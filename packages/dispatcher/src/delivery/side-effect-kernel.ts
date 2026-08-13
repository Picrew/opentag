import { createHash } from 'node:crypto';
import {
  domainSeparatedCanonicalBytes,
  type DeliveryIntentV2,
} from '@opentag/delivery-contract';
import { type createDeliveryKernelRepository, DELIVERY_ERROR_CODES,
  type DeliveryErrorCode, type ExpectedDeliveryOwner } from '@opentag/store';
import { type ProviderDeliveryResult, ProviderAdapterRegistry } from './provider-registry.js';

const ATTENTION_EVIDENCE = {
  provider_adapter_not_registered: 'sha256:f443f5a15f8ed4f358b38012507180672bf19df21b93c872091e323c4331716e',
  delivery_request_preparation_failed: 'sha256:bb0ff0ba276c9f25b1925a185265bf6e109dd09ee980f17c2b665c63e204177b',
  delivery_request_digest_mismatch: 'sha256:59f366cd52fd4090782e4834974d46ae0ec94572a65826756201ca4d93e0c7a3',
  delivery_payload_custody_unavailable: 'sha256:8c8d4868e7599cffde0dbceda47cf8c3f6b1d8f7a17c404cc707bd0839b43f01',
  provider_binding_mismatch: 'sha256:3c09161f1680468648da69d87961d9379ef0087db4ed8f1a9aba6cc042905704',
} as const;

export interface DeliveryClaim extends ExpectedDeliveryOwner { attemptId: string; intentId: string; sequence: number; leaseFence: string; revision: number; authoritySnapshotDigest: string; journalIntentDigest: string }

interface DeliveryBeginMarkers { installationBeginMarkerId: string; installationBeginMarkerDigest: string;
  scopeBeginMarkerId: string; scopeBeginMarkerDigest: string }

interface BegunDeliveryClaim extends DeliveryClaim, DeliveryBeginMarkers {}

export type DeliverySettlement = Awaited<ReturnType<DeliveryKernelRepository['settleOrReadTerminal']>>;

export type DeliveryKernelRepository = ReturnType<typeof createDeliveryKernelRepository>;

type AttentionReason = keyof typeof ATTENTION_EVIDENCE;

type DeliveryBlocked = { outcome: 'blocked'; reason: AttentionReason | 'delivery_begin_stale' };

interface ProviderSideEffectKernelOptions<Request extends object> {
  repository: DeliveryKernelRepository; registry: ProviderAdapterRegistry<Request>;
  prepareRequest(intent: DeliveryIntentV2, persistedPayload: unknown): {
    request: Request; operation: DeliveryIntentV2['operation'];
    presentationDigest: string; targetDigest: string;
  };
  timeoutMs?: number;
}

export class ProviderSideEffectKernel<Request extends object> {
  readonly #options: ProviderSideEffectKernelOptions<Request>;

  constructor(options: ProviderSideEffectKernelOptions<Request>) {
    this.#options = { ...options, timeoutMs: options.timeoutMs ?? 30_000 };
  }

  async enqueue(intent: DeliveryIntentV2, persistedPayload: unknown): Promise<{ outcome: 'queued' }> {
    await this.#options.repository.recordIntent(intent, persistedPayload);
    return { outcome: 'queued' };
  }

  async deliverNext(): Promise<DeliverySettlement | DeliveryBlocked | null> {
    const { prepareRequest, registry, repository } = this.#options;
    const claimed = await repository.claimNext(); if (!claimed) return null;
    const claim = await repository.renewLease(claimed);
    if (!claim) return { outcome: 'blocked', reason: 'delivery_begin_stale' };
    let stored;
    try { stored = await repository.getIntent(claim); }
    catch { return this.#attention(claim, undefined, 'delivery_request_preparation_failed'); }
    if (!stored) return this.#attention(claim, undefined, 'delivery_request_preparation_failed');
    if (stored.outcome === 'custody_unavailable') {
      return this.#attention(claim, undefined, 'delivery_payload_custody_unavailable');
    }
    const binding = stored.intent.providerBinding;
    if (stored.journalIntentDigest !== claim.journalIntentDigest) return this.#attention(claim, stored.intent, 'delivery_request_digest_mismatch');
    if (binding.providerId !== claim.providerId || binding.providerInstanceId !== claim.providerInstanceId || binding.bindingDigest !== claim.providerBindingDigest ||
      binding.providerConfigGeneration !== claim.providerConfigGeneration || binding.providerConfigGenerationDigest !== claim.providerConfigGenerationDigest ||
      stored.intent.authoritySnapshotDigest !== claim.authoritySnapshotDigest) {
      return this.#attention(claim, stored.intent, 'provider_binding_mismatch');
    }
    const adapter = registry.resolve(binding);
    if (!adapter) return this.#attention(claim, stored.intent, 'provider_adapter_not_registered');

    let prepared: ReturnType<ProviderSideEffectKernelOptions<Request>['prepareRequest']>;
    try { prepared = prepareRequest(stored.intent, stored.persistedPayload); } catch {
      return this.#attention(claim, stored.intent, 'delivery_request_preparation_failed');
    }
    if (prepared.operation !== stored.intent.operation || prepared.presentationDigest !== stored.intent.presentationDigest ||
      prepared.targetDigest !== stored.intent.targetDigest) {
      return this.#attention(claim, stored.intent, 'delivery_request_digest_mismatch');
    }

    const begun = await this.#begin(claim, stored.intent); if (!begun) return { outcome: 'blocked', reason: 'delivery_begin_stale' };

    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(); reject(new DeliveryTimeoutError());
        }, this.#options.timeoutMs);
      });
      const result = await Promise.race([adapter.deliver({ ...prepared.request, intent: stored.intent, signal: controller.signal }), timeout]);
      return this.#settle(begun, result);
    } catch (error) {
      return this.#settle(begun, {
        outcome: 'outcome_unknown',
        evidenceDigest: error instanceof DeliveryTimeoutError
          ? 'sha256:eb73b0d832e8a2f9c8224e4203725d771be8aae6407b5a2a30ff552ad384fb81'
          : 'sha256:288f18790debd9a2eb07dd54196c2f80ef1ddacc43df02ee1d3a3893bed30ab6',
        errorCode: error instanceof DeliveryTimeoutError
          ? 'provider_delivery_timeout' : 'provider_delivery_exception',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async recoverStrandedBegun(input: { before: string; evidenceDigest: string; outcomeRecordedAt?: string }): Promise<number> { return this.#options.repository.finalizeStrandedBegun(input); }

  async #attention(claim: DeliveryClaim, intent: DeliveryIntentV2 | undefined,
    reason: AttentionReason): Promise<DeliverySettlement | DeliveryBlocked> {
    const begun = await this.#begin(claim, intent); if (!begun) return { outcome: 'blocked', reason: 'delivery_begin_stale' };
    const settlement = await this.#settle(begun, { outcome: 'attention',
      evidenceDigest: ATTENTION_EVIDENCE[reason], errorCode: reason });
    return settlement.outcome === 'attention' ? { outcome: 'blocked', reason } : settlement;
  }

  async #begin(claim: DeliveryClaim, intent?: DeliveryIntentV2): Promise<BegunDeliveryClaim | null> {
    return this.#options.repository.markBegin({ ...claim, ...deriveBeginMarkers(claim, intent) });
  }

  async #settle(claim: BegunDeliveryClaim, result: ProviderDeliveryResult): Promise<DeliverySettlement> {
    const normalized = normalizeProviderResult(claim.providerId, claim.providerInstanceId, result);
    return this.#options.repository.settleOrReadTerminal({ ...claim, ...normalized });
  }
}

class DeliveryTimeoutError extends Error {} const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SLACK_RESOURCE_ID = /^\d{1,20}\.\d{1,20}$/u; const ERROR_CODES = new Set<string>(DELIVERY_ERROR_CODES);

function normalizeProviderResult(providerId: string, providerInstanceId: string, result: ProviderDeliveryResult): Pick<DeliverySettlement, 'outcome' | 'evidenceDigest' | 'errorCode' | 'externalResourceDigest' | 'externalResourceId'> {
  if (!SHA256.test(result.evidenceDigest)) return invalidProviderResult();
  const errorCode = result.errorCode && ERROR_CODES.has(result.errorCode) ? result.errorCode as DeliveryErrorCode : undefined;
  if (result.errorCode && !errorCode) return invalidProviderResult();
  if (result.outcome !== 'accepted') return errorCode
    ? { outcome: result.outcome, evidenceDigest: result.evidenceDigest, errorCode }
    : invalidProviderResult();
  if (errorCode) return invalidProviderResult();
  if (!result.externalResourceId) return { outcome: 'accepted', evidenceDigest: result.evidenceDigest };
  if (providerId !== 'slack' || !SLACK_RESOURCE_ID.test(result.externalResourceId)) return invalidProviderResult();
  return { outcome: 'accepted', evidenceDigest: result.evidenceDigest,
    externalResourceDigest: digest(`opentag.delivery.external-resource.v1\0${providerId}\0${providerInstanceId}\0${result.externalResourceId}`),
    externalResourceId: result.externalResourceId };
}

function deriveBeginMarkers(
  claim: DeliveryClaim,
  intent?: DeliveryIntentV2,
): DeliveryBeginMarkers {
  const tuple = {
    ...claim,
    sideEffectIntentId: intent?.sideEffectIntentId ?? claim.intentId,
    scope: intent?.scope ?? { kind: 'journal_unavailable', id: claim.intentId },
    installationId: intent && 'installationId' in intent ? intent.installationId : claim.runtimeOwnerId,
      ...(intent ? { providerBinding: intent.providerBinding } : {}),
  };
  const installationBeginMarkerDigest = digest(domainSeparatedCanonicalBytes('opentag.delivery.begin.installation.v1', tuple));
  const scopeBeginMarkerDigest = digest(domainSeparatedCanonicalBytes('opentag.delivery.begin.scope.v1', tuple));
  return {
    installationBeginMarkerId:
      `installation_begin_${installationBeginMarkerDigest.slice(7, 39)}`,
    installationBeginMarkerDigest,
    scopeBeginMarkerId: `scope_begin_${scopeBeginMarkerDigest.slice(7, 39)}`,
    scopeBeginMarkerDigest,
  };
}

function digest(bytes: string | Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function invalidProviderResult(): Pick<DeliverySettlement, 'outcome' | 'evidenceDigest' | 'errorCode'> { return { outcome: 'outcome_unknown', evidenceDigest: 'sha256:f88c1a5749548ef9462fe990a59c02db0d11c1494c5ea58a89fd46808ceee79b', errorCode: 'provider_result_invalid' }; }
