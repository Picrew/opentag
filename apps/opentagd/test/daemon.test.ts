import type { ContextPacket, OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import { createEchoExecutor } from "@opentag/runner";
import { describe, expect, it, vi } from "vitest";
import { runOneDaemonIteration, serveDaemon } from "../src/daemon.js";

const run: OpenTagRun = {
  id: "run_1",
  eventId: "evt_1",
  status: "assigned",
  assignedRunnerId: "runner_1",
  contextPacket: {
    summary: "Fix the issue from the source thread.",
    sourcePointers: [],
    exclusions: ["Do not touch unrelated files."]
  },
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z"
};

const event: OpenTagEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

const slackEvent: OpenTagEvent = {
  ...event,
  id: "evt_slack_1",
  source: "slack",
  actor: { provider: "slack", providerUserId: "U456", handle: "U456", organizationId: "T123" },
  callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage", threadKey: "T123|C123|1710000000.000100" },
  metadata: { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }
};

const attemptLease = {
  attemptId: "attempt_1",
  attemptNumber: 1,
  fencingToken: "fence_1"
};

describe("opentagd", () => {
  it("never claims from the legacy run-once path for a Control V1 runner", async () => {
    const claim = vi.fn(async () => null);
    await expect(runOneDaemonIteration({
      mode: "control-v1-sidecar",
      controlLoop: {
        async beforeIteration() { return true; },
        async afterIteration() {},
        abort() {},
        async close() {},
      },
      client: {
        claim,
        async markRunning() {},
        async heartbeat() {},
        async progress() {},
        async complete() {},
        async requestActionPermission() { throw new Error("should not run"); },
        async resolveActionPermission() { throw new Error("should not run"); },
        async recordMaterialActionReceipt() { throw new Error("should not run"); },
      },
    } as never)).rejects.toThrow(/accepts only a legacy claim-capable daemon runtime/iu);
    expect(claim).not.toHaveBeenCalled();
  });

  it("claims a run and completes it with echo executor", async () => {
    const calls: string[] = [];

    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          calls.push("claim");
          return { run, event, ...attemptLease };
        },
        async markRunning(runId, executor) {
          calls.push(`running:${runId}:${executor}`);
        },
        async heartbeat(runId) {
          calls.push(`heartbeat:${runId}`);
        },
        async progress(runId, _lease, input) {
          calls.push(`progress:${runId}:${input.type}:${input.message}`);
        },
        async complete(runId, _lease, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(calls).toEqual([
      "claim",
      "running:run_1:echo",
      "progress:run_1:executor.started:Echo executor started for run_1",
      "progress:run_1:executor.completed:Echo executor completed for run_1",
      "complete:run_1:success:Echoed OpenTag command: fix this"
    ]);
  });

  it("returns false when no work is available", async () => {
    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          return null;
        },
        async markRunning() {
          throw new Error("should not run");
        },
        async heartbeat() {
          throw new Error("should not run");
        },
        async progress() {
          throw new Error("should not run");
        },
        async complete() {
          throw new Error("should not run");
        }
      }
    });

    expect(didWork).toBe(false);
  });

  it("exits the daemon loop when the abort signal is triggered while idle", async () => {
    const abortController = new AbortController();
    let claimCount = 0;

    const daemonPromise = serveDaemon({
      mode: "legacy",
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: { echo: createEchoExecutor() },
      pollIntervalMs: 10_000,
      signal: abortController.signal,
      client: {
        async claim() {
          claimCount += 1;
          abortController.abort();
          return null;
        },
        async markRunning() {
          throw new Error("should not run");
        },
        async heartbeat() {
          throw new Error("should not run");
        },
        async progress() {
          throw new Error("should not run");
        },
        async complete() {
          throw new Error("should not run");
        }
      }
    });

    await expect(daemonPromise).resolves.toBeUndefined();
    expect(claimCount).toBe(1);
  });

  it("refuses to execute when the repo has no local workspace mapping", async () => {
    const calls: string[] = [];
    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          return { run, event, ...attemptLease };
        },
        async markRunning() {
          throw new Error("should not run");
        },
        async heartbeat() {
          throw new Error("should not run");
        },
        async progress() {
          throw new Error("should not run");
        },
        async complete(runId, _lease, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(didWork).toBe(true);
    expect(calls).toEqual([
      "complete:run_1:needs_human:This run targets github:acme/demo, which is not in this runner's local Project Target allowlist."
    ]);
  });

  it("refuses to execute when the configured executor is unavailable locally", async () => {
    const calls: string[] = [];
    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo", defaultExecutor: "codex" }],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          return { run, event, ...attemptLease };
        },
        async markRunning() {
          throw new Error("should not run");
        },
        async heartbeat() {
          throw new Error("should not run");
        },
        async progress() {
          throw new Error("should not run");
        },
        async complete(runId, _lease, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(didWork).toBe(true);
    expect(calls).toEqual(["complete:run_1:needs_human:No local executor is configured for 'codex'."]);
  });

  it("resolves Slack events against the mapped repository provider", async () => {
    const calls: string[] = [];
    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          return { run, event: slackEvent, ...attemptLease };
        },
        async markRunning(runId, executor) {
          calls.push(`running:${runId}:${executor}`);
        },
        async heartbeat() {
          return;
        },
        async progress() {
          return;
        },
        async complete(runId, _lease, result) {
          calls.push(`complete:${runId}:${result.conclusion}`);
        }
      }
    });

    expect(calls).toEqual(["running:run_1:echo", "complete:run_1:success"]);
  });

  it("sends heartbeats while a long-running executor is active", async () => {
    const calls: string[] = [];
    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: {
        echo: {
          id: "echo",
          displayName: "Echo",
          async canRun() {
            return { ready: true };
          },
          async run(_input, sink) {
            await sink.emit({
              type: "executor.started",
              message: "long task",
              at: "2026-06-24T00:00:00.000Z"
            });
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { conclusion: "success", summary: "done" };
          },
          async cancel() {
            return;
          }
        }
      },
      heartbeatIntervalMs: 5,
      client: {
        async claim() {
          return { run, event, ...attemptLease };
        },
        async markRunning(runId, executor, _lease, options) {
          calls.push(`running:${runId}:${executor}:${options?.runTimeoutMs ?? "none"}`);
        },
        async heartbeat(runId) {
          calls.push(`heartbeat:${runId}`);
        },
        async progress(runId, _lease, input) {
          calls.push(`progress:${runId}:${input.type}:${input.message}`);
        },
        async complete(runId, _lease, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(calls.some((call) => call === "heartbeat:run_1")).toBe(true);
    expect(calls.at(-1)).toBe("complete:run_1:success:done");
  });

  it("cancels the executor when the control plane no longer claims the run for this runner", async () => {
    const calls: string[] = [];
    const cancel = vi.fn(async () => {
      calls.push("executor.cancel");
    });

    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: {
        echo: {
          id: "echo",
          displayName: "Echo",
          async canRun() {
            return { ready: true };
          },
          async run() {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { conclusion: "success", summary: "late success" };
          },
          cancel
        }
      },
      heartbeatIntervalMs: 5,
      client: {
        async claim() {
          return { run, event, ...attemptLease };
        },
        async markRunning(runId, executor, _lease, options) {
          calls.push(`running:${runId}:${executor}:${options?.runTimeoutMs ?? "none"}`);
        },
        async heartbeat() {
          calls.push("heartbeat.cancelled");
          throw new Error('heartbeat failed: 404 {"error":"run_not_claimed_by_runner"}');
        },
        async progress() {
          calls.push("progress");
        },
        async complete() {
          calls.push("complete");
          throw new Error("should not complete after cancellation");
        }
      }
    });

    expect(cancel).toHaveBeenCalledWith("run_1", "attempt_1");
    expect(calls).toContain("heartbeat.cancelled");
    expect(calls).not.toContain("complete");
  });

  it("completes the run as timed out and cancels the executor when the hard timeout fires", async () => {
    const calls: string[] = [];
    const cancel = vi.fn(async () => {
      calls.push("executor.cancel");
    });

    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: {
        echo: {
          id: "echo",
          displayName: "Echo",
          async canRun() {
            return { ready: true };
          },
          async run() {
            await new Promise(() => {
              // Leave the executor pending; the daemon timeout must end the run.
            });
            return { conclusion: "success", summary: "late success" };
          },
          cancel
        }
      },
      heartbeatIntervalMs: 0,
      runTimeoutMs: 5,
      client: {
        async claim() {
          return { run, event, ...attemptLease };
        },
        async markRunning(runId, executor, _lease, options) {
          calls.push(`running:${runId}:${executor}:${options?.runTimeoutMs ?? "none"}`);
        },
        async heartbeat() {
          throw new Error("should not run");
        },
        async progress() {
          calls.push("progress");
        },
        async complete(runId, _lease, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(cancel).toHaveBeenCalledWith("run_1", "attempt_1");
    expect(calls).toEqual([
      "running:run_1:echo:5",
      "executor.cancel",
      "complete:run_1:timed_out:Echo exceeded the configured hard timeout of 5ms."
    ]);
  });

  it("completes the run as failed when the executor throws after markRunning", async () => {
    const calls: string[] = [];

    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: {
        echo: {
          id: "echo",
          displayName: "Echo",
          async canRun() {
            return { ready: true };
          },
          async run() {
            throw new Error("executor exploded");
          },
          async cancel() {
            return;
          }
        }
      },
      heartbeatIntervalMs: 0,
      client: {
        async claim() {
          calls.push("claim");
          return { run, event, ...attemptLease };
        },
        async markRunning(runId, executor) {
          calls.push(`running:${runId}:${executor}`);
        },
        async heartbeat() {
          throw new Error("should not run");
        },
        async progress() {
          return;
        },
        async complete(runId, _lease, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(didWork).toBe(true);
    expect(calls).toEqual(["claim", "running:run_1:echo", "complete:run_1:failure:Echo failed: executor exploded"]);
  });

  it("does not recommit codex changes from the claimed run row when preparing a PR branch", async () => {
    const checkoutPath = "/tmp/demo";
    const commands: string[] = [];
    let completed: OpenTagRunResult | undefined;

    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath, defaultExecutor: "codex" }],
      executors: {
        codex: {
          ...createEchoExecutor(),
          id: "codex",
          displayName: "Codex",
          capability: {
            ...createEchoExecutor().capability!,
            id: "codex",
            sourceControl: "self_committing"
          },
          async run() {
            return { conclusion: "success", summary: "Changed README.md.", changedFiles: ["README.md"] };
          }
        }
      },
      pullRequestOptions: {
        preparePullRequestBranch: true,
        commandRunner: {
          async run(command, args, options) {
            commands.push(`${options?.cwd ?? ""}: ${command} ${args.join(" ")}`);
            if (command === "git" && args[0] === "commit" && options?.cwd === checkoutPath) {
              return { exitCode: 1, stdout: "", stderr: "nothing to commit" };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      },
      client: {
        async claim() {
          return {
            run,
            ...attemptLease,
            event: {
              ...event,
              permissions: [
                ...event.permissions,
                { scope: "repo:write", reason: "write branch" },
                { scope: "pr:create", reason: "create the pull request action" }
              ]
            }
          };
        },
        async markRunning() {
          return;
        },
        async heartbeat() {
          return;
        },
        async progress() {
          return;
        },
        async complete(_runId, _lease, result) {
          completed = result;
        }
      }
    });

    expect(didWork).toBe(true);
    expect(commands).toEqual(["/tmp/demo: git push -u origin opentag/run_1"]);
    expect(completed).toMatchObject({ conclusion: "success", changedFiles: ["README.md"] });
  });

  it("completes with needs_human when preparing the PR action branch fails", async () => {
    const commands: string[] = [];
    let completed: OpenTagRunResult | undefined;
    const executorResult: OpenTagRunResult = {
      conclusion: "success",
      summary: "Changed README.md.",
      changedFiles: ["README.md"],
      suggestedChanges: [
        {
          proposalId: "proposal_run_1",
          createdAt: "2026-06-24T00:00:00.000Z",
          sourceRunId: "run_1",
          summary: "Create a pull request.",
          intents: [
            {
              intentId: "proposal_run_1_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create a pull request for the run branch.",
              params: { head: "opentag/run_1", base: "main" }
            }
          ]
        }
      ]
    };

    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo", defaultExecutor: "capture" }],
      executors: {
        capture: {
          id: "capture",
          displayName: "Capture Executor",
          async canRun() {
            return { ready: true };
          },
          async run() {
            return executorResult;
          },
          async cancel() {
            return;
          }
        }
      },
      pullRequestOptions: {
        preparePullRequestBranch: true,
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            if (args[0] === "push") {
              return { exitCode: 128, stdout: "", stderr: "network unavailable" };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      },
      client: {
        async claim() {
          return {
            run,
            ...attemptLease,
            event: {
              ...event,
              permissions: [
                ...event.permissions,
                { scope: "repo:write", reason: "commit code changes on a run branch" },
                { scope: "pr:create", reason: "create the pull request action" }
              ]
            }
          };
        },
        async markRunning() {
          return;
        },
        async heartbeat() {
          return;
        },
        async progress() {
          return;
        },
        async complete(_runId, _lease, result) {
          completed = result;
        }
      }
    });

    expect(didWork).toBe(true);
    expect(commands).toEqual(["git add -- README.md", "git commit -m OpenTag run run_1", "git push -u origin opentag/run_1"]);
    expect(completed).toMatchObject({
      conclusion: "needs_human",
      changedFiles: ["README.md"],
      nextAction: "Fix branch push or pull request credentials, then retry the run before applying the PR action."
    });
    expect(completed?.summary).toContain("could not prepare the pull request action");
    expect(completed?.summary).toContain("network unavailable");
    expect(completed?.suggestedChanges).toBeUndefined();
  });

  it("logs and continues the daemon loop after an iteration-level failure", async () => {
    const abortController = new AbortController();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let claimCount = 0;

    try {
      await serveDaemon({
        mode: "legacy",
        runnerId: "runner_1",
        repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
        executors: { echo: createEchoExecutor() },
        pollIntervalMs: 1,
        signal: abortController.signal,
        client: {
          async claim() {
            claimCount += 1;
            if (claimCount === 1) {
              throw new Error("dispatcher temporarily unavailable");
            }
            abortController.abort();
            return null;
          },
          async markRunning() {
            throw new Error("should not run");
          },
          async heartbeat() {
            throw new Error("should not run");
          },
          async progress() {
            throw new Error("should not run");
          },
          async complete() {
            throw new Error("should not run");
          }
        }
      });
      expect(claimCount).toBe(2);
      expect(warn).toHaveBeenCalledWith("OpenTag daemon iteration failed; retrying:", expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it("passes the run context packet into executor input", async () => {
    let seenPacket: ContextPacket | undefined;
    const localRun: OpenTagRun = {
      ...run,
      contextPacket: {
        summary: "Fix the issue from the source thread.",
        sourcePointers: [],
        exclusions: ["Do not touch unrelated files."]
      }
    };

    await runOneDaemonIteration({
      runnerId: "runner_1",
      executors: {
        capture: {
          id: "capture",
          displayName: "Capture Executor",
          async canRun(input) {
            seenPacket = input.contextPacket;
            return { ready: true };
          },
          async run(input) {
            seenPacket = input.contextPacket;
            return { conclusion: "success", summary: "captured" };
          },
          async cancel() {
            return;
          }
        }
      },
      client: {
        async claim() {
          return {
            run: localRun,
            ...attemptLease,
            event: {
              ...event,
              permissions: [
                ...event.permissions,
                { scope: "repo:write", reason: "write branch" }
              ]
            }
          };
        },
        async markRunning() {
          return;
        },
        async heartbeat() {
          return;
        },
        async progress() {
          return;
        },
        async complete() {
          return;
        }
      },
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo", defaultExecutor: "capture" }]
    });

    expect(seenPacket?.summary).toBe("Fix the issue from the source thread.");
    expect(seenPacket?.exclusions).toEqual(["Do not touch unrelated files."]);
  });
});
