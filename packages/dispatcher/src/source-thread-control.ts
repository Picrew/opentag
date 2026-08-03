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
import {
  ChannelBindingCorruptionError,
  ManagedChannelAuthorityError,
  type createOpenTagRepository
} from "@opentag/store";
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
  authorizeHumanEscalationChange?(
    escalation: HumanEscalation,
    channelPrincipal?: { provider: string; applicationId: string; botId?: string }
  ): Promise<{ allowed: boolean; reasonCode?: string }>;
  onHumanEscalationChanged?(
    escalation: HumanEscalation,
    actor: ActorIdentity,
    channelPrincipal?: { provider: string; applicationId: string; botId?: string }
  ): Promise<{
    outcome: "not_configured" | "not_eligible" | "ambiguous" | "created" | "replayed" | "deferred" | "needs_human" | "rejected" | "error";
    reasonCode?: string;
    activeRunId?: string;
    notBefore?: string;
    resumedRunId?: string;
    humanEscalationId?: string;
  } | void>;
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
    channelPrincipal?: { provider: string; applicationId: string; botId?: string };
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

    const authorization = await options.authorizeHumanEscalationChange?.(escalation, input.channelPrincipal);
    if (authorization && !authorization.allowed) {
      const reasonCode = authorization.reasonCode ?? "managed_channel_principal_required";
      await deliverThreadControlReply({
        request: input.request,
        command: input.command,
        body: `Could not update human escalation ${escalation.id}: the owning managed-channel principal is required (${reasonCode}).`,
        ...(target ? { auditRunId: target.run.id } : {})
      });
      return jsonResponse({ outcome: "rejected", escalationId: escalation.id, reasonCode });
    }

    try {
      const transitioned = await options.repo.transitionHumanEscalation({
        id: escalation.id,
        toState: input.command.verb === "acknowledge" ? "acknowledged" : "resolved",
        actor: input.request.actor,
        ...(input.channelPrincipal ? { channelPrincipal: input.channelPrincipal } : {}),
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
      const changeEffect = transitioned.changed
        ? await options.onHumanEscalationChanged?.(
            transitioned.escalation,
            input.request.actor,
            input.channelPrincipal
          )
        : undefined;
      const automaticallyResumed = input.command.verb === "resolve" && Boolean(changeEffect?.resumedRunId);
      const selected = transitioned.escalation.resolution?.optionId;
      const selectedOption = selected
        ? transitioned.escalation.options?.find((option) => option.id === selected)
        : undefined;
      const unresolvedContinuation = changeEffect && !automaticallyResumed
        ? changeEffect.outcome === "deferred"
          ? {
              reason: changeEffect.activeRunId
                ? `Automatic continuation is deferred because Run ${changeEffect.activeRunId} is active.`
                : `Automatic continuation is deferred by its cadence or retry policy${changeEffect.notBefore ? ` until ${changeEffect.notBefore}` : ""}.`,
              nextAction: changeEffect.activeRunId
                ? "Follow the active Run and wait for terminal evidence before resuming."
                : `Wait for the governed continuation window${changeEffect.notBefore ? ` until ${changeEffect.notBefore}` : ""}; do not create a duplicate task.`
            }
          : changeEffect.outcome === "needs_human"
            ? {
                reason: "Automatic continuation requires another governed human decision.",
                nextAction: changeEffect.humanEscalationId
                  ? `Resolve human escalation ${changeEffect.humanEscalationId}.`
                  : "Inspect the WorkThread attention state and resolve the required decision."
              }
            : changeEffect.outcome === "ambiguous"
              ? {
                  reason: `Automatic continuation is ambiguous (${changeEffect.reasonCode ?? "multiple_authorities"}).`,
                  nextAction: "Select or repair the authoritative Workstream; do not create a duplicate task."
                }
              : changeEffect.outcome === "rejected"
                ? {
                    reason: `Automatic continuation was rejected by its authority boundary (${changeEffect.reasonCode ?? "authority_rejected"}).`,
                    nextAction: "Inspect the Workstream recipe, channel ownership, and control-plane evidence before resuming."
                  }
                : changeEffect.outcome === "error"
                  ? {
                      reason: "Automatic continuation evaluation failed; this is not ordinary policy ineligibility.",
                      nextAction: "Inspect continuation failure evidence before retrying or creating another task."
                    }
                  : changeEffect.outcome === "not_eligible" && changeEffect.reasonCode !== "manual_policy"
                    ? {
                        reason: `The Workstream policy did not admit another Run (${changeEffect.reasonCode ?? "not_eligible"}).`,
                        nextAction: ({
                          terminal_work_loop: "Follow the terminal WorkThread evidence; create new work only for a genuinely new objective.",
                          workstream_blocked: "Resolve the Workstream budget or constraint before asking it to continue.",
                          stale_trigger: "Follow the current WorkThread state; the stale trigger must not start duplicate work.",
                          trigger_already_consumed: "Follow the existing continuation Run or terminal evidence for this trigger.",
                          trigger_not_enabled: "Use a trigger enabled by the recorded Workstream recipe, or update that governed policy.",
                          action_not_resumable: "Complete the canonical WorkLoop next action before requesting another Run.",
                          completion_not_available: "Wait for durable WorkLoop completion evidence before requesting continuation."
                        } as Record<string, string>)[changeEffect.reasonCode ?? ""]
                          ?? "Inspect the recorded Workstream decision and follow its canonical next action; do not create a duplicate task."
                      }
                    : changeEffect.outcome === "not_configured"
                      ? {
                          reason: "No Workstream continuation policy is configured.",
                          nextAction: "Configure a governed Workstream continuation policy before requesting automatic continuation."
                        }
                      : {
                          reason: `The Workstream policy did not admit another Run (${changeEffect.reasonCode ?? "not_eligible"}).`,
                          nextAction: "Send a new task in this source thread if you want to resume manually with the recorded resolution."
                        }
        : undefined;
      const body = input.command.verb === "acknowledge"
        ? `Acknowledged human escalation ${escalation.id}. It remains blocking until it is resolved or expires.`
        : automaticallyResumed
          ? [
              `Resolved human escalation ${escalation.id}${selectedOption ? ` with ${selectedOption.label}` : ""}.`,
              `The resolution is durably attributed and Workstream policy admitted Run ${changeEffect?.resumedRunId}.`,
              "Follow the new Run for execution evidence."
            ].join("\n")
          : [
              `Resolved human escalation ${escalation.id}${selectedOption ? ` with ${selectedOption.label}` : ""}.`,
              unresolvedContinuation?.reason ?? "The resolution was already durably attributed; no new continuation evaluation was required.",
              unresolvedContinuation?.nextAction ?? "Follow the existing WorkThread state."
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
          ? {
              resume: automaticallyResumed
                ? { required: false, runId: changeEffect?.resumedRunId, nextAction: "Follow the new Run for execution evidence." }
                : {
                    required: Boolean(unresolvedContinuation),
                    ...(unresolvedContinuation ? { reason: unresolvedContinuation.reason } : {}),
                    nextAction: unresolvedContinuation?.nextAction ?? "Follow the existing WorkThread state."
                  }
            }
          : {})
      });
    } catch (error) {
      if (error instanceof ManagedChannelAuthorityError || error instanceof ChannelBindingCorruptionError) {
        const reasonCode = error instanceof ManagedChannelAuthorityError
          ? error.reasonCode
          : "managed_channel_binding_corrupt";
        await deliverThreadControlReply({
          request: input.request,
          command: input.command,
          body: `Could not update human escalation ${escalation.id}: the owning managed-channel principal is required (${reasonCode}).`,
          ...(target ? { auditRunId: target.run.id } : {})
        });
        return jsonResponse({ outcome: "rejected", escalationId: escalation.id, reasonCode });
      }
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
    handle(input: {
      request: SourceThreadControlActionRequest;
      command: ThreadControlCommand;
      channelPrincipal?: { provider: string; applicationId: string; botId?: string };
    }): Promise<Response> {
      if (input.command.verb === "status") return handleStatus(input);
      if (input.command.verb === "doctor") return handleDoctor(input);
      if (input.command.verb === "acknowledge" || input.command.verb === "resolve") return handleHumanEscalation(input);
      return handleStop(input);
    }
  };
}
