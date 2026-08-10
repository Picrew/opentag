import type {
  ActorIdentity,
  HumanEscalation,
  OpenTagEvent,
  OpenTagRun,
  ReassessmentObligation,
  WorkstreamContinuationDecision,
  WorkstreamContinuationTriggerEvent
} from "@opentag/core";
import type { createOpenTagRepository } from "@opentag/store";
import type { ReassessmentObligationProcessingResult } from "./reassessment-obligations.js";

type Repository = ReturnType<typeof createOpenTagRepository>;

type ContinuationDispatch = {
  outcome: "not_configured" | "not_eligible" | "ambiguous" | "created" | "replayed" | "deferred" | "needs_human" | "rejected" | "error";
  workThreadId: string;
  trigger: WorkstreamContinuationTriggerEvent;
  decisions: WorkstreamContinuationDecision[];
  reasonCode?: string;
  notBefore?: string;
  run?: OpenTagRun;
};

type ContinuationInput = {
  workThreadId: string;
  trigger: WorkstreamContinuationTriggerEvent;
  preferredParentRunId?: string;
  continuationActor?: ActorIdentity;
  durableHumanResolution?: HumanEscalation;
  continuationContext?: {
    pointer: OpenTagEvent["context"][number];
    metadata: Record<string, unknown>;
  };
};

export function createReassessmentObligationProcessor(input: {
  repo: Pick<
    Repository,
    | "getWorkThread"
    | "getRun"
    | "listVerificationEvidence"
    | "getHumanEscalation"
    | "listCompletionWaivers"
    | "listMaterialActionReceiptsForWorkThread"
  >;
  ingestRunResult(runId: string): Promise<{ assessment: { id: string } } | null>;
  reassessWorkThread(workThreadId: string, trigger: string): Promise<{ assessment: { id: string } } | null>;
  deliverCompletionTransition(
    workThreadId: string,
    options?: {
      retryPendingTransition?: boolean;
      forceCurrentAssessment?: boolean;
      legacyFallback?: boolean;
    }
  ): Promise<string | null>;
  promoteNextFollowUpAfterTerminalRun(input: { activeRunId: string }): Promise<unknown | null>;
  attemptWorkstreamContinuation(input: ContinuationInput): Promise<ContinuationDispatch>;
  humanResolutionContinuationContext(escalation: HumanEscalation): ContinuationInput["continuationContext"] | undefined;
  now(): string;
  deferralMs: number;
}): (obligation: ReassessmentObligation) => Promise<ReassessmentObligationProcessingResult> {
  return async (obligation) => {
    const workThread = await input.repo.getWorkThread({ workThreadId: obligation.workThreadId });
    if (!workThread) {
      return { outcome: "blocked", reasonCode: "source_missing", lastError: "The obligation WorkThread no longer exists." };
    }

    let sourceRun: Awaited<ReturnType<Repository["getRun"]>> | null = null;
    let sourceEscalation: HumanEscalation | null = null;
    let evidenceDelivery: { provider: string; deliveryId: string } | null = null;
    if (obligation.sourceKind === "run_result_recorded") {
      sourceRun = await input.repo.getRun({ runId: obligation.sourceId });
      if (!sourceRun?.run.result || sourceRun.run.thread?.id !== obligation.workThreadId) {
        return { outcome: "blocked", reasonCode: "source_missing", lastError: "The recorded Run result source is unavailable." };
      }
    } else if (obligation.sourceKind === "verification_evidence_attached") {
      const records = await input.repo.listVerificationEvidence({ workThreadId: obligation.workThreadId });
      const matching = records.find((record) =>
        [record.provider, record.deliveryId, record.subjectRef, obligation.workThreadId].join(":") === obligation.sourceId
      );
      if (!matching) {
        return { outcome: "blocked", reasonCode: "source_missing", lastError: "The attached verification evidence source is unavailable." };
      }
      evidenceDelivery = { provider: matching.provider, deliveryId: matching.deliveryId };
    } else if (obligation.sourceKind === "human_escalation_changed") {
      sourceEscalation = await input.repo.getHumanEscalation({ id: obligation.sourceId });
      if (!sourceEscalation || sourceEscalation.workThreadId !== obligation.workThreadId) {
        return { outcome: "blocked", reasonCode: "source_missing", lastError: "The HumanEscalation source is unavailable." };
      }
    } else if (obligation.sourceKind === "completion_waiver_changed") {
      const waivers = await input.repo.listCompletionWaivers({ workThreadId: obligation.workThreadId });
      if (!waivers.some((waiver) => waiver.id === obligation.sourceId)) {
        return { outcome: "blocked", reasonCode: "source_missing", lastError: "The completion waiver source is unavailable." };
      }
    } else if (
      obligation.sourceKind === "material_action_receipt_recorded"
      || obligation.sourceKind === "material_action_reconciled"
    ) {
      const receipts = await input.repo.listMaterialActionReceiptsForWorkThread({ workThreadId: obligation.workThreadId });
      if (!receipts.some((receipt) => receipt.actionId === obligation.sourceId)) {
        return { outcome: "blocked", reasonCode: "source_missing", lastError: "The material-action receipt source is unavailable." };
      }
    }

    const recoveredTransitionAssessmentId = obligation.attemptCount > 1
      && obligation.lastReasonCode === "reassessment_failed"
      ? await input.deliverCompletionTransition(obligation.workThreadId, {
          retryPendingTransition: true,
          ...(sourceRun
            ? { forceCurrentAssessment: true, legacyFallback: false }
            : {})
        })
      : null;
    const governanceResult = sourceRun
      ? await input.ingestRunResult(sourceRun.run.id)
      : await input.reassessWorkThread(
          obligation.workThreadId,
          `reassessment-obligation:${obligation.id}:${obligation.attemptCount}`
        );
    const deliveredTransitionAssessmentId = governanceResult
      ? sourceRun
        ? await input.deliverCompletionTransition(obligation.workThreadId, {
            forceCurrentAssessment: true,
            legacyFallback: false
          })
        : await input.deliverCompletionTransition(obligation.workThreadId)
      : null;
    const satisfiedAssessmentId = governanceResult?.assessment.id
      ?? deliveredTransitionAssessmentId
      ?? recoveredTransitionAssessmentId
      ?? undefined;

    const promotableRunId = sourceRun?.run.result
      && sourceRun.run.result.conclusion !== "needs_human"
      && sourceRun.run.result.conclusion !== "cancelled"
      ? sourceRun.run.id
      : null;
    const promotedFollowUp = promotableRunId
      ? await input.promoteNextFollowUpAfterTerminalRun({ activeRunId: promotableRunId })
      : null;
    if (promotedFollowUp) {
      return {
        outcome: "satisfied",
        reasonCode: "continuation_dispatched",
        ...(satisfiedAssessmentId ? { satisfiedAssessmentId } : {})
      };
    }

    let continuationInput: ContinuationInput | null = null;
    if (sourceRun?.run.result && ["failure", "interrupted", "timed_out"].includes(sourceRun.run.result.conclusion)) {
      continuationInput = {
        workThreadId: obligation.workThreadId,
        trigger: {
          id: `run-terminal:${sourceRun.run.id}`,
          kind: "retryable_run_failure",
          occurredAt: sourceRun.run.updatedAt
        },
        preferredParentRunId: sourceRun.run.id
      };
    } else if (evidenceDelivery) {
      continuationInput = {
        workThreadId: obligation.workThreadId,
        trigger: {
          id: evidenceDelivery.provider === "github"
            ? `github-evidence:${evidenceDelivery.deliveryId}`
            : `completion-evidence:${evidenceDelivery.provider}:${evidenceDelivery.deliveryId}`,
          kind: "completion_evidence_changed",
          occurredAt: obligation.createdAt
        }
      };
    } else if (sourceEscalation?.state === "resolved" && sourceEscalation.resolution) {
      const resolutionContext = input.humanResolutionContinuationContext(sourceEscalation);
      continuationInput = {
        workThreadId: obligation.workThreadId,
        trigger: {
          id: `human-escalation:${sourceEscalation.id}`,
          kind: "human_escalation_resolved",
          occurredAt: sourceEscalation.resolution.resolvedAt
        },
        continuationActor: sourceEscalation.resolution.actor,
        durableHumanResolution: sourceEscalation,
        ...(resolutionContext ? { continuationContext: resolutionContext } : {}),
        ...(sourceEscalation.runId ? { preferredParentRunId: sourceEscalation.runId } : {})
      };
    } else if (
      obligation.sourceKind === "material_action_receipt_recorded"
      || obligation.sourceKind === "material_action_reconciled"
      || obligation.sourceKind === "completion_waiver_changed"
    ) {
      continuationInput = {
        workThreadId: obligation.workThreadId,
        trigger: {
          id: `completion-evidence:${obligation.sourceKind}:${obligation.sourceId}:${obligation.sourceDigest}`,
          kind: "completion_evidence_changed",
          occurredAt: obligation.createdAt
        }
      };
    }

    if (!continuationInput) {
      return satisfiedAssessmentId
        ? { outcome: "satisfied", reasonCode: "assessment_satisfied", satisfiedAssessmentId }
        : { outcome: "satisfied", reasonCode: "continuation_terminal" };
    }
    const continuation = await input.attemptWorkstreamContinuation(continuationInput);
    if (continuation.outcome === "error") {
      throw new Error(continuation.reasonCode ?? "Continuation dispatch failed during reassessment delivery.");
    }
    if (continuation.outcome === "deferred") {
      const notBefore = continuation.notBefore ?? new Date(Date.parse(input.now()) + input.deferralMs).toISOString();
      return { outcome: "rescheduled", reasonCode: "continuation_deferred", notBefore };
    }
    if (continuation.outcome === "created" || continuation.outcome === "replayed") {
      return {
        outcome: "satisfied",
        reasonCode: "continuation_dispatched",
        ...(satisfiedAssessmentId ? { satisfiedAssessmentId } : {})
      };
    }
    if (continuation.outcome === "needs_human" || continuation.outcome === "ambiguous") {
      return {
        outcome: "blocked",
        reasonCode: "needs_human",
        lastError: continuation.reasonCode ?? "Continuation requires an attributed human decision."
      };
    }
    if (continuation.outcome === "rejected") {
      return {
        outcome: "blocked",
        reasonCode: "authority_missing",
        lastError: continuation.reasonCode ?? "Continuation authority was rejected."
      };
    }
    return {
      outcome: "satisfied",
      reasonCode: "continuation_terminal",
      ...(satisfiedAssessmentId ? { satisfiedAssessmentId } : {})
    };
  };
}
