import { z } from "zod";

export const CompletionAssessmentStateSchema = z.enum([
  "pending",
  "satisfied",
  "unsatisfied",
  "blocked",
  "waived",
]);

export const CompletionGateResultStateSchema = z.enum([
  "passed",
  "failed",
  "missing",
  "unknown",
  "waived",
]);

export const CompletionReasonCodeSchema = z.enum([
  "artifact_requirement_satisfied",
  "artifact_missing",
  "artifact_ambiguous",
  "verification_passed",
  "verification_failed",
  "verification_missing",
  "verification_assurance_insufficient",
  "verification_subject_mismatch",
  "verification_stale",
  "external_state_satisfied",
  "external_state_mismatch",
  "external_state_missing",
  "external_state_assurance_insufficient",
  "external_state_subject_mismatch",
  "external_state_stale",
  "material_action_succeeded",
  "material_action_failed",
  "material_action_unknown",
  "material_action_missing",
  "human_acceptance_recorded",
  "human_acceptance_missing",
  "gate_waived",
  "waiver_invalid",
  "execution_succeeded",
  "execution_incomplete",
  "execution_not_succeeded",
]);

type CompletionGateResultState = z.infer<typeof CompletionGateResultStateSchema>;
type CompletionAssessmentState = z.infer<typeof CompletionAssessmentStateSchema>;
type CompletionReasonCode = z.infer<typeof CompletionReasonCodeSchema>;

export const COMPLETION_REASON_ALLOWED_GATE_STATES = Object.freeze({
  artifact_requirement_satisfied: ["passed"],
  artifact_missing: ["missing"],
  artifact_ambiguous: ["unknown"],
  verification_passed: ["passed"],
  verification_failed: ["failed"],
  verification_missing: ["missing"],
  verification_assurance_insufficient: ["unknown"],
  verification_subject_mismatch: ["unknown"],
  verification_stale: ["missing"],
  external_state_satisfied: ["passed"],
  external_state_mismatch: ["failed"],
  external_state_missing: ["missing"],
  external_state_assurance_insufficient: ["unknown"],
  external_state_subject_mismatch: ["unknown"],
  external_state_stale: ["missing"],
  material_action_succeeded: ["passed"],
  material_action_failed: ["failed"],
  material_action_unknown: ["unknown"],
  material_action_missing: ["missing"],
  human_acceptance_recorded: ["passed"],
  human_acceptance_missing: ["missing", "unknown"],
  gate_waived: ["waived"],
  waiver_invalid: ["unknown"],
  execution_succeeded: ["passed"],
  execution_incomplete: ["missing"],
  execution_not_succeeded: ["failed"],
} as const satisfies Record<CompletionReasonCode, readonly CompletionGateResultState[]>);

export function reduceCompletionGateStates(
  states: readonly (CompletionGateResultState | CompletionAssessmentState)[],
): CompletionAssessmentState {
  if (states.some((state) => state === "unknown" || state === "blocked")) return "blocked";
  if (states.some((state) => state === "failed" || state === "unsatisfied")) return "unsatisfied";
  if (states.some((state) => state === "missing" || state === "pending")) return "pending";
  if (states.some((state) => state === "waived")) return "waived";
  return "satisfied";
}
