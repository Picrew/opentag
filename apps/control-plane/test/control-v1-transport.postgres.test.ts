import {
  buildHostedLifecycleRequestV1,
  computePermissionRequestDigestV1,
  HumanPermissionDecisionRequestV1Schema,
  RunnerPermissionRequestV1Schema,
} from "@opentag/control-protocol";
import { createOpenTagClient } from "@opentag/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createPermissionCoordinator } from "../src/modules/hosted-runs/permissions.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
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

describe.skipIf(!TEST_DATABASE_URL)("Control V1 Node transport", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let identity = 0;
  const now = new Date("2026-08-15T08:00:00.000Z");

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("runs the existing OpenTag client through register, claim, and complete", async () => {
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => now },
      tokenFactory: () => "runtime_http_secret",
      idFactory: () => "credential_http",
    });
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: (kind) => `${kind}_http_${++identity}`,
      tokenFactory: () => `fence_http_${identity}`,
    });
    const application = createControlPlaneApplication({
      capabilities: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1",
        capabilities: [...HOSTED_CAPABILITIES, "relay.registration.v1"],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "local", releaseSha: "local" },
      },
      readiness: { check: async () => ({ ready: true }) },
      control: {
        bootstrap: {
          authenticate: (token) => token === "bootstrap_http_secret"
            ? { organizationId: "org_http", organizationName: "HTTP tenant" }
            : null,
        },
        runners,
        hosted,
      },
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await application.fetch(new Request(String(url), init));
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    const bootstrapClient = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: {
        kind: "bootstrap_pairing",
        token: "bootstrap_http_secret",
      },
      fetchImpl,
    });
    const registrationRequest = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.registration.v1"] as const,
      requestId: "request_register_http",
      operationId: "operation_register_http",
      runnerId: "runner_http",
      capabilities: [...HOSTED_CAPABILITIES],
    };
    const registered = await bootstrapClient.registerRunnerControlV1(
      registrationRequest,
    );
    expect(registered).toMatchObject({
      replayed: false,
      runnerId: "runner_http",
      runnerToken: "runtime_http_secret",
    });

    const runtimeClient = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: {
        kind: "runtime",
        token: registered.runnerToken,
      },
      fetchImpl,
    });
    await expect(
      runtimeClient.getRunnerControlContextV1({ runnerId: "runner_http" }),
    ).resolves.toMatchObject({
      organizationId: "org_http",
      runnerId: "runner_http",
    });
    await recordHostedReadiness({
      pool: fixture.pool,
      organizationId: "org_http",
      runnerId: "runner_http",
    });

    const hostedInput = await hostedAdmissionFixture({
      runId: "run_http",
      suffix: "7",
      organizationId: "org_http",
      runnerId: "runner_http",
    });
    await hosted.admit({
      runId: "run_http",
      admission: hostedInput.admission,
      policy: hostedInput.policy,
    });
    const claim = await runtimeClient.claimHostedRunControlV1({
      runnerId: "runner_http",
      request: hostedClaimRequest({
        operationId: "operation_claim_http",
        requestId: "request_claim_http",
        credentialId: "credential_http",
      }),
    });
    expect(claim?.runId).toBe("run_http");
    if (!claim) throw new Error("claim missing");
    const complete = await buildHostedLifecycleRequestV1({
      organizationId: "org_http",
      runnerId: "runner_http",
      runId: "run_http",
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
      resultDigest: `sha256:${"8".repeat(64)}`,
      artifactDigests: [],
      evidenceDigests: [],
    });
    await expect(
      runtimeClient.completeHostedRunControlV1({
        organizationId: "org_http",
        credentialId: "credential_http",
        runnerId: "runner_http",
        runId: "run_http",
        request: complete,
      }),
    ).resolves.toMatchObject({ status: 201, replayed: false });

    const cancelInput = await hostedAdmissionFixture({
      runId: "run_http_cancel",
      suffix: "8",
      organizationId: "org_http",
      runnerId: "runner_http",
    });
    await hosted.admit({
      runId: "run_http_cancel",
      admission: cancelInput.admission,
      policy: cancelInput.policy,
    });
    const cancelClaim = await runtimeClient.claimHostedRunControlV1({
      runnerId: "runner_http",
      request: hostedClaimRequest({
        operationId: "operation_claim_http_cancel",
        requestId: "request_claim_http_cancel",
        credentialId: "credential_http",
      }),
    });
    if (!cancelClaim) throw new Error("cancel claim missing");
    const cancel = await buildHostedLifecycleRequestV1({
      organizationId: "org_http",
      runnerId: "runner_http",
      runId: "run_http_cancel",
      action: "cancel",
      attempt: {
        attemptId: cancelClaim.attempt.id,
        attemptNumber: cancelClaim.attempt.number,
        epoch: cancelClaim.attempt.epoch,
        fencingToken: cancelClaim.attempt.fencingToken,
        fencingTokenDigest: cancelClaim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      reasonCode: "operator_cancelled",
    });
    await expect(runtimeClient.cancelHostedRunControlV1({
      organizationId: "org_http",
      credentialId: "credential_http",
      runnerId: "runner_http",
      runId: "run_http_cancel",
      request: cancel,
    })).resolves.toMatchObject({
      status: 201,
      replayed: false,
      receipt: { payload: { operation: "cancel" } },
    });

    const replayInput = await hostedAdmissionFixture({
      runId: "run_http_claim_replay",
      suffix: "f30",
      organizationId: "org_http",
      runnerId: "runner_http",
    });
    await hosted.admit({
      runId: "run_http_claim_replay",
      admission: replayInput.admission,
      policy: replayInput.policy,
    });
    const replayRequest = hostedClaimRequest({
      operationId: "operation_claim_http_replay",
      requestId: "request_claim_http_replay",
      credentialId: "credential_http",
    });
    const replayedClaims = await Promise.all([
      runtimeClient.claimHostedRunControlV1({
        runnerId: "runner_http",
        request: replayRequest,
      }),
      runtimeClient.claimHostedRunControlV1({
        runnerId: "runner_http",
        request: replayRequest,
      }),
    ]);
    expect(replayedClaims[0]).not.toBeNull();
    expect(replayedClaims[1]).toEqual(replayedClaims[0]);
    const attempts = await fixture.pool.query(
      `SELECT attempt_id
       FROM cp_hosted_attempt
       WHERE organization_id = 'org_http'
         AND run_id = 'run_http_claim_replay'`,
    );
    expect(attempts.rowCount).toBe(1);

    const mismatchInput = await hostedAdmissionFixture({
      runId: "run_http_claim_mismatch",
      suffix: "a31",
      organizationId: "org_http",
      runnerId: "runner_http",
    });
    await hosted.admit({
      runId: "run_http_claim_mismatch",
      admission: mismatchInput.admission,
      policy: mismatchInput.policy,
    });
    const mismatchRequest = hostedClaimRequest({
      operationId: "operation_claim_http_mismatch",
      requestId: "request_claim_http_mismatch_a",
      credentialId: "credential_http",
    });
    const mismatchResponses = await Promise.all([
      application.fetch(new Request(
        "http://control.test/v1/runners/runner_http/hosted-claims",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${registered.runnerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(mismatchRequest),
        },
      )),
      application.fetch(new Request(
        "http://control.test/v1/runners/runner_http/hosted-claims",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${registered.runnerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...mismatchRequest,
            requestId: "request_claim_http_mismatch_b",
          }),
        },
      )),
    ]);
    expect(mismatchResponses.map(({ status }) => status).sort()).toEqual([
      200,
      409,
    ]);
    const conflictResponse = mismatchResponses.find(({ status }) => status === 409);
    expect(await conflictResponse?.json()).toMatchObject({
      error: "idempotency_conflict",
    });
  });

  it("conceals runtime routes from invalid credentials", async () => {
    const application = createControlPlaneApplication({
      capabilities: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1",
        capabilities: [],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "local", releaseSha: "local" },
      },
      readiness: { check: async () => ({ ready: true }) },
      control: {
        bootstrap: { authenticate: () => null },
        runners: createRunnerDirectory({
          pool: fixture.pool,
          clock: { now: () => now },
          tokenFactory: () => "unused",
          idFactory: () => "unused",
        }),
        hosted: createHostedRunCoordinator({
          pool: fixture.pool,
          clock: { now: () => now },
          leaseDurationMs: 60_000,
          idFactory: () => "unused",
          tokenFactory: () => "unused",
        }),
      },
    });
    const response = await application.fetch(
      new Request("http://control.test/v1/runners/runner_private/control-context", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain("runner_http");
  });

  it("lets the existing client reprovision with separate recovery authority", async () => {
    let credentialNumber = 0;
    let tokenNumber = 0;
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => now },
      tokenFactory: () => `runtime_reprovision_${++tokenNumber}`,
      idFactory: (kind) => `${kind}_reprovision_${++credentialNumber}`,
    });
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => "unused_reprovision_attempt",
      tokenFactory: () => "unused_reprovision_fence",
    });
    const application = createControlPlaneApplication({
      capabilities: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1",
        capabilities: [
          ...HOSTED_CAPABILITIES,
          "relay.registration.v1",
          "relay.credential-reprovision.v1",
        ].sort(),
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "local", releaseSha: "local" },
      },
      readiness: { check: async () => ({ ready: true }) },
      control: {
        bootstrap: {
          authenticate: (token) => token === "bootstrap_reprovision_secret"
            ? {
                organizationId: "org_reprovision",
                organizationName: "Reprovision tenant",
              }
            : null,
        },
        recovery: {
          authenticate: (token) => token === "recovery_reprovision_secret"
            ? { organizationId: "org_reprovision" }
            : null,
        },
        runners,
        hosted,
      },
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await application.fetch(new Request(String(url), init));
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    const bootstrap = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: {
        kind: "bootstrap_pairing",
        token: "bootstrap_reprovision_secret",
      },
      fetchImpl,
    });
    const registered = await bootstrap.registerRunnerControlV1({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.registration.v1"],
      requestId: "request_register_reprovision_http",
      operationId: "operation_register_reprovision_http",
      runnerId: "runner_reprovision_http",
      capabilities: [...HOSTED_CAPABILITIES],
    });
    const recovery = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: {
        kind: "recovery_pairing",
        token: "recovery_reprovision_secret",
      },
      fetchImpl,
    });
    const reprovisioned = await recovery.reprovisionRunnerControlV1({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.credential-reprovision.v1"],
      requestId: "request_reprovision_http",
      operationId: "operation_reprovision_http",
      runnerId: "runner_reprovision_http",
      recoveryCredentialId: registered.credentialId,
      expectedRegistrationGeneration: 1,
      expectedCredentialGeneration: 1,
    });
    expect(reprovisioned).toMatchObject({
      replayed: false,
      registrationGeneration: 2,
      credentialGeneration: 2,
      runnerToken: "runtime_reprovision_2",
    });
    if (reprovisioned.replayed) throw new Error("fresh credential missing");
    const oldRuntime = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: { kind: "runtime", token: registered.runnerToken },
      fetchImpl,
    });
    await expect(oldRuntime.getRunnerControlContextV1({
      runnerId: "runner_reprovision_http",
    })).rejects.toMatchObject({ status: 401 });
    const newRuntime = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: {
        kind: "runtime",
        token: reprovisioned.runnerToken,
      },
      fetchImpl,
    });
    await expect(newRuntime.getRunnerControlContextV1({
      runnerId: "runner_reprovision_http",
    })).resolves.toMatchObject({
      registrationGeneration: 2,
      credentialGeneration: 2,
    });
  });

  it("runs permission request, scoped approval, and current lookup through the existing client", async () => {
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => now },
      tokenFactory: () => "runtime_permission_http_secret",
      idFactory: () => "credential_permission_http",
    });
    const registration = await runners.register({
      organizationId: "org_permission_http",
      organizationName: "Permission HTTP tenant",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_permission_http",
        operationId: "operation_register_permission_http",
        runnerId: "runner_permission_http",
        capabilities: [...HOSTED_CAPABILITIES, "relay.permission.v1"].sort(),
      },
    });
    if (registration.kind !== "created") throw new Error("registration failed");
    const authenticated = await runners.authenticate(
      "runtime_permission_http_secret",
    );
    if (authenticated.kind !== "authenticated") {
      throw new Error("authentication failed");
    }
    await recordHostedReadiness({
      pool: fixture.pool,
      organizationId: authenticated.principal.organizationId,
      runnerId: authenticated.principal.runnerId,
    });
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => "attempt_permission_http",
      tokenFactory: () => "fence_permission_http",
    });
    const admission = await hostedAdmissionFixture({
      runId: "run_permission_http",
      suffix: "93",
      organizationId: "org_permission_http",
      runnerId: "runner_permission_http",
    });
    await hosted.admit({
      runId: "run_permission_http",
      admission: admission.admission,
      policy: admission.policy,
    });
    const claimOutcome = await hosted.claim({
      principal: authenticated.principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_permission_http",
        requestId: "request_claim_permission_http",
        credentialId: "credential_permission_http",
      }),
    });
    if (claimOutcome.kind !== "claimed") throw new Error("claim failed");
    const claim = claimOutcome.claim;
    const permissions = createPermissionCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: (kind) => `${kind}_http`,
    });
    const application = createControlPlaneApplication({
      capabilities: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1",
        capabilities: ["relay.permission.v1"],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "local", releaseSha: "local" },
      },
      readiness: { check: async () => ({ ready: true }) },
      control: {
        bootstrap: { authenticate: () => null },
        approver: {
          authenticate: async (token) => token === "approver_permission_http"
            ? {
                kind: "authenticated" as const,
                principal: {
                  organizationId: "org_permission_http",
                  actorId: "api_key_permission_http",
                },
              }
            : token === "unscoped_permission_http"
              ? { kind: "insufficient_scope" as const }
              : { kind: "invalid_credential" as const },
        },
        runners,
        hosted,
        permissions,
      },
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await application.fetch(new Request(String(url), init));
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    const digestInput = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.permission.v1"] as const,
      organizationId: "org_permission_http",
      runnerId: "runner_permission_http",
      runId: "run_permission_http",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      permissionRequestId: "permission_request_http",
      actionId: "action_permission_http",
      actionFamily: "github.merge",
      riskTier: "high" as const,
      targetFingerprint: `sha256:${"3".repeat(64)}`,
      permissionScopes: ["github:merge"],
      policySnapshotRef: admission.policy.payload.snapshotId,
      policySnapshotDigest: admission.policy.receiptDigest,
      requestedAt: now.toISOString(),
    };
    const request = RunnerPermissionRequestV1Schema.parse({
      ...digestInput,
      requestId: "request_permission_http",
      operationId: "operation_permission_http",
      attempt: {
        ...digestInput.attempt,
        fencingToken: claim.attempt.fencingToken,
      },
      permissionRequestDigest: await computePermissionRequestDigestV1(
        digestInput,
      ),
    });
    const runtime = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: {
        kind: "runtime",
        token: "runtime_permission_http_secret",
      },
      fetchImpl,
    });
    const waiting = await runtime.requestActionPermissionControlV1(request);
    expect(waiting).toMatchObject({ status: 202, outcome: "waiting" });
    const query = {
      organizationId: request.organizationId,
      runnerId: request.runnerId,
      runId: request.runId,
      attempt: digestInput.attempt,
      actionId: request.actionId,
      permissionRequestId: request.permissionRequestId,
      permissionRequestDigest: request.permissionRequestDigest,
    };
    await expect(
      runtime.getActionPermissionCurrentControlV1(query),
    ).resolves.toMatchObject({ status: 202, outcome: "waiting" });
    const decision = HumanPermissionDecisionRequestV1Schema.parse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.permission.v1"],
      requestId: "request_permission_decision_http",
      operationId: "operation_permission_decision_http",
      organizationId: request.organizationId,
      runId: request.runId,
      attempt: digestInput.attempt,
      actionId: request.actionId,
      permissionRequestId: request.permissionRequestId,
      permissionRequestDigest: request.permissionRequestDigest,
      policySnapshotDigest: request.policySnapshotDigest,
      decisionId: "decision_permission_http",
      decision: "allow_once",
      decidedAt: now.toISOString(),
    });
    const unscoped = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: {
        kind: "approver",
        token: "unscoped_permission_http",
      },
      fetchImpl,
    });
    await expect(
      unscoped.resolveActionPermissionControlV1({
        runnerId: request.runnerId,
        decision,
      }),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
    const approver = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: {
        kind: "approver",
        token: "approver_permission_http",
      },
      fetchImpl,
    });
    await expect(
      approver.resolveActionPermissionControlV1({
        runnerId: request.runnerId,
        decision,
      }),
    ).resolves.toMatchObject({
      status: 200,
      outcome: "resolved",
      receipt: {
        payload: {
          state: "authorized",
          decisionActorRef: "api_key_permission_http",
        },
      },
    });
    await expect(
      runtime.getActionPermissionCurrentControlV1(query),
    ).resolves.toMatchObject({ status: 200, outcome: "resolved" });
  });
});
