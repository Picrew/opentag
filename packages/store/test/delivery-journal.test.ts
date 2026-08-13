import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryIntentV2Schema } from '@opentag/delivery-contract';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createDeliveryKernelRepository,
  type DeliveryClaim,
  type DeliveryPayloadCustody,
} from '../src/delivery-repository.js';
import { createEncryptedFileDeliveryPayloadCustody } from '../src/delivery-payload-custody.js';
import { bootstrapDeliveryJournal } from '../src/delivery-schema.js';

const digest = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const stable = digest('stable');
const owner = {
  providerId: 'slack', providerInstanceId: 'instance_1',
  providerBindingDigest: stable, providerConfigGeneration: 7,
  providerConfigGenerationDigest: stable, runtimeOwnerId: 'installation_1',
  runtimeGeneration: 3, schemaGeneration: 1,
};

function custody(): DeliveryPayloadCustody {
  const values = new Map<string, unknown>();
  const key = (input: Parameters<DeliveryPayloadCustody['read']>[0]) =>
    `${input.intentId}\0${input.journalIntentDigest}\0${input.runtimeOwnerId}`;
  return {
    stage(input) {
      let closed = false;
      return {
        commit() { if (!closed) values.set(key(input), input.envelope); closed = true; },
        rollback() { closed = true; },
      };
    },
    read(input) {
      if (!values.has(key(input))) throw new Error('custody missing');
      return values.get(key(input)) as ReturnType<DeliveryPayloadCustody['read']>;
    },
    recoverJournaled: () => 0,
    reconcile: () => ({ finalized: 0, removed: 0 }),
  };
}

function setup(path = ':memory:') {
  const sqlite = new Database(path);
  bootstrapDeliveryJournal(sqlite);
  const repository = createDeliveryKernelRepository({
    database: drizzle(sqlite), payloadCustody: custody(), owner,
    leaseOwner: 'worker', leaseSeconds: 30,
    now: () => new Date('2026-08-13T00:00:01.000Z'),
  });
  return { sqlite, repository };
}

function intent(overrides: Record<string, unknown> = {}) {
  return DeliveryIntentV2Schema.parse({
    contractVersion: 2, sideEffectIntentId: 'intent_1', causalId: 'cause_1',
    intentKind: 'delivery', operation: 'create', deliveryKind: 'message',
    presentationDigest: stable,
    provenance: { kind: 'business', repositoryIdentityDigest: stable,
      runId: 'run_1', authorityLineageDigest: stable },
    providerBinding: { bindingKind: 'established', providerId: 'slack',
      providerInstanceId: 'instance_1', providerPrincipalDigest: stable,
      principalAssurance: 'configured_declared', bindingDigest: stable,
      providerConfigGeneration: 7, providerConfigGenerationDigest: stable,
      lifecycle: 'active' },
    targetDigest: stable, authorityKind: 'run_authority',
    authoritySnapshotDigest: stable, evidencePolicy: 'local_audit',
    idempotencyKey: 'delivery_1', scope: { kind: 'local_repository', id: 'repo_1' },
    createdAt: '2026-08-13T00:00:00.000Z', initialAttemptSequence: 1,
    ...overrides,
  });
}

function markers(claim: DeliveryClaim, overrides: Record<string, unknown> = {}) {
  return {
    ...claim,
    installationBeginMarkerId: 'installation_marker',
    installationBeginMarkerDigest: digest('installation_marker'),
    scopeBeginMarkerId: 'scope_marker',
    scopeBeginMarkerDigest: digest('scope_marker'),
    ...overrides,
  };
}

function row(sqlite: Database.Database) {
  return sqlite.prepare('SELECT * FROM delivery_attempts WHERE intent_id = ?')
    .get('intent_1') as Record<string, unknown>;
}

describe('fresh delivery journal', () => {
  it('bootstraps one fresh-only journal table with no raw payload columns', () => {
    const { sqlite } = setup();
    expect(sqlite.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'delivery_%' ORDER BY name",
    ).all()).toEqual([{ name: 'delivery_attempts' }]);
    const columns = (sqlite.prepare('PRAGMA table_info(delivery_attempts)').all() as
      Array<{ name: string }>).map(({ name }) => name);
    expect(columns).not.toEqual(expect.arrayContaining([
      'canonical_intent_json', 'persisted_payload_json', 'persisted_payload_digest',
    ]));
  });

  it('records exact replay idempotently and rejects conflicting identities', () => {
    const { repository, sqlite } = setup();
    repository.recordIntent(intent(), { text: 'UNKNOWN_CUSTOMER_SECRET_85c7' });
    repository.recordIntent(intent(), { text: 'UNKNOWN_CUSTOMER_SECRET_85c7' });
    expect(row(sqlite)).toMatchObject({ state: 'pending', revision: 1 });
    expect(sqlite.serialize().includes(Buffer.from('UNKNOWN_CUSTOMER_SECRET_85c7')))
      .toBe(false);
    expect(() => repository.recordIntent(
      intent({ presentationDigest: digest('changed') }), {},
    )).toThrow(/conflict/u);
    expect(() => repository.recordIntent(
      intent({ sideEffectIntentId: 'intent_2', causalId: 'cause_2' }), {},
    )).toThrow(/idempotency conflict/u);
  });

  it('claims globally, renews and releases only the full leased tuple', () => {
    const { repository } = setup();
    repository.recordIntent(intent(), {});
    const first = repository.claimNext({
      leaseOwner: 'worker_a', leaseSeconds: 10,
      now: new Date('2026-08-13T00:00:01.000Z'),
    });
    expect(first).not.toBeNull();
    if (!first) throw new Error('expected claim');
    expect(repository.claimNext({
      leaseOwner: 'worker_b', leaseSeconds: 10,
      now: new Date('2026-08-13T00:00:02.000Z'),
    })).toBeNull();
    expect(repository.renewLease({ ...first, leaseFence: 'wrong' })).toBeNull();
    const renewed = repository.renewLease({
      ...first, leaseOwner: 'worker_a', leaseSeconds: 30,
      now: new Date('2026-08-13T00:00:05.000Z'),
    });
    expect(renewed).toMatchObject({ revision: first.revision + 1 });
    if (!renewed) throw new Error('expected renewal');
    expect(repository.releaseUnusedClaim({ ...renewed, runtimeGeneration: 4 }))
      .toBe(false);
    expect(repository.releaseUnusedClaim(renewed)).toBe(true);
    expect(repository.claimNext({
      leaseOwner: 'worker_b', leaseSeconds: 10,
      now: new Date('2026-08-13T00:00:06.000Z'),
    })).not.toBeNull();
  });

  it('reclaims only expired pre-begin work and never reclaims begun work', () => {
    const { repository } = setup(); repository.recordIntent(intent(), {});
    const first = repository.claimNext({ leaseOwner: 'worker_a', leaseSeconds: 10,
      now: new Date('2026-08-13T00:00:01.000Z') });
    const second = repository.claimNext({ leaseOwner: 'worker_b', leaseSeconds: 10,
      now: new Date('2026-08-13T00:00:12.000Z') });
    expect(second).toMatchObject({ attemptId: first?.attemptId,
      revision: (first?.revision ?? 0) + 1 });
    if (!first || !second) throw new Error('expected claims');
    expect(repository.markBegin(markers(first))).toBeNull();
    const begun = repository.markBegin(markers(second, {
      begunAt: '2026-08-13T00:00:12.500Z',
    }));
    expect(begun).not.toBeNull();
    expect(repository.claimNext({ leaseOwner: 'worker_c', leaseSeconds: 10,
      now: new Date('2026-08-13T00:01:00.000Z') })).toBeNull();
  });

  it.each(['accepted', 'rejected', 'outcome_unknown', 'attention'] as const)(
    'settles %s only after exact durable begin',
    (outcome) => {
      const { repository, sqlite } = setup(); repository.recordIntent(intent(), {});
      const claim = repository.claimNext(); if (!claim) throw new Error('missing claim');
      const begun = repository.markBegin(markers(claim));
      if (!begun) throw new Error('missing begin');
      const input = {
        ...begun, outcome, evidenceDigest: digest(`evidence:${outcome}`),
        ...(outcome === 'accepted' ? {} : {
          errorCode: outcome === 'rejected' ? 'slack_rejected' as const
            : outcome === 'attention' ? 'invalid_delivery_shape' as const
              : 'transport_error' as const,
        }),
      };
      expect(() => repository.settleOrReadTerminal({
        ...input, installationBeginMarkerDigest: digest('wrong'),
      })).toThrow(/tuple conflict/u);
      expect(repository.settleOrReadTerminal(input)).toMatchObject({ outcome });
      expect(row(sqlite)).toMatchObject({ state: outcome });
      expect(repository.claimNext()).toBeNull();
    },
  );

  it('freezes a stale finalize race as outcome_unknown', () => {
    const { repository, sqlite } = setup(); repository.recordIntent(intent(), {});
    const claim = repository.claimNext(); if (!claim) throw new Error('missing claim');
    const begun = repository.markBegin(markers(claim));
    if (!begun) throw new Error('missing begin');
    const stale = repository.settleOrReadTerminal({
      ...begun, revision: claim.revision, outcome: 'accepted',
      evidenceDigest: digest('accepted'),
    });
    expect(stale).toMatchObject({ outcome: 'outcome_unknown',
      errorCode: 'delivery_settlement_stale' });
    expect(row(sqlite)).toMatchObject({ state: 'outcome_unknown' });
  });

  it('recovers stranded begun attempts without making them resendable', () => {
    const { repository, sqlite } = setup(); repository.recordIntent(intent(), {});
    const claim = repository.claimNext(); if (!claim) throw new Error('missing claim');
    repository.markBegin(markers(claim, { begunAt: '2026-08-13T00:00:02.000Z' }));
    expect(repository.finalizeStrandedBegun({
      before: '2026-08-13T00:01:00.000Z', evidenceDigest: digest('restart'),
    })).toBe(1);
    expect(row(sqlite)).toMatchObject({ state: 'outcome_unknown',
      error_code: 'delivery_restart_after_begin' });
    expect(repository.claimNext()).toBeNull();
  });

  it('persists and resolves only bounded exact accepted Slack resources', () => {
    const { repository } = setup();
    const accepted = intent({ statusMessageId: 'run_1:status' });
    repository.recordIntent(accepted, {});
    const claim = repository.claimNext(); if (!claim) throw new Error('missing claim');
    const begun = repository.markBegin(markers(claim));
    if (!begun) throw new Error('missing begin');
    expect(repository.settleOrReadTerminal({
      ...begun, outcome: 'accepted', evidenceDigest: digest('accepted'),
      externalResourceDigest: digest('resource'), externalResourceId: '171.002',
    })).toMatchObject({ externalResourceId: '171.002' });
    expect(repository.findAcceptedExternalResource({
      intent: accepted, statusMessageId: 'run_1:status',
    })).toEqual({ outcome: 'exact', externalResourceId: '171.002',
      externalResourceDigest: digest('resource') });
  });

  it.each([
    ['URI', 'https://hooks.slack.test/171.002'],
    ['token', 'xoxb-secret'],
    ['arbitrary', 'message-171'],
    ['unbounded', `${'1'.repeat(21)}.002`],
  ])('rejects %s external resource identifiers atomically', (_case, value) => {
    const { repository, sqlite } = setup(); repository.recordIntent(intent(), {});
    const claim = repository.claimNext(); if (!claim) throw new Error('missing claim');
    const begun = repository.markBegin(markers(claim));
    if (!begun) throw new Error('missing begin');
    expect(() => repository.settleOrReadTerminal({
      ...begun, outcome: 'accepted', evidenceDigest: digest('accepted'),
      externalResourceDigest: digest('resource'), externalResourceId: value,
    })).toThrow(/Slack timestamp/u);
    expect(row(sqlite)).toMatchObject({ state: 'provider_io_begun',
      external_resource_id: null });
  });

  it('rejects unsafe owner identifiers before persistence or claim', () => {
    const { sqlite } = setup();
    for (const runtimeOwnerId of ['/tmp/runner', 'https://runner.test', 'xoxb-secret']) {
      expect(() => createDeliveryKernelRepository({
        database: drizzle(sqlite), payloadCustody: custody(),
        owner: { ...owner, runtimeOwnerId }, leaseOwner: 'worker', leaseSeconds: 30,
      })).toThrow(/runtimeOwnerId/u);
    }
    const { repository } = setup(); repository.recordIntent(intent(), {});
    for (const leaseOwner of ['/tmp/worker', 'https://worker.test', 'xoxb-secret']) {
      expect(() => repository.claimNext({ leaseOwner })).toThrow(/leaseOwner/u);
    }
  });

  it('reads terminal truth after SQLite restart without a debug repository API', () => {
    const directory = mkdtempSync(join(tmpdir(), 'opentag-delivery-'));
    const path = join(directory, 'journal.sqlite');
    const first = setup(path); first.repository.recordIntent(intent(), {});
    const claim = first.repository.claimNext(); if (!claim) throw new Error('missing claim');
    const begun = first.repository.markBegin(markers(claim));
    if (!begun) throw new Error('missing begin');
    first.repository.settleOrReadTerminal({
      ...begun, outcome: 'accepted', evidenceDigest: digest('accepted'),
      externalResourceDigest: digest('resource'), externalResourceId: '171.002',
    });
    first.sqlite.close();
    const reopened = new Database(path);
    expect(row(reopened)).toMatchObject({ state: 'accepted',
      external_resource_id: '171.002' });
    reopened.close(); rmSync(directory, { recursive: true });
  });

  it('recovers journal-committed staged custody before any claim or provider action', () => {
    const directory = mkdtempSync(join(tmpdir(), 'opentag-delivery-commit-'));
    const path = join(directory, 'journal.sqlite'); const custodyDirectory = join(directory, 'payloads');
    const key = Buffer.alloc(32, 7); let injected = false; let providerActions = 0;
    try {
      const first = new Database(path); bootstrapDeliveryJournal(first);
      const crashed = createDeliveryKernelRepository({ database: drizzle(first), owner, leaseOwner: 'worker', leaseSeconds: 30,
        payloadCustody: createEncryptedFileDeliveryPayloadCustody({ directory: custodyDirectory, trustedBoundary: directory, key,
          fault(point) { if (!injected && point === 'before_finalize') { injected = true; throw new Error('commit_fault'); } } }) });
      expect(() => crashed.recordIntent(intent(), { text: 'frozen presentation' })).toThrow('commit_fault');
      expect(row(first)).toMatchObject({ state: 'pending' });
      expect(readdirSync(custodyDirectory)).toEqual([expect.stringMatching(/\.staged$/u)]);
      first.close();

      const reopened = new Database(path); const repository = createDeliveryKernelRepository({ database: drizzle(reopened), owner,
        leaseOwner: 'worker', leaseSeconds: 30, payloadCustody: createEncryptedFileDeliveryPayloadCustody({ directory: custodyDirectory,
          trustedBoundary: directory, key }) });
      expect(providerActions).toBe(0);
      expect(readdirSync(custodyDirectory)).toEqual([expect.stringMatching(/\.payload$/u)]);
      const claim = repository.claimNext(); if (!claim) throw new Error('missing recovered claim');
      expect(repository.getIntent(claim)).toMatchObject({ outcome: 'hydrated', persistedPayload: { text: 'frozen presentation' } });
      const begun = repository.markBegin(markers(claim)); if (!begun) throw new Error('missing recovered begin');
      providerActions += 1;
      repository.settleOrReadTerminal({ ...begun, outcome: 'accepted', evidenceDigest: digest('recovered') });
      expect(providerActions).toBe(1); expect(repository.claimNext()).toBeNull(); reopened.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
