import type {
  CompletionContract,
  WorkstreamContinuationDecisionInput,
  WorkstreamContinuationRecord
} from "@opentag/core";
import { describe, expect, it } from "vitest";
import {
  deriveWorkLoopView,
  evaluateCompletion,
  evaluateWorkstream,
  evaluateWorkstreamContinuation,
  workstreamContinuationInputDigest
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const t0 = "2026-08-03T00:00:00.000Z";
const t1 = "2026-08-03T00:01:00.000Z";
const t2 = "2026-08-03T00:02:00.000Z";
const t3 = "2026-08-03T00:03:00.000Z";

function completionContract(): CompletionContract {
  return {
    id: "contract_continuation",
    version: 1,
    workThreadId: "thread_1",
    cycle: 1,
    mode: "execution_compat",
    targetSelectors: [],
    resolvedFrom: [{ scope: "organization_default", ref: "continuation-test", version: "1" }],
    gates: [{ id: "execution", kind: "material_action", actionFamily: "executor_run", requiredOutcome: "succeeded" }],
    maxAutomaticRetries: 0,
    onSatisfied: "report_only",
    createdAt: t0
  };
}

function baseInput(): WorkstreamContinuationDecisionInput {
  const contract = completionContract();
  const runResults = [{
    runId: "run_failed",
    result: { conclusion: "failure" as const, summary: "The bounded attempt failed." },
    recordedAt: t1
  }];
  const assessment = evaluateCompletion({
    contract,
    runResults,
    artifacts: [],
    evidence: [],
    materialActionReceipts: [],
    waivers: [],
    evaluatedAt: t1
  });
  const recipe = {
    id: "recipe_1",
    version: 1,
    name: "Evidence-driven continuation",
    continuation: {
      mode: "evidence_driven" as const,
      triggers: ["retryable_run_failure", "completion_evidence_changed"] as const,
      maxContinuationsPerWorkThread: 3,
      minIntervalSeconds: 60,
      backoff: { initialSeconds: 30, maxSeconds: 300 }
    },
    budgets: {
      maxConcurrentRuns: 2,
      maxAttemptsPerRun: 3,
      maxCostUnits: 20,
      costUnitsPerAttempt: 5,
      allowedLocalities: ["local", "private"] as const
    },
    createdAt: t0,
    contentDigest: digest
  };
  const workstream = {
    id: "workstream_1",
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    name: "Continuation test",
    members: [
      { kind: "work_thread" as const, workThreadId: "thread_1" },
      { kind: "work_thread" as const, workThreadId: "thread_2" }
    ],
    createdAt: t0,
    contentDigest: digest
  };
  const metrics = {
    workstreamId: workstream.id,
    workThreadCount: 2,
    acceptedWorkThreadCount: 2,
    runCount: 1,
    queuedRunCount: 0,
    activeRunCount: 0,
    needsHumanRunCount: 0,
    terminalRunCount: 1,
    failedRunCount: 1,
    budgetBlockedRunCount: 0,
    exceptionCount: 0,
    totalAttempts: 1,
    attemptsPerRunExceededCount: 0,
    totalCostUnits: 5,
    attemptsByLocality: { local: 1, private: 0, hosted: 0, unknown: 0 }
  };
  return {
    recipe,
    workstream,
    evaluation: evaluateWorkstream({ recipe, workstream, metrics, evaluatedAt: t2 }),
    workLoop: deriveWorkLoopView({ contract, runResults, assessment }),
    trigger: { id: "trigger_1", kind: "retryable_run_failure", occurredAt: t2 },
    activeRunIds: [],
    continuations: [],
    evaluatedAt: t3
  };
}

function record(input: Partial<WorkstreamContinuationRecord> = {}): WorkstreamContinuationRecord {
  return {
    workstreamId: "workstream_1",
    workThreadId: "thread_1",
    runId: "run_continuation_1",
    triggerId: "trigger_previous",
    startedAt: t1,
    conclusion: "failure",
    ...input
  };
}

describe("evaluateWorkstreamContinuation", () => {
  it("is deterministic across set-like recipe, member, and history ordering", () => {
    const input = baseInput();
    const first = record({ runId: "run_continuation_1", startedAt: "2026-08-02T23:50:00.000Z", conclusion: "success" });
    const second = record({ runId: "run_continuation_2", triggerId: "trigger_previous_2", startedAt: t1, conclusion: "success" });
    const reordered = {
      ...input,
      recipe: {
        ...input.recipe,
        continuation: input.recipe.continuation?.mode === "evidence_driven"
          ? { ...input.recipe.continuation, triggers: [...input.recipe.continuation.triggers].reverse() }
          : input.recipe.continuation,
        budgets: { ...input.recipe.budgets, allowedLocalities: [...input.recipe.budgets.allowedLocalities].reverse() }
      },
      workstream: { ...input.workstream, members: [...input.workstream.members].reverse() },
      continuations: [second, first]
    };
    const original = { ...input, continuations: [first, second] };
    expect(workstreamContinuationInputDigest(reordered)).toBe(workstreamContinuationInputDigest(original));
    expect(evaluateWorkstreamContinuation(reordered)).toEqual(evaluateWorkstreamContinuation(original));
    expect(evaluateWorkstreamContinuation(original)).toMatchObject({
      action: "eligible",
      reasonCode: "eligible",
      nextAction: { hint: { kind: "resume_work_thread", targetId: "thread_1" } },
      automaticContinuationCount: 2
    });
  });

  it("defaults missing and manual policies to a visible wait decision", () => {
    const input = baseInput();
    for (const continuation of [undefined, { mode: "manual" as const }]) {
      const recipe = { ...input.recipe, continuation };
      expect(evaluateWorkstreamContinuation({ ...input, recipe })).toMatchObject({
        action: "wait",
        reasonCode: "manual_policy"
      });
    }
  });

  it("fails closed for Workstream governance, human action, and non-resumable WorkLoop actions", () => {
    const input = baseInput();
    expect(evaluateWorkstreamContinuation({
      ...input,
      evaluation: {
        ...input.evaluation,
        status: "blocked",
        violations: [{ code: "budget_blocked_runs", message: "A run is budget blocked.", actual: 1 }]
      }
    })).toMatchObject({ action: "wait", reasonCode: "workstream_blocked" });
    expect(evaluateWorkstreamContinuation({
      ...input,
      evaluation: { ...input.evaluation, status: "attention_required", violations: [] }
    })).toMatchObject({ action: "needs_human", reasonCode: "workstream_attention_required" });
    expect(evaluateWorkstreamContinuation({
      ...input,
      workLoop: {
        ...input.workLoop,
        nextAction: {
          summary: "Refresh completion evidence.",
          hint: { kind: "refresh_completion_evidence", targetId: "checks" },
          causes: input.workLoop.nextAction.causes
        }
      }
    })).toMatchObject({ action: "wait", reasonCode: "action_not_resumable" });
    expect(evaluateWorkstreamContinuation({
      ...input,
      workLoop: {
        ...input.workLoop,
        nextAction: {
          summary: "Resolve a blocking decision.",
          hint: { kind: "request_human_decision", targetId: "escalation_1" },
          causes: []
        }
      }
    })).toMatchObject({ action: "needs_human", reasonCode: "human_decision_required" });
  });

  it("rejects disabled, consumed, and stale triggers without creating work", () => {
    const input = baseInput();
    expect(evaluateWorkstreamContinuation({
      ...input,
      trigger: { ...input.trigger, kind: "human_escalation_resolved" }
    })).toMatchObject({ action: "wait", reasonCode: "trigger_not_enabled" });
    expect(evaluateWorkstreamContinuation({
      ...input,
      continuations: [record({ triggerId: input.trigger.id })]
    })).toMatchObject({ action: "wait", reasonCode: "trigger_already_consumed" });
    expect(evaluateWorkstreamContinuation({
      ...input,
      trigger: { ...input.trigger, occurredAt: t1 },
      continuations: [record({ startedAt: t1 })]
    })).toMatchObject({ action: "wait", reasonCode: "stale_trigger" });
  });

  it("enforces continuation count, cadence, and exponential failure backoff", () => {
    const input = baseInput();
    expect(evaluateWorkstreamContinuation({
      ...input,
      continuations: [
        record({ runId: "continuation_1", triggerId: "past_1", startedAt: "2026-08-02T23:40:00.000Z" }),
        record({ runId: "continuation_2", triggerId: "past_2", startedAt: "2026-08-02T23:45:00.000Z" }),
        record({ runId: "continuation_3", triggerId: "past_3", startedAt: "2026-08-02T23:50:00.000Z" })
      ]
    })).toMatchObject({ action: "needs_human", reasonCode: "continuation_limit_reached" });

    const backoffInput = {
      ...input,
      recipe: {
        ...input.recipe,
        continuation: input.recipe.continuation?.mode === "evidence_driven"
          ? { ...input.recipe.continuation, backoff: { initialSeconds: 120, maxSeconds: 300 } }
          : input.recipe.continuation
      },
      trigger: { ...input.trigger, occurredAt: "2026-08-03T00:02:10.000Z" },
      continuations: [record({ startedAt: t2 })],
      evaluatedAt: "2026-08-03T00:02:20.000Z"
    };
    expect(evaluateWorkstreamContinuation(backoffInput)).toMatchObject({
      action: "wait",
      reasonCode: "backoff_not_elapsed",
      notBefore: "2026-08-03T00:04:00.000Z"
    });

    expect(evaluateWorkstreamContinuation({
      ...backoffInput,
      recipe: input.recipe,
      continuations: [record({ startedAt: t2, conclusion: "success" })]
    })).toMatchObject({
      action: "wait",
      reasonCode: "cadence_not_elapsed",
      notBefore: "2026-08-03T00:03:00.000Z"
    });
  });

  it("stops terminal and active loops before considering automatic policy", () => {
    const input = baseInput();
    expect(evaluateWorkstreamContinuation({
      ...input,
      workLoop: {
        ...input.workLoop,
        completion: "satisfied",
        nextAction: { summary: "No completion action is required.", hint: { kind: "none" }, causes: [] }
      }
    })).toMatchObject({ action: "terminal", reasonCode: "terminal_work_loop" });
    expect(evaluateWorkstreamContinuation({
      ...input,
      activeRunIds: ["run_active"]
    })).toMatchObject({ action: "wait", reasonCode: "active_run" });
  });

  it("rejects unbound history, duplicate records, and future trigger claims", () => {
    const input = baseInput();
    expect(() => evaluateWorkstreamContinuation({
      ...input,
      continuations: [record({ workstreamId: "workstream_other" })]
    })).toThrow(/history does not belong/u);
    expect(() => evaluateWorkstreamContinuation({
      ...input,
      continuations: [record(), record()]
    })).toThrow(/run ids must be unique/u);
    expect(() => evaluateWorkstreamContinuation({
      ...input,
      trigger: { ...input.trigger, occurredAt: "2026-08-03T00:04:00.000Z" }
    })).toThrow(/cannot occur after/u);
  });
});
