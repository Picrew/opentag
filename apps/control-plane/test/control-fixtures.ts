import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeHostedAdmissionEnvelopeDigestV1,
  HostedAdmissionEnvelopeV1Schema,
  HostedClaimRequestV1Schema,
} from "@opentag/control-protocol";
import type { Pool } from "pg";

export const HOSTED_CAPABILITIES = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
] as const;

const digest = (character: string) => `sha256:${character.repeat(64)}`;

export async function recordHostedReadiness(input: {
  pool: Pick<Pool, "query">;
  organizationId: string;
  runnerId: string;
  receiptId?: string;
  receiptDigest?: string;
}) {
  await input.pool.query(
    `INSERT INTO cp_runner_readiness(
       organization_id, runner_id, receipt_id, receipt_digest, observed_at,
       expires_at, receipt
     ) VALUES($1, $2, $3, $4, $5, $6, '{}'::jsonb)
     ON CONFLICT (organization_id, receipt_id) DO NOTHING`,
    [
      input.organizationId,
      input.runnerId,
      input.receiptId ?? "readiness_receipt_hosted",
      input.receiptDigest ?? digest("a"),
      "2026-08-15T07:00:00.000Z",
      "2030-08-15T07:00:00.000Z",
    ],
  );
}

export async function hostedAdmissionFixture(input: {
  runId: string;
  suffix: string;
  organizationId?: string;
  runnerId?: string;
}) {
  const organizationId = input.organizationId ?? "org_hosted";
  const runnerId = input.runnerId ?? "runner_hosted";
  const observedAt = "2026-08-15T07:00:00.000Z";
  const readinessDigest = digest("a");
  const policyPayload = {
    snapshotId: `policy_${input.suffix}`,
    capturedAt: observedAt,
    tenant: { organizationId },
    actor: {
      provider: "github",
      providerUserId: "1001",
      login: "octocat",
      authorizationRef: `grant_${input.suffix}`,
    },
    target: {
      projectTargetId: `target_${input.suffix}`,
      bindingId: `binding_${input.suffix}`,
      providerRepositoryId: "123",
      defaultBranch: "main",
    },
    runner: { runnerId, readinessReceiptDigest: readinessDigest },
    executor: {
      executorId: "executor_acp",
      capabilityDigest: digest("b"),
    },
    requiredRelayCapabilities: HOSTED_CAPABILITIES,
    admissionRules: {
      profile: "github-pr-exact-head/v1",
      requiredCheckNames: ["test"],
      mergeRequired: false,
      humanApprovalRequiredFor: ["merge"],
    },
  };
  const policySeed = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptId: `policy_receipt_${input.suffix}`,
    organizationId,
    operationId: `operation_admit_${input.suffix}`,
    requiredCapabilities: HOSTED_CAPABILITIES,
    producer: { kind: "cloud" as const, id: "control_plane" },
    identity: {
      namespace: "opentag.control.receipt/admission-policy-snapshot/v1" as const,
      parts: [organizationId, input.runId, policyPayload.snapshotId],
    },
    observedAt,
    payloadDigest: await computeControlPayloadDigestV1(policyPayload),
    receiptDigest: digest("0"),
    receiptKind: "admission_policy_snapshot" as const,
    runId: input.runId,
    payload: policyPayload,
  };
  const { receiptDigest: _ignored, ...policyDigestInput } = policySeed;
  const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse({
    ...policySeed,
    receiptDigest: await computeControlReceiptDigestV1(policyDigestInput),
  });
  const admissionSeed = {
    kind: "hosted_admission" as const,
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.hosted-admission.v1"] as const,
    admissionId: `admission_${input.suffix}`,
    operationId: policy.operationId,
    organizationId,
    bindingId: policyPayload.target.bindingId,
    bindingSecretVersion: "secret-v1",
    provider: "github" as const,
    deliveryId: `delivery_${input.suffix}`,
    deliveryPayloadDigest: digest("c"),
    sourceIdentityDigest: digest(input.suffix.slice(0, 1).toLowerCase()),
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
      providerEventId: `${700 + Number.parseInt(input.suffix.replace(/\D/gu, "") || "1", 10)}`,
      kind: "issue_comment" as const,
    },
    verifiedActor: {
      providerUserId: "1001",
      login: "octocat",
      authorization: {
        decision: "allowed" as const,
        grantRef: policyPayload.actor.authorizationRef,
        grantVersion: 1,
        grantDigest: digest("d"),
      },
    },
    projectTarget: {
      projectTargetId: policyPayload.target.projectTargetId,
      version: 1,
      digest: digest("e"),
    },
    runnerId,
    admissionPolicySnapshot: {
      snapshotId: policyPayload.snapshotId,
      digest: policy.receiptDigest,
    },
    receivedAt: observedAt,
    envelopeDigest: digest("0"),
  };
  const admission = HostedAdmissionEnvelopeV1Schema.parse({
    ...admissionSeed,
    envelopeDigest: await computeHostedAdmissionEnvelopeDigestV1(admissionSeed),
  });
  return { admission, policy, readinessDigest };
}

export function hostedClaimRequest(input: {
  operationId: string;
  requestId: string;
  credentialId?: string;
  readinessDigest?: string;
}) {
  return HostedClaimRequestV1Schema.parse({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: HOSTED_CAPABILITIES,
    requestId: input.requestId,
    operationId: input.operationId,
    expectedAuthority: {
      credentialId: input.credentialId ?? "credential_hosted",
      registrationGeneration: 1,
      credentialGeneration: 1,
      runnerReadinessReceiptId: "readiness_receipt_hosted",
      runnerReadinessReceiptDigest: input.readinessDigest ?? digest("a"),
    },
  });
}
