import { createHash, randomUUID } from 'node:crypto';
import {
  CallbackAttemptObservationReceiptEnvelopeV1Schema,
  CallbackProviderObservationReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  type CallbackAttemptObservationReceiptEnvelopeV1,
  type CallbackProviderObservationReceiptEnvelopeV1,
} from '@opentag/core';
import {
  createOpenTagRepository,
  type ClaimedGovernedCallback,
} from '@opentag/store';
import {
  CallbackProviderOutcomeUnknownError,
  type CallbackSinkPreflightResult,
} from './callbacks.js';
import type { CallbackDeliveryResult, CallbackMessage, CallbackSink } from './server.js';

type Repository = ReturnType<typeof createOpenTagRepository>;

export type GovernedCallbackWorker = {
  start(): Promise<void>;
  stop(): Promise<void>;
  wake(): void;
  drain(): Promise<void>;
};

export type GovernedCallbackWorkerOptions = {
  repo: Pick<
    Repository,
    | 'recoverExpiredGovernedCallbacks'
    | 'claimGovernedCallbackIntents'
    | 'beginGovernedCallbackSending'
    | 'quarantineGovernedCallbackAttempt'
    | 'finalizeGovernedCallbackAttempt'
    | 'reconcileGovernedCallbackOutcome'
    | 'getPriorAcceptedGovernedGitHubResource'
  >;
  sink: CallbackSink;
  destinationId: string;
  organizationId: string;
  leaseOwner?: string;
  leaseSeconds?: number;
  batchSize?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void | Promise<void>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

type FinalObservation = {
  attempt: CallbackAttemptObservationReceiptEnvelopeV1;
  provider?: CallbackProviderObservationReceiptEnvelopeV1;
};

type CallbackSinkWithPreflight = CallbackSink & {
  preflight(message: CallbackMessage): Promise<CallbackSinkPreflightResult>;
};

function stableDigestId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function githubIssueCommentsTarget(uri: string): {
  owner: string;
  repo: string;
  issueNumber: string;
} | null {
  try {
    const parsed = new URL(uri);
    if (
      parsed.origin !== 'https://api.github.com'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search !== ''
      || parsed.hash !== ''
    ) return null;
    const match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/comments$/u
      .exec(parsed.pathname);
    return match
      ? { owner: match[1]!, repo: match[2]!, issueNumber: match[3]! }
      : null;
  } catch {
    return null;
  }
}

function providerReceiptIdentity(input: {
  claimed: ClaimedGovernedCallback;
  result: Extract<CallbackDeliveryResult, { handled: true; outcome: 'accepted' | 'rejected' }>;
}): { providerReceiptId: string; resourceIdentity: string } | null {
  const target = githubIssueCommentsTarget(input.claimed.delivery.uri);
  if (!target) return null;
  if (input.result.outcome === 'accepted') {
    const nativeId = input.result.providerReceiptId;
    const nativeUri = input.result.providerResourceUri;
    if (!nativeId || !nativeUri) return null;
    const providerId = /^(?:comment_)?([1-9][0-9]*)$/u.exec(nativeId)?.[1];
    let resource: { owner: string; repo: string; id: string } | undefined;
    try {
      const parsed = new URL(nativeUri);
      const match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/([1-9][0-9]*)$/u
        .exec(parsed.pathname);
      resource = parsed.origin === 'https://api.github.com'
        && parsed.username === ''
        && parsed.password === ''
        && parsed.search === ''
        && parsed.hash === ''
        && match
        ? { owner: match[1]!, repo: match[2]!, id: match[3]! }
        : undefined;
    } catch {
      return null;
    }
    if (
      !providerId
      || !resource
      || resource.id !== providerId
      || resource.owner.toLowerCase() !== target.owner.toLowerCase()
      || resource.repo.toLowerCase() !== target.repo.toLowerCase()
    ) return null;
    return {
      providerReceiptId: `comment_${providerId}`,
      resourceIdentity: `github:comment:${providerId}`,
    };
  }

  // A rejected HTTP mutation has no created GitHub resource. Preserve the
  // provider rejection as an observation tied to the attempted issue target;
  // this is not success evidence and does not claim a remote mutation exists.
  const observationId = stableDigestId('provider_receipt', {
    localAttemptId: input.claimed.attempt.localAttemptId,
    reasonCode: input.result.reasonCode,
  });
  return {
    providerReceiptId: observationId,
    resourceIdentity: `github:issue:${target.issueNumber}`,
  };
}

async function withDigests<T extends { payload: unknown }>(
  envelope: T,
): Promise<T & { payloadDigest: string; receiptDigest: string }> {
  const payloadDigest = await computeControlPayloadDigestV1(envelope.payload);
  const withoutReceiptDigest = { ...envelope, payloadDigest };
  return {
    ...withoutReceiptDigest,
    receiptDigest: await computeControlReceiptDigestV1(withoutReceiptDigest),
  };
}

async function observationFor(input: {
  claimed: ClaimedGovernedCallback;
  result: CallbackDeliveryResult;
  attemptedAt: string;
  observedAt: string;
}): Promise<FinalObservation> {
  const { claimed } = input;
  if (!input.result.handled) throw new Error('callback_sink_unhandled');
  const normalized = input.result;
  const outcome = normalized.outcome;
  const reasonCode = outcome === 'accepted'
    ? 'provider_accepted'
    : outcome === 'rejected'
      ? 'provider_rejected'
      : normalized.reasonCode === 'provider_timeout'
        ? 'provider_timeout'
        : 'provider_receipt_missing';
  const operationId = stableDigestId('callback_observation', {
    localAttemptId: claimed.attempt.localAttemptId,
    outcome,
  });
  const attemptBase = {
    schemaVersion: 1 as const,
    protocolVersion: '1.0' as const,
    receiptKind: 'callback_attempt_observation' as const,
    receiptId: stableDigestId('callback_attempt_receipt', {
      localAttemptId: claimed.attempt.localAttemptId,
      outcome,
    }),
    organizationId: claimed.intent.organizationId,
    operationId,
    requiredCapabilities: ['relay.callback-observation.v1'] as const,
    producer: claimed.producer,
    identity: {
      namespace: 'opentag.control.receipt/callback-attempt-observation/v1',
      parts: [
        claimed.intent.organizationId,
        claimed.intent.workThreadId,
        claimed.intent.localIntentId,
        claimed.attempt.localAttemptId,
      ],
    },
    predecessorReceiptDigests: [claimed.intentReceiptDigest],
    observedAt: input.observedAt,
    runId: claimed.intent.runId,
    workThreadId: claimed.intent.workThreadId,
    payload: {
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      outcome,
      reasonCode,
      ...(outcome === 'outcome_unknown'
        ? { nextAction: 'reconcile-provider' as const, owner: claimed.producer.id }
        : {}),
      attemptedAt: input.attemptedAt,
      observedAt: input.observedAt,
    },
  };
  const attempt = CallbackAttemptObservationReceiptEnvelopeV1Schema.parse(
    await withDigests(attemptBase),
  );
  if (outcome === 'outcome_unknown') return { attempt };

  const identity = providerReceiptIdentity({
    claimed,
    result: normalized as Extract<
      CallbackDeliveryResult,
      { handled: true; outcome: 'accepted' | 'rejected' }
    >,
  });
  if (!identity) {
    throw new Error('callback_provider_evidence_invalid');
  }
  const providerBase = {
    schemaVersion: 1 as const,
    protocolVersion: '1.0' as const,
    receiptKind: 'callback_provider_observation' as const,
    receiptId: stableDigestId('callback_provider_receipt', {
      localAttemptId: claimed.attempt.localAttemptId,
      providerReceiptId: identity.providerReceiptId,
    }),
    organizationId: claimed.intent.organizationId,
    operationId: stableDigestId('callback_provider_observation', {
      localAttemptId: claimed.attempt.localAttemptId,
      providerReceiptId: identity.providerReceiptId,
      resourceIdentity: identity.resourceIdentity,
      outcome,
    }),
    requiredCapabilities: ['relay.callback-observation.v1'] as const,
    producer: claimed.producer,
    identity: {
      namespace: 'opentag.control.receipt/callback-provider-observation/v1',
      parts: [
        claimed.intent.organizationId,
        claimed.intent.workThreadId,
        claimed.intent.localIntentId,
        claimed.attempt.localAttemptId,
        identity.providerReceiptId,
      ],
    },
    predecessorReceiptDigests: [attempt.receiptDigest],
    observedAt: input.observedAt,
    runId: claimed.intent.runId,
    workThreadId: claimed.intent.workThreadId,
    payload: {
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      providerReceiptId: identity.providerReceiptId,
      resourceIdentity: identity.resourceIdentity,
      targetIdentityDigest: claimed.targetIdentityDigest,
      outcome: outcome === 'accepted' ? ('succeeded' as const) : ('failed' as const),
      observedAt: input.observedAt,
      reasonCode,
    },
  };
  const provider = CallbackProviderObservationReceiptEnvelopeV1Schema.parse(
    await withDigests(providerBase),
  );
  return { attempt, provider };
}

async function attentionObservation(input: {
  claimed: ClaimedGovernedCallback;
  attemptedAt: string;
  observedAt: string;
  reasonCode: 'callback_sink_unhandled' | 'callback_target_invalid' | 'callback_local_error';
}): Promise<CallbackAttemptObservationReceiptEnvelopeV1> {
  const { claimed } = input;
  const base = {
    schemaVersion: 1 as const,
    protocolVersion: '1.0' as const,
    receiptKind: 'callback_attempt_observation' as const,
    receiptId: stableDigestId('callback_attempt_receipt', {
      localAttemptId: claimed.attempt.localAttemptId,
      outcome: 'attention',
      reasonCode: input.reasonCode,
    }),
    organizationId: claimed.intent.organizationId,
    operationId: stableDigestId('callback_observation', {
      localAttemptId: claimed.attempt.localAttemptId,
      outcome: 'attention',
      reasonCode: input.reasonCode,
    }),
    requiredCapabilities: ['relay.callback-observation.v1'] as const,
    producer: claimed.producer,
    identity: {
      namespace: 'opentag.control.receipt/callback-attempt-observation/v1',
      parts: [
        claimed.intent.organizationId,
        claimed.intent.workThreadId,
        claimed.intent.localIntentId,
        claimed.attempt.localAttemptId,
      ],
    },
    predecessorReceiptDigests: [claimed.intentReceiptDigest],
    observedAt: input.observedAt,
    runId: claimed.intent.runId,
    workThreadId: claimed.intent.workThreadId,
    payload: {
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      outcome: 'attention' as const,
      reasonCode: input.reasonCode,
      nextAction: 'repair-local-callback' as const,
      owner: claimed.producer.id,
      attemptedAt: input.attemptedAt,
      observedAt: input.observedAt,
    },
  };
  return CallbackAttemptObservationReceiptEnvelopeV1Schema.parse(
    await withDigests(base),
  );
}

function callbackMessage(input: {
  claimed: ClaimedGovernedCallback;
  externalMessageId?: string;
}): CallbackMessage {
  const { claimed } = input;
  return {
    runId: claimed.delivery.runId,
    kind: claimed.delivery.kind,
    provider: claimed.delivery.provider,
    uri: claimed.delivery.uri,
    body: claimed.delivery.body,
    ...(claimed.delivery.threadKey ? { threadKey: claimed.delivery.threadKey } : {}),
    ...(claimed.delivery.agentId ? { agentId: claimed.delivery.agentId } : {}),
    ...(claimed.delivery.statusMessageKey
      ? { statusMessageKey: claimed.delivery.statusMessageKey }
      : {}),
    ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
    ...(claimed.delivery.blocks
      ? { blocks: claimed.delivery.blocks as NonNullable<CallbackMessage['blocks']> }
      : {}),
    ...(claimed.delivery.rich
      ? { rich: claimed.delivery.rich as NonNullable<CallbackMessage['rich']> }
      : {}),
    idempotencyKey: claimed.intent.idempotencyKey,
  };
}

function sinkWithPreflight(sink: CallbackSink): sink is CallbackSinkWithPreflight {
  return 'preflight' in sink && typeof sink.preflight === 'function';
}

function assertGovernedCallbackStoreOutcome(
  operation: 'quarantine' | 'finalize',
  outcome: string,
  committed: readonly string[],
): void {
  if (committed.includes(outcome)) return;
  throw new Error(`governed_callback_worker_${operation}_${outcome}`);
}

async function providerReceiptWithPredecessor(
  receipt: CallbackProviderObservationReceiptEnvelopeV1,
  predecessorReceiptDigest: string,
): Promise<CallbackProviderObservationReceiptEnvelopeV1> {
  const {
    payloadDigest: _payloadDigest,
    receiptDigest: _receiptDigest,
    ...base
  } = receipt;
  return CallbackProviderObservationReceiptEnvelopeV1Schema.parse(
    await withDigests({
      ...base,
      predecessorReceiptDigests: [predecessorReceiptDigest],
    }),
  );
}

export function createGovernedCallbackWorker(
  input: GovernedCallbackWorkerOptions,
): GovernedCallbackWorker {
  const leaseOwner = input.leaseOwner ?? `dispatcher_callback_${randomUUID()}`;
  const leaseSeconds = input.leaseSeconds ?? 30;
  const batchSize = input.batchSize ?? 20;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const now = input.now ?? (() => new Date());
  const setTimer = input.setTimeout ?? globalThis.setTimeout;
  const clearTimer = input.clearTimeout ?? globalThis.clearTimeout;
  let running = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let latch: Promise<void> | undefined;

  const reportError = async (error: unknown): Promise<void> => {
    try {
      await input.onError?.(error);
    } catch {
      // Error reporting is best-effort and must not create an unhandled rejection.
    }
  };

  const schedule = () => {
    if (!running || timer) return;
    timer = setTimer(() => {
      timer = undefined;
      void drain()
        .catch(reportError)
        .finally(schedule);
    }, pollIntervalMs);
    timer.unref?.();
  };

  const processClaim = async (claimed: ClaimedGovernedCallback) => {
    const leaseToken = claimed.intent.leaseToken;
    if (!leaseToken) return;
    const observedNow = () => now().toISOString();
    const quarantine = async (
      reasonCode: 'callback_sink_unhandled' | 'callback_target_invalid' | 'callback_local_error',
    ) => {
      const at = observedNow();
      const receipt = await attentionObservation({
        claimed,
        attemptedAt: at,
        observedAt: at,
        reasonCode,
      });
      const outcome = await input.repo.quarantineGovernedCallbackAttempt({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        leaseToken,
        attemptReceipt: receipt,
        now: now(),
      });
      assertGovernedCallbackStoreOutcome(
        'quarantine',
        outcome,
        ['quarantined', 'replayed'],
      );
    };

    const finalizeAttention = async (
      receipt: CallbackAttemptObservationReceiptEnvelopeV1,
    ): Promise<void> => {
      const outcome = await input.repo.finalizeGovernedCallbackAttempt({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        leaseToken,
        attemptReceipt: receipt,
        now: now(),
      });
      if (typeof outcome === 'object') {
        throw new Error('governed_callback_worker_finalize_reconciliation_required');
      }
      assertGovernedCallbackStoreOutcome(
        'finalize',
        outcome,
        ['finalized', 'replayed'],
      );
    };

    let externalMessageId: string | undefined;
    if (claimed.delivery.statusMessageKey) {
      let prior: Awaited<ReturnType<
        Repository['getPriorAcceptedGovernedGitHubResource']
      >>;
      try {
        prior = await input.repo.getPriorAcceptedGovernedGitHubResource({
          destinationId: input.destinationId,
          organizationId: input.organizationId,
          runId: claimed.intent.runId,
          workThreadId: claimed.intent.workThreadId,
          statusMessageKey: claimed.delivery.statusMessageKey,
          targetIdentityDigest: claimed.targetIdentityDigest,
        });
      } catch {
        await quarantine('callback_local_error');
        return;
      }
      if (prior.outcome === 'conflict') {
        await quarantine('callback_local_error');
        return;
      }
      if (prior.outcome === 'found') externalMessageId = prior.providerReceiptId;
    }
    const message = callbackMessage({ claimed, ...(externalMessageId ? { externalMessageId } : {}) });
    if (!sinkWithPreflight(input.sink)) {
      await quarantine('callback_sink_unhandled');
      return;
    }
    let preflight: CallbackSinkPreflightResult;
    try {
      preflight = await input.sink.preflight(message);
    } catch {
      await quarantine('callback_local_error');
      return;
    }
    if (!preflight.handled) {
      await quarantine(preflight.reasonCode === 'callback_target_invalid'
        ? 'callback_target_invalid'
        : 'callback_sink_unhandled');
      return;
    }
    const began = await input.repo.beginGovernedCallbackSending({
      destinationId: input.destinationId,
      organizationId: input.organizationId,
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken,
      now: now(),
    });
    if (began.outcome !== 'sending') return;
    let result: CallbackDeliveryResult;
    try {
      result = await input.sink.deliver(message);
    } catch (error) {
      if (error instanceof CallbackProviderOutcomeUnknownError) {
        result = {
          ...error.classification,
          owner: claimed.producer.id,
        };
      } else {
        const observedAt = observedNow();
        const receipt = await attentionObservation({
          claimed,
          attemptedAt: began.attemptedAt,
          observedAt: Date.parse(observedAt) < Date.parse(began.attemptedAt)
            ? began.attemptedAt
            : observedAt,
          reasonCode: 'callback_local_error',
        });
        await finalizeAttention(receipt);
        return;
      }
    }
    if (!result.handled) {
      const observedAt = observedNow();
      const receipt = await attentionObservation({
        claimed,
        attemptedAt: began.attemptedAt,
        observedAt: Date.parse(observedAt) < Date.parse(began.attemptedAt)
          ? began.attemptedAt
          : observedAt,
        reasonCode: 'callback_sink_unhandled',
      });
      await finalizeAttention(receipt);
      return;
    }
    const observedAt = now().toISOString();
    let observation: FinalObservation;
    try {
      observation = await observationFor({
        claimed,
        result,
        attemptedAt: began.attemptedAt,
        observedAt:
          Date.parse(observedAt) < Date.parse(began.attemptedAt)
            ? began.attemptedAt
            : observedAt,
      });
    } catch {
      const receipt = await attentionObservation({
        claimed,
        attemptedAt: began.attemptedAt,
        observedAt: Date.parse(observedAt) < Date.parse(began.attemptedAt)
          ? began.attemptedAt
          : observedAt,
        reasonCode: 'callback_local_error',
      });
      await finalizeAttention(receipt);
      return;
    }
    const finalized = await input.repo.finalizeGovernedCallbackAttempt({
      destinationId: input.destinationId,
      organizationId: input.organizationId,
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken,
      attemptReceipt: observation.attempt,
      ...(observation.provider ? { providerReceipt: observation.provider } : {}),
      now: now(),
    });
    if (
      typeof finalized === 'object'
      && finalized.outcome === 'reconciliation_required'
      && observation.provider
    ) {
      const providerReceipt = await providerReceiptWithPredecessor(
        observation.provider,
        finalized.attemptReceiptDigest,
      );
      await input.repo.reconcileGovernedCallbackOutcome({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        providerReceipt,
        now: now(),
      });
      return;
    }
    if (typeof finalized === 'object') {
      throw new Error('governed_callback_worker_finalize_reconciliation_required');
    }
    assertGovernedCallbackStoreOutcome(
      'finalize',
      finalized,
      ['finalized', 'replayed'],
    );
  };

  const runDrain = async () => {
    for (;;) {
      await input.repo.recoverExpiredGovernedCallbacks({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        now: now(),
      });
      const claimed = await input.repo.claimGovernedCallbackIntents({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        leaseOwner,
        leaseSeconds,
        limit: batchSize,
        now: now(),
      });
      if (claimed.length === 0) return;
      for (const entry of claimed) await processClaim(entry);
      if (claimed.length < batchSize) return;
    }
  };

  const drain = (): Promise<void> => {
    if (latch) return latch;
    latch = runDrain().finally(() => {
      latch = undefined;
    });
    return latch;
  };

  return {
    async start() {
      if (running) return;
      running = true;
      latch = runDrain().finally(() => {
        latch = undefined;
      });
      try {
        await latch;
      } catch (error) {
        running = false;
        throw error;
      }
      schedule();
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
      await latch;
    },
    wake() {
      if (!running) return;
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
      queueMicrotask(() => {
        if (!running) return;
        void drain()
          .catch(reportError)
          .finally(schedule);
      });
    },
    drain,
  };
}
