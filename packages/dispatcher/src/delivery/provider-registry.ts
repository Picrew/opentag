import { EstablishedProviderBindingV1Schema, type DeliveryIntentV2, type EstablishedProviderBindingV1 } from '@opentag/delivery-contract';

export type ProviderDeliveryResult = { outcome: 'accepted' | 'rejected' | 'outcome_unknown' | 'attention'; evidenceDigest: string; externalResourceId?: string; errorCode?: string };

const DESCRIPTOR_FIELDS = ['providerId', 'providerInstanceId', 'bindingDigest',
  'providerPrincipalDigest', 'providerConfigGeneration', 'providerConfigGenerationDigest'] as const;
type ProviderAdapterDescriptor = Readonly<Pick<EstablishedProviderBindingV1, typeof DESCRIPTOR_FIELDS[number]>>;

export type RegisteredProviderAdapter<Request extends object = object> = ProviderAdapterDescriptor & {
  deliver(input: Request & { intent: DeliveryIntentV2; signal?: AbortSignal }): Promise<ProviderDeliveryResult>;
};

export class ProviderAdapterRegistry<Request extends object = object> {
  readonly #providers = new Map<string, RegisteredProviderAdapter<Request>>();

  register(adapter: RegisteredProviderAdapter<Request>): this {
    EstablishedProviderBindingV1Schema.parse({ bindingKind: 'established',
      ...Object.fromEntries(DESCRIPTOR_FIELDS.map((field) => [field, adapter[field]])),
      principalAssurance: 'configured_declared', lifecycle: 'active' });
    const key = `${adapter.providerId}\0${adapter.providerInstanceId}`;
    if (this.#providers.has(key)) {
      throw new Error(`Provider adapter already registered: ${adapter.providerId}/${adapter.providerInstanceId}`);
    }
    this.#providers.set(key, Object.freeze(adapter));
    return this;
  }

  resolve(binding: EstablishedProviderBindingV1): RegisteredProviderAdapter<Request> | undefined {
    const adapter = this.#providers.get(`${binding.providerId}\0${binding.providerInstanceId}`);
    return adapter && DESCRIPTOR_FIELDS.every((field) => adapter[field] === binding[field])
      ? adapter : undefined;
  }
}
