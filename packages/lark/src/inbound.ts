import {
  createDoctorSummaryPresentation,
  createSourceThreadStatusPresentation,
  parseThreadActionCommand,
  parseProjectTargetRef,
  renderOpenTagPresentationPlainText,
  type OpenTagDoctorSummaryPresentation,
  type ConversationMemoryPolicy,
  type OpenTagChannelAttachmentRef,
  type OpenTagEvent,
  type OpenTagSourceThreadStatusPresentation
} from "@opentag/core";
import type { CreateRunResult } from "@opentag/client";
import { encodeLarkThreadKey, type LarkChannelBinding, normalizeLarkMessage, stripLarkMention } from "./normalize.js";
import {
  createLarkDoctorSummaryCard,
  createLarkSourceThreadStatusCard,
  larkRenderLocaleFromDomain,
  parseLarkThreadActionButtonValue,
  type LarkRenderLocale,
  type LarkCard
} from "./render.js";

export type LarkMention = { key?: string; id?: { open_id?: string }; name?: string };

// Flattened `im.message.receive_v1` payload as delivered by the SDK EventDispatcher (header fields + message/sender on the top level). All optional (external input).
export type LarkInboundMessageEvent = {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  tenant_key?: string;
  app_id?: string;
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: LarkMention[];
  };
};

export type LarkCardActionEvent = {
  event_id?: string;
  event_type?: string;
  tenant_key?: string;
  open_id?: string;
  user_id?: string;
  open_message_id?: string;
  open_chat_id?: string;
  context?: {
    open_message_id?: string;
    open_chat_id?: string;
  };
  operator?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
    name?: string;
  };
  user?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
    name?: string;
  };
  action?: {
    value?: unknown;
    tag?: string;
    name?: string;
    option?: string;
    timezone?: string;
  };
};

export type LarkMessageHandlerConfig = {
  agentId: string;
  applicationId?: string;
  botOpenId?: string;
  domain?: "lark" | "feishu";
  renderLocale?: LarkRenderLocale;
  callbackUri?: string;
  conversationMemory?: ConversationMemoryPolicy;
  defaultRepoBinding?: { repoProvider: string; owner: string; repo: string };
  resolveChannelBinding(input: { tenantKey: string; chatId: string }): Promise<LarkChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<CreateRunResult>;
  submitThreadAction?(action: LarkThreadActionInput): Promise<unknown>;
  // Self-service binding from within Lark (`/bind owner/repo`); optional so tests can omit it.
  bindChannel?(input: { tenantKey: string; chatId: string; repoProvider: string; owner: string; repo: string }): Promise<void>;
  // Explicit self-service unbinding; callers should keep any admin checks at the hosting boundary.
  unbindChannel?(input: { tenantKey: string; chatId: string }): Promise<void>;
  canManageBinding?(input: LarkBindingManagementContext): Promise<boolean> | boolean;
  // Explicit cancellation from within Lark. No runId means cancel the active run for this chat's Project Target.
  stopRun?(input: { tenantKey: string; chatId: string; runId?: string; requestedBy: string }): Promise<LarkStopRunResult>;
  // Optional redacted status/doctor renderers for hosting apps that can inspect richer runtime state.
  status?(input: LarkSelfServiceContext): Promise<LarkSelfServiceReply | string>;
  doctor?(input: LarkSelfServiceContext): Promise<LarkSelfServiceReply | string>;
  // Reply into the originating thread (onboarding hints, bind confirmations); optional.
  reply?(input: { messageId: string; text: string; card?: LarkCard }): Promise<void>;
  // Unified delivery can acknowledge accepted runs through provider-native receipts.
  // When that lifecycle path is enabled, avoid also posting the ingress text acknowledgement.
  suppressRunCreatedReply?: boolean;
  now?(): number;
};

export type LarkCardActionHandlerConfig = {
  domain?: "lark" | "feishu";
  renderLocale?: LarkRenderLocale;
  callbackUri?: string;
  resolveChannelBinding(input: { tenantKey: string; chatId: string }): Promise<LarkChannelBinding | null>;
  submitThreadAction?(action: LarkThreadActionInput): Promise<unknown>;
};

export type LarkSelfServiceReply = {
  text: string;
  card?: LarkCard;
};

export type LarkThreadActionInput = {
  id: string;
  rawText: string;
  actor: {
    provider: "lark";
    providerUserId: string;
    handle: string;
    organizationId: string;
  };
  callback: {
    provider: "lark";
    uri: string;
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

export type LarkSelfServiceContext = {
  tenantKey: string;
  chatId: string;
  messageId: string;
  binding: LarkChannelBinding | null;
};

export type LarkBindingManagementContext = {
  action: "bind" | "unbind";
  tenantKey: string;
  chatId: string;
  chatType: string;
  senderOpenId: string;
  senderUserId?: string;
  senderUnionId?: string;
  messageId: string;
  eventId: string;
};

export type LarkStopRunResult =
  | { outcome: "cancelled"; runId: string }
  | { outcome: "not_found"; runId?: string }
  | { outcome: "already_terminal"; runId: string };

export type LarkMessageHandlerOutcome = {
  status:
    | "created"
    | "bound"
    | "unbound"
    | "self_service_help"
    | "self_service_status"
    | "self_service_doctor"
    | "self_service_stop"
    | "self_service_stop_unavailable"
    | "ignored_non_text"
    | "ignored_invalid_payload"
    | "ignored_group_requires_bot_open_id"
    | "ignored_not_addressed"
    | "ignored_bind_usage"
    | "ignored_bind_unavailable"
    | "ignored_bind_unauthorized"
    | "ignored_unbind_usage"
    | "ignored_unbind_unavailable"
    | "ignored_unbind_unauthorized"
    | "ignored_unbound_chat"
    | "ignored_empty_command"
    | "ignored_thread_action_unavailable"
    | "thread_action_submitted"
    | "follow_up_queued"
    | "needs_human_decision";
  runId?: string;
  followUpRequestId?: string;
  reason?: string;
  tenantKey?: string;
  chatId?: string;
};

export type LarkCardActionHandlerOutcome = {
  status:
    | "card_action_submitted"
    | "ignored_card_action_invalid_payload"
    | "ignored_card_action_unavailable"
    | "ignored_card_action_unbound_chat"
    | "ignored_card_action_not_opentag";
  tenantKey?: string;
  chatId?: string;
  messageId?: string;
};

const BIND_USAGE =
  "Usage: /bind <owner>/<repo> — e.g. /bind amplifthq/opentag (or /bind github:amplifthq/opentag).";
const UNBIND_USAGE =
  "Usage: /unbind confirm — disconnects this chat from its current Project Target. This does not remove local checkout allowlists or repository bindings.";
const UNBOUND_HINT =
  "This chat isn't connected to a Project Target yet. @-mention me with `/bind <owner>/<repo>` to connect it — e.g. /bind amplifthq/opentag.";
const HELP_TEXT = [
  "OpenTag commands:",
  "- /bind <owner>/<repo> or /bind <provider>:<owner>/<repo> connects this chat to a Project Target.",
  "- /unbind confirm disconnects this chat from its current Project Target; it never deletes local checkout config.",
  "- /status shows the current Project Target, active-run guidance, queued follow-ups, and the next safe action.",
  "- /doctor shows a redacted readiness summary for this source container.",
  "- /stop [run_id] requests cancellation for the active chat run or the specified run; this connector will not treat stop as a successful completion.",
  "Project Targets never use absolute local paths. Keep local checkout paths in runner config and allowlists.",
  "Group chats must @-mention the bot before commands or runs."
].join("\n");
const STOP_UNAVAILABLE_TEXT = [
  "Run cancellation from this Lark ingress is not configured.",
  "OpenTag will not treat a stop request as a successful completion. Use `opentag status --run <run_id>` for audit detail, or `opentag service stop` if you need to stop the local background service."
].join("\n");
const THREAD_ACTION_UNAVAILABLE_TEXT =
  "Source-thread actions are not configured for this Lark ingress yet. Use `opentag status --run <run_id>` for audit detail.";
const THREAD_ACTION_INVALID_THREAD_TEXT =
  "I couldn't match this action reply to a source-thread result. Reply in the final result thread, or use `opentag status --run <run_id>` for audit detail.";
const BINDING_AUTH_DENIED_TEXT =
  "Only an authorized Lark binding manager can change this chat's Project Target. Ask an admin to run the command or update local OpenTag channel bindings.";

type DefaultRepoBinding = NonNullable<LarkMessageHandlerConfig["defaultRepoBinding"]>;

function bindingFromDefault(input: { tenantKey: string; chatId: string; binding: DefaultRepoBinding }): LarkChannelBinding {
  return {
    tenantKey: input.tenantKey,
    chatId: input.chatId,
    repoProvider: input.binding.repoProvider,
    owner: input.binding.owner,
    repo: input.binding.repo
  };
}

function shouldMigrateLegacyLocalBinding(input: {
  existing: LarkChannelBinding;
  defaultBinding: DefaultRepoBinding;
}): boolean {
  return (
    input.defaultBinding.repoProvider === "local" &&
    input.defaultBinding.owner.startsWith("path_") &&
    input.existing.repoProvider === "local" &&
    input.existing.owner === "local" &&
    input.existing.repo === input.defaultBinding.repo
  );
}

type ParsedInboundContent = { text: string; attachments: OpenTagChannelAttachmentRef[] };

function collectPostText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPostText(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.title === "string" && record.title.trim()) output.push(record.title.trim());
  if (typeof record.text === "string" && record.text.trim()) output.push(record.text.trim());
  if (record.tag === "a" && typeof record.href === "string" && record.href.trim()) output.push(record.href.trim());
  for (const [key, child] of Object.entries(record)) {
    if (key !== "title" && key !== "text" && key !== "href" && key !== "tag") collectPostText(child, output);
  }
}

function attachmentKind(messageType: string): OpenTagChannelAttachmentRef["kind"] {
  if (messageType === "image") return "image";
  if (messageType === "audio") return "audio";
  if (messageType === "media") return "video";
  return "file";
}

function parseInboundContent(message: NonNullable<LarkInboundMessageEvent["message"]>): ParsedInboundContent {
  let content: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(message.content ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed as Record<string, unknown>;
  } catch {
    return { text: "", attachments: [] };
  }
  const messageType = message.message_type ?? "text";
  if (messageType === "text") {
    return { text: typeof content.text === "string" ? content.text : "", attachments: [] };
  }
  if (messageType === "post" || messageType === "interactive") {
    const parts: string[] = [];
    collectPostText(content, parts);
    return { text: [...new Set(parts)].join("\n"), attachments: [] };
  }
  const resourceKey = typeof content.file_key === "string"
    ? content.file_key
    : typeof content.image_key === "string" ? content.image_key : undefined;
  if (!resourceKey || !message.message_id) return { text: "", attachments: [] };
  const kind = attachmentKind(messageType);
  const name = typeof content.file_name === "string" && content.file_name.trim() ? content.file_name.trim() : undefined;
  const resourceType = kind === "image" ? "image" : "file";
  const attachment: OpenTagChannelAttachmentRef = {
    id: resourceKey,
    kind,
    ...(name ? { name } : {}),
    uri: `lark://message/${encodeURIComponent(message.message_id)}/resource/${encodeURIComponent(resourceKey)}?type=${resourceType}`
  };
  const label = name ?? kind;
  return { text: `Read the attached ${kind}: ${label}`, attachments: [attachment] };
}

function mentionsBot(mentions: LarkMention[] | undefined, botOpenId: string): boolean {
  return (mentions ?? []).some((mention) => mention.id?.open_id === botOpenId);
}

function formatProjectTarget(binding: LarkChannelBinding): string {
  return `${binding.repoProvider}:${binding.owner}/${binding.repo}`;
}

function larkCallbackMessageId(message: NonNullable<LarkInboundMessageEvent["message"]>): string | undefined {
  return message.root_id ?? message.parent_id ?? message.message_id;
}

function compactIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 96);
}

function larkCardActionId(input: { eventId?: string; messageId: string; actorId: string; command: string }): string {
  if (input.eventId) return `approval_lark_card_${input.eventId}`;
  return `approval_lark_card_${compactIdPart(input.messageId)}_${compactIdPart(input.actorId)}_${compactIdPart(input.command)}`;
}

function normalizeLocalizedThreadActionCommand(text: string): string {
  const match = text.trim().match(/^(执行|应用|确认|批准|继续|拒绝)\s+([1-9]\d*)$/u);
  if (!match) return text;
  const [, verb, index] = match;
  const decision = verb === "执行" || verb === "应用" ? "apply" : verb === "确认" || verb === "批准" ? "approve" : verb === "继续" ? "continue" : "reject";
  return `${decision} ${index}`;
}

function parseLarkThreadActionCommand(text: string) {
  const normalized = normalizeLocalizedThreadActionCommand(text);
  return parseThreadActionCommand(normalized) ?? parseThreadActionCommand(text);
}

function normalizeSelfServiceReply(reply: LarkSelfServiceReply | string): LarkSelfServiceReply {
  return typeof reply === "string" ? { text: reply } : reply;
}

function parseSelfServiceCommand(command: string): "help" | "status" | "doctor" | null {
  const trimmed = command.trim();
  if (/^\/help(\s|$)/.test(trimmed)) return "help";
  if (/^\/status(\s|$)/.test(trimmed)) return "status";
  if (/^\/doctor(\s|$)/.test(trimmed)) return "doctor";
  return null;
}

function statusPresentation(input: {
  tenantKey: string;
  chatId: string;
  binding: LarkChannelBinding | null;
}): OpenTagSourceThreadStatusPresentation {
  if (!input.binding) {
    return createSourceThreadStatusPresentation({
      title: "OpenTag status:",
      sourceContainer: `lark:${input.tenantKey}/${input.chatId}`,
      bindingState: "unbound",
      nextAction: UNBOUND_HINT,
      detailHint: "active run and queued follow-up status are unavailable until this chat is bound."
    });
  }
  return createSourceThreadStatusPresentation({
    title: "OpenTag status:",
    sourceContainer: `lark:${input.tenantKey}/${input.chatId}`,
    projectTarget: formatProjectTarget(input.binding),
    bindingState: "bound",
    nextAction: "send a follow-up in this thread, or check `opentag status --run <run_id>` locally for audit detail.",
    stopHint: "cancellation is explicit and is not reported as successful completion; timeout policy is surfaced in status/audit.",
    detailHint: "at most one run is active per Project Target + source thread; new same-thread requests queue behind it."
  });
}

function statusReply(input: { tenantKey: string; chatId: string; binding: LarkChannelBinding | null }): LarkSelfServiceReply {
  const presentation = statusPresentation(input);
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    card: createLarkSourceThreadStatusCard(presentation)
  };
}

function doctorPresentation(input: {
  tenantKey: string;
  chatId: string;
  binding: LarkChannelBinding | null;
}): OpenTagDoctorSummaryPresentation {
  return createDoctorSummaryPresentation({
    title: "OpenTag doctor (redacted):",
    checks: [
      { status: "ok", name: "Source container", message: `lark:${input.tenantKey}/${input.chatId}` },
      {
        status: input.binding ? "ok" : "warn",
        name: "Project Target",
        message: input.binding ? formatProjectTarget(input.binding) : "not bound"
      },
      { status: "ok", name: "Secrets", message: "redacted. Use env/file/keychain SecretRef entries in local config instead of sharing secrets in chat." },
      {
        status: "warn",
        name: "Runtime readiness",
        message: "check `opentag service status` locally; launchd running is not the same as connector ready."
      },
      { status: "ok", name: "Source-thread output", message: "concise final replies by default; detailed process stays in audit/status." }
    ]
  });
}

function doctorReply(input: { tenantKey: string; chatId: string; binding: LarkChannelBinding | null }): LarkSelfServiceReply {
  const presentation = doctorPresentation(input);
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    card: createLarkDoctorSummaryCard(presentation)
  };
}

function formatFollowUpQueuedText(input: { activeRunId?: string; followUpRequestId: string; reason?: string }): string {
  return [
    "Queued as a follow-up.",
    input.activeRunId ? `- Active run: ${input.activeRunId}` : "- Active run: currently in this source thread.",
    `- Follow-up request: ${input.followUpRequestId}`,
    input.reason ? `- Reason: ${input.reason}` : "- Reason: another run is already active for this thread.",
    "- Next action: wait for the active run final reply, or inspect locally with `opentag status --run <run_id>`.",
    "- Stop/timeout: cancellation is explicit and will not be treated as successful completion; timeout details are recorded in audit/status."
  ].join("\n");
}

function formatRunReceivedText(runId: string): string {
  return [
    `Received. Run: ${runId}.`,
    "- Use `/status` in this chat for active-run and queue state.",
    `- Use \`opentag status --run ${runId}\` locally for audit detail.`
  ].join("\n");
}

function parseStopCommand(command: string): { runId?: string } | null {
  const match = command.trim().match(/^\/stop(?:\s+(\S+))?\s*$/);
  if (!match) return null;
  return match[1] ? { runId: match[1] } : {};
}

function formatStopResultText(result: LarkStopRunResult): string {
  if (result.outcome === "cancelled") {
    return [
      `Cancellation requested for run ${result.runId}.`,
      "- OpenTag will not treat this stop request as a successful completion.",
      "- The local executor may need a moment to observe the cancellation; further nonessential completion writes are suppressed."
    ].join("\n");
  }
  if (result.outcome === "already_terminal") {
    return `Run ${result.runId} is already finished. OpenTag will not change its final result.`;
  }
  return result.runId
    ? `Run ${result.runId} was not found or is no longer cancelable.`
    : "No active run was found for this chat and Project Target.";
}

// Parse `/bind owner/repo` (or `/bind provider:owner/repo`). null = not a bind command; {ok:false} = malformed.
function parseBindCommand(
  command: string
): { ok: true; repoProvider: string; owner: string; repo: string } | { ok: false } | null {
  if (!/^\/bind(\s|$)/.test(command)) return null;
  const match = command.match(/^\/bind\s+(\S+)\s*$/);
  if (!match) return { ok: false };
  try {
    const ref = parseProjectTargetRef(match[1] as string);
    return { ok: true, repoProvider: ref.provider, owner: ref.owner, repo: ref.repo };
  } catch {
    return { ok: false };
  }
}

function parseUnbindCommand(command: string): { ok: true } | { ok: false } | null {
  if (!/^\/unbind(\s|$)/.test(command)) return null;
  return /^\/unbind\s+confirm\s*$/.test(command) ? { ok: true } : { ok: false };
}

async function canManageLarkBinding(
  config: LarkMessageHandlerConfig,
  context: LarkBindingManagementContext
): Promise<boolean> {
  if (config.canManageBinding) return config.canManageBinding(context);
  return context.chatType === "p2p";
}

// Handle one inbound Lark message: group messages must @-mention the bot unless they are exact threaded action replies.
export function createLarkMessageHandler(config: LarkMessageHandlerConfig) {
  return async function handleLarkMessage(data: LarkInboundMessageEvent): Promise<LarkMessageHandlerOutcome> {
    const renderLocale = config.renderLocale ?? larkRenderLocaleFromDomain(config.domain);
    const message = data.message;
    const supportedMessageTypes = new Set(["text", "post", "interactive", "file", "image", "audio", "media"]);
    if (!message || !message.message_type || !supportedMessageTypes.has(message.message_type)) {
      return { status: "ignored_non_text" };
    }

    const tenantKey = data.tenant_key ?? data.sender?.tenant_key;
    const chatId = message.chat_id;
    const messageId = message.message_id;
    const eventId = data.event_id;
    const senderOpenId = data.sender?.sender_id?.open_id;
    if (!tenantKey || !chatId || !messageId || !eventId || !senderOpenId) {
      return { status: "ignored_invalid_payload" };
    }

    const parsedContent = parseInboundContent(message);
    const command = stripLarkMention(parsedContent.text);
    const threadActionCommand = parseLarkThreadActionCommand(command);
    const isThreadReply = Boolean(message.root_id || message.parent_id);

    // Group messages must @-mention the bot before triggering a write-capable run. Exact source-thread
    // action replies are allowed without a mention only when Lark marks the message as threaded.
    const chatType = message.chat_type ?? "group";
    const isDirect = chatType === "p2p";
    if (!isDirect) {
      if (!config.botOpenId) {
        return { status: "ignored_group_requires_bot_open_id", tenantKey, chatId };
      }
      if (!mentionsBot(message.mentions, config.botOpenId) && !(threadActionCommand && isThreadReply)) {
        return { status: "ignored_not_addressed", tenantKey, chatId };
      }
    }

    // Self-service binding: connect this chat to a Project Target without leaving Lark.
    const bindRequest = parseBindCommand(command);
    if (bindRequest && !config.bindChannel) {
      return { status: "ignored_bind_unavailable", tenantKey, chatId };
    }
    if (bindRequest && config.bindChannel) {
      if (!bindRequest.ok) {
        await config.reply?.({ messageId, text: BIND_USAGE });
        return { status: "ignored_bind_usage", tenantKey, chatId };
      }
      const authorized = await canManageLarkBinding(config, {
        action: "bind",
        tenantKey,
        chatId,
        chatType,
        senderOpenId,
        ...(data.sender?.sender_id?.user_id ? { senderUserId: data.sender.sender_id.user_id } : {}),
        ...(data.sender?.sender_id?.union_id ? { senderUnionId: data.sender.sender_id.union_id } : {}),
        messageId,
        eventId
      });
      if (!authorized) {
        await config.reply?.({ messageId, text: BINDING_AUTH_DENIED_TEXT });
        return { status: "ignored_bind_unauthorized", tenantKey, chatId };
      }
      await config.bindChannel({
        tenantKey,
        chatId,
        repoProvider: bindRequest.repoProvider,
        owner: bindRequest.owner,
        repo: bindRequest.repo
      });
      await config.reply?.({
        messageId,
        text: `Connected this chat to Project Target ${bindRequest.repoProvider}:${bindRequest.owner}/${bindRequest.repo}. @-mention me with a task to start a run.`
      });
      return { status: "bound", tenantKey, chatId };
    }

    const unbindRequest = parseUnbindCommand(command);
    if (unbindRequest && !config.unbindChannel) {
      return { status: "ignored_unbind_unavailable", tenantKey, chatId };
    }
    if (unbindRequest && config.unbindChannel) {
      if (!unbindRequest.ok) {
        await config.reply?.({ messageId, text: UNBIND_USAGE });
        return { status: "ignored_unbind_usage", tenantKey, chatId };
      }
      const authorized = await canManageLarkBinding(config, {
        action: "unbind",
        tenantKey,
        chatId,
        chatType,
        senderOpenId,
        ...(data.sender?.sender_id?.user_id ? { senderUserId: data.sender.sender_id.user_id } : {}),
        ...(data.sender?.sender_id?.union_id ? { senderUnionId: data.sender.sender_id.union_id } : {}),
        messageId,
        eventId
      });
      if (!authorized) {
        await config.reply?.({ messageId, text: BINDING_AUTH_DENIED_TEXT });
        return { status: "ignored_unbind_unauthorized", tenantKey, chatId };
      }
      const binding = await config.resolveChannelBinding({ tenantKey, chatId });
      if (!binding) {
        await config.reply?.({ messageId, text: UNBOUND_HINT });
        return { status: "ignored_unbound_chat", tenantKey, chatId };
      }
      await config.unbindChannel({ tenantKey, chatId });
      await config.reply?.({
        messageId,
        text: `Disconnected this chat from Project Target ${formatProjectTarget(binding)}. @-mention me with \`/bind <owner>/<repo>\` to connect a new target.`
      });
      return { status: "unbound", tenantKey, chatId };
    }

    if (command.trim().length === 0) {
      return { status: "ignored_empty_command", tenantKey, chatId };
    }

    const stopRequest = parseStopCommand(command);
    if (stopRequest) {
      if (!config.stopRun) {
        await config.reply?.({ messageId, text: STOP_UNAVAILABLE_TEXT });
        return { status: "self_service_stop_unavailable", tenantKey, chatId };
      }
      const result = await config.stopRun({
        tenantKey,
        chatId,
        ...(stopRequest.runId ? { runId: stopRequest.runId } : {}),
        requestedBy: `lark:${senderOpenId}`
      });
      await config.reply?.({ messageId, text: formatStopResultText(result) });
      return { status: "self_service_stop", ...(result.runId ? { runId: result.runId } : {}), tenantKey, chatId };
    }

    const selfServiceCommand = parseSelfServiceCommand(command);
    if (selfServiceCommand === "help") {
      await config.reply?.({ messageId, text: HELP_TEXT });
      return { status: "self_service_help", tenantKey, chatId };
    }
    if (selfServiceCommand === "status" || selfServiceCommand === "doctor") {
      const binding = await config.resolveChannelBinding({ tenantKey, chatId });
      const context: LarkSelfServiceContext = { tenantKey, chatId, messageId, binding };
      const reply =
        selfServiceCommand === "status"
          ? normalizeSelfServiceReply(await (config.status?.(context) ?? Promise.resolve(statusReply({ tenantKey, chatId, binding }))))
          : normalizeSelfServiceReply(await (config.doctor?.(context) ?? Promise.resolve(doctorReply({ tenantKey, chatId, binding }))));
      await config.reply?.({ messageId, text: reply.text, ...(reply.card ? { card: reply.card } : {}) });
      return { status: selfServiceCommand === "status" ? "self_service_status" : "self_service_doctor", tenantKey, chatId };
    }

    let binding = await config.resolveChannelBinding({ tenantKey, chatId });
    if (binding && config.defaultRepoBinding && config.bindChannel) {
      if (shouldMigrateLegacyLocalBinding({ existing: binding, defaultBinding: config.defaultRepoBinding })) {
        await config.bindChannel({
          tenantKey,
          chatId,
          repoProvider: config.defaultRepoBinding.repoProvider,
          owner: config.defaultRepoBinding.owner,
          repo: config.defaultRepoBinding.repo
        });
        binding = bindingFromDefault({ tenantKey, chatId, binding: config.defaultRepoBinding });
      }
    }
    if (!binding) {
      if (config.defaultRepoBinding && config.bindChannel) {
        await config.bindChannel({
          tenantKey,
          chatId,
          repoProvider: config.defaultRepoBinding.repoProvider,
          owner: config.defaultRepoBinding.owner,
          repo: config.defaultRepoBinding.repo
        });
        binding = bindingFromDefault({ tenantKey, chatId, binding: config.defaultRepoBinding });
      } else {
        await config.reply?.({ messageId, text: UNBOUND_HINT });
        return { status: "ignored_unbound_chat", tenantKey, chatId };
      }
    }

    if (threadActionCommand) {
      if (!config.submitThreadAction) {
        await config.reply?.({ messageId, text: THREAD_ACTION_UNAVAILABLE_TEXT });
        return { status: "ignored_thread_action_unavailable", tenantKey, chatId };
      }
      const callbackMessageId = larkCallbackMessageId(message);
      if (!callbackMessageId) {
        await config.reply?.({ messageId, text: THREAD_ACTION_INVALID_THREAD_TEXT });
        return { status: "ignored_invalid_payload", tenantKey, chatId };
      }
      await config.submitThreadAction({
        id: `approval_lark_${eventId}`,
        rawText: threadActionCommand.rawText,
        actor: {
          provider: "lark",
          providerUserId: senderOpenId,
          handle: senderOpenId,
          organizationId: tenantKey
        },
        callback: {
          provider: "lark",
          uri: config.callbackUri ?? "lark://im/v1/messages",
          threadKey: encodeLarkThreadKey({ tenantKey, chatId, messageId: callbackMessageId })
        },
        metadata: {
          source: "lark_reply",
          tenantKey,
          chatId,
          messageId,
          ...(threadActionCommand.rawText !== command ? { larkRawText: command } : {}),
          sourceDeliveryId: eventId,
          larkEventId: eventId,
          ...(config.domain ? { larkDomain: config.domain } : {}),
          larkRenderLocale: renderLocale,
          ...(message.root_id ? { rootId: message.root_id } : {}),
          ...(message.parent_id ? { parentId: message.parent_id } : {}),
          ...(data.sender?.sender_id?.user_id ? { senderUserId: data.sender.sender_id.user_id } : {}),
          ...(data.sender?.sender_id?.union_id ? { senderUnionId: data.sender.sender_id.union_id } : {}),
          ...(config.botOpenId ? { larkBotOpenId: config.botOpenId } : {}),
          repoProvider: binding.repoProvider ?? "github",
          owner: binding.owner,
          repo: binding.repo
        }
      });
      return { status: "thread_action_submitted", tenantKey, chatId };
    }

    const parsedTime = data.create_time ? Number(data.create_time) : Number.NaN;
    const eventTimeMs = Number.isFinite(parsedTime) ? parsedTime : (config.now?.() ?? Date.now());

    const event = normalizeLarkMessage({
      tenantKey,
      chatId,
      chatType: message.chat_type ?? "group",
      senderOpenId,
      text: parsedContent.text,
      ...(parsedContent.attachments.length ? { attachments: parsedContent.attachments } : {}),
      messageId,
      ...(message.root_id ? { rootId: message.root_id } : {}),
      eventId,
      eventTimeMs,
      agentId: config.agentId,
      ...(config.applicationId ? { applicationId: config.applicationId } : {}),
      ...(config.botOpenId ? { botOpenId: config.botOpenId } : {}),
      ...(config.domain ? { domain: config.domain } : {}),
      renderLocale,
      ...(config.callbackUri ? { callbackUri: config.callbackUri } : {}),
      ...(config.conversationMemory ? { conversationMemory: config.conversationMemory } : {}),
      binding
    });
    if (!event) {
      return { status: "ignored_empty_command" };
    }

    const result = await config.createRun(event);
    if (result.outcome === "run_created") {
      if (!result.idempotentReplay && !config.suppressRunCreatedReply) {
        await config.reply?.({ messageId, text: formatRunReceivedText(result.run.id) });
      }
      return { status: "created", runId: result.run.id, tenantKey, chatId };
    }
    if (result.outcome === "follow_up_queued") {
      await config.reply?.({
        messageId,
        text: formatFollowUpQueuedText({
          followUpRequestId: result.followUpRequest.id,
          ...(result.decision.activeRunId ? { activeRunId: result.decision.activeRunId } : {}),
          reason: result.decision.reason
        })
      });
      return {
        status: "follow_up_queued",
        followUpRequestId: result.followUpRequest.id,
        ...(result.decision.activeRunId ? { runId: result.decision.activeRunId } : {}),
        reason: result.decision.reason,
        tenantKey,
        chatId
      };
    }
    return {
      status: "needs_human_decision",
      reason: result.decision.reason,
      tenantKey,
      chatId
    };
  };
}

export function createLarkCardActionHandler(config: LarkCardActionHandlerConfig) {
  return async function handleLarkCardAction(data: LarkCardActionEvent): Promise<LarkCardActionHandlerOutcome> {
    const renderLocale = config.renderLocale ?? larkRenderLocaleFromDomain(config.domain);
    const parsedValue = parseLarkThreadActionButtonValue(data.action?.value);
    if (!parsedValue) {
      return { status: "ignored_card_action_not_opentag" };
    }
    const command = parseLarkThreadActionCommand(parsedValue.command);
    if (!command) {
      return { status: "ignored_card_action_invalid_payload" };
    }

    const tenantKey = data.tenant_key;
    const chatId = data.context?.open_chat_id ?? data.open_chat_id;
    const messageId = data.context?.open_message_id ?? data.open_message_id;
    const actorOpenId = data.operator?.open_id ?? data.user?.open_id ?? data.open_id;
    if (!tenantKey || !chatId || !messageId || !actorOpenId) {
      return {
        status: "ignored_card_action_invalid_payload",
        ...(tenantKey ? { tenantKey } : {}),
        ...(chatId ? { chatId } : {}),
        ...(messageId ? { messageId } : {})
      };
    }

    const binding = await config.resolveChannelBinding({ tenantKey, chatId });
    if (!binding) {
      return { status: "ignored_card_action_unbound_chat", tenantKey, chatId, messageId };
    }
    if (!config.submitThreadAction) {
      return { status: "ignored_card_action_unavailable", tenantKey, chatId, messageId };
    }

    await config.submitThreadAction({
      id: larkCardActionId({
        ...(data.event_id ? { eventId: data.event_id } : {}),
        messageId,
        actorId: actorOpenId,
        command: command.rawText
      }),
      rawText: command.rawText,
      actor: {
        provider: "lark",
        providerUserId: actorOpenId,
        handle: data.operator?.name ?? data.user?.name ?? actorOpenId,
        organizationId: tenantKey
      },
      callback: {
        provider: "lark",
        uri: config.callbackUri ?? "lark://im/v1/messages",
        threadKey: encodeLarkThreadKey({ tenantKey, chatId, messageId })
      },
      metadata: {
        source: "lark_card_action",
        tenantKey,
        chatId,
        messageId,
        ...(config.domain ? { larkDomain: config.domain } : {}),
        larkRenderLocale: renderLocale,
        ...(command.rawText !== parsedValue.command ? { larkRawCommand: parsedValue.command } : {}),
        sourceDeliveryId: data.event_id ?? larkCardActionId({ messageId, actorId: actorOpenId, command: command.rawText }),
        ...(data.event_id ? { larkEventId: data.event_id } : {}),
        ...(data.operator?.user_id ?? data.user?.user_id ?? data.user_id ? { senderUserId: data.operator?.user_id ?? data.user?.user_id ?? data.user_id } : {}),
        ...(data.operator?.union_id ?? data.user?.union_id ? { senderUnionId: data.operator?.union_id ?? data.user?.union_id } : {}),
        ...(data.action?.tag ? { actionTag: data.action.tag } : {}),
        ...(data.action?.name ? { actionName: data.action.name } : {}),
        ...(parsedValue.proposalId ? { proposalId: parsedValue.proposalId } : {}),
        ...(parsedValue.intentId ? { intentId: parsedValue.intentId } : {}),
        ...(parsedValue.permissionDecision ? { permissionDecision: parsedValue.permissionDecision } : {}),
        ...(parsedValue.proposalHash ? { proposalHash: parsedValue.proposalHash } : {}),
        ...(parsedValue.approvalEpoch ? { approvalEpoch: parsedValue.approvalEpoch } : {}),
        ...(parsedValue.actionId ? { governedActionId: parsedValue.actionId } : {}),
        repoProvider: binding.repoProvider ?? "github",
        owner: binding.owner,
        repo: binding.repo
      }
    });
    return { status: "card_action_submitted", tenantKey, chatId, messageId };
  };
}
