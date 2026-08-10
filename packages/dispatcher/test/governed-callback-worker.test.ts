import { describe, expect, it, vi } from 'vitest';
import type {
  CallbackAttemptObservationReceiptEnvelopeV1,
  CallbackProviderObservationReceiptEnvelopeV1,
} from '@opentag/core';
import { CallbackProviderOutcomeUnknownError } from '../src/callbacks.js';
import { createGovernedCallbackWorker } from '../src/governed-callback-worker.js';

const NOW = new Date('2026-08-10T08:00:00.000Z');

function claimed() {
  return {
    intent: {
      localIntentId: 'intent_1',
      idempotencyKey: 'assessment_1:satisfied',
      destinationId: 'cloud_1',
      organizationId: 'org_1',
      runnerId: 'runner_1',
      runId: 'run_1',
      workThreadId: 'thread_1',
      provider: 'github' as const,
      operationId: 'callback_operation_1',
      payloadDigest: `sha256:${'a'.repeat(64)}`,
      targetIdentityDigest: `sha256:${'f'.repeat(64)}`,
      state: 'leased' as const,
      currentAttemptId: 'callback_attempt_1',
      currentAttemptNumber: 1,
      leaseOwner: 'worker_1',
      leaseToken: 'lease_1',
      leaseExpiresAt: '2026-08-10T08:01:00.000Z',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    attempt: {
      localAttemptId: 'callback_attempt_1',
      localIntentId: 'intent_1',
      attemptNumber: 1,
      requestDigest: `sha256:${'b'.repeat(64)}`,
      state: 'leased' as const,
      leaseOwner: 'worker_1',
      leaseToken: 'lease_1',
      leaseExpiresAt: '2026-08-10T08:01:00.000Z',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    delivery: {
      id: 1,
      runId: 'run_1',
      kind: 'final' as const,
      provider: 'github' as const,
      uri: 'https://api.github.com/repos/acme/demo/issues/1/comments',
      body: 'Complete',
      threadKey: 'issue:1',
      statusMessageKey: 'run-status',
      idempotencyKey: 'governed_delivery_1',
      dispatchMode: 'governed' as const,
      governedState: 'leased' as const,
      status: 'pending' as const,
      attempts: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    producer: {
      kind: 'local_opentag' as const,
      id: 'runner_1',
      credentialId: 'credential_1',
      registrationGeneration: 1,
    },
    intentReceiptDigest: `sha256:${'c'.repeat(64)}`,
    targetIdentityDigest: `sha256:${'f'.repeat(64)}`,
    authority: {
      attemptId: 'attempt_1',
      attemptNumber: 1,
      epoch: 1,
      fencingTokenDigest: `sha256:${'d'.repeat(64)}`,
      completionOperationId: 'complete_1',
      assessmentReceiptId: 'assessment_receipt_1',
      assessmentReceiptDigest: `sha256:${'e'.repeat(64)}`,
    },
  };
}

function setup(result: unknown, options: {
  preflight?: unknown;
  prior?: unknown;
  finalize?: unknown;
  quarantine?: unknown;
  deliverError?: unknown;
  begin?: unknown;
  onError?: (error: unknown) => void | Promise<void>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  enforceDistinctReceiptOperations?: boolean;
} = {}) {
  const entry = claimed();
  const persisted = { state: 'leased' as 'leased' | 'sending' | 'accepted' };
  const repo = {
    recoverExpiredGovernedCallbacks: vi.fn(async () => ({
      requeued: 0,
      outcomeUnknown: 0,
    })),
    claimGovernedCallbackIntents: vi
      .fn()
      .mockResolvedValueOnce([entry])
      .mockResolvedValue([]),
    beginGovernedCallbackSending: vi.fn(async () => {
      const outcome = options.begin ?? {
        outcome: 'sending' as const,
        attemptedAt: NOW.toISOString(),
      };
      if (
        typeof outcome === 'object'
        && outcome !== null
        && 'outcome' in outcome
        && outcome.outcome === 'sending'
      ) persisted.state = 'sending';
      return outcome;
    }),
    quarantineGovernedCallbackAttempt: vi.fn(async () =>
      options.quarantine ?? 'quarantined' as const),
    finalizeGovernedCallbackAttempt: vi.fn(async (input: {
      attemptReceipt: CallbackAttemptObservationReceiptEnvelopeV1;
      providerReceipt?: CallbackProviderObservationReceiptEnvelopeV1;
    }) => {
      if (
        options.enforceDistinctReceiptOperations
        && input.providerReceipt
        && input.attemptReceipt.operationId === input.providerReceipt.operationId
      ) throw new Error('control_projection_operation_conflict');
      const outcome = options.finalize ?? 'finalized' as const;
      if (outcome === 'finalized' || outcome === 'replayed') {
        persisted.state = input.attemptReceipt.payload.outcome === 'accepted'
          ? 'accepted'
          : persisted.state;
      }
      return outcome;
    }),
    reconcileGovernedCallbackOutcome: vi.fn(async () => ({ outcome: 'recorded' as const })),
    getPriorAcceptedGovernedGitHubResource: vi.fn(async () =>
      options.prior ?? { outcome: 'not_found' as const }),
  };
  const sink = {
    preflight: vi.fn(async () => options.preflight ?? { handled: true as const }),
    deliver: vi.fn(async () => {
      if (options.deliverError !== undefined) throw options.deliverError;
      return result;
    }),
  };
  const worker = createGovernedCallbackWorker({
    repo: repo as never,
    sink: sink as never,
    destinationId: 'cloud_1',
    organizationId: 'org_1',
    now: () => NOW,
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
    ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
  });
  return { worker, repo, sink, persisted };
}

describe('createGovernedCallbackWorker', () => {
  it('persists accepted attempt and provider receipts from native GitHub evidence', async () => {
    const { worker, repo } = setup({
      handled: true,
      outcome: 'accepted',
      providerReceiptId: '123',
      providerResourceUri:
        'https://api.github.com/repos/acme/demo/issues/comments/123',
    });

    await worker.drain();

    const finalized = repo.finalizeGovernedCallbackAttempt.mock.calls[0]![0];
    expect(finalized.attemptReceipt.payload).toMatchObject({
      outcome: 'accepted',
      reasonCode: 'provider_accepted',
    });
    expect(finalized.providerReceipt.payload).toMatchObject({
      providerReceiptId: 'comment_123',
      resourceIdentity: 'github:comment:123',
      targetIdentityDigest: `sha256:${'f'.repeat(64)}`,
      outcome: 'succeeded',
    });
    expect(finalized.providerReceipt.predecessorReceiptDigests).toEqual([
      finalized.attemptReceipt.receiptDigest,
    ]);
  });

  it('finalizes accepted evidence with collision-free receipt operations', async () => {
    const { worker, repo, sink, persisted } = setup({
      handled: true,
      outcome: 'accepted',
      providerReceiptId: '123',
      providerResourceUri:
        'https://api.github.com/repos/acme/demo/issues/comments/123',
    }, { enforceDistinctReceiptOperations: true });

    await worker.drain();
    await worker.drain();

    const finalized = repo.finalizeGovernedCallbackAttempt.mock.calls[0]![0];
    expect(finalized.attemptReceipt.operationId).not.toBe(
      finalized.providerReceipt?.operationId,
    );
    expect(finalized.providerReceipt?.predecessorReceiptDigests).toEqual([
      finalized.attemptReceipt.receiptDigest,
    ]);
    expect(persisted.state).toBe('accepted');
    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(repo.finalizeGovernedCallbackAttempt).toHaveBeenCalledTimes(1);
  });

  it('persists rejected provider observation without claiming remote success', async () => {
    const { worker, repo } = setup({
      handled: true,
      outcome: 'rejected',
      reasonCode: 'provider_rejected',
    });

    await worker.drain();

    const finalized = repo.finalizeGovernedCallbackAttempt.mock.calls[0]![0];
    expect(finalized.attemptReceipt.payload.outcome).toBe('rejected');
    expect(finalized.providerReceipt.payload).toMatchObject({
      outcome: 'failed',
      reasonCode: 'provider_rejected',
      targetIdentityDigest: `sha256:${'f'.repeat(64)}`,
    });
    expect(finalized.providerReceipt.payload.resourceIdentity).toBe(
      'github:issue:1',
    );
  });

  it('persists unknown as attention-required evidence and never sends again', async () => {
    const { worker, repo, sink } = setup({
      handled: true,
      outcome: 'outcome_unknown',
      reasonCode: 'provider_timeout',
      nextAction: 'reconcile-provider',
      owner: 'untrusted_sink_owner',
    });

    await worker.drain();
    await worker.drain();

    const finalized = repo.finalizeGovernedCallbackAttempt.mock.calls[0]![0];
    expect(finalized.attemptReceipt.payload).toMatchObject({
      outcome: 'outcome_unknown',
      reasonCode: 'provider_timeout',
      nextAction: 'reconcile-provider',
      owner: 'runner_1',
    });
    expect(finalized.providerReceipt).toBeUndefined();
    expect(sink.deliver).toHaveBeenCalledTimes(1);
  });

  it('recovers before every claim and latches concurrent drains', async () => {
    const { worker, repo, sink } = setup({
      handled: true,
      outcome: 'accepted',
      providerReceiptId: '123',
      providerResourceUri:
        'https://api.github.com/repos/acme/demo/issues/comments/123',
    });

    await Promise.all([worker.start(), worker.drain(), worker.drain()]);
    await worker.drain();
    await worker.stop();

    expect(repo.recoverExpiredGovernedCallbacks).toHaveBeenCalledTimes(2);
    expect(repo.recoverExpiredGovernedCallbacks.mock.invocationCallOrder[0]).toBeLessThan(
      repo.claimGovernedCallbackIntents.mock.invocationCallOrder[0]!,
    );
    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(repo.beginGovernedCallbackSending).toHaveBeenCalledTimes(1);
  });

  it('quarantines preflight failure before sending or provider I/O', async () => {
    const { worker, repo, sink } = setup({ handled: false }, {
      preflight: { handled: false, reasonCode: 'callback_target_invalid' },
    });

    await worker.drain();

    expect(repo.quarantineGovernedCallbackAttempt).toHaveBeenCalledTimes(1);
    expect(repo.quarantineGovernedCallbackAttempt.mock.calls[0]![0].attemptReceipt.payload)
      .toMatchObject({
        outcome: 'attention',
        reasonCode: 'callback_target_invalid',
        nextAction: 'repair-local-callback',
      });
    expect(repo.beginGovernedCallbackSending).not.toHaveBeenCalled();
    expect(sink.deliver).not.toHaveBeenCalled();
  });

  it.each(['stale_lease', 'not_found'])(
    'surfaces an uncommitted %s preflight quarantine',
    async (outcome) => {
      const { worker, repo, sink } = setup({ handled: false }, {
        preflight: { handled: false, reasonCode: 'callback_target_invalid' },
        quarantine: outcome,
      });

      await expect(worker.drain()).rejects.toThrow(
        `governed_callback_worker_quarantine_${outcome}`,
      );
      expect(repo.quarantineGovernedCallbackAttempt).toHaveBeenCalledTimes(1);
      expect(repo.beginGovernedCallbackSending).not.toHaveBeenCalled();
      expect(sink.deliver).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['handled false', undefined, { handled: false }],
    ['generic exception', new Error('local adapter failed'), undefined],
  ])('quarantines %s after begin without inventing provider evidence', async (
    _name,
    deliverError,
    result,
  ) => {
    const { worker, repo } = setup(result, { deliverError });

    await worker.drain();

    const finalized = repo.finalizeGovernedCallbackAttempt.mock.calls[0]![0];
    expect(finalized.attemptReceipt.payload).toMatchObject({
      outcome: 'attention',
      nextAction: 'repair-local-callback',
    });
    expect(finalized.providerReceipt).toBeUndefined();
    expect(repo.reconcileGovernedCallbackOutcome).not.toHaveBeenCalled();
  });

  it('treats only the explicit provider unknown error as outcome_unknown', async () => {
    const { worker, repo } = setup(undefined, {
      deliverError: new CallbackProviderOutcomeUnknownError('provider_timeout'),
    });

    await worker.drain();

    const finalized = repo.finalizeGovernedCallbackAttempt.mock.calls[0]![0];
    expect(finalized.attemptReceipt.payload).toMatchObject({
      outcome: 'outcome_unknown',
      reasonCode: 'provider_timeout',
      nextAction: 'reconcile-provider',
    });
    expect(finalized.providerReceipt).toBeUndefined();
  });

  it('quarantines malformed terminal GitHub evidence as a local error', async () => {
    const { worker, repo } = setup({
      handled: true,
      outcome: 'accepted',
      providerReceiptId: '123',
      providerResourceUri: 'https://api.github.com/repos/acme/demo/issues/comments/456',
    });

    await worker.drain();

    const finalized = repo.finalizeGovernedCallbackAttempt.mock.calls[0]![0];
    expect(finalized.attemptReceipt.payload).toMatchObject({
      outcome: 'attention',
      reasonCode: 'callback_local_error',
    });
    expect(finalized.providerReceipt).toBeUndefined();
  });

  it('rejects accepted GitHub evidence from a different repository', async () => {
    const { worker, repo } = setup({
      handled: true,
      outcome: 'accepted',
      providerReceiptId: '123',
      providerResourceUri: 'https://api.github.com/repos/other/demo/issues/comments/123',
    });

    await worker.drain();

    const finalized = repo.finalizeGovernedCallbackAttempt.mock.calls[0]![0];
    expect(finalized.attemptReceipt.payload).toMatchObject({
      outcome: 'attention',
      reasonCode: 'callback_local_error',
    });
    expect(finalized.providerReceipt).toBeUndefined();
    expect(repo.reconcileGovernedCallbackOutcome).not.toHaveBeenCalled();
  });

  it.each(['stale_lease', 'not_found'])(
    'surfaces accepted provider evidence when finalize returns %s without resending',
    async (outcome) => {
      const { worker, repo, sink } = setup({
        handled: true,
        outcome: 'accepted',
        providerReceiptId: '123',
        providerResourceUri: 'https://api.github.com/repos/acme/demo/issues/comments/123',
      }, { finalize: outcome });

      await expect(worker.drain()).rejects.toThrow(
        `governed_callback_worker_finalize_${outcome}`,
      );
      await expect(worker.drain()).resolves.toBeUndefined();
      expect(sink.deliver).toHaveBeenCalledTimes(1);
      expect(repo.finalizeGovernedCallbackAttempt).toHaveBeenCalledTimes(1);
      expect(repo.reconcileGovernedCallbackOutcome).not.toHaveBeenCalled();
    },
  );

  it('surfaces an uncommitted local Attention finalize', async () => {
    const { worker, sink } = setup({ handled: false }, { finalize: 'stale_lease' });

    await expect(worker.drain()).rejects.toThrow(
      'governed_callback_worker_finalize_stale_lease',
    );
    await expect(worker.drain()).resolves.toBeUndefined();
    expect(sink.deliver).toHaveBeenCalledTimes(1);
  });

  it('uses prior accepted GitHub evidence as the restart PATCH identity', async () => {
    const { worker, repo, sink } = setup({
      handled: true,
      outcome: 'accepted',
      providerReceiptId: '123',
      providerResourceUri: 'https://api.github.com/repos/acme/demo/issues/comments/123',
    }, {
      prior: {
        outcome: 'found',
        providerReceiptId: 'comment_123',
        resourceIdentity: 'github:comment:123',
        targetIdentityDigest: `sha256:${'f'.repeat(64)}`,
      },
    });

    await worker.drain();

    expect(repo.getPriorAcceptedGovernedGitHubResource).toHaveBeenCalledWith(
      expect.objectContaining({
        statusMessageKey: 'run-status',
        targetIdentityDigest: `sha256:${'f'.repeat(64)}`,
      }),
    );
    expect(sink.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ externalMessageId: 'comment_123' }),
    );
    expect(sink.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ externalMessageId: 'comment_123' }),
    );
  });

  it('reanchors terminal provider evidence and reconciles an unknown attempt', async () => {
    const anchor = `sha256:${'9'.repeat(64)}`;
    const { worker, repo } = setup({
      handled: true,
      outcome: 'accepted',
      providerReceiptId: '123',
      providerResourceUri: 'https://api.github.com/repos/acme/demo/issues/comments/123',
    }, {
      finalize: {
        outcome: 'reconciliation_required',
        attemptReceiptId: 'unknown_attempt_receipt',
        attemptReceiptDigest: anchor,
      },
    });

    await worker.drain();

    expect(repo.reconcileGovernedCallbackOutcome).toHaveBeenCalledTimes(1);
    const reconciled = repo.reconcileGovernedCallbackOutcome.mock.calls[0]![0];
    expect(reconciled.providerReceipt.predecessorReceiptDigests).toEqual([anchor]);
    expect(reconciled.providerReceipt.payload).toMatchObject({
      outcome: 'succeeded',
      targetIdentityDigest: `sha256:${'f'.repeat(64)}`,
    });
  });

  it.each(['stale_lease', 'not_found']) (
    'never performs provider I/O after a %s begin result',
    async (outcome) => {
    const { worker, repo, sink } = setup({ handled: true, outcome: 'accepted' }, {
      begin: { outcome },
    });

    await worker.drain();

    expect(sink.deliver).not.toHaveBeenCalled();
    expect(repo.finalizeGovernedCallbackAttempt).not.toHaveBeenCalled();
    expect(repo.reconcileGovernedCallbackOutcome).not.toHaveBeenCalled();
    },
  );

  it('swallows an async onError rejection and continues scheduling', async () => {
    const callbacks: Array<() => void> = [];
    const setTimeout = vi.fn(((callback: () => void) => {
      callbacks.push(callback);
      return { unref() {} };
    }) as unknown as typeof globalThis.setTimeout);
    const clearTimeout = vi.fn() as unknown as typeof globalThis.clearTimeout;
    const onError = vi.fn(async () => {
      throw new Error('error reporter unavailable');
    });
    const { worker, repo } = setup({
      handled: true,
      outcome: 'accepted',
      providerReceiptId: '123',
      providerResourceUri: 'https://api.github.com/repos/acme/demo/issues/comments/123',
    }, { onError, setTimeout, clearTimeout });

    await worker.start();
    repo.claimGovernedCallbackIntents.mockRejectedValueOnce(new Error('drain failed'));
    callbacks.shift()?.();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(setTimeout).toHaveBeenCalledTimes(2));
    await worker.stop();
  });
});
