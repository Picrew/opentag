import { describe, expect, it } from "vitest";
import { OpenTagJsonSchemas } from "../src/json-schema.js";

type JsonSchemaNode = null | boolean | number | string | JsonSchemaNode[] | { [key: string]: JsonSchemaNode };

function resolveLocalReference(document: JsonSchemaNode, reference: string): JsonSchemaNode | undefined {
  if (!reference.startsWith("#/")) {
    return undefined;
  }

  return reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<JsonSchemaNode | undefined>((current, segment) => {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      return current[segment];
    }, document);
}

function collectReferences(node: JsonSchemaNode, references: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((entry) => collectReferences(entry, references));
    return references;
  }
  if (node === null || typeof node !== "object") {
    return references;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      references.push(value);
    } else {
      collectReferences(value, references);
    }
  }
  return references;
}

function collectObjectSchemas(
  node: JsonSchemaNode,
  objectSchemas: Array<Record<string, JsonSchemaNode>> = []
): Array<Record<string, JsonSchemaNode>> {
  if (Array.isArray(node)) {
    node.forEach((entry) => collectObjectSchemas(entry, objectSchemas));
    return objectSchemas;
  }
  if (node === null || typeof node !== "object") {
    return objectSchemas;
  }

  if (node.type === "object") {
    objectSchemas.push(node);
  }
  Object.values(node).forEach((value) => collectObjectSchemas(value, objectSchemas));
  return objectSchemas;
}

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
    expect(OpenTagJsonSchemas.AcceptedGateAdvance).toHaveProperty("definitions.AcceptedGateAdvance");
    expect(OpenTagJsonSchemas.AcceptedProgressAttributionView).toHaveProperty("definitions.AcceptedProgressAttributionView");
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
    expect(OpenTagJsonSchemas.ReassessmentObligation).toHaveProperty("definitions.ReassessmentObligation");
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
    expect(OpenTagJsonSchemas.AcceptedProgressMetrics).toHaveProperty("definitions.AcceptedProgressMetrics");
    expect(OpenTagJsonSchemas.FactoryRecipeSnapshotInput).toHaveProperty("definitions.FactoryRecipeSnapshotInput");
    expect(OpenTagJsonSchemas.FactoryRecipeSnapshot).toHaveProperty("definitions.FactoryRecipeSnapshot");
    expect(OpenTagJsonSchemas.WorkstreamContinuationPolicy).toHaveProperty("definitions.WorkstreamContinuationPolicy");
    expect(OpenTagJsonSchemas.WorkstreamContinuationDecisionInput).toHaveProperty("definitions.WorkstreamContinuationDecisionInput");
    expect(OpenTagJsonSchemas.WorkstreamContinuationDecision).toHaveProperty("definitions.WorkstreamContinuationDecision");
    expect(OpenTagJsonSchemas.WorkstreamInput).toHaveProperty("definitions.WorkstreamInput");
    expect(OpenTagJsonSchemas.Workstream).toHaveProperty("definitions.Workstream");
    expect(OpenTagJsonSchemas.WorkstreamAdmissionBatchInput).toHaveProperty("definitions.WorkstreamAdmissionBatchInput");
    expect(OpenTagJsonSchemas.WorkstreamAdmissionBatchReceipt).toHaveProperty("definitions.WorkstreamAdmissionBatchReceipt");
    expect(OpenTagJsonSchemas.WorkstreamMetrics).toHaveProperty("definitions.WorkstreamMetrics");
    expect(OpenTagJsonSchemas.WorkstreamEvaluation).toHaveProperty("definitions.WorkstreamEvaluation");
  });

  it("emits draft-07 documents with resolvable local references", () => {
    for (const [name, schema] of Object.entries(OpenTagJsonSchemas)) {
      const document = schema as JsonSchemaNode;

      expect(schema, name).toMatchObject({
        $schema: "http://json-schema.org/draft-07/schema#",
        $ref: `#/definitions/${name}`
      });

      for (const reference of collectReferences(document)) {
        expect(reference, `${name} contains a non-local reference`).toMatch(/^#\//u);
        expect(resolveLocalReference(document, reference), `${name} contains a dangling reference: ${reference}`).toBeDefined();
      }
      for (const objectSchema of collectObjectSchemas(document)) {
        expect(
          Object.hasOwn(objectSchema, "additionalProperties"),
          `${name} contains an object schema without an explicit additionalProperties contract`
        ).toBe(true);
      }
    }
  });
});
