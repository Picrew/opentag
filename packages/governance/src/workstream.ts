import { createHash } from "node:crypto";
import {
  WorkstreamEvaluationInputSchema,
  WorkstreamEvaluationSchema,
  type RunnerLocality,
  type WorkstreamBudgetViolation,
  type WorkstreamEvaluation,
  type WorkstreamEvaluationInput
} from "@opentag/core";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function normalizedInput(input: WorkstreamEvaluationInput): WorkstreamEvaluationInput {
  return {
    ...input,
    recipe: {
      ...input.recipe,
      budgets: {
        ...input.recipe.budgets,
        allowedLocalities: [...input.recipe.budgets.allowedLocalities].sort(compareCodeUnits)
      }
    },
    workstream: {
      ...input.workstream,
      members: [...input.workstream.members].sort((left, right) => compareCodeUnits(left.workThreadId, right.workThreadId))
    }
  };
}

export function workstreamInputDigest(inputValue: WorkstreamEvaluationInput): string {
  const input = WorkstreamEvaluationInputSchema.parse(inputValue);
  const normalized = normalizedInput(input);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(normalized))).digest("hex")}`;
}

export function evaluateWorkstream(inputValue: WorkstreamEvaluationInput): WorkstreamEvaluation {
  const input = WorkstreamEvaluationInputSchema.parse(inputValue);
  if (input.recipe.id !== input.workstream.recipeId || input.recipe.version !== input.workstream.recipeVersion) {
    throw new Error("Workstream recipe reference does not match the evaluated recipe snapshot.");
  }
  if (input.metrics.workstreamId !== input.workstream.id) {
    throw new Error("Workstream metrics do not belong to the evaluated workstream.");
  }

  const violations: WorkstreamBudgetViolation[] = [];
  const budgets = input.recipe.budgets;
  const metrics = input.metrics;

  if (metrics.activeRunCount > budgets.maxConcurrentRuns) {
    violations.push({
      code: "concurrency_budget_exceeded",
      message: "Active runs exceed the recipe concurrency budget.",
      actual: metrics.activeRunCount,
      limit: budgets.maxConcurrentRuns
    });
  }
  if (metrics.attemptsPerRunExceededCount > 0) {
    violations.push({
      code: "attempt_budget_exceeded",
      message: "One or more runs exceed the recipe attempt budget.",
      actual: metrics.attemptsPerRunExceededCount,
      limit: budgets.maxAttemptsPerRun
    });
  }
  if (metrics.budgetBlockedRunCount > 0) {
    violations.push({
      code: "budget_blocked_runs",
      message: "One or more runs are blocked by a recipe budget.",
      actual: metrics.budgetBlockedRunCount
    });
  }

  const observedCostUnits = metrics.totalAttempts * budgets.costUnitsPerAttempt;
  if (metrics.totalCostUnits !== observedCostUnits) {
    violations.push({
      code: "cost_accounting_mismatch",
      message: "Reported cost units do not match the recipe cost per attempt.",
      actual: metrics.totalCostUnits,
      limit: observedCostUnits
    });
  }
  if (observedCostUnits > budgets.maxCostUnits) {
    violations.push({
      code: "cost_budget_exceeded",
      message: "Observed attempt cost exceeds the recipe cost budget.",
      actual: observedCostUnits,
      limit: budgets.maxCostUnits
    });
  }

  const allowedLocalities = new Set<RunnerLocality>(budgets.allowedLocalities);
  (Object.entries(metrics.attemptsByLocality) as Array<[RunnerLocality | "unknown", number]>).forEach(([locality, count]) => {
    if (locality === "unknown" && count > 0) {
      violations.push({
        code: "locality_budget_exceeded",
        message: "One or more attempts have no immutable locality snapshot.",
        actual: count
      });
      return;
    }
    if (locality !== "unknown" && count > 0 && !allowedLocalities.has(locality)) {
      violations.push({
        code: "locality_budget_exceeded",
        message: `Attempts ran in disallowed locality: ${locality}.`,
        actual: count,
        locality
      });
    }
  });

  violations.sort((left, right) =>
    compareCodeUnits(left.code, right.code) || compareCodeUnits(left.locality ?? "", right.locality ?? "")
  );

  return WorkstreamEvaluationSchema.parse({
    workstreamId: input.workstream.id,
    recipeId: input.recipe.id,
    recipeVersion: input.recipe.version,
    status: violations.length > 0 ? "blocked" : metrics.exceptionCount > 0 ? "attention_required" : "healthy",
    inputDigest: workstreamInputDigest(input),
    evaluatedAt: input.evaluatedAt,
    acceptedWorkThreadCount: metrics.acceptedWorkThreadCount,
    violations
  });
}
