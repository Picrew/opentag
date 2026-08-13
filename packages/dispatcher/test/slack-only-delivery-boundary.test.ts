import { computeLinearSignature } from '@opentag/linear';
import { describe, expect, it } from 'vitest';
import { createDefaultProviderPresentation } from '../src/presentation.js';
import {
  createDispatcherApp,
  type DispatcherDeliveryPresentation,
} from '../src/server.js';

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function signedLinearWebhookRequest(
  payload: unknown,
  webhookSecret: string,
): RequestInit {
  const rawBody = JSON.stringify(payload);
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'linear-signature': computeLinearSignature({ webhookSecret, rawBody }),
    },
    body: rawBody,
  };
}

describe('Slack-only delivery boundary', () => {
  it('accepts a Linear AgentSession ingress without provider I/O', async () => {
    const deliveries: DispatcherDeliveryPresentation[] = [];
    const providerRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      providerRequests.push(String(url));
      return Response.json({
        data: { agentSessionUpdate: { success: true } },
      });
    }) as typeof fetch;
    const presentation = createDefaultProviderPresentation();
    const app = createDispatcherApp({
      databasePath: ':memory:',
      reassessmentObligations: { autoStart: false },
      presentation: {
        ...presentation,
        shouldDeliverRunStatusUpdate: () => false,
      },
      deliveryProducer: {
        async enqueue(delivery) {
          deliveries.push(delivery);
          return {
            outcome: 'queued',
            sideEffectIntentId: `intent_${deliveries.length}`,
          };
        },
      },
    });

    try {
      await app.request(
        '/v1/runners',
        jsonRequest({ runnerId: 'runner_1', name: 'Runner 1' }),
      );
      await app.request(
        '/v1/repo-bindings',
        jsonRequest({
          provider: 'github',
          owner: 'acme',
          repo: 'demo',
          runnerId: 'runner_1',
        }),
      );
      expect(
        (
          await app.request(
            '/v1/linear-relay-installations',
            jsonRequest({
              id: 'install_agent_session',
              webhookPath: '/linear/webhooks/install_agent_session',
              webhookSecret: 'linear_webhook_secret',
              token: 'lin_api_token',
              graphqlUrl: 'https://linear.example/graphql',
              repoProvider: 'github',
              owner: 'acme',
              repo: 'demo',
            }),
          )
        ).status,
      ).toBe(201);

      const payload = {
        type: 'AgentSessionEvent',
        action: 'created',
        webhookId: 'linear_agent_session_created_1',
        organizationId: 'org_1',
        createdAt: '2026-08-13T00:00:00.000Z',
        webhookTimestamp: Date.now(),
        promptContext: '<issue identifier="ENG-1">Fix the regression</issue>',
        agentSession: {
          id: 'agent_session_1',
          creator: { id: 'user_1', name: 'Ada' },
          issue: {
            id: 'issue_1',
            identifier: 'ENG-1',
            title: 'Demo',
            url: 'https://linear.app/acme/issue/ENG-1/demo',
            team: { id: 'team_1', key: 'ENG', name: 'Engineering' },
          },
        },
      };
      const response = await app.request(
        '/linear/webhooks/install_agent_session',
        signedLinearWebhookRequest(payload, 'linear_webhook_secret'),
      );

      expect(response.status).toBe(200);
      const accepted = (await response.json()) as {
        ok: boolean;
        runId: string;
      };
      expect(accepted).toMatchObject({
        ok: true,
        runId: expect.stringMatching(/^run_/),
      });
      expect(deliveries.length).toBeGreaterThan(0);
      expect(providerRequests).toEqual([]);

      const claimResponse = await app.request('/v1/runners/runner_1/claim', {
        method: 'POST',
      });
      expect(claimResponse.status).toBe(200);
      const claim = (await claimResponse.json()) as {
        attemptId: string;
        fencingToken: string;
      };
      const lease = {
        attemptId: claim.attemptId,
        fencingToken: claim.fencingToken,
      };
      expect(
        (
          await app.request(
            `/v1/runners/runner_1/runs/${accepted.runId}/running`,
            jsonRequest({ ...lease, executor: 'echo' }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(
            `/v1/runners/runner_1/runs/${accepted.runId}/progress`,
            jsonRequest({
              ...lease,
              message: 'Halfway done',
              visibility: 'human',
            }),
          )
        ).status,
      ).toBe(200);

      const eventsResponse = await app.request(
        `/v1/runs/${accepted.runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      const { events } = (await eventsResponse.json()) as {
        events: Array<{ type: string }>;
      };
      expect(
        events.filter(
          (event) => event.type === 'delivery.progress.suppressed',
        ),
      ).toHaveLength(2);
      expect(events.map((event) => event.type)).not.toContain(
        'callback.progress.suppressed',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
