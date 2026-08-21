import { parseOpenTagMention } from "./mention.js";
import type {
  ApprovalMode,
  Grant,
  MutationIntent,
  NormalizedMaterialAction,
  OpenTagRunResult,
  SuggestedChangesSnapshot
} from "./schema.js";
import { isFeishuReadOnlyMcpResource } from "./feishu-mcp-policy.js";

export type MaterialActionRequestInput = {
  title: string;
  kind?: string | null;
  permissionScopes?: string[];
  provider?: string;
  connectionId?: string;
  operation?: string;
  resource?: string;
  resourceVersion?: string;
  targetFingerprint?: string;
  targetConstraints?: Record<string, unknown>;
  grantScope?: Record<string, unknown>;
  target?: Record<string, unknown>;
};

const MATERIAL_ACTION_PATTERN = /(?:push|deploy|publish|release|create|update|delete|write|mutat|send|post|merge|issue|connector)/iu;
const CRITICAL_ACTION_PATTERN = /(?:credential|secret|token|security[_ -]?override|disable[_ -]?(?:guard|safety))/iu;
const OPAQUE_MATERIAL_ACTION_KINDS = new Set(["execute", "tool", "fetch", "edit", "delete", "move", "other"]);
const CANONICAL_TARGET_KEYS = new Set([
  "title", "kind", "provider", "connectionId", "operation", "resource", "resourceVersion",
  "targetFingerprint", "targetConstraints", "grantScope"
]);

function normalizedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function targetExtensions(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !CANONICAL_TARGET_KEYS.has(key)));
}

export function normalizeMaterialActionRequest(input: MaterialActionRequestInput): NormalizedMaterialAction {
  const title = input.title.trim().replace(/\s+/gu, " ").slice(0, 240) || "untitled action";
  const explicitResource = input.resource?.trim();
  const trustedReadOnlyFeishuTool = isFeishuReadOnlyMcpResource(
    explicitResource ?? (isFeishuReadOnlyMcpResource(title) ? title : undefined)
  );
  const kind = trustedReadOnlyFeishuTool
    ? "read"
    : input.kind?.trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, "_") || "tool";
  const actionFamily = kind === "tool" ? title.toLowerCase().split(/\s+/u).slice(0, 3).join("_").replace(/[^a-z0-9._:-]+/gu, "_") : kind;
  const permissionScopes = trustedReadOnlyFeishuTool
    ? []
    : [...new Set(input.permissionScopes ?? [])].map((scope) => scope.trim()).filter(Boolean).sort();
  const provider = input.provider?.trim().toLowerCase() || "acp";
  const connectionId = input.connectionId?.trim() || `${provider}:agent-managed`;
  const operation = trustedReadOnlyFeishuTool
    ? "read"
    : input.operation?.trim().toLowerCase() || actionFamily || kind;
  const resource = explicitResource || title;
  const resourceVersion = input.resourceVersion?.trim();
  const targetFingerprint = input.targetFingerprint?.trim().toLowerCase();
  const probe = `${actionFamily} ${title} ${permissionScopes.join(" ")}`;
  const internallyBlocked = CRITICAL_ACTION_PATTERN.test(probe);
  const material = OPAQUE_MATERIAL_ACTION_KINDS.has(kind) || MATERIAL_ACTION_PATTERN.test(probe) || permissionScopes.some((scope) => /(?:write|publish|deploy|admin|mutate)/iu.test(scope));
  const riskTier = internallyBlocked ? "critical" : /(?:push|deploy|publish|release|merge)/iu.test(probe) ? "high" : material ? "medium" : "low";
  const scope = input.grantScope
    ? normalizedRecord({
        permissionScopes,
        provider,
        connectionId,
        operation,
        grantScope: normalizedRecord(input.grantScope),
        ...(input.targetConstraints ? { targetConstraints: normalizedRecord(input.targetConstraints) } : {})
      })
    : normalizedRecord({
        permissionScopes,
        provider,
        connectionId,
        operation,
        resource,
        ...(resourceVersion ? { resourceVersion } : {}),
        ...(targetFingerprint ? { targetFingerprint } : {}),
        ...(input.targetConstraints ? { targetConstraints: normalizedRecord(input.targetConstraints) } : {})
      });
  return {
    actionFamily: actionFamily || "tool",
    scope,
    target: normalizedRecord({
      ...targetExtensions(input.target),
      title,
      provider,
      connectionId,
      operation,
      resource,
      ...(resourceVersion ? { resourceVersion } : {}),
      ...(targetFingerprint ? { targetFingerprint } : {}),
      ...(input.targetConstraints ? { targetConstraints: normalizedRecord(input.targetConstraints) } : {}),
      ...(input.grantScope ? { grantScope: normalizedRecord(input.grantScope) } : {}),
      ...(input.kind || trustedReadOnlyFeishuTool ? { kind } : {})
    }),
    riskTier,
    material,
    internallyBlocked,
    ...(internallyBlocked ? { blockReason: "OpenTag internal guardrails prohibit credential export or safety bypass actions." } : {})
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function grantMatchesAction(
  grant: Pick<Grant, "runId" | "attemptId" | "capability" | "resourceScope" | "expiresAt" | "revokedAt" | "constraints">,
  input: { runId: string; attemptId: string; actionId?: string; proposalHash?: string; action: NormalizedMaterialAction; now?: string }
): boolean {
  const constraints = grant.constraints ?? {};
  const permissionDecision = constraints["permissionDecision"];
  const grantActionId = constraints["actionId"];
  const grantProposalHash = constraints["proposalHash"];
  const exactOneShot = permissionDecision === "allow_once" &&
    typeof grant.attemptId === "string" && grant.attemptId.trim().length > 0 && grant.attemptId === input.attemptId &&
    typeof grantActionId === "string" && grantActionId.trim().length > 0 &&
    typeof input.actionId === "string" && input.actionId.trim().length > 0 && grantActionId === input.actionId &&
    typeof grantProposalHash === "string" && grantProposalHash.trim().length > 0 &&
    typeof input.proposalHash === "string" && input.proposalHash.trim().length > 0 && grantProposalHash === input.proposalHash;
  if (!exactOneShot && !actionScopeAllowsRunReuse(input.action.scope)) return false;
  if (grant.revokedAt) return false;
  if (grant.expiresAt && grant.expiresAt <= (input.now ?? new Date().toISOString())) return false;
  if (grant.runId !== input.runId || grant.capability !== input.action.actionFamily) return false;
  if (grant.attemptId && grant.attemptId !== input.attemptId) return false;
  if (permissionDecision === "allow_once" && !exactOneShot) return false;
  return stableJson(grant.resourceScope) === stableJson(input.action.scope);
}

export function actionScopeAllowsRunReuse(scope: Record<string, unknown>): boolean {
  const targetConstraints = scope["targetConstraints"];
  return !(targetConstraints && typeof targetConstraints === "object" && !Array.isArray(targetConstraints) &&
    (targetConstraints as Record<string, unknown>)["reuse"] === "deny");
}

export function evaluateActionPermission(input: {
  mode: ApprovalMode;
  action: NormalizedMaterialAction;
  matchingGrant?: boolean;
}): { outcome: "authorized" | "needs_approval" | "blocked"; reason: string } {
  if (input.action.internallyBlocked) {
    return { outcome: "blocked", reason: input.action.blockReason ?? "Blocked by OpenTag internal guardrails." };
  }
  if (input.matchingGrant) return { outcome: "authorized", reason: "A matching durable grant covers this action family and scope." };
  if (input.mode === "autonomous") return { outcome: "authorized", reason: "Autonomous mode authorizes this action within internal guardrails." };
  if (input.mode === "auto" && !input.action.material) return { outcome: "authorized", reason: "Auto mode authorizes low-risk non-material actions." };
  return { outcome: "needs_approval", reason: `${input.mode} mode requires a durable approval for this action.` };
}

export type ThreadActionVerb = "approve" | "apply" | "continue" | "reject";
export type ThreadControlVerb = "status" | "doctor" | "stop" | "acknowledge" | "resolve";

export type ThreadActionSelection =
  | { kind: "latest" }
  | { kind: "all" }
  | { kind: "index"; index: number }
  | { kind: "proposal"; proposalId: string }
  | { kind: "intent"; intentId: string }
  | { kind: "domain"; domain: string };

export type ThreadActionCommand = {
  verb: ThreadActionVerb;
  selection: ThreadActionSelection;
  rawText: string;
  reason?: string;
};

export type ThreadControlCommand = {
  verb: ThreadControlVerb;
  rawText: string;
  runId?: string;
  escalationId?: string;
  optionId?: string;
  reason?: string;
};

export type SuggestedActionCandidate = {
  index: number;
  proposalId: string;
  proposalSummary: string;
  proposalPreconditions?: string[];
  intent: MutationIntent;
};

export type ActionReceiptState = "ready_to_apply" | "needs_approval" | "needs_setup" | "unsupported";
export type ActionReceiptDecision = "apply" | "approve" | "reject" | "continue";
export type ActionReceiptPrimaryDecision = "apply" | "continue" | "none";

export type ActionReceiptCapability = {
  state?: ActionReceiptState;
  targetLabel?: string;
  setupReason?: string;
  visibleDecisions?: ActionReceiptDecision[];
  primaryDecision?: ActionReceiptPrimaryDecision;
};

export type ActionReceiptContext = {
  capabilityByIntentId?: Record<string, ActionReceiptCapability>;
};

export type ActionReceipt = {
  candidate: SuggestedActionCandidate;
  state: ActionReceiptState;
  targetLabel: string;
  setupReason?: string;
  visibleDecisions: ActionReceiptDecision[];
  primaryDecision: ActionReceiptPrimaryDecision;
};

const ENGLISH_VERBS: Record<string, ThreadActionVerb> = {
  approve: "approve",
  approved: "approve",
  ok: "approve",
  okay: "approve",
  apply: "apply",
  continue: "continue",
  proceed: "continue",
  reject: "reject",
  decline: "reject"
};

const CHINESE_VERBS: Array<{ pattern: RegExp; verb: ThreadActionVerb }> = [
  { pattern: /^(批准|同意)/, verb: "approve" },
  { pattern: /^(应用|套用|执行)/, verb: "apply" },
  { pattern: /^(继续执行|继续这个|继续此|继续)/, verb: "continue" },
  { pattern: /^(拒绝|不同意|驳回)/, verb: "reject" }
];

const DOMAIN_ALIASES: Record<string, string> = {
  label: "labels",
  labels: "labels",
  status: "status",
  assignee: "assignee",
  assignees: "assignee",
  priority: "priority",
  review: "review",
  reviews: "review",
  artifact: "artifact_links",
  artifacts: "artifact_links",
  issue: "issue",
  issues: "issue",
  ticket: "issue",
  tickets: "issue",
  pr: "pull_request",
  prs: "pull_request",
  pull_request: "pull_request",
  pull_requests: "pull_request"
};

function normalizeToken(token: string): string {
  return token.trim().replace(/[.,;:!?，。；：！？]+$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function threadCommandText(rawText: string): string {
  const mention = parseOpenTagMention(rawText);
  return mention.matched ? mention.rawText : rawText.trim();
}

function parseSelection(tokens: string[]): ThreadActionSelection {
  const normalized = tokens.map(normalizeToken).filter(Boolean);
  const first = normalized[0];
  if (!first) return { kind: "latest" };
  if (first.toLowerCase() === "all" || first === "全部") return { kind: "all" };
  if (/^\d+$/.test(first)) return { kind: "index", index: Number(first) };
  if (first.startsWith("proposal_")) return { kind: "proposal", proposalId: first };
  if (first.startsWith("intent_")) return { kind: "intent", intentId: first };

  const maybeProposal = normalized.find((token) => token.startsWith("proposal_"));
  if (maybeProposal) return { kind: "proposal", proposalId: maybeProposal };
  const maybeIntent = normalized.find((token) => token.startsWith("intent_"));
  if (maybeIntent) return { kind: "intent", intentId: maybeIntent };

  const domain = DOMAIN_ALIASES[first.toLowerCase()];
  return domain ? { kind: "domain", domain } : { kind: "latest" };
}

function reasonAfterSelection(rest: string, selection: ThreadActionSelection): string | undefined {
  if (!rest.trim()) return undefined;
  if (selection.kind === "all") {
    const stripped = rest.replace(/^\s*(?:all|全部)\s*/iu, "").trim();
    return stripped.length > 0 ? stripped : undefined;
  }
  if (selection.kind === "latest") return rest.trim();
  const selectionText =
    selection.kind === "index"
      ? String(selection.index)
      : selection.kind === "proposal"
        ? escapeRegExp(selection.proposalId)
        : selection.kind === "intent"
          ? escapeRegExp(selection.intentId)
          : Object.keys(DOMAIN_ALIASES).join("|");
  const pattern = new RegExp(`^\\s*(?:${selectionText})\\b\\s*`, "i");
  const stripped = rest.replace(pattern, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

export function parseThreadActionCommand(rawText: string): ThreadActionCommand | null {
  const text = threadCommandText(rawText);
  if (!text) return null;

  for (const candidate of CHINESE_VERBS) {
    const match = text.match(candidate.pattern);
    if (!match) continue;
    const verbText = match[0] ?? "";
    const rest = text.slice(verbText.length).trim();
    const selection = parseSelection(rest.split(/\s+/u));
    const reason = reasonAfterSelection(rest, selection);
    return {
      verb: candidate.verb,
      selection,
      rawText: text,
      ...(reason ? { reason } : {})
    };
  }

  const [verbTokenRaw = "", ...restTokens] = text.split(/\s+/u);
  const verbToken = normalizeToken(verbTokenRaw).toLowerCase();
  const verb = ENGLISH_VERBS[verbToken];
  if (!verb) return null;
  const rest = restTokens.join(" ");
  const selection = parseSelection(restTokens);
  const reason = reasonAfterSelection(rest, selection);
  return {
    verb,
    selection,
    rawText: text,
    ...(reason ? { reason } : {})
  };
}

export function parseThreadControlCommand(rawText: string): ThreadControlCommand | null {
  const text = threadCommandText(rawText);
  if (!text) return null;

  const simple = text.match(/^\/(status|doctor)\s*$/i);
  if (simple) {
    return {
      verb: simple[1]!.toLowerCase() as "status" | "doctor",
      rawText: text
    };
  }

  const stop = text.match(/^\/stop(?:\s+(\S+))?\s*$/i);
  if (stop) {
    return {
      verb: "stop",
      rawText: text,
      ...(stop[1] ? { runId: stop[1] } : {})
    };
  }

  const acknowledge = text.match(/^\/(?:ack|acknowledge)\s+(\S+)\s*$/i);
  if (acknowledge) {
    return { verb: "acknowledge", rawText: text, escalationId: acknowledge[1]! };
  }

  const resolve = text.match(/^\/resolve\s+(\S+)(?:\s+(.+))?\s*$/i);
  if (!resolve) return null;
  const flags = resolve[2]?.trim();
  const optionThenReason = flags?.match(/^--option\s+(\S+)(?:\s+--reason\s+(.+))?$/i);
  const reasonThenOption = flags?.match(/^--reason\s+(.+?)(?:\s+--option\s+(\S+))?$/i);
  if (flags && !optionThenReason && !reasonThenOption) return null;
  const optionId = optionThenReason?.[1] ?? reasonThenOption?.[2];
  const reason = optionThenReason?.[2] ?? reasonThenOption?.[1];
  return {
    verb: "resolve",
    rawText: text,
    escalationId: resolve[1]!,
    ...(optionId ? { optionId } : {}),
    ...(reason?.trim() ? { reason: reason.trim() } : {})
  };
}

export function suggestedActionCandidatesFromSnapshots(
  snapshots: SuggestedChangesSnapshot[],
  startIndex = 1
): SuggestedActionCandidate[] {
  const candidates: SuggestedActionCandidate[] = [];
  let index = startIndex;
  for (const snapshot of snapshots) {
    for (const intent of snapshot.intents) {
      candidates.push({
        index,
        proposalId: snapshot.proposalId,
        proposalSummary: snapshot.summary,
        ...(snapshot.preconditions?.length ? { proposalPreconditions: snapshot.preconditions } : {}),
        intent
      });
      index += 1;
    }
  }
  return candidates;
}

export function suggestedActionCandidatesFromResult(result: OpenTagRunResult): SuggestedActionCandidate[] {
  return suggestedActionCandidatesFromSnapshots(result.suggestedChanges ?? []);
}

function defaultActionTargetLabel(intent: MutationIntent): string {
  if (intent.action === "create_pull_request") return "GitHub pull request";
  if (intent.action === "create_issue" || (intent.domain === "issue" && intent.action === "create")) return "Linear issue";
  if (intent.domain === "labels") return "GitHub labels";
  if (intent.domain === "assignee" || intent.domain === "assignees") return "GitHub assignees";
  if (intent.domain === "review") return "GitHub review request";
  if (intent.domain === "artifact_links") return "Artifact link";
  if (intent.domain === "follow_up") return "OpenTag follow-up run";
  return `${intent.domain} / ${intent.action}`;
}

function defaultVisibleDecisionsForState(state: ActionReceiptState): ActionReceiptDecision[] {
  if (state === "ready_to_apply") return ["apply", "reject"];
  if (state === "needs_approval") return ["approve", "reject"];
  if (state === "needs_setup") return ["continue", "reject"];
  return ["continue", "reject"];
}

function defaultPrimaryDecisionForState(state: ActionReceiptState): ActionReceiptPrimaryDecision {
  if (state === "ready_to_apply") return "apply";
  if (state === "needs_setup" || state === "unsupported") return "continue";
  return "none";
}

export function actionReceiptHeading(receipts: ActionReceipt[]): string {
  const states = new Set(receipts.map((receipt) => receipt.state));
  if (states.size === 1 && states.has("ready_to_apply")) return "Ready to apply";
  if (states.size > 1) return mixedActionReceiptHeading(receipts);
  if (states.has("needs_setup")) return "Needs setup";
  if (states.has("unsupported")) return "Needs attention";
  return "Needs approval";
}

function countedActionPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? "action" : "actions"} ${count === 1 ? singular : plural}`;
}

function mixedActionReceiptHeading(receipts: ActionReceipt[]): string {
  const counts: Record<ActionReceiptState, number> = {
    ready_to_apply: 0,
    needs_approval: 0,
    needs_setup: 0,
    unsupported: 0
  };
  for (const receipt of receipts) {
    counts[receipt.state] += 1;
  }
  return [
    counts.ready_to_apply > 0 ? countedActionPhrase(counts.ready_to_apply, "ready to apply", "ready to apply") : undefined,
    counts.needs_setup > 0 ? countedActionPhrase(counts.needs_setup, "needs setup", "need setup") : undefined,
    counts.needs_approval > 0 ? countedActionPhrase(counts.needs_approval, "needs approval", "need approval") : undefined,
    counts.unsupported > 0 ? countedActionPhrase(counts.unsupported, "needs attention", "need attention") : undefined
  ]
    .filter((phrase): phrase is string => Boolean(phrase))
    .join(", ");
}

export function buildActionReceipt(candidate: SuggestedActionCandidate, context: ActionReceiptContext = {}): ActionReceipt {
  const capability = context.capabilityByIntentId?.[candidate.intent.intentId];
  const state = capability?.state ?? "needs_approval";
  return {
    candidate,
    state,
    targetLabel: capability?.targetLabel ?? defaultActionTargetLabel(candidate.intent),
    ...(capability?.setupReason ? { setupReason: capability.setupReason } : {}),
    visibleDecisions: capability?.visibleDecisions ?? defaultVisibleDecisionsForState(state),
    primaryDecision: capability?.primaryDecision ?? defaultPrimaryDecisionForState(state)
  };
}

export function buildActionReceiptsFromResult(result: OpenTagRunResult, context: ActionReceiptContext = {}): ActionReceipt[] {
  return suggestedActionCandidatesFromResult(result).map((candidate) => buildActionReceipt(candidate, context));
}

export type WorkContextMutationDomain = "priority" | "status" | "assignee" | "label";

export type WorkContextMutationRequest = {
  domain: WorkContextMutationDomain;
  value: string;
};

const WORK_CONTEXT_MUTATION_CLAUSES: Array<{ domain: WorkContextMutationDomain; pattern: RegExp }> = [
  {
    domain: "priority",
    pattern: /^set\s+(?:the\s+)?(?:(?:this|the)\s+)?(?:issue(?:'s)?\s+)?priority\s+(?:to\s+)?(.+)$/i
  },
  {
    domain: "status",
    pattern: /^(?:set\s+(?:the\s+)?(?:(?:this|the)\s+)?(?:issue(?:'s)?\s+)?(?:status|state)\s+(?:to\s+)?|move\s+(?:(?:this|the)\s+issue\s+)?to\s+)(.+)$/i
  },
  {
    domain: "assignee",
    pattern: /^(?:assign\s+(?:(?:this|the)\s+issue\s+)?(?:to\s+)?|set\s+(?:the\s+)?(?:issue(?:'s)?\s+)?assignee\s+(?:to\s+)?)(.+)$/i
  },
  {
    domain: "label",
    pattern: /^(?:add|set)\s+(?:the\s+)?label(?:s)?\s+(?:to\s+)?(.+)$/i
  }
];

function cleanMutationValue(raw: string): string | undefined {
  const value = raw
    .trim()
    .replace(/^["'`「『]+|["'`」』]+$/gu, "")
    .replace(/[.,;:!?，。；：！？]+$/u, "")
    .trim();
  return value.length > 0 && value.length <= 120 ? value : undefined;
}

/**
 * Parse a source-thread command that consists purely of work-context mutation
 * statements ("set priority to High", "assign to alice and add label bug").
 * Returns null unless every clause is a recognized mutation, so anything that
 * mixes in other work ("fix the bug and set priority high") still routes to an
 * executor run.
 */
export function parseWorkContextMutationCommand(rawText: string): WorkContextMutationRequest[] | null {
  const text = threadCommandText(rawText);
  if (!text || /[\n\r]/.test(text)) return null;

  const clauses = text
    .split(/\s+(?:and\s+then|and|then)\s+|[;；]/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0) return null;

  const requests: WorkContextMutationRequest[] = [];
  for (const clause of clauses) {
    const matched = WORK_CONTEXT_MUTATION_CLAUSES.find((candidate) => candidate.pattern.test(clause));
    if (!matched) return null;
    const value = cleanMutationValue(clause.match(matched.pattern)?.[1] ?? "");
    if (!value) return null;
    requests.push({ domain: matched.domain, value });
  }
  return requests.length > 0 ? requests : null;
}
