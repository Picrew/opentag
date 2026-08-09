import {
  buildHostedLifecycleRequestV1,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeGitHubIssueCommentSourceIdentityDigestV1,
  computeHostedAdmissionEnvelopeDigestV1,
  computeHostedClaimFencingTokenDigestV1,
  computeHostedLifecycleReceiptIdV1,
  computeHostedLifecycleRequestIdV1,
  type HostedClaimRequestV1,
  type HostedClaimV1,
  type HostedHeartbeatRequestV1,
  type HostedRejectStartRequestV1,
  type HostedRunningRequestV1,
  type HostedLifecycleReceiptEnvelopeV1,
  type OpenTagEvent
} from "@opentag/core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSha256Json } from "../src/canonical-json.js";
import { HostedImportConflictError, createOpenTagRepository } from "../src/repository.js";
import { migrateSchema } from "../src/schema.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const capabilities = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1"
] as const;
const observedAt = "2026-08-10T00:00:00.000Z";
const leaseExpiresAt = "2099-08-10T00:02:00.000Z";
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function request(operationId = "claim-op-1", requestId = "claim-request-1"): HostedClaimRequestV1 {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: capabilities,
    requestId,
    operationId,
    expectedAuthority: {
      credentialId: "credential-1",
      registrationGeneration: 3,
      credentialGeneration: 2,
      runnerReadinessReceiptId: "readiness-1",
      runnerReadinessReceiptDigest: digestA
    }
  };
}

async function fixture(input: {
  runId?: string;
  admissionId?: string;
  admissionOperationId?: string;
  claimOperationId?: string;
  requestId?: string;
  attemptId?: string;
  attemptNumber?: number;
  deliveryId?: string;
  providerEventId?: string;
  body?: string;
  fencingToken?: string;
  leaseExpiresAt?: string;
} = {}): Promise<{
  event: OpenTagEvent;
  claim: HostedClaimV1;
  request: HostedClaimRequestV1;
  sourceReceipt: {
    provider: "github";
    providerRepositoryId: string;
    owner: string;
    repo: string;
    sourceThread: HostedClaimV1["hostedAdmission"]["sourceThread"];
    sourceEvent: HostedClaimV1["hostedAdmission"]["sourceEvent"];
    actor: { providerUserId: string; login: string };
    sourceIdentityDigest: string;
    eventDigest: string;
    refetchedAt: string;
  };
}> {
  const runId = input.runId ?? "hosted-run-1";
  const admissionId = input.admissionId ?? "admission-1";
  const admissionOperationId = input.admissionOperationId ?? "admission-op-1";
  const claimOperationId = input.claimOperationId ?? "claim-op-1";
  const requestId = input.requestId ?? "claim-request-1";
  const attemptId = input.attemptId ?? "attempt-cloud-1";
  const attemptNumber = input.attemptNumber ?? 1;
  const deliveryId = input.deliveryId ?? "delivery-1";
  const providerEventId = input.providerEventId ?? "789";
  const body = input.body ?? "@opentag fix the failing test";
  const fencingToken = input.fencingToken ?? "cloud-fence-1";
  const claimLeaseExpiresAt = input.leaseExpiresAt ?? leaseExpiresAt;
  const event: OpenTagEvent = {
    id: `event-${providerEventId}`,
    source: "github",
    sourceEventId: providerEventId,
    receivedAt: observedAt,
    actor: { provider: "github", providerUserId: "1001", handle: "octocat" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: body, intent: "fix", args: {} },
    context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/widget/issues/42", visibility: "public" }],
    workItem: {
      provider: "github",
      kind: "issue",
      externalId: "acme/widget#42",
      uri: "https://github.com/acme/widget/issues/42",
      ownerContainer: { provider: "github", id: "acme/widget", uri: "https://github.com/acme/widget" }
    },
    permissions: [{ scope: "issue:comment", reason: "reply" }],
    callback: { provider: "github", uri: "https://api.github.com/repos/acme/widget/issues/42/comments" },
    metadata: { owner: "acme", repo: "widget", issueNumber: 42, githubDeliveryId: deliveryId }
  };
  const sourceIdentityDigest = await computeGitHubIssueCommentSourceIdentityDigestV1({
    provider: "github",
    repository: { providerRepositoryId: "123", owner: "acme", repo: "widget" },
    sourceThread: { kind: "issue", providerThreadId: "456", number: 42 },
    sourceEvent: { providerEventId, kind: "issue_comment" },
    actor: { providerUserId: "1001", login: "octocat" },
    executionBearingCommentBody: body
  });
  const admissionBase = {
    kind: "hosted_admission" as const,
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.hosted-admission.v1"] as const,
    admissionId,
    operationId: admissionOperationId,
    organizationId: "org-1",
    bindingId: "binding-1",
    bindingSecretVersion: "secret-v3",
    provider: "github" as const,
    deliveryId,
    deliveryPayloadDigest: digestA,
    sourceIdentityDigest,
    eventName: "issue_comment" as const,
    action: "created" as const,
    repository: { providerRepositoryId: "123", owner: "acme", repo: "widget" },
    sourceThread: { kind: "issue" as const, providerThreadId: "456", number: 42 },
    sourceEvent: { providerEventId, kind: "issue_comment" as const },
    verifiedActor: {
      providerUserId: "1001",
      login: "octocat",
      authorization: { decision: "allowed" as const, grantRef: "grant-1", grantVersion: 1, grantDigest: digestA }
    },
    projectTarget: { projectTargetId: "target-1", version: 1, digest: digestA },
    runnerId: "runner-1",
    admissionPolicySnapshot: { snapshotId: "policy-1", digest: digestB },
    receivedAt: observedAt,
    envelopeDigest: digestA
  };
  const hostedAdmission = {
    ...admissionBase,
    envelopeDigest: await computeHostedAdmissionEnvelopeDigestV1(admissionBase)
  };
  const fencingTokenDigest = await computeHostedClaimFencingTokenDigestV1(fencingToken);
  const claim: HostedClaimV1 = {
    kind: "hosted_claim",
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: capabilities,
    requestId,
    operationId: claimOperationId,
    organizationId: "org-1",
    runnerId: "runner-1",
    runId,
    executorId: "executor-acp",
    hostedAdmission,
    admissionPolicySnapshot: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      receiptId: "policy-receipt-1",
      organizationId: "org-1",
      operationId: admissionOperationId,
      requiredCapabilities: capabilities,
      producer: { kind: "cloud", id: "cloud-control" },
      identity: { namespace: "opentag.control.receipt/admission-policy-snapshot/v1", parts: ["org-1", runId, "policy-1"] },
      observedAt,
      payloadDigest: digestA,
      receiptDigest: digestB,
      receiptKind: "admission_policy_snapshot",
      runId,
      payload: {
        snapshotId: "policy-1",
        capturedAt: observedAt,
        tenant: { organizationId: "org-1" },
        actor: { provider: "github", providerUserId: "1001", login: "octocat", authorizationRef: "grant-1" },
        target: { projectTargetId: "target-1", bindingId: "binding-1", providerRepositoryId: "123", defaultBranch: "main" },
        runner: { runnerId: "runner-1", readinessReceiptDigest: digestA },
        executor: { executorId: "executor-acp", capabilityDigest: digestB },
        requiredRelayCapabilities: capabilities,
        admissionRules: { profile: "github-pr/v1", requiredCheckNames: ["test"], mergeRequired: false, humanApprovalRequiredFor: ["merge"] }
      }
    },
    attempt: {
      id: attemptId,
      number: attemptNumber,
      epoch: attemptNumber,
      fencingToken,
      fencingTokenDigest,
      leaseExpiresAt: claimLeaseExpiresAt
    },
    authority: {
      organizationId: "org-1",
      runnerId: "runner-1",
      runId,
      credentialId: "credential-1",
      registrationGeneration: 3,
      credentialGeneration: 2,
      projectTargetId: "target-1",
      bindingId: "binding-1",
      targetBindingDigest: digestA,
      admissionPolicyReceiptId: "policy-receipt-1",
      admissionPolicySnapshotId: "policy-1",
      admissionPolicySnapshotDigest: digestB,
      runnerReadinessReceiptId: "readiness-1",
      runnerReadinessReceiptDigest: digestA,
      targetReadinessReceiptId: "readiness-1",
      targetReadinessReceiptDigest: digestA,
      executorId: "executor-acp",
      executorCapabilityDigest: digestB,
      attemptId,
      attemptNumber,
      epoch: attemptNumber,
      fencingTokenDigest
    }
  };
  return {
    event,
    claim,
    request: request(claimOperationId, requestId),
    sourceReceipt: {
      provider: "github",
      providerRepositoryId: "123",
      owner: "acme",
      repo: "widget",
      sourceThread: hostedAdmission.sourceThread,
      sourceEvent: hostedAdmission.sourceEvent,
      actor: { providerUserId: "1001", login: "octocat" },
      sourceIdentityDigest,
      eventDigest: canonicalSha256Json(event),
      refetchedAt: observedAt
    }
  };
}

async function begin(repo: ReturnType<typeof createOpenTagRepository>, value: Awaited<ReturnType<typeof fixture>>) {
  return repo.beginHostedClaimOperation({
    destinationId: "cloud-1",
    organizationId: "org-1",
    runnerId: "runner-1",
    request: value.request
  });
}

const heartbeatAuthority = {
  destinationId: "cloud-1",
  organizationId: "org-1",
  runnerId: "runner-1",
  credentialId: "credential-1"
};

async function heartbeatRequest(input: {
  claim: HostedClaimV1;
  expectedLeaseExpiresAt: string;
  occurredAt?: string;
}): Promise<HostedHeartbeatRequestV1> {
  return buildHostedLifecycleRequestV1({
    action: "heartbeat",
    organizationId: "org-1",
    runnerId: "runner-1",
    runId: input.claim.runId,
    attempt: {
      attemptId: input.claim.attempt.id,
      attemptNumber: input.claim.attempt.number,
      epoch: input.claim.attempt.epoch,
      fencingToken: input.claim.attempt.fencingToken,
      fencingTokenDigest: input.claim.attempt.fencingTokenDigest
    },
    occurredAt: input.occurredAt ?? "2026-08-10T00:01:00.000Z",
    expectedLeaseExpiresAt: input.expectedLeaseExpiresAt
  }) as Promise<HostedHeartbeatRequestV1>;
}

async function heartbeatReceipt(input: {
  claim: HostedClaimV1;
  request: HostedHeartbeatRequestV1;
  leaseExpiresAt: string;
}): Promise<HostedLifecycleReceiptEnvelopeV1> {
  const payload = {
    operation: "heartbeat" as const,
    occurredAt: input.request.occurredAt,
    leaseExpiresAt: input.leaseExpiresAt
  };
  const base = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptKind: "attempt_lifecycle" as const,
    receiptId: await computeHostedLifecycleReceiptIdV1({
      organizationId: "org-1",
      operationId: input.request.operationId
    }),
    organizationId: "org-1",
    requestId: input.request.requestId,
    operationId: input.request.operationId,
    requestDigest: input.request.requestDigest,
    requiredCapabilities: ["relay.lifecycle.v1"] as const,
    producer: { kind: "runner" as const, id: "runner-1", credentialId: "credential-1" },
    identity: {
      namespace: "opentag.control.receipt/attempt-lifecycle/v1" as const,
      parts: [
        "org-1",
        input.claim.runId,
        input.claim.attempt.id,
        "heartbeat" as const,
        input.request.operationId
      ] as const
    },
    observedAt: input.request.occurredAt,
    payloadDigest: await computeControlPayloadDigestV1(payload),
    runId: input.claim.runId,
    attempt: {
      attemptId: input.claim.attempt.id,
      attemptNumber: input.claim.attempt.number,
      epoch: input.claim.attempt.epoch,
      fencingTokenDigest: input.claim.attempt.fencingTokenDigest
    },
    payload
  };
  return { ...base, receiptDigest: await computeControlReceiptDigestV1(base) };
}

async function rejectStartReceipt(input: {
  claim: HostedClaimV1;
  request: HostedRejectStartRequestV1;
}): Promise<HostedLifecycleReceiptEnvelopeV1> {
  const payload = {
    operation: "reject_start" as const,
    occurredAt: input.request.occurredAt,
    executorId: input.request.executorId,
    reasonCode: input.request.reasonCode
  };
  const base = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptKind: "attempt_lifecycle" as const,
    receiptId: await computeHostedLifecycleReceiptIdV1({
      organizationId: input.claim.organizationId,
      operationId: input.request.operationId
    }),
    organizationId: input.claim.organizationId,
    requestId: input.request.requestId,
    operationId: input.request.operationId,
    requestDigest: input.request.requestDigest,
    requiredCapabilities: ["relay.lifecycle.v1"] as const,
    producer: {
      kind: "runner" as const,
      id: input.claim.runnerId,
      credentialId: input.claim.authority.credentialId
    },
    identity: {
      namespace: "opentag.control.receipt/attempt-lifecycle/v1" as const,
      parts: [
        input.claim.organizationId,
        input.claim.runId,
        input.claim.attempt.id,
        "reject_start" as const,
        input.request.operationId
      ] as const
    },
    observedAt: input.request.occurredAt,
    payloadDigest: await computeControlPayloadDigestV1(payload),
    runId: input.claim.runId,
    attempt: {
      attemptId: input.claim.attempt.id,
      attemptNumber: input.claim.attempt.number,
      epoch: input.claim.attempt.epoch,
      fencingTokenDigest: input.claim.attempt.fencingTokenDigest
    },
    payload
  };
  return { ...base, receiptDigest: await computeControlReceiptDigestV1(base) };
}

async function startHostedExecution(
  repo: ReturnType<typeof createOpenTagRepository>,
  claim: HostedClaimV1,
): Promise<boolean> {
  const request = await buildHostedLifecycleRequestV1({
    action: "running",
    organizationId: claim.organizationId,
    runnerId: claim.runnerId,
    runId: claim.runId,
    attempt: {
      attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.number,
      epoch: claim.attempt.epoch,
      fencingToken: claim.attempt.fencingToken,
      fencingTokenDigest: claim.attempt.fencingTokenDigest
    },
    occurredAt: observedAt,
    executorId: claim.executorId,
    executorCapabilityDigest: claim.authority.executorCapabilityDigest
  }) as HostedRunningRequestV1;
  const local = await repo.markHostedRunRunningLocally({
    destinationId: "cloud-1",
    organizationId: claim.organizationId,
    runnerId: claim.runnerId,
    credentialId: claim.authority.credentialId,
    runId: claim.runId,
    attemptId: claim.attempt.id,
    fencingToken: claim.attempt.fencingToken,
    executor: claim.executorId,
    request
  });
  if (local.operation.state !== "acknowledged") {
    const claimed = await repo.claimDueHostedLifecycleOperations({
      destinationId: "cloud-1",
      organizationId: claim.organizationId,
      leaseOwner: "test-running-pump",
      leaseSeconds: 30,
      now: new Date()
    });
    const operation = claimed.find((candidate) => candidate.operationId === local.operation.operationId);
    if (!operation?.leaseToken) throw new Error("running lifecycle operation was not claimable");
    const payload = {
      operation: "running" as const,
      occurredAt: request.occurredAt,
      executorId: request.executorId,
      executorCapabilityDigest: request.executorCapabilityDigest
    };
    const base = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      receiptKind: "attempt_lifecycle" as const,
      receiptId: await computeHostedLifecycleReceiptIdV1({
        organizationId: claim.organizationId,
        operationId: request.operationId
      }),
      organizationId: claim.organizationId,
      requestId: request.requestId,
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      requiredCapabilities: ["relay.lifecycle.v1"] as const,
      producer: { kind: "runner" as const, id: claim.runnerId, credentialId: claim.authority.credentialId },
      identity: {
        namespace: "opentag.control.receipt/attempt-lifecycle/v1" as const,
        parts: [claim.organizationId, claim.runId, claim.attempt.id, "running" as const, request.operationId] as const
      },
      observedAt,
      payloadDigest: await computeControlPayloadDigestV1(payload),
      runId: claim.runId,
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingTokenDigest: claim.attempt.fencingTokenDigest
      },
      payload
    };
    const receipt = { ...base, receiptDigest: await computeControlReceiptDigestV1(base) };
    await repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: claim.organizationId,
      operationId: operation.operationId,
      leaseToken: operation.leaseToken,
      receipt
    });
  }
  return repo.acquireHostedExecutionStart({
    runId: claim.runId,
    attemptId: claim.attempt.id,
    fencingToken: claim.attempt.fencingToken
  });
}

describe("hosted assigned Run import", () => {
  it("fails closed on an incompatible partial lifecycle journal and repairs stale guards", () => {
    const partial = new Database(":memory:");
    partial.exec(`CREATE TABLE hosted_lifecycle_operations (
      destination_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_digest TEXT NOT NULL
    )`);
    partial.prepare(`INSERT INTO hosted_lifecycle_operations VALUES (?, ?, ?, ?, ?, ?)`)
      .run("cloud-1", "org-1", "runner-1", "credential-1", "operation-1", digestA);
    expect(() => migrateSchema(partial)).toThrow(
      /hosted_lifecycle_operations_incompatible_partial_schema/u,
    );
    expect(partial.prepare("PRAGMA table_info(hosted_lifecycle_operations)").all())
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "business_key_digest" }),
      ]));
    expect(partial.prepare("SELECT count(*) AS count FROM hosted_lifecycle_operations").get())
      .toEqual({ count: 1 });
    partial.close();

    const complete = new Database(":memory:");
    migrateSchema(complete);
    complete.exec(`
      DROP TRIGGER hosted_lifecycle_operations_immutable_guard;
      CREATE TRIGGER hosted_lifecycle_operations_immutable_guard
      BEFORE UPDATE OF request_digest ON hosted_lifecycle_operations
      BEGIN SELECT RAISE(ABORT, 'stale_guard'); END;
    `);
    migrateSchema(complete);
    const guard = complete.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'hosted_lifecycle_operations_immutable_guard'",
    ).get() as { sql: string };
    expect(guard.sql).toContain("business_key_digest");
    expect(guard.sql).not.toContain("stale_guard");
    complete.close();
  });
  it("imports Cloud authority directly and exactly replays without entering the legacy queue", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture();
    await begin(repo, value);
    const created = await repo.importHostedAssignedRun(value);
    expect(created).toMatchObject({
      outcome: "created",
      claimed: {
        run: { id: "hosted-run-1", status: "assigned", assignedRunnerId: "runner-1", executor: "executor-acp" },
        attemptId: "attempt-cloud-1",
        attemptNumber: 1,
        fencingToken: "cloud-fence-1",
        executorId: "executor-acp"
      },
      hostedAuthority: { runnerId: "runner-1", workThreadId: expect.any(String) }
    });
    await expect(repo.importHostedAssignedRun(value)).resolves.toMatchObject({ outcome: "replayed", claimed: created.claimed });
    await expect(repo.getHostedAssignedRunForRecovery({
      destinationId: "cloud-1",
      organizationId: "org-1",
      runnerId: "runner-1"
    })).resolves.toMatchObject({ claimed: created.claimed });
    await expect(startHostedExecution(repo, value.claim)).resolves.toBe(true);
    await expect(repo.acquireHostedExecutionStart({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-1",
      fencingToken: "cloud-fence-1"
    })).resolves.toBe(false);
    await expect(repo.getHostedAssignedRunForRecovery({
      destinationId: "cloud-1",
      organizationId: "org-1",
      runnerId: "runner-1"
    })).resolves.toBeNull();
    await expect(repo.claimNextRun({ runnerId: "legacy-runner", leaseSeconds: 60 })).resolves.toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) count FROM work_threads").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT * FROM attempts WHERE id = ?").get("attempt-cloud-1")).toMatchObject({
      run_id: "hosted-run-1",
      number: 1,
      runner_id: "runner-1",
      selected_executor_id: "executor-acp",
      fencing_token: "cloud-fence-1",
      lease_expires_at: leaseExpiresAt
    });
  });

  it("replays after restart and preserves the durable journal request after response loss", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentag-hosted-import-"));
    tempDirs.push(directory);
    const path = join(directory, "store.sqlite");
    const value = await fixture();
    const firstSqlite = new Database(path);
    migrateSchema(firstSqlite);
    const first = createOpenTagRepository(drizzle(firstSqlite));
    await begin(first, value);
    firstSqlite.close();
    const secondSqlite = new Database(path);
    migrateSchema(secondSqlite);
    const second = createOpenTagRepository(drizzle(secondSqlite));
    await expect(second.getHostedClaimOperationForRetry({ destinationId: "cloud-1", organizationId: "org-1", runnerId: "runner-1" }))
      .resolves.toMatchObject({ request: value.request, state: "pending" });
    await second.importHostedAssignedRun(value);
    secondSqlite.close();
    const thirdSqlite = new Database(path);
    migrateSchema(thirdSqlite);
    await expect(createOpenTagRepository(drizzle(thirdSqlite)).importHostedAssignedRun(value))
      .resolves.toMatchObject({ outcome: "replayed" });
    thirdSqlite.close();
  });

  it("expires recovery fail-closed, then recovers and starts only the later Cloud attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const directory = await mkdtemp(join(tmpdir(), "opentag-hosted-attempt-"));
    tempDirs.push(directory);
    const path = join(directory, "store.sqlite");
    const firstValue = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    const secondValue = await fixture({
      claimOperationId: "claim-op-2",
      requestId: "claim-request-2",
      attemptId: "attempt-cloud-2",
      attemptNumber: 2,
      fencingToken: "cloud-fence-2",
      leaseExpiresAt: "2026-08-10T00:05:00.000Z"
    });
    const firstSqlite = new Database(path);
    migrateSchema(firstSqlite);
    const first = createOpenTagRepository(drizzle(firstSqlite));
    await begin(first, firstValue);
    await first.importHostedAssignedRun(firstValue);
    firstSqlite.close();

    vi.setSystemTime(new Date("2026-08-10T00:03:00.000Z"));
    const secondSqlite = new Database(path);
    migrateSchema(secondSqlite);
    const second = createOpenTagRepository(drizzle(secondSqlite));
    await expect(second.getHostedAssignedRunForRecovery({
      destinationId: "cloud-1",
      organizationId: "org-1",
      runnerId: "runner-1"
    })).resolves.toBeNull();
    await expect(second.acquireHostedExecutionStart({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-1",
      fencingToken: "cloud-fence-1"
    })).rejects.toMatchObject({ code: "HOSTED_IMPORT_AUTHORITY_CONFLICT" });
    expect(secondSqlite.prepare(
      "SELECT execution_started_at FROM hosted_claim_operations WHERE operation_id = ?"
    ).get("claim-op-1")).toEqual({ execution_started_at: null });

    await begin(second, secondValue);
    await expect(second.importHostedAssignedRun(secondValue)).resolves.toMatchObject({
      outcome: "created",
      executionState: "ready_to_start",
      claimed: {
        run: { id: "hosted-run-1" },
        attemptId: "attempt-cloud-2",
        attemptNumber: 2,
        fencingToken: "cloud-fence-2"
      },
      hostedAuthority: { claimOperationId: "claim-op-2", attemptId: "attempt-cloud-2" }
    });
    await expect(second.getHostedAssignedRunForRecovery({
      destinationId: "cloud-1",
      organizationId: "org-1",
      runnerId: "runner-1"
    })).resolves.toMatchObject({
      claimed: { attemptId: "attempt-cloud-2", attemptNumber: 2 },
      hostedAuthority: { claimOperationId: "claim-op-2", attemptId: "attempt-cloud-2" },
      leaseExpiresAt: "2026-08-10T00:05:00.000Z"
    });
    await expect(second.isHostedExecutionCurrent({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-2",
      fencingToken: "cloud-fence-2"
    })).resolves.toBe(false);
    await expect(second.importHostedAssignedRun(firstValue)).resolves.toMatchObject({
      outcome: "replayed",
      executionState: "superseded",
      executionMayStart: false,
      claimed: null,
      hostedAuthority: { claimOperationId: "claim-op-1", attemptId: "attempt-cloud-1" }
    });
    await expect(second.acquireHostedExecutionStart({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-1",
      fencingToken: "cloud-fence-1"
    })).rejects.toMatchObject({ code: "HOSTED_IMPORT_AUTHORITY_CONFLICT" });
    await expect(startHostedExecution(second, secondValue.claim)).resolves.toBe(true);
    await expect(second.isHostedExecutionCurrent({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-2",
      fencingToken: "cloud-fence-2"
    })).resolves.toBe(true);
    await expect(second.isHostedExecutionCurrent({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-1",
      fencingToken: "cloud-fence-1"
    })).resolves.toBe(false);
    await expect(second.acquireHostedExecutionStart({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-2",
      fencingToken: "cloud-fence-2"
    })).resolves.toBe(false);
    expect(secondSqlite.prepare("SELECT COUNT(*) count FROM hosted_run_imports").get()).toEqual({ count: 1 });
    expect(secondSqlite.prepare("SELECT COUNT(*) count FROM hosted_attempt_imports").get()).toEqual({ count: 2 });
    expect(secondSqlite.prepare("SELECT COUNT(*) count FROM work_threads").get()).toEqual({ count: 1 });
    secondSqlite.close();
  });

  it("replays immutable hosted lineage after execution starts and after the run becomes terminal", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture();
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    await startHostedExecution(repo, value.claim);
    sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run("hosted-run-1");
    sqlite.prepare("UPDATE attempts SET status = 'running' WHERE id = ?").run("attempt-cloud-1");
    await expect(repo.importHostedAssignedRun(value)).resolves.toMatchObject({
      outcome: "replayed",
      executionState: "already_started",
      executionMayStart: false,
      claimed: null
    });
    sqlite.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run("hosted-run-1");
    sqlite.prepare("UPDATE attempts SET status = 'succeeded' WHERE id = ?").run("attempt-cloud-1");
    await expect(repo.importHostedAssignedRun(value)).resolves.toMatchObject({
      outcome: "replayed",
      executionState: "terminal",
      executionMayStart: false,
      claimed: null
    });
  });

  it("recovers a locally-running attempt before execution and acquires only after running is acknowledged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const directory = await mkdtemp(join(tmpdir(), "opentag-running-recovery-"));
    tempDirs.push(directory);
    const path = join(directory, "store.sqlite");
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:05:00.000Z" });
    const firstSqlite = new Database(path);
    migrateSchema(firstSqlite);
    const first = createOpenTagRepository(drizzle(firstSqlite));
    await begin(first, value);
    await first.importHostedAssignedRun(value);
    const runningRequest = await buildHostedLifecycleRequestV1({
      action: "running",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId,
      runId: value.claim.runId,
      attempt: {
        attemptId: value.claim.attempt.id,
        attemptNumber: value.claim.attempt.number,
        epoch: value.claim.attempt.epoch,
        fencingToken: value.claim.attempt.fencingToken,
        fencingTokenDigest: value.claim.attempt.fencingTokenDigest
      },
      occurredAt: observedAt,
      executorId: value.claim.executorId,
      executorCapabilityDigest: value.claim.authority.executorCapabilityDigest
    }) as HostedRunningRequestV1;
    await expect(first.markHostedRunRunningLocally({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId,
      credentialId: value.claim.authority.credentialId,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      executor: value.claim.executorId,
      request: runningRequest
    })).resolves.toMatchObject({ outcome: "running", operation: { state: "pending", sequence: 1 } });
    firstSqlite.close();

    const secondSqlite = new Database(path);
    migrateSchema(secondSqlite);
    const second = createOpenTagRepository(drizzle(secondSqlite));
    await expect(second.getHostedAssignedRunForRecovery({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId
    })).resolves.toMatchObject({ claimed: { run: { status: "running" }, attemptId: value.claim.attempt.id } });
    await expect(second.acquireHostedExecutionStart({
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken
    })).rejects.toMatchObject({ code: "HOSTED_IMPORT_AUTHORITY_CONFLICT" });
    await expect(startHostedExecution(second, value.claim)).resolves.toBe(true);
    await expect(second.acquireHostedExecutionStart({
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken
    })).resolves.toBe(false);
    secondSqlite.close();
  });

  it("persists and consumes an exact pre-import claim authority shell", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture();
    await begin(repo, value);
    await expect(repo.persistHostedClaimAuthorityShell({
      destinationId: "cloud-1",
      credentialId: value.claim.authority.credentialId,
      request: value.request,
      claim: value.claim
    })).resolves.toMatchObject({ outcome: "created", operation: { state: "claimed", runId: value.claim.runId } });
    await expect(repo.persistHostedClaimAuthorityShell({
      destinationId: "cloud-1",
      credentialId: value.claim.authority.credentialId,
      request: value.request,
      claim: value.claim
    })).resolves.toMatchObject({ outcome: "replayed" });
    const conflicting = await fixture({
      attemptId: "attempt-cloud-conflict",
      attemptNumber: 2,
      fencingToken: "cloud-fence-conflict"
    });
    await expect(repo.persistHostedClaimAuthorityShell({
      destinationId: "cloud-1",
      credentialId: conflicting.claim.authority.credentialId,
      request: conflicting.request,
      claim: conflicting.claim
    })).rejects.toMatchObject({ code: "HOSTED_CLAIM_OPERATION_CONFLICT" });
    await expect(repo.getHostedClaimOperationForRetry({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId
    })).resolves.toMatchObject({ operationId: value.claim.operationId, state: "claimed" });
    await expect(repo.importHostedAssignedRun(value)).resolves.toMatchObject({ outcome: "created" });
    await expect(repo.getHostedClaimOperationForRetry({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId
    })).resolves.toBeNull();
  });

  it("journals and exactly replays reject-start from a pre-import authority shell", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture();
    await begin(repo, value);
    await repo.persistHostedClaimAuthorityShell({
      destinationId: "cloud-1",
      credentialId: value.claim.authority.credentialId,
      request: value.request,
      claim: value.claim
    });
    const rejectRequest = await buildHostedLifecycleRequestV1({
      action: "reject-start",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId,
      runId: value.claim.runId,
      attempt: {
        attemptId: value.claim.attempt.id,
        attemptNumber: value.claim.attempt.number,
        epoch: value.claim.attempt.epoch,
        fencingToken: value.claim.attempt.fencingToken,
        fencingTokenDigest: value.claim.attempt.fencingTokenDigest
      },
      occurredAt: observedAt,
      executorId: value.claim.executorId,
      reasonCode: "unknown_safe_failure"
    }) as HostedRejectStartRequestV1;
    const input = {
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      credentialId: value.claim.authority.credentialId,
      runnerId: value.claim.runnerId,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      executorId: value.claim.executorId,
      reason: "source refetch failed",
      request: rejectRequest
    };
    sqlite.exec(`CREATE TRIGGER reject_preimport_lifecycle_insert
      BEFORE INSERT ON hosted_lifecycle_operations
      BEGIN SELECT RAISE(ABORT, 'injected preimport lifecycle failure'); END;`);
    await expect(repo.rejectHostedAttemptStartLocally(input))
      .rejects.toThrow("injected preimport lifecycle failure");
    expect(sqlite.prepare(
      "SELECT active_key AS activeKey FROM hosted_claim_operations WHERE operation_id = ?"
    ).get(value.claim.operationId)).toMatchObject({ activeKey: expect.any(String) });
    expect(sqlite.prepare("SELECT count(*) AS count FROM hosted_lifecycle_operations").get())
      .toEqual({ count: 0 });
    sqlite.exec("DROP TRIGGER reject_preimport_lifecycle_insert");
    const first = await repo.rejectHostedAttemptStartLocally(input);
    expect(first).toMatchObject({ outcome: "journaled", operation: { action: "reject-start", sequence: 1 } });
    await expect(repo.rejectHostedAttemptStartLocally(input)).resolves.toMatchObject({
      outcome: "journaled",
      operation: { operationId: first.operation.operationId }
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
    await expect(repo.getHostedClaimOperationForRetry({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId
    })).resolves.toMatchObject({ operationId: value.claim.operationId, state: "claimed" });
    await expect(repo.getHostedPreImportAuthorityRecovery({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId
    })).resolves.toMatchObject({
      state: "reject_pending",
      lifecycleOperation: { operationId: first.operation.operationId }
    });
    await expect(repo.importHostedAssignedRun(value))
      .rejects.toMatchObject({ code: "HOSTED_IMPORT_AUTHORITY_CONFLICT" });
    const [retryLease] = await repo.claimDueHostedLifecycleOperations({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      leaseOwner: "reject-pump",
      leaseSeconds: 30
    });
    const retryAt = new Date(Date.now() + 1_000);
    await expect(repo.retryHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      operationId: rejectRequest.operationId,
      leaseToken: retryLease!.leaseToken!,
      reasonCode: "provider_unavailable",
      nextAttemptAt: retryAt.toISOString()
    })).resolves.toBe("retried");
    await expect(repo.getHostedPreImportAuthorityRecovery({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId
    })).resolves.toMatchObject({ state: "reject_pending" });
    const [leasedReject] = await repo.claimDueHostedLifecycleOperations({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      leaseOwner: "reject-pump",
      leaseSeconds: 30,
      now: retryAt
    });
    sqlite.exec(`CREATE TRIGGER ignore_preimport_reject_claim_release
      BEFORE UPDATE OF active_key ON hosted_claim_operations
      WHEN OLD.operation_id = '${value.claim.operationId}'
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      operationId: rejectRequest.operationId,
      leaseToken: leasedReject!.leaseToken!,
      receipt: await rejectStartReceipt({ claim: value.claim, request: rejectRequest })
    })).rejects.toThrow("hosted_reject_start_claim_update_lost");
    expect(sqlite.prepare(
      "SELECT state, lease_token AS leaseToken FROM hosted_lifecycle_operations WHERE operation_id = ?"
    ).get(rejectRequest.operationId)).toEqual({
      state: "leased",
      leaseToken: leasedReject!.leaseToken
    });
    expect(sqlite.prepare(
      "SELECT active_key AS activeKey FROM hosted_claim_operations WHERE operation_id = ?"
    ).get(value.claim.operationId)).toMatchObject({ activeKey: expect.any(String) });
    sqlite.exec("DROP TRIGGER ignore_preimport_reject_claim_release");
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      operationId: rejectRequest.operationId,
      leaseToken: leasedReject!.leaseToken!,
      receipt: await rejectStartReceipt({ claim: value.claim, request: rejectRequest })
    })).resolves.toBe("acknowledged");
    await expect(repo.getHostedPreImportAuthorityRecovery({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId
    })).resolves.toBeNull();
    await expect(repo.getHostedClaimOperationForRetry({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId
    })).resolves.toBeNull();
  });

  it("acknowledges a post-import reject-start after the claim shell was consumed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    expect(sqlite.prepare(
      "SELECT active_key AS activeKey FROM hosted_claim_operations WHERE operation_id = ?"
    ).get(value.claim.operationId)).toEqual({ activeKey: null });
    const rejectRequest = await buildHostedLifecycleRequestV1({
      action: "reject-start",
      organizationId: value.claim.organizationId,
      runnerId: value.claim.runnerId,
      runId: value.claim.runId,
      attempt: {
        attemptId: value.claim.attempt.id,
        attemptNumber: value.claim.attempt.number,
        epoch: value.claim.attempt.epoch,
        fencingToken: value.claim.attempt.fencingToken,
        fencingTokenDigest: value.claim.attempt.fencingTokenDigest
      },
      occurredAt: observedAt,
      executorId: value.claim.executorId,
      reasonCode: "unknown_safe_failure"
    }) as HostedRejectStartRequestV1;
    const rejected = await repo.rejectHostedAttemptStartLocally({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      credentialId: value.claim.authority.credentialId,
      runnerId: value.claim.runnerId,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      executorId: value.claim.executorId,
      reason: "executor start failed",
      request: rejectRequest
    });
    const [leasedReject] = await repo.claimDueHostedLifecycleOperations({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      leaseOwner: "reject-pump",
      leaseSeconds: 30
    });
    expect(leasedReject).toMatchObject({ operationId: rejected.operation.operationId });
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: value.claim.organizationId,
      operationId: rejectRequest.operationId,
      leaseToken: leasedReject!.leaseToken!,
      receipt: await rejectStartReceipt({ claim: value.claim, request: rejectRequest })
    })).resolves.toBe("acknowledged");
  });

  it("keeps expired hosted assignments outside the legacy lease expiry and claim paths", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture({ leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    await expect(repo.claimNextRun({ runnerId: "legacy-runner", leaseSeconds: 60 })).resolves.toBeNull();
    expect(sqlite.prepare("SELECT status, current_attempt_id FROM runs WHERE id = ?").get("hosted-run-1"))
      .toEqual({ status: "assigned", current_attempt_id: "attempt-cloud-1" });
    expect(sqlite.prepare("SELECT status FROM attempts WHERE id = ?").get("attempt-cloud-1"))
      .toEqual({ status: "assigned" });
  });

  it("fails closed for Run, admission, operation, attempt, fence, source, and authority collisions", async () => {
    const cases: Array<[string, Awaited<ReturnType<typeof fixture>>, string]> = [
      ["run", await fixture({ admissionId: "admission-2", admissionOperationId: "admission-op-2", claimOperationId: "claim-op-2", requestId: "request-2", attemptId: "attempt-2", deliveryId: "delivery-2", providerEventId: "790", fencingToken: "fence-2" }), "HOSTED_IMPORT_RUN_CONFLICT"],
      ["admission", await fixture({ runId: "run-2", claimOperationId: "claim-op-2", requestId: "request-2", attemptId: "attempt-2", deliveryId: "delivery-2", providerEventId: "790", fencingToken: "fence-2" }), "HOSTED_IMPORT_ADMISSION_CONFLICT"],
      ["operation", await fixture({ runId: "run-2", admissionId: "admission-2", claimOperationId: "claim-op-2", requestId: "request-2", attemptId: "attempt-2", deliveryId: "delivery-2", providerEventId: "790", fencingToken: "fence-2" }), "HOSTED_IMPORT_OPERATION_CONFLICT"],
      ["attempt", await fixture({ runId: "run-2", admissionId: "admission-2", admissionOperationId: "admission-op-2", claimOperationId: "claim-op-2", requestId: "request-2", deliveryId: "delivery-2", providerEventId: "790", fencingToken: "fence-2" }), "HOSTED_IMPORT_ATTEMPT_CONFLICT"],
      ["fence", await fixture({ runId: "run-2", admissionId: "admission-2", admissionOperationId: "admission-op-2", claimOperationId: "claim-op-2", requestId: "request-2", attemptId: "attempt-2", deliveryId: "delivery-2", providerEventId: "790" }), "HOSTED_IMPORT_FENCE_CONFLICT"]
    ];
    for (const [, collision, code] of cases) {
      const sqlite = new Database(":memory:");
      migrateSchema(sqlite);
      const repo = createOpenTagRepository(drizzle(sqlite));
      const original = await fixture();
      await begin(repo, original);
      await repo.importHostedAssignedRun(original);
      await begin(repo, collision);
      await expect(repo.importHostedAssignedRun(collision)).rejects.toMatchObject({ code });
      expect(sqlite.prepare("SELECT COUNT(*) count FROM runs").get()).toEqual({ count: 1 });
      sqlite.close();
    }
  });

  it("rejects a locally refetched event whose execution-bearing source digest differs", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture();
    await begin(repo, value);
    await expect(repo.importHostedAssignedRun({
      claim: value.claim,
      sourceReceipt: value.sourceReceipt,
      event: { ...value.event, command: { ...value.event.command, rawText: "different command" } }
    })).rejects.toMatchObject({ code: "HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT" });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM runs").get()).toEqual({ count: 0 });
  });

  it("acks an empty poll before allowing a new operation and rejects operation digest drift", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const first = await fixture();
    await begin(repo, first);
    const proposed = await fixture({ claimOperationId: "claim-op-2", requestId: "request-2" });
    await expect(begin(repo, proposed)).resolves.toMatchObject({ outcome: "replayed", operation: { request: first.request } });
    await repo.acknowledgeHostedClaimEmpty({ operationId: first.request.operationId, requestId: first.request.requestId });
    await expect(begin(repo, proposed)).resolves.toMatchObject({ outcome: "created", operation: { request: proposed.request } });
    await expect(repo.beginHostedClaimOperation({
      destinationId: "other-cloud",
      organizationId: "org-1",
      runnerId: "runner-1",
      request: { ...proposed.request, requestId: "drifted" }
    })).rejects.toMatchObject({ code: "HOSTED_CLAIM_OPERATION_CONFLICT" });
  });

  it("terminally abandons only an authoritative pending-operation rejection", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture();
    await begin(repo, value);
    await expect(repo.abandonHostedClaimOperation({
      operationId: value.request.operationId,
      requestId: value.request.requestId,
      reasonCode: "stale_control_authority"
    })).resolves.toMatchObject({ state: "empty", terminalReasonCode: "stale_control_authority" });
    await expect(repo.getHostedClaimOperationForRetry({
      destinationId: "cloud-1",
      organizationId: "org-1",
      runnerId: "runner-1"
    })).resolves.toBeNull();
  });

  it("rolls back all imported rows when the canonical WorkThread is corrupt", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture();
    await begin(repo, value);
    sqlite.prepare(`INSERT INTO work_threads (
      id, scope_id, canonical_key, provider, owner_container_id, work_item_kind,
      external_id, thread_json, created_at, updated_at
    ) VALUES (?, 'local', ?, 'github', 'acme/widget', 'issue', 'acme/widget#42', '{}', ?, ?)`)
      .run("corrupt-thread", JSON.stringify(["github", "github", "acme/widget", "issue", "acme/widget#42"]), observedAt, observedAt);
    await expect(repo.importHostedAssignedRun(value)).rejects.toMatchObject({ code: "HOSTED_IMPORT_WORK_THREAD_CONFLICT" });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM runs").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT state FROM hosted_claim_operations").get()).toEqual({ state: "pending" });
  });
});

describe("hosted heartbeat lease authority", () => {
  it("rejects every lifecycle action through the non-atomic enqueue API", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const fencingToken = "local-fence";
    const attempt = {
      attemptId: "attempt-lifecycle-1",
      attemptNumber: 1,
      epoch: 1,
      fencingToken,
      fencingTokenDigest: await computeHostedClaimFencingTokenDigestV1(fencingToken)
    };
    const common = {
      organizationId: "org-1",
      runnerId: "runner-1",
      runId: "run-lifecycle-1",
      attempt,
      occurredAt: "2026-08-10T00:01:00.000Z"
    };
    const requests = [
      ["heartbeat", await buildHostedLifecycleRequestV1({
        ...common, action: "heartbeat", expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z"
      })],
      ["running", await buildHostedLifecycleRequestV1({
        ...common, action: "running", executorId: "codex", executorCapabilityDigest: digestA
      })],
      ["reject-start", await buildHostedLifecycleRequestV1({
        ...common, action: "reject-start", executorId: "codex", reasonCode: "executor_unavailable"
      })],
      ["progress", await buildHostedLifecycleRequestV1({
        ...common, action: "progress", progressId: `progress_${"1".repeat(64)}`, progressDigest: digestA
      })],
      ["complete", await buildHostedLifecycleRequestV1({
        ...common,
        action: "complete",
        conclusion: "success",
        reasonCode: "executor_success",
        resultDigest: digestA,
        artifactDigests: [],
        evidenceDigests: []
      })]
    ] as const;
    for (const [action, lifecycleRequest] of requests) {
      await expect(repo.enqueueHostedLifecycleOperation({
        destinationId: "cloud-1",
        organizationId: "org-1",
        runnerId: "runner-1",
        credentialId: "credential-1",
        runId: "run-lifecycle-1",
        action,
        request: lifecycleRequest
      })).rejects.toMatchObject({
        code: "HOSTED_LIFECYCLE_ATOMIC_API_REQUIRED"
      });
    }
    expect(sqlite.prepare("SELECT count(*) AS count FROM hosted_lifecycle_operations").get())
      .toEqual({ count: 0 });
  });

  it("commits local completion and executor-result lifecycle journal atomically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    await startHostedExecution(repo, value.claim);
    const result = { conclusion: "success" as const, summary: "completed locally" };
    const request = await buildHostedLifecycleRequestV1({
      action: "complete",
      organizationId: "org-1",
      runnerId: "runner-1",
      runId: value.claim.runId,
      attempt: {
        attemptId: value.claim.attempt.id,
        attemptNumber: value.claim.attempt.number,
        epoch: value.claim.attempt.epoch,
        fencingToken: value.claim.attempt.fencingToken,
        fencingTokenDigest: value.claim.attempt.fencingTokenDigest
      },
      occurredAt: "2026-08-10T00:01:00.000Z",
      conclusion: "success",
      reasonCode: "executor_success",
      resultDigest: await computeControlPayloadDigestV1(result),
      artifactDigests: [],
      evidenceDigests: []
    });
    sqlite.exec(`CREATE TRIGGER reject_hosted_complete_journal
      BEFORE INSERT ON hosted_lifecycle_operations
      BEGIN SELECT RAISE(ABORT, 'injected hosted lifecycle failure'); END;`);
    const completion = {
      runId: value.claim.runId,
      result,
      runnerId: "runner-1",
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      destinationId: "cloud-1",
      organizationId: "org-1",
      credentialId: "credential-1",
      request
    };
    const forgedOperationId = `op_${"0".repeat(64)}`;
    await expect(repo.completeHostedRunLocally({
      ...completion,
      request: {
        ...request,
        operationId: forgedOperationId,
        requestId: await computeHostedLifecycleRequestIdV1({
          operationId: forgedOperationId,
          requestDigest: request.requestDigest,
        }),
      },
    })).rejects.toMatchObject({ code: "HOSTED_LIFECYCLE_OPERATION_INVALID" });
    await expect(repo.completeHostedRunLocally(completion)).rejects.toThrow("injected hosted lifecycle failure");
    expect(sqlite.prepare("SELECT status, result_json AS resultJson FROM runs WHERE id = ?")
      .get(value.claim.runId)).toEqual({ status: "running", resultJson: null });
    expect(sqlite.prepare("SELECT count(*) AS count FROM reassessment_obligations").get())
      .toEqual({ count: 0 });
    sqlite.exec("DROP TRIGGER reject_hosted_complete_journal");
    await expect(repo.completeHostedRunLocally(completion)).resolves.toBe("completed");
    await expect(repo.completeHostedRunLocally(completion)).resolves.toBe("duplicate");
    const alternateRequest = await buildHostedLifecycleRequestV1({
      action: "complete",
      organizationId: "org-1",
      runnerId: "runner-1",
      runId: value.claim.runId,
      attempt: {
        attemptId: value.claim.attempt.id,
        attemptNumber: value.claim.attempt.number,
        epoch: value.claim.attempt.epoch,
        fencingToken: value.claim.attempt.fencingToken,
        fencingTokenDigest: value.claim.attempt.fencingTokenDigest,
      },
      occurredAt: "2026-08-10T00:01:01.000Z",
      conclusion: "success",
      reasonCode: "executor_success",
      resultDigest: await computeControlPayloadDigestV1(result),
      artifactDigests: [],
      evidenceDigests: [],
    });
    await expect(repo.completeHostedRunLocally({
      ...completion,
      request: alternateRequest,
    })).rejects.toMatchObject({ code: "HOSTED_LIFECYCLE_OPERATION_CONFLICT" });
    await expect(repo.completeRun({
      runId: completion.runId,
      result,
      runnerId: completion.runnerId,
      attemptId: completion.attemptId,
      fencingToken: completion.fencingToken,
      hostedLifecycleOperation: { forged: true },
    } as unknown as Parameters<typeof repo.completeRun>[0])).resolves.toBe("duplicate");
    expect(sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(value.claim.runId))
      .toEqual({ status: "succeeded" });
    expect(sqlite.prepare("SELECT action, state FROM hosted_lifecycle_operations WHERE action = 'complete'").get())
      .toEqual({ action: "complete", state: "pending" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM hosted_lifecycle_operations").get())
      .toEqual({ count: 2 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM reassessment_obligations").get())
      .toEqual({ count: 1 });
  });

  it("validates hosted completion against the one sanitized persisted result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    await startHostedExecution(repo, value.claim);
    const rawResult = {
      conclusion: "success" as const,
      summary: `completed with ${value.claim.attempt.fencingToken}`,
    };
    const persistedResult = {
      conclusion: "success" as const,
      summary: "completed with [redacted]",
    };
    const mismatchedAttemptRequest = await buildHostedLifecycleRequestV1({
      action: "complete",
      organizationId: "org-1",
      runnerId: "runner-1",
      runId: value.claim.runId,
      attempt: {
        attemptId: value.claim.attempt.id,
        attemptNumber: 2,
        epoch: 2,
        fencingToken: value.claim.attempt.fencingToken,
        fencingTokenDigest: value.claim.attempt.fencingTokenDigest,
      },
      occurredAt: "2026-08-10T00:01:00.000Z",
      conclusion: "success",
      reasonCode: "executor_success",
      resultDigest: await computeControlPayloadDigestV1(persistedResult),
      artifactDigests: [],
      evidenceDigests: [],
    });
    await expect(repo.completeHostedRunLocally({
      runId: value.claim.runId,
      result: rawResult,
      runnerId: "runner-1",
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      destinationId: "cloud-1",
      organizationId: "org-1",
      credentialId: "credential-1",
      request: mismatchedAttemptRequest,
    })).rejects.toMatchObject({ code: "HOSTED_LIFECYCLE_OPERATION_INVALID" });
    expect(sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(value.claim.runId))
      .toEqual({ status: "running" });
    const request = await buildHostedLifecycleRequestV1({
      action: "complete",
      organizationId: "org-1",
      runnerId: "runner-1",
      runId: value.claim.runId,
      attempt: {
        attemptId: value.claim.attempt.id,
        attemptNumber: value.claim.attempt.number,
        epoch: value.claim.attempt.epoch,
        fencingToken: value.claim.attempt.fencingToken,
        fencingTokenDigest: value.claim.attempt.fencingTokenDigest,
      },
      occurredAt: "2026-08-10T00:01:00.000Z",
      conclusion: "success",
      reasonCode: "executor_success",
      resultDigest: await computeControlPayloadDigestV1(persistedResult),
      artifactDigests: [],
      evidenceDigests: [],
    });
    await expect(repo.completeHostedRunLocally({
      runId: value.claim.runId,
      result: rawResult,
      runnerId: "runner-1",
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      destinationId: "cloud-1",
      organizationId: "org-1",
      credentialId: "credential-1",
      request,
    })).resolves.toBe("completed");
    const stored = sqlite.prepare("SELECT result_json AS resultJson FROM runs WHERE id = ?")
      .get(value.claim.runId) as { resultJson: string };
    expect(JSON.parse(stored.resultJson)).toEqual(persistedResult);
    expect(stored.resultJson).not.toContain(value.claim.attempt.fencingToken);
  });

  it("durably replays the exact pending request after response loss and restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const directory = await mkdtemp(join(tmpdir(), "opentag-hosted-heartbeat-"));
    tempDirs.push(directory);
    const path = join(directory, "store.sqlite");
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    const firstSqlite = new Database(path);
    migrateSchema(firstSqlite);
    const first = createOpenTagRepository(drizzle(firstSqlite));
    await begin(first, value);
    await first.importHostedAssignedRun(value);
    await startHostedExecution(first, value.claim);
    const request = await heartbeatRequest({
      claim: value.claim,
      expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z"
    });
    await expect(first.enqueueHostedLifecycleOperation({
      destinationId: heartbeatAuthority.destinationId,
      organizationId: heartbeatAuthority.organizationId,
      runnerId: heartbeatAuthority.runnerId,
      credentialId: heartbeatAuthority.credentialId,
      runId: value.claim.runId,
      action: "heartbeat",
      request
    })).rejects.toMatchObject({ code: "HOSTED_LIFECYCLE_ATOMIC_API_REQUIRED" });
    await expect(first.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request
    })).resolves.toMatchObject({ outcome: "created", operation: { request } });
    firstSqlite.close();

    vi.setSystemTime(new Date("2026-08-10T00:01:15.000Z"));
    const secondSqlite = new Database(path);
    migrateSchema(secondSqlite);
    const second = createOpenTagRepository(drizzle(secondSqlite));
    await expect(second.getHostedHeartbeatOperationForRetry({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken
    })).resolves.toMatchObject({ request, expectedLeaseExpiresAt: request.expectedLeaseExpiresAt });
    await expect(second.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request
    })).resolves.toMatchObject({ outcome: "replayed", operation: { request } });
    secondSqlite.close();
  });

  it("rolls back an injected lease mutation when heartbeat journaling loses its insert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    await startHostedExecution(repo, value.claim);
    const request = await heartbeatRequest({
      claim: value.claim,
      expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z"
    });
    sqlite.exec(`CREATE TRIGGER mutate_lease_and_ignore_heartbeat_insert
      BEFORE INSERT ON hosted_lifecycle_operations
      WHEN NEW.action = 'heartbeat'
      BEGIN
        UPDATE attempts
          SET lease_expires_at = '2026-08-10T00:01:30.000Z'
          WHERE id = NEW.attempt_id;
        SELECT RAISE(IGNORE);
      END;`);
    await expect(repo.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request
    })).rejects.toThrow("hosted_lifecycle_operation_insert_lost");
    expect(sqlite.prepare(
      "SELECT lease_expires_at AS leaseExpiresAt FROM attempts WHERE id = ?"
    ).get(value.claim.attempt.id)).toEqual({ leaseExpiresAt: request.expectedLeaseExpiresAt });
    expect(sqlite.prepare(
      "SELECT count(*) AS count FROM hosted_lifecycle_operations WHERE action = 'heartbeat'"
    ).get()).toEqual({ count: 0 });
    sqlite.exec("DROP TRIGGER mutate_lease_and_ignore_heartbeat_insert");
    await expect(repo.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request
    })).resolves.toMatchObject({ outcome: "created", operation: { request } });
  });

  it("accepts a strictly later verified receipt by CAS and makes exact replay non-regressing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    await startHostedExecution(repo, value.claim);
    const request = await heartbeatRequest({
      claim: value.claim,
      expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z"
    });
    await repo.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request
    });
    const receipt = await heartbeatReceipt({
      claim: value.claim,
      request,
      leaseExpiresAt: "2026-08-10T00:04:00.000Z"
    });
    const apply = {
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      operationId: request.operationId,
      requestId: request.requestId,
      receipt
    };
    await expect(repo.applyHostedHeartbeatReceipt({
      ...apply,
      receipt: {
        ...receipt,
        payload: { ...receipt.payload, leaseExpiresAt: "2026-08-10T00:03:30.000Z" }
      }
    })).resolves.toBe("rejected");
    const [claimed] = await repo.claimDueHostedLifecycleOperations({
      destinationId: "cloud-1",
      organizationId: "org-1",
      leaseOwner: "heartbeat-pump",
      leaseSeconds: 30,
      now: new Date("2026-08-10T00:01:00.000Z")
    });
    expect(claimed).toMatchObject({ operationId: request.operationId, action: "heartbeat", state: "leased" });
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: "org-1",
      operationId: request.operationId,
      leaseToken: claimed!.leaseToken!,
      receipt,
      now: new Date("2026-08-10T00:01:01.000Z")
    })).resolves.toBe("acknowledged");
    await expect(repo.getHostedExecutionLease({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken
    })).resolves.toEqual({ leaseExpiresAt: "2026-08-10T00:04:00.000Z" });
    await expect(repo.applyHostedHeartbeatReceipt(apply)).resolves.toBe("replayed");
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: "org-1",
      operationId: request.operationId,
      leaseToken: claimed!.leaseToken!,
      receipt,
      now: new Date("2026-08-10T00:01:02.000Z")
    })).resolves.toBe("acknowledged");
    expect(sqlite.prepare("SELECT lease_expires_at FROM attempts WHERE id = ?").get(value.claim.attempt.id))
      .toEqual({ lease_expires_at: "2026-08-10T00:04:00.000Z" });

    vi.setSystemTime(new Date("2026-08-10T00:02:30.000Z"));
    const secondRequest = await heartbeatRequest({
      claim: value.claim,
      expectedLeaseExpiresAt: "2026-08-10T00:04:00.000Z",
      occurredAt: "2026-08-10T00:02:30.000Z"
    });
    await expect(repo.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request: secondRequest
    })).resolves.toMatchObject({
      outcome: "created",
      operation: { expectedLeaseExpiresAt: "2026-08-10T00:04:00.000Z" }
    });
    const secondReceipt = await heartbeatReceipt({
      claim: value.claim,
      request: secondRequest,
      leaseExpiresAt: "2026-08-10T00:06:00.000Z"
    });
    await expect(repo.applyHostedHeartbeatReceipt({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      operationId: secondRequest.operationId,
      requestId: secondRequest.requestId,
      receipt: secondReceipt
    })).resolves.toBe("accepted");
    await expect(repo.getHostedExecutionLease({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken
    })).resolves.toEqual({ leaseExpiresAt: "2026-08-10T00:06:00.000Z" });
  });

  it("rolls back heartbeat run, attempt, and journal writes when any CAS write is ignored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    await startHostedExecution(repo, value.claim);
    const request = await heartbeatRequest({
      claim: value.claim,
      expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z",
    });
    await repo.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request,
    });
    const [claimed] = await repo.claimDueHostedLifecycleOperations({
      destinationId: "cloud-1",
      organizationId: "org-1",
      leaseOwner: "heartbeat-pump",
      leaseSeconds: 30,
      now: new Date("2026-08-10T00:01:00.000Z"),
    });
    const receipt = await heartbeatReceipt({
      claim: value.claim,
      request,
      leaseExpiresAt: "2026-08-10T00:04:00.000Z",
    });
    const mismatchedRequest = await buildHostedLifecycleRequestV1({
      action: "heartbeat",
      organizationId: "org-1",
      runnerId: "runner-1",
      runId: value.claim.runId,
      attempt: {
        attemptId: value.claim.attempt.id,
        attemptNumber: 2,
        epoch: 2,
        fencingToken: value.claim.attempt.fencingToken,
        fencingTokenDigest: value.claim.attempt.fencingTokenDigest,
      },
      occurredAt: "2026-08-10T00:01:00.000Z",
      expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z",
    });
    expect(mismatchedRequest.attempt.attemptNumber).toBe(2);
    const mismatchedReceipt = await heartbeatReceipt({
      claim: {
        ...value.claim,
        attempt: { ...value.claim.attempt, number: 2, epoch: 2 },
      },
      request: mismatchedRequest,
      leaseExpiresAt: "2026-08-10T00:04:00.000Z",
    });
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: "org-1",
      operationId: request.operationId,
      leaseToken: claimed!.leaseToken!,
      receipt: mismatchedReceipt,
      now: new Date("2026-08-10T00:01:01.000Z"),
    })).resolves.toBe("stale_lease");
    sqlite.exec(`CREATE TRIGGER ignore_hosted_run_heartbeat
      BEFORE UPDATE OF lease_expires_at ON runs
      WHEN OLD.id = '${value.claim.runId}'
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: "org-1",
      operationId: request.operationId,
      leaseToken: claimed!.leaseToken!,
      receipt,
      now: new Date("2026-08-10T00:01:01.000Z"),
    })).rejects.toThrow("hosted_heartbeat_lease_update_lost");
    expect(sqlite.prepare("SELECT lease_expires_at FROM runs WHERE id = ?")
      .get(value.claim.runId)).toEqual({ lease_expires_at: "2026-08-10T00:02:00.000Z" });
    expect(sqlite.prepare("SELECT lease_expires_at FROM attempts WHERE id = ?")
      .get(value.claim.attempt.id)).toEqual({ lease_expires_at: "2026-08-10T00:02:00.000Z" });
    expect(sqlite.prepare("SELECT state FROM hosted_lifecycle_operations WHERE operation_id = ?")
      .get(request.operationId)).toEqual({ state: "leased" });
    sqlite.exec("DROP TRIGGER ignore_hosted_run_heartbeat");
    await repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: "org-1",
      operationId: request.operationId,
      leaseToken: claimed!.leaseToken!,
      receipt,
      now: new Date("2026-08-10T00:01:01.000Z"),
    });

    const nextRequest = await heartbeatRequest({
      claim: value.claim,
      expectedLeaseExpiresAt: "2026-08-10T00:04:00.000Z",
      occurredAt: "2026-08-10T00:02:00.000Z",
    });
    await repo.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request: nextRequest,
    });
    const [nextClaim] = await repo.claimDueHostedLifecycleOperations({
      destinationId: "cloud-1",
      organizationId: "org-1",
      leaseOwner: "heartbeat-pump",
      leaseSeconds: 30,
      now: new Date("2026-08-10T00:02:00.000Z"),
    });
    const nextReceipt = await heartbeatReceipt({
      claim: value.claim,
      request: nextRequest,
      leaseExpiresAt: "2026-08-10T00:06:00.000Z",
    });
    sqlite.exec(`CREATE TRIGGER ignore_hosted_heartbeat_journal
      BEFORE UPDATE OF state ON hosted_lifecycle_operations
      WHEN OLD.operation_id = '${nextRequest.operationId}' AND NEW.state = 'acknowledged'
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud-1",
      organizationId: "org-1",
      operationId: nextRequest.operationId,
      leaseToken: nextClaim!.leaseToken!,
      receipt: nextReceipt,
      now: new Date("2026-08-10T00:02:01.000Z"),
    })).rejects.toThrow("hosted_heartbeat_journal_update_lost");
    expect(sqlite.prepare("SELECT lease_expires_at FROM runs WHERE id = ?")
      .get(value.claim.runId)).toEqual({ lease_expires_at: "2026-08-10T00:04:00.000Z" });
    expect(sqlite.prepare("SELECT lease_expires_at FROM attempts WHERE id = ?")
      .get(value.claim.attempt.id)).toEqual({ lease_expires_at: "2026-08-10T00:04:00.000Z" });
    expect(sqlite.prepare("SELECT state FROM hosted_lifecycle_operations WHERE operation_id = ?")
      .get(nextRequest.operationId)).toEqual({ state: "leased" });
  });

  it("rejects a response arriving after expiry or revocation without reviving execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    await startHostedExecution(repo, value.claim);
    const request = await heartbeatRequest({
      claim: value.claim,
      expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z"
    });
    await repo.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request
    });
    const receipt = await heartbeatReceipt({
      claim: value.claim,
      request,
      leaseExpiresAt: "2026-08-10T00:05:00.000Z"
    });
    vi.setSystemTime(new Date("2026-08-10T00:02:00.001Z"));
    await expect(repo.applyHostedHeartbeatReceipt({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      operationId: request.operationId,
      requestId: request.requestId,
      receipt
    })).resolves.toBe("rejected");
    expect(sqlite.prepare("SELECT lease_expires_at FROM attempts WHERE id = ?").get(value.claim.attempt.id))
      .toEqual({ lease_expires_at: "2026-08-10T00:02:00.000Z" });

    vi.setSystemTime(new Date("2026-08-10T00:01:30.000Z"));
    sqlite.prepare("UPDATE hosted_claim_operations SET terminal_reason_code = ? WHERE operation_id = ?")
      .run("stale_control_authority", value.claim.operationId);
    await expect(repo.applyHostedHeartbeatReceipt({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      operationId: request.operationId,
      requestId: request.requestId,
      receipt
    })).resolves.toBe("rejected");
    expect(sqlite.prepare("SELECT lease_expires_at FROM attempts WHERE id = ?").get(value.claim.attempt.id))
      .toEqual({ lease_expires_at: "2026-08-10T00:02:00.000Z" });
  });

  it("never lets an attempt-1 receipt renew the current attempt 2", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const first = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    await begin(repo, first);
    await repo.importHostedAssignedRun(first);
    await startHostedExecution(repo, first.claim);
    const firstRequest = await heartbeatRequest({
      claim: first.claim,
      expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z"
    });
    await repo.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: first.claim.runId,
      attemptId: first.claim.attempt.id,
      fencingToken: first.claim.attempt.fencingToken,
      request: firstRequest
    });
    const firstReceipt = await heartbeatReceipt({
      claim: first.claim,
      request: firstRequest,
      leaseExpiresAt: "2026-08-10T00:06:00.000Z"
    });

    vi.setSystemTime(new Date("2026-08-10T00:03:00.000Z"));
    const second = await fixture({
      claimOperationId: "claim-op-2",
      requestId: "claim-request-2",
      attemptId: "attempt-cloud-2",
      attemptNumber: 2,
      fencingToken: "cloud-fence-2",
      leaseExpiresAt: "2026-08-10T00:05:00.000Z"
    });
    await begin(repo, second);
    await repo.importHostedAssignedRun(second);
    await startHostedExecution(repo, second.claim);
    await expect(repo.applyHostedHeartbeatReceipt({
      ...heartbeatAuthority,
      runId: first.claim.runId,
      attemptId: first.claim.attempt.id,
      fencingToken: first.claim.attempt.fencingToken,
      operationId: firstRequest.operationId,
      requestId: firstRequest.requestId,
      receipt: firstReceipt
    })).resolves.toBe("rejected");
    await expect(repo.getHostedExecutionLease({
      ...heartbeatAuthority,
      runId: second.claim.runId,
      attemptId: second.claim.attempt.id,
      fencingToken: second.claim.attempt.fencingToken
    })).resolves.toEqual({ leaseExpiresAt: "2026-08-10T00:05:00.000Z" });
  });
});
