import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatProjectTargetRef } from "@opentag/core";
import { nodeCommandRunner, type CommandRunner, type ExecutorAdapter, type ExecutorCapabilityContract } from "@opentag/runner";
import { createOpenTagClient } from "@opentag/client";
import { hostedRunnerAuthProblem, normalizeChannelBindings, runnerDispatcherToken } from "./config.js";
import type { OpenTagDaemonConfig, RepositoryBindingConfig } from "./config.js";
import { hermesProfileConfigurationWarning } from "./runtime.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  name: string;
  status: DoctorCheckStatus;
  message: string;
};

function check(status: DoctorCheckStatus, name: string, message: string): DoctorCheck {
  return { name, status, message };
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function formatExecutorCapability(capability: ExecutorCapabilityContract): string {
  const secrets = capability.requiredSecrets.length ? capability.requiredSecrets.map((secret) => secret.id).join(",") : "none";
  const completion = capability.completionSignals.map((signal) => signal.type).join(",");
  const context = capability.contextAccess.length ? capability.contextAccess.join(",") : "none";
  return [
    `invocation=${capability.invocation}`,
    `profile=${yesNo(capability.supportsProfile)}`,
    `streaming=${yesNo(capability.supportsStreaming)}`,
    `cancel=${yesNo(capability.supportsCancel)}`,
    `hook_completion=${yesNo(capability.supportsHookCompletion)}`,
    `progress=${capability.progressEvents}`,
    `approval=${capability.approvalMode}`,
    `context=${context}`,
    `prompt=${capability.promptAssembly}`,
    `write=${capability.writeAccess}`,
    `conversation=${capability.conversationAccess}`,
    `prompt_mutation=${capability.promptMutation}`,
    `raw_context=${yesNo(capability.rawContextAccess)}`,
    `write_actions=${capability.writeActionAccess}`,
    `isolation=${capability.workspaceIsolation}`,
    `cwd_conformance=${capability.workspaceCwdConformance ?? "not_applicable"}`,
    `secrets=${secrets}`,
    `completion=${completion}`
  ].join(", ");
}

function checkExecutorCapability(name: string, capability: ExecutorCapabilityContract): DoctorCheck {
  return check(
    capability.workspaceCwdConformance === "unverified" ? "fail" : "ok",
    `${name} capability`,
    formatExecutorCapability(capability)
  );
}

function envSecretConfigured(env: Record<string, string | undefined>, name: string): boolean {
  return Boolean(env[name]?.trim());
}

function executorSecretReference(secret: ExecutorCapabilityContract["requiredSecrets"][number]): string {
  return secret.env ? `env ${secret.env}` : "an executor-specific secret reference";
}

function checkExecutorSecretRequirements(input: {
  capability: ExecutorCapabilityContract;
  env: Record<string, string | undefined>;
}): DoctorCheck[] {
  return input.capability.requiredSecrets.map((secret) => {
    const reference = executorSecretReference(secret);
    const configured = secret.env ? envSecretConfigured(input.env, secret.env) : false;
    if (configured) {
      return check(
        "ok",
        `${input.capability.id} secret ${secret.id}`,
        `${secret.label} configured via ${reference} (${secret.required ? "required" : "optional"}).`
      );
    }
    if (secret.required) {
      return check(
        "fail",
        `${input.capability.id} secret ${secret.id}`,
        `${secret.label} is required but ${reference} is not configured.${secret.description ? ` ${secret.description}` : ""}`
      );
    }
    return check(
      "ok",
      `${input.capability.id} secret ${secret.id}`,
      `${secret.label} is optional and not configured via ${reference}; executor may use local login/config.`
    );
  });
}

// Codex accepts built-in tiers (e.g. flex, fast), legacy request values (e.g. priority),
// and catalog-provided tier IDs. OpenTag should not maintain a closed allowlist here.
const CODEX_DEPRECATED_SERVICE_TIERS = new Set(["default"]);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_RUNNER_HEARTBEAT_STALE_MS = 30_000;

function defaultCodexConfigPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

function parseCodexServiceTiers(configText: string): string[] {
  return [...configText.matchAll(/^\s*service_tier\s*=\s*(?:"([^"]+)"|'([^']+)')(?:\s*#.*)?\s*$/gm)]
    .map((match) => match[1] ?? match[2])
    .filter((value): value is string => Boolean(value));
}

function shouldCheckCodexConfig(config: OpenTagDaemonConfig): boolean {
  return config.repositories.some((repository) => repository.defaultExecutor === "codex");
}

function checkRunnerApiAuth(config: OpenTagDaemonConfig): DoctorCheck {
  const hostedAuthProblem = hostedRunnerAuthProblem(config);
  if (hostedAuthProblem) {
    return check("fail", "hosted runner auth", hostedAuthProblem);
  }
  if (config.controlRegistration) {
    return check(
      "ok",
      "hosted runner auth",
      "Hosted Control V1 paired runtime credential is valid for this runner; pairing credentials are not used."
    );
  }
  if (config.runnerToken) {
    return check(
      "ok",
      "hook ingest auth",
      "Runner-scoped dispatcher token is configured separately from the pairing token for claim/progress/completion and local hook ingest."
    );
  }
  return config.pairingToken
    ? check(
        "ok",
        "hook ingest auth",
        "Legacy daemon pairing token is configured for runner calls and local hook ingest; configure runnerToken to reduce relay credential blast radius."
      )
    : check(
        "warn",
        "hook ingest auth",
        "No runner-scoped dispatcher token is configured; runner endpoints and local hook ingest are not protected."
      );
}

function formatDurationMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute(s)`;
  if (ms % 1_000 === 0) return `${ms / 1_000} second(s)`;
  return `${ms}ms`;
}

function repositoryTargetLabel(repository: RepositoryBindingConfig): string {
  return formatProjectTargetRef({
    provider: repository.provider,
    owner: repository.owner,
    repo: repository.repo
  });
}

function runnerHeartbeatStaleAfterMs(config: OpenTagDaemonConfig): number {
  return Math.max(
    config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    MIN_RUNNER_HEARTBEAT_STALE_MS / 3
  ) * 3;
}

function checkRunnerHeartbeat(input: {
  heartbeatAt?: string;
  config: OpenTagDaemonConfig;
  now?: Date;
}): DoctorCheck {
  if (!input.heartbeatAt) {
    return check(
      "warn",
      "runner heartbeat",
      "no heartbeat observed yet; the runner may be starting or the dispatcher may not expose runner heartbeat metadata."
    );
  }

  const heartbeatTime = Date.parse(input.heartbeatAt);
  if (!Number.isFinite(heartbeatTime)) {
    return check("warn", "runner heartbeat", `invalid heartbeat timestamp: ${input.heartbeatAt}`);
  }

  const now = input.now?.getTime() ?? Date.now();
  const ageMs = Math.max(0, now - heartbeatTime);
  const staleAfterMs = runnerHeartbeatStaleAfterMs(input.config);
  if (ageMs > staleAfterMs) {
    return check(
      "warn",
      "runner heartbeat",
      `stale; last heartbeat ${input.heartbeatAt} (${formatDurationMs(ageMs)} ago, stale after ${formatDurationMs(staleAfterMs)})`
    );
  }

  return check("ok", "runner heartbeat", `fresh; last heartbeat ${input.heartbeatAt}`);
}

function runnerTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").toLowerCase();
}

function normalizedRevokedFingerprints(config: OpenTagDaemonConfig): Set<string> {
  return new Set((config.revokedRunnerTokenFingerprints ?? []).map((fingerprint) => fingerprint.trim().toLowerCase()).filter(Boolean));
}

function checkRunnerTokenRotation(config: OpenTagDaemonConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const rotationCount = config.runnerTokens?.length ?? 0;
  const revoked = normalizedRevokedFingerprints(config);

  if (rotationCount > 0) {
    checks.push(
      config.runnerToken
        ? check("ok", "runner token rotation", `${rotationCount} additional runner token(s) configured for the rotation window.`)
        : check(
            "warn",
            "runner token rotation",
            "Additional runner tokens are configured, but daemon.runnerToken is missing; configure the current runner token before relying on rotation."
          )
    );
  }

  if (revoked.size > 0) {
    const currentTokenRevoked = config.runnerToken ? revoked.has(runnerTokenFingerprint(config.runnerToken)) : false;
    const rotationTokenFingerprints = new Set((config.runnerTokens ?? []).map(runnerTokenFingerprint));
    const rotationTokenRevokedCount = [...rotationTokenFingerprints].filter((fingerprint) => revoked.has(fingerprint)).length;
    checks.push(
      currentTokenRevoked
        ? check(
            "fail",
            "runner token revocation",
            "Current daemon.runnerToken fingerprint is revoked; pair again or update daemon.runnerToken before starting the runner."
          )
        : rotationTokenRevokedCount > 0
          ? check(
              "fail",
              "runner token revocation",
              `${rotationTokenRevokedCount} daemon.runnerTokens fingerprint(s) are revoked; remove revoked rotation tokens before relying on rotation.`
            )
        : check(
            "ok",
            "runner token revocation",
            `${revoked.size} revoked runner token fingerprint(s) configured; revoked tokens fail closed without printing token values.`
          )
    );
  }

  return checks;
}

function checkCodexConfig(configPath = defaultCodexConfigPath()): DoctorCheck {
  if (!existsSync(configPath)) {
    return check("ok", "Codex config", `No Codex config file found at ${configPath}; CLI defaults will be used`);
  }

  let configText: string;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch (error) {
    return check("fail", "Codex config", error instanceof Error ? error.message : String(error));
  }

  const serviceTiers = parseCodexServiceTiers(configText);
  if (!serviceTiers.length) {
    return check("ok", "Codex config", `No service_tier override configured in ${configPath}`);
  }

  const deprecatedTier = serviceTiers.find((tier) => CODEX_DEPRECATED_SERVICE_TIERS.has(tier));
  if (deprecatedTier) {
    return check(
      "fail",
      "Codex config",
      `Deprecated service_tier '${deprecatedTier}' in ${configPath}. Remove it or set a current Codex tier such as 'flex' or 'fast'.`
    );
  }

  return check("ok", "Codex config", `service_tier=${serviceTiers.join(", ")}`);
}

async function checkGitCheckout(input: {
  repository: RepositoryBindingConfig;
  executor?: ExecutorAdapter;
  commandRunner: CommandRunner;
  env: Record<string, string | undefined>;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const target = repositoryTargetLabel(input.repository);
  if (!existsSync(input.repository.checkoutPath)) {
    return [check("fail", `${target} checkout`, "Configured workspace path does not exist (hasWorkspacePath=yes).")];
  }
  checks.push(check("ok", `${target} checkout`, "Workspace path configured (hasWorkspacePath=yes)."));

  try {
    const gitRepo = await input.commandRunner.run("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: input.repository.checkoutPath
    });
    if (gitRepo.exitCode !== 0 || gitRepo.stdout.trim() !== "true") {
      checks.push(check("fail", `${target} git repo`, gitRepo.stderr || gitRepo.stdout || "Not a git repository."));
      return checks;
    }
    checks.push(check("ok", `${target} git repo`, "Git checkout detected"));
  } catch (error) {
    checks.push(
      check(
        "fail",
        `${target} git repo`,
        error instanceof Error ? error.message : String(error)
      )
    );
    return checks;
  }

  const executor = input.executor;
  if (!executor) {
    checks.push(check("fail", `${input.repository.defaultExecutor} executor`, "No local executor is configured with this id."));
    return checks;
  }
  checks.push(
    executor.capability
      ? checkExecutorCapability(input.repository.defaultExecutor, executor.capability)
      : check(
          "warn",
          `${input.repository.defaultExecutor} capability`,
          "Executor does not declare a capability contract; readiness may be incomplete."
        )
  );
  if (executor.capability) {
    checks.push(...checkExecutorSecretRequirements({ capability: executor.capability, env: input.env }));
  }
  try {
    const readiness = await executor.canRun({
      runId: "doctor",
      workspace: { kind: "repository", path: input.repository.checkoutPath },
      ...(input.repository.baseBranch ? { baseBranch: input.repository.baseBranch } : {}),
      ...(input.repository.worktreeRoot ? { worktreeRoot: input.repository.worktreeRoot } : {}),
      ...(input.repository.keepWorktree ? { keepWorktree: input.repository.keepWorktree } : {}),
      command: { rawText: "doctor", intent: "unknown", args: {} },
      context: []
    });
    checks.push(
      readiness.ready
        ? check("ok", `${input.repository.defaultExecutor} executor`, `${executor.displayName} is ready`)
        : check("fail", `${input.repository.defaultExecutor} executor`, readiness.reason ?? `${executor.displayName} is not ready`)
    );
  } catch (error) {
    checks.push(
      check(
        "fail",
        `${input.repository.defaultExecutor} executor`,
        error instanceof Error ? error.message : String(error)
      )
    );
  }
  return checks;
}

export async function runDoctor(input: {
  config: OpenTagDaemonConfig;
  executors: Record<string, ExecutorAdapter>;
  fetchImpl?: typeof fetch;
  commandRunner?: CommandRunner;
  codexConfigPath?: string;
  now?: Date;
  env?: Record<string, string | undefined>;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const commandRunner = input.commandRunner ?? nodeCommandRunner;
  const env = input.env ?? process.env;
  const hermesProfileWarning = hermesProfileConfigurationWarning(input.config);
  if (hermesProfileWarning) {
    checks.push(check("warn", "Hermes profile configuration", hermesProfileWarning));
  }
  const hostedAuthProblem = hostedRunnerAuthProblem(input.config);
  const token = runnerDispatcherToken(input.config);
  const client = hostedAuthProblem
    ? undefined
    : createOpenTagClient({
        dispatcherUrl: input.config.dispatcherUrl,
        ...(token ? { pairingToken: token } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
      });

  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.config.dispatcherUrl.replace(/\/$/, "")}/healthz`);
    checks.push(response.ok ? check("ok", "dispatcher health", input.config.dispatcherUrl) : check("fail", "dispatcher health", `${response.status}`));
  } catch (error) {
    checks.push(check("fail", "dispatcher health", error instanceof Error ? error.message : String(error)));
  }

  if (client) {
    try {
      const { runner } = await client.getRunner({ runnerId: input.config.runnerId });
      checks.push(check("ok", "runner registration", `${runner.runnerId} (${runner.name})`));
      checks.push(
        checkRunnerHeartbeat({
          ...(runner.heartbeatAt ? { heartbeatAt: runner.heartbeatAt } : {}),
          config: input.config,
          ...(input.now ? { now: input.now } : {})
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(check(message.includes("runner_not_found") ? "fail" : "warn", "runner registration", message));
    }
  } else {
    checks.push(check("fail", "runner registration", hostedAuthProblem ?? "Hosted runner authentication is invalid."));
  }

  checks.push(checkRunnerApiAuth(input.config));
  checks.push(...checkRunnerTokenRotation(input.config));

  if (!input.config.repositories.length) {
    const configuredAgentCount = Object.keys(input.config.agents ?? {}).length;
    checks.push(
      configuredAgentCount > 0
        ? check(
            "ok",
            "repository config",
            `${configuredAgentCount} configured agent${configuredAgentCount === 1 ? "" : "s"} support${configuredAgentCount === 1 ? "s" : ""} repository-free Runs.`
          )
        : check("fail", "repository config", "No repositories or agents are configured.")
    );
  }

  if (shouldCheckCodexConfig(input.config)) {
    checks.push(checkCodexConfig(input.codexConfigPath));
  }

  for (const repository of input.config.repositories) {
    checks.push(
      ...(await checkGitCheckout({
        repository,
        commandRunner,
        env,
        ...(input.executors[repository.defaultExecutor] ? { executor: input.executors[repository.defaultExecutor] } : {})
      }))
    );

    if (!client) {
      checks.push(check("fail", `${repository.owner}/${repository.repo} binding`, hostedAuthProblem ?? "Hosted runner authentication is invalid."));
      continue;
    }
    try {
      const { binding } = await client.getRepositoryBinding({
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo
      });
      checks.push(
        binding.runnerId === input.config.runnerId
          ? check("ok", `${repository.owner}/${repository.repo} binding`, `Bound to ${binding.runnerId}`)
          : check("fail", `${repository.owner}/${repository.repo} binding`, `Bound to ${binding.runnerId}, expected ${input.config.runnerId}`)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(check(message.includes("repo_binding_not_found") ? "warn" : "fail", `${repository.owner}/${repository.repo} binding`, message));
    }
  }

  const repositoryExecutorIds = new Set(input.config.repositories.map((repository) => repository.defaultExecutor));
  for (const agentId of Object.keys(input.config.agents ?? {})) {
    if (repositoryExecutorIds.has(agentId)) continue;
    const executor = input.executors[agentId];
    if (!executor) {
      checks.push(check("fail", `${agentId} configured agent`, "No local executor is configured with this id."));
      continue;
    }
    checks.push(check("ok", `${agentId} configured agent`, `${executor.displayName} (${executor.id})`));
    checks.push(
      executor.capability
        ? checkExecutorCapability(agentId, executor.capability)
        : check(
            "warn",
            `${agentId} capability`,
            "Executor does not declare a capability contract; readiness may be incomplete."
          )
    );
    if (executor.capability) {
      checks.push(...checkExecutorSecretRequirements({ capability: executor.capability, env }));
    }
  }

  for (const binding of normalizeChannelBindings(input.config)) {
    if (!client) {
      checks.push(
        check(
          "fail",
          `${binding.provider}:${binding.accountId}/${binding.conversationId} binding`,
          hostedAuthProblem ?? "Hosted runner authentication is invalid."
        )
      );
      continue;
    }
    try {
      const { binding: remoteBinding } = await client.getChannelBinding({
        provider: binding.provider,
        accountId: binding.accountId,
        conversationId: binding.conversationId
      });
      checks.push(
        remoteBinding.repoProvider === binding.repoProvider &&
        remoteBinding.owner === binding.owner &&
        remoteBinding.repo === binding.repo
          ? check(
              "ok",
              `${binding.provider}:${binding.accountId}/${binding.conversationId} binding`,
              `${remoteBinding.repoProvider}:${remoteBinding.owner}/${remoteBinding.repo}`
            )
          : check(
              "fail",
              `${binding.provider}:${binding.accountId}/${binding.conversationId} binding`,
              `Bound to ${remoteBinding.repoProvider}:${remoteBinding.owner}/${remoteBinding.repo}, expected ${binding.repoProvider}:${binding.owner}/${binding.repo}`
            )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(
        check(
          message.includes("channel_binding_not_found") ? "warn" : "fail",
          `${binding.provider}:${binding.accountId}/${binding.conversationId} binding`,
          message
        )
      );
    }
  }

  const githubApplyToken = input.config.githubApplyToken === null ? undefined : (input.config.githubApplyToken ?? input.config.githubToken);

  if (input.config.allowAutoCreatePullRequest) {
    checks.push(
      input.config.githubToken
        ? check("ok", "GitHub PR actions", "Configured for legacy immediate PR creation")
        : check("warn", "GitHub PR actions", "Immediate PR creation is enabled, but githubToken is not configured")
    );
  } else if (input.config.preparePullRequestBranch) {
    checks.push(
      githubApplyToken
        ? check("ok", "GitHub PR actions", "Configured for thread-native `apply 1` PR creation")
        : check(
            "warn",
            "GitHub PR actions",
            "Run branches can be pushed, but a GitHub apply token is required for direct `apply 1` PR creation"
          )
    );
  } else if (input.config.githubToken) {
    checks.push(check("warn", "GitHub PR actions", "githubToken is configured, but run branch preparation is disabled"));
  } else {
    checks.push(check("warn", "GitHub PR actions", "Not configured; PR creation actions will be skipped or fail"));
  }

  return checks;
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  return checks.map((item) => `${item.status.toUpperCase().padEnd(4)} ${item.name}: ${item.message}`).join("\n");
}

export function doctorHasFailures(checks: DoctorCheck[]): boolean {
  return checks.some((item) => item.status === "fail");
}
