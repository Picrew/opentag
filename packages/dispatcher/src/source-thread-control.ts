import { createHash } from "node:crypto";
import {
  conversationKeysFromCallback,
  conversationKeysFromEvent,
  createDoctorSummaryPresentation,
  createSourceThreadStatusPresentation,
  formatProjectTargetRef,
  projectTargetRefFromEvent,
  type ActorIdentity,
  type FollowUpRequest,
  type HumanEscalation,
  type OpenTagEvent,
  type OpenTagRun,
  type ProjectTargetRef,
  type ThreadControlCommand
} from "@opentag/core";
import type { SlackBlock } from "@opentag/slack";
import type { createOpenTagRepository } from "@opentag/store";
import type { CallbackPresentation } from "./presentation.js";

type OpenTagRepository = ReturnType<typeof createOpenTagRepository>;

type SourceThreadControlCallbackMessage = {
  runId: string;
  kind: "acknowledgement" | "progress" | "final";
  provider: string;
  uri: string;
  body: string;
  threadKey?: string;
  blocks?: SlackBlock[];
  rich?: {
    provider: string;
    payload: unknown;
  };
};

export type SourceThreadControlActionRequest = {
  id?: string | undefined;
  rawText: string;
  actor: ActorIdentity;
  callback: {
    provider: string;
    uri: string;
    threadKey?: string | undefined;
  };
  metadata?: Record<string, unknown> | undefined;
};

type SourceThreadRuntimeState = {
  conversationKeys: string[];
  sourceThread: string;
  projectTarget?: ProjectTargetRef;
  bindingState: "bound" | "unbound";
  active?: { run: OpenTagRun; event: OpenTagEvent };
  queuedFollowUps: FollowUpRequest[];
  runTimeoutMs?: number;
};

type RecordControlPlaneEvent = (input: {
  type: string;
  severity?: "info" | "warn" | "error" | undefined;
  subject?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
}) => Promise<void>;

type SourceThreadControlOptions = {
  repo: OpenTagRepository;
  presentation: CallbackPresentation;
  conversationKeysFromThreadAction(input: {
    callback: { provider: string; uri: string; threadKey?: string | undefined };
    metadata?: Record<string, unknown> | undefined;
  }): string[];
  latestRunTimeoutMs(events: Array<{ type: string; payload: unknown }>): number | undefined;
  deliverAuditedMessage(message: SourceThreadControlCallbackMessage): Promise<unknown>;
  deliverDirectMessage(message: SourceThreadControlCallbackMessage): Promise<unknown>;
  recordControlPlaneEvent: RecordControlPlaneEvent;
  onHumanEscalationChanged?(escalation: HumanEscalation): Promise<void>;
  now?: () => string;
};

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ownerRepoFromProjectPath(pathWithNamespace: string | undefined): { owner: string; repo: string } | undefined {
  if (!pathWithNamespace) return undefined;
  const lastSlash = pathWithNamespace.lastIndexOf("/");
  if (lastSlash === -1) return undefined;
  return {
    owner: pathWithNamespace.substring(0, lastSlash),
    repo: pathWithNamespace.substring(lastSlash + 1)
  };
}

function projectTargetFromThreadAction(input: {
  callback: { provider: string };
  metadata?: Record<string, unknown> | undefined;
}): ProjectTargetRef | undefined {
  const repoProvider = metadataString(input.metadata, "repoProvider") ?? input.callback.provider;
  const explicitOwner = metadataString(input.metadata, "owner");
  const explicitRepo = metadataString(input.metadata, "repo");
  if (explicitOwner && explicitRepo) {
    return { provider: repoProvider, owner: explicitOwner, repo: explicitRepo };
  }

  const gitlabPath = metadataString(input.metadata, "projectPathWithNamespace");
  const gitlabOwnerRepo = repoProvider === "gitlab" ? ownerRepoFromProjectPath(gitlabPath) : undefined;
  return gitlabOwnerRepo ? { provider: repoProvider, ...gitlabOwnerRepo } : undefined;
}

function sourceThreadLabel(input: { callback: { provider: string; uri: string; threadKey?: string | undefined } }): string {
  return `${input.callback.provider}:${input.callback.threadKey ?? input.callback.uri}`;
}

function queuedFollowUpsForPresentation(followUps: FollowUpRequest[]) {
  return followUps.slice(0, 3).map((followUp) => ({
    id: followUp.id,
    status: followUp.status,
    command: followUp.event.command.rawText
  }));
}

function queuedFollowUpsSummary(followUps: FollowUpRequest[]): string {
  if (followUps.length === 0) return "none.";
  const visible = followUps.slice(0, 3).map((followUp) => followUp.id);
  const suffix = followUps.length > visible.length ? `, +${followUps.length - visible.length} more` : "";
  return `${followUps.length} (${visible.join(", ")}${suffix}).`;
}

function formatDurationMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute(s)`;
  if (ms % 1_000 === 0) return `${ms / 1_000} second(s)`;
  return `${ms}ms`;
}

function runTimeoutPolicyText(runTimeoutMs: number | undefined): string {
  return runTimeoutMs ? `hard timeout after ${formatDurationMs(runTimeoutMs)}` : "disabled or not recorded";
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

export function createSourceThreadControlHandler(options: SourceThreadControlOptions) {
  async function sourceThreadRuntimeState(request: SourceThreadControlActionRequest): Promise<SourceThreadRuntimeState> {
    const conversationKeys = options.conversationKeysFromThreadAction({
      callback: request.callback,
      ...(request.metadata ? { metadata: request.metadata } : {})
    });
    const active = await options.repo.findCancelableRunForConversation({ conversationKeys });
    const metadataProjectTarget = projectTargetFromThreadAction({
      callback: request.callback,
      ...(request.metadata ? { metadata: request.metadata } : {})
    });
    const activeProjectTarget = active ? projectTargetRefFromEvent(active.event) : undefined;
    const projectTarget = metadataProjectTarget ?? activeProjectTarget ?? undefined;
    const repoBinding = projectTarget ? await options.repo.getRepoBinding(projectTarget) : null;
    const queuedFollowUps = active ? await options.repo.listQueuedFollowUpsForActiveRun({ activeRunId: active.run.id }) : [];
    const runTimeoutMs = active ? options.latestRunTimeoutMs(await options.repo.listRunEvents({ runId: active.run.id })) : undefined;
    return {
      conversationKeys,
      sourceThread: sourceThreadLabel({ callback: request.callback }),
      ...(projectTarget ? { projectTarget } : {}),
      bindingState: repoBinding ? "bound" : "unbound",
      ...(active ? { active } : {}),
      queuedFollowUps,
      ...(runTimeoutMs ? { runTimeoutMs } : {})
    };
  }

  async function deliverThreadControlReply(input: {
    request: SourceThreadControlActionRequest;
    command: ThreadControlCommand;
    body: string;
    auditRunId?: string;
    blocks?: SlackBlock[];
    rich?: SourceThreadControlCallbackMessage["rich"];
  }): Promise<void> {
    const runId =
      input.auditRunId ??
      `control_${stableHash(JSON.stringify([input.request.callback.provider, input.request.callback.threadKey ?? input.request.callback.uri, input.command.rawText]))}`;
    const message: SourceThreadControlCallbackMessage = {
      runId,
      kind: "final",
      provider: input.request.callback.provider,
      uri: input.request.callback.uri,
      body: input.body,
      ...(input.request.callback.threadKey ? { threadKey: input.request.callback.threadKey } : {}),
      ...(input.blocks?.length ? { blocks: input.blocks } : {}),
      ...(input.rich ? { rich: input.rich } : {})
    };
    if (input.auditRunId) {
      await options.deliverAuditedMessage(message);
      return;
    }

    await options.deliverDirectMessage(message);
    await options.recordControlPlaneEvent({
      type: "source_thread_control.replied",
      severity: "info",
      subject: sourceThreadLabel({ callback: input.request.callback }),
      payload: {
        provider: input.request.callback.provider,
        command: input.command.verb,
        callback: {
          uri: input.request.callback.uri,
          ...(input.request.callback.threadKey ? { threadKey: input.request.callback.threadKey } : {})
        },
        auditedOnRun: null
      }
    });
  }

  async function deliverThreadControlPresentation(input: {
    request: SourceThreadControlActionRequest;
    command: ThreadControlCommand;
    presentation: ReturnType<typeof createSourceThreadStatusPresentation> | ReturnType<typeof createDoctorSummaryPresentation>;
    auditRunId?: string;
  }): Promise<void> {
    const rendered = options.presentation.render({
      provider: input.request.callback.provider,
      presentation: input.presentation
    });
    await deliverThreadControlReply({
      request: input.request,
      command: input.command,
      body: rendered.body,
      ...(input.auditRunId ? { auditRunId: input.auditRunId } : {}),
      ...(rendered.blocks?.length ? { blocks: rendered.blocks } : {}),
      ...(rendered.rich ? { rich: rendered.rich } : {})
    });
  }

  async function handleStatus(input: {
    request: SourceThreadControlActionRequest;
    command: ThreadControlCommand;
  }): Promise<Response> {
    const runtime = await sourceThreadRuntimeState(input.request);
    const activeRun = runtime.active?.run;
    const presentationBody = createSourceThreadStatusPresentation({
      title: "OpenTag status:",
      sourceContainer: runtime.sourceThread,
      ...(runtime.projectTarget ? { projectTarget: formatProjectTargetRef(runtime.projectTarget) } : {}),
      bindingState: runtime.bindingState,
      ...(activeRun
        ? {
            activeRun: {
              id: activeRun.id,
              status: activeRun.status,
              updatedAt: activeRun.updatedAt
            }
          }
        : {}),
      ...(runtime.active?.event.command.rawText ? { currentCommand: runtime.active.event.command.rawText } : {}),
      queuedFollowUps: queuedFollowUpsForPresentation(runtime.queuedFollowUps),
      queuedFollowUpsTotal: runtime.queuedFollowUps.length,
      nextAction: activeRun
        ? "wait for the final reply, send a follow-up to queue more context, or use `/stop` to request cancellation."
        : runtime.bindingState === "bound"
          ? "mention OpenTag with a task to start a run in this source thread."
          : "bind the Project Target locally before starting runs from this source thread.",
      stopHint: `cancellation is explicit and is not reported as successful completion; timeout policy: ${runTimeoutPolicyText(runtime.runTimeoutMs)}.`,
      detailHint: activeRun
        ? `use \`opentag status --run ${activeRun.id}\` locally for audit events and executor detail.`
        : "no active run is currently available for local run-level audit."
    });
    await deliverThreadControlPresentation({
      request: input.request,
      command: input.command,
      presentation: presentationBody,
      ...(activeRun ? { auditRunId: activeRun.id } : {})
    });
    return jsonResponse({
      outcome: "status",
      sourceThread: runtime.sourceThread,
      bindingState: runtime.bindingState,
      ...(runtime.projectTarget ? { projectTarget: runtime.projectTarget } : {}),
      ...(activeRun ? { activeRun } : {}),
      queuedFollowUps: runtime.queuedFollowUps,
      ...(runtime.runTimeoutMs ? { runTimeoutPolicy: { hardTimeoutMs: runtime.runTimeoutMs } } : {})
    });
  }

  async function handleDoctor(input: {
    request: SourceThreadControlActionRequest;
    command: ThreadControlCommand;
  }): Promise<Response> {
    const runtime = await sourceThreadRuntimeState(input.request);
    const activeRun = runtime.active?.run;
    const presentationBody = createDoctorSummaryPresentation({
      title: "OpenTag doctor (redacted):",
      checks: [
        { status: "ok", name: "Source thread", message: runtime.sourceThread },
        {
          status: runtime.projectTarget ? "ok" : "warn",
          name: "Project Target",
          message: runtime.projectTarget ? formatProjectTargetRef(runtime.projectTarget) : "not available from this thread metadata."
        },
        {
          status: runtime.bindingState === "bound" ? "ok" : "warn",
          name: "Repository binding",
          message: runtime.bindingState === "bound" ? "configured." : "not found locally; runs from this thread may need setup."
        },
        {
          status: "ok",
          name: "Active run",
          message: activeRun ? `${activeRun.id} (${activeRun.status}), updated ${activeRun.updatedAt}.` : "none."
        },
        { status: "ok", name: "Queued follow-ups", message: queuedFollowUpsSummary(runtime.queuedFollowUps) },
        { status: "ok", name: "Timeout policy", message: runTimeoutPolicyText(runtime.runTimeoutMs) },
        {
          status: "ok",
          name: "Runtime readiness",
          message: "source-thread control is reachable; run `opentag service status` locally for controller, connector, executor, and heartbeat health."
        },
        { status: "ok", name: "Secrets", message: "redacted. Keep provider tokens and local paths out of source threads." }
      ]
    });
    await deliverThreadControlPresentation({
      request: input.request,
      command: input.command,
      presentation: presentationBody,
      ...(activeRun ? { auditRunId: activeRun.id } : {})
    });
    return jsonResponse({
      outcome: "doctor",
      sourceThread: runtime.sourceThread,
      bindingState: runtime.bindingState,
      ...(runtime.projectTarget ? { projectTarget: runtime.projectTarget } : {}),
      ...(activeRun ? { activeRun } : {}),
      queuedFollowUps: runtime.queuedFollowUps
    });
  }

  function stopResultBody(input: {
    outcome: "cancelled" | "already_terminal" | "not_found";
    runId?: string;
  }): string {
    if (input.outcome === "cancelled") {
      return [
        `Cancellation requested for run ${input.runId}.`,
        "- OpenTag will not treat this stop request as a successful completion.",
        "- The local executor may need a moment to observe the cancellation; further nonessential completion writes are suppressed."
      ].join("\n");
    }
    if (input.outcome === "already_terminal") {
      return `Run ${input.runId} is already finished. OpenTag will not change its final result.`;
    }
    return input.runId
      ? `Run ${input.runId} was not found in this source thread or is no longer cancelable.`
      : "No active run was found for this source thread.";
  }

  async function handleStop(input: {
    request: SourceThreadControlActionRequest;
    command: ThreadControlCommand;
  }): Promise<Response> {
    const runtime = await sourceThreadRuntimeState(input.request);
    const target = input.command.runId
      ? await options.repo.getRun({ runId: input.command.runId })
      : runtime.active ?? null;
    const belongsToThread = target
      ? conversationKeysFromEvent(target.event).some((key) => runtime.conversationKeys.includes(key))
      : false;
    if (!target || !belongsToThread) {
      await deliverThreadControlReply({
        request: input.request,
        command: input.command,
        body: stopResultBody({ outcome: "not_found", ...(input.command.runId ? { runId: input.command.runId } : {}) })
      });
      return jsonResponse({
        outcome: "not_found",
        ...(input.command.runId ? { runId: input.command.runId } : {})
      });
    }

    const outcome = await options.repo.cancelRun({
      runId: target.run.id,
      reason: `Stop requested from ${sourceThreadLabel({ callback: input.request.callback })}.`,
      requestedBy: `${input.request.actor.provider}:${input.request.actor.providerUserId}`
    });
    if (outcome.outcome === "already_terminal") {
      await deliverThreadControlReply({
        request: input.request,
        command: input.command,
        body: stopResultBody({ outcome: "already_terminal", runId: outcome.run.id }),
        auditRunId: outcome.run.id
      });
      return jsonResponse({ outcome: "already_terminal", run: outcome.run });
    }
    if (outcome.outcome === "not_found") {
      await deliverThreadControlReply({
        request: input.request,
        command: input.command,
        body: stopResultBody({ outcome: "not_found", runId: target.run.id })
      });
      return jsonResponse({ outcome: "not_found", runId: target.run.id });
    }

    await deliverThreadControlReply({
      request: input.request,
      command: input.command,
      body: stopResultBody({ outcome: "cancelled", runId: outcome.run.id }),
      auditRunId: outcome.run.id
    });
    return jsonResponse({ outcome: "cancelled", run: outcome.run });
  }

  async function handleHumanEscalation(input: {
    request: SourceThreadControlActionRequest;
    command: ThreadControlCommand;
  }): Promise<Response> {
    const escalationId = input.command.escalationId;
    if (!escalationId) return jsonResponse({ outcome: "invalid", reason: "escalation_id_required" });
    const runtime = await sourceThreadRuntimeState(input.request);
    const escalation = await options.repo.getHumanEscalation({ id: escalationId });
    const target = escalation?.runId ? await options.repo.getRun({ runId: escalation.runId }) : null;
    const workThread = escalation && !target
      ? await options.repo.getWorkThread({ workThreadId: escalation.workThreadId })
      : null;
    const workThreadAnchors = workThread
      ? [workThread.primaryAnchor, ...(workThread.secondaryAnchors ?? [])]
      : [];
    const belongsToThread = target
      ? conversationKeysFromEvent(target.event).some((key) => runtime.conversationKeys.includes(key))
      : workThreadAnchors.some((anchor) => conversationKeysFromCallback({
          provider: anchor.provider,
          uri: anchor.uri,
          ...(anchor.threadKey ? { threadKey: anchor.threadKey } : {})
        }).some((key) => runtime.conversationKeys.includes(key)));
    if (!escalation || !belongsToThread) {
      await deliverThreadControlReply({
        request: input.request,
        command: input.command,
        body: `Human escalation ${escalationId} was not found in this source thread.`
      });
      return jsonResponse({ outcome: "not_found", escalationId });
    }

    try {
      const transitioned = await options.repo.transitionHumanEscalation({
        id: escalation.id,
        toState: input.command.verb === "acknowledge" ? "acknowledged" : "resolved",
        actor: input.request.actor,
        ...(input.command.optionId ? { optionId: input.command.optionId } : {}),
        ...(input.command.reason ? { reason: input.command.reason } : {}),
        at: options.now?.() ?? new Date().toISOString()
      });
      if (transitioned.escalation.state === "expired") {
        await deliverThreadControlReply({
          request: input.request,
          command: input.command,
          body: `Could not update human escalation ${escalation.id}: it expired without implicit approval.`,
          ...(target ? { auditRunId: target.run.id } : {})
        });
        return jsonResponse({ outcome: "conflict", escalation: transitioned.escalation, message: "Human escalation expired." });
      }
      if (transitioned.changed) {
        await options.onHumanEscalationChanged?.(transitioned.escalation);
      }
      const selected = transitioned.escalation.resolution?.optionId;
      const selectedOption = selected
        ? transitioned.escalation.options?.find((option) => option.id === selected)
        : undefined;
      const body = input.command.verb === "acknowledge"
        ? `Acknowledged human escalation ${escalation.id}. It remains blocking until it is resolved or expires.`
        : [
            `Resolved human escalation ${escalation.id}${selectedOption ? ` with ${selectedOption.label}` : ""}.`,
            "The resolution is durably attributed; OpenTag did not inject it into the executor process that already stopped.",
            "Send a new task in this source thread to resume work with the recorded resolution."
          ].join("\n");
      await deliverThreadControlReply({
        request: input.request,
        command: input.command,
        body,
        ...(target ? { auditRunId: target.run.id } : {})
      });
      return jsonResponse({
        outcome: transitioned.changed ? transitioned.escalation.state : "duplicate",
        escalation: transitioned.escalation,
        ...(input.command.verb === "resolve"
          ? { resume: { required: true, nextAction: "Send a new source-thread task to resume work." } }
          : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid human escalation transition.";
      await deliverThreadControlReply({
        request: input.request,
        command: input.command,
        body: `Could not update human escalation ${escalation.id}: ${message}`,
        ...(target ? { auditRunId: target.run.id } : {})
      });
      return jsonResponse({ outcome: "conflict", escalationId: escalation.id, message });
    }
  }

  return {
    handle(input: { request: SourceThreadControlActionRequest; command: ThreadControlCommand }): Promise<Response> {
      if (input.command.verb === "status") return handleStatus(input);
      if (input.command.verb === "doctor") return handleDoctor(input);
      if (input.command.verb === "acknowledge" || input.command.verb === "resolve") return handleHumanEscalation(input);
      return handleStop(input);
    }
  };
}
