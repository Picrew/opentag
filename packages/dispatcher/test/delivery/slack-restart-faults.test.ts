import { DeliveryIntentV2Schema } from '@opentag/delivery-contract';
import { describe, expect, it } from 'vitest';
import { ProviderAdapterRegistry } from '../../src/delivery/provider-registry.js';
import type { RegisteredProviderAdapter } from '../../src/delivery/provider-registry.js';
import {
  ProviderSideEffectKernel,
  type DeliveryKernelRepository,
  type DeliverySettlement,
} from '../../src/delivery/side-effect-kernel.js';

type Request = { operation: 'create'; presentation: string };
const digest = `sha256:${'2'.repeat(64)}`;
const intent = DeliveryIntentV2Schema.parse({ contractVersion: 2,
  sideEffectIntentId: 'slack-intent-1', causalId: 'cause-1', intentKind: 'delivery',
  operation: 'create', deliveryKind: 'message', presentationDigest: digest,
  provenance: { kind: 'business', repositoryIdentityDigest: digest,
    runId: 'run-1', authorityLineageDigest: digest },
  providerBinding: { bindingKind: 'established', providerId: 'slack',
    providerInstanceId: 'team-1', providerPrincipalDigest: digest,
    principalAssurance: 'configured_declared', bindingDigest: digest,
    providerConfigGeneration: 1, providerConfigGenerationDigest: digest,
    lifecycle: 'active' }, targetDigest: digest, authorityKind: 'run_authority',
  authoritySnapshotDigest: digest, evidencePolicy: 'local_audit',
  idempotencyKey: 'delivery-1', scope: { kind: 'local_repository', id: 'repo-1' },
  createdAt: '2026-08-13T00:00:00.000Z', initialAttemptSequence: 1 });

function registered(
  deliver: RegisteredProviderAdapter<Request>['deliver'],
): RegisteredProviderAdapter<Request> {
  return {
    providerId: 'slack',
    providerInstanceId: 'team-1',
    bindingDigest: digest,
    providerPrincipalDigest: digest,
    providerConfigGeneration: 1,
    providerConfigGenerationDigest: digest,
    deliver,
  };
}

function harness(finalizeStrandedBegun = async () => 0) {
  const settlements: DeliverySettlement[] = [];
  const repository: DeliveryKernelRepository = {
    recordIntent: async () => {},
    getIntent: async () => ({ outcome: 'hydrated' as const, intent, persistedPayload: {},
      journalIntentDigest: digest }),
    claimNext: async () => ({
      attemptId: 'attempt-1', intentId: 'slack-intent-1', sequence: 1,
      leaseFence: 'fence-1', revision: 2, providerId: 'slack',
      providerInstanceId: 'team-1', providerBindingDigest: digest,
      providerConfigGeneration: 1, providerConfigGenerationDigest: digest,
      runtimeOwnerId: 'installation-1', runtimeGeneration: 1, schemaGeneration: 1,
      authoritySnapshotDigest: digest, journalIntentDigest: digest,
    }),
    markBegin: async (begun) => ({ ...begun, revision: begun.revision + 1 }),
    settleOrReadTerminal: async (settlement) => {
      settlements.push(settlement);
      return settlement;
    },
    renewLease: async (leased) => leased,
    finalizeStrandedBegun,
  };
  return { repository, settlements };
}

const prepareRequest = () => ({
  request: { operation: 'create' as const, presentation: 'hello' },
  operation: 'create' as const,
  presentationDigest: digest,
  targetDigest: digest,
});

describe('Slack restart faults', () => {
  it('settles a post-begin exception as outcome_unknown', async () => {
    const state = harness();
    const registry = new ProviderAdapterRegistry<Request>().register(
      registered(async () => { throw new Error('connection reset'); }),
    );
    const result = await new ProviderSideEffectKernel({
      repository: state.repository, registry, prepareRequest,
    }).deliverNext();

    expect(result).toMatchObject({
      outcome: 'outcome_unknown', errorCode: 'provider_delivery_exception',
    });
    expect(state.settlements[0]?.outcome).toBe('outcome_unknown');
  });

  it('settles a provider timeout as outcome_unknown', async () => {
    const state = harness();
    const registry = new ProviderAdapterRegistry<Request>().register(
      registered(async () => new Promise(() => {})),
    );
    const result = await new ProviderSideEffectKernel({
      repository: state.repository, registry, prepareRequest, timeoutMs: 1,
    }).deliverNext();

    expect(result).toMatchObject({
      outcome: 'outcome_unknown', errorCode: 'provider_delivery_timeout',
    });
  });

  it('lets the repository settle stranded begun attempts without resend', async () => {
    let recovered = 0;
    const state = harness(async () => { recovered += 1; return 2; });
    let sends = 0;
    const registry = new ProviderAdapterRegistry<Request>().register(
      registered(async () => {
          sends += 1;
          return { outcome: 'accepted', evidenceDigest: 'not-used' };
        }),
    );
    const count = await new ProviderSideEffectKernel({
      repository: state.repository, registry, prepareRequest,
    }).recoverStrandedBegun({ before: '2026-08-13T01:00:00.000Z',
      evidenceDigest: digest });

    expect(count).toBe(2);
    expect(recovered).toBe(1);
    expect(sends).toBe(0);
  });
});
