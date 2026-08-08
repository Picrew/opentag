import { createHash } from "node:crypto";
import {
  buildPermissionRequestDigestInputV1,
  canonicalJsonStringify,
} from "@opentag/core";
import { describe, expect, it } from "vitest";
import {
  createOpenTagClient,
  type HumanPermissionDecisionRequestV1,
  type PermissionResolutionReceiptEnvelopeV1,
  type RunnerPermissionCurrentQueryV1,
  type RunnerPermissionRequestV1,
} from "../src/index.js";

const digest = `sha256:${"1".repeat(64)}`;
const otherDigest = `sha256:${"2".repeat(64)}`;
const observedAt = "2026-08-08T00:00:00.000Z";

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;
}

function sha256Raw(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sealReceipt(
  receipt: PermissionResolutionReceiptEnvelopeV1,
): PermissionResolutionReceiptEnvelopeV1 {
  receipt.payloadDigest = sha256Canonical(receipt.payload);
  const { receiptDigest: _receiptDigest, ...receiptDigestInput } = receipt;
  receipt.receiptDigest = sha256Canonical(receiptDigestInput);
  return receipt;
}

function jsonResponse(body: unknown, status: number, url: string): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function runnerRequest(): RunnerPermissionRequestV1 {
  const request: RunnerPermissionRequestV1 = {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.permission.v1"],
    requestId: "transport_request_1",
    operationId: "permission_operation_1",
    organizationId: "org_1",
    runnerId: "runner:1",
    runId: "run:1",
    attempt: {
      attemptId: "attempt_1",
      attemptNumber: 2,
      epoch: 2,
      fencingToken: "fence_transport_canary",
      fencingTokenDigest: sha256Raw("fence_transport_canary"),
    },
    permissionRequestId: "permission_request_1",
    actionId: "action:1",
    actionFamily: "publish",
    riskTier: "high",
    targetFingerprint: otherDigest,
    permissionScopes: ["npm:publish", "package:write"],
    policySnapshotRef: "policy_1",
    policySnapshotDigest: digest,
    permissionRequestDigest: digest,
    requestedAt: observedAt,
  };
  request.permissionRequestDigest = sha256Canonical(
    buildPermissionRequestDigestInputV1({
      schemaVersion: request.schemaVersion,
      protocolVersion: request.protocolVersion,
      requiredCapabilities: request.requiredCapabilities,
      organizationId: request.organizationId,
      runnerId: request.runnerId,
      runId: request.runId,
      attempt: {
        attemptId: request.attempt.attemptId,
        attemptNumber: request.attempt.attemptNumber,
        epoch: request.attempt.epoch,
        fencingTokenDigest: request.attempt.fencingTokenDigest,
      },
      permissionRequestId: request.permissionRequestId,
      actionId: request.actionId,
      actionFamily: request.actionFamily,
      riskTier: request.riskTier,
      targetFingerprint: request.targetFingerprint,
      permissionScopes: request.permissionScopes,
      policySnapshotRef: request.policySnapshotRef,
      policySnapshotDigest: request.policySnapshotDigest,
      requestedAt: request.requestedAt,
    }),
  );
  return request;
}

function waitingReceipt(): PermissionResolutionReceiptEnvelopeV1 {
  const request = runnerRequest();
  return sealReceipt({
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
      parts: ["org_1", "run:1", "attempt_1", "action:1", "resolution_1"],
    },
    observedAt,
    payloadDigest: digest,
    receiptDigest: otherDigest,
    runId: "run:1",
    attempt: {
      attemptId: "attempt_1",
      attemptNumber: 2,
      epoch: 2,
      fencingTokenDigest: request.attempt.fencingTokenDigest,
    },
    payload: {
      resolutionId: "resolution_1",
      permissionRequestId: "permission_request_1",
      permissionRequestDigest: request.permissionRequestDigest,
      actionId: "action:1",
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
  });
}

function authorizedReceipt(): PermissionResolutionReceiptEnvelopeV1 {
  const waiting = waitingReceipt();
  const { nextAction: _nextAction, ...terminalPayload } = waiting.payload;
  return sealReceipt({
    ...waiting,
    receiptId: "permission_receipt_2",
    operationId: "decision_operation_1",
    identity: {
      ...waiting.identity,
      parts: ["org_1", "run:1", "attempt_1", "action:1", "resolution_2"],
    },
    payload: {
      ...terminalPayload,
      resolutionId: "resolution_2",
      state: "authorized",
      decision: "allow_once",
      decisionRef: "decision_1",
      decisionActorRef: "user_1",
      reasonCode: "human_approved",
      decidedAt: observedAt,
    },
  });
}

function deniedReceipt(): PermissionResolutionReceiptEnvelopeV1 {
  const waiting = waitingReceipt();
  const { nextAction: _nextAction, ...terminalPayload } = waiting.payload;
  return sealReceipt({
    ...waiting,
    receiptId: "permission_receipt_denied",
    operationId: "decision_deny_operation_1",
    identity: {
      ...waiting.identity,
      parts: ["org_1", "run:1", "attempt_1", "action:1", "resolution_denied"],
    },
    payload: {
      ...terminalPayload,
      resolutionId: "resolution_denied",
      state: "denied",
      decision: "deny",
      decisionRef: "decision_deny_1",
      decisionActorRef: "user_1",
      reasonCode: "human_denied",
      decidedAt: observedAt,
    },
  });
}

function staleReceipt(): PermissionResolutionReceiptEnvelopeV1 {
  const waiting = waitingReceipt();
  const { nextAction: _nextAction, ...terminalPayload } = waiting.payload;
  return sealReceipt({
    ...waiting,
    receiptId: "permission_receipt_stale",
    identity: {
      ...waiting.identity,
      parts: ["org_1", "run:1", "attempt_1", "action:1", "resolution_stale"],
    },
    payload: {
      ...terminalPayload,
      resolutionId: "resolution_stale",
      state: "stale",
      reasonCode: "attempt_stale",
    },
  });
}

function humanDecision(): HumanPermissionDecisionRequestV1 {
  const request = runnerRequest();
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.permission.v1"],
    requestId: "decision_transport_1",
    operationId: "decision_operation_1",
    organizationId: "org_1",
    runId: "run:1",
    attempt: {
      attemptId: "attempt_1",
      attemptNumber: 2,
      epoch: 2,
      fencingTokenDigest: request.attempt.fencingTokenDigest,
    },
    actionId: "action:1",
    permissionRequestId: "permission_request_1",
    permissionRequestDigest: request.permissionRequestDigest,
    policySnapshotDigest: digest,
    decisionId: "decision_1",
    decision: "allow_once",
    decidedAt: observedAt,
  };
}

function humanDenyDecision(): HumanPermissionDecisionRequestV1 {
  return {
    ...humanDecision(),
    operationId: "decision_deny_operation_1",
    decisionId: "decision_deny_1",
    decision: "deny",
  };
}

function currentQuery(): RunnerPermissionCurrentQueryV1 {
  const request = runnerRequest();
  return {
    organizationId: request.organizationId,
    runnerId: request.runnerId,
    runId: request.runId,
    attempt: {
      attemptId: request.attempt.attemptId,
      attemptNumber: request.attempt.attemptNumber,
      epoch: request.attempt.epoch,
      fencingTokenDigest: request.attempt.fencingTokenDigest,
    },
    actionId: request.actionId,
    permissionRequestId: request.permissionRequestId,
    permissionRequestDigest: request.permissionRequestDigest,
  };
}

describe("Control V1 permission transport", () => {
  it("rejects every wrong credential kind before permission transport", async () => {
    let calls = 0;
    const createClient = (
      kind:
        | "bootstrap_pairing"
        | "recovery_pairing"
        | "operator"
        | "approver"
        | "runtime",
    ) =>
      createOpenTagClient({
        dispatcherUrl: "https://control.example/base",
        controlCredential: { kind, token: `${kind}_header_canary` },
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(waitingReceipt(), 202, "https://control.example/response");
        },
      });

    const operator = createClient("operator");
    await expect(operator.requestActionPermissionControlV1(runnerRequest())).rejects.toThrow(
      /required=runtime actual=operator/,
    );
    await expect(operator.getActionPermissionCurrentControlV1(currentQuery())).rejects.toThrow(
      /required=runtime actual=operator/,
    );
    await expect(operator.resolveActionPermissionControlV1({
      runnerId: "runner:1",
      decision: humanDecision(),
    })).rejects.toThrow(/required=approver actual=operator/);

    const approver = createClient("approver");
    await expect(approver.requestActionPermissionControlV1(runnerRequest())).rejects.toThrow(
      /required=runtime actual=approver/,
    );
    await expect(approver.getActionPermissionCurrentControlV1(currentQuery())).rejects.toThrow(
      /required=runtime actual=approver/,
    );

    const runtime = createClient("runtime");
    await expect(runtime.resolveActionPermissionControlV1({
      runnerId: "runner:1",
      decision: humanDecision(),
    })).rejects.toThrow(/required=approver actual=runtime/);

    for (const kind of ["bootstrap_pairing", "recovery_pairing"] as const) {
      const pairing = createClient(kind);
      await expect(pairing.requestActionPermissionControlV1(runnerRequest())).rejects.toThrow(
        new RegExp(`required=runtime actual=${kind}`),
      );
      await expect(pairing.getActionPermissionCurrentControlV1(currentQuery())).rejects.toThrow(
        new RegExp(`required=runtime actual=${kind}`),
      );
      await expect(pairing.resolveActionPermissionControlV1({
        runnerId: "runner:1",
        decision: humanDecision(),
      })).rejects.toThrow(new RegExp(`required=approver actual=${kind}`));
    }

    expect(calls).toBe(0);
  });

  it("posts the strict Runner request and accepts only 202 waiting", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const receipt = waitingReceipt();
    const sdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "runtime", token: "runtime_header_canary" },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse(
          receipt,
          202,
          "https://control.example/base/v1/runners/runner%3A1/runs/run%3A1/action-permissions",
        );
      },
    });

    await expect(sdk.requestActionPermissionControlV1(runnerRequest())).resolves.toEqual({
      status: 202,
      outcome: "waiting",
      receipt,
    });
    expect(requests[0]?.url).toBe(
      "https://control.example/base/v1/runners/runner%3A1/runs/run%3A1/action-permissions",
    );
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer runtime_header_canary",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(runnerRequest());

    const invalid = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "runtime", token: "runtime_header_canary" },
      fetchImpl: async () => jsonResponse(receipt, 200, "https://control.example/response"),
    });
    await expect(invalid.requestActionPermissionControlV1(runnerRequest()))
      .rejects.toMatchObject({ responseBody: "invalid_control_v1_response" });
  });

  it("posts a human decision with approver transport and uses a decision-specific parser", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const receipt = authorizedReceipt();
    const sdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "approver", token: "approver_header_canary" },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse(receipt, 200, "https://control.example/response");
      },
    });

    await expect(sdk.resolveActionPermissionControlV1({
      runnerId: "runner:1",
      decision: humanDecision(),
    })).resolves.toEqual({ status: 200, outcome: "resolved", receipt });
    expect(requests[0]?.url).toBe(
      "https://control.example/base/v1/runners/runner%3A1/runs/run%3A1/action-permissions/action%3A1/resolve",
    );
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer approver_header_canary",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(humanDecision());
    const serializedDecision = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(serializedDecision).not.toHaveProperty("runnerId");
    expect(serializedDecision).not.toHaveProperty("fencingToken");
    expect(JSON.stringify(serializedDecision)).not.toContain("runtime_header_canary");
    expect(JSON.stringify(serializedDecision)).not.toContain("approver_header_canary");

    const waiting = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "approver", token: "approver_header_canary" },
      fetchImpl: async () => jsonResponse(waitingReceipt(), 202, "https://control.example/response"),
    });
    await expect(waiting.resolveActionPermissionControlV1({
      runnerId: "runner:1",
      decision: humanDecision(),
    })).rejects.toMatchObject({ responseBody: "invalid_control_v1_response" });

    const otherOperation = sealReceipt({
      ...authorizedReceipt(),
      operationId: "other_decision_operation",
    });
    const mismatch = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "approver", token: "approver_header_canary" },
      fetchImpl: async () => jsonResponse(otherOperation, 200, "https://control.example/response"),
    });
    await expect(mismatch.resolveActionPermissionControlV1({
      runnerId: "runner:1",
      decision: humanDecision(),
    })).rejects.toMatchObject({ responseBody: "response_identity_mismatch" });
  });

  it("resolves and polls a denied decision with strict status, attribution, and digests", async () => {
    const decision = humanDenyDecision();
    const receipt = deniedReceipt();
    const resolveSdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "approver", token: "approver_header_canary" },
      fetchImpl: async () => jsonResponse(receipt, 200, "https://control.example/response"),
    });
    await expect(resolveSdk.resolveActionPermissionControlV1({
      runnerId: "runner:1",
      decision,
    })).resolves.toEqual({ status: 200, outcome: "resolved", receipt });

    const currentSdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "runtime", token: "runtime_header_canary" },
      fetchImpl: async () => jsonResponse(receipt, 200, "https://control.example/response"),
    });
    await expect(currentSdk.getActionPermissionCurrentControlV1(currentQuery())).resolves.toEqual({
      status: 200,
      outcome: "resolved",
      receipt,
    });

    for (const mutate of [
      () => ({ ...receipt, payloadDigest: digest }),
      () => ({ ...receipt, receiptDigest: digest }),
      () => ({
        ...receipt,
        payload: { ...receipt.payload, decisionActorRef: undefined },
      } as PermissionResolutionReceiptEnvelopeV1),
      () => ({
        ...receipt,
        payload: { ...receipt.payload, nextAction: "wait_for_operator" },
      } as PermissionResolutionReceiptEnvelopeV1),
    ]) {
      const invalidSdk = createOpenTagClient({
        dispatcherUrl: "https://control.example/base",
        controlCredential: { kind: "approver", token: "approver_header_canary" },
        fetchImpl: async () => jsonResponse(mutate(), 200, "https://control.example/response"),
      });
      await expect(invalidSdk.resolveActionPermissionControlV1({
        runnerId: "runner:1",
        decision,
      })).rejects.toMatchObject({ responseBody: "invalid_control_v1_response" });
    }
  });

  it("polls current state and rejects status/state confusion", async () => {
    const query = currentQuery();
    for (const [status, receipt, outcome] of [
      [202, waitingReceipt(), "waiting"],
      [200, authorizedReceipt(), "resolved"],
      [200, deniedReceipt(), "resolved"],
      [200, staleReceipt(), "resolved"],
    ] as const) {
      let url = "";
      const sdk = createOpenTagClient({
        dispatcherUrl: "https://control.example/base",
        controlCredential: { kind: "runtime", token: "runtime_header_canary" },
        fetchImpl: async (input) => {
          url = String(input);
          return jsonResponse(receipt, status, "https://control.example/response");
        },
      });
      await expect(sdk.getActionPermissionCurrentControlV1(query)).resolves.toEqual({
        status,
        outcome,
        receipt,
      });
      expect(url).toContain(
        "/v1/runners/runner%3A1/runs/run%3A1/action-permissions/action%3A1/current?",
      );
      expect(url).toContain("permissionRequestDigest=sha256%3A");
    }

    for (const [status, receipt] of [
      [200, waitingReceipt()],
      [202, authorizedReceipt()],
    ] as const) {
      const sdk = createOpenTagClient({
        dispatcherUrl: "https://control.example/base",
        controlCredential: { kind: "runtime", token: "runtime_header_canary" },
        fetchImpl: async () => jsonResponse(receipt, status, "https://control.example/response"),
      });
      await expect(sdk.getActionPermissionCurrentControlV1(query))
        .rejects.toMatchObject({ responseBody: "invalid_control_v1_response" });
    }
  });

  it("maps permission fail-closed errors without exposing their message", async () => {
    const sdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "runtime", token: "runtime_header_canary" },
      fetchImpl: async () => jsonResponse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        error: "stale_attempt",
        message: "response_secret_canary",
        requestId: "transport_request_1",
      }, 409, "https://control.example/response"),
    });
    const failure = await sdk.requestActionPermissionControlV1(runnerRequest()).catch((error) => error);
    expect(failure).toMatchObject({ status: 409, code: "stale_attempt" });
    expect(String(failure)).not.toContain("response_secret_canary");
  });

  it("validates public fence and canonical request digests before transport", async () => {
    let calls = 0;
    const sdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "runtime", token: "runtime_header_canary" },
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(waitingReceipt(), 202, "https://control.example/response");
      },
    });
    const fenceMismatch = runnerRequest();
    fenceMismatch.attempt.fencingToken = "different_raw_fence";
    await expect(sdk.requestActionPermissionControlV1(fenceMismatch)).rejects.toMatchObject({
      responseBody: "invalid_permission_fencing_token_digest",
    });

    const requestDigestMismatch = runnerRequest();
    requestDigestMismatch.actionFamily = "deploy";
    await expect(sdk.requestActionPermissionControlV1(requestDigestMismatch)).rejects.toMatchObject({
      responseBody: "invalid_permission_request_digest",
    });
    expect(calls).toBe(0);

    const changedRequestId = { ...runnerRequest(), requestId: "transport_request_2" };
    await expect(sdk.requestActionPermissionControlV1(changedRequestId)).resolves.toMatchObject({
      status: 202,
      outcome: "waiting",
    });

    const changedOperation = { ...runnerRequest(), operationId: "permission_operation_2" };
    const changedOperationReceipt = sealReceipt({
      ...waitingReceipt(),
      operationId: changedOperation.operationId,
    });
    const operationSdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "runtime", token: "runtime_header_canary" },
      fetchImpl: async () => jsonResponse(
        changedOperationReceipt,
        202,
        "https://control.example/response",
      ),
    });
    await expect(operationSdk.requestActionPermissionControlV1(changedOperation)).resolves.toMatchObject({
      status: 202,
      outcome: "waiting",
    });
  });

  it("rejects raw action/provider/custody fields before transport and mismatched receipts", async () => {
    let calls = 0;
    const sdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "runtime", token: "runtime_header_canary" },
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(waitingReceipt(), 202, "https://control.example/response");
      },
    });
    for (const unsafe of [
      { action: { id: "action:1" } },
      { rawArgs: { command: "npm publish" } },
      { title: "Publish package" },
      { path: "/private/repo" },
      { providerPayload: { token: "secret" } },
      { metadata: {} },
    ]) {
      await expect(sdk.requestActionPermissionControlV1({
        ...runnerRequest(),
        ...unsafe,
      } as RunnerPermissionRequestV1)).rejects.toBeTruthy();
    }
    expect(calls).toBe(0);

    const mismatchedReceipt = waitingReceipt();
    mismatchedReceipt.payload.permissionRequestDigest = digest;
    sealReceipt(mismatchedReceipt);
    const mismatchSdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "runtime", token: "runtime_header_canary" },
      fetchImpl: async () => jsonResponse(mismatchedReceipt, 202, "https://control.example/response"),
    });
    await expect(mismatchSdk.requestActionPermissionControlV1(runnerRequest()))
      .rejects.toMatchObject({ responseBody: "response_identity_mismatch" });
  });

  it.each([
    ["operationId", () => sealReceipt({ ...waitingReceipt(), operationId: "other_operation" })],
    ["payloadDigest", () => ({ ...waitingReceipt(), payloadDigest: digest })],
    ["receiptDigest", () => ({ ...waitingReceipt(), receiptDigest: digest })],
  ] as const)("rejects a mismatched %s without echoing receipt contents", async (_name, mutate) => {
    const sdk = createOpenTagClient({
      dispatcherUrl: "https://control.example/base",
      controlCredential: { kind: "runtime", token: "runtime_header_canary" },
      fetchImpl: async () => jsonResponse(mutate(), 202, "https://control.example/response"),
    });
    const failure = await sdk.requestActionPermissionControlV1(runnerRequest()).catch((error) => error);
    expect(failure).toMatchObject({
      responseBody: _name === "operationId"
        ? "response_identity_mismatch"
        : "invalid_control_v1_response",
    });
    expect(String(failure)).not.toContain("operator decision is required");
  });
});
