import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { OpenTagEvent } from "@opentag/core";
import { createOpenTagRepository, migrateSchema } from "@opentag/store";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createDispatcherApp, type CallbackMessage, type SourceReceipt } from "../src/server.js";

const event = {
  id: "evt_seed",
  source: "github",
  sourceEventId: "comment_seed",
  receivedAt: "2026-07-26T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
  workItem: {
    provider: "github",
    kind: "issue",
    externalId: "acme/demo#1",
    uri: "https://github.com/acme/demo/issues/1",
    ownerContainer: { provider: "github", id: "acme/demo", uri: "https://github.com/acme/demo" }
  },
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { repoProvider: "github", owner: "acme", repo: "demo" }
} as const;

function post(body: unknown) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function waitFor(predicate: () => boolean, message: string, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function factorySetup(input: {
  callbackMessages?: CallbackMessage[];
  sourceReceipts?: SourceReceipt[];
  agentAccessProfileCheck?: Parameters<typeof createDispatcherApp>[0]["agentAccessProfileCheck"];
  completionNow?: Parameters<typeof createDispatcherApp>[0]["completionNow"];
  completionPolicies?: Parameters<typeof createDispatcherApp>[0]["completionPolicies"];
  databasePath?: string;
  seedEvent?: OpenTagEvent;
  channelPrincipals?: Parameters<typeof createDispatcherApp>[0]["channelPrincipals"];
  reassessmentObligations?: Parameters<typeof createDispatcherApp>[0]["reassessmentObligations"];
  managedChannel?: {
    binding: {
      provider: string;
      accountId: string;
      conversationId: string;
      repoProvider?: string;
      owner?: string;
      repo?: string;
      ownership: { mode: "managed"; exclusive: true; applicationId: string; botId?: string };
    };
    credential: string;
  };
  continuation?: {
    mode: "evidence_driven";
    triggers: Array<"completion_evidence_changed" | "human_escalation_resolved" | "retryable_run_failure">;
    maxContinuationsPerWorkThread: number;
    minIntervalSeconds: number;
    backoff: { initialSeconds: number; maxSeconds: number };
  };
} = {}) {
  const app = createDispatcherApp({
    databasePath: input.databasePath ?? ":memory:",
    reassessmentObligations: input.reassessmentObligations ?? { autoStart: false },
    callbackSink: { async deliver(message) { input.callbackMessages?.push(message); } },
    sourceReceiptSink: { async deliver(receipt) { input.sourceReceipts?.push(receipt); return { delivered: true }; } },
    ...(input.agentAccessProfileCheck ? { agentAccessProfileCheck: input.agentAccessProfileCheck } : {}),
    ...(input.completionNow ? { completionNow: input.completionNow } : {}),
    ...(input.completionPolicies ? { completionPolicies: input.completionPolicies } : {}),
    ...(input.channelPrincipals ? { channelPrincipals: input.channelPrincipals } : {})
  });
  expect((await app.request("/v1/runners", post({ runnerId: "runner_1", name: "Local Runner" }))).status).toBe(201);
  expect((await app.request("/v1/repo-bindings", post({
    provider: "github",
    owner: "acme",
    repo: "demo",
    runnerId: "runner_1",
    workspacePath: "/tmp/acme-demo",
    defaultExecutor: "echo",
    allowedActors: ["octocat"]
  }))).status).toBe(201);
  if (input.managedChannel) {
    const binding = await app.request("/v1/channel-bindings", {
      ...post(input.managedChannel.binding),
      headers: {
        "content-type": "application/json",
        "x-opentag-channel-principal": input.managedChannel.credential
      }
    });
    expect(binding.status).toBe(201);
  }
  const seedResponse = await app.request("/v1/runs", {
    ...post({ runId: "run_seed", event: input.seedEvent ?? event }),
    ...(input.managedChannel ? {
      headers: {
        "content-type": "application/json",
        "x-opentag-channel-principal": input.managedChannel.credential
      }
    } : {})
  });
  expect(seedResponse.status).toBe(201);
  const seed = await seedResponse.json() as { run: { thread: { id: string } } };
  expect((await app.request("/v1/runs/run_seed/cancel", post({ reason: "factory setup" }))).status).toBe(200);

  const recipe = {
    id: "recipe_default",
    version: 1,
    name: "Default workstream",
    ...(input.continuation ? { continuation: input.continuation } : {}),
    budgets: {
      maxConcurrentRuns: 2,
      maxAttemptsPerRun: 3,
      maxCostUnits: 20,
      costUnitsPerAttempt: 1,
      allowedLocalities: ["local", "private", "hosted"]
    }
  };
  expect((await app.request("/v1/factory-recipes", post(recipe))).status).toBe(201);
  const workstream = {
    id: "workstream_default",
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    name: "Default workstream",
    members: [{ kind: "work_thread", workThreadId: seed.run.thread.id }]
  };
  expect((await app.request("/v1/workstreams", post(workstream))).status).toBe(201);
  return { app, recipe, workstream, workThreadId: seed.run.thread.id };
}

describe("workstream batch admission", () => {
  it("turns a retryable terminal failure into one governed child Run without source-side acknowledgement", async () => {
    const callbackMessages: CallbackMessage[] = [];
    const sourceReceipts: SourceReceipt[] = [];
    const { app, workThreadId } = await factorySetup({
      callbackMessages,
      sourceReceipts,
      continuation: {
        mode: "evidence_driven",
        triggers: ["retryable_run_failure"],
        maxContinuationsPerWorkThread: 2,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 3_600, maxSeconds: 3_600 }
      }
    });
    callbackMessages.length = 0;
    sourceReceipts.length = 0;
    const batch = {
      id: "batch_retryable_continuation",
      workstreamId: "workstream_default",
      items: [{
        itemId: "item_retryable_continuation",
        runId: "run_retryable_continuation_parent",
        workThreadId,
        event: {
          ...event,
          id: "evt_retryable_continuation_parent",
          sourceEventId: "comment_retryable_continuation_parent",
          receivedAt: "2026-07-26T00:10:00.000Z"
        }
      }]
    };
    expect((await app.request("/v1/workstream-batches", post(batch))).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };

    const completed = await app.request(
      "/v1/runners/runner_1/runs/run_retryable_continuation_parent/complete",
      post({
        ...claim,
        idempotencyKey: "complete:run_retryable_continuation_parent",
        result: { conclusion: "failure", summary: "The bounded attempt failed and can be retried." }
      })
    );
    expect(completed.status).toBe(200);
    const completedBody = await completed.json() as {
      continuation: { outcome: string; run: { id: string } };
    };
    expect(completedBody.continuation).toMatchObject({
      outcome: "created",
      decisions: [{ action: "eligible", reasonCode: "eligible", workstreamId: "workstream_default" }],
      run: {
        status: "queued",
        parentRunId: "run_retryable_continuation_parent",
        triggeredByAction: {
          kind: "resume_work_thread",
          targetId: workThreadId,
          metadata: {
            workstreamContinuation: true,
            workstreamId: "workstream_default",
            workThreadId,
            triggerId: "run-terminal:run_retryable_continuation_parent"
          }
        }
      }
    });
    const childRunId = completedBody.continuation.run.id;
    await expect((await app.request(`/v1/runs/${childRunId}`)).json()).resolves.toMatchObject({
      run: { id: childRunId, parentRunId: "run_retryable_continuation_parent", status: "queued" },
      event: { metadata: { workstreamContinuation: true, workstreamId: "workstream_default" } }
    });
    expect(callbackMessages.some((message) => message.runId === childRunId)).toBe(false);
    expect(sourceReceipts.some((receipt) => receipt.runId === childRunId)).toBe(false);

    const collidingChild = await app.request(
      "/v1/runs/run_retryable_continuation_parent/child-runs",
      post({
        runId: "run_manual_child_during_continuation",
        action: { kind: "resume_work_thread", targetId: workThreadId },
        commandText: "Start a duplicate manual child while automatic continuation owns the thread."
      })
    );
    expect(collidingChild.status).toBe(409);
    await expect(collidingChild.json()).resolves.toMatchObject({
      error: "active_conversation_race",
      activeRunId: childRunId
    });

    const replay = await app.request(
      "/v1/runners/runner_1/runs/run_retryable_continuation_parent/complete",
      post({
        ...claim,
        idempotencyKey: "complete:run_retryable_continuation_parent",
        result: { conclusion: "failure", summary: "The bounded attempt failed and can be retried." }
      })
    );
    await expect(replay.json()).resolves.toMatchObject({ ok: true, replayed: true });
    await expect((await app.request("/v1/workstreams/workstream_default/metrics")).json()).resolves.toMatchObject({
      metrics: { runCount: 2, queuedRunCount: 1, terminalRunCount: 1 }
    });
    await expect((await app.request("/v1/control-plane-events?type=workstream.continuation.dispatched")).json()).resolves.toMatchObject({
      events: [{ subject: "workstream_default", payload: { outcome: "created", runId: childRunId } }]
    });

    const childClaim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const childCompleted = await app.request(
      `/v1/runners/runner_1/runs/${childRunId}/complete`,
      post({
        ...childClaim,
        result: { conclusion: "failure", summary: "The automatic continuation also failed." }
      })
    );
    await expect(childCompleted.json()).resolves.toMatchObject({
      ok: true,
      continuation: {
        outcome: "deferred",
        reasonCode: "backoff_not_elapsed",
        notBefore: expect.any(String),
        decisions: [{ action: "wait", reasonCode: "backoff_not_elapsed", automaticContinuationCount: 1 }]
      }
    });
    await expect((await app.request("/v1/workstreams/workstream_default/metrics")).json()).resolves.toMatchObject({
      metrics: { runCount: 2, queuedRunCount: 0, terminalRunCount: 2 }
    });
  });

  it("uses the injected continuation clock and reports the reason from the decision that needs a human", async () => {
    const evaluatedAt = "2099-07-26T00:30:00.000Z";
    const { app, recipe, workThreadId } = await factorySetup({
      completionNow: () => evaluatedAt,
      continuation: {
        mode: "evidence_driven",
        triggers: ["retryable_run_failure"],
        maxContinuationsPerWorkThread: 1,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    expect((await app.request("/v1/workstream-batches", post({
      id: "batch_continuation_reason",
      workstreamId: "workstream_default",
      items: [{
        itemId: "item_continuation_reason",
        runId: "run_continuation_reason_parent",
        workThreadId,
        event: {
          ...event,
          id: "evt_continuation_reason_parent",
          sourceEventId: "comment_continuation_reason_parent",
          receivedAt: "2026-07-26T00:10:00.000Z"
        }
      }]
    }))).status).toBe(201);
    const parentClaim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const parentCompletion = await app.request(
      "/v1/runners/runner_1/runs/run_continuation_reason_parent/complete",
      post({
        ...parentClaim,
        result: { conclusion: "failure", summary: "The first bounded attempt failed." }
      })
    );
    const parentBody = await parentCompletion.json() as {
      continuation: { decisions: Array<{ evaluatedAt: string }>; run: { id: string } };
    };
    expect(parentBody.continuation.decisions[0]?.evaluatedAt).toBe(evaluatedAt);

    expect((await app.request("/v1/factory-recipes", post({
      id: "recipe_manual",
      version: 1,
      name: "Manual workstream",
      continuation: { mode: "manual" },
      budgets: recipe.budgets
    }))).status).toBe(201);
    expect((await app.request("/v1/workstreams", post({
      id: "a_manual",
      recipeId: "recipe_manual",
      recipeVersion: 1,
      name: "Manual workstream",
      members: [{ kind: "work_thread", workThreadId }]
    }))).status).toBe(201);

    const childClaim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const childCompletion = await app.request(
      `/v1/runners/runner_1/runs/${parentBody.continuation.run.id}/complete`,
      post({
        ...childClaim,
        result: { conclusion: "failure", summary: "The continuation also failed." }
      })
    );
    await expect(childCompletion.json()).resolves.toMatchObject({
      continuation: {
        outcome: "needs_human",
        reasonCode: "continuation_limit_reached",
        decisions: [
          { workstreamId: "a_manual", action: "wait", reasonCode: "manual_policy" },
          { workstreamId: "workstream_default", action: "needs_human", reasonCode: "continuation_limit_reached" }
        ]
      }
    });
  });

  it("keeps queued follow-up promotion behind an already-submitted automatic continuation", async () => {
    const { app, workThreadId } = await factorySetup({
      continuation: {
        mode: "evidence_driven",
        triggers: ["retryable_run_failure"],
        maxContinuationsPerWorkThread: 2,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    expect((await app.request("/v1/workstream-batches", post({
      id: "batch_continuation_before_follow_up",
      workstreamId: "workstream_default",
      items: [{
        itemId: "item_continuation_before_follow_up",
        runId: "run_continuation_before_follow_up",
        workThreadId,
        event: {
          ...event,
          id: "evt_continuation_before_follow_up",
          sourceEventId: "comment_continuation_before_follow_up",
          receivedAt: "2026-07-26T00:20:00.000Z"
        }
      }]
    }))).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const completed = await app.request(
      "/v1/runners/runner_1/runs/run_continuation_before_follow_up/complete",
      post({
        ...claim,
        result: { conclusion: "failure", summary: "Create the governed continuation first." }
      })
    );
    const completedBody = await completed.json() as { continuation: { run: { id: string } } };
    const continuationRunId = completedBody.continuation.run.id;

    const queued = await app.request("/v1/runs", post({
      runId: "follow_up_behind_continuation",
      event: {
        ...event,
        id: "evt_follow_up_behind_continuation",
        sourceEventId: "comment_follow_up_behind_continuation",
        receivedAt: "2026-07-26T00:21:00.000Z"
      }
    }));
    expect(queued.status).toBe(202);
    await expect(queued.json()).resolves.toMatchObject({
      decision: { action: "queue_follow_up", activeRunId: continuationRunId },
      followUpRequest: { id: "follow_up_behind_continuation", status: "queued" }
    });

    const promoted = await app.request(
      "/v1/follow-up-requests/follow_up_behind_continuation/create-run",
      post({ runId: "run_promoted_behind_continuation" })
    );
    expect(promoted.status).toBe(409);
    await expect(promoted.json()).resolves.toEqual({
      error: "active_conversation_race",
      activeRunId: continuationRunId
    });
    await expect((await app.request("/v1/follow-up-requests/follow_up_behind_continuation")).json()).resolves.toMatchObject({
      followUpRequest: { status: "queued" }
    });
    expect((await app.request("/v1/runs/run_promoted_behind_continuation")).status).toBe(404);
  });

  it("lets a queued follow-up win before evaluating automatic continuation, without creating both", async () => {
    const { app, workThreadId } = await factorySetup({
      continuation: {
        mode: "evidence_driven",
        triggers: ["retryable_run_failure"],
        maxContinuationsPerWorkThread: 2,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    expect((await app.request("/v1/workstream-batches", post({
      id: "batch_follow_up_before_continuation",
      workstreamId: "workstream_default",
      items: [{
        itemId: "item_follow_up_before_continuation",
        runId: "run_follow_up_before_continuation",
        workThreadId,
        event: {
          ...event,
          id: "evt_follow_up_before_continuation",
          sourceEventId: "comment_follow_up_before_continuation",
          receivedAt: "2026-07-26T00:25:00.000Z"
        }
      }]
    }))).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    expect((await app.request("/v1/runs", post({
      runId: "follow_up_before_continuation",
      event: {
        ...event,
        id: "evt_queued_before_continuation",
        sourceEventId: "comment_queued_before_continuation",
        receivedAt: "2026-07-26T00:26:00.000Z"
      }
    }))).status).toBe(202);

    const completed = await app.request(
      "/v1/runners/runner_1/runs/run_follow_up_before_continuation/complete",
      post({
        ...claim,
        result: { conclusion: "failure", summary: "Promote the human follow-up first." }
      })
    );
    const completedBody = await completed.json() as {
      promotedFollowUp?: { followUpRequest: { id: string }; run: { id: string; status: string } };
      continuation?: unknown;
    };
    expect(completedBody).toMatchObject({
      promotedFollowUp: {
        followUpRequest: { id: "follow_up_before_continuation" },
        run: { status: "queued" }
      }
    });
    expect(completedBody.continuation).toBeUndefined();
    const promotedRunId = completedBody.promotedFollowUp!.run.id;
    await expect((await app.request(`/v1/runs/${promotedRunId}`)).json()).resolves.toMatchObject({
      run: { id: promotedRunId, status: "queued" },
      event: { metadata: expect.not.objectContaining({ workstreamContinuation: true }) }
    });
    await expect((await app.request("/v1/control-plane-events?type=workstream.continuation.dispatched")).json()).resolves.toMatchObject({
      events: []
    });
  });

  it("recovers queued-follow-up priority after a crash between terminal commit and promotion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-follow-up-reassessment-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    const setup = await factorySetup({
      databasePath,
      reassessmentObligations: { autoStart: false },
      continuation: {
        mode: "evidence_driven",
        triggers: ["retryable_run_failure"],
        maxContinuationsPerWorkThread: 2,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    let restarted: ReturnType<typeof createDispatcherApp> | undefined;
    try {
      expect((await setup.app.request("/v1/workstream-batches", post({
        id: "batch_follow_up_crash_recovery",
        workstreamId: "workstream_default",
        items: [{
          itemId: "item_follow_up_crash_recovery",
          runId: "run_follow_up_crash_recovery",
          workThreadId: setup.workThreadId,
          event: {
            ...event,
            id: "evt_follow_up_crash_recovery",
            sourceEventId: "comment_follow_up_crash_recovery",
            receivedAt: "2026-07-26T00:27:00.000Z"
          }
        }]
      }))).status).toBe(201);
      const claim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
        attemptId: string;
        fencingToken: string;
      };
      expect((await setup.app.request("/v1/runs", post({
        runId: "follow_up_crash_recovery",
        event: {
          ...event,
          id: "evt_queued_follow_up_crash_recovery",
          sourceEventId: "comment_queued_follow_up_crash_recovery",
          receivedAt: "2026-07-26T00:28:00.000Z"
        }
      }))).status).toBe(202);

      const sqlite = new Database(databasePath);
      migrateSchema(sqlite);
      const repo = createOpenTagRepository(drizzle(sqlite));
      await expect(repo.completeRun({
        runId: "run_follow_up_crash_recovery",
        runnerId: "runner_1",
        attemptId: claim.attemptId,
        fencingToken: claim.fencingToken,
        result: { conclusion: "failure", summary: "Committed immediately before the dispatcher crash." }
      })).resolves.toBe("completed");
      sqlite.close();
      await setup.app.stopBackgroundWorkers();

      restarted = createDispatcherApp({
        databasePath,
        reassessmentObligations: { pollIntervalMs: 10 }
      });
      const observer = new Database(databasePath);
      await waitFor(
        () => (observer.prepare("SELECT status FROM follow_up_requests WHERE id = 'follow_up_crash_recovery'").get() as { status?: string } | undefined)?.status === "promoted",
        "restart did not promote the queued follow-up before automatic continuation"
      );
      expect(observer.prepare(`
        SELECT COUNT(*) AS count FROM runs
        WHERE json_extract(event_json, '$.metadata.workstreamContinuation') = 1
      `).get()).toEqual({ count: 0 });
      expect(observer.prepare(`
        SELECT state, last_reason_code AS reasonCode FROM reassessment_obligations
        WHERE source_kind = 'run_result_recorded' AND source_id = 'run_follow_up_crash_recovery'
      `).get()).toEqual({ state: "satisfied", reasonCode: "continuation_dispatched" });
      observer.close();
    } finally {
      await restarted?.stopBackgroundWorkers();
      await setup.app.stopBackgroundWorkers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an evidence obligation pending behind an active Run and reassesses after it becomes terminal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-active-run-reassessment-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    const setup = await factorySetup({
      databasePath,
      completionPolicies: [{ provider: "github", owner: "acme", repo: "demo", requiredChecks: ["build", "test"] }],
      reassessmentObligations: { autoStart: false, inline: false, pollIntervalMs: 10 },
      continuation: {
        mode: "evidence_driven",
        triggers: ["completion_evidence_changed"],
        maxContinuationsPerWorkThread: 1,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    const observer = new Database(databasePath);
    let recovery: ReturnType<typeof createDispatcherApp> | undefined;
    try {
      expect((await setup.app.request("/v1/workstream-batches", post({
        id: "batch_active_run_reassessment",
        workstreamId: "workstream_default",
        items: [{
          itemId: "item_active_run_reassessment",
          runId: "run_evidence_before_active",
          workThreadId: setup.workThreadId,
          event: {
            ...event,
            id: "evt_evidence_before_active",
            sourceEventId: "comment_evidence_before_active",
            receivedAt: "2026-07-26T00:32:00.000Z"
          }
        }]
      }))).status).toBe(201);
      const parentClaim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
        attemptId: string;
        fencingToken: string;
      };
      expect((await setup.app.request(
        "/v1/runners/runner_1/runs/run_evidence_before_active/complete",
        post({
          ...parentClaim,
          result: {
            conclusion: "failure",
            summary: "Wait for provider evidence.",
            createdPullRequestUrl: "https://github.com/acme/demo/pull/7"
          }
        })
      )).status).toBe(200);
      expect((await setup.app.request("/v1/completion-evidence/github", post({
        provider: "github",
        deliveryId: "delivery-active-run-reassessment",
        eventName: "check_run",
        repository: { owner: "acme", repo: "demo" },
        pullRequest: {
          number: 7,
          resourceRef: "github:acme/demo:pull_request:7",
          headSha: "b".repeat(40),
          baseSha: "c".repeat(40),
          baseBranch: "main",
          state: "open"
        },
        checks: { build: "failed", test: "passed" },
        observedAt: "2099-07-26T00:34:00.000Z",
        payloadDigest: `sha256:${"e".repeat(64)}`
      }))).status).toBe(201);
      expect((await setup.app.request("/v1/runs", post({
        runId: "run_active_during_evidence",
        event: {
          ...event,
          id: "evt_active_during_evidence",
          sourceEventId: "comment_active_during_evidence",
          receivedAt: "2026-07-26T00:33:00.000Z"
        }
      }))).status).toBe(201);
      const activeClaim = await (await setup.app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
        attemptId: string;
        fencingToken: string;
      };
      recovery = createDispatcherApp({
        databasePath,
        completionPolicies: [{ provider: "github", owner: "acme", repo: "demo", requiredChecks: ["build", "test"] }],
        reassessmentObligations: { inline: false, pollIntervalMs: 10 }
      });
      await waitFor(
        () => {
          const row = observer.prepare(`
            SELECT state, last_reason_code AS reasonCode, attempt_count AS attemptCount
            FROM reassessment_obligations
            WHERE source_kind = 'verification_evidence_attached'
          `).get() as { state?: string; reasonCode?: string; attemptCount?: number } | undefined;
          return row?.state === "pending" && row.reasonCode === "continuation_deferred" && (row.attemptCount ?? 0) >= 1;
        },
        "active Run did not durably defer the evidence obligation"
      );

      expect((await setup.app.request(
        "/v1/runners/runner_1/runs/run_active_during_evidence/complete",
        post({
          ...activeClaim,
          result: {
            conclusion: "failure",
            summary: "The active Run is now terminal and retryable.",
            createdPullRequestUrl: "https://github.com/acme/demo/pull/7"
          }
        })
      )).status).toBe(200);
      await waitFor(
        () => (observer.prepare(`
          SELECT state FROM reassessment_obligations
          WHERE source_kind = 'verification_evidence_attached'
        `).get() as { state?: string } | undefined)?.state !== "pending",
        "due evidence obligation remained pending after the active Run became terminal"
      );
      expect(observer.prepare(`
        SELECT state, last_reason_code AS reasonCode, attempt_count AS attemptCount FROM reassessment_obligations
        WHERE source_kind = 'verification_evidence_attached'
      `).get()).toMatchObject({ state: "satisfied", reasonCode: "continuation_terminal", attemptCount: expect.any(Number) });
      expect((observer.prepare(`
        SELECT attempt_count AS attemptCount FROM reassessment_obligations
        WHERE source_kind = 'verification_evidence_attached'
      `).get() as { attemptCount: number }).attemptCount).toBeGreaterThanOrEqual(2);
      expect(observer.prepare(`
        SELECT COUNT(*) AS count FROM runs
        WHERE json_extract(event_json, '$.metadata.workstreamContinuation') = 1
      `).get()).toEqual({ count: 0 });
    } finally {
      observer.close();
      await recovery?.stopBackgroundWorkers();
      await setup.app.stopBackgroundWorkers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resumes from a durable human resolution only when the Workstream policy enables it", async () => {
    const { app, workThreadId } = await factorySetup({
      continuation: {
        mode: "evidence_driven",
        triggers: ["human_escalation_resolved"],
        maxContinuationsPerWorkThread: 1,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    const batch = {
      id: "batch_human_continuation",
      workstreamId: "workstream_default",
      items: [{
        itemId: "item_human_continuation",
        runId: "run_human_continuation_parent",
        workThreadId,
        event: {
          ...event,
          id: "evt_human_continuation_parent",
          sourceEventId: "comment_human_continuation_parent",
          receivedAt: "2026-07-26T00:20:00.000Z"
        }
      }]
    };
    expect((await app.request("/v1/workstream-batches", post(batch))).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    expect((await app.request(
      "/v1/runners/runner_1/runs/run_human_continuation_parent/complete",
      post({
        ...claim,
        result: {
          conclusion: "needs_human",
          summary: "A bounded decision is required.",
          humanEscalation: {
            class: "missing_input",
            audience: "requester",
            summary: "Choose the bounded target.",
            reason: "The target was not supplied.",
            options: [{ id: "staging", label: "Use staging", consequence: "Keeps the change in staging." }],
            dedupeKey: "target:v1"
          }
        }
      })
    )).status).toBe(200);
    const stored = await (await app.request("/v1/runs/run_human_continuation_parent")).json() as {
      run: { result: { humanEscalationId: string } };
    };
    const resolved = await app.request(
      `/v1/human-escalations/${stored.run.result.humanEscalationId}/resolve`,
      post({
        actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
        optionId: "staging",
        reason: "Use the bounded staging target. Bearer abcdefghijklmnop"
      })
    );
    expect(resolved.status).toBe(201);
    const resolvedBody = await resolved.json() as {
      continuation: { run: { id: string } };
      resume: { required: boolean };
    };
    expect(resolvedBody).toMatchObject({
      outcome: "resolved",
      continuation: {
        outcome: "created",
        decisions: [{ action: "eligible", reasonCode: "eligible" }],
        run: { parentRunId: "run_human_continuation_parent", triggeredByAction: { kind: "resume_work_thread" } }
      },
      resume: { required: false }
    });
    const storedChild = await (await app.request(`/v1/runs/${resolvedBody.continuation.run.id}`)).json() as {
      run: { triggeredByAction: { metadata: Record<string, unknown> } };
      event: { actor: { provider: string; providerUserId: string; handle: string }; context: Array<{ title?: string; uri: string }>; metadata: Record<string, unknown> };
    };
    expect(storedChild).toMatchObject({
      run: {
        triggeredByAction: {
          metadata: {
            humanEscalationId: stored.run.result.humanEscalationId,
            humanResolutionDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
          }
        }
      },
      event: {
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        metadata: {
          humanEscalationId: stored.run.result.humanEscalationId,
          humanResolutionDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        }
      }
    });
    const resolutionContext = storedChild.event.context.find((pointer) => pointer.title === "OpenTag human resolution");
    expect(resolutionContext?.uri).toContain("Selected option label: Use staging");
    expect(resolutionContext?.uri).toContain("Selected option consequence: Keeps the change in staging.");
    expect(resolutionContext?.uri).toContain("Resolution reason: Use the bounded staging target. Bearer [redacted]");
    expect(resolutionContext?.uri).not.toContain("abcdefghijklmnop");

    const childClaim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      run: { id: string };
      event: { context: Array<{ title?: string; uri: string }> };
    };
    expect(childClaim.run.id).toBe(resolvedBody.continuation.run.id);
    expect(childClaim.event.context.find((pointer) => pointer.title === "OpenTag human resolution")?.uri)
      .toContain("Selected option: staging");
  });

  it("uses newly ingested provider evidence as a trigger without treating it as completion", async () => {
    const { app, workThreadId } = await factorySetup({
      completionPolicies: [{ provider: "github", owner: "acme", repo: "demo", requiredChecks: ["build", "test"] }],
      continuation: {
        mode: "evidence_driven",
        triggers: ["completion_evidence_changed"],
        maxContinuationsPerWorkThread: 1,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    const batch = {
      id: "batch_evidence_continuation",
      workstreamId: "workstream_default",
      items: [{
        itemId: "item_evidence_continuation",
        runId: "run_evidence_continuation_parent",
        workThreadId,
        event: {
          ...event,
          id: "evt_evidence_continuation_parent",
          sourceEventId: "comment_evidence_continuation_parent",
          receivedAt: "2026-07-26T00:30:00.000Z"
        }
      }]
    };
    expect((await app.request("/v1/workstream-batches", post(batch))).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const failed = await app.request(
      "/v1/runners/runner_1/runs/run_evidence_continuation_parent/complete",
      post({
        ...claim,
        result: {
          conclusion: "failure",
          summary: "The implementation needs another bounded attempt.",
          createdPullRequestUrl: "https://github.com/acme/demo/pull/7"
        }
      })
    );
    await expect(failed.json()).resolves.toMatchObject({
      completion: { completion: "unsatisfied" },
      continuation: { outcome: "not_eligible", reasonCode: "trigger_not_enabled" }
    });

    const evidence = await app.request("/v1/completion-evidence/github", post({
      provider: "github",
      deliveryId: "delivery-evidence-continuation",
      eventName: "check_run",
      repository: { owner: "acme", repo: "demo" },
      pullRequest: {
        number: 7,
        resourceRef: "github:acme/demo:pull_request:7",
        headSha: "b".repeat(40),
        baseSha: "c".repeat(40),
        baseBranch: "main",
        state: "open"
      },
      checks: { build: "failed", test: "passed" },
      observedAt: "2026-07-26T00:31:00.000Z",
      payloadDigest: `sha256:${"e".repeat(64)}`
    }));
    expect(evidence.status).toBe(201);
    await expect(evidence.json()).resolves.toMatchObject({
      outcome: "recorded",
      workThreadId,
      completion: { completion: "unsatisfied", nextAction: { hint: { kind: "resume_work_thread" } } },
      continuation: {
        outcome: "created",
        trigger: { id: "github-evidence:delivery-evidence-continuation", kind: "completion_evidence_changed" },
        decisions: [{ action: "eligible", reasonCode: "eligible" }],
        run: { parentRunId: "run_evidence_continuation_parent", status: "queued" }
      }
    });
  });

  it.each([
    {
      provider: "slack",
      accountId: "T_CONTINUE",
      conversationId: "C_CONTINUE",
      metadata: { teamId: "T_CONTINUE", channelId: "C_CONTINUE" }
    },
    {
      provider: "lark",
      accountId: "tenant_continue",
      conversationId: "chat_continue",
      metadata: { tenantKey: "tenant_continue", chatId: "chat_continue" }
    }
  ])("inherits a verified managed $provider ownership attestation for automatic continuation", async ({
    provider,
    accountId,
    conversationId,
    metadata
  }) => {
    const credential = `${provider}_continuation_principal`;
    const applicationId = `${provider}_continuation_app`;
    const managedEvent = {
      ...event,
      id: `evt_${provider}_continuation_seed`,
      source: provider,
      sourceEventId: `message_${provider}_continuation_seed`,
      actor: { provider, providerUserId: "managed_user", handle: "alice" },
      context: [],
      callback: { provider, uri: `https://example.com/${provider}/callback`, threadKey: `${accountId}:${conversationId}` },
      metadata
    } as OpenTagEvent;
    const { app, workThreadId } = await factorySetup({
      seedEvent: managedEvent,
      channelPrincipals: [{ provider, applicationId, credential }],
      managedChannel: {
        binding: {
          provider,
          accountId,
          conversationId,
          ownership: { mode: "managed", exclusive: true, applicationId }
        },
        credential
      },
      continuation: {
        mode: "evidence_driven",
        triggers: ["retryable_run_failure"],
        maxContinuationsPerWorkThread: 1,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    const parentEvent = {
      ...managedEvent,
      id: `evt_${provider}_continuation_parent`,
      sourceEventId: `message_${provider}_continuation_parent`,
      receivedAt: "2026-07-26T00:40:00.000Z"
    };
    const admitted = await app.request("/v1/workstream-batches", {
      ...post({
        id: `batch_${provider}_continuation`,
        workstreamId: "workstream_default",
        items: [{
          itemId: `item_${provider}_continuation`,
          runId: `run_${provider}_continuation_parent`,
          workThreadId,
          event: parentEvent
        }]
      }),
      headers: { "content-type": "application/json", "x-opentag-channel-principal": credential }
    });
    expect(admitted.status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const completed = await app.request(
      `/v1/runners/runner_1/runs/run_${provider}_continuation_parent/complete`,
      post({
        ...claim,
        result: { conclusion: "failure", summary: "Retry the managed-channel work within policy." }
      })
    );
    await expect(completed.json()).resolves.toMatchObject({
      continuation: {
        outcome: "created",
        run: { status: "queued", parentRunId: `run_${provider}_continuation_parent` }
      }
    });
  });

  it("rejects managed-channel continuation after the owning application binding rotates", async () => {
    const credential = "slack_rotation_owner";
    const managedEvent = {
      ...event,
      id: "evt_slack_rotation_seed",
      source: "slack",
      sourceEventId: "message_slack_rotation_seed",
      actor: { provider: "slack", providerUserId: "U_ROTATE", handle: "alice" },
      context: [],
      callback: { provider: "slack", uri: "https://example.com/slack/callback", threadKey: "T_ROTATE:C_ROTATE" },
      metadata: { teamId: "T_ROTATE", channelId: "C_ROTATE" }
    } as OpenTagEvent;
    const { app, workThreadId } = await factorySetup({
      seedEvent: managedEvent,
      channelPrincipals: [
        { provider: "slack", applicationId: "A_OLD", credential },
        { provider: "slack", applicationId: "A_NEW", credential: "slack_rotation_new" }
      ],
      managedChannel: {
        binding: {
          provider: "slack",
          accountId: "T_ROTATE",
          conversationId: "C_ROTATE",
          ownership: { mode: "managed", exclusive: true, applicationId: "A_OLD" }
        },
        credential
      },
      continuation: {
        mode: "evidence_driven",
        triggers: ["retryable_run_failure"],
        maxContinuationsPerWorkThread: 1,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    expect((await app.request("/v1/workstream-batches", {
      ...post({
        id: "batch_slack_rotation",
        workstreamId: "workstream_default",
        items: [{
          itemId: "item_slack_rotation",
          runId: "run_slack_rotation_parent",
          workThreadId,
          event: {
            ...managedEvent,
            id: "evt_slack_rotation_parent",
            sourceEventId: "message_slack_rotation_parent",
            receivedAt: "2026-07-26T00:50:00.000Z"
          }
        }]
      }),
      headers: { "content-type": "application/json", "x-opentag-channel-principal": credential }
    })).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    expect((await app.request("/v1/channel-bindings/slack/T_ROTATE/C_ROTATE", {
      method: "DELETE",
      headers: { "x-opentag-channel-principal": credential }
    })).status).toBe(204);
    expect((await app.request("/v1/channel-bindings", {
      ...post({
        provider: "slack",
        accountId: "T_ROTATE",
        conversationId: "C_ROTATE",
        ownership: { mode: "managed", exclusive: true, applicationId: "A_NEW" }
      }),
      headers: { "content-type": "application/json", "x-opentag-channel-principal": "slack_rotation_new" }
    })).status).toBe(201);

    const completed = await app.request(
      "/v1/runners/runner_1/runs/run_slack_rotation_parent/complete",
      post({
        ...claim,
        result: { conclusion: "failure", summary: "Do not continue under a rotated owner." }
      })
    );
    await expect(completed.json()).resolves.toMatchObject({
      continuation: { outcome: "rejected", reasonCode: "managed_channel_ownership_unverified" }
    });
  });

  it("requires the current managed-channel principal before resolving and resuming human-blocked work", async () => {
    const ownerCredential = "slack_human_owner";
    const foreignCredential = "slack_human_foreign";
    const managedEvent = {
      ...event,
      id: "evt_slack_human_seed",
      source: "slack",
      sourceEventId: "message_slack_human_seed",
      actor: { provider: "slack", providerUserId: "U_OWNER", handle: "alice" },
      context: [],
      callback: { provider: "slack", uri: "https://example.com/slack/callback", threadKey: "T_HUMAN:C_HUMAN" },
      metadata: { teamId: "T_HUMAN", channelId: "C_HUMAN" }
    } as OpenTagEvent;
    const { app, workThreadId } = await factorySetup({
      seedEvent: managedEvent,
      channelPrincipals: [
        { provider: "slack", applicationId: "A_OWNER", credential: ownerCredential },
        { provider: "slack", applicationId: "A_FOREIGN", credential: foreignCredential }
      ],
      managedChannel: {
        binding: {
          provider: "slack",
          accountId: "T_HUMAN",
          conversationId: "C_HUMAN",
          ownership: { mode: "managed", exclusive: true, applicationId: "A_OWNER" }
        },
        credential: ownerCredential
      },
      continuation: {
        mode: "evidence_driven",
        triggers: ["human_escalation_resolved"],
        maxContinuationsPerWorkThread: 1,
        minIntervalSeconds: 0,
        backoff: { initialSeconds: 1, maxSeconds: 1 }
      }
    });
    expect((await app.request("/v1/workstream-batches", {
      ...post({
        id: "batch_slack_human",
        workstreamId: "workstream_default",
        items: [{
          itemId: "item_slack_human",
          runId: "run_slack_human_parent",
          workThreadId,
          event: {
            ...managedEvent,
            id: "evt_slack_human_parent",
            sourceEventId: "message_slack_human_parent",
            receivedAt: "2026-07-26T00:55:00.000Z"
          }
        }]
      }),
      headers: { "content-type": "application/json", "x-opentag-channel-principal": ownerCredential }
    })).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    expect((await app.request(
      "/v1/runners/runner_1/runs/run_slack_human_parent/complete",
      post({
        ...claim,
        result: {
          conclusion: "needs_human",
          summary: "Choose a managed target.",
          humanEscalation: {
            class: "missing_input",
            audience: "requester",
            summary: "Choose the managed target.",
            reason: "The target is missing.",
            options: [{ id: "staging", label: "Use staging", consequence: "Keeps the work bounded." }]
          }
        }
      })
    )).status).toBe(200);
    const storedParent = await (await app.request("/v1/runs/run_slack_human_parent")).json() as {
      run: { result: { humanEscalationId: string } };
    };
    const resolutionBody = {
      actor: { provider: "slack", providerUserId: "U_OWNER", handle: "alice" },
      optionId: "staging",
      reason: "Use the bounded managed target."
    };
    const foreign = await app.request(
      `/v1/human-escalations/${storedParent.run.result.humanEscalationId}/resolve`,
      {
        ...post(resolutionBody),
        headers: { "content-type": "application/json", "x-opentag-channel-principal": foreignCredential }
      }
    );
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toEqual({ error: "managed_channel_principal_required" });

    const owner = await app.request(
      `/v1/human-escalations/${storedParent.run.result.humanEscalationId}/resolve`,
      {
        ...post(resolutionBody),
        headers: { "content-type": "application/json", "x-opentag-channel-principal": ownerCredential }
      }
    );
    expect(owner.status).toBe(201);
    await expect(owner.json()).resolves.toMatchObject({
      outcome: "resolved",
      continuation: { outcome: "created", run: { parentRunId: "run_slack_human_parent" } },
      resume: { required: false }
    });
  });

  it.each([
    {
      provider: "slack",
      accountId: "T_ADMISSION",
      conversationId: "C_ADMISSION",
      metadata: { teamId: "T_ADMISSION", channelId: "C_ADMISSION" }
    },
    {
      provider: "lark",
      accountId: "tenant_admission",
      conversationId: "chat_admission",
      metadata: { tenantKey: "tenant_admission", chatId: "chat_admission" }
    }
  ])("fails closed for runless managed $provider admission escalations", async ({
    provider,
    accountId,
    conversationId,
    metadata
  }) => {
    async function setupAdmissionEscalation(suffix: string) {
      const ownerCredential = `${provider}_${suffix}_owner`;
      const foreignCredential = `${provider}_${suffix}_foreign`;
      const rotatedCredential = `${provider}_${suffix}_rotated`;
      const ownerApplicationId = `${provider}_${suffix}_app_owner`;
      const rotatedApplicationId = `${provider}_${suffix}_app_rotated`;
      let deny = false;
      const managedEvent = {
        ...event,
        id: `evt_${provider}_${suffix}_seed`,
        source: provider,
        sourceEventId: `message_${provider}_${suffix}_seed`,
        actor: { provider, providerUserId: "managed_owner", handle: "alice" },
        context: [],
        callback: {
          provider,
          uri: `https://example.com/${provider}/callback`,
          threadKey: `${accountId}:${conversationId}`
        },
        metadata: { ...metadata, repoProvider: "github", owner: "acme", repo: "demo" }
      } as OpenTagEvent;
      const { app } = await factorySetup({
        seedEvent: managedEvent,
        agentAccessProfileCheck: async () => deny
          ? { allowed: false, reason: "A human must approve this managed admission.", reasonCode: "agent_access_profile_denied" }
          : { allowed: true },
        channelPrincipals: [
          { provider, applicationId: ownerApplicationId, credential: ownerCredential },
          { provider, applicationId: `${provider}_${suffix}_app_foreign`, credential: foreignCredential },
          { provider, applicationId: rotatedApplicationId, credential: rotatedCredential }
        ],
        managedChannel: {
          binding: {
            provider,
            accountId,
            conversationId,
            repoProvider: "github",
            owner: "acme",
            repo: "demo",
            ownership: { mode: "managed", exclusive: true, applicationId: ownerApplicationId }
          },
          credential: ownerCredential
        }
      });
      deny = true;
      const admission = await app.request("/v1/runs", {
        ...post({
          runId: `run_${provider}_${suffix}_admission_denied`,
          event: {
            ...managedEvent,
            id: `evt_${provider}_${suffix}_admission_denied`,
            sourceEventId: `message_${provider}_${suffix}_admission_denied`,
            receivedAt: "2026-07-26T00:58:00.000Z"
          }
        }),
        headers: {
          "content-type": "application/json",
          "x-opentag-channel-principal": ownerCredential
        }
      });
      expect(admission.status).toBe(202);
      const admissionBody = await admission.json() as {
        escalation: {
          id: string;
          runId?: string;
          sourceAuthority?: {
            provider: string;
            accountId: string;
            conversationId: string;
            ownership: { applicationId: string };
            bindingDigest: string;
          };
        };
      };
      expect(admissionBody.escalation).toMatchObject({
        sourceAuthority: {
          provider,
          accountId,
          conversationId,
          ownership: { applicationId: ownerApplicationId },
          bindingDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        }
      });
      expect(admissionBody.escalation).not.toHaveProperty("runId");
      return {
        app,
        escalationId: admissionBody.escalation.id,
        ownerCredential,
        foreignCredential,
        rotatedCredential,
        rotatedApplicationId
      };
    }

    const current = await setupAdmissionEscalation("current");
    const actor = { provider, providerUserId: "managed_owner", handle: "alice" };
    const missing = await current.app.request(
      `/v1/human-escalations/${current.escalationId}/acknowledge`,
      post({ actor })
    );
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toEqual({ error: "managed_channel_principal_required" });
    const foreign = await current.app.request(
      `/v1/human-escalations/${current.escalationId}/resolve`,
      {
        ...post({ actor, reason: "A foreign app must not resolve this escalation." }),
        headers: { "content-type": "application/json", "x-opentag-channel-principal": current.foreignCredential }
      }
    );
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toEqual({ error: "managed_channel_principal_required" });
    const owner = await current.app.request(
      `/v1/human-escalations/${current.escalationId}/resolve`,
      {
        ...post({ actor, reason: "The current managed owner approved admission." }),
        headers: { "content-type": "application/json", "x-opentag-channel-principal": current.ownerCredential }
      }
    );
    expect(owner.status).toBe(201);
    const ownerBody = await owner.json() as { outcome: string; escalation: Record<string, unknown> };
    expect(ownerBody).toMatchObject({ outcome: "resolved" });
    expect(ownerBody.escalation).not.toHaveProperty("runId");

    const source = await setupAdmissionEscalation("source");
    const foreignSource = await source.app.request("/v1/thread-actions", {
      ...post({
        rawText: `@opentag /resolve ${source.escalationId} --reason Foreign source adapter`,
        actor,
        callback: {
          provider,
          uri: `https://example.com/${provider}/callback`,
          threadKey: `${accountId}:${conversationId}`
        },
        metadata: { ...metadata, repoProvider: "github", owner: "acme", repo: "demo" }
      }),
      headers: {
        "content-type": "application/json",
        "x-opentag-channel-principal": source.foreignCredential
      }
    });
    expect(foreignSource.status).toBe(200);
    await expect(foreignSource.json()).resolves.toEqual({
      outcome: "rejected",
      escalationId: source.escalationId,
      reasonCode: "managed_channel_principal_required"
    });
    const ownerSource = await source.app.request("/v1/thread-actions", {
      ...post({
        rawText: `@opentag /resolve ${source.escalationId} --reason Current source adapter owner`,
        actor,
        callback: {
          provider,
          uri: `https://example.com/${provider}/callback`,
          threadKey: `${accountId}:${conversationId}`
        },
        metadata: { ...metadata, repoProvider: "github", owner: "acme", repo: "demo" }
      }),
      headers: {
        "content-type": "application/json",
        "x-opentag-channel-principal": source.ownerCredential
      }
    });
    expect(ownerSource.status).toBe(200);
    await expect(ownerSource.json()).resolves.toMatchObject({
      outcome: "resolved",
      escalation: { id: source.escalationId, state: "resolved" },
      resume: {
        required: true,
        nextAction: "Wait for durable WorkLoop completion evidence before requesting continuation."
      }
    });

    const rotated = await setupAdmissionEscalation("rotated");
    expect((await rotated.app.request(`/v1/channel-bindings/${provider}/${accountId}/${conversationId}`, {
      method: "DELETE",
      headers: { "x-opentag-channel-principal": rotated.ownerCredential }
    })).status).toBe(204);
    expect((await rotated.app.request("/v1/channel-bindings", {
      ...post({
        provider,
        accountId,
        conversationId,
        ownership: {
          mode: "managed",
          exclusive: true,
          applicationId: rotated.rotatedApplicationId
        }
      }),
      headers: {
        "content-type": "application/json",
        "x-opentag-channel-principal": rotated.rotatedCredential
      }
    })).status).toBe(201);
    const afterRotation = await rotated.app.request(
      `/v1/human-escalations/${rotated.escalationId}/resolve`,
      {
        ...post({ actor, reason: "A rotated binding must not inherit the old escalation." }),
        headers: { "content-type": "application/json", "x-opentag-channel-principal": rotated.rotatedCredential }
      }
    );
    expect(afterRotation.status).toBe(403);
    await expect(afterRotation.json()).resolves.toEqual({ error: "managed_channel_authority_changed" });
  });

  it("keeps single-run behavior and admits an ordered quiet replay-safe batch", async () => {
    const callbackMessages: CallbackMessage[] = [];
    const sourceReceipts: SourceReceipt[] = [];
    const { app, workThreadId } = await factorySetup({ callbackMessages, sourceReceipts });
    callbackMessages.length = 0;
    sourceReceipts.length = 0;

    const batch = {
      id: "batch_1",
      workstreamId: "workstream_default",
      items: [{
        itemId: "item_1",
        runId: "run_batch_1",
        workThreadId,
        event: { ...event, id: "evt_batch_1", sourceEventId: "comment_batch_1", receivedAt: "2026-07-26T00:01:00.000Z" }
      }]
    };
    const admitted = await app.request("/v1/workstream-batches", post(batch));
    expect(admitted.status).toBe(201);
    const responseBody = await admitted.json() as { receipt: { result: unknown } };
    expect(responseBody.receipt).toMatchObject({
      status: "completed",
      batch: { id: "batch_1", workstreamId: "workstream_default" },
      items: [{ itemId: "item_1", index: 0, runId: "run_batch_1", status: "completed" }],
      result: {
        batchId: "batch_1",
        workstreamId: "workstream_default",
        results: [{ itemId: "item_1", index: 0, runId: "run_batch_1", admittedRunId: "run_batch_1", status: "created" }],
        summary: { totalItems: 1, createdCount: 1, exceptionCount: 0, exceptions: [], omittedExceptionCount: 0 }
      }
    });
    expect(callbackMessages).toEqual([]);
    expect(sourceReceipts).toEqual([]);

    const replay = await app.request("/v1/workstream-batches", post(batch));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(responseBody);
    const durable = await app.request("/v1/workstream-batches/batch_1");
    await expect(durable.json()).resolves.toEqual(responseBody);

    const conflicting = await app.request("/v1/workstream-batches", post({
      ...batch,
      items: [{ ...batch.items[0], event: { ...batch.items[0].event, command: { ...batch.items[0].event.command, rawText: "different" } } }]
    }));
    expect(conflicting.status).toBe(409);
    await expect(conflicting.json()).resolves.toEqual({ error: "workstream_batch_conflict" });

    expect((await app.request("/v1/workstreams/workstream_default/metrics")).status).toBe(200);
    expect((await app.request("/v1/workstreams/workstream_default/evaluation")).status).toBe(200);
    const audit = await app.request("/v1/control-plane-events?type=workstream.batch.exceptions");
    const auditBody = await audit.json() as { events: unknown[] };
    expect(auditBody.events).toHaveLength(1);
  });

  it("rejects strict bodies and work-thread membership mismatches", async () => {
    const { app, workThreadId } = await factorySetup();
    const invalid = await app.request("/v1/workstream-batches", post({
      id: "batch_extra",
      workstreamId: "workstream_default",
      items: [{ itemId: "item_extra", runId: "run_extra", workThreadId, event }],
      extra: true
    }));
    expect(invalid.status).toBe(400);

    const mismatch = await app.request("/v1/workstream-batches", post({
      id: "batch_mismatch",
      workstreamId: "workstream_default",
      items: [{ itemId: "item_mismatch", runId: "run_mismatch", workThreadId: "thread_missing", event }]
    }));
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toEqual({ error: "workstream_member_mismatch", workThreadId: "thread_missing" });
  });

  it("preserves factory attribution when a queued batch follow-up is promoted", async () => {
    const { app, workThreadId } = await factorySetup();
    expect((await app.request("/v1/runs", post({
      runId: "run_active_before_batch",
      event: {
        ...event,
        id: "evt_active_before_batch",
        sourceEventId: "comment_active_before_batch",
        receivedAt: "2026-07-26T00:01:00.000Z"
      }
    }))).status).toBe(201);
    expect((await app.request("/v1/runners/runner_1/claim", { method: "POST" })).status).toBe(200);
    const batch = {
      id: "batch_follow_up",
      workstreamId: "workstream_default",
      items: [{
        itemId: "item_follow_up",
        runId: "follow_up_batch_queued",
        workThreadId,
        event: {
          ...event,
          id: "evt_batch_follow_up",
          sourceEventId: "comment_batch_follow_up",
          receivedAt: "2026-07-26T00:03:00.000Z"
        }
      }]
    };

    const admitted = await app.request("/v1/workstream-batches", post(batch));
    expect(admitted.status).toBe(201);
    await expect(admitted.json()).resolves.toMatchObject({
      receipt: {
        result: {
          results: [
            { itemId: "item_follow_up", status: "follow_up_queued", followUpRequestId: "follow_up_batch_queued" }
          ]
        }
      }
    });

    const queued = await app.request("/v1/follow-up-requests/follow_up_batch_queued");
    await expect(queued.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_batch_queued",
        workstreamId: "workstream_default",
        admissionBatchId: "batch_follow_up"
      }
    });

    const promoted = await app.request("/v1/follow-up-requests/follow_up_batch_queued/create-run", post({
      runId: "run_promoted_from_batch"
    }));
    expect(promoted.status).toBe(201);
    await expect(promoted.json()).resolves.toMatchObject({
      run: { id: "run_promoted_from_batch", parentRunId: "run_active_before_batch" }
    });

    const metrics = await app.request("/v1/workstreams/workstream_default/metrics");
    await expect(metrics.json()).resolves.toMatchObject({ metrics: { runCount: 1 } });
  });

  it("keeps needs-human decisions durable and bounds the quiet exception summary", async () => {
    let deny = false;
    const callbackMessages: CallbackMessage[] = [];
    const sourceReceipts: SourceReceipt[] = [];
    const { app, workThreadId } = await factorySetup({
      callbackMessages,
      sourceReceipts,
      agentAccessProfileCheck: async () => deny
        ? { allowed: false, reason: "access denied", reasonCode: "agent_access_profile_denied" }
        : { allowed: true }
    });
    callbackMessages.length = 0;
    sourceReceipts.length = 0;
    deny = true;

    const items = Array.from({ length: 12 }, (_, index) => ({
      itemId: `item_denied_${index}`,
      runId: `run_denied_${index}`,
      workThreadId,
      event: {
        ...event,
        id: `evt_denied_${index}`,
        sourceEventId: `comment_denied_${index}`,
        receivedAt: `2026-07-26T00:${String(index + 1).padStart(2, "0")}:00.000Z`
      }
    }));
    const response = await app.request("/v1/workstream-batches", post({
      id: "batch_denied",
      workstreamId: "workstream_default",
      items
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as {
      receipt: { result: { results: Array<{ status: string; humanEscalationId?: string }>; summary: Record<string, unknown> } };
    };
    expect(body.receipt.result.summary).toMatchObject({
      totalItems: 12,
      needsHumanDecisionCount: 12,
      exceptionCount: 12,
      omittedExceptionCount: 2,
      exceptions: expect.arrayContaining([expect.objectContaining({ status: "needs_human_decision" })])
    });
    expect((body.receipt.result.summary["exceptions"] as unknown[])).toHaveLength(10);
    expect(body.receipt.result.results).toHaveLength(12);
    expect(body.receipt.result.results.every((item) => item.status === "needs_human_decision" && item.humanEscalationId)).toBe(true);
    expect(callbackMessages).toEqual([]);
    expect(sourceReceipts).toEqual([]);
  });

  it("renews the batch and current item leases during a slow admission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-workstream-heartbeat-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    let delayAdmission = false;
    let releaseAdmission: (() => void) | undefined;
    let signalAdmissionStarted: (() => void) | undefined;
    const admissionStarted = new Promise<void>((resolve) => {
      signalAdmissionStarted = resolve;
    });
    const admissionRelease = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    try {
      const { app, workThreadId } = await factorySetup({
        databasePath,
        agentAccessProfileCheck: async () => {
          if (delayAdmission) {
            signalAdmissionStarted?.();
            await admissionRelease;
          }
          return { allowed: true };
        }
      });
      delayAdmission = true;
      const batch = {
        id: "batch_heartbeat",
        workstreamId: "workstream_default",
        items: [{
          itemId: "item_heartbeat",
          runId: "run_heartbeat",
          workThreadId,
          event: {
            ...event,
            id: "evt_heartbeat",
            sourceEventId: "comment_heartbeat",
            receivedAt: "2026-07-26T00:01:00.000Z"
          }
        }]
      };

      const admission = app.request("/v1/workstream-batches", post(batch));
      await admissionStarted;
      await vi.advanceTimersByTimeAsync(301_000);

      const competingDispatcher = createDispatcherApp({ databasePath });
      const competing = await competingDispatcher.request("/v1/workstream-batches", post(batch));
      expect(competing.status).toBe(200);
      await expect(competing.json()).resolves.toMatchObject({
        receipt: {
          status: "processing",
          items: [{ itemId: "item_heartbeat", status: "processing" }]
        }
      });

      releaseAdmission?.();
      const completed = await admission;
      expect(completed.status).toBe(201);
      await expect(completed.json()).resolves.toMatchObject({
        receipt: { status: "completed", result: { batchId: "batch_heartbeat" } }
      });
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resumes an expired processing item without creating a second run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-workstream-batch-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    try {
      const { app, workThreadId } = await factorySetup({ databasePath });
      const batch = {
        id: "batch_resume",
        workstreamId: "workstream_default",
        items: [{
          itemId: "item_resume",
          runId: "run_resume",
          workThreadId,
          event: { ...event, id: "evt_resume", sourceEventId: "comment_resume", receivedAt: "2026-07-26T00:20:00.000Z" }
        }]
      };
      expect((await app.request("/v1/workstream-batches", post(batch))).status).toBe(201);

      const sqlite = new Database(databasePath);
      try {
        sqlite.prepare(`UPDATE workstream_admission_batches
          SET status = 'processing', lease_owner = 'live_dispatcher', lease_expires_at = '2999-01-01T00:00:00.000Z',
              result_json = NULL, completed_at = NULL
          WHERE id = ?`).run(batch.id);
      } finally {
        sqlite.close();
      }
      const activeLease = await app.request("/v1/workstream-batches", post(batch));
      expect(activeLease.status).toBe(200);
      await expect(activeLease.json()).resolves.toMatchObject({
        receipt: { batch: { id: "batch_resume" }, status: "processing" }
      });

      const expiredSqlite = new Database(databasePath);
      try {
        expiredSqlite.prepare(`UPDATE workstream_admission_batches
          SET lease_owner = 'dead_dispatcher', lease_expires_at = '2000-01-01T00:00:00.000Z'
          WHERE id = ?`).run(batch.id);
        expiredSqlite.prepare(`UPDATE workstream_admission_batch_items
          SET status = 'processing', lease_owner = 'dead_dispatcher', lease_expires_at = '2000-01-01T00:00:00.000Z',
              result_json = NULL, completed_at = NULL
          WHERE batch_id = ? AND item_id = ?`).run(batch.id, "item_resume");
      } finally {
        expiredSqlite.close();
      }

      const resumed = await app.request("/v1/workstream-batches", post(batch));
      expect(resumed.status).toBe(200);
      await expect(resumed.json()).resolves.toMatchObject({
        receipt: {
          status: "completed",
          result: {
            results: [{
              itemId: "item_resume",
              runId: "run_resume",
              admittedRunId: "run_resume",
              status: "idempotent_replay"
            }]
          }
        }
      });
      const metrics = await app.request("/v1/workstreams/workstream_default/metrics");
      await expect(metrics.json()).resolves.toMatchObject({ metrics: { runCount: 1 } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconstructs the same durable receipt and deterministic evaluation after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-workstream-replay-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    const completionNow = () => "2026-07-26T00:30:00.000Z";
    try {
      const { app, workThreadId } = await factorySetup({ databasePath, completionNow });
      const batch = {
        id: "batch_restart_replay",
        workstreamId: "workstream_default",
        items: [{
          itemId: "item_restart_replay",
          runId: "run_restart_replay",
          workThreadId,
          event: {
            ...event,
            id: "evt_restart_replay",
            sourceEventId: "comment_restart_replay",
            receivedAt: "2026-07-26T00:29:00.000Z"
          }
        }]
      };
      expect((await app.request("/v1/workstream-batches", post(batch))).status).toBe(201);
      const beforeReceipt = await (await app.request("/v1/workstream-batches/batch_restart_replay")).json();
      const beforeEvaluation = await (await app.request("/v1/workstreams/workstream_default/evaluation")).json();

      const recovered = createDispatcherApp({ databasePath, completionNow });
      const afterReceipt = await (await recovered.request("/v1/workstream-batches/batch_restart_replay")).json();
      const afterEvaluation = await (await recovered.request("/v1/workstreams/workstream_default/evaluation")).json();

      expect(afterReceipt).toEqual(beforeReceipt);
      expect(afterEvaluation).toEqual(beforeEvaluation);
      await expect(recovered.request("/v1/workstream-batches", post(batch)).then((response) => response.json()))
        .resolves.toEqual(beforeReceipt);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
