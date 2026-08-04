import { describe, expect, it } from "vitest";
import type { WorkstreamEvaluationInput } from "@opentag/core";
import { evaluateWorkstream, workstreamInputDigest } from "../src/workstream.js";

const digest = `sha256:${"a".repeat(64)}`;

function baseInput(): WorkstreamEvaluationInput {
  return {
    recipe: {
      id: "recipe_1",
      version: 1,
      name: "Release",
      budgets: {
        maxConcurrentRuns: 2,
        maxAttemptsPerRun: 3,
        maxCostUnits: 20,
        costUnitsPerAttempt: 5,
        allowedLocalities: ["local", "private"]
      },
      createdAt: "2026-07-26T00:00:00.000Z",
      contentDigest: digest
    },
    workstream: {
      id: "workstream_1",
      recipeId: "recipe_1",
      recipeVersion: 1,
      name: "Release",
      members: [
        { kind: "work_thread", workThreadId: "thread_1" },
        { kind: "work_thread", workThreadId: "thread_2" }
      ],
      createdAt: "2026-07-26T00:00:00.000Z",
      contentDigest: digest
    },
    metrics: {
      workstreamId: "workstream_1",
      workThreadCount: 2,
      acceptedWorkThreadCount: 1,
      acceptedGateAdvanceCount: 1,
      attributedGateAdvanceCount: 1,
      unresolvedGateAdvanceCount: 0,
      runsWithAcceptedProgressCount: 1,
      runCount: 2,
      queuedRunCount: 0,
      activeRunCount: 1,
      needsHumanRunCount: 0,
      terminalRunCount: 1,
      failedRunCount: 0,
      budgetBlockedRunCount: 0,
      exceptionCount: 0,
      totalAttempts: 2,
      attemptsPerRunExceededCount: 0,
      totalCostUnits: 10,
      attemptsByLocality: { local: 1, private: 1, hosted: 0, unknown: 0 }
    },
    evaluatedAt: "2026-07-26T01:00:00.000Z"
  };
}

describe("evaluateWorkstream", () => {
  it("is deterministic and independent of set-like input ordering", () => {
    const input = baseInput();
    const reordered = {
      ...input,
      recipe: {
        ...input.recipe,
        budgets: { ...input.recipe.budgets, allowedLocalities: ["private", "local"] as const }
      },
      workstream: { ...input.workstream, members: [...input.workstream.members].reverse() }
    };
    expect(workstreamInputDigest(input)).toBe(workstreamInputDigest(reordered));
    expect(evaluateWorkstream(input)).toEqual(evaluateWorkstream(reordered));
    expect(evaluateWorkstream(input)).toMatchObject({ status: "healthy", acceptedWorkThreadCount: 1 });
  });

  it.each([
    ["concurrency_budget_exceeded", (input: WorkstreamEvaluationInput) => ({ ...input, metrics: { ...input.metrics, activeRunCount: 2, queuedRunCount: 0, terminalRunCount: 0 }, recipe: { ...input.recipe, budgets: { ...input.recipe.budgets, maxConcurrentRuns: 1 } } })],
    ["attempt_budget_exceeded", (input: WorkstreamEvaluationInput) => ({ ...input, metrics: { ...input.metrics, attemptsPerRunExceededCount: 1 } })],
    ["cost_budget_exceeded", (input: WorkstreamEvaluationInput) => ({ ...input, recipe: { ...input.recipe, budgets: { ...input.recipe.budgets, maxCostUnits: 9 } } })],
    ["cost_accounting_mismatch", (input: WorkstreamEvaluationInput) => ({ ...input, metrics: { ...input.metrics, totalCostUnits: 9 } })],
    ["locality_budget_exceeded", (input: WorkstreamEvaluationInput) => ({ ...input, metrics: { ...input.metrics, attemptsByLocality: { local: 1, private: 0, hosted: 1, unknown: 0 } } })],
    ["locality_budget_exceeded", (input: WorkstreamEvaluationInput) => ({ ...input, metrics: { ...input.metrics, attemptsByLocality: { local: 1, private: 0, hosted: 0, unknown: 1 } } })],
    ["budget_blocked_runs", (input: WorkstreamEvaluationInput) => ({ ...input, metrics: { ...input.metrics, budgetBlockedRunCount: 1 } })]
  ] as const)("fails closed for %s", (code, mutate) => {
    const evaluation = evaluateWorkstream(mutate(baseInput()));
    expect(evaluation.status).toBe("blocked");
    expect(evaluation.violations.map((violation) => violation.code)).toContain(code);
  });

  it("uses ordinary exceptions only as an attention signal", () => {
    const input = baseInput();
    const evaluation = evaluateWorkstream({ ...input, metrics: { ...input.metrics, exceptionCount: 1 } });
    expect(evaluation).toMatchObject({ status: "attention_required", violations: [] });
  });
});
