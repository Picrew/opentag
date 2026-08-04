import type { CompletionAssessment } from "@opentag/core";
import { deriveWorkLoopView, evaluateCompletion } from "./evaluate.js";
import type {
  CompletionEvaluationSnapshot,
  GovernanceClock,
  GovernanceCommand,
  GovernanceCommandResult,
  GovernanceIds,
  GovernanceQuery,
  GovernanceRepository,
  GovernanceView,
  OpenTagGovernance
} from "./types.js";

function assessmentForSnapshot(snapshot: CompletionEvaluationSnapshot, evaluatedAt?: string): CompletionAssessment {
  const assessment = evaluateCompletion({
    contract: snapshot.contract,
    runResults: snapshot.runResults,
    artifacts: snapshot.artifacts,
    evidence: snapshot.evidence,
    materialActionReceipts: snapshot.materialActionReceipts,
    waivers: snapshot.waivers,
    blockingEscalations: snapshot.blockingEscalations ?? [],
    ...(evaluatedAt ? { evaluatedAt } : {}),
    lineage: {
      sequence: (snapshot.currentAssessment?.sequence ?? 0) + 1,
      ...(snapshot.currentAssessment ? { supersedesAssessmentId: snapshot.currentAssessment.id } : {})
    }
  });
  const current = snapshot.currentAssessment;
  if (
    assessment.acceptedAt
    && current?.acceptedAt
    && (current.state === "satisfied" || current.state === "waived")
    && (assessment.state === "satisfied" || assessment.state === "waived")
  ) {
    return { ...assessment, acceptedAt: current.acceptedAt };
  }
  return assessment;
}

export function createOpenTagGovernance(input: {
  repository: GovernanceRepository;
  clock?: GovernanceClock;
  ids?: GovernanceIds;
}): OpenTagGovernance {
  const clock = input.clock ?? { now: () => new Date().toISOString() };
  const ids = input.ids ?? {
    assessmentId: (digest: string, sequence: number) => `assessment_${digest.slice("sha256:".length, "sha256:".length + 24)}_${sequence}`
  };

  async function reassess(workThreadId: string): Promise<GovernanceCommandResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await input.repository.loadEvaluationSnapshot(workThreadId);
      const evaluated = assessmentForSnapshot(snapshot, clock.now());
      if (snapshot.currentAssessment?.inputDigest === evaluated.inputDigest) {
        return {
          outcome: "duplicate",
          assessment: snapshot.currentAssessment,
          view: deriveWorkLoopView({
            contract: snapshot.contract,
            runResults: snapshot.runResults,
            materialActionReceipts: snapshot.materialActionReceipts,
            blockingEscalations: snapshot.blockingEscalations,
            assessment: snapshot.currentAssessment
          })
        };
      }
      const assessment = {
        ...evaluated,
        id: ids.assessmentId(evaluated.inputDigest, evaluated.sequence),
        assessedAt: evaluated.assessedAt || clock.now()
      };
      const appended = await input.repository.appendAssessment({
        assessment,
        expectedCurrentAssessmentId: snapshot.currentAssessment?.id ?? null
      });
      if (appended.outcome === "conflict") continue;
      return {
        outcome: appended.outcome,
        assessment: appended.assessment,
        view: deriveWorkLoopView({
          contract: snapshot.contract,
          runResults: snapshot.runResults,
          materialActionReceipts: snapshot.materialActionReceipts,
          blockingEscalations: snapshot.blockingEscalations,
          assessment: appended.assessment
        })
      };
    }
    const snapshot = await input.repository.loadEvaluationSnapshot(workThreadId);
    const current = snapshot.currentAssessment ?? assessmentForSnapshot(snapshot);
    return {
      outcome: "conflict",
      assessment: current,
      view: deriveWorkLoopView({
        contract: snapshot.contract,
        runResults: snapshot.runResults,
        materialActionReceipts: snapshot.materialActionReceipts,
        blockingEscalations: snapshot.blockingEscalations,
        assessment: current
      })
    };
  }

  async function execute(command: GovernanceCommand): Promise<GovernanceCommandResult> {
    if (command.type === "ingest_evidence") {
      await input.repository.recordEvidence(command.evidence);
      return reassess(command.evidence.workThreadId);
    }
    if (command.type === "apply_completion_waiver") {
      await input.repository.recordWaiver(command.waiver);
      return reassess(command.workThreadId);
    }
    if (command.type === "resolve_human_escalation") {
      await input.repository.resolveHumanEscalation(command.escalation);
      if (command.waiver) await input.repository.recordWaiver(command.waiver);
      return reassess(command.workThreadId);
    }
    return reassess(command.workThreadId);
  }

  async function read(query: GovernanceQuery): Promise<GovernanceView> {
    if (query.type === "list_human_escalations") return input.repository.listHumanEscalations(query.workThreadId);
    const current = await reassess(query.workThreadId);
    if (query.type === "explain_completion") return current.assessment;
    return current.view;
  }

  return { execute, read };
}
