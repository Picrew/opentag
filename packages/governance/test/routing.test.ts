import type { RunnerDirectoryEntry } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { evaluateRouting } from "../src/index.js";

const decidedAt = "2026-07-25T00:00:00.000Z";
const capability = {
  id: "codex",
  invocation: "spawn" as const,
  supportsProfile: false,
  supportsStreaming: true,
  supportsCancel: true,
  supportsHookCompletion: false,
  progressEvents: "audit" as const,
  approvalMode: "opentag_policy" as const,
  contextAccess: ["context_packet" as const, "context_pointers" as const, "workspace" as const],
  promptAssembly: "opentag" as const,
  writeAccess: "workspace" as const,
  conversationAccess: "request" as const,
  promptMutation: "none" as const,
  rawContextAccess: false,
  writeActionAccess: "propose" as const,
  workspaceIsolation: "worktree" as const,
  sourceControl: "self_committing" as const,
  requiredSecrets: [],
  completionSignals: [{ type: "stream_event" as const, required: true, description: "Executor stop response." }]
};

function runner(input: {
  runnerId: string;
  locality?: RunnerDirectoryEntry["locality"];
  readiness?: RunnerDirectoryEntry["readiness"]["state"];
  executors?: RunnerDirectoryEntry["executors"];
  active?: number;
}): RunnerDirectoryEntry {
  const readiness = input.readiness ?? "ready";
  return {
    runnerId: input.runnerId,
    name: input.runnerId,
    locality: input.locality ?? "local",
    declaredState: readiness === "draining" ? "draining" : "ready",
    executors: input.executors ?? [{ executorId: "codex", readiness: "ready", capability }],
    maxConcurrentRuns: 1,
    preference: 0,
    readiness: {
      state: readiness,
      reasonCode: `runner_${readiness}`,
      reason: `Runner is ${readiness}.`
    },
    capacity: { active: input.active ?? (readiness === "at_capacity" ? 1 : 0), limit: 1 },
    createdAt: decidedAt,
    heartbeatAt: decidedAt
  };
}

describe("evaluateRouting", () => {
  it("selects the first eligible candidate and keeps rejected alternatives explainable", () => {
    const decision = evaluateRouting({
      runId: "run_1",
      runnerIds: ["runner-primary", "runner-fallback"],
      executorIds: ["codex"],
      runners: [
        runner({ runnerId: "runner-primary", readiness: "at_capacity" }),
        runner({ runnerId: "runner-fallback" })
      ],
      projectTarget: { bound: true, allowedRunnerIds: ["runner-primary", "runner-fallback"] },
      access: { unresolvedConnectionRefs: false },
      decidedAt
    });

    expect(decision).toMatchObject({
      reasonCode: "preferred_eligible_candidate",
      selected: { runnerId: "runner-fallback", executorId: "codex" },
      candidates: [
        {
          runnerId: "runner-primary",
          eligible: false,
          reasons: expect.arrayContaining([expect.objectContaining({ code: "runner_at_capacity" })])
        },
        { runnerId: "runner-fallback", eligible: true }
      ]
    });
  });

  it("fails closed without relaxing locality, credentials, or executor capability", () => {
    const decision = evaluateRouting({
      runId: "run_2",
      runnerIds: ["runner-hosted"],
      executorIds: ["hermes"],
      runners: [runner({
        runnerId: "runner-hosted",
        locality: "hosted",
        executors: [{ executorId: "codex", readiness: "ready", capability }]
      })],
      projectTarget: { bound: true, allowedRunnerIds: ["runner-hosted"] },
      access: { locality: "local_required", unresolvedConnectionRefs: true },
      decidedAt
    });

    expect(decision).toMatchObject({
      reasonCode: "no_eligible_runner",
      candidates: [{
        eligible: false,
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: "runner_locality_mismatch" }),
          expect.objectContaining({ code: "credential_resolution_unreported" }),
          expect.objectContaining({ code: "executor_not_configured" })
        ])
      }]
    });
    expect(decision).not.toHaveProperty("selected");
  });

  it("treats factory recipe locality as an additional hard routing constraint", () => {
    const decision = evaluateRouting({
      runId: "run_factory_locality",
      runnerIds: ["runner-hosted", "runner-local"],
      executorIds: ["codex"],
      runners: [
        runner({ runnerId: "runner-hosted", locality: "hosted" }),
        runner({ runnerId: "runner-local", locality: "local" })
      ],
      access: { allowedLocalities: ["local"], unresolvedConnectionRefs: false },
      decidedAt
    });
    expect(decision.selected).toMatchObject({ runnerId: "runner-local" });
    expect(decision.candidates[0]).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code: "runner_locality_not_allowed_by_factory_recipe" })])
    });
  });

  it("derives a stable decision id independently of evaluation time", () => {
    const input = {
      runId: "run_stable",
      runnerIds: ["runner_1"],
      executorIds: ["codex"],
      runners: [runner({ runnerId: "runner_1" })],
      access: { unresolvedConnectionRefs: false }
    };

    const first = evaluateRouting({ ...input, decidedAt });
    const second = evaluateRouting({ ...input, decidedAt: "2026-07-25T00:01:00.000Z" });

    expect(first.id).toBe(second.id);
    expect(first.decidedAt).not.toBe(second.decidedAt);
  });

  it("treats present empty allowlists as deny-all while omitted allowlists do not widen or narrow candidates", () => {
    const base = {
      runId: "run_allowlists",
      runnerIds: ["runner_1"],
      executorIds: ["codex"],
      runners: [runner({ runnerId: "runner_1" })],
      decidedAt
    };
    expect(evaluateRouting({ ...base, access: { unresolvedConnectionRefs: false } }).selected)
      .toEqual({ runnerId: "runner_1", executorId: "codex" });
    expect(evaluateRouting({ ...base, access: { allowedRunnerIds: [], unresolvedConnectionRefs: false } }))
      .toMatchObject({ reasonCode: "no_eligible_runner", candidates: [{ eligible: false }] });
    expect(evaluateRouting({ ...base, access: { allowedExecutorIds: [], unresolvedConnectionRefs: false } }))
      .toMatchObject({ reasonCode: "no_eligible_runner", candidates: [{ eligible: false }] });
  });

  it("rejects unknown and capability-incompatible explicit executors", () => {
    const unknown = evaluateRouting({
      runId: "run_unknown",
      runnerIds: ["runner_1"],
      executorIds: ["codex"],
      runners: [runner({ runnerId: "runner_1", executors: [{ executorId: "codex", readiness: "unknown", capability }] })],
      access: { unresolvedConnectionRefs: false },
      decidedAt
    });
    expect(unknown).toMatchObject({
      reasonCode: "no_eligible_runner",
      candidates: [{ reasons: expect.arrayContaining([expect.objectContaining({ code: "executor_readiness_unknown" })]) }]
    });

    const incompatible = evaluateRouting({
      runId: "run_incompatible",
      runnerIds: ["runner_1"],
      executorIds: ["codex"],
      runners: [runner({
        runnerId: "runner_1",
        executors: [{ executorId: "codex", readiness: "ready", capability: { ...capability, writeAccess: "none", workspaceIsolation: "none", sourceControl: "none" } }]
      })],
      requirements: { minimumWriteAccess: "workspace", minimumWorkspaceIsolation: "branch", requiresSourceControl: true },
      access: { unresolvedConnectionRefs: false },
      decidedAt
    });
    expect(incompatible).toMatchObject({
      reasonCode: "no_eligible_runner",
      candidates: [{ reasons: expect.arrayContaining([
        expect.objectContaining({ code: "executor_write_capability_mismatch" }),
        expect.objectContaining({ code: "executor_isolation_capability_mismatch" }),
        expect.objectContaining({ code: "executor_source_control_capability_mismatch" })
      ]) }]
    });
  });
});
