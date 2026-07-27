import {
  createDoctorSummaryPresentation,
  createSourceThreadStatusPresentation,
  parseProjectTargetRef,
  parseThreadActionCommand,
  renderOpenTagPresentationPlainText,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagEvent,
  type OpenTagSourceThreadStatusPresentation
} from "@opentag/core";
import { encodeSlackThreadKey, normalizeSlackAppMention, stripSlackAppMention, type SlackChannelBinding } from "./normalize.js";
import {
  createSlackDoctorSummaryBlocks,
  createSlackSourceThreadStatusBlocks,
  parseSlackSuggestedActionButtonValue,
  type SlackBlock
} from "./render.js";

export type SlackThreadActionInput = {
  id: string;
  rawText: string;
  actor: {
    provider: "slack";
    providerUserId: string;
    handle: string;
    organizationId: string;
  };
  callback: {
    provider: "slack";
    uri: string;
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

export type SlackEventEnvelope = {
  token?: string;
  type: "url_verification" | "event_callback";
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: {
    type: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    channel?: string;
    subtype?: string;
    bot_id?: string;
  };
  event_id?: string;
  event_time?: number;
  authorizations?: Array<{ user_id?: string }>;
};

export type SlackInteractiveBlockAction = {
  type?: string;
  action_id?: string;
  block_id?: string;
  value?: string;
  action_ts?: string;
};

export type SlackInteractivePayload = {
  type: "block_actions";
  api_app_id?: string;
  team?: { id?: string; domain?: string };
  user?: { id?: string; username?: string; name?: string };
  channel?: { id?: string; name?: string };
  message?: { ts?: string; thread_ts?: string };
  container?: { type?: string; channel_id?: string; message_ts?: string; thread_ts?: string };
  trigger_id?: string;
  actions?: SlackInteractiveBlockAction[];
};

export type SlackIngressPayload = SlackEventEnvelope | SlackInteractivePayload;

export type SlackIngressVerification = {
  signatureVerified?: boolean;
};

export type SlackAppRuntimeConfig = {
  agentId: string;
  appId?: string;
  callbackUri?: string;
};

export type SlackSelfServiceReply = {
  text: string;
  textFormat?: "mrkdwn";
  blocks?: SlackBlock[];
};

export type SlackSelfServiceContext = {
  teamId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  binding: SlackChannelBinding | null;
};

export type SlackBindingManagementContext = {
  action: "bind" | "unbind";
  teamId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  eventId: string;
  appId?: string;
};

export type SlackStopRunResult =
  | { outcome: "cancelled"; runId: string }
  | { outcome: "already_terminal"; runId: string }
  | { outcome: "not_found"; runId?: string };

export type SlackEventProcessorInput = {
  resolveChannelBinding(input: { teamId: string; channelId: string }): Promise<SlackChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  submitThreadAction?(action: SlackThreadActionInput): Promise<unknown>;
  bindChannel?(input: { teamId: string; channelId: string; repoProvider: string; owner: string; repo: string }): Promise<void>;
  unbindChannel?(input: { teamId: string; channelId: string }): Promise<void>;
  reply?(input: { channelId: string; threadTs: string; text: string; textFormat?: "mrkdwn"; blocks?: SlackBlock[] }): Promise<void>;
  status?(input: SlackSelfServiceContext): Promise<SlackSelfServiceReply | string>;
  doctor?(input: SlackSelfServiceContext): Promise<SlackSelfServiceReply | string>;
  linear?(input: SlackSelfServiceContext): Promise<SlackSelfServiceReply | string>;
  stopRun?(input: { teamId: string; channelId: string; runId?: string; requestedBy: string }): Promise<SlackStopRunResult>;
  canManageBinding?(input: SlackBindingManagementContext): Promise<boolean> | boolean;
  now(): string;
};

export type SlackEventProcessorStatus = 200 | 400;

export type SlackEventProcessorResult =
  | {
      kind: "json";
      status: SlackEventProcessorStatus;
      body: Record<string, unknown>;
    }
  | {
      kind: "text";
      status: SlackEventProcessorStatus;
      body: string;
    };

function json(body: Record<string, unknown>, status: SlackEventProcessorStatus = 200): SlackEventProcessorResult {
  return { kind: "json", status, body };
}

function text(body: string, status: SlackEventProcessorStatus = 200): SlackEventProcessorResult {
  return { kind: "text", status, body };
}

const HELP_TEXT = [
  "OpenTag commands:",
  "- @mention the app with `/bind <owner>/<repo>` or `/bind <provider>:<owner>/<repo>` to connect this Slack channel to a Project Target.",
  "- @mention the app with `/status` to see the Project Target, active run, queued follow-ups, and next safe action.",
  "- @mention the app with `/doctor` to see a redacted readiness summary for this Slack channel.",
  "- @mention the app with `/linear` to list unfinished Linear issues for the configured Linear project (read-only).",
  "- @mention the app with `/stop [run_id]` to request cancellation for the active channel run or a specific run; OpenTag will not treat stop as successful completion.",
  "- @mention the app with `/unbind confirm` to disconnect this Slack channel from its Project Target; this does not delete local checkout config.",
  "- Reply in a source thread with `apply 1`, `approve 1`, `reject 1`, or `continue 1` when OpenTag posts source-thread actions.",
  "Project Targets never use absolute local paths. Keep local checkout paths in runner config and allowlists."
].join("\n");
const BIND_USAGE =
  "Usage: @mention the app with `/bind <owner>/<repo>` — e.g. `/bind amplifthq/opentag` or `/bind github:amplifthq/opentag`. Project Targets never use absolute local paths.";
const UNBIND_USAGE =
  "Usage: @mention the app with `/unbind confirm` to disconnect this Slack channel from its Project Target. This does not remove local checkout config, repository bindings, or allowlists.";
const UNBOUND_HINT =
  "This Slack channel is not connected to a Project Target. @mention the app with `/bind <owner>/<repo>` before starting runs, or update local OpenTag channel bindings.";
const STOP_UNAVAILABLE_TEXT = [
  "Run cancellation from this Slack ingress is not configured.",
  "OpenTag will not treat a stop request as a successful completion. Use `opentag status --run <run_id>` for audit detail, or `opentag service stop` if you need to stop the local background service."
].join("\n");
const LINEAR_UNAVAILABLE_TEXT =
  "Linear backlog is not available on this OpenTag runtime. Start OpenTag with `opentag start` after configuring platforms.linear, or update the ingress deployment.";
const LINEAR_USAGE =
  "Usage: @mention the app with `/linear` to list unfinished Linear issues for the configured Linear project (read-only).";
const BINDING_AUTH_DENIED_TEXT =
  "Only an authorized Slack binding manager can change this channel's Project Target. Ask an admin to run the command or update local OpenTag channel bindings.";

function normalizeSelfServiceReply(reply: SlackSelfServiceReply | string): SlackSelfServiceReply {
  return typeof reply === "string" ? { text: reply } : reply;
}

function parseSelfServiceCommand(command: string | null): "help" | "status" | "doctor" | null {
  const trimmed = command?.trim();
  if (!trimmed) return null;
  if (/^\/help(\s|$)/.test(trimmed)) return "help";
  if (/^\/status(\s|$)/.test(trimmed)) return "status";
  if (/^\/doctor(\s|$)/.test(trimmed)) return "doctor";
  return null;
}

function parseLinearCommand(command: string | null): { ok: true } | { ok: false } | null {
  const trimmed = command?.trim();
  if (!trimmed) return null;
  if (/^\/?linear$/iu.test(trimmed)) return { ok: true };
  // A slash prefix is an unambiguous command attempt; extra arguments get usage help.
  if (/^\/linear(\s|$)/iu.test(trimmed)) return { ok: false };
  // Bare "linear <more words>" stays a normal coding-run mention.
  return null;
}

type WellFormedSlackEventPayload = SlackEventEnvelope & {
  type: "event_callback";
  team_id: string;
  event_id: string;
  event: NonNullable<SlackEventEnvelope["event"]> & {
    user: string;
    text: string;
    ts: string;
    channel: string;
  };
};

function isWellFormedSlackEventPayload(payload: SlackIngressPayload): payload is WellFormedSlackEventPayload {
  if (payload.type !== "event_callback" || !payload.event) return false;
  return Boolean(
    payload.team_id &&
      payload.event_id &&
      payload.event.user &&
      payload.event.text &&
      payload.event.ts &&
      payload.event.channel
  );
}

type SlackLinearBacklogQueryPayload = WellFormedSlackEventPayload & {
  event: WellFormedSlackEventPayload["event"] & { type: "app_mention" };
};

export function isSlackLinearBacklogQuery(payload: SlackIngressPayload): payload is SlackLinearBacklogQueryPayload {
  if (!isWellFormedSlackEventPayload(payload) || payload.event.type !== "app_mention") return false;
  const command = stripSlackAppMention(payload.event.text, payload.authorizations?.[0]?.user_id);
  return parseLinearCommand(command)?.ok === true;
}

function parseStopCommand(command: string | null): { runId?: string } | null {
  const match = command?.trim().match(/^\/stop(?:\s+(\S+))?\s*$/);
  if (!match) return null;
  return match[1] ? { runId: match[1] } : {};
}

function parseBindCommand(
  command: string | null
): { ok: true; repoProvider: string; owner: string; repo: string } | { ok: false } | null {
  const trimmed = command?.trim();
  if (!trimmed || !/^\/bind(\s|$)/.test(trimmed)) return null;
  const match = trimmed.match(/^\/bind\s+(\S+)\s*$/);
  if (!match) return { ok: false };
  try {
    const ref = parseProjectTargetRef(match[1] as string);
    return { ok: true, repoProvider: ref.provider, owner: ref.owner, repo: ref.repo };
  } catch {
    return { ok: false };
  }
}

function parseUnbindCommand(command: string | null): { ok: true } | { ok: false } | null {
  const trimmed = command?.trim();
  if (!trimmed || !/^\/unbind(\s|$)/.test(trimmed)) return null;
  return /^\/unbind\s+confirm\s*$/.test(trimmed) ? { ok: true } : { ok: false };
}

async function canManageSlackBinding(
  input: SlackEventProcessorInput,
  context: SlackBindingManagementContext
): Promise<boolean> {
  if (input.canManageBinding) return input.canManageBinding(context);
  return false;
}

function formatStopResultText(result: SlackStopRunResult): string {
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
    : "No active run was found for this Slack channel and Project Target.";
}

function repositoryMetadataFromBinding(
  binding: SlackChannelBinding
): { repoProvider: string; owner: string; repo: string } | undefined {
  if (!binding.owner?.trim() || !binding.repo?.trim()) return undefined;
  return {
    repoProvider: binding.repoProvider?.trim() || "github",
    owner: binding.owner.trim(),
    repo: binding.repo.trim()
  };
}

function formatProjectTarget(binding: SlackChannelBinding): string {
  const repository = repositoryMetadataFromBinding(binding);
  return repository ? `${repository.repoProvider}:${repository.owner}/${repository.repo}` : "not bound";
}

function statusPresentation(input: SlackSelfServiceContext): OpenTagSourceThreadStatusPresentation {
  if (!input.binding) {
    return createSourceThreadStatusPresentation({
      title: "OpenTag status:",
      sourceContainer: `slack:${input.teamId}/${input.channelId}`,
      bindingState: "unbound",
      nextAction: "bind this Slack channel to a Project Target before starting runs.",
      detailHint: "active run and queued follow-up status are unavailable until this channel is bound."
    });
  }
  return createSourceThreadStatusPresentation({
    title: "OpenTag status:",
    sourceContainer: `slack:${input.teamId}/${input.channelId}`,
    projectTarget: formatProjectTarget(input.binding),
    bindingState: "bound",
    nextAction: "mention the app with a task, send a follow-up in the source thread, or use `opentag status --run <run_id>` locally.",
    stopHint: "cancellation is explicit and is not reported as successful completion; timeout policy is recorded in audit/status.",
    detailHint: "at most one run is active per Project Target + source thread; same-thread requests queue behind it."
  });
}

function statusReply(input: SlackSelfServiceContext): SlackSelfServiceReply {
  const presentation = statusPresentation(input);
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    blocks: createSlackSourceThreadStatusBlocks(presentation)
  };
}

function doctorPresentation(input: SlackSelfServiceContext): OpenTagDoctorSummaryPresentation {
  return createDoctorSummaryPresentation({
    title: "OpenTag doctor (redacted):",
    checks: [
      { status: "ok", name: "Source container", message: `slack:${input.teamId}/${input.channelId}` },
      {
        status: input.binding ? "ok" : "warn",
        name: "Project Target",
        message: input.binding ? formatProjectTarget(input.binding) : "not bound"
      },
      { status: "ok", name: "Secrets", message: "redacted. Use env/file/keychain SecretRef config and never paste tokens into Slack." },
      {
        status: "warn",
        name: "Runtime readiness",
        message: "check `opentag service status` locally; launchd running is not the same as connector ready."
      },
      { status: "ok", name: "Source-thread output", message: "concise final replies by default; detailed process stays in audit/status." }
    ]
  });
}

function doctorReply(input: SlackSelfServiceContext): SlackSelfServiceReply {
  const presentation = doctorPresentation(input);
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    blocks: createSlackDoctorSummaryBlocks(presentation)
  };
}

export function createSlackEventProcessor(input: SlackEventProcessorInput) {
  async function processBlockActions(payload: SlackInteractivePayload, slackApp: SlackAppRuntimeConfig): Promise<SlackEventProcessorResult> {
    const action = payload.actions?.find((candidate) => {
      if (candidate.action_id?.startsWith("opentag:")) return true;
      return typeof candidate.value === "string" && parseSlackSuggestedActionButtonValue(candidate.value) !== null;
    });
    if (!action) {
      return json({ ok: true });
    }

    const parsedValue = typeof action.value === "string" ? parseSlackSuggestedActionButtonValue(action.value) : null;
    const rawText =
      parsedValue?.command ??
      (typeof action.value === "string" && parseThreadActionCommand(action.value) ? action.value.trim() : undefined);
    if (!rawText || !parseThreadActionCommand(rawText)) {
      return json({ error: "invalid_interactive_action" }, 400);
    }
    if (!input.submitThreadAction) {
      return json({ ok: true });
    }

    const teamId = payload.team?.id;
    const userId = payload.user?.id;
    const channelId = payload.channel?.id ?? payload.container?.channel_id;
    const messageTs = payload.message?.ts ?? payload.container?.message_ts;
    const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts ?? messageTs;
    if (!teamId || !userId || !channelId || !messageTs || !threadTs) {
      return json({ error: "invalid_interactive_payload" }, 400);
    }

    const binding = await input.resolveChannelBinding({
      teamId,
      channelId
    });
    if (!binding) {
      return json({ ok: true, ignored: "unbound_channel" });
    }

    await input.submitThreadAction({
      id: `approval_slack_block_${payload.trigger_id ?? `${action.action_id ?? "action"}_${action.action_ts ?? messageTs}`}`,
      rawText,
      actor: {
        provider: "slack",
        providerUserId: userId,
        handle: payload.user?.username ?? payload.user?.name ?? userId,
        organizationId: teamId
      },
      callback: {
        provider: "slack",
        uri: slackApp.callbackUri ?? "https://slack.com/api/chat.postMessage",
        threadKey: encodeSlackThreadKey({
          teamId,
          channelId,
          threadTs
        })
      },
      metadata: {
        source: "slack_button",
        teamId,
        channelId,
        messageTs,
        ...(payload.api_app_id ? { slackAppId: payload.api_app_id } : {}),
        ...(action.action_id ? { actionId: action.action_id } : {}),
        ...(action.block_id ? { blockId: action.block_id } : {}),
        ...(action.action_ts ? { actionTs: action.action_ts } : {}),
        ...(parsedValue ? { proposalId: parsedValue.proposalId, intentId: parsedValue.intentId } : {}),
        ...(parsedValue?.permissionDecision ? { permissionDecision: parsedValue.permissionDecision } : {}),
        ...(parsedValue?.proposalHash ? { proposalHash: parsedValue.proposalHash } : {}),
        ...(parsedValue?.approvalEpoch ? { approvalEpoch: parsedValue.approvalEpoch } : {}),
        ...(parsedValue?.actionId ? { governedActionId: parsedValue.actionId } : {}),
        ...repositoryMetadataFromBinding(binding)
      }
    });
    return json({ ok: true });
  }

  return {
    async process(
      payload: SlackIngressPayload,
      slackApp: SlackAppRuntimeConfig,
      verification: SlackIngressVerification = {}
    ): Promise<SlackEventProcessorResult> {
      if (payload.type === "block_actions") {
        return processBlockActions(payload, slackApp);
      }
      if (payload.type === "url_verification") {
        return text(payload.challenge ?? "");
      }
      if (payload.type !== "event_callback" || !payload.event || !["app_mention", "message"].includes(payload.event.type)) {
        return json({ ok: true });
      }
      if (payload.event.type === "message" && (payload.event.subtype || payload.event.bot_id)) {
        return json({ ok: true });
      }
      if (!isWellFormedSlackEventPayload(payload)) {
        return json({ error: "invalid_event_payload" }, 400);
      }
      const rawThreadActionText =
        payload.event.type === "app_mention"
          ? stripSlackAppMention(payload.event.text, payload.authorizations?.[0]?.user_id)
          : payload.event.text.trim();
      const bindRequest = payload.event.type === "app_mention" ? parseBindCommand(rawThreadActionText) : null;
      if (bindRequest) {
        const threadTs = payload.event.thread_ts ?? payload.event.ts;
        if (!input.reply) {
          return json({ ok: true, ignored: "self_service_reply_unavailable", command: "bind" });
        }
        if (!input.bindChannel) {
          await input.reply({
            channelId: payload.event.channel,
            threadTs,
            text: "Slack channel binding from source threads is not configured. Re-run `opentag setup` or update local OpenTag channel bindings."
          });
          return json({ ok: true, selfService: "bind", unavailable: true });
        }
        if (!bindRequest.ok) {
          await input.reply({
            channelId: payload.event.channel,
            threadTs,
            text: BIND_USAGE
          });
          return json({ ok: true, selfService: "bind", usage: true });
        }
        const authorized = await canManageSlackBinding(input, {
          action: "bind",
          teamId: payload.team_id,
          channelId: payload.event.channel,
          threadTs,
          userId: payload.event.user,
          eventId: payload.event_id,
          ...(payload.api_app_id ? { appId: payload.api_app_id } : {})
        });
        if (!authorized) {
          await input.reply({
            channelId: payload.event.channel,
            threadTs,
            text: BINDING_AUTH_DENIED_TEXT
          });
          return json({ ok: true, selfService: "bind", unauthorized: true });
        }
        await input.bindChannel({
          teamId: payload.team_id,
          channelId: payload.event.channel,
          repoProvider: bindRequest.repoProvider,
          owner: bindRequest.owner,
          repo: bindRequest.repo
        });
        await input.reply({
          channelId: payload.event.channel,
          threadTs,
          text: `Connected this Slack channel to Project Target ${bindRequest.repoProvider}:${bindRequest.owner}/${bindRequest.repo}. @mention the app with a task to start a run.`
        });
        return json({ ok: true, selfService: "bind" });
      }
      const unbindRequest = payload.event.type === "app_mention" ? parseUnbindCommand(rawThreadActionText) : null;
      if (unbindRequest) {
        const threadTs = payload.event.thread_ts ?? payload.event.ts;
        if (!input.reply) {
          return json({ ok: true, ignored: "self_service_reply_unavailable", command: "unbind" });
        }
        if (!input.unbindChannel) {
          await input.reply({
            channelId: payload.event.channel,
            threadTs,
            text: "Slack channel unbinding is not enabled in this build. Re-run `opentag setup` or update local OpenTag channel bindings."
          });
          return json({ ok: true, selfService: "unbind", unavailable: true });
        }
        if (!unbindRequest.ok) {
          await input.reply({
            channelId: payload.event.channel,
            threadTs,
            text: UNBIND_USAGE
          });
          return json({ ok: true, selfService: "unbind", usage: true });
        }
        const authorized = await canManageSlackBinding(input, {
          action: "unbind",
          teamId: payload.team_id,
          channelId: payload.event.channel,
          threadTs,
          userId: payload.event.user,
          eventId: payload.event_id,
          ...(payload.api_app_id ? { appId: payload.api_app_id } : {})
        });
        if (!authorized) {
          await input.reply({
            channelId: payload.event.channel,
            threadTs,
            text: BINDING_AUTH_DENIED_TEXT
          });
          return json({ ok: true, selfService: "unbind", unauthorized: true });
        }
        const binding = await input.resolveChannelBinding({
          teamId: payload.team_id,
          channelId: payload.event.channel
        });
        if (!binding) {
          await input.reply({
            channelId: payload.event.channel,
            threadTs,
            text: UNBOUND_HINT
          });
          return json({ ok: true, selfService: "unbind", ignored: "unbound_channel" });
        }
        await input.unbindChannel({
          teamId: payload.team_id,
          channelId: payload.event.channel
        });
        await input.reply({
          channelId: payload.event.channel,
          threadTs,
          text: `Disconnected this Slack channel from Project Target ${formatProjectTarget(binding)}. Re-run \`opentag setup\` or update local OpenTag channel bindings to connect a new target.`
        });
        return json({ ok: true, selfService: "unbind" });
      }
      const stopRequest = payload.event.type === "app_mention" ? parseStopCommand(rawThreadActionText) : null;
      if (stopRequest) {
        const threadTs = payload.event.thread_ts ?? payload.event.ts;
        if (!input.stopRun) {
          if (input.reply) {
            await input.reply({
              channelId: payload.event.channel,
              threadTs,
              text: STOP_UNAVAILABLE_TEXT
            });
          }
          return json({ ok: true, selfService: "stop", unavailable: true });
        }
        const result = await input.stopRun({
          teamId: payload.team_id,
          channelId: payload.event.channel,
          ...(stopRequest.runId ? { runId: stopRequest.runId } : {}),
          requestedBy: `slack:${payload.event.user}`
        });
        if (input.reply) {
          await input.reply({
            channelId: payload.event.channel,
            threadTs,
            text: formatStopResultText(result)
          });
        }
        return json({ ok: true, selfService: "stop", outcome: result.outcome, ...(result.runId ? { runId: result.runId } : {}) });
      }
      const linearRequest = payload.event.type === "app_mention" ? parseLinearCommand(rawThreadActionText) : null;
      if (linearRequest) {
        const threadTs = payload.event.thread_ts ?? payload.event.ts;
        if (!input.reply) {
          return json({ ok: true, ignored: "self_service_reply_unavailable", command: "linear" });
        }
        if (!linearRequest.ok) {
          await input.reply({ channelId: payload.event.channel, threadTs, text: LINEAR_USAGE });
          return json({ ok: true, selfService: "linear", usage: true });
        }
        if (!input.linear) {
          await input.reply({ channelId: payload.event.channel, threadTs, text: LINEAR_UNAVAILABLE_TEXT });
          return json({ ok: true, selfService: "linear", unavailable: true });
        }
        // /linear authorization and project routing are enforced by the injected handler before credentials or APIs are used; repository binding is intentionally not its authorization source.
        const reply = normalizeSelfServiceReply(
          await input.linear({
            teamId: payload.team_id,
            channelId: payload.event.channel,
            threadTs,
            userId: payload.event.user,
            binding: null
          })
        );
        await input.reply({
          channelId: payload.event.channel,
          threadTs,
          text: reply.text,
          ...(reply.textFormat ? { textFormat: reply.textFormat } : {}),
          ...(reply.blocks?.length ? { blocks: reply.blocks } : {})
        });
        return json({ ok: true, selfService: "linear" });
      }
      const selfServiceCommand = payload.event.type === "app_mention" ? parseSelfServiceCommand(rawThreadActionText) : null;
      if (selfServiceCommand) {
        const binding =
          selfServiceCommand === "help"
            ? null
            : await input.resolveChannelBinding({
                teamId: payload.team_id,
                channelId: payload.event.channel
              });
        const threadTs = payload.event.thread_ts ?? payload.event.ts;
        if (!input.reply) {
          return json({ ok: true, ignored: "self_service_reply_unavailable", command: selfServiceCommand });
        }
        const context: SlackSelfServiceContext = {
          teamId: payload.team_id,
          channelId: payload.event.channel,
          threadTs,
          userId: payload.event.user,
          binding
        };
        const reply =
          selfServiceCommand === "help"
            ? { text: HELP_TEXT }
            : normalizeSelfServiceReply(
                selfServiceCommand === "status"
                  ? input.status
                    ? await input.status(context)
                    : statusReply(context)
                  : input.doctor
                    ? await input.doctor(context)
                    : doctorReply(context)
              );
        await input.reply({
          channelId: payload.event.channel,
          threadTs,
          text: reply.text,
          ...(reply.blocks?.length ? { blocks: reply.blocks } : {})
        });
        return json({ ok: true, selfService: selfServiceCommand });
      }
      if (payload.event.type === "message" && (!rawThreadActionText || !parseThreadActionCommand(rawThreadActionText))) {
        return json({ ok: true });
      }

      const binding = await input.resolveChannelBinding({
        teamId: payload.team_id,
        channelId: payload.event.channel
      });
      if (!binding) {
        return json({ ok: true, ignored: "unbound_channel" });
      }

      if (rawThreadActionText && parseThreadActionCommand(rawThreadActionText) && input.submitThreadAction) {
        await input.submitThreadAction({
          id: `approval_slack_${payload.event_id}`,
          rawText: rawThreadActionText,
          actor: {
            provider: "slack",
            providerUserId: payload.event.user,
            handle: payload.event.user,
            organizationId: payload.team_id
          },
          callback: {
            provider: "slack",
            uri: slackApp.callbackUri ?? "https://slack.com/api/chat.postMessage",
            threadKey: encodeSlackThreadKey({
              teamId: payload.team_id,
              channelId: payload.event.channel,
              threadTs: payload.event.thread_ts ?? payload.event.ts
            })
          },
          metadata: {
            teamId: payload.team_id,
            channelId: payload.event.channel,
            messageTs: payload.event.ts,
            sourceDeliveryId: payload.event_id,
            slackEventId: payload.event_id,
            ...(payload.api_app_id ? { slackAppId: payload.api_app_id } : {}),
            ...(payload.authorizations?.[0]?.user_id ? { slackBotUserId: payload.authorizations[0].user_id } : {}),
            ...(typeof verification.signatureVerified === "boolean"
              ? { webhookSignatureVerified: verification.signatureVerified, signatureState: verification.signatureVerified ? "verified" : "unverified" }
              : {}),
            ...repositoryMetadataFromBinding(binding)
          }
        });
        return json({ ok: true });
      }

      if (payload.event.type !== "app_mention") {
        return json({ ok: true });
      }

      const event = normalizeSlackAppMention({
        teamId: payload.team_id,
        channelId: payload.event.channel,
        userId: payload.event.user,
        text: payload.event.text,
        ts: payload.event.ts,
        eventId: payload.event_id,
        eventTime: payload.event_time ?? Math.floor(Date.parse(input.now()) / 1000),
        agentId: slackApp.agentId,
        binding,
        ...(payload.api_app_id ? { appId: payload.api_app_id } : {}),
        ...(payload.event.thread_ts ? { threadTs: payload.event.thread_ts } : {}),
        ...(payload.authorizations?.[0]?.user_id ? { botUserId: payload.authorizations[0].user_id } : {}),
        ...(slackApp.callbackUri ? { callbackUri: slackApp.callbackUri } : {}),
        ...(typeof verification.signatureVerified === "boolean" ? { signatureVerified: verification.signatureVerified } : {})
      });
      if (!event) {
        return json({ ok: true, ignored: "empty_command" });
      }

      await input.createRun(event);
      return json({ ok: true });
    }
  };
}
