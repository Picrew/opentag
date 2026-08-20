import { describe, expect, it } from "vitest";
import {
  encodeLarkThreadKey,
  larkConversationKey,
  type LarkMessageInput,
  normalizeLarkChannelMessage,
  normalizeLarkMessage,
  parseLarkThreadKey,
  stripLarkMention
} from "../src/index.js";

const baseInput: LarkMessageInput = {
  tenantKey: "tk_123",
  chatId: "oc_chat",
  chatType: "group",
  senderOpenId: "ou_user",
  text: "@_user_1 fix the login bug",
  messageId: "om_msg",
  eventId: "evt_1",
  eventTimeMs: 1_700_000_000_000,
  applicationId: "cli_app_123",
  botOpenId: "ou_bot",
  binding: { tenantKey: "tk_123", chatId: "oc_chat", owner: "acme", repo: "app" }
};

describe("stripLarkMention", () => {
  it("strips a mention placeholder and trims", () => {
    expect(stripLarkMention("@_user_1 hello")).toBe("hello");
  });

  it("removes @_user_10 intact (no leftover digit from an @_user_1 prefix strip)", () => {
    expect(stripLarkMention("@_user_10 deploy now")).toBe("deploy now");
  });

  it("strips multiple placeholders and collapses whitespace", () => {
    expect(stripLarkMention("@_user_1 hey @_user_2   there")).toBe("hey there");
  });

  it("returns empty string when only a mention is present", () => {
    expect(stripLarkMention("@_user_1")).toBe("");
  });
});

describe("lark thread key", () => {
  it("round-trips", () => {
    const key = encodeLarkThreadKey({ tenantKey: "tk", chatId: "oc", messageId: "om" });
    expect(key).toBe("tk|oc|om");
    expect(parseLarkThreadKey(key)).toEqual({ tenantKey: "tk", chatId: "oc", messageId: "om" });
  });

  it("throws on a malformed key", () => {
    expect(() => parseLarkThreadKey("bad")).toThrow(/Invalid Lark thread key/);
  });
});

describe("lark conversation key", () => {
  it("keeps direct messages in one private conversation", () => {
    expect(larkConversationKey({ ...baseInput, chatType: "p2p", messageId: "om_first" })).toBe("lark:tk_123|oc_chat");
    expect(larkConversationKey({ ...baseInput, chatType: "p2p", messageId: "om_second" })).toBe("lark:tk_123|oc_chat");
  });

  it("isolates group conversations by root thread", () => {
    expect(larkConversationKey({ ...baseInput, messageId: "om_reply", rootId: "om_root" })).toBe(
      "lark:tk_123|oc_chat|om_root"
    );
    expect(larkConversationKey({ ...baseInput, messageId: "om_other" })).toBe("lark:tk_123|oc_chat|om_other");
  });

  it("shares conversational main-channel memory without merging task threads", () => {
    expect(larkConversationKey({ ...baseInput, messageId: "om_question" }, "chat")).toBe("lark:tk_123|oc_chat");
    expect(larkConversationKey({ ...baseInput, messageId: "om_task" }, "task")).toBe("lark:tk_123|oc_chat|om_task");
    expect(larkConversationKey({ ...baseInput, messageId: "om_reply", rootId: "om_task" }, "chat")).toBe(
      "lark:tk_123|oc_chat|om_task"
    );
  });
});

describe("normalizeLarkMessage", () => {
  it("normalizes native Lark ingress through opentag.channel.v1", () => {
    expect(normalizeLarkChannelMessage(baseInput)).toMatchObject({
      protocol: "opentag.channel.v1",
      trigger: "mention",
      source: { channel: { provider: "lark", workspace: "tk_123", id: "oc_chat" }, actor: { id: "ou_user" } },
      text: "fix the login bug",
      replyTarget: { purpose: "all" }
    });
  });

  it("maps a Lark message into an OpenTagEvent", () => {
    const event = normalizeLarkMessage(baseInput);
    expect(event).not.toBeNull();
    expect(event?.source).toBe("lark");
    expect(event?.actor.provider).toBe("lark");
    expect(event?.actor.providerUserId).toBe("ou_user");
    expect(event?.actor.organizationId).toBe("tk_123");
    expect(event?.callback.provider).toBe("lark");
    expect(event?.callback.threadKey).toBe("tk_123|oc_chat|om_msg");
    expect(event?.command.rawText).toBe("fix the login bug");
    expect(event?.metadata.owner).toBe("acme");
    expect(event?.metadata.repo).toBe("app");
    expect(event?.metadata.repoProvider).toBe("github");
    expect(event?.metadata.chatId).toBe("oc_chat");
    expect(event?.metadata.tenantKey).toBe("tk_123");
    expect(event?.metadata.accountId).toBe("tk_123");
    expect(event?.metadata.conversationId).toBe("oc_chat");
    expect(event?.metadata.conversationKey).toBe("lark:tk_123|oc_chat|om_msg");
    expect(event?.metadata.conversationMemory).toEqual({
      enabled: true,
      maxRuns: 100,
      maxCharacters: 160_000,
      maxTurnCharacters: 20_000
    });
    expect(event?.metadata.sourceDeliveryId).toBe("evt_1");
    expect(event?.metadata.larkEventId).toBe("evt_1");
    expect(event?.metadata.larkRenderLocale).toBe("en-US");
    expect(event?.metadata).toMatchObject({
      larkInteractionMode: "task",
      larkInteractionReason: "explicit_fix_intent",
      larkReplyInThread: true
    });
    expect(event?.metadata).toMatchObject({ channelApplicationId: "cli_app_123", channelBotId: "ou_bot" });
    expect(event?.permissions.map((permission) => permission.scope)).toEqual(
      expect.arrayContaining(["chat:postMessage", "runner:local", "repo:read", "repo:write", "pr:create"])
    );
  });

  it("marks a natural question for a main-channel reply", () => {
    const event = normalizeLarkMessage({
      ...baseInput,
      text: "@_user_1 为什么这个项目会使用 Claude Code？"
    });

    expect(event?.metadata).toMatchObject({
      larkInteractionMode: "chat",
      larkInteractionReason: "conversational_default",
      larkReplyInThread: false,
      conversationKey: "lark:tk_123|oc_chat"
    });
  });

  it("carries an explicit disabled memory policy", () => {
    const event = normalizeLarkMessage({
      ...baseInput,
      conversationMemory: { enabled: false, maxRuns: 3, maxCharacters: 6_000, maxTurnCharacters: 2_000 }
    });

    expect(event?.metadata.conversationMemory).toEqual({
      enabled: false,
      maxRuns: 3,
      maxCharacters: 6_000,
      maxTurnCharacters: 2_000
    });
  });

  it("derives Feishu render locale from the domain", () => {
    const event = normalizeLarkMessage({ ...baseInput, domain: "feishu" });
    expect(event?.metadata.larkDomain).toBe("feishu");
    expect(event?.metadata.larkRenderLocale).toBe("zh-CN");
  });

  it("returns null when the command is empty after stripping", () => {
    expect(normalizeLarkMessage({ ...baseInput, text: "@_user_1" })).toBeNull();
  });

  it("honors binding.repoProvider when provided", () => {
    const event = normalizeLarkMessage({
      ...baseInput,
      binding: { ...baseInput.binding, repoProvider: "gitlab" }
    });
    expect(event?.metadata.repoProvider).toBe("gitlab");
  });

  it.each(["fix", "run"] as const)(
    "keeps repository-free %s commands at channel-and-runner least privilege",
    (intent) => {
      const event = normalizeLarkMessage({
        ...baseInput,
        text: `@_user_1 ${intent} the login bug`,
        binding: { tenantKey: "tk_123", chatId: "oc_chat" }
      });

      expect(event?.permissions.map((permission) => permission.scope)).toEqual(["chat:postMessage", "runner:local"]);
      expect(event?.metadata).not.toHaveProperty("repoProvider");
      expect(event?.metadata).not.toHaveProperty("owner");
      expect(event?.metadata).not.toHaveProperty("repo");
    }
  );

  it("treats a partial runtime repository binding as repository-free", () => {
    const event = normalizeLarkMessage({
      ...baseInput,
      binding: {
        tenantKey: "tk_123",
        chatId: "oc_chat",
        owner: "acme"
      } as LarkMessageInput["binding"]
    });

    expect(event?.permissions.map((permission) => permission.scope)).toEqual(["chat:postMessage", "runner:local"]);
    expect(event?.metadata).not.toHaveProperty("repoProvider");
    expect(event?.metadata).not.toHaveProperty("owner");
    expect(event?.metadata).not.toHaveProperty("repo");
  });
});
