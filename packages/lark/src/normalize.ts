import {
  commandFromRawText,
  OpenTagChannelInboundMessageSchema,
  DEFAULT_CONVERSATION_MEMORY_POLICY,
  type ContextPointer,
  type ConversationMemoryPolicy,
  type OpenTagChannelInboundMessage,
  type OpenTagCommand,
  type OpenTagEvent,
  type PermissionGrant
} from "@opentag/core";
import { larkRenderLocaleFromDomain, type LarkRenderLocale } from "./render.js";

export type LarkChannelBinding = {
  tenantKey: string;
  chatId: string;
} & ({ repoProvider?: string; owner: string; repo: string } | { repoProvider?: never; owner?: never; repo?: never });

export type LarkMessageInput = {
  tenantKey: string;
  chatId: string;
  chatType: string;
  senderOpenId: string;
  text: string;
  messageId: string;
  rootId?: string;
  eventId: string;
  eventTimeMs: number;
  agentId?: string;
  applicationId?: string;
  botOpenId?: string;
  domain?: "lark" | "feishu";
  renderLocale?: LarkRenderLocale;
  callbackUri?: string;
  conversationMemory?: ConversationMemoryPolicy;
  binding: LarkChannelBinding;
};

// Strip `@_user_N` mention placeholders (whole \d+ index) and collapse whitespace.
export function stripLarkMention(text: string): string {
  return text
    .replace(/@_user_\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function encodeLarkThreadKey(input: { tenantKey: string; chatId: string; messageId: string }): string {
  return `${input.tenantKey}|${input.chatId}|${input.messageId}`;
}

export function parseLarkThreadKey(threadKey: string): { tenantKey: string; chatId: string; messageId: string } {
  const [tenantKey, chatId, messageId] = threadKey.split("|");
  if (!tenantKey || !chatId || !messageId) {
    throw new Error(`Invalid Lark thread key: ${threadKey}`);
  }
  return { tenantKey, chatId, messageId };
}

export function larkConversationKey(input: Pick<LarkMessageInput, "tenantKey" | "chatId" | "chatType" | "messageId" | "rootId">): string {
  const conversationId = input.chatType === "p2p"
    ? input.chatId
    : `${input.chatId}|${input.rootId ?? input.messageId}`;
  return `lark:${input.tenantKey}|${conversationId}`;
}

export function normalizeLarkChannelMessage(input: LarkMessageInput): OpenTagChannelInboundMessage | null {
  const text = stripLarkMention(input.text);
  if (!text) return null;
  const rootMessageId = input.rootId ?? input.messageId;
  const channel = { provider: "lark", workspace: input.tenantKey, id: input.chatId };
  const thread = { provider: "lark", id: rootMessageId, parentMessageId: rootMessageId };
  return OpenTagChannelInboundMessageSchema.parse({
    protocol: "opentag.channel.v1",
    eventId: input.eventId,
    occurredAt: new Date(input.eventTimeMs).toISOString(),
    trigger: "mention",
    source: {
      kind: "channel_message",
      channel,
      thread,
      actor: { provider: "lark", id: input.senderOpenId }
    },
    text,
    attachments: [],
    replyTarget: { channel, thread, purpose: "all" }
  });
}

function repositoryMetadataFromBinding(
  binding: LarkChannelBinding
): { repoProvider: string; owner: string; repo: string } | undefined {
  if (!binding.owner?.trim() || !binding.repo?.trim()) return undefined;
  return {
    repoProvider: binding.repoProvider?.trim() || "github",
    owner: binding.owner,
    repo: binding.repo
  };
}

function permissionsForIntent(intent: OpenTagCommand["intent"], hasRepositoryTarget: boolean): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    {
      scope: "chat:postMessage",
      reason: "reply in the originating Lark thread"
    },
    {
      scope: "runner:local",
      reason: "execute the run on a paired local daemon"
    }
  ];

  if (hasRepositoryTarget && (intent === "fix" || intent === "run")) {
    permissions.push(
      {
        scope: "repo:read",
        reason: "inspect the repository in the paired local checkout"
      },
      {
        scope: "repo:write",
        reason: "commit code changes on an isolated run branch"
      },
      {
        scope: "pr:create",
        reason: "open a pull request for completed code changes"
      }
    );
  }

  return permissions;
}

function contextPointersForCommand(command: OpenTagCommand): ContextPointer[] {
  const context: ContextPointer[] = [];

  for (const reference of command.parsed?.references ?? []) {
    if (reference.kind === "url") {
      context.push({
        kind: "url",
        uri: reference.uri,
        visibility: "organization",
        title: reference.title ?? "Command URL reference"
      });
      continue;
    }

    if (reference.kind === "file" || reference.kind === "path") {
      context.push({
        kind: "file",
        uri: reference.uri,
        ...(reference.line ? { line: reference.line } : {}),
        ...(reference.startLine ? { startLine: reference.startLine } : {}),
        ...(reference.endLine ? { endLine: reference.endLine } : {}),
        visibility: "organization",
        title: referenceTitle(reference)
      });
    }
  }

  return context;
}

function referenceTitle(reference: NonNullable<OpenTagCommand["parsed"]>["references"][number]): string {
  return reference.title ?? "Command file reference";
}

function commandMetadata(command: OpenTagCommand): Record<string, unknown> {
  if (!command.parsed) return {};
  return {
    commandParser: command.parsed.version,
    commandDiagnostics: command.parsed.diagnostics,
    ...(command.parsed.approval ? { approval: command.parsed.approval } : {}),
    ...(command.parsed.network ? { network: command.parsed.network } : {})
  };
}

export function normalizeLarkMessage(input: LarkMessageInput): OpenTagEvent | null {
  const channelMessage = normalizeLarkChannelMessage(input);
  if (!channelMessage?.text) return null;
  const rawText = channelMessage.text;

  const command = commandFromRawText(rawText);
  const agentId = input.agentId ?? "opentag";
  const renderLocale = input.renderLocale ?? larkRenderLocaleFromDomain(input.domain);
  const repositoryMetadata = repositoryMetadataFromBinding(input.binding);

  return {
    id: `evt_lark_message_${input.eventId}`,
    source: "lark",
    sourceEventId: input.eventId,
    receivedAt: new Date(input.eventTimeMs).toISOString(),
    actor: {
      provider: "lark",
      providerUserId: input.senderOpenId,
      handle: input.senderOpenId,
      organizationId: input.tenantKey
    },
    target: {
      mention: input.botOpenId ? `@${input.botOpenId}` : "@app",
      agentId,
      ...(command.parsed?.executorHint ? { executorHint: command.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "lark",
        kind: "message",
        uri: `lark://tenant/${input.tenantKey}/chat/${input.chatId}/message/${input.messageId}`,
        visibility: "organization",
        title: "Lark message"
      },
      {
        kind: "text",
        uri: input.text,
        visibility: "organization",
        title: "Lark message text"
      },
      ...contextPointersForCommand(command)
    ],
    permissions: permissionsForIntent(command.intent, repositoryMetadata !== undefined),
    callback: {
      provider: "lark",
      uri: input.callbackUri ?? "lark://im/v1/messages",
      threadKey: encodeLarkThreadKey({
        tenantKey: input.tenantKey,
        chatId: input.chatId,
        messageId: input.messageId
      })
    },
    metadata: {
      tenantKey: input.tenantKey,
      chatId: input.chatId,
      accountId: input.tenantKey,
      conversationId: input.chatId,
      conversationKey: larkConversationKey(input),
      conversationMemory: input.conversationMemory ?? DEFAULT_CONVERSATION_MEMORY_POLICY,
      messageId: input.messageId,
      chatType: input.chatType,
      sourceDeliveryId: input.eventId,
      larkEventId: input.eventId,
      ...(input.domain ? { larkDomain: input.domain } : {}),
      larkRenderLocale: renderLocale,
      ...(input.rootId ? { rootId: input.rootId } : {}),
      ...(input.botOpenId ? { larkBotOpenId: input.botOpenId } : {}),
      ...(input.applicationId ? { channelApplicationId: input.applicationId } : {}),
      ...(input.botOpenId ? { channelBotId: input.botOpenId } : {}),
      ...commandMetadata(command),
      ...repositoryMetadata
    }
  };
}
