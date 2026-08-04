import { describe, expect, it } from "vitest";
import {
  ReassessmentObligationSchema,
  ReassessmentObligationSourceKindSchema,
  ReassessmentObligationStateSchema
} from "../src/schema.js";

const timestamp = "2026-08-04T08:00:00.000Z";
const sourceDigest = `sha256:${"a".repeat(64)}`;

function pendingObligation() {
  return {
    id: "reassessment_obligation_1",
    workThreadId: "work_thread_1",
    sourceKind: "run_result_recorded" as const,
    sourceId: "run_1",
    sourceDigest,
    notBefore: timestamp,
    state: "pending" as const,
    attemptCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

describe("ReassessmentObligationSchema", () => {
  it.each([
    "run_result_recorded",
    "verification_evidence_attached",
    "material_action_receipt_recorded",
    "material_action_reconciled",
    "human_escalation_changed",
    "completion_waiver_changed",
    "continuation_not_before"
  ] as const)("accepts the supported source kind %s", (sourceKind) => {
    expect(ReassessmentObligationSourceKindSchema.parse(sourceKind)).toBe(sourceKind);
    expect(ReassessmentObligationSchema.parse({ ...pendingObligation(), sourceKind })).toMatchObject({ sourceKind });
  });

  it("rejects arbitrary source kinds", () => {
    expect(() => ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      sourceKind: "generic_job"
    })).toThrow();
  });

  it.each(["pending", "leased", "satisfied", "blocked"] as const)("accepts the delivery state %s", (state) => {
    expect(ReassessmentObligationStateSchema.parse(state)).toBe(state);
  });

  it.each(["completed", "succeeded", "waived"])("rejects the business state %s", (state) => {
    expect(() => ReassessmentObligationStateSchema.parse(state)).toThrow();
  });

  it("requires a complete lease and fresh fence only while leased", () => {
    const leased = {
      ...pendingObligation(),
      state: "leased" as const,
      leaseOwner: "dispatcher_1",
      leaseExpiresAt: "2026-08-04T08:00:30.000Z",
      leaseToken: "lease_token_1",
      attemptCount: 1
    };
    expect(ReassessmentObligationSchema.parse(leased)).toMatchObject({ leaseToken: "lease_token_1" });
    expect(() => ReassessmentObligationSchema.parse({ ...leased, leaseToken: undefined })).toThrow(/lease owner, expiry, and fencing token/u);
    expect(() => ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      leaseOwner: "dispatcher_1",
      leaseExpiresAt: "2026-08-04T08:00:30.000Z",
      leaseToken: "lease_token_1"
    })).toThrow(/Active lease fields/u);
  });

  it("keeps satisfaction distinct from WorkThread completion", () => {
    const satisfied = ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      state: "satisfied",
      lastReasonCode: "assessment_satisfied",
      satisfiedAssessmentId: "assessment_1",
      updatedAt: "2026-08-04T08:00:05.000Z"
    });
    expect(satisfied).toMatchObject({
      state: "satisfied",
      lastReasonCode: "assessment_satisfied",
      satisfiedAssessmentId: "assessment_1"
    });
    expect(satisfied).not.toHaveProperty("completionState");
    expect(() => ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      state: "satisfied",
      lastReasonCode: "assessment_satisfied"
    })).toThrow(/assessment-backed satisfaction/u);
  });

  it("allows a terminal continuation outcome without fabricating an assessment id", () => {
    expect(ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      state: "satisfied",
      lastReasonCode: "continuation_terminal"
    })).not.toHaveProperty("satisfiedAssessmentId");
  });

  it("constrains reasons to the transition that persisted them", () => {
    expect(ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      lastReasonCode: "reassessment_failed",
      lastError: "fixture reassessment failed"
    })).toMatchObject({ state: "pending", lastReasonCode: "reassessment_failed" });
    expect(ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      state: "blocked",
      lastReasonCode: "needs_human"
    })).toMatchObject({ state: "blocked", lastReasonCode: "needs_human" });
    expect(() => ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      state: "blocked",
      lastReasonCode: "continuation_dispatched"
    })).toThrow(/blocked obligation reason/u);
  });

  it("rejects malformed digests and timestamps", () => {
    expect(() => ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      sourceDigest: "sha256:not-a-digest"
    })).toThrow();
    expect(() => ReassessmentObligationSchema.parse({
      ...pendingObligation(),
      notBefore: "tomorrow"
    })).toThrow();
  });
});
