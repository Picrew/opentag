import { createHash } from "node:crypto";
import {
  RoutingDecisionSchema,
  type RoutingCandidate,
  type RoutingDecision,
  RoutingExecutorRequirementsSchema,
  type RunnerDirectoryEntry,
  type RunnerLocality
} from "@opentag/core";

export type RoutingLocalityRequirement = "local_required" | "private_required" | "hosted_allowed";

export type RoutingEvaluationInput = {
  runId: string;
  policySnapshotId?: string;
  accessProfileSnapshotId?: string;
  runnerIds: string[];
  executorIds: string[];
  runners: RunnerDirectoryEntry[];
  requirements?: Parameters<typeof RoutingExecutorRequirementsSchema.parse>[0];
  rejectedPlacements?: Array<{ runnerId: string; executorId: string; reason: string }>;
  projectTarget?: {
    bound: boolean;
    allowedRunnerIds: string[];
  };
  access: {
    allowedRunnerIds?: string[];
    allowedExecutorIds?: string[];
    locality?: RoutingLocalityRequirement;
    unresolvedConnectionRefs: boolean;
  };
  decidedAt: string;
};

const WRITE_ACCESS_RANK = { none: 0, workspace: 1, external: 2 } as const;
const ISOLATION_RANK = { none: 0, branch: 1, worktree: 2, external: 3 } as const;

function executorCapabilityReasons(
  capability: NonNullable<RunnerDirectoryEntry["executors"][number]["capability"]>,
  requirements: ReturnType<typeof RoutingExecutorRequirementsSchema.parse>
): RoutingCandidate["reasons"] {
  const reasons: RoutingCandidate["reasons"] = [];
  const missingContext = requirements.requiredContextAccess.filter((required) => !capability.contextAccess.includes(required));
  if (missingContext.length) {
    reasons.push({ code: "executor_context_capability_mismatch", message: `Executor does not provide required context access: ${missingContext.join(", ")}.` });
  }
  if (WRITE_ACCESS_RANK[capability.writeAccess] < WRITE_ACCESS_RANK[requirements.minimumWriteAccess]) {
    reasons.push({ code: "executor_write_capability_mismatch", message: `Executor write access '${capability.writeAccess}' is below required '${requirements.minimumWriteAccess}'.` });
  }
  if (ISOLATION_RANK[capability.workspaceIsolation] < ISOLATION_RANK[requirements.minimumWorkspaceIsolation]) {
    reasons.push({ code: "executor_isolation_capability_mismatch", message: `Executor isolation '${capability.workspaceIsolation}' is below required '${requirements.minimumWorkspaceIsolation}'.` });
  }
  if (requirements.requiresCancel && !capability.supportsCancel) {
    reasons.push({ code: "executor_cancel_capability_mismatch", message: "Executor does not support required cancellation." });
  }
  if (requirements.requiresSourceControl && (!capability.sourceControl || capability.sourceControl === "none")) {
    reasons.push({ code: "executor_source_control_capability_mismatch", message: "Executor does not provide required source-control behavior." });
  }
  if (requirements.requiresCompletionSignal && !capability.completionSignals.some((signal) => signal.required)) {
    reasons.push({ code: "executor_completion_capability_mismatch", message: "Executor does not declare an authoritative completion signal." });
  }
  return reasons;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function localityAllows(required: RoutingLocalityRequirement | undefined, actual: RunnerLocality): boolean {
  if (!required || required === "hosted_allowed") return true;
  if (required === "local_required") return actual === "local";
  return actual === "local" || actual === "private";
}

function routingDecisionId(identity: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(identity))).digest("hex");
  return `routing_${digest.slice(0, 24)}`;
}

export function evaluateRouting(input: RoutingEvaluationInput): RoutingDecision {
  const runnerById = new Map(input.runners.map((runner) => [runner.runnerId, runner]));
  const candidates: RoutingCandidate[] = [];
  const requirements = RoutingExecutorRequirementsSchema.parse(input.requirements ?? {});

  for (const runnerId of input.runnerIds) {
    const runner = runnerById.get(runnerId);
    for (const executorId of input.executorIds) {
      const reasons: RoutingCandidate["reasons"] = [];
      let eligible = true;
      if (!runner) {
        eligible = false;
        reasons.push({ code: "runner_not_registered", message: "Runner identity is not present in the directory." });
      } else {
        reasons.push({ code: runner.readiness.reasonCode, message: runner.readiness.reason });
        if (runner.readiness.state !== "ready") eligible = false;
      }

      if (input.projectTarget) {
        if (!input.projectTarget.bound) {
          eligible = false;
          reasons.push({ code: "project_target_unbound", message: "Project Target has no runner binding." });
        } else if (!input.projectTarget.allowedRunnerIds.includes(runnerId)) {
          eligible = false;
          reasons.push({ code: "runner_not_bound_to_project", message: "Runner is not in the Project Target routing preference." });
        } else {
          reasons.push({ code: "runner_bound_to_project", message: "Runner is bound to the Project Target." });
        }
      } else {
        reasons.push({ code: "repository_free_run", message: "Run does not require a Project Target binding." });
      }

      if (input.access.allowedRunnerIds !== undefined && !input.access.allowedRunnerIds.includes(runnerId)) {
        eligible = false;
        reasons.push({ code: "runner_not_allowed_by_access_profile", message: "Access profile does not allow this runner." });
      } else {
        reasons.push({ code: "runner_allowed_by_access_profile", message: "Access profile allows this runner." });
      }

      if (runner && !localityAllows(input.access.locality, runner.locality)) {
        eligible = false;
        reasons.push({ code: "runner_locality_mismatch", message: "Runner locality does not satisfy the captured access profile." });
      } else if (runner) {
        reasons.push({ code: "runner_locality_satisfied", message: "Runner locality satisfies the captured access profile." });
      }

      if (input.access.allowedExecutorIds !== undefined && !input.access.allowedExecutorIds.includes(executorId)) {
        eligible = false;
        reasons.push({ code: "executor_not_allowed_by_access_profile", message: "Access profile does not allow this executor." });
      } else {
        reasons.push({ code: "executor_allowed_by_access_profile", message: "Access profile allows this executor." });
      }

      if (input.access.unresolvedConnectionRefs) {
        eligible = false;
        reasons.push({
          code: "credential_resolution_unreported",
          message: "Runner did not report credential-reference resolution capability for this run."
        });
      }

      if (runner) {
        const executor = runner.executors.find((candidate) => candidate.executorId === executorId);
        if (runner.executors.length === 0) {
          reasons.push({
            code: "executor_capability_legacy_unspecified",
            message: "Legacy runner registration did not report executor capability; attempt startup remains authoritative."
          });
        } else if (!executor) {
          eligible = false;
          reasons.push({ code: "executor_not_configured", message: "Runner did not register this executor." });
        } else if (executor.readiness === "unavailable") {
          eligible = false;
          reasons.push({ code: "executor_unavailable", message: executor.reason ?? "Runner reported this executor unavailable." });
        } else if (executor.readiness === "unknown") {
          eligible = false;
          reasons.push({
            code: "executor_readiness_unknown",
            message: executor.reason ?? "Executor readiness is unknown, so it cannot receive a new attempt."
          });
        } else if (!executor.capability) {
          eligible = false;
          reasons.push({ code: "executor_capability_unreported", message: "Explicit executor registration did not include a typed capability contract." });
        } else {
          const mismatchReasons = executorCapabilityReasons(executor.capability, requirements);
          if (mismatchReasons.length) {
            eligible = false;
            reasons.push(...mismatchReasons);
          } else {
            reasons.push({ code: "executor_capability_satisfied", message: "Executor capability satisfies the run requirements." });
            reasons.push({ code: "executor_ready", message: "Runner reported this executor ready." });
          }
        }
      }

      const rejectedPlacement = input.rejectedPlacements?.find(
        (rejected) => rejected.runnerId === runnerId && rejected.executorId === executorId
      );
      if (rejectedPlacement) {
        eligible = false;
        reasons.push({ code: "executor_preflight_rejected", message: rejectedPlacement.reason });
      }

      candidates.push({
        runnerId,
        executorId,
        eligible,
        reasons,
        ...(runner ? { locality: runner.locality, readiness: runner.readiness.state, capacity: runner.capacity } : {})
      });
    }
  }

  const selectedCandidate = candidates.find((candidate) => candidate.eligible);
  const reasonCode = selectedCandidate ? "preferred_eligible_candidate" : "no_eligible_runner";
  const reason = selectedCandidate
    ? "Selected the first eligible target in the configured stable preference order."
    : "No registered runner and executor target satisfies every routing constraint.";
  const identity = {
    runId: input.runId,
    ...(input.policySnapshotId ? { policySnapshotId: input.policySnapshotId } : {}),
    ...(input.accessProfileSnapshotId ? { accessProfileSnapshotId: input.accessProfileSnapshotId } : {}),
    candidates,
    ...(selectedCandidate ? { selected: { runnerId: selectedCandidate.runnerId, executorId: selectedCandidate.executorId } } : {}),
    reasonCode,
    reason
  };
  return RoutingDecisionSchema.parse({
    id: routingDecisionId(identity),
    ...identity,
    decidedAt: input.decidedAt
  });
}
