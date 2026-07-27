import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AdapterMutationMappingSchema,
  OpenTagManagedChannelBindingOwnershipSchema
} from "@opentag/core";
import {
  formatConfigError as formatDaemonConfigError,
  parseDaemonConfig,
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
    agents: z.record(AcpAgentSchema).optional(),
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
    preparePullRequestBranch: z.boolean().optional(),
    allowAutoCreatePullRequest: z.boolean().optional(),
    runnerToken: SecretStringSchema.optional(),
    runnerTokens: z.array(SecretStringSchema).optional(),
    revokedRunnerTokenFingerprints: z.array(z.string().trim().min(1)).optional(),
    pairingToken: SecretStringSchema,
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
  .strict();

export type OpenTagCliConfig = Omit<z.infer<typeof OpenTagCliConfigSchema>, "daemon"> & {
  daemon: OpenTagDaemonConfig & { completionPolicies?: GitHubCompletionPolicyConfig[] };
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

function formatPath(path: Array<string | number>): string {
  return path.length ? path.join(".") : "config";
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
        : {})
    }
  };
}

export function runnerDispatcherToken(config: Pick<OpenTagDaemonConfig, "runnerToken" | "pairingToken">): string | undefined {
  return config.runnerToken ?? config.pairingToken;
}

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

export function ensurePrivateDirectory(path: string): void {
  const createdPath = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (createdPath) {
    chmodSync(path, 0o700);
  }
}

export function writeCliConfigAtomic(path: string, config: OpenTagCliConfig): void {
  ensurePrivateDirectory(dirname(path));
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function assertPrivateConfigFile(path: string): void {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
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
