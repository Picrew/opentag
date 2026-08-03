import { createHash } from "node:crypto";
import {
  WorkstreamContinuationDecisionInputSchema,
  WorkstreamContinuationDecisionSchema,
  type WorkstreamContinuationDecision,
  type WorkstreamContinuationDecisionInput,
  type WorkstreamContinuationReasonCode
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

function normalizedInput(input: WorkstreamContinuationDecisionInput): WorkstreamContinuationDecisionInput {
  return {
    ...input,
    recipe: {
      ...input.recipe,
      budgets: {
        ...input.recipe.budgets,
        allowedLocalities: [...input.recipe.budgets.allowedLocalities].sort(compareCodeUnits)
      },
      ...(input.recipe.continuation?.mode === "evidence_driven"
        ? {
            continuation: {
              ...input.recipe.continuation,
              triggers: [...input.recipe.continuation.triggers].sort(compareCodeUnits)
            }
          }
        : {})
    },
    workstream: {
      ...input.workstream,
      members: [...input.workstream.members].sort((left, right) => compareCodeUnits(left.workThreadId, right.workThreadId))
    },
    continuations: [...input.continuations]
      .sort((left, right) => compareCodeUnits(left.startedAt, right.startedAt) || compareCodeUnits(left.runId, right.runId)),
    activeRunIds: [...input.activeRunIds].sort(compareCodeUnits)
  };
}

export function workstreamContinuationInputDigest(inputValue: WorkstreamContinuationDecisionInput): string {
  const input = WorkstreamContinuationDecisionInputSchema.parse(inputValue);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(normalizedInput(input)))).digest("hex")}`;
}

function continuationNotBefore(input: WorkstreamContinuationDecisionInput): {
  notBefore?: string;
  reasonCode?: Extract<WorkstreamContinuationReasonCode, "cadence_not_elapsed" | "backoff_not_elapsed">;
} {
  const policy = input.recipe.continuation;
  if (!policy || policy.mode !== "evidence_driven" || input.continuations.length === 0) return {};
  const history = [...input.continuations]
    .sort((left, right) => compareCodeUnits(left.startedAt, right.startedAt) || compareCodeUnits(left.runId, right.runId));
  const latest = history.at(-1)!;
  let consecutiveRetryableFailures = 0;
  for (const continuation of [...history].reverse()) {
    if (continuation.conclusion === "failure" || continuation.conclusion === "interrupted" || continuation.conclusion === "timed_out") {
      consecutiveRetryableFailures += 1;
      continue;
    }
    break;
  }
  const backoffSeconds = consecutiveRetryableFailures === 0
    ? 0
    : Math.min(
        policy.backoff.maxSeconds,
        policy.backoff.initialSeconds * (2 ** Math.max(0, consecutiveRetryableFailures - 1))
      );
  const cadenceAt = Date.parse(latest.startedAt) + policy.minIntervalSeconds * 1_000;
  const backoffAt = Date.parse(latest.startedAt) + backoffSeconds * 1_000;
  const nextAt = Math.max(cadenceAt, backoffAt);
  if (Date.parse(input.evaluatedAt) >= nextAt) return {};
  return {
    notBefore: new Date(nextAt).toISOString(),
    reasonCode: backoffAt > cadenceAt ? "backoff_not_elapsed" : "cadence_not_elapsed"
  };
}

export function evaluateWorkstreamContinuation(
  inputValue: WorkstreamContinuationDecisionInput
): WorkstreamContinuationDecision {
  const input = WorkstreamContinuationDecisionInputSchema.parse(inputValue);
  if (input.recipe.id !== input.workstream.recipeId || input.recipe.version !== input.workstream.recipeVersion) {
    throw new Error("Workstream recipe reference does not match the continuation recipe snapshot.");
  }
  if (
    input.evaluation.workstreamId !== input.workstream.id
    || input.evaluation.recipeId !== input.recipe.id
    || input.evaluation.recipeVersion !== input.recipe.version
  ) {
    throw new Error("Workstream evaluation does not match the continuation workstream and recipe.");
  }
  if (!input.workstream.members.some((member) => member.workThreadId === input.workLoop.workThreadId)) {
    throw new Error("WorkLoop does not belong to the continuation workstream.");
  }
  if (input.continuations.some((continuation) =>
    continuation.workstreamId !== input.workstream.id || continuation.workThreadId !== input.workLoop.workThreadId
  )) {
    throw new Error("Continuation history does not belong to the evaluated Workstream and WorkThread.");
  }
  if (Date.parse(input.trigger.occurredAt) > Date.parse(input.evaluatedAt)) {
    throw new Error("Continuation trigger cannot occur after evaluatedAt.");
  }

  const base = {
    workstreamId: input.workstream.id,
    workThreadId: input.workLoop.workThreadId,
    trigger: input.trigger,
    nextAction: input.workLoop.nextAction,
    automaticContinuationCount: input.continuations.length,
    inputDigest: workstreamContinuationInputDigest(input),
    evaluatedAt: input.evaluatedAt
  };
  const decision = (
    action: WorkstreamContinuationDecision["action"],
    reasonCode: WorkstreamContinuationReasonCode,
    notBefore?: string
  ): WorkstreamContinuationDecision => WorkstreamContinuationDecisionSchema.parse({
    ...base,
    action,
    reasonCode,
    ...(notBefore ? { notBefore } : {})
  });

  if (input.workLoop.completion === "satisfied" || input.workLoop.completion === "waived") {
    return decision("terminal", "terminal_work_loop");
  }
  if (input.activeRunIds.length > 0 || input.workLoop.execution === "running") {
    return decision("wait", "active_run");
  }
  if (
    input.workLoop.nextAction.hint.kind === "request_human_decision"
    || input.workLoop.nextAction.hint.kind === "reconcile_material_action"
  ) {
    return decision("needs_human", "human_decision_required");
  }

  const policy = input.recipe.continuation;
  if (!policy || policy.mode === "manual") return decision("wait", "manual_policy");
  if (input.evaluation.status === "blocked") return decision("wait", "workstream_blocked");
  if (input.evaluation.status === "attention_required") {
    return decision("needs_human", "workstream_attention_required");
  }
  if (!policy.triggers.includes(input.trigger.kind)) return decision("wait", "trigger_not_enabled");
  if (input.continuations.some((continuation) => continuation.triggerId === input.trigger.id)) {
    return decision("wait", "trigger_already_consumed");
  }
  const latestContinuation = [...input.continuations]
    .sort((left, right) => compareCodeUnits(left.startedAt, right.startedAt) || compareCodeUnits(left.runId, right.runId))
    .at(-1);
  if (latestContinuation && Date.parse(input.trigger.occurredAt) <= Date.parse(latestContinuation.startedAt)) {
    return decision("wait", "stale_trigger");
  }
  if (input.workLoop.nextAction.hint.kind !== "resume_work_thread") {
    return decision("wait", "action_not_resumable");
  }
  if (input.continuations.length >= policy.maxContinuationsPerWorkThread) {
    return decision("needs_human", "continuation_limit_reached");
  }
  const timing = continuationNotBefore(input);
  if (timing.notBefore && timing.reasonCode) return decision("wait", timing.reasonCode, timing.notBefore);
  return decision("eligible", "eligible");
}
