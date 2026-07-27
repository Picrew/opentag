import { randomUUID } from "node:crypto";
import { createOpenTagClient, type ChannelRuntimeStatus } from "@opentag/client";
import { createDoctorSummaryPresentation, createSourceThreadStatusPresentation, renderOpenTagPresentationPlainText } from "@opentag/core";
import type { SlackEventProcessorInput, SlackSelfServiceReply, SlackStopRunResult } from "./events.js";
import { createSlackDoctorSummaryBlocks, createSlackPostMessagePayload, createSlackSourceThreadStatusBlocks } from "./render.js";

export type SlackChannelPrincipalConfig =
  | { appId: string; channelPrincipalCredential: string }
  | { appId?: never; channelPrincipalCredential?: never };

export type SlackDispatcherEventConfig = {
  dispatcherUrl: string;
  dispatcherToken?: string;
  botToken?: string;
  callbackUri?: string;
  bindingAdminUserIds?: string[];
  runTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  linear?: SlackEventProcessorInput["linear"];
} & SlackChannelPrincipalConfig;

function assertSlackChannelPrincipalConfig(config: {
  appId?: string;
  channelPrincipalCredential?: string;
}): void {
  if (Boolean(config.appId) !== Boolean(config.channelPrincipalCredential)) {
    throw new Error("Slack appId and channelPrincipalCredential must be configured together.");
  }
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

function slackRuntimeStatusReply(status: ChannelRuntimeStatus, input: { runTimeoutMs?: number } = {}): SlackSelfServiceReply {
  const presentation = createSourceThreadStatusPresentation({
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
      ? "wait for the final reply, send a follow-up to queue more context, or use `opentag status --run <run_id>` locally."
      : "@mention the app with a task to start a run.",
    stopHint: `cancellation is explicit and is not reported as successful completion; timeout policy: ${runTimeoutPolicy({ ...input, status })}.`,
    detailHint: "use `opentag status --run <run_id>` locally for audit events and executor detail."
  });
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    blocks: createSlackSourceThreadStatusBlocks(presentation)
  };
}

function slackRuntimeDoctorReply(input: { teamId: string; channelId: string; status: ChannelRuntimeStatus; runTimeoutMs?: number }): SlackSelfServiceReply {
  const presentation = createDoctorSummaryPresentation({
    title: "OpenTag doctor (redacted):",
    checks: [
      { status: "ok", name: "Source container", message: `slack:${input.teamId}/${input.channelId}` },
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
        message: "source-container status is reachable; run `opentag service status` locally to confirm controller, connector, executor, and heartbeat health."
      },
      { status: "ok", name: "Secrets", message: "redacted. Use env/file/keychain SecretRef config and never paste tokens into Slack." }
    ]
  });
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    blocks: createSlackDoctorSummaryBlocks(presentation)
  };
}

function statusUnavailable(input: { binding?: { repoProvider?: string; owner?: string; repo?: string }; error: unknown }): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return [
    "OpenTag status:",
    input.binding ? `Project Target: ${formatProjectTarget(input.binding)}` : "Project Target: not bound.",
    "Runtime status: unavailable from dispatcher.",
    `Reason: ${message}`,
    "Next action: check `opentag service status` and `opentag status` locally."
  ].join("\n");
}

function doctorUnavailable(input: { teamId: string; channelId: string; binding?: { repoProvider?: string; owner?: string; repo?: string }; error: unknown }): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return [
    "OpenTag doctor (redacted):",
    `Source container: slack:${input.teamId}/${input.channelId}`,
    input.binding ? `Project Target: ${formatProjectTarget(input.binding)}` : "Project Target: not bound.",
    "Dispatcher: source-container status unavailable.",
    `Reason: ${message}`,
    "Runtime readiness: run `opentag service status` and `opentag status --channel slack:<team>/<channel>` locally.",
    "Secrets: redacted; do not share local config or app tokens in Slack."
  ].join("\n");
}

function mapStopError(input: { error: unknown; runId?: string }): SlackStopRunResult | null {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (message.includes("run_already_terminal")) {
    return { outcome: "already_terminal", runId: input.runId ?? "active run" };
  }
  if (message.includes("run_not_found") || message.includes("active_run_not_found") || message.includes("channel_binding_not_found")) {
    return input.runId ? { outcome: "not_found", runId: input.runId } : { outcome: "not_found" };
  }
  return null;
}

export function createSlackDispatcherEventProcessorInput(config: SlackDispatcherEventConfig): SlackEventProcessorInput {
  assertSlackChannelPrincipalConfig(config);
  const fetchImpl = config.fetchImpl ?? fetch;
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {}),
    ...(config.channelPrincipalCredential ? { channelPrincipalCredential: config.channelPrincipalCredential } : {}),
    fetchImpl
  });

  const processorInput: SlackEventProcessorInput = {
    async resolveChannelBinding(input) {
      try {
        const { binding } = await dispatcherClient.getChannelBinding({
          provider: "slack",
          accountId: input.teamId,
          conversationId: input.channelId
        });
        return {
          teamId: binding.accountId,
          channelId: binding.conversationId,
          ...(binding.owner?.trim() && binding.repo?.trim()
            ? {
                repoProvider: binding.repoProvider?.trim() || "github",
                owner: binding.owner.trim(),
                repo: binding.repo.trim()
              }
            : {})
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes("channel_binding_not_found")) {
          return null;
        }
        throw error;
      }
    },
    async createRun(event) {
      const runId = `run_${randomUUID()}`;
      const created = await dispatcherClient.createRun({ runId, event });
      return created.outcome === "run_created" ? { runId: created.run.id } : { runId };
    },
    async bindChannel(input) {
      await dispatcherClient.bindChannel({
        provider: "slack",
        accountId: input.teamId,
        conversationId: input.channelId,
        repoProvider: input.repoProvider,
        owner: input.owner,
        repo: input.repo,
        ...(config.appId
          ? { ownership: { mode: "managed" as const, exclusive: true as const, applicationId: config.appId } }
          : {})
      });
    },
    async submitThreadAction(action) {
      await dispatcherClient.submitThreadAction(action);
    },
    async unbindChannel(input) {
      await dispatcherClient.unbindChannel({
        provider: "slack",
        accountId: input.teamId,
        conversationId: input.channelId
      });
    },
    canManageBinding(input) {
      return Boolean(config.bindingAdminUserIds?.includes(input.userId));
    },
    async stopRun(input) {
      try {
        const result = input.runId
          ? await dispatcherClient.cancelRun({
              runId: input.runId,
              reason: "Stop requested from Slack.",
              requestedBy: input.requestedBy
            })
          : await dispatcherClient.cancelActiveChannelRun({
              provider: "slack",
              accountId: input.teamId,
              conversationId: input.channelId,
              reason: "Stop requested from Slack.",
              requestedBy: input.requestedBy
            });
        return { outcome: "cancelled", runId: result.run.id };
      } catch (error) {
        const mapped = mapStopError({ error, ...(input.runId ? { runId: input.runId } : {}) });
        if (mapped) return mapped;
        throw error;
      }
    },
    async status(input) {
      if (!input.binding) return statusUnavailable({ error: "channel not bound" });
      try {
        return slackRuntimeStatusReply(
          await dispatcherClient.getChannelRuntimeStatus({
            provider: "slack",
            accountId: input.teamId,
            conversationId: input.channelId
          }),
          { ...(config.runTimeoutMs ? { runTimeoutMs: config.runTimeoutMs } : {}) }
        );
      } catch (error) {
        return statusUnavailable({ binding: input.binding, error });
      }
    },
    async doctor(input) {
      if (!input.binding) {
        return doctorUnavailable({ teamId: input.teamId, channelId: input.channelId, error: "channel not bound" });
      }
      try {
        return slackRuntimeDoctorReply({
          teamId: input.teamId,
          channelId: input.channelId,
          status: await dispatcherClient.getChannelRuntimeStatus({
            provider: "slack",
            accountId: input.teamId,
            conversationId: input.channelId
          }),
          ...(config.runTimeoutMs ? { runTimeoutMs: config.runTimeoutMs } : {})
        });
      } catch (error) {
        return doctorUnavailable({ teamId: input.teamId, channelId: input.channelId, binding: input.binding, error });
      }
    },
    ...(config.linear ? { linear: config.linear } : {}),
    now: () => new Date().toISOString()
  };
  if (config.botToken) {
    processorInput.reply = async (input) => {
      const response = await fetchImpl(config.callbackUri ?? "https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.botToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createSlackPostMessagePayload({
            channelId: input.channelId,
            threadTs: input.threadTs,
            text: input.text,
            ...(input.textFormat ? { textFormat: input.textFormat } : {}),
            ...(input.blocks?.length ? { blocks: input.blocks } : {})
          })
        )
      });
      if (!response.ok) {
        throw new Error(`deliver Slack self-service reply failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (body.ok === false) {
        throw new Error(`deliver Slack self-service reply failed: ${body.error ?? "unknown_error"}`);
      }
    };
  }
  return processorInput;
}
