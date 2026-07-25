import { describe, expect, it } from "vitest";
import {
  AcceptedCompletionMetricsSchema,
  AcceptedCompletionSegmentSchema,
  ExecutorCapabilityContractSchema,
  FrozenRoutingPolicySchema,
  RoutingDecisionSchema,
  RunnerDirectoryEntrySchema,
  RunnerRegistrationInputSchema,
  RunnerRegistrationRequestSchema
} from "../src/routing.js";

describe("explainable routing contracts", () => {
  it("distinguishes unrestricted routing from an explicit deny-all allowlist", () => {
    expect(FrozenRoutingPolicySchema.parse({ runnerIds: null, executorIds: null })).toEqual({
      runnerIds: null,
      executorIds: null
    });
    expect(FrozenRoutingPolicySchema.parse({ runnerIds: [], executorIds: [] })).toEqual({
      runnerIds: [],
      executorIds: []
    });
  });

  it("keeps legacy runner registration additive while applying safe defaults", () => {
    const request = RunnerRegistrationRequestSchema.parse({ runnerId: "runner_local", name: "Local runner" });
    expect(request).toEqual({ runnerId: "runner_local", name: "Local runner" });
    expect(RunnerRegistrationInputSchema.parse(request)).toEqual({
      runnerId: "runner_local",
      name: "Local runner",
      locality: "local",
      declaredState: "ready",
      executors: [],
      maxConcurrentRuns: 1_000,
      preference: 0
    });
    expect(() => RunnerRegistrationRequestSchema.parse({
      runnerId: "runner_local",
      name: "Local runner",
      maxConcurrentRuns: 1_001
    })).toThrow();
  });

  it("rejects duplicate executor capability records", () => {
    expect(() => RunnerRegistrationInputSchema.parse({
      runnerId: "runner_local",
      name: "Local runner",
      executors: [
        { executorId: "codex", readiness: "ready" },
        { executorId: "codex", readiness: "unknown" }
      ]
    })).toThrow(/executor ids must be unique/iu);
  });

  it("requires a selected placement target to be an eligible candidate", () => {
    const candidate = {
      runnerId: "runner_local",
      executorId: "codex",
      eligible: false,
      reasons: [{ code: "runner_at_capacity", message: "Runner has no free concurrency slot." }],
      locality: "local" as const,
      readiness: "at_capacity" as const,
      capacity: { active: 1, limit: 1 }
    };
    expect(() => RoutingDecisionSchema.parse({
      id: "routing_1",
      runId: "run_1",
      candidates: [candidate],
      selected: { runnerId: "runner_local", executorId: "codex" },
      reasonCode: "preferred_eligible_candidate",
      reason: "Selected the first eligible configured target.",
      decidedAt: "2026-07-25T00:00:00.000Z"
    })).toThrow(/only an eligible candidate/iu);
  });

  it("represents current readiness and capacity separately from declared configuration", () => {
    const capability = ExecutorCapabilityContractSchema.parse({
      id: "codex",
      invocation: "spawn",
      supportsProfile: false,
      supportsStreaming: true,
      supportsCancel: true,
      supportsHookCompletion: false,
      progressEvents: "audit",
      approvalMode: "opentag_policy",
      contextAccess: ["context_packet", "workspace"],
      promptAssembly: "opentag",
      writeAccess: "workspace",
      conversationAccess: "request",
      promptMutation: "none",
      rawContextAccess: false,
      writeActionAccess: "propose",
      workspaceIsolation: "worktree",
      sourceControl: "self_committing",
      requiredSecrets: [],
      completionSignals: [{ type: "stream_event", required: true, description: "Executor stop response." }]
    });
    const entry = RunnerDirectoryEntrySchema.parse({
      runnerId: "runner_local",
      name: "Local runner",
      locality: "local",
      declaredState: "ready",
      executors: [{ executorId: "codex", readiness: "ready", capability }],
      maxConcurrentRuns: 2,
      preference: 10,
      readiness: { state: "ready", reasonCode: "heartbeat_current", reason: "Runner heartbeat is current." },
      capacity: { active: 1, limit: 2 },
      createdAt: "2026-07-25T00:00:00.000Z",
      heartbeatAt: "2026-07-25T00:00:01.000Z"
    });
    expect(entry.executors[0]?.capability).toMatchObject({ supportsCancel: true });
    expect(entry.capacity).toEqual({ active: 1, limit: 2 });
  });

  it("rejects internally inconsistent accepted-completion metrics", () => {
    expect(AcceptedCompletionSegmentSchema.parse({
      id: "runner_local",
      completedRuns: 0,
      acceptedCompletions: 0,
      acceptanceRate: 0
    })).toMatchObject({ acceptanceRate: 0 });
    expect(() => AcceptedCompletionSegmentSchema.parse({
      id: "runner_local",
      completedRuns: 2,
      acceptedCompletions: 3,
      acceptanceRate: 1
    })).toThrow(/cannot exceed completedRuns/iu);
    expect(() => AcceptedCompletionSegmentSchema.parse({
      id: "runner_local",
      completedRuns: 2,
      acceptedCompletions: 1,
      acceptanceRate: 0.75
    })).toThrow(/must equal acceptedCompletions divided by completedRuns/iu);
    expect(() => AcceptedCompletionSegmentSchema.parse({
      id: "runner_local",
      completedRuns: 0,
      acceptedCompletions: 0,
      acceptanceRate: 1
    })).toThrow(/must equal acceptedCompletions divided by completedRuns/iu);
    expect(() => AcceptedCompletionMetricsSchema.parse({
      completedRuns: 1,
      acceptedCompletions: 2,
      byRunner: [],
      byExecutor: []
    })).toThrow(/cannot exceed completedRuns/iu);
    expect(() => AcceptedCompletionMetricsSchema.parse({
      completedRuns: 1,
      acceptedCompletions: 1,
      byRunner: [{ id: "runner_local", completedRuns: 2, acceptedCompletions: 0, acceptanceRate: 0 }],
      byExecutor: [{ id: "codex", completedRuns: 1, acceptedCompletions: 1, acceptanceRate: 1 }]
    })).toThrow(/byRunner totals must equal the aggregate metrics/iu);
    expect(() => AcceptedCompletionMetricsSchema.parse({
      completedRuns: 2,
      acceptedCompletions: 1,
      byRunner: [
        { id: "runner_local", completedRuns: 1, acceptedCompletions: 1, acceptanceRate: 1 },
        { id: "runner_local", completedRuns: 1, acceptedCompletions: 0, acceptanceRate: 0 }
      ],
      byExecutor: [{ id: "codex", completedRuns: 2, acceptedCompletions: 1, acceptanceRate: 0.5 }]
    })).toThrow(/byRunner ids must be unique/iu);
  });
});
