import { createHash } from "node:crypto";
import {
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeHostedAdmissionEnvelopeDigestV1,
} from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createOpenTagClient } from "../src/index.js";

const digest = `sha256:${"1".repeat(64)}`;
const otherDigest = `sha256:${"2".repeat(64)}`;
const hostedClaimCapabilities = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
] as const;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hostedClaimRequest() {
  return {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: hostedClaimCapabilities,
    requestId: "request_claim_1",
    operationId: "operation_claim_1",
    expectedAuthority: {
      credentialId: "credential_runtime_1",
      registrationGeneration: 3,
      credentialGeneration: 2,
      runnerReadinessReceiptId: "readiness_receipt_1",
      runnerReadinessReceiptDigest: digest,
    },
  };
}

async function hostedClaim() {
  const fencingToken = "hosted_fence_secret";
  const claim = {
    kind: "hosted_claim" as const,
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: hostedClaimCapabilities,
    requestId: "request_claim_1",
    operationId: "operation_claim_1",
    organizationId: "org_1",
    runnerId: "runner_1",
    runId: "run_1",
    executorId: "executor_acp",
    hostedAdmission: {
      kind: "hosted_admission" as const,
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.hosted-admission.v1"] as const,
      admissionId: "admission_1",
      operationId: "operation_admission_1",
      organizationId: "org_1",
      bindingId: "binding_1",
      bindingSecretVersion: "secret-v3",
      provider: "github" as const,
      deliveryId: "delivery_1",
      deliveryPayloadDigest: digest,
      sourceIdentityDigest: digest,
      eventName: "issue_comment" as const,
      action: "created" as const,
      repository: {
        providerRepositoryId: "123",
        owner: "acme",
        repo: "demo",
      },
      sourceThread: {
        kind: "issue" as const,
        providerThreadId: "456",
        number: 7,
      },
      sourceEvent: {
        providerEventId: "789",
        kind: "issue_comment" as const,
      },
      verifiedActor: {
        providerUserId: "1001",
        login: "octocat",
        authorization: {
          decision: "allowed" as const,
          grantRef: "grant_1",
          grantVersion: 1,
          grantDigest: digest,
        },
      },
      projectTarget: {
        projectTargetId: "target_1",
        version: 1,
        digest,
      },
      runnerId: "runner_1",
      admissionPolicySnapshot: {
        snapshotId: "policy_1",
        digest: otherDigest,
      },
      receivedAt: "2026-08-08T00:00:00.000Z",
      envelopeDigest: digest,
    },
    admissionPolicySnapshot: {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      receiptId: "policy_receipt_1",
      organizationId: "org_1",
      operationId: "operation_admission_1",
      requiredCapabilities: hostedClaimCapabilities,
      producer: { kind: "cloud" as const, id: "cloud_control" },
      identity: {
        namespace: "opentag.control.receipt/admission-policy-snapshot/v1" as const,
        parts: ["org_1", "run_1", "policy_1"],
      },
      observedAt: "2026-08-08T00:00:00.000Z",
      payloadDigest: digest,
      receiptDigest: otherDigest,
      receiptKind: "admission_policy_snapshot" as const,
      runId: "run_1",
      payload: {
        snapshotId: "policy_1",
        capturedAt: "2026-08-08T00:00:00.000Z",
        tenant: { organizationId: "org_1" },
        actor: {
          provider: "github",
          providerUserId: "1001",
          login: "octocat",
          authorizationRef: "grant_1",
        },
        target: {
          projectTargetId: "target_1",
          bindingId: "binding_1",
          providerRepositoryId: "123",
          defaultBranch: "main",
        },
        runner: {
          runnerId: "runner_1",
          readinessReceiptDigest: digest,
        },
        executor: {
          executorId: "executor_acp",
          capabilityDigest: otherDigest,
        },
        requiredRelayCapabilities: hostedClaimCapabilities,
        admissionRules: {
          profile: "github-pr-exact-head/v1",
          requiredCheckNames: ["test"],
          mergeRequired: false,
          humanApprovalRequiredFor: ["merge"],
        },
      },
    },
    attempt: {
      id: "attempt_1",
      number: 1,
      epoch: 1,
      fencingToken,
      fencingTokenDigest: sha256(fencingToken),
      leaseExpiresAt: "2026-08-08T00:02:00.000Z",
    },
    authority: {
      organizationId: "org_1",
      runnerId: "runner_1",
      runId: "run_1",
      credentialId: "credential_runtime_1",
      registrationGeneration: 3,
      credentialGeneration: 2,
      projectTargetId: "target_1",
      bindingId: "binding_1",
      targetBindingDigest: digest,
      admissionPolicyReceiptId: "policy_receipt_1",
      admissionPolicySnapshotId: "policy_1",
      admissionPolicySnapshotDigest: otherDigest,
      runnerReadinessReceiptId: "readiness_receipt_1",
      runnerReadinessReceiptDigest: digest,
      targetReadinessReceiptId: "readiness_receipt_1",
      targetReadinessReceiptDigest: digest,
      executorId: "executor_acp",
      executorCapabilityDigest: otherDigest,
      attemptId: "attempt_1",
      attemptNumber: 1,
      epoch: 1,
      fencingTokenDigest: sha256(fencingToken),
    },
  };
  claim.admissionPolicySnapshot.payloadDigest =
    await computeControlPayloadDigestV1(claim.admissionPolicySnapshot.payload);
  const { receiptDigest: _receiptDigest, ...policyReceiptDigestInput } =
    claim.admissionPolicySnapshot;
  claim.admissionPolicySnapshot.receiptDigest =
    await computeControlReceiptDigestV1(policyReceiptDigestInput);
  claim.hostedAdmission.admissionPolicySnapshot.digest =
    claim.admissionPolicySnapshot.receiptDigest;
  claim.authority.admissionPolicySnapshotDigest =
    claim.admissionPolicySnapshot.receiptDigest;
  claim.hostedAdmission.envelopeDigest =
    await computeHostedAdmissionEnvelopeDigestV1(claim.hostedAdmission);
  return claim;
}

function response(body: unknown, status: number): Response {
  const result = status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
  Object.defineProperty(result, "url", {
    value: "https://control.example/v1/runners/runner_1/hosted-claims",
  });
  return result;
}

function client(fetchImpl: typeof fetch) {
  return createOpenTagClient({
    dispatcherUrl: "https://control.example",
    controlCredential: { kind: "runtime", token: "runtime_secret" },
    fetchImpl,
  });
}

describe("claimHostedRunControlV1", () => {
  it("uses only the hosted claim endpoint and maps 204 to null", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(undefined, 204));
    await expect(client(fetchImpl).claimHostedRunControlV1({
      runnerId: "runner_1",
      request: hostedClaimRequest(),
    })).resolves.toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://control.example/v1/runners/runner_1/hosted-claims",
    );
    expect(String(url)).not.toMatch(/\/claim$/u);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer runtime_secret",
    );
    expect(JSON.parse(String(init?.body))).toEqual(hostedClaimRequest());
  });

  it("strictly parses and returns a linked 200 claim", async () => {
    const claim = await hostedClaim();
    const fetchImpl = vi.fn<typeof fetch>(async () => response(claim, 200));
    await expect(client(fetchImpl).claimHostedRunControlV1({
      runnerId: "runner_1",
      request: hostedClaimRequest(),
    })).resolves.toEqual(claim);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a malformed or mismatched claim", async () => {
    const claim = await hostedClaim();
    const badFenceClaim = await hostedClaim();
    for (const body of [
      { ...claim, rawBody: "@opentag secret" },
      { ...claim, operationId: "other_operation" },
      {
        ...badFenceClaim,
        attempt: { ...badFenceClaim.attempt, fencingTokenDigest: digest },
        authority: { ...badFenceClaim.authority, fencingTokenDigest: digest },
      },
    ]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => response(body, 200));
      await expect(client(fetchImpl).claimHostedRunControlV1({
        runnerId: "runner_1",
        request: hostedClaimRequest(),
      })).rejects.toThrow(/invalid_control_v1_response|response_identity_mismatch/iu);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed on admission and policy digest corruption", async () => {
    const claim = await hostedClaim();
    const corruptions = [
      {
        ...claim,
        hostedAdmission: {
          ...claim.hostedAdmission,
          repository: {
            ...claim.hostedAdmission.repository,
            owner: "transferred-owner",
          },
        },
      },
      {
        ...claim,
        admissionPolicySnapshot: {
          ...claim.admissionPolicySnapshot,
          payload: {
            ...claim.admissionPolicySnapshot.payload,
            admissionRules: {
              ...claim.admissionPolicySnapshot.payload.admissionRules,
              profile: "tampered-policy-profile",
            },
          },
        },
      },
      {
        ...claim,
        admissionPolicySnapshot: {
          ...claim.admissionPolicySnapshot,
          producer: {
            ...claim.admissionPolicySnapshot.producer,
            id: "tampered-cloud-producer",
          },
        },
      },
    ];

    for (const body of corruptions) {
      const fetchImpl = vi.fn<typeof fetch>(async () => response(body, 200));
      await expect(client(fetchImpl).claimHostedRunControlV1({
        runnerId: "runner_1",
        request: hostedClaimRequest(),
      })).rejects.toThrow(/invalid_control_v1_response/iu);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("requires a runtime credential before transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const approver = createOpenTagClient({
      dispatcherUrl: "https://control.example",
      controlCredential: { kind: "approver", token: "approver_secret" },
      fetchImpl,
    });
    await expect(approver.claimHostedRunControlV1({
      runnerId: "runner_1",
      request: hostedClaimRequest(),
    })).rejects.toThrow(/required=runtime actual=approver/iu);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not retry or replace the operation after an unknown transport outcome", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("response lost");
    });
    await expect(client(fetchImpl).claimHostedRunControlV1({
      runnerId: "runner_1",
      request: hostedClaimRequest(),
    })).rejects.toThrow(/transport_failed/iu);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      operationId: "operation_claim_1",
    });
  });
});
