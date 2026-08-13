import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DeliveryIntentV2Schema } from '@opentag/delivery-contract';
import {
  bootstrapDeliveryJournal,
  createDeliveryKernelRepository,
  deliveryAttempts,
  type DeliveryPayloadCustody,
} from '@opentag/store';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  ProviderAdapterRegistry,
  type RegisteredProviderAdapter,
} from '../../src/delivery/provider-registry.js';
import { ProviderSideEffectKernel } from '../../src/delivery/side-effect-kernel.js';

const digest = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const stable = digest('stable');
const owner = {
  providerId: 'slack', providerInstanceId: 'instance-1',
  providerBindingDigest: stable, providerConfigGeneration: 7,
  providerConfigGenerationDigest: stable, runtimeOwnerId: 'installation-1',
  runtimeGeneration: 3, schemaGeneration: 1,
};
const intent = DeliveryIntentV2Schema.parse({
  contractVersion: 2, sideEffectIntentId: 'intent-1', causalId: 'cause-1',
  intentKind: 'delivery', operation: 'create', deliveryKind: 'message',
  presentationDigest: stable, provenance: { kind: 'business',
    repositoryIdentityDigest: stable, runId: 'run-1',
    authorityLineageDigest: stable }, providerBinding: {
    bindingKind: 'established', providerId: 'slack',
    providerInstanceId: 'instance-1', providerPrincipalDigest: stable,
    principalAssurance: 'configured_declared', bindingDigest: stable,
    providerConfigGeneration: 7, providerConfigGenerationDigest: stable,
    lifecycle: 'active' }, targetDigest: stable,
  authorityKind: 'run_authority', authoritySnapshotDigest: stable,
  evidencePolicy: 'local_audit', idempotencyKey: 'delivery-1',
  scope: { kind: 'local_repository', id: 'repo-1' },
  createdAt: '2026-08-13T00:00:00.000Z', initialAttemptSequence: 1,
});

function testPayloadCustody(): DeliveryPayloadCustody {
  const committed = new Map<string, unknown>();
  return {
    stage(input) {
      const key = `${input.journalIntentDigest}\0${input.runtimeOwnerId}\0${input.runtimeGeneration}\0${input.schemaGeneration}`;
      let closed = false;
      return { commit() { if (!closed) committed.set(key, input.envelope); closed = true; },
        rollback() { closed = true; } };
    },
    read(input) {
      const key = `${input.journalIntentDigest}\0${input.runtimeOwnerId}\0${input.runtimeGeneration}\0${input.schemaGeneration}`;
      if (!committed.has(key)) throw new Error('custody missing');
      return committed.get(key);
    },
    recoverJournaled: () => 0,
    reconcile: () => ({ finalized: 0, removed: 0 }),
  };
}

function registered(
  deliver: RegisteredProviderAdapter<{ text: string }>['deliver'],
): RegisteredProviderAdapter<{ text: string }> {
  return {
    providerId: 'slack',
    providerInstanceId: 'instance-1',
    bindingDigest: stable,
    providerPrincipalDigest: stable,
    providerConfigGeneration: 7,
    providerConfigGenerationDigest: stable,
    deliver,
  };
}

describe('store delivery kernel repository adapter', () => {
  it('owns the kernel repository composition in store without a dispatcher adapter', () => {
    const adapter = fileURLToPath(new URL(
      '../../src/delivery/store-repository-adapter.ts',
      import.meta.url,
    ));
    expect(existsSync(adapter)).toBe(false);
    expect(createDeliveryKernelRepository).toBeTypeOf('function');
  });

  it('drives the real journal through leased, durable begin, and terminal state', async () => {
    const sqlite = new Database(':memory:');
    bootstrapDeliveryJournal(sqlite);
    const database = drizzle(sqlite);
    const calls: string[] = [];
    const privateText = 'UNKNOWN_CUSTOMER_SECRET_85c7';
    const kernel = new ProviderSideEffectKernel({
      repository: createDeliveryKernelRepository({
        database, payloadCustody: testPayloadCustody(), owner, leaseOwner: 'worker-1', leaseSeconds: 30,
        now: () => new Date('2026-08-13T00:00:01.000Z'),
      }),
      registry: new ProviderAdapterRegistry<{ text: string }>().register(
        registered(async ({ text }) => {
          calls.push('provider');
          const row = database.select().from(deliveryAttempts).get();
          expect(row).toMatchObject({
            state: 'provider_io_begun',
            installationBeginMarkerId: expect.stringMatching(/^installation_begin_/u),
            scopeBeginMarkerId: expect.stringMatching(/^scope_begin_/u),
          });
          expect(text).toBe(privateText);
          return { outcome: 'accepted', evidenceDigest: digest('accepted'),
            externalResourceId: '171.002' };
        }),
      ),
      prepareRequest: (_deliveryIntent, payload) => ({
        request: { text: (payload as { text: string }).text },
        operation: 'create',
        presentationDigest: stable,
        targetDigest: stable,
      }),
    });

    await kernel.enqueue(intent, { text: privateText });
    expect(await kernel.deliverNext()).toMatchObject({ outcome: 'accepted' });
    expect(calls).toEqual(['provider']);
    expect(database.select().from(deliveryAttempts).all()).toMatchObject([
      { state: 'accepted', providerBindingDigest: stable,
        providerConfigGenerationDigest: stable, runtimeOwnerId: 'installation-1',
        runtimeGeneration: 3, authoritySnapshotDigest: stable,
        installationBeginMarkerId: expect.stringMatching(/^installation_begin_/u),
        scopeBeginMarkerId: expect.stringMatching(/^scope_begin_/u),
        externalResourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        externalResourceId: '171.002' },
    ]);
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM delivery_attempts').all()))
      .toContain('171.002');
    expect(sqlite.serialize().includes(Buffer.from(privateText))).toBe(false);
  });

  it('durably terminates a journaled missing adapter without returning it to pending', async () => {
    const sqlite = new Database(':memory:');
    bootstrapDeliveryJournal(sqlite);
    const database = drizzle(sqlite);
    const kernel = new ProviderSideEffectKernel({
      repository: createDeliveryKernelRepository({ database,
        payloadCustody: testPayloadCustody(), owner, leaseOwner: 'worker-1', leaseSeconds: 30 }),
      registry: new ProviderAdapterRegistry<{ text: string }>(),
      prepareRequest: () => ({ request: { text: 'unused' }, operation: 'create',
        presentationDigest: stable, targetDigest: stable }),
    });
    await kernel.enqueue(intent, { text: 'hello' });
    expect(await kernel.deliverNext()).toEqual({ outcome: 'blocked',
      reason: 'provider_adapter_not_registered' });
    expect(database.select().from(deliveryAttempts).all()).toMatchObject([
      { state: 'attention', evidenceDigest: expect.stringMatching(/^sha256:/u) },
    ]);
    expect(await kernel.deliverNext()).toBeNull();
  });

  it.each([
    ['non-Slack provider', { providerId: 'teams', providerInstanceId: 'tenant-1' }],
    ['configured Slack generation drift', { providerConfigGeneration: 8 }],
  ])('globally claims and terminalizes %s exactly once with zero provider I/O', async (
    _case, bindingOverride,
  ) => {
    const sqlite = new Database(':memory:'); bootstrapDeliveryJournal(sqlite);
    const database = drizzle(sqlite); let providerIo = 0;
    const drifted = DeliveryIntentV2Schema.parse({ ...intent, providerBinding: {
      ...intent.providerBinding, ...bindingOverride } });
    const kernel = new ProviderSideEffectKernel({
      repository: createDeliveryKernelRepository({ database,
        payloadCustody: testPayloadCustody(), owner,
        leaseOwner: 'worker-1', leaseSeconds: 30 }),
      registry: new ProviderAdapterRegistry<{ text: string }>().register(
        registered(async () => { providerIo += 1;
          return { outcome: 'accepted', evidenceDigest: stable,
            externalResourceId: '171.002' }; })),
      prepareRequest: () => ({ request: { text: 'unused' }, operation: 'create',
        presentationDigest: stable, targetDigest: stable }),
    });
    await kernel.enqueue(drifted, { text: 'hello' });

    expect(await kernel.deliverNext()).toEqual({ outcome: 'blocked',
      reason: 'provider_adapter_not_registered' });
    expect(providerIo).toBe(0);
    expect(database.select().from(deliveryAttempts).all())
      .toMatchObject([{ state: 'attention',
        errorCode: 'provider_adapter_not_registered' }]);
    expect(await kernel.deliverNext()).toBeNull();
  });

  it('detects persisted payload tampering before begin with zero provider I/O', async () => {
    const sqlite = new Database(':memory:');
    bootstrapDeliveryJournal(sqlite);
    const database = drizzle(sqlite);
    let providerIo = 0; let credentialIo = 0;
    const payloadCustody = testPayloadCustody(); let custodyAvailable = true;
    const kernel = new ProviderSideEffectKernel({
      repository: createDeliveryKernelRepository({ database,
        payloadCustody: { stage: (input) => payloadCustody.stage(input), read: (input) => {
          if (!custodyAvailable) throw new Error('custody missing'); return payloadCustody.read(input);
        }, recoverJournaled: (input) => payloadCustody.recoverJournaled(input), reconcile: (input) => payloadCustody.reconcile(input) },
        owner, leaseOwner: 'worker-1', leaseSeconds: 30 }),
      registry: new ProviderAdapterRegistry<{ text: string }>().register(
        registered(async () => {
          credentialIo += 1; providerIo += 1;
          return { outcome: 'accepted', evidenceDigest: stable,
            externalResourceId: '171.002' };
        }),
      ),
      prepareRequest: (_deliveryIntent, payload) => ({
        request: { text: (payload as { text: string }).text },
        operation: 'create', presentationDigest: stable, targetDigest: stable,
      }),
    });
    await kernel.enqueue(intent, { text: 'hello' });
    custodyAvailable = false;

    expect(await kernel.deliverNext()).toEqual({ outcome: 'blocked',
      reason: 'delivery_payload_custody_unavailable' });
    expect(providerIo).toBe(0);
    expect(credentialIo).toBe(0);
    expect(database.select().from(deliveryAttempts).all()).toMatchObject([
      { state: 'attention', errorCode: 'delivery_payload_custody_unavailable' },
    ]);
    expect(await kernel.deliverNext()).toBeNull();
  });

  it.each([
    ['operation', { operation: 'update' as const, presentationDigest: stable,
      targetDigest: stable }],
    ['presentation', { operation: 'create' as const, presentationDigest: digest('wrong'),
      targetDigest: stable }],
    ['target', { operation: 'create' as const, presentationDigest: stable,
      targetDigest: digest('wrong') }],
  ])('rejects prepared %s drift before provider I/O', async (_field, prepared) => {
    const sqlite = new Database(':memory:');
    bootstrapDeliveryJournal(sqlite);
    const database = drizzle(sqlite);
    let providerIo = 0;
    const kernel = new ProviderSideEffectKernel({
      repository: createDeliveryKernelRepository({ database,
        payloadCustody: testPayloadCustody(), owner, leaseOwner: 'worker-1', leaseSeconds: 30 }),
      registry: new ProviderAdapterRegistry<{ text: string }>().register(
        registered(async () => {
          providerIo += 1;
          return { outcome: 'accepted', evidenceDigest: stable,
            externalResourceId: '171.002' };
        }),
      ),
      prepareRequest: () => ({ request: { text: 'hello' }, ...prepared }),
    });
    await kernel.enqueue(intent, { text: 'hello' });
    expect(await kernel.deliverNext()).toEqual({ outcome: 'blocked',
      reason: 'delivery_request_digest_mismatch' });
    expect(providerIo).toBe(0);
    expect(database.select().from(deliveryAttempts).all()).toMatchObject([
      { state: 'attention', errorCode: 'delivery_request_digest_mismatch' },
    ]);
    expect(await kernel.deliverNext()).toBeNull();
  });
});
