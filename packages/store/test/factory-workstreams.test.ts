import Database from "better-sqlite3";
import { WorkstreamAdmissionBatchInputSchema } from "@opentag/core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { canonicalSha256Json } from "../src/canonical-json.js";
import { createOpenTagRepository } from "../src/repository.js";
import { migrateSchema } from "../src/schema.js";

function fixture() {
  const sqlite = new Database(":memory:");
  migrateSchema(sqlite);
  return { sqlite, repo: createOpenTagRepository(drizzle(sqlite)) };
}

function event(id: string) {
  return {
    id: `event-${id}`,
    source: "github" as const,
    sourceEventId: `comment-${id}`,
    receivedAt: "2026-07-26T00:00:00.000Z",
    actor: { provider: "github" as const, providerUserId: "42", handle: "octocat" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "fix", intent: "fix" as const, args: {} },
    context: [{ provider: "github" as const, kind: "issue" as const, uri: "https://github.com/acme/demo/issues/42", visibility: "public" as const }],
    workItem: { provider: "github" as const, kind: "issue" as const, externalId: "acme/demo#42", uri: "https://github.com/acme/demo/issues/42", ownerContainer: { provider: "github" as const, id: "acme/demo", uri: "https://github.com/acme/demo" } },
    thread: { provider: "github" as const, kind: "issue_comment" as const, externalId: "comment-root", uri: "https://github.com/acme/demo/issues/42#issuecomment-root", threadKey: "acme/demo#42" },
    permissions: [{ scope: "issue:comment", reason: "reply" }],
    callback: { provider: "github" as const, uri: "https://api.github.com/repos/acme/demo/issues/42/comments" },
    metadata: { owner: "acme", repo: "demo", issueNumber: 42 }
  };
}

async function setupFactory() {
  const { sqlite, repo } = fixture();
  const run = await repo.createRun({ id: "seed-run", event: event("seed") });
  const workThreadId = run.run.thread?.id;
  if (!workThreadId) throw new Error("expected WorkThread");
  const recipe = { id: "recipe", version: 1, name: "bounded", budgets: { maxConcurrentRuns: 1, maxAttemptsPerRun: 1, maxCostUnits: 1, costUnitsPerAttempt: 1, allowedLocalities: ["local"] } };
  await repo.createFactoryRecipeSnapshot({ id: "recipe", version: 1, recipe });
  await repo.createFactoryWorkstream({ id: "workstream", recipeId: "recipe", recipeVersion: 1, workstream: { id: "workstream", name: "one" }, workThreadIds: [workThreadId] });
  return { sqlite, repo, workThreadId };
}

describe("factory workstream persistence", () => {
  it("uses a stable code-unit canonical digest for durable replay identity", () => {
    expect(canonicalSha256Json({ z: 1, "ä": 2, a: 3, "😀": 4 })).toBe(
      "sha256:fb215dbd6cdd5ce98f4e77b27ba82bf88b6376d244e0dbc9323c496101653081"
    );
  });

  it("migrates a pre-Phase-4 database idempotently without losing legacy runs or follow-ups", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const legacyRepo = createOpenTagRepository(drizzle(sqlite));
    const legacyEvent = event("legacy-migration");
    await legacyRepo.createRun({ id: "legacy-run", event: legacyEvent });
    await legacyRepo.createFollowUpRequest({
      id: "legacy-follow-up",
      event: event("legacy-follow-up"),
      activeRunId: "legacy-run",
      decision: {
        action: "queue_follow_up",
        reason: "Legacy follow-up remains queued.",
        reasonCode: "active_run_same_thread",
        decidedAt: "2026-07-26T00:00:00.000Z",
        activeRunId: "legacy-run",
        eventId: "event-legacy-follow-up"
      }
    });

    sqlite.exec(`
      DROP INDEX IF EXISTS runs_workstream_idx;
      DROP INDEX IF EXISTS runs_admission_batch_idx;
      DROP INDEX IF EXISTS control_plane_events_idempotency_key_idx;
      DROP TABLE IF EXISTS workstream_admission_batch_items;
      DROP TABLE IF EXISTS workstream_admission_batches;
      DROP TABLE IF EXISTS factory_workstream_members;
      DROP TABLE IF EXISTS factory_workstreams;
      DROP TABLE IF EXISTS factory_recipe_snapshots;
      ALTER TABLE runs DROP COLUMN workstream_id;
      ALTER TABLE runs DROP COLUMN admission_batch_id;
      ALTER TABLE attempts DROP COLUMN runner_locality;
      ALTER TABLE control_plane_events DROP COLUMN idempotency_key;
      ALTER TABLE follow_up_requests DROP COLUMN workstream_id;
      ALTER TABLE follow_up_requests DROP COLUMN admission_batch_id;
      DELETE FROM opentag_schema_migrations WHERE id = '2026-07-26-factory-workstreams-v1';
    `);

    migrateSchema(sqlite);
    migrateSchema(sqlite);
    const migratedRepo = createOpenTagRepository(drizzle(sqlite));
    await expect(migratedRepo.getRun({ runId: "legacy-run" })).resolves.toMatchObject({ run: { id: "legacy-run" } });
    await expect(migratedRepo.getFollowUpRequest({ id: "legacy-follow-up" })).resolves.toMatchObject({
      id: "legacy-follow-up",
      status: "queued"
    });
    const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("factory_workstreams");
    expect(table).toEqual({ name: "factory_workstreams" });
    const runColumns = sqlite.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    expect(runColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["workstream_id", "admission_batch_id"]));
    const followUpColumns = sqlite.prepare("PRAGMA table_info(follow_up_requests)").all() as Array<{ name: string }>;
    expect(followUpColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["workstream_id", "admission_batch_id"]));
  });

  it("keeps recipe and workstream snapshots immutable", async () => {
    const { repo } = await setupFactory();
    await expect(repo.createFactoryRecipeSnapshot({ id: "recipe", version: 1, recipe: { id: "recipe", version: 1, name: "changed", budgets: { maxConcurrentRuns: 1, maxAttemptsPerRun: 1, maxCostUnits: 1, costUnitsPerAttempt: 1, allowedLocalities: ["local"] } } })).resolves.toMatchObject({ outcome: "conflict" });
    await expect(repo.createFactoryWorkstream({ id: "workstream", recipeId: "recipe", recipeVersion: 1, workstream: { id: "workstream", name: "changed" }, workThreadIds: ["missing"] })).resolves.toMatchObject({ outcome: "conflict" });
  });

  it("lists the bounded Workstream authority for a WorkThread", async () => {
    const { repo, workThreadId } = await setupFactory();

    await expect(repo.listFactoryWorkstreamsForWorkThread({ workThreadId })).resolves.toMatchObject([
      {
        id: "workstream",
        recipeId: "recipe",
        recipeVersion: 1,
        workstream: { id: "workstream", name: "one" },
        workThreadIds: [workThreadId]
      }
    ]);
    await expect(repo.listFactoryWorkstreamsForWorkThread({ workThreadId: "missing" })).resolves.toEqual([]);
  });

  it("atomically rejects a new run while the conversation has any active run", async () => {
    const { repo } = await setupFactory();

    await expect(repo.createRun({
      id: "automatic-continuation",
      event: event("automatic-continuation"),
      workstreamId: "workstream",
      rejectIfActiveConversation: true
    })).rejects.toThrow("ACTIVE_CONVERSATION_RACE:seed-run");
    await expect(repo.getRun({ runId: "automatic-continuation" })).resolves.toBeNull();
  });

  it("atomically rejects a run while an automatic Workstream continuation is active", async () => {
    const { repo } = await setupFactory();
    await repo.createRun({
      id: "active-automatic-continuation",
      event: event("active-automatic-continuation"),
      triggeredByAction: {
        kind: "resume_work_thread",
        metadata: { workstreamContinuation: true }
      }
    });

    await expect(repo.createRun({
      id: "blocked-by-automatic-continuation",
      event: event("blocked-by-automatic-continuation"),
      rejectIfAutomaticContinuationActive: true
    })).rejects.toMatchObject({ activeRunId: "active-automatic-continuation" });
    await expect(repo.getRun({ runId: "blocked-by-automatic-continuation" })).resolves.toBeNull();
  });

  it("returns an automatic-continuation source-event replay before applying the active-conversation fence", async () => {
    const { repo } = fixture();
    const replayEvent = event("automatic-continuation-replay");
    const triggeredByAction = {
      kind: "resume_work_thread" as const,
      metadata: { workstreamContinuation: true }
    };
    const first = await repo.createRun({
      id: "automatic-continuation-replay",
      event: replayEvent,
      triggeredByAction,
      rejectIfActiveConversation: true
    });
    const replay = await repo.createRun({
      id: "automatic-continuation-replay-retry",
      event: replayEvent,
      triggeredByAction,
      rejectIfActiveConversation: true
    });

    expect(first).toMatchObject({ created: true, run: { id: "automatic-continuation-replay" } });
    expect(replay).toMatchObject({
      created: false,
      run: { id: "automatic-continuation-replay" },
      replayDecision: { reasonCode: "duplicate_source_event" }
    });
    await expect(repo.getRun({ runId: "automatic-continuation-replay-retry" })).resolves.toBeNull();
  });

  it("resumes expired batches, fences items, and replays completed results", async () => {
    const { repo, workThreadId } = await setupFactory();
    const items = [{ itemId: "item", runId: "run", workThreadId, event: event("batch") }];
    const request = { id: "batch", workstreamId: "workstream", items };
    const input = { id: "batch", workstreamId: "workstream", requestDigest: canonicalSha256Json(WorkstreamAdmissionBatchInputSchema.parse(request)), request, items, leaseOwner: "owner-a", leaseSeconds: 1, now: new Date("2026-07-26T00:00:00.000Z") };
    await expect(repo.beginWorkstreamAdmissionBatch(input)).resolves.toMatchObject({ outcome: "acquired" });
    await expect(repo.beginWorkstreamAdmissionBatch({ ...input, leaseOwner: "owner-b", now: new Date("2026-07-26T00:00:00.500Z") })).resolves.toMatchObject({ outcome: "in_progress" });
    await expect(repo.beginWorkstreamAdmissionBatch({ ...input, leaseOwner: "owner-b", leaseSeconds: 60, now: new Date("2026-07-26T00:00:02.000Z") })).resolves.toMatchObject({ outcome: "acquired" });
    await expect(repo.claimWorkstreamAdmissionBatchItem({ batchId: "batch", itemId: "item", leaseOwner: "owner-b", leaseSeconds: 60, now: new Date("2026-07-26T00:00:02.000Z") })).resolves.toMatchObject({ outcome: "claimed" });
    await expect(repo.renewWorkstreamAdmissionBatchLease({ batchId: "batch", itemId: "item", leaseOwner: "owner-a", leaseSeconds: 60, now: new Date("2026-07-26T00:00:50.000Z") })).resolves.toMatchObject({ outcome: "stale_lease" });
    await expect(repo.renewWorkstreamAdmissionBatchLease({ batchId: "batch", itemId: "item", leaseOwner: "owner-b", leaseSeconds: 60, now: new Date("2026-07-26T00:00:50.000Z") })).resolves.toMatchObject({ outcome: "renewed" });
    await expect(repo.beginWorkstreamAdmissionBatch({ ...input, leaseOwner: "owner-c", leaseSeconds: 60, now: new Date("2026-07-26T00:01:03.000Z") })).resolves.toMatchObject({ outcome: "in_progress" });
    await expect(repo.completeWorkstreamAdmissionBatchItem({ batchId: "batch", itemId: "item", leaseOwner: "owner-a", result: { status: "created" }, now: new Date("2026-07-26T00:01:03.000Z") })).resolves.toMatchObject({ outcome: "stale_lease" });
    await expect(repo.completeWorkstreamAdmissionBatchItem({ batchId: "batch", itemId: "item", leaseOwner: "owner-b", result: { status: "created" }, now: new Date("2026-07-26T00:01:03.000Z") })).resolves.toMatchObject({ outcome: "completed" });
    await expect(repo.finalizeWorkstreamAdmissionBatch({ id: "batch", leaseOwner: "owner-b", result: { totalItems: 1 }, now: new Date("2026-07-26T00:01:03.000Z") })).resolves.toMatchObject({ outcome: "completed" });
    await expect(repo.beginWorkstreamAdmissionBatch({ ...input, leaseOwner: "owner-c", now: new Date("2026-07-26T00:02:00.000Z") })).resolves.toMatchObject({ outcome: "replay", batch: { result: { totalItems: 1 } } });
  });

  it("attributes runs and atomically blocks a second attempt at the recipe budget", async () => {
    const { sqlite, repo } = await setupFactory();
    sqlite.prepare("DELETE FROM runs WHERE id = ?").run("seed-run");
    await repo.registerRunner({ runnerId: "runner", name: "runner", locality: "local" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner", defaultExecutor: "codex" });
    const run = await repo.createRun({ id: "factory-run", event: event("factory"), workstreamId: "workstream" });
    expect(run.created).toBe(true);
    await expect(repo.claimNextRun({ runnerId: "runner", leaseSeconds: 0 })).resolves.toMatchObject({ run: { id: "factory-run" } });
    await expect(repo.claimNextRun({ runnerId: "runner", leaseSeconds: 60 })).resolves.toBeNull();
    await expect(repo.getRun({ runId: "factory-run" })).resolves.toMatchObject({ run: { status: "needs_approval" } });
    await expect(repo.getWorkstreamMetrics({ workstreamId: "workstream" })).resolves.toMatchObject({
      workThreadCount: 1,
      runCount: 1,
      needsHumanRunCount: 1,
      budgetBlockedRunCount: 1,
      totalAttempts: 1,
      attemptsPerRunExceededCount: 0,
      totalCostUnits: 1,
      attemptsByLocality: { local: 1, private: 0, hosted: 0, unknown: 0 }
    });
  });

  it("derives lifetime metrics without binding every historical run id", async () => {
    const { sqlite, repo } = await setupFactory();
    sqlite.exec(`
      WITH RECURSIVE sequence(value) AS (
        VALUES(1)
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 33000
      )
      INSERT INTO runs (
        id, event_id, status, event_json, workstream_id,
        routing_rejections_json, created_at, updated_at
      )
      SELECT
        'historical-run-' || value,
        'historical-event-' || value,
        'queued',
        '{}',
        'workstream',
        '[]',
        '2026-07-26T00:00:00.000Z',
        '2026-07-26T00:00:00.000Z'
      FROM sequence;
    `);

    await expect(repo.getWorkstreamMetrics({ workstreamId: "workstream" })).resolves.toMatchObject({
      runCount: 33_000,
      queuedRunCount: 33_000,
      totalAttempts: 0,
      budgetBlockedRunCount: 0
    });
  });

  it("fails closed and audits once when an attributed claim loses recipe authority", async () => {
    const { sqlite, repo } = await setupFactory();
    sqlite.prepare("DELETE FROM runs WHERE id = ?").run("seed-run");
    await repo.registerRunner({ runnerId: "runner", name: "runner", locality: "local" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner", defaultExecutor: "codex" });
    await repo.createRun({ id: "factory-corrupt-recipe", event: event("corrupt-recipe"), workstreamId: "workstream" });
    sqlite.prepare("DELETE FROM factory_recipe_snapshots WHERE id = ? AND version = ?").run("recipe", 1);

    await expect(repo.claimNextRun({ runnerId: "runner", leaseSeconds: 60 })).resolves.toBeNull();
    await expect(repo.claimNextRun({ runnerId: "runner", leaseSeconds: 60 })).resolves.toBeNull();
    await expect(repo.getRun({ runId: "factory-corrupt-recipe" })).resolves.toMatchObject({ run: { status: "queued" } });
    expect(sqlite.prepare("SELECT count(*) AS count FROM attempts WHERE run_id = ?").get("factory-corrupt-recipe")).toEqual({ count: 0 });
    expect((await repo.listRunEvents({ runId: "factory-corrupt-recipe" })).filter((entry) => entry.type === "factory.invariant_blocked")).toHaveLength(1);
    expect(sqlite.prepare("SELECT count(*) AS count FROM control_plane_events WHERE type = ? AND subject = ?").get("factory.invariant_blocked", "workstream")).toEqual({ count: 1 });
  });

  it("publishes a new run only with its complete base audit and keeps replay audit bounded", async () => {
    const { sqlite, repo } = fixture();
    const source = { ...event("atomic"), metadata: { ...event("atomic").metadata, deliveryId: "delivery-atomic" } };
    await repo.createRun({ id: "atomic-run", event: source });
    await repo.createRun({ id: "atomic-retry", event: source });
    await repo.createRun({ id: "atomic-retry", event: source });
    const events = await repo.listRunEvents({ runId: "atomic-run" });
    expect(events.filter((entry) => entry.type === "run.created")).toHaveLength(1);
    expect(events.filter((entry) => entry.type === "context_packet.generated")).toHaveLength(1);
    expect(events.filter((entry) => entry.type === "admission.decided" && (entry.payload as { reasonCode?: string }).reasonCode === "new_event")).toHaveLength(1);
    expect(events.filter((entry) => entry.type === "run.create_idempotent_replay")).toHaveLength(1);
    expect(sqlite.prepare("SELECT count(*) AS count FROM source_deliveries WHERE run_id = ?").get("atomic-run")).toEqual({ count: 1 });
  });

  it("treats concurrency as transient capacity and leaves the next run queued without blocking audit", async () => {
    const { sqlite, repo } = await setupFactory();
    sqlite.prepare("DELETE FROM runs WHERE id = ?").run("seed-run");
    await repo.registerRunner({ runnerId: "runner", name: "runner", locality: "local" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner", defaultExecutor: "codex" });
    await repo.createRun({ id: "run-one", event: event("one"), workstreamId: "workstream" });
    await repo.createRun({ id: "run-two", event: event("two"), workstreamId: "workstream" });
    await expect(repo.claimNextRun({ runnerId: "runner", leaseSeconds: 60 })).resolves.toMatchObject({ run: { id: "run-one" } });
    await expect(repo.claimNextRun({ runnerId: "runner", leaseSeconds: 60 })).resolves.toBeNull();
    await expect(repo.getRun({ runId: "run-two" })).resolves.toMatchObject({ run: { status: "queued" } });
    expect((await repo.listRunEvents({ runId: "run-two" })).some((entry) => entry.type === "factory.budget_blocked")).toBe(false);
  });

  it("counts accepted WorkThreads only from the current assessment authority", async () => {
    const { sqlite, repo, workThreadId } = await setupFactory();
    const assessment = (id: string, sequence: number, state: "satisfied" | "pending", evidenceBacked: boolean) => ({
      id,
      workThreadId,
      contractId: "contract",
      contractVersion: 1,
      cycle: 1,
      sequence,
      ...(sequence > 1 ? { supersedesAssessmentId: "assessment-accepted" } : {}),
      inputDigest: `sha256:${String(sequence).repeat(64)}`,
      targetBindings: [],
      state,
      evidenceBacked,
      gateResults: [{ gateId: "checks", state: state === "satisfied" ? "passed" : "missing", evidenceIds: state === "satisfied" ? ["evidence"] : [], reasonCode: state === "satisfied" ? "verification_passed" : "verification_missing", reason: "authority", evaluatedAt: "2026-07-26T00:00:00.000Z" }],
      assessedAt: "2026-07-26T00:00:00.000Z",
      assessedBy: "opentag"
    });
    const accepted = assessment("assessment-accepted", 1, "satisfied", true);
    const pending = assessment("assessment-pending", 2, "pending", false);
    const insert = sqlite.prepare(`INSERT INTO completion_assessments (id, work_thread_id, contract_id, contract_version, cycle, sequence, supersedes_assessment_id, input_digest, state, assessment_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(accepted.id, workThreadId, "contract", 1, 1, 1, null, accepted.inputDigest, accepted.state, JSON.stringify(accepted), accepted.assessedAt);
    insert.run(pending.id, workThreadId, "contract", 1, 1, 2, "assessment-accepted", pending.inputDigest, pending.state, JSON.stringify(pending), pending.assessedAt);
    sqlite.prepare("UPDATE work_threads SET current_assessment_id = ? WHERE id = ?").run("assessment-pending", workThreadId);
    await expect(repo.getWorkstreamMetrics({ workstreamId: "workstream" })).resolves.toMatchObject({ acceptedWorkThreadCount: 0 });
    sqlite.prepare("UPDATE work_threads SET current_assessment_id = ? WHERE id = ?").run("assessment-accepted", workThreadId);
    await expect(repo.getWorkstreamMetrics({ workstreamId: "workstream" })).resolves.toMatchObject({ acceptedWorkThreadCount: 1 });
  });

  it("counts only current unexpired persisted waiver authority", async () => {
    const { sqlite, repo, workThreadId } = await setupFactory();
    await repo.recordCompletionContract({
      contract: {
        id: "contract-waiver",
        version: 1,
        workThreadId,
        cycle: 1,
        mode: "governed",
        targetSelectors: [],
        resolvedFrom: [{ scope: "work_context_owner_container", ref: "github:acme/demo", version: "1" }],
        gates: [{ id: "acceptance", kind: "human_acceptance", requiredRole: "repo_owner" }],
        maxAutomaticRetries: 0,
        onSatisfied: "report_only",
        createdAt: "2026-07-26T00:00:00.000Z"
      }
    });
    const waiver = (id: string, expiresAt: string) => ({
      id,
      contractId: "contract-waiver",
      contractVersion: 1,
      cycle: 1,
      actor: { provider: "github" as const, providerUserId: "owner-1", handle: "repo-owner" },
      reason: "The owner explicitly accepted this bounded exception.",
      scope: "selected_gates" as const,
      policyScope: "work_context_owner_container" as const,
      gateIds: ["acceptance"],
      waivedAt: "2026-07-26T00:01:00.000Z",
      expiresAt
    });
    const acceptedWaiver = waiver("waiver-active", "2999-01-01T00:00:00.000Z");
    const expiredWaiver = waiver("waiver-expired", "2000-01-01T00:00:00.000Z");
    await repo.recordCompletionWaiver({ waiver: acceptedWaiver });
    await repo.recordCompletionWaiver({ waiver: expiredWaiver });

    const assessment = (id: string, sequence: number, attributedWaiver: typeof acceptedWaiver) => ({
      id,
      workThreadId,
      contractId: "contract-waiver",
      contractVersion: 1,
      cycle: 1,
      sequence,
      ...(sequence > 1 ? { supersedesAssessmentId: "assessment-waiver-active" } : {}),
      inputDigest: `sha256:${String(sequence).repeat(64)}`,
      targetBindings: [],
      state: "waived",
      evidenceBacked: true,
      gateResults: [{
        gateId: "acceptance",
        state: "waived",
        evidenceIds: [],
        reasonCode: "gate_waived",
        reason: "The gate is covered by an attributed waiver.",
        evaluatedAt: "2026-07-26T00:01:00.000Z"
      }],
      assessedAt: "2026-07-26T00:01:00.000Z",
      assessedBy: "human",
      acceptedAt: "2026-07-26T00:01:00.000Z",
      waiver: attributedWaiver
    });
    const active = assessment("assessment-waiver-active", 1, acceptedWaiver);
    const expired = assessment("assessment-waiver-expired", 2, expiredWaiver);
    const insert = sqlite.prepare(`INSERT INTO completion_assessments
      (id, work_thread_id, contract_id, contract_version, cycle, sequence, supersedes_assessment_id, input_digest, state, assessment_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(active.id, workThreadId, active.contractId, active.contractVersion, active.cycle, active.sequence, null, active.inputDigest, active.state, JSON.stringify(active), active.assessedAt);
    insert.run(expired.id, workThreadId, expired.contractId, expired.contractVersion, expired.cycle, expired.sequence, expired.supersedesAssessmentId, expired.inputDigest, expired.state, JSON.stringify(expired), expired.assessedAt);

    sqlite.prepare("UPDATE work_threads SET current_assessment_id = ? WHERE id = ?").run(active.id, workThreadId);
    await expect(repo.getWorkstreamMetrics({ workstreamId: "workstream" })).resolves.toMatchObject({ acceptedWorkThreadCount: 1 });
    sqlite.prepare("UPDATE work_threads SET current_assessment_id = ? WHERE id = ?").run(expired.id, workThreadId);
    await expect(repo.getWorkstreamMetrics({ workstreamId: "workstream" })).resolves.toMatchObject({ acceptedWorkThreadCount: 0 });
  });
});
