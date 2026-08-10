import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  AcceptedProgressMetricsSchema,
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
  canonicalJsonStringify,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeHostedLifecycleRequestDigestV1,
  computeHostedLifecycleRequestIdV1,
  computeHostedLifecycleOperationIdV1,
  computeHostedLifecycleReceiptIdV1,
  computeHostedClaimFencingTokenDigestV1,
  CompletionAssessmentReceiptEnvelopeV1Schema,
  CompletionEvidenceObservationPayloadV1Schema,
  CompletionEvidenceObservationReceiptEnvelopeV1Schema,
  CompletionContractRefReceiptEnvelopeV1Schema,
  CallbackAttemptObservationReceiptEnvelopeV1Schema,
  CallbackIntentObservationReceiptEnvelopeV1Schema,
  CallbackProviderObservationReceiptEnvelopeV1Schema,
  compareCompletionGateIds,
  compareRfc3339Timestamps,
  ContextPacketSchema,
  conversationKeyFromEvent,
  conversationKeysFromEvent,
  defaultRunEventMetadata,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  parseGitHubIssueCommentsTargetV1,
  ReassessmentObligationReasonCodeSchema,
  ReassessmentObligationSchema,
  ReassessmentObligationSourceKindSchema,
  ReassessmentObligationStateSchema,
  reduceCompletionGateStates,
  runResultArtifactId,
  runResultCreatedPullRequestArtifactId,
  PolicyRuleSchema,
  PolicySnapshotProvenanceSchema,
  ProposalLineageSchema,
  preflightMutationIntent,
  evaluateActionPermission,
  grantMatchesAction,
  containsCredentialLikeData,
  FollowUpRequestSchema,
  FactoryRecipeSnapshotInputSchema,
  FrozenRoutingPolicySchema,
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
  RoutingDecisionSchema,
  RunnerDirectoryEntrySchema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  RunnerRegistrationInputSchema,
  SuggestedChangesSnapshotSchema,
  HumanEscalationSchema,
  HostedClaimRequestV1Schema,
  HostedClaimV1Schema,
  HostedHeartbeatRequestV1Schema,
  HostedProgressRequestV1Schema,
  HostedRejectStartRequestV1Schema,
  HostedRunningRequestV1Schema,
  HostedCompleteRequestV1Schema,
  HostedLifecycleRequestV1Schema,
  HostedLifecycleReceiptEnvelopeV1Schema,
  VerificationEvidenceSchema,
  WorkThreadRefReceiptEnvelopeV1Schema,
  WorkThreadSchema,
  WorkstreamAdmissionBatchInputSchema,
  WorkstreamInputSchema,
  verifyHostedAdmissionEnvelopeDigestV1,
  verifyHostedClaimFencingTokenDigestV1,
  verifyHostedLifecycleReceiptV1,
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
  type AcceptedProgressAttributionView,
  type AdapterMutationMapping,
  type CompletionAssessment,
  type CompletionContract,
  type CompletionWaiver,
  type CompletionAssessmentReceiptEnvelopeV1,
  type CompletionEvidenceObservationPayloadV1,
  type CompletionEvidenceObservationReceiptEnvelopeV1,
  type CompletionContractRefReceiptEnvelopeV1,
  type FrozenRoutingPolicy,
  type FactoryRecipeSnapshotInput,
  type HumanEscalation,
  type HostedClaimRequestV1,
  type HostedClaimV1,
  type HostedHeartbeatRequestV1,
  type HostedProgressRequestV1,
  type HostedRejectStartRequestV1,
  type HostedRunningRequestV1,
  type HostedCompleteRequestV1,
  type HostedLifecycleActionV1,
  type HostedLifecycleRequestV1,
  type HostedLifecycleReceiptEnvelopeV1,
  type MutationIntentActionability,
  type OpenTagEvent,
  type OpenTagManagedChannelBindingOwnership,
  type OpenTagRun,
  type OpenTagRunResult,
  type ReassessmentObligation,
  type ReassessmentObligationReasonCode,
  type ReassessmentObligationSourceKind,
  type ReassessmentObligationState,
  type PolicyRule,
  type PolicySnapshotProvenance,
  type ProjectTargetRef,
  type ProposalLineage,
  type RunAdmissionDecision,
  type RunEventImportance,
  type RunEventVisibility,
  type AcceptedProgressMetrics,
  type RoutingDecision,
  type RunnerDirectoryEntry,
  type RunnerRegistrationConfig,
  type RunnerRegistrationInput,
  type RunnerReadinessReceiptEnvelopeV1,
  type SuggestedChangesSnapshot,
  type VerificationEvidence,
  type WorkThreadRefReceiptEnvelopeV1,
  type WorkThread,
  type WorkstreamInput
} from "@opentag/core";
import {
  deriveAcceptedProgressAttribution,
  evaluateRouting,
  type CompletionArtifact,
  type CompletionEvidenceFact
} from "@opentag/governance";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { alias } from "drizzle-orm/sqlite-core";
import { canonicalSha256Json } from "./canonical-json.js";
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
  controlPlaneProjectionOutbox,
  controlPlaneEvents,
  factoryRecipeSnapshots,
  factoryWorkstreamMembers,
  factoryWorkstreams,
  governanceEvents,
  hostedAttemptImports,
  hostedClaimOperations,
  hostedLifecycleOperations,
  hostedRunImports,
  humanEscalations,
  linearOAuthInstallStates,
  linearRelayInstallations,
  repoBindings,
  repoMutationMappings,
  repoPolicyRules,
  reassessmentObligations,
  callbackDeliveries,
  governedCallbackAttempts,
  governedCallbackIntents,
  governedCallbackReconciliations,
  followUpRequests,
  runEvents,
  sourceDeliveries,
  runners,
  runs,
  suggestedChanges,
  verificationEvidenceRecords,
  workThreads,
  workstreamAdmissionBatchItems,
  workstreamAdmissionBatches
} from "./schema.js";

export type ControlPlaneProjectionEnvelope =
  | RunnerReadinessReceiptEnvelopeV1
  | WorkThreadRefReceiptEnvelopeV1
  | CompletionContractRefReceiptEnvelopeV1
  | CompletionEvidenceObservationReceiptEnvelopeV1
  | CompletionAssessmentReceiptEnvelopeV1
  | typeof CallbackIntentObservationReceiptEnvelopeV1Schema._output
  | typeof CallbackAttemptObservationReceiptEnvelopeV1Schema._output
  | typeof CallbackProviderObservationReceiptEnvelopeV1Schema._output;

export type ControlPlaneProjectionOutboxState = "pending" | "leased" | "acknowledged" | "attention";

export type ControlPlaneProjectionOutboxEntry = {
  receiptId: string;
  destinationId: string;
  organizationId: string;
  runnerId?: string;
  runId?: string;
  workThreadId?: string;
  receiptKind: ControlPlaneProjectionEnvelope["receiptKind"];
  identity: { namespace: string; parts: string[]; key: string };
  operationId: string;
  dependsOnReceiptId?: string;
  requiresLifecycleOperationId?: string;
  payloadDigest: string;
  receiptDigest: string;
  envelope: ControlPlaneProjectionEnvelope;
  state: ControlPlaneProjectionOutboxState;
  attemptCount: number;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  lastReasonCode?: string;
  lastHttpStatus?: number;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
};

export type EnqueueControlPlaneProjectionInput = {
  destinationId: string;
  envelope: unknown;
  dependsOnReceiptId?: string;
  requiresLifecycleOperationId?: string;
  now?: Date;
};

export type EnqueueControlPlaneProjectionResult =
  | { outcome: "created" | "replay"; entry: ControlPlaneProjectionOutboxEntry }
  | { outcome: "conflict"; conflictOn: "receipt_id" | "identity" | "operation"; existingReceiptId: string };

export type ClaimControlPlaneProjectionsResult = {
  entries: ControlPlaneProjectionOutboxEntry[];
  rejected: Array<{
    receiptId?: string;
    rowIdentityDigest: string;
    reasonCode:
      | "stored_row_invalid"
      | "dependency_missing"
      | "dependency_cross_destination"
      | "dependency_invalid";
  }>;
};

export class ControlPlaneProjectionOutboxValidationError extends Error {
  readonly code:
    | "projection_envelope_invalid"
    | "projection_custody_violation"
    | "projection_destination_invalid"
    | "projection_digest_mismatch"
    | "projection_invalid_unicode";

  constructor(code: ControlPlaneProjectionOutboxValidationError["code"]) {
    super(code);
    this.name = "ControlPlaneProjectionOutboxValidationError";
    this.code = code;
  }
}

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

export type EnqueueReassessmentObligationInput = {
  workThreadId: string;
  sourceKind: ReassessmentObligationSourceKind;
  sourceId: string;
  sourceDigest: string;
  notBefore?: string;
  createdAt?: string;
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

export type ManagedChannelPrincipalIdentity = {
  provider: string;
  applicationId: string;
  botId?: string;
};

export type ManagedChannelAuthorityFailureReason =
  | "managed_channel_authority_unavailable"
  | "managed_channel_authority_changed"
  | "managed_channel_principal_required";

export class ManagedChannelAuthorityError extends Error {
  override readonly name = "ManagedChannelAuthorityError";

  constructor(readonly reasonCode: ManagedChannelAuthorityFailureReason) {
    super(reasonCode);
  }
}

export class ActiveConversationRaceError extends Error {
  override readonly name = "ActiveConversationRaceError";

  constructor(readonly activeRunId: string) {
    super(`ACTIVE_CONVERSATION_RACE:${activeRunId}`);
  }
}

export type ClaimedOpenTagRun = OpenTagRunWithEvent & {
  attemptId: string;
  attemptNumber: number;
  fencingToken: string;
  executorId: string;
  routingDecision: RoutingDecision;
};

export const HOSTED_IMPORT_ERROR_CODES = [
  "HOSTED_IMPORT_CLAIM_INVALID",
  "HOSTED_IMPORT_EVENT_MISMATCH",
  "HOSTED_IMPORT_RUN_CONFLICT",
  "HOSTED_IMPORT_ADMISSION_CONFLICT",
  "HOSTED_IMPORT_OPERATION_CONFLICT",
  "HOSTED_IMPORT_ATTEMPT_CONFLICT",
  "HOSTED_IMPORT_FENCE_CONFLICT",
  "HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT",
  "HOSTED_IMPORT_AUTHORITY_CONFLICT",
  "HOSTED_IMPORT_WORK_THREAD_CONFLICT",
  "HOSTED_CLAIM_OPERATION_INVALID",
  "HOSTED_CLAIM_OPERATION_CONFLICT",
  "HOSTED_CLAIM_OPERATION_NOT_PENDING",
  "HOSTED_HEARTBEAT_OPERATION_INVALID",
  "HOSTED_HEARTBEAT_OPERATION_CONFLICT"
] as const;

export type HostedImportErrorCode = (typeof HOSTED_IMPORT_ERROR_CODES)[number];

export class HostedImportConflictError extends Error {
  override readonly name = "HostedImportConflictError";

  constructor(readonly code: HostedImportErrorCode) {
    super(code);
  }
}

export class HostedLifecycleOperationConflictError extends Error {
  override readonly name = "HostedLifecycleOperationConflictError";

  constructor(readonly code:
    | "HOSTED_LIFECYCLE_OPERATION_INVALID"
    | "HOSTED_LIFECYCLE_OPERATION_CONFLICT"
    | "HOSTED_LIFECYCLE_PREDECESSOR_NOT_ACKNOWLEDGED"
    | "HOSTED_LIFECYCLE_ATOMIC_API_REQUIRED") {
    super(code);
  }
}

export class GovernedCallbackConflictError extends Error {
  constructor(readonly code:
    | "GOVERNED_CALLBACK_INVALID"
    | "GOVERNED_CALLBACK_CONFLICT"
    | "GOVERNED_CALLBACK_AUTHORITY_CONFLICT"
    | "GOVERNED_CALLBACK_STALE_LEASE"
    | "GOVERNED_CALLBACK_RECONCILIATION_REQUIRED") {
    super(code);
  }
}

export type HostedImportAuthority = HostedClaimV1["authority"] & {
  admissionId: string;
  admissionOperationId: string;
  claimOperationId: string;
  admissionEnvelopeDigest: string;
  sourceIdentityDigest: string;
  deliveryPayloadDigest: string;
  policyReceiptId: string;
  policyPayloadDigest: string;
  policyReceiptDigest: string;
  eventDigest: string;
  contextPacketDigest: string;
  workThreadId?: string;
  workThreadDigest?: string;
  claimDigest: string;
  authorityDigest: string;
  importedAt: string;
};

export type HostedAssignedRun = OpenTagRunWithEvent & {
  attemptId: string;
  attemptNumber: number;
  fencingToken: string;
  executorId: string;
};

export type ImportHostedAssignedRunResult = {
  outcome: "created" | "replayed";
  executionState: "ready_to_start" | "already_started" | "superseded" | "terminal";
  executionMayStart: false;
  claimed: HostedAssignedRun | null;
  hostedAuthority: HostedImportAuthority;
};

export type HostedSourceRefetchReceipt = {
  provider: "github";
  providerRepositoryId: string;
  owner: string;
  repo: string;
  sourceThread: HostedClaimV1["hostedAdmission"]["sourceThread"];
  sourceEvent: HostedClaimV1["hostedAdmission"]["sourceEvent"];
  actor: { providerUserId: string; login: string };
  sourceIdentityDigest: string;
  eventDigest: string;
  refetchedAt: string;
};

export type HostedClaimOperation = {
  operationId: string;
  requestId: string;
  organizationId: string;
  runnerId: string;
  destinationId: string;
  requestDigest: string;
  request: HostedClaimRequestV1;
  state: "pending" | "claimed" | "empty";
  runId?: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  executionStartedAt?: string;
  terminalReasonCode?: "stale_control_authority" | "operation_digest_conflict";
};

export type HostedHeartbeatOperation = {
  destinationId: string;
  organizationId: string;
  runnerId: string;
  credentialId: string;
  operationId: string;
  requestId: string;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  fencingTokenDigest: string;
  expectedLeaseExpiresAt: string;
  requestDigest: string;
  request: HostedHeartbeatRequestV1;
  state: "pending" | "acknowledged";
  createdAt: string;
  updatedAt: string;
  receiptDigest?: string;
  receipt?: HostedLifecycleReceiptEnvelopeV1;
  acceptedLeaseExpiresAt?: string;
  acknowledgedAt?: string;
};

export type HostedLifecycleOperationState = "pending" | "leased" | "acknowledged" | "attention";

export type HostedLifecycleOperation = {
  destinationId: string;
  organizationId: string;
  runnerId: string;
  credentialId: string;
  operationId: string;
  requestId: string;
  action: HostedLifecycleActionV1;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  fencingTokenDigest: string;
  requestDigest: string;
  businessKeyDigest: string;
  sequence: number;
  request: HostedLifecycleRequestV1;
  state: HostedLifecycleOperationState;
  attemptCount: number;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  receiptId?: string;
  receiptDigest?: string;
  receipt?: HostedLifecycleReceiptEnvelopeV1;
  lastReasonCode?: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
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
export type CallbackDeliveryStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "failed"
  | "attention";

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
  dispatchMode: "legacy" | "governed";
  governedState?: GovernedCallbackState;
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

export type GovernedCallbackState =
  | "pending"
  | "leased"
  | "sending"
  | "accepted"
  | "rejected"
  | "outcome_unknown"
  | "attention";

export type GovernedCallbackIntent = {
  localIntentId: string;
  idempotencyKey: string;
  destinationId: string;
  organizationId: string;
  runnerId: string;
  runId: string;
  workThreadId: string;
  provider: "github";
  operationId: string;
  payloadDigest: string;
  targetIdentityDigest: string;
  state: GovernedCallbackState;
  currentAttemptId?: string;
  currentAttemptNumber: number;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  lastReasonCode?: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
};

export type GovernedCallbackAttempt = {
  localAttemptId: string;
  localIntentId: string;
  attemptNumber: number;
  previousAttemptId?: string;
  retryAuthorizationId?: string;
  requestDigest: string;
  state: GovernedCallbackState;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  attemptedAt?: string;
  observedAt?: string;
  reasonCode?: string;
  nextAction?: string;
  owner?: string;
  providerReceiptId?: string;
  resourceIdentity?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaimedGovernedCallback = {
  intent: GovernedCallbackIntent;
  attempt: GovernedCallbackAttempt;
  delivery: CallbackDelivery;
  producer: {
    kind: "local_opentag";
    id: string;
    credentialId: string;
    registrationGeneration: number;
  };
  intentReceiptDigest: string;
  targetIdentityDigest: string;
  authority: {
    attemptId: string;
    attemptNumber: number;
    epoch: number;
    fencingTokenDigest: string;
    completionOperationId: string;
    assessmentReceiptId: string;
    assessmentReceiptDigest: string;
  };
};

export type GovernedCallbackEnqueueContext = {
  outcome: "ready";
  destinationId: string;
  organizationId: string;
  runnerId: string;
  producer: {
    kind: "local_opentag";
    id: string;
    credentialId: string;
    registrationGeneration: number;
  };
  sourceThreadIdentityDigest: string;
  assessmentReceipt: CompletionAssessmentReceiptEnvelopeV1;
  completionOperationId: string;
  authority: {
    attemptId: string;
    attemptNumber: number;
    epoch: number;
    fencingTokenDigest: string;
    admissionId: string;
    admissionOperationId: string;
    claimOperationId: string;
  };
};

export type GetGovernedCallbackEnqueueContextResult =
  | GovernedCallbackEnqueueContext
  | { outcome: "not_found" }
  | { outcome: "authority_conflict" };

export type GovernedCallbackScope = {
  destinationId: string;
  organizationId: string;
};

export type GovernedCallbackReconciliationEvidence =
  typeof CallbackProviderObservationReceiptEnvelopeV1Schema._output;

export type PriorAcceptedGovernedGitHubResource =
  | { outcome: "not_found" }
  | { outcome: "conflict" }
  | {
      outcome: "found";
      providerReceiptId: string;
      resourceIdentity: string;
      targetIdentityDigest: string;
    };

export type RepoBinding = {
  provider: string;
  owner: string;
  repo: string;
  runnerId: string;
  fallbackRunnerIds?: string[];
  workspacePath?: string;
  defaultExecutor?: string;
  fallbackExecutorIds?: string[];
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

export function managedChannelBindingAuthorityDigest(input: Pick<
  ChannelBinding,
  "provider" | "accountId" | "conversationId" | "ownership"
>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    provider: input.provider,
    accountId: input.accountId,
    conversationId: input.conversationId,
    ownership: input.ownership ?? null
  })).digest("hex")}`;
}

function principalOwnsManagedChannelBinding(
  principal: ManagedChannelPrincipalIdentity | undefined,
  binding: ChannelBinding
): boolean {
  if (!binding.ownership) return true;
  return principal?.provider === binding.provider
    && principal.applicationId === binding.ownership.applicationId
    && (!binding.ownership.botId || principal.botId === binding.ownership.botId);
}

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

export type RunnerRegistration = RunnerRegistrationConfig & {
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
  workstreamId?: string;
  admissionBatchId?: string;
  event: OpenTagEvent;
  decision: RunAdmissionDecision;
  accessProfileSnapshot?: AgentAccessProfileSnapshot;
  policySnapshotProvenance?: PolicySnapshotProvenance;
  routingPolicy?: FrozenRoutingPolicy;
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

export type StoredFactoryRecipeSnapshot = {
  id: string;
  version: number;
  recipe: FactoryRecipeSnapshotInput;
  contentDigest: string;
  createdAt: string;
};

export type StoredFactoryWorkstream = {
  id: string;
  recipeId: string;
  recipeVersion: number;
  workstream: WorkstreamInput;
  contentDigest: string;
  workThreadIds: string[];
  createdAt: string;
};

export type WorkstreamAdmissionBatchItem = {
  itemId: string;
  ordinal: number;
  runId: string;
  workThreadId: string;
  event: OpenTagEvent;
  status: "pending" | "processing" | "completed";
  leaseOwner?: string;
  leaseExpiresAt?: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type WorkstreamAdmissionBatch = {
  id: string;
  workstreamId: string;
  requestDigest: string;
  request: unknown;
  status: "processing" | "completed";
  leaseOwner?: string;
  leaseExpiresAt?: string;
  result?: unknown;
  items: WorkstreamAdmissionBatchItem[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type WorkstreamMetrics = {
  workstreamId: string;
  workThreadCount: number;
  acceptedWorkThreadCount: number;
  acceptedGateAdvanceCount: number;
  attributedGateAdvanceCount: number;
  unresolvedGateAdvanceCount: number;
  runsWithAcceptedProgressCount: number;
  runCount: number;
  queuedRunCount: number;
  activeRunCount: number;
  terminalRunCount: number;
  failedRunCount: number;
  needsHumanRunCount: number;
  budgetBlockedRunCount: number;
  totalAttempts: number;
  attemptsPerRunExceededCount: number;
  totalCostUnits: number;
  attemptsByLocality: { local: number; private: number; hosted: number; unknown: number };
  exceptionCount: number;
};

export type AttemptMutationConflict = "stale_attempt";
export type HeartbeatOutcome = "updated" | AttemptMutationConflict | "not_found";
export type RecordProgressOutcome =
  | { outcome: "recorded" | "duplicate"; event: OpenTagAuditEvent }
  | AttemptMutationConflict
  | "not_found";
export type MarkRunningOutcome = "running" | "duplicate" | AttemptMutationConflict | "not_found";
export type RejectAttemptStartOutcome = "requeued" | "duplicate" | AttemptMutationConflict | "not_found";
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

const projectionEnvelopeSchemas = {
  runner_readiness: RunnerReadinessReceiptEnvelopeV1Schema,
  work_thread_ref: WorkThreadRefReceiptEnvelopeV1Schema,
  completion_contract_ref: CompletionContractRefReceiptEnvelopeV1Schema,
  completion_evidence_observation: CompletionEvidenceObservationReceiptEnvelopeV1Schema,
  completion_assessment: CompletionAssessmentReceiptEnvelopeV1Schema,
  callback_intent_observation: CallbackIntentObservationReceiptEnvelopeV1Schema,
  callback_attempt_observation: CallbackAttemptObservationReceiptEnvelopeV1Schema,
  callback_provider_observation: CallbackProviderObservationReceiptEnvelopeV1Schema
} as const;

const PROJECTION_SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/#-]*$/u;
const PROJECTION_FORBIDDEN_FIELD = /^(?:uri|url|body|headers?|comment|credential|path|command|context)$/iu;

function isProjectionTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRfc3339Instant(value: string): boolean {
  try {
    return compareRfc3339Timestamps(value, value) === 0;
  } catch {
    return false;
  }
}

function toControlTimestamp(value: string): string {
  if (!isRfc3339Instant(value)) throw new Error("projection_timestamp_invalid");
  return new Date(value).toISOString();
}

function assertProjectionMutableReference(value: string): void {
  assertProjectionCustodySafe(value);
}

function parseControlPlaneProjectionEnvelope(input: unknown): ControlPlaneProjectionEnvelope {
  const receiptKind = input && typeof input === "object"
    ? (input as { receiptKind?: unknown }).receiptKind
    : undefined;
  if (typeof receiptKind !== "string" || !(receiptKind in projectionEnvelopeSchemas)) {
    throw new ControlPlaneProjectionOutboxValidationError("projection_envelope_invalid");
  }
  const parsed = projectionEnvelopeSchemas[receiptKind as keyof typeof projectionEnvelopeSchemas].safeParse(input);
  if (!parsed.success) throw new ControlPlaneProjectionOutboxValidationError("projection_envelope_invalid");
  return parsed.data as ControlPlaneProjectionEnvelope;
}

function assertProjectionCustodySafe(value: unknown, path: string[] = []): void {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
          throw new ControlPlaneProjectionOutboxValidationError("projection_invalid_unicode");
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new ControlPlaneProjectionOutboxValidationError("projection_invalid_unicode");
      }
    }
    if (
      containsCredentialLikeData(value)
      || !PROJECTION_SAFE_REFERENCE.test(value)
      || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)
      || /^(?:\/|~\/|[A-Za-z]:[\\/])/u.test(value)
      || /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(value)
    ) {
      throw new ControlPlaneProjectionOutboxValidationError("projection_custody_violation");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertProjectionCustodySafe(child, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    const digestReference = /Digest$/u.test(key);
    const allowedCredentialReference = childPath.join(".") === "producer.credentialId";
    if (
      PROJECTION_FORBIDDEN_FIELD.test(key)
      || (isCredentialFieldName(key) && !digestReference && !allowedCredentialReference)
    ) {
      throw new ControlPlaneProjectionOutboxValidationError("projection_custody_violation");
    }
    assertProjectionCustodySafe(child, childPath);
  }
}

function projectionIdentityKey(envelope: ControlPlaneProjectionEnvelope): string {
  return canonicalSha256Json({
    namespace: envelope.identity.namespace,
    parts: envelope.identity.parts
  });
}

function assertProjectionDigests(envelope: ControlPlaneProjectionEnvelope): void {
  const payloadDigest = canonicalSha256Json(envelope.payload);
  const { receiptDigest: _receiptDigest, ...receiptContent } = envelope;
  const receiptDigest = canonicalSha256Json(receiptContent);
  if (envelope.payloadDigest !== payloadDigest || envelope.receiptDigest !== receiptDigest) {
    throw new ControlPlaneProjectionOutboxValidationError("projection_digest_mismatch");
  }
}

function projectionOutboxEntryFromRow(
  row: typeof controlPlaneProjectionOutbox.$inferSelect
): ControlPlaneProjectionOutboxEntry {
  const state = row.state as ControlPlaneProjectionOutboxState;
  if (!["pending", "leased", "acknowledged", "attention"].includes(state)) {
    throw new Error("control_plane_projection_outbox_state_invalid");
  }
  let envelope: ControlPlaneProjectionEnvelope;
  try {
    envelope = parseControlPlaneProjectionEnvelope(JSON.parse(row.envelopeJson));
    assertProjectionCustodySafe(envelope);
    assertProjectionDigests(envelope);
  } catch {
    throw new Error("control_plane_projection_outbox_row_invalid");
  }
  const runnerId = envelope.receiptKind === "runner_readiness"
    ? envelope.payload.runnerId
    : null;
  const runId = "runId" in envelope ? envelope.runId : null;
  const workThreadId = "workThreadId" in envelope ? envelope.workThreadId : null;
  const timestampValues = [
    row.createdAt,
    row.updatedAt,
    ...(row.nextAttemptAt ? [row.nextAttemptAt] : []),
    ...(row.leaseExpiresAt ? [row.leaseExpiresAt] : []),
    ...(row.acknowledgedAt ? [row.acknowledgedAt] : [])
  ];
  const validMutableShape = Number.isInteger(row.attemptCount)
    && row.attemptCount >= 0
    && timestampValues.every(isProjectionTimestamp)
    && row.updatedAt >= row.createdAt
    && (row.lastHttpStatus === null
      || (Number.isInteger(row.lastHttpStatus) && row.lastHttpStatus >= 100 && row.lastHttpStatus <= 599))
    && (state !== "pending" || (
      row.nextAttemptAt !== null
      && row.nextAttemptAt >= row.updatedAt
      && row.leaseOwner === null
      && row.leaseToken === null
      && row.leaseExpiresAt === null
      && row.acknowledgedAt === null
    ))
    && (state !== "leased" || (
      row.nextAttemptAt !== null
      && row.leaseOwner !== null
      && row.leaseToken !== null
      && row.leaseExpiresAt !== null
      && row.leaseExpiresAt > row.updatedAt
      && row.acknowledgedAt === null
    ))
    && (state !== "acknowledged" || (
      row.nextAttemptAt === null
      && row.leaseOwner === null
      && row.leaseToken === null
      && row.leaseExpiresAt === null
      && row.acknowledgedAt !== null
      && row.acknowledgedAt >= row.updatedAt
    ))
    && (state !== "attention" || (
      row.nextAttemptAt === null
      && row.leaseOwner === null
      && row.leaseToken === null
      && row.leaseExpiresAt === null
      && row.acknowledgedAt === null
      && row.lastReasonCode !== null
    ));
  try {
    if (row.lastReasonCode !== null) assertProjectionMutableReference(row.lastReasonCode);
    if (row.leaseOwner !== null) assertProjectionMutableReference(row.leaseOwner);
    if (row.leaseToken !== null) assertProjectionMutableReference(row.leaseToken);
    if (row.dependsOnReceiptId !== null) assertProjectionMutableReference(row.dependsOnReceiptId);
    if (row.requiresLifecycleOperationId !== null) {
      assertProjectionMutableReference(row.requiresLifecycleOperationId);
    }
  } catch {
    throw new Error("control_plane_projection_outbox_row_invalid");
  }
  if (
    !validMutableShape
    || row.receiptId !== envelope.receiptId
    || row.organizationId !== envelope.organizationId
    || row.runnerId !== runnerId
    || row.runId !== runId
    || row.workThreadId !== workThreadId
    || row.receiptKind !== envelope.receiptKind
    || row.identityNamespace !== envelope.identity.namespace
    || row.identityPartsJson !== JSON.stringify(envelope.identity.parts)
    || row.identityKey !== projectionIdentityKey(envelope)
    || row.operationId !== envelope.operationId
    || row.payloadDigest !== envelope.payloadDigest
    || row.receiptDigest !== envelope.receiptDigest
    || row.envelopeJson !== canonicalJsonStringify(envelope)
  ) {
    throw new Error("control_plane_projection_outbox_row_invalid");
  }
  return {
    receiptId: row.receiptId,
    destinationId: row.destinationId,
    organizationId: row.organizationId,
    ...(row.runnerId ? { runnerId: row.runnerId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.workThreadId ? { workThreadId: row.workThreadId } : {}),
    receiptKind: row.receiptKind as ControlPlaneProjectionEnvelope["receiptKind"],
    identity: {
      namespace: row.identityNamespace,
      parts: JSON.parse(row.identityPartsJson) as string[],
      key: row.identityKey
    },
    operationId: row.operationId,
    ...(row.dependsOnReceiptId ? { dependsOnReceiptId: row.dependsOnReceiptId } : {}),
    ...(row.requiresLifecycleOperationId
      ? { requiresLifecycleOperationId: row.requiresLifecycleOperationId }
      : {}),
    payloadDigest: row.payloadDigest,
    receiptDigest: row.receiptDigest,
    envelope,
    state,
    attemptCount: row.attemptCount,
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.lastReasonCode ? { lastReasonCode: row.lastReasonCode } : {}),
    ...(row.lastHttpStatus !== null ? { lastHttpStatus: row.lastHttpStatus } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.acknowledgedAt ? { acknowledgedAt: row.acknowledgedAt } : {})
  };
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

function factoryRecipeSnapshotFromRow(row: typeof factoryRecipeSnapshots.$inferSelect): StoredFactoryRecipeSnapshot {
  return {
    id: row.id,
    version: row.version,
    recipe: FactoryRecipeSnapshotInputSchema.parse(JSON.parse(row.recipeJson)),
    contentDigest: row.contentDigest,
    createdAt: row.createdAt
  };
}

function factoryWorkstreamFromRows(
  row: typeof factoryWorkstreams.$inferSelect,
  members: Array<Pick<typeof factoryWorkstreamMembers.$inferSelect, "workThreadId">>
): StoredFactoryWorkstream {
  return {
    id: row.id,
    recipeId: row.recipeId,
    recipeVersion: row.recipeVersion,
    workstream: WorkstreamInputSchema.parse(JSON.parse(row.workstreamJson)),
    contentDigest: row.contentDigest,
    workThreadIds: members.map((member) => member.workThreadId).sort(),
    createdAt: row.createdAt
  };
}

function admissionBatchItemFromRow(row: typeof workstreamAdmissionBatchItems.$inferSelect): WorkstreamAdmissionBatchItem {
  return {
    itemId: row.itemId,
    ordinal: row.ordinal,
    runId: row.runId,
    workThreadId: row.workThreadId,
    event: OpenTagEventSchema.parse(JSON.parse(row.eventJson)),
    status: row.status as WorkstreamAdmissionBatchItem["status"],
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.resultJson ? { result: JSON.parse(row.resultJson) as unknown } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {})
  };
}

function admissionBatchFromRows(
  row: typeof workstreamAdmissionBatches.$inferSelect,
  items: Array<typeof workstreamAdmissionBatchItems.$inferSelect>
): WorkstreamAdmissionBatch {
  return {
    id: row.id,
    workstreamId: row.workstreamId,
    requestDigest: row.requestDigest,
    request: JSON.parse(row.requestJson) as unknown,
    status: row.status as WorkstreamAdmissionBatch["status"],
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.resultJson ? { result: JSON.parse(row.resultJson) as unknown } : {}),
    items: items.sort((left, right) => left.ordinal - right.ordinal).map(admissionBatchItemFromRow),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {})
  };
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

function reassessmentObligationFromRow(
  row: typeof reassessmentObligations.$inferSelect
): ReassessmentObligation {
  return ReassessmentObligationSchema.parse({
    id: row.id,
    workThreadId: row.workThreadId,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    sourceDigest: row.sourceDigest,
    notBefore: row.notBefore,
    state: row.state,
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    attemptCount: row.attemptCount,
    ...(row.lastReasonCode ? { lastReasonCode: row.lastReasonCode } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.satisfiedAssessmentId ? { satisfiedAssessmentId: row.satisfiedAssessmentId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

function reassessmentObligationValues(
  input: EnqueueReassessmentObligationInput
): typeof reassessmentObligations.$inferInsert {
  const sourceKind = ReassessmentObligationSourceKindSchema.parse(input.sourceKind);
  const sourceId = OpenTagEventSchema.shape.id.parse(input.sourceId);
  const sourceDigest = input.sourceDigest;
  const createdAt = OpenTagEventSchema.shape.receivedAt.parse(input.createdAt ?? nowIso());
  const notBefore = OpenTagEventSchema.shape.receivedAt.parse(input.notBefore ?? createdAt);
  const identityDigest = canonicalSha256Json({ sourceKind, sourceId, sourceDigest });
  const obligation = ReassessmentObligationSchema.parse({
    id: `reassessment_${identityDigest.slice("sha256:".length, "sha256:".length + 32)}`,
    workThreadId: input.workThreadId,
    sourceKind,
    sourceId,
    sourceDigest,
    notBefore,
    state: "pending",
    attemptCount: 0,
    createdAt,
    updatedAt: createdAt
  });
  return obligation;
}

function verificationEvidenceAttachmentObligation(input: {
  workThreadId: string;
  provider: string;
  deliveryId: string;
  subjectRef: string;
  records: Array<Pick<typeof verificationEvidenceRecords.$inferSelect, "id" | "payloadDigest">>;
  at: string;
}): typeof reassessmentObligations.$inferInsert {
  const sourceId = [input.provider, input.deliveryId, input.subjectRef, input.workThreadId].join(":");
  const sourceDigest = canonicalSha256Json({
    workThreadId: input.workThreadId,
    provider: input.provider,
    deliveryId: input.deliveryId,
    subjectRef: input.subjectRef,
    records: input.records
      .map((record) => ({ id: record.id, payloadDigest: record.payloadDigest }))
      .sort((left, right) => left.id.localeCompare(right.id))
  });
  return reassessmentObligationValues({
    workThreadId: input.workThreadId,
    sourceKind: "verification_evidence_attached",
    sourceId,
    sourceDigest,
    notBefore: input.at,
    createdAt: input.at
  });
}

function humanEscalationReassessmentObligation(
  escalation: HumanEscalation,
  at: string
): typeof reassessmentObligations.$inferInsert {
  return reassessmentObligationValues({
    workThreadId: escalation.workThreadId,
    sourceKind: "human_escalation_changed",
    sourceId: escalation.id,
    sourceDigest: canonicalSha256Json(escalation),
    notBefore: at,
    createdAt: at
  });
}

function sanitizeReassessmentError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const sanitized = String(sanitizeCredentialLikeValue(error)).slice(0, 4096);
  return sanitized || undefined;
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

function hostedClaimOperationFromRow(
  row: typeof hostedClaimOperations.$inferSelect
): HostedClaimOperation {
  return {
    operationId: row.operationId,
    requestId: row.requestId,
    organizationId: row.organizationId,
    runnerId: row.runnerId,
    destinationId: row.destinationId,
    requestDigest: row.requestDigest,
    request: HostedClaimRequestV1Schema.parse(JSON.parse(row.requestJson)),
    state: row.state as HostedClaimOperation["state"],
    ...(row.runId ? { runId: row.runId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.acknowledgedAt ? { acknowledgedAt: row.acknowledgedAt } : {}),
    ...(row.executionStartedAt ? { executionStartedAt: row.executionStartedAt } : {}),
    ...(row.terminalReasonCode
      ? { terminalReasonCode: row.terminalReasonCode as "stale_control_authority" | "operation_digest_conflict" }
      : {})
  };
}

function hostedLifecycleOperationFromRow(
  row: typeof hostedLifecycleOperations.$inferSelect
): HostedLifecycleOperation {
  return {
    destinationId: row.destinationId,
    organizationId: row.organizationId,
    runnerId: row.runnerId,
    credentialId: row.credentialId,
    operationId: row.operationId,
    requestId: row.requestId,
    action: row.action as HostedLifecycleActionV1,
    runId: row.runId,
    attemptId: row.attemptId,
    attemptNumber: row.attemptNumber,
    fencingTokenDigest: row.fencingTokenDigest,
    requestDigest: row.requestDigest,
    businessKeyDigest: row.businessKeyDigest,
    sequence: row.sequence,
    request: HostedLifecycleRequestV1Schema.parse(JSON.parse(row.requestJson)),
    state: row.state as HostedLifecycleOperationState,
    attemptCount: row.attemptCount,
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.receiptId ? { receiptId: row.receiptId } : {}),
    ...(row.receiptDigest ? { receiptDigest: row.receiptDigest } : {}),
    ...(row.receiptJson
      ? { receipt: HostedLifecycleReceiptEnvelopeV1Schema.parse(JSON.parse(row.receiptJson)) }
      : {}),
    ...(row.lastReasonCode ? { lastReasonCode: row.lastReasonCode } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.acknowledgedAt ? { acknowledgedAt: row.acknowledgedAt } : {})
  };
}

function hostedLifecycleRequestDigestSync(input: {
  organizationId: string;
  runnerId: string;
  runId: string;
  action: HostedLifecycleActionV1;
  request: HostedLifecycleRequestV1;
}): string {
  const { request } = input;
  const common = {
    operation: input.action,
    organizationId: input.organizationId,
    runnerId: input.runnerId,
    runId: input.runId,
    schemaVersion: request.schemaVersion,
    protocolVersion: request.protocolVersion,
    requiredCapabilities: request.requiredCapabilities,
    attempt: {
      attemptId: request.attempt.attemptId,
      attemptNumber: request.attempt.attemptNumber,
      epoch: request.attempt.epoch,
      fencingTokenDigest: request.attempt.fencingTokenDigest,
    },
    occurredAt: request.occurredAt,
  };
  const actionFields = input.action === "heartbeat"
    ? {
        expectedLeaseExpiresAt:
          HostedHeartbeatRequestV1Schema.parse(request).expectedLeaseExpiresAt,
      }
    : input.action === "running"
      ? (() => {
          const value = request as Extract<HostedLifecycleRequestV1, { executorCapabilityDigest: string }>;
          return {
            executorId: value.executorId,
            executorCapabilityDigest: value.executorCapabilityDigest,
            ...(value.runTimeoutMs ? { runTimeoutMs: value.runTimeoutMs } : {}),
          };
        })()
      : input.action === "reject-start"
        ? (() => {
            const value = request as Extract<HostedLifecycleRequestV1, { reasonCode: string; executorId: string }>;
            return { executorId: value.executorId, reasonCode: value.reasonCode };
          })()
        : input.action === "progress"
          ? (() => {
              const value = request as Extract<HostedLifecycleRequestV1, { progressId: string }>;
              return { progressId: value.progressId, progressDigest: value.progressDigest };
            })()
          : (() => {
              const value = HostedCompleteRequestV1Schema.parse(request);
              return {
                conclusion: value.conclusion,
                reasonCode: value.reasonCode,
                resultDigest: value.resultDigest,
                artifactDigests: value.artifactDigests,
                evidenceDigests: value.evidenceDigests,
              };
            })();
  return canonicalSha256Json({ ...common, ...actionFields });
}

function validAcknowledgedLifecycleDependency(
  row: typeof hostedLifecycleOperations.$inferSelect,
): boolean {
  try {
    if (row.state !== "acknowledged" || !row.receiptJson) return false;
    const action = row.action as HostedLifecycleActionV1;
    const request = HostedLifecycleRequestV1Schema.parse(JSON.parse(row.requestJson));
    const receipt = HostedLifecycleReceiptEnvelopeV1Schema.parse(
      JSON.parse(row.receiptJson),
    );
    const expectedOperation = action === "reject-start"
      ? "reject_start"
      : action === "complete"
        ? "executor_result"
        : action;
    const expectedRequestDigest = hostedLifecycleRequestDigestSync({
      organizationId: row.organizationId,
      runnerId: row.runnerId,
      runId: row.runId,
      action,
      request,
    });
    const expectedOperationId = computeHostedLifecycleOperationIdV1(
      expectedRequestDigest,
    );
    const expectedRequestId = `req_${canonicalSha256Json({
      purpose: "opentag-hosted-lifecycle-request-id-v1",
      operationId: expectedOperationId,
      requestDigest: expectedRequestDigest,
    }).slice("sha256:".length)}`;
    const expectedReceiptId = `lifecycle_${canonicalSha256Json({
      organizationId: row.organizationId,
      operationId: expectedOperationId,
    }).slice("sha256:".length)}`;
    const expectedPayload = action === "heartbeat"
      ? {
          operation: expectedOperation,
          occurredAt: request.occurredAt,
          leaseExpiresAt: (receipt.payload as { leaseExpiresAt: string }).leaseExpiresAt,
        }
      : action === "running"
        ? (() => {
            const value = request as Extract<HostedLifecycleRequestV1, { executorCapabilityDigest: string }>;
            return {
              operation: expectedOperation,
              occurredAt: value.occurredAt,
              executorId: value.executorId,
              executorCapabilityDigest: value.executorCapabilityDigest,
              ...(value.runTimeoutMs ? { runTimeoutMs: value.runTimeoutMs } : {}),
            };
          })()
        : action === "reject-start"
          ? (() => {
              const value = request as Extract<HostedLifecycleRequestV1, { reasonCode: string; executorId: string }>;
              return {
                operation: expectedOperation,
                occurredAt: value.occurredAt,
                executorId: value.executorId,
                reasonCode: value.reasonCode,
              };
            })()
          : action === "progress"
            ? (() => {
                const value = request as Extract<HostedLifecycleRequestV1, { progressId: string }>;
                return {
                  operation: expectedOperation,
                  occurredAt: value.occurredAt,
                  progressId: value.progressId,
                  progressDigest: value.progressDigest,
                };
              })()
            : (() => {
                const value = HostedCompleteRequestV1Schema.parse(request);
                return {
                  operation: expectedOperation,
                  occurredAt: value.occurredAt,
                  conclusion: value.conclusion,
                  reasonCode: value.reasonCode,
                  resultDigest: value.resultDigest,
                  artifactDigests: value.artifactDigests,
                  evidenceDigests: value.evidenceDigests,
                };
              })();
    const { receiptDigest: _receiptDigest, ...receiptWithoutDigest } = receipt;
    return row.requestJson === canonicalJsonStringify(request)
      && row.receiptJson === canonicalJsonStringify(receipt)
      && row.action === action
      && row.operationId === expectedOperationId
      && row.requestId === expectedRequestId
      && row.requestDigest === expectedRequestDigest
      && row.attemptId === request.attempt.attemptId
      && row.attemptNumber === request.attempt.attemptNumber
      && row.fencingTokenDigest === request.attempt.fencingTokenDigest
      && request.requestDigest === expectedRequestDigest
      && request.operationId === expectedOperationId
      && request.requestId === expectedRequestId
      && request.attempt.epoch === request.attempt.attemptNumber
      && row.receiptId === expectedReceiptId
      && row.receiptDigest === receipt.receiptDigest
      && receipt.receiptId === expectedReceiptId
      && receipt.organizationId === row.organizationId
      && receipt.runId === row.runId
      && receipt.operationId === row.operationId
      && receipt.requestId === row.requestId
      && receipt.requestDigest === row.requestDigest
      && receipt.producer.id === row.runnerId
      && receipt.producer.credentialId === row.credentialId
      && receipt.attempt.attemptId === row.attemptId
      && receipt.attempt.attemptNumber === row.attemptNumber
      && receipt.attempt.epoch === row.attemptNumber
      && receipt.attempt.fencingTokenDigest === row.fencingTokenDigest
      && receipt.payload.operation === expectedOperation
      && canonicalJsonStringify(receipt.payload)
        === canonicalJsonStringify(expectedPayload)
      && canonicalJsonStringify(receipt.identity.parts) === canonicalJsonStringify([
        row.organizationId,
        row.runId,
        row.attemptId,
        expectedOperation,
        row.operationId,
      ])
      && receipt.payloadDigest === canonicalSha256Json(receipt.payload)
      && receipt.receiptDigest === canonicalSha256Json(receiptWithoutDigest)
      && (
        action !== "heartbeat"
        || Date.parse((receipt.payload as { leaseExpiresAt: string }).leaseExpiresAt)
          > Date.parse(HostedHeartbeatRequestV1Schema.parse(request).expectedLeaseExpiresAt)
      );
  } catch {
    return false;
  }
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function completionFactFromStoredEvidence(input: {
  evidence: VerificationEvidence;
  workThreadId: string;
}): CompletionEvidenceFact | null {
  const metadata = input.evidence.metadata;
  const direct = metadata?.["completionFact"];
  const template = metadata?.["completionFactTemplate"];
  if (direct !== undefined && template !== undefined) return null;
  const candidate = direct ?? (isPlainRecord(template)
    ? { ...template, workThreadId: input.workThreadId }
    : undefined);
  if (!isPlainRecord(candidate) || !hasOnlyKeys(candidate, [
    "id",
    "workThreadId",
    "cycle",
    "kind",
    "assurance",
    "subject",
    "claim",
    "provenance",
    "observedAt",
    "receivedAt"
  ])) return null;
  const subject = candidate["subject"];
  const claim = candidate["claim"];
  const provenance = candidate["provenance"];
  if (
    typeof candidate["id"] !== "string"
    || typeof candidate["workThreadId"] !== "string"
    || !Number.isSafeInteger(candidate["cycle"])
    || (candidate["cycle"] as number) <= 0
    || typeof candidate["kind"] !== "string"
    || !["verified", "reported", "unverifiable"].includes(
      candidate["assurance"] as string
    )
    || typeof candidate["observedAt"] !== "string"
    || typeof candidate["receivedAt"] !== "string"
    || !isPlainRecord(subject)
    || !hasOnlyKeys(subject, ["provider", "resourceRef", "resourceVersion"])
    || typeof subject["provider"] !== "string"
    || typeof subject["resourceRef"] !== "string"
    || typeof subject["resourceVersion"] !== "string"
    || !isPlainRecord(claim)
    || !hasOnlyKeys(claim, ["predicate", "outcome", "observations"])
    || typeof claim["predicate"] !== "string"
    || typeof claim["outcome"] !== "string"
    || !isPlainRecord(provenance)
    || !hasOnlyKeys(provenance, [
      "adapter",
      "adapterVersion",
      "payloadDigest",
      "sourceEventId",
      "providerDeliveryId"
    ])
    || typeof provenance["adapter"] !== "string"
    || typeof provenance["adapterVersion"] !== "string"
    || typeof provenance["payloadDigest"] !== "string"
    || (provenance["sourceEventId"] !== undefined
      && typeof provenance["sourceEventId"] !== "string")
    || (provenance["providerDeliveryId"] !== undefined
      && typeof provenance["providerDeliveryId"] !== "string")
  ) return null;
  const observations = claim["observations"];
  if (
    observations !== undefined
    && (!isPlainRecord(observations)
      || Object.values(observations).some((value) => typeof value !== "string"))
  ) return null;
  return {
    id: candidate["id"],
    workThreadId: candidate["workThreadId"],
    cycle: candidate["cycle"] as number,
    kind: candidate["kind"],
    assurance: candidate["assurance"] as CompletionEvidenceFact["assurance"],
    subject: {
      provider: subject["provider"],
      resourceRef: subject["resourceRef"],
      resourceVersion: subject["resourceVersion"]
    },
    claim: {
      predicate: claim["predicate"],
      outcome: claim["outcome"],
      ...(observations
        ? { observations: observations as Record<string, string> }
        : {})
    },
    provenance: {
      adapter: provenance["adapter"],
      adapterVersion: provenance["adapterVersion"],
      payloadDigest: provenance["payloadDigest"],
      ...(typeof provenance["sourceEventId"] === "string"
        ? { sourceEventId: provenance["sourceEventId"] }
        : {}),
      ...(typeof provenance["providerDeliveryId"] === "string"
        ? { providerDeliveryId: provenance["providerDeliveryId"] }
        : {})
    },
    observedAt: candidate["observedAt"],
    receivedAt: candidate["receivedAt"]
  };
}

function storedEvidenceClaimsCompletionFact(
  evidence: VerificationEvidence
): boolean {
  const metadata = evidence.metadata;
  return metadata !== undefined
    && (
      Object.prototype.hasOwnProperty.call(metadata, "completionFact")
      || Object.prototype.hasOwnProperty.call(metadata, "completionFactTemplate")
    );
}

function completionAssuranceAccepted(
  actual: CompletionEvidenceFact["assurance"],
  minimum: "verified" | "reported"
): boolean {
  return minimum === "verified"
    ? actual === "verified"
    : actual === "verified" || actual === "reported";
}

function githubPullRequestResourceRef(input: {
  uri: string;
  owner: string;
  repo: string;
}): string | null {
  let url: URL;
  try {
    url = new URL(input.uri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(url.pathname);
  if (
    !match
    || match[1]!.toLowerCase() !== input.owner.toLowerCase()
    || match[2]!.toLowerCase() !== input.repo.toLowerCase()
  ) return null;
  return `github:${input.owner}/${input.repo}:pull_request:${match[3]}`;
}

function isAutomaticWorkstreamContinuationActionJson(value: string | null): boolean {
  if (!value) return false;
  try {
    const action = ActionHintSchema.safeParse(JSON.parse(value));
    return action.success
      && action.data.kind === "resume_work_thread"
      && action.data.metadata?.["workstreamContinuation"] === true;
  } catch {
    // An unreadable action cannot safely prove that a queued Run is unrelated.
    return true;
  }
}

type CurrentAssessmentAuthorityRow = {
  assessmentId: string;
  threadId: string;
  persistedThreadId: string;
  assessmentJson: string;
  waiverId: string | null;
  waiverWorkThreadId: string | null;
  waiverContractId: string | null;
  waiverContractVersion: number | null;
  waiverCycle: number | null;
  waiverContentDigest: string | null;
  waiverJson: string | null;
};

function currentAssessmentIsAccepted(row: CurrentAssessmentAuthorityRow, evaluatedAt: string): boolean {
  try {
    const assessment = CompletionAssessmentSchema.parse(JSON.parse(row.assessmentJson));
    if (
      assessment.id !== row.assessmentId
      || assessment.workThreadId !== row.threadId
      || row.persistedThreadId !== row.threadId
    ) {
      return false;
    }
    if (assessment.state === "satisfied") return assessment.evidenceBacked;
    if (assessment.state !== "waived" || !assessment.evidenceBacked || !assessment.waiver) return false;

    const waiver = assessment.waiver;
    if (
      !row.waiverJson
      || row.waiverId !== waiver.id
      || row.waiverWorkThreadId !== row.threadId
      || row.waiverContractId !== assessment.contractId
      || row.waiverContractVersion !== assessment.contractVersion
      || row.waiverCycle !== assessment.cycle
      || compareRfc3339Timestamps(waiver.waivedAt, evaluatedAt) > 0
      || (waiver.expiresAt !== undefined
        && compareRfc3339Timestamps(waiver.expiresAt, evaluatedAt) <= 0)
      || (waiver.runId !== undefined && waiver.runId !== assessment.triggeredByRunId)
    ) {
      return false;
    }
    const persistedWaiver = CompletionWaiverSchema.parse(JSON.parse(row.waiverJson));
    const { id: _id, ...semanticWaiver } = waiver;
    const expectedDigest = `sha256:${sha256(stableActionJson(semanticWaiver))}`;
    const waivedGateIds = assessment.gateResults
      .filter((gate) => gate.state === "waived")
      .map((gate) => gate.gateId);
    return row.waiverContentDigest === expectedDigest
      && JSON.stringify(persistedWaiver) === JSON.stringify(waiver)
      && waivedGateIds.length > 0
      && waivedGateIds.every((gateId) => waiver.gateIds.includes(gateId));
  } catch {
    return false;
  }
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

class GovernedCallbackEnqueueValidationError extends Error {}

function governedCallbackEnqueueConflict(): never {
  throw new GovernedCallbackEnqueueValidationError();
}

function parseGovernedCallbackEnqueueJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) governedCallbackEnqueueConflict();
    throw error;
  }
}

function parseGovernedCallbackEnqueueSchema<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false };
  },
  json: string
): T {
  const parsed = schema.safeParse(parseGovernedCallbackEnqueueJson(json));
  if (!parsed.success) governedCallbackEnqueueConflict();
  return parsed.data;
}

function governedCallbackEnqueueAuthorityFromJson(
  authorityJson: string
): HostedClaimV1["authority"] {
  try {
    return hostedClaimAuthoritySnapshotFromJson(authorityJson);
  } catch (error) {
    if (
      error instanceof SyntaxError
      || (error instanceof Error
        && error.message === "hosted claim authority snapshot invalid")
    ) governedCallbackEnqueueConflict();
    throw error;
  }
}

function governedCallbackEnqueueProjectionFromRow(
  row: typeof controlPlaneProjectionOutbox.$inferSelect
): ControlPlaneProjectionOutboxEntry {
  try {
    return projectionOutboxEntryFromRow(row);
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message === "control_plane_projection_outbox_state_invalid"
        || error.message === "control_plane_projection_outbox_row_invalid"
      )
    ) governedCallbackEnqueueConflict();
    throw error;
  }
}

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
    dispatchMode: row.dispatchMode as "legacy" | "governed",
    ...(row.governedState ? { governedState: row.governedState as GovernedCallbackState } : {}),
    status: row.status as CallbackDeliveryStatus,
    attempts: row.attempts,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function governedCallbackCanonicalPayload(row: typeof callbackDeliveries.$inferSelect) {
  const metadata = callbackDeliveryMetadataFromJson(row.metadataJson);
  return {
    method: "POST",
    mode: row.kind,
    target: row.uri,
    body: row.body,
    threadKey: row.threadKey,
    agentId: metadata?.agentId ?? null,
    statusMessageKey: metadata?.statusMessageKey ?? null,
    blocks: metadata?.blocks ?? null,
    rich: metadata && "rich" in metadata ? metadata.rich : null
  };
}

function governedCallbackPayloadDigest(
  row: typeof callbackDeliveries.$inferSelect
): string {
  return canonicalSha256Json(governedCallbackCanonicalPayload(row));
}

const HOSTED_CLAIM_AUTHORITY_KEYS = [
  "organizationId", "runnerId", "runId", "credentialId",
  "registrationGeneration", "credentialGeneration", "projectTargetId",
  "bindingId", "targetBindingDigest", "admissionPolicyReceiptId",
  "admissionPolicySnapshotId", "admissionPolicySnapshotDigest",
  "runnerReadinessReceiptId", "runnerReadinessReceiptDigest",
  "targetReadinessReceiptId", "targetReadinessReceiptDigest", "executorId",
  "executorCapabilityDigest", "attemptId", "attemptNumber", "epoch",
  "fencingTokenDigest"
] as const;

function hostedClaimAuthoritySnapshotFromJson(
  authorityJson: string
): HostedClaimV1["authority"] {
  const value = JSON.parse(authorityJson) as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [...HOSTED_CLAIM_AUTHORITY_KEYS].sort();
  const integerKeys = [
    "registrationGeneration", "credentialGeneration", "attemptNumber", "epoch"
  ] as const;
  const digestKeys = [
    "targetBindingDigest", "admissionPolicySnapshotDigest",
    "runnerReadinessReceiptDigest", "targetReadinessReceiptDigest",
    "executorCapabilityDigest", "fencingTokenDigest"
  ] as const;
  const stringKeys = HOSTED_CLAIM_AUTHORITY_KEYS.filter(
    (key) => !(integerKeys as readonly string[]).includes(key)
  );
  if (
    canonicalJsonStringify(keys) !== canonicalJsonStringify(expectedKeys)
    || stringKeys.some((key) => typeof value[key] !== "string" || value[key] === "")
    || digestKeys.some((key) => !/^sha256:[0-9a-f]{64}$/u.test(value[key] as string))
    || integerKeys.some((key) => !Number.isInteger(value[key]) || (value[key] as number) <= 0)
    || value.epoch !== value.attemptNumber
    || value.runnerReadinessReceiptId !== value.targetReadinessReceiptId
    || value.runnerReadinessReceiptDigest !== value.targetReadinessReceiptDigest
  ) throw new Error("hosted claim authority snapshot invalid");
  return value as HostedClaimV1["authority"];
}

function governedCallbackIntentFromRow(
  row: typeof governedCallbackIntents.$inferSelect
): GovernedCallbackIntent {
  return {
    localIntentId: row.localIntentId,
    idempotencyKey: row.idempotencyKey,
    destinationId: row.destinationId,
    organizationId: row.organizationId,
    runnerId: row.runnerId,
    runId: row.runId,
    workThreadId: row.workThreadId,
    provider: "github",
    operationId: row.operationId,
    payloadDigest: row.payloadDigest,
    targetIdentityDigest: row.targetIdentityDigest,
    state: row.state as GovernedCallbackState,
    currentAttemptNumber: row.currentAttemptNumber,
    ...(row.currentAttemptId ? { currentAttemptId: row.currentAttemptId } : {}),
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.lastReasonCode ? { lastReasonCode: row.lastReasonCode } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.terminalAt ? { terminalAt: row.terminalAt } : {})
  };
}

function governedCallbackEventTarget(input: {
  eventJson: string;
  eventDigest: string;
  deliveryTarget: string;
  targetIdentityDigest: string;
}): { issueNumber: number; resourceIdentity: string } {
  const event = OpenTagEventSchema.parse(JSON.parse(input.eventJson));
  if (canonicalSha256Json(event) !== input.eventDigest) {
    throw new Error("governed callback event digest mismatch");
  }
  const project = projectTargetRefFromEvent(event);
  const issueNumber = event.metadata?.["issueNumber"]
    ?? event.metadata?.["pullRequestNumber"];
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/comments$/u
    .exec(input.deliveryTarget);
  if (
    !project || project.provider !== "github" || !match
    || project.owner.toLowerCase() !== match[1]!.toLowerCase()
    || project.repo.toLowerCase() !== match[2]!.toLowerCase()
    || typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber)
    || issueNumber !== Number(match[3])
  ) throw new Error("governed callback target lineage mismatch");
  const targetIdentityDigest = canonicalSha256Json({
    provider: "github",
    owner: match[1]!.toLowerCase(),
    repo: match[2]!.toLowerCase(),
    issueNumber
  });
  if (targetIdentityDigest !== input.targetIdentityDigest) {
    throw new Error("governed callback target digest mismatch");
  }
  return { issueNumber, resourceIdentity: `github:issue:${issueNumber}` };
}

function governedProviderIdentityMatches(input: {
  receipt: typeof CallbackProviderObservationReceiptEnvelopeV1Schema._output;
  targetIdentityDigest: string;
  issueNumber: number;
}): boolean {
  const payload = input.receipt.payload;
  if (payload.targetIdentityDigest !== input.targetIdentityDigest) return false;
  if (payload.outcome === "failed") {
    return payload.resourceIdentity === `github:issue:${input.issueNumber}`;
  }
  const match = /^comment_([1-9][0-9]*)$/u.exec(payload.providerReceiptId);
  return !!match && payload.resourceIdentity === `github:comment:${match[1]}`;
}

function governedCallbackAttemptFromRow(
  row: typeof governedCallbackAttempts.$inferSelect
): GovernedCallbackAttempt {
  return {
    localAttemptId: row.localAttemptId,
    localIntentId: row.localIntentId,
    attemptNumber: row.attemptNumber,
    requestDigest: row.requestDigest,
    state: row.state as GovernedCallbackState,
    ...(row.previousAttemptId ? { previousAttemptId: row.previousAttemptId } : {}),
    ...(row.retryAuthorizationId ? { retryAuthorizationId: row.retryAuthorizationId } : {}),
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.attemptedAt ? { attemptedAt: row.attemptedAt } : {}),
    ...(row.observedAt ? { observedAt: row.observedAt } : {}),
    ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
    ...(row.nextAction ? { nextAction: row.nextAction } : {}),
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.providerReceiptId ? { providerReceiptId: row.providerReceiptId } : {}),
    ...(row.resourceIdentity ? { resourceIdentity: row.resourceIdentity } : {}),
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
    ...(row.workstreamId ? { workstreamId: row.workstreamId } : {}),
    ...(row.admissionBatchId ? { admissionBatchId: row.admissionBatchId } : {}),
    event: OpenTagEventSchema.parse(JSON.parse(row.eventJson)),
    decision: RunAdmissionDecisionSchema.parse(JSON.parse(row.decisionJson)),
    ...(row.accessProfileSnapshotJson
      ? { accessProfileSnapshot: AgentAccessProfileSnapshotSchema.parse(JSON.parse(row.accessProfileSnapshotJson)) }
      : {}),
    ...(row.policySnapshotProvenanceJson
      ? { policySnapshotProvenance: PolicySnapshotProvenanceSchema.parse(JSON.parse(row.policySnapshotProvenanceJson)) }
      : {}),
    ...(row.routingPolicyJson
      ? { routingPolicy: FrozenRoutingPolicySchema.parse(JSON.parse(row.routingPolicyJson)) }
      : {}),
    status: row.status as FollowUpRequest["status"],
    ...(row.createdRunId ? { createdRunId: row.createdRunId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }) as FollowUpRequest;
}

function runnerFromRow(row: typeof runners.$inferSelect): RunnerRegistration {
  const registration = RunnerRegistrationInputSchema.parse({
    runnerId: row.runnerId,
    name: row.name,
    locality: row.locality,
    declaredState: row.declaredState,
    executors: JSON.parse(row.executorsJson) as unknown,
    maxConcurrentRuns: row.maxConcurrentRuns,
    preference: row.preference
  });
  return {
    ...registration,
    createdAt: row.createdAt,
    ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {})
  };
}

function routingPreferenceIdsFromJson(value: string | null): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed)
    || parsed.length > 64
    || parsed.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(parsed).size !== parsed.length
  ) {
    throw new Error("Persisted routing preference ids must be a unique JSON string array with at most 64 entries.");
  }
  return parsed;
}

const RUNNER_HEARTBEAT_FRESHNESS_MS = 60_000;
const CLAIM_SCAN_LIMIT = 64;
const EXPIRED_LEASE_RECOVERY_LIMIT = 32;
const ROUTING_DIRECTORY_LIMIT = 256;
const DEFAULT_ROUTING_EXECUTOR_IDS = ["echo"] as const;
const WRITE_CAPABLE_PERMISSION_SCOPES: ReadonlySet<string> = new Set(["repo:write", "pr:create", "pr:update"]);

function runnerReadiness(input: {
  registration: RunnerRegistration;
  active: number;
  now: Date;
}): RunnerDirectoryEntry["readiness"] {
  if (input.registration.declaredState === "draining") {
    return {
      state: "draining",
      reasonCode: "runner_draining",
      reason: "Runner declared itself draining and will not accept a new attempt."
    };
  }
  const heartbeatAt = input.registration.heartbeatAt ? Date.parse(input.registration.heartbeatAt) : Number.NaN;
  if (!Number.isFinite(heartbeatAt) || input.now.getTime() - heartbeatAt > RUNNER_HEARTBEAT_FRESHNESS_MS) {
    return {
      state: "stale",
      reasonCode: "runner_heartbeat_stale",
      reason: "Runner heartbeat is outside the current readiness window."
    };
  }
  if (input.active >= input.registration.maxConcurrentRuns) {
    return {
      state: "at_capacity",
      reasonCode: "runner_at_capacity",
      reason: "Runner has no free concurrency slot."
    };
  }
  return {
    state: "ready",
    reasonCode: "runner_heartbeat_current",
    reason: "Runner heartbeat is current and capacity is available."
  };
}

function runnerDirectoryEntry(input: {
  registration: RunnerRegistration;
  active: number;
  now: Date;
}): RunnerDirectoryEntry {
  const { heartbeatAt, ...registration } = input.registration;
  const parsedHeartbeatAt = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  return RunnerDirectoryEntrySchema.parse({
    ...registration,
    ...(Number.isFinite(parsedHeartbeatAt) ? { heartbeatAt } : {}),
    readiness: runnerReadiness(input),
    capacity: {
      active: input.active,
      limit: input.registration.maxConcurrentRuns
    }
  });
}

function uniquePreferenceIds(ids: string[], primary: string | undefined, label: string): string[] {
  const normalized = ids.map((id) => id.trim());
  if (normalized.length > 63) {
    throw new Error(`Fallback ${label} ids cannot exceed 63 entries.`);
  }
  if (normalized.some((id) => id.length === 0)) {
    throw new Error(`Fallback ${label} ids cannot be empty.`);
  }
  if (primary && normalized.includes(primary)) {
    throw new Error(`Fallback ${label} ids cannot repeat the primary ${label} id.`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Fallback ${label} ids must be unique.`);
  }
  return normalized;
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

  async function repoBindingForProjectTarget(projectTarget: ProjectTargetRef | null): Promise<typeof repoBindings.$inferSelect | null> {
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
    return row ?? null;
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

  async function appendRunChildCreatedEvent(input: {
    parentRunId: string;
    childRunId: string;
    payload: unknown;
    message: string;
    createdAt: string;
  }): Promise<void> {
    const eventInput: Parameters<typeof runEventValues>[0] = {
      runId: input.parentRunId,
      type: "run.child_created",
      payload: input.payload,
      visibility: "audit",
      importance: "normal",
      message: input.message,
      createdAt: input.createdAt
    };
    const safeInput = sanitizeRunEventValue(eventInput, await attemptFencingTokensForRun(input.parentRunId));
    await db.insert(runEvents).values({
      ...runEventValues(safeInput),
      progressIdempotencyDigest: sha256Json({ kind: "run_child_created", childRunId: input.childRunId })
    }).onConflictDoNothing({ target: [runEvents.runId, runEvents.progressIdempotencyDigest] });
  }

  async function appendFollowUpPromotedEvent(input: {
    parentRunId: string;
    followUpRequestId: string;
    createdRunId: string;
    sourceEventId: string;
    createdAt: string;
  }): Promise<void> {
    const eventInput: Parameters<typeof runEventValues>[0] = {
      runId: input.parentRunId,
      type: "follow_up_request.promoted",
      payload: {
        followUpRequestId: input.followUpRequestId,
        createdRunId: input.createdRunId,
        sourceEventId: input.sourceEventId
      },
      visibility: "audit",
      importance: "normal",
      createdAt: input.createdAt
    };
    const safeInput = sanitizeRunEventValue(eventInput, await attemptFencingTokensForRun(input.parentRunId));
    await db.insert(runEvents).values({
      ...runEventValues(safeInput),
      progressIdempotencyDigest: sha256Json({
        kind: "follow_up_request_promoted",
        followUpRequestId: input.followUpRequestId,
        createdRunId: input.createdRunId
      })
    }).onConflictDoNothing({ target: [runEvents.runId, runEvents.progressIdempotencyDigest] });
  }

  type RoutingDirectorySnapshot = {
    registrations: RunnerRegistration[];
    directory: RunnerDirectoryEntry[];
    legacyBindings: Map<string, typeof repoBindings.$inferSelect>;
  };

  function repositoryRoutingKey(provider: string, owner: string, repo: string): string {
    return `${provider}\0${owner}\0${repo}`;
  }

  function routingRejectionsFromJson(value: string): Array<{ runnerId: string; executorId: string; reason: string }> {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Persisted routing rejections must be an array.");
    return parsed.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Persisted routing rejection is invalid.");
      const rejection = item as Record<string, unknown>;
      if (typeof rejection["runnerId"] !== "string" || typeof rejection["executorId"] !== "string" || typeof rejection["reason"] !== "string") {
        throw new Error("Persisted routing rejection is invalid.");
      }
      return { runnerId: rejection["runnerId"], executorId: rejection["executorId"], reason: rejection["reason"] };
    });
  }

  function routingDecisionForRun(input: {
    runRow: typeof runs.$inferSelect;
    now: Date;
    snapshot: RoutingDirectorySnapshot;
    event?: OpenTagEvent;
    allowedLocalities?: Array<"local" | "private" | "hosted">;
  }): RoutingDecision {
    const event = input.event ?? OpenTagEventSchema.parse(JSON.parse(input.runRow.eventJson));
    const accessProfile = input.runRow.accessProfileSnapshotJson
      ? AgentAccessProfileSnapshotSchema.parse(JSON.parse(input.runRow.accessProfileSnapshotJson))
      : undefined;
    const policySnapshot = input.runRow.policySnapshotProvenanceJson
      ? PolicySnapshotProvenanceSchema.parse(JSON.parse(input.runRow.policySnapshotProvenanceJson))
      : undefined;
    const projectTarget = projectTargetRefFromEvent(event);
    const legacyBinding = projectTarget
      ? input.snapshot.legacyBindings.get(repositoryRoutingKey(projectTarget.provider, projectTarget.owner, projectTarget.repo))
      : undefined;
    const frozenPolicy = input.runRow.routingPolicyJson
      ? FrozenRoutingPolicySchema.parse(JSON.parse(input.runRow.routingPolicyJson))
      : undefined;
    const frozenRunnerIds = frozenPolicy
      ? frozenPolicy.runnerIds
      : input.runRow.routingRunnerIdsJson !== null
        ? routingPreferenceIdsFromJson(input.runRow.routingRunnerIdsJson)
        : undefined;
    const bindingRunnerIds = Array.isArray(frozenRunnerIds)
      ? frozenRunnerIds
      : !frozenPolicy && legacyBinding
        ? [legacyBinding.runnerId, ...routingPreferenceIdsFromJson(legacyBinding.fallbackRunnerIdsJson)]
        : [];
    const registeredRunnerIds = input.snapshot.registrations.map((registration) => registration.runnerId);
    const runnerIds = Array.isArray(frozenRunnerIds)
      ? frozenRunnerIds
      : frozenPolicy
        ? registeredRunnerIds
        : bindingRunnerIds.length
          ? [
              ...bindingRunnerIds,
              ...registeredRunnerIds.filter((runnerId) => !bindingRunnerIds.includes(runnerId))
            ]
          : registeredRunnerIds;
    const registrationsByRunnerId = new Map(
      input.snapshot.registrations.map((registration) => [registration.runnerId, registration])
    );
    const registeredExecutorIds = [...new Set(
      runnerIds.flatMap((runnerId) =>
        registrationsByRunnerId.get(runnerId)?.executors.map((executor) => executor.executorId) ?? []
      )
    )];
    const frozenExecutorIds = frozenPolicy
      ? frozenPolicy.executorIds
      : input.runRow.routingExecutorIdsJson !== null
        ? routingPreferenceIdsFromJson(input.runRow.routingExecutorIdsJson)
        : undefined;
    const executorIds = Array.isArray(frozenExecutorIds)
      ? frozenExecutorIds
      : frozenPolicy
        ? registeredExecutorIds.length > 0 ? registeredExecutorIds : [...DEFAULT_ROUTING_EXECUTOR_IDS]
        : event.target.executorHint
          ? [event.target.executorHint]
          : legacyBinding?.defaultExecutor
            ? [legacyBinding.defaultExecutor, ...routingPreferenceIdsFromJson(legacyBinding.fallbackExecutorIdsJson)]
            : accessProfile?.constraints.allowedExecutorIds !== undefined
              ? accessProfile.constraints.allowedExecutorIds
              : registeredExecutorIds.length > 0 ? registeredExecutorIds : [...DEFAULT_ROUTING_EXECUTOR_IDS];
    const writeCapable = event.permissions.some((permission) => WRITE_CAPABLE_PERMISSION_SCOPES.has(permission.scope));
    return evaluateRouting({
      runId: input.runRow.id,
      ...(policySnapshot?.id ? { policySnapshotId: policySnapshot.id } : {}),
      ...(accessProfile?.id ? { accessProfileSnapshotId: accessProfile.id } : {}),
      runnerIds,
      executorIds,
      runners: input.snapshot.directory,
      requirements: {
        requiredContextAccess: ["context_packet"],
        minimumWriteAccess: writeCapable ? "workspace" : "none",
        minimumWorkspaceIsolation: writeCapable && projectTarget ? "branch" : "none",
        requiresCancel: false,
        requiresSourceControl: Boolean(writeCapable && projectTarget),
        requiresCompletionSignal: true
      },
      rejectedPlacements: routingRejectionsFromJson(input.runRow.routingRejectionsJson),
      ...(projectTarget ? { projectTarget: { bound: bindingRunnerIds.length > 0, allowedRunnerIds: bindingRunnerIds } } : {}),
      access: {
        ...(accessProfile?.constraints.allowedRunnerIds !== undefined
          ? { allowedRunnerIds: accessProfile.constraints.allowedRunnerIds }
          : {}),
        ...(accessProfile?.constraints.allowedExecutorIds !== undefined
          ? { allowedExecutorIds: accessProfile.constraints.allowedExecutorIds }
          : {}),
        ...(accessProfile?.constraints.locality ? { locality: accessProfile.constraints.locality } : {}),
        ...(input.allowedLocalities ? { allowedLocalities: input.allowedLocalities } : {}),
        unresolvedConnectionRefs: Boolean(accessProfile?.connectionRefs.length)
      },
      decidedAt: input.now.toISOString()
    });
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
    const replayIdentity = {
      requestedRunId: input.requestedRunId,
      replayKind: input.replayKind,
      sourceDeliveryId: input.sourceDeliveryId ?? null,
      eventId: input.event.id
    };
    await db.insert(runEvents).values([
      {
        ...runEventValues({
          runId: input.runRow.id,
          type: "admission.decided",
          payload: replayDecision,
          visibility: "audit",
          importance: "normal",
          message: replayDecision.reason,
          createdAt: input.createdAt
        }),
        progressIdempotencyDigest: sha256Json({ kind: "create_run_replay_admission", ...replayIdentity })
      },
      {
        ...runEventValues({
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
        }),
        progressIdempotencyDigest: sha256Json({ kind: "create_run_replay", ...replayIdentity })
      }
    ]).onConflictDoNothing().run();
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

  type AcceptedProgressSnapshot = {
    acceptedGateAdvanceCount: number;
    attributedGateAdvanceCount: number;
    unresolvedGateAdvanceCount: number;
    runIdsWithAcceptedProgress: string[];
    acceptedGateAdvancesByRunId: Map<string, number>;
    projectionsByWorkThreadId: Map<string, AcceptedProgressAttributionView>;
  };

  async function acceptedProgressSnapshot(input: { workThreadIds?: string[] } = {}): Promise<AcceptedProgressSnapshot> {
    const requestedIds = input.workThreadIds ? [...new Set(input.workThreadIds)] : undefined;
    if (requestedIds?.length === 0) {
      return {
        acceptedGateAdvanceCount: 0,
        attributedGateAdvanceCount: 0,
        unresolvedGateAdvanceCount: 0,
        runIdsWithAcceptedProgress: [],
        acceptedGateAdvancesByRunId: new Map(),
        projectionsByWorkThreadId: new Map()
      };
    }
    const currentRows = await db.select({
      workThreadId: workThreads.id,
      assessmentJson: completionAssessments.assessmentJson
    }).from(workThreads)
      .innerJoin(completionAssessments, eq(completionAssessments.id, workThreads.currentAssessmentId))
      .where(requestedIds ? inArray(workThreads.id, requestedIds) : undefined);
    const workThreadIds = currentRows.map((row) => row.workThreadId);
    if (workThreadIds.length === 0) {
      return {
        acceptedGateAdvanceCount: 0,
        attributedGateAdvanceCount: 0,
        unresolvedGateAdvanceCount: 0,
        runIdsWithAcceptedProgress: [],
        acceptedGateAdvancesByRunId: new Map(),
        projectionsByWorkThreadId: new Map()
      };
    }
    const [assessmentRows, progressRunRows] = await Promise.all([
      db.select({
        workThreadId: completionAssessments.workThreadId,
        assessmentJson: completionAssessments.assessmentJson
      }).from(completionAssessments)
        .where(inArray(completionAssessments.workThreadId, workThreadIds))
        .orderBy(asc(completionAssessments.cycle), asc(completionAssessments.sequence)),
      db.select({
        id: runs.id,
        workThreadId: runs.workThreadId,
        resultJson: runs.resultJson,
        updatedAt: runs.updatedAt
      }).from(runs).where(inArray(runs.workThreadId, workThreadIds))
    ]);
    const assessmentsByWorkThread = new Map<string, CompletionAssessment[]>();
    for (const row of assessmentRows) {
      const parsed = CompletionAssessmentSchema.safeParse(recordFromJson(row.assessmentJson));
      if (!parsed.success) continue;
      const values = assessmentsByWorkThread.get(row.workThreadId) ?? [];
      values.push(parsed.data);
      assessmentsByWorkThread.set(row.workThreadId, values);
    }
    const artifactsByWorkThread = new Map<string, CompletionArtifact[]>();
    const runIdsByWorkThread = new Map<string, string[]>();
    for (const row of progressRunRows) {
      if (!row.workThreadId) continue;
      const threadRunIds = runIdsByWorkThread.get(row.workThreadId) ?? [];
      threadRunIds.push(row.id);
      runIdsByWorkThread.set(row.workThreadId, threadRunIds);
      if (!row.resultJson) continue;
      const parsedResult = OpenTagRunResultSchema.safeParse(recordFromJson(row.resultJson));
      if (!parsedResult.success) continue;
      const artifacts = artifactsByWorkThread.get(row.workThreadId) ?? [];
      if (parsedResult.data.createdPullRequestUrl) {
        artifacts.push({
          id: runResultCreatedPullRequestArtifactId(row.id),
          kind: "pull_request",
          sourceRunId: row.id,
          uri: parsedResult.data.createdPullRequestUrl,
          recordedAt: row.updatedAt
        });
      }
      for (const [index, artifact] of (parsedResult.data.artifacts ?? []).entries()) {
        artifacts.push({
          id: artifact.id ?? runResultArtifactId(row.id, index),
          kind: artifact.kind ?? artifact.type ?? "custom",
          sourceRunId: row.id,
          ...(artifact.uri ? { uri: artifact.uri } : {}),
          recordedAt: artifact.createdAt ?? row.updatedAt
        });
      }
      artifactsByWorkThread.set(row.workThreadId, artifacts);
    }
    let acceptedGateAdvanceCount = 0;
    let attributedGateAdvanceCount = 0;
    let unresolvedGateAdvanceCount = 0;
    const acceptedGateAdvancesByRunId = new Map<string, number>();
    const projectionsByWorkThreadId = new Map<string, AcceptedProgressAttributionView>();
    for (const row of currentRows) {
      const currentAssessment = CompletionAssessmentSchema.safeParse(recordFromJson(row.assessmentJson));
      if (!currentAssessment.success || currentAssessment.data.workThreadId !== row.workThreadId) {
        throw new Error(`Accepted progress authority is invalid for WorkThread ${row.workThreadId}: current assessment is malformed or belongs to another WorkThread.`);
      }
      try {
        const projection = deriveAcceptedProgressAttribution({
          currentAssessment: currentAssessment.data,
          assessmentHistory: assessmentsByWorkThread.get(row.workThreadId) ?? [],
          artifacts: artifactsByWorkThread.get(row.workThreadId) ?? [],
          workThreadRunIds: runIdsByWorkThread.get(row.workThreadId) ?? []
        });
        projectionsByWorkThreadId.set(row.workThreadId, projection);
        acceptedGateAdvanceCount += projection.acceptedGateAdvanceCount;
        attributedGateAdvanceCount += projection.attributedGateAdvanceCount;
        unresolvedGateAdvanceCount += projection.unresolvedGateAdvanceCount;
        for (const advance of projection.advances) {
          if (advance.resolution.status !== "attributed") continue;
          acceptedGateAdvancesByRunId.set(
            advance.resolution.sourceRunId,
            (acceptedGateAdvancesByRunId.get(advance.resolution.sourceRunId) ?? 0) + 1
          );
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown derivation failure";
        throw new Error(`Accepted progress authority is invalid for WorkThread ${row.workThreadId}: ${reason}`);
      }
    }
    return {
      acceptedGateAdvanceCount,
      attributedGateAdvanceCount,
      unresolvedGateAdvanceCount,
      runIdsWithAcceptedProgress: [...acceptedGateAdvancesByRunId.keys()].sort(),
      acceptedGateAdvancesByRunId,
      projectionsByWorkThreadId
    };
  }

  type ProjectionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

  type PreparedHostedLifecycleOperation = {
    destinationId: string;
    organizationId: string;
    runnerId: string;
    credentialId: string;
    runId: string;
    action: HostedLifecycleActionV1;
    request: HostedLifecycleRequestV1;
    requestJson: string;
    businessKeyDigest: string;
    createdAt: string;
  };

  async function prepareHostedLifecycleOperation(input: {
    destinationId: string;
    organizationId: string;
    runnerId: string;
    credentialId: string;
    runId: string;
    action: HostedLifecycleActionV1;
    request: HostedLifecycleRequestV1;
    now?: Date;
  }): Promise<PreparedHostedLifecycleOperation> {
    let request: HostedLifecycleRequestV1;
    try {
      request = HostedLifecycleRequestV1Schema.parse(input.request);
    } catch {
      throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
    }
    const requestDigest = await computeHostedLifecycleRequestDigestV1({
      organizationId: input.organizationId,
      runnerId: input.runnerId,
      runId: input.runId,
      action: input.action,
      request
    });
    const requestId = await computeHostedLifecycleRequestIdV1({
      operationId: request.operationId,
      requestDigest: request.requestDigest
    });
    if (
      request.requestDigest !== requestDigest
      || request.requestId !== requestId
      || request.operationId !== computeHostedLifecycleOperationIdV1(request.requestDigest)
      || request.attempt.attemptId.length === 0
      || request.attempt.attemptNumber !== request.attempt.epoch
    ) throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
    const businessKeyDigest = canonicalSha256Json({
      destinationId: input.destinationId,
      organizationId: input.organizationId,
      runnerId: input.runnerId,
      credentialId: input.credentialId,
      runId: input.runId,
      attemptId: request.attempt.attemptId,
      attemptNumber: request.attempt.attemptNumber,
      action: input.action,
      discriminator: input.action === "heartbeat"
        ? (request as HostedHeartbeatRequestV1).expectedLeaseExpiresAt
        : input.action === "progress"
          ? (request as HostedProgressRequestV1).progressId
          : "single_action_per_attempt"
    });
    return {
      ...input,
      request,
      requestJson: canonicalJsonStringify(request),
      businessKeyDigest,
      createdAt: (input.now ?? new Date()).toISOString()
    };
  }

  function enqueueHostedLifecycleOperationTx(
    tx: ProjectionTransaction,
    input: PreparedHostedLifecycleOperation
  ): { outcome: "created" | "replayed"; operation: HostedLifecycleOperation } {
    const scope = [
      eq(hostedLifecycleOperations.destinationId, input.destinationId),
      eq(hostedLifecycleOperations.organizationId, input.organizationId),
      eq(hostedLifecycleOperations.runnerId, input.runnerId),
      eq(hostedLifecycleOperations.credentialId, input.credentialId)
    ];
    const existing = tx.select().from(hostedLifecycleOperations).where(or(
      and(...scope, eq(hostedLifecycleOperations.operationId, input.request.operationId)),
      and(...scope, eq(hostedLifecycleOperations.requestId, input.request.requestId)),
      and(...scope, eq(hostedLifecycleOperations.businessKeyDigest, input.businessKeyDigest))
    )).limit(1).get();
    if (existing) {
      const exact = existing.operationId === input.request.operationId
        && existing.requestId === input.request.requestId
        && existing.action === input.action
        && existing.runId === input.runId
        && existing.attemptId === input.request.attempt.attemptId
        && existing.attemptNumber === input.request.attempt.attemptNumber
        && existing.fencingTokenDigest === input.request.attempt.fencingTokenDigest
        && existing.requestDigest === input.request.requestDigest
        && existing.businessKeyDigest === input.businessKeyDigest
        && existing.requestJson === input.requestJson;
      if (!exact) throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_CONFLICT");
      return { outcome: "replayed", operation: hostedLifecycleOperationFromRow(existing) };
    }
    const terminal = tx.select({ operationId: hostedLifecycleOperations.operationId })
      .from(hostedLifecycleOperations).where(and(
        eq(hostedLifecycleOperations.destinationId, input.destinationId),
        eq(hostedLifecycleOperations.organizationId, input.organizationId),
        eq(hostedLifecycleOperations.runId, input.runId),
        eq(hostedLifecycleOperations.attemptId, input.request.attempt.attemptId),
        inArray(hostedLifecycleOperations.action, ["complete", "reject-start"])
      )).limit(1).get();
    if (terminal) {
      throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_CONFLICT");
    }
    if (["heartbeat", "progress", "complete"].includes(input.action)) {
      const running = tx.select().from(hostedLifecycleOperations).where(and(
        eq(hostedLifecycleOperations.destinationId, input.destinationId),
        eq(hostedLifecycleOperations.organizationId, input.organizationId),
        eq(hostedLifecycleOperations.runnerId, input.runnerId),
        eq(hostedLifecycleOperations.credentialId, input.credentialId),
        eq(hostedLifecycleOperations.runId, input.runId),
        eq(hostedLifecycleOperations.attemptId, input.request.attempt.attemptId),
        eq(hostedLifecycleOperations.action, "running"),
        eq(hostedLifecycleOperations.state, "acknowledged")
      )).limit(1).get();
      if (!running || !validAcknowledgedLifecycleDependency(running)) {
        throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_PREDECESSOR_NOT_ACKNOWLEDGED");
      }
    }
    const sequenceRow = tx.select({
      value: sql<number>`coalesce(max(${hostedLifecycleOperations.sequence}), 0)`
    }).from(hostedLifecycleOperations).where(and(
      eq(hostedLifecycleOperations.destinationId, input.destinationId),
      eq(hostedLifecycleOperations.organizationId, input.organizationId),
      eq(hostedLifecycleOperations.runId, input.runId),
      eq(hostedLifecycleOperations.attemptId, input.request.attempt.attemptId)
    )).get();
    tx.insert(hostedLifecycleOperations).values({
      destinationId: input.destinationId,
      organizationId: input.organizationId,
      runnerId: input.runnerId,
      credentialId: input.credentialId,
      operationId: input.request.operationId,
      requestId: input.request.requestId,
      action: input.action,
      runId: input.runId,
      attemptId: input.request.attempt.attemptId,
      attemptNumber: input.request.attempt.attemptNumber,
      fencingTokenDigest: input.request.attempt.fencingTokenDigest,
      requestDigest: input.request.requestDigest,
      businessKeyDigest: input.businessKeyDigest,
      sequence: Number(sequenceRow?.value ?? 0) + 1,
      requestJson: input.requestJson,
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: input.createdAt,
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    }).run();
    const created = tx.select().from(hostedLifecycleOperations).where(and(
      ...scope,
      eq(hostedLifecycleOperations.operationId, input.request.operationId)
    )).limit(1).get();
    if (!created) throw new Error("hosted_lifecycle_operation_insert_lost");
    return { outcome: "created", operation: hostedLifecycleOperationFromRow(created) };
  }

  function projectionDestination(value: string): string {
    if (
      !PROJECTION_SAFE_REFERENCE.test(value)
      || containsCredentialLikeData(value)
      || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)
      || /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(value)
    ) {
      throw new ControlPlaneProjectionOutboxValidationError("projection_destination_invalid");
    }
    return value;
  }

  function projectionOrganization(value: string): string {
    return projectionDestination(value);
  }

  function enqueueControlPlaneProjectionTx(
    tx: ProjectionTransaction,
    input: EnqueueControlPlaneProjectionInput
  ): EnqueueControlPlaneProjectionResult {
    const destinationId = projectionDestination(input.destinationId);
    const envelope = parseControlPlaneProjectionEnvelope(input.envelope);
    assertProjectionCustodySafe(envelope);
    assertProjectionDigests(envelope);
    const at = (input.now ?? new Date()).toISOString();
    const identityKey = projectionIdentityKey(envelope);
    const envelopeJson = canonicalJsonStringify(envelope);
    const runnerId = envelope.receiptKind === "runner_readiness" ? envelope.payload.runnerId : null;
    const runId = "runId" in envelope ? envelope.runId : null;
    const workThreadId = "workThreadId" in envelope ? envelope.workThreadId : null;
    const values: typeof controlPlaneProjectionOutbox.$inferInsert = {
      receiptId: envelope.receiptId,
      destinationId,
      organizationId: envelope.organizationId,
      runnerId,
      runId,
      workThreadId,
      receiptKind: envelope.receiptKind,
      identityNamespace: envelope.identity.namespace,
      identityPartsJson: JSON.stringify(envelope.identity.parts),
      identityKey,
      operationId: envelope.operationId,
      dependsOnReceiptId: input.dependsOnReceiptId ?? null,
      requiresLifecycleOperationId: input.requiresLifecycleOperationId ?? null,
      payloadDigest: envelope.payloadDigest,
      receiptDigest: envelope.receiptDigest,
      envelopeJson,
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at
    };
    const byReceipt = tx.select().from(controlPlaneProjectionOutbox).where(and(
      eq(controlPlaneProjectionOutbox.destinationId, destinationId),
      eq(controlPlaneProjectionOutbox.organizationId, envelope.organizationId),
      eq(controlPlaneProjectionOutbox.receiptId, envelope.receiptId)
    )).limit(1).get();
    const byIdentity = tx.select().from(controlPlaneProjectionOutbox).where(and(
      eq(controlPlaneProjectionOutbox.destinationId, destinationId),
      eq(controlPlaneProjectionOutbox.organizationId, envelope.organizationId),
      eq(controlPlaneProjectionOutbox.identityKey, identityKey)
    )).limit(1).get();
    const byOperation = tx.select().from(controlPlaneProjectionOutbox).where(and(
      eq(controlPlaneProjectionOutbox.destinationId, destinationId),
      eq(controlPlaneProjectionOutbox.organizationId, envelope.organizationId),
      eq(controlPlaneProjectionOutbox.operationId, envelope.operationId)
    )).limit(1).get();
    const conflict = byReceipt ?? byIdentity ?? byOperation;
    if (conflict) {
      const exact = conflict.receiptId === values.receiptId
        && conflict.destinationId === values.destinationId
        && conflict.organizationId === values.organizationId
        && conflict.runnerId === values.runnerId
        && conflict.runId === values.runId
        && conflict.workThreadId === values.workThreadId
        && conflict.receiptKind === values.receiptKind
        && conflict.identityNamespace === values.identityNamespace
        && conflict.identityPartsJson === values.identityPartsJson
        && conflict.identityKey === values.identityKey
        && conflict.operationId === values.operationId
        && conflict.dependsOnReceiptId === values.dependsOnReceiptId
        && conflict.requiresLifecycleOperationId === values.requiresLifecycleOperationId
        && conflict.payloadDigest === values.payloadDigest
        && conflict.receiptDigest === values.receiptDigest
        && conflict.envelopeJson === values.envelopeJson;
      if (exact) return { outcome: "replay", entry: projectionOutboxEntryFromRow(conflict) };
      return {
        outcome: "conflict",
        conflictOn: byReceipt ? "receipt_id" : byIdentity ? "identity" : "operation",
        existingReceiptId: conflict.receiptId
      };
    }
    tx.insert(controlPlaneProjectionOutbox).values(values).run();
    const created = tx.select().from(controlPlaneProjectionOutbox).where(and(
      eq(controlPlaneProjectionOutbox.destinationId, destinationId),
      eq(controlPlaneProjectionOutbox.organizationId, envelope.organizationId),
      eq(controlPlaneProjectionOutbox.receiptId, envelope.receiptId)
    )).limit(1).get();
    if (!created) throw new Error("control_plane_projection_outbox_insert_lost");
    return { outcome: "created", entry: projectionOutboxEntryFromRow(created) };
  }

  function ensureCompletionAssessmentProjectionTx(
    tx: ProjectionTransaction,
    input: { workThreadId: string; runId: string; assessmentId: string }
  ): void {
    const importedRuns = tx.select().from(hostedRunImports)
      .where(eq(hostedRunImports.runId, input.runId)).all();
    if (importedRuns.length === 0) return;
    if (importedRuns.length !== 1) {
      throw new Error("completion_assessment_projection_authority_conflict");
    }
    const importedRun = importedRuns[0]!;
    if (importedRun.workThreadId !== input.workThreadId) {
      throw new Error("completion_assessment_projection_authority_conflict");
    }
    const thread = tx.select().from(workThreads).where(and(
      eq(workThreads.id, input.workThreadId),
      eq(workThreads.id, importedRun.workThreadId)
    )).limit(1).get();
    if (!thread?.currentAssessmentId) return;
    const currentAssessmentRow = tx.select().from(completionAssessments).where(and(
      eq(completionAssessments.id, thread.currentAssessmentId),
      eq(completionAssessments.workThreadId, input.workThreadId)
    )).limit(1).get();
    if (!currentAssessmentRow) {
      throw new Error("completion_assessment_projection_authority_conflict");
    }
    const currentAssessment = CompletionAssessmentSchema.parse(
      JSON.parse(currentAssessmentRow.assessmentJson)
    );
    if (
      currentAssessmentRow.assessmentJson !== JSON.stringify(currentAssessment)
      || currentAssessmentRow.id !== currentAssessment.id
      || currentAssessmentRow.workThreadId !== currentAssessment.workThreadId
      || currentAssessmentRow.contractId !== currentAssessment.contractId
      || currentAssessmentRow.contractVersion !== currentAssessment.contractVersion
      || currentAssessmentRow.cycle !== currentAssessment.cycle
      || currentAssessmentRow.sequence !== currentAssessment.sequence
      || currentAssessmentRow.supersedesAssessmentId
        !== (currentAssessment.supersedesAssessmentId ?? null)
      || currentAssessmentRow.inputDigest !== currentAssessment.inputDigest
      || currentAssessmentRow.state !== currentAssessment.state
    ) throw new Error("completion_assessment_projection_authority_conflict");
    const assessmentRow = tx.select().from(completionAssessments).where(and(
      eq(completionAssessments.id, input.assessmentId),
      eq(completionAssessments.workThreadId, input.workThreadId)
    )).limit(1).get();
    if (!assessmentRow) {
      throw new Error("completion_assessment_projection_authority_conflict");
    }
    const assessment = CompletionAssessmentSchema.parse(
      JSON.parse(assessmentRow.assessmentJson)
    );
    if (
      assessmentRow.assessmentJson !== JSON.stringify(assessment)
      || assessmentRow.id !== assessment.id
      || assessmentRow.workThreadId !== assessment.workThreadId
      || assessmentRow.contractId !== assessment.contractId
      || assessmentRow.contractVersion !== assessment.contractVersion
      || assessmentRow.cycle !== assessment.cycle
      || assessmentRow.sequence !== assessment.sequence
      || assessmentRow.supersedesAssessmentId !== (assessment.supersedesAssessmentId ?? null)
      || assessmentRow.inputDigest !== assessment.inputDigest
      || assessmentRow.state !== assessment.state
    ) throw new Error("completion_assessment_projection_authority_conflict");
    if (assessment.triggeredByRunId !== input.runId) return;

    const importedAttempts = tx.select().from(hostedAttemptImports).where(and(
      eq(hostedAttemptImports.attemptId, importedRun.attemptId),
      eq(hostedAttemptImports.runId, importedRun.runId),
      eq(hostedAttemptImports.claimOperationId, importedRun.claimOperationId),
      eq(hostedAttemptImports.fencingTokenDigest, importedRun.fencingTokenDigest)
    )).all();
    const claims = tx.select().from(hostedClaimOperations).where(and(
      eq(hostedClaimOperations.operationId, importedRun.claimOperationId),
      eq(hostedClaimOperations.runId, importedRun.runId),
      eq(hostedClaimOperations.attemptId, importedRun.attemptId),
      eq(hostedClaimOperations.fencingTokenDigest, importedRun.fencingTokenDigest)
    )).all();
    if (importedAttempts.length !== 1 || claims.length !== 1) {
      throw new Error("completion_assessment_projection_authority_conflict");
    }
    const importedAttempt = importedAttempts[0]!;
    const claim = claims[0]!;
    let authority: HostedClaimV1["authority"];
    try {
      authority = hostedClaimAuthoritySnapshotFromJson(importedRun.authorityJson);
    } catch {
      throw new Error("completion_assessment_projection_authority_conflict");
    }
    if (
      importedRun.workThreadId !== input.workThreadId
      || importedRun.authorityJson !== importedAttempt.authorityJson
      || importedRun.authorityJson !== claim.authorityJson
      || importedRun.authorityDigest !== importedAttempt.authorityDigest
      || importedRun.authorityDigest !== claim.authorityDigest
      || importedRun.claimDigest !== importedAttempt.claimDigest
      || importedRun.claimDigest !== claim.claimDigest
      || canonicalSha256Json(authority) !== importedRun.authorityDigest
      || authority.organizationId !== claim.organizationId
      || authority.runnerId !== claim.runnerId
      || authority.runId !== importedRun.runId
      || authority.credentialId !== claim.credentialId
      || authority.attemptId !== importedRun.attemptId
      || authority.attemptNumber !== importedAttempt.attemptNumber
      || authority.attemptId !== claim.attemptId
      || authority.attemptNumber !== claim.attemptNumber
      || authority.epoch !== importedAttempt.attemptNumber
      || authority.fencingTokenDigest !== importedRun.fencingTokenDigest
      || claim.state !== "claimed"
      || claim.executionStartedAt === null
      || claim.terminalReasonCode !== null
      || claim.destinationId.length === 0
    ) throw new Error("completion_assessment_projection_authority_conflict");

    const completionRows = tx.select().from(hostedLifecycleOperations).where(and(
      eq(hostedLifecycleOperations.destinationId, claim.destinationId),
      eq(hostedLifecycleOperations.organizationId, authority.organizationId),
      eq(hostedLifecycleOperations.action, "complete"),
      eq(hostedLifecycleOperations.runId, input.runId)
    )).all();
    if (completionRows.length === 0) return;
    if (completionRows.length !== 1) {
      throw new Error("completion_assessment_projection_authority_conflict");
    }
    const completion = completionRows[0]!;
    if (completion.state !== "acknowledged") return;
    if (
      completion.runnerId !== authority.runnerId
      || completion.credentialId !== authority.credentialId
      || completion.attemptId !== authority.attemptId
      || completion.attemptNumber !== authority.attemptNumber
      || completion.fencingTokenDigest !== authority.fencingTokenDigest
      || !validAcknowledgedLifecycleDependency(completion)
    ) throw new Error("completion_assessment_projection_authority_conflict");

    const contractRow = tx.select().from(completionContracts).where(and(
      eq(completionContracts.id, assessment.contractId),
      eq(completionContracts.version, assessment.contractVersion),
      eq(completionContracts.workThreadId, assessment.workThreadId),
      eq(completionContracts.cycle, assessment.cycle)
    )).limit(1).get();
    if (!contractRow) {
      throw new Error("completion_assessment_projection_authority_conflict");
    }
    const contract = CompletionContractSchema.parse(JSON.parse(contractRow.contractJson));
    if (
      contractRow.contractJson !== JSON.stringify(contract)
      || contractRow.contentDigest !== sha256Json(contract)
    ) throw new Error("completion_assessment_projection_authority_conflict");
    const contractGateIds = new Set(contract.gates.map((gate) => gate.id));
    const assessmentGateIds = new Set(assessment.gateResults.map((gate) => gate.gateId));
    if (
      [...contractGateIds].some((gateId) => !assessmentGateIds.has(gateId))
      || [...assessmentGateIds].some((gateId) =>
        !contractGateIds.has(gateId) && !/^human_escalation:/u.test(gateId)
      )
    ) {
      throw new Error("completion_assessment_projection_authority_conflict");
    }

    const completionRequest = HostedCompleteRequestV1Schema.parse(
      JSON.parse(completion.requestJson)
    );
    const completionReceipt = HostedLifecycleReceiptEnvelopeV1Schema.parse(
      JSON.parse(completion.receiptJson!)
    );
    const run = tx.select().from(runs).where(and(
      eq(runs.id, input.runId),
      eq(runs.workThreadId, input.workThreadId)
    )).limit(1).get();
    const attempt = tx.select().from(attempts).where(and(
      eq(attempts.id, authority.attemptId),
      eq(attempts.runId, input.runId),
      eq(attempts.number, authority.attemptNumber),
      eq(attempts.runnerId, authority.runnerId)
    )).limit(1).get();
    const runResult = run?.resultJson
      ? OpenTagRunResultSchema.parse(JSON.parse(run.resultJson))
      : undefined;
    const attemptResult = attempt?.resultJson
      ? OpenTagRunResultSchema.parse(JSON.parse(attempt.resultJson))
      : undefined;
    const expectedRunStatus = runResult?.conclusion === "success"
      ? "succeeded"
      : runResult?.conclusion === "failure"
        ? "failed"
        : runResult?.conclusion === "needs_human"
          ? "needs_approval"
          : runResult?.conclusion;
    const expectedAttemptStatus = runResult?.conclusion === "success"
      ? "succeeded"
      : runResult?.conclusion === "failure"
        ? "failed"
        : runResult?.conclusion === "needs_human"
          ? "needs_human"
          : runResult?.conclusion;
    if (
      !run?.resultJson || !attempt?.resultJson
      || `sha256:${createHash("sha256").update(attempt.fencingToken).digest("hex")}`
        !== authority.fencingTokenDigest
      || !releasedTerminalAttemptMatchesRun(attempt, run)
      || run.status !== expectedRunStatus
      || attempt.status !== expectedAttemptStatus
      || completionRequest.conclusion !== runResult?.conclusion
      || canonicalJsonStringify(runResult) !== canonicalJsonStringify(attemptResult)
      || canonicalSha256Json(runResult) !== completionRequest.resultDigest
      || canonicalSha256Json(attemptResult) !== completionRequest.resultDigest
      || completionReceipt.receiptId !== completion.receiptId
      || completionReceipt.receiptDigest !== completion.receiptDigest
    ) throw new Error("completion_assessment_projection_authority_conflict");

    const projectionAttempt = {
      attemptId: authority.attemptId,
      attemptNumber: authority.attemptNumber,
      epoch: authority.epoch,
      fencingTokenDigest: authority.fencingTokenDigest
    };
    const projectionProducer = {
      kind: "local_opentag" as const,
      id: authority.runnerId,
      credentialId: authority.credentialId,
      registrationGeneration: authority.registrationGeneration
    };
    const evidenceIdentity = (
      payload: CompletionEvidenceObservationPayloadV1,
      contractReceiptDigest: string
    ) => ({
      namespace: "opentag.control.receipt/completion-evidence-observation/v1" as const,
      parts: [
        authority.organizationId,
        input.workThreadId,
        input.runId,
        payload.evidenceType,
        payload.evidenceId,
        payload.authorityDigest,
        contractReceiptDigest
      ]
    });
    const evidenceSelectionKey = (
      payload: CompletionEvidenceObservationPayloadV1
    ): string => canonicalSha256Json({
      purpose: "opentag-completion-evidence-selection-v1",
      organizationId: authority.organizationId,
      workThreadId: input.workThreadId,
      runId: input.runId,
      evidenceType: payload.evidenceType,
      evidenceId: payload.evidenceId,
      authorityDigest: payload.authorityDigest
    });
    const evidenceReceiptId = (
      payload: CompletionEvidenceObservationPayloadV1,
      contractReceiptDigest: string
    ): string => {
      const identity = evidenceIdentity(payload, contractReceiptDigest);
      const projectionKey = canonicalSha256Json({
        purpose: "opentag-completion-evidence-projection-v1",
        identity
      }).slice("sha256:".length);
      return `completion_evidence_receipt_${projectionKey}`;
    };
    const evidenceEnvelope = (
      payload: CompletionEvidenceObservationPayloadV1,
      contractReceiptDigest: string,
      predecessorReceiptDigests: string[]
    ): CompletionEvidenceObservationReceiptEnvelopeV1 => {
      const identity = evidenceIdentity(payload, contractReceiptDigest);
      const receiptId = evidenceReceiptId(payload, contractReceiptDigest);
      const projectionKey = receiptId.slice("completion_evidence_receipt_".length);
      const observedAt = payload.evidenceType === "completion_waiver"
        ? payload.waivedAt
        : payload.observedAt;
      const base = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        receiptKind: "completion_evidence_observation" as const,
        receiptId,
        organizationId: authority.organizationId,
        operationId: `completion_evidence_operation_${projectionKey}`,
        requiredCapabilities: ["relay.completion-evidence.v1" as const],
        producer: projectionProducer,
        identity,
        predecessorReceiptDigests: [...new Set(predecessorReceiptDigests)].sort(),
        observedAt,
        runId: input.runId,
        workThreadId: input.workThreadId,
        attempt: projectionAttempt,
        payload,
        payloadDigest: canonicalSha256Json(payload)
      };
      return CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse({
        ...base,
        receiptDigest: canonicalSha256Json(base)
      });
    };
    const verificationById = new Map<string, {
      fact: CompletionEvidenceFact;
      payload: CompletionEvidenceObservationPayloadV1;
    }>();
    for (const row of tx.select().from(verificationEvidenceRecords).where(
      eq(verificationEvidenceRecords.workThreadId, input.workThreadId)
    ).all()) {
      const evidence = VerificationEvidenceSchema.parse(JSON.parse(row.evidenceJson));
      if (!storedEvidenceClaimsCompletionFact(evidence)) continue;
      const fact = completionFactFromStoredEvidence({
        evidence,
        workThreadId: input.workThreadId
      });
      if (
        !fact
        || row.id !== evidence.id
        || row.id !== fact.id
        || fact.workThreadId !== input.workThreadId
        || evidence.kind !== row.kind
        || evidence.kind !== fact.kind
        || evidence.assurance !== row.assurance
        || evidence.assurance !== fact.assurance
        || evidence.subjectRef !== `${fact.subject.resourceRef}@${fact.subject.resourceVersion}`
        || evidence.createdAt !== fact.observedAt
        || row.provider !== fact.subject.provider
        || row.subjectRef !== fact.subject.resourceRef
        || row.subjectVersion !== fact.subject.resourceVersion
        || row.payloadDigest !== fact.provenance.payloadDigest
        || row.observedAt !== fact.observedAt
        || row.receivedAt !== fact.receivedAt
        || (fact.provenance.providerDeliveryId !== undefined
          && fact.provenance.providerDeliveryId !== row.deliveryId)
        || row.evidenceJson !== JSON.stringify(evidence)
        || !/^sha256:[0-9a-f]{64}$/u.test(row.payloadDigest)
        || !isRfc3339Instant(row.observedAt)
        || !isRfc3339Instant(row.receivedAt)
        || compareRfc3339Timestamps(row.receivedAt, row.observedAt) < 0
      ) throw new Error("completion_assessment_projection_authority_conflict");
      if (fact.cycle !== assessment.cycle) continue;
      if (
        compareRfc3339Timestamps(row.receivedAt, run.createdAt) < 0
        || compareRfc3339Timestamps(row.receivedAt, assessment.assessedAt) > 0
      ) continue;
      const payload = CompletionEvidenceObservationPayloadV1Schema.parse({
        evidenceType: "verification_evidence",
        evidenceId: fact.id,
        authorityDigest: canonicalSha256Json(fact),
        evidenceKind: fact.kind,
        assurance: fact.assurance,
        subject: fact.subject,
        claim: {
          predicate: fact.claim.predicate,
          outcome: fact.claim.outcome,
          ...(fact.claim.observations
            ? { observationsDigest: canonicalSha256Json(fact.claim.observations) }
            : {})
        },
        provenancePayloadDigest: fact.provenance.payloadDigest,
        observedAt: toControlTimestamp(fact.observedAt),
        receivedAt: toControlTimestamp(fact.receivedAt)
      });
      const existing = verificationById.get(fact.id);
      if (existing && canonicalJsonStringify(existing.payload) !== canonicalJsonStringify(payload)) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      verificationById.set(fact.id, { fact, payload });
    }

    const materialById = new Map<string, {
      receipt: MaterialActionReceipt;
      actionFamily: string;
      payload: CompletionEvidenceObservationPayloadV1;
    }>();
    for (const row of tx.select().from(materialActions).where(and(
      eq(materialActions.runId, input.runId),
      isNotNull(materialActions.receiptJson)
    )).all()) {
      const receipt = MaterialActionReceiptSchema.parse(JSON.parse(row.receiptJson!));
      if (
        receipt.actionId !== row.id
        || row.attemptId !== authority.attemptId
        || row.attemptFenceDigest
          !== authority.fencingTokenDigest.slice("sha256:".length)
        || row.receiptJson !== JSON.stringify(receipt)
        || row.status !== receipt.outcome
      ) throw new Error("completion_assessment_projection_authority_conflict");
      if (compareRfc3339Timestamps(receipt.observedAt, assessment.assessedAt) > 0) {
        continue;
      }
      const payload = CompletionEvidenceObservationPayloadV1Schema.parse({
        evidenceType: "material_action",
        evidenceId: receipt.id,
        authorityDigest: canonicalSha256Json(receipt),
        actionId: receipt.actionId,
        actionFamily: row.actionFamily,
        outcome: receipt.outcome,
        observedAt: toControlTimestamp(receipt.observedAt)
      });
      const existing = materialById.get(receipt.id);
      if (existing && canonicalJsonStringify(existing.payload) !== canonicalJsonStringify(payload)) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      materialById.set(receipt.id, { receipt, actionFamily: row.actionFamily, payload });
    }

    const waiverById = new Map<string, {
      waiver: CompletionWaiver;
      payload: CompletionEvidenceObservationPayloadV1;
    }>();
    for (const row of tx.select().from(completionWaivers).where(
      eq(completionWaivers.workThreadId, input.workThreadId)
    ).all()) {
      const storedWaiver = CompletionWaiverSchema.parse(JSON.parse(row.waiverJson));
      const { id: _waiverId, ...semanticWaiver } = storedWaiver;
      const authorityDigest = `sha256:${sha256(stableActionJson(semanticWaiver))}`;
      if (
        storedWaiver.id !== row.id
        || storedWaiver.contractId !== row.contractId
        || storedWaiver.contractVersion !== row.contractVersion
        || storedWaiver.cycle !== row.cycle
        || row.waiverJson !== JSON.stringify(storedWaiver)
        || row.contentDigest !== authorityDigest
      ) throw new Error("completion_assessment_projection_authority_conflict");
      if (
        storedWaiver.contractId !== assessment.contractId
        || storedWaiver.contractVersion !== assessment.contractVersion
        || storedWaiver.cycle !== assessment.cycle
        || (storedWaiver.runId !== undefined && storedWaiver.runId !== input.runId)
      ) continue;
      const payload = CompletionEvidenceObservationPayloadV1Schema.parse({
        evidenceType: "completion_waiver",
        evidenceId: storedWaiver.id,
        authorityDigest,
        contractId: storedWaiver.contractId,
        version: storedWaiver.contractVersion,
        cycle: storedWaiver.cycle,
        runId: input.runId,
        gateIds: [...storedWaiver.gateIds].sort(compareCompletionGateIds),
        actorRef: `actor_${canonicalSha256Json(storedWaiver.actor).slice("sha256:".length)}`,
        reasonDigest: canonicalSha256Json(storedWaiver.reason),
        waivedAt: toControlTimestamp(storedWaiver.waivedAt),
        ...(storedWaiver.expiresAt
          ? { expiresAt: toControlTimestamp(storedWaiver.expiresAt) }
          : {})
      });
      waiverById.set(storedWaiver.id, { waiver: storedWaiver, payload });
    }

    const event = OpenTagEventSchema.parse(JSON.parse(run.eventJson));
    const eventOwner = event.metadata["owner"];
    const eventRepo = event.metadata["repo"];
    if (
      canonicalSha256Json(event) !== importedRun.eventDigest
      || typeof eventOwner !== "string"
      || typeof eventRepo !== "string"
    ) throw new Error("completion_assessment_projection_authority_conflict");
    const artifactById = new Map<string, {
      authority: CompletionArtifact;
      payload: CompletionEvidenceObservationPayloadV1;
    }>();
    const artifactCandidates = [
      ...(runResult.createdPullRequestUrl
        ? [{
            id: runResultCreatedPullRequestArtifactId(input.runId),
            kind: "pull_request",
            uri: runResult.createdPullRequestUrl,
            sourceRunId: input.runId
          }]
        : []),
      ...(runResult.artifacts ?? []).map((artifact, index) => ({
        id: artifact.id ?? runResultArtifactId(input.runId, index),
        kind: artifact.kind ?? artifact.type ?? "custom",
        uri: artifact.uri,
        sourceRunId: artifact.sourceRunId ?? input.runId
      }))
    ];
    for (const candidate of artifactCandidates) {
      const binding = assessment.targetBindings.find((target) => target.artifactId === candidate.id);
      if (!binding) continue;
      const resourceRef = githubPullRequestResourceRef({
        uri: candidate.uri,
        owner: eventOwner,
        repo: eventRepo
      });
      if (
        candidate.kind !== "pull_request"
        || candidate.sourceRunId !== input.runId
        || binding.key !== "primary_change"
        || binding.provider !== "github"
        || resourceRef !== binding.resourceRef
        || (binding.resourceVersion !== "unverified"
          && ![...verificationById.values()].some(({ fact }) =>
            fact.assurance === "verified"
            && fact.subject.provider === "github"
            && fact.subject.resourceRef === binding.resourceRef
            && fact.subject.resourceVersion === binding.resourceVersion
          ))
      ) throw new Error("completion_assessment_projection_authority_conflict");
      const artifactAuthority: CompletionArtifact = {
        id: candidate.id,
        kind: candidate.kind,
        sourceRunId: input.runId,
        uri: candidate.uri,
        target: {
          key: binding.key,
          provider: binding.provider,
          resourceRef: binding.resourceRef,
          resourceVersion: binding.resourceVersion
        },
        recordedAt: run.updatedAt
      };
      const payload = CompletionEvidenceObservationPayloadV1Schema.parse({
        evidenceType: "run_artifact",
        evidenceId: candidate.id,
        authorityDigest: canonicalSha256Json(artifactAuthority),
        artifactKind: candidate.kind,
        sourceRunId: input.runId,
        target: {
          provider: binding.provider,
          resourceRef: binding.resourceRef,
          resourceVersion: binding.resourceVersion
        },
        observedAt: toControlTimestamp(run.updatedAt)
      });
      const existing = artifactById.get(candidate.id);
      if (existing && canonicalJsonStringify(existing.payload) !== canonicalJsonStringify(payload)) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      artifactById.set(candidate.id, { authority: artifactAuthority, payload });
    }

    const escalationById = new Map<string, {
      escalation: HumanEscalation;
      payload: CompletionEvidenceObservationPayloadV1;
    }>();
    for (const row of tx.select().from(humanEscalations).where(
      eq(humanEscalations.workThreadId, input.workThreadId)
    ).all()) {
      const escalation = HumanEscalationSchema.parse(JSON.parse(row.escalationJson));
      if (
        row.escalationJson !== JSON.stringify(escalation)
        || escalation.id !== row.id
        || escalation.workThreadId !== row.workThreadId
        || escalation.class !== row.class
        || escalation.state !== row.state
      ) throw new Error("completion_assessment_projection_authority_conflict");
      if (
        escalation.runId !== input.runId
        || escalation.attemptId !== authority.attemptId
        || !escalation.blocking
        || compareRfc3339Timestamps(escalation.openedAt, assessment.assessedAt) > 0
        || (escalation.state !== "open" && escalation.state !== "acknowledged")
      ) continue;
      escalationById.set(escalation.id, {
        escalation,
        payload: CompletionEvidenceObservationPayloadV1Schema.parse({
          evidenceType: "human_escalation",
          evidenceId: escalation.id,
          authorityDigest: canonicalSha256Json(escalation),
          class: escalation.class,
          state: escalation.state,
          blocking: true,
          reasonDigest: canonicalSha256Json(escalation.reason),
          observedAt: toControlTimestamp(escalation.openedAt)
        })
      });
    }

    const selectedEvidence = new Map<string, CompletionEvidenceObservationPayloadV1>();
    const selectEvidence = (
      payload: CompletionEvidenceObservationPayloadV1
    ): string => {
      const selectionKey = evidenceSelectionKey(payload);
      const existing = selectedEvidence.get(selectionKey);
      if (existing && canonicalJsonStringify(existing) !== canonicalJsonStringify(payload)) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      selectedEvidence.set(selectionKey, payload);
      return selectionKey;
    };
    type GateAuthority = {
      state: "passed" | "failed" | "missing" | "unknown" | "waived";
      reasonCode: string;
      evidenceIds: string[];
      evidenceKind?: "verification" | "material" | "artifact";
      waiverId?: string;
    };
    const authoritativeFacts = (
      records: Array<{ fact: CompletionEvidenceFact }>
    ): { records: Array<{ fact: CompletionEvidenceFact }>; conflicted: boolean } => {
      const ordered = [...records].sort((left, right) =>
        compareRfc3339Timestamps(right.fact.observedAt, left.fact.observedAt)
        || compareRfc3339Timestamps(right.fact.receivedAt, left.fact.receivedAt)
        || compareCompletionGateIds(left.fact.id, right.fact.id)
      );
      const latest = ordered[0];
      if (!latest) return { records: [], conflicted: false };
      const current = ordered.filter((item) =>
        compareRfc3339Timestamps(item.fact.observedAt, latest.fact.observedAt) === 0
        && compareRfc3339Timestamps(item.fact.receivedAt, latest.fact.receivedAt) === 0
      );
      const claims = new Set(current.map(({ fact }) => canonicalJsonStringify({
        assurance: fact.assurance,
        claim: fact.claim
      })));
      return { records: current, conflicted: claims.size > 1 };
    };
    const currentMaterialReceipts = (
      actionFamily: string
    ): {
      records: Array<{ receipt: MaterialActionReceipt; actionFamily: string }>;
      conflicted: boolean;
    } => {
      const ordered = [...materialById.values()]
        .filter((item) => item.actionFamily === actionFamily)
        .sort((left, right) =>
          compareRfc3339Timestamps(
            right.receipt.observedAt,
            left.receipt.observedAt
          )
          || compareCompletionGateIds(left.receipt.id, right.receipt.id)
        );
      const latest = ordered[0];
      if (!latest) return { records: [], conflicted: false };
      const current = ordered.filter((item) =>
        compareRfc3339Timestamps(
          item.receipt.observedAt,
          latest.receipt.observedAt
        ) === 0
      );
      return {
        records: current,
        conflicted: new Set(current.map((item) => item.receipt.outcome)).size > 1
      };
    };
    const exactIds = (left: string[], right: string[]): boolean =>
      canonicalJsonStringify([...new Set(left)].sort())
        === canonicalJsonStringify([...new Set(right)].sort());
    const canonicalActiveWaiver = [...waiverById.values()]
      .filter(({ waiver: candidate }) =>
        candidate.contractId === contract.id
        && candidate.contractVersion === contract.version
        && candidate.cycle === contract.cycle
        && (candidate.runId === undefined || candidate.runId === input.runId)
        && candidate.gateIds.every((gateId) => contractGateIds.has(gateId))
        && compareRfc3339Timestamps(
          candidate.waivedAt,
          assessment.assessedAt
        ) <= 0
        && (candidate.expiresAt === undefined
          || compareRfc3339Timestamps(
            candidate.expiresAt,
            assessment.assessedAt
          ) > 0)
      )
      .sort((left, right) => {
        const timeOrder = compareRfc3339Timestamps(
          left.waiver.waivedAt,
          right.waiver.waivedAt
        );
        if (timeOrder !== 0) return -timeOrder;
        return compareCompletionGateIds(left.waiver.id, right.waiver.id);
      })[0];
    const authorityForGate = (
      gate: CompletionAssessment["gateResults"][number]
    ): GateAuthority => {
      const syntheticEscalationId = gate.gateId.startsWith("human_escalation:")
        ? gate.gateId.slice("human_escalation:".length)
        : undefined;
      if (syntheticEscalationId) {
        if (!escalationById.has(syntheticEscalationId)) {
          throw new Error("completion_assessment_projection_authority_conflict");
        }
        return {
          state: "unknown",
          reasonCode: "human_acceptance_missing",
          evidenceIds: [syntheticEscalationId],
          evidenceKind: "verification"
        };
      }
      const contractGate = contract.gates.find((candidate) => candidate.id === gate.gateId);
      if (!contractGate) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      if (canonicalActiveWaiver?.waiver.gateIds.includes(gate.gateId)) {
        return {
          state: "waived",
          reasonCode: "gate_waived",
          evidenceIds: [],
          waiverId: canonicalActiveWaiver.waiver.id
        };
      }
      if (contract.mode === "execution_compat") {
        const exactCompatibilityContract = contract.gates.length === 1
          && contractGate.kind === "material_action"
          && contractGate.actionFamily === "executor_run"
          && contractGate.requiredOutcome === "succeeded"
          && assessment.targetBindings.length === 0;
        if (!exactCompatibilityContract) {
          throw new Error("completion_assessment_projection_authority_conflict");
        }
        return runResult.conclusion === "success"
          ? {
              state: "passed",
              reasonCode: "execution_succeeded",
              evidenceIds: [input.runId]
            }
          : {
              state: "failed",
              reasonCode: "execution_not_succeeded",
              evidenceIds: []
            };
      }
      if (contractGate.kind === "artifact") {
        const candidates = [...artifactById.values()].filter((item) =>
          item.authority.target?.key === contractGate.targetKey
        );
        const identities = new Set(candidates.map((item) => canonicalJsonStringify([
          item.authority.target?.provider,
          item.authority.target?.resourceRef,
          item.authority.target?.resourceVersion
        ])));
        if (identities.size > 1) {
          return { state: "unknown", reasonCode: "artifact_ambiguous", evidenceIds: [] };
        }
        const matching = candidates.filter((item) =>
          item.authority.kind === contractGate.artifactKind
        );
        return identities.size === 0 || matching.length < contractGate.minimum
          ? { state: "missing", reasonCode: "artifact_missing", evidenceIds: [] }
          : {
              state: "passed",
              reasonCode: "artifact_requirement_satisfied",
              evidenceIds: matching.map((item) => item.authority.id).sort(),
              evidenceKind: "artifact"
            };
      }
      if (contractGate.kind === "material_action") {
        const current = currentMaterialReceipts(contractGate.actionFamily);
        if (current.conflicted) {
          return {
            state: "unknown",
            reasonCode: "material_action_unknown",
            evidenceIds: current.records.map((item) => item.receipt.id).sort(),
            evidenceKind: "material"
          };
        }
        const required = current.records.filter((item) =>
          item.receipt.outcome === contractGate.requiredOutcome
        );
        if (required.length > 0) {
          return {
            state: "passed",
            reasonCode: "material_action_succeeded",
            evidenceIds: [required[0]!.receipt.id],
            evidenceKind: "material"
          };
        }
        const unknown = current.records.filter((item) => item.receipt.outcome === "unknown");
        if (unknown.length > 0) {
          return {
            state: "unknown",
            reasonCode: "material_action_unknown",
            evidenceIds: [unknown[0]!.receipt.id],
            evidenceKind: "material"
          };
        }
        const failed = current.records.filter((item) => item.receipt.outcome === "failed");
        return failed.length > 0
          ? {
              state: "failed",
              reasonCode: "material_action_failed",
              evidenceIds: [failed[0]!.receipt.id],
              evidenceKind: "material"
            }
          : { state: "missing", reasonCode: "material_action_missing", evidenceIds: [] };
      }
      if (contractGate.kind === "human_acceptance") {
        const authoritative = authoritativeFacts([...verificationById.values()].filter(
          ({ fact }) => fact.kind === "human.acceptance" && fact.claim.predicate === "role"
        ));
        const accepted = !authoritative.conflicted
          ? authoritative.records.filter(({ fact }) =>
              fact.assurance === "verified"
              && fact.claim.outcome === contractGate.requiredRole
            )
          : [];
        return accepted.length > 0
          ? {
              state: "passed",
              reasonCode: "human_acceptance_recorded",
              evidenceIds: [accepted[0]!.fact.id],
              evidenceKind: "verification"
            }
          : {
              state: "missing",
              reasonCode: "human_acceptance_missing",
              evidenceIds: []
            };
      }
      const binding = assessment.targetBindings.find((candidate) =>
        candidate.key === contractGate.targetKey
      );
      if (!binding) {
        return {
          state: "missing",
          reasonCode: contractGate.kind === "verification"
            ? "verification_missing"
            : "external_state_missing",
          evidenceIds: []
        };
      }
      if (contractGate.kind === "external_state" && binding.provider !== contractGate.provider) {
        return {
          state: "unknown",
          reasonCode: "external_state_subject_mismatch",
          evidenceIds: []
        };
      }
      const relevant = [...verificationById.values()].filter(({ fact }) =>
        fact.subject.provider === binding.provider
        && fact.subject.resourceRef === binding.resourceRef
        && fact.subject.resourceVersion === binding.resourceVersion
        && (contractGate.kind === "verification"
          ? fact.kind === contractGate.evidenceKind
          : fact.claim.predicate === "state")
      );
      if (relevant.length === 0) {
        const stale = [...verificationById.values()].filter(({ fact }) =>
          fact.subject.provider === binding.provider
          && fact.subject.resourceRef === binding.resourceRef
          && fact.subject.resourceVersion !== binding.resourceVersion
          && (contractGate.kind === "verification"
            ? fact.kind === contractGate.evidenceKind
            : fact.claim.predicate === "state")
        );
        return {
          state: "missing",
          reasonCode: stale.length > 0
            ? contractGate.kind === "verification"
              ? "verification_stale"
              : "external_state_stale"
            : contractGate.kind === "verification"
              ? "verification_missing"
              : "external_state_missing",
          evidenceIds: stale.map(({ fact }) => fact.id).sort(),
          ...(stale.length > 0 ? { evidenceKind: "verification" as const } : {})
        };
      }
      const authoritative = authoritativeFacts(relevant);
      if (authoritative.conflicted) {
        return {
          state: "unknown",
          reasonCode: contractGate.kind === "verification"
            ? "verification_assurance_insufficient"
            : "external_state_assurance_insufficient",
          evidenceIds: authoritative.records.map(({ fact }) => fact.id).sort(),
          evidenceKind: "verification"
        };
      }
      const assured = authoritative.records.filter(({ fact }) =>
        completionAssuranceAccepted(fact.assurance, contractGate.minimumAssurance)
      );
      if (assured.length === 0) {
        return {
          state: "unknown",
          reasonCode: contractGate.kind === "verification"
            ? "verification_assurance_insufficient"
            : "external_state_assurance_insufficient",
          evidenceIds: authoritative.records.map(({ fact }) => fact.id).sort(),
          evidenceKind: "verification"
        };
      }
      const satisfied = assured.filter(({ fact }) =>
        fact.claim.outcome === (
          contractGate.kind === "verification"
            ? contractGate.requiredOutcome
            : contractGate.requiredState
        )
        && (contractGate.kind !== "verification"
          || (contractGate.requiredObservations ?? []).every((name) =>
            fact.claim.observations?.[name] === "passed"
          ))
      );
      return satisfied.length > 0
        ? {
            state: "passed",
            reasonCode: contractGate.kind === "verification"
              ? "verification_passed"
              : "external_state_satisfied",
            evidenceIds: [satisfied[0]!.fact.id],
            evidenceKind: "verification"
          }
        : {
            state: "failed",
            reasonCode: contractGate.kind === "verification"
              ? "verification_failed"
              : "external_state_mismatch",
            evidenceIds: assured.map(({ fact }) => fact.id).sort(),
            evidenceKind: "verification"
          };
    };
    const selectedGateResults = [...assessment.gateResults]
      .sort((left, right) => compareCompletionGateIds(left.gateId, right.gateId))
      .map((gate) => {
        const expected = authorityForGate(gate);
        if (
          gate.state !== expected.state
          || gate.reasonCode !== expected.reasonCode
          || !exactIds(gate.evidenceIds, expected.evidenceIds)
        ) throw new Error("completion_assessment_projection_authority_conflict");
        let evidenceReceiptIds: string[] = [];
        if (expected.waiverId) {
          if (assessment.waiver?.id !== expected.waiverId) {
            throw new Error("completion_assessment_projection_authority_conflict");
          }
          evidenceReceiptIds = [selectEvidence(
            waiverById.get(expected.waiverId)!.payload
          )];
        } else if (expected.evidenceKind === "verification") {
          evidenceReceiptIds = expected.evidenceIds.map((id) => {
            const record = verificationById.get(id) ?? escalationById.get(id);
            if (!record) {
              throw new Error("completion_assessment_projection_authority_conflict");
            }
            return selectEvidence(record.payload);
          });
        } else if (expected.evidenceKind === "material") {
          evidenceReceiptIds = expected.evidenceIds.map((id) => {
            const record = materialById.get(id);
            if (!record) {
              throw new Error("completion_assessment_projection_authority_conflict");
            }
            return selectEvidence(record.payload);
          });
        } else if (expected.evidenceKind === "artifact") {
          evidenceReceiptIds = expected.evidenceIds.map((id) => {
            const record = artifactById.get(id);
            if (!record) {
              throw new Error("completion_assessment_projection_authority_conflict");
            }
            return selectEvidence(record.payload);
          });
        }
        return {
          gateId: gate.gateId,
          state: gate.state === "passed"
          ? "satisfied" as const
          : gate.state === "failed"
            ? "unsatisfied" as const
            : gate.state === "missing"
              ? "pending" as const
              : gate.state === "unknown"
                ? "blocked" as const
                : "waived" as const,
          reasonCode: gate.reasonCode,
          evidenceReceiptIds: [...new Set(evidenceReceiptIds)].sort()
        };
      });
    const activeEscalationGateIds = [...escalationById.keys()]
      .map((id) => `human_escalation:${id}`)
      .sort();
    const projectedEscalationGateIds = assessment.gateResults
      .filter((gate) => gate.gateId.startsWith("human_escalation:"))
      .map((gate) => gate.gateId)
      .sort();
    const uniqueAssessmentGateIds = new Set(
      assessment.gateResults.map((gate) => gate.gateId)
    );
    const contractGateStates = assessment.gateResults.filter((gate) =>
      contractGateIds.has(gate.gateId)
    );
    const effectiveGateStates = selectedGateResults.map((gate) => gate.state);
    const expectedAssessmentState = reduceCompletionGateStates(
      effectiveGateStates
    );
    let supersededAssessment: CompletionAssessment | undefined;
    if (assessment.supersedesAssessmentId) {
      const supersededRow = tx.select().from(completionAssessments).where(and(
        eq(completionAssessments.id, assessment.supersedesAssessmentId),
        eq(completionAssessments.workThreadId, assessment.workThreadId)
      )).limit(1).get();
      if (!supersededRow) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      supersededAssessment = CompletionAssessmentSchema.parse(
        JSON.parse(supersededRow.assessmentJson)
      );
      if (
        supersededRow.assessmentJson !== JSON.stringify(supersededAssessment)
        || supersededAssessment.id !== assessment.supersedesAssessmentId
      ) throw new Error("completion_assessment_projection_authority_conflict");
    }
    const assessmentAccepted = assessment.state === "satisfied"
      || assessment.state === "waived";
    const supersededAccepted = supersededAssessment?.state === "satisfied"
      || supersededAssessment?.state === "waived";
    const acceptedAtLineageMismatch = assessmentAccepted
      && (
        assessment.acceptedAt === undefined
        || (supersededAccepted
          ? supersededAssessment?.acceptedAt === undefined
            || compareRfc3339Timestamps(
              assessment.acceptedAt,
              supersededAssessment.acceptedAt
            ) !== 0
          : compareRfc3339Timestamps(
              assessment.acceptedAt,
              assessment.assessedAt
            ) !== 0)
      );
    if (
      uniqueAssessmentGateIds.size !== assessment.gateResults.length
      || !exactIds(activeEscalationGateIds, projectedEscalationGateIds)
      || contractGateStates.length !== contract.gates.length
      || assessment.state !== expectedAssessmentState
      || (contract.mode === "execution_compat"
        && assessment.state !== "waived"
        && assessment.evidenceBacked)
      || (contract.mode === "governed"
        && (assessment.state === "satisfied" || assessment.state === "waived")
        && !assessment.evidenceBacked)
      || acceptedAtLineageMismatch
      || selectedGateResults.some((gate) =>
        (gate.state === "waived"
          || (contract.mode === "governed" && gate.state === "satisfied"))
        && gate.evidenceReceiptIds.length === 0
      )
    ) throw new Error("completion_assessment_projection_authority_conflict");
    let waiver: {
      ref: string;
      actorRef: string;
      reasonDigest: string;
    } | undefined;
    const hasWaivedGate = selectedGateResults.some((gate) => gate.state === "waived");
    if (
      hasWaivedGate !== Boolean(assessment.waiver)
      || (assessment.waiver
        ? assessment.assessedBy !== "human"
        : assessment.assessedBy !== "opentag")
    ) {
      throw new Error("completion_assessment_projection_authority_conflict");
    }
    if (assessment.waiver) {
      const waiverRow = tx.select().from(completionWaivers).where(and(
        eq(completionWaivers.id, assessment.waiver.id),
        eq(completionWaivers.workThreadId, assessment.workThreadId),
        eq(completionWaivers.contractId, assessment.contractId),
        eq(completionWaivers.contractVersion, assessment.contractVersion),
        eq(completionWaivers.cycle, assessment.cycle)
      )).limit(1).get();
      if (!waiverRow || waiverRow.waiverJson !== JSON.stringify(assessment.waiver)) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      waiver = {
        ref: assessment.waiver.id,
        actorRef: `actor_${canonicalSha256Json(assessment.waiver.actor)
          .slice("sha256:".length)}`,
        reasonDigest: canonicalSha256Json(assessment.waiver.reason)
      };
    }

    const projectionLifecycleDependency = (
      row: typeof controlPlaneProjectionOutbox.$inferSelect
    ): typeof hostedLifecycleOperations.$inferSelect => {
      if (!row.requiresLifecycleOperationId) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      const lifecycleRows = tx.select().from(hostedLifecycleOperations).where(and(
        eq(hostedLifecycleOperations.destinationId, row.destinationId),
        eq(hostedLifecycleOperations.organizationId, row.organizationId),
        eq(hostedLifecycleOperations.operationId, row.requiresLifecycleOperationId)
      )).all();
      if (
        lifecycleRows.length !== 1
        || lifecycleRows[0]!.action !== "complete"
        || lifecycleRows[0]!.runId !== row.runId
        || !validAcknowledgedLifecycleDependency(lifecycleRows[0]!)
      ) throw new Error("completion_assessment_projection_authority_conflict");
      return lifecycleRows[0]!;
    };

    let predecessorAssessmentRow: typeof controlPlaneProjectionOutbox.$inferSelect
      | undefined;
    let predecessorAssessmentEnvelope: ReturnType<
      typeof CompletionAssessmentReceiptEnvelopeV1Schema.parse
    > | undefined;
    if (assessment.supersedesAssessmentId) {
      const predecessorRows = tx.select().from(controlPlaneProjectionOutbox).where(and(
        eq(controlPlaneProjectionOutbox.destinationId, claim.destinationId),
        eq(controlPlaneProjectionOutbox.organizationId, authority.organizationId),
        eq(controlPlaneProjectionOutbox.workThreadId, input.workThreadId),
        eq(controlPlaneProjectionOutbox.receiptKind, "completion_assessment")
      )).all().filter((row) => {
        try {
          const predecessor = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
            JSON.parse(row.envelopeJson)
          );
          return predecessor.payload.assessmentId === assessment.supersedesAssessmentId;
        } catch {
          throw new Error("completion_assessment_projection_authority_conflict");
        }
      });
      if (predecessorRows.length !== 1) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      predecessorAssessmentRow = predecessorRows[0]!;
      predecessorAssessmentEnvelope = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
        JSON.parse(predecessorAssessmentRow.envelopeJson)
      );
      const predecessorLifecycle = projectionLifecycleDependency(
        predecessorAssessmentRow
      );
      const predecessorCompletionRequest = HostedCompleteRequestV1Schema.parse(
        JSON.parse(predecessorLifecycle.requestJson)
      );
      if (
        predecessorAssessmentRow.envelopeJson
          !== canonicalJsonStringify(predecessorAssessmentEnvelope)
        || predecessorAssessmentRow.receiptDigest
          !== predecessorAssessmentEnvelope.receiptDigest
        || predecessorAssessmentRow.runId !== predecessorAssessmentEnvelope.runId
        || predecessorAssessmentRow.workThreadId
          !== predecessorAssessmentEnvelope.workThreadId
        || predecessorAssessmentEnvelope.workThreadId !== input.workThreadId
        || predecessorAssessmentEnvelope.payload.executorResultReceiptRef.receiptId
          !== predecessorLifecycle.receiptId
        || predecessorAssessmentEnvelope.payload.executorResultReceiptRef.operationId
          !== predecessorLifecycle.operationId
        || predecessorAssessmentEnvelope.payload.executorResultReceiptRef.requestId
          !== predecessorLifecycle.requestId
        || predecessorAssessmentEnvelope.payload.executorResultReceiptRef.requestDigest
          !== predecessorLifecycle.requestDigest
        || predecessorAssessmentEnvelope.payload.executorResultReceiptRef.resultDigest
          !== predecessorCompletionRequest.resultDigest
        || !(predecessorAssessmentEnvelope.predecessorReceiptDigests ?? []).includes(
          predecessorLifecycle.receiptDigest!
        )
      ) throw new Error("completion_assessment_projection_authority_conflict");
      assertProjectionCustodySafe(predecessorAssessmentEnvelope);
      assertProjectionDigests(predecessorAssessmentEnvelope);
    }
    const sameRunPredecessor = predecessorAssessmentEnvelope?.runId === input.runId;
    const crossRunPredecessor = predecessorAssessmentEnvelope !== undefined
      && !sameRunPredecessor;

    const localCreationAuthority = {
      schemaVersion: 1 as const,
      kind: "work_thread_created" as const,
      workThreadId: thread.id,
      scopeId: thread.scopeId,
      canonicalKey: thread.canonicalKey,
      provider: thread.provider,
      ownerContainerId: thread.ownerContainerId,
      workItemKind: thread.workItemKind,
      externalId: thread.externalId,
      createdAt: thread.createdAt
    };
    const localCreationReceiptDigest = canonicalSha256Json(localCreationAuthority);
    const localCreationReceiptId = `local_work_thread_creation_${localCreationReceiptDigest
      .slice("sha256:".length)}`;
    const workThreadIdentity = {
      namespace: "opentag.control.receipt/work-thread-ref/v1" as const,
      parts: [authority.organizationId, input.runId, input.workThreadId]
    };
    const workThreadProjectionKey = canonicalSha256Json({
      purpose: "opentag-work-thread-ref-projection-v1",
      identity: workThreadIdentity
    }).slice("sha256:".length);
    const workThreadObservedAt = [
      thread.createdAt,
      importedRun.importedAt,
      ...(crossRunPredecessor && predecessorAssessmentEnvelope
        ? [predecessorAssessmentEnvelope.observedAt]
        : [])
    ].sort(compareRfc3339Timestamps).at(-1)!;
    const workThreadPayload = {
      workThreadId: input.workThreadId,
      sourceIdentityDigest: importedRun.sourceIdentityDigest,
      localCreationReceiptId,
      localCreationReceiptDigest,
      lineageKind: "hosted_source_identity",
      hostedAuthorityRef: {
        claimOperationId: importedRun.claimOperationId,
        authorityDigest: importedRun.authorityDigest,
        attempt: projectionAttempt,
        admissionPolicySnapshot: {
          receiptId: authority.admissionPolicyReceiptId,
          snapshotId: authority.admissionPolicySnapshotId,
          digest: authority.admissionPolicySnapshotDigest
        }
      },
      createdAt: toControlTimestamp(thread.createdAt)
    };
    const workThreadBase = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      receiptKind: "work_thread_ref" as const,
      receiptId: `work_thread_receipt_${workThreadProjectionKey}`,
      organizationId: authority.organizationId,
      operationId: `work_thread_operation_${workThreadProjectionKey}`,
      requiredCapabilities: ["relay.work-thread-ref.v1" as const],
      producer: projectionProducer,
      identity: workThreadIdentity,
      predecessorReceiptDigests: [...new Set([
        importedRun.authorityDigest,
        authority.admissionPolicySnapshotDigest,
        ...(crossRunPredecessor && predecessorAssessmentEnvelope
          ? [predecessorAssessmentEnvelope.receiptDigest]
          : [])
      ])].sort(),
      observedAt: toControlTimestamp(workThreadObservedAt),
      runId: input.runId,
      workThreadId: input.workThreadId,
      payload: workThreadPayload,
      payloadDigest: canonicalSha256Json(workThreadPayload)
    };
    const workThreadEnvelope = WorkThreadRefReceiptEnvelopeV1Schema.parse({
      ...workThreadBase,
      receiptDigest: canonicalSha256Json(workThreadBase)
    });
    assertProjectionCustodySafe(workThreadEnvelope);
    assertProjectionDigests(workThreadEnvelope);
    const existingWorkThreadRow = tx.select().from(controlPlaneProjectionOutbox)
      .where(and(
        eq(controlPlaneProjectionOutbox.destinationId, claim.destinationId),
        eq(controlPlaneProjectionOutbox.organizationId, authority.organizationId),
        eq(controlPlaneProjectionOutbox.receiptId, workThreadEnvelope.receiptId)
      )).limit(1).get();
    const workThreadDependsOnReceiptId = crossRunPredecessor
      ? predecessorAssessmentRow!.receiptId
      : undefined;
    if (existingWorkThreadRow) {
      const existingWorkThreadLifecycle = projectionLifecycleDependency(
        existingWorkThreadRow
      );
      if (
        existingWorkThreadRow.envelopeJson !== canonicalJsonStringify(workThreadEnvelope)
        || existingWorkThreadRow.receiptDigest !== workThreadEnvelope.receiptDigest
        || existingWorkThreadRow.dependsOnReceiptId
          !== (workThreadDependsOnReceiptId ?? null)
        || (!sameRunPredecessor
          && existingWorkThreadLifecycle.operationId !== completion.operationId)
      ) throw new Error("completion_assessment_projection_authority_conflict");
    } else {
      if (sameRunPredecessor) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
        destinationId: claim.destinationId,
        envelope: workThreadEnvelope,
        ...(workThreadDependsOnReceiptId
          ? { dependsOnReceiptId: workThreadDependsOnReceiptId }
          : {}),
        requiresLifecycleOperationId: completion.operationId,
        now: new Date(workThreadObservedAt)
      }));
    }

    let chainParentReceiptId = sameRunPredecessor
      ? predecessorAssessmentRow!.receiptId
      : workThreadEnvelope.receiptId;
    let chainParentReceiptDigest = sameRunPredecessor
      ? predecessorAssessmentEnvelope!.receiptDigest
      : workThreadEnvelope.receiptDigest;

    const contractIdentity = {
      namespace: "opentag.control.receipt/completion-contract-ref/v1" as const,
      parts: [
        authority.organizationId,
        input.runId,
        input.workThreadId,
        contract.id,
        String(contract.version),
        String(contract.cycle)
      ]
    };
    const contractProjectionKey = canonicalSha256Json({
      purpose: "opentag-completion-contract-ref-projection-v1",
      identity: contractIdentity
    }).slice("sha256:".length);
    const predecessorContract = predecessorAssessmentEnvelope?.payload.contract;
    const sameContractTuple = predecessorContract !== undefined
      && predecessorContract.contractId === contract.id
      && predecessorContract.version === contract.version
      && predecessorContract.cycle === contract.cycle;
    const sameRunContractEvolution = sameRunPredecessor && !sameContractTuple;
    if (
      sameRunContractEvolution
      && predecessorContract
      && !(
        contract.cycle > predecessorContract.cycle
        || (
          contract.cycle === predecessorContract.cycle
          && contract.version > predecessorContract.version
        )
      )
    ) throw new Error("completion_assessment_projection_authority_conflict");
    const contractPayload = {
      contractId: contract.id,
      version: contract.version,
      cycle: contract.cycle,
      mode: contract.mode,
      contentDigest: contractRow.contentDigest,
      resolvedTargetDigests: [] as [],
      requiredGateIds: contract.gates.map((gate) => gate.id)
        .sort(compareCompletionGateIds),
      createdAt: toControlTimestamp(contract.createdAt),
      ...(sameRunContractEvolution && predecessorContract
        ? { supersedesContractId: predecessorContract.contractId }
        : {})
    };
    const contractReceiptId = `completion_contract_receipt_${contractProjectionKey}`;
    const existingContractRow = tx.select().from(controlPlaneProjectionOutbox).where(and(
      eq(controlPlaneProjectionOutbox.destinationId, claim.destinationId),
      eq(controlPlaneProjectionOutbox.organizationId, authority.organizationId),
      eq(controlPlaneProjectionOutbox.receiptId, contractReceiptId)
    )).limit(1).get();
    let contractEnvelope: ReturnType<typeof CompletionContractRefReceiptEnvelopeV1Schema.parse>;
    if (existingContractRow) {
      const existingContractLifecycle = projectionLifecycleDependency(existingContractRow);
      contractEnvelope = CompletionContractRefReceiptEnvelopeV1Schema.parse(
        JSON.parse(existingContractRow.envelopeJson)
      );
      const contractParentRow = existingContractRow.dependsOnReceiptId
        ? tx.select().from(controlPlaneProjectionOutbox).where(and(
            eq(controlPlaneProjectionOutbox.destinationId, claim.destinationId),
            eq(controlPlaneProjectionOutbox.organizationId, authority.organizationId),
            eq(controlPlaneProjectionOutbox.receiptId, existingContractRow.dependsOnReceiptId)
          )).limit(1).get()
        : undefined;
      if (
        existingContractRow.envelopeJson !== canonicalJsonStringify(contractEnvelope)
        || existingContractRow.receiptDigest !== contractEnvelope.receiptDigest
        || contractEnvelope.receiptId !== contractReceiptId
        || contractEnvelope.operationId
          !== `completion_contract_operation_${contractProjectionKey}`
        || contractEnvelope.organizationId !== authority.organizationId
        || canonicalJsonStringify(contractEnvelope.producer)
          !== canonicalJsonStringify(projectionProducer)
        || canonicalJsonStringify(contractEnvelope.identity)
          !== canonicalJsonStringify(contractIdentity)
        || contractEnvelope.runId !== input.runId
        || contractEnvelope.workThreadId !== input.workThreadId
        || canonicalJsonStringify(contractEnvelope.payload)
          !== canonicalJsonStringify(contractPayload)
        || compareRfc3339Timestamps(
          contractEnvelope.observedAt,
          contractPayload.createdAt
        ) < 0
        || compareRfc3339Timestamps(
          contractEnvelope.observedAt,
          workThreadEnvelope.observedAt
        ) < 0
        || !contractParentRow
        || !(contractEnvelope.predecessorReceiptDigests ?? []).includes(
          contractParentRow.receiptDigest
        )
        || !(contractEnvelope.predecessorReceiptDigests ?? []).includes(
          workThreadEnvelope.receiptDigest
        )
        || (!sameRunPredecessor || !sameContractTuple)
          && (
            existingContractLifecycle.operationId !== completion.operationId
            || existingContractRow.dependsOnReceiptId !== chainParentReceiptId
          )
      ) throw new Error("completion_assessment_projection_authority_conflict");
      assertProjectionCustodySafe(contractEnvelope);
      assertProjectionDigests(contractEnvelope);
      if (!sameRunPredecessor || !sameContractTuple) {
        chainParentReceiptId = contractEnvelope.receiptId;
        chainParentReceiptDigest = contractEnvelope.receiptDigest;
      }
    } else {
      if (sameRunPredecessor && sameContractTuple) {
        throw new Error("completion_assessment_projection_authority_conflict");
      }
      const contractObservedAt = [
        contract.createdAt,
        workThreadEnvelope.observedAt,
        ...(predecessorAssessmentEnvelope
          ? [predecessorAssessmentEnvelope.observedAt]
          : [])
      ].sort(compareRfc3339Timestamps).at(-1)!;
      const contractBase = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        receiptKind: "completion_contract_ref" as const,
        receiptId: contractReceiptId,
        organizationId: authority.organizationId,
        operationId: `completion_contract_operation_${contractProjectionKey}`,
        requiredCapabilities: ["relay.completion-contract-ref.v1" as const],
        producer: projectionProducer,
        identity: contractIdentity,
        predecessorReceiptDigests: [...new Set([
          workThreadEnvelope.receiptDigest,
          chainParentReceiptDigest
        ])].sort(),
        observedAt: toControlTimestamp(contractObservedAt),
        runId: input.runId,
        workThreadId: input.workThreadId,
        payload: contractPayload,
        payloadDigest: canonicalSha256Json(contractPayload)
      };
      contractEnvelope = CompletionContractRefReceiptEnvelopeV1Schema.parse({
        ...contractBase,
        receiptDigest: canonicalSha256Json(contractBase)
      });
      assertProjectionCustodySafe(contractEnvelope);
      assertProjectionDigests(contractEnvelope);
      assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
        destinationId: claim.destinationId,
        envelope: contractEnvelope,
        dependsOnReceiptId: chainParentReceiptId,
        requiresLifecycleOperationId: completion.operationId,
        now: new Date(contractObservedAt)
      }));
      chainParentReceiptId = contractEnvelope.receiptId;
      chainParentReceiptDigest = contractEnvelope.receiptDigest;
    }

    const finalEvidenceBySelectionKey = new Map<
      string,
      CompletionEvidenceObservationReceiptEnvelopeV1
    >();
    const orderedEvidence = [...selectedEvidence.entries()].sort(
      ([leftSelectionKey, left], [rightSelectionKey, right]) =>
        left.evidenceType.localeCompare(right.evidenceType)
        || left.evidenceId.localeCompare(right.evidenceId)
        || leftSelectionKey.localeCompare(rightSelectionKey)
    );
    for (const [selectionKey, evidencePayload] of orderedEvidence) {
      const receiptId = evidenceReceiptId(
        evidencePayload,
        contractEnvelope.receiptDigest
      );
      const existing = tx.select().from(controlPlaneProjectionOutbox).where(and(
        eq(controlPlaneProjectionOutbox.destinationId, claim.destinationId),
        eq(controlPlaneProjectionOutbox.organizationId, authority.organizationId),
        eq(controlPlaneProjectionOutbox.receiptId, receiptId)
      )).limit(1).get();
      if (existing) {
        projectionLifecycleDependency(existing);
        const persistedEnvelope = CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
          JSON.parse(existing.envelopeJson)
        );
        const persistedParent = existing.dependsOnReceiptId
          ? tx.select().from(controlPlaneProjectionOutbox).where(and(
              eq(controlPlaneProjectionOutbox.destinationId, claim.destinationId),
              eq(controlPlaneProjectionOutbox.organizationId, authority.organizationId),
              eq(controlPlaneProjectionOutbox.receiptId, existing.dependsOnReceiptId)
            )).limit(1).get()
          : undefined;
        const isCurrentChainEvidence = existing.dependsOnReceiptId
          === chainParentReceiptId;
        if (
          existing.envelopeJson !== canonicalJsonStringify(persistedEnvelope)
          || existing.receiptDigest !== persistedEnvelope.receiptDigest
          || persistedEnvelope.receiptId !== receiptId
          || persistedEnvelope.organizationId !== authority.organizationId
          || canonicalJsonStringify(persistedEnvelope.producer)
            !== canonicalJsonStringify(projectionProducer)
          || canonicalJsonStringify(persistedEnvelope.identity)
            !== canonicalJsonStringify(evidenceIdentity(
              evidencePayload,
              contractEnvelope.receiptDigest
            ))
          || persistedEnvelope.runId !== input.runId
          || persistedEnvelope.workThreadId !== input.workThreadId
          || canonicalJsonStringify(persistedEnvelope.attempt)
            !== canonicalJsonStringify(projectionAttempt)
          || canonicalJsonStringify(persistedEnvelope.payload)
            !== canonicalJsonStringify(evidencePayload)
          || !persistedParent
          || !(persistedEnvelope.predecessorReceiptDigests ?? []).includes(
            persistedParent.receiptDigest
          )
          || !(persistedEnvelope.predecessorReceiptDigests ?? []).includes(
            completionReceipt.receiptDigest
          )
          || !(persistedEnvelope.predecessorReceiptDigests ?? []).includes(
            contractEnvelope.receiptDigest
          )
          || ((!sameRunPredecessor || !sameContractTuple)
            && !isCurrentChainEvidence)
        ) throw new Error("completion_assessment_projection_authority_conflict");
        assertProjectionCustodySafe(persistedEnvelope);
        assertProjectionDigests(persistedEnvelope);
        finalEvidenceBySelectionKey.set(selectionKey, persistedEnvelope);
        if (isCurrentChainEvidence) {
          chainParentReceiptId = persistedEnvelope.receiptId;
          chainParentReceiptDigest = persistedEnvelope.receiptDigest;
        }
        continue;
      }
      const evidence = evidenceEnvelope(
        evidencePayload,
        contractEnvelope.receiptDigest,
        [
        completionReceipt.receiptDigest,
        contractEnvelope.receiptDigest,
        chainParentReceiptDigest
        ]
      );
      assertProjectionCustodySafe(evidence);
      assertProjectionDigests(evidence);
      assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
        destinationId: claim.destinationId,
        envelope: evidence,
        dependsOnReceiptId: chainParentReceiptId,
        requiresLifecycleOperationId: completion.operationId,
        now: new Date(evidence.observedAt)
      }));
      finalEvidenceBySelectionKey.set(selectionKey, evidence);
      chainParentReceiptId = evidence.receiptId;
      chainParentReceiptDigest = evidence.receiptDigest;
    }

    const gateResults = selectedGateResults.map((gate) => ({
      gateId: gate.gateId,
      state: gate.state,
      reasonCode: gate.reasonCode,
      evidenceReceiptDigests: gate.evidenceReceiptIds.map((selectionKey) => {
        const evidence = finalEvidenceBySelectionKey.get(selectionKey);
        if (!evidence) throw new Error("completion_assessment_projection_authority_conflict");
        return evidence.receiptDigest;
      }).sort()
    }));
    const evidenceReceiptDigests = [...new Set(
      gateResults.flatMap((gate) => gate.evidenceReceiptDigests)
    )].sort();

    const identity = {
      namespace: "opentag.control.receipt/completion-assessment/v1" as const,
      parts: [authority.organizationId, input.workThreadId, assessment.id]
    };
    const projectionKey = canonicalSha256Json({
      purpose: "opentag-completion-assessment-projection-v1",
      identity
    }).slice("sha256:".length);
    const payload = {
      assessmentId: assessment.id,
      workThreadId: assessment.workThreadId,
      contract: {
        contractId: contract.id,
        version: contract.version,
        cycle: contract.cycle,
        mode: contract.mode,
        contentDigest: contractRow.contentDigest
      },
      admissionPolicySnapshot: {
        snapshotId: authority.admissionPolicySnapshotId,
        digest: authority.admissionPolicySnapshotDigest
      },
      runId: input.runId,
      attempt: {
        attemptId: authority.attemptId,
        attemptNumber: authority.attemptNumber,
        epoch: authority.epoch,
        fencingTokenDigest: authority.fencingTokenDigest
      },
      executorResultReceiptRef: {
        receiptId: completionReceipt.receiptId,
        operationId: completion.operationId,
        requestId: completion.requestId,
        requestDigest: completion.requestDigest,
        resultDigest: completionRequest.resultDigest
      },
      assessmentInputDigest: assessment.inputDigest,
      evidenceReceiptDigests,
      gateResults,
      conclusion: assessment.state,
      assessedAt: toControlTimestamp(assessment.assessedAt),
      assessedBy: assessment.assessedBy === "opentag" ? "local_opentag" : "human",
      ...(assessment.supersedesAssessmentId
        ? { supersedesAssessmentId: assessment.supersedesAssessmentId }
        : {}),
      ...(waiver ? { waiver } : {})
    };
    const base = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      receiptKind: "completion_assessment" as const,
      receiptId: `assessment_receipt_${projectionKey}`,
      organizationId: authority.organizationId,
      operationId: `assessment_operation_${projectionKey}`,
      requiredCapabilities: ["relay.completion-assessment.v1" as const],
      producer: projectionProducer,
      identity,
      predecessorReceiptDigests: [...new Set([
        completionReceipt.receiptDigest,
        contractEnvelope.receiptDigest,
        ...evidenceReceiptDigests,
        ...(predecessorAssessmentEnvelope
          ? [predecessorAssessmentEnvelope.receiptDigest]
          : [])
      ])].sort(),
      observedAt: toControlTimestamp(assessment.assessedAt),
      runId: input.runId,
      workThreadId: input.workThreadId,
      attempt: projectionAttempt,
      payload,
      payloadDigest: canonicalSha256Json(payload)
    };
    const envelope = CompletionAssessmentReceiptEnvelopeV1Schema.parse({
      ...base,
      receiptDigest: canonicalSha256Json(base)
    });
    assertProjectionCustodySafe(envelope);
    assertProjectionDigests(envelope);
    const existingAssessment = tx.select().from(controlPlaneProjectionOutbox).where(and(
      eq(controlPlaneProjectionOutbox.destinationId, claim.destinationId),
      eq(controlPlaneProjectionOutbox.organizationId, authority.organizationId),
      eq(controlPlaneProjectionOutbox.receiptId, envelope.receiptId)
    )).limit(1).get();
    if (existingAssessment) {
      if (
        existingAssessment.receiptDigest !== envelope.receiptDigest
        || existingAssessment.envelopeJson !== canonicalJsonStringify(envelope)
        || existingAssessment.requiresLifecycleOperationId !== completion.operationId
        || existingAssessment.dependsOnReceiptId !== chainParentReceiptId
      ) throw new Error("completion_assessment_projection_authority_conflict");
      return;
    }
    assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
      destinationId: claim.destinationId,
      envelope,
      dependsOnReceiptId: chainParentReceiptId,
      requiresLifecycleOperationId: completion.operationId,
      now: new Date(assessment.assessedAt)
    }));
  }

  function assertGovernedCallbackAuthorityTx(
    tx: ProjectionTransaction,
    intent: typeof governedCallbackIntents.$inferSelect,
    options: { requireCurrentAssessment?: boolean } = {}
  ): typeof callbackDeliveries.$inferSelect {
    if (
      intent.completionOperationId === null
      || intent.assessmentReceiptId === null
      || intent.assessmentReceiptDigest === null
      || intent.localDeliveryId === null
      || intent.targetIdentityDigest === null
    ) throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_AUTHORITY_CONFLICT");
    let intentEnvelope: typeof CallbackIntentObservationReceiptEnvelopeV1Schema._output;
    try {
      intentEnvelope = CallbackIntentObservationReceiptEnvelopeV1Schema.parse(
        JSON.parse(intent.intentReceiptJson)
      );
    } catch {
      throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_AUTHORITY_CONFLICT");
    }
    const assessmentRef = intentEnvelope.payload.assessmentRef;
    const importedRun = tx.select().from(hostedRunImports).where(and(
      eq(hostedRunImports.runId, intent.runId),
      eq(hostedRunImports.admissionId, intent.admissionId),
      eq(hostedRunImports.admissionOperationId, intent.admissionOperationId),
      eq(hostedRunImports.claimOperationId, intent.claimOperationId),
      eq(hostedRunImports.attemptId, intent.runAttemptId),
      eq(hostedRunImports.fencingTokenDigest, intent.fencingTokenDigest),
      eq(hostedRunImports.workThreadId, intent.workThreadId),
      eq(hostedRunImports.sourceIdentityDigest,
        intentEnvelope.payload.sourceThreadIdentityDigest)
    )).limit(1).get();
    const importedAttempt = tx.select().from(hostedAttemptImports).where(and(
      eq(hostedAttemptImports.attemptId, intent.runAttemptId),
      eq(hostedAttemptImports.runId, intent.runId),
      eq(hostedAttemptImports.attemptNumber, intent.runAttemptNumber),
      eq(hostedAttemptImports.claimOperationId, intent.claimOperationId),
      eq(hostedAttemptImports.fencingTokenDigest, intent.fencingTokenDigest)
    )).limit(1).get();
    const claim = tx.select().from(hostedClaimOperations).where(and(
      eq(hostedClaimOperations.operationId, intent.claimOperationId),
      eq(hostedClaimOperations.destinationId, intent.destinationId),
      eq(hostedClaimOperations.organizationId, intent.organizationId),
      eq(hostedClaimOperations.runnerId, intent.runnerId),
      eq(hostedClaimOperations.runId, intent.runId),
      eq(hostedClaimOperations.credentialId, intent.credentialId),
      eq(hostedClaimOperations.attemptId, intent.runAttemptId),
      eq(hostedClaimOperations.attemptNumber, intent.runAttemptNumber),
      eq(hostedClaimOperations.fencingTokenDigest, intent.fencingTokenDigest),
      eq(hostedClaimOperations.state, "claimed"),
      isNotNull(hostedClaimOperations.executionStartedAt),
      isNull(hostedClaimOperations.terminalReasonCode)
    )).limit(1).get();
    const completion = tx.select().from(hostedLifecycleOperations).where(and(
      eq(hostedLifecycleOperations.destinationId, intent.destinationId),
      eq(hostedLifecycleOperations.organizationId, intent.organizationId),
      eq(hostedLifecycleOperations.runnerId, intent.runnerId),
      eq(hostedLifecycleOperations.credentialId, intent.credentialId),
      eq(hostedLifecycleOperations.operationId, intent.completionOperationId),
      eq(hostedLifecycleOperations.action, "complete"),
      eq(hostedLifecycleOperations.runId, intent.runId),
      eq(hostedLifecycleOperations.attemptId, intent.runAttemptId),
      eq(hostedLifecycleOperations.attemptNumber, intent.runAttemptNumber),
      eq(hostedLifecycleOperations.fencingTokenDigest, intent.fencingTokenDigest)
    )).limit(1).get();
    const delivery = tx.select().from(callbackDeliveries).where(and(
      eq(callbackDeliveries.id, intent.localDeliveryId),
      eq(callbackDeliveries.runId, intent.runId),
      eq(callbackDeliveries.provider, "github"),
      eq(callbackDeliveries.dispatchMode, "governed")
    )).limit(1).get();
    const run = tx.select().from(runs).where(eq(runs.id, intent.runId)).limit(1).get();
    const thread = tx.select().from(workThreads)
      .where(eq(workThreads.id, intent.workThreadId)).limit(1).get();
    const assessmentRow = tx.select().from(completionAssessments).where(and(
      eq(completionAssessments.id, assessmentRef),
      eq(completionAssessments.workThreadId, intent.workThreadId)
    )).limit(1).get();
    const assessmentProjection = tx.select().from(controlPlaneProjectionOutbox).where(and(
      eq(controlPlaneProjectionOutbox.destinationId, intent.destinationId),
      eq(controlPlaneProjectionOutbox.organizationId, intent.organizationId),
      eq(controlPlaneProjectionOutbox.receiptId, intent.assessmentReceiptId),
      eq(controlPlaneProjectionOutbox.receiptDigest, intent.assessmentReceiptDigest),
      eq(controlPlaneProjectionOutbox.receiptKind, "completion_assessment")
    )).limit(1).get();
    try {
      if (!importedRun || !importedAttempt || !claim || !completion || !delivery || !run
        || !thread || !assessmentRow || !assessmentProjection
        || importedRun.authorityDigest !== importedAttempt.authorityDigest
        || importedRun.authorityDigest !== claim.authorityDigest
        || importedRun.authorityJson !== importedAttempt.authorityJson
        || importedRun.authorityJson !== claim.authorityJson
        || importedRun.claimDigest !== importedAttempt.claimDigest
        || importedRun.claimDigest !== claim.claimDigest
        || !validAcknowledgedLifecycleDependency(completion)
        || (options.requireCurrentAssessment !== false
          && thread.currentAssessmentId !== assessmentRef)
        || delivery.governedState !== intent.state
        || governedCallbackPayloadDigest(delivery) !== intent.payloadDigest
        || assessmentProjection.requiresLifecycleOperationId
          !== intent.completionOperationId
      ) throw new Error("invalid frozen lineage");
      governedCallbackEventTarget({
        eventJson: run.eventJson,
        eventDigest: importedRun.eventDigest,
        deliveryTarget: delivery.uri,
        targetIdentityDigest: intent.targetIdentityDigest
      });
      const authority = hostedClaimAuthoritySnapshotFromJson(importedAttempt.authorityJson);
      if (
        !authority || typeof authority !== "object"
        || canonicalSha256Json(authority) !== importedAttempt.authorityDigest
        || authority.organizationId !== intent.organizationId
        || authority.runnerId !== intent.runnerId
        || authority.runId !== intent.runId
        || authority.credentialId !== intent.credentialId
        || authority.registrationGeneration !== intent.registrationGeneration
        || authority.attemptId !== intent.runAttemptId
        || authority.attemptNumber !== intent.runAttemptNumber
        || authority.epoch !== intent.runAttemptNumber
        || authority.fencingTokenDigest !== intent.fencingTokenDigest
      ) throw new Error("invalid frozen authority");
      const assessment = CompletionAssessmentSchema.parse(JSON.parse(assessmentRow.assessmentJson));
      const envelope = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
        JSON.parse(assessmentProjection.envelopeJson)
      );
      const completionRequest = HostedCompleteRequestV1Schema.parse(
        JSON.parse(completion.requestJson)
      );
      const executorResultRef = envelope.payload.executorResultReceiptRef;
      assertProjectionCustodySafe(envelope);
      assertProjectionDigests(envelope);
      if (
        assessment.id !== assessmentRef
        || assessment.workThreadId !== intent.workThreadId
        || assessment.triggeredByRunId !== intent.runId
        || envelope.receiptId !== intent.assessmentReceiptId
        || envelope.receiptDigest !== intent.assessmentReceiptDigest
        || envelope.organizationId !== intent.organizationId
        || envelope.runId !== intent.runId
        || envelope.workThreadId !== intent.workThreadId
        || envelope.attempt.attemptId !== intent.runAttemptId
        || envelope.attempt.attemptNumber !== intent.runAttemptNumber
        || envelope.attempt.epoch !== intent.runAttemptNumber
        || envelope.attempt.fencingTokenDigest !== intent.fencingTokenDigest
        || envelope.producer.id !== intent.producerId
        || envelope.producer.credentialId !== intent.credentialId
        || envelope.producer.registrationGeneration !== intent.registrationGeneration
        || envelope.payload.assessmentId !== assessmentRef
        || !intentEnvelope.predecessorReceiptDigests?.includes(
          intent.assessmentReceiptDigest
        )
        || envelope.payload.workThreadId !== intent.workThreadId
        || envelope.payload.runId !== intent.runId
        || envelope.payload.attempt.attemptId !== intent.runAttemptId
        || envelope.payload.attempt.attemptNumber !== intent.runAttemptNumber
        || envelope.payload.attempt.epoch !== intent.runAttemptNumber
        || envelope.payload.attempt.fencingTokenDigest !== intent.fencingTokenDigest
        || executorResultRef.receiptId !== completion.receiptId
        || executorResultRef.operationId !== completion.operationId
        || executorResultRef.requestId !== completion.requestId
        || executorResultRef.requestDigest !== completion.requestDigest
        || executorResultRef.resultDigest !== completionRequest.resultDigest
        || !envelope.predecessorReceiptDigests?.includes(completion.receiptDigest!)
        || envelope.payload.admissionPolicySnapshot.snapshotId
          !== authority.admissionPolicySnapshotId
        || envelope.payload.admissionPolicySnapshot.digest
          !== authority.admissionPolicySnapshotDigest
        || envelope.payload.contract.contractId !== assessment.contractId
        || envelope.payload.contract.version !== assessment.contractVersion
        || envelope.payload.contract.cycle !== assessment.cycle
        || envelope.payload.assessmentInputDigest !== assessment.inputDigest
        || envelope.payload.conclusion !== assessment.state
        || envelope.payload.assessedAt !== assessment.assessedAt
        || envelope.payload.assessedBy !== (assessment.assessedBy === "opentag"
          ? "local_opentag"
          : "human")
        || (envelope.payload.supersedesAssessmentId ?? null)
          !== (assessment.supersedesAssessmentId ?? null)
      ) throw new Error("invalid completion assessment");
    } catch {
      throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_AUTHORITY_CONFLICT");
    }
    return delivery;
  }

  function updateGovernedDeliveryStateTx(
    tx: ProjectionTransaction,
    input: { deliveryId: number; from: GovernedCallbackState | GovernedCallbackState[]; to: GovernedCallbackState; updatedAt: string }
  ): void {
    const from = Array.isArray(input.from) ? input.from : [input.from];
    const updated = tx.update(callbackDeliveries).set({
      governedState: input.to,
      updatedAt: input.updatedAt
    }).where(and(
      eq(callbackDeliveries.id, input.deliveryId),
      eq(callbackDeliveries.dispatchMode, "governed"),
      inArray(callbackDeliveries.governedState, from)
    )).run();
    if (updated.changes !== 1) throw new Error("governed_callback_delivery_state_update_lost");
  }

  function validateCallbackProjectionEnvelope<T extends ControlPlaneProjectionEnvelope>(
    schema: { parse(value: unknown): T },
    value: unknown
  ): T {
    let envelope: T;
    try {
      envelope = schema.parse(value);
      assertProjectionCustodySafe(envelope);
      assertProjectionDigests(envelope);
    } catch {
      throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_INVALID");
    }
    return envelope;
  }

  function assertProjectionCreatedOrReplayed(result: EnqueueControlPlaneProjectionResult): void {
    if (result.outcome === "conflict") {
      throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_CONFLICT");
    }
  }

  function buildExpiredSendingAttemptObservation(
    intent: typeof governedCallbackIntents.$inferSelect,
    attempt: typeof governedCallbackAttempts.$inferSelect,
    observedAt: string
  ): typeof CallbackAttemptObservationReceiptEnvelopeV1Schema._output {
    if (!attempt.attemptedAt) throw new Error("governed_callback_attempted_at_missing");
    const payload = {
      localIntentId: intent.localIntentId,
      localAttemptId: attempt.localAttemptId,
      attemptNumber: attempt.attemptNumber,
      requestDigest: attempt.requestDigest,
      outcome: "outcome_unknown" as const,
      reasonCode: "provider_receipt_missing" as const,
      nextAction: "reconcile-provider" as const,
      owner: intent.producerId,
      attemptedAt: attempt.attemptedAt,
      observedAt
    };
    const base = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      receiptKind: "callback_attempt_observation" as const,
      receiptId: `receipt_${attempt.localAttemptId}`,
      organizationId: intent.organizationId,
      operationId: `operation_${attempt.localAttemptId}`,
      requiredCapabilities: ["relay.callback-observation.v1"] as const,
      producer: {
        kind: "local_opentag" as const,
        id: intent.producerId,
        credentialId: intent.credentialId,
        registrationGeneration: intent.registrationGeneration
      },
      identity: {
        namespace: "opentag.control.receipt/callback-attempt-observation/v1" as const,
        parts: [
          intent.organizationId,
          intent.workThreadId,
          intent.localIntentId,
          attempt.localAttemptId
        ]
      },
      observedAt,
      runId: intent.runId,
      workThreadId: intent.workThreadId,
      predecessorReceiptDigests: [intent.intentReceiptDigest],
      payload,
      payloadDigest: canonicalSha256Json(payload)
    };
    return validateCallbackProjectionEnvelope(
      CallbackAttemptObservationReceiptEnvelopeV1Schema,
      { ...base, receiptDigest: canonicalSha256Json(base) }
    );
  }

  function buildLocalAttentionAttemptObservation(
    intent: typeof governedCallbackIntents.$inferSelect,
    attempt: typeof governedCallbackAttempts.$inferSelect,
    observedAt: string
  ): typeof CallbackAttemptObservationReceiptEnvelopeV1Schema._output {
    const payload = {
      localIntentId: intent.localIntentId,
      localAttemptId: attempt.localAttemptId,
      attemptNumber: attempt.attemptNumber,
      requestDigest: attempt.requestDigest,
      outcome: "attention" as const,
      reasonCode: "callback_local_error" as const,
      nextAction: "repair-local-callback" as const,
      owner: intent.producerId,
      attemptedAt: attempt.attemptedAt ?? observedAt,
      observedAt
    };
    const base = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      receiptKind: "callback_attempt_observation" as const,
      receiptId: `receipt_${attempt.localAttemptId}`,
      organizationId: intent.organizationId,
      operationId: `operation_${attempt.localAttemptId}`,
      requiredCapabilities: ["relay.callback-observation.v1"] as const,
      producer: {
        kind: "local_opentag" as const,
        id: intent.producerId,
        credentialId: intent.credentialId,
        registrationGeneration: intent.registrationGeneration
      },
      identity: {
        namespace: "opentag.control.receipt/callback-attempt-observation/v1" as const,
        parts: [
          intent.organizationId,
          intent.workThreadId,
          intent.localIntentId,
          attempt.localAttemptId
        ]
      },
      observedAt,
      runId: intent.runId,
      workThreadId: intent.workThreadId,
      predecessorReceiptDigests: [intent.intentReceiptDigest],
      payload,
      payloadDigest: canonicalSha256Json(payload)
    };
    return validateCallbackProjectionEnvelope(
      CallbackAttemptObservationReceiptEnvelopeV1Schema,
      { ...base, receiptDigest: canonicalSha256Json(base) }
    );
  }

  function validProjectionLimit(value: number | undefined): number {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error("projection_limit_invalid");
    return Math.min(100, Math.max(1, Math.trunc(value ?? 50)));
  }

  function validProjectionReason(value: string): string {
    try {
      assertProjectionMutableReference(value);
    } catch {
      throw new ControlPlaneProjectionOutboxValidationError("projection_custody_violation");
    }
    return value;
  }

  function validProjectionHttpStatus(value: number | undefined): number | undefined {
    if (value !== undefined && (!Number.isInteger(value) || value < 100 || value > 599)) {
      throw new Error("projection_http_status_invalid");
    }
    return value;
  }

  function validProjectionTimestamp(value: string): string {
    if (!isProjectionTimestamp(value)) {
      throw new Error("projection_timestamp_invalid");
    }
    return value;
  }

  function acknowledgeHostedLifecycleOperationTx(input: {
    tx: ProjectionTransaction;
    row: typeof hostedLifecycleOperations.$inferSelect;
    receipt: HostedLifecycleReceiptEnvelopeV1;
    acknowledgedAt: string;
    expectedState: "pending" | "leased";
    leaseToken?: string;
  }): boolean {
    const { tx, row, receipt, acknowledgedAt } = input;
    let preImportRejectClaim: typeof hostedClaimOperations.$inferSelect | undefined;
    if (row.action === "reject-start") {
      const importedAttempt = tx.select().from(hostedAttemptImports).where(and(
        eq(hostedAttemptImports.attemptId, row.attemptId),
        eq(hostedAttemptImports.runId, row.runId),
        eq(hostedAttemptImports.attemptNumber, row.attemptNumber),
        eq(hostedAttemptImports.fencingTokenDigest, row.fencingTokenDigest)
      )).limit(1).get();
      if (!importedAttempt) {
        preImportRejectClaim = tx.select().from(hostedClaimOperations).where(and(
          eq(hostedClaimOperations.destinationId, row.destinationId),
          eq(hostedClaimOperations.organizationId, row.organizationId),
          eq(hostedClaimOperations.runnerId, row.runnerId),
          eq(hostedClaimOperations.credentialId, row.credentialId),
          eq(hostedClaimOperations.runId, row.runId),
          eq(hostedClaimOperations.attemptId, row.attemptId),
          eq(hostedClaimOperations.attemptNumber, row.attemptNumber),
          eq(hostedClaimOperations.fencingTokenDigest, row.fencingTokenDigest),
          eq(hostedClaimOperations.state, "claimed"),
          isNotNull(hostedClaimOperations.activeKey),
          isNull(hostedClaimOperations.terminalReasonCode)
        )).limit(1).get();
        if (!preImportRejectClaim) {
          throw new Error("hosted_reject_start_claim_authority_missing");
        }
      }
    }
    if (row.action === "heartbeat") {
      if (receipt.payload.operation !== "heartbeat") return false;
      const request = HostedHeartbeatRequestV1Schema.parse(JSON.parse(row.requestJson));
      const run = tx.select().from(runs).where(eq(runs.id, row.runId)).limit(1).get();
      const attempt = tx.select().from(attempts).where(and(
        eq(attempts.id, row.attemptId),
        eq(attempts.runId, row.runId),
        eq(attempts.fencingToken, request.attempt.fencingToken)
      )).limit(1).get();
      const importedAttempt = tx.select().from(hostedAttemptImports)
        .where(eq(hostedAttemptImports.attemptId, row.attemptId)).limit(1).get();
      const claimOperation = importedAttempt
        ? tx.select().from(hostedClaimOperations).where(and(
            eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId),
            eq(hostedClaimOperations.state, "claimed"),
            isNull(hostedClaimOperations.terminalReasonCode)
          )).limit(1).get()
        : undefined;
      const oldExpiry = Date.parse(request.expectedLeaseExpiresAt);
      const newExpiry = Date.parse(receipt.payload.leaseExpiresAt);
      if (
        !run || !attempt || !claimOperation
        || run.currentAttemptId !== row.attemptId
        || run.assignedRunnerId !== row.runnerId
        || run.leaseExpiresAt !== request.expectedLeaseExpiresAt
        || attempt.runnerId !== row.runnerId
        || attempt.number !== request.attempt.attemptNumber
        || importedAttempt?.attemptNumber !== request.attempt.attemptNumber
        || request.attempt.epoch !== request.attempt.attemptNumber
        || attempt.leaseExpiresAt !== request.expectedLeaseExpiresAt
        || !["assigned", "running"].includes(attempt.status)
        || !Number.isFinite(oldExpiry) || !Number.isFinite(newExpiry)
        || oldExpiry <= Date.parse(acknowledgedAt)
        || newExpiry <= oldExpiry || newExpiry <= Date.parse(acknowledgedAt)
      ) return false;
      const attemptUpdated = tx.update(attempts).set({
        heartbeatAt: acknowledgedAt,
        leaseExpiresAt: receipt.payload.leaseExpiresAt,
        updatedAt: acknowledgedAt
      }).where(and(
        eq(attempts.id, row.attemptId),
        eq(attempts.leaseExpiresAt, request.expectedLeaseExpiresAt)
      )).run();
      const runUpdated = tx.update(runs).set({
        heartbeatAt: acknowledgedAt,
        leaseExpiresAt: receipt.payload.leaseExpiresAt,
        updatedAt: acknowledgedAt
      }).where(and(
        eq(runs.id, row.runId),
        eq(runs.currentAttemptId, row.attemptId),
        eq(runs.leaseExpiresAt, request.expectedLeaseExpiresAt)
      )).run();
      if (attemptUpdated.changes !== 1 || runUpdated.changes !== 1) {
        throw new Error("hosted_heartbeat_lease_update_lost");
      }
    }
    const receiptJson = canonicalJsonStringify(receipt);
    const conditions = [
      eq(hostedLifecycleOperations.destinationId, row.destinationId),
      eq(hostedLifecycleOperations.organizationId, row.organizationId),
      eq(hostedLifecycleOperations.runnerId, row.runnerId),
      eq(hostedLifecycleOperations.credentialId, row.credentialId),
      eq(hostedLifecycleOperations.operationId, row.operationId),
      eq(hostedLifecycleOperations.state, input.expectedState)
    ];
    if (input.expectedState === "leased" && input.leaseToken) {
      conditions.push(eq(hostedLifecycleOperations.leaseToken, input.leaseToken));
      conditions.push(gt(hostedLifecycleOperations.leaseExpiresAt, acknowledgedAt));
    }
    const acknowledged = tx.update(hostedLifecycleOperations).set({
      state: "acknowledged",
      nextAttemptAt: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      receiptId: receipt.receiptId,
      receiptDigest: receipt.receiptDigest,
      receiptJson,
      updatedAt: acknowledgedAt,
      acknowledgedAt
    }).where(and(...conditions)).run().changes === 1;
    if (!acknowledged && row.action === "heartbeat") {
      throw new Error("hosted_heartbeat_journal_update_lost");
    }
    if (acknowledged && preImportRejectClaim?.activeKey) {
      const claimUpdated = tx.update(hostedClaimOperations).set({
        activeKey: null,
        updatedAt: acknowledgedAt
      }).where(and(
        eq(hostedClaimOperations.operationId, preImportRejectClaim.operationId),
        eq(hostedClaimOperations.destinationId, preImportRejectClaim.destinationId),
        eq(hostedClaimOperations.organizationId, preImportRejectClaim.organizationId),
        eq(hostedClaimOperations.runnerId, preImportRejectClaim.runnerId),
        eq(hostedClaimOperations.credentialId, preImportRejectClaim.credentialId!),
        eq(hostedClaimOperations.runId, preImportRejectClaim.runId!),
        eq(hostedClaimOperations.attemptId, preImportRejectClaim.attemptId!),
        eq(hostedClaimOperations.attemptNumber, preImportRejectClaim.attemptNumber!),
        eq(hostedClaimOperations.fencingTokenDigest, preImportRejectClaim.fencingTokenDigest!),
        eq(hostedClaimOperations.activeKey, preImportRejectClaim.activeKey),
        eq(hostedClaimOperations.state, "claimed"),
        isNull(hostedClaimOperations.terminalReasonCode)
      )).run();
      if (claimUpdated.changes !== 1) {
        throw new Error("hosted_reject_start_claim_update_lost");
      }
    }
    if (acknowledged && row.action === "complete") {
      const importedRun = tx.select({ workThreadId: hostedRunImports.workThreadId })
        .from(hostedRunImports)
        .where(eq(hostedRunImports.runId, row.runId))
        .limit(1)
        .get();
      if (importedRun?.workThreadId) {
        const assessmentRows = tx.select().from(completionAssessments).where(
          eq(completionAssessments.workThreadId, importedRun.workThreadId)
        ).orderBy(
          asc(completionAssessments.cycle),
          asc(completionAssessments.sequence),
          asc(completionAssessments.id)
        ).all();
        for (const assessmentRow of assessmentRows) {
          const assessment = CompletionAssessmentSchema.parse(
            JSON.parse(assessmentRow.assessmentJson)
          );
          if (assessment.triggeredByRunId !== row.runId) continue;
          ensureCompletionAssessmentProjectionTx(tx, {
            workThreadId: importedRun.workThreadId,
            runId: row.runId,
            assessmentId: assessment.id
          });
        }
      }
    }
    return acknowledged;
  }

  type CompleteRunInput = {
    runId: string;
    result: OpenTagRunResult;
    humanEscalation?: HumanEscalation;
    runnerId?: string;
    attemptId?: string;
    fencingToken?: string;
    idempotencyKey?: string;
  };
  type HostedCompletionLifecycleOperation = {
    destinationId: string;
    organizationId: string;
    runnerId: string;
    credentialId: string;
    request: HostedCompleteRequestV1;
    requestJson: string;
    businessKeyDigest: string;
  };
  let completeRunWithHostedLifecycle: (
    input: CompleteRunInput,
    lifecycle: HostedCompletionLifecycleOperation,
  ) => Promise<CompleteRunOutcome>;

  return {
    appendRunEvent,

    async enqueueControlPlaneProjection(input: EnqueueControlPlaneProjectionInput): Promise<EnqueueControlPlaneProjectionResult> {
      return db.transaction((tx) => enqueueControlPlaneProjectionTx(tx, input), { behavior: "immediate" });
    },

    async getControlPlaneProjection(input: {
      destinationId: string;
      organizationId: string;
      receiptId: string;
    }): Promise<ControlPlaneProjectionOutboxEntry | null> {
      const destinationId = projectionDestination(input.destinationId);
      const organizationId = projectionOrganization(input.organizationId);
      const row = await db.select().from(controlPlaneProjectionOutbox).where(and(
        eq(controlPlaneProjectionOutbox.destinationId, destinationId),
        eq(controlPlaneProjectionOutbox.organizationId, organizationId),
        eq(controlPlaneProjectionOutbox.receiptId, input.receiptId)
      )).limit(1).get();
      return row ? projectionOutboxEntryFromRow(row) : null;
    },

    async getLatestRunnerReadinessProjection(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
    }): Promise<ControlPlaneProjectionOutboxEntry | null> {
      const destinationId = projectionDestination(input.destinationId);
      const organizationId = projectionOrganization(input.organizationId);
      const runnerId = projectionDestination(input.runnerId);
      const row = await db.select().from(controlPlaneProjectionOutbox).where(and(
        eq(controlPlaneProjectionOutbox.destinationId, destinationId),
        eq(controlPlaneProjectionOutbox.organizationId, organizationId),
        eq(controlPlaneProjectionOutbox.runnerId, runnerId),
        eq(controlPlaneProjectionOutbox.receiptKind, "runner_readiness")
      )).orderBy(
        desc(sql<string>`json_extract(${controlPlaneProjectionOutbox.envelopeJson}, '$.payload.observedAt')`),
        desc(controlPlaneProjectionOutbox.createdAt),
        desc(controlPlaneProjectionOutbox.receiptId)
      ).limit(1).get();
      return row ? projectionOutboxEntryFromRow(row) : null;
    },

    async listControlPlaneProjections(input: {
      destinationId: string;
      organizationId: string;
      state?: ControlPlaneProjectionOutboxState;
      limit?: number;
    }): Promise<ControlPlaneProjectionOutboxEntry[]> {
      const destinationId = projectionDestination(input.destinationId);
      const organizationId = projectionOrganization(input.organizationId);
      const condition = input.state
        ? and(
            eq(controlPlaneProjectionOutbox.destinationId, destinationId),
            eq(controlPlaneProjectionOutbox.organizationId, organizationId),
            eq(controlPlaneProjectionOutbox.state, input.state)
          )
        : and(
            eq(controlPlaneProjectionOutbox.destinationId, destinationId),
            eq(controlPlaneProjectionOutbox.organizationId, organizationId)
          );
      const rows = await db.select().from(controlPlaneProjectionOutbox).where(condition)
        .orderBy(asc(controlPlaneProjectionOutbox.createdAt), asc(controlPlaneProjectionOutbox.receiptId))
        .limit(validProjectionLimit(input.limit));
      return rows.map(projectionOutboxEntryFromRow);
    },

    async claimDueControlPlaneProjections(input: {
      destinationId: string;
      organizationId: string;
      leaseOwner: string;
      leaseSeconds: number;
      limit?: number;
      now?: Date;
    }): Promise<ClaimControlPlaneProjectionsResult> {
      const destinationId = projectionDestination(input.destinationId);
      const organizationId = projectionOrganization(input.organizationId);
      const leaseOwner = projectionDestination(input.leaseOwner);
      if (!Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) throw new Error("projection_lease_seconds_invalid");
      const limit = validProjectionLimit(input.limit);
      const now = input.now ?? new Date();
      const at = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
      return db.transaction((tx) => {
        const claimed: ControlPlaneProjectionOutboxEntry[] = [];
        const rejected: ClaimControlPlaneProjectionsResult["rejected"] = [];
        let cursor: {
          nextAttemptAt: string;
          createdAt: string;
          receiptId: string;
        } | undefined;
        while (claimed.length < limit) {
          const cursorCondition = cursor
            ? or(
                gt(controlPlaneProjectionOutbox.nextAttemptAt, cursor.nextAttemptAt),
                and(
                  eq(controlPlaneProjectionOutbox.nextAttemptAt, cursor.nextAttemptAt),
                  gt(controlPlaneProjectionOutbox.createdAt, cursor.createdAt)
                ),
                and(
                  eq(controlPlaneProjectionOutbox.nextAttemptAt, cursor.nextAttemptAt),
                  eq(controlPlaneProjectionOutbox.createdAt, cursor.createdAt),
                  gt(controlPlaneProjectionOutbox.receiptId, cursor.receiptId)
                )
              )
            : undefined;
          const due = tx.select().from(controlPlaneProjectionOutbox).where(and(
            eq(controlPlaneProjectionOutbox.destinationId, destinationId),
            eq(controlPlaneProjectionOutbox.organizationId, organizationId),
            eq(controlPlaneProjectionOutbox.state, "pending"),
            lte(controlPlaneProjectionOutbox.nextAttemptAt, at),
            cursorCondition
          )).orderBy(
            asc(controlPlaneProjectionOutbox.nextAttemptAt),
            asc(controlPlaneProjectionOutbox.createdAt),
            asc(controlPlaneProjectionOutbox.receiptId)
          ).limit(100).all();
          if (due.length === 0) break;
          for (const row of due) {
            cursor = {
              nextAttemptAt: row.nextAttemptAt!,
              createdAt: row.createdAt,
              receiptId: row.receiptId
            };
            if (claimed.length >= limit) break;
            let currentEntry: ControlPlaneProjectionOutboxEntry;
            try {
              currentEntry = projectionOutboxEntryFromRow(row);
            } catch {
              if (rejected.length < 100) {
                const safeReceiptId = PROJECTION_SAFE_REFERENCE.test(row.receiptId)
                  && !containsCredentialLikeData(row.receiptId)
                  && !/(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(row.receiptId);
                rejected.push({
                  ...(safeReceiptId ? { receiptId: row.receiptId } : {}),
                  rowIdentityDigest: canonicalSha256Json({
                    destinationId: row.destinationId,
                    organizationId: row.organizationId,
                    receiptId: row.receiptId
                  }),
                  reasonCode: "stored_row_invalid"
                });
              }
              continue;
            }
            let dependencyReason:
              | "dependency_missing"
              | "dependency_cross_destination"
              | "dependency_invalid"
              | undefined;
            let dependencyPending = false;
            if (row.dependsOnReceiptId) {
              const parent = tx.select().from(controlPlaneProjectionOutbox).where(and(
                eq(controlPlaneProjectionOutbox.destinationId, destinationId),
                eq(controlPlaneProjectionOutbox.organizationId, organizationId),
                eq(controlPlaneProjectionOutbox.receiptId, row.dependsOnReceiptId)
              )).limit(1).get();
              if (!parent) {
                const elsewhere = tx.select({ receiptId: controlPlaneProjectionOutbox.receiptId })
                  .from(controlPlaneProjectionOutbox)
                  .where(eq(controlPlaneProjectionOutbox.receiptId, row.dependsOnReceiptId))
                  .limit(1).get();
                dependencyReason = elsewhere ? "dependency_cross_destination" : "dependency_missing";
              } else if (parent.state !== "acknowledged") {
                dependencyPending = true;
              } else {
                try {
                  projectionOutboxEntryFromRow(parent);
                } catch {
                  dependencyReason = "dependency_invalid";
                }
              }
            }
            if (!dependencyReason && !dependencyPending && row.requiresLifecycleOperationId) {
              const lifecycle = tx.select().from(hostedLifecycleOperations).where(and(
                eq(hostedLifecycleOperations.destinationId, destinationId),
                eq(hostedLifecycleOperations.organizationId, organizationId),
                eq(hostedLifecycleOperations.operationId, row.requiresLifecycleOperationId)
              )).limit(1).get();
              if (!lifecycle) {
                const elsewhere = tx.select({ operationId: hostedLifecycleOperations.operationId })
                  .from(hostedLifecycleOperations)
                  .where(eq(hostedLifecycleOperations.operationId, row.requiresLifecycleOperationId))
                  .limit(1).get();
                dependencyReason = elsewhere ? "dependency_cross_destination" : "dependency_missing";
              } else if (lifecycle.state !== "acknowledged") {
                dependencyPending = true;
              } else if (!validAcknowledgedLifecycleDependency(lifecycle)) {
                dependencyReason = "dependency_invalid";
              } else if (currentEntry.receiptKind === "completion_assessment") {
                const reference = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
                  currentEntry.envelope,
                ).payload.executorResultReceiptRef;
                if (lifecycle.action !== "complete") {
                  dependencyReason = "dependency_invalid";
                } else {
                  const request = HostedCompleteRequestV1Schema.parse(
                    JSON.parse(lifecycle.requestJson),
                  );
                  if (
                    reference.receiptId !== lifecycle.receiptId
                  || reference.operationId !== lifecycle.operationId
                  || reference.requestId !== lifecycle.requestId
                  || reference.requestDigest !== lifecycle.requestDigest
                  || reference.resultDigest !== request.resultDigest
                  ) {
                    dependencyReason = "dependency_invalid";
                  }
                }
              }
            }
            if (dependencyPending) continue;
            const leaseToken = randomUUID();
            const updated = tx.update(controlPlaneProjectionOutbox).set({
              state: "leased",
              leaseOwner,
              leaseToken,
              leaseExpiresAt,
              attemptCount: row.attemptCount + 1,
              updatedAt: at
            }).where(and(
              eq(controlPlaneProjectionOutbox.receiptId, row.receiptId),
              eq(controlPlaneProjectionOutbox.destinationId, destinationId),
              eq(controlPlaneProjectionOutbox.organizationId, organizationId),
              eq(controlPlaneProjectionOutbox.state, "pending"),
              lte(controlPlaneProjectionOutbox.nextAttemptAt, at)
            )).run();
            if (updated.changes !== 1) continue;
            if (dependencyReason) {
              tx.update(controlPlaneProjectionOutbox).set({
                state: "attention",
                nextAttemptAt: null,
                leaseOwner: null,
                leaseToken: null,
                leaseExpiresAt: null,
                lastReasonCode: dependencyReason,
                updatedAt: at
              }).where(and(
                eq(controlPlaneProjectionOutbox.receiptId, row.receiptId),
                eq(controlPlaneProjectionOutbox.destinationId, destinationId),
                eq(controlPlaneProjectionOutbox.organizationId, organizationId),
                eq(controlPlaneProjectionOutbox.state, "leased"),
                eq(controlPlaneProjectionOutbox.leaseToken, leaseToken)
              )).run();
              rejected.push({
                receiptId: row.receiptId,
                rowIdentityDigest: canonicalSha256Json({
                  destinationId,
                  organizationId,
                  receiptId: row.receiptId
                }),
                reasonCode: dependencyReason
              });
              continue;
            }
            claimed.push(projectionOutboxEntryFromRow({
              ...row,
              state: "leased",
              leaseOwner,
              leaseToken,
              leaseExpiresAt,
              attemptCount: row.attemptCount + 1,
              updatedAt: at
            }));
          }
          if (due.length < 100) break;
        }
        return { entries: claimed, rejected };
      }, { behavior: "immediate" });
    },

    async acknowledgeControlPlaneProjection(input: {
      destinationId: string;
      organizationId: string;
      receiptId: string;
      leaseToken: string;
      httpStatus?: number;
      now?: Date;
    }): Promise<{ outcome: "acknowledged" | "stale_lease" | "not_found"; entry?: ControlPlaneProjectionOutboxEntry }> {
      const destinationId = projectionDestination(input.destinationId);
      const organizationId = projectionOrganization(input.organizationId);
      const at = (input.now ?? new Date()).toISOString();
      const httpStatus = validProjectionHttpStatus(input.httpStatus);
      return db.transaction((tx) => {
        const row = tx.select().from(controlPlaneProjectionOutbox).where(and(
          eq(controlPlaneProjectionOutbox.destinationId, destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, organizationId),
          eq(controlPlaneProjectionOutbox.receiptId, input.receiptId)
        )).limit(1).get();
        if (!row) return { outcome: "not_found" as const };
        projectionOutboxEntryFromRow(row);
        if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
          return { outcome: "stale_lease" as const };
        }
        const updated = tx.update(controlPlaneProjectionOutbox).set({
          state: "acknowledged",
          nextAttemptAt: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastHttpStatus: httpStatus ?? null,
          updatedAt: at,
          acknowledgedAt: at
        }).where(and(
          eq(controlPlaneProjectionOutbox.receiptId, input.receiptId),
          eq(controlPlaneProjectionOutbox.destinationId, destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, organizationId),
          eq(controlPlaneProjectionOutbox.state, "leased"),
          eq(controlPlaneProjectionOutbox.leaseToken, input.leaseToken),
          gt(controlPlaneProjectionOutbox.leaseExpiresAt, at)
        )).run();
        if (updated.changes !== 1) return { outcome: "stale_lease" as const };
        const acknowledged = tx.select().from(controlPlaneProjectionOutbox).where(and(
          eq(controlPlaneProjectionOutbox.destinationId, destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, organizationId),
          eq(controlPlaneProjectionOutbox.receiptId, input.receiptId)
        )).limit(1).get();
        return { outcome: "acknowledged" as const, entry: projectionOutboxEntryFromRow(acknowledged!) };
      }, { behavior: "immediate" });
    },

    async retryControlPlaneProjection(input: {
      destinationId: string;
      organizationId: string;
      receiptId: string;
      leaseToken: string;
      nextAttemptAt: string;
      reasonCode: string;
      httpStatus?: number;
      now?: Date;
    }): Promise<{ outcome: "retried" | "stale_lease" | "not_found"; entry?: ControlPlaneProjectionOutboxEntry }> {
      const destinationId = projectionDestination(input.destinationId);
      const organizationId = projectionOrganization(input.organizationId);
      const at = (input.now ?? new Date()).toISOString();
      const nextAttemptAt = validProjectionTimestamp(input.nextAttemptAt);
      if (nextAttemptAt < at) throw new Error("projection_retry_time_in_past");
      const reasonCode = validProjectionReason(input.reasonCode);
      const httpStatus = validProjectionHttpStatus(input.httpStatus);
      return db.transaction((tx) => {
        const row = tx.select().from(controlPlaneProjectionOutbox).where(and(
          eq(controlPlaneProjectionOutbox.destinationId, destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, organizationId),
          eq(controlPlaneProjectionOutbox.receiptId, input.receiptId)
        )).limit(1).get();
        if (!row) return { outcome: "not_found" as const };
        projectionOutboxEntryFromRow(row);
        if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
          return { outcome: "stale_lease" as const };
        }
        const updated = tx.update(controlPlaneProjectionOutbox).set({
          state: "pending",
          nextAttemptAt,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastReasonCode: reasonCode,
          lastHttpStatus: httpStatus ?? null,
          updatedAt: at
        }).where(and(
          eq(controlPlaneProjectionOutbox.receiptId, input.receiptId),
          eq(controlPlaneProjectionOutbox.destinationId, destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, organizationId),
          eq(controlPlaneProjectionOutbox.state, "leased"),
          eq(controlPlaneProjectionOutbox.leaseToken, input.leaseToken),
          gt(controlPlaneProjectionOutbox.leaseExpiresAt, at)
        )).run();
        if (updated.changes !== 1) return { outcome: "stale_lease" as const };
        const retried = tx.select().from(controlPlaneProjectionOutbox).where(and(
          eq(controlPlaneProjectionOutbox.destinationId, destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, organizationId),
          eq(controlPlaneProjectionOutbox.receiptId, input.receiptId)
        )).limit(1).get();
        return { outcome: "retried" as const, entry: projectionOutboxEntryFromRow(retried!) };
      }, { behavior: "immediate" });
    },

    async markControlPlaneProjectionAttention(input: {
      destinationId: string;
      organizationId: string;
      receiptId: string;
      leaseToken: string;
      reasonCode: string;
      httpStatus?: number;
      now?: Date;
    }): Promise<{ outcome: "attention" | "stale_lease" | "not_found"; entry?: ControlPlaneProjectionOutboxEntry }> {
      const destinationId = projectionDestination(input.destinationId);
      const organizationId = projectionOrganization(input.organizationId);
      const at = (input.now ?? new Date()).toISOString();
      const reasonCode = validProjectionReason(input.reasonCode);
      const httpStatus = validProjectionHttpStatus(input.httpStatus);
      return db.transaction((tx) => {
        const row = tx.select().from(controlPlaneProjectionOutbox).where(and(
          eq(controlPlaneProjectionOutbox.destinationId, destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, organizationId),
          eq(controlPlaneProjectionOutbox.receiptId, input.receiptId)
        )).limit(1).get();
        if (!row) return { outcome: "not_found" as const };
        projectionOutboxEntryFromRow(row);
        if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
          return { outcome: "stale_lease" as const };
        }
        const updated = tx.update(controlPlaneProjectionOutbox).set({
          state: "attention",
          nextAttemptAt: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastReasonCode: reasonCode,
          lastHttpStatus: httpStatus ?? null,
          updatedAt: at
        }).where(and(
          eq(controlPlaneProjectionOutbox.receiptId, input.receiptId),
          eq(controlPlaneProjectionOutbox.destinationId, destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, organizationId),
          eq(controlPlaneProjectionOutbox.state, "leased"),
          eq(controlPlaneProjectionOutbox.leaseToken, input.leaseToken),
          gt(controlPlaneProjectionOutbox.leaseExpiresAt, at)
        )).run();
        if (updated.changes !== 1) return { outcome: "stale_lease" as const };
        const attention = tx.select().from(controlPlaneProjectionOutbox).where(and(
          eq(controlPlaneProjectionOutbox.destinationId, destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, organizationId),
          eq(controlPlaneProjectionOutbox.receiptId, input.receiptId)
        )).limit(1).get();
        return { outcome: "attention" as const, entry: projectionOutboxEntryFromRow(attention!) };
      }, { behavior: "immediate" });
    },

    async recoverExpiredControlPlaneProjectionLeases(input: {
      destinationId: string;
      organizationId: string;
      limit?: number;
      now?: Date;
    }): Promise<{ recovered: number; entries: ControlPlaneProjectionOutboxEntry[] }> {
      const destinationId = projectionDestination(input.destinationId);
      const organizationId = projectionOrganization(input.organizationId);
      const limit = validProjectionLimit(input.limit);
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        const entries: ControlPlaneProjectionOutboxEntry[] = [];
        let cursor: {
          leaseExpiresAt: string;
          createdAt: string;
          receiptId: string;
        } | undefined;
        while (entries.length < limit) {
          const cursorCondition = cursor
            ? or(
                gt(controlPlaneProjectionOutbox.leaseExpiresAt, cursor.leaseExpiresAt),
                and(
                  eq(controlPlaneProjectionOutbox.leaseExpiresAt, cursor.leaseExpiresAt),
                  gt(controlPlaneProjectionOutbox.createdAt, cursor.createdAt)
                ),
                and(
                  eq(controlPlaneProjectionOutbox.leaseExpiresAt, cursor.leaseExpiresAt),
                  eq(controlPlaneProjectionOutbox.createdAt, cursor.createdAt),
                  gt(controlPlaneProjectionOutbox.receiptId, cursor.receiptId)
                )
              )
            : undefined;
          const expired = tx.select().from(controlPlaneProjectionOutbox).where(and(
            eq(controlPlaneProjectionOutbox.destinationId, destinationId),
            eq(controlPlaneProjectionOutbox.organizationId, organizationId),
            eq(controlPlaneProjectionOutbox.state, "leased"),
            lte(controlPlaneProjectionOutbox.leaseExpiresAt, at),
            cursorCondition
          )).orderBy(
            asc(controlPlaneProjectionOutbox.leaseExpiresAt),
            asc(controlPlaneProjectionOutbox.createdAt),
            asc(controlPlaneProjectionOutbox.receiptId)
          ).limit(100).all();
          if (expired.length === 0) break;
          for (const row of expired) {
            cursor = {
              leaseExpiresAt: row.leaseExpiresAt!,
              createdAt: row.createdAt,
              receiptId: row.receiptId
            };
            if (entries.length >= limit) break;
            try {
              projectionOutboxEntryFromRow(row);
            } catch {
              continue;
            }
            const updated = tx.update(controlPlaneProjectionOutbox).set({
              state: "pending",
              nextAttemptAt: at,
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              lastReasonCode: "lease_expired",
              updatedAt: at
            }).where(and(
              eq(controlPlaneProjectionOutbox.receiptId, row.receiptId),
              eq(controlPlaneProjectionOutbox.destinationId, destinationId),
              eq(controlPlaneProjectionOutbox.organizationId, organizationId),
              eq(controlPlaneProjectionOutbox.state, "leased"),
              lte(controlPlaneProjectionOutbox.leaseExpiresAt, at)
            )).run();
            if (updated.changes !== 1) continue;
            entries.push(projectionOutboxEntryFromRow({
              ...row,
              state: "pending",
              nextAttemptAt: at,
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              lastReasonCode: "lease_expired",
              updatedAt: at
            }));
          }
          if (expired.length < 100) break;
        }
        return { recovered: entries.length, entries };
      }, { behavior: "immediate" });
    },

    async getFactoryRecipeSnapshot(input: { id: string; version: number }): Promise<StoredFactoryRecipeSnapshot | null> {
      const row = await db.select().from(factoryRecipeSnapshots)
        .where(and(eq(factoryRecipeSnapshots.id, input.id), eq(factoryRecipeSnapshots.version, input.version))).limit(1).get();
      return row ? factoryRecipeSnapshotFromRow(row) : null;
    },

    async createFactoryRecipeSnapshot(input: {
      id: string;
      version: number;
      recipe: FactoryRecipeSnapshotInput;
      contentDigest?: string;
      createdAt?: string;
    }): Promise<{ outcome: "created" | "existing"; recipeSnapshot: StoredFactoryRecipeSnapshot } | { outcome: "conflict"; recipeSnapshot: StoredFactoryRecipeSnapshot }> {
      const recipe = FactoryRecipeSnapshotInputSchema.parse(input.recipe);
      if (recipe.id !== input.id || recipe.version !== input.version) throw new Error("FACTORY_RECIPE_IDENTITY_MISMATCH");
      const recipeJson = JSON.stringify(recipe);
      const contentDigest = sha256Json(recipe);
      if (input.contentDigest && input.contentDigest !== contentDigest) throw new Error("FACTORY_RECIPE_CONTENT_DIGEST_MISMATCH");
      const createdAt = input.createdAt ?? nowIso();
      return db.transaction((tx) => {
        const existing = tx.select().from(factoryRecipeSnapshots)
          .where(and(eq(factoryRecipeSnapshots.id, input.id), eq(factoryRecipeSnapshots.version, input.version))).limit(1).get();
        if (existing) {
          return { outcome: existing.contentDigest === contentDigest ? "existing" as const : "conflict" as const, recipeSnapshot: factoryRecipeSnapshotFromRow(existing) };
        }
        tx.insert(factoryRecipeSnapshots).values({ id: input.id, version: input.version, recipeJson, contentDigest, createdAt }).run();
        return { outcome: "created" as const, recipeSnapshot: { id: input.id, version: input.version, recipe, contentDigest, createdAt } };
      });
    },

    async getFactoryWorkstream(input: { id: string }): Promise<StoredFactoryWorkstream | null> {
      const row = await db.select().from(factoryWorkstreams).where(eq(factoryWorkstreams.id, input.id)).limit(1).get();
      if (!row) return null;
      const members = await db.select({ workThreadId: factoryWorkstreamMembers.workThreadId }).from(factoryWorkstreamMembers)
        .where(eq(factoryWorkstreamMembers.workstreamId, input.id)).orderBy(asc(factoryWorkstreamMembers.workThreadId));
      return factoryWorkstreamFromRows(row, members);
    },

    async listFactoryWorkstreamsForWorkThread(input: {
      workThreadId: string;
      limit?: number;
    }): Promise<StoredFactoryWorkstream[]> {
      const limit = Math.min(101, Math.max(1, Math.trunc(input.limit ?? 101)));
      const rows = await db.select({ workstream: factoryWorkstreams })
        .from(factoryWorkstreamMembers)
        .innerJoin(factoryWorkstreams, eq(factoryWorkstreams.id, factoryWorkstreamMembers.workstreamId))
        .where(eq(factoryWorkstreamMembers.workThreadId, input.workThreadId))
        .orderBy(asc(factoryWorkstreams.id))
        .limit(limit);
      const stored: StoredFactoryWorkstream[] = [];
      for (const { workstream } of rows) {
        const members = await db.select({ workThreadId: factoryWorkstreamMembers.workThreadId })
          .from(factoryWorkstreamMembers)
          .where(eq(factoryWorkstreamMembers.workstreamId, workstream.id))
          .orderBy(asc(factoryWorkstreamMembers.workThreadId));
        stored.push(factoryWorkstreamFromRows(workstream, members));
      }
      return stored;
    },

    async createFactoryWorkstream(input: {
      id: string;
      recipeId: string;
      recipeVersion: number;
      workstream: Partial<WorkstreamInput> & { name: string };
      workThreadIds: string[];
      contentDigest?: string;
      createdAt?: string;
    }): Promise<{ outcome: "created" | "existing"; workstream: StoredFactoryWorkstream } | { outcome: "conflict" | "recipe_not_found" | "work_thread_not_found"; workstream?: StoredFactoryWorkstream; workThreadId?: string }> {
      const normalizedWorkThreadIds = [...new Set(input.workThreadIds)].sort();
      if (normalizedWorkThreadIds.length === 0) return { outcome: "work_thread_not_found" as const };
      const candidateWorkstream = input.workstream as Record<string, unknown>;
      const workstream = WorkstreamInputSchema.parse({
        ...candidateWorkstream,
        id: input.id,
        recipeId: input.recipeId,
        recipeVersion: input.recipeVersion,
        members: normalizedWorkThreadIds.map((workThreadId) => ({ kind: "work_thread", workThreadId }))
      });
      const workstreamJson = JSON.stringify(workstream);
      const contentDigest = sha256Json(workstream);
      if (input.contentDigest && input.contentDigest !== contentDigest) throw new Error("FACTORY_WORKSTREAM_CONTENT_DIGEST_MISMATCH");
      const createdAt = input.createdAt ?? nowIso();
      return db.transaction((tx) => {
        const existing = tx.select().from(factoryWorkstreams).where(eq(factoryWorkstreams.id, input.id)).limit(1).get();
        if (existing) {
          const members = tx.select({ workThreadId: factoryWorkstreamMembers.workThreadId }).from(factoryWorkstreamMembers)
            .where(eq(factoryWorkstreamMembers.workstreamId, input.id)).orderBy(asc(factoryWorkstreamMembers.workThreadId)).all();
          const stored = factoryWorkstreamFromRows(existing, members);
          return { outcome: existing.contentDigest === contentDigest ? "existing" as const : "conflict" as const, workstream: stored };
        }
        const recipe = tx.select({ id: factoryRecipeSnapshots.id }).from(factoryRecipeSnapshots)
          .where(and(eq(factoryRecipeSnapshots.id, input.recipeId), eq(factoryRecipeSnapshots.version, input.recipeVersion))).limit(1).get();
        if (!recipe) return { outcome: "recipe_not_found" as const };
        for (const workThreadId of normalizedWorkThreadIds) {
          const thread = tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, workThreadId)).limit(1).get();
          if (!thread) return { outcome: "work_thread_not_found" as const, workThreadId };
        }
        tx.insert(factoryWorkstreams).values({ id: input.id, recipeId: input.recipeId, recipeVersion: input.recipeVersion, workstreamJson, contentDigest, createdAt }).run();
        if (normalizedWorkThreadIds.length > 0) tx.insert(factoryWorkstreamMembers).values(normalizedWorkThreadIds.map((workThreadId) => ({ workstreamId: input.id, workThreadId, createdAt }))).run();
        return { outcome: "created" as const, workstream: { id: input.id, recipeId: input.recipeId, recipeVersion: input.recipeVersion, workstream, contentDigest, workThreadIds: normalizedWorkThreadIds, createdAt } };
      });
    },

    async getWorkstreamAdmissionBatch(input: { id: string }): Promise<WorkstreamAdmissionBatch | null> {
      const row = await db.select().from(workstreamAdmissionBatches).where(eq(workstreamAdmissionBatches.id, input.id)).limit(1).get();
      if (!row) return null;
      const items = await db.select().from(workstreamAdmissionBatchItems).where(eq(workstreamAdmissionBatchItems.batchId, input.id)).orderBy(asc(workstreamAdmissionBatchItems.ordinal));
      return admissionBatchFromRows(row, items);
    },

    async beginWorkstreamAdmissionBatch(input: {
      id: string;
      workstreamId: string;
      requestDigest: string;
      request: unknown;
      items: Array<{ itemId: string; runId: string; workThreadId: string; event: OpenTagEvent }>;
      leaseOwner: string;
      leaseSeconds: number;
      now?: Date;
    }): Promise<{ outcome: "acquired" | "in_progress" | "replay" | "conflict" | "workstream_not_found" | "invalid_member"; batch?: WorkstreamAdmissionBatch; workThreadId?: string }> {
      const now = input.now ?? new Date();
      const at = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
      const request = WorkstreamAdmissionBatchInputSchema.parse(input.request);
      if (request.id !== input.id || request.workstreamId !== input.workstreamId) throw new Error("FACTORY_BATCH_REQUEST_IDENTITY_MISMATCH");
      const suppliedItems = input.items.map((item) => ({ ...item, event: OpenTagEventSchema.parse(item.event) }));
      if (canonicalSha256Json(request.items) !== canonicalSha256Json(suppliedItems)) throw new Error("FACTORY_BATCH_REQUEST_ITEMS_MISMATCH");
      const requestDigest = canonicalSha256Json(request);
      if (requestDigest !== input.requestDigest) throw new Error("FACTORY_BATCH_REQUEST_DIGEST_MISMATCH");
      return db.transaction((tx) => {
        const existing = tx.select().from(workstreamAdmissionBatches).where(eq(workstreamAdmissionBatches.id, input.id)).limit(1).get();
        if (existing) {
          const items = tx.select().from(workstreamAdmissionBatchItems).where(eq(workstreamAdmissionBatchItems.batchId, input.id)).orderBy(asc(workstreamAdmissionBatchItems.ordinal)).all();
          const batch = admissionBatchFromRows(existing, items);
          if (existing.requestDigest !== requestDigest) return { outcome: "conflict" as const, batch };
          if (existing.status === "completed") return { outcome: "replay" as const, batch };
          if (existing.leaseOwner !== input.leaseOwner && existing.leaseExpiresAt && existing.leaseExpiresAt > at) return { outcome: "in_progress" as const, batch };
          tx.update(workstreamAdmissionBatches).set({ leaseOwner: input.leaseOwner, leaseExpiresAt, updatedAt: at }).where(eq(workstreamAdmissionBatches.id, input.id)).run();
          return { outcome: "acquired" as const, batch: admissionBatchFromRows({ ...existing, leaseOwner: input.leaseOwner, leaseExpiresAt, updatedAt: at }, items) };
        }
        const workstream = tx.select({ id: factoryWorkstreams.id }).from(factoryWorkstreams).where(eq(factoryWorkstreams.id, input.workstreamId)).limit(1).get();
        if (!workstream) return { outcome: "workstream_not_found" as const };
        const itemIds = new Set<string>();
        const runIds = new Set<string>();
        for (const item of input.items) {
          if (itemIds.has(item.itemId) || runIds.has(item.runId)) return { outcome: "conflict" as const };
          itemIds.add(item.itemId); runIds.add(item.runId);
          const member = tx.select({ workThreadId: factoryWorkstreamMembers.workThreadId }).from(factoryWorkstreamMembers)
            .where(and(eq(factoryWorkstreamMembers.workstreamId, input.workstreamId), eq(factoryWorkstreamMembers.workThreadId, item.workThreadId))).limit(1).get();
          if (!member) return { outcome: "invalid_member" as const, workThreadId: item.workThreadId };
        }
        tx.insert(workstreamAdmissionBatches).values({ id: input.id, workstreamId: input.workstreamId, requestDigest, requestJson: JSON.stringify(request), status: "processing", leaseOwner: input.leaseOwner, leaseExpiresAt, createdAt: at, updatedAt: at }).run();
        if (input.items.length > 0) tx.insert(workstreamAdmissionBatchItems).values(input.items.map((item, ordinal) => ({ batchId: input.id, itemId: item.itemId, ordinal, runId: item.runId, workThreadId: item.workThreadId, eventJson: JSON.stringify(OpenTagEventSchema.parse(item.event)), status: "pending", createdAt: at, updatedAt: at }))).run();
        const row = tx.select().from(workstreamAdmissionBatches).where(eq(workstreamAdmissionBatches.id, input.id)).get()!;
        const items = tx.select().from(workstreamAdmissionBatchItems).where(eq(workstreamAdmissionBatchItems.batchId, input.id)).orderBy(asc(workstreamAdmissionBatchItems.ordinal)).all();
        return { outcome: "acquired" as const, batch: admissionBatchFromRows(row, items) };
      });
    },

    async claimWorkstreamAdmissionBatchItem(input: { batchId: string; itemId: string; leaseOwner: string; leaseSeconds: number; now?: Date }): Promise<{ outcome: "claimed" | "in_progress" | "completed" | "not_found" | "batch_lease_lost"; item?: WorkstreamAdmissionBatchItem }> {
      const now = input.now ?? new Date();
      const at = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
      return db.transaction((tx) => {
        const batch = tx.select().from(workstreamAdmissionBatches).where(eq(workstreamAdmissionBatches.id, input.batchId)).limit(1).get();
        if (!batch) return { outcome: "not_found" as const };
        if (batch.status === "completed") return { outcome: "completed" as const };
        if (batch.leaseOwner !== input.leaseOwner || (batch.leaseExpiresAt !== null && batch.leaseExpiresAt <= at)) return { outcome: "batch_lease_lost" as const };
        const item = tx.select().from(workstreamAdmissionBatchItems).where(and(eq(workstreamAdmissionBatchItems.batchId, input.batchId), eq(workstreamAdmissionBatchItems.itemId, input.itemId))).limit(1).get();
        if (!item) return { outcome: "not_found" as const };
        tx.update(workstreamAdmissionBatches).set({ leaseExpiresAt, updatedAt: at })
          .where(eq(workstreamAdmissionBatches.id, input.batchId)).run();
        if (item.status === "completed") return { outcome: "completed" as const, item: admissionBatchItemFromRow(item) };
        if (item.status === "processing" && item.leaseOwner !== input.leaseOwner && item.leaseExpiresAt && item.leaseExpiresAt > at) return { outcome: "in_progress" as const, item: admissionBatchItemFromRow(item) };
        tx.update(workstreamAdmissionBatchItems).set({ status: "processing", leaseOwner: input.leaseOwner, leaseExpiresAt, updatedAt: at })
          .where(and(eq(workstreamAdmissionBatchItems.batchId, input.batchId), eq(workstreamAdmissionBatchItems.itemId, input.itemId))).run();
        return { outcome: "claimed" as const, item: admissionBatchItemFromRow({ ...item, status: "processing", leaseOwner: input.leaseOwner, leaseExpiresAt, updatedAt: at }) };
      });
    },

    async renewWorkstreamAdmissionBatchLease(input: {
      batchId: string;
      itemId?: string;
      leaseOwner: string;
      leaseSeconds: number;
      now?: Date;
    }): Promise<{ outcome: "renewed" | "completed" | "stale_lease" | "not_found" }> {
      const now = input.now ?? new Date();
      const at = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
      return db.transaction((tx) => {
        const batch = tx.select().from(workstreamAdmissionBatches)
          .where(eq(workstreamAdmissionBatches.id, input.batchId)).limit(1).get();
        if (!batch) return { outcome: "not_found" as const };
        if (batch.status === "completed") return { outcome: "completed" as const };
        if (
          batch.leaseOwner !== input.leaseOwner
          || batch.leaseExpiresAt === null
          || batch.leaseExpiresAt <= at
        ) {
          return { outcome: "stale_lease" as const };
        }
        if (input.itemId) {
          const item = tx.select().from(workstreamAdmissionBatchItems).where(and(
            eq(workstreamAdmissionBatchItems.batchId, input.batchId),
            eq(workstreamAdmissionBatchItems.itemId, input.itemId)
          )).limit(1).get();
          if (!item) return { outcome: "not_found" as const };
          if (
            item.status !== "processing"
            || item.leaseOwner !== input.leaseOwner
            || item.leaseExpiresAt === null
            || item.leaseExpiresAt <= at
          ) {
            return { outcome: item.status === "completed" ? "completed" as const : "stale_lease" as const };
          }
          tx.update(workstreamAdmissionBatchItems).set({ leaseExpiresAt, updatedAt: at }).where(and(
            eq(workstreamAdmissionBatchItems.batchId, input.batchId),
            eq(workstreamAdmissionBatchItems.itemId, input.itemId)
          )).run();
        }
        tx.update(workstreamAdmissionBatches).set({ leaseExpiresAt, updatedAt: at })
          .where(eq(workstreamAdmissionBatches.id, input.batchId)).run();
        return { outcome: "renewed" as const };
      });
    },

    async completeWorkstreamAdmissionBatchItem(input: { batchId: string; itemId: string; leaseOwner: string; result: unknown; now?: Date }): Promise<{ outcome: "completed" | "duplicate" | "stale_lease" | "not_found"; item?: WorkstreamAdmissionBatchItem }> {
      const at = (input.now ?? new Date()).toISOString();
      const resultJson = JSON.stringify(input.result);
      return db.transaction((tx) => {
        const batch = tx.select().from(workstreamAdmissionBatches).where(eq(workstreamAdmissionBatches.id, input.batchId)).limit(1).get();
        if (!batch) return { outcome: "not_found" as const };
        if (batch.status !== "processing" || batch.leaseOwner !== input.leaseOwner || (batch.leaseExpiresAt !== null && batch.leaseExpiresAt <= at)) {
          return { outcome: "stale_lease" as const };
        }
        const item = tx.select().from(workstreamAdmissionBatchItems).where(and(eq(workstreamAdmissionBatchItems.batchId, input.batchId), eq(workstreamAdmissionBatchItems.itemId, input.itemId))).limit(1).get();
        if (!item) return { outcome: "not_found" as const };
        if (item.status === "completed") return { outcome: item.resultJson === resultJson ? "duplicate" as const : "stale_lease" as const, item: admissionBatchItemFromRow(item) };
        if (item.status !== "processing" || item.leaseOwner !== input.leaseOwner || (item.leaseExpiresAt !== null && item.leaseExpiresAt <= at)) return { outcome: "stale_lease" as const, item: admissionBatchItemFromRow(item) };
        tx.update(workstreamAdmissionBatchItems).set({ status: "completed", resultJson, leaseOwner: null, leaseExpiresAt: null, completedAt: at, updatedAt: at })
          .where(and(eq(workstreamAdmissionBatchItems.batchId, input.batchId), eq(workstreamAdmissionBatchItems.itemId, input.itemId))).run();
        return { outcome: "completed" as const, item: admissionBatchItemFromRow({ ...item, status: "completed", resultJson, leaseOwner: null, leaseExpiresAt: null, completedAt: at, updatedAt: at }) };
      });
    },

    async finalizeWorkstreamAdmissionBatch(input: { id: string; leaseOwner: string; result: unknown; now?: Date }): Promise<{ outcome: "completed" | "replay" | "incomplete" | "stale_lease" | "not_found"; batch?: WorkstreamAdmissionBatch }> {
      const at = (input.now ?? new Date()).toISOString();
      const resultJson = JSON.stringify(input.result);
      return db.transaction((tx) => {
        const row = tx.select().from(workstreamAdmissionBatches).where(eq(workstreamAdmissionBatches.id, input.id)).limit(1).get();
        if (!row) return { outcome: "not_found" as const };
        const items = tx.select().from(workstreamAdmissionBatchItems).where(eq(workstreamAdmissionBatchItems.batchId, input.id)).orderBy(asc(workstreamAdmissionBatchItems.ordinal)).all();
        if (row.status === "completed") return { outcome: "replay" as const, batch: admissionBatchFromRows(row, items) };
        if (row.leaseOwner !== input.leaseOwner || (row.leaseExpiresAt !== null && row.leaseExpiresAt <= at)) return { outcome: "stale_lease" as const, batch: admissionBatchFromRows(row, items) };
        if (items.some((item) => item.status !== "completed")) return { outcome: "incomplete" as const, batch: admissionBatchFromRows(row, items) };
        tx.update(workstreamAdmissionBatches).set({ status: "completed", resultJson, leaseOwner: null, leaseExpiresAt: null, completedAt: at, updatedAt: at }).where(eq(workstreamAdmissionBatches.id, input.id)).run();
        return { outcome: "completed" as const, batch: admissionBatchFromRows({ ...row, status: "completed", resultJson, leaseOwner: null, leaseExpiresAt: null, completedAt: at, updatedAt: at }, items) };
      });
    },

    async getWorkstreamMetrics(input: { workstreamId: string }): Promise<WorkstreamMetrics | null> {
      const workstream = await db.select().from(factoryWorkstreams).where(eq(factoryWorkstreams.id, input.workstreamId)).limit(1).get();
      if (!workstream) return null;
      const recipe = await db.select().from(factoryRecipeSnapshots).where(and(eq(factoryRecipeSnapshots.id, workstream.recipeId), eq(factoryRecipeSnapshots.version, workstream.recipeVersion))).limit(1).get();
      let recipeValue: FactoryRecipeSnapshotInput;
      try {
        recipeValue = FactoryRecipeSnapshotInputSchema.parse(recipe ? JSON.parse(recipe.recipeJson) : null);
      } catch {
        throw new Error("FACTORY_RECIPE_AUTHORITY_MISSING_OR_INVALID");
      }
      const costUnitsPerAttempt = recipeValue.budgets.costUnitsPerAttempt;
      const memberRows = await db.select({ workThreadId: factoryWorkstreamMembers.workThreadId }).from(factoryWorkstreamMembers).where(eq(factoryWorkstreamMembers.workstreamId, input.workstreamId));
      const currentAssessmentRows = memberRows.length > 0 ? await db.select({
        threadId: workThreads.id,
        assessmentId: completionAssessments.id,
        persistedThreadId: completionAssessments.workThreadId,
        assessmentJson: completionAssessments.assessmentJson,
        waiverId: completionWaivers.id,
        waiverWorkThreadId: completionWaivers.workThreadId,
        waiverContractId: completionWaivers.contractId,
        waiverContractVersion: completionWaivers.contractVersion,
        waiverCycle: completionWaivers.cycle,
        waiverContentDigest: completionWaivers.contentDigest,
        waiverJson: completionWaivers.waiverJson
      })
        .from(factoryWorkstreamMembers)
        .innerJoin(workThreads, eq(workThreads.id, factoryWorkstreamMembers.workThreadId))
        .innerJoin(completionAssessments, eq(completionAssessments.id, workThreads.currentAssessmentId))
        .leftJoin(completionWaivers, eq(
          completionWaivers.id,
          sql<string | null>`CASE WHEN json_valid(${completionAssessments.assessmentJson}) THEN json_extract(${completionAssessments.assessmentJson}, '$.waiver.id') ELSE NULL END`
        ))
        .where(eq(factoryWorkstreamMembers.workstreamId, input.workstreamId)) : [];
      const evaluatedAt = nowIso();
      const acceptedWorkThreadCount = currentAssessmentRows.filter((row) =>
        currentAssessmentIsAccepted(row, evaluatedAt)
      ).length;
      const acceptedProgress = await acceptedProgressSnapshot({
        workThreadIds: memberRows.map((row) => row.workThreadId)
      });
      const runRows = await db.select().from(runs).where(eq(runs.workstreamId, input.workstreamId));
      const attemptRows = runRows.length > 0 ? await db.select({
        runId: attempts.runId,
        runnerLocality: attempts.runnerLocality
      }).from(attempts)
        .innerJoin(runs, eq(runs.id, attempts.runId))
        .where(eq(runs.workstreamId, input.workstreamId)) : [];
      const blockedEvents = runRows.length > 0 ? await db.select({
        runId: runEvents.runId,
        payloadJson: runEvents.payloadJson
      }).from(runEvents)
        .innerJoin(runs, eq(runs.id, runEvents.runId))
        .where(and(eq(runs.workstreamId, input.workstreamId), eq(runEvents.type, "factory.budget_blocked"))) : [];
      const currentlyNeedsHuman = new Set(runRows.filter((run) => run.status === "needs_approval").map((run) => run.id));
      const blockedRunIds = new Set(blockedEvents.filter((row) => currentlyNeedsHuman.has(row.runId)).map((row) => row.runId));
      const localityCounts = { local: 0, private: 0, hosted: 0, unknown: 0 };
      const attemptCountByRun = new Map<string, number>();
      for (const attempt of attemptRows) {
        attemptCountByRun.set(attempt.runId, (attemptCountByRun.get(attempt.runId) ?? 0) + 1);
        const locality = attempt.runnerLocality;
        if (locality === "local" || locality === "private" || locality === "hosted") localityCounts[locality] += 1;
        else localityCounts.unknown += 1;
      }
      const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted", "timed_out"]);
      return {
        workstreamId: input.workstreamId,
        workThreadCount: memberRows.length,
        acceptedWorkThreadCount,
        acceptedGateAdvanceCount: acceptedProgress.acceptedGateAdvanceCount,
        attributedGateAdvanceCount: acceptedProgress.attributedGateAdvanceCount,
        unresolvedGateAdvanceCount: acceptedProgress.unresolvedGateAdvanceCount,
        runsWithAcceptedProgressCount: acceptedProgress.runIdsWithAcceptedProgress.length,
        runCount: runRows.length,
        queuedRunCount: runRows.filter((run) => run.status === "queued").length,
        activeRunCount: runRows.filter((run) => ["assigned", "running"].includes(run.status)).length,
        terminalRunCount: runRows.filter((run) => terminal.has(run.status)).length,
        failedRunCount: runRows.filter((run) => ["failed", "interrupted", "timed_out"].includes(run.status)).length,
        needsHumanRunCount: runRows.filter((run) => run.status === "needs_approval").length,
        budgetBlockedRunCount: blockedRunIds.size,
        totalAttempts: attemptRows.length,
        attemptsPerRunExceededCount: [...attemptCountByRun.values()]
          .filter((count) => count > recipeValue.budgets.maxAttemptsPerRun).length,
        totalCostUnits: attemptRows.length * costUnitsPerAttempt,
        attemptsByLocality: localityCounts,
        exceptionCount: runRows.filter((run) => run.status === "needs_approval" || ["failed", "interrupted", "timed_out"].includes(run.status)).length
      };
    },

    upsertWorkThread: upsertWorkThreadRecord,

    async getWorkThread(input: { workThreadId: string }): Promise<DurableWorkThread | null> {
      const row = await db.select().from(workThreads).where(eq(workThreads.id, input.workThreadId)).limit(1).get();
      return row ? workThreadFromRow(row) : null;
    },

    async listWorkThreads(input: { limit?: number } = {}): Promise<DurableWorkThread[]> {
      const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
      const rows = await db
        .select()
        .from(workThreads)
        .orderBy(desc(workThreads.updatedAt), asc(workThreads.id))
        .limit(limit);
      return rows.map(workThreadFromRow);
    },

    async enqueueReassessmentObligation(
      input: EnqueueReassessmentObligationInput
    ): Promise<{ outcome: "created" | "existing"; obligation: ReassessmentObligation }> {
      const values = reassessmentObligationValues(input);
      return db.transaction((tx) => {
        const thread = tx.select({ id: workThreads.id }).from(workThreads)
          .where(eq(workThreads.id, values.workThreadId)).limit(1).get();
        if (!thread) throw new Error(`WorkThread ${values.workThreadId} does not exist.`);
        const inserted = tx.insert(reassessmentObligations).values(values).onConflictDoNothing().run();
        const row = tx.select().from(reassessmentObligations).where(and(
          eq(reassessmentObligations.sourceKind, values.sourceKind),
          eq(reassessmentObligations.sourceId, values.sourceId),
          eq(reassessmentObligations.sourceDigest, values.sourceDigest)
        )).limit(1).get();
        if (!row) throw new Error("ReassessmentObligation disappeared after enqueue.");
        if (row.workThreadId !== values.workThreadId) {
          throw new Error("ReassessmentObligation source identity is already bound to a different WorkThread.");
        }
        return {
          outcome: inserted.changes === 1 ? "created" as const : "existing" as const,
          obligation: reassessmentObligationFromRow(row)
        };
      }, { behavior: "immediate" });
    },

    async getReassessmentObligation(input: { id: string }): Promise<ReassessmentObligation | null> {
      const row = await db.select().from(reassessmentObligations)
        .where(eq(reassessmentObligations.id, input.id)).limit(1).get();
      return row ? reassessmentObligationFromRow(row) : null;
    },

    async listReassessmentObligations(input: {
      workThreadId?: string;
      state?: ReassessmentObligationState;
      limit?: number;
    } = {}): Promise<ReassessmentObligation[]> {
      const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
      const state = input.state ? ReassessmentObligationStateSchema.parse(input.state) : undefined;
      const rows = input.workThreadId && state
        ? await db.select().from(reassessmentObligations).where(and(
            eq(reassessmentObligations.workThreadId, input.workThreadId),
            eq(reassessmentObligations.state, state)
          )).orderBy(asc(reassessmentObligations.notBefore), asc(reassessmentObligations.createdAt), asc(reassessmentObligations.id)).limit(limit)
        : input.workThreadId
          ? await db.select().from(reassessmentObligations)
              .where(eq(reassessmentObligations.workThreadId, input.workThreadId))
              .orderBy(asc(reassessmentObligations.notBefore), asc(reassessmentObligations.createdAt), asc(reassessmentObligations.id)).limit(limit)
          : state
            ? await db.select().from(reassessmentObligations)
                .where(eq(reassessmentObligations.state, state))
                .orderBy(asc(reassessmentObligations.notBefore), asc(reassessmentObligations.createdAt), asc(reassessmentObligations.id)).limit(limit)
            : await db.select().from(reassessmentObligations)
                .orderBy(asc(reassessmentObligations.notBefore), asc(reassessmentObligations.createdAt), asc(reassessmentObligations.id)).limit(limit);
      return rows.map(reassessmentObligationFromRow);
    },

    async claimDueReassessmentObligations(input: {
      leaseOwner: string;
      leaseSeconds: number;
      limit: number;
      now?: Date;
    }): Promise<ReassessmentObligation[]> {
      if (!input.leaseOwner) throw new Error("A reassessment obligation claim requires leaseOwner.");
      if (!Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) {
        throw new Error("A reassessment obligation claim requires positive leaseSeconds.");
      }
      if (!Number.isFinite(input.limit) || input.limit <= 0) {
        throw new Error("A reassessment obligation claim requires a positive limit.");
      }
      const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
      const now = input.now ?? new Date();
      const at = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
      return db.transaction((tx) => {
        const due = tx.select().from(reassessmentObligations).where(or(
          and(
            eq(reassessmentObligations.state, "pending"),
            lte(reassessmentObligations.notBefore, at)
          ),
          and(
            eq(reassessmentObligations.state, "leased"),
            isNotNull(reassessmentObligations.leaseExpiresAt),
            lte(reassessmentObligations.leaseExpiresAt, at)
          )
        )).orderBy(
          asc(reassessmentObligations.notBefore),
          asc(reassessmentObligations.createdAt),
          asc(reassessmentObligations.id)
        ).limit(limit).all();
        const claimed: ReassessmentObligation[] = [];
        for (const row of due) {
          const leaseToken = randomUUID();
          const updated = tx.update(reassessmentObligations).set({
            state: "leased",
            leaseOwner: input.leaseOwner,
            leaseExpiresAt,
            leaseToken,
            attemptCount: row.attemptCount + 1,
            updatedAt: at
          }).where(and(
            eq(reassessmentObligations.id, row.id),
            or(
              and(
                eq(reassessmentObligations.state, "pending"),
                lte(reassessmentObligations.notBefore, at)
              ),
              and(
                eq(reassessmentObligations.state, "leased"),
                isNotNull(reassessmentObligations.leaseExpiresAt),
                lte(reassessmentObligations.leaseExpiresAt, at)
              )
            )
          )).run();
          if (updated.changes !== 1) continue;
          claimed.push(reassessmentObligationFromRow({
            ...row,
            state: "leased",
            leaseOwner: input.leaseOwner,
            leaseExpiresAt,
            leaseToken,
            attemptCount: row.attemptCount + 1,
            updatedAt: at
          }));
        }
        return claimed;
      }, { behavior: "immediate" });
    },

    async renewReassessmentObligationLease(input: {
      id: string;
      leaseOwner: string;
      leaseToken: string;
      leaseSeconds: number;
      now?: Date;
    }): Promise<{ outcome: "renewed" | "stale_lease" | "not_found"; obligation?: ReassessmentObligation }> {
      if (!Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) {
        throw new Error("A reassessment obligation renewal requires positive leaseSeconds.");
      }
      const now = input.now ?? new Date();
      const at = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
      return db.transaction((tx) => {
        const row = tx.select().from(reassessmentObligations).where(eq(reassessmentObligations.id, input.id)).limit(1).get();
        if (!row) return { outcome: "not_found" as const };
        if (
          row.state !== "leased"
          || row.leaseOwner !== input.leaseOwner
          || row.leaseToken !== input.leaseToken
          || !row.leaseExpiresAt
          || row.leaseExpiresAt <= at
        ) return { outcome: "stale_lease" as const, obligation: reassessmentObligationFromRow(row) };
        const renewed = tx.update(reassessmentObligations).set({ leaseExpiresAt, updatedAt: at })
          .where(and(
            eq(reassessmentObligations.id, input.id),
            eq(reassessmentObligations.state, "leased"),
            eq(reassessmentObligations.leaseOwner, input.leaseOwner),
            eq(reassessmentObligations.leaseToken, input.leaseToken),
            gt(reassessmentObligations.leaseExpiresAt, at)
          )).run();
        if (renewed.changes !== 1) {
          return { outcome: "stale_lease" as const, obligation: reassessmentObligationFromRow(row) };
        }
        return {
          outcome: "renewed" as const,
          obligation: reassessmentObligationFromRow({ ...row, leaseExpiresAt, updatedAt: at })
        };
      }, { behavior: "immediate" });
    },

    async satisfyReassessmentObligation(input: {
      id: string;
      leaseOwner: string;
      leaseToken: string;
      reasonCode: Extract<ReassessmentObligationReasonCode, "assessment_satisfied" | "continuation_dispatched" | "continuation_terminal">;
      satisfiedAssessmentId?: string;
      now?: Date;
    }): Promise<{ outcome: "satisfied" | "duplicate" | "stale_lease" | "not_found"; obligation?: ReassessmentObligation }> {
      const reasonCode = ReassessmentObligationReasonCodeSchema.parse(input.reasonCode);
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        const row = tx.select().from(reassessmentObligations).where(eq(reassessmentObligations.id, input.id)).limit(1).get();
        if (!row) return { outcome: "not_found" as const };
        if (row.state === "satisfied") {
          const duplicate = row.lastReasonCode === reasonCode
            && (row.satisfiedAssessmentId ?? undefined) === input.satisfiedAssessmentId;
          return {
            outcome: duplicate ? "duplicate" as const : "stale_lease" as const,
            obligation: reassessmentObligationFromRow(row)
          };
        }
        if (
          row.state !== "leased"
          || row.leaseOwner !== input.leaseOwner
          || row.leaseToken !== input.leaseToken
          || !row.leaseExpiresAt
          || row.leaseExpiresAt <= at
        ) return { outcome: "stale_lease" as const, obligation: reassessmentObligationFromRow(row) };
        const obligation = ReassessmentObligationSchema.parse({
          ...reassessmentObligationFromRow(row),
          state: "satisfied",
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          leaseToken: undefined,
          lastReasonCode: reasonCode,
          lastError: undefined,
          satisfiedAssessmentId: input.satisfiedAssessmentId,
          updatedAt: at
        });
        const satisfied = tx.update(reassessmentObligations).set({
          state: "satisfied",
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseToken: null,
          lastReasonCode: reasonCode,
          lastError: null,
          satisfiedAssessmentId: input.satisfiedAssessmentId ?? null,
          updatedAt: at
        }).where(and(
          eq(reassessmentObligations.id, input.id),
          eq(reassessmentObligations.state, "leased"),
          eq(reassessmentObligations.leaseOwner, input.leaseOwner),
          eq(reassessmentObligations.leaseToken, input.leaseToken),
          gt(reassessmentObligations.leaseExpiresAt, at)
        )).run();
        if (satisfied.changes !== 1) {
          return { outcome: "stale_lease" as const, obligation: reassessmentObligationFromRow(row) };
        }
        return { outcome: "satisfied" as const, obligation };
      }, { behavior: "immediate" });
    },

    async rescheduleReassessmentObligation(input: {
      id: string;
      leaseOwner: string;
      leaseToken: string;
      notBefore: string;
      reasonCode: Extract<ReassessmentObligationReasonCode, "continuation_deferred" | "reassessment_failed">;
      lastError?: string;
      now?: Date;
    }): Promise<{ outcome: "rescheduled" | "stale_lease" | "not_found"; obligation?: ReassessmentObligation }> {
      const reasonCode = ReassessmentObligationReasonCodeSchema.parse(input.reasonCode);
      const notBefore = OpenTagEventSchema.shape.receivedAt.parse(input.notBefore);
      const lastError = sanitizeReassessmentError(input.lastError);
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        const row = tx.select().from(reassessmentObligations).where(eq(reassessmentObligations.id, input.id)).limit(1).get();
        if (!row) return { outcome: "not_found" as const };
        if (
          row.state !== "leased"
          || row.leaseOwner !== input.leaseOwner
          || row.leaseToken !== input.leaseToken
          || !row.leaseExpiresAt
          || row.leaseExpiresAt <= at
        ) return { outcome: "stale_lease" as const, obligation: reassessmentObligationFromRow(row) };
        const obligation = ReassessmentObligationSchema.parse({
          ...reassessmentObligationFromRow(row),
          state: "pending",
          notBefore,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          leaseToken: undefined,
          lastReasonCode: reasonCode,
          lastError,
          satisfiedAssessmentId: undefined,
          updatedAt: at
        });
        const rescheduled = tx.update(reassessmentObligations).set({
          state: "pending",
          notBefore,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseToken: null,
          lastReasonCode: reasonCode,
          lastError: lastError ?? null,
          satisfiedAssessmentId: null,
          updatedAt: at
        }).where(and(
          eq(reassessmentObligations.id, input.id),
          eq(reassessmentObligations.state, "leased"),
          eq(reassessmentObligations.leaseOwner, input.leaseOwner),
          eq(reassessmentObligations.leaseToken, input.leaseToken),
          gt(reassessmentObligations.leaseExpiresAt, at)
        )).run();
        if (rescheduled.changes !== 1) {
          return { outcome: "stale_lease" as const, obligation: reassessmentObligationFromRow(row) };
        }
        return { outcome: "rescheduled" as const, obligation };
      }, { behavior: "immediate" });
    },

    async blockReassessmentObligation(input: {
      id: string;
      leaseOwner: string;
      leaseToken: string;
      reasonCode: Extract<ReassessmentObligationReasonCode, "source_missing" | "authority_missing" | "needs_human">;
      lastError?: string;
      now?: Date;
    }): Promise<{ outcome: "blocked" | "duplicate" | "stale_lease" | "not_found"; obligation?: ReassessmentObligation }> {
      const reasonCode = ReassessmentObligationReasonCodeSchema.parse(input.reasonCode);
      const lastError = sanitizeReassessmentError(input.lastError);
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        const row = tx.select().from(reassessmentObligations).where(eq(reassessmentObligations.id, input.id)).limit(1).get();
        if (!row) return { outcome: "not_found" as const };
        if (row.state === "blocked") {
          const duplicate = row.lastReasonCode === reasonCode && (row.lastError ?? undefined) === lastError;
          return {
            outcome: duplicate ? "duplicate" as const : "stale_lease" as const,
            obligation: reassessmentObligationFromRow(row)
          };
        }
        if (
          row.state !== "leased"
          || row.leaseOwner !== input.leaseOwner
          || row.leaseToken !== input.leaseToken
          || !row.leaseExpiresAt
          || row.leaseExpiresAt <= at
        ) return { outcome: "stale_lease" as const, obligation: reassessmentObligationFromRow(row) };
        const obligation = ReassessmentObligationSchema.parse({
          ...reassessmentObligationFromRow(row),
          state: "blocked",
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          leaseToken: undefined,
          lastReasonCode: reasonCode,
          lastError,
          satisfiedAssessmentId: undefined,
          updatedAt: at
        });
        const blocked = tx.update(reassessmentObligations).set({
          state: "blocked",
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseToken: null,
          lastReasonCode: reasonCode,
          lastError: lastError ?? null,
          satisfiedAssessmentId: null,
          updatedAt: at
        }).where(and(
          eq(reassessmentObligations.id, input.id),
          eq(reassessmentObligations.state, "leased"),
          eq(reassessmentObligations.leaseOwner, input.leaseOwner),
          eq(reassessmentObligations.leaseToken, input.leaseToken),
          gt(reassessmentObligations.leaseExpiresAt, at)
        )).run();
        if (blocked.changes !== 1) {
          return { outcome: "stale_lease" as const, obligation: reassessmentObligationFromRow(row) };
        }
        return { outcome: "blocked" as const, obligation };
      }, { behavior: "immediate" });
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
        if (input.workThreadId) {
          const attachedRows = tx.select({
            id: verificationEvidenceRecords.id,
            payloadDigest: verificationEvidenceRecords.payloadDigest,
            receivedAt: verificationEvidenceRecords.receivedAt
          }).from(verificationEvidenceRecords).where(and(
            eq(verificationEvidenceRecords.workThreadId, input.workThreadId),
            eq(verificationEvidenceRecords.provider, input.provider),
            eq(verificationEvidenceRecords.deliveryId, input.deliveryId),
            eq(verificationEvidenceRecords.subjectRef, input.subjectRef)
          )).all();
          tx.insert(reassessmentObligations).values(verificationEvidenceAttachmentObligation({
            workThreadId: input.workThreadId,
            provider: input.provider,
            deliveryId: input.deliveryId,
            subjectRef: input.subjectRef,
            records: attachedRows,
            at: attachedRows.map((attached) => attached.receivedAt).sort()[0] ?? receivedAt
          })).onConflictDoNothing().run();
        }
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
        const attachmentGroups = new Map<string, StoredVerificationEvidence[]>();
        for (const evidence of stored) {
          if (!evidence.workThreadId) continue;
          const key = JSON.stringify([
            evidence.workThreadId,
            evidence.provider,
            evidence.deliveryId,
            evidence.subjectRef
          ]);
          const group = attachmentGroups.get(key) ?? [];
          group.push(evidence);
          attachmentGroups.set(key, group);
        }
        for (const group of attachmentGroups.values()) {
          const first = group[0]!;
          const attachedRows = tx.select({
            id: verificationEvidenceRecords.id,
            payloadDigest: verificationEvidenceRecords.payloadDigest,
            receivedAt: verificationEvidenceRecords.receivedAt
          }).from(verificationEvidenceRecords).where(and(
            eq(verificationEvidenceRecords.workThreadId, first.workThreadId!),
            eq(verificationEvidenceRecords.provider, first.provider),
            eq(verificationEvidenceRecords.deliveryId, first.deliveryId),
            eq(verificationEvidenceRecords.subjectRef, first.subjectRef)
          )).all();
          tx.insert(reassessmentObligations).values(verificationEvidenceAttachmentObligation({
            workThreadId: first.workThreadId!,
            provider: first.provider,
            deliveryId: first.deliveryId,
            subjectRef: first.subjectRef,
            records: attachedRows,
            at: attachedRows.map((attached) => attached.receivedAt).sort()[0]!
          })).onConflictDoNothing().run();
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
          const attachedAt = input.attachedAt ?? nowIso();
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
            createdAt: attachedAt
          }).run();
          tx.insert(reassessmentObligations).values(verificationEvidenceAttachmentObligation({
            workThreadId: input.workThreadId,
            provider: input.provider,
            deliveryId: input.deliveryId,
            subjectRef: input.subjectRef,
            records,
            at: attachedAt
          })).onConflictDoNothing().run();
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
          const duplicate = completionAssessmentFromRow(duplicateById);
          if (duplicate.triggeredByRunId) {
            ensureCompletionAssessmentProjectionTx(tx, {
              workThreadId: duplicate.workThreadId,
              runId: duplicate.triggeredByRunId,
              assessmentId: duplicate.id
            });
          }
          return { outcome: "duplicate" as const, assessment: duplicate };
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
          const duplicate = completionAssessmentFromRow(duplicateByInput);
          if (duplicate.triggeredByRunId) {
            ensureCompletionAssessmentProjectionTx(tx, {
              workThreadId: duplicate.workThreadId,
              runId: duplicate.triggeredByRunId,
              assessmentId: duplicate.id
            });
          }
          return { outcome: "duplicate" as const, assessment: duplicate };
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
        if (assessment.triggeredByRunId) {
          ensureCompletionAssessmentProjectionTx(tx, {
            workThreadId: assessment.workThreadId,
            runId: assessment.triggeredByRunId,
            assessmentId: assessment.id
          });
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

    async getAcceptedProgressAttribution(input: { workThreadId: string }): Promise<AcceptedProgressAttributionView | null> {
      const thread = await db.select({ currentAssessmentId: workThreads.currentAssessmentId })
        .from(workThreads)
        .where(eq(workThreads.id, input.workThreadId))
        .limit(1)
        .get();
      if (!thread?.currentAssessmentId) return null;
      const snapshot = await acceptedProgressSnapshot({ workThreadIds: [input.workThreadId] });
      return snapshot.projectionsByWorkThreadId.get(input.workThreadId) ?? null;
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
        tx.insert(reassessmentObligations).values(reassessmentObligationValues({
          workThreadId: contract.workThreadId,
          sourceKind: "completion_waiver_changed",
          sourceId: waiver.id,
          sourceDigest: contentDigest,
          notBefore: waiver.waivedAt,
          createdAt: waiver.waivedAt
        })).onConflictDoNothing().run();
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
        tx.insert(reassessmentObligations)
          .values(humanEscalationReassessmentObligation(escalation, createdAt))
          .onConflictDoNothing()
          .run();
        return { escalation, created: true };
      });
    },

    async transitionHumanEscalation(input: {
      id: string;
      toState: "acknowledged" | "resolved" | "expired" | "superseded";
      at: string;
      actor?: ActorIdentity;
      channelPrincipal?: ManagedChannelPrincipalIdentity;
      optionId?: string;
      reason?: string;
      supersededById?: string;
    }): Promise<{ escalation: HumanEscalation; changed: boolean }> {
      const transitionedAt = OpenTagEventSchema.shape.receivedAt.parse(input.at);
      return db.transaction((tx) => {
        const existing = tx.select().from(humanEscalations).where(eq(humanEscalations.id, input.id)).limit(1).get();
        if (!existing) throw new Error(`HumanEscalation ${input.id} does not exist.`);
        const current = humanEscalationFromRow(existing);
        if (
          (input.toState === "acknowledged" || input.toState === "resolved")
          && current.sourceAuthority
        ) {
          const authority = current.sourceAuthority;
          const bindingRow = tx
            .select()
            .from(channelBindings)
            .where(and(
              eq(channelBindings.provider, authority.provider),
              eq(channelBindings.accountId, authority.accountId),
              eq(channelBindings.conversationId, authority.conversationId)
            ))
            .limit(1)
            .get();
          if (!bindingRow) {
            throw new ManagedChannelAuthorityError("managed_channel_authority_unavailable");
          }
          const binding = channelBindingFromRow(bindingRow);
          if (managedChannelBindingAuthorityDigest(binding) !== authority.bindingDigest) {
            throw new ManagedChannelAuthorityError("managed_channel_authority_changed");
          }
          if (!principalOwnsManagedChannelBinding(input.channelPrincipal, binding)) {
            throw new ManagedChannelAuthorityError("managed_channel_principal_required");
          }
        }
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
        tx.insert(reassessmentObligations)
          .values(humanEscalationReassessmentObligation(escalation, transitionedAt))
          .onConflictDoNothing()
          .run();
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
        if (current.sourceAuthority) {
          throw new ManagedChannelAuthorityError("managed_channel_principal_required");
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
        tx.insert(reassessmentObligations)
          .values(humanEscalationReassessmentObligation(escalation, resolution.resolvedAt))
          .onConflictDoNothing()
          .run();
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
        .where(and(eq(runs.conversationKey, input.conversationKey), inArray(runs.status, ["queued", "assigned", "running", "needs_approval"])))
        .orderBy(asc(runs.createdAt));
      // A permission wait keeps its attempt attached so the runtime can heartbeat
      // and resume it. A completed needs_human run clears the attempt and must not
      // block later work in the same conversation.
      const row = rows.find((candidate) =>
        candidate.status === "queued"
          ? isAutomaticWorkstreamContinuationActionJson(candidate.triggeredByActionJson)
          : candidate.status !== "needs_approval" || candidate.currentAttemptId !== null
      );
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
      workstreamId?: string;
      admissionBatchId?: string;
      accessProfileSnapshot?: AgentAccessProfileSnapshot;
      policySnapshotProvenance?: PolicySnapshotProvenance;
      routingPolicy?: FrozenRoutingPolicy;
    }): Promise<{ followUpRequest: FollowUpRequest; created: boolean }> {
      const event = OpenTagEventSchema.parse(input.event);
      const decision = RunAdmissionDecisionSchema.parse(input.decision);
      const accessProfileSnapshot = input.accessProfileSnapshot
        ? AgentAccessProfileSnapshotSchema.parse(input.accessProfileSnapshot)
        : undefined;
      const policySnapshotProvenance = input.policySnapshotProvenance
        ? PolicySnapshotProvenanceSchema.parse(input.policySnapshotProvenance)
        : undefined;
      const routingPolicy = input.routingPolicy
        ? FrozenRoutingPolicySchema.parse(input.routingPolicy)
        : undefined;
      if (input.admissionBatchId && !input.workstreamId) {
        throw new Error("Follow-up batch attribution requires a workstream.");
      }
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
          workstreamId: input.workstreamId ?? null,
          admissionBatchId: input.admissionBatchId ?? null,
          eventJson: JSON.stringify(event),
          decisionJson: JSON.stringify(decision),
          accessProfileSnapshotJson: accessProfileSnapshot ? JSON.stringify(accessProfileSnapshot) : null,
          policySnapshotProvenanceJson: policySnapshotProvenance ? JSON.stringify(policySnapshotProvenance) : null,
          routingPolicyJson: routingPolicy ? JSON.stringify(routingPolicy) : null,
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
        if (
          existing.workstreamId !== (input.workstreamId ?? null)
          || existing.admissionBatchId !== (input.admissionBatchId ?? null)
        ) {
          throw new Error("FACTORY_FOLLOW_UP_ATTRIBUTION_CONFLICT");
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

    async listFollowUpsForActiveRun(input: { activeRunId: string }): Promise<FollowUpRequest[]> {
      const rows = await db
        .select()
        .from(followUpRequests)
        .where(eq(followUpRequests.activeRunId, input.activeRunId))
        .orderBy(asc(followUpRequests.createdAt));
      return rows.map(followUpRequestFromRow);
    },

    async createRunFromFollowUpRequest(input: { followUpRequestId: string; runId: string }): Promise<{ followUpRequest: FollowUpRequest; run: OpenTagRun }> {
      let row = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.followUpRequestId)).limit(1).get();
      if (!row) {
        throw new Error(`Follow-up request not found: ${input.followUpRequestId}`);
      }
      if (row.status === "promoted") {
        if (!row.createdRunId) {
          throw new Error(`Promoted follow-up request ${input.followUpRequestId} has no created Run.`);
        }
        const existing = await this.getRun({ runId: row.createdRunId });
        if (!existing || existing.event.id !== row.sourceEventId) {
          throw new Error(`Promoted follow-up request ${input.followUpRequestId} has no matching created Run.`);
        }
        if (row.activeRunId) {
          await appendFollowUpPromotedEvent({
            parentRunId: row.activeRunId,
            followUpRequestId: row.id,
            createdRunId: existing.run.id,
            sourceEventId: row.sourceEventId,
            createdAt: row.updatedAt
          });
        }
        return { followUpRequest: followUpRequestFromRow(row), run: existing.run };
      }
      if (row.status !== "queued" && row.status !== "promoting") {
        throw new Error(`Follow-up request ${input.followUpRequestId} is not queued.`);
      }
      let promotionRunId = row.createdRunId ?? input.runId;
      let updatedAt = nowIso();
      if (row.status === "queued") {
        const promoteResult = await db
          .update(followUpRequests)
          .set({
            status: "promoting",
            createdRunId: promotionRunId,
            updatedAt
          })
          .where(and(eq(followUpRequests.id, input.followUpRequestId), eq(followUpRequests.status, "queued")));
        if (promoteResult.changes === 0) {
          row = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.followUpRequestId)).limit(1).get();
          if (!row || row.status !== "promoting" || !row.createdRunId) {
            throw new Error(`Follow-up request ${input.followUpRequestId} is not queued.`);
          }
          promotionRunId = row.createdRunId;
          updatedAt = row.updatedAt;
        } else {
          row = { ...row, status: "promoting", createdRunId: promotionRunId, updatedAt };
        }
      } else if (!row.createdRunId) {
        const repairResult = await db
          .update(followUpRequests)
          .set({ createdRunId: promotionRunId, updatedAt })
          .where(and(
            eq(followUpRequests.id, input.followUpRequestId),
            eq(followUpRequests.status, "promoting"),
            isNull(followUpRequests.createdRunId)
          ));
        if (repairResult.changes === 0) {
          row = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.followUpRequestId)).limit(1).get();
          if (!row?.createdRunId) {
            throw new Error(`Promoting follow-up request ${input.followUpRequestId} has no reserved Run identity.`);
          }
          promotionRunId = row.createdRunId;
          updatedAt = row.updatedAt;
        } else {
          row = { ...row, createdRunId: promotionRunId, updatedAt };
        }
      }
      const followUp = followUpRequestFromRow({ ...row, status: "promoting", createdRunId: promotionRunId, updatedAt });
      let run: OpenTagRun;
      try {
        const createdRun = await this.createRun({
          id: promotionRunId,
          event: followUp.event,
          rejectIfAutomaticContinuationActive: true,
          ...(followUp.accessProfileSnapshot ? { accessProfileSnapshot: followUp.accessProfileSnapshot } : {}),
          ...(followUp.policySnapshotProvenance ? { policySnapshotProvenance: followUp.policySnapshotProvenance } : {}),
          ...(followUp.routingPolicy ? { routingPolicy: followUp.routingPolicy } : {}),
          ...(followUp.activeRunId ? { parentRunId: followUp.activeRunId } : {}),
          ...(followUp.workstreamId ? { workstreamId: followUp.workstreamId } : {}),
          ...(followUp.admissionBatchId ? {
            admissionBatchId: followUp.admissionBatchId,
            admissionItemRunId: followUp.id
          } : {})
        });
        if (!createdRun.created) {
          const existing = await this.getRun({ runId: promotionRunId });
          if (!existing || existing.event.id !== followUp.sourceEventId) {
            throw new Error(`Run already exists for follow-up request ${input.followUpRequestId}.`);
          }
          run = existing.run;
        } else {
          run = createdRun.run;
        }
      } catch (error) {
        const committed = await this.getRun({ runId: promotionRunId });
        if (committed?.event.id === followUp.sourceEventId) {
          run = committed.run;
        } else {
          if (error instanceof ActiveConversationRaceError && !committed) {
            await db
              .update(followUpRequests)
              .set({
                status: "queued",
                createdRunId: null,
                updatedAt: nowIso()
              })
              .where(and(
                eq(followUpRequests.id, input.followUpRequestId),
                eq(followUpRequests.status, "promoting"),
                eq(followUpRequests.createdRunId, promotionRunId)
              ));
          }
          throw error;
        }
      }
      if (followUp.activeRunId) {
        await appendRunChildCreatedEvent({
          parentRunId: followUp.activeRunId,
          childRunId: run.id,
          payload: { childRunId: run.id },
          message: `Created child run ${run.id}.`,
          createdAt: run.createdAt
        });
        await appendFollowUpPromotedEvent({
          parentRunId: followUp.activeRunId,
          followUpRequestId: followUp.id,
          createdRunId: run.id,
          sourceEventId: followUp.sourceEventId,
          createdAt: updatedAt
        });
      }
      await db
        .update(followUpRequests)
        .set({ status: "promoted", createdRunId: run.id, updatedAt })
        .where(and(
          eq(followUpRequests.id, input.followUpRequestId),
          eq(followUpRequests.status, "promoting"),
          eq(followUpRequests.createdRunId, promotionRunId)
        ));
      const updated = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.followUpRequestId)).limit(1).get();
      if (!updated || updated.status !== "promoted" || updated.createdRunId !== run.id) {
        throw new Error(`Follow-up request ${input.followUpRequestId} was promoted but could not be loaded`);
      }
      return { followUpRequest: followUpRequestFromRow(updated), run };
    },

    async registerRunner(input: RunnerRegistrationInput): Promise<void> {
      const registration = RunnerRegistrationInputSchema.parse(input);
      const createdAt = nowIso();
      const hasDirectoryConfiguration = ["locality", "declaredState", "executors", "maxConcurrentRuns", "preference"]
        .some((field) => (input as Record<string, unknown>)[field] !== undefined);
      if (!hasDirectoryConfiguration) {
        const existing = await db.select({ runnerId: runners.runnerId }).from(runners)
          .where(eq(runners.runnerId, registration.runnerId)).limit(1).get();
        if (existing) {
          await db.update(runners).set({ name: registration.name, heartbeatAt: createdAt })
            .where(eq(runners.runnerId, registration.runnerId));
          return;
        }
      }
      await db
        .insert(runners)
        .values({
          runnerId: registration.runnerId,
          name: registration.name,
          locality: registration.locality,
          declaredState: registration.declaredState,
          executorsJson: JSON.stringify(registration.executors),
          maxConcurrentRuns: registration.maxConcurrentRuns,
          preference: registration.preference,
          createdAt,
          heartbeatAt: createdAt
        })
        .onConflictDoUpdate({
          target: runners.runnerId,
          set: {
            name: registration.name,
            locality: registration.locality,
            declaredState: registration.declaredState,
            executorsJson: JSON.stringify(registration.executors),
            maxConcurrentRuns: registration.maxConcurrentRuns,
            preference: registration.preference,
            heartbeatAt: createdAt
          }
        });
    },

    async getRunner(input: { runnerId: string }): Promise<RunnerRegistration | null> {
      const row = await db.select().from(runners).where(eq(runners.runnerId, input.runnerId)).limit(1).get();
      return row ? runnerFromRow(row) : null;
    },

    async listRunners(): Promise<RunnerDirectoryEntry[]> {
      const now = new Date();
      const runnerRows = await db.select().from(runners).orderBy(asc(runners.preference), asc(runners.runnerId));
      const activeRows = await db
        .select({ runnerId: runs.assignedRunnerId, active: sql<number>`count(*)` })
        .from(runs)
        .where(and(inArray(runs.status, ["assigned", "running", "needs_approval"]), isNotNull(runs.assignedRunnerId)))
        .groupBy(runs.assignedRunnerId);
      const activeByRunner = new Map<string, number>();
      for (const active of activeRows) {
        if (!active.runnerId) continue;
        activeByRunner.set(active.runnerId, active.active);
      }
      return runnerRows.map((row) => runnerDirectoryEntry({
        registration: runnerFromRow(row),
        active: activeByRunner.get(row.runnerId) ?? 0,
        now
      }));
    },

    async createRepoBinding(input: {
      provider: string;
      owner: string;
      repo: string;
      runnerId: string;
      fallbackRunnerIds?: string[];
      workspacePath?: string;
      defaultExecutor?: string;
      fallbackExecutorIds?: string[];
      allowedActors?: string[];
    }): Promise<void> {
      const fallbackRunnerIds = uniquePreferenceIds(input.fallbackRunnerIds ?? [], input.runnerId, "runner");
      const fallbackExecutorIds = uniquePreferenceIds(input.fallbackExecutorIds ?? [], input.defaultExecutor, "executor");
      if (fallbackExecutorIds.length > 0 && !input.defaultExecutor) {
        throw new Error("Fallback executor ids require a primary default executor.");
      }
      await db
        .insert(repoBindings)
        .values({
          ...input,
          fallbackRunnerIdsJson: fallbackRunnerIds.length ? JSON.stringify(fallbackRunnerIds) : null,
          workspacePath: input.workspacePath ?? null,
          defaultExecutor: input.defaultExecutor ?? null,
          fallbackExecutorIdsJson: fallbackExecutorIds.length ? JSON.stringify(fallbackExecutorIds) : null,
          allowedActorsJson: input.allowedActors ? JSON.stringify(input.allowedActors) : null,
          createdAt: nowIso()
        })
        .onConflictDoUpdate({
          target: [repoBindings.provider, repoBindings.owner, repoBindings.repo],
          set: {
            runnerId: input.runnerId,
            fallbackRunnerIdsJson: fallbackRunnerIds.length ? JSON.stringify(fallbackRunnerIds) : null,
            workspacePath: input.workspacePath ?? null,
            defaultExecutor: input.defaultExecutor ?? null,
            fallbackExecutorIdsJson: fallbackExecutorIds.length ? JSON.stringify(fallbackExecutorIds) : null,
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

    async beginHostedClaimOperation(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
      request: HostedClaimRequestV1;
    }): Promise<{ outcome: "created" | "replayed"; operation: HostedClaimOperation }> {
      let request: HostedClaimRequestV1;
      try {
        request = HostedClaimRequestV1Schema.parse(input.request);
      } catch {
        throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_INVALID");
      }
      if (!input.destinationId || !input.organizationId || !input.runnerId) {
        throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_INVALID");
      }
      const requestDigest = canonicalSha256Json(request);
      const activeKey = canonicalSha256Json({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        runnerId: input.runnerId
      });
      const createdAt = nowIso();
      return db.transaction((tx) => {
        const pending = tx.select().from(hostedClaimOperations)
          .where(eq(hostedClaimOperations.activeKey, activeKey)).limit(1).get();
        if (pending) {
          return { outcome: "replayed" as const, operation: hostedClaimOperationFromRow(pending) };
        }
        const sameOperation = tx.select().from(hostedClaimOperations)
          .where(eq(hostedClaimOperations.operationId, request.operationId)).limit(1).get();
        if (sameOperation) {
          if (
            sameOperation.requestDigest !== requestDigest
            || sameOperation.requestId !== request.requestId
            || sameOperation.destinationId !== input.destinationId
            || sameOperation.organizationId !== input.organizationId
            || sameOperation.runnerId !== input.runnerId
          ) {
            throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
          }
          return { outcome: "replayed" as const, operation: hostedClaimOperationFromRow(sameOperation) };
        }
        const sameRequest = tx.select().from(hostedClaimOperations)
          .where(eq(hostedClaimOperations.requestId, request.requestId)).limit(1).get();
        if (sameRequest) throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
        tx.insert(hostedClaimOperations).values({
          operationId: request.operationId,
          requestId: request.requestId,
          organizationId: input.organizationId,
          runnerId: input.runnerId,
          destinationId: input.destinationId,
          activeKey,
          requestDigest,
          requestJson: JSON.stringify(request),
          state: "pending",
          createdAt,
          updatedAt: createdAt
        }).run();
        const row = tx.select().from(hostedClaimOperations)
          .where(eq(hostedClaimOperations.operationId, request.operationId)).limit(1).get()!;
        return { outcome: "created" as const, operation: hostedClaimOperationFromRow(row) };
      });
    },

    async getHostedClaimOperationForRetry(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
    }): Promise<HostedClaimOperation | null> {
      const activeKey = canonicalSha256Json(input);
      const row = await db.select().from(hostedClaimOperations)
        .where(eq(hostedClaimOperations.activeKey, activeKey)).limit(1).get();
      return row ? hostedClaimOperationFromRow(row) : null;
    },

    async getHostedPreImportAuthorityRecovery(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
    }): Promise<
      | { state: "claim_retry"; operation: HostedClaimOperation }
      | {
          state: "reject_pending" | "reject_attention";
          operation: HostedClaimOperation;
          lifecycleOperation: HostedLifecycleOperation;
        }
      | null
    > {
      const activeKey = canonicalSha256Json(input);
      const shell = await db.select().from(hostedClaimOperations).where(and(
        eq(hostedClaimOperations.activeKey, activeKey),
        eq(hostedClaimOperations.state, "claimed")
      )).limit(1).get();
      if (!shell || !shell.runId || !shell.attemptId || !shell.claimDigest || !shell.authorityDigest) return null;
      const imported = await db.select({ attemptId: hostedAttemptImports.attemptId })
        .from(hostedAttemptImports)
        .where(eq(hostedAttemptImports.claimOperationId, shell.operationId)).limit(1).get();
      if (imported) return null;
      const rejection = await db.select().from(hostedLifecycleOperations).where(and(
        eq(hostedLifecycleOperations.destinationId, input.destinationId),
        eq(hostedLifecycleOperations.organizationId, input.organizationId),
        eq(hostedLifecycleOperations.runnerId, input.runnerId),
        eq(hostedLifecycleOperations.credentialId, shell.credentialId ?? ""),
        eq(hostedLifecycleOperations.runId, shell.runId),
        eq(hostedLifecycleOperations.attemptId, shell.attemptId),
        eq(hostedLifecycleOperations.action, "reject-start")
      )).limit(1).get();
      if (!rejection) return { state: "claim_retry", operation: hostedClaimOperationFromRow(shell) };
      if (rejection.state === "acknowledged") return null;
      return {
        state: rejection.state === "attention" ? "reject_attention" : "reject_pending",
        operation: hostedClaimOperationFromRow(shell),
        lifecycleOperation: hostedLifecycleOperationFromRow(rejection)
      };
    },

    async persistHostedClaimAuthorityShell(input: {
      destinationId: string;
      credentialId: string;
      request: HostedClaimRequestV1;
      claim: HostedClaimV1;
    }): Promise<{ outcome: "created" | "replayed"; operation: HostedClaimOperation }> {
      const request = HostedClaimRequestV1Schema.parse(input.request);
      const claim = HostedClaimV1Schema.parse(input.claim);
      if (
        claim.operationId !== request.operationId
        || claim.requestId !== request.requestId
        || claim.authority.credentialId !== input.credentialId
        || !(await verifyHostedClaimFencingTokenDigestV1(claim))
      ) throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
      const claimDigest = canonicalSha256Json(claim);
      const authorityDigest = canonicalSha256Json(claim.authority);
      const authorityJson = canonicalJsonStringify(claim.authority);
      const acknowledgedAt = nowIso();
      return db.transaction((tx) => {
        const current = tx.select().from(hostedClaimOperations).where(and(
          eq(hostedClaimOperations.operationId, request.operationId),
          eq(hostedClaimOperations.requestId, request.requestId),
          eq(hostedClaimOperations.destinationId, input.destinationId),
          eq(hostedClaimOperations.organizationId, claim.organizationId),
          eq(hostedClaimOperations.runnerId, claim.runnerId)
        )).limit(1).get();
        if (!current) throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
        const exact = current.state === "claimed"
          && current.runId === claim.runId
          && current.claimDigest === claimDigest
          && current.authorityDigest === authorityDigest
          && current.authorityJson === authorityJson
          && current.attemptId === claim.attempt.id
          && current.attemptNumber === claim.attempt.number
          && current.fencingTokenDigest === claim.attempt.fencingTokenDigest
          && current.credentialId === input.credentialId
          && current.leaseExpiresAt === claim.attempt.leaseExpiresAt
          && current.executorId === claim.executorId;
        if (exact) return { outcome: "replayed" as const, operation: hostedClaimOperationFromRow(current) };
        if (current.state !== "pending") {
          throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
        }
        const updated = tx.update(hostedClaimOperations).set({
          state: "claimed",
          runId: claim.runId,
          claimDigest,
          authorityDigest,
          authorityJson,
          attemptId: claim.attempt.id,
          attemptNumber: claim.attempt.number,
          fencingTokenDigest: claim.attempt.fencingTokenDigest,
          credentialId: input.credentialId,
          leaseExpiresAt: claim.attempt.leaseExpiresAt,
          executorId: claim.executorId,
          updatedAt: acknowledgedAt,
          acknowledgedAt
        }).where(and(
          eq(hostedClaimOperations.operationId, request.operationId),
          eq(hostedClaimOperations.state, "pending")
        )).run();
        if (updated.changes !== 1) throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
        const row = tx.select().from(hostedClaimOperations)
          .where(eq(hostedClaimOperations.operationId, request.operationId)).limit(1).get()!;
        return { outcome: "created" as const, operation: hostedClaimOperationFromRow(row) };
      }, { behavior: "immediate" });
    },

    async getHostedAssignedRunForRecovery(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
    }): Promise<{
      claimed: HostedAssignedRun;
      hostedAuthority: HostedImportAuthority;
      leaseExpiresAt: string;
    } | null> {
      const recoveredAt = Date.now();
      const operations = await db.select().from(hostedClaimOperations).where(and(
        eq(hostedClaimOperations.destinationId, input.destinationId),
        eq(hostedClaimOperations.organizationId, input.organizationId),
        eq(hostedClaimOperations.runnerId, input.runnerId),
        eq(hostedClaimOperations.state, "claimed")
      )).orderBy(desc(hostedClaimOperations.acknowledgedAt), desc(hostedClaimOperations.operationId));
      for (const operation of operations) {
        if (!operation.runId || operation.executionStartedAt) continue;
        const runRow = await db.select().from(runs).where(and(
          eq(runs.id, operation.runId),
          inArray(runs.status, ["assigned", "running"]),
          eq(runs.assignedRunnerId, input.runnerId)
        )).limit(1).get();
        if (!runRow?.currentAttemptId) continue;
        const attemptRow = await db.select().from(attempts).where(and(
          eq(attempts.id, runRow.currentAttemptId),
          eq(attempts.runId, runRow.id),
          inArray(attempts.status, ["assigned", "running"])
        )).limit(1).get();
        const importRow = await db.select().from(hostedRunImports)
          .where(eq(hostedRunImports.runId, runRow.id)).limit(1).get();
        const attemptImportRow = attemptRow
          ? await db.select().from(hostedAttemptImports)
              .where(eq(hostedAttemptImports.attemptId, attemptRow.id)).limit(1).get()
          : undefined;
        if (
          !attemptRow || !importRow || !attemptImportRow || !attemptRow.selectedExecutorId
          || operation.operationId !== attemptImportRow.claimOperationId
        ) {
          throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        }
        const leaseExpiresAt = Date.parse(attemptRow.leaseExpiresAt);
        if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= recoveredAt) continue;
        const hostedAuthority: HostedImportAuthority = {
          ...(JSON.parse(attemptImportRow.authorityJson) as HostedClaimV1["authority"]),
          admissionId: importRow.admissionId,
          admissionOperationId: importRow.admissionOperationId,
          claimOperationId: attemptImportRow.claimOperationId,
          admissionEnvelopeDigest: importRow.admissionEnvelopeDigest,
          sourceIdentityDigest: importRow.sourceIdentityDigest,
          deliveryPayloadDigest: importRow.deliveryPayloadDigest,
          policyReceiptId: importRow.policyReceiptId,
          policyPayloadDigest: importRow.policyPayloadDigest,
          policyReceiptDigest: importRow.policyReceiptDigest,
          eventDigest: importRow.eventDigest,
          contextPacketDigest: importRow.contextPacketDigest,
          ...(importRow.workThreadId ? { workThreadId: importRow.workThreadId } : {}),
          ...(importRow.workThreadDigest ? { workThreadDigest: importRow.workThreadDigest } : {}),
          claimDigest: attemptImportRow.claimDigest,
          authorityDigest: attemptImportRow.authorityDigest,
          importedAt: attemptImportRow.importedAt
        };
        return {
          claimed: {
            run: runFromRow(runRow),
            event: OpenTagEventSchema.parse(JSON.parse(runRow.eventJson)),
            attemptId: attemptRow.id,
            attemptNumber: attemptRow.number,
            fencingToken: attemptRow.fencingToken,
            executorId: attemptRow.selectedExecutorId
          },
          hostedAuthority,
          leaseExpiresAt: attemptRow.leaseExpiresAt
        };
      }
      return null;
    },

    async markHostedRunRunningLocally(input: {
      runId: string;
      runnerId: string;
      attemptId: string;
      fencingToken: string;
      executor: string;
      executorCapability?: unknown;
      runTimeoutMs?: number;
      idempotencyKey?: string;
      destinationId: string;
      organizationId: string;
      credentialId: string;
      request: HostedRunningRequestV1;
    }): Promise<{ outcome: MarkRunningOutcome; operation: HostedLifecycleOperation }> {
      const request = HostedRunningRequestV1Schema.parse(input.request);
      const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
      if (
        request.attempt.attemptId !== input.attemptId
        || request.attempt.fencingTokenDigest !== await computeHostedClaimFencingTokenDigestV1(input.fencingToken)
        || request.executorId !== safeInput.executor
        || request.runTimeoutMs !== safeInput.runTimeoutMs
      ) throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
      const prepared = await prepareHostedLifecycleOperation({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        credentialId: input.credentialId,
        runId: input.runId,
        action: "running",
        request
      });
      return db.transaction((tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        const importedAttempt = tx.select().from(hostedAttemptImports)
          .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
        const claim = importedAttempt
          ? tx.select().from(hostedClaimOperations).where(and(
              eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId),
              eq(hostedClaimOperations.destinationId, input.destinationId),
              eq(hostedClaimOperations.organizationId, input.organizationId),
              eq(hostedClaimOperations.runnerId, input.runnerId),
              eq(hostedClaimOperations.runId, input.runId),
              eq(hostedClaimOperations.state, "claimed")
            )).limit(1).get()
          : undefined;
        const authority = importedAttempt
          ? JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]
          : undefined;
        if (!run || !attempt || !importedAttempt || !claim || authority?.credentialId !== input.credentialId) {
          throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        }
        if (
          run.assignedRunnerId !== input.runnerId
          || run.currentAttemptId !== input.attemptId
          || !["assigned", "running"].includes(run.status)
          || attempt.runId !== input.runId
          || attempt.runnerId !== input.runnerId
          || attempt.fencingToken !== input.fencingToken
          || !["assigned", "running"].includes(attempt.status)
          || (attempt.selectedExecutorId !== null && attempt.selectedExecutorId !== safeInput.executor)
          || !hasActiveAttemptLease(attempt)
        ) throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        const journal = enqueueHostedLifecycleOperationTx(tx, prepared);
        const duplicate = run.status === "running" && attempt.status === "running";
        if (!duplicate) {
          tx.update(runs).set({ status: "running", executor: safeInput.executor, updatedAt: prepared.createdAt })
            .where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId))).run();
          tx.update(attempts).set({ status: "running", heartbeatAt: prepared.createdAt, updatedAt: prepared.createdAt })
            .where(eq(attempts.id, input.attemptId)).run();
          tx.insert(runEvents).values(runEventValues({
            runId: input.runId,
            type: "run.running",
            payload: {
              runnerId: input.runnerId,
              attemptId: input.attemptId,
              ...(safeInput.idempotencyKey ? { idempotencyKey: safeInput.idempotencyKey } : {}),
              executor: safeInput.executor,
              ...(safeInput.runTimeoutMs ? { runTimeoutMs: safeInput.runTimeoutMs } : {})
            },
            visibility: "audit",
            importance: "normal",
            createdAt: prepared.createdAt
          })).run();
          if (safeInput.executorCapability) tx.insert(runEvents).values(runEventValues({
            runId: input.runId,
            type: "executor.capability.snapshot",
            payload: { executor: safeInput.executor, capability: safeInput.executorCapability },
            visibility: "audit",
            importance: "normal",
            message: `Executor capability snapshot recorded for ${safeInput.executor}.`,
            createdAt: prepared.createdAt
          })).run();
        }
        return { outcome: duplicate ? "duplicate" : "running", operation: journal.operation };
      }, { behavior: "immediate" });
    },

    async recordHostedProgressLocally(input: {
      runId: string;
      runnerId: string;
      attemptId: string;
      fencingToken: string;
      message: string;
      type?: string;
      at?: string;
      visibility?: RunEventVisibility;
      importance?: RunEventImportance;
      idempotencyKey: string;
      destinationId: string;
      organizationId: string;
      credentialId: string;
      request: HostedProgressRequestV1;
    }): Promise<{ outcome: "recorded" | "duplicate"; operation: HostedLifecycleOperation }> {
      const request = HostedProgressRequestV1Schema.parse(input.request);
      const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
      const createdAt = safeInput.at ?? request.occurredAt;
      const expectedProgressDigest = await computeControlPayloadDigestV1({ type: "status", occurredAt: createdAt });
      if (
        request.attempt.attemptId !== input.attemptId
        || request.attempt.fencingTokenDigest !== await computeHostedClaimFencingTokenDigestV1(input.fencingToken)
        || request.progressDigest !== expectedProgressDigest
        || request.progressId !== `progress_${expectedProgressDigest.slice("sha256:".length)}`
      ) throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
      const prepared = await prepareHostedLifecycleOperation({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        credentialId: input.credentialId,
        runId: input.runId,
        action: "progress",
        request
      });
      return db.transaction((tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        const importedAttempt = tx.select().from(hostedAttemptImports)
          .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
        const claim = importedAttempt
          ? tx.select().from(hostedClaimOperations).where(and(
              eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId),
              eq(hostedClaimOperations.destinationId, input.destinationId),
              eq(hostedClaimOperations.organizationId, input.organizationId),
              eq(hostedClaimOperations.runnerId, input.runnerId),
              eq(hostedClaimOperations.runId, input.runId),
              eq(hostedClaimOperations.state, "claimed")
            )).limit(1).get()
          : undefined;
        const authority = importedAttempt
          ? JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]
          : undefined;
        if (
          !run || !attempt || !importedAttempt || !claim || authority?.credentialId !== input.credentialId
          || run.assignedRunnerId !== input.runnerId
          || run.currentAttemptId !== input.attemptId || run.status !== "running"
          || attempt.runId !== input.runId || attempt.runnerId !== input.runnerId
          || attempt.fencingToken !== input.fencingToken || attempt.status !== "running"
          || !hasActiveAttemptLease(attempt)
        ) throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        const journal = enqueueHostedLifecycleOperationTx(tx, prepared);
        const digest = progressIdempotencyDigest(input.idempotencyKey);
        const inserted = tx.insert(runEvents).values({
          runId: input.runId,
          type: "run.progress",
          payloadJson: JSON.stringify({
            runnerId: input.runnerId,
            attemptId: input.attemptId,
            type: safeInput.type ?? "progress",
            message: safeInput.message,
            at: createdAt
          }),
          progressIdempotencyDigest: digest,
          visibility: safeInput.visibility ?? "audit",
          importance: safeInput.importance ?? "normal",
          message: safeInput.message,
          createdAt
        }).onConflictDoNothing({ target: [runEvents.runId, runEvents.progressIdempotencyDigest] }).run();
        return { outcome: inserted.changes === 1 ? "recorded" : "duplicate", operation: journal.operation };
      }, { behavior: "immediate" });
    },

    async rejectHostedAttemptStartLocally(input: {
      runId: string;
      runnerId: string;
      attemptId: string;
      fencingToken: string;
      executorId: string;
      reason: string;
      destinationId: string;
      organizationId: string;
      credentialId: string;
      request: HostedRejectStartRequestV1;
    }): Promise<{ outcome: RejectAttemptStartOutcome | "journaled"; operation: HostedLifecycleOperation }> {
      const request = HostedRejectStartRequestV1Schema.parse(input.request);
      const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
      if (
        request.attempt.attemptId !== input.attemptId
        || request.attempt.fencingTokenDigest !== await computeHostedClaimFencingTokenDigestV1(input.fencingToken)
        || request.executorId !== safeInput.executorId
      ) throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
      const prepared = await prepareHostedLifecycleOperation({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        credentialId: input.credentialId,
        runId: input.runId,
        action: "reject-start",
        request
      });
      return db.transaction((tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        const claim = tx.select().from(hostedClaimOperations).where(and(
          eq(hostedClaimOperations.destinationId, input.destinationId),
          eq(hostedClaimOperations.organizationId, input.organizationId),
          eq(hostedClaimOperations.runnerId, input.runnerId),
          eq(hostedClaimOperations.runId, input.runId),
          eq(hostedClaimOperations.attemptId, input.attemptId),
          eq(hostedClaimOperations.attemptNumber, request.attempt.attemptNumber),
          eq(hostedClaimOperations.fencingTokenDigest, request.attempt.fencingTokenDigest),
          eq(hostedClaimOperations.credentialId, input.credentialId),
          eq(hostedClaimOperations.executorId, safeInput.executorId),
          eq(hostedClaimOperations.state, "claimed")
        )).limit(1).get();
        const shellAuthority = claim?.authorityJson
          ? JSON.parse(claim.authorityJson) as HostedClaimV1["authority"]
          : undefined;
        const validShell = Boolean(
          claim?.claimDigest && claim.authorityDigest && shellAuthority
          && canonicalSha256Json(shellAuthority) === claim.authorityDigest
          && shellAuthority.organizationId === input.organizationId
          && shellAuthority.runnerId === input.runnerId
          && shellAuthority.runId === input.runId
          && shellAuthority.credentialId === input.credentialId
          && Number.isFinite(Date.parse(claim.leaseExpiresAt ?? ""))
          && Date.parse(claim.leaseExpiresAt ?? "") > Date.parse(prepared.createdAt)
        );
        if (!run || !attempt) {
          if (!validShell) throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
          const journal = enqueueHostedLifecycleOperationTx(tx, prepared);
          return { outcome: "journaled" as const, operation: journal.operation };
        }
        const journal = enqueueHostedLifecycleOperationTx(tx, prepared);
        const alreadyRejected = routingRejectionsFromJson(run.routingRejectionsJson).some(
          (rejection) => rejection.runnerId === input.runnerId && rejection.executorId === safeInput.executorId
        );
        if (alreadyRejected && run.currentAttemptId !== input.attemptId) {
          return { outcome: "duplicate" as const, operation: journal.operation };
        }
        if (
          run.status !== "assigned" || run.currentAttemptId !== input.attemptId
          || run.assignedRunnerId !== input.runnerId || attempt.runId !== input.runId
          || attempt.runnerId !== input.runnerId || attempt.fencingToken !== input.fencingToken
          || attempt.status !== "assigned" || attempt.selectedExecutorId !== safeInput.executorId
          || !hasActiveAttemptLease(attempt)
        ) throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        const rejections = routingRejectionsFromJson(run.routingRejectionsJson);
        rejections.push({ runnerId: input.runnerId, executorId: safeInput.executorId, reason: safeInput.reason });
        tx.update(attempts).set({
          status: "interrupted", finishedAt: prepared.createdAt,
          resultJson: JSON.stringify({ conclusion: "interrupted", summary: safeInput.reason }),
          updatedAt: prepared.createdAt
        }).where(eq(attempts.id, input.attemptId)).run();
        tx.update(runs).set({
          status: "queued", assignedRunnerId: null, executor: null, leasedAt: null,
          leaseExpiresAt: null, heartbeatAt: null, currentAttemptId: null,
          currentRoutingDecisionId: null, routingRejectionsJson: JSON.stringify(rejections),
          updatedAt: prepared.createdAt
        }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId))).run();
        tx.insert(runEvents).values(runEventValues({
          runId: input.runId,
          type: "routing.preflight_rejected",
          payload: {
            runnerId: input.runnerId, executorId: safeInput.executorId,
            attemptId: input.attemptId, routingDecisionId: attempt.routingDecisionId,
            reason: safeInput.reason
          },
          visibility: "audit", importance: "blocking", message: safeInput.reason,
          createdAt: prepared.createdAt
        })).run();
        return { outcome: "requeued" as const, operation: journal.operation };
      }, { behavior: "immediate" });
    },

    async acquireHostedExecutionStart(input: {
      runId: string;
      attemptId: string;
      fencingToken: string;
    }): Promise<boolean> {
      return db.transaction((tx) => {
        const startedAt = nowIso();
        const imported = tx.select().from(hostedRunImports)
          .where(eq(hostedRunImports.runId, input.runId)).limit(1).get();
        const importedAttempt = tx.select().from(hostedAttemptImports)
          .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
        const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        const operation = tx.select().from(hostedClaimOperations).where(and(
          eq(hostedClaimOperations.operationId, importedAttempt?.claimOperationId ?? ""),
          eq(hostedClaimOperations.state, "claimed"),
          eq(hostedClaimOperations.runId, input.runId)
        )).limit(1).get();
        const credentialId = importedAttempt
          ? (JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]).credentialId
          : "";
        const runningOperation = operation
          ? tx.select().from(hostedLifecycleOperations).where(and(
              eq(hostedLifecycleOperations.destinationId, operation.destinationId),
              eq(hostedLifecycleOperations.organizationId, operation.organizationId),
              eq(hostedLifecycleOperations.runnerId, operation.runnerId),
              eq(hostedLifecycleOperations.credentialId, credentialId),
              eq(hostedLifecycleOperations.runId, input.runId),
              eq(hostedLifecycleOperations.attemptId, input.attemptId),
              eq(hostedLifecycleOperations.action, "running"),
              eq(hostedLifecycleOperations.state, "acknowledged")
            )).limit(1).get()
          : undefined;
        if (
          !imported || !importedAttempt || !run || !attempt || !operation || !runningOperation
          || importedAttempt.runId !== input.runId
          || run.status !== "running"
          || run.currentAttemptId !== input.attemptId
          || attempt.runId !== input.runId
          || attempt.status !== "running"
          || attempt.fencingToken !== input.fencingToken
          || !validAcknowledgedLifecycleDependency(runningOperation)
        ) {
          throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        }
        const leaseExpiresAt = Date.parse(attempt.leaseExpiresAt);
        if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.parse(startedAt)) return false;
        if (operation.executionStartedAt) return false;
        const acquired = tx.update(hostedClaimOperations).set({
          executionStartedAt: startedAt,
          updatedAt: startedAt
        }).where(and(
          eq(hostedClaimOperations.operationId, operation.operationId),
          isNull(hostedClaimOperations.executionStartedAt)
        )).run();
        return acquired.changes === 1;
      });
    },

    async isHostedExecutionCurrent(input: {
      runId: string;
      attemptId: string;
      fencingToken: string;
    }): Promise<boolean> {
      return db.transaction((tx) => {
        const checkedAt = Date.now();
        const importedRun = tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
          .where(eq(hostedRunImports.runId, input.runId)).limit(1).get();
        const importedAttempt = tx.select().from(hostedAttemptImports)
          .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
        const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        const operation = tx.select().from(hostedClaimOperations).where(and(
          eq(hostedClaimOperations.operationId, importedAttempt?.claimOperationId ?? ""),
          eq(hostedClaimOperations.state, "claimed"),
          eq(hostedClaimOperations.runId, input.runId),
          isNotNull(hostedClaimOperations.executionStartedAt)
        )).limit(1).get();
        if (
          !importedRun || !importedAttempt || !run || !attempt || !operation
          || importedAttempt.runId !== input.runId
          || run.currentAttemptId !== input.attemptId
          || !["assigned", "running", "needs_approval"].includes(run.status)
          || attempt.runId !== input.runId
          || !["assigned", "running"].includes(attempt.status)
          || attempt.fencingToken !== input.fencingToken
        ) {
          return false;
        }
        const leaseExpiresAt = Date.parse(attempt.leaseExpiresAt);
        return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > checkedAt;
      });
    },

    async getHostedExecutionLease(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
      credentialId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
    }): Promise<{ leaseExpiresAt: string } | null> {
      return db.transaction((tx) => {
        const checkedAt = Date.now();
        const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        const importedAttempt = tx.select().from(hostedAttemptImports)
          .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
        const operation = importedAttempt
          ? tx.select().from(hostedClaimOperations).where(and(
              eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId),
              eq(hostedClaimOperations.destinationId, input.destinationId),
              eq(hostedClaimOperations.organizationId, input.organizationId),
              eq(hostedClaimOperations.runnerId, input.runnerId),
              eq(hostedClaimOperations.state, "claimed"),
              eq(hostedClaimOperations.runId, input.runId),
              isNotNull(hostedClaimOperations.executionStartedAt),
              isNull(hostedClaimOperations.terminalReasonCode)
            )).limit(1).get()
          : undefined;
        if (
          !run || !attempt || !importedAttempt || !operation
          || run.currentAttemptId !== input.attemptId
          || run.assignedRunnerId !== input.runnerId
          || !["assigned", "running", "needs_approval"].includes(run.status)
          || run.leaseExpiresAt !== attempt.leaseExpiresAt
          || attempt.runId !== input.runId
          || attempt.runnerId !== input.runnerId
          || !["assigned", "running"].includes(attempt.status)
          || attempt.fencingToken !== input.fencingToken
          || importedAttempt.runId !== input.runId
          || importedAttempt.attemptNumber !== attempt.number
          || (JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]).credentialId !== input.credentialId
        ) {
          return null;
        }
        const leaseExpiresAt = Date.parse(attempt.leaseExpiresAt);
        return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > checkedAt
          ? { leaseExpiresAt: attempt.leaseExpiresAt }
          : null;
      });
    },

    async enqueueHostedLifecycleOperation(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
      credentialId: string;
      runId: string;
      action: HostedLifecycleActionV1;
      request: HostedLifecycleRequestV1;
      now?: Date;
    }): Promise<{ outcome: "created" | "replayed"; operation: HostedLifecycleOperation }> {
      throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_ATOMIC_API_REQUIRED");
    },

    async claimDueHostedLifecycleOperations(input: {
      destinationId: string;
      organizationId: string;
      leaseOwner: string;
      leaseSeconds: number;
      limit?: number;
      now?: Date;
    }): Promise<HostedLifecycleOperation[]> {
      if (!input.leaseOwner || !Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) {
        throw new Error("hosted_lifecycle_operation_lease_invalid");
      }
      const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)));
      const now = input.now ?? new Date();
      const at = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
      return db.transaction((tx) => {
        const predecessor = alias(hostedLifecycleOperations, "hosted_lifecycle_predecessor");
        const due = tx.select().from(hostedLifecycleOperations).where(and(
          eq(hostedLifecycleOperations.destinationId, input.destinationId),
          eq(hostedLifecycleOperations.organizationId, input.organizationId),
          notExists(
            tx.select({ operationId: predecessor.operationId })
              .from(predecessor)
              .where(and(
                eq(predecessor.destinationId, hostedLifecycleOperations.destinationId),
                eq(predecessor.organizationId, hostedLifecycleOperations.organizationId),
                eq(predecessor.runId, hostedLifecycleOperations.runId),
                eq(predecessor.attemptId, hostedLifecycleOperations.attemptId),
                lt(predecessor.sequence, hostedLifecycleOperations.sequence),
                sql`${predecessor.state} <> 'acknowledged'`
              ))
          ),
          or(
            and(eq(hostedLifecycleOperations.state, "pending"), lte(hostedLifecycleOperations.nextAttemptAt, at)),
            and(eq(hostedLifecycleOperations.state, "leased"), lte(hostedLifecycleOperations.leaseExpiresAt, at))
          )
        )).orderBy(
          asc(hostedLifecycleOperations.runId),
          asc(hostedLifecycleOperations.attemptId),
          asc(hostedLifecycleOperations.sequence),
          asc(hostedLifecycleOperations.operationId)
        ).limit(limit).all();
        const claimed: HostedLifecycleOperation[] = [];
        for (const row of due) {
          const leaseToken = randomUUID();
          const updated = tx.update(hostedLifecycleOperations).set({
            state: "leased",
            attemptCount: row.attemptCount + 1,
            leaseOwner: input.leaseOwner,
            leaseToken,
            leaseExpiresAt,
            updatedAt: at
          }).where(and(
            eq(hostedLifecycleOperations.destinationId, row.destinationId),
            eq(hostedLifecycleOperations.organizationId, row.organizationId),
            eq(hostedLifecycleOperations.runnerId, row.runnerId),
            eq(hostedLifecycleOperations.credentialId, row.credentialId),
            eq(hostedLifecycleOperations.operationId, row.operationId),
            or(
              and(eq(hostedLifecycleOperations.state, "pending"), lte(hostedLifecycleOperations.nextAttemptAt, at)),
              and(eq(hostedLifecycleOperations.state, "leased"), lte(hostedLifecycleOperations.leaseExpiresAt, at))
            )
          )).run();
          if (updated.changes !== 1) continue;
          claimed.push(hostedLifecycleOperationFromRow({
            ...row,
            state: "leased",
            attemptCount: row.attemptCount + 1,
            leaseOwner: input.leaseOwner,
            leaseToken,
            leaseExpiresAt,
            updatedAt: at
          }));
        }
        return claimed;
      }, { behavior: "immediate" });
    },

    async acknowledgeHostedLifecycleOperation(input: {
      destinationId: string;
      organizationId: string;
      operationId: string;
      leaseToken: string;
      receipt: HostedLifecycleReceiptEnvelopeV1;
      now?: Date;
    }): Promise<"acknowledged" | "stale_lease" | "not_found"> {
      const receipt = HostedLifecycleReceiptEnvelopeV1Schema.parse(input.receipt);
      const at = (input.now ?? new Date()).toISOString();
      const preflightRow = await db.select().from(hostedLifecycleOperations).where(and(
        eq(hostedLifecycleOperations.destinationId, input.destinationId),
        eq(hostedLifecycleOperations.organizationId, input.organizationId),
        eq(hostedLifecycleOperations.operationId, input.operationId)
      )).limit(1).get();
      if (!preflightRow) return "not_found";
      const request = HostedLifecycleRequestV1Schema.parse(JSON.parse(preflightRow.requestJson));
      const expectedReceiptId = await computeHostedLifecycleReceiptIdV1({
        organizationId: preflightRow.organizationId,
        operationId: preflightRow.operationId
      });
      if (
        receipt.receiptId !== expectedReceiptId
        || !(await verifyHostedLifecycleReceiptV1({
          receipt,
          request,
          action: preflightRow.action as HostedLifecycleActionV1,
          organizationId: preflightRow.organizationId,
          runnerId: preflightRow.runnerId,
          runId: preflightRow.runId,
          credentialId: preflightRow.credentialId
        }))
      ) return "stale_lease";
      return db.transaction((tx) => {
        const row = tx.select().from(hostedLifecycleOperations).where(and(
          eq(hostedLifecycleOperations.destinationId, input.destinationId),
          eq(hostedLifecycleOperations.organizationId, input.organizationId),
          eq(hostedLifecycleOperations.operationId, input.operationId)
        )).limit(1).get();
        if (!row) return "not_found" as const;
        if (row.state === "acknowledged") {
          return row.receiptId === receipt.receiptId
            && row.receiptDigest === receipt.receiptDigest
            && row.receiptJson === canonicalJsonStringify(receipt)
            ? "acknowledged" as const
            : "stale_lease" as const;
        }
        if (
          row.state !== "leased" || row.leaseToken !== input.leaseToken
          || !row.leaseExpiresAt || row.leaseExpiresAt <= at
          || receipt.organizationId !== row.organizationId
          || receipt.runId !== row.runId
          || receipt.operationId !== row.operationId
          || receipt.requestId !== row.requestId
          || receipt.requestDigest !== row.requestDigest
          || receipt.producer.id !== row.runnerId
          || receipt.producer.credentialId !== row.credentialId
          || receipt.attempt.attemptId !== row.attemptId
          || receipt.attempt.attemptNumber !== row.attemptNumber
          || receipt.attempt.fencingTokenDigest !== row.fencingTokenDigest
        ) return "stale_lease" as const;
        return acknowledgeHostedLifecycleOperationTx({
          tx,
          row,
          receipt,
          acknowledgedAt: at,
          expectedState: "leased",
          leaseToken: input.leaseToken
        }) ? "acknowledged" as const : "stale_lease" as const;
      }, { behavior: "immediate" });
    },

    async retryHostedLifecycleOperation(input: {
      destinationId: string;
      organizationId: string;
      operationId: string;
      leaseToken: string;
      nextAttemptAt: string;
      reasonCode: string;
      now?: Date;
    }): Promise<"retried" | "stale_lease" | "not_found"> {
      const at = (input.now ?? new Date()).toISOString();
      if (input.nextAttemptAt < at) throw new Error("hosted_lifecycle_retry_time_in_past");
      return db.transaction((tx) => {
        const row = tx.select().from(hostedLifecycleOperations).where(and(
          eq(hostedLifecycleOperations.destinationId, input.destinationId),
          eq(hostedLifecycleOperations.organizationId, input.organizationId),
          eq(hostedLifecycleOperations.operationId, input.operationId)
        )).limit(1).get();
        if (!row) return "not_found" as const;
        if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
          return "stale_lease" as const;
        }
        const updated = tx.update(hostedLifecycleOperations).set({
          state: "pending",
          nextAttemptAt: input.nextAttemptAt,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastReasonCode: input.reasonCode,
          updatedAt: at
        }).where(and(
          eq(hostedLifecycleOperations.operationId, row.operationId),
          eq(hostedLifecycleOperations.state, "leased"),
          eq(hostedLifecycleOperations.leaseToken, input.leaseToken),
          gt(hostedLifecycleOperations.leaseExpiresAt, at)
        )).run();
        return updated.changes === 1 ? "retried" as const : "stale_lease" as const;
      }, { behavior: "immediate" });
    },

    async markHostedLifecycleOperationAttention(input: {
      destinationId: string;
      organizationId: string;
      operationId: string;
      leaseToken: string;
      reasonCode: string;
      now?: Date;
    }): Promise<"attention" | "stale_lease" | "not_found"> {
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        const row = tx.select().from(hostedLifecycleOperations).where(and(
          eq(hostedLifecycleOperations.destinationId, input.destinationId),
          eq(hostedLifecycleOperations.organizationId, input.organizationId),
          eq(hostedLifecycleOperations.operationId, input.operationId)
        )).limit(1).get();
        if (!row) return "not_found" as const;
        if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
          return "stale_lease" as const;
        }
        const updated = tx.update(hostedLifecycleOperations).set({
          state: "attention",
          nextAttemptAt: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastReasonCode: input.reasonCode,
          updatedAt: at
        }).where(and(
          eq(hostedLifecycleOperations.operationId, row.operationId),
          eq(hostedLifecycleOperations.state, "leased"),
          eq(hostedLifecycleOperations.leaseToken, input.leaseToken),
          gt(hostedLifecycleOperations.leaseExpiresAt, at)
        )).run();
        return updated.changes === 1 ? "attention" as const : "stale_lease" as const;
      }, { behavior: "immediate" });
    },

    async recoverExpiredHostedLifecycleOperations(input: {
      destinationId: string;
      organizationId: string;
      now?: Date;
    }): Promise<number> {
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => tx.update(hostedLifecycleOperations).set({
        state: "pending",
        nextAttemptAt: at,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastReasonCode: "lease_expired",
        updatedAt: at
      }).where(and(
        eq(hostedLifecycleOperations.destinationId, input.destinationId),
        eq(hostedLifecycleOperations.organizationId, input.organizationId),
        eq(hostedLifecycleOperations.state, "leased"),
        lte(hostedLifecycleOperations.leaseExpiresAt, at)
      )).run().changes, { behavior: "immediate" });
    },

    async beginHostedHeartbeatOperation(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
      credentialId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
      request: HostedHeartbeatRequestV1;
    }): Promise<{ outcome: "created" | "replayed"; operation: HostedHeartbeatOperation }> {
      const prepared = await prepareHostedLifecycleOperation({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        credentialId: input.credentialId,
        runId: input.runId,
        action: "heartbeat",
        request: input.request
      });
      const request = prepared.request as HostedHeartbeatRequestV1;
      return db.transaction((tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const attempt = tx.select().from(attempts).where(and(
          eq(attempts.id, input.attemptId),
          eq(attempts.runId, input.runId),
          eq(attempts.runnerId, input.runnerId),
          eq(attempts.fencingToken, input.fencingToken)
        )).limit(1).get();
        const importedAttempt = tx.select().from(hostedAttemptImports).where(and(
          eq(hostedAttemptImports.attemptId, input.attemptId),
          eq(hostedAttemptImports.runId, input.runId)
        )).limit(1).get();
        const claimOperation = importedAttempt
          ? tx.select().from(hostedClaimOperations).where(and(
              eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId),
              eq(hostedClaimOperations.destinationId, input.destinationId),
              eq(hostedClaimOperations.organizationId, input.organizationId),
              eq(hostedClaimOperations.runnerId, input.runnerId),
              eq(hostedClaimOperations.state, "claimed"),
              eq(hostedClaimOperations.runId, input.runId),
              isNotNull(hostedClaimOperations.executionStartedAt),
              isNull(hostedClaimOperations.terminalReasonCode)
            )).limit(1).get()
          : undefined;
        const authorityCredentialId = importedAttempt
          ? (JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]).credentialId
          : undefined;
        if (
          !run || !attempt || !importedAttempt || !claimOperation
          || request.attempt.attemptId !== input.attemptId
          || request.attempt.attemptNumber !== attempt.number
          || request.attempt.epoch !== attempt.number
          || request.attempt.fencingToken !== input.fencingToken
          || request.attempt.fencingTokenDigest !== importedAttempt.fencingTokenDigest
          || request.expectedLeaseExpiresAt !== attempt.leaseExpiresAt
          || run.currentAttemptId !== input.attemptId
          || run.assignedRunnerId !== input.runnerId
          || !["running", "needs_approval"].includes(run.status)
          || run.leaseExpiresAt !== attempt.leaseExpiresAt
          || attempt.status !== "running"
          || importedAttempt.attemptNumber !== attempt.number
          || authorityCredentialId !== input.credentialId
          || !Number.isFinite(Date.parse(attempt.leaseExpiresAt))
          || Date.parse(attempt.leaseExpiresAt) <= Date.parse(prepared.createdAt)
        ) {
          throw new HostedImportConflictError("HOSTED_HEARTBEAT_OPERATION_CONFLICT");
        }
        const result = enqueueHostedLifecycleOperationTx(tx, prepared);
        const operation = result.operation;
        if (operation.state !== "pending" && operation.state !== "acknowledged") {
          throw new HostedImportConflictError("HOSTED_HEARTBEAT_OPERATION_CONFLICT");
        }
        return {
          outcome: result.outcome,
          operation: {
            destinationId: operation.destinationId,
            organizationId: operation.organizationId,
            runnerId: operation.runnerId,
            credentialId: operation.credentialId,
            operationId: operation.operationId,
            requestId: operation.requestId,
            runId: operation.runId,
            attemptId: operation.attemptId,
            attemptNumber: operation.attemptNumber,
            fencingTokenDigest: operation.fencingTokenDigest,
            expectedLeaseExpiresAt: request.expectedLeaseExpiresAt,
            requestDigest: operation.requestDigest,
            request,
            state: operation.state,
            createdAt: operation.createdAt,
            updatedAt: operation.updatedAt,
            ...(operation.receiptDigest ? { receiptDigest: operation.receiptDigest } : {}),
            ...(operation.receipt ? { receipt: operation.receipt } : {}),
            ...(operation.receipt?.payload.operation === "heartbeat"
              ? { acceptedLeaseExpiresAt: operation.receipt.payload.leaseExpiresAt }
              : {}),
            ...(operation.acknowledgedAt ? { acknowledgedAt: operation.acknowledgedAt } : {})
          }
        };
      }, { behavior: "immediate" });
    },

    async getHostedHeartbeatOperationForRetry(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
      credentialId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
    }): Promise<HostedHeartbeatOperation | null> {
      const row = await db.select().from(hostedLifecycleOperations).where(and(
        eq(hostedLifecycleOperations.destinationId, input.destinationId),
        eq(hostedLifecycleOperations.organizationId, input.organizationId),
        eq(hostedLifecycleOperations.runnerId, input.runnerId),
        eq(hostedLifecycleOperations.credentialId, input.credentialId),
        eq(hostedLifecycleOperations.runId, input.runId),
        eq(hostedLifecycleOperations.attemptId, input.attemptId),
        eq(hostedLifecycleOperations.action, "heartbeat"),
        eq(hostedLifecycleOperations.state, "pending")
      )).orderBy(desc(hostedLifecycleOperations.createdAt)).limit(1).get();
      if (!row) return null;
      const request = HostedHeartbeatRequestV1Schema.parse(JSON.parse(row.requestJson));
      const lease = await this.getHostedExecutionLease(input);
      if (!lease || request.expectedLeaseExpiresAt !== lease.leaseExpiresAt) return null;
      return {
        destinationId: row.destinationId,
        organizationId: row.organizationId,
        runnerId: row.runnerId,
        credentialId: row.credentialId,
        operationId: row.operationId,
        requestId: row.requestId,
        runId: row.runId,
        attemptId: row.attemptId,
        attemptNumber: row.attemptNumber,
        fencingTokenDigest: row.fencingTokenDigest,
        expectedLeaseExpiresAt: request.expectedLeaseExpiresAt,
        requestDigest: row.requestDigest,
        request,
        state: "pending",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    },

    async applyHostedHeartbeatReceipt(input: {
      destinationId: string;
      organizationId: string;
      runnerId: string;
      credentialId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
      operationId: string;
      requestId: string;
      receipt: HostedLifecycleReceiptEnvelopeV1;
    }): Promise<"accepted" | "replayed" | "rejected"> {
      return await (async () => {
        const parsed = HostedLifecycleReceiptEnvelopeV1Schema.safeParse(input.receipt);
        if (!parsed.success || parsed.data.payload.operation !== "heartbeat") return "rejected" as const;
        const receipt = parsed.data;
        const journal = await db.select().from(hostedLifecycleOperations).where(and(
          eq(hostedLifecycleOperations.destinationId, input.destinationId),
          eq(hostedLifecycleOperations.organizationId, input.organizationId),
          eq(hostedLifecycleOperations.runnerId, input.runnerId),
          eq(hostedLifecycleOperations.credentialId, input.credentialId),
          eq(hostedLifecycleOperations.operationId, input.operationId),
          eq(hostedLifecycleOperations.requestId, input.requestId),
          eq(hostedLifecycleOperations.action, "heartbeat")
        )).limit(1).get();
        if (!journal) return "rejected" as const;
        const request = HostedHeartbeatRequestV1Schema.parse(JSON.parse(journal.requestJson));
        const expectedReceiptId = await computeHostedLifecycleReceiptIdV1({
          organizationId: input.organizationId,
          operationId: input.operationId
        });
        if (
          receipt.receiptId !== expectedReceiptId
          || !(await verifyHostedLifecycleReceiptV1({
            receipt,
            request,
            action: "heartbeat",
            organizationId: input.organizationId,
            runnerId: input.runnerId,
            runId: input.runId,
            credentialId: input.credentialId
          }))
        ) return "rejected" as const;
        const receiptJson = canonicalJsonStringify(receipt);
        const acknowledgedAt = nowIso();
        return db.transaction((tx) => {
          const current = tx.select().from(hostedLifecycleOperations).where(and(
            eq(hostedLifecycleOperations.destinationId, input.destinationId),
            eq(hostedLifecycleOperations.organizationId, input.organizationId),
            eq(hostedLifecycleOperations.runnerId, input.runnerId),
            eq(hostedLifecycleOperations.credentialId, input.credentialId),
            eq(hostedLifecycleOperations.operationId, input.operationId),
            eq(hostedLifecycleOperations.requestId, input.requestId)
          )).limit(1).get();
          if (!current) return "rejected" as const;
          if (current.state === "acknowledged") {
            return current.receiptId === receipt.receiptId
              && current.receiptDigest === receipt.receiptDigest
              && current.receiptJson === receiptJson
              ? "replayed" as const
              : "rejected" as const;
          }
          return current.state === "pending" && acknowledgeHostedLifecycleOperationTx({
            tx,
            row: current,
            receipt,
            acknowledgedAt,
            expectedState: "pending"
          }) ? "accepted" as const : "rejected" as const;
        }, { behavior: "immediate" });
      })();
    },

    async acknowledgeHostedClaimEmpty(input: {
      operationId: string;
      requestId: string;
    }): Promise<HostedClaimOperation> {
      const acknowledgedAt = nowIso();
      return db.transaction((tx) => {
        const current = tx.select().from(hostedClaimOperations).where(and(
          eq(hostedClaimOperations.operationId, input.operationId),
          eq(hostedClaimOperations.requestId, input.requestId)
        )).limit(1).get();
        if (!current) throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
        if (current.state === "empty") return hostedClaimOperationFromRow(current);
        if (current.state !== "pending") {
          throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
        }
        tx.update(hostedClaimOperations).set({
          state: "empty",
          activeKey: null,
          updatedAt: acknowledgedAt,
          acknowledgedAt
        }).where(and(
          eq(hostedClaimOperations.operationId, input.operationId),
          eq(hostedClaimOperations.state, "pending")
        )).run();
        return hostedClaimOperationFromRow(tx.select().from(hostedClaimOperations)
          .where(eq(hostedClaimOperations.operationId, input.operationId)).limit(1).get()!);
      });
    },

    async abandonHostedClaimOperation(input: {
      operationId: string;
      requestId: string;
      reasonCode: "stale_control_authority" | "operation_digest_conflict";
    }): Promise<HostedClaimOperation> {
      const acknowledgedAt = nowIso();
      return db.transaction((tx) => {
        const current = tx.select().from(hostedClaimOperations).where(and(
          eq(hostedClaimOperations.operationId, input.operationId),
          eq(hostedClaimOperations.requestId, input.requestId)
        )).limit(1).get();
        if (!current) throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
        if (current.state === "empty" && current.terminalReasonCode === input.reasonCode) {
          return hostedClaimOperationFromRow(current);
        }
        if (current.state !== "pending") {
          throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
        }
        tx.update(hostedClaimOperations).set({
          state: "empty",
          activeKey: null,
          terminalReasonCode: input.reasonCode,
          updatedAt: acknowledgedAt,
          acknowledgedAt
        }).where(and(
          eq(hostedClaimOperations.operationId, input.operationId),
          eq(hostedClaimOperations.state, "pending")
        )).run();
        return hostedClaimOperationFromRow(tx.select().from(hostedClaimOperations)
          .where(eq(hostedClaimOperations.operationId, input.operationId)).limit(1).get()!);
      });
    },

    async importHostedAssignedRun(input: {
      event: OpenTagEvent;
      claim: HostedClaimV1;
      sourceReceipt: HostedSourceRefetchReceipt;
    }): Promise<ImportHostedAssignedRunResult> {
      let event: OpenTagEvent;
      let claim: HostedClaimV1;
      try {
        event = OpenTagEventSchema.parse(input.event);
        claim = HostedClaimV1Schema.parse(input.claim);
      } catch {
        throw new HostedImportConflictError("HOSTED_IMPORT_CLAIM_INVALID");
      }
      if (
        !(await verifyHostedAdmissionEnvelopeDigestV1(claim.hostedAdmission))
        || !(await verifyHostedClaimFencingTokenDigestV1(claim))
      ) {
        throw new HostedImportConflictError("HOSTED_IMPORT_CLAIM_INVALID");
      }

      const admission = claim.hostedAdmission;
      const sourceReceipt = input.sourceReceipt;
      const projectTarget = projectTargetRefFromEvent(event);
      const deliveryId = sourceDeliveryIdFromEvent(event);
      const localThreadNumber = typeof event.metadata.issueNumber === "number"
        ? event.metadata.issueNumber
        : typeof event.metadata.pullRequestNumber === "number"
          ? event.metadata.pullRequestNumber
          : null;
      if (
        event.source !== "github"
        || event.sourceEventId !== admission.sourceEvent.providerEventId
        || event.actor.provider !== "github"
        || event.actor.providerUserId !== admission.verifiedActor.providerUserId
        || event.actor.handle !== admission.verifiedActor.login
        || deliveryId !== admission.deliveryId
        || projectTarget?.provider !== admission.provider
        || projectTarget.owner !== admission.repository.owner
        || projectTarget.repo !== admission.repository.repo
        || event.workItem?.provider !== "github"
        || event.workItem.kind !== admission.sourceThread.kind
        || localThreadNumber !== admission.sourceThread.number
      ) {
        throw new HostedImportConflictError("HOSTED_IMPORT_EVENT_MISMATCH");
      }
      if (
        sourceReceipt.provider !== "github"
        || sourceReceipt.providerRepositoryId !== admission.repository.providerRepositoryId
        || sourceReceipt.owner !== admission.repository.owner
        || sourceReceipt.repo !== admission.repository.repo
        || canonicalSha256Json(sourceReceipt.sourceThread) !== canonicalSha256Json(admission.sourceThread)
        || canonicalSha256Json(sourceReceipt.sourceEvent) !== canonicalSha256Json(admission.sourceEvent)
        || sourceReceipt.actor.providerUserId !== admission.verifiedActor.providerUserId
        || sourceReceipt.actor.login !== admission.verifiedActor.login
        || sourceReceipt.sourceIdentityDigest !== admission.sourceIdentityDigest
        || sourceReceipt.eventDigest !== canonicalSha256Json(event)
        || !Number.isFinite(Date.parse(sourceReceipt.refetchedAt))
      ) {
        throw new HostedImportConflictError("HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT");
      }

      const importedAt = nowIso();
      const protocolFields = protocolRunFieldsFromEvent(event, event.receivedAt);
      const eventDigest = canonicalSha256Json(event);
      const contextPacketDigest = canonicalSha256Json(protocolFields.contextPacket);
      const incomingWorkThreadDigest = protocolFields.thread
        ? canonicalSha256Json(protocolFields.thread)
        : null;
      const claimDigest = canonicalSha256Json(claim);
      const authorityDigest = canonicalSha256Json(claim.authority);

      const result = db.transaction((tx) => {
        const claimOperation = tx.select().from(hostedClaimOperations).where(
          eq(hostedClaimOperations.operationId, claim.operationId)
        ).limit(1).get();
        if (
          !claimOperation
          || claimOperation.requestId !== claim.requestId
          || claimOperation.organizationId !== claim.organizationId
          || claimOperation.runnerId !== claim.runnerId
        ) {
          throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
        }
        const exactAuthorityShell = claimOperation.state === "claimed"
          && claimOperation.runId === claim.runId
          && claimOperation.claimDigest === claimDigest
          && claimOperation.authorityDigest === authorityDigest
          && claimOperation.authorityJson === canonicalJsonStringify(claim.authority)
          && claimOperation.attemptId === claim.attempt.id
          && claimOperation.attemptNumber === claim.attempt.number
          && claimOperation.fencingTokenDigest === claim.attempt.fencingTokenDigest
          && claimOperation.credentialId === claim.authority.credentialId
          && claimOperation.leaseExpiresAt === claim.attempt.leaseExpiresAt
          && claimOperation.executorId === claim.executorId;
        const claimAuthorityAvailable = claimOperation.state === "pending" || exactAuthorityShell;
        if (exactAuthorityShell) {
          const rejection = tx.select({ operationId: hostedLifecycleOperations.operationId })
            .from(hostedLifecycleOperations).where(and(
              eq(hostedLifecycleOperations.destinationId, claimOperation.destinationId),
              eq(hostedLifecycleOperations.organizationId, claim.organizationId),
              eq(hostedLifecycleOperations.runnerId, claim.runnerId),
              eq(hostedLifecycleOperations.credentialId, claim.authority.credentialId),
              eq(hostedLifecycleOperations.runId, claim.runId),
              eq(hostedLifecycleOperations.attemptId, claim.attempt.id),
              eq(hostedLifecycleOperations.action, "reject-start")
            )).limit(1).get();
          if (rejection) throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        }
        const existingImport = tx.select().from(hostedRunImports)
          .where(eq(hostedRunImports.runId, claim.runId)).limit(1).get();
        if (existingImport) {
          const importedAttempt = tx.select().from(hostedAttemptImports)
            .where(eq(hostedAttemptImports.attemptId, claim.attempt.id)).limit(1).get();
          if (!importedAttempt) {
            const exactLineage = existingImport.admissionId === admission.admissionId
              && existingImport.admissionOperationId === admission.operationId
              && existingImport.sourceIdentityDigest === admission.sourceIdentityDigest
              && existingImport.deliveryPayloadDigest === admission.deliveryPayloadDigest
              && existingImport.admissionEnvelopeDigest === admission.envelopeDigest
              && existingImport.eventDigest === eventDigest
              && existingImport.contextPacketDigest === contextPacketDigest
              && existingImport.workThreadDigest === incomingWorkThreadDigest;
            if (!exactLineage) {
              throw new HostedImportConflictError("HOSTED_IMPORT_RUN_CONFLICT");
            }
            const currentRun = tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1).get();
            const previousAttempt = currentRun?.currentAttemptId
              ? tx.select().from(attempts).where(eq(attempts.id, currentRun.currentAttemptId)).limit(1).get()
              : undefined;
            const previousHostedAttempt = previousAttempt
              ? tx.select().from(hostedAttemptImports)
                  .where(eq(hostedAttemptImports.attemptId, previousAttempt.id)).limit(1).get()
              : undefined;
            const retryablePreviousAttempt = Boolean(
              previousAttempt
              && (
                ["interrupted", "cancelled", "timed_out", "failed"].includes(previousAttempt.status)
                || Date.parse(previousAttempt.leaseExpiresAt) <= Date.parse(importedAt)
              )
            );
            if (
              !currentRun || !previousAttempt || !previousHostedAttempt
              || previousHostedAttempt.runId !== claim.runId
              || previousHostedAttempt.attemptNumber !== previousAttempt.number
              || terminalRunStatus(currentRun.status)
              || !retryablePreviousAttempt
              || !claimAuthorityAvailable
              || claim.attempt.number !== previousAttempt.number + 1
            ) {
              throw new HostedImportConflictError("HOSTED_IMPORT_ATTEMPT_CONFLICT");
            }
            if (tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
              .where(eq(hostedAttemptImports.claimOperationId, claim.operationId)).limit(1).get()) {
              throw new HostedImportConflictError("HOSTED_IMPORT_OPERATION_CONFLICT");
            }
            if (tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
              .where(eq(hostedAttemptImports.fencingTokenDigest, claim.attempt.fencingTokenDigest)).limit(1).get()) {
              throw new HostedImportConflictError("HOSTED_IMPORT_FENCE_CONFLICT");
            }
            if (tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
              .where(eq(hostedAttemptImports.authorityDigest, authorityDigest)).limit(1).get()) {
              throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
            }
            if (tx.select({ id: attempts.id }).from(attempts).where(or(
              eq(attempts.id, claim.attempt.id),
              and(eq(attempts.runId, claim.runId), eq(attempts.number, claim.attempt.number))
            )).limit(1).get()) {
              throw new HostedImportConflictError("HOSTED_IMPORT_ATTEMPT_CONFLICT");
            }
            if (tx.select({ id: attempts.id }).from(attempts)
              .where(eq(attempts.fencingToken, claim.attempt.fencingToken)).limit(1).get()) {
              throw new HostedImportConflictError("HOSTED_IMPORT_FENCE_CONFLICT");
            }
            tx.insert(attempts).values({
              id: claim.attempt.id, runId: claim.runId, number: claim.attempt.number,
              runnerId: claim.runnerId, runnerLocality: "hosted", selectedExecutorId: claim.executorId,
              fencingToken: claim.attempt.fencingToken, status: "assigned", startedAt: importedAt,
              heartbeatAt: importedAt, leaseExpiresAt: claim.attempt.leaseExpiresAt,
              createdAt: importedAt, updatedAt: importedAt
            }).run();
            tx.insert(hostedAttemptImports).values({
              attemptId: claim.attempt.id, runId: claim.runId, attemptNumber: claim.attempt.number,
              claimOperationId: claim.operationId, fencingTokenDigest: claim.attempt.fencingTokenDigest,
              claimDigest, authorityDigest, authorityJson: JSON.stringify(claim.authority), importedAt
            }).run();
            const reassigned = tx.update(runs).set({
              status: "assigned", assignedRunnerId: claim.runnerId, executor: claim.executorId,
              leasedAt: importedAt, leaseExpiresAt: claim.attempt.leaseExpiresAt, heartbeatAt: importedAt,
              currentAttemptId: claim.attempt.id, updatedAt: importedAt
            }).where(and(eq(runs.id, claim.runId), eq(runs.currentAttemptId, previousAttempt.id))).run();
            if (reassigned.changes !== 1) {
              throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
            }
            if (!exactAuthorityShell) {
              const acknowledged = tx.update(hostedClaimOperations).set({
                state: "claimed", activeKey: null, runId: claim.runId,
                updatedAt: importedAt, acknowledgedAt: importedAt
              }).where(and(
                eq(hostedClaimOperations.operationId, claim.operationId),
                eq(hostedClaimOperations.state, "pending")
              )).run();
              if (acknowledged.changes !== 1) {
                throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
              }
            } else {
              tx.update(hostedClaimOperations).set({ activeKey: null, updatedAt: importedAt })
                .where(eq(hostedClaimOperations.operationId, claim.operationId)).run();
            }
            return {
              outcome: "created" as const,
              importRow: existingImport,
              attemptImportRow: tx.select().from(hostedAttemptImports)
                .where(eq(hostedAttemptImports.attemptId, claim.attempt.id)).limit(1).get()!,
              runRow: tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1).get()!,
              executionStartedAt: null,
              superseded: false
            };
          }
          const exact = existingImport.admissionId === admission.admissionId
            && existingImport.admissionOperationId === admission.operationId
            && importedAttempt.claimOperationId === claim.operationId
            && importedAttempt.attemptId === claim.attempt.id
            && importedAttempt.fencingTokenDigest === claim.attempt.fencingTokenDigest
            && existingImport.sourceIdentityDigest === admission.sourceIdentityDigest
            && existingImport.deliveryPayloadDigest === admission.deliveryPayloadDigest
            && existingImport.admissionEnvelopeDigest === admission.envelopeDigest
            && existingImport.policyReceiptId === claim.admissionPolicySnapshot.receiptId
            && existingImport.policyPayloadDigest === claim.admissionPolicySnapshot.payloadDigest
            && existingImport.policyReceiptDigest === claim.admissionPolicySnapshot.receiptDigest
            && existingImport.eventDigest === eventDigest
            && existingImport.contextPacketDigest === contextPacketDigest
            && existingImport.workThreadDigest === incomingWorkThreadDigest
            && importedAttempt.claimDigest === claimDigest
            && importedAttempt.authorityDigest === authorityDigest
            && importedAttempt.authorityJson === JSON.stringify(claim.authority);
          if (!exact) throw new HostedImportConflictError("HOSTED_IMPORT_RUN_CONFLICT");
          if (claimOperation.state !== "claimed" || claimOperation.runId !== claim.runId) {
            throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
          }
          const runRow = tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1).get();
          const attemptRow = tx.select().from(attempts).where(eq(attempts.id, claim.attempt.id)).limit(1).get();
          if (runRow && attemptRow && runRow.currentAttemptId !== claim.attempt.id) {
            const currentHostedAttempt = runRow.currentAttemptId
              ? tx.select().from(hostedAttemptImports)
                  .where(eq(hostedAttemptImports.attemptId, runRow.currentAttemptId)).limit(1).get()
              : undefined;
            if (
              !currentHostedAttempt
              || runRow.eventId !== event.id
              || runRow.workThreadId !== existingImport.workThreadId
              || attemptRow.runId !== claim.runId
              || attemptRow.number !== claim.attempt.number
              || attemptRow.runnerId !== claim.runnerId
              || attemptRow.selectedExecutorId !== claim.executorId
              || attemptRow.fencingToken !== claim.attempt.fencingToken
              || attemptRow.leaseExpiresAt !== claim.attempt.leaseExpiresAt
            ) {
              throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
            }
            return {
              outcome: "replayed" as const,
              importRow: existingImport,
              attemptImportRow: importedAttempt,
              runRow,
              executionStartedAt: claimOperation.executionStartedAt,
              superseded: true
            };
          }
          if (
            runRow && attemptRow
            && (runRow.status !== "assigned" || attemptRow.status !== "assigned")
          ) {
            if (
              !claimOperation.executionStartedAt
              || runRow.eventId !== event.id
              || runRow.workThreadId !== existingImport.workThreadId
              || attemptRow.runId !== claim.runId
              || attemptRow.number !== claim.attempt.number
              || attemptRow.runnerId !== claim.runnerId
              || attemptRow.selectedExecutorId !== claim.executorId
              || attemptRow.fencingToken !== claim.attempt.fencingToken
              || attemptRow.leaseExpiresAt !== claim.attempt.leaseExpiresAt
            ) {
              throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
            }
            return {
              outcome: "replayed" as const,
              importRow: existingImport,
              attemptImportRow: importedAttempt,
              runRow,
              executionStartedAt: claimOperation.executionStartedAt,
              superseded: false
            };
          }
          if (
            !runRow || !attemptRow
            || runRow.status !== "assigned"
            || runRow.eventId !== event.id
            || runRow.assignedRunnerId !== claim.runnerId
            || runRow.executor !== claim.executorId
            || runRow.currentAttemptId !== claim.attempt.id
            || runRow.leaseExpiresAt !== claim.attempt.leaseExpiresAt
            || runRow.workThreadId !== existingImport.workThreadId
            || attemptRow.runId !== claim.runId
            || attemptRow.number !== claim.attempt.number
            || attemptRow.runnerId !== claim.runnerId
            || attemptRow.selectedExecutorId !== claim.executorId
            || attemptRow.fencingToken !== claim.attempt.fencingToken
            || attemptRow.leaseExpiresAt !== claim.attempt.leaseExpiresAt
            || attemptRow.status !== "assigned"
          ) {
            throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
          }
          return {
            outcome: "replayed" as const,
            importRow: existingImport,
            attemptImportRow: importedAttempt,
            runRow,
            executionStartedAt: claimOperation.executionStartedAt,
            superseded: false
          };
        }

        if (!claimAuthorityAvailable) {
          throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
        }

        if (tx.select({ id: runs.id }).from(runs).where(or(eq(runs.id, claim.runId), eq(runs.eventId, event.id))).limit(1).get()) {
          throw new HostedImportConflictError("HOSTED_IMPORT_RUN_CONFLICT");
        }
        if (tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
          .where(eq(hostedRunImports.admissionId, admission.admissionId)).limit(1).get()) {
          throw new HostedImportConflictError("HOSTED_IMPORT_ADMISSION_CONFLICT");
        }
        if (tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports).where(or(
          eq(hostedRunImports.claimOperationId, claim.operationId),
          eq(hostedRunImports.claimOperationId, admission.operationId),
          eq(hostedRunImports.admissionOperationId, claim.operationId),
          eq(hostedRunImports.admissionOperationId, admission.operationId)
        )).limit(1).get()) {
          throw new HostedImportConflictError("HOSTED_IMPORT_OPERATION_CONFLICT");
        }
        const collidingAttempt = tx.select().from(attempts).where(or(
          eq(attempts.id, claim.attempt.id),
          and(eq(attempts.runId, claim.runId), eq(attempts.number, claim.attempt.number))
        )).limit(1).get();
        if (collidingAttempt) throw new HostedImportConflictError("HOSTED_IMPORT_ATTEMPT_CONFLICT");
        if (tx.select({ id: attempts.id }).from(attempts)
          .where(eq(attempts.fencingToken, claim.attempt.fencingToken)).limit(1).get()
          || tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
            .where(eq(hostedRunImports.fencingTokenDigest, claim.attempt.fencingTokenDigest)).limit(1).get()
          || tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
            .where(eq(hostedAttemptImports.fencingTokenDigest, claim.attempt.fencingTokenDigest)).limit(1).get()) {
          throw new HostedImportConflictError("HOSTED_IMPORT_FENCE_CONFLICT");
        }
        const sourceCollision = tx.select().from(hostedRunImports).where(
          eq(hostedRunImports.sourceIdentityDigest, admission.sourceIdentityDigest)
        ).limit(1).get();
        if (sourceCollision) throw new HostedImportConflictError("HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT");
        const deliveryCollision = tx.select().from(sourceDeliveries).where(and(
          eq(sourceDeliveries.source, event.source),
          eq(sourceDeliveries.deliveryId, admission.deliveryId)
        )).limit(1).get();
        if (deliveryCollision) throw new HostedImportConflictError("HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT");
        if (tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
          .where(eq(hostedRunImports.authorityDigest, authorityDigest)).limit(1).get()
          || tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
            .where(eq(hostedAttemptImports.authorityDigest, authorityDigest)).limit(1).get()) {
          throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        }

        let durableThread: DurableWorkThread | undefined;
        if (protocolFields.thread) {
          const canonicalKey = workThreadCanonicalKey(protocolFields.thread);
          const existingThread = tx.select().from(workThreads).where(and(
            eq(workThreads.scopeId, "local"),
            eq(workThreads.canonicalKey, canonicalKey)
          )).limit(1).get();
          if (existingThread) {
            let current: DurableWorkThread;
            try {
              current = workThreadFromRow(existingThread);
            } catch {
              throw new HostedImportConflictError("HOSTED_IMPORT_WORK_THREAD_CONFLICT");
            }
            durableThread = mergeWorkThreadAnchors(current, protocolFields.thread);
            if (workThreadCanonicalKey(durableThread) !== canonicalKey) {
              throw new HostedImportConflictError("HOSTED_IMPORT_WORK_THREAD_CONFLICT");
            }
            const mergedJson = JSON.stringify(durableThread);
            if (mergedJson !== existingThread.threadJson) {
              tx.update(workThreads).set({ threadJson: mergedJson, updatedAt: importedAt })
                .where(eq(workThreads.id, existingThread.id)).run();
            }
          } else {
            const id = protocolFields.thread.id ?? `thread_${randomUUID()}`;
            if (tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, id)).limit(1).get()) {
              throw new HostedImportConflictError("HOSTED_IMPORT_WORK_THREAD_CONFLICT");
            }
            durableThread = WorkThreadSchema.parse({ ...protocolFields.thread, id }) as DurableWorkThread;
            tx.insert(workThreads).values({
              id,
              scopeId: "local",
              canonicalKey,
              provider: durableThread.workItemReference.provider,
              ownerContainerId: durableThread.workItemReference.ownerContainer?.id ?? "",
              workItemKind: durableThread.workItemReference.kind,
              externalId: durableThread.workItemReference.externalId,
              threadJson: JSON.stringify(durableThread),
              currentAssessmentId: null,
              createdAt: importedAt,
              updatedAt: importedAt
            }).run();
          }
        }

        tx.insert(runs).values({
          id: claim.runId,
          eventId: event.id,
          status: "assigned",
          eventJson: JSON.stringify(event),
          contextPacketJson: JSON.stringify(protocolFields.contextPacket),
          assignedRunnerId: claim.runnerId,
          executor: claim.executorId,
          repoProvider: projectTarget.provider,
          repoOwner: projectTarget.owner,
          repoName: projectTarget.repo,
          workThreadId: durableThread?.id ?? null,
          conversationKey: conversationKeyFromEvent(event),
          leasedAt: importedAt,
          leaseExpiresAt: claim.attempt.leaseExpiresAt,
          heartbeatAt: importedAt,
          currentAttemptId: claim.attempt.id,
          routingPolicyJson: JSON.stringify({ runnerIds: [claim.runnerId], executorIds: [claim.executorId] }),
          routingRunnerIdsJson: JSON.stringify([claim.runnerId]),
          routingExecutorIdsJson: JSON.stringify([claim.executorId]),
          routingRejectionsJson: "[]",
          createdAt: importedAt,
          updatedAt: importedAt
        }).run();
        tx.insert(attempts).values({
          id: claim.attempt.id,
          runId: claim.runId,
          number: claim.attempt.number,
          runnerId: claim.runnerId,
          runnerLocality: "hosted",
          selectedExecutorId: claim.executorId,
          fencingToken: claim.attempt.fencingToken,
          status: "assigned",
          startedAt: importedAt,
          heartbeatAt: importedAt,
          leaseExpiresAt: claim.attempt.leaseExpiresAt,
          createdAt: importedAt,
          updatedAt: importedAt
        }).run();
        tx.insert(sourceDeliveries).values({
          source: event.source,
          deliveryId: admission.deliveryId,
          runId: claim.runId,
          eventId: event.id,
          createdAt: importedAt
        }).run();
        tx.insert(hostedRunImports).values({
          runId: claim.runId,
          admissionId: admission.admissionId,
          admissionOperationId: admission.operationId,
          claimOperationId: claim.operationId,
          attemptId: claim.attempt.id,
          fencingTokenDigest: claim.attempt.fencingTokenDigest,
          sourceIdentityDigest: admission.sourceIdentityDigest,
          deliveryPayloadDigest: admission.deliveryPayloadDigest,
          admissionEnvelopeDigest: admission.envelopeDigest,
          policyReceiptId: claim.admissionPolicySnapshot.receiptId,
          policyPayloadDigest: claim.admissionPolicySnapshot.payloadDigest,
          policyReceiptDigest: claim.admissionPolicySnapshot.receiptDigest,
          eventDigest,
          contextPacketDigest,
          workThreadId: durableThread?.id ?? null,
          workThreadDigest: incomingWorkThreadDigest,
          claimDigest,
          authorityDigest,
          authorityJson: JSON.stringify(claim.authority),
          importedAt
        }).run();
        tx.insert(hostedAttemptImports).values({
          attemptId: claim.attempt.id,
          runId: claim.runId,
          attemptNumber: claim.attempt.number,
          claimOperationId: claim.operationId,
          fencingTokenDigest: claim.attempt.fencingTokenDigest,
          claimDigest,
          authorityDigest,
          authorityJson: JSON.stringify(claim.authority),
          importedAt
        }).run();
        if (!exactAuthorityShell) {
          const acknowledged = tx.update(hostedClaimOperations).set({
            state: "claimed",
            activeKey: null,
            runId: claim.runId,
            updatedAt: importedAt,
            acknowledgedAt: importedAt
          }).where(and(
            eq(hostedClaimOperations.operationId, claim.operationId),
            eq(hostedClaimOperations.state, "pending")
          )).run();
          if (acknowledged.changes !== 1) {
            throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
          }
        } else {
          tx.update(hostedClaimOperations).set({ activeKey: null, updatedAt: importedAt })
            .where(eq(hostedClaimOperations.operationId, claim.operationId)).run();
        }
        tx.insert(runEvents).values([
          runEventValues({
            runId: claim.runId,
            type: "run.hosted_imported",
            payload: {
              admissionId: admission.admissionId,
              admissionEnvelopeDigest: admission.envelopeDigest,
              claimOperationId: claim.operationId,
              authorityDigest,
              attemptId: claim.attempt.id,
              attemptNumber: claim.attempt.number
            },
            visibility: "audit",
            importance: "high",
            createdAt: importedAt
          }),
          runEventValues({
            runId: claim.runId,
            type: "context_packet.generated",
            payload: { contextPacket: protocolFields.contextPacket, ...(durableThread ? { thread: durableThread } : {}) },
            visibility: "audit",
            importance: "normal",
            message: protocolFields.contextPacket.summary,
            createdAt: importedAt
          })
        ]).run();
        const runRow = tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1).get();
        if (!runRow) throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        return {
          outcome: "created" as const,
          importRow: tx.select().from(hostedRunImports).where(eq(hostedRunImports.runId, claim.runId)).limit(1).get()!,
          attemptImportRow: tx.select().from(hostedAttemptImports)
            .where(eq(hostedAttemptImports.attemptId, claim.attempt.id)).limit(1).get()!,
          runRow,
          executionStartedAt: null,
          superseded: false
        };
      });

      const storedEvent = OpenTagEventSchema.parse(JSON.parse(result.runRow.eventJson));
      const hostedAuthority: HostedImportAuthority = {
        ...(JSON.parse(result.attemptImportRow.authorityJson) as HostedClaimV1["authority"]),
        admissionId: result.importRow.admissionId,
        admissionOperationId: result.importRow.admissionOperationId,
        claimOperationId: result.attemptImportRow.claimOperationId,
        admissionEnvelopeDigest: result.importRow.admissionEnvelopeDigest,
        sourceIdentityDigest: result.importRow.sourceIdentityDigest,
        deliveryPayloadDigest: result.importRow.deliveryPayloadDigest,
        policyReceiptId: result.importRow.policyReceiptId,
        policyPayloadDigest: result.importRow.policyPayloadDigest,
        policyReceiptDigest: result.importRow.policyReceiptDigest,
        eventDigest: result.importRow.eventDigest,
        contextPacketDigest: result.importRow.contextPacketDigest,
        ...(result.importRow.workThreadId ? { workThreadId: result.importRow.workThreadId } : {}),
        ...(result.importRow.workThreadDigest ? { workThreadDigest: result.importRow.workThreadDigest } : {}),
        claimDigest: result.attemptImportRow.claimDigest,
        authorityDigest: result.attemptImportRow.authorityDigest,
        importedAt: result.attemptImportRow.importedAt
      };
      return {
        outcome: result.outcome,
        executionState: terminalRunStatus(result.runRow.status)
          ? "terminal"
          : result.superseded
            ? "superseded"
            : result.executionStartedAt
            ? "already_started"
            : "ready_to_start",
        executionMayStart: false,
        claimed: result.superseded || result.executionStartedAt || terminalRunStatus(result.runRow.status) ? null : {
          run: runFromRow(result.runRow),
          event: storedEvent,
          attemptId: claim.attempt.id,
          attemptNumber: claim.attempt.number,
          fencingToken: claim.attempt.fencingToken,
          executorId: claim.executorId
        },
        hostedAuthority
      };
    },

    async createRun(input: {
      id: string;
      event: OpenTagEvent;
      accessProfileSnapshot?: AgentAccessProfileSnapshot;
      policySnapshotProvenance?: PolicySnapshotProvenance;
      routingPolicy?: FrozenRoutingPolicy;
      parentRunId?: string;
      triggeredByAction?: ActionHint;
      sourceProposalId?: string;
      sourceApplyPlanId?: string;
      workstreamId?: string;
      admissionBatchId?: string;
      admissionItemRunId?: string;
      rejectIfActiveConversation?: boolean;
      rejectIfAutomaticContinuationActive?: boolean;
    }): Promise<CreateRunResult> {
      const event = OpenTagEventSchema.parse(input.event);
      const accessProfileSnapshot = input.accessProfileSnapshot
        ? AgentAccessProfileSnapshotSchema.parse(input.accessProfileSnapshot)
        : undefined;
      const policySnapshotProvenance = input.policySnapshotProvenance
        ? PolicySnapshotProvenanceSchema.parse(input.policySnapshotProvenance)
        : undefined;
      const routingPolicy = input.routingPolicy
        ? FrozenRoutingPolicySchema.parse(input.routingPolicy)
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
      if (input.workstreamId) {
        if (!durableThread) throw new Error("FACTORY_ATTRIBUTION_REQUIRES_WORK_THREAD");
        const member = await db.select({ workThreadId: factoryWorkstreamMembers.workThreadId }).from(factoryWorkstreamMembers)
          .where(and(eq(factoryWorkstreamMembers.workstreamId, input.workstreamId), eq(factoryWorkstreamMembers.workThreadId, durableThread.id))).limit(1).get();
        if (!member) throw new Error("FACTORY_WORKSTREAM_MEMBERSHIP_MISMATCH");
      }
      if (input.admissionBatchId) {
        if (!input.workstreamId || !durableThread) throw new Error("FACTORY_BATCH_ATTRIBUTION_REQUIRES_WORKSTREAM");
        const item = await db.select({ runId: workstreamAdmissionBatchItems.runId }).from(workstreamAdmissionBatchItems)
          .innerJoin(workstreamAdmissionBatches, eq(workstreamAdmissionBatches.id, workstreamAdmissionBatchItems.batchId))
          .where(and(
            eq(workstreamAdmissionBatchItems.batchId, input.admissionBatchId),
            eq(workstreamAdmissionBatchItems.runId, input.admissionItemRunId ?? input.id),
            eq(workstreamAdmissionBatchItems.workThreadId, durableThread.id),
            eq(workstreamAdmissionBatches.workstreamId, input.workstreamId)
          )).limit(1).get();
        if (!item) throw new Error("FACTORY_ADMISSION_BATCH_ATTRIBUTION_MISMATCH");
      }
      const repoKey = projectTargetRefFromEvent(event);
      const routingBinding = routingPolicy ? null : await repoBindingForProjectTarget(repoKey);
      const expectedRunnerId = routingPolicy?.runnerIds?.[0] ?? routingBinding?.runnerId ?? null;
      const frozenRunnerIds = routingPolicy
        ? routingPolicy.runnerIds
        : repoKey
        ? routingBinding
          ? [routingBinding.runnerId, ...routingPreferenceIdsFromJson(routingBinding.fallbackRunnerIdsJson)]
          : []
        : accessProfileSnapshot?.constraints.allowedRunnerIds !== undefined
          ? accessProfileSnapshot.constraints.allowedRunnerIds
          : null;
      const frozenExecutorIds = routingPolicy
        ? routingPolicy.executorIds
        : event.target.executorHint
        ? [event.target.executorHint]
        : routingBinding?.defaultExecutor
          ? [routingBinding.defaultExecutor, ...routingPreferenceIdsFromJson(routingBinding.fallbackExecutorIdsJson)]
          : accessProfileSnapshot?.constraints.allowedExecutorIds !== undefined
            ? accessProfileSnapshot.constraints.allowedExecutorIds
            : null;
      const capturedRoutingPolicy = routingPolicy ?? FrozenRoutingPolicySchema.parse({
        runnerIds: frozenRunnerIds,
        executorIds: frozenExecutorIds
      });
      const reconcileReplayFactoryAttribution = (existingRunId: string): void => {
        if (!input.workstreamId && !input.admissionBatchId) return;
        db.transaction((tx) => {
          const current = tx.select().from(runs).where(eq(runs.id, existingRunId)).limit(1).get();
          if (!current) throw new Error("FACTORY_REPLAY_RUN_NOT_FOUND");
          if (!durableThread || current.workThreadId !== durableThread.id) throw new Error("FACTORY_REPLAY_WORK_THREAD_MISMATCH");
          if (current.workstreamId && current.workstreamId !== input.workstreamId) throw new Error("FACTORY_REPLAY_WORKSTREAM_CONFLICT");
          if (current.admissionBatchId && current.admissionBatchId !== input.admissionBatchId) throw new Error("FACTORY_REPLAY_ADMISSION_BATCH_CONFLICT");
          const shouldAttachWorkstream = Boolean(input.workstreamId && !current.workstreamId);
          const shouldAttachBatch = Boolean(input.admissionBatchId && !current.admissionBatchId);
          if (!shouldAttachWorkstream && !shouldAttachBatch) return;
          const updated = tx.update(runs).set({
            ...(shouldAttachWorkstream ? { workstreamId: input.workstreamId! } : {}),
            ...(shouldAttachBatch ? { admissionBatchId: input.admissionBatchId! } : {}),
            updatedAt: createdAt
          }).where(and(
            eq(runs.id, existingRunId),
            ...(shouldAttachWorkstream ? [isNull(runs.workstreamId)] : []),
            ...(shouldAttachBatch ? [isNull(runs.admissionBatchId)] : [])
          )).run();
          if (updated.changes !== 1) throw new Error("FACTORY_REPLAY_ATTRIBUTION_CAS_CONFLICT");
          tx.insert(runEvents).values({
            ...runEventValues({
              runId: existingRunId,
              type: "factory.attribution_attached",
              payload: { workstreamId: input.workstreamId, admissionBatchId: input.admissionBatchId },
              visibility: "audit",
              importance: "normal",
              createdAt
            }),
            progressIdempotencyDigest: sha256Json({ kind: "factory_attribution", workstreamId: input.workstreamId, admissionBatchId: input.admissionBatchId })
          }).onConflictDoNothing({ target: [runEvents.runId, runEvents.progressIdempotencyDigest] }).run();
        });
      };
      const sourceDeliveryId = sourceDeliveryIdFromEvent(event);
      const createDecision = RunAdmissionDecisionSchema.parse({
        action: "start",
        reason: "Source event accepted and ready to create a run.",
        reasonCode: "new_event",
        decidedAt: createdAt,
        eventId: event.id
      });
      const insertResult = db.transaction((tx) => {
        if (sourceDeliveryId) {
          const existingDelivery = tx.select().from(sourceDeliveries)
            .where(and(eq(sourceDeliveries.source, event.source), eq(sourceDeliveries.deliveryId, sourceDeliveryId)))
            .limit(1)
            .get();
          if (existingDelivery) {
            const existingByDelivery = tx.select().from(runs).where(eq(runs.id, existingDelivery.runId)).limit(1).get();
            if (!existingByDelivery) {
              throw new Error(`Source delivery ${event.source}:${sourceDeliveryId} references a missing Run.`);
            }
            return { outcome: "replay" as const, runRow: existingByDelivery, replayKind: "source_delivery" as const };
          }
        }
        const existingBySourceEvent = tx.select().from(runs).where(eq(runs.eventId, event.id)).limit(1).get();
        if (existingBySourceEvent) {
          return { outcome: "replay" as const, runRow: existingBySourceEvent, replayKind: "source_event" as const };
        }
        if (input.rejectIfActiveConversation || input.rejectIfAutomaticContinuationActive) {
          const activeCandidates = tx.select({ id: runs.id, triggeredByActionJson: runs.triggeredByActionJson })
            .from(runs).where(and(
            inArray(runs.conversationKey, conversationKeysFromEvent(event)),
            or(
              inArray(runs.status, ["queued", "assigned", "running"]),
              and(eq(runs.status, "needs_approval"), isNotNull(runs.currentAttemptId))
            )
          )).orderBy(asc(runs.createdAt), asc(runs.id)).all();
          const active = input.rejectIfActiveConversation
            ? activeCandidates[0]
            : activeCandidates.find((candidate) => isAutomaticWorkstreamContinuationActionJson(candidate.triggeredByActionJson));
          if (active) throw new ActiveConversationRaceError(active.id);
        }
        const inserted = tx.insert(runs).values({
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
        workstreamId: input.workstreamId ?? null,
        admissionBatchId: input.admissionBatchId ?? null,
        conversationKey: conversationKeyFromEvent(event),
        routingPolicyJson: JSON.stringify(capturedRoutingPolicy),
        routingRunnerIdsJson: frozenRunnerIds === null ? null : JSON.stringify(frozenRunnerIds),
        routingExecutorIdsJson: frozenExecutorIds === null ? null : JSON.stringify(frozenExecutorIds),
        routingRejectionsJson: "[]",
        createdAt,
        updatedAt: createdAt
        }).onConflictDoNothing({ target: runs.eventId }).run();
        if (inserted.changes === 0) {
          const replay = tx.select().from(runs).where(eq(runs.eventId, event.id)).limit(1).get();
          if (!replay) throw new Error(`Run already exists for event ${event.id}, but it could not be loaded`);
          return { outcome: "replay" as const, runRow: replay, replayKind: "source_event" as const };
        }
        if (sourceDeliveryId) {
          tx.insert(sourceDeliveries).values({ source: event.source, deliveryId: sourceDeliveryId, runId: input.id, eventId: event.id, createdAt })
            .onConflictDoNothing({ target: [sourceDeliveries.source, sourceDeliveries.deliveryId] }).run();
        }
        const baseEvents: Array<typeof runEvents.$inferInsert> = [
          runEventValues({ runId: input.id, type: "admission.decided", payload: createDecision, visibility: "audit", importance: "normal", message: createDecision.reason, createdAt }),
          runEventValues({ runId: input.id, type: "run.created", payload: { eventId: event.id, provenance: runProvenance({ event, projectTarget: repoKey, admissionDecision: createDecision, expectedRunnerId }) }, visibility: "audit", importance: "low", createdAt }),
          runEventValues({ runId: input.id, type: "context_packet.generated", payload: { contextPacket: protocolFields.contextPacket, ...(durableThread ? { thread: durableThread } : {}) }, visibility: "audit", importance: "normal", message: protocolFields.contextPacket.summary, createdAt })
        ];
        if (accessProfileSnapshot && policySnapshotProvenance) {
          baseEvents.push(runEventValues({
            runId: input.id,
            type: "agent_access_profile.captured",
            payload: { accessProfileSnapshotId: accessProfileSnapshot.id, policySnapshotId: policySnapshotProvenance.id, requestedBy: accessProfileSnapshot.requestedBy, agentPrincipal: accessProfileSnapshot.agentPrincipal, projectTargets: accessProfileSnapshot.projectTargets },
            visibility: "audit",
            importance: "high",
            message: "Attributed agent access and policy snapshots captured at admission.",
            createdAt
          }));
        }
        tx.insert(runEvents).values(baseEvents).run();
        return { outcome: "created" as const };
      });
      if (insertResult.outcome === "replay") {
        reconcileReplayFactoryAttribution(insertResult.runRow.id);
        return recordCreateRunReplay({
          runRow: insertResult.runRow,
          requestedRunId: input.id,
          event,
          projectTarget: repoKey,
          expectedRunnerId,
          replayKind: insertResult.replayKind,
          sourceDeliveryId,
          createdAt
        });
      }
      if (input.parentRunId) {
        await appendRunChildCreatedEvent({
          parentRunId: input.parentRunId,
          childRunId: input.id,
          payload: {
            childRunId: input.id,
            ...(triggeredByAction ? { triggeredByAction } : {}),
            ...(input.sourceProposalId ? { sourceProposalId: input.sourceProposalId } : {}),
            ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {})
          },
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
      await db
        .insert(runners)
        .values({
          runnerId: input.runnerId,
          name: input.runnerId,
          locality: "local",
          declaredState: "ready",
          executorsJson: "[]",
          maxConcurrentRuns: 1_000,
          preference: 0,
          createdAt: runnerHeartbeatAt,
          heartbeatAt: runnerHeartbeatAt
        })
        .onConflictDoUpdate({
          target: runners.runnerId,
          set: { heartbeatAt: runnerHeartbeatAt }
        });
      const activeRows = await db
        .select()
        .from(runs)
        .where(and(
          inArray(runs.status, ["assigned", "running", "needs_approval"]),
          isNotNull(runs.leaseExpiresAt),
          lte(runs.leaseExpiresAt, now.toISOString()),
          notExists(db.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
            .where(eq(hostedRunImports.runId, runs.id)))
        ))
        .orderBy(asc(runs.leaseExpiresAt), asc(runs.createdAt), asc(runs.id))
        .limit(EXPIRED_LEASE_RECOVERY_LIMIT);
      for (const activeRow of activeRows) {
        if (!isIsoExpired(activeRow.leaseExpiresAt, now)) continue;
        const updatedAt = nowIso();
        const interrupted = db.transaction((tx) => {
          const current = tx.select().from(runs).where(eq(runs.id, activeRow.id)).limit(1).get();
          const hosted = tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
            .where(eq(hostedRunImports.runId, activeRow.id)).limit(1).get();
          if (hosted || !current || !isIsoExpired(current.leaseExpiresAt, now) || !["assigned", "running", "needs_approval"].includes(current.status)) {
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
              currentRoutingDecisionId: null,
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

      await db.update(runners).set({ heartbeatAt: runnerHeartbeatAt }).where(eq(runners.runnerId, input.runnerId));
      const updatedAt = nowIso();
      const leasedAt = updatedAt;
      const leaseExpiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
      const attemptId = newAttemptId();
      const fencingToken = newFencingToken();
      const claim = db.transaction((tx) => {
        const caller = tx.select({
          claimCursorCreatedAt: runners.claimCursorCreatedAt,
          claimCursorRunId: runners.claimCursorRunId
        }).from(runners).where(eq(runners.runnerId, input.runnerId)).limit(1).get();
        const hasCursor = Boolean(caller?.claimCursorCreatedAt && caller.claimCursorRunId);
        const isNotHostedRun = notExists(
          tx.select({ runId: hostedRunImports.runId })
            .from(hostedRunImports)
            .where(eq(hostedRunImports.runId, runs.id))
        );
        const queuedAfterCursor = hasCursor
          ? tx.select().from(runs).where(and(
              eq(runs.status, "queued"),
              isNotHostedRun,
              or(
                gt(runs.createdAt, caller!.claimCursorCreatedAt!),
                and(eq(runs.createdAt, caller!.claimCursorCreatedAt!), gt(runs.id, caller!.claimCursorRunId!))
              )
            )).orderBy(asc(runs.createdAt), asc(runs.id)).limit(CLAIM_SCAN_LIMIT).all()
          : tx.select().from(runs).where(and(eq(runs.status, "queued"), isNotHostedRun))
              .orderBy(asc(runs.createdAt), asc(runs.id)).limit(CLAIM_SCAN_LIMIT).all();
        const remainingWindow = CLAIM_SCAN_LIMIT - queuedAfterCursor.length;
        const queuedBeforeCursor = hasCursor && remainingWindow > 0
          ? tx.select().from(runs).where(and(
              eq(runs.status, "queued"),
              isNotHostedRun,
              or(
                lt(runs.createdAt, caller!.claimCursorCreatedAt!),
                and(eq(runs.createdAt, caller!.claimCursorCreatedAt!), lte(runs.id, caller!.claimCursorRunId!))
              )
            )).orderBy(asc(runs.createdAt), asc(runs.id)).limit(remainingWindow).all()
          : [];
        const queuedRows = [...queuedAfterCursor, ...queuedBeforeCursor];
        if (queuedRows.length === 0) return null;

        const queuedEvents = new Map<string, OpenTagEvent>();
        function eventForQueuedRun(queued: typeof runs.$inferSelect): OpenTagEvent {
          const cached = queuedEvents.get(queued.id);
          if (cached) return cached;
          const event = OpenTagEventSchema.parse(JSON.parse(queued.eventJson));
          queuedEvents.set(queued.id, event);
          return event;
        }
        const projectTargets = new Map<string, ProjectTargetRef>();
        for (const queued of queuedRows) {
          const event = eventForQueuedRun(queued);
          const projectTarget = projectTargetRefFromEvent(event);
          if (projectTarget) {
            projectTargets.set(repositoryRoutingKey(projectTarget.provider, projectTarget.owner, projectTarget.repo), projectTarget);
          }
        }
        const projectTargetConditions = [...projectTargets.values()].map((projectTarget) => and(
          eq(repoBindings.provider, projectTarget.provider),
          eq(repoBindings.owner, projectTarget.owner),
          eq(repoBindings.repo, projectTarget.repo)
        ));
        const bindingRows = projectTargetConditions.length
          ? tx.select().from(repoBindings).where(or(...projectTargetConditions)).limit(CLAIM_SCAN_LIMIT).all()
          : [];
        const legacyBindings = new Map(bindingRows.map((binding) => [
          repositoryRoutingKey(binding.provider, binding.owner, binding.repo),
          binding
        ]));

        function directoryRequirementForRun(queued: typeof runs.$inferSelect): {
          explicitRunnerIds: string[];
          mode: "closed" | "explicit" | "wildcard";
        } {
          if (queued.routingPolicyJson !== null) {
            const policy = FrozenRoutingPolicySchema.parse(JSON.parse(queued.routingPolicyJson));
            if (policy.runnerIds !== null) {
              return { explicitRunnerIds: policy.runnerIds, mode: "explicit" };
            }
            const projectTarget = projectTargetRefFromEvent(eventForQueuedRun(queued));
            return { explicitRunnerIds: [], mode: projectTarget ? "closed" : "wildcard" };
          }
          if (queued.routingRunnerIdsJson !== null) {
            return {
              explicitRunnerIds: routingPreferenceIdsFromJson(queued.routingRunnerIdsJson),
              mode: "explicit"
            };
          }
          const event = eventForQueuedRun(queued);
          const projectTarget = projectTargetRefFromEvent(event);
          if (!projectTarget) {
            return { explicitRunnerIds: [], mode: "wildcard" };
          }
          const binding = legacyBindings.get(repositoryRoutingKey(projectTarget.provider, projectTarget.owner, projectTarget.repo));
          return {
            explicitRunnerIds: binding
              ? [binding.runnerId, ...routingPreferenceIdsFromJson(binding.fallbackRunnerIdsJson)]
              : [],
            mode: binding ? "explicit" : "closed"
          };
        }

        const requiredRunnerIds = new Set<string>();
        const evaluationRows: typeof queuedRows = [];
        const evaluationMode = directoryRequirementForRun(queuedRows[0]!).mode;
        for (const queued of queuedRows) {
          const requirement = directoryRequirementForRun(queued);
          if (requirement.mode !== evaluationMode) break;
          const newRunnerIds = requirement.explicitRunnerIds.filter((runnerId) => !requiredRunnerIds.has(runnerId));
          if (requiredRunnerIds.size + newRunnerIds.length > ROUTING_DIRECTORY_LIMIT) {
            break;
          }
          for (const runnerId of newRunnerIds) requiredRunnerIds.add(runnerId);
          evaluationRows.push(queued);
        }
        if (evaluationRows.length === 0) return null;
        const requiredRunnerIdList = [...requiredRunnerIds];
        const explicitRunnerRows = requiredRunnerIdList.length
          ? tx.select().from(runners)
              .where(inArray(runners.runnerId, requiredRunnerIdList))
              .orderBy(asc(runners.preference), asc(runners.runnerId))
              .limit(ROUTING_DIRECTORY_LIMIT)
              .all()
          : [];
        const repositoryFreeRunnerRows = evaluationMode === "wildcard"
          ? tx.select().from(runners)
              .orderBy(asc(runners.preference), asc(runners.runnerId))
              .limit(ROUTING_DIRECTORY_LIMIT)
              .all()
          : [];
        const runnerRows = [...explicitRunnerRows, ...repositoryFreeRunnerRows]
          .sort((left, right) => left.preference - right.preference || left.runnerId.localeCompare(right.runnerId));
        const registrations = runnerRows.map(runnerFromRow);
        const activeRows = runnerRows.length
          ? tx.select({ runnerId: runs.assignedRunnerId, active: sql<number>`count(*)` }).from(runs)
              .where(and(
                inArray(runs.status, ["assigned", "running", "needs_approval"]),
                inArray(runs.assignedRunnerId, runnerRows.map((runner) => runner.runnerId))
              ))
              .groupBy(runs.assignedRunnerId).all()
          : [];
        const activeByRunner = new Map<string, number>();
        for (const active of activeRows) {
          if (!active.runnerId) continue;
          activeByRunner.set(active.runnerId, active.active);
        }
        const snapshot: RoutingDirectorySnapshot = {
          registrations,
          directory: registrations.map((registration) => runnerDirectoryEntry({
            registration,
            active: activeByRunner.get(registration.runnerId) ?? 0,
            now
          })),
          legacyBindings
        };
        const latestRoutingEventIds = tx.select({ id: sql<number>`max(${runEvents.id})` }).from(runEvents)
          .where(and(inArray(runEvents.runId, evaluationRows.map((run) => run.id)), eq(runEvents.type, "routing.decided")))
          .groupBy(runEvents.runId)
          .limit(CLAIM_SCAN_LIMIT)
          .all()
          .map((event) => event.id);
        const existingRoutingEvents = latestRoutingEventIds.length
          ? tx.select().from(runEvents).where(inArray(runEvents.id, latestRoutingEventIds)).all()
          : [];
        const latestRoutingEventByRun = new Map<string, typeof runEvents.$inferSelect>();
        for (const event of existingRoutingEvents) latestRoutingEventByRun.set(event.runId, event);

        for (const candidate of evaluationRows) {
          const accessProfile = candidate.accessProfileSnapshotJson
            ? AgentAccessProfileSnapshotSchema.parse(JSON.parse(candidate.accessProfileSnapshotJson))
            : undefined;
          const accessBlockedReason = accessProfile?.revokedAt && Date.parse(accessProfile.revokedAt) <= now.getTime()
            ? "The captured agent access profile was revoked before a new attempt could start."
            : accessProfile?.expiresAt && Date.parse(accessProfile.expiresAt) <= now.getTime()
              ? "The captured agent access profile expired before a new attempt could start."
              : null;
          if (accessBlockedReason) {
            const blockedAt = now.toISOString();
            tx.update(runs).set({ status: "needs_approval", currentRoutingDecisionId: null, updatedAt: blockedAt })
              .where(and(eq(runs.id, candidate.id), eq(runs.status, "queued"))).run();
            const dedupeKey = `access-profile:${accessProfile!.id}:inactive:v1`;
            const escalationId = `escalation_${createHash("sha256")
              .update(`${candidate.id}\0${dedupeKey}`)
              .digest("hex")
              .slice(0, 24)}`;
            if (candidate.workThreadId) {
              const escalation = HumanEscalationSchema.parse({
                id: escalationId,
                workThreadId: candidate.workThreadId,
                runId: candidate.id,
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
                activeDedupeKey: `${candidate.id}:${dedupeKey}`,
                escalationJson: JSON.stringify(escalation),
                createdAt: blockedAt,
                updatedAt: blockedAt
              }).onConflictDoNothing({ target: humanEscalations.id }).run();
              tx.insert(governanceEvents).values({
                workThreadId: candidate.workThreadId,
                type: "human_escalation.opened",
                subjectId: escalation.id,
                payloadJson: JSON.stringify({ class: escalation.class, blocking: true, dedupeKey, source: "access_profile" }),
                createdAt: blockedAt
              }).run();
              tx.insert(reassessmentObligations)
                .values(humanEscalationReassessmentObligation(escalation, blockedAt))
                .onConflictDoNothing()
                .run();
            }
            tx.insert(runEvents).values(runEventValues({
              runId: candidate.id,
              type: "agent_access_profile.blocked",
              payload: {
                accessProfileSnapshotId: accessProfile!.id,
                reason: accessBlockedReason,
                ...(candidate.workThreadId
                  ? { humanEscalationId: escalationId }
                  : { humanResolutionUnavailableReason: "The run has no durable WorkThread for resolution." })
              },
              visibility: "audit",
              importance: "blocking",
              message: accessBlockedReason,
              createdAt: blockedAt
            })).run();
            continue;
          }

          const requirement = directoryRequirementForRun(candidate);
          const candidateRunnerIds = requirement.mode === "explicit"
            ? new Set(requirement.explicitRunnerIds)
            : null;
          const candidateSnapshot = candidateRunnerIds
            ? {
                ...snapshot,
                registrations: snapshot.registrations.filter((registration) => candidateRunnerIds.has(registration.runnerId)),
                directory: snapshot.directory.filter((entry) => candidateRunnerIds.has(entry.runnerId))
              }
            : snapshot;
          const factoryBudget = candidate.workstreamId
            ? (() => {
                const row = tx.select({ recipeJson: factoryRecipeSnapshots.recipeJson }).from(factoryWorkstreams)
                  .innerJoin(factoryRecipeSnapshots, and(
                    eq(factoryRecipeSnapshots.id, factoryWorkstreams.recipeId),
                    eq(factoryRecipeSnapshots.version, factoryWorkstreams.recipeVersion)
                  )).where(eq(factoryWorkstreams.id, candidate.workstreamId!)).limit(1).get();
                if (!row) return null;
                try {
                  const parsed = FactoryRecipeSnapshotInputSchema.safeParse(JSON.parse(row.recipeJson));
                  return parsed.success ? parsed.data.budgets : null;
                } catch {
                  return null;
                }
              })()
            : undefined;
          if (candidate.workstreamId && !factoryBudget) {
            const blockedAt = now.toISOString();
            const invariantKey = `factory-recipe-authority:${candidate.workstreamId}`;
            tx.insert(runEvents).values({
              ...runEventValues({
                runId: candidate.id,
                type: "factory.invariant_blocked",
                payload: { workstreamId: candidate.workstreamId, invariant: "authoritative_recipe_snapshot_missing_or_invalid" },
                visibility: "audit",
                importance: "blocking",
                message: "Factory claim is blocked because its authoritative recipe snapshot is missing or invalid.",
                createdAt: blockedAt
              }),
              progressIdempotencyDigest: sha256Json({ kind: invariantKey, runId: candidate.id })
            }).onConflictDoNothing({ target: [runEvents.runId, runEvents.progressIdempotencyDigest] }).run();
            tx.insert(controlPlaneEvents).values({
              type: "factory.invariant_blocked",
              severity: "error",
              subject: candidate.workstreamId,
              idempotencyKey: `${invariantKey}:${candidate.id}`,
              payloadJson: JSON.stringify({
                workstreamId: candidate.workstreamId,
                runId: candidate.id,
                invariant: "authoritative_recipe_snapshot_missing_or_invalid"
              }),
              createdAt: blockedAt
            }).onConflictDoNothing({ target: controlPlaneEvents.idempotencyKey }).run();
            continue;
          }
          if (candidate.workstreamId && factoryBudget?.maxConcurrentRuns !== undefined) {
            const active = tx.select({ count: sql<number>`count(*)` }).from(runs)
              .where(and(eq(runs.workstreamId, candidate.workstreamId), inArray(runs.status, ["assigned", "running"]))).get()?.count ?? 0;
            if (active >= factoryBudget.maxConcurrentRuns) continue;
          }
          const routingDecision = routingDecisionForRun({
            runRow: candidate,
            now,
            snapshot: candidateSnapshot,
            event: eventForQueuedRun(candidate),
            ...(factoryBudget?.allowedLocalities ? { allowedLocalities: factoryBudget.allowedLocalities } : {})
          });
          const latest = latestRoutingEventByRun.get(candidate.id);
          const previous = latest ? RoutingDecisionSchema.safeParse(JSON.parse(latest.payloadJson)) : undefined;
          if (!previous?.success || previous.data.id !== routingDecision.id) {
            tx.insert(runEvents).values(runEventValues({
              runId: candidate.id,
              type: "routing.decided",
              payload: routingDecision,
              visibility: "audit",
              importance: routingDecision.selected ? "normal" : "blocking",
              message: routingDecision.reason,
              createdAt: routingDecision.decidedAt
            })).run();
          }
          tx.update(runs).set({ currentRoutingDecisionId: routingDecision.id, updatedAt })
            .where(and(eq(runs.id, candidate.id), eq(runs.status, "queued"))).run();
          if (routingDecision.selected?.runnerId !== input.runnerId) continue;

          const executorId = routingDecision.selected.executorId;
          const selectedRunner = registrations.find((registration) => registration.runnerId === input.runnerId);
          const authoritativeExecutorId = selectedRunner?.executors.length ? executorId : null;
          const previousAttempt = tx.select({ number: attempts.number }).from(attempts)
            .where(eq(attempts.runId, candidate.id)).orderBy(desc(attempts.number)).limit(1).get();
          const number = (previousAttempt?.number ?? 0) + 1;
          if (candidate.workstreamId) {
            const budget = factoryBudget!;
            const workstreamAttempts = tx.select({ count: sql<number>`count(*)` }).from(attempts)
              .innerJoin(runs, eq(runs.id, attempts.runId)).where(eq(runs.workstreamId, candidate.workstreamId)).get()?.count ?? 0;
            const costUnitsPerAttempt = budget.costUnitsPerAttempt ?? 0;
            const nextCostUnits = (workstreamAttempts + 1) * costUnitsPerAttempt;
            const runnerLocality = selectedRunner?.locality ?? "unknown";
            const violation = budget.maxAttemptsPerRun !== undefined && number > budget.maxAttemptsPerRun
                ? { code: "max_attempts_per_run", observed: number, limit: budget.maxAttemptsPerRun }
                : budget.maxCostUnits !== undefined && nextCostUnits > budget.maxCostUnits
                  ? { code: "max_cost_units", observed: nextCostUnits, limit: budget.maxCostUnits }
                  : null;
            if (violation) {
              const blockedAt = now.toISOString();
              const blocked = tx.update(runs).set({ status: "needs_approval", currentRoutingDecisionId: null, updatedAt: blockedAt })
                .where(and(eq(runs.id, candidate.id), eq(runs.status, "queued"))).run();
              if (blocked.changes === 1) {
                const dedupeDigest = sha256Json({ kind: "factory_budget", workstreamId: candidate.workstreamId, code: violation.code });
                tx.insert(runEvents).values({
                  ...runEventValues({
                    runId: candidate.id,
                    type: "factory.budget_blocked",
                    payload: { workstreamId: candidate.workstreamId, violation, runnerId: input.runnerId, runnerLocality },
                    visibility: "audit",
                    importance: "blocking",
                    message: `Factory workstream budget blocked this attempt: ${violation.code}.`,
                    createdAt: blockedAt
                  }),
                  progressIdempotencyDigest: dedupeDigest
                }).onConflictDoNothing({ target: [runEvents.runId, runEvents.progressIdempotencyDigest] }).run();
                if (candidate.workThreadId) {
                  tx.insert(governanceEvents).values({
                    workThreadId: candidate.workThreadId,
                    type: "factory.budget_blocked",
                    subjectId: candidate.id,
                    payloadJson: JSON.stringify({ workstreamId: candidate.workstreamId, violation }),
                    createdAt: blockedAt
                  }).run();
                }
              }
              continue;
            }
          }
          const updateResult = tx.update(runs).set({
            status: "assigned",
            assignedRunnerId: input.runnerId,
            leasedAt,
            leaseExpiresAt,
            heartbeatAt: leasedAt,
            currentAttemptId: attemptId,
            updatedAt
          }).where(and(
            eq(runs.id, candidate.id),
            eq(runs.status, "queued"),
            eq(runs.currentRoutingDecisionId, routingDecision.id)
          )).run();
          if (updateResult.changes === 0) continue;
          tx.insert(attempts).values({
            id: attemptId,
            runId: candidate.id,
            number,
            runnerId: input.runnerId,
            runnerLocality: selectedRunner?.locality ?? null,
            selectedExecutorId: authoritativeExecutorId,
            routingDecisionId: routingDecision.id,
            fencingToken,
            status: "assigned",
            startedAt: leasedAt,
            heartbeatAt: leasedAt,
            leaseExpiresAt,
            createdAt: leasedAt,
            updatedAt
          }).run();
          tx.update(runners).set({
            heartbeatAt: runnerHeartbeatAt,
            claimCursorCreatedAt: candidate.createdAt,
            claimCursorRunId: candidate.id
          }).where(eq(runners.runnerId, input.runnerId)).run();
          tx.insert(runEvents).values(runEventValues({
            runId: candidate.id,
            type: "run.claimed",
            payload: {
              runnerId: input.runnerId,
              executorId,
              routingDecisionId: routingDecision.id,
              attemptId,
              attemptNumber: number,
              leasedAt,
              leaseExpiresAt
            },
            visibility: "audit",
            importance: "normal",
            createdAt: updatedAt
          })).run();
          return { row: candidate, routingDecision, executorId, attemptNumber: number };
        }
        const lastScanned = evaluationRows.at(-1)!;
        tx.update(runners).set({
          heartbeatAt: runnerHeartbeatAt,
          claimCursorCreatedAt: lastScanned.createdAt,
          claimCursorRunId: lastScanned.id
        }).where(eq(runners.runnerId, input.runnerId)).run();
        return null;
      });
      if (!claim) return null;

      return {
        run: {
          ...runFromRow({
            ...claim.row,
            status: "assigned",
            assignedRunnerId: input.runnerId,
            currentAttemptId: attemptId,
            currentRoutingDecisionId: claim.routingDecision.id,
            updatedAt
          }),
          status: "assigned",
          assignedRunnerId: input.runnerId,
          updatedAt
        },
        event: OpenTagEventSchema.parse(JSON.parse(claim.row.eventJson)),
        attemptId,
        attemptNumber: claim.attemptNumber,
        fencingToken,
        executorId: claim.executorId,
        routingDecision: claim.routingDecision
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
        ...(row.fallbackRunnerIdsJson ? { fallbackRunnerIds: routingPreferenceIdsFromJson(row.fallbackRunnerIdsJson) } : {}),
        ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
        ...(row.defaultExecutor ? { defaultExecutor: row.defaultExecutor } : {}),
        ...(row.fallbackExecutorIdsJson ? { fallbackExecutorIds: routingPreferenceIdsFromJson(row.fallbackExecutorIdsJson) } : {}),
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

    async rejectAttemptStart(input: AttemptLease & { executorId: string; reason: string }): Promise<RejectAttemptStartOutcome> {
      const rejectedAt = nowIso();
      const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
      return db.transaction((tx) => {
        const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        if (!currentRun || !currentAttempt) return "not_found" as const;
        const alreadyRejected = routingRejectionsFromJson(currentRun.routingRejectionsJson).some(
          (rejection) => rejection.runnerId === input.runnerId && rejection.executorId === safeInput.executorId
        );
        if (alreadyRejected && currentRun.currentAttemptId !== input.attemptId) return "duplicate" as const;
        if (
          currentRun.status !== "assigned"
          || currentRun.currentAttemptId !== input.attemptId
          || currentRun.assignedRunnerId !== input.runnerId
          || currentAttempt.runId !== input.runId
          || currentAttempt.runnerId !== input.runnerId
          || currentAttempt.fencingToken !== input.fencingToken
          || currentAttempt.status !== "assigned"
          || currentAttempt.selectedExecutorId !== safeInput.executorId
          || !hasActiveAttemptLease(currentAttempt)
        ) {
          return "stale_attempt" as const;
        }
        const rejections = routingRejectionsFromJson(currentRun.routingRejectionsJson);
        rejections.push({ runnerId: input.runnerId, executorId: safeInput.executorId, reason: safeInput.reason });
        tx.update(attempts).set({
          status: "interrupted",
          finishedAt: rejectedAt,
          resultJson: JSON.stringify({ conclusion: "interrupted", summary: safeInput.reason }),
          updatedAt: rejectedAt
        }).where(eq(attempts.id, input.attemptId)).run();
        tx.update(runs).set({
          status: "queued",
          assignedRunnerId: null,
          executor: null,
          leasedAt: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          currentAttemptId: null,
          currentRoutingDecisionId: null,
          routingRejectionsJson: JSON.stringify(rejections),
          updatedAt: rejectedAt
        }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId))).run();
        tx.insert(runEvents).values(runEventValues({
          runId: input.runId,
          type: "routing.preflight_rejected",
          payload: {
            runnerId: input.runnerId,
            executorId: safeInput.executorId,
            attemptId: input.attemptId,
            routingDecisionId: currentAttempt.routingDecisionId,
            reason: safeInput.reason
          },
          visibility: "audit",
          importance: "blocking",
          message: safeInput.reason,
          createdAt: rejectedAt
        })).run();
        return "requeued" as const;
      });
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
                (currentAttempt.selectedExecutorId !== null && currentAttempt.selectedExecutorId !== safeInput.executor) ||
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

    async completeHostedRunLocally(input: {
      runId: string;
      result: OpenTagRunResult;
      humanEscalation?: HumanEscalation;
      runnerId: string;
      attemptId: string;
      fencingToken: string;
      idempotencyKey?: string;
      destinationId: string;
      organizationId: string;
      credentialId: string;
      request: HostedCompleteRequestV1;
    }): Promise<CompleteRunOutcome> {
      const request = HostedCompleteRequestV1Schema.parse(input.request);
      const requestDigest = await computeHostedLifecycleRequestDigestV1({
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        runId: input.runId,
        action: "complete",
        request
      });
      const requestId = await computeHostedLifecycleRequestIdV1({
        operationId: request.operationId,
        requestDigest: request.requestDigest
      });
      const operationId = computeHostedLifecycleOperationIdV1(
        request.requestDigest,
      );
      if (
        request.requestDigest !== requestDigest
        || request.requestId !== requestId
        || request.operationId !== operationId
        || request.attempt.attemptId !== input.attemptId
        || await computeHostedClaimFencingTokenDigestV1(input.fencingToken)
          !== request.attempt.fencingTokenDigest
      ) throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
      return completeRunWithHostedLifecycle({
        runId: input.runId,
        result: input.result,
        ...(input.humanEscalation ? { humanEscalation: input.humanEscalation } : {}),
        runnerId: input.runnerId,
        attemptId: input.attemptId,
        fencingToken: input.fencingToken,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }, {
          destinationId: input.destinationId,
          organizationId: input.organizationId,
          runnerId: input.runnerId,
          credentialId: input.credentialId,
          request,
          requestJson: canonicalJsonStringify(request),
          businessKeyDigest: canonicalSha256Json({
            destinationId: input.destinationId,
            organizationId: input.organizationId,
            runnerId: input.runnerId,
            credentialId: input.credentialId,
            runId: input.runId,
            attemptId: request.attempt.attemptId,
            attemptNumber: request.attempt.attemptNumber,
            action: "complete",
            discriminator: "single_action_per_attempt"
          })
        }
      );
    },

    completeRun: (() => {
      const completeRunInternal = async (
        input: CompleteRunInput,
        hostedLifecycleOperation?: HostedCompletionLifecycleOperation,
      ): Promise<CompleteRunOutcome> => {
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
                id: artifact.id ?? runResultArtifactId(input.runId, index),
                sourceRunId: input.runId,
                createdAt: artifact.createdAt ?? updatedAt
              }))
            }
          : {})
      });
      if (
        hostedLifecycleOperation
        && hostedLifecycleOperation.request.resultDigest
          !== await computeControlPayloadDigestV1(result)
      ) {
        throw new HostedLifecycleOperationConflictError(
          "HOSTED_LIFECYCLE_OPERATION_INVALID",
        );
      }
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
      let hasExactHostedLifecycleReplay = false;
      if (hostedLifecycleOperation) {
        const lifecycle = hostedLifecycleOperation;
        const request = lifecycle.request;
        const [attempt, importedAttempt] = await Promise.all([
          db.select().from(attempts).where(eq(attempts.id, input.attemptId!)).limit(1).get(),
          db.select().from(hostedAttemptImports)
            .where(eq(hostedAttemptImports.attemptId, input.attemptId!)).limit(1).get(),
        ]);
        if (
          !attempt
          || !importedAttempt
          || attempt.number !== request.attempt.attemptNumber
          || importedAttempt.attemptNumber !== request.attempt.attemptNumber
          || request.attempt.epoch !== request.attempt.attemptNumber
        ) {
          throw new HostedLifecycleOperationConflictError(
            "HOSTED_LIFECYCLE_OPERATION_INVALID",
          );
        }
        const existing = await db.select().from(hostedLifecycleOperations).where(or(
          and(
            eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
            eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
            eq(hostedLifecycleOperations.runnerId, lifecycle.runnerId),
            eq(hostedLifecycleOperations.credentialId, lifecycle.credentialId),
            eq(hostedLifecycleOperations.operationId, request.operationId)
          ),
          and(
            eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
            eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
            eq(hostedLifecycleOperations.runnerId, lifecycle.runnerId),
            eq(hostedLifecycleOperations.credentialId, lifecycle.credentialId),
            eq(hostedLifecycleOperations.requestId, request.requestId)
          ),
          and(
            eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
            eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
            eq(hostedLifecycleOperations.runnerId, lifecycle.runnerId),
            eq(hostedLifecycleOperations.credentialId, lifecycle.credentialId),
            eq(hostedLifecycleOperations.businessKeyDigest, lifecycle.businessKeyDigest)
          )
        )).limit(1).get();
        if (existing) {
          hasExactHostedLifecycleReplay = existing.requestId === request.requestId
            && existing.action === "complete"
            && existing.runId === input.runId
            && existing.attemptId === request.attempt.attemptId
            && existing.attemptNumber === request.attempt.attemptNumber
            && existing.fencingTokenDigest === request.attempt.fencingTokenDigest
            && existing.requestDigest === request.requestDigest
            && existing.businessKeyDigest === lifecycle.businessKeyDigest
            && existing.requestJson === lifecycle.requestJson;
          if (!hasExactHostedLifecycleReplay) {
            throw new HostedLifecycleOperationConflictError(
              "HOSTED_LIFECYCLE_OPERATION_CONFLICT",
            );
          }
        }
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
          if (
            duplicateTerminalAttempt
            && hostedLifecycleOperation
            && !hasExactHostedLifecycleReplay
          ) {
            throw new HostedLifecycleOperationConflictError(
              "HOSTED_LIFECYCLE_OPERATION_CONFLICT",
            );
          }
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
        if (hostedLifecycleOperation && !hasExactHostedLifecycleReplay) {
          throw new HostedLifecycleOperationConflictError(
            "HOSTED_LIFECYCLE_OPERATION_CONFLICT",
          );
        }
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
            if (hostedLifecycleOperation) {
              const lifecycle = hostedLifecycleOperation;
              const request = lifecycle.request;
              const existing = tx.select().from(hostedLifecycleOperations).where(or(
                and(
                  eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
                  eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
                  eq(hostedLifecycleOperations.runnerId, lifecycle.runnerId),
                  eq(hostedLifecycleOperations.credentialId, lifecycle.credentialId),
                  eq(hostedLifecycleOperations.operationId, request.operationId)
                ),
                and(
                  eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
                  eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
                  eq(hostedLifecycleOperations.runnerId, lifecycle.runnerId),
                  eq(hostedLifecycleOperations.credentialId, lifecycle.credentialId),
                  eq(hostedLifecycleOperations.requestId, request.requestId)
                ),
                and(
                  eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
                  eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
                  eq(hostedLifecycleOperations.runnerId, lifecycle.runnerId),
                  eq(hostedLifecycleOperations.credentialId, lifecycle.credentialId),
                  eq(hostedLifecycleOperations.businessKeyDigest, lifecycle.businessKeyDigest)
                )
              )).limit(1).get();
              const exact = existing
                && existing.requestId === request.requestId
                && existing.action === "complete"
                && existing.runId === input.runId
                && existing.attemptId === request.attempt.attemptId
                && existing.attemptNumber === request.attempt.attemptNumber
                && existing.fencingTokenDigest === request.attempt.fencingTokenDigest
                && existing.requestDigest === request.requestDigest
                && existing.businessKeyDigest === lifecycle.businessKeyDigest
                && existing.requestJson === lifecycle.requestJson;
              if (!exact) {
                throw new HostedLifecycleOperationConflictError(
                  "HOSTED_LIFECYCLE_OPERATION_CONFLICT",
                );
              }
            }
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
          tx.insert(reassessmentObligations)
            .values(humanEscalationReassessmentObligation(effectiveEscalation, updatedAt))
            .onConflictDoNothing()
            .run();
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
        if (currentRun.workThreadId) {
          tx.insert(reassessmentObligations).values(reassessmentObligationValues({
            workThreadId: currentRun.workThreadId,
            sourceKind: "run_result_recorded",
            sourceId: input.runId,
            sourceDigest: canonicalSha256Json(completedResult),
            notBefore: updatedAt,
            createdAt: updatedAt
          })).onConflictDoNothing().run();
        }
        if (hostedLifecycleOperation) {
          const lifecycle = hostedLifecycleOperation;
          const request = lifecycle.request;
          const existing = tx.select().from(hostedLifecycleOperations).where(or(
            and(
              eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
              eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
              eq(hostedLifecycleOperations.runnerId, lifecycle.runnerId),
              eq(hostedLifecycleOperations.credentialId, lifecycle.credentialId),
              eq(hostedLifecycleOperations.operationId, request.operationId)
            ),
            and(
              eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
              eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
              eq(hostedLifecycleOperations.runnerId, lifecycle.runnerId),
              eq(hostedLifecycleOperations.credentialId, lifecycle.credentialId),
              eq(hostedLifecycleOperations.requestId, request.requestId)
            ),
            and(
              eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
              eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
              eq(hostedLifecycleOperations.runnerId, lifecycle.runnerId),
              eq(hostedLifecycleOperations.credentialId, lifecycle.credentialId),
              eq(hostedLifecycleOperations.businessKeyDigest, lifecycle.businessKeyDigest)
            )
          )).limit(1).get();
          if (existing) {
            const exact = existing.requestId === request.requestId
              && existing.action === "complete"
              && existing.runId === input.runId
              && existing.attemptId === request.attempt.attemptId
              && existing.attemptNumber === request.attempt.attemptNumber
              && existing.fencingTokenDigest === request.attempt.fencingTokenDigest
              && existing.requestDigest === request.requestDigest
              && existing.businessKeyDigest === lifecycle.businessKeyDigest
              && existing.requestJson === lifecycle.requestJson;
            if (!exact) throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_CONFLICT");
          } else {
            const terminal = tx.select({ operationId: hostedLifecycleOperations.operationId })
              .from(hostedLifecycleOperations).where(and(
                eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
                eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
                eq(hostedLifecycleOperations.runId, input.runId),
                eq(hostedLifecycleOperations.attemptId, request.attempt.attemptId),
                inArray(hostedLifecycleOperations.action, ["complete", "reject-start"])
              )).limit(1).get();
            if (terminal) {
              throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_CONFLICT");
            }
            const sequenceRow = tx.select({
              value: sql<number>`coalesce(max(${hostedLifecycleOperations.sequence}), 0)`
            }).from(hostedLifecycleOperations).where(and(
              eq(hostedLifecycleOperations.destinationId, lifecycle.destinationId),
              eq(hostedLifecycleOperations.organizationId, lifecycle.organizationId),
              eq(hostedLifecycleOperations.runId, input.runId),
              eq(hostedLifecycleOperations.attemptId, request.attempt.attemptId)
            )).get();
            tx.insert(hostedLifecycleOperations).values({
              destinationId: lifecycle.destinationId,
              organizationId: lifecycle.organizationId,
              runnerId: lifecycle.runnerId,
              credentialId: lifecycle.credentialId,
              operationId: request.operationId,
              requestId: request.requestId,
              action: "complete",
              runId: input.runId,
              attemptId: request.attempt.attemptId,
              attemptNumber: request.attempt.attemptNumber,
              fencingTokenDigest: request.attempt.fencingTokenDigest,
              requestDigest: request.requestDigest,
              businessKeyDigest: lifecycle.businessKeyDigest,
              sequence: Number(sequenceRow?.value ?? 0) + 1,
              requestJson: lifecycle.requestJson,
              state: "pending",
              attemptCount: 0,
              nextAttemptAt: updatedAt,
              createdAt: updatedAt,
              updatedAt
            }).run();
          }
        }
        return "completed" as const;
      });
      if (completionOutcome !== "completed") return completionOutcome;
      return "completed";
      };
      completeRunWithHostedLifecycle = (input, lifecycle) =>
        completeRunInternal(input, lifecycle);
      return (input: CompleteRunInput) => completeRunInternal(input);
    })(),

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
        if (run.workThreadId) {
          tx.insert(reassessmentObligations).values(reassessmentObligationValues({
            workThreadId: run.workThreadId,
            sourceKind: "material_action_receipt_recorded",
            sourceId: input.actionId,
            sourceDigest: canonicalSha256Json(receipt),
            notBefore: updatedAt,
            createdAt: updatedAt
          })).onConflictDoNothing().run();
        }
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
        const run = tx.select({ workThreadId: runs.workThreadId }).from(runs)
          .where(eq(runs.id, row.runId)).limit(1).get();
        if (run?.workThreadId) {
          tx.insert(reassessmentObligations).values(reassessmentObligationValues({
            workThreadId: run.workThreadId,
            sourceKind: "material_action_reconciled",
            sourceId: input.actionId,
            sourceDigest: canonicalSha256Json(receipt),
            notBefore: updatedAt,
            createdAt: updatedAt
          })).onConflictDoNothing().run();
        }
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
      idempotencyKey?: string;
      payload?: unknown;
      createdAt?: string;
    }): Promise<"recorded" | "duplicate"> {
      const inserted = await db.insert(controlPlaneEvents).values({
        type: input.type,
        severity: input.severity ?? "info",
        subject: input.subject ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt: input.createdAt ?? nowIso()
      }).onConflictDoNothing({ target: controlPlaneEvents.idempotencyKey });
      return inserted.changes === 1 ? "recorded" : "duplicate";
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

    async getGovernedCallbackEnqueueContext(input: {
      runId: string;
      assessmentId: string;
    }): Promise<GetGovernedCallbackEnqueueContextResult> {
      return db.transaction((tx) => {
        const importedRun = tx.select().from(hostedRunImports)
          .where(eq(hostedRunImports.runId, input.runId)).all();
        const assessmentRows = tx.select().from(completionAssessments)
          .where(eq(completionAssessments.id, input.assessmentId)).all();
        if (importedRun.length === 0) {
          return { outcome: "not_found" } as const;
        }
        if (importedRun.length !== 1 || assessmentRows.length !== 1) {
          return { outcome: "authority_conflict" } as const;
        }

        const imported = importedRun[0]!;
        const assessmentRow = assessmentRows[0]!;
        try {
          if (!imported.workThreadId) governedCallbackEnqueueConflict();
          const runRows = tx.select().from(runs).where(and(
            eq(runs.id, input.runId),
            eq(runs.workThreadId, imported.workThreadId)
          )).all();
          const threadRows = tx.select().from(workThreads).where(and(
            eq(workThreads.id, imported.workThreadId),
            eq(workThreads.currentAssessmentId, input.assessmentId)
          )).all();
          const attemptRows = tx.select().from(hostedAttemptImports).where(and(
            eq(hostedAttemptImports.attemptId, imported.attemptId),
            eq(hostedAttemptImports.runId, imported.runId),
            eq(hostedAttemptImports.claimOperationId, imported.claimOperationId),
            eq(hostedAttemptImports.fencingTokenDigest, imported.fencingTokenDigest)
          )).all();
          if (runRows.length !== 1 || threadRows.length !== 1 || attemptRows.length !== 1) {
            governedCallbackEnqueueConflict();
          }
          const run = runRows[0]!;
          const importedAttempt = attemptRows[0]!;
          const authority = governedCallbackEnqueueAuthorityFromJson(imported.authorityJson);
          const actualAttemptRows = tx.select().from(attempts).where(and(
            eq(attempts.id, authority.attemptId),
            eq(attempts.runId, authority.runId)
          )).all();
          if (actualAttemptRows.length !== 1) governedCallbackEnqueueConflict();
          const actualAttempt = actualAttemptRows[0]!;
          const actualFencingTokenDigest = `sha256:${createHash("sha256")
            .update(actualAttempt.fencingToken)
            .digest("hex")}`;
          const claimRows = tx.select().from(hostedClaimOperations).where(and(
            eq(hostedClaimOperations.operationId, imported.claimOperationId),
            eq(hostedClaimOperations.organizationId, authority.organizationId),
            eq(hostedClaimOperations.runnerId, authority.runnerId),
            eq(hostedClaimOperations.runId, imported.runId),
            eq(hostedClaimOperations.credentialId, authority.credentialId),
            eq(hostedClaimOperations.attemptId, imported.attemptId),
            eq(hostedClaimOperations.attemptNumber, importedAttempt.attemptNumber),
            eq(hostedClaimOperations.fencingTokenDigest, imported.fencingTokenDigest),
            eq(hostedClaimOperations.state, "claimed"),
            isNotNull(hostedClaimOperations.executionStartedAt),
            isNull(hostedClaimOperations.terminalReasonCode)
          )).all();
          if (claimRows.length !== 1) governedCallbackEnqueueConflict();
          const claim = claimRows[0]!;
          const completionRows = tx.select().from(hostedLifecycleOperations).where(and(
            eq(hostedLifecycleOperations.destinationId, claim.destinationId),
            eq(hostedLifecycleOperations.organizationId, authority.organizationId),
            eq(hostedLifecycleOperations.runnerId, authority.runnerId),
            eq(hostedLifecycleOperations.credentialId, authority.credentialId),
            eq(hostedLifecycleOperations.action, "complete"),
            eq(hostedLifecycleOperations.runId, imported.runId),
            eq(hostedLifecycleOperations.attemptId, imported.attemptId),
            eq(hostedLifecycleOperations.attemptNumber, importedAttempt.attemptNumber),
            eq(hostedLifecycleOperations.fencingTokenDigest, imported.fencingTokenDigest),
            eq(hostedLifecycleOperations.state, "acknowledged")
          )).all();
          if (completionRows.length !== 1) {
            governedCallbackEnqueueConflict();
          }
          const completion = completionRows[0]!;
          if (!validAcknowledgedLifecycleDependency(completion)) {
            governedCallbackEnqueueConflict();
          }

          const projectionIdentity = {
            namespace: "opentag.control.receipt/completion-assessment/v1",
            parts: [authority.organizationId, imported.workThreadId, input.assessmentId]
          };
          const projectionRows = tx.select().from(controlPlaneProjectionOutbox).where(and(
            eq(controlPlaneProjectionOutbox.destinationId, claim.destinationId),
            eq(controlPlaneProjectionOutbox.organizationId, authority.organizationId),
            eq(controlPlaneProjectionOutbox.runId, imported.runId),
            eq(controlPlaneProjectionOutbox.workThreadId, imported.workThreadId),
            eq(controlPlaneProjectionOutbox.receiptKind, "completion_assessment"),
            eq(controlPlaneProjectionOutbox.identityKey,
              canonicalSha256Json(projectionIdentity))
          )).all();
          if (projectionRows.length !== 1) {
            governedCallbackEnqueueConflict();
          }
          const projection = governedCallbackEnqueueProjectionFromRow(projectionRows[0]!);
          if (projection.envelope.receiptKind !== "completion_assessment") {
            governedCallbackEnqueueConflict();
          }
          const envelope = projection.envelope;
          const assessment = parseGovernedCallbackEnqueueSchema(
            CompletionAssessmentSchema,
            assessmentRow.assessmentJson
          );
          const completionRequest = parseGovernedCallbackEnqueueSchema(
            HostedCompleteRequestV1Schema,
            completion.requestJson
          );
          const completionReceipt = parseGovernedCallbackEnqueueSchema(
            HostedLifecycleReceiptEnvelopeV1Schema,
            completion.receiptJson!
          );
          if (!run.resultJson || !actualAttempt.resultJson) {
            governedCallbackEnqueueConflict();
          }
          const runResult = parseGovernedCallbackEnqueueSchema(
            OpenTagRunResultSchema,
            run.resultJson
          );
          const attemptResult = parseGovernedCallbackEnqueueSchema(
            OpenTagRunResultSchema,
            actualAttempt.resultJson
          );
          const expectedRunStatus = runResult.conclusion === "success"
            ? "succeeded"
            : runResult.conclusion === "failure"
              ? "failed"
              : runResult.conclusion === "needs_human"
                ? "needs_approval"
                : runResult.conclusion;
          const expectedAttemptStatus = runResult.conclusion === "success"
            ? "succeeded"
            : runResult.conclusion === "failure"
              ? "failed"
              : runResult.conclusion === "needs_human"
                ? "needs_human"
                : runResult.conclusion;
          const executorResultRef = envelope.payload.executorResultReceiptRef;
          if (
            assessmentRow.workThreadId !== imported.workThreadId
            || actualAttempt.runId !== authority.runId
            || actualAttempt.runnerId !== authority.runnerId
            || actualAttempt.number !== authority.attemptNumber
            || actualFencingTokenDigest !== authority.fencingTokenDigest
            || !releasedTerminalAttemptMatchesRun(actualAttempt, run)
            || run.status !== expectedRunStatus
            || actualAttempt.status !== expectedAttemptStatus
            || completionRequest.conclusion !== runResult.conclusion
            || canonicalJsonStringify(runResult) !== canonicalJsonStringify(attemptResult)
            || canonicalSha256Json(runResult) !== completionRequest.resultDigest
            || canonicalSha256Json(attemptResult) !== completionRequest.resultDigest
            || assessment.id !== input.assessmentId
            || assessment.workThreadId !== imported.workThreadId
            || assessment.triggeredByRunId !== imported.runId
            || imported.authorityJson !== importedAttempt.authorityJson
            || imported.authorityJson !== claim.authorityJson
            || imported.authorityDigest !== importedAttempt.authorityDigest
            || imported.authorityDigest !== claim.authorityDigest
            || imported.claimDigest !== importedAttempt.claimDigest
            || imported.claimDigest !== claim.claimDigest
            || canonicalSha256Json(authority) !== imported.authorityDigest
            || authority.organizationId !== claim.organizationId
            || authority.runnerId !== claim.runnerId
            || authority.runId !== imported.runId
            || authority.credentialId !== claim.credentialId
            || authority.attemptId !== imported.attemptId
            || authority.attemptNumber !== importedAttempt.attemptNumber
            || authority.epoch !== importedAttempt.attemptNumber
            || authority.fencingTokenDigest !== imported.fencingTokenDigest
            || projection.destinationId !== claim.destinationId
            || projection.organizationId !== authority.organizationId
            || projection.runId !== imported.runId
            || projection.workThreadId !== imported.workThreadId
            || projection.requiresLifecycleOperationId !== completion.operationId
            || envelope.payload.assessmentId !== input.assessmentId
            || envelope.organizationId !== authority.organizationId
            || envelope.runId !== imported.runId
            || envelope.workThreadId !== imported.workThreadId
            || envelope.producer.kind !== "local_opentag"
            || envelope.producer.credentialId !== authority.credentialId
            || envelope.producer.registrationGeneration
              !== authority.registrationGeneration
            || envelope.attempt.attemptId !== authority.attemptId
            || envelope.attempt.attemptNumber !== authority.attemptNumber
            || envelope.attempt.epoch !== authority.epoch
            || envelope.attempt.fencingTokenDigest !== authority.fencingTokenDigest
            || envelope.payload.workThreadId !== imported.workThreadId
            || envelope.payload.runId !== imported.runId
            || envelope.payload.attempt.attemptId !== authority.attemptId
            || envelope.payload.attempt.attemptNumber !== authority.attemptNumber
            || envelope.payload.attempt.epoch !== authority.epoch
            || envelope.payload.attempt.fencingTokenDigest !== authority.fencingTokenDigest
            || envelope.payload.admissionPolicySnapshot.snapshotId
              !== authority.admissionPolicySnapshotId
            || envelope.payload.admissionPolicySnapshot.digest
              !== authority.admissionPolicySnapshotDigest
            || envelope.payload.contract.contractId !== assessment.contractId
            || envelope.payload.contract.version !== assessment.contractVersion
            || envelope.payload.contract.cycle !== assessment.cycle
            || envelope.payload.assessmentInputDigest !== assessment.inputDigest
            || envelope.payload.conclusion !== assessment.state
            || envelope.payload.assessedAt !== assessment.assessedAt
            || envelope.payload.assessedBy !== (assessment.assessedBy === "opentag"
              ? "local_opentag"
              : "human")
            || (envelope.payload.supersedesAssessmentId ?? null)
              !== (assessment.supersedesAssessmentId ?? null)
            || executorResultRef.receiptId !== completionReceipt.receiptId
            || executorResultRef.operationId !== completion.operationId
            || executorResultRef.requestId !== completion.requestId
            || executorResultRef.requestDigest !== completion.requestDigest
            || executorResultRef.resultDigest !== completionRequest.resultDigest
            || !envelope.predecessorReceiptDigests?.includes(completionReceipt.receiptDigest)
          ) governedCallbackEnqueueConflict();

          return {
            outcome: "ready",
            destinationId: claim.destinationId,
            organizationId: authority.organizationId,
            runnerId: authority.runnerId,
            producer: envelope.producer,
            sourceThreadIdentityDigest: imported.sourceIdentityDigest,
            assessmentReceipt: envelope,
            completionOperationId: completion.operationId,
            authority: {
              attemptId: authority.attemptId,
              attemptNumber: authority.attemptNumber,
              epoch: authority.epoch,
              fencingTokenDigest: authority.fencingTokenDigest,
              admissionId: imported.admissionId,
              admissionOperationId: imported.admissionOperationId,
              claimOperationId: imported.claimOperationId
            }
          } as const;
        } catch (error) {
          if (error instanceof GovernedCallbackEnqueueValidationError) {
            return { outcome: "authority_conflict" } as const;
          }
          throw error;
        }
      });
    },

    async listGovernedCallbackScopes(): Promise<GovernedCallbackScope[]> {
      const rows = await db.select({
        destinationId: governedCallbackIntents.destinationId,
        organizationId: governedCallbackIntents.organizationId
      }).from(governedCallbackIntents).where(
        inArray(governedCallbackIntents.state, ["pending", "leased", "sending"])
      );
      return [...new Map(rows.map((row) => [
        `${row.destinationId}\u0000${row.organizationId}`,
        row
      ])).values()].sort((left, right) =>
        left.destinationId.localeCompare(right.destinationId)
        || left.organizationId.localeCompare(right.organizationId));
    },

    async enqueueGovernedCallbackIntent(input: {
      destinationId: string;
      runnerId: string;
      idempotencyKey: string;
      delivery: {
        provider: "github";
        mode: CallbackDeliveryKind;
        target: string;
        body: string;
        threadKey?: string;
        agentId?: string;
        statusMessageKey?: string;
        blocks?: unknown[];
        rich?: unknown;
      };
      completionOperationId: string;
      authority: {
        attemptId: string;
        attemptNumber: number;
        epoch: number;
        fencingTokenDigest: string;
        admissionId: string;
        admissionOperationId: string;
        claimOperationId: string;
      };
      receipt: typeof CallbackIntentObservationReceiptEnvelopeV1Schema._output;
      now?: Date;
    }): Promise<{ outcome: "created" | "replayed"; intent: GovernedCallbackIntent }> {
      const receipt = validateCallbackProjectionEnvelope(
        CallbackIntentObservationReceiptEnvelopeV1Schema,
        input.receipt
      );
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.idempotencyKey)
        || input.authority.epoch !== input.authority.attemptNumber
        || input.delivery.provider !== "github"
        || receipt.payload.provider !== "github"
      ) throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_INVALID");
      let githubTarget: Awaited<ReturnType<typeof parseGitHubIssueCommentsTargetV1>>;
      try {
        githubTarget = await parseGitHubIssueCommentsTargetV1(
          input.delivery.target,
          input.delivery.threadKey
        );
      } catch {
        throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_INVALID");
      }
      const safeDelivery = sanitizeCredentialLikeValue({
        target: input.delivery.target,
        body: input.delivery.body,
        ...(input.delivery.threadKey ? { threadKey: input.delivery.threadKey } : {}),
        ...(input.delivery.agentId ? { agentId: input.delivery.agentId } : {}),
        ...(input.delivery.statusMessageKey ? { statusMessageKey: input.delivery.statusMessageKey } : {}),
        ...(input.delivery.blocks ? { blocks: input.delivery.blocks } : {}),
        ...(input.delivery.rich !== undefined ? { rich: input.delivery.rich } : {})
      });
      const deliveryMetadataJson = canonicalJsonStringify({
        ...(safeDelivery.agentId ? { agentId: safeDelivery.agentId } : {}),
        ...(safeDelivery.statusMessageKey ? { statusMessageKey: safeDelivery.statusMessageKey } : {}),
        ...(safeDelivery.blocks ? { blocks: safeDelivery.blocks } : {}),
        ...(safeDelivery.rich !== undefined ? { rich: safeDelivery.rich } : {})
      });
      const payloadDigest = canonicalSha256Json({
        method: "POST",
        mode: input.delivery.mode,
        target: safeDelivery.target,
        body: safeDelivery.body,
        threadKey: safeDelivery.threadKey ?? null,
        agentId: safeDelivery.agentId ?? null,
        statusMessageKey: safeDelivery.statusMessageKey ?? null,
        blocks: safeDelivery.blocks ?? null,
        rich: safeDelivery.rich ?? null
      });
      if (payloadDigest !== receipt.payload.payloadDigest) {
        throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_INVALID");
      }
      const createdAt = (input.now ?? new Date()).toISOString();
      const receiptJson = canonicalJsonStringify(receipt);
      return db.transaction((tx) => {
        const assessmentProjection = tx.select().from(controlPlaneProjectionOutbox).where(and(
          eq(controlPlaneProjectionOutbox.destinationId, input.destinationId),
          eq(controlPlaneProjectionOutbox.organizationId, receipt.organizationId),
          eq(controlPlaneProjectionOutbox.workThreadId, receipt.workThreadId),
          eq(controlPlaneProjectionOutbox.receiptKind, "completion_assessment"),
          eq(controlPlaneProjectionOutbox.receiptDigest, receipt.payload.assessmentDigest)
        )).limit(1).get();
        let assessmentEnvelope: CompletionAssessmentReceiptEnvelopeV1;
        try {
          if (!assessmentProjection) throw new Error("assessment projection missing");
          assessmentEnvelope = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
            JSON.parse(assessmentProjection.envelopeJson)
          );
          assertProjectionCustodySafe(assessmentEnvelope);
          assertProjectionDigests(assessmentEnvelope);
          if (
            assessmentEnvelope.receiptId !== assessmentProjection.receiptId
            || assessmentEnvelope.receiptDigest !== receipt.payload.assessmentDigest
            || assessmentEnvelope.payload.assessmentId !== receipt.payload.assessmentRef
          ) throw new Error("assessment projection mismatch");
        } catch {
          throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_AUTHORITY_CONFLICT");
        }
        const deliveryIdempotencyKey = `governed:${canonicalSha256Json({
          destinationId: input.destinationId,
          organizationId: receipt.organizationId,
          localIntentId: receipt.payload.localIntentId,
          idempotencyKey: input.idempotencyKey
        })}`;
        tx.insert(callbackDeliveries).values({
          runId: receipt.runId,
          kind: input.delivery.mode,
          provider: input.delivery.provider,
          uri: safeDelivery.target,
          body: safeDelivery.body,
          threadKey: safeDelivery.threadKey ?? null,
          idempotencyKey: deliveryIdempotencyKey,
          metadataJson: deliveryMetadataJson,
          dispatchMode: "governed",
          governedState: "pending",
          status: "pending",
          createdAt,
          updatedAt: createdAt
        }).onConflictDoNothing({ target: callbackDeliveries.idempotencyKey }).run();
        const governedDelivery = tx.select().from(callbackDeliveries).where(
          eq(callbackDeliveries.idempotencyKey, deliveryIdempotencyKey)
        ).limit(1).get();
        if (
          !governedDelivery
          || governedDelivery.dispatchMode !== "governed"
          || governedDelivery.runId !== receipt.runId
          || governedDelivery.kind !== input.delivery.mode
          || governedDelivery.provider !== input.delivery.provider
          || governedDelivery.uri !== safeDelivery.target
          || governedDelivery.body !== safeDelivery.body
          || governedDelivery.threadKey !== (safeDelivery.threadKey ?? null)
          || governedDelivery.metadataJson !== deliveryMetadataJson
          || governedCallbackPayloadDigest(governedDelivery) !== receipt.payload.payloadDigest
        ) throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_CONFLICT");
        const existing = tx.select().from(governedCallbackIntents).where(or(
          eq(governedCallbackIntents.localIntentId, receipt.payload.localIntentId),
          and(
            eq(governedCallbackIntents.destinationId, input.destinationId),
            eq(governedCallbackIntents.organizationId, receipt.organizationId),
            eq(governedCallbackIntents.idempotencyKey, input.idempotencyKey)
          ),
          and(
            eq(governedCallbackIntents.destinationId, input.destinationId),
            eq(governedCallbackIntents.organizationId, receipt.organizationId),
            eq(governedCallbackIntents.operationId, receipt.operationId)
          )
        )).limit(1).get();
        if (existing) {
          const exact = existing.destinationId === input.destinationId
            && existing.organizationId === receipt.organizationId
            && existing.runnerId === input.runnerId
            && existing.idempotencyKey === input.idempotencyKey
            && existing.localIntentId === receipt.payload.localIntentId
            && existing.runId === receipt.runId
            && existing.workThreadId === receipt.workThreadId
            && existing.runAttemptId === input.authority.attemptId
            && existing.runAttemptNumber === input.authority.attemptNumber
            && existing.fencingTokenDigest === input.authority.fencingTokenDigest
            && existing.admissionId === input.authority.admissionId
            && existing.admissionOperationId === input.authority.admissionOperationId
            && existing.claimOperationId === input.authority.claimOperationId
            && existing.completionOperationId === input.completionOperationId
            && existing.assessmentReceiptId === assessmentEnvelope.receiptId
            && existing.assessmentReceiptDigest === assessmentEnvelope.receiptDigest
            && existing.localDeliveryId === governedDelivery.id
            && existing.payloadDigest === receipt.payload.payloadDigest
            && existing.targetIdentityDigest === githubTarget.targetIdentityDigest
            && existing.intentReceiptDigest === receipt.receiptDigest
            && existing.intentReceiptJson === receiptJson;
          if (!exact) throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_CONFLICT");
          return { outcome: "replayed" as const, intent: governedCallbackIntentFromRow(existing) };
        }
        const authorityRow = {
          localIntentId: receipt.payload.localIntentId,
          idempotencyKey: input.idempotencyKey,
          destinationId: input.destinationId,
          organizationId: receipt.organizationId,
          runnerId: input.runnerId,
          producerId: receipt.producer.id,
          credentialId: receipt.producer.credentialId,
          registrationGeneration: receipt.producer.registrationGeneration,
          runId: receipt.runId,
          workThreadId: receipt.workThreadId,
          runAttemptId: input.authority.attemptId,
          runAttemptNumber: input.authority.attemptNumber,
          fencingTokenDigest: input.authority.fencingTokenDigest,
          admissionId: input.authority.admissionId,
          admissionOperationId: input.authority.admissionOperationId,
          claimOperationId: input.authority.claimOperationId,
          completionOperationId: input.completionOperationId,
          assessmentReceiptId: assessmentEnvelope.receiptId,
          assessmentReceiptDigest: assessmentEnvelope.receiptDigest,
          localDeliveryId: governedDelivery.id,
          provider: receipt.payload.provider,
          operationId: receipt.operationId,
          payloadDigest: receipt.payload.payloadDigest,
          intentReceiptId: receipt.receiptId,
          intentReceiptDigest: receipt.receiptDigest,
          intentReceiptJson: receiptJson,
          targetIdentityDigest: githubTarget.targetIdentityDigest,
          state: "pending",
          currentAttemptId: `callback_attempt_${canonicalSha256Json({
            localIntentId: receipt.payload.localIntentId,
            attemptNumber: 1,
            payloadDigest: receipt.payload.payloadDigest
          }).slice("sha256:".length)}`,
          currentAttemptNumber: 1,
          nextAttemptAt: createdAt,
          createdAt,
          updatedAt: createdAt
        };
        tx.insert(governedCallbackIntents).values(authorityRow).run();
        tx.insert(governedCallbackAttempts).values({
          localAttemptId: authorityRow.currentAttemptId,
          localIntentId: receipt.payload.localIntentId,
          attemptNumber: 1,
          requestDigest: canonicalSha256Json({
            localIntentId: receipt.payload.localIntentId,
            attemptNumber: 1,
            payloadDigest: receipt.payload.payloadDigest,
            runId: receipt.runId,
            runAttemptId: input.authority.attemptId,
            fencingTokenDigest: input.authority.fencingTokenDigest
          }),
          state: "pending",
          createdAt,
          updatedAt: createdAt
        }).run();
        const created = tx.select().from(governedCallbackIntents)
          .where(eq(governedCallbackIntents.localIntentId, receipt.payload.localIntentId))
          .limit(1).get();
        if (!created) throw new Error("governed_callback_intent_insert_lost");
        assertGovernedCallbackAuthorityTx(tx, created);
        const importedAuthority = tx.select().from(hostedRunImports)
          .where(eq(hostedRunImports.runId, created.runId)).limit(1).get();
        if (importedAuthority?.sourceIdentityDigest !== receipt.payload.sourceThreadIdentityDigest) {
          throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_AUTHORITY_CONFLICT");
        }
        assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
          destinationId: input.destinationId,
          envelope: receipt,
          dependsOnReceiptId: assessmentEnvelope.receiptId,
          requiresLifecycleOperationId: input.completionOperationId,
          ...(input.now ? { now: input.now } : {})
        }));
        tx.insert(runEvents).values(runEventValues({
          runId: receipt.runId,
          type: "callback.governed.intent_queued",
          payload: {
            localIntentId: receipt.payload.localIntentId,
            provider: "github",
            payloadDigest: receipt.payload.payloadDigest,
            intentReceiptId: receipt.receiptId
          },
          visibility: "audit",
          importance: "normal",
          createdAt
        })).run();
        return { outcome: "created" as const, intent: governedCallbackIntentFromRow(created) };
      }, { behavior: "immediate" });
    },

    async claimGovernedCallbackIntents(input: {
      destinationId: string;
      organizationId: string;
      leaseOwner: string;
      leaseSeconds: number;
      limit?: number;
      now?: Date;
    }): Promise<ClaimedGovernedCallback[]> {
      if (!input.leaseOwner || !Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) {
        throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_INVALID");
      }
      const now = input.now ?? new Date();
      const at = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
      const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)));
      return db.transaction((tx) => {
        const due = tx.select().from(governedCallbackIntents).where(and(
          eq(governedCallbackIntents.destinationId, input.destinationId),
          eq(governedCallbackIntents.organizationId, input.organizationId),
          eq(governedCallbackIntents.state, "pending"),
          lte(governedCallbackIntents.nextAttemptAt, at)
        )).orderBy(asc(governedCallbackIntents.createdAt), asc(governedCallbackIntents.localIntentId))
          .limit(limit).all();
        const claimed: ClaimedGovernedCallback[] = [];
        for (const row of due) {
          let localDelivery: typeof callbackDeliveries.$inferSelect;
          try {
            localDelivery = assertGovernedCallbackAuthorityTx(tx, row);
          } catch (error) {
            if (!(error instanceof GovernedCallbackConflictError)) throw error;
            tx.update(governedCallbackIntents).set({
              state: "attention",
              nextAttemptAt: null,
              lastReasonCode: "authority_conflict",
              updatedAt: at,
              terminalAt: at
            }).where(and(
              eq(governedCallbackIntents.localIntentId, row.localIntentId),
              eq(governedCallbackIntents.state, "pending")
            )).run();
            if (row.localDeliveryId !== null) {
              const governedDelivery = tx.select({
                id: callbackDeliveries.id,
                governedState: callbackDeliveries.governedState
              })
                .from(callbackDeliveries).where(and(
                  eq(callbackDeliveries.id, row.localDeliveryId),
                  eq(callbackDeliveries.dispatchMode, "governed")
                )).limit(1).get();
              const deliveryUpdated = tx.update(callbackDeliveries).set({
                governedState: "attention",
                updatedAt: at
              }).where(and(
                eq(callbackDeliveries.id, row.localDeliveryId),
                eq(callbackDeliveries.dispatchMode, "governed"),
                inArray(callbackDeliveries.governedState, ["pending", "leased", "sending"])
              )).run();
              if (
                governedDelivery
                && ["pending", "leased", "sending"].includes(governedDelivery.governedState ?? "")
                && deliveryUpdated.changes !== 1
              ) {
                throw new Error("governed_callback_delivery_quarantine_update_lost");
              }
            }
            continue;
          }
          const pendingAttempt = row.currentAttemptId
            ? tx.select().from(governedCallbackAttempts).where(and(
                eq(governedCallbackAttempts.localAttemptId, row.currentAttemptId),
                eq(governedCallbackAttempts.localIntentId, row.localIntentId),
                eq(governedCallbackAttempts.attemptNumber, row.currentAttemptNumber),
                eq(governedCallbackAttempts.state, "pending")
              )).limit(1).get()
            : undefined;
          if (!pendingAttempt) {
            tx.update(governedCallbackIntents).set({
              state: "attention",
              nextAttemptAt: null,
              lastReasonCode: "pending_attempt_missing",
              updatedAt: at,
              terminalAt: at
            }).where(and(
              eq(governedCallbackIntents.localIntentId, row.localIntentId),
              eq(governedCallbackIntents.state, "pending")
            )).run();
            updateGovernedDeliveryStateTx(tx, {
              deliveryId: row.localDeliveryId!,
              from: "pending",
              to: "attention",
              updatedAt: at
            });
            continue;
          }
          const leaseToken = randomBytes(32).toString("hex");
          const updated = tx.update(governedCallbackIntents).set({
            state: "leased",
            nextAttemptAt: null,
            leaseOwner: input.leaseOwner,
            leaseToken,
            leaseExpiresAt,
            lastReasonCode: null,
            updatedAt: at
          }).where(and(
            eq(governedCallbackIntents.localIntentId, row.localIntentId),
            eq(governedCallbackIntents.state, "pending"),
            eq(governedCallbackIntents.currentAttemptId, pendingAttempt.localAttemptId),
            eq(governedCallbackIntents.currentAttemptNumber, pendingAttempt.attemptNumber)
          )).run();
          if (updated.changes !== 1) continue;
          const attemptUpdated = tx.update(governedCallbackAttempts).set({
            state: "leased",
            leaseOwner: input.leaseOwner,
            leaseToken,
            leaseExpiresAt,
            updatedAt: at
          }).where(and(
            eq(governedCallbackAttempts.localAttemptId, pendingAttempt.localAttemptId),
            eq(governedCallbackAttempts.state, "pending")
          )).run();
          if (attemptUpdated.changes !== 1) throw new Error("governed_callback_claim_update_lost");
          updateGovernedDeliveryStateTx(tx, {
            deliveryId: row.localDeliveryId!,
            from: "pending",
            to: "leased",
            updatedAt: at
          });
          const intent = tx.select().from(governedCallbackIntents)
            .where(eq(governedCallbackIntents.localIntentId, row.localIntentId)).limit(1).get()!;
          const attempt = tx.select().from(governedCallbackAttempts)
            .where(eq(governedCallbackAttempts.localAttemptId, pendingAttempt.localAttemptId)).limit(1).get()!;
          claimed.push({
            intent: governedCallbackIntentFromRow(intent),
            attempt: governedCallbackAttemptFromRow(attempt),
            delivery: callbackDeliveryFromRow({ ...localDelivery, governedState: "leased", updatedAt: at }),
            producer: {
              kind: "local_opentag",
              id: row.producerId,
              credentialId: row.credentialId,
              registrationGeneration: row.registrationGeneration
            },
            intentReceiptDigest: row.intentReceiptDigest,
            targetIdentityDigest: row.targetIdentityDigest,
            authority: {
              attemptId: row.runAttemptId,
              attemptNumber: row.runAttemptNumber,
              epoch: row.runAttemptNumber,
              fencingTokenDigest: row.fencingTokenDigest,
              completionOperationId: row.completionOperationId!,
              assessmentReceiptId: row.assessmentReceiptId!,
              assessmentReceiptDigest: row.assessmentReceiptDigest!
            }
          });
        }
        return claimed;
      }, { behavior: "immediate" });
    },

    async beginGovernedCallbackSending(input: {
      destinationId: string;
      organizationId: string;
      localIntentId: string;
      localAttemptId: string;
      leaseToken: string;
      now?: Date;
    }): Promise<
      | { outcome: "sending"; attemptedAt: string }
      | { outcome: "stale_lease" }
      | { outcome: "not_found" }
    > {
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        const intent = tx.select().from(governedCallbackIntents).where(and(
          eq(governedCallbackIntents.localIntentId, input.localIntentId),
          eq(governedCallbackIntents.destinationId, input.destinationId),
          eq(governedCallbackIntents.organizationId, input.organizationId)
        )).limit(1).get();
        const attempt = tx.select().from(governedCallbackAttempts).where(and(
          eq(governedCallbackAttempts.localAttemptId, input.localAttemptId),
          eq(governedCallbackAttempts.localIntentId, input.localIntentId)
        )).limit(1).get();
        if (!intent || !attempt) return { outcome: "not_found" } as const;
        assertGovernedCallbackAuthorityTx(tx, intent);
        if (
          intent.state !== "leased" || attempt.state !== "leased"
          || intent.currentAttemptId !== input.localAttemptId
          || intent.leaseToken !== input.leaseToken || attempt.leaseToken !== input.leaseToken
          || !intent.leaseExpiresAt || intent.leaseExpiresAt <= at
          || attempt.leaseExpiresAt !== intent.leaseExpiresAt
        ) return { outcome: "stale_lease" } as const;
        const intentUpdated = tx.update(governedCallbackIntents).set({ state: "sending", updatedAt: at })
          .where(and(
            eq(governedCallbackIntents.localIntentId, input.localIntentId),
            eq(governedCallbackIntents.state, "leased"),
            eq(governedCallbackIntents.currentAttemptId, input.localAttemptId),
            eq(governedCallbackIntents.leaseToken, input.leaseToken),
            gt(governedCallbackIntents.leaseExpiresAt, at)
          )).run();
        const attemptUpdated = tx.update(governedCallbackAttempts).set({
          state: "sending",
          attemptedAt: at,
          updatedAt: at
        }).where(and(
          eq(governedCallbackAttempts.localAttemptId, input.localAttemptId),
          eq(governedCallbackAttempts.state, "leased"),
          eq(governedCallbackAttempts.leaseToken, input.leaseToken),
          gt(governedCallbackAttempts.leaseExpiresAt, at)
        )).run();
        if (intentUpdated.changes !== 1 || attemptUpdated.changes !== 1) {
          throw new Error("governed_callback_begin_sending_update_lost");
        }
        updateGovernedDeliveryStateTx(tx, {
          deliveryId: intent.localDeliveryId!,
          from: "leased",
          to: "sending",
          updatedAt: at
        });
        return { outcome: "sending", attemptedAt: at } as const;
      }, { behavior: "immediate" });
    },

    async quarantineGovernedCallbackAttempt(input: {
      destinationId: string;
      organizationId: string;
      localIntentId: string;
      localAttemptId: string;
      leaseToken: string;
      attemptReceipt: typeof CallbackAttemptObservationReceiptEnvelopeV1Schema._output;
      now?: Date;
    }): Promise<"quarantined" | "replayed" | "stale_lease" | "not_found"> {
      const receipt = validateCallbackProjectionEnvelope(
        CallbackAttemptObservationReceiptEnvelopeV1Schema,
        input.attemptReceipt
      );
      if (receipt.payload.outcome !== "attention") return "stale_lease";
      const receiptJson = canonicalJsonStringify(receipt);
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        const intent = tx.select().from(governedCallbackIntents).where(and(
          eq(governedCallbackIntents.localIntentId, input.localIntentId),
          eq(governedCallbackIntents.destinationId, input.destinationId),
          eq(governedCallbackIntents.organizationId, input.organizationId)
        )).limit(1).get();
        const attempt = tx.select().from(governedCallbackAttempts).where(and(
          eq(governedCallbackAttempts.localAttemptId, input.localAttemptId),
          eq(governedCallbackAttempts.localIntentId, input.localIntentId)
        )).limit(1).get();
        if (!intent || !attempt) return "not_found" as const;
        if (attempt.state === "attention") {
          return attempt.attemptReceiptDigest === receipt.receiptDigest
            && attempt.attemptReceiptJson === receiptJson
            ? "replayed" as const
            : "stale_lease" as const;
        }
        assertGovernedCallbackAuthorityTx(tx, intent, { requireCurrentAssessment: false });
        if (
          intent.state !== "leased" || attempt.state !== "leased"
          || intent.currentAttemptId !== attempt.localAttemptId
          || intent.leaseToken !== input.leaseToken || attempt.leaseToken !== input.leaseToken
          || !intent.leaseExpiresAt || intent.leaseExpiresAt <= at
          || receipt.organizationId !== intent.organizationId
          || receipt.runId !== intent.runId
          || receipt.workThreadId !== intent.workThreadId
          || receipt.producer.id !== intent.producerId
          || receipt.producer.credentialId !== intent.credentialId
          || receipt.producer.registrationGeneration !== intent.registrationGeneration
          || receipt.payload.localIntentId !== intent.localIntentId
          || receipt.payload.localAttemptId !== attempt.localAttemptId
          || receipt.payload.attemptNumber !== attempt.attemptNumber
          || receipt.payload.requestDigest !== attempt.requestDigest
          || !receipt.predecessorReceiptDigests?.includes(intent.intentReceiptDigest)
        ) return "stale_lease" as const;
        const attemptUpdated = tx.update(governedCallbackAttempts).set({
          state: "attention",
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          attemptedAt: receipt.payload.attemptedAt,
          observedAt: receipt.payload.observedAt,
          reasonCode: receipt.payload.reasonCode,
          nextAction: receipt.payload.nextAction!,
          owner: receipt.payload.owner!,
          attemptReceiptId: receipt.receiptId,
          attemptReceiptDigest: receipt.receiptDigest,
          attemptReceiptJson: receiptJson,
          updatedAt: at
        }).where(and(
          eq(governedCallbackAttempts.localAttemptId, attempt.localAttemptId),
          eq(governedCallbackAttempts.state, "leased"),
          eq(governedCallbackAttempts.leaseToken, input.leaseToken)
        )).run();
        const intentUpdated = tx.update(governedCallbackIntents).set({
          state: "attention",
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastReasonCode: receipt.payload.reasonCode,
          updatedAt: at,
          terminalAt: at
        }).where(and(
          eq(governedCallbackIntents.localIntentId, intent.localIntentId),
          eq(governedCallbackIntents.state, "leased"),
          eq(governedCallbackIntents.leaseToken, input.leaseToken)
        )).run();
        if (attemptUpdated.changes !== 1 || intentUpdated.changes !== 1) {
          throw new Error("governed_callback_quarantine_update_lost");
        }
        updateGovernedDeliveryStateTx(tx, {
          deliveryId: intent.localDeliveryId!,
          from: "leased",
          to: "attention",
          updatedAt: at
        });
        assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
          destinationId: intent.destinationId,
          envelope: receipt,
          dependsOnReceiptId: intent.intentReceiptId,
          ...(input.now ? { now: input.now } : {})
        }));
        tx.insert(runEvents).values(runEventValues({
          runId: intent.runId,
          type: "callback.governed.attention",
          payload: {
            localIntentId: intent.localIntentId,
            localAttemptId: attempt.localAttemptId,
            reasonCode: receipt.payload.reasonCode,
            nextAction: receipt.payload.nextAction,
            owner: receipt.payload.owner
          },
          visibility: "audit",
          importance: "high",
          createdAt: at
        })).run();
        return "quarantined" as const;
      }, { behavior: "immediate" });
    },

    async recoverExpiredGovernedCallbacks(input: {
      destinationId: string;
      organizationId: string;
      now?: Date;
    }): Promise<{ requeued: number; outcomeUnknown: number }> {
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        let requeued = 0;
        let outcomeUnknown = 0;
        const expired = tx.select().from(governedCallbackIntents).where(and(
          eq(governedCallbackIntents.destinationId, input.destinationId),
          eq(governedCallbackIntents.organizationId, input.organizationId),
          inArray(governedCallbackIntents.state, ["leased", "sending"]),
          lte(governedCallbackIntents.leaseExpiresAt, at)
        )).all();
        for (const intent of expired) {
          const attempt = intent.currentAttemptId
            ? tx.select().from(governedCallbackAttempts)
                .where(eq(governedCallbackAttempts.localAttemptId, intent.currentAttemptId)).limit(1).get()
            : undefined;
          if (!attempt || attempt.leaseToken !== intent.leaseToken) continue;
          let frozenAuthorityValid = true;
          try {
            assertGovernedCallbackAuthorityTx(tx, intent, { requireCurrentAssessment: false });
          } catch (error) {
            if (!(error instanceof GovernedCallbackConflictError)) throw error;
            frozenAuthorityValid = false;
          }
          if (!frozenAuthorityValid && intent.state === "leased" && attempt.state === "leased") {
            const observation = buildLocalAttentionAttemptObservation(intent, attempt, at);
            const attemptUpdated = tx.update(governedCallbackAttempts).set({
              state: "attention",
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              attemptedAt: observation.payload.attemptedAt,
              observedAt: observation.payload.observedAt,
              reasonCode: observation.payload.reasonCode,
              nextAction: observation.payload.nextAction,
              owner: observation.payload.owner,
              attemptReceiptId: observation.receiptId,
              attemptReceiptDigest: observation.receiptDigest,
              attemptReceiptJson: canonicalJsonStringify(observation),
              updatedAt: at
            }).where(and(
              eq(governedCallbackAttempts.localAttemptId, attempt.localAttemptId),
              eq(governedCallbackAttempts.state, "leased"),
              eq(governedCallbackAttempts.leaseToken, attempt.leaseToken!)
            )).run();
            const intentUpdated = tx.update(governedCallbackIntents).set({
              state: "attention",
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              lastReasonCode: observation.payload.reasonCode,
              updatedAt: at,
              terminalAt: at
            }).where(and(
              eq(governedCallbackIntents.localIntentId, intent.localIntentId),
              eq(governedCallbackIntents.state, "leased"),
              eq(governedCallbackIntents.leaseToken, attempt.leaseToken!)
            )).run();
            const deliveryUpdated = tx.update(callbackDeliveries)
              .set({ governedState: "attention", updatedAt: at })
              .where(and(
                eq(callbackDeliveries.id, intent.localDeliveryId!),
                eq(callbackDeliveries.dispatchMode, "governed"),
                eq(callbackDeliveries.governedState, "leased")
              )).run();
            if (
              attemptUpdated.changes !== 1
              || intentUpdated.changes !== 1
              || deliveryUpdated.changes !== 1
            ) throw new Error("governed_callback_authority_quarantine_update_lost");
            tx.insert(runEvents).values(runEventValues({
              runId: intent.runId,
              type: "callback.governed.attention",
              payload: {
                localIntentId: intent.localIntentId,
                localAttemptId: attempt.localAttemptId,
                reasonCode: observation.payload.reasonCode,
                nextAction: observation.payload.nextAction,
                owner: observation.payload.owner,
                detail: "authority_conflict"
              },
              visibility: "audit",
              importance: "high",
              createdAt: at
            })).run();
            continue;
          }
          if (intent.state === "leased" && attempt.state === "leased") {
            const attemptUpdated = tx.update(governedCallbackAttempts).set({
              state: "pending",
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: at
            }).where(and(
              eq(governedCallbackAttempts.localAttemptId, attempt.localAttemptId),
              eq(governedCallbackAttempts.state, "leased"),
              eq(governedCallbackAttempts.leaseToken, attempt.leaseToken!)
            )).run();
            const intentUpdated = tx.update(governedCallbackIntents).set({
              state: "pending",
              nextAttemptAt: at,
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              lastReasonCode: "lease_expired_before_send",
              updatedAt: at
            }).where(and(
              eq(governedCallbackIntents.localIntentId, intent.localIntentId),
              eq(governedCallbackIntents.state, "leased"),
              eq(governedCallbackIntents.leaseToken, attempt.leaseToken!)
            )).run();
            if (attemptUpdated.changes !== 1 || intentUpdated.changes !== 1) {
              throw new Error("governed_callback_lease_recovery_update_lost");
            }
            updateGovernedDeliveryStateTx(tx, {
              deliveryId: intent.localDeliveryId!,
              from: "leased",
              to: "pending",
              updatedAt: at
            });
            requeued += 1;
            continue;
          }
          if (intent.state === "sending" && attempt.state === "sending") {
            const observation = buildExpiredSendingAttemptObservation(intent, attempt, at);
            const observationJson = canonicalJsonStringify(observation);
            const attemptUpdated = tx.update(governedCallbackAttempts).set({
              state: "outcome_unknown",
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              observedAt: at,
              reasonCode: "provider_receipt_missing",
              nextAction: "reconcile-provider",
              owner: intent.producerId,
              attemptReceiptId: observation.receiptId,
              attemptReceiptDigest: observation.receiptDigest,
              attemptReceiptJson: observationJson,
              updatedAt: at
            }).where(and(
              eq(governedCallbackAttempts.localAttemptId, attempt.localAttemptId),
              eq(governedCallbackAttempts.state, "sending"),
              eq(governedCallbackAttempts.leaseToken, attempt.leaseToken!)
            )).run();
            const intentUpdated = tx.update(governedCallbackIntents).set({
              state: "attention",
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              lastReasonCode: "provider_receipt_missing",
              updatedAt: at,
              terminalAt: at
            }).where(and(
              eq(governedCallbackIntents.localIntentId, intent.localIntentId),
              eq(governedCallbackIntents.state, "sending"),
              eq(governedCallbackIntents.leaseToken, attempt.leaseToken!)
            )).run();
            if (attemptUpdated.changes !== 1 || intentUpdated.changes !== 1) {
              throw new Error("governed_callback_unknown_recovery_update_lost");
            }
            updateGovernedDeliveryStateTx(tx, {
              deliveryId: intent.localDeliveryId!,
              from: "sending",
              to: "attention",
              updatedAt: at
            });
            if (frozenAuthorityValid) {
              assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
                destinationId: intent.destinationId,
                envelope: observation,
                dependsOnReceiptId: intent.intentReceiptId,
                now: new Date(at)
              }));
            }
            tx.insert(runEvents).values(runEventValues({
              runId: intent.runId,
              type: "callback.governed.outcome_unknown",
              payload: {
                localIntentId: intent.localIntentId,
                localAttemptId: attempt.localAttemptId,
                reasonCode: "provider_receipt_missing",
                nextAction: "reconcile-provider",
                owner: intent.producerId
              },
              visibility: "audit",
              importance: "high",
              createdAt: at
            })).run();
            outcomeUnknown += 1;
          }
        }
        return { requeued, outcomeUnknown };
      }, { behavior: "immediate" });
    },

    async finalizeGovernedCallbackAttempt(input: {
      destinationId: string;
      organizationId: string;
      localIntentId: string;
      localAttemptId: string;
      leaseToken: string;
      attemptReceipt: typeof CallbackAttemptObservationReceiptEnvelopeV1Schema._output;
      providerReceipt?: typeof CallbackProviderObservationReceiptEnvelopeV1Schema._output;
      now?: Date;
    }): Promise<
      | "finalized"
      | "replayed"
      | "stale_lease"
      | "not_found"
      | {
          outcome: "reconciliation_required";
          attemptReceiptId: string;
          attemptReceiptDigest: string;
        }
    > {
      const attemptReceipt = validateCallbackProjectionEnvelope(
        CallbackAttemptObservationReceiptEnvelopeV1Schema,
        input.attemptReceipt
      );
      const providerReceipt = input.providerReceipt
        ? validateCallbackProjectionEnvelope(
            CallbackProviderObservationReceiptEnvelopeV1Schema,
            input.providerReceipt
          )
        : undefined;
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        const intent = tx.select().from(governedCallbackIntents).where(and(
          eq(governedCallbackIntents.localIntentId, input.localIntentId),
          eq(governedCallbackIntents.destinationId, input.destinationId),
          eq(governedCallbackIntents.organizationId, input.organizationId)
        )).limit(1).get();
        const attempt = tx.select().from(governedCallbackAttempts).where(and(
          eq(governedCallbackAttempts.localAttemptId, input.localAttemptId),
          eq(governedCallbackAttempts.localIntentId, input.localIntentId)
        )).limit(1).get();
        if (!intent || !attempt) return "not_found" as const;
        const attemptJson = canonicalJsonStringify(attemptReceipt);
        const providerJson = providerReceipt ? canonicalJsonStringify(providerReceipt) : null;
        if (["accepted", "rejected", "attention"].includes(attempt.state)) {
          return attempt.attemptReceiptDigest === attemptReceipt.receiptDigest
            && attempt.attemptReceiptJson === attemptJson
            && attempt.providerReceiptDigest === (providerReceipt?.receiptDigest ?? null)
            && attempt.providerReceiptJson === providerJson
            ? "replayed" as const
            : "stale_lease" as const;
        }
        assertGovernedCallbackAuthorityTx(tx, intent, { requireCurrentAssessment: false });
        const outcome = attemptReceipt.payload.outcome;
        const expectedProviderOutcome = outcome === "accepted"
          ? "succeeded"
          : outcome === "rejected" ? "failed" : null;
        const delivery = tx.select().from(callbackDeliveries)
          .where(eq(callbackDeliveries.id, intent.localDeliveryId!)).limit(1).get();
        const importedRun = tx.select().from(hostedRunImports)
          .where(eq(hostedRunImports.runId, intent.runId)).limit(1).get();
        const run = tx.select().from(runs).where(eq(runs.id, intent.runId)).limit(1).get();
        if (!delivery || !importedRun || !run) return "stale_lease" as const;
        let target: { issueNumber: number; resourceIdentity: string };
        try {
          target = governedCallbackEventTarget({
            eventJson: run.eventJson,
            eventDigest: importedRun.eventDigest,
            deliveryTarget: delivery.uri,
            targetIdentityDigest: intent.targetIdentityDigest
          });
        } catch {
          return "stale_lease" as const;
        }
        if (attempt.state === "outcome_unknown") {
          if (
            attemptReceipt.payload.outcome !== "outcome_unknown"
            && providerReceipt
            && attempt.attemptReceiptId
            && attempt.attemptReceiptDigest
            && providerReceipt.organizationId === intent.organizationId
            && providerReceipt.runId === intent.runId
            && providerReceipt.workThreadId === intent.workThreadId
            && providerReceipt.producer.id === intent.producerId
            && providerReceipt.producer.credentialId === intent.credentialId
            && providerReceipt.producer.registrationGeneration === intent.registrationGeneration
            && providerReceipt.payload.localIntentId === intent.localIntentId
            && providerReceipt.payload.localAttemptId === attempt.localAttemptId
            && governedProviderIdentityMatches({
              receipt: providerReceipt,
              targetIdentityDigest: intent.targetIdentityDigest,
              issueNumber: target.issueNumber
            })
            && Date.parse(providerReceipt.payload.observedAt)
              >= Date.parse(attempt.attemptedAt!)
          ) {
            return {
              outcome: "reconciliation_required" as const,
              attemptReceiptId: attempt.attemptReceiptId,
              attemptReceiptDigest: attempt.attemptReceiptDigest
            };
          }
          return attempt.attemptReceiptDigest === attemptReceipt.receiptDigest
            && attempt.attemptReceiptJson === attemptJson
            && !providerReceipt
            && attempt.providerReceiptDigest === null
            && attempt.providerReceiptJson === null
            ? "replayed" as const
            : "stale_lease" as const;
        }
        if (
          ((outcome === "accepted" || outcome === "rejected") && !providerReceipt)
          || ((outcome === "outcome_unknown" || outcome === "attention") && !!providerReceipt)
          || intent.state !== "sending" || attempt.state !== "sending"
          || intent.currentAttemptId !== attempt.localAttemptId
          || intent.leaseToken !== input.leaseToken || attempt.leaseToken !== input.leaseToken
          || attemptReceipt.organizationId !== intent.organizationId
          || attemptReceipt.runId !== intent.runId
          || attemptReceipt.workThreadId !== intent.workThreadId
          || attemptReceipt.producer.id !== intent.producerId
          || attemptReceipt.producer.credentialId !== intent.credentialId
          || attemptReceipt.producer.registrationGeneration !== intent.registrationGeneration
          || attemptReceipt.payload.localIntentId !== intent.localIntentId
          || attemptReceipt.payload.localAttemptId !== attempt.localAttemptId
          || attemptReceipt.payload.attemptNumber !== attempt.attemptNumber
          || attemptReceipt.payload.requestDigest !== attempt.requestDigest
          || !attemptReceipt.predecessorReceiptDigests?.includes(
            intent.intentReceiptDigest
          )
          || attemptReceipt.payload.attemptedAt !== attempt.attemptedAt
          || (providerReceipt && (
            providerReceipt.organizationId !== intent.organizationId
            || providerReceipt.runId !== intent.runId
            || providerReceipt.workThreadId !== intent.workThreadId
            || providerReceipt.producer.id !== intent.producerId
            || providerReceipt.producer.credentialId !== intent.credentialId
            || providerReceipt.producer.registrationGeneration !== intent.registrationGeneration
            || providerReceipt.payload.localIntentId !== intent.localIntentId
            || providerReceipt.payload.localAttemptId !== attempt.localAttemptId
            || providerReceipt.payload.outcome !== expectedProviderOutcome
            || !governedProviderIdentityMatches({
              receipt: providerReceipt,
              targetIdentityDigest: intent.targetIdentityDigest,
              issueNumber: target.issueNumber
            })
            || providerReceipt.payload.reasonCode !== attemptReceipt.payload.reasonCode
            || Date.parse(providerReceipt.payload.observedAt)
              < Date.parse(attempt.attemptedAt!)
            || !providerReceipt.predecessorReceiptDigests?.includes(
              attemptReceipt.receiptDigest
            )
          ))
        ) return "stale_lease" as const;
        const attemptUpdated = tx.update(governedCallbackAttempts).set({
          state: outcome,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          observedAt: attemptReceipt.payload.observedAt,
          reasonCode: attemptReceipt.payload.reasonCode,
          nextAction: attemptReceipt.payload.nextAction ?? null,
          owner: attemptReceipt.payload.owner ?? null,
          attemptReceiptId: attemptReceipt.receiptId,
          attemptReceiptDigest: attemptReceipt.receiptDigest,
          attemptReceiptJson: attemptJson,
          providerReceiptId: providerReceipt?.payload.providerReceiptId ?? null,
          resourceIdentity: providerReceipt?.payload.resourceIdentity ?? null,
          providerReceiptDigest: providerReceipt?.receiptDigest ?? null,
          providerReceiptJson: providerJson,
          updatedAt: at
        }).where(and(
          eq(governedCallbackAttempts.localAttemptId, attempt.localAttemptId),
          eq(governedCallbackAttempts.state, "sending"),
          eq(governedCallbackAttempts.leaseToken, input.leaseToken)
        )).run();
        const intentState = outcome === "outcome_unknown" || outcome === "attention"
          ? "attention"
          : outcome;
        const intentUpdated = tx.update(governedCallbackIntents).set({
          state: intentState,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastReasonCode: attemptReceipt.payload.reasonCode,
          updatedAt: at,
          terminalAt: at
        }).where(and(
          eq(governedCallbackIntents.localIntentId, intent.localIntentId),
          eq(governedCallbackIntents.state, "sending"),
          eq(governedCallbackIntents.currentAttemptId, attempt.localAttemptId),
          eq(governedCallbackIntents.leaseToken, input.leaseToken)
        )).run();
        if (attemptUpdated.changes !== 1 || intentUpdated.changes !== 1) {
          throw new Error("governed_callback_finalize_update_lost");
        }
        updateGovernedDeliveryStateTx(tx, {
          deliveryId: intent.localDeliveryId!,
          from: "sending",
          to: intentState,
          updatedAt: at
        });
        assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
          destinationId: intent.destinationId,
          envelope: attemptReceipt,
          dependsOnReceiptId: intent.intentReceiptId,
          ...(input.now ? { now: input.now } : {})
        }));
        if (providerReceipt) {
          assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
            destinationId: intent.destinationId,
            envelope: providerReceipt,
            dependsOnReceiptId: attemptReceipt.receiptId,
            ...(input.now ? { now: input.now } : {})
          }));
        }
        tx.insert(runEvents).values(runEventValues({
          runId: intent.runId,
          type: `callback.governed.${outcome}`,
          payload: {
            localIntentId: intent.localIntentId,
            localAttemptId: attempt.localAttemptId,
            ...(providerReceipt ? {
              providerReceiptId: providerReceipt.payload.providerReceiptId,
              resourceIdentity: providerReceipt.payload.resourceIdentity
            } : {}),
            reasonCode: attemptReceipt.payload.reasonCode,
            ...(attemptReceipt.payload.nextAction ? { nextAction: attemptReceipt.payload.nextAction } : {}),
            ...(attemptReceipt.payload.owner ? { owner: attemptReceipt.payload.owner } : {})
          },
          visibility: "audit",
          importance: outcome === "outcome_unknown" ? "high" : "normal",
          createdAt: at
        })).run();
        return "finalized" as const;
      }, { behavior: "immediate" });
    },

    async reconcileGovernedCallbackOutcome(input: {
      destinationId: string;
      organizationId: string;
      localIntentId: string;
      localAttemptId: string;
      providerReceipt: typeof CallbackProviderObservationReceiptEnvelopeV1Schema._output;
      now?: Date;
    }): Promise<{ outcome: "recorded" | "replayed" }> {
      const evidence = validateCallbackProjectionEnvelope(
        CallbackProviderObservationReceiptEnvelopeV1Schema,
        input.providerReceipt
      );
      const evidenceJson = canonicalJsonStringify(evidence);
      const evidenceDigest = evidence.receiptDigest;
      const resolution = evidence.payload.outcome === "succeeded"
        ? "accepted"
        : evidence.payload.outcome === "failed" ? "rejected" : null;
      if (!resolution) throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_INVALID");
      const at = (input.now ?? new Date()).toISOString();
      return db.transaction((tx) => {
        const intent = tx.select().from(governedCallbackIntents).where(and(
          eq(governedCallbackIntents.localIntentId, input.localIntentId),
          eq(governedCallbackIntents.destinationId, input.destinationId),
          eq(governedCallbackIntents.organizationId, input.organizationId)
        )).limit(1).get();
        const existing = tx.select().from(governedCallbackReconciliations)
          .where(or(
            eq(governedCallbackReconciliations.reconciliationId, evidence.receiptId),
            eq(governedCallbackReconciliations.localAttemptId, input.localAttemptId)
          ))
          .limit(1).get();
        if (existing) {
          const exact = intent
            && existing.reconciliationId === evidence.receiptId
            && existing.localIntentId === input.localIntentId
            && existing.localAttemptId === input.localAttemptId
            && existing.resolution === resolution
            && existing.evidenceDigest === evidenceDigest
            && existing.evidenceJson === evidenceJson
            && existing.owner === evidence.producer.id
            && existing.retryAttemptId === null;
          if (!exact) throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_CONFLICT");
          return { outcome: "replayed" as const };
        }
        const attempt = tx.select().from(governedCallbackAttempts).where(and(
          eq(governedCallbackAttempts.localAttemptId, input.localAttemptId),
          eq(governedCallbackAttempts.localIntentId, input.localIntentId),
          eq(governedCallbackAttempts.state, "outcome_unknown")
        )).limit(1).get();
        if (!intent || !attempt || !["outcome_unknown", "attention"].includes(intent.state)) {
          throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_RECONCILIATION_REQUIRED");
        }
        let unknownAttemptReceipt: typeof CallbackAttemptObservationReceiptEnvelopeV1Schema._output;
        try {
          if (!attempt.attemptReceiptJson || !attempt.attemptReceiptDigest) throw new Error();
          unknownAttemptReceipt = CallbackAttemptObservationReceiptEnvelopeV1Schema.parse(
            JSON.parse(attempt.attemptReceiptJson)
          );
        } catch {
          throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_RECONCILIATION_REQUIRED");
        }
        assertGovernedCallbackAuthorityTx(tx, intent, { requireCurrentAssessment: false });
        const delivery = tx.select().from(callbackDeliveries)
          .where(eq(callbackDeliveries.id, intent.localDeliveryId!)).limit(1).get();
        const importedRun = tx.select().from(hostedRunImports)
          .where(eq(hostedRunImports.runId, intent.runId)).limit(1).get();
        const run = tx.select().from(runs).where(eq(runs.id, intent.runId)).limit(1).get();
        let target: { issueNumber: number; resourceIdentity: string } | undefined;
        try {
          if (!delivery || !importedRun || !run) throw new Error();
          target = governedCallbackEventTarget({
            eventJson: run.eventJson,
            eventDigest: importedRun.eventDigest,
            deliveryTarget: delivery.uri,
            targetIdentityDigest: intent.targetIdentityDigest
          });
        } catch {
          throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_AUTHORITY_CONFLICT");
        }
        if (
          unknownAttemptReceipt.payload.outcome !== "outcome_unknown"
          || unknownAttemptReceipt.receiptDigest !== attempt.attemptReceiptDigest
          || unknownAttemptReceipt.receiptId !== attempt.attemptReceiptId
          || unknownAttemptReceipt.organizationId !== intent.organizationId
          || unknownAttemptReceipt.runId !== intent.runId
          || unknownAttemptReceipt.workThreadId !== intent.workThreadId
          || unknownAttemptReceipt.producer.id !== intent.producerId
          || unknownAttemptReceipt.producer.credentialId !== intent.credentialId
          || unknownAttemptReceipt.producer.registrationGeneration
            !== intent.registrationGeneration
          || unknownAttemptReceipt.payload.localIntentId !== intent.localIntentId
          || unknownAttemptReceipt.payload.localAttemptId !== attempt.localAttemptId
          || unknownAttemptReceipt.payload.attemptNumber !== attempt.attemptNumber
          || unknownAttemptReceipt.payload.requestDigest !== attempt.requestDigest
          || unknownAttemptReceipt.payload.attemptedAt !== attempt.attemptedAt
          || !unknownAttemptReceipt.predecessorReceiptDigests?.includes(
            intent.intentReceiptDigest
          )
          || evidence.organizationId !== intent.organizationId
          || evidence.runId !== intent.runId
          || evidence.workThreadId !== intent.workThreadId
          || evidence.producer.id !== intent.producerId
          || evidence.producer.credentialId !== intent.credentialId
          || evidence.producer.registrationGeneration !== intent.registrationGeneration
          || evidence.payload.localIntentId !== intent.localIntentId
          || evidence.payload.localAttemptId !== attempt.localAttemptId
          || !governedProviderIdentityMatches({
            receipt: evidence,
            targetIdentityDigest: intent.targetIdentityDigest,
            issueNumber: target.issueNumber
          })
          || !evidence.predecessorReceiptDigests?.includes(attempt.attemptReceiptDigest)
          || Date.parse(evidence.payload.observedAt) < Date.parse(attempt.attemptedAt!)
          || (resolution === "accepted" && evidence.payload.reasonCode !== "provider_accepted")
          || (resolution === "rejected" && evidence.payload.reasonCode !== "provider_rejected")
        ) {
          throw new GovernedCallbackConflictError("GOVERNED_CALLBACK_AUTHORITY_CONFLICT");
        }
        const updated = tx.update(governedCallbackIntents).set({
          state: resolution,
          lastReasonCode: "reconciled_provider_evidence",
          updatedAt: at,
          terminalAt: at
        }).where(and(
          eq(governedCallbackIntents.localIntentId, input.localIntentId),
          inArray(governedCallbackIntents.state, ["outcome_unknown", "attention"]),
          eq(governedCallbackIntents.currentAttemptId, input.localAttemptId)
        )).run();
        if (updated.changes !== 1) throw new Error("governed_callback_reconciliation_update_lost");
        updateGovernedDeliveryStateTx(tx, {
          deliveryId: intent.localDeliveryId!,
          from: ["outcome_unknown", "attention"],
          to: resolution,
          updatedAt: at
        });
        tx.insert(governedCallbackReconciliations).values({
          reconciliationId: evidence.receiptId,
          localIntentId: input.localIntentId,
          localAttemptId: input.localAttemptId,
          resolution,
          evidenceDigest,
          evidenceJson,
          owner: evidence.producer.id,
          retryAttemptId: null,
          createdAt: at
        }).run();
        tx.insert(runEvents).values(runEventValues({
          runId: intent.runId,
          type: "callback.governed.reconciled",
          payload: {
            reconciliationId: evidence.receiptId,
            localIntentId: input.localIntentId,
            localAttemptId: input.localAttemptId,
            resolution,
            evidenceDigest,
            owner: evidence.producer.id,
            resourceIdentity: evidence.payload.resourceIdentity
          },
          visibility: "audit",
          importance: "high",
          createdAt: at
        })).run();
        assertProjectionCreatedOrReplayed(enqueueControlPlaneProjectionTx(tx, {
          destinationId: intent.destinationId,
          envelope: evidence,
          dependsOnReceiptId: attempt.attemptReceiptId!,
          ...(input.now ? { now: input.now } : {})
        }));
        return { outcome: "recorded" as const };
      }, { behavior: "immediate" });
    },

    async getPriorAcceptedGovernedGitHubResource(input: {
      destinationId: string;
      organizationId: string;
      runId: string;
      workThreadId: string;
      statusMessageKey: string;
      targetIdentityDigest: string;
    }): Promise<PriorAcceptedGovernedGitHubResource> {
      const rows = await db.select({
        intent: governedCallbackIntents,
        attempt: governedCallbackAttempts,
        delivery: callbackDeliveries
      }).from(governedCallbackIntents)
        .innerJoin(governedCallbackAttempts, and(
          eq(governedCallbackAttempts.localIntentId, governedCallbackIntents.localIntentId),
          eq(governedCallbackAttempts.localAttemptId, governedCallbackIntents.currentAttemptId)
        ))
        .innerJoin(callbackDeliveries,
          eq(callbackDeliveries.id, governedCallbackIntents.localDeliveryId))
        .where(and(
          eq(governedCallbackIntents.destinationId, input.destinationId),
          eq(governedCallbackIntents.organizationId, input.organizationId),
          eq(governedCallbackIntents.runId, input.runId),
          eq(governedCallbackIntents.workThreadId, input.workThreadId),
          eq(governedCallbackIntents.targetIdentityDigest, input.targetIdentityDigest),
          eq(governedCallbackIntents.state, "accepted")
        ));
      const candidates: Array<{
        providerReceiptId: string;
        resourceIdentity: string;
        targetIdentityDigest: string;
      }> = [];
      for (const row of rows) {
        const metadata = callbackDeliveryMetadataFromJson(row.delivery.metadataJson);
        if (metadata?.statusMessageKey !== input.statusMessageKey) continue;
        const importedRun = await db.select().from(hostedRunImports)
          .where(eq(hostedRunImports.runId, row.intent.runId)).limit(1).get();
        const run = await db.select().from(runs)
          .where(eq(runs.id, row.intent.runId)).limit(1).get();
        let target: { issueNumber: number; resourceIdentity: string };
        try {
          if (!importedRun || !run) throw new Error();
          target = governedCallbackEventTarget({
            eventJson: run.eventJson,
            eventDigest: importedRun.eventDigest,
            deliveryTarget: row.delivery.uri,
            targetIdentityDigest: row.intent.targetIdentityDigest
          });
        } catch {
          return { outcome: "conflict" };
        }
        let receiptJson = row.attempt.state === "accepted"
          ? row.attempt.providerReceiptJson
          : null;
        let expectedReceiptDigest = row.attempt.state === "accepted"
          ? row.attempt.providerReceiptDigest
          : null;
        if (row.attempt.state === "outcome_unknown") {
          const reconciliations = await db.select().from(governedCallbackReconciliations)
            .where(and(
              eq(governedCallbackReconciliations.localIntentId, row.intent.localIntentId),
              eq(governedCallbackReconciliations.localAttemptId, row.attempt.localAttemptId),
              eq(governedCallbackReconciliations.resolution, "accepted")
            ));
          if (reconciliations.length !== 1) return { outcome: "conflict" };
          receiptJson = reconciliations[0]!.evidenceJson;
          expectedReceiptDigest = reconciliations[0]!.evidenceDigest;
        }
        let receipt: typeof CallbackProviderObservationReceiptEnvelopeV1Schema._output;
        try {
          if (!receiptJson) throw new Error();
          receipt = CallbackProviderObservationReceiptEnvelopeV1Schema.parse(
            JSON.parse(receiptJson)
          );
        } catch {
          return { outcome: "conflict" };
        }
        if (
          receipt.payload.outcome !== "succeeded"
          || receipt.receiptDigest !== expectedReceiptDigest
          || receipt.organizationId !== row.intent.organizationId
          || receipt.runId !== row.intent.runId
          || receipt.workThreadId !== row.intent.workThreadId
          || receipt.producer.id !== row.intent.producerId
          || receipt.producer.credentialId !== row.intent.credentialId
          || receipt.producer.registrationGeneration !== row.intent.registrationGeneration
          || receipt.payload.localIntentId !== row.intent.localIntentId
          || receipt.payload.localAttemptId !== row.attempt.localAttemptId
          || !receipt.predecessorReceiptDigests?.includes(
            row.attempt.attemptReceiptDigest!
          )
          || !governedProviderIdentityMatches({
            receipt,
            targetIdentityDigest: row.intent.targetIdentityDigest,
            issueNumber: target.issueNumber
          })
        ) return { outcome: "conflict" };
        candidates.push({
          providerReceiptId: receipt.payload.providerReceiptId,
          resourceIdentity: receipt.payload.resourceIdentity,
          targetIdentityDigest: receipt.payload.targetIdentityDigest
        });
      }
      if (candidates.length === 0) return { outcome: "not_found" };
      const resources = new Map(candidates.map((candidate) => [
        `${candidate.providerReceiptId}\u0000${candidate.resourceIdentity}`,
        candidate
      ]));
      if (resources.size !== 1) return { outcome: "conflict" };
      return { outcome: "found", ...resources.values().next().value! };
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
          dispatchMode: "legacy",
          governedState: null,
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
        .where(and(
          eq(callbackDeliveries.id, input.deliveryId),
          eq(callbackDeliveries.dispatchMode, "legacy")
        ))
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
        .where(and(
          eq(callbackDeliveries.id, input.deliveryId),
          eq(callbackDeliveries.dispatchMode, "legacy")
        ));
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
        .where(and(
          eq(callbackDeliveries.runId, input.runId),
          eq(callbackDeliveries.provider, input.provider),
          eq(callbackDeliveries.status, "delivered"),
          eq(callbackDeliveries.dispatchMode, "legacy")
        ))
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
        .where(and(
          eq(callbackDeliveries.id, input.deliveryId),
          eq(callbackDeliveries.dispatchMode, "legacy")
        ))
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
        .where(and(
          eq(callbackDeliveries.id, input.deliveryId),
          eq(callbackDeliveries.dispatchMode, "legacy")
        ));
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

    async markCallbackAttention(input: {
      deliveryId: number;
      reasonCode: string;
      nextAction: string;
      owner?: string;
    }): Promise<void> {
      const updatedAt = nowIso();
      const row = await db.select().from(callbackDeliveries).where(and(
        eq(callbackDeliveries.id, input.deliveryId),
        eq(callbackDeliveries.dispatchMode, "legacy"),
        inArray(callbackDeliveries.status, ["pending", "delivering", "failed"])
      )).limit(1).get();
      if (!row) return;
      const safe = sanitizeCredentialLikeValue({
        reasonCode: input.reasonCode.slice(0, 128),
        nextAction: input.nextAction.slice(0, 256),
        ...(input.owner ? { owner: input.owner.slice(0, 128) } : {})
      }, { secrets: await attemptFencingTokensForRun(row.runId) });
      const attempts = row.attempts + 1;
      const updated = await db.update(callbackDeliveries).set({
        status: "attention",
        attempts,
        lastError: safe.reasonCode,
        nextAttemptAt: null,
        updatedAt
      }).where(and(
        eq(callbackDeliveries.id, input.deliveryId),
        eq(callbackDeliveries.dispatchMode, "legacy"),
        inArray(callbackDeliveries.status, ["pending", "delivering", "failed"])
      ));
      if (updated.changes !== 1) return;
      await appendRunEvent({
        runId: row.runId,
        type: `callback.${row.kind}.attention`,
        payload: {
          ...callbackDeliveryFromRow(row),
          status: "attention",
          attempts,
          reasonCode: safe.reasonCode,
          nextAction: safe.nextAction,
          ...(safe.owner ? { owner: safe.owner } : {}),
          updatedAt
        },
        visibility: "audit",
        importance: "high",
        createdAt: updatedAt
      });
    },

    async listPendingCallbackDeliveries(input: { limit: number; now?: Date; maxAttempts?: number }): Promise<CallbackDelivery[]> {
      const now = input.now ?? new Date();
      const maxAttempts = input.maxAttempts ?? Number.POSITIVE_INFINITY;
      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(and(
          eq(callbackDeliveries.dispatchMode, "legacy"),
          inArray(callbackDeliveries.status, ["pending", "failed"])
        ))
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
        .where(and(
          eq(callbackDeliveries.dispatchMode, "legacy"),
          inArray(callbackDeliveries.status, ["pending", "failed", "delivering"])
        ))
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
            ? and(eq(callbackDeliveries.id, row.id), eq(callbackDeliveries.dispatchMode, "legacy"), eq(callbackDeliveries.status, "delivering"), eq(callbackDeliveries.updatedAt, row.updatedAt))
            : and(eq(callbackDeliveries.id, row.id), eq(callbackDeliveries.dispatchMode, "legacy"), inArray(callbackDeliveries.status, ["pending", "failed"]));
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

    async getAcceptedProgressMetrics(): Promise<AcceptedProgressMetrics> {
      const acceptedProgress = await acceptedProgressSnapshot();
      const acceptedProgressRows = [...acceptedProgress.acceptedGateAdvancesByRunId].map(([runId, acceptedGateAdvances]) => ({
        runId,
        acceptedGateAdvances
      }));
      type AggregateRow = {
        dimension: "total" | "runner" | "executor";
        id: string | null;
        completedRuns: number;
        runsWithAcceptedProgress: number;
        acceptedGateAdvances: number;
      };
      const aggregateRows = db.all<AggregateRow>(sql`
        WITH accepted_progress AS (
          SELECT
            json_extract(value, '$.runId') AS run_id,
            json_extract(value, '$.acceptedGateAdvances') AS accepted_gate_advances
          FROM json_each(${JSON.stringify(acceptedProgressRows)})
        ),
        latest_attempt_numbers AS (
          SELECT run_id, max(number) AS number
          FROM attempts
          GROUP BY run_id
        ),
        latest_attempts AS (
          SELECT attempt.run_id, attempt.runner_id, attempt.selected_executor_id, attempt.status
          FROM attempts AS attempt
          INNER JOIN latest_attempt_numbers AS latest
            ON latest.run_id = attempt.run_id AND latest.number = attempt.number
        ),
        attributable_runs AS (
          SELECT
            run.id,
            attempt.runner_id,
            attempt.selected_executor_id,
            coalesce(progress.accepted_gate_advances, 0) AS accepted_gate_advances
          FROM runs AS run
          INNER JOIN latest_attempts AS attempt ON attempt.run_id = run.id
          LEFT JOIN accepted_progress AS progress ON progress.run_id = run.id
          WHERE run.status IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out')
            AND run.current_attempt_id IS NULL
            AND run.assigned_runner_id IS NULL
            AND attempt.selected_executor_id IS NOT NULL
            AND attempt.status = run.status
        ),
        dimension_rows AS (
          SELECT 'runner' AS dimension, runner_id AS id, accepted_gate_advances FROM attributable_runs
          UNION ALL
          SELECT 'executor' AS dimension, selected_executor_id AS id, accepted_gate_advances FROM attributable_runs
        )
        SELECT
          'total' AS dimension,
          NULL AS id,
          count(*) AS completedRuns,
          coalesce(sum(CASE WHEN accepted_gate_advances > 0 THEN 1 ELSE 0 END), 0) AS runsWithAcceptedProgress,
          coalesce(sum(accepted_gate_advances), 0) AS acceptedGateAdvances
        FROM attributable_runs
        UNION ALL
        SELECT
          dimension,
          id,
          count(*) AS completedRuns,
          coalesce(sum(CASE WHEN accepted_gate_advances > 0 THEN 1 ELSE 0 END), 0) AS runsWithAcceptedProgress,
          coalesce(sum(accepted_gate_advances), 0) AS acceptedGateAdvances
        FROM dimension_rows
        GROUP BY dimension, id
        ORDER BY dimension, id
      `);
      const total = aggregateRows.find((row) => row.dimension === "total");
      const segment = (dimension: "runner" | "executor") => aggregateRows
        .filter((row): row is AggregateRow & { id: string } => row.dimension === dimension && row.id !== null)
        .map((row) => ({
          id: row.id,
          completedRuns: row.completedRuns,
          runsWithAcceptedProgress: row.runsWithAcceptedProgress,
          acceptedGateAdvances: row.acceptedGateAdvances
        }));

      return AcceptedProgressMetricsSchema.parse({
        completedRuns: total?.completedRuns ?? 0,
        runsWithAcceptedProgress: acceptedProgress.runIdsWithAcceptedProgress.length,
        acceptedGateAdvances: acceptedProgress.acceptedGateAdvanceCount,
        attributedAcceptedGateAdvances: acceptedProgress.attributedGateAdvanceCount,
        unresolvedAcceptedGateAdvances: acceptedProgress.unresolvedGateAdvanceCount,
        byRunner: segment("runner"),
        byExecutor: segment("executor")
      });
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
