import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { OpenTagManagedChannelBindingOwnershipSchema } from "@opentag/core";
import { z } from "zod/v3";

const BUILT_IN_EXECUTOR_IDS = ["echo", "codex", "claude-code", "cursor", "opencode", "hermes", "openclaw"] as const;

// Accept any trimmed non-empty executor id. Custom executors registered by a
// standalone runner are valid, but daemon ACP agents cannot replace built-ins.
const ExecutorSchema = z.string().trim().min(1);
const KeepWorktreeSchema = z.enum(["always", "on_failure", "never"]);
const PositiveIntegerSchema = z.number().int().positive();

function defaultLocalStateDirectory(): string {
  if (process.env.OPENTAG_STATE_DIR) return resolve(process.env.OPENTAG_STATE_DIR);
  if (process.env.XDG_STATE_HOME) return resolve(process.env.XDG_STATE_HOME, "opentag");
  return join(homedir(), ".local", "state", "opentag");
}

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, "Path must be absolute.");

const SecretRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("env"),
      name: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      path: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("keychain"),
      service: z.string().trim().min(1),
      account: z.string().trim().min(1)
    })
    .strict()
]);

export type SecretRef = z.infer<typeof SecretRefSchema>;
export type KeychainSecretRef = Extract<SecretRef, { kind: "keychain" }>;

type ExecFileSyncLike = (file: string, args: readonly string[], options: { encoding: "utf8" }) => string | Buffer;

function requireResolvedSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Secret ${label} resolved to an empty value.`);
  }
  return trimmed;
}

export function readKeychainSecret(ref: KeychainSecretRef, execFileSyncImpl: ExecFileSyncLike = execFileSync): string {
  let value: string | Buffer;
  try {
    value = execFileSyncImpl(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", ref.service, "-a", ref.account],
      { encoding: "utf8" }
    );
  } catch {
    throw new Error(`Secret keychain ref ${ref.service}/${ref.account} could not be resolved.`);
  }
  return requireResolvedSecret(String(value), `keychain ref ${ref.service}/${ref.account}`);
}

function resolveSecretRef(ref: SecretRef): string {
  if (ref.kind === "env") {
    const value = process.env[ref.name];
    if (!value) {
      throw new Error(`Secret env ref ${ref.name} is not set.`);
    }
    return requireResolvedSecret(value, `env ref ${ref.name}`);
  }
  if (ref.kind === "file") {
    let value: string;
    try {
      value = readFileSync(ref.path, "utf8");
    } catch {
      throw new Error(`Secret file ref ${ref.path} could not be resolved.`);
    }
    return requireResolvedSecret(value, `file ref ${ref.path}`);
  }
  return readKeychainSecret(ref);
}

const SecretStringSchema = z.union([z.string().min(1), SecretRefSchema]).transform((value) => {
  return typeof value === "string" ? value : resolveSecretRef(value);
});

const HermesAcpConfigSchema = z.object({
  command: z.string().trim().min(1).optional(),
  profile: z.string().trim().min(1).optional(),
  profileTemplate: z.string().trim().min(1).optional()
});

const OpenClawAcpConfigSchema = z.object({
  command: z.string().trim().min(1).optional(),
  profile: z.string().trim().min(1).optional(),
  gatewayUrl: z.string().url().optional(),
  expectedVersion: z.string().trim().min(1).optional()
});

const AgentSessionProfileConfigSchema = z.object({
  profile: z.string().trim().min(1).optional(),
  profileTemplate: z.string().trim().min(1).optional()
});

const RunnerSecurityPolicySchema = z.object({
  mode: z.enum(["enforce", "audit", "off"]).optional(),
  allowedWorkspaceRoot: z.string().min(1).optional(),
  allowUnsafePrompts: z.boolean().optional(),
  extraSafeEnv: z.array(z.string().min(1)).optional()
});

export const AcpAgentConfigSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().trim().min(1).optional(),
    workspaceCwd: z.literal("required"),
    sessionModeId: z.string().trim().min(1).optional(),
    supportsProfile: z.boolean().default(false),
    supportsCancel: z.boolean().default(false),
    readinessTimeoutMs: PositiveIntegerSchema.optional()
  })
  .strict();

export const RepositoryBindingConfigSchema = z.object({
  provider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1),
  checkoutPath: z.string().min(1),
  defaultExecutor: ExecutorSchema.default("echo"),
  baseBranch: z.string().min(1).default("main"),
  pushRemote: z.string().min(1).default("origin"),
  worktreeRoot: z.string().min(1).optional(),
  keepWorktree: KeepWorktreeSchema.default("on_failure")
});

export const SlackChannelBindingConfigSchema = z.object({
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1)
});

export const ChannelBindingConfigSchema = z
  .object({
    provider: z.string().min(1),
    accountId: z.string().min(1),
    conversationId: z.string().min(1),
    repoProvider: z.string().min(1).optional(),
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    ownership: OpenTagManagedChannelBindingOwnershipSchema.optional()
  })
  .superRefine((binding, ctx) => {
    const present = [binding.repoProvider, binding.owner, binding.repo].filter((value) => value !== undefined).length;
    if (present !== 0 && present !== 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repoProvider"],
        message: "Channel binding repository fields repoProvider, owner, and repo must be provided together."
      });
    }
  });

export const LarkChannelBindingConfigSchema = z.object({
  tenantKey: z.string().min(1),
  chatId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1)
});

export const OpenTagDaemonConfigSchema = z
  .object({
    runnerId: z.string().min(1).default("runner_local"),
    dispatcherUrl: z.string().url().default("http://localhost:3030"),
    repositories: z.array(RepositoryBindingConfigSchema).default([]),
    agents: z.record(AcpAgentConfigSchema).default({}),
    scratchRoot: AbsolutePathSchema.default(() => join(defaultLocalStateDirectory(), "scratch")),
    keepScratch: KeepWorktreeSchema.default("on_failure"),
    approvalMode: z.enum(["ask", "auto", "autonomous"]).default("auto"),
    channelBindings: z.array(ChannelBindingConfigSchema).optional(),
    slackChannels: z.array(SlackChannelBindingConfigSchema).optional(),
    larkChannels: z.array(LarkChannelBindingConfigSchema).optional(),
    // Reject removed direct-adapter config instead of silently stripping it from the non-strict daemon schema.
    claudeCode: z.never().optional(),
    hermes: HermesAcpConfigSchema.optional(),
    openclaw: OpenClawAcpConfigSchema.optional(),
    agentSessionProfile: AgentSessionProfileConfigSchema.optional(),
    security: RunnerSecurityPolicySchema.optional(),
    githubToken: SecretStringSchema.optional(),
    githubApplyToken: SecretStringSchema.nullable().optional(),
    preparePullRequestBranch: z.boolean().optional(),
    allowAutoCreatePullRequest: z.boolean().optional(),
    runnerToken: SecretStringSchema.optional(),
    runnerTokens: z.array(SecretStringSchema).optional(),
    revokedRunnerTokenFingerprints: z.array(z.string().trim().min(1)).optional(),
    pairingToken: SecretStringSchema.optional(),
    pollIntervalMs: PositiveIntegerSchema.default(5000),
    heartbeatIntervalMs: PositiveIntegerSchema.default(15000),
    runTimeoutMs: PositiveIntegerSchema.optional()
  })
  .superRefine((config, ctx) => {
    for (const name of Object.keys(config.agents)) {
      if (BUILT_IN_EXECUTOR_IDS.some((executorId) => executorId === name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", name],
          message: `Configured ACP agent '${name}' cannot replace the built-in executor with the same id.`
        });
      }
    }
  });

export type RepositoryBindingConfig = z.infer<typeof RepositoryBindingConfigSchema>;
export type ChannelBindingConfig = z.infer<typeof ChannelBindingConfigSchema>;
export type SlackChannelBindingConfig = z.infer<typeof SlackChannelBindingConfigSchema>;
export type LarkChannelBindingConfig = z.infer<typeof LarkChannelBindingConfigSchema>;
export type AgentSessionProfileConfig = z.infer<typeof AgentSessionProfileConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
export type OpenTagDaemonConfig = z.infer<typeof OpenTagDaemonConfigSchema>;

function channelBindingIdentity(binding: Pick<ChannelBindingConfig, "provider" | "accountId" | "conversationId">): string {
  return JSON.stringify([binding.provider, binding.accountId, binding.conversationId]);
}

function formatChannelBindingIdentity(binding: Pick<ChannelBindingConfig, "provider" | "accountId" | "conversationId">): string {
  return `${binding.provider}:${binding.accountId}/${binding.conversationId}`;
}

function sameChannelBindingTarget(left: ChannelBindingConfig, right: ChannelBindingConfig): boolean {
  return left.repoProvider === right.repoProvider
    && left.owner === right.owner
    && left.repo === right.repo
    && JSON.stringify(left.ownership) === JSON.stringify(right.ownership);
}

function formatChannelBindingTarget(binding: ChannelBindingConfig): string {
  return binding.repoProvider && binding.owner && binding.repo
    ? `${binding.repoProvider}:${binding.owner}/${binding.repo}`
    : "no repository target";
}

export function normalizeChannelBindings(config: OpenTagDaemonConfig): ChannelBindingConfig[] {
  const bindings: ChannelBindingConfig[] = [...(config.channelBindings ?? [])];

  for (const binding of config.slackChannels ?? []) {
    bindings.push({
      provider: "slack",
      accountId: binding.teamId,
      conversationId: binding.channelId,
      repoProvider: binding.repoProvider,
      owner: binding.owner,
      repo: binding.repo
    });
  }

  for (const binding of config.larkChannels ?? []) {
    bindings.push({
      provider: "lark",
      accountId: binding.tenantKey,
      conversationId: binding.chatId,
      repoProvider: binding.repoProvider,
      owner: binding.owner,
      repo: binding.repo
    });
  }

  const normalized = new Map<string, ChannelBindingConfig>();
  for (const binding of bindings) {
    const key = channelBindingIdentity(binding);
    const existing = normalized.get(key);
    if (existing && !sameChannelBindingTarget(existing, binding)) {
      throw new Error(
        `Conflicting channel binding for ${formatChannelBindingIdentity(binding)}: ${formatChannelBindingTarget(existing)} and ${formatChannelBindingTarget(binding)}`
      );
    }
    if (!existing) {
      normalized.set(key, binding);
    }
  }

  return [...normalized.values()];
}

export type InitConfigInput = {
  runnerId?: string;
  dispatcherUrl?: string;
  pairingToken?: string;
  runnerToken?: string;
  owner: string;
  repo: string;
  checkoutPath: string;
  executor?: string;
  baseBranch?: string;
  pushRemote?: string;
  worktreeRoot?: string;
  keepWorktree?: string;
};

function parseNumberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function stringListFromJsonEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  const values = parsed.map((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${name}[${index}] must be a non-empty string.`);
    }
    return value.trim();
  });
  return values.length ? values : undefined;
}

function formatPath(path: Array<string | number>): string {
  return path.length ? path.join(".") : "config";
}

export function formatConfigError(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }

  return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join("\n");
}

export function parseDaemonConfig(value: unknown): OpenTagDaemonConfig {
  const parsed = OpenTagDaemonConfigSchema.parse(value);
  normalizeChannelBindings(parsed);
  return parsed;
}

export function runnerDispatcherToken(config: Pick<OpenTagDaemonConfig, "runnerToken" | "pairingToken">): string | undefined {
  return config.runnerToken ?? config.pairingToken;
}

export function createInitialConfig(input: InitConfigInput): OpenTagDaemonConfig {
  return parseDaemonConfig({
    runnerId: input.runnerId ?? "runner_local",
    dispatcherUrl: input.dispatcherUrl ?? "http://localhost:3030",
    ...(input.pairingToken ? { pairingToken: input.pairingToken } : {}),
    ...(input.runnerToken ? { runnerToken: input.runnerToken } : {}),
    repositories: [
      {
        provider: "github",
        owner: input.owner,
        repo: input.repo,
        checkoutPath: input.checkoutPath,
        defaultExecutor: input.executor ?? "echo",
        baseBranch: input.baseBranch ?? "main",
        pushRemote: input.pushRemote ?? "origin",
        ...(input.worktreeRoot ? { worktreeRoot: input.worktreeRoot } : {}),
        keepWorktree: input.keepWorktree ?? "on_failure"
      }
    ]
  });
}

function assertNoLegacyClaudeDirectEnvironment(): void {
  const configured = [
    "OPENTAG_CLAUDE_COMMAND",
    "OPENTAG_CLAUDE_MODEL",
    "OPENTAG_CLAUDE_PERMISSION_MODE",
    "OPENTAG_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS"
  ].filter((name) => process.env[name] !== undefined);
  if (configured.length > 0) {
    throw new Error(
      `${configured.join(", ")} configure the removed Claude direct adapter. Claude Code now uses the Registry-backed ACP launch; remove these variables.`
    );
  }
}

function extraSafeEnvFromEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const names = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return names.length > 0 ? names : undefined;
}

export function loadConfigFromEnv(): OpenTagDaemonConfig {
  assertNoLegacyClaudeDirectEnvironment();
  const configPath = process.env.OPENTAG_CONFIG_PATH;
  if (configPath) {
    return parseDaemonConfig(JSON.parse(readFileSync(configPath, "utf8")));
  }

  const owner = process.env.OPENTAG_REPO_OWNER;
  const repo = process.env.OPENTAG_REPO_NAME;
  const checkoutPath = process.env.OPENTAG_WORKSPACE_PATH;
  const repositoryProvider = process.env.OPENTAG_REPO_PROVIDER ?? process.env.OPENTAG_SLACK_REPO_PROVIDER ?? "github";
  const runnerTokens = stringListFromJsonEnv("OPENTAG_RUNNER_TOKENS_JSON");
  const revokedRunnerTokenFingerprints = stringListFromJsonEnv("OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON");
  const repositories =
    owner && repo && checkoutPath
      ? [
          {
            provider: repositoryProvider,
            owner,
            repo,
            checkoutPath,
            defaultExecutor: process.env.OPENTAG_DEFAULT_EXECUTOR ?? "echo",
            baseBranch: process.env.OPENTAG_BASE_BRANCH ?? "main",
            pushRemote: process.env.OPENTAG_PUSH_REMOTE ?? "origin",
            ...(process.env.OPENTAG_WORKTREE_ROOT ? { worktreeRoot: process.env.OPENTAG_WORKTREE_ROOT } : {}),
            keepWorktree: process.env.OPENTAG_KEEP_WORKTREE ?? "on_failure"
          }
        ]
      : [];

  const config = {
    runnerId: process.env.OPENTAG_RUNNER_ID ?? "runner_local",
    dispatcherUrl: process.env.OPENTAG_DISPATCHER_URL ?? "http://localhost:3030",
    repositories,
    ...(process.env.OPENTAG_SLACK_TEAM_ID && process.env.OPENTAG_SLACK_CHANNEL_ID && owner && repo
      ? {
          slackChannels: [
            {
              teamId: process.env.OPENTAG_SLACK_TEAM_ID,
              channelId: process.env.OPENTAG_SLACK_CHANNEL_ID,
              repoProvider: repositoryProvider,
              owner,
              repo
            }
          ]
        }
      : {}),
    ...(process.env.OPENTAG_LARK_TENANT_KEY && process.env.OPENTAG_LARK_CHAT_ID && owner && repo
      ? {
          larkChannels: [
            {
              tenantKey: process.env.OPENTAG_LARK_TENANT_KEY,
              chatId: process.env.OPENTAG_LARK_CHAT_ID,
              repoProvider: repositoryProvider,
              owner,
              repo
            }
          ]
        }
      : {}),
    ...(process.env.OPENTAG_HERMES_COMMAND || process.env.OPENTAG_HERMES_PROFILE || process.env.OPENTAG_HERMES_PROFILE_TEMPLATE
      ? {
          hermes: {
            ...(process.env.OPENTAG_HERMES_COMMAND ? { command: process.env.OPENTAG_HERMES_COMMAND } : {}),
            ...(process.env.OPENTAG_HERMES_PROFILE ? { profile: process.env.OPENTAG_HERMES_PROFILE } : {}),
            ...(process.env.OPENTAG_HERMES_PROFILE_TEMPLATE ? { profileTemplate: process.env.OPENTAG_HERMES_PROFILE_TEMPLATE } : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_OPENCLAW_COMMAND || process.env.OPENTAG_OPENCLAW_PROFILE || process.env.OPENTAG_OPENCLAW_GATEWAY_URL || process.env.OPENTAG_OPENCLAW_EXPECTED_VERSION
      ? {
          openclaw: {
            ...(process.env.OPENTAG_OPENCLAW_COMMAND ? { command: process.env.OPENTAG_OPENCLAW_COMMAND } : {}),
            ...(process.env.OPENTAG_OPENCLAW_PROFILE ? { profile: process.env.OPENTAG_OPENCLAW_PROFILE } : {}),
            ...(process.env.OPENTAG_OPENCLAW_GATEWAY_URL ? { gatewayUrl: process.env.OPENTAG_OPENCLAW_GATEWAY_URL } : {}),
            ...(process.env.OPENTAG_OPENCLAW_EXPECTED_VERSION ? { expectedVersion: process.env.OPENTAG_OPENCLAW_EXPECTED_VERSION } : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_AGENT_PROFILE || process.env.OPENTAG_AGENT_PROFILE_TEMPLATE
      ? {
          agentSessionProfile: {
            ...(process.env.OPENTAG_AGENT_PROFILE ? { profile: process.env.OPENTAG_AGENT_PROFILE } : {}),
            ...(process.env.OPENTAG_AGENT_PROFILE_TEMPLATE ? { profileTemplate: process.env.OPENTAG_AGENT_PROFILE_TEMPLATE } : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_SECURITY_MODE ||
    process.env.OPENTAG_ALLOWED_WORKSPACE_ROOT ||
    process.env.OPENTAG_ALLOW_UNSAFE_PROMPTS ||
    process.env.OPENTAG_EXTRA_SAFE_ENV
      ? {
          security: {
            ...(process.env.OPENTAG_SECURITY_MODE
              ? { mode: process.env.OPENTAG_SECURITY_MODE as "enforce" | "audit" | "off" }
              : {}),
            ...(process.env.OPENTAG_ALLOWED_WORKSPACE_ROOT
              ? { allowedWorkspaceRoot: process.env.OPENTAG_ALLOWED_WORKSPACE_ROOT }
              : {}),
            ...(process.env.OPENTAG_ALLOW_UNSAFE_PROMPTS
              ? { allowUnsafePrompts: process.env.OPENTAG_ALLOW_UNSAFE_PROMPTS === "true" }
              : {}),
            ...(extraSafeEnvFromEnv(process.env.OPENTAG_EXTRA_SAFE_ENV)
              ? { extraSafeEnv: extraSafeEnvFromEnv(process.env.OPENTAG_EXTRA_SAFE_ENV) }
              : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_GITHUB_TOKEN ? { githubToken: process.env.OPENTAG_GITHUB_TOKEN } : {}),
    ...(process.env.OPENTAG_GITHUB_APPLY_DISABLED === "true"
      ? { githubApplyToken: null }
      : process.env.OPENTAG_GITHUB_APPLY_TOKEN
        ? { githubApplyToken: process.env.OPENTAG_GITHUB_APPLY_TOKEN }
        : {}),
    ...(process.env.OPENTAG_PREPARE_PR_BRANCH ? { preparePullRequestBranch: process.env.OPENTAG_PREPARE_PR_BRANCH === "true" } : {}),
    ...(process.env.OPENTAG_ALLOW_AUTO_CREATE_PR ? { allowAutoCreatePullRequest: process.env.OPENTAG_ALLOW_AUTO_CREATE_PR === "true" } : {}),
    ...(process.env.OPENTAG_PAIRING_TOKEN ? { pairingToken: process.env.OPENTAG_PAIRING_TOKEN } : {}),
    ...(process.env.OPENTAG_RUNNER_TOKEN ? { runnerToken: process.env.OPENTAG_RUNNER_TOKEN } : {}),
    ...(runnerTokens ? { runnerTokens } : {}),
    ...(revokedRunnerTokenFingerprints ? { revokedRunnerTokenFingerprints } : {}),
    ...(process.env.OPENTAG_POLL_INTERVAL_MS ? { pollIntervalMs: parseNumberFromEnv("OPENTAG_POLL_INTERVAL_MS") } : {}),
    ...(process.env.OPENTAG_HEARTBEAT_INTERVAL_MS
      ? { heartbeatIntervalMs: parseNumberFromEnv("OPENTAG_HEARTBEAT_INTERVAL_MS") }
      : {}),
    ...(process.env.OPENTAG_RUN_TIMEOUT_MS ? { runTimeoutMs: parseNumberFromEnv("OPENTAG_RUN_TIMEOUT_MS") } : {})
  };
  return parseDaemonConfig(config);
}
