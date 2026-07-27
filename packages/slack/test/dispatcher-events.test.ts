import { describe, expect, it, vi } from "vitest";
import { createSlackDispatcherEventProcessorInput, type SlackDispatcherEventConfig } from "../src/dispatcher-events.js";

describe("Slack dispatcher-backed self-service", () => {
  it.each([
    ["appId", { dispatcherUrl: "http://dispatcher.test", appId: "A123" }],
    ["channelPrincipalCredential", { dispatcherUrl: "http://dispatcher.test", channelPrincipalCredential: "slack_principal_123" }]
  ])("rejects Slack dispatcher config with only %s", (_field, config) => {
    expect(() => createSlackDispatcherEventProcessorInput(config as unknown as SlackDispatcherEventConfig)).toThrow(
      "Slack appId and channelPrincipalCredential must be configured together."
    );
  });

  it("does not expose a partial repository target from a dispatcher binding", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      binding: {
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        repoProvider: "github",
        owner: "acme"
      }
    })) as unknown as typeof fetch;
    const processorInput = createSlackDispatcherEventProcessorInput({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl
    });

    await expect(processorInput.resolveChannelBinding({ teamId: "T123", channelId: "C123" })).resolves.toEqual({
      teamId: "T123",
      channelId: "C123"
    });
  });

  it("renders dispatcher channel status and posts it back to the Slack thread", async () => {
    const requests: Array<{ url: string; authorization?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        url: href,
        ...(headers?.authorization ? { authorization: headers.authorization } : {}),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {})
      });
      if (href === "http://dispatcher.test/v1/channel-bindings/slack/T123/C123/status") {
        return Response.json({
          binding: {
            provider: "slack",
            accountId: "T123",
            conversationId: "C123",
            repoProvider: "github",
            owner: "acme",
            repo: "demo"
          },
          activeRun: {
            id: "run_active",
            eventId: "evt_active",
            status: "running",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:02:00.000Z"
          },
          activeEvent: {
            id: "evt_active",
            source: "slack",
            sourceEventId: "EvActive",
            receivedAt: "2026-06-24T00:00:00.000Z",
            actor: { provider: "slack", providerUserId: "U456", handle: "alice", organizationId: "T123" },
            target: { mention: "<@U_APP>", agentId: "opentag" },
            command: { rawText: "fix the bug", intent: "fix", args: {} },
            context: [],
            permissions: [],
            callback: {
              provider: "slack",
              uri: "https://slack.com/api/chat.postMessage",
              threadKey: "T123|C123|1719187200.000100"
            },
            metadata: { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }
          },
          runTimeoutPolicy: { hardTimeoutMs: 45_000 },
          queuedFollowUps: [
            {
              id: "follow_up_1",
              sourceEventId: "EvFollowUp",
              conversationKey: "slack:T123|C123|1719187200.000100",
              activeRunId: "run_active",
              event: {
                id: "evt_follow_up",
                source: "slack",
                sourceEventId: "EvFollowUp",
                receivedAt: "2026-06-24T00:01:00.000Z",
                actor: { provider: "slack", providerUserId: "U456", handle: "alice", organizationId: "T123" },
                target: { mention: "<@U_APP>", agentId: "opentag" },
                command: { rawText: "update the docs too", intent: "fix", args: {} },
                context: [],
                permissions: [],
                callback: {
                  provider: "slack",
                  uri: "https://slack.com/api/chat.postMessage",
                  threadKey: "T123|C123|1719187200.000100"
                },
                metadata: { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }
              },
              decision: {
                action: "queue_follow_up",
                reason: "A run is already active for this thread.",
                reasonCode: "active_run_same_thread",
                decidedAt: "2026-06-24T00:01:00.000Z",
                activeRunId: "run_active",
                eventId: "evt_follow_up"
              },
              status: "queued",
              createdAt: "2026-06-24T00:01:00.000Z",
              updatedAt: "2026-06-24T00:01:00.000Z"
            }
          ]
        });
      }
      if (href === "https://slack.com/api/chat.postMessage") {
        return Response.json({ ok: true, ts: "1719187201.000100" });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const processorInput = createSlackDispatcherEventProcessorInput({
      dispatcherUrl: "http://dispatcher.test",
      dispatcherToken: "dispatcher_token",
      botToken: "xoxb-test",
      runTimeoutMs: 30_000,
      fetchImpl
    });

    const reply = await processorInput.status!({
      teamId: "T123",
      channelId: "C123",
      threadTs: "1719187200.000100",
      userId: "U456",
      binding: { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }
    });
    await processorInput.reply!({
      channelId: "C123",
      threadTs: "1719187200.000100",
      text: typeof reply === "string" ? reply : reply.text,
      blocks: typeof reply === "string" ? undefined : reply.blocks
    });

    expect(requests).toEqual([
      expect.objectContaining({
        url: "http://dispatcher.test/v1/channel-bindings/slack/T123/C123/status",
        authorization: "Bearer dispatcher_token"
      }),
      expect.objectContaining({
        url: "https://slack.com/api/chat.postMessage",
        authorization: "Bearer xoxb-test",
        body: expect.objectContaining({
          channel: "C123",
          thread_ts: "1719187200.000100",
          text: expect.stringContaining("OpenTag status:")
        })
      })
    ]);
    expect(JSON.stringify(requests[1]?.body)).toContain("*Active run:* run_active (running)");
    expect(JSON.stringify(requests[1]?.body)).toContain("follow_up_1 (queued): update the docs too");
    expect(JSON.stringify(requests[1]?.body)).toContain("timeout policy: hard timeout after 45 second(s).");
  });

  it("posts a reply with textFormat: mrkdwn without re-escaping a hand-built Slack link", async () => {
    const requests: Array<{ url: string; authorization?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        url: href,
        ...(headers?.authorization ? { authorization: headers.authorization } : {}),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {})
      });
      if (href === "https://slack.com/api/chat.postMessage") {
        return Response.json({ ok: true, ts: "1719187201.000100" });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const processorInput = createSlackDispatcherEventProcessorInput({
      dispatcherUrl: "http://dispatcher.test",
      botToken: "xoxb-test",
      fetchImpl
    });

    await processorInput.reply!({
      channelId: "C123",
      threadTs: "1719187200.000100",
      text: "<https://x|A>",
      textFormat: "mrkdwn"
    });

    expect(requests).toEqual([
      expect.objectContaining({
        url: "https://slack.com/api/chat.postMessage",
        authorization: "Bearer xoxb-test",
        body: expect.objectContaining({
          channel: "C123",
          thread_ts: "1719187200.000100",
          text: "<https://x|A>"
        })
      })
    ]);
  });

  it("cancels a specific run through the dispatcher", async () => {
    const requests: Array<{ url: string; authorization?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        url: href,
        ...(headers?.authorization ? { authorization: headers.authorization } : {}),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {})
      });
      if (href === "http://dispatcher.test/v1/runs/run_active/cancel") {
        return Response.json({
          outcome: "cancelled",
          run: {
            id: "run_active",
            eventId: "evt_active",
            status: "cancelled",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:02:00.000Z"
          }
        });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const processorInput = createSlackDispatcherEventProcessorInput({
      dispatcherUrl: "http://dispatcher.test",
      dispatcherToken: "dispatcher_token",
      fetchImpl
    });

    await expect(
      processorInput.stopRun!({
        teamId: "T123",
        channelId: "C123",
        runId: "run_active",
        requestedBy: "slack:U456"
      })
    ).resolves.toEqual({ outcome: "cancelled", runId: "run_active" });

    expect(requests).toEqual([
      expect.objectContaining({
        url: "http://dispatcher.test/v1/runs/run_active/cancel",
        authorization: "Bearer dispatcher_token",
        body: {
          reason: "Stop requested from Slack.",
          requestedBy: "slack:U456"
        }
      })
    ]);
  });

  it("cancels the active Slack channel run through the dispatcher", async () => {
    const requests: Array<{ url: string; authorization?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        url: href,
        ...(headers?.authorization ? { authorization: headers.authorization } : {}),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {})
      });
      if (href === "http://dispatcher.test/v1/channel-bindings/slack/T123/C123/cancel-active-run") {
        return Response.json({
          outcome: "cancelled",
          run: {
            id: "run_active",
            eventId: "evt_active",
            status: "cancelled",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:02:00.000Z"
          }
        });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const processorInput = createSlackDispatcherEventProcessorInput({
      dispatcherUrl: "http://dispatcher.test",
      dispatcherToken: "dispatcher_token",
      fetchImpl
    });

    await expect(
      processorInput.stopRun!({
        teamId: "T123",
        channelId: "C123",
        requestedBy: "slack:U456"
      })
    ).resolves.toEqual({ outcome: "cancelled", runId: "run_active" });

    expect(requests).toEqual([
      expect.objectContaining({
        url: "http://dispatcher.test/v1/channel-bindings/slack/T123/C123/cancel-active-run",
        authorization: "Bearer dispatcher_token",
        body: {
          reason: "Stop requested from Slack.",
          requestedBy: "slack:U456"
        }
      })
    ]);
  });

  it("binds a Slack channel through the dispatcher", async () => {
    const requests: Array<{ url: string; authorization?: string; principal?: string; body?: unknown; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const headers = new Headers(init?.headers);
      requests.push({
        url: href,
        ...(init?.method ? { method: init.method } : {}),
        ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}),
        ...(headers.get("x-opentag-channel-principal") ? { principal: headers.get("x-opentag-channel-principal")! } : {}),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {})
      });
      if (href === "http://dispatcher.test/v1/channel-bindings" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const processorInput = createSlackDispatcherEventProcessorInput({
      dispatcherUrl: "http://dispatcher.test",
      dispatcherToken: "dispatcher_token",
      channelPrincipalCredential: "slack_principal_123",
      appId: "A123",
      fetchImpl
    });

    await expect(
      processorInput.bindChannel!({
        teamId: "T123",
        channelId: "C123",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    ).resolves.toBeUndefined();

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/channel-bindings",
        method: "POST",
        authorization: "Bearer dispatcher_token",
        principal: "slack_principal_123",
        body: {
          provider: "slack",
          accountId: "T123",
          conversationId: "C123",
          repoProvider: "github",
          owner: "acme",
          repo: "demo",
          ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
        }
      }
    ]);
  });

  it("authorizes Slack channel binding managers from configured user ids", () => {
    const processorInput = createSlackDispatcherEventProcessorInput({
      dispatcherUrl: "http://dispatcher.test",
      bindingAdminUserIds: ["U_ADMIN"]
    });

    expect(
      processorInput.canManageBinding!({
        action: "bind",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1719187200.000100",
        userId: "U_ADMIN",
        eventId: "EvBind"
      })
    ).toBe(true);
    expect(
      processorInput.canManageBinding!({
        action: "unbind",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1719187200.000100",
        userId: "U_VIEWER",
        eventId: "EvUnbind"
      })
    ).toBe(false);
  });

  it("unbinds a Slack channel through the dispatcher", async () => {
    const requests: Array<{ url: string; method?: string; authorization?: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        url: href,
        ...(init?.method ? { method: init.method } : {}),
        ...(headers?.authorization ? { authorization: headers.authorization } : {})
      });
      if (href === "http://dispatcher.test/v1/channel-bindings/slack/T123/C123" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const processorInput = createSlackDispatcherEventProcessorInput({
      dispatcherUrl: "http://dispatcher.test",
      dispatcherToken: "dispatcher_token",
      fetchImpl
    });

    await expect(
      processorInput.unbindChannel!({
        teamId: "T123",
        channelId: "C123"
      })
    ).resolves.toBeUndefined();

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/channel-bindings/slack/T123/C123",
        method: "DELETE",
        authorization: "Bearer dispatcher_token"
      }
    ]);
  });
});

describe("linear handler passthrough", () => {
  it("copies the configured linear handler into the processor input", () => {
    const linear = async () => "backlog";
    const input = createSlackDispatcherEventProcessorInput({ dispatcherUrl: "http://localhost:3030", linear });
    expect(input.linear).toBe(linear);
  });

  it("leaves linear undefined when not configured", () => {
    const input = createSlackDispatcherEventProcessorInput({ dispatcherUrl: "http://localhost:3030" });
    expect(input.linear).toBeUndefined();
  });
});
