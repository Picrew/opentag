import type { ReassessmentObligation } from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createReassessmentObligationProcessor } from "../src/reassessment-processor.js";

const timestamp = "2026-08-04T08:00:00.000Z";

function obligation(overrides: Partial<ReassessmentObligation> = {}): ReassessmentObligation {
  return {
    id: "reassess_1",
    workThreadId: "thread_1",
    sourceKind: "completion_waiver_changed",
    sourceId: "waiver_1",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    notBefore: timestamp,
    state: "leased",
    leaseOwner: "worker_1",
    leaseExpiresAt: "2026-08-04T08:01:00.000Z",
    leaseToken: "lease_1",
    attemptCount: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    repo: {
      getWorkThread: vi.fn(async () => ({ thread: { id: "thread_1" } })),
      getRun: vi.fn(async () => null),
      listVerificationEvidence: vi.fn(async () => []),
      getHumanEscalation: vi.fn(async () => null),
      listCompletionWaivers: vi.fn(async () => [{ id: "waiver_1" }]),
      listMaterialActionReceiptsForWorkThread: vi.fn(async () => [])
    },
    ingestRunResult: vi.fn(async () => null),
    reassessWorkThread: vi.fn(async () => ({ assessment: { id: "assessment_1" } })),
    deliverCompletionTransition: vi.fn(async () => "assessment_1"),
    promoteNextFollowUpAfterTerminalRun: vi.fn(async () => null),
    attemptWorkstreamContinuation: vi.fn(async () => ({
      outcome: "deferred" as const,
      workThreadId: "thread_1",
      trigger: { id: "trigger_1", kind: "completion_evidence_changed" as const, occurredAt: timestamp },
      decisions: []
    })),
    humanResolutionContinuationContext: vi.fn(() => undefined),
    now: () => timestamp,
    deferralMs: 1_000,
    ...overrides
  };
}

describe("createReassessmentObligationProcessor", () => {
  it("preserves the durable deferral transition and injected clock", async () => {
    const deps = dependencies();
    const process = createReassessmentObligationProcessor(deps as never);

    await expect(process(obligation())).resolves.toEqual({
      outcome: "rescheduled",
      reasonCode: "continuation_deferred",
      notBefore: "2026-08-04T08:00:01.000Z"
    });
    expect(deps.reassessWorkThread).toHaveBeenCalledWith(
      "thread_1",
      "reassessment-obligation:reassess_1:1"
    );
    expect(deps.deliverCompletionTransition).toHaveBeenCalledWith("thread_1");
  });

  it("blocks before governance when the durable source disappeared after restart", async () => {
    const deps = dependencies({
      repo: {
        ...dependencies().repo,
        listCompletionWaivers: vi.fn(async () => [])
      }
    });
    const process = createReassessmentObligationProcessor(deps as never);

    await expect(process(obligation())).resolves.toEqual({
      outcome: "blocked",
      reasonCode: "source_missing",
      lastError: "The completion waiver source is unavailable."
    });
    expect(deps.reassessWorkThread).not.toHaveBeenCalled();
  });

  it("keeps the obligation retryable when completion callback custody is not durable yet", async () => {
    const callbackFailure = new Error("governed_callback_authority_conflict");
    const deps = dependencies({
      deliverCompletionTransition: vi.fn(async () => {
        throw callbackFailure;
      })
    });
    const process = createReassessmentObligationProcessor(deps as never);

    await expect(process(obligation())).rejects.toBe(callbackFailure);
    expect(deps.reassessWorkThread).toHaveBeenCalledOnce();
    expect(deps.promoteNextFollowUpAfterTerminalRun).not.toHaveBeenCalled();
    expect(deps.attemptWorkstreamContinuation).not.toHaveBeenCalled();
  });

  it("retries the pending transition before a new reassessment can supersede it", async () => {
    const callOrder: string[] = [];
    const deliverCompletionTransition = vi.fn(async (
      _workThreadId: string,
      options?: { retryPendingTransition?: boolean }
    ) => {
      callOrder.push(options?.retryPendingTransition ? "retry-transition" : "current-transition");
      return options?.retryPendingTransition ? "assessment_pending_callback" : null;
    });
    const reassessWorkThread = vi.fn(async () => {
      callOrder.push("reassess");
      return { assessment: { id: "assessment_after_retry" } };
    });
    const deps = dependencies({ deliverCompletionTransition, reassessWorkThread });
    const process = createReassessmentObligationProcessor(deps as never);

    await expect(process(obligation({
      attemptCount: 2,
      lastReasonCode: "reassessment_failed"
    }))).resolves.toMatchObject({
      outcome: "rescheduled",
      reasonCode: "continuation_deferred"
    });
    expect(callOrder).toEqual([
      "retry-transition",
      "reassess",
      "current-transition"
    ]);
    expect(deliverCompletionTransition).toHaveBeenNthCalledWith(
      1,
      "thread_1",
      { retryPendingTransition: true }
    );
  });

  it("forces a governed-only terminal assessment callback for recorded run results", async () => {
    const deliverCompletionTransition = vi.fn(async () => "assessment_run_result");
    const base = dependencies();
    const deps = dependencies({
      repo: {
        ...base.repo,
        getRun: vi.fn(async () => ({
          run: {
            id: "run_1",
            thread: { id: "thread_1" },
            result: { conclusion: "success" },
            updatedAt: timestamp
          }
        }))
      },
      ingestRunResult: vi.fn(async () => ({
        assessment: { id: "assessment_run_result" }
      })),
      deliverCompletionTransition
    });
    const process = createReassessmentObligationProcessor(deps as never);

    await expect(process(obligation({
      sourceKind: "run_result_recorded",
      sourceId: "run_1"
    }))).resolves.toEqual({
      outcome: "satisfied",
      reasonCode: "assessment_satisfied",
      satisfiedAssessmentId: "assessment_run_result"
    });
    expect(deliverCompletionTransition).toHaveBeenCalledWith("thread_1", {
      forceCurrentAssessment: true,
      legacyFallback: false
    });
  });
});
