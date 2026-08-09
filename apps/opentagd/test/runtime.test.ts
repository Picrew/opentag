import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeHostedAdmissionEnvelopeDigestV1,
  computeHostedClaimFencingTokenDigestV1,
  HostedClaimV1Schema,
  type HostedClaimRequestV1,
} from "@opentag/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenTagDaemonConfig } from "../src/config.js";
import { createDaemonRuntimeInput, pullRequestOptionsFromConfig, securityFromConfig } from "../src/runtime.js";

const config: OpenTagDaemonConfig = {
  runnerId: "runner_local",
  dispatcherUrl: "http://localhost:3030",
  agents: {},
  scratchRoot: "/tmp/opentag-scratch",
  keepScratch: "on_failure",
  repositories: [
    {
      provider: "github",
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo",
      defaultExecutor: "codex",
      baseBranch: "main",
      pushRemote: "origin",
      keepWorktree: "on_failure"
    }
  ],
  security: {
    mode: "enforce",
    allowedWorkspaceRoot: "/tmp",
    allowUnsafePrompts: false,
    extraSafeEnv: ["OPENTAG_DEBUG"]
  },
  githubToken: "ghs_test",
  preparePullRequestBranch: true,
  allowAutoCreatePullRequest: true,
  pairingToken: "pairing_test",
  pollIntervalMs: 1000,
  heartbeatIntervalMs: 15000,
  runTimeoutMs: 30_000
};

const pairedConfig: OpenTagDaemonConfig = {
  ...config,
  runnerId: "runner_hosted",
  dispatcherUrl: "https://control.example",
  pairingToken: undefined,
  runnerToken: "runtime_token",
  repositories: [],
  trustedRelay: {
    schemaVersion: 1,
    origin: "https://control.example",
    authorizedAt: "2026-08-08T00:00:00.000Z",
    authorizationMethod: "explicit_cli",
  },
  controlRegistration: {
    kind: "hosted_control_v1",
    state: "paired",
    operationId: "operation_pair_1",
    registration: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      organizationId: "org_1",
      runnerId: "runner_hosted",
      registrationGeneration: 1,
      credentialGeneration: 1,
      credentialId: "credential_runtime_1",
      credentialPurpose: "runtime",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
  },
};

const hostedClaimCapabilities = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
] as const;
const controlDigest = `sha256:${"1".repeat(64)}`;

async function hostedClaimFixture(request: HostedClaimRequestV1) {
  const observedAt = "2026-08-08T00:00:00.000Z";
  const fencingToken = "hosted_fence_test";
  const executorCapabilityDigest = `sha256:${"2".repeat(64)}`;
  const policyPayload = {
    snapshotId: "policy_1",
    capturedAt: observedAt,
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
      runnerId: "runner_hosted",
      readinessReceiptDigest:
        request.expectedAuthority.runnerReadinessReceiptDigest,
    },
    executor: {
      executorId: "echo",
      capabilityDigest: executorCapabilityDigest,
    },
    requiredRelayCapabilities: hostedClaimCapabilities,
    admissionRules: {
      profile: "github-pr-exact-head/v1",
      requiredCheckNames: ["test"],
      mergeRequired: false,
      humanApprovalRequiredFor: ["merge"],
    },
  } as const;
  const policyBase = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptId: "policy_receipt_1",
    organizationId: "org_1",
    operationId: "admission_operation_1",
    requiredCapabilities: hostedClaimCapabilities,
    producer: { kind: "cloud" as const, id: "cloud_control" },
    identity: {
      namespace:
        "opentag.control.receipt/admission-policy-snapshot/v1" as const,
      parts: ["org_1", "run_1", "policy_1"],
    },
    observedAt,
    payloadDigest: await computeControlPayloadDigestV1(policyPayload),
    receiptKind: "admission_policy_snapshot" as const,
    runId: "run_1",
    payload: policyPayload,
  };
  const policyReceipt = {
    ...policyBase,
    receiptDigest: await computeControlReceiptDigestV1(policyBase),
  };
  const admissionBase = {
    kind: "hosted_admission" as const,
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.hosted-admission.v1"] as const,
    admissionId: "admission_1",
    operationId: "admission_operation_1",
    organizationId: "org_1",
    bindingId: "binding_1",
    bindingSecretVersion: "binding_secret_1",
    provider: "github" as const,
    deliveryId: "delivery_1",
    deliveryPayloadDigest: controlDigest,
    sourceIdentityDigest: controlDigest,
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
        grantDigest: controlDigest,
      },
    },
    projectTarget: {
      projectTargetId: "target_1",
      version: 1,
      digest: controlDigest,
    },
    runnerId: "runner_hosted",
    admissionPolicySnapshot: {
      snapshotId: "policy_1",
      digest: policyReceipt.receiptDigest,
    },
    receivedAt: observedAt,
  };
  const hostedAdmission = {
    ...admissionBase,
    envelopeDigest: await computeHostedAdmissionEnvelopeDigestV1({
      ...admissionBase,
      envelopeDigest: controlDigest,
    }),
  };
  const fencingTokenDigest =
    await computeHostedClaimFencingTokenDigestV1(fencingToken);
  return HostedClaimV1Schema.parse({
    kind: "hosted_claim" as const,
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: hostedClaimCapabilities,
    requestId: request.requestId,
    operationId: request.operationId,
    organizationId: "org_1",
    runnerId: "runner_hosted",
    runId: "run_1",
    executorId: "echo",
    hostedAdmission,
    admissionPolicySnapshot: policyReceipt,
    attempt: {
      id: "attempt_1",
      number: 1,
      epoch: 1,
      fencingToken,
      fencingTokenDigest,
      leaseExpiresAt: "2099-08-08T00:02:00.000Z",
    },
    authority: {
      organizationId: "org_1",
      runnerId: "runner_hosted",
      runId: "run_1",
      credentialId: request.expectedAuthority.credentialId,
      registrationGeneration:
        request.expectedAuthority.registrationGeneration,
      credentialGeneration: request.expectedAuthority.credentialGeneration,
      projectTargetId: "target_1",
      bindingId: "binding_1",
      targetBindingDigest: controlDigest,
      admissionPolicyReceiptId: policyReceipt.receiptId,
      admissionPolicySnapshotId: policyPayload.snapshotId,
      admissionPolicySnapshotDigest: policyReceipt.receiptDigest,
      runnerReadinessReceiptId:
        request.expectedAuthority.runnerReadinessReceiptId,
      runnerReadinessReceiptDigest:
        request.expectedAuthority.runnerReadinessReceiptDigest,
      targetReadinessReceiptId:
        request.expectedAuthority.runnerReadinessReceiptId,
      targetReadinessReceiptDigest:
        request.expectedAuthority.runnerReadinessReceiptDigest,
      executorId: "echo",
      executorCapabilityDigest,
      attemptId: "attempt_1",
      attemptNumber: 1,
      epoch: 1,
      fencingTokenDigest,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opentagd runtime helpers", () => {
  it("normalizes configured runner security policy", () => {
    expect(securityFromConfig(config)).toEqual({
      mode: "enforce",
      allowedWorkspaceRoot: "/tmp",
      allowUnsafePrompts: false,
      extraSafeEnv: ["OPENTAG_DEBUG"]
    });
  });

  it("omits pull request options when GitHub PR creation is not configured", () => {
    const {
      githubToken: _githubToken,
      preparePullRequestBranch: _preparePullRequestBranch,
      allowAutoCreatePullRequest: _allowAutoCreatePullRequest,
      ...configWithoutPullRequests
    } = config;
    expect(pullRequestOptionsFromConfig(configWithoutPullRequests)).toBeUndefined();
  });

  it("creates reusable daemon runtime input from daemon config", () => {
    const input = createDaemonRuntimeInput(config);

    expect(input.runnerId).toBe("runner_local");
    expect(input.repositories).toEqual(config.repositories);
    expect(input.executors.echo.id).toBe("echo");
    expect(input.executors.codex.id).toBe("codex");
    expect(input.executors["claude-code"].id).toBe("claude-code");
    expect(input.security).toEqual(securityFromConfig(config));
    expect(input.pullRequestOptions).toEqual({ githubToken: "ghs_test", preparePullRequestBranch: true, allowAutoCreatePullRequest: true });
    expect(input.pollIntervalMs).toBe(1000);
    expect(input.heartbeatIntervalMs).toBe(15000);
    expect(input.runTimeoutMs).toBe(30_000);
    expect(input.client).toEqual({
      claim: expect.any(Function),
      markRunning: expect.any(Function),
      rejectAttemptStart: expect.any(Function),
      heartbeat: expect.any(Function),
      progress: expect.any(Function),
      complete: expect.any(Function),
      requestActionPermission: expect.any(Function),
      resolveActionPermission: expect.any(Function),
      recordMaterialActionReceipt: expect.any(Function)
    });
  });

  it("fails closed when a paired Control V1 runtime has no authoritative database path", () => {
    expect(() => createDaemonRuntimeInput(pairedConfig)).toThrow(
      /authoritative local dispatcher database path/iu
    );
  });

  it("creates and runs the paired Control V1 context/readiness sidecar with the supplied database path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentagd-control-v1-"));
    const databasePath = join(directory, "opentag.db");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      const pathname = new URL(requestUrl).pathname;
      requests.push(`${init?.method ?? "GET"} ${pathname}`);
      const requestBody = init?.body
        ? JSON.parse(String(init.body))
        : undefined;
      const body = pathname.endsWith("/hosted-claims")
        ? await hostedClaimFixture(requestBody)
        : init?.method === "POST"
          ? requestBody
          : {
            schemaVersion: 1,
            protocolVersion: "1.0",
            contextKind: "runner_control",
            organizationId: "org_1",
            runnerId: "runner_hosted",
            credentialId: "credential_runtime_1",
            registrationGeneration: 1,
            credentialGeneration: 1,
            capabilities: ["relay.readiness.v1"],
            targets: [],
            observedAt: new Date().toISOString(),
          };
      const response = new Response(JSON.stringify(body), {
        status: pathname.endsWith("/hosted-claims")
          ? 200
          : init?.method === "POST"
            ? 201
            : 200,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(response, "url", { value: requestUrl });
      return response;
    }));

    const input = createDaemonRuntimeInput(pairedConfig, { databasePath });
    try {
      expect(input.mode).toBe("control-v1-sidecar");
      if (input.mode !== "control-v1-sidecar") {
        throw new Error("Expected a Control V1 sidecar runtime.");
      }
      expect(input).not.toHaveProperty("client");
      await expect(input.controlLoop.beforeIteration()).rejects.toThrow(
        "hosted_claim_target_mismatch",
      );
      expect(requests).toEqual([
        "GET /v1/runners/runner_hosted/control-context",
        "POST /v1/runners/runner_hosted/readiness",
        "POST /v1/runners/runner_hosted/hosted-claims",
      ]);
    } finally {
      if (input.mode === "control-v1-sidecar") await input.controlLoop.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
