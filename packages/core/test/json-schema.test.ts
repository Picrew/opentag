import { describe, expect, it } from "vitest";
import { OpenTagJsonSchemas } from "../src/json-schema.js";

describe("OpenTagJsonSchemas", () => {
  it("exports public JSON Schemas for protocol objects", () => {
    expect(OpenTagJsonSchemas.OpenTagEvent).toMatchObject({
      $ref: "#/definitions/OpenTagEvent",
      definitions: {
        OpenTagEvent: {
          type: "object"
        }
      }
    });
    expect(OpenTagJsonSchemas.OpenTagRun).toHaveProperty("definitions.OpenTagRun");
    expect(OpenTagJsonSchemas.OpenTagRunResult).toHaveProperty("definitions.OpenTagRunResult");
    expect(OpenTagJsonSchemas.WorkThread).toHaveProperty("definitions.WorkThread");
    expect(OpenTagJsonSchemas.CompletionGate).toHaveProperty("definitions.CompletionGate");
    expect(OpenTagJsonSchemas.CompletionTargetSelector).toHaveProperty("definitions.CompletionTargetSelector");
    expect(OpenTagJsonSchemas.ResolvedCompletionTarget).toHaveProperty("definitions.ResolvedCompletionTarget");
    expect(OpenTagJsonSchemas.CompletionContract).toHaveProperty("definitions.CompletionContract");
    expect(OpenTagJsonSchemas.CompletionGateResult).toHaveProperty("definitions.CompletionGateResult");
    expect(OpenTagJsonSchemas.CompletionWaiver).toHaveProperty("definitions.CompletionWaiver");
    expect(OpenTagJsonSchemas.CompletionAssessment).toHaveProperty("definitions.CompletionAssessment");
    expect(OpenTagJsonSchemas.HumanEscalation).toHaveProperty("definitions.HumanEscalation");
    expect(OpenTagJsonSchemas.ContextPacket).toHaveProperty("definitions.ContextPacket");
    expect(OpenTagJsonSchemas.RunAdmissionDecision).toHaveProperty("definitions.RunAdmissionDecision");
    expect(OpenTagJsonSchemas.RunEvent).toHaveProperty("definitions.RunEvent");
    expect(OpenTagJsonSchemas.AdapterMutationMapping).toHaveProperty("definitions.AdapterMutationMapping");
    expect(OpenTagJsonSchemas.CapabilityContract).toHaveProperty("definitions.CapabilityContract");
    expect(OpenTagJsonSchemas.PolicyResolution).toHaveProperty("definitions.PolicyResolution");
    expect(OpenTagJsonSchemas.ProposalLineage).toHaveProperty("definitions.ProposalLineage");
    expect(OpenTagJsonSchemas.SuccessMetricName).toHaveProperty("definitions.SuccessMetricName");
    expect(OpenTagJsonSchemas.SuggestedChangesSnapshot).toHaveProperty("definitions.SuggestedChangesSnapshot");
    expect(OpenTagJsonSchemas.ApprovalDecision).toHaveProperty("definitions.ApprovalDecision");
    expect(OpenTagJsonSchemas.ApplyPlan).toHaveProperty("definitions.ApplyPlan");
    expect(OpenTagJsonSchemas.FrozenRoutingPolicy).toHaveProperty("definitions.FrozenRoutingPolicy");
    expect(OpenTagJsonSchemas.RunnerRegistration).toHaveProperty("definitions.RunnerRegistration");
    expect(OpenTagJsonSchemas.RunnerDirectoryEntry).toHaveProperty("definitions.RunnerDirectoryEntry");
    expect(OpenTagJsonSchemas.RoutingDecision).toHaveProperty("definitions.RoutingDecision");
    expect(OpenTagJsonSchemas.AcceptedCompletionMetrics).toHaveProperty("definitions.AcceptedCompletionMetrics");
    expect(OpenTagJsonSchemas.FactoryRecipeSnapshotInput).toHaveProperty("definitions.FactoryRecipeSnapshotInput");
    expect(OpenTagJsonSchemas.FactoryRecipeSnapshot).toHaveProperty("definitions.FactoryRecipeSnapshot");
    expect(OpenTagJsonSchemas.WorkstreamInput).toHaveProperty("definitions.WorkstreamInput");
    expect(OpenTagJsonSchemas.Workstream).toHaveProperty("definitions.Workstream");
    expect(OpenTagJsonSchemas.WorkstreamAdmissionBatchInput).toHaveProperty("definitions.WorkstreamAdmissionBatchInput");
    expect(OpenTagJsonSchemas.WorkstreamAdmissionBatchReceipt).toHaveProperty("definitions.WorkstreamAdmissionBatchReceipt");
    expect(OpenTagJsonSchemas.WorkstreamMetrics).toHaveProperty("definitions.WorkstreamMetrics");
    expect(OpenTagJsonSchemas.WorkstreamEvaluation).toHaveProperty("definitions.WorkstreamEvaluation");
  });
});
