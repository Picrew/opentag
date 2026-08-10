import {
  HostedCompleteRequestV1Schema,
  HostedLifecycleReceiptEnvelopeV1Schema,
  HostedHeartbeatRequestV1Schema,
  buildHostedLifecycleRequestV1,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeHostedClaimFencingTokenDigestV1,
  computeHostedLifecycleRequestIdV1,
  type HostedLifecycleActionV1,
  type HostedLifecycleReceiptEnvelopeV1,
  type HostedLifecycleRequestV1,
} from '@opentag/core';
import { describe, expect, it, vi } from 'vitest';
import { createOpenTagClient } from '../src/index.js';

const ORGANIZATION_ID = 'org_1';
const CREDENTIAL_ID = 'credential_1';
const RUNNER_ID = 'runner_1';
const RUN_ID = 'run_1';
const DIGEST = `sha256:${'1'.repeat(64)}`;

function response(
  body: unknown,
  status: number,
  url: string,
  headers?: HeadersInit,
): Response {
  const result = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

function runtimeClient(fetchImpl: typeof fetch) {
  return createOpenTagClient({
    dispatcherUrl: 'https://control.example',
    pairingToken: 'legacy_pairing_token_must_not_be_used',
    controlCredential: { kind: 'runtime', token: 'runtime_secret' },
    fetchImpl,
  });
}

async function requestFor(action: HostedLifecycleActionV1) {
  const common = {
    organizationId: ORGANIZATION_ID,
    runnerId: RUNNER_ID,
    runId: RUN_ID,
    attempt: {
      attemptId: 'attempt_1',
      attemptNumber: 1,
      epoch: 1,
      fencingToken: 'raw_fence',
      fencingTokenDigest: await computeHostedClaimFencingTokenDigestV1(
        'raw_fence',
      ),
    },
    occurredAt: '2026-08-10T00:00:00.000Z',
  } as const;
  if (action === 'heartbeat') {
    return buildHostedLifecycleRequestV1({
      ...common,
      action,
      expectedLeaseExpiresAt: '2026-08-10T00:01:00.000Z',
    });
  }
  if (action === 'running') {
    return buildHostedLifecycleRequestV1({
      ...common,
      action,
      executorId: 'codex',
      executorCapabilityDigest: DIGEST,
      runTimeoutMs: 60_000,
    });
  }
  if (action === 'reject-start') {
    return buildHostedLifecycleRequestV1({
      ...common,
      action,
      executorId: 'codex',
      reasonCode: 'executor_unavailable',
    });
  }
  if (action === 'progress') {
    return buildHostedLifecycleRequestV1({
      ...common,
      action,
      progressId: `progress_${'2'.repeat(64)}`,
      progressDigest: DIGEST,
    });
  }
  return buildHostedLifecycleRequestV1({
    ...common,
    action,
    conclusion: 'success',
    reasonCode: 'executor_success',
    resultDigest: DIGEST,
    artifactDigests: [],
    evidenceDigests: [],
  });
}

async function receiptFor(
  action: HostedLifecycleActionV1,
  request: HostedLifecycleRequestV1,
): Promise<HostedLifecycleReceiptEnvelopeV1> {
  const operation = action === 'reject-start'
    ? 'reject_start'
    : action === 'complete'
      ? 'executor_result'
      : action;
  const payload = action === 'heartbeat'
    ? {
        operation,
        occurredAt: request.occurredAt,
        leaseExpiresAt: '2026-08-10T00:02:00.000Z',
      }
    : action === 'running'
      ? {
          operation,
          occurredAt: request.occurredAt,
          executorId: 'executorId' in request ? request.executorId : '',
          executorCapabilityDigest: 'executorCapabilityDigest' in request
            ? request.executorCapabilityDigest
            : DIGEST,
          ...('runTimeoutMs' in request && request.runTimeoutMs
            ? { runTimeoutMs: request.runTimeoutMs }
            : {}),
        }
      : action === 'reject-start'
        ? {
            operation,
            occurredAt: request.occurredAt,
            executorId: 'executorId' in request ? request.executorId : '',
            reasonCode: 'reasonCode' in request
              ? request.reasonCode
              : 'unknown_safe_failure',
          }
        : action === 'progress'
          ? {
              operation,
              occurredAt: request.occurredAt,
              progressId: 'progressId' in request ? request.progressId : '',
              progressDigest: 'progressDigest' in request
                ? request.progressDigest
                : DIGEST,
            }
          : {
              operation,
              occurredAt: request.occurredAt,
              conclusion: 'conclusion' in request
                ? request.conclusion
                : 'failure',
              reasonCode: 'reasonCode' in request
                ? request.reasonCode
                : 'unknown_failure',
              resultDigest: 'resultDigest' in request
                ? request.resultDigest
                : DIGEST,
              artifactDigests: 'artifactDigests' in request
                ? request.artifactDigests
                : [],
              evidenceDigests: 'evidenceDigests' in request
                ? request.evidenceDigests
                : [],
            };
  const base = {
    schemaVersion: 1 as const,
    protocolVersion: '1.0' as const,
    receiptKind: 'attempt_lifecycle' as const,
    receiptId: `lifecycle_${'3'.repeat(64)}`,
    organizationId: ORGANIZATION_ID,
    requestId: request.requestId,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    requiredCapabilities: ['relay.lifecycle.v1'] as const,
    producer: {
      kind: 'runner' as const,
      id: RUNNER_ID,
      credentialId: CREDENTIAL_ID,
    },
    identity: {
      namespace: 'opentag.control.receipt/attempt-lifecycle/v1' as const,
      parts: [
        ORGANIZATION_ID,
        RUN_ID,
        request.attempt.attemptId,
        operation,
        request.operationId,
      ] as const,
    },
    observedAt: '2026-08-10T00:00:01.000Z',
    payloadDigest: await computeControlPayloadDigestV1(payload),
    runId: RUN_ID,
    attempt: {
      attemptId: request.attempt.attemptId,
      attemptNumber: request.attempt.attemptNumber,
      epoch: request.attempt.epoch,
      fencingTokenDigest: request.attempt.fencingTokenDigest,
    },
    payload,
  };
  return {
    ...base,
    receiptDigest: await computeControlReceiptDigestV1(base),
  } as HostedLifecycleReceiptEnvelopeV1;
}

function input(request: HostedLifecycleRequestV1) {
  return {
    organizationId: ORGANIZATION_ID,
    credentialId: CREDENTIAL_ID,
    runnerId: RUNNER_ID,
    runId: RUN_ID,
    request,
  };
}

describe('hosted lifecycle Control V1 transports', () => {
  it('posts strict requests and verifies 201 fresh plus 200 replay receipts', async () => {
    const actions = [
      'heartbeat',
      'running',
      'progress',
      'complete',
      'reject-start',
    ] as const;
    const requests = await Promise.all(actions.map(requestFor));
    let index = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const action = actions[index];
      const request = requests[index];
      index += 1;
      return response(
        await receiptFor(action, request),
        index === 1 ? 201 : 200,
        String(url),
      );
    });
    const client = runtimeClient(fetchImpl);

    const results = [
      await client.heartbeatHostedRunControlV1(input(requests[0])),
      await client.markHostedRunRunningControlV1(input(requests[1])),
      await client.progressHostedRunControlV1(input(requests[2])),
      await client.completeHostedRunControlV1(input(requests[3])),
      await client.rejectHostedAttemptStartControlV1(input(requests[4])),
    ];

    expect(results.map(({ status, replayed }) => ({ status, replayed }))).toEqual([
      { status: 201, replayed: false },
      { status: 200, replayed: true },
      { status: 200, replayed: true },
      { status: 200, replayed: true },
      { status: 200, replayed: true },
    ]);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://control.example/v1/runners/runner_1/runs/run_1/heartbeat',
      'https://control.example/v1/runners/runner_1/runs/run_1/running',
      'https://control.example/v1/runners/runner_1/runs/run_1/progress',
      'https://control.example/v1/runners/runner_1/runs/run_1/complete',
      'https://control.example/v1/runners/runner_1/runs/run_1/reject-start',
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body))))
      .toEqual(requests);
  });

  it('accepts caller-stable operation identity independent of the digest', async () => {
    const built = await requestFor('heartbeat');
    const operationId = `op_${'f'.repeat(64)}`;
    const request = HostedHeartbeatRequestV1Schema.parse({
      ...built,
      operationId,
      requestId: await computeHostedLifecycleRequestIdV1({
        operationId,
        requestDigest: built.requestDigest,
      }),
    });
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      response(await receiptFor('heartbeat', request), 201, String(url)),
    );

    await expect(runtimeClient(fetchImpl).heartbeatHostedRunControlV1(input(request)))
      .resolves.toMatchObject({ status: 201, replayed: false });
  });

  it('rejects legacy request fields and mismatched receipts before acceptance', async () => {
    const request = await requestFor('heartbeat');
    expect(HostedHeartbeatRequestV1Schema.safeParse({
      ...request,
      idempotencyKey: 'legacy',
    }).success).toBe(false);
    const receipt = await receiptFor('heartbeat', request);
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      response({ ...receipt, requestDigest: DIGEST }, 201, String(url)),
    );

    await expect(runtimeClient(fetchImpl).heartbeatHostedRunControlV1(input(request)))
      .rejects.toThrow(/invalid_control_v1_response/u);
  });

  it('rejects secret-like, free-form, and conclusion-mismatched complete reasons', async () => {
    const request = await requestFor('complete');
    for (const reasonCode of [
      'ghp_0123456789abcdef',
      ['sk', 'live', '0123456789abcdef'].join('_'),
      'raw-token',
      'private-message',
      'unknown_safe_failure',
      'executor_success',
    ]) {
      expect(HostedCompleteRequestV1Schema.safeParse({
        ...request,
        conclusion: 'failure',
        reasonCode,
      }).success).toBe(false);
    }

    const validReceipt = await receiptFor('complete', request);
    const invalidReceipt = {
      ...validReceipt,
      payload: {
        ...validReceipt.payload,
        operation: 'executor_result' as const,
        conclusion: 'failure' as const,
        reasonCode: 'executor_success',
      },
    };
    expect(HostedLifecycleReceiptEnvelopeV1Schema.safeParse(invalidReceipt).success)
      .toBe(false);
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      response(invalidReceipt, 201, String(url)),
    );
    await expect(runtimeClient(fetchImpl).completeHostedRunControlV1(input(request)))
      .rejects.toThrow(/invalid_control_v1_response/u);
  });

  it('requires exact request identity and Retry-After parity on 429', async () => {
    const request = await requestFor('heartbeat');
    const error = {
      schemaVersion: 1,
      protocolVersion: '1.0',
      error: 'rate_limited',
      message: 'Try again later.',
      requestId: request.requestId,
      retryAfterSeconds: 7,
    };
    const matching = vi.fn<typeof fetch>(async (url) =>
      response(error, 429, String(url), { 'retry-after': '7' }),
    );
    await expect(runtimeClient(matching).heartbeatHostedRunControlV1(input(request)))
      .rejects.toMatchObject({
        name: 'OpenTagControlV1HttpError',
        status: 429,
        code: 'rate_limited',
        requestId: request.requestId,
        retryAfterSeconds: 7,
      });

    const mismatched = vi.fn<typeof fetch>(async (url) =>
      response(error, 429, String(url), { 'retry-after': '8' }),
    );
    await expect(runtimeClient(mismatched).heartbeatHostedRunControlV1(input(request)))
      .rejects.toThrow(/invalid_control_v1_response/u);
  });
});
