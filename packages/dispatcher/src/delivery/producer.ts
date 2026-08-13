import { DeliveryIntentV2Schema, type DeliveryIntentV2 } from '@opentag/delivery-contract';

type DeliveryIntentResolver<Presentation> = (presentation: Presentation) => Promise<{ intent: DeliveryIntentV2; persistedPayload: unknown } | null>;
type DeliveryIntentSubmitter = Readonly<{ enqueue(intent: DeliveryIntentV2, payload: unknown): Promise<{ outcome: 'queued' }> }>;

export class UnifiedDeliveryProducer<Presentation> {
  readonly #resolveIntent: DeliveryIntentResolver<Presentation> | undefined; readonly #submitter: DeliveryIntentSubmitter | undefined;

  constructor(input: { resolveIntent?: DeliveryIntentResolver<Presentation>; submitter?: DeliveryIntentSubmitter }) {
    this.#resolveIntent = input.resolveIntent; this.#submitter = input.submitter; }

  async enqueue(presentation: Presentation) {
    if (!this.#resolveIntent || !this.#submitter) return { outcome: 'activation_blocked' };
    const resolved = await this.#resolveIntent(presentation);
    if (!resolved) return { outcome: 'activation_blocked' };
    const intent = DeliveryIntentV2Schema.parse(resolved.intent);
    const submitted = await this.#submitter.enqueue(intent, resolved.persistedPayload);
    if (submitted.outcome !== 'queued') throw new Error('Delivery submitter did not confirm a durable enqueue.');
    return { outcome: 'queued', sideEffectIntentId: intent.sideEffectIntentId };
  }
}

export type UnifiedDeliveryEnqueuer<Presentation> = Pick<UnifiedDeliveryProducer<Presentation>, 'enqueue'>;
