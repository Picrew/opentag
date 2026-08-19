import { z } from "zod";
import {
  COMPLETION_REASON_ALLOWED_GATE_STATES,
  CompletionAssessmentStateSchema,
  CompletionGateResultStateSchema,
  CompletionReasonCodeSchema,
  reduceCompletionGateStates,
} from "@opentag/control-protocol";
import { isCredentialSafeDisplayResource, isCredentialSafeText, isCredentialSafeValue } from "./credential-safety.js";
import { FrozenRoutingPolicySchema } from "./routing.js";

export {
  COMPLETION_REASON_ALLOWED_GATE_STATES,
  CompletionGateResultStateSchema,
  CompletionReasonCodeSchema,
  reduceCompletionGateStates,
};

export const ProviderSchema = z.string().min(1);
export const SourceSchema = ProviderSchema;
export const ContextPointerKindSchema = z.string().min(1).refine((kind) => !kind.includes("."), {
  message: "Context pointer kind must not include a provider prefix; use the provider field instead."
});
export const ExecutorHintSchema = z.enum(["claude-code", "codex", "cursor", "opencode", "hermes", "openclaw", "custom"]);
export const PermissionScopeSchema = z.string().min(1);
export const CommandArgValueSchema = z.union([z.string(), z.boolean(), z.number()]);
export const CommandFlagValueSchema = z.union([CommandArgValueSchema, z.array(CommandArgValueSchema)]);

export const CommandReferenceSchema = z.object({
  kind: z.enum(["file", "path", "line", "range", "url", "text"]),
  uri: z.string().min(1),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  title: z.string().min(1).optional()
});

export const CommandParseDiagnosticSchema = z.object({
  level: z.enum(["warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  token: z.string().min(1).optional()
});

export const ParsedOpenTagCommandSchema = z.object({
  version: z.literal("v1"),
  prompt: z.string(),
  flags: z.record(z.string(), CommandFlagValueSchema),
  references: z.array(CommandReferenceSchema),
  requestedScopes: z.array(PermissionScopeSchema),
  approval: z.enum(["auto", "required", "never"]).optional(),
  network: z.enum(["restricted"]).optional(),
  executorHint: ExecutorHintSchema.optional(),
  diagnostics: z.array(CommandParseDiagnosticSchema)
});

export const ActorIdentitySchema = z.object({
  provider: ProviderSchema,
  providerUserId: z.string().min(1),
  handle: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  /** Platform-reported write access to the source repository (for example,
   * GitHub's collaborator permission API). Absent when the platform does not
   * report it; admission treats absent as "no write access" on public repos. */
  writeAccess: z.boolean().optional()
});

export const AgentTargetSchema = z.object({
  mention: z.string().min(1),
  agentId: z.string().min(1),
  executorHint: ExecutorHintSchema.optional(),
  workspaceHint: z.string().min(1).optional()
});

export const OpenTagCommandSchema = z.object({
  rawText: z.string(),
  intent: z.enum(["fix", "review", "investigate", "explain", "run", "unknown"]),
  args: z.record(z.string(), CommandArgValueSchema),
  parsed: ParsedOpenTagCommandSchema.optional()
});

export const ContextPointerSchema = z.object({
  provider: ProviderSchema.optional(),
  kind: ContextPointerKindSchema,
  uri: z.string().min(1),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  title: z.string().min(1).optional(),
  visibility: z.enum(["public", "private", "organization"])
});

export const ContextPacketAssemblyStageSchema = z.enum(["collect", "classify", "filter", "preserve", "summarize", "budget", "emit"]);

export const ContextPacketIntentSchema = z.object({
  rawText: z.string().min(1),
  normalizedIntent: z.string().min(1),
  requestedBy: ActorIdentitySchema
});

export const ContextPacketSourceRoleSchema = z.enum(["primary", "supporting", "background"]);

export const ContextPacketSourceSchema = z.object({
  pointer: ContextPointerSchema,
  role: ContextPacketSourceRoleSchema,
  included: z.boolean(),
  reason: z.string().min(1)
});

export const ContextPacketFactConfidenceSchema = z.enum(["observed", "inferred", "uncertain"]);

export const ConversationHistoryTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
  runId: z.string().min(1),
  occurredAt: z.string().datetime()
});

export const DEFAULT_CONVERSATION_MEMORY_POLICY = {
  enabled: true,
  maxRuns: 100,
  maxCharacters: 160_000,
  maxTurnCharacters: 20_000
} as const;

export const ConversationMemoryPolicySchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_CONVERSATION_MEMORY_POLICY.enabled),
    maxRuns: z.number().int().min(1).max(1_000).default(DEFAULT_CONVERSATION_MEMORY_POLICY.maxRuns),
    maxCharacters: z.number().int().min(1_000).max(2_000_000).default(DEFAULT_CONVERSATION_MEMORY_POLICY.maxCharacters),
    maxTurnCharacters: z.number().int().min(256).max(200_000).default(DEFAULT_CONVERSATION_MEMORY_POLICY.maxTurnCharacters)
  })
  .strict()
  .refine((policy) => policy.maxTurnCharacters <= policy.maxCharacters, {
    message: "maxTurnCharacters cannot exceed maxCharacters",
    path: ["maxTurnCharacters"]
  });

export const ContextPacketSchema = z.object({
  summary: z.string().min(1),
  sourcePointers: z.array(ContextPointerSchema),
  intent: ContextPacketIntentSchema.optional(),
  sources: z.array(ContextPacketSourceSchema).optional(),
  facts: z
    .array(
      z.object({
        text: z.string().min(1),
        sourceUri: z.string().min(1).optional(),
        source: ContextPointerSchema.optional(),
        confidence: ContextPacketFactConfidenceSchema.optional()
      })
    )
    .optional(),
  risks: z.array(z.string().min(1)).optional(),
  exclusions: z.array(z.string().min(1)).optional(),
  mustPreserve: z.array(z.string().min(1)).optional(),
  conversationHistory: z.array(ConversationHistoryTurnSchema).optional(),
  redactions: z
    .array(
      z.object({
        reason: z.string().min(1),
        sourceUri: z.string().min(1).optional()
      })
    )
    .optional(),
  assembly: z
    .object({
      stages: z.array(ContextPacketAssemblyStageSchema),
      budgetTokens: z.number().int().positive().optional(),
      emittedAt: z.string().datetime().optional()
    })
    .optional()
});

export const PermissionGrantSchema = z.object({
  scope: PermissionScopeSchema,
  reason: z.string().min(1),
  expiresAt: z.string().datetime().optional()
});

/** An opaque reference to connector credentials held outside the durable run model. */
export const ConnectionRefSchema = z
  .object({
    id: z.string().min(1),
    provider: ProviderSchema,
    custody: z.enum(["agent", "opentag", "operator"]),
    brokerRef: z.string().min(1),
    declaredCapabilities: z.array(z.string().min(1))
  })
  .strict();

export const VerificationEvidenceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    assurance: z.enum(["verified", "reported", "unverifiable"]),
    subjectRef: z.string().min(1),
    summary: z.string().min(1),
    sourceRef: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const AttemptStatusSchema = z.enum([
  "assigned",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
  "needs_human"
]);

export const AttemptSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    number: z.number().int().positive(),
    runnerId: z.string().min(1),
    status: AttemptStatusSchema,
    startedAt: z.string().datetime(),
    heartbeatAt: z.string().datetime(),
    leaseExpiresAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    result: z.lazy(() => OpenTagRunResultSchema).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const GrantSchema = z
  .object({
    id: z.string().min(1),
    connectionId: z.string().min(1),
    capability: z.string().min(1),
    resourceScope: z.record(z.string(), z.unknown()),
    runId: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    expiresAt: z.string().datetime().optional(),
    constraints: z.record(z.string(), z.unknown()).optional(),
    revokedAt: z.string().datetime().optional()
  })
  .strict();

export const ApprovalModeSchema = z.enum(["ask", "auto", "autonomous"]);
export const PermissionDecisionKindSchema = z.enum(["allow_once", "allow_run", "deny"]);
export const ActionRiskTierSchema = z.enum(["low", "medium", "high", "critical"]);
const CredentialSafeRecordSchema = z.record(z.string(), z.unknown()).refine(isCredentialSafeValue, {
  message: "Record must not contain credential-like keys or values."
});
const CredentialSafeActionTitleSchema = z.string().min(1).max(240)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine(isCredentialSafeText, { message: "Action title must not contain credential-like data." });

export const NormalizedMaterialActionSchema = z
  .object({
    actionFamily: z.string().min(1),
    scope: CredentialSafeRecordSchema,
    target: CredentialSafeRecordSchema,
    riskTier: ActionRiskTierSchema,
    material: z.boolean(),
    internallyBlocked: z.boolean(),
    blockReason: z.string().min(1).optional()
  })
  .strict();

export const MaterialActionReceiptSchema = z
  .object({
    id: z.string().min(1),
    actionId: z.string().min(1),
    provider: ProviderSchema,
    connectionId: z.string().min(1).max(128).optional(),
    targetFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
    receiptRef: z.string().min(1),
    outcome: z.enum(["succeeded", "failed", "unknown"]),
    externalId: z.string().min(1).optional(),
    externalUri: z.string().url().optional(),
    observedAt: z.string().datetime(),
    evidence: z.array(VerificationEvidenceSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const ActionSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    attemptId: z.string().min(1),
    actionFamily: z.string().min(1),
    capability: z.string().min(1),
    scope: CredentialSafeRecordSchema,
    target: CredentialSafeRecordSchema,
    riskTier: ActionRiskTierSchema,
    status: z.enum(["proposed", "waiting_approval", "authorized", "executing", "succeeded", "failed", "unknown", "cancelled"]),
    idempotencyKey: z.string().min(1),
    proposalId: z.string().min(1).optional(),
    proposalHash: z.string().min(1).optional(),
    decisionSnapshotHash: z.string().min(1).optional(),
    attemptFenceDigest: z.string().min(1),
    receipt: MaterialActionReceiptSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const ActionPermissionRequestSchema = z
  .object({
    toolCallId: z.string().min(1),
    title: CredentialSafeActionTitleSchema,
    kind: z.string().min(1).nullable().optional(),
    connectionId: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u).refine(isCredentialSafeText).default("acp:agent-managed"),
    operation: z.string().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/u).refine(isCredentialSafeText).default("tool"),
    resource: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u).refine(isCredentialSafeDisplayResource).optional(),
    resourceVersion: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u).refine(isCredentialSafeText).optional(),
    targetFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
    targetConstraints: CredentialSafeRecordSchema.optional(),
    grantScope: CredentialSafeRecordSchema.optional(),
    permissionScopes: z.array(z.string().min(1)).default([]),
    mode: ApprovalModeSchema.default("auto"),
    provider: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u).default("acp")
  })
  .strict();

export const ActionPermissionResolutionSchema = z
  .object({
    state: z.enum(["authorized", "waiting", "denied", "reconciled", "unknown", "stale"]),
    action: ActionSchema,
    decision: PermissionDecisionKindSchema.optional(),
    receipt: MaterialActionReceiptSchema.optional(),
    reason: z.string().min(1).optional()
  })
  .strict();

export const ArtifactSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    kind: z.string().min(1),
    title: z.string().min(1),
    uri: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    evidence: z.array(VerificationEvidenceSchema).optional(),
    createdAt: z.string().datetime(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const CapabilityClassSchema = z.enum(["read_only", "callback", "external_write"]);

export const CapabilityContractSchema = z.object({
  id: z.string().min(1),
  semanticAction: z.string().min(1),
  capabilityClass: CapabilityClassSchema,
  requiresExplicitIntent: z.boolean(),
  mayAutoApplyByPolicy: z.boolean(),
  adapterTargets: z.array(z.string().min(1)).optional(),
  requiredPermissionScopes: z.array(PermissionGrantSchema.shape.scope),
  requiredExecutorConditions: z.array(z.string().min(1)).optional()
});

export const PolicyScopeSchema = z.enum([
  "organization_default",
  "adapter_surface_default",
  "work_context_owner_container",
  "work_item_override",
  "primary_anchor_override"
]);

export const PolicyEffectSchema = z.enum(["allow", "deny"]);

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  scope: PolicyScopeSchema,
  effect: PolicyEffectSchema,
  capabilityId: z.string().min(1).optional(),
  mutationDomain: z.string().min(1).optional(),
  reason: z.string().min(1)
});

export const PolicyResolutionSchema = z.object({
  capabilityId: z.string().min(1),
  decision: PolicyEffectSchema,
  resolvedBy: PolicyScopeSchema,
  rules: z.array(PolicyRuleSchema),
  reason: z.string().min(1)
});

export const PolicySnapshotProvenanceSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(["repository_free", "repo_binding", "agent_access_profile"]),
    sourceRef: z.string().min(1).optional(),
    rules: z.array(PolicyRuleSchema),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    capturedAt: z.string().datetime()
  })
  .strict();

export const AgentPrincipalSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["opentag_agent", "provider_agent", "custom"])
  })
  .strict();

export const AgentAccessProfileSnapshotSchema = z
  .object({
    id: z.string().min(1),
    agentPrincipal: AgentPrincipalSchema,
    requestedBy: ActorIdentitySchema,
    projectTargets: z.array(z.string().min(1)),
    connectionRefs: z.array(ConnectionRefSchema),
    permissions: z.array(PermissionGrantSchema),
    constraints: z
      .object({
        locality: z.enum(["local_required", "private_required", "hosted_allowed"]).optional(),
        maximumRiskTier: ActionRiskTierSchema.optional(),
        allowedExecutorIds: z.array(z.string().min(1)).optional(),
        allowedRunnerIds: z.array(z.string().min(1)).optional()
      })
      .strict(),
    policySnapshotId: z.string().min(1),
    capturedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    revokedAt: z.string().datetime().optional()
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const capturedAt = Date.parse(snapshot.capturedAt);
    if (snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= capturedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent access profile expiresAt must be later than capturedAt.",
        path: ["expiresAt"]
      });
    }
    if (snapshot.revokedAt && Date.parse(snapshot.revokedAt) < capturedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent access profile revokedAt cannot precede capturedAt.",
        path: ["revokedAt"]
      });
    }
  });

export const AdapterMutationMappingSchema = z.object({
  id: z.string().min(1),
  adapter: z.string().min(1),
  domain: z.string().min(1),
  strategy: z.string().min(1),
  values: z.record(z.string(), z.string().min(1)),
  description: z.string().min(1).optional()
});

export const SuccessMetricNameSchema = z.enum([
  "time_to_first_useful_artifact",
  "artifact_acceptance_rate",
  "context_reuse_rate",
  "external_write_approval_rate",
  "stale_proposal_rate"
]);

export const CallbackRouteSchema = z.object({
  provider: ProviderSchema,
  uri: z.string().min(1),
  threadKey: z.string().min(1).optional()
});

export const WorkItemReferenceSchema = z.object({
  provider: z.string().min(1),
  kind: z.string().min(1),
  externalId: z.string().min(1),
  uri: z.string().min(1),
  title: z.string().min(1).optional(),
  ownerContainer: z
    .object({
      provider: z.string().min(1),
      id: z.string().min(1),
      uri: z.string().min(1).optional()
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const ConversationAnchorSchema = z.object({
  provider: ProviderSchema,
  kind: z.string().min(1),
  externalId: z.string().min(1),
  uri: z.string().min(1),
  threadKey: z.string().min(1).optional(),
  controlPlane: z.boolean().optional(),
  canApprove: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const WorkThreadSchema = z.object({
  id: z.string().min(1).optional(),
  workItemReference: WorkItemReferenceSchema,
  primaryAnchor: ConversationAnchorSchema,
  secondaryAnchors: z.array(ConversationAnchorSchema).optional()
});

export const RunAdmissionActionSchema = z.enum([
  "start",
  "wait",
  "drop_duplicate",
  "queue_follow_up",
  "attach_to_active_run",
  "needs_human_decision"
]);

export const RunAdmissionReasonCodeSchema = z.enum([
  "new_event",
  "duplicate_source_event",
  "duplicate_source_delivery",
  "active_run_same_thread",
  "active_write_run_same_thread",
  "scope_change_requires_decision",
  "policy_rejected",
  "repo_context_missing",
  "repo_not_bound",
  "actor_not_allowed_for_write",
  "actor_not_authorized_for_public_repo",
  "agent_access_profile_denied"
]);

export const RunAdmissionDecisionSchema = z.object({
  action: RunAdmissionActionSchema,
  reason: z.string().min(1),
  reasonCode: RunAdmissionReasonCodeSchema,
  decidedAt: z.string().datetime(),
  activeRunId: z.string().min(1).optional(),
  eventId: z.string().min(1).optional()
});

export const FollowUpRequestStatusSchema = z.enum(["queued", "promoting", "promoted", "cancelled"]);

export const FollowUpRequestSchema = z.object({
  id: z.string().min(1),
  sourceEventId: z.string().min(1),
  conversationKey: z.string().min(1),
  activeRunId: z.string().min(1).optional(),
  workstreamId: z.string().min(1).optional(),
  admissionBatchId: z.string().min(1).optional(),
  event: z.lazy(() => OpenTagEventSchema),
    decision: RunAdmissionDecisionSchema,
    accessProfileSnapshot: AgentAccessProfileSnapshotSchema.optional(),
    policySnapshotProvenance: PolicySnapshotProvenanceSchema.optional(),
    routingPolicy: FrozenRoutingPolicySchema.optional(),
  status: FollowUpRequestStatusSchema,
  createdRunId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine((value, ctx) => {
  if (value.admissionBatchId && !value.workstreamId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Follow-up batch attribution requires a workstream.",
      path: ["admissionBatchId"]
    });
  }
  if (Boolean(value.accessProfileSnapshot) !== Boolean(value.policySnapshotProvenance)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Follow-up access and policy snapshots must be captured together.",
      path: [value.accessProfileSnapshot ? "policySnapshotProvenance" : "accessProfileSnapshot"]
    });
  }
  if (
    value.accessProfileSnapshot
    && value.policySnapshotProvenance
    && value.accessProfileSnapshot.policySnapshotId !== value.policySnapshotProvenance.id
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Follow-up access snapshot must reference the captured policy snapshot.",
      path: ["accessProfileSnapshot", "policySnapshotId"]
    });
  }
});

export const RunEventVisibilitySchema = z.enum(["human", "audit", "debug"]);
export const RunEventImportanceSchema = z.enum(["low", "normal", "high", "blocking"]);

export const RunEventSchema = z.object({
  id: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
  runId: z.string().min(1),
  type: z.string().min(1),
  createdAt: z.string().datetime(),
  visibility: RunEventVisibilitySchema,
  importance: RunEventImportanceSchema,
  message: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  sourcePointer: ContextPointerSchema.optional()
});

export const ArtifactKindSchema = z.enum([
  "root_cause_note",
  "suggested_changes_snapshot",
  "verification_summary",
  "patch",
  "report",
  "screenshot",
  "log_summary",
  "pull_request",
  "risk_note",
  "follow_up_task",
  "audit_trail",
  "decision_record"
]);

export const RunArtifactTypeSchema = z.enum([
  "suggested_changes_snapshot",
  "next_action",
  "apply_plan",
  "patch_summary",
  "diagnosis_report",
  "pr_intent",
  "patch",
  "report",
  "log_summary",
  "pull_request",
  "verification_summary",
  "custom"
]);

export const ActionHintSchema = z.object({
  kind: z.enum([
    "apply_suggested_changes",
    "generate_patch",
    "request_human_decision",
    "link_to_work_item",
    "request_review",
    "create_pull_request",
    "refresh_completion_evidence",
    "reconcile_material_action",
    "resume_work_thread",
    "reassess_completion",
    "none"
  ]),
  targetId: z.string().min(1).optional(),
  selectedIntentIds: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const NextActionSchema = z.union([
  z.string().min(1),
  z.object({
    summary: z.string().min(1),
    hint: ActionHintSchema
  })
]);

export const CompletionStateSchema = CompletionAssessmentStateSchema;

export const CompletionGateKindSchema = z.enum([
  "artifact",
  "verification",
  "external_state",
  "material_action",
  "human_acceptance"
]);

export const CompletionEvidenceAssuranceSchema = VerificationEvidenceSchema.shape.assurance.exclude(["unverifiable"]);

const CompletionGateIdSchema = z.string().min(1);
const CompletionTargetKeySchema = z.string().min(1);

export const CompletionTargetSelectorSchema = z
  .object({
    key: CompletionTargetKeySchema,
    kind: z.literal("change_request"),
    lineage: z.literal("current_cycle"),
    cardinality: z.literal("exactly_one")
  })
  .strict();

export const ResolvedCompletionTargetSchema = z
  .object({
    key: CompletionTargetKeySchema,
    provider: ProviderSchema,
    resourceRef: z.string().min(1),
    resourceVersion: z.string().min(1),
    artifactId: z.string().min(1)
  })
  .strict();

export const CompletionGateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: CompletionGateIdSchema,
      kind: z.literal("artifact"),
      targetKey: CompletionTargetKeySchema,
      artifactKind: ArtifactKindSchema,
      minimum: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      id: CompletionGateIdSchema,
      kind: z.literal("verification"),
      targetKey: CompletionTargetKeySchema,
      evidenceKind: z.string().min(1),
      requiredObservations: z.array(z.string().min(1)).optional(),
      requiredOutcome: z.literal("passed"),
      minimumAssurance: CompletionEvidenceAssuranceSchema
    })
    .strict(),
  z
    .object({
      id: CompletionGateIdSchema,
      kind: z.literal("external_state"),
      targetKey: CompletionTargetKeySchema,
      provider: ProviderSchema,
      requiredState: z.string().min(1),
      minimumAssurance: CompletionEvidenceAssuranceSchema
    })
    .strict(),
  z
    .object({
      id: CompletionGateIdSchema,
      kind: z.literal("material_action"),
      targetKey: CompletionTargetKeySchema.optional(),
      actionFamily: z.string().min(1),
      requiredOutcome: z.literal("succeeded")
    })
    .strict(),
  z
    .object({
      id: CompletionGateIdSchema,
      kind: z.literal("human_acceptance"),
      targetKey: CompletionTargetKeySchema.optional(),
      requiredRole: z.string().min(1)
    })
    .strict()
]);

export const CompletionContractSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    workThreadId: z.string().min(1),
    cycle: z.number().int().positive(),
    mode: z.enum(["execution_compat", "governed"]),
    targetSelectors: z.array(CompletionTargetSelectorSchema),
    resolvedFrom: z.array(
      z
        .object({
          scope: PolicyScopeSchema,
          ref: z.string().min(1),
          version: z.string().min(1).optional()
        })
        .strict()
    ),
    gates: z.array(CompletionGateSchema).min(1),
    maxAutomaticRetries: z.number().int().nonnegative(),
    onSatisfied: z.enum(["report_only", "propose_work_item_transition", "apply_transition_by_policy"]),
    createdAt: z.string().datetime()
  })
  .strict()
  .superRefine((contract, ctx) => {
    const seen = new Set<string>();
    const targetKeys = new Set<string>();
    contract.targetSelectors.forEach((selector, index) => {
      if (targetKeys.has(selector.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Completion target selector key must be unique: ${selector.key}`,
          path: ["targetSelectors", index, "key"]
        });
      }
      targetKeys.add(selector.key);
    });
    contract.gates.forEach((gate, index) => {
      if (seen.has(gate.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Completion gate id must be unique: ${gate.id}`,
          path: ["gates", index, "id"]
        });
      }
      seen.add(gate.id);
      if (gate.id.startsWith("human_escalation:")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Completion contract gates cannot use the reserved human_escalation namespace.",
          path: ["gates", index, "id"]
        });
      }
      if (gate.targetKey && !targetKeys.has(gate.targetKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Completion gate targetKey must reference a target selector: ${gate.targetKey}`,
          path: ["gates", index, "targetKey"]
        });
      }
    });
    if (contract.mode === "execution_compat" && contract.targetSelectors.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An execution compatibility contract cannot declare provider delivery targets.",
        path: ["targetSelectors"]
      });
    }
    if (contract.mode === "execution_compat") {
      const executorGate = contract.gates[0];
      if (
        contract.gates.length !== 1
        || executorGate?.kind !== "material_action"
        || executorGate.actionFamily !== "executor_run"
        || executorGate.requiredOutcome !== "succeeded"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An execution compatibility contract requires exactly one executor_run material-action gate.",
          path: ["gates"]
        });
      }
    }
  });

type CompletionGateResultStateValue = z.infer<typeof CompletionGateResultStateSchema>;
type CompletionAssessmentStateValue = z.infer<typeof CompletionStateSchema>;
type CompletionReasonCodeValue = z.infer<typeof CompletionReasonCodeSchema>;

const COMPLETION_REASON_REQUIRES_GATE_EVIDENCE = Object.freeze({
  artifact_requirement_satisfied: true,
  artifact_missing: false,
  artifact_ambiguous: false,
  verification_passed: true,
  verification_failed: true,
  verification_missing: false,
  verification_assurance_insufficient: true,
  verification_subject_mismatch: false,
  verification_stale: true,
  external_state_satisfied: true,
  external_state_mismatch: true,
  external_state_missing: false,
  external_state_assurance_insufficient: true,
  external_state_subject_mismatch: false,
  external_state_stale: true,
  material_action_succeeded: true,
  material_action_failed: true,
  material_action_unknown: true,
  material_action_missing: false,
  human_acceptance_recorded: true,
  human_acceptance_missing: false,
  gate_waived: false,
  waiver_invalid: false,
  execution_succeeded: false,
  execution_incomplete: false,
  execution_not_succeeded: false
} as const satisfies Record<CompletionReasonCodeValue, boolean>);

export function completionReasonAllowsGateState(
  reasonCode: CompletionReasonCodeValue,
  state: CompletionGateResultStateValue
): boolean {
  return (COMPLETION_REASON_ALLOWED_GATE_STATES[reasonCode] as readonly CompletionGateResultStateValue[]).includes(state);
}

export function completionReasonRequiresGateEvidence(reasonCode: CompletionReasonCodeValue): boolean {
  return COMPLETION_REASON_REQUIRES_GATE_EVIDENCE[reasonCode];
}

export function compareCompletionGateIds(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

const RFC3339_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseRfc3339Instant(value: string): {
  epochSeconds: number;
  fractionalSeconds: string;
} | undefined {
  const match = RFC3339_INSTANT_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]!
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return undefined;
  }
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  const offsetDirection = match[9] === "-" ? -1 : match[9] === "+" ? 1 : 0;
  const offsetSeconds = offsetDirection * (offsetHour * 3_600 + offsetMinute * 60);
  return {
    epochSeconds: utc.getTime() / 1_000 - offsetSeconds,
    fractionalSeconds: match[7] ?? ""
  };
}

function tryCompareRfc3339Timestamps(left: string, right: string): number | undefined {
  const leftInstant = parseRfc3339Instant(left);
  const rightInstant = parseRfc3339Instant(right);
  if (!leftInstant || !rightInstant) return undefined;
  if (leftInstant.epochSeconds !== rightInstant.epochSeconds) {
    return leftInstant.epochSeconds < rightInstant.epochSeconds ? -1 : 1;
  }
  const precision = Math.max(
    leftInstant.fractionalSeconds.length,
    rightInstant.fractionalSeconds.length
  );
  for (let index = 0; index < precision; index += 1) {
    const leftDigit = leftInstant.fractionalSeconds.charCodeAt(index) || 48;
    const rightDigit = rightInstant.fractionalSeconds.charCodeAt(index) || 48;
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}

export function compareRfc3339Timestamps(left: string, right: string): number {
  const comparison = tryCompareRfc3339Timestamps(left, right);
  if (comparison === undefined) {
    throw new TypeError("RFC3339 timestamp comparison requires valid timestamps.");
  }
  return comparison;
}

const CompletionTimestampSchema = z.string().datetime({ offset: true }).superRefine((value, ctx) => {
  if (parseRfc3339Instant(value) === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Completion timestamps must be valid RFC3339 calendar instants."
    });
  }
});

export const CompletionGateResultSchema = z
  .object({
    gateId: CompletionGateIdSchema,
    targetKey: CompletionTargetKeySchema.optional(),
    state: CompletionGateResultStateSchema,
    evidenceIds: z.array(z.string().min(1)),
    reasonCode: CompletionReasonCodeSchema,
    reason: z.string().min(1),
    evaluatedAt: CompletionTimestampSchema
  })
  .strict()
  .superRefine((result, ctx) => {
    if (!completionReasonAllowsGateState(result.reasonCode, result.state)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completion gate reason and state are incompatible.",
        path: ["state"]
      });
    }
    if (completionReasonRequiresGateEvidence(result.reasonCode) && result.evidenceIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "This completion gate reason requires evidence.",
        path: ["evidenceIds"]
      });
    }
  });

export const CompletionWaiverSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1).optional(),
    contractId: z.string().min(1),
    contractVersion: z.number().int().positive(),
    cycle: z.number().int().positive(),
    actor: ActorIdentitySchema,
    reason: z.string().min(1),
    scope: z.literal("selected_gates"),
    policyScope: PolicyScopeSchema,
    gateIds: z.array(CompletionGateIdSchema).min(1),
    waivedAt: CompletionTimestampSchema,
    expiresAt: CompletionTimestampSchema.optional()
  })
  .strict()
  .superRefine((waiver, ctx) => {
    const seen = new Set<string>();
    waiver.gateIds.forEach((gateId, index) => {
      if (seen.has(gateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Waived gate id must be unique: ${gateId}`,
          path: ["gateIds", index]
        });
      }
      seen.add(gateId);
    });
    if (waiver.expiresAt) {
      const expirationOrder = tryCompareRfc3339Timestamps(
        waiver.expiresAt,
        waiver.waivedAt
      );
      if (expirationOrder !== undefined && expirationOrder <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A completion waiver must expire after it is granted.",
          path: ["expiresAt"]
        });
      }
    }
  });

export const CompletionAssessmentSchema = z
  .object({
    id: z.string().min(1),
    workThreadId: z.string().min(1),
    triggeredByRunId: z.string().min(1).optional(),
    contractId: z.string().min(1),
    contractVersion: z.number().int().positive(),
    cycle: z.number().int().positive(),
    sequence: z.number().int().positive(),
    inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    targetBindings: z.array(ResolvedCompletionTargetSchema),
    state: CompletionStateSchema,
    evidenceBacked: z.boolean(),
    gateResults: z.array(CompletionGateResultSchema).min(1),
    assessedAt: CompletionTimestampSchema,
    assessedBy: z.enum(["opentag", "human"]),
    supersedesAssessmentId: z.string().min(1).optional(),
    acceptedAt: CompletionTimestampSchema.optional(),
    waiver: CompletionWaiverSchema.optional()
  })
  .strict()
  .superRefine((assessment, ctx) => {
    const seen = new Set<string>();
    const targetKeys = new Set<string>();
    assessment.targetBindings.forEach((target, index) => {
      if (targetKeys.has(target.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Resolved completion target key must be unique: ${target.key}`,
          path: ["targetBindings", index, "key"]
        });
      }
      targetKeys.add(target.key);
    });
    assessment.gateResults.forEach((result, index) => {
      if (seen.has(result.gateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Completion gate result must be unique: ${result.gateId}`,
          path: ["gateResults", index, "gateId"]
        });
      }
      seen.add(result.gateId);
      const previous = assessment.gateResults[index - 1];
      if (previous && compareCompletionGateIds(previous.gateId, result.gateId) >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Completion gate results must be in canonical Unicode gate id order.",
          path: ["gateResults", index, "gateId"]
        });
      }
      const evaluationOrder = tryCompareRfc3339Timestamps(
        result.evaluatedAt,
        assessment.assessedAt
      );
      if (evaluationOrder !== undefined && evaluationOrder > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A gate cannot be evaluated after its completion assessment.",
          path: ["gateResults", index, "evaluatedAt"]
        });
      }
    });
    const reducedState = reduceCompletionGateStates(assessment.gateResults.map((result) => result.state));
    if (assessment.state !== reducedState) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completion assessment state must equal the deterministic gate reduction.",
        path: ["state"]
      });
    }
    const accepted = assessment.state === "satisfied" || assessment.state === "waived";
    if (accepted !== Boolean(assessment.acceptedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "acceptedAt is required exactly when completion is accepted.",
        path: ["acceptedAt"]
      });
    }
    if (assessment.acceptedAt) {
      const acceptanceOrder = tryCompareRfc3339Timestamps(
        assessment.acceptedAt,
        assessment.assessedAt
      );
      if (acceptanceOrder !== undefined && acceptanceOrder > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Completion acceptance cannot occur after its assessment.",
          path: ["acceptedAt"]
        });
      }
    }
    const hasWaivedGate = assessment.gateResults.some((result) => result.state === "waived");
    if (hasWaivedGate && !assessment.waiver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A completion assessment with waived gates requires waiver attribution.",
        path: ["waiver"]
      });
    }
    if (!hasWaivedGate && assessment.waiver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Waiver attribution is only valid when at least one gate is waived.",
        path: ["waiver"]
      });
    }
    if (assessment.waiver && assessment.assessedBy !== "human") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A completion waiver must be assessed by a human.",
        path: ["assessedBy"]
      });
    }
    if (!assessment.waiver && assessment.assessedBy !== "opentag") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A completion assessment without a waiver must be assessed by OpenTag.",
        path: ["assessedBy"]
      });
    }
    if (assessment.waiver && (
      assessment.waiver.contractId !== assessment.contractId
      || assessment.waiver.contractVersion !== assessment.contractVersion
      || assessment.waiver.cycle !== assessment.cycle
    )) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A completion waiver must target the assessed contract version and cycle.",
        path: ["waiver"]
      });
    }
    if (assessment.waiver) {
      const waiverOrder = tryCompareRfc3339Timestamps(
        assessment.waiver.waivedAt,
        assessment.assessedAt
      );
      if (waiverOrder !== undefined && waiverOrder > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A completion waiver cannot be applied before it is granted.",
          path: ["waiver", "waivedAt"]
        });
      }
    }
    if (assessment.waiver?.expiresAt) {
      const expirationOrder = tryCompareRfc3339Timestamps(
        assessment.waiver.expiresAt,
        assessment.assessedAt
      );
      if (expirationOrder !== undefined && expirationOrder <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An expired completion waiver cannot be applied to an assessment.",
          path: ["waiver", "expiresAt"]
        });
      }
    }
    if (assessment.waiver) {
      const waivedGateIds = assessment.gateResults
        .filter((result) => result.state === "waived")
        .map((result) => result.gateId)
        .sort(compareCompletionGateIds);
      const attributedGateIds = [...assessment.waiver.gateIds].sort(compareCompletionGateIds);
      if (JSON.stringify(waivedGateIds) !== JSON.stringify(attributedGateIds)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Waiver attribution gate ids must exactly equal the waived gate ids.",
          path: ["waiver", "gateIds"]
        });
      }
    }
  });

export const ReassessmentObligationSourceKindSchema = z.enum([
  "run_result_recorded",
  "verification_evidence_attached",
  "material_action_receipt_recorded",
  "material_action_reconciled",
  "human_escalation_changed",
  "completion_waiver_changed",
  "continuation_not_before"
]);

export const ReassessmentObligationStateSchema = z.enum([
  "pending",
  "leased",
  "satisfied",
  "blocked"
]);

export const ReassessmentObligationReasonCodeSchema = z.enum([
  "assessment_satisfied",
  "continuation_dispatched",
  "continuation_terminal",
  "continuation_deferred",
  "source_missing",
  "authority_missing",
  "reassessment_failed",
  "needs_human"
]);

const ReassessmentPendingReasonCodes = new Set([
  "continuation_deferred",
  "reassessment_failed"
]);
const ReassessmentSatisfiedReasonCodes = new Set([
  "assessment_satisfied",
  "continuation_dispatched",
  "continuation_terminal"
]);
const ReassessmentBlockedReasonCodes = new Set([
  "source_missing",
  "authority_missing",
  "needs_human"
]);

export const ReassessmentObligationSchema = z
  .object({
    id: z.string().min(1),
    workThreadId: z.string().min(1),
    sourceKind: ReassessmentObligationSourceKindSchema,
    sourceId: z.string().min(1),
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    notBefore: z.string().datetime(),
    state: ReassessmentObligationStateSchema,
    leaseOwner: z.string().min(1).optional(),
    leaseExpiresAt: z.string().datetime().optional(),
    leaseToken: z.string().min(1).optional(),
    attemptCount: z.number().int().nonnegative(),
    lastReasonCode: ReassessmentObligationReasonCodeSchema.optional(),
    lastError: z.string().min(1).max(4096).optional(),
    satisfiedAssessmentId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict()
  .superRefine((obligation, ctx) => {
    const activeLeaseFields = [obligation.leaseOwner, obligation.leaseExpiresAt, obligation.leaseToken];
    if (obligation.state === "leased") {
      if (activeLeaseFields.some((field) => !field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A leased reassessment obligation requires lease owner, expiry, and fencing token.",
          path: ["leaseToken"]
        });
      }
      if (obligation.attemptCount < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A leased reassessment obligation must record at least one attempt.",
          path: ["attemptCount"]
        });
      }
    } else if (activeLeaseFields.some((field) => field !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Active lease fields are allowed only while a reassessment obligation is leased.",
        path: ["leaseOwner"]
      });
    }

    if (obligation.satisfiedAssessmentId && obligation.state !== "satisfied") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only a satisfied reassessment obligation may reference a satisfying assessment.",
        path: ["satisfiedAssessmentId"]
      });
    }
    if (obligation.state === "satisfied" && !obligation.lastReasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A satisfied reassessment obligation requires a terminal reason.",
        path: ["lastReasonCode"]
      });
    }
    if (obligation.state === "blocked" && !obligation.lastReasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A blocked reassessment obligation requires a terminal reason.",
        path: ["lastReasonCode"]
      });
    }
    if (obligation.lastReasonCode === "assessment_satisfied" && !obligation.satisfiedAssessmentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An assessment-backed satisfaction requires its assessment id.",
        path: ["satisfiedAssessmentId"]
      });
    }
    if (
      obligation.state === "pending"
      && obligation.lastReasonCode
      && !ReassessmentPendingReasonCodes.has(obligation.lastReasonCode)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The pending obligation reason must describe deferral or a retryable reassessment failure.",
        path: ["lastReasonCode"]
      });
    }
    if (
      obligation.state === "satisfied"
      && obligation.lastReasonCode
      && !ReassessmentSatisfiedReasonCodes.has(obligation.lastReasonCode)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The satisfied obligation reason must describe completed governance delivery.",
        path: ["lastReasonCode"]
      });
    }
    if (
      obligation.state === "blocked"
      && obligation.lastReasonCode
      && !ReassessmentBlockedReasonCodes.has(obligation.lastReasonCode)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The blocked obligation reason must describe missing authority or required human action.",
        path: ["lastReasonCode"]
      });
    }
  });

export const HumanEscalationOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    consequence: z.string().min(1)
  })
  .strict();

export const HumanEscalationRequestSchema = z
  .object({
    class: z.enum(["approval", "missing_input", "configuration", "verification", "reconciliation", "security"]),
    audience: z.enum(["requester", "work_item_owner", "repo_owner", "operator", "security"]),
    subjectRef: z.string().min(1).optional(),
    blocking: z.boolean().default(true),
    summary: z.string().min(1),
    reason: z.string().min(1),
    options: z.array(HumanEscalationOptionSchema).min(1).optional(),
    nextAction: ActionHintSchema.optional(),
    dedupeKey: z.string().min(1).optional(),
    expiresAt: z.string().datetime().optional()
  })
  .strict()
  .superRefine((request, ctx) => {
    const optionIds = new Set<string>();
    request.options?.forEach((option, index) => {
      if (optionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Human escalation option ids must be unique.",
          path: ["options", index, "id"]
        });
      }
      optionIds.add(option.id);
    });
  });

export const HumanEscalationSchema = z
  .object({
    id: z.string().min(1),
    workThreadId: z.string().min(1),
    runId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    sourceAuthority: z
      .object({
        provider: z.string().min(1),
        accountId: z.string().min(1),
        conversationId: z.string().min(1),
        ownership: z
          .object({
            mode: z.literal("managed"),
            exclusive: z.literal(true),
            applicationId: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/u),
            botId: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/u).optional()
          })
          .strict()
          .optional(),
        bindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
      })
      .strict()
      .optional(),
    class: z.enum(["approval", "missing_input", "configuration", "verification", "reconciliation", "security"]),
    audience: z.enum(["requester", "work_item_owner", "repo_owner", "operator", "security"]),
    subjectRef: z.string().min(1),
    state: z.enum(["open", "acknowledged", "resolved", "expired", "superseded"]),
    blocking: z.boolean(),
    summary: z.string().min(1),
    reason: z.string().min(1),
    options: z.array(HumanEscalationOptionSchema).min(1).optional(),
    nextAction: ActionHintSchema.optional(),
    dedupeKey: z.string().min(1).optional(),
    openedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    acknowledgement: z
      .object({
        actor: ActorIdentitySchema,
        acknowledgedAt: z.string().datetime()
      })
      .strict()
      .optional(),
    resolution: z
      .object({
        optionId: z.string().min(1).optional(),
        actor: ActorIdentitySchema,
        reason: z.string().min(1).optional(),
        resolvedAt: z.string().datetime()
      })
      .strict()
      .optional(),
    terminalReason: z.string().min(1).optional(),
    supersededById: z.string().min(1).optional()
  })
  .strict()
  .superRefine((escalation, ctx) => {
    if (escalation.state === "resolved" && !escalation.resolution) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A resolved human escalation requires resolution attribution.",
        path: ["resolution"]
      });
    }
    if (escalation.resolution && escalation.state !== "resolved") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Human escalation resolution is only valid for the resolved state.",
        path: ["state"]
      });
    }
    if (escalation.state === "acknowledged" && !escalation.acknowledgement) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An acknowledged human escalation requires actor attribution.",
        path: ["acknowledgement"]
      });
    }
    if (escalation.acknowledgement && escalation.state === "open") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An open human escalation cannot already be acknowledged.",
        path: ["state"]
      });
    }
    const openedAt = Date.parse(escalation.openedAt);
    if (escalation.expiresAt && Date.parse(escalation.expiresAt) <= openedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Human escalation expiresAt must be later than openedAt.",
        path: ["expiresAt"]
      });
    }
    if (escalation.state === "expired" && !escalation.expiresAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An expired human escalation requires expiresAt.",
        path: ["expiresAt"]
      });
    }
    if (escalation.state === "superseded" && !escalation.supersededById) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A superseded human escalation requires supersededById.",
        path: ["supersededById"]
      });
    }
    const optionIds = new Set<string>();
    escalation.options?.forEach((option, index) => {
      if (optionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Human escalation option ids must be unique.",
          path: ["options", index, "id"]
        });
      }
      optionIds.add(option.id);
    });
    if (escalation.resolution?.optionId && !optionIds.has(escalation.resolution.optionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Human escalation resolution optionId must identify one of the offered options.",
        path: ["resolution", "optionId"]
      });
    }
    if (escalation.resolution && Date.parse(escalation.resolution.resolvedAt) < openedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Human escalation resolvedAt cannot precede openedAt.",
        path: ["resolution", "resolvedAt"]
      });
    }
    if (escalation.acknowledgement && Date.parse(escalation.acknowledgement.acknowledgedAt) < openedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Human escalation acknowledgedAt cannot precede openedAt.",
        path: ["acknowledgement", "acknowledgedAt"]
      });
    }
    if (
      escalation.acknowledgement
      && escalation.resolution
      && Date.parse(escalation.resolution.resolvedAt) < Date.parse(escalation.acknowledgement.acknowledgedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Human escalation resolvedAt cannot precede acknowledgedAt.",
        path: ["resolution", "resolvedAt"]
      });
    }
    if (escalation.supersededById && escalation.state !== "superseded") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Human escalation supersededById is only valid for the superseded state.",
        path: ["supersededById"]
      });
    }
    if (escalation.terminalReason && escalation.state !== "expired" && escalation.state !== "superseded") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Human escalation terminalReason is only valid for expired or superseded states.",
        path: ["terminalReason"]
      });
    }
  });

export const WorkLoopCauseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completion_gate"),
    gateId: z.string().min(1),
    state: CompletionGateResultStateSchema,
    reasonCode: CompletionReasonCodeSchema
  }).strict(),
  z.object({
    kind: z.literal("human_escalation"),
    escalationId: z.string().min(1),
    class: z.enum(["approval", "missing_input", "configuration", "verification", "reconciliation", "security"]),
    audience: z.enum(["requester", "work_item_owner", "repo_owner", "operator", "security"]),
    blocking: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal("material_action"),
    actionId: z.string().min(1),
    outcome: z.enum(["failed", "unknown"]),
    receiptIds: z.array(z.string().min(1))
  }).strict(),
  z.object({
    kind: z.literal("run"),
    runId: z.string().min(1),
    conclusion: z.enum(["success", "failure", "cancelled", "interrupted", "timed_out", "needs_human"])
  }).strict()
]);

export const WorkLoopNextActionSchema = z.object({
  summary: z.string().min(1),
  hint: ActionHintSchema,
  causes: z.array(WorkLoopCauseSchema)
}).strict();

export const WorkLoopViewSchema = z.object({
  workThreadId: z.string().min(1),
  execution: z.enum(["idle", "running", "succeeded", "failed", "cancelled", "interrupted", "timed_out", "needs_human"]),
  completion: CompletionStateSchema,
  evidenceBacked: z.boolean(),
  contract: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    cycle: z.number().int().positive(),
    mode: z.enum(["execution_compat", "governed"])
  }).strict(),
  currentAssessment: CompletionAssessmentSchema,
  targetBindings: z.array(ResolvedCompletionTargetSchema),
  missingGateIds: z.array(z.string().min(1)),
  failedGateIds: z.array(z.string().min(1)),
  blockedGateIds: z.array(z.string().min(1)),
  nextAction: WorkLoopNextActionSchema
}).strict();

export const AcceptedProgressUnresolvedReasonSchema = z.enum([
  "gate_target_missing",
  "target_binding_missing",
  "target_artifact_missing",
  "artifact_not_found",
  "artifact_ambiguous",
  "artifact_source_run_missing",
  "source_run_not_in_work_thread"
]);

export const AcceptedProgressResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("attributed"),
    artifactId: z.string().min(1),
    sourceRunId: z.string().min(1)
  }).strict(),
  z.object({
    status: z.literal("unresolved"),
    reasonCode: AcceptedProgressUnresolvedReasonSchema
  }).strict()
]);

export const AcceptedGateAdvanceSchema = z.object({
  workThreadId: z.string().min(1),
  contractId: z.string().min(1),
  contractVersion: z.number().int().positive(),
  cycle: z.number().int().positive(),
  assessmentId: z.string().min(1),
  assessmentSequence: z.number().int().positive(),
  previousAssessmentId: z.string().min(1).optional(),
  gateId: CompletionGateIdSchema,
  targetKey: CompletionTargetKeySchema.optional(),
  acceptedState: z.literal("passed"),
  evidenceIds: z.array(z.string().min(1)),
  acceptedAt: z.string().datetime(),
  resolution: AcceptedProgressResolutionSchema
}).strict();

export const AcceptedProgressAttributionViewSchema = z.object({
  workThreadId: z.string().min(1),
  contract: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    cycle: z.number().int().positive()
  }).strict(),
  currentAssessmentId: z.string().min(1),
  advances: z.array(AcceptedGateAdvanceSchema),
  acceptedGateAdvanceCount: z.number().int().nonnegative(),
  attributedGateAdvanceCount: z.number().int().nonnegative(),
  unresolvedGateAdvanceCount: z.number().int().nonnegative(),
  runIdsWithAcceptedProgress: z.array(z.string().min(1))
}).strict().superRefine((view, ctx) => {
  if (view.advances.length !== view.acceptedGateAdvanceCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "acceptedGateAdvanceCount must equal the number of accepted gate advances.",
      path: ["acceptedGateAdvanceCount"]
    });
  }
  const attributedGateAdvanceCount = view.advances.filter((advance) => advance.resolution.status === "attributed").length;
  if (attributedGateAdvanceCount !== view.attributedGateAdvanceCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "attributedGateAdvanceCount must equal attributed advances.",
      path: ["attributedGateAdvanceCount"]
    });
  }
  if (view.advances.length - attributedGateAdvanceCount !== view.unresolvedGateAdvanceCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unresolvedGateAdvanceCount must equal unresolved advances.",
      path: ["unresolvedGateAdvanceCount"]
    });
  }
  const expectedRunIds = [...new Set(view.advances.flatMap((advance) =>
    advance.resolution.status === "attributed" ? [advance.resolution.sourceRunId] : []
  ))].sort();
  if (
    expectedRunIds.length !== view.runIdsWithAcceptedProgress.length
    || expectedRunIds.some((runId, index) => view.runIdsWithAcceptedProgress[index] !== runId)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "runIdsWithAcceptedProgress must be the unique sorted attributed source Run ids.",
      path: ["runIdsWithAcceptedProgress"]
    });
  }
  const seen = new Set<string>();
  view.advances.forEach((advance, index) => {
    if (
      advance.workThreadId !== view.workThreadId
      || advance.contractId !== view.contract.id
      || advance.contractVersion !== view.contract.version
      || advance.cycle !== view.contract.cycle
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accepted gate advance authority must match its attribution view.",
        path: ["advances", index]
      });
    }
    const identity = `${advance.assessmentId}\u0000${advance.gateId}`;
    if (seen.has(identity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accepted gate advances must be unique per assessment and gate.",
        path: ["advances", index]
      });
    }
    seen.add(identity);
  });
});

export const CanonicalMutationDomainSchema = z.enum([
  "status",
  "assignee",
  "priority",
  "labels",
  "schedule",
  "review",
  "artifact_links",
  "issue",
  "pull_request"
]);

export const MutationIntentSchema = z.object({
  intentId: z.string().min(1),
  domain: z.union([CanonicalMutationDomainSchema, z.string().min(1)]),
  action: z.string().min(1),
  summary: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  supersedesIntentIds: z.array(z.string().min(1)).optional(),
  sourcePointer: ContextPointerSchema.optional()
});

export const SuggestedChangesSnapshotSchema = z.object({
  proposalId: z.string().min(1),
  createdAt: z.string().datetime(),
  sourceRunId: z.string().min(1).optional(),
  workThread: WorkThreadSchema.optional(),
  summary: z.string().min(1),
  intents: z.array(MutationIntentSchema).min(1),
  preconditions: z.array(z.string().min(1)).optional(),
  supersedesProposalIds: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const MutationIntentActionabilitySchema = z.object({
  proposalId: z.string().min(1),
  intentId: z.string().min(1),
  domain: z.union([CanonicalMutationDomainSchema, z.string().min(1)]),
  status: z.enum(["current", "superseded", "stale", "conflicted"]),
  supersededByProposalId: z.string().min(1).optional(),
  supersededByIntentId: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
});

export const ProposalLineageSchema = z.object({
  scopeKey: z.string().min(1),
  entries: z.array(MutationIntentActionabilitySchema)
});

export const ApprovalDecisionSchema = z.object({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  approvedIntentIds: z.array(z.string().min(1)),
  rejectedIntentIds: z.array(z.string().min(1)).optional(),
  approvedBy: ActorIdentitySchema,
  approvedAt: z.string().datetime(),
  scope: z.enum(["manual", "policy"]),
  reason: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const ApplyIntentOutcomeSchema = z.object({
  intentId: z.string().min(1),
  outcome: z.enum(["applied", "skipped", "failed", "stale", "unsupported"]),
  message: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  externalUri: z.string().min(1).optional(),
  error: z.string().min(1).optional()
});

export const ApplyPlanSchema = z.object({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  approvalDecisionId: z.string().min(1),
  selectedIntentIds: z.array(z.string().min(1)),
  mode: z.enum(["preflight_then_per_intent", "atomic"]).default("preflight_then_per_intent"),
  adapter: z.string().min(1).optional(),
  adapterPlan: z.unknown().optional(),
  outcomes: z.array(ApplyIntentOutcomeSchema).optional()
});

export const OpenTagEventSchema = z.object({
  id: z.string().min(1),
  source: SourceSchema,
  sourceEventId: z.string().min(1),
  receivedAt: z.string().datetime(),
  actor: ActorIdentitySchema,
  target: AgentTargetSchema,
  command: OpenTagCommandSchema,
  context: z.array(ContextPointerSchema),
  workItem: WorkItemReferenceSchema.optional(),
  permissions: z.array(PermissionGrantSchema),
  callback: CallbackRouteSchema,
  metadata: z.record(z.string(), z.unknown())
});

function requireRunResultArtifactRunId(runId: string): void {
  if (runId.length === 0) {
    throw new Error("Run-result artifact IDs require a non-empty run ID.");
  }
}

/**
 * Stable identity for the dedicated pull-request field on a run result.
 */
export function runResultCreatedPullRequestArtifactId(runId: string): string {
  requireRunResultArtifactRunId(runId);
  return `${runId}:created-pull-request`;
}

/**
 * Stable identity for a run-result artifact that did not provide its own ID.
 *
 * `artifactIndex` is the zero-based position in `result.artifacts`; the
 * serialized suffix is deliberately one-based so the first artifact is `:1`.
 */
export function runResultArtifactId(runId: string, artifactIndex: number): string {
  requireRunResultArtifactRunId(runId);
  if (!Number.isSafeInteger(artifactIndex) || artifactIndex < 0) {
    throw new RangeError("Run-result artifact index must be a non-negative safe integer.");
  }
  return `${runId}:artifact:${artifactIndex + 1}`;
}

export const ResultArtifactSchema = z.object({
  id: z.string().min(1).optional(),
  type: RunArtifactTypeSchema.optional(),
  kind: ArtifactKindSchema.optional(),
  title: z.string(),
  uri: z.string(),
  summary: z.string().min(1).optional(),
  sourceRunId: z.string().min(1).optional(),
  createdAt: z.string().datetime().optional(),
  relatedIds: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const OpenTagRunResultSchema = z.object({
  conclusion: z.enum(["success", "failure", "cancelled", "interrupted", "timed_out", "needs_human"]),
  summary: z.string(),
  changedFiles: z.array(z.string()).optional(),
  createdPullRequestUrl: z.string().url().optional(),
  artifacts: z.array(ResultArtifactSchema).optional(),
  suggestedChanges: z.array(SuggestedChangesSnapshotSchema).optional(),
  approvalDecision: ApprovalDecisionSchema.optional(),
  applyPlan: ApplyPlanSchema.optional(),
  humanEscalation: HumanEscalationRequestSchema.optional(),
  humanEscalationId: z.string().min(1).optional(),
  humanResolutionUnavailableReason: z.string().min(1).optional(),
  verification: z
    .array(
      z.object({
        command: z.string(),
        outcome: z.enum(["passed", "failed", "not_run"]),
        excerpt: z.string().optional()
      })
    )
    .optional(),
  nextAction: NextActionSchema.optional()
});

export const OpenTagRunSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  status: z.enum(["queued", "assigned", "running", "needs_approval", "succeeded", "failed", "cancelled", "interrupted", "timed_out"]),
  thread: WorkThreadSchema.optional(),
  parentRunId: z.string().min(1).optional(),
  triggeredByAction: ActionHintSchema.optional(),
  sourceProposalId: z.string().min(1).optional(),
  sourceApplyPlanId: z.string().min(1).optional(),
  contextPacket: ContextPacketSchema.optional(),
  accessProfileSnapshot: AgentAccessProfileSnapshotSchema.optional(),
  policySnapshotProvenance: PolicySnapshotProvenanceSchema.optional(),
  assignedRunnerId: z.string().min(1).optional(),
  executor: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  result: OpenTagRunResultSchema.optional()
}).superRefine((run, ctx) => {
  if (Boolean(run.accessProfileSnapshot) !== Boolean(run.policySnapshotProvenance)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Run access and policy snapshots must be attached together.",
      path: [run.accessProfileSnapshot ? "policySnapshotProvenance" : "accessProfileSnapshot"]
    });
  }
  if (
    run.accessProfileSnapshot
    && run.policySnapshotProvenance
    && run.accessProfileSnapshot.policySnapshotId !== run.policySnapshotProvenance.id
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Run access profile must reference the attached policy snapshot provenance.",
      path: ["accessProfileSnapshot", "policySnapshotId"]
    });
  }
});

export type ActorIdentity = z.infer<typeof ActorIdentitySchema>;
export type AgentTarget = z.infer<typeof AgentTargetSchema>;
export type OpenTagCommand = z.infer<typeof OpenTagCommandSchema>;
export type ParsedOpenTagCommand = z.infer<typeof ParsedOpenTagCommandSchema>;
export type CommandParseDiagnostic = z.infer<typeof CommandParseDiagnosticSchema>;
export type CommandReference = z.infer<typeof CommandReferenceSchema>;
export type ContextPointer = z.infer<typeof ContextPointerSchema>;
export type ContextPacketAssemblyStage = z.infer<typeof ContextPacketAssemblyStageSchema>;
export type ContextPacketIntent = z.infer<typeof ContextPacketIntentSchema>;
export type ContextPacketSourceRole = z.infer<typeof ContextPacketSourceRoleSchema>;
export type ContextPacketSource = z.infer<typeof ContextPacketSourceSchema>;
export type ContextPacketFactConfidence = z.infer<typeof ContextPacketFactConfidenceSchema>;
export type ConversationHistoryTurn = z.infer<typeof ConversationHistoryTurnSchema>;
export type ConversationMemoryPolicy = z.infer<typeof ConversationMemoryPolicySchema>;
export type ContextPacket = z.infer<typeof ContextPacketSchema>;
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;
export type ConnectionRef = z.infer<typeof ConnectionRefSchema>;
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Grant = z.infer<typeof GrantSchema>;
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type PermissionDecisionKind = z.infer<typeof PermissionDecisionKindSchema>;
export type ActionRiskTier = z.infer<typeof ActionRiskTierSchema>;
export type NormalizedMaterialAction = z.infer<typeof NormalizedMaterialActionSchema>;
export type MaterialActionReceipt = z.infer<typeof MaterialActionReceiptSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type ActionPermissionRequest = z.infer<typeof ActionPermissionRequestSchema>;
export type ActionPermissionResolution = z.infer<typeof ActionPermissionResolutionSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type CapabilityClass = z.infer<typeof CapabilityClassSchema>;
export type CapabilityContract = z.infer<typeof CapabilityContractSchema>;
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicyResolution = z.infer<typeof PolicyResolutionSchema>;
export type PolicySnapshotProvenance = z.infer<typeof PolicySnapshotProvenanceSchema>;
export type AgentPrincipal = z.infer<typeof AgentPrincipalSchema>;
export type AgentAccessProfileSnapshot = z.infer<typeof AgentAccessProfileSnapshotSchema>;
export type AdapterMutationMapping = z.infer<typeof AdapterMutationMappingSchema>;
export type SuccessMetricName = z.infer<typeof SuccessMetricNameSchema>;
export type CallbackRoute = z.infer<typeof CallbackRouteSchema>;
export type WorkItemReference = z.infer<typeof WorkItemReferenceSchema>;
export type ConversationAnchor = z.infer<typeof ConversationAnchorSchema>;
export type WorkThread = z.infer<typeof WorkThreadSchema>;
export type RunAdmissionAction = z.infer<typeof RunAdmissionActionSchema>;
export type RunAdmissionReasonCode = z.infer<typeof RunAdmissionReasonCodeSchema>;
export type RunAdmissionDecision = z.infer<typeof RunAdmissionDecisionSchema>;
export type FollowUpRequestStatus = z.infer<typeof FollowUpRequestStatusSchema>;
export type FollowUpRequest = z.infer<typeof FollowUpRequestSchema>;
export type RunEventVisibility = z.infer<typeof RunEventVisibilitySchema>;
export type RunEventImportance = z.infer<typeof RunEventImportanceSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type RunArtifactType = z.infer<typeof RunArtifactTypeSchema>;
export type ActionHint = z.infer<typeof ActionHintSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
export type CompletionState = z.infer<typeof CompletionStateSchema>;
export type CompletionGateKind = z.infer<typeof CompletionGateKindSchema>;
export type CompletionEvidenceAssurance = z.infer<typeof CompletionEvidenceAssuranceSchema>;
export type CompletionTargetSelector = z.infer<typeof CompletionTargetSelectorSchema>;
export type ResolvedCompletionTarget = z.infer<typeof ResolvedCompletionTargetSchema>;
export type CompletionGate = z.infer<typeof CompletionGateSchema>;
export type CompletionContract = z.infer<typeof CompletionContractSchema>;
export type CompletionGateResultState = z.infer<typeof CompletionGateResultStateSchema>;
export type CompletionReasonCode = z.infer<typeof CompletionReasonCodeSchema>;
export type CompletionGateResult = z.infer<typeof CompletionGateResultSchema>;
export type CompletionWaiver = z.infer<typeof CompletionWaiverSchema>;
export type CompletionAssessment = z.infer<typeof CompletionAssessmentSchema>;
export type ReassessmentObligationSourceKind = z.infer<typeof ReassessmentObligationSourceKindSchema>;
export type ReassessmentObligationState = z.infer<typeof ReassessmentObligationStateSchema>;
export type ReassessmentObligationReasonCode = z.infer<typeof ReassessmentObligationReasonCodeSchema>;
export type ReassessmentObligation = z.infer<typeof ReassessmentObligationSchema>;
export type HumanEscalation = z.infer<typeof HumanEscalationSchema>;
export type HumanEscalationOption = z.infer<typeof HumanEscalationOptionSchema>;
export type WorkLoopCause = z.infer<typeof WorkLoopCauseSchema>;
export type WorkLoopNextAction = z.infer<typeof WorkLoopNextActionSchema>;
export type WorkLoopView = z.infer<typeof WorkLoopViewSchema>;
export type AcceptedProgressUnresolvedReason = z.infer<typeof AcceptedProgressUnresolvedReasonSchema>;
export type AcceptedProgressResolution = z.infer<typeof AcceptedProgressResolutionSchema>;
export type AcceptedGateAdvance = z.infer<typeof AcceptedGateAdvanceSchema>;
export type AcceptedProgressAttributionView = z.infer<typeof AcceptedProgressAttributionViewSchema>;
export type HumanEscalationRequest = z.infer<typeof HumanEscalationRequestSchema>;
export type CanonicalMutationDomain = z.infer<typeof CanonicalMutationDomainSchema>;
export type MutationIntent = z.infer<typeof MutationIntentSchema>;
export type SuggestedChangesSnapshot = z.infer<typeof SuggestedChangesSnapshotSchema>;
export type MutationIntentActionability = z.infer<typeof MutationIntentActionabilitySchema>;
export type ProposalLineage = z.infer<typeof ProposalLineageSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type ApplyIntentOutcome = z.infer<typeof ApplyIntentOutcomeSchema>;
export type ApplyPlan = z.infer<typeof ApplyPlanSchema>;
export type ResultArtifact = z.infer<typeof ResultArtifactSchema>;
export type OpenTagEvent = z.infer<typeof OpenTagEventSchema>;
export type OpenTagRun = z.infer<typeof OpenTagRunSchema>;
export type OpenTagRunResult = z.infer<typeof OpenTagRunResultSchema>;
