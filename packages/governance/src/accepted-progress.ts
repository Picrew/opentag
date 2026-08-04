import {
  AcceptedProgressAttributionViewSchema,
  CompletionAssessmentSchema,
  type AcceptedGateAdvance,
  type AcceptedProgressAttributionView,
  type CompletionAssessment,
  type CompletionGateResult,
  type ResolvedCompletionTarget
} from "@opentag/core";
import type { CompletionArtifact } from "./types.js";

export type AcceptedProgressAttributionInput = {
  currentAssessment: CompletionAssessment;
  assessmentHistory: CompletionAssessment[];
  artifacts: CompletionArtifact[];
  workThreadRunIds: string[];
};

function sameAuthority(left: CompletionAssessment, right: CompletionAssessment): boolean {
  return left.workThreadId === right.workThreadId
    && left.contractId === right.contractId
    && left.contractVersion === right.contractVersion
    && left.cycle === right.cycle;
}

function assessmentLineage(input: AcceptedProgressAttributionInput): CompletionAssessment[] {
  const current = CompletionAssessmentSchema.parse(input.currentAssessment);
  const allById = new Map<string, CompletionAssessment>();
  const byId = new Map<string, CompletionAssessment>();
  for (const value of input.assessmentHistory) {
    const assessment = CompletionAssessmentSchema.parse(value);
    allById.set(assessment.id, assessment);
    if (sameAuthority(assessment, current)) byId.set(assessment.id, assessment);
  }
  allById.set(current.id, current);
  byId.set(current.id, current);

  const lineage: CompletionAssessment[] = [];
  const seen = new Set<string>();
  let cursor: CompletionAssessment | undefined = current;
  while (cursor) {
    if (seen.has(cursor.id)) throw new Error(`CompletionAssessment lineage contains a cycle at ${cursor.id}.`);
    seen.add(cursor.id);
    lineage.push(cursor);
    if (!cursor.supersedesAssessmentId) break;
    const previous = byId.get(cursor.supersedesAssessmentId);
    if (!previous) {
      const authorityBoundary = allById.get(cursor.supersedesAssessmentId);
      if (authorityBoundary && !sameAuthority(authorityBoundary, cursor)) break;
      throw new Error(`CompletionAssessment ${cursor.id} references missing predecessor ${cursor.supersedesAssessmentId}.`);
    }
    if (previous.sequence >= cursor.sequence) {
      throw new Error(`CompletionAssessment ${cursor.id} does not advance its predecessor sequence.`);
    }
    cursor = previous;
  }
  return lineage.reverse();
}

function targetBinding(
  assessment: CompletionAssessment,
  gate: CompletionGateResult
): ResolvedCompletionTarget | undefined {
  return gate.targetKey
    ? assessment.targetBindings.find((binding) => binding.key === gate.targetKey)
    : undefined;
}

function acceptedTargetIdentity(assessment: CompletionAssessment, gate: CompletionGateResult): string {
  if (!gate.targetKey) return "no-target";
  const binding = targetBinding(assessment, gate);
  if (!binding) return `missing-target:${gate.targetKey}`;
  return JSON.stringify([
    binding.key,
    binding.provider,
    binding.resourceRef,
    binding.resourceVersion,
    binding.artifactId ?? null
  ]);
}

function acceptedAdvance(
  assessment: CompletionAssessment,
  previousAssessment: CompletionAssessment | undefined,
  gate: CompletionGateResult
): boolean {
  if (gate.state !== "passed") return false;
  const previousGate = previousAssessment?.gateResults.find((candidate) => candidate.gateId === gate.gateId);
  return previousGate?.state !== "passed"
    || acceptedTargetIdentity(previousAssessment!, previousGate) !== acceptedTargetIdentity(assessment, gate);
}

function resolveAdvance(input: {
  assessment: CompletionAssessment;
  gate: CompletionGateResult;
  artifactsById: Map<string, CompletionArtifact[]>;
  workThreadRunIds: Set<string>;
}): AcceptedGateAdvance["resolution"] {
  if (!input.gate.targetKey) return { status: "unresolved", reasonCode: "gate_target_missing" };
  const binding = targetBinding(input.assessment, input.gate);
  if (!binding) return { status: "unresolved", reasonCode: "target_binding_missing" };
  if (!binding.artifactId) return { status: "unresolved", reasonCode: "target_artifact_missing" };
  const artifacts = input.artifactsById.get(binding.artifactId) ?? [];
  if (artifacts.length === 0) return { status: "unresolved", reasonCode: "artifact_not_found" };
  if (artifacts.length > 1) return { status: "unresolved", reasonCode: "artifact_ambiguous" };
  const artifact = artifacts[0]!;
  if (!artifact.sourceRunId) return { status: "unresolved", reasonCode: "artifact_source_run_missing" };
  if (!input.workThreadRunIds.has(artifact.sourceRunId)) {
    return { status: "unresolved", reasonCode: "source_run_not_in_work_thread" };
  }
  return {
    status: "attributed",
    artifactId: artifact.id,
    sourceRunId: artifact.sourceRunId
  };
}

export function deriveAcceptedProgressAttribution(
  input: AcceptedProgressAttributionInput
): AcceptedProgressAttributionView {
  const currentAssessment = CompletionAssessmentSchema.parse(input.currentAssessment);
  const lineage = assessmentLineage({ ...input, currentAssessment });
  const artifactsById = new Map<string, CompletionArtifact[]>();
  for (const artifact of input.artifacts) {
    const artifacts = artifactsById.get(artifact.id) ?? [];
    artifacts.push(artifact);
    artifactsById.set(artifact.id, artifacts);
  }
  const workThreadRunIds = new Set(input.workThreadRunIds);
  const advances: AcceptedGateAdvance[] = [];
  for (const [index, assessment] of lineage.entries()) {
    const previousAssessment = index > 0 ? lineage[index - 1] : undefined;
    for (const gate of assessment.gateResults) {
      if (!acceptedAdvance(assessment, previousAssessment, gate)) continue;
      advances.push({
        workThreadId: assessment.workThreadId,
        contractId: assessment.contractId,
        contractVersion: assessment.contractVersion,
        cycle: assessment.cycle,
        assessmentId: assessment.id,
        assessmentSequence: assessment.sequence,
        ...(previousAssessment ? { previousAssessmentId: previousAssessment.id } : {}),
        gateId: gate.gateId,
        ...(gate.targetKey ? { targetKey: gate.targetKey } : {}),
        acceptedState: "passed",
        evidenceIds: [...gate.evidenceIds],
        acceptedAt: gate.evaluatedAt,
        resolution: resolveAdvance({ assessment, gate, artifactsById, workThreadRunIds })
      });
    }
  }
  advances.sort((left, right) =>
    left.assessmentSequence - right.assessmentSequence
    || left.gateId.localeCompare(right.gateId)
  );
  const attributedGateAdvanceCount = advances.filter((advance) => advance.resolution.status === "attributed").length;
  const runIdsWithAcceptedProgress = [...new Set(advances.flatMap((advance) =>
    advance.resolution.status === "attributed" ? [advance.resolution.sourceRunId] : []
  ))].sort();
  return AcceptedProgressAttributionViewSchema.parse({
    workThreadId: currentAssessment.workThreadId,
    contract: {
      id: currentAssessment.contractId,
      version: currentAssessment.contractVersion,
      cycle: currentAssessment.cycle
    },
    currentAssessmentId: currentAssessment.id,
    advances,
    acceptedGateAdvanceCount: advances.length,
    attributedGateAdvanceCount,
    unresolvedGateAdvanceCount: advances.length - attributedGateAdvanceCount,
    runIdsWithAcceptedProgress
  });
}
