import * as lark from "@larksuiteoapi/node-sdk";
import { createLarkInteractiveMessageContent, createLarkTextMessageContent, type LarkCard } from "./render.js";

type LarkReplyPayload = {
  path: { message_id: string };
  data: { content: string; msg_type: string; reply_in_thread?: boolean; uuid?: string };
};

type LarkPatchPayload = {
  path: { message_id: string };
  data: { content: string };
};

type LarkUpdatePayload = {
  path: { message_id: string };
  data: { content: string; msg_type: string };
};

type LarkMessageMethod = "reply" | "patch" | "update";

type LarkMessageApi = {
  reply?: (payload?: LarkReplyPayload) => Promise<unknown>;
  patch?: (payload?: LarkPatchPayload) => Promise<unknown>;
  update?: (payload?: LarkUpdatePayload) => Promise<unknown>;
};

type LarkRequestPayload = {
  method: string;
  url: string;
  data?: unknown;
};

export type LarkReplyResult = {
  messageId?: string;
};

// Minimal client surface OpenTag uses; lark.Client satisfies it structurally.
export type LarkReplyClient = {
  request?: (payload: LarkRequestPayload) => Promise<unknown>;
  im: {
    message?: LarkMessageApi;
    v1?: {
      message?: LarkMessageApi;
    };
  };
};

export function createLarkReplyClient(input: { appId: string; appSecret: string; domain?: "lark" | "feishu" }): LarkReplyClient {
  return new lark.Client({
    appId: input.appId,
    appSecret: input.appSecret,
    domain: input.domain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark
  });
}

function larkMessageApi(client: LarkReplyClient, method: LarkMessageMethod): LarkMessageApi {
  const legacyApi = client.im.message;
  if (legacyApi?.[method]) return legacyApi;
  const v1Api = client.im.v1?.message;
  if (v1Api?.[method]) return v1Api;
  throw new Error(`Lark client does not support message.${method}.`);
}

function larkReplyMessageId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const data = "data" in response ? (response as { data?: unknown }).data : undefined;
  if (data && typeof data === "object" && "message_id" in data) {
    const value = (data as { message_id?: unknown }).message_id;
    if (typeof value === "string" && value.length > 0) return value;
  }
  if ("message_id" in response) {
    const value = (response as { message_id?: unknown }).message_id;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export async function replyLarkMessage(
  client: LarkReplyClient,
  input: { messageId: string; text: string; card?: LarkCard; replyInThread?: boolean }
): Promise<LarkReplyResult> {
  const reply = larkMessageApi(client, "reply").reply;
  if (!reply) throw new Error("Lark client does not support message.reply.");
  const response = await reply({
    path: { message_id: input.messageId },
    data: input.card
      ? {
          content: createLarkInteractiveMessageContent(input.card),
          msg_type: "interactive",
          reply_in_thread: input.replyInThread ?? true
        }
      : {
          content: createLarkTextMessageContent(input.text),
          msg_type: "text",
          reply_in_thread: input.replyInThread ?? true
        }
  });
  const messageId = larkReplyMessageId(response);
  return messageId ? { messageId } : {};
}

export async function patchLarkMessageCard(client: LarkReplyClient, input: { messageId: string; card: LarkCard }): Promise<void> {
  const patch = larkMessageApi(client, "patch").patch;
  if (!patch) throw new Error("Lark client does not support message.patch.");
  await patch({
    path: { message_id: input.messageId },
    data: {
      content: createLarkInteractiveMessageContent(input.card)
    }
  });
}

export async function updateLarkTextMessage(client: LarkReplyClient, input: { messageId: string; text: string }): Promise<void> {
  const update = larkMessageApi(client, "update").update;
  if (!update) throw new Error("Lark client does not support message.update.");
  await update({
    path: { message_id: input.messageId },
    data: {
      msg_type: "text",
      content: createLarkTextMessageContent(input.text)
    }
  });
}

export async function addLarkMessageReaction(client: LarkReplyClient, input: { messageId: string; emojiType: string }): Promise<void> {
  if (!client.request) throw new Error("Lark client does not support request.");
  await client.request({
    method: "POST",
    url: `/open-apis/im/v1/messages/${encodeURIComponent(input.messageId)}/reactions`,
    data: {
      reaction_type: {
        emoji_type: input.emojiType
      }
    }
  });
}
