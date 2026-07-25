import { z } from "zod";
import {
  actionReceiptHeading,
  buildActionReceiptsFromResult,
  type ActionReceipt,
  type ActionReceiptContext,
  type ActionReceiptDecision,
  type ActionReceiptPrimaryDecision,
  type ActionReceiptState
} from "./action.js";
import { OpenTagRunResultSchema, type OpenTagRunResult } from "./schema.js";
import { isCredentialSafeText, isCredentialSafeValue } from "./credential-safety.js";

const CredentialSafePresentationTextSchema = z.string().min(1).refine(isCredentialSafeText);

export const OpenTagPresentationActionSchema = z.object({
  index: z.number().int().positive(),
  proposalId: CredentialSafePresentationTextSchema.optional(),
  intentId: CredentialSafePresentationTextSchema.optional(),
  title: CredentialSafePresentationTextSchema,
  state: z.enum(["ready_to_apply", "needs_approval", "needs_setup", "unsupported"]),
  targetLabel: CredentialSafePresentationTextSchema,
  impact: CredentialSafePresentationTextSchema.optional(),
  capabilityState: CredentialSafePresentationTextSchema.optional(),
  approvalRequirement: CredentialSafePresentationTextSchema.optional(),
  safeNextAction: CredentialSafePresentationTextSchema.optional(),
  visibleDecisions: z.array(z.enum(["apply", "approve", "reject", "continue"])),
  primaryDecision: z.enum(["apply", "continue", "none"]),
  setupReason: CredentialSafePresentationTextSchema.optional(),
  details: z.array(CredentialSafePresentationTextSchema).optional(),
  detailRows: z.array(z.object({ label: CredentialSafePresentationTextSchema, value: CredentialSafePresentationTextSchema })).optional()
});

export const OpenTagRunStatusPresentationSchema = z.object({
  kind: z.literal("run_status"),
  runId: z.string().min(1),
  state: z.enum(["received", "queued", "running", "waiting_for_approval", "waiting_for_human", "completed", "failed", "cancelled", "interrupted", "timed_out"]),
  message: z.string().min(1).optional(),
  nextAction: z.string().min(1).optional(),
  detailVisibility: z.enum(["source_thread", "audit"]).optional()
});

export const OpenTagApprovalPromptPresentationSchema = z
  .object({
    kind: z.literal("approval_prompt"),
    runId: z.string().min(1),
    approvalId: z.string().min(1),
    proposalId: z.string().min(1),
    intentId: z.string().min(1),
    actionId: z.string().min(1),
    proposalHash: z.string().min(1),
    approvalEpoch: z.string().min(1),
    title: CredentialSafePresentationTextSchema,
    summary: CredentialSafePresentationTextSchema,
    target: z.object({
      provider: CredentialSafePresentationTextSchema,
      connectionId: CredentialSafePresentationTextSchema,
      operation: CredentialSafePresentationTextSchema,
      resource: CredentialSafePresentationTextSchema,
      resourceVersion: CredentialSafePresentationTextSchema.optional()
    }).strict(),
    runScope: z.record(z.unknown()).refine(isCredentialSafeValue),
    decisions: z.array(z.enum(["allow_once", "allow_run", "deny"])).min(1)
  })
  .strict();

export const OpenTagDoctorCheckPresentationSchema = z.object({
  status: z.enum(["ok", "warn", "fail", "unknown"]),
  name: z.string().min(1),
  message: z.string().min(1).optional()
});

export const OpenTagDoctorSummaryPresentationSchema = z.object({
  kind: z.literal("doctor_summary"),
  title: z.string().min(1),
  checks: z.array(OpenTagDoctorCheckPresentationSchema)
});

export const OpenTagSourceThreadStatusRunSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  updatedAt: z.string().min(1).optional()
});

export const OpenTagSourceThreadQueuedFollowUpSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1).optional(),
  command: z.string().min(1).optional()
});

export const OpenTagSourceThreadStatusPresentationSchema = z.object({
  kind: z.literal("source_thread_status"),
  title: z.string().min(1),
  sourceContainer: z.string().min(1).optional(),
  projectTarget: z.string().min(1).optional(),
  bindingState: z.enum(["bound", "unbound"]),
  activeRun: OpenTagSourceThreadStatusRunSchema.optional(),
  queuedFollowUps: z.array(OpenTagSourceThreadQueuedFollowUpSchema),
  queuedFollowUpsTotal: z.number().int().nonnegative().optional(),
  currentCommand: z.string().min(1).optional(),
  nextAction: z.string().min(1),
  stopHint: z.string().min(1).optional(),
  detailHint: z.string().min(1).optional()
});

export const OpenTagActionReceiptPresentationSchema = z.object({
  kind: z.literal("action_receipt"),
  title: z.string().min(1),
  actions: z.array(OpenTagPresentationActionSchema),
  auditRunId: z.string().min(1).optional()
});

export const OpenTagFinalSummaryPresentationSchema = z.object({
  kind: z.literal("final_summary"),
  outcome: CredentialSafePresentationTextSchema,
  summary: CredentialSafePresentationTextSchema,
  changedFiles: z.array(CredentialSafePresentationTextSchema).optional(),
  artifacts: OpenTagRunResultSchema.shape.artifacts.refine(isCredentialSafeValue),
  verification: OpenTagRunResultSchema.shape.verification.refine(isCredentialSafeValue),
  nextActions: z.array(CredentialSafePresentationTextSchema).optional(),
  actionReceiptTitle: CredentialSafePresentationTextSchema.optional(),
  actions: z.array(OpenTagPresentationActionSchema).optional(),
  auditRunId: CredentialSafePresentationTextSchema.optional(),
  result: OpenTagRunResultSchema.refine(isCredentialSafeValue)
});

export const OpenTagPresentationSchema = z.discriminatedUnion("kind", [
  OpenTagRunStatusPresentationSchema,
  OpenTagApprovalPromptPresentationSchema,
  OpenTagDoctorSummaryPresentationSchema,
  OpenTagSourceThreadStatusPresentationSchema,
  OpenTagActionReceiptPresentationSchema,
  OpenTagFinalSummaryPresentationSchema
]);

export type OpenTagPresentationAction = z.infer<typeof OpenTagPresentationActionSchema>;
export type OpenTagRunStatusPresentation = z.infer<typeof OpenTagRunStatusPresentationSchema>;
export type OpenTagApprovalPromptPresentation = z.infer<typeof OpenTagApprovalPromptPresentationSchema>;
export type OpenTagDoctorCheckPresentation = z.infer<typeof OpenTagDoctorCheckPresentationSchema>;
export type OpenTagDoctorSummaryPresentation = z.infer<typeof OpenTagDoctorSummaryPresentationSchema>;
export type OpenTagSourceThreadStatusRun = z.infer<typeof OpenTagSourceThreadStatusRunSchema>;
export type OpenTagSourceThreadQueuedFollowUp = z.infer<typeof OpenTagSourceThreadQueuedFollowUpSchema>;
export type OpenTagSourceThreadStatusPresentation = z.infer<typeof OpenTagSourceThreadStatusPresentationSchema>;
export type OpenTagActionReceiptPresentation = z.infer<typeof OpenTagActionReceiptPresentationSchema>;
export type OpenTagFinalSummaryPresentation = z.infer<typeof OpenTagFinalSummaryPresentationSchema>;
export type OpenTagPresentation = z.infer<typeof OpenTagPresentationSchema>;
export type OpenTagPresentationDeliveryTier = "silent" | "status" | "attention_required" | "terminal";

export function presentationDeliveryTier(presentation: OpenTagPresentation): OpenTagPresentationDeliveryTier {
  if (presentation.kind === "final_summary") return "terminal";
  if (presentation.kind === "approval_prompt" || presentation.kind === "action_receipt") return "attention_required";
  if (presentation.kind === "run_status") {
    if (presentation.detailVisibility === "audit") return "silent";
    if (["waiting_for_approval", "waiting_for_human", "failed"].includes(presentation.state)) return "attention_required";
    if (["completed", "cancelled", "interrupted", "timed_out"].includes(presentation.state)) return "terminal";
    return "status";
  }
  return "status";
}

export function renderMarkdownArtifactLines(presentation: Pick<OpenTagFinalSummaryPresentation, "artifacts">): string[] {
  if (!presentation.artifacts?.length) return [];
  return [
    "Artifacts:",
    ...presentation.artifacts.map((artifact) => `- ${artifact.kind ? `${artifact.kind}: ` : ""}[${artifact.title}](${artifact.uri})`)
  ];
}

function nextActionSummary(result: OpenTagRunResult): string | undefined {
  if (!result.nextAction) return undefined;
  if (typeof result.nextAction === "string") return result.nextAction;
  return result.nextAction.summary;
}

function presentationActionFromReceipt(receipt: ActionReceipt): OpenTagPresentationAction {
  const impact = actionImpactFromReceipt(receipt);
  const capabilityState = actionCapabilityStateFromReceipt(receipt);
  const approvalRequirement = actionApprovalRequirementFromReceipt(receipt);
  const safeNextAction = actionSafeNextActionFromReceipt(receipt);
  const details = presentationActionDetailsFromReceipt(receipt);
  const detailRows = presentationActionDetailRowsFromReceipt(receipt);
  return {
    index: receipt.candidate.index,
    proposalId: receipt.candidate.proposalId,
    intentId: receipt.candidate.intent.intentId,
    title: receipt.candidate.intent.summary,
    state: receipt.state as ActionReceiptState,
    targetLabel: receipt.targetLabel,
    impact,
    capabilityState,
    approvalRequirement,
    safeNextAction,
    visibleDecisions: receipt.visibleDecisions as ActionReceiptDecision[],
    primaryDecision: receipt.primaryDecision as ActionReceiptPrimaryDecision,
    ...(receipt.setupReason ? { setupReason: receipt.setupReason } : {}),
    ...(details.length ? { details } : {}),
    ...(detailRows.length ? { detailRows } : {})
  };
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayParam(params: Record<string, unknown> | undefined, key: string): string[] {
  const value = params?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function listValue(values: string[]): string {
  return values.join("\n");
}

function actionDecisionCommand(decision: ActionReceiptDecision, index: number): string {
  return `${decision} ${index}`;
}

function commandForDecision(receipt: ActionReceipt, decision: ActionReceiptDecision): string {
  return inlineCode(actionDecisionCommand(decision, receipt.candidate.index));
}

function actionImpactFromReceipt(receipt: ActionReceipt): string {
  const intent = receipt.candidate.intent;
  const params = intent.params;
  if (intent.action === "create_pull_request") {
    const head = stringParam(params, "head") ?? stringParam(params, "branch") ?? "unknown";
    const base = stringParam(params, "base") ?? stringParam(params, "baseBranch") ?? "main";
    const changedFiles = stringArrayParam(params, "changedFiles");
    const fileText = changedFiles.length === 1 ? "1 changed file" : `${changedFiles.length} changed files`;
    return `Creates a pull request from ${inlineCode(head)} into ${inlineCode(base)} with ${fileText}.`;
  }
  if (intent.action === "create_issue" || (intent.domain === "issue" && intent.action === "create")) {
    const title = stringParam(params, "title") ?? "untitled issue";
    const team = stringParam(params, "team") ?? stringParam(params, "teamKey") ?? stringParam(params, "teamId");
    return team
      ? `Creates a new Linear issue titled ${inlineCode(title)} for team ${inlineCode(team)}.`
      : `Creates a new Linear issue titled ${inlineCode(title)}.`;
  }
  if (intent.domain === "labels") return "Writes label metadata on the source work item.";
  if (intent.domain === "assignee" || intent.domain === "assignees") return "Writes assignee metadata on the source work item.";
  if (intent.domain === "review") return "Requests review on the source work item or proposed code change.";
  if (intent.domain === "artifact_links") return "Attaches or references an OpenTag artifact without changing repository files.";
  if (intent.domain === "follow_up") return "Starts a bounded follow-up run from this source-thread action.";
  return `Proposes ${intent.action} on ${intent.domain}.`;
}

function actionCapabilityStateFromReceipt(receipt: ActionReceipt): string {
  if (receipt.state === "ready_to_apply") {
    return "Adapter capability and preflight allow direct apply for this target.";
  }
  if (receipt.state === "needs_approval") {
    return "External write is withheld until a human records approval.";
  }
  if (receipt.state === "needs_setup") {
    return `Direct apply is blocked by setup or preflight: ${receipt.setupReason ?? "setup is required"}.`;
  }
  return receipt.setupReason
    ? `No safe direct apply path is available here: ${receipt.setupReason}.`
    : "No safe direct apply path is available from this source thread.";
}

function actionApprovalRequirementFromReceipt(receipt: ActionReceipt): string {
  if (receipt.state === "ready_to_apply") {
    return `Review impact, then use ${commandForDecision(receipt, "apply")} to approve and apply, or ${commandForDecision(receipt, "reject")}.`;
  }
  if (receipt.state === "needs_approval") {
    return `Use ${commandForDecision(receipt, "approve")} to record approval without applying yet, or ${commandForDecision(receipt, "reject")}.`;
  }
  if (receipt.state === "needs_setup") {
    return "Approval alone cannot apply this action until setup or preflight is fixed.";
  }
  return "No approval path is advertised for this unsupported action.";
}

function actionSafeNextActionFromReceipt(receipt: ActionReceipt): string {
  if (receipt.primaryDecision === "apply" && receipt.visibleDecisions.includes("apply")) {
    return `${commandForDecision(receipt, "apply")} is the safe apply path after reviewing this receipt.`;
  }
  if (receipt.primaryDecision === "continue" && receipt.visibleDecisions.includes("continue")) {
    return `${commandForDecision(receipt, "continue")} continues in a bounded follow-up run without silently writing externally.`;
  }
  if (receipt.visibleDecisions.includes("approve")) {
    return `${commandForDecision(receipt, "approve")} records human approval; OpenTag will not silently apply.`;
  }
  if (receipt.visibleDecisions.includes("continue")) {
    return `${commandForDecision(receipt, "continue")} is the safest continuation path.`;
  }
  return `${commandForDecision(receipt, "reject")} leaves the source system unchanged.`;
}

function actionFallbackFromReceipt(receipt: ActionReceipt): string | undefined {
  if (!receipt.visibleDecisions.includes("continue")) return undefined;
  if (receipt.state === "ready_to_apply") return undefined;
  return `${commandForDecision(receipt, "continue")} starts a follow-up run instead of applying an external write.`;
}

function renderVerificationParams(params: Record<string, unknown> | undefined): string[] {
  const value = params?.["verification"];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const command = (item as Record<string, unknown>)["command"];
      const outcome = (item as Record<string, unknown>)["outcome"];
      const summary = (item as Record<string, unknown>)["summary"];
      if (typeof outcome !== "string") return undefined;
      const prefix = typeof command === "string" && command.length > 0 ? `${inlineCode(command)}: ${outcome}` : outcome;
      return typeof summary === "string" && summary.length > 0 ? `${prefix} - ${summary}` : prefix;
    })
    .filter((line): line is string => Boolean(line));
}

function presentationActionDetailsFromReceipt(receipt: ActionReceipt): string[] {
  const details: string[] = [
    `Impact: ${actionImpactFromReceipt(receipt)}`,
    `Capability/preflight: ${actionCapabilityStateFromReceipt(receipt)}`,
    `Approval: ${actionApprovalRequirementFromReceipt(receipt)}`,
    `Safe next action: ${actionSafeNextActionFromReceipt(receipt)}`
  ];
  const fallback = actionFallbackFromReceipt(receipt);
  if (fallback) details.push(`Fallback: ${fallback}`);
  const params = receipt.candidate.intent.params;
  if (receipt.candidate.intent.action === "create_pull_request") {
    const head = stringParam(params, "head") ?? stringParam(params, "branch");
    const base = stringParam(params, "base") ?? stringParam(params, "baseBranch");
    const changedFiles = stringArrayParam(params, "changedFiles");
    if (head || base) details.push(`Branch: \`${head ?? "unknown"}\` -> \`${base ?? "main"}\``);
    if (changedFiles.length > 0) details.push(`Changed files: ${changedFiles.map((file) => `\`${file}\``).join(", ")}`);
  }
  if (receipt.candidate.intent.action === "create_issue" || (receipt.candidate.intent.domain === "issue" && receipt.candidate.intent.action === "create")) {
    const title = stringParam(params, "title");
    const team = stringParam(params, "team") ?? stringParam(params, "teamKey") ?? stringParam(params, "teamId");
    const labels = stringArrayParam(params, "labels").concat(stringArrayParam(params, "labelIds"));
    if (title) details.push(`Title: ${inlineCode(title)}`);
    if (team) details.push(`Team: ${inlineCode(team)}`);
    if (labels.length > 0) details.push(`Labels: ${labels.map(inlineCode).join(", ")}`);
  }
  if (receipt.candidate.proposalPreconditions?.length) {
    details.push(`Preconditions: ${receipt.candidate.proposalPreconditions.length} check(s) in the audit log.`);
  }
  return details;
}

function presentationActionDetailRowsFromReceipt(receipt: ActionReceipt): Array<{ label: string; value: string }> {
  const candidate = receipt.candidate;
  const params = candidate.intent.params;
  const rows: Array<{ label: string; value: string }> = [
    { label: "Target", value: receipt.targetLabel },
    { label: "Impact", value: actionImpactFromReceipt(receipt) },
    { label: "Capability / preflight", value: actionCapabilityStateFromReceipt(receipt) },
    { label: "Required approval", value: actionApprovalRequirementFromReceipt(receipt) },
    { label: "Safe next action", value: actionSafeNextActionFromReceipt(receipt) }
  ];
  const fallback = actionFallbackFromReceipt(receipt);
  if (fallback) rows.push({ label: "Fallback", value: fallback });
  if (receipt.setupReason) rows.push({ label: "Status", value: receipt.setupReason });
  if (candidate.intent.action === "create_pull_request") {
    const title = stringParam(params, "title");
    const head = stringParam(params, "head") ?? stringParam(params, "branch");
    const base = stringParam(params, "base") ?? stringParam(params, "baseBranch");
    const changedFiles = stringArrayParam(params, "changedFiles");
    const risks = stringArrayParam(params, "risks");
    const verification = renderVerificationParams(params);
    if (title) rows.push({ label: "Title", value: title });
    if (head || base) rows.push({ label: "Branch", value: `${inlineCode(head ?? "unknown")} -> ${inlineCode(base ?? "main")}` });
    if (changedFiles.length > 0) rows.push({ label: "Changed files", value: changedFiles.map(inlineCode).join(", ") });
    if (verification.length > 0) rows.push({ label: "Verification", value: listValue(verification) });
    if (risks.length > 0) rows.push({ label: "Risks", value: listValue(risks) });
  }
  if (candidate.intent.action === "create_issue" || (candidate.intent.domain === "issue" && candidate.intent.action === "create")) {
    const title = stringParam(params, "title");
    const description = stringParam(params, "description") ?? stringParam(params, "body");
    const team = stringParam(params, "team") ?? stringParam(params, "teamKey") ?? stringParam(params, "teamId");
    const priority = stringParam(params, "priority");
    const labels = stringArrayParam(params, "labels").concat(stringArrayParam(params, "labelIds"));
    if (title) rows.push({ label: "Title", value: title });
    if (team) rows.push({ label: "Team", value: inlineCode(team) });
    if (priority) rows.push({ label: "Priority", value: inlineCode(priority) });
    if (labels.length > 0) rows.push({ label: "Labels", value: labels.map(inlineCode).join(", ") });
    if (description) rows.push({ label: "Description", value: description });
  }
  if (candidate.proposalPreconditions?.length) {
    rows.push({ label: "Preconditions", value: listValue(candidate.proposalPreconditions) });
  }
  return rows;
}

export function createRunStatusPresentation(input: {
  runId: string;
  state: OpenTagRunStatusPresentation["state"];
  message?: string;
  nextAction?: string;
  detailVisibility?: OpenTagRunStatusPresentation["detailVisibility"];
}): OpenTagRunStatusPresentation {
  return OpenTagRunStatusPresentationSchema.parse({
    kind: "run_status",
    runId: input.runId,
    state: input.state,
    ...(input.message ? { message: input.message } : {}),
    ...(input.nextAction ? { nextAction: input.nextAction } : {}),
    ...(input.detailVisibility ? { detailVisibility: input.detailVisibility } : {})
  });
}

export function createDoctorSummaryPresentation(input: {
  title?: string;
  checks: OpenTagDoctorCheckPresentation[];
}): OpenTagDoctorSummaryPresentation {
  return OpenTagDoctorSummaryPresentationSchema.parse({
    kind: "doctor_summary",
    title: input.title ?? "OpenTag doctor",
    checks: input.checks.map((check) => ({
      status: check.status,
      name: check.name,
      ...(check.message ? { message: check.message } : {})
    }))
  });
}

export function createSourceThreadStatusPresentation(input: {
  title?: string;
  sourceContainer?: string;
  projectTarget?: string;
  bindingState: OpenTagSourceThreadStatusPresentation["bindingState"];
  activeRun?: OpenTagSourceThreadStatusRun;
  queuedFollowUps?: OpenTagSourceThreadQueuedFollowUp[];
  queuedFollowUpsTotal?: number;
  currentCommand?: string;
  nextAction: string;
  stopHint?: string;
  detailHint?: string;
}): OpenTagSourceThreadStatusPresentation {
  return OpenTagSourceThreadStatusPresentationSchema.parse({
    kind: "source_thread_status",
    title: input.title ?? "OpenTag status",
    ...(input.sourceContainer ? { sourceContainer: input.sourceContainer } : {}),
    ...(input.projectTarget ? { projectTarget: input.projectTarget } : {}),
    bindingState: input.bindingState,
    ...(input.activeRun ? { activeRun: input.activeRun } : {}),
    queuedFollowUps: input.queuedFollowUps ?? [],
    ...(input.queuedFollowUpsTotal !== undefined ? { queuedFollowUpsTotal: input.queuedFollowUpsTotal } : {}),
    ...(input.currentCommand ? { currentCommand: input.currentCommand } : {}),
    nextAction: input.nextAction,
    ...(input.stopHint ? { stopHint: input.stopHint } : {}),
    ...(input.detailHint ? { detailHint: input.detailHint } : {})
  });
}

export function createActionReceiptPresentation(input: {
  result: OpenTagRunResult;
  receiptContext?: ActionReceiptContext;
  auditRunId?: string;
}): OpenTagActionReceiptPresentation | null {
  const receipts = buildActionReceiptsFromResult(input.result, input.receiptContext);
  if (receipts.length === 0) return null;
  return OpenTagActionReceiptPresentationSchema.parse({
    kind: "action_receipt",
    title: actionReceiptHeading(receipts),
    actions: receipts.map(presentationActionFromReceipt),
    ...(input.auditRunId ? { auditRunId: input.auditRunId } : {})
  });
}

export function createFinalSummaryPresentation(input: {
  result: OpenTagRunResult;
  receiptContext?: ActionReceiptContext;
  auditRunId?: string;
}): OpenTagFinalSummaryPresentation {
  const actionReceipt = createActionReceiptPresentation(input);
  const nextAction = nextActionSummary(input.result);
  return OpenTagFinalSummaryPresentationSchema.parse({
    kind: "final_summary",
    outcome: input.result.conclusion,
    summary: input.result.summary,
    ...(input.result.changedFiles?.length ? { changedFiles: input.result.changedFiles } : {}),
    ...(input.result.artifacts?.length ? { artifacts: input.result.artifacts } : {}),
    ...(input.result.verification?.length ? { verification: input.result.verification } : {}),
    ...(nextAction ? { nextActions: [nextAction] } : {}),
    ...(actionReceipt ? { actionReceiptTitle: actionReceipt.title, actions: actionReceipt.actions } : {}),
    ...(input.auditRunId ? { auditRunId: input.auditRunId } : {}),
    result: input.result
  });
}

export function renderOpenTagPresentationPlainText(presentation: OpenTagPresentation): string {
  if (presentation.kind === "run_status") {
    return [
      `Run ${presentation.runId}: ${presentation.state}`,
      ...(presentation.message ? [`Message: ${presentation.message}`] : []),
      ...(presentation.nextAction ? [`Next action: ${presentation.nextAction}`] : [])
    ].join("\n");
  }
  if (presentation.kind === "approval_prompt") {
    return [
      presentation.title,
      presentation.summary,
      `Run scope: ${renderApprovalRunScope(presentation.runScope)}`,
      `Decisions: ${presentation.decisions.join(", ")}`,
      `Approval: ${presentation.approvalId}`,
      `Run: ${presentation.runId}`
    ].join("\n");
  }
  if (presentation.kind === "doctor_summary") {
    return [
      presentation.title,
      ...presentation.checks.map((check) => `${check.status.toUpperCase()} ${check.name}${check.message ? `: ${check.message}` : ""}`)
    ].join("\n");
  }
  if (presentation.kind === "source_thread_status") {
    const queuedTotal = presentation.queuedFollowUpsTotal ?? presentation.queuedFollowUps.length;
    const queuedOverflow = Math.max(queuedTotal - presentation.queuedFollowUps.length, 0);
    const queuedIds = presentation.queuedFollowUps.map((followUp) => {
      const status = followUp.status ? ` (${followUp.status})` : "";
      const command = followUp.command ? `: ${followUp.command}` : "";
      return `${followUp.id}${status}${command}`;
    });
    const queuedDetail =
      queuedIds.length > 0 ? ` (${queuedIds.join(", ")}${queuedOverflow > 0 ? `, +${queuedOverflow} more` : ""})` : "";
    const queuedFollowUps =
      queuedTotal === 0
        ? "none"
        : `${queuedTotal}${queuedDetail}`;
    const activeRun = presentation.activeRun
      ? `${presentation.activeRun.id} (${presentation.activeRun.status})${presentation.activeRun.updatedAt ? `, updated ${presentation.activeRun.updatedAt}` : ""}`
      : "none";
    return [
      presentation.title,
      ...(presentation.sourceContainer ? [`Source container: ${presentation.sourceContainer}`] : []),
      `Project Target: ${presentation.projectTarget ?? "not bound"}`,
      `Active run: ${activeRun}`,
      ...(presentation.currentCommand ? [`Command: ${presentation.currentCommand}`] : []),
      `Queued follow-ups: ${queuedFollowUps}`,
      `Next action: ${presentation.nextAction}`,
      ...(presentation.stopHint ? [`Stop/timeout: ${presentation.stopHint}`] : []),
      ...(presentation.detailHint ? [`Details: ${presentation.detailHint}`] : [])
    ].join("\n");
  }
  if (presentation.kind === "action_receipt") {
    const lines = [presentation.title];
    for (const action of presentation.actions) {
      lines.push(`${action.index}. ${action.title}`);
      lines.push(`Target: ${action.targetLabel}`);
      if (action.setupReason) lines.push(`Status: ${action.setupReason}`);
      if (action.details?.length) lines.push(...action.details);
      lines.push(`Actions: ${action.visibleDecisions.map((decision) => actionDecisionCommand(decision, action.index)).join(", ")}`);
    }
    if (presentation.auditRunId) lines.push(`Audit: opentag status --run ${presentation.auditRunId}`);
    return lines.join("\n");
  }
  return [
    `Finished: ${presentation.outcome}`,
    presentation.summary,
    ...(presentation.changedFiles?.length ? ["Changed files:", ...presentation.changedFiles.map((file) => `- ${file}`)] : []),
    ...(presentation.artifacts?.length ? ["Artifacts:", ...presentation.artifacts.map((artifact) => `- ${artifact.title}: ${artifact.uri}`)] : []),
    ...(presentation.verification?.length ? ["Verification:", ...presentation.verification.map((check) => `- ${check.command}: ${check.outcome}`)] : []),
    ...(presentation.nextActions?.length ? ["Next actions:", ...presentation.nextActions.map((action) => `- ${action}`)] : []),
    ...(presentation.actions?.length
      ? [
          presentation.actionReceiptTitle ?? "Suggested actions",
          ...presentation.actions.flatMap((action) => [
            `${action.index}. ${action.title}`,
            `Target: ${action.targetLabel}`,
            ...(action.setupReason ? [`Status: ${action.setupReason}`] : []),
            ...(action.details?.length ? action.details : []),
            `Actions: ${action.visibleDecisions.map((decision) => actionDecisionCommand(decision, action.index)).join(", ")}`
          ])
        ]
      : []),
    ...(presentation.auditRunId ? [`Audit: opentag status --run ${presentation.auditRunId}`] : [])
  ].join("\n");
}

function stablePresentationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePresentationJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stablePresentationJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function renderApprovalRunScope(scope: Record<string, unknown>): string {
  return Object.entries(scope)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${stablePresentationJson(value)}`)
    .join(", ");
}
