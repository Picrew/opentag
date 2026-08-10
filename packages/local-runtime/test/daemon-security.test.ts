import { describe, expect, it, vi } from "vitest";
import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import type { ExecutorAdapter } from "@opentag/runner";
import {
  resolveRepositoryBinding,
  runOneDaemonIteration,
  type DaemonClient,
} from "../src/daemon.js";

function event(metadata: Record<string, unknown>, source = "github"): OpenTagEvent {
  return {
    id: "evt_security",
    source,
    sourceEventId: "source_security",
    receivedAt: "2026-06-30T00:00:00.000Z",
    actor: { provider: source, providerUserId: "user_1", handle: "octocat" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [],
    permissions: [{ scope: "repo:write", reason: "security test" }],
    callback: { provider: source, uri: "https://example.com/callback" },
    metadata
  };
}

function runForEvent(input: { event: OpenTagEvent; executor?: ExecutorAdapter }) {
  const run: OpenTagRun = {
    id: "run_security",
    eventId: input.event.id,
    status: "assigned",
    assignedRunnerId: "runner_local",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z"
  };
  let completed: OpenTagRunResult | undefined;
  const client: DaemonClient = {
    claim: async () => ({ run, event: input.event, attemptId: "attempt_1", attemptNumber: 1, fencingToken: "fence_1" }),
    markRunning: async () => {},
    heartbeat: async () => {},
    progress: async () => {},
    complete: async (_runId, _lease, result) => {
      completed = result;
    }
  };

  return runOneDaemonIteration({
    runnerId: "runner_local",
    repositories: [
      {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        defaultExecutor: "echo",
        baseBranch: "main",
        pushRemote: "origin",
        keepWorktree: "on_failure"
      }
    ],
    executors: input.executor ? { echo: input.executor } : {},
    client
  }).then(() => completed);
}

describe("daemon Project Target allowlist", () => {
  it("matches mixed-case GitHub targets against the canonical local binding", () => {
    const binding = {
      provider: "github",
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo",
      defaultExecutor: "echo",
      baseBranch: "main",
      pushRemote: "origin",
      keepWorktree: "on_failure" as const,
    };

    expect(resolveRepositoryBinding(
      event({ repoProvider: "GitHub", owner: "AcMe", repo: "DeMo" }),
      [binding],
    )).toBe(binding);
  });

  it("refuses runs that target a repository outside the local allowlist", async () => {
    const executor: ExecutorAdapter = {
      id: "echo",
      displayName: "Echo",
      canRun: vi.fn(async () => ({ ready: true })),
      run: vi.fn(async () => ({ conclusion: "success", summary: "should not run" })),
      cancel: vi.fn()
    };

    const completed = await runForEvent({
      event: event({ repoProvider: "github", owner: "evil", repo: "demo" }),
      executor
    });

    expect(completed).toMatchObject({
      conclusion: "needs_human",
      summary: "This run targets github:evil/demo, which is not in this runner's local Project Target allowlist."
    });
    expect(executor.canRun).not.toHaveBeenCalled();
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("refuses GitHub source events that try to target a non-GitHub Project Target", async () => {
    const completed = await runForEvent({
      event: event({ repoProvider: "local", owner: "acme", repo: "demo" })
    });

    expect(completed).toMatchObject({
      conclusion: "needs_human",
      summary: "GitHub source events must target a GitHub Project Target, received local:acme/demo."
    });
  });

  it("refuses runs without Project Target metadata before executor selection", async () => {
    const completed = await runForEvent({
      event: event({})
    });

    expect(completed).toMatchObject({
      conclusion: "needs_human",
      summary: "Repository-bearing events require complete Project Target metadata."
    });
  });
});
