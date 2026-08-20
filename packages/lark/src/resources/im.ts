import type { FeishuOpenApiClient } from "./client.js";
import type { FeishuDownloadedResource, FeishuPage, FeishuResource } from "./types.js";

export type FeishuMessageResourceType = "file" | "image";

export type FeishuChatHistoryOptions = {
  startTime?: number;
  endTime?: number;
  pageSize?: number;
  pageToken?: string;
  sortType?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
};

type MessageSender = {
  id?: string;
  id_type?: string;
  sender_type?: string;
};

type MessageItem = {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  create_time?: string;
  update_time?: string;
  deleted?: boolean;
  updated?: boolean;
  chat_id?: string;
  sender?: MessageSender;
  body?: { content?: string };
};

type MessagePageResponse = {
  items?: MessageItem[];
  has_more?: boolean;
  page_token?: string;
};

function parseContent(content: string | undefined): unknown {
  if (!content) return {};
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return { text: content };
  }
}

function stringsFromPost(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) output.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsFromPost(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.title === "string" && record.title.trim()) output.push(record.title.trim());
  if (typeof record.text === "string" && record.text.trim()) output.push(record.text.trim());
  if (typeof record.href === "string" && record.href.trim() && record.tag === "a") output.push(record.href.trim());
  for (const [key, child] of Object.entries(record)) {
    if (key !== "title" && key !== "text" && key !== "href" && key !== "tag") stringsFromPost(child, output);
  }
}

function contentText(type: string | undefined, content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const record = content as Record<string, unknown>;
  if (type === "text" && typeof record.text === "string") return record.text;
  if (type === "post" || type === "interactive") {
    const parts: string[] = [];
    stringsFromPost(record, parts);
    return [...new Set(parts)].join("\n");
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberField(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function messageResource(item: MessageItem): FeishuResource | undefined {
  if (!item.message_id) return undefined;
  const content = parseContent(item.body?.content);
  const contentRecord = content && typeof content === "object" ? content as Record<string, unknown> : {};
  const text = contentText(item.msg_type, content);
  const fileKey = stringField(contentRecord.file_key) ?? stringField(contentRecord.image_key);
  const fileName = stringField(contentRecord.file_name);
  const resourceType: FeishuMessageResourceType | undefined = item.msg_type === "image"
    ? "image"
    : fileKey ? "file" : undefined;
  const createTime = numberField(item.create_time);
  const updateTime = numberField(item.update_time);

  return {
    id: item.message_id,
    type: "message",
    ...(fileName ? { title: fileName } : {}),
    ...(text !== undefined ? { text } : {}),
    metadata: {
      messageId: item.message_id,
      ...(item.chat_id ? { chatId: item.chat_id } : {}),
      ...(item.msg_type ? { messageType: item.msg_type } : {}),
      ...(item.sender?.id ? { creatorId: item.sender.id } : {}),
      ...(item.sender?.id_type ? { creatorIdType: item.sender.id_type } : {}),
      ...(item.sender?.sender_type ? { senderType: item.sender.sender_type } : {}),
      ...(item.root_id ? { rootId: item.root_id } : {}),
      ...(item.parent_id ? { parentId: item.parent_id } : {}),
      ...(item.thread_id ? { threadId: item.thread_id } : {}),
      ...(fileKey ? { fileKey } : {}),
      ...(resourceType ? { resourceType } : {}),
      ...(fileName ? { fileName } : {}),
      ...(createTime !== undefined ? { createTime } : {}),
      ...(updateTime !== undefined ? { modifiedTime: updateTime } : {}),
      ...(item.deleted !== undefined ? { deleted: item.deleted } : {}),
      ...(item.updated !== undefined ? { updated: item.updated } : {})
    }
  };
}

export function createFeishuImReader(client: FeishuOpenApiClient) {
  async function getChatHistory(chatId: string, options: FeishuChatHistoryOptions = {}): Promise<FeishuPage<FeishuResource>> {
    if (!chatId.trim()) throw new Error("Feishu chat id must not be empty.");
    const data = await client.requestJson<MessagePageResponse>("/open-apis/im/v1/messages", {
      query: {
        container_id_type: "chat",
        container_id: chatId,
        start_time: options.startTime,
        end_time: options.endTime,
        sort_type: options.sortType ?? "ByCreateTimeDesc",
        page_size: Math.min(Math.max(options.pageSize ?? 50, 1), 50),
        page_token: options.pageToken
      }
    });
    return {
      items: (data.items ?? []).map(messageResource).filter((item): item is FeishuResource => item !== undefined),
      hasMore: data.has_more === true,
      ...(data.page_token ? { pageToken: data.page_token } : {})
    };
  }

  async function getMessage(messageId: string): Promise<FeishuResource> {
    if (!messageId.trim()) throw new Error("Feishu message id must not be empty.");
    const data = await client.requestJson<MessagePageResponse>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`
    );
    const resource = data.items?.map(messageResource).find((item) => item !== undefined);
    if (!resource) throw new Error("Feishu message response did not include a readable message.");
    return resource;
  }

  async function downloadMessageResource(
    messageId: string,
    fileKey: string,
    resourceType: FeishuMessageResourceType = "file",
    options: { maxBytes?: number } = {}
  ): Promise<FeishuDownloadedResource> {
    if (!messageId.trim()) throw new Error("Feishu message id must not be empty.");
    if (!fileKey.trim()) throw new Error("Feishu message resource key must not be empty.");
    return client.requestBinary(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
      {
        query: { type: resourceType },
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {})
      }
    );
  }

  return { getChatHistory, getMessage, downloadMessageResource };
}

export type FeishuImReader = ReturnType<typeof createFeishuImReader>;
