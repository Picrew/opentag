type JsonObject = Record<string, unknown>;

export type SlackChannelBinding = {
  teamId: string;
  channelId: string;
};

export type LinearProjectSelection = {
  id: string;
  name: string;
};

export type RegistrySlackLinearConfig = {
  schemaVersion: 1;
  state: {
    directory: string;
    databasePath: string;
    worktreeRoot: string;
  };
  runtime: { mode: "local" };
  daemon: {
    runnerId: string;
    dispatcherUrl: string;
    repositories: [];
    pairingToken: { kind: "env"; name: "OPENTAG_SLACK_LINEAR_PAIRING_TOKEN" };
    pollIntervalMs: number;
    heartbeatIntervalMs: number;
  };
  platforms: {
    slack: {
      mode: "socket_mode";
      appToken: { kind: "env"; name: "OPENTAG_SLACK_APP_TOKEN" };
      botToken: { kind: "env"; name: "OPENTAG_SLACK_BOT_TOKEN" };
      teamId: string;
      channelId: string;
    };
    linear: {
      connections: {
        default: { token: { kind: "env"; name: "OPENTAG_LINEAR_SMOKE_TOKEN" } };
      };
      channels: Array<{
        teamId: string;
        channelId: string;
        projectId: string;
        connection: "default";
      }>;
      graphqlUrl: string;
    };
  };
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function hasExpectedLinearBacklogProjectMapping(
  variables: Record<string, unknown>,
  expectedProjectId: string
): boolean {
  const suppliedProjectIds = ["projectId", "projectKey"]
    .filter((key) => Object.hasOwn(variables, key))
    .map((key) => variables[key]);
  return suppliedProjectIds.length > 0 && suppliedProjectIds.every((value) => value === expectedProjectId);
}

export function expectedLinearBacklogPageCount(reportedOpenCount: number, forcedPageSize: number): number {
  if (!Number.isSafeInteger(reportedOpenCount) || reportedOpenCount < 0) {
    throw new Error("Reported Linear open count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(forcedPageSize) || forcedPageSize < 1) {
    throw new Error("Forced Linear page size must be a positive safe integer.");
  }
  return Math.max(1, Math.ceil(reportedOpenCount / forcedPageSize));
}

function candidateBinding(value: unknown): SlackChannelBinding | undefined {
  if (!isObject(value)) return undefined;
  const teamId = nonBlank(value.teamId) ?? nonBlank(value.accountId);
  const channelId = nonBlank(value.channelId) ?? nonBlank(value.conversationId);
  return teamId && channelId ? { teamId, channelId } : undefined;
}

export function selectSlackChannelBinding(config: unknown, requestedChannelId?: string): SlackChannelBinding {
  if (!isObject(config)) throw new Error("OpenTag config must be a JSON object.");
  const candidates: SlackChannelBinding[] = [];

  if (isObject(config.platforms) && isObject(config.platforms.slack)) {
    const binding = candidateBinding(config.platforms.slack);
    if (binding) candidates.push(binding);
  }
  if (Array.isArray(config.slackChannels)) {
    for (const value of config.slackChannels) {
      const binding = candidateBinding(value);
      if (binding) candidates.push(binding);
    }
  }
  if (Array.isArray(config.channelBindings)) {
    for (const value of config.channelBindings) {
      if (!isObject(value) || value.provider !== "slack") continue;
      const binding = candidateBinding(value);
      if (binding) candidates.push(binding);
    }
  }

  const deduplicated = [...new Map(candidates.map((binding) => [`${binding.teamId}\u0000${binding.channelId}`, binding])).values()];
  const requested = nonBlank(requestedChannelId);
  if (requested) {
    const selected = deduplicated.find((binding) => binding.channelId === requested);
    if (!selected) throw new Error(`No Slack channel binding found for requested channel ${requested}.`);
    return selected;
  }
  if (!deduplicated[0]) throw new Error("OpenTag config has no Slack channel binding.");
  return deduplicated[0];
}

export function normalizeLinearIssueRef(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Linear smoke issue reference must not be empty.");
  const pathMatch = trimmed.match(/\/issue\/([^/#?]+)/u);
  return pathMatch?.[1] ? decodeURIComponent(pathMatch[1]) : trimmed;
}

export function describeLinearProjectDiscoveryFailure(input: { status: number; messages: string[] }): string {
  const detail = input.messages.filter(Boolean).join("; ") || `http_${input.status}`;
  if (
    input.status === 401 ||
    input.status === 403 ||
    /authentication required|not authenticated|unauthorized|forbidden|permission denied|access denied/iu.test(detail)
  ) {
    return `Linear project discovery failed: ${detail}. Reauthorize the Linear live acceptance and refresh OPENTAG_LINEAR_SMOKE_TOKEN.`;
  }
  if (/entity not found:\s*issue|issue(?:\s+\S+){0,3}\s+not found|could not find(?:\s+\S+){0,3}\s+issue/iu.test(detail)) {
    return `Linear smoke issue discovery failed: ${detail}. Update OPENTAG_LINEAR_SMOKE_ISSUE to an issue in a project accessible to the configured token.`;
  }
  return `Linear provider project discovery failed: ${detail}. Retry the acceptance or check the Linear API status and response.`;
}

export function selectLinearProjectFromDiscoveryResponse(input: {
  status: number;
  body: unknown;
}): LinearProjectSelection {
  const body = isObject(input.body) ? input.body : {};
  const messages = Array.isArray(body.errors)
    ? body.errors.flatMap((value) => (isObject(value) ? [nonBlank(value.message)].filter((message): message is string => Boolean(message)) : []))
    : [];
  if (input.status < 200 || input.status >= 300 || messages.length > 0) {
    throw new Error(describeLinearProjectDiscoveryFailure({ status: input.status, messages }));
  }
  if (!isObject(body.data) || !("issue" in body.data)) {
    throw new Error(
      "Linear provider project discovery failed: the response did not contain data.issue. Retry the acceptance or check the Linear API status and response."
    );
  }
  if (body.data.issue === null) {
    throw new Error(
      "Linear smoke issue discovery failed: issue not found. Update OPENTAG_LINEAR_SMOKE_ISSUE to an issue in a project accessible to the configured token."
    );
  }
  if (!isObject(body.data.issue)) {
    throw new Error(
      "Linear provider project discovery failed: data.issue was malformed. Retry the acceptance or check the Linear API status and response."
    );
  }
  const project = body.data.issue.project;
  if (project === null) {
    throw new Error("The configured Linear smoke issue is not assigned to a project; /linear requires a project mapping.");
  }
  if (!isObject(project) || !nonBlank(project.id) || !nonBlank(project.name)) {
    throw new Error(
      "Linear provider project discovery failed: data.issue.project was malformed. Retry the acceptance or check the Linear API status and response."
    );
  }
  return { id: nonBlank(project.id)!, name: nonBlank(project.name)! };
}

export function buildSlackLinearDiagnosticLog(input: {
  cliOutput: string;
  failureMessage?: string;
  sensitiveValues?: string[];
}): string {
  const redact = (value: string): string => {
    let result = value;
    for (const sensitiveValue of input.sensitiveValues ?? []) {
      if (sensitiveValue) result = result.replaceAll(sensitiveValue, "[REDACTED]");
    }
    return result
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
      .replace(/\bx(?:app|ox[baprs])-[A-Za-z0-9-]+/giu, "[REDACTED]")
      .replace(/\blin_api_[A-Za-z0-9_-]+/giu, "[REDACTED]");
  };
  const output = redact(input.cliOutput).trimEnd();
  const sections = [output || "[opentag-live] no CLI output was captured."];
  if (input.failureMessage) sections.push(`[opentag-live] harness failure: ${redact(input.failureMessage)}`);
  return `${sections.join("\n")}\n`;
}

export function appendSlackLinearCleanupFailure(primaryFailure: string | undefined, cleanupFailure: unknown): string {
  const detail = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
  return primaryFailure ? `${primaryFailure}; cleanup failed: ${detail}` : `Cleanup failed: ${detail}`;
}

export async function stopSlackLinearProcessForCleanup(input: {
  sendSignal: (signal: "SIGTERM" | "SIGKILL") => boolean;
  waitForExit: () => Promise<void>;
}): Promise<void> {
  const termSent = input.sendSignal("SIGTERM");
  try {
    await input.waitForExit();
  } catch (error) {
    const killSent = input.sendSignal("SIGKILL");
    throw new Error(
      `Registry CLI cleanup did not complete after SIGTERM; SIGTERM sent=${termSent}, SIGKILL sent=${killSent}.`,
      { cause: error }
    );
  }
}

export async function runSlackLinearCleanupActions(
  actions: Array<{ name: string; run: () => Promise<void> }>
): Promise<void> {
  const failures: Error[] = [];
  for (const action of actions) {
    try {
      await action.run();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(new Error(`${action.name}: ${detail}`, { cause: error }));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map((failure) => failure.message).join("; "));
  }
}

export function validateLinearLiveGraphqlUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Live acceptance requires the canonical Linear GraphQL endpoint.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.linear.app" ||
    url.port ||
    url.pathname !== "/graphql" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("Live acceptance requires the canonical Linear GraphQL endpoint https://api.linear.app/graphql.");
  }
  return "https://api.linear.app/graphql";
}

const REGISTRY_CHILD_ENV_ALLOWLIST = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

function allowlistedBaseEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of REGISTRY_CHILD_ENV_ALLOWLIST) {
    const value = baseEnv[name];
    if (value) env[name] = value;
  }
  return env;
}

export function buildRegistryInstallerEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  cacheDirectory: string;
  userConfigPath: string;
  globalConfigPath: string;
}): NodeJS.ProcessEnv {
  return {
    ...allowlistedBaseEnvironment(input.baseEnv),
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: input.cacheDirectory,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: input.globalConfigPath,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
    NPM_CONFIG_USERCONFIG: input.userConfigPath
  };
}

export function buildRegistrySlackLinearChildEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  appToken: string;
  botToken: string;
  linearToken: string;
  pairingToken: string;
}): NodeJS.ProcessEnv {
  return {
    ...allowlistedBaseEnvironment(input.baseEnv),
    OPENTAG_SLACK_APP_TOKEN: input.appToken,
    OPENTAG_SLACK_BOT_TOKEN: input.botToken,
    OPENTAG_LINEAR_SMOKE_TOKEN: input.linearToken,
    OPENTAG_SLACK_LINEAR_PAIRING_TOKEN: input.pairingToken
  };
}

export function isGracefulCliExit(input: { code: number | null; signal: NodeJS.Signals | null }): boolean {
  return input.code === 0 && input.signal === null;
}

export function buildRegistrySlackLinearConfig(input: {
  stateDirectory: string;
  databasePath: string;
  worktreeRoot: string;
  dispatcherUrl: string;
  graphqlUrl: string;
  teamId: string;
  channelId: string;
  projectId: string;
}): RegistrySlackLinearConfig {
  return {
    schemaVersion: 1,
    state: {
      directory: input.stateDirectory,
      databasePath: input.databasePath,
      worktreeRoot: input.worktreeRoot
    },
    runtime: { mode: "local" },
    daemon: {
      runnerId: "runner_slack_linear_registry_live",
      dispatcherUrl: input.dispatcherUrl,
      repositories: [],
      pairingToken: { kind: "env", name: "OPENTAG_SLACK_LINEAR_PAIRING_TOKEN" },
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 15_000
    },
    platforms: {
      slack: {
        mode: "socket_mode",
        appToken: { kind: "env", name: "OPENTAG_SLACK_APP_TOKEN" },
        botToken: { kind: "env", name: "OPENTAG_SLACK_BOT_TOKEN" },
        teamId: input.teamId,
        channelId: input.channelId
      },
      linear: {
        connections: {
          default: { token: { kind: "env", name: "OPENTAG_LINEAR_SMOKE_TOKEN" } }
        },
        channels: [
          {
            teamId: input.teamId,
            channelId: input.channelId,
            projectId: input.projectId,
            connection: "default"
          }
        ],
        graphqlUrl: input.graphqlUrl
      }
    }
  };
}

export type SlackLinearReplySummary = {
  kind: "backlog" | "empty";
  displayedIssueCount: number;
  reportedOpenCount: number;
};

export type SlackLinearReplyCandidate = {
  ts?: string;
  text?: string;
  user?: string;
};

export type CorrelatedSlackLinearReply = {
  message: SlackLinearReplyCandidate & { ts: string; text: string; user: string };
  summary: SlackLinearReplySummary;
};

export function summarizeSlackLinearReply(text: string): SlackLinearReplySummary {
  if (!/_Linear · queried \d{2}:\d{2} UTC_/u.test(text)) {
    throw new Error("Slack response is not a successful /linear reply.");
  }
  const openMatch = text.match(/· (\d+) open\*/u);
  if (!openMatch) throw new Error("Slack response does not report the authoritative open issue count.");
  const reportedOpenCount = Number(openMatch[1]);
  const displayedIssueCount = text.split("\n").filter((line) => line.startsWith("• ")).length;
  if (reportedOpenCount === 0) {
    if (!text.includes("No unfinished issues in this Linear project.")) {
      throw new Error("Slack response reports an empty backlog without the empty-state receipt.");
    }
    return { kind: "empty", displayedIssueCount, reportedOpenCount };
  }
  if (displayedIssueCount === 0) throw new Error("Slack response reports open Linear issues but displays none.");
  return { kind: "backlog", displayedIssueCount, reportedOpenCount };
}

export function selectCorrelatedSlackLinearReply(input: {
  messages: SlackLinearReplyCandidate[];
  threadTs: string;
  botUserId: string;
  correlationMarker: string;
  auditCompletedAtMs?: number;
}): CorrelatedSlackLinearReply | undefined {
  const successfulReplies: CorrelatedSlackLinearReply[] = [];
  for (const candidate of input.messages) {
    if (!candidate.ts || candidate.ts === input.threadTs || !candidate.text || candidate.user !== input.botUserId) continue;
    try {
      successfulReplies.push({
        message: { ...candidate, ts: candidate.ts, text: candidate.text, user: candidate.user },
        summary: summarizeSlackLinearReply(candidate.text)
      });
    } catch {
      // The thread may include other bot receipts; only successful /linear replies participate in correlation.
    }
  }
  if (successfulReplies.length > 1) {
    throw new Error("Observed multiple successful Slack /linear replies in the source thread; runtime ownership is ambiguous.");
  }
  const reply = successfulReplies[0];
  if (!reply) return undefined;
  if (input.auditCompletedAtMs === undefined) {
    throw new Error("A successful Slack /linear reply arrived before the audited Linear query completed.");
  }
  const replyAtMs = Number(reply.message.ts) * 1_000;
  if (!Number.isFinite(replyAtMs) || replyAtMs < input.auditCompletedAtMs) {
    throw new Error("A successful Slack /linear reply is not ordered after the audited Linear query completed.");
  }
  if (!reply.message.text.includes(input.correlationMarker)) {
    throw new Error("The Slack /linear reply does not carry the registry runtime correlation marker.");
  }
  return reply;
}
