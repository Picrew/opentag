import {
  createOpenTagClient,
  OpenTagClientHttpError,
  type ChannelRuntimeStatus,
  type CompletionExplanation,
  type ControlPlaneAlert,
  type EnsuredWorkThread,
  type RunMetrics,
  type WorkLoopAttentionItem
} from "@opentag/client";
import {
  createSourceThreadStatusPresentation,
  formatProjectTargetRef,
  platformCapabilityForProvider,
  projectTargetRefFromEvent,
  renderOpenTagPresentationPlainText,
  RoutingDecisionSchema,
  type OpenTagEvent,
  type OpenTagRun,
  type AcceptedProgressAttributionView,
  type AcceptedProgressMetrics,
  type FactoryRecipeSnapshot,
  type RunnerDirectoryEntry,
  type RoutingDecision,
  type PlatformLivenessStrategy,
  type Workstream,
  type WorkstreamEvaluation,
  type WorkstreamMetrics
} from "@opentag/core";
import { DEFAULT_AGENT_SESSION_PROFILE_TEMPLATE } from "@opentag/local-runtime";
import { formatConfiguredCapabilities } from "./catalogs/capabilities.js";
import type { PlatformId } from "./catalogs/platforms.js";
import {
  defaultConfigPath,
  hostedRunnerAuthProblem,
  readCliConfig,
  readRedactedCliConfig,
  relayUrlFromConfig,
  redactedCliConfig,
  runnerDispatcherToken,
  runtimeModeFromConfig,
  type OpenTagCliConfig
} from "./config.js";
import { probeDispatcherHealth } from "./health.js";
import { formatConfiguredProjectTargetSummary } from "./project-target-summary.js";
import { formatRelaySecurityChecks, relaySecurityChecksFromConfig } from "./relay-security.js";
import { formatSecretReadiness } from "./secret-readiness.js";

export type StatusCommandOptions = {
  config?: string;
  run?: string;
  channel?: string;
  workstream?: string;
  workThread?: string;
  attention?: boolean;
  json?: boolean;
};

export type StatusSummary = {
  configPath: string;
  dispatcher: "online" | "offline";
  dispatcherUrl: string;
  runtimeMode: "local" | "relay";
  relayUrl?: string;
  relaySecurity: string[];
  controlPlaneAlerts: ControlPlaneAlert[];
  controlPlaneAlertsError?: string;
  runnerId: string;
  runTimeoutPolicy: string;
  secrets: string[];
  repositories: string[];
  platforms: string[];
  agentSessionProfile: string[];
  capabilities: string[];
  runnerDirectory?: RunnerDirectoryEntry[];
  runnerDirectoryError?: string;
  acceptedProgressMetrics?: AcceptedProgressMetrics;
  acceptedProgressMetricsError?: string;
};

function assertHostedStatusAuth(config: OpenTagCliConfig): void {
  const problem = hostedRunnerAuthProblem(config.daemon);
  if (problem) throw new Error(problem);
}

function assertHostedRunStatusAuth(config: OpenTagCliConfig): void {
  if (!config.daemon.controlRegistration) return;
  const problem = hostedRunnerAuthProblem({
    ...config.daemon,
    pairingToken: undefined
  });
  if (problem) throw new Error(problem);
}

type RunAuditEvent = {
  type?: unknown;
  visibility?: unknown;
  importance?: unknown;
  message?: unknown;
  payload?: unknown;
  createdAt?: unknown;
};

type RunLedgerEntry = RunAuditEvent & {
  category?: unknown;
  sequence?: unknown;
};

export type RunStatusSummary = {
  configPath: string;
  dispatcherUrl: string;
  run: OpenTagRun;
  event: OpenTagEvent;
  metrics: RunMetrics;
  runTimeoutPolicy?: string;
  events: RunAuditEvent[];
  ledgerEntries?: RunLedgerEntry[];
  completion?: CompletionExplanation;
};

export type ChannelStatusSummary = {
  configPath: string;
  dispatcherUrl: string;
  provider: string;
  accountId: string;
  conversationId: string;
  runTimeoutPolicy: string;
  status: ChannelRuntimeStatus;
};

export type WorkstreamStatusSummary = {
  configPath: string;
  dispatcherUrl: string;
  recipe: FactoryRecipeSnapshot;
  workstream: Workstream;
  metrics: WorkstreamMetrics;
  evaluation: WorkstreamEvaluation;
  alerts: ControlPlaneAlert[];
};

export type WorkThreadStatusSummary = {
  configPath: string;
  dispatcherUrl: string;
  workThread: EnsuredWorkThread;
  completion: CompletionExplanation;
  acceptedProgress: AcceptedProgressAttributionView | null;
};

export type WorkLoopAttentionStatusSummary = {
  configPath: string;
  dispatcherUrl: string;
  workLoops: WorkLoopAttentionItem[];
  scanned: number;
  scanLimitReached: boolean;
};

export function parseChannelRef(ref: string): { provider: string; accountId: string; conversationId: string } {
  const trimmed = ref.trim();
  const colon = trimmed.indexOf(":");
  const slash = trimmed.indexOf("/", colon + 1);
  if (colon <= 0 || slash <= colon + 1 || slash === trimmed.length - 1) {
    throw new Error("--channel must be formatted as provider:account_id/conversation_id.");
  }
  return {
    provider: trimmed.slice(0, colon),
    accountId: trimmed.slice(colon + 1, slash),
    conversationId: trimmed.slice(slash + 1)
  };
}

function formatDurationMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute(s)`;
  if (ms % 1_000 === 0) return `${ms / 1_000} second(s)`;
  return `${ms}ms`;
}

function formatRunTimeoutPolicy(timeoutMs: number | undefined): string {
  return timeoutMs ? `hard timeout after ${formatDurationMs(timeoutMs)}` : "disabled";
}

function formatAgentSessionProfile(config: OpenTagCliConfig["daemon"]["agentSessionProfile"]): string[] {
  const lines = ["Agent Session Profile:"];
  if (config?.profile) {
    lines.push(`  fixed profile: ${config.profile}`);
    if (config.profileTemplate) {
      lines.push(`  template ignored while fixed profile is set: ${config.profileTemplate}`);
    }
  } else if (config?.profileTemplate) {
    lines.push(`  template: ${config.profileTemplate}`);
  } else {
    lines.push(`  default template: ${DEFAULT_AGENT_SESSION_PROFILE_TEMPLATE}`);
  }
  lines.push("  scope: derived from source provider, source container, Project Target, and actor; session identity excludes checkout paths and secrets.");
  return lines;
}

export async function getStatusSummary(input: {
  configPath?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<StatusSummary> {
  const configPath = input.configPath ?? defaultConfigPath();
  const secretConfig = readRedactedCliConfig(configPath);
  const config = readCliConfig(configPath);
  return statusFromConfig({ config, configPath, secretConfig, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
}

export async function statusFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
  secretConfig?: unknown;
}): Promise<StatusSummary> {
  assertHostedStatusAuth(input.config);
  const relayUrl = relayUrlFromConfig(input.config);
  const dispatcher = (await probeDispatcherHealth({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    timeoutMs: input.healthTimeoutMs ?? 1_000
  }))
    ? "online"
    : "offline";
  const controlPlaneAlertState = await loadControlPlaneAlertState({
    config: input.config,
    dispatcher,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const routingState = await loadRoutingState({
    config: input.config,
    dispatcher,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });

  const platforms = Object.entries(input.config.platforms)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  const executors = input.config.daemon.repositories.map((repository) => repository.defaultExecutor);
  return {
    configPath: input.configPath,
    dispatcher,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    runtimeMode: runtimeModeFromConfig(input.config),
    ...(relayUrl ? { relayUrl } : {}),
    relaySecurity: formatRelaySecurityChecks(relaySecurityChecksFromConfig(input.config)),
    controlPlaneAlerts: controlPlaneAlertState.alerts,
    ...(controlPlaneAlertState.error ? { controlPlaneAlertsError: controlPlaneAlertState.error } : {}),
    runnerId: input.config.daemon.runnerId,
    runTimeoutPolicy: formatRunTimeoutPolicy(input.config.daemon.runTimeoutMs),
    secrets: formatSecretReadiness(input.secretConfig ?? redactedCliConfig(input.config)),
    repositories: input.config.daemon.repositories.map((repository) => {
      return formatConfiguredProjectTargetSummary(repository);
    }),
    platforms,
    agentSessionProfile: formatAgentSessionProfile(input.config.daemon.agentSessionProfile),
    capabilities: formatConfiguredCapabilities({
      platforms: platforms as PlatformId[],
      executors
    }),
    runnerDirectory: routingState.runners,
    ...(routingState.runnersError ? { runnerDirectoryError: routingState.runnersError } : {}),
    ...(routingState.metrics ? { acceptedProgressMetrics: routingState.metrics } : {}),
    ...(routingState.metricsError ? { acceptedProgressMetricsError: routingState.metricsError } : {})
  };
}

async function loadRoutingState(input: {
  config: OpenTagCliConfig;
  dispatcher: "online" | "offline";
  fetchImpl?: typeof fetch;
}): Promise<{
  runners: RunnerDirectoryEntry[];
  runnersError?: string;
  metrics?: AcceptedProgressMetrics;
  metricsError?: string;
}> {
  if (input.dispatcher !== "online") return { runners: [] };
  assertHostedStatusAuth(input.config);
  const token = runnerDispatcherToken(input.config.daemon);
  const client = createOpenTagClient({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(token ? { pairingToken: token } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const [runners, metrics] = await Promise.allSettled([
    client.listRunners(),
    client.getAcceptedProgressMetrics()
  ]);
  return {
    runners: runners.status === "fulfilled" ? runners.value.runners : [],
    ...(runners.status === "rejected"
      ? { runnersError: runners.reason instanceof Error ? runners.reason.message : String(runners.reason) }
      : {}),
    ...(metrics.status === "fulfilled" ? { metrics: metrics.value.metrics } : {}),
    ...(metrics.status === "rejected"
      ? { metricsError: metrics.reason instanceof Error ? metrics.reason.message : String(metrics.reason) }
      : {})
  };
}

async function loadControlPlaneAlertState(input: {
  config: OpenTagCliConfig;
  dispatcher: "online" | "offline";
  fetchImpl?: typeof fetch;
}): Promise<{ alerts: ControlPlaneAlert[]; error?: string }> {
  if (input.dispatcher !== "online") return { alerts: [] };
  assertHostedStatusAuth(input.config);
  try {
    const token = runnerDispatcherToken(input.config.daemon);
    const client = createOpenTagClient({
      dispatcherUrl: input.config.daemon.dispatcherUrl,
      ...(token ? { pairingToken: token } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
    });
    const result = await client.listControlPlaneAlerts({ limit: 5 });
    return { alerts: Array.isArray(result.alerts) ? result.alerts : [] };
  } catch (error) {
    return { alerts: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getRunStatusSummary(input: {
  runId: string;
  configPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<RunStatusSummary> {
  const configPath = input.configPath ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  return runStatusFromConfig({
    config,
    configPath,
    runId: input.runId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

export async function getChannelStatusSummary(input: {
  channel: string;
  configPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<ChannelStatusSummary> {
  const configPath = input.configPath ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  return channelStatusFromConfig({
    config,
    configPath,
    channel: input.channel,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

export async function getWorkstreamStatusSummary(input: {
  workstreamId: string;
  configPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkstreamStatusSummary> {
  const configPath = input.configPath ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  return workstreamStatusFromConfig({
    config,
    configPath,
    workstreamId: input.workstreamId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

export async function getWorkThreadStatusSummary(input: {
  workThreadId: string;
  configPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkThreadStatusSummary> {
  const configPath = input.configPath ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  return workThreadStatusFromConfig({
    config,
    configPath,
    workThreadId: input.workThreadId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

export async function getWorkLoopAttentionStatusSummary(input: {
  configPath?: string;
  fetchImpl?: typeof fetch;
  limit?: number;
} = {}): Promise<WorkLoopAttentionStatusSummary> {
  const configPath = input.configPath ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  return workLoopAttentionStatusFromConfig({
    config,
    configPath,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.limit ? { limit: input.limit } : {})
  });
}

function governanceStatusClient(input: {
  config: OpenTagCliConfig;
  fetchImpl?: typeof fetch;
}) {
  assertHostedStatusAuth(input.config);
  const token = input.config.daemon.controlRegistration
    ? runnerDispatcherToken(input.config.daemon)
    : input.config.daemon.pairingToken ?? runnerDispatcherToken(input.config.daemon);
  return createOpenTagClient({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(token ? { pairingToken: token } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

export async function workThreadStatusFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  workThreadId: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkThreadStatusSummary> {
  const result = await governanceStatusClient(input).getWorkThreadCompletion({ workThreadId: input.workThreadId });
  return {
    configPath: input.configPath,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...result
  };
}

export async function workLoopAttentionStatusFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  fetchImpl?: typeof fetch;
  limit?: number;
}): Promise<WorkLoopAttentionStatusSummary> {
  const result = await governanceStatusClient(input).listWorkLoopsRequiringAttention({ limit: input.limit ?? 25 });
  return {
    configPath: input.configPath,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    workLoops: result.workLoops,
    scanned: result.scanned,
    scanLimitReached: result.scanLimitReached
  };
}

export async function workstreamStatusFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  workstreamId: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkstreamStatusSummary> {
  assertHostedStatusAuth(input.config);
  const token = runnerDispatcherToken(input.config.daemon);
  const client = createOpenTagClient({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(token ? { pairingToken: token } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const { workstream } = await client.getWorkstream({ id: input.workstreamId });
  const [recipe, metrics, evaluation, alerts] = await Promise.all([
    client.getFactoryRecipeSnapshot({ id: workstream.recipeId, version: workstream.recipeVersion }),
    client.getWorkstreamMetrics({ id: workstream.id }),
    client.getWorkstreamEvaluation({ id: workstream.id }),
    client.listControlPlaneAlerts({ limit: 100 })
  ]);
  return {
    configPath: input.configPath,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    recipe: recipe.recipe,
    workstream,
    metrics: metrics.metrics,
    evaluation: evaluation.evaluation,
    alerts: alerts.alerts.filter((alert) =>
      alert.subject === workstream.id || alert.subject === `workstream:${workstream.id}`
    )
  };
}

export async function channelStatusFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  channel: string;
  fetchImpl?: typeof fetch;
}): Promise<ChannelStatusSummary> {
  assertHostedStatusAuth(input.config);
  const channel = parseChannelRef(input.channel);
  const token = runnerDispatcherToken(input.config.daemon);
  const client = createOpenTagClient({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(token ? { pairingToken: token } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  return {
    configPath: input.configPath,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    runTimeoutPolicy: formatRunTimeoutPolicy(input.config.daemon.runTimeoutMs),
    ...channel,
    status: await client.getChannelRuntimeStatus(channel)
  };
}

export async function runStatusFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  runId: string;
  fetchImpl?: typeof fetch;
}): Promise<RunStatusSummary> {
  assertHostedRunStatusAuth(input.config);
  const runnerToken = runnerDispatcherToken(input.config.daemon);
  const runtimeToken = input.config.daemon.controlRegistration
    ? input.config.daemon.runnerToken
    : runnerToken;
  const runnerClient = createOpenTagClient({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(runtimeToken ? { pairingToken: runtimeToken } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const governanceToken = input.config.daemon.controlRegistration
    ? runtimeToken
    : input.config.daemon.pairingToken;
  const completionRequest = governanceToken
    ? createOpenTagClient({
        dispatcherUrl: input.config.daemon.dispatcherUrl,
        pairingToken: governanceToken,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
      }).getCompletion({ runId: input.runId }).catch((error: unknown) => {
        if (isCompletionNotAvailable(error)) return undefined;
        throw error;
      })
    : Promise.resolve(undefined);
  const [claimed, events, metrics, ledger, completion] = await Promise.all([
    runnerClient.getRun({ runId: input.runId }),
    runnerClient.listRunEvents({ runId: input.runId }),
    runnerClient.getRunMetrics({ runId: input.runId }),
    runnerClient.getRunLedger({ runId: input.runId }).catch(() => undefined),
    completionRequest
  ]);
  return {
    configPath: input.configPath,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    run: claimed.run,
    event: claimed.event,
    metrics: metrics.metrics,
    runTimeoutPolicy: formatRunTimeoutPolicy(input.config.daemon.runTimeoutMs),
    events: events.events as RunAuditEvent[],
    ...(ledger?.ledger && Array.isArray(ledger.ledger.entries) ? { ledgerEntries: ledger.ledger.entries as RunLedgerEntry[] } : {}),
    ...(completion?.completion ? { completion: completion.completion } : {})
  };
}

function isCompletionNotAvailable(error: unknown): boolean {
  if (!(error instanceof OpenTagClientHttpError) || error.status !== 404) return false;
  try {
    const body = JSON.parse(error.responseBody) as { error?: unknown };
    return body.error === "completion_not_available";
  } catch {
    return false;
  }
}

export function formatStatus(summary: StatusSummary): string {
  return [
    `Config: ${summary.configPath}`,
    `Runtime: ${summary.runtimeMode}`,
    ...(summary.relayUrl ? [`Relay: ${summary.relayUrl}`] : []),
    ...summary.relaySecurity,
    `Dispatcher: ${summary.dispatcher} (${summary.dispatcherUrl})`,
    ...formatControlPlaneAlerts(summary),
    `Runner: ${summary.runnerId}`,
    ...formatRunnerDirectory(summary),
    ...formatAcceptedProgressMetrics(summary),
    `Run Timeout: ${summary.runTimeoutPolicy}`,
    ...summary.secrets,
    ...summary.agentSessionProfile,
    `Platforms: ${summary.platforms.length ? summary.platforms.join(", ") : "none"}`,
    ...summary.capabilities,
    "Project Targets:",
    ...(summary.repositories.length ? summary.repositories.map((repository) => `  ${repository}`) : ["  none"])
  ].join("\n");
}

function formatRunnerDirectory(summary: StatusSummary): string[] {
  if (summary.dispatcher !== "online") return ["Runner Directory:", "  unavailable (dispatcher offline)"];
  if (summary.runnerDirectoryError) return ["Runner Directory:", `  unavailable: ${summary.runnerDirectoryError}`];
  if (!summary.runnerDirectory?.length) return ["Runner Directory:", "  none"];
  return [
    "Runner Directory:",
    ...summary.runnerDirectory.map((runner) => {
      const executors = runner.executors.length ? runner.executors.map((executor) => executor.executorId).join(",") : "legacy-unspecified";
      return `  ${runner.runnerId}: ${runner.readiness.state}; locality=${runner.locality}; capacity=${runner.capacity.active}/${runner.capacity.limit}; executors=${executors}`;
    })
  ];
}

function formatAcceptedProgressMetrics(summary: StatusSummary): string[] {
  if (summary.dispatcher !== "online") {
    return ["Accepted Progress:", "  unavailable (dispatcher offline)"];
  }
  if (summary.acceptedProgressMetricsError) {
    return ["Accepted Progress:", `  unavailable: ${summary.acceptedProgressMetricsError}`];
  }
  const metrics = summary.acceptedProgressMetrics;
  if (!metrics) return [];
  const segment = (label: string, values: AcceptedProgressMetrics["byRunner"]): string[] => [
    `  ${label}:`,
    ...(values.length
      ? values.map((value) => `    ${value.id}: runs=${value.runsWithAcceptedProgress}; gate advances=${value.acceptedGateAdvances}; completed runs=${value.completedRuns}`)
      : ["    none"])
  ];
  return [
    "Accepted Progress:",
    `  total: runs=${metrics.runsWithAcceptedProgress}; gate advances=${metrics.acceptedGateAdvances} (${metrics.attributedAcceptedGateAdvances} attributed, ${metrics.unresolvedAcceptedGateAdvances} unresolved); completed runs=${metrics.completedRuns}`,
    ...segment("by runner", metrics.byRunner),
    ...segment("by executor", metrics.byExecutor)
  ];
}

function formatControlPlaneAlerts(summary: StatusSummary): string[] {
  if (summary.dispatcher !== "online") {
    return ["Control Plane Alerts:", "  unavailable (dispatcher offline)"];
  }
  if (summary.controlPlaneAlertsError) {
    return ["Control Plane Alerts:", `  WARN unavailable: ${summary.controlPlaneAlertsError}`];
  }
  if (summary.controlPlaneAlerts.length === 0) {
    return ["Control Plane Alerts:", "  none"];
  }
  return [
    "Control Plane Alerts:",
    ...summary.controlPlaneAlerts.flatMap((alert) => [
      `  ${alert.severity.toUpperCase()} ${alert.type}: ${alert.subject ?? "unknown"} count=${alert.count} threshold=${alert.threshold} last=${alert.lastSeenAt} - ${alert.reason}`,
      `    Next: ${alert.nextAction}`
    ])
  ];
}

function displayValue(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function formatRunEvent(event: RunAuditEvent): string {
  const createdAt = displayValue(event.createdAt);
  const visibility = displayValue(event.visibility);
  const importance = displayValue(event.importance);
  const message = typeof event.message === "string" && event.message.length > 0 ? ` - ${event.message}` : "";
  return `  ${createdAt} ${visibility}/${importance} ${displayValue(event.type)}${message}`;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function runTerminalSemantics(summary: RunStatusSummary): string[] {
  const terminalEvent = [...summary.events].reverse().find((event) => {
    if (summary.run.status === "cancelled") return event.type === "run.cancel_requested";
    return false;
  });
  const payload = recordFromUnknown(terminalEvent?.payload);
  const terminalReason = payload?.["terminalReason"];
  const terminalSemantics = payload?.["terminalSemantics"];
  if (typeof terminalReason !== "string" || terminalReason.length === 0) return [];
  return [
    `Terminal reason: ${terminalReason}`,
    ...(typeof terminalSemantics === "string" && terminalSemantics.length > 0 ? [`Terminal semantics: ${terminalSemantics}`] : [])
  ];
}

function runSpecificTimeoutPolicy(summary: RunStatusSummary): string | undefined {
  for (const event of [...summary.events].reverse()) {
    if (event.type !== "run.running") continue;
    const payload = recordFromUnknown(event.payload);
    const runTimeoutMs = payload?.["runTimeoutMs"];
    if (typeof runTimeoutMs === "number" && Number.isInteger(runTimeoutMs) && runTimeoutMs > 0) {
      return formatRunTimeoutPolicy(runTimeoutMs);
    }
  }
  return summary.runTimeoutPolicy;
}

function stringFromRecord(record: Record<string, unknown> | null | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function booleanFromRecord(record: Record<string, unknown> | null | undefined, keys: string[]): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function runProvenancePayload(summary: RunStatusSummary): Record<string, unknown> | null {
  const created = summary.events.find((event) => event.type === "run.created");
  const createdProvenance = recordFromUnknown(recordFromUnknown(created?.payload)?.["provenance"]);
  if (createdProvenance) return createdProvenance;

  for (const event of [...summary.events].reverse()) {
    const provenance = recordFromUnknown(recordFromUnknown(event.payload)?.["provenance"]);
    if (provenance) return provenance;
  }
  return null;
}

function sourceDeliveryIdFromMetadata(metadata: Record<string, unknown> | null): string | undefined {
  return stringFromRecord(metadata, [
    "sourceDeliveryId",
    "webhookDeliveryId",
    "deliveryId",
    "githubDeliveryId",
    "githubDeliveryGuid",
    "slackEventId",
    "larkEventId"
  ]);
}

function signatureStateFromMetadata(metadata: Record<string, unknown> | null): string {
  const explicit = stringFromRecord(metadata, ["signatureState", "webhookSignatureState"]);
  if (explicit === "verified" || explicit === "unverified" || explicit === "unknown") return explicit;

  const verified = booleanFromRecord(metadata, ["signatureVerified", "verifiedSignature", "webhookSignatureVerified", "githubSignatureVerified"]);
  if (verified === true) return "verified";
  if (verified === false) return "unverified";
  return "unknown";
}

function projectTargetFromProvenance(provenance: Record<string, unknown> | null): string | undefined {
  const target = recordFromUnknown(provenance?.["projectTarget"]);
  return stringFromRecord(target, ["ref"]);
}

function projectTargetFromEvent(event: OpenTagEvent): string | undefined {
  const ref = projectTargetRefFromEvent(event);
  return ref ? formatProjectTargetRef(ref) : undefined;
}

function admissionLineFromProvenance(provenance: Record<string, unknown> | null): string {
  const admission = recordFromUnknown(provenance?.["admissionDecision"]);
  const action = stringFromRecord(admission, ["action"]) ?? "unknown";
  const reasonCode = stringFromRecord(admission, ["reasonCode"]);
  const activeRunId = stringFromRecord(admission, ["activeRunId"]);
  const eventId = stringFromRecord(admission, ["eventId"]);
  return [
    reasonCode ? `${action} (${reasonCode})` : action,
    ...(activeRunId ? [`activeRun=${activeRunId}`] : []),
    ...(eventId ? [`event=${eventId}`] : [])
  ].join("; ");
}

function claimedRunnerId(summary: RunStatusSummary): string | undefined {
  if (summary.run.assignedRunnerId) return summary.run.assignedRunnerId;
  for (const event of [...summary.events].reverse()) {
    if (event.type !== "run.claimed") continue;
    const runnerId = stringFromRecord(recordFromUnknown(event.payload), ["runnerId"]);
    if (runnerId) return runnerId;
  }
  return undefined;
}

function formatRunProvenance(summary: RunStatusSummary): string[] {
  const provenance = runProvenancePayload(summary);
  const metadata = recordFromUnknown(summary.event.metadata);
  const sourceDeliveryId = stringFromRecord(provenance, ["sourceDeliveryId"]) ?? sourceDeliveryIdFromMetadata(metadata);
  const signatureState = stringFromRecord(provenance, ["signatureState"]) ?? signatureStateFromMetadata(metadata);
  const projectTarget = projectTargetFromProvenance(provenance) ?? projectTargetFromEvent(summary.event);
  const expectedRunnerId = stringFromRecord(provenance, ["expectedRunnerId"]);
  return [
    "Provenance:",
    `  Source delivery: ${sourceDeliveryId ?? "unknown"}`,
    `  Signature: ${signatureState}`,
    `  Project Target: ${projectTarget ?? "unknown"}`,
    `  Admission: ${admissionLineFromProvenance(provenance)}`,
    `  Expected runner: ${expectedRunnerId ?? "unbound"}`,
    `  Claimed runner: ${claimedRunnerId(summary) ?? "none"}`
  ];
}

function routingDecisionFromSummary(summary: RunStatusSummary): RoutingDecision | undefined {
  for (const event of [...summary.events].reverse()) {
    if (event.type !== "routing.decided") continue;
    const parsed = RoutingDecisionSchema.safeParse(event.payload);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function formatRunRouting(summary: RunStatusSummary): string[] {
  const decision = routingDecisionFromSummary(summary);
  if (!decision) return ["Routing:", "  no structured routing decision recorded (legacy run)"];
  return [
    "Routing:",
    `  Decision: ${decision.reasonCode} - ${decision.reason}`,
    `  Selected: ${decision.selected ? `${decision.selected.runnerId}/${decision.selected.executorId}` : "none"}`,
    ...decision.candidates.map((candidate) => {
      const state = candidate.eligible ? "eligible" : "rejected";
      const capacity = candidate.capacity ? `; capacity=${candidate.capacity.active}/${candidate.capacity.limit}` : "";
      return `  ${state} ${candidate.runnerId}/${candidate.executorId}${capacity}: ${candidate.reasons.map((reason) => reason.code).join(", ")}`;
    })
  ];
}

function livenessGuidance(strategy: PlatformLivenessStrategy | "default_delivery"): string {
  if (strategy === "status_update") return "source thread can receive concise status/progress updates.";
  if (strategy === "source_receipt") return "source thread uses native receipts first; routine progress stays in audit/status.";
  if (strategy === "pull_status") return "source thread stays quiet by default; pull detail with /status or this command.";
  if (strategy === "thread_reply") return "source thread uses concise thread replies for liveness.";
  return "source-thread delivery follows provider default behavior.";
}

function formatRunLiveness(summary: RunStatusSummary): string[] {
  const provider = summary.event.callback.provider;
  const capability = platformCapabilityForProvider(provider);
  const strategy = capability?.livenessStrategy ?? "default_delivery";
  return ["Liveness:", `  Provider: ${provider} (${strategy})`, `  Progress delivery: ${livenessGuidance(strategy)}`];
}

function formatDelivery(summary: RunStatusSummary): string[] {
  const count = (type: string) => summary.events.filter((event) => event.type === type).length;
  const blocked = count("delivery.activation_blocked");
  return ["Delivery:", `  intents queued: ${count("delivery.intent.queued")}`, `  activation blocked: ${blocked}`, "  Provider outcomes: unavailable in the run event read model.", ...(blocked ? ["  Attention: delivery activation was blocked; no provider I/O was attempted."] : [])];
}

function formatRunResult(run: OpenTagRun): string[] {
  if (!run.result) return [];
  const lines = ["Result:", `  summary: ${run.result.summary}`];
  if (run.result.changedFiles?.length) {
    lines.push(`  changed files: ${run.result.changedFiles.join(", ")}`);
  }
  if (run.result.artifacts?.length) {
    lines.push("  artifacts:");
    for (const artifact of run.result.artifacts) {
      lines.push(`    - ${artifact.kind ? `${artifact.kind}: ` : ""}${artifact.title}: ${artifact.uri}`);
    }
  }
  if (run.result.verification?.length) {
    lines.push("  verification:");
    for (const check of run.result.verification) {
      lines.push(`    - ${check.command}: ${check.outcome}`);
    }
  }
  return lines;
}

function formatRunContextPacket(run: OpenTagRun): string[] {
  const packet = run.contextPacket;
  if (!packet) return ["Context Packet:", "  none"];
  const lines = ["Context Packet:", `  summary: ${packet.summary}`];
  if (packet.intent) {
    lines.push(`  intent: ${packet.intent.normalizedIntent}`);
    lines.push(`  requested by: ${packet.intent.requestedBy.provider}:${packet.intent.requestedBy.providerUserId}`);
  }
  const visibleSources = packet.sources?.slice(0, 4) ?? [];
  if (visibleSources.length > 0) {
    lines.push(`  sources: ${packet.sources?.length ?? 0}`);
    for (const source of visibleSources) {
      lines.push(`    - ${source.included ? "included" : "excluded"} ${source.role}: ${source.pointer.uri} (${source.reason})`);
    }
  } else if (packet.sourcePointers.length > 0) {
    lines.push(`  source pointers: ${packet.sourcePointers.length}`);
    for (const pointer of packet.sourcePointers.slice(0, 4)) {
      lines.push(`    - ${pointer.kind}: ${pointer.uri}`);
    }
  }
  if (packet.facts?.length) lines.push(`  facts: ${packet.facts.slice(0, 3).map((fact) => fact.text).join("; ")}`);
  if (packet.risks?.length) lines.push(`  risks: ${packet.risks.slice(0, 3).join("; ")}`);
  if (packet.exclusions?.length) lines.push(`  exclusions: ${packet.exclusions.slice(0, 3).join("; ")}`);
  if (packet.mustPreserve?.length) lines.push(`  must preserve: ${packet.mustPreserve.slice(0, 3).join("; ")}`);
  if (packet.redactions?.length) lines.push(`  redactions: ${packet.redactions.map((redaction) => redaction.reason).slice(0, 3).join("; ")}`);
  if (packet.assembly?.stages.length) {
    lines.push(`  assembly: ${packet.assembly.stages.join(" -> ")}${packet.assembly.emittedAt ? ` at ${packet.assembly.emittedAt}` : ""}`);
  }
  return lines;
}

function ledgerCategoryForStatus(type: unknown): string {
  if (typeof type !== "string") return "audit";
  if (type === "source_event.received") return "source_event";
  if (type.startsWith("admission.")) return "admission";
  if (type.startsWith("context_packet.")) return "context_packet";
  if (type.startsWith("routing.")) return "routing";
  if (type.startsWith("executor.capability.")) return "executor_capability";
  if (type.startsWith("delivery.")) return "delivery";
  if (type.startsWith("approval.")) return "approval_decision";
  if (type.startsWith("apply_plan.")) return "apply_plan";
  if (type.startsWith("artifact.") || type.startsWith("proposal.snapshot.")) return "artifact";
  if (type === "run.completed") return "final_outcome";
  if (type === "run.cancelled" || type.includes(".cancel")) return "cancellation";
  if (type.includes("timeout") || type === "run.timed_out") return "timeout";
  if (type === "run.progress") return "progress_visibility";
  if (type.startsWith("run.")) return "lifecycle";
  if (type.startsWith("security.") || type.endsWith(".failed")) return "error";
  return "audit";
}

function ledgerCategoryForEntry(event: RunLedgerEntry): string {
  return typeof event.category === "string" && event.category.length > 0 ? event.category : ledgerCategoryForStatus(event.type);
}

function formatAgentWorkLedger(summary: RunStatusSummary): string[] {
  const ledgerEvents: RunLedgerEntry[] =
    summary.ledgerEntries ??
    [
      {
        type: "source_event.received",
        visibility: "audit",
        importance: "normal",
        message: `${summary.event.source} source event ${summary.event.sourceEventId} received.`,
        createdAt: summary.event.receivedAt,
        category: "source_event"
      },
      ...summary.events
    ];
  const categories = new Map<string, number>();
  for (const event of ledgerEvents) {
    const category = ledgerCategoryForEntry(event);
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const counts = [...categories.entries()].map(([category, count]) => `${category}=${count}`).join(", ");
  return [
    "Agent Work Ledger:",
    `  entries: ${ledgerEvents.length}${counts ? ` (${counts})` : ""}`,
    ...ledgerEvents.slice(-6).map((event) => {
      const type = typeof event.type === "string" ? event.type : "unknown";
      const message = typeof event.message === "string" ? ` - ${event.message}` : "";
      return `  ${ledgerCategoryForEntry(event)}: ${type}${message}`;
    })
  ];
}

export function formatRunStatus(summary: RunStatusSummary): string {
  const latestEvents = summary.events.slice(-5);
  const conclusion = summary.run.result?.conclusion;
  const timeoutPolicy = runSpecificTimeoutPolicy(summary);
  return [
    `Config: ${summary.configPath}`,
    `Dispatcher: ${summary.dispatcherUrl}`,
    `Run: ${summary.run.id}`,
    `Status: ${summary.run.status}${conclusion ? ` (${conclusion})` : ""}`,
    ...(timeoutPolicy ? [`Run Timeout: ${timeoutPolicy}`] : []),
    ...runTerminalSemantics(summary),
    `Source: ${summary.event.source} (${summary.event.sourceEventId})`,
    ...formatRunProvenance(summary),
    ...formatRunRouting(summary),
    `Command: ${summary.event.command.rawText}`,
    `Updated: ${summary.run.updatedAt}`,
    ...formatRunContextPacket(summary.run),
    ...formatRunResult(summary.run),
    ...(summary.completion ? formatCompletionExplanation(summary.completion) : []),
    `Metrics: ${summary.metrics.totalEventCount} events, ${summary.metrics.suggestedChangesCount} suggested action(s), ${summary.metrics.applyPlanCount} apply plan(s), ${summary.metrics.staleIntentCount} stale intent(s)`,
    ...formatAgentWorkLedger(summary),
    ...formatRunLiveness(summary),
    ...formatDelivery(summary),
    "Recent Events:",
    ...(latestEvents.length ? latestEvents.map(formatRunEvent) : ["  none"])
  ].join("\n");
}

export function formatCompletionExplanation(completion: CompletionExplanation): string[] {
  const current = completion.currentAssessment;
  const lineage = completion.assessmentHistory
    .map((assessment) => `${assessment.sequence}:${assessment.id}${assessment.supersedesAssessmentId ? `<-${assessment.supersedesAssessmentId}` : ""}`)
    .join(" -> ");
  return [
    "Completion Governance:",
    `  Execution: ${completion.execution}`,
    `  Completion: ${completion.completion}`,
    `  Contract: ${completion.contract.id} v${completion.contract.version} cycle=${completion.contract.cycle} mode=${completion.contract.mode}`,
    `  Current assessment: ${current.id} sequence=${current.sequence}${current.acceptedAt ? ` accepted=${current.acceptedAt}` : ""}`,
    `  Assessment lineage: ${lineage || "none"}`,
    "  Gates:",
    ...current.gateResults.map((gate) =>
      `    ${gate.gateId}: ${gate.state} (${gate.reasonCode}) - ${gate.reason}`
    ),
    "  Evidence:",
    ...(completion.evidence.length
      ? completion.evidence.map((item) =>
          `    ${item.id}: ${item.kind} assurance=${item.assurance} subject=${item.subject.resourceRef}@${item.subject.resourceVersion} provider=${item.subject.provider}`
        )
      : ["    none"]),
    `  Missing requirements: ${completion.missingGateIds.length ? completion.missingGateIds.join(", ") : "none"}`,
    `  Failed requirements: ${completion.failedGateIds.length ? completion.failedGateIds.join(", ") : "none"}`,
    `  Blocked requirements: ${completion.blockedGateIds.length ? completion.blockedGateIds.join(", ") : "none"}`,
    "  Open human escalations:",
    ...(completion.openHumanEscalations.length
      ? completion.openHumanEscalations.map((escalation) =>
          `    ${escalation.id}: ${escalation.class}/${escalation.state} - ${escalation.summary}`
        )
      : ["    none"]),
    `  Next action: ${completion.nextAction.summary}`
  ];
}

function workLoopCauseLabel(cause: WorkLoopAttentionItem["completion"]["nextAction"]["causes"][number]): string {
  if (cause.kind === "completion_gate") {
    return `gate:${cause.gateId}/${cause.state}/${cause.reasonCode}`;
  }
  if (cause.kind === "human_escalation") {
    return `escalation:${cause.escalationId}/${cause.class}/${cause.audience}`;
  }
  if (cause.kind === "material_action") {
    return `action:${cause.actionId}/${cause.outcome}`;
  }
  return `run:${cause.runId}/${cause.conclusion}`;
}

function workThreadReference(workThread: EnsuredWorkThread): string {
  const reference = workThread.workItemReference;
  return `${reference.provider}:${reference.kind}:${reference.externalId}`;
}

export function formatWorkThreadStatus(summary: WorkThreadStatusSummary): string {
  const progressLines = summary.acceptedProgress
    ? [
        "Accepted Progress:",
        `  gate advances: ${summary.acceptedProgress.acceptedGateAdvanceCount} (${summary.acceptedProgress.attributedGateAdvanceCount} attributed, ${summary.acceptedProgress.unresolvedGateAdvanceCount} unresolved)`,
        `  contributing runs: ${summary.acceptedProgress.runIdsWithAcceptedProgress.join(", ") || "none"}`,
        ...summary.acceptedProgress.advances.map((advance) => advance.resolution.status === "attributed"
          ? `  ${advance.gateId}: run=${advance.resolution.sourceRunId}; artifact=${advance.resolution.artifactId}; assessment=${advance.assessmentId}`
          : `  ${advance.gateId}: unresolved=${advance.resolution.reasonCode}; assessment=${advance.assessmentId}`)
      ]
    : ["Accepted Progress:", "  unavailable (no current CompletionAssessment attribution)"];
  return [
    `Config: ${summary.configPath}`,
    `Dispatcher: ${summary.dispatcherUrl}`,
    `WorkThread: ${summary.workThread.id}`,
    `Work item: ${workThreadReference(summary.workThread)}`,
    `Control anchor: ${summary.workThread.primaryAnchor.provider}:${summary.workThread.primaryAnchor.kind}:${summary.workThread.primaryAnchor.externalId}`,
    ...formatCompletionExplanation(summary.completion),
    `  Action hint: ${summary.completion.nextAction.hint.kind}${summary.completion.nextAction.hint.targetId ? ` target=${summary.completion.nextAction.hint.targetId}` : ""}`,
    `  Causes: ${summary.completion.nextAction.causes.length ? summary.completion.nextAction.causes.map(workLoopCauseLabel).join(", ") : "none"}`,
    ...progressLines
  ].join("\n");
}

export function workThreadStatusJson(summary: WorkThreadStatusSummary): Record<string, unknown> {
  return {
    workThread: summary.workThread,
    completion: summary.completion,
    acceptedProgress: summary.acceptedProgress
  };
}

export function formatWorkLoopAttentionStatus(summary: WorkLoopAttentionStatusSummary): string {
  return [
    `Work loops requiring attention: ${summary.workLoops.length} (scanned ${summary.scanned})`,
    ...summary.workLoops.flatMap((item) => [
      `  ${item.workThread.id}: ${item.completion.completion}/${item.completion.execution} ${workThreadReference(item.workThread)}`,
      `    Next: ${item.completion.nextAction.summary}`,
      `    Hint: ${item.completion.nextAction.hint.kind}${item.completion.nextAction.hint.targetId ? ` target=${item.completion.nextAction.hint.targetId}` : ""}`,
      `    Causes: ${item.completion.nextAction.causes.map(workLoopCauseLabel).join(", ") || "none"}`
    ]),
    ...(summary.scanLimitReached ? ["  More WorkThreads may exist beyond the bounded scan; narrow by --work-thread when you have an id."] : []),
    `Config: ${summary.configPath}`,
    `Dispatcher: ${summary.dispatcherUrl}`
  ].join("\n");
}

export function workLoopAttentionStatusJson(summary: WorkLoopAttentionStatusSummary): Record<string, unknown> {
  return {
    attention: "required",
    workLoops: summary.workLoops,
    scanned: summary.scanned,
    scanLimitReached: summary.scanLimitReached
  };
}

function workstreamNextAction(summary: WorkstreamStatusSummary): string {
  if (summary.evaluation.status === "blocked") {
    return "Resolve the blocking budget violations before admitting or claiming more work.";
  }
  if (summary.evaluation.status === "attention_required") {
    return "Review the bounded exception summary and address the affected runs.";
  }
  if (summary.metrics.acceptedWorkThreadCount === 0) {
    return "Wait for governed completion evidence; no work thread has an accepted outcome yet.";
  }
  return "No action required; continue monitoring accepted outcomes.";
}

function formatWorkstreamExceptions(summary: WorkstreamStatusSummary): string[] {
  const violations = summary.evaluation.violations.slice(0, 5);
  const alerts = summary.alerts.slice(0, 5);
  if (violations.length === 0 && alerts.length === 0) return [];
  return [
    "Exceptions:",
    ...violations.map((violation) =>
      `  budget: ${violation.code} - ${violation.message} (actual=${violation.actual}${violation.limit !== undefined ? `, limit=${violation.limit}` : ""})`
    ),
    ...(summary.evaluation.violations.length > violations.length
      ? [`  budget: ${summary.evaluation.violations.length - violations.length} more violation(s) omitted`]
      : []),
    ...alerts.map((alert) => `  alert: ${alert.severity}/${alert.type} - ${alert.reason}; next=${alert.nextAction}`),
    ...(summary.alerts.length > alerts.length ? [`  alert: ${summary.alerts.length - alerts.length} more alert(s) omitted`] : [])
  ];
}

export function formatWorkstreamStatus(summary: WorkstreamStatusSummary): string {
  const { budgets } = summary.recipe;
  const metrics = summary.metrics;
  return [
    `Workstream: ${summary.workstream.id} (${summary.workstream.name})`,
    `State: ${summary.evaluation.status}`,
    `Next action: ${workstreamNextAction(summary)}`,
    "Completion Authority:",
    `  accepted work threads: ${metrics.acceptedWorkThreadCount}/${metrics.workThreadCount}`,
    "Accepted Progress:",
    `  gate advances: ${metrics.acceptedGateAdvanceCount} (${metrics.attributedGateAdvanceCount} attributed, ${metrics.unresolvedGateAdvanceCount} unresolved)`,
    `  contributing runs: ${metrics.runsWithAcceptedProgressCount}`,
    "Budget:",
    `  concurrency: ${metrics.activeRunCount}/${budgets.maxConcurrentRuns}; blocked runs=${metrics.budgetBlockedRunCount}`,
    `  attempts: ${metrics.totalAttempts}; per-run limit=${budgets.maxAttemptsPerRun}; exceeded runs=${metrics.attemptsPerRunExceededCount}`,
    `  cost units: ${metrics.totalCostUnits}/${budgets.maxCostUnits}; per attempt=${budgets.costUnitsPerAttempt}`,
    `  allowed localities: ${budgets.allowedLocalities.join(", ")}`,
    ...formatWorkstreamExceptions(summary),
    "Details:",
    `  recipe: ${summary.recipe.id}@${summary.recipe.version} (${summary.recipe.name})`,
    `  members: ${summary.workstream.members.length}`,
    `  runs: ${metrics.runCount}; queued=${metrics.queuedRunCount}; active=${metrics.activeRunCount}; needs-human=${metrics.needsHumanRunCount}; terminal=${metrics.terminalRunCount}; failed=${metrics.failedRunCount}`,
    `  attempts by locality: local=${metrics.attemptsByLocality.local}; private=${metrics.attemptsByLocality.private}; hosted=${metrics.attemptsByLocality.hosted}; unknown=${metrics.attemptsByLocality.unknown}`,
    `  evaluated: ${summary.evaluation.evaluatedAt}`,
    `  config: ${summary.configPath}`,
    `  dispatcher: ${summary.dispatcherUrl}`
  ].join("\n");
}

export function workstreamStatusJson(summary: WorkstreamStatusSummary): Record<string, unknown> {
  return {
    state: summary.evaluation.status,
    nextAction: workstreamNextAction(summary),
    workstream: summary.workstream,
    recipe: summary.recipe,
    metrics: summary.metrics,
    evaluation: summary.evaluation,
    alerts: summary.alerts
  };
}

function projectTargetLabel(input: ChannelRuntimeStatus["binding"]): string | undefined {
  if (!input.repoProvider || !input.owner || !input.repo) return undefined;
  return `${input.repoProvider}:${input.owner}/${input.repo}`;
}

export function formatChannelStatus(summary: ChannelStatusSummary): string {
  const activeRun = summary.status.activeRun;
  const runTimeoutPolicy = summary.status.runTimeoutPolicy?.hardTimeoutMs
    ? formatRunTimeoutPolicy(summary.status.runTimeoutPolicy.hardTimeoutMs)
    : summary.runTimeoutPolicy;
  const projectTarget = projectTargetLabel(summary.status.binding);
  const statusPresentation = createSourceThreadStatusPresentation({
    title: "OpenTag status:",
    sourceContainer: `${summary.provider}:${summary.accountId}/${summary.conversationId}`,
    ...(projectTarget ? { projectTarget } : {}),
    bindingState: "bound",
    ...(activeRun
      ? {
          activeRun: {
            id: activeRun.id,
            status: activeRun.status,
            updatedAt: activeRun.updatedAt
          }
        }
      : {}),
    ...(summary.status.activeEvent?.command.rawText ? { currentCommand: summary.status.activeEvent.command.rawText } : {}),
    queuedFollowUps: summary.status.queuedFollowUps.slice(0, 5).map((followUp) => ({
      id: followUp.id,
      status: followUp.status,
      command: followUp.event.command.rawText
    })),
    queuedFollowUpsTotal: summary.status.queuedFollowUps.length,
    nextAction: activeRun
      ? `wait for the final reply, send a source-thread follow-up, or request cancellation with \`opentag cancel --run ${activeRun.id}\` or source-thread /stop.`
      : "mention the bot in the bound source container to start a run.",
    stopHint: `cancellation is explicit and is not reported as successful completion; timeout policy: ${runTimeoutPolicy}.`,
    detailHint: activeRun
      ? `use \`opentag status --run ${activeRun.id}\` locally for audit events and executor detail.`
      : `use \`opentag status --channel ${summary.provider}:${summary.accountId}/${summary.conversationId}\` to refresh this source-container view.`
  });
  return [
    `Config: ${summary.configPath}`,
    `Dispatcher: ${summary.dispatcherUrl}`,
    renderOpenTagPresentationPlainText(statusPresentation)
  ].join("\n");
}

export async function runStatusCommand(options: StatusCommandOptions): Promise<void> {
  const selectors = [options.run, options.channel, options.workstream, options.workThread, options.attention ? "attention" : undefined]
    .filter(Boolean);
  if (selectors.length > 1) {
    throw new Error("Use only one of --run, --channel, --workstream, --work-thread, or --attention.");
  }
  if (options.json && !options.workstream && !options.workThread && !options.attention) {
    throw new Error("Use --json with --workstream, --work-thread, or --attention.");
  }
  if (options.workstream) {
    const summary = await getWorkstreamStatusSummary({
      workstreamId: options.workstream,
      ...(options.config ? { configPath: options.config } : {})
    });
    console.log(options.json ? JSON.stringify(workstreamStatusJson(summary), null, 2) : formatWorkstreamStatus(summary));
    return;
  }
  if (options.workThread) {
    const summary = await getWorkThreadStatusSummary({
      workThreadId: options.workThread,
      ...(options.config ? { configPath: options.config } : {})
    });
    console.log(options.json ? JSON.stringify(workThreadStatusJson(summary), null, 2) : formatWorkThreadStatus(summary));
    return;
  }
  if (options.attention) {
    const summary = await getWorkLoopAttentionStatusSummary({
      ...(options.config ? { configPath: options.config } : {})
    });
    console.log(options.json
      ? JSON.stringify(workLoopAttentionStatusJson(summary), null, 2)
      : formatWorkLoopAttentionStatus(summary));
    return;
  }
  if (options.run) {
    console.log(formatRunStatus(await getRunStatusSummary({ runId: options.run, ...(options.config ? { configPath: options.config } : {}) })));
    return;
  }
  if (options.channel) {
    console.log(
      formatChannelStatus(await getChannelStatusSummary({ channel: options.channel, ...(options.config ? { configPath: options.config } : {}) }))
    );
    return;
  }
  console.log(formatStatus(await getStatusSummary({ ...(options.config ? { configPath: options.config } : {}) })));
}
