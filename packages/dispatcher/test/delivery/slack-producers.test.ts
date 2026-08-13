import { describe, expect, it, vi } from 'vitest';
import { createSlackEventProcessor } from '../../../slack/src/events.js';

describe('Slack self-service presentation producer', () => {
  it('carries an authenticated Events API status reply as raw cause and presentation', async () => {
    const reply = vi.fn(async () => undefined);
    const processor = createSlackEventProcessor({ resolveChannelBinding: async () => ({ teamId: 'T1', channelId: 'C1', repoProvider: 'github', owner: 'acme', repo: 'demo' }), createRun: async () => ({ runId: 'unused' }),
      reply, now: () => { throw new Error('replay must not call now'); } });
    await processor.process({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event_time: 1_775_692_800,
      api_app_id: 'A1', authorizations: [{ user_id: 'UBOT' }], event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '170.001', text: '<@UBOT> /status' } },
      { agentId: 'opentag' }, { signatureVerified: true });
    expect(reply).toHaveBeenCalledWith({ cause: { assurance: 'verified_http_signature', eventId: 'Ev1', eventTime: 1_775_692_800,
      teamId: 'T1', channelId: 'C1', threadTs: '170.001', userId: 'U1', appId: 'A1', command: 'status' },
      presentation: expect.objectContaining({ text: expect.stringContaining('OpenTag status') }) });
  });

  it('labels Socket Mode assurance without fabricating an HTTP signature', async () => {
    const reply = vi.fn(async () => undefined);
    const processor = createSlackEventProcessor({ resolveChannelBinding: async () => ({ teamId: 'T1', channelId: 'C1', owner: 'acme', repo: 'demo' }),
      createRun: async () => ({ runId: 'unused' }), reply, now: () => 'unused' });
    await processor.process({ type: 'event_callback', team_id: 'T1', event_id: 'Ev2', event_time: 1_775_692_800,
      authorizations: [{ user_id: 'UBOT' }], event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '170.001', text: '<@UBOT> /doctor' } },
      { agentId: 'opentag' }, { transportAssurance: 'authenticated_socket_mode' });
    expect(reply.mock.calls[0]![0].cause).toMatchObject({ assurance: 'authenticated_socket_mode', eventTime: 1_775_692_800, command: 'doctor' });
    expect(reply.mock.calls[0]![0].cause).not.toHaveProperty('webhookSignatureVerified');
  });

  it.each(['bind', 'unbind', 'stop', 'linear', 'help'] as const)('routes %s replies through the same authenticated structural sink', async (command) => {
    const reply = vi.fn(async () => undefined); const processor = createSlackEventProcessor({ resolveChannelBinding: async () => null,
      createRun: async () => ({ runId: 'unused' }), reply, now: () => 'unused' });
    await processor.process({ type: 'event_callback', team_id: 'T1', event_id: `Ev-${command}`, event_time: 1_775_692_800,
      authorizations: [{ user_id: 'UBOT' }], event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '170.001', text: `<@UBOT> /${command}` } },
      { agentId: 'opentag' }, { signatureVerified: true });
    expect(reply).toHaveBeenCalledOnce(); expect(reply.mock.calls[0]![0].cause.command).toBe(command);
  });

  it('does not call the delivery sink for an unauthenticated event', async () => {
    const reply = vi.fn(async () => undefined); const processor = createSlackEventProcessor({ resolveChannelBinding: async () => null,
      createRun: async () => ({ runId: 'unused' }), reply, now: () => 'unused' });
    await processor.process({ type: 'event_callback', team_id: 'T1', event_id: 'Ev-unsafe', event_time: 1_775_692_800,
      authorizations: [{ user_id: 'UBOT' }], event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '170.001', text: '<@UBOT> /help' } }, { agentId: 'opentag' });
    expect(reply).not.toHaveBeenCalled();
  });
});
