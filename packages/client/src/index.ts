import {
  FollowUpRequestSchema,
  ActionSchema,
  ActionPermissionResolutionSchema,
  CompletionAssessmentSchema,
  CompletionContractSchema,
  CompletionWaiverSchema,
  AcceptedProgressAttributionViewSchema,
  HumanEscalationSchema,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  OpenTagRunSchema,
  AcceptedProgressMetricsSchema,
  FactoryRecipeSnapshotInputSchema,
  FactoryRecipeSnapshotSchema,
  RoutingDecisionSchema,
  CallbackAttemptObservationReceiptEnvelopeV1Schema,
  CallbackIntentObservationReceiptEnvelopeV1Schema,
  CallbackProviderObservationReceiptEnvelopeV1Schema,
  computePermissionFencingTokenDigestV1,
  computePermissionRequestDigestV1,
  canonicalJsonStringify,
  CompletionAssessmentReceiptEnvelopeV1Schema,
  CompletionContractRefReceiptEnvelopeV1Schema,
  ControlErrorHttpResponseV1Schema,
  HumanPermissionDecisionHttpResponseV1Schema,
  HumanPermissionDecisionRequestV1Schema,
  PermissionResolutionCurrentHttpResponseV1Schema,
  RelayCapabilitiesResponseV1Schema,
  RunnerPermissionCurrentQueryV1Schema,
  RunnerPermissionRequestHttpResponseV1Schema,
  RunnerPermissionRequestV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  RunnerCredentialHttpResponseV1Schema,
  RunnerCredentialReprovisionRequestV1Schema,
  RunnerDirectoryEntrySchema,
  RunnerRegistrationRequestV1Schema,
  WorkThreadRefReceiptEnvelopeV1Schema,
  RunAdmissionDecisionSchema,
  WorkstreamAdmissionBatchInputSchema,
  WorkstreamAdmissionBatchReceiptSchema,
  WorkstreamEvaluationSchema,
  WorkstreamMetricsSchema,
  WorkstreamInputSchema,
  WorkstreamSchema,
  WorkLoopViewSchema,
  WorkThreadSchema,
  type ActorIdentity,
  type Action,
  type ActionPermissionRequest,
  type ActionPermissionResolution,
  type MaterialActionReceipt,
  type CompletionAssessment,
  type CompletionContract,
  type CompletionWaiver,
  type AcceptedProgressAttributionView,
  type HumanEscalation,
  type ActionHint,
  type AdapterMutationMapping,
  type ApprovalDecision,
  type ApplyPlan,
  type MutationIntentActionability,
  type OpenTagEvent,
  type OpenTagManagedChannelBindingOwnership,
  type OpenTagRun,
  type OpenTagRunResult,
  type AcceptedProgressMetrics,
  type FactoryRecipeSnapshot,
  type FactoryRecipeSnapshotInput,
  type PolicyRule,
  type ProposalLineage,
  type RoutingDecision,
  type RunnerCredentialReprovisionRequestV1,
  type RunnerCredentialResponseV1,
  type RunnerDirectoryEntry,
  type RunnerRegistrationRequestV1,
  type RunnerReadinessReceiptEnvelopeV1,
  type HumanPermissionDecisionRequestV1,
  type PermissionResolutionReceiptEnvelopeV1,
  type RunnerPermissionCurrentQueryV1,
  type RunnerPermissionRequestV1,
  type WorkThreadRefReceiptEnvelopeV1,
  type CompletionContractRefReceiptEnvelopeV1,
  type CompletionAssessmentReceiptEnvelopeV1,
  type RunnerRegistrationConfig,
  type RunnerRegistrationInput,
  type RunEventImportance,
  type RunEventVisibility,
  type SuggestedChangesSnapshot,
  type VerificationEvidence,
  type Workstream,
  type WorkstreamAdmissionBatchInput,
  type WorkstreamAdmissionBatchReceipt,
  type WorkstreamEvaluation,
  type WorkstreamInput,
  type WorkstreamMetrics,
  type WorkLoopView,
  type WorkThread
} from "@opentag/core";

export type {
  FactoryRecipeSnapshot,
  FactoryRecipeSnapshotInput,
  HumanPermissionDecisionRequestV1,
  PermissionResolutionReceiptEnvelopeV1,
  RunnerPermissionCurrentQueryV1,
  RunnerPermissionRequestV1,
  Workstream,
  WorkstreamAdmissionBatchInput,
  WorkstreamAdmissionBatchReceipt,
  WorkstreamEvaluation,
  WorkstreamInput,
  WorkstreamMetrics
} from "@opentag/core";

export type ClaimedOpenTagRun = {
  run: OpenTagRun;
  event: OpenTagEvent;
  attemptId: string;
  attemptNumber: number;
  fencingToken: string;
  executorId?: string;
  routingDecision?: RoutingDecision;
};

export type OpenTagRunRecord = Pick<ClaimedOpenTagRun, "run" | "event">;

export type CompletionEvidenceSummary = {
  id: string;
  kind: string;
  assurance: "verified" | "reported" | "unverifiable";
  subject: { provider: string; resourceRef: string; resourceVersion: string };
  claim: { predicate: string; outcome: string; observations?: Record<string, string> };
  observedAt: string;
  receivedAt: string;
};

export type CompletionExplanation = WorkLoopView & {
  contractSnapshot: CompletionContract;
  assessmentHistory: CompletionAssessment[];
  evidence: CompletionEvidenceSummary[];
  openHumanEscalations: HumanEscalation[];
};

export type WorkLoopAttentionItem = {
  workThread: EnsuredWorkThread;
  completion: WorkLoopView;
};

export type WorkLoopAttentionResult = {
  attention: "required";
  workLoops: WorkLoopAttentionItem[];
  scanned: number;
  scanLimitReached: boolean;
};

export type BoundedCompletionWaiverInput = Pick<
  CompletionWaiver,
  "actor" | "reason" | "scope" | "policyScope" | "gateIds" | "waivedAt" | "expiresAt"
>;

export type HumanEscalationActorInput = {
  escalationId: string;
  actor: ActorIdentity;
};

export type HumanEscalationResolutionInput = HumanEscalationActorInput & {
  optionId?: string;
  reason?: string;
  resolvedAt?: string;
};

export type HumanEscalationResolutionResult = {
  outcome: "resolved" | "duplicate";
  escalation: HumanEscalation;
  completion?: CompletionExplanation;
  resume: { required: true; reason: string; nextAction: string };
};

export type AttemptLease = Pick<ClaimedOpenTagRun, "attemptId" | "fencingToken">;

export type RepoBindingInput = {
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

export type RepositoryBindingConfig = {
  provider: string;
  owner: string;
  repo: string;
  checkoutPath: string;
  defaultExecutor?: string;
  fallbackRunnerIds?: string[];
  fallbackExecutorIds?: string[];
  baseBranch?: string;
  pushRemote?: string;
  worktreeRoot?: string;
  keepWorktree?: "always" | "on_failure" | "never";
};

export type SlackChannelBindingInput = {
  teamId: string;
  channelId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

type ChannelBindingRepositoryTarget =
  | { repoProvider: string; owner: string; repo: string }
  | { repoProvider?: never; owner?: never; repo?: never };

export type ChannelBindingInput = {
  provider: string;
  accountId: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
  ownership?: OpenTagManagedChannelBindingOwnership;
} & ChannelBindingRepositoryTarget;

type Assert<T extends true> = T;
type ChannelBindingRejectsPartialRepositoryTarget = Assert<
  { provider: string; accountId: string; conversationId: string; repoProvider: string } extends ChannelBindingInput ? false : true
>;

export type RunnerRegistration = RunnerRegistrationConfig & {
  createdAt: string;
  heartbeatAt?: string;
};

export type RegisterRunnerInput = Omit<RunnerRegistrationInput, "name"> & { name?: string };

export type ControlPlaneAlert = {
  id: string;
  type: string;
  severity: "info" | "warn" | "error";
  eventType: string;
  count: number;
  threshold: number;
  firstSeenAt: string;
  lastSeenAt: string;
  subject?: string;
  reason: string;
  nextAction: string;
};

export type RecordControlPlaneEventInput = {
  type: string;
  severity?: "info" | "warn" | "error";
  subject?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
};

export type GitHubCompletionEvidenceInput = {
  provider: "github";
  deliveryId: string;
  eventName: "pull_request" | "check_run" | "check_suite" | "status";
  repository: { owner: string; repo: string };
  pullRequest: {
    number: number;
    resourceRef: string;
    headSha: string;
    baseSha: string;
    baseBranch: string;
    state: "open" | "closed" | "merged";
  };
  checks: Record<string, "passed" | "failed" | "pending">;
  observedAt: string;
  payloadDigest: string;
};

export type GitHubCompletionReconciliationEscalationInput = {
  operation: "open" | "resolve";
  escalation: Pick<HumanEscalation, "audience" | "subjectRef" | "summary" | "reason"> & {
    class: "reconciliation";
    audience: "repo_owner";
    state: "open" | "resolved";
    blocking: true;
    dedupeKey: string;
  };
  correlation: {
    provider: "github";
    deliveryId: string;
    eventName: "pull_request" | "check_run" | "check_suite" | "status";
    repository: { owner: string; repo: string };
    pullRequestNumbers: number[];
    headSha?: string;
  };
};

export type PruneSourceDeliveriesInput = {
  olderThan: string;
  limit?: number;
};

export type SourceDeliveryPruneResult = {
  scanned: number;
  pruned: number;
  retainedActive: number;
};

export type ControlCredential =
  | { kind: "bootstrap_pairing"; token: string }
  | { kind: "recovery_pairing"; token: string }
  | { kind: "operator"; token: string }
  | { kind: "approver"; token: string }
  | { kind: "runtime"; token: string };

export type RelayCapabilitiesResponseV1 = typeof RelayCapabilitiesResponseV1Schema._output;
export type CallbackIntentObservationReceiptEnvelopeV1 =
  typeof CallbackIntentObservationReceiptEnvelopeV1Schema._output;
export type CallbackAttemptObservationReceiptEnvelopeV1 =
  typeof CallbackAttemptObservationReceiptEnvelopeV1Schema._output;
export type CallbackProviderObservationReceiptEnvelopeV1 =
  typeof CallbackProviderObservationReceiptEnvelopeV1Schema._output;
export type CallbackObservationReceiptEnvelopeV1 =
  | CallbackIntentObservationReceiptEnvelopeV1
  | CallbackAttemptObservationReceiptEnvelopeV1
  | CallbackProviderObservationReceiptEnvelopeV1;

export type ControlReceiptResult<T> =
  | { status: 201; replayed: false; outcome: "accepted"; receipt: T }
  | { status: 200; replayed: true; outcome: "accepted"; receipt: T };

export type CallbackObservationControlReceiptResult =
  | ControlReceiptResult<CallbackObservationReceiptEnvelopeV1>
  | {
      status: 202;
      replayed: false;
      outcome: "outcome_unknown";
      receipt: CallbackObservationReceiptEnvelopeV1;
    };

export type RunnerPermissionRequestControlV1Result = {
  status: 202;
  outcome: "waiting";
  receipt: PermissionResolutionReceiptEnvelopeV1;
};

export type HumanPermissionDecisionControlV1Result = {
  status: 200;
  outcome: "resolved";
  receipt: PermissionResolutionReceiptEnvelopeV1;
};

export type PermissionResolutionCurrentControlV1Result =
  | RunnerPermissionRequestControlV1Result
  | HumanPermissionDecisionControlV1Result;

export type OpenTagClientOptions = {
  dispatcherUrl: string;
  pairingToken?: string;
  controlCredential?: ControlCredential;
  channelPrincipalCredential?: string;
  fetchImpl?: typeof fetch;
};

export type RunnerClientOptions = OpenTagClientOptions & {
  runnerId: string;
};

export type RunProgressInput = {
  type?: string;
  message: string;
  at?: string;
  visibility?: RunEventVisibility;
  importance?: RunEventImportance;
  idempotencyKey?: string;
};

export type ReconcileMaterialActionInput = {
  actionId: string;
  outcome: "succeeded" | "failed";
  idempotencyKey: string;
  receiptRef: string;
  evidence?: VerificationEvidence[];
};

export type RunTimeoutPolicy = {
  hardTimeoutMs?: number;
};

export type CreateRunInput = {
  runId: string;
  event: OpenTagEvent;
};

export type EnsuredWorkThread = WorkThread & { id: string };

export type EnsureWorkThreadResult = {
  workThread: EnsuredWorkThread;
  created: boolean;
};

export type CreateRunResult =
  | {
      outcome: "run_created";
      decision: import("@opentag/core").RunAdmissionDecision;
      run: OpenTagRun;
      idempotentReplay?: boolean;
    }
  | {
      outcome: "follow_up_queued";
      decision: import("@opentag/core").RunAdmissionDecision;
      followUpRequest: import("@opentag/core").FollowUpRequest;
    }
  | {
      outcome: "needs_human_decision";
      decision: import("@opentag/core").RunAdmissionDecision;
      escalation?: HumanEscalation;
      resolutionUnavailableReason?: string;
    };

export type CompleteRunInput = {
  runnerId: string;
  runId: string;
  attemptId: string;
  fencingToken: string;
  result: OpenTagRunResult;
  idempotencyKey?: string;
};

export type ApprovalDecisionInput = {
  id?: string;
  approvedIntentIds: string[];
  rejectedIntentIds?: string[];
  approvedBy: ActorIdentity;
  approvedAt?: string;
  scope?: "manual" | "policy";
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type ApplyPlanInput = {
  id?: string;
  approvalDecisionId: string;
  selectedIntentIds?: string[];
  adapter?: string;
  execute?: boolean;
};

export type ChildRunInput = {
  runId: string;
  action: ActionHint;
  commandText?: string;
  sourceProposalId?: string;
  sourceApplyPlanId?: string;
};

export type ThreadActionInput = {
  id?: string;
  rawText: string;
  actor: ActorIdentity;
  callback: {
    provider: string;
    uri: string;
    threadKey?: string;
  };
  metadata?: Record<string, unknown>;
};

export type ThreadActionResult = {
  outcome: string;
  message?: string;
  decision?: ApprovalDecision;
  plan?: ApplyPlan;
  run?: OpenTagRun;
};

export type CancelRunResult = {
  outcome: "cancelled";
  run: OpenTagRun;
};

export type ChannelRuntimeStatus = {
  binding: ChannelBindingInput;
  activeRun?: OpenTagRun;
  activeEvent?: OpenTagEvent;
  runTimeoutPolicy?: RunTimeoutPolicy;
  queuedFollowUps: import("@opentag/core").FollowUpRequest[];
};

export type RunMetrics = {
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
  applyOutcomeCounts: {
    applied: number;
    skipped: number;
    failed: number;
    stale: number;
    unsupported: number;
  };
  staleIntentCount: number;
};

export type AggregateMetrics = Omit<RunMetrics, "runId"> & {
  scope: "repo" | "work_thread";
  scopeId: string;
  runCount: number;
};

export type LinearRelayInstallationInput = {
  id: string;
  webhookPath: string;
  webhookSecret: string;
  token: string;
  auth?:
    | { method: "api_key" }
    | {
        method: "oauth_app";
        actor: "app";
        clientId?: string;
        refreshToken?: string;
        accessTokenExpiresAt?: string;
        scopes?: string[];
      };
  graphqlUrl?: string;
  repoProvider: string;
  owner: string;
  repo: string;
  organizationId?: string;
  teamId?: string;
  teamKey?: string;
};

export type CreateLinearOAuthInstallationInput = {
  repoProvider?: string;
  owner: string;
  repo: string;
  teamId?: string;
  teamKey?: string;
  graphqlUrl?: string;
  redirectUri?: string;
  scopes?: string[];
};

export type LinearRelayInstallationSummary = {
  id: string;
  webhookPath: string;
  projectTarget: {
    repoProvider: string;
    owner: string;
    repo: string;
  };
  graphqlUrl?: string;
  organizationId?: string;
  teamId?: string;
  teamKey?: string;
};

export type LinearOAuthInstallationStart = {
  authorizationUrl: string;
  stateExpiresAt: string;
  oauthWebhookPath?: string;
  installation: LinearRelayInstallationSummary;
};

export type OpenTagClient = {
  getRelayCapabilitiesControlV1(): Promise<RelayCapabilitiesResponseV1>;
  registerRunner(input: RegisterRunnerInput): Promise<void>;
  registerRunnerControlV1(input: RunnerRegistrationRequestV1): Promise<RunnerCredentialResponseV1>;
  reprovisionRunnerControlV1(input: RunnerCredentialReprovisionRequestV1): Promise<RunnerCredentialResponseV1>;
  reportRunnerReadinessControlV1(input: RunnerReadinessReceiptEnvelopeV1): Promise<ControlReceiptResult<RunnerReadinessReceiptEnvelopeV1>>;
  requestActionPermissionControlV1(input: RunnerPermissionRequestV1): Promise<RunnerPermissionRequestControlV1Result>;
  resolveActionPermissionControlV1(input: { runnerId: string; decision: HumanPermissionDecisionRequestV1 }): Promise<HumanPermissionDecisionControlV1Result>;
  getActionPermissionCurrentControlV1(input: RunnerPermissionCurrentQueryV1): Promise<PermissionResolutionCurrentControlV1Result>;
  projectWorkThreadRefControlV1(input: WorkThreadRefReceiptEnvelopeV1): Promise<ControlReceiptResult<WorkThreadRefReceiptEnvelopeV1>>;
  projectCompletionContractRefControlV1(input: CompletionContractRefReceiptEnvelopeV1): Promise<ControlReceiptResult<CompletionContractRefReceiptEnvelopeV1>>;
  projectCompletionAssessmentControlV1(input: CompletionAssessmentReceiptEnvelopeV1): Promise<ControlReceiptResult<CompletionAssessmentReceiptEnvelopeV1>>;
  projectCallbackObservationControlV1(input: CallbackObservationReceiptEnvelopeV1): Promise<CallbackObservationControlReceiptResult>;
  getRunner(input: { runnerId: string }): Promise<{ runner: RunnerRegistration }>;
  listRunners(): Promise<{ runners: RunnerDirectoryEntry[] }>;
  listControlPlaneAlerts(input?: { limit?: number; since?: string }): Promise<{ alerts: ControlPlaneAlert[] }>;
  recordControlPlaneEvent(input: RecordControlPlaneEventInput): Promise<void>;
  ingestGitHubCompletionEvidence(input: GitHubCompletionEvidenceInput): Promise<void>;
  requestGitHubCompletionReconciliationEscalation(input: GitHubCompletionReconciliationEscalationInput): Promise<void>;
  pruneSourceDeliveries(input: PruneSourceDeliveriesInput): Promise<SourceDeliveryPruneResult>;
  bindRepository(input: RepoBindingInput): Promise<void>;
  getRepositoryBinding(input: { provider: string; owner: string; repo: string }): Promise<{ binding: RepoBindingInput }>;
  upsertRepoPolicyRule(input: { provider: string; owner: string; repo: string; rule: PolicyRule }): Promise<{ rule: PolicyRule }>;
  listRepoPolicyRules(input: { provider: string; owner: string; repo: string }): Promise<{ rules: PolicyRule[] }>;
  upsertRepoMutationMapping(input: {
    provider: string;
    owner: string;
    repo: string;
    mapping: AdapterMutationMapping;
  }): Promise<{ mapping: AdapterMutationMapping }>;
  listRepoMutationMappings(input: { provider: string; owner: string; repo: string }): Promise<{ mappings: AdapterMutationMapping[] }>;
  createLinearOAuthInstallation(input: CreateLinearOAuthInstallationInput): Promise<LinearOAuthInstallationStart>;
  upsertLinearRelayInstallation(input: LinearRelayInstallationInput): Promise<{ installation: LinearRelayInstallationSummary }>;
  bindChannel(input: ChannelBindingInput, options?: { adminOverride?: boolean }): Promise<void>;
  getChannelBinding(input: { provider: string; accountId: string; conversationId: string }): Promise<{ binding: ChannelBindingInput }>;
  getChannelRuntimeStatus(input: { provider: string; accountId: string; conversationId: string }): Promise<ChannelRuntimeStatus>;
  unbindChannel(input: { provider: string; accountId: string; conversationId: string }): Promise<void>;
  bindSlackChannel(input: SlackChannelBindingInput): Promise<void>;
  getSlackChannelBinding(input: { teamId: string; channelId: string }): Promise<{ binding: SlackChannelBindingInput }>;
  ensureWorkThread(input: OpenTagEvent): Promise<EnsureWorkThreadResult>;
  createFactoryRecipeSnapshot(input: FactoryRecipeSnapshotInput): Promise<{ recipe: FactoryRecipeSnapshot }>;
  getFactoryRecipeSnapshot(input: { id: string; version: number }): Promise<{ recipe: FactoryRecipeSnapshot }>;
  createWorkstream(input: WorkstreamInput): Promise<{ workstream: Workstream }>;
  getWorkstream(input: { id: string }): Promise<{ workstream: Workstream }>;
  createWorkstreamAdmissionBatch(input: WorkstreamAdmissionBatchInput): Promise<{ receipt: WorkstreamAdmissionBatchReceipt }>;
  getWorkstreamAdmissionBatch(input: { id: string }): Promise<{ receipt: WorkstreamAdmissionBatchReceipt }>;
  getWorkstreamMetrics(input: { id: string }): Promise<{ metrics: WorkstreamMetrics }>;
  getWorkstreamEvaluation(input: { id: string }): Promise<{ evaluation: WorkstreamEvaluation }>;
  createRun(input: CreateRunInput): Promise<CreateRunResult>;
  getFollowUpRequest(input: { id: string }): Promise<{ followUpRequest: import("@opentag/core").FollowUpRequest }>;
  createRunFromFollowUpRequest(input: { id: string; runId: string }): Promise<{ followUpRequest: import("@opentag/core").FollowUpRequest; run: OpenTagRun }>;
  claim(input: { runnerId: string }): Promise<ClaimedOpenTagRun | null>;
  heartbeat(input: { runnerId: string; runId: string } & AttemptLease): Promise<void>;
  rejectAttemptStart(input: { runnerId: string; runId: string; executorId: string; reason: string } & AttemptLease): Promise<void>;
  requestActionPermission(input: { runnerId: string; runId: string } & AttemptLease & { request: ActionPermissionRequest }): Promise<ActionPermissionResolution>;
  resolveActionPermission(input: { runnerId: string; runId: string; actionId: string } & AttemptLease): Promise<ActionPermissionResolution>;
  recordMaterialActionReceipt(input: { runnerId: string; runId: string; actionId: string; receipt: MaterialActionReceipt } & AttemptLease): Promise<ActionPermissionResolution>;
  reconcileMaterialAction(input: ReconcileMaterialActionInput): Promise<{ action: Action; replayed: boolean }>;
  markRunning(input: {
    runnerId: string;
    runId: string;
    attemptId: string;
    fencingToken: string;
    executor: string;
    executorCapability?: Record<string, unknown>;
    runTimeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<void>;
  progress(input: { runnerId: string; runId: string } & AttemptLease & RunProgressInput): Promise<void>;
  complete(input: CompleteRunInput): Promise<void>;
  cancelRun(input: { runId: string; reason?: string; requestedBy?: string }): Promise<CancelRunResult>;
  cancelActiveChannelRun(input: {
    provider: string;
    accountId: string;
    conversationId: string;
    reason?: string;
    requestedBy?: string;
  }): Promise<CancelRunResult>;
  getRun(input: { runId: string }): Promise<OpenTagRunRecord>;
  getCompletion(input: { runId: string }): Promise<{ completion: CompletionExplanation }>;
  getWorkThreadCompletion(input: { workThreadId: string }): Promise<{
    workThread: EnsuredWorkThread;
    completion: CompletionExplanation;
    acceptedProgress: AcceptedProgressAttributionView | null;
  }>;
  listWorkLoopsRequiringAttention(input?: { limit?: number }): Promise<WorkLoopAttentionResult>;
  listHumanEscalations(input: { runId: string }): Promise<{
    escalations: HumanEscalation[];
    resolutionUnavailableReason?: string;
  }>;
  acknowledgeHumanEscalation(input: HumanEscalationActorInput & { acknowledgedAt?: string }): Promise<{
    outcome: "acknowledged" | "duplicate";
    escalation: HumanEscalation;
  }>;
  resolveHumanEscalation(input: HumanEscalationResolutionInput): Promise<HumanEscalationResolutionResult>;
  waiveCompletion(input: { runId: string; waiver: BoundedCompletionWaiverInput }): Promise<{
    outcome: "recorded" | "duplicate" | "conflict";
    completion: CompletionExplanation;
    waiver: CompletionWaiver;
  }>;
  listRunEvents(input: { runId: string }): Promise<{ events: unknown[] }>;
  getRunLedger(input: { runId: string }): Promise<{ ledger: { runId: string; entries: unknown[] } }>;
  getRunMetrics(input: { runId: string }): Promise<{ metrics: RunMetrics }>;
  getRepoMetrics(input: { provider: string; owner: string; repo: string }): Promise<{ metrics: AggregateMetrics }>;
  getWorkThreadMetrics(input: { threadId: string }): Promise<{ metrics: AggregateMetrics }>;
  getAcceptedProgressMetrics(): Promise<{ metrics: AcceptedProgressMetrics }>;
  getProposal(input: { proposalId: string }): Promise<{ runId: string; snapshot: SuggestedChangesSnapshot }>;
  getProposalLineage(input: { proposalId: string }): Promise<{ lineage: ProposalLineage }>;
  listCurrentMutationIntents(input: { proposalId: string }): Promise<{ intents: MutationIntentActionability[] }>;
  approveProposal(input: { proposalId: string } & ApprovalDecisionInput): Promise<{ decision: ApprovalDecision }>;
  getApprovalDecision(input: { approvalDecisionId: string }): Promise<{ decision: ApprovalDecision }>;
  createApplyPlan(input: { proposalId: string } & ApplyPlanInput): Promise<{ plan: ApplyPlan }>;
  getApplyPlan(input: { applyPlanId: string }): Promise<{ plan: ApplyPlan }>;
  createChildRun(input: { parentRunId: string } & ChildRunInput): Promise<{ run: OpenTagRun }>;
  submitThreadAction(input: ThreadActionInput): Promise<ThreadActionResult>;
};

export type DispatcherRunnerClient = {
  claim(): Promise<ClaimedOpenTagRun | null>;
  markRunning(
    runId: string,
    executor: string,
    lease: AttemptLease,
    options?: { executorCapability?: Record<string, unknown>; runTimeoutMs?: number; idempotencyKey?: string }
  ): Promise<void>;
  rejectAttemptStart(runId: string, executorId: string, reason: string, lease: AttemptLease): Promise<void>;
  heartbeat(runId: string, lease: AttemptLease): Promise<void>;
  requestActionPermission(runId: string, lease: AttemptLease, request: ActionPermissionRequest): Promise<ActionPermissionResolution>;
  resolveActionPermission(runId: string, lease: AttemptLease, actionId: string): Promise<ActionPermissionResolution>;
  recordMaterialActionReceipt(runId: string, lease: AttemptLease, actionId: string, receipt: MaterialActionReceipt): Promise<ActionPermissionResolution>;
  progress(runId: string, lease: AttemptLease, input: RunProgressInput & { type: string; at: string }): Promise<void>;
  complete(runId: string, lease: AttemptLease, result: OpenTagRunResult, options?: { idempotencyKey?: string }): Promise<void>;
};

export class OpenTagClientHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(action: string, status: number, responseBody: string) {
    super(`${action} failed: ${status}${responseBody ? ` ${responseBody}` : ""}`);
    this.name = "OpenTagClientHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

type RunnerCredentialControlV1HttpResponse = ReturnType<
  typeof RunnerCredentialHttpResponseV1Schema.parse
>;
type RunnerCredentialControlV1ErrorResponse = Exclude<
  RunnerCredentialControlV1HttpResponse,
  { status: 200 | 201 }
>;

export class OpenTagControlV1HttpError extends Error {
  readonly status: RunnerCredentialControlV1ErrorResponse["status"];
  readonly code: RunnerCredentialControlV1ErrorResponse["body"]["error"];
  readonly requestId: string;
  readonly retryAfterSeconds?: number;

  constructor(
    action: string,
    status: RunnerCredentialControlV1ErrorResponse["status"],
    code: RunnerCredentialControlV1ErrorResponse["body"]["error"],
    requestId: string,
    retryAfterSeconds?: number
  ) {
    super(`${action} failed: ${status} ${code} requestId=${requestId}`);
    this.name = "OpenTagControlV1HttpError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

function baseUrlFrom(dispatcherUrl: string): string {
  return dispatcherUrl.replace(/\/$/, "");
}

function authHeaders(pairingToken: string | undefined): Record<string, string> {
  return pairingToken ? { authorization: `Bearer ${pairingToken}` } : {};
}

function jsonHeaders(pairingToken: string | undefined): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders(pairingToken) };
}

function requireControlCredential(
  credential: ControlCredential | undefined,
  requiredKind: ControlCredential["kind"]
): string {
  const actualKind = credential?.kind ?? "missing";
  if (
    !credential
    || credential.kind !== requiredKind
    || typeof credential.token !== "string"
    || credential.token.trim().length === 0
  ) {
    throw new Error(
      `Control credential rejected: required=${requiredKind} actual=${actualKind}`
    );
  }
  return credential.token;
}

function parseRunTimeoutPolicy(value: unknown): RunTimeoutPolicy {
  if (!value || typeof value !== "object") return {};
  const hardTimeoutMs = (value as { hardTimeoutMs?: unknown }).hardTimeoutMs;
  if (hardTimeoutMs === undefined) return {};
  return typeof hardTimeoutMs === "number" && Number.isInteger(hardTimeoutMs) && hardTimeoutMs > 0 ? { hardTimeoutMs } : {};
}

function parseCompletionExplanation(value: unknown): CompletionExplanation {
  const completion = WorkLoopViewSchema.passthrough().parse(value) as CompletionExplanation;
  return {
    ...completion,
    contractSnapshot: CompletionContractSchema.parse(completion.contractSnapshot),
    currentAssessment: CompletionAssessmentSchema.parse(completion.currentAssessment),
    assessmentHistory: completion.assessmentHistory.map((assessment) => CompletionAssessmentSchema.parse(assessment)),
    openHumanEscalations: completion.openHumanEscalations.map((escalation) => HumanEscalationSchema.parse(escalation))
  };
}

function parseEnsuredWorkThread(value: unknown): EnsuredWorkThread {
  const workThread = WorkThreadSchema.parse(value);
  if (!workThread.id) throw new Error("WorkThread response is missing its durable id.");
  return workThread as EnsuredWorkThread;
}

function parseHumanEscalationResume(value: unknown): HumanEscalationResolutionResult["resume"] {
  const resume = value as { required?: unknown; reason?: unknown; nextAction?: unknown } | null;
  if (
    !resume
    || resume.required !== true
    || typeof resume.reason !== "string"
    || resume.reason.length === 0
    || typeof resume.nextAction !== "string"
    || resume.nextAction.length === 0
  ) {
    throw new Error("resolveHumanEscalation returned an invalid resume contract.");
  }
  return { required: true, reason: resume.reason, nextAction: resume.nextAction };
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    throw new OpenTagClientHttpError(action, response.status, text);
  }
}

type StrictControlSchema<T> = {
  parse(value: unknown): T;
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false };
};

function assertControlResponseBoundary(
  response: Response,
  action: string,
  trustedOrigin: string
): void {
  if (
    response.redirected
    || response.type === "opaqueredirect"
    || (response.status >= 300 && response.status < 400)
  ) {
    throw new OpenTagClientHttpError(action, response.status, "redirect_rejected");
  }
  if (!response.url) {
    throw new OpenTagClientHttpError(action, response.status, "response_origin_unverifiable");
  }
  let responseOrigin: string;
  try {
    responseOrigin = new URL(response.url).origin;
  } catch {
    throw new OpenTagClientHttpError(action, response.status, "response_origin_mismatch");
  }
  if (responseOrigin !== trustedOrigin) {
    throw new OpenTagClientHttpError(action, response.status, "response_origin_mismatch");
  }
}

async function parseControlJson(
  response: Response,
  action: string,
  trustedOrigin: string
): Promise<unknown> {
  assertControlResponseBoundary(response, action, trustedOrigin);
  try {
    return await response.json();
  } catch {
    throw new OpenTagClientHttpError(action, response.status, "invalid_json_response");
  }
}

function throwControlV1Error(
  response: Response,
  body: unknown,
  action: string,
  expectedRequestId?: string
): never {
  const error = ControlErrorHttpResponseV1Schema.safeParse({
    status: response.status,
    body
  });
  if (!error.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  if (expectedRequestId !== undefined && error.data.body.requestId !== expectedRequestId) {
    throw new OpenTagClientHttpError(action, response.status, "response_identity_mismatch");
  }
  if (error.data.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== String(error.data.body.retryAfterSeconds)) {
      throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
    }
  }
  throw new OpenTagControlV1HttpError(
    action,
    error.data.status,
    error.data.body.error,
    expectedRequestId ?? "unavailable",
    error.data.status === 429 ? error.data.body.retryAfterSeconds : undefined
  );
}

async function parseControlReceiptResponse<T extends {
  receiptId: string;
  organizationId: string;
  operationId: string;
  receiptDigest: string;
}>(
  response: Response,
  action: string,
  trustedOrigin: string,
  request: T,
  schema: StrictControlSchema<T>,
  isUnknownResponse?: (receipt: T) => boolean
): Promise<ControlReceiptResult<T> | {
  status: 202;
  replayed: false;
  outcome: "outcome_unknown";
  receipt: T;
}> {
  const body = await parseControlJson(response, action, trustedOrigin);
  if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
    throwControlV1Error(response, body, action);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  if (canonicalJsonStringify(parsed.data) !== canonicalJsonStringify(request)) {
    throw new OpenTagClientHttpError(action, response.status, "response_identity_mismatch");
  }
  if (response.status === 202 && !isUnknownResponse?.(parsed.data)) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  if (response.status === 200) {
    return { status: 200, replayed: true, outcome: "accepted", receipt: parsed.data };
  }
  if (response.status === 201) {
    return { status: 201, replayed: false, outcome: "accepted", receipt: parsed.data };
  }
  return {
    status: 202,
    replayed: false,
    outcome: "outcome_unknown",
    receipt: parsed.data
  };
}

type PermissionResolutionExpectedIdentity = {
  operationId?: string;
  organizationId: string;
  runId: string;
  attemptId: string;
  attemptNumber?: number;
  epoch?: number;
  fencingTokenDigest?: string;
  actionId: string;
  permissionRequestId: string;
  permissionRequestDigest: string;
  policySnapshotDigest?: string;
  decisionId?: string;
  decision?: "allow_once" | "deny";
  decidedAt?: string;
};

async function canonicalSha256Digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJsonStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function assertPermissionResolutionDigests(
  receipt: PermissionResolutionReceiptEnvelopeV1,
  action: string,
  status: number
): Promise<void> {
  const expectedPayloadDigest = await canonicalSha256Digest(receipt.payload);
  const { receiptDigest: _receiptDigest, ...receiptDigestInput } = receipt;
  const expectedReceiptDigest = await canonicalSha256Digest(receiptDigestInput);
  if (
    receipt.payloadDigest !== expectedPayloadDigest
    || receipt.receiptDigest !== expectedReceiptDigest
  ) {
    throw new OpenTagClientHttpError(action, status, "invalid_control_v1_response");
  }
}

function assertPermissionResolutionIdentity(
  receipt: PermissionResolutionReceiptEnvelopeV1,
  expected: PermissionResolutionExpectedIdentity,
  action: string,
  status: number
): void {
  if (
    (expected.operationId !== undefined && receipt.operationId !== expected.operationId)
    || receipt.organizationId !== expected.organizationId
    || receipt.runId !== expected.runId
    || receipt.attempt.attemptId !== expected.attemptId
    || (expected.attemptNumber !== undefined
      && receipt.attempt.attemptNumber !== expected.attemptNumber)
    || (expected.epoch !== undefined && receipt.attempt.epoch !== expected.epoch)
    || (expected.fencingTokenDigest !== undefined
      && receipt.attempt.fencingTokenDigest !== expected.fencingTokenDigest)
    || receipt.payload.actionId !== expected.actionId
    || receipt.payload.permissionRequestId !== expected.permissionRequestId
    || receipt.payload.permissionRequestDigest !== expected.permissionRequestDigest
    || (expected.policySnapshotDigest !== undefined
      && receipt.payload.policySnapshotDigest !== expected.policySnapshotDigest)
    || (expected.decisionId !== undefined && receipt.payload.decisionRef !== expected.decisionId)
    || (expected.decision !== undefined && receipt.payload.decision !== expected.decision)
    || (expected.decidedAt !== undefined && receipt.payload.decidedAt !== expected.decidedAt)
  ) {
    throw new OpenTagClientHttpError(action, status, "response_identity_mismatch");
  }
}

async function parseRunnerPermissionRequestControlV1Response(
  response: Response,
  action: string,
  trustedOrigin: string,
  request: RunnerPermissionRequestV1
): Promise<RunnerPermissionRequestControlV1Result> {
  const body = await parseControlJson(response, action, trustedOrigin);
  if (response.status !== 202) {
    throwControlV1Error(response, body, action, request.requestId);
  }
  const parsed = RunnerPermissionRequestHttpResponseV1Schema.safeParse({ status: response.status, body });
  if (!parsed.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  const receipt = parsed.data.body;
  await assertPermissionResolutionDigests(receipt, action, response.status);
  assertPermissionResolutionIdentity(receipt, {
    operationId: request.operationId,
    organizationId: request.organizationId,
    runId: request.runId,
    attemptId: request.attempt.attemptId,
    attemptNumber: request.attempt.attemptNumber,
    epoch: request.attempt.epoch,
    fencingTokenDigest: request.attempt.fencingTokenDigest,
    actionId: request.actionId,
    permissionRequestId: request.permissionRequestId,
    permissionRequestDigest: request.permissionRequestDigest,
    policySnapshotDigest: request.policySnapshotDigest,
  }, action, response.status);
  if (
    receipt.payload.actionFamily !== request.actionFamily
    || receipt.payload.riskTier !== request.riskTier
    || receipt.payload.targetFingerprint !== request.targetFingerprint
    || canonicalJsonStringify(receipt.payload.permissionScopes)
      !== canonicalJsonStringify(request.permissionScopes)
    || receipt.payload.policySnapshotRef !== request.policySnapshotRef
    || receipt.payload.requestedAt !== request.requestedAt
  ) {
    throw new OpenTagClientHttpError(action, response.status, "response_identity_mismatch");
  }
  return { status: 202, outcome: "waiting", receipt };
}

async function parseHumanPermissionDecisionControlV1Response(
  response: Response,
  action: string,
  trustedOrigin: string,
  request: HumanPermissionDecisionRequestV1
): Promise<HumanPermissionDecisionControlV1Result> {
  const body = await parseControlJson(response, action, trustedOrigin);
  if (response.status !== 200) {
    throwControlV1Error(response, body, action, request.requestId);
  }
  const parsed = HumanPermissionDecisionHttpResponseV1Schema.safeParse({ status: response.status, body });
  if (!parsed.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  const receipt = parsed.data.body;
  await assertPermissionResolutionDigests(receipt, action, response.status);
  assertPermissionResolutionIdentity(receipt, {
    operationId: request.operationId,
    organizationId: request.organizationId,
    runId: request.runId,
    attemptId: request.attempt.attemptId,
    attemptNumber: request.attempt.attemptNumber,
    epoch: request.attempt.epoch,
    fencingTokenDigest: request.attempt.fencingTokenDigest,
    actionId: request.actionId,
    permissionRequestId: request.permissionRequestId,
    permissionRequestDigest: request.permissionRequestDigest,
    policySnapshotDigest: request.policySnapshotDigest,
    decisionId: request.decisionId,
    decision: request.decision,
    decidedAt: request.decidedAt,
  }, action, response.status);
  return { status: 200, outcome: "resolved", receipt };
}

async function parsePermissionResolutionCurrentControlV1Response(
  response: Response,
  action: string,
  trustedOrigin: string,
  query: RunnerPermissionCurrentQueryV1
): Promise<PermissionResolutionCurrentControlV1Result> {
  const body = await parseControlJson(response, action, trustedOrigin);
  if (response.status !== 200 && response.status !== 202) {
    throwControlV1Error(response, body, action);
  }
  const parsed = PermissionResolutionCurrentHttpResponseV1Schema.safeParse({
    status: response.status,
    body,
  });
  if (!parsed.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  const receipt = parsed.data.body;
  await assertPermissionResolutionDigests(receipt, action, response.status);
  assertPermissionResolutionIdentity(receipt, {
    ...query,
    attemptId: query.attempt.attemptId,
    attemptNumber: query.attempt.attemptNumber,
    epoch: query.attempt.epoch,
    fencingTokenDigest: query.attempt.fencingTokenDigest,
  }, action, response.status);
  return response.status === 202
    ? { status: 202, outcome: "waiting", receipt }
    : { status: 200, outcome: "resolved", receipt };
}

async function parseRunnerCredentialControlV1Response(
  response: Response,
  action: string,
  trustedOrigin: string,
  expected: {
    requestId: string;
    operationId: string;
    runnerId: string;
    registrationGeneration: number;
    credentialGeneration: number;
  }
): Promise<RunnerCredentialResponseV1> {
  const body = await parseControlJson(response, action, trustedOrigin);

  const envelope = RunnerCredentialHttpResponseV1Schema.safeParse({
    status: response.status,
    body
  });
  if (!envelope.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }

  if (envelope.data.status !== 200 && envelope.data.status !== 201) {
    throwControlV1Error(response, body, action, expected.requestId);
  }

  if (
    envelope.data.body.operationId !== expected.operationId
    || envelope.data.body.runnerId !== expected.runnerId
  ) {
    throw new OpenTagClientHttpError(action, response.status, "response_identity_mismatch");
  }
  if (
    envelope.data.body.registrationGeneration !== expected.registrationGeneration
    || envelope.data.body.credentialGeneration !== expected.credentialGeneration
  ) {
    throw new OpenTagClientHttpError(action, response.status, "response_generation_mismatch");
  }
  return envelope.data.body;
}

function parseSourceDeliveryPruneResult(value: unknown): SourceDeliveryPruneResult {
  const result = value as Partial<SourceDeliveryPruneResult> | null;
  if (
    !result ||
    typeof result.scanned !== "number" ||
    typeof result.pruned !== "number" ||
    typeof result.retainedActive !== "number"
  ) {
    throw new Error("pruneSourceDeliveries returned an invalid response.");
  }
  return {
    scanned: result.scanned,
    pruned: result.pruned,
    retainedActive: result.retainedActive
  };
}

function parseClaimedRun(body: {
  run: unknown;
  event: unknown;
  attemptId?: unknown;
  attemptNumber?: unknown;
  fencingToken?: unknown;
  executorId?: unknown;
  routingDecision?: unknown;
}): ClaimedOpenTagRun {
  if (typeof body.attemptId !== "string" || !body.attemptId || typeof body.fencingToken !== "string" || !body.fencingToken) {
    throw new Error("claim returned an invalid attempt lease.");
  }
  if (typeof body.attemptNumber !== "number" || !Number.isInteger(body.attemptNumber) || body.attemptNumber < 1) {
    throw new Error("claim returned an invalid attempt number.");
  }
  if (body.executorId !== undefined && (typeof body.executorId !== "string" || !body.executorId)) {
    throw new Error("claim returned an invalid executor placement.");
  }
  return {
    run: OpenTagRunSchema.parse(body.run),
    event: OpenTagEventSchema.parse(body.event),
    attemptId: body.attemptId,
    attemptNumber: body.attemptNumber,
    fencingToken: body.fencingToken,
    ...(body.executorId ? { executorId: body.executorId } : {}),
    ...(body.routingDecision !== undefined ? { routingDecision: RoutingDecisionSchema.parse(body.routingDecision) } : {})
  };
}

export function createOpenTagClient(options: OpenTagClientOptions): OpenTagClient {
  const baseUrl = baseUrlFrom(options.dispatcherUrl);
  let trustedControlOrigin: string;
  try {
    trustedControlOrigin = new URL(baseUrl).origin;
  } catch {
    throw new Error("OpenTag dispatcher URL is invalid.");
  }
  const baseFetch = options.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = (url, init) => {
    if (!options.channelPrincipalCredential) return baseFetch(url, init);
    const headers = new Headers(init?.headers);
    headers.set("x-opentag-channel-principal", options.channelPrincipalCredential);
    return baseFetch(url, { ...init, headers });
  };
  const controlFetch = async (
    url: string,
    init: RequestInit,
    action: string
  ): Promise<Response> => {
    try {
      return await baseFetch(url, { ...init, redirect: "manual" });
    } catch {
      throw new OpenTagClientHttpError(action, 0, "transport_failed");
    }
  };

  return {
    async getRelayCapabilitiesControlV1() {
      const action = "getRelayCapabilitiesControlV1";
      const response = await controlFetch(
        `${baseUrl}/v1/relay/capabilities`,
        { method: "GET" },
        action
      );
      const body = await parseControlJson(response, action, trustedControlOrigin);
      if (response.status !== 200) {
        throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
      }
      const parsed = RelayCapabilitiesResponseV1Schema.safeParse(body);
      if (!parsed.success) {
        throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
      }
      return parsed.data;
    },

    async registerRunner(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ ...input, name: input.name ?? input.runnerId })
      });
      await assertOk(response, "registerRunner");
    },

    async registerRunnerControlV1(input) {
      const request = RunnerRegistrationRequestV1Schema.parse(input);
      const controlToken = requireControlCredential(
        options.controlCredential,
        "bootstrap_pairing"
      );
      const action = "registerRunnerControlV1";
      const response = await controlFetch(`${baseUrl}/v1/runners`, {
        method: "POST",
        headers: jsonHeaders(controlToken),
        body: JSON.stringify(request)
      }, action);
      return parseRunnerCredentialControlV1Response(
        response,
        action,
        trustedControlOrigin,
        {
          ...request,
          registrationGeneration: 1,
          credentialGeneration: 1
        }
      );
    },

    async reprovisionRunnerControlV1(input) {
      const request = RunnerCredentialReprovisionRequestV1Schema.parse(input);
      const controlToken = requireControlCredential(
        options.controlCredential,
        "recovery_pairing"
      );
      const action = "reprovisionRunnerControlV1";
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/credentials/reprovision`,
        {
          method: "POST",
          headers: jsonHeaders(controlToken),
          body: JSON.stringify(request)
        },
        action
      );
      return parseRunnerCredentialControlV1Response(
        response,
        action,
        trustedControlOrigin,
        {
          ...request,
          registrationGeneration: request.expectedRegistrationGeneration + 1,
          credentialGeneration: request.expectedCredentialGeneration + 1
        }
      );
    },

    async reportRunnerReadinessControlV1(input) {
      const request = RunnerReadinessReceiptEnvelopeV1Schema.parse(input);
      const action = "reportRunnerReadinessControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.payload.runnerId)}/readiness`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request)
        },
        action
      );
      return parseControlReceiptResponse(
        response,
        action,
        trustedControlOrigin,
        request,
        RunnerReadinessReceiptEnvelopeV1Schema,
        undefined
      ) as Promise<ControlReceiptResult<RunnerReadinessReceiptEnvelopeV1>>;
    },

    async requestActionPermissionControlV1(input) {
      const action = "requestActionPermissionControlV1";
      const request = RunnerPermissionRequestV1Schema.parse(input);
      const expectedFencingTokenDigest = await computePermissionFencingTokenDigestV1(
        request.attempt.fencingToken
      );
      if (request.attempt.fencingTokenDigest !== expectedFencingTokenDigest) {
        throw new OpenTagClientHttpError(
          action,
          0,
          "invalid_permission_fencing_token_digest"
        );
      }
      const expectedPermissionRequestDigest = await computePermissionRequestDigestV1({
        schemaVersion: request.schemaVersion,
        protocolVersion: request.protocolVersion,
        requiredCapabilities: request.requiredCapabilities,
        organizationId: request.organizationId,
        runnerId: request.runnerId,
        runId: request.runId,
        attempt: {
          attemptId: request.attempt.attemptId,
          attemptNumber: request.attempt.attemptNumber,
          epoch: request.attempt.epoch,
          fencingTokenDigest: request.attempt.fencingTokenDigest,
        },
        permissionRequestId: request.permissionRequestId,
        actionId: request.actionId,
        actionFamily: request.actionFamily,
        riskTier: request.riskTier,
        targetFingerprint: request.targetFingerprint,
        permissionScopes: request.permissionScopes,
        policySnapshotRef: request.policySnapshotRef,
        policySnapshotDigest: request.policySnapshotDigest,
        requestedAt: request.requestedAt,
      });
      if (request.permissionRequestDigest !== expectedPermissionRequestDigest) {
        throw new OpenTagClientHttpError(
          action,
          0,
          "invalid_permission_request_digest"
        );
      }
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/runs/${encodeURIComponent(request.runId)}/action-permissions`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action
      );
      return parseRunnerPermissionRequestControlV1Response(
        response,
        action,
        trustedControlOrigin,
        request
      );
    },

    async resolveActionPermissionControlV1(input) {
      const runnerId = RunnerPermissionCurrentQueryV1Schema.shape.runnerId.parse(input.runnerId);
      const decision = HumanPermissionDecisionRequestV1Schema.parse(input.decision);
      const action = "resolveActionPermissionControlV1";
      const token = requireControlCredential(options.controlCredential, "approver");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(runnerId)}/runs/${encodeURIComponent(decision.runId)}/action-permissions/${encodeURIComponent(decision.actionId)}/resolve`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(decision),
        },
        action
      );
      return parseHumanPermissionDecisionControlV1Response(
        response,
        action,
        trustedControlOrigin,
        decision
      );
    },

    async getActionPermissionCurrentControlV1(input) {
      const query = RunnerPermissionCurrentQueryV1Schema.parse(input);
      const action = "getActionPermissionCurrentControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const search = new URLSearchParams({
        organizationId: query.organizationId,
        attemptId: query.attempt.attemptId,
        attemptNumber: String(query.attempt.attemptNumber),
        epoch: String(query.attempt.epoch),
        fencingTokenDigest: query.attempt.fencingTokenDigest,
        permissionRequestId: query.permissionRequestId,
        permissionRequestDigest: query.permissionRequestDigest,
      });
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(query.runnerId)}/runs/${encodeURIComponent(query.runId)}/action-permissions/${encodeURIComponent(query.actionId)}/current?${search.toString()}`,
        { method: "GET", headers: authHeaders(token) },
        action
      );
      return parsePermissionResolutionCurrentControlV1Response(
        response,
        action,
        trustedControlOrigin,
        query
      );
    },

    async projectWorkThreadRefControlV1(input) {
      const request = WorkThreadRefReceiptEnvelopeV1Schema.parse(input);
      const action = "projectWorkThreadRefControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runs/${encodeURIComponent(request.runId)}/receipts/work-thread-ref`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) },
        action
      );
      return parseControlReceiptResponse(
        response,
        action,
        trustedControlOrigin,
        request,
        WorkThreadRefReceiptEnvelopeV1Schema,
        undefined
      ) as Promise<ControlReceiptResult<WorkThreadRefReceiptEnvelopeV1>>;
    },

    async projectCompletionContractRefControlV1(input) {
      const request = CompletionContractRefReceiptEnvelopeV1Schema.parse(input);
      const action = "projectCompletionContractRefControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runs/${encodeURIComponent(request.runId)}/receipts/completion-contract-ref`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) },
        action
      );
      return parseControlReceiptResponse(
        response,
        action,
        trustedControlOrigin,
        request,
        CompletionContractRefReceiptEnvelopeV1Schema,
        undefined
      ) as Promise<ControlReceiptResult<CompletionContractRefReceiptEnvelopeV1>>;
    },

    async projectCompletionAssessmentControlV1(input) {
      const request = CompletionAssessmentReceiptEnvelopeV1Schema.parse(input);
      const action = "projectCompletionAssessmentControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runs/${encodeURIComponent(request.runId)}/receipts/completion-assessments`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) },
        action
      );
      return parseControlReceiptResponse(
        response,
        action,
        trustedControlOrigin,
        request,
        CompletionAssessmentReceiptEnvelopeV1Schema,
        undefined
      ) as Promise<ControlReceiptResult<CompletionAssessmentReceiptEnvelopeV1>>;
    },

    async projectCallbackObservationControlV1(input) {
      const schema = input.receiptKind === "callback_intent_observation"
        ? CallbackIntentObservationReceiptEnvelopeV1Schema
        : input.receiptKind === "callback_attempt_observation"
          ? CallbackAttemptObservationReceiptEnvelopeV1Schema
          : CallbackProviderObservationReceiptEnvelopeV1Schema;
      const request = schema.parse(input) as CallbackObservationReceiptEnvelopeV1;
      const action = "projectCallbackObservationControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runs/${encodeURIComponent(request.runId)}/receipts/callback-observations`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) },
        action
      );
      return parseControlReceiptResponse(
        response,
        action,
        trustedControlOrigin,
        request,
        schema as StrictControlSchema<CallbackObservationReceiptEnvelopeV1>,
        (receipt) => receipt.receiptKind !== "callback_intent_observation"
          && receipt.payload.outcome === "outcome_unknown"
      );
    },

    async getRunner(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRunner");
      return (await response.json()) as { runner: RunnerRegistration };
    },

    async listRunners() {
      const response = await fetchImpl(`${baseUrl}/v1/runners`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listRunners");
      const body = (await response.json()) as { runners?: unknown };
      if (!Array.isArray(body.runners)) throw new Error("listRunners returned an invalid directory.");
      return { runners: body.runners.map((runner) => RunnerDirectoryEntrySchema.parse(runner)) };
    },

    async listControlPlaneAlerts(input = {}) {
      const params = new URLSearchParams();
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.since) params.set("since", input.since);
      const query = params.toString();
      const response = await fetchImpl(`${baseUrl}/v1/control-plane-alerts${query ? `?${query}` : ""}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listControlPlaneAlerts");
      return (await response.json()) as { alerts: ControlPlaneAlert[] };
    },

    async recordControlPlaneEvent(input) {
      const response = await fetchImpl(`${baseUrl}/v1/control-plane-events`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "recordControlPlaneEvent");
    },

    async ingestGitHubCompletionEvidence(input) {
      const response = await fetchImpl(`${baseUrl}/v1/completion-evidence/github`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "ingestGitHubCompletionEvidence");
    },

    async requestGitHubCompletionReconciliationEscalation(input) {
      const response = await fetchImpl(`${baseUrl}/v1/completion-escalations/github`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "requestGitHubCompletionReconciliationEscalation");
    },

    async pruneSourceDeliveries(input) {
      const response = await fetchImpl(`${baseUrl}/v1/source-deliveries/prune`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "pruneSourceDeliveries");
      const body = (await response.json()) as { result?: unknown };
      return parseSourceDeliveryPruneResult(body.result);
    },

    async bindRepository(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "bindRepository");
    },

    async getRepositoryBinding(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRepositoryBinding");
      return (await response.json()) as { binding: RepoBindingInput };
    },

    async upsertRepoPolicyRule(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/policy-rules`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ rule: input.rule })
      });
      await assertOk(response, "upsertRepoPolicyRule");
      return (await response.json()) as { rule: PolicyRule };
    },

    async listRepoPolicyRules(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/policy-rules`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listRepoPolicyRules");
      return (await response.json()) as { rules: PolicyRule[] };
    },

    async upsertRepoMutationMapping(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/mutation-mappings`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ mapping: input.mapping })
      });
      await assertOk(response, "upsertRepoMutationMapping");
      return (await response.json()) as { mapping: AdapterMutationMapping };
    },

    async listRepoMutationMappings(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/mutation-mappings`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listRepoMutationMappings");
      return (await response.json()) as { mappings: AdapterMutationMapping[] };
    },

    async createLinearOAuthInstallation(input) {
      const response = await fetchImpl(`${baseUrl}/v1/linear-oauth-installations`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "createLinearOAuthInstallation");
      return (await response.json()) as LinearOAuthInstallationStart;
    },

    async upsertLinearRelayInstallation(input) {
      const response = await fetchImpl(`${baseUrl}/v1/linear-relay-installations`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "upsertLinearRelayInstallation");
      return (await response.json()) as { installation: LinearRelayInstallationSummary };
    },

    async bindChannel(input, bindOptions) {
      const response = await fetchImpl(`${baseUrl}/v1/channel-bindings`, {
        method: "POST",
        headers: {
          ...jsonHeaders(options.pairingToken),
          ...(bindOptions?.adminOverride ? { "x-opentag-channel-admin-override": "true" } : {})
        },
        body: JSON.stringify(input)
      });
      await assertOk(response, "bindChannel");
    },

    async getChannelBinding(input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/channel-bindings/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.conversationId)}`,
        {
          headers: authHeaders(options.pairingToken)
        }
      );
      await assertOk(response, "getChannelBinding");
      return (await response.json()) as { binding: ChannelBindingInput };
    },

    async getChannelRuntimeStatus(input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/channel-bindings/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.conversationId)}/status`,
        {
          headers: authHeaders(options.pairingToken)
        }
      );
      await assertOk(response, "getChannelRuntimeStatus");
      const body = (await response.json()) as {
        binding: ChannelBindingInput;
        activeRun?: unknown;
        activeEvent?: unknown;
        runTimeoutPolicy?: unknown;
        queuedFollowUps?: unknown[];
      };
      return {
        binding: body.binding,
        ...(body.activeRun ? { activeRun: OpenTagRunSchema.parse(body.activeRun) } : {}),
        ...(body.activeEvent ? { activeEvent: OpenTagEventSchema.parse(body.activeEvent) } : {}),
        ...(body.runTimeoutPolicy ? { runTimeoutPolicy: parseRunTimeoutPolicy(body.runTimeoutPolicy) } : {}),
        queuedFollowUps: (body.queuedFollowUps ?? []).map((followUp) => FollowUpRequestSchema.parse(followUp))
      };
    },

    async unbindChannel(input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/channel-bindings/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.conversationId)}`,
        {
          method: "DELETE",
          headers: authHeaders(options.pairingToken)
        }
      );
      await assertOk(response, "unbindChannel");
    },

    async bindSlackChannel(input) {
      const response = await fetchImpl(`${baseUrl}/v1/slack-channel-bindings`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "bindSlackChannel");
    },

    async getSlackChannelBinding(input) {
      const response = await fetchImpl(`${baseUrl}/v1/slack-channel-bindings/${input.teamId}/${input.channelId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getSlackChannelBinding");
      return (await response.json()) as { binding: SlackChannelBindingInput };
    },

    async ensureWorkThread(input) {
      const event = OpenTagEventSchema.parse(input);
      const response = await fetchImpl(`${baseUrl}/v1/work-threads/ensure`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(event)
      });
      await assertOk(response, "ensureWorkThread");
      const body = (await response.json()) as { workThread?: unknown; created?: unknown };
      const workThread = WorkThreadSchema.parse(body.workThread);
      if (!workThread.id || typeof body.created !== "boolean") {
        throw new Error("ensureWorkThread returned an invalid response.");
      }
      return { workThread: { ...workThread, id: workThread.id }, created: body.created };
    },

    async createFactoryRecipeSnapshot(input) {
      const recipe = FactoryRecipeSnapshotInputSchema.parse(input);
      const response = await fetchImpl(`${baseUrl}/v1/factory-recipes`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(recipe)
      });
      await assertOk(response, "createFactoryRecipeSnapshot");
      const body = (await response.json()) as { recipe?: unknown };
      return { recipe: FactoryRecipeSnapshotSchema.parse(body.recipe) };
    },

    async getFactoryRecipeSnapshot(input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/factory-recipes/${encodeURIComponent(input.id)}/versions/${input.version}`,
        { headers: authHeaders(options.pairingToken) }
      );
      await assertOk(response, "getFactoryRecipeSnapshot");
      const body = (await response.json()) as { recipe?: unknown };
      return { recipe: FactoryRecipeSnapshotSchema.parse(body.recipe) };
    },

    async createWorkstream(input) {
      const workstream = WorkstreamInputSchema.parse(input);
      const response = await fetchImpl(`${baseUrl}/v1/workstreams`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(workstream)
      });
      await assertOk(response, "createWorkstream");
      const body = (await response.json()) as { workstream?: unknown };
      return { workstream: WorkstreamSchema.parse(body.workstream) };
    },

    async getWorkstream(input) {
      const response = await fetchImpl(`${baseUrl}/v1/workstreams/${encodeURIComponent(input.id)}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getWorkstream");
      const body = (await response.json()) as { workstream?: unknown };
      return { workstream: WorkstreamSchema.parse(body.workstream) };
    },

    async createWorkstreamAdmissionBatch(input) {
      const batch = WorkstreamAdmissionBatchInputSchema.parse(input);
      const response = await fetchImpl(`${baseUrl}/v1/workstream-batches`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(batch)
      });
      await assertOk(response, "createWorkstreamAdmissionBatch");
      const body = (await response.json()) as { receipt?: unknown };
      return { receipt: WorkstreamAdmissionBatchReceiptSchema.parse(body.receipt) };
    },

    async getWorkstreamAdmissionBatch(input) {
      const response = await fetchImpl(`${baseUrl}/v1/workstream-batches/${encodeURIComponent(input.id)}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getWorkstreamAdmissionBatch");
      const body = (await response.json()) as { receipt?: unknown };
      return { receipt: WorkstreamAdmissionBatchReceiptSchema.parse(body.receipt) };
    },

    async getWorkstreamMetrics(input) {
      const response = await fetchImpl(`${baseUrl}/v1/workstreams/${encodeURIComponent(input.id)}/metrics`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getWorkstreamMetrics");
      const body = (await response.json()) as { metrics?: unknown };
      return { metrics: WorkstreamMetricsSchema.parse(body.metrics) };
    },

    async getWorkstreamEvaluation(input) {
      const response = await fetchImpl(`${baseUrl}/v1/workstreams/${encodeURIComponent(input.id)}/evaluation`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getWorkstreamEvaluation");
      const body = (await response.json()) as { evaluation?: unknown };
      return { evaluation: WorkstreamEvaluationSchema.parse(body.evaluation) };
    },

    async createRun(input) {
      const event = OpenTagEventSchema.parse(input.event);
      const response = await fetchImpl(`${baseUrl}/v1/runs`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ runId: input.runId, event })
      });
      await assertOk(response, "createRun");
      const body = (await response.json()) as {
        decision: unknown;
        run?: unknown;
        followUpRequest?: unknown;
        idempotentReplay?: unknown;
        escalation?: unknown;
        resolutionUnavailableReason?: unknown;
      };
      const decision = RunAdmissionDecisionSchema.parse(body.decision);
      if (body.run) {
        return {
          outcome: "run_created",
          decision,
          run: OpenTagRunSchema.parse(body.run),
          ...(body.idempotentReplay === true ? { idempotentReplay: true } : {})
        };
      }
      if (body.followUpRequest) {
        return {
          outcome: "follow_up_queued",
          decision,
          followUpRequest: FollowUpRequestSchema.parse(body.followUpRequest)
        };
      }
      return {
        outcome: "needs_human_decision",
        decision,
        ...(body.escalation ? { escalation: HumanEscalationSchema.parse(body.escalation) } : {}),
        ...(typeof body.resolutionUnavailableReason === "string"
          ? { resolutionUnavailableReason: body.resolutionUnavailableReason }
          : {})
      };
    },

    async getFollowUpRequest(input) {
      const response = await fetchImpl(`${baseUrl}/v1/follow-up-requests/${input.id}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getFollowUpRequest");
      const body = (await response.json()) as { followUpRequest: unknown };
      return { followUpRequest: FollowUpRequestSchema.parse(body.followUpRequest) };
    },

    async createRunFromFollowUpRequest(input) {
      const response = await fetchImpl(`${baseUrl}/v1/follow-up-requests/${input.id}/create-run`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ runId: input.runId })
      });
      await assertOk(response, "createRunFromFollowUpRequest");
      const body = (await response.json()) as { followUpRequest: unknown; run: unknown };
      return {
        followUpRequest: FollowUpRequestSchema.parse(body.followUpRequest),
        run: OpenTagRunSchema.parse(body.run)
      };
    },

    async claim(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/claim`, {
        method: "POST",
        headers: authHeaders(options.pairingToken)
      });
      if (response.status === 204) return null;
      await assertOk(response, "claim");
      return parseClaimedRun((await response.json()) as {
        run: unknown;
        event: unknown;
        attemptId?: unknown;
        attemptNumber?: unknown;
        fencingToken?: unknown;
        executorId?: unknown;
        routingDecision?: unknown;
      });
    },

    async heartbeat(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/heartbeat`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ attemptId: input.attemptId, fencingToken: input.fencingToken })
      });
      await assertOk(response, "heartbeat");
    },

    async rejectAttemptStart(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/reject-start`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
          executorId: input.executorId,
          reason: input.reason
        })
      });
      await assertOk(response, "rejectAttemptStart");
    },

    async requestActionPermission(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/action-permissions`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ attemptId: input.attemptId, fencingToken: input.fencingToken, request: input.request })
      });
      await assertOk(response, "requestActionPermission");
      const body = (await response.json()) as { resolution: unknown };
      return ActionPermissionResolutionSchema.parse(body.resolution);
    },

    async resolveActionPermission(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/action-permissions/${input.actionId}/resolve`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ attemptId: input.attemptId, fencingToken: input.fencingToken })
      });
      await assertOk(response, "resolveActionPermission");
      const body = (await response.json()) as { resolution: unknown };
      return ActionPermissionResolutionSchema.parse(body.resolution);
    },

    async recordMaterialActionReceipt(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/material-actions/${input.actionId}/receipt`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ attemptId: input.attemptId, fencingToken: input.fencingToken, receipt: input.receipt })
      });
      await assertOk(response, "recordMaterialActionReceipt");
      const body = (await response.json()) as { resolution: unknown };
      return ActionPermissionResolutionSchema.parse(body.resolution);
    },

    async reconcileMaterialAction(input) {
      const response = await fetchImpl(`${baseUrl}/v1/material-actions/${input.actionId}/reconcile`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          outcome: input.outcome,
          idempotencyKey: input.idempotencyKey,
          receiptRef: input.receiptRef,
          ...(input.evidence ? { evidence: input.evidence } : {})
        })
      });
      await assertOk(response, "reconcileMaterialAction");
      const body = (await response.json()) as { result: { action: unknown }; replayed: boolean };
      return { action: ActionSchema.parse(body.result.action), replayed: body.replayed };
    },

    async markRunning(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/running`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          executor: input.executor,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
          ...(input.executorCapability ? { executorCapability: input.executorCapability } : {}),
          ...(input.runTimeoutMs ? { runTimeoutMs: input.runTimeoutMs } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
        })
      });
      await assertOk(response, "markRunning");
    },

    async progress(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/progress`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.type ? { type: input.type } : {}),
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
          message: input.message,
          ...(input.at ? { at: input.at } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.importance ? { importance: input.importance } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
        })
      });
      await assertOk(response, "progress");
    },

    async complete(input) {
      const result = OpenTagRunResultSchema.parse(input.result);
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/complete`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          result,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
        })
      });
      await assertOk(response, "complete");
    },

    async cancelRun(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/cancel`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.requestedBy ? { requestedBy: input.requestedBy } : {})
        })
      });
      await assertOk(response, "cancelRun");
      const body = (await response.json()) as { outcome: "cancelled"; run: unknown };
      return { outcome: body.outcome, run: OpenTagRunSchema.parse(body.run) };
    },

    async cancelActiveChannelRun(input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/channel-bindings/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.conversationId)}/cancel-active-run`,
        {
          method: "POST",
          headers: jsonHeaders(options.pairingToken),
          body: JSON.stringify({
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.requestedBy ? { requestedBy: input.requestedBy } : {})
          })
        }
      );
      await assertOk(response, "cancelActiveChannelRun");
      const body = (await response.json()) as { outcome: "cancelled"; run: unknown };
      return { outcome: body.outcome, run: OpenTagRunSchema.parse(body.run) };
    },

    async getRun(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRun");
      const body = (await response.json()) as { run: unknown; event: unknown };
      return {
        run: OpenTagRunSchema.parse(body.run),
        event: OpenTagEventSchema.parse(body.event)
      };
    },

    async getCompletion(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/completion`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getCompletion");
      const body = (await response.json()) as { completion: CompletionExplanation };
      return { completion: parseCompletionExplanation(body.completion) };
    },

    async getWorkThreadCompletion(input) {
      const response = await fetchImpl(`${baseUrl}/v1/work-threads/${encodeURIComponent(input.workThreadId)}/completion`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getWorkThreadCompletion");
      const body = (await response.json()) as { workThread?: unknown; completion?: unknown; acceptedProgress?: unknown };
      return {
        workThread: parseEnsuredWorkThread(body.workThread),
        completion: parseCompletionExplanation(body.completion),
        acceptedProgress: body.acceptedProgress === null
          ? null
          : AcceptedProgressAttributionViewSchema.parse(body.acceptedProgress)
      };
    },

    async listWorkLoopsRequiringAttention(input = {}) {
      const limit = input.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("listWorkLoopsRequiringAttention limit must be an integer from 1 to 100.");
      }
      const response = await fetchImpl(`${baseUrl}/v1/work-loops?attention=required&limit=${limit}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listWorkLoopsRequiringAttention");
      const body = (await response.json()) as {
        attention?: unknown;
        workLoops?: unknown;
        scanned?: unknown;
        scanLimitReached?: unknown;
      };
      if (
        body.attention !== "required"
        || !Array.isArray(body.workLoops)
        || typeof body.scanned !== "number"
        || typeof body.scanLimitReached !== "boolean"
      ) {
        throw new Error("listWorkLoopsRequiringAttention returned an invalid work-loop list.");
      }
      return {
        attention: "required" as const,
        workLoops: body.workLoops.map((item) => {
          const candidate = item as { workThread?: unknown; completion?: unknown };
          return {
            workThread: parseEnsuredWorkThread(candidate.workThread),
            completion: WorkLoopViewSchema.parse(candidate.completion)
          };
        }),
        scanned: body.scanned,
        scanLimitReached: body.scanLimitReached
      };
    },

    async listHumanEscalations(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${encodeURIComponent(input.runId)}/human-escalations`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listHumanEscalations");
      const body = (await response.json()) as { escalations?: unknown; resolutionUnavailableReason?: unknown };
      if (!Array.isArray(body.escalations)) {
        throw new Error("listHumanEscalations returned an invalid escalation list.");
      }
      return {
        escalations: body.escalations.map((escalation) => HumanEscalationSchema.parse(escalation)),
        ...(typeof body.resolutionUnavailableReason === "string" && body.resolutionUnavailableReason.length > 0
          ? { resolutionUnavailableReason: body.resolutionUnavailableReason }
          : {})
      };
    },

    async acknowledgeHumanEscalation(input) {
      const response = await fetchImpl(`${baseUrl}/v1/human-escalations/${encodeURIComponent(input.escalationId)}/acknowledge`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          actor: input.actor,
          ...(input.acknowledgedAt ? { acknowledgedAt: input.acknowledgedAt } : {})
        })
      });
      await assertOk(response, "acknowledgeHumanEscalation");
      const body = (await response.json()) as { outcome?: unknown; escalation: unknown };
      if (body.outcome !== "acknowledged" && body.outcome !== "duplicate") {
        throw new Error("acknowledgeHumanEscalation returned an invalid outcome.");
      }
      return { outcome: body.outcome, escalation: HumanEscalationSchema.parse(body.escalation) };
    },

    async resolveHumanEscalation(input) {
      const response = await fetchImpl(`${baseUrl}/v1/human-escalations/${encodeURIComponent(input.escalationId)}/resolve`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          actor: input.actor,
          ...(input.optionId ? { optionId: input.optionId } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.resolvedAt ? { resolvedAt: input.resolvedAt } : {})
        })
      });
      await assertOk(response, "resolveHumanEscalation");
      const body = (await response.json()) as {
        outcome: "resolved" | "duplicate";
        escalation: unknown;
        completion?: unknown;
        resume: unknown;
      };
      if (body.outcome !== "resolved" && body.outcome !== "duplicate") {
        throw new Error("resolveHumanEscalation returned an invalid outcome.");
      }
      return {
        outcome: body.outcome,
        escalation: HumanEscalationSchema.parse(body.escalation),
        ...(body.completion ? { completion: parseCompletionExplanation(body.completion) } : {}),
        resume: parseHumanEscalationResume(body.resume)
      };
    },

    async waiveCompletion(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/completion/waivers`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input.waiver)
      });
      await assertOk(response, "waiveCompletion");
      const body = (await response.json()) as {
        outcome: "recorded" | "duplicate" | "conflict";
        completion: CompletionExplanation;
        waiver: unknown;
      };
      return {
        outcome: body.outcome,
        completion: parseCompletionExplanation(body.completion),
        waiver: CompletionWaiverSchema.parse(body.waiver)
      };
    },

    async listRunEvents(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/events`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listRunEvents");
      return (await response.json()) as { events: unknown[] };
    },

    async getRunLedger(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/ledger`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRunLedger");
      return (await response.json()) as { ledger: { runId: string; entries: unknown[] } };
    },

    async getRunMetrics(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/metrics`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRunMetrics");
      return (await response.json()) as { metrics: RunMetrics };
    },

    async getRepoMetrics(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/metrics`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRepoMetrics");
      return (await response.json()) as { metrics: AggregateMetrics };
    },

    async getWorkThreadMetrics(input) {
      const response = await fetchImpl(`${baseUrl}/v1/work-thread-metrics?threadId=${encodeURIComponent(input.threadId)}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getWorkThreadMetrics");
      return (await response.json()) as { metrics: AggregateMetrics };
    },

    async getAcceptedProgressMetrics() {
      const response = await fetchImpl(`${baseUrl}/v1/routing/accepted-progress-metrics`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getAcceptedProgressMetrics");
      const body = (await response.json()) as { metrics?: unknown };
      return { metrics: AcceptedProgressMetricsSchema.parse(body.metrics) };
    },

    async getProposal(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getProposal");
      return (await response.json()) as { runId: string; snapshot: SuggestedChangesSnapshot };
    },

    async getProposalLineage(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}/lineage`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getProposalLineage");
      return (await response.json()) as { lineage: ProposalLineage };
    },

    async listCurrentMutationIntents(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}/current-intents`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listCurrentMutationIntents");
      return (await response.json()) as { intents: MutationIntentActionability[] };
    },

    async approveProposal(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}/approvals`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.id ? { id: input.id } : {}),
          approvedIntentIds: input.approvedIntentIds,
          ...(input.rejectedIntentIds?.length ? { rejectedIntentIds: input.rejectedIntentIds } : {}),
          approvedBy: input.approvedBy,
          ...(input.approvedAt ? { approvedAt: input.approvedAt } : {}),
          ...(input.scope ? { scope: input.scope } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {})
        })
      });
      await assertOk(response, "approveProposal");
      return (await response.json()) as { decision: ApprovalDecision };
    },

    async getApprovalDecision(input) {
      const response = await fetchImpl(`${baseUrl}/v1/approvals/${input.approvalDecisionId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getApprovalDecision");
      return (await response.json()) as { decision: ApprovalDecision };
    },

    async createApplyPlan(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}/apply-plans`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.id ? { id: input.id } : {}),
          approvalDecisionId: input.approvalDecisionId,
          ...(input.selectedIntentIds !== undefined ? { selectedIntentIds: input.selectedIntentIds } : {}),
          ...(input.adapter ? { adapter: input.adapter } : {}),
          ...(input.execute !== undefined ? { execute: input.execute } : {})
        })
      });
      await assertOk(response, "createApplyPlan");
      return (await response.json()) as { plan: ApplyPlan };
    },

    async getApplyPlan(input) {
      const response = await fetchImpl(`${baseUrl}/v1/apply-plans/${input.applyPlanId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getApplyPlan");
      return (await response.json()) as { plan: ApplyPlan };
    },

    async createChildRun(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.parentRunId}/child-runs`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          runId: input.runId,
          action: input.action,
          ...(input.commandText ? { commandText: input.commandText } : {}),
          ...(input.sourceProposalId ? { sourceProposalId: input.sourceProposalId } : {}),
          ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {})
        })
      });
      await assertOk(response, "createChildRun");
      const body = (await response.json()) as { run: unknown };
      return { run: OpenTagRunSchema.parse(body.run) };
    },

    async submitThreadAction(input) {
      const response = await fetchImpl(`${baseUrl}/v1/thread-actions`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.id ? { id: input.id } : {}),
          rawText: input.rawText,
          actor: input.actor,
          callback: {
            provider: input.callback.provider,
            uri: input.callback.uri,
            ...(input.callback.threadKey ? { threadKey: input.callback.threadKey } : {})
          },
          ...(input.metadata ? { metadata: input.metadata } : {})
        })
      });
      await assertOk(response, "submitThreadAction");
      return (await response.json()) as ThreadActionResult;
    }
  };
}

export function createDispatcherClient(options: RunnerClientOptions): DispatcherRunnerClient {
  const client = createOpenTagClient(options);
  return {
    claim: () => client.claim({ runnerId: options.runnerId }),
    markRunning: (runId, executor, lease, markRunningOptions) =>
      client.markRunning({
        runnerId: options.runnerId,
        runId,
        executor,
        ...lease,
        ...(markRunningOptions?.executorCapability ? { executorCapability: markRunningOptions.executorCapability } : {}),
        ...(markRunningOptions?.runTimeoutMs ? { runTimeoutMs: markRunningOptions.runTimeoutMs } : {}),
        ...(markRunningOptions?.idempotencyKey ? { idempotencyKey: markRunningOptions.idempotencyKey } : {})
      }),
    heartbeat: (runId, lease) => client.heartbeat({ runnerId: options.runnerId, runId, ...lease }),
    rejectAttemptStart: (runId, executorId, reason, lease) =>
      client.rejectAttemptStart({ runnerId: options.runnerId, runId, executorId, reason, ...lease }),
    requestActionPermission: (runId, lease, request) => client.requestActionPermission({ runnerId: options.runnerId, runId, ...lease, request }),
    resolveActionPermission: (runId, lease, actionId) => client.resolveActionPermission({ runnerId: options.runnerId, runId, actionId, ...lease }),
    recordMaterialActionReceipt: (runId, lease, actionId, receipt) => client.recordMaterialActionReceipt({ runnerId: options.runnerId, runId, actionId, receipt, ...lease }),
    progress: (runId, lease, input) => client.progress({ runnerId: options.runnerId, runId, ...lease, ...input }),
    complete: (runId, lease, result, completeOptions) =>
      client.complete({
        runnerId: options.runnerId,
        runId,
        ...lease,
        result,
        ...(completeOptions?.idempotencyKey ? { idempotencyKey: completeOptions.idempotencyKey } : {})
      })
  };
}

export function createDispatcherAdminClient(options: RunnerClientOptions) {
  const client = createOpenTagClient(options);
  return {
    registerRunner(
      name = options.runnerId,
      registration: Omit<RegisterRunnerInput, "runnerId" | "name"> = {}
    ): Promise<void> {
      return client.registerRunner({ runnerId: options.runnerId, name, ...registration });
    },

    bindRepository(binding: RepositoryBindingConfig): Promise<void> {
      return client.bindRepository({
        provider: binding.provider,
        owner: binding.owner,
        repo: binding.repo,
        runnerId: options.runnerId,
        ...(binding.fallbackRunnerIds?.length ? { fallbackRunnerIds: binding.fallbackRunnerIds } : {}),
        workspacePath: binding.checkoutPath,
        ...(binding.defaultExecutor ? { defaultExecutor: binding.defaultExecutor } : {}),
        ...(binding.fallbackExecutorIds?.length ? { fallbackExecutorIds: binding.fallbackExecutorIds } : {})
      });
    },

    bindSlackChannel(binding: SlackChannelBindingInput): Promise<void> {
      return client.bindSlackChannel(binding);
    },

    bindChannel(binding: ChannelBindingInput): Promise<void> {
      return client.bindChannel(binding, { adminOverride: true });
    },

    upsertRepoMutationMapping(input: {
      provider: string;
      owner: string;
      repo: string;
      mapping: AdapterMutationMapping;
    }): Promise<{ mapping: AdapterMutationMapping }> {
      return client.upsertRepoMutationMapping(input);
    },

    createLinearOAuthInstallation(input: CreateLinearOAuthInstallationInput): Promise<LinearOAuthInstallationStart> {
      return client.createLinearOAuthInstallation(input);
    },

    upsertLinearRelayInstallation(input: LinearRelayInstallationInput): Promise<{ installation: LinearRelayInstallationSummary }> {
      return client.upsertLinearRelayInstallation(input);
    },

    getChannelBinding(input: {
      provider: string;
      accountId: string;
      conversationId: string;
    }): Promise<{ binding: ChannelBindingInput }> {
      return client.getChannelBinding(input);
    },

    unbindChannel(input: { provider: string; accountId: string; conversationId: string }): Promise<void> {
      return client.unbindChannel(input);
    }
  };
}
