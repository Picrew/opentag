import {
  computePermissionRequestDigestV1,
  HumanPermissionDecisionRequestV1Schema,
  PermissionResolutionReceiptEnvelopeV1Schema,
  RunnerPermissionCurrentQueryV1Schema,
  RunnerPermissionRequestV1Schema,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createPermissionCoordinator } from "../src/modules/hosted-runs/permissions.js";
import { createConsoleReadModel } from "../src/modules/console-reads/index.js";
import { createRunnerDirectory, type RuntimePrincipal } from "../src/modules/runners/index.js";
import {
  hostedAdmissionFixture,
  hostedClaimRequest,
  recordHostedReadiness,
} from "./control-fixtures.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("governed permissions PostgreSQL module", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let principal: RuntimePrincipal;
  const now = new Date("2026-08-15T14:00:00.000Z");

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: () => "credential_permission",
      tokenFactory: () => "runtime_permission_secret",
    });
    const registration = await runners.register({
      organizationId: "org_permission",
      organizationName: "Permissions",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_permission",
        operationId: "operation_register_permission",
        runnerId: "runner_permission",
        capabilities: [
          "relay.claim-fence.v1",
          "relay.hosted-admission.v1",
          "relay.hosted-claim.v1",
          "relay.lifecycle.v1",
          "relay.permission.v1",
          "relay.readiness.v1",
        ],
      },
    });
    if (registration.kind !== "created") throw new Error("registration failed");
    const authenticated = await runners.authenticate("runtime_permission_secret");
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

  it("persists waiting authority and resolves exactly one attributed decision", async () => {
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => "attempt_permission",
      tokenFactory: () => "fence_permission",
    });
    const admission = await hostedAdmissionFixture({
      runId: "run_permission",
      suffix: "91",
      organizationId: "org_permission",
      runnerId: "runner_permission",
    });
    await hosted.admit({
      runId: "run_permission",
      admission: admission.admission,
      policy: admission.policy,
    });
    const claimOutcome = await hosted.claim({
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_permission",
        requestId: "request_claim_permission",
        credentialId: "credential_permission",
      }),
    });
    if (claimOutcome.kind !== "claimed") throw new Error("claim failed");
    const claim = claimOutcome.claim;
    const digestInput = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.permission.v1"] as const,
      organizationId: "org_permission",
      runnerId: "runner_permission",
      runId: "run_permission",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      permissionRequestId: "permission_request_1",
      actionId: "action_1",
      actionFamily: "github.merge",
      riskTier: "high" as const,
      targetFingerprint: `sha256:${"1".repeat(64)}`,
      permissionScopes: ["github:merge"],
      policySnapshotRef: admission.policy.payload.snapshotId,
      policySnapshotDigest: admission.policy.receiptDigest,
      requestedAt: now.toISOString(),
    };
    const request = RunnerPermissionRequestV1Schema.parse({
      ...digestInput,
      requestId: "request_permission_1",
      operationId: "operation_permission_1",
      attempt: {
        ...digestInput.attempt,
        fencingToken: claim.attempt.fencingToken,
      },
      permissionRequestDigest: await computePermissionRequestDigestV1(
        digestInput,
      ),
    });
    const permissions = createPermissionCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: (kind) => `${kind}_1`,
    });
    const untrustedPolicyDigestInput = {
      ...digestInput,
      permissionRequestId: "permission_request_untrusted_policy",
      actionId: "action_untrusted_policy",
      policySnapshotDigest: `sha256:${"9".repeat(64)}`,
    };
    const untrustedPolicyRequest = RunnerPermissionRequestV1Schema.parse({
      ...untrustedPolicyDigestInput,
      requestId: "request_permission_untrusted_policy",
      operationId: "operation_permission_untrusted_policy",
      attempt: {
        ...untrustedPolicyDigestInput.attempt,
        fencingToken: claim.attempt.fencingToken,
      },
      permissionRequestDigest: await computePermissionRequestDigestV1(
        untrustedPolicyDigestInput,
      ),
    });
    await expect(permissions.request({
      principal,
      request: untrustedPolicyRequest,
    })).resolves.toEqual({ kind: "stale_fence" });

    const waiting = await permissions.request({ principal, request });
    expect(waiting.kind).toBe("waiting");
    if (waiting.kind !== "waiting") throw new Error("waiting receipt missing");
    expect(
      PermissionResolutionReceiptEnvelopeV1Schema.parse(waiting.receipt).payload,
    ).toMatchObject({ state: "waiting", nextAction: "wait_for_operator" });
    const storedRequest = await fixture.pool.query<{ request: unknown }>(
      `SELECT request FROM cp_permission_request
       WHERE organization_id = $1 AND permission_request_id = $2`,
      [principal.organizationId, request.permissionRequestId],
    );
    expect(JSON.stringify(storedRequest.rows[0]?.request)).not.toContain(
      claim.attempt.fencingToken,
    );
    expect(JSON.stringify(storedRequest.rows[0]?.request)).toContain(
      claim.attempt.fencingTokenDigest,
    );
    const consolePermissions = await createConsoleReadModel({
      pool: fixture.pool,
    }).listPermissions({
      operatorId: "viewer_permission",
      organizationId: principal.organizationId,
      role: "viewer",
      email: "viewer@example.test",
      displayName: "Viewer",
    });
    expect(JSON.stringify(consolePermissions)).not.toContain(
      claim.attempt.fencingToken,
    );
    const query = RunnerPermissionCurrentQueryV1Schema.parse({
      organizationId: request.organizationId,
      runnerId: request.runnerId,
      runId: request.runId,
      attempt: digestInput.attempt,
      actionId: request.actionId,
      permissionRequestId: request.permissionRequestId,
      permissionRequestDigest: request.permissionRequestDigest,
    });
    await expect(permissions.current({ principal, query })).resolves.toMatchObject({
      kind: "waiting",
      receipt: { receiptDigest: waiting.receipt.receiptDigest },
    });

    const allow = HumanPermissionDecisionRequestV1Schema.parse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.permission.v1"],
      requestId: "request_permission_decision_allow",
      operationId: "operation_permission_decision_allow",
      organizationId: "org_permission",
      runId: "run_permission",
      attempt: digestInput.attempt,
      actionId: request.actionId,
      permissionRequestId: request.permissionRequestId,
      permissionRequestDigest: request.permissionRequestDigest,
      policySnapshotDigest: request.policySnapshotDigest,
      decisionId: "decision_allow_1",
      decision: "allow_once",
      decidedAt: now.toISOString(),
    });
    const deny = HumanPermissionDecisionRequestV1Schema.parse({
      ...allow,
      requestId: "request_permission_decision_deny",
      operationId: "operation_permission_decision_deny",
      decisionId: "decision_deny_1",
      decision: "deny",
    });
    const decisions = await Promise.all([
      permissions.resolve({
        principal: {
          organizationId: "org_permission",
          actorId: "api_key_approver",
        },
        runnerId: "runner_permission",
        decision: allow,
      }),
      permissions.resolve({
        principal: {
          organizationId: "org_permission",
          actorId: "api_key_approver",
        },
        runnerId: "runner_permission",
        decision: deny,
      }),
    ]);
    expect(decisions.filter((outcome) => outcome.kind === "resolved")).toHaveLength(1);
    expect(decisions.filter((outcome) => outcome.kind === "conflict")).toHaveLength(1);
    const current = await permissions.current({ principal, query });
    expect(current.kind).toBe("resolved");
    if (current.kind !== "resolved") throw new Error("resolution missing");
    expect(current.receipt.payload.state).toMatch(/authorized|denied/u);
    expect(current.receipt.payload.decisionActorRef).toBe("api_key_approver");
  });
});
