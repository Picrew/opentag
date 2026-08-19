import { randomUUID } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import { createOpenTagClient, type ChannelRuntimeStatus } from "@opentag/client";
import {
  createDoctorSummaryPresentation,
  createSourceThreadStatusPresentation,
  parseProjectTargetRef,
  renderOpenTagPresentationPlainText,
  type OpenTagDoctorSummaryPresentation,
  type ConversationMemoryPolicy,
  type OpenTagEvent,
  type OpenTagSourceThreadStatusPresentation
} from "@opentag/core";
import { createLarkReplyClient, replyLarkMessage } from "./outbound.js";
import {
  createLarkCardActionHandler,
  createLarkMessageHandler,
  type LarkCardActionEvent,
  type LarkCardActionHandlerOutcome,
  type LarkInboundMessageEvent,
  type LarkMessageHandlerOutcome,
  type LarkSelfServiceReply
} from "./inbound.js";
import { createLarkDoctorSummaryCard, createLarkSourceThreadStatusCard, type LarkCard } from "./render.js";

export const DEFAULT_AGENT_ID = "opentag";

export type LarkIngressConfig = {
  appId: string;
  appSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  channelPrincipalCredential?: string;
  domain: "lark" | "feishu";
  agentId: string;
  botOpenId?: string;
  bindingAdminOpenIds?: string[];
  bindingAdminUserIds?: string[];
  bindingAdminUnionIds?: string[];
  runTimeoutMs?: number;
  conversationMemory?: ConversationMemoryPolicy;
  defaultRepoBinding?: { repoProvider: string; owner: string; repo: string };
};

export type LarkWsClient = {
  start(input: { eventDispatcher: unknown }): Promise<void>;
  close?(input?: { force?: boolean }): void | Promise<void>;
};

export type LarkIngressDependencies = {
  createWsClient?(config: LarkIngressConfig): LarkWsClient;
  createEventDispatcher?(handler: (data: LarkInboundMessageEvent) => Promise<void>): unknown;
  reply?(input: { messageId: string; text: string; card?: LarkCard }): Promise<void>;
  logIgnored?(outcome: LarkMessageHandlerOutcome): void;
};

export type LarkIngressHandle = {
  startPromise: Promise<void>;
  handleCardAction(data: LarkCardActionEvent): Promise<LarkCardActionHandlerOutcome>;
  close(): Promise<void>;
};

export type LarkCardActionCallbackHandlerConfig = {
  verificationToken?: string;
  encryptKey?: string;
  loggerLevel?: lark.LoggerLevel;
  handleCardAction(data: LarkCardActionEvent): Promise<LarkCardActionHandlerOutcome>;
  logOutcome?(outcome: LarkCardActionHandlerOutcome): void;
};

export function createLarkCardActionCallbackHandler(config: LarkCardActionCallbackHandlerConfig): lark.CardActionHandler {
  return new lark.CardActionHandler(
    {
      ...(config.verificationToken ? { verificationToken: config.verificationToken } : {}),
      ...(config.encryptKey ? { encryptKey: config.encryptKey } : {}),
      loggerLevel: config.loggerLevel ?? lark.LoggerLevel.error
    },
    async (data: LarkCardActionEvent) => {
      try {
        const outcome = await config.handleCardAction(data);
        config.logOutcome?.(outcome);
      } catch (error) {
        console.error("[lark] failed to handle card action:", error);
      }
      return {};
    }
  );
}

function defaultRepoBindingFromEnv(value: string | undefined): LarkIngressConfig["defaultRepoBinding"] {
  if (!value) return undefined;
  try {
    const ref = parseProjectTargetRef(value);
    return {
      repoProvider: ref.provider,
      owner: ref.owner,
      repo: ref.repo
    };
  } catch {
    throw new Error("OPENTAG_LARK_DEFAULT_REPO must be formatted as owner/repo or provider:owner/repo");
  }
}

function domainFromEnv(value: string | undefined): LarkIngressConfig["domain"] {
  const domain = value ?? "lark";
  if (domain !== "lark" && domain !== "feishu") {
    throw new Error("LARK_DOMAIN must be either lark or feishu");
  }
  return domain;
}

function positiveIntegerFromEnv(name: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function csvList(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

function optionalNonBlankEnv(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function larkIngressConfigFromEnv(env: NodeJS.ProcessEnv): LarkIngressConfig {
  const appId = optionalNonBlankEnv("LARK_APP_ID", env.LARK_APP_ID);
  const appSecret = optionalNonBlankEnv("LARK_APP_SECRET", env.LARK_APP_SECRET);
  const channelPrincipalCredential = optionalNonBlankEnv(
    "OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL",
    env.OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL
  );
  const dispatcherUrl = env.OPENTAG_DISPATCHER_URL;
  if (Boolean(appId) !== Boolean(channelPrincipalCredential)) {
    throw new Error("LARK_APP_ID and OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together.");
  }
  if (!appId || !appSecret) {
    throw new Error("LARK_APP_ID and LARK_APP_SECRET are required");
  }
  if (!dispatcherUrl) {
    throw new Error("OPENTAG_DISPATCHER_URL is required");
  }

  const defaultRepoBinding = defaultRepoBindingFromEnv(env.OPENTAG_LARK_DEFAULT_REPO);
  const runTimeoutMs = positiveIntegerFromEnv("OPENTAG_RUN_TIMEOUT_MS", env.OPENTAG_RUN_TIMEOUT_MS);
  const bindingAdminOpenIds = csvList(env.OPENTAG_LARK_BINDING_ADMIN_OPEN_IDS);
  const bindingAdminUserIds = csvList(env.OPENTAG_LARK_BINDING_ADMIN_USER_IDS);
  const bindingAdminUnionIds = csvList(env.OPENTAG_LARK_BINDING_ADMIN_UNION_IDS);

  return {
    appId,
    appSecret,
    dispatcherUrl,
    domain: domainFromEnv(env.LARK_DOMAIN),
    agentId: env.OPENTAG_LARK_AGENT_ID ?? DEFAULT_AGENT_ID,
    ...(env.OPENTAG_DISPATCHER_TOKEN ? { dispatcherToken: env.OPENTAG_DISPATCHER_TOKEN } : {}),
    ...(channelPrincipalCredential ? { channelPrincipalCredential } : {}),
    ...(env.LARK_BOT_OPEN_ID ? { botOpenId: env.LARK_BOT_OPEN_ID } : {}),
    ...(bindingAdminOpenIds ? { bindingAdminOpenIds } : {}),
    ...(bindingAdminUserIds ? { bindingAdminUserIds } : {}),
    ...(bindingAdminUnionIds ? { bindingAdminUnionIds } : {}),
    ...(runTimeoutMs ? { runTimeoutMs } : {}),
    ...(defaultRepoBinding ? { defaultRepoBinding } : {})
  };
}

function createDefaultWsClient(config: LarkIngressConfig): LarkWsClient {
  return new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark
  });
}

function createDefaultEventDispatcher(handler: (data: LarkInboundMessageEvent) => Promise<void>): unknown {
  return new lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data) => handler(data as unknown as LarkInboundMessageEvent)
  });
}

function logIgnored(outcome: LarkMessageHandlerOutcome): void {
  if (
    outcome.status === "created" ||
    outcome.status === "bound" ||
    outcome.status === "unbound" ||
    outcome.status === "thread_action_submitted" ||
    outcome.status === "self_service_help" ||
    outcome.status === "self_service_status" ||
    outcome.status === "self_service_doctor" ||
    outcome.status === "self_service_stop" ||
    outcome.status === "self_service_stop_unavailable"
  ) {
    return;
  }
  if (outcome.status === "follow_up_queued") {
    console.log(
      `[lark] queued follow-up${outcome.followUpRequestId ? ` follow_up_request_id=${outcome.followUpRequestId}` : ""}${outcome.runId ? ` active_run_id=${outcome.runId}` : ""}`
    );
    return;
  }
  if (outcome.status === "needs_human_decision") {
    console.log(`[lark] needs human decision${outcome.reason ? `: ${outcome.reason}` : ""}`);
    return;
  }
  if (outcome.status === "ignored_unbound_chat") {
    console.log(
      `[lark] ignored unbound chat - bind it: provider=lark accountId(tenant_key)=${outcome.tenantKey} conversationId(chat_id)=${outcome.chatId} (reply '/bind owner/repo' with a Project Target ref, or POST /v1/channel-bindings)`
    );
    return;
  }
  console.log(`[lark] ignored event: ${outcome.status}${outcome.chatId ? ` chat_id=${outcome.chatId}` : ""}`);
}

function formatProjectTarget(input: { repoProvider?: string; owner?: string; repo?: string }): string {
  if (!input.owner || !input.repo) return "not bound";
  return `${input.repoProvider ?? "github"}:${input.owner}/${input.repo}`;
}

function queuedFollowUpsSummary(status: ChannelRuntimeStatus): string {
  if (status.queuedFollowUps.length === 0) return "none.";
  const visible = status.queuedFollowUps.slice(0, 3).map((followUp) => followUp.id);
  const suffix = status.queuedFollowUps.length > visible.length ? `, +${status.queuedFollowUps.length - visible.length} more` : "";
  return `${status.queuedFollowUps.length} (${visible.join(", ")}${suffix}).`;
}

function formatDurationMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute(s)`;
  if (ms % 1_000 === 0) return `${ms / 1_000} second(s)`;
  return `${ms}ms`;
}

function runTimeoutPolicy(input: { runTimeoutMs?: number; status?: ChannelRuntimeStatus }): string {
  const hardTimeoutMs = input.status?.runTimeoutPolicy?.hardTimeoutMs ?? input.runTimeoutMs;
  return hardTimeoutMs ? `hard timeout after ${formatDurationMs(hardTimeoutMs)}` : "disabled";
}

function larkRuntimeStatusPresentation(status: ChannelRuntimeStatus, input: { runTimeoutMs?: number } = {}): OpenTagSourceThreadStatusPresentation {
  return createSourceThreadStatusPresentation({
    title: "OpenTag status:",
    sourceContainer: `${status.binding.provider}:${status.binding.accountId}/${status.binding.conversationId}`,
    projectTarget: formatProjectTarget(status.binding),
    bindingState: "bound",
    ...(status.activeRun
      ? {
          activeRun: {
            id: status.activeRun.id,
            status: status.activeRun.status,
            updatedAt: status.activeRun.updatedAt
          }
        }
      : {}),
    ...(status.activeEvent?.command.rawText ? { currentCommand: status.activeEvent.command.rawText } : {}),
    queuedFollowUps: status.queuedFollowUps.slice(0, 3).map((followUp) => ({
      id: followUp.id,
      status: followUp.status,
      command: followUp.event.command.rawText
    })),
    queuedFollowUpsTotal: status.queuedFollowUps.length,
    nextAction: status.activeRun
      ? "wait for the final reply, send a follow-up to queue more context, or use `/stop` to request cancellation."
      : "@-mention me with a task to start a run.",
    stopHint: `cancellation is explicit and is not reported as successful completion; timeout policy: ${runTimeoutPolicy({ ...input, status })}.`,
    detailHint: "use `opentag status --run <run_id>` locally for audit events and executor detail."
  });
}

function larkRuntimeStatusReply(status: ChannelRuntimeStatus, input: { runTimeoutMs?: number } = {}): LarkSelfServiceReply {
  const presentation = larkRuntimeStatusPresentation(status, input);
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    card: createLarkSourceThreadStatusCard(presentation)
  };
}

function larkRuntimeDoctorPresentation(input: {
  tenantKey: string;
  chatId: string;
  status: ChannelRuntimeStatus;
  runTimeoutMs?: number;
}): OpenTagDoctorSummaryPresentation {
  return createDoctorSummaryPresentation({
    title: "OpenTag doctor (redacted):",
    checks: [
      { status: "ok", name: "Source container", message: `lark:${input.tenantKey}/${input.chatId}` },
      { status: "ok", name: "Project Target", message: formatProjectTarget(input.status.binding) },
      { status: "ok", name: "Dispatcher", message: "reachable for this source container." },
      {
        status: "ok",
        name: "Active run",
        message: input.status.activeRun
          ? `${input.status.activeRun.id} (${input.status.activeRun.status}), updated ${input.status.activeRun.updatedAt}.`
          : "none."
      },
      { status: "ok", name: "Queued follow-ups", message: queuedFollowUpsSummary(input.status) },
      { status: "ok", name: "Timeout policy", message: runTimeoutPolicy({ ...input, status: input.status }) },
      {
        status: "ok",
        name: "Runtime readiness",
        message: "source-container status is reachable; run `opentag service status` locally to confirm launchd, connector, executor, and heartbeat health."
      },
      { status: "ok", name: "Secrets", message: "redacted. Use env/file/keychain SecretRef config and never paste app secrets into this chat." },
      { status: "ok", name: "Source-thread output", message: "concise final replies by default; detailed process belongs in audit/status." }
    ]
  });
}

function larkRuntimeDoctorReply(input: { tenantKey: string; chatId: string; status: ChannelRuntimeStatus; runTimeoutMs?: number }): LarkSelfServiceReply {
  const presentation = larkRuntimeDoctorPresentation(input);
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    card: createLarkDoctorSummaryCard(presentation)
  };
}

function formatStatusUnavailable(input: { binding?: { repoProvider?: string; owner?: string; repo?: string }; error: unknown }): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return [
    "OpenTag status:",
    input.binding ? `- Project Target: ${formatProjectTarget(input.binding)}` : "- Project Target: not bound.",
    "- Runtime status: unavailable from dispatcher.",
    `- Reason: ${message}`,
    "- Next action: check `opentag service status` and `opentag status` locally."
  ].join("\n");
}

function formatDoctorUnavailable(input: {
  tenantKey: string;
  chatId: string;
  binding?: { repoProvider?: string; owner?: string; repo?: string };
  error: unknown;
}): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return [
    "OpenTag doctor (redacted):",
    `- Source container: lark:${input.tenantKey}/${input.chatId}`,
    input.binding
      ? `- Project Target: ${formatProjectTarget(input.binding)}`
      : "- Project Target: not bound.",
    "- Dispatcher: source-container status unavailable.",
    `- Reason: ${message}`,
    "- Runtime readiness: run `opentag service status` and `opentag status --channel lark:<tenant>/<chat>` locally.",
    "- Secrets: redacted; do not share local config or app secrets in this chat."
  ].join("\n");
}

export function startLarkIngress(config: LarkIngressConfig, dependencies: LarkIngressDependencies = {}): LarkIngressHandle {
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {}),
    ...(config.channelPrincipalCredential ? { channelPrincipalCredential: config.channelPrincipalCredential } : {})
  });
  let replyClient: ReturnType<typeof createLarkReplyClient> | undefined;
  const reply =
    dependencies.reply ??
    ((input: { messageId: string; text: string; card?: LarkCard }) => {
      replyClient ??= createLarkReplyClient({ appId: config.appId, appSecret: config.appSecret, domain: config.domain });
      return replyLarkMessage(replyClient, input);
    });

  async function resolveChannelBinding(input: { tenantKey: string; chatId: string }) {
    try {
      const { binding } = await dispatcherClient.getChannelBinding({
        provider: "lark",
        accountId: input.tenantKey,
        conversationId: input.chatId
      });
      return {
        tenantKey: binding.accountId,
        chatId: binding.conversationId,
        ...(binding.repoProvider
          ? { repoProvider: binding.repoProvider, owner: binding.owner, repo: binding.repo }
          : {})
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("channel_binding_not_found")) {
        return null;
      }
      throw error;
    }
  }

  const handler = createLarkMessageHandler({
    agentId: config.agentId,
    applicationId: config.appId,
    suppressRunCreatedReply: true,
    domain: config.domain,
    ...(config.botOpenId ? { botOpenId: config.botOpenId } : {}),
    ...(config.defaultRepoBinding ? { defaultRepoBinding: config.defaultRepoBinding } : {}),
    ...(config.conversationMemory ? { conversationMemory: config.conversationMemory } : {}),
    resolveChannelBinding,
    async bindChannel(input) {
      await dispatcherClient.bindChannel({
        provider: "lark",
        accountId: input.tenantKey,
        conversationId: input.chatId,
        repoProvider: input.repoProvider,
        owner: input.owner,
        repo: input.repo,
        ownership: {
          mode: "managed",
          exclusive: true,
          applicationId: config.appId,
          ...(config.botOpenId ? { botId: config.botOpenId } : {})
        }
      });
    },
    async unbindChannel(input) {
      await dispatcherClient.unbindChannel({
        provider: "lark",
        accountId: input.tenantKey,
        conversationId: input.chatId
      });
    },
    canManageBinding(input) {
      if (input.chatType === "p2p") return true;
      return Boolean(
        config.bindingAdminOpenIds?.includes(input.senderOpenId) ||
          (input.senderUserId && config.bindingAdminUserIds?.includes(input.senderUserId)) ||
          (input.senderUnionId && config.bindingAdminUnionIds?.includes(input.senderUnionId))
      );
    },
    async stopRun(input) {
      try {
        const result = input.runId
          ? await dispatcherClient.cancelRun({
              runId: input.runId,
              reason: "Stop requested from Lark.",
              requestedBy: input.requestedBy
            })
          : await dispatcherClient.cancelActiveChannelRun({
              provider: "lark",
              accountId: input.tenantKey,
              conversationId: input.chatId,
              reason: "Stop requested from Lark.",
              requestedBy: input.requestedBy
            });
        return { outcome: "cancelled", runId: result.run.id };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("run_already_terminal")) {
          return { outcome: "already_terminal", runId: input.runId ?? "active run" };
        }
        if (
          message.includes("run_not_found") ||
          message.includes("active_run_not_found") ||
          message.includes("channel_binding_not_found")
        ) {
          return input.runId ? { outcome: "not_found", runId: input.runId } : { outcome: "not_found" };
        }
        throw error;
      }
    },
    async status(input) {
      if (!input.binding) {
        const presentation = createSourceThreadStatusPresentation({
          title: "OpenTag status:",
          sourceContainer: `lark:${input.tenantKey}/${input.chatId}`,
          bindingState: "unbound",
          nextAction: "@-mention me with `/bind <owner>/<repo>` to connect a Project Target.",
          detailHint: "active run and queued follow-up status are unavailable until this chat is bound."
        });
        return {
          text: renderOpenTagPresentationPlainText(presentation),
          card: createLarkSourceThreadStatusCard(presentation)
        };
      }
      try {
        return larkRuntimeStatusReply(
          await dispatcherClient.getChannelRuntimeStatus({
            provider: "lark",
            accountId: input.tenantKey,
            conversationId: input.chatId
          }),
          { ...(config.runTimeoutMs ? { runTimeoutMs: config.runTimeoutMs } : {}) }
        );
      } catch (error) {
        return formatStatusUnavailable({ binding: input.binding, error });
      }
    },
    async doctor(input) {
      if (!input.binding) {
        const presentation = createDoctorSummaryPresentation({
          title: "OpenTag doctor (redacted):",
          checks: [
            { status: "ok", name: "Source container", message: `lark:${input.tenantKey}/${input.chatId}` },
            { status: "warn", name: "Project Target", message: "not bound." },
            { status: "warn", name: "Dispatcher", message: "binding not found for this source container." },
            { status: "ok", name: "Next action", message: "@-mention me with `/bind <owner>/<repo>` to connect a Project Target." },
            { status: "ok", name: "Secrets", message: "redacted; do not share local config or app secrets in this chat." }
          ]
        });
        return {
          text: renderOpenTagPresentationPlainText(presentation),
          card: createLarkDoctorSummaryCard(presentation)
        };
      }
      try {
        return larkRuntimeDoctorReply({
          tenantKey: input.tenantKey,
          chatId: input.chatId,
          status: await dispatcherClient.getChannelRuntimeStatus({
            provider: "lark",
            accountId: input.tenantKey,
            conversationId: input.chatId
          }),
          ...(config.runTimeoutMs ? { runTimeoutMs: config.runTimeoutMs } : {})
        });
      } catch (error) {
        return formatDoctorUnavailable({ tenantKey: input.tenantKey, chatId: input.chatId, binding: input.binding, error });
      }
    },
    async reply(input) {
      await reply(input);
    },
    async createRun(event: OpenTagEvent) {
      const runId = `run_${randomUUID()}`;
      return dispatcherClient.createRun({ runId, event });
    },
    async submitThreadAction(action) {
      return dispatcherClient.submitThreadAction(action);
    }
  });
  const handleCardAction = createLarkCardActionHandler({
    domain: config.domain,
    resolveChannelBinding,
    async submitThreadAction(action) {
      return dispatcherClient.submitThreadAction(action);
    }
  });

  const eventDispatcher = (dependencies.createEventDispatcher ?? createDefaultEventDispatcher)(async (data) => {
    try {
      (dependencies.logIgnored ?? logIgnored)(await handler(data));
    } catch (error) {
      console.error("[lark] failed to handle inbound message:", error);
    }
  });
  const wsClient = (dependencies.createWsClient ?? createDefaultWsClient)(config);

  return {
    startPromise: wsClient.start({ eventDispatcher }),
    handleCardAction,
    async close() {
      await wsClient.close?.({ force: true });
    }
  };
}
