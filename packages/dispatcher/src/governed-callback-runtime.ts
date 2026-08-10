import { createHash } from 'node:crypto';
import {
  CallbackIntentObservationReceiptEnvelopeV1Schema,
  CompletionAssessmentReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  type CallbackIntentObservationReceiptEnvelopeV1,
} from '@opentag/core';
import {
  createOpenTagRepository,
  type GovernedCallbackEnqueueContext,
  type GovernedCallbackScope,
} from '@opentag/store';
import {
  createGovernedCallbackWorker,
  type GovernedCallbackWorker,
  type GovernedCallbackWorkerOptions,
} from './governed-callback-worker.js';
import type { CallbackMessage, CallbackSink } from './server.js';

type Repository = ReturnType<typeof createOpenTagRepository>;

type RuntimeRepository = Pick<
  Repository,
  | 'enqueueGovernedCallbackIntent'
  | 'listGovernedCallbackScopes'
  | 'recoverExpiredGovernedCallbacks'
  | 'claimGovernedCallbackIntents'
  | 'beginGovernedCallbackSending'
  | 'quarantineGovernedCallbackAttempt'
  | 'finalizeGovernedCallbackAttempt'
  | 'reconcileGovernedCallbackOutcome'
  | 'getPriorAcceptedGovernedGitHubResource'
>;

type WorkerFactory = (options: GovernedCallbackWorkerOptions) => GovernedCallbackWorker;

export type GovernedCallbackRuntimeEnqueueResult =
  | {
      outcome: 'created';
      localIntentId: string;
      receipt: CallbackIntentObservationReceiptEnvelopeV1;
    }
  | {
      outcome: 'replayed';
      localIntentId: string;
      receipt: CallbackIntentObservationReceiptEnvelopeV1;
    };

export type GovernedCallbackRuntime = {
  start(): Promise<void>;
  enqueue(input: {
    context: GovernedCallbackEnqueueContext;
    message: CallbackMessage;
    transitionKey: string;
  }): Promise<GovernedCallbackRuntimeEnqueueResult>;
  stop(): Promise<void>;
};

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex')}`;
}

function scopeKey(scope: GovernedCallbackScope): string {
  return JSON.stringify([scope.destinationId, scope.organizationId]);
}

function deliveryFor(message: CallbackMessage) {
  return {
    provider: 'github' as const,
    mode: message.kind,
    target: message.uri,
    body: message.body,
    ...(message.threadKey ? { threadKey: message.threadKey } : {}),
    ...(message.agentId ? { agentId: message.agentId } : {}),
    ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
    ...(message.blocks ? { blocks: message.blocks } : {}),
    ...(message.rich !== undefined ? { rich: message.rich } : {}),
  };
}

async function callbackPayloadDigest(message: CallbackMessage): Promise<string> {
  return computeControlPayloadDigestV1({
    method: 'POST',
    mode: message.kind,
    target: message.uri,
    body: message.body,
    threadKey: message.threadKey ?? null,
    agentId: message.agentId ?? null,
    statusMessageKey: message.statusMessageKey ?? null,
    blocks: message.blocks ?? null,
    rich: message.rich ?? null,
  });
}

export async function buildGovernedCallbackIntent(input: {
  context: GovernedCallbackEnqueueContext;
  message: CallbackMessage;
  transitionKey: string;
}): Promise<{
  idempotencyKey: string;
  receipt: CallbackIntentObservationReceiptEnvelopeV1;
}> {
  const { context, message } = input;
  let assessmentReceipt;
  try {
    assessmentReceipt = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
      context.assessmentReceipt,
    );
  } catch {
    throw new Error('governed_callback_runtime_invalid');
  }
  const {
    receiptDigest: assessmentReceiptDigest,
    payloadDigest: assessmentPayloadDigest,
    ...assessmentWithoutDigests
  } = assessmentReceipt;
  const computedAssessmentPayloadDigest = await computeControlPayloadDigestV1(
    assessmentReceipt.payload,
  );
  const computedAssessmentReceiptDigest = await computeControlReceiptDigestV1({
    ...assessmentWithoutDigests,
    payloadDigest: computedAssessmentPayloadDigest,
  });
  if (
    message.provider !== 'github'
    || message.runId !== assessmentReceipt.runId
    || input.transitionKey.length === 0
    || context.organizationId !== assessmentReceipt.organizationId
    || context.producer.kind !== assessmentReceipt.producer.kind
    || context.producer.id !== assessmentReceipt.producer.id
    || context.producer.credentialId !== assessmentReceipt.producer.credentialId
    || context.producer.registrationGeneration
      !== assessmentReceipt.producer.registrationGeneration
    || context.completionOperationId
      !== assessmentReceipt.payload.executorResultReceiptRef.operationId
    || context.authority.attemptId !== assessmentReceipt.attempt.attemptId
    || context.authority.attemptNumber !== assessmentReceipt.attempt.attemptNumber
    || context.authority.epoch !== assessmentReceipt.attempt.epoch
    || context.authority.fencingTokenDigest
      !== assessmentReceipt.attempt.fencingTokenDigest
    || assessmentPayloadDigest !== computedAssessmentPayloadDigest
    || assessmentReceiptDigest !== computedAssessmentReceiptDigest
  ) {
    throw new Error('governed_callback_runtime_invalid');
  }
  const payloadDigest = await callbackPayloadDigest(message);
  const semanticDigest = await computeControlPayloadDigestV1({
    transitionKey: input.transitionKey,
    assessmentReceiptDigest: assessmentReceipt.receiptDigest,
    completionOperationId: context.completionOperationId,
    payloadDigest,
  });
  const localIntentId = stableId('intent', semanticDigest);
  const operationId = stableId('callback_operation', semanticDigest);
  const createdAt = assessmentReceipt.payload.assessedAt;
  const base = {
    schemaVersion: 1 as const,
    protocolVersion: '1.0' as const,
    receiptKind: 'callback_intent_observation' as const,
    receiptId: stableId('callback_intent_receipt', semanticDigest),
    organizationId: context.organizationId,
    operationId,
    requiredCapabilities: ['relay.callback-observation.v1'] as const,
    producer: context.producer,
    identity: {
      namespace: 'opentag.control.receipt/callback-intent-observation/v1',
      parts: [
        context.organizationId,
        assessmentReceipt.workThreadId,
        localIntentId,
      ],
    },
    predecessorReceiptDigests: [assessmentReceipt.receiptDigest],
    observedAt: createdAt,
    runId: assessmentReceipt.runId,
    workThreadId: assessmentReceipt.workThreadId,
    payload: {
      localIntentId,
      assessmentRef: assessmentReceipt.payload.assessmentId,
      assessmentDigest: assessmentReceipt.receiptDigest,
      provider: 'github' as const,
      sourceThreadIdentityDigest: context.sourceThreadIdentityDigest,
      operationId,
      payloadDigest,
      createdAt,
    },
  };
  const withPayloadDigest = {
    ...base,
    payloadDigest: await computeControlPayloadDigestV1(base.payload),
  };
  const receipt = CallbackIntentObservationReceiptEnvelopeV1Schema.parse({
    ...withPayloadDigest,
    receiptDigest: await computeControlReceiptDigestV1(withPayloadDigest),
  });
  return {
    idempotencyKey: stableId('callback_enqueue', semanticDigest),
    receipt,
  };
}

export function createGovernedCallbackRuntime(input: {
  repo: RuntimeRepository;
  sink: CallbackSink;
  workerFactory?: WorkerFactory;
  onError?: (error: unknown) => void | Promise<void>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}): GovernedCallbackRuntime {
  type RetryTimer = ReturnType<typeof globalThis.setTimeout>;
  const workers = new Map<string, {
    worker: GovernedCallbackWorker;
    started: Promise<void> | undefined;
    retryAttempt: number;
    retryTimer: RetryTimer | undefined;
  }>();
  const workerFactory = input.workerFactory ?? createGovernedCallbackWorker;
  const retryBaseMs = Math.max(1, input.retryBaseMs ?? 250);
  const retryMaxMs = Math.max(retryBaseMs, input.retryMaxMs ?? 5_000);
  const setRetryTimeout = input.setTimeout ?? globalThis.setTimeout;
  const clearRetryTimeout = input.clearTimeout ?? globalThis.clearTimeout;
  let stopped = false;
  let startLatch: Promise<void> | undefined;
  let stopLatch: Promise<void> | undefined;

  const reportWorkerError = async (): Promise<void> => {
    try {
      await input.onError?.(new Error('governed_callback_worker_failed'));
    } catch {
      // Error reporting is best-effort and must never create another rejection.
    }
  };

  const ensureWorker = (scope: GovernedCallbackScope) => {
    const key = scopeKey(scope);
    let entry = workers.get(key);
    if (!entry) {
      const worker = workerFactory({
        repo: input.repo,
        sink: input.sink,
        destinationId: scope.destinationId,
        organizationId: scope.organizationId,
        onError: reportWorkerError,
      });
      entry = {
        worker,
        started: undefined,
        retryAttempt: 0,
        retryTimer: undefined,
      };
      workers.set(key, entry);
    }
    return entry;
  };

  const startWorker = async (scope: GovernedCallbackScope): Promise<GovernedCallbackWorker> => {
    const entry = ensureWorker(scope);
    entry.started ??= entry.worker.start();
    try {
      await entry.started;
    } catch (error) {
      entry.started = undefined;
      throw error;
    }
    return entry.worker;
  };

  const clearWorkerRetry = (entry: {
    retryAttempt: number;
    retryTimer: RetryTimer | undefined;
  }): void => {
    if (entry.retryTimer) {
      clearRetryTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
    }
  };

  const launchWorker = (scope: GovernedCallbackScope): GovernedCallbackWorker => {
    const key = scopeKey(scope);
    const entry = ensureWorker(scope);
    clearWorkerRetry(entry);
    if (entry.started || stopped) return entry.worker;

    const started = entry.worker.start();
    entry.started = started;
    void started.then(() => {
      if (entry.started === started) entry.retryAttempt = 0;
    }, async () => {
      if (entry.started !== started) return;
      entry.started = undefined;
      if (!stopped && workers.get(key) === entry && !entry.retryTimer) {
        const delayMs = Math.min(
          retryMaxMs,
          retryBaseMs * (2 ** Math.min(entry.retryAttempt, 30)),
        );
        entry.retryAttempt += 1;
        entry.retryTimer = setRetryTimeout(() => {
          entry.retryTimer = undefined;
          if (stopped || workers.get(key) !== entry) return;
          launchWorker(scope);
        }, delayMs);
        entry.retryTimer.unref?.();
      }
      await reportWorkerError();
    });
    return entry.worker;
  };

  const shutdownWorkers = async (): Promise<void> => {
    const entries = [...workers.values()];
    for (const entry of entries) clearWorkerRetry(entry);
    const results = await Promise.allSettled(entries.map(async (entry) => {
      try {
        await entry.started;
      } catch {
        // Startup failure is handled by the caller; shutdown still owns cleanup.
      }
      await entry.worker.stop();
    }));
    workers.clear();
    if (results.some((result) => result.status === 'rejected')) {
      await reportWorkerError();
    }
  };

  const start = (): Promise<void> => {
    if (startLatch) return startLatch;
    startLatch = (async () => {
      if (stopLatch) await stopLatch;
      stopped = false;
      const scopes = await input.repo.listGovernedCallbackScopes();
      const results = await Promise.allSettled(scopes.map(startWorker));
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) {
        stopped = true;
        await shutdownWorkers();
        throw failure.reason;
      }
    })().catch((error) => {
      stopped = true;
      throw error;
    }).finally(() => {
      startLatch = undefined;
    });
    return startLatch;
  };

  const stop = (): Promise<void> => {
    if (stopLatch) return stopLatch;
    stopped = true;
    stopLatch = (async () => {
      if (startLatch) {
        try {
          await startLatch;
        } catch {
          await reportWorkerError();
        }
      }
      await shutdownWorkers();
    })().finally(() => {
      stopLatch = undefined;
    });
    return stopLatch;
  };

  return {
    start,

    async enqueue(enqueueInput) {
      if (stopped) throw new Error('governed_callback_runtime_stopped');
      const built = await buildGovernedCallbackIntent(enqueueInput);
      const context = enqueueInput.context;
      const result = await input.repo.enqueueGovernedCallbackIntent({
        destinationId: context.destinationId,
        runnerId: context.runnerId,
        idempotencyKey: built.idempotencyKey,
        delivery: deliveryFor(enqueueInput.message),
        completionOperationId: context.completionOperationId,
        authority: context.authority,
        receipt: built.receipt,
        now: new Date(built.receipt.payload.createdAt),
      });
      if (!stopped) {
        const worker = launchWorker({
          destinationId: context.destinationId,
          organizationId: context.organizationId,
        });
        worker.wake();
      }
      return {
        outcome: result.outcome,
        localIntentId: built.receipt.payload.localIntentId,
        receipt: built.receipt,
      };
    },

    stop,
  };
}
