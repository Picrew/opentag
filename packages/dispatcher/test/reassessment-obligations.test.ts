import type { WorkThread } from "@opentag/core";
import { createOpenTagRepository, migrateSchema } from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDispatcherApp } from "../src/server.js";
import { createReassessmentObligationWorker } from "../src/reassessment-obligations.js";

const timestamp = "2026-08-04T08:00:00.000Z";

function thread(suffix: string): WorkThread {
  return {
    workItemReference: {
      provider: "github",
      kind: "issue",
      externalId: `acme/demo#${suffix}`,
      uri: `https://github.com/acme/demo/issues/${suffix}`,
      ownerContainer: {
        provider: "github",
        id: "acme/demo",
        uri: "https://github.com/acme/demo"
      }
    },
    primaryAnchor: {
      provider: "github",
      kind: "issue_comment",
      externalId: `comment-${suffix}`,
      uri: `https://github.com/acme/demo/issues/${suffix}#issuecomment-${suffix}`,
      threadKey: `acme/demo#${suffix}`
    }
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function repository(databasePath = ":memory:") {
  const sqlite = new Database(databasePath);
  migrateSchema(sqlite);
  return { sqlite, repo: createOpenTagRepository(drizzle(sqlite)) };
}

function post(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 50
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe("dispatcher reassessment obligation worker", () => {
  it("isolates a retryable failure and continues with the next obligation", async () => {
    const { repo } = repository();
    const firstThread = (await repo.upsertWorkThread({ thread: thread("1") })).thread;
    const secondThread = (await repo.upsertWorkThread({ thread: thread("2") })).thread;
    await repo.enqueueReassessmentObligation({
      workThreadId: firstThread.id,
      sourceKind: "run_result_recorded",
      sourceId: "run-poisoned",
      sourceDigest: digest("a"),
      notBefore: timestamp,
      createdAt: timestamp
    });
    await repo.enqueueReassessmentObligation({
      workThreadId: secondThread.id,
      sourceKind: "run_result_recorded",
      sourceId: "run-healthy",
      sourceDigest: digest("b"),
      notBefore: timestamp,
      createdAt: timestamp
    });
    const worker = createReassessmentObligationWorker({
      repo,
      leaseOwner: "dispatcher-test",
      now: () => new Date(timestamp),
      retryBaseMs: 1_000,
      async process(obligation) {
        if (obligation.sourceId === "run-poisoned") throw new Error("fixture processor failure");
        return { outcome: "satisfied", reasonCode: "continuation_terminal" };
      }
    });

    const report = await worker.drainDue();

    expect(report).toMatchObject({ claimed: 2, satisfied: 1, rescheduled: 1, blocked: 0 });
    await expect(repo.listReassessmentObligations({ workThreadId: firstThread.id })).resolves.toMatchObject([
      {
        state: "pending",
        attemptCount: 1,
        lastReasonCode: "reassessment_failed",
        lastError: "fixture processor failure",
        notBefore: "2026-08-04T08:00:01.000Z"
      }
    ]);
    await expect(repo.listReassessmentObligations({ workThreadId: secondThread.id })).resolves.toMatchObject([
      { state: "satisfied", attemptCount: 1, lastReasonCode: "continuation_terminal" }
    ]);
  });

  it("waits for an in-flight fenced delivery when the worker stops", async () => {
    const { repo } = repository();
    const storedThread = (await repo.upsertWorkThread({ thread: thread("draining-stop") })).thread;
    await repo.enqueueReassessmentObligation({
      workThreadId: storedThread.id,
      sourceKind: "run_result_recorded",
      sourceId: "run-draining-stop",
      sourceDigest: digest("f"),
      notBefore: timestamp,
      createdAt: timestamp
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const processingStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = createReassessmentObligationWorker({
      repo,
      leaseOwner: "dispatcher-stop-test",
      pollIntervalMs: 10,
      now: () => new Date(timestamp),
      async process() {
        started();
        await released;
        return { outcome: "satisfied", reasonCode: "continuation_terminal" };
      }
    });
    worker.start();
    await processingStarted;

    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;

    await expect(repo.listReassessmentObligations({ workThreadId: storedThread.id })).resolves.toMatchObject([
      { state: "satisfied", attemptCount: 1 }
    ]);
  });

  it("does not process a future obligation until its durable notBefore", async () => {
    const { repo } = repository();
    const storedThread = (await repo.upsertWorkThread({ thread: thread("future") })).thread;
    await repo.enqueueReassessmentObligation({
      workThreadId: storedThread.id,
      sourceKind: "continuation_not_before",
      sourceId: "continuation-future",
      sourceDigest: digest("c"),
      notBefore: "2026-08-04T08:01:00.000Z",
      createdAt: timestamp
    });
    let now = new Date(timestamp);
    let processed = 0;
    const worker = createReassessmentObligationWorker({
      repo,
      leaseOwner: "dispatcher-test",
      now: () => now,
      async process() {
        processed += 1;
        return { outcome: "satisfied", reasonCode: "continuation_terminal" };
      }
    });

    await expect(worker.drainDue()).resolves.toMatchObject({ claimed: 0 });
    expect(processed).toBe(0);
    now = new Date("2026-08-04T08:01:00.000Z");
    await expect(worker.drainDue()).resolves.toMatchObject({ claimed: 1, satisfied: 1 });
    expect(processed).toBe(1);
  });

  it("stops polling and waits for background work before dispatcher disposal completes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-reassessment-stop-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    const app = createDispatcherApp({
      databasePath,
      reassessmentObligations: { pollIntervalMs: 10 }
    });
    await app.stopBackgroundWorkers();

    const seeded = repository(databasePath);
    const storedThread = (await seeded.repo.upsertWorkThread({ thread: thread("stopped") })).thread;
    await seeded.repo.enqueueReassessmentObligation({
      workThreadId: storedThread.id,
      sourceKind: "continuation_not_before",
      sourceId: "continuation-after-stop",
      sourceDigest: digest("d"),
      notBefore: timestamp,
      createdAt: timestamp
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    await expect(seeded.repo.listReassessmentObligations({ workThreadId: storedThread.id })).resolves.toMatchObject([
      { state: "pending", attemptCount: 0 }
    ]);
    seeded.sqlite.close();
  });

  it("reassesses a committed Run result after restart without replaying completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-reassessment-restart-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    const seeded = repository(databasePath);
    const event = {
      id: "event-restart",
      source: "github" as const,
      sourceEventId: "delivery-restart",
      receivedAt: timestamp,
      actor: { provider: "github", providerUserId: "user-1", handle: "octocat" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "fix", intent: "fix", args: {} },
      context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/99", visibility: "public" as const }],
      workItem: thread("99").workItemReference,
      permissions: [],
      callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/99/comments" },
      metadata: { owner: "acme", repo: "demo", issueNumber: 99 }
    };
    await seeded.repo.createRun({ id: "run-restart", event });
    await seeded.repo.completeRun({
      runId: "run-restart",
      result: { conclusion: "success", summary: "durable result" }
    });
    expect(seeded.sqlite.prepare("SELECT COUNT(*) AS count FROM completion_assessments").get()).toEqual({ count: 0 });
    expect(seeded.sqlite.prepare("SELECT state FROM reassessment_obligations").get()).toEqual({ state: "pending" });
    seeded.sqlite.close();

    createDispatcherApp({ databasePath, reassessmentObligations: { pollIntervalMs: 10 } });
    const observer = new Database(databasePath);
    await waitFor(
      () => (observer.prepare("SELECT state FROM reassessment_obligations").get() as { state?: string } | undefined)?.state === "satisfied",
      "restart did not satisfy the pending reassessment obligation"
    );

    expect(observer.prepare("SELECT COUNT(*) AS count FROM completion_assessments").get()).toEqual({ count: 1 });
    expect(observer.prepare("SELECT state, attempt_count AS attemptCount, satisfied_assessment_id AS assessmentId FROM reassessment_obligations").get())
      .toMatchObject({ state: "satisfied", attemptCount: 1, assessmentId: expect.any(String) });
    observer.close();
  });

  it("recovers committed provider evidence from the pre-reassessment crash window", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-reassessment-evidence-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    const app = createDispatcherApp({
      databasePath,
      completionPolicies: [{ provider: "github", owner: "acme", repo: "demo", requiredChecks: ["build", "test"] }],
      reassessmentObligations: { autoStart: false, inline: false, pollIntervalMs: 10 }
    });
    expect((await app.request("/v1/runners", post({ runnerId: "runner-1", name: "Local Runner" }))).status).toBe(201);
    expect((await app.request("/v1/repo-bindings", post({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner-1",
      workspacePath: "/tmp/acme-demo",
      defaultExecutor: "echo"
    }))).status).toBe(201);
    expect((await app.request("/v1/runs", post({
      runId: "run-evidence-crash",
      event: {
        id: "event-evidence-crash",
        source: "github",
        sourceEventId: "comment-evidence-crash",
        receivedAt: timestamp,
        actor: { provider: "github", providerUserId: "user-1", handle: "octocat", writeAccess: true },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "fix", intent: "fix", args: {} },
        context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/100", visibility: "public" }],
        workItem: thread("100").workItemReference,
        permissions: [],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/100/comments" },
        metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 100 }
      }
    }))).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner-1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    expect((await app.request("/v1/runners/runner-1/runs/run-evidence-crash/complete", post({
      ...claim,
      result: {
        conclusion: "success",
        summary: "implementation complete",
        createdPullRequestUrl: "https://github.com/acme/demo/pull/7"
      }
    }))).status).toBe(200);
    const evidence = await app.request("/v1/completion-evidence/github", post({
      provider: "github",
      deliveryId: "delivery-evidence-crash",
      eventName: "pull_request",
      repository: { owner: "acme", repo: "demo" },
      pullRequest: {
        number: 7,
        resourceRef: "github:acme/demo:pull_request:7",
        headSha: "b".repeat(40),
        baseSha: "c".repeat(40),
        baseBranch: "main",
        state: "merged"
      },
      checks: { build: "passed", test: "passed" },
      observedAt: "2026-08-04T08:05:00.000Z",
      payloadDigest: digest("e")
    }));
    expect(evidence.status).toBe(201);
    await expect(evidence.json()).resolves.toMatchObject({
      outcome: "recorded",
      completion: { completion: "pending", currentAssessment: { state: "pending", sequence: 1 } }
    });

    const observer = new Database(databasePath);
    expect(observer.prepare(`
      SELECT state FROM reassessment_obligations
      WHERE source_kind = 'verification_evidence_attached'
    `).get()).toEqual({ state: "pending" });
    expect(observer.prepare("SELECT state FROM completion_assessments ORDER BY sequence DESC LIMIT 1").get())
      .toEqual({ state: "pending" });

    createDispatcherApp({
      databasePath,
      completionPolicies: [{ provider: "github", owner: "acme", repo: "demo", requiredChecks: ["build", "test"] }],
      reassessmentObligations: { pollIntervalMs: 10 }
    });
    await waitFor(
      () => (observer.prepare(`
        SELECT state FROM reassessment_obligations
        WHERE source_kind = 'verification_evidence_attached'
      `).get() as { state?: string } | undefined)?.state === "satisfied",
      "restart did not satisfy the provider-evidence obligation"
    );
    expect(observer.prepare("SELECT state FROM completion_assessments ORDER BY sequence DESC LIMIT 1").get())
      .toEqual({ state: "satisfied" });
    const assessmentCount = (observer.prepare("SELECT COUNT(*) AS count FROM completion_assessments").get() as { count: number }).count;
    const obligationCount = (observer.prepare(`
      SELECT COUNT(*) AS count FROM reassessment_obligations
      WHERE source_kind = 'verification_evidence_attached'
    `).get() as { count: number }).count;

    createDispatcherApp({
      databasePath,
      completionPolicies: [{ provider: "github", owner: "acme", repo: "demo", requiredChecks: ["build", "test"] }],
      reassessmentObligations: { pollIntervalMs: 10 }
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(observer.prepare("SELECT COUNT(*) AS count FROM completion_assessments").get()).toEqual({ count: assessmentCount });
    expect(observer.prepare(`
      SELECT COUNT(*) AS count FROM reassessment_obligations
      WHERE source_kind = 'verification_evidence_attached'
    `).get()).toEqual({ count: obligationCount });
    observer.close();
  }, 10_000);
});
