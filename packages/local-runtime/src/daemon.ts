import { createHash } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  formatProjectTargetRef,
  parseWorkContextMutationCommand,
  projectTargetRefFromEvent,
  sanitizeCredentialLikeValue,
  type OpenTagEvent,
  type OpenTagRun,
  type OpenTagRunResult,
  type ActionPermissionRequest,
  type ActionPermissionResolution,
  type ApprovalMode,
  type MaterialActionReceipt,
  type ProjectTargetRef
} from "@opentag/core";
import {
  assessRunnerSecurity,
  formatSecurityAssessment,
  createAgentSessionProfileForEvent,
  createWorkContextMutationRunResult,
  isFeishuReadOnlyMcpResource,
  resolveAgentSessionProfile,
  resolveRunnerSecurityPaths,
  type ExecutorAdapter,
  type ExecutorMaterialActionReport,
  type ExecutorWorkspace,
  type RunnerSecurityPolicy,
  executionPathForAttempt
} from "@opentag/runner";
import {
  canonicalRepositoryIdentity,
  type AgentSessionProfileConfig,
  type RepositoryBindingConfig,
} from "./config.js";
import type { HostedControlLoop } from "./control-v1.js";
import { maybeCreatePullRequest, type PullRequestOptions } from "./pr.js";

export type ClaimedRun = {
  run: OpenTagRun;
  event: OpenTagEvent;
  attemptId: string;
  attemptNumber: number;
  fencingToken: string;
  executorId?: string;
};

export type AttemptLease = Pick<ClaimedRun, "attemptId" | "fencingToken">;

export type DaemonClient = {
  claim(): Promise<ClaimedRun | null>;
  markRunning(
    runId: string,
    executor: string,
    lease: AttemptLease,
    options?: { executorCapability?: Record<string, unknown>; runTimeoutMs?: number; idempotencyKey?: string }
  ): Promise<void>;
  rejectAttemptStart?(runId: string, executorId: string, reason: string, lease: AttemptLease): Promise<void>;
  heartbeat(runId: string, lease: AttemptLease): Promise<void>;
  progress(runId: string, lease: AttemptLease, input: { type: string; message: string; at: string }): Promise<void>;
  complete(runId: string, lease: AttemptLease, result: OpenTagRunResult): Promise<void>;
  requestActionPermission(runId: string, lease: AttemptLease, request: ActionPermissionRequest): Promise<ActionPermissionResolution>;
  resolveActionPermission(runId: string, lease: AttemptLease, actionId: string): Promise<ActionPermissionResolution>;
  recordMaterialActionReceipt(runId: string, lease: AttemptLease, actionId: string, receipt: import("@opentag/core").MaterialActionReceipt): Promise<ActionPermissionResolution>;
};

export type TrustedMaterialActionReceiptProvider = (input: {
  runId: string;
  attemptId: string;
  report: ExecutorMaterialActionReport;
}) => Promise<MaterialActionReceipt | null>;

export function resolveRepositoryBinding(event: OpenTagEvent, repositories: RepositoryBindingConfig[]): RepositoryBindingConfig | null {
  const projectTargetRef = projectTargetRefFromEvent(event);
  if (!projectTargetRef) return null;
  const targetIdentity = canonicalRepositoryIdentity(projectTargetRef);

  return (
    repositories.find((candidate) => {
      const candidateIdentity = canonicalRepositoryIdentity(candidate);
      return candidateIdentity.provider === targetIdentity.provider
        && candidateIdentity.owner === targetIdentity.owner
        && candidateIdentity.repo === targetIdentity.repo;
    }) ?? null
  );
}

export function resolveWorkspacePath(event: OpenTagEvent, repositories: RepositoryBindingConfig[]): string | null {
  return resolveRepositoryBinding(event, repositories)?.checkoutPath ?? null;
}

function claimedProjectTargetFailure(input: {
  event: OpenTagEvent;
  projectTargetRef: ProjectTargetRef | null;
  repositories: RepositoryBindingConfig[];
}): OpenTagRunResult | null {
  if (!input.projectTargetRef) {
    const metadata = input.event.metadata ?? {};
    const hasRepositoryMetadata = ["repoProvider", "owner", "repo"].some((key) => metadata[key] !== undefined);
    if (input.event.source !== "github" && !hasRepositoryMetadata) return null;
    return {
      conclusion: "needs_human",
      summary: "Repository-bearing events require complete Project Target metadata.",
      nextAction: "Replay this event with repoProvider, owner, and repo metadata before allowing repository execution."
    };
  }

  if (input.event.source === "github" && input.projectTargetRef.provider !== "github") {
    return {
      conclusion: "needs_human",
      summary: `GitHub source events must target a GitHub Project Target, received ${formatProjectTargetRef(input.projectTargetRef)}.`,
      nextAction: "Verify the relay is preserving GitHub webhook metadata before allowing this run."
    };
  }

  const targetIdentity = canonicalRepositoryIdentity(input.projectTargetRef);
  const allowed = input.repositories.some((repository) => {
    const repositoryIdentity = canonicalRepositoryIdentity(repository);
    return repositoryIdentity.provider === targetIdentity.provider
      && repositoryIdentity.owner === targetIdentity.owner
      && repositoryIdentity.repo === targetIdentity.repo;
  });
  if (!allowed) {
    return {
      conclusion: "needs_human",
      summary: `This run targets ${formatProjectTargetRef(input.projectTargetRef)}, which is not in this runner's local Project Target allowlist.`,
      nextAction: "Update the local OpenTag config only if this relay and Project Target are trusted."
    };
  }

  return null;
}

function scratchPathForAttempt(root: string, attemptId: string): string {
  if (!isAbsolute(root)) throw new Error(`Scratch root must be absolute: ${root}`);
  const segment = createHash("sha256").update(attemptId).digest("hex").slice(0, 24);
  return join(resolve(root), `attempt-${segment}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedRunResult(stage: string, error: unknown): OpenTagRunResult {
  return {
    conclusion: "failure",
    summary: `${stage} failed: ${errorMessage(error)}`
  };
}

function formatDurationMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute(s)`;
  if (ms % 1_000 === 0) return `${ms / 1_000} second(s)`;
  return `${ms}ms`;
}

function timedOutRunResult(input: { executorName: string; timeoutMs: number }): OpenTagRunResult {
  return {
    conclusion: "timed_out",
    summary: `${input.executorName} exceeded the configured hard timeout of ${formatDurationMs(input.timeoutMs)}.`,
    nextAction: "OpenTag requested executor cancellation. Check the local audit/status output before retrying or continuing manually."
  };
}

function runNoLongerClaimed(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("stale_attempt") || message.includes("run_not_claimed_by_runner") || message.includes("run_not_found");
}

type ExecutorRunOutcome =
  | { kind: "result"; result: OpenTagRunResult }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }
  | { kind: "hosted_lease_expired" };

function pullRequestPreparationFailureResult(result: OpenTagRunResult, error: unknown): OpenTagRunResult {
  return {
    conclusion: "needs_human",
    summary: `Executor completed, but OpenTag could not prepare the pull request action: ${errorMessage(error)}`,
    ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    ...(result.verification ? { verification: result.verification } : {}),
    nextAction: "Fix branch push or pull request credentials, then retry the run before applying the PR action."
  };
}

function metadataToken(metadata: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function executorMetadata(event: OpenTagEvent): Record<string, unknown> {
  const metadata = event.metadata ?? {};
  const accountId =
    metadataToken(metadata, "accountId") ??
    metadataToken(metadata, "teamId") ??
    metadataToken(metadata, "tenantKey") ??
    metadataToken(metadata, "botId");
  const conversationId =
    metadataToken(metadata, "conversationId") ??
    metadataToken(metadata, "channelId") ??
    metadataToken(metadata, "chatId");

  return {
    ...metadata,
    provider: event.source,
    sourceActorId: event.actor.providerUserId,
    sourceOccurredAt: event.receivedAt,
    ...(accountId ? { accountId } : {}),
    ...(conversationId ? { conversationId } : {})
  };
}

export type LegacyDaemonIterationInput = {
  mode: "legacy";
  runnerId: string;
  repositories: RepositoryBindingConfig[];
  executors: Record<string, ExecutorAdapter>;
  scratchRoot?: string;
  keepScratch?: "always" | "on_failure" | "never";
  approvalMode?: ApprovalMode;
  trustedMaterialActionReceipt?: TrustedMaterialActionReceiptProvider;
  security?: RunnerSecurityPolicy;
  pullRequestOptions?: PullRequestOptions;
  heartbeatIntervalMs?: number;
  maxConcurrentRuns?: number;
  runTimeoutMs?: number;
  agentSessionProfile?: AgentSessionProfileConfig;
  client: DaemonClient;
};

export type ClaimedRunExecutionClient = Omit<DaemonClient, "claim">;

export type ClaimedRunExecutionInput = Omit<
  LegacyDaemonIterationInput,
  "mode" | "client"
> & {
  claimed: ClaimedRun;
  client: ClaimedRunExecutionClient;
  hostedExecutionAuthority?: {
    leaseExpiresAt: string;
    assertCurrent(): Promise<boolean>;
    readAcceptedLeaseExpiresAt?(): Promise<string | null>;
    now?: () => Date;
  };
};

export async function runOneDaemonIteration(
  input: LegacyDaemonIterationInput
): Promise<boolean> {
  const runtimeInput = input as unknown as Record<string, unknown>;
  if (
    (runtimeInput.mode !== undefined && runtimeInput.mode !== "legacy")
    || "controlLoop" in runtimeInput
    || "controlV1SidecarOnly" in runtimeInput
    || typeof input.client?.claim !== "function"
  ) {
    throw new Error(
      "runOneDaemonIteration accepts only a legacy claim-capable daemon runtime."
    );
  }
  const claimed = await input.client.claim();
  if (!claimed) return false;
  const { mode: _mode, ...executionInput } = input;
  return executeClaimedRun({
    ...executionInput,
    claimed,
  });
}

/**
 * Executes one already-claimed Attempt without owning claim authority.
 *
 * The caller supplies the authoritative Run, Attempt ID, and fencing token.
 * This helper only consumes those values through the claim-less lifecycle
 * client and never allocates or recovers an Attempt itself.
 */
export async function executeClaimedRun(
  input: ClaimedRunExecutionInput
): Promise<boolean> {
  const { claimed } = input;
  const lease: AttemptLease = { attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
  const runId = claimed.run.id;

  const projectTargetRef = projectTargetRefFromEvent(claimed.event);
  const claimedTargetFailure = claimedProjectTargetFailure({
    event: claimed.event,
    projectTargetRef,
    repositories: input.repositories
  });
  if (claimedTargetFailure) {
    await input.client.complete(claimed.run.id, lease, claimedTargetFailure);
    return true;
  }
  // Pure source-thread mutations stay on the governed apply path and do not
  // allocate either a repository worktree or a scratch attempt directory.
  const mutationRequests = parseWorkContextMutationCommand(claimed.event.command.rawText);
  if (mutationRequests) {
    await input.client.complete(
      claimed.run.id,
      lease,
      createWorkContextMutationRunResult({ runId: claimed.run.id, requests: mutationRequests })
    );
    return true;
  }
  const binding = resolveRepositoryBinding(claimed.event, input.repositories);
  const executorId = claimed.executorId ?? claimed.event.target.executorHint ?? binding?.defaultExecutor ?? "echo";
  async function rejectUnreadyAttempt(reason: string): Promise<void> {
    try {
      if (input.client.rejectAttemptStart) {
        await input.client.rejectAttemptStart(runId, executorId, reason, lease);
        return;
      }
      await input.client.complete(runId, lease, { conclusion: "needs_human", summary: reason });
    } catch (error) {
      if (!runNoLongerClaimed(error)) throw error;
    }
  }
  if (projectTargetRef && !binding) {
    await rejectUnreadyAttempt("No local workspace mapping is configured for this run's repository.");
    return true;
  }
  const scratchRoot = resolve(input.scratchRoot ?? join(process.cwd(), ".opentag", "scratch"));
  const workspace: ExecutorWorkspace = binding
    ? { kind: "repository", path: binding.checkoutPath }
    : {
        kind: "scratch",
        path: scratchPathForAttempt(scratchRoot, claimed.attemptId)
      };
  const executor = input.executors[executorId];
  if (!executor) {
    await rejectUnreadyAttempt(`No local executor is configured for '${executorId}'.`);
    return true;
  }
  const metadata = executorMetadata(claimed.event);
  const fallbackSessionProfile = createAgentSessionProfileForEvent({
    runId: claimed.run.id,
    event: claimed.event,
    metadata
  });
  const sessionProfile = input.agentSessionProfile
    ? resolveAgentSessionProfile({
        ...(input.agentSessionProfile.profile ? { profile: input.agentSessionProfile.profile } : {}),
        ...(input.agentSessionProfile.profileTemplate ? { profileTemplate: input.agentSessionProfile.profileTemplate } : {}),
        metadata: {
          ...metadata,
          runId: claimed.run.id
        },
        ...(projectTargetRef ? { projectTargetRef } : {}),
        actorId: claimed.event.actor.providerUserId,
        ...(fallbackSessionProfile ? { fallback: fallbackSessionProfile } : {})
      })
    : fallbackSessionProfile;

  const executionPath = executionPathForAttempt({
    workspace,
    runId: claimed.run.id,
    attemptId: claimed.attemptId,
    ...(binding?.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {})
  });
  if (workspace.kind === "scratch") {
    const existing = await lstat(workspace.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      await input.client.complete(claimed.run.id, lease, {
        conclusion: "needs_human",
        summary: "Scratch attempt workspace already exists; refusing to reuse it.",
        nextAction: "Inspect and preserve the existing attempt path, then retry the Run with a new Attempt."
      });
      return true;
    }
  }
  const securityPaths = await resolveRunnerSecurityPaths({
    workspacePath: workspace.path,
    executionPath,
    ...(workspace.kind === "scratch"
      ? { allowedWorkspaceRoot: scratchRoot }
      : input.security?.allowedWorkspaceRoot
        ? { allowedWorkspaceRoot: input.security.allowedWorkspaceRoot }
        : {})
  });

  const securityAssessment = assessRunnerSecurity({
    executorId,
    workspaceKind: workspace.kind,
    workspacePath: securityPaths.workspacePath,
    executionPath: securityPaths.executionPath,
    command: claimed.event.command,
    context: claimed.event.context,
    permissions: claimed.event.permissions,
    ...(workspace.kind === "scratch"
      ? { policy: { ...(input.security ?? {}), allowedWorkspaceRoot: securityPaths.allowedWorkspaceRoot ?? scratchRoot } }
      : input.security
        ? { policy: { ...input.security, ...(securityPaths.allowedWorkspaceRoot ? { allowedWorkspaceRoot: securityPaths.allowedWorkspaceRoot } : {}) } }
        : {})
  });
  if (securityAssessment.findings.length > 0) {
    await input.client.progress(claimed.run.id, lease, {
      type: securityAssessment.allowed ? "security.audit" : "security.blocked",
      message: formatSecurityAssessment(securityAssessment),
      at: new Date().toISOString()
    });
  }
  if (!securityAssessment.allowed) {
    await input.client.complete(claimed.run.id, lease, {
      conclusion: "needs_human",
      summary: formatSecurityAssessment(securityAssessment),
      nextAction: "Review the request and rerun with a narrower prompt or an explicit local policy override if appropriate."
    });
    return true;
  }

  let scratchAttemptCreated = false;
  if (workspace.kind === "scratch") {
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    try {
      await mkdir(workspace.path, { mode: 0o700 });
      scratchAttemptCreated = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await input.client.complete(claimed.run.id, lease, {
        conclusion: "needs_human",
        summary: "Scratch attempt workspace already exists; refusing to reuse it.",
        nextAction: "Inspect and preserve the existing attempt path, then retry the Run with a new Attempt."
      });
      return true;
    }
  }
  async function cleanupUnexecutedScratch(): Promise<void> {
    if (!scratchAttemptCreated || workspace.kind !== "scratch") return;
    await rm(workspace.path, { recursive: true, force: true });
    scratchAttemptCreated = false;
  }

  const activeExecutor = executor;
  const runTimeoutMs = input.runTimeoutMs;
  let readiness: Awaited<ReturnType<ExecutorAdapter["canRun"]>>;
  try {
    readiness = await executor.canRun({
      runId: claimed.run.id,
      attemptId: claimed.attemptId,
      workspace,
      command: claimed.event.command,
      context: claimed.event.context,
      ...(claimed.run.contextPacket ? { contextPacket: claimed.run.contextPacket } : {}),
      permissions: claimed.event.permissions,
      metadata,
      ...(sessionProfile ? { sessionProfile } : {}),
      ...(binding?.baseBranch ? { baseBranch: binding.baseBranch } : {}),
      ...(binding?.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
      ...(binding?.keepWorktree !== undefined ? { keepWorktree: binding.keepWorktree } : {})
    });
  } catch (error) {
    await cleanupUnexecutedScratch();
    const result = failedRunResult(`${executor.displayName} readiness check`, error);
    await rejectUnreadyAttempt(result.summary);
    return true;
  }

  if (!readiness.ready) {
    await cleanupUnexecutedScratch();
    await rejectUnreadyAttempt(readiness.reason ?? `${executor.displayName} is not ready`);
    return true;
  }

  try {
    await input.client.markRunning(runId, activeExecutor.id, lease, {
      ...(activeExecutor.capability ? { executorCapability: activeExecutor.capability as unknown as Record<string, unknown> } : {}),
      idempotencyKey: `${input.runnerId}:${runId}:running`,
      ...(runTimeoutMs ? { runTimeoutMs } : {})
    });
  } catch (error) {
    await cleanupUnexecutedScratch();
    if (!runNoLongerClaimed(error)) throw error;
    return true;
  }

  const attemptId = claimed.attemptId;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 15_000;
  let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let hostedLeaseDeadlineHandle: ReturnType<typeof setTimeout> | undefined;
  let cancellationDetected = false;
  let cancelPromise: Promise<void> | undefined;
  const hostedAuthority = input.hostedExecutionAuthority;
  const hostedClock = hostedAuthority?.now ?? (() => new Date());
  let hostedLeaseDeadline = hostedAuthority
    ? Date.parse(hostedAuthority.leaseExpiresAt)
    : undefined;
  let hostedLeaseRevoked = false;
  let armHostedLeaseDeadline: (() => void) | undefined;
  if (hostedAuthority && !Number.isFinite(hostedLeaseDeadline)) {
    throw new Error("hosted_execution_lease_deadline_invalid");
  }
  function beginExecutorCancellation(): void {
    cancellationDetected = true;
    cancelPromise ??= activeExecutor.cancel(runId, attemptId).catch((cancelError: unknown) => {
      console.warn(`OpenTag executor cancellation failed for ${runId}:`, cancelError);
    });
  }
  function revokeHostedExecutionAuthority(): void {
    hostedLeaseRevoked = true;
    beginExecutorCancellation();
  }
  function requestExecutorCancel(error: unknown): void {
    if (!runNoLongerClaimed(error)) {
      console.warn(`OpenTag heartbeat failed for ${runId}:`, error);
      return;
    }
    revokeHostedExecutionAuthority();
  }
  async function hostedExecutionIsCurrent(): Promise<boolean> {
    if (!hostedAuthority || hostedLeaseDeadline === undefined) return true;
    if (hostedLeaseRevoked || hostedClock().getTime() >= hostedLeaseDeadline) {
      revokeHostedExecutionAuthority();
      return false;
    }
    try {
      if (!(await hostedAuthority.assertCurrent())) {
        revokeHostedExecutionAuthority();
        return false;
      }
    } catch {
      revokeHostedExecutionAuthority();
      return false;
    }
    if (hostedLeaseRevoked || hostedClock().getTime() >= hostedLeaseDeadline) {
      revokeHostedExecutionAuthority();
      return false;
    }
    return true;
  }
  if (!(await hostedExecutionIsCurrent())) {
    if (cancelPromise) await cancelPromise;
    return true;
  }
  if (heartbeatIntervalMs > 0) {
    heartbeatHandle = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = input.client.heartbeat(runId, lease)
        .then(async () => {
          const acceptedLeaseExpiresAt = await hostedAuthority
            ?.readAcceptedLeaseExpiresAt?.();
          if (!acceptedLeaseExpiresAt || hostedLeaseRevoked) return;
          const acceptedDeadline = Date.parse(acceptedLeaseExpiresAt);
          if (
            Number.isFinite(acceptedDeadline)
            && hostedLeaseDeadline !== undefined
            && acceptedDeadline > hostedLeaseDeadline
          ) {
            hostedLeaseDeadline = acceptedDeadline;
            armHostedLeaseDeadline?.();
          }
        })
        .catch(requestExecutorCancel)
        .finally(() => {
          heartbeatInFlight = undefined;
        });
    }, heartbeatIntervalMs);
  }
  const trustedReceiptsByActionId = new Map<string, Promise<MaterialActionReceipt | null>>();

  const executorRunPromise: Promise<ExecutorRunOutcome> = activeExecutor
    .run(
      {
        runId,
        attemptId: claimed.attemptId,
        workspace,
        command: claimed.event.command,
        context: claimed.event.context,
        ...(claimed.run.contextPacket ? { contextPacket: claimed.run.contextPacket } : {}),
        permissions: claimed.event.permissions,
        permissionResolver: async (request) => {
          const deniedActionId = `hosted_denied_${createHash("sha256")
            .update(`${runId}:${attemptId}:${request.toolCallId}`)
            .digest("hex")
            .slice(0, 24)}`;
          if (!(await hostedExecutionIsCurrent())) {
            return { actionId: deniedActionId, decision: "deny" as const };
          }
          const permissionResource = request.resource
            ?? (isFeishuReadOnlyMcpResource(request.title) ? request.title : undefined);
          const trustedReadOnlyFeishuTool = isFeishuReadOnlyMcpResource(permissionResource);
          let resolution = await input.client.requestActionPermission(runId, lease, {
            toolCallId: request.toolCallId,
            title: request.title,
            ...(trustedReadOnlyFeishuTool
              ? { kind: "read" as const }
              : request.kind
                ? { kind: request.kind }
                : {}),
            connectionId: request.connectionId,
            operation: trustedReadOnlyFeishuTool ? "read" : request.operation,
            ...(permissionResource ? { resource: permissionResource } : {}),
            ...(request.resourceVersion ? { resourceVersion: request.resourceVersion } : {}),
            ...(request.targetFingerprint ? { targetFingerprint: request.targetFingerprint } : {}),
            ...(request.targetConstraints ? { targetConstraints: request.targetConstraints } : {}),
            ...(request.grantScope ? { grantScope: request.grantScope } : {}),
            permissionScopes: trustedReadOnlyFeishuTool ? [] : request.permissionScopes,
            mode: input.approvalMode ?? "auto",
            provider: request.provider
          });
          while (resolution.state === "waiting") {
            await new Promise((resolveWait) => setTimeout(resolveWait, 250));
            if (!(await hostedExecutionIsCurrent())) {
              return { actionId: resolution.action.id, decision: "deny" as const };
            }
            try {
              resolution = await input.client.resolveActionPermission(runId, lease, resolution.action.id);
            } catch (error) {
              if (runNoLongerClaimed(error)) return { actionId: resolution.action.id, decision: "deny" as const };
              throw error;
            }
          }
          if (!(await hostedExecutionIsCurrent())) {
            return { actionId: resolution.action.id, decision: "deny" as const };
          }
          if (resolution.state === "authorized") {
            return {
              actionId: resolution.action.id,
              decision: resolution.decision === "allow_run" ? "allow_run" as const : "allow_once" as const,
              material: resolution.action.riskTier !== "low"
            };
          }
          if (resolution.state === "reconciled") {
            return {
              actionId: resolution.action.id,
              decision: "deny" as const,
              reconciled: true,
              ...(resolution.receipt ? { receipt: { receiptRef: resolution.receipt.receiptRef, outcome: resolution.receipt.outcome } } : {})
            };
          }
          return { actionId: resolution.action.id, decision: "deny" as const };
        },
        materialActionReporter: async (report) => {
          if (!(await hostedExecutionIsCurrent())) {
            throw new Error("hosted_execution_authority_expired");
          }
          let trustedReceiptPromise = trustedReceiptsByActionId.get(report.actionId);
          if (!trustedReceiptPromise && input.trustedMaterialActionReceipt) {
            const createdReceiptPromise = input.trustedMaterialActionReceipt({ runId, attemptId: lease.attemptId, report });
            trustedReceiptsByActionId.set(report.actionId, createdReceiptPromise);
            trustedReceiptPromise = createdReceiptPromise;
          }
          const trustedReceipt = await trustedReceiptPromise;
          if (!(await hostedExecutionIsCurrent())) {
            throw new Error("hosted_execution_authority_expired");
          }
          await input.client.recordMaterialActionReceipt(runId, lease, report.actionId, trustedReceipt ?? {
            id: `receipt_${createHash("sha256").update(`${report.actionId}:${report.receiptRef}`).digest("hex").slice(0, 24)}`,
            actionId: report.actionId,
            provider: report.provider,
            receiptRef: report.receiptRef,
            outcome: report.outcome,
            observedAt: new Date().toISOString(),
            metadata: {
              toolCallId: report.toolCallId,
              assurance: "reported",
              ...(report.reportedOutcome ? { agentReportedOutcome: report.reportedOutcome } : {})
            }
          });
        },
        metadata,
        ...(sessionProfile ? { sessionProfile } : {}),
        ...(binding?.baseBranch ? { baseBranch: binding.baseBranch } : {}),
        ...(binding?.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
        ...(binding?.keepWorktree !== undefined ? { keepWorktree: binding.keepWorktree } : {})
      },
      {
        emit: async (event) => {
          const safeEvent = sanitizeCredentialLikeValue(event, { secrets: [lease.fencingToken] });
          console.log(`[${safeEvent.type}] ${safeEvent.message}`);
          try {
            await input.client.progress(runId, lease, {
              type: safeEvent.type,
              message: safeEvent.message,
              at: safeEvent.at
            });
          } catch (error) {
            if (runNoLongerClaimed(error)) {
              requestExecutorCancel(error);
              return;
            }
            throw error;
          }
        }
      }
    )
    .then(
      (result) => ({ kind: "result", result }) as const,
      (error: unknown) => ({ kind: "error", error }) as const
    );

  const timeoutPromise =
    runTimeoutMs && runTimeoutMs > 0
      ? new Promise<ExecutorRunOutcome>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), runTimeoutMs);
        })
      : undefined;
  const hostedLeaseDeadlinePromise =
    hostedAuthority && hostedLeaseDeadline !== undefined
      ? new Promise<ExecutorRunOutcome>((resolveDeadline) => {
          const armDeadline = () => {
            if (hostedLeaseRevoked) return;
            if (hostedLeaseDeadlineHandle) {
              clearTimeout(hostedLeaseDeadlineHandle);
              hostedLeaseDeadlineHandle = undefined;
            }
            const currentDeadline = hostedLeaseDeadline;
            if (currentDeadline === undefined) return;
            const remainingMs = currentDeadline - hostedClock().getTime();
            if (remainingMs <= 0) {
              hostedLeaseRevoked = true;
              beginExecutorCancellation();
              resolveDeadline({ kind: "hosted_lease_expired" });
              return;
            }
            hostedLeaseDeadlineHandle = setTimeout(
              armDeadline,
              Math.min(remainingMs, 2_147_483_647),
            );
          };
          armHostedLeaseDeadline = armDeadline;
          armDeadline();
        })
      : undefined;

  let executorOutcome: ExecutorRunOutcome;
  try {
    const competingOutcomes = [
      executorRunPromise,
      ...(timeoutPromise ? [timeoutPromise] : []),
      ...(hostedLeaseDeadlinePromise ? [hostedLeaseDeadlinePromise] : []),
    ];
    executorOutcome = await (competingOutcomes.length === 1
      ? executorRunPromise
      : Promise.race(competingOutcomes));
  } finally {
    if (heartbeatHandle) clearInterval(heartbeatHandle);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (hostedLeaseDeadlineHandle) clearTimeout(hostedLeaseDeadlineHandle);
    if (heartbeatInFlight) await heartbeatInFlight;
  }

  if (executorOutcome.kind === "hosted_lease_expired") {
    if (cancelPromise) await cancelPromise;
    return true;
  }

  if (executorOutcome.kind === "timeout") {
    if (cancellationDetected) {
      if (cancelPromise) await cancelPromise;
      return true;
    }
    cancellationDetected = true;
    cancelPromise ??= activeExecutor.cancel(runId, attemptId).catch((cancelError: unknown) => {
      console.warn(
        `OpenTag executor cancellation failed after timeout for ${runId}:`,
        sanitizeCredentialLikeValue(String(cancelError), { secrets: [lease.fencingToken] })
      );
    });
    await cancelPromise;
    if (!(await hostedExecutionIsCurrent())) {
      return true;
    }
    try {
      await input.client.complete(
        runId,
        lease,
        sanitizeCredentialLikeValue(
          timedOutRunResult({ executorName: activeExecutor.displayName, timeoutMs: runTimeoutMs ?? 0 }),
          { secrets: [lease.fencingToken] }
        )
      );
    } catch (completeError) {
      if (runNoLongerClaimed(completeError)) {
        return true;
      }
      throw completeError;
    }
    return true;
  }

  if (executorOutcome.kind === "error") {
    if (cancellationDetected) {
      if (cancelPromise) await cancelPromise;
      return true;
    }
    if (!(await hostedExecutionIsCurrent())) {
      if (cancelPromise) await cancelPromise;
      return true;
    }
    try {
      await input.client.complete(
        runId,
        lease,
        sanitizeCredentialLikeValue(failedRunResult(activeExecutor.displayName, executorOutcome.error), {
          secrets: [lease.fencingToken]
        })
      );
    } catch (completeError) {
      if (runNoLongerClaimed(completeError)) {
        return true;
      }
      throw completeError;
    }
    return true;
  }
  if (cancelPromise) await cancelPromise;
  if (cancellationDetected) {
    return true;
  }
  if (!(await hostedExecutionIsCurrent())) {
    if (cancelPromise) await cancelPromise;
    return true;
  }

  const executorResult = sanitizeCredentialLikeValue(executorOutcome.result, {
    secrets: [lease.fencingToken]
  });
  let result: OpenTagRunResult;
  try {
    result = binding
      ? await maybeCreatePullRequest({
          run: claimed.run,
          ...(executor.capability ? { executorCapability: executor.capability } : {}),
          event: claimed.event,
          binding,
          result: executorResult,
          options: input.pullRequestOptions ?? {},
          ...(hostedAuthority
            ? { assertExecutionCurrent: hostedExecutionIsCurrent }
            : {})
        })
      : executorResult;
  } catch (error) {
    if (!(await hostedExecutionIsCurrent())) {
      if (cancelPromise) await cancelPromise;
      return true;
    }
    result = sanitizeCredentialLikeValue(pullRequestPreparationFailureResult(executorResult, error), {
      secrets: [lease.fencingToken]
    });
  }
  if (!(await hostedExecutionIsCurrent())) {
    if (cancelPromise) await cancelPromise;
    return true;
  }
  try {
    await input.client.complete(runId, lease, result);
  } catch (error) {
    if (runNoLongerClaimed(error)) {
      return true;
    }
    throw error;
  }
  if (workspace.kind === "scratch" && result.conclusion === "success" && (input.keepScratch ?? "on_failure") !== "always") {
    try {
      await rm(workspace.path, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `OpenTag could not clean scratch workspace ${workspace.path}:`,
        sanitizeCredentialLikeValue(String(error), { secrets: [lease.fencingToken] })
      );
    }
  }
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeout);
      resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type LegacyDaemonRuntimeInput = LegacyDaemonIterationInput & {
  pollIntervalMs?: number;
  signal?: AbortSignal;
  controlLoop?: never;
};

export type ControlV1SidecarRuntimeInput = {
  mode: "control-v1-sidecar";
  pollIntervalMs?: number;
  signal?: AbortSignal;
  controlLoop: HostedControlLoop;
  client?: never;
};

export type DaemonRuntimeInput =
  | LegacyDaemonRuntimeInput
  | ControlV1SidecarRuntimeInput;

function assertDaemonRuntimeInput(input: DaemonRuntimeInput): void {
  const runtimeInput = input as unknown as Record<string, unknown>;
  if ("controlV1SidecarOnly" in runtimeInput) {
    throw new Error(
      "controlV1SidecarOnly is not a valid authority boundary; use a discriminated daemon runtime mode."
    );
  }
  if (runtimeInput.mode === "legacy") {
    if (
      "controlLoop" in runtimeInput
      || typeof (runtimeInput.client as { claim?: unknown } | undefined)?.claim
        !== "function"
    ) {
      throw new Error(
        "Legacy daemon runtime requires a claim-capable client and forbids a HostedControlLoop."
      );
    }
    return;
  }
  if (runtimeInput.mode === "control-v1-sidecar") {
    const loop = runtimeInput.controlLoop as Partial<HostedControlLoop> | undefined;
    if (
      "client" in runtimeInput
      || !loop
      || typeof loop.beforeIteration !== "function"
      || typeof loop.afterIteration !== "function"
      || typeof loop.abort !== "function"
      || typeof loop.close !== "function"
    ) {
      throw new Error(
        "Control V1 sidecar runtime requires a HostedControlLoop and forbids a claim-capable client."
      );
    }
    return;
  }
  throw new Error("Unknown daemon runtime mode.");
}

export async function serveDaemon(input: DaemonRuntimeInput): Promise<void> {
  assertDaemonRuntimeInput(input);
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  if (input.mode === "control-v1-sidecar") {
    const abortControlLoop = () => input.controlLoop.abort();
    input.signal?.addEventListener("abort", abortControlLoop, { once: true });
    try {
      while (!input.signal?.aborted) {
        try {
          const didWork = await input.controlLoop.beforeIteration();
          await input.controlLoop.afterIteration();
          if (!didWork) {
            await sleep(pollIntervalMs, input.signal);
          }
        } catch (error) {
          if (input.signal?.aborted) break;
          console.warn("OpenTag Control V1 sidecar iteration failed; retrying:", error);
          await sleep(pollIntervalMs, input.signal);
        }
      }
    } finally {
      input.signal?.removeEventListener("abort", abortControlLoop);
      await input.controlLoop.close();
    }
    return;
  }

  const workerCount = Math.max(1, Math.floor(input.maxConcurrentRuns ?? 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!input.signal?.aborted) {
      try {
        const didWork = await runOneDaemonIteration(input);
        if (!didWork) {
          await sleep(pollIntervalMs, input.signal);
        }
      } catch (error) {
        if (input.signal?.aborted) break;
        console.warn("OpenTag daemon iteration failed; retrying:", error);
        await sleep(pollIntervalMs, input.signal);
      }
    }
  }));
}
