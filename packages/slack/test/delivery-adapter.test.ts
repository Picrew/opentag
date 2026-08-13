import type { DeliveryIntentV2 } from '@opentag/delivery-contract';
import { describe, expect, it, vi } from 'vitest';

import {
  createSlackDeliveryAdapter,
} from '../src/delivery-adapter.js';

const bindingDigest = `sha256:${'1'.repeat(64)}`;
const principalDigest = `sha256:${'2'.repeat(64)}`;
const generationDigest = `sha256:${'3'.repeat(64)}`;

function intent(operation: 'create' | 'update', deliveryKind: 'message' | 'reaction'): DeliveryIntentV2 {
  return {
    operation,
    deliveryKind,
    providerBinding: {
      bindingKind: 'established',
      providerId: 'slack',
      providerInstanceId: 'slack-primary',
      bindingDigest,
      providerPrincipalDigest: principalDigest,
      principalAssurance: 'provider_verified',
      providerConfigGeneration: 7,
      providerConfigGenerationDigest: generationDigest,
      lifecycle: 'active',
    },
  } as DeliveryIntentV2;
}

function adapter(fetchImpl: typeof fetch, resolveCredential = vi.fn(async () => 'xoxb-super-secret')) {
  return {
    adapter: createSlackDeliveryAdapter({
      providerInstanceId: 'slack-primary',
      bindingDigest,
      providerPrincipalDigest: principalDigest,
      providerConfigGeneration: 7,
      providerConfigGenerationDigest: generationDigest,
      resolveCredential,
      fetchImpl,
      deadlineMs: 20,
    }),
    resolveCredential,
  };
}

describe('Slack delivery adapter', () => {
  it('uses only the selected instance and generation and returns stable accepted evidence', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, ts: '171.002' }));
    const selected = adapter(fetchImpl);
    const input = {
      intent: intent('create', 'message'),
      operation: { kind: 'create_message', channelId: 'C1', threadTs: '170.001' } as const,
      presentation: { kind: 'message', text: 'Hello *there*', textFormat: 'mrkdwn' } as const,
    };

    const first = await selected.adapter.deliver(input);
    const second = await selected.adapter.deliver(input);

    expect(selected.resolveCredential).toHaveBeenCalledTimes(2);
    expect(selected.resolveCredential).toHaveBeenNthCalledWith(1, {
      providerId: 'slack',
      providerInstanceId: 'slack-primary',
      bindingDigest,
      providerPrincipalDigest: principalDigest,
      providerConfigGeneration: 7,
      providerConfigGenerationDigest: generationDigest,
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: 'Bearer xoxb-super-secret',
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: 'C1', text: 'Hello *there*', thread_ts: '170.001' }),
      signal: expect.any(AbortSignal),
    });
    expect(first).toEqual({ outcome: 'accepted', evidenceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), externalResourceId: '171.002' });
    expect(second.evidenceDigest).toBe(first.evidenceDigest);
  });

  it('updates messages and adds reactions with the canonical Slack methods', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, ts: '171.003' }))
      .mockResolvedValueOnce(Response.json({ ok: true, ts: 'ignored' }));
    const selected = adapter(fetchImpl).adapter;

    await selected.deliver({
      intent: intent('update', 'message'),
      operation: { kind: 'update_message', channelId: 'C1', messageTs: '171.002' },
      presentation: { kind: 'message', text: 'Updated' },
    });
    await selected.deliver({
      intent: intent('create', 'reaction'),
      operation: { kind: 'add_reaction', channelId: 'C1', messageTs: '171.002' },
      presentation: { kind: 'reaction', name: 'eyes' },
    });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://slack.com/api/chat.update',
      'https://slack.com/api/reactions.add',
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ channel: 'C1', text: 'Updated', ts: '171.002' });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({ channel: 'C1', timestamp: '171.002', name: 'eyes' });
  });

  it.each([
    ['providerId', { providerId: 'teams' }],
    ['providerInstanceId', { providerInstanceId: 'slack-secondary' }],
    ['bindingDigest', { bindingDigest: `sha256:${'4'.repeat(64)}` }],
    ['providerPrincipalDigest', {
      providerPrincipalDigest: `sha256:${'5'.repeat(64)}`,
    }],
    ['providerConfigGeneration', { providerConfigGeneration: 8 }],
    ['providerConfigGenerationDigest', {
      providerConfigGenerationDigest: `sha256:${'6'.repeat(64)}`,
    }],
  ])('does not resolve credentials or perform provider I/O when %s drifts', async (
    _field,
    changed,
  ) => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, ts: '171.002' }));
    const selected = adapter(fetchImpl);
    const mismatched = intent('create', 'message');
    Object.assign(mismatched.providerBinding, changed);

    await expect(selected.adapter.deliver({
      intent: mismatched,
      operation: { kind: 'create_message', channelId: 'C1' },
      presentation: { kind: 'message', text: 'No send' },
    })).resolves.toMatchObject({ outcome: 'attention', errorCode: 'provider_binding_mismatch' });
    expect(selected.resolveCredential).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['explicit rejection', async () => Response.json({ ok: false, error: 'invalid_auth' }), 'rejected', 'slack_rejected'],
    ['server failure', async () => new Response('secret=xoxb-leak', { status: 503 }), 'outcome_unknown', 'provider_5xx'],
    ['malformed success', async () => new Response('{nope', { status: 200 }), 'outcome_unknown', 'malformed_response'],
    ['ambiguous success', async () => Response.json({ ok: true }), 'outcome_unknown', 'ambiguous_response'],
    ['transport failure', async () => { throw new Error('xoxb-leak /Users/alice/private'); }, 'outcome_unknown', 'transport_error'],
  ])('classifies and sanitizes %s', async (_name, fetcher, outcome, errorCode) => {
    const result = await adapter(vi.fn(fetcher) as unknown as typeof fetch).adapter.deliver({
      intent: intent('create', 'message'),
      operation: { kind: 'create_message', channelId: 'C1' },
      presentation: { kind: 'message', text: 'Hello' },
    });
    expect(result).toMatchObject({ outcome, errorCode, evidenceDigest: expect.stringMatching(/^sha256:/) });
    expect(JSON.stringify(result)).not.toMatch(/xoxb|Users|secret/i);
  });

  it('treats a deadline as outcome unknown without leaking the token', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const result = await adapter(fetchImpl as typeof fetch).adapter.deliver({
      intent: intent('create', 'message'),
      operation: { kind: 'create_message', channelId: 'C1' },
      presentation: { kind: 'message', text: 'Hello' },
    });
    expect(result).toMatchObject({ outcome: 'outcome_unknown', errorCode: 'deadline_exceeded' });
    expect(JSON.stringify(result)).not.toContain('xoxb');
  });
});
