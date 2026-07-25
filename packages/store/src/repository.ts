import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  AgentAccessProfileSnapshotSchema,
  ApprovalDecisionSchema,
  ActorIdentitySchema,
  ActionPermissionRequestSchema,
  ActionPermissionResolutionSchema,
  ActionSchema,
  actionScopeAllowsRunReuse,
  MaterialActionReceiptSchema,
  ApplyIntentOutcomeSchema,
  ApplyPlanSchema,
  AttemptSchema,
  ActionHintSchema,
  AdapterMutationMappingSchema,
  CompletionAssessmentSchema,
  CompletionContractSchema,
  CompletionWaiverSchema,
  ContextPacketSchema,
  conversationKeyFromEvent,
  defaultRunEventMetadata,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  PolicyRuleSchema,
  PolicySnapshotProvenanceSchema,
  ProposalLineageSchema,
  preflightMutationIntent,
  evaluateActionPermission,
  grantMatchesAction,
  containsCredentialLikeData,
  FollowUpRequestSchema,
  isCredentialFieldName,
  redactCredentialLikeData,
  sanitizeCredentialLikeValue,
  normalizeMaterialActionRequest,
  OpenTagManagedChannelBindingOwnershipSchema,
  formatProjectTargetRef,
  projectTargetRefFromEvent,
  protocolRunFieldsFromEvent,
  RunAdmissionDecisionSchema,
  RunEventImportanceSchema,
  RunEventVisibilitySchema,
  SuggestedChangesSnapshotSchema,
  HumanEscalationSchema,
  VerificationEvidenceSchema,
  WorkThreadSchema,
  type ApprovalDecision,
  type AgentAccessProfileSnapshot,
  type ActorIdentity,
  type Action,
  type ActionPermissionRequest,
  type ActionPermissionResolution,
  type MaterialActionReceipt,
  type Attempt,
  type ApplyIntentOutcome,
  type ApplyPlan,
  type ActionHint,
  type AdapterMutationMapping,
  type CompletionAssessment,
  type CompletionContract,
  type CompletionWaiver,
  type HumanEscalation,
  type MutationIntentActionability,
  type OpenTagEvent,
  type OpenTagManagedChannelBindingOwnership,
  type OpenTagRun,
  type OpenTagRunResult,
  type PolicyRule,
  type PolicySnapshotProvenance,
  type ProjectTargetRef,
  type ProposalLineage,
  type RunAdmissionDecision,
  type RunEventImportance,
  type RunEventVisibility,
  type SuggestedChangesSnapshot,
  type VerificationEvidence,
  type WorkThread
} from "@opentag/core";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { alias } from "drizzle-orm/sqlite-core";
import {
  applyPlans,
  attempts,
  approvalDecisions,
  grants,
  materialActions,
  channelBindings,
  completionAssessments,
  completionContracts,
  completionWaivers,
  controlPlaneEvents,
  governanceEvents,
  humanEscalations,
  linearOAuthInstallStates,
  linearRelayInstallations,
  repoBindings,
  repoMutationMappings,
  repoPolicyRules,
  callbackDeliveries,
  followUpRequests,
  runEvents,
  sourceDeliveries,
  runners,
  runs,
  suggestedChanges,
  verificationEvidenceRecords,
  workThreads
} from "./schema.js";

export type OpenTagRunWithEvent = {
  run: OpenTagRun;
  event: OpenTagEvent;
};

export type DurableWorkThread = WorkThread & { id: string };

export type StoredVerificationEvidence = {
  id: string;
  workThreadId?: string;
  provider: string;
  deliveryId: string;
  subjectRef: string;
  subjectVersion: string;
  evidence: VerificationEvidence;
  payloadDigest: string;
  observedAt: string;
  receivedAt: string;
};

export type RecordVerificationEvidenceInput = {
  id?: string;
  workThreadId?: string;
  provider: string;
  deliveryId: string;
  subjectRef: string;
  subjectVersion: string;
  evidence: VerificationEvidence;
  payloadDigest?: string;
  observedAt?: string;
  receivedAt?: string;
};

export type GovernanceAuditEvent = {
  id: number;
  workThreadId?: string;
  type: string;
  subjectId?: string;
  payload: unknown;
  createdAt: string;
};

export class ChannelBindingCorruptionError extends Error {
  override readonly name = "ChannelBindingCorruptionError";
}

export type ClaimedOpenTagRun = OpenTagRunWithEvent & {
  attemptId: string;
  attemptNumber: number;
  fencingToken: string;
};

export type OpenTagAuditEvent = {
  id: number;
  runId: string;
  type: string;
  visibility: RunEventVisibility;
  importance: RunEventImportance;
  message?: string;
  payload: unknown;
  createdAt: string;
};

export type AgentWorkLedgerCategory =
  | "source_event"
  | "admission"
  | "context_packet"
  | "executor_capability"
  | "lifecycle"
  | "progress_visibility"
  | "approval_decision"
  | "apply_plan"
  | "artifact"
  | "callback_delivery"
  | "final_outcome"
  | "error"
  | "cancellation"
  | "timeout"
  | "audit";

export type AgentWorkLedgerEntry = OpenTagAuditEvent & {
  sequence: number;
  category: AgentWorkLedgerCategory;
};

export type AgentWorkLedger = {
  runId: string;
  entries: AgentWorkLedgerEntry[];
};

export type CallbackDeliveryKind = "acknowledgement" | "progress" | "final";
export type CallbackDeliveryProvider = string;
export type CallbackDeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export type CallbackDelivery = {
  id: number;
  runId: string;
  kind: CallbackDeliveryKind;
  provider: CallbackDeliveryProvider;
  uri: string;
  body: string;
  threadKey?: string;
  idempotencyKey?: string;
  agentId?: string;
  statusMessageKey?: string;
  externalMessageId?: string;
  blocks?: unknown[];
  rich?: unknown;
  status: CallbackDeliveryStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EnqueuedCallbackDelivery = CallbackDelivery & {
  enqueueOutcome: "queued" | "duplicate";
};

export type RepoBinding = {
  provider: string;
  owner: string;
  repo: string;
  runnerId: string;
  workspacePath?: string;
  defaultExecutor?: string;
  allowedActors?: string[];
};

export type ChannelBinding = {
  provider: string;
  accountId: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
  ownership?: OpenTagManagedChannelBindingOwnership;
} & (
  | { repoProvider: string; owner: string; repo: string }
  | { repoProvider?: never; owner?: never; repo?: never }
);

export type SlackChannelBinding = {
  teamId: string;
  channelId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

export type LinearRelayInstallation = {
  id: string;
  webhookPath: string;
  webhookSecret: string;
  token: string;
  auth?: LinearRelayInstallationAuth;
  graphqlUrl?: string;
  repoProvider: string;
  owner: string;
  repo: string;
  organizationId?: string;
  teamId?: string;
  teamKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type LinearRelayInstallationAuth =
  | {
      method: "api_key";
    }
  | {
      method: "oauth_app";
      actor: "app";
      clientId?: string;
      refreshToken?: string;
      accessTokenExpiresAt?: string;
      appUserId?: string;
      scopes?: string[];
    };

export type LinearOAuthInstallState = {
  state: string;
  installationId: string;
  webhookPath: string;
  webhookSecret: string;
  redirectUri: string;
  graphqlUrl?: string;
  repoProvider: string;
  owner: string;
  repo: string;
  teamId?: string;
  teamKey?: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
};

export type RunnerRegistration = {
  runnerId: string;
  name: string;
  createdAt: string;
  heartbeatAt?: string;
};

export type StoredSuggestedChangesSnapshot = {
  runId: string;
  snapshot: SuggestedChangesSnapshot;
};

export type StoredSuggestedChangesInConversation = StoredSuggestedChangesSnapshot & {
  run: OpenTagRun;
  event: OpenTagEvent;
};

type RunSignatureState = "verified" | "unverified" | "unknown";

type RunProvenance = {
  source: string;
  sourceEventId: string;
  sourceDeliveryId: string | null;
  signatureState: RunSignatureState;
  projectTarget: (ProjectTargetRef & { ref: string }) | null;
  admissionDecision: Pick<RunAdmissionDecision, "action" | "reasonCode" | "eventId" | "activeRunId">;
  expectedRunnerId: string | null;
};

export type ApplyOutcomeCounts = {
  applied: number;
  skipped: number;
  failed: number;
  stale: number;
  unsupported: number;
};

export type CreateRunResult =
  | {
      run: OpenTagRun;
      created: true;
    }
  | {
      run: OpenTagRun;
      created: false;
      replayKind: "source_event" | "source_delivery";
      replayDecision: RunAdmissionDecision;
    };

export type CancelRunOutcome =
  | { outcome: "cancelled"; run: OpenTagRun; event: OpenTagEvent }
  | { outcome: "already_terminal"; run: OpenTagRun; event: OpenTagEvent }
  | { outcome: "not_found" };

export type SourceDeliveryPruneResult = {
  scanned: number;
  pruned: number;
  retainedActive: number;
};

export type FollowUpRequest = {
  id: string;
  sourceEventId: string;
  conversationKey: string;
  activeRunId?: string;
  event: OpenTagEvent;
  decision: RunAdmissionDecision;
  accessProfileSnapshot?: AgentAccessProfileSnapshot;
  policySnapshotProvenance?: PolicySnapshotProvenance;
  status: "queued" | "promoting" | "promoted" | "cancelled";
  createdRunId?: string;
  createdAt: string;
  updatedAt: string;
};

export type OpenTagRunMetrics = {
  runId: string;
  totalEventCount: number;
  humanEventCount: number;
  auditEventCount: number;
  debugEventCount: number;
  humanCallbackCount: number;
  threadNoiseRatio: number;
  suggestedChangesCount: number;
  approvalDecisionCount: number;
  applyPlanCount: number;
  childRunCount: number;
  applyOutcomeCounts: ApplyOutcomeCounts;
  staleIntentCount: number;
};

export type OpenTagAggregateMetrics = {
  scope: "repo" | "work_thread";
  scopeId: string;
  runCount: number;
  totalEventCount: number;
  humanEventCount: number;
  auditEventCount: number;
  debugEventCount: number;
  humanCallbackCount: number;
  threadNoiseRatio: number;
  suggestedChangesCount: number;
  approvalDecisionCount: number;
  applyPlanCount: number;
  childRunCount: number;
  applyOutcomeCounts: ApplyOutcomeCounts;
  staleIntentCount: number;
};

export type AttemptMutationConflict = "stale_attempt";
export type HeartbeatOutcome = "updated" | AttemptMutationConflict | "not_found";
export type RecordProgressOutcome =
  | { outcome: "recorded" | "duplicate"; event: OpenTagAuditEvent }
  | AttemptMutationConflict
  | "not_found";
export type MarkRunningOutcome = "running" | "duplicate" | AttemptMutationConflict | "not_found";
export type CompleteRunOutcome = "completed" | "duplicate" | AttemptMutationConflict | "not_found";

export type ControlPlaneEventSeverity = "info" | "warn" | "error";

export type ControlPlaneEvent = {
  id: number;
  type: string;
  severity: ControlPlaneEventSeverity;
  subject?: string;
  payload: unknown;
  createdAt: string;
};

export type ControlPlaneAlert = {
  id: string;
  type:
    | "repeated_auth_failures"
    | "repeated_signature_failures"
    | "token_misuse"
    | "repeated_large_payload_rejections"
    | "repeated_invalid_request_body"
    | "repeated_unknown_project_targets"
    | "abnormal_runner_claim_rate";
  severity: ControlPlaneEventSeverity;
  eventType: string;
  count: number;
  threshold: number;
  firstSeenAt: string;
  lastSeenAt: string;
  subject?: string;
  reason: string;
  nextAction: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function workThreadCanonicalKey(thread: WorkThread): string {
  const workItem = thread.workItemReference;
  return JSON.stringify([
    workItem.provider,
    workItem.ownerContainer?.provider ?? "",
    workItem.ownerContainer?.id ?? "",
    workItem.kind,
    workItem.externalId
  ]);
}

function conversationAnchorKey(anchor: WorkThread["primaryAnchor"]): string {
  return JSON.stringify([anchor.provider, anchor.kind, anchor.externalId, anchor.threadKey ?? ""]);
}

function mergeWorkThreadAnchors(current: DurableWorkThread, incoming: WorkThread): DurableWorkThread {
  const known = new Set([
    conversationAnchorKey(current.primaryAnchor),
    ...(current.secondaryAnchors ?? []).map(conversationAnchorKey)
  ]);
  const additions = [incoming.primaryAnchor, ...(incoming.secondaryAnchors ?? [])].filter((anchor) => {
    const key = conversationAnchorKey(anchor);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  return WorkThreadSchema.parse({
    ...current,
    id: current.id,
    workItemReference: incoming.workItemReference,
    primaryAnchor: current.primaryAnchor,
    secondaryAnchors: [...(current.secondaryAnchors ?? []), ...additions]
  }) as DurableWorkThread;
}

function workThreadFromRow(row: typeof workThreads.$inferSelect): DurableWorkThread {
  const thread = WorkThreadSchema.parse(JSON.parse(row.threadJson));
  return { ...thread, id: row.id };
}

function completionContractFromRow(row: typeof completionContracts.$inferSelect): CompletionContract {
  return CompletionContractSchema.parse(JSON.parse(row.contractJson));
}

function completionAssessmentFromRow(row: typeof completionAssessments.$inferSelect): CompletionAssessment {
  return CompletionAssessmentSchema.parse(JSON.parse(row.assessmentJson));
}

function completionWaiverFromRow(row: typeof completionWaivers.$inferSelect): CompletionWaiver {
  return CompletionWaiverSchema.parse(JSON.parse(row.waiverJson));
}

function storedVerificationEvidenceFromRow(
  row: typeof verificationEvidenceRecords.$inferSelect
): StoredVerificationEvidence {
  return {
    id: row.id,
    ...(row.workThreadId ? { workThreadId: row.workThreadId } : {}),
    provider: row.provider,
    deliveryId: row.deliveryId,
    subjectRef: row.subjectRef,
    subjectVersion: row.subjectVersion,
    evidence: VerificationEvidenceSchema.parse(JSON.parse(row.evidenceJson)),
    payloadDigest: row.payloadDigest,
    observedAt: row.observedAt,
    receivedAt: row.receivedAt
  };
}

function humanEscalationFromRow(row: typeof humanEscalations.$inferSelect): HumanEscalation {
  return HumanEscalationSchema.parse(JSON.parse(row.escalationJson));
}

function governanceEventFromRow(row: typeof governanceEvents.$inferSelect): GovernanceAuditEvent {
  return {
    id: row.id,
    ...(row.workThreadId ? { workThreadId: row.workThreadId } : {}),
    type: row.type,
    ...(row.subjectId ? { subjectId: row.subjectId } : {}),
    payload: JSON.parse(row.payloadJson) as unknown,
    createdAt: row.createdAt
  };
}

function isIsoExpired(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() <= now.getTime();
}

function hasActiveAttemptLease(
  attempt: Pick<typeof attempts.$inferSelect, "leaseExpiresAt">,
  now = new Date()
): boolean {
  const leaseExpiresAt = attempt.leaseExpiresAt;
  const parsed = AttemptSchema.shape.leaseExpiresAt.safeParse(leaseExpiresAt);
  if (!parsed.success) return false;
  const expiresAt = Date.parse(parsed.data);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function newAttemptId(): string {
  return `attempt_${randomUUID()}`;
}

function newFencingToken(): string {
  return randomBytes(32).toString("base64url");
}

function attemptFromRow(row: typeof attempts.$inferSelect): Attempt {
  return {
    id: row.id,
    runId: row.runId,
    number: row.number,
    runnerId: row.runnerId,
    status: row.status as Attempt["status"],
    startedAt: row.startedAt,
    heartbeatAt: row.heartbeatAt,
    leaseExpiresAt: row.leaseExpiresAt,
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.resultJson ? { result: OpenTagRunResultSchema.parse(JSON.parse(row.resultJson)) } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function actionFromRow(row: typeof materialActions.$inferSelect): Action {
  return ActionSchema.parse({
    id: row.id,
    runId: row.runId,
    attemptId: row.attemptId,
    actionFamily: row.actionFamily,
    capability: row.capability,
    scope: JSON.parse(row.scopeJson) as unknown,
    target: JSON.parse(row.targetJson) as unknown,
    riskTier: row.riskTier,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    ...(row.proposalId ? { proposalId: row.proposalId } : {}),
    ...(row.proposalHash ? { proposalHash: row.proposalHash } : {}),
    ...(row.decisionSnapshotHash ? { decisionSnapshotHash: row.decisionSnapshotHash } : {}),
    attemptFenceDigest: row.attemptFenceDigest,
    ...(row.receiptJson ? { receipt: JSON.parse(row.receiptJson) as unknown } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function progressIdempotencyDigest(idempotencyKey: string): string {
  return createHash("sha256")
    .update("opentag.progress-idempotency.v1\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest("hex");
}

function stableActionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableActionJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableActionJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const SAFE_RECEIPT_METADATA_KEYS = new Set([
  "assurance",
  "agentReportedOutcome",
  "toolCallId",
  "providerOperationId",
  "statusCode",
  "reconciliationIdempotencyKey",
  "reconciliationSource",
  "reconciliationActorId"
]);

function sanitizeMaterialActionReceipt(receipt: MaterialActionReceipt, options: { allowEvidence?: boolean } = {}): MaterialActionReceipt {
  if (receipt.evidence?.length && !options.allowEvidence) {
    throw new Error("Material action receipt evidence is not accepted until each evidence field has a durable safe-list policy.");
  }
  const evidence = options.allowEvidence ? receipt.evidence?.map((item) => VerificationEvidenceSchema.parse({
    id: sanitizeCredentialLikeValue(item.id).toString().slice(0, 256),
    kind: sanitizeCredentialLikeValue(item.kind).toString().slice(0, 128),
    assurance: item.assurance,
    subjectRef: sanitizeCredentialLikeValue(item.subjectRef).toString().slice(0, 512),
    summary: sanitizeCredentialLikeValue(item.summary).toString().slice(0, 1_000),
    ...(item.sourceRef ? { sourceRef: sanitizeCredentialLikeValue(item.sourceRef).toString().slice(0, 512) } : {}),
    createdAt: item.createdAt
  })) : undefined;
  if (containsCredentialLikeData(receipt.receiptRef)) {
    throw new Error("Material action receiptRef contains credential-like data.");
  }
  if (receipt.externalId && containsCredentialLikeData(receipt.externalId)) {
    throw new Error("Material action externalId contains credential-like data.");
  }
  let externalUri = receipt.externalUri;
  if (externalUri) {
    const url = new URL(externalUri);
    url.search = "";
    url.hash = "";
    externalUri = url.toString();
    if (containsCredentialLikeData(externalUri)) {
      throw new Error("Material action externalUri contains credential-like data.");
    }
  }
  const metadata = receipt.metadata
    ? Object.fromEntries(Object.entries(receipt.metadata).filter(([key, value]) =>
        SAFE_RECEIPT_METADATA_KEYS.has(key) &&
        !isCredentialFieldName(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
        !containsCredentialLikeData(`${key}:${String(value)}`)
      ))
    : undefined;
  return MaterialActionReceiptSchema.parse({
    id: receipt.id,
    actionId: receipt.actionId,
    provider: receipt.provider,
    ...(receipt.connectionId ? { connectionId: receipt.connectionId } : {}),
    ...(receipt.targetFingerprint ? { targetFingerprint: receipt.targetFingerprint } : {}),
    receiptRef: receipt.receiptRef.slice(0, 512),
    outcome: receipt.outcome,
    ...(receipt.externalId ? { externalId: receipt.externalId.slice(0, 256) } : {}),
    ...(externalUri ? { externalUri } : {}),
    observedAt: receipt.observedAt,
    ...(evidence?.length ? { evidence } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {})
  });
}

type AttemptLease = {
  runId: string;
  runnerId: string;
  attemptId: string;
  fencingToken: string;
};

class StaleActionTransitionError extends Error {}

function runFromRow(row: typeof runs.$inferSelect): OpenTagRun {
  const event = OpenTagEventSchema.parse(JSON.parse(row.eventJson));
  const result = row.resultJson ? OpenTagRunResultSchema.parse(JSON.parse(row.resultJson)) : undefined;
  const triggeredByAction = row.triggeredByActionJson ? ActionHintSchema.parse(JSON.parse(row.triggeredByActionJson)) : undefined;
  const protocolFields = protocolRunFieldsFromEvent(event, row.createdAt);
  const durableThread = protocolFields.thread && row.workThreadId
    ? { ...protocolFields.thread, id: row.workThreadId }
    : protocolFields.thread;
  const contextPacket = row.contextPacketJson
    ? ContextPacketSchema.parse(JSON.parse(row.contextPacketJson))
    : protocolFields.contextPacket;
  const accessProfileSnapshot = row.accessProfileSnapshotJson
    ? AgentAccessProfileSnapshotSchema.parse(JSON.parse(row.accessProfileSnapshotJson))
    : undefined;
  const policySnapshotProvenance = row.policySnapshotProvenanceJson
    ? PolicySnapshotProvenanceSchema.parse(JSON.parse(row.policySnapshotProvenanceJson))
    : undefined;
  return {
    id: row.id,
    eventId: row.eventId,
    status: row.status as OpenTagRun["status"],
    ...(durableThread ? { thread: durableThread } : {}),
    contextPacket,
    ...(accessProfileSnapshot ? { accessProfileSnapshot } : {}),
    ...(policySnapshotProvenance ? { policySnapshotProvenance } : {}),
    ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
    ...(triggeredByAction ? { triggeredByAction } : {}),
    ...(row.sourceProposalId ? { sourceProposalId: row.sourceProposalId } : {}),
    ...(row.sourceApplyPlanId ? { sourceApplyPlanId: row.sourceApplyPlanId } : {}),
    assignedRunnerId: row.assignedRunnerId ?? undefined,
    executor: row.executor ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(result ? { result } : {})
  };
}

function terminalRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted" || status === "timed_out";
}

function releasedTerminalAttemptMatchesRun(
  attempt: Pick<typeof attempts.$inferSelect, "status">,
  run: Pick<typeof runs.$inferSelect, "status" | "currentAttemptId" | "assignedRunnerId">
): boolean {
  if (run.currentAttemptId !== null || run.assignedRunnerId !== null) return false;
  if (attempt.status === "needs_human") return run.status === "needs_approval";
  return terminalRunStatus(attempt.status) && attempt.status === run.status;
}

function ledgerCategoryForEventType(type: string): AgentWorkLedgerCategory {
  if (type.startsWith("admission.")) return "admission";
  if (type.startsWith("context_packet.")) return "context_packet";
  if (type.startsWith("executor.capability.")) return "executor_capability";
  if (type === "callback.progress.suppressed") return "progress_visibility";
  if (type.startsWith("callback.")) return "callback_delivery";
  if (type.startsWith("source_receipt.")) return "callback_delivery";
  if (type.startsWith("approval.")) return "approval_decision";
  if (type.startsWith("apply_plan.")) return "apply_plan";
  if (type.startsWith("artifact.")) return "artifact";
  if (type.startsWith("proposal.snapshot.")) return "artifact";
  if (type === "run.completed") return "final_outcome";
  if (type === "run.cancelled" || type.includes(".cancel")) return "cancellation";
  if (type.includes("timeout") || type === "run.timed_out") return "timeout";
  if (type === "run.progress") return "progress_visibility";
  if (type.startsWith("run.")) return "lifecycle";
  if (type.startsWith("security.") || type.endsWith(".failed")) return "error";
  return "audit";
}

function sourceContainerMetadataMatches(input: {
  event: OpenTagEvent;
  source: string;
  metadata: Record<string, string>;
}): boolean {
  if (input.event.source !== input.source) return false;
  return Object.entries(input.metadata).every(([key, value]) => input.event.metadata[key] === value);
}

type CallbackDeliveryMetadata = {
  agentId?: string;
  statusMessageKey?: string;
  externalMessageId?: string;
  blocks?: unknown[];
  rich?: unknown;
};

function callbackDeliveryMetadataFromJson(metadataJson: string | null): CallbackDeliveryMetadata | undefined {
  return metadataJson && typeof metadataJson === "string" ? (JSON.parse(metadataJson) as CallbackDeliveryMetadata) : undefined;
}

function callbackDeliveryFromRow(row: typeof callbackDeliveries.$inferSelect): CallbackDelivery {
  const metadata = callbackDeliveryMetadataFromJson(row.metadataJson);
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as CallbackDeliveryKind,
    provider: row.provider as CallbackDeliveryProvider,
    uri: row.uri,
    body: row.body,
    ...(row.threadKey ? { threadKey: row.threadKey } : {}),
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    ...(metadata?.agentId ? { agentId: metadata.agentId } : {}),
    ...(metadata?.statusMessageKey ? { statusMessageKey: metadata.statusMessageKey } : {}),
    ...(metadata?.externalMessageId ? { externalMessageId: metadata.externalMessageId } : {}),
    ...(metadata?.blocks ? { blocks: metadata.blocks } : {}),
    ...(metadata && "rich" in metadata ? { rich: metadata.rich } : {}),
    status: row.status as CallbackDeliveryStatus,
    attempts: row.attempts,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function callbackBodyHash(input: { body: string; blocks?: unknown[]; rich?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify({ body: input.body, blocks: input.blocks ?? [], rich: input.rich ?? null }))
    .digest("hex");
}

function callbackIdempotencyKey(input: {
  runId: string;
  kind: CallbackDeliveryKind;
  provider: CallbackDeliveryProvider;
  uri: string;
  body: string;
  threadKey?: string;
  statusMessageKey?: string;
  blocks?: unknown[];
  rich?: unknown;
  idempotencyKey?: string;
}): string {
  if (input.idempotencyKey) {
    return `explicit:${createHash("sha256").update("opentag.callback-idempotency.v1\0").update(input.idempotencyKey).digest("hex")}`;
  }
  return [
    input.runId,
    input.provider,
    input.threadKey ?? input.uri,
    input.kind,
    input.statusMessageKey ?? "",
    callbackBodyHash({ body: input.body, ...(input.blocks ? { blocks: input.blocks } : {}), ...(input.rich !== undefined ? { rich: input.rich } : {}) })
  ].join("|");
}

function followUpRequestFromRow(row: typeof followUpRequests.$inferSelect): FollowUpRequest {
  return FollowUpRequestSchema.parse({
    id: row.id,
    sourceEventId: row.sourceEventId,
    conversationKey: row.conversationKey,
    ...(row.activeRunId ? { activeRunId: row.activeRunId } : {}),
    event: OpenTagEventSchema.parse(JSON.parse(row.eventJson)),
    decision: RunAdmissionDecisionSchema.parse(JSON.parse(row.decisionJson)),
    ...(row.accessProfileSnapshotJson
      ? { accessProfileSnapshot: AgentAccessProfileSnapshotSchema.parse(JSON.parse(row.accessProfileSnapshotJson)) }
      : {}),
    ...(row.policySnapshotProvenanceJson
      ? { policySnapshotProvenance: PolicySnapshotProvenanceSchema.parse(JSON.parse(row.policySnapshotProvenanceJson)) }
      : {}),
    status: row.status as FollowUpRequest["status"],
    ...(row.createdRunId ? { createdRunId: row.createdRunId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }) as FollowUpRequest;
}

function runnerFromRow(row: typeof runners.$inferSelect): RunnerRegistration {
  return {
    runnerId: row.runnerId,
    name: row.name,
    createdAt: row.createdAt,
    ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {})
  };
}

function recordFromJson(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function metadataString(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function metadataBoolean(metadata: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function signatureStateFromEvent(event: OpenTagEvent): RunSignatureState {
  const explicitState = metadataString(event.metadata, ["signatureState", "webhookSignatureState"]);
  if (explicitState === "verified" || explicitState === "unverified" || explicitState === "unknown") return explicitState;

  const verified = metadataBoolean(event.metadata, [
    "signatureVerified",
    "verifiedSignature",
    "webhookSignatureVerified",
    "githubSignatureVerified"
  ]);
  if (verified === true) return "verified";
  if (verified === false) return "unverified";
  return "unknown";
}

function sourceDeliveryIdFromEvent(event: OpenTagEvent): string | null {
  return metadataString(event.metadata, [
    "sourceDeliveryId",
    "webhookDeliveryId",
    "deliveryId",
    "githubDeliveryId",
    "githubDeliveryGuid",
    "slackEventId",
    "larkEventId"
  ]);
}

function projectTargetProvenance(ref: ProjectTargetRef | null): RunProvenance["projectTarget"] {
  if (!ref) return null;
  return {
    ref: formatProjectTargetRef(ref),
    ...ref
  };
}

function runProvenance(input: {
  event: OpenTagEvent;
  projectTarget: ProjectTargetRef | null;
  admissionDecision: RunAdmissionDecision;
  expectedRunnerId: string | null;
}): RunProvenance {
  return {
    source: input.event.source,
    sourceEventId: input.event.sourceEventId,
    sourceDeliveryId: sourceDeliveryIdFromEvent(input.event),
    signatureState: signatureStateFromEvent(input.event),
    projectTarget: projectTargetProvenance(input.projectTarget),
    admissionDecision: {
      action: input.admissionDecision.action,
      reasonCode: input.admissionDecision.reasonCode,
      ...(input.admissionDecision.eventId ? { eventId: input.admissionDecision.eventId } : {}),
      ...(input.admissionDecision.activeRunId ? { activeRunId: input.admissionDecision.activeRunId } : {})
    },
    expectedRunnerId: input.expectedRunnerId
  };
}

const CHANNEL_BINDING_RECORD_VERSION = 2;
const CHANNEL_BINDING_RECORD_RESERVED_FIELDS = new Set([
  "__opentagChannelBindingRecord",
  "management",
  "ownership",
  "metadata"
]);

function channelBindingRecordFromJson(value: string | null): {
  metadata?: Record<string, unknown>;
  ownership?: OpenTagManagedChannelBindingOwnership;
} {
  if (value === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ChannelBindingCorruptionError("Stored channel binding record is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChannelBindingCorruptionError("Stored channel binding record is not an object.");
  }
  const stored = parsed as Record<string, unknown>;
  const storedVersion = stored["__opentagChannelBindingRecord"];
  if (storedVersion === undefined) {
    if (Object.keys(stored).some((field) => CHANNEL_BINDING_RECORD_RESERVED_FIELDS.has(field))) {
      throw new ChannelBindingCorruptionError("Stored channel binding record uses reserved fields without a version discriminator.");
    }
    return { metadata: stored };
  }
  if (storedVersion !== CHANNEL_BINDING_RECORD_VERSION) {
    throw new ChannelBindingCorruptionError("Stored channel binding record has an unsupported version.");
  }
  const metadata = stored["metadata"];
  const management = stored["management"];
  if (management !== "managed" && management !== "unmanaged") {
    throw new ChannelBindingCorruptionError("Stored channel binding record has no valid management state.");
  }
  const ownership = OpenTagManagedChannelBindingOwnershipSchema.safeParse(stored["ownership"]);
  if (management === "managed" && !ownership.success) {
    throw new ChannelBindingCorruptionError("Stored managed channel binding has invalid ownership.");
  }
  if (management === "unmanaged" && stored["ownership"] !== undefined) {
    throw new ChannelBindingCorruptionError("Stored unmanaged channel binding unexpectedly contains ownership.");
  }
  if (
    Object.prototype.hasOwnProperty.call(stored, "metadata") &&
    (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    throw new ChannelBindingCorruptionError("Stored channel binding record has invalid metadata.");
  }
  return {
    ...(metadata ? { metadata: metadata as Record<string, unknown> } : {}),
    ...(management === "managed" && ownership.success ? { ownership: ownership.data } : {})
  };
}

function channelBindingRecordJson(input: ChannelBinding): string | null {
  return JSON.stringify({
    __opentagChannelBindingRecord: CHANNEL_BINDING_RECORD_VERSION,
    management: input.ownership ? "managed" : "unmanaged",
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.ownership ? { ownership: OpenTagManagedChannelBindingOwnershipSchema.parse(input.ownership) } : {})
  });
}

function channelBindingFromRow(row: typeof channelBindings.$inferSelect): ChannelBinding {
  const record = channelBindingRecordFromJson(row.metadataJson);
  const repositoryValues = [row.repoProvider, row.owner, row.repo];
  const repositoryFieldCount = repositoryValues.filter((value) => value !== null).length;
  if (repositoryFieldCount !== 0 && repositoryFieldCount !== 3) {
    throw new Error("Stored channel binding has partial repository fields.");
  }
  return {
    provider: row.provider,
    accountId: row.accountId,
    conversationId: row.conversationId,
    ...(row.repoProvider && row.owner && row.repo
      ? { repoProvider: row.repoProvider, owner: row.owner, repo: row.repo }
      : {}),
    ...(record.metadata ? { metadata: record.metadata } : {}),
    ...(record.ownership ? { ownership: record.ownership } : {})
  };
}

function channelBindingRepositoryFields(input: ChannelBinding):
  | { repoProvider: string; owner: string; repo: string }
  | { repoProvider: null; owner: null; repo: null } {
  const values = [input.repoProvider, input.owner, input.repo];
  const present = values.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== 3) {
    throw new Error("Channel binding repository fields repoProvider, owner, and repo must be provided together.");
  }
  return input.repoProvider && input.owner && input.repo
    ? { repoProvider: input.repoProvider, owner: input.owner, repo: input.repo }
    : { repoProvider: null, owner: null, repo: null };
}

function channelBindingsMatch(left: ChannelBinding, right: ChannelBinding): boolean {
  return left.provider === right.provider
    && left.accountId === right.accountId
    && left.conversationId === right.conversationId
    && left.repoProvider === right.repoProvider
    && left.owner === right.owner
    && left.repo === right.repo
    && JSON.stringify(left.metadata ?? null) === JSON.stringify(right.metadata ?? null)
    && left.ownership?.mode === right.ownership?.mode
    && left.ownership?.exclusive === right.ownership?.exclusive
    && left.ownership?.applicationId === right.ownership?.applicationId
    && left.ownership?.botId === right.ownership?.botId;
}

function stringArrayFromJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
}

function parseLinearRelayInstallationAuth(value: string | null): LinearRelayInstallationAuth | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.method === "api_key") return { method: "api_key" };
  if (record.method !== "oauth_app" || record.actor !== "app") return undefined;
  const scopes = Array.isArray(record.scopes) ? record.scopes.filter((item): item is string => typeof item === "string" && item.length > 0) : undefined;
  return {
    method: "oauth_app",
    actor: "app",
    ...(typeof record.clientId === "string" && record.clientId.length > 0 ? { clientId: record.clientId } : {}),
    ...(typeof record.refreshToken === "string" && record.refreshToken.length > 0 ? { refreshToken: record.refreshToken } : {}),
    ...(typeof record.accessTokenExpiresAt === "string" && record.accessTokenExpiresAt.length > 0
      ? { accessTokenExpiresAt: record.accessTokenExpiresAt }
      : {}),
    ...(typeof record.appUserId === "string" && record.appUserId.length > 0 ? { appUserId: record.appUserId } : {}),
    ...(scopes?.length ? { scopes } : {})
  };
}

function linearRelayInstallationFromRow(row: typeof linearRelayInstallations.$inferSelect): LinearRelayInstallation {
  const auth = parseLinearRelayInstallationAuth(row.authJson);
  return {
    id: row.id,
    webhookPath: row.webhookPath,
    webhookSecret: row.webhookSecret,
    token: row.token,
    ...(auth ? { auth } : {}),
    ...(row.graphqlUrl ? { graphqlUrl: row.graphqlUrl } : {}),
    repoProvider: row.repoProvider,
    owner: row.owner,
    repo: row.repo,
    ...(row.organizationId ? { organizationId: row.organizationId } : {}),
    ...(row.teamId ? { teamId: row.teamId } : {}),
    ...(row.teamKey ? { teamKey: row.teamKey } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function linearOAuthInstallStateFromRow(row: typeof linearOAuthInstallStates.$inferSelect): LinearOAuthInstallState {
  return {
    state: row.state,
    installationId: row.installationId,
    webhookPath: row.webhookPath,
    webhookSecret: row.webhookSecret,
    redirectUri: row.redirectUri,
    ...(row.graphqlUrl ? { graphqlUrl: row.graphqlUrl } : {}),
    repoProvider: row.repoProvider,
    owner: row.owner,
    repo: row.repo,
    ...(row.teamId ? { teamId: row.teamId } : {}),
    ...(row.teamKey ? { teamKey: row.teamKey } : {}),
    scopes: stringArrayFromJson(row.scopesJson),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {})
  };
}

function syntheticManualApprovalPolicyRules(decision: ApprovalDecision): PolicyRule[] {
  return [
    {
      id: `manual_approval_${decision.id}`,
      scope: "primary_anchor_override",
      effect: "allow",
      reason: "Manual approval decision authorized selected proposal intents."
    }
  ];
}

function executorConditionsFromIntent(intent: { params?: Record<string, unknown> | undefined }): string[] {
  const value = intent.params?.["executorConditions"];
  if (!Array.isArray(value)) return [];
  return value.filter((condition): condition is string => typeof condition === "string" && condition.length > 0);
}

function lineageScopeKey(input: { runId: string; snapshot: SuggestedChangesSnapshot }): string {
  return input.snapshot.workThread?.id ?? `run:${input.runId}`;
}

function computeProposalLineage(snapshots: StoredSuggestedChangesSnapshot[], targetScopeKey: string): ProposalLineage {
  const scoped = snapshots
    .filter((snapshot) => lineageScopeKey(snapshot) === targetScopeKey)
    .sort((left, right) => {
      const timeDelta = new Date(left.snapshot.createdAt).getTime() - new Date(right.snapshot.createdAt).getTime();
      if (timeDelta !== 0) return timeDelta;
      return left.snapshot.proposalId.localeCompare(right.snapshot.proposalId);
    });

  const latestProposalByDomain = new Map<string, string>();
  const explicitSupersession = new Map<string, { proposalId: string; intentId: string }>();
  for (const stored of scoped) {
    const domainsInProposal = new Set<string>();
    for (const intent of stored.snapshot.intents) {
      domainsInProposal.add(intent.domain);
      for (const supersededIntentId of intent.supersedesIntentIds ?? []) {
        explicitSupersession.set(supersededIntentId, { proposalId: stored.snapshot.proposalId, intentId: intent.intentId });
      }
    }
    for (const domain of domainsInProposal) {
      latestProposalByDomain.set(domain, stored.snapshot.proposalId);
    }
  }

  const entries: MutationIntentActionability[] = [];
  for (const stored of scoped) {
    for (const intent of stored.snapshot.intents) {
      const explicit = explicitSupersession.get(intent.intentId);
      const latestProposalId = latestProposalByDomain.get(intent.domain);
      if (explicit) {
        entries.push({
          proposalId: stored.snapshot.proposalId,
          intentId: intent.intentId,
          domain: intent.domain,
          status: "superseded",
          supersededByProposalId: explicit.proposalId,
          supersededByIntentId: explicit.intentId,
          reason: "A later intent explicitly superseded this intent."
        });
      } else if (latestProposalId && latestProposalId !== stored.snapshot.proposalId) {
        const supersedingIntent = scoped
          .find((candidate) => candidate.snapshot.proposalId === latestProposalId)
          ?.snapshot.intents.find((candidateIntent) => candidateIntent.domain === intent.domain);
        entries.push({
          proposalId: stored.snapshot.proposalId,
          intentId: intent.intentId,
          domain: intent.domain,
          status: "superseded",
          supersededByProposalId: latestProposalId,
          ...(supersedingIntent ? { supersededByIntentId: supersedingIntent.intentId } : {}),
          reason: `A newer proposal superseded the ${intent.domain} domain.`
        });
      } else {
        entries.push({
          proposalId: stored.snapshot.proposalId,
          intentId: intent.intentId,
          domain: intent.domain,
          status: "current"
        });
      }
    }
  }

  return ProposalLineageSchema.parse({ scopeKey: targetScopeKey, entries });
}

function emptyApplyOutcomeCounts(): ApplyOutcomeCounts {
  return {
    applied: 0,
    skipped: 0,
    failed: 0,
    stale: 0,
    unsupported: 0
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function payloadString(payload: unknown, path: string[]): string | null {
  let current = payload;
  for (const segment of path) {
    const record = recordFromUnknown(current);
    if (!record) return null;
    current = record[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

function controlPlaneAlertSubject(event: ControlPlaneEvent): string {
  if (event.type === "run.claimed") {
    return payloadString(event.payload, ["runnerId"]) ?? event.subject ?? "unknown-runner";
  }
  if (event.type === "security.auth_failed") {
    return payloadString(event.payload, ["tokenFingerprint"]) ?? event.subject ?? "unknown-token";
  }
  if (event.type === "security.token_misuse") {
    const provider = payloadString(event.payload, ["provider"]);
    const tokenKind = payloadString(event.payload, ["tokenKind"]);
    if (provider && tokenKind) return `${provider}:${tokenKind}`;
    return event.subject ?? "unknown-token";
  }
  if (event.type === "security.signature_failed") {
    const provider = payloadString(event.payload, ["provider"]);
    const endpoint = payloadString(event.payload, ["endpoint"]);
    if (provider && endpoint) return `${provider}:${endpoint}`;
    return event.subject ?? "unknown-signature-source";
  }
  if (event.type === "security.request_body_rejected") {
    return payloadString(event.payload, ["endpoint"]) ?? event.subject ?? "unknown-endpoint";
  }
  if (event.type === "admission.needs_human_decision") {
    const reasonCode = payloadString(event.payload, ["decision", "reasonCode"]) ?? payloadString(event.payload, ["reasonCode"]);
    if (reasonCode === "repo_not_bound" || reasonCode === "repo_context_missing") {
      return payloadString(event.payload, ["projectTarget"]) ?? reasonCode;
    }
  }
  return event.subject ?? event.type;
}

function controlPlaneAlertKind(event: ControlPlaneEvent): ControlPlaneAlert["type"] | null {
  if (event.type === "run.claimed") return "abnormal_runner_claim_rate";
  if (event.type === "security.auth_failed") return "repeated_auth_failures";
  if (event.type === "security.token_misuse") return "token_misuse";
  if (event.type === "security.signature_failed") return "repeated_signature_failures";
  if (event.type === "security.request_body_rejected") {
    return payloadString(event.payload, ["reason"]) === "request_body_too_large"
      ? "repeated_large_payload_rejections"
      : "repeated_invalid_request_body";
  }
  if (event.type === "admission.needs_human_decision") {
    const reasonCode = payloadString(event.payload, ["decision", "reasonCode"]) ?? payloadString(event.payload, ["reasonCode"]);
    if (reasonCode === "repo_not_bound" || reasonCode === "repo_context_missing") return "repeated_unknown_project_targets";
  }
  return null;
}

function controlPlaneAlertMetadata(kind: ControlPlaneAlert["type"]): Pick<ControlPlaneAlert, "reason" | "nextAction" | "severity"> {
  if (kind === "repeated_auth_failures") {
    return {
      severity: "warn",
      reason: "Repeated dispatcher authorization failures were observed.",
      nextAction: "Check for token misuse, stale runner configuration, or a leaked/rotated pairing token."
    };
  }
  if (kind === "token_misuse") {
    return {
      severity: "warn",
      reason: "A platform or relay token failed with a terminal authentication or configuration error.",
      nextAction: "Rotate or replace the affected token, then restart or re-pair the ingress or runner that owns it."
    };
  }
  if (kind === "repeated_large_payload_rejections") {
    return {
      severity: "warn",
      reason: "Repeated oversized dispatcher request bodies were rejected.",
      nextAction: "Check source ingress payload size, request body limits, and whether a client is retrying an invalid payload."
    };
  }
  if (kind === "repeated_invalid_request_body") {
    return {
      severity: "warn",
      reason: "Repeated malformed or schema-invalid request bodies were rejected.",
      nextAction: "Check source webhook payload shape, client versions, and whether unsigned or incompatible traffic is hitting the endpoint."
    };
  }
  if (kind === "repeated_signature_failures") {
    return {
      severity: "warn",
      reason: "Repeated source webhook signature verification failures were observed.",
      nextAction: "Check the source webhook secret, signing configuration, endpoint URL, and whether unsigned traffic is hitting the ingress."
    };
  }
  if (kind === "abnormal_runner_claim_rate") {
    return {
      severity: "warn",
      reason: "Runner claim volume exceeded the local alert threshold.",
      nextAction: "Check for runaway runner loops, token misuse, or an unexpected burst of queued runs for this runner."
    };
  }
  return {
    severity: "warn",
    reason: "Repeated source events resolved to missing or unbound Project Targets.",
    nextAction: "Verify source metadata, Project Target bindings, and runner allowlists before retrying."
  };
}

function controlPlaneAlertThreshold(kind: ControlPlaneAlert["type"], thresholds?: Partial<Record<ControlPlaneAlert["type"], number>>): number {
  return (
    thresholds?.[kind] ??
    (kind === "token_misuse"
      ? 1
      : kind === "repeated_auth_failures" || kind === "repeated_signature_failures"
        ? 3
        : kind === "abnormal_runner_claim_rate"
          ? 10
          : 2)
  );
}

function metricsFromEvents(runId: string, events: OpenTagAuditEvent[]): OpenTagRunMetrics {
  const latestApplyPlans = new Map<string, ApplyPlan>();
  for (const event of events) {
    if (event.type !== "apply_plan.created" && event.type !== "apply_plan.executed") continue;
    const parsed = ApplyPlanSchema.safeParse(event.payload);
    if (parsed.success) {
      latestApplyPlans.set(parsed.data.id, parsed.data);
    }
  }

  const applyOutcomeCounts = emptyApplyOutcomeCounts();
  for (const plan of latestApplyPlans.values()) {
    for (const outcome of plan.outcomes ?? []) {
      applyOutcomeCounts[outcome.outcome] += 1;
    }
  }

  const humanCallbackCount = events.filter((event) => event.visibility === "human" && event.type.startsWith("callback.")).length;
  const auditEventCount = events.filter((event) => event.visibility === "audit").length;
  return {
    runId,
    totalEventCount: events.length,
    humanEventCount: events.filter((event) => event.visibility === "human").length,
    auditEventCount,
    debugEventCount: events.filter((event) => event.visibility === "debug").length,
    humanCallbackCount,
    threadNoiseRatio: auditEventCount === 0 ? humanCallbackCount : humanCallbackCount / auditEventCount,
    suggestedChangesCount: events
      .filter((event) => event.type === "proposal.snapshot.created")
      .reduce((count, event) => {
        const payload = recordFromUnknown(event.payload);
        const intents = payload?.["intents"];
        return count + (Array.isArray(intents) ? intents.length : 1);
      }, 0),
    approvalDecisionCount: events.filter((event) => event.type === "approval.decision.recorded").length,
    applyPlanCount: latestApplyPlans.size,
    childRunCount: events.filter((event) => event.type === "run.child_created").length,
    applyOutcomeCounts,
    staleIntentCount: applyOutcomeCounts.stale
  };
}

function aggregateMetrics(input: {
  scope: OpenTagAggregateMetrics["scope"];
  scopeId: string;
  runs: OpenTagRunMetrics[];
}): OpenTagAggregateMetrics {
  const applyOutcomeCounts = emptyApplyOutcomeCounts();
  for (const run of input.runs) {
    applyOutcomeCounts.applied += run.applyOutcomeCounts.applied;
    applyOutcomeCounts.skipped += run.applyOutcomeCounts.skipped;
    applyOutcomeCounts.failed += run.applyOutcomeCounts.failed;
    applyOutcomeCounts.stale += run.applyOutcomeCounts.stale;
    applyOutcomeCounts.unsupported += run.applyOutcomeCounts.unsupported;
  }
  const auditEventCount = input.runs.reduce((sum, run) => sum + run.auditEventCount, 0);
  const humanCallbackCount = input.runs.reduce((sum, run) => sum + run.humanCallbackCount, 0);
  return {
    scope: input.scope,
    scopeId: input.scopeId,
    runCount: input.runs.length,
    totalEventCount: input.runs.reduce((sum, run) => sum + run.totalEventCount, 0),
    humanEventCount: input.runs.reduce((sum, run) => sum + run.humanEventCount, 0),
    auditEventCount,
    debugEventCount: input.runs.reduce((sum, run) => sum + run.debugEventCount, 0),
    humanCallbackCount,
    threadNoiseRatio: auditEventCount === 0 ? humanCallbackCount : humanCallbackCount / auditEventCount,
    suggestedChangesCount: input.runs.reduce((sum, run) => sum + run.suggestedChangesCount, 0),
    approvalDecisionCount: input.runs.reduce((sum, run) => sum + run.approvalDecisionCount, 0),
    applyPlanCount: input.runs.reduce((sum, run) => sum + run.applyPlanCount, 0),
    childRunCount: input.runs.reduce((sum, run) => sum + run.childRunCount, 0),
    applyOutcomeCounts,
    staleIntentCount: input.runs.reduce((sum, run) => sum + run.staleIntentCount, 0)
  };
}

export function createOpenTagRepository(db: BetterSQLite3Database) {
  function activeAttemptLease(input: AttemptLease):
    | { outcome: "active"; run: typeof runs.$inferSelect; attempt: typeof attempts.$inferSelect }
    | { outcome: "stale_attempt" | "not_found" } {
    const run = db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
    if (!run) return { outcome: "not_found" };
    if (run.currentAttemptId !== input.attemptId || run.assignedRunnerId !== input.runnerId) {
      return { outcome: "stale_attempt" };
    }
    const attempt = db.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
    if (
      !attempt ||
      attempt.runId !== input.runId ||
      attempt.runnerId !== input.runnerId ||
      attempt.fencingToken !== input.fencingToken ||
      (attempt.status !== "assigned" && attempt.status !== "running") ||
      !hasActiveAttemptLease(attempt)
    ) {
      return { outcome: "stale_attempt" };
    }
    return { outcome: "active", run, attempt };
  }

  async function repoBindingRunnerId(projectTarget: ProjectTargetRef | null): Promise<string | null> {
    if (!projectTarget) return null;
    const row = await db
      .select()
      .from(repoBindings)
      .where(
        and(
          eq(repoBindings.provider, projectTarget.provider),
          eq(repoBindings.owner, projectTarget.owner),
          eq(repoBindings.repo, projectTarget.repo)
        )
      )
      .limit(1)
      .get();
    return row?.runnerId ?? null;
  }

  function runEventValues(input: {
    runId: string;
    type: string;
    payload: unknown;
    createdAt?: string;
    visibility?: RunEventVisibility;
    importance?: RunEventImportance;
    message?: string;
  }): typeof runEvents.$inferInsert {
    return {
      runId: input.runId,
      type: input.type,
      visibility: input.visibility ?? defaultRunEventMetadata(input.type).visibility,
      importance: input.importance ?? defaultRunEventMetadata(input.type).importance,
      message: input.message ?? null,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.createdAt ?? nowIso()
    };
  }

  function runEventFromRow(row: typeof runEvents.$inferSelect): OpenTagAuditEvent {
    return {
      id: row.id,
      runId: row.runId,
      type: row.type,
      visibility: RunEventVisibilitySchema.parse(row.visibility),
      importance: RunEventImportanceSchema.parse(row.importance),
      ...(row.message ? { message: row.message } : {}),
      payload: JSON.parse(row.payloadJson) as unknown,
      createdAt: row.createdAt
    };
  }

  function sanitizeRunEventValue<T>(value: T, secrets: readonly string[]): T {
    function sanitize(child: unknown): unknown {
      if (typeof child === "string") {
        const withoutRuntimeSecrets = secrets.reduce(
          (safe, secret) => safe.split(secret).join("[redacted]"),
          child
        );
        return redactCredentialLikeData(withoutRuntimeSecrets);
      }
      if (Array.isArray(child)) return child.map((entry) => sanitize(entry));
      if (child && typeof child === "object") {
        return Object.fromEntries(
          Object.entries(child as Record<string, unknown>).map(([key, entry]) => [key, sanitize(entry)])
        );
      }
      return child;
    }
    return sanitize(value) as T;
  }

  async function attemptFencingTokensForRun(runId: string): Promise<string[]> {
    const knownAttempts = await db
      .select({ fencingToken: attempts.fencingToken })
      .from(attempts)
      .where(eq(attempts.runId, runId));
    return knownAttempts.map((attempt) => attempt.fencingToken);
  }

  async function sanitizeRunnerControlledInputForRun<T>(runId: string, input: T): Promise<T> {
    return sanitizeCredentialLikeValue(input, {
      secrets: await attemptFencingTokensForRun(runId)
    });
  }

  async function latestMaterialActionForSemanticKey(input: {
    runId: string;
    idempotencyKey: string;
  }): Promise<typeof materialActions.$inferSelect | undefined> {
    const row = await db
      .select({ action: materialActions })
      .from(materialActions)
      .leftJoin(
        attempts,
        and(eq(materialActions.attemptId, attempts.id), eq(materialActions.runId, attempts.runId))
      )
      .where(and(eq(materialActions.runId, input.runId), eq(materialActions.idempotencyKey, input.idempotencyKey)))
      .orderBy(
        desc(attempts.number),
        desc(materialActions.createdAt),
        desc(sql<number>`"material_actions"._rowid_`)
      )
      .limit(1)
      .get();
    return row?.action;
  }

  async function appendRunEvent(input: Parameters<typeof runEventValues>[0]): Promise<void> {
    const safeInput = sanitizeRunEventValue(input, await attemptFencingTokensForRun(input.runId));
    await db.insert(runEvents).values(runEventValues(safeInput));
  }

  async function recordCreateRunReplay(input: {
    runRow: typeof runs.$inferSelect;
    requestedRunId: string;
    event: OpenTagEvent;
    projectTarget: ProjectTargetRef | null;
    expectedRunnerId: string | null;
    replayKind: "source_event" | "source_delivery";
    sourceDeliveryId?: string | null;
    createdAt: string;
  }): Promise<Extract<CreateRunResult, { created: false }>> {
    const reason =
      input.replayKind === "source_delivery"
        ? "Source delivery already created a run."
        : "Source event already created a run.";
    const reasonCode = input.replayKind === "source_delivery" ? "duplicate_source_delivery" : "duplicate_source_event";
    const replayDecision = RunAdmissionDecisionSchema.parse({
      action: "drop_duplicate",
      reason,
      reasonCode,
      decidedAt: input.createdAt,
      activeRunId: input.runRow.id,
      eventId: input.event.id
    });
    await appendRunEvent({
      runId: input.runRow.id,
      type: "admission.decided",
      payload: replayDecision,
      visibility: "audit",
      importance: "normal",
      message: replayDecision.reason,
      createdAt: input.createdAt
    });
    await appendRunEvent({
      runId: input.runRow.id,
      type: "run.create_idempotent_replay",
      payload: {
        requestedRunId: input.requestedRunId,
        eventId: input.event.id,
        replayKey:
          input.replayKind === "source_delivery"
            ? { kind: "source_delivery", source: input.event.source, deliveryId: input.sourceDeliveryId }
            : { kind: "source_event", eventId: input.event.id },
        provenance: runProvenance({
          event: input.event,
          projectTarget: input.projectTarget,
          admissionDecision: replayDecision,
          expectedRunnerId: input.expectedRunnerId
        })
      },
      visibility: "audit",
      importance: "low",
      createdAt: input.createdAt
    });
    return {
      run: runFromRow(input.runRow),
      created: false,
      replayKind: input.replayKind,
      replayDecision
    };
  }

  type CreateApplyPlanInput = {
    id: string;
    proposalId: string;
    approvalDecisionId: string;
    selectedIntentIds?: string[];
    adapter?: string;
    policyRules?: PolicyRule[];
  };

  async function buildApplyPlan(input: CreateApplyPlanInput): Promise<{ plan: ApplyPlan; runId: string; createdAt: string } | null> {
    const storedProposalRow = await db
      .select()
      .from(suggestedChanges)
      .where(eq(suggestedChanges.proposalId, input.proposalId))
      .limit(1)
      .get();
    const decisionRow = await db
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.id, input.approvalDecisionId))
      .limit(1)
      .get();
    const decision = decisionRow ? ApprovalDecisionSchema.parse(JSON.parse(decisionRow.decisionJson)) : null;
    if (!storedProposalRow || !decision || decision.proposalId !== input.proposalId) return null;
    const storedProposal = {
      runId: storedProposalRow.runId,
      snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(storedProposalRow.snapshotJson))
    };

    const runRow = await db.select().from(runs).where(eq(runs.id, storedProposal.runId)).limit(1).get();
    if (!runRow) return null;
    const event = OpenTagEventSchema.parse(JSON.parse(runRow.eventJson));
    const repoKey = projectTargetRefFromEvent(event);
    const storedPolicyRuleRows = repoKey
      ? await db
          .select()
          .from(repoPolicyRules)
          .where(and(eq(repoPolicyRules.provider, repoKey.provider), eq(repoPolicyRules.owner, repoKey.owner), eq(repoPolicyRules.repo, repoKey.repo)))
          .orderBy(asc(repoPolicyRules.createdAt))
      : [];
    const storedPolicyRules = storedPolicyRuleRows.map((row) => PolicyRuleSchema.parse(JSON.parse(row.ruleJson)));
    const storedMappingRows = repoKey
      ? await db
          .select()
          .from(repoMutationMappings)
          .where(
            and(
              eq(repoMutationMappings.provider, repoKey.provider),
              eq(repoMutationMappings.owner, repoKey.owner),
              eq(repoMutationMappings.repo, repoKey.repo)
            )
          )
          .orderBy(asc(repoMutationMappings.createdAt))
      : [];
    const storedMappings = storedMappingRows.map((row) => AdapterMutationMappingSchema.parse(JSON.parse(row.mappingJson)));
    const selectedIntentIds = input.selectedIntentIds ?? decision.approvedIntentIds;
    const approvedIntentIds = new Set(decision.approvedIntentIds);
    const proposalIntents = new Map(storedProposal.snapshot.intents.map((intent) => [intent.intentId, intent]));
    const lineageRows = await db.select().from(suggestedChanges).orderBy(asc(suggestedChanges.createdAt));
    const lineage = computeProposalLineage(
      lineageRows.map((row) => ({
        runId: row.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
      })),
      lineageScopeKey(storedProposal)
    );
    const actionabilityByIntentId = new Map(lineage.entries.map((entry) => [entry.intentId, entry]));
    const policyRules = [...storedPolicyRules, ...(input.policyRules ?? []), ...syntheticManualApprovalPolicyRules(decision)];

    const outcomes = selectedIntentIds.map((intentId) => {
      if (!approvedIntentIds.has(intentId)) {
        return {
          intentId,
          outcome: "skipped" as const,
          message: "Intent was not approved by the approval decision."
        };
      }
      const intent = proposalIntents.get(intentId);
      if (!intent) {
        return {
          intentId,
          outcome: "failed" as const,
          message: "Intent does not exist on the referenced proposal."
        };
      }
      const actionability = actionabilityByIntentId.get(intentId);
      if (actionability?.status !== "current") {
        return {
          intentId,
          outcome: "stale" as const,
          message: actionability?.reason ?? "Intent is no longer current for its mutation domain."
        };
      }
      return preflightMutationIntent({
        intent,
        permissions: event.permissions,
        policyRules,
        executorConditions: executorConditionsFromIntent(intent),
        ...(input.adapter ? { adapter: input.adapter } : {})
      }).outcome;
    });

    return {
      runId: storedProposal.runId,
      createdAt: nowIso(),
      plan: ApplyPlanSchema.parse({
        id: input.id,
        proposalId: input.proposalId,
        approvalDecisionId: input.approvalDecisionId,
        selectedIntentIds,
        ...(input.adapter ? { adapter: input.adapter } : {}),
        adapterPlan: {
          semantics: "preflight first, then per-intent outcome",
          externalWritesExecuted: false,
          mappings: storedMappings
        },
        outcomes
      })
    };
  }

  function applyPlanCreatedEventRow(input: { runId: string; plan: ApplyPlan; createdAt: string }): typeof runEvents.$inferInsert {
    return {
      runId: input.runId,
      type: "apply_plan.created",
      visibility: "audit",
      importance: "high",
      message: `Created apply plan for ${input.plan.selectedIntentIds.length} intent(s).`,
      payloadJson: JSON.stringify(input.plan),
      createdAt: input.createdAt
    };
  }

  async function appendApplyPlanCreatedEvent(input: { runId: string; plan: ApplyPlan; createdAt: string }): Promise<void> {
    await db.insert(runEvents).values(applyPlanCreatedEventRow(input));
  }

  async function upsertWorkThreadRecord(input: {
    thread: WorkThread;
    scopeId?: string;
    recordedAt?: string;
  }): Promise<{ thread: DurableWorkThread; created: boolean }> {
    const parsed = WorkThreadSchema.parse(input.thread);
    const scopeId = input.scopeId ?? "local";
    const canonicalKey = workThreadCanonicalKey(parsed);
    const recordedAt = input.recordedAt ?? nowIso();
    return db.transaction((tx) => {
      const existing = tx
        .select()
        .from(workThreads)
        .where(and(eq(workThreads.scopeId, scopeId), eq(workThreads.canonicalKey, canonicalKey)))
        .limit(1)
        .get();
      if (existing) {
        const merged = mergeWorkThreadAnchors(workThreadFromRow(existing), parsed);
        const mergedJson = JSON.stringify(merged);
        if (mergedJson !== existing.threadJson) {
          tx.update(workThreads)
            .set({ threadJson: mergedJson, updatedAt: recordedAt })
            .where(eq(workThreads.id, existing.id))
            .run();
          tx.insert(governanceEvents).values({
            workThreadId: existing.id,
            type: "work_thread.updated",
            subjectId: existing.id,
            payloadJson: JSON.stringify({ anchorCount: 1 + (merged.secondaryAnchors?.length ?? 0) }),
            createdAt: recordedAt
          }).run();
        }
        return { thread: merged, created: false };
      }
      const id = parsed.id ?? `thread_${randomUUID()}`;
      const durable = WorkThreadSchema.parse({ ...parsed, id }) as DurableWorkThread;
      const conflictingId = tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, id)).limit(1).get();
      if (conflictingId) throw new Error(`WorkThread id ${id} already identifies another external work item.`);
      tx.insert(workThreads).values({
        id,
        scopeId,
        canonicalKey,
        provider: parsed.workItemReference.provider,
        ownerContainerId: parsed.workItemReference.ownerContainer?.id ?? "",
        workItemKind: parsed.workItemReference.kind,
        externalId: parsed.workItemReference.externalId,
        threadJson: JSON.stringify(durable),
        currentAssessmentId: null,
        createdAt: recordedAt,
        updatedAt: recordedAt
      }).run();
      tx.insert(governanceEvents).values({
        workThreadId: id,
        type: "work_thread.created",
        subjectId: id,
        payloadJson: JSON.stringify({ canonicalKey, scopeId }),
        createdAt: recordedAt
      }).run();
      return { thread: durable, created: true };
    });
  }

  return {
    appendRunEvent,

    upsertWorkThread: upsertWorkThreadRecord,

    async getWorkThread(input: { workThreadId: string }): Promise<DurableWorkThread | null> {
      const row = await db.select().from(workThreads).where(eq(workThreads.id, input.workThreadId)).limit(1).get();
      return row ? workThreadFromRow(row) : null;
    },

    async attachRunToWorkThread(input: { runId: string; workThreadId: string }): Promise<boolean> {
      return db.transaction((tx) => {
        const thread = tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, input.workThreadId)).limit(1).get();
        const run = tx.select({ id: runs.id }).from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        if (!thread || !run) return false;
        tx.update(runs).set({ workThreadId: input.workThreadId, updatedAt: nowIso() }).where(eq(runs.id, input.runId)).run();
        return true;
      });
    },

    async recordCompletionContract(input: {
      contract: CompletionContract;
    }): Promise<{ contract: CompletionContract; created: boolean }> {
      const contract = CompletionContractSchema.parse(input.contract);
      const contractJson = JSON.stringify(contract);
      const contentDigest = sha256Json(contract);
      return db.transaction((tx) => {
        const thread = tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, contract.workThreadId)).limit(1).get();
        if (!thread) throw new Error(`WorkThread ${contract.workThreadId} does not exist.`);
        const existing = tx
          .select()
          .from(completionContracts)
          .where(and(eq(completionContracts.id, contract.id), eq(completionContracts.version, contract.version)))
          .limit(1)
          .get();
        if (existing) {
          if (existing.contentDigest !== contentDigest || existing.contractJson !== contractJson) {
            throw new Error(`CompletionContract ${contract.id}@${contract.version} is immutable.`);
          }
          return { contract: completionContractFromRow(existing), created: false };
        }
        tx.insert(completionContracts).values({
          id: contract.id,
          version: contract.version,
          workThreadId: contract.workThreadId,
          cycle: contract.cycle,
          contractJson,
          contentDigest,
          createdAt: contract.createdAt
        }).run();
        tx.insert(governanceEvents).values({
          workThreadId: contract.workThreadId,
          type: "completion_contract.recorded",
          subjectId: `${contract.id}@${contract.version}`,
          payloadJson: JSON.stringify({ contractId: contract.id, version: contract.version, cycle: contract.cycle, contentDigest }),
          createdAt: contract.createdAt
        }).run();
        return { contract, created: true };
      });
    },

    async getCompletionContract(input: { contractId: string; version?: number }): Promise<CompletionContract | null> {
      const conditions = [eq(completionContracts.id, input.contractId)];
      if (input.version !== undefined) conditions.push(eq(completionContracts.version, input.version));
      const row = await db
        .select()
        .from(completionContracts)
        .where(and(...conditions))
        .orderBy(desc(completionContracts.version))
        .limit(1)
        .get();
      return row ? completionContractFromRow(row) : null;
    },

    async getLatestCompletionContractForWorkThread(input: { workThreadId: string }): Promise<CompletionContract | null> {
      const row = await db
        .select()
        .from(completionContracts)
        .where(eq(completionContracts.workThreadId, input.workThreadId))
        .orderBy(desc(completionContracts.cycle), desc(completionContracts.version), desc(completionContracts.createdAt))
        .limit(1)
        .get();
      return row ? completionContractFromRow(row) : null;
    },

    async recordVerificationEvidence(input: RecordVerificationEvidenceInput): Promise<{ evidence: StoredVerificationEvidence; created: boolean }> {
      const evidence = VerificationEvidenceSchema.parse(input.evidence);
      const receivedAt = input.receivedAt ?? nowIso();
      const observedAt = input.observedAt ?? evidence.createdAt;
      const payloadDigest = input.payloadDigest ?? sha256Json({
        provider: input.provider,
        deliveryId: input.deliveryId,
        subjectRef: input.subjectRef,
        subjectVersion: input.subjectVersion,
        evidence
      });
      return db.transaction((tx) => {
        if (input.workThreadId) {
          const thread = tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, input.workThreadId)).limit(1).get();
          if (!thread) throw new Error(`WorkThread ${input.workThreadId} does not exist.`);
        }
        const existing = tx
          .select()
          .from(verificationEvidenceRecords)
          .where(and(
            eq(verificationEvidenceRecords.provider, input.provider),
            eq(verificationEvidenceRecords.deliveryId, input.deliveryId),
            eq(verificationEvidenceRecords.subjectRef, input.subjectRef),
            eq(verificationEvidenceRecords.subjectVersion, input.subjectVersion),
            eq(verificationEvidenceRecords.kind, evidence.kind)
          ))
          .limit(1)
          .get();
        if (existing) {
          if (existing.payloadDigest !== payloadDigest || existing.evidenceJson !== JSON.stringify(evidence)) {
            throw new Error(`Evidence delivery ${input.provider}/${input.deliveryId} conflicts with its durable payload.`);
          }
          return { evidence: storedVerificationEvidenceFromRow(existing), created: false };
        }
        const id = input.id ?? evidence.id;
        const row = {
          id,
          workThreadId: input.workThreadId ?? null,
          provider: input.provider,
          deliveryId: input.deliveryId,
          subjectRef: input.subjectRef,
          subjectVersion: input.subjectVersion,
          kind: evidence.kind,
          assurance: evidence.assurance,
          evidenceJson: JSON.stringify(evidence),
          payloadDigest,
          observedAt,
          receivedAt
        };
        tx.insert(verificationEvidenceRecords).values(row).run();
        tx.insert(governanceEvents).values({
          workThreadId: input.workThreadId ?? null,
          type: "verification_evidence.recorded",
          subjectId: id,
          payloadJson: JSON.stringify({ provider: input.provider, deliveryId: input.deliveryId, subjectRef: input.subjectRef, subjectVersion: input.subjectVersion, kind: evidence.kind, assurance: evidence.assurance, payloadDigest }),
          createdAt: receivedAt
        }).run();
        return { evidence: storedVerificationEvidenceFromRow(row), created: true };
      });
    },

    async recordVerificationEvidenceBatch(input: {
      records: RecordVerificationEvidenceInput[];
    }): Promise<{ evidence: StoredVerificationEvidence[]; created: number }> {
      const records = input.records.map((record) => {
        const evidence = VerificationEvidenceSchema.parse(record.evidence);
        const receivedAt = record.receivedAt ?? nowIso();
        const observedAt = record.observedAt ?? evidence.createdAt;
        const payloadDigest = record.payloadDigest ?? sha256Json({
          provider: record.provider,
          deliveryId: record.deliveryId,
          subjectRef: record.subjectRef,
          subjectVersion: record.subjectVersion,
          evidence
        });
        return { ...record, evidence, receivedAt, observedAt, payloadDigest };
      });
      const batchKeys = new Set<string>();
      for (const record of records) {
        const key = JSON.stringify([record.provider, record.deliveryId, record.subjectRef, record.subjectVersion, record.evidence.kind]);
        if (batchKeys.has(key)) throw new Error("Verification evidence batch contains a duplicate delivery/subject/kind identity.");
        batchKeys.add(key);
      }
      return db.transaction((tx) => {
        const stored: StoredVerificationEvidence[] = [];
        let created = 0;
        for (const record of records) {
          if (record.workThreadId) {
            const thread = tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, record.workThreadId)).limit(1).get();
            if (!thread) throw new Error(`WorkThread ${record.workThreadId} does not exist.`);
          }
          const existing = tx
            .select()
            .from(verificationEvidenceRecords)
            .where(and(
              eq(verificationEvidenceRecords.provider, record.provider),
              eq(verificationEvidenceRecords.deliveryId, record.deliveryId),
              eq(verificationEvidenceRecords.subjectRef, record.subjectRef),
              eq(verificationEvidenceRecords.subjectVersion, record.subjectVersion),
              eq(verificationEvidenceRecords.kind, record.evidence.kind)
            ))
            .limit(1)
            .get();
          if (existing) {
            if (existing.payloadDigest !== record.payloadDigest || existing.evidenceJson !== JSON.stringify(record.evidence)) {
              throw new Error(`Evidence delivery ${record.provider}/${record.deliveryId} conflicts with its durable payload.`);
            }
            stored.push(storedVerificationEvidenceFromRow(existing));
            continue;
          }
          const id = record.id ?? record.evidence.id;
          const row = {
            id,
            workThreadId: record.workThreadId ?? null,
            provider: record.provider,
            deliveryId: record.deliveryId,
            subjectRef: record.subjectRef,
            subjectVersion: record.subjectVersion,
            kind: record.evidence.kind,
            assurance: record.evidence.assurance,
            evidenceJson: JSON.stringify(record.evidence),
            payloadDigest: record.payloadDigest,
            observedAt: record.observedAt,
            receivedAt: record.receivedAt
          };
          tx.insert(verificationEvidenceRecords).values(row).run();
          tx.insert(governanceEvents).values({
            workThreadId: record.workThreadId ?? null,
            type: "verification_evidence.recorded",
            subjectId: id,
            payloadJson: JSON.stringify({
              provider: record.provider,
              deliveryId: record.deliveryId,
              subjectRef: record.subjectRef,
              subjectVersion: record.subjectVersion,
              kind: record.evidence.kind,
              assurance: record.evidence.assurance,
              payloadDigest: record.payloadDigest
            }),
            createdAt: record.receivedAt
          }).run();
          created += 1;
          stored.push(storedVerificationEvidenceFromRow(row));
        }
        return { evidence: stored, created };
      });
    },

    async listVerificationEvidence(input: { workThreadId?: string }): Promise<StoredVerificationEvidence[]> {
      const rows = input.workThreadId
        ? await db.select().from(verificationEvidenceRecords).where(eq(verificationEvidenceRecords.workThreadId, input.workThreadId)).orderBy(asc(verificationEvidenceRecords.receivedAt), asc(verificationEvidenceRecords.id))
        : await db.select().from(verificationEvidenceRecords).orderBy(asc(verificationEvidenceRecords.receivedAt), asc(verificationEvidenceRecords.id));
      return rows.map(storedVerificationEvidenceFromRow);
    },

    async attachVerificationEvidenceDeliveryToWorkThread(input: {
      provider: string;
      deliveryId: string;
      subjectRef: string;
      workThreadId: string;
      attachedAt?: string;
    }): Promise<{ attached: number }> {
      return db.transaction((tx) => {
        const thread = tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, input.workThreadId)).limit(1).get();
        if (!thread) throw new Error(`WorkThread ${input.workThreadId} does not exist.`);
        const records = tx.select().from(verificationEvidenceRecords).where(and(
          eq(verificationEvidenceRecords.provider, input.provider),
          eq(verificationEvidenceRecords.deliveryId, input.deliveryId),
          eq(verificationEvidenceRecords.subjectRef, input.subjectRef)
        )).all();
        if (records.some((record) => record.workThreadId && record.workThreadId !== input.workThreadId)) {
          throw new Error(`Evidence delivery ${input.provider}/${input.deliveryId} is already attached to a different WorkThread.`);
        }
        const attached = tx.update(verificationEvidenceRecords)
          .set({ workThreadId: input.workThreadId })
          .where(and(
            eq(verificationEvidenceRecords.provider, input.provider),
            eq(verificationEvidenceRecords.deliveryId, input.deliveryId),
            eq(verificationEvidenceRecords.subjectRef, input.subjectRef),
            isNull(verificationEvidenceRecords.workThreadId)
          ))
          .run().changes;
        if (attached > 0) {
          tx.insert(governanceEvents).values({
            workThreadId: input.workThreadId,
            type: "verification_evidence.attached",
            subjectId: `${input.provider}:${input.deliveryId}:${input.subjectRef}`,
            payloadJson: JSON.stringify({
              provider: input.provider,
              deliveryId: input.deliveryId,
              subjectRef: input.subjectRef,
              recordCount: attached
            }),
            createdAt: input.attachedAt ?? nowIso()
          }).run();
        }
        return { attached };
      });
    },

    async appendCompletionAssessment(input: {
      assessment: CompletionAssessment;
      expectedCurrentAssessmentId: string | null;
    }): Promise<
      | { outcome: "recorded" | "duplicate"; assessment: CompletionAssessment }
      | { outcome: "conflict"; currentAssessment: CompletionAssessment | null }
    > {
      const assessment = CompletionAssessmentSchema.parse(input.assessment);
      const assessmentJson = JSON.stringify(assessment);
      return db.transaction((tx) => {
        const duplicateById = tx.select().from(completionAssessments).where(eq(completionAssessments.id, assessment.id)).limit(1).get();
        if (duplicateById) {
          if (duplicateById.assessmentJson !== assessmentJson) {
            throw new Error(`CompletionAssessment ${assessment.id} is immutable.`);
          }
          return { outcome: "duplicate" as const, assessment: completionAssessmentFromRow(duplicateById) };
        }
        const duplicateByInput = tx.select().from(completionAssessments).where(and(
          eq(completionAssessments.workThreadId, assessment.workThreadId),
          eq(completionAssessments.cycle, assessment.cycle),
          eq(completionAssessments.inputDigest, assessment.inputDigest)
        )).limit(1).get();
        if (duplicateByInput) {
          if (duplicateByInput.assessmentJson !== assessmentJson) {
            throw new Error(`CompletionAssessment input digest ${assessment.inputDigest} is immutable.`);
          }
          return { outcome: "duplicate" as const, assessment: completionAssessmentFromRow(duplicateByInput) };
        }
        const thread = tx.select().from(workThreads).where(eq(workThreads.id, assessment.workThreadId)).limit(1).get();
        if (!thread) throw new Error(`WorkThread ${assessment.workThreadId} does not exist.`);
        if (thread.currentAssessmentId !== input.expectedCurrentAssessmentId) {
          const current = thread.currentAssessmentId
            ? tx.select().from(completionAssessments).where(eq(completionAssessments.id, thread.currentAssessmentId)).limit(1).get()
            : undefined;
          return { outcome: "conflict" as const, currentAssessment: current ? completionAssessmentFromRow(current) : null };
        }
        if ((assessment.supersedesAssessmentId ?? null) !== input.expectedCurrentAssessmentId) {
          throw new Error("CompletionAssessment supersession must match the expected WorkThread assessment head.");
        }
        const previousInCycle = tx.select().from(completionAssessments).where(and(
          eq(completionAssessments.workThreadId, assessment.workThreadId),
          eq(completionAssessments.cycle, assessment.cycle)
        )).orderBy(desc(completionAssessments.sequence)).limit(1).get();
        const expectedSequence = (previousInCycle?.sequence ?? 0) + 1;
        if (assessment.sequence !== expectedSequence) {
          throw new Error(`CompletionAssessment sequence must be ${expectedSequence} for cycle ${assessment.cycle}.`);
        }
        const previousCurrent = thread.currentAssessmentId
          ? tx.select().from(completionAssessments).where(eq(completionAssessments.id, thread.currentAssessmentId)).limit(1).get()
          : undefined;
        tx.insert(completionAssessments).values({
          id: assessment.id,
          workThreadId: assessment.workThreadId,
          contractId: assessment.contractId,
          contractVersion: assessment.contractVersion,
          cycle: assessment.cycle,
          sequence: assessment.sequence,
          supersedesAssessmentId: assessment.supersedesAssessmentId ?? null,
          inputDigest: assessment.inputDigest,
          state: assessment.state,
          assessmentJson,
          createdAt: assessment.assessedAt
        }).run();
        const updateCondition = input.expectedCurrentAssessmentId === null
          ? and(eq(workThreads.id, assessment.workThreadId), isNull(workThreads.currentAssessmentId))
          : and(eq(workThreads.id, assessment.workThreadId), eq(workThreads.currentAssessmentId, input.expectedCurrentAssessmentId));
        const updated = tx.update(workThreads).set({ currentAssessmentId: assessment.id, updatedAt: assessment.assessedAt }).where(updateCondition).run();
        if (updated.changes !== 1) throw new Error("CompletionAssessment head compare-and-swap failed.");
        tx.insert(governanceEvents).values({
          workThreadId: assessment.workThreadId,
          type: "completion_assessment.appended",
          subjectId: assessment.id,
          payloadJson: JSON.stringify({ contractId: assessment.contractId, contractVersion: assessment.contractVersion, cycle: assessment.cycle, sequence: assessment.sequence, state: assessment.state, inputDigest: assessment.inputDigest, supersedesAssessmentId: assessment.supersedesAssessmentId ?? null }),
          createdAt: assessment.assessedAt
        }).run();
        const accepted = assessment.state === "satisfied" || assessment.state === "waived";
        const wasAccepted = previousCurrent?.state === "satisfied" || previousCurrent?.state === "waived";
        if (accepted && !wasAccepted && assessment.acceptedAt) {
          const elapsedMs = Math.max(0, Date.parse(assessment.acceptedAt) - Date.parse(thread.createdAt));
          tx.insert(governanceEvents).values({
            workThreadId: assessment.workThreadId,
            type: "success_metric.observed",
            subjectId: assessment.id,
            payloadJson: JSON.stringify({
              metric: "time_to_verified_completion_ms",
              value: Number.isFinite(elapsedMs) ? elapsedMs : 0,
              acceptedAt: assessment.acceptedAt,
              contractId: assessment.contractId,
              contractVersion: assessment.contractVersion,
              cycle: assessment.cycle,
              state: assessment.state,
              evidenceBacked: assessment.evidenceBacked
            }),
            createdAt: assessment.acceptedAt
          }).run();
        }
        return { outcome: "recorded" as const, assessment };
      });
    },

    async listCompletionAssessments(input: { workThreadId: string }): Promise<CompletionAssessment[]> {
      const rows = await db.select().from(completionAssessments).where(eq(completionAssessments.workThreadId, input.workThreadId)).orderBy(asc(completionAssessments.cycle), asc(completionAssessments.sequence));
      return rows.map(completionAssessmentFromRow);
    },

    async getCurrentCompletionAssessment(input: { workThreadId: string }): Promise<CompletionAssessment | null> {
      const thread = await db.select({ currentAssessmentId: workThreads.currentAssessmentId }).from(workThreads).where(eq(workThreads.id, input.workThreadId)).limit(1).get();
      if (!thread?.currentAssessmentId) return null;
      const row = await db.select().from(completionAssessments).where(eq(completionAssessments.id, thread.currentAssessmentId)).limit(1).get();
      return row ? completionAssessmentFromRow(row) : null;
    },

    async recordCompletionWaiver(input: { waiver: CompletionWaiver }): Promise<{ waiver: CompletionWaiver; created: boolean }> {
      const waiver = CompletionWaiverSchema.parse(sanitizeCredentialLikeValue(input.waiver));
      const waiverJson = JSON.stringify(waiver);
      const { id: _id, ...semanticWaiver } = waiver;
      const contentDigest = `sha256:${sha256(stableActionJson(semanticWaiver))}`;
      return db.transaction((tx) => {
        const existingById = tx.select().from(completionWaivers).where(eq(completionWaivers.id, waiver.id)).limit(1).get();
        if (existingById) {
          if (existingById.waiverJson !== waiverJson) throw new Error(`CompletionWaiver ${waiver.id} is immutable.`);
          return { waiver: completionWaiverFromRow(existingById), created: false };
        }
        const contract = tx.select().from(completionContracts).where(and(
          eq(completionContracts.id, waiver.contractId),
          eq(completionContracts.version, waiver.contractVersion),
          eq(completionContracts.cycle, waiver.cycle)
        )).limit(1).get();
        if (!contract) throw new Error(`CompletionWaiver ${waiver.id} targets an unknown completion contract snapshot.`);
        const existingByContent = tx.select().from(completionWaivers).where(and(
          eq(completionWaivers.workThreadId, contract.workThreadId),
          eq(completionWaivers.cycle, waiver.cycle),
          eq(completionWaivers.contentDigest, contentDigest)
        )).limit(1).get();
        if (existingByContent) return { waiver: completionWaiverFromRow(existingByContent), created: false };
        tx.insert(completionWaivers).values({
          id: waiver.id,
          workThreadId: contract.workThreadId,
          contractId: waiver.contractId,
          contractVersion: waiver.contractVersion,
          cycle: waiver.cycle,
          contentDigest,
          waiverJson,
          createdAt: waiver.waivedAt
        }).run();
        tx.insert(governanceEvents).values({
          workThreadId: contract.workThreadId,
          type: "completion_waiver.recorded",
          subjectId: waiver.id,
          payloadJson: JSON.stringify({
            runId: waiver.runId ?? null,
            contractId: waiver.contractId,
            contractVersion: waiver.contractVersion,
            cycle: waiver.cycle,
            actor: waiver.actor,
            reason: waiver.reason,
            scope: waiver.scope,
            policyScope: waiver.policyScope,
            gateIds: waiver.gateIds,
            waivedAt: waiver.waivedAt,
            expiresAt: waiver.expiresAt ?? null,
            contentDigest
          }),
          createdAt: waiver.waivedAt
        }).run();
        return { waiver, created: true };
      });
    },

    async listCompletionWaivers(input: { workThreadId: string }): Promise<CompletionWaiver[]> {
      const rows = await db.select().from(completionWaivers)
        .where(eq(completionWaivers.workThreadId, input.workThreadId))
        .orderBy(asc(completionWaivers.createdAt), asc(completionWaivers.id));
      return rows.map(completionWaiverFromRow);
    },

    async listMaterialActionReceiptsForWorkThread(input: { workThreadId: string }): Promise<MaterialActionReceipt[]> {
      const rows = await db
        .select({ actionFamily: materialActions.actionFamily, receiptJson: materialActions.receiptJson })
        .from(materialActions)
        .innerJoin(runs, eq(materialActions.runId, runs.id))
        .where(and(eq(runs.workThreadId, input.workThreadId), isNotNull(materialActions.receiptJson)))
        .orderBy(asc(materialActions.createdAt), asc(materialActions.id));
      return rows.flatMap((row) => {
        if (!row.receiptJson) return [];
        const receipt = MaterialActionReceiptSchema.parse(JSON.parse(row.receiptJson));
        return [{
          ...receipt,
          metadata: { ...(receipt.metadata ?? {}), actionFamily: row.actionFamily }
        }];
      });
    },

    async listMaterialActionReceiptsForRun(input: { runId: string }): Promise<MaterialActionReceipt[]> {
      const rows = await db
        .select({ actionFamily: materialActions.actionFamily, receiptJson: materialActions.receiptJson })
        .from(materialActions)
        .where(and(eq(materialActions.runId, input.runId), isNotNull(materialActions.receiptJson)))
        .orderBy(asc(materialActions.createdAt), asc(materialActions.id));
      return rows.flatMap((row) => {
        if (!row.receiptJson) return [];
        const receipt = MaterialActionReceiptSchema.parse(JSON.parse(row.receiptJson));
        return [{
          ...receipt,
          metadata: { ...(receipt.metadata ?? {}), actionFamily: row.actionFamily }
        }];
      });
    },

    async openHumanEscalation(input: { escalation: HumanEscalation }): Promise<{ escalation: HumanEscalation; created: boolean }> {
      const escalation = HumanEscalationSchema.parse(input.escalation);
      if (escalation.state !== "open" && escalation.state !== "acknowledged") {
        throw new Error("A new HumanEscalation must be open or acknowledged.");
      }
      const createdAt = escalation.openedAt;
      return db.transaction((tx) => {
        const thread = tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, escalation.workThreadId)).limit(1).get();
        if (!thread) throw new Error(`WorkThread ${escalation.workThreadId} does not exist.`);
        const activeDedupeKey = escalation.dedupeKey
          ? `${escalation.runId ?? "thread"}:${escalation.dedupeKey}`
          : null;
        const active = activeDedupeKey
          ? tx.select().from(humanEscalations).where(and(
              eq(humanEscalations.workThreadId, escalation.workThreadId),
              eq(humanEscalations.activeDedupeKey, activeDedupeKey)
            )).limit(1).get()
          : undefined;
        if (active) return { escalation: humanEscalationFromRow(active), created: false };
        const inserted = tx.insert(humanEscalations).values({
          id: escalation.id,
          workThreadId: escalation.workThreadId,
          class: escalation.class,
          state: escalation.state,
          dedupeKey: escalation.dedupeKey ?? null,
          activeDedupeKey,
          escalationJson: JSON.stringify(escalation),
          createdAt,
          updatedAt: createdAt
        }).onConflictDoNothing().run();
        if (inserted.changes !== 1) {
          const existingByDedupe = activeDedupeKey
            ? tx.select().from(humanEscalations).where(and(
                eq(humanEscalations.workThreadId, escalation.workThreadId),
                eq(humanEscalations.activeDedupeKey, activeDedupeKey)
              )).limit(1).get()
            : undefined;
          const existing = existingByDedupe
            ?? tx.select().from(humanEscalations).where(eq(humanEscalations.id, escalation.id)).limit(1).get();
          if (!existing) throw new Error("A conflicting HumanEscalation could not be correlated.");
          const correlated = humanEscalationFromRow(existing);
          if (
            correlated.workThreadId !== escalation.workThreadId
            || correlated.runId !== escalation.runId
            || correlated.dedupeKey !== escalation.dedupeKey
          ) {
            throw new Error("A conflicting HumanEscalation does not match the requested identity.");
          }
          return { escalation: correlated, created: false };
        }
        tx.insert(governanceEvents).values({
          workThreadId: escalation.workThreadId,
          type: "human_escalation.opened",
          subjectId: escalation.id,
          payloadJson: JSON.stringify({ class: escalation.class, blocking: escalation.blocking, dedupeKey: escalation.dedupeKey ?? null }),
          createdAt
        }).run();
        return { escalation, created: true };
      });
    },

    async transitionHumanEscalation(input: {
      id: string;
      toState: "acknowledged" | "resolved" | "expired" | "superseded";
      at: string;
      actor?: ActorIdentity;
      optionId?: string;
      reason?: string;
      supersededById?: string;
    }): Promise<{ escalation: HumanEscalation; changed: boolean }> {
      const transitionedAt = OpenTagEventSchema.shape.receivedAt.parse(input.at);
      return db.transaction((tx) => {
        const existing = tx.select().from(humanEscalations).where(eq(humanEscalations.id, input.id)).limit(1).get();
        if (!existing) throw new Error(`HumanEscalation ${input.id} does not exist.`);
        const current = humanEscalationFromRow(existing);
        const expiredDueToDeadline = Boolean(
          (input.toState === "acknowledged" || input.toState === "resolved")
          && current.expiresAt
          && Date.parse(transitionedAt) >= Date.parse(current.expiresAt)
        );
        const toState = expiredDueToDeadline ? "expired" as const : input.toState;
        if (current.state === toState) {
          if (toState === "acknowledged") {
            if (!input.actor) throw new Error("Acknowledging a HumanEscalation requires an attributed actor.");
            const actor = ActorIdentitySchema.parse(input.actor);
            if (!current.acknowledgement || stableActionJson(current.acknowledgement.actor) !== stableActionJson(actor)) {
              throw new Error(`HumanEscalation ${input.id} already has a different acknowledgement.`);
            }
          } else if (toState === "resolved") {
            if (!input.actor) throw new Error("Resolving a HumanEscalation requires an attributed actor.");
            const actor = ActorIdentitySchema.parse(input.actor);
            if (
              !current.resolution
              || stableActionJson(current.resolution.actor) !== stableActionJson(actor)
              || current.resolution.optionId !== input.optionId
              || current.resolution.reason !== input.reason
            ) {
              throw new Error(`HumanEscalation ${input.id} already has a different resolution.`);
            }
          } else if (
            (input.reason && current.terminalReason !== input.reason)
            || (toState === "superseded" && input.supersededById && current.supersededById !== input.supersededById)
          ) {
            throw new Error(`HumanEscalation ${input.id} already has different terminal details.`);
          }
          return { escalation: current, changed: false };
        }
        if (current.state === "resolved" || current.state === "expired" || current.state === "superseded") {
          throw new Error(`HumanEscalation ${input.id} is already terminal in state ${current.state}.`);
        }

        let escalation: HumanEscalation;
        if (toState === "acknowledged") {
          if (!input.actor) throw new Error("Acknowledging a HumanEscalation requires an attributed actor.");
          escalation = HumanEscalationSchema.parse({
            ...current,
            state: "acknowledged",
            acknowledgement: { actor: input.actor, acknowledgedAt: transitionedAt }
          });
        } else if (toState === "resolved") {
          if (!input.actor) throw new Error("Resolving a HumanEscalation requires an attributed actor.");
          if (current.options?.length && !input.optionId) {
            throw new Error("Resolving this HumanEscalation requires one offered optionId.");
          }
          escalation = HumanEscalationSchema.parse({
            ...current,
            state: "resolved",
            resolution: {
              ...(input.optionId ? { optionId: input.optionId } : {}),
              actor: input.actor,
              ...(input.reason ? { reason: input.reason } : {}),
              resolvedAt: transitionedAt
            }
          });
        } else if (toState === "expired") {
          if (!current.expiresAt || Date.parse(transitionedAt) < Date.parse(current.expiresAt)) {
            throw new Error(`HumanEscalation ${input.id} has not reached expiresAt.`);
          }
          escalation = HumanEscalationSchema.parse({
            ...current,
            state: "expired",
            terminalReason: expiredDueToDeadline
              ? "Escalation expired without implicit approval."
              : input.reason ?? "Escalation expired without implicit approval."
          });
        } else {
          if (!input.supersededById || input.supersededById === input.id) {
            throw new Error("Superseding a HumanEscalation requires a different supersededById.");
          }
          const successorRow = tx.select().from(humanEscalations)
            .where(eq(humanEscalations.id, input.supersededById)).limit(1).get();
          const successor = successorRow ? humanEscalationFromRow(successorRow) : null;
          if (!successor || successor.workThreadId !== current.workThreadId) {
            throw new Error("A HumanEscalation successor must exist in the same WorkThread.");
          }
          escalation = HumanEscalationSchema.parse({
            ...current,
            state: "superseded",
            supersededById: successor.id,
            terminalReason: input.reason ?? `Superseded by ${successor.id}.`
          });
        }

        const swapped = tx.update(humanEscalations).set({
          state: escalation.state,
          activeDedupeKey: escalation.state === "acknowledged" ? existing.activeDedupeKey : null,
          escalationJson: JSON.stringify(escalation),
          updatedAt: transitionedAt
        }).where(and(
          eq(humanEscalations.id, escalation.id),
          eq(humanEscalations.state, current.state)
        )).run();
        if (swapped.changes !== 1) {
          throw new Error(`HumanEscalation ${escalation.id} changed state concurrently.`);
        }
        tx.insert(governanceEvents).values({
          workThreadId: escalation.workThreadId,
          type: `human_escalation.${escalation.state}`,
          subjectId: escalation.id,
          payloadJson: JSON.stringify({
            class: escalation.class,
            ...(input.actor ? { actor: input.actor } : {}),
            ...(input.optionId ? { optionId: input.optionId } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
            ...(expiredDueToDeadline ? { rejectedLateTransition: input.toState } : {}),
            ...(input.supersededById ? { supersededById: input.supersededById } : {})
          }),
          createdAt: transitionedAt
        }).run();
        return { escalation, changed: true };
      });
    },

    async expireHumanEscalations(input: {
      at: string;
      workThreadId?: string;
      runId?: string;
    }): Promise<{ scanned: number; expired: number }> {
      const at = OpenTagEventSchema.shape.receivedAt.parse(input.at);
      const activeStateFilter = inArray(humanEscalations.state, ["open", "acknowledged"]);
      const rows = input.workThreadId
        ? await db.select().from(humanEscalations).where(and(
            eq(humanEscalations.workThreadId, input.workThreadId),
            activeStateFilter
          ))
        : await db.select().from(humanEscalations).where(activeStateFilter);
      const candidates = rows.map(humanEscalationFromRow).filter((escalation) =>
        (!input.runId || escalation.runId === input.runId)
        && Boolean(escalation.expiresAt)
        && Date.parse(escalation.expiresAt!) <= Date.parse(at)
      );
      let expired = 0;
      for (const escalation of candidates) {
        try {
          const result = await this.transitionHumanEscalation({
            id: escalation.id,
            toState: "expired",
            at,
            reason: "Escalation expired without implicit approval."
          });
          if (result.changed) expired += 1;
        } catch {
          // Each candidate is an independent best-effort transition. A
          // concurrent terminal decision must not prevent later expirations.
        }
      }
      return { scanned: rows.length, expired };
    },

    async resolveHumanEscalation(input: { escalation: HumanEscalation }): Promise<{ escalation: HumanEscalation; resolved: boolean }> {
      const escalation = HumanEscalationSchema.parse(input.escalation);
      if (escalation.state !== "resolved" || !escalation.resolution) {
        throw new Error("A resolved HumanEscalation with attributed resolution is required.");
      }
      const resolution = escalation.resolution;
      return db.transaction((tx) => {
        const existing = tx.select().from(humanEscalations).where(eq(humanEscalations.id, escalation.id)).limit(1).get();
        if (!existing) throw new Error(`HumanEscalation ${escalation.id} does not exist.`);
        const current = humanEscalationFromRow(existing);
        if (current.state === "resolved") {
          if (existing.escalationJson !== JSON.stringify(escalation)) {
            throw new Error(`HumanEscalation ${escalation.id} already has a different resolution.`);
          }
          return { escalation: current, resolved: false };
        }
        if (current.state === "expired" || current.state === "superseded") {
          throw new Error(`HumanEscalation ${escalation.id} is already terminal in state ${current.state}.`);
        }
        if (
          current.workThreadId !== escalation.workThreadId
          || current.class !== escalation.class
          || current.openedAt !== escalation.openedAt
          || current.dedupeKey !== escalation.dedupeKey
        ) {
          throw new Error(`HumanEscalation ${escalation.id} resolution cannot change its immutable identity.`);
        }
        tx.update(humanEscalations).set({
          state: "resolved",
          activeDedupeKey: null,
          escalationJson: JSON.stringify(escalation),
          updatedAt: resolution.resolvedAt
        }).where(eq(humanEscalations.id, escalation.id)).run();
        tx.insert(governanceEvents).values({
          workThreadId: escalation.workThreadId,
          type: "human_escalation.resolved",
          subjectId: escalation.id,
          payloadJson: JSON.stringify({ class: escalation.class, actor: resolution.actor, reason: resolution.reason ?? null }),
          createdAt: resolution.resolvedAt
        }).run();
        return { escalation, resolved: true };
      });
    },

    async listHumanEscalations(input: { workThreadId: string }): Promise<HumanEscalation[]> {
      const rows = await db.select().from(humanEscalations).where(eq(humanEscalations.workThreadId, input.workThreadId)).orderBy(asc(humanEscalations.createdAt), asc(humanEscalations.id));
      return rows.map(humanEscalationFromRow);
    },

    async getHumanEscalation(input: { id: string }): Promise<HumanEscalation | null> {
      const row = await db.select().from(humanEscalations).where(eq(humanEscalations.id, input.id)).limit(1).get();
      return row ? humanEscalationFromRow(row) : null;
    },

    async listGovernanceEvents(input: { workThreadId?: string }): Promise<GovernanceAuditEvent[]> {
      const rows = input.workThreadId
        ? await db.select().from(governanceEvents).where(eq(governanceEvents.workThreadId, input.workThreadId)).orderBy(asc(governanceEvents.id))
        : await db.select().from(governanceEvents).orderBy(asc(governanceEvents.id));
      return rows.map(governanceEventFromRow);
    },

    async getRunByEventId(input: { eventId: string }): Promise<{ run: OpenTagRun; event: OpenTagEvent } | null> {
      const row = await db.select().from(runs).where(eq(runs.eventId, input.eventId)).limit(1).get();
      if (!row) return null;
      return {
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async findActiveRunForConversation(input: { conversationKey: string }): Promise<{ run: OpenTagRun; event: OpenTagEvent } | null> {
      const rows = await db
        .select()
        .from(runs)
        .where(and(eq(runs.conversationKey, input.conversationKey), inArray(runs.status, ["assigned", "running", "needs_approval"])))
        .orderBy(asc(runs.createdAt));
      // A permission wait keeps its attempt attached so the runtime can heartbeat
      // and resume it. A completed needs_human run clears the attempt and must not
      // block later work in the same conversation.
      const row = rows.find((candidate) => candidate.status !== "needs_approval" || candidate.currentAttemptId !== null);
      if (!row) return null;
      return {
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async findCancelableRunForConversation(input: { conversationKeys: string[] }): Promise<{ run: OpenTagRun; event: OpenTagEvent } | null> {
      const keys = [...new Set(input.conversationKeys.filter((key) => key.length > 0))];
      if (keys.length === 0) return null;
      const rows = await db
        .select()
        .from(runs)
        .where(and(inArray(runs.conversationKey, keys), inArray(runs.status, ["queued", "assigned", "running", "needs_approval"])))
        .orderBy(asc(runs.createdAt));
      // A run parked in needs_approval can sit in the conversation indefinitely; the run
      // that is actually executing (or about to) is the one status/stop should target.
      const row = rows.find((candidate) => candidate.status !== "needs_approval") ?? rows[0];
      if (!row) return null;
      return {
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async findCancelableRunForSourceContainer(input: {
      source: string;
      repoProvider?: string;
      owner?: string;
      repo?: string;
      metadata: Record<string, string>;
    }): Promise<{ run: OpenTagRun; event: OpenTagEvent } | null> {
      const targetFields = [input.repoProvider, input.owner, input.repo];
      const targetFieldCount = targetFields.filter((value) => value !== undefined).length;
      if (targetFieldCount !== 0 && targetFieldCount !== 3) {
        throw new Error("Cancelable source-container lookup repository fields must be provided together.");
      }
      const activeStatus = inArray(runs.status, ["queued", "assigned", "running", "needs_approval"]);
      const rows = input.repoProvider && input.owner && input.repo
        ? await db
            .select()
            .from(runs)
            .where(
              and(
                eq(runs.repoProvider, input.repoProvider),
                eq(runs.repoOwner, input.owner),
                eq(runs.repoName, input.repo),
                activeStatus
              )
            )
            .orderBy(asc(runs.createdAt))
        : await db.select().from(runs).where(activeStatus).orderBy(asc(runs.createdAt));
      for (const row of rows) {
        const event = OpenTagEventSchema.parse(JSON.parse(row.eventJson));
        if (sourceContainerMetadataMatches({ event, source: input.source, metadata: input.metadata })) {
          return { run: runFromRow(row), event };
        }
      }
      return null;
    },

    async cancelRun(input: { runId: string; reason?: string; requestedBy?: string }): Promise<CancelRunOutcome> {
      const updatedAt = nowIso();
      return db.transaction((tx) => {
        const current = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        if (!current) return { outcome: "not_found" as const };
        const event = OpenTagEventSchema.parse(JSON.parse(current.eventJson));
        if (terminalRunStatus(current.status)) {
          return { outcome: "already_terminal" as const, run: runFromRow(current), event };
        }
        const fencingTokens = tx
          .select({ fencingToken: attempts.fencingToken })
          .from(attempts)
          .where(eq(attempts.runId, input.runId))
          .all()
          .map((attempt) => attempt.fencingToken);
        const safeCancellation = sanitizeRunEventValue({
          reason: input.reason ?? "Cancellation was requested by a human.",
          ...(input.requestedBy ? { requestedBy: input.requestedBy } : {})
        }, fencingTokens);
        const result = OpenTagRunResultSchema.parse({
          conclusion: "cancelled",
          summary: safeCancellation.reason,
          nextAction: "OpenTag will not treat this stop request as a successful completion."
        });
        const cas = tx.update(runs)
          .set({
            status: "cancelled",
            resultJson: JSON.stringify(result),
            assignedRunnerId: null,
            leasedAt: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            currentAttemptId: null,
            updatedAt
          })
          .where(and(eq(runs.id, input.runId), inArray(runs.status, ["queued", "assigned", "running", "needs_approval"])))
          .run();
        if (cas.changes !== 1) {
          const winner = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
          if (!winner) return { outcome: "not_found" as const };
          if (terminalRunStatus(winner.status)) {
            return {
              outcome: "already_terminal" as const,
              run: runFromRow(winner),
              event: OpenTagEventSchema.parse(JSON.parse(winner.eventJson))
            };
          }
          throw new Error(`Cancellation CAS lost while Run ${input.runId} remained active`);
        }
        if (current.currentAttemptId) {
          const attemptCancellation = tx.update(attempts)
            .set({ status: "cancelled", finishedAt: updatedAt, resultJson: JSON.stringify(result), updatedAt })
            .where(and(
              eq(attempts.id, current.currentAttemptId),
              eq(attempts.runId, input.runId),
              inArray(attempts.status, ["assigned", "running"])
            ))
            .run();
          if (attemptCancellation.changes !== 1) {
            throw new Error(`Cancellation could not terminate active Attempt ${current.currentAttemptId}`);
          }
        }
        tx.update(materialActions)
          .set({ status: "unknown", updatedAt })
          .where(and(eq(materialActions.runId, input.runId), eq(materialActions.status, "executing")))
          .run();
        tx.update(materialActions)
          .set({ status: "cancelled", updatedAt })
          .where(and(
            eq(materialActions.runId, input.runId),
            inArray(materialActions.status, ["proposed", "waiting_approval", "authorized"])
          ))
          .run();
        tx.update(grants)
          .set({ revokedAt: updatedAt })
          .where(and(
            eq(grants.runId, input.runId),
            isNotNull(grants.attemptId),
            isNull(grants.revokedAt)
          ))
          .run();
        const safeAuditEvent = sanitizeRunEventValue({
          runId: input.runId,
          type: "run.cancel_requested",
          payload: {
            previousStatus: current.status,
            previousRunnerId: current.assignedRunnerId,
            terminalReason: "cancelled_by_user",
            terminalSemantics: "A human stop request is not a successful completion and does not auto-promote queued follow-ups.",
            ...(safeCancellation.requestedBy ? { requestedBy: safeCancellation.requestedBy } : {}),
            reason: result.summary
          },
          visibility: "audit" as const,
          importance: "high" as const,
          message: result.summary,
          createdAt: updatedAt
        }, fencingTokens);
        tx.insert(runEvents)
          .values(runEventValues(safeAuditEvent))
          .run();
        const cancelled = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        if (!cancelled || cancelled.status !== "cancelled") {
          throw new Error(`Cancelled Run ${input.runId} could not be loaded from the winning transaction`);
        }
        return { outcome: "cancelled" as const, run: runFromRow(cancelled), event };
      });
    },

    async createFollowUpRequest(input: {
      id: string;
      event: OpenTagEvent;
      decision: RunAdmissionDecision;
      activeRunId?: string;
      accessProfileSnapshot?: AgentAccessProfileSnapshot;
      policySnapshotProvenance?: PolicySnapshotProvenance;
    }): Promise<{ followUpRequest: FollowUpRequest; created: boolean }> {
      const event = OpenTagEventSchema.parse(input.event);
      const decision = RunAdmissionDecisionSchema.parse(input.decision);
      const accessProfileSnapshot = input.accessProfileSnapshot
        ? AgentAccessProfileSnapshotSchema.parse(input.accessProfileSnapshot)
        : undefined;
      const policySnapshotProvenance = input.policySnapshotProvenance
        ? PolicySnapshotProvenanceSchema.parse(input.policySnapshotProvenance)
        : undefined;
      if (Boolean(accessProfileSnapshot) !== Boolean(policySnapshotProvenance)) {
        throw new Error("Follow-up access and policy snapshots must be captured together.");
      }
      if (accessProfileSnapshot && policySnapshotProvenance && accessProfileSnapshot.policySnapshotId !== policySnapshotProvenance.id) {
        throw new Error("Follow-up access snapshot must reference the captured policy snapshot.");
      }
      const createdAt = nowIso();
      const conversationKey = conversationKeyFromEvent(event);
      const insertResult = await db
        .insert(followUpRequests)
        .values({
          id: input.id,
          sourceEventId: event.id,
          conversationKey,
          activeRunId: input.activeRunId ?? null,
          eventJson: JSON.stringify(event),
          decisionJson: JSON.stringify(decision),
          accessProfileSnapshotJson: accessProfileSnapshot ? JSON.stringify(accessProfileSnapshot) : null,
          policySnapshotProvenanceJson: policySnapshotProvenance ? JSON.stringify(policySnapshotProvenance) : null,
          status: "queued",
          createdRunId: null,
          createdAt,
          updatedAt: createdAt
        })
        .onConflictDoNothing({ target: followUpRequests.sourceEventId });
      if (insertResult.changes === 0) {
        const existing = await db.select().from(followUpRequests).where(eq(followUpRequests.sourceEventId, event.id)).limit(1).get();
        if (!existing) {
          throw new Error(`Follow-up request already exists for event ${event.id}, but it could not be loaded`);
        }
        return { followUpRequest: followUpRequestFromRow(existing), created: false };
      }
      const created = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.id)).limit(1).get();
      if (!created) {
        throw new Error(`Follow-up request ${input.id} was created but could not be loaded`);
      }
      return { followUpRequest: followUpRequestFromRow(created), created: true };
    },

    async getFollowUpRequest(input: { id: string }): Promise<FollowUpRequest | null> {
      const row = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.id)).limit(1).get();
      return row ? followUpRequestFromRow(row) : null;
    },

    async listQueuedFollowUpsForActiveRun(input: { activeRunId: string }): Promise<FollowUpRequest[]> {
      const rows = await db
        .select()
        .from(followUpRequests)
        .where(and(eq(followUpRequests.activeRunId, input.activeRunId), eq(followUpRequests.status, "queued")))
        .orderBy(asc(followUpRequests.createdAt));
      return rows.map(followUpRequestFromRow);
    },

    async createRunFromFollowUpRequest(input: { followUpRequestId: string; runId: string }): Promise<{ followUpRequest: FollowUpRequest; run: OpenTagRun }> {
      const row = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.followUpRequestId)).limit(1).get();
      if (!row) {
        throw new Error(`Follow-up request not found: ${input.followUpRequestId}`);
      }
      if (row.status !== "queued") {
        throw new Error(`Follow-up request ${input.followUpRequestId} is not queued.`);
      }
      const updatedAt = nowIso();
      const promoteResult = await db
        .update(followUpRequests)
        .set({
          status: "promoting",
          updatedAt
        })
        .where(and(eq(followUpRequests.id, input.followUpRequestId), eq(followUpRequests.status, "queued")));
      if (promoteResult.changes === 0) {
        throw new Error(`Follow-up request ${input.followUpRequestId} is not queued.`);
      }
      const followUp = followUpRequestFromRow({ ...row, status: "promoting", updatedAt });
      try {
        const { run, created } = await this.createRun({
          id: input.runId,
          event: followUp.event,
          ...(followUp.accessProfileSnapshot ? { accessProfileSnapshot: followUp.accessProfileSnapshot } : {}),
          ...(followUp.policySnapshotProvenance ? { policySnapshotProvenance: followUp.policySnapshotProvenance } : {}),
          ...(followUp.activeRunId ? { parentRunId: followUp.activeRunId } : {})
        });
        if (!created) {
          throw new Error(`Run already exists for follow-up request ${input.followUpRequestId}.`);
        }
        await db
          .update(followUpRequests)
          .set({
            status: "promoted",
            createdRunId: run.id,
            updatedAt
          })
          .where(eq(followUpRequests.id, input.followUpRequestId));
        const updated = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.followUpRequestId)).limit(1).get();
        if (!updated) {
          throw new Error(`Follow-up request ${input.followUpRequestId} was promoted but could not be loaded`);
        }
        if (followUp.activeRunId) {
          await appendRunEvent({
            runId: followUp.activeRunId,
            type: "follow_up_request.promoted",
            payload: { followUpRequestId: followUp.id, createdRunId: run.id, sourceEventId: followUp.sourceEventId },
            visibility: "audit",
            importance: "normal",
            createdAt: updatedAt
          });
        }
        return { followUpRequest: followUpRequestFromRow(updated), run };
      } catch (error) {
        await db
          .update(followUpRequests)
          .set({
            status: "queued",
            updatedAt: nowIso()
          })
          .where(and(eq(followUpRequests.id, input.followUpRequestId), eq(followUpRequests.status, "promoting")));
        throw error;
      }
    },

    async registerRunner(input: { runnerId: string; name: string }): Promise<void> {
      const createdAt = nowIso();
      await db
        .insert(runners)
        .values({ runnerId: input.runnerId, name: input.name, createdAt, heartbeatAt: createdAt })
        .onConflictDoUpdate({
          target: runners.runnerId,
          set: {
            name: input.name,
            heartbeatAt: createdAt
          }
        });
    },

    async getRunner(input: { runnerId: string }): Promise<RunnerRegistration | null> {
      const row = await db.select().from(runners).where(eq(runners.runnerId, input.runnerId)).limit(1).get();
      return row ? runnerFromRow(row) : null;
    },

    async createRepoBinding(input: {
      provider: string;
      owner: string;
      repo: string;
      runnerId: string;
      workspacePath?: string;
      defaultExecutor?: string;
      allowedActors?: string[];
    }): Promise<void> {
      await db
        .insert(repoBindings)
        .values({
          ...input,
          workspacePath: input.workspacePath ?? null,
          defaultExecutor: input.defaultExecutor ?? null,
          allowedActorsJson: input.allowedActors ? JSON.stringify(input.allowedActors) : null,
          createdAt: nowIso()
        })
        .onConflictDoUpdate({
          target: [repoBindings.provider, repoBindings.owner, repoBindings.repo],
          set: {
            runnerId: input.runnerId,
            workspacePath: input.workspacePath ?? null,
            defaultExecutor: input.defaultExecutor ?? null,
            allowedActorsJson: input.allowedActors ? JSON.stringify(input.allowedActors) : null
          }
        });
    },

    async upsertRepoPolicyRule(input: { provider: string; owner: string; repo: string; rule: PolicyRule }): Promise<PolicyRule> {
      const rule = PolicyRuleSchema.parse(input.rule);
      const createdAt = nowIso();
      await db
        .insert(repoPolicyRules)
        .values({
          id: rule.id,
          provider: input.provider,
          owner: input.owner,
          repo: input.repo,
          ruleJson: JSON.stringify(rule),
          createdAt
        })
        .onConflictDoUpdate({
          target: [repoPolicyRules.provider, repoPolicyRules.owner, repoPolicyRules.repo, repoPolicyRules.id],
          set: {
            ruleJson: JSON.stringify(rule),
            createdAt
          }
        });
      return rule;
    },

    async listRepoPolicyRules(input: { provider: string; owner: string; repo: string }): Promise<PolicyRule[]> {
      const rows = await db
        .select()
        .from(repoPolicyRules)
        .where(and(eq(repoPolicyRules.provider, input.provider), eq(repoPolicyRules.owner, input.owner), eq(repoPolicyRules.repo, input.repo)))
        .orderBy(asc(repoPolicyRules.createdAt));
      return rows.map((row) => PolicyRuleSchema.parse(JSON.parse(row.ruleJson)));
    },

    async upsertRepoMutationMapping(input: {
      provider: string;
      owner: string;
      repo: string;
      mapping: AdapterMutationMapping;
    }): Promise<AdapterMutationMapping> {
      const mapping = AdapterMutationMappingSchema.parse(input.mapping);
      const createdAt = nowIso();
      await db
        .insert(repoMutationMappings)
        .values({
          id: mapping.id,
          provider: input.provider,
          owner: input.owner,
          repo: input.repo,
          mappingJson: JSON.stringify(mapping),
          createdAt
        })
        .onConflictDoUpdate({
          target: [repoMutationMappings.provider, repoMutationMappings.owner, repoMutationMappings.repo, repoMutationMappings.id],
          set: {
            mappingJson: JSON.stringify(mapping),
            createdAt
          }
        });
      return mapping;
    },

    async listRepoMutationMappings(input: { provider: string; owner: string; repo: string }): Promise<AdapterMutationMapping[]> {
      const rows = await db
        .select()
        .from(repoMutationMappings)
        .where(and(eq(repoMutationMappings.provider, input.provider), eq(repoMutationMappings.owner, input.owner), eq(repoMutationMappings.repo, input.repo)))
        .orderBy(asc(repoMutationMappings.createdAt));
      return rows.map((row) => AdapterMutationMappingSchema.parse(JSON.parse(row.mappingJson)));
    },

    async upsertLinearRelayInstallation(input: {
      id: string;
      webhookPath: string;
      webhookSecret: string;
      token: string;
      auth?: LinearRelayInstallationAuth;
      graphqlUrl?: string;
      repoProvider: string;
      owner: string;
      repo: string;
      organizationId?: string;
      teamId?: string;
      teamKey?: string;
    }): Promise<LinearRelayInstallation> {
      const createdAt = nowIso();
      const authJson = input.auth ? JSON.stringify(input.auth) : null;
      await db
        .insert(linearRelayInstallations)
        .values({
          id: input.id,
          webhookPath: input.webhookPath,
          webhookSecret: input.webhookSecret,
          token: input.token,
          authJson,
          graphqlUrl: input.graphqlUrl ?? null,
          repoProvider: input.repoProvider,
          owner: input.owner,
          repo: input.repo,
          organizationId: input.organizationId ?? null,
          teamId: input.teamId ?? null,
          teamKey: input.teamKey ?? null,
          createdAt,
          updatedAt: createdAt
        })
        .onConflictDoUpdate({
          target: linearRelayInstallations.id,
          set: {
            webhookPath: input.webhookPath,
            webhookSecret: input.webhookSecret,
            token: input.token,
            authJson,
            graphqlUrl: input.graphqlUrl ?? null,
            repoProvider: input.repoProvider,
            owner: input.owner,
            repo: input.repo,
            organizationId: input.organizationId ?? null,
            teamId: input.teamId ?? null,
            teamKey: input.teamKey ?? null,
            updatedAt: createdAt
          }
        });
      const [row] = await db.select().from(linearRelayInstallations).where(eq(linearRelayInstallations.id, input.id)).limit(1);
      if (!row) {
        throw new Error(`Linear relay installation ${input.id} was not stored.`);
      }
      return linearRelayInstallationFromRow(row);
    },

    async getLinearRelayInstallation(input: { id: string }): Promise<LinearRelayInstallation | null> {
      const [row] = await db.select().from(linearRelayInstallations).where(eq(linearRelayInstallations.id, input.id)).limit(1);
      return row ? linearRelayInstallationFromRow(row) : null;
    },

    async getLinearRelayInstallationByOrganizationId(input: { organizationId: string }): Promise<LinearRelayInstallation | null> {
      const [row] = await db
        .select()
        .from(linearRelayInstallations)
        .where(eq(linearRelayInstallations.organizationId, input.organizationId))
        .limit(1);
      return row ? linearRelayInstallationFromRow(row) : null;
    },

    async getLinearRelayInstallationByWebhookPath(input: { webhookPath: string }): Promise<LinearRelayInstallation | null> {
      const [row] = await db
        .select()
        .from(linearRelayInstallations)
        .where(eq(linearRelayInstallations.webhookPath, input.webhookPath))
        .limit(1);
      return row ? linearRelayInstallationFromRow(row) : null;
    },

    async deleteLinearRelayInstallation(input: { id: string }): Promise<boolean> {
      const result = await db.delete(linearRelayInstallations).where(eq(linearRelayInstallations.id, input.id));
      return result.changes > 0;
    },

    async createLinearOAuthInstallState(input: {
      state: string;
      installationId: string;
      webhookPath: string;
      webhookSecret: string;
      redirectUri: string;
      graphqlUrl?: string;
      repoProvider: string;
      owner: string;
      repo: string;
      teamId?: string;
      teamKey?: string;
      scopes: string[];
      expiresAt: string;
    }): Promise<LinearOAuthInstallState> {
      const createdAt = nowIso();
      await db
        .insert(linearOAuthInstallStates)
        .values({
          state: input.state,
          installationId: input.installationId,
          webhookPath: input.webhookPath,
          webhookSecret: input.webhookSecret,
          redirectUri: input.redirectUri,
          graphqlUrl: input.graphqlUrl ?? null,
          repoProvider: input.repoProvider,
          owner: input.owner,
          repo: input.repo,
          teamId: input.teamId ?? null,
          teamKey: input.teamKey ?? null,
          scopesJson: JSON.stringify(input.scopes),
          createdAt,
          expiresAt: input.expiresAt,
          completedAt: null
        })
        .onConflictDoUpdate({
          target: linearOAuthInstallStates.state,
          set: {
            installationId: input.installationId,
            webhookPath: input.webhookPath,
            webhookSecret: input.webhookSecret,
            redirectUri: input.redirectUri,
            graphqlUrl: input.graphqlUrl ?? null,
            repoProvider: input.repoProvider,
            owner: input.owner,
            repo: input.repo,
            teamId: input.teamId ?? null,
            teamKey: input.teamKey ?? null,
            scopesJson: JSON.stringify(input.scopes),
            createdAt,
            expiresAt: input.expiresAt,
            completedAt: null
          }
        });
      const [row] = await db.select().from(linearOAuthInstallStates).where(eq(linearOAuthInstallStates.state, input.state)).limit(1);
      if (!row) {
        throw new Error(`Linear OAuth install state ${input.state} was not stored.`);
      }
      return linearOAuthInstallStateFromRow(row);
    },

    async getLinearOAuthInstallState(input: { state: string }): Promise<LinearOAuthInstallState | null> {
      const [row] = await db.select().from(linearOAuthInstallStates).where(eq(linearOAuthInstallStates.state, input.state)).limit(1);
      return row ? linearOAuthInstallStateFromRow(row) : null;
    },

    async completeLinearOAuthInstallState(input: { state: string; completedAt?: string }): Promise<void> {
      await db
        .update(linearOAuthInstallStates)
        .set({ completedAt: input.completedAt ?? nowIso() })
        .where(eq(linearOAuthInstallStates.state, input.state));
    },

    async upsertChannelBinding(input: ChannelBinding & { allowManagedOwnershipOverride?: boolean }): Promise<void> {
      const repositoryFields = channelBindingRepositoryFields(input);
      const ownership = input.ownership ? OpenTagManagedChannelBindingOwnershipSchema.parse(input.ownership) : undefined;
      db.transaction((tx) => {
        const existingRow = tx
          .select()
          .from(channelBindings)
          .where(
            and(
              eq(channelBindings.provider, input.provider),
              eq(channelBindings.accountId, input.accountId),
              eq(channelBindings.conversationId, input.conversationId)
            )
          )
          .limit(1)
          .get();
        const existing = existingRow ? channelBindingFromRow(existingRow) : null;
        if (!input.allowManagedOwnershipOverride && existing?.ownership && (
          !ownership ||
          ownership.applicationId !== existing.ownership.applicationId ||
          ownership.botId !== existing.ownership.botId
        )) {
          throw new Error("Exclusive managed channel binding belongs to a different application identity.");
        }
        tx.insert(channelBindings)
          .values({
            provider: input.provider,
            accountId: input.accountId,
            conversationId: input.conversationId,
            ...repositoryFields,
            metadataJson: channelBindingRecordJson({ ...input, ...(ownership ? { ownership } : {}) }),
            createdAt: nowIso()
          })
          .onConflictDoUpdate({
            target: [channelBindings.provider, channelBindings.accountId, channelBindings.conversationId],
            set: {
              ...repositoryFields,
              metadataJson: channelBindingRecordJson({ ...input, ...(ownership ? { ownership } : {}) })
            }
          })
          .run();
      });
    },

    async deleteChannelBinding(input: {
      provider: string;
      accountId: string;
      conversationId: string;
      expectedBinding?: ChannelBinding;
    }): Promise<boolean> {
      return db.transaction((tx) => {
        const existingRow = tx
          .select()
          .from(channelBindings)
          .where(
            and(
              eq(channelBindings.provider, input.provider),
              eq(channelBindings.accountId, input.accountId),
              eq(channelBindings.conversationId, input.conversationId)
            )
          )
          .limit(1)
          .get();
        if (!existingRow) return false;
        const existing = channelBindingFromRow(existingRow);
        if (existing.ownership && !input.expectedBinding) return false;
        if (input.expectedBinding && !channelBindingsMatch(existing, input.expectedBinding)) return false;
        tx.delete(channelBindings)
          .where(
            and(
              eq(channelBindings.provider, input.provider),
              eq(channelBindings.accountId, input.accountId),
              eq(channelBindings.conversationId, input.conversationId)
            )
          )
          .run();
        return true;
      });
    },

    async createSlackChannelBinding(input: SlackChannelBinding): Promise<void> {
      const repoProvider = input.repoProvider ?? "github";
      db.transaction((tx) => {
        const existingRow = tx
          .select()
          .from(channelBindings)
          .where(
            and(
              eq(channelBindings.provider, "slack"),
              eq(channelBindings.accountId, input.teamId),
              eq(channelBindings.conversationId, input.channelId)
            )
          )
          .limit(1)
          .get();
        const existing = existingRow ? channelBindingFromRow(existingRow) : null;
        if (existing?.ownership) {
          throw new Error("Exclusive managed channel binding cannot be mutated through the Slack compatibility store method.");
        }
        const binding: ChannelBinding = {
          provider: "slack",
          accountId: input.teamId,
          conversationId: input.channelId,
          repoProvider,
          owner: input.owner,
          repo: input.repo,
          ...(existing?.metadata ? { metadata: existing.metadata } : {})
        };
        tx.insert(channelBindings)
          .values({
            provider: binding.provider,
            accountId: binding.accountId,
            conversationId: binding.conversationId,
            repoProvider,
            owner: input.owner,
            repo: input.repo,
            metadataJson: channelBindingRecordJson(binding),
            createdAt: nowIso()
          })
          .onConflictDoUpdate({
            target: [channelBindings.provider, channelBindings.accountId, channelBindings.conversationId],
            set: {
              repoProvider,
              owner: input.owner,
              repo: input.repo,
              metadataJson: channelBindingRecordJson(binding)
            }
          })
          .run();
      });
    },

    async createRun(input: {
      id: string;
      event: OpenTagEvent;
      accessProfileSnapshot?: AgentAccessProfileSnapshot;
      policySnapshotProvenance?: PolicySnapshotProvenance;
      parentRunId?: string;
      triggeredByAction?: ActionHint;
      sourceProposalId?: string;
      sourceApplyPlanId?: string;
    }): Promise<CreateRunResult> {
      const event = OpenTagEventSchema.parse(input.event);
      const accessProfileSnapshot = input.accessProfileSnapshot
        ? AgentAccessProfileSnapshotSchema.parse(input.accessProfileSnapshot)
        : undefined;
      const policySnapshotProvenance = input.policySnapshotProvenance
        ? PolicySnapshotProvenanceSchema.parse(input.policySnapshotProvenance)
        : undefined;
      if (Boolean(accessProfileSnapshot) !== Boolean(policySnapshotProvenance)) {
        throw new Error("Run access and policy snapshots must be attached together.");
      }
      if (accessProfileSnapshot && accessProfileSnapshot.policySnapshotId !== policySnapshotProvenance?.id) {
        throw new Error("An access profile snapshot must reference the attached policy snapshot provenance.");
      }
      const triggeredByAction = input.triggeredByAction ? ActionHintSchema.parse(input.triggeredByAction) : undefined;
      const createdAt = nowIso();
      const protocolFields = protocolRunFieldsFromEvent(event, createdAt);
      const durableThread = protocolFields.thread
        ? (await upsertWorkThreadRecord({ thread: protocolFields.thread, recordedAt: createdAt })).thread
        : undefined;
      const repoKey = projectTargetRefFromEvent(event);
      const expectedRunnerId = await repoBindingRunnerId(repoKey);
      const sourceDeliveryId = sourceDeliveryIdFromEvent(event);
      if (sourceDeliveryId) {
        const existingDelivery = await db
          .select()
          .from(sourceDeliveries)
          .where(and(eq(sourceDeliveries.source, event.source), eq(sourceDeliveries.deliveryId, sourceDeliveryId)))
          .limit(1)
          .get();
        if (existingDelivery) {
          const existingByDelivery = await db.select().from(runs).where(eq(runs.id, existingDelivery.runId)).limit(1).get();
          if (existingByDelivery) {
            return recordCreateRunReplay({
              runRow: existingByDelivery,
              requestedRunId: input.id,
              event,
              projectTarget: repoKey,
              expectedRunnerId,
              replayKind: "source_delivery",
              sourceDeliveryId,
              createdAt
            });
          }
        }
      }
      const insertResult = await db
        .insert(runs)
        .values({
        id: input.id,
        eventId: event.id,
        status: "queued",
        eventJson: JSON.stringify(event),
        contextPacketJson: JSON.stringify(protocolFields.contextPacket),
        accessProfileSnapshotJson: accessProfileSnapshot ? JSON.stringify(accessProfileSnapshot) : null,
        policySnapshotProvenanceJson: policySnapshotProvenance ? JSON.stringify(policySnapshotProvenance) : null,
        parentRunId: input.parentRunId ?? null,
        triggeredByActionJson: triggeredByAction ? JSON.stringify(triggeredByAction) : null,
        sourceProposalId: input.sourceProposalId ?? null,
        sourceApplyPlanId: input.sourceApplyPlanId ?? null,
        repoProvider: repoKey?.provider ?? null,
        repoOwner: repoKey?.owner ?? null,
        repoName: repoKey?.repo ?? null,
        workThreadId: durableThread?.id ?? null,
        conversationKey: conversationKeyFromEvent(event),
        createdAt,
        updatedAt: createdAt
        })
        .onConflictDoNothing({ target: runs.eventId });
      if (insertResult.changes === 0) {
        const existingBySourceEvent = await db.select().from(runs).where(eq(runs.eventId, event.id)).limit(1).get();
        if (!existingBySourceEvent) {
          throw new Error(`Run already exists for event ${event.id}, but it could not be loaded`);
        }
        return recordCreateRunReplay({
          runRow: existingBySourceEvent,
          requestedRunId: input.id,
          event,
          projectTarget: repoKey,
          expectedRunnerId,
          replayKind: "source_event",
          sourceDeliveryId,
          createdAt
        });
      }
      const createDecision = RunAdmissionDecisionSchema.parse({
        action: "start",
        reason: "Source event accepted and ready to create a run.",
        reasonCode: "new_event",
        decidedAt: createdAt,
        eventId: event.id
      });
      if (sourceDeliveryId) {
        await db
          .insert(sourceDeliveries)
          .values({
            source: event.source,
            deliveryId: sourceDeliveryId,
            runId: input.id,
            eventId: event.id,
            createdAt
          })
          .onConflictDoNothing({ target: [sourceDeliveries.source, sourceDeliveries.deliveryId] });
      }
      await appendRunEvent({
        runId: input.id,
        type: "admission.decided",
        payload: createDecision,
        visibility: "audit",
        importance: "normal",
        message: createDecision.reason,
        createdAt
      });
      await appendRunEvent({
        runId: input.id,
        type: "run.created",
        payload: {
          eventId: event.id,
          provenance: runProvenance({
            event,
            projectTarget: repoKey,
            admissionDecision: createDecision,
            expectedRunnerId
          })
        },
        visibility: "audit",
        importance: "low",
        createdAt
      });
      await appendRunEvent({
        runId: input.id,
        type: "context_packet.generated",
        payload: {
          contextPacket: protocolFields.contextPacket,
          ...(durableThread ? { thread: durableThread } : {})
        },
        visibility: "audit",
        importance: "normal",
        message: protocolFields.contextPacket.summary,
        createdAt
      });
      if (accessProfileSnapshot && policySnapshotProvenance) {
        await appendRunEvent({
          runId: input.id,
          type: "agent_access_profile.captured",
          payload: {
            accessProfileSnapshotId: accessProfileSnapshot.id,
            policySnapshotId: policySnapshotProvenance.id,
            requestedBy: accessProfileSnapshot.requestedBy,
            agentPrincipal: accessProfileSnapshot.agentPrincipal,
            projectTargets: accessProfileSnapshot.projectTargets
          },
          visibility: "audit",
          importance: "high",
          message: "Attributed agent access and policy snapshots captured at admission.",
          createdAt
        });
      }
      if (input.parentRunId) {
        await appendRunEvent({
          runId: input.parentRunId,
          type: "run.child_created",
          payload: {
            childRunId: input.id,
            ...(triggeredByAction ? { triggeredByAction } : {}),
            ...(input.sourceProposalId ? { sourceProposalId: input.sourceProposalId } : {}),
            ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {})
          },
          visibility: "audit",
          importance: "normal",
          message: `Created child run ${input.id}.`,
          createdAt
        });
      }
      return {
        run: {
          id: input.id,
          eventId: event.id,
          status: "queued",
          ...(durableThread ? { thread: durableThread } : {}),
          ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
          ...(triggeredByAction ? { triggeredByAction } : {}),
          ...(input.sourceProposalId ? { sourceProposalId: input.sourceProposalId } : {}),
          ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {}),
          contextPacket: protocolFields.contextPacket,
          ...(accessProfileSnapshot ? { accessProfileSnapshot } : {}),
          ...(policySnapshotProvenance ? { policySnapshotProvenance } : {}),
          createdAt,
          updatedAt: createdAt
        },
        created: true
      };
    },

    async pruneSourceDeliveries(input: { olderThan: string; limit?: number }): Promise<SourceDeliveryPruneResult> {
      const cutoff = new Date(input.olderThan);
      if (!Number.isFinite(cutoff.getTime())) {
        throw new Error("olderThan must be a valid timestamp.");
      }
      const requestedLimit = input.limit ?? 1_000;
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 1_000;
      const rows = await db
        .select()
        .from(sourceDeliveries)
        .where(lt(sourceDeliveries.createdAt, cutoff.toISOString()))
        .orderBy(asc(sourceDeliveries.createdAt))
        .limit(limit);

      let pruned = 0;
      let retainedActive = 0;
      for (const row of rows) {
        const runRow = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, row.runId)).limit(1).get();
        if (runRow && !terminalRunStatus(runRow.status)) {
          retainedActive += 1;
          continue;
        }
        const result = await db
          .delete(sourceDeliveries)
          .where(and(eq(sourceDeliveries.source, row.source), eq(sourceDeliveries.deliveryId, row.deliveryId)));
        pruned += result.changes;
      }

      return {
        scanned: rows.length,
        pruned,
        retainedActive
      };
    },

    async claimNextRun(input: { runnerId: string; leaseSeconds: number }): Promise<ClaimedOpenTagRun | null> {
      const now = new Date();
      const runnerHeartbeatAt = nowIso();
      const activeRows = await db
        .select()
        .from(runs)
        .where(inArray(runs.status, ["assigned", "running", "needs_approval"]))
        .orderBy(asc(runs.createdAt));
      for (const activeRow of activeRows) {
        if (!isIsoExpired(activeRow.leaseExpiresAt, now)) continue;
        const updatedAt = nowIso();
        const interrupted = db.transaction((tx) => {
          const current = tx.select().from(runs).where(eq(runs.id, activeRow.id)).limit(1).get();
          if (!current || !isIsoExpired(current.leaseExpiresAt, now) || !["assigned", "running", "needs_approval"].includes(current.status)) {
            return false;
          }
          if (current.currentAttemptId) {
            tx.update(attempts)
              .set({
                status: "interrupted",
                finishedAt: updatedAt,
                resultJson: JSON.stringify({ conclusion: "interrupted", summary: "Attempt lease expired." }),
                updatedAt
              })
              .where(and(eq(attempts.id, current.currentAttemptId), inArray(attempts.status, ["assigned", "running"])))
              .run();
            tx.update(materialActions)
              .set({ status: "unknown", updatedAt })
              .where(and(eq(materialActions.attemptId, current.currentAttemptId), eq(materialActions.status, "executing")))
              .run();
            tx.update(materialActions)
              .set({ status: "cancelled", updatedAt })
              .where(and(eq(materialActions.attemptId, current.currentAttemptId), eq(materialActions.status, "waiting_approval")))
              .run();
          }
          tx.update(runs)
            .set({
              status: "queued",
              assignedRunnerId: null,
              leasedAt: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              currentAttemptId: null,
              updatedAt
            })
            .where(eq(runs.id, current.id))
            .run();
          tx.insert(runEvents)
            .values(
              runEventValues({
                runId: current.id,
                type: "run.lease_expired",
                payload: {
                  previousRunnerId: current.assignedRunnerId,
                  previousAttemptId: current.currentAttemptId,
                  previousLeaseExpiresAt: current.leaseExpiresAt
                },
                visibility: "audit",
                importance: "normal",
                createdAt: updatedAt
              })
            )
            .run();
          return true;
        });
        if (!interrupted) continue;
      }

      const queuedRows = await db.select().from(runs).where(eq(runs.status, "queued")).orderBy(asc(runs.createdAt));
      let row: typeof runs.$inferSelect | undefined;
      for (const candidate of queuedRows) {
        const accessProfile = candidate.accessProfileSnapshotJson
          ? AgentAccessProfileSnapshotSchema.parse(JSON.parse(candidate.accessProfileSnapshotJson))
          : undefined;
        if (
          accessProfile?.constraints.allowedRunnerIds?.length
          && !accessProfile.constraints.allowedRunnerIds.includes(input.runnerId)
        ) {
          continue;
        }
        const accessBlockedReason = accessProfile?.revokedAt && Date.parse(accessProfile.revokedAt) <= now.getTime()
          ? "The captured agent access profile was revoked before a new attempt could start."
          : accessProfile?.expiresAt && Date.parse(accessProfile.expiresAt) <= now.getTime()
            ? "The captured agent access profile expired before a new attempt could start."
            : null;
        if (accessBlockedReason) {
          const blockedAt = now.toISOString();
          db.transaction((tx) => {
            const current = tx.select().from(runs).where(eq(runs.id, candidate.id)).limit(1).get();
            if (!current || current.status !== "queued") return;
            tx.update(runs).set({ status: "needs_approval", updatedAt: blockedAt }).where(eq(runs.id, current.id)).run();
            const dedupeKey = `access-profile:${accessProfile!.id}:inactive:v1`;
            const escalationId = `escalation_${createHash("sha256")
              .update(`${current.id}\0${dedupeKey}`)
              .digest("hex")
              .slice(0, 24)}`;
            if (current.workThreadId) {
              const escalation = HumanEscalationSchema.parse({
                id: escalationId,
                workThreadId: current.workThreadId,
                runId: current.id,
                class: "security",
                audience: "operator",
                subjectRef: accessProfile!.id,
                state: "open",
                blocking: true,
                summary: "Run access is no longer valid.",
                reason: accessBlockedReason,
                nextAction: { kind: "request_human_decision", targetId: accessProfile!.id },
                dedupeKey,
                openedAt: blockedAt
              });
              tx.insert(humanEscalations).values({
                id: escalation.id,
                workThreadId: escalation.workThreadId,
                class: escalation.class,
                state: escalation.state,
                dedupeKey,
                activeDedupeKey: `${current.id}:${dedupeKey}`,
                escalationJson: JSON.stringify(escalation),
                createdAt: blockedAt,
                updatedAt: blockedAt
              }).onConflictDoNothing({ target: humanEscalations.id }).run();
              tx.insert(governanceEvents).values({
                workThreadId: current.workThreadId,
                type: "human_escalation.opened",
                subjectId: escalation.id,
                payloadJson: JSON.stringify({ class: escalation.class, blocking: true, dedupeKey, source: "access_profile" }),
                createdAt: blockedAt
              }).run();
            }
            tx.insert(runEvents).values(runEventValues({
              runId: current.id,
              type: "agent_access_profile.blocked",
              payload: {
                accessProfileSnapshotId: accessProfile!.id,
                reason: accessBlockedReason,
                ...(current.workThreadId
                  ? { humanEscalationId: escalationId }
                  : { humanResolutionUnavailableReason: "The run has no durable WorkThread for resolution." })
              },
              visibility: "audit",
              importance: "blocking",
              message: accessBlockedReason,
              createdAt: blockedAt
            })).run();
          });
          continue;
        }
        const event = OpenTagEventSchema.parse(JSON.parse(candidate.eventJson));
        const repoKey = projectTargetRefFromEvent(event);
        if (!repoKey) {
          if (db.select().from(runners).where(eq(runners.runnerId, input.runnerId)).limit(1).get()) {
            row = candidate;
            break;
          }
          continue;
        }
        const binding = db
          .select()
          .from(repoBindings)
          .where(
            and(
              eq(repoBindings.provider, repoKey.provider),
              eq(repoBindings.owner, repoKey.owner),
              eq(repoBindings.repo, repoKey.repo),
              eq(repoBindings.runnerId, input.runnerId)
            )
          )
          .limit(1)
          .get();
        if (binding) {
          row = candidate;
          break;
        }
      }
      if (!row) {
        await db.update(runners).set({ heartbeatAt: runnerHeartbeatAt }).where(eq(runners.runnerId, input.runnerId));
        return null;
      }

      const updatedAt = nowIso();
      const leasedAt = updatedAt;
      const leaseExpiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
      const attemptId = newAttemptId();
      const fencingToken = newFencingToken();
      const attemptNumber = db.transaction((tx) => {
        const previous = tx
          .select({ number: attempts.number })
          .from(attempts)
          .where(eq(attempts.runId, row.id))
          .orderBy(desc(attempts.number))
          .limit(1)
          .get();
        const number = (previous?.number ?? 0) + 1;
        const updateResult = tx
          .update(runs)
          .set({
            status: "assigned",
            assignedRunnerId: input.runnerId,
            leasedAt,
            leaseExpiresAt,
            heartbeatAt: leasedAt,
            currentAttemptId: attemptId,
            updatedAt
          })
          .where(and(eq(runs.id, row.id), eq(runs.status, "queued")))
          .run();
        if (updateResult.changes === 0) return null;
        tx.insert(attempts)
          .values({
            id: attemptId,
            runId: row.id,
            number,
            runnerId: input.runnerId,
            fencingToken,
            status: "assigned",
            startedAt: leasedAt,
            heartbeatAt: leasedAt,
            leaseExpiresAt,
            createdAt: leasedAt,
            updatedAt
          })
          .run();
        tx.update(runners).set({ heartbeatAt: runnerHeartbeatAt }).where(eq(runners.runnerId, input.runnerId)).run();
        tx.insert(runEvents)
          .values(
            runEventValues({
              runId: row.id,
              type: "run.claimed",
              payload: { runnerId: input.runnerId, attemptId, attemptNumber: number, leasedAt, leaseExpiresAt },
              visibility: "audit",
              importance: "normal",
              createdAt: updatedAt
            })
          )
          .run();
        return number;
      });
      if (attemptNumber === null) return null;

      return {
        run: {
          ...runFromRow({
            ...row,
            status: "assigned",
            assignedRunnerId: input.runnerId,
            updatedAt
          }),
          status: "assigned",
          assignedRunnerId: input.runnerId,
          updatedAt
        },
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson)),
        attemptId,
        attemptNumber,
        fencingToken
      };
    },

    async getRepoBinding(input: { provider: string; owner: string; repo: string }): Promise<RepoBinding | null> {
      const row = await db
        .select()
        .from(repoBindings)
        .where(
          and(eq(repoBindings.provider, input.provider), eq(repoBindings.owner, input.owner), eq(repoBindings.repo, input.repo))
        )
        .limit(1)
        .get();
      if (!row) return null;
      return {
        provider: row.provider,
        owner: row.owner,
        repo: row.repo,
        runnerId: row.runnerId,
        ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
        ...(row.defaultExecutor ? { defaultExecutor: row.defaultExecutor } : {}),
        ...(row.allowedActorsJson ? { allowedActors: JSON.parse(row.allowedActorsJson) as string[] } : {})
      };
    },

    async getChannelBinding(input: {
      provider: string;
      accountId: string;
      conversationId: string;
    }): Promise<ChannelBinding | null> {
      const row = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.provider, input.provider),
            eq(channelBindings.accountId, input.accountId),
            eq(channelBindings.conversationId, input.conversationId)
          )
        )
        .limit(1)
        .get();
      return row ? channelBindingFromRow(row) : null;
    },

    async getSlackChannelBinding(input: { teamId: string; channelId: string }): Promise<SlackChannelBinding | null> {
      const row = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.provider, "slack"),
            eq(channelBindings.accountId, input.teamId),
            eq(channelBindings.conversationId, input.channelId)
          )
        )
        .limit(1)
        .get();
      if (!row) return null;
      const binding = channelBindingFromRow(row);
      if (!binding.repoProvider || !binding.owner || !binding.repo) return null;
      return {
        teamId: binding.accountId,
        channelId: binding.conversationId,
        repoProvider: binding.repoProvider,
        owner: binding.owner,
        repo: binding.repo
      };
    },

    async heartbeat(input: AttemptLease & { leaseSeconds?: number }): Promise<HeartbeatOutcome> {
      const updatedAt = nowIso();
      const lease = activeAttemptLease(input);
      if (lease.outcome !== "active") return lease.outcome;
      const leaseSeconds = input.leaseSeconds ?? 60;
      const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      const updated = db.transaction((tx) => {
        const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        if (
          !currentRun ||
          !currentAttempt ||
          currentRun.assignedRunnerId !== input.runnerId ||
          currentRun.currentAttemptId !== input.attemptId ||
          !["assigned", "running", "needs_approval"].includes(currentRun.status) ||
          currentAttempt.runId !== input.runId ||
          currentAttempt.runnerId !== input.runnerId ||
          currentAttempt.fencingToken !== input.fencingToken ||
          (currentAttempt.status !== "assigned" && currentAttempt.status !== "running") ||
          !hasActiveAttemptLease(currentAttempt)
        ) {
          return false;
        }
        tx.update(attempts)
          .set({ heartbeatAt: updatedAt, leaseExpiresAt, updatedAt })
          .where(eq(attempts.id, input.attemptId))
          .run();
        tx.update(runs)
          .set({ heartbeatAt: updatedAt, leaseExpiresAt, updatedAt })
          .where(eq(runs.id, input.runId))
          .run();
        tx.update(runners).set({ heartbeatAt: updatedAt }).where(eq(runners.runnerId, input.runnerId)).run();
        return true;
      });
      if (!updated) return "stale_attempt";
      await appendRunEvent({
        runId: input.runId,
        type: "run.heartbeat",
        payload: { runnerId: input.runnerId, attemptId: input.attemptId, heartbeatAt: updatedAt, leaseExpiresAt },
        visibility: "debug",
        importance: "low",
        createdAt: updatedAt
      });
      return "updated";
    },

    async markRunning(input: {
      runId: string;
      executor: string;
      runnerId?: string;
      attemptId?: string;
      fencingToken?: string;
      executorCapability?: unknown;
      runTimeoutMs?: number;
      idempotencyKey?: string;
    }): Promise<MarkRunningOutcome> {
      const updatedAt = nowIso();
      const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
      const conditions = [eq(runs.id, input.runId)];
      if (input.runnerId) {
        if (!input.attemptId || !input.fencingToken) return "stale_attempt";
        const lease = activeAttemptLease({
          runId: input.runId,
          runnerId: input.runnerId,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken
        });
        if (lease.outcome !== "active") return lease.outcome;
        conditions.push(eq(runs.assignedRunnerId, input.runnerId));
        conditions.push(eq(runs.currentAttemptId, input.attemptId));
      }
      if (safeInput.idempotencyKey) {
        const existing = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(desc(runEvents.id)).limit(250);
        for (const event of existing) {
          if (event.type !== "run.running") continue;
          const payload = recordFromJson(event.payloadJson);
          if (payload?.["idempotencyKey"] === safeInput.idempotencyKey) return "duplicate";
        }
      }
      const mutationOutcome =
        input.runnerId && input.attemptId && input.fencingToken
          ? db.transaction((tx) => {
              const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
              const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId!)).limit(1).get();
              if (
                !currentRun ||
                !currentAttempt ||
                currentRun.assignedRunnerId !== input.runnerId ||
                currentRun.currentAttemptId !== input.attemptId ||
                (currentRun.status !== "assigned" && currentRun.status !== "running") ||
                currentAttempt.runId !== input.runId ||
                currentAttempt.runnerId !== input.runnerId ||
                currentAttempt.fencingToken !== input.fencingToken ||
                (currentAttempt.status !== "assigned" && currentAttempt.status !== "running") ||
                !hasActiveAttemptLease(currentAttempt)
              ) {
                return "stale_attempt" as const;
              }
              tx.update(runs)
                .set({ status: "running", executor: safeInput.executor, updatedAt })
                .where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId!)))
                .run();
              tx.update(attempts)
                .set({ status: "running", heartbeatAt: updatedAt, updatedAt })
                .where(eq(attempts.id, input.attemptId!))
                .run();
              return "running" as const;
            })
          : (await db
              .update(runs)
              .set({ status: "running", executor: safeInput.executor, updatedAt })
              .where(and(...conditions))).changes > 0
            ? ("running" as const)
            : ("not_found" as const);
      if (mutationOutcome !== "running") return mutationOutcome;
      await appendRunEvent({
        runId: input.runId,
        type: "run.running",
        payload: {
          ...(safeInput.runnerId ? { runnerId: safeInput.runnerId } : {}),
          ...(safeInput.attemptId ? { attemptId: safeInput.attemptId } : {}),
          ...(safeInput.idempotencyKey ? { idempotencyKey: safeInput.idempotencyKey } : {}),
          executor: safeInput.executor,
          ...(safeInput.runTimeoutMs ? { runTimeoutMs: safeInput.runTimeoutMs } : {})
        },
        visibility: "audit",
        importance: "normal",
        createdAt: updatedAt
      });
      if (safeInput.executorCapability) {
        await appendRunEvent({
          runId: input.runId,
          type: "executor.capability.snapshot",
          payload: {
            executor: safeInput.executor,
            capability: safeInput.executorCapability
          },
          visibility: "audit",
          importance: "normal",
          message: `Executor capability snapshot recorded for ${safeInput.executor}.`,
          createdAt: updatedAt
        });
      }
      return "running";
    },

    async completeRun(input: {
      runId: string;
      result: OpenTagRunResult;
      humanEscalation?: HumanEscalation;
      runnerId?: string;
      attemptId?: string;
      fencingToken?: string;
      idempotencyKey?: string;
    }): Promise<CompleteRunOutcome> {
      const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
      const safeIdempotencyKey = safeInput.idempotencyKey;
      const parsedResult = OpenTagRunResultSchema.parse(safeInput.result);
      const humanEscalation = input.humanEscalation
        ? HumanEscalationSchema.parse(input.humanEscalation)
        : undefined;
      const hasHumanEscalationFields = Boolean(
        parsedResult.humanEscalation
        || parsedResult.humanEscalationId
        || parsedResult.humanResolutionUnavailableReason
      );
      if (parsedResult.conclusion !== "needs_human" && hasHumanEscalationFields) {
        throw new Error("Human escalation fields are only valid for a needs_human result.");
      }
      if (parsedResult.humanEscalationId && parsedResult.humanResolutionUnavailableReason) {
        throw new Error("A needs_human result cannot both link an escalation and report human resolution unavailable.");
      }
      const updatedAt = nowIso();
      const result = OpenTagRunResultSchema.parse({
        ...parsedResult,
        ...(parsedResult.conclusion === "needs_human"
          && !humanEscalation
          && !parsedResult.humanEscalationId
          && !parsedResult.humanResolutionUnavailableReason
          ? {
              humanResolutionUnavailableReason:
                "No durable HumanEscalation was supplied at this persistence boundary."
            }
          : {}),
        ...(parsedResult.artifacts?.length
          ? {
              artifacts: parsedResult.artifacts.map((artifact, index) => ({
                ...artifact,
                id: artifact.id ?? `${input.runId}:artifact:${index + 1}`,
                sourceRunId: artifact.sourceRunId ?? input.runId,
                createdAt: artifact.createdAt ?? updatedAt
              }))
            }
          : {})
      });
      const status =
        result.conclusion === "success"
          ? "succeeded"
          : result.conclusion === "cancelled"
            ? "cancelled"
            : result.conclusion === "interrupted"
              ? "interrupted"
              : result.conclusion === "timed_out"
                ? "timed_out"
                : result.conclusion === "needs_human"
                  ? "needs_approval"
                  : "failed";
      const runRow = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (!runRow) {
        if (input.runnerId) return "not_found";
        throw new Error(`Run not found: ${input.runId}`);
      }
      if (humanEscalation) {
        if (result.conclusion !== "needs_human") {
          throw new Error("A HumanEscalation may only be attached to a needs_human result.");
        }
        if (
          humanEscalation.runId !== input.runId
          || humanEscalation.workThreadId !== runRow.workThreadId
          || result.humanEscalationId !== humanEscalation.id
        ) {
          throw new Error("A needs_human result must point to its attached HumanEscalation in the same run and WorkThread.");
        }
      }
      if (input.runnerId) {
        if (!input.attemptId || !input.fencingToken) return "stale_attempt";
        const lease = activeAttemptLease({
          runId: input.runId,
          runnerId: input.runnerId,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken
        });
        if (lease.outcome !== "active") {
          const completedAttempt = await db.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
          const duplicateTerminalAttempt =
            completedAttempt?.runId === input.runId &&
            completedAttempt.runnerId === input.runnerId &&
            completedAttempt.fencingToken === input.fencingToken &&
            releasedTerminalAttemptMatchesRun(completedAttempt, runRow);
          if (duplicateTerminalAttempt && status === runRow.status) return "duplicate";
          if (duplicateTerminalAttempt && safeIdempotencyKey) {
            const existing = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(desc(runEvents.id)).limit(250);
            for (const event of existing) {
              if (event.type !== "run.completed") continue;
              const payload = recordFromJson(event.payloadJson);
              if (payload?.["idempotencyKey"] === safeIdempotencyKey) return "duplicate";
            }
          }
          return lease.outcome;
        }
      }
      if (safeIdempotencyKey) {
        const existing = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(desc(runEvents.id)).limit(250);
        for (const event of existing) {
          if (event.type !== "run.completed") continue;
          const payload = recordFromJson(event.payloadJson);
          if (payload?.["idempotencyKey"] === safeIdempotencyKey) return "duplicate";
        }
      }
      if (terminalRunStatus(runRow.status)) {
        return input.runnerId ? "duplicate" : "not_found";
      }
      const runThread = runRow ? protocolRunFieldsFromEvent(OpenTagEventSchema.parse(JSON.parse(runRow.eventJson)), runRow.createdAt).thread : undefined;
      const attemptId = input.attemptId ?? runRow.currentAttemptId ?? undefined;
      const attemptStatus =
        result.conclusion === "success"
          ? "succeeded"
          : result.conclusion === "cancelled"
            ? "cancelled"
            : result.conclusion === "interrupted"
              ? "interrupted"
              : result.conclusion === "timed_out"
                ? "timed_out"
                : result.conclusion === "needs_human"
                  ? "needs_human"
                  : "failed";
      const parsedSnapshots = (result.suggestedChanges ?? []).map((snapshot) =>
        SuggestedChangesSnapshotSchema.parse({
          ...snapshot,
          sourceRunId: snapshot.sourceRunId ?? input.runId,
          ...(snapshot.workThread || !runThread ? {} : { workThread: runThread })
        })
      );
      const completionEventsForResult = (completedResult: OpenTagRunResult): Array<typeof runEvents.$inferInsert> => [
        ...parsedSnapshots.map((snapshot) =>
          runEventValues({
            runId: input.runId,
            type: "proposal.snapshot.created",
            payload: snapshot,
            visibility: "audit",
            importance: "high",
            message: snapshot.summary,
            createdAt: updatedAt
          })
        ),
        ...(completedResult.artifacts ?? []).map((artifact) =>
          runEventValues({
            runId: input.runId,
            type: "artifact.created",
            payload: artifact,
            visibility: "audit",
            importance: "normal",
            message: artifact.summary ?? artifact.title,
            createdAt: updatedAt
          })
        ),
        runEventValues({
          runId: input.runId,
          type: "run.completed",
          payload: {
            ...completedResult,
            ...(attemptId ? { attemptId } : {}),
            ...(safeIdempotencyKey ? { idempotencyKey: safeIdempotencyKey } : {})
          },
          visibility: "audit",
          importance: "high",
          message: completedResult.summary,
          createdAt: updatedAt
        }),
        ...((completedResult.suggestedChanges?.length ?? 0) > 0 || (completedResult.artifacts?.length ?? 0) > 0
          ? [
              runEventValues({
                runId: input.runId,
                type: "success_metric.observed",
                payload: {
                  metric: "time_to_first_useful_artifact",
                  artifactCount: completedResult.artifacts?.length ?? 0,
                  suggestedChangesCount: completedResult.suggestedChanges?.length ?? 0
                },
                visibility: "audit",
                importance: "normal",
                createdAt: updatedAt
              })
            ]
          : [])
      ];
      const completionOutcome = db.transaction((tx) => {
        const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        if (!currentRun) return input.runnerId ? ("not_found" as const) : ("not_found" as const);
        let currentAttempt: typeof attempts.$inferSelect | undefined;
        if (input.runnerId && input.attemptId && input.fencingToken) {
          currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
          if (
            !currentAttempt ||
            currentAttempt.runId !== input.runId ||
            currentAttempt.runnerId !== input.runnerId ||
            currentAttempt.fencingToken !== input.fencingToken
          ) {
            return "stale_attempt" as const;
          }
          if (releasedTerminalAttemptMatchesRun(currentAttempt, currentRun)) {
            return status === currentRun.status ? ("duplicate" as const) : ("stale_attempt" as const);
          }
          if (currentAttempt.status !== "assigned" && currentAttempt.status !== "running") {
            return "stale_attempt" as const;
          }
          if (!hasActiveAttemptLease(currentAttempt)) return "stale_attempt" as const;
          if (currentRun.currentAttemptId !== input.attemptId || currentRun.assignedRunnerId !== input.runnerId) {
            return "stale_attempt" as const;
          }
          if (currentRun.status !== "assigned" && currentRun.status !== "running") return "stale_attempt" as const;
        } else if (terminalRunStatus(currentRun.status)) {
          return "not_found" as const;
        }
        let completedResult = result;
        if (humanEscalation) {
          const activeDedupeKey = humanEscalation.dedupeKey
            ? `${humanEscalation.runId ?? "thread"}:${humanEscalation.dedupeKey}`
            : null;
          const inserted = tx.insert(humanEscalations).values({
            id: humanEscalation.id,
            workThreadId: humanEscalation.workThreadId,
            class: humanEscalation.class,
            state: humanEscalation.state,
            dedupeKey: humanEscalation.dedupeKey ?? null,
            activeDedupeKey,
            escalationJson: JSON.stringify(humanEscalation),
            createdAt: humanEscalation.openedAt,
            updatedAt: humanEscalation.openedAt
          }).onConflictDoNothing().run();
          let effectiveEscalation = humanEscalation;
          if (inserted.changes === 1) {
            tx.insert(governanceEvents).values({
              workThreadId: humanEscalation.workThreadId,
              type: "human_escalation.opened",
              subjectId: humanEscalation.id,
              payloadJson: JSON.stringify({
                class: humanEscalation.class,
                blocking: humanEscalation.blocking,
                dedupeKey: humanEscalation.dedupeKey ?? null,
                source: "run_result"
              }),
              createdAt: humanEscalation.openedAt
            }).run();
          } else {
            const existingById = tx.select().from(humanEscalations)
              .where(eq(humanEscalations.id, humanEscalation.id)).limit(1).get();
            const existingByDedupe = activeDedupeKey
              ? tx.select().from(humanEscalations).where(and(
                  eq(humanEscalations.workThreadId, humanEscalation.workThreadId),
                  eq(humanEscalations.activeDedupeKey, activeDedupeKey)
                )).limit(1).get()
              : undefined;
            const existing = existingById ?? existingByDedupe;
            if (!existing) {
              throw new Error("A conflicting HumanEscalation could not be correlated to the run result.");
            }
            effectiveEscalation = humanEscalationFromRow(existing);
            if (
              effectiveEscalation.workThreadId !== humanEscalation.workThreadId
              || effectiveEscalation.runId !== humanEscalation.runId
              || effectiveEscalation.dedupeKey !== humanEscalation.dedupeKey
            ) {
              throw new Error("A conflicting HumanEscalation does not match the run result identity.");
            }
          }
          completedResult = OpenTagRunResultSchema.parse({
            ...result,
            humanEscalationId: effectiveEscalation.id
          });
        }
        tx.update(runs)
          .set({
            status,
            resultJson: JSON.stringify(completedResult),
            assignedRunnerId: null,
            leasedAt: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            currentAttemptId: null,
            updatedAt
          })
          .where(eq(runs.id, input.runId))
          .run();
        if (attemptId) {
          tx.update(materialActions)
            .set({ status: "unknown", updatedAt })
            .where(and(eq(materialActions.attemptId, attemptId), eq(materialActions.status, "executing")))
            .run();
          tx.update(attempts)
            .set({ status: attemptStatus, finishedAt: updatedAt, resultJson: JSON.stringify(completedResult), updatedAt })
            .where(eq(attempts.id, attemptId))
            .run();
        }
        for (const snapshot of parsedSnapshots) {
          tx.insert(suggestedChanges)
            .values({
              proposalId: snapshot.proposalId,
              runId: input.runId,
              snapshotJson: JSON.stringify(snapshot),
              createdAt: snapshot.createdAt
            })
            .onConflictDoUpdate({
              target: suggestedChanges.proposalId,
              set: {
                runId: input.runId,
                snapshotJson: JSON.stringify(snapshot),
                createdAt: snapshot.createdAt
              }
            })
            .run();
        }
        for (const event of completionEventsForResult(completedResult)) {
          tx.insert(runEvents).values(event).run();
        }
        return "completed" as const;
      });
      if (completionOutcome !== "completed") return completionOutcome;
      return "completed";
    },

    async requestActionPermission(input: {
      runnerId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
      request: ActionPermissionRequest;
    }): Promise<ActionPermissionResolution | null> {
      const request = ActionPermissionRequestSchema.parse(input.request);
      if (activeAttemptLease(input).outcome !== "active") return null;

      const normalized = normalizeMaterialActionRequest({
        title: request.title,
        ...(request.kind ? { kind: request.kind } : {}),
        permissionScopes: request.permissionScopes,
        provider: request.provider,
        connectionId: request.connectionId,
        operation: request.operation,
        ...(request.resource ? { resource: request.resource } : {}),
        ...(request.resourceVersion ? { resourceVersion: request.resourceVersion } : {}),
        ...(request.targetFingerprint ? { targetFingerprint: request.targetFingerprint } : {}),
        ...(request.targetConstraints ? { targetConstraints: request.targetConstraints } : {}),
        ...(request.grantScope ? { grantScope: request.grantScope } : {})
      });
      const reusableIdentity = actionScopeAllowsRunReuse(normalized.scope);
      const semanticKey = reusableIdentity
        ? stableActionJson({
            runId: input.runId,
            actionFamily: normalized.actionFamily,
            scope: normalized.scope,
            target: normalized.target
          })
        : stableActionJson({
            runId: input.runId,
            attemptId: input.attemptId,
            opaqueToolCallId: createHmac("sha256", input.fencingToken).update(request.toolCallId).digest("hex"),
            actionFamily: normalized.actionFamily,
            provider: normalized.scope["provider"],
            connectionId: normalized.scope["connectionId"],
            operation: normalized.scope["operation"]
          });
      const idempotencyKey = `action:${sha256(semanticKey)}`;
      const actionId = `action_${sha256(stableActionJson({ semanticKey, attemptId: input.attemptId })).slice(0, 24)}`;
      const candidateProposalHash = reusableIdentity
        ? sha256(stableActionJson({ actionId, normalized }))
        : sha256(stableActionJson({ actionId, semanticKey, reuse: "deny" }));
      const hasSameExactAction = (row: typeof materialActions.$inferSelect): boolean => stableActionJson({
        scope: JSON.parse(row.scopeJson) as unknown,
        target: JSON.parse(row.targetJson) as unknown
      }) === stableActionJson({ scope: normalized.scope, target: normalized.target });
      const currentOwnedAuthorizedAction = (currentActionId: string): ReturnType<typeof actionFromRow> | undefined =>
        db.transaction((tx) => {
          const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
          const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
          const currentAction = tx.select().from(materialActions).where(eq(materialActions.id, currentActionId)).limit(1).get();
          if (
            !currentAttempt || !currentRun || !currentAction || currentAttempt.runnerId !== input.runnerId ||
            currentAttempt.fencingToken !== input.fencingToken || !["assigned", "running"].includes(currentAttempt.status) ||
            !hasActiveAttemptLease(currentAttempt) ||
            currentRun.currentAttemptId !== input.attemptId || currentRun.assignedRunnerId !== input.runnerId ||
            currentAction.status !== "authorized" || currentAction.attemptId !== input.attemptId ||
            currentAction.attemptFenceDigest !== sha256(input.fencingToken)
          ) return undefined;
          return actionFromRow(currentAction);
        });
      const failClosedOnTargetDrift = (row: typeof materialActions.$inferSelect): ActionPermissionResolution | null => db.transaction((tx) => {
        const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const currentAction = tx.select().from(materialActions).where(eq(materialActions.id, row.id)).limit(1).get();
        if (
          !currentAttempt || !currentRun || !currentAction || currentAttempt.runnerId !== input.runnerId ||
          currentAttempt.fencingToken !== input.fencingToken || !["assigned", "running"].includes(currentAttempt.status) ||
          !hasActiveAttemptLease(currentAttempt) ||
          currentRun.currentAttemptId !== input.attemptId || currentRun.assignedRunnerId !== input.runnerId
        ) return null;
        const reason = "The opaque ACP request identity was replayed with a different exact target. The prior approval was not reused.";
        if (currentAction.status === "executing") {
          tx.update(materialActions)
            .set({ status: "unknown", updatedAt: nowIso() })
            .where(and(eq(materialActions.id, currentAction.id), eq(materialActions.status, "executing")))
            .run();
          const unknown = tx.select().from(materialActions).where(eq(materialActions.id, currentAction.id)).limit(1).get();
          return { state: "unknown", action: actionFromRow(unknown!), reason };
        }
        if (currentAction.status === "succeeded" || currentAction.status === "unknown") {
          return { state: "unknown", action: actionFromRow(currentAction), reason };
        }
        if (["proposed", "waiting_approval", "authorized"].includes(currentAction.status)) {
          const updatedAt = nowIso();
          tx.update(materialActions)
            .set({ status: "cancelled", updatedAt })
            .where(and(eq(materialActions.id, currentAction.id), inArray(materialActions.status, ["proposed", "waiting_approval", "authorized"])))
            .run();
          tx.update(runs)
            .set({ status: "running", updatedAt })
            .where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId), eq(runs.assignedRunnerId, input.runnerId)))
            .run();
          const cancelled = tx.select().from(materialActions).where(eq(materialActions.id, currentAction.id)).limit(1).get();
          return { state: "denied", action: actionFromRow(cancelled!), decision: "deny", reason };
        }
        return { state: "denied", action: actionFromRow(currentAction), decision: "deny", reason };
      });
      const existing = await latestMaterialActionForSemanticKey({ runId: input.runId, idempotencyKey });
      if (existing) {
        if (activeAttemptLease(input).outcome !== "active") return null;
        if (!reusableIdentity && !hasSameExactAction(existing)) return failClosedOnTargetDrift(existing);
        const action = actionFromRow(existing);
        if (action.status === "succeeded" && action.receipt) {
          return ActionPermissionResolutionSchema.parse({ state: "reconciled", action, decision: "deny", receipt: action.receipt, reason: "Known success reused; the ACP tool must not execute again." });
        }
        if (action.status === "unknown") {
          return ActionPermissionResolutionSchema.parse({ state: "unknown", action, reason: "The provider outcome is unknown and requires human reconciliation." });
        }
        if (action.status === "failed") {
          return ActionPermissionResolutionSchema.parse({ state: "denied", action, decision: "deny", reason: "Known failure is not automatically retried without a new policy decision." });
        }
        if (action.status === "authorized" || action.status === "executing") {
          const sameOwner = action.attemptId === input.attemptId && action.attemptFenceDigest === sha256(input.fencingToken);
          if (sameOwner && action.status === "authorized" && !normalized.material) {
            const current = currentOwnedAuthorizedAction(action.id);
            return current
              ? { state: "authorized", action: current, decision: "allow_once", reason: "Non-material Auto action does not require receipt tracking." }
              : null;
          }
          if (sameOwner && action.status === "authorized") {
            return this.resolveActionPermission({
              runnerId: input.runnerId,
              runId: input.runId,
              attemptId: input.attemptId,
              fencingToken: input.fencingToken,
              actionId: action.id
            });
          }
          const unknown = db.transaction((tx) => {
            const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
            const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
            if (
              !currentAttempt || !currentRun || currentAttempt.runnerId !== input.runnerId ||
              currentAttempt.fencingToken !== input.fencingToken || !["assigned", "running"].includes(currentAttempt.status) ||
              !hasActiveAttemptLease(currentAttempt) ||
              currentRun.currentAttemptId !== input.attemptId || currentRun.assignedRunnerId !== input.runnerId
            ) return undefined;
            tx.update(materialActions).set({ status: "unknown", updatedAt: nowIso() }).where(and(eq(materialActions.id, action.id), inArray(materialActions.status, ["authorized", "executing"]))).run();
            return tx.select().from(materialActions).where(eq(materialActions.id, action.id)).limit(1).get();
          });
          return unknown ? { state: "unknown", action: actionFromRow(unknown), reason: "Execution ownership changed or a duplicate arrived before a trusted receipt; reconciliation is required." } : null;
        }
        if (!(action.status === "cancelled" && action.attemptId !== input.attemptId)) {
          return this.resolveActionPermission({
            runnerId: input.runnerId,
            runId: input.runId,
            attemptId: input.attemptId,
            fencingToken: input.fencingToken,
            actionId: action.id
          });
        }
        // An expired approval belongs to its originating Attempt. A replacement
        // Attempt gets a fresh proposal epoch while retaining the provider
        // idempotency key represented by semanticKey.
      }

      let inserted:
        | { kind: "stale" }
        | { kind: "conflict" }
        | { kind: "resolved"; resolution: ActionPermissionResolution };
      try {
        inserted = db.transaction((tx) => {
          const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
          const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
          if (
            !currentAttempt || !currentRun || currentAttempt.runId !== input.runId ||
            currentAttempt.runnerId !== input.runnerId || currentAttempt.fencingToken !== input.fencingToken ||
            !["assigned", "running"].includes(currentAttempt.status) || !hasActiveAttemptLease(currentAttempt) ||
            currentRun.currentAttemptId !== input.attemptId || currentRun.assignedRunnerId !== input.runnerId
          ) return { kind: "stale" as const };
          const storedGrants = tx.select().from(grants).where(eq(grants.runId, input.runId)).all();
          const matches = (row: typeof grants.$inferSelect): boolean => grantMatchesAction({
            runId: row.runId,
            ...(row.attemptId ? { attemptId: row.attemptId } : {}),
            capability: row.capability,
            resourceScope: JSON.parse(row.resourceScopeJson) as Record<string, unknown>,
            ...(row.constraintsJson ? { constraints: JSON.parse(row.constraintsJson) as Record<string, unknown> } : {}),
            ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
            ...(row.revokedAt ? { revokedAt: row.revokedAt } : {})
          }, { runId: input.runId, attemptId: input.attemptId, actionId, proposalHash: candidateProposalHash, action: normalized });
          const matchingGrant = storedGrants.some(matches);
          const policy = evaluateActionPermission({ mode: request.mode, action: normalized, matchingGrant });
          const createdAt = nowIso();
          const proposalId = policy.outcome === "needs_approval" ? `proposal_${actionId}` : undefined;
          const proposalHash = proposalId ? candidateProposalHash : undefined;
          const approvalEpoch = proposalHash
            ? sha256(stableActionJson({ actionId, attemptId: input.attemptId, proposalHash }))
            : undefined;
          const status = policy.outcome === "authorized"
            ? normalized.material ? "executing" : "authorized"
            : policy.outcome === "blocked" ? "cancelled" : "waiting_approval";
          const snapshot = proposalId && proposalHash
            ? SuggestedChangesSnapshotSchema.parse({
                proposalId,
                sourceRunId: input.runId,
                createdAt,
                summary: `Allow ${request.title}`,
                intents: [{
                  intentId: `intent_${actionId}`,
                  domain: "agent_permission",
                  action: normalized.actionFamily,
                  summary: `Allow ${request.title}`,
                  params: {
                    actionId,
                    actionFamily: normalized.actionFamily,
                    scope: normalized.scope,
                    target: normalized.target,
                    riskTier: normalized.riskTier,
                    decisions: actionScopeAllowsRunReuse(normalized.scope) ? ["allow_once", "allow_run", "deny"] : ["allow_once", "deny"]
                  }
                }],
                preconditions: ["The originating Attempt must remain active.", "The normalized action family and scope must not change."],
                metadata: { kind: "acp_permission", actionId, approvalMode: request.mode, proposalHash, approvalEpoch }
              })
            : undefined;
          const result = tx.insert(materialActions).values({
            id: actionId,
            runId: input.runId,
            attemptId: input.attemptId,
            actionFamily: normalized.actionFamily,
            capability: normalized.actionFamily,
            scopeJson: JSON.stringify(normalized.scope),
            targetJson: JSON.stringify(normalized.target),
            riskTier: normalized.riskTier,
            status,
            idempotencyKey,
            proposalId: proposalId ?? null,
            proposalHash: proposalHash ?? null,
            decisionSnapshotHash: policy.outcome === "authorized" ? sha256(stableActionJson({ mode: request.mode, policy })) : null,
            attemptFenceDigest: sha256(input.fencingToken),
            receiptJson: null,
            createdAt,
            updatedAt: createdAt
          }).onConflictDoNothing().run();
          if (result.changes === 0) return { kind: "conflict" as const };
          const activeAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
          const activeRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
          if (
            !activeAttempt || !activeRun || activeAttempt.runnerId !== input.runnerId ||
            activeAttempt.fencingToken !== input.fencingToken || !["assigned", "running"].includes(activeAttempt.status) ||
            !hasActiveAttemptLease(activeAttempt) ||
            activeRun.currentAttemptId !== input.attemptId || activeRun.assignedRunnerId !== input.runnerId
          ) throw new StaleActionTransitionError("Attempt ownership changed during action creation.");
          if (matchingGrant && !tx.select().from(grants).where(eq(grants.runId, input.runId)).all().some(matches)) {
            throw new StaleActionTransitionError("The matching grant changed during action authorization.");
          }
          if (snapshot && proposalId) {
            tx.insert(suggestedChanges).values({ proposalId, runId: input.runId, snapshotJson: JSON.stringify(snapshot), createdAt }).onConflictDoNothing().run();
            const paused = tx.update(runs).set({ status: "needs_approval", updatedAt: createdAt }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId), eq(runs.assignedRunnerId, input.runnerId))).run();
            if (paused.changes !== 1) throw new StaleActionTransitionError("Attempt ownership changed while creating an action proposal.");
            tx.insert(runEvents).values(runEventValues({
              runId: input.runId,
              type: "action.permission.waiting",
              payload: { actionId, proposalId, actionFamily: normalized.actionFamily, scope: normalized.scope, riskTier: normalized.riskTier },
              visibility: "human",
              importance: "high",
              message: snapshot.summary,
              createdAt
            })).run();
          }
          const row = tx.select().from(materialActions).where(eq(materialActions.id, actionId)).limit(1).get();
          if (!row) throw new Error(`Material action ${actionId} was not stored.`);
          const action = actionFromRow(row);
          const resolution: ActionPermissionResolution = policy.outcome === "blocked"
            ? { state: "denied", action, decision: "deny", reason: policy.reason }
            : policy.outcome === "authorized"
              ? { state: "authorized", action, decision: matchingGrant ? "allow_run" : "allow_once", reason: policy.reason }
              : { state: "waiting", action, reason: policy.reason };
          return { kind: "resolved" as const, resolution };
        });
      } catch (error) {
        if (error instanceof StaleActionTransitionError) return null;
        throw error;
      }
      if (inserted.kind === "stale") return null;
      if (inserted.kind === "conflict") {
        const winnerRow = await latestMaterialActionForSemanticKey({ runId: input.runId, idempotencyKey });
        if (!winnerRow || winnerRow.id !== actionId) return null;
        if (activeAttemptLease(input).outcome !== "active") return null;
        if (!reusableIdentity && !hasSameExactAction(winnerRow)) return failClosedOnTargetDrift(winnerRow);
        const winner = actionFromRow(winnerRow);
        if (winner.status === "succeeded" && winner.receipt) {
          return { state: "reconciled", action: winner, decision: "deny", receipt: winner.receipt, reason: "Known success reused; the ACP tool must not execute again." };
        }
        if (winner.status === "unknown") {
          return { state: "unknown", action: winner, reason: "The provider outcome is unknown and requires human reconciliation." };
        }
        if (winner.status === "authorized" && !normalized.material) {
          const current = currentOwnedAuthorizedAction(winner.id);
          return current
            ? { state: "authorized", action: current, decision: "allow_once", reason: "Non-material Auto action does not require receipt tracking." }
            : null;
        }
        if (winner.status === "executing") {
          const unknown = db.transaction((tx) => {
            const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
            const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
            if (
              !currentAttempt || !currentRun || currentAttempt.runnerId !== input.runnerId ||
              currentAttempt.fencingToken !== input.fencingToken || !["assigned", "running"].includes(currentAttempt.status) ||
              !hasActiveAttemptLease(currentAttempt) ||
              currentRun.currentAttemptId !== input.attemptId || currentRun.assignedRunnerId !== input.runnerId
            ) return undefined;
            tx.update(materialActions)
              .set({ status: "unknown", updatedAt: nowIso() })
              .where(and(eq(materialActions.id, winner.id), eq(materialActions.status, "executing")))
              .run();
            return tx.select().from(materialActions).where(eq(materialActions.id, winner.id)).limit(1).get();
          });
          return unknown
            ? { state: "unknown", action: actionFromRow(unknown), reason: "Execution ownership changed or a duplicate arrived before a trusted receipt; reconciliation is required." }
            : null;
        }
        return this.resolveActionPermission({
          runnerId: input.runnerId,
          runId: input.runId,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
          actionId: winner.id
        });
      }
      return inserted.resolution;
    },

    async resolveActionPermission(input: {
      runnerId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
      actionId: string;
    }): Promise<ActionPermissionResolution | null> {
      if (activeAttemptLease(input).outcome !== "active") {
        const staleRow = await db.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
        return staleRow
          ? { state: "stale", action: actionFromRow(staleRow), reason: "The originating Attempt is no longer active." }
          : null;
      }
      try {
        return db.transaction((tx) => {
          const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
          const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
          const row = tx.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
          if (!row) return null;
          const action = actionFromRow(row);
          if (
            !attempt || !run || attempt.runId !== input.runId || attempt.runnerId !== input.runnerId ||
            attempt.fencingToken !== input.fencingToken || run.currentAttemptId !== input.attemptId ||
            run.assignedRunnerId !== input.runnerId || action.attemptFenceDigest !== sha256(input.fencingToken) ||
            !["assigned", "running"].includes(attempt.status) || !hasActiveAttemptLease(attempt)
          ) return { state: "stale" as const, action, reason: "The originating Attempt is no longer active." };
          if (action.status === "succeeded" && action.receipt) return { state: "reconciled" as const, action, decision: "deny" as const, receipt: action.receipt };
          if (action.status === "unknown") return { state: "unknown" as const, action, reason: "The action outcome is unknown." };
          if (action.status === "executing") {
            tx.update(materialActions).set({ status: "unknown", updatedAt: nowIso() }).where(and(eq(materialActions.id, action.id), eq(materialActions.status, "executing"))).run();
            const unknown = tx.select().from(materialActions).where(eq(materialActions.id, action.id)).limit(1).get();
            return { state: "unknown" as const, action: actionFromRow(unknown!), reason: "Execution was already released without a trusted terminal receipt." };
          }
          if (action.status === "authorized") {
            const activeGrants = tx.select().from(grants).where(eq(grants.runId, action.runId)).all();
            const hasRunGrant = activeGrants.some((grant) => {
              const constraints = grant.constraintsJson ? JSON.parse(grant.constraintsJson) as Record<string, unknown> : undefined;
              return constraints?.["permissionDecision"] === "allow_run" && !grant.attemptId && grantMatchesAction({
                runId: grant.runId,
                capability: grant.capability,
                resourceScope: JSON.parse(grant.resourceScopeJson) as Record<string, unknown>,
                ...(constraints ? { constraints } : {}),
                ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
                ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {})
              }, {
                runId: input.runId,
                attemptId: input.attemptId,
                actionId: action.id,
                ...(action.proposalHash ? { proposalHash: action.proposalHash } : {}),
                action: {
                  actionFamily: action.actionFamily,
                  scope: action.scope,
                  target: action.target,
                  riskTier: action.riskTier,
                  material: action.riskTier !== "low",
                  internallyBlocked: false
                }
              });
            });
            const updatedAt = nowIso();
            const released = tx.update(materialActions).set({ status: "executing", updatedAt }).where(and(eq(materialActions.id, action.id), eq(materialActions.status, "authorized"))).run();
            const resumed = tx.update(runs).set({ status: "running", updatedAt }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId), eq(runs.assignedRunnerId, input.runnerId))).run();
            if (released.changes !== 1 || resumed.changes !== 1) throw new StaleActionTransitionError("Attempt ownership changed during action authorization.");
            const executing = tx.select().from(materialActions).where(eq(materialActions.id, action.id)).limit(1).get();
            return { state: "authorized" as const, action: actionFromRow(executing!), decision: hasRunGrant ? "allow_run" as const : "allow_once" as const };
          }
          if (action.status === "cancelled" || action.status === "failed") return { state: "denied" as const, action, decision: "deny" as const };
          if (!action.proposalId) return { state: "denied" as const, action, decision: "deny" as const, reason: "The action has no approval proposal." };
          const decisionRow = tx.select().from(approvalDecisions).where(eq(approvalDecisions.proposalId, action.proposalId)).orderBy(desc(approvalDecisions.createdAt)).limit(1).get();
          if (!decisionRow) return { state: "waiting" as const, action };
          const decision = ApprovalDecisionSchema.parse(JSON.parse(decisionRow.decisionJson));
          const intentId = `intent_${action.id}`;
          const approved = decision.approvedIntentIds.includes(intentId) && !(decision.rejectedIntentIds ?? []).includes(intentId);
          const decisionKind = approved && decision.metadata?.["permissionDecision"] === "allow_run" && actionScopeAllowsRunReuse(action.scope)
            ? "allow_run" as const
            : approved ? "allow_once" as const : "deny" as const;
          const updatedAt = nowIso();
          if (decisionKind === "deny") {
            const cancelled = tx.update(materialActions).set({ status: "cancelled", decisionSnapshotHash: sha256(stableActionJson(decision)), updatedAt }).where(and(eq(materialActions.id, action.id), eq(materialActions.status, "waiting_approval"))).run();
            const resumed = tx.update(runs).set({ status: "running", updatedAt }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId), eq(runs.assignedRunnerId, input.runnerId))).run();
            if (cancelled.changes !== 1 || resumed.changes !== 1) throw new StaleActionTransitionError("Attempt ownership changed during action denial.");
            const updated = tx.select().from(materialActions).where(eq(materialActions.id, action.id)).limit(1).get();
            return { state: "denied" as const, action: actionFromRow(updated!), decision: "deny" as const };
          }
          tx.insert(grants).values({
            id: `grant_${sha256(`${decision.id}:${action.id}:${decisionKind}`).slice(0, 24)}`,
            connectionId: String(action.target["connectionId"]),
            capability: action.actionFamily,
            resourceScopeJson: JSON.stringify(action.scope),
            runId: action.runId,
            attemptId: decisionKind === "allow_once" ? action.attemptId : null,
            expiresAt: null,
            constraintsJson: JSON.stringify({
              permissionDecision: decisionKind,
              decisionId: decision.id,
              actionId: action.id,
              proposalHash: action.proposalHash,
              targetFingerprint: action.target["targetFingerprint"],
              riskTier: action.riskTier
            }),
            revokedAt: null,
            createdAt: updatedAt
          }).onConflictDoNothing().run();
          const released = tx.update(materialActions).set({ status: "executing", decisionSnapshotHash: sha256(stableActionJson(decision)), updatedAt }).where(and(eq(materialActions.id, action.id), eq(materialActions.status, "waiting_approval"))).run();
          const resumed = tx.update(runs).set({ status: "running", updatedAt }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId), eq(runs.assignedRunnerId, input.runnerId))).run();
          if (released.changes !== 1 || resumed.changes !== 1) throw new StaleActionTransitionError("Attempt ownership changed during action authorization.");
          const updated = tx.select().from(materialActions).where(eq(materialActions.id, action.id)).limit(1).get();
          return { state: "authorized" as const, action: actionFromRow(updated!), decision: decisionKind };
        });
      } catch (error) {
        if (!(error instanceof StaleActionTransitionError)) throw error;
        const row = await db.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
        if (!row) return null;
        return { state: "stale", action: actionFromRow(row), reason: error.message };
      }
    },

    async recordMaterialActionReceipt(input: {
      runnerId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
      actionId: string;
      receipt: MaterialActionReceipt;
    }): Promise<ActionPermissionResolution | null> {
      let receipt = sanitizeMaterialActionReceipt(MaterialActionReceiptSchema.parse(input.receipt));
      if (receipt.actionId !== input.actionId) throw new Error("Material action receipt actionId must match the governed action.");
      if (activeAttemptLease(input).outcome !== "active") {
        const staleRow = await db.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
        return staleRow
          ? { state: "stale", action: actionFromRow(staleRow), reason: "The receipt writer does not own the active fenced Attempt." }
          : null;
      }
      const updatedAt = nowIso();
      const outcome = db.transaction((tx) => {
        const actionRow = tx.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
        if (!actionRow) return { kind: "not_found" as const };
        const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        const action = actionFromRow(actionRow);
        if (
          !attempt || !run || attempt.runId !== input.runId || attempt.runnerId !== input.runnerId ||
          attempt.fencingToken !== input.fencingToken || run.currentAttemptId !== input.attemptId ||
          run.assignedRunnerId !== input.runnerId || action.runId !== input.runId ||
          action.attemptId !== input.attemptId || action.attemptFenceDigest !== sha256(input.fencingToken) ||
          !["assigned", "running"].includes(attempt.status) || !hasActiveAttemptLease(attempt)
        ) return { kind: "stale" as const, action };
        if (action.receipt || ["succeeded", "failed", "unknown"].includes(action.status)) {
          return { kind: "existing" as const, action };
        }
        if (action.status !== "executing") return { kind: "not_executing" as const, action };

        if (receipt.provider === "acp" && receipt.outcome !== "unknown") {
          receipt = MaterialActionReceiptSchema.parse({ ...receipt, outcome: "unknown" });
        }
        if (receipt.outcome !== "unknown") {
          const expectedProvider = String(action.target["provider"] ?? "");
          const expectedConnectionId = String(action.target["connectionId"] ?? "");
          const expectedFingerprint = action.target["targetFingerprint"];
          if (receipt.provider !== expectedProvider) throw new Error("Material action receipt provider must match the approved target.");
          if (receipt.connectionId !== expectedConnectionId) throw new Error("Material action receipt connectionId must match the approved target.");
          if (expectedFingerprint === undefined || receipt.targetFingerprint === undefined) {
            receipt = MaterialActionReceiptSchema.parse({ ...receipt, outcome: "unknown" });
          } else if (receipt.targetFingerprint !== expectedFingerprint) {
            throw new Error("Material action receipt targetFingerprint must match the approved target.");
          }
        }
        const status = receipt.outcome === "succeeded" ? "succeeded" : receipt.outcome === "failed" ? "failed" : "unknown";

        const recorded = tx.update(materialActions)
          .set({ status, receiptJson: JSON.stringify(receipt), updatedAt })
          .where(and(
            eq(materialActions.id, input.actionId),
            eq(materialActions.runId, input.runId),
            eq(materialActions.attemptId, input.attemptId),
            eq(materialActions.attemptFenceDigest, sha256(input.fencingToken)),
            eq(materialActions.status, "executing"),
            isNull(materialActions.receiptJson)
          ))
          .run();
        if (recorded.changes === 0) {
          const winnerRow = tx.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
          return winnerRow
            ? { kind: "existing" as const, action: actionFromRow(winnerRow) }
            : { kind: "not_found" as const };
        }
        tx.insert(runEvents).values(runEventValues({
          runId: input.runId,
          type: "material_action.receipt.recorded",
          payload: receipt,
          visibility: "human",
          importance: "high",
          message: `Material action ${input.actionId} ${receipt.outcome}.`,
          createdAt: updatedAt
        })).run();
        const updatedRow = tx.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
        if (!updatedRow) throw new Error("Material action disappeared after recording its receipt.");
        return { kind: "recorded" as const, action: actionFromRow(updatedRow) };
      });
      if (outcome.kind === "not_found") return null;
      if (outcome.kind === "stale") {
        return { state: "stale", action: outcome.action, reason: "The receipt writer does not own the active fenced Attempt." };
      }
      if (outcome.kind === "not_executing") return this.resolveActionPermission(input);
      const action = outcome.action;
      return action.status === "succeeded"
        ? { state: "reconciled", action, decision: "deny", ...(action.receipt ? { receipt: action.receipt } : {}) }
        : action.status === "unknown"
          ? { state: "unknown", action, ...(action.receipt ? { receipt: action.receipt } : {}) }
          : { state: "denied", action, decision: "deny", ...(action.receipt ? { receipt: action.receipt } : {}) };
    },

    async reconcileUnknownMaterialAction(input: {
      actionId: string;
      outcome: "succeeded" | "failed";
      idempotencyKey: string;
      receiptRef: string;
      source: "control_plane_admin" | "trusted_provider";
      actorId: string;
      evidence?: MaterialActionReceipt["evidence"];
    }): Promise<{
      outcome: "reconciled" | "replayed" | "conflict" | "not_found";
      action?: ReturnType<typeof actionFromRow>;
    }> {
      const updatedAt = nowIso();
      const actionRun = await db
        .select({ runId: materialActions.runId })
        .from(materialActions)
        .where(eq(materialActions.id, input.actionId))
        .limit(1)
        .get();
      if (!actionRun) return { outcome: "not_found" };
      const safeInput = await sanitizeRunnerControlledInputForRun(actionRun.runId, input);
      return db.transaction((tx) => {
        const row = tx.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
        if (!row) return { outcome: "not_found" as const };
        const current = actionFromRow(row);
        const sameReconciliation =
          current.receipt?.metadata?.["reconciliationIdempotencyKey"] === safeInput.idempotencyKey &&
          current.status === safeInput.outcome;
        if (row.status !== "unknown") {
          return {
            outcome: sameReconciliation ? "replayed" as const : "conflict" as const,
            action: current
          };
        }

        const provider = String(current.target["provider"] ?? "");
        const connectionId = current.target["connectionId"];
        const targetFingerprint = current.target["targetFingerprint"];
        const receipt = sanitizeMaterialActionReceipt(MaterialActionReceiptSchema.parse({
          id: `reconciliation_${sha256(stableActionJson({ actionId: safeInput.actionId, idempotencyKey: safeInput.idempotencyKey })).slice(0, 24)}`,
          actionId: safeInput.actionId,
          provider,
          ...(typeof connectionId === "string" ? { connectionId } : {}),
          ...(typeof targetFingerprint === "string" ? { targetFingerprint } : {}),
          receiptRef: safeInput.receiptRef,
          outcome: safeInput.outcome,
          observedAt: updatedAt,
          ...(safeInput.evidence ? { evidence: safeInput.evidence } : {}),
          metadata: {
            reconciliationIdempotencyKey: safeInput.idempotencyKey,
            reconciliationSource: safeInput.source,
            reconciliationActorId: safeInput.actorId
          }
        }), { allowEvidence: true });
        const changed = tx.update(materialActions)
          .set({ status: safeInput.outcome, receiptJson: JSON.stringify(receipt), updatedAt })
          .where(and(eq(materialActions.id, input.actionId), eq(materialActions.status, "unknown")))
          .run();
        if (changed.changes !== 1) {
          const winner = tx.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
          return winner ? { outcome: "conflict" as const, action: actionFromRow(winner) } : { outcome: "not_found" as const };
        }
        const auditPayload = sanitizeCredentialLikeValue({
          actionId: safeInput.actionId,
          runId: row.runId,
          outcome: safeInput.outcome,
          idempotencyKey: safeInput.idempotencyKey,
          source: safeInput.source,
          actorId: safeInput.actorId,
          receipt
        });
        tx.insert(runEvents).values(runEventValues({
          runId: row.runId,
          type: "material_action.reconciled",
          payload: auditPayload,
          visibility: "human",
          importance: "high",
          message: `Material action ${input.actionId} reconciled as ${safeInput.outcome}.`,
          createdAt: updatedAt
        })).run();
        tx.insert(controlPlaneEvents).values({
          type: "material_action.reconciled",
          severity: "info",
          subject: input.actionId,
          payloadJson: JSON.stringify(auditPayload),
          createdAt: updatedAt
        }).run();
        const updated = tx.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
        return { outcome: "reconciled" as const, action: actionFromRow(updated!) };
      });
    },

    async getSuggestedChanges(input: { proposalId: string }): Promise<StoredSuggestedChangesSnapshot | null> {
      const row = await db.select().from(suggestedChanges).where(eq(suggestedChanges.proposalId, input.proposalId)).limit(1).get();
      if (!row) return null;
      return {
        runId: row.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
      };
    },

    async listSuggestedChangesForRun(input: { runId: string }): Promise<SuggestedChangesSnapshot[]> {
      const rows = await db.select().from(suggestedChanges).where(eq(suggestedChanges.runId, input.runId)).orderBy(asc(suggestedChanges.createdAt));
      return rows.map((row) => SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson)));
    },

    async listLatestSuggestedChangesForConversation(input: {
      conversationKey: string;
    }): Promise<StoredSuggestedChangesInConversation[]> {
      const runRows = await db
        .select()
        .from(runs)
        .where(eq(runs.conversationKey, input.conversationKey))
        .orderBy(asc(runs.createdAt));
      for (const runRow of [...runRows].reverse()) {
        const proposalRows = await db
          .select()
          .from(suggestedChanges)
          .where(eq(suggestedChanges.runId, runRow.id))
          .orderBy(asc(suggestedChanges.createdAt));
        if (proposalRows.length === 0) continue;
        const run = runFromRow(runRow);
        const event = OpenTagEventSchema.parse(JSON.parse(runRow.eventJson));
        return proposalRows.map((row) => ({
          runId: row.runId,
          run,
          event,
          snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
        }));
      }
      return [];
    },

    async getProposalLineage(input: { proposalId: string }): Promise<ProposalLineage | null> {
      const targetRow = await db.select().from(suggestedChanges).where(eq(suggestedChanges.proposalId, input.proposalId)).limit(1).get();
      if (!targetRow) return null;
      const target = {
        runId: targetRow.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(targetRow.snapshotJson))
      };
      const rows = await db.select().from(suggestedChanges).orderBy(asc(suggestedChanges.createdAt));
      const snapshots = rows.map((row) => ({
        runId: row.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
      }));
      return computeProposalLineage(snapshots, lineageScopeKey(target));
    },

    async listCurrentMutationIntents(input: { proposalId: string }): Promise<MutationIntentActionability[] | null> {
      const targetRow = await db.select().from(suggestedChanges).where(eq(suggestedChanges.proposalId, input.proposalId)).limit(1).get();
      if (!targetRow) return null;
      const rows = await db.select().from(suggestedChanges).orderBy(asc(suggestedChanges.createdAt));
      const lineage = computeProposalLineage(
        rows.map((row) => ({
          runId: row.runId,
          snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
        })),
        lineageScopeKey({
          runId: targetRow.runId,
          snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(targetRow.snapshotJson))
        })
      );
      if (!lineage) return null;
      return lineage.entries.filter((entry) => entry.status === "current");
    },

    async recordApprovalDecision(input: ApprovalDecision): Promise<ApprovalDecision | null> {
      const decision = ApprovalDecisionSchema.parse(input);
      const storedProposalRow = await db
        .select()
        .from(suggestedChanges)
        .where(eq(suggestedChanges.proposalId, decision.proposalId))
        .limit(1)
        .get();
      if (!storedProposalRow) return null;
      const snapshot = SuggestedChangesSnapshotSchema.parse(JSON.parse(storedProposalRow.snapshotJson));
      if (snapshot.metadata?.["kind"] === "acp_permission") {
        const actionId = snapshot.metadata["actionId"];
        const proposalHash = snapshot.metadata["proposalHash"];
        const approvalEpoch = snapshot.metadata["approvalEpoch"];
        const intentId = typeof actionId === "string" ? `intent_${actionId}` : undefined;
        const permissionDecision = decision.metadata?.["permissionDecision"];
        const approved = intentId ? decision.approvedIntentIds.includes(intentId) : false;
        const rejected = intentId ? (decision.rejectedIntentIds ?? []).includes(intentId) : false;
        if (
          typeof actionId !== "string" || typeof proposalHash !== "string" || typeof approvalEpoch !== "string" ||
          decision.metadata?.["actionId"] !== actionId || decision.metadata?.["proposalHash"] !== proposalHash ||
          decision.metadata?.["approvalEpoch"] !== approvalEpoch ||
          !intentId || !snapshot.intents.some((intent) => intent.intentId === intentId) ||
          (permissionDecision !== "allow_once" && permissionDecision !== "allow_run" && permissionDecision !== "deny") ||
          (permissionDecision === "deny" ? !rejected || approved : !approved || rejected)
        ) return null;
        const winner = db.transaction((tx) => {
          const actionRow = tx.select().from(materialActions).where(and(eq(materialActions.id, actionId), eq(materialActions.proposalId, decision.proposalId))).limit(1).get();
          if (!actionRow || actionRow.status !== "waiting_approval" || actionRow.proposalHash !== proposalHash) return null;
          const runRow = tx.select().from(runs).where(eq(runs.id, actionRow.runId)).limit(1).get();
          const attemptRow = tx.select().from(attempts).where(eq(attempts.id, actionRow.attemptId)).limit(1).get();
          if (
            !runRow || !attemptRow || runRow.status !== "needs_approval" ||
            runRow.currentAttemptId !== actionRow.attemptId || attemptRow.runId !== runRow.id ||
            !["assigned", "running"].includes(attemptRow.status) || !hasActiveAttemptLease(attemptRow)
          ) return null;
          if (actionRow.decisionSnapshotHash) {
            const existing = tx.select().from(approvalDecisions).where(eq(approvalDecisions.proposalId, decision.proposalId)).orderBy(asc(approvalDecisions.createdAt)).limit(1).get();
            return existing ? ApprovalDecisionSchema.parse(JSON.parse(existing.decisionJson)) : null;
          }
          const decisionHash = sha256(stableActionJson(decision));
          const claimed = tx.update(materialActions)
            .set({ decisionSnapshotHash: decisionHash, updatedAt: decision.approvedAt })
            .where(and(eq(materialActions.id, actionId), eq(materialActions.proposalId, decision.proposalId), isNull(materialActions.decisionSnapshotHash)))
            .run();
          if (claimed.changes === 0) {
            const existing = tx.select().from(approvalDecisions).where(eq(approvalDecisions.proposalId, decision.proposalId)).orderBy(asc(approvalDecisions.createdAt)).limit(1).get();
            return existing ? ApprovalDecisionSchema.parse(JSON.parse(existing.decisionJson)) : null;
          }
          tx.insert(approvalDecisions).values({
            id: decision.id,
            proposalId: decision.proposalId,
            decisionJson: JSON.stringify(decision),
            createdAt: decision.approvedAt
          }).run();
          return decision;
        });
        if (!winner) return null;
        if (winner.id !== decision.id) return winner;
      } else {
        await db
          .insert(approvalDecisions)
          .values({
            id: decision.id,
            proposalId: decision.proposalId,
            decisionJson: JSON.stringify(decision),
            createdAt: decision.approvedAt
          })
          .onConflictDoUpdate({
            target: approvalDecisions.id,
            set: {
              proposalId: decision.proposalId,
              decisionJson: JSON.stringify(decision),
              createdAt: decision.approvedAt
            }
          });
      }
      await appendRunEvent({
        runId: storedProposalRow.runId,
        type: "approval.decision.recorded",
        payload: decision,
        visibility: "audit",
        importance: "high",
        message: `Approved ${decision.approvedIntentIds.length} intent(s).`,
        createdAt: decision.approvedAt
      });
      await appendRunEvent({
        runId: storedProposalRow.runId,
        type: "success_metric.observed",
        payload: {
          metric: "external_write_approval_rate",
          proposalId: decision.proposalId,
          approvedIntentCount: decision.approvedIntentIds.length
        },
        visibility: "audit",
        importance: "normal",
        createdAt: decision.approvedAt
      });
      return decision;
    },

    async getApprovalDecision(input: { id: string }): Promise<ApprovalDecision | null> {
      const row = await db.select().from(approvalDecisions).where(eq(approvalDecisions.id, input.id)).limit(1).get();
      return row ? ApprovalDecisionSchema.parse(JSON.parse(row.decisionJson)) : null;
    },

    async createApplyPlan(input: {
      id: string;
      proposalId: string;
      approvalDecisionId: string;
      selectedIntentIds?: string[];
      adapter?: string;
      policyRules?: PolicyRule[];
    }): Promise<ApplyPlan | null> {
      const built = await buildApplyPlan(input);
      if (!built) return null;
      await db
        .insert(applyPlans)
        .values({
          id: built.plan.id,
          proposalId: built.plan.proposalId,
          approvalDecisionId: built.plan.approvalDecisionId,
          planJson: JSON.stringify(built.plan),
          createdAt: built.createdAt
        })
        .onConflictDoUpdate({
          target: applyPlans.id,
          set: {
            proposalId: built.plan.proposalId,
            approvalDecisionId: built.plan.approvalDecisionId,
            planJson: JSON.stringify(built.plan),
            createdAt: built.createdAt
          }
        });
      await appendApplyPlanCreatedEvent(built);
      return built.plan;
    },

    async createApplyPlanOnce(input: {
      id: string;
      proposalId: string;
      approvalDecisionId: string;
      selectedIntentIds?: string[];
      adapter?: string;
      policyRules?: PolicyRule[];
    }): Promise<{ plan: ApplyPlan; created: boolean } | null> {
      const built = await buildApplyPlan(input);
      if (!built) return null;
      const result = db.transaction((tx) => {
        const insertResult = tx
          .insert(applyPlans)
          .values({
            id: built.plan.id,
            proposalId: built.plan.proposalId,
            approvalDecisionId: built.plan.approvalDecisionId,
            planJson: JSON.stringify(built.plan),
            createdAt: built.createdAt
          })
          .onConflictDoNothing({ target: applyPlans.id })
          .run();
        if (insertResult.changes === 0) {
          return { created: false as const };
        }
        tx.insert(runEvents).values(applyPlanCreatedEventRow(built)).run();
        return { created: true as const };
      });
      if (!result.created) {
        const existing = await db.select().from(applyPlans).where(eq(applyPlans.id, input.id)).limit(1).get();
        if (!existing) {
          throw new Error(`Apply plan ${input.id} already exists but could not be loaded`);
        }
        return { plan: ApplyPlanSchema.parse(JSON.parse(existing.planJson)), created: false };
      }
      return { plan: built.plan, created: true };
    },

    async getApplyPlan(input: { id: string }): Promise<ApplyPlan | null> {
      const row = await db.select().from(applyPlans).where(eq(applyPlans.id, input.id)).limit(1).get();
      return row ? ApplyPlanSchema.parse(JSON.parse(row.planJson)) : null;
    },

    async updateApplyPlanOutcomes(input: { id: string; outcomes: ApplyIntentOutcome[]; externalWritesExecuted: boolean }): Promise<ApplyPlan | null> {
      const row = await db.select().from(applyPlans).where(eq(applyPlans.id, input.id)).limit(1).get();
      if (!row) return null;
      const currentPlan = ApplyPlanSchema.parse(JSON.parse(row.planJson));
      const outcomes = input.outcomes.map((outcome) => ApplyIntentOutcomeSchema.parse(outcome));
      const updatedPlan = ApplyPlanSchema.parse({
        ...currentPlan,
        adapterPlan: {
          ...(currentPlan.adapterPlan && typeof currentPlan.adapterPlan === "object" && !Array.isArray(currentPlan.adapterPlan)
            ? currentPlan.adapterPlan
            : {}),
          externalWritesExecuted: input.externalWritesExecuted
        },
        outcomes
      });
      const updatedAt = nowIso();
      await db
        .update(applyPlans)
        .set({ planJson: JSON.stringify(updatedPlan), createdAt: row.createdAt })
        .where(eq(applyPlans.id, input.id));

      const storedProposalRow = await db
        .select()
        .from(suggestedChanges)
        .where(eq(suggestedChanges.proposalId, updatedPlan.proposalId))
        .limit(1)
        .get();
      if (storedProposalRow) {
        await appendRunEvent({
          runId: storedProposalRow.runId,
          type: "apply_plan.executed",
          payload: updatedPlan,
          visibility: "audit",
          importance: "high",
          message: `Executed apply plan with ${outcomes.length} outcome(s).`,
          createdAt: updatedAt
        });
      }
      return updatedPlan;
    },

    async recordProgress(input: {
      runId: string;
      message: string;
      type?: string;
      at?: string;
      visibility?: RunEventVisibility;
      importance?: RunEventImportance;
      runnerId?: string;
      attemptId?: string;
      fencingToken?: string;
      idempotencyKey?: string;
    }): Promise<RecordProgressOutcome> {
      const idempotencyDigest = input.idempotencyKey === undefined
        ? undefined
        : progressIdempotencyDigest(input.idempotencyKey);
      const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
      const safeMessage = safeInput.message;
      const safeType = safeInput.type;
      if (input.runnerId) {
        if (!input.attemptId || !input.fencingToken) return "stale_attempt";
        const lease = activeAttemptLease({
          runId: input.runId,
          runnerId: input.runnerId,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken
        });
        if (lease.outcome !== "active") return lease.outcome;
        const createdAt = safeInput.at ?? nowIso();
        return db.transaction((tx) => {
          const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
          const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId!)).limit(1).get();
          if (!run) return "not_found" as const;
          if (
            !attempt ||
            run.assignedRunnerId !== input.runnerId ||
            run.currentAttemptId !== input.attemptId ||
            (run.status !== "assigned" && run.status !== "running" && run.status !== "needs_approval") ||
            attempt.runId !== input.runId ||
            attempt.runnerId !== input.runnerId ||
            attempt.fencingToken !== input.fencingToken ||
            (attempt.status !== "assigned" && attempt.status !== "running") ||
            !hasActiveAttemptLease(attempt)
          ) {
            return "stale_attempt" as const;
          }
          const inserted = tx.insert(runEvents)
            .values({
              runId: input.runId,
              type: "run.progress",
              payloadJson: JSON.stringify({
                runnerId: safeInput.runnerId,
                attemptId: safeInput.attemptId,
                type: safeType ?? "progress",
                message: safeMessage,
                at: createdAt
              }),
              progressIdempotencyDigest: idempotencyDigest ?? null,
              visibility: safeInput.visibility ?? "audit",
              importance: safeInput.importance ?? "normal",
              message: safeMessage,
              createdAt
            })
            .onConflictDoNothing({ target: [runEvents.runId, runEvents.progressIdempotencyDigest] })
            .returning()
            .get();
          if (!inserted) {
            if (!idempotencyDigest) throw new Error("progress event was not created");
            const existing = tx
              .select()
              .from(runEvents)
              .where(and(
                eq(runEvents.runId, input.runId),
                eq(runEvents.progressIdempotencyDigest, idempotencyDigest)
              ))
              .limit(1)
              .get();
            if (!existing) throw new Error("duplicate progress event could not be loaded");
            return { outcome: "duplicate" as const, event: runEventFromRow(existing) };
          }
          return { outcome: "recorded" as const, event: runEventFromRow(inserted) };
        });
      }
      const createdAt = safeInput.at ?? nowIso();
      return db.transaction((tx) => {
        const inserted = tx
          .insert(runEvents)
          .values({
            ...runEventValues({
              runId: input.runId,
              type: "run.progress",
              payload: {
                ...(safeInput.runnerId ? { runnerId: safeInput.runnerId } : {}),
                type: safeType ?? "progress",
                message: safeMessage,
                at: createdAt
              },
              visibility: safeInput.visibility ?? "audit",
              importance: safeInput.importance ?? "normal",
              message: safeMessage,
              createdAt
            }),
            progressIdempotencyDigest: idempotencyDigest ?? null
          })
          .onConflictDoNothing({ target: [runEvents.runId, runEvents.progressIdempotencyDigest] })
          .returning()
          .get();
        if (!inserted) {
          if (!idempotencyDigest) throw new Error("progress event was not created");
          const existing = tx
            .select()
            .from(runEvents)
            .where(and(
              eq(runEvents.runId, input.runId),
              eq(runEvents.progressIdempotencyDigest, idempotencyDigest)
            ))
            .limit(1)
            .get();
          if (!existing) throw new Error("duplicate progress event could not be loaded");
          return { outcome: "duplicate" as const, event: runEventFromRow(existing) };
        }
        return { outcome: "recorded" as const, event: runEventFromRow(inserted) };
      });
    },

    async listAttempts(input: { runId: string }): Promise<Attempt[]> {
      const rows = await db.select().from(attempts).where(eq(attempts.runId, input.runId)).orderBy(asc(attempts.number));
      return rows.map(attemptFromRow);
    },

    async getRun(input: { runId: string }): Promise<OpenTagRunWithEvent | null> {
      const row = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (!row) return null;
      return {
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async listRunsForWorkThread(input: { workThreadId: string }): Promise<OpenTagRunWithEvent[]> {
      const rows = await db
        .select()
        .from(runs)
        .where(eq(runs.workThreadId, input.workThreadId))
        .orderBy(asc(runs.createdAt), asc(runs.id));
      return rows.map((row) => ({
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      }));
    },

    async listRunsWithResults(): Promise<OpenTagRunWithEvent[]> {
      const rows = await db
        .select()
        .from(runs)
        .where(isNotNull(runs.resultJson))
        .orderBy(asc(runs.createdAt), asc(runs.id));
      return rows.map((row) => ({
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      }));
    },

    async listCurrentWorkThreadRunsWithResults(): Promise<OpenTagRunWithEvent[]> {
      const newerRuns = alias(runs, "newer_runs");
      const rows = await db
        .select()
        .from(runs)
        .where(and(
          isNotNull(runs.workThreadId),
          isNotNull(runs.resultJson),
          notExists(
            db
              .select({ id: newerRuns.id })
              .from(newerRuns)
              .where(and(
                eq(newerRuns.workThreadId, runs.workThreadId),
                sql`(${newerRuns.createdAt}, ${newerRuns.id}) > (${runs.createdAt}, ${runs.id})`
              ))
          )
        ))
        .orderBy(asc(runs.createdAt), asc(runs.id));
      return rows.map((row) => ({
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      }));
    },

    async listRunEvents(input: { runId: string }): Promise<OpenTagAuditEvent[]> {
      const rows = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(asc(runEvents.id));
      return rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        type: row.type,
        visibility: RunEventVisibilitySchema.parse(row.visibility),
        importance: RunEventImportanceSchema.parse(row.importance),
        ...(row.message ? { message: row.message } : {}),
        payload: JSON.parse(row.payloadJson) as unknown,
        createdAt: row.createdAt
      }));
    },

    async getRunLedger(input: { runId: string }): Promise<AgentWorkLedger | null> {
      const runRow = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (!runRow) return null;
      const event = OpenTagEventSchema.parse(JSON.parse(runRow.eventJson));
      const rows = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(asc(runEvents.id));
      const sourceEntry: AgentWorkLedgerEntry = {
        id: 0,
        sequence: 0,
        runId: input.runId,
        type: "source_event.received",
        visibility: "audit",
        importance: "normal",
        message: `${event.source} source event ${event.sourceEventId} received.`,
        payload: { event },
        createdAt: event.receivedAt,
        category: "source_event"
      };
      return {
        runId: input.runId,
        entries: [
          sourceEntry,
          ...rows.map((row, index) => ({
            id: row.id,
            sequence: index + 1,
            runId: row.runId,
            type: row.type,
            visibility: RunEventVisibilitySchema.parse(row.visibility),
            importance: RunEventImportanceSchema.parse(row.importance),
            ...(row.message ? { message: row.message } : {}),
            payload: row.payloadJson ? (JSON.parse(row.payloadJson) as unknown) : {},
            createdAt: row.createdAt,
            category: ledgerCategoryForEventType(row.type)
          }))
        ]
      };
    },

    async appendControlPlaneEvent(input: {
      type: string;
      severity?: ControlPlaneEventSeverity;
      subject?: string;
      payload?: unknown;
      createdAt?: string;
    }): Promise<void> {
      await db.insert(controlPlaneEvents).values({
        type: input.type,
        severity: input.severity ?? "info",
        subject: input.subject ?? null,
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt: input.createdAt ?? nowIso()
      });
    },

    async listControlPlaneEvents(input: { limit?: number; type?: string; severity?: ControlPlaneEventSeverity } = {}): Promise<ControlPlaneEvent[]> {
      const conditions = [
        ...(input.type ? [eq(controlPlaneEvents.type, input.type)] : []),
        ...(input.severity ? [eq(controlPlaneEvents.severity, input.severity)] : [])
      ];
      const rows = await db
        .select()
        .from(controlPlaneEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(controlPlaneEvents.id))
        .limit(input.limit ?? 100);
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        severity: row.severity as ControlPlaneEventSeverity,
        ...(row.subject ? { subject: row.subject } : {}),
        payload: JSON.parse(row.payloadJson) as unknown,
        createdAt: row.createdAt
      }));
    },

    async summarizeControlPlaneAlerts(input: {
      since?: string;
      limit?: number;
      thresholds?: Partial<Record<ControlPlaneAlert["type"], number>>;
    } = {}): Promise<ControlPlaneAlert[]> {
      const limit = input.limit ?? 5_000;
      const rows = await db
        .select()
        .from(controlPlaneEvents)
        .orderBy(desc(controlPlaneEvents.id))
        .limit(limit);
      const claimRows = await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.type, "run.claimed"))
        .orderBy(desc(runEvents.id))
        .limit(limit);
      const groups = new Map<string, { kind: ControlPlaneAlert["type"]; eventType: string; subject: string; events: ControlPlaneEvent[] }>();

      function addEvent(event: ControlPlaneEvent) {
        if (input.since && event.createdAt < input.since) return;
        const kind = controlPlaneAlertKind(event);
        if (!kind) return;
        const subject = controlPlaneAlertSubject(event);
        const key = `${kind}|${event.type}|${subject}`;
        const group = groups.get(key) ?? { kind, eventType: event.type, subject, events: [] };
        group.events.push(event);
        groups.set(key, group);
      }

      for (const row of rows.reverse()) {
        addEvent({
          id: row.id,
          type: row.type,
          severity: row.severity as ControlPlaneEventSeverity,
          ...(row.subject ? { subject: row.subject } : {}),
          payload: JSON.parse(row.payloadJson) as unknown,
          createdAt: row.createdAt
        });
      }
      for (const row of claimRows.reverse()) {
        addEvent({
          id: row.id,
          type: row.type,
          severity: "info",
          subject: row.runId,
          payload: JSON.parse(row.payloadJson) as unknown,
          createdAt: row.createdAt
        });
      }

      return [...groups.values()]
        .flatMap((group): ControlPlaneAlert[] => {
          const threshold = controlPlaneAlertThreshold(group.kind, input.thresholds);
          if (group.events.length < threshold) return [];
          const metadata = controlPlaneAlertMetadata(group.kind);
          const first = group.events[0]!;
          const last = group.events.at(-1)!;
          return [
            {
              id: `${group.kind}:${group.eventType}:${group.subject}`,
              type: group.kind,
              severity: metadata.severity,
              eventType: group.eventType,
              count: group.events.length,
              threshold,
              firstSeenAt: first.createdAt,
              lastSeenAt: last.createdAt,
              subject: group.subject,
              reason: metadata.reason,
              nextAction: metadata.nextAction
            }
          ];
        })
        .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
    },

    async enqueueCallbackDelivery(input: {
      runId: string;
      kind: CallbackDeliveryKind;
      provider: CallbackDeliveryProvider;
      uri: string;
      body: string;
      threadKey?: string;
      agentId?: string;
      statusMessageKey?: string;
      blocks?: unknown[];
      rich?: unknown;
      idempotencyKey?: string;
    }): Promise<EnqueuedCallbackDelivery> {
      const safeDelivery = sanitizeCredentialLikeValue({
        uri: input.uri,
        body: input.body,
        ...(input.threadKey ? { threadKey: input.threadKey } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.statusMessageKey ? { statusMessageKey: input.statusMessageKey } : {}),
        ...(input.blocks ? { blocks: input.blocks } : {}),
        ...(input.rich !== undefined ? { rich: input.rich } : {})
      });
      const createdAt = nowIso();
      const idempotencyKey = callbackIdempotencyKey({ ...input, ...safeDelivery });
      const rows = await db
        .insert(callbackDeliveries)
        .values({
          runId: input.runId,
          kind: input.kind,
          provider: input.provider,
          uri: safeDelivery.uri,
          body: safeDelivery.body,
          threadKey: safeDelivery.threadKey ?? null,
          idempotencyKey,
          metadataJson: JSON.stringify({
            ...(safeDelivery.agentId ? { agentId: safeDelivery.agentId } : {}),
            ...(safeDelivery.statusMessageKey ? { statusMessageKey: safeDelivery.statusMessageKey } : {}),
            ...(safeDelivery.blocks ? { blocks: safeDelivery.blocks } : {}),
            ...(safeDelivery.rich !== undefined ? { rich: safeDelivery.rich } : {})
          }),
          status: "pending",
          createdAt,
          updatedAt: createdAt
        })
        .onConflictDoNothing({ target: callbackDeliveries.idempotencyKey })
        .returning();
      const row = rows[0];
      if (!row) {
        const existing = await db.select().from(callbackDeliveries).where(eq(callbackDeliveries.idempotencyKey, idempotencyKey)).limit(1).get();
        if (!existing) throw new Error("callback delivery was not created");
        await appendRunEvent({
          runId: input.runId,
          type: `callback.${input.kind}.duplicate`,
          payload: callbackDeliveryFromRow(existing),
          visibility: "audit",
          importance: "normal",
          message: "Duplicate callback delivery suppressed.",
          createdAt
        });
        return { ...callbackDeliveryFromRow(existing), enqueueOutcome: "duplicate" as const };
      }
      await appendRunEvent({
        runId: input.runId,
        type: `callback.${input.kind}.queued`,
        payload: callbackDeliveryFromRow(row),
        visibility: "audit",
        importance: "normal",
        createdAt
      });
      return { ...callbackDeliveryFromRow(row), enqueueOutcome: "queued" as const };
    },

    async markCallbackDelivered(input: { deliveryId: number; externalMessageId?: string }): Promise<void> {
      const updatedAt = nowIso();
      const row = await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.id, input.deliveryId))
        .limit(1)
        .get();
      if (!row) return;
      const metadata = callbackDeliveryMetadataFromJson(row.metadataJson) ?? {};
      const metadataJson = JSON.stringify({
        ...metadata,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {})
      });
      await db
        .update(callbackDeliveries)
        .set({ status: "delivered", attempts: row.attempts + 1, lastError: null, nextAttemptAt: null, metadataJson, updatedAt })
        .where(eq(callbackDeliveries.id, input.deliveryId));
      const deliveredRow = { ...row, metadataJson };
      await appendRunEvent({
        runId: row.runId,
        type: `callback.${row.kind}.delivered`,
        payload: { ...callbackDeliveryFromRow(deliveredRow), status: "delivered", attempts: row.attempts + 1, updatedAt },
        visibility: "human",
        importance: row.kind === "final" ? "high" : "normal",
        message: row.body,
        createdAt: updatedAt
      });
    },

    async findCallbackExternalMessageId(input: {
      runId: string;
      provider: CallbackDeliveryProvider;
      threadKey?: string;
      statusMessageKey: string;
    }): Promise<string | undefined> {
      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(and(eq(callbackDeliveries.runId, input.runId), eq(callbackDeliveries.provider, input.provider), eq(callbackDeliveries.status, "delivered")))
        .orderBy(desc(callbackDeliveries.updatedAt), desc(callbackDeliveries.id));

      for (const row of rows) {
        const delivery = callbackDeliveryFromRow(row);
        if (delivery.statusMessageKey !== input.statusMessageKey) continue;
        if ((delivery.threadKey ?? undefined) !== input.threadKey) continue;
        if (delivery.externalMessageId) return delivery.externalMessageId;
      }
      return undefined;
    },

    async markCallbackFailed(input: { deliveryId: number; error: string; nextAttemptAt?: string; maxAttempts?: number }): Promise<void> {
      const updatedAt = nowIso();
      const row = await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.id, input.deliveryId))
        .limit(1)
        .get();
      if (!row) return;
      const safeError = sanitizeCredentialLikeValue(input.error, {
        secrets: await attemptFencingTokensForRun(row.runId)
      });
      const attemptCount = row.attempts + 1;
      await db
        .update(callbackDeliveries)
        .set({ status: "failed", attempts: attemptCount, lastError: safeError, nextAttemptAt: input.nextAttemptAt ?? null, updatedAt })
        .where(eq(callbackDeliveries.id, input.deliveryId));
      await appendRunEvent({
        runId: row.runId,
        type: `callback.${row.kind}.failed`,
        payload: {
          ...callbackDeliveryFromRow(row),
          status: "failed",
          attempts: attemptCount,
          lastError: safeError,
          ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
          updatedAt
        },
        visibility: "audit",
        importance: "normal",
        createdAt: updatedAt
      });
      if (input.maxAttempts !== undefined && attemptCount >= input.maxAttempts && !input.nextAttemptAt) {
        await appendRunEvent({
          runId: row.runId,
          type: `callback.${row.kind}.suppressed`,
          payload: {
            ...callbackDeliveryFromRow(row),
            status: "failed",
            attempts: attemptCount,
            maxAttempts: input.maxAttempts,
            lastError: safeError,
            updatedAt
          },
          visibility: "audit",
          importance: "high",
          message: "Callback delivery retry budget exhausted; further delivery attempts are suppressed to avoid duplicate storms.",
          createdAt: updatedAt
        });
      }
    },

    async listPendingCallbackDeliveries(input: { limit: number; now?: Date; maxAttempts?: number }): Promise<CallbackDelivery[]> {
      const now = input.now ?? new Date();
      const maxAttempts = input.maxAttempts ?? Number.POSITIVE_INFINITY;
      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(inArray(callbackDeliveries.status, ["pending", "failed"]))
        .orderBy(asc(callbackDeliveries.id));
      return rows
        .map(callbackDeliveryFromRow)
        .filter((delivery) => delivery.attempts < maxAttempts)
        .filter((delivery) => !delivery.nextAttemptAt || new Date(delivery.nextAttemptAt).getTime() <= now.getTime())
        .slice(0, input.limit);
    },

    async claimPendingCallbackDeliveries(input: { limit: number; now?: Date; maxAttempts?: number; staleDeliveryThresholdMs?: number }): Promise<CallbackDelivery[]> {
      const now = input.now ?? new Date();
      const maxAttempts = input.maxAttempts ?? Number.POSITIVE_INFINITY;
      const staleThresholdMs = input.staleDeliveryThresholdMs ?? 60_000;
      const staleDeliveryCutoff = new Date(now.getTime() - staleThresholdMs).toISOString();

      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(inArray(callbackDeliveries.status, ["pending", "failed", "delivering"]))
        .orderBy(asc(callbackDeliveries.id));

      const claimed: CallbackDelivery[] = [];
      for (const row of rows) {
        const delivery = callbackDeliveryFromRow(row);
        if (delivery.attempts >= maxAttempts) continue;
        if (delivery.nextAttemptAt && new Date(delivery.nextAttemptAt).getTime() > now.getTime()) continue;
        if (row.status === "delivering" && row.updatedAt > staleDeliveryCutoff) continue;

        const updatedAt = input.now ? input.now.toISOString() : nowIso();
        const claimWhere =
          row.status === "delivering"
            ? and(eq(callbackDeliveries.id, row.id), eq(callbackDeliveries.status, "delivering"), eq(callbackDeliveries.updatedAt, row.updatedAt))
            : and(eq(callbackDeliveries.id, row.id), inArray(callbackDeliveries.status, ["pending", "failed"]));
        const claimResult = await db.update(callbackDeliveries).set({ status: "delivering", updatedAt }).where(claimWhere);
        if (claimResult.changes === 0) continue;

        claimed.push({
          ...delivery,
          status: "delivering",
          updatedAt
        });
        if (claimed.length >= input.limit) break;
      }

      return claimed;
    },

    async getRunMetrics(input: { runId: string }): Promise<OpenTagRunMetrics> {
      const rows = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(asc(runEvents.id));
      const events = rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        type: row.type,
        visibility: RunEventVisibilitySchema.parse(row.visibility),
        importance: RunEventImportanceSchema.parse(row.importance),
        ...(row.message ? { message: row.message } : {}),
        payload: JSON.parse(row.payloadJson) as unknown,
        createdAt: row.createdAt
      }));
      return metricsFromEvents(input.runId, events);
    },

    async getRepoMetrics(input: { provider: string; owner: string; repo: string }): Promise<OpenTagAggregateMetrics> {
      const runRows = await db
        .select()
        .from(runs)
        .where(and(eq(runs.repoProvider, input.provider), eq(runs.repoOwner, input.owner), eq(runs.repoName, input.repo)))
        .orderBy(asc(runs.createdAt));
      const matchingRunIds = runRows.map((row) => row.id);
      const runMetrics = [];
      for (const runId of matchingRunIds) {
        const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.id));
        runMetrics.push(
          metricsFromEvents(
            runId,
            rows.map((row) => ({
              id: row.id,
              runId: row.runId,
              type: row.type,
              visibility: RunEventVisibilitySchema.parse(row.visibility),
              importance: RunEventImportanceSchema.parse(row.importance),
              ...(row.message ? { message: row.message } : {}),
              payload: JSON.parse(row.payloadJson) as unknown,
              createdAt: row.createdAt
            }))
          )
        );
      }
      return aggregateMetrics({
        scope: "repo",
        scopeId: `${input.provider}:${input.owner}/${input.repo}`,
        runs: runMetrics
      });
    },

    async getWorkThreadMetrics(input: { threadId: string }): Promise<OpenTagAggregateMetrics> {
      const runRows = await db.select().from(runs).where(eq(runs.workThreadId, input.threadId)).orderBy(asc(runs.createdAt));
      const matchingRunIds = runRows.map((row) => row.id);
      const runMetrics = [];
      for (const runId of matchingRunIds) {
        const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.id));
        runMetrics.push(
          metricsFromEvents(
            runId,
            rows.map((row) => ({
              id: row.id,
              runId: row.runId,
              type: row.type,
              visibility: RunEventVisibilitySchema.parse(row.visibility),
              importance: RunEventImportanceSchema.parse(row.importance),
              ...(row.message ? { message: row.message } : {}),
              payload: JSON.parse(row.payloadJson) as unknown,
              createdAt: row.createdAt
            }))
          )
        );
      }
      return aggregateMetrics({
        scope: "work_thread",
        scopeId: input.threadId,
        runs: runMetrics
      });
    }
  };
}
