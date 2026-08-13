import type { OpenTagEvent, OpenTagRun } from '@opentag/core';
import {
  DeliveryIntentV2Schema,
  type DeliveryIntentV2,
} from '@opentag/delivery-contract';
import type { createOpenTagRepository } from '@opentag/store';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedDeliveryProducer } from '../src/delivery/producer.js';
import { createDefaultProviderPresentation } from '../src/presentation.js';
import {
  createSourceThreadControlHandler,
  type SourceThreadControlDeliveryPresentation,
} from '../src/source-thread-control.js';

type OpenTagRepository = ReturnType<typeof createOpenTagRepository>;
const digest = `sha256:${'c'.repeat(64)}`;

function request() {
  return {
    id: 'thread-action-1',
    rawText: '@opentag /doctor',
    actor: {
      provider: 'github',
      providerUserId: '42',
      handle: 'octocat',
      writeAccess: true,
    },
    callback: {
      provider: 'github',
      uri: 'https://api.github.com/repos/acme/demo/issues/1/comments',
      threadKey: 'acme/demo#1',
    },
  };
}

function event(): OpenTagEvent {
  return {
    id: 'event-1',
    source: 'github',
    sourceEventId: 'comment-1',
    receivedAt: '2026-08-13T00:00:00.000Z',
    actor: {
      provider: 'github',
      providerUserId: '42',
      handle: 'octocat',
    },
    target: { mention: '@opentag', agentId: 'opentag' },
    command: { rawText: 'fix this', intent: 'fix', args: {} },
    context: [],
    permissions: [],
    callback: request().callback,
    metadata: { repoProvider: 'github', owner: 'acme', repo: 'demo' },
  };
}

function repository(active?: { run: OpenTagRun; event: OpenTagEvent }) {
  return {
    findCancelableRunForConversation: vi.fn(async () => active ?? null),
    getRepoBinding: vi.fn(async () => null),
    listQueuedFollowUpsForActiveRun: vi.fn(async () => []),
    listRunEvents: vi.fn(async () => []),
  } as unknown as OpenTagRepository;
}

function validRunlessIntent(): DeliveryIntentV2 {
  return DeliveryIntentV2Schema.parse({
    contractVersion: 2,
    sideEffectIntentId: 'intent-source-thread-1',
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
      runtimeGeneration: 2,
      scopeId: 'github-installation-1',
    },
    providerBinding: {
      bindingKind: 'established',
      providerId: 'github',
      providerInstanceId: 'github-installation-1',
      providerPrincipalDigest: digest,
      principalAssurance: 'provider_verified',
      providerConfigGeneration: 5,
      providerConfigGenerationDigest: digest,
      lifecycle: 'active',
      bindingDigest: digest,
    },
    targetDigest: digest,
    authorityKind: 'local_source_thread_control',
    authoritySnapshotDigest: digest,
    evidencePolicy: 'local_audit',
    idempotencyKey: 'source-thread-control-reply-1',
    scope: { kind: 'provider_instance', id: 'github-installation-1' },
    createdAt: '2026-08-13T00:00:00.000Z',
    initialAttemptSequence: 1,
    installationId: 'github-installation-1',
    runtimeGeneration: 2,
  });
}

function options(input: {
  repo?: OpenTagRepository;
  deliveryProducer: {
    enqueue(presentation: SourceThreadControlDeliveryPresentation): Promise<
      | { outcome: 'queued'; sideEffectIntentId: string }
      | { outcome: 'activation_blocked' }
    >;
  };
  events: Array<{ type: string; payload?: Record<string, unknown> }>;
}) {
  return {
    repo: input.repo ?? repository(),
    presentation: createDefaultProviderPresentation(),
    conversationKeysFromThreadAction: () => ['github:acme/demo#1'],
    latestRunTimeoutMs: () => undefined,
    deliveryProducer: input.deliveryProducer,
    async recordControlPlaneEvent(event: {
      type: string;
      payload?: Record<string, unknown>;
    }) {
      input.events.push(event);
    },
  };
}

describe('source-thread control unified delivery', () => {
  it('enqueues a runless source_thread_control intent without fabricating a Run or accepted receipt', async () => {
    const submitted: DeliveryIntentV2[] = [];
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const producer = new UnifiedDeliveryProducer<SourceThreadControlDeliveryPresentation>({
      async resolveIntent(presentation) {
        expect(presentation.kind).toBe('source_thread_control');
        expect(presentation.auditRunId).toBeUndefined();
        expect(presentation.request.id).toBe('thread-action-1');
        return {
          intent: validRunlessIntent(),
          persistedPayload: {
            body: presentation.body,
          },
        };
      },
      submitter: {
        async enqueue(intent) {
          submitted.push(intent);
          return { outcome: 'queued' };
        },
      },
    });
    const handler = createSourceThreadControlHandler(
      options({ deliveryProducer: producer, events }),
    );

    const response = await handler.handle({
      request: request(),
      command: { verb: 'doctor', rawText: '/doctor' },
    });

    expect(response.status).toBe(200);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      operation: 'control_reply',
      provenance: { kind: 'source_thread_control' },
    });
    expect(submitted[0]).not.toHaveProperty('provenance.runId');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'source_thread_control.reply_enqueued',
        payload: expect.objectContaining({
          auditedOnRun: null,
          sideEffectIntentId: 'intent-source-thread-1',
          deliveryOutcome: 'queued',
        }),
      }),
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'source_thread_control.replied' }),
    );
    expect(JSON.stringify(events)).not.toContain(request().callback.uri);
    expect(JSON.stringify(events)).not.toContain(request().callback.threadKey!);
  });

  it('carries only a real active Run id as optional audit context', async () => {
    const activeEvent = event();
    const activeRun: OpenTagRun = {
      id: 'run-active-1',
      eventId: activeEvent.id,
      status: 'running',
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:01:00.000Z',
    };
    const enqueue = vi.fn(async () => ({
      outcome: 'queued' as const,
      sideEffectIntentId: 'intent-active-1',
    }));
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const handler = createSourceThreadControlHandler(
      options({
        repo: repository({ run: activeRun, event: activeEvent }),
        deliveryProducer: { enqueue },
        events,
      }),
    );

    await handler.handle({
      request: request(),
      command: { verb: 'doctor', rawText: '/doctor' },
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ auditRunId: 'run-active-1' }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'source_thread_control.reply_enqueued',
        payload: expect.objectContaining({ auditedOnRun: 'run-active-1' }),
      }),
    ]);
  });

  it('records activation blocking and never falls back to a direct sink', async () => {
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const enqueue = vi.fn(async () => ({ outcome: 'activation_blocked' as const }));
    const handler = createSourceThreadControlHandler(
      options({ deliveryProducer: { enqueue }, events }),
    );

    await handler.handle({
      request: request(),
      command: { verb: 'doctor', rawText: '/doctor' },
    });

    expect(enqueue).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'source_thread_control.delivery_activation_blocked',
      }),
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'source_thread_control.reply_enqueued' }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'source_thread_control.replied' }),
    );
  });
});
