import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createOpenTagClient, type OpenTagClient } from "@opentag/client";
import type {
  ActionPermissionRequest,
  ActionPermissionResolution,
  CompletionAssessmentReceiptEnvelopeV1,
  CompletionContractRefReceiptEnvelopeV1,
  HostedClaimRequestV1,
  HostedClaimV1,
  HostedExecutorResultReasonCodeV1,
  MaterialActionReceipt,
  RunnerReadinessReceiptEnvelopeV1,
  RunnerControlContextResponseV1,
  WorkThreadRefReceiptEnvelopeV1,
} from "@opentag/core";
import {
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  buildHostedLifecycleRequestV1,
  HostedCompleteRequestV1Schema,
  HostedHeartbeatRequestV1Schema,
  HostedProgressRequestV1Schema,
  HostedRejectStartRequestV1Schema,
  HostedRunningRequestV1Schema,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  computePermissionRequestDigestV1,
  verifyHostedAdmissionEnvelopeDigestV1,
  RunnerReadinessReceiptEnvelopeV1Schema,
} from "@opentag/core";
import { openDispatcherGovernanceStore } from "@opentag/dispatcher";
import {
  refetchGitHubIssueCommentForHostedAdmission,
  type GitHubIssueCommentRefetchReceipt,
} from "@opentag/github";
import type { ExecutorAdapter, RunnerSecurityPolicy } from "@opentag/runner";
import {
  canonicalRepositoryIdentity,
  type OpenTagDaemonConfig,
  type RepositoryBindingConfig,
} from "./config.js";
import {
  executeClaimedRun,
  type ClaimedRun,
  type ClaimedRunExecutionClient,
} from "./daemon.js";
import type { PullRequestOptions } from "./pr.js";

const require = createRequire(import.meta.url);
const LOCAL_RUNTIME_VERSION = (require("../package.json") as { version: string }).version;
const READINESS_TTL_MS = 60_000;
const READINESS_PROBE_CACHE_RATIO = 0.5;
const CONTROL_TRANSFER_TIMEOUT_MS = 30_000;
const CONTROL_LEASE_SAFETY_MS = 5_000;
const DEFAULT_CONTROL_LEASE_SECONDS = 90;
const HOSTED_CLAIM_CAPABILITIES = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
] as const;

type CallbackObservationReceiptEnvelopeV1 = Parameters<
  OpenTagClient["projectCallbackObservationControlV1"]
>[0];

export type ControlPlaneProjectionEnvelope =
  | RunnerReadinessReceiptEnvelopeV1
  | WorkThreadRefReceiptEnvelopeV1
  | CompletionContractRefReceiptEnvelopeV1
  | CompletionAssessmentReceiptEnvelopeV1
  | CallbackObservationReceiptEnvelopeV1;

export type ControlPlaneProjectionOutboxEntry = {
  receiptId: string;
  destinationId: string;
  organizationId: string;
  runnerId?: string;
  runId?: string;
  workThreadId?: string;
  receiptKind: ControlPlaneProjectionEnvelope["receiptKind"];
  identity: { namespace: string; parts: string[]; key: string };
  operationId: string;
  payloadDigest: string;
  receiptDigest: string;
  envelope: ControlPlaneProjectionEnvelope;
  state: "pending" | "leased" | "acknowledged" | "attention";
  attemptCount: number;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ControlProjectionRepository = {
  recoverExpiredControlPlaneProjectionLeases(input: { destinationId: string; organizationId: string; limit?: number; now?: Date }): Promise<unknown>;
  claimDueControlPlaneProjections(input: { destinationId: string; organizationId: string; leaseOwner: string; leaseSeconds: number; limit?: number; now?: Date }): Promise<{ entries: ControlPlaneProjectionOutboxEntry[] }>;
  acknowledgeControlPlaneProjection(input: { destinationId: string; organizationId: string; receiptId: string; leaseToken: string; httpStatus?: number; now?: Date }): Promise<{ outcome: "acknowledged" | "stale_lease" | "not_found" }>;
  retryControlPlaneProjection(input: { destinationId: string; organizationId: string; receiptId: string; leaseToken: string; nextAttemptAt: string; reasonCode: string; httpStatus?: number; now?: Date }): Promise<{ outcome: "retried" | "stale_lease" | "not_found" }>;
  markControlPlaneProjectionAttention(input: { destinationId: string; organizationId: string; receiptId: string; leaseToken: string; reasonCode: string; httpStatus?: number; now?: Date }): Promise<{ outcome: "attention" | "stale_lease" | "not_found" }>;
};

export type ControlProjectionClient = Pick<OpenTagClient,
  "reportRunnerReadinessControlV1" | "projectWorkThreadRefControlV1" |
  "projectCompletionContractRefControlV1" | "projectCompletionAssessmentControlV1" |
  "projectCallbackObservationControlV1">;

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function retryable(status: number | undefined): boolean {
  return status === 0
    || status === 408
    || status === 429
    || (status !== undefined && status >= 500 && status < 600);
}

function retryAfterMs(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const seconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : 0;
}

function retryableControlContextError(error: unknown): boolean {
  const status = httpStatus(error);
  return status !== undefined && retryable(status);
}

async function deliverProjection(client: ControlProjectionClient, envelope: ControlPlaneProjectionEnvelope): Promise<number> {
  const result = envelope.receiptKind === "runner_readiness"
    ? await client.reportRunnerReadinessControlV1(envelope)
    : envelope.receiptKind === "work_thread_ref"
      ? await client.projectWorkThreadRefControlV1(envelope)
      : envelope.receiptKind === "completion_contract_ref"
        ? await client.projectCompletionContractRefControlV1(envelope)
        : envelope.receiptKind === "completion_assessment"
          ? await client.projectCompletionAssessmentControlV1(envelope)
          : await client.projectCallbackObservationControlV1(envelope);
  return result.status;
}

export async function pumpControlPlaneProjections(input: {
  repo: ControlProjectionRepository;
  client: ControlProjectionClient;
  destinationId: string;
  organizationId: string;
  leaseOwner: string;
  leaseSeconds?: number;
  limit?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  transferTimeoutMs?: number;
  now?: Date | (() => Date);
}): Promise<{ delivered: number; retried: number; attention: number }> {
  const clock = typeof input.now === "function"
    ? input.now
    : input.now
      ? () => input.now as Date
      : () => new Date();
  const claimNow = clock();
  await input.repo.recoverExpiredControlPlaneProjectionLeases({ destinationId: input.destinationId, organizationId: input.organizationId, ...(input.limit ? { limit: input.limit } : {}), now: claimNow });
  const summary = { delivered: 0, retried: 0, attention: 0 };
  const transferTimeoutMs = input.transferTimeoutMs ?? CONTROL_TRANSFER_TIMEOUT_MS;
  const minimumLeaseRemainingMs = transferTimeoutMs + CONTROL_LEASE_SAFETY_MS;
  const leaseSeconds = Math.max(
    input.leaseSeconds ?? DEFAULT_CONTROL_LEASE_SECONDS,
    Math.ceil(minimumLeaseRemainingMs / 1_000),
  );
  const limit = input.limit ?? 25;
  for (let index = 0; index < limit; index += 1) {
    const nextClaimAt = index === 0 ? claimNow : clock();
    const claimed = await input.repo.claimDueControlPlaneProjections({
      destinationId: input.destinationId,
      organizationId: input.organizationId,
      leaseOwner: input.leaseOwner,
      leaseSeconds,
      limit: 1,
      now: nextClaimAt,
    });
    const entry = claimed.entries[0];
    if (!entry) break;
    if (!entry.leaseToken) continue;
    const sendAt = clock();
    const leaseExpiresAt = Date.parse(entry.leaseExpiresAt ?? "");
    if (
      !Number.isFinite(leaseExpiresAt)
      || leaseExpiresAt - sendAt.getTime() < minimumLeaseRemainingMs
    ) {
      const outcome = await input.repo.retryControlPlaneProjection({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        receiptId: entry.receiptId,
        leaseToken: entry.leaseToken,
        nextAttemptAt: sendAt.toISOString(),
        reasonCode: "lease_window_insufficient",
        now: sendAt,
      });
      if (outcome.outcome === "retried") summary.retried += 1;
      continue;
    }
    try {
      const status = await deliverProjection(input.client, entry.envelope);
      const outcome = await input.repo.acknowledgeControlPlaneProjection({ destinationId: input.destinationId, organizationId: input.organizationId, receiptId: entry.receiptId, leaseToken: entry.leaseToken, httpStatus: status, now: clock() });
      if (outcome.outcome === "acknowledged") summary.delivered += 1;
    } catch (error) {
      const status = httpStatus(error);
      const failureNow = clock();
      if (retryable(status)) {
        const backoff = Math.min(input.retryMaxMs ?? 60_000, (input.retryBaseMs ?? 1_000) * 2 ** Math.max(0, entry.attemptCount - 1));
        const delay = Math.max(backoff, retryAfterMs(error));
        const outcome = await input.repo.retryControlPlaneProjection({ destinationId: input.destinationId, organizationId: input.organizationId, receiptId: entry.receiptId, leaseToken: entry.leaseToken, nextAttemptAt: new Date(failureNow.getTime() + delay).toISOString(), reasonCode: status ? `http_${status}` : "transport_failed", ...(status ? { httpStatus: status } : {}), now: failureNow });
        if (outcome.outcome === "retried") summary.retried += 1;
      } else {
        const outcome = await input.repo.markControlPlaneProjectionAttention({ destinationId: input.destinationId, organizationId: input.organizationId, receiptId: entry.receiptId, leaseToken: entry.leaseToken, reasonCode: status === undefined ? "unexpected_error" : `http_${status}`, ...(status ? { httpStatus: status } : {}), now: failureNow });
        if (outcome.outcome === "attention") summary.attention += 1;
      }
    }
  }
  return summary;
}

function stableDigestId(prefix: string, digest: string): string {
  return `${prefix}_${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}

export function isRunnerControlContextFreshV1(
  observedAt: string,
  now: Date,
  maxAgeMs = READINESS_TTL_MS,
): boolean {
  const ageMs = now.getTime() - Date.parse(observedAt);
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

export function assertRunnerControlContextRegistrationV1(input: {
  context: RunnerControlContextResponseV1;
  registration: OpenTagDaemonConfig["controlRegistration"];
}): void {
  const registration = input.registration;
  if (!registration || !("registration" in registration)) {
    throw new Error("runner_control_context_registration_unavailable");
  }
  if (input.context.organizationId !== registration.registration.organizationId) {
    throw new Error("runner_control_context_organization_mismatch");
  }
  if (
    input.context.credentialId !== registration.registration.credentialId
    || input.context.registrationGeneration
      !== registration.registration.registrationGeneration
    || input.context.credentialGeneration
      !== registration.registration.credentialGeneration
  ) {
    throw new Error("runner_control_context_credential_mismatch");
  }
}

export function buildHostedClaimRequestV1(input: {
  context: RunnerControlContextResponseV1;
  readiness: RunnerReadinessReceiptEnvelopeV1;
  requestId: string;
  operationId: string;
}): HostedClaimRequestV1 {
  if (
    input.readiness.organizationId !== input.context.organizationId
    || input.readiness.payload.runnerId !== input.context.runnerId
    || input.readiness.producer.credentialId !== input.context.credentialId
    || input.readiness.producer.registrationGeneration
      !== input.context.registrationGeneration
  ) {
    throw new Error("hosted_claim_readiness_context_mismatch");
  }
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: [...HOSTED_CLAIM_CAPABILITIES],
    requestId: input.requestId,
    operationId: input.operationId,
    expectedAuthority: {
      credentialId: input.context.credentialId,
      registrationGeneration: input.context.registrationGeneration,
      credentialGeneration: input.context.credentialGeneration,
      runnerReadinessReceiptId: input.readiness.receiptId,
      runnerReadinessReceiptDigest: input.readiness.receiptDigest,
    },
  };
}

export async function assertHostedClaimCurrentAuthorityV1(input: {
  claim: HostedClaimV1;
  context: RunnerControlContextResponseV1;
  readiness: RunnerReadinessReceiptEnvelopeV1;
  request: HostedClaimRequestV1;
  now: Date;
}): Promise<void> {
  const { claim, context, readiness, request } = input;
  if (!(await verifyHostedAdmissionEnvelopeDigestV1(claim.hostedAdmission))) {
    throw new Error("hosted_claim_admission_envelope_digest_mismatch");
  }
  if (
    claim.organizationId !== context.organizationId
    || claim.runnerId !== context.runnerId
    || claim.authority.credentialId !== context.credentialId
    || claim.authority.registrationGeneration !== context.registrationGeneration
    || claim.authority.credentialGeneration !== context.credentialGeneration
  ) {
    throw new Error("hosted_claim_current_context_mismatch");
  }
  if (
    claim.authority.runnerReadinessReceiptId
      !== request.expectedAuthority.runnerReadinessReceiptId
    || claim.authority.runnerReadinessReceiptDigest
      !== request.expectedAuthority.runnerReadinessReceiptDigest
  ) {
    throw new Error("hosted_claim_readiness_mismatch");
  }
  const target = context.targets.find(
    (candidate) => candidate.projectTargetId === claim.authority.projectTargetId,
  );
  if (
    !target
    || target.bindingDigest !== claim.authority.targetBindingDigest
    || target.provider !== claim.hostedAdmission.provider
    || target.owner !== claim.hostedAdmission.repository.owner
    || target.repo !== claim.hostedAdmission.repository.repo
    || target.defaultExecutor !== claim.executorId
  ) {
    throw new Error("hosted_claim_target_mismatch");
  }
  const readyTarget = readiness.payload.targets.find(
    (candidate) => candidate.projectTargetId === target.projectTargetId,
  );
  const readyExecutor = readiness.payload.executors.find(
    (candidate) => candidate.executorId === claim.executorId,
  );
  if (
    readyTarget?.state !== "ready"
    || readyTarget.bindingDigest !== target.bindingDigest
    || readyExecutor?.state !== "ready"
    || readyExecutor.capabilityDigest !== claim.authority.executorCapabilityDigest
  ) {
    throw new Error("hosted_claim_readiness_not_ready");
  }
  const leaseExpiresAt = Date.parse(claim.attempt.leaseExpiresAt);
  if (
    !Number.isFinite(leaseExpiresAt)
    || leaseExpiresAt <= input.now.getTime()
  ) {
    throw new Error("hosted_claim_lease_expired");
  }
}

export async function buildRunnerReadinessReceipt(input: {
  context: RunnerControlContextResponseV1;
  executors: Record<string, ExecutorAdapter>;
  repositories: RepositoryBindingConfig[];
  observedAt?: string;
  now?: () => Date;
  ttlMs?: number;
  readinessProbeCache?: Map<string, {
    expiresAt: number;
    readiness: Awaited<ReturnType<ExecutorAdapter["canRun"]>>;
  }>;
}): Promise<RunnerReadinessReceiptEnvelopeV1> {
  if (!input.context.capabilities.includes("relay.readiness.v1")) {
    throw new Error("runner_control_context_missing_readiness_capability");
  }
  const clock = input.now ?? (() => new Date());
  const probeNow = clock();
  const readinessTtlMs = input.ttlMs ?? READINESS_TTL_MS;
  const contextDigest = await computeControlPayloadDigestV1({
    organizationId: input.context.organizationId,
    runnerId: input.context.runnerId,
    credentialId: input.context.credentialId,
    registrationGeneration: input.context.registrationGeneration,
    credentialGeneration: input.context.credentialGeneration,
    capabilities: input.context.capabilities,
    targets: input.context.targets,
  });
  const matchedRepositories = new Map<string, RepositoryBindingConfig>();
  const targets = input.context.targets.map((target) => {
    const targetIdentity = canonicalRepositoryIdentity(target);
    const matches = input.repositories.filter((binding) => {
      const bindingIdentity = canonicalRepositoryIdentity(binding);
      return bindingIdentity.provider === targetIdentity.provider
        && bindingIdentity.owner === targetIdentity.owner
        && bindingIdentity.repo === targetIdentity.repo
        && binding.defaultExecutor === target.defaultExecutor
        && (binding.baseBranch ?? null) === target.defaultBranch;
    });
    if (matches.length !== 1) {
      return {
        projectTargetId: target.projectTargetId,
        bindingDigest: target.bindingDigest,
        state: "unknown" as const,
        reasonCode: "target_binding_stale" as const,
      };
    }
    const binding = matches[0]!;
    let checkoutVerified = false;
    if (existsSync(binding.checkoutPath)) {
      try {
        checkoutVerified = execFileSync(
          "git",
          ["-C", binding.checkoutPath, "rev-parse", "--is-inside-work-tree"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim() === "true";
      } catch {
        checkoutVerified = false;
      }
    }
    if (checkoutVerified && !matchedRepositories.has(binding.defaultExecutor)) {
      matchedRepositories.set(binding.defaultExecutor, binding);
    }
    return checkoutVerified
      ? {
          projectTargetId: target.projectTargetId,
          bindingDigest: target.bindingDigest,
          state: "ready" as const,
        }
      : {
          projectTargetId: target.projectTargetId,
          bindingDigest: target.bindingDigest,
          state: "blocked" as const,
          reasonCode: "target_unavailable" as const,
        };
  });
  const executors = await Promise.all(Object.values(input.executors)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(async (executor) => {
      const base = {
        executorId: executor.id,
        adapterVersion: LOCAL_RUNTIME_VERSION,
        capabilityDigest: await computeControlPayloadDigestV1(
          executor.capability ?? { id: executor.id },
        ),
      };
      const binding = matchedRepositories.get(executor.id);
      if (!binding) {
        return {
          ...base,
          state: "unknown" as const,
          reasonCode: "executor_unavailable" as const,
        };
      }
      try {
        const cacheKey = await computeControlPayloadDigestV1({
          contextDigest,
          capabilityDigest: base.capabilityDigest,
          binding: {
            provider: binding.provider,
            owner: binding.owner,
            repo: binding.repo,
            checkoutPath: binding.checkoutPath,
            defaultExecutor: binding.defaultExecutor,
            baseBranch: binding.baseBranch ?? null,
            worktreeRoot: binding.worktreeRoot ?? null,
            keepWorktree: binding.keepWorktree ?? null,
          },
        });
        const cached = input.readinessProbeCache?.get(cacheKey);
        const readiness = cached && cached.expiresAt > probeNow.getTime()
          ? cached.readiness
          : await executor.canRun({
              runId: "control-v1-readiness",
              workspace: { kind: "repository", path: binding.checkoutPath },
              command: { rawText: "control-v1-readiness", intent: "unknown", args: {} },
              context: [],
              ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
              ...(binding.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
              ...(binding.keepWorktree ? { keepWorktree: binding.keepWorktree } : {}),
            });
        if (!cached || cached.expiresAt <= probeNow.getTime()) {
          input.readinessProbeCache?.set(cacheKey, {
            expiresAt: probeNow.getTime() + Math.floor(readinessTtlMs * READINESS_PROBE_CACHE_RATIO),
            readiness,
          });
        }
        return readiness.ready
          ? { ...base, state: "ready" as const }
          : {
              ...base,
              state: "blocked" as const,
              reasonCode: "executor_unavailable" as const,
            };
      } catch {
        return {
          ...base,
          state: "blocked" as const,
          reasonCode: "executor_unavailable" as const,
        };
      }
    }));
  // This timestamp describes the completed local probe. The server context's
  // observedAt is an acceptance timestamp and must not be reused as evidence.
  const observedAt = input.observedAt ?? clock().toISOString();
  const payloadBase = {
    readinessId: "pending",
    runnerId: input.context.runnerId,
    registrationGeneration: input.context.registrationGeneration,
    capabilities: input.context.capabilities,
    executors,
    targets,
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + (input.ttlMs ?? READINESS_TTL_MS)).toISOString(),
  };
  const readinessSeedDigest = await computeControlPayloadDigestV1(payloadBase);
  const readinessId = stableDigestId("readiness", readinessSeedDigest);
  const payload = { ...payloadBase, readinessId };
  const receiptId = stableDigestId("readiness_receipt", await computeControlPayloadDigestV1(payload));
  const base = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptKind: "runner_readiness" as const,
    receiptId,
    organizationId: input.context.organizationId,
    operationId: stableDigestId("readiness_operation", readinessSeedDigest),
    requiredCapabilities: ["relay.readiness.v1"] as const,
    producer: {
      kind: "runner" as const,
      id: input.context.runnerId,
      credentialId: input.context.credentialId,
      registrationGeneration: input.context.registrationGeneration,
    },
    identity: {
      namespace: "opentag.control.receipt/runner-readiness/v1",
      parts: [input.context.organizationId, input.context.runnerId, String(input.context.registrationGeneration), readinessId],
    },
    observedAt,
    payload,
    payloadDigest: await computeControlPayloadDigestV1(payload),
  };
  return RunnerReadinessReceiptEnvelopeV1Schema.parse({
    ...base,
    receiptDigest: await computeControlReceiptDigestV1(base),
  });
}

export type HostedControlLoop = {
  beforeIteration(): Promise<boolean>;
  afterIteration(): Promise<void>;
  abort(): void;
  close(): Promise<void>;
};

type HostedExecutionRepository = Omit<
  ReturnType<typeof openDispatcherGovernanceStore>["repo"],
  "getHostedAssignedRunForRecovery" | "isHostedExecutionCurrent"
> & {
  getHostedClaimOperationForRetry(input: {
    destinationId: string;
    organizationId: string;
    runnerId: string;
  }): Promise<{ operationId: string; requestId: string; request: HostedClaimRequestV1 } | null>;
  beginHostedClaimOperation(input: {
    destinationId: string;
    organizationId: string;
    runnerId: string;
    request: HostedClaimRequestV1;
  }): Promise<{
    outcome: "created" | "replayed";
    operation: { operationId: string; requestId: string; request: HostedClaimRequestV1 };
  }>;
  acknowledgeHostedClaimEmpty(input: {
    operationId: string;
    requestId: string;
  }): Promise<unknown>;
  importHostedAssignedRun(input: {
    event: import("@opentag/core").OpenTagEvent;
    claim: HostedClaimV1;
    sourceReceipt: GitHubIssueCommentRefetchReceipt;
  }): Promise<{
    outcome: "created" | "replayed";
    executionState: "ready_to_start" | "already_started" | "terminal" | "superseded";
    claimed: ClaimedRun | null;
  }>;
  acquireHostedExecutionStart(input: {
    runId: string;
    attemptId: string;
    fencingToken: string;
  }): Promise<boolean>;
  abandonHostedClaimOperation(input: {
    operationId: string;
    requestId: string;
    reasonCode: "stale_control_authority" | "operation_digest_conflict";
  }): Promise<unknown>;
  getHostedAssignedRunForRecovery(input: {
    destinationId: string;
    organizationId: string;
    runnerId: string;
  }): Promise<{
    claimed: ClaimedRun;
    leaseExpiresAt: string;
    hostedAuthority: HostedClaimV1["authority"] & {
      policyReceiptDigest: string;
    };
  } | null>;
  isHostedExecutionCurrent(input: {
    runId: string;
    attemptId: string;
    fencingToken: string;
  }): Promise<boolean>;
  markRunning(input: {
    runnerId: string;
    attemptId: string;
    fencingToken: string;
    executor: string;
    executorCapability?: unknown;
    runTimeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<string>;
  heartbeat(input: {
    runId: string;
    runnerId: string;
    attemptId: string;
    fencingToken: string;
  }): Promise<string>;
  rejectAttemptStart(input: {
    runId: string;
    runnerId: string;
    attemptId: string;
    fencingToken: string;
    executorId: string;
    reason: string;
  }): Promise<string>;
  completeRun(input: {
    runId: string;
    runnerId: string;
    attemptId: string;
    fencingToken: string;
    result: import("@opentag/core").OpenTagRunResult;
    idempotencyKey?: string;
  }): Promise<string>;
  appendRunEvent(input: {
    runId: string;
    type: string;
    payload: unknown;
    createdAt?: string;
    visibility?: "audit" | "human" | "debug";
    importance?: "blocking" | "low" | "high" | "normal";
    message?: string;
  }): Promise<unknown>;
};

function permissionResolutionFromReceipt(input: {
  receipt: Awaited<ReturnType<OpenTagClient["getActionPermissionCurrentControlV1"]>>["receipt"];
  request: ActionPermissionRequest;
}): ActionPermissionResolution {
  const { receipt, request } = input;
  const state = receipt.payload.state;
  return {
    state,
    action: {
      id: receipt.payload.actionId,
      runId: receipt.runId,
      attemptId: receipt.attempt.attemptId,
      actionFamily: receipt.payload.actionFamily,
      capability: request.operation,
      scope: { permissionScopes: receipt.payload.permissionScopes },
      target: { fingerprint: receipt.payload.targetFingerprint },
      riskTier: receipt.payload.riskTier,
      status: state === "waiting"
        ? "waiting_approval"
        : state === "authorized"
          ? "authorized"
          : "cancelled",
      idempotencyKey: receipt.payload.permissionRequestId,
      attemptFenceDigest: receipt.attempt.fencingTokenDigest,
      createdAt: receipt.payload.requestedAt,
      updatedAt: receipt.observedAt,
    },
    ...(state === "authorized" ? { decision: "allow_once" as const } : {}),
    ...(receipt.payload.reasonCode ? { reason: receipt.payload.reasonCode } : {}),
  };
}

export async function buildHostedProgressMetadataForControlV1(input: {
  at: string;
}): Promise<{ progressId: string; progressDigest: string }> {
  const progressDigest = await computeControlPayloadDigestV1({
    type: "status",
    occurredAt: input.at,
  });
  return {
    progressId: `progress_${progressDigest.slice("sha256:".length)}`,
    progressDigest,
  };
}

export async function buildHostedCompletionMetadataForControlV1(
  result: import("@opentag/core").OpenTagRunResult,
): Promise<{
  conclusion: import("@opentag/core").OpenTagRunResult["conclusion"];
  reasonCode: HostedExecutorResultReasonCodeV1;
  resultDigest: string;
  artifactDigests: string[];
  evidenceDigests: string[];
}> {
  const reasonCodes = {
    success: "executor_success",
    failure: "executor_failure",
    cancelled: "executor_cancelled",
    interrupted: "executor_interrupted",
    timed_out: "executor_timed_out",
    needs_human: "executor_needs_human",
  } as const satisfies Record<
    import("@opentag/core").OpenTagRunResult["conclusion"],
    HostedExecutorResultReasonCodeV1
  >;
  return {
    conclusion: result.conclusion,
    reasonCode: reasonCodes[result.conclusion],
    resultDigest: await computeControlPayloadDigestV1(result),
    artifactDigests: [...new Set(await Promise.all(
      (result.artifacts ?? []).map((artifact) =>
        computeControlPayloadDigestV1(artifact)
      ),
    ))].sort(),
    evidenceDigests: [...new Set(await Promise.all(
      (result.verification ?? []).map((evidence) =>
        computeControlPayloadDigestV1(evidence)
      ),
    ))].sort(),
  };
}

async function createHostedExecutionClient(input: {
  client: OpenTagClient;
  repo: HostedExecutionRepository;
  authority: {
    organizationId: string;
    runnerId: string;
    attemptId: string;
    attemptNumber: number;
    epoch: number;
    fencingToken: string;
    fencingTokenDigest: string;
    credentialId: string;
    executorCapabilityDigest: string;
    leaseExpiresAt: string;
    policySnapshotRef: string;
    policySnapshotDigest: string;
  };
}): Promise<ClaimedRunExecutionClient> {
  const { client, repo, authority } = input;
  const executionOccurredAt = new Date().toISOString();
  const permissionRequests = new Map<string, {
    request: ActionPermissionRequest;
    permissionRequestId: string;
    permissionRequestDigest: string;
  }>();
  const attempt = {
    attemptId: authority.attemptId,
    attemptNumber: authority.attemptNumber,
    epoch: authority.epoch,
    fencingToken: authority.fencingToken,
    fencingTokenDigest: authority.fencingTokenDigest,
  };
  return {
    async markRunning(runId, executor, lease, options) {
      const request = HostedRunningRequestV1Schema.parse(
        await buildHostedLifecycleRequestV1({
        action: "running",
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        attempt,
        occurredAt: executionOccurredAt,
        executorId: executor,
        executorCapabilityDigest: authority.executorCapabilityDigest,
        ...(options?.runTimeoutMs ? { runTimeoutMs: options.runTimeoutMs } : {}),
        }),
      );
      await client.markHostedRunRunningControlV1({
        organizationId: authority.organizationId,
        credentialId: authority.credentialId,
        runnerId: authority.runnerId,
        runId,
        request,
      });
      const outcome = await repo.markRunning({
        runnerId: authority.runnerId,
        runId,
        executor,
        ...lease,
        ...(options?.executorCapability ? { executorCapability: options.executorCapability } : {}),
        ...(options?.runTimeoutMs ? { runTimeoutMs: options.runTimeoutMs } : {}),
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      if (outcome !== "running" && outcome !== "duplicate") {
        throw new Error("hosted_local_mark_running_split_outcome");
      }
    },
    async rejectAttemptStart(runId, executorId, reason, lease) {
      const request = HostedRejectStartRequestV1Schema.parse(
        await buildHostedLifecycleRequestV1({
        action: "reject-start",
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        attempt,
        occurredAt: executionOccurredAt,
        executorId,
        reasonCode: "unknown_safe_failure",
        }),
      );
      await client.rejectHostedAttemptStartControlV1({
        organizationId: authority.organizationId,
        credentialId: authority.credentialId,
        runnerId: authority.runnerId,
        runId,
        request,
      });
      const outcome = await repo.rejectAttemptStart({
        runnerId: authority.runnerId,
        runId,
        executorId,
        reason,
        ...lease,
      });
      if (outcome !== "requeued" && outcome !== "duplicate") {
        throw new Error("hosted_local_reject_start_split_outcome");
      }
    },
    async heartbeat(runId, _lease) {
      const journalAuthority = {
        destinationId: "cloud",
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        credentialId: authority.credentialId,
        runId,
        attemptId: authority.attemptId,
        fencingToken: authority.fencingToken,
      };
      let operation = await repo.getHostedHeartbeatOperationForRetry(
        journalAuthority,
      );
      if (!operation) {
        const currentLease = await repo.getHostedExecutionLease(
          journalAuthority,
        );
        if (!currentLease) {
          throw new Error("hosted_execution_authority_expired");
        }
        const request = HostedHeartbeatRequestV1Schema.parse(
          await buildHostedLifecycleRequestV1({
            action: "heartbeat",
            organizationId: authority.organizationId,
            runnerId: authority.runnerId,
            runId,
            attempt,
            occurredAt: new Date().toISOString(),
            expectedLeaseExpiresAt: currentLease.leaseExpiresAt,
          }),
        );
        operation = (await repo.beginHostedHeartbeatOperation({
          ...journalAuthority,
          request,
        })).operation;
      }
      const accepted = await client.heartbeatHostedRunControlV1({
        organizationId: authority.organizationId,
        credentialId: authority.credentialId,
        runnerId: authority.runnerId,
        runId,
        request: operation.request,
      });
      const outcome = await repo.applyHostedHeartbeatReceipt({
        ...journalAuthority,
        operationId: operation.operationId,
        requestId: operation.requestId,
        receipt: accepted.receipt,
      });
      if (outcome !== "accepted" && outcome !== "replayed") {
        throw new Error("hosted_heartbeat_receipt_rejected");
      }
    },
    async progress(runId, lease, progress) {
      const progressMetadata = await buildHostedProgressMetadataForControlV1(
        progress,
      );
      const request = HostedProgressRequestV1Schema.parse(
        await buildHostedLifecycleRequestV1({
        action: "progress",
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        attempt,
        occurredAt: progress.at,
        ...progressMetadata,
        }),
      );
      await client.progressHostedRunControlV1({
        organizationId: authority.organizationId,
        credentialId: authority.credentialId,
        runnerId: authority.runnerId,
        runId,
        request,
      });
      await repo.appendRunEvent({
        runId,
        type: "run.progress",
        payload: progress,
        createdAt: progress.at,
        visibility: "human",
        importance: "normal",
        message: progress.message,
      });
    },
    async complete(runId, lease, result) {
      const completionMetadata =
        await buildHostedCompletionMetadataForControlV1(result);
      const request = HostedCompleteRequestV1Schema.parse(
        await buildHostedLifecycleRequestV1({
        action: "complete",
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        attempt,
        occurredAt: executionOccurredAt,
        ...completionMetadata,
        }),
      );
      await client.completeHostedRunControlV1({
        organizationId: authority.organizationId,
        credentialId: authority.credentialId,
        runnerId: authority.runnerId,
        runId,
        request,
      });
      const outcome = await repo.completeRun({
        runnerId: authority.runnerId,
        runId,
        ...lease,
        result,
      });
      if (outcome !== "completed" && outcome !== "duplicate") {
        throw new Error("hosted_local_complete_split_outcome");
      }
    },
    async requestActionPermission(runId, lease, request) {
      const actionId = `action_${(await computeControlPayloadDigestV1({
        runId,
        attemptId: lease.attemptId,
        toolCallId: request.toolCallId,
      })).slice("sha256:".length, "sha256:".length + 24)}`;
      const permissionRequestId = `permission_${(await computeControlPayloadDigestV1({
        actionId,
        request,
      })).slice("sha256:".length, "sha256:".length + 24)}`;
      const requestedAt = new Date().toISOString();
      const actionFamily = request.operation.toLowerCase().replace(/[^a-z0-9._-]/gu, "_").slice(0, 64) || "tool";
      const targetFingerprint = request.targetFingerprint
        ?? await computeControlPayloadDigestV1({
          connectionId: request.connectionId,
          operation: request.operation,
          resource: request.resource ?? null,
          targetConstraints: request.targetConstraints ?? null,
        });
      const digestInput = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        requiredCapabilities: ["relay.permission.v1"] as ["relay.permission.v1"],
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        attempt: {
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          epoch: attempt.epoch,
          fencingTokenDigest: attempt.fencingTokenDigest,
        },
        permissionRequestId,
        actionId,
        actionFamily,
        riskTier: "high" as const,
        targetFingerprint,
        permissionScopes: [...request.permissionScopes].sort(),
        policySnapshotRef: authority.policySnapshotRef,
        policySnapshotDigest: authority.policySnapshotDigest,
        requestedAt,
      };
      const permissionRequestDigest = await computePermissionRequestDigestV1(digestInput);
      const result = await client.requestActionPermissionControlV1({
        ...digestInput,
        requestId: permissionRequestId,
        operationId: permissionRequestId,
        attempt,
        permissionRequestDigest,
      });
      permissionRequests.set(actionId, { request, permissionRequestId, permissionRequestDigest });
      return permissionResolutionFromReceipt({ receipt: result.receipt, request });
    },
    async resolveActionPermission(runId, _lease, actionId) {
      const pending = permissionRequests.get(actionId);
      if (!pending) throw new Error("hosted_permission_request_unknown");
      const result = await client.getActionPermissionCurrentControlV1({
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        actionId,
        attempt: {
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          epoch: attempt.epoch,
          fencingTokenDigest: attempt.fencingTokenDigest,
        },
        permissionRequestId: pending.permissionRequestId,
        permissionRequestDigest: pending.permissionRequestDigest,
      });
      return permissionResolutionFromReceipt({ receipt: result.receipt, request: pending.request });
    },
    async recordMaterialActionReceipt(runId, _lease, actionId, receipt: MaterialActionReceipt) {
      const pending = permissionRequests.get(actionId);
      if (!pending) throw new Error("hosted_material_action_permission_unknown");
      const observedAt = receipt.observedAt;
      const operationId = `material_${receipt.id}`;
      const payload = {
        actionId,
        actionFamily: pending.request.operation.toLowerCase().replace(/[^a-z0-9._-]/gu, "_").slice(0, 64) || "tool",
        provider: receipt.provider,
        connectionRef: receipt.connectionId ?? pending.request.connectionId,
        targetFingerprint: receipt.targetFingerprint ?? pending.request.targetFingerprint
          ?? await computeControlPayloadDigestV1({ resource: pending.request.resource ?? null }),
        operationId,
        requestDigest: pending.permissionRequestDigest,
        actionPayloadDigest: await computeControlPayloadDigestV1(receipt.metadata ?? {}),
        outcome: receipt.outcome === "unknown" ? "outcome_unknown" as const : receipt.outcome,
        ...(receipt.externalId ? { externalId: receipt.externalId } : {}),
        ...(receipt.externalUri ? { externalUri: receipt.externalUri } : {}),
        observedAt,
        reasonCode: receipt.outcome === "succeeded"
          ? "provider_accepted" as const
          : receipt.outcome === "failed"
            ? "provider_error" as const
            : "provider_receipt_missing" as const,
        ...(receipt.outcome === "unknown"
          ? { nextAction: "reconcile_provider_receipt", owner: "local_operator" }
          : {}),
      };
      const receiptId = receipt.id;
      const envelopeBase = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        receiptKind: "material_action" as const,
        receiptId,
        organizationId: authority.organizationId,
        operationId,
        requiredCapabilities: ["relay.material-receipt.v1"] as ["relay.material-receipt.v1"],
        producer: { kind: "local_opentag" as const, id: authority.runnerId },
        identity: {
          namespace: "opentag.control.receipt/material-action/v1" as const,
          parts: [authority.organizationId, runId, attempt.attemptId, actionId, receiptId],
        },
        observedAt,
        runId,
        attempt: {
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          epoch: attempt.epoch,
          fencingTokenDigest: attempt.fencingTokenDigest,
        },
        payload,
        payloadDigest: await computeMaterialActionPayloadDigestV1(payload),
      };
      const envelope = {
        ...envelopeBase,
        receiptDigest: await computeMaterialActionReceiptDigestV1(envelopeBase),
      };
      await client.recordMaterialActionReceiptControlV1({
        runnerId: authority.runnerId,
        fencingToken: attempt.fencingToken,
        receipt: envelope,
      });
      const resolved = await client.getActionPermissionCurrentControlV1({
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        actionId,
        attempt: {
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          epoch: attempt.epoch,
          fencingTokenDigest: attempt.fencingTokenDigest,
        },
        permissionRequestId: pending.permissionRequestId,
        permissionRequestDigest: pending.permissionRequestDigest,
      });
      return permissionResolutionFromReceipt({ receipt: resolved.receipt, request: pending.request });
    },
  };
}

export function createHostedControlLoop(input: {
  config: OpenTagDaemonConfig;
  databasePath: string;
  executors: Record<string, ExecutorAdapter>;
  pullRequestOptions?: PullRequestOptions;
  security?: RunnerSecurityPolicy;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  controlClient?: OpenTagClient;
  governanceStore?: {
    repo: HostedExecutionRepository;
    close(): void;
  };
  executeClaimedRunImpl?: typeof executeClaimedRun;
  refetchGitHubIssueCommentImpl?: typeof refetchGitHubIssueCommentForHostedAdmission;
}): HostedControlLoop | undefined {
  const registration = input.config.controlRegistration;
  if (!registration || registration.state !== "paired" || !input.config.runnerToken) return undefined;
  const store = input.governanceStore
    ?? openDispatcherGovernanceStore(input.databasePath);
  const repo = store.repo as HostedExecutionRepository;
  const abortController = new AbortController();
  const client = input.controlClient ?? createOpenTagClient({
    dispatcherUrl: input.config.dispatcherUrl,
    controlCredential: { kind: "runtime", token: input.config.runnerToken },
    controlSignal: abortController.signal,
  });
  const clock = input.now ?? (() => new Date());
  let context: RunnerControlContextResponseV1 | undefined;
  const readinessProbeCache = new Map<string, {
    expiresAt: number;
    readiness: Awaited<ReturnType<ExecutorAdapter["canRun"]>>;
  }>();
  let inFlight: Promise<unknown> | undefined;
  let closed = false;
  const pump = async () => {
    if (!context) return;
    await pumpControlPlaneProjections({
      repo,
      client,
      destinationId: "cloud",
      organizationId: context.organizationId,
      leaseOwner: `runner_${input.config.runnerId}`,
    });
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    inFlight = operation;
    return operation.finally(() => {
      if (inFlight === operation) inFlight = undefined;
    });
  };
  return {
    beforeIteration() {
      return track((async () => {
        const nextContext = await client.getRunnerControlContextV1({
          runnerId: input.config.runnerId,
        });
        assertRunnerControlContextRegistrationV1({
          context: nextContext,
          registration,
        });
        // Read the clock after the response so network delay cannot make stale
        // authority appear current.
        if (!isRunnerControlContextFreshV1(nextContext.observedAt, clock())) {
          throw new Error("runner_control_context_stale");
        }
        context = nextContext;
        const localReadiness = await buildRunnerReadinessReceipt({
          context,
          executors: input.executors,
          repositories: input.config.repositories,
          now: clock,
          readinessProbeCache,
        });
        const recovery = await repo.getHostedAssignedRunForRecovery({
          destinationId: "cloud",
          organizationId: context.organizationId,
          runnerId: context.runnerId,
        });
        if (recovery) {
          const authority = recovery.hostedAuthority;
          const target = context.targets.find(
            (candidate) => candidate.projectTargetId === authority.projectTargetId,
          );
          const readyTarget = localReadiness.payload.targets.find(
            (candidate) => candidate.projectTargetId === authority.projectTargetId,
          );
          const readyExecutor = localReadiness.payload.executors.find(
            (candidate) => candidate.executorId === authority.executorId,
          );
          if (
            authority.organizationId !== context.organizationId
            || authority.runnerId !== context.runnerId
            || authority.credentialId !== context.credentialId
            || authority.registrationGeneration !== context.registrationGeneration
            || authority.credentialGeneration !== context.credentialGeneration
            || !target
            || target.bindingDigest !== authority.targetBindingDigest
            || target.defaultExecutor !== authority.executorId
            || readyTarget?.state !== "ready"
            || readyExecutor?.state !== "ready"
            || readyExecutor.capabilityDigest !== authority.executorCapabilityDigest
          ) {
            throw new Error("hosted_recovery_current_authority_mismatch");
          }
          const acquired = await repo.acquireHostedExecutionStart({
            runId: recovery.claimed.run.id,
            attemptId: recovery.claimed.attemptId,
            fencingToken: recovery.claimed.fencingToken,
          });
          if (!acquired) return false;
          const executionClient = await createHostedExecutionClient({
            client,
            repo,
            authority: {
              organizationId: authority.organizationId,
              runnerId: authority.runnerId,
              credentialId: authority.credentialId,
              attemptId: authority.attemptId,
              attemptNumber: authority.attemptNumber,
              epoch: authority.epoch,
              fencingToken: recovery.claimed.fencingToken,
              fencingTokenDigest: authority.fencingTokenDigest,
              executorCapabilityDigest: authority.executorCapabilityDigest,
              leaseExpiresAt: recovery.leaseExpiresAt,
              policySnapshotRef: authority.admissionPolicySnapshotId,
              policySnapshotDigest: authority.policyReceiptDigest,
            },
          });
          await (input.executeClaimedRunImpl ?? executeClaimedRun)({
            runnerId: context.runnerId,
            repositories: input.config.repositories,
            executors: input.executors,
            scratchRoot: input.config.scratchRoot,
            keepScratch: input.config.keepScratch,
            approvalMode: input.config.approvalMode,
            ...(input.security ? { security: input.security } : {}),
            ...(input.pullRequestOptions ? { pullRequestOptions: input.pullRequestOptions } : {}),
            ...(input.config.heartbeatIntervalMs ? { heartbeatIntervalMs: input.config.heartbeatIntervalMs } : {}),
            ...(input.config.runTimeoutMs ? { runTimeoutMs: input.config.runTimeoutMs } : {}),
            ...(input.config.agentSessionProfile ? { agentSessionProfile: input.config.agentSessionProfile } : {}),
            client: executionClient,
            claimed: recovery.claimed,
            hostedExecutionAuthority: {
              leaseExpiresAt: recovery.leaseExpiresAt,
              now: clock,
              assertCurrent: () => repo.isHostedExecutionCurrent({
                runId: recovery.claimed.run.id,
                attemptId: recovery.claimed.attemptId,
                fencingToken: recovery.claimed.fencingToken,
              }),
              readAcceptedLeaseExpiresAt: async () =>
                (await repo.getHostedExecutionLease({
                  destinationId: "cloud",
                  organizationId: authority.organizationId,
                  runnerId: authority.runnerId,
                  credentialId: authority.credentialId,
                  runId: recovery.claimed.run.id,
                  attemptId: recovery.claimed.attemptId,
                  fencingToken: recovery.claimed.fencingToken,
                }))?.leaseExpiresAt ?? null,
            },
          });
          return true;
        }
        const existing = await repo.getHostedClaimOperationForRetry({
          destinationId: "cloud",
          organizationId: context.organizationId,
          runnerId: context.runnerId,
        });
        let operation = existing;
        if (!operation) {
          // A new claim is forbidden until Cloud has synchronously accepted
          // this exact readiness receipt. Projection retries are not acceptance.
          const acceptedReadiness = await client.reportRunnerReadinessControlV1(
            localReadiness,
          );
          operation = (await repo.beginHostedClaimOperation({
            destinationId: "cloud",
            organizationId: context.organizationId,
            runnerId: context.runnerId,
            request: buildHostedClaimRequestV1({
              context,
              readiness: acceptedReadiness.receipt,
              requestId: `request_${randomUUID()}`,
              operationId: `operation_${randomUUID()}`,
            }),
          })).operation;
        }
        let claim: HostedClaimV1 | null;
        try {
          claim = await client.claimHostedRunControlV1({
            runnerId: context.runnerId,
            request: operation.request,
          });
        } catch (error) {
          const controlError = error as { status?: unknown; code?: unknown };
          if (
            controlError.status === 409
            && (controlError.code === "stale_control_authority"
              || controlError.code === "operation_digest_conflict")
          ) {
            await repo.abandonHostedClaimOperation({
              operationId: operation.operationId,
              requestId: operation.requestId,
              reasonCode: controlError.code,
            });
          }
          throw error;
        }
        if (!claim) {
          await repo.acknowledgeHostedClaimEmpty({
            operationId: operation.operationId,
            requestId: operation.requestId,
          });
          return false;
        }
        await assertHostedClaimCurrentAuthorityV1({
          claim,
          context,
          readiness: localReadiness,
          request: operation.request,
          now: clock(),
        });
        let imported: Awaited<ReturnType<HostedExecutionRepository["importHostedAssignedRun"]>>;
        try {
          if (!input.config.githubToken) {
            throw new Error("hosted_github_token_unavailable");
          }
          const refetched = await (input.refetchGitHubIssueCommentImpl
            ?? refetchGitHubIssueCommentForHostedAdmission)({
            admission: claim.hostedAdmission,
            token: input.config.githubToken,
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
            now: clock,
          });
          if (Date.parse(claim.attempt.leaseExpiresAt) <= clock().getTime()) {
            throw new Error("hosted_claim_lease_expired");
          }
          imported = await repo.importHostedAssignedRun({
            event: refetched.event,
            claim,
            sourceReceipt: refetched.receipt,
          });
        } catch (error) {
          // A rejection is itself fenced lifecycle mutation. Never emit it
          // after expiry or when the current Cloud authority was not verified.
          if (Date.parse(claim.attempt.leaseExpiresAt) > clock().getTime()) {
            const request = HostedRejectStartRequestV1Schema.parse(
              await buildHostedLifecycleRequestV1({
              organizationId: claim.organizationId,
              runnerId: claim.runnerId,
              runId: claim.runId,
              action: "reject-start",
              attempt: {
                attemptId: claim.attempt.id,
                attemptNumber: claim.attempt.number,
                epoch: claim.attempt.epoch,
                fencingToken: claim.attempt.fencingToken,
                fencingTokenDigest: claim.attempt.fencingTokenDigest,
              },
              occurredAt: clock().toISOString(),
              executorId: claim.executorId,
              reasonCode: "unknown_safe_failure",
              }),
            );
            await client.rejectHostedAttemptStartControlV1({
              organizationId: claim.organizationId,
              credentialId: claim.authority.credentialId,
              runnerId: claim.runnerId,
              runId: claim.runId,
              request,
            });
          }
          throw error;
        }
        if (Date.parse(claim.attempt.leaseExpiresAt) <= clock().getTime()) {
          throw new Error("hosted_claim_lease_expired_after_import");
        }
        if (imported.executionState !== "ready_to_start") return false;
        if (!imported.claimed) {
          throw new Error("hosted_import_ready_without_claimed_run");
        }
        const acquired = await repo.acquireHostedExecutionStart({
          runId: claim.runId,
          attemptId: claim.attempt.id,
          fencingToken: claim.attempt.fencingToken,
        });
        if (!acquired) return false;
        const executionClient = await createHostedExecutionClient({
          client,
          repo,
          authority: {
            organizationId: claim.organizationId,
            runnerId: claim.runnerId,
            credentialId: claim.authority.credentialId,
            attemptId: claim.attempt.id,
            attemptNumber: claim.attempt.number,
            epoch: claim.attempt.epoch,
            fencingToken: claim.attempt.fencingToken,
            fencingTokenDigest: claim.attempt.fencingTokenDigest,
            executorCapabilityDigest: claim.authority.executorCapabilityDigest,
            leaseExpiresAt: claim.attempt.leaseExpiresAt,
            policySnapshotRef: claim.admissionPolicySnapshot.payload.snapshotId,
            policySnapshotDigest: claim.admissionPolicySnapshot.receiptDigest,
          },
        });
        await (input.executeClaimedRunImpl ?? executeClaimedRun)({
          runnerId: claim.runnerId,
          repositories: input.config.repositories,
          executors: input.executors,
          scratchRoot: input.config.scratchRoot,
          keepScratch: input.config.keepScratch,
          approvalMode: input.config.approvalMode,
          ...(input.security ? { security: input.security } : {}),
          ...(input.pullRequestOptions ? { pullRequestOptions: input.pullRequestOptions } : {}),
          ...(input.config.heartbeatIntervalMs ? { heartbeatIntervalMs: input.config.heartbeatIntervalMs } : {}),
          ...(input.config.runTimeoutMs ? { runTimeoutMs: input.config.runTimeoutMs } : {}),
          ...(input.config.agentSessionProfile ? { agentSessionProfile: input.config.agentSessionProfile } : {}),
          client: executionClient,
          claimed: imported.claimed,
          hostedExecutionAuthority: {
            leaseExpiresAt: claim.attempt.leaseExpiresAt,
            now: clock,
            assertCurrent: () => repo.isHostedExecutionCurrent({
              runId: claim.runId,
              attemptId: claim.attempt.id,
              fencingToken: claim.attempt.fencingToken,
            }),
            readAcceptedLeaseExpiresAt: async () =>
              (await repo.getHostedExecutionLease({
                destinationId: "cloud",
                organizationId: claim.organizationId,
                runnerId: claim.runnerId,
                credentialId: claim.authority.credentialId,
                runId: claim.runId,
                attemptId: claim.attempt.id,
                fencingToken: claim.attempt.fencingToken,
              }))?.leaseExpiresAt ?? null,
          },
        });
        return true;
      })());
    },
    afterIteration() {
      return track(pump());
    },
    abort() {
      abortController.abort();
    },
    async close() {
      if (closed) return;
      closed = true;
      abortController.abort();
      try {
        await inFlight;
      } catch {
        // The abort path is expected to reject an in-flight transport call.
      }
      store.close();
    },
  };
}
