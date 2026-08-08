import { describe, expect, it } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_SCHEMA_VERSION,
  AdmissionPolicySnapshotPayloadV1Schema,
  CallbackIntentObservationPayloadV1Schema,
  CallbackProviderObservationPayloadV1Schema,
  CompletionContractRefPayloadV1Schema,
  CompletionAssessmentReceiptEnvelopeV1Schema,
  ControlMutationRequestV1Schema,
  ControlHttpResponseV1Schema,
  ReceiptDigestSchema,
  NpmPackageVersionSchema,
  RelayCapabilitiesResponseV1Schema,
  RunnerCredentialReprovisionRequestV1Schema,
  RunnerCredentialResponseV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  RunnerRegistrationRequestV1Schema,
  RunnerRegistrationResponseV1Schema,
  type CompletionAssessmentReceiptEnvelopeV1,
} from "../src/control-protocol.js";

const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const observedAt = "2026-08-08T00:00:00.000Z";

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
          reasonCode: "required_checks_passed",
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
      }).artifact.packageVersion,
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

describe("OpenTag Control V1 status semantics", () => {
  it.each([
    {
      status: 202,
      state: "waiting",
      requestId: "req_1",
      resolutionRef: "permission_1",
      nextAction: "wait_for_operator",
    },
    { status: 404, error: "missing_or_concealed", message: "Resource not found.", requestId: "req_1" },
    { status: 409, error: "stale_attempt", message: "The attempt fence is stale.", requestId: "req_1" },
    {
      status: 412,
      error: "capability_required",
      message: "Required capability is unavailable.",
      requestId: "req_1",
      requiredCapabilities: ["relay.lifecycle.v1"],
    },
    {
      status: 426,
      error: "protocol_upgrade_required",
      message: "Upgrade the control protocol.",
      requestId: "req_1",
      supported: { schemaVersions: [1], protocolVersions: ["1.0"] },
      nextAction: "upgrade_client",
    },
  ])("accepts the normalized $status response shape", (response) => {
    expect(
      ControlHttpResponseV1Schema.safeParse({
        status: response.status,
        body: {
          schemaVersion: 1,
          protocolVersion: "1.0",
          ...Object.fromEntries(Object.entries(response).filter(([key]) => key !== "status")),
        },
      }).success,
    ).toBe(true);
  });

  it("does not let a 202 waiting receipt claim authorization", () => {
    expect(
      ControlHttpResponseV1Schema.safeParse({
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
    expect(
      RunnerCredentialReprovisionRequestV1Schema.safeParse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.credential-reprovision.v1"],
        requestId: "req_recover_1",
        operationId: "op_recover_1",
        runnerId: "runner_1",
        expectedRegistrationGeneration: 1,
        expectedCredentialGeneration: 1,
      }).success,
    ).toBe(true);
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
  });
});

describe("ReceiptEnvelope V1", () => {
  it("accepts an executor-neutral, locally authored completion assessment", () => {
    expect(CompletionAssessmentReceiptEnvelopeV1Schema.safeParse(assessmentReceipt()).success).toBe(true);
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
    expect(
      RunnerReadinessReceiptEnvelopeV1Schema.safeParse({
        ...readiness,
        payload: { ...readiness.payload, workspacePath: "/private/repo" },
      }).success,
    ).toBe(false);
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
        nextAction: "reconcile_provider_receipt",
        owner: "local_opentag",
      }).success,
    ).toBe(true);
  });
});
