import { DeliveryIntentV2Schema } from '@opentag/delivery-contract';
import { describe, expect, it } from 'vitest';
import {
  ProviderAdapterRegistry,
  type RegisteredProviderAdapter,
} from '../../src/delivery/provider-registry.js';
import {
  ProviderSideEffectKernel,
  type DeliveryClaim,
  type DeliveryKernelRepository,
  type DeliverySettlement,
} from '../../src/delivery/side-effect-kernel.js';

type Request = { presentation: string };
const digest = `sha256:${'1'.repeat(64)}`;
const intent = DeliveryIntentV2Schema.parse({
  contractVersion: 2,
  sideEffectIntentId: 'intent-1', causalId: 'cause-1', intentKind: 'delivery',
  operation: 'create', deliveryKind: 'message', presentationDigest: digest,
  provenance: { kind: 'business', repositoryIdentityDigest: digest,
    runId: 'run-1', authorityLineageDigest: digest },
  providerBinding: {
    bindingKind: 'established', providerId: 'slack', providerInstanceId: 'workspace-a',
    providerPrincipalDigest: digest, principalAssurance: 'configured_declared',
    bindingDigest: digest, providerConfigGeneration: 7,
    providerConfigGenerationDigest: digest, lifecycle: 'active',
  },
  targetDigest: digest, authorityKind: 'run_authority', authoritySnapshotDigest: digest,
  evidencePolicy: 'local_audit', idempotencyKey: 'delivery-1',
  scope: { kind: 'local_repository', id: 'repo-1' },
  createdAt: '2026-08-13T00:00:00.000Z', initialAttemptSequence: 1,
});
const claim: DeliveryClaim = {
  attemptId: 'attempt-1', intentId: 'intent-1', sequence: 1,
  leaseFence: 'fence-1', revision: 2,
  providerId: 'slack', providerInstanceId: 'workspace-a',
  providerBindingDigest: digest, providerConfigGeneration: 7,
  providerConfigGenerationDigest: digest, runtimeOwnerId: 'installation-1',
  runtimeGeneration: 1, schemaGeneration: 1, authoritySnapshotDigest: digest,
  journalIntentDigest: digest,
};

function registered(
  deliver: RegisteredProviderAdapter<Request>['deliver'],
  overrides: Partial<RegisteredProviderAdapter<Request>> = {},
): RegisteredProviderAdapter<Request> {
  return {
    providerId: 'slack',
    providerInstanceId: 'workspace-a',
    bindingDigest: digest,
    providerPrincipalDigest: digest,
    providerConfigGeneration: 7,
    providerConfigGenerationDigest: digest,
    deliver,
    ...overrides,
  };
}

function repository() {
  const calls: string[] = [];
  const settlements: DeliverySettlement[] = [];
  const value: DeliveryKernelRepository = {
    recordIntent: async () => { calls.push('record'); },
    getIntent: async () => ({ outcome: 'hydrated' as const, intent, persistedPayload: { body: 'hello' },
      journalIntentDigest: digest }),
    claimNext: async () => { calls.push('claim'); return claim; },
    markBegin: async (begun) => {
      calls.push('begin');
      return { ...begun, revision: begun.revision + 1 };
    },
    settleOrReadTerminal: async (settlement) => {
      calls.push(`settle:${settlement.outcome}`);
      settlements.push(settlement);
      return settlement;
    },
    renewLease: async (leased) => { calls.push('renew'); return leased; },
    finalizeStrandedBegun: async () => 0,
  };
  return { value, calls, settlements };
}

async function captureBeginMarkers(
  claimed: DeliveryClaim,
  storedIntent = intent,
) {
  let captured: Parameters<DeliveryKernelRepository['markBegin']>[0] | undefined;
  const repo = repository();
  repo.value.claimNext = async () => claimed;
  repo.value.getIntent = async () => ({
    outcome: 'hydrated' as const,
    intent: storedIntent,
    persistedPayload: { body: 'hello' },
    journalIntentDigest: claimed.journalIntentDigest,
  });
  repo.value.markBegin = async (begun) => {
    captured = begun;
    return null;
  };
  const result = await new ProviderSideEffectKernel({
    repository: repo.value,
    registry: new ProviderAdapterRegistry<Request>(),
    prepareRequest: () => ({
      request: { presentation: 'unused' },
      operation: 'create',
      presentationDigest: digest,
      targetDigest: digest,
    }),
  }).deliverNext();
  expect(result).toEqual({ outcome: 'blocked', reason: 'delivery_begin_stale' });
  expect(captured).toBeDefined();
  return {
    installationBeginMarkerId: captured!.installationBeginMarkerId,
    installationBeginMarkerDigest: captured!.installationBeginMarkerDigest,
    scopeBeginMarkerId: captured!.scopeBeginMarkerId,
    scopeBeginMarkerDigest: captured!.scopeBeginMarkerDigest,
  };
}

describe('ProviderSideEffectKernel', () => {
  it('derives deterministic, domain-separated begin markers inside the kernel', async () => {
    const first = await captureBeginMarkers(claim);
    const second = await captureBeginMarkers({ ...claim });

    expect(second).toEqual(first);
    expect(first.installationBeginMarkerId).toMatch(/^installation_begin_/u);
    expect(first.scopeBeginMarkerId).toMatch(/^scope_begin_/u);
    expect(first.installationBeginMarkerDigest).not.toBe(
      first.scopeBeginMarkerDigest,
    );
  });

  it.each([
    ['attemptId', { attemptId: 'attempt-2' }],
    ['intentId', { intentId: 'intent-2' }],
    ['sequence', { sequence: 2 }],
    ['leaseFence', { leaseFence: 'fence-2' }],
    ['revision', { revision: 3 }],
    ['runtimeOwnerId', { runtimeOwnerId: 'installation-2' }],
    ['runtimeGeneration', { runtimeGeneration: 2 }],
    ['schemaGeneration', { schemaGeneration: 2 }],
    ['journalIntentDigest', {
      journalIntentDigest: `sha256:${'5'.repeat(64)}`,
    }],
  ] satisfies Array<[string, Partial<DeliveryClaim>]>) (
    'changes markers and leaves the begin stale when immutable %s is tampered',
    async (_field, changed) => {
      const baseline = await captureBeginMarkers(claim);
      const tampered = await captureBeginMarkers({ ...claim, ...changed });

      expect(tampered).not.toEqual(baseline);
    },
  );

  it('binds begin markers to the immutable scope and principal', async () => {
    const baseline = await captureBeginMarkers(claim);
    const changedScope = await captureBeginMarkers(claim, {
      ...intent,
      scope: { ...intent.scope, id: 'repo-2' },
    });
    const changedPrincipal = await captureBeginMarkers(claim, {
      ...intent,
      providerBinding: {
        ...intent.providerBinding,
        providerPrincipalDigest: `sha256:${'7'.repeat(64)}`,
      },
    });

    expect(changedScope).not.toEqual(baseline);
    expect(changedPrincipal).not.toEqual(baseline);
  });

  it.each([
    ['sideEffectIntentId', {
      claim: {},
      intent: { sideEffectIntentId: 'intent-2' },
    }],
    ['providerInstanceId', {
      claim: { providerInstanceId: 'workspace-b' },
      intent: { providerBinding: {
        ...intent.providerBinding,
        providerInstanceId: 'workspace-b',
      } },
    }],
    ['providerBindingDigest', {
      claim: { providerBindingDigest: `sha256:${'8'.repeat(64)}` },
      intent: { providerBinding: {
        ...intent.providerBinding,
        bindingDigest: `sha256:${'8'.repeat(64)}`,
      } },
    }],
    ['providerConfigGeneration', {
      claim: { providerConfigGeneration: 8 },
      intent: { providerBinding: {
        ...intent.providerBinding,
        providerConfigGeneration: 8,
      } },
    }],
    ['providerConfigGenerationDigest', {
      claim: { providerConfigGenerationDigest: `sha256:${'9'.repeat(64)}` },
      intent: { providerBinding: {
        ...intent.providerBinding,
        providerConfigGenerationDigest: `sha256:${'9'.repeat(64)}`,
      } },
    }],
    ['authoritySnapshotDigest', {
      claim: { authoritySnapshotDigest: `sha256:${'a'.repeat(64)}` },
      intent: { authoritySnapshotDigest: `sha256:${'a'.repeat(64)}` },
    }],
  ])('binds begin markers to matched immutable %s', async (_field, changes) => {
    const baseline = await captureBeginMarkers(claim);
    const changedIntent = {
      ...intent,
      ...changes.intent,
    } as typeof intent;
    const changed = await captureBeginMarkers(
      { ...claim, ...changes.claim },
      changedIntent,
    );

    expect(changed).not.toEqual(baseline);
  });

  it('commits record, claim, and begin before provider I/O', async () => {
    const repo = repository();
    const registry = new ProviderAdapterRegistry<Request>().register(
      registered(async ({ intent: deliveredIntent, presentation }) => {
          repo.calls.push('provider');
          expect(deliveredIntent).toBe(intent);
          expect(presentation).toBe('hello');
          return { outcome: 'accepted', evidenceDigest: digest,
            externalResourceId: '171.002' };
        }),
    );
    const kernel = new ProviderSideEffectKernel({
      repository: repo.value,
      registry,
      prepareRequest: (_intent, payload) => ({
        request: { presentation: (payload as { body: string }).body },
        operation: 'create',
        presentationDigest: digest,
        targetDigest: digest,
      }),
    });

    expect(await kernel.enqueue(intent, { body: 'hello' })).toEqual({
      outcome: 'queued',
    });
    expect((await kernel.deliverNext())?.outcome).toBe('accepted');
    expect(repo.calls).toEqual([
      'record', 'claim', 'renew', 'begin', 'provider', 'settle:accepted',
    ]);
    expect(repo.settlements[0]?.revision).toBe(3);
    expect(repo.settlements[0]).toMatchObject({
      externalResourceId: '171.002',
      externalResourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it.each(['rejected', 'attention', 'outcome_unknown'] as const)(
    'preserves the adapter terminal outcome %s',
    async (outcome) => {
      const repo = repository();
      const registry = new ProviderAdapterRegistry<Request>().register(
        registered(async () => ({ outcome, evidenceDigest: digest,
          ...(outcome === 'accepted' ? { externalResourceId: '171.002' } : {}),
          errorCode: outcome === 'rejected' ? 'slack_rejected' :
              outcome === 'attention' ? 'invalid_delivery_shape' :
                'transport_error' })),
      );
      const result = await new ProviderSideEffectKernel({
        repository: repo.value, registry,
        prepareRequest: () => ({ request: { presentation: 'hello' }, operation: 'create',
          presentationDigest: digest, targetDigest: digest }),
      }).deliverNext();

      expect(result?.outcome).toBe(outcome);
      expect(repo.settlements[0]?.outcome).toBe(outcome);
    },
  );

  it('journals a missing exact adapter and terminates it as attention with zero provider I/O', async () => {
    const repo = repository();
    let providerIo = 0;
    const registry = new ProviderAdapterRegistry<Request>().register(
      registered(async () => {
          providerIo += 1;
          return { outcome: 'accepted', evidenceDigest: 'wrong' };
        }, { providerInstanceId: 'workspace-b' }),
    );
    const kernel = new ProviderSideEffectKernel({
      repository: repo.value, registry,
      prepareRequest: () => ({ request: { presentation: 'hello' }, operation: 'create',
        presentationDigest: digest, targetDigest: digest }),
    });
    expect(await kernel.enqueue(intent, { body: 'hello' })).toEqual({ outcome: 'queued' });
    const result = await kernel.deliverNext();

    expect(result).toEqual({
      outcome: 'blocked', reason: 'provider_adapter_not_registered',
    });
    expect(providerIo).toBe(0);
    expect(repo.calls).toEqual(['record', 'claim', 'renew', 'begin', 'settle:attention']);
    expect(repo.settlements[0]).toMatchObject({
      outcome: 'attention', errorCode: 'provider_adapter_not_registered',
    });
  });

  it.each([
    ['providerId', { providerId: 'teams' }],
    ['providerInstanceId', { providerInstanceId: 'workspace-b' }],
    ['bindingDigest', { bindingDigest: `sha256:${'2'.repeat(64)}` }],
    ['providerPrincipalDigest', {
      providerPrincipalDigest: `sha256:${'3'.repeat(64)}`,
    }],
    ['providerConfigGeneration', { providerConfigGeneration: 8 }],
    ['providerConfigGenerationDigest', {
      providerConfigGenerationDigest: `sha256:${'4'.repeat(64)}`,
    }],
  ] satisfies Array<[
    string,
    Partial<RegisteredProviderAdapter<Request>>,
  ]>)(
    'blocks exact registration %s drift before provider I/O',
    async (_field, changed) => {
      const repo = repository();
      let providerIo = 0;
      const registry = new ProviderAdapterRegistry<Request>().register(
        registered(async () => {
          providerIo += 1;
          return { outcome: 'accepted', evidenceDigest: digest };
        }, changed),
      );
      const result = await new ProviderSideEffectKernel({
        repository: repo.value,
        registry,
        prepareRequest: () => ({
          request: { presentation: 'hello' },
          operation: 'create',
          presentationDigest: digest,
          targetDigest: digest,
        }),
      }).deliverNext();

      expect(result).toEqual({
        outcome: 'blocked',
        reason: 'provider_adapter_not_registered',
      });
      expect(providerIo).toBe(0);
    },
  );

  it('durably terminates a claim if its exact registration disappears before begin', async () => {
    const repo = repository();
    const registry = new ProviderAdapterRegistry<Request>();
    const result = await new ProviderSideEffectKernel({
      repository: repo.value, registry,
      prepareRequest: () => ({ request: { presentation: 'hello' }, operation: 'create',
        presentationDigest: digest, targetDigest: digest }),
    }).deliverNext();

    expect(result).toEqual({
      outcome: 'blocked', reason: 'provider_adapter_not_registered',
    });
    expect(repo.calls).toEqual(['claim', 'renew', 'begin', 'settle:attention']);
  });

  it('durably terminates request preparation failure as attention before provider I/O', async () => {
    const repo = repository();
    let providerIo = 0;
    const registry = new ProviderAdapterRegistry<Request>().register(
      registered(async () => {
        providerIo += 1;
        return { outcome: 'accepted', evidenceDigest: digest,
          externalResourceId: '171.002' };
      }),
    );
    const result = await new ProviderSideEffectKernel({
      repository: repo.value, registry,
      prepareRequest: () => { throw new Error('invalid payload'); },
    }).deliverNext();
    expect(result).toEqual({
      outcome: 'blocked', reason: 'delivery_request_preparation_failed',
    });
    expect(providerIo).toBe(0);
    expect(repo.calls).toEqual(['claim', 'renew', 'begin', 'settle:attention']);
    expect(repo.settlements[0]).toMatchObject({ outcome: 'attention',
      errorCode: 'delivery_request_preparation_failed' });
  });

  it.each([
    ['journal read failure', async () => { throw new Error('corrupt journal'); },
      'delivery_request_preparation_failed'],
    ['custody unavailable without duplicated intent', async () => ({
      outcome: 'custody_unavailable' as const,
      journalIntentDigest: digest,
    }), 'delivery_payload_custody_unavailable'],
    ['journal digest mismatch', async () => ({ outcome: 'hydrated' as const,
      intent, persistedPayload: { body: 'hello' },
      journalIntentDigest: `sha256:${'9'.repeat(64)}` }),
    'delivery_request_digest_mismatch'],
    ['binding mismatch', async () => ({ outcome: 'hydrated' as const,
      intent: { ...intent, providerBinding: { ...intent.providerBinding,
        providerConfigGeneration: 8 } }, persistedPayload: { body: 'hello' },
      journalIntentDigest: digest }), 'provider_binding_mismatch'],
  ])('durably terminates deterministic %s without release or repeat', async (
    _case, getIntent, errorCode,
  ) => {
    const repo = repository(); let claims = 0;
    repo.value.claimNext = async () => claims++ === 0 ? claim : null;
    repo.value.getIntent = getIntent as DeliveryKernelRepository['getIntent'];
    const kernel = new ProviderSideEffectKernel({ repository: repo.value,
      registry: new ProviderAdapterRegistry<Request>().register(
        registered(async () => { throw new Error('provider must not run'); })),
      prepareRequest: () => ({ request: { presentation: 'hello' },
        operation: 'create', presentationDigest: digest, targetDigest: digest }) });

    expect(await kernel.deliverNext()).toMatchObject({ outcome: 'blocked' });
    expect(repo.settlements[0]).toMatchObject({ outcome: 'attention', errorCode });
    expect(await kernel.deliverNext()).toBeNull();
  });

  it('fails closed as outcome_unknown when terminal settlement loses its CAS', async () => {
    const repo = repository();
    repo.value.settleOrReadTerminal = async (settlement) => ({
      ...settlement,
      outcome: 'outcome_unknown',
      evidenceDigest: digest,
      errorCode: 'delivery_settlement_stale',
    });
    const registry = new ProviderAdapterRegistry<Request>().register(
      registered(async () => ({ outcome: 'accepted', evidenceDigest: digest,
        externalResourceId: '171.002' })),
    );
    const result = await new ProviderSideEffectKernel({
      repository: repo.value, registry,
      prepareRequest: () => ({ request: { presentation: 'hello' }, operation: 'create',
        presentationDigest: digest, targetDigest: digest }),
    }).deliverNext();
    expect(result).toMatchObject({
      outcome: 'outcome_unknown', errorCode: 'delivery_settlement_stale',
    });
  });

  it.each([
    'https://hooks.slack.test/171.002', 'xoxb-secret', 'message-171',
    `${'1'.repeat(21)}.002`, `171.${'2'.repeat(21)}`,
  ])('fails closed before persistence for invalid Slack resource ID %s', async (externalResourceId) => {
    const repo = repository();
    const registry = new ProviderAdapterRegistry<Request>().register(
      registered(async () => ({
        outcome: 'accepted', evidenceDigest: digest, externalResourceId,
      })),
    );
    const result = await new ProviderSideEffectKernel({
      repository: repo.value, registry,
      prepareRequest: () => ({ request: { presentation: 'hello' }, operation: 'create',
        presentationDigest: digest, targetDigest: digest }),
    }).deliverNext();
    expect(result).toMatchObject({ outcome: 'outcome_unknown',
      errorCode: 'provider_result_invalid' });
    expect(repo.settlements[0]).not.toHaveProperty('externalResourceId');
  });
});
