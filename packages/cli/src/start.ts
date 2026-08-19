import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import {
  createOpenTagClient,
  createDispatcherAdminClient,
  type ChannelBindingInput,
  type CreateLinearOAuthInstallationInput,
  type LinearOAuthInstallationStart,
  type LinearRelayInstallationInput,
  type RepositoryBindingConfig
} from "@opentag/client";
import type { AdapterMutationMapping } from "@opentag/core";
import {
  resolveGitHubSourceApiOrigin,
  startGitHubIngress,
  type GitHubIngressConfig,
  type GitHubIngressHandle
} from "@opentag/github";
import { startGitLabIngress, type GitLabIngressConfig, type GitLabIngressHandle } from "@opentag/gitlab";
import { DEFAULT_AGENT_ID, startLarkIngress, type LarkIngressConfig, type LarkIngressHandle } from "@opentag/lark";
import {
  DEFAULT_LINEAR_COMMENT_RUN_DEFER_MS,
  refreshLinearOAuthToken,
  startLinearIngress,
  type LinearIngressConfig,
  type LinearIngressHandle,
  type LinearOAuthTokenResponse
} from "@opentag/linear";
import {
  createDaemonRuntimeInput,
  dispatcherRuntimeHardeningInputFromEnv,
  getUnifiedDeliveryActivationState,
  hermesProfileConfigurationWarning,
  normalizeChannelBindings,
  reassessmentObligationTestRuntimeInputFromEnv,
  executorsFromConfig,
  runnerExecutorRegistrations,
  serveDaemon,
  startDispatcher,
  type LocalDispatcherRuntimeInput
} from "@opentag/local-runtime";
import {
  startSlackIngress,
  startSlackSocketModeIngress,
  type SlackEventsApiIngressConfig,
  type SlackIngressHandle,
  type SlackSocketModeIngressConfig,
  type SlackSocketModeIngressHandle
} from "@opentag/slack";
import {
  defaultConfigPath,
  ensurePrivateDirectory,
  hostedRunnerAuthProblem,
  readCliConfig,
  relayUrlFromConfig,
  runtimeModeFromConfig,
  writeCliConfigAtomic,
  type OpenTagCliConfig
} from "./config.js";
import { probeDispatcherHealth } from "./health.js";
import { linearBacklogConfigDiagnostics } from "./linear-backlog-config.js";
import { discordLocalInteractionsUrl, discordPublicInteractionsUrlPlaceholder } from "./platforms/discord/display.js";
import { githubLocalWebhookUrl, githubPublicWebhookUrlPlaceholder, githubWebhooksSettingsUrl } from "./platforms/github/display.js";
import { gitlabLocalWebhookUrl, gitlabProjectWebhooksSettingsUrl, gitlabPublicWebhookUrlPlaceholder } from "./platforms/gitlab/display.js";
import { linearLocalWebhookUrl, linearPublicWebhookUrlPlaceholder, linearWebhookSettingsUrl } from "./platforms/linear/display.js";
import { DEFAULT_GITHUB_WEBHOOK_PORT, DEFAULT_GITLAB_WEBHOOK_PORT, DEFAULT_LINEAR_WEBHOOK_PORT, DEFAULT_SLACK_EVENTS_PORT } from "./platforms/ports.js";
import { teamsLocalWebhookUrl, teamsPublicWebhookUrlPlaceholder } from "./platforms/teams/display.js";
import { telegramLocalWebhookUrl, telegramPublicWebhookUrlPlaceholder } from "./platforms/telegram/display.js";
import {
  assertHostedRelayAuthorization,
  assertRelayTransportAllowed,
  canonicalHostedRelayOrigin,
  relayTrustWarning
} from "./relay-security.js";
import { createSlackLinearBacklogHandler } from "./slack-linear-backlog.js";

export type StartCommandOptions = {
  config?: string;
  background?: boolean;
};

type LinearTokenProvider = NonNullable<LocalDispatcherRuntimeInput["linearTokenProvider"]>;

type Logger = Pick<Console, "log">;

export type StartRuntimeDependencies = {
  assertStartPortsAvailable?: typeof assertStartPortsAvailable;
  bootstrapDispatcher?: typeof bootstrapLocalDispatcher;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  now?: () => Date;
  readConfig?: typeof readCliConfig;
  refreshLinearOAuthToken?: typeof refreshLinearOAuthToken;
  serveDaemon?: typeof serveDaemon;
  startDispatcher?: typeof startDispatcher;
  startGitHubIngress?: typeof startGitHubIngress;
  startGitLabIngress?: typeof startGitLabIngress;
  startLinearIngress?: typeof startLinearIngress;
  startLarkIngress?: typeof startLarkIngress;
  startSlackIngress?: typeof startSlackIngress;
  startSlackSocketModeIngress?: typeof startSlackSocketModeIngress;
  waitForDispatcher?: typeof waitForDispatcher;
  writeConfig?: typeof writeCliConfigAtomic;
};

export type StartFromConfigInput = {
  config: OpenTagCliConfig;
  configPath: string;
  dependencies?: StartRuntimeDependencies;
  listenForProcessSignals?: boolean;
  signal?: AbortSignal;
};

export type BootstrapClient = {
  registerRunner(
    name?: string,
    registration?: Parameters<ReturnType<typeof createDispatcherAdminClient>["registerRunner"]>[1]
  ): Promise<void>;
  bindRepository(binding: RepositoryBindingConfig): Promise<void>;
  upsertRepoMutationMapping?(input: {
    provider: string;
    owner: string;
    repo: string;
    mapping: AdapterMutationMapping;
  }): Promise<unknown>;
  createLinearOAuthInstallation?(input: CreateLinearOAuthInstallationInput): Promise<LinearOAuthInstallationStart>;
  upsertLinearRelayInstallation?(input: LinearRelayInstallationInput): Promise<unknown>;
  bindChannel(binding: ChannelBindingInput): Promise<void>;
};

type PlatformIngressHandle =
  | { platform: "lark"; url?: string; handle: LarkIngressHandle }
  | { platform: "slack"; mode: "events_api"; url: string; handle: SlackIngressHandle }
  | { platform: "slack"; mode: "socket_mode"; handle: SlackSocketModeIngressHandle }
  | { platform: "github"; url: string; webhookPath: string; handle: GitHubIngressHandle }
  | { platform: "gitlab"; url: string; webhookPath: string; handle: GitLabIngressHandle }
  | { platform: "linear"; url: string; webhookPath: string; handle: LinearIngressHandle };

function dispatcherPortFromUrl(dispatcherUrl: string): number {
  const url = new URL(dispatcherUrl);
  if (url.protocol !== "http:" || (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) {
    throw new Error("opentag start currently supports only local http dispatcher URLs.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Dispatcher URL must not include a path, query, or hash.");
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Dispatcher URL has an invalid port: ${dispatcherUrl}`);
  }
  return port;
}

function requireLarkConfig(config: OpenTagCliConfig): NonNullable<OpenTagCliConfig["platforms"]["lark"]> {
  const lark = config.platforms.lark;
  if (!lark) {
    throw new Error("This config has no Lark platform config.");
  }
  return lark;
}

function requireSlackConfig(config: OpenTagCliConfig): NonNullable<OpenTagCliConfig["platforms"]["slack"]> {
  const slack = config.platforms.slack;
  if (!slack) {
    throw new Error("This config has no Slack platform config.");
  }
  return slack;
}

function requireGitHubConfig(config: OpenTagCliConfig): NonNullable<OpenTagCliConfig["platforms"]["github"]> {
  const github = config.platforms.github;
  if (!github) {
    throw new Error("This config has no GitHub platform config.");
  }
  return github;
}

function requireGitLabConfig(config: OpenTagCliConfig): NonNullable<OpenTagCliConfig["platforms"]["gitlab"]> {
  const gitlab = config.platforms.gitlab;
  if (!gitlab) {
    throw new Error("This config has no GitLab platform config.");
  }
  return gitlab;
}

function requireLinearConfig(config: OpenTagCliConfig): NonNullable<OpenTagCliConfig["platforms"]["linear"]> {
  const linear = config.platforms.linear;
  if (!linear) {
    throw new Error("This config has no Linear platform config.");
  }
  return linear;
}

// A query-only Linear config (token + projectId, no webhookSecret) powers the
// read-only Slack /linear backlog command and must not mount webhook ingress.
function linearIngressEnabled(
  linear: OpenTagCliConfig["platforms"]["linear"]
): linear is NonNullable<OpenTagCliConfig["platforms"]["linear"]> {
  if (!linear) return false;
  return Boolean(linear.webhookSecret) || linear.auth?.method === "hosted_oauth_app";
}

function hasStartablePlatform(config: OpenTagCliConfig): boolean {
  return Boolean(
    config.platforms.lark ||
      config.platforms.slack ||
      config.platforms.github ||
      config.platforms.gitlab ||
      config.platforms.linear ||
      config.platforms.telegram ||
      config.platforms.discord ||
      config.platforms.teams
  );
}

function positiveIntegerFromEnv(name: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function discordModeFromEnv(value: string | undefined): "gateway" | "webhook" | undefined {
  if (!value) return undefined;
  if (value === "gateway" || value === "webhook") return value;
  throw new Error("OPENTAG_DISCORD_MODE must be gateway or webhook.");
}

function maxRequestBodyBytesFromEnv(env?: NodeJS.ProcessEnv): number | undefined {
  return positiveIntegerFromEnv("OPENTAG_MAX_REQUEST_BODY_BYTES", env?.OPENTAG_MAX_REQUEST_BODY_BYTES);
}

type LocalPortCheck = {
  label: string;
  port: number;
  fix: string;
};

function localStartPortChecks(config: OpenTagCliConfig): LocalPortCheck[] {
  const checks: LocalPortCheck[] = [
    {
      label: "dispatcher",
      port: dispatcherPortFromUrl(config.daemon.dispatcherUrl),
      fix: "Change daemon.dispatcherUrl in the OpenTag config."
    }
  ];
  const slack = config.platforms.slack;
  if (slack && slackModeFromCliConfig(config) === "events_api") {
    checks.push({
      label: "Slack Events API",
      port: slack.port ?? DEFAULT_SLACK_EVENTS_PORT,
      fix: "Run `opentag setup --platform slack --slack-mode events_api --slack-port <port> --force`, or edit platforms.slack.port in the OpenTag config."
    });
  }
  const github = config.platforms.github;
  if (github) {
    checks.push({
      label: "GitHub local webhook",
      port: github.port ?? DEFAULT_GITHUB_WEBHOOK_PORT,
      fix: "Run `opentag setup --platform github --github-port <port> --force`, or edit platforms.github.port in the OpenTag config."
    });
  }
  const gitlab = config.platforms.gitlab;
  if (gitlab) {
    checks.push({
      label: "GitLab local webhook",
      port: gitlab.port ?? DEFAULT_GITLAB_WEBHOOK_PORT,
      fix: "Run `opentag setup --platform gitlab --gitlab-port <port> --force`, or edit platforms.gitlab.port in the OpenTag config."
    });
  }
  const linear = config.platforms.linear;
  if (linearIngressEnabled(linear)) {
    checks.push({
      label: "Linear local webhook",
      port: linear.port ?? DEFAULT_LINEAR_WEBHOOK_PORT,
      fix: "Run `opentag setup --platform linear --linear-port <port> --force`, or edit platforms.linear.port in the OpenTag config."
    });
  }
  return checks;
}

async function assertPortAvailable(check: LocalPortCheck): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            [
              `OpenTag cannot start ${check.label} because port ${check.port} is already in use.`,
              check.fix,
              `To inspect the current process: lsof -nP -iTCP:${check.port} -sTCP:LISTEN`
            ].join("\n")
          )
        );
        return;
      }
      reject(
        new Error(
          [`OpenTag cannot start ${check.label} on port ${check.port}: ${error.message}`, check.fix].join("\n")
        )
      );
    });
    // Tunnels commonly forward to localhost/127.0.0.1; this catches the real
    // collision even when another address family would still let Node listen.
    server.listen(check.port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}

export async function assertStartPortsAvailable(config: OpenTagCliConfig): Promise<void> {
  const checks = localStartPortChecks(config);
  const seen = new Map<number, LocalPortCheck>();
  for (const check of checks) {
    const existing = seen.get(check.port);
    if (existing) {
      throw new Error(
        [
          `OpenTag cannot start because ${existing.label} and ${check.label} both use port ${check.port}.`,
          `${existing.label}: ${existing.fix}`,
          `${check.label}: ${check.fix}`
        ].join("\n")
      );
    }
    seen.set(check.port, check);
  }
  for (const check of checks) {
    await assertPortAvailable(check);
  }
}

export function dispatcherRuntimeInputFromCliConfig(
  config: OpenTagCliConfig,
  input: { env?: NodeJS.ProcessEnv } = {}
): LocalDispatcherRuntimeInput {
  if (!hasStartablePlatform(config)) {
    throw new Error("This config has no startable platform. Run `opentag setup` and choose Lark, Slack, or GitHub.");
  }
  const lark = config.platforms.lark;
  const slack = config.platforms.slack;
  const github = config.platforms.github;
  const gitlab = config.platforms.gitlab;
  const linear = config.platforms.linear;
  const telegram = config.platforms.telegram;
  const discord = config.platforms.discord;
  const teams = config.platforms.teams;
  const env = input.env ?? process.env;
  const discordMode =
    discord?.mode ??
    discordModeFromEnv(env.OPENTAG_DISCORD_MODE) ??
    (env.OPENTAG_DISCORD_PUBLIC_KEY ? "webhook" : env.OPENTAG_DISCORD_BOT_TOKEN ? "gateway" : undefined);
  const discordPublicKey = discord?.publicKey ?? env.OPENTAG_DISCORD_PUBLIC_KEY;
  const discordBotToken = discord?.botToken ?? env.OPENTAG_DISCORD_BOT_TOKEN;
  const discordWebhookPath = discord?.webhookPath ?? env.OPENTAG_DISCORD_WEBHOOK_PATH;
  const channelPrincipals = [
    ...(lark
      ? [
          {
            provider: "lark",
            applicationId: lark.appId,
            ...(lark.botOpenId ? { botId: lark.botOpenId } : {}),
            credential: channelPrincipalCredential({
              provider: "lark",
              applicationId: lark.appId,
              secret: lark.appSecret
            })
          }
        ]
      : []),
    ...(slack?.appId
      ? [
          {
            provider: "slack",
            applicationId: slack.appId,
            credential: channelPrincipalCredential({
              provider: "slack",
              applicationId: slack.appId,
              secret: slack.botToken
            })
          }
        ]
      : [])
  ];
  if (discordMode === "webhook" && !discordPublicKey) {
    throw new Error("Discord webhook mode requires platforms.discord.publicKey or OPENTAG_DISCORD_PUBLIC_KEY.");
  }
  if ((discordMode === "gateway" || discordMode === "webhook") && !discordBotToken) {
    // Gateway and interactions authentication both require the bot credential.
    throw new Error("Discord platform requires platforms.discord.botToken or OPENTAG_DISCORD_BOT_TOKEN.");
  }
  const teamsAppId = teams?.appId ?? env.OPENTAG_TEAMS_APP_ID;
  const teamsAppPassword = teams?.appPassword ?? env.OPENTAG_TEAMS_APP_PASSWORD;
  const teamsTenantId = teams?.tenantId ?? env.OPENTAG_TEAMS_TENANT_ID;
  const teamsWebhookPath = teams?.webhookPath ?? env.OPENTAG_TEAMS_WEBHOOK_PATH;
  if (Boolean(teamsAppId) !== Boolean(teamsAppPassword)) {
    // Bot Framework token exchange needs both halves of the credential; a lone
    // app id or password would silently fail authentication on every message.
    throw new Error(
      "Microsoft Teams platform requires both platforms.teams.appId/appPassword or OPENTAG_TEAMS_APP_ID/OPENTAG_TEAMS_APP_PASSWORD together."
    );
  }
  if (github && !config.daemon.preparePullRequestBranch && !config.daemon.allowAutoCreatePullRequest) {
    throw new Error(
      "GitHub platform requires daemon.preparePullRequestBranch=true unless legacy daemon.allowAutoCreatePullRequest is enabled. Run `opentag setup` and choose GitHub to update this config."
    );
  }
  const reassessmentObligations = reassessmentObligationTestRuntimeInputFromEnv(env);
  return {
    port: dispatcherPortFromUrl(config.daemon.dispatcherUrl),
    databasePath: config.state.databasePath,
    ...dispatcherRuntimeHardeningInputFromEnv(input.env ?? process.env),
    ...(reassessmentObligations ? { reassessmentObligations } : {}),
    ...(config.daemon.pairingToken ? { pairingToken: config.daemon.pairingToken } : {}),
    ...(config.daemon.runnerToken ? { runnerToken: config.daemon.runnerToken } : {}),
    ...(config.daemon.runnerTokens ? { runnerTokens: config.daemon.runnerTokens } : {}),
    ...(config.daemon.revokedRunnerTokenFingerprints
      ? { revokedRunnerTokenFingerprints: config.daemon.revokedRunnerTokenFingerprints }
      : {}),
    ...(channelPrincipals.length > 0 ? { channelPrincipals } : {}),
    slackInstallations: config.platforms.slack?.installations ?? [],
    ...(config.daemon.githubToken ? { githubToken: config.daemon.githubToken } : {}),
    ...(config.daemon.completionPolicies !== undefined
      ? { completionPolicies: config.daemon.completionPolicies }
      : {}),
    ...(config.daemon.defaultGitHubCompletion !== undefined
      ? { defaultGitHubCompletion: config.daemon.defaultGitHubCompletion }
      : {}),
    ...(config.daemon.githubApplyToken !== undefined
      ? { githubApplyToken: config.daemon.githubApplyToken }
      : config.daemon.githubToken
        ? { githubApplyToken: config.daemon.githubToken }
        : {}),
    ...(gitlab ? { gitlabToken: gitlab.token, gitlabBaseUrl: gitlab.baseUrl } : {}),
    ...(linearIngressEnabled(linear) && linear.token
      ? {
          linearToken: linear.token,
          ...(linear.graphqlUrl ? { linearGraphqlUrl: linear.graphqlUrl } : {}),
          ...(linear.mappings ? { linearMappings: linear.mappings } : {}),
          ...(linear.projectTarget ? { linearProjectTarget: linear.projectTarget } : {})
        }
      : {}),
    ...(lark
      ? {
          lark: {
            appId: lark.appId,
            appSecret: lark.appSecret,
            domain: lark.domain
          }
        }
      : {}),
    ...(telegram
      ? {
          telegramBots: [
            {
              mode: telegram.mode ?? "polling",
              botId: telegram.botId,
              agentId: telegram.agentId ?? "opentag",
              ...(telegram.botUsername ? { botUsername: telegram.botUsername } : {}),
              botToken: telegram.botToken,
              ...(telegram.bindingAdminUserIds ? { bindingAdminUserIds: telegram.bindingAdminUserIds } : {}),
              ...(telegram.secretToken ? { secretToken: telegram.secretToken } : {}),
              ...(telegram.callbackUri ? { callbackUri: telegram.callbackUri } : {})
            }
          ]
        }
      : {}),
    ...(discordMode ? { discordMode } : {}),
    ...(discordPublicKey ? { discordPublicKey } : {}),
    ...(discordBotToken ? { discordBotToken } : {}),
    ...(discordWebhookPath ? { discordWebhookPath } : {}),
    ...(teamsAppId ? { teamsAppId } : {}),
    ...(teamsAppPassword ? { teamsAppPassword } : {}),
    ...(teamsTenantId ? { teamsTenantId } : {}),
    ...(teamsWebhookPath ? { teamsWebhookPath } : {})
  };
}

function channelPrincipalCredential(input: {
  provider: "lark" | "slack";
  applicationId: string;
  secret: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(`opentag-channel-principal:v1\0${input.provider}\0${input.applicationId}`)
    .digest("base64url");
}

function defaultRepoBindingFromConfig(config: OpenTagCliConfig): LarkIngressConfig["defaultRepoBinding"] {
  if (config.platforms.lark?.defaultProjectBinding === false) return undefined;
  if (config.daemon.repositories.length !== 1) return undefined;
  const repository = config.daemon.repositories[0];
  if (!repository) return undefined;
  return {
    repoProvider: repository.provider,
    owner: repository.owner,
    repo: repository.repo
  };
}

export function larkIngressConfigFromCliConfig(config: OpenTagCliConfig): LarkIngressConfig {
  const lark = requireLarkConfig(config);
  const defaultRepoBinding = defaultRepoBindingFromConfig(config);
  return {
    appId: lark.appId,
    appSecret: lark.appSecret,
    dispatcherUrl: config.daemon.dispatcherUrl,
    domain: lark.domain,
    agentId: DEFAULT_AGENT_ID,
    channelPrincipalCredential: channelPrincipalCredential({
      provider: "lark",
      applicationId: lark.appId,
      secret: lark.appSecret
    }),
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    ...(lark.botOpenId ? { botOpenId: lark.botOpenId } : {}),
    ...(lark.conversationMemory ? { conversationMemory: lark.conversationMemory } : {}),
    ...(config.daemon.runTimeoutMs ? { runTimeoutMs: config.daemon.runTimeoutMs } : {}),
    ...(defaultRepoBinding ? { defaultRepoBinding } : {})
  };
}

function slackModeFromCliConfig(config: OpenTagCliConfig): "socket_mode" | "events_api" {
  const slack = requireSlackConfig(config);
  return slack.mode ?? "events_api";
}

export function slackIngressConfigFromCliConfig(
  config: OpenTagCliConfig,
  input: { env?: NodeJS.ProcessEnv; linearTokenProvider?: LinearTokenProvider } = {}
): SlackEventsApiIngressConfig {
  const slack = requireSlackConfig(config);
  if (!slack.signingSecret) {
    throw new Error("Slack Events API mode requires platforms.slack.signingSecret.");
  }
  const maxRequestBodyBytes = maxRequestBodyBytesFromEnv(input.env);
  return {
    signingSecret: slack.signingSecret,
    dispatcherUrl: config.daemon.dispatcherUrl,
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    botToken: slack.botToken,
    ...(slack.appId
      ? {
          channelPrincipalCredential: channelPrincipalCredential({
            provider: "slack",
            applicationId: slack.appId,
            secret: slack.botToken
          })
        }
      : {}),
    ...(slack.appId ? { appId: slack.appId } : {}),
    ...(config.daemon.runTimeoutMs ? { runTimeoutMs: config.daemon.runTimeoutMs } : {}),
    ...(maxRequestBodyBytes ? { maxRequestBodyBytes } : {}),
    ...(slack.port ? { port: slack.port } : {}),
    linear: createSlackLinearBacklogHandler({
      ...(config.platforms.linear ? { linear: config.platforms.linear } : {}),
      env: input.env ?? process.env,
      ...(input.linearTokenProvider ? { getToken: input.linearTokenProvider } : {})
    })
  };
}

export function slackSocketModeIngressConfigFromCliConfig(
  config: OpenTagCliConfig,
  input: { env?: NodeJS.ProcessEnv; linearTokenProvider?: LinearTokenProvider } = {}
): SlackSocketModeIngressConfig {
  const slack = requireSlackConfig(config);
  if (!slack.appToken) {
    throw new Error("Slack Socket Mode requires platforms.slack.appToken.");
  }
  return {
    appToken: slack.appToken,
    dispatcherUrl: config.daemon.dispatcherUrl,
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    ...(slack.appId
      ? {
          channelPrincipalCredential: channelPrincipalCredential({
            provider: "slack",
            applicationId: slack.appId,
            secret: slack.botToken
          })
        }
      : {}),
    ...(config.daemon.runTimeoutMs ? { runTimeoutMs: config.daemon.runTimeoutMs } : {}),
    ...(slack.appId ? { appId: slack.appId } : {}),
    linear: createSlackLinearBacklogHandler({
      ...(config.platforms.linear ? { linear: config.platforms.linear } : {}),
      env: input.env ?? process.env,
      ...(input.linearTokenProvider ? { getToken: input.linearTokenProvider } : {})
    })
  };
}

export function githubIngressConfigFromCliConfig(
  config: OpenTagCliConfig,
  input: { env?: NodeJS.ProcessEnv; dispatcherFetchImpl?: typeof fetch } = {}
): GitHubIngressConfig {
  const github = requireGitHubConfig(config);
  const maxRequestBodyBytes = maxRequestBodyBytesFromEnv(input.env);
  const pairingToken = config.daemon.pairingToken;
  const governanceClient = pairingToken
    ? createOpenTagClient({
        dispatcherUrl: config.daemon.dispatcherUrl,
        pairingToken,
        ...(input.dispatcherFetchImpl ? { fetchImpl: input.dispatcherFetchImpl } : {})
      })
    : undefined;
  return {
    webhookSecret: github.webhookSecret,
    dispatcherUrl: config.daemon.dispatcherUrl,
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    ...(config.daemon.githubToken ? { githubToken: config.daemon.githubToken } : {}),
    ...(governanceClient
      ? {
          requestCompletionReconciliationEscalation: (request) =>
            governanceClient.requestGitHubCompletionReconciliationEscalation(request)
        }
      : {}),
    ...(maxRequestBodyBytes ? { maxRequestBodyBytes } : {}),
    port: github.port ?? DEFAULT_GITHUB_WEBHOOK_PORT,
    ...(github.webhookPath ? { webhookPath: github.webhookPath } : {})
  };
}

export function gitlabIngressConfigFromCliConfig(config: OpenTagCliConfig): GitLabIngressConfig {
  const gitlab = requireGitLabConfig(config);
  return {
    webhookSecret: gitlab.webhookSecret,
    baseUrl: gitlab.baseUrl,
    dispatcherUrl: config.daemon.dispatcherUrl,
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    port: gitlab.port ?? DEFAULT_GITLAB_WEBHOOK_PORT,
    ...(gitlab.webhookPath ? { webhookPath: gitlab.webhookPath } : {})
  };
}

export function linearIngressConfigFromCliConfig(config: OpenTagCliConfig): LinearIngressConfig {
  const linear = requireLinearConfig(config);
  if (linear.auth?.method === "hosted_oauth_app") {
    throw new Error("Linear hosted OAuth install configs must run in relay mode; local Linear ingress needs a local token and webhook secret.");
  }
  if (!linear.token || !linear.webhookSecret) {
    throw new Error("Linear local ingress requires platforms.linear.token and platforms.linear.webhookSecret.");
  }
  return {
    webhookSecret: linear.webhookSecret,
    linearToken: linear.token,
    ...(linear.graphqlUrl ? { graphqlUrl: linear.graphqlUrl } : {}),
    projectTarget: requireLinearProjectTarget(linear.projectTarget, "Linear local ingress"),
    dispatcherUrl: config.daemon.dispatcherUrl,
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    port: linear.port ?? DEFAULT_LINEAR_WEBHOOK_PORT,
    ...(linear.webhookPath ? { webhookPath: linear.webhookPath } : {}),
    // OAuth-app installs get both Comment and AgentSessionEvent webhooks for one mention;
    // defer comment runs so the agent-session channel can claim them.
    ...(linear.auth?.method === "oauth_app" ? { commentRunDeferMs: DEFAULT_LINEAR_COMMENT_RUN_DEFER_MS } : {})
  };
}

function requireLinearProjectTarget(
  projectTarget: { repoProvider: string; owner: string; repo: string } | undefined,
  purpose: string
): { repoProvider: string; owner: string; repo: string } {
  if (!projectTarget) {
    throw new Error(`${purpose} requires platforms.linear.projectTarget.`);
  }
  return projectTarget;
}

const LINEAR_OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;

function linearAccessTokenExpiresAt(input: { token: LinearOAuthTokenResponse; now: () => Date }): string | undefined {
  if (typeof input.token.expiresIn !== "number" || !Number.isFinite(input.token.expiresIn)) return undefined;
  return new Date(input.now().getTime() + input.token.expiresIn * 1000).toISOString();
}

function shouldRefreshLinearOAuthToken(input: { accessTokenExpiresAt?: string | undefined; now: () => Date; refreshSkewMs: number }): boolean {
  if (!input.accessTokenExpiresAt) return true;
  const expiresAt = Date.parse(input.accessTokenExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= input.now().getTime() + input.refreshSkewMs;
}

export function createLinearOAuthTokenProvider(input: {
  config: OpenTagCliConfig;
  configPath: string;
  now?: () => Date;
  readConfig?: typeof readCliConfig;
  refreshLinearOAuthToken?: typeof refreshLinearOAuthToken;
  refreshSkewMs?: number;
  writeConfig?: typeof writeCliConfigAtomic;
}): LocalDispatcherRuntimeInput["linearTokenProvider"] | undefined {
  const linear = input.config.platforms.linear;
  if (!linear || linear.auth?.method !== "oauth_app" || !linear.auth.refreshToken) return undefined;

  const now = input.now ?? (() => new Date());
  const refresh = input.refreshLinearOAuthToken ?? refreshLinearOAuthToken;
  const readConfig = input.readConfig ?? readCliConfig;
  const writeConfig = input.writeConfig ?? writeCliConfigAtomic;
  const refreshSkewMs = input.refreshSkewMs ?? LINEAR_OAUTH_REFRESH_SKEW_MS;
  const clientId = linear.auth.clientId;
  const clientSecret = linear.auth.clientSecret;
  let accessToken = linear.token;
  let refreshToken = linear.auth.refreshToken;
  let accessTokenExpiresAt = linear.auth.accessTokenExpiresAt;
  let scopes = linear.auth.scopes;
  let inFlight: Promise<string | undefined> | undefined;

  async function persistRefreshedToken(response: LinearOAuthTokenResponse): Promise<string> {
    accessToken = response.accessToken;
    if (typeof response.refreshToken === "string" && response.refreshToken.length > 0) {
      refreshToken = response.refreshToken;
    }
    accessTokenExpiresAt = linearAccessTokenExpiresAt({ token: response, now }) ?? accessTokenExpiresAt;
    scopes = response.scope ?? scopes;

    const latest = readConfig(input.configPath);
    const latestLinear = latest.platforms.linear;
    if (latestLinear?.auth?.method !== "oauth_app") {
      return accessToken;
    }

    const updatedLinear: NonNullable<OpenTagCliConfig["platforms"]["linear"]> = {
      ...latestLinear,
      token: accessToken,
      auth: {
        ...latestLinear.auth,
        refreshToken,
        ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
        ...(scopes ? { scopes } : {})
      }
    };
    const updatedConfig: OpenTagCliConfig = {
      ...latest,
      platforms: {
        ...latest.platforms,
        linear: updatedLinear
      }
    };
    writeConfig(input.configPath, updatedConfig);
    input.config.platforms.linear = updatedLinear;
    return accessToken;
  }

  async function refreshTokenOnce(): Promise<string | undefined> {
    const response = await refresh({
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      refreshToken
    });
    return persistRefreshedToken(response);
  }

  return async () => {
    if (!shouldRefreshLinearOAuthToken({ accessTokenExpiresAt, now, refreshSkewMs })) {
      return accessToken;
    }
    inFlight ??= refreshTokenOnce().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

export async function bootstrapLocalDispatcher(config: OpenTagCliConfig, client?: BootstrapClient): Promise<void> {
  const admin =
    client ??
    createDispatcherAdminClient({
      dispatcherUrl: config.daemon.dispatcherUrl,
      runnerId: config.daemon.runnerId,
      ...(config.daemon.pairingToken ? { pairingToken: config.daemon.pairingToken } : {})
    });

  await admin.registerRunner(config.daemon.runnerId, {
    locality: "local",
    executors: runnerExecutorRegistrations(executorsFromConfig(config.daemon)),
    maxConcurrentRuns: 1
  });
  for (const repository of config.daemon.repositories) {
    await admin.bindRepository({
      provider: repository.provider,
      owner: repository.owner,
      repo: repository.repo,
      checkoutPath: repository.checkoutPath,
      ...(repository.defaultExecutor ? { defaultExecutor: repository.defaultExecutor } : {}),
      ...(repository.baseBranch ? { baseBranch: repository.baseBranch } : {}),
      ...(repository.pushRemote ? { pushRemote: repository.pushRemote } : {}),
      ...(repository.worktreeRoot ? { worktreeRoot: repository.worktreeRoot } : {}),
      ...(repository.keepWorktree ? { keepWorktree: repository.keepWorktree } : {})
    });
  }
  const linear = config.platforms.linear;
  if (linear?.mappings?.length && admin.upsertRepoMutationMapping) {
    const mappingTarget = requireLinearProjectTarget(linear.projectTarget, "Linear mutation mapping upload");
    for (const mapping of linear.mappings) {
      await admin.upsertRepoMutationMapping({
        provider: mappingTarget.repoProvider,
        owner: mappingTarget.owner,
        repo: mappingTarget.repo,
        mapping
      });
    }
  }
  if (linear?.auth?.method === "hosted_oauth_app") {
    if (!admin.createLinearOAuthInstallation) {
      throw new Error("This dispatcher client cannot create hosted Linear OAuth installations.");
    }
    const installTarget = requireLinearProjectTarget(linear.projectTarget, "Linear hosted OAuth install");
    const started = await admin.createLinearOAuthInstallation({
      repoProvider: installTarget.repoProvider,
      owner: installTarget.owner,
      repo: installTarget.repo,
      ...(linear.teamId ? { teamId: linear.teamId } : {}),
      ...(linear.teamKey ? { teamKey: linear.teamKey } : {}),
      ...(linear.graphqlUrl ? { graphqlUrl: linear.graphqlUrl } : {}),
      ...(linear.auth.scopes ? { scopes: linear.auth.scopes } : {})
    });
    config.platforms.linear = {
      ...linear,
      webhookPath: started.oauthWebhookPath ?? linear.webhookPath,
      ...(started.installation.graphqlUrl ? { graphqlUrl: started.installation.graphqlUrl } : {}),
      ...(started.installation.teamId ? { teamId: started.installation.teamId } : {}),
      ...(started.installation.teamKey ? { teamKey: started.installation.teamKey } : {}),
      auth: {
        ...linear.auth,
        installationId: started.installation.id,
        authorizationUrl: started.authorizationUrl,
        stateExpiresAt: started.stateExpiresAt
      }
    };
  } else if (linear?.webhookPath?.startsWith("/linear/webhooks/")) {
    if (admin.upsertLinearRelayInstallation) {
      if (!linear.token || !linear.webhookSecret) {
        throw new Error("Linear relay installation upload requires platforms.linear.token and platforms.linear.webhookSecret.");
      }
      const relayTarget = requireLinearProjectTarget(linear.projectTarget, "Linear relay installation upload");
      await admin.upsertLinearRelayInstallation({
        id: linear.webhookPath.slice("/linear/webhooks/".length),
        webhookPath: linear.webhookPath,
        webhookSecret: linear.webhookSecret,
        token: linear.token,
        ...(linear.auth?.method === "oauth_app"
          ? {
              auth: {
                method: "oauth_app" as const,
                actor: "app" as const,
                ...(linear.auth.clientId ? { clientId: linear.auth.clientId } : {}),
                ...(linear.auth.refreshToken ? { refreshToken: linear.auth.refreshToken } : {}),
                ...(linear.auth.accessTokenExpiresAt ? { accessTokenExpiresAt: linear.auth.accessTokenExpiresAt } : {}),
                ...(linear.auth.scopes?.length ? { scopes: linear.auth.scopes } : {})
              }
            }
          : {}),
        ...(linear.graphqlUrl ? { graphqlUrl: linear.graphqlUrl } : {}),
        repoProvider: relayTarget.repoProvider,
        owner: relayTarget.owner,
        repo: relayTarget.repo,
        ...(linear.teamId ? { teamId: linear.teamId } : {}),
        ...(linear.teamKey ? { teamKey: linear.teamKey } : {})
      });
    }
  }
  for (const binding of normalizeChannelBindings(config.daemon)) {
    await admin.bindChannel({
      provider: binding.provider,
      accountId: binding.accountId,
      conversationId: binding.conversationId,
      ...(binding.repoProvider && binding.owner && binding.repo
        ? { repoProvider: binding.repoProvider, owner: binding.owner, repo: binding.repo }
        : {}),
      ...(binding.metadata ? { metadata: binding.metadata } : {}),
      ...(binding.ownership ? { ownership: binding.ownership } : {})
    });
  }
}

export async function waitForDispatcher(input: {
  dispatcherUrl: string;
  fetchImpl?: typeof fetch;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const attempts = input.attempts ?? 60;
  const delayMs = input.delayMs ?? 500;
  const timeoutMs = input.timeoutMs ?? 1_000;
  const healthUrl = `${input.dispatcherUrl.replace(/\/$/, "")}/healthz`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const healthy = await probeDispatcherHealth({
      dispatcherUrl: input.dispatcherUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs
    });
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Dispatcher did not become healthy at ${healthUrl}.`);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function shouldRethrowAbortReason(input: { shutdownRequested: boolean; reason: unknown }): boolean {
  return !input.shutdownRequested && input.reason instanceof Error;
}

function defaultStartDependencies(dependencies: StartRuntimeDependencies = {}) {
  return {
    assertStartPortsAvailable: dependencies.assertStartPortsAvailable ?? assertStartPortsAvailable,
    bootstrapDispatcher: dependencies.bootstrapDispatcher ?? bootstrapLocalDispatcher,
    env: dependencies.env ?? process.env,
    logger: dependencies.logger ?? console,
    now: dependencies.now ?? (() => new Date()),
    readConfig: dependencies.readConfig ?? readCliConfig,
    refreshLinearOAuthToken: dependencies.refreshLinearOAuthToken ?? refreshLinearOAuthToken,
    serveDaemon: dependencies.serveDaemon ?? serveDaemon,
    startDispatcher: dependencies.startDispatcher ?? startDispatcher,
    startGitHubIngress: dependencies.startGitHubIngress ?? startGitHubIngress,
    startGitLabIngress: dependencies.startGitLabIngress ?? startGitLabIngress,
    startLinearIngress: dependencies.startLinearIngress ?? startLinearIngress,
    startLarkIngress: dependencies.startLarkIngress ?? startLarkIngress,
    startSlackIngress: dependencies.startSlackIngress ?? startSlackIngress,
    startSlackSocketModeIngress: dependencies.startSlackSocketModeIngress ?? startSlackSocketModeIngress,
    waitForDispatcher: dependencies.waitForDispatcher ?? waitForDispatcher,
    writeConfig: dependencies.writeConfig ?? writeCliConfigAtomic
  };
}

export function hostedE2EGitHubApiOriginFromEnv(
  config: OpenTagCliConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const marker = env.OPENTAG_E2E_HOSTED_CLAIM_V1;
  const apiOrigin = env.OPENTAG_E2E_GITHUB_API_ORIGIN;
  if (marker === undefined && apiOrigin === undefined) return undefined;
  if (marker !== "1" || !apiOrigin) {
    throw new Error(
      "Hosted Control V1 E2E GitHub API origin markers are incomplete."
    );
  }
  if (
    config.daemon.controlRegistration?.kind !== "hosted_control_v1"
    || config.daemon.controlRegistration.state !== "paired"
  ) {
    throw new Error(
      "Hosted Control V1 E2E GitHub API origin requires a paired Hosted Control V1 runner."
    );
  }
  return resolveGitHubSourceApiOrigin({
    token: config.daemon.githubToken ?? "",
    apiOrigin,
  });
}

function addAbortHandlers(input: StartFromConfigInput, abortController: AbortController): {
  shutdownRequested(): boolean;
  dispose(): void;
} {
  let shutdownRequested = false;
  const abortGracefully = (reason?: unknown) => {
    shutdownRequested = true;
    if (!abortController.signal.aborted) {
      abortController.abort(reason);
    }
  };

  const onProcessSignal = () => abortGracefully();
  const onExternalAbort = () => abortGracefully(input.signal?.reason);

  if (input.listenForProcessSignals !== false) {
    process.once("SIGINT", onProcessSignal);
    process.once("SIGTERM", onProcessSignal);
  }
  if (input.signal) {
    if (input.signal.aborted) {
      onExternalAbort();
    } else {
      input.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    shutdownRequested: () => shutdownRequested,
    dispose() {
      if (input.listenForProcessSignals !== false) {
        process.off("SIGINT", onProcessSignal);
        process.off("SIGTERM", onProcessSignal);
      }
      input.signal?.removeEventListener("abort", onExternalAbort);
    }
  };
}

function abortOnSubsystemFailure(promise: Promise<void>, abortController: AbortController): void {
  promise.catch((error: unknown) => {
    if (!abortController.signal.aborted) {
      abortController.abort(error);
    }
  });
}

function assertRelayModePlatformsSupported(config: OpenTagCliConfig): void {
  const unsupported = [
    ...(config.platforms.lark ? ["Lark / Feishu"] : []),
    ...(config.platforms.slack ? ["Slack"] : []),
    ...(config.platforms.telegram ? ["Telegram"] : []),
    ...(config.platforms.discord ? ["Discord"] : []),
    ...(config.platforms.teams ? ["Microsoft Teams"] : [])
  ];
  if (unsupported.length > 0) {
    throw new Error(
      `Relay mode currently supports GitHub/GitLab/Linear-backed ingress only. ${unsupported.join(", ")} configs still require local mode.`
    );
  }
}

export function githubRelayWebhookUrl(config: OpenTagCliConfig): string {
  const relayUrl = relayUrlFromConfig(config) ?? config.daemon.dispatcherUrl;
  return `${relayUrl.replace(/\/$/, "")}/github/webhooks`;
}

export function gitlabRelayWebhookUrl(config: OpenTagCliConfig): string {
  const relayUrl = relayUrlFromConfig(config) ?? config.daemon.dispatcherUrl;
  const webhookPath = config.platforms.gitlab?.webhookPath ?? "/gitlab/webhooks";
  return `${relayUrl.replace(/\/$/, "")}${webhookPath}`;
}

export function linearRelayWebhookUrl(config: OpenTagCliConfig): string {
  const relayUrl = relayUrlFromConfig(config) ?? config.daemon.dispatcherUrl;
  const webhookPath = config.platforms.linear?.webhookPath ?? "/linear/webhooks";
  return `${relayUrl.replace(/\/$/, "")}${webhookPath}`;
}

async function startLocalMode(input: StartFromConfigInput, abortController: AbortController, shutdownRequested: () => boolean): Promise<void> {
  const dependencies = defaultStartDependencies(input.dependencies);
  const logger = dependencies.logger;
  const config = input.config;
  const env = dependencies.env ?? process.env;
  const ingresses: PlatformIngressHandle[] = [];
  const dispatcherInput = dispatcherRuntimeInputFromCliConfig(config, { env });
  const linearTokenProvider = createLinearOAuthTokenProvider({
    config,
    configPath: input.configPath,
    now: dependencies.now,
    readConfig: dependencies.readConfig,
    refreshLinearOAuthToken: dependencies.refreshLinearOAuthToken,
    writeConfig: dependencies.writeConfig
  });
  // OAuth refresh is also used by the read-only Slack /linear handler, but a
  // token provider only grants dispatcher mutation capability when Linear
  // webhook/apply ingress is explicitly enabled.
  if (linearTokenProvider && linearIngressEnabled(config.platforms.linear)) {
    dispatcherInput.linearTokenProvider = linearTokenProvider;
  }
  const dispatcher = dependencies.startDispatcher(dispatcherInput);
  let originalError: unknown;
  let daemonPromise: Promise<void> | undefined;

  try {
    await dependencies.waitForDispatcher({ dispatcherUrl: config.daemon.dispatcherUrl });
    await dependencies.bootstrapDispatcher(config);

    daemonPromise = dependencies.serveDaemon({
      ...createDaemonRuntimeInput(config.daemon, { databasePath: config.state.databasePath }),
      signal: abortController.signal
    });
    abortOnSubsystemFailure(daemonPromise, abortController);

    if (config.platforms.lark) {
      const handle = dependencies.startLarkIngress(larkIngressConfigFromCliConfig(config));
      ingresses.push({ platform: "lark", handle });
      abortOnSubsystemFailure(handle.startPromise, abortController);
    }
    if (config.platforms.slack) {
      if (slackModeFromCliConfig(config) === "socket_mode") {
        const handle = dependencies.startSlackSocketModeIngress(
          slackSocketModeIngressConfigFromCliConfig(config, { env, ...(linearTokenProvider ? { linearTokenProvider } : {}) })
        );
        ingresses.push({ platform: "slack", mode: "socket_mode", handle });
        abortOnSubsystemFailure(handle.startPromise, abortController);
      } else {
        const handle = dependencies.startSlackIngress(
          slackIngressConfigFromCliConfig(config, { env, ...(linearTokenProvider ? { linearTokenProvider } : {}) })
        );
        ingresses.push({ platform: "slack", mode: "events_api", url: handle.url, handle });
      }
    }
    if (config.platforms.github) {
      const handle = dependencies.startGitHubIngress(githubIngressConfigFromCliConfig(config, { env }));
      ingresses.push({ platform: "github", url: handle.url, webhookPath: handle.webhookPath, handle });
    }
    if (config.platforms.gitlab) {
      const handle = dependencies.startGitLabIngress(gitlabIngressConfigFromCliConfig(config));
      ingresses.push({ platform: "gitlab", url: handle.url, webhookPath: handle.webhookPath, handle });
    }
    if (linearIngressEnabled(config.platforms.linear)) {
      const linearIngressConfig = linearIngressConfigFromCliConfig(config);
      if (linearTokenProvider) {
        linearIngressConfig.getLinearToken = linearTokenProvider;
      }
      const handle = dependencies.startLinearIngress(linearIngressConfig);
      ingresses.push({ platform: "linear", url: handle.url, webhookPath: handle.webhookPath, handle });
    }

    logger.log("OpenTag is running.");
    logger.log(`Config: ${input.configPath}`);
    logger.log(`Dispatcher: ${config.daemon.dispatcherUrl}`);
    const deliveryActivation = getUnifiedDeliveryActivationState();
    logger.log(`Unified delivery: ${deliveryActivation.status} (${deliveryActivation.releaseStatus})`);
    logger.log(`Unified delivery blockers: ${deliveryActivation.reasons.join(", ")}`);
    const hermesWarning = hermesProfileConfigurationWarning(config.daemon);
    if (hermesWarning) logger.log(hermesWarning);
    for (const diagnostic of linearBacklogConfigDiagnostics(config)) logger.log(`Warning: ${diagnostic.message}`);
    for (const ingress of ingresses) {
      if (ingress.platform === "slack") {
        const slack = config.platforms.slack!;
        if (ingress.mode === "socket_mode") {
          logger.log("Slack: using Socket Mode");
          logger.log(`Slack channel binding: ${slack.teamId}/${slack.channelId}`);
          logger.log("Before testing, invite the Slack app to that channel with /invite @your app name.");
        } else {
          logger.log(`Slack Events: ${ingress.url}/slack/events`);
          logger.log(`Slack channel binding: ${slack.teamId}/${slack.channelId}`);
          logger.log("Before testing, invite the Slack app to that channel with /invite @your app name.");
        }
      } else if (ingress.platform === "github") {
        const github = config.platforms.github!;
        logger.log(`GitHub local webhook: ${githubLocalWebhookUrl({ port: github.port, webhookPath: ingress.webhookPath })}`);
        logger.log(`GitHub Payload URL: ${githubPublicWebhookUrlPlaceholder(ingress.webhookPath)}`);
        logger.log(`GitHub settings: ${githubWebhooksSettingsUrl(github)}`);
        logger.log(`Tunnel example: ngrok http ${github.port ?? DEFAULT_GITHUB_WEBHOOK_PORT}`);
      } else if (ingress.platform === "gitlab") {
        const gitlab = config.platforms.gitlab!;
        logger.log(`GitLab local webhook: ${gitlabLocalWebhookUrl({ port: gitlab.port, webhookPath: ingress.webhookPath })}`);
        logger.log(`GitLab Payload URL: ${gitlabPublicWebhookUrlPlaceholder(ingress.webhookPath)}`);
        logger.log(`GitLab settings: ${gitlabProjectWebhooksSettingsUrl(gitlab)}`);
        logger.log("GitLab events: Note events");
        logger.log(`Tunnel example: ngrok http ${gitlab.port ?? DEFAULT_GITLAB_WEBHOOK_PORT}`);
      } else if (ingress.platform === "linear") {
        const linear = config.platforms.linear!;
        logger.log(`Linear local webhook: ${linearLocalWebhookUrl({ port: linear.port, webhookPath: ingress.webhookPath })}`);
        logger.log(`Linear webhook URL: ${linearPublicWebhookUrlPlaceholder(ingress.webhookPath)}`);
        logger.log(`Linear settings: ${linearWebhookSettingsUrl()}`);
        if (linear.auth?.method === "oauth_app") {
          logger.log("Linear events: Comment and Agent session events (enable Webhooks on the Linear OAuth app and point them at the webhook URL above)");
        } else {
          logger.log("Linear events: Comment events");
        }
        logger.log(`Tunnel example: ngrok http ${linear.port ?? DEFAULT_LINEAR_WEBHOOK_PORT}`);
      } else {
        logger.log("Lark / Feishu: connected through Personal Agent long connection");
      }
    }
    if (config.platforms.telegram) {
      const telegram = config.platforms.telegram;
      if ((telegram.mode ?? "polling") === "webhook") {
        logger.log(`Telegram local webhook: ${telegramLocalWebhookUrl({ botId: telegram.botId })}`);
        logger.log(`Telegram webhook URL: ${telegramPublicWebhookUrlPlaceholder({ botId: telegram.botId })}`);
        logger.log("Telegram setWebhook must point at the public HTTPS tunnel URL and include the configured secret token.");
        logger.log("Tunnel example: ngrok http 3030");
      } else {
        logger.log("Telegram: using getUpdates polling");
        logger.log("Telegram tunnel: not required in polling mode");
      }
    }
    if (config.platforms.discord) {
      const discord = config.platforms.discord;
      if ((discord.mode ?? "gateway") === "webhook") {
        logger.log(`Discord local interactions endpoint: ${discordLocalInteractionsUrl({ webhookPath: discord.webhookPath })}`);
        logger.log(`Discord Interactions Endpoint URL: ${discordPublicInteractionsUrlPlaceholder(discord.webhookPath ?? "/discord/interactions")}`);
        logger.log("Discord slash command: register /opentag and install the app into the target server.");
        logger.log("Tunnel example: ngrok http 3030");
      } else {
        logger.log("Discord: using Gateway connection");
        logger.log("Discord tunnel: not required in Gateway mode");
        logger.log("Discord slash command: register /opentag and install the app into the target server.");
      }
    }
    if (config.platforms.teams) {
      const teams = config.platforms.teams;
      logger.log(
        `Microsoft Teams local messaging endpoint: ${teamsLocalWebhookUrl({
          webhookPath: teams.webhookPath,
          dispatcherPort: dispatcherPortFromUrl(config.daemon.dispatcherUrl)
        })}`
      );
      logger.log(`Microsoft Teams Messaging Endpoint URL: ${teamsPublicWebhookUrlPlaceholder(teams.webhookPath ?? "/teams/messages")}`);
      logger.log("Microsoft Teams: install the app into the target Teams tenant.");
      logger.log(`Tunnel example: ngrok http ${dispatcherPortFromUrl(config.daemon.dispatcherUrl)}`);
    }
    logger.log("Press Ctrl-C to stop.");

    await waitForAbort(abortController.signal);
    const reason = abortController.signal.reason;
    if (shouldRethrowAbortReason({ shutdownRequested: shutdownRequested(), reason })) {
      throw reason;
    }
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    abortController.abort();
    if (daemonPromise) await Promise.allSettled([daemonPromise]);
    await Promise.allSettled([...ingresses].reverse().map((ingress) => ingress.handle.close()));
    try {
      await dispatcher.close();
    } catch (error) {
      if (originalError !== undefined) {
        logger.log(`OpenTag dispatcher close failed during shutdown: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        throw error;
      }
    }
  }
}

async function startRelayMode(
  input: StartFromConfigInput,
  abortController: AbortController,
  shutdownRequested: () => boolean,
  githubApiOrigin?: string,
): Promise<void> {
  const dependencies = defaultStartDependencies(input.dependencies);
  const logger = dependencies.logger;
  const config = input.config;
  assertRelayModePlatformsSupported(config);
  const relayUrl = relayUrlFromConfig(config) ?? config.daemon.dispatcherUrl;
  assertRelayTransportAllowed(relayUrl);

  await dependencies.waitForDispatcher({ dispatcherUrl: config.daemon.dispatcherUrl });
  if (!config.daemon.controlRegistration) {
    await dependencies.bootstrapDispatcher(config);
  }

  let daemonPromise: Promise<void> | undefined;
  try {
    daemonPromise = dependencies.serveDaemon({
      ...createDaemonRuntimeInput(config.daemon, {
        databasePath: config.state.databasePath,
        ...(githubApiOrigin !== undefined ? { githubApiOrigin } : {}),
      }),
      signal: abortController.signal
    });
    abortOnSubsystemFailure(daemonPromise, abortController);

    logger.log("OpenTag is running in relay mode.");
    logger.log(`Config: ${input.configPath}`);
    logger.log(`Relay: ${relayUrl}`);
    logger.log(relayTrustWarning(relayUrl));
    logger.log("Local dispatcher: disabled");
    logger.log(`Runner: ${config.daemon.runnerId}`);
    const hermesWarning = hermesProfileConfigurationWarning(config.daemon);
    if (hermesWarning) logger.log(hermesWarning);
    for (const diagnostic of linearBacklogConfigDiagnostics(config)) logger.log(`Warning: ${diagnostic.message}`);
    if (config.platforms.github) {
      logger.log(`GitHub webhook URL: ${githubRelayWebhookUrl(config)}`);
      logger.log("GitHub webhook secret: the relay must verify the configured secret before creating runs.");
    }
    if (config.platforms.gitlab) {
      logger.log(`GitLab webhook URL: ${gitlabRelayWebhookUrl(config)}`);
      logger.log("GitLab webhook secret: the relay must verify X-Gitlab-Token before creating runs.");
    }
    if (config.platforms.linear) {
      const linear = config.platforms.linear;
      logger.log(`Linear webhook URL: ${linearRelayWebhookUrl(config)}`);
      if (linear.auth?.method === "hosted_oauth_app") {
        if (linear.auth.authorizationUrl) {
          logger.log(`Linear OAuth install URL: ${linear.auth.authorizationUrl}`);
        }
        logger.log("Linear OAuth install: the relay stores the app token and generated webhook secret after install.");
      } else {
        logger.log("Linear webhook secret: the relay must verify Linear-Signature and webhook timestamp before creating runs.");
      }
    }
    logger.log("Press Ctrl-C to stop.");

    await waitForAbort(abortController.signal);
    const reason = abortController.signal.reason;
    if (shouldRethrowAbortReason({ shutdownRequested: shutdownRequested(), reason })) {
      throw reason;
    }
  } finally {
    abortController.abort();
    if (daemonPromise) await Promise.allSettled([daemonPromise]);
  }
}

export async function startFromConfig(input: StartFromConfigInput): Promise<void> {
  if (input.config.daemon.controlRegistration) {
    assertHostedRelayAuthorization({
      dispatcherUrl: input.config.daemon.dispatcherUrl,
      trustedRelay: input.config.daemon.trustedRelay
    });
    const relayUrl = relayUrlFromConfig(input.config);
    if (!relayUrl) {
      throw new Error("Hosted Control V1 requires runtime.mode=relay before secrets or network access.");
    }
    if (
      canonicalHostedRelayOrigin(relayUrl)
      !== canonicalHostedRelayOrigin(input.config.daemon.dispatcherUrl)
    ) {
      throw new Error("Hosted Control V1 relay origin does not match dispatcher origin.");
    }
  }
  const hostedAuthProblem = hostedRunnerAuthProblem(input.config.daemon);
  if (hostedAuthProblem) throw new Error(hostedAuthProblem);
  const githubApiOrigin = hostedE2EGitHubApiOriginFromEnv(
    input.config,
    input.dependencies?.env ?? process.env,
  );

  ensurePrivateDirectory(input.config.state.directory);
  ensurePrivateDirectory(input.config.state.worktreeRoot);

  const dependencies = defaultStartDependencies(input.dependencies);
  if (runtimeModeFromConfig(input.config) === "local") {
    await dependencies.assertStartPortsAvailable(input.config);
  }

  const abortController = new AbortController();
  const abortHandlers = addAbortHandlers(input, abortController);
  try {
    if (runtimeModeFromConfig(input.config) === "relay") {
      await startRelayMode(
        input,
        abortController,
        abortHandlers.shutdownRequested,
        githubApiOrigin,
      );
      return;
    }
    await startLocalMode(input, abortController, abortHandlers.shutdownRequested);
  } finally {
    abortHandlers.dispose();
  }
}

export async function runStartCommand(options: StartCommandOptions): Promise<void> {
  const configPath = options.config ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  await startFromConfig({ config, configPath });
}
