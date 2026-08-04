import type { CompletionAssessment } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { deriveAcceptedProgressAttribution, type CompletionArtifact } from "../src/index.js";

const t1 = "2026-08-04T00:00:00.000Z";
const t2 = "2026-08-04T00:01:00.000Z";
const t3 = "2026-08-04T00:02:00.000Z";

function assessment(input: {
  id: string;
  sequence: number;
  supersedesAssessmentId?: string;
  contractVersion?: number;
  cycle?: number;
  gates: CompletionAssessment["gateResults"];
  bindings?: CompletionAssessment["targetBindings"];
}): CompletionAssessment {
  return {
    id: input.id,
    workThreadId: "thread_1",
    contractId: "contract_1",
    contractVersion: input.contractVersion ?? 1,
    cycle: input.cycle ?? 1,
    sequence: input.sequence,
    inputDigest: `sha256:${String(input.sequence).repeat(64)}`,
    targetBindings: input.bindings ?? [],
    state: "pending",
    evidenceBacked: true,
    gateResults: input.gates,
    assessedAt: [t1, t2, t3][input.sequence - 1]!,
    assessedBy: "opentag",
    ...(input.supersedesAssessmentId ? { supersedesAssessmentId: input.supersedesAssessmentId } : {})
  };
}

function gate(input: {
  id: string;
  state: "missing" | "passed" | "waived";
  targetKey?: string;
  at: string;
}): CompletionAssessment["gateResults"][number] {
  return {
    gateId: input.id,
    ...(input.targetKey ? { targetKey: input.targetKey } : {}),
    state: input.state,
    evidenceIds: input.state === "missing" ? [] : [`evidence_${input.id}`],
    reasonCode: input.state === "missing"
      ? "artifact_missing"
      : input.state === "waived"
        ? "gate_waived"
        : "artifact_requirement_satisfied",
    reason: `${input.id} is ${input.state}.`,
    evaluatedAt: input.at
  };
}

function binding(key: string, artifactId: string, resourceVersion: string) {
  return {
    key,
    provider: "github",
    resourceRef: `github:acme/demo:pull_request:${artifactId}`,
    resourceVersion,
    artifactId
  };
}

function artifact(id: string, sourceRunId?: string): CompletionArtifact {
  return {
    id,
    kind: "pull_request",
    ...(sourceRunId ? { sourceRunId } : {}),
    recordedAt: t1
  };
}

describe("deriveAcceptedProgressAttribution", () => {
  it("attributes new passed gates through target artifact provenance without recounting unchanged gates", () => {
    const first = assessment({
      id: "assessment_1",
      sequence: 1,
      gates: [
        gate({ id: "pull_request", state: "passed", targetKey: "change", at: t1 }),
        gate({ id: "checks", state: "missing", targetKey: "verification", at: t1 })
      ],
      bindings: [binding("change", "artifact_pr", "head_1")]
    });
    const second = assessment({
      id: "assessment_2",
      sequence: 2,
      supersedesAssessmentId: first.id,
      gates: [
        gate({ id: "pull_request", state: "passed", targetKey: "change", at: t2 }),
        gate({ id: "checks", state: "passed", targetKey: "verification", at: t2 })
      ],
      bindings: [
        binding("change", "artifact_pr", "head_1"),
        binding("verification", "artifact_checks", "head_1")
      ]
    });
    const third = assessment({
      id: "assessment_3",
      sequence: 3,
      supersedesAssessmentId: second.id,
      gates: second.gateResults.map((result) => ({ ...result, evaluatedAt: t3 })),
      bindings: second.targetBindings
    });

    const view = deriveAcceptedProgressAttribution({
      currentAssessment: third,
      assessmentHistory: [third, first, second],
      artifacts: [artifact("artifact_pr", "run_1"), artifact("artifact_checks", "run_2")],
      workThreadRunIds: ["run_1", "run_2", "run_later"]
    });

    expect(view).toMatchObject({
      currentAssessmentId: "assessment_3",
      acceptedGateAdvanceCount: 2,
      attributedGateAdvanceCount: 2,
      unresolvedGateAdvanceCount: 0,
      runIdsWithAcceptedProgress: ["run_1", "run_2"],
      advances: [
        { assessmentId: "assessment_1", gateId: "pull_request", resolution: { sourceRunId: "run_1" } },
        { assessmentId: "assessment_2", gateId: "checks", resolution: { sourceRunId: "run_2" } }
      ]
    });
    expect(view.runIdsWithAcceptedProgress).not.toContain("run_later");
  });

  it("records changed targets as new advances and fails closed on human, missing, ambiguous, and foreign provenance", () => {
    const first = assessment({
      id: "assessment_1",
      sequence: 1,
      gates: [gate({ id: "change", state: "passed", targetKey: "change", at: t1 })],
      bindings: [binding("change", "artifact_old", "head_1")]
    });
    const second = assessment({
      id: "assessment_2",
      sequence: 2,
      supersedesAssessmentId: first.id,
      gates: [
        gate({ id: "change", state: "passed", targetKey: "change", at: t2 }),
        gate({ id: "human", state: "passed", at: t2 }),
        gate({ id: "missing_artifact", state: "passed", targetKey: "missing_artifact", at: t2 }),
        gate({ id: "ambiguous_artifact", state: "passed", targetKey: "ambiguous_artifact", at: t2 }),
        gate({ id: "foreign_run", state: "passed", targetKey: "foreign_run", at: t2 })
      ],
      bindings: [
        binding("change", "artifact_new", "head_2"),
        binding("missing_artifact", "artifact_missing", "head_2"),
        binding("ambiguous_artifact", "artifact_duplicate", "head_2"),
        binding("foreign_run", "artifact_foreign", "head_2")
      ]
    });

    const view = deriveAcceptedProgressAttribution({
      currentAssessment: second,
      assessmentHistory: [first, second],
      artifacts: [
        artifact("artifact_old", "run_old"),
        artifact("artifact_new", "run_new"),
        artifact("artifact_duplicate", "run_a"),
        artifact("artifact_duplicate", "run_b"),
        artifact("artifact_foreign", "run_other_thread")
      ],
      workThreadRunIds: ["run_old", "run_new", "run_a", "run_b"]
    });

    expect(view.runIdsWithAcceptedProgress).toEqual(["run_new", "run_old"]);
    expect(view.advances).toEqual(expect.arrayContaining([
      expect.objectContaining({ assessmentId: "assessment_2", gateId: "change", resolution: { status: "attributed", artifactId: "artifact_new", sourceRunId: "run_new" } }),
      expect.objectContaining({ gateId: "human", resolution: { status: "unresolved", reasonCode: "gate_target_missing" } }),
      expect.objectContaining({ gateId: "missing_artifact", resolution: { status: "unresolved", reasonCode: "artifact_not_found" } }),
      expect.objectContaining({ gateId: "ambiguous_artifact", resolution: { status: "unresolved", reasonCode: "artifact_ambiguous" } }),
      expect.objectContaining({ gateId: "foreign_run", resolution: { status: "unresolved", reasonCode: "source_run_not_in_work_thread" } })
    ]));
  });

  it("rejects a broken assessment lineage instead of guessing an adjacent assessment", () => {
    const current = assessment({
      id: "assessment_2",
      sequence: 2,
      supersedesAssessmentId: "assessment_missing",
      gates: [gate({ id: "change", state: "passed", targetKey: "change", at: t2 })],
      bindings: [binding("change", "artifact_pr", "head_1")]
    });
    expect(() => deriveAcceptedProgressAttribution({
      currentAssessment: current,
      assessmentHistory: [current],
      artifacts: [artifact("artifact_pr", "run_1")],
      workThreadRunIds: ["run_1"]
    })).toThrow(/missing predecessor/u);
  });

  it.each([
    { label: "completion cycle", contractVersion: 1, cycle: 2 },
    { label: "contract version", contractVersion: 2, cycle: 1 }
  ])("starts accepted progress independently at a new $label authority boundary", ({ contractVersion, cycle }) => {
    const previousAuthority = assessment({
      id: "assessment_previous_authority",
      sequence: 1,
      gates: [gate({ id: "change", state: "passed", targetKey: "change", at: t1 })],
      bindings: [binding("change", "artifact_previous", "head_1")]
    });
    const currentAuthority = assessment({
      id: "assessment_current_authority",
      sequence: contractVersion === 1 ? 1 : 2,
      supersedesAssessmentId: previousAuthority.id,
      contractVersion,
      cycle,
      gates: [gate({ id: "change", state: "passed", targetKey: "change", at: t2 })],
      bindings: [binding("change", "artifact_current", "head_2")]
    });

    const view = deriveAcceptedProgressAttribution({
      currentAssessment: currentAuthority,
      assessmentHistory: [previousAuthority, currentAuthority],
      artifacts: [
        artifact("artifact_previous", "run_previous"),
        artifact("artifact_current", "run_current")
      ],
      workThreadRunIds: ["run_previous", "run_current"]
    });

    expect(view).toMatchObject({
      contract: { id: "contract_1", version: contractVersion, cycle },
      currentAssessmentId: currentAuthority.id,
      acceptedGateAdvanceCount: 1,
      attributedGateAdvanceCount: 1,
      unresolvedGateAdvanceCount: 0,
      runIdsWithAcceptedProgress: ["run_current"],
      advances: [{
        assessmentId: currentAuthority.id,
        gateId: "change",
        resolution: { status: "attributed", artifactId: "artifact_current", sourceRunId: "run_current" }
      }]
    });
  });
});
