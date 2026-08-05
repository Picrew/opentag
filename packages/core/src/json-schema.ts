import { z } from "zod";
import {
  AgentAccessProfileSnapshotSchema,
  AcceptedGateAdvanceSchema,
  AcceptedProgressAttributionViewSchema,
  ActionHintSchema,
  MaterialActionReceiptSchema,
  ActionSchema,
  ActionPermissionRequestSchema,
  ActionPermissionResolutionSchema,
  AdapterMutationMappingSchema,
  ApplyIntentOutcomeSchema,
  ApplyPlanSchema,
  ApprovalDecisionSchema,
  ArtifactKindSchema,
  ArtifactSchema,
  AttemptSchema,
  AttemptStatusSchema,
  CapabilityContractSchema,
  CanonicalMutationDomainSchema,
  CompletionAssessmentSchema,
  CompletionContractSchema,
  CompletionGateResultSchema,
  CompletionGateSchema,
  CompletionTargetSelectorSchema,
  CompletionWaiverSchema,
  ReassessmentObligationSchema,
  ResolvedCompletionTargetSchema,
  ContextPacketSchema,
  ConnectionRefSchema,
  ConversationAnchorSchema,
  FollowUpRequestSchema,
  GrantSchema,
  HumanEscalationSchema,
  MutationIntentSchema,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  OpenTagRunSchema,
  ProposalLineageSchema,
  RunAdmissionDecisionSchema,
  RunArtifactTypeSchema,
  RunEventImportanceSchema,
  RunEventSchema,
  RunEventVisibilitySchema,
  PolicyResolutionSchema,
  PolicySnapshotProvenanceSchema,
  SuggestedChangesSnapshotSchema,
  SuccessMetricNameSchema,
  VerificationEvidenceSchema,
  WorkItemReferenceSchema,
  WorkLoopCauseSchema,
  WorkLoopNextActionSchema,
  WorkLoopViewSchema,
  WorkThreadSchema
} from "./schema.js";
import {
  OpenTagChannelInboundMessageSchema,
  OpenTagChannelPresentationCommandSchema
} from "./channel-protocol.js";
import {
  OpenTagActorRefSchema,
  OpenTagChannelRefSchema,
  OpenTagChangeRequestRefSchema,
  OpenTagContextRefSchema,
  OpenTagIntegrationManifestSchema,
  OpenTagReplyTargetRefSchema,
  OpenTagRepoRefSchema,
  OpenTagRunSourceRefSchema,
  OpenTagRunTargetsSchema,
  OpenTagThreadRefSchema,
  OpenTagWorkItemRefSchema
} from "./integration-protocol.js";
import {
  AcceptedProgressMetricsSchema,
  FrozenRoutingPolicySchema,
  RoutingDecisionSchema,
  RunnerDirectoryEntrySchema,
  RunnerRegistrationInputSchema
} from "./routing.js";
import {
  FactoryRecipeSnapshotInputSchema,
  FactoryRecipeSnapshotSchema,
  WorkstreamContinuationDecisionInputSchema,
  WorkstreamContinuationDecisionSchema,
  WorkstreamContinuationPolicySchema,
  WorkstreamAdmissionBatchInputSchema,
  WorkstreamAdmissionBatchReceiptSchema,
  WorkstreamEvaluationSchema,
  WorkstreamInputSchema,
  WorkstreamMetricsSchema,
  WorkstreamSchema
} from "./factory.js";

type JsonSchemaValue = null | boolean | number | string | JsonSchemaValue[] | { [key: string]: JsonSchemaValue };
type OpenTagJsonSchema = {
  $ref: string;
  definitions: Record<string, JsonSchemaValue>;
  $schema?: string;
};

function rewriteRootReferences(value: JsonSchemaValue, rootReference: string): JsonSchemaValue {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteRootReferences(entry, rootReference));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "$ref" && entry === "#" ? rootReference : rewriteRootReferences(entry, rootReference)
    ])
  );
}

function preserveClosedObjectContract(value: JsonSchemaValue): JsonSchemaValue {
  if (Array.isArray(value)) {
    return value.map(preserveClosedObjectContract);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const schema = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, preserveClosedObjectContract(entry)])
  );
  if (schema.type === "object" && schema.additionalProperties === undefined) {
    schema.additionalProperties = false;
  }
  return schema;
}

function toOpenTagJsonSchema(schema: z.ZodType, name: string): OpenTagJsonSchema {
  const rootReference = `#/definitions/${name}`;
  const generated = rewriteRootReferences(
    preserveClosedObjectContract(
      z.toJSONSchema(schema, {
        io: "input",
        reused: "ref",
        target: "draft-7"
      }) as JsonSchemaValue
    ),
    rootReference
  ) as Record<string, JsonSchemaValue>;
  const { $schema, definitions, ...definition } = generated;

  return {
    $ref: rootReference,
    definitions: {
      [name]: definition,
      ...(definitions && typeof definitions === "object" && !Array.isArray(definitions) ? definitions : {})
    },
    ...(typeof $schema === "string" ? { $schema } : {})
  };
}

export const OpenTagJsonSchemas = {
  OpenTagEvent: toOpenTagJsonSchema(OpenTagEventSchema, "OpenTagEvent"),
  AcceptedGateAdvance: toOpenTagJsonSchema(AcceptedGateAdvanceSchema, "AcceptedGateAdvance"),
  AcceptedProgressAttributionView: toOpenTagJsonSchema(AcceptedProgressAttributionViewSchema, "AcceptedProgressAttributionView"),
  OpenTagRun: toOpenTagJsonSchema(OpenTagRunSchema, "OpenTagRun"),
  OpenTagRunResult: toOpenTagJsonSchema(OpenTagRunResultSchema, "OpenTagRunResult"),
  ConnectionRef: toOpenTagJsonSchema(ConnectionRefSchema, "ConnectionRef"),
  AgentAccessProfileSnapshot: toOpenTagJsonSchema(AgentAccessProfileSnapshotSchema, "AgentAccessProfileSnapshot"),
  PolicySnapshotProvenance: toOpenTagJsonSchema(PolicySnapshotProvenanceSchema, "PolicySnapshotProvenance"),
  Attempt: toOpenTagJsonSchema(AttemptSchema, "Attempt"),
  AttemptStatus: toOpenTagJsonSchema(AttemptStatusSchema, "AttemptStatus"),
  Grant: toOpenTagJsonSchema(GrantSchema, "Grant"),
  Action: toOpenTagJsonSchema(ActionSchema, "Action"),
  MaterialActionReceipt: toOpenTagJsonSchema(MaterialActionReceiptSchema, "MaterialActionReceipt"),
  ActionPermissionRequest: toOpenTagJsonSchema(ActionPermissionRequestSchema, "ActionPermissionRequest"),
  ActionPermissionResolution: toOpenTagJsonSchema(ActionPermissionResolutionSchema, "ActionPermissionResolution"),
  Artifact: toOpenTagJsonSchema(ArtifactSchema, "Artifact"),
  VerificationEvidence: toOpenTagJsonSchema(VerificationEvidenceSchema, "VerificationEvidence"),
  RunAdmissionDecision: toOpenTagJsonSchema(RunAdmissionDecisionSchema, "RunAdmissionDecision"),
  FollowUpRequest: toOpenTagJsonSchema(FollowUpRequestSchema, "FollowUpRequest"),
  WorkItemReference: toOpenTagJsonSchema(WorkItemReferenceSchema, "WorkItemReference"),
  ConversationAnchor: toOpenTagJsonSchema(ConversationAnchorSchema, "ConversationAnchor"),
  WorkThread: toOpenTagJsonSchema(WorkThreadSchema, "WorkThread"),
  CompletionGate: toOpenTagJsonSchema(CompletionGateSchema, "CompletionGate"),
  CompletionTargetSelector: toOpenTagJsonSchema(CompletionTargetSelectorSchema, "CompletionTargetSelector"),
  ResolvedCompletionTarget: toOpenTagJsonSchema(ResolvedCompletionTargetSchema, "ResolvedCompletionTarget"),
  CompletionContract: toOpenTagJsonSchema(CompletionContractSchema, "CompletionContract"),
  CompletionGateResult: toOpenTagJsonSchema(CompletionGateResultSchema, "CompletionGateResult"),
  CompletionWaiver: toOpenTagJsonSchema(CompletionWaiverSchema, "CompletionWaiver"),
  CompletionAssessment: toOpenTagJsonSchema(CompletionAssessmentSchema, "CompletionAssessment"),
  ReassessmentObligation: toOpenTagJsonSchema(ReassessmentObligationSchema, "ReassessmentObligation"),
  HumanEscalation: toOpenTagJsonSchema(HumanEscalationSchema, "HumanEscalation"),
  WorkLoopCause: toOpenTagJsonSchema(WorkLoopCauseSchema, "WorkLoopCause"),
  WorkLoopNextAction: toOpenTagJsonSchema(WorkLoopNextActionSchema, "WorkLoopNextAction"),
  WorkLoopView: toOpenTagJsonSchema(WorkLoopViewSchema, "WorkLoopView"),
  ContextPacket: toOpenTagJsonSchema(ContextPacketSchema, "ContextPacket"),
  OpenTagIntegrationManifest: toOpenTagJsonSchema(OpenTagIntegrationManifestSchema, "OpenTagIntegrationManifest"),
  OpenTagActorRef: toOpenTagJsonSchema(OpenTagActorRefSchema, "OpenTagActorRef"),
  OpenTagChannelRef: toOpenTagJsonSchema(OpenTagChannelRefSchema, "OpenTagChannelRef"),
  OpenTagThreadRef: toOpenTagJsonSchema(OpenTagThreadRefSchema, "OpenTagThreadRef"),
  OpenTagRepoRef: toOpenTagJsonSchema(OpenTagRepoRefSchema, "OpenTagRepoRef"),
  OpenTagChangeRequestRef: toOpenTagJsonSchema(OpenTagChangeRequestRefSchema, "OpenTagChangeRequestRef"),
  OpenTagWorkItemRef: toOpenTagJsonSchema(OpenTagWorkItemRefSchema, "OpenTagWorkItemRef"),
  OpenTagContextRef: toOpenTagJsonSchema(OpenTagContextRefSchema, "OpenTagContextRef"),
  OpenTagRunSourceRef: toOpenTagJsonSchema(OpenTagRunSourceRefSchema, "OpenTagRunSourceRef"),
  OpenTagRunTargets: toOpenTagJsonSchema(OpenTagRunTargetsSchema, "OpenTagRunTargets"),
  OpenTagReplyTargetRef: toOpenTagJsonSchema(OpenTagReplyTargetRefSchema, "OpenTagReplyTargetRef"),
  OpenTagChannelInboundMessage: toOpenTagJsonSchema(OpenTagChannelInboundMessageSchema, "OpenTagChannelInboundMessage"),
  OpenTagChannelPresentationCommand: toOpenTagJsonSchema(OpenTagChannelPresentationCommandSchema, "OpenTagChannelPresentationCommand"),
  RunEventVisibility: toOpenTagJsonSchema(RunEventVisibilitySchema, "RunEventVisibility"),
  RunEventImportance: toOpenTagJsonSchema(RunEventImportanceSchema, "RunEventImportance"),
  RunEvent: toOpenTagJsonSchema(RunEventSchema, "RunEvent"),
  ArtifactKind: toOpenTagJsonSchema(ArtifactKindSchema, "ArtifactKind"),
  RunArtifactType: toOpenTagJsonSchema(RunArtifactTypeSchema, "RunArtifactType"),
  AdapterMutationMapping: toOpenTagJsonSchema(AdapterMutationMappingSchema, "AdapterMutationMapping"),
  CapabilityContract: toOpenTagJsonSchema(CapabilityContractSchema, "CapabilityContract"),
  PolicyResolution: toOpenTagJsonSchema(PolicyResolutionSchema, "PolicyResolution"),
  ProposalLineage: toOpenTagJsonSchema(ProposalLineageSchema, "ProposalLineage"),
  SuccessMetricName: toOpenTagJsonSchema(SuccessMetricNameSchema, "SuccessMetricName"),
  ActionHint: toOpenTagJsonSchema(ActionHintSchema, "ActionHint"),
  CanonicalMutationDomain: toOpenTagJsonSchema(CanonicalMutationDomainSchema, "CanonicalMutationDomain"),
  MutationIntent: toOpenTagJsonSchema(MutationIntentSchema, "MutationIntent"),
  SuggestedChangesSnapshot: toOpenTagJsonSchema(SuggestedChangesSnapshotSchema, "SuggestedChangesSnapshot"),
  ApprovalDecision: toOpenTagJsonSchema(ApprovalDecisionSchema, "ApprovalDecision"),
  ApplyPlan: toOpenTagJsonSchema(ApplyPlanSchema, "ApplyPlan"),
  ApplyIntentOutcome: toOpenTagJsonSchema(ApplyIntentOutcomeSchema, "ApplyIntentOutcome"),
  FrozenRoutingPolicy: toOpenTagJsonSchema(FrozenRoutingPolicySchema, "FrozenRoutingPolicy"),
  RunnerRegistration: toOpenTagJsonSchema(RunnerRegistrationInputSchema, "RunnerRegistration"),
  RunnerDirectoryEntry: toOpenTagJsonSchema(RunnerDirectoryEntrySchema, "RunnerDirectoryEntry"),
  RoutingDecision: toOpenTagJsonSchema(RoutingDecisionSchema, "RoutingDecision"),
  AcceptedProgressMetrics: toOpenTagJsonSchema(AcceptedProgressMetricsSchema, "AcceptedProgressMetrics"),
  FactoryRecipeSnapshotInput: toOpenTagJsonSchema(FactoryRecipeSnapshotInputSchema, "FactoryRecipeSnapshotInput"),
  FactoryRecipeSnapshot: toOpenTagJsonSchema(FactoryRecipeSnapshotSchema, "FactoryRecipeSnapshot"),
  WorkstreamContinuationPolicy: toOpenTagJsonSchema(WorkstreamContinuationPolicySchema, "WorkstreamContinuationPolicy"),
  WorkstreamContinuationDecisionInput: toOpenTagJsonSchema(WorkstreamContinuationDecisionInputSchema, "WorkstreamContinuationDecisionInput"),
  WorkstreamContinuationDecision: toOpenTagJsonSchema(WorkstreamContinuationDecisionSchema, "WorkstreamContinuationDecision"),
  WorkstreamInput: toOpenTagJsonSchema(WorkstreamInputSchema, "WorkstreamInput"),
  Workstream: toOpenTagJsonSchema(WorkstreamSchema, "Workstream"),
  WorkstreamAdmissionBatchInput: toOpenTagJsonSchema(WorkstreamAdmissionBatchInputSchema, "WorkstreamAdmissionBatchInput"),
  WorkstreamAdmissionBatchReceipt: toOpenTagJsonSchema(WorkstreamAdmissionBatchReceiptSchema, "WorkstreamAdmissionBatchReceipt"),
  WorkstreamMetrics: toOpenTagJsonSchema(WorkstreamMetricsSchema, "WorkstreamMetrics"),
  WorkstreamEvaluation: toOpenTagJsonSchema(WorkstreamEvaluationSchema, "WorkstreamEvaluation")
} as const;
