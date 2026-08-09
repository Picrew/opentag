import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createOpenTagClient, type OpenTagClient } from "@opentag/client";
import type {
  CompletionAssessmentReceiptEnvelopeV1,
  CompletionContractRefReceiptEnvelopeV1,
  RunnerReadinessReceiptEnvelopeV1,
  RunnerControlContextResponseV1,
  WorkThreadRefReceiptEnvelopeV1,
} from "@opentag/core";
import {
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  RunnerReadinessReceiptEnvelopeV1Schema,
} from "@opentag/core";
import { openDispatcherGovernanceStore } from "@opentag/dispatcher";
import type { ExecutorAdapter } from "@opentag/runner";
import {
  canonicalRepositoryIdentity,
  type OpenTagDaemonConfig,
  type RepositoryBindingConfig,
} from "./config.js";

const require = createRequire(import.meta.url);
const LOCAL_RUNTIME_VERSION = (require("../package.json") as { version: string }).version;
const READINESS_TTL_MS = 60_000;
const READINESS_PROBE_CACHE_RATIO = 0.5;
const CONTROL_TRANSFER_TIMEOUT_MS = 30_000;
const CONTROL_LEASE_SAFETY_MS = 5_000;
const DEFAULT_CONTROL_LEASE_SECONDS = 90;

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

export function createHostedControlLoop(input: {
  config: OpenTagDaemonConfig;
  databasePath: string;
  executors: Record<string, ExecutorAdapter>;
  now?: () => Date;
}): HostedControlLoop | undefined {
  const registration = input.config.controlRegistration;
  if (!registration || registration.state !== "paired" || !input.config.runnerToken) return undefined;
  const store = openDispatcherGovernanceStore(input.databasePath);
  const abortController = new AbortController();
  const client = createOpenTagClient({
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
  const contextFresh = () => {
    if (!context) return false;
    return isRunnerControlContextFreshV1(context.observedAt, clock());
  };
  const pump = async () => {
    if (!context) return;
    await pumpControlPlaneProjections({
      repo: store.repo,
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
        try {
          const nextContext = await client.getRunnerControlContextV1({
            runnerId: input.config.runnerId,
          });
          assertRunnerControlContextRegistrationV1({
            context: nextContext,
            registration,
          });
          // Read the clock after the network response so time spent waiting for
          // the server cannot make a stale context appear fresh.
          if (!isRunnerControlContextFreshV1(nextContext.observedAt, clock())) {
            throw new Error("runner_control_context_stale");
          }
          context = nextContext;
          const receipt = await buildRunnerReadinessReceipt({
            context,
            executors: input.executors,
            repositories: input.config.repositories,
            now: clock,
            readinessProbeCache,
          });
          const queued = await store.repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope: receipt,
          });
          if (queued.outcome === "conflict") {
            throw new Error("runner_readiness_projection_conflict");
          }
        } catch (error) {
          // Only transient transport/server failures may use a recently verified
          // context. Invalid, forbidden, or conflicting control data fails closed.
          if (!retryableControlContextError(error)) throw error;
        }
        await pump();
        return contextFresh();
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
