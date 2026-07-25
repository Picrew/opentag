import type {
  AgentAccessProfileSnapshot,
  CompletionAssessment,
  CompletionContract,
  CompletionWaiver,
  HumanEscalation,
  OpenTagEvent,
  PolicySnapshotProvenance,
  WorkThread
} from "@opentag/core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createOpenTagRepository } from "../src/repository.js";
import { migrateSchema } from "../src/schema.js";

const timestamp = "2026-07-21T10:00:00.000Z";

function workThread(input: { id?: string; anchorId: string }): WorkThread {
  return {
    ...(input.id ? { id: input.id } : {}),
    workItemReference: {
      provider: "github",
      kind: "issue",
      externalId: "acme/demo#42",
      uri: "https://github.com/acme/demo/issues/42",
      ownerContainer: {
        provider: "github",
        id: "acme/demo",
        uri: "https://github.com/acme/demo"
      }
    },
    primaryAnchor: {
      provider: "github",
      kind: "issue_comment",
      externalId: input.anchorId,
      uri: `https://github.com/acme/demo/issues/42#${input.anchorId}`,
      threadKey: "acme/demo#42"
    }
  };
}

function githubEvent(id: string, sourceEventId: string): OpenTagEvent {
  return {
    id,
    source: "github",
    sourceEventId,
    receivedAt: timestamp,
    actor: { provider: "github", providerUserId: "user-1", handle: "octocat" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/42", visibility: "public" }],
    workItem: workThread({ anchorId: "comment-1" }).workItemReference,
    permissions: [],
    callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/42/comments", threadKey: "acme/demo#42" },
    metadata: { owner: "acme", repo: "demo", issueNumber: 42 }
  };
}

function strictContract(workThreadId: string): CompletionContract {
  return {
    id: "contract-1",
    version: 1,
    workThreadId,
    cycle: 1,
    mode: "governed",
    targetSelectors: [{ key: "primary_change", kind: "change_request", lineage: "current_cycle", cardinality: "exactly_one" }],
    resolvedFrom: [{ scope: "work_context_owner_container", ref: "github:acme/demo", version: "1" }],
    gates: [
      { id: "pr", kind: "artifact", targetKey: "primary_change", artifactKind: "pull_request", minimum: 1 },
      { id: "checks", kind: "verification", targetKey: "primary_change", evidenceKind: "source_control.required_checks", requiredOutcome: "passed", minimumAssurance: "verified" },
      { id: "merge", kind: "external_state", targetKey: "primary_change", provider: "github", requiredState: "merged", minimumAssurance: "verified" }
    ],
    maxAutomaticRetries: 1,
    onSatisfied: "report_only",
    createdAt: timestamp
  };
}

function assessment(input: {
  id: string;
  workThreadId: string;
  sequence: number;
  digestChar: string;
  supersedesAssessmentId?: string;
  state?: CompletionAssessment["state"];
  acceptedAt?: string;
}): CompletionAssessment {
  return {
    id: input.id,
    workThreadId: input.workThreadId,
    contractId: "contract-1",
    contractVersion: 1,
    cycle: 1,
    sequence: input.sequence,
    inputDigest: `sha256:${input.digestChar.repeat(64)}`,
    targetBindings: [{
      key: "primary_change",
      provider: "github",
      resourceRef: "github:acme/demo:pull_request:7",
      resourceVersion: "abc123",
      artifactId: "artifact-pr-7"
    }],
    state: input.state ?? "pending",
    evidenceBacked: true,
    gateResults: [{
      gateId: "checks",
      targetKey: "primary_change",
      state: "missing",
      evidenceIds: [],
      reasonCode: "verification_missing",
      reason: "Required check evidence has not arrived.",
      evaluatedAt: timestamp
    }],
    assessedAt: timestamp,
    assessedBy: "opentag",
    ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
    ...(input.supersedesAssessmentId ? { supersedesAssessmentId: input.supersedesAssessmentId } : {})
  };
}

function repository() {
  const sqlite = new Database(":memory:");
  migrateSchema(sqlite);
  return { sqlite, repo: createOpenTagRepository(drizzle(sqlite)) };
}

describe("completion governance persistence", () => {
  it("adds the governance migration to a legacy database and remains restart-safe", () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    sqlite.exec(`
      DELETE FROM opentag_schema_migrations WHERE id = '2026-07-21-completion-governance-v1';
      DELETE FROM opentag_schema_migrations WHERE id = '2026-07-21-completion-waivers-v1';
      DROP TABLE completion_waivers;
      DROP TABLE governance_events;
      DROP TABLE human_escalations;
      DROP TABLE completion_assessments;
      DROP TABLE verification_evidence;
      DROP TABLE completion_contracts;
      DROP TABLE work_threads;
    `);

    expect(() => migrateSchema(sqlite)).not.toThrow();
    expect(() => migrateSchema(sqlite)).not.toThrow();

    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      "work_threads",
      "completion_contracts",
      "verification_evidence",
      "completion_assessments",
      "completion_waivers",
      "human_escalations",
      "governance_events"
    ]));
    const migration = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get("2026-07-21-completion-governance-v1");
    expect(migration).toBeTruthy();
    const waiverMigration = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get("2026-07-21-completion-waivers-v1");
    expect(waiverMigration).toBeTruthy();
    const phase2Migration = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get("2026-07-25-human-escalation-access-identity-v1");
    expect(phase2Migration).toBeTruthy();
    const runColumns = sqlite.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    expect(runColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "access_profile_snapshot_json",
      "policy_snapshot_provenance_json"
    ]));
    const followUpColumns = sqlite.prepare("PRAGMA table_info(follow_up_requests)").all() as Array<{ name: string }>;
    expect(followUpColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "access_profile_snapshot_json",
      "policy_snapshot_provenance_json"
    ]));
  });

  it("persists immutable requester, agent, and policy snapshots with the admitted run", async () => {
    const { repo } = repository();
    const policySnapshot: PolicySnapshotProvenance = {
      id: "policy_snapshot_1",
      source: "repo_binding",
      sourceRef: "github:acme/demo",
      rules: [],
      contentDigest: `sha256:${"a".repeat(64)}`,
      capturedAt: timestamp
    };
    const accessProfileSnapshot: AgentAccessProfileSnapshot = {
      id: "access_snapshot_1",
      agentPrincipal: { id: "opentag", kind: "opentag_agent" },
      requestedBy: { provider: "github", providerUserId: "user-1", handle: "octocat" },
      projectTargets: ["github:acme/demo"],
      connectionRefs: [],
      permissions: [],
      constraints: { locality: "local_required", allowedRunnerIds: ["runner-local"] },
      policySnapshotId: policySnapshot.id,
      capturedAt: timestamp
    };

    const created = await repo.createRun({
      id: "run-access-snapshot",
      event: githubEvent("event-access-snapshot", "delivery-access-snapshot"),
      accessProfileSnapshot,
      policySnapshotProvenance: policySnapshot
    });
    expect(created.run).toMatchObject({ accessProfileSnapshot, policySnapshotProvenance: policySnapshot });
    await expect(repo.createRun({
      id: "run-policy-only-invalid",
      event: githubEvent("event-policy-only-invalid", "delivery-policy-only-invalid"),
      policySnapshotProvenance: policySnapshot
    })).rejects.toThrow(/attached together/u);
    await expect(repo.createRun({
      id: "run-access-snapshot-replay",
      event: githubEvent("event-access-snapshot", "delivery-access-snapshot"),
      accessProfileSnapshot: { ...accessProfileSnapshot, requestedBy: { provider: "github", providerUserId: "different" } },
      policySnapshotProvenance: policySnapshot
    })).resolves.toMatchObject({ created: false, run: { accessProfileSnapshot } });
  });

  it("blocks new attempts after an access snapshot expires and opens one durable escalation", async () => {
    const { repo } = repository();
    await repo.registerRunner({ runnerId: "runner-local", name: "Local runner" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner-local" });
    const policySnapshot: PolicySnapshotProvenance = {
      id: "policy_snapshot_expiring",
      source: "repo_binding",
      sourceRef: "github:acme/demo",
      rules: [],
      contentDigest: `sha256:${"b".repeat(64)}`,
      capturedAt: timestamp
    };
    const accessProfileSnapshot: AgentAccessProfileSnapshot = {
      id: "access_snapshot_expiring",
      agentPrincipal: { id: "opentag", kind: "opentag_agent" },
      requestedBy: { provider: "github", providerUserId: "user-1", handle: "octocat" },
      projectTargets: ["github:acme/demo"],
      connectionRefs: [],
      permissions: [],
      constraints: { locality: "local_required", allowedRunnerIds: ["runner-local"] },
      policySnapshotId: policySnapshot.id,
      capturedAt: timestamp,
      expiresAt: "2026-07-22T10:00:00.000Z"
    };
    const created = await repo.createRun({
      id: "run-expired-access",
      event: githubEvent("event-expired-access", "delivery-expired-access"),
      accessProfileSnapshot,
      policySnapshotProvenance: policySnapshot
    });

    await expect(repo.claimNextRun({ runnerId: "runner-local", leaseSeconds: 60 })).resolves.toBeNull();
    await expect(repo.getRun({ runId: created.run.id })).resolves.toMatchObject({ run: { status: "needs_approval" } });
    await expect(repo.listHumanEscalations({ workThreadId: created.run.thread!.id! })).resolves.toMatchObject([
      { class: "security", state: "open", runId: created.run.id, subjectRef: accessProfileSnapshot.id }
    ]);
    await expect(repo.claimNextRun({ runnerId: "runner-local", leaseSeconds: 60 })).resolves.toBeNull();
    await expect(repo.listHumanEscalations({ workThreadId: created.run.thread!.id! })).resolves.toHaveLength(1);
  });

  it("skips a run for an ineligible polling runner without blocking its eligible runner", async () => {
    const { repo } = repository();
    await repo.registerRunner({ runnerId: "runner-local", name: "Local runner" });
    await repo.registerRunner({ runnerId: "runner-other", name: "Other runner" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner-local" });
    const policySnapshot: PolicySnapshotProvenance = {
      id: "policy_snapshot_runner_scope",
      source: "repo_binding",
      sourceRef: "github:acme/demo",
      rules: [],
      contentDigest: `sha256:${"d".repeat(64)}`,
      capturedAt: timestamp
    };
    const accessProfileSnapshot: AgentAccessProfileSnapshot = {
      id: "access_snapshot_runner_scope",
      agentPrincipal: { id: "opentag", kind: "opentag_agent" },
      requestedBy: { provider: "github", providerUserId: "user-1", handle: "octocat" },
      projectTargets: ["github:acme/demo"],
      connectionRefs: [],
      permissions: [],
      constraints: { locality: "local_required", allowedRunnerIds: ["runner-local"] },
      policySnapshotId: policySnapshot.id,
      capturedAt: timestamp
    };
    const created = await repo.createRun({
      id: "run-runner-scoped-access",
      event: githubEvent("event-runner-scoped-access", "delivery-runner-scoped-access"),
      accessProfileSnapshot,
      policySnapshotProvenance: policySnapshot
    });

    await expect(repo.claimNextRun({ runnerId: "runner-other", leaseSeconds: 60 })).resolves.toBeNull();
    await expect(repo.getRun({ runId: created.run.id })).resolves.toMatchObject({ run: { status: "queued" } });
    await expect(repo.listHumanEscalations({ workThreadId: created.run.thread!.id! })).resolves.toEqual([]);
    await expect(repo.claimNextRun({ runnerId: "runner-local", leaseSeconds: 60 })).resolves.toMatchObject({
      run: { id: created.run.id, assignedRunnerId: "runner-local" }
    });
  });

  it("carries queued follow-up access identity into promotion and rechecks it before execution", async () => {
    const { repo } = repository();
    await repo.registerRunner({ runnerId: "runner-local", name: "Local runner" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner-local" });
    const policySnapshot: PolicySnapshotProvenance = {
      id: "policy_snapshot_follow_up",
      source: "repo_binding",
      sourceRef: "github:acme/demo",
      rules: [],
      contentDigest: `sha256:${"c".repeat(64)}`,
      capturedAt: timestamp
    };
    const accessProfileSnapshot: AgentAccessProfileSnapshot = {
      id: "access_snapshot_follow_up",
      agentPrincipal: { id: "opentag", kind: "opentag_agent" },
      requestedBy: { provider: "github", providerUserId: "user-1", handle: "octocat" },
      projectTargets: ["github:acme/demo"],
      connectionRefs: [],
      permissions: [],
      constraints: { locality: "local_required", allowedRunnerIds: ["runner-local"] },
      policySnapshotId: policySnapshot.id,
      capturedAt: timestamp,
      expiresAt: "2026-07-22T10:00:00.000Z"
    };
    const event = githubEvent("event-follow-up-access", "delivery-follow-up-access");
    const queued = await repo.createFollowUpRequest({
      id: "follow-up-access",
      event,
      decision: {
        action: "queue_follow_up",
        reason: "An active run owns this thread.",
        reasonCode: "active_run_same_thread",
        decidedAt: timestamp,
        activeRunId: "run-parent-follow-up",
        eventId: event.id
      },
      activeRunId: "run-parent-follow-up",
      accessProfileSnapshot,
      policySnapshotProvenance: policySnapshot
    });
    expect(queued.followUpRequest).toMatchObject({ accessProfileSnapshot, policySnapshotProvenance: policySnapshot });

    const promoted = await repo.createRunFromFollowUpRequest({
      followUpRequestId: queued.followUpRequest.id,
      runId: "run-promoted-follow-up-access"
    });
    expect(promoted.run).toMatchObject({ accessProfileSnapshot, policySnapshotProvenance: policySnapshot });
    await expect(repo.claimNextRun({ runnerId: "runner-local", leaseSeconds: 60 })).resolves.toBeNull();
    await expect(repo.getRun({ runId: promoted.run.id })).resolves.toMatchObject({ run: { status: "needs_approval" } });
  });

  it("reuses one durable WorkThread across anchors and attaches created runs", async () => {
    const { repo } = repository();
    const first = await repo.upsertWorkThread({ thread: workThread({ id: "legacy-anchor-derived", anchorId: "comment-1" }) });
    const second = await repo.upsertWorkThread({ thread: workThread({ id: "different-anchor-derived", anchorId: "comment-2" }) });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.thread.id).toBe(first.thread.id);
    expect(second.thread.secondaryAnchors).toHaveLength(1);

    const created = await repo.createRun({ id: "run-1", event: githubEvent("event-1", "delivery-1") });
    expect(created.run.thread?.id).toBe(first.thread.id);
    expect((await repo.getRun({ runId: "run-1" }))?.run.thread?.id).toBe(first.thread.id);
  });

  it("keeps contract snapshots immutable and evidence replay-safe", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-1" }) })).thread;
    const contract = strictContract(thread.id);

    await expect(repo.recordCompletionContract({ contract })).resolves.toMatchObject({ created: true });
    await expect(repo.recordCompletionContract({ contract })).resolves.toMatchObject({ created: false });
    await expect(repo.recordCompletionContract({ contract: { ...contract, maxAutomaticRetries: 2 } })).rejects.toThrow(/immutable/u);

    const evidenceInput = {
      workThreadId: thread.id,
      provider: "github",
      deliveryId: "delivery-checks-1",
      subjectRef: "github:acme/demo:pull_request:7",
      subjectVersion: "abc123",
      evidence: {
        id: "evidence-checks-1",
        kind: "source_control.required_checks",
        assurance: "verified" as const,
        subjectRef: "github:acme/demo:pull_request:7:head:abc123",
        summary: "Configured required checks passed for the current head.",
        createdAt: timestamp
      },
      observedAt: timestamp,
      receivedAt: timestamp
    };
    await expect(repo.recordVerificationEvidence(evidenceInput)).resolves.toMatchObject({ created: true });
    await expect(repo.recordVerificationEvidence(evidenceInput)).resolves.toMatchObject({ created: false });
    await expect(repo.recordVerificationEvidence({
      ...evidenceInput,
      payloadDigest: `sha256:${"f".repeat(64)}`
    })).rejects.toThrow(/conflicts/u);
    await expect(repo.listVerificationEvidence({ workThreadId: thread.id })).resolves.toHaveLength(1);
  });

  it("records a reconciled evidence batch atomically and idempotently", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-batch" }) })).thread;
    const records = ["source_control.pull_request", "source_control.required_checks"].map((kind, index) => ({
      id: `evidence-batch-${index}`,
      workThreadId: thread.id,
      provider: "github",
      deliveryId: "delivery-batch-1",
      subjectRef: "github:acme/demo:pull_request:7",
      subjectVersion: "abc123",
      evidence: {
        id: `evidence-batch-${index}`,
        kind,
        assurance: "verified" as const,
        subjectRef: "github:acme/demo:pull_request:7@abc123",
        summary: `${kind}=verified`,
        createdAt: timestamp
      },
      payloadDigest: `sha256:${String(index + 1).repeat(64)}`,
      observedAt: timestamp,
      receivedAt: timestamp
    }));

    await expect(repo.recordVerificationEvidenceBatch({ records })).resolves.toMatchObject({ created: 2 });
    await expect(repo.recordVerificationEvidenceBatch({ records })).resolves.toMatchObject({ created: 0 });
    await expect(repo.listVerificationEvidence({ workThreadId: thread.id })).resolves.toHaveLength(2);

    const { repo: rollbackRepo } = repository();
    const rollbackThread = (await rollbackRepo.upsertWorkThread({ thread: workThread({ anchorId: "comment-rollback" }) })).thread;
    const conflictingIds = records.map((record, index) => ({
      ...record,
      id: "same-primary-key",
      workThreadId: rollbackThread.id,
      deliveryId: "delivery-batch-rollback",
      evidence: { ...record.evidence, id: "same-primary-key", kind: `kind-${index}` }
    }));
    await expect(rollbackRepo.recordVerificationEvidenceBatch({ records: conflictingIds })).rejects.toThrow();
    await expect(rollbackRepo.listVerificationEvidence({ workThreadId: rollbackThread.id })).resolves.toHaveLength(0);
  });

  it("appends one monotonic assessment lineage and rejects a stale head", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-1" }) })).thread;
    await repo.recordCompletionContract({ contract: strictContract(thread.id) });

    const first = assessment({ id: "assessment-1", workThreadId: thread.id, sequence: 1, digestChar: "a" });
    const second = assessment({ id: "assessment-2", workThreadId: thread.id, sequence: 2, digestChar: "b", supersedesAssessmentId: first.id });
    const staleCompetitor = assessment({ id: "assessment-stale", workThreadId: thread.id, sequence: 2, digestChar: "c", supersedesAssessmentId: first.id });

    await expect(repo.appendCompletionAssessment({ assessment: first, expectedCurrentAssessmentId: null })).resolves.toMatchObject({ outcome: "recorded" });
    await expect(repo.appendCompletionAssessment({ assessment: first, expectedCurrentAssessmentId: null })).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(repo.appendCompletionAssessment({ assessment: second, expectedCurrentAssessmentId: first.id })).resolves.toMatchObject({ outcome: "recorded" });
    await expect(repo.appendCompletionAssessment({ assessment: staleCompetitor, expectedCurrentAssessmentId: first.id })).resolves.toMatchObject({
      outcome: "conflict",
      currentAssessment: { id: second.id }
    });

    await expect(repo.listCompletionAssessments({ workThreadId: thread.id })).resolves.toEqual([first, second]);
    await expect(repo.getCurrentCompletionAssessment({ workThreadId: thread.id })).resolves.toEqual(second);
  });

  it("records the completion metric exactly once at the first accepted transition", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-metric" }) })).thread;
    await repo.recordCompletionContract({ contract: strictContract(thread.id) });
    const pending = assessment({ id: "assessment-metric-pending", workThreadId: thread.id, sequence: 1, digestChar: "d" });
    const acceptedAt = "2026-07-21T10:05:00.000Z";
    const accepted = assessment({
      id: "assessment-metric-accepted",
      workThreadId: thread.id,
      sequence: 2,
      digestChar: "e",
      supersedesAssessmentId: pending.id,
      state: "satisfied",
      acceptedAt
    });
    const stillAccepted = assessment({
      id: "assessment-metric-still-accepted",
      workThreadId: thread.id,
      sequence: 3,
      digestChar: "f",
      supersedesAssessmentId: accepted.id,
      state: "satisfied",
      acceptedAt
    });

    await repo.appendCompletionAssessment({ assessment: pending, expectedCurrentAssessmentId: null });
    await repo.appendCompletionAssessment({ assessment: accepted, expectedCurrentAssessmentId: pending.id });
    await repo.appendCompletionAssessment({ assessment: stillAccepted, expectedCurrentAssessmentId: accepted.id });

    const metrics = (await repo.listGovernanceEvents({ workThreadId: thread.id }))
      .filter((event) => event.type === "success_metric.observed");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      subjectId: accepted.id,
      createdAt: acceptedAt,
      payload: {
        metric: "time_to_verified_completion_ms",
        acceptedAt,
        state: "satisfied",
        evidenceBacked: true
      }
    });
  });

  it("loads durable material receipts for a WorkThread with their governed action family", async () => {
    const { sqlite, repo } = repository();
    const created = await repo.createRun({ id: "run-receipt", event: githubEvent("event-receipt", "delivery-receipt") });
    const workThreadId = created.run.thread!.id;
    const receipt = {
      id: "receipt-release-1",
      actionId: "action-release-1",
      provider: "github",
      receiptRef: "github:release:1",
      outcome: "succeeded",
      observedAt: timestamp
    };
    sqlite.prepare(`
      INSERT INTO material_actions (
        id, run_id, attempt_id, action_family, capability, scope_json, target_json,
        risk_tier, status, idempotency_key, attempt_fence_digest, receipt_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.actionId,
      created.run.id,
      "attempt-receipt",
      "release",
      "release:publish",
      "{}",
      "{}",
      "high",
      "succeeded",
      "release-once",
      `sha256:${"a".repeat(64)}`,
      JSON.stringify(receipt),
      timestamp,
      timestamp
    );

    await expect(repo.listMaterialActionReceiptsForWorkThread({ workThreadId })).resolves.toEqual([{
      ...receipt,
      metadata: { actionFamily: "release" }
    }]);
  });

  it("persists an attributed current-contract waiver idempotently and audits it", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-waiver" }) })).thread;
    await repo.recordCompletionContract({ contract: strictContract(thread.id) });
    const waiver: CompletionWaiver = {
      id: "waiver-current-contract",
      contractId: "contract-1",
      contractVersion: 1,
      cycle: 1,
      actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
      reason: "The merge gate is intentionally deferred for this bounded cycle.",
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["merge"],
      waivedAt: timestamp,
      expiresAt: "2026-07-22T10:00:00.000Z"
    };

    await expect(repo.recordCompletionWaiver({ waiver })).resolves.toMatchObject({ created: true, waiver });
    await expect(repo.recordCompletionWaiver({ waiver })).resolves.toMatchObject({ created: false, waiver });
    await expect(repo.listCompletionWaivers({ workThreadId: thread.id })).resolves.toEqual([waiver]);
    await expect(repo.recordCompletionWaiver({ waiver: { ...waiver, reason: "Different reason." } })).rejects.toThrow(/immutable/u);

    const events = await repo.listGovernanceEvents({ workThreadId: thread.id });
    expect(events.filter((event) => event.type === "completion_waiver.recorded")).toEqual([
      expect.objectContaining({
        subjectId: waiver.id,
        payload: expect.objectContaining({
          actor: waiver.actor,
          reason: waiver.reason,
          gateIds: waiver.gateIds,
          policyScope: waiver.policyScope
        })
      })
    ]);
  });

  it("redacts credential-like waiver text at the durable storage boundary", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-waiver-secret" }) })).thread;
    await repo.recordCompletionContract({ contract: strictContract(thread.id) });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const result = await repo.recordCompletionWaiver({
      waiver: {
        id: "waiver-redacted",
        contractId: "contract-1",
        contractVersion: 1,
        cycle: 1,
        actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
        reason: `Emergency exception requested with token ${secret}`,
        scope: "selected_gates",
        policyScope: "work_context_owner_container",
        gateIds: ["merge"],
        waivedAt: timestamp
      }
    });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.waiver.reason).toContain("[redacted]");
    expect(JSON.stringify(await repo.listCompletionWaivers({ workThreadId: thread.id }))).not.toContain(secret);
    expect(JSON.stringify(await repo.listGovernanceEvents({ workThreadId: thread.id }))).not.toContain(secret);
  });

  it("deduplicates active human escalations and retains attributed resolution", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-1" }) })).thread;
    const open: HumanEscalation = {
      id: "escalation-1",
      workThreadId: thread.id,
      class: "verification",
      audience: "repo_owner",
      subjectRef: "github:acme/demo:pull_request:7",
      state: "open",
      blocking: true,
      summary: "Required check evidence is unavailable.",
      reason: "The configured check has not reported for the current head.",
      dedupeKey: "verification:checks:primary_change",
      openedAt: timestamp
    };
    const duplicate = { ...open, id: "escalation-duplicate" };

    await expect(repo.openHumanEscalation({ escalation: open })).resolves.toMatchObject({ created: true });
    await expect(repo.openHumanEscalation({ escalation: duplicate })).resolves.toMatchObject({
      created: false,
      escalation: { id: open.id }
    });

    const resolved: HumanEscalation = {
      ...open,
      state: "resolved",
      resolution: {
        actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
        reason: "Repository check configuration repaired.",
        resolvedAt: "2026-07-21T10:05:00.000Z"
      }
    };
    await expect(repo.resolveHumanEscalation({ escalation: resolved })).resolves.toMatchObject({ resolved: true });
    await expect(repo.resolveHumanEscalation({ escalation: resolved })).resolves.toMatchObject({ resolved: false });
    await expect(repo.listHumanEscalations({ workThreadId: thread.id })).resolves.toEqual([resolved]);

    const events = await repo.listGovernanceEvents({ workThreadId: thread.id });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "work_thread.created",
      "human_escalation.opened",
      "human_escalation.resolved"
    ]));
  });

  it("attributes acknowledgement, validates bounded options, and expires authority-expanding escalations closed", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-lifecycle" }) })).thread;
    const open: HumanEscalation = {
      id: "escalation-lifecycle",
      workThreadId: thread.id,
      class: "approval",
      audience: "requester",
      subjectRef: "deployment:production",
      state: "open",
      blocking: true,
      summary: "Production deployment approval is required.",
      reason: "The action expands authority beyond the current run grant.",
      options: [
        { id: "approve", label: "Approve", consequence: "Allows one production deployment attempt." },
        { id: "deny", label: "Deny", consequence: "Leaves the deployment blocked." }
      ],
      dedupeKey: "deployment:production:v1",
      openedAt: timestamp,
      expiresAt: "2026-07-21T10:10:00.000Z"
    };
    await repo.openHumanEscalation({ escalation: open });

    const acknowledgingActor = { provider: "github" as const, providerUserId: "user-1", handle: "octocat" };
    await expect(repo.transitionHumanEscalation({
      id: open.id,
      toState: "acknowledged",
      actor: acknowledgingActor,
      at: "2026-07-21T10:01:00.000Z"
    })).resolves.toMatchObject({ changed: true, escalation: { state: "acknowledged" } });
    await expect(repo.transitionHumanEscalation({
      id: open.id,
      toState: "acknowledged",
      actor: acknowledgingActor,
      at: "2026-07-21T10:01:30.000Z"
    })).resolves.toMatchObject({ changed: false, escalation: { state: "acknowledged" } });
    await expect(repo.transitionHumanEscalation({
      id: open.id,
      toState: "acknowledged",
      actor: { provider: "github", providerUserId: "user-2", handle: "maintainer" },
      at: "2026-07-21T10:01:30.000Z"
    })).rejects.toThrow(/different acknowledgement/u);
    await expect(repo.transitionHumanEscalation({
      id: open.id,
      toState: "resolved",
      actor: { provider: "github", providerUserId: "user-1", handle: "octocat" },
      optionId: "not-offered",
      at: "2026-07-21T10:02:00.000Z"
    })).rejects.toThrow(/optionId/u);
    await expect(repo.transitionHumanEscalation({
      id: open.id,
      toState: "expired",
      at: "2026-07-21T10:05:00.000Z",
      reason: "Expiry sweep."
    })).rejects.toThrow(/has not reached expiresAt/u);

    await expect(repo.expireHumanEscalations({ at: "2026-07-21T10:10:00.000Z", workThreadId: thread.id }))
      .resolves.toMatchObject({ expired: 1 });
    const [expired] = await repo.listHumanEscalations({ workThreadId: thread.id });
    expect(expired).toMatchObject({ state: "expired", terminalReason: "Escalation expired without implicit approval." });
    expect(expired?.resolution).toBeUndefined();
    expect((await repo.listGovernanceEvents({ workThreadId: thread.id })).map((event) => event.type)).toEqual(expect.arrayContaining([
      "human_escalation.acknowledged",
      "human_escalation.expired"
    ]));

    const lateResolution: HumanEscalation = {
      ...open,
      id: "escalation-late-resolution",
      dedupeKey: "deployment:production:late:v1"
    };
    await repo.openHumanEscalation({ escalation: lateResolution });
    await expect(repo.transitionHumanEscalation({
      id: lateResolution.id,
      toState: "resolved",
      actor: acknowledgingActor,
      optionId: "approve",
      reason: "This decision arrived too late.",
      at: lateResolution.expiresAt!
    })).resolves.toMatchObject({
      changed: true,
      escalation: {
        state: "expired",
        terminalReason: "Escalation expired without implicit approval."
      }
    });
    expect((await repo.getHumanEscalation({ id: lateResolution.id }))?.resolution).toBeUndefined();
  });

  it("continues an expiry sweep when one candidate changes concurrently", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-expiry-race" }) })).thread;
    const first: HumanEscalation = {
      id: "escalation-expiry-race-1",
      workThreadId: thread.id,
      class: "approval",
      audience: "requester",
      subjectRef: "deployment:first",
      state: "open",
      blocking: true,
      summary: "First approval expires.",
      reason: "The first bounded decision is still open.",
      dedupeKey: "expiry-race:first:v1",
      openedAt: timestamp,
      expiresAt: "2026-07-21T10:10:00.000Z"
    };
    const second: HumanEscalation = {
      ...first,
      id: "escalation-expiry-race-2",
      subjectRef: "deployment:second",
      summary: "Second approval expires.",
      dedupeKey: "expiry-race:second:v1"
    };
    await repo.openHumanEscalation({ escalation: first });
    await repo.openHumanEscalation({ escalation: second });
    const transition = repo.transitionHumanEscalation.bind(repo);
    repo.transitionHumanEscalation = async (input) => {
      if (input.id === first.id) throw new Error("simulated concurrent terminal transition");
      return transition(input);
    };

    await expect(repo.expireHumanEscalations({
      at: "2026-07-21T10:10:00.000Z",
      workThreadId: thread.id
    })).resolves.toEqual({ scanned: 2, expired: 1 });
    await expect(repo.getHumanEscalation({ id: first.id })).resolves.toMatchObject({ state: "open" });
    await expect(repo.getHumanEscalation({ id: second.id })).resolves.toMatchObject({ state: "expired" });
  });

  it("supersedes an escalation only with a successor in the same WorkThread", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-supersession" }) })).thread;
    const foreignThreadInput = workThread({ anchorId: "comment-supersession-foreign" });
    foreignThreadInput.workItemReference = {
      ...foreignThreadInput.workItemReference,
      externalId: "acme/demo#43",
      uri: "https://github.com/acme/demo/issues/43"
    };
    foreignThreadInput.primaryAnchor = {
      ...foreignThreadInput.primaryAnchor,
      uri: "https://github.com/acme/demo/issues/43#comment-supersession-foreign",
      threadKey: "acme/demo#43"
    };
    const foreignThread = (await repo.upsertWorkThread({ thread: foreignThreadInput })).thread;
    const predecessor: HumanEscalation = {
      id: "escalation-superseded",
      workThreadId: thread.id,
      class: "configuration",
      audience: "operator",
      subjectRef: "configuration:provider",
      state: "open",
      blocking: true,
      summary: "Provider configuration is stale.",
      reason: "The provider settings need a new decision.",
      dedupeKey: "configuration:provider:v1",
      openedAt: timestamp
    };
    const successor: HumanEscalation = {
      ...predecessor,
      id: "escalation-successor",
      dedupeKey: "configuration:provider:v2",
      summary: "Provider configuration needs an updated decision."
    };
    const foreignSuccessor: HumanEscalation = {
      ...successor,
      id: "escalation-foreign-successor",
      workThreadId: foreignThread.id,
      dedupeKey: "configuration:provider:foreign:v2"
    };
    await repo.openHumanEscalation({ escalation: predecessor });
    await repo.openHumanEscalation({ escalation: successor });
    await repo.openHumanEscalation({ escalation: foreignSuccessor });

    await expect(repo.transitionHumanEscalation({
      id: predecessor.id,
      toState: "superseded",
      supersededById: predecessor.id,
      at: "2026-07-21T10:01:00.000Z"
    })).rejects.toThrow(/different supersededById/u);
    await expect(repo.transitionHumanEscalation({
      id: predecessor.id,
      toState: "superseded",
      supersededById: foreignSuccessor.id,
      at: "2026-07-21T10:01:00.000Z"
    })).rejects.toThrow(/same WorkThread/u);
    await expect(repo.transitionHumanEscalation({
      id: predecessor.id,
      toState: "superseded",
      supersededById: successor.id,
      reason: "A newer configuration decision replaced this request.",
      at: "2026-07-21T10:01:00.000Z"
    })).resolves.toMatchObject({
      changed: true,
      escalation: {
        state: "superseded",
        supersededById: successor.id,
        terminalReason: "A newer configuration decision replaced this request."
      }
    });
  });

  it("atomically links a needs-human run result to its durable escalation", async () => {
    const { repo } = repository();
    const created = await repo.createRun({ id: "run-needs-human", event: githubEvent("event-needs-human", "delivery-needs-human") });
    const workThreadId = created.run.thread?.id;
    if (!workThreadId) throw new Error("expected work thread");
    const escalation: HumanEscalation = {
      id: "escalation-run-needs-human",
      workThreadId,
      runId: created.run.id,
      class: "missing_input",
      audience: "requester",
      subjectRef: created.run.id,
      state: "open",
      blocking: true,
      summary: "Choose a target environment.",
      reason: "The executor cannot infer the deployment target.",
      nextAction: { kind: "request_human_decision", targetId: created.run.id },
      dedupeKey: "run-needs-human:target-environment:v1",
      openedAt: timestamp
    };

    await expect(repo.completeRun({
      runId: created.run.id,
      result: {
        conclusion: "needs_human",
        summary: "A deployment target is required.",
        humanEscalationId: escalation.id
      },
      humanEscalation: escalation
    })).resolves.toBe("completed");
    await expect(repo.getRun({ runId: created.run.id })).resolves.toMatchObject({
      run: { result: { conclusion: "needs_human", humanEscalationId: escalation.id } }
    });
    await expect(repo.listHumanEscalations({ workThreadId })).resolves.toMatchObject([
      { id: escalation.id, state: "open", runId: created.run.id }
    ]);
    const actor = { provider: "github" as const, providerUserId: "user-1", handle: "octocat" };
    await expect(repo.transitionHumanEscalation({
      id: escalation.id,
      toState: "resolved",
      actor,
      reason: "Use the staging environment.",
      at: "2026-07-21T10:05:00.000Z"
    })).resolves.toMatchObject({ changed: true, escalation: { state: "resolved" } });
    await expect(repo.transitionHumanEscalation({
      id: escalation.id,
      toState: "resolved",
      actor,
      reason: "Use the staging environment.",
      at: "2026-07-21T10:06:00.000Z"
    })).resolves.toMatchObject({ changed: false });
    await expect(repo.transitionHumanEscalation({
      id: escalation.id,
      toState: "resolved",
      actor,
      reason: "Use production instead.",
      at: "2026-07-21T10:06:00.000Z"
    })).rejects.toThrow(/different resolution/u);
  });

  it("reuses the authoritative active escalation when run completion races on its dedupe key", async () => {
    const { repo } = repository();
    const created = await repo.createRun({
      id: "run-needs-human-dedupe-race",
      event: githubEvent("event-needs-human-dedupe-race", "delivery-needs-human-dedupe-race")
    });
    const workThreadId = created.run.thread?.id;
    if (!workThreadId) throw new Error("expected work thread");
    const authoritative: HumanEscalation = {
      id: "escalation-authoritative",
      workThreadId,
      runId: created.run.id,
      class: "missing_input",
      audience: "requester",
      subjectRef: created.run.id,
      state: "open",
      blocking: true,
      summary: "Choose a target environment.",
      reason: "The executor cannot infer the deployment target.",
      dedupeKey: "target-environment:v1",
      openedAt: timestamp
    };
    const racing = { ...authoritative, id: "escalation-racing-completion" };
    await repo.openHumanEscalation({ escalation: authoritative });

    await expect(repo.completeRun({
      runId: created.run.id,
      result: {
        conclusion: "needs_human",
        summary: "A deployment target is required.",
        humanEscalationId: racing.id
      },
      humanEscalation: racing
    })).resolves.toBe("completed");
    await expect(repo.getRun({ runId: created.run.id })).resolves.toMatchObject({
      run: { result: { humanEscalationId: authoritative.id } }
    });
    await expect(repo.listHumanEscalations({ workThreadId })).resolves.toHaveLength(1);
    const openedEvents = (await repo.listGovernanceEvents({ workThreadId }))
      .filter((event) => event.type === "human_escalation.opened");
    expect(openedEvents).toHaveLength(1);
    expect(openedEvents[0]?.subjectId).toBe(authoritative.id);
  });

  it("records a stable unavailable reason when a direct persistence caller omits an escalation", async () => {
    const { repo } = repository();
    await repo.createRun({
      id: "run-needs-human-without-route",
      event: githubEvent("event-needs-human-without-route", "delivery-needs-human-without-route")
    });

    await expect(repo.completeRun({
      runId: "run-needs-human-without-route",
      result: {
        conclusion: "success",
        summary: "Invalid result.",
        humanEscalationId: "escalation_invalid_success"
      }
    })).rejects.toThrow(/only valid for a needs_human/u);

    await expect(repo.completeRun({
      runId: "run-needs-human-without-route",
      result: { conclusion: "needs_human", summary: "Operator input is required." }
    })).resolves.toBe("completed");
    await expect(repo.getRun({ runId: "run-needs-human-without-route" })).resolves.toMatchObject({
      run: {
        result: {
          conclusion: "needs_human",
          humanResolutionUnavailableReason: "No durable HumanEscalation was supplied at this persistence boundary."
        }
      }
    });
  });
});
