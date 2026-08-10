import {
  CallbackIntentObservationReceiptEnvelopeV1Schema,
  CompletionAssessmentReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
} from '@opentag/core';
import type { GovernedCallbackEnqueueContext } from '@opentag/store';
import { describe, expect, it, vi } from 'vitest';
import {
  buildGovernedCallbackIntent,
  createGovernedCallbackRuntime,
  type CallbackMessage,
  type GovernedCallbackWorker,
  type GovernedCallbackWorkerOptions,
} from '../src/index.js';

const NOW = '2026-08-10T08:00:00.000Z';
const DIGEST = `sha256:${'1'.repeat(64)}`;

async function withDigests<T extends { payload: unknown }>(value: T) {
  const withPayloadDigest = {
    ...value,
    payloadDigest: await computeControlPayloadDigestV1(value.payload),
  };
  return {
    ...withPayloadDigest,
    receiptDigest: await computeControlReceiptDigestV1(withPayloadDigest),
  };
}

async function readyContext(input: {
  destinationId?: string;
  organizationId?: string;
  credentialId?: string;
  runId?: string;
  workThreadId?: string;
  assessmentId?: string;
} = {}): Promise<GovernedCallbackEnqueueContext> {
  const destinationId = input.destinationId ?? 'cloud_1';
  const organizationId = input.organizationId ?? 'org_1';
  const runId = input.runId ?? 'run_1';
  const workThreadId = input.workThreadId ?? 'work_thread_1';
  const assessmentId = input.assessmentId ?? 'assessment_1';
  const credentialId = input.credentialId ?? 'credential_secret_ref';
  const producer = {
    kind: 'local_opentag' as const,
    id: 'local_opentag',
    credentialId,
    registrationGeneration: 1,
  };
  const attempt = {
    attemptId: 'attempt_1',
    attemptNumber: 1,
    epoch: 1,
    fencingTokenDigest: `sha256:${'2'.repeat(64)}`,
  };
  const assessmentReceipt = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
    await withDigests({
      schemaVersion: 1 as const,
      protocolVersion: '1.0' as const,
      receiptKind: 'completion_assessment' as const,
      receiptId: `assessment_receipt_${organizationId}`,
      organizationId,
      operationId: `assessment_operation_${organizationId}`,
      requiredCapabilities: ['relay.completion-assessment.v1'] as const,
      producer,
      identity: {
        namespace: 'opentag.control.receipt/completion-assessment/v1',
        parts: [organizationId, workThreadId, assessmentId],
      },
      predecessorReceiptDigests: [DIGEST],
      observedAt: NOW,
      runId,
      workThreadId,
      attempt,
      payload: {
        assessmentId,
        workThreadId,
        contract: {
          contractId: 'contract_1',
          version: 1,
          cycle: 1,
          mode: 'governed' as const,
          contentDigest: DIGEST,
        },
        admissionPolicySnapshot: { snapshotId: 'policy_1', digest: DIGEST },
        runId,
        attempt,
        executorResultReceiptRef: {
          receiptId: `lifecycle_${'1'.repeat(64)}`,
          operationId: `op_${'1'.repeat(64)}`,
          requestId: `req_${'1'.repeat(64)}`,
          requestDigest: DIGEST,
          resultDigest: DIGEST,
        },
        assessmentInputDigest: DIGEST,
        evidenceReceiptDigests: [DIGEST],
        gateResults: [{
          gateId: 'checks',
          state: 'satisfied' as const,
          reasonCode: 'verification_passed',
          evidenceReceiptDigests: [DIGEST],
        }],
        conclusion: 'satisfied' as const,
        assessedAt: NOW,
        assessedBy: 'local_opentag' as const,
      },
    }),
  );
  return {
    outcome: 'ready',
    destinationId,
    organizationId,
    runnerId: 'runner_1',
    producer,
    sourceThreadIdentityDigest: `sha256:${'3'.repeat(64)}`,
    assessmentReceipt,
    completionOperationId: `op_${'1'.repeat(64)}`,
    authority: {
      ...attempt,
      admissionId: 'admission_1',
      admissionOperationId: 'admission_operation_1',
      claimOperationId: 'claim_operation_1',
    },
  };
}

function callbackMessage(runId = 'run_1'): CallbackMessage {
  return {
    runId,
    kind: 'final',
    provider: 'github',
    uri: 'https://api.github.com/repos/acme/demo/issues/7/comments',
    body: 'verified completion',
    statusMessageKey: 'completion-status',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'verified' } }],
    rich: { provider: 'github', payload: { state: 'satisfied' } },
  };
}

function workerHarness() {
  const workers: Array<{
    options: GovernedCallbackWorkerOptions;
    worker: GovernedCallbackWorker;
    start: ReturnType<typeof vi.fn>;
    wake: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const factory = (options: GovernedCallbackWorkerOptions): GovernedCallbackWorker => {
    const start = vi.fn(async () => {});
    const wake = vi.fn();
    const stop = vi.fn(async () => {});
    const worker = { start, wake, stop, drain: vi.fn(async () => {}) };
    workers.push({ options, worker, start, wake, stop });
    return worker;
  };
  return { workers, factory };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledTimeouts() {
  let nextId = 1;
  let unrefCalls = 0;
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  type Handle = ReturnType<typeof globalThis.setTimeout> & { id: number };
  const setTimeout = ((callback: () => void, delayMs?: number) => {
    const handle = {
      id: nextId++,
      unref() { unrefCalls += 1; },
    } as Handle;
    callbacks.set(handle.id, callback);
    delays.push(delayMs ?? 0);
    return handle;
  }) as typeof globalThis.setTimeout;
  const clearTimeout = ((handle: Handle) => {
    callbacks.delete(handle.id);
  }) as typeof globalThis.clearTimeout;
  return {
    setTimeout,
    clearTimeout,
    delays,
    get unrefCalls() { return unrefCalls; },
    get pendingCount() { return callbacks.size; },
    runNext() {
      const next = callbacks.entries().next().value as
        | [number, () => void]
        | undefined;
      if (!next) throw new Error('No controlled timeout is pending.');
      callbacks.delete(next[0]);
      next[1]();
    },
    runAll() {
      while (callbacks.size > 0) this.runNext();
    },
  };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Condition was not met.');
}

function runtimeRepo(input: {
  scopes?: Array<{ destinationId: string; organizationId: string }>;
  enqueue?: (...args: unknown[]) => unknown;
}) {
  return {
    listGovernedCallbackScopes: vi.fn(async () => input.scopes ?? []),
    enqueueGovernedCallbackIntent: vi.fn(input.enqueue ?? (async () => ({
      outcome: 'created',
      intent: {},
    }))),
  } as never;
}

describe('governed callback runtime', () => {
  it('builds a deterministic schema-valid intent with exact lineage and payload digest', async () => {
    const context = await readyContext();
    const message = callbackMessage();
    const first = await buildGovernedCallbackIntent({
      context,
      message,
      transitionKey: 'completion-transition:assessment_1:satisfied',
    });
    const replay = await buildGovernedCallbackIntent({
      context,
      message: { ...message },
      transitionKey: 'completion-transition:assessment_1:satisfied',
    });
    expect(replay).toEqual(first);
    expect(CallbackIntentObservationReceiptEnvelopeV1Schema.parse(first.receipt))
      .toEqual(first.receipt);
    expect(first.receipt.predecessorReceiptDigests).toEqual([
      context.assessmentReceipt.receiptDigest,
    ]);
    expect(first.receipt.payload).toMatchObject({
      assessmentRef: context.assessmentReceipt.payload.assessmentId,
      assessmentDigest: context.assessmentReceipt.receiptDigest,
      sourceThreadIdentityDigest: context.sourceThreadIdentityDigest,
      createdAt: context.assessmentReceipt.payload.assessedAt,
    });
    await expect(computeControlPayloadDigestV1({
      method: 'POST',
      mode: message.kind,
      target: message.uri,
      body: message.body,
      threadKey: null,
      agentId: null,
      statusMessageKey: message.statusMessageKey,
      blocks: message.blocks,
      rich: message.rich,
    })).resolves.toBe(first.receipt.payload.payloadDigest);
  });

  it('enqueues idempotently and starts then wakes one worker for the scope', async () => {
    const context = await readyContext();
    const repo = runtimeRepo({});
    repo.enqueueGovernedCallbackIntent
      .mockResolvedValueOnce({ outcome: 'created', intent: {} })
      .mockResolvedValueOnce({ outcome: 'replayed', intent: {} });
    const harness = workerHarness();
    const runtime = createGovernedCallbackRuntime({
      repo,
      sink: { async deliver() { return { handled: false }; } },
      workerFactory: harness.factory,
    });
    const input = {
      context,
      message: callbackMessage(),
      transitionKey: 'completion-transition:assessment_1:satisfied',
    };
    const first = await runtime.enqueue(input);
    const replay = await runtime.enqueue(input);
    expect(first.outcome).toBe('created');
    expect(replay).toEqual({ ...first, outcome: 'replayed' });
    expect(repo.enqueueGovernedCallbackIntent).toHaveBeenCalledTimes(2);
    expect(repo.enqueueGovernedCallbackIntent.mock.calls[0]).toEqual(
      repo.enqueueGovernedCallbackIntent.mock.calls[1],
    );
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.start).toHaveBeenCalledTimes(1);
    expect(harness.workers[0]!.wake).toHaveBeenCalledTimes(2);
  });

  it('returns after durable enqueue without awaiting the worker provider drain', async () => {
    let releaseStart!: () => void;
    const startPending = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const wake = vi.fn();
    const runtime = createGovernedCallbackRuntime({
      repo: runtimeRepo({}),
      sink: { async deliver() { return { handled: false }; } },
      workerFactory: () => ({
        start: vi.fn(() => startPending),
        stop: vi.fn(async () => {}),
        wake,
        drain: vi.fn(async () => {}),
      }),
    });
    await expect(runtime.enqueue({
      context: await readyContext(),
      message: callbackMessage(),
      transitionKey: 'transition_nonblocking_enqueue',
    })).resolves.toMatchObject({ outcome: 'created' });
    expect(wake).toHaveBeenCalledOnce();
    releaseStart();
    await runtime.stop();
  });

  it('retries a dynamically created scope after first-start failure without another enqueue', async () => {
    const timeouts = controlledTimeouts();
    const repo = runtimeRepo({});
    const deliver = vi.fn(async () => ({ handled: false as const }));
    const stop = vi.fn(async () => {});
    let startCalls = 0;
    const runtime = createGovernedCallbackRuntime({
      repo,
      sink: { deliver },
      retryBaseMs: 10,
      retryMaxMs: 20,
      setTimeout: timeouts.setTimeout,
      clearTimeout: timeouts.clearTimeout,
      workerFactory: () => ({
        async start() {
          startCalls += 1;
          if (startCalls === 1) throw new Error('first drain failed');
          await deliver(callbackMessage());
        },
        stop,
        wake() {},
        async drain() {},
      }),
    });

    await runtime.enqueue({
      context: await readyContext(),
      message: callbackMessage(),
      transitionKey: 'transition_retry_dynamic_scope',
    });
    await waitForCondition(() => timeouts.pendingCount === 1);
    expect(repo.enqueueGovernedCallbackIntent).toHaveBeenCalledTimes(1);
    expect(startCalls).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(timeouts.unrefCalls).toBe(1);

    timeouts.runNext();
    await waitForCondition(() => deliver.mock.calls.length === 1);
    expect(startCalls).toBe(2);
    expect(repo.enqueueGovernedCallbackIntent).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(timeouts.pendingCount).toBe(0);
    await runtime.stop();
  });

  it('cancels a dynamic-scope retry on stop and never resurrects the worker', async () => {
    const timeouts = controlledTimeouts();
    const start = vi.fn(async () => { throw new Error('first drain failed'); });
    const stop = vi.fn(async () => {});
    const runtime = createGovernedCallbackRuntime({
      repo: runtimeRepo({}),
      sink: { async deliver() { return { handled: false }; } },
      retryBaseMs: 10,
      setTimeout: timeouts.setTimeout,
      clearTimeout: timeouts.clearTimeout,
      workerFactory: () => ({ start, stop, wake() {}, async drain() {} }),
    });

    await runtime.enqueue({
      context: await readyContext(),
      message: callbackMessage(),
      transitionKey: 'transition_cancel_dynamic_retry',
    });
    await waitForCondition(() => timeouts.pendingCount === 1);
    await runtime.stop();

    expect(timeouts.pendingCount).toBe(0);
    timeouts.runAll();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('serializes repeated dynamic-scope failures with a capped retry delay', async () => {
    const timeouts = controlledTimeouts();
    const start = vi.fn(async () => { throw new Error('drain failed'); });
    const runtime = createGovernedCallbackRuntime({
      repo: runtimeRepo({}),
      sink: { async deliver() { return { handled: false }; } },
      retryBaseMs: 10,
      retryMaxMs: 20,
      setTimeout: timeouts.setTimeout,
      clearTimeout: timeouts.clearTimeout,
      workerFactory: () => ({
        start,
        async stop() {},
        wake() {},
        async drain() {},
      }),
    });

    await runtime.enqueue({
      context: await readyContext(),
      message: callbackMessage(),
      transitionKey: 'transition_bounded_dynamic_retry',
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitForCondition(() => timeouts.pendingCount === 1);
      expect(start).toHaveBeenCalledTimes(attempt);
      expect(timeouts.pendingCount).toBe(1);
      if (attempt < 3) timeouts.runNext();
    }
    expect(timeouts.delays).toEqual([10, 20, 20]);
    await runtime.stop();
    expect(timeouts.pendingCount).toBe(0);
  });

  it('waits for an in-flight dynamic retry start before stopping', async () => {
    const timeouts = controlledTimeouts();
    const retryStart = deferred();
    const stop = vi.fn(async () => {});
    let startCalls = 0;
    const runtime = createGovernedCallbackRuntime({
      repo: runtimeRepo({}),
      sink: { async deliver() { return { handled: false }; } },
      retryBaseMs: 10,
      setTimeout: timeouts.setTimeout,
      clearTimeout: timeouts.clearTimeout,
      workerFactory: () => ({
        start() {
          startCalls += 1;
          return startCalls === 1
            ? Promise.reject(new Error('first drain failed'))
            : retryStart.promise;
        },
        stop,
        wake() {},
        async drain() {},
      }),
    });

    await runtime.enqueue({
      context: await readyContext(),
      message: callbackMessage(),
      transitionKey: 'transition_stop_during_dynamic_retry',
    });
    await waitForCondition(() => timeouts.pendingCount === 1);
    timeouts.runNext();
    expect(startCalls).toBe(2);

    let stopped = false;
    const stopTask = runtime.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(stop).not.toHaveBeenCalled();

    retryStart.resolve();
    await stopTask;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(timeouts.pendingCount).toBe(0);
  });

  it('isolates workers by destination and organization without credential-bearing keys', async () => {
    const repo = runtimeRepo({});
    const harness = workerHarness();
    const runtime = createGovernedCallbackRuntime({
      repo,
      sink: { async deliver() { return { handled: false }; } },
      workerFactory: harness.factory,
    });
    const contexts = await Promise.all([
      readyContext({
        destinationId: 'cloud_a',
        organizationId: 'org_a',
        credentialId: 'credential_private_a',
      }),
      readyContext({
        destinationId: 'cloud_b',
        organizationId: 'org_b',
        credentialId: 'credential_private_b',
        runId: 'run_b',
        workThreadId: 'thread_b',
        assessmentId: 'assessment_b',
      }),
    ]);
    await runtime.enqueue({
      context: contexts[0]!,
      message: callbackMessage(),
      transitionKey: 'transition_a',
    });
    await runtime.enqueue({
      context: contexts[1]!,
      message: callbackMessage('run_b'),
      transitionKey: 'transition_b',
    });
    expect(harness.workers.map(({ options }) => ({
      destinationId: options.destinationId,
      organizationId: options.organizationId,
    }))).toEqual([
      { destinationId: 'cloud_a', organizationId: 'org_a' },
      { destinationId: 'cloud_b', organizationId: 'org_b' },
    ]);
  });

  it('discovers and starts persisted scopes on restart, absorbs reporter failures, and stops all', async () => {
    const scopes = [
      { destinationId: 'cloud_a', organizationId: 'org_a' },
      { destinationId: 'cloud_b', organizationId: 'org_b' },
    ];
    const repo = runtimeRepo({ scopes });
    const harness = workerHarness();
    const reported: unknown[] = [];
    const runtime = createGovernedCallbackRuntime({
      repo,
      sink: { async deliver() { return { handled: false }; } },
      workerFactory: harness.factory,
      onError: async (error) => {
        reported.push(error);
        throw new Error('reporter failed');
      },
    });
    await Promise.all([runtime.start(), runtime.start()]);
    expect(repo.listGovernedCallbackScopes).toHaveBeenCalledTimes(1);
    expect(harness.workers.map(({ start }) => start.mock.calls.length)).toEqual([1, 1]);
    await expect(harness.workers[0]!.options.onError?.(
      new Error('credential_private body=verified completion'),
    ))
      .resolves.toBeUndefined();
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toBe('governed_callback_worker_failed');
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(harness.workers.map(({ stop }) => stop.mock.calls.length)).toEqual([1, 1]);
  });

  it('rolls back every persisted-scope worker when one startup fails', async () => {
    const failure = new Error('startup drain failed');
    const harness = workerHarness();
    let workerIndex = 0;
    const runtime = createGovernedCallbackRuntime({
      repo: runtimeRepo({
        scopes: [
          { destinationId: 'cloud_a', organizationId: 'org_a' },
          { destinationId: 'cloud_b', organizationId: 'org_b' },
        ],
      }),
      sink: { async deliver() { return { handled: false }; } },
      workerFactory: (options) => {
        const worker = harness.factory(options);
        const current = harness.workers[workerIndex++]!;
        if (workerIndex === 2) current.start.mockRejectedValueOnce(failure);
        return worker;
      },
    });
    await expect(runtime.start()).rejects.toBe(failure);
    expect(harness.workers).toHaveLength(2);
    expect(harness.workers.map(({ stop }) => stop.mock.calls.length)).toEqual([1, 1]);
  });

  it('retries discovery with fresh workers after a rolled-back startup', async () => {
    const scopes = [
      { destinationId: 'cloud_a', organizationId: 'org_a' },
      { destinationId: 'cloud_b', organizationId: 'org_b' },
    ];
    const repo = runtimeRepo({ scopes });
    const harness = workerHarness();
    let creation = 0;
    const runtime = createGovernedCallbackRuntime({
      repo,
      sink: { async deliver() { return { handled: false }; } },
      workerFactory: (options) => {
        const worker = harness.factory(options);
        creation += 1;
        if (creation === 2) harness.workers.at(-1)!.start
          .mockRejectedValueOnce(new Error('first startup failed'));
        return worker;
      },
    });
    await expect(runtime.start()).rejects.toThrow('first startup failed');
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(repo.listGovernedCallbackScopes).toHaveBeenCalledTimes(2);
    expect(harness.workers).toHaveLength(4);
    expect(harness.workers.slice(0, 2).map(({ stop }) => stop.mock.calls.length))
      .toEqual([1, 1]);
    expect(harness.workers.slice(2).map(({ start }) => start.mock.calls.length))
      .toEqual([1, 1]);
    await runtime.stop();
    expect(harness.workers.slice(2).map(({ stop }) => stop.mock.calls.length))
      .toEqual([1, 1]);
  });

  it('fails closed on context and assessment lineage mismatches before Store or workers', async () => {
    const cases: Array<{
      name: string;
      mutate: (context: GovernedCallbackEnqueueContext, message: CallbackMessage) => void;
    }> = [
      {
        name: 'organization',
        mutate(context) { context.organizationId = 'org_other'; },
      },
      {
        name: 'producer credential',
        mutate(context) { context.producer.credentialId = 'credential_other'; },
      },
      {
        name: 'producer generation',
        mutate(context) { context.producer.registrationGeneration = 2; },
      },
      {
        name: 'assessment work thread lineage',
        mutate(context) {
          context.assessmentReceipt = {
            ...context.assessmentReceipt,
            workThreadId: 'work_thread_other',
          } as typeof context.assessmentReceipt;
        },
      },
      {
        name: 'assessment run lineage',
        mutate(context) {
          context.assessmentReceipt = {
            ...context.assessmentReceipt,
            runId: 'run_other',
          } as typeof context.assessmentReceipt;
        },
      },
      {
        name: 'message run lineage',
        mutate(_context, message) { message.runId = 'run_other'; },
      },
      {
        name: 'assessment digest integrity',
        mutate(context, message) {
          context.assessmentReceipt = {
            ...context.assessmentReceipt,
            runId: 'run_other',
            payload: { ...context.assessmentReceipt.payload, runId: 'run_other' },
          } as typeof context.assessmentReceipt;
          message.runId = 'run_other';
        },
      },
    ];
    for (const testCase of cases) {
      const repo = runtimeRepo({});
      const harness = workerHarness();
      const runtime = createGovernedCallbackRuntime({
        repo,
        sink: { async deliver() { return { handled: false }; } },
        workerFactory: harness.factory,
      });
      const context = await readyContext();
      const message = callbackMessage();
      testCase.mutate(context, message);
      await expect(runtime.enqueue({
        context,
        message,
        transitionKey: `transition_${testCase.name}`,
      }), testCase.name).rejects.toThrow('governed_callback_runtime_invalid');
      expect(repo.enqueueGovernedCallbackIntent, testCase.name).not.toHaveBeenCalled();
      expect(harness.workers, testCase.name).toEqual([]);
    }
  });

  it('propagates enqueue conflicts before starting or waking a worker', async () => {
    const conflict = new Error('GOVERNED_CALLBACK_CONFLICT');
    const repo = runtimeRepo({ enqueue: async () => { throw conflict; } });
    const harness = workerHarness();
    const runtime = createGovernedCallbackRuntime({
      repo,
      sink: { async deliver() { return { handled: false }; } },
      workerFactory: harness.factory,
    });
    await expect(runtime.enqueue({
      context: await readyContext(),
      message: callbackMessage(),
      transitionKey: 'transition_conflict',
    })).rejects.toBe(conflict);
    expect(harness.workers).toEqual([]);
  });
});
