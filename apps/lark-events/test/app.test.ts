import type { CreateRunResult } from "@opentag/client";
import type { OpenTagEvent } from "@opentag/core";
import type { LarkChannelBinding } from "@opentag/lark";
import { describe, expect, it, vi } from "vitest";
import { createLarkMessageHandler, type LarkInboundMessageEvent } from "../src/app.js";

// Mirrors the flattened im.message.receive_v1 payload the SDK delivers.
function messageEvent(overrides?: {
  text?: string;
  messageType?: string;
  chatType?: string;
  chatId?: string;
  tenantKey?: string;
  messageId?: string;
  eventId?: string;
  openId?: string;
  mentionBot?: boolean;
  content?: Record<string, unknown>;
}): LarkInboundMessageEvent {
  const mentionBot = overrides?.mentionBot ?? true;
  return {
    event_id: overrides?.eventId ?? "evt_1",
    event_type: "im.message.receive_v1",
    create_time: "1700000000000",
    tenant_key: overrides?.tenantKey ?? "tk_123",
    sender: {
      sender_id: { open_id: overrides?.openId ?? "ou_user" },
      sender_type: "user",
      tenant_key: overrides?.tenantKey ?? "tk_123"
    },
    message: {
      message_id: overrides?.messageId ?? "om_msg",
      chat_id: overrides?.chatId ?? "oc_chat",
      chat_type: overrides?.chatType ?? "group",
      message_type: overrides?.messageType ?? "text",
      content: JSON.stringify(overrides?.content ?? { text: overrides?.text ?? "@_user_1 fix the bug" }),
      mentions: mentionBot ? [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "OpenTag" }] : []
    }
  };
}

const binding: LarkChannelBinding = { tenantKey: "tk_123", chatId: "oc_chat", owner: "acme", repo: "app" };

function runCreated(event: OpenTagEvent, runId = "run_1"): CreateRunResult {
  return {
    outcome: "run_created",
    decision: {
      action: "start",
      reason: "new event",
      reasonCode: "new_event",
      decidedAt: "2026-06-24T00:00:00.000Z"
    },
    run: {
      id: runId,
      eventId: event.id,
      status: "queued",
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z"
    }
  };
}

function makeHandler(opts?: {
  withBotOpenId?: boolean;
  binding?: LarkChannelBinding | null;
  defaultRepoBinding?: { repoProvider: string; owner: string; repo: string };
  createRun?: ReturnType<typeof vi.fn>;
  bindChannel?: ReturnType<typeof vi.fn>;
  canManageBinding?: Parameters<typeof createLarkMessageHandler>[0]["canManageBinding"] | null;
  reply?: ReturnType<typeof vi.fn>;
}) {
  const createRun = opts?.createRun ?? vi.fn(async (event: OpenTagEvent) => runCreated(event));
  const bindChannel = opts?.bindChannel ?? vi.fn(async () => {});
  const canManageBinding =
    opts?.canManageBinding === null ? undefined : vi.fn(opts?.canManageBinding ?? (async () => true));
  const reply = opts?.reply ?? vi.fn(async () => {});
  const handler = createLarkMessageHandler({
    agentId: "opentag",
    ...(opts?.withBotOpenId === false ? {} : { botOpenId: "ou_bot" }),
    ...(opts?.defaultRepoBinding ? { defaultRepoBinding: opts.defaultRepoBinding } : {}),
    resolveChannelBinding: async () => (opts && "binding" in opts ? (opts.binding ?? null) : binding),
    createRun,
    bindChannel,
    ...(canManageBinding ? { canManageBinding } : {}),
    reply
  });
  return { handler, createRun, bindChannel, canManageBinding, reply };
}

describe("createLarkMessageHandler", () => {
  it("normalizes a group message that @-mentions the bot and creates a run", async () => {
    const { handler, createRun } = makeHandler();
    const outcome = await handler(messageEvent());
    expect(outcome.status).toBe("created");
    expect(outcome.runId).toBe("run_1");
    const event = createRun.mock.calls[0]?.[0];
    expect(event?.source).toBe("lark");
    expect(event?.command.rawText).toBe("fix the bug");
    expect(event?.callback.threadKey).toBe("tk_123|oc_chat|om_msg");
  });

  it("handles a direct (p2p) message without requiring a mention", async () => {
    const { handler } = makeHandler({ withBotOpenId: false });
    const outcome = await handler(messageEvent({ chatType: "p2p", text: "fix the bug", mentionBot: false }));
    expect(outcome.status).toBe("created");
  });

  it("ignores group messages that do not @-mention the bot", async () => {
    const { handler, createRun } = makeHandler();
    const outcome = await handler(messageEvent({ text: "fix the bug", mentionBot: false }));
    expect(outcome.status).toBe("ignored_not_addressed");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("ignores group messages when botOpenId is not configured", async () => {
    const { handler } = makeHandler({ withBotOpenId: false });
    expect((await handler(messageEvent())).status).toBe("ignored_group_requires_bot_open_id");
  });

  it("normalizes supported image messages as attachment context", async () => {
    const { handler, createRun } = makeHandler();
    const outcome = await handler(messageEvent({
      messageType: "image",
      content: { image_key: "img_1" }
    }));

    expect(outcome.status).toBe("created");
    expect(createRun.mock.calls[0]?.[0].context).toContainEqual(expect.objectContaining({
      kind: "attachment",
      uri: "lark://message/om_msg/resource/img_1?type=image"
    }));
  });

  it("ignores unsupported message types", async () => {
    const { handler } = makeHandler();
    expect((await handler(messageEvent({ messageType: "sticker" }))).status).toBe("ignored_non_text");
  });

  it("binds the chat via /bind owner/repo and confirms in-thread", async () => {
    const { handler, bindChannel, canManageBinding, reply, createRun } = makeHandler();
    const outcome = await handler(messageEvent({ text: "@_user_1 /bind amplifthq/opentag" }));
    expect(outcome.status).toBe("bound");
    expect(canManageBinding).toHaveBeenCalledWith({
      action: "bind",
      tenantKey: "tk_123",
      chatId: "oc_chat",
      chatType: "group",
      senderOpenId: "ou_user",
      messageId: "om_msg",
      eventId: "evt_1"
    });
    expect(bindChannel).toHaveBeenCalledWith({
      tenantKey: "tk_123",
      chatId: "oc_chat",
      repoProvider: "github",
      owner: "amplifthq",
      repo: "opentag"
    });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("denies group /bind by default before changing the Project Target", async () => {
    const { handler, bindChannel, reply, createRun } = makeHandler({ canManageBinding: null });

    const outcome = await handler(messageEvent({ text: "@_user_1 /bind amplifthq/opentag" }));

    expect(outcome.status).toBe("ignored_bind_unauthorized");
    expect(bindChannel).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Only an authorized Lark binding manager");
  });

  it("accepts an explicit provider prefix in /bind", async () => {
    const { handler, bindChannel } = makeHandler();
    await handler(messageEvent({ text: "@_user_1 /bind github:acme/web-app" }));
    expect(bindChannel).toHaveBeenCalledWith(
      expect.objectContaining({ repoProvider: "github", owner: "acme", repo: "web-app" })
    );
  });

  it("replies with usage on a malformed /bind and does not bind", async () => {
    const { handler, bindChannel, reply } = makeHandler();
    const outcome = await handler(messageEvent({ text: "@_user_1 /bind not-a-repo" }));
    expect(outcome.status).toBe("ignored_bind_usage");
    expect(bindChannel).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("does not turn /bind into a run when self-service binding is unavailable", async () => {
    const createRun = vi.fn(async (event: OpenTagEvent) => runCreated(event));
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      botOpenId: "ou_bot",
      resolveChannelBinding: async () => binding,
      createRun
    });

    const outcome = await handler(messageEvent({ text: "@_user_1 /bind amplifthq/opentag" }));

    expect(outcome.status).toBe("ignored_bind_unavailable");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("replies with an onboarding hint when the chat is unbound", async () => {
    const { handler, reply, createRun } = makeHandler({ binding: null });
    const outcome = await handler(messageEvent());
    expect(outcome.status).toBe("ignored_unbound_chat");
    expect(outcome.tenantKey).toBe("tk_123");
    expect(outcome.chatId).toBe("oc_chat");
    expect(reply).toHaveBeenCalledTimes(1);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("auto-binds an unbound chat to the configured default repo and creates a run", async () => {
    const { handler, bindChannel, reply, createRun } = makeHandler({
      binding: null,
      defaultRepoBinding: { repoProvider: "github", owner: "amplifthq", repo: "opentag" }
    });
    const outcome = await handler(messageEvent({ text: "@_user_1 investigate this setup" }));
    expect(outcome.status).toBe("created");
    expect(bindChannel).toHaveBeenCalledWith({
      tenantKey: "tk_123",
      chatId: "oc_chat",
      repoProvider: "github",
      owner: "amplifthq",
      repo: "opentag"
    });
    expect(reply).toHaveBeenCalledWith({
      messageId: "om_msg",
      text: expect.stringContaining("Received. Run: run_1.")
    });
    const event = createRun.mock.calls[0]?.[0];
    expect(event?.metadata).toMatchObject({ repoProvider: "github", owner: "amplifthq", repo: "opentag" });
  });

  it("migrates an existing legacy local binding to the default local Project Target before creating a run", async () => {
    const { handler, bindChannel, createRun } = makeHandler({
      binding: {
        tenantKey: "tk_123",
        chatId: "oc_chat",
        repoProvider: "local",
        owner: "local",
        repo: "opentag"
      },
      defaultRepoBinding: { repoProvider: "local", owner: "path_abc123", repo: "opentag" }
    });

    const outcome = await handler(messageEvent({ text: "@_user_1 investigate this setup" }));

    expect(outcome.status).toBe("created");
    expect(bindChannel).toHaveBeenCalledWith({
      tenantKey: "tk_123",
      chatId: "oc_chat",
      repoProvider: "local",
      owner: "path_abc123",
      repo: "opentag"
    });
    const event = createRun.mock.calls[0]?.[0];
    expect(event?.metadata).toMatchObject({ repoProvider: "local", owner: "path_abc123", repo: "opentag" });
  });

  it("does not auto-bind an empty @mention", async () => {
    const { handler, bindChannel, reply, createRun } = makeHandler({
      binding: null,
      defaultRepoBinding: { repoProvider: "github", owner: "amplifthq", repo: "opentag" }
    });
    const outcome = await handler(messageEvent({ text: "@_user_1   " }));
    expect(outcome.status).toBe("ignored_empty_command");
    expect(bindChannel).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("falls back to now() when create_time is malformed", async () => {
    const createRun = vi.fn(async (event: OpenTagEvent) => runCreated(event));
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      botOpenId: "ou_bot",
      resolveChannelBinding: async () => binding,
      createRun,
      now: () => 1_700_000_000_000
    });
    const evt = messageEvent();
    evt.create_time = "not-a-number";
    const outcome = await handler(evt);
    expect(outcome.status).toBe("created");
    const event = createRun.mock.calls[0]?.[0];
    expect(() => new Date(event!.receivedAt).toISOString()).not.toThrow();
    expect(event?.receivedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("ignores payloads missing required ids", async () => {
    const { handler } = makeHandler();
    const broken = messageEvent();
    broken.message!.chat_id = undefined;
    expect((await handler(broken)).status).toBe("ignored_invalid_payload");
  });

  it("propagates createRun failure instead of silently succeeding", async () => {
    const createRun = vi.fn(async () => {
      throw new Error("dispatcher unreachable");
    });
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      botOpenId: "ou_bot",
      resolveChannelBinding: async () => binding,
      createRun
    });
    await expect(handler(messageEvent())).rejects.toThrow(/dispatcher unreachable/);
  });
});
