import type {
  ApplyIntentOutcome,
  CapabilityContract,
  ContextPacket,
  ContextPacketFactConfidence,
  ContextPointer,
  ConversationAnchor,
  MutationIntent,
  OpenTagEvent,
  PermissionGrant,
  PolicyResolution,
  PolicyRule,
  PolicyScope,
  WorkItemReference,
  WorkThread
} from "./schema.js";
import { ConversationMemoryPolicySchema } from "./schema.js";

const CONTEXT_PACKET_STAGES = ["collect", "classify", "filter", "preserve", "summarize", "budget", "emit"] as const;
const POLICY_SCOPE_ORDER: PolicyScope[] = [
  "organization_default",
  "adapter_surface_default",
  "work_context_owner_container",
  "work_item_override",
  "primary_anchor_override"
];

export type ContextSourceClassification = "primary_evidence" | "supporting_context" | "background_noise" | "sensitive_material";

export type ClassifiedContextPointer = {
  pointer: ContextPointer;
  classification: ContextSourceClassification;
  reason: string;
};

function contextPacketSourceRole(classification: ContextSourceClassification): "primary" | "supporting" | "background" {
  switch (classification) {
    case "primary_evidence":
      return "primary";
    case "supporting_context":
      return "supporting";
    case "background_noise":
    case "sensitive_material":
      return "background";
  }
}

export function contextPointerLabel(pointer: ContextPointer): string {
  return pointer.provider ? `${pointer.provider}.${pointer.kind}` : pointer.kind;
}

export type ContextPacketAssemblyOptions = {
  budgetTokens?: number;
  risks?: string[];
  exclusions?: string[];
  redactions?: Array<{ reason: string; sourceUri?: string }>;
  hooks?: ContextPacketAssemblyHooks;
};

export type ContextPacketAssemblyHooks = {
  collect?(input: { event: OpenTagEvent; pointers: ContextPointer[] }): ContextPointer[];
  classify?(input: { event: OpenTagEvent; classified: ClassifiedContextPointer[] }): ClassifiedContextPointer[];
  filter?(input: { event: OpenTagEvent; classified: ClassifiedContextPointer[] }): ClassifiedContextPointer[];
  preserve?(input: { event: OpenTagEvent; facts: ContextPacketFact[] }): ContextPacketFact[];
  summarize?(input: { event: OpenTagEvent; summary: string }): string;
  budget?(input: {
    event: OpenTagEvent;
    classified: ClassifiedContextPointer[];
    budgetTokens?: number;
  }): ClassifiedContextPointer[];
  emit?(input: { event: OpenTagEvent; packet: ContextPacket }): ContextPacket;
};

export type AdapterMutationCompilation<TOperation = unknown> =
  | {
      ok: true;
      adapter: string;
      intentId: string;
      operation: TOperation;
    }
  | {
      ok: false;
      adapter: string;
      outcome: ApplyIntentOutcome;
    };

export type AdapterMutationCompiler<TOperation = unknown> = {
  adapter: string;
  compile(intent: MutationIntent): AdapterMutationCompilation<TOperation>;
};

export type AdapterMutationCompilerRegistry = {
  register<TOperation>(compiler: AdapterMutationCompiler<TOperation>): void;
  get(adapter: string): AdapterMutationCompiler | undefined;
  compile(adapter: string, intents: MutationIntent[]): AdapterMutationCompilation[];
};

export function createAdapterMutationCompilerRegistry(compilers: AdapterMutationCompiler[] = []): AdapterMutationCompilerRegistry {
  const byAdapter = new Map(compilers.map((compiler) => [compiler.adapter, compiler]));
  return {
    register(compiler) {
      byAdapter.set(compiler.adapter, compiler);
    },
    get(adapter) {
      return byAdapter.get(adapter);
    },
    compile(adapter, intents) {
      const compiler = byAdapter.get(adapter);
      if (!compiler) {
        return intents.map((intent) => ({
          ok: false,
          adapter,
          outcome: {
            intentId: intent.intentId,
            outcome: "unsupported",
            message: `No adapter mutation compiler is registered for ${adapter}.`
          }
        }));
      }
      return intents.map((intent) => compiler.compile(intent));
    }
  };
}

function classifyContextPointer(pointer: ContextPointer): ClassifiedContextPointer {
  if (pointer.kind === "text") {
    return { pointer, classification: "primary_evidence", reason: "Original user-authored text is primary evidence." };
  }
  if (["issue", "pull_request", "comment", "thread", "message"].includes(pointer.kind)) {
    return { pointer, classification: "primary_evidence", reason: `${contextPointerLabel(pointer)} is directly attached to the invocation.` };
  }
  if (["repo", "file", "url"].includes(pointer.kind)) {
    return { pointer, classification: "supporting_context", reason: `${contextPointerLabel(pointer)} supports execution but is not itself the request.` };
  }
  return { pointer, classification: "supporting_context", reason: "Pointer is relevant context." };
}

export function collectContextPointers(event: OpenTagEvent): ContextPointer[] {
  return event.context;
}

export function classifyContextPointers(pointers: ContextPointer[]): ClassifiedContextPointer[] {
  return pointers.map((pointer) => classifyContextPointer(pointer));
}

export function filterClassifiedContextPointers(classified: ClassifiedContextPointer[]): ClassifiedContextPointer[] {
  return classified.filter((entry) => entry.classification !== "background_noise" && entry.classification !== "sensitive_material");
}

type ContextPacketFact = { text: string; sourceUri?: string; source?: ContextPointer; confidence?: ContextPacketFactConfidence };

function metadataString(event: OpenTagEvent, key: string): string | undefined {
  const value = event.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataStringArray(event: OpenTagEvent, key: string): string[] {
  const value = event.metadata[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function preserveActionLoopFacts(event: OpenTagEvent): ContextPacketFact[] {
  const facts: ContextPacketFact[] = [];
  const threadActionVerb = metadataString(event, "threadActionVerb");
  const parentRunId = metadataString(event, "parentRunId");
  const sourceProposalId = metadataString(event, "sourceProposalId");
  const approvalDecisionId = metadataString(event, "approvalDecisionId");
  const sourceApplyPlanId = metadataString(event, "sourceApplyPlanId");
  const previousRunSummary = metadataString(event, "previousRunSummary");
  const fallbackReason = metadataString(event, "fallbackReason");
  const selectedIntentIds = metadataStringArray(event, "selectedIntentIds");

  if (threadActionVerb) facts.push({ text: `Action loop thread action: ${threadActionVerb}`, confidence: "observed" });
  if (parentRunId) facts.push({ text: `Action loop parent run: ${parentRunId}`, confidence: "observed" });
  if (sourceProposalId) facts.push({ text: `Action loop proposal: ${sourceProposalId}`, confidence: "observed" });
  if (approvalDecisionId) facts.push({ text: `Action loop approval decision: ${approvalDecisionId}`, confidence: "observed" });
  if (sourceApplyPlanId) facts.push({ text: `Action loop apply plan: ${sourceApplyPlanId}`, confidence: "observed" });
  if (selectedIntentIds.length > 0) facts.push({ text: `Action loop selected intents: ${selectedIntentIds.join(", ")}`, confidence: "observed" });
  if (previousRunSummary) facts.push({ text: `Action loop previous result: ${previousRunSummary}`, confidence: "observed" });
  if (fallbackReason) facts.push({ text: `Action loop fallback reason: ${fallbackReason}`, confidence: "observed" });

  return facts;
}

export function preserveContextFacts(event: OpenTagEvent, classified: ClassifiedContextPointer[]): ContextPacketFact[] {
  const sourceUri = classified[0]?.pointer.uri;
  return [
    {
      text: `Requested intent: ${event.command.intent}`,
      ...(sourceUri ? { sourceUri } : {}),
      ...(classified[0]?.pointer ? { source: classified[0].pointer } : {}),
      confidence: "observed"
    },
    ...preserveActionLoopFacts(event),
    ...classified.map((entry) => ({
      text: `${entry.classification}: ${contextPointerLabel(entry.pointer)}`,
      sourceUri: entry.pointer.uri,
      source: entry.pointer,
      confidence: "observed" as const
    }))
  ];
}

export function summarizeContextPacket(event: OpenTagEvent): string {
  // A whitespace-only rawText is functionally empty, so fall back to the derived
  // request label rather than emitting a blank summary.
  return event.command.rawText.trim() || `OpenTag ${event.command.intent} request`;
}

export function budgetContextPointers(classified: ClassifiedContextPointer[], budgetTokens?: number): ClassifiedContextPointer[] {
  if (!budgetTokens) return classified;
  const maxPointers = Math.max(1, Math.floor(budgetTokens / 500));
  return classified.slice(0, maxPointers);
}

export function assembleContextPacketFromEvent(
  event: OpenTagEvent,
  emittedAt = event.receivedAt,
  options: ContextPacketAssemblyOptions = {}
): ContextPacket {
  const collected = options.hooks?.collect?.({ event, pointers: collectContextPointers(event) }) ?? collectContextPointers(event);
  const classified = options.hooks?.classify?.({ event, classified: classifyContextPointers(collected) }) ?? classifyContextPointers(collected);
  const filtered =
    options.hooks?.filter?.({ event, classified: filterClassifiedContextPointers(classified) }) ??
    filterClassifiedContextPointers(classified);
  const budgeted =
    options.hooks?.budget?.({
      event,
      classified: budgetContextPointers(filtered, options.budgetTokens),
      ...(options.budgetTokens ? { budgetTokens: options.budgetTokens } : {})
    }) ??
    budgetContextPointers(filtered, options.budgetTokens);
  const writeScopes = event.permissions
    .map((permission) => permission.scope)
    .filter((scope) => scope === "repo:write" || scope === "pr:create" || scope === "pr:update");
  const summary = options.hooks?.summarize?.({ event, summary: summarizeContextPacket(event) }) ?? summarizeContextPacket(event);
  const facts = options.hooks?.preserve?.({ event, facts: preserveContextFacts(event, budgeted) }) ?? preserveContextFacts(event, budgeted);
  const packet = {
    summary,
    sourcePointers: budgeted.map((entry) => entry.pointer),
    intent: {
      // OpenTagCommandSchema.rawText permits an empty string, but
      // ContextPacketIntentSchema.rawText requires min length 1. A
      // whitespace-only rawText is functionally empty, so trim before the
      // emptiness check and fall back to the (always non-empty) summary. The
      // original, untrimmed rawText is preserved whenever it has real content,
      // keeping the emitted packet schema-valid so the store does not accept the
      // run on write and then throw on read.
      rawText: event.command.rawText.trim() ? event.command.rawText : summary,
      normalizedIntent: event.command.intent,
      requestedBy: event.actor
    },
    sources: budgeted.map((entry) => ({
      pointer: entry.pointer,
      role: contextPacketSourceRole(entry.classification),
      included: true,
      reason: entry.reason
    })),
    facts,
    risks:
      options.risks ??
      (writeScopes.length > 0
        ? [`External write-capable scopes were requested: ${writeScopes.join(", ")}.`]
        : ["No external write-capable scopes were requested."]),
    exclusions: options.exclusions ?? ["Do not mutate external state unless an explicit capability and policy allow it."],
    mustPreserve: [summary],
    ...(options.redactions?.length ? { redactions: options.redactions } : {}),
    assembly: {
      stages: [...CONTEXT_PACKET_STAGES],
      ...(options.budgetTokens ? { budgetTokens: options.budgetTokens } : {}),
      emittedAt
    }
  };
  return options.hooks?.emit?.({ event, packet }) ?? packet;
}

export function defaultRunEventMetadata(type: string): {
  visibility: "human" | "audit" | "debug";
  importance: "low" | "normal" | "high" | "blocking";
} {
  const visibility = type.startsWith("callback.") ? "human" : type.startsWith("executor.log") ? "debug" : "audit";
  const importance =
    type === "run.waiting_for_permission"
      ? "blocking"
      : type === "run.completed" || type.startsWith("callback.final")
        ? "high"
        : type === "run.created"
          ? "low"
          : "normal";
  return { visibility, importance };
}

export const DefaultCapabilityContracts = [
  {
    id: "reply_thread",
    semanticAction: "reply_thread",
    capabilityClass: "callback",
    requiresExplicitIntent: false,
    mayAutoApplyByPolicy: true,
    requiredPermissionScopes: ["issue:comment", "chat:postMessage"]
  },
  {
    id: "attach_artifact",
    semanticAction: "attach_artifact",
    capabilityClass: "callback",
    requiresExplicitIntent: false,
    mayAutoApplyByPolicy: true,
    requiredPermissionScopes: ["issue:comment", "chat:postMessage"]
  },
  {
    id: "create_pr",
    semanticAction: "create_pull_request",
    capabilityClass: "external_write",
    requiresExplicitIntent: true,
    mayAutoApplyByPolicy: true,
    requiredPermissionScopes: ["pr:create"],
    requiredExecutorConditions: ["isolated branch exists"]
  },
  {
    id: "create_issue",
    semanticAction: "create_issue",
    capabilityClass: "external_write",
    requiresExplicitIntent: true,
    mayAutoApplyByPolicy: false,
    adapterTargets: ["linear"],
    requiredPermissionScopes: ["issue:create"]
  },
  {
    id: "set_status",
    semanticAction: "transition_status",
    capabilityClass: "external_write",
    requiresExplicitIntent: true,
    mayAutoApplyByPolicy: true,
    requiredPermissionScopes: ["repo:write"]
  },
  {
    id: "set_assignee",
    semanticAction: "set_assignee",
    capabilityClass: "external_write",
    requiresExplicitIntent: true,
    mayAutoApplyByPolicy: true,
    requiredPermissionScopes: ["repo:write"]
  },
  {
    id: "set_priority",
    semanticAction: "set_priority",
    capabilityClass: "external_write",
    requiresExplicitIntent: true,
    mayAutoApplyByPolicy: true,
    requiredPermissionScopes: ["repo:write"]
  },
  {
    id: "set_labels",
    semanticAction: "set_labels",
    capabilityClass: "external_write",
    requiresExplicitIntent: true,
    mayAutoApplyByPolicy: true,
    requiredPermissionScopes: ["repo:write"]
  },
  {
    id: "request_review",
    semanticAction: "request_review",
    capabilityClass: "external_write",
    requiresExplicitIntent: true,
    mayAutoApplyByPolicy: true,
    adapterTargets: ["github"],
    requiredPermissionScopes: ["pr:update"]
  }
] satisfies CapabilityContract[];

function firstContextUri(event: OpenTagEvent, input: { provider?: string; kind: string }): string | undefined {
  return event.context.find((pointer) => pointer.kind === input.kind && (!input.provider || pointer.provider === input.provider))?.uri;
}

export function workItemReferenceFromEvent(event: OpenTagEvent): WorkItemReference | undefined {
  return event.workItem;
}

export function primaryConversationAnchorFromEvent(event: OpenTagEvent): ConversationAnchor {
  const sourcePointer =
    firstContextUri(event, { provider: event.callback.provider, kind: "comment" }) ??
    firstContextUri(event, { provider: event.callback.provider, kind: "message" }) ??
    firstContextUri(event, { provider: event.callback.provider, kind: "thread" }) ??
    firstContextUri(event, { kind: "url" });
  return {
    provider: event.callback.provider,
    kind: event.callback.threadKey ? "thread" : `${event.callback.provider}_thread`,
    externalId: event.callback.threadKey ?? event.callback.uri,
    uri: sourcePointer ?? event.callback.uri,
    controlPlane: true,
    canApprove: true,
    ...(event.callback.threadKey ? { threadKey: event.callback.threadKey } : {})
  };
}

function callbackConversationKey(callback: OpenTagEvent["callback"]): string {
  return `${callback.provider}:${callback.threadKey ?? callback.uri}`;
}

function explicitConversationKey(event: OpenTagEvent): string | undefined {
  const key = metadataRecordString(event.metadata, "conversationKey");
  return key?.startsWith(`${event.callback.provider}:`) ? key : undefined;
}

function canonicalTeamsConversationKey(callback: OpenTagEvent["callback"]): string | undefined {
  if (callback.provider !== "teams" || !callback.threadKey) return undefined;
  const firstSeparator = callback.threadKey.indexOf("|");
  const lastSeparator = callback.threadKey.lastIndexOf("|");
  if (firstSeparator <= 0 || lastSeparator <= firstSeparator + 1 || lastSeparator === callback.threadKey.length - 1) {
    return undefined;
  }

  const serviceUrl = callback.threadKey.slice(0, firstSeparator);
  const conversationId = callback.threadKey.slice(firstSeparator + 1, lastSeparator);
  const activityId = callback.threadKey.slice(lastSeparator + 1);
  const baseConversationId = conversationId.replace(/;messageid=[^;]+$/i, "");
  if (baseConversationId === conversationId) return undefined;
  return `teams:${serviceUrl}|${baseConversationId}|${activityId}`;
}

export function conversationKeysFromCallback(callback: OpenTagEvent["callback"]): string[] {
  return [...new Set([callbackConversationKey(callback), canonicalTeamsConversationKey(callback)].filter((key): key is string => Boolean(key)))];
}

function metadataRecordString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataIssueNumber(metadata: Record<string, unknown>): string | undefined {
  const value = metadata["issueNumber"];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}

function legacyGitHubIssueConversationKey(event: OpenTagEvent): string | undefined {
  if (event.callback.provider !== "github") return undefined;
  const owner = metadataRecordString(event.metadata, "owner");
  const repo = metadataRecordString(event.metadata, "repo");
  const issueNumber = metadataIssueNumber(event.metadata);
  if (!owner || !repo || !issueNumber) return undefined;
  if (event.callback.threadKey !== `${owner}/${repo}#${issueNumber}`) return undefined;
  return `github:${owner}/${repo}`;
}

export function conversationKeyFromEvent(event: OpenTagEvent): string {
  return explicitConversationKey(event) ?? callbackConversationKey(event.callback);
}

export function conversationMemoryPolicyFromEvent(event: OpenTagEvent) {
  const parsed = ConversationMemoryPolicySchema.safeParse(event.metadata["conversationMemory"]);
  return parsed.success && parsed.data.enabled ? parsed.data : undefined;
}

export function conversationKeysFromEvent(event: OpenTagEvent): string[] {
  return [...new Set([
    conversationKeyFromEvent(event),
    ...conversationKeysFromCallback(event.callback),
    legacyGitHubIssueConversationKey(event)
  ].filter((key): key is string => Boolean(key)))];
}

export function workThreadFromEvent(event: OpenTagEvent): WorkThread | undefined {
  const workItemReference = workItemReferenceFromEvent(event);
  if (!workItemReference) return undefined;

  const primaryAnchor = primaryConversationAnchorFromEvent(event);
  return {
    id: `thread_${workItemReference.provider}_${workItemReference.externalId}_${primaryAnchor.externalId}`,
    workItemReference,
    primaryAnchor
  };
}

export function contextPacketFromEvent(event: OpenTagEvent, emittedAt = event.receivedAt): ContextPacket {
  return assembleContextPacketFromEvent(event, emittedAt);
}

export function protocolRunFieldsFromEvent(
  event: OpenTagEvent,
  emittedAt = event.receivedAt
): { thread?: WorkThread; contextPacket: ContextPacket } {
  const thread = workThreadFromEvent(event);
  const contextPacket = contextPacketFromEvent(event, emittedAt);
  return {
    ...(thread ? { thread } : {}),
    contextPacket
  };
}

export function capabilityForMutationIntent(
  intent: MutationIntent,
  capabilities: readonly CapabilityContract[] = DefaultCapabilityContracts
): CapabilityContract | undefined {
  const capabilityId =
    intent.action === "create_pull_request"
      ? "create_pr"
      : intent.action === "create_issue" || (intent.domain === "issue" && intent.action === "create")
        ? "create_issue"
        : intent.action === "request_review"
          ? "request_review"
          : intent.action === "link_artifact"
            ? "attach_artifact"
            : intent.domain === "status"
              ? "set_status"
              : intent.domain === "assignee"
                ? "set_assignee"
                : intent.domain === "priority"
                  ? "set_priority"
                  : intent.domain === "labels"
                    ? "set_labels"
                    : undefined;

  return capabilityId ? capabilities.find((capability) => capability.id === capabilityId) : undefined;
}

export function resolvePolicy(input: {
  capabilityId: string;
  mutationDomain?: string;
  rules: PolicyRule[];
  defaultDecision?: "allow" | "deny";
}): PolicyResolution {
  const matchingRules = input.rules.filter(
    (rule) =>
      (!rule.capabilityId || rule.capabilityId === input.capabilityId) &&
      (!rule.mutationDomain || rule.mutationDomain === input.mutationDomain)
  );
  const sortedRules = [...matchingRules].sort((left, right) => {
    const scopeDelta = POLICY_SCOPE_ORDER.indexOf(right.scope) - POLICY_SCOPE_ORDER.indexOf(left.scope);
    if (scopeDelta !== 0) return scopeDelta;
    if (left.effect === right.effect) return 0;
    return left.effect === "deny" ? -1 : 1;
  });
  const winningRule = sortedRules[0];
  if (winningRule) {
    return {
      capabilityId: input.capabilityId,
      decision: winningRule.effect,
      resolvedBy: winningRule.scope,
      rules: matchingRules,
      reason: winningRule.reason
    };
  }

  return {
    capabilityId: input.capabilityId,
    decision: input.defaultDecision ?? "deny",
    resolvedBy: "organization_default",
    rules: [],
    reason: input.defaultDecision === "allow" ? "Allowed by default policy." : "Denied by default policy."
  };
}

export function permissionScopesAllowCapability(permissions: PermissionGrant[], capability: CapabilityContract): boolean {
  const grantedScopes = new Set(permissions.map((permission) => permission.scope));
  return capability.requiredPermissionScopes.some((scope) => grantedScopes.has(scope));
}

export function preflightMutationIntent(input: {
  intent: MutationIntent;
  permissions: PermissionGrant[];
  policyRules: PolicyRule[];
  adapter?: string;
  executorConditions?: string[];
  capabilities?: readonly CapabilityContract[];
}): { capability?: CapabilityContract; policyResolution?: PolicyResolution; outcome: ApplyIntentOutcome } {
  const capability = capabilityForMutationIntent(input.intent, input.capabilities);
  if (!capability) {
    return {
      outcome: {
        intentId: input.intent.intentId,
        outcome: "unsupported",
        message: `No capability contract maps mutation action ${input.intent.action}.`
      }
    };
  }

  if (!permissionScopesAllowCapability(input.permissions, capability)) {
    return {
      capability,
      outcome: {
        intentId: input.intent.intentId,
        outcome: "unsupported",
        message: `Missing platform permission for capability ${capability.id}.`
      }
    };
  }
  if (input.adapter && capability.adapterTargets && !capability.adapterTargets.includes(input.adapter)) {
    return {
      capability,
      outcome: {
        intentId: input.intent.intentId,
        outcome: "unsupported",
        message: `Capability ${capability.id} cannot be applied by adapter ${input.adapter}.`
      }
    };
  }
  const missingConditions = (capability.requiredExecutorConditions ?? []).filter(
    (condition) => !(input.executorConditions ?? []).includes(condition)
  );
  if (missingConditions.length > 0) {
    return {
      capability,
      outcome: {
        intentId: input.intent.intentId,
        outcome: "unsupported",
        message: `Missing executor condition(s) for capability ${capability.id}: ${missingConditions.join(", ")}.`
      }
    };
  }

  const policyResolution = resolvePolicy({
    capabilityId: capability.id,
    mutationDomain: input.intent.domain,
    rules: input.policyRules,
    defaultDecision: capability.capabilityClass === "external_write" ? "deny" : "allow"
  });
  if (policyResolution.decision === "deny") {
    return {
      capability,
      policyResolution,
      outcome: {
        intentId: input.intent.intentId,
        outcome: "unsupported",
        message: `OpenTag policy denied capability ${capability.id}: ${policyResolution.reason}`
      }
    };
  }

  return {
    capability,
    policyResolution,
    outcome: {
      intentId: input.intent.intentId,
      outcome: "skipped",
      message: `Preflight passed for ${capability.id}; adapter execution is not implemented in this protocol slice.`
    }
  };
}
