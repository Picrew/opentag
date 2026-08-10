import { createDispatcherClient } from "@opentag/client";
import {
  OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1,
  resolveGitHubSourceApiOrigin
} from "@opentag/github";
import {
  createAcpAgentExecutor,
  createBuiltInAcpExecutors,
  createEchoExecutor,
  DEFAULT_HERMES_PROFILE,
  type BuiltInAcpAgentOptions,
  type ExecutorAdapter,
  type RunnerSecurityPolicy
} from "@opentag/runner";
import type { RunnerExecutorRegistration } from "@opentag/core";
import {
  assertHostedRelayAuthorization,
  hostedRunnerAuthProblem,
  runnerDispatcherToken,
  type OpenTagDaemonConfig
} from "./config.js";
import type { DaemonClient, DaemonRuntimeInput } from "./daemon.js";
import type { PullRequestOptions } from "./pr.js";
import { createHostedControlLoop } from "./control-v1.js";

export function securityFromConfig(config: OpenTagDaemonConfig): RunnerSecurityPolicy | undefined {
  const security = config.security;
  if (!security) return undefined;

  const normalized: RunnerSecurityPolicy = {};
  if (security.mode !== undefined) normalized.mode = security.mode;
  if (security.allowedWorkspaceRoot !== undefined) normalized.allowedWorkspaceRoot = security.allowedWorkspaceRoot;
  if (security.allowUnsafePrompts !== undefined) normalized.allowUnsafePrompts = security.allowUnsafePrompts;
  if (security.extraSafeEnv !== undefined) normalized.extraSafeEnv = security.extraSafeEnv;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function hermesProfileConfigurationWarning(config: OpenTagDaemonConfig): string | undefined {
  if (!config.hermes?.profileTemplate) return undefined;
  const profile = config.hermes.profile ?? DEFAULT_HERMES_PROFILE;
  return (
    "Hermes configuration warning: daemon.hermes.profileTemplate is not used because OpenTag does not yet provision per-run " +
    `Hermes profiles. OpenTag will use the fixed profile '${profile}'; set daemon.hermes.profile explicitly and remove profileTemplate.`
  );
}

export function builtInAcpOptionsFromConfig(config: OpenTagDaemonConfig): BuiltInAcpAgentOptions {
  const security = securityFromConfig(config);
  return {
    ...(security ? { security } : {}),
    hermes: {
      ...(config.hermes?.command ? { command: config.hermes.command } : {}),
      ...(config.hermes?.profile ? { profile: config.hermes.profile } : {})
    },
    openclaw: {
      ...(config.openclaw?.command ? { command: config.openclaw.command } : {}),
      ...(config.openclaw?.profile ? { profile: config.openclaw.profile } : {}),
      ...(config.openclaw?.gatewayUrl ? { gatewayUrl: config.openclaw.gatewayUrl } : {}),
      ...(config.openclaw?.expectedVersion ? { expectedVersion: config.openclaw.expectedVersion } : {})
    }
  };
}

export function executorsFromConfig(config: OpenTagDaemonConfig) {
  const security = securityFromConfig(config);
  const builtInAcpExecutors = createBuiltInAcpExecutors(builtInAcpOptionsFromConfig(config));

  const executors: Record<string, ExecutorAdapter> = {
    echo: createEchoExecutor(),
    codex: builtInAcpExecutors.codex,
    "claude-code": builtInAcpExecutors["claude-code"],
    cursor: builtInAcpExecutors.cursor,
    opencode: builtInAcpExecutors.opencode,
    hermes: builtInAcpExecutors.hermes,
    openclaw: builtInAcpExecutors.openclaw
  };
  for (const [id, agent] of Object.entries(config.agents)) {
    if (Object.prototype.hasOwnProperty.call(executors, id)) {
      throw new Error(`Configured ACP agent '${id}' cannot replace built-in executor '${id}'.`);
    }
    executors[id] = createAcpAgentExecutor(
      {
        id,
        label: agent.label ?? id,
        workspaceCwd: agent.workspaceCwd,
        launch: {
          command: agent.command,
          args: agent.args,
          ...(agent.cwd ? { cwd: agent.cwd } : {})
        },
        ...(agent.sessionModeId ? { sessionModeId: agent.sessionModeId } : {}),
        capabilities: { supportsProfile: agent.supportsProfile, supportsCancel: agent.supportsCancel },
        ...(agent.readinessTimeoutMs ? { readinessTimeoutMs: agent.readinessTimeoutMs } : {})
      },
      security ? { security } : {}
    );
  }
  return executors;
}

export function runnerExecutorRegistrations(
  executors: Record<string, ExecutorAdapter>
): RunnerExecutorRegistration[] {
  return Object.values(executors)
    .map((executor) => ({
      executorId: executor.id,
      ...(executor.capability ? { capability: { ...executor.capability } } : {}),
      readiness: "ready" as const,
      reason: "Executor is configured; run-specific readiness is verified before execution starts."
    }))
    .sort((left, right) => left.executorId.localeCompare(right.executorId));
}

export function createDaemonClient(config: OpenTagDaemonConfig): DaemonClient {
  if (config.controlRegistration) {
    assertHostedRelayAuthorization({
      dispatcherUrl: config.dispatcherUrl,
      trustedRelay: config.trustedRelay
    });
    const hostedAuthProblem = hostedRunnerAuthProblem(config);
    if (hostedAuthProblem) throw new Error(hostedAuthProblem);
    throw new Error(
      "Hosted Control V1 does not expose a legacy claim-capable daemon client."
    );
  }
  const token = runnerDispatcherToken(config);
  return createDispatcherClient({
    dispatcherUrl: config.dispatcherUrl,
    runnerId: config.runnerId,
    ...(token ? { pairingToken: token } : {})
  });
}

export function pullRequestOptionsFromConfig(config: OpenTagDaemonConfig): PullRequestOptions | undefined {
  const githubToken = config.githubToken === OPENTAG_E2E_NO_PROVIDER_CREDENTIAL_V1
    ? undefined
    : config.githubToken;
  if (!githubToken && config.preparePullRequestBranch === undefined && config.allowAutoCreatePullRequest === undefined) {
    return undefined;
  }

  return {
    ...(githubToken ? { githubToken } : {}),
    ...(config.preparePullRequestBranch !== undefined ? { preparePullRequestBranch: config.preparePullRequestBranch } : {}),
    ...(config.allowAutoCreatePullRequest !== undefined ? { allowAutoCreatePullRequest: config.allowAutoCreatePullRequest } : {})
  };
}

export function createDaemonRuntimeInput(
  config: OpenTagDaemonConfig,
  options: { databasePath?: string; githubApiOrigin?: string } = {},
): DaemonRuntimeInput {
  const security = securityFromConfig(config);
  const pullRequestOptions = pullRequestOptionsFromConfig(config);
  const executors = executorsFromConfig(config);
  if (options.githubApiOrigin !== undefined && !config.controlRegistration) {
    throw new Error(
      "Hosted Control V1 E2E GitHub API origin requires paired Hosted Control V1."
    );
  }
  if (config.controlRegistration) {
    if (!options.databasePath) {
      throw new Error(
        "Hosted Control V1 requires the authoritative local dispatcher database path."
      );
    }
    assertHostedRelayAuthorization({
      dispatcherUrl: config.dispatcherUrl,
      trustedRelay: config.trustedRelay
    });
    const hostedAuthProblem = hostedRunnerAuthProblem(config);
    if (hostedAuthProblem) throw new Error(hostedAuthProblem);
    const githubApiOrigin = options.githubApiOrigin !== undefined
      ? resolveGitHubSourceApiOrigin({
        token: config.githubToken ?? "",
        apiOrigin: options.githubApiOrigin,
      })
      : undefined;
    const controlLoop = createHostedControlLoop({
      config,
      databasePath: options.databasePath,
      executors,
      ...(security ? { security } : {}),
      ...(pullRequestOptions ? { pullRequestOptions } : {}),
      ...(githubApiOrigin !== undefined ? { githubApiOrigin } : {}),
    });
    if (!controlLoop) {
      throw new Error("Hosted Control V1 sidecar could not be created.");
    }
    return {
      mode: "control-v1-sidecar",
      controlLoop,
      ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
    };
  }

  return {
    mode: "legacy",
    runnerId: config.runnerId,
    repositories: config.repositories,
    executors,
    scratchRoot: config.scratchRoot,
    keepScratch: config.keepScratch,
    approvalMode: config.approvalMode,
    ...(security ? { security } : {}),
    ...(pullRequestOptions ? { pullRequestOptions } : {}),
    ...(config.heartbeatIntervalMs ? { heartbeatIntervalMs: config.heartbeatIntervalMs } : {}),
    ...(config.runTimeoutMs ? { runTimeoutMs: config.runTimeoutMs } : {}),
    ...(config.agentSessionProfile ? { agentSessionProfile: config.agentSessionProfile } : {}),
    ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
    client: createDaemonClient(config)
  };
}
