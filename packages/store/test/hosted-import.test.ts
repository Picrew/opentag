import {
  buildHostedLifecycleRequestV1,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeGitHubIssueCommentSourceIdentityDigestV1,
  computeHostedAdmissionEnvelopeDigestV1,
  computeHostedClaimFencingTokenDigestV1,
  type HostedClaimRequestV1,
  type HostedClaimV1,
  type HostedHeartbeatRequestV1,
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
    receiptId: `lifecycle_${input.request.operationId.slice(3)}`,
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

describe("hosted assigned Run import", () => {
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
    await expect(repo.acquireHostedExecutionStart({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-1",
      fencingToken: "cloud-fence-1"
    })).resolves.toBe(true);
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
    })).resolves.toBe(false);
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
    await expect(second.acquireHostedExecutionStart({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-2",
      fencingToken: "cloud-fence-2"
    })).resolves.toBe(true);
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
    await repo.acquireHostedExecutionStart({
      runId: "hosted-run-1",
      attemptId: "attempt-cloud-1",
      fencingToken: "cloud-fence-1"
    });
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
    await first.acquireHostedExecutionStart({
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken
    });
    const request = await heartbeatRequest({
      claim: value.claim,
      expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z"
    });
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
    const replacement = await heartbeatRequest({
      claim: value.claim,
      expectedLeaseExpiresAt: request.expectedLeaseExpiresAt,
      occurredAt: "2026-08-10T00:01:15.000Z"
    });
    await expect(second.beginHostedHeartbeatOperation({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken,
      request: replacement
    })).resolves.toMatchObject({ outcome: "replayed", operation: { request } });
    secondSqlite.close();
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
    await repo.acquireHostedExecutionStart({
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken
    });
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
    await expect(repo.applyHostedHeartbeatReceipt(apply)).resolves.toBe("accepted");
    await expect(repo.getHostedExecutionLease({
      ...heartbeatAuthority,
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken
    })).resolves.toEqual({ leaseExpiresAt: "2026-08-10T00:04:00.000Z" });
    await expect(repo.applyHostedHeartbeatReceipt(apply)).resolves.toBe("replayed");
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

  it("rejects a response arriving after expiry or revocation without reviving execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
    await begin(repo, value);
    await repo.importHostedAssignedRun(value);
    await repo.acquireHostedExecutionStart({
      runId: value.claim.runId,
      attemptId: value.claim.attempt.id,
      fencingToken: value.claim.attempt.fencingToken
    });
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
    await repo.acquireHostedExecutionStart({
      runId: first.claim.runId,
      attemptId: first.claim.attempt.id,
      fencingToken: first.claim.attempt.fencingToken
    });
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
    await repo.acquireHostedExecutionStart({
      runId: second.claim.runId,
      attemptId: second.claim.attempt.id,
      fencingToken: second.claim.attempt.fencingToken
    });
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
