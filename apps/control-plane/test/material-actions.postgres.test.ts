import {
  computeMaterialActionFencingTokenDigestV1,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  MaterialActionReceiptEnvelopeV1Schema,
  RunnerMaterialActionReconcileRequestV1Schema,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createMaterialActionCoordinator } from "../src/modules/hosted-runs/material-actions.js";
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

describe.skipIf(!TEST_DATABASE_URL)("material action PostgreSQL module", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let principal: RuntimePrincipal;
  const now = new Date("2026-08-15T15:00:00.000Z");

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: () => "credential_material",
      tokenFactory: () => "runtime_material_secret",
    });
    const registration = await runners.register({
      organizationId: "org_material",
      organizationName: "Material actions",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_material",
        operationId: "operation_register_material",
        runnerId: "runner_material",
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
    const authenticated = await runners.authenticate("runtime_material_secret");
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

  it("keeps an append-only receipt chain and reconciles the current evidence", async () => {
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => "attempt_material",
      tokenFactory: () => "fence_material",
    });
    const admission = await hostedAdmissionFixture({
      runId: "run_material",
      suffix: "94",
      organizationId: "org_material",
      runnerId: "runner_material",
    });
    await hosted.admit({
      runId: "run_material",
      admission: admission.admission,
      policy: admission.policy,
    });
    const claimOutcome = await hosted.claim({
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_material",
        requestId: "request_claim_material",
        credentialId: "credential_material",
      }),
    });
    if (claimOutcome.kind !== "claimed") throw new Error("claim failed");
    const claim = claimOutcome.claim;
    const coordinator = createMaterialActionCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
    });
    const receiptFor = async (input: {
      receiptId: string;
      operationId: string;
      outcome: "succeeded" | "outcome_unknown";
      predecessorReceiptDigests?: string[];
    }) => {
      const payload = {
        actionId: "action_material",
        actionFamily: "github.merge",
        provider: "github",
        connectionRef: "connection_material",
        targetFingerprint: `sha256:${"4".repeat(64)}`,
        operationId: input.operationId,
        requestDigest: `sha256:${"5".repeat(64)}`,
        actionPayloadDigest: `sha256:${"6".repeat(64)}`,
        outcome: input.outcome,
        ...(input.outcome === "succeeded"
          ? {
              externalId: "pr_42",
              externalUri: "https://github.com/example/repo/pull/42",
              reasonCode: "provider_accepted" as const,
            }
          : {
              reasonCode: "provider_timeout" as const,
              nextAction: "reconcile_provider",
              owner: "runner_material",
            }),
        observedAt: now.toISOString(),
      };
      const seed = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        receiptId: input.receiptId,
        organizationId: "org_material",
        operationId: input.operationId,
        requiredCapabilities: ["relay.material-receipt.v1"] as const,
        producer: { kind: "local_opentag" as const, id: "runner_material" },
        identity: {
          namespace: "opentag.control.receipt/material-action/v1" as const,
          parts: [
            "org_material",
            "run_material",
            claim.attempt.id,
            "action_material",
            input.receiptId,
          ],
        },
        ...(input.predecessorReceiptDigests
          ? { predecessorReceiptDigests: input.predecessorReceiptDigests }
          : {}),
        observedAt: now.toISOString(),
        payloadDigest: await computeMaterialActionPayloadDigestV1(payload),
        receiptDigest: `sha256:${"0".repeat(64)}`,
        receiptKind: "material_action" as const,
        runId: "run_material",
        attempt: {
          attemptId: claim.attempt.id,
          attemptNumber: claim.attempt.number,
          epoch: claim.attempt.epoch,
          fencingTokenDigest: claim.attempt.fencingTokenDigest,
        },
        payload,
      };
      const { receiptDigest: _ignored, ...digestInput } = seed;
      return MaterialActionReceiptEnvelopeV1Schema.parse({
        ...seed,
        receiptDigest: await computeMaterialActionReceiptDigestV1(digestInput),
      });
    };
    const unknown = await receiptFor({
      receiptId: "receipt_material_unknown",
      operationId: "operation_material_unknown",
      outcome: "outcome_unknown",
    });
    await expect(coordinator.record({
      principal,
      fencingToken: claim.attempt.fencingToken,
      receipt: unknown,
    })).resolves.toMatchObject({ kind: "recorded" });
    await expect(coordinator.record({
      principal,
      fencingToken: claim.attempt.fencingToken,
      receipt: unknown,
    })).resolves.toMatchObject({ kind: "replayed" });
    const reconcile = RunnerMaterialActionReconcileRequestV1Schema.parse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.material-receipt.v1"],
      requestId: "request_reconcile_material",
      organizationId: "org_material",
      runnerId: "runner_material",
      runId: "run_material",
      actionId: "action_material",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      expectedCurrentReceiptId: unknown.receiptId,
      expectedCurrentReceiptDigest: unknown.receiptDigest,
    });
    await expect(coordinator.reconcile({ principal, request: reconcile }))
      .resolves.toMatchObject({ kind: "outcome_unknown" });

    const terminal = await receiptFor({
      receiptId: "receipt_material_terminal",
      operationId: "operation_material_terminal",
      outcome: "succeeded",
      predecessorReceiptDigests: [unknown.receiptDigest],
    });
    await expect(coordinator.record({
      principal,
      fencingToken: claim.attempt.fencingToken,
      receipt: terminal,
    })).resolves.toMatchObject({ kind: "recorded" });
    await expect(coordinator.reconcile({
      principal,
      request: { ...reconcile, requestId: "request_reconcile_terminal",
        expectedCurrentReceiptId: terminal.receiptId,
        expectedCurrentReceiptDigest: terminal.receiptDigest },
    })).resolves.toMatchObject({
      kind: "resolved",
      receipt: { payload: { outcome: "succeeded" } },
    });
    const rows = await fixture.pool.query<{ receipt_id: string }>(
      `SELECT receipt_id FROM cp_material_action_receipt
       WHERE organization_id = $1 ORDER BY created_at, receipt_id`,
      ["org_material"],
    );
    expect(rows.rows.map((row) => row.receipt_id)).toEqual([
      "receipt_material_terminal",
      "receipt_material_unknown",
    ]);
  });
});
