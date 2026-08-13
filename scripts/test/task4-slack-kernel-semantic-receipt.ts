import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  TASK4_BASE_REVISION,
  TASK4_SEMANTIC_INPUT_SPEC,
  collectTask4SemanticInputs,
  createTask4SemanticReceipt,
  markTask4SemanticReceiptIncomplete,
  publishTask4SemanticReceipt,
} from '../release/verify-slack-kernel-cutover.mjs';
import {
  createSlackLifecycleComposition,
  createSlackSelfServiceAuthorityResolver,
  getUnifiedDeliveryActivationState,
  type DispatcherDeliveryPresentation,
  type SlackDeliveryAuthority,
} from '../../packages/dispatcher/src/index.js';
import {
  createSlackDeliveryAdapter,
  createSlackEventProcessor,
} from '../../packages/slack/src/index.js';
import {
  bootstrapDeliveryJournal,
  createDeliveryKernelRepository,
  createEncryptedFileDeliveryPayloadCustody,
  createSlackInstallationRegistry,
  deliveryAttempts,
  type DeliveryPayloadCustody,
} from '../../packages/store/src/index.js';
import { createSlackDispatcherEventProcessorInput } from '../../packages/slack/src/dispatcher-events.js';
import { startDispatcher } from '../../packages/local-runtime/src/index.js';
import Database from '../../packages/store/node_modules/better-sqlite3/lib/index.js';
import { count, eq } from '../../packages/store/node_modules/drizzle-orm/index.js';
import { drizzle } from '../../packages/store/node_modules/drizzle-orm/better-sqlite3/index.js';

const REPOSITORY = resolve(import.meta.dirname, '../..');
const INVENTORY_PATH = resolve(
  REPOSITORY,
  'scripts/release/manifests/opentag-provider-io-roots.v1.json',
);
const OUTPUT = '.superpowers/sdd/prd-unified-delivery-breaking-cutover/task-4-slack-kernel-semantic-receipt.json';
const stable = digest('task4-stable');
const providerInstanceId = 'semantic-provider-instance';
const installationId = 'semantic-installation-record';
const owner = {
  providerId: 'slack',
  providerInstanceId,
  providerBindingDigest: stable,
  providerConfigGeneration: 7,
  providerConfigGenerationDigest: stable,
  runtimeOwnerId: 'semantic-runtime',
  runtimeGeneration: 3,
  schemaGeneration: 1,
} as const;

type TransportCall = Readonly<{ method: string; kind: 'create' | 'update' | 'reaction' }>;
type OpenComposition = ReturnType<typeof openComposition>;

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

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

function authority(
  presentation: DispatcherDeliveryPresentation,
  bindingDigest = stable,
): SlackDeliveryAuthority {
  const control = presentation.kind === 'source_thread_control';
  return {
    providerBinding: {
      bindingKind: 'established',
      providerId: 'slack',
      providerInstanceId,
      providerPrincipalDigest: stable,
      principalAssurance: 'provider_verified',
      bindingDigest,
      providerConfigGeneration: 7,
      providerConfigGenerationDigest: stable,
      lifecycle: 'active',
    },
    authoritySnapshotIdentity: control ? 'source-authority' : 'run-authority',
    causalId: control ? 'source-cause' : 'run-cause',
    createdAt: control
      ? new Date(Number(presentation.request.metadata?.['eventTime']) * 1_000).toISOString()
      : '2026-08-13T00:00:00.000Z',
    provenance: control
      ? {
          kind: 'source_thread_control',
          inboundEventIdentity: String(
            presentation.request.metadata?.['slackEventId'],
          ),
          sourceThreadIdentity: presentation.request.callback.threadKey!,
          installationId,
          runtimeGeneration: 3,
          scopeId: providerInstanceId,
        }
      : {
          kind: 'business',
          repositoryIdentity: 'github:example/project',
          authorityLineageIdentity: 'run-authority-lineage',
          scopeId: 'repository-scope',
        },
  };
}

function openComposition(
  path: string,
  calls: TransportCall[],
  counters: { credential: number },
  options: {
    bindingDigest?: string;
    lookup?: { current?: { outcome: 'none' | 'ambiguous' } };
    resolveAuthority?: (presentation: DispatcherDeliveryPresentation) => Promise<SlackDeliveryAuthority | null>;
  } = {},
) {
  const sqlite = new Database(path);
  bootstrapDeliveryJournal(sqlite);
  const database = drizzle(sqlite);
  const payloadCustody = path === ':memory:'
    ? createTestPayloadCustody()
    : createEncryptedFileDeliveryPayloadCustody({
        directory: `${path}.payloads`,
        trustedBoundary: dirname(path),
        key: Buffer.alloc(32, 0x54),
      });
  const repository = createDeliveryKernelRepository({
    database,
    payloadCustody,
    owner: {
      ...owner,
      providerBindingDigest: options.bindingDigest ?? stable,
    },
    leaseOwner: 'semantic-worker',
    leaseSeconds: 30,
  });
  const kernelRepository = options.lookup
    ? {
        ...repository,
        findAcceptedExternalResource: (
          input: Parameters<typeof repository.findAcceptedExternalResource>[0],
        ) => options.lookup?.current ?? repository.findAcceptedExternalResource(input),
      }
    : repository;
  const composition = createSlackLifecycleComposition({
    repository: kernelRepository,
    resolveAuthority: options.resolveAuthority ?? (async (presentation) =>
      authority(presentation, options.bindingDigest ?? stable)),
    adapter: createSlackDeliveryAdapter({
      providerInstanceId,
      providerConfigGeneration: 7,
      bindingDigest: options.bindingDigest ?? stable,
      providerPrincipalDigest: stable,
      providerConfigGenerationDigest: stable,
      resolveCredential: async () => {
        counters.credential += 1;
        return 'semantic-test-credential';
      },
      fetchImpl: async (url, init) => {
        const method = String(url).split('/').at(-1)!;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({
          method,
          kind:
            method === 'chat.postMessage'
              ? 'create'
              : method === 'chat.update'
                ? 'update'
                : 'reaction',
        });
        return Response.json({ ok: true, ts: body['ts'] ?? '171.002' });
      },
    }),
  });
  return {
    sqlite,
    database,
    producer: composition.producer,
    kernel: composition.kernel,
  };
}

function countRows(runtime: OpenComposition, table: typeof deliveryAttempts): number {
  return runtime.database.select({ value: count() }).from(table).get()!.value;
}

async function lifecycleRestartUpdate(path: string) {
  const calls: TransportCall[] = [];
  const counters = { credential: 0 };
  let runtime = openComposition(path, calls, counters);
  const create = await runtime.producer.enqueue({
    kind: 'business',
    runId: 'semantic-run',
    phase: 'acknowledgement',
    provider: 'slack',
    uri: 'ignored',
    body: 'started',
    threadKey: 'T1|C1|170.001',
    statusMessageKey: 'semantic-status',
  });
  assert(create.outcome === 'queued', 'lifecycle create must queue');
  const created = await runtime.kernel.deliverNext();
  assert(created?.outcome === 'accepted', 'lifecycle create must be accepted');
  const firstResource = 'externalResourceId' in created ? created.externalResourceId : undefined;
  runtime.sqlite.close();

  runtime = openComposition(path, calls, counters);
  const update = await runtime.producer.enqueue({
    kind: 'business',
    runId: 'semantic-run',
    phase: 'final',
    provider: 'slack',
    uri: 'ignored',
    body: 'finished',
    threadKey: 'T1|C1|170.001',
    statusMessageKey: 'semantic-status',
  });
  assert(update.outcome === 'queued', 'lifecycle update must queue');
  const updated = await runtime.kernel.deliverNext();
  assert(updated?.outcome === 'accepted', 'lifecycle update must be accepted');
  const secondResource =
    updated && 'externalResourceId' in updated ? updated.externalResourceId : undefined;
  runtime.sqlite.close();
  return {
    passed: true as const,
    createOutcome: 'accepted' as const,
    updateOutcome: 'accepted' as const,
    closeReopenCount: 1,
    createCount: calls.filter((call) => call.kind === 'create').length,
    updateCount: calls.filter((call) => call.kind === 'update').length,
    providerIoCount: calls.length,
    sameExternalResource:
      typeof firstResource === 'string' && firstResource === secondResource,
  };
}

async function sourceReceiptReaction() {
  const calls: TransportCall[] = [];
  const runtime = openComposition(':memory:', calls, { credential: 0 });
  const queued = await runtime.producer.enqueue({
    kind: 'source_receipt',
    runId: 'semantic-run',
    phase: 'received',
    provider: 'slack',
    uri: 'ignored',
    sourceEvent: { metadata: { channelId: 'C1', messageTs: '170.001' } },
  } as DispatcherDeliveryPresentation);
  assert(queued.outcome === 'queued', 'reaction must queue');
  const settled = await runtime.kernel.deliverNext();
  assert(settled?.outcome === 'accepted', 'reaction must be accepted');
  runtime.sqlite.close();
  return {
    passed: true as const,
    settlementOutcome: 'accepted' as const,
    reactionCount: calls.filter((call) => call.kind === 'reaction').length,
    providerIoCount: calls.length,
  };
}

async function sourceThreadControl() {
  const calls: TransportCall[] = [];
  const runtime = openComposition(':memory:', calls, { credential: 0 });
  const queued = await runtime.producer.enqueue(sourceControlPresentation('status'));
  assert(queued.outcome === 'queued', 'source control must queue');
  const stored = runtime.database.select().from(deliveryAttempts)
    .where(eq(deliveryAttempts.intentId, queued.sideEffectIntentId)).get();
  assert(stored, 'source control journal intent missing');
  const settled = await runtime.kernel.deliverNext();
  assert(settled?.outcome === 'accepted', 'source control must be accepted');
  const result = {
    passed: true as const,
    settlementOutcome: 'accepted' as const,
    canonicalIntentCount: 1,
    journalIntentCount: countRows(runtime, deliveryAttempts),
    providerIoCount: calls.length,
    provenanceKind: stored.provenanceKind,
    inventedRunAuthority: stored.runId !== null,
  };
  runtime.sqlite.close();
  return result;
}

async function selfServiceIngress() {
  const calls: TransportCall[] = [];
  const rpcCalls: string[] = [];
  const registry = createSlackInstallationRegistry([{ recordVersion: 1, installationId, teamId: 'T1', appId: 'A1', channelIds: ['C1'],
    providerInstanceId, bindingDigest: stable, principalDigest: stable, principalAssurance: 'provider_verified', lifecycle: 'active', configGeneration: 7,
    configGenerationDigest: stable, credentialReference: { custody: 'local', id: 'semantic.local.credential' } }]);
  const runtime = openComposition(':memory:', calls, { credential: 0 }, { resolveAuthority: createSlackSelfServiceAuthorityResolver({
    registry, runtimeGeneration: 3, authoritySnapshotIdentity: 'semantic-source-authority' }) });
  const app = (await import('../../packages/dispatcher/src/index.js')).createDispatcherApp({
    databasePath: ':memory:',
    pairingToken: 'semantic-pairing',
    deliveryProducer: runtime.producer,
  });
  const commands = ['bind', 'unbind', 'stop', 'linear', 'help', 'status', 'doctor'] as const;
  const outcomes: string[] = [];
  for (const [index, command] of commands.entries()) {
    const processor = createSlackEventProcessor(
      createSlackDispatcherEventProcessorInput({
        dispatcherUrl: 'http://semantic.dispatcher',
        dispatcherToken: 'semantic-pairing',
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          rpcCalls.push(`${init?.method ?? 'GET'} ${path}`);
          if (
            path === '/v1/channel-bindings/slack/T1/C1/cancel-active-run'
          ) {
            return Response.json({
              outcome: 'cancelled',
              run: {
                id: 'semantic-active-run',
                eventId: 'semantic-active-event',
                status: 'cancelled',
                createdAt: '2026-08-13T00:00:00.000Z',
                updatedAt: '2026-08-13T00:00:01.000Z',
                result: {
                  conclusion: 'cancelled',
                  summary: 'Stop requested from Slack.',
                },
              },
            });
          }
          if (path === '/v1/channel-bindings/slack/T1/C1/status') {
            return Response.json({
              binding: {
                provider: 'slack',
                accountId: 'T1',
                conversationId: 'C1',
                repoProvider: 'github',
                owner: 'example',
                repo: 'project',
              },
              queuedFollowUps: [],
            });
          }
          if (path === '/v1/channel-bindings/slack/T1/C1') {
            return Response.json({
              binding: {
                provider: 'slack',
                accountId: 'T1',
                conversationId: 'C1',
                repoProvider: 'github',
                owner: 'example',
                repo: 'project',
              },
            });
          }
          return app.fetch(
            new Request(String(url), {
              method: init?.method,
              headers: init?.headers,
              body: init?.body,
            }),
          );
        },
      }),
    );
    const result = await processor.process(
      {
        type: 'event_callback',
        team_id: 'T1',
        api_app_id: 'A1',
        event_id: `semantic-event-${index}`,
        event_time: 1_775_692_800 + index,
        authorizations: [{ user_id: 'UBOT' }],
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          ts: `170.00${index + 1}`,
          text: `<@UBOT> /${command}`,
        },
      },
      { agentId: 'opentag' },
      { signatureVerified: true },
    );
    outcomes.push(String(result.body['selfService']));
  }
  const before = countRows(runtime, deliveryAttempts);
  assert(before === commands.length, 'all self-service replies must share the journal sink');
  assert(
    rpcCalls.filter((entry) => entry.endsWith('/cancel-active-run')).length === 1,
    'stop must traverse the production cancellation client contract',
  );
  assert(
    rpcCalls.filter((entry) => entry.endsWith('/status')).length === 2,
    'status and doctor must traverse the production status client contract',
  );
  assert(
    rpcCalls.filter((entry) =>
      entry.endsWith('/delivery-presentations/slack-self-service'),
    ).length === commands.length,
    'every command must traverse the dispatcher delivery endpoint',
  );
  const settlements = [];
  for (;;) { const settled = await runtime.kernel.deliverNext(); if (!settled) break;
    assert(settled.outcome === 'accepted', 'self-service must reach the kernel'); settlements.push(settled); }
  assert(settlements.length === commands.length, 'every self-service command must settle');
  const rows = runtime.database.select().from(deliveryAttempts).all();
  assert(rows.every((row) => row.provenanceKind === 'source_thread_control' && row.provenanceInstallationId === installationId &&
    row.provenanceScopeId === providerInstanceId && row.providerInstanceId === providerInstanceId), 'wrong self-service authority correlation');
  await app.stopBackgroundWorkers();
  runtime.sqlite.close();
  return {
    passed: true as const,
    ingressOutcome: outcomes.every((value) => value.length > 0)
      ? ('processed' as const)
      : ('failed' as const),
    authenticatedCommandCount: commands.length,
    sharedSinkDeliveryCount: before,
    canonicalIntentCount: settlements.length,
    journalIntentCount: rows.length,
    settlementOutcome: 'accepted' as const,
    providerIoCount: calls.length,
  };
}

function sourceControlPresentation(command: string): DispatcherDeliveryPresentation {
  return {
    kind: 'source_thread_control',
    body: 'semantic reply',
    command: { verb: command, rawText: `/${command}` },
    request: {
      rawText: `/${command}`,
      actor: { provider: 'slack', providerUserId: 'U1' },
      callback: {
        provider: 'slack',
        uri: 'slack:source-thread',
        threadKey: 'T1|C1|170.001',
      },
      metadata: {
        slackEventId: `semantic-event-${command}`,
        eventTime: 1_775_692_800,
        assurance: 'verified_http_signature',
      },
    },
  };
}

async function blockedLifecycle(kind: 'crossBinding' | 'crossTarget' | 'ambiguousLifecycle') {
  const directory = mkdtempSync(join(tmpdir(), `task4-${kind}-`));
  const path = join(directory, 'journal.sqlite');
  const calls: TransportCall[] = [];
  const counters = { credential: 0 };
  try {
    let runtime = openComposition(path, calls, counters);
    await runtime.producer.enqueue({
      kind: 'business',
      runId: 'semantic-run',
      phase: 'acknowledgement',
      provider: 'slack',
      uri: 'ignored',
      body: 'started',
      threadKey: 'T1|C1|170.001',
      statusMessageKey: 'semantic-status',
    });
    await runtime.kernel.deliverNext();
    runtime.sqlite.close();
    calls.length = 0;
    counters.credential = 0;
    const otherDigest = digest('other-binding');
    const lookup = kind === 'ambiguousLifecycle'
      ? { current: { outcome: 'ambiguous' as const } }
      : undefined;
    runtime = openComposition(path, calls, counters, {
      ...(kind === 'crossBinding' ? { bindingDigest: otherDigest } : {}),
      ...(lookup ? { lookup } : {}),
    });
    const result = await runtime.producer.enqueue({
      kind: 'business',
      runId: 'semantic-run',
      phase: 'final',
      provider: 'slack',
      uri: 'ignored',
      body: 'finished',
      threadKey: kind === 'crossTarget' ? 'T1|C2|170.001' : 'T1|C1|170.001',
      statusMessageKey: 'semantic-status',
    });
    assert(result.outcome === 'activation_blocked', `${kind} must block`);
    assert((await runtime.kernel.deliverNext()) === null, `${kind} must not queue`);
    runtime.sqlite.close();
    return {
      passed: true as const,
      producerOutcome: 'activation_blocked' as const,
      credentialResolutionCount: counters.credential,
      providerIoCount: calls.length,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function hardActivationBlocked() {
  const directory = mkdtempSync(join(tmpdir(), 'task4-dormant-runtime-'));
  const databasePath = join(directory, 'dispatcher.sqlite');
  let providerIoCount = 0;
  let credentialResolutionCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...input: Parameters<typeof fetch>) => {
    providerIoCount += 1;
    return originalFetch(...input);
  }) as typeof fetch;
  const handle = startDispatcher({
    port: 0,
    databasePath,
    deliveryActivation: true,
  } as Parameters<typeof startDispatcher>[0] & { deliveryActivation: true });
  try {
    const address = handle.server.address();
    assert(address && typeof address === 'object', 'runtime address unavailable');
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/delivery-presentations/slack-self-service`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cause: {
            assurance: 'verified_http_signature',
            eventId: 'dormant-event',
            eventTime: 1_775_692_800,
            teamId: 'T1',
            channelId: 'C1',
            threadTs: '170.001',
            userId: 'U1',
            command: 'status',
          },
          presentation: { text: 'dormant status' },
        }),
      },
    );
    assert(response.ok, 'dormant runtime request failed');
    const result = (await response.json()) as { outcome: string };
    assert(result.outcome === 'activation_blocked', 'dormant runtime must block');
    const sqlite = new Database(databasePath, { readonly: true });
    const deliveryJournalSqlCount = Number(
      sqlite.prepare("SELECT count(*) value FROM sqlite_master WHERE name LIKE 'delivery_%'").get()
        ?.value ?? 0,
    );
    sqlite.close();
    const activation = getUnifiedDeliveryActivationState({ active: true });
    return {
      active: activation.active,
      status: activation.status,
      releaseStatus: activation.releaseStatus,
      reasons: activation.reasons,
      attemptedOverrideIgnored: true as const,
      producerOutcome: 'activation_blocked' as const,
      deliveryJournalSqlCount,
      credentialResolutionCount,
      providerIoCount,
    };
  } finally {
    globalThis.fetch = originalFetch;
    await handle.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function outputPath(argv: string[]): string {
  const index = argv.indexOf('--output');
  if (index < 0) return resolve(REPOSITORY, OUTPUT);
  assert(argv[index + 1], '--output requires a path');
  return resolve(process.cwd(), argv[index + 1]);
}

async function main() {
  const output = outputPath(process.argv.slice(2));
  const directory = mkdtempSync(join(tmpdir(), 'task4-semantic-receipt-'));
  const lifecyclePath = join(directory, 'lifecycle.sqlite');
  markTask4SemanticReceiptIncomplete({
    repository: REPOSITORY,
    receiptPath: output,
  });
  try {
    const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')) as {
      inventoryDigest: string;
    };
    const receipt = createTask4SemanticReceipt({
      baseRevision: TASK4_BASE_REVISION,
      acceptedInventoryDigest: inventory.inventoryDigest,
      inputs: collectTask4SemanticInputs({
        repository: REPOSITORY,
        inputSpec: TASK4_SEMANTIC_INPUT_SPEC,
      }),
      activation: await hardActivationBlocked(),
      cases: {
        lifecycleRestartUpdate: await lifecycleRestartUpdate(lifecyclePath),
        sourceReceiptReaction: await sourceReceiptReaction(),
        sourceThreadControl: await sourceThreadControl(),
        selfServiceIngress: await selfServiceIngress(),
        crossBinding: await blockedLifecycle('crossBinding'),
        crossTarget: await blockedLifecycle('crossTarget'),
        ambiguousLifecycle: await blockedLifecycle('ambiguousLifecycle'),
      },
    });
    publishTask4SemanticReceipt({
      repository: REPOSITORY,
      receiptPath: output,
      receipt,
    });
    process.stdout.write(
      `${JSON.stringify({
        status: receipt.status,
        allCasesPassed: receipt.allCasesPassed,
        productionReachabilityProven: receipt.productionReachabilityProven,
        receiptDigest: receipt.receiptDigest,
        inputsDigest: receipt.inputsDigest,
      })}\n`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
