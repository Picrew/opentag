import { z } from "zod";
import { RunnerLocalitySchema } from "./routing.js";
import { OpenTagEventSchema, WorkLoopNextActionSchema, WorkLoopViewSchema } from "./schema.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const NonNegativeIntegerSchema = z.number().int().nonnegative();

const UniqueLocalitiesSchema = z.array(RunnerLocalitySchema).min(1).max(3).superRefine((localities, ctx) => {
  localities.forEach((locality, index) => {
    if (localities.indexOf(locality) !== index) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed runner localities must be unique.",
        path: [index]
      });
    }
  });
});

export const FactoryRecipeBudgetSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(1_000),
  maxAttemptsPerRun: z.number().int().min(1).max(100),
  maxCostUnits: z.number().int().positive(),
  costUnitsPerAttempt: z.number().int().positive(),
  allowedLocalities: UniqueLocalitiesSchema
}).strict().superRefine((budget, ctx) => {
  if (budget.costUnitsPerAttempt > budget.maxCostUnits) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "costUnitsPerAttempt cannot exceed maxCostUnits.",
      path: ["costUnitsPerAttempt"]
    });
  }
});

export const WorkstreamContinuationTriggerSchema = z.enum([
  "completion_evidence_changed",
  "human_escalation_resolved",
  "retryable_run_failure"
]);

const UniqueContinuationTriggersSchema = z.array(WorkstreamContinuationTriggerSchema).min(1).max(3)
  .superRefine((triggers, ctx) => {
    triggers.forEach((trigger, index) => {
      if (triggers.indexOf(trigger) !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Continuation triggers must be unique.",
          path: [index]
        });
      }
    });
  });

export const WorkstreamContinuationPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("manual") }).strict(),
  z.object({
    mode: z.literal("evidence_driven"),
    triggers: UniqueContinuationTriggersSchema,
    maxContinuationsPerWorkThread: z.number().int().min(1).max(100),
    minIntervalSeconds: z.number().int().min(0).max(86_400),
    backoff: z.object({
      initialSeconds: z.number().int().min(1).max(86_400),
      maxSeconds: z.number().int().min(1).max(604_800)
    }).strict().superRefine((backoff, ctx) => {
      if (backoff.maxSeconds < backoff.initialSeconds) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Continuation maxSeconds cannot be less than initialSeconds.",
          path: ["maxSeconds"]
        });
      }
    })
  }).strict()
]);

export const FactoryRecipeSnapshotInputSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  completionProfileId: z.string().min(1).optional(),
  continuation: WorkstreamContinuationPolicySchema.optional(),
  budgets: FactoryRecipeBudgetSchema
}).strict();

export const FactoryRecipeSnapshotSchema = FactoryRecipeSnapshotInputSchema.extend({
  createdAt: z.string().datetime(),
  contentDigest: Sha256DigestSchema
}).strict();

export const WorkstreamMemberSchema = z.object({
  kind: z.literal("work_thread"),
  workThreadId: z.string().min(1)
}).strict();

export const WorkstreamInputSchema = z.object({
  id: z.string().min(1),
  recipeId: z.string().min(1),
  recipeVersion: z.number().int().positive(),
  name: z.string().min(1),
  members: z.array(WorkstreamMemberSchema).min(1).max(1_000).superRefine((members, ctx) => {
    const seen = new Set<string>();
    members.forEach((member, index) => {
      if (seen.has(member.workThreadId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Workstream member keys must be unique.",
          path: [index, "workThreadId"]
        });
      }
      seen.add(member.workThreadId);
    });
  })
}).strict();

export const WorkstreamSchema = WorkstreamInputSchema.extend({
  createdAt: z.string().datetime(),
  contentDigest: Sha256DigestSchema
}).strict();

export const WorkstreamAdmissionBatchItemSchema = z.object({
  itemId: z.string().min(1),
  runId: z.string().min(1),
  workThreadId: z.string().min(1),
  event: OpenTagEventSchema
}).strict();

export const WorkstreamAdmissionBatchInputSchema = z.object({
  id: z.string().min(1),
  workstreamId: z.string().min(1),
  items: z.array(WorkstreamAdmissionBatchItemSchema).min(1).max(1_000).superRefine((items, ctx) => {
    const itemIds = new Set<string>();
    const runIds = new Set<string>();
    items.forEach((item, index) => {
      if (itemIds.has(item.itemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Admission batch item ids must be unique.",
          path: [index, "itemId"]
        });
      }
      itemIds.add(item.itemId);
      if (runIds.has(item.runId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Admission batch run ids must be unique.",
          path: [index, "runId"]
        });
      }
      runIds.add(item.runId);
    });
  })
}).strict();

export const WorkstreamAdmissionBatchSchema = WorkstreamAdmissionBatchInputSchema.extend({
  createdAt: z.string().datetime(),
  contentDigest: Sha256DigestSchema
}).strict();

export const WorkstreamAdmissionResultStatusSchema = z.enum([
  "created",
  "idempotent_replay",
  "follow_up_queued",
  "wait_active_run",
  "needs_human_decision",
  "rejected"
]);

export const WorkstreamAdmissionBatchItemResultSchema = z.object({
  itemId: z.string().min(1),
  index: NonNegativeIntegerSchema,
  runId: z.string().min(1),
  status: WorkstreamAdmissionResultStatusSchema,
  statusCode: z.number().int().min(100).max(599).optional(),
  reasonCode: z.string().min(1).optional(),
  admittedRunId: z.string().min(1).optional(),
  followUpRequestId: z.string().min(1).optional(),
  humanEscalationId: z.string().min(1).optional()
}).strict();

function admissionItemResultsEqual(
  left: z.infer<typeof WorkstreamAdmissionBatchItemResultSchema>,
  right: z.infer<typeof WorkstreamAdmissionBatchItemResultSchema>
): boolean {
  return left.itemId === right.itemId
    && left.index === right.index
    && left.runId === right.runId
    && left.status === right.status
    && left.statusCode === right.statusCode
    && left.reasonCode === right.reasonCode
    && left.admittedRunId === right.admittedRunId
    && left.followUpRequestId === right.followUpRequestId
    && left.humanEscalationId === right.humanEscalationId;
}

export const WorkstreamAdmissionQuietExceptionSchema = z.object({
  itemId: z.string().min(1),
  index: NonNegativeIntegerSchema,
  runId: z.string().min(1),
  status: z.enum(["needs_human_decision", "rejected"]),
  reasonCode: z.string().min(1).optional()
}).strict();

export const WorkstreamAdmissionQuietSummarySchema = z.object({
  totalItems: NonNegativeIntegerSchema,
  createdCount: NonNegativeIntegerSchema,
  idempotentReplayCount: NonNegativeIntegerSchema,
  followUpQueuedCount: NonNegativeIntegerSchema,
  waitActiveRunCount: NonNegativeIntegerSchema,
  needsHumanDecisionCount: NonNegativeIntegerSchema,
  rejectedCount: NonNegativeIntegerSchema,
  exceptionCount: NonNegativeIntegerSchema,
  exceptions: z.array(WorkstreamAdmissionQuietExceptionSchema).max(10),
  omittedExceptionCount: NonNegativeIntegerSchema
}).strict().superRefine((summary, ctx) => {
  const counted = summary.createdCount
    + summary.idempotentReplayCount
    + summary.followUpQueuedCount
    + summary.waitActiveRunCount
    + summary.needsHumanDecisionCount
    + summary.rejectedCount;
  if (counted !== summary.totalItems) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Admission result counts must equal totalItems." });
  }
  if (summary.exceptionCount !== summary.needsHumanDecisionCount + summary.rejectedCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exceptionCount must include all exceptional outcomes." });
  }
  if (summary.exceptions.length > summary.exceptionCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Exception samples cannot exceed exceptionCount." });
  }
  if (summary.omittedExceptionCount !== summary.exceptionCount - summary.exceptions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "omittedExceptionCount must describe unsampled exceptions." });
  }
});

export const WorkstreamAdmissionBatchResultSchema = z.object({
  batchId: z.string().min(1),
  workstreamId: z.string().min(1),
  inputDigest: Sha256DigestSchema,
  results: z.array(WorkstreamAdmissionBatchItemResultSchema).max(1_000),
  summary: WorkstreamAdmissionQuietSummarySchema,
  completedAt: z.string().datetime()
}).strict().superRefine((result, ctx) => {
  if (result.results.length !== result.summary.totalItems) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Result count must equal summary totalItems.", path: ["results"] });
  }
  const itemIds = new Set(result.results.map((item) => item.itemId));
  if (itemIds.size !== result.results.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Admission result item ids must be unique.", path: ["results"] });
  }
  const indices = new Set(result.results.map((item) => item.index));
  if (indices.size !== result.results.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Admission result indices must be unique.", path: ["results"] });
  }
  const counts = {
    createdCount: result.results.filter((item) => item.status === "created").length,
    idempotentReplayCount: result.results.filter((item) => item.status === "idempotent_replay").length,
    followUpQueuedCount: result.results.filter((item) => item.status === "follow_up_queued").length,
    waitActiveRunCount: result.results.filter((item) => item.status === "wait_active_run").length,
    needsHumanDecisionCount: result.results.filter((item) => item.status === "needs_human_decision").length,
    rejectedCount: result.results.filter((item) => item.status === "rejected").length
  };
  for (const [field, count] of Object.entries(counts)) {
    if (result.summary[field as keyof typeof counts] !== count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must match the corresponding admission results.`,
        path: ["summary", field]
      });
    }
  }
});

export const WorkstreamAdmissionBatchProgressItemSchema = z.object({
  itemId: z.string().min(1),
  index: NonNegativeIntegerSchema,
  runId: z.string().min(1),
  workThreadId: z.string().min(1),
  status: z.enum(["pending", "processing", "completed"]),
  result: WorkstreamAdmissionBatchItemResultSchema.optional()
}).strict().superRefine((item, ctx) => {
  if ((item.status === "completed") !== Boolean(item.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Only completed items carry a durable result.", path: ["result"] });
  }
});

export const WorkstreamAdmissionBatchReceiptSchema = z.object({
  batch: WorkstreamAdmissionBatchSchema,
  status: z.enum(["processing", "completed"]),
  items: z.array(WorkstreamAdmissionBatchProgressItemSchema).min(1).max(1_000),
  result: WorkstreamAdmissionBatchResultSchema.optional(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional()
}).strict().superRefine((receipt, ctx) => {
  if (receipt.items.length !== receipt.batch.items.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Receipt progress must cover every durable batch item.",
      path: ["items"]
    });
  }
  receipt.items.forEach((item, index) => {
    const batchItem = receipt.batch.items[index];
    if (
      !batchItem
      || item.index !== index
      || item.itemId !== batchItem.itemId
      || item.runId !== batchItem.runId
      || item.workThreadId !== batchItem.workThreadId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Receipt progress item identity must match the durable batch item at the same index.",
        path: ["items", index]
      });
    }
  });
  if (receipt.result) {
    if (
      receipt.result.batchId !== receipt.batch.id
      || receipt.result.workstreamId !== receipt.batch.workstreamId
      || receipt.result.inputDigest !== receipt.batch.contentDigest
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Receipt result must describe the same durable batch and input digest.",
        path: ["result"]
      });
    }
    if (receipt.result.summary.totalItems !== receipt.items.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Receipt result must cover every batch item.",
        path: ["result", "summary", "totalItems"]
      });
    }
    receipt.result.results.forEach((resultItem, index) => {
      const progressItem = receipt.items[index];
      if (
        !progressItem
        || resultItem.index !== index
        || resultItem.itemId !== progressItem.itemId
        || resultItem.runId !== progressItem.runId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Receipt result item identity must match progress at the same index.",
          path: ["result", "results", index]
        });
      } else if (!progressItem.result || !admissionItemResultsEqual(resultItem, progressItem.result)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Receipt result item must match the complete durable progress result at the same index.",
          path: ["result", "results", index]
        });
      }
    });
  }
  if (receipt.status === "completed") {
    if (!receipt.result || !receipt.completedAt || receipt.items.some((item) => item.status !== "completed")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A completed batch receipt requires all item results and completion metadata." });
    }
  } else if (receipt.result || receipt.completedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A processing batch receipt cannot carry final completion metadata." });
  }
});

export const WorkstreamLocalityMetricsSchema = z.object({
  local: NonNegativeIntegerSchema,
  private: NonNegativeIntegerSchema,
  hosted: NonNegativeIntegerSchema,
  unknown: NonNegativeIntegerSchema
}).strict();

export const WorkstreamMetricsSchema = z.object({
  workstreamId: z.string().min(1),
  workThreadCount: NonNegativeIntegerSchema,
  acceptedWorkThreadCount: NonNegativeIntegerSchema,
  runCount: NonNegativeIntegerSchema,
  queuedRunCount: NonNegativeIntegerSchema,
  activeRunCount: NonNegativeIntegerSchema,
  needsHumanRunCount: NonNegativeIntegerSchema,
  terminalRunCount: NonNegativeIntegerSchema,
  failedRunCount: NonNegativeIntegerSchema,
  budgetBlockedRunCount: NonNegativeIntegerSchema,
  exceptionCount: NonNegativeIntegerSchema,
  totalAttempts: NonNegativeIntegerSchema,
  attemptsPerRunExceededCount: NonNegativeIntegerSchema,
  totalCostUnits: NonNegativeIntegerSchema,
  attemptsByLocality: WorkstreamLocalityMetricsSchema
}).strict().superRefine((metrics, ctx) => {
  if (metrics.acceptedWorkThreadCount > metrics.workThreadCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "acceptedWorkThreadCount cannot exceed workThreadCount.", path: ["acceptedWorkThreadCount"] });
  }
  if (metrics.attemptsPerRunExceededCount > metrics.runCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "attemptsPerRunExceededCount cannot exceed runCount.", path: ["attemptsPerRunExceededCount"] });
  }
  const localityAttempts = metrics.attemptsByLocality.local
    + metrics.attemptsByLocality.private
    + metrics.attemptsByLocality.hosted
    + metrics.attemptsByLocality.unknown;
  if (localityAttempts !== metrics.totalAttempts) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Locality attempt counts must equal totalAttempts.", path: ["attemptsByLocality"] });
  }
  const categorizedRuns = metrics.queuedRunCount
    + metrics.activeRunCount
    + metrics.needsHumanRunCount
    + metrics.terminalRunCount;
  if (categorizedRuns !== metrics.runCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Run status counts must equal runCount." });
  }
  if (metrics.budgetBlockedRunCount > metrics.runCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "budgetBlockedRunCount cannot exceed runCount.", path: ["budgetBlockedRunCount"] });
  }
  if (metrics.failedRunCount > metrics.terminalRunCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "failedRunCount cannot exceed terminalRunCount.", path: ["failedRunCount"] });
  }
});

export const WorkstreamBudgetViolationCodeSchema = z.enum([
  "concurrency_budget_exceeded",
  "attempt_budget_exceeded",
  "cost_budget_exceeded",
  "cost_accounting_mismatch",
  "locality_budget_exceeded",
  "budget_blocked_runs"
]);

export const WorkstreamBudgetViolationSchema = z.object({
  code: WorkstreamBudgetViolationCodeSchema,
  message: z.string().min(1),
  actual: NonNegativeIntegerSchema,
  limit: NonNegativeIntegerSchema.optional(),
  locality: RunnerLocalitySchema.optional()
}).strict();

export const WorkstreamEvaluationInputSchema = z.object({
  recipe: FactoryRecipeSnapshotSchema,
  workstream: WorkstreamSchema,
  metrics: WorkstreamMetricsSchema,
  evaluatedAt: z.string().datetime()
}).strict();

export const WorkstreamEvaluationSchema = z.object({
  workstreamId: z.string().min(1),
  recipeId: z.string().min(1),
  recipeVersion: z.number().int().positive(),
  status: z.enum(["healthy", "attention_required", "blocked"]),
  inputDigest: Sha256DigestSchema,
  evaluatedAt: z.string().datetime(),
  acceptedWorkThreadCount: NonNegativeIntegerSchema,
  violations: z.array(WorkstreamBudgetViolationSchema)
}).strict();

export const WorkstreamContinuationTriggerEventSchema = z.object({
  id: z.string().min(1),
  kind: WorkstreamContinuationTriggerSchema,
  occurredAt: z.string().datetime()
}).strict();

export const WorkstreamContinuationRecordSchema = z.object({
  workstreamId: z.string().min(1),
  workThreadId: z.string().min(1),
  runId: z.string().min(1),
  triggerId: z.string().min(1),
  startedAt: z.string().datetime(),
  conclusion: z.enum(["success", "failure", "cancelled", "interrupted", "timed_out", "needs_human"]).optional()
}).strict();

export const WorkstreamContinuationDecisionInputSchema = z.object({
  recipe: FactoryRecipeSnapshotSchema,
  workstream: WorkstreamSchema,
  evaluation: WorkstreamEvaluationSchema,
  workLoop: WorkLoopViewSchema,
  trigger: WorkstreamContinuationTriggerEventSchema,
  activeRunIds: z.array(z.string().min(1)).max(100).superRefine((runIds, ctx) => {
    runIds.forEach((runId, index) => {
      if (runIds.indexOf(runId) !== index) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Active continuation run ids must be unique.", path: [index] });
      }
    });
  }),
  continuations: z.array(WorkstreamContinuationRecordSchema).max(1_000).superRefine((continuations, ctx) => {
    const runIds = new Set<string>();
    const triggerIds = new Set<string>();
    continuations.forEach((continuation, index) => {
      if (runIds.has(continuation.runId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Continuation run ids must be unique.", path: [index, "runId"] });
      }
      runIds.add(continuation.runId);
      if (triggerIds.has(continuation.triggerId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Continuation trigger ids must be unique.", path: [index, "triggerId"] });
      }
      triggerIds.add(continuation.triggerId);
    });
  }),
  evaluatedAt: z.string().datetime()
}).strict();

export const WorkstreamContinuationReasonCodeSchema = z.enum([
  "eligible",
  "terminal_work_loop",
  "active_run",
  "human_decision_required",
  "manual_policy",
  "workstream_blocked",
  "workstream_attention_required",
  "trigger_not_enabled",
  "trigger_already_consumed",
  "stale_trigger",
  "action_not_resumable",
  "continuation_limit_reached",
  "cadence_not_elapsed",
  "backoff_not_elapsed"
]);

export const WorkstreamContinuationDecisionSchema = z.object({
  workstreamId: z.string().min(1),
  workThreadId: z.string().min(1),
  trigger: WorkstreamContinuationTriggerEventSchema,
  action: z.enum(["eligible", "wait", "needs_human", "terminal"]),
  reasonCode: WorkstreamContinuationReasonCodeSchema,
  nextAction: WorkLoopNextActionSchema,
  automaticContinuationCount: NonNegativeIntegerSchema,
  notBefore: z.string().datetime().optional(),
  inputDigest: Sha256DigestSchema,
  evaluatedAt: z.string().datetime()
}).strict();

export type FactoryRecipeBudget = z.infer<typeof FactoryRecipeBudgetSchema>;
export type FactoryRecipeSnapshotInput = z.infer<typeof FactoryRecipeSnapshotInputSchema>;
export type FactoryRecipeSnapshot = z.infer<typeof FactoryRecipeSnapshotSchema>;
export type WorkstreamMember = z.infer<typeof WorkstreamMemberSchema>;
export type WorkstreamInput = z.infer<typeof WorkstreamInputSchema>;
export type Workstream = z.infer<typeof WorkstreamSchema>;
export type WorkstreamAdmissionBatchItem = z.infer<typeof WorkstreamAdmissionBatchItemSchema>;
export type WorkstreamAdmissionBatchInput = z.infer<typeof WorkstreamAdmissionBatchInputSchema>;
export type WorkstreamAdmissionBatch = z.infer<typeof WorkstreamAdmissionBatchSchema>;
export type WorkstreamAdmissionResultStatus = z.infer<typeof WorkstreamAdmissionResultStatusSchema>;
export type WorkstreamAdmissionBatchItemResult = z.infer<typeof WorkstreamAdmissionBatchItemResultSchema>;
export type WorkstreamAdmissionQuietSummary = z.infer<typeof WorkstreamAdmissionQuietSummarySchema>;
export type WorkstreamAdmissionBatchResult = z.infer<typeof WorkstreamAdmissionBatchResultSchema>;
export type WorkstreamAdmissionBatchProgressItem = z.infer<typeof WorkstreamAdmissionBatchProgressItemSchema>;
export type WorkstreamAdmissionBatchReceipt = z.infer<typeof WorkstreamAdmissionBatchReceiptSchema>;
export type WorkstreamMetrics = z.infer<typeof WorkstreamMetricsSchema>;
export type WorkstreamBudgetViolation = z.infer<typeof WorkstreamBudgetViolationSchema>;
export type WorkstreamEvaluationInput = z.infer<typeof WorkstreamEvaluationInputSchema>;
export type WorkstreamEvaluation = z.infer<typeof WorkstreamEvaluationSchema>;
export type WorkstreamContinuationTrigger = z.infer<typeof WorkstreamContinuationTriggerSchema>;
export type WorkstreamContinuationPolicy = z.infer<typeof WorkstreamContinuationPolicySchema>;
export type WorkstreamContinuationTriggerEvent = z.infer<typeof WorkstreamContinuationTriggerEventSchema>;
export type WorkstreamContinuationRecord = z.infer<typeof WorkstreamContinuationRecordSchema>;
export type WorkstreamContinuationDecisionInput = z.infer<typeof WorkstreamContinuationDecisionInputSchema>;
export type WorkstreamContinuationReasonCode = z.infer<typeof WorkstreamContinuationReasonCodeSchema>;
export type WorkstreamContinuationDecision = z.infer<typeof WorkstreamContinuationDecisionSchema>;
