import { afterEach, describe, expect, it, vi } from "vitest";
import type { LarkInboundMessageEvent } from "../src/app.js";
import { DEFAULT_AGENT_ID, larkIngressConfigFromEnv, startLarkIngress } from "../src/ingress.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Lark ingress runtime", () => {
  it("fails clearly when required environment values are missing", () => {
    expect(() => larkIngressConfigFromEnv({})).toThrow("LARK_APP_ID and LARK_APP_SECRET are required");
    expect(() =>
      larkIngressConfigFromEnv({
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL: "lark_principal_test"
      })
    ).toThrow("OPENTAG_DISPATCHER_URL is required");
  });

  it("rejects partial or blank managed principal configuration", () => {
    expect(() =>
      larkIngressConfigFromEnv({
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        OPENTAG_DISPATCHER_URL: "http://localhost:3030"
      })
    ).toThrow("LARK_APP_ID and OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together.");
    expect(() =>
      larkIngressConfigFromEnv({
        OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL: "lark_principal_test"
      })
    ).toThrow("LARK_APP_ID and OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together.");
    expect(() =>
      larkIngressConfigFromEnv({
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL: "   ",
        OPENTAG_DISPATCHER_URL: "http://localhost:3030"
      })
    ).toThrow("OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL must be a non-empty string");
  });

  it("normalizes environment values into an ingress config", () => {
    expect(
      larkIngressConfigFromEnv({
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        LARK_DOMAIN: "feishu",
        LARK_BOT_OPEN_ID: "ou_bot",
        OPENTAG_DISPATCHER_URL: "http://localhost:3030",
        OPENTAG_DISPATCHER_TOKEN: "pairing_test",
        OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL: "lark_principal_test",
        OPENTAG_RUN_TIMEOUT_MS: "30000",
        OPENTAG_LARK_DEFAULT_REPO: "local:path_abc/opentag",
        OPENTAG_LARK_BINDING_ADMIN_OPEN_IDS: "ou_admin, ou_backup",
        OPENTAG_LARK_BINDING_ADMIN_USER_IDS: "u_admin",
        OPENTAG_LARK_BINDING_ADMIN_UNION_IDS: "on_admin"
      })
    ).toEqual({
      appId: "cli_test",
      appSecret: "secret_test",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: "pairing_test",
      channelPrincipalCredential: "lark_principal_test",
      domain: "feishu",
      agentId: DEFAULT_AGENT_ID,
      botOpenId: "ou_bot",
      bindingAdminOpenIds: ["ou_admin", "ou_backup"],
      bindingAdminUserIds: ["u_admin"],
      bindingAdminUnionIds: ["on_admin"],
      runTimeoutMs: 30000,
      defaultRepoBinding: {
        repoProvider: "local",
        owner: "path_abc",
        repo: "opentag"
      }
    });
  });

  it("rejects invalid Lark domains instead of silently defaulting", () => {
    expect(() =>
      larkIngressConfigFromEnv({
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        LARK_DOMAIN: "feishu ",
        OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL: "lark_principal_test",
        OPENTAG_DISPATCHER_URL: "http://localhost:3030"
      })
    ).toThrow("LARK_DOMAIN must be either lark or feishu");
  });

  it("starts the long-connection client through injectable SDK boundaries", async () => {
    let capturedHandler: ((data: LarkInboundMessageEvent) => Promise<void>) | undefined;
    const eventDispatcher = { registered: true };
    const start = vi.fn(async () => {});
    const logIgnored = vi.fn();

    const handle = startLarkIngress(
      {
        appId: "cli_test",
        appSecret: "secret_test",
        dispatcherUrl: "http://localhost:3030",
        domain: "lark",
        agentId: DEFAULT_AGENT_ID
      },
      {
        createEventDispatcher(handler) {
          capturedHandler = handler;
          return eventDispatcher;
        },
        createWsClient(config) {
          expect(config.appId).toBe("cli_test");
          return { start };
        },
        reply: vi.fn(async () => {}),
        logIgnored
      }
    );

    await handle.startPromise;

    expect(start).toHaveBeenCalledWith({ eventDispatcher });
    await capturedHandler?.({
      message: { message_type: "sticker" }
    });
    expect(logIgnored).toHaveBeenCalledWith({ status: "ignored_non_text" });
  });

  it("routes /stop run_id through dispatcher cancellation", async () => {
    let capturedHandler: ((data: LarkInboundMessageEvent) => Promise<void>) | undefined;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const reply = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({
          outcome: "cancelled",
          run: {
            id: "run_1",
            eventId: "evt_1",
            status: "cancelled",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:01.000Z",
            result: { conclusion: "cancelled", summary: "Stop requested from Lark." }
          }
        });
      })
    );

    const handle = startLarkIngress(
      {
        appId: "cli_test",
        appSecret: "secret_test",
        dispatcherUrl: "http://dispatcher.test",
        dispatcherToken: "pairing_test",
        domain: "lark",
        agentId: DEFAULT_AGENT_ID,
        botOpenId: "ou_bot",
        runTimeoutMs: 30_000
      },
      {
        createEventDispatcher(handler) {
          capturedHandler = handler;
          return {};
        },
        createWsClient() {
          return { start: vi.fn(async () => {}) };
        },
        reply
      }
    );
    await handle.startPromise;

    await capturedHandler?.({
      event_id: "evt_lark_stop",
      tenant_key: "tenant_1",
      sender: { sender_id: { open_id: "ou_sender" }, tenant_key: "tenant_1" },
      message: {
        message_id: "om_stop",
        chat_id: "oc_chat",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 /stop run_1" }),
        mentions: [{ id: { open_id: "ou_bot" } }]
      }
    });

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/runs/run_1/cancel");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer pairing_test" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      reason: "Stop requested from Lark.",
      requestedBy: "lark:ou_sender"
    });
    expect(reply.mock.calls[0]?.[0].text).toContain("Cancellation requested for run run_1");
  });

  it("replies to /status with active run and queued follow-up details from the dispatcher", async () => {
    let capturedHandler: ((data: LarkInboundMessageEvent) => Promise<void>) | undefined;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const reply = vi.fn(async () => {});
    const event = {
      id: "evt_lark_status",
      source: "lark",
      sourceEventId: "msg_lark_status",
      receivedAt: "2026-06-24T00:00:00.000Z",
      actor: { provider: "lark", providerUserId: "ou_sender", handle: "ou_sender", organizationId: "tenant_1" },
      target: { mention: "@ou_bot", agentId: "opentag" },
      command: { rawText: "fix this", intent: "fix", args: {} },
      context: [],
      permissions: [{ scope: "chat:postMessage", reason: "reply in source chat" }],
      callback: { provider: "lark", uri: "lark://im/v1/messages", threadKey: "tenant_1|oc_chat|om_thread" },
      metadata: { tenantKey: "tenant_1", chatId: "oc_chat", repoProvider: "github", owner: "acme", repo: "demo" }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const href = String(url);
        requests.push({ url: href, init });
        if (href.endsWith("/v1/channel-bindings/lark/tenant_1/oc_chat/status")) {
          return Response.json({
            binding: {
              provider: "lark",
              accountId: "tenant_1",
              conversationId: "oc_chat",
              repoProvider: "github",
              owner: "acme",
              repo: "demo"
            },
            activeRun: {
              id: "run_active",
              eventId: "evt_lark_status",
              status: "running",
              createdAt: "2026-06-24T00:00:00.000Z",
              updatedAt: "2026-06-24T00:01:00.000Z"
            },
            activeEvent: event,
            runTimeoutPolicy: { hardTimeoutMs: 45_000 },
            queuedFollowUps: [
              {
                id: "follow_up_1",
                sourceEventId: "evt_lark_follow_up",
                conversationKey: "lark:tenant_1|oc_chat|om_thread",
                activeRunId: "run_active",
                event,
                decision: {
                  action: "queue_follow_up",
                  reason: "A run is already active for this thread.",
                  reasonCode: "active_run_same_thread",
                  decidedAt: "2026-06-24T00:01:10.000Z",
                  activeRunId: "run_active",
                  eventId: "evt_lark_follow_up"
                },
                status: "queued",
                createdAt: "2026-06-24T00:01:10.000Z",
                updatedAt: "2026-06-24T00:01:10.000Z"
              }
            ]
          });
        }
        return Response.json({
          binding: {
            provider: "lark",
            accountId: "tenant_1",
            conversationId: "oc_chat",
            repoProvider: "github",
            owner: "acme",
            repo: "demo"
          }
        });
      })
    );

    const handle = startLarkIngress(
      {
        appId: "cli_test",
        appSecret: "secret_test",
        dispatcherUrl: "http://dispatcher.test",
        dispatcherToken: "pairing_test",
        domain: "lark",
        agentId: DEFAULT_AGENT_ID,
        botOpenId: "ou_bot",
        runTimeoutMs: 30_000
      },
      {
        createEventDispatcher(handler) {
          capturedHandler = handler;
          return {};
        },
        createWsClient() {
          return { start: vi.fn(async () => {}) };
        },
        reply
      }
    );
    await handle.startPromise;

    await capturedHandler?.({
      event_id: "evt_lark_status_command",
      tenant_key: "tenant_1",
      sender: { sender_id: { open_id: "ou_sender" }, tenant_key: "tenant_1" },
      message: {
        message_id: "om_status",
        chat_id: "oc_chat",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 /status" }),
        mentions: [{ id: { open_id: "ou_bot" } }]
      }
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat",
      "http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat/status"
    ]);
    expect(requests[1]?.init?.headers).toMatchObject({ authorization: "Bearer pairing_test" });
    expect(reply.mock.calls[0]?.[0].text).toContain("Project Target: github:acme/demo");
    expect(reply.mock.calls[0]?.[0].text).toContain("Active run: run_active (running)");
    expect(reply.mock.calls[0]?.[0].text).toContain("Command: fix this");
    expect(reply.mock.calls[0]?.[0].text).toContain("Queued follow-ups: 1 (follow_up_1 (queued): fix this)");
    expect(reply.mock.calls[0]?.[0].text).toContain("timeout policy: hard timeout after 45 second(s).");
    expect(reply.mock.calls[0]?.[0].card).toMatchObject({
      header: {
        template: "blue",
        title: { content: "OpenTag status" }
      }
    });
  });

  it("replies to /doctor with redacted source-container runtime checks from the dispatcher", async () => {
    let capturedHandler: ((data: LarkInboundMessageEvent) => Promise<void>) | undefined;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const reply = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const href = String(url);
        requests.push({ url: href, init });
        if (href.endsWith("/v1/channel-bindings/lark/tenant_1/oc_chat/status")) {
          return Response.json({
            binding: {
              provider: "lark",
              accountId: "tenant_1",
              conversationId: "oc_chat",
              repoProvider: "github",
              owner: "acme",
              repo: "demo"
            },
            activeRun: {
              id: "run_doctor",
              eventId: "evt_lark_doctor",
              status: "running",
              createdAt: "2026-06-24T00:00:00.000Z",
              updatedAt: "2026-06-24T00:03:00.000Z"
            },
            runTimeoutPolicy: { hardTimeoutMs: 45_000 },
            queuedFollowUps: []
          });
        }
        return Response.json({
          binding: {
            provider: "lark",
            accountId: "tenant_1",
            conversationId: "oc_chat",
            repoProvider: "github",
            owner: "acme",
            repo: "demo"
          }
        });
      })
    );

    const handle = startLarkIngress(
      {
        appId: "cli_test",
        appSecret: "secret_test",
        dispatcherUrl: "http://dispatcher.test",
        dispatcherToken: "pairing_test",
        domain: "lark",
        agentId: DEFAULT_AGENT_ID,
        botOpenId: "ou_bot",
        runTimeoutMs: 30_000
      },
      {
        createEventDispatcher(handler) {
          capturedHandler = handler;
          return {};
        },
        createWsClient() {
          return { start: vi.fn(async () => {}) };
        },
        reply
      }
    );
    await handle.startPromise;

    await capturedHandler?.({
      event_id: "evt_lark_doctor_command",
      tenant_key: "tenant_1",
      sender: { sender_id: { open_id: "ou_sender" }, tenant_key: "tenant_1" },
      message: {
        message_id: "om_doctor",
        chat_id: "oc_chat",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 /doctor" }),
        mentions: [{ id: { open_id: "ou_bot" } }]
      }
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat",
      "http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat/status"
    ]);
    expect(requests[1]?.init?.headers).toMatchObject({ authorization: "Bearer pairing_test" });
    expect(reply.mock.calls[0]?.[0].text).toContain("OpenTag doctor (redacted):");
    expect(reply.mock.calls[0]?.[0].text).toContain("Source container: lark:tenant_1/oc_chat");
    expect(reply.mock.calls[0]?.[0].text).toContain("Project Target: github:acme/demo");
    expect(reply.mock.calls[0]?.[0].text).toContain("Dispatcher: reachable for this source container.");
    expect(reply.mock.calls[0]?.[0].text).toContain("Active run: run_doctor (running)");
    expect(reply.mock.calls[0]?.[0].text).toContain("Timeout policy: hard timeout after 45 second(s)");
    expect(reply.mock.calls[0]?.[0].text).toContain("Secrets: redacted");
    expect(reply.mock.calls[0]?.[0].card).toMatchObject({
      header: {
        template: "green",
        title: { content: "OpenTag doctor (redacted)" }
      }
    });
  });

  it("logs inbound handler failures without rejecting the event dispatcher callback", async () => {
    let capturedHandler: ((data: LarkInboundMessageEvent) => Promise<void>) | undefined;
    const start = vi.fn(async () => {});
    const error = new Error("log failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    startLarkIngress(
      {
        appId: "cli_test",
        appSecret: "secret_test",
        dispatcherUrl: "http://localhost:3030",
        domain: "lark",
        agentId: DEFAULT_AGENT_ID
      },
      {
        createEventDispatcher(handler) {
          capturedHandler = handler;
          return {};
        },
        createWsClient() {
          return { start };
        },
        reply: vi.fn(async () => {}),
        logIgnored() {
          throw error;
        }
      }
    );

    try {
      expect(capturedHandler).toBeDefined();
      await expect(capturedHandler!({ message: { message_type: "image" } })).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith("[lark] failed to handle inbound message:", error);
    } finally {
      consoleError.mockRestore();
    }
  });
});
