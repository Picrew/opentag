import { describe, expect, it } from "vitest";
import {
  FactoryRecipeBudgetSchema,
  FactoryRecipeSnapshotInputSchema,
  WorkstreamAdmissionBatchInputSchema,
  WorkstreamAdmissionBatchReceiptSchema,
  WorkstreamAdmissionBatchResultSchema,
  WorkstreamAdmissionBatchSchema,
  WorkstreamAdmissionQuietSummarySchema,
  WorkstreamInputSchema,
  WorkstreamMetricsSchema
} from "../src/factory.js";

describe("factory contracts", () => {
  const budgets = {
    maxConcurrentRuns: 4,
    maxAttemptsPerRun: 3,
    maxCostUnits: 100,
    costUnitsPerAttempt: 5,
    allowedLocalities: ["local", "private"] as const
  };

  it("keeps recipe request fields strict and server-owned fields out of input", () => {
    expect(FactoryRecipeSnapshotInputSchema.parse({
      id: "recipe_default",
      version: 1,
      name: "Default",
      budgets
    })).toMatchObject({ version: 1 });
    expect(() => FactoryRecipeSnapshotInputSchema.parse({
      id: "recipe_default",
      version: 1,
      name: "Default",
      budgets,
      createdAt: "2026-07-26T00:00:00.000Z"
    })).toThrow();
    expect(() => FactoryRecipeBudgetSchema.parse({ ...budgets, maxConcurrentRuns: 0 })).toThrow();
    expect(() => FactoryRecipeBudgetSchema.parse({ ...budgets, maxCostUnits: 4, costUnitsPerAttempt: 5 })).toThrow(/cannot exceed/u);
    expect(() => FactoryRecipeBudgetSchema.parse({ ...budgets, allowedLocalities: ["local", "local"] })).toThrow(/unique/u);
    expect(() => FactoryRecipeBudgetSchema.parse({ ...budgets, unknown: true })).toThrow();
  });

  it("accepts only unique WorkThread members", () => {
    const input = {
      id: "workstream_1",
      recipeId: "recipe_default",
      recipeVersion: 1,
      name: "Release",
      members: [
        { kind: "work_thread" as const, workThreadId: "thread_1" },
        { kind: "work_thread" as const, workThreadId: "thread_2" }
      ]
    };
    expect(WorkstreamInputSchema.parse(input).members).toHaveLength(2);
    expect(() => WorkstreamInputSchema.parse({ ...input, members: [] })).toThrow();
    expect(() => WorkstreamInputSchema.parse({ ...input, members: [input.members[0], input.members[0]] })).toThrow(/unique/u);
    expect(() => WorkstreamInputSchema.parse({
      ...input,
      members: [{ kind: "work_item", workItemReference: {} }]
    })).toThrow();
  });

  it("requires stable unique batch item and run identities with a bounded exception summary", () => {
    const event = {
      id: "event_1",
      source: "github",
      sourceEventId: "event_1",
      receivedAt: "2026-07-26T00:00:00.000Z",
      actor: { provider: "github", providerUserId: "actor_1" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "Please fix the release.", intent: "fix", args: {} },
      context: [],
      permissions: [],
      callback: { provider: "github", uri: "https://api.github.test/issues/1/comments" },
      metadata: {}
    };
    const first = { itemId: "item_1", runId: "run_1", workThreadId: "thread_1", event };
    expect(WorkstreamAdmissionBatchInputSchema.parse({
      id: "batch_1",
      workstreamId: "workstream_1",
      items: [first]
    }).items).toHaveLength(1);
    expect(() => WorkstreamAdmissionBatchInputSchema.parse({
      id: "batch_1",
      workstreamId: "workstream_1",
      items: [first, { ...first, itemId: "item_2" }]
    })).toThrow(/run ids must be unique/u);

    expect(WorkstreamAdmissionQuietSummarySchema.parse({
      totalItems: 12,
      createdCount: 0,
      idempotentReplayCount: 0,
      followUpQueuedCount: 0,
      needsHumanDecisionCount: 12,
      rejectedCount: 0,
      exceptionCount: 12,
      exceptions: Array.from({ length: 10 }, (_, index) => ({
        itemId: `item_${index}`,
        index,
        runId: `run_${index}`,
        status: "needs_human_decision" as const
      })),
      omittedExceptionCount: 2
    }).omittedExceptionCount).toBe(2);
  });

  it("binds durable batch receipts to their batch, progress, and final result", () => {
    const event = {
      id: "event_receipt",
      source: "github",
      sourceEventId: "event_receipt",
      receivedAt: "2026-07-26T00:00:00.000Z",
      actor: { provider: "github", providerUserId: "actor_1" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "Please fix the release.", intent: "fix", args: {} },
      context: [],
      permissions: [],
      callback: { provider: "github", uri: "https://api.github.test/issues/1/comments" },
      metadata: {}
    };
    const digest = `sha256:${"a".repeat(64)}`;
    const completedAt = "2026-07-26T00:01:00.000Z";
    const batch = WorkstreamAdmissionBatchSchema.parse({
      id: "batch_receipt",
      workstreamId: "workstream_1",
      items: [{ itemId: "item_1", runId: "run_1", workThreadId: "thread_1", event }],
      createdAt: "2026-07-26T00:00:00.000Z",
      contentDigest: digest
    });
    const itemResult = {
      itemId: "item_1",
      index: 0,
      runId: "run_1",
      status: "created" as const,
      statusCode: 201,
      admittedRunId: "run_1"
    };
    const summary = {
      totalItems: 1,
      createdCount: 1,
      idempotentReplayCount: 0,
      followUpQueuedCount: 0,
      needsHumanDecisionCount: 0,
      rejectedCount: 0,
      exceptionCount: 0,
      exceptions: [],
      omittedExceptionCount: 0
    };
    const result = WorkstreamAdmissionBatchResultSchema.parse({
      batchId: batch.id,
      workstreamId: batch.workstreamId,
      inputDigest: batch.contentDigest,
      results: [itemResult],
      summary,
      completedAt
    });
    const receipt = {
      batch,
      status: "completed" as const,
      items: [{
        itemId: "item_1",
        index: 0,
        runId: "run_1",
        workThreadId: "thread_1",
        status: "completed" as const,
        result: itemResult
      }],
      result,
      updatedAt: completedAt,
      completedAt
    };

    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(WorkstreamAdmissionBatchResultSchema.safeParse({ ...result, results: [] }).success).toBe(false);
    expect(WorkstreamAdmissionBatchResultSchema.safeParse({
      ...result,
      results: [itemResult, { ...itemResult, itemId: "item_2", runId: "run_2" }],
      summary: { ...summary, totalItems: 2, createdCount: 2 }
    }).success).toBe(false);
    expect(WorkstreamAdmissionBatchResultSchema.safeParse({
      ...result,
      results: [{ ...itemResult, status: "rejected", statusCode: 409, admittedRunId: undefined }]
    }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({ ...receipt, result: undefined }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({ ...receipt, completedAt: undefined }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({
      ...receipt,
      items: [{ ...receipt.items[0], result: undefined }]
    }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({ ...receipt, status: "processing" }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({
      ...receipt,
      result: { ...result, batchId: "batch_other" }
    }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({
      ...receipt,
      result: { ...result, workstreamId: "workstream_other" }
    }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({
      ...receipt,
      result: { ...result, inputDigest: `sha256:${"b".repeat(64)}` }
    }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({
      ...receipt,
      items: [{ ...receipt.items[0], runId: "run_other" }]
    }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({
      ...receipt,
      result: { ...result, results: [{ ...itemResult, runId: "run_other" }] }
    }).success).toBe(false);
    expect(WorkstreamAdmissionBatchReceiptSchema.safeParse({
      ...receipt,
      result: {
        ...result,
        results: [{ ...itemResult, status: "rejected", statusCode: 409, admittedRunId: undefined }],
        summary: { ...summary, createdCount: 0, rejectedCount: 1, exceptionCount: 1, omittedExceptionCount: 1 }
      }
    }).success).toBe(false);
  });

  it("validates WorkThread authority, run breakdown, cost, and locality dimensions", () => {
    const metrics = {
      workstreamId: "workstream_1",
      workThreadCount: 2,
      acceptedWorkThreadCount: 1,
      runCount: 3,
      queuedRunCount: 1,
      activeRunCount: 1,
      needsHumanRunCount: 0,
      terminalRunCount: 1,
      failedRunCount: 0,
      budgetBlockedRunCount: 0,
      exceptionCount: 0,
      totalAttempts: 2,
      attemptsPerRunExceededCount: 0,
      totalCostUnits: 10,
      attemptsByLocality: { local: 2, private: 0, hosted: 0, unknown: 0 }
    };
    expect(WorkstreamMetricsSchema.parse(metrics).acceptedWorkThreadCount).toBe(1);
    expect(() => WorkstreamMetricsSchema.parse({ ...metrics, acceptedWorkThreadCount: 3 })).toThrow(/workThreadCount/u);
    expect(() => WorkstreamMetricsSchema.parse({ ...metrics, queuedRunCount: 2 })).toThrow(/Run status counts/u);
    expect(() => WorkstreamMetricsSchema.parse({ ...metrics, attemptsByLocality: { local: 1, private: 0, hosted: 0, unknown: 0 } })).toThrow(/totalAttempts/u);
  });
});
