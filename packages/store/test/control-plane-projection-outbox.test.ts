import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ControlPlaneProjectionOutboxValidationError,
  createOpenTagRepository
} from "../src/repository.js";
import { canonicalSha256Json } from "../src/canonical-json.js";
import { migrateSchema } from "../src/schema.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-08-08T00:00:00.000Z");

function withProjectionDigests<T extends { payload: unknown }>(value: T) {
  const withPayloadDigest = { ...value, payloadDigest: canonicalSha256Json(value.payload) };
  return { ...withPayloadDigest, receiptDigest: canonicalSha256Json(withPayloadDigest) };
}

function workThreadReceipt(overrides: Record<string, unknown> = {}) {
  return withProjectionDigests({
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "work_thread_ref",
    receiptId: "receipt_work_thread_1",
    organizationId: "org_1",
    operationId: "operation_work_thread_1",
    requiredCapabilities: ["relay.work-thread-ref.v1"],
    producer: { kind: "local_opentag", id: "local_opentag" },
    identity: {
      namespace: "opentag.control.receipt/work-thread-ref/v1",
      parts: ["org_1", "run_1", "work_thread_1"]
    },
    observedAt: NOW.toISOString(),
    runId: "run_1",
    workThreadId: "work_thread_1",
    payload: {
      workThreadId: "work_thread_1",
      sourceIdentityDigest: DIGEST,
      localCreationReceiptId: "local_creation_1",
      localCreationReceiptDigest: DIGEST,
      lineageKind: "source_event",
      createdAt: NOW.toISOString()
    },
    ...overrides
  });
}

function callbackProviderReceipt(
  resourceIdentity = "github:comment:123",
  overrides: Record<string, unknown> = {}
) {
  return withProjectionDigests({
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "callback_provider_observation",
    receiptId: "receipt_callback_provider_1",
    organizationId: "org_1",
    operationId: "operation_callback_1",
    requiredCapabilities: ["relay.callback-observation.v1"],
    producer: { kind: "local_opentag", id: "local_opentag" },
    identity: {
      namespace: "opentag.control.receipt/callback-provider-observation/v1",
      parts: ["org_1", "work_thread_1", "intent_1", "callback_attempt_1", "provider_receipt_1"]
    },
    observedAt: NOW.toISOString(),
    runId: "run_1",
    workThreadId: "work_thread_1",
    payload: {
      localIntentId: "intent_1",
      localAttemptId: "callback_attempt_1",
      providerReceiptId: "provider_receipt_1",
      resourceIdentity,
      outcome: "succeeded",
      observedAt: NOW.toISOString()
    },
    ...overrides,
  });
}

function allowedReceipts() {
  const governed = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    organizationId: "org_1",
    producer: { kind: "local_opentag" as const, id: "local_opentag" },
    observedAt: NOW.toISOString(),
    runId: "run_1",
    workThreadId: "work_thread_1"
  };
  const attempt = {
    attemptId: "attempt_1",
    attemptNumber: 1,
    epoch: 1,
    fencingTokenDigest: DIGEST
  };
  return [
    withProjectionDigests({
      schemaVersion: 1,
      protocolVersion: "1.0",
      receiptKind: "runner_readiness",
      receiptId: "receipt_readiness",
      organizationId: "org_1",
      operationId: "operation_readiness",
      requiredCapabilities: ["relay.readiness.v1"],
      producer: { kind: "runner", id: "runner_1", credentialId: "credential_ref_1", registrationGeneration: 1 },
      identity: {
        namespace: "opentag.control.receipt/runner-readiness/v1",
        parts: ["org_1", "runner_1", "1", "readiness_1"]
      },
      observedAt: NOW.toISOString(),
      payload: {
        readinessId: "readiness_1",
        runnerId: "runner_1",
        registrationGeneration: 1,
        capabilities: ["relay.readiness.v1"],
        executors: [],
        targets: [],
        observedAt: NOW.toISOString(),
        expiresAt: "2026-08-08T00:01:00.000Z"
      }
    }),
    workThreadReceipt(),
    withProjectionDigests({
      ...governed,
      receiptKind: "completion_contract_ref",
      receiptId: "receipt_contract",
      operationId: "operation_contract",
      requiredCapabilities: ["relay.completion-contract-ref.v1"],
      identity: {
        namespace: "opentag.control.receipt/completion-contract-ref/v1",
        parts: ["org_1", "work_thread_1", "contract_1", "1", "1"]
      },
      payload: {
        contractId: "contract_1",
        version: 1,
        cycle: 1,
        mode: "governed",
        contentDigest: DIGEST,
        resolvedTargetDigests: [DIGEST],
        requiredGateIds: ["checks"],
        createdAt: NOW.toISOString()
      }
    }),
    withProjectionDigests({
      ...governed,
      receiptKind: "completion_assessment",
      receiptId: "receipt_assessment",
      operationId: "operation_assessment",
      requiredCapabilities: ["relay.completion-assessment.v1"],
      attempt,
      identity: {
        namespace: "opentag.control.receipt/completion-assessment/v1",
        parts: ["org_1", "work_thread_1", "assessment_1"]
      },
      payload: {
        assessmentId: "assessment_1",
        workThreadId: "work_thread_1",
        contract: { contractId: "contract_1", version: 1, cycle: 1, contentDigest: DIGEST },
        admissionPolicySnapshot: { snapshotId: "policy_1", digest: DIGEST },
        runId: "run_1",
        attempt,
        assessmentInputDigest: DIGEST,
        evidenceReceiptDigests: [DIGEST],
        gateResults: [{
          gateId: "checks",
          state: "satisfied",
          reasonCode: "verification_passed",
          evidenceReceiptDigests: [DIGEST]
        }],
        conclusion: "satisfied",
        assessedAt: NOW.toISOString(),
        assessedBy: "local_opentag"
      }
    }),
    withProjectionDigests({
      ...governed,
      receiptKind: "callback_intent_observation",
      receiptId: "receipt_callback_intent",
      operationId: "operation_callback",
      requiredCapabilities: ["relay.callback-observation.v1"],
      identity: {
        namespace: "opentag.control.receipt/callback-intent-observation/v1",
        parts: ["org_1", "work_thread_1", "intent_1"]
      },
      payload: {
        localIntentId: "intent_1",
        assessmentRef: "assessment_1",
        assessmentDigest: DIGEST,
        provider: "github",
        sourceThreadIdentityDigest: DIGEST,
        operationId: "operation_callback",
        payloadDigest: DIGEST,
        createdAt: NOW.toISOString()
      }
    }),
    withProjectionDigests({
      ...governed,
      receiptKind: "callback_attempt_observation",
      receiptId: "receipt_callback_attempt",
      operationId: "operation_callback_attempt",
      requiredCapabilities: ["relay.callback-observation.v1"],
      identity: {
        namespace: "opentag.control.receipt/callback-attempt-observation/v1",
        parts: ["org_1", "work_thread_1", "intent_1", "callback_attempt_1"]
      },
      payload: {
        localIntentId: "intent_1",
        localAttemptId: "callback_attempt_1",
        attemptNumber: 1,
        requestDigest: DIGEST,
        outcome: "accepted",
        reasonCode: "provider_accepted",
        attemptedAt: NOW.toISOString(),
        observedAt: NOW.toISOString()
      }
    }),
    callbackProviderReceipt()
  ];
}

function repository(sqlite = new Database(":memory:")) {
  migrateSchema(sqlite);
  return { sqlite, repo: createOpenTagRepository(drizzle(sqlite)) };
}

describe("control_plane_projection_outbox", () => {
  it("accepts exactly the seven current Control V1 projection receipt schemas", async () => {
    const { sqlite, repo } = repository();
    const outcomes = [];
    for (const envelope of allowedReceipts()) {
      outcomes.push(await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope, now: NOW }));
    }
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(Array(7).fill("created"));
    expect(sqlite.prepare("SELECT receipt_kind AS receiptKind FROM control_plane_projection_outbox ORDER BY receipt_kind")
      .all()).toHaveLength(7);
    sqlite.close();
  });

  it("migrates fresh and existing databases idempotently with strict state checks", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE legacy_data (id TEXT PRIMARY KEY)");
    migrateSchema(sqlite);
    migrateSchema(sqlite);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("control_plane_projection_outbox")).toBeTruthy();
    expect(sqlite.prepare("SELECT count(*) AS count FROM opentag_schema_migrations WHERE id = ?")
      .get("2026-08-08-control-plane-projection-outbox-v1")).toEqual({ count: 1 });
    expect(() => sqlite.prepare(`
      INSERT INTO control_plane_projection_outbox (
        receipt_id, destination_id, organization_id, receipt_kind, identity_namespace,
        identity_parts_json, identity_key, operation_id, payload_digest, receipt_digest,
        envelope_json, state, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'leased', 0, ?, ?)
    `).run(
      "invalid", "cloud", "org", "work_thread_ref", "namespace", "[]", "key", "operation",
      DIGEST, DIGEST, "{}", NOW.toISOString(), NOW.toISOString()
    )).toThrow();
    sqlite.close();
  });

  it("persists strict envelopes across restart and reuses exact replay", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-projection-outbox-"));
    const databasePath = path.join(directory, "store.sqlite");
    const first = repository(new Database(databasePath));
    const created = await first.repo.enqueueControlPlaneProjection({
      destinationId: "cloud_primary",
      envelope: workThreadReceipt(),
      now: NOW
    });
    expect(created).toMatchObject({ outcome: "created", entry: { state: "pending", runId: "run_1" } });
    first.sqlite.close();

    const second = repository(new Database(databasePath));
    await expect(second.repo.enqueueControlPlaneProjection({
      destinationId: "cloud_primary",
      envelope: workThreadReceipt(),
      now: new Date("2026-08-08T00:01:00.000Z")
    })).resolves.toMatchObject({ outcome: "replay", entry: { createdAt: NOW.toISOString() } });
    await expect(second.repo.getControlPlaneProjection({
      destinationId: "cloud_primary", organizationId: "org_1", receiptId: "receipt_work_thread_1"
    }))
      .resolves.toMatchObject({ identity: { parts: ["org_1", "run_1", "work_thread_1"] } });
    second.sqlite.close();
    fs.rmSync(directory, { recursive: true });
  });

  it("returns deterministic zero-mutation conflicts for identity and operation reuse", async () => {
    const { sqlite, repo } = repository();
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud_primary", envelope: workThreadReceipt(), now: NOW });
    const identityConflict = workThreadReceipt({
      receiptId: "receipt_other",
      operationId: "operation_other",
    });
    await expect(repo.enqueueControlPlaneProjection({ destinationId: "cloud_primary", envelope: identityConflict, now: NOW }))
      .resolves.toEqual({ outcome: "conflict", conflictOn: "identity", existingReceiptId: "receipt_work_thread_1" });
    const operationConflict = workThreadReceipt({
      receiptId: "receipt_other",
      identity: {
        namespace: "opentag.control.receipt/work-thread-ref/v1",
        parts: ["org_1", "run_2", "work_thread_2"]
      },
      runId: "run_2",
      workThreadId: "work_thread_2",
      payload: {
        ...workThreadReceipt().payload,
        workThreadId: "work_thread_2"
      }
    });
    await expect(repo.enqueueControlPlaneProjection({ destinationId: "cloud_primary", envelope: operationConflict, now: NOW }))
      .resolves.toEqual({ outcome: "conflict", conflictOn: "operation", existingReceiptId: "receipt_work_thread_1" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM control_plane_projection_outbox").get()).toEqual({ count: 1 });
    sqlite.close();
  });

  it("treats receipt and operation identity as destination-and-tenant scoped", async () => {
    const { sqlite, repo } = repository();
    const tenantA = workThreadReceipt();
    const tenantB = workThreadReceipt({
      organizationId: "org_2",
      identity: {
        namespace: "opentag.control.receipt/work-thread-ref/v1",
        parts: ["org_2", "run_1", "work_thread_1"]
      }
    });
    await expect(repo.enqueueControlPlaneProjection({
      destinationId: "cloud", envelope: tenantA, now: NOW
    })).resolves.toMatchObject({ outcome: "created" });
    await expect(repo.enqueueControlPlaneProjection({
      destinationId: "cloud", envelope: tenantB, now: NOW
    })).resolves.toMatchObject({ outcome: "created" });
    await expect(repo.enqueueControlPlaneProjection({
      destinationId: "cloud_secondary", envelope: tenantA, now: NOW
    })).resolves.toMatchObject({ outcome: "created" });
    await expect(repo.enqueueControlPlaneProjection({
      destinationId: "cloud", envelope: tenantA, now: NOW
    })).resolves.toMatchObject({ outcome: "replay" });
    await expect(repo.getControlPlaneProjection({
      destinationId: "cloud", organizationId: "org_missing", receiptId: tenantA.receiptId
    })).resolves.toBeNull();

    const claimA = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud", organizationId: "org_1", leaseOwner: "uploader", leaseSeconds: 30, now: NOW
    });
    const before = sqlite.prepare(`
      SELECT state, attempt_count AS attemptCount, lease_token AS leaseToken
      FROM control_plane_projection_outbox
      WHERE destination_id = 'cloud' AND organization_id = 'org_1' AND receipt_id = ?
    `).get(tenantA.receiptId);
    await expect(repo.acknowledgeControlPlaneProjection({
      destinationId: "cloud",
      organizationId: "org_missing",
      receiptId: tenantA.receiptId,
      leaseToken: claimA.entries[0]!.leaseToken!,
      now: new Date("2026-08-08T00:00:01.000Z")
    })).resolves.toEqual({ outcome: "not_found" });
    expect(sqlite.prepare(`
      SELECT state, attempt_count AS attemptCount, lease_token AS leaseToken
      FROM control_plane_projection_outbox
      WHERE destination_id = 'cloud' AND organization_id = 'org_1' AND receipt_id = ?
    `).get(tenantA.receiptId)).toEqual(before);
    expect(sqlite.prepare("SELECT count(*) AS count FROM control_plane_projection_outbox").get())
      .toEqual({ count: 3 });
    sqlite.close();
  });

  it("uses a stable canonical identity digest without colliding distinct identities", async () => {
    const { sqlite, repo } = repository();
    const first = workThreadReceipt();
    const reordered = {
      ...first,
      identity: { parts: [...first.identity.parts], namespace: first.identity.namespace }
    };
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: first, now: NOW });
    await expect(repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: reordered, now: NOW }))
      .resolves.toMatchObject({ outcome: "replay" });
    const different = workThreadReceipt({
      receiptId: "receipt_work_thread_2",
      operationId: "operation_work_thread_2",
      runId: "run_2",
      workThreadId: "work_thread_2",
      identity: {
        namespace: "opentag.control.receipt/work-thread-ref/v1",
        parts: ["org_1", "run_2", "work_thread_2"]
      },
      payload: { ...workThreadReceipt().payload, workThreadId: "work_thread_2" }
    });
    await expect(repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: different, now: NOW }))
      .resolves.toMatchObject({ outcome: "created" });
    const keys = sqlite.prepare("SELECT identity_key AS identityKey FROM control_plane_projection_outbox ORDER BY receipt_id")
      .all() as Array<{ identityKey: string }>;
    expect(keys).toHaveLength(2);
    expect(keys[0]!.identityKey).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(keys[0]!.identityKey).not.toBe(keys[1]!.identityKey);
    sqlite.close();
  });

  it("recomputes payload and receipt digests and rejects tampering with zero writes", async () => {
    const { sqlite, repo } = repository();
    const valid = workThreadReceipt();
    await expect(repo.enqueueControlPlaneProjection({
      destinationId: "cloud",
      envelope: { ...valid, payloadDigest: DIGEST },
      now: NOW
    })).rejects.toMatchObject({ code: "projection_digest_mismatch" });
    await expect(repo.enqueueControlPlaneProjection({
      destinationId: "cloud",
      envelope: { ...valid, receiptDigest: DIGEST },
      now: NOW
    })).rejects.toMatchObject({ code: "projection_digest_mismatch" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM control_plane_projection_outbox").get()).toEqual({ count: 0 });
    sqlite.close();
  });

  it("guards immutable rows against raw update, delete, and INSERT OR REPLACE", async () => {
    const { sqlite, repo } = repository();
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: workThreadReceipt(), now: NOW });
    const { entries: [claimed] } = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud", organizationId: "org_1", leaseOwner: "uploader", leaseSeconds: 30, now: NOW
    });
    await expect(repo.acknowledgeControlPlaneProjection({
      destinationId: "cloud", organizationId: "org_1",
      receiptId: claimed!.receiptId,
      leaseToken: claimed!.leaseToken!,
      httpStatus: 200,
      now: new Date("2026-08-08T00:00:01.000Z")
    })).resolves.toMatchObject({ outcome: "acknowledged", entry: { state: "acknowledged" } });
    const before = sqlite.prepare("SELECT * FROM control_plane_projection_outbox WHERE receipt_id = ?")
      .get("receipt_work_thread_1");
    expect(() => sqlite.prepare("UPDATE control_plane_projection_outbox SET receipt_digest = ? WHERE receipt_id = ?")
      .run(`sha256:${"c".repeat(64)}`, "receipt_work_thread_1")).toThrow(/immutable/u);
    expect(() => sqlite.prepare("DELETE FROM control_plane_projection_outbox WHERE receipt_id = ?")
      .run("receipt_work_thread_1")).toThrow(/delete_forbidden/u);
    expect(() => sqlite.prepare(`
      INSERT OR REPLACE INTO control_plane_projection_outbox
      SELECT * FROM control_plane_projection_outbox WHERE receipt_id = ?
    `).run("receipt_work_thread_1")).toThrow(/duplicate_insert/u);
    expect(sqlite.prepare("SELECT * FROM control_plane_projection_outbox WHERE receipt_id = ?")
      .get("receipt_work_thread_1")).toEqual(before);
    sqlite.close();
  });

  it("rejects raw non-initial inserts, malformed metadata, and illegal transitions", async () => {
    const { sqlite, repo } = repository();
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: workThreadReceipt(), now: NOW });
    expect(() => sqlite.prepare(`
      INSERT INTO control_plane_projection_outbox
      SELECT receipt_id, 'raw_leased', organization_id, runner_id, run_id,
        work_thread_id, receipt_kind, identity_namespace, identity_parts_json,
        identity_key, operation_id, payload_digest, receipt_digest, envelope_json,
        'leased', 1, next_attempt_at, 'unsafe owner', 'token',
        '2026-08-08T00:01:00.000Z', NULL, NULL, created_at, updated_at, NULL
      FROM control_plane_projection_outbox WHERE destination_id = 'cloud'
    `).run()).toThrow(/insert_invalid/u);
    expect(() => sqlite.prepare(`
      INSERT INTO control_plane_projection_outbox
      SELECT receipt_id, 'raw_digest', organization_id, runner_id, run_id,
        work_thread_id, receipt_kind, identity_namespace, identity_parts_json,
        identity_key, operation_id, 'sha256:bad', receipt_digest, envelope_json,
        state, attempt_count, next_attempt_at, lease_owner, lease_token,
        lease_expires_at, last_reason_code, last_http_status, created_at, updated_at,
        acknowledged_at
      FROM control_plane_projection_outbox WHERE destination_id = 'cloud'
    `).run()).toThrow();
    expect(() => sqlite.prepare(`
      INSERT INTO control_plane_projection_outbox
      SELECT receipt_id, 'raw_kind', organization_id, runner_id, run_id,
        work_thread_id, 'unknown_kind', identity_namespace, identity_parts_json,
        identity_key, operation_id, payload_digest, receipt_digest, envelope_json,
        state, attempt_count, next_attempt_at, lease_owner, lease_token,
        lease_expires_at, last_reason_code, last_http_status, created_at, updated_at,
        acknowledged_at
      FROM control_plane_projection_outbox WHERE destination_id = 'cloud'
    `).run()).toThrow();
    expect(() => sqlite.prepare(`
      INSERT INTO control_plane_projection_outbox
      SELECT receipt_id, 'raw_json', organization_id, runner_id, run_id,
        work_thread_id, receipt_kind, identity_namespace, identity_parts_json,
        identity_key, operation_id, payload_digest, receipt_digest, 'not-json',
        state, attempt_count, next_attempt_at, lease_owner, lease_token,
        lease_expires_at, last_reason_code, last_http_status, created_at, updated_at,
        acknowledged_at
      FROM control_plane_projection_outbox WHERE destination_id = 'cloud'
    `).run()).toThrow();
    expect(() => sqlite.prepare(`
      INSERT INTO control_plane_projection_outbox
      SELECT receipt_id, 'raw_extracted', organization_id, runner_id, run_id,
        'wrong_thread', receipt_kind, identity_namespace, identity_parts_json,
        identity_key, operation_id, payload_digest, receipt_digest, envelope_json,
        state, attempt_count, next_attempt_at, lease_owner, lease_token,
        lease_expires_at, last_reason_code, last_http_status, created_at, updated_at,
        acknowledged_at
      FROM control_plane_projection_outbox WHERE destination_id = 'cloud'
    `).run()).toThrow(/insert_invalid/u);
    expect(() => sqlite.prepare(`
      UPDATE control_plane_projection_outbox
      SET state = 'attention', next_attempt_at = NULL,
        last_reason_code = 'operator_required'
      WHERE destination_id = 'cloud'
    `).run()).toThrow(/transition_invalid/u);
    const unsafeOwnerTransition = sqlite.prepare(`
      UPDATE control_plane_projection_outbox
      SET state = 'leased', attempt_count = attempt_count + 1,
        lease_owner = ?, lease_token = 'token',
        lease_expires_at = '2026-08-08T00:01:00.000Z'
      WHERE destination_id = 'cloud'
    `);
    for (const unsafeOwner of ["https://unsafe.example/owner", "uploader/../secret"]) {
      expect(() => unsafeOwnerTransition.run(unsafeOwner)).toThrow(/transition_invalid/u);
    }

    const claim = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud", organizationId: "org_1", leaseOwner: "uploader", leaseSeconds: 30, now: NOW
    });
    expect(() => sqlite.prepare(`
      UPDATE control_plane_projection_outbox SET attempt_count = 0
      WHERE destination_id = 'cloud'
    `).run()).toThrow(/transition_invalid/u);
    expect(() => sqlite.prepare(`
      UPDATE control_plane_projection_outbox
      SET state = 'pending', next_attempt_at = ?, lease_owner = NULL,
        lease_token = NULL, lease_expires_at = NULL, last_reason_code = ?
      WHERE destination_id = 'cloud'
    `).run("2026-08-08T00:00:01.000Z", "https://secret.example/token"))
      .toThrow(/transition_invalid/u);
    await repo.acknowledgeControlPlaneProjection({
      destinationId: "cloud",
      organizationId: "org_1",
      receiptId: "receipt_work_thread_1",
      leaseToken: claim.entries[0]!.leaseToken!,
      now: new Date("2026-08-08T00:00:01.000Z")
    });
    expect(() => sqlite.prepare(`
      UPDATE control_plane_projection_outbox
      SET state = 'pending', next_attempt_at = ?, acknowledged_at = NULL
      WHERE destination_id = 'cloud'
    `).run("2026-08-08T00:00:02.000Z")).toThrow(/transition_invalid/u);
    sqlite.close();
  });

  it("fails closed when raw persistence disagrees with the canonical envelope", async () => {
    const { sqlite, repo } = repository();
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: workThreadReceipt(), now: NOW });
    sqlite.exec("DROP TRIGGER control_plane_projection_outbox_insert_guard");
    sqlite.prepare(`
      INSERT INTO control_plane_projection_outbox
      SELECT
        'forged_receipt', 'cloud_forged', 'org_forged', runner_id, run_id,
        work_thread_id, receipt_kind, identity_namespace, identity_parts_json,
        'forged_identity_key', 'forged_operation', payload_digest, receipt_digest,
        envelope_json, state, attempt_count, next_attempt_at, lease_owner,
        lease_token, lease_expires_at, last_reason_code, last_http_status,
        created_at, updated_at, acknowledged_at
      FROM control_plane_projection_outbox WHERE receipt_id = ?
    `).run("receipt_work_thread_1");
    await expect(repo.getControlPlaneProjection({
      destinationId: "cloud_forged", organizationId: "org_forged", receiptId: "forged_receipt"
    }))
      .rejects.toThrow("control_plane_projection_outbox_row_invalid");
    sqlite.close();
  });

  it("isolates a poisoned due row without blocking or returning valid tenant work", async () => {
    const { sqlite, repo } = repository();
    const poison = workThreadReceipt({
      receiptId: "a_poison",
      operationId: "operation_poison",
      identity: {
        namespace: "opentag.control.receipt/work-thread-ref/v1",
        parts: ["org_1", "run_poison", "thread_poison"]
      },
      runId: "run_poison",
      workThreadId: "thread_poison",
      payload: { ...workThreadReceipt().payload, workThreadId: "thread_poison" }
    });
    const valid = workThreadReceipt({
      receiptId: "z_valid",
      operationId: "operation_valid",
      identity: {
        namespace: "opentag.control.receipt/work-thread-ref/v1",
        parts: ["org_1", "run_valid", "thread_valid"]
      },
      runId: "run_valid",
      workThreadId: "thread_valid",
      payload: { ...workThreadReceipt().payload, workThreadId: "thread_valid" }
    });
    const metadataPoison = workThreadReceipt({
      receiptId: "b_metadata_poison",
      operationId: "operation_metadata_poison",
      identity: {
        namespace: "opentag.control.receipt/work-thread-ref/v1",
        parts: ["org_1", "run_metadata", "thread_metadata"]
      },
      runId: "run_metadata",
      workThreadId: "thread_metadata",
      payload: { ...workThreadReceipt().payload, workThreadId: "thread_metadata" }
    });
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: poison, now: NOW });
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: metadataPoison, now: NOW });
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: valid, now: NOW });
    sqlite.exec("DROP TRIGGER control_plane_projection_outbox_immutable_update_guard");
    sqlite.exec("DROP TRIGGER control_plane_projection_outbox_transition_guard");
    sqlite.prepare(`
      UPDATE control_plane_projection_outbox SET envelope_json = '{}'
      WHERE destination_id = 'cloud' AND organization_id = 'org_1' AND receipt_id = 'a_poison'
    `).run();
    sqlite.prepare(`
      UPDATE control_plane_projection_outbox SET last_reason_code = 'https://unsafe.example/reason'
      WHERE destination_id = 'cloud' AND organization_id = 'org_1' AND receipt_id = 'b_metadata_poison'
    `).run();

    const result = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud", organizationId: "org_1", leaseOwner: "uploader", leaseSeconds: 30, now: NOW
    });
    expect(result).toMatchObject({
      entries: [{ receiptId: "z_valid", state: "leased" }],
      rejected: [
        { receiptId: "a_poison", reasonCode: "stored_row_invalid" },
        { receiptId: "b_metadata_poison", reasonCode: "stored_row_invalid" }
      ]
    });
    expect(sqlite.prepare(`
      SELECT state, attempt_count AS attemptCount
      FROM control_plane_projection_outbox
      WHERE destination_id = 'cloud' AND organization_id = 'org_1' AND receipt_id = 'a_poison'
    `).get()).toEqual({ state: "pending", attemptCount: 0 });
    sqlite.close();
  });

  it("scopes list and CAS claims by destination and tenant", async () => {
    const { sqlite, repo } = repository();
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud_a", envelope: workThreadReceipt(), now: NOW });
    await repo.enqueueControlPlaneProjection({
      destinationId: "cloud_b",
      envelope: workThreadReceipt({ receiptId: "receipt_b", operationId: "operation_b" }),
      now: NOW
    });
    await repo.enqueueControlPlaneProjection({
      destinationId: "cloud_a",
      envelope: workThreadReceipt({
        receiptId: "receipt_org_b",
        organizationId: "org_2",
        operationId: "operation_org_b",
        identity: {
          namespace: "opentag.control.receipt/work-thread-ref/v1",
          parts: ["org_2", "run_1", "work_thread_1"]
        }
      }),
      now: NOW
    });
    const firstClaim = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud_a", organizationId: "org_1", leaseOwner: "uploader_1", leaseSeconds: 30, now: NOW
    });
    expect(firstClaim.entries).toHaveLength(1);
    await expect(repo.claimDueControlPlaneProjections({
      destinationId: "cloud_a", organizationId: "org_1", leaseOwner: "uploader_2", leaseSeconds: 30, now: NOW
    })).resolves.toEqual({ entries: [], rejected: [] });
    await expect(repo.listControlPlaneProjections({ destinationId: "cloud_a", organizationId: "org_2" }))
      .resolves.toHaveLength(1);
    sqlite.close();
  });

  it("requires the live lease token for ack, retry, attention, and recovers expiry", async () => {
    const { sqlite, repo } = repository();
    await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope: workThreadReceipt(), now: NOW });
    const { entries: [claimed] } = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud", organizationId: "org_1", leaseOwner: "uploader", leaseSeconds: 10, now: NOW
    });
    expect(claimed?.leaseToken).toBeTruthy();
    await expect(repo.acknowledgeControlPlaneProjection({
      destinationId: "cloud", organizationId: "org_1",
      receiptId: claimed!.receiptId, leaseToken: "wrong", now: NOW
    })).resolves.toMatchObject({ outcome: "stale_lease" });
    await expect(repo.recoverExpiredControlPlaneProjectionLeases({
      destinationId: "cloud", organizationId: "org_1", now: new Date("2026-08-08T00:00:11.000Z")
    })).resolves.toMatchObject({ recovered: 1, entries: [{ state: "pending", lastReasonCode: "lease_expired" }] });
    const { entries: [reclaimed] } = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "uploader",
      leaseSeconds: 30,
      now: new Date("2026-08-08T00:00:11.000Z")
    });
    await expect(repo.retryControlPlaneProjection({
      destinationId: "cloud", organizationId: "org_1",
      receiptId: reclaimed!.receiptId,
      leaseToken: reclaimed!.leaseToken!,
      nextAttemptAt: "2026-08-08T00:01:00.000Z",
      reasonCode: "provider_unavailable",
      httpStatus: 503,
      now: new Date("2026-08-08T00:00:12.000Z")
    })).resolves.toMatchObject({ outcome: "retried", entry: { state: "pending", attemptCount: 2 } });
    const { entries: [finalClaim] } = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "uploader",
      leaseSeconds: 30,
      now: new Date("2026-08-08T00:01:00.000Z")
    });
    await expect(repo.markControlPlaneProjectionAttention({
      destinationId: "cloud", organizationId: "org_1",
      receiptId: finalClaim!.receiptId,
      leaseToken: finalClaim!.leaseToken!,
      reasonCode: "operator_required",
      now: new Date("2026-08-08T00:01:01.000Z")
    })).resolves.toMatchObject({ outcome: "attention", entry: { state: "attention" } });
    sqlite.close();
  });

  it("validates corrupt leased rows before ack, retry, or attention can clean them", async () => {
    const { sqlite, repo } = repository();
    const receipts = ["ack", "retry", "attention"].map((suffix, index) =>
      workThreadReceipt({
        receiptId: `receipt_corrupt_${suffix}`,
        operationId: `operation_corrupt_${suffix}`,
        identity: {
          namespace: "opentag.control.receipt/work-thread-ref/v1",
          parts: ["org_1", `run_corrupt_${index}`, `thread_corrupt_${index}`]
        },
        runId: `run_corrupt_${index}`,
        workThreadId: `thread_corrupt_${index}`,
        payload: {
          ...workThreadReceipt().payload,
          workThreadId: `thread_corrupt_${index}`
        }
      }));
    for (const envelope of receipts) {
      await repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope, now: NOW });
    }
    const claimed = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "uploader",
      leaseSeconds: 30,
      limit: 3,
      now: NOW
    });
    sqlite.exec("DROP TRIGGER control_plane_projection_outbox_transition_guard");
    sqlite.prepare(`
      UPDATE control_plane_projection_outbox
      SET lease_owner = 'uploader/../credential'
      WHERE destination_id = 'cloud' AND organization_id = 'org_1'
    `).run();
    const before = sqlite.prepare(`
      SELECT * FROM control_plane_projection_outbox
      WHERE destination_id = 'cloud' AND organization_id = 'org_1'
      ORDER BY receipt_id
    `).all();
    const byReceipt = new Map(claimed.entries.map((entry) => [entry.receiptId, entry]));
    await expect(repo.acknowledgeControlPlaneProjection({
      destinationId: "cloud",
      organizationId: "org_1",
      receiptId: "receipt_corrupt_ack",
      leaseToken: byReceipt.get("receipt_corrupt_ack")!.leaseToken!,
      now: new Date("2026-08-08T00:00:01.000Z")
    })).rejects.toThrow("control_plane_projection_outbox_row_invalid");
    await expect(repo.retryControlPlaneProjection({
      destinationId: "cloud",
      organizationId: "org_1",
      receiptId: "receipt_corrupt_retry",
      leaseToken: byReceipt.get("receipt_corrupt_retry")!.leaseToken!,
      nextAttemptAt: "2026-08-08T00:01:00.000Z",
      reasonCode: "provider_unavailable",
      now: new Date("2026-08-08T00:00:01.000Z")
    })).rejects.toThrow("control_plane_projection_outbox_row_invalid");
    await expect(repo.markControlPlaneProjectionAttention({
      destinationId: "cloud",
      organizationId: "org_1",
      receiptId: "receipt_corrupt_attention",
      leaseToken: byReceipt.get("receipt_corrupt_attention")!.leaseToken!,
      reasonCode: "operator_required",
      now: new Date("2026-08-08T00:00:01.000Z")
    })).rejects.toThrow("control_plane_projection_outbox_row_invalid");
    expect(sqlite.prepare(`
      SELECT * FROM control_plane_projection_outbox
      WHERE destination_id = 'cloud' AND organization_id = 'org_1'
      ORDER BY receipt_id
    `).all()).toEqual(before);
    sqlite.close();
  });

  it("seeks beyond one hundred poisoned rows without repeating diagnostics", async () => {
    const { sqlite, repo } = repository();
    for (let index = 0; index < 101; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      await repo.enqueueControlPlaneProjection({
        destinationId: "cloud",
        envelope: workThreadReceipt({
          receiptId: `p${suffix}`,
          operationId: `operation_poison_${suffix}`,
          identity: {
            namespace: "opentag.control.receipt/work-thread-ref/v1",
            parts: ["org_1", `run_poison_${suffix}`, `thread_poison_${suffix}`]
          },
          runId: `run_poison_${suffix}`,
          workThreadId: `thread_poison_${suffix}`,
          payload: {
            ...workThreadReceipt().payload,
            workThreadId: `thread_poison_${suffix}`
          }
        }),
        now: NOW
      });
    }
    await repo.enqueueControlPlaneProjection({
      destinationId: "cloud",
      envelope: workThreadReceipt({
        receiptId: "z_valid_after_poison",
        operationId: "operation_valid_after_poison",
        identity: {
          namespace: "opentag.control.receipt/work-thread-ref/v1",
          parts: ["org_1", "run_valid_after_poison", "thread_valid_after_poison"]
        },
        runId: "run_valid_after_poison",
        workThreadId: "thread_valid_after_poison",
        payload: {
          ...workThreadReceipt().payload,
          workThreadId: "thread_valid_after_poison"
        }
      }),
      now: NOW
    });
    sqlite.exec("DROP TRIGGER control_plane_projection_outbox_immutable_update_guard");
    sqlite.prepare(`
      UPDATE control_plane_projection_outbox SET envelope_json = '{}'
      WHERE destination_id = 'cloud' AND organization_id = 'org_1'
        AND receipt_id LIKE 'p%'
    `).run();

    const result = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "uploader",
      leaseSeconds: 30,
      limit: 1,
      now: NOW
    });
    expect(result.entries).toMatchObject([
      { receiptId: "z_valid_after_poison", state: "leased" }
    ]);
    expect(result.rejected).toHaveLength(100);
    expect(new Set(result.rejected.map((entry) => entry.receiptId)).size).toBe(100);
    expect(sqlite.prepare(`
      SELECT count(*) AS count FROM control_plane_projection_outbox
      WHERE receipt_id LIKE 'p%' AND state = 'pending' AND attempt_count = 0
    `).get()).toEqual({ count: 101 });
    sqlite.close();
  });

  it("recovers an expired valid lease after one hundred poisoned leases", async () => {
    const { sqlite, repo } = repository();
    for (let index = 0; index < 101; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      await repo.enqueueControlPlaneProjection({
        destinationId: "cloud",
        envelope: workThreadReceipt({
          receiptId: `p${suffix}`,
          operationId: `operation_recovery_poison_${suffix}`,
          identity: {
            namespace: "opentag.control.receipt/work-thread-ref/v1",
            parts: ["org_1", `run_recovery_poison_${suffix}`, `thread_recovery_poison_${suffix}`]
          },
          runId: `run_recovery_poison_${suffix}`,
          workThreadId: `thread_recovery_poison_${suffix}`,
          payload: {
            ...workThreadReceipt().payload,
            workThreadId: `thread_recovery_poison_${suffix}`
          }
        }),
        now: NOW
      });
    }
    await repo.enqueueControlPlaneProjection({
      destinationId: "cloud",
      envelope: workThreadReceipt({
        receiptId: "z_valid_after_recovery_poison",
        operationId: "operation_valid_after_recovery_poison",
        identity: {
          namespace: "opentag.control.receipt/work-thread-ref/v1",
          parts: ["org_1", "run_valid_after_recovery_poison", "thread_valid_after_recovery_poison"]
        },
        runId: "run_valid_after_recovery_poison",
        workThreadId: "thread_valid_after_recovery_poison",
        payload: {
          ...workThreadReceipt().payload,
          workThreadId: "thread_valid_after_recovery_poison"
        }
      }),
      now: NOW
    });
    const firstClaim = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "uploader",
      leaseSeconds: 10,
      limit: 100,
      now: NOW
    });
    const secondClaim = await repo.claimDueControlPlaneProjections({
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "uploader",
      leaseSeconds: 10,
      limit: 2,
      now: NOW
    });
    expect([...firstClaim.entries, ...secondClaim.entries]).toHaveLength(102);
    sqlite.exec("DROP TRIGGER control_plane_projection_outbox_immutable_update_guard");
    sqlite.prepare(`
      UPDATE control_plane_projection_outbox SET envelope_json = '{}'
      WHERE destination_id = 'cloud' AND organization_id = 'org_1'
        AND receipt_id LIKE 'p%'
    `).run();

    const result = await repo.recoverExpiredControlPlaneProjectionLeases({
      destinationId: "cloud",
      organizationId: "org_1",
      limit: 1,
      now: new Date("2026-08-08T00:00:10.000Z")
    });
    expect(result).toMatchObject({
      recovered: 1,
      entries: [{
        receiptId: "z_valid_after_recovery_poison",
        state: "pending",
        lastReasonCode: "lease_expired"
      }]
    });
    expect(sqlite.prepare(`
      SELECT count(*) AS count FROM control_plane_projection_outbox
      WHERE receipt_id LIKE 'p%' AND state = 'leased' AND attempt_count = 1
    `).get()).toEqual({ count: 101 });
    sqlite.close();
  });

  it("claims and recovers once across concurrent repositories at the exact expiry boundary", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opentag-projection-concurrency-"));
    const databasePath = path.join(directory, "store.sqlite");
    const first = repository(new Database(databasePath));
    const second = repository(new Database(databasePath));
    await first.repo.enqueueControlPlaneProjection({
      destinationId: "cloud", envelope: workThreadReceipt(), now: NOW
    });
    const claims = await Promise.all([first.repo, second.repo].map((repo, index) =>
      repo.claimDueControlPlaneProjections({
        destinationId: "cloud",
        organizationId: "org_1",
        leaseOwner: `uploader_${index}`,
        leaseSeconds: 10,
        now: NOW
      })));
    expect(claims.flatMap((result) => result.entries)).toHaveLength(1);
    const claimed = claims.flatMap((result) => result.entries)[0]!;
    await expect(second.repo.acknowledgeControlPlaneProjection({
      destinationId: "cloud",
      organizationId: "org_1",
      receiptId: claimed.receiptId,
      leaseToken: claimed.leaseToken!,
      now: new Date("2026-08-08T00:00:10.000Z")
    })).resolves.toEqual({ outcome: "stale_lease" });
    first.sqlite.close();
    second.sqlite.close();

    const restartedA = repository(new Database(databasePath));
    const restartedB = repository(new Database(databasePath));
    const recovered = await Promise.all([restartedA.repo, restartedB.repo].map((repo) =>
      repo.recoverExpiredControlPlaneProjectionLeases({
        destinationId: "cloud",
        organizationId: "org_1",
        now: new Date("2026-08-08T00:00:10.000Z")
      })));
    expect(recovered.reduce((count, result) => count + result.recovered, 0)).toBe(1);
    restartedA.sqlite.close();
    restartedB.sqlite.close();
    fs.rmSync(directory, { recursive: true });
  });

  it("rejects non-allowlisted envelopes and callback custody leakage before writing", async () => {
    const { sqlite, repo } = repository();
    await expect(repo.enqueueControlPlaneProjection({
      destinationId: "cloud",
      envelope: { ...workThreadReceipt(), receiptKind: "admission_policy_snapshot" },
      now: NOW
    })).rejects.toBeInstanceOf(ControlPlaneProjectionOutboxValidationError);
    await expect(repo.enqueueControlPlaneProjection({
      destinationId: "cloud",
      envelope: callbackProviderReceipt("https://api.github.com/comments/123?token=secret"),
      now: NOW
    })).rejects.toMatchObject({ code: "projection_envelope_invalid" });
    const topUnknown = { ...workThreadReceipt(), unexpected: "value" };
    const nestedUnknown = {
      ...workThreadReceipt(),
      payload: { ...workThreadReceipt().payload, unexpected: "value" }
    };
    for (const envelope of [topUnknown, nestedUnknown]) {
      await expect(repo.enqueueControlPlaneProjection({ destinationId: "cloud", envelope, now: NOW }))
        .rejects.toMatchObject({ code: "projection_envelope_invalid" });
    }
    for (const forbiddenField of [
      "uri", "body", "header", "comment", "credential", "path", "command", "context"
    ]) {
      await expect(repo.enqueueControlPlaneProjection({
        destinationId: "cloud",
        envelope: {
          ...workThreadReceipt(),
          payload: { ...workThreadReceipt().payload, [forbiddenField]: "secret_ref" }
        },
        now: NOW
      })).rejects.toMatchObject({ code: "projection_envelope_invalid" });
    }
    for (const unsafe of [
      "https://api.github.com/comments/123",
      "/private/tmp/secret",
      "C:\\Users\\secret",
      "../credential",
      "Bearer secret-token",
      "free form comment",
      "source\ud800event",
      "source\udcffevent"
    ]) {
      const expectation = expect(repo.enqueueControlPlaneProjection({
        destinationId: "cloud", envelope: callbackProviderReceipt(unsafe), now: NOW
      })).rejects;
      await expectation.toMatchObject({ code: "projection_envelope_invalid" });
    }
    for (const [field, unsafeId] of [
      ["receiptId", "receipt_github_pat_abcdefghijklmnopqrstuvwxyz123456"],
      [
        "operationId",
        "operation_nested_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"
      ],
      ["receiptId", "https://example.test/callback?token=secret"],
      ["operationId", "/tmp/callback-operation"],
      ["receiptId", '{"body":"callback"}'],
      ["operationId", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
      ["receiptId", "callback; curl https://example.test/upload"]
    ] as const) {
      await expect(repo.enqueueControlPlaneProjection({
        destinationId: "cloud",
        envelope: callbackProviderReceipt("github:comment:123", { [field]: unsafeId }),
        now: NOW
      })).rejects.toMatchObject({ code: "projection_envelope_invalid" });
    }
    expect(sqlite.prepare("SELECT count(*) AS count FROM control_plane_projection_outbox").get()).toEqual({ count: 0 });
    sqlite.close();
  });
});
