import { createOpenTagRepository, migrateSchema } from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createDispatcherApp,
  createDispatcherCompletionGovernance,
  currentWorkThreadRun,
  type CallbackMessage,
  type GitHubCompletionPolicy
} from "../src/index.js";

const strictPolicy: GitHubCompletionPolicy = {
  provider: "github",
  owner: "acme",
  repo: "demo",
  requiredChecks: ["build", "test"]
};

const HEAD_OLD = "a".repeat(40);
const HEAD_CURRENT = "b".repeat(40);
const BASE_SHA = "c".repeat(40);

function githubSnapshot(input: {
  deliveryId: string;
  eventName?: "pull_request" | "check_run" | "check_suite" | "status";
  pullRequestNumber?: number;
  headSha?: string;
  state?: "open" | "closed" | "merged";
  checks?: Record<string, "passed" | "failed" | "pending">;
  observedAt?: string;
  resourceRef?: string;
}) {
  return {
    provider: "github",
    deliveryId: input.deliveryId,
    eventName: input.eventName ?? "pull_request",
    repository: { owner: "acme", repo: "demo" },
    pullRequest: {
      number: input.pullRequestNumber ?? 7,
      resourceRef: input.resourceRef ?? `github:acme/demo:pull_request:${input.pullRequestNumber ?? 7}`,
      headSha: input.headSha ?? HEAD_CURRENT,
      baseSha: BASE_SHA,
      baseBranch: "main",
      state: input.state ?? "merged"
    },
    checks: input.checks ?? { build: "passed", test: "passed" },
    observedAt: input.observedAt ?? "2026-07-21T10:05:00.000Z",
    payloadDigest: `sha256:${(input.deliveryId === "delivery-old" ? "d" : "e").repeat(64)}`
  };
}

function githubIssueEvent(input: { id: string; sourceEventId: string; issueNumber?: number }) {
  const issueNumber = input.issueNumber ?? 1;
  return {
    id: input.id,
    source: "github",
    sourceEventId: input.sourceEventId,
    receivedAt: "2026-07-21T00:00:00.000Z",
    actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [{
      provider: "github",
      kind: "issue",
      uri: `https://github.com/acme/demo/issues/${issueNumber}`,
      visibility: "public"
    }],
    workItem: {
      provider: "github",
      kind: "issue",
      externalId: `acme/demo#${issueNumber}`,
      uri: `https://github.com/acme/demo/issues/${issueNumber}`,
      ownerContainer: {
        provider: "github",
        id: "acme/demo",
        uri: "https://github.com/acme/demo"
      }
    },
    permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
    callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
    metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber }
  };
}

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function startRun(input: {
  runId: string;
  completionPolicies?: GitHubCompletionPolicy[];
  defaultGitHubCompletion?: "governed" | "compat";
  databasePath?: string;
  completionNow?: () => string;
  issueNumber?: number;
  reassessmentObligations?: {
    autoStart?: boolean;
    inline?: boolean;
    pollIntervalMs?: number;
  };
}) {
  const delivered: CallbackMessage[] = [];
  const app = createDispatcherApp({
    databasePath: input.databasePath ?? ":memory:",
    ...(input.completionPolicies ? { completionPolicies: input.completionPolicies } : {}),
    ...(input.defaultGitHubCompletion ? { defaultGitHubCompletion: input.defaultGitHubCompletion } : {}),
    ...(input.completionNow ? { completionNow: input.completionNow } : {}),
    reassessmentObligations: input.reassessmentObligations ?? { autoStart: false },
    callbackSink: {
      async deliver(message) {
        delivered.push(message);
      }
    }
  });
  expect((await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }))).status).toBe(201);
  expect((await app.request("/v1/repo-bindings", jsonRequest({
    provider: "github",
    owner: "acme",
    repo: "demo",
    runnerId: "runner_1",
    workspacePath: "/Users/test/demo",
    defaultExecutor: "echo"
  }))).status).toBe(201);
  expect((await app.request("/v1/runs", jsonRequest({
    runId: input.runId,
    event: githubIssueEvent({ id: `event_${input.runId}`, sourceEventId: `comment_${input.runId}`, ...(input.issueNumber ? { issueNumber: input.issueNumber } : {}) })
  }))).status).toBe(201);
  const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
  expect(claimResponse.status).toBe(200);
  const claim = await claimResponse.json() as { attemptId: string; fencingToken: string };
  return { app, claim, delivered };
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "opentag-completion-recovery-"));
  onTestFinished(() => {
    // Vitest owns the temporary test process; SQLite files are intentionally left
    // for the OS temporary-directory sweeper if an open app connection remains.
  });
  return join(directory, "dispatcher.sqlite");
}

async function completeRun(input: {
  setup: Awaited<ReturnType<typeof startRun>>;
  runId: string;
  conclusion: "success" | "failure" | "cancelled" | "timed_out";
  idempotencyKey?: string;
  pullRequestNumber?: number;
  omitPullRequest?: boolean;
}) {
  return input.setup.app.request(`/v1/runners/runner_1/runs/${input.runId}/complete`, jsonRequest({
    ...input.setup.claim,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    result: {
      conclusion: input.conclusion,
      summary: `${input.conclusion} result`,
      ...(input.conclusion === "success" && !input.omitPullRequest
        ? { createdPullRequestUrl: `https://github.com/acme/demo/pull/${input.pullRequestNumber ?? 7}` }
        : {})
    }
  }));
}

describe("dispatcher completion governance", () => {
  it("uses SQLite binary run-id authority when creation timestamps tie", () => {
    const createdAt = "2026-07-21T10:00:00.000Z";

    expect(currentWorkThreadRun([
      { run: { id: "run_current_work_thread_B", createdAt } },
      { run: { id: "run_current_work_thread_a", createdAt } }
    ])?.run.id).toBe("run_current_work_thread_a");
  });

  it("loads one current-run correlation snapshot for a multi-subject evidence delivery", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const governance = createDispatcherCompletionGovernance({
      repo,
      policies: [strictPolicy],
      now: () => "2099-07-21T10:10:00.000Z"
    });
    const expectedWorkThreadIds: string[] = [];
    for (const [runId, issueNumber, pullRequestNumber] of [
      ["run_correlation_snapshot_7", 7, 7],
      ["run_correlation_snapshot_8", 8, 8]
    ] as const) {
      await repo.createRun({
        id: runId,
        event: githubIssueEvent({ id: `event_${runId}`, sourceEventId: `comment_${runId}`, issueNumber })
      });
      await repo.completeRun({
        runId,
        result: {
          conclusion: "success",
          summary: `created pull request ${pullRequestNumber}`,
          createdPullRequestUrl: `https://github.com/acme/demo/pull/${pullRequestNumber}`
        }
      });
      await governance.ingestRunResult(runId);
      const stored = await repo.getRun({ runId });
      expectedWorkThreadIds.push(stored!.run.thread!.id);
    }
    const currentRunReads = vi.spyOn(repo, "listCurrentWorkThreadRunsWithResults");

    const result = await governance.ingestGitHubSnapshotSet([
      githubSnapshot({ deliveryId: "delivery-correlation-snapshot", pullRequestNumber: 7 }),
      githubSnapshot({ deliveryId: "delivery-correlation-snapshot", pullRequestNumber: 8 })
    ]);

    expect(result.workThreadIds).toEqual(expectedWorkThreadIds.sort());
    expect(currentRunReads).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsafe strict policy without required checks", () => {
    expect(() => createDispatcherApp({
      databasePath: ":memory:",
      completionPolicies: [{ ...strictPolicy, requiredChecks: [] }]
    })).toThrow("must configure at least one required check");
  });

  it("keeps strict work pending after executor success until repository evidence arrives", async () => {
    const setup = await startRun({ runId: "run_strict", completionPolicies: [strictPolicy] });
    const response = await completeRun({ setup, runId: "run_strict", conclusion: "success" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      completion: {
        execution: "succeeded",
        completion: "pending",
        evidenceBacked: true,
        contract: { mode: "governed", cycle: 1, version: 1 },
        missingGateIds: ["required_checks", "merge"],
        currentAssessment: {
          gateResults: [
            { gateId: "pull_request", state: "passed" },
            { gateId: "required_checks", state: "missing" },
            { gateId: "merge", state: "missing" }
          ]
        }
      }
    });
    expect(setup.delivered.at(-1)).toMatchObject({ kind: "final" });
    expect(setup.delivered.at(-1)?.body).toContain("Execution succeeded");
    expect(setup.delivered.at(-1)?.body).toContain("verified repository evidence");
  });

  it("exposes WorkThread completion and a bounded work-loop attention view", async () => {
    const setup = await startRun({ runId: "run_work_loop_status", completionPolicies: [strictPolicy] });
    expect((await completeRun({ setup, runId: "run_work_loop_status", conclusion: "success" })).status).toBe(200);
    const stored = await (await setup.app.request("/v1/runs/run_work_loop_status")).json() as {
      run: { thread?: { id?: string } };
    };
    const workThreadId = stored.run.thread?.id;
    expect(workThreadId).toBeTruthy();

    expect((await setup.app.request("/v1/runs", jsonRequest({
      runId: "run_work_loop_terminal",
      event: githubIssueEvent({ id: "event_work_loop_terminal", sourceEventId: "comment_work_loop_terminal", issueNumber: 3 })
    }))).status).toBe(201);
    const terminalClaim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    expect((await setup.app.request(
      "/v1/runners/runner_1/runs/run_work_loop_terminal/complete",
      jsonRequest({
        ...terminalClaim,
        result: {
          conclusion: "success",
          summary: "terminal result",
          createdPullRequestUrl: "https://github.com/acme/demo/pull/9"
        }
      })
    )).status).toBe(200);
    expect((await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-work-loop-terminal", pullRequestNumber: 9 }))
    )).status).toBe(201);

    expect((await setup.app.request("/v1/runs", jsonRequest({
      runId: "run_work_loop_active",
      event: githubIssueEvent({ id: "event_work_loop_active", sourceEventId: "comment_work_loop_active", issueNumber: 2 })
    }))).status).toBe(201);
    expect((await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).status).toBe(200);

    const byThread = await setup.app.request(`/v1/work-threads/${encodeURIComponent(workThreadId!)}/completion`);
    expect(byThread.status).toBe(200);
    await expect(byThread.json()).resolves.toMatchObject({
      workThread: { id: workThreadId },
      completion: {
        workThreadId,
        completion: "pending",
        nextAction: { hint: { kind: "refresh_completion_evidence", targetId: "required_checks" } }
      },
      acceptedProgress: {
        workThreadId,
        acceptedGateAdvanceCount: 1,
        attributedGateAdvanceCount: 1,
        unresolvedGateAdvanceCount: 0,
        runIdsWithAcceptedProgress: ["run_work_loop_status"],
        advances: [{
          gateId: "pull_request",
          resolution: {
            status: "attributed",
            sourceRunId: "run_work_loop_status"
          }
        }]
      }
    });

    const attention = await setup.app.request("/v1/work-loops?attention=required&limit=10");
    expect(attention.status).toBe(200);
    await expect(attention.json()).resolves.toMatchObject({
      attention: "required",
      workLoops: [{
        workThread: { id: workThreadId },
        completion: { completion: "pending", nextAction: { hint: { kind: "refresh_completion_evidence" } } }
      }],
      scanned: 3,
      scanLimitReached: false
    });
    expect((await setup.app.request("/v1/work-loops?attention=required&limit=0")).status).toBe(400);
    expect((await setup.app.request("/v1/work-loops")).status).toBe(400);
  });

  it("keeps the completion endpoint available across a completion-cycle authority boundary", async () => {
    const databasePath = temporaryDatabasePath();
    const setup = await startRun({
      runId: "run_completion_cycle_boundary",
      completionPolicies: [strictPolicy],
      databasePath
    });
    expect((await completeRun({
      setup,
      runId: "run_completion_cycle_boundary",
      conclusion: "success"
    })).status).toBe(200);
    const stored = await (await setup.app.request("/v1/runs/run_completion_cycle_boundary")).json() as {
      run: { thread?: { id?: string } };
    };
    const workThreadId = stored.run.thread?.id;
    expect(workThreadId).toBeTruthy();

    const sqlite = new Database(databasePath);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const currentContract = await repo.getLatestCompletionContractForWorkThread({ workThreadId: workThreadId! });
    if (!currentContract) throw new Error("expected current completion contract");
    const currentAssessment = await repo.getCurrentCompletionAssessment({ workThreadId: workThreadId! });
    if (!currentAssessment) throw new Error("expected current completion assessment");
    await repo.recordCompletionContract({
      contract: {
        ...currentContract,
        version: currentContract.version + 1,
        cycle: currentContract.cycle + 1
      }
    });
    await expect(repo.appendCompletionAssessment({
      expectedCurrentAssessmentId: currentAssessment.id,
      assessment: {
        ...currentAssessment,
        id: "assessment_completion_cycle_boundary",
        contractVersion: currentContract.version + 1,
        cycle: currentContract.cycle + 1,
        sequence: 1,
        supersedesAssessmentId: currentAssessment.id,
        inputDigest: `sha256:${"9".repeat(64)}`,
        assessedAt: "2026-07-21T10:06:00.000Z"
      }
    })).resolves.toMatchObject({ outcome: "recorded" });
    sqlite.close();

    const firstRead = await setup.app.request(`/v1/work-threads/${encodeURIComponent(workThreadId!)}/completion`);
    expect(firstRead.status).toBe(200);
    const currentRead = await setup.app.request(`/v1/work-threads/${encodeURIComponent(workThreadId!)}/completion`);
    expect(currentRead.status).toBe(200);
    await expect(currentRead.json()).resolves.toMatchObject({
      workThread: { id: workThreadId },
      acceptedProgress: {
        contract: {
          id: currentContract.id,
          version: currentContract.version + 1,
          cycle: currentContract.cycle + 1
        },
        currentAssessmentId: expect.any(String)
      }
    });
  });

  it("keeps the work-loop attention listing read-only when no assessment has been persisted", async () => {
    const databasePath = temporaryDatabasePath();
    const setup = await startRun({
      runId: "run_work_loop_read_only",
      databasePath,
      completionPolicies: [strictPolicy]
    });
    expect((await completeRun({ setup, runId: "run_work_loop_read_only", conclusion: "success" })).status).toBe(200);
    const sqlite = new Database(databasePath);
    onTestFinished(() => sqlite.close());
    sqlite.prepare("UPDATE work_threads SET current_assessment_id = NULL").run();
    sqlite.prepare("DELETE FROM completion_assessments").run();
    sqlite.prepare("DELETE FROM governance_events").run();
    sqlite.prepare("DELETE FROM human_escalations").run();

    const before = {
      assessments: (sqlite.prepare("SELECT count(*) AS count FROM completion_assessments").get() as { count: number }).count,
      governanceEvents: (sqlite.prepare("SELECT count(*) AS count FROM governance_events").get() as { count: number }).count,
      escalations: (sqlite.prepare("SELECT count(*) AS count FROM human_escalations").get() as { count: number }).count
    };
    const response = await setup.app.request("/v1/work-loops?attention=required&limit=10");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ workLoops: [] });
    const after = {
      assessments: (sqlite.prepare("SELECT count(*) AS count FROM completion_assessments").get() as { count: number }).count,
      governanceEvents: (sqlite.prepare("SELECT count(*) AS count FROM governance_events").get() as { count: number }).count,
      escalations: (sqlite.prepare("SELECT count(*) AS count FROM human_escalations").get() as { count: number }).count
    };
    expect(after).toEqual(before);
  });

  it("preserves executor-success semantics for a run that ships no pull request", async () => {
    const setup = await startRun({ runId: "run_compat" });
    const response = await completeRun({ setup, runId: "run_compat", conclusion: "success", omitPullRequest: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      completion: {
        execution: "succeeded",
        completion: "satisfied",
        evidenceBacked: false,
        contract: { mode: "execution_compat" }
      }
    });
    expect(setup.delivered.at(-1)?.body).toContain("success result");
  });

  it("preserves executor-success semantics for a pull request run when the default is opted out", async () => {
    const setup = await startRun({ runId: "run_compat_opt_out", defaultGitHubCompletion: "compat" });
    const response = await completeRun({ setup, runId: "run_compat_opt_out", conclusion: "success" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      completion: {
        execution: "succeeded",
        completion: "satisfied",
        evidenceBacked: false,
        contract: { mode: "execution_compat" }
      }
    });
  });

  it("gates a zero-config pull request run on verified PR existence and observed checks", async () => {
    const setup = await startRun({ runId: "run_default_verified" });
    const response = await completeRun({ setup, runId: "run_default_verified", conclusion: "success" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      completion: {
        execution: "succeeded",
        completion: "pending",
        evidenceBacked: true,
        contract: { mode: "governed", cycle: 1, version: 1 },
        missingGateIds: ["verified_pull_request", "observed_checks"],
        currentAssessment: {
          gateResults: [
            { gateId: "pull_request", state: "passed" },
            { gateId: "verified_pull_request", state: "missing" },
            { gateId: "observed_checks", state: "missing" }
          ]
        }
      }
    });
    expect(setup.delivered.at(-1)?.body).toContain("Execution succeeded");
    expect(setup.delivered.at(-1)?.body).toContain("verified repository evidence");

    const evidence = await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-default-verified", state: "open" }))
    );
    expect(evidence.status).toBe(201);
    await expect(evidence.json()).resolves.toMatchObject({
      outcome: "recorded",
      completion: {
        execution: "succeeded",
        completion: "satisfied",
        evidenceBacked: true,
        missingGateIds: [],
        failedGateIds: []
      }
    });
  });

  it("keeps the zero-config observed-checks gate unsatisfied while any check is failing", async () => {
    const setup = await startRun({ runId: "run_default_failing_check" });
    await completeRun({ setup, runId: "run_default_failing_check", conclusion: "success" });

    const failing = await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({
        deliveryId: "delivery-default-failing",
        state: "open",
        checks: { build: "passed", test: "failed" },
        observedAt: "2026-07-21T10:05:00.000Z"
      }))
    );
    expect(failing.status).toBe(201);
    await expect(failing.json()).resolves.toMatchObject({
      completion: {
        completion: "unsatisfied",
        failedGateIds: ["observed_checks"]
      }
    });

    const green = await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({
        deliveryId: "delivery-default-green",
        state: "open",
        checks: { build: "passed", test: "passed" },
        observedAt: "2026-07-21T10:06:00.000Z"
      }))
    );
    expect(green.status).toBe(201);
    await expect(green.json()).resolves.toMatchObject({
      completion: { completion: "satisfied", failedGateIds: [] }
    });
  });

  it("upgrades a compatibility thread to the default verified contract once a run ships a pull request", async () => {
    const setup = await startRun({ runId: "run_upgrade_1" });
    const first = await completeRun({ setup, runId: "run_upgrade_1", conclusion: "success", omitPullRequest: true });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      completion: { completion: "satisfied", contract: { mode: "execution_compat", version: 1 } }
    });

    expect((await setup.app.request("/v1/runs", jsonRequest({
      runId: "run_upgrade_2",
      event: githubIssueEvent({ id: "event_run_upgrade_2", sourceEventId: "comment_run_upgrade_2" })
    }))).status).toBe(201);
    setup.claim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const second = await completeRun({ setup, runId: "run_upgrade_2", conclusion: "success" });

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      completion: {
        completion: "pending",
        evidenceBacked: true,
        contract: { mode: "governed", cycle: 1, version: 2 },
        missingGateIds: ["verified_pull_request", "observed_checks"]
      }
    });
  });

  it("returns the current assessment without duplicating side effects on completion replay", async () => {
    const setup = await startRun({ runId: "run_replay", completionPolicies: [strictPolicy] });
    const first = await completeRun({
      setup,
      runId: "run_replay",
      conclusion: "success",
      idempotencyKey: "completion-replay-key"
    });
    const firstBody = await first.json() as { completion: { currentAssessment: { id: string } } };
    const deliveredAfterFirst = setup.delivered.length;

    const replay = await completeRun({
      setup,
      runId: "run_replay",
      conclusion: "success",
      idempotencyKey: "completion-replay-key"
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      replayed: true,
      completion: { currentAssessment: { id: firstBody.completion.currentAssessment.id } }
    });
    expect(setup.delivered).toHaveLength(deliveredAfterFirst);
  });

  it("heals a missing assessment from a durably persisted runner result on replay after restart", async () => {
    const databasePath = temporaryDatabasePath();
    const setup = await startRun({ runId: "run_result_recovery", completionPolicies: [strictPolicy], databasePath });
    await completeRun({
      setup,
      runId: "run_result_recovery",
      conclusion: "success",
      idempotencyKey: "result-recovery-key"
    });
    const sqlite = new Database(databasePath);
    sqlite.prepare("DELETE FROM completion_assessments").run();
    sqlite.prepare("UPDATE work_threads SET current_assessment_id = NULL").run();
    sqlite.close();

    const restarted = createDispatcherApp({ databasePath, completionPolicies: [strictPolicy] });
    const replay = await restarted.request(
      "/v1/runners/runner_1/runs/run_result_recovery/complete",
      jsonRequest({
        ...setup.claim,
        idempotencyKey: "result-recovery-key",
        result: {
          conclusion: "success",
          summary: "success result",
          createdPullRequestUrl: "https://github.com/acme/demo/pull/7"
        }
      })
    );

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      replayed: true,
      completion: { completion: "pending", currentAssessment: { sequence: 1 } }
    });
  });

  it.each(["failure", "cancelled", "timed_out"] as const)(
    "never treats a %s executor result as completed work",
    async (conclusion) => {
      const runId = `run_${conclusion}`;
      const setup = await startRun({ runId, completionPolicies: [strictPolicy] });
      const response = await completeRun({ setup, runId, conclusion });

      expect(response.status).toBe(200);
      const body = await response.json() as { completion: { execution: string; completion: string } };
      expect(body.completion.execution).toBe(conclusion === "failure" ? "failed" : conclusion);
      expect(body.completion.completion).not.toBe("satisfied");
      expect(body.completion.completion).not.toBe("waived");
      expect(setup.delivered.at(-1)?.body).toContain(`Execution ${conclusion}; work is not complete.`);
    }
  );

  it("promotes the next queued follow-up even while strict completion awaits evidence", async () => {
    const setup = await startRun({ runId: "run_active", completionPolicies: [strictPolicy] });
    const queued = await setup.app.request("/v1/runs", jsonRequest({
      runId: "follow_up_1",
      event: githubIssueEvent({ id: "event_follow_up", sourceEventId: "comment_follow_up" })
    }));
    expect(queued.status).toBe(202);

    const complete = await completeRun({ setup, runId: "run_active", conclusion: "success" });
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toMatchObject({
      completion: { completion: "pending" },
      promotedFollowUp: {
        followUpRequest: { id: "follow_up_1", status: "promoted" },
        run: { parentRunId: "run_active" }
      }
    });
  });

  it("becomes satisfied only after verified current-head checks and merge evidence", async () => {
    const setup = await startRun({ runId: "run_verified", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_verified", conclusion: "success" });

    const evidence = await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-verified" }))
    );
    expect(evidence.status).toBe(201);
    await expect(evidence.json()).resolves.toMatchObject({
      outcome: "recorded",
      completion: {
        execution: "succeeded",
        completion: "satisfied",
        evidenceBacked: true,
        targetBindings: [{ resourceRef: "github:acme/demo:pull_request:7", resourceVersion: HEAD_CURRENT }],
        missingGateIds: [],
        failedGateIds: [],
        blockedGateIds: []
      }
    });
    expect(setup.delivered.at(-1)?.body).toContain("provider-verified completion requirements are satisfied");
    const explanation = await setup.app.request("/v1/runs/run_verified/completion");
    expect(explanation.status).toBe(200);
    const explanationBody = await explanation.json() as {
      completion: { evidence: Array<{ kind: string; assurance: string; subject: { resourceVersion: string } }> };
    };
    expect(explanationBody).toMatchObject({
      completion: {
        execution: "succeeded",
        completion: "satisfied",
        contractSnapshot: { mode: "governed", version: 1, cycle: 1 },
        currentAssessment: { state: "satisfied", sequence: 2 },
        assessmentHistory: [{ state: "pending" }, { state: "satisfied" }],
        openHumanEscalations: []
      }
    });
    expect(explanationBody.completion.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "source_control.pull_request", assurance: "verified", subject: expect.objectContaining({ resourceVersion: HEAD_CURRENT }) }),
      expect.objectContaining({ kind: "source_control.required_checks", assurance: "verified", subject: expect.objectContaining({ resourceVersion: HEAD_CURRENT }) }),
      expect.objectContaining({ kind: "source_control.pull_request_state", assurance: "verified", subject: expect.objectContaining({ resourceVersion: HEAD_CURRENT }) })
    ]));
  });

  it("fails a configured base-branch gate when GitHub reports another base", async () => {
    const setup = await startRun({
      runId: "run_wrong_base",
      completionPolicies: [{ ...strictPolicy, baseBranch: "release" }]
    });
    await completeRun({ setup, runId: "run_wrong_base", conclusion: "success" });
    const evidence = await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-wrong-base" }))
    );

    await expect(evidence.json()).resolves.toMatchObject({
      completion: {
        completion: "unsatisfied",
        failedGateIds: ["base_branch"]
      }
    });
  });

  it("deduplicates a GitHub delivery without appending another assessment", async () => {
    const setup = await startRun({ runId: "run_delivery_replay", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_delivery_replay", conclusion: "success" });
    const snapshot = githubSnapshot({ deliveryId: "delivery-replay" });
    const first = await setup.app.request("/v1/completion-evidence/github", jsonRequest(snapshot));
    const firstBody = await first.json() as { completion: { currentAssessment: { id: string } } };
    const callbacksAfterFirst = setup.delivered.length;
    const replay = await setup.app.request("/v1/completion-evidence/github", jsonRequest({
      ...snapshot,
      observedAt: "2026-07-21T10:06:00.000Z",
      payloadDigest: `sha256:${"a".repeat(64)}`
    }));

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      outcome: "duplicate",
      completion: { currentAssessment: { id: firstBody.completion.currentAssessment.id } }
    });
    expect(setup.delivered).toHaveLength(callbacksAfterFirst);
  });

  it("rejects reuse of a GitHub delivery id when facts change even if the claimed digest does not", async () => {
    const setup = await startRun({ runId: "run_delivery_conflict", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_delivery_conflict", conclusion: "success" });
    const original = githubSnapshot({ deliveryId: "delivery-conflict" });
    await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(original)
    );

    const conflict = await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest({
        ...githubSnapshot({ deliveryId: "delivery-conflict", state: "open" }),
        payloadDigest: original.payloadDigest
      })
    );

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: "completion_evidence_delivery_conflict" });
  });

  it("heals a stale assessment from durable GitHub evidence on the first read after restart", async () => {
    const databasePath = temporaryDatabasePath();
    const setup = await startRun({ runId: "run_evidence_recovery", completionPolicies: [strictPolicy], databasePath });
    await completeRun({ setup, runId: "run_evidence_recovery", conclusion: "success" });
    await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-evidence-recovery" }))
    );
    const sqlite = new Database(databasePath);
    sqlite.prepare("DELETE FROM completion_assessments WHERE state = 'satisfied'").run();
    sqlite.prepare(`
      UPDATE work_threads
      SET current_assessment_id = (
        SELECT id FROM completion_assessments
        WHERE work_thread_id = work_threads.id
        ORDER BY sequence DESC LIMIT 1
      )
    `).run();
    sqlite.close();

    const restarted = createDispatcherApp({ databasePath, completionPolicies: [strictPolicy] });
    const explanation = await restarted.request("/v1/runs/run_evidence_recovery/completion");

    expect(explanation.status).toBe(200);
    await expect(explanation.json()).resolves.toMatchObject({
      completion: {
        completion: "satisfied",
        currentAssessment: { state: "satisfied", sequence: 2 },
        assessmentHistory: [{ state: "pending" }, { state: "satisfied" }]
      }
    });
  });

  it("reassesses dirty durable completion state and emits the missed semantic transition at startup", async () => {
    const databasePath = temporaryDatabasePath();
    const setup = await startRun({
      runId: "run_startup_recovery",
      completionPolicies: [strictPolicy],
      databasePath,
      reassessmentObligations: { autoStart: false, inline: false }
    });
    await completeRun({ setup, runId: "run_startup_recovery", conclusion: "success" });
    await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-startup-recovery" }))
    );
    const sqlite = new Database(databasePath);
    expect(sqlite.prepare(`
      SELECT state FROM reassessment_obligations
      WHERE source_kind = 'verification_evidence_attached'
    `).get()).toEqual({ state: "pending" });
    expect(sqlite.prepare("SELECT state FROM completion_assessments ORDER BY sequence DESC LIMIT 1").get())
      .toEqual({ state: "pending" });
    sqlite.close();
    const recoveredCallbacks: CallbackMessage[] = [];
    createDispatcherApp({
      databasePath,
      completionPolicies: [strictPolicy],
      callbackSink: { async deliver(message) { recoveredCallbacks.push(message); } }
    });

    for (let attempt = 0; attempt < 50 && recoveredCallbacks.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    expect(recoveredCallbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: expect.stringContaining("provider-verified completion requirements are satisfied") })
    ]));
  });

  it("opens, deduplicates, and resolves a correlated GitHub reconciliation escalation", async () => {
    const setup = await startRun({ runId: "run_reconciliation", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_reconciliation", conclusion: "success" });
    await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-reconciliation-evidence" }))
    );
    const callbacksBeforeEscalation = setup.delivered.length;
    const escalation = {
      operation: "open",
      escalation: {
        class: "reconciliation",
        audience: "repo_owner",
        subjectRef: "github:acme/demo:pull_request:7",
        state: "open",
        blocking: true,
        summary: "GitHub completion reconciliation failed.",
        reason: "The authoritative snapshot could not be loaded.",
        dedupeKey: "github:acme/demo:pull_request:7:completion-reconciliation"
      },
      correlation: {
        provider: "github",
        deliveryId: "delivery-reconciliation",
        eventName: "pull_request",
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [7],
        headSha: HEAD_CURRENT
      }
    };
    const opened = await setup.app.request("/v1/completion-escalations/github", jsonRequest(escalation));
    expect(opened.status).toBe(201);
    await expect(opened.json()).resolves.toMatchObject({ outcome: "opened" });
    expect(setup.delivered).toHaveLength(callbacksBeforeEscalation + 1);
    expect(setup.delivered.at(-1)?.body).toContain("blocked");
    await expect((await setup.app.request("/v1/completion-escalations/github", jsonRequest(escalation))).json())
      .resolves.toMatchObject({ outcome: "duplicate" });
    expect(setup.delivered).toHaveLength(callbacksBeforeEscalation + 1);
    const explanation = await setup.app.request("/v1/runs/run_reconciliation/completion");
    await expect(explanation.json()).resolves.toMatchObject({
      completion: {
        completion: "blocked",
        currentAssessment: { state: "blocked", triggeredByRunId: "run_reconciliation" },
        openHumanEscalations: [{ class: "reconciliation", state: "open", blocking: true, runId: "run_reconciliation" }]
      }
    });

    const resolved = await setup.app.request("/v1/completion-escalations/github", jsonRequest({
      ...escalation,
      operation: "resolve",
      escalation: {
        ...escalation.escalation,
        state: "resolved",
        reason: "The authoritative snapshot was reconciled successfully."
      }
    }));
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({ outcome: "resolved" });
    await expect((await setup.app.request("/v1/runs/run_reconciliation/completion")).json())
      .resolves.toMatchObject({ completion: { completion: "satisfied", openHumanEscalations: [] } });
    expect(setup.delivered.at(-1)?.body).toContain("provider-verified completion requirements are satisfied");

    const reopened = await setup.app.request("/v1/completion-escalations/github", jsonRequest(escalation));
    expect(reopened.status).toBe(201);
    await expect(reopened.json()).resolves.toMatchObject({ outcome: "opened" });
    const duplicateReopen = await setup.app.request("/v1/completion-escalations/github", jsonRequest(escalation));
    expect(duplicateReopen.status).toBe(200);
    await expect(duplicateReopen.json()).resolves.toMatchObject({ outcome: "duplicate" });
    const reopenedExplanation = await (await setup.app.request("/v1/runs/run_reconciliation/completion")).json() as {
      completion: {
        openHumanEscalations: Array<{ id: string }>;
        assessmentHistory: Array<{ gateResults: Array<{ gateId: string }> }>;
      };
    };
    expect(reopenedExplanation.completion.openHumanEscalations).toHaveLength(1);
    const escalationGateIds = new Set(reopenedExplanation.completion.assessmentHistory.flatMap((assessment) =>
      assessment.gateResults.flatMap((gate) => gate.gateId.startsWith("human_escalation:") ? [gate.gateId] : [])
    ));
    expect(escalationGateIds.size).toBe(2);
    const resolvedReopen = await setup.app.request("/v1/completion-escalations/github", jsonRequest({
      ...escalation,
      operation: "resolve",
      escalation: { ...escalation.escalation, state: "resolved" }
    }));
    expect(resolvedReopen.status).toBe(200);
    await expect(resolvedReopen.json()).resolves.toMatchObject({ outcome: "resolved" });
    await expect((await setup.app.request("/v1/runs/run_reconciliation/completion")).json())
      .resolves.toMatchObject({ completion: { completion: "satisfied", openHumanEscalations: [] } });
  });

  it("correlates a status reconciliation escalation by a unique current head SHA", async () => {
    const setup = await startRun({ runId: "run_head_unique", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_head_unique", conclusion: "success" });
    await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-head-unique" }))
    );
    const response = await setup.app.request("/v1/completion-escalations/github", jsonRequest({
      operation: "open",
      escalation: {
        class: "reconciliation",
        audience: "repo_owner",
        subjectRef: `github:acme/demo:commit:${HEAD_CURRENT}`,
        state: "open",
        blocking: true,
        summary: "Status reconciliation failed.",
        reason: "GitHub status could not be reconciled.",
        dedupeKey: `github:acme/demo:commit:${HEAD_CURRENT}:completion-reconciliation`
      },
      correlation: {
        provider: "github",
        deliveryId: "status-head-unique",
        eventName: "status",
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [],
        headSha: HEAD_CURRENT
      }
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ outcome: "opened" });
  });

  it("opens a new active escalation generation when the same dedupe key fails in a newer run", async () => {
    const setup = await startRun({ runId: "run_escalation_generation_1", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_escalation_generation_1", conclusion: "success" });
    const escalation = {
      operation: "open",
      escalation: {
        class: "reconciliation",
        audience: "repo_owner",
        subjectRef: "github:acme/demo:pull_request:7",
        state: "open",
        blocking: true,
        summary: "GitHub completion reconciliation failed.",
        reason: "The authoritative snapshot could not be loaded.",
        dedupeKey: "github:acme/demo:pull_request:7:cross-run-reconciliation"
      },
      correlation: {
        provider: "github",
        deliveryId: "delivery-escalation-generation-1",
        eventName: "pull_request",
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [7]
      }
    };
    expect((await setup.app.request("/v1/completion-escalations/github", jsonRequest(escalation))).status).toBe(201);

    expect((await setup.app.request("/v1/runs", jsonRequest({
      runId: "run_escalation_generation_2",
      event: githubIssueEvent({ id: "event_escalation_generation_2", sourceEventId: "comment_escalation_generation_2" })
    }))).status).toBe(201);
    setup.claim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    await completeRun({ setup, runId: "run_escalation_generation_2", conclusion: "success" });
    const reopened = await setup.app.request("/v1/completion-escalations/github", jsonRequest({
      ...escalation,
      correlation: { ...escalation.correlation, deliveryId: "delivery-escalation-generation-2" }
    }));
    expect(reopened.status).toBe(201);
    await expect(reopened.json()).resolves.toMatchObject({ outcome: "opened" });
    const replay = await setup.app.request("/v1/completion-escalations/github", jsonRequest({
      ...escalation,
      correlation: { ...escalation.correlation, deliveryId: "delivery-escalation-generation-2-replay" }
    }));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ outcome: "duplicate" });

    const explanation = await (await setup.app.request("/v1/runs/run_escalation_generation_2/completion")).json() as {
      completion: {
        completion: string;
        currentAssessment: { triggeredByRunId?: string };
        openHumanEscalations: Array<{ id: string; runId?: string }>;
      };
    };
    expect(explanation.completion.completion).toBe("blocked");
    expect(explanation.completion.currentAssessment.triggeredByRunId).toBe("run_escalation_generation_2");
    expect(explanation.completion.openHumanEscalations).toHaveLength(2);
    expect(new Set(explanation.completion.openHumanEscalations.map((item) => item.id)).size).toBe(2);
    expect(explanation.completion.openHumanEscalations.map((item) => item.runId).sort()).toEqual([
      "run_escalation_generation_1",
      "run_escalation_generation_2"
    ]);
  });

  it("fails closed when a status head SHA has no current WorkThread correlation", async () => {
    const setup = await startRun({ runId: "run_head_none", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_head_none", conclusion: "success" });
    const response = await setup.app.request("/v1/completion-escalations/github", jsonRequest({
      operation: "open",
      escalation: {
        class: "reconciliation",
        audience: "repo_owner",
        subjectRef: `github:acme/demo:commit:${HEAD_CURRENT}`,
        state: "open",
        blocking: true,
        summary: "Status reconciliation failed.",
        reason: "No matching head exists.",
        dedupeKey: "github:head:none"
      },
      correlation: {
        provider: "github",
        deliveryId: "status-head-none",
        eventName: "status",
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [],
        headSha: HEAD_CURRENT
      }
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ outcome: "uncorrelated" });
  });

  it("fails closed when a status head SHA ambiguously matches two current WorkThreads", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", completionPolicies: [strictPolicy] });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }));
    await app.request("/v1/repo-bindings", jsonRequest({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" }));
    for (const [runId, issueNumber, pullRequestNumber] of [["run_head_a", 1, 7], ["run_head_b", 2, 8]] as const) {
      expect((await app.request("/v1/runs", jsonRequest({
        runId,
        event: githubIssueEvent({ id: `event_${runId}`, sourceEventId: `comment_${runId}`, issueNumber })
      }))).status).toBe(201);
      const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
        attemptId: string;
        fencingToken: string;
      };
      await app.request(`/v1/runners/runner_1/runs/${runId}/complete`, jsonRequest({
        ...claim,
        result: {
          conclusion: "success",
          summary: "created PR",
          createdPullRequestUrl: `https://github.com/acme/demo/pull/${pullRequestNumber}`
        }
      }));
      await app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
        deliveryId: `delivery-${runId}`,
        pullRequestNumber,
        headSha: HEAD_CURRENT
      })));
    }
    const response = await app.request("/v1/completion-escalations/github", jsonRequest({
      operation: "open",
      escalation: {
        class: "reconciliation",
        audience: "repo_owner",
        subjectRef: `github:acme/demo:commit:${HEAD_CURRENT}`,
        state: "open",
        blocking: true,
        summary: "Status reconciliation failed.",
        reason: "Multiple current heads match.",
        dedupeKey: "github:head:ambiguous"
      },
      correlation: {
        provider: "github",
        deliveryId: "status-head-ambiguous",
        eventName: "status",
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [],
        headSha: HEAD_CURRENT
      }
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ outcome: "ambiguous" });
  });

  it("does not let an older satisfied run satisfy a newer failed delivery cycle on the same WorkThread", async () => {
    const setup = await startRun({ runId: "run_cycle_success", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_cycle_success", conclusion: "success" });
    await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-cycle-success" }))
    );
    expect((await setup.app.request("/v1/runs", jsonRequest({
      runId: "run_cycle_failure",
      event: githubIssueEvent({ id: "event_cycle_failure", sourceEventId: "comment_cycle_failure" })
    }))).status).toBe(201);
    const claim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const failed = await setup.app.request(
      "/v1/runners/runner_1/runs/run_cycle_failure/complete",
      jsonRequest({
        ...claim,
        result: { conclusion: "failure", summary: "new delivery failed" }
      })
    );

    expect(failed.status).toBe(200);
    await expect(failed.json()).resolves.toMatchObject({
      completion: {
        execution: "failed",
        completion: "unsatisfied",
        currentAssessment: { triggeredByRunId: "run_cycle_failure" }
      }
    });
  });

  it("does not correlate an old pull request subject after a newer delivery cycle changes the current pull request", async () => {
    const setup = await startRun({ runId: "run_pr_epoch_7", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_pr_epoch_7", conclusion: "success", pullRequestNumber: 7 });
    await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-pr-epoch-7",
      pullRequestNumber: 7
    })));
    expect((await setup.app.request("/v1/runs", jsonRequest({
      runId: "run_pr_epoch_8",
      event: githubIssueEvent({ id: "event_pr_epoch_8", sourceEventId: "comment_pr_epoch_8" })
    }))).status).toBe(201);
    const claim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    setup.claim = claim;
    await completeRun({ setup, runId: "run_pr_epoch_8", conclusion: "success", pullRequestNumber: 8 });
    const escalationFor = (pullRequestNumber: number) => ({
      operation: "open",
      escalation: {
        class: "reconciliation",
        audience: "repo_owner",
        subjectRef: `github:acme/demo:pull_request:${pullRequestNumber}`,
        state: "open",
        blocking: true,
        summary: "GitHub completion reconciliation failed.",
        reason: "The current pull request snapshot could not be loaded.",
        dedupeKey: `github:acme/demo:pull_request:${pullRequestNumber}:epoch-reconciliation`
      },
      correlation: {
        provider: "github",
        deliveryId: `delivery-pr-epoch-${pullRequestNumber}-failure`,
        eventName: "pull_request",
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [pullRequestNumber]
      }
    });
    expect((await setup.app.request("/v1/completion-escalations/github", jsonRequest(escalationFor(7)))).status).toBe(404);
    expect((await setup.app.request("/v1/completion-escalations/github", jsonRequest(escalationFor(8)))).status).toBe(201);
  });

  it("keeps the newer created run authoritative when an older run completes afterward", async () => {
    const databasePath = temporaryDatabasePath();
    const setup = await startRun({
      runId: "run_epoch_interleave_1",
      completionPolicies: [strictPolicy],
      databasePath
    });
    expect((await setup.app.request("/v1/runs", jsonRequest({
      runId: "run_epoch_interleave_2",
      event: githubIssueEvent({ id: "event_epoch_interleave_2", sourceEventId: "comment_epoch_interleave_2" })
    }))).status).toBe(202);
    const promote = await setup.app.request("/v1/follow-up-requests/run_epoch_interleave_2/create-run", jsonRequest({
      runId: "run_epoch_interleave_2_promoted"
    }));
    expect(promote.status).toBe(201);
    await expect(promote.json()).resolves.toMatchObject({
      followUpRequest: { id: "run_epoch_interleave_2", status: "promoted" },
      run: { id: "run_epoch_interleave_2_promoted", parentRunId: "run_epoch_interleave_1" }
    });
    const currentRunId = "run_epoch_interleave_2_promoted";

    const oldCompletion = await completeRun({
      setup,
      runId: "run_epoch_interleave_1",
      conclusion: "success",
      pullRequestNumber: 7
    });
    expect(oldCompletion.status).toBe(200);
    await expect(oldCompletion.json()).resolves.toMatchObject({
      completion: { completion: "pending", currentAssessment: { state: "pending" } }
    });
    setup.claim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const promotedExplanation = await (await setup.app.request(`/v1/runs/${currentRunId}/completion`)).json() as {
      completion: { completion: string; currentAssessment: { triggeredByRunId?: string } };
    };
    expect(promotedExplanation.completion.completion).toBe("pending");
    expect(promotedExplanation.completion.currentAssessment.triggeredByRunId).toBeUndefined();
    const escalationFor = (pullRequestNumber: number) => ({
      operation: "open",
      escalation: {
        class: "reconciliation",
        audience: "repo_owner",
        subjectRef: `github:acme/demo:pull_request:${pullRequestNumber}`,
        state: "open",
        blocking: true,
        summary: "GitHub completion reconciliation failed.",
        reason: "The current pull request snapshot could not be loaded.",
        dedupeKey: `github:acme/demo:pull_request:${pullRequestNumber}:interleaved-reconciliation`
      },
      correlation: {
        provider: "github",
        deliveryId: `delivery-interleaved-${pullRequestNumber}`,
        eventName: "pull_request",
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [pullRequestNumber]
      }
    });
    expect((await setup.app.request("/v1/completion-escalations/github", jsonRequest(escalationFor(7)))).status).toBe(404);

    await completeRun({ setup, runId: currentRunId, conclusion: "success", pullRequestNumber: 8 });
    await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-interleaved-current-evidence",
      pullRequestNumber: 8
    })));
    expect((await setup.app.request("/v1/completion-escalations/github", jsonRequest(escalationFor(7)))).status).toBe(404);
    const currentHeadEscalation = {
      ...escalationFor(8),
      correlation: {
        ...escalationFor(8).correlation,
        pullRequestNumbers: [],
        headSha: HEAD_CURRENT
      }
    };
    const currentOpen = await setup.app.request("/v1/completion-escalations/github", jsonRequest(currentHeadEscalation));
    expect(currentOpen.status).toBe(201);
    await expect(currentOpen.json()).resolves.toMatchObject({ outcome: "opened" });
    const replay = await setup.app.request("/v1/completion-escalations/github", jsonRequest(currentHeadEscalation));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ outcome: "duplicate" });
    await expect((await setup.app.request(`/v1/runs/${currentRunId}/completion`)).json()).resolves.toMatchObject({
      completion: {
        completion: "blocked",
        currentAssessment: { triggeredByRunId: currentRunId },
        openHumanEscalations: [{ runId: currentRunId }]
      }
    });
    expect(setup.delivered.at(-1)?.runId).toBe(currentRunId);

    const restartedDeliveries: CallbackMessage[] = [];
    const restarted = createDispatcherApp({
      databasePath,
      completionPolicies: [strictPolicy],
      callbackSink: { async deliver(message) { restartedDeliveries.push(message); } }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect((await restarted.request(`/v1/runs/${currentRunId}/completion`)).json()).resolves.toMatchObject({
      completion: {
        completion: "blocked",
        currentAssessment: { triggeredByRunId: currentRunId },
        openHumanEscalations: [{ runId: currentRunId }]
      }
    });
    expect((await restarted.request("/v1/completion-escalations/github", jsonRequest(escalationFor(7)))).status).toBe(404);
    const restartedReplay = await restarted.request("/v1/completion-escalations/github", jsonRequest(currentHeadEscalation));
    expect(restartedReplay.status).toBe(200);
    await expect(restartedReplay.json()).resolves.toMatchObject({ outcome: "duplicate" });
    expect(restartedDeliveries).toEqual([]);
  });

  it("atomically persists and replay-fences a multi-PR GitHub completion delivery", async () => {
    const databasePath = temporaryDatabasePath();
    const setup = await startRun({ runId: "run_multi_pr_delivery", completionPolicies: [strictPolicy], databasePath });
    await completeRun({ setup, runId: "run_multi_pr_delivery", conclusion: "success", pullRequestNumber: 7 });
    const snapshots = [7, 8].map((pullRequestNumber) => githubSnapshot({
      deliveryId: "delivery-multi-pr",
      eventName: "status",
      pullRequestNumber
    }));
    const first = await setup.app.request("/v1/completion-evidence/github/batch", jsonRequest({ snapshots }));
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ outcome: "recorded", workThreadIds: [expect.any(String)] });
    const sqlite = new Database(databasePath);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM verification_evidence WHERE delivery_id = ?")
      .get("delivery-multi-pr") as { count: number }).count).toBe(9);

    const replay = await setup.app.request("/v1/completion-evidence/github/batch", jsonRequest({ snapshots: [...snapshots].reverse() }));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ outcome: "duplicate" });

    const changedFacts = structuredClone(snapshots);
    changedFacts[1]!.checks = { build: "failed", test: "passed" };
    expect((await setup.app.request("/v1/completion-evidence/github/batch", jsonRequest({ snapshots: changedFacts }))).status).toBe(409);
    expect((await setup.app.request("/v1/completion-evidence/github/batch", jsonRequest({ snapshots: [snapshots[0]] }))).status).toBe(409);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM verification_evidence WHERE delivery_id = ?")
      .get("delivery-multi-pr") as { count: number }).count).toBe(9);
    sqlite.close();
  });

  it("keeps the source thread quiet for same-state check updates", async () => {
    const setup = await startRun({ runId: "run_quiet_checks", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_quiet_checks", conclusion: "success" });
    const callbacksAfterExecution = setup.delivered.length;

    await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-quiet-1",
      state: "open",
      checks: { build: "passed", test: "pending" },
      observedAt: "2026-07-21T10:05:00.000Z"
    })));
    const callbacksAfterStateChange = setup.delivered.length;
    expect(callbacksAfterStateChange).toBe(callbacksAfterExecution + 1);
    await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-quiet-2",
      state: "open",
      checks: { build: "passed", test: "passed" },
      observedAt: "2026-07-21T10:06:00.000Z"
    })));

    expect(setup.delivered).toHaveLength(callbacksAfterStateChange);
  });

  it("applies and replays a bounded current-contract waiver with one semantic callback", async () => {
    const setup = await startRun({
      runId: "run_waived",
      completionPolicies: [strictPolicy],
      completionNow: () => "2026-07-21T10:11:00.000Z"
    });
    await completeRun({ setup, runId: "run_waived", conclusion: "success" });
    const body = {
      actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
      reason: "Merge and checks are intentionally deferred for this bounded delivery cycle.",
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["required_checks", "merge"],
      waivedAt: "2026-07-21T10:10:00.000Z",
      expiresAt: "2026-07-22T10:10:00.000Z"
    };
    const first = await setup.app.request("/v1/runs/run_waived/completion/waivers", jsonRequest(body));
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      outcome: "recorded",
      completion: {
        completion: "waived",
        currentAssessment: {
          state: "waived",
          assessedBy: "human",
          waiver: { actor: body.actor, reason: body.reason, gateIds: ["merge", "required_checks"] }
        }
      },
      waiver: { actor: body.actor, reason: body.reason, gateIds: ["merge", "required_checks"] }
    });
    expect(setup.delivered.at(-1)?.body).toContain("attributed bounded waiver");
    const callbacksAfterFirst = setup.delivered.length;

    const replay = await setup.app.request("/v1/runs/run_waived/completion/waivers", jsonRequest(body));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ outcome: "duplicate", completion: { completion: "waived" } });
    expect(setup.delivered).toHaveLength(callbacksAfterFirst);

    const invalid = await setup.app.request("/v1/runs/run_waived/completion/waivers", jsonRequest({
      ...body,
      gateIds: ["not-a-current-gate"],
      waivedAt: "2026-07-21T10:11:00.000Z"
    }));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_completion_waiver" });
  });

  it("does not carry a bounded waiver into a newer successful delivery on the same WorkThread", async () => {
    const setup = await startRun({ runId: "run_old_waiver", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_old_waiver", conclusion: "success" });
    await setup.app.request("/v1/runs/run_old_waiver/completion/waivers", jsonRequest({
      actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
      reason: "Exception for the first delivery only.",
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["required_checks", "merge"],
      waivedAt: "2026-07-21T10:10:00.000Z"
    }));
    expect((await setup.app.request("/v1/runs", jsonRequest({
      runId: "run_after_waiver",
      event: githubIssueEvent({ id: "event_after_waiver", sourceEventId: "comment_after_waiver" })
    }))).status).toBe(201);
    const claim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const completed = await setup.app.request(
      "/v1/runners/runner_1/runs/run_after_waiver/complete",
      jsonRequest({
        ...claim,
        result: {
          conclusion: "success",
          summary: "new delivery success",
          createdPullRequestUrl: "https://github.com/acme/demo/pull/7"
        }
      })
    );

    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      completion: {
        completion: "pending",
        currentAssessment: { triggeredByRunId: "run_after_waiver" }
      }
    });
  });

  it("projects a read-time waiver expiry exactly once and keeps replay reads quiet", async () => {
    let now = "2026-07-21T10:00:00.000Z";
    const setup = await startRun({
      runId: "run_waiver_expiry",
      completionPolicies: [strictPolicy],
      completionNow: () => now
    });
    await completeRun({ setup, runId: "run_waiver_expiry", conclusion: "success" });
    const waiver = await setup.app.request("/v1/runs/run_waiver_expiry/completion/waivers", jsonRequest({
      actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
      reason: "Short-lived delivery exception.",
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["required_checks", "merge"],
      waivedAt: "2026-07-21T10:00:00.000Z",
      expiresAt: "2026-07-21T10:05:00.000Z"
    }));
    expect(waiver.status).toBe(201);
    const callbacksBeforeExpiry = setup.delivered.length;
    now = "2026-07-21T10:06:00.000Z";

    const firstRead = await setup.app.request("/v1/runs/run_waiver_expiry/completion");
    expect(firstRead.status).toBe(200);
    await expect(firstRead.json()).resolves.toMatchObject({ completion: { completion: "pending" } });
    expect(setup.delivered).toHaveLength(callbacksBeforeExpiry + 1);
    expect(setup.delivered.at(-1)?.body).toContain("waiting for verified evidence");

    const replayRead = await setup.app.request("/v1/runs/run_waiver_expiry/completion");
    expect(replayRead.status).toBe(200);
    expect(setup.delivered).toHaveLength(callbacksBeforeExpiry + 1);
  });

  it("redacts credential-like waiver text before persistence, audit, and callback rendering", async () => {
    const setup = await startRun({ runId: "run_waiver_privacy", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_waiver_privacy", conclusion: "success" });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const response = await setup.app.request("/v1/runs/run_waiver_privacy/completion/waivers", jsonRequest({
      actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
      reason: `Emergency exception requested with token ${secret}`,
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["required_checks", "merge"],
      waivedAt: "2026-07-21T10:10:00.000Z"
    }));

    expect(response.status).toBe(201);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(secret);
    expect(body).toContain("[redacted]");
    expect(JSON.stringify(setup.delivered)).not.toContain(secret);

    const explanation = await setup.app.request("/v1/runs/run_waiver_privacy/completion");
    expect(JSON.stringify(await explanation.json())).not.toContain(secret);
  });

  it("converges when two evidence deliveries race and never leaves a stale assessment head", async () => {
    const setup = await startRun({ runId: "run_concurrent_evidence", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_concurrent_evidence", conclusion: "success" });
    const pending = githubSnapshot({
      deliveryId: "delivery-concurrent-pending",
      state: "open",
      checks: { build: "passed", test: "pending" },
      observedAt: "2026-07-21T10:04:00.000Z"
    });
    const accepted = githubSnapshot({
      deliveryId: "delivery-concurrent-accepted",
      observedAt: "2026-07-21T10:05:00.000Z"
    });

    const responses = await Promise.all([
      setup.app.request("/v1/completion-evidence/github", jsonRequest(pending)),
      setup.app.request("/v1/completion-evidence/github", jsonRequest(accepted))
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const replay = await setup.app.request("/v1/completion-evidence/github", jsonRequest(accepted));

    await expect(replay.json()).resolves.toMatchObject({
      outcome: "duplicate",
      completion: {
        completion: "satisfied",
        missingGateIds: [],
        failedGateIds: [],
        blockedGateIds: []
      }
    });
  });

  it("converges when executor result and matching evidence arrive concurrently", async () => {
    const setup = await startRun({ runId: "run_result_evidence_race", completionPolicies: [strictPolicy] });
    const snapshot = githubSnapshot({ deliveryId: "delivery-result-evidence-race" });

    const responses = await Promise.all([
      completeRun({ setup, runId: "run_result_evidence_race", conclusion: "success" }),
      setup.app.request("/v1/completion-evidence/github", jsonRequest(snapshot))
    ]);
    expect(responses.every((response) => response.status >= 200 && response.status < 300)).toBe(true);
    const replay = await setup.app.request("/v1/completion-evidence/github", jsonRequest(snapshot));

    await expect(replay.json()).resolves.toMatchObject({
      outcome: "duplicate",
      completion: {
        execution: "succeeded",
        completion: "satisfied",
        targetBindings: [{ resourceVersion: HEAD_CURRENT }]
      }
    });
  });

  it("keeps old-head green evidence visible but fails it against the new PR head", async () => {
    const setup = await startRun({ runId: "run_stale_head", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_stale_head", conclusion: "success" });
    const oldEvidence = await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-old",
      headSha: HEAD_OLD,
      observedAt: "2026-07-21T10:05:00.000Z"
    })));
    expect((await oldEvidence.json() as { completion: { completion: string } }).completion.completion).toBe("satisfied");

    const newEvidence = await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-new",
      headSha: HEAD_CURRENT,
      state: "open",
      checks: { build: "passed", test: "pending" },
      observedAt: "2026-07-21T10:10:00.000Z"
    })));
    await expect(newEvidence.json()).resolves.toMatchObject({
      outcome: "recorded",
      completion: {
        completion: "unsatisfied",
        targetBindings: [{ resourceVersion: HEAD_CURRENT }],
        failedGateIds: ["required_checks", "merge"]
      }
    });
  });

  it("persists uncorrelated evidence but requires a current-epoch observation after later correlation", async () => {
    const delivered: CallbackMessage[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      completionPolicies: [strictPolicy],
      callbackSink: { async deliver(message) { delivered.push(message); } }
    });
    const early = await app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({ deliveryId: "delivery-early" })));
    expect(early.status).toBe(200);
    await expect(early.json()).resolves.toEqual({ outcome: "uncorrelated" });

    expect((await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }))).status).toBe(201);
    expect((await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1"
    }))).status).toBe(201);
    expect((await app.request("/v1/runs", jsonRequest({
      runId: "run_evidence_first",
      event: githubIssueEvent({ id: "event_evidence_first", sourceEventId: "comment_evidence_first" })
    }))).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const complete = await app.request("/v1/runners/runner_1/runs/run_evidence_first/complete", jsonRequest({
      ...claim,
      result: {
        conclusion: "success",
        summary: "created the PR",
        createdPullRequestUrl: "https://github.com/acme/demo/pull/7"
      }
    }));
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toMatchObject({
      completion: { execution: "succeeded", completion: "pending" }
    });
    const current = await app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-current-after-correlation",
      observedAt: new Date().toISOString()
    })));
    expect(current.status).toBe(201);
    await expect(current.json()).resolves.toMatchObject({
      completion: { execution: "succeeded", completion: "satisfied" }
    });
    expect(delivered.at(-1)?.body).toContain("provider-verified completion requirements are satisfied");
  });

  it("rejects a spoofed resource identity instead of correlating it", async () => {
    const setup = await startRun({ runId: "run_spoof", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_spoof", conclusion: "success" });
    const response = await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-spoof",
      resourceRef: "github:other/demo:pull_request:7"
    })));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_completion_evidence_identity" });
  });
});
