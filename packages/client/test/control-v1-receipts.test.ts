import { describe, expect, it } from "vitest";
import {
  createOpenTagClient,
  OpenTagControlV1HttpError,
  type CallbackObservationReceiptEnvelopeV1,
  type CompletionAssessmentReceiptEnvelopeV1,
  type CompletionContractRefReceiptEnvelopeV1,
  type RunnerReadinessReceiptEnvelopeV1,
  type WorkThreadRefReceiptEnvelopeV1
} from "../src/index.js";

const digest = `sha256:${"1".repeat(64)}`;
const otherDigest = `sha256:${"2".repeat(64)}`;
const observedAt = "2026-08-08T00:00:00.000Z";

function jsonResponse(
  body: unknown,
  status = 200,
  url = "https://control.example/response",
  headers: HeadersInit = {}
): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) }
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

const base = {
  schemaVersion: 1 as const,
  protocolVersion: "1.0" as const,
  organizationId: "org_1",
  producer: { kind: "local_opentag" as const, id: "local_1" },
  observedAt,
  payloadDigest: digest,
  receiptDigest: otherDigest
};

function readiness(): RunnerReadinessReceiptEnvelopeV1 {
  return {
    ...base,
    receiptKind: "runner_readiness",
    receiptId: "receipt_readiness_1",
    operationId: "op_readiness_1",
    requiredCapabilities: ["relay.readiness.v1"],
    producer: {
      kind: "runner",
      id: "runner_1",
      credentialId: "runtime_credential_1",
      registrationGeneration: 1
    },
    identity: {
      namespace: "opentag.control.receipt/runner-readiness/v1",
      parts: ["org_1", "runner_1", "1", "readiness_1"]
    },
    payload: {
      readinessId: "readiness_1",
      runnerId: "runner_1",
      registrationGeneration: 1,
      capabilities: ["relay.readiness.v1"],
      executors: [],
      targets: [],
      observedAt,
      expiresAt: "2026-08-08T00:01:00.000Z"
    }
  };
}

function workThreadRef(): WorkThreadRefReceiptEnvelopeV1 {
  return {
    ...base,
    receiptKind: "work_thread_ref",
    receiptId: "receipt_thread_1",
    operationId: "op_thread_1",
    requiredCapabilities: ["relay.work-thread-ref.v1"],
    runId: "run/1",
    workThreadId: "thread_1",
    identity: {
      namespace: "opentag.control.receipt/work-thread-ref/v1",
      parts: ["org_1", "run/1", "thread_1"]
    },
    payload: {
      workThreadId: "thread_1",
      sourceIdentityDigest: digest,
      localCreationReceiptId: "local_creation_1",
      localCreationReceiptDigest: digest,
      lineageKind: "source_thread",
      createdAt: observedAt
    }
  };
}

function contractRef(): CompletionContractRefReceiptEnvelopeV1 {
  return {
    ...base,
    receiptKind: "completion_contract_ref",
    receiptId: "receipt_contract_1",
    operationId: "op_contract_1",
    requiredCapabilities: ["relay.completion-contract-ref.v1"],
    runId: "run_1",
    workThreadId: "thread_1",
    identity: {
      namespace: "opentag.control.receipt/completion-contract-ref/v1",
      parts: ["org_1", "thread_1", "contract_1", "1", "1"]
    },
    payload: {
      contractId: "contract_1",
      version: 1,
      cycle: 1,
      mode: "governed",
      contentDigest: digest,
      resolvedTargetDigests: [digest],
      requiredGateIds: ["checks"],
      createdAt: observedAt
    }
  };
}

const attempt = {
  attemptId: "attempt_1",
  attemptNumber: 1,
  epoch: 1,
  fencingTokenDigest: digest
};

function assessment(): CompletionAssessmentReceiptEnvelopeV1 {
  return {
    ...base,
    receiptKind: "completion_assessment",
    receiptId: "receipt_assessment_1",
    operationId: "op_assessment_1",
    requiredCapabilities: ["relay.completion-assessment.v1"],
    runId: "run_1",
    workThreadId: "thread_1",
    attempt,
    identity: {
      namespace: "opentag.control.receipt/completion-assessment/v1",
      parts: ["org_1", "thread_1", "assessment_1"]
    },
    payload: {
      assessmentId: "assessment_1",
      workThreadId: "thread_1",
      contract: { contractId: "contract_1", version: 1, cycle: 1, contentDigest: digest },
      admissionPolicySnapshot: { snapshotId: "policy_1", digest },
      runId: "run_1",
      attempt,
      assessmentInputDigest: digest,
      evidenceReceiptDigests: [digest],
      gateResults: [{
        gateId: "checks",
        state: "pending",
        reasonCode: "verification_missing",
        evidenceReceiptDigests: [digest]
      }],
      conclusion: "pending",
      assessedAt: observedAt,
      assessedBy: "local_1"
    }
  };
}

function callbackUnknown(): CallbackObservationReceiptEnvelopeV1 {
  return {
    ...base,
    receiptKind: "callback_attempt_observation",
    receiptId: "receipt_callback_1",
    operationId: "op_callback_1",
    requiredCapabilities: ["relay.callback-observation.v1"],
    runId: "run_1",
    workThreadId: "thread_1",
    identity: {
      namespace: "opentag.control.receipt/callback-attempt-observation/v1",
      parts: ["org_1", "thread_1", "intent_1", "callback_attempt_1"]
    },
    payload: {
      localIntentId: "intent_1",
      localAttemptId: "callback_attempt_1",
      attemptNumber: 1,
      requestDigest: digest,
      outcome: "outcome_unknown",
      reasonCode: "provider_timeout",
      nextAction: "reconcile-provider",
      owner: base.producer.id,
      attemptedAt: observedAt,
      observedAt
    }
  };
}

function callbackIntent(): CallbackObservationReceiptEnvelopeV1 {
  return {
    ...base,
    receiptKind: "callback_intent_observation",
    receiptId: "receipt_callback_intent_1",
    operationId: "op_callback_intent_1",
    requiredCapabilities: ["relay.callback-observation.v1"],
    runId: "run_1",
    workThreadId: "thread_1",
    identity: {
      namespace: "opentag.control.receipt/callback-intent-observation/v1",
      parts: ["org_1", "thread_1", "intent_1"]
    },
    payload: {
      localIntentId: "intent_1",
      assessmentRef: "assessment_1",
      assessmentDigest: digest,
      provider: "github",
      sourceThreadIdentityDigest: digest,
      operationId: "op_callback_intent_1",
      payloadDigest: digest,
      createdAt: observedAt
    }
  };
}

function callbackProvider(): CallbackObservationReceiptEnvelopeV1 {
  return {
    ...base,
    receiptKind: "callback_provider_observation",
    receiptId: "receipt_callback_provider_1",
    operationId: "op_callback_provider_1",
    requiredCapabilities: ["relay.callback-observation.v1"],
    runId: "run_1",
    workThreadId: "thread_1",
    identity: {
      namespace: "opentag.control.receipt/callback-provider-observation/v1",
      parts: ["org_1", "thread_1", "intent_1", "callback_attempt_1", "provider_receipt_1"]
    },
    payload: {
      localIntentId: "intent_1",
      localAttemptId: "callback_attempt_1",
      providerReceiptId: "provider_receipt_1",
      resourceIdentity: "github:comment:1",
      outcome: "succeeded",
      observedAt,
      reasonCode: "provider_accepted"
    }
  };
}

function client(fetchImpl: typeof fetch) {
  return createOpenTagClient({
    dispatcherUrl: "https://control.example/base",
    controlCredential: { kind: "runtime", token: "runtime_header_canary" },
    fetchImpl
  });
}

describe("Control V1 typed receipt transport", () => {
  it("parses the strict capability handshake and uses manual redirects", async () => {
    let init: RequestInit | undefined;
    const body = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      registryVersion: "opentag.control.capabilities/v1",
      capabilities: ["relay.readiness.v1"],
      minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
      deployment: { environment: "test", releaseSha: "a".repeat(40) }
    };
    const result = await client(async (_url, requestInit) => {
      init = requestInit;
      return jsonResponse(body, 200, "https://control.example/v1/relay/capabilities");
    }).getRelayCapabilitiesControlV1();

    expect(result).toEqual(body);
    expect(init?.redirect).toBe("manual");
  });

  it.each([
    ["readiness", readiness(), "/v1/runners/runner_1/readiness", "reportRunnerReadinessControlV1"],
    ["work thread", workThreadRef(), "/v1/runs/run%2F1/receipts/work-thread-ref", "projectWorkThreadRefControlV1"],
    ["contract", contractRef(), "/v1/runs/run_1/receipts/completion-contract-ref", "projectCompletionContractRefControlV1"],
    ["assessment", assessment(), "/v1/runs/run_1/receipts/completion-assessments", "projectCompletionAssessmentControlV1"]
  ] as const)("posts and strictly parses a fresh %s receipt", async (_name, receipt, path, method) => {
    let requestUrl = "";
    let init: RequestInit | undefined;
    const sdk = client(async (url, requestInit) => {
      requestUrl = String(url);
      init = requestInit;
      return jsonResponse(receipt, 201, `https://control.example${path}`);
    });

    const result = await (sdk[method] as (input: never) => Promise<unknown>)(receipt as never);
    expect(result).toEqual({ status: 201, replayed: false, outcome: "accepted", receipt });
    expect(requestUrl).toBe(`https://control.example/base${path}`);
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime_header_canary");
    expect(JSON.parse(String(init?.body))).toEqual(receipt);
  });

  it("returns stable replay metadata without presenting replay as a fresh mutation", async () => {
    const receipt = readiness();
    const result = await client(async () => jsonResponse(receipt, 200))
      .reportRunnerReadinessControlV1(receipt);

    expect(result).toEqual({ status: 200, replayed: true, outcome: "accepted", receipt });
  });

  it.each([
    ["receiptKind", "invalid_control_v1_response", () => ({ ...readiness(), receiptKind: "work_thread_ref" })],
    ["identity namespace", "invalid_control_v1_response", () => ({
      ...readiness(),
      identity: { ...readiness().identity, namespace: "opentag.control.receipt/work-thread-ref/v1" }
    })],
    ["identity parts", "invalid_control_v1_response", () => ({
      ...readiness(),
      identity: { ...readiness().identity, parts: ["org_1", "runner_other", "1", "readiness_1"] }
    })],
    ["payload digest", "response_identity_mismatch", () => ({ ...readiness(), payloadDigest: otherDigest })],
    ["full payload", "response_identity_mismatch", () => ({
      ...readiness(),
      payload: { ...readiness().payload, capabilities: ["relay.lifecycle.v1", "relay.readiness.v1"] }
    })]
  ])("rejects a response whose %s differs while the original four comparison fields stay fixed", async (_name, expectedReason, mutate) => {
    const request = readiness();
    const response = mutate();
    expect(response.receiptId).toBe(request.receiptId);
    expect(response.organizationId).toBe(request.organizationId);
    expect(response.operationId).toBe(request.operationId);
    expect(response.receiptDigest).toBe(request.receiptDigest);

    await expect(client(async () => jsonResponse(response, 201))
      .reportRunnerReadinessControlV1(request))
      .rejects.toMatchObject({ responseBody: expectedReason });
  });

  it.each([
    ["run", () => {
      const receipt = workThreadRef();
      return {
        ...receipt,
        runId: "run_2",
        identity: { ...receipt.identity, parts: ["org_1", "run_2", "thread_1"] }
      };
    }],
    ["work thread", () => {
      const receipt = workThreadRef();
      return {
        ...receipt,
        workThreadId: "thread_2",
        identity: { ...receipt.identity, parts: ["org_1", "run/1", "thread_2"] },
        payload: { ...receipt.payload, workThreadId: "thread_2" }
      };
    }],
    ["attempt", () => {
      const receipt = assessment();
      const changedAttempt = {
        ...receipt.attempt,
        attemptNumber: 2,
        epoch: 2,
      };
      return {
        ...receipt,
        attempt: changedAttempt,
        payload: { ...receipt.payload, attempt: changedAttempt }
      };
    }]
  ])("rejects a schema-valid response with changed %s identity while the original four fields stay fixed", async (name, mutate) => {
    const request = name === "attempt" ? assessment() : workThreadRef();
    const response = mutate();
    expect(response.receiptId).toBe(request.receiptId);
    expect(response.organizationId).toBe(request.organizationId);
    expect(response.operationId).toBe(request.operationId);
    expect(response.receiptDigest).toBe(request.receiptDigest);
    const sdk = client(async () => jsonResponse(response, 201));
    const operation = name === "attempt"
      ? sdk.projectCompletionAssessmentControlV1(request as CompletionAssessmentReceiptEnvelopeV1)
      : sdk.projectWorkThreadRefControlV1(request as WorkThreadRefReceiptEnvelopeV1);

    await expect(operation).rejects.toMatchObject({ responseBody: "response_identity_mismatch" });
  });

  it("maps a callback unknown receipt only from the exact 202 status", async () => {
    const receipt = callbackUnknown();
    const result = await client(async () => jsonResponse(receipt, 202))
      .projectCallbackObservationControlV1(receipt);

    expect(result).toEqual({
      status: 202,
      replayed: false,
      outcome: "outcome_unknown",
      receipt
    });
  });

  it.each([
    ["intent", callbackIntent()],
    ["provider", callbackProvider()]
  ])("projects a strict callback %s observation through the shared endpoint", async (_name, receipt) => {
    const result = await client(async () => jsonResponse(receipt, 201))
      .projectCallbackObservationControlV1(receipt);

    expect(result).toEqual({ status: 201, replayed: false, outcome: "accepted", receipt });
  });

  it("rejects 202 for a callback observation that is not outcome_unknown", async () => {
    const receipt = callbackProvider();
    await expect(client(async () => jsonResponse(receipt, 202))
      .projectCallbackObservationControlV1(receipt))
      .rejects.toMatchObject({ responseBody: "invalid_control_v1_response" });
  });

  it.each([
    [404, "missing_or_concealed", {}],
    [409, "stale_attempt", {}],
    [412, "capability_required", { requiredCapabilities: ["relay.readiness.v1"] }],
    [422, "observation_policy_mismatch", {}],
    [426, "protocol_upgrade_required", {
      supported: { schemaVersions: [1], protocolVersions: ["1.0"] },
      nextAction: "upgrade_client"
    }]
  ])("maps fail-closed status %i to its allowlisted reason", async (status, error, extra) => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      error,
      message: "body_secret_canary",
      requestId: "request_body_token_canary",
      ...extra
    }, status));

    const failure = await sdk.reportRunnerReadinessControlV1(receipt).catch((caught) => caught);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({ status, code: error });
    expect(String(failure)).not.toContain("body_secret_canary");
    expect(String(failure)).not.toContain("request_body_token_canary");
  });

  it("maps a strict receipt 429 and exposes only sanitized retry metadata", async () => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      error: "rate_limited",
      message: "receipt_429_body_canary",
      requestId: "receipt_429_request_canary",
      retryAfterSeconds: 7
    }, 429, "https://control.example/v1/runners/runner_1/readiness", {
      "retry-after": "7",
      "x-secret-canary": "receipt_429_header_canary"
    }));

    const failure = await sdk.reportRunnerReadinessControlV1(receipt).catch((caught) => caught);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({
      status: 429,
      code: "rate_limited",
      requestId: "unavailable",
      retryAfterSeconds: 7
    });
    expect(String(failure)).not.toContain("canary");
  });

  it.each([
    ["missing header", {}, { retryAfterSeconds: 7 }],
    ["mismatched header", { "retry-after": "8" }, { retryAfterSeconds: 7 }],
    ["malformed body", { "retry-after": "7" }, { retryAfterSeconds: "7" }]
  ])("rejects a receipt 429 with %s", async (_name, headers, extra) => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      error: "rate_limited",
      message: "receipt_429_body_canary",
      requestId: "receipt_429_request_canary",
      ...extra
    }, 429, "https://control.example/v1/runners/runner_1/readiness", headers));

    const failure = await sdk.reportRunnerReadinessControlV1(receipt).catch((caught) => caught);
    expect(failure).toMatchObject({ responseBody: "invalid_control_v1_response" });
    expect(String(failure)).not.toContain("canary");
  });

  it("rejects unknown request fields before fetch", async () => {
    let fetched = false;
    const input = { ...readiness(), plaintextCredential: "body_token_canary" };
    const sdk = client(async () => {
      fetched = true;
      return jsonResponse(input, 201);
    });

    await expect(sdk.reportRunnerReadinessControlV1(input as RunnerReadinessReceiptEnvelopeV1))
      .rejects.toMatchObject({ name: "ZodError" });
    expect(fetched).toBe(false);
  });

  it("rejects unknown response fields and identity changes without leaking response data", async () => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse({
      ...receipt,
      receiptId: "body_secret_canary",
      unexpected: "response_token_canary"
    }, 201));

    const failure = await sdk.reportRunnerReadinessControlV1(receipt).catch((caught) => caught);
    expect(failure).toMatchObject({ responseBody: "invalid_control_v1_response" });
    expect(String(failure)).not.toContain("canary");
  });

  it.each([
    ["same-origin", "https://control.example/redirected"],
    ["cross-origin", "https://attacker.example/redirected"]
  ])("rejects a %s redirect without following it", async (_name, url) => {
    let calls = 0;
    const sdk = client(async (_requestUrl, init) => {
      calls += 1;
      expect(init?.redirect).toBe("manual");
      return jsonResponse({}, 302, url);
    });

    await expect(sdk.reportRunnerReadinessControlV1(readiness()))
      .rejects.toMatchObject({ responseBody: "redirect_rejected" });
    expect(calls).toBe(1);
  });

  it("rejects a successful response from a different origin", async () => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse(
      receipt,
      201,
      "https://attacker.example/v1/runners/runner_1/readiness"
    ));

    await expect(sdk.reportRunnerReadinessControlV1(receipt))
      .rejects.toMatchObject({ responseBody: "response_origin_mismatch" });
  });

  it("rejects a Control V1 response whose final origin cannot be proven", async () => {
    const receipt = readiness();
    const sdk = client(async () => {
      const response = new Response(JSON.stringify(receipt), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
      expect(response.url).toBe("");
      return response;
    });

    await expect(sdk.reportRunnerReadinessControlV1(receipt))
      .rejects.toMatchObject({ responseBody: "response_origin_unverifiable" });
  });

  it("sanitizes thrown transport failures that contain URL, header, and body canaries", async () => {
    const sdk = client(async () => {
      throw new TypeError(
        "https://attacker.example/?token=url_token_canary Authorization=runtime_header_canary body_token_canary"
      );
    });

    const failure = await sdk.reportRunnerReadinessControlV1(readiness()).catch((caught) => caught);
    expect(failure).toMatchObject({ status: 0, responseBody: "transport_failed" });
    expect(String(failure)).not.toContain("canary");
  });
});
