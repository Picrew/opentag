import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  CompletionContractSchema,
  type CompletionAssessment,
  type CompletionContract,
  type CompletionWaiver,
  type HumanEscalation,
  type OpenTagEvent,
  type OpenTagRun
} from "@opentag/core";
import {
  createOpenTagGovernance,
  deriveWorkLoopView,
  type CompletionArtifact,
  type CompletionEvidenceFact,
  type CompletionEvaluationSnapshot,
  type GovernanceCommandResult,
  type GovernanceRepository,
  type WorkLoopView
} from "@opentag/governance";
import type { GitHubVerifiedPullRequestSnapshot } from "@opentag/github";
import type { GitHubCompletionReconciliationEscalationRequest } from "@opentag/github";
import {
  createOpenTagRepository,
  type RecordVerificationEvidenceInput,
  type StoredVerificationEvidence
} from "@opentag/store";

type OpenTagRepository = ReturnType<typeof createOpenTagRepository>;

export type GitHubCompletionPolicy = {
  provider: "github";
  owner: string;
  repo: string;
  requiredChecks: string[];
  baseBranch?: string;
  requireMerge?: boolean;
};

/**
 * Zero-config completion behavior for GitHub-backed runs without an explicit
 * completion policy. "governed" gates runs that produce a pull request on
 * verified PR existence plus all observed checks passing; "compat" preserves
 * the legacy executor-success semantics.
 */
export type GitHubDefaultCompletionMode = "governed" | "compat";

export type BoundedCompletionWaiverInput = Pick<
  CompletionWaiver,
  "actor" | "reason" | "scope" | "policyScope" | "gateIds" | "waivedAt" | "expiresAt"
>;

function repositoryIdentity(event: OpenTagEvent): { provider: string; owner: string; repo: string } | null {
  const provider = event.metadata["repoProvider"];
  const owner = event.metadata["owner"];
  const repo = event.metadata["repo"];
  if (typeof provider !== "string" || typeof owner !== "string" || typeof repo !== "string") return null;
  return { provider, owner, repo };
}

function matchingPolicy(event: OpenTagEvent, policies: readonly GitHubCompletionPolicy[]): GitHubCompletionPolicy | undefined {
  const identity = repositoryIdentity(event);
  if (!identity || identity.provider !== "github") return undefined;
  return policies.find((policy) =>
    policy.owner.toLowerCase() === identity.owner.toLowerCase()
    && policy.repo.toLowerCase() === identity.repo.toLowerCase()
  );
}

function validatePolicies(policies: readonly GitHubCompletionPolicy[]): GitHubCompletionPolicy[] {
  const seen = new Set<string>();
  return policies.map((policy, index) => {
    const owner = policy.owner.trim();
    const repo = policy.repo.trim();
    const requiredChecks = [...new Set(policy.requiredChecks.map((name) => name.trim()).filter(Boolean))].sort();
    if (!owner || !repo) throw new Error(`GitHub completion policy ${index} must identify a non-empty owner and repository.`);
    if (requiredChecks.length === 0) throw new Error(`GitHub completion policy ${owner}/${repo} must configure at least one required check.`);
    const key = `${owner}/${repo}`.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate GitHub completion policy for ${owner}/${repo}.`);
    seen.add(key);
    return { ...policy, owner, repo, requiredChecks };
  });
}

function strictContract(input: {
  workThreadId: string;
  policy: GitHubCompletionPolicy;
  createdAt: string;
}): CompletionContract {
  const policyRef = `github:${input.policy.owner}/${input.policy.repo}`;
  return CompletionContractSchema.parse({
    id: `completion:${input.workThreadId}:github-pr`,
    version: 1,
    workThreadId: input.workThreadId,
    cycle: 1,
    mode: "governed",
    targetSelectors: [{ key: "primary_change", kind: "change_request", lineage: "current_cycle", cardinality: "exactly_one" }],
    resolvedFrom: [{ scope: "work_context_owner_container", ref: policyRef, version: "1" }],
    gates: [
      { id: "pull_request", kind: "artifact", targetKey: "primary_change", artifactKind: "pull_request", minimum: 1 },
      {
        id: "required_checks",
        kind: "verification",
        targetKey: "primary_change",
        evidenceKind: "source_control.required_checks",
        requiredObservations: [...new Set(input.policy.requiredChecks)].sort(),
        requiredOutcome: "passed",
        minimumAssurance: "verified"
      },
      ...(input.policy.baseBranch
        ? [{
            id: "base_branch",
            kind: "verification" as const,
            targetKey: "primary_change",
            evidenceKind: "source_control.pull_request",
            requiredObservations: [`base:${input.policy.baseBranch}`],
            requiredOutcome: "passed",
            minimumAssurance: "verified" as const
          }]
        : []),
      ...(input.policy.requireMerge === false
        ? []
        : [{
            id: "merge",
            kind: "external_state" as const,
            targetKey: "primary_change",
            provider: "github" as const,
            requiredState: "merged",
            minimumAssurance: "verified" as const
          }])
    ],
    maxAutomaticRetries: 1,
    onSatisfied: "report_only",
    createdAt: input.createdAt
  });
}

function defaultVerifiedContract(input: {
  workThreadId: string;
  repository: { owner: string; repo: string };
  createdAt: string;
  version?: number;
}): CompletionContract {
  return CompletionContractSchema.parse({
    id: `completion:${input.workThreadId}:github-pr-default`,
    version: input.version ?? 1,
    workThreadId: input.workThreadId,
    cycle: 1,
    mode: "governed",
    targetSelectors: [{ key: "primary_change", kind: "change_request", lineage: "current_cycle", cardinality: "exactly_one" }],
    resolvedFrom: [{ scope: "organization_default", ref: `github-default:${input.repository.owner}/${input.repository.repo}`, version: "1" }],
    gates: [
      { id: "pull_request", kind: "artifact", targetKey: "primary_change", artifactKind: "pull_request", minimum: 1 },
      {
        id: "observed_checks",
        kind: "verification",
        targetKey: "primary_change",
        evidenceKind: "source_control.observed_checks_rollup",
        requiredOutcome: "passed",
        minimumAssurance: "verified"
      }
    ],
    maxAutomaticRetries: 1,
    onSatisfied: "report_only",
    createdAt: input.createdAt
  });
}

function compatibilityContract(input: { workThreadId: string; createdAt: string }): CompletionContract {
  return CompletionContractSchema.parse({
    id: `completion:${input.workThreadId}:compat`,
    version: 1,
    workThreadId: input.workThreadId,
    cycle: 1,
    mode: "execution_compat",
    targetSelectors: [],
    resolvedFrom: [{ scope: "organization_default", ref: "execution-compatibility", version: "1" }],
    gates: [{ id: "execution", kind: "material_action", actionFamily: "executor_run", requiredOutcome: "succeeded" }],
    maxAutomaticRetries: 0,
    onSatisfied: "report_only",
    createdAt: input.createdAt
  });
}

function parseGitHubPullRequestUrl(
  uri: string,
  repository: { owner: string; repo: string }
): { resourceRef: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/u);
  if (!match) return null;
  const [, owner, repo, number] = match;
  if (!owner || !repo || !number) return null;
  if (owner.toLowerCase() !== repository.owner.toLowerCase() || repo.toLowerCase() !== repository.repo.toLowerCase()) return null;
  return { resourceRef: `github:${repository.owner}/${repository.repo}:pull_request:${number}` };
}

function completionFactFromStoredEvidence(record: StoredVerificationEvidence): CompletionEvidenceFact | null {
  const metadata = record.evidence.metadata;
  const direct = metadata?.["completionFact"];
  const template = metadata?.["completionFactTemplate"];
  const value = direct ?? (record.workThreadId && template && typeof template === "object" && !Array.isArray(template)
    ? { ...template as Record<string, unknown>, workThreadId: record.workThreadId }
    : null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fact = value as Partial<CompletionEvidenceFact>;
  if (
    typeof fact.id !== "string"
    || typeof fact.workThreadId !== "string"
    || typeof fact.cycle !== "number"
    || typeof fact.kind !== "string"
    || (fact.assurance !== "verified" && fact.assurance !== "reported" && fact.assurance !== "unverifiable")
    || !fact.subject
    || typeof fact.subject.provider !== "string"
    || typeof fact.subject.resourceRef !== "string"
    || typeof fact.subject.resourceVersion !== "string"
    || !fact.claim
    || typeof fact.claim.predicate !== "string"
    || typeof fact.claim.outcome !== "string"
    || !fact.provenance
    || typeof fact.provenance.adapter !== "string"
    || typeof fact.provenance.adapterVersion !== "string"
    || typeof fact.provenance.payloadDigest !== "string"
    || typeof fact.observedAt !== "string"
    || typeof fact.receivedAt !== "string"
  ) return null;
  return fact as CompletionEvidenceFact;
}

function factDigest(snapshotDigest: string, kind: string): string {
  return `sha256:${createHash("sha256").update(`${snapshotDigest}:${kind}`).digest("hex")}`;
}

function canonicalizeGitHubCompletionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeGitHubCompletionValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeGitHubCompletionValue(child)])
    );
  }
  return value;
}

function githubCompletionSemanticDigest(snapshot: GitHubVerifiedPullRequestSnapshot): string {
  const semanticSnapshot = {
    provider: snapshot.provider,
    repository: snapshot.repository,
    pullRequest: snapshot.pullRequest,
    checks: snapshot.checks
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeGitHubCompletionValue(semanticSnapshot)))
    .digest("hex")}`;
}

function observedChecksRollupOutcome(checks: Record<string, "passed" | "failed" | "pending">): "passed" | "failed" | "pending" {
  const states = Object.values(checks);
  if (states.some((state) => state === "failed")) return "failed";
  if (states.some((state) => state === "pending")) return "pending";
  return "passed";
}

function githubFactTemplates(input: {
  snapshot: GitHubVerifiedPullRequestSnapshot;
  receivedAt: string;
}): Array<Omit<CompletionEvidenceFact, "workThreadId">> {
  const semanticDigest = githubCompletionSemanticDigest(input.snapshot);
  const common = {
    cycle: 1,
    assurance: "verified" as const,
    subject: {
      provider: "github",
      resourceRef: input.snapshot.pullRequest.resourceRef,
      resourceVersion: input.snapshot.pullRequest.headSha
    },
    observedAt: input.snapshot.observedAt,
    receivedAt: input.receivedAt
  };
  const provenance = (kind: string) => ({
    adapter: "@opentag/github",
    adapterVersion: "0.8.0",
    payloadDigest: factDigest(semanticDigest, kind),
    providerDeliveryId: input.snapshot.deliveryId
  });
  const idPrefix = `github:${input.snapshot.deliveryId}:pr:${input.snapshot.pullRequest.number}:${input.snapshot.pullRequest.headSha}`;
  return [
    {
      ...common,
      id: `${idPrefix}:identity`,
      kind: "source_control.pull_request",
      claim: {
        predicate: "existence",
        outcome: "passed",
        observations: {
          [`base:${input.snapshot.pullRequest.baseBranch}`]: "passed",
          base_branch: input.snapshot.pullRequest.baseBranch,
          base_sha: input.snapshot.pullRequest.baseSha
        }
      },
      provenance: provenance("source_control.pull_request")
    },
    {
      ...common,
      id: `${idPrefix}:checks`,
      kind: "source_control.required_checks",
      claim: { predicate: "checks", outcome: "passed", observations: input.snapshot.checks },
      provenance: provenance("source_control.required_checks")
    },
    {
      ...common,
      id: `${idPrefix}:state`,
      kind: "source_control.pull_request_state",
      claim: { predicate: "state", outcome: input.snapshot.pullRequest.state },
      provenance: provenance("source_control.pull_request_state")
    },
    {
      ...common,
      id: `${idPrefix}:checks-rollup`,
      kind: "source_control.observed_checks_rollup",
      claim: {
        predicate: "checks_rollup",
        outcome: observedChecksRollupOutcome(input.snapshot.checks),
        observations: input.snapshot.checks
      },
      provenance: provenance("source_control.observed_checks_rollup")
    }
  ];
}

function githubEvidenceRecords(input: {
  snapshot: GitHubVerifiedPullRequestSnapshot;
  receivedAt: string;
  workThreadId?: string;
}): RecordVerificationEvidenceInput[] {
  return githubFactTemplates(input).map((template) => {
    const fact = input.workThreadId ? { ...template, workThreadId: input.workThreadId } : null;
    return {
      id: template.id,
      ...(input.workThreadId ? { workThreadId: input.workThreadId } : {}),
      provider: "github",
      deliveryId: input.snapshot.deliveryId,
      subjectRef: input.snapshot.pullRequest.resourceRef,
      subjectVersion: input.snapshot.pullRequest.headSha,
      evidence: {
        id: template.id,
        kind: template.kind,
        assurance: "verified",
        subjectRef: `${template.subject.resourceRef}@${template.subject.resourceVersion}`,
        summary: `${template.claim.predicate}=${template.claim.outcome}`,
        sourceRef: `github-api:${input.snapshot.eventName}`,
        createdAt: input.snapshot.observedAt,
        metadata: fact ? { completionFact: fact } : { completionFactTemplate: template }
      },
      payloadDigest: template.provenance.payloadDigest,
      observedAt: input.snapshot.observedAt,
      receivedAt: input.receivedAt
    };
  });
}

function githubSnapshotSetRecords(input: {
  snapshots: GitHubVerifiedPullRequestSnapshot[];
  receivedAt: string;
}): { records: RecordVerificationEvidenceInput[]; manifestDigest: string } {
  const first = input.snapshots[0]!;
  const subjects = input.snapshots.map((snapshot) => ({
    subjectRef: snapshot.pullRequest.resourceRef,
    subjectVersion: snapshot.pullRequest.headSha,
    semanticDigest: githubCompletionSemanticDigest(snapshot)
  })).sort((left, right) => left.subjectRef.localeCompare(right.subjectRef));
  const manifest = {
    provider: "github" as const,
    deliveryId: first.deliveryId,
    eventName: first.eventName,
    repository: first.repository,
    subjects
  };
  const manifestDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeGitHubCompletionValue(manifest)))
    .digest("hex")}`;
  const manifestRef = `github:${first.repository.owner}/${first.repository.repo}:completion_delivery:${first.deliveryId}`;
  const observedAt = input.snapshots.map((snapshot) => snapshot.observedAt).sort().at(-1)!;
  return {
    manifestDigest,
    records: [
      ...input.snapshots.flatMap((snapshot) => githubEvidenceRecords({
        snapshot,
        receivedAt: input.receivedAt
      })),
      {
        id: `github:${first.deliveryId}:snapshot-set`,
        provider: "github",
        deliveryId: first.deliveryId,
        subjectRef: manifestRef,
        subjectVersion: "snapshot-set-v1",
        evidence: {
          id: `github:${first.deliveryId}:snapshot-set`,
          kind: "github.completion_snapshot_set",
          assurance: "verified",
          subjectRef: manifestRef,
          summary: `GitHub completion delivery contains ${subjects.length} pull request snapshot(s).`,
          sourceRef: `github-api:${first.eventName}`,
          createdAt: observedAt,
          metadata: { snapshotSetManifest: manifest }
        },
        payloadDigest: manifestDigest,
        observedAt,
        receivedAt: input.receivedAt
      }
    ]
  };
}

function artifactsFromRuns(input: {
  runs: Array<{ run: OpenTagRun; event: OpenTagEvent }>;
  evidence: CompletionEvidenceFact[];
  contract: CompletionContract;
}): CompletionArtifact[] {
  const artifacts: CompletionArtifact[] = [];
  for (const stored of input.runs) {
    const result = stored.run.result;
    if (!result) continue;
    const repository = repositoryIdentity(stored.event);
    if (!repository || repository.provider !== "github") continue;
    const candidates = [
      ...(result.createdPullRequestUrl
        ? [{ id: `${stored.run.id}:created-pull-request`, kind: "pull_request", uri: result.createdPullRequestUrl }]
        : []),
      ...(result.artifacts ?? []).map((artifact, index) => ({
        id: artifact.id ?? `${stored.run.id}:artifact:${index}`,
        kind: artifact.kind ?? artifact.type ?? "custom",
        uri: artifact.uri
      }))
    ];
    for (const candidate of candidates) {
      if (candidate.kind !== "pull_request") continue;
      const parsed = parseGitHubPullRequestUrl(candidate.uri, repository);
      if (!parsed) continue;
      const authoritative = [...input.evidence]
        .filter((fact) =>
          fact.assurance === "verified"
          && fact.subject.provider === "github"
          && fact.subject.resourceRef === parsed.resourceRef
        )
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
        .at(-1);
      artifacts.push({
        id: candidate.id,
        kind: "pull_request",
        sourceRunId: stored.run.id,
        uri: candidate.uri,
        target: {
          key: "primary_change",
          provider: "github",
          resourceRef: parsed.resourceRef,
          resourceVersion: authoritative?.subject.resourceVersion ?? "unverified"
        },
        recordedAt: stored.run.updatedAt
      });
    }
  }
  return artifacts;
}

export function currentWorkThreadRun<T extends { run: Pick<OpenTagRun, "id" | "createdAt"> }>(runs: readonly T[]): T | undefined {
  return [...runs].sort((left, right) =>
    sqliteBinaryTextCompare(left.run.createdAt, right.run.createdAt)
      || sqliteBinaryTextCompare(left.run.id, right.run.id)
  ).at(-1);
}

function sqliteBinaryTextCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function currentDeliveryCycleRuns(
  runs: Array<{ run: OpenTagRun; event: OpenTagEvent }>
): Array<{ run: OpenTagRun; event: OpenTagEvent }> {
  const latest = currentWorkThreadRun(runs);
  return latest ? [latest] : [];
}

function githubPullRequestResourceRefs(stored: { run: OpenTagRun; event: OpenTagEvent }): Set<string> {
  const repository = repositoryIdentity(stored.event);
  if (!repository || repository.provider !== "github" || !stored.run.result) return new Set();
  const result = stored.run.result;
  const uris = [
    ...(result.createdPullRequestUrl ? [result.createdPullRequestUrl] : []),
    ...(result.artifacts ?? []).flatMap((artifact) =>
      (artifact.kind ?? artifact.type) === "pull_request" ? [artifact.uri] : []
    )
  ];
  return new Set(uris.flatMap((uri) => {
    const parsed = parseGitHubPullRequestUrl(uri, repository);
    return parsed ? [parsed.resourceRef] : [];
  }));
}

type CurrentWorkThreadCorrelationIndex = {
  currentRunsByWorkThreadId: Map<string, { run: OpenTagRun; event: OpenTagEvent }>;
  workThreadIdsByResourceRef: Map<string, string[]>;
};

async function loadCurrentWorkThreadCorrelationIndex(input: {
  repo: OpenTagRepository;
}): Promise<CurrentWorkThreadCorrelationIndex> {
  const currentRunsByWorkThreadId = new Map<string, { run: OpenTagRun; event: OpenTagEvent }>();
  const workThreadIdSetsByResourceRef = new Map<string, Set<string>>();
  for (const stored of await input.repo.listCurrentWorkThreadRunsWithResults()) {
    const workThreadId = stored.run.thread?.id;
    if (!workThreadId) continue;
    currentRunsByWorkThreadId.set(workThreadId, stored);
    for (const resourceRef of githubPullRequestResourceRefs(stored)) {
      const workThreadIds = workThreadIdSetsByResourceRef.get(resourceRef) ?? new Set<string>();
      workThreadIds.add(workThreadId);
      workThreadIdSetsByResourceRef.set(resourceRef, workThreadIds);
    }
  }
  return {
    currentRunsByWorkThreadId,
    workThreadIdsByResourceRef: new Map([...workThreadIdSetsByResourceRef].map(([resourceRef, workThreadIds]) =>
      [resourceRef, [...workThreadIds].sort()]
    ))
  };
}

function matchingWorkThreadIds(input: {
  correlationIndex: CurrentWorkThreadCorrelationIndex;
  resourceRef: string;
}): string[] {
  return input.correlationIndex.workThreadIdsByResourceRef.get(input.resourceRef) ?? [];
}

async function attachCorrelatableEvidence(input: {
  repo: OpenTagRepository;
  attachedAt: string;
  correlationIndex: CurrentWorkThreadCorrelationIndex;
}): Promise<Set<string>> {
  const uncorrelated = (await input.repo.listVerificationEvidence({})).filter((record) =>
    record.provider === "github" && !record.workThreadId && record.evidence.metadata?.["completionFactTemplate"]
  );
  const attachedThreads = new Set<string>();
  const identities = new Map<string, StoredVerificationEvidence>();
  for (const record of uncorrelated) {
    identities.set(JSON.stringify([record.provider, record.deliveryId, record.subjectRef]), record);
  }
  for (const record of identities.values()) {
    const candidates = matchingWorkThreadIds({ correlationIndex: input.correlationIndex, resourceRef: record.subjectRef });
    if (candidates.length !== 1) continue;
    await input.repo.attachVerificationEvidenceDeliveryToWorkThread({
      provider: record.provider,
      deliveryId: record.deliveryId,
      subjectRef: record.subjectRef,
      workThreadId: candidates[0]!,
      attachedAt: input.attachedAt
    });
    attachedThreads.add(candidates[0]!);
  }
  return attachedThreads;
}

async function ensureContract(input: {
  repo: OpenTagRepository;
  run: OpenTagRun;
  event: OpenTagEvent;
  policies: readonly GitHubCompletionPolicy[];
  defaultGitHubCompletion: GitHubDefaultCompletionMode;
}): Promise<CompletionContract> {
  const workThreadId = input.run.thread?.id;
  if (!workThreadId) throw new Error(`Run ${input.run.id} has no durable WorkThread.`);
  const policy = matchingPolicy(input.event, input.policies);
  const repository = repositoryIdentity(input.event);
  const defaultVerifiedEligible = !policy
    && input.defaultGitHubCompletion === "governed"
    && repository?.provider === "github"
    && githubPullRequestResourceRefs({ run: input.run, event: input.event }).size > 0;
  const existing = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
  if (existing) {
    // A thread that started with informational runs holds the compatibility
    // contract; once a later run ships a pull request, upgrade it to the
    // default verified contract so the new change is evidence-gated.
    const upgradeable = existing.mode === "execution_compat"
      && existing.id === `completion:${workThreadId}:compat`
      && defaultVerifiedEligible;
    if (!upgradeable) return existing;
    const upgraded = defaultVerifiedContract({
      workThreadId,
      repository: { owner: repository!.owner, repo: repository!.repo },
      createdAt: input.run.createdAt,
      version: existing.version + 1
    });
    return (await input.repo.recordCompletionContract({ contract: upgraded })).contract;
  }
  const contract = policy
    ? strictContract({ workThreadId, policy, createdAt: input.run.createdAt })
    : defaultVerifiedEligible
      ? defaultVerifiedContract({
          workThreadId,
          repository: { owner: repository!.owner, repo: repository!.repo },
          createdAt: input.run.createdAt
        })
      : compatibilityContract({ workThreadId, createdAt: input.run.createdAt });
  return (await input.repo.recordCompletionContract({ contract })).contract;
}

export type GitHubCompletionEvidenceIngestion = {
  outcome: "recorded" | "duplicate" | "uncorrelated" | "ambiguous";
  workThreadId?: string;
  completion?: WorkLoopView;
};

export type GitHubCompletionEvidenceBatchIngestion = {
  outcome: "recorded" | "duplicate";
  manifestDigest: string;
  workThreadIds: string[];
};

export type CompletionExplanation = WorkLoopView & {
  contractSnapshot: CompletionContract;
  assessmentHistory: CompletionAssessment[];
  evidence: CompletionEvidenceFact[];
  openHumanEscalations: HumanEscalation[];
};

export type CompletionSourceThreadTransition = {
  runId: string;
  event: OpenTagEvent;
  completion: WorkLoopView;
  transitionKey: string;
};

export function createDispatcherCompletionGovernance(input: {
  repo: OpenTagRepository;
  policies?: readonly GitHubCompletionPolicy[];
  defaultGitHubCompletion?: GitHubDefaultCompletionMode;
  now?: () => string;
  deferReassessment?: boolean;
}) {
  const policies = validatePolicies(input.policies ?? []);
  const defaultGitHubCompletion = input.defaultGitHubCompletion ?? "governed";
  const governanceRepository: GovernanceRepository = {
    async loadEvaluationSnapshot(workThreadId): Promise<CompletionEvaluationSnapshot> {
      const contract = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
      if (!contract) throw new Error(`WorkThread ${workThreadId} has no completion contract.`);
      const runs = currentDeliveryCycleRuns(await input.repo.listRunsForWorkThread({ workThreadId }));
      const currentRun = runs[0]?.run;
      const currentAssessment = await input.repo.getCurrentCompletionAssessment({ workThreadId });
      const blockingEscalations = (await input.repo.listHumanEscalations({ workThreadId })).filter((escalation) =>
        escalation.blocking
        && Boolean(currentRun)
        && escalation.runId === currentRun!.id
      );
      const storedEvidence = (await input.repo.listVerificationEvidence({ workThreadId }))
        .filter((record) => !currentRun || record.receivedAt >= currentRun.createdAt);
      const evidence = storedEvidence.map(completionFactFromStoredEvidence).filter((fact): fact is CompletionEvidenceFact => Boolean(fact));
      return {
        contract,
        runResults: runs.flatMap(({ run }) => run.result ? [{ runId: run.id, result: run.result, recordedAt: run.updatedAt }] : []),
        artifacts: artifactsFromRuns({ runs, evidence, contract }),
        evidence,
        materialActionReceipts: currentRun
          ? await input.repo.listMaterialActionReceiptsForRun({ runId: currentRun.id })
          : [],
        waivers: currentRun
          ? (await input.repo.listCompletionWaivers({ workThreadId }))
            .filter((waiver) => waiver.runId === currentRun.id)
          : [],
        blockingEscalations,
        currentAssessment
      };
    },
    async recordEvidence(fact) {
      const recorded = await input.repo.recordVerificationEvidence({
        id: fact.id,
        workThreadId: fact.workThreadId,
        provider: fact.subject.provider,
        deliveryId: fact.provenance.providerDeliveryId ?? fact.provenance.sourceEventId ?? fact.id,
        subjectRef: fact.subject.resourceRef,
        subjectVersion: fact.subject.resourceVersion,
        evidence: {
          id: fact.id,
          kind: fact.kind,
          assurance: fact.assurance,
          subjectRef: `${fact.subject.resourceRef}@${fact.subject.resourceVersion}`,
          summary: `${fact.claim.predicate}=${fact.claim.outcome}`,
          sourceRef: `${fact.provenance.adapter}@${fact.provenance.adapterVersion}`,
          createdAt: fact.observedAt,
          metadata: { completionFact: fact }
        },
        payloadDigest: fact.provenance.payloadDigest,
        observedAt: fact.observedAt,
        receivedAt: fact.receivedAt
      });
      return { created: recorded.created };
    },
    async recordWaiver(waiver: CompletionWaiver) {
      const recorded = await input.repo.recordCompletionWaiver({ waiver });
      return { created: recorded.created };
    },
    async resolveHumanEscalation(escalation: HumanEscalation) {
      return input.repo.resolveHumanEscalation({ escalation });
    },
    async appendAssessment(assessmentInput) {
      return input.repo.appendCompletionAssessment(assessmentInput);
    },
    async listHumanEscalations(workThreadId) {
      return input.repo.listHumanEscalations({ workThreadId });
    }
  };
  const governance = createOpenTagGovernance({
    repository: governanceRepository,
    clock: { now: input.now ?? (() => new Date().toISOString()) }
  });
  const reassessmentTails = new Map<string, Promise<GovernanceCommandResult>>();

  async function readPersistedWorkLoop(workThreadId: string): Promise<WorkLoopView | null> {
    const contract = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
    if (!contract) return null;
    const snapshot = await governanceRepository.loadEvaluationSnapshot(workThreadId);
    if (!snapshot.currentAssessment) return null;
    return deriveWorkLoopView({
      contract: snapshot.contract,
      runResults: snapshot.runResults,
      materialActionReceipts: snapshot.materialActionReceipts,
      blockingEscalations: snapshot.blockingEscalations,
      assessment: snapshot.currentAssessment
    });
  }

  async function syncHumanEscalation(result: GovernanceCommandResult): Promise<void> {
    const assessment = result.assessment;
    const dedupeKey = `completion:${assessment.contractId}:${assessment.contractVersion}:${assessment.cycle}:blocked`;
    const active = (await input.repo.listHumanEscalations({ workThreadId: assessment.workThreadId }))
      .filter((escalation) => escalation.state === "open" || escalation.state === "acknowledged");
    if (assessment.state === "blocked") {
      if (active.some((escalation) => escalation.blocking && escalation.class === "reconciliation")) return;
      const semantic = `${assessment.workThreadId}:${dedupeKey}`;
      await input.repo.openHumanEscalation({
        escalation: {
          id: `escalation_${createHash("sha256").update(semantic).digest("hex").slice(0, 24)}`,
          workThreadId: assessment.workThreadId,
          ...(assessment.triggeredByRunId ? { runId: assessment.triggeredByRunId } : {}),
          class: "verification",
          audience: "repo_owner",
          subjectRef: `${assessment.contractId}@${assessment.contractVersion}`,
          state: "open",
          blocking: true,
          summary: "Completion verification needs human attention.",
          reason: result.view.nextAction.summary,
          nextAction: { kind: "request_human_decision", targetId: assessment.workThreadId },
          dedupeKey,
          openedAt: assessment.assessedAt
        }
      });
      return;
    }
    for (const escalation of active.filter((candidate) => candidate.dedupeKey?.startsWith("completion:"))) {
      await input.repo.resolveHumanEscalation({
        escalation: {
          ...escalation,
          state: "resolved",
          resolution: {
            actor: { provider: "opentag", providerUserId: "completion-governance", handle: "opentag" },
            reason: `Completion assessment advanced to ${assessment.state}.`,
            resolvedAt: assessment.assessedAt
          }
        }
      });
    }
  }

  async function reassess(workThreadId: string, commandId: string): Promise<GovernanceCommandResult> {
    const previous = reassessmentTails.get(workThreadId);
    const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
      const result = await governance.execute({ type: "reassess_completion", commandId, workThreadId });
      await syncHumanEscalation(result);
      return result;
    });
    reassessmentTails.set(workThreadId, task);
    try {
      return await task;
    } finally {
      if (reassessmentTails.get(workThreadId) === task) reassessmentTails.delete(workThreadId);
    }
  }

  async function buildCompletionExplanation(workThreadId: string): Promise<CompletionExplanation | null> {
    const contractSnapshot = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
    if (!contractSnapshot) return null;
    await reassess(workThreadId, `explain-work-thread:${workThreadId}`);
    const [completion, assessmentHistory, storedEvidence, escalations] = await Promise.all([
      governance.read({ type: "get_work_loop", workThreadId }) as Promise<WorkLoopView>,
      input.repo.listCompletionAssessments({ workThreadId }),
      input.repo.listVerificationEvidence({ workThreadId }),
      input.repo.listHumanEscalations({ workThreadId })
    ]);
    return {
      ...completion,
      contractSnapshot,
      assessmentHistory,
      evidence: storedEvidence
        .map(completionFactFromStoredEvidence)
        .filter((fact): fact is CompletionEvidenceFact => Boolean(fact)),
      openHumanEscalations: escalations.filter((escalation) =>
        escalation.state === "open" || escalation.state === "acknowledged"
      )
    };
  }

  async function ingestGitHubSnapshotSetWithCorrelationIndex(
    snapshots: GitHubVerifiedPullRequestSnapshot[],
    correlationIndex: CurrentWorkThreadCorrelationIndex
  ): Promise<GitHubCompletionEvidenceBatchIngestion> {
    if (snapshots.length === 0) throw new Error("GitHub completion evidence snapshot set cannot be empty.");
    const ordered = [...snapshots].sort((left, right) =>
      left.pullRequest.resourceRef.localeCompare(right.pullRequest.resourceRef)
    );
    const first = ordered[0]!;
    const subjectRefs = new Set<string>();
    for (const snapshot of ordered) {
      const expectedRef = `github:${snapshot.repository.owner}/${snapshot.repository.repo}:pull_request:${snapshot.pullRequest.number}`;
      if (snapshot.pullRequest.resourceRef !== expectedRef) {
        throw new Error("GitHub completion evidence resource identity does not match its repository and pull request number.");
      }
      if (snapshot.deliveryId !== first.deliveryId
        || snapshot.eventName !== first.eventName
        || snapshot.repository.owner !== first.repository.owner
        || snapshot.repository.repo !== first.repository.repo) {
        throw new Error("GitHub completion evidence snapshot set must share one delivery, event, and repository.");
      }
      if (subjectRefs.has(snapshot.pullRequest.resourceRef)) {
        throw new Error("GitHub completion evidence snapshot set contains a duplicate pull request subject.");
      }
      subjectRefs.add(snapshot.pullRequest.resourceRef);
    }
    const receivedAt = input.now?.() ?? new Date().toISOString();
    const snapshotSet = githubSnapshotSetRecords({ snapshots: ordered, receivedAt });
    const existingDelivery = (await input.repo.listVerificationEvidence({})).filter((record) =>
      record.provider === "github"
      && record.deliveryId === first.deliveryId
    );
    if (existingDelivery.length > 0) {
      const existingIdentity = [...new Set(existingDelivery.map((record) => JSON.stringify([
        record.subjectRef,
        record.subjectVersion,
        record.evidence.kind,
        record.payloadDigest
      ])))].sort();
      const replayIdentity = [...new Set(snapshotSet.records.map((record) => JSON.stringify([
        record.subjectRef,
        record.subjectVersion,
        record.evidence.kind,
        record.payloadDigest
      ])))].sort();
      if (JSON.stringify(existingIdentity) !== JSON.stringify(replayIdentity)) {
        throw new Error("GitHub completion evidence delivery payload conflicts with its durable record.");
      }
    } else {
      await input.repo.recordVerificationEvidenceBatch({ records: snapshotSet.records });
    }
    await attachCorrelatableEvidence({ repo: input.repo, attachedAt: receivedAt, correlationIndex });
    const attachedWorkThreadIds = [...new Set((await input.repo.listVerificationEvidence({})).flatMap((record) =>
      record.provider === "github" && record.deliveryId === first.deliveryId && record.workThreadId
        ? [record.workThreadId]
        : []
    ))].sort();
    if (!input.deferReassessment) {
      for (const workThreadId of attachedWorkThreadIds) {
        await reassess(workThreadId, `github-evidence-set:${first.deliveryId}:${snapshotSet.manifestDigest}`);
      }
    }
    return {
      outcome: existingDelivery.length > 0 ? "duplicate" : "recorded",
      manifestDigest: snapshotSet.manifestDigest,
      workThreadIds: attachedWorkThreadIds
    };
  }

  return {
    async ingestRunResult(runId: string): Promise<GovernanceCommandResult | null> {
      const stored = await input.repo.getRun({ runId });
      if (!stored?.run.thread?.id || !stored.run.result) return null;
      await ensureContract({ repo: input.repo, run: stored.run, event: stored.event, policies, defaultGitHubCompletion });
      const correlationIndex = await loadCurrentWorkThreadCorrelationIndex({ repo: input.repo });
      await attachCorrelatableEvidence({
        repo: input.repo,
        attachedAt: input.now?.() ?? new Date().toISOString(),
        correlationIndex
      });
      const result = await governance.execute({
        type: "ingest_run_result",
        commandId: `run-result:${runId}:${stored.run.updatedAt}`,
        workThreadId: stored.run.thread.id,
        runId
      });
      await syncHumanEscalation(result);
      return result;
    },

    async ingestEvidence(fact: CompletionEvidenceFact): Promise<GovernanceCommandResult> {
      const result = await governance.execute({ type: "ingest_evidence", commandId: `evidence:${fact.id}`, evidence: fact });
      await syncHumanEscalation(result);
      return result;
    },

    async reassessRun(runId: string): Promise<GovernanceCommandResult | null> {
      const stored = await input.repo.getRun({ runId });
      const workThreadId = stored?.run.thread?.id;
      if (!workThreadId) return null;
      const contract = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
      if (!contract) return null;
      return reassess(workThreadId, `reassess-run:${runId}`);
    },

    async applyWaiverForRun(runId: string, waiverInput: BoundedCompletionWaiverInput): Promise<GovernanceCommandResult | null> {
      const stored = await input.repo.getRun({ runId });
      const workThreadId = stored?.run.thread?.id;
      if (!workThreadId) return null;
      const contract = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
      if (!contract) return null;
      if (contract.mode !== "governed") throw new Error("Execution-compatibility contracts cannot be waived.");
      const gateIds = [...new Set(waiverInput.gateIds)].sort();
      if (gateIds.some((gateId) => !contract.gates.some((gate) => gate.id === gateId))) {
        throw new Error("A completion waiver may target only gates in the current contract snapshot.");
      }
      if (!contract.resolvedFrom.some((source) => source.scope === waiverInput.policyScope)) {
        throw new Error("A completion waiver policy scope must match the current contract authority.");
      }
      if (waiverInput.expiresAt && waiverInput.expiresAt <= waiverInput.waivedAt) {
        throw new Error("A completion waiver expiresAt must be later than waivedAt.");
      }
      const semantic = JSON.stringify({
        workThreadId,
        runId,
        contractId: contract.id,
        contractVersion: contract.version,
        cycle: contract.cycle,
        actor: waiverInput.actor,
        reason: waiverInput.reason,
        scope: waiverInput.scope,
        policyScope: waiverInput.policyScope,
        gateIds,
        waivedAt: waiverInput.waivedAt,
        expiresAt: waiverInput.expiresAt ?? null
      });
      const id = `waiver_${createHash("sha256").update(semantic).digest("hex").slice(0, 24)}`;
      const waiver: CompletionWaiver = {
        id,
        runId,
        contractId: contract.id,
        contractVersion: contract.version,
        cycle: contract.cycle,
        actor: waiverInput.actor,
        reason: waiverInput.reason,
        scope: waiverInput.scope,
        policyScope: waiverInput.policyScope,
        gateIds,
        waivedAt: waiverInput.waivedAt,
        ...(waiverInput.expiresAt ? { expiresAt: waiverInput.expiresAt } : {})
      };
      const result = await governance.execute({
        type: "apply_completion_waiver",
        commandId: `completion-waiver:${id}`,
        workThreadId,
        waiver
      });
      await syncHumanEscalation(result);
      return result;
    },

    async ingestGitHubSnapshotSet(
      snapshots: GitHubVerifiedPullRequestSnapshot[]
    ): Promise<GitHubCompletionEvidenceBatchIngestion> {
      const correlationIndex = await loadCurrentWorkThreadCorrelationIndex({ repo: input.repo });
      return ingestGitHubSnapshotSetWithCorrelationIndex(snapshots, correlationIndex);
    },

    async ingestGitHubSnapshot(snapshot: GitHubVerifiedPullRequestSnapshot): Promise<GitHubCompletionEvidenceIngestion> {
      const correlationIndex = await loadCurrentWorkThreadCorrelationIndex({ repo: input.repo });
      const candidates = matchingWorkThreadIds({ correlationIndex, resourceRef: snapshot.pullRequest.resourceRef });
      const batch = await ingestGitHubSnapshotSetWithCorrelationIndex([snapshot], correlationIndex);
      const workThreadId = batch.workThreadIds.length === 1 ? batch.workThreadIds[0] : undefined;
      if (!workThreadId) return { outcome: candidates.length > 1 ? "ambiguous" : "uncorrelated" };
      const completion = input.deferReassessment
        ? await this.readWorkLoop(workThreadId)
        : await this.getWorkLoop(workThreadId);
      return { outcome: batch.outcome, workThreadId, ...(completion ? { completion } : {}) };
    },

    async handleGitHubReconciliationEscalation(
      request: GitHubCompletionReconciliationEscalationRequest
    ): Promise<{ outcome: "opened" | "duplicate" | "resolved" | "already_resolved" | "uncorrelated" | "ambiguous"; workThreadId?: string }> {
      const resourceRefs = request.correlation.pullRequestNumbers.map((number) =>
        `github:${request.correlation.repository.owner}/${request.correlation.repository.repo}:pull_request:${number}`
      );
      const correlationIndex = await loadCurrentWorkThreadCorrelationIndex({ repo: input.repo });
      const resourceCandidates = [...new Set(resourceRefs.flatMap((resourceRef) =>
        matchingWorkThreadIds({ correlationIndex, resourceRef })
      ))].sort();
      const matchingHeadRecords = request.correlation.headSha
        ? (await input.repo.listVerificationEvidence({})).filter((record) =>
          record.provider === "github"
          && record.workThreadId
          && record.subjectVersion === request.correlation.headSha
          && record.subjectRef.startsWith(`github:${request.correlation.repository.owner}/${request.correlation.repository.repo}:pull_request:`)
        )
        : [];
      const headCandidates: string[] = [];
      for (const candidate of [...new Set(matchingHeadRecords.flatMap((record) => record.workThreadId ? [record.workThreadId] : []))].sort()) {
        const latestCandidateRun = correlationIndex.currentRunsByWorkThreadId.get(candidate);
        if (latestCandidateRun) {
          const currentResourceRefs = githubPullRequestResourceRefs(latestCandidateRun);
          if (matchingHeadRecords.some((record) =>
            record.workThreadId === candidate
            && record.receivedAt >= latestCandidateRun.run.createdAt
            && currentResourceRefs.has(record.subjectRef)
          )) headCandidates.push(candidate);
        }
      }
      const candidates = resourceCandidates.length > 0 ? resourceCandidates : headCandidates;
      if (candidates.length !== 1) return { outcome: candidates.length === 0 ? "uncorrelated" : "ambiguous" };
      const workThreadId = candidates[0]!;
      const latest = correlationIndex.currentRunsByWorkThreadId.get(workThreadId);
      if (!latest) return { outcome: "uncorrelated" };
      const active = (await input.repo.listHumanEscalations({ workThreadId }))
        .find((escalation) =>
          (escalation.state === "open" || escalation.state === "acknowledged")
          && escalation.dedupeKey === request.escalation.dedupeKey
          && escalation.runId === latest.run.id
        );
      if (request.operation === "resolve") {
        if (!active) return { outcome: "already_resolved", workThreadId };
        const resolvedAt = input.now?.() ?? new Date().toISOString();
        const result = await input.repo.resolveHumanEscalation({
          escalation: {
            ...active,
            state: "resolved",
            resolution: {
              actor: { provider: "github", providerUserId: "completion-reconciliation", handle: "opentag" },
              reason: request.escalation.reason,
              resolvedAt
            }
          }
        });
        if (!input.deferReassessment) {
          await reassess(workThreadId, `github-reconciliation-resolve:${request.escalation.dedupeKey}`);
        }
        return { outcome: result.resolved ? "resolved" : "already_resolved", workThreadId };
      }
      const openedAt = input.now?.() ?? new Date().toISOString();
      const generations = (await input.repo.listHumanEscalations({ workThreadId }))
        .filter((escalation) => escalation.dedupeKey === request.escalation.dedupeKey)
        .length;
      const semantic = `${workThreadId}:${request.escalation.dedupeKey}:generation:${generations + 1}`;
      const result = await input.repo.openHumanEscalation({
        escalation: {
          id: `escalation_${createHash("sha256").update(semantic).digest("hex").slice(0, 24)}`,
          workThreadId,
          runId: latest.run.id,
          class: request.escalation.class,
          audience: request.escalation.audience,
          subjectRef: request.escalation.subjectRef,
          state: "open",
          blocking: true,
          summary: request.escalation.summary,
          reason: request.escalation.reason,
          nextAction: { kind: "request_human_decision", targetId: request.escalation.subjectRef },
          dedupeKey: request.escalation.dedupeKey,
          openedAt
        }
      });
      if (!input.deferReassessment) {
        await reassess(workThreadId, `github-reconciliation-open:${request.escalation.dedupeKey}`);
      }
      return { outcome: result.created ? "opened" : "duplicate", workThreadId };
    },

    async getWorkLoop(workThreadId: string): Promise<WorkLoopView | null> {
      const contract = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
      if (!contract) return null;
      return (await reassess(workThreadId, `read-work-loop:${workThreadId}`)).view;
    },

    async reassessWorkThread(workThreadId: string, commandId: string): Promise<GovernanceCommandResult | null> {
      const contract = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
      if (!contract) return null;
      return reassess(workThreadId, commandId);
    },

    async readWorkLoop(workThreadId: string): Promise<WorkLoopView | null> {
      return readPersistedWorkLoop(workThreadId);
    },

    async explainWorkThread(workThreadId: string): Promise<CompletionExplanation | null> {
      return buildCompletionExplanation(workThreadId);
    },

    async explainRun(runId: string): Promise<CompletionExplanation | null> {
      const stored = await input.repo.getRun({ runId });
      const workThreadId = stored?.run.thread?.id;
      if (!workThreadId) return null;
      return buildCompletionExplanation(workThreadId);
    },

    async getSourceThreadTransition(workThreadId: string): Promise<CompletionSourceThreadTransition | null> {
      const assessments = await input.repo.listCompletionAssessments({ workThreadId });
      const current = assessments.at(-1);
      const previous = assessments.at(-2);
      if (!current || !previous || current.state === previous.state) return null;
      const latest = currentWorkThreadRun(await input.repo.listRunsForWorkThread({ workThreadId }));
      if (!latest?.run.result) return null;
      const completion = await governance.read({ type: "get_work_loop", workThreadId }) as WorkLoopView;
      return {
        runId: latest.run.id,
        event: latest.event,
        completion,
        transitionKey: `completion-transition:${current.id}:${current.state}`
      };
    }
  };
}
