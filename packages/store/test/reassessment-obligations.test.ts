import type { OpenTagEvent, WorkThread } from "@opentag/core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createOpenTagRepository } from "../src/repository.js";
import { migrateSchema } from "../src/schema.js";

const timestamp = "2026-08-04T08:00:00.000Z";

function workThread(suffix = "42"): WorkThread {
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

function githubEvent(): OpenTagEvent {
  return {
    id: "event-1",
    source: "github",
    sourceEventId: "delivery-1",
    receivedAt: timestamp,
    actor: { provider: "github", providerUserId: "user-1", handle: "octocat" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "fix", intent: "fix", args: {} },
    context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/42", visibility: "public" }],
    workItem: workThread().workItemReference,
    permissions: [],
    callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/42/comments" },
    metadata: { owner: "acme", repo: "demo", issueNumber: 42 }
  };
}

function fixture() {
  const sqlite = new Database(":memory:");
  migrateSchema(sqlite);
  return { sqlite, repo: createOpenTagRepository(drizzle(sqlite)) };
}

async function threadFixture() {
  const value = fixture();
  const thread = (await value.repo.upsertWorkThread({ thread: workThread() })).thread;
  return { ...value, workThreadId: thread.id };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

describe("reassessment obligation persistence", () => {
  it("migrates the durable queue and its replay and due indexes idempotently", () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    sqlite.exec(`
      DROP TABLE reassessment_obligations;
      DELETE FROM opentag_schema_migrations
        WHERE id = '2026-08-04-reassessment-obligations-v1';
    `);

    expect(() => migrateSchema(sqlite)).not.toThrow();
    expect(() => migrateSchema(sqlite)).not.toThrow();

    const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("reassessment_obligations");
    const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all("reassessment_obligations") as Array<{ name: string }>;
    const migrations = sqlite.prepare("SELECT COUNT(*) AS count FROM opentag_schema_migrations WHERE id = ?")
      .get("2026-08-04-reassessment-obligations-v1") as { count: number };

    expect(table).toEqual({ name: "reassessment_obligations" });
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
      "reassessment_obligations_source_identity_idx",
      "reassessment_obligations_due_idx",
      "reassessment_obligations_thread_state_idx"
    ]));
    expect(migrations.count).toBe(1);
  });

  it("replays an exact source identity and keeps changed source content distinct", async () => {
    const { repo, workThreadId } = await threadFixture();
    const input = {
      workThreadId,
      sourceKind: "run_result_recorded" as const,
      sourceId: "run-1",
      sourceDigest: digest("a"),
      notBefore: timestamp,
      createdAt: timestamp
    };

    const created = await repo.enqueueReassessmentObligation(input);
    const replayed = await repo.enqueueReassessmentObligation(input);
    const changed = await repo.enqueueReassessmentObligation({ ...input, sourceDigest: digest("b") });

    expect(created).toMatchObject({ outcome: "created" });
    expect(replayed).toMatchObject({ outcome: "existing", obligation: { id: created.obligation.id } });
    expect(changed).toMatchObject({ outcome: "created" });
    await expect(repo.listReassessmentObligations({ workThreadId })).resolves.toHaveLength(2);
  });

  it("rejects an exact source identity replay against a different WorkThread", async () => {
    const { repo } = fixture();
    const first = (await repo.upsertWorkThread({ thread: workThread("42") })).thread;
    const second = (await repo.upsertWorkThread({ thread: workThread("43") })).thread;
    const source = {
      sourceKind: "run_result_recorded" as const,
      sourceId: "run-cross-thread",
      sourceDigest: digest("f"),
      notBefore: timestamp,
      createdAt: timestamp
    };

    await repo.enqueueReassessmentObligation({ ...source, workThreadId: first.id });
    await expect(repo.enqueueReassessmentObligation({
      ...source,
      workThreadId: second.id
    })).rejects.toThrow(/different WorkThread/u);
    await expect(repo.listReassessmentObligations({})).resolves.toMatchObject([
      { workThreadId: first.id }
    ]);
  });

  it("claims only due work in deterministic order and leaves future work pending", async () => {
    const { repo, workThreadId } = await threadFixture();
    await repo.enqueueReassessmentObligation({
      workThreadId,
      sourceKind: "run_result_recorded",
      sourceId: "later-created",
      sourceDigest: digest("a"),
      notBefore: "2026-08-04T07:59:00.000Z",
      createdAt: "2026-08-04T08:00:02.000Z"
    });
    await repo.enqueueReassessmentObligation({
      workThreadId,
      sourceKind: "run_result_recorded",
      sourceId: "earlier-created",
      sourceDigest: digest("b"),
      notBefore: "2026-08-04T07:59:00.000Z",
      createdAt: "2026-08-04T08:00:01.000Z"
    });
    await repo.enqueueReassessmentObligation({
      workThreadId,
      sourceKind: "continuation_not_before",
      sourceId: "future",
      sourceDigest: digest("c"),
      notBefore: "2026-08-04T09:00:00.000Z",
      createdAt: timestamp
    });

    const claimed = await repo.claimDueReassessmentObligations({
      leaseOwner: "dispatcher-1",
      leaseSeconds: 30,
      limit: 10,
      now: new Date(timestamp)
    });

    expect(claimed.map((obligation) => obligation.sourceId)).toEqual(["earlier-created", "later-created"]);
    expect(claimed.every((obligation) => obligation.state === "leased" && obligation.attemptCount === 1)).toBe(true);
    expect(new Set(claimed.map((obligation) => obligation.leaseToken)).size).toBe(2);
    await expect(repo.listReassessmentObligations({ state: "pending" })).resolves.toMatchObject([
      { sourceId: "future" }
    ]);
  });

  it("uses a fresh fence to reject the same-owner ABA race after lease expiry", async () => {
    const { repo, workThreadId } = await threadFixture();
    await repo.enqueueReassessmentObligation({
      workThreadId,
      sourceKind: "run_result_recorded",
      sourceId: "run-aba",
      sourceDigest: digest("d"),
      notBefore: timestamp,
      createdAt: timestamp
    });
    const [first] = await repo.claimDueReassessmentObligations({
      leaseOwner: "dispatcher-same",
      leaseSeconds: 10,
      limit: 1,
      now: new Date(timestamp)
    });
    const [second] = await repo.claimDueReassessmentObligations({
      leaseOwner: "dispatcher-same",
      leaseSeconds: 10,
      limit: 1,
      now: new Date("2026-08-04T08:00:11.000Z")
    });
    if (!first?.leaseToken || !second?.leaseToken) throw new Error("expected fenced claims");

    expect(second.leaseToken).not.toBe(first.leaseToken);
    await expect(repo.satisfyReassessmentObligation({
      id: first.id,
      leaseOwner: "dispatcher-same",
      leaseToken: first.leaseToken,
      reasonCode: "assessment_satisfied",
      satisfiedAssessmentId: "assessment-stale",
      now: new Date("2026-08-04T08:00:12.000Z")
    })).resolves.toMatchObject({ outcome: "stale_lease" });
    await expect(repo.satisfyReassessmentObligation({
      id: second.id,
      leaseOwner: "dispatcher-same",
      leaseToken: second.leaseToken,
      reasonCode: "assessment_satisfied",
      satisfiedAssessmentId: "assessment-current",
      now: new Date("2026-08-04T08:00:12.000Z")
    })).resolves.toMatchObject({
      outcome: "satisfied",
      obligation: { state: "satisfied", satisfiedAssessmentId: "assessment-current" }
    });
  });

  it("serializes claims across independent file-backed repository connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-reassessment-"));
    const databasePath = join(directory, "claims.sqlite");
    const setupSqlite = new Database(databasePath);
    try {
      setupSqlite.pragma("busy_timeout = 1000");
      migrateSchema(setupSqlite);
      const setupRepo = createOpenTagRepository(drizzle(setupSqlite));
      const thread = (await setupRepo.upsertWorkThread({ thread: workThread("file-backed") })).thread;
      await setupRepo.enqueueReassessmentObligation({
        workThreadId: thread.id,
        sourceKind: "run_result_recorded",
        sourceId: "run-file-backed",
        sourceDigest: digest("1"),
        notBefore: timestamp,
        createdAt: timestamp
      });
      setupSqlite.close();

      const workerSource = `
        require("tsx/cjs");
        const { parentPort, workerData } = require("node:worker_threads");
        const Database = require("better-sqlite3");
        const { drizzle } = require("drizzle-orm/better-sqlite3");
        const { createOpenTagRepository } = require(workerData.repositoryPath);
        const sqlite = new Database(workerData.databasePath);
        sqlite.pragma("busy_timeout = 2000");
        const repo = createOpenTagRepository(drizzle(sqlite));
        parentPort.postMessage({ kind: "ready" });
        parentPort.once("message", async () => {
          try {
            const claimed = await repo.claimDueReassessmentObligations({
              leaseOwner: workerData.leaseOwner,
              leaseSeconds: 30,
              limit: 1,
              now: new Date(workerData.now)
            });
            parentPort.postMessage({ kind: "result", claimed });
          } catch (error) {
            parentPort.postMessage({ kind: "error", error: error instanceof Error ? error.message : String(error) });
          } finally {
            sqlite.close();
            parentPort.close();
          }
        });
      `;
      const repositoryPath = fileURLToPath(new URL("../src/repository.ts", import.meta.url));
      const workers = ["dispatcher-a", "dispatcher-b"].map((leaseOwner) => {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: { databasePath, repositoryPath, leaseOwner, now: timestamp }
        });
        const ready = new Promise<void>((resolve, reject) => {
          worker.once("error", reject);
          const onMessage = (message: { kind: string }) => {
            if (message.kind !== "ready") return;
            worker.off("message", onMessage);
            resolve();
          };
          worker.on("message", onMessage);
        });
        const result = new Promise<Array<{ id: string; leaseOwner?: string; leaseToken?: string }>>((resolve, reject) => {
          worker.on("message", (message: { kind: string; claimed?: Array<{ id: string; leaseOwner?: string; leaseToken?: string }>; error?: string }) => {
            if (message.kind === "result") resolve(message.claimed ?? []);
            if (message.kind === "error") reject(new Error(message.error));
          });
          worker.once("error", reject);
        });
        return { worker, ready, result };
      });
      await Promise.all(workers.map((entry) => entry.ready));
      for (const entry of workers) entry.worker.postMessage({ kind: "claim" });
      const claims = await Promise.all(workers.map((entry) => entry.result));

      expect(claims.map((claim) => claim.length).sort()).toEqual([0, 1]);
      const [claimed] = claims.find((claim) => claim.length === 1)!;
      expect(claimed).toMatchObject({ id: expect.any(String), leaseOwner: expect.stringMatching(/^dispatcher-/u), leaseToken: expect.any(String) });
    } finally {
      if (setupSqlite.open) setupSqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("reschedules retryable work and blocks only with the current fence", async () => {
    const { repo, workThreadId } = await threadFixture();
    const created = await repo.enqueueReassessmentObligation({
      workThreadId,
      sourceKind: "verification_evidence_attached",
      sourceId: "delivery-1",
      sourceDigest: digest("e"),
      notBefore: timestamp,
      createdAt: timestamp
    });
    const [first] = await repo.claimDueReassessmentObligations({
      leaseOwner: "dispatcher-1",
      leaseSeconds: 30,
      limit: 1,
      now: new Date(timestamp)
    });
    if (!first?.leaseToken) throw new Error("expected first claim");
    await expect(repo.rescheduleReassessmentObligation({
      id: created.obligation.id,
      leaseOwner: "dispatcher-1",
      leaseToken: first.leaseToken,
      notBefore: "2026-08-04T08:01:00.000Z",
      reasonCode: "reassessment_failed",
      lastError: "fixture failure",
      now: new Date("2026-08-04T08:00:01.000Z")
    })).resolves.toMatchObject({
      outcome: "rescheduled",
      obligation: { state: "pending", lastReasonCode: "reassessment_failed", lastError: "fixture failure" }
    });

    const [second] = await repo.claimDueReassessmentObligations({
      leaseOwner: "dispatcher-2",
      leaseSeconds: 30,
      limit: 1,
      now: new Date("2026-08-04T08:01:00.000Z")
    });
    if (!second?.leaseToken) throw new Error("expected second claim");
    await expect(repo.blockReassessmentObligation({
      id: created.obligation.id,
      leaseOwner: "dispatcher-1",
      leaseToken: first.leaseToken,
      reasonCode: "authority_missing",
      now: new Date("2026-08-04T08:01:01.000Z")
    })).resolves.toMatchObject({ outcome: "stale_lease" });
    await expect(repo.blockReassessmentObligation({
      id: created.obligation.id,
      leaseOwner: "dispatcher-2",
      leaseToken: second.leaseToken,
      reasonCode: "authority_missing",
      lastError: "completion contract missing",
      now: new Date("2026-08-04T08:01:01.000Z")
    })).resolves.toMatchObject({ outcome: "blocked", obligation: { state: "blocked" } });
    await expect(repo.claimDueReassessmentObligations({
      leaseOwner: "dispatcher-3",
      leaseSeconds: 30,
      limit: 1,
      now: new Date("2026-08-04T08:02:00.000Z")
    })).resolves.toEqual([]);
  });

  it("commits an attached provider fact and its obligation atomically", async () => {
    const { sqlite, repo, workThreadId } = await threadFixture();
    const evidence = {
      id: "evidence-1",
      kind: "source_control.required_checks",
      assurance: "verified" as const,
      subjectRef: "github:acme/demo:pull_request:7:head:abc123",
      summary: "Required checks passed.",
      createdAt: timestamp
    };
    await repo.recordVerificationEvidence({
      provider: "github",
      deliveryId: "delivery-evidence-1",
      subjectRef: "github:acme/demo:pull_request:7",
      subjectVersion: "abc123",
      evidence,
      observedAt: timestamp,
      receivedAt: timestamp
    });
    sqlite.exec(`
      CREATE TRIGGER reject_reassessment_obligation
      BEFORE INSERT ON reassessment_obligations
      BEGIN
        SELECT RAISE(ABORT, 'fixture obligation insert failure');
      END;
    `);

    await expect(repo.attachVerificationEvidenceDeliveryToWorkThread({
      provider: "github",
      deliveryId: "delivery-evidence-1",
      subjectRef: "github:acme/demo:pull_request:7",
      workThreadId,
      attachedAt: timestamp
    })).rejects.toThrow(/fixture obligation insert failure/u);
    await expect(repo.listVerificationEvidence({ workThreadId })).resolves.toHaveLength(0);

    sqlite.exec("DROP TRIGGER reject_reassessment_obligation;");
    await expect(repo.attachVerificationEvidenceDeliveryToWorkThread({
      provider: "github",
      deliveryId: "delivery-evidence-1",
      subjectRef: "github:acme/demo:pull_request:7",
      workThreadId,
      attachedAt: timestamp
    })).resolves.toEqual({ attached: 1 });
    await expect(repo.listReassessmentObligations({ workThreadId })).resolves.toMatchObject([
      { sourceKind: "verification_evidence_attached", state: "pending" }
    ]);
    await expect(repo.attachVerificationEvidenceDeliveryToWorkThread({
      provider: "github",
      deliveryId: "delivery-evidence-1",
      subjectRef: "github:acme/demo:pull_request:7",
      workThreadId,
      attachedAt: timestamp
    })).resolves.toEqual({ attached: 0 });
    await expect(repo.listReassessmentObligations({ workThreadId })).resolves.toHaveLength(1);
  });

  it("derives evidence batch replay identity from the authoritative delivery group", async () => {
    const { repo, workThreadId } = await threadFixture();
    const records = ["source_control.pull_request", "source_control.required_checks"].map((kind, index) => ({
      id: `evidence-replay-${index}`,
      workThreadId,
      provider: "github",
      deliveryId: "delivery-replay",
      subjectRef: "github:acme/demo:pull_request:7",
      subjectVersion: "abc123",
      evidence: {
        id: `evidence-replay-${index}`,
        kind,
        assurance: "verified" as const,
        subjectRef: "github:acme/demo:pull_request:7@abc123",
        summary: `${kind}=verified`,
        createdAt: timestamp
      },
      payloadDigest: digest(String(index + 2)),
      observedAt: timestamp,
      receivedAt: timestamp
    }));

    await repo.recordVerificationEvidenceBatch({ records });
    await expect(repo.listReassessmentObligations({ workThreadId })).resolves.toHaveLength(1);
    await repo.recordVerificationEvidenceBatch({ records: [records[0]!] });
    await expect(repo.listReassessmentObligations({ workThreadId })).resolves.toHaveLength(1);

    const { repo: growingRepo, workThreadId: growingThreadId } = await threadFixture();
    const growingRecords = records.map((record) => ({ ...record, workThreadId: growingThreadId }));
    await growingRepo.recordVerificationEvidenceBatch({ records: [growingRecords[0]!] });
    await growingRepo.recordVerificationEvidenceBatch({ records: growingRecords });
    await expect(growingRepo.listReassessmentObligations({ workThreadId: growingThreadId })).resolves.toHaveLength(2);
    await growingRepo.recordVerificationEvidenceBatch({ records: growingRecords });
    await expect(growingRepo.listReassessmentObligations({ workThreadId: growingThreadId })).resolves.toHaveLength(2);
  });

  it("commits HumanEscalation state changes with distinct reassessment obligations", async () => {
    const { repo, workThreadId } = await threadFixture();
    const open = {
      id: "escalation-obligation",
      workThreadId,
      class: "verification" as const,
      audience: "repo_owner" as const,
      subjectRef: "github:acme/demo:pull_request:7",
      state: "open" as const,
      blocking: true,
      summary: "Required check evidence is unavailable.",
      reason: "The configured check has not reported for the current head.",
      dedupeKey: "verification:checks:primary_change",
      openedAt: timestamp
    };
    await repo.openHumanEscalation({ escalation: open });
    const resolved = {
      ...open,
      state: "resolved" as const,
      resolution: {
        actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
        reason: "Repository check configuration repaired.",
        resolvedAt: "2026-08-04T08:05:00.000Z"
      }
    };
    await repo.resolveHumanEscalation({ escalation: resolved });

    await expect(repo.listReassessmentObligations({ workThreadId })).resolves.toMatchObject([
      { sourceKind: "human_escalation_changed", sourceId: open.id, state: "pending" },
      { sourceKind: "human_escalation_changed", sourceId: open.id, state: "pending" }
    ]);
  });

  it("rolls back a terminal Run when its obligation cannot commit", async () => {
    const { sqlite, repo } = fixture();
    await repo.createRun({ id: "run-1", event: githubEvent() });
    sqlite.exec(`
      CREATE TRIGGER reject_run_reassessment_obligation
      BEFORE INSERT ON reassessment_obligations
      WHEN NEW.source_kind = 'run_result_recorded'
      BEGIN
        SELECT RAISE(ABORT, 'fixture run obligation insert failure');
      END;
    `);

    await expect(repo.completeRun({
      runId: "run-1",
      result: { conclusion: "success", summary: "done" }
    })).rejects.toThrow(/fixture run obligation insert failure/u);
    await expect(repo.getRun({ runId: "run-1" })).resolves.toMatchObject({ run: { status: "queued" } });
    await expect(repo.listReassessmentObligations({})).resolves.toHaveLength(0);

    sqlite.exec("DROP TRIGGER reject_run_reassessment_obligation;");
    await expect(repo.completeRun({
      runId: "run-1",
      result: { conclusion: "success", summary: "done" }
    })).resolves.toBe("completed");
    await expect(repo.listReassessmentObligations({})).resolves.toMatchObject([
      { sourceKind: "run_result_recorded", sourceId: "run-1", state: "pending" }
    ]);
  });
});
