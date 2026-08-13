import { describe, expect, it } from 'vitest';
import { createOpenTagClient } from '../../client/src/index.js';
import {
  createDispatcherApp,
  type DispatcherDeliveryPresentation,
} from '../src/server.js';

const commands = [
  'bind',
  'unbind',
  'stop',
  'linear',
  'help',
  'status',
  'doctor',
] as const;

const request = (command: (typeof commands)[number], extra: object = {}) => ({
  cause: {
    assurance: 'verified_http_signature',
    eventId: `Ev-${command}`,
    eventTime: 1_775_692_800,
    teamId: 'T1',
    channelId: 'C1',
    threadTs: '170.001',
    userId: 'U1',
    appId: 'A1',
    command,
  },
  presentation: {
    text: `${command} reply`,
    textFormat: 'mrkdwn',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${command}*` } }],
  },
  ...extra,
});

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Slack self-service delivery presentation', () => {
  it.each(commands)('maps %s to the single source-thread delivery producer', async (command) => {
    const deliveries: DispatcherDeliveryPresentation[] = [];
    const app = createDispatcherApp({
      databasePath: ':memory:',
      reassessmentObligations: { autoStart: false },
      deliveryProducer: {
        async enqueue(delivery) {
          deliveries.push(delivery);
          return { outcome: 'queued', sideEffectIntentId: `intent-${command}` };
        },
      },
    });

    const response = await app.request(
      '/v1/delivery-presentations/slack-self-service',
      post(request(command)),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      outcome: 'queued',
      sideEffectIntentId: `intent-${command}`,
    });
    expect(deliveries).toEqual([
      {
        kind: 'source_thread_control',
        request: {
          rawText: `/${command}`,
          actor: { provider: 'slack', providerUserId: 'U1' },
          callback: {
            provider: 'slack',
            uri: 'slack:source-thread',
            threadKey: 'T1|C1|170.001',
          },
          metadata: {
            assurance: 'verified_http_signature',
            slackEventId: `Ev-${command}`,
            eventTime: 1_775_692_800,
            teamId: 'T1',
            channelId: 'C1',
            threadTs: '170.001',
            userId: 'U1',
            appId: 'A1',
          },
        },
        command: { verb: command, rawText: `/${command}` },
        body: `${command} reply`,
        textFormat: 'mrkdwn',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${command}*` } },
        ],
      },
    ]);
  });

  it.each([
    ['unknown command', request('help', { cause: { ...request('help').cause, command: 'apply' } })],
    ['extra root key', request('help', { intent: { id: 'forbidden' } })],
    ['unsafe cause key', { ...request('help'), cause: { ...request('help').cause, token: 'secret' } }],
    ['unsafe presentation key', { ...request('help'), presentation: { ...request('help').presentation, uri: 'https://example.test' } }],
    ['invalid assurance', { ...request('help'), cause: { ...request('help').cause, assurance: 'reported' } }],
    ['missing assurance', { ...request('help'), cause: { ...request('help').cause, assurance: undefined } }],
    ['invalid event time', { ...request('help'), cause: { ...request('help').cause, eventTime: -1 } }],
    ['missing event time', { ...request('help'), cause: { ...request('help').cause, eventTime: undefined } }],
    ['oversize identifier', { ...request('help'), cause: { ...request('help').cause, eventId: 'E'.repeat(257) } }],
    ['oversize presentation', { ...request('help'), presentation: { text: 'x'.repeat(4_001) } }],
  ])('rejects %s before enqueue', async (_label, body) => {
    let enqueueCount = 0;
    const app = createDispatcherApp({
      databasePath: ':memory:',
      reassessmentObligations: { autoStart: false },
      deliveryProducer: {
        async enqueue() {
          enqueueCount += 1;
          return { outcome: 'queued', sideEffectIntentId: 'unexpected' };
        },
      },
    });
    const response = await app.request(
      '/v1/delivery-presentations/slack-self-service',
      post(body),
    );
    expect(response.status).toBe(400);
    expect(enqueueCount).toBe(0);
  });

  it('reports default activation blocking without delivery or provider claims', async () => {
    const app = createDispatcherApp({
      databasePath: ':memory:',
      reassessmentObligations: { autoStart: false },
    });
    const response = await app.request(
      '/v1/delivery-presentations/slack-self-service',
      post(request('help')),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ outcome: 'activation_blocked' });

    const audit = (await (
      await app.request(
        '/v1/control-plane-events?type=source_thread_control.delivery_activation_blocked',
      )
    ).json()) as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      type: 'source_thread_control.delivery_activation_blocked',
      payload: {
        provider: 'slack',
        command: 'help',
        deliveryOutcome: 'activation_blocked',
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(/delivered|secret|https?:|Ev-help|help reply/iu);
  });

  it('round-trips through the public client and dispatcher route', async () => {
    const deliveries: DispatcherDeliveryPresentation[] = [];
    const app = createDispatcherApp({
      databasePath: ':memory:',
      pairingToken: 'pair-roundtrip',
      reassessmentObligations: { autoStart: false },
      deliveryProducer: {
        async enqueue(delivery) {
          deliveries.push(delivery);
          return { outcome: 'queued', sideEffectIntentId: 'intent-roundtrip' };
        },
      },
    });
    const client = createOpenTagClient({
      dispatcherUrl: 'http://dispatcher.test',
      pairingToken: 'pair-roundtrip',
      fetchImpl: (input, init) => app.request(input, init),
    });

    await expect(
      client.submitSlackSelfServiceDelivery(request('doctor')),
    ).resolves.toEqual({
      outcome: 'queued',
      sideEffectIntentId: 'intent-roundtrip',
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      kind: 'source_thread_control',
      command: { verb: 'doctor' },
      request: { callback: { threadKey: 'T1|C1|170.001' } },
    });
    const audit = (await (
      await app.request(
        '/v1/control-plane-events?type=source_thread_control.reply_enqueued',
        { headers: { authorization: 'Bearer pair-roundtrip' } },
      )
    ).json()) as { events: Array<{ type: string }> };
    expect(audit.events).toEqual([
      expect.objectContaining({ type: 'source_thread_control.reply_enqueued' }),
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/replied|delivered/iu);
  });
});
