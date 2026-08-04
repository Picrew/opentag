import type {
  ReassessmentObligation,
  ReassessmentObligationReasonCode
} from "@opentag/core";
import type { createOpenTagRepository } from "@opentag/store";
import { randomUUID } from "node:crypto";

type ReassessmentRepository = Pick<
  ReturnType<typeof createOpenTagRepository>,
  | "claimDueReassessmentObligations"
  | "renewReassessmentObligationLease"
  | "satisfyReassessmentObligation"
  | "rescheduleReassessmentObligation"
  | "blockReassessmentObligation"
>;

type SatisfiedReason = Extract<
  ReassessmentObligationReasonCode,
  "assessment_satisfied" | "continuation_dispatched" | "continuation_terminal"
>;
type PendingReason = Extract<
  ReassessmentObligationReasonCode,
  "continuation_deferred" | "reassessment_failed"
>;
type BlockedReason = Extract<
  ReassessmentObligationReasonCode,
  "source_missing" | "authority_missing" | "needs_human"
>;

export type ReassessmentObligationProcessingResult =
  | {
      outcome: "satisfied";
      reasonCode: SatisfiedReason;
      satisfiedAssessmentId?: string;
    }
  | {
      outcome: "rescheduled";
      reasonCode: PendingReason;
      notBefore: string;
      lastError?: string;
    }
  | {
      outcome: "blocked";
      reasonCode: BlockedReason;
      lastError?: string;
    };

export type ReassessmentObligationDrainReport = {
  claimed: number;
  satisfied: number;
  rescheduled: number;
  blocked: number;
  stale: number;
};

export type ReassessmentObligationWorker = {
  drainDue(): Promise<ReassessmentObligationDrainReport>;
  start(): void;
  stop(): Promise<void>;
  wake(): void;
};

const emptyReport = (): ReassessmentObligationDrainReport => ({
  claimed: 0,
  satisfied: 0,
  rescheduled: 0,
  blocked: 0,
  stale: 0
});

class ReassessmentObligationLeaseLostError extends Error {}

export function createReassessmentObligationWorker(input: {
  repo: ReassessmentRepository;
  process(obligation: ReassessmentObligation): Promise<ReassessmentObligationProcessingResult>;
  leaseOwner?: string;
  leaseSeconds?: number;
  batchSize?: number;
  pollIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  onError?: (error: unknown) => void | Promise<void>;
}): ReassessmentObligationWorker {
  const leaseOwner = input.leaseOwner ?? `dispatcher-reassessment-${randomUUID()}`;
  const leaseSeconds = input.leaseSeconds ?? 30;
  const batchSize = input.batchSize ?? 25;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const retryBaseMs = input.retryBaseMs ?? 1_000;
  const retryMaxMs = input.retryMaxMs ?? 60_000;
  const maxAttempts = input.maxAttempts ?? 5;
  const now = input.now ?? (() => new Date());
  let active = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let draining: Promise<ReassessmentObligationDrainReport> | undefined;

  async function withLease<T>(obligation: ReassessmentObligation, task: () => Promise<T>): Promise<T> {
    if (!obligation.leaseOwner || !obligation.leaseToken) {
      throw new ReassessmentObligationLeaseLostError(`Reassessment obligation ${obligation.id} has no active lease.`);
    }
    const obligationLeaseOwner = obligation.leaseOwner;
    const obligationLeaseToken = obligation.leaseToken;
    let renewalFailure: Error | undefined;
    let renewalChain = Promise.resolve();
    const renew = async () => {
      if (renewalFailure) return;
      const renewed = await input.repo.renewReassessmentObligationLease({
        id: obligation.id,
        leaseOwner: obligationLeaseOwner,
        leaseToken: obligationLeaseToken,
        leaseSeconds,
        now: now()
      });
      if (renewed.outcome !== "renewed") {
        throw new ReassessmentObligationLeaseLostError(
          `Reassessment obligation ${obligation.id} lease could not be renewed: ${renewed.outcome}.`
        );
      }
    };
    const scheduleRenewal = () => {
      renewalChain = renewalChain.then(renew).catch((error: unknown) => {
        renewalFailure = error instanceof Error ? error : new Error(String(error));
      });
    };
    const heartbeat = globalThis.setInterval(scheduleRenewal, Math.max(10, Math.floor(leaseSeconds * 1_000 / 3)));
    heartbeat.unref?.();
    try {
      const result = await task();
      await renewalChain;
      if (renewalFailure) throw renewalFailure;
      await renew();
      return result;
    } finally {
      globalThis.clearInterval(heartbeat);
      await renewalChain;
    }
  }

  async function applyResult(
    obligation: ReassessmentObligation,
    result: ReassessmentObligationProcessingResult,
    report: ReassessmentObligationDrainReport
  ): Promise<void> {
    if (!obligation.leaseOwner || !obligation.leaseToken) {
      report.stale += 1;
      return;
    }
    if (result.outcome === "satisfied") {
      const transition = await input.repo.satisfyReassessmentObligation({
        id: obligation.id,
        leaseOwner: obligation.leaseOwner,
        leaseToken: obligation.leaseToken,
        reasonCode: result.reasonCode,
        ...(result.satisfiedAssessmentId ? { satisfiedAssessmentId: result.satisfiedAssessmentId } : {}),
        now: now()
      });
      if (transition.outcome === "satisfied" || transition.outcome === "duplicate") report.satisfied += 1;
      else report.stale += 1;
      return;
    }
    if (result.outcome === "rescheduled") {
      const transition = await input.repo.rescheduleReassessmentObligation({
        id: obligation.id,
        leaseOwner: obligation.leaseOwner,
        leaseToken: obligation.leaseToken,
        reasonCode: result.reasonCode,
        notBefore: result.notBefore,
        ...(result.lastError ? { lastError: result.lastError } : {}),
        now: now()
      });
      if (transition.outcome === "rescheduled") report.rescheduled += 1;
      else report.stale += 1;
      return;
    }
    const transition = await input.repo.blockReassessmentObligation({
      id: obligation.id,
      leaseOwner: obligation.leaseOwner,
      leaseToken: obligation.leaseToken,
      reasonCode: result.reasonCode,
      ...(result.lastError ? { lastError: result.lastError } : {}),
      now: now()
    });
    if (transition.outcome === "blocked" || transition.outcome === "duplicate") report.blocked += 1;
    else report.stale += 1;
  }

  async function recoverFailure(
    obligation: ReassessmentObligation,
    error: unknown,
    report: ReassessmentObligationDrainReport
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (!obligation.leaseOwner || !obligation.leaseToken) {
      report.stale += 1;
      return;
    }
    if (obligation.attemptCount >= maxAttempts) {
      await applyResult(obligation, {
        outcome: "blocked",
        reasonCode: "needs_human",
        lastError: message
      }, report);
      return;
    }
    const exponent = Math.max(0, obligation.attemptCount - 1);
    const delayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** exponent));
    await applyResult(obligation, {
      outcome: "rescheduled",
      reasonCode: "reassessment_failed",
      notBefore: new Date(now().getTime() + delayMs).toISOString(),
      lastError: message
    }, report);
  }

  async function performDrain(): Promise<ReassessmentObligationDrainReport> {
    const report = emptyReport();
    for (let index = 0; index < batchSize; index += 1) {
      const [obligation] = await input.repo.claimDueReassessmentObligations({
        leaseOwner,
        leaseSeconds,
        limit: 1,
        now: now()
      });
      if (!obligation) break;
      report.claimed += 1;
      try {
        const result = await withLease(obligation, () => input.process(obligation));
        await applyResult(obligation, result, report);
      } catch (error) {
        if (error instanceof ReassessmentObligationLeaseLostError) {
          report.stale += 1;
          await input.onError?.(error);
          continue;
        }
        try {
          await recoverFailure(obligation, error, report);
        } catch (transitionError) {
          report.stale += 1;
          await input.onError?.(transitionError);
        }
      }
    }
    return report;
  }

  async function drainDue(): Promise<ReassessmentObligationDrainReport> {
    if (draining) return draining;
    draining = performDrain().finally(() => {
      draining = undefined;
    });
    return draining;
  }

  function wake(): void {
    if (!active) return;
    queueMicrotask(() => {
      if (!active) return;
      void drainDue().catch((error) => input.onError?.(error));
    });
  }

  function schedule(): void {
    if (!active) return;
    timer = globalThis.setTimeout(() => {
      void drainDue()
        .catch((error) => input.onError?.(error))
        .finally(schedule);
    }, pollIntervalMs);
    timer.unref?.();
  }

  return {
    drainDue,
    start() {
      if (active) return;
      active = true;
      wake();
      schedule();
    },
    async stop() {
      active = false;
      if (timer !== undefined) globalThis.clearTimeout(timer);
      timer = undefined;
      const pendingDrain = draining;
      if (pendingDrain) {
        await pendingDrain.catch(async (error) => {
          await input.onError?.(error);
        });
      }
    },
    wake
  };
}
