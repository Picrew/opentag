import { describe, expect, it } from 'vitest';
import {
  ProviderAdapterRegistry,
  type RegisteredProviderAdapter,
} from '../../src/delivery/provider-registry.js';

type Request = { presentation: string };
const digest = (digit: string) => `sha256:${digit.repeat(64)}`;

function adapter(
  name: string,
  overrides: Partial<RegisteredProviderAdapter<Request>> = {},
): RegisteredProviderAdapter<Request> {
  return {
    providerId: 'slack',
    providerInstanceId: 'workspace-a',
    bindingDigest: digest('1'),
    providerPrincipalDigest: digest('2'),
    providerConfigGeneration: 7,
    providerConfigGenerationDigest: digest('3'),
    deliver: async () => ({ outcome: 'accepted', evidenceDigest: name }),
    ...overrides,
  };
}

const binding = {
  bindingKind: 'established' as const,
  providerId: 'slack',
  providerInstanceId: 'workspace-a',
  bindingDigest: digest('1'),
  providerPrincipalDigest: digest('2'),
  principalAssurance: 'provider_verified' as const,
  providerConfigGeneration: 7,
  providerConfigGenerationDigest: digest('3'),
  lifecycle: 'active' as const,
};

describe('ProviderAdapterRegistry', () => {
  it('resolves only an exact immutable registration descriptor', () => {
    const registered = adapter('slack-a');
    const registry = new ProviderAdapterRegistry<Request>().register(registered);

    expect(registry.resolve(binding)).toBe(registered);
    for (const changed of [
      { providerId: 'teams' },
      { providerInstanceId: 'workspace-b' },
      { bindingDigest: digest('4') },
      { providerPrincipalDigest: digest('5') },
      { providerConfigGeneration: 8 },
      { providerConfigGenerationDigest: digest('6') },
    ]) {
      expect(registry.resolve({ ...binding, ...changed })).toBeUndefined();
    }

    expect(Object.isFrozen(registered)).toBe(true);
    expect(() => {
      (registered as { providerConfigGeneration: number })
        .providerConfigGeneration = 8;
    }).toThrow(TypeError);
    expect(registry.resolve(binding)).toBe(registered);
    expect(registry.resolve({ ...binding, providerConfigGeneration: 8 }))
      .toBeUndefined();
  });

  it('rejects replacement of an exact provider-instance registration', () => {
    const registry = new ProviderAdapterRegistry<Request>().register(
      adapter('first'),
    );

    expect(() => registry.register(adapter('second'))).toThrow(
      'Provider adapter already registered',
    );
  });
});
