import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_SCHEMA_VERSION,
  AdmissionPolicySnapshotPayloadV1Schema,
  CallbackAttemptObservationPayloadV1Schema,
  CallbackAttemptObservationReceiptEnvelopeV1Schema,
  CallbackIntentObservationReceiptEnvelopeV1Schema,
  CallbackIntentObservationPayloadV1Schema,
  CallbackProviderObservationReceiptEnvelopeV1Schema,
  CallbackProviderObservationPayloadV1Schema,
  CallbackNextActionV1Schema,
  CallbackOpaqueStableIdV1Schema,
  CallbackObservationReasonCodeV1Schema,
  CallbackProviderV1Schema,
  CompletionContractRefPayloadV1Schema,
  CompletionContractRefReceiptEnvelopeV1Schema,
  CompletionAssessmentPayloadV1Schema,
  CompletionAssessmentReceiptEnvelopeV1Schema,
  ControlMutationRequestV1Schema,
  ControlErrorHttpResponseV1Schema,
  ControlWaitingHttpResponseV1Schema,
  buildMaterialActionReceiptDigestInputV1,
  buildPermissionRequestDigestInputV1,
  computeMaterialActionFencingTokenDigestV1,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  computePermissionFencingTokenDigestV1,
  computePermissionRequestDigestV1,
  HumanPermissionDecisionHttpResponseV1Schema,
  HumanPermissionDecisionRequestV1Schema,
  MaterialActionPayloadV1Schema,
  MaterialActionReconcileHttpResponseV1Schema,
  MaterialActionReceiptDigestInputV1Schema,
  MaterialActionReceiptEnvelopeV1Schema,
  PermissionRequestDigestInputV1Schema,
  PermissionResolutionCurrentHttpResponseV1Schema,
  PermissionResolutionReceiptEnvelopeV1Schema,
  ReceiptDigestSchema,
  NpmPackageVersionSchema,
  RelayCapabilitiesResponseV1Schema,
  RunnerCredentialReprovisionRequestV1Schema,
  RunnerCredentialCurrentStateHttpResponseV1Schema,
  RunnerCredentialMetadataV1Schema,
  RunnerCredentialRevocationHttpResponseV1Schema,
  RunnerCredentialRevocationRequestV1Schema,
  RunnerCredentialRotationHttpResponseV1Schema,
  RunnerCredentialRotationRequestV1Schema,
  RunnerCredentialResponseV1Schema,
  RunnerCredentialHttpResponseV1Schema,
  RunnerReadinessReasonCodeV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  WorkThreadRefPayloadV1Schema,
  WorkThreadRefReceiptEnvelopeV1Schema,
  RunnerPermissionCurrentQueryV1Schema,
  RunnerPermissionRequestHttpResponseV1Schema,
  RunnerPermissionRequestV1Schema,
  RunnerMaterialActionReconcileRequestV1Schema,
  RunnerRegistrationRequestV1Schema,
  RunnerRegistrationResponseV1Schema,
  type CompletionAssessmentReceiptEnvelopeV1,
  type RunnerReadinessReceiptEnvelopeV1,
} from "../src/control-protocol.js";
import { canonicalJsonStringify } from "../src/canonical-json.js";

const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const observedAt = "2026-08-08T00:00:00.000Z";
const publicFenceDigest = `sha256:${createHash("sha256").update("fence_secret_canary", "utf8").digest("hex")}`;

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;
}

const GOVERNED_PROJECTION_VECTORS_PATH = new URL(
  "./fixtures/control-v1-governed-projection-vectors.json",
  import.meta.url,
);
const GOVERNED_PROJECTION_VECTORS_SHA256 = "daafcf4c6d4c886d5f0ac74b8ef43e93e8526e6d5bd6dc995e349a3ff7d41722";

function assessmentReceipt(): CompletionAssessmentReceiptEnvelopeV1 {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "completion_assessment",
    receiptId: "assessment_receipt_1",
    organizationId: "org_1",
    operationId: "op_assessment_1",
    requiredCapabilities: ["relay.completion-assessment.v1"],
    runId: "run_1",
    workThreadId: "wt_1",
    attempt: {
      attemptId: "attempt_1",
      attemptNumber: 1,
      epoch: 1,
      fencingTokenDigest: digest,
    },
    producer: {
      kind: "local_opentag",
      id: "runner_1",
      credentialId: "runtime_credential_1",
      registrationGeneration: 1,
    },
    identity: {
      namespace: "opentag.control.receipt/completion-assessment/v1",
      parts: ["org_1", "wt_1", "assessment_1"],
    },
    predecessorReceiptDigests: [digest],
    observedAt,
    payload: {
      assessmentId: "assessment_1",
      workThreadId: "wt_1",
      contract: {
        contractId: "contract_1",
        version: 1,
        cycle: 1,
        contentDigest: digest,
      },
      admissionPolicySnapshot: {
        snapshotId: "policy_1",
        digest,
      },
      runId: "run_1",
      attempt: {
        attemptId: "attempt_1",
        attemptNumber: 1,
        epoch: 1,
        fencingTokenDigest: digest,
      },
      assessmentInputDigest: digest,
      evidenceReceiptDigests: [digest, otherDigest],
      gateResults: [
        {
          gateId: "checks",
          state: "satisfied",
          reasonCode: "verification_passed",
          evidenceReceiptDigests: [digest],
        },
      ],
      conclusion: "satisfied",
      assessedAt: observedAt,
      assessedBy: "local_opentag",
    },
    payloadDigest: digest,
    receiptDigest: otherDigest,
  };
}

describe("OpenTag Control V1 version and capability negotiation", () => {
  it("keeps schema, protocol, and artifact versions independent", () => {
    expect(CONTROL_SCHEMA_VERSION).toBe(1);
    expect(CONTROL_PROTOCOL_VERSION).toBe("1.0");

    expect(
      RelayCapabilitiesResponseV1Schema.parse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1",
        capabilities: ["relay.readiness.v1", "relay.registration.v1"],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: {
          environment: "staging",
          releaseSha: "0".repeat(40),
        },
        artifact: { packageName: "@opentag/core", packageVersion: "0.9.0" },
      }).artifact?.packageVersion,
    ).toBe("0.9.0");
  });

  it.each([
    { schemaVersion: 2, protocolVersion: "1.0" },
    { schemaVersion: 1, protocolVersion: "2.0" },
  ])("rejects unsupported schema or protocol versions: %j", (versions) => {
    expect(
      ControlMutationRequestV1Schema.safeParse({
        ...versions,
        requiredCapabilities: ["relay.lifecycle.v1"],
        requestId: "req_1",
        operationId: "op_1",
      }).success,
    ).toBe(false);
  });

  it.each(["1", "1.0", "01.0.0", "1.0.0-01", "v1.0.0"])("rejects invalid npm artifact semver %s", (version) => {
    expect(NpmPackageVersionSchema.safeParse(version).success).toBe(false);
  });

  it.each([
    ["relay.readiness.v1", "relay.lifecycle.v1"],
    ["relay.lifecycle.v1", "relay.lifecycle.v1"],
  ])("rejects unsorted or duplicate required capabilities: %j", (requiredCapabilities) => {
    expect(
      ControlMutationRequestV1Schema.safeParse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities,
        requestId: "req_1",
        operationId: "op_1",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown capability names and parallel idempotency fields", () => {
    const request = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.not-real.v1"],
      requestId: "req_1",
      operationId: "op_1",
    };

    expect(ControlMutationRequestV1Schema.safeParse(request).success).toBe(false);
    expect(
      ControlMutationRequestV1Schema.safeParse({
        ...request,
        requiredCapabilities: ["relay.lifecycle.v1"],
        idempotencyKey: "parallel-key",
      }).success,
    ).toBe(false);
  });
});

describe("permission V1 control protocol", () => {
  const attempt = {
    attemptId: "attempt_1",
    attemptNumber: 2,
    epoch: 2,
    fencingTokenDigest: publicFenceDigest,
  } as const;
  const request = {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.permission.v1"],
    requestId: "transport_request_1",
    operationId: "permission_operation_1",
    organizationId: "org_1",
    runnerId: "runner_1",
    runId: "run_1",
    attempt: {
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
      epoch: attempt.epoch,
      fencingToken: "fence_secret_canary",
      fencingTokenDigest: attempt.fencingTokenDigest,
    },
    permissionRequestId: "permission_request_1",
    actionId: "action_1",
    actionFamily: "publish",
    riskTier: "high",
    targetFingerprint: otherDigest,
    permissionScopes: ["npm:publish", "package:write"],
    policySnapshotRef: "policy_1",
    policySnapshotDigest: digest,
    permissionRequestDigest: otherDigest,
    requestedAt: observedAt,
  } as const;
  const digestSource = {
    schemaVersion: request.schemaVersion,
    protocolVersion: request.protocolVersion,
    requiredCapabilities: request.requiredCapabilities,
    organizationId: request.organizationId,
    runnerId: request.runnerId,
    runId: request.runId,
    attempt,
    permissionRequestId: request.permissionRequestId,
    actionId: request.actionId,
    actionFamily: request.actionFamily,
    riskTier: request.riskTier,
    targetFingerprint: request.targetFingerprint,
    permissionScopes: request.permissionScopes,
    policySnapshotRef: request.policySnapshotRef,
    policySnapshotDigest: request.policySnapshotDigest,
    requestedAt: request.requestedAt,
  } as const;
  const waitingReceipt = {
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "permission_resolution",
    receiptId: "permission_receipt_1",
    organizationId: "org_1",
    operationId: "permission_operation_1",
    requiredCapabilities: ["relay.permission.v1"],
    producer: { kind: "cloud", id: "control_1" },
    identity: {
      namespace: "opentag.control.receipt/permission-resolution/v1",
      parts: ["org_1", "run_1", "attempt_1", "action_1", "resolution_1"],
    },
    observedAt,
    payloadDigest: digest,
    receiptDigest: otherDigest,
    runId: "run_1",
    attempt,
    payload: {
      resolutionId: "resolution_1",
      permissionRequestId: "permission_request_1",
      permissionRequestDigest: otherDigest,
      actionId: "action_1",
      actionFamily: "publish",
      riskTier: "high",
      targetFingerprint: otherDigest,
      permissionScopes: ["npm:publish", "package:write"],
      policySnapshotRef: "policy_1",
      policySnapshotDigest: digest,
      state: "waiting",
      reasonCode: "human_approval_required",
      requestedAt: observedAt,
      observedAt,
      nextAction: "wait_for_operator",
    },
  } as const;

  it("accepts only a normalized, fenced Runner permission request", () => {
    expect(RunnerPermissionRequestV1Schema.safeParse(request).success).toBe(true);
    expect(RunnerPermissionCurrentQueryV1Schema.safeParse({
      organizationId: request.organizationId,
      runnerId: request.runnerId,
      runId: request.runId,
      attempt,
      actionId: request.actionId,
      permissionRequestId: request.permissionRequestId,
      permissionRequestDigest: request.permissionRequestDigest,
    }).success).toBe(true);
    for (const [field, value] of [
      ["action", { id: "action_1" }],
      ["toolCallId", "tool_1"],
      ["rawArgs", { command: "npm publish" }],
      ["title", "Publish from /private/repo"],
      ["path", "/private/repo"],
      ["provider", "npm"],
      ["metadata", {}],
    ] as const) {
      expect(RunnerPermissionRequestV1Schema.safeParse({ ...request, [field]: value }).success).toBe(false);
    }
    expect(RunnerPermissionRequestV1Schema.safeParse({
      ...request,
      permissionScopes: ["package:write", "npm:publish"],
    }).success).toBe(false);
    expect(RunnerPermissionRequestV1Schema.safeParse({
      ...request,
      attempt: { ...request.attempt, epoch: 3 },
    }).success).toBe(false);
  });

  it("freezes public fence and permission request digest inputs without transport circularity", async () => {
    expect(await computePermissionFencingTokenDigestV1("fence_secret_canary")).toBe(
      "sha256:a512da91cdeeb1f7d044b56cabe5e37335094c4045e07ce6680630109e7cfef5",
    );
    const input = buildPermissionRequestDigestInputV1(digestSource);
    expect(PermissionRequestDigestInputV1Schema.parse(input)).toEqual(digestSource);
    expect(Object.keys(input)).not.toContain("requestId");
    expect(Object.keys(input)).not.toContain("operationId");
    expect(Object.keys(input)).not.toContain("permissionRequestDigest");
    expect(Object.keys(input.attempt)).not.toContain("fencingToken");

    const expectedDigest = await computePermissionRequestDigestV1(digestSource);
    expect(expectedDigest).toBe(
      "sha256:bc7e39fcc63caab71661680c54ec90dc7a98fd043082b8af45c1d78cffb19154",
    );
    expect(await computePermissionRequestDigestV1(buildPermissionRequestDigestInputV1(digestSource))).toBe(expectedDigest);

    for (const excludedField of [
      { requestId: "transport_request_2" },
      { operationId: "permission_operation_2" },
      { permissionRequestDigest: digest },
    ]) {
      expect(PermissionRequestDigestInputV1Schema.safeParse({
        ...digestSource,
        ...excludedField,
      }).success).toBe(false);
    }
    expect(PermissionRequestDigestInputV1Schema.safeParse({
      ...digestSource,
      attempt: { ...attempt, fencingToken: "different_raw_fence" },
    }).success).toBe(false);

    const businessMutations = [
      { ...digestSource, requiredCapabilities: ["relay.lifecycle.v1", "relay.permission.v1"] as const },
      { ...digestSource, organizationId: "org_2" },
      { ...digestSource, runnerId: "runner_2" },
      { ...digestSource, runId: "run_2" },
      { ...digestSource, attempt: { ...attempt, attemptId: "attempt_2" } },
      { ...digestSource, attempt: { ...attempt, attemptNumber: 3, epoch: 3 } },
      { ...digestSource, attempt: { ...attempt, fencingTokenDigest: otherDigest } },
      { ...digestSource, permissionRequestId: "permission_request_2" },
      { ...digestSource, actionId: "action_2" },
      { ...digestSource, actionFamily: "deploy" },
      { ...digestSource, riskTier: "critical" as const },
      { ...digestSource, targetFingerprint: digest },
      { ...digestSource, permissionScopes: ["npm:publish"] as const },
      { ...digestSource, policySnapshotRef: "policy_2" },
      { ...digestSource, policySnapshotDigest: otherDigest },
      { ...digestSource, requestedAt: "2026-08-08T00:00:01.000Z" },
    ];
    for (const mutation of businessMutations) {
      expect(await computePermissionRequestDigestV1(mutation)).not.toBe(expectedDigest);
    }
  });

  it("limits human decisions to allow_once or deny without Runner credentials", () => {
    const decision = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.permission.v1"],
      requestId: "decision_transport_1",
      operationId: "decision_operation_1",
      organizationId: "org_1",
      runId: "run_1",
      attempt,
      actionId: "action_1",
      permissionRequestId: "permission_request_1",
      permissionRequestDigest: otherDigest,
      policySnapshotDigest: digest,
      decisionId: "decision_1",
      decision: "allow_once",
      decidedAt: observedAt,
    } as const;
    expect(HumanPermissionDecisionRequestV1Schema.safeParse(decision).success).toBe(true);
    expect(HumanPermissionDecisionRequestV1Schema.safeParse({ ...decision, decision: "allow_run" }).success).toBe(false);
    expect(HumanPermissionDecisionRequestV1Schema.safeParse({ ...decision, runnerToken: "secret" }).success).toBe(false);
    expect(HumanPermissionDecisionRequestV1Schema.safeParse({ ...decision, fencingToken: "secret" }).success).toBe(false);
    expect(HumanPermissionDecisionRequestV1Schema.safeParse({ ...decision, reason: "Approved." }).success).toBe(false);
  });

  it("rejects bounded-field smuggling across requests and receipts", () => {
    for (const actionFamily of [
      "Publish",
      "publish/path",
      `p${"a".repeat(64)}`,
      "sk_live_abcdefgh",
    ]) {
      expect(RunnerPermissionRequestV1Schema.safeParse({ ...request, actionFamily }).success).toBe(false);
    }

    for (const permissionScopes of [
      ["publish"],
      ["NPM:publish"],
      ["npm:/private/repo"],
      [`${"a".repeat(64)}:${"b".repeat(64)}`],
      Array.from({ length: 33 }, (_, index) => `scope:item${String(index).padStart(2, "0")}`),
      ["npm:ghp_abcdefgh"],
    ]) {
      expect(RunnerPermissionRequestV1Schema.safeParse({ ...request, permissionScopes }).success).toBe(false);
    }

    for (const field of [
      "requestId",
      "operationId",
      "organizationId",
      "runnerId",
      "runId",
      "permissionRequestId",
      "actionId",
      "policySnapshotRef",
    ] as const) {
      for (const unsafe of [
        "/private/repo",
        "https://control.example/id",
        `a${"b".repeat(128)}`,
        "bad\nid",
        "ghp_abcdefgh",
      ]) {
        expect(RunnerPermissionRequestV1Schema.safeParse({ ...request, [field]: unsafe }).success).toBe(false);
      }
    }

    expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({
      ...waitingReceipt,
      producer: { kind: "cloud", id: "/private/control" },
    }).success).toBe(false);
    expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({
      ...waitingReceipt,
      nextAction: "wait_for_operator",
    }).success).toBe(false);
    expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({
      ...waitingReceipt,
      payload: { ...waitingReceipt.payload, nextAction: "poll_later" },
    }).success).toBe(false);

    const { nextAction: _nextAction, ...terminalPayload } = waitingReceipt.payload;
    const authorized = {
      ...waitingReceipt,
      payload: {
        ...terminalPayload,
        state: "authorized",
        decision: "allow_once",
        decisionRef: "decision_1",
        decisionActorRef: "user_1",
        reasonCode: "human_approved",
        decidedAt: observedAt,
      },
    } as const;
    for (const field of ["decisionRef", "decisionActorRef"] as const) {
      expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({
        ...authorized,
        payload: { ...authorized.payload, [field]: "/private/actor" },
      }).success).toBe(false);
    }
    for (const reason of ["relative/path", "Original tool title", "https://control.example/private"]) {
      expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({
        ...waitingReceipt,
        payload: { ...waitingReceipt.payload, reason },
      }).success).toBe(false);
    }
  });

  it("keeps waiting and terminal permission receipts strict, sanitized, and status-bound", () => {
    expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse(waitingReceipt).success).toBe(true);
    expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({
      ...waitingReceipt,
      requiredCapabilities: ["relay.permission.v1", "relay.readiness.v1"],
    }).success).toBe(false);
    expect(RunnerPermissionRequestHttpResponseV1Schema.safeParse({ status: 202, body: waitingReceipt }).success).toBe(true);
    expect(RunnerPermissionRequestHttpResponseV1Schema.safeParse({ status: 200, body: waitingReceipt }).success).toBe(false);
    expect(PermissionResolutionCurrentHttpResponseV1Schema.safeParse({ status: 200, body: waitingReceipt }).success).toBe(false);

    const authorized = {
      ...waitingReceipt,
      payload: {
        ...waitingReceipt.payload,
        state: "authorized",
        decision: "allow_once",
        decisionRef: "decision_1",
        decisionActorRef: "user_1",
        reasonCode: "human_approved",
        decidedAt: observedAt,
        nextAction: undefined,
      },
    } as const;
    expect(HumanPermissionDecisionHttpResponseV1Schema.safeParse({ status: 200, body: authorized }).success).toBe(true);
    expect(HumanPermissionDecisionHttpResponseV1Schema.safeParse({ status: 202, body: authorized }).success).toBe(false);
    expect(HumanPermissionDecisionHttpResponseV1Schema.safeParse({ status: 200, body: waitingReceipt }).success).toBe(false);
    expect(PermissionResolutionCurrentHttpResponseV1Schema.safeParse({ status: 202, body: authorized }).success).toBe(false);

    const denied = {
      ...authorized,
      payload: {
        ...authorized.payload,
        state: "denied",
        decision: "deny",
        reasonCode: "human_denied",
      },
    } as const;
    expect(HumanPermissionDecisionHttpResponseV1Schema.safeParse({ status: 200, body: denied }).success).toBe(true);
    expect(PermissionResolutionCurrentHttpResponseV1Schema.safeParse({ status: 200, body: denied }).success).toBe(true);
    for (const payload of [
      { ...denied.payload, decision: "allow_once" },
      { ...denied.payload, reasonCode: "human_approved" },
      { ...denied.payload, decisionRef: undefined },
      { ...denied.payload, decisionActorRef: undefined },
      { ...denied.payload, decidedAt: undefined },
      { ...denied.payload, nextAction: "wait_for_operator" },
      { ...authorized.payload, decision: "deny" },
      { ...authorized.payload, reasonCode: "human_denied" },
    ]) {
      expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({
        ...denied,
        payload,
      }).success).toBe(false);
    }

    for (const [field, value] of [
      ["action", { id: "action_1" }],
      ["rawArgs", { command: "npm publish" }],
      ["title", "Publish package"],
      ["path", "/private/repo"],
      ["providerPayload", { token: "secret" }],
      ["metadata", {}],
      ["fencingToken", "fence_secret_canary"],
    ] as const) {
      expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({ ...waitingReceipt, [field]: value }).success).toBe(false);
      expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({
        ...waitingReceipt,
        payload: { ...waitingReceipt.payload, [field]: value },
      }).success).toBe(false);
    }
    expect(PermissionResolutionReceiptEnvelopeV1Schema.safeParse({
      ...authorized,
      payload: { ...authorized.payload, decision: "allow_run" },
    }).success).toBe(false);
  });
});

describe("material action receipt V1 control protocol", () => {
  const payload = {
    actionId: "action_1",
    actionFamily: "publish",
    provider: "npm",
    connectionRef: "connection_1",
    targetFingerprint: digest,
    operationId: "material_operation_1",
    requestDigest: otherDigest,
    actionPayloadDigest: digest,
    outcome: "succeeded",
    externalId: "publish_1",
    externalUri: "https://registry.example/packages/opentag/1.0.0",
    observedAt,
    evidenceRefs: ["evidence_1", "evidence_2"],
    evidenceDigests: [digest, otherDigest],
    reasonCode: "provider_accepted",
  } as const;
  const receipt = {
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptId: "material_receipt_1",
    organizationId: "org_1",
    operationId: "material_operation_1",
    requiredCapabilities: ["relay.material-receipt.v1"],
    producer: { kind: "local_opentag", id: "local_opentag_1" },
    identity: {
      namespace: "opentag.control.receipt/material-action/v1",
      parts: ["org_1", "run_1", "attempt_1", "action_1", "material_receipt_1"],
    },
    observedAt,
    payloadDigest: digest,
    receiptDigest: otherDigest,
    receiptKind: "material_action",
    runId: "run_1",
    attempt: {
      attemptId: "attempt_1",
      attemptNumber: 2,
      epoch: 2,
      fencingTokenDigest: digest,
    },
    payload,
  } as const;
  const reconcileRequest = {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.material-receipt.v1"],
    requestId: "reconcile_request_1",
    organizationId: "org_1",
    runnerId: "runner_1",
    runId: "run_1",
    actionId: "action_1",
    attempt: {
      attemptId: "attempt_1",
      attemptNumber: 2,
      epoch: 2,
      fencingToken: "fence_secret_canary",
      fencingTokenDigest: publicFenceDigest,
    },
    expectedCurrentReceiptId: "material_receipt_1",
    expectedCurrentReceiptDigest: otherDigest,
  } as const;

  it("accepts the strict locally authoritative material receipt and canonical digest inputs", async () => {
    expect(MaterialActionPayloadV1Schema.safeParse(payload).success).toBe(true);
    expect(MaterialActionReceiptEnvelopeV1Schema.safeParse(receipt).success).toBe(true);
    const { receiptDigest: _receiptDigest, ...receiptDigestInput } = receipt;
    expect(MaterialActionReceiptDigestInputV1Schema.parse(receiptDigestInput)).toEqual(
      receiptDigestInput,
    );
    expect(buildMaterialActionReceiptDigestInputV1(receiptDigestInput)).toEqual(
      receiptDigestInput,
    );
    expect(await computeMaterialActionPayloadDigestV1(payload)).toBe(digestCanonical(payload));
    expect(await computeMaterialActionReceiptDigestV1(receiptDigestInput)).toBe(
      digestCanonical(receiptDigestInput),
    );
  });

  it("freezes a strict runtime Runner reconciliation query without provider mutation fields", async () => {
    expect(RunnerMaterialActionReconcileRequestV1Schema.safeParse(reconcileRequest).success).toBe(true);
    const {
      expectedCurrentReceiptId: _expectedCurrentReceiptId,
      expectedCurrentReceiptDigest: _expectedCurrentReceiptDigest,
      ...withoutExpectedCurrent
    } = reconcileRequest;
    expect(RunnerMaterialActionReconcileRequestV1Schema.safeParse(withoutExpectedCurrent).success).toBe(true);
    expect(await computeMaterialActionFencingTokenDigestV1("fence_secret_canary")).toBe(
      publicFenceDigest,
    );

    for (const [field, value] of [
      ["provider", "npm"],
      ["outcome", "succeeded"],
      ["evidence", []],
      ["body", { provider: "response" }],
      ["metadata", {}],
      ["credential", "runtime_token_canary"],
      ["operationId", "cloud_mutation_1"],
      ["connectionRef", "connection_1"],
    ] as const) {
      expect(RunnerMaterialActionReconcileRequestV1Schema.safeParse({
        ...reconcileRequest,
        [field]: value,
      }).success).toBe(false);
    }
    expect(RunnerMaterialActionReconcileRequestV1Schema.safeParse({
      ...reconcileRequest,
      attempt: { ...reconcileRequest.attempt, fencingToken: "" },
    }).success).toBe(false);
    expect(RunnerMaterialActionReconcileRequestV1Schema.safeParse({
      ...reconcileRequest,
      attempt: { ...reconcileRequest.attempt, epoch: 3 },
    }).success).toBe(false);
  });

  it("requires exact capability and an all-or-nothing expected-current pair", () => {
    for (const mutation of [
      { requiredCapabilities: ["relay.lifecycle.v1"] },
      { requiredCapabilities: ["relay.material-receipt.v1", "relay.permission.v1"] },
      { expectedCurrentReceiptId: undefined },
      { expectedCurrentReceiptDigest: undefined },
      { expectedCurrentReceiptId: null },
      { expectedCurrentReceiptDigest: null },
      { runnerId: "/private/runner" },
      { actionId: "ghp_abcdefgh" },
    ]) {
      expect(RunnerMaterialActionReconcileRequestV1Schema.safeParse({
        ...reconcileRequest,
        ...mutation,
      }).success).toBe(false);
    }
  });

  it("maps terminal reconciliation to 200, unknown to 202, and keeps standard errors", () => {
    const failedReceipt = {
      ...receipt,
      payload: {
        ...payload,
        outcome: "failed",
        reasonCode: "provider_rejected",
      },
    } as const;
    const unknownReceipt = {
      ...receipt,
      payload: {
        ...payload,
        outcome: "outcome_unknown",
        reasonCode: "provider_receipt_missing",
        nextAction: "reconcile_provider_receipt",
        owner: "local_opentag",
      },
    } as const;
    for (const terminalReceipt of [receipt, failedReceipt]) {
      expect(MaterialActionReconcileHttpResponseV1Schema.safeParse({
        status: 200,
        body: terminalReceipt,
      }).success).toBe(true);
      expect(MaterialActionReconcileHttpResponseV1Schema.safeParse({
        status: 202,
        body: terminalReceipt,
      }).success).toBe(false);
    }
    expect(MaterialActionReconcileHttpResponseV1Schema.safeParse({
      status: 202,
      body: unknownReceipt,
    }).success).toBe(true);
    expect(MaterialActionReconcileHttpResponseV1Schema.safeParse({
      status: 200,
      body: unknownReceipt,
    }).success).toBe(false);

    for (const [status, error] of [
      [404, "missing_or_concealed"],
      [409, "idempotency_conflict"],
      [500, "internal_error"],
    ] as const) {
      expect(MaterialActionReconcileHttpResponseV1Schema.safeParse({
        status,
        body: {
          schemaVersion: 1,
          protocolVersion: "1.0",
          error,
          message: "Reconciliation query failed.",
          requestId: "reconcile_request_1",
        },
      }).success).toBe(true);
    }
  });

  it("rejects unknown, nullable, or raw custody fields", () => {
    for (const [field, value] of [
      ["metadata", {}],
      ["context", { source: "private" }],
      ["rawBody", "provider response"],
      ["command", "npm publish"],
      ["path", "/private/repo"],
      ["token", "npm_token_canary"],
    ] as const) {
      expect(MaterialActionPayloadV1Schema.safeParse({ ...payload, [field]: value }).success).toBe(false);
    }
    for (const field of ["externalId", "externalUri", "evidenceRefs", "evidenceDigests"] as const) {
      expect(MaterialActionPayloadV1Schema.safeParse({ ...payload, [field]: null }).success).toBe(false);
    }
    expect(MaterialActionReceiptEnvelopeV1Schema.safeParse({
      ...receipt,
      attempt: { ...receipt.attempt, fencingToken: "raw_fence_canary" },
    }).success).toBe(false);
    expect(MaterialActionReceiptEnvelopeV1Schema.safeParse({
      ...receipt,
      producer: { ...receipt.producer, credentialId: "runtime_credential_1" },
    }).success).toBe(false);
  });

  it("binds outcomes to allowlisted reasons and reconciliation ownership", () => {
    for (const mutation of [
      { outcome: "succeeded", reasonCode: "provider_error" },
      { outcome: "failed", reasonCode: "provider_accepted" },
      { outcome: "outcome_unknown", reasonCode: "provider_rejected" },
      { outcome: "made_up", reasonCode: "provider_accepted" },
    ]) {
      expect(MaterialActionPayloadV1Schema.safeParse({ ...payload, ...mutation }).success).toBe(false);
    }
    const unknown = {
      ...payload,
      outcome: "outcome_unknown",
      reasonCode: "provider_timeout",
      nextAction: "reconcile_provider_receipt",
      owner: "local_opentag",
    } as const;
    expect(MaterialActionPayloadV1Schema.safeParse(unknown).success).toBe(true);
    expect(MaterialActionPayloadV1Schema.safeParse({ ...unknown, nextAction: undefined }).success).toBe(false);
    expect(MaterialActionPayloadV1Schema.safeParse({ ...unknown, owner: undefined }).success).toBe(false);
    expect(MaterialActionPayloadV1Schema.safeParse({ ...payload, nextAction: "retry" }).success).toBe(false);
    expect(MaterialActionPayloadV1Schema.safeParse({
      ...payload,
      outcome: "failed",
      reasonCode: "provider_rejected",
      owner: "local_opentag",
    }).success).toBe(false);
  });

  it("accepts only sanitized canonical HTTP(S) external URIs", () => {
    for (const externalUri of [
      "ftp://provider.example/receipt/1",
      "https://user:password@provider.example/receipt/1",
      "https://provider.example/receipt/1?token=secret",
      "https://provider.example/receipt/1#access_token",
      "https://provider.example",
      "not-a-url",
    ]) {
      expect(MaterialActionPayloadV1Schema.safeParse({ ...payload, externalUri }).success).toBe(false);
    }
  });

  it("binds capability, producer, attempt, operation, time, and exact identity", () => {
    for (const mutation of [
      { requiredCapabilities: ["relay.lifecycle.v1"] },
      { requiredCapabilities: ["relay.material-receipt.v1", "relay.permission.v1"] },
      { producer: { kind: "cloud", id: "control_1" } },
      { producer: { kind: "runner", id: "runner_1" } },
      { identity: { ...receipt.identity, parts: [...receipt.identity.parts.slice(0, 4), "other_receipt"] } },
      { identity: { ...receipt.identity, parts: ["org_1", "run_1", "attempt_1", "other_action", "material_receipt_1"] } },
      { attempt: { ...receipt.attempt, epoch: 3 } },
      { payload: { ...payload, operationId: "other_operation" } },
      { payload: { ...payload, observedAt: "2026-08-08T00:00:01.000Z" } },
    ]) {
      expect(MaterialActionReceiptEnvelopeV1Schema.safeParse({ ...receipt, ...mutation }).success).toBe(false);
    }
    for (const mutation of [
      { actionId: "/private/action" },
      { connectionRef: "https://provider.example/connection" },
      { externalId: "ghp_abcdefgh" },
      { actionFamily: "Publish" },
      { provider: "npm/provider" },
      { evidenceRefs: ["evidence_1"], evidenceDigests: [digest, otherDigest] },
      { evidenceRefs: undefined },
      { evidenceDigests: undefined },
    ]) {
      expect(MaterialActionPayloadV1Schema.safeParse({ ...payload, ...mutation }).success).toBe(false);
    }
  });
});

describe("OpenTag Control V1 status semantics", () => {
  it.each([
    { status: 400, error: "invalid_request_body", message: "Invalid body.", requestId: "req_1" },
    { status: 401, error: "invalid_credential", message: "Invalid credential.", requestId: "req_1" },
    { status: 403, error: "insufficient_scope", message: "Insufficient scope.", requestId: "req_1" },
    { status: 404, error: "missing_or_concealed", message: "Resource not found.", requestId: "req_1" },
    { status: 409, error: "stale_attempt", message: "The attempt fence is stale.", requestId: "req_1" },
    {
      status: 412,
      error: "capability_required",
      message: "Required capability is unavailable.",
      requestId: "req_1",
      requiredCapabilities: ["relay.lifecycle.v1"],
    },
    { status: 413, error: "request_body_too_large", message: "Body too large.", requestId: "req_1" },
    { status: 422, error: "observation_policy_mismatch", message: "Policy mismatch.", requestId: "req_1" },
    {
      status: 426,
      error: "protocol_upgrade_required",
      message: "Upgrade the control protocol.",
      requestId: "req_1",
      supported: { schemaVersions: [1], protocolVersions: ["1.0"] },
      nextAction: "upgrade_client",
    },
    {
      status: 429,
      error: "rate_limited",
      message: "Retry later.",
      requestId: "req_1",
      retryAfterSeconds: 30,
    },
    {
      status: 500,
      error: "internal_error",
      message: "Internal failure.",
      requestId: "req_1",
    },
  ])("accepts the normalized $status response shape", (response) => {
    expect(
      ControlErrorHttpResponseV1Schema.safeParse({
        status: response.status,
        body: {
          schemaVersion: 1,
          protocolVersion: "1.0",
          ...Object.fromEntries(Object.entries(response).filter(([key]) => key !== "status")),
        },
      }).success,
    ).toBe(true);
  });

  it("freezes the strict 500 internal error response shape", () => {
    const response = {
      status: 500,
      body: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        error: "internal_error",
        message: "Internal failure.",
        requestId: "req_internal_1",
      },
    } as const;

    expect(ControlErrorHttpResponseV1Schema.safeParse(response).success).toBe(true);
    expect(ControlErrorHttpResponseV1Schema.safeParse({
      ...response,
      unexpected: true,
    }).success).toBe(false);
    expect(ControlErrorHttpResponseV1Schema.safeParse({
      ...response,
      body: { ...response.body, unexpected: true },
    }).success).toBe(false);
    expect(ControlErrorHttpResponseV1Schema.safeParse({
      ...response,
      body: { ...response.body, message: "" },
    }).success).toBe(false);
    expect(ControlErrorHttpResponseV1Schema.safeParse({
      ...response,
      body: { ...response.body, requestId: "" },
    }).success).toBe(false);
  });

  it.each(["stale_registration", "stale_readiness", "target_binding_stale"] as const)(
    "accepts readiness conflict reason %s",
    (error) => {
      expect(
        ControlErrorHttpResponseV1Schema.safeParse({
          status: 409,
          body: {
            schemaVersion: 1,
            protocolVersion: "1.0",
            error,
            message: "The readiness receipt is stale.",
            requestId: "req_readiness_1",
          },
        }).success,
      ).toBe(true);
    },
  );

  it("does not let a 202 waiting receipt claim authorization", () => {
    expect(
      ControlWaitingHttpResponseV1Schema.safeParse({
        status: 202,
        body: {
          schemaVersion: 1,
          protocolVersion: "1.0",
          state: "authorized",
          requestId: "req_1",
          resolutionRef: "permission_1",
          nextAction: "apply",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a durable 202 waiting response without treating it as an error", () => {
    expect(
      ControlWaitingHttpResponseV1Schema.safeParse({
        status: 202,
        body: {
          schemaVersion: 1,
          protocolVersion: "1.0",
          state: "waiting",
          requestId: "req_1",
          resolutionRef: "permission_1",
          nextAction: "wait_for_operator",
        },
      }).success,
    ).toBe(true);
  });
});

describe("runner registration and credential re-provision", () => {
  const registration = {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.registration.v1"],
    requestId: "req_pair_1",
    operationId: "op_pair_1",
    runnerId: "runner_1",
    displayName: "Private runner",
    capabilities: ["relay.lifecycle.v1", "relay.readiness.v1"],
  } as const;

  it("accepts strict registration and re-provision mutation identities", () => {
    expect(RunnerRegistrationRequestV1Schema.safeParse(registration).success).toBe(true);
    const reprovision = RunnerCredentialReprovisionRequestV1Schema.parse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.credential-reprovision.v1"],
        requestId: "req_recover_1",
        operationId: "op_recover_1",
        runnerId: "runner_1",
        recoveryCredentialId: "recovery_1",
        expectedRegistrationGeneration: 1,
        expectedCredentialGeneration: 1,
    });
    expect(reprovision.recoveryCredentialId).toBe("recovery_1");
    expect(
      RunnerCredentialReprovisionRequestV1Schema.safeParse({
        ...reprovision,
        recoveryCredentialId: " recovery_1",
      }).success,
    ).toBe(false);
    const { recoveryCredentialId: _recoveryCredentialId, ...missingCredentialIdentity } = reprovision;
    expect(RunnerCredentialReprovisionRequestV1Schema.safeParse(missingCredentialIdentity).success).toBe(false);
    const changedCredentialIdentity = RunnerCredentialReprovisionRequestV1Schema.parse({
      ...reprovision,
      recoveryCredentialId: "recovery_2",
    });
    expect(changedCredentialIdentity.recoveryCredentialId).toBe("recovery_2");
    expect(changedCredentialIdentity).not.toEqual(reprovision);
    expect(
      RunnerCredentialReprovisionRequestV1Schema.safeParse({
        ...reprovision,
        recoveryCredentialIdentity: "recovery_shadow",
      }).success,
    ).toBe(false);
  });

  it.each(["environment", "workspacePath", "metadata", "organizationId", "runnerToken", "idempotencyKey"])(
    "rejects forbidden registration field %s",
    (field) => {
      expect(RunnerRegistrationRequestV1Schema.safeParse({ ...registration, [field]: "forbidden" }).success).toBe(false);
    },
  );

  it("permits plaintext only in a fresh 201 response and forbids it on replay", () => {
    const metadata = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      operationId: "op_pair_1",
      runnerId: "runner_1",
      registrationGeneration: 1,
      credentialGeneration: 1,
      credentialId: "runtime_credential_1",
      credentialPurpose: "runtime",
      createdAt: observedAt,
    } as const;

    expect(
      RunnerRegistrationResponseV1Schema.safeParse({
        ...metadata,
        runnerToken: "one-time-plaintext",
        replayed: false,
      }).success,
    ).toBe(true);
    expect(RunnerCredentialMetadataV1Schema.parse(metadata)).toEqual(metadata);
    expect(
      RunnerCredentialMetadataV1Schema.safeParse({ ...metadata, replayed: false }).success,
    ).toBe(false);
    expect(
      RunnerRegistrationResponseV1Schema.safeParse({
        ...metadata,
        runnerToken: "must-not-replay",
        replayed: true,
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialResponseV1Schema.safeParse({
        ...metadata,
        runnerToken: "must-not-replay",
        replayed: true,
      }).success,
    ).toBe(false);
    const freshResponse = {
      status: 201,
      body: { ...metadata, runnerToken: "one-time-plaintext", replayed: false },
    } as const;
    const replayedResponse = {
      status: 200,
      body: { ...metadata, replayed: true },
    } as const;
    expect(RunnerCredentialHttpResponseV1Schema.parse(freshResponse)).toEqual(freshResponse);
    expect(RunnerCredentialHttpResponseV1Schema.parse(replayedResponse)).toEqual(replayedResponse);
    expect(
      RunnerCredentialHttpResponseV1Schema.safeParse({
        status: 200,
        body: { ...metadata, runnerToken: "must-not-replay", replayed: true },
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialHttpResponseV1Schema.safeParse({
        status: 400,
        body: {
          schemaVersion: 1,
          protocolVersion: "1.0",
          error: "invalid_request_body",
          message: "Invalid body.",
          requestId: "req_1",
        },
      }).success,
    ).toBe(true);
    expect(
      RunnerCredentialHttpResponseV1Schema.safeParse({
        status: 400,
        body: {
          schemaVersion: 1,
          protocolVersion: "1.0",
          error: "invalid_request_body",
          message: "Invalid body.",
          requestId: "req_1",
          metadata: {},
        },
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialHttpResponseV1Schema.safeParse({
        status: 201,
        body: { ...metadata, replayed: true },
      }).success,
    ).toBe(false);
  });

  it.each([" req_1", "req_1 ", " "])("rejects canonical request IDs with whitespace: %j", (requestId) => {
    expect(RunnerRegistrationRequestV1Schema.safeParse({ ...registration, requestId }).success).toBe(false);
  });
});

describe("runner credential rotation and revocation", () => {
  const mutation = {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.credential-rotation.v1"],
    requestId: "req_rotate_1",
    operationId: "op_rotate_1",
    runnerId: "runner_1",
    expectedRegistrationGeneration: 3,
    expectedCredentialGeneration: 7,
    expectedCredentialId: "runtime_credential_7",
  } as const;

  const rotationMetadata = {
    schemaVersion: 1,
    protocolVersion: "1.0",
    operationId: "op_rotate_1",
    runnerId: "runner_1",
    registrationGeneration: 3,
    credentialGeneration: 8,
    replacedCredentialId: "runtime_credential_7",
    credentialId: "runtime_credential_8",
    credentialPurpose: "runtime",
    createdAt: observedAt,
  } as const;

  it("accepts strict generation-fenced rotate and revoke requests", () => {
    expect(RunnerCredentialRotationRequestV1Schema.parse(mutation)).toEqual(mutation);
    expect(RunnerCredentialRevocationRequestV1Schema.parse(mutation)).toEqual(mutation);

    expect(
      RunnerCredentialRotationRequestV1Schema.safeParse({
        ...mutation,
        credentialGeneration: 8,
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialRevocationRequestV1Schema.safeParse({
        ...mutation,
        requiredCapabilities: ["relay.lifecycle.v1"],
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialRotationRequestV1Schema.safeParse({
        ...mutation,
        requiredCapabilities: [
          "relay.credential-rotation.v1",
          "relay.lifecycle.v1",
        ],
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialRotationRequestV1Schema.safeParse({
        ...mutation,
        expectedCredentialGeneration: 0,
      }).success,
    ).toBe(false);
  });

  it("returns plaintext only for a fresh rotation and requires a new credential ID", () => {
    expect(rotationMetadata.registrationGeneration).toBe(mutation.expectedRegistrationGeneration);
    expect(rotationMetadata.credentialGeneration).toBe(mutation.expectedCredentialGeneration + 1);
    expect(
      RunnerCredentialRotationHttpResponseV1Schema.safeParse({
        status: 201,
        body: {
          ...rotationMetadata,
          runnerToken: "one-time-plaintext",
          replayed: false,
        },
      }).success,
    ).toBe(true);
    expect(
      RunnerCredentialRotationHttpResponseV1Schema.safeParse({
        status: 200,
        body: {
          ...rotationMetadata,
          replayed: true,
        },
      }).success,
    ).toBe(true);
    expect(
      RunnerCredentialRotationHttpResponseV1Schema.safeParse({
        status: 200,
        body: {
          ...rotationMetadata,
          runnerToken: "must-not-replay",
          replayed: true,
        },
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialRotationHttpResponseV1Schema.safeParse({
        status: 200,
        body: {
          ...rotationMetadata,
          runnerToken: "fresh-token-at-wrong-status",
          replayed: false,
        },
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialRotationHttpResponseV1Schema.safeParse({
        status: 201,
        body: {
          ...rotationMetadata,
          replayed: true,
        },
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialRotationHttpResponseV1Schema.safeParse({
        status: 201,
        body: {
          ...rotationMetadata,
          replayed: false,
        },
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialRotationHttpResponseV1Schema.safeParse({
        status: 201,
        body: {
          ...rotationMetadata,
          credentialId: rotationMetadata.replacedCredentialId,
          runnerToken: "one-time-plaintext",
          replayed: false,
        },
      }).success,
    ).toBe(false);
  });

  it("represents revoke as a token-free terminal tombstone on first response and replay", () => {
    const revoked = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      operationId: "op_revoke_1",
      runnerId: "runner_1",
      registrationGeneration: 3,
      credentialGeneration: 8,
      credentialState: "revoked",
      revokedCredentialId: "runtime_credential_7",
      credentialPurpose: "runtime",
      activeCredentialId: null,
      revokedAt: observedAt,
    } as const;

    for (const replayed of [false, true] as const) {
      expect(
        RunnerCredentialRevocationHttpResponseV1Schema.safeParse({
          status: 200,
          body: { ...revoked, replayed },
        }).success,
      ).toBe(true);
      expect(
        RunnerCredentialRevocationHttpResponseV1Schema.safeParse({
          status: 200,
          body: { ...revoked, replayed, runnerToken: "forbidden" },
        }).success,
      ).toBe(false);
    }

    for (const invalidBody of [
      { ...revoked, replayed: false, activeCredentialId: "still-active" },
      { ...revoked, replayed: false, credentialId: "unexpected" },
      { ...revoked, replayed: false, credentialState: "active" },
    ]) {
      expect(
        RunnerCredentialRevocationHttpResponseV1Schema.safeParse({
          status: 200,
          body: invalidBody,
        }).success,
      ).toBe(false);
    }
  });

  it.each([
    "stale_credential",
    "idempotency_conflict",
    "invalid_state_transition",
  ] as const)(
    "accepts the endpoint-specific 409 %s response",
    (error) => {
      for (const schema of [
        RunnerCredentialRotationHttpResponseV1Schema,
        RunnerCredentialRevocationHttpResponseV1Schema,
      ]) {
        expect(
          schema.safeParse({
            status: 409,
            body: {
              schemaVersion: 1,
              protocolVersion: "1.0",
              error,
              message: "Credential mutation conflict.",
              requestId: "req_rotate_1",
            },
          }).success,
        ).toBe(true);
      }
    },
  );

  it("rejects non-credential conflicts and observation-only errors", () => {
    const body = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      message: "Wrong endpoint error.",
      requestId: "req_rotate_1",
    } as const;

    for (const schema of [
      RunnerCredentialRotationHttpResponseV1Schema,
      RunnerCredentialRevocationHttpResponseV1Schema,
    ]) {
      expect(
        schema.safeParse({
          status: 409,
          body: { ...body, error: "stale_attempt" },
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          status: 422,
          body: { ...body, error: "observation_policy_mismatch" },
        }).success,
      ).toBe(false);
    }
    expect(
      RunnerCredentialHttpResponseV1Schema.safeParse({
        status: 409,
        body: { ...body, error: "stale_credential" },
      }).success,
    ).toBe(false);
    expect(
      ControlErrorHttpResponseV1Schema.safeParse({
        status: 409,
        body: { ...body, error: "stale_credential" },
      }).success,
    ).toBe(false);
  });

  it("accepts only the strict rate-limited response body at 429", () => {
    const response = {
      status: 429,
      body: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        error: "rate_limited",
        message: "Try again later.",
        requestId: "req_rotate_1",
        retryAfterSeconds: 30,
      },
    } as const;

    expect(RunnerCredentialRotationHttpResponseV1Schema.safeParse(response).success).toBe(true);
    expect(RunnerCredentialRevocationHttpResponseV1Schema.safeParse(response).success).toBe(true);
    expect(ControlErrorHttpResponseV1Schema.safeParse(response).success).toBe(true);
    expect(
      RunnerCredentialRotationHttpResponseV1Schema.safeParse({
        ...response,
        body: { ...response.body, retryAfterSeconds: 0 },
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialRotationHttpResponseV1Schema.safeParse({
        ...response,
        body: { ...response.body, error: "stale_credential" },
      }).success,
    ).toBe(false);
  });

  it("exposes a strict operator current-generation projection without credential material", () => {
    const active = {
      status: 200,
      body: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        projectionStatus: "ready",
        runnerId: "runner_1",
        registrationGeneration: 3,
        credentialGeneration: 8,
        activeCredentialId: "runtime_credential_8",
        credentialState: "active",
        observedAt,
      },
    } as const;
    expect(RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse(active).success).toBe(true);
    expect(
      RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse({
        ...active,
        body: { ...active.body, activeCredentialId: null },
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse({
        ...active,
        body: { ...active.body, runnerToken: "forbidden" },
      }).success,
    ).toBe(false);
    expect(
      RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse({
        ...active,
        body: {
          ...active.body,
          activeCredentialId: null,
          credentialState: "revoked",
        },
      }).success,
    ).toBe(true);

    for (const reason of [
      "legacy_projection_unbackfilled",
      "credential_projection_inconsistent",
    ] as const) {
      expect(
        RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse({
          status: 200,
          body: {
            schemaVersion: 1,
            protocolVersion: "1.0",
            projectionStatus: "pending",
            runnerId: "runner_1",
            registrationGeneration: null,
            credentialGeneration: null,
            activeCredentialId: null,
            credentialState: "unknown",
            reason,
            nextAction: "operator_projection_migration_required",
            observedAt,
          },
        }).success,
      ).toBe(true);
    }

    const pending = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      projectionStatus: "pending",
      runnerId: "runner_1",
      registrationGeneration: null,
      credentialGeneration: null,
      activeCredentialId: null,
      credentialState: "unknown",
      reason: "legacy_projection_unbackfilled",
      nextAction: "operator_projection_migration_required",
      observedAt,
    } as const;

    const responseWithoutProjectionStatus: Record<string, unknown> = {
      ...active.body,
    };
    delete responseWithoutProjectionStatus.projectionStatus;
    expect(
      RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse({
        status: 200,
        body: responseWithoutProjectionStatus,
      }).success,
    ).toBe(false);

    for (const invalidBody of [
      { ...active.body, registrationGeneration: null },
      { ...active.body, credentialGeneration: null },
      { ...active.body, credentialState: "unknown" },
      { ...active.body, reason: "legacy_projection_unbackfilled" },
      {
        ...active.body,
        credentialState: "revoked",
        activeCredentialId: "runtime_credential_8",
      },
      { ...pending, registrationGeneration: 3 },
      { ...pending, credentialGeneration: 8 },
      { ...pending, activeCredentialId: "runtime_credential_8" },
      { ...pending, credentialState: "revoked" },
      { ...pending, reason: "projection_temporarily_unavailable" },
      { ...pending, nextAction: "retry_later" },
      { ...pending, extra: true },
    ]) {
      expect(
        RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse({
          status: 200,
          body: invalidBody,
        }).success,
      ).toBe(false);
    }

    for (const forbiddenField of [
      "runnerToken",
      "organizationId",
      "operatorId",
      "operatorScope",
      "grantedScopes",
      "verifier",
      "credentialPrefix",
      "scope",
    ]) {
      for (const body of [active.body, pending]) {
        expect(
          RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse({
            ...active,
            body: { ...body, [forbiddenField]: "forbidden" },
          }).success,
        ).toBe(false);
      }
    }

    for (const errorResponse of [
      { status: 401, error: "invalid_credential" },
      { status: 403, error: "insufficient_scope" },
      { status: 404, error: "missing_or_concealed" },
    ] as const) {
      expect(
        RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse({
          status: errorResponse.status,
          body: {
            schemaVersion: 1,
            protocolVersion: "1.0",
            error: errorResponse.error,
            message: "Credential current state is unavailable.",
            requestId: "req_current_1",
          },
        }).success,
      ).toBe(true);
    }
    expect(
      RunnerCredentialCurrentStateHttpResponseV1Schema.safeParse({
        status: 429,
        body: {
          schemaVersion: 1,
          protocolVersion: "1.0",
          error: "rate_limited",
          message: "Retry later.",
          requestId: "req_current_1",
          retryAfterSeconds: 30,
        },
      }).success,
    ).toBe(true);
  });
});

describe("governed projection fixture vectors", () => {
  it("parses and verifies the protocol-authority artifact", () => {
    const artifactBytes = readFileSync(GOVERNED_PROJECTION_VECTORS_PATH);
    const artifactText = artifactBytes.toString("utf8");
    const artifact = JSON.parse(artifactText) as {
      schemaVersion: number;
      protocolVersion: string;
      vectorVersion: string;
      fixtures: Record<string, unknown>;
    };

    expect(artifactText.endsWith("\n")).toBe(true);
    expect(artifactText).not.toContain("\r");
    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      GOVERNED_PROJECTION_VECTORS_SHA256,
    );
    expect({
      schemaVersion: artifact.schemaVersion,
      protocolVersion: artifact.protocolVersion,
      vectorVersion: artifact.vectorVersion,
    }).toEqual({
      schemaVersion: CONTROL_SCHEMA_VERSION,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      vectorVersion: "opentag.control.governed-projection-vectors/v1",
    });

    const fixtureSchemas = [
      ["workThreadRef", WorkThreadRefReceiptEnvelopeV1Schema, WorkThreadRefPayloadV1Schema],
      [
        "completionContractRef",
        CompletionContractRefReceiptEnvelopeV1Schema,
        CompletionContractRefPayloadV1Schema,
      ],
      ["completionAssessment", CompletionAssessmentReceiptEnvelopeV1Schema, CompletionAssessmentPayloadV1Schema],
      [
        "callbackIntentObservation",
        CallbackIntentObservationReceiptEnvelopeV1Schema,
        CallbackIntentObservationPayloadV1Schema,
      ],
      [
        "callbackAttemptObservation",
        CallbackAttemptObservationReceiptEnvelopeV1Schema,
        CallbackAttemptObservationPayloadV1Schema,
      ],
      [
        "callbackProviderObservation",
        CallbackProviderObservationReceiptEnvelopeV1Schema,
        CallbackProviderObservationPayloadV1Schema,
      ],
    ] as const;

    expect(Object.keys(artifact.fixtures)).toEqual(fixtureSchemas.map(([name]) => name));
    for (const [name, receiptSchema, payloadSchema] of fixtureSchemas) {
      const receipt = receiptSchema.parse(artifact.fixtures[name]);
      const payload = payloadSchema.parse(receipt.payload);
      const { receiptDigest, ...receiptDigestInput } = receipt;

      expect(receipt.payloadDigest, `${name} payloadDigest`).toBe(digestCanonical(payload));
      expect(receiptDigest, `${name} receiptDigest`).toBe(digestCanonical(receiptDigestInput));
    }
  });
});

describe("ReceiptEnvelope V1", () => {
  it("types readiness producer authority exactly", () => {
    expectTypeOf<
      RunnerReadinessReceiptEnvelopeV1["producer"]["kind"]
    >().toEqualTypeOf<"runner">();
    expectTypeOf<
      RunnerReadinessReceiptEnvelopeV1["producer"]["credentialId"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      RunnerReadinessReceiptEnvelopeV1["producer"]["registrationGeneration"]
    >().toEqualTypeOf<number>();
  });

  it("preserves each callback receipt kind as a concrete literal type", () => {
    expectTypeOf<
      typeof CallbackIntentObservationReceiptEnvelopeV1Schema._output.receiptKind
    >().toEqualTypeOf<"callback_intent_observation">();
    expectTypeOf<
      typeof CallbackAttemptObservationReceiptEnvelopeV1Schema._output.receiptKind
    >().toEqualTypeOf<"callback_attempt_observation">();
    expectTypeOf<
      typeof CallbackProviderObservationReceiptEnvelopeV1Schema._output.receiptKind
    >().toEqualTypeOf<"callback_provider_observation">();
    expectTypeOf<typeof CallbackProviderV1Schema._output>().toEqualTypeOf<"github">();
    expectTypeOf<typeof CallbackNextActionV1Schema._output>().toEqualTypeOf<"reconcile-provider">();
    expectTypeOf<typeof CallbackOpaqueStableIdV1Schema._output>().toEqualTypeOf<string>();
  });

  it("accepts an executor-neutral, locally authored completion assessment", () => {
    expect(CompletionAssessmentReceiptEnvelopeV1Schema.safeParse(assessmentReceipt()).success).toBe(true);
  });

  it("uses the Run-scoped attempt number as the receipt fencing epoch", () => {
    const receipt = assessmentReceipt();
    expect(
      CompletionAssessmentReceiptEnvelopeV1Schema.safeParse({
        ...receipt,
        attempt: { ...receipt.attempt, epoch: 2 },
        payload: {
          ...receipt.payload,
          attempt: { ...receipt.payload.attempt, epoch: 2 },
        },
      }).success,
    ).toBe(false);
    expect(
      CompletionAssessmentReceiptEnvelopeV1Schema.safeParse({
        ...receipt,
        attempt: { ...receipt.attempt, attemptNumber: 2 },
        payload: {
          ...receipt.payload,
          attempt: { ...receipt.payload.attempt, attemptNumber: 2 },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown envelope and payload fields", () => {
    const receipt = assessmentReceipt();
    expect(CompletionAssessmentReceiptEnvelopeV1Schema.safeParse({ ...receipt, metadata: {} }).success).toBe(false);
    expect(
      CompletionAssessmentReceiptEnvelopeV1Schema.safeParse({
        ...receipt,
        payload: { ...receipt.payload, executorResult: "success" },
      }).success,
    ).toBe(false);
  });

  it.each(["sha256:abc", `SHA256:${"a".repeat(64)}`, `sha256:${"G".repeat(64)}`])(
    "rejects invalid digest %s",
    (invalidDigest) => {
      expect(ReceiptDigestSchema.safeParse(invalidDigest).success).toBe(false);
    },
  );

  it("rejects unsorted/duplicate evidence digests and a mismatched kind capability", () => {
    const receipt = assessmentReceipt();
    expect(
      CompletionAssessmentReceiptEnvelopeV1Schema.safeParse({
        ...receipt,
        payload: { ...receipt.payload, evidenceReceiptDigests: [otherDigest, digest] },
      }).success,
    ).toBe(false);
    expect(
      CompletionAssessmentReceiptEnvelopeV1Schema.safeParse({
        ...receipt,
        requiredCapabilities: ["relay.lifecycle.v1"],
      }).success,
    ).toBe(false);
  });

  it("rejects a stable identity tuple that does not match the assessment refs", () => {
    const receipt = assessmentReceipt();
    expect(
      CompletionAssessmentReceiptEnvelopeV1Schema.safeParse({
        ...receipt,
        identity: { ...receipt.identity, parts: ["org_1", "wt_other", "assessment_1"] },
      }).success,
    ).toBe(false);
    expect(
      CompletionAssessmentReceiptEnvelopeV1Schema.safeParse({
        ...receipt,
        identity: { ...receipt.identity, parts: [" org_1", "wt_1", "assessment_1"] },
      }).success,
    ).toBe(false);
  });

  it("keeps readiness refs credential- and path-free", () => {
    const readiness = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      receiptKind: "runner_readiness",
      receiptId: "readiness_receipt_1",
      organizationId: "org_1",
      operationId: "op_readiness_1",
      requiredCapabilities: ["relay.readiness.v1"],
      producer: {
        kind: "runner",
        id: "runner_1",
        credentialId: "runtime_credential_1",
        registrationGeneration: 1,
      },
      identity: {
        namespace: "opentag.control.receipt/runner-readiness/v1",
        parts: ["org_1", "runner_1", "1", "readiness_1"],
      },
      observedAt,
      payload: {
        readinessId: "readiness_1",
        runnerId: "runner_1",
        registrationGeneration: 1,
        capabilities: ["relay.lifecycle.v1", "relay.readiness.v1"],
        executors: [
          {
            executorId: "executor_acp",
            adapterVersion: "1.2.3",
            capabilityDigest: digest,
            state: "ready",
          },
        ],
        targets: [
          {
            projectTargetId: "target_1",
            bindingDigest: digest,
            state: "ready",
          },
        ],
        observedAt,
        expiresAt: "2026-08-08T00:02:00.000Z",
      },
      payloadDigest: digest,
      receiptDigest: otherDigest,
    } as const;

    expect(RunnerReadinessReceiptEnvelopeV1Schema.safeParse(readiness).success).toBe(true);
    for (const producer of [
      { ...readiness.producer, kind: "local_opentag" },
      { ...readiness.producer, id: "runner_other" },
      { ...readiness.producer, registrationGeneration: 2 },
      { kind: "runner", id: "runner_1", registrationGeneration: 1 },
      { kind: "runner", id: "runner_1", credentialId: "runtime_credential_1" },
    ]) {
      expect(
        RunnerReadinessReceiptEnvelopeV1Schema.safeParse({ ...readiness, producer }).success,
      ).toBe(false);
    }
    expect(
      RunnerReadinessReceiptEnvelopeV1Schema.safeParse({
        ...readiness,
        payload: { ...readiness.payload, workspacePath: "/private/repo" },
      }).success,
    ).toBe(false);
    expect(
      RunnerReadinessReceiptEnvelopeV1Schema.safeParse({
        ...readiness,
        payload: { ...readiness.payload, expiresAt: readiness.payload.observedAt },
      }).success,
    ).toBe(false);
    expect(
      RunnerReadinessReceiptEnvelopeV1Schema.safeParse({
        ...readiness,
        payload: { ...readiness.payload, observedAt: "2026-08-08T00:00:01.000Z" },
      }).success,
    ).toBe(false);
    expect(
      RunnerReadinessReceiptEnvelopeV1Schema.safeParse({
        ...readiness,
        payload: {
          ...readiness.payload,
          executors: [{ ...readiness.payload.executors[0], state: "blocked", reasonCode: "made_up_reason" }],
        },
      }).success,
    ).toBe(false);
    for (const collectionName of ["executors", "targets"] as const) {
      expect(
        RunnerReadinessReceiptEnvelopeV1Schema.safeParse({
          ...readiness,
          payload: {
            ...readiness.payload,
            [collectionName]: [
              {
                ...readiness.payload[collectionName][0],
                reasonCode: "executor_unavailable",
              },
            ],
          },
        }).success,
      ).toBe(false);
    }
  });

  it("keeps policy snapshots executor-neutral and free of policy bodies", () => {
    const policy = {
      snapshotId: "policy_1",
      capturedAt: observedAt,
      tenant: { organizationId: "org_1" },
      actor: {
        provider: "github",
        providerUserId: "1001",
        login: "operator",
        authorizationRef: "actor_grant_1",
      },
      target: {
        projectTargetId: "target_1",
        bindingId: "binding_1",
        providerRepositoryId: "123",
        defaultBranch: "main",
      },
      runner: { runnerId: "runner_1", readinessReceiptDigest: digest },
      executor: { executorId: "executor_acp", capabilityDigest: digest },
      requiredRelayCapabilities: ["relay.lifecycle.v1"],
      admissionRules: {
        profile: "github-pr-exact-head/v1",
        requiredCheckNames: ["test", "typecheck"],
        mergeRequired: false,
        humanApprovalRequiredFor: ["merge"],
      },
    } as const;

    expect(AdmissionPolicySnapshotPayloadV1Schema.safeParse(policy).success).toBe(true);
    expect(
      AdmissionPolicySnapshotPayloadV1Schema.safeParse({
        ...policy,
        completionContract: { conclusion: "satisfied" },
      }).success,
    ).toBe(false);
  });

  it("projects only contract refs and digests, never contract content", () => {
    const contractRef = {
      contractId: "contract_1",
      version: 1,
      cycle: 1,
      mode: "governed",
      contentDigest: digest,
      resolvedTargetDigests: [digest],
      requiredGateIds: ["checks", "merge"],
      createdAt: observedAt,
    } as const;

    expect(CompletionContractRefPayloadV1Schema.safeParse(contractRef).success).toBe(true);
    expect(
      CompletionContractRefPayloadV1Schema.safeParse({
        ...contractRef,
        contract: { gates: [] },
      }).success,
    ).toBe(false);
  });

  it("keeps callback observations append-only, sanitized, and honest about unknown outcomes", () => {
    const intent = {
      localIntentId: "intent_1",
      assessmentRef: "assessment_1",
      assessmentDigest: digest,
      provider: "github",
      sourceThreadIdentityDigest: digest,
      operationId: "op_callback_1",
      payloadDigest: digest,
      createdAt: observedAt,
    } as const;

    expect(CallbackIntentObservationPayloadV1Schema.safeParse(intent).success).toBe(true);
    expect(
      CallbackIntentObservationPayloadV1Schema.safeParse({
        ...intent,
        callbackUri: "https://provider.example/callback",
        body: "rendered callback",
      }).success,
    ).toBe(false);
    expect(
      CallbackProviderObservationPayloadV1Schema.safeParse({
        localIntentId: "intent_1",
        localAttemptId: "callback_attempt_1",
        providerReceiptId: "comment_1",
        resourceIdentity: "github:comment:1",
        outcome: "outcome_unknown",
        observedAt,
      }).success,
    ).toBe(false);
    expect(
      CallbackProviderObservationPayloadV1Schema.safeParse({
        localIntentId: "intent_1",
        localAttemptId: "callback_attempt_1",
        providerReceiptId: "comment_1",
        resourceIdentity: "github:comment:1",
        outcome: "outcome_unknown",
        observedAt,
        reasonCode: "provider_timeout",
        nextAction: "reconcile-provider",
        owner: "local_opentag",
      }).success,
    ).toBe(true);
  });

  it("validates callback attempt unknown metadata, reason registry, and timestamp ordering", () => {
    const attempt = {
      localIntentId: "intent_1",
      localAttemptId: "callback_attempt_1",
      attemptNumber: 1,
      requestDigest: digest,
      outcome: "outcome_unknown",
      reasonCode: "provider_timeout",
      nextAction: "reconcile-provider",
      owner: "local_opentag",
      attemptedAt: "2026-08-08T00:00:00.000Z",
      observedAt: "2026-08-08T00:00:01.000Z",
    } as const;

    expect(CallbackAttemptObservationPayloadV1Schema.safeParse(attempt).success).toBe(true);
    expect(
      CallbackAttemptObservationPayloadV1Schema.safeParse({ ...attempt, nextAction: undefined }).success,
    ).toBe(false);
    expect(
      CallbackAttemptObservationPayloadV1Schema.safeParse({ ...attempt, owner: undefined }).success,
    ).toBe(false);
    expect(
      CallbackAttemptObservationPayloadV1Schema.safeParse({
        ...attempt,
        observedAt: "2026-08-07T23:59:59.999Z",
      }).success,
    ).toBe(false);
    expect(
      CallbackAttemptObservationPayloadV1Schema.safeParse({ ...attempt, reasonCode: "made_up_reason" }).success,
    ).toBe(false);
    expect(
      CallbackAttemptObservationPayloadV1Schema.safeParse({ ...attempt, reasonCode: "provider_accepted" }).success,
    ).toBe(false);
    expect(
      CallbackAttemptObservationPayloadV1Schema.safeParse({
        ...attempt,
        outcome: "accepted",
        reasonCode: "provider_accepted",
        nextAction: undefined,
        owner: undefined,
      }).success,
    ).toBe(true);
    expect(
      CallbackProviderObservationPayloadV1Schema.safeParse({
        localIntentId: "intent_1",
        localAttemptId: "callback_attempt_1",
        providerReceiptId: "comment_1",
        resourceIdentity: "github:comment:1",
        outcome: "succeeded",
        reasonCode: "provider_error",
        observedAt,
      }).success,
    ).toBe(false);
    expect(CallbackObservationReasonCodeV1Schema.safeParse("provider_timeout").success).toBe(true);
    expect(RunnerReadinessReasonCodeV1Schema.safeParse("made_up_reason").success).toBe(false);
  });

  it("rejects callback custody, credentials, paths, commands, and unregistered literals", () => {
    const intent = {
      localIntentId: "intent_1",
      assessmentRef: "assessment_1",
      assessmentDigest: digest,
      provider: "github",
      sourceThreadIdentityDigest: digest,
      operationId: "op_callback_1",
      payloadDigest: digest,
      createdAt: observedAt,
    } as const;
    const attempt = {
      localIntentId: "intent_1",
      localAttemptId: "callback_attempt_1",
      attemptNumber: 1,
      requestDigest: digest,
      outcome: "accepted",
      reasonCode: "provider_accepted",
      attemptedAt: observedAt,
      observedAt,
    } as const;
    const provider = {
      localIntentId: "intent_1",
      localAttemptId: "callback_attempt_1",
      providerReceiptId: "comment_1",
      resourceIdentity: "github:comment:1",
      outcome: "succeeded",
      reasonCode: "provider_accepted",
      observedAt,
    } as const;

    expect(CallbackIntentObservationPayloadV1Schema.safeParse({ ...intent, provider: "gitlab" }).success).toBe(false);
    expect(CallbackAttemptObservationPayloadV1Schema.safeParse({
      ...attempt,
      nextAction: "upload-callback-body",
    }).success).toBe(false);
    for (const resourceIdentity of [
      "gitlab:issue:42",
      "github:pull-request:42",
      "github:issue:https://github.com/example/repo/issues/42",
      "github:issue:42?token=secret",
      "github:comment:42#body",
      "github:issue:42\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "github:issue:nested_github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "github:issue:nested-github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "github:comment:nested_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
      "github:comment:nested-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    ]) {
      expect(
        CallbackProviderObservationPayloadV1Schema.safeParse({ ...provider, resourceIdentity }).success,
        resourceIdentity,
      ).toBe(false);
    }
    for (const resourceIdentity of [
      "github:issue:issue_1",
      "github:comment:comment-1",
      "github:comment:nested_comment_1",
    ]) {
      expect(
        CallbackProviderObservationPayloadV1Schema.safeParse({ ...provider, resourceIdentity }).success,
        resourceIdentity,
      ).toBe(true);
    }

    const unsafeReferences = [
      "https://example.test/callback?token=secret",
      '{"body":"callback"}',
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "Bearer abcdefghijklmnopqrstuvwxyz",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "/tmp/callback-receipt",
      "../callback-receipt",
      "curl https://example.test/callback",
      "callback; rm -rf workspace",
      "callback$(whoami)",
      "callback\r\nnext-header: value",
    ] as const;
    for (const unsafeReference of unsafeReferences) {
      expect(
        CallbackIntentObservationPayloadV1Schema.safeParse({ ...intent, localIntentId: unsafeReference }).success,
        `localIntentId: ${unsafeReference}`,
      ).toBe(false);
      expect(
        CallbackAttemptObservationPayloadV1Schema.safeParse({ ...attempt, localAttemptId: unsafeReference }).success,
        `localAttemptId: ${unsafeReference}`,
      ).toBe(false);
      expect(
        CallbackProviderObservationPayloadV1Schema.safeParse({
          ...provider,
          providerReceiptId: unsafeReference,
        }).success,
        `providerReceiptId: ${unsafeReference}`,
      ).toBe(false);
    }
    for (const credentialLikeReference of [
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    ]) {
      expect(
        CallbackIntentObservationPayloadV1Schema.safeParse({
          ...intent,
          localIntentId: `intent-${credentialLikeReference}`,
        }).success,
      ).toBe(false);
      expect(
        CallbackAttemptObservationPayloadV1Schema.safeParse({
          ...attempt,
          localAttemptId: `callback-attempt-${credentialLikeReference}`,
        }).success,
      ).toBe(false);
      expect(
        CallbackProviderObservationPayloadV1Schema.safeParse({
          ...provider,
          providerReceiptId: `provider-receipt-${credentialLikeReference}`,
        }).success,
      ).toBe(false);
    }
    for (const [field, value] of [
      ["localIntentId", "intent_github_pat_abcdefghijklmnopqrstuvwxyz123456"],
      [
        "localIntentId",
        "intent_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
      ],
      ["localAttemptId", "callback_attempt_ghp_abcdefghijklmnopqrstuvwxyz"],
      ["providerReceiptId", "provider_receipt_github_pat_abcdefghijklmnopqrstuvwxyz123456"],
      [
        "localAttemptId",
        "callback-attempt_nested_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
      ],
      [
        "providerReceiptId",
        "provider_receipt_nested_github_pat_abcdefghijklmnopqrstuvwxyz123456",
      ],
    ] as const) {
      const schema = field === "localIntentId"
        ? CallbackIntentObservationPayloadV1Schema
        : field === "localAttemptId"
          ? CallbackAttemptObservationPayloadV1Schema
          : CallbackProviderObservationPayloadV1Schema;
      const source = field === "localIntentId" ? intent : field === "localAttemptId" ? attempt : provider;
      expect(schema.safeParse({ ...source, [field]: value }).success, `${field}: ${value}`).toBe(false);
    }
    expect(CallbackIntentObservationPayloadV1Schema.safeParse(intent).success).toBe(true);
    expect(CallbackAttemptObservationPayloadV1Schema.safeParse(attempt).success).toBe(true);
    expect(CallbackProviderObservationPayloadV1Schema.safeParse(provider).success).toBe(true);
    expect(CallbackIntentObservationPayloadV1Schema.safeParse({ ...intent, localIntentId: "callback_1" }).success).toBe(false);
    expect(CallbackAttemptObservationPayloadV1Schema.safeParse({ ...attempt, localAttemptId: "attempt_1" }).success).toBe(false);
    expect(CallbackProviderObservationPayloadV1Schema.safeParse({
      ...provider,
      providerReceiptId: "receipt_1",
    }).success).toBe(false);
  });

  it("binds callback attempt and provider observation times to their envelopes", () => {
    const baseEnvelope = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      organizationId: "org_1",
      operationId: "op_callback_1",
      requiredCapabilities: ["relay.callback-observation.v1"],
      runId: "run_1",
      workThreadId: "wt_1",
      producer: {
        kind: "local_opentag",
        id: "runner_1",
        credentialId: "runtime_credential_1",
        registrationGeneration: 1,
      },
      observedAt,
      payloadDigest: digest,
      receiptDigest: otherDigest,
    } as const;
    const intentEnvelope = {
      ...baseEnvelope,
      receiptKind: "callback_intent_observation",
      receiptId: "callback_intent_receipt_1",
      identity: {
        namespace: "opentag.control.receipt/callback-intent-observation/v1",
        parts: ["org_1", "wt_1", "intent_1"],
      },
      payload: {
        localIntentId: "intent_1",
        assessmentRef: "assessment_1",
        assessmentDigest: digest,
        provider: "github",
        sourceThreadIdentityDigest: digest,
        operationId: baseEnvelope.operationId,
        payloadDigest: digest,
        createdAt: observedAt,
      },
    } as const;
    const attemptEnvelope = {
      ...baseEnvelope,
      receiptKind: "callback_attempt_observation",
      receiptId: "callback_attempt_receipt_1",
      identity: {
        namespace: "opentag.control.receipt/callback-attempt-observation/v1",
        parts: ["org_1", "wt_1", "intent_1", "callback_attempt_1"],
      },
      payload: {
        localIntentId: "intent_1",
        localAttemptId: "callback_attempt_1",
        attemptNumber: 1,
        requestDigest: digest,
        outcome: "accepted",
        reasonCode: "provider_accepted",
        attemptedAt: observedAt,
        observedAt,
      },
    } as const;
    const providerEnvelope = {
      ...baseEnvelope,
      receiptKind: "callback_provider_observation",
      receiptId: "callback_provider_receipt_1",
      identity: {
        namespace: "opentag.control.receipt/callback-provider-observation/v1",
        parts: ["org_1", "wt_1", "intent_1", "callback_attempt_1", "comment_1"],
      },
      payload: {
        localIntentId: "intent_1",
        localAttemptId: "callback_attempt_1",
        providerReceiptId: "comment_1",
        resourceIdentity: "github:comment:1",
        outcome: "succeeded",
        reasonCode: "provider_accepted",
        observedAt,
      },
    } as const;

    expect(CallbackIntentObservationReceiptEnvelopeV1Schema.safeParse(intentEnvelope).success).toBe(true);
    expect(CallbackAttemptObservationReceiptEnvelopeV1Schema.safeParse(attemptEnvelope).success).toBe(true);
    expect(CallbackProviderObservationReceiptEnvelopeV1Schema.safeParse(providerEnvelope).success).toBe(true);
    for (const [schema, envelope] of [
      [CallbackIntentObservationReceiptEnvelopeV1Schema, intentEnvelope],
      [CallbackAttemptObservationReceiptEnvelopeV1Schema, attemptEnvelope],
      [CallbackProviderObservationReceiptEnvelopeV1Schema, providerEnvelope],
    ] as const) {
      for (const [field, unsafeId] of [
        ["receiptId", "receipt_github_pat_abcdefghijklmnopqrstuvwxyz123456"],
        [
          "operationId",
          "operation_nested_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
        ],
        ["receiptId", "https://example.test/callback?token=secret"],
        ["operationId", "/tmp/callback-operation"],
        ["receiptId", "../callback-receipt"],
        ["operationId", '{"body":"callback"}'],
        ["receiptId", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
        ["operationId", "callback; curl https://example.test/upload"],
        ["receiptId", "callback\r\nX-Token: secret"],
      ] as const) {
        const changed = { ...envelope, [field]: unsafeId };
        const candidate = envelope.receiptKind === "callback_intent_observation" && field === "operationId"
          ? { ...changed, payload: { ...envelope.payload, operationId: unsafeId } }
          : changed;
        expect(schema.safeParse(candidate).success, `${envelope.receiptKind} ${field}: ${unsafeId}`).toBe(false);
      }
    }
    const unknownAttemptEnvelope = {
      ...attemptEnvelope,
      payload: {
        ...attemptEnvelope.payload,
        outcome: "outcome_unknown",
        reasonCode: "provider_timeout",
        nextAction: "reconcile-provider",
        owner: attemptEnvelope.producer.id,
      },
    } as const;
    expect(CallbackAttemptObservationReceiptEnvelopeV1Schema.safeParse(unknownAttemptEnvelope).success).toBe(true);
    expect(
      CallbackAttemptObservationReceiptEnvelopeV1Schema.safeParse({
        ...unknownAttemptEnvelope,
        payload: { ...unknownAttemptEnvelope.payload, owner: "different-local-owner" },
      }).success,
    ).toBe(false);
    const unknownProviderEnvelope = {
      ...providerEnvelope,
      payload: {
        ...providerEnvelope.payload,
        outcome: "outcome_unknown",
        reasonCode: "provider_receipt_missing",
        nextAction: "reconcile-provider",
        owner: providerEnvelope.producer.id,
      },
    } as const;
    expect(CallbackProviderObservationReceiptEnvelopeV1Schema.safeParse(unknownProviderEnvelope).success).toBe(true);
    expect(
      CallbackProviderObservationReceiptEnvelopeV1Schema.safeParse({
        ...unknownProviderEnvelope,
        payload: { ...unknownProviderEnvelope.payload, owner: "different-local-owner" },
      }).success,
    ).toBe(false);
    expect(
      CallbackAttemptObservationReceiptEnvelopeV1Schema.safeParse({
        ...attemptEnvelope,
        payload: { ...attemptEnvelope.payload, observedAt: "2026-08-08T00:00:01.000Z" },
      }).success,
    ).toBe(false);
    expect(
      CallbackProviderObservationReceiptEnvelopeV1Schema.safeParse({
        ...providerEnvelope,
        payload: { ...providerEnvelope.payload, observedAt: "2026-08-08T00:00:01.000Z" },
      }).success,
    ).toBe(false);
  });
});
