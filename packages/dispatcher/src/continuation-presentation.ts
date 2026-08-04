export type ContinuationPresentationInput = {
  outcome: "not_configured" | "not_eligible" | "ambiguous" | "created" | "replayed" | "deferred" | "needs_human" | "rejected" | "error";
  reasonCode?: string;
  activeRunId?: string;
  notBefore?: string;
  resumedRunId?: string;
  humanEscalationId?: string;
};

export type ContinuationResumePresentation = {
  required: boolean;
  runId?: string;
  reason: string;
  nextAction: string;
};

const NOT_ELIGIBLE_NEXT_ACTIONS: Readonly<Record<string, string>> = {
  terminal_work_loop: "Follow the terminal WorkThread evidence; create new work only for a genuinely new objective.",
  workstream_blocked: "Resolve the Workstream budget or constraint before asking it to continue.",
  stale_trigger: "Follow the current WorkThread state; the stale trigger must not start duplicate work.",
  trigger_already_consumed: "Follow the existing continuation Run or terminal evidence for this trigger.",
  trigger_not_enabled: "Use a trigger enabled by the recorded Workstream recipe, or update that governed policy.",
  action_not_resumable: "Complete the canonical WorkLoop next action before requesting another Run.",
  completion_not_available: "Wait for durable WorkLoop completion evidence before requesting continuation."
};

export function continuationResumePresentation(
  continuation: ContinuationPresentationInput
): ContinuationResumePresentation {
  if (
    (continuation.outcome === "created" || continuation.outcome === "replayed")
    && continuation.resumedRunId
  ) {
    return {
      required: false,
      runId: continuation.resumedRunId,
      reason: "Resolution is durable context and the Workstream continuation policy admitted a Run.",
      nextAction: `Follow Run ${continuation.resumedRunId} for execution evidence.`
    };
  }
  if (continuation.outcome === "deferred") {
    const deferredUntil = continuation.notBefore ? ` until ${continuation.notBefore}` : "";
    return {
      required: true,
      reason: continuation.activeRunId
        ? `Automatic continuation is deferred because Run ${continuation.activeRunId} is active.`
        : `Automatic continuation is deferred by its cadence or retry policy${deferredUntil}.`,
      nextAction: continuation.activeRunId
        ? "Follow the active Run and wait for its terminal evidence before resuming."
        : `Wait for the governed continuation window${deferredUntil}; do not create a duplicate task.`
    };
  }
  if (continuation.outcome === "needs_human") {
    return {
      required: true,
      reason: "Automatic continuation requires an additional governed human decision.",
      nextAction: continuation.humanEscalationId
        ? `Resolve human escalation ${continuation.humanEscalationId}.`
        : "Inspect the WorkThread attention state and resolve the required decision."
    };
  }
  if (continuation.outcome === "ambiguous") {
    return {
      required: true,
      reason: `Automatic continuation is ambiguous (${continuation.reasonCode ?? "multiple_authorities"}).`,
      nextAction: "Select or repair the authoritative Workstream before resuming; do not create a duplicate task."
    };
  }
  if (continuation.outcome === "rejected") {
    return {
      required: true,
      reason: `Automatic continuation was rejected by its authority boundary (${continuation.reasonCode ?? "authority_rejected"}).`,
      nextAction: "Inspect the Workstream recipe, channel ownership, and control-plane evidence before resuming."
    };
  }
  if (continuation.outcome === "error") {
    return {
      required: true,
      reason: "Automatic continuation evaluation failed; this is not an ordinary policy ineligibility.",
      nextAction: "Inspect the continuation failure in control-plane evidence before retrying or creating another task."
    };
  }
  if (continuation.outcome === "not_eligible" && continuation.reasonCode !== "manual_policy") {
    return {
      required: true,
      reason: `The Workstream continuation policy did not admit another Run (${continuation.reasonCode ?? "not_eligible"}).`,
      nextAction: NOT_ELIGIBLE_NEXT_ACTIONS[continuation.reasonCode ?? ""]
        ?? "Inspect the recorded Workstream decision and follow its canonical next action; do not create a duplicate task."
    };
  }
  if (continuation.outcome === "not_configured") {
    return {
      required: true,
      reason: "The recorded resolution has no Workstream continuation policy.",
      nextAction: "Configure a governed Workstream continuation policy before requesting automatic continuation."
    };
  }
  return {
    required: true,
    reason: `The Workstream continuation policy did not admit another Run (${continuation.reasonCode ?? "not_eligible"}).`,
    nextAction: "Send a new source-thread task if you want to resume manually with the recorded resolution."
  };
}
