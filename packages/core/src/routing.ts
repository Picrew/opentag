import { z } from "zod/v3";

export const RunnerLocalitySchema = z.enum(["local", "private", "hosted"]);
export const RunnerDeclaredStateSchema = z.enum(["ready", "draining"]);
export const RunnerReadinessStateSchema = z.enum(["ready", "stale", "draining", "at_capacity"]);
export const RunnerExecutorReadinessSchema = z.enum(["ready", "unavailable", "unknown"]);

const RoutingPreferenceIdsSchema = z.array(z.string().min(1)).max(64).superRefine((ids, ctx) => {
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Routing preference ids must be unique."
    });
  }
});

export const FrozenRoutingPolicySchema = z.object({
  runnerIds: RoutingPreferenceIdsSchema.nullable(),
  executorIds: RoutingPreferenceIdsSchema.nullable()
}).strict();

export const ExecutorCapabilityContractSchema = z
  .object({
    id: z.string().min(1),
    invocation: z.enum(["spawn", "hook_ingest", "hybrid"]),
    supportsProfile: z.boolean(),
    supportsStreaming: z.boolean(),
    supportsCancel: z.boolean(),
    supportsHookCompletion: z.boolean(),
    progressEvents: z.enum(["none", "audit", "human"]),
    approvalMode: z.enum(["none", "opentag_policy", "executor_managed"]),
    contextAccess: z.array(z.enum(["context_packet", "context_pointers", "workspace"])),
    promptAssembly: z.enum(["opentag", "executor_adapter", "external_runtime"]),
    writeAccess: z.enum(["none", "workspace", "external"]),
    conversationAccess: z.enum(["none", "request", "thread_transcript"]),
    promptMutation: z.enum(["none", "append", "replace"]),
    rawContextAccess: z.boolean(),
    writeActionAccess: z.enum(["none", "propose", "execute"]),
    workspaceIsolation: z.enum(["none", "branch", "worktree", "external"]),
    workspaceCwdConformance: z.enum(["declared", "unverified"]).optional(),
    sourceControl: z.enum(["none", "daemon_managed", "self_committing"]).optional(),
    requiredSecrets: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      required: z.boolean(),
      description: z.string().min(1).optional(),
      env: z.string().min(1).optional()
    }).strict()),
    completionSignals: z.array(z.object({
      type: z.enum(["process_exit", "hook_event", "stream_event"]),
      required: z.boolean(),
      description: z.string().min(1)
    }).strict())
  })
  .strict();

export const RoutingExecutorRequirementsSchema = z.object({
  requiredContextAccess: z.array(z.enum(["context_packet", "context_pointers", "workspace"])).default([]),
  minimumWriteAccess: z.enum(["none", "workspace", "external"]).default("none"),
  minimumWorkspaceIsolation: z.enum(["none", "branch", "worktree", "external"]).default("none"),
  requiresCancel: z.boolean().default(false),
  requiresSourceControl: z.boolean().default(false),
  requiresCompletionSignal: z.boolean().default(true)
}).strict();

export const RunnerExecutorRegistrationSchema = z
  .object({
    executorId: z.string().min(1),
    capability: ExecutorCapabilityContractSchema.optional(),
    readiness: RunnerExecutorReadinessSchema.default("unknown"),
    reason: z.string().min(1).optional()
  })
  .strict();

const RunnerRegistrationShape = {
  runnerId: z.string().min(1),
  name: z.string().min(1),
  locality: RunnerLocalitySchema.default("local"),
  declaredState: RunnerDeclaredStateSchema.default("ready"),
  executors: z.array(RunnerExecutorRegistrationSchema).default([]),
  maxConcurrentRuns: z.number().int().positive().max(1_000).default(1_000),
  preference: z.number().int().min(-1_000_000).max(1_000_000).default(0)
};

export const RunnerRegistrationRequestSchema = z
  .object(RunnerRegistrationShape)
  .strict()
  .partial({
    locality: true,
    declaredState: true,
    executors: true,
    maxConcurrentRuns: true,
    preference: true
  });

export const RunnerRegistrationInputSchema = z
  .object(RunnerRegistrationShape)
  .strict()
  .superRefine((registration, ctx) => {
    const executorIds = new Set<string>();
    registration.executors.forEach((executor, index) => {
      if (executorIds.has(executor.executorId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Runner executor ids must be unique.",
          path: ["executors", index, "executorId"]
        });
      }
      executorIds.add(executor.executorId);
    });
  });

export const RunnerDirectoryEntrySchema = z.object({
  ...RunnerRegistrationShape,
  readiness: z
    .object({
      state: RunnerReadinessStateSchema,
      reasonCode: z.string().min(1),
      reason: z.string().min(1)
    })
    .strict(),
  capacity: z
    .object({
      active: z.number().int().nonnegative(),
      limit: z.number().int().positive()
    })
    .strict(),
  createdAt: z.string().datetime(),
  heartbeatAt: z.string().datetime().optional()
}).strict();

export const RoutingCandidateReasonSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1)
  })
  .strict();

export const RoutingCandidateSchema = z
  .object({
    runnerId: z.string().min(1),
    executorId: z.string().min(1),
    eligible: z.boolean(),
    reasons: z.array(RoutingCandidateReasonSchema).min(1),
    locality: RunnerLocalitySchema.optional(),
    readiness: RunnerReadinessStateSchema.optional(),
    capacity: z
      .object({
        active: z.number().int().nonnegative(),
        limit: z.number().int().positive()
      })
      .strict()
      .optional()
  })
  .strict();

export const RoutingDecisionSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    policySnapshotId: z.string().min(1).optional(),
    accessProfileSnapshotId: z.string().min(1).optional(),
    candidates: z.array(RoutingCandidateSchema),
    selected: z
      .object({
        runnerId: z.string().min(1),
        executorId: z.string().min(1)
      })
      .strict()
      .optional(),
    reasonCode: z.string().min(1),
    reason: z.string().min(1),
    decidedAt: z.string().datetime()
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (!decision.selected) return;
    const selected = decision.candidates.find(
      (candidate) =>
        candidate.runnerId === decision.selected?.runnerId &&
        candidate.executorId === decision.selected.executorId
    );
    if (!selected?.eligible) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A routing decision may select only an eligible candidate.",
        path: ["selected"]
      });
    }
  });

export const AcceptedProgressSegmentSchema = z
  .object({
    id: z.string().min(1),
    completedRuns: z.number().int().nonnegative(),
    runsWithAcceptedProgress: z.number().int().nonnegative(),
    acceptedGateAdvances: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((segment, ctx) => {
    if (segment.runsWithAcceptedProgress > segment.acceptedGateAdvances) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runsWithAcceptedProgress cannot exceed acceptedGateAdvances.",
        path: ["runsWithAcceptedProgress"]
      });
    }
  });

export const AcceptedProgressMetricsSchema = z
  .object({
    completedRuns: z.number().int().nonnegative(),
    runsWithAcceptedProgress: z.number().int().nonnegative(),
    acceptedGateAdvances: z.number().int().nonnegative(),
    attributedAcceptedGateAdvances: z.number().int().nonnegative(),
    unresolvedAcceptedGateAdvances: z.number().int().nonnegative(),
    byRunner: z.array(AcceptedProgressSegmentSchema),
    byExecutor: z.array(AcceptedProgressSegmentSchema)
  })
  .strict()
  .superRefine((metrics, ctx) => {
    if (metrics.runsWithAcceptedProgress > metrics.attributedAcceptedGateAdvances) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runsWithAcceptedProgress cannot exceed attributedAcceptedGateAdvances.",
        path: ["runsWithAcceptedProgress"]
      });
    }
    if (
      metrics.attributedAcceptedGateAdvances + metrics.unresolvedAcceptedGateAdvances
      !== metrics.acceptedGateAdvances
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Attributed and unresolved accepted gate advances must equal acceptedGateAdvances.",
        path: ["acceptedGateAdvances"]
      });
    }
    for (const [field, segments] of [
      ["byRunner", metrics.byRunner],
      ["byExecutor", metrics.byExecutor]
    ] as const) {
      const seenIds = new Set<string>();
      segments.forEach((segment, index) => {
        if (seenIds.has(segment.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} ids must be unique.`,
            path: [field, index, "id"]
          });
        }
        seenIds.add(segment.id);
      });
      const completedRuns = segments.reduce((sum, segment) => sum + segment.completedRuns, 0);
      const runsWithAcceptedProgress = segments.reduce((sum, segment) => sum + segment.runsWithAcceptedProgress, 0);
      const acceptedGateAdvances = segments.reduce((sum, segment) => sum + segment.acceptedGateAdvances, 0);
      if (completedRuns !== metrics.completedRuns) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} completedRuns must equal the aggregate metrics.`,
          path: [field]
        });
      }
      if (
        runsWithAcceptedProgress > metrics.runsWithAcceptedProgress
        || acceptedGateAdvances > metrics.attributedAcceptedGateAdvances
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} accepted progress cannot exceed the attributed aggregate metrics.`,
          path: [field]
        });
      }
    }
  });

export type RunnerLocality = z.infer<typeof RunnerLocalitySchema>;
export type RunnerDeclaredState = z.infer<typeof RunnerDeclaredStateSchema>;
export type RunnerReadinessState = z.infer<typeof RunnerReadinessStateSchema>;
export type FrozenRoutingPolicy = z.infer<typeof FrozenRoutingPolicySchema>;
export type RunnerExecutorRegistration = z.infer<typeof RunnerExecutorRegistrationSchema>;
export type ExecutorCapabilityContract = z.infer<typeof ExecutorCapabilityContractSchema>;
export type RoutingExecutorRequirements = z.infer<typeof RoutingExecutorRequirementsSchema>;
export type RunnerRegistrationInput = z.input<typeof RunnerRegistrationInputSchema>;
export type RunnerRegistrationRequest = z.infer<typeof RunnerRegistrationRequestSchema>;
export type RunnerRegistrationConfig = z.infer<typeof RunnerRegistrationInputSchema>;
export type RunnerDirectoryEntry = z.infer<typeof RunnerDirectoryEntrySchema>;
export type RoutingCandidate = z.infer<typeof RoutingCandidateSchema>;
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;
export type AcceptedProgressSegment = z.infer<typeof AcceptedProgressSegmentSchema>;
export type AcceptedProgressMetrics = z.infer<typeof AcceptedProgressMetricsSchema>;
