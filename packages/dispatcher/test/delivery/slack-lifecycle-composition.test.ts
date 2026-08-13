import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSlackDeliveryAdapter, createSlackEventProcessor } from '@opentag/slack';
import { bootstrapDeliveryJournal, createDeliveryKernelRepository, createEncryptedFileDeliveryPayloadCustody, createSlackInstallationRegistry, type DeliveryPayloadCustody } from '@opentag/store';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createSlackDispatcherEventProcessorInput } from '../../../slack/src/dispatcher-events.js';
import { createSlackLifecycleComposition, createSlackSelfServiceAuthorityResolver } from '../../src/delivery/slack-lifecycle-composition.js';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const stable = digest('stable');
const owner = { providerId: 'slack', providerInstanceId: 'install-1', providerBindingDigest: stable,
  providerConfigGeneration: 7, providerConfigGenerationDigest: stable, runtimeOwnerId: 'runtime-1',
  runtimeGeneration: 3, schemaGeneration: 1 } as const;
const authority = () => ({ providerBinding: {
    bindingKind: 'established', providerId: 'slack', providerInstanceId: 'install-1',
    providerPrincipalDigest: stable, principalAssurance: 'provider_verified', bindingDigest: stable,
    providerConfigGeneration: 7, providerConfigGenerationDigest: stable, lifecycle: 'active' as const },
  authoritySnapshotIdentity: 'authority-1', causalId: 'run-1', createdAt: '2026-08-13T00:00:00.000Z',
  provenance: { kind: 'business' as const, repositoryIdentity: 'github:acme/demo', authorityLineageIdentity: 'run-authority-1', scopeId: 'repo-1' } });

function createTestPayloadCustody(): DeliveryPayloadCustody {
  const committed = new Map<string, unknown>();
  const key = (input: Parameters<DeliveryPayloadCustody['read']>[0]) =>
    `${input.journalIntentDigest}\0${input.runtimeOwnerId}\0${input.runtimeGeneration}\0${input.schemaGeneration}`;
  return {
    stage(input) {
      let closed = false;
      return {
        commit() { if (!closed) committed.set(key(input), input.envelope); closed = true; },
        rollback() { closed = true; },
      };
    },
    read(input) {
      if (!committed.has(key(input))) throw new Error('custody missing');
      return committed.get(key(input));
    },
    recoverJournaled: () => 0,
    reconcile: () => ({ finalized: 0, removed: 0 }),
  };
}

function open(path: string, requests: Array<{ method: string; body: Record<string, unknown> }>,
  resolveAuthority = async () => authority(), expectedOwner = owner,
  lookupOverride?: { current?: { outcome: 'none' | 'ambiguous' } }) {
  const sqlite = new Database(path); bootstrapDeliveryJournal(sqlite);
  const database = drizzle(sqlite);
  const payloadCustody = path === ':memory:' ? createTestPayloadCustody() :
    createEncryptedFileDeliveryPayloadCustody({ directory: `${path}.payloads`, trustedBoundary: dirname(path), key: Buffer.alloc(32, 9) });
  const repository = createDeliveryKernelRepository({ database, payloadCustody, owner: expectedOwner, leaseOwner: 'worker', leaseSeconds: 30 });
  const composition = createSlackLifecycleComposition({
    repository: lookupOverride ? { ...repository, findAcceptedExternalResource: (input) => lookupOverride.current ?? repository.findAcceptedExternalResource(input) } : repository,
    resolveAuthority,
    adapter: createSlackDeliveryAdapter({ providerInstanceId: expectedOwner.providerInstanceId, bindingDigest: expectedOwner.providerBindingDigest,
      providerPrincipalDigest: stable, providerConfigGeneration: 7, providerConfigGenerationDigest: stable,
      resolveCredential: async () => 'test-token', fetchImpl: async (url, init) => {
        const method = String(url).split('/').at(-1)!; const body = JSON.parse(String(init?.body));
        requests.push({ method, body }); return Response.json({ ok: true, ts: body.ts ?? '171.002' });
      } }),
  });
  return { sqlite, composition };
}

describe('Slack lifecycle composition', () => {
  it('authorizes self-service only through exact installation team, app, and channel scope', async () => {
    const registry = createSlackInstallationRegistry([{ recordVersion: 1, installationId: 'installation-record-1', teamId: 'T1', appId: 'A1', channelIds: ['C1'],
      providerInstanceId: 'provider-instance-1', bindingDigest: stable, principalDigest: stable, principalAssurance: 'provider_verified', lifecycle: 'active',
      configGeneration: 7, configGenerationDigest: stable, credentialReference: { custody: 'local', id: 'slack.bot.install-1' } }]);
    expect(() => createSlackSelfServiceAuthorityResolver({ registry, runtimeGeneration: 0, authoritySnapshotIdentity: 'runtime-authority-3' })).toThrow();
    expect(() => createSlackSelfServiceAuthorityResolver({ registry, runtimeGeneration: 3, authoritySnapshotIdentity: '' })).toThrow();
    const resolve = createSlackSelfServiceAuthorityResolver({ registry, runtimeGeneration: 3, authoritySnapshotIdentity: 'runtime-authority-3' });
    const presentation = { kind: 'source_thread_control', body: 'status', command: { verb: 'status', rawText: '/status' }, request: { rawText: '/status',
      actor: { provider: 'slack', providerUserId: 'U1' }, callback: { provider: 'slack', uri: 'slack:source-thread', threadKey: 'T1|C1|170.001' },
      metadata: { slackEventId: 'Ev1', eventTime: 1_775_692_800, appId: 'A1' } } } as const;
    await expect(resolve(presentation)).resolves.toMatchObject({ providerBinding: { providerInstanceId: 'provider-instance-1' }, causalId: 'Ev1', createdAt: '2026-04-09T00:00:00.000Z',
      provenance: { installationId: 'installation-record-1', scopeId: 'provider-instance-1' } });
    await expect(resolve({ ...presentation, request: { ...presentation.request, callback: { ...presentation.request.callback, threadKey: 'T1|C2|170.001' } } })).resolves.toBeNull();
    await expect(resolve({ ...presentation, request: { ...presentation.request, metadata: { ...presentation.request.metadata, appId: 'A2' } } })).resolves.toBeNull();
    const requests: Array<{ method: string; body: Record<string, unknown> }> = []; const runtime = open(':memory:', requests, resolve,
      { ...owner, providerInstanceId: 'provider-instance-1' });
    await expect(runtime.composition.producer.enqueue(presentation)).resolves.toMatchObject({ outcome: 'queued' });
    await expect(runtime.composition.kernel.deliverNext()).resolves.toMatchObject({ outcome: 'accepted' });
    await expect(runtime.composition.producer.enqueue({ ...presentation, request: { ...presentation.request,
      callback: { ...presentation.request.callback, threadKey: 'T2|C1|170.001' } } })).resolves.toEqual({ outcome: 'activation_blocked' });
    expect(await runtime.composition.kernel.deliverNext()).toBeNull(); expect(requests).toHaveLength(1); runtime.sqlite.close();
  });

  it('reopens SQLite and updates the accepted lifecycle message without a second create', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opentag-slack-lifecycle-')); const path = join(directory, 'delivery.sqlite');
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    try {
      let runtime = open(path, requests);
      expect(await runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'acknowledgement',
        provider: 'slack', uri: 'ignored', body: 'started', threadKey: 'T1|C1|170.001', statusMessageKey: 'run-1:status' }))
        .toMatchObject({ outcome: 'queued' });
      expect(await runtime.composition.kernel.deliverNext()).toMatchObject({ outcome: 'accepted', externalResourceId: '171.002' });
      runtime.sqlite.close();
      runtime = open(path, requests);
      expect(await runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'final',
        provider: 'slack', uri: 'ignored', body: 'done', threadKey: 'T1|C1|170.001', statusMessageKey: 'run-1:status' }))
        .toMatchObject({ outcome: 'queued' });
      expect(await runtime.composition.kernel.deliverNext()).toMatchObject({ outcome: 'accepted', externalResourceId: '171.002' });
      expect(requests).toEqual([{ method: 'chat.postMessage', body: expect.objectContaining({ channel: 'C1', thread_ts: '170.001' }) },
        { method: 'chat.update', body: expect.objectContaining({ channel: 'C1', ts: '171.002' }) }]);
      runtime.sqlite.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('maps a Slack source receipt to the exact source reaction', async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const runtime = open(':memory:', requests);
    await runtime.composition.producer.enqueue({ kind: 'source_receipt', runId: 'run-1', phase: 'received', provider: 'slack', uri: 'ignored',
      sourceEvent: { metadata: { channelId: 'C1', messageTs: '170.001' } } } as never);
    await runtime.composition.kernel.deliverNext();
    expect(requests).toEqual([{ method: 'reactions.add', body: { channel: 'C1', timestamp: '170.001', name: 'eyes' } }]);
    runtime.sqlite.close();
  });

  it('routes source-thread control through the same resolver', async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const runtime = open(':memory:', requests, async (presentation) => presentation.kind !== 'source_thread_control' ? null : ({ ...authority(),
      createdAt: new Date(Number(presentation.request.metadata?.eventTime) * 1_000).toISOString(), provenance: { kind: 'source_thread_control' as const,
        inboundEventIdentity: String(presentation.request.metadata?.slackEventId), sourceThreadIdentity: presentation.request.callback.threadKey!,
        installationId: 'install-1', runtimeGeneration: 3, scopeId: 'install-1' } }));
    const processor = createSlackEventProcessor(createSlackDispatcherEventProcessorInput({ dispatcherUrl: 'http://dispatcher.test', fetchImpl: async (url, init) => {
      if (String(url).includes('/v1/channel-bindings/')) return Response.json({ binding: { provider: 'slack', accountId: 'T1', conversationId: 'C1', owner: 'acme', repo: 'demo' } });
      const input = JSON.parse(String(init?.body)); await runtime.composition.producer.enqueue({ kind: 'source_thread_control', body: input.presentation.text,
        textFormat: input.presentation.textFormat, command: { verb: input.cause.command, rawText: `/${input.cause.command}` }, request: { rawText: `/${input.cause.command}`,
          actor: { provider: 'slack', providerUserId: input.cause.userId }, callback: { provider: 'slack', uri: 'slack:source-thread',
            threadKey: `${input.cause.teamId}|${input.cause.channelId}|${input.cause.threadTs}` }, metadata: { slackEventId: input.cause.eventId,
            eventTime: input.cause.eventTime, assurance: input.cause.assurance } } });
      return Response.json({ outcome: 'status' });
    } }));
    await processor.process({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event_time: 1_775_692_800,
      authorizations: [{ user_id: 'UBOT' }], event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '170.001', text: '<@UBOT> /status' } },
      { agentId: 'opentag' }, { signatureVerified: true });
    await runtime.composition.kernel.deliverNext();
    expect(requests).toEqual([{ method: 'chat.postMessage', body: expect.objectContaining({ channel: 'C1', text: expect.stringContaining('OpenTag status') }) }]);
    runtime.sqlite.close();
  });

  it('blocks cross-target lifecycle lookup before credential or provider I/O', async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = []; const runtime = open(':memory:', requests);
    await runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'acknowledgement', provider: 'slack', uri: 'ignored',
      body: 'started', threadKey: 'T1|C1|170.001', statusMessageKey: 'run-1:status' });
    await runtime.composition.kernel.deliverNext(); requests.length = 0;
    const result = await runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'final', provider: 'slack', uri: 'ignored',
      body: 'done', threadKey: 'T1|C2|170.001', statusMessageKey: 'run-1:status' });
    expect(result).toEqual({ outcome: 'activation_blocked' });
    expect(await runtime.composition.kernel.deliverNext()).toBeNull();
    expect(requests).toEqual([]);
    runtime.sqlite.close();
  });

  it('blocks cross-binding lifecycle lookup before credential or provider I/O', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opentag-slack-binding-')); const path = join(directory, 'delivery.sqlite');
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    try {
      let runtime = open(path, requests);
      await runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'acknowledgement', provider: 'slack', uri: 'ignored',
        body: 'started', threadKey: 'T1|C1|170.001', statusMessageKey: 'run-1:status' });
      await runtime.composition.kernel.deliverNext(); runtime.sqlite.close(); requests.length = 0;
      const other = digest('other-binding'); const otherOwner = { ...owner, providerBindingDigest: other };
      const otherAuthority = { ...authority(), providerBinding: { ...authority().providerBinding, bindingDigest: other } };
      runtime = open(path, requests, async () => otherAuthority, otherOwner);
      await expect(runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'final', provider: 'slack', uri: 'ignored',
        body: 'done', threadKey: 'T1|C1|170.001', statusMessageKey: 'run-1:status' })).resolves.toEqual({ outcome: 'activation_blocked' });
      expect(await runtime.composition.kernel.deliverNext()).toBeNull(); expect(requests).toEqual([]); runtime.sqlite.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects a Slack thread key with trailing target segments', async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = []; const runtime = open(':memory:', requests);
    await expect(runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'acknowledgement', provider: 'slack', uri: 'ignored',
      body: 'started', threadKey: 'T1|C1|170.001|unexpected' })).resolves.toEqual({ outcome: 'activation_blocked' });
    expect(await runtime.composition.kernel.deliverNext()).toBeNull(); expect(requests).toEqual([]); runtime.sqlite.close();
  });

  it('blocks an ambiguous prior lifecycle resource before provider I/O', async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = []; const runtime = open(':memory:', requests, async () => authority(), owner, { current: { outcome: 'ambiguous' } });
    await expect(runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'final', provider: 'slack', uri: 'ignored',
      body: 'done', threadKey: 'T1|C1|170.001', statusMessageKey: 'run-1:status' })).resolves.toEqual({ outcome: 'activation_blocked' });
    expect(await runtime.composition.kernel.deliverNext()).toBeNull(); expect(requests).toEqual([]); runtime.sqlite.close();
  });

  it('rechecks the accepted resource at prepare and blocks drift before provider I/O', async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = []; const lookupOverride: { current?: { outcome: 'none' } } = {};
    const runtime = open(':memory:', requests, async () => authority(), owner, lookupOverride);
    await runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'acknowledgement', provider: 'slack', uri: 'ignored',
      body: 'started', threadKey: 'T1|C1|170.001', statusMessageKey: 'run-1:status' });
    await runtime.composition.kernel.deliverNext(); requests.length = 0;
    await expect(runtime.composition.producer.enqueue({ kind: 'business', runId: 'run-1', phase: 'final', provider: 'slack', uri: 'ignored',
      body: 'done', threadKey: 'T1|C1|170.001', statusMessageKey: 'run-1:status' })).resolves.toMatchObject({ outcome: 'queued' });
    lookupOverride.current = { outcome: 'none' };
    await expect(runtime.composition.kernel.deliverNext()).resolves.toEqual({ outcome: 'blocked', reason: 'delivery_request_preparation_failed' });
    expect(requests).toEqual([]); runtime.sqlite.close();
  });

});
