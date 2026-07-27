import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { OpenTagEventSchema, type OpenTagEvent } from "../../packages/core/src/index.js";
import { normalizeGitHubIssueComment, type GitHubIssueCommentInput } from "../../packages/github/src/index.js";

type JsonObject = Record<string, unknown>;
const TRUSTED_NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

export type GitHubFactoryRegistryRuntimeArtifact = {
  expectedVersion: string;
  package: "@opentag/cli";
  version: string;
  registry: string;
  resolved: string;
  integrity: string;
  sourceNormalizer: {
    package: "@opentag/github";
    version: string;
    resolved: string;
    integrity: string;
  };
  eventSchema: {
    package: "@opentag/core";
    version: string;
    resolved: string;
    integrity: string;
  };
};

export type GitHubFactoryAcceptanceEvidence = {
  recordedAt: string;
  repository: string;
  runtimeSource: "source_checkout" | "registry_install";
  runtimeArtifact?: GitHubFactoryRegistryRuntimeArtifact;
  source: {
    issueUrl: string;
    mentionUrl: string;
    issueNumber: number;
    issueState: string;
    commentId: string;
    eventId: string;
  };
  factory: {
    workThreadId: string;
    recipe: { id: string; version: number; contentDigest: string };
    workstream: { id: string; contentDigest: string };
    batch: {
      id: string;
      inputDigest: string;
      initialReceipt: JsonObject;
      replayedReceipt: JsonObject;
    };
  };
  run: {
    id: string;
    status: string;
    workThreadId: string;
    workstreamId: string;
    admissionBatchId: string;
    contextPacketCaptured: boolean;
    accessProfileCaptured: boolean;
    policyProvenanceCaptured: boolean;
  };
  attempt: {
    id: string;
    runnerId: string;
    executorId: string;
    locality: string;
    status: string;
    hasFencingToken: boolean;
  };
  pullRequest: {
    number: number;
    state: string;
    url: string;
    headRefOid: string;
    mergedAt?: string;
    mergeCommit?: { oid?: string } | null;
  };
  requiredCheck: {
    context: string;
    headSha: string;
    state: string;
    targetUrl?: string;
  };
  completion: {
    afterExecutorSuccess: JsonObject;
    afterRequiredCheck: JsonObject;
    afterMerge: JsonObject;
    afterRestart: JsonObject;
  };
  metrics: {
    beforeProviderEvidence: JsonObject;
    afterMerge: JsonObject;
    afterRestart: JsonObject;
  };
  assessmentCount: number;
  sourceReceipt: {
    matchedPhrase: string;
    beforeRestart: {
      id: string;
      url: string;
      bodyDigest: string;
    };
    afterRestart: {
      id: string;
      url: string;
      bodyDigest: string;
    };
    countBeforeRestart: number;
    countAfterRestart: number;
  };
};

export type GitHubFactoryAcceptanceReport = Omit<
  GitHubFactoryAcceptanceEvidence,
  "factory" | "completion" | "metrics"
> & {
  schemaVersion: 1;
  case: "github-factory-live";
  factory: Omit<GitHubFactoryAcceptanceEvidence["factory"], "batch"> & {
    batch: Omit<GitHubFactoryAcceptanceEvidence["factory"]["batch"], "initialReceipt" | "replayedReceipt"> & {
      status: string;
      admittedRunId: string;
      restartReplayMatched: true;
    };
  };
  completion: GitHubFactoryAcceptanceEvidence["completion"];
  metrics: GitHubFactoryAcceptanceEvidence["metrics"];
  assertions: {
    externalPlanningSystemRemainedAuthoritative: true;
    factoryBatchCreatedAttributedRun: true;
    localFencedAttemptCompleted: true;
    executorSuccessDidNotSatisfyCompletion: true;
    requiredCheckBoundToCurrentHead: true;
    requiredCheckDidNotBypassMerge: true;
    providerVerifiedMergeSatisfiedContract: true;
    acceptedOutcomeAdvancedAuthoritatively: true;
    restartPreservedSatisfiedAssessment: true;
    restartPreservedWorkstreamMetrics: true;
    restartReplayedExactBatchReceipt: true;
    restartDidNotDuplicateFinalReceipt: true;
  };
  excludedScope: ["dag", "operator_console"];
};

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function isSha512Integrity(value: string): boolean {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  return Boolean(match?.[1] && Buffer.from(match[1], "base64").byteLength === 64);
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function completionState(snapshot: JsonObject): string {
  return string(snapshot["completion"], "completion state");
}

function currentAssessment(snapshot: JsonObject): JsonObject {
  const assessment = object(snapshot["currentAssessment"], "current completion assessment");
  string(assessment["id"], "current completion assessment id");
  string(assessment["inputDigest"], "current completion assessment input digest");
  string(assessment["state"], "current completion assessment state");
  if (!Array.isArray(assessment["targetBindings"])) {
    throw new Error("current completion assessment targetBindings must be an array.");
  }
  if (!Array.isArray(assessment["gateResults"])) {
    throw new Error("current completion assessment gateResults must be an array.");
  }
  return assessment;
}

function gateState(snapshot: JsonObject, gateId: string): string | undefined {
  const assessment = currentAssessment(snapshot);
  const results = assessment["gateResults"];
  if (!Array.isArray(results)) throw new Error("current completion assessment gateResults must be an array.");
  for (const value of results) {
    const gate = object(value, "completion gate result");
    if (gate["gateId"] === gateId) return string(gate["state"], `${gateId} gate state`);
  }
  return undefined;
}

function receiptBody(receipt: JsonObject): JsonObject {
  return object(receipt["receipt"] ?? receipt, "batch receipt");
}

function receiptAdmission(receipt: JsonObject): { status: string; admittedRunId: string; inputDigest: string } {
  const body = receiptBody(receipt);
  const batch = object(body["batch"], "batch receipt batch");
  const result = object(body["result"], "batch receipt result");
  const results = result["results"];
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error("GitHub factory acceptance requires exactly one batch result.");
  }
  const item = object(results[0], "batch admission result");
  return {
    status: string(item["status"], "batch admission status"),
    admittedRunId: string(item["admittedRunId"], "batch admitted run id"),
    inputDigest: string(batch["contentDigest"], "batch input digest")
  };
}

function metrics(snapshot: JsonObject): JsonObject {
  return object(snapshot["metrics"] ?? snapshot, "workstream metrics");
}

function metric(snapshot: JsonObject, field: string): number {
  return number(metrics(snapshot)[field], `workstream metric ${field}`);
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`GitHub factory acceptance failed: ${message}`);
}

function validateRegistryRuntimeArtifact(
  runtimeSource: GitHubFactoryAcceptanceEvidence["runtimeSource"],
  artifact: GitHubFactoryRegistryRuntimeArtifact | undefined
): void {
  if (runtimeSource === "source_checkout") {
    invariant(!artifact, "source-checkout proof must not claim registry runtime artifact identity");
    return;
  }

  invariant(artifact, "registry runtime artifact identity is missing");
  invariant(artifact.package === "@opentag/cli", `registry runtime package is ${artifact.package}`);
  invariant(artifact.expectedVersion.length > 0, "expected registry CLI version is missing");
  invariant(
    artifact.version === artifact.expectedVersion,
    `registry CLI version ${artifact.version} does not match expected version ${artifact.expectedVersion}`
  );
  invariant(isSha512Integrity(artifact.integrity), "registry CLI integrity is missing or invalid");
  invariant(artifact.sourceNormalizer.package === "@opentag/github", "registry source normalizer package is invalid");
  invariant(
    artifact.sourceNormalizer.version === artifact.expectedVersion,
    `registry source normalizer version ${artifact.sourceNormalizer.version} does not match expected version ${artifact.expectedVersion}`
  );
  invariant(
    isSha512Integrity(artifact.sourceNormalizer.integrity),
    "registry source normalizer integrity is missing or invalid"
  );
  invariant(artifact.eventSchema.package === "@opentag/core", "registry event schema package is invalid");
  invariant(
    artifact.eventSchema.version === artifact.expectedVersion,
    `registry event schema version ${artifact.eventSchema.version} does not match expected version ${artifact.expectedVersion}`
  );
  invariant(
    isSha512Integrity(artifact.eventSchema.integrity),
    "registry event schema integrity is missing or invalid"
  );

  let resolved: URL;
  let normalizerResolved: URL;
  let eventSchemaResolved: URL;
  try {
    resolved = new URL(artifact.resolved);
    normalizerResolved = new URL(artifact.sourceNormalizer.resolved);
    eventSchemaResolved = new URL(artifact.eventSchema.resolved);
  } catch {
    throw new Error("GitHub factory acceptance failed: registry artifact resolution is not a valid URL.");
  }
  invariant(resolved.protocol === "https:", "registry CLI artifact was not resolved over HTTPS");
  invariant(normalizerResolved.protocol === "https:", "registry source normalizer was not resolved over HTTPS");
  invariant(eventSchemaResolved.protocol === "https:", "registry event schema was not resolved over HTTPS");
  invariant(artifact.registry === TRUSTED_NPM_REGISTRY_ORIGIN, "registry CLI did not use the trusted npm registry");
  invariant(resolved.origin === TRUSTED_NPM_REGISTRY_ORIGIN, "registry CLI artifact did not use the trusted npm registry");
  invariant(
    normalizerResolved.origin === TRUSTED_NPM_REGISTRY_ORIGIN,
    "registry source normalizer did not use the trusted npm registry"
  );
  invariant(
    eventSchemaResolved.origin === TRUSTED_NPM_REGISTRY_ORIGIN,
    "registry event schema did not use the trusted npm registry"
  );
  invariant(artifact.registry === resolved.origin, "registry CLI origin does not match its resolved artifact URL");
  for (const [label, url] of [
    ["registry CLI artifact", resolved],
    ["registry source normalizer", normalizerResolved],
    ["registry event schema", eventSchemaResolved]
  ] as const) {
    invariant(
      !url.username && !url.password && !url.search && !url.hash,
      `${label} URL contains credentials, query parameters, or fragments`
    );
  }
}

export function normalizeGitHubFactorySourceEvent(input: GitHubIssueCommentInput): OpenTagEvent {
  const event = normalizeGitHubIssueComment(input);
  if (!event) throw new Error("GitHub factory source comment does not contain a valid @opentag command.");
  return OpenTagEventSchema.parse(event);
}

export function buildGitHubFactoryAcceptanceReport(
  evidence: GitHubFactoryAcceptanceEvidence
): GitHubFactoryAcceptanceReport {
  validateRegistryRuntimeArtifact(evidence.runtimeSource, evidence.runtimeArtifact);
  const admission = receiptAdmission(evidence.factory.batch.initialReceipt);
  const replayAdmission = receiptAdmission(evidence.factory.batch.replayedReceipt);
  const initialCompletion = completionState(evidence.completion.afterExecutorSuccess);
  const checkedCompletion = completionState(evidence.completion.afterRequiredCheck);
  const mergedCompletion = completionState(evidence.completion.afterMerge);
  const restartedCompletion = completionState(evidence.completion.afterRestart);
  const mergedAssessment = currentAssessment(evidence.completion.afterMerge);
  const restartedAssessment = currentAssessment(evidence.completion.afterRestart);
  const beforeTerminal = metric(evidence.metrics.beforeProviderEvidence, "terminalRunCount");
  const beforeAccepted = metric(evidence.metrics.beforeProviderEvidence, "acceptedWorkThreadCount");
  const mergedTerminal = metric(evidence.metrics.afterMerge, "terminalRunCount");
  const mergedAccepted = metric(evidence.metrics.afterMerge, "acceptedWorkThreadCount");
  const restartedTerminal = metric(evidence.metrics.afterRestart, "terminalRunCount");
  const restartedAccepted = metric(evidence.metrics.afterRestart, "acceptedWorkThreadCount");

  invariant(evidence.source.issueUrl.includes("github.com/"), "source work item is not a GitHub issue URL");
  invariant(evidence.source.mentionUrl.includes("#issuecomment-"), "source mention is not a GitHub issue comment");
  invariant(evidence.source.issueState.toUpperCase() === "OPEN", "factory acceptance mutated the external planning issue state");
  invariant(evidence.source.commentId.length > 0 && evidence.source.eventId.length > 0, "source identities are missing");
  invariant(evidence.factory.workThreadId === evidence.run.workThreadId, "Run is not attached to the factory WorkThread");
  invariant(evidence.factory.workstream.id === evidence.run.workstreamId, "Run is not attributed to the workstream");
  invariant(evidence.factory.batch.id === evidence.run.admissionBatchId, "Run is not attributed to the admission batch");
  invariant(admission.status === "created", `batch admission status is ${admission.status}, expected created`);
  invariant(admission.admittedRunId === evidence.run.id, "batch receipt does not identify the admitted Run");
  invariant(admission.inputDigest === evidence.factory.batch.inputDigest, "batch receipt digest is not the retained input digest");
  invariant(replayAdmission.admittedRunId === evidence.run.id, "replayed batch receipt points at a different Run");
  invariant(isDeepStrictEqual(evidence.factory.batch.initialReceipt, evidence.factory.batch.replayedReceipt), "restart replay changed the durable batch receipt");
  invariant(evidence.run.status === "succeeded", `Run status is ${evidence.run.status}, expected succeeded`);
  invariant(evidence.run.contextPacketCaptured, "Run has no captured Context Packet");
  invariant(evidence.run.accessProfileCaptured, "Run has no captured access-profile snapshot");
  invariant(evidence.run.policyProvenanceCaptured, "Run has no captured policy provenance");
  invariant(evidence.attempt.locality === "local", `Attempt locality is ${evidence.attempt.locality}, expected local`);
  invariant(evidence.attempt.status === "succeeded", `Attempt status is ${evidence.attempt.status}, expected succeeded`);
  invariant(evidence.attempt.hasFencingToken, "Attempt has no durable fencing token");
  invariant(evidence.attempt.runnerId.length > 0 && evidence.attempt.executorId.length > 0, "Attempt attribution is incomplete");
  invariant(initialCompletion !== "satisfied", "executor success satisfied completion before provider evidence");
  invariant(checkedCompletion !== "satisfied", "required check bypassed the merge gate");
  invariant(gateState(evidence.completion.afterRequiredCheck, "required_checks") === "passed", "required-check gate did not pass");
  invariant(evidence.requiredCheck.headSha === evidence.pullRequest.headRefOid, "required check is not bound to the PR head");
  invariant(evidence.requiredCheck.state === "success", `required check state is ${evidence.requiredCheck.state}`);
  invariant(evidence.pullRequest.state.toUpperCase() === "MERGED" && Boolean(evidence.pullRequest.mergedAt), "pull request is not provider-verified merged");
  invariant(mergedCompletion === "satisfied", "merge did not satisfy completion");
  invariant(gateState(evidence.completion.afterMerge, "merge") === "passed", "merge gate did not pass");
  invariant(restartedCompletion === "satisfied", "restart lost the satisfied completion state");
  invariant(
    isDeepStrictEqual(mergedAssessment, restartedAssessment),
    "restart changed the durable satisfied completion assessment"
  );
  invariant(evidence.assessmentCount > 0, "no durable CompletionAssessment was recorded");
  invariant(beforeTerminal === 1 && mergedTerminal === 1 && restartedTerminal === 1, "terminal Run authority changed across provider evidence or restart");
  invariant(beforeAccepted === 0 && mergedAccepted === 1 && restartedAccepted === 1, "accepted outcome did not advance 0 -> 1 and remain authoritative");
  invariant(isDeepStrictEqual(evidence.metrics.afterMerge, evidence.metrics.afterRestart), "restart changed authoritative workstream metrics");
  invariant(evidence.sourceReceipt.matchedPhrase.length > 0, "source-thread completion receipt was not observed");
  invariant(evidence.sourceReceipt.beforeRestart.bodyDigest.startsWith("sha256:"), "source-thread receipt digest is missing before restart");
  invariant(evidence.sourceReceipt.afterRestart.bodyDigest.startsWith("sha256:"), "source-thread receipt digest is missing after restart");
  invariant(evidence.sourceReceipt.countBeforeRestart === 1, "expected exactly one provider-verified source-thread receipt before restart");
  invariant(evidence.sourceReceipt.countAfterRestart === 1, "expected exactly one provider-verified source-thread receipt after restart");
  invariant(
    isDeepStrictEqual(evidence.sourceReceipt.beforeRestart, evidence.sourceReceipt.afterRestart),
    "restart changed or replaced the final source-thread receipt"
  );

  return {
    schemaVersion: 1,
    case: "github-factory-live",
    recordedAt: evidence.recordedAt,
    repository: evidence.repository,
    runtimeSource: evidence.runtimeSource,
    ...(evidence.runtimeArtifact ? { runtimeArtifact: evidence.runtimeArtifact } : {}),
    source: evidence.source,
    factory: {
      workThreadId: evidence.factory.workThreadId,
      recipe: evidence.factory.recipe,
      workstream: evidence.factory.workstream,
      batch: {
        id: evidence.factory.batch.id,
        inputDigest: evidence.factory.batch.inputDigest,
        status: admission.status,
        admittedRunId: admission.admittedRunId,
        restartReplayMatched: true
      }
    },
    run: evidence.run,
    attempt: evidence.attempt,
    pullRequest: evidence.pullRequest,
    requiredCheck: evidence.requiredCheck,
    completion: evidence.completion,
    metrics: evidence.metrics,
    assessmentCount: evidence.assessmentCount,
    sourceReceipt: evidence.sourceReceipt,
    assertions: {
      externalPlanningSystemRemainedAuthoritative: true,
      factoryBatchCreatedAttributedRun: true,
      localFencedAttemptCompleted: true,
      executorSuccessDidNotSatisfyCompletion: true,
      requiredCheckBoundToCurrentHead: true,
      requiredCheckDidNotBypassMerge: true,
      providerVerifiedMergeSatisfiedContract: true,
      acceptedOutcomeAdvancedAuthoritatively: true,
      restartPreservedSatisfiedAssessment: true,
      restartPreservedWorkstreamMetrics: true,
      restartReplayedExactBatchReceipt: true,
      restartDidNotDuplicateFinalReceipt: true
    },
    excludedScope: ["dag", "operator_console"]
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function main(argv: string[]): Promise<void> {
  const [command, inputPath, outputPath, ...rest] = argv;
  if (rest.length > 0 || !inputPath || !outputPath || (command !== "event" && command !== "report")) {
    throw new Error("Usage: github-factory-acceptance.ts <event|report> <input.json> <output.json>");
  }

  const input = await readJson(inputPath);
  if (command === "event") {
    await writePrivateJson(outputPath, normalizeGitHubFactorySourceEvent(input as GitHubIssueCommentInput));
    return;
  }
  await writePrivateJson(outputPath, buildGitHubFactoryAcceptanceReport(input as GitHubFactoryAcceptanceEvidence));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
