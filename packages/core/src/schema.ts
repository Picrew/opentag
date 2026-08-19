import { z } from "zod";
import { isCredentialSafeDisplayResource, isCredentialSafeText, isCredentialSafeValue } from "./credential-safety.js";
import { FrozenRoutingPolicySchema } from "./routing.js";

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
  flags: z.record(CommandFlagValueSchema),
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
  args: z.record(CommandArgValueSchema),
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
    metadata: z.record(z.unknown()).optional()
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
    resourceScope: z.record(z.unknown()),
    runId: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    expiresAt: z.string().datetime().optional(),
    constraints: z.record(z.unknown()).optional(),
    revokedAt: z.string().datetime().optional()
  })
  .strict();

export const ApprovalModeSchema = z.enum(["ask", "auto", "autonomous"]);
export const PermissionDecisionKindSchema = z.enum(["allow_once", "allow_run", "deny"]);
export const ActionRiskTierSchema = z.enum(["low", "medium", "high", "critical"]);
const CredentialSafeRecordSchema = z.record(z.unknown()).refine(isCredentialSafeValue, {
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
    metadata: z.record(z.unknown()).optional()
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
    metadata: z.record(z.unknown()).optional()
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
  values: z.record(z.string().min(1)),
  description: z.string().min(1).optional()
});

export const SuccessMetricNameSchema = z.enum([
  "time_to_first_useful_artifact",
  "thread_noise_ratio",
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
  metadata: z.record(z.unknown()).optional()
});

export const ConversationAnchorSchema = z.object({
  provider: ProviderSchema,
  kind: z.string().min(1),
  externalId: z.string().min(1),
  uri: z.string().min(1),
  threadKey: z.string().min(1).optional(),
  controlPlane: z.boolean().optional(),
  canApprove: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const WorkThreadSchema = z.object({
  id: z.string().min(1).optional(),
  workItemReference: WorkItemReferenceSchema,
  primaryAnchor: ConversationAnchorSchema,
  secondaryAnchors: z.array(ConversationAnchorSchema).optional()
});

export const RunAdmissionActionSchema = z.enum([
  "start",
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
    "none"
  ]),
  targetId: z.string().min(1).optional(),
  selectedIntentIds: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const NextActionSchema = z.union([
  z.string().min(1),
  z.object({
    summary: z.string().min(1),
    hint: ActionHintSchema
  })
]);

export const CompletionStateSchema = z.enum(["pending", "satisfied", "unsatisfied", "blocked", "waived"]);

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
  });

export const CompletionGateResultStateSchema = z.enum(["passed", "failed", "missing", "unknown", "waived"]);

export const CompletionReasonCodeSchema = z.enum([
  "artifact_requirement_satisfied",
  "artifact_missing",
  "artifact_ambiguous",
  "verification_passed",
  "verification_failed",
  "verification_missing",
  "verification_assurance_insufficient",
  "verification_subject_mismatch",
  "verification_stale",
  "external_state_satisfied",
  "external_state_mismatch",
  "external_state_missing",
  "external_state_assurance_insufficient",
  "external_state_subject_mismatch",
  "external_state_stale",
  "material_action_succeeded",
  "material_action_failed",
  "material_action_unknown",
  "material_action_missing",
  "human_acceptance_recorded",
  "human_acceptance_missing",
  "gate_waived",
  "waiver_invalid",
  "execution_succeeded",
  "execution_incomplete",
  "execution_not_succeeded"
]);

export const CompletionGateResultSchema = z
  .object({
    gateId: CompletionGateIdSchema,
    targetKey: CompletionTargetKeySchema.optional(),
    state: CompletionGateResultStateSchema,
    evidenceIds: z.array(z.string().min(1)),
    reasonCode: CompletionReasonCodeSchema,
    reason: z.string().min(1),
    evaluatedAt: z.string().datetime()
  })
  .strict();

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
    waivedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional()
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
    assessedAt: z.string().datetime(),
    assessedBy: z.enum(["opentag", "human"]),
    supersedesAssessmentId: z.string().min(1).optional(),
    acceptedAt: z.string().datetime().optional(),
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
    });
    if (assessment.state === "waived" && !assessment.waiver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A waived completion assessment requires waiver attribution.",
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
  params: z.record(z.unknown()).optional(),
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
  metadata: z.record(z.unknown()).optional()
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
  metadata: z.record(z.unknown()).optional()
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
  metadata: z.record(z.unknown())
});

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
  metadata: z.record(z.unknown()).optional()
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
export type HumanEscalation = z.infer<typeof HumanEscalationSchema>;
export type HumanEscalationOption = z.infer<typeof HumanEscalationOptionSchema>;
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
