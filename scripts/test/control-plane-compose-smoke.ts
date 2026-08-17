import { createHmac } from "node:crypto";
import {
  HumanPermissionDecisionRequestV1Schema,
  HostedCancelRequestV1Schema,
  MaterialActionReceiptEnvelopeV1Schema,
  RunnerPermissionRequestV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  buildHostedLifecycleRequestV1,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  computePermissionRequestDigestV1,
} from "../../packages/control-protocol/src/index.js";
import { createOpenTagClient } from "../../packages/client/src/index.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
};

const baseUrl = process.env.OPENTAG_SMOKE_URL
  ?? `http://127.0.0.1:${process.env.OPENTAG_PORT ?? "3000"}`;
const organizationId = required("OPENTAG_BOOTSTRAP_ORGANIZATION_ID");
const stamp = `${Date.now()}`;
const runnerId = `runner_smoke_${stamp}`;
const projectTargetId = `target_smoke_${stamp}`;
const bindingId = `binding_smoke_${stamp}`;
const repositoryId = stamp;
const actorId = "1001";
const capabilities = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.material-receipt.v1",
  "relay.permission.v1",
  "relay.readiness.v1",
] as const;
const hostedCapabilities = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function json<T>(response: Response, expectedStatus: number): Promise<T> {
  if (response.status !== expectedStatus) {
    throw new Error(`unexpected_http_${response.status}:${await response.text()}`);
  }
  return await response.json() as T;
}

async function main(): Promise<void> {
  const discovery = await json<{
    capabilities: string[];
  }>(await fetch(`${baseUrl}/v1/relay/capabilities`), 200);
  for (const capability of [
    "relay.credential-reprovision.v1",
    "relay.material-receipt.v1",
    "relay.permission.v1",
  ]) {
    assert(discovery.capabilities.includes(capability), `missing_${capability}`);
  }

  const bootstrapClient = createOpenTagClient({
    dispatcherUrl: baseUrl,
    controlCredential: {
      kind: "bootstrap_pairing",
      token: required("OPENTAG_BOOTSTRAP_PAIRING_TOKEN"),
    },
  });
  const registered = await bootstrapClient.registerRunnerControlV1({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.registration.v1"],
    requestId: `request_register_${stamp}`,
    operationId: `operation_register_${stamp}`,
    runnerId,
    capabilities: [...capabilities],
  });
  assert(!registered.replayed, "runner_registration_replayed");

  const runtimeClient = createOpenTagClient({
    dispatcherUrl: baseUrl,
    controlCredential: { kind: "runtime", token: registered.runnerToken },
  });
  const context = await runtimeClient.getRunnerControlContextV1({ runnerId });
  assert(context.organizationId === organizationId, "wrong_runner_organization");

  const login = await fetch(`${baseUrl}/api/console/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({
      email: required("OPENTAG_BOOTSTRAP_ADMIN_EMAIL"),
      password: required("OPENTAG_BOOTSTRAP_ADMIN_PASSWORD"),
    }),
  });
  assert(login.status === 200, `console_login_${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "console_cookie_missing");
  const consoleHeaders = {
    "content-type": "application/json",
    cookie,
    origin: baseUrl,
  };

  const targetBindingDigest = `sha256:${"a".repeat(64)}`;
  await json(await fetch(`${baseUrl}/api/console/project-targets`, {
    method: "POST",
    headers: consoleHeaders,
    body: JSON.stringify({
      projectTargetId,
      runnerId,
      bindingDigest: targetBindingDigest,
      provider: "github",
      owner: "smoke",
      repo: "control-plane",
      defaultExecutor: "executor_acp",
      defaultBranch: "main",
      version: 1,
    }),
  }), 201);

  const now = new Date();
  const readinessId = `readiness_smoke_${stamp}`;
  const executorCapabilityDigest = `sha256:${"c".repeat(64)}`;
  const readinessPayload = {
    readinessId,
    runnerId,
    registrationGeneration: registered.registrationGeneration,
    capabilities: [...capabilities],
    executors: [{
      executorId: "executor_acp",
      adapterVersion: "1.0.0",
      capabilityDigest: executorCapabilityDigest,
      state: "ready" as const,
    }],
    targets: [{
      projectTargetId,
      bindingDigest: targetBindingDigest,
      state: "ready" as const,
    }],
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
  const readinessSeed = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptId: readinessId,
    organizationId,
    operationId: `operation_readiness_${stamp}`,
    requiredCapabilities: ["relay.readiness.v1"] as const,
    producer: {
      kind: "runner" as const,
      id: runnerId,
      credentialId: registered.credentialId,
      registrationGeneration: registered.registrationGeneration,
    },
    identity: {
      namespace: "opentag.control.receipt/runner-readiness/v1" as const,
      parts: [organizationId, runnerId, `${registered.registrationGeneration}`, readinessId],
    },
    observedAt: now.toISOString(),
    payloadDigest: await computeControlPayloadDigestV1(readinessPayload),
    receiptDigest: `sha256:${"0".repeat(64)}`,
    receiptKind: "runner_readiness" as const,
    payload: readinessPayload,
  };
  const { receiptDigest: _readinessDigest, ...readinessDigestInput } = readinessSeed;
  const readiness = RunnerReadinessReceiptEnvelopeV1Schema.parse({
    ...readinessSeed,
    receiptDigest: await computeControlReceiptDigestV1(readinessDigestInput),
  });
  await runtimeClient.reportRunnerReadinessControlV1(readiness);

  const binding = await json<{
    kind: "created";
    secret: string;
  }>(await fetch(`${baseUrl}/api/console/github-bindings`, {
    method: "POST",
    headers: consoleHeaders,
    body: JSON.stringify({
      bindingId,
      providerRepositoryId: repositoryId,
      owner: "smoke",
      repo: "control-plane",
      runnerId,
      projectTargetId,
      allowedActorIds: [actorId],
      enabled: true,
    }),
  }), 201);

  const providerBody = JSON.stringify({
    action: "created",
    repository: {
      id: Number(repositoryId),
      name: "control-plane",
      owner: { login: "smoke" },
    },
    sender: { id: Number(actorId), login: "smoke-operator" },
    issue: { id: Number(repositoryId) + 1, number: 1 },
    comment: {
      id: Number(repositoryId) + 2,
      body: "@opentag verify the clean control plane",
    },
  });
  const deliveryId = `delivery_smoke_${stamp}`;
  const signature = `sha256=${createHmac("sha256", binding.secret)
    .update(providerBody)
    .digest("hex")}`;
  const deliver = () => fetch(
    `${baseUrl}/v1/providers/github/webhooks/${bindingId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
      body: providerBody,
    },
  );
  const admitted = await json<{ kind: "accepted"; runId: string }>(await deliver(), 202);
  const replayed = await json<{ kind: "replayed"; runId: string }>(await deliver(), 200);
  assert(replayed.runId === admitted.runId, "github_replay_changed_run");

  const claim = await runtimeClient.claimHostedRunControlV1({
    runnerId,
    request: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: [...hostedCapabilities],
      requestId: `request_claim_${stamp}`,
      operationId: `operation_claim_${stamp}`,
      expectedAuthority: {
        credentialId: registered.credentialId,
        registrationGeneration: registered.registrationGeneration,
        credentialGeneration: registered.credentialGeneration,
        runnerReadinessReceiptId: readiness.receiptId,
        runnerReadinessReceiptDigest: readiness.receiptDigest,
      },
    },
  });
  assert(claim?.runId === admitted.runId, "hosted_claim_missing");

  const permissionDigestInput = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.permission.v1"] as ["relay.permission.v1"],
    organizationId,
    runnerId,
    runId: admitted.runId,
    attempt: {
      attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.number,
      epoch: claim.attempt.epoch,
      fencingTokenDigest: claim.attempt.fencingTokenDigest,
    },
    permissionRequestId: `permission_smoke_${stamp}`,
    actionId: `action_smoke_${stamp}`,
    actionFamily: "github.merge",
    riskTier: "high" as const,
    targetFingerprint: `sha256:${"d".repeat(64)}`,
    permissionScopes: ["github:merge"],
    policySnapshotRef: claim.admissionPolicySnapshot.payload.snapshotId,
    policySnapshotDigest: claim.admissionPolicySnapshot.receiptDigest,
    requestedAt: new Date().toISOString(),
  };
  const permission = RunnerPermissionRequestV1Schema.parse({
    ...permissionDigestInput,
    requestId: `request_permission_${stamp}`,
    operationId: `operation_permission_${stamp}`,
    attempt: {
      ...permissionDigestInput.attempt,
      fencingToken: claim.attempt.fencingToken,
    },
    permissionRequestDigest: await computePermissionRequestDigestV1(
      permissionDigestInput,
    ),
  });
  const waiting = await runtimeClient.requestActionPermissionControlV1(permission);
  assert(waiting.status === 202 && waiting.outcome === "waiting", "permission_not_waiting");

  const apiKey = await json<{ token: string }>(await fetch(
    `${baseUrl}/api/console/api-keys`,
    {
      method: "POST",
      headers: consoleHeaders,
      body: JSON.stringify({
        label: `compose-smoke-${stamp}`,
        scopes: ["permission:resolve", "run:read", "runner:read"],
      }),
    },
  ), 201);
  const decision = HumanPermissionDecisionRequestV1Schema.parse({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.permission.v1"],
    requestId: `request_decision_${stamp}`,
    operationId: `operation_decision_${stamp}`,
    organizationId,
    runId: admitted.runId,
    attempt: permissionDigestInput.attempt,
    actionId: permission.actionId,
    permissionRequestId: permission.permissionRequestId,
    permissionRequestDigest: permission.permissionRequestDigest,
    policySnapshotDigest: permission.policySnapshotDigest,
    decisionId: `decision_smoke_${stamp}`,
    decision: "allow_once",
    decidedAt: new Date().toISOString(),
  });
  const approver = createOpenTagClient({
    dispatcherUrl: baseUrl,
    controlCredential: { kind: "approver", token: apiKey.token },
  });
  const resolved = await approver.resolveActionPermissionControlV1({
    runnerId,
    decision,
  });
  assert(resolved.outcome === "resolved", "permission_not_resolved");

  const materialPayload = {
    actionId: permission.actionId,
    actionFamily: "github.merge",
    provider: "github",
    connectionRef: `connection_smoke_${stamp}`,
    targetFingerprint: permission.targetFingerprint,
    operationId: `operation_material_${stamp}`,
    requestDigest: `sha256:${"e".repeat(64)}`,
    actionPayloadDigest: `sha256:${"f".repeat(64)}`,
    outcome: "succeeded" as const,
    externalId: `pr_${stamp}`,
    externalUri: `https://github.com/smoke/control-plane/pull/${stamp}`,
    observedAt: new Date().toISOString(),
    reasonCode: "provider_accepted" as const,
  };
  const materialSeed = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptId: `receipt_material_${stamp}`,
    organizationId,
    operationId: materialPayload.operationId,
    requiredCapabilities: ["relay.material-receipt.v1"] as [
      "relay.material-receipt.v1",
    ],
    producer: { kind: "local_opentag" as const, id: runnerId },
    identity: {
      namespace: "opentag.control.receipt/material-action/v1" as const,
      parts: [
        organizationId,
        admitted.runId,
        claim.attempt.id,
        materialPayload.actionId,
        `receipt_material_${stamp}`,
      ],
    },
    observedAt: new Date().toISOString(),
    payloadDigest: await computeMaterialActionPayloadDigestV1(materialPayload),
    receiptDigest: `sha256:${"0".repeat(64)}`,
    receiptKind: "material_action" as const,
    runId: admitted.runId,
    attempt: {
      attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.number,
      epoch: claim.attempt.epoch,
      fencingTokenDigest: claim.attempt.fencingTokenDigest,
    },
    payload: materialPayload,
  };
  const { receiptDigest: _materialDigest, ...materialDigestInput } = materialSeed;
  const material = MaterialActionReceiptEnvelopeV1Schema.parse({
    ...materialSeed,
    receiptDigest: await computeMaterialActionReceiptDigestV1(materialDigestInput),
  });
  const recorded = await runtimeClient.recordMaterialActionReceiptControlV1({
    runnerId,
    fencingToken: claim.attempt.fencingToken,
    receipt: material,
  });
  assert(recorded.status === 201, "material_receipt_not_recorded");
  const reconciled = await runtimeClient.reconcileMaterialActionControlV1({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.material-receipt.v1"],
    requestId: `request_reconcile_${stamp}`,
    organizationId,
    runnerId,
    runId: admitted.runId,
    actionId: materialPayload.actionId,
    attempt: {
      ...material.attempt,
      fencingToken: claim.attempt.fencingToken,
    },
    expectedCurrentReceiptId: material.receiptId,
    expectedCurrentReceiptDigest: material.receiptDigest,
  });
  assert(reconciled.status === 200 && reconciled.outcome === "resolved", "material_not_resolved");

  const cancellation = HostedCancelRequestV1Schema.parse(
    await buildHostedLifecycleRequestV1({
      organizationId,
      runnerId,
      runId: admitted.runId,
      action: "cancel",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: new Date().toISOString(),
      reasonCode: "operator_cancelled",
    }),
  );
  const cancelled = await runtimeClient.cancelHostedRunControlV1({
    organizationId,
    credentialId: registered.credentialId,
    runnerId,
    runId: admitted.runId,
    request: cancellation,
  });
  assert(cancelled.receipt.payload.operation === "cancel", "run_not_cancelled");

  const recoveryClient = createOpenTagClient({
    dispatcherUrl: baseUrl,
    controlCredential: {
      kind: "recovery_pairing",
      token: required("OPENTAG_RECOVERY_PAIRING_TOKEN"),
    },
  });
  const reprovisioned = await recoveryClient.reprovisionRunnerControlV1({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.credential-reprovision.v1"],
    requestId: `request_reprovision_${stamp}`,
    operationId: `operation_reprovision_${stamp}`,
    runnerId,
    recoveryCredentialId: registered.credentialId,
    expectedRegistrationGeneration: registered.registrationGeneration,
    expectedCredentialGeneration: registered.credentialGeneration,
  });
  assert(!reprovisioned.replayed, "credential_reprovision_replayed");
  let oldCredentialStatus = 0;
  try {
    await runtimeClient.getRunnerControlContextV1({ runnerId });
  } catch (error) {
    oldCredentialStatus = (error as { status?: number }).status ?? 0;
  }
  assert(oldCredentialStatus === 401, "old_runtime_credential_still_valid");
  const recoveredClient = createOpenTagClient({
    dispatcherUrl: baseUrl,
    controlCredential: {
      kind: "runtime",
      token: reprovisioned.runnerToken,
    },
  });
  const recoveredContext = await recoveredClient.getRunnerControlContextV1({
    runnerId,
  });
  assert(recoveredContext.credentialGeneration === 2, "credential_generation_not_advanced");

  const evidence = await json<{
    materialActions: unknown[];
    permissions: unknown[];
  }>(await fetch(`${baseUrl}/api/console/evidence`, {
    headers: { cookie },
  }), 200);
  assert(evidence.materialActions.length > 0, "material_evidence_not_visible");
  assert(evidence.permissions.length > 0, "permission_evidence_not_visible");

  console.log(JSON.stringify({
    status: "ok",
    runnerId,
    runId: admitted.runId,
    registrationGeneration: recoveredContext.registrationGeneration,
    credentialGeneration: recoveredContext.credentialGeneration,
    permission: resolved.receipt.payload.state,
    material: reconciled.outcome,
    terminal: cancelled.receipt.payload.operation,
  }));
}

await main();
