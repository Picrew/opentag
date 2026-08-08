import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AdapterMutationMappingSchema,
  OpenTagManagedChannelBindingOwnershipSchema
} from "@opentag/core";
import {
  HostedControlRegistrationSchema,
  formatConfigError as formatDaemonConfigError,
  hostedRunnerAuthProblem,
  parseDaemonConfig,
  runnerDispatcherToken,
  type LocalDispatcherRuntimeInput,
  type OpenTagDaemonConfig
} from "@opentag/local-runtime";
import { z } from "zod";
import type { CliLanguage } from "./catalogs/languages.js";
import type { PlatformId } from "./catalogs/platforms.js";

// Executor ids (repository bindings and the last-used preference) accept any
// trimmed non-empty string so custom executors registered by a standalone runner
// validate; echo, codex, claude-code, cursor, opencode, hermes, and openclaw remain the documented built-ins.
// Mirrors the daemon config and the open runtime dispatch.
const ExecutorIdSchema = z.string().trim().min(1);
const KeepWorktreeSchema = z.enum(["always", "on_failure", "never"]);
const PositiveIntegerSchema = z.number().int().positive();
const CliLanguageSchema = z.enum(["en", "zh-CN"]);
const PlatformSchema = z.enum(["lark", "slack", "github", "gitlab", "linear", "telegram", "discord", "teams"]);
const LarkSetupMethodSchema = z.enum(["saved", "scan", "manual"]);
const SlackModeSchema = z.enum(["socket_mode", "events_api"]);
const TelegramModeSchema = z.enum(["polling", "webhook"]);
const DiscordModeSchema = z.enum(["gateway", "webhook"]);
const BindingMethodSchema = z.enum(["default_project", "bind_later"]);
const OptionalPortSchema = z.number().int().min(1).max(65535).optional();

export type GitHubCompletionPolicyConfig = NonNullable<LocalDispatcherRuntimeInput["completionPolicies"]>[number];

const GitHubCompletionPolicySchema = z
  .object({
    provider: z.literal("github"),
    owner: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    requiredChecks: z.array(z.string().trim().min(1)).min(1),
    baseBranch: z.string().trim().min(1).optional(),
    requireMerge: z.boolean().optional()
  })
  .strict()
  .transform(
    (policy): GitHubCompletionPolicyConfig => ({
      provider: policy.provider,
      owner: policy.owner,
      repo: policy.repo,
      requiredChecks: policy.requiredChecks,
      ...(policy.baseBranch !== undefined ? { baseBranch: policy.baseBranch } : {}),
      ...(policy.requireMerge !== undefined ? { requireMerge: policy.requireMerge } : {})
    })
  );

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
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
    throw new Error(
      `Secret keychain ref ${ref.service}/${ref.account} could not be resolved via macOS Keychain (/usr/bin/security). Keychain SecretRefs are only supported on macOS.${detail}`
    );
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

const RuntimeConfigSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("local")
    })
    .strict(),
  z
    .object({
      mode: z.literal("relay"),
      relayUrl: z.string().url(),
      relayProvider: z.string().min(1).optional()
    })
    .strict()
]);

const RepositoryBindingSchema = z
  .object({
    provider: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    checkoutPath: z.string().min(1),
    defaultExecutor: ExecutorIdSchema,
    baseBranch: z.string().min(1),
    pushRemote: z.string().min(1),
    worktreeRoot: z.string().min(1),
    keepWorktree: KeepWorktreeSchema
  })
  .strict();

const ChannelBindingSchema = z
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
  .strict()
  .superRefine((binding, context) => {
    const repositoryFields = [binding.repoProvider, binding.owner, binding.repo];
    const configuredCount = repositoryFields.filter((value) => value !== undefined).length;
    if (configuredCount !== 0 && configuredCount !== repositoryFields.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repoProvider"],
        message: "Channel binding repository fields repoProvider, owner, and repo must be provided together."
      });
    }
  });

const HermesSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    profile: z.string().trim().min(1).optional(),
    profileTemplate: z.string().trim().min(1).optional()
  })
  .strict();

const OpenClawSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    profile: z.string().trim().min(1).optional(),
    gatewayUrl: z.string().url().optional(),
    expectedVersion: z.string().trim().min(1).optional()
  })
  .strict();

const AgentSessionProfileSchema = z
  .object({
    profile: z.string().trim().min(1).optional(),
    profileTemplate: z.string().trim().min(1).optional()
  })
  .strict();

const SecuritySchema = z
  .object({
    mode: z.enum(["enforce", "audit", "off"]).optional(),
    allowedWorkspaceRoot: z.string().min(1).optional(),
    allowUnsafePrompts: z.boolean().optional(),
    extraSafeEnv: z.array(z.string().min(1)).optional()
  })
  .strict();

const AcpAgentSchema = z
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

const DaemonConfigSchema = z
  .object({
    runnerId: z.string().min(1),
    dispatcherUrl: z.string().url(),
    repositories: z.array(RepositoryBindingSchema).default([]),
    agents: z.record(z.string(), AcpAgentSchema).optional(),
    scratchRoot: z.string().min(1).optional(),
    keepScratch: KeepWorktreeSchema.optional(),
    approvalMode: z.enum(["ask", "auto", "autonomous"]).optional(),
    channelBindings: z.array(ChannelBindingSchema).optional(),
    hermes: HermesSchema.optional(),
    openclaw: OpenClawSchema.optional(),
    agentSessionProfile: AgentSessionProfileSchema.optional(),
    security: SecuritySchema.optional(),
    githubToken: SecretStringSchema.optional(),
    githubApplyToken: SecretStringSchema.nullable().optional(),
    completionPolicies: z.array(GitHubCompletionPolicySchema).optional(),
    defaultGitHubCompletion: z.enum(["governed", "compat"]).optional(),
    preparePullRequestBranch: z.boolean().optional(),
    allowAutoCreatePullRequest: z.boolean().optional(),
    runnerToken: SecretStringSchema.optional(),
    runnerTokens: z.array(SecretStringSchema).optional(),
    revokedRunnerTokenFingerprints: z.array(z.string().trim().min(1)).optional(),
    pairingToken: SecretStringSchema.optional(),
    controlRegistration: HostedControlRegistrationSchema.optional(),
    pollIntervalMs: PositiveIntegerSchema,
    heartbeatIntervalMs: PositiveIntegerSchema,
    runTimeoutMs: PositiveIntegerSchema.optional()
  })
  .strict();

const LarkPlatformSchema = z
  .object({
    appId: z.string().min(1),
    appSecret: SecretStringSchema,
    domain: z.enum(["lark", "feishu"]),
    botOpenId: z.string().min(1).optional(),
    defaultProjectBinding: z.boolean().optional()
  })
  .strict();

const SlackPlatformSchema = z
  .object({
    mode: SlackModeSchema.optional(),
    appToken: SecretStringSchema.optional(),
    signingSecret: SecretStringSchema.optional(),
    botToken: SecretStringSchema,
    teamId: z.string().min(1),
    channelId: z.string().min(1),
    appId: z.string().min(1).optional(),
    defaultProjectBinding: z.boolean().optional(),
    port: OptionalPortSchema
  })
  .strict()
  .superRefine((value, context) => {
    const mode = value.mode ?? "events_api";
    if (mode === "socket_mode" && !value.appToken) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appToken"],
        message: "Slack Socket Mode requires appToken."
      });
    }
    if (mode === "events_api" && !value.signingSecret) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signingSecret"],
        message: "Slack Events API requires signingSecret."
      });
    }
  });

const GitHubPlatformSchema = z
  .object({
    webhookSecret: SecretStringSchema,
    owner: z.string().min(1),
    repo: z.string().min(1),
    webhookPath: z.string().min(1).optional(),
    port: OptionalPortSchema
  })
  .strict();

const GitLabPlatformSchema = z
  .object({
    token: SecretStringSchema,
    webhookSecret: SecretStringSchema,
    projectPathWithNamespace: z.string().min(1),
    baseUrl: z.string().url(),
    webhookPath: z.string().min(1).optional(),
    port: OptionalPortSchema
  })
  .strict();

const LinearAuthSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("api_key")
    })
    .strict(),
  z
    .object({
      method: z.literal("oauth_app"),
      actor: z.literal("app"),
      clientId: z.string().min(1),
      clientSecret: SecretStringSchema.optional(),
      redirectUri: z.string().url().optional(),
      refreshToken: SecretStringSchema.optional(),
      accessTokenExpiresAt: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional()
    })
    .strict(),
  z
    .object({
      method: z.literal("hosted_oauth_app"),
      actor: z.literal("app"),
      installationId: z.string().min(1).optional(),
      authorizationUrl: z.string().url().optional(),
      stateExpiresAt: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional()
    })
    .strict()
]);

const LinearChannelSchema = z
  .object({
    teamId: z.string().trim().min(1),
    channelId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    connection: z.string().trim().min(1).optional()
  })
  .strict();

const LinearConnectionSchema = z
  .object({
    token: SecretStringSchema
  })
  .strict();

const LinearPlatformSchema = z
  .object({
    token: SecretStringSchema.optional(),
    auth: LinearAuthSchema.optional(),
    webhookSecret: SecretStringSchema.optional(),
    teamId: z.string().min(1).optional(),
    teamKey: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    channels: z.array(LinearChannelSchema).optional(),
    connections: z.record(z.string().trim().min(1), LinearConnectionSchema).optional(),
    graphqlUrl: z.string().url().optional(),
    webhookPath: z.string().min(1).optional(),
    port: OptionalPortSchema,
    mappings: z.array(AdapterMutationMappingSchema).optional(),
    projectTarget: z
      .object({
        repoProvider: z.string().min(1),
        owner: z.string().min(1),
        repo: z.string().min(1)
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    const seenChannels = new Set<string>();
    value.channels?.forEach((channel, index) => {
      const key = `${channel.teamId}\u0000${channel.channelId}`;
      if (seenChannels.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["channels", index],
          message: `Duplicate Linear channel mapping for ${channel.teamId}/${channel.channelId}.`
        });
      }
      seenChannels.add(key);
    });

    if (value.auth?.method === "hosted_oauth_app") return;

    const hasConnectionToken = Object.keys(value.connections ?? {}).length > 0;
    if (value.webhookSecret && !value.token) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["token"],
        message: "Linear webhook/apply configuration requires the top-level Linear token. connections.*.token is query-only."
      });
    } else if (!value.token && !hasConnectionToken) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["token"],
        message: "Linear token or connections.*.token is required unless auth.method is hosted_oauth_app."
      });
    }
    if (!value.webhookSecret && !value.projectId && !value.channels?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["webhookSecret"],
        message:
          "Linear webhookSecret is required unless auth.method is hosted_oauth_app or the config is query-only (projectId or channels set)."
      });
    }
  });

const TelegramPlatformSchema = z
  .object({
    mode: TelegramModeSchema.optional(),
    botId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    botUsername: z.string().min(1).optional(),
    botToken: SecretStringSchema,
    bindingAdminUserIds: z.array(z.string().min(1)).optional(),
    secretToken: SecretStringSchema.optional(),
    callbackUri: z.string().url().optional()
  })
  .strict();

const DiscordPlatformSchema = z
  .object({
    mode: DiscordModeSchema.optional(),
    publicKey: z.string().min(1).optional(),
    botToken: SecretStringSchema,
    webhookPath: z.string().min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const mode = value.mode ?? "gateway";
    if (mode === "webhook" && !value.publicKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publicKey"],
        message: "Discord webhook mode requires publicKey."
      });
    }
  });

const TeamsPlatformSchema = z
  .object({
    appId: z.string().min(1),
    appPassword: SecretStringSchema,
    tenantId: z.string().min(1).optional(),
    webhookPath: z.string().min(1).optional()
  })
  .strict();

const PreferencesSchema = z
  .object({
    language: CliLanguageSchema.optional(),
    lastSetup: z
      .object({
        platforms: z.array(PlatformSchema).optional(),
        executor: ExecutorIdSchema.optional(),
        projectPath: z.string().min(1).optional(),
        larkSetupMethod: LarkSetupMethodSchema.optional(),
        larkDomain: z.enum(["lark", "feishu"]).optional(),
        bindingMethod: BindingMethodSchema.optional(),
        slackMode: SlackModeSchema.optional(),
        slackTeamId: z.string().min(1).optional(),
        slackChannelId: z.string().min(1).optional(),
        slackPort: OptionalPortSchema,
        githubOwner: z.string().min(1).optional(),
        githubRepo: z.string().min(1).optional(),
        githubPort: OptionalPortSchema,
        githubAutoCreatePullRequest: z.boolean().optional(),
        gitlabProjectPathWithNamespace: z.string().min(1).optional(),
        gitlabBaseUrl: z.string().url().optional(),
        gitlabPort: OptionalPortSchema,
        linearAuth: z.enum(["api_key", "oauth_app"]).optional(),
        linearTeamId: z.string().min(1).optional(),
        linearTeamKey: z.string().min(1).optional(),
        linearPort: OptionalPortSchema,
        telegramMode: TelegramModeSchema.optional(),
        telegramBotId: z.string().min(1).optional(),
        telegramBotUsername: z.string().min(1).optional(),
        discordMode: DiscordModeSchema.optional(),
        discordWebhookPath: z.string().min(1).optional(),
        teamsTenantId: z.string().min(1).optional(),
        teamsWebhookPath: z.string().min(1).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const OpenTagCliConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z
      .object({
        directory: z.string().min(1),
        databasePath: z.string().min(1),
        worktreeRoot: z.string().min(1)
      })
      .strict(),
    runtime: RuntimeConfigSchema.optional(),
    preferences: PreferencesSchema.optional(),
    daemon: DaemonConfigSchema,
    platforms: z
      .object({
        lark: LarkPlatformSchema.optional(),
        slack: SlackPlatformSchema.optional(),
        github: GitHubPlatformSchema.optional(),
        gitlab: GitLabPlatformSchema.optional(),
        linear: LinearPlatformSchema.optional(),
        telegram: TelegramPlatformSchema.optional(),
        discord: DiscordPlatformSchema.optional(),
        teams: TeamsPlatformSchema.optional()
      })
      .strict()
  })
  .strict()
  .superRefine((config, context) => {
    if (!config.daemon.controlRegistration) {
      if (!config.daemon.pairingToken) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daemon", "pairingToken"],
          message: "Legacy OpenTag configuration requires daemon.pairingToken."
        });
      }
      return;
    }
    if (config.runtime?.mode !== "relay") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "mode"],
        message: "Hosted Control V1 configuration requires runtime.mode=relay."
      });
      return;
    }
    if (config.runtime.relayUrl !== config.daemon.dispatcherUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "relayUrl"],
        message: "Hosted Control V1 relayUrl must match daemon.dispatcherUrl."
      });
    }
  });

export type OpenTagCliConfig = Omit<z.infer<typeof OpenTagCliConfigSchema>, "daemon"> & {
  daemon: OpenTagDaemonConfig & {
    completionPolicies?: GitHubCompletionPolicyConfig[];
    defaultGitHubCompletion?: "governed" | "compat";
  };
};

export type OpenTagCliPreferences = NonNullable<OpenTagCliConfig["preferences"]>;
export type OpenTagCliLastSetup = NonNullable<OpenTagCliPreferences["lastSetup"]>;
export type OpenTagCliLanguage = CliLanguage;
export type OpenTagCliPlatform = PlatformId;
export type OpenTagCliExecutor = string;
export type OpenTagRuntimeMode = NonNullable<OpenTagCliConfig["runtime"]>["mode"];

export type PathEnvironment = Partial<
  Record<"OPENTAG_CONFIG_PATH" | "OPENTAG_CONFIG_HOME" | "OPENTAG_STATE_DIR" | "XDG_CONFIG_HOME" | "XDG_STATE_HOME", string>
>;

function configHome(env: PathEnvironment, home = homedir()): string {
  if (env.OPENTAG_CONFIG_HOME) return resolve(env.OPENTAG_CONFIG_HOME);
  if (env.XDG_CONFIG_HOME) return resolve(env.XDG_CONFIG_HOME, "opentag");
  return join(home, ".config", "opentag");
}

export function defaultConfigPath(env: PathEnvironment = process.env, home = homedir()): string {
  if (env.OPENTAG_CONFIG_PATH) return resolve(env.OPENTAG_CONFIG_PATH);
  return join(configHome(env, home), "config.json");
}

export function defaultStateDirectory(env: PathEnvironment = process.env, home = homedir()): string {
  if (env.OPENTAG_STATE_DIR) return resolve(env.OPENTAG_STATE_DIR);
  if (env.XDG_STATE_HOME) return resolve(env.XDG_STATE_HOME, "opentag");
  return join(home, ".local", "state", "opentag");
}

function formatPath(path: PropertyKey[]): string {
  return path.length ? path.map(String).join(".") : "config";
}

export function formatCliConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join("\n");
  }
  return formatDaemonConfigError(error);
}

export function parseCliConfig(value: unknown): OpenTagCliConfig {
  const parsed = OpenTagCliConfigSchema.parse(value);
  return {
    ...parsed,
    daemon: {
      ...parseDaemonConfig(parsed.daemon),
      ...(parsed.daemon.completionPolicies !== undefined
        ? { completionPolicies: parsed.daemon.completionPolicies }
        : {}),
      ...(parsed.daemon.defaultGitHubCompletion !== undefined
        ? { defaultGitHubCompletion: parsed.daemon.defaultGitHubCompletion }
        : {})
    }
  };
}

export { hostedRunnerAuthProblem, runnerDispatcherToken };

export function runtimeModeFromConfig(config: OpenTagCliConfig): OpenTagRuntimeMode {
  return config.runtime?.mode ?? "local";
}

export function relayUrlFromConfig(config: OpenTagCliConfig): string | undefined {
  return config.runtime?.mode === "relay" ? config.runtime.relayUrl : undefined;
}

export function readCliConfig(path = defaultConfigPath()): OpenTagCliConfig {
  assertPrivateConfigFile(path);
  return parseCliConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function ensurePrivateDirectory(
  path: string,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  const createdPath = filesystem.mkdir(path, { recursive: true, mode: 0o700 });
  if (createdPath) {
    filesystem.chmod(path, 0o700);
  }
}

export const CLI_CONFIG_DIRECTORY_DURABILITY =
  process.platform === "win32" ? "atomic_replace" : "directory_fsync";

export class CliConfigWriteOutcomeUnknownError extends Error {
  readonly code = "config_write_outcome_unknown";

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "CliConfigWriteOutcomeUnknownError";
  }
}

export type CliConfigFilesystemOps = {
  chmod(path: string, mode: number): void;
  close(file: number): void;
  fchmod(file: number, mode: number): void;
  fsync(file: number): void;
  lstat(path: string): {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
  };
  mkdir(path: string, options: { recursive: true; mode: number }): string | undefined;
  open(path: string, flags: string, mode?: number): number;
  readFile(path: string): string;
  rename(from: string, to: string): void;
  remove(path: string): void;
  stat(path: string): { mode: number };
  writeFile(
    target: string | number,
    contents: string,
    options: "utf8" | { mode: number; flag: string }
  ): void;
};

export const CLI_CONFIG_FILESYSTEM_OPS: CliConfigFilesystemOps = {
  chmod: chmodSync,
  close: closeSync,
  fchmod: fchmodSync,
  fsync: fsyncSync,
  lstat: lstatSync,
  mkdir: (path, options) => mkdirSync(path, options),
  open: openSync,
  readFile: (path) => readFileSync(path, "utf8"),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
  stat: statSync,
  writeFile: (target, contents, options) => writeFileSync(target, contents, options)
};

function combinedFailure(primary: unknown, cleanup: unknown, message: string): unknown {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined) return primary;
  return new AggregateError([primary, cleanup], message, { cause: primary });
}

function releaseConfigLock(
  lockPath: string,
  lockFile: number | undefined,
  filesystem: CliConfigFilesystemOps
): unknown {
  let cleanupError: unknown;
  if (lockFile !== undefined) {
    try {
      filesystem.close(lockFile);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    filesystem.remove(lockPath);
  } catch (error) {
    cleanupError = combinedFailure(cleanupError, error, "OpenTag config lock cleanup failed.");
  }
  try {
    fsyncDirectory(dirname(lockPath), filesystem);
  } catch (error) {
    cleanupError = combinedFailure(cleanupError, error, "OpenTag config lock cleanup failed.");
  }
  return cleanupError;
}

function configLockRecord(path: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    configPath: path,
    createdAt: new Date().toISOString()
  })}\n`;
}

const MAX_CONFIG_LOCK_RECORD_BYTES = 4_096;

function readableConfigLockRecord(lockPath: string, filesystem: CliConfigFilesystemOps): string {
  try {
    const stats = filesystem.lstat(lockPath);
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.size <= 0
      || stats.size > MAX_CONFIG_LOCK_RECORD_BYTES
    ) {
      throw new Error("invalid lock record file");
    }
    const raw = filesystem.readFile(lockPath).trim();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid lock record");
    }
    const record = parsed as Record<string, unknown>;
    const createdAt = record.createdAt;
    const keys = Object.keys(record).sort();
    if (
      keys.join("\u0000") !== ["configPath", "createdAt", "pid", "schemaVersion"].join("\u0000")
      || record.schemaVersion !== 1
      || typeof record.pid !== "number"
      || !Number.isSafeInteger(record.pid)
      || record.pid <= 0
      || typeof record.configPath !== "string"
      || record.configPath.length === 0
      || record.configPath.length > 4_096
      || typeof createdAt !== "string"
      || createdAt.length > 64
    ) {
      throw new Error("invalid lock record");
    }
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== createdAt) {
      throw new Error("invalid lock record");
    }
    return JSON.stringify({
      schemaVersion: 1,
      pid: record.pid,
      createdAt: new Date(createdAtMs).toISOString()
    });
  } catch {
    return JSON.stringify({ schemaVersion: 1, status: "unreadable_or_invalid" });
  }
}

function withCliConfigLock<T>(
  path: string,
  operation: () => T,
  filesystem: CliConfigFilesystemOps
): T {
  ensurePrivateDirectory(dirname(path), filesystem);
  const lockPath = `${path}.lock`;
  let lockFile: number | undefined;
  try {
    lockFile = filesystem.open(lockPath, "wx", 0o600);
    filesystem.fchmod(lockFile, 0o600);
    filesystem.writeFile(lockFile, configLockRecord(path), "utf8");
    filesystem.fsync(lockFile);
  } catch (error) {
    // If openSync failed with EEXIST, lockFile is undefined and the adjacent
    // lock belongs to another process. Never remove another writer's lock.
    const cleanupError =
      lockFile === undefined ? undefined : releaseConfigLock(lockPath, lockFile, filesystem);
    if (
      lockFile === undefined &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      const lockRecord = readableConfigLockRecord(lockPath, filesystem);
      throw new Error(
        `OpenTag config is locked by another writer at ${lockPath}. Lock record: ${lockRecord}. `
          + `Retry after that writer releases the lock. If the lock remains stale, verify the recorded process identity first; `
          + `only after confirming that exact writer is no longer running, manually delete the exact lock path ${JSON.stringify(lockPath)}. `
          + "OpenTag will not delete a lock based on PID alone.",
        { cause: combinedFailure(error, cleanupError, "OpenTag config lock acquisition failed.") }
      );
    }
    throw combinedFailure(error, cleanupError, "OpenTag config lock acquisition failed.");
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  const cleanupError = releaseConfigLock(lockPath, lockFile, filesystem);
  if (operationError !== undefined) {
    const failure = combinedFailure(
      operationError,
      cleanupError,
      "OpenTag config write and lock cleanup failed."
    );
    if (operationError instanceof CliConfigWriteOutcomeUnknownError) {
      if (cleanupError === undefined) throw operationError;
      throw new CliConfigWriteOutcomeUnknownError(operationError.message, failure);
    }
    throw failure;
  }
  if (cleanupError !== undefined) {
    throw new CliConfigWriteOutcomeUnknownError(
      "OpenTag config write completed, but releasing its writer lock could not be confirmed.",
      cleanupError
    );
  }
  return result as T;
}

function replaceConfigFileDurably(
  path: string,
  contents: string,
  validateReadback: (contents: string) => void,
  filesystem: CliConfigFilesystemOps
): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let tempFile: number | undefined;
  let renamed = false;
  try {
    tempFile = filesystem.open(tempPath, "wx", 0o600);
    filesystem.fchmod(tempFile, 0o600);
    filesystem.writeFile(tempFile, contents, "utf8");
    filesystem.fsync(tempFile);
    const fileToClose = tempFile;
    tempFile = undefined;
    filesystem.close(fileToClose);
    filesystem.rename(tempPath, path);
    renamed = true;
    fsyncDirectory(dirname(path), filesystem);
    validateReadback(filesystem.readFile(path));
  } catch (error) {
    let cleanupError: unknown;
    if (tempFile !== undefined) {
      const fileToClose = tempFile;
      tempFile = undefined;
      try {
        filesystem.close(fileToClose);
      } catch (closeError) {
        cleanupError = closeError;
      }
    }
    if (!renamed) {
      try {
        filesystem.remove(tempPath);
      } catch (removeError) {
        cleanupError = combinedFailure(
          cleanupError,
          removeError,
          "OpenTag temporary config cleanup failed."
        );
      }
    }
    const failure = combinedFailure(error, cleanupError, "OpenTag config write cleanup failed.");
    if (renamed) {
      throw new CliConfigWriteOutcomeUnknownError(
        "OpenTag config was replaced, but its durable readback could not be confirmed.",
        failure
      );
    }
    throw failure;
  }
}

export function writeCliConfigAtomic(
  path: string,
  config: OpenTagCliConfig,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  withCliConfigLock(path, () => {
    replaceConfigFileDurably(path, `${JSON.stringify(config, null, 2)}\n`, (contents) => {
      parseCliConfig(JSON.parse(contents));
    }, filesystem);
  }, filesystem);
}

export type HostedControlConfigPatch = {
  controlRegistration: NonNullable<OpenTagDaemonConfig["controlRegistration"]>;
  dispatcherUrl: string;
  relayProvider?: string;
  relayUrl: string;
  removePairingToken?: boolean;
  runnerToken?: string | null;
};

function requireRawConfigObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenTag config must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function fsyncDirectory(
  path: string,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  // Node does not expose a portable Windows directory-fsync primitive. Windows
  // therefore gets atomic replacement and readback, but not the POSIX crash-
  // durability claim represented by CLI_CONFIG_DIRECTORY_DURABILITY.
  if (CLI_CONFIG_DIRECTORY_DURABILITY === "atomic_replace") return;
  const directory = filesystem.open(path, "r");
  let fsyncError: unknown;
  try {
    filesystem.fsync(directory);
  } catch (error) {
    fsyncError = error;
  }
  let closeError: unknown;
  try {
    filesystem.close(directory);
  } catch (error) {
    closeError = error;
  }
  const failure = combinedFailure(
    fsyncError,
    closeError,
    "OpenTag directory fsync and close both failed."
  );
  if (failure !== undefined) throw failure;
}

const RawSecretValueSchema = z.union([z.string().min(1), SecretRefSchema]);

const RAW_SECRET_STRING_PATHS = [
  ["daemon", "githubToken"],
  ["daemon", "githubApplyToken"],
  ["daemon", "runnerToken"],
  ["daemon", "runnerTokens", "*"],
  ["daemon", "pairingToken"],
  ["platforms", "lark", "appSecret"],
  ["platforms", "slack", "appToken"],
  ["platforms", "slack", "signingSecret"],
  ["platforms", "slack", "botToken"],
  ["platforms", "github", "webhookSecret"],
  ["platforms", "gitlab", "token"],
  ["platforms", "gitlab", "webhookSecret"],
  ["platforms", "linear", "token"],
  ["platforms", "linear", "auth", "clientSecret"],
  ["platforms", "linear", "auth", "refreshToken"],
  ["platforms", "linear", "connections", "*", "token"],
  ["platforms", "linear", "webhookSecret"],
  ["platforms", "telegram", "botToken"],
  ["platforms", "telegram", "secretToken"],
  ["platforms", "discord", "botToken"],
  ["platforms", "teams", "appPassword"]
] as const satisfies readonly (readonly string[])[];

function replaceKnownRawSecretField(
  value: unknown,
  path: readonly string[],
  index = 0
): unknown {
  if (index === path.length) {
    if (value === null || value === undefined) return value;
    RawSecretValueSchema.parse(value);
    return "raw-secret-ref";
  }
  const segment = path[index]!;
  if (segment === "*") {
    if (Array.isArray(value)) {
      return value.map((entry) => replaceKnownRawSecretField(entry, path, index + 1));
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceKnownRawSecretField(entry, path, index + 1)
      ])
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!(segment in record)) return value;
  return {
    ...record,
    [segment]: replaceKnownRawSecretField(record[segment], path, index + 1)
  };
}

function replaceKnownRawSecretFields(value: unknown): unknown {
  return RAW_SECRET_STRING_PATHS.reduce(
    (projected, path) => replaceKnownRawSecretField(projected, path),
    value
  );
}

export const OpenTagCliRawConfigSchema = z.preprocess(
  replaceKnownRawSecretFields,
  OpenTagCliConfigSchema
);

function validateHostedControlRawConfig(value: unknown): void {
  const raw = requireRawConfigObject(value);
  OpenTagCliRawConfigSchema.parse(raw);
  const runtime = RuntimeConfigSchema.parse(raw.runtime);
  if (runtime.mode !== "relay") {
    throw new Error("Hosted Control V1 config requires runtime.mode=relay.");
  }
  const daemon = requireRawConfigObject(raw.daemon);
  const dispatcherUrl = z.string().url().parse(daemon.dispatcherUrl);
  if (runtime.relayUrl !== dispatcherUrl) {
    throw new Error("Hosted Control V1 relayUrl must match daemon.dispatcherUrl.");
  }
  HostedControlRegistrationSchema.parse(daemon.controlRegistration);
  if (daemon.runnerToken !== undefined) {
    z.string().min(1).parse(daemon.runnerToken);
  }
  if (daemon.pairingToken !== undefined) {
    RawSecretValueSchema.parse(daemon.pairingToken);
  }
}

export function writeHostedControlConfigAtomic(
  path: string,
  patch: HostedControlConfigPatch,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  withCliConfigLock(path, () => {
    assertPrivateConfigFile(path, filesystem);
    const raw = requireRawConfigObject(JSON.parse(filesystem.readFile(path)));
    const daemon = requireRawConfigObject(raw.daemon);
    const patchedDaemon: Record<string, unknown> = {
      ...daemon,
      dispatcherUrl: patch.dispatcherUrl,
      controlRegistration: patch.controlRegistration
    };
    if (patch.removePairingToken) delete patchedDaemon.pairingToken;
    if (patch.runnerToken === null) delete patchedDaemon.runnerToken;
    else if (patch.runnerToken !== undefined) patchedDaemon.runnerToken = patch.runnerToken;

    const patched: Record<string, unknown> = {
      ...raw,
      runtime: {
        mode: "relay",
        relayUrl: patch.relayUrl,
        ...(patch.relayProvider ? { relayProvider: patch.relayProvider } : {})
      },
      daemon: patchedDaemon
    };
    validateHostedControlRawConfig(patched);
    replaceConfigFileDurably(path, `${JSON.stringify(patched, null, 2)}\n`, (contents) => {
      validateHostedControlRawConfig(JSON.parse(contents));
    }, filesystem);
  }, filesystem);
}

export function assertPrivateConfigFile(
  path: string,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  if (process.platform === "win32") return;
  const mode = filesystem.stat(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`OpenTag config contains secrets and must not be readable by group or others: ${path}\nFix it with: chmod 600 ${path}`);
  }
}

function redactSecretValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ref = value as { account?: unknown; kind?: unknown; name?: unknown; path?: unknown; service?: unknown };
    if (ref.kind === "env" && typeof ref.name === "string") {
      return `[env:${ref.name}]`;
    }
    if (ref.kind === "file" && typeof ref.path === "string") {
      return `[file:${ref.path}]`;
    }
    if (ref.kind === "keychain" && typeof ref.service === "string" && typeof ref.account === "string") {
      return `[keychain:${ref.service}/${ref.account}]`;
    }
  }
  return "[REDACTED]";
}

function redactValue(key: string, value: unknown): unknown {
  if (key === "runnerTokens" && Array.isArray(value)) {
    return value.map((entry) => redactSecretValue(entry));
  }
  if (
    [
      "appPassword",
      "appSecret",
      "appToken",
      "botToken",
      "clientSecret",
      "githubToken",
      "githubApplyToken",
      "refreshToken",
      "runnerToken",
      "runnerTokens",
      "pairingToken",
      "secretToken",
      "signingSecret",
      "token",
      "webhookSecret"
    ].includes(key)
  ) {
    return redactSecretValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue("", entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryKey, entryValue)]));
  }
  return value;
}

export function redactedCliConfig(config: OpenTagCliConfig): unknown {
  return redactValue("", config);
}

export function redactedCliConfigValue(value: unknown): unknown {
  return redactValue("", value);
}

export function readRedactedCliConfig(path = defaultConfigPath()): unknown {
  assertPrivateConfigFile(path);
  return redactedCliConfigValue(JSON.parse(readFileSync(path, "utf8")));
}
