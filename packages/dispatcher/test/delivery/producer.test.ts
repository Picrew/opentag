import {
  DeliveryIntentV2Schema,
  type DeliveryIntentV2,
} from '@opentag/delivery-contract';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedDeliveryProducer } from '../../src/delivery/producer.js';

const digest = `sha256:${'b'.repeat(64)}`;
const intent = DeliveryIntentV2Schema.parse({
  contractVersion: 2,
  sideEffectIntentId: 'intent-control-1',
  causalId: 'thread-action-1',
  intentKind: 'delivery',
  operation: 'control_reply',
  deliveryKind: 'message',
  presentationDigest: digest,
  provenance: {
    kind: 'source_thread_control',
    providerInstanceId: 'github-installation-1',
    inboundEventDigest: digest,
    sourceThreadDigest: digest,
    providerBindingDigest: digest,
    installationId: 'github-installation-1',
    runtimeGeneration: 3,
    scopeId: 'github-installation-1',
  },
  providerBinding: {
    bindingKind: 'established',
    providerId: 'github',
    providerInstanceId: 'github-installation-1',
    providerPrincipalDigest: digest,
    principalAssurance: 'provider_verified',
    providerConfigGeneration: 4,
    providerConfigGenerationDigest: digest,
    lifecycle: 'active',
    bindingDigest: digest,
  },
  targetDigest: digest,
  authorityKind: 'local_source_thread_control',
  authoritySnapshotDigest: digest,
  evidencePolicy: 'local_audit',
  idempotencyKey: 'control-reply-1',
  scope: { kind: 'provider_instance', id: 'github-installation-1' },
  createdAt: '2026-08-13T00:00:00.000Z',
  initialAttemptSequence: 1,
  installationId: 'github-installation-1',
  runtimeGeneration: 3,
});

describe('UnifiedDeliveryProducer', () => {
  it('validates an exact V2 intent before invoking the only submitter seam', async () => {
    const presentation = { body: 'OpenTag status', provider: 'github' };
    const persistedPayload = { body: presentation.body };
    const resolveIntent = vi.fn(async () => ({ intent, persistedPayload }));
    const enqueue = vi.fn(async () => ({ outcome: 'queued' as const }));
    const producer = new UnifiedDeliveryProducer({
      resolveIntent,
      submitter: { enqueue },
    });

    await expect(producer.enqueue(presentation)).resolves.toEqual({
      outcome: 'queued',
      sideEffectIntentId: 'intent-control-1',
    });
    expect(resolveIntent).toHaveBeenCalledWith(presentation);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(intent, persistedPayload);
  });

  it.each([
    { resolveIntent: undefined, submitter: { enqueue: vi.fn() } },
    { resolveIntent: vi.fn(), submitter: undefined },
  ])('is deterministically activation-blocked when a dependency is missing', async (input) => {
    const producer = new UnifiedDeliveryProducer<{ body: string }>({
      resolveIntent: input.resolveIntent,
      submitter: input.submitter,
    });

    await expect(producer.enqueue({ body: 'never delivered' })).resolves.toEqual({
      outcome: 'activation_blocked',
    });
    if (input.resolveIntent) expect(input.resolveIntent).not.toHaveBeenCalled();
    if (input.submitter) expect(input.submitter.enqueue).not.toHaveBeenCalled();
  });

  it('is activation-blocked when exact authority cannot resolve', async () => {
    const enqueue = vi.fn();
    const producer = new UnifiedDeliveryProducer({
      resolveIntent: async () => null,
      submitter: { enqueue },
    });

    await expect(producer.enqueue({ body: 'no authority' })).resolves.toEqual({
      outcome: 'activation_blocked',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects an invalid resolver result before the submitter is called', async () => {
    const enqueue = vi.fn();
    const invalidIntent = {
      ...intent,
      contractVersion: 1,
    } as unknown as DeliveryIntentV2;
    const producer = new UnifiedDeliveryProducer({
      resolveIntent: async () => ({
        intent: invalidIntent,
        persistedPayload: { body: 'invalid' },
      }),
      submitter: { enqueue },
    });

    await expect(producer.enqueue({ body: 'invalid' })).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not report queued without a durable submitter acknowledgement', async () => {
    const producer = new UnifiedDeliveryProducer({
      resolveIntent: async () => ({
        intent,
        persistedPayload: { body: 'not durable' },
      }),
      submitter: {
        enqueue: async () => ({ outcome: 'not_queued' }) as never,
      },
    });

    await expect(producer.enqueue({ body: 'not durable' })).rejects.toThrow(
      'Delivery submitter did not confirm a durable enqueue.',
    );
  });
});
