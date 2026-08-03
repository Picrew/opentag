import type {
  CompletionAssessment,
  CompletionContract,
  CompletionWaiver,
  HumanEscalation,
  MaterialActionReceipt,
  OpenTagRunResult,
  ResolvedCompletionTarget,
  WorkLoopCause,
  WorkLoopNextAction,
  WorkThread
} from "@opentag/core";

export type { WorkLoopCause, WorkLoopNextAction } from "@opentag/core";

export type CompletionArtifact = {
  id: string;
  kind: string;
  sourceRunId?: string;
  uri?: string;
  target?: {
    key: string;
    provider: string;
    resourceRef: string;
    resourceVersion: string;
  };
  recordedAt: string;
};

export type CompletionEvidenceFact = {
  id: string;
  workThreadId: string;
  cycle: number;
  kind: string;
  assurance: "verified" | "reported" | "unverifiable";
  subject: {
    provider: string;
    resourceRef: string;
    resourceVersion: string;
  };
  claim: {
    predicate: string;
    outcome: string;
    observations?: Record<string, string>;
  };
  provenance: {
    adapter: string;
    adapterVersion: string;
    payloadDigest: string;
    sourceEventId?: string;
    providerDeliveryId?: string;
  };
  observedAt: string;
  receivedAt: string;
};

export type CompletionRunResult = {
  runId: string;
  result: OpenTagRunResult;
  recordedAt: string;
};

export type CompletionEvaluationInput = {
  contract: CompletionContract;
  runResults: CompletionRunResult[];
  artifacts: CompletionArtifact[];
  evidence: CompletionEvidenceFact[];
  materialActionReceipts: MaterialActionReceipt[];
  waivers: CompletionWaiver[];
  blockingEscalations?: HumanEscalation[];
  evaluatedAt?: string;
  lineage?: {
    sequence: number;
    supersedesAssessmentId?: string;
  };
};

export type CompletionEvaluationSnapshot = Omit<CompletionEvaluationInput, "lineage" | "evaluatedAt"> & {
  currentAssessment: CompletionAssessment | null;
};

export type WorkLoopView = {
  workThreadId: string;
  execution: "idle" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "timed_out" | "needs_human";
  completion: CompletionAssessment["state"];
  evidenceBacked: boolean;
  contract: { id: string; version: number; cycle: number; mode: CompletionContract["mode"] };
  currentAssessment: CompletionAssessment;
  targetBindings: ResolvedCompletionTarget[];
  missingGateIds: string[];
  failedGateIds: string[];
  blockedGateIds: string[];
  nextAction: WorkLoopNextAction;
};

export type IngestRunResultCommand = {
  type: "ingest_run_result";
  commandId: string;
  workThreadId: string;
  runId: string;
};

export type IngestEvidenceCommand = {
  type: "ingest_evidence";
  commandId: string;
  evidence: CompletionEvidenceFact;
};

export type ReassessCompletionCommand = {
  type: "reassess_completion";
  commandId: string;
  workThreadId: string;
};

export type ResolveHumanEscalationCommand = {
  type: "resolve_human_escalation";
  commandId: string;
  workThreadId: string;
  escalation: HumanEscalation;
  waiver?: CompletionWaiver;
};

export type ApplyCompletionWaiverCommand = {
  type: "apply_completion_waiver";
  commandId: string;
  workThreadId: string;
  waiver: CompletionWaiver;
};

export type GovernanceCommand =
  | IngestRunResultCommand
  | IngestEvidenceCommand
  | ReassessCompletionCommand
  | ApplyCompletionWaiverCommand
  | ResolveHumanEscalationCommand;

export type GetWorkLoopQuery = { type: "get_work_loop"; workThreadId: string };
export type ExplainCompletionQuery = { type: "explain_completion"; workThreadId: string };
export type ListHumanEscalationsQuery = { type: "list_human_escalations"; workThreadId: string };
export type GovernanceQuery = GetWorkLoopQuery | ExplainCompletionQuery | ListHumanEscalationsQuery;

export type GovernanceCommandResult = {
  outcome: "recorded" | "duplicate" | "conflict";
  assessment: CompletionAssessment;
  view: WorkLoopView;
};

export type GovernanceView = WorkLoopView | CompletionAssessment | HumanEscalation[];

export interface GovernanceRepository {
  loadEvaluationSnapshot(workThreadId: string): Promise<CompletionEvaluationSnapshot>;
  recordEvidence(evidence: CompletionEvidenceFact): Promise<{ created: boolean }>;
  recordWaiver(waiver: CompletionWaiver): Promise<{ created: boolean }>;
  resolveHumanEscalation(escalation: HumanEscalation): Promise<{ resolved: boolean }>;
  appendAssessment(input: {
    assessment: CompletionAssessment;
    expectedCurrentAssessmentId: string | null;
  }): Promise<
    | { outcome: "recorded" | "duplicate"; assessment: CompletionAssessment }
    | { outcome: "conflict"; currentAssessment: CompletionAssessment | null }
  >;
  listHumanEscalations(workThreadId: string): Promise<HumanEscalation[]>;
}

export interface GovernanceClock {
  now(): string;
}

export interface GovernanceIds {
  assessmentId(inputDigest: string, sequence: number): string;
}

export interface OpenTagGovernance {
  execute(command: GovernanceCommand): Promise<GovernanceCommandResult>;
  read(query: GovernanceQuery): Promise<GovernanceView>;
}

export type EnsureWorkThreadInput = { thread: WorkThread };
