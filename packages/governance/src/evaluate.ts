import { createHash } from "node:crypto";
import {
  CompletionAssessmentSchema,
  compareCompletionGateIds,
  compareRfc3339Timestamps,
  CompletionContractSchema,
  CompletionGateResultSchema,
  reduceCompletionGateStates,
  type CompletionAssessment,
  type CompletionGate,
  type CompletionGateResult,
  type CompletionReasonCode,
  type CompletionWaiver,
  type ResolvedCompletionTarget
} from "@opentag/core";
import type {
  CompletionArtifact,
  CompletionEvaluationInput,
  CompletionEvidenceFact,
  WorkLoopCause,
  WorkLoopView
} from "./types.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

export function completionInputDigest(input: Omit<CompletionEvaluationInput, "lineage">): string {
  const waiverEvaluationTime = input.evaluatedAt ?? latestTimestamp(input);
  const ordered = {
    contract: input.contract,
    runResults: [...input.runResults].sort((left, right) => left.runId.localeCompare(right.runId)),
    artifacts: [...input.artifacts].sort((left, right) => left.id.localeCompare(right.id)),
    evidence: [...input.evidence].sort((left, right) => left.id.localeCompare(right.id)),
    materialActionReceipts: [...input.materialActionReceipts].sort((left, right) => left.id.localeCompare(right.id)),
    waivers: [...input.waivers].sort((left, right) => left.id.localeCompare(right.id)),
    blockingEscalations: [...(input.blockingEscalations ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    waiverValidity: [...input.waivers]
      .filter((waiver) => Boolean(waiver.expiresAt))
      .map((waiver) => ({
        id: waiver.id,
        active: compareRfc3339Timestamps(waiver.expiresAt!, waiverEvaluationTime) > 0
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(ordered))).digest("hex")}`;
}

function latestTimestamp(input: CompletionEvaluationInput): string {
  const timestamps = [
    input.contract.createdAt,
    ...input.runResults.map((item) => item.recordedAt),
    ...input.artifacts.map((item) => item.recordedAt),
    ...input.evidence.flatMap((item) => [item.observedAt, item.receivedAt]),
    ...input.materialActionReceipts.map((item) => item.observedAt),
    ...input.waivers.map((item) => item.waivedAt),
    ...(input.blockingEscalations ?? []).flatMap((item) => [
      item.openedAt,
      ...(item.resolution?.resolvedAt ? [item.resolution.resolvedAt] : [])
    ])
  ];
  return latestExactTimestamp(timestamps);
}

function latestExactTimestamp(timestamps: readonly string[]): string {
  return timestamps.slice(1).reduce((latest, timestamp) => {
    const instantOrder = compareRfc3339Timestamps(timestamp, latest);
    if (instantOrder > 0) return timestamp;
    if (instantOrder < 0) return latest;
    return compareCompletionGateIds(timestamp, latest) < 0 ? timestamp : latest;
  }, timestamps[0]!);
}

function activeBlockingEscalations(input: CompletionEvaluationInput) {
  return (input.blockingEscalations ?? []).filter((escalation) =>
    escalation.blocking && (escalation.state === "open" || escalation.state === "acknowledged")
  );
}

function assessmentTimestamp(input: CompletionEvaluationInput, evaluationTime: string): string {
  const expiredBoundaries = input.waivers.flatMap((waiver) =>
    waiver.expiresAt
      && compareRfc3339Timestamps(waiver.expiresAt, evaluationTime) <= 0
      ? [waiver.expiresAt]
      : []
  );
  const timestamps = [latestTimestamp(input), ...expiredBoundaries];
  return latestExactTimestamp(timestamps);
}

function canonicalLatestRunResult(
  runResults: CompletionEvaluationInput["runResults"]
) {
  return [...runResults]
    .sort((left, right) =>
      compareRfc3339Timestamps(left.recordedAt, right.recordedAt)
      || compareCompletionGateIds(left.runId, right.runId)
    )
    .at(-1);
}

function assuranceAccepted(actual: CompletionEvidenceFact["assurance"], minimum: "verified" | "reported"): boolean {
  if (actual === "unverifiable") return false;
  return minimum === "verified" ? actual === "verified" : actual === "verified" || actual === "reported";
}

function validWaiverForAssessment(
  waiver: CompletionWaiver,
  input: CompletionEvaluationInput,
  evaluationTime: string,
  assessedAt: string
): boolean {
  const currentRunId = canonicalLatestRunResult(input.runResults)?.runId;
  return waiver.contractId === input.contract.id
    && waiver.contractVersion === input.contract.version
    && waiver.cycle === input.contract.cycle
    && (!waiver.runId || waiver.runId === currentRunId)
    && compareRfc3339Timestamps(waiver.waivedAt, evaluationTime) <= 0
    && compareRfc3339Timestamps(waiver.waivedAt, assessedAt) <= 0
    && (
      !waiver.expiresAt
      || (
        compareRfc3339Timestamps(waiver.expiresAt, evaluationTime) > 0
        && compareRfc3339Timestamps(waiver.expiresAt, assessedAt) > 0
      )
    );
}

function canonicalActiveWaiver(
  input: CompletionEvaluationInput,
  evaluationTime: string,
  assessedAt: string
): CompletionWaiver | undefined {
  const contractGateIds = new Set(input.contract.gates.map((gate) => gate.id));
  return input.waivers
    .filter((waiver) =>
      validWaiverForAssessment(waiver, input, evaluationTime, assessedAt)
      && waiver.gateIds.every((gateId) => contractGateIds.has(gateId))
    )
    .sort((left, right) => {
      const waiverTimeOrder = compareRfc3339Timestamps(
        left.waivedAt,
        right.waivedAt
      );
      if (waiverTimeOrder !== 0) return -waiverTimeOrder;
      return compareCompletionGateIds(left.id, right.id);
    })[0];
}

function resolvedTargets(input: CompletionEvaluationInput): {
  bindings: ResolvedCompletionTarget[];
  artifactsByTarget: Map<string, CompletionArtifact[]>;
  ambiguousKeys: Set<string>;
} {
  const artifactsByTarget = new Map<string, CompletionArtifact[]>();
  for (const artifact of input.artifacts) {
    if (!artifact.target) continue;
    const current = artifactsByTarget.get(artifact.target.key) ?? [];
    current.push(artifact);
    artifactsByTarget.set(artifact.target.key, current);
  }
  const bindings: ResolvedCompletionTarget[] = [];
  const ambiguousKeys = new Set<string>();
  for (const selector of input.contract.targetSelectors) {
    const candidates = [...(artifactsByTarget.get(selector.key) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    const identities = new Map<string, CompletionArtifact[]>();
    for (const artifact of candidates) {
      const identity = JSON.stringify([artifact.target?.provider, artifact.target?.resourceRef, artifact.target?.resourceVersion]);
      identities.set(identity, [...(identities.get(identity) ?? []), artifact]);
    }
    if (identities.size > 1) {
      ambiguousKeys.add(selector.key);
      continue;
    }
    const candidate = [...identities.values()][0]?.[0];
    if (!candidate?.target) continue;
    bindings.push({
      key: selector.key,
      provider: candidate.target.provider as ResolvedCompletionTarget["provider"],
      resourceRef: candidate.target.resourceRef,
      resourceVersion: candidate.target.resourceVersion,
      artifactId: candidate.id
    });
  }
  return { bindings, artifactsByTarget, ambiguousKeys };
}

function authoritativeEvidence(facts: CompletionEvidenceFact[]): {
  facts: CompletionEvidenceFact[];
  conflicted: boolean;
} {
  if (facts.length === 0) return { facts: [], conflicted: false };
  const ordered = [...facts].sort((left, right) =>
    compareRfc3339Timestamps(right.observedAt, left.observedAt)
    || compareRfc3339Timestamps(right.receivedAt, left.receivedAt)
    || compareCompletionGateIds(left.id, right.id)
  );
  const latest = ordered[0]!;
  const tied = ordered.filter((item) =>
    compareRfc3339Timestamps(item.observedAt, latest.observedAt) === 0
    && compareRfc3339Timestamps(item.receivedAt, latest.receivedAt) === 0
  );
  const claims = new Set(tied.map((item) => JSON.stringify(canonicalize({ assurance: item.assurance, claim: item.claim }))));
  return { facts: tied, conflicted: claims.size > 1 };
}

function currentReceipt(receipts: CompletionEvaluationInput["materialActionReceipts"]): {
  receipts: CompletionEvaluationInput["materialActionReceipts"];
  conflicted: boolean;
} {
  if (receipts.length === 0) return { receipts: [], conflicted: false };
  const ordered = [...receipts].sort((left, right) =>
    compareRfc3339Timestamps(right.observedAt, left.observedAt)
    || compareCompletionGateIds(left.id, right.id)
  );
  const latest = ordered[0]!;
  const tied = ordered.filter((item) =>
    compareRfc3339Timestamps(item.observedAt, latest.observedAt) === 0
  );
  return { receipts: tied, conflicted: new Set(tied.map((item) => item.outcome)).size > 1 };
}

function result(input: Omit<CompletionGateResult, "evaluatedAt">, evaluatedAt: string): CompletionGateResult {
  return CompletionGateResultSchema.parse({ ...input, evaluatedAt });
}

function targetEvidence(
  evidence: CompletionEvidenceFact[],
  target: ResolvedCompletionTarget,
  kind?: string
): CompletionEvidenceFact[] {
  return evidence.filter((item) =>
    (!kind || item.kind === kind)
    && item.subject.provider === target.provider
    && item.subject.resourceRef === target.resourceRef
    && item.subject.resourceVersion === target.resourceVersion
  );
}

function staleTargetEvidence(
  evidence: CompletionEvidenceFact[],
  target: ResolvedCompletionTarget,
  kind?: string
): CompletionEvidenceFact[] {
  return evidence.filter((item) =>
    (!kind || item.kind === kind)
    && item.subject.provider === target.provider
    && item.subject.resourceRef === target.resourceRef
    && item.subject.resourceVersion !== target.resourceVersion
  );
}

function evaluateGate(
  gate: CompletionGate,
  input: CompletionEvaluationInput,
  targetByKey: Map<string, ResolvedCompletionTarget>,
  artifactsByTarget: Map<string, CompletionArtifact[]>,
  ambiguousKeys: Set<string>,
  evaluatedAt: string,
  activeWaiver: CompletionWaiver | undefined
): CompletionGateResult {
  if (activeWaiver?.gateIds.includes(gate.id)) {
    return result({ gateId: gate.id, ...(gate.targetKey ? { targetKey: gate.targetKey } : {}), state: "waived", evidenceIds: [], reasonCode: "gate_waived", reason: `Gate waived by ${activeWaiver.actor.handle ?? activeWaiver.actor.providerUserId}.` }, evaluatedAt);
  }
  const target = gate.targetKey ? targetByKey.get(gate.targetKey) : undefined;
  if (gate.targetKey && ambiguousKeys.has(gate.targetKey)) {
    return result({ gateId: gate.id, targetKey: gate.targetKey, state: "unknown", evidenceIds: [], reasonCode: "artifact_ambiguous", reason: "Multiple delivery targets are present for this work cycle." }, evaluatedAt);
  }
  if (gate.kind === "artifact") {
    const candidates = artifactsByTarget.get(gate.targetKey) ?? [];
    const matching = candidates.filter((artifact) => artifact.kind === gate.artifactKind);
    if (!target || matching.length < gate.minimum) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "missing", evidenceIds: [], reasonCode: "artifact_missing", reason: `Missing ${gate.artifactKind} artifact for the current delivery target.` }, evaluatedAt);
    }
    return result({ gateId: gate.id, targetKey: gate.targetKey, state: "passed", evidenceIds: matching.map((artifact) => artifact.id).sort(), reasonCode: "artifact_requirement_satisfied", reason: `${matching.length} matching ${gate.artifactKind} artifact(s) recorded.` }, evaluatedAt);
  }
  if (gate.kind === "verification") {
    if (!target) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "missing", evidenceIds: [], reasonCode: "verification_missing", reason: "The delivery target has not been resolved." }, evaluatedAt);
    }
    const matching = targetEvidence(input.evidence, target, gate.evidenceKind);
    if (matching.length === 0) {
      const stale = staleTargetEvidence(input.evidence, target, gate.evidenceKind);
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "missing", evidenceIds: stale.map((item) => item.id).sort(), reasonCode: stale.length > 0 ? "verification_stale" : "verification_missing", reason: stale.length > 0 ? "Verification exists only for a different resource version." : "Required verification evidence has not arrived." }, evaluatedAt);
    }
    const authoritative = authoritativeEvidence(matching);
    if (authoritative.conflicted) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "unknown", evidenceIds: authoritative.facts.map((item) => item.id).sort(), reasonCode: "verification_assurance_insufficient", reason: "Equally current authoritative verification observations conflict." }, evaluatedAt);
    }
    const assured = authoritative.facts.filter((item) => assuranceAccepted(item.assurance, gate.minimumAssurance));
    if (assured.length === 0) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "unknown", evidenceIds: authoritative.facts.map((item) => item.id).sort(), reasonCode: "verification_assurance_insufficient", reason: `Verification requires ${gate.minimumAssurance} evidence.` }, evaluatedAt);
    }
    const requiredObservationsPassed = (item: CompletionEvidenceFact) => (gate.requiredObservations ?? []).every(
      (name) => item.claim.observations?.[name] === "passed"
    );
    const passed = assured.find((item) => item.claim.outcome === gate.requiredOutcome && requiredObservationsPassed(item));
    if (!passed) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "failed", evidenceIds: assured.map((item) => item.id).sort(), reasonCode: "verification_failed", reason: "Verified evidence does not satisfy the required outcome and observations." }, evaluatedAt);
    }
    return result({ gateId: gate.id, targetKey: gate.targetKey, state: "passed", evidenceIds: [passed.id], reasonCode: "verification_passed", reason: "Required verification passed for the current resource version." }, evaluatedAt);
  }
  if (gate.kind === "external_state") {
    if (!target) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "missing", evidenceIds: [], reasonCode: "external_state_missing", reason: "The delivery target has not been resolved." }, evaluatedAt);
    }
    if (target.provider !== gate.provider) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "unknown", evidenceIds: [], reasonCode: "external_state_subject_mismatch", reason: "The resolved target provider does not match this gate." }, evaluatedAt);
    }
    const matching = targetEvidence(input.evidence, target).filter((item) => item.claim.predicate === "state");
    if (matching.length === 0) {
      const stale = staleTargetEvidence(input.evidence, target).filter((item) => item.claim.predicate === "state");
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "missing", evidenceIds: stale.map((item) => item.id).sort(), reasonCode: stale.length > 0 ? "external_state_stale" : "external_state_missing", reason: stale.length > 0 ? "External state exists only for a different resource version." : "Required external state evidence has not arrived." }, evaluatedAt);
    }
    const authoritative = authoritativeEvidence(matching);
    if (authoritative.conflicted) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "unknown", evidenceIds: authoritative.facts.map((item) => item.id).sort(), reasonCode: "external_state_assurance_insufficient", reason: "Equally current authoritative external-state observations conflict." }, evaluatedAt);
    }
    const assured = authoritative.facts.filter((item) => assuranceAccepted(item.assurance, gate.minimumAssurance));
    if (assured.length === 0) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "unknown", evidenceIds: authoritative.facts.map((item) => item.id).sort(), reasonCode: "external_state_assurance_insufficient", reason: `External state requires ${gate.minimumAssurance} evidence.` }, evaluatedAt);
    }
    const satisfied = assured.find((item) => item.claim.outcome === gate.requiredState);
    if (!satisfied) {
      return result({ gateId: gate.id, targetKey: gate.targetKey, state: "failed", evidenceIds: assured.map((item) => item.id).sort(), reasonCode: "external_state_mismatch", reason: `Verified external state is not ${gate.requiredState}.` }, evaluatedAt);
    }
    return result({ gateId: gate.id, targetKey: gate.targetKey, state: "passed", evidenceIds: [satisfied.id], reasonCode: "external_state_satisfied", reason: `Verified external state is ${gate.requiredState}.` }, evaluatedAt);
  }
  if (gate.kind === "material_action") {
    const receipts = input.materialActionReceipts.filter((receipt) => receipt.metadata?.["actionFamily"] === gate.actionFamily);
    const current = currentReceipt(receipts);
    if (current.conflicted) return result({ gateId: gate.id, ...(gate.targetKey ? { targetKey: gate.targetKey } : {}), state: "unknown", evidenceIds: current.receipts.map((receipt) => receipt.id).sort(), reasonCode: "material_action_unknown", reason: "Equally current material action receipts conflict and require reconciliation." }, evaluatedAt);
    const succeeded = current.receipts.find((receipt) => receipt.outcome === gate.requiredOutcome);
    if (succeeded) return result({ gateId: gate.id, ...(gate.targetKey ? { targetKey: gate.targetKey } : {}), state: "passed", evidenceIds: [succeeded.id], reasonCode: "material_action_succeeded", reason: "The required material action has a succeeded receipt." }, evaluatedAt);
    const unknown = current.receipts.find((receipt) => receipt.outcome === "unknown");
    if (unknown) return result({ gateId: gate.id, ...(gate.targetKey ? { targetKey: gate.targetKey } : {}), state: "unknown", evidenceIds: [unknown.id], reasonCode: "material_action_unknown", reason: "The material action outcome is unknown and requires reconciliation." }, evaluatedAt);
    const failed = current.receipts.find((receipt) => receipt.outcome === "failed");
    if (failed) return result({ gateId: gate.id, ...(gate.targetKey ? { targetKey: gate.targetKey } : {}), state: "failed", evidenceIds: [failed.id], reasonCode: "material_action_failed", reason: "The required material action failed." }, evaluatedAt);
    return result({ gateId: gate.id, ...(gate.targetKey ? { targetKey: gate.targetKey } : {}), state: "missing", evidenceIds: [], reasonCode: "material_action_missing", reason: "No receipt exists for the required material action." }, evaluatedAt);
  }
  const authoritative = authoritativeEvidence(input.evidence.filter((item) =>
    item.kind === "human.acceptance" && item.claim.predicate === "role"
  ));
  const acceptance = authoritative.conflicted
    ? undefined
    : authoritative.facts.find((item) =>
        item.claim.outcome === gate.requiredRole && item.assurance === "verified"
      );
  return acceptance
    ? result({ gateId: gate.id, ...(gate.targetKey ? { targetKey: gate.targetKey } : {}), state: "passed", evidenceIds: [acceptance.id], reasonCode: "human_acceptance_recorded", reason: `Acceptance recorded for role ${gate.requiredRole}.` }, evaluatedAt)
    : result({ gateId: gate.id, ...(gate.targetKey ? { targetKey: gate.targetKey } : {}), state: "missing", evidenceIds: [], reasonCode: "human_acceptance_missing", reason: `Acceptance from role ${gate.requiredRole} is missing.` }, evaluatedAt);
}

function compatibilityAssessment(
  input: CompletionEvaluationInput,
  inputDigest: string,
  evaluatedAt: string,
  evaluationTime: string
): CompletionAssessment {
  const latestResult = canonicalLatestRunResult(input.runResults);
  const blockingEscalations = activeBlockingEscalations(input);
  const activeWaiver = canonicalActiveWaiver(
    input,
    evaluationTime,
    evaluatedAt
  );
  const sequence = input.lineage?.sequence ?? 1;
  const executionGateId = input.contract.gates[0]?.id ?? "execution";
  const executionWaived = activeWaiver?.gateIds.includes(executionGateId) ?? false;
  const executionGate: CompletionGateResult = executionWaived
    ? result({
      gateId: executionGateId,
      state: "waived",
      evidenceIds: [],
      reasonCode: "gate_waived",
      reason: `Gate waived by ${activeWaiver?.actor.handle ?? activeWaiver?.actor.providerUserId}.`
    }, evaluatedAt)
    : latestResult?.result.conclusion === "success"
      ? result({
        gateId: executionGateId,
        state: "passed",
        evidenceIds: [latestResult.runId],
        reasonCode: "execution_succeeded",
        reason: "Executor run succeeded under the compatibility contract."
      }, evaluatedAt)
      : latestResult
        ? result({
          gateId: executionGateId,
          state: "failed",
          evidenceIds: [],
          reasonCode: "execution_not_succeeded",
          reason: "The terminal executor result did not succeed."
        }, evaluatedAt)
        : result({
          gateId: executionGateId,
          state: "missing",
          evidenceIds: [],
          reasonCode: "execution_incomplete",
          reason: "No terminal executor result is available."
        }, evaluatedAt);
  const effectiveGateResults = [executionGate, ...blockingEscalations.map((escalation) => ({
    gateId: `human_escalation:${escalation.id}`,
    state: "unknown" as const,
    evidenceIds: [escalation.id],
    reasonCode: "human_acceptance_missing" as const,
    reason: escalation.reason,
    evaluatedAt
  }))].sort((left, right) => compareCompletionGateIds(left.gateId, right.gateId));
  const state = reduceCompletionGateStates(effectiveGateResults.map((gate) => gate.state));
  return CompletionAssessmentSchema.parse({
    id: `assessment_${inputDigest.slice("sha256:".length, "sha256:".length + 24)}_${sequence}`,
    workThreadId: input.contract.workThreadId,
    ...(latestResult ? { triggeredByRunId: latestResult.runId } : {}),
    contractId: input.contract.id,
    contractVersion: input.contract.version,
    cycle: input.contract.cycle,
    sequence,
    inputDigest,
    targetBindings: [],
    state,
    evidenceBacked: false,
    gateResults: effectiveGateResults,
    assessedAt: evaluatedAt,
    assessedBy: executionWaived ? "human" : "opentag",
    ...(input.lineage?.supersedesAssessmentId ? { supersedesAssessmentId: input.lineage.supersedesAssessmentId } : {}),
    ...((state === "satisfied" || state === "waived") ? { acceptedAt: evaluatedAt } : {}),
    ...(executionWaived ? { waiver: activeWaiver } : {})
  });
}

export function evaluateCompletion(inputValue: CompletionEvaluationInput): CompletionAssessment {
  const input = { ...inputValue, contract: CompletionContractSchema.parse(inputValue.contract) };
  const evaluationTime = input.evaluatedAt ?? latestTimestamp(input);
  const evaluatedAt = assessmentTimestamp(input, evaluationTime);
  const inputDigest = completionInputDigest({ ...input, evaluatedAt: evaluationTime });
  if (input.contract.mode === "execution_compat") {
    return compatibilityAssessment(input, inputDigest, evaluatedAt, evaluationTime);
  }

  const { bindings, artifactsByTarget, ambiguousKeys } = resolvedTargets(input);
  const targetByKey = new Map(bindings.map((target) => [target.key, target]));
  const activeWaiver = canonicalActiveWaiver(
    input,
    evaluationTime,
    evaluatedAt
  );
  const gateResults = input.contract.gates.map((gate) => evaluateGate(
    gate,
    input,
    targetByKey,
    artifactsByTarget,
    ambiguousKeys,
    evaluatedAt,
    activeWaiver
  ));
  const blockingEscalations = activeBlockingEscalations(input);
  const effectiveGateResults = [
    ...gateResults,
    ...blockingEscalations.map((escalation) => ({
      gateId: `human_escalation:${escalation.id}`,
      state: "unknown" as const,
      evidenceIds: [escalation.id],
      reasonCode: "human_acceptance_missing" as const,
      reason: escalation.reason,
      evaluatedAt
    }))
  ].sort((left, right) => compareCompletionGateIds(left.gateId, right.gateId));
  const state = reduceCompletionGateStates(effectiveGateResults.map((gate) => gate.state));
  const sequence = input.lineage?.sequence ?? 1;
  const appliedWaiver = gateResults.some((gate) => gate.state === "waived") ? activeWaiver : undefined;
  const latestRunResult = canonicalLatestRunResult(input.runResults);
  return CompletionAssessmentSchema.parse({
    id: `assessment_${inputDigest.slice("sha256:".length, "sha256:".length + 24)}_${sequence}`,
    workThreadId: input.contract.workThreadId,
    ...(latestRunResult ? { triggeredByRunId: latestRunResult.runId } : {}),
    contractId: input.contract.id,
    contractVersion: input.contract.version,
    cycle: input.contract.cycle,
    sequence,
    inputDigest,
    targetBindings: bindings,
    state,
    evidenceBacked: true,
    gateResults: effectiveGateResults,
    assessedAt: evaluatedAt,
    assessedBy: appliedWaiver ? "human" : "opentag",
    ...(input.lineage?.supersedesAssessmentId ? { supersedesAssessmentId: input.lineage.supersedesAssessmentId } : {}),
    ...((state === "satisfied" || state === "waived") ? { acceptedAt: evaluatedAt } : {}),
    ...(appliedWaiver ? { waiver: appliedWaiver } : {})
  });
}

export function deriveWorkLoopView(input: {
  contract: CompletionEvaluationInput["contract"];
  runResults: CompletionEvaluationInput["runResults"];
  materialActionReceipts?: CompletionEvaluationInput["materialActionReceipts"];
  blockingEscalations?: CompletionEvaluationInput["blockingEscalations"];
  assessment: CompletionAssessment;
}): WorkLoopView {
  const latestRunResult = canonicalLatestRunResult(input.runResults);
  const latestResult = latestRunResult?.result;
  const execution = latestResult?.conclusion === "success"
    ? "succeeded"
    : latestResult?.conclusion === "failure"
      ? "failed"
      : latestResult?.conclusion ?? "idle";
  const assessmentGateById = new Map(input.assessment.gateResults.map((gate) => [gate.gateId, gate]));
  const contractGateIds = new Set(input.contract.gates.map((gate) => gate.id));
  const orderedGateResults = [
    ...input.contract.gates.map((gate) => assessmentGateById.get(gate.id)).filter((gate) => gate !== undefined),
    ...input.assessment.gateResults.filter((gate) => !contractGateIds.has(gate.gateId))
  ];
  const missingGateIds = orderedGateResults.filter((gate) => gate.state === "missing").map((gate) => gate.gateId);
  const failedGateIds = orderedGateResults.filter((gate) => gate.state === "failed").map((gate) => gate.gateId);
  const blockedGateIds = orderedGateResults.filter((gate) => gate.state === "unknown").map((gate) => gate.gateId);
  const gateCauses: WorkLoopCause[] = orderedGateResults
    .filter((gate) => gate.state !== "passed" && gate.state !== "waived")
    .map((gate) => ({
      kind: "completion_gate",
      gateId: gate.gateId,
      state: gate.state,
      reasonCode: gate.reasonCode
    }));
  const activeEscalations = [...(input.blockingEscalations ?? [])]
    .filter((escalation) => escalation.blocking && (escalation.state === "open" || escalation.state === "acknowledged"))
    .sort((left, right) => left.id.localeCompare(right.id));
  const escalationCauses: WorkLoopCause[] = activeEscalations.map((escalation) => ({
    kind: "human_escalation",
    escalationId: escalation.id,
    class: escalation.class,
    audience: escalation.audience,
    blocking: true
  }));
  const receiptsById = new Map((input.materialActionReceipts ?? []).map((receipt) => [receipt.id, receipt]));
  const materialActionCausesById = new Map<string, Extract<WorkLoopCause, { kind: "material_action" }>>();
  for (const gate of orderedGateResults) {
    if (gate.reasonCode !== "material_action_failed" && gate.reasonCode !== "material_action_unknown") continue;
    const outcome = gate.reasonCode === "material_action_failed" ? "failed" : "unknown";
    for (const receiptId of gate.evidenceIds) {
      const receipt = receiptsById.get(receiptId);
      if (!receipt) continue;
      const current = materialActionCausesById.get(receipt.actionId);
      materialActionCausesById.set(receipt.actionId, {
        kind: "material_action",
        actionId: receipt.actionId,
        outcome: current?.outcome === "unknown" || outcome === "unknown" ? "unknown" : "failed",
        receiptIds: [...new Set([...(current?.receiptIds ?? []), receipt.id])].sort()
      });
    }
  }
  const materialActionCauses: WorkLoopCause[] = [...materialActionCausesById.values()]
    .sort((left, right) => left.actionId.localeCompare(right.actionId));
  const runCauses: WorkLoopCause[] = latestRunResult && latestRunResult.result.conclusion !== "success"
    ? [{ kind: "run", runId: latestRunResult.runId, conclusion: latestRunResult.result.conclusion }]
    : [];
  const causes = [...escalationCauses, ...materialActionCauses, ...gateCauses, ...runCauses];

  const refreshReasonCodes = new Set<CompletionReasonCode>([
    "verification_missing",
    "verification_assurance_insufficient",
    "verification_subject_mismatch",
    "verification_stale",
    "external_state_missing",
    "external_state_assurance_insufficient",
    "external_state_subject_mismatch",
    "external_state_stale"
  ]);
  const refreshGate = orderedGateResults.find((gate) =>
    gate.state !== "passed" && gate.state !== "waived" && refreshReasonCodes.has(gate.reasonCode)
  );
  const humanGate = orderedGateResults.find((gate) => gate.reasonCode === "human_acceptance_missing");
  const unknownMaterialAction = materialActionCauses.find((cause) =>
    cause.kind === "material_action" && cause.outcome === "unknown"
  );
  const nextAction = input.assessment.state === "satisfied" || input.assessment.state === "waived"
    ? {
        summary: "No completion action is required.",
        hint: { kind: "none" as const },
        causes: []
      }
    : activeEscalations[0]
      ? {
          summary: `Resolve blocking escalation ${activeEscalations[0].id}.`,
          hint: { kind: "request_human_decision" as const, targetId: activeEscalations[0].id },
          causes
        }
      : unknownMaterialAction && unknownMaterialAction.kind === "material_action"
        ? {
            summary: `Reconcile material action ${unknownMaterialAction.actionId} before retrying.`,
            hint: { kind: "reconcile_material_action" as const, targetId: unknownMaterialAction.actionId },
            causes
          }
        : humanGate
          ? {
              summary: `Record the required human decision for gate ${humanGate.gateId}.`,
              hint: { kind: "request_human_decision" as const, targetId: humanGate.gateId },
              causes
            }
          : refreshGate
            ? {
                summary: `Refresh completion evidence for gate ${refreshGate.gateId}.`,
                hint: { kind: "refresh_completion_evidence" as const, targetId: refreshGate.gateId },
                causes
              }
            : blockedGateIds.length === 0 && (
                failedGateIds.length > 0
                || missingGateIds.length > 0
                || Boolean(latestRunResult && latestResult?.conclusion !== "success")
              )
              ? {
                  summary: `Resume work on ${input.assessment.workThreadId} to address incomplete completion requirements.`,
                  hint: { kind: "resume_work_thread" as const, targetId: input.assessment.workThreadId },
                  causes
                }
              : {
                  summary: `Reassess completion for ${input.assessment.workThreadId}.`,
                  hint: { kind: "reassess_completion" as const, targetId: input.assessment.workThreadId },
                  causes
                };
  return {
    workThreadId: input.assessment.workThreadId,
    execution,
    completion: input.assessment.state,
    evidenceBacked: input.assessment.evidenceBacked,
    contract: { id: input.contract.id, version: input.contract.version, cycle: input.contract.cycle, mode: input.contract.mode },
    currentAssessment: input.assessment,
    targetBindings: input.assessment.targetBindings,
    missingGateIds,
    failedGateIds,
    blockedGateIds,
    nextAction
  };
}
