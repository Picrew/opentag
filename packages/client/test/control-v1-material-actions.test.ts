import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "@opentag/core";
import { describe, expect, it } from "vitest";
import {
  createOpenTagClient,
  OpenTagControlV1HttpError,
  type ControlCredential,
  type MaterialActionReceiptEnvelopeV1,
  type RunnerMaterialActionReconcileRequestV1,
} from "../src/index.js";

const observedAt = "2026-08-08T00:00:00.000Z";
const rawFence = "material_fence_canary";
const digest = `sha256:${"1".repeat(64)}`;
const otherDigest = `sha256:${"2".repeat(64)}`;

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;
}

function sha256Raw(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sealReceipt(
  receipt: MaterialActionReceiptEnvelopeV1,
): MaterialActionReceiptEnvelopeV1 {
  receipt.payloadDigest = sha256Canonical(receipt.payload);
  const { receiptDigest: _receiptDigest, ...receiptDigestInput } = receipt;
  receipt.receiptDigest = sha256Canonical(receiptDigestInput);
  return receipt;
}

function materialReceipt(
  outcome: "succeeded" | "failed" | "outcome_unknown" = "succeeded",
): MaterialActionReceiptEnvelopeV1 {
  const receiptId = `material_receipt_${outcome}`;
  const terminal = outcome !== "outcome_unknown";
  return sealReceipt({
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "material_action",
    receiptId,
    organizationId: "org_1",
    operationId: "material_operation_1",
    requiredCapabilities: ["relay.material-receipt.v1"],
    producer: { kind: "local_opentag", id: "runner:1" },
    identity: {
      namespace: "opentag.control.receipt/material-action/v1",
      parts: ["org_1", "run:1", "attempt_1", "action:1", receiptId],
    },
    observedAt,
    payloadDigest: digest,
    receiptDigest: otherDigest,
    runId: "run:1",
    attempt: {
      attemptId: "attempt_1",
      attemptNumber: 2,
      epoch: 2,
      fencingTokenDigest: sha256Raw(rawFence),
    },
    payload: {
      actionId: "action:1",
      actionFamily: "publish",
      provider: "npm",
      connectionRef: "connection_1",
      targetFingerprint: digest,
      operationId: "material_operation_1",
      requestDigest: otherDigest,
      actionPayloadDigest: digest,
      outcome,
      observedAt,
      reasonCode: outcome === "succeeded"
        ? "provider_accepted"
        : outcome === "failed"
          ? "provider_error"
          : "provider_receipt_missing",
      ...(terminal ? {} : {
        nextAction: "reconcile_provider_receipt",
        owner: "runner:1",
      }),
    },
  });
}

function reconcileRequest(
  expected?: MaterialActionReceiptEnvelopeV1,
): RunnerMaterialActionReconcileRequestV1 {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.material-receipt.v1"],
    requestId: "material_reconcile_request_1",
    organizationId: "org_1",
    runnerId: "runner:1",
    runId: "run:1",
    actionId: "action:1",
    attempt: {
      attemptId: "attempt_1",
      attemptNumber: 2,
      epoch: 2,
      fencingToken: rawFence,
      fencingTokenDigest: sha256Raw(rawFence),
    },
    ...(expected ? {
      expectedCurrentReceiptId: expected.receiptId,
      expectedCurrentReceiptDigest: expected.receiptDigest,
    } : {}),
  };
}

function jsonResponse(body: unknown, status: number, url: string): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function client(
  fetchImpl: typeof fetch,
  controlCredential: ControlCredential = {
    kind: "runtime",
    token: "runtime_header_canary",
  },
) {
  return createOpenTagClient({
    dispatcherUrl: "https://control.example/base",
    controlCredential,
    fetchImpl,
  });
}

describe("Control V1 material action transport", () => {
  it("rejects every non-runtime credential before either transport", async () => {
    let calls = 0;
    const receipt = materialReceipt();
    const request = reconcileRequest();
    for (const kind of [
      "bootstrap_pairing",
      "recovery_pairing",
      "operator",
      "approver",
    ] as const) {
      const sdk = client(async () => {
        calls += 1;
        return jsonResponse(receipt, 201, "https://control.example/response");
      }, { kind, token: `${kind}_header_canary` });
      await expect(sdk.recordMaterialActionReceiptControlV1({
        runnerId: "runner:1",
        fencingToken: rawFence,
        receipt,
      })).rejects.toThrow(new RegExp(`required=runtime actual=${kind}`));
      await expect(sdk.reconcileMaterialActionControlV1(request))
        .rejects.toThrow(new RegExp(`required=runtime actual=${kind}`));
    }
    expect(calls).toBe(0);
  });

  it.each([
    [201, false],
    [200, true],
  ] as const)("posts a strict receipt and accepts %i replay semantics", async (status, replayed) => {
    const receipt = materialReceipt();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = client(async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse(receipt, status, "https://control.example/response");
    });

    await expect(sdk.recordMaterialActionReceiptControlV1({
      runnerId: "runner:1",
      fencingToken: rawFence,
      receipt,
    })).resolves.toEqual({ status, replayed, outcome: "accepted", receipt });
    expect(requests[0]?.url).toBe(
      "https://control.example/base/v1/runners/runner%3A1/runs/run%3A1/material-actions/action%3A1/receipt",
    );
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(new Headers(requests[0]?.init?.headers).get("authorization"))
      .toBe("Bearer runtime_header_canary");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      fencingToken: rawFence,
      receipt,
    });
  });

  it("rejects malformed receipt input and raw-fence mismatch before transport", async () => {
    let calls = 0;
    const sdk = client(async () => {
      calls += 1;
      return jsonResponse(materialReceipt(), 201, "https://control.example/response");
    });
    const receipt = materialReceipt();
    await expect(sdk.recordMaterialActionReceiptControlV1({
      runnerId: "runner:1",
      fencingToken: "wrong_fence",
      receipt,
    })).rejects.toMatchObject({
      responseBody: "invalid_material_fencing_token_digest",
    });
    await expect(sdk.recordMaterialActionReceiptControlV1({
      runnerId: "runner:1",
      fencingToken: rawFence,
      receipt: { ...receipt, credential: "secret" } as MaterialActionReceiptEnvelopeV1,
    })).rejects.toThrow();
    await expect(sdk.recordMaterialActionReceiptControlV1({
      runnerId: "runner:2",
      fencingToken: rawFence,
      receipt,
    })).rejects.toMatchObject({
      responseBody: "invalid_material_receipt_identity",
    });
    for (const fencingToken of ["", "x".repeat(4097)]) {
      await expect(sdk.recordMaterialActionReceiptControlV1({
        runnerId: "runner:1",
        fencingToken,
        receipt,
      })).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  it("rejects malformed reconciliation input and raw-fence mismatch before transport", async () => {
    let calls = 0;
    const sdk = client(async () => {
      calls += 1;
      return jsonResponse(materialReceipt(), 200, "https://control.example/response");
    });
    const request = reconcileRequest();
    await expect(sdk.reconcileMaterialActionControlV1({
      ...request,
      attempt: { ...request.attempt, fencingToken: "wrong_fence" },
    })).rejects.toMatchObject({
      responseBody: "invalid_material_fencing_token_digest",
    });
    await expect(sdk.reconcileMaterialActionControlV1({
      ...request,
      provider: "npm",
    } as RunnerMaterialActionReconcileRequestV1)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it.each([
    [materialReceipt("succeeded"), 200, "resolved"],
    [materialReceipt("failed"), 200, "resolved"],
    [materialReceipt("outcome_unknown"), 202, "outcome_unknown"],
  ] as const)("reconciles without provider mutation input", async (receipt, status, outcome) => {
    const request = reconcileRequest();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = client(async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse(receipt, status, "https://control.example/response");
    });

    await expect(sdk.reconcileMaterialActionControlV1(request)).resolves.toEqual({
      status,
      outcome,
      receipt,
    });
    expect(requests[0]?.url).toBe(
      "https://control.example/base/v1/material-actions/action%3A1/reconcile",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(request);
    expect(String(requests[0]?.init?.body)).not.toContain("runtime_header_canary");
    for (const forbidden of ["provider", "outcome", "evidence", "connectionRef"]) {
      expect(JSON.parse(String(requests[0]?.init?.body))).not.toHaveProperty(forbidden);
    }
  });

  it("rejects response digest, identity, CAS, and status confusion", async () => {
    const terminal = materialReceipt();
    const cases: Array<{
      request: RunnerMaterialActionReconcileRequestV1;
      receipt: MaterialActionReceiptEnvelopeV1;
      status: number;
      reason: string;
    }> = [
      {
        request: reconcileRequest(),
        receipt: { ...terminal, payloadDigest: otherDigest },
        status: 200,
        reason: "invalid_material_receipt_digest",
      },
      {
        request: reconcileRequest(),
        receipt: sealReceipt({
          ...terminal,
          producer: { kind: "local_opentag", id: "runner:2" },
        }),
        status: 200,
        reason: "response_identity_mismatch",
      },
      {
        request: reconcileRequest({
          ...terminal,
          receiptId: "expected_receipt",
        }),
        receipt: terminal,
        status: 200,
        reason: "response_identity_mismatch",
      },
      {
        request: reconcileRequest(),
        receipt: terminal,
        status: 202,
        reason: "invalid_control_v1_response",
      },
    ];
    for (const testCase of cases) {
      const sdk = client(async () => jsonResponse(
        testCase.receipt,
        testCase.status,
        "https://control.example/response",
      ));
      await expect(sdk.reconcileMaterialActionControlV1(testCase.request))
        .rejects.toMatchObject({ responseBody: testCase.reason });
    }
  });

  it("binds standard reconciliation errors to the request ID", async () => {
    const request = reconcileRequest();
    const sdk = client(async () => jsonResponse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      error: "missing_or_concealed",
      message: "body_secret_canary",
      requestId: request.requestId,
    }, 404, "https://control.example/response"));
    const failure = await sdk.reconcileMaterialActionControlV1(request)
      .catch((caught) => caught);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({ status: 404, code: "missing_or_concealed" });
    expect(String(failure)).not.toContain("body_secret_canary");

    const mismatch = client(async () => jsonResponse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      error: "stale_attempt",
      message: "Attempt changed.",
      requestId: "different_request",
    }, 409, "https://control.example/response"));
    await expect(mismatch.reconcileMaterialActionControlV1(request))
      .rejects.toMatchObject({ responseBody: "response_identity_mismatch" });
  });
});
