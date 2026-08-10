import type {
  CompletionContract,
  CompletionWaiver,
  HumanEscalation,
  OpenTagRunResult
} from "@opentag/core";
import { describe, expect, it } from "vitest";
import {
  completionInputDigest,
  createOpenTagGovernance,
  deriveWorkLoopView,
  evaluateCompletion,
  type CompletionArtifact,
  type CompletionEvaluationSnapshot,
  type CompletionEvidenceFact,
  type GovernanceRepository
} from "../src/index.js";

const t0 = "2026-07-21T10:00:00.000Z";
const t1 = "2026-07-21T10:01:00.000Z";
const t2 = "2026-07-21T10:02:00.000Z";
const t3 = "2026-07-21T10:03:00.000Z";

function strictContract(): CompletionContract {
  return {
    id: "contract-github-1",
    version: 1,
    workThreadId: "thread-1",
    cycle: 1,
    mode: "governed",
    targetSelectors: [{ key: "primary_change", kind: "change_request", lineage: "current_cycle", cardinality: "exactly_one" }],
    resolvedFrom: [{ scope: "work_context_owner_container", ref: "github:acme/demo", version: "1" }],
    gates: [
      { id: "pr", kind: "artifact", targetKey: "primary_change", artifactKind: "pull_request", minimum: 1 },
      {
        id: "checks",
        kind: "verification",
        targetKey: "primary_change",
        evidenceKind: "source_control.required_checks",
        requiredObservations: ["build", "test"],
        requiredOutcome: "passed",
        minimumAssurance: "verified"
      },
      { id: "merge", kind: "external_state", targetKey: "primary_change", provider: "github", requiredState: "merged", minimumAssurance: "verified" }
    ],
    maxAutomaticRetries: 1,
    onSatisfied: "report_only",
    createdAt: t0
  };
}

function compatibilityContract(): CompletionContract {
  return {
    id: "compat-1",
    version: 1,
    workThreadId: "thread-1",
    cycle: 1,
    mode: "execution_compat",
    targetSelectors: [],
    resolvedFrom: [{ scope: "organization_default", ref: "compatibility" }],
    gates: [{ id: "execution", kind: "material_action", actionFamily: "executor_run", requiredOutcome: "succeeded" }],
    maxAutomaticRetries: 0,
    onSatisfied: "report_only",
    createdAt: t0
  };
}

const successResult: OpenTagRunResult = { conclusion: "success", summary: "Created pull request." };

function prArtifact(input: { ref?: string; version?: string; id?: string } = {}): CompletionArtifact {
  return {
    id: input.id ?? "artifact-pr-7",
    kind: "pull_request",
    uri: "https://github.com/acme/demo/pull/7",
    target: {
      key: "primary_change",
      provider: "github",
      resourceRef: input.ref ?? "github:acme/demo:pull_request:7",
      resourceVersion: input.version ?? "head-2"
    },
    recordedAt: t1
  };
}

function evidence(input: {
  id: string;
  kind: string;
  predicate: string;
  outcome: string;
  assurance?: CompletionEvidenceFact["assurance"];
  ref?: string;
  version?: string;
  observations?: Record<string, string>;
  observedAt?: string;
}): CompletionEvidenceFact {
  return {
    id: input.id,
    workThreadId: "thread-1",
    cycle: 1,
    kind: input.kind,
    assurance: input.assurance ?? "verified",
    subject: {
      provider: "github",
      resourceRef: input.ref ?? "github:acme/demo:pull_request:7",
      resourceVersion: input.version ?? "head-2"
    },
    claim: {
      predicate: input.predicate,
      outcome: input.outcome,
      ...(input.observations ? { observations: input.observations } : {})
    },
    provenance: {
      adapter: "github",
      adapterVersion: "phase1",
      payloadDigest: `sha256:${input.id.padEnd(64, "0").slice(0, 64)}`,
      providerDeliveryId: `delivery-${input.id}`
    },
    observedAt: input.observedAt ?? t2,
    receivedAt: input.observedAt ?? t2
  };
}

function baseInput() {
  return {
    contract: strictContract(),
    runResults: [{ runId: "run-1", result: successResult, recordedAt: t1 }],
    artifacts: [prArtifact()],
    evidence: [] as CompletionEvidenceFact[],
    materialActionReceipts: [],
    waivers: [] as CompletionWaiver[]
  };
}

describe("evaluateCompletion", () => {
  it("keeps compatibility execution success out of evidence-backed completion metrics", () => {
    const assessment = evaluateCompletion({
      ...baseInput(),
      contract: compatibilityContract(),
      artifacts: []
    });

    expect(assessment).toMatchObject({ state: "satisfied", evidenceBacked: false });
    expect(assessment.gateResults[0]).toMatchObject({ reasonCode: "execution_succeeded", state: "passed" });

    const failed = evaluateCompletion({
      ...baseInput(),
      contract: compatibilityContract(),
      artifacts: [],
      runResults: [{ runId: "run-1", result: { conclusion: "cancelled", summary: "Stopped." }, recordedAt: t1 }]
    });
    expect(failed).toMatchObject({ state: "unsatisfied", evidenceBacked: false });
    expect(failed.gateResults[0]).toMatchObject({ reasonCode: "execution_not_succeeded", state: "failed" });

    const pending = evaluateCompletion({
      ...baseInput(),
      contract: compatibilityContract(),
      artifacts: [],
      runResults: []
    });
    expect(pending).toMatchObject({ state: "pending", evidenceBacked: false });
    expect(pending.gateResults[0]).toMatchObject({ reasonCode: "execution_incomplete", state: "missing" });

    const waiver: CompletionWaiver = {
      id: "waiver-execution",
      contractId: "compat-1",
      contractVersion: 1,
      cycle: 1,
      actor: { provider: "github", providerUserId: "owner-1" },
      reason: "The bounded compatibility result is accepted.",
      scope: "selected_gates",
      policyScope: "organization_default",
      gateIds: ["execution"],
      waivedAt: t2
    };
    const waived = evaluateCompletion({
      ...baseInput(),
      contract: compatibilityContract(),
      artifacts: [],
      runResults: [{ runId: "run-1", result: { conclusion: "failure", summary: "Failed." }, recordedAt: t1 }],
      waivers: [waiver]
    });
    expect(waived).toMatchObject({ state: "waived", assessedBy: "human", waiver: { id: waiver.id } });
    expect(waived.gateResults[0]).toMatchObject({ reasonCode: "gate_waived", state: "waived" });
  });

  it("requires verified current-head checks and merge after executor success", () => {
    const pending = evaluateCompletion(baseInput());
    expect(pending.state).toBe("pending");
    expect(pending.gateResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ gateId: "pr", state: "passed" }),
      expect.objectContaining({ gateId: "checks", state: "missing" }),
      expect.objectContaining({ gateId: "merge", state: "missing" })
    ]));

    const reportedChecks = evidence({
      id: "checks-reported",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      assurance: "reported",
      observations: { build: "passed", test: "passed" }
    });
    const insufficient = evaluateCompletion({ ...baseInput(), evidence: [reportedChecks] });
    expect(insufficient).toMatchObject({ state: "blocked" });
    expect(insufficient.gateResults.find((gate) => gate.gateId === "checks")).toMatchObject({ reasonCode: "verification_assurance_insufficient" });

    const verifiedChecks = evidence({
      id: "checks-verified",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });
    const merged = evidence({ id: "merge-verified", kind: "source_control.pull_request", predicate: "state", outcome: "merged", observedAt: t3 });
    const satisfied = evaluateCompletion({ ...baseInput(), evidence: [merged, verifiedChecks] });

    expect(satisfied).toMatchObject({ state: "satisfied", evidenceBacked: true, acceptedAt: t3 });
    expect(satisfied.gateResults.map((gate) => gate.gateId)).toEqual(["checks", "merge", "pr"]);
    expect(satisfied.targetBindings).toEqual([expect.objectContaining({ resourceRef: "github:acme/demo:pull_request:7", resourceVersion: "head-2" })]);

    const satisfiedAfterFailedExecution = evaluateCompletion({
      ...baseInput(),
      runResults: [{ runId: "run-1", result: { conclusion: "failure", summary: "Execution failed." }, recordedAt: t1 }],
      evidence: [merged, verifiedChecks]
    });
    expect(satisfiedAfterFailedExecution.state).toBe("satisfied");

    const submillisecondEvidence = {
      ...verifiedChecks,
      id: "checks-submillisecond",
      observedAt: "2026-07-21T10:03:00.0001Z",
      receivedAt: "2026-07-21T10:03:00.0009Z"
    };
    const submillisecondAssessment = evaluateCompletion({
      ...baseInput(),
      evidence: [merged, submillisecondEvidence]
    });
    expect(submillisecondAssessment).toMatchObject({
      assessedAt: submillisecondEvidence.receivedAt,
      acceptedAt: submillisecondEvidence.receivedAt
    });
    expect(submillisecondAssessment.gateResults.every((gate) =>
      gate.evaluatedAt === submillisecondEvidence.receivedAt
    )).toBe(true);
  });

  it("never combines a PR, checks, and merge from different targets or stale heads", () => {
    const checksWrongPr = evidence({
      id: "checks-pr-8",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      ref: "github:acme/demo:pull_request:8",
      observations: { build: "passed", test: "passed" }
    });
    const mergeOldHead = evidence({
      id: "merge-old-head",
      kind: "source_control.pull_request",
      predicate: "state",
      outcome: "merged",
      version: "head-1"
    });
    const assessment = evaluateCompletion({ ...baseInput(), evidence: [checksWrongPr, mergeOldHead] });

    expect(assessment.state).toBe("pending");
    expect(assessment.gateResults.find((gate) => gate.gateId === "checks")).toMatchObject({ state: "missing", reasonCode: "verification_missing" });
    expect(assessment.gateResults.find((gate) => gate.gateId === "merge")).toMatchObject({ state: "missing", reasonCode: "external_state_stale" });
  });

  it("is independent of evidence arrival order and fails closed on unknown action receipts", () => {
    const checks = evidence({
      id: "checks-verified",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });
    const merge = evidence({ id: "merge-verified", kind: "source_control.pull_request", predicate: "state", outcome: "merged" });
    const left = evaluateCompletion({ ...baseInput(), evidence: [checks, merge] });
    const right = evaluateCompletion({ ...baseInput(), evidence: [merge, checks] });

    expect(right).toEqual(left);
    expect(completionInputDigest({ ...baseInput(), evidence: [merge, checks] })).toBe(
      completionInputDigest({ ...baseInput(), evidence: [checks, merge] })
    );

    const contract: CompletionContract = {
      ...strictContract(),
      gates: [{ id: "publish", kind: "material_action", actionFamily: "release", requiredOutcome: "succeeded" }],
      targetSelectors: []
    };
    const unknown = evaluateCompletion({
      ...baseInput(),
      contract,
      artifacts: [],
      materialActionReceipts: [{
        id: "receipt-1",
        actionId: "action-1",
        provider: "github",
        receiptRef: "receipt:1",
        outcome: "unknown",
        observedAt: t2,
        metadata: { actionFamily: "release" }
      }]
    });
    expect(unknown).toMatchObject({ state: "blocked" });
    expect(unknown.gateResults[0]).toMatchObject({ state: "unknown", reasonCode: "material_action_unknown" });
  });

  it("uses only the latest coherent authoritative observation and fails closed on ties", () => {
    const passed = evidence({
      id: "checks-old-pass",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" },
      observedAt: t2
    });
    const failed = evidence({
      id: "checks-new-failure",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "failed",
      observations: { build: "passed", test: "failed" },
      observedAt: t3
    });
    for (const facts of [[passed, failed], [failed, passed]]) {
      const assessment = evaluateCompletion({ ...baseInput(), evidence: facts, evaluatedAt: t3 });
      expect(assessment.gateResults.find((gate) => gate.gateId === "checks")).toMatchObject({
        state: "failed",
        evidenceIds: [failed.id],
        reasonCode: "verification_failed"
      });
    }

    const retargetedBase = evidence({
      id: "base-retargeted",
      kind: "source_control.pull_request",
      predicate: "existence",
      outcome: "passed",
      observations: { "base:main": "failed", base_branch: "release" },
      observedAt: t3
    });
    const baseContract: CompletionContract = {
      ...strictContract(),
      gates: [{
        id: "base",
        kind: "verification",
        targetKey: "primary_change",
        evidenceKind: "source_control.pull_request",
        requiredObservations: ["base:main"],
        requiredOutcome: "passed",
        minimumAssurance: "verified"
      }]
    };
    const oldBase = evidence({
      id: "base-old-main",
      kind: "source_control.pull_request",
      predicate: "existence",
      outcome: "passed",
      observations: { "base:main": "passed", base_branch: "main" },
      observedAt: t2
    });
    expect(evaluateCompletion({ ...baseInput(), contract: baseContract, evidence: [retargetedBase, oldBase], evaluatedAt: t3 }).gateResults[0]).toMatchObject({ state: "failed" });

    const oldMerged = evidence({
      id: "merge-old-success",
      kind: "source_control.pull_request_state",
      predicate: "state",
      outcome: "merged",
      observedAt: t2
    });
    const reopened = evidence({
      id: "merge-new-open",
      kind: "source_control.pull_request_state",
      predicate: "state",
      outcome: "open",
      observedAt: t3
    });
    expect(evaluateCompletion({ ...baseInput(), evidence: [oldMerged, reopened], evaluatedAt: t3 }).gateResults.find((gate) => gate.gateId === "merge")).toMatchObject({
      state: "failed",
      evidenceIds: [reopened.id],
      reasonCode: "external_state_mismatch"
    });

    const tiedPass = { ...passed, id: "checks-tied-pass", observedAt: t3, receivedAt: t3 };
    const tied = evaluateCompletion({ ...baseInput(), evidence: [failed, tiedPass], evaluatedAt: t3 });
    expect(tied).toMatchObject({ state: "blocked" });
    expect(tied.gateResults.find((gate) => gate.gateId === "checks")).toMatchObject({
      state: "unknown",
      evidenceIds: [failed.id, tiedPass.id].sort(),
      reasonCode: "verification_assurance_insufficient"
    });
  });

  it.each([
    ["newer non-matching role", t1, t2],
    ["same-instant conflicting role", t2, t2]
  ])("uses only authoritative human acceptance for %s", (
    _scenario,
    ownerObservedAt,
    reviewerObservedAt
  ) => {
    const contract: CompletionContract = {
      ...strictContract(),
      targetSelectors: [],
      gates: [{
        id: "approval",
        kind: "human_acceptance",
        requiredRole: "owner"
      }]
    };
    const owner = evidence({
      id: "acceptance-owner",
      kind: "human.acceptance",
      predicate: "role",
      outcome: "owner",
      observedAt: ownerObservedAt
    });
    const reviewer = evidence({
      id: "acceptance-reviewer",
      kind: "human.acceptance",
      predicate: "role",
      outcome: "reviewer",
      observedAt: reviewerObservedAt
    });

    for (const facts of [[owner, reviewer], [reviewer, owner]]) {
      const assessment = evaluateCompletion({
        ...baseInput(),
        contract,
        artifacts: [],
        evidence: facts
      });
      expect(assessment).toMatchObject({
        state: "pending",
        gateResults: [{
          gateId: "approval",
          state: "missing",
          reasonCode: "human_acceptance_missing",
          evidenceIds: []
        }]
      });
    }
  });

  it("canonicalizes target bindings and material action authority across input permutations", () => {
    const duplicateTargetArtifact = prArtifact({ id: "artifact-pr-6" });
    const explicitTime = "2026-07-21T10:04:00.000Z";
    const left = evaluateCompletion({ ...baseInput(), artifacts: [prArtifact(), duplicateTargetArtifact], evaluatedAt: explicitTime });
    const right = evaluateCompletion({ ...baseInput(), artifacts: [duplicateTargetArtifact, prArtifact()], evaluatedAt: explicitTime });
    expect(right).toEqual(left);
    expect(left.targetBindings[0]?.artifactId).toBe("artifact-pr-6");

    const tiedRunA = {
      ...baseInput().runResults[0]!,
      runId: "run-a",
      recordedAt: "2026-07-21T10:01:00Z"
    };
    const tiedRunZ = {
      ...baseInput().runResults[0]!,
      runId: "run-z",
      recordedAt: t1
    };
    const tiedRunsLeft = evaluateCompletion({
      ...baseInput(),
      runResults: [tiedRunA, tiedRunZ],
      evaluatedAt: explicitTime
    });
    const tiedRunsRight = evaluateCompletion({
      ...baseInput(),
      runResults: [tiedRunZ, tiedRunA],
      evaluatedAt: explicitTime
    });
    expect(tiedRunsRight).toEqual(tiedRunsLeft);
    expect(tiedRunsLeft.triggeredByRunId).toBe("run-z");

    const contract: CompletionContract = {
      ...strictContract(),
      gates: [{ id: "publish", kind: "material_action", actionFamily: "release", requiredOutcome: "succeeded" }],
      targetSelectors: []
    };
    const succeeded = {
      id: "receipt-old-success",
      actionId: "action-release",
      provider: "github" as const,
      receiptRef: "receipt:old",
      outcome: "succeeded" as const,
      observedAt: t2,
      metadata: { actionFamily: "release" }
    };
    const unknown = { ...succeeded, id: "receipt-new-unknown", receiptRef: "receipt:new", outcome: "unknown" as const, observedAt: t3 };
    for (const receipts of [[succeeded, unknown], [unknown, succeeded]]) {
      const assessment = evaluateCompletion({ ...baseInput(), contract, artifacts: [], materialActionReceipts: receipts, evaluatedAt: t3 });
      expect(assessment.gateResults[0]).toMatchObject({ state: "unknown", evidenceIds: [unknown.id], reasonCode: "material_action_unknown" });
    }

    const failedTie = { ...unknown, id: "receipt-new-failed", receiptRef: "receipt:failed", outcome: "failed" as const };
    const conflicted = evaluateCompletion({ ...baseInput(), contract, artifacts: [], materialActionReceipts: [failedTie, unknown], evaluatedAt: t3 });
    expect(conflicted.gateResults[0]).toMatchObject({
      state: "unknown",
      evidenceIds: [failedTie.id, unknown.id].sort(),
      reasonCode: "material_action_unknown"
    });
  });

  it("applies only bounded, current-contract waivers", () => {
    const waiver: CompletionWaiver = {
      id: "waiver-1",
      contractId: "contract-github-1",
      contractVersion: 1,
      cycle: 1,
      actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
      reason: "Merge is intentionally deferred for this bounded cycle.",
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["checks", "merge"],
      waivedAt: t2,
      expiresAt: "2026-07-21T11:00:00.000Z"
    };
    const waived = evaluateCompletion({ ...baseInput(), waivers: [waiver], evaluatedAt: t3 });
    expect(waived).toMatchObject({ state: "waived", assessedBy: "human", waiver: { id: waiver.id } });

    const partialWaiver = { ...waiver, id: "waiver-partial", gateIds: ["checks"] };
    const waivedWithMissing = evaluateCompletion({ ...baseInput(), waivers: [partialWaiver], evaluatedAt: t3 });
    expect(waivedWithMissing).toMatchObject({ state: "pending", assessedBy: "human", waiver: { id: partialWaiver.id } });
    expect(waivedWithMissing.acceptedAt).toBeUndefined();

    const blockingEscalation: HumanEscalation = {
      id: "escalation-waived",
      workThreadId: "thread-1",
      class: "verification",
      audience: "repo_owner",
      subjectRef: "github:acme/demo:pull_request:7",
      state: "open",
      blocking: true,
      summary: "Human review remains required.",
      reason: "The waiver does not resolve the active escalation.",
      openedAt: t3
    };
    const waivedWithBlocking = evaluateCompletion({
      ...baseInput(),
      waivers: [waiver],
      blockingEscalations: [blockingEscalation],
      evaluatedAt: t3
    });
    expect(waivedWithBlocking).toMatchObject({ state: "blocked", assessedBy: "human", waiver: { id: waiver.id } });
    expect(waivedWithBlocking.acceptedAt).toBeUndefined();

    const newerCanonical = { ...partialWaiver, id: "waiver-newer", waivedAt: t3 };
    const olderOtherGate = { ...waiver, id: "waiver-older", gateIds: ["merge"], waivedAt: t1 };
    const canonicalOnly = evaluateCompletion({
      ...baseInput(),
      waivers: [olderOtherGate, newerCanonical],
      evaluatedAt: t3
    });
    expect(canonicalOnly).toMatchObject({ state: "pending", waiver: { id: newerCanonical.id } });
    expect(canonicalOnly.gateResults.find((gate) => gate.gateId === "merge")?.state).toBe("missing");

    const newerIrrelevant = { ...waiver, id: "waiver-irrelevant", gateIds: ["not-a-contract-gate"], waivedAt: t3 };
    const irrelevantCannotMask = evaluateCompletion({
      ...baseInput(),
      waivers: [waiver, newerIrrelevant],
      evaluatedAt: t3
    });
    expect(irrelevantCannotMask).toMatchObject({ state: "waived", waiver: { id: waiver.id } });

    const futureWaiver = {
      ...partialWaiver,
      id: "waiver-future",
      waivedAt: "2026-07-21T10:04:00.000Z"
    };
    for (const contract of [strictContract(), compatibilityContract()]) {
      const beforeGrant = evaluateCompletion({
        ...baseInput(),
        contract,
        waivers: [{
          ...futureWaiver,
          contractId: contract.id,
          contractVersion: contract.version,
          cycle: contract.cycle,
          gateIds: [contract.gates[0]!.id]
        }],
        evaluatedAt: t3
      });
      expect(beforeGrant.waiver).toBeUndefined();
      expect(beforeGrant.assessedBy).toBe("opentag");
    }

    const mixedPrecisionFuture = evaluateCompletion({
      ...baseInput(),
      waivers: [{
        ...partialWaiver,
        id: "waiver-future-fractional",
        waivedAt: "2026-07-21T10:03:00.100Z"
      }],
      evaluatedAt: "2026-07-21T10:03:00Z"
    });
    expect(mixedPrecisionFuture.waiver).toBeUndefined();
    expect(mixedPrecisionFuture.assessedBy).toBe("opentag");

    const submillisecondFuture = evaluateCompletion({
      ...baseInput(),
      waivers: [{
        ...partialWaiver,
        id: "waiver-future-submillisecond",
        waivedAt: "2026-07-21T10:03:00.0009Z"
      }],
      evaluatedAt: "2026-07-21T10:03:00.0001Z"
    });
    expect(submillisecondFuture.waiver).toBeUndefined();
    expect(submillisecondFuture.assessedBy).toBe("opentag");

    const tiedZ = {
      ...partialWaiver,
      id: "z",
      waivedAt: "2026-07-21T10:02:00Z"
    };
    const tiedUmlaut = { ...waiver, id: "ä", gateIds: ["merge"], waivedAt: t2 };
    for (const waivers of [[tiedZ, tiedUmlaut], [tiedUmlaut, tiedZ]]) {
      const tiedCanonical = evaluateCompletion({ ...baseInput(), waivers, evaluatedAt: t3 });
      expect(tiedCanonical.waiver?.id).toBe("z");
      expect(tiedCanonical.gateResults.find((gate) => gate.gateId === "checks")?.state).toBe("waived");
      expect(tiedCanonical.gateResults.find((gate) => gate.gateId === "merge")?.state).toBe("missing");
    }

    const expiredAtFinalAssessment = evaluateCompletion({
      ...baseInput(),
      runResults: [{
        ...baseInput().runResults[0]!,
        recordedAt: "2026-07-21T10:03:00.100Z"
      }],
      waivers: [{
        ...partialWaiver,
        expiresAt: "2026-07-21T10:03:00.050Z"
      }],
      evaluatedAt: "2026-07-21T10:03:00Z"
    });
    expect(expiredAtFinalAssessment.state).toBe("pending");
    expect(expiredAtFinalAssessment.waiver).toBeUndefined();

    const expired = evaluateCompletion({ ...baseInput(), waivers: [waiver], evaluatedAt: "2026-07-21T12:00:00.000Z" });
    expect(expired.state).toBe("pending");
    expect(expired.waiver).toBeUndefined();
  });
});

describe("deriveWorkLoopView", () => {
  it("turns completion state into structured native action hints and explicit causes", () => {
    const pendingAssessment = evaluateCompletion(baseInput());
    const pending = deriveWorkLoopView({
      contract: strictContract(),
      runResults: baseInput().runResults,
      assessment: pendingAssessment
    });
    expect(pending.nextAction).toMatchObject({
      summary: "Refresh completion evidence for gate checks.",
      hint: { kind: "refresh_completion_evidence", targetId: "checks" },
      causes: expect.arrayContaining([
        { kind: "completion_gate", gateId: "checks", state: "missing", reasonCode: "verification_missing" },
        { kind: "completion_gate", gateId: "merge", state: "missing", reasonCode: "external_state_missing" }
      ])
    });

    const actionContract: CompletionContract = {
      ...strictContract(),
      gates: [{ id: "publish", kind: "material_action", actionFamily: "release", requiredOutcome: "succeeded" }],
      targetSelectors: []
    };
    const unknownReceipt = {
      id: "receipt-unknown",
      actionId: "action-release",
      provider: "github" as const,
      receiptRef: "receipt:unknown",
      outcome: "unknown" as const,
      observedAt: t2,
      metadata: { actionFamily: "release" }
    };
    const actionInput = {
      ...baseInput(),
      contract: actionContract,
      artifacts: [],
      materialActionReceipts: [unknownReceipt]
    };
    const blockedAssessment = evaluateCompletion(actionInput);
    const blocked = deriveWorkLoopView({
      contract: actionContract,
      runResults: actionInput.runResults,
      materialActionReceipts: actionInput.materialActionReceipts,
      assessment: blockedAssessment
    });
    expect(blocked.nextAction).toMatchObject({
      hint: { kind: "reconcile_material_action", targetId: "action-release" },
      causes: expect.arrayContaining([{
        kind: "material_action",
        actionId: "action-release",
        outcome: "unknown",
        receiptIds: ["receipt-unknown"]
      }])
    });

    const ambiguousArtifactContract: CompletionContract = {
      ...strictContract(),
      gates: [{ id: "pr", kind: "artifact", targetKey: "primary_change", artifactKind: "pull_request", minimum: 1 }]
    };
    const ambiguousArtifactInput = {
      ...baseInput(),
      contract: ambiguousArtifactContract,
      runResults: [{
        runId: "run-failed",
        result: { conclusion: "failure" as const, summary: "The latest Run did not resolve the ambiguity." },
        recordedAt: t3
      }],
      artifacts: [
        prArtifact({ id: "artifact-a", ref: "github:acme/demo:pull_request:7" }),
        prArtifact({ id: "artifact-b", ref: "github:acme/demo:pull_request:8" })
      ]
    };
    const ambiguousArtifactAssessment = evaluateCompletion(ambiguousArtifactInput);
    const ambiguousArtifactView = deriveWorkLoopView({
      contract: ambiguousArtifactContract,
      runResults: ambiguousArtifactInput.runResults,
      assessment: ambiguousArtifactAssessment
    });
    expect(ambiguousArtifactView).toMatchObject({
      completion: "blocked",
      blockedGateIds: ["pr"],
      nextAction: { hint: { kind: "reassess_completion", targetId: "thread-1" } }
    });
    expect(ambiguousArtifactView.nextAction.hint.kind).not.toBe("resume_work_thread");

    const escalation: HumanEscalation = {
      id: "escalation-review",
      workThreadId: "thread-1",
      class: "verification",
      audience: "repo_owner",
      subjectRef: "github:acme/demo:pull_request:7",
      state: "open",
      blocking: true,
      summary: "Repository evidence needs review.",
      reason: "Equally current observations conflict.",
      openedAt: t2
    };
    const escalatedAssessment = evaluateCompletion({ ...baseInput(), blockingEscalations: [escalation] });
    const escalated = deriveWorkLoopView({
      contract: strictContract(),
      runResults: baseInput().runResults,
      blockingEscalations: [escalation],
      assessment: escalatedAssessment
    });
    expect(escalated.nextAction).toMatchObject({
      hint: { kind: "request_human_decision", targetId: escalation.id },
      causes: expect.arrayContaining([{
        kind: "human_escalation",
        escalationId: escalation.id,
        class: "verification",
        audience: "repo_owner",
        blocking: true
      }])
    });

    const checks = evidence({
      id: "checks-terminal",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });
    const merge = evidence({
      id: "merge-terminal",
      kind: "source_control.pull_request_state",
      predicate: "state",
      outcome: "merged"
    });
    const terminalAssessment = evaluateCompletion({ ...baseInput(), evidence: [checks, merge] });
    const terminal = deriveWorkLoopView({
      contract: strictContract(),
      runResults: baseInput().runResults,
      assessment: terminalAssessment
    });
    expect(terminal.nextAction).toEqual({
      summary: "No completion action is required.",
      hint: { kind: "none" },
      causes: []
    });
  });
});

describe("OpenTagGovernance command/query interface", () => {
  it("records evidence, reassesses once, and suppresses duplicate command effects", async () => {
    let snapshot: CompletionEvaluationSnapshot = { ...baseInput(), currentAssessment: null };
    const assessments = new Map<string, ReturnType<typeof evaluateCompletion>>();
    const escalations: HumanEscalation[] = [];
    const repository: GovernanceRepository = {
      async loadEvaluationSnapshot() {
        return snapshot;
      },
      async recordEvidence(item) {
        if (snapshot.evidence.some((existing) => existing.id === item.id)) return { created: false };
        snapshot = { ...snapshot, evidence: [...snapshot.evidence, item] };
        return { created: true };
      },
      async recordWaiver(item) {
        if (snapshot.waivers.some((existing) => existing.id === item.id)) return { created: false };
        snapshot = { ...snapshot, waivers: [...snapshot.waivers, item] };
        return { created: true };
      },
      async resolveHumanEscalation(item) {
        escalations.push(item);
        return { resolved: true };
      },
      async appendAssessment({ assessment, expectedCurrentAssessmentId }) {
        const duplicate = assessments.get(assessment.inputDigest);
        if (duplicate) return { outcome: "duplicate" as const, assessment: duplicate };
        if ((snapshot.currentAssessment?.id ?? null) !== expectedCurrentAssessmentId) {
          return { outcome: "conflict" as const, currentAssessment: snapshot.currentAssessment };
        }
        assessments.set(assessment.inputDigest, assessment);
        snapshot = { ...snapshot, currentAssessment: assessment };
        return { outcome: "recorded" as const, assessment };
      },
      async listHumanEscalations() {
        return escalations;
      }
    };
    const governance = createOpenTagGovernance({
      repository,
      clock: { now: () => t3 },
      ids: { assessmentId: (digest, sequence) => `custom-${digest.slice(-8)}-${sequence}` }
    });
    const checks = evidence({
      id: "checks-verified",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });

    const first = await governance.execute({ type: "ingest_evidence", commandId: "command-1", evidence: checks });
    const replay = await governance.execute({ type: "ingest_evidence", commandId: "command-1", evidence: checks });

    expect(first).toMatchObject({ outcome: "recorded", assessment: { state: "pending" } });
    expect(first.assessment.id).toMatch(/^custom-/u);
    expect(replay).toMatchObject({ outcome: "duplicate", assessment: { id: first.assessment.id } });
    expect(assessments).toHaveLength(1);
    await expect(governance.read({ type: "get_work_loop", workThreadId: "thread-1" })).resolves.toMatchObject({
      execution: "succeeded",
      completion: "pending",
      missingGateIds: ["merge"]
    });

    const waiver: CompletionWaiver = {
      id: "waiver-command-1",
      contractId: "contract-github-1",
      contractVersion: 1,
      cycle: 1,
      actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
      reason: "Merge is intentionally deferred for this bounded cycle.",
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["merge"],
      waivedAt: t2,
      expiresAt: "2026-07-21T11:00:00.000Z"
    };
    const waived = await governance.execute({
      type: "apply_completion_waiver",
      commandId: "waiver-command-1",
      workThreadId: "thread-1",
      waiver
    });
    const waiverReplay = await governance.execute({
      type: "apply_completion_waiver",
      commandId: "waiver-command-1",
      workThreadId: "thread-1",
      waiver
    });

    expect(waived).toMatchObject({ outcome: "recorded", assessment: { state: "waived", waiver: { id: waiver.id } } });
    expect(waiverReplay).toMatchObject({ outcome: "duplicate", assessment: { id: waived.assessment.id } });
    expect(assessments).toHaveLength(2);
  });

  it("serializes concurrent evidence reassessments without regressing the assessment head", async () => {
    let snapshot: CompletionEvaluationSnapshot = { ...baseInput(), currentAssessment: null };
    const assessments: ReturnType<typeof evaluateCompletion>[] = [];
    const repository: GovernanceRepository = {
      async loadEvaluationSnapshot() {
        await Promise.resolve();
        return snapshot;
      },
      async recordEvidence(item) {
        if (snapshot.evidence.some((existing) => existing.id === item.id)) return { created: false };
        snapshot = { ...snapshot, evidence: [...snapshot.evidence, item] };
        return { created: true };
      },
      async recordWaiver() {
        return { created: false };
      },
      async resolveHumanEscalation() {
        return { resolved: false };
      },
      async appendAssessment({ assessment, expectedCurrentAssessmentId }) {
        await Promise.resolve();
        const duplicate = assessments.find((item) => item.inputDigest === assessment.inputDigest);
        if (duplicate) return { outcome: "duplicate" as const, assessment: duplicate };
        if ((snapshot.currentAssessment?.id ?? null) !== expectedCurrentAssessmentId) {
          return { outcome: "conflict" as const, currentAssessment: snapshot.currentAssessment };
        }
        assessments.push(assessment);
        snapshot = { ...snapshot, currentAssessment: assessment };
        return { outcome: "recorded" as const, assessment };
      },
      async listHumanEscalations() {
        return [];
      }
    };
    const governance = createOpenTagGovernance({ repository, clock: { now: () => t3 } });
    const checks = evidence({
      id: "checks-concurrent",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });
    const merge = evidence({
      id: "merge-concurrent",
      kind: "source_control.pull_request_state",
      predicate: "state",
      outcome: "merged"
    });

    await Promise.all([
      governance.execute({ type: "ingest_evidence", commandId: "checks", evidence: checks }),
      governance.execute({ type: "ingest_evidence", commandId: "merge", evidence: merge })
    ]);

    expect(snapshot.currentAssessment).toMatchObject({ state: "satisfied", sequence: assessments.length });
    expect(assessments.map((item) => item.sequence)).toEqual(assessments.map((_, index) => index + 1));
    expect(assessments.at(-1)?.inputDigest).toBe(completionInputDigest({ ...baseInput(), evidence: [checks, merge] }));
  });

  it("replays durable inputs without a new assessment and preserves first acceptance time", async () => {
    const checks = evidence({
      id: "checks-accepted",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });
    const merge = evidence({
      id: "merge-accepted",
      kind: "source_control.pull_request_state",
      predicate: "state",
      outcome: "merged"
    });
    let snapshot: CompletionEvaluationSnapshot = { ...baseInput(), evidence: [checks, merge], currentAssessment: null };
    const assessments: ReturnType<typeof evaluateCompletion>[] = [];
    const repository: GovernanceRepository = {
      async loadEvaluationSnapshot() { return snapshot; },
      async recordEvidence(item) {
        if (snapshot.evidence.some((existing) => existing.id === item.id)) return { created: false };
        snapshot = { ...snapshot, evidence: [...snapshot.evidence, item] };
        return { created: true };
      },
      async recordWaiver() { return { created: false }; },
      async resolveHumanEscalation() { return { resolved: false }; },
      async appendAssessment({ assessment, expectedCurrentAssessmentId }) {
        if ((snapshot.currentAssessment?.id ?? null) !== expectedCurrentAssessmentId) {
          return { outcome: "conflict" as const, currentAssessment: snapshot.currentAssessment };
        }
        assessments.push(assessment);
        snapshot = { ...snapshot, currentAssessment: assessment };
        return { outcome: "recorded" as const, assessment };
      },
      async listHumanEscalations() { return []; }
    };
    let now = t3;
    const governance = createOpenTagGovernance({ repository, clock: { now: () => now } });
    const accepted = await governance.execute({ type: "reassess_completion", commandId: "first", workThreadId: "thread-1" });
    now = "2026-07-21T10:10:00.000Z";
    const replay = await governance.execute({ type: "reassess_completion", commandId: "replay", workThreadId: "thread-1" });
    const unrelated = evidence({
      id: "unrelated-accepted",
      kind: "source_control.review",
      predicate: "review",
      outcome: "approved",
      observedAt: now
    });
    const reassessed = await governance.execute({ type: "ingest_evidence", commandId: "unrelated", evidence: unrelated });

    expect(accepted.assessment).toMatchObject({ state: "satisfied", acceptedAt: t2, sequence: 1 });
    expect(replay).toMatchObject({ outcome: "duplicate", assessment: { id: accepted.assessment.id, sequence: 1 } });
    expect(reassessed.assessment).toMatchObject({ state: "satisfied", acceptedAt: t2, sequence: 2 });
    expect(assessments).toHaveLength(2);
  });

  it("CAS-safely supersedes a stored waived assessment when the waiver expires on reassess or read", async () => {
    const waiver: CompletionWaiver = {
      id: "waiver-expiring",
      contractId: "contract-github-1",
      contractVersion: 1,
      cycle: 1,
      actor: { provider: "github", providerUserId: "owner-1" },
      reason: "Bounded temporary exception.",
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["checks", "merge"],
      waivedAt: t2,
      expiresAt: "2026-07-21T10:05:00.000Z"
    };
    let snapshot: CompletionEvaluationSnapshot = { ...baseInput(), waivers: [waiver], currentAssessment: null };
    const assessments: ReturnType<typeof evaluateCompletion>[] = [];
    const repository: GovernanceRepository = {
      async loadEvaluationSnapshot() { return snapshot; },
      async recordEvidence() { return { created: false }; },
      async recordWaiver() { return { created: false }; },
      async resolveHumanEscalation() { return { resolved: false }; },
      async appendAssessment({ assessment, expectedCurrentAssessmentId }) {
        const duplicate = assessments.find((item) => item.inputDigest === assessment.inputDigest);
        if (duplicate) return { outcome: "duplicate" as const, assessment: duplicate };
        if ((snapshot.currentAssessment?.id ?? null) !== expectedCurrentAssessmentId) {
          return { outcome: "conflict" as const, currentAssessment: snapshot.currentAssessment };
        }
        assessments.push(assessment);
        snapshot = { ...snapshot, currentAssessment: assessment };
        return { outcome: "recorded" as const, assessment };
      },
      async listHumanEscalations() { return []; }
    };
    let now = t3;
    const governance = createOpenTagGovernance({ repository, clock: { now: () => now } });
    const initial = await governance.execute({ type: "reassess_completion", commandId: "initial", workThreadId: "thread-1" });
    expect(initial.assessment).toMatchObject({ state: "waived", sequence: 1 });

    now = "2026-07-21T10:06:00.000Z";
    const [read, reassessed] = await Promise.all([
      governance.read({ type: "explain_completion", workThreadId: "thread-1" }),
      governance.execute({ type: "reassess_completion", commandId: "expired", workThreadId: "thread-1" })
    ]);
    expect(read).toMatchObject({ state: "pending", sequence: 2, supersedesAssessmentId: initial.assessment.id });
    expect(reassessed.assessment).toMatchObject({ state: "pending", sequence: 2, supersedesAssessmentId: initial.assessment.id });
    expect(snapshot.currentAssessment).toMatchObject({ state: "pending", sequence: 2 });
    expect(assessments).toHaveLength(2);

    await expect(governance.read({ type: "get_work_loop", workThreadId: "thread-1" })).resolves.toMatchObject({ completion: "pending" });
    expect(assessments).toHaveLength(2);
  });
});
