import {
  buildHostedLifecycleRequestV1,
  computeHostedClaimFencingTokenDigestV1,
  type HostedClaimV1,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createRunnerDirectory, type RuntimePrincipal } from "../src/modules/runners/index.js";
import {
  HOSTED_CAPABILITIES,
  hostedAdmissionFixture,
  hostedClaimRequest,
  recordHostedReadiness,
} from "./control-fixtures.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("Hosted Coordinator PostgreSQL lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let principal: RuntimePrincipal;
  let now = new Date("2026-08-15T07:00:00.000Z");
  let identity = 0;
  const clock = { now: () => new Date(now) };

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock,
      tokenFactory: () => "runtime_hosted_secret",
      idFactory: () => "credential_hosted",
    });
    const registration = await runners.register({
      organizationId: "org_hosted",
      organizationName: "Hosted",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_hosted",
        operationId: "operation_register_hosted",
        runnerId: "runner_hosted",
        capabilities: [...HOSTED_CAPABILITIES],
      },
    });
    if (registration.kind !== "created") throw new Error("registration failed");
    const authenticated = await runners.authenticate("runtime_hosted_secret");
    if (authenticated.kind !== "authenticated") throw new Error("authentication failed");
    principal = authenticated.principal;
    await recordHostedReadiness({
      pool: fixture.pool,
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  const coordinator = () => createHostedRunCoordinator({
    pool: fixture.pool,
    clock,
    leaseDurationMs: 60_000,
    idFactory: (kind) => `${kind}_${++identity}`,
    tokenFactory: () => `fence_${identity}`,
  });

  async function admitAndClaim(suffix: string): Promise<HostedClaimV1> {
    const service = coordinator();
    const fixtureInput = await hostedAdmissionFixture({
      runId: `run_${suffix}`,
      suffix,
    });
    const admitted = await service.admit({
      runId: `run_${suffix}`,
      admission: fixtureInput.admission,
      policy: fixtureInput.policy,
    });
    expect(admitted.kind).toMatch(/created|replayed/u);
    const claim = await service.claim({
      principal,
      request: hostedClaimRequest({
        operationId: `operation_claim_${suffix}`,
        requestId: `request_claim_${suffix}`,
        readinessDigest: fixtureInput.readinessDigest,
      }),
    });
    if (claim.kind !== "claimed") throw new Error(`claim failed: ${claim.kind}`);
    return claim.claim;
  }

  it("deduplicates admission to one durable Run identity", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({ runId: "run_1", suffix: "1" });

    const first = await service.admit({ runId: "run_1", admission: input.admission, policy: input.policy });
    const second = await service.admit({ runId: "run_1", admission: input.admission, policy: input.policy });

    expect(first).toEqual({ kind: "created", runId: "run_1" });
    expect(second).toEqual({ kind: "replayed", runId: "run_1" });
    const rows = await fixture.pool.query(
      "SELECT run_id FROM cp_hosted_run WHERE admission_id = $1",
      [input.admission.admissionId],
    );
    expect(rows.rowCount).toBe(1);
    await fixture.pool.query(
      "DELETE FROM cp_hosted_audit_event WHERE run_id = 'run_1'",
    );
    await fixture.pool.query("DELETE FROM cp_hosted_run WHERE run_id = 'run_1'");
  });

  it("rejects a claim whose readiness identity is not current", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({
      runId: "run_wrong_readiness",
      suffix: "9",
    });
    await service.admit({
      runId: "run_wrong_readiness",
      admission: input.admission,
      policy: input.policy,
    });

    await expect(service.claim({
      principal,
      request: {
        ...hostedClaimRequest({
          operationId: "operation_claim_wrong_readiness",
          requestId: "request_claim_wrong_readiness",
        }),
        expectedAuthority: {
          ...hostedClaimRequest({
            operationId: "operation_claim_wrong_readiness",
            requestId: "request_claim_wrong_readiness",
          }).expectedAuthority,
          runnerReadinessReceiptId: "readiness_receipt_untrusted",
        },
      },
    })).resolves.toEqual({
      kind: "conflict",
      reason: "authority_mismatch",
    });

    await fixture.pool.query(
      "DELETE FROM cp_hosted_audit_event WHERE run_id = 'run_wrong_readiness'",
    );
    await fixture.pool.query(
      "DELETE FROM cp_hosted_run WHERE run_id = 'run_wrong_readiness'",
    );
  });

  it("gives exactly one concurrent claimer the lease", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({ runId: "run_2", suffix: "2" });
    await service.admit({ runId: "run_2", admission: input.admission, policy: input.policy });

    const outcomes = await Promise.all([
      service.claim({
        principal,
        request: hostedClaimRequest({
          operationId: "operation_claim_2a",
          requestId: "request_claim_2a",
        }),
      }),
      service.claim({
        principal,
        request: hostedClaimRequest({
          operationId: "operation_claim_2b",
          requestId: "request_claim_2b",
        }),
      }),
    ]);

    expect(outcomes.filter(({ kind }) => kind === "claimed")).toHaveLength(1);
    expect(outcomes.filter(({ kind }) => kind === "empty")).toHaveLength(1);
  });

  it("replays one concurrent claim operation against one pending Run", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({
      runId: "run_claim_replay_one",
      suffix: "d20",
    });
    await service.admit({
      runId: "run_claim_replay_one",
      admission: input.admission,
      policy: input.policy,
    });
    const command = {
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_replay_one",
        requestId: "request_claim_replay_one",
      }),
    };

    const outcomes = await Promise.all([
      service.claim(command),
      service.claim(command),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "claimed",
      "replayed",
    ]);
    const claims = outcomes.flatMap((outcome) =>
      outcome.kind === "claimed" || outcome.kind === "replayed"
        ? [outcome.claim]
        : []
    );
    expect(claims).toHaveLength(2);
    expect(claims[1]).toEqual(claims[0]);
  });

  it("replays one concurrent claim operation without claiming a second pending Run", async () => {
    const service = coordinator();
    const first = await hostedAdmissionFixture({
      runId: "run_claim_replay_many_a",
      suffix: "a21",
    });
    const second = await hostedAdmissionFixture({
      runId: "run_claim_replay_many_b",
      suffix: "b22",
    });
    await service.admit({
      runId: "run_claim_replay_many_a",
      admission: first.admission,
      policy: first.policy,
    });
    await service.admit({
      runId: "run_claim_replay_many_b",
      admission: second.admission,
      policy: second.policy,
    });
    const command = {
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_replay_many",
        requestId: "request_claim_replay_many",
      }),
    };

    const outcomes = await Promise.all([
      service.claim(command),
      service.claim(command),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "claimed",
      "replayed",
    ]);
    const claims = outcomes.flatMap((outcome) =>
      outcome.kind === "claimed" || outcome.kind === "replayed"
        ? [outcome.claim]
        : []
    );
    expect(new Set(claims.map(({ runId }) => runId)).size).toBe(1);
    const pendingRuns = await fixture.pool.query(
      `SELECT run_id
       FROM cp_hosted_run
       WHERE run_id IN ('run_claim_replay_many_a', 'run_claim_replay_many_b')
         AND state = 'pending'`,
    );
    expect(pendingRuns.rowCount).toBe(1);
    const pendingRunId = pendingRuns.rows[0]?.run_id as string;
    await fixture.pool.query(
      "DELETE FROM cp_hosted_audit_event WHERE run_id = $1",
      [pendingRunId],
    );
    await fixture.pool.query(
      "DELETE FROM cp_hosted_run WHERE run_id = $1",
      [pendingRunId],
    );
  });

  it("conflicts one concurrent claim operation whose request digest changes", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({
      runId: "run_claim_operation_mismatch",
      suffix: "e20",
    });
    await service.admit({
      runId: "run_claim_operation_mismatch",
      admission: input.admission,
      policy: input.policy,
    });
    const request = hostedClaimRequest({
      operationId: "operation_claim_digest_mismatch",
      requestId: "request_claim_digest_mismatch_a",
    });

    const outcomes = await Promise.all([
      service.claim({ principal, request }),
      service.claim({
        principal,
        request: {
          ...request,
          requestId: "request_claim_digest_mismatch_b",
        },
      }),
    ]);

    expect(outcomes.filter(({ kind }) => kind === "claimed")).toHaveLength(1);
    expect(outcomes.filter(({ kind }) => kind === "conflict")).toEqual([
      { kind: "conflict", reason: "operation_mismatch" },
    ]);
  });

  it("rejects a stale fence and never reopens a completed Run", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("3");
    const staleToken = "stale_fence";
    const stale = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "progress",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: staleToken,
        fencingTokenDigest: await computeHostedClaimFencingTokenDigestV1(
          staleToken,
        ),
      },
      occurredAt: now.toISOString(),
      progressId: `progress_${"1".repeat(64)}`,
      progressDigest: `sha256:${"2".repeat(64)}`,
    });
    await expect(
      service.lifecycle({ principal, runId: claim.runId, action: "progress", request: stale }),
    ).resolves.toEqual({ kind: "stale_fence" });

    const complete = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "complete",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      conclusion: "success",
      reasonCode: "executor_success",
      resultDigest: `sha256:${"3".repeat(64)}`,
      artifactDigests: [],
      evidenceDigests: [],
    });
    const settled = await service.lifecycle({
      principal,
      runId: claim.runId,
      action: "complete",
      request: complete,
    });
    expect(settled.kind).toBe("accepted");

    const late = await buildHostedLifecycleRequestV1({
      ...{
        organizationId: principal.organizationId,
        runnerId: principal.runnerId,
        runId: claim.runId,
        action: "complete" as const,
        attempt: {
          attemptId: claim.attempt.id,
          attemptNumber: claim.attempt.number,
          epoch: claim.attempt.epoch,
          fencingToken: claim.attempt.fencingToken,
          fencingTokenDigest: claim.attempt.fencingTokenDigest,
        },
        occurredAt: new Date(now.getTime() + 1_000).toISOString(),
        conclusion: "failure" as const,
        reasonCode: "executor_failure" as const,
        resultDigest: `sha256:${"4".repeat(64)}`,
        artifactDigests: [],
        evidenceDigests: [],
      },
    });
    await expect(
      service.lifecycle({ principal, runId: claim.runId, action: "complete", request: late }),
    ).resolves.toEqual({ kind: "terminal", terminalKind: "completed" });
  });

  it("settles cancellation racing completion exactly once", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("4");
    const complete = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "complete",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      conclusion: "success",
      reasonCode: "executor_success",
      resultDigest: `sha256:${"5".repeat(64)}`,
      artifactDigests: [],
      evidenceDigests: [],
    });
    const cancel = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "cancel",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      reasonCode: "operator_cancelled",
    });

    const outcomes = await Promise.all([
      service.lifecycle({
        principal,
        runId: claim.runId,
        action: "cancel",
        request: cancel,
      }),
      service.lifecycle({ principal, runId: claim.runId, action: "complete", request: complete }),
    ]);
    expect(outcomes.filter(({ kind }) => kind === "accepted")).toHaveLength(1);
    expect(outcomes.filter(({ kind }) => kind === "terminal")).toHaveLength(1);
    const terminal = await service.inspect({ organizationId: "org_hosted", runId: claim.runId });
    expect(terminal?.state).toMatch(/cancelled|completed/u);
  });

  it("replays one lifecycle receipt under an identical concurrent operation", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("concurrent_lifecycle");
    const progress = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "progress",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      progressId: `progress_${"8".repeat(64)}`,
      progressDigest: `sha256:${"9".repeat(64)}`,
    });

    const outcomes = await Promise.all([
      service.lifecycle({
        principal,
        runId: claim.runId,
        action: "progress",
        request: progress,
      }),
      service.lifecycle({
        principal,
        runId: claim.runId,
        action: "progress",
        request: progress,
      }),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "accepted",
      "replayed",
    ]);
    const receipts = await fixture.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM cp_hosted_lifecycle_receipt
       WHERE organization_id = $1 AND operation_id = $2`,
      [principal.organizationId, progress.operationId],
    );
    expect(receipts.rows[0]?.count).toBe(1);
  });

  it("reclaims an expired lease with a new attempt and fences the old one", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("5");
    now = new Date(now.getTime() + 61_000);
    const reclaimed = await service.claim({
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_5b",
        requestId: "request_claim_5b",
      }),
    });
    expect(reclaimed.kind).toBe("claimed");
    if (reclaimed.kind !== "claimed") throw new Error("reclaim failed");
    expect(reclaimed.claim.attempt.number).toBe(2);
    expect(reclaimed.claim.attempt.id).not.toBe(claim.attempt.id);

    const heartbeat = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "heartbeat",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      expectedLeaseExpiresAt: claim.attempt.leaseExpiresAt,
    });
    await expect(
      service.lifecycle({ principal, runId: claim.runId, action: "heartbeat", request: heartbeat }),
    ).resolves.toEqual({ kind: "stale_fence" });
  });

  it("rolls back admission if its audit write fails", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({ runId: "run_rollback", suffix: "6" });
    await fixture.pool.query(
      `ALTER TABLE cp_hosted_audit_event
       ADD CONSTRAINT reject_rollback_audit
       CHECK ((event ->> 'runId') <> 'run_rollback')`,
    );
    await expect(
      service.admit({ runId: "run_rollback", admission: input.admission, policy: input.policy }),
    ).rejects.toThrow();
    const row = await fixture.pool.query(
      "SELECT run_id FROM cp_hosted_run WHERE run_id = 'run_rollback'",
    );
    expect(row.rowCount).toBe(0);
    await fixture.pool.query(
      "ALTER TABLE cp_hosted_audit_event DROP CONSTRAINT reject_rollback_audit",
    );
  });
});
