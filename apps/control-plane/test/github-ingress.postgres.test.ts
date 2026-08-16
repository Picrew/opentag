import { createHash, createHmac } from "node:crypto";
import {
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  RunnerReadinessReceiptEnvelopeV1Schema,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGithubIngress } from "../src/modules/github-ingress/index.js";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

function signature(secret: string, body: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe.skipIf(!TEST_DATABASE_URL)("signed GitHub ingress", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let ingress: ReturnType<typeof createGithubIngress>;
  const now = new Date("2026-08-15T13:00:00.000Z");
  const owner = {
    operatorId: "operator_ingress",
    organizationId: "org_ingress",
    role: "owner" as const,
    email: "owner@example.test",
    displayName: "Owner",
  };

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    await fixture.pool.query(
      `INSERT INTO cp_organization(organization_id, display_name)
       VALUES('org_ingress', 'Ingress')`,
    );
    await fixture.pool.query(
      `INSERT INTO cp_operator(operator_id, email, display_name, created_at)
       VALUES('operator_ingress', 'owner@example.test', 'Owner', $1)`,
      [now],
    );
    await fixture.pool.query(
      `INSERT INTO cp_membership(organization_id, operator_id, role, created_at)
       VALUES('org_ingress', 'operator_ingress', 'owner', $1)`,
      [now],
    );
    await fixture.pool.query(
      `INSERT INTO cp_runner(
         organization_id, runner_id, display_name, registration_generation,
         credential_generation, current_credential_id, capabilities,
         created_at, updated_at
       ) VALUES(
         'org_ingress', 'runner_ingress', 'Ingress runner', 1, 1,
         'credential_ingress', $1, $2, $2
       )`,
      [JSON.stringify([
        "relay.claim-fence.v1",
        "relay.hosted-admission.v1",
        "relay.hosted-claim.v1",
        "relay.lifecycle.v1",
        "relay.readiness.v1",
      ]), now],
    );
    await fixture.pool.query(
      `INSERT INTO cp_project_target(
         organization_id, project_target_id, runner_id, binding_digest,
         provider, owner, repo, default_executor, default_branch,
         version, updated_at
       ) VALUES(
         'org_ingress', 'target_ingress', 'runner_ingress', $1,
         'github', 'acme', 'demo', 'executor_acp', 'main', 1, $2
       )`,
      [`sha256:${"a".repeat(64)}`, now],
    );
    const readinessPayload = {
      readinessId: "readiness_ingress",
      runnerId: "runner_ingress",
      registrationGeneration: 1,
      capabilities: [
        "relay.claim-fence.v1",
        "relay.hosted-admission.v1",
        "relay.hosted-claim.v1",
        "relay.lifecycle.v1",
        "relay.readiness.v1",
      ],
      executors: [{
        executorId: "executor_acp",
        adapterVersion: "1.0.0",
        capabilityDigest: `sha256:${"c".repeat(64)}`,
        state: "ready" as const,
      }],
      targets: [{
        projectTargetId: "target_ingress",
        bindingDigest: `sha256:${"a".repeat(64)}`,
        state: "ready" as const,
      }],
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    };
    const readinessSeed = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      receiptId: "readiness_ingress",
      organizationId: "org_ingress",
      operationId: "operation_readiness_ingress",
      requiredCapabilities: ["relay.readiness.v1"] as const,
      producer: {
        kind: "runner" as const,
        id: "runner_ingress",
        credentialId: "credential_ingress",
        registrationGeneration: 1,
      },
      identity: {
        namespace: "opentag.control.receipt/runner-readiness/v1" as const,
        parts: ["org_ingress", "runner_ingress", "1", "readiness_ingress"],
      },
      observedAt: now.toISOString(),
      payloadDigest: await computeControlPayloadDigestV1(readinessPayload),
      receiptDigest: `sha256:${"0".repeat(64)}`,
      receiptKind: "runner_readiness" as const,
      payload: readinessPayload,
    };
    const { receiptDigest: _receiptDigest, ...readinessDigestInput } = readinessSeed;
    const readiness = RunnerReadinessReceiptEnvelopeV1Schema.parse({
      ...readinessSeed,
      receiptDigest: await computeControlReceiptDigestV1(readinessDigestInput),
    });
    await fixture.pool.query(
      `INSERT INTO cp_runner_readiness(
         organization_id, runner_id, receipt_id, receipt_digest,
         observed_at, expires_at, receipt
       ) VALUES(
         'org_ingress', 'runner_ingress', 'readiness_ingress', $1,
         $2, $3, $4
       )`,
      [
        readiness.receiptDigest,
        now,
        new Date(now.getTime() + 10 * 60_000),
        readiness,
      ],
    );
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => "unused_attempt",
      tokenFactory: () => "unused_fence",
    });
    ingress = createGithubIngress({
      pool: fixture.pool,
      hosted,
      clock: { now: () => now },
      masterSecret: "github-ingress-master-secret-with-32-bytes",
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("creates one binding secret and admits one authorized issue comment", async () => {
    const binding = await ingress.createBinding(owner, {
      bindingId: "binding_ingress",
      providerRepositoryId: "123",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_ingress",
      projectTargetId: "target_ingress",
      allowedActorIds: ["1001"],
      enabled: true,
    });
    expect(binding.kind).toBe("created");
    if (binding.kind !== "created") throw new Error("binding missing");
    expect(binding.secret).toBeTruthy();
    const bindingAudit = await fixture.pool.query<{
      operation_kind: string;
      event: unknown;
    }>(
      `SELECT operation_kind, event FROM cp_management_audit_event
       WHERE organization_id = 'org_ingress'
         AND resource_id = 'binding_ingress'`,
    );
    expect(bindingAudit.rows.map(({ operation_kind }) => operation_kind)).toEqual([
      "github_binding.create",
    ]);
    expect(JSON.stringify(bindingAudit.rows)).not.toContain(binding.secret);

    const body = new TextEncoder().encode(JSON.stringify({
      action: "created",
      repository: {
        id: 123,
        name: "demo",
        owner: { login: "acme" },
      },
      sender: { id: 1001, login: "octocat" },
      issue: { id: 456, number: 7 },
      comment: { id: 701, body: "@opentag fix the flaky test" },
    }));
    const delivery = {
      bindingId: "binding_ingress",
      deliveryId: "delivery_1",
      eventName: "issue_comment",
      signature: signature(binding.secret, body),
      body,
    };
    const accepted = await ingress.receive(delivery);
    expect(accepted).toMatchObject({ kind: "accepted", runId: expect.any(String) });
    await expect(ingress.receive(delivery)).resolves.toMatchObject({
      kind: "replayed",
      runId: accepted.kind === "accepted" ? accepted.runId : undefined,
    });
    const counts = await fixture.pool.query<{
      deliveries: number;
      runs: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM cp_github_delivery) AS deliveries,
        (SELECT count(*)::int FROM cp_hosted_run) AS runs`,
    );
    expect(counts.rows[0]).toEqual({ deliveries: 1, runs: 1 });
  });

  it("allows separate tenants to bind the same provider repository id", async () => {
    await fixture.pool.query(
      `INSERT INTO cp_organization(organization_id, display_name)
       VALUES('org_ingress_other', 'Other ingress')`,
    );
    await fixture.pool.query(
      `INSERT INTO cp_operator(operator_id, email, display_name, created_at)
       VALUES('operator_ingress_other', 'other-owner@example.test', 'Other owner', $1)`,
      [now],
    );
    await fixture.pool.query(
      `INSERT INTO cp_membership(organization_id, operator_id, role, created_at)
       VALUES('org_ingress_other', 'operator_ingress_other', 'owner', $1)`,
      [now],
    );
    await fixture.pool.query(
      `INSERT INTO cp_runner(
         organization_id, runner_id, registration_generation,
         credential_generation, current_credential_id, capabilities,
         created_at, updated_at
       ) VALUES(
         'org_ingress_other', 'runner_ingress_other', 1, 1,
         'credential_ingress_other', '[]'::jsonb, $1, $1
       )`,
      [now],
    );
    await fixture.pool.query(
      `INSERT INTO cp_project_target(
         organization_id, project_target_id, runner_id, binding_digest,
         provider, owner, repo, default_executor, version, updated_at
       ) VALUES(
         'org_ingress_other', 'target_ingress_other', 'runner_ingress_other',
         'digest-other', 'github', 'acme', 'demo', 'executor_acp', 1, $1
       )`,
      [now],
    );
    const outcome = await ingress.createBinding({
      operatorId: "operator_ingress_other",
      organizationId: "org_ingress_other",
      role: "owner",
      email: "other-owner@example.test",
      displayName: "Other owner",
    }, {
      bindingId: "binding_ingress_other",
      providerRepositoryId: "123",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_ingress_other",
      projectTargetId: "target_ingress_other",
      allowedActorIds: ["1001"],
      enabled: false,
    });

    expect(outcome.kind).toBe("created");
  });

  it("fails closed for a bad signature or non-allowlisted stable actor id", async () => {
    const badSignatureBody = new TextEncoder().encode("{}");
    await expect(ingress.receive({
      bindingId: "binding_ingress",
      deliveryId: "delivery_bad_signature",
      eventName: "issue_comment",
      signature: `sha256=${"0".repeat(64)}`,
      body: badSignatureBody,
    })).resolves.toEqual({ kind: "invalid_binding_or_signature" });

    const body = new TextEncoder().encode(JSON.stringify({
      action: "created",
      repository: { id: 123, name: "demo", owner: { login: "acme" } },
      sender: { id: 9999, login: "octocat" },
      issue: { id: 457, number: 8 },
      comment: { id: 702, body: "@opentag unauthorized" },
    }));
    const secret = ingress.deriveBindingSecret("org_ingress", "binding_ingress", "v1");
    await expect(ingress.receive({
      bindingId: "binding_ingress",
      deliveryId: "delivery_bad_actor",
      eventName: "issue_comment",
      signature: signature(secret, body),
      body,
    })).resolves.toEqual({ kind: "rejected_authority" });
  });

  it("reserves a delivery before effects and rejects a concurrent payload conflict", async () => {
    const before = await fixture.pool.query<{ runs: number }>(
      "SELECT count(*)::int AS runs FROM cp_hosted_run",
    );
    const secret = ingress.deriveBindingSecret(
      "org_ingress",
      "binding_ingress",
      "v1",
    );
    const body = (commentId: number) => new TextEncoder().encode(JSON.stringify({
      action: "created",
      repository: { id: 123, name: "demo", owner: { login: "acme" } },
      sender: { id: 1001, login: "octocat" },
      issue: { id: 900 + commentId, number: 90 + commentId },
      comment: { id: commentId, body: `@opentag delivery race ${commentId}` },
    }));
    const firstBody = body(801);
    const conflictingBody = body(802);

    const outcomes = await Promise.all([
      ingress.receive({
        bindingId: "binding_ingress",
        deliveryId: "delivery_concurrent_conflict",
        eventName: "issue_comment",
        signature: signature(secret, firstBody),
        body: firstBody,
      }),
      ingress.receive({
        bindingId: "binding_ingress",
        deliveryId: "delivery_concurrent_conflict",
        eventName: "issue_comment",
        signature: signature(secret, conflictingBody),
        body: conflictingBody,
      }),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "accepted",
      "delivery_conflict",
    ]);
    const after = await fixture.pool.query<{
      deliveries: number;
      runs: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM cp_github_delivery
         WHERE delivery_id = 'delivery_concurrent_conflict') AS deliveries,
        (SELECT count(*)::int FROM cp_hosted_run) AS runs`,
    );
    expect(after.rows[0]).toEqual({
      deliveries: 1,
      runs: (before.rows[0]?.runs ?? 0) + 1,
    });
  });

  it("recovers an abandoned processing reservation after its lease expires", async () => {
    const secret = ingress.deriveBindingSecret(
      "org_ingress",
      "binding_ingress",
      "v1",
    );
    const body = new TextEncoder().encode(JSON.stringify({
      action: "created",
      repository: { id: 123, name: "demo", owner: { login: "acme" } },
      sender: { id: 1001, login: "octocat" },
      issue: { id: 999, number: 99 },
      comment: { id: 899, body: "@opentag recover abandoned delivery" },
    }));
    const payloadDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    await fixture.pool.query(
      `INSERT INTO cp_github_delivery(
         organization_id, binding_id, delivery_id, payload_digest, event_name,
         normalized_outcome, processing_token, processing_expires_at, received_at
       ) VALUES(
         'org_ingress', 'binding_ingress', 'delivery_abandoned', $1,
         'issue_comment', '{"kind":"processing"}', 'abandoned_token', $2, $3
       )`,
      [
        payloadDigest,
        new Date(now.getTime() - 1),
        new Date(now.getTime() - 60_001),
      ],
    );

    await expect(ingress.receive({
      bindingId: "binding_ingress",
      deliveryId: "delivery_abandoned",
      eventName: "issue_comment",
      signature: signature(secret, body),
      body,
    })).resolves.toMatchObject({ kind: "accepted", runId: expect.any(String) });

    const stored = await fixture.pool.query<{
      normalized_outcome: unknown;
      processing_token: string | null;
      processing_expires_at: Date | null;
    }>(
      `SELECT normalized_outcome, processing_token, processing_expires_at
       FROM cp_github_delivery
       WHERE organization_id = 'org_ingress'
         AND binding_id = 'binding_ingress'
         AND delivery_id = 'delivery_abandoned'`,
    );
    expect(stored.rows[0]).toMatchObject({
      normalized_outcome: { kind: "accepted" },
      processing_token: null,
      processing_expires_at: null,
    });
  });

  it("records pull-request evidence without creating a run", async () => {
    const before = await fixture.pool.query<{ runs: number }>(
      "SELECT count(*)::int AS runs FROM cp_hosted_run",
    );
    const body = new TextEncoder().encode(JSON.stringify({
      action: "opened",
      repository: { id: 123, name: "demo", owner: { login: "acme" } },
      sender: { id: 1001, login: "octocat" },
      pull_request: { id: 800, number: 9, html_url: "https://github.com/acme/demo/pull/9" },
    }));
    const secret = ingress.deriveBindingSecret("org_ingress", "binding_ingress", "v1");
    await expect(ingress.receive({
      bindingId: "binding_ingress",
      deliveryId: "delivery_pr_opened",
      eventName: "pull_request",
      signature: signature(secret, body),
      body,
    })).resolves.toEqual({ kind: "evidence_recorded" });
    const result = await fixture.pool.query<{ runs: number; evidence: number }>(
      `SELECT
        (SELECT count(*)::int FROM cp_hosted_run) AS runs,
        (SELECT count(*)::int FROM cp_provider_evidence) AS evidence`,
    );
    expect(result.rows[0]).toEqual({
      runs: before.rows[0]?.runs ?? 0,
      evidence: 1,
    });
  });
});
