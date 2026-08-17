import {
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  MaterialActionReceiptEnvelopeV1Schema,
} from "@opentag/control-protocol";
import { createOpenTagClient } from "@opentag/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createMaterialActionCoordinator } from "../src/modules/hosted-runs/material-actions.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import {
  hostedAdmissionFixture,
  hostedClaimRequest,
  recordHostedReadiness,
} from "./control-fixtures.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("material action Control V1 transport", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const now = new Date("2026-08-15T15:30:00.000Z");

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("uses the existing client to record and reconcile provider evidence", async () => {
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: () => "credential_material_http",
      tokenFactory: () => "runtime_material_http",
    });
    const registration = await runners.register({
      organizationId: "org_material_http",
      organizationName: "Material HTTP",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_material_http",
        operationId: "operation_register_material_http",
        runnerId: "runner_material_http",
        capabilities: [
          "relay.claim-fence.v1",
          "relay.hosted-admission.v1",
          "relay.hosted-claim.v1",
          "relay.lifecycle.v1",
          "relay.material-receipt.v1",
          "relay.readiness.v1",
        ],
      },
    });
    if (registration.kind !== "created") throw new Error("registration failed");
    const authentication = await runners.authenticate("runtime_material_http");
    if (authentication.kind !== "authenticated") throw new Error("auth failed");
    await recordHostedReadiness({
      pool: fixture.pool,
      organizationId: authentication.principal.organizationId,
      runnerId: authentication.principal.runnerId,
    });
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => "attempt_material_http",
      tokenFactory: () => "fence_material_http",
    });
    const admission = await hostedAdmissionFixture({
      runId: "run_material_http",
      suffix: "95",
      organizationId: "org_material_http",
      runnerId: "runner_material_http",
    });
    await hosted.admit({
      runId: "run_material_http",
      admission: admission.admission,
      policy: admission.policy,
    });
    const claimOutcome = await hosted.claim({
      principal: authentication.principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_material_http",
        requestId: "request_claim_material_http",
        credentialId: "credential_material_http",
      }),
    });
    if (claimOutcome.kind !== "claimed") throw new Error("claim failed");
    const claim = claimOutcome.claim;
    const materials = createMaterialActionCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
    });
    const application = createControlPlaneApplication({
      capabilities: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1",
        capabilities: ["relay.material-receipt.v1"],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "local", releaseSha: "local" },
      },
      readiness: { check: async () => ({ ready: true }) },
      control: {
        bootstrap: { authenticate: () => null },
        runners,
        hosted,
        materials,
      },
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await application.fetch(new Request(String(url), init));
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    const payload = {
      actionId: "action_material_http",
      actionFamily: "github.merge",
      provider: "github",
      connectionRef: "connection_material_http",
      targetFingerprint: `sha256:${"7".repeat(64)}`,
      operationId: "operation_material_http",
      requestDigest: `sha256:${"8".repeat(64)}`,
      actionPayloadDigest: `sha256:${"9".repeat(64)}`,
      outcome: "succeeded" as const,
      externalId: "pr_84",
      externalUri: "https://github.com/example/repo/pull/84",
      observedAt: now.toISOString(),
      reasonCode: "provider_accepted" as const,
    };
    const seed = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      receiptId: "receipt_material_http",
      organizationId: "org_material_http",
      operationId: payload.operationId,
      requiredCapabilities: ["relay.material-receipt.v1"] as const,
      producer: {
        kind: "local_opentag" as const,
        id: "runner_material_http",
      },
      identity: {
        namespace: "opentag.control.receipt/material-action/v1" as const,
        parts: [
          "org_material_http",
          "run_material_http",
          claim.attempt.id,
          payload.actionId,
          "receipt_material_http",
        ],
      },
      observedAt: now.toISOString(),
      payloadDigest: await computeMaterialActionPayloadDigestV1(payload),
      receiptDigest: `sha256:${"0".repeat(64)}`,
      receiptKind: "material_action" as const,
      runId: "run_material_http",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      payload,
    };
    const { receiptDigest: _ignored, ...digestInput } = seed;
    const receipt = MaterialActionReceiptEnvelopeV1Schema.parse({
      ...seed,
      receiptDigest: await computeMaterialActionReceiptDigestV1(digestInput),
    });
    const client = createOpenTagClient({
      dispatcherUrl: "http://control.test",
      controlCredential: {
        kind: "runtime",
        token: "runtime_material_http",
      },
      fetchImpl,
    });
    await expect(client.recordMaterialActionReceiptControlV1({
      runnerId: "runner_material_http",
      fencingToken: claim.attempt.fencingToken,
      receipt,
    })).resolves.toMatchObject({ status: 201, replayed: false });
    await expect(client.reconcileMaterialActionControlV1({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.material-receipt.v1"],
      requestId: "request_reconcile_material_http",
      organizationId: "org_material_http",
      runnerId: "runner_material_http",
      runId: "run_material_http",
      actionId: payload.actionId,
      attempt: {
        ...receipt.attempt,
        fencingToken: claim.attempt.fencingToken,
      },
      expectedCurrentReceiptId: receipt.receiptId,
      expectedCurrentReceiptDigest: receipt.receiptDigest,
    })).resolves.toMatchObject({ status: 200, outcome: "resolved" });
  });
});
