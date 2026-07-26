import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

async function factorySetup(input: {
  callbackMessages?: CallbackMessage[];
  sourceReceipts?: SourceReceipt[];
  agentAccessProfileCheck?: Parameters<typeof createDispatcherApp>[0]["agentAccessProfileCheck"];
  completionNow?: Parameters<typeof createDispatcherApp>[0]["completionNow"];
  databasePath?: string;
} = {}) {
  const app = createDispatcherApp({
    databasePath: input.databasePath ?? ":memory:",
    callbackSink: { async deliver(message) { input.callbackMessages?.push(message); } },
    sourceReceiptSink: { async deliver(receipt) { input.sourceReceipts?.push(receipt); return { delivered: true }; } },
    ...(input.agentAccessProfileCheck ? { agentAccessProfileCheck: input.agentAccessProfileCheck } : {}),
    ...(input.completionNow ? { completionNow: input.completionNow } : {})
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
  const seedResponse = await app.request("/v1/runs", post({ runId: "run_seed", event }));
  expect(seedResponse.status).toBe(201);
  const seed = await seedResponse.json() as { run: { thread: { id: string } } };
  expect((await app.request("/v1/runs/run_seed/cancel", post({ reason: "factory setup" }))).status).toBe(200);

  const recipe = {
    id: "recipe_default",
    version: 1,
    name: "Default workstream",
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
