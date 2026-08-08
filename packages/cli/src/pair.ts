import { randomUUID } from "node:crypto";
import { createOpenTagClient, OpenTagControlV1HttpError, type OpenTagClient } from "@opentag/client";
import {
  RunnerCredentialReprovisionRequestV1Schema,
  RunnerRegistrationRequestV1Schema,
  type RunnerCredentialResponseV1
} from "@opentag/core";
import {
  HostedControlRegistrationSchema,
  type HostedControlRegistration,
  type HostedControlRegistrationMetadata,
  type TrustedRelayAuthorizationV1
} from "@opentag/local-runtime";
import {
  defaultConfigPath,
  readCliConfig,
  readCliRawConfig,
  writeCliConfigAtomic,
  writeHostedControlConfigAtomic,
  type OpenTagCliConfig
} from "./config.js";
import {
  evaluateRelayIngressCapability,
  probeDispatcherHealth,
  probeRelayCapabilities,
  type RelayIngressRequirement
} from "./health.js";
import { formatConfiguredProjectTargetSummary } from "./project-target-summary.js";
import {
  TrustedRelayAuthorizationV1Schema,
  assertRelayTransportAllowed,
  canonicalHostedRelayOrigin,
  relayTrustWarning
} from "./relay-security.js";
import { bootstrapLocalDispatcher, type BootstrapClient } from "./start.js";

export type PairCommandOptions = {
  config?: string;
  relay?: string;
  register?: boolean;
  recover?: string;
  trustRelayOrigin?: string;
};

export type PairRelayDependencies = {
  createControlClient?: (options: Parameters<typeof createOpenTagClient>[0]) => Pick<
    OpenTagClient,
    "getRelayCapabilitiesControlV1" | "registerRunnerControlV1" | "reprovisionRunnerControlV1"
  >;
  fetchImpl?: typeof fetch;
  bootstrapClient?: BootstrapClient;
  logger?: Pick<Console, "log" | "warn">;
  healthTimeoutMs?: number;
  randomUUID?: () => string;
  now?: () => Date;
  readConfig?: typeof readCliConfig;
  readRawConfig?: typeof readCliRawConfig;
  readRecoverySecret?: () => string | undefined;
  writeConfig?: typeof writeCliConfigAtomic;
  writeHostedConfig?: typeof writeHostedControlConfigAtomic;
};

type PairRelaySummaryInput = {
  configPath: string;
  config: OpenTagCliConfig;
  relayUrl: string;
  registered: boolean;
};

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function normalizeRelayUrl(rawRelayUrl: string): string {
  const raw = rawRelayUrl.trim();
  if (!raw) {
    throw new Error("Relay URL must not be empty.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Relay URL must be a valid http or https URL: ${rawRelayUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Relay URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Relay URL must not include credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Relay URL must not include a query string or fragment.");
  }
  return stripTrailingSlash(url.toString());
}

export function inferRelayProvider(relayUrl: string): string {
  const hostname = new URL(relayUrl).hostname.toLowerCase();
  return hostname.includes("railway") ? "railway" : "custom";
}

export function relayConfigFrom(input: { config: OpenTagCliConfig; relayUrl: string }): OpenTagCliConfig {
  const hostedRelay = input.config.daemon.controlRegistration
    ? input.config.daemon.dispatcherUrl
    : undefined;
  if (hostedRelay && hostedRelay !== input.relayUrl) {
    throw new Error(
      `Hosted Control V1 authority is already bound to ${hostedRelay}; re-pairing to a different relay is not allowed.`
    );
  }
  const relayProvider = inferRelayProvider(input.relayUrl);
  return {
    ...input.config,
    runtime: {
      mode: "relay",
      relayUrl: input.relayUrl,
      relayProvider
    },
    daemon: {
      ...input.config.daemon,
      dispatcherUrl: input.relayUrl
    }
  };
}

export function controlRequestIdFromOperationId(operationId: string): string {
  return `request:${operationId}`;
}

function registrationMetadata(response: RunnerCredentialResponseV1): HostedControlRegistrationMetadata {
  return {
    schemaVersion: response.schemaVersion,
    protocolVersion: response.protocolVersion,
    runnerId: response.runnerId,
    registrationGeneration: response.registrationGeneration,
    credentialGeneration: response.credentialGeneration,
    credentialId: response.credentialId,
    credentialPurpose: response.credentialPurpose,
    createdAt: response.createdAt
  };
}

function rawObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rawDaemon(value: unknown): Record<string, unknown> {
  return rawObject(rawObject(value, "OpenTag config").daemon, "OpenTag daemon config");
}

function assertPersistedRegistration(
  readRawConfig: typeof readCliRawConfig,
  path: string,
  expected: HostedControlRegistration,
  trustedRelay: TrustedRelayAuthorizationV1,
  expectedRunnerToken?: string
): void {
  const daemon = rawDaemon(readRawConfig(path));
  if (JSON.stringify(daemon.controlRegistration) !== JSON.stringify(expected)) {
    throw new Error("Hosted Control V1 registration state did not survive atomic config readback.");
  }
  if (JSON.stringify(daemon.trustedRelay) !== JSON.stringify(trustedRelay)) {
    throw new Error("Hosted Control V1 trusted relay authorization did not survive atomic config readback.");
  }
  if (expectedRunnerToken !== undefined && daemon.runnerToken !== expectedRunnerToken) {
    throw new Error("Hosted Control V1 staged runner credential failed atomic config readback.");
  }
}

function writeHostedState(input: {
  configPath: string;
  controlRegistration: HostedControlRegistration;
  readRawConfig: typeof readCliRawConfig;
  relayUrl: string;
  trustedRelay: TrustedRelayAuthorizationV1;
  removePairingToken?: boolean;
  runnerToken?: string | null;
  writeHostedConfig: typeof writeHostedControlConfigAtomic;
}): void {
  input.writeHostedConfig(input.configPath, {
    dispatcherUrl: input.relayUrl,
    relayProvider: inferRelayProvider(input.relayUrl),
    relayUrl: input.relayUrl,
    trustedRelay: input.trustedRelay,
    controlRegistration: input.controlRegistration,
    ...(input.removePairingToken ? { removePairingToken: true } : {}),
    ...(input.runnerToken !== undefined ? { runnerToken: input.runnerToken } : {})
  });
  assertPersistedRegistration(
    input.readRawConfig,
    input.configPath,
    input.controlRegistration,
    input.trustedRelay,
    input.runnerToken === undefined || input.runnerToken === null
      ? undefined
      : input.runnerToken
  );
}

function defaultReadRecoverySecret(): string | undefined {
  return process.env.OPENTAG_RECOVERY_CREDENTIAL;
}

function requireRecoverySecret(readRecoverySecret: () => string | undefined): string {
  const secret = readRecoverySecret()?.trim();
  if (!secret) {
    throw new Error(
      "Runner recovery credential is unavailable; set OPENTAG_RECOVERY_CREDENTIAL and retry with --recover <credentialId>."
    );
  }
  return secret;
}

async function persistStageThenPair(input: {
  configPath: string;
  operationId: string;
  relayUrl: string;
  response: Extract<RunnerCredentialResponseV1, { replayed: false }>;
  readRawConfig: typeof readCliRawConfig;
  trustedRelay: TrustedRelayAuthorizationV1;
  writeHostedConfig: typeof writeHostedControlConfigAtomic;
}): Promise<void> {
  const registration = registrationMetadata(input.response);
  const stagedControl: HostedControlRegistration = {
    kind: "hosted_control_v1",
    state: "credential_staged",
    operationId: input.operationId,
    registration
  };
  writeHostedState({
    configPath: input.configPath,
    controlRegistration: stagedControl,
    readRawConfig: input.readRawConfig,
    relayUrl: input.relayUrl,
    trustedRelay: input.trustedRelay,
    removePairingToken: true,
    runnerToken: input.response.runnerToken,
    writeHostedConfig: input.writeHostedConfig
  });

  const pairedControl: HostedControlRegistration = { ...stagedControl, state: "paired" };
  writeHostedState({
    configPath: input.configPath,
    controlRegistration: pairedControl,
    readRawConfig: input.readRawConfig,
    relayUrl: input.relayUrl,
    trustedRelay: input.trustedRelay,
    removePairingToken: true,
    runnerToken: input.response.runnerToken,
    writeHostedConfig: input.writeHostedConfig
  });
}

function replayRecoveryRequired(
  response: Extract<RunnerCredentialResponseV1, { replayed: true }>
): HostedControlRegistration {
  return {
    kind: "hosted_control_v1",
    state: "unpaired",
    reason: "recovery_required",
    registration: registrationMetadata(response)
  };
}

type HostedPairPlan = {
  controlRegistration: HostedControlRegistration;
  finalizeStagedLocally?: {
    pairedControl: Extract<HostedControlRegistration, { state: "paired" }>;
    runnerToken: string;
  };
  relayOrigin: string;
  trustedRelay: TrustedRelayAuthorizationV1;
  operationId: string;
  recoveryRegistration?: HostedControlRegistrationMetadata;
};

function hostedPairPlan(input: {
  options: PairCommandOptions;
  rawConfig: unknown;
  relayUrl: string;
  operationId: () => string;
  now: () => Date;
}): HostedPairPlan | undefined {
  const daemon = rawDaemon(input.rawConfig);
  const rawControl = daemon.controlRegistration;
  const rawTrust = daemon.trustedRelay;
  const hostedRequested = input.options.trustRelayOrigin !== undefined
    || input.options.recover !== undefined
    || rawControl !== undefined
    || rawTrust !== undefined;
  if (!hostedRequested) return undefined;
  if (input.options.register === false) {
    throw new Error(
      "--no-register is incompatible with Hosted Control V1 registration, recovery, and staged finalization."
    );
  }

  const relayOrigin = canonicalHostedRelayOrigin(input.relayUrl);
  const explicitOrigin = input.options.trustRelayOrigin === undefined
    ? undefined
    : canonicalHostedRelayOrigin(input.options.trustRelayOrigin);
  if (explicitOrigin !== undefined && explicitOrigin !== relayOrigin) {
    throw new Error("--trust-relay-origin must exactly match the canonical --relay origin.");
  }
  const persistedTrust = rawTrust === undefined
    ? undefined
    : TrustedRelayAuthorizationV1Schema.parse(rawTrust);
  if (persistedTrust && persistedTrust.origin !== relayOrigin) {
    throw new Error("Hosted Control V1 is already bound to a different trusted relay origin.");
  }
  if (!persistedTrust && explicitOrigin === undefined) {
    throw new Error(
      "Hosted Control V1 requires --trust-relay-origin <origin>; --relay, --yes, TLS, health, and capabilities do not authorize trust."
    );
  }
  const trustedRelay = persistedTrust ?? TrustedRelayAuthorizationV1Schema.parse({
    schemaVersion: 1,
    origin: explicitOrigin,
    authorizedAt: input.now().toISOString(),
    authorizationMethod: "explicit_cli"
  });
  const control = rawControl === undefined
    ? undefined
    : HostedControlRegistrationSchema.parse(rawControl);

  if (control?.state === "credential_staged") {
    if (input.options.recover !== undefined) {
      throw new Error("Hosted credential staging must be finalized before recovery can begin.");
    }
    const runnerId = daemon.runnerId;
    if (typeof runnerId !== "string" || !runnerId.trim()) {
      throw new Error("Hosted staged credential requires a non-empty raw daemon runnerId.");
    }
    if (control.registration.runnerId !== runnerId) {
      throw new Error("Hosted staged credential runner identity does not match raw daemon runnerId.");
    }
    const runnerToken = daemon.runnerToken;
    if (typeof runnerToken !== "string" || !runnerToken.trim()) {
      throw new Error("Hosted staged credential requires a non-empty inline raw runner token.");
    }
    return {
      controlRegistration: control,
      finalizeStagedLocally: {
        pairedControl: { ...control, state: "paired" },
        runnerToken
      },
      relayOrigin,
      trustedRelay,
      operationId: control.operationId
    };
  }

  if (input.options.recover !== undefined) {
    const recoveryCredentialId = input.options.recover.trim();
    if (!recoveryCredentialId) {
      throw new Error("--recover requires a non-empty recovery credential id.");
    }
    if (
      control?.state === "unpaired"
      && "flow" in control
      && control.flow === "reprovision"
    ) {
      if (control.recoveryCredentialId !== recoveryCredentialId) {
        throw new Error("Hosted recovery is already pending for a different recovery credential id.");
      }
      return {
        controlRegistration: control,
        relayOrigin,
        trustedRelay,
        operationId: control.operationId,
        recoveryRegistration: control.registration
      };
    }
    if (!control || control.state !== "unpaired" || control.reason !== "recovery_required") {
      throw new Error("Hosted recovery requires a persisted recovery-required registration state.");
    }
    const operationId = input.operationId();
    return {
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        flow: "reprovision",
        operationId,
        reason: "pending",
        recoveryCredentialId,
        registration: control.registration
      },
      relayOrigin,
      trustedRelay,
      operationId,
      recoveryRegistration: control.registration
    };
  }

  if (control !== undefined) {
    if (
      control.state === "unpaired"
      && "flow" in control
      && control.flow === "registration"
    ) {
      return {
        controlRegistration: control,
        relayOrigin,
        trustedRelay,
        operationId: control.operationId
      };
    }
    if (control.state === "unpaired" && control.reason === "recovery_required") {
      throw new Error("Hosted Control V1 requires --recover <recoveryCredentialId> for this runner.");
    }
    throw new Error(`Hosted Control V1 pairing cannot start from persisted state ${control.state}.`);
  }

  const operationId = input.operationId();
  return {
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "unpaired",
      flow: "registration",
      operationId,
      reason: "pending"
    },
    relayOrigin,
    trustedRelay,
    operationId
  };
}

function linearRelayIngressRequirement(config: OpenTagCliConfig): RelayIngressRequirement | undefined {
  const linear = config.platforms.linear;
  if (!linear) return undefined;
  if ((linear.webhookPath ?? "/linear/webhooks").startsWith("/linear/webhooks/")) return undefined;
  return {
    provider: "linear",
    path: linear.webhookPath ?? "/linear/webhooks",
    requireCallback: true,
    requireApply: true
  };
}

function formatOptionalRelayEnv(name: string, value: string | undefined): string[] {
  return value ? [`  ${name}=${value}`] : [];
}

export function formatLinearRelayProvisioningHint(config: OpenTagCliConfig): string {
  const linear = config.platforms.linear;
  if (!linear) return "";
  const target = linear.projectTarget;
  if (linear.auth?.method === "hosted_oauth_app") {
    return [
      "Configure the relay process for hosted Linear OAuth installs, then restart the relay and retry pairing:",
      "  OPENTAG_LINEAR_OAUTH_CLIENT_ID=<Linear OAuth app client id>",
      "  OPENTAG_LINEAR_OAUTH_REDIRECT_URI=<relay URL>/linear/oauth/callback",
      "  OPENTAG_LINEAR_OAUTH_CLIENT_SECRET=<optional Linear OAuth app client secret>",
      "  OPENTAG_LINEAR_OAUTH_WEBHOOK_SECRET=<Linear OAuth app webhook signing secret>",
      "  OPENTAG_LINEAR_OAUTH_WEBHOOK_PATH=/linear/oauth/webhooks",
      "Secrets are intentionally not printed here."
    ].join("\n");
  }
  return [
    "Configure the relay process with Linear environment variables, then restart the relay and retry pairing:",
    "  OPENTAG_LINEAR_API_KEY=<Linear OAuth access token or raw lin_api_... key>",
    "  OPENTAG_LINEAR_WEBHOOK_SECRET=<copy platforms.linear.webhookSecret from the local OpenTag config>",
    `  OPENTAG_LINEAR_WEBHOOK_PATH=${linear.webhookPath ?? "/linear/webhooks"}`,
    `  OPENTAG_LINEAR_REPO_PROVIDER=${target?.repoProvider ?? "<Project Target repo provider>"}`,
    `  OPENTAG_LINEAR_REPO_OWNER=${target?.owner ?? "<Project Target owner>"}`,
    `  OPENTAG_LINEAR_REPO_NAME=${target?.repo ?? "<Project Target repo>"}`,
    ...formatOptionalRelayEnv("OPENTAG_LINEAR_GRAPHQL_URL", linear.graphqlUrl),
    "Secrets are intentionally not printed here."
  ].join("\n");
}

export async function validateRelayPlatformCapabilities(input: {
  config: OpenTagCliConfig;
  relayUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<void> {
  const linear = input.config.platforms.linear;
  if (linear?.auth?.method === "hosted_oauth_app") {
    const probe = await probeRelayCapabilities({
      dispatcherUrl: input.relayUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs: input.timeoutMs
    });
    if (probe.status !== "unknown") {
      const platform = probe.capabilities.platforms.find((candidate) => candidate.provider === "linear");
      if (platform?.oauthInstall?.enabled !== true) {
        const reason = platform?.oauthInstall?.reason ?? "Linear hosted OAuth install is not enabled.";
        const hint = formatLinearRelayProvisioningHint(input.config);
        throw new Error(
          `Relay ${input.relayUrl} is not ready for Linear hosted OAuth install: ${reason}${hint ? `\n\n${hint}` : ""}`
        );
      }
      if (platform?.ingress?.enabled !== true) {
        const reason = platform?.ingress?.reason ?? "Linear hosted OAuth webhook ingress is not enabled.";
        const hint = formatLinearRelayProvisioningHint(input.config);
        throw new Error(
          `Relay ${input.relayUrl} is not ready for Linear hosted OAuth webhooks: ${reason}${hint ? `\n\n${hint}` : ""}`
        );
      }
    }
    return;
  }
  const requirement = linearRelayIngressRequirement(input.config);
  if (!requirement) return;

  const probe = await probeRelayCapabilities({
    dispatcherUrl: input.relayUrl,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    timeoutMs: input.timeoutMs
  });
  if (probe.status === "unknown") return;

  const support = evaluateRelayIngressCapability(probe.capabilities, requirement);
  if (!support.ok) {
    const hint = formatLinearRelayProvisioningHint(input.config);
    throw new Error(
      `Relay ${input.relayUrl} is not ready for Linear at ${requirement.path}: ${support.reason}${hint ? `\n\n${hint}` : ""}`
    );
  }
}

function githubRelayWebhookUrl(relayUrl: string): string {
  return `${stripTrailingSlash(relayUrl)}/github/webhooks`;
}

function gitlabRelayWebhookUrl(relayUrl: string, webhookPath = "/gitlab/webhooks"): string {
  return `${stripTrailingSlash(relayUrl)}${webhookPath}`;
}

function linearRelayWebhookUrl(relayUrl: string, webhookPath = "/linear/webhooks"): string {
  return `${stripTrailingSlash(relayUrl)}${webhookPath}`;
}

function discordRelayInteractionsUrl(relayUrl: string, webhookPath = "/discord/interactions"): string {
  return `${stripTrailingSlash(relayUrl)}${webhookPath}`;
}

function teamsRelayWebhookUrl(relayUrl: string, webhookPath = "/teams/messages"): string {
  return `${stripTrailingSlash(relayUrl)}${webhookPath}`;
}

export function formatPairRelaySummary(input: PairRelaySummaryInput): string {
  const projectTargets = input.config.daemon.repositories.map((repository) => {
    return `  ${formatConfiguredProjectTargetSummary(repository)}`;
  });
  const discord = input.config.platforms.discord;
  const teams = input.config.platforms.teams;
  return [
    "OpenTag relay pairing updated.",
    `Config: ${input.configPath}`,
    `Relay: ${input.relayUrl}`,
    `Runner: ${input.config.daemon.runnerId}`,
    `Registration: ${input.registered ? "completed" : "skipped"}`,
    relayTrustWarning(input.relayUrl),
    "Project Targets:",
    ...(projectTargets.length ? projectTargets : ["  none"]),
    ...(input.config.platforms.github ? [`GitHub webhook URL: ${githubRelayWebhookUrl(input.relayUrl)}`] : []),
    ...(input.config.platforms.gitlab
      ? [`GitLab webhook URL: ${gitlabRelayWebhookUrl(input.relayUrl, input.config.platforms.gitlab.webhookPath)}`]
      : []),
    ...(input.config.platforms.linear
      ? [`Linear webhook URL: ${linearRelayWebhookUrl(input.relayUrl, input.config.platforms.linear.webhookPath)}`]
      : []),
    ...(input.config.platforms.linear?.auth?.method === "hosted_oauth_app" && input.config.platforms.linear.auth.authorizationUrl
      ? [`Linear OAuth install URL: ${input.config.platforms.linear.auth.authorizationUrl}`]
      : []),
    ...(discord?.mode === "webhook" ? [`Discord Interactions Endpoint URL: ${discordRelayInteractionsUrl(input.relayUrl, discord.webhookPath)}`] : []),
    ...(teams ? [`Microsoft Teams Messaging Endpoint URL: ${teamsRelayWebhookUrl(input.relayUrl, teams.webhookPath)}`] : []),
    "Next steps:",
    `  opentag start --config ${input.configPath}`,
    "  opentag service start"
  ].join("\n");
}

async function runLegacyPair(input: {
  options: PairCommandOptions;
  dependencies: PairRelayDependencies;
  configPath: string;
  config: OpenTagCliConfig;
  relayUrl: string;
}): Promise<OpenTagCliConfig> {
  const healthy = await probeDispatcherHealth({
    dispatcherUrl: input.relayUrl,
    ...(input.dependencies.fetchImpl ? { fetchImpl: input.dependencies.fetchImpl } : {}),
    timeoutMs: input.dependencies.healthTimeoutMs ?? 5_000
  });
  if (!healthy) throw new Error(`Relay health check failed at ${input.relayUrl}/healthz.`);
  const updated = relayConfigFrom({ config: input.config, relayUrl: input.relayUrl });
  await validateRelayPlatformCapabilities({
    config: updated,
    relayUrl: input.relayUrl,
    ...(input.dependencies.fetchImpl ? { fetchImpl: input.dependencies.fetchImpl } : {}),
    timeoutMs: input.dependencies.healthTimeoutMs ?? 5_000
  });
  if (input.options.register !== false) {
    await bootstrapLocalDispatcher(updated, input.dependencies.bootstrapClient);
  }
  (input.dependencies.writeConfig ?? writeCliConfigAtomic)(input.configPath, updated);
  return updated;
}

async function runHostedPair(input: {
  dependencies: PairRelayDependencies;
  configPath: string;
  plan: HostedPairPlan;
  relayUrl: string;
}): Promise<OpenTagCliConfig> {
  const readRawConfig = input.dependencies.readRawConfig ?? readCliRawConfig;
  const readConfig = input.dependencies.readConfig ?? readCliConfig;
  const writeHostedConfig = input.dependencies.writeHostedConfig
    ?? writeHostedControlConfigAtomic;
  const createControlClient = input.dependencies.createControlClient
    ?? createOpenTagClient;

  writeHostedState({
    configPath: input.configPath,
    controlRegistration: input.plan.controlRegistration,
    readRawConfig,
    relayUrl: input.relayUrl,
    trustedRelay: input.plan.trustedRelay,
    writeHostedConfig
  });

  const capabilityClient = createControlClient({
    dispatcherUrl: input.plan.relayOrigin,
    ...(input.dependencies.fetchImpl
      ? { fetchImpl: input.dependencies.fetchImpl }
      : {})
  });
  const capabilities = await capabilityClient.getRelayCapabilitiesControlV1();
  const requiredCapability = input.plan.recoveryRegistration
    ? "relay.credential-reprovision.v1" as const
    : "relay.registration.v1" as const;
  if (!capabilities.capabilities.includes(requiredCapability)) {
    throw new Error(
      `Hosted Control V1 relay does not advertise required capability ${requiredCapability}.`
    );
  }

  // This is intentionally the first full config read. The raw trust and
  // pending-operation readback above must complete before any SecretRef is
  // materialized.
  const config = readConfig(input.configPath);
  let controlCredential: Parameters<typeof createOpenTagClient>[0]["controlCredential"];
  if (input.plan.recoveryRegistration) {
    controlCredential = {
      kind: "recovery_pairing",
      token: requireRecoverySecret(
        input.dependencies.readRecoverySecret ?? defaultReadRecoverySecret
      )
    };
  } else {
    const pairingToken = config.daemon.pairingToken?.trim();
    if (!pairingToken) {
      throw new Error("Hosted Control V1 registration requires daemon.pairingToken.");
    }
    controlCredential = { kind: "bootstrap_pairing", token: pairingToken };
  }

  const mutationClient = createControlClient({
    dispatcherUrl: input.plan.relayOrigin,
    controlCredential,
    ...(input.dependencies.fetchImpl
      ? { fetchImpl: input.dependencies.fetchImpl }
      : {})
  });
  let response: RunnerCredentialResponseV1;
  try {
    if (input.plan.recoveryRegistration) {
      response = await mutationClient.reprovisionRunnerControlV1(
        RunnerCredentialReprovisionRequestV1Schema.parse({
          schemaVersion: 1,
          protocolVersion: "1.0",
          requiredCapabilities: ["relay.credential-reprovision.v1"],
          requestId: controlRequestIdFromOperationId(input.plan.operationId),
          operationId: input.plan.operationId,
          runnerId: config.daemon.runnerId,
          recoveryCredentialId: (input.plan.controlRegistration as Extract<
            HostedControlRegistration,
            { flow: "reprovision" }
          >).recoveryCredentialId,
          expectedRegistrationGeneration:
            input.plan.recoveryRegistration.registrationGeneration,
          expectedCredentialGeneration:
            input.plan.recoveryRegistration.credentialGeneration
        })
      );
    } else {
      response = await mutationClient.registerRunnerControlV1(
        RunnerRegistrationRequestV1Schema.parse({
          schemaVersion: 1,
          protocolVersion: "1.0",
          requiredCapabilities: ["relay.registration.v1"],
          requestId: controlRequestIdFromOperationId(input.plan.operationId),
          operationId: input.plan.operationId,
          runnerId: config.daemon.runnerId,
          capabilities: []
        })
      );
    }
  } catch (error) {
    if (!(error instanceof OpenTagControlV1HttpError)) {
      const pending = input.plan.controlRegistration;
      if (pending.state !== "unpaired" || !("flow" in pending)) {
        throw new Error("Hosted Control V1 mutation failed before a replayable pending state was available.");
      }
      writeHostedState({
        configPath: input.configPath,
        controlRegistration: {
          ...pending,
          reason: "outcome_unknown"
        },
        readRawConfig,
        relayUrl: input.relayUrl,
        trustedRelay: input.plan.trustedRelay,
        writeHostedConfig
      });
      throw new Error(
        "Hosted Control V1 mutation outcome is unknown; retry with the persisted operation."
      );
    }
    throw error;
  }

  if (response.replayed) {
    writeHostedState({
      configPath: input.configPath,
      controlRegistration: replayRecoveryRequired(response),
      readRawConfig,
      relayUrl: input.relayUrl,
      trustedRelay: input.plan.trustedRelay,
      removePairingToken: true,
      runnerToken: null,
      writeHostedConfig
    });
  } else {
    await persistStageThenPair({
      configPath: input.configPath,
      operationId: input.plan.operationId,
      relayUrl: input.relayUrl,
      response,
      readRawConfig,
      trustedRelay: input.plan.trustedRelay,
      writeHostedConfig
    });
  }
  return readConfig(input.configPath);
}

function finalizeStagedHostedPair(input: {
  dependencies: PairRelayDependencies;
  configPath: string;
  plan: HostedPairPlan & {
    finalizeStagedLocally: NonNullable<HostedPairPlan["finalizeStagedLocally"]>;
  };
  relayUrl: string;
}): void {
  writeHostedState({
    configPath: input.configPath,
    controlRegistration: input.plan.finalizeStagedLocally.pairedControl,
    readRawConfig: input.dependencies.readRawConfig ?? readCliRawConfig,
    relayUrl: input.relayUrl,
    trustedRelay: input.plan.trustedRelay,
    runnerToken: input.plan.finalizeStagedLocally.runnerToken,
    writeHostedConfig: input.dependencies.writeHostedConfig
      ?? writeHostedControlConfigAtomic
  });
}
export async function runPairCommand(options: PairCommandOptions, dependencies: PairRelayDependencies = {}): Promise<void> {
  if (!options.relay) {
    throw new Error("opentag pair currently requires --relay <url>.");
  }

  const logger = dependencies.logger ?? console;
  const configPath = options.config ?? defaultConfigPath();
  const relayUrl = normalizeRelayUrl(options.relay);
  assertRelayTransportAllowed(relayUrl);
  const readRawConfig = dependencies.readRawConfig ?? readCliRawConfig;
  const rawConfig = readRawConfig(configPath);
  const plan = hostedPairPlan({
    options,
    rawConfig,
    relayUrl,
    operationId: dependencies.randomUUID ?? randomUUID,
    now: dependencies.now ?? (() => new Date())
  });
  if (plan?.finalizeStagedLocally) {
    finalizeStagedHostedPair({
      dependencies,
      configPath,
      plan: {
        ...plan,
        finalizeStagedLocally: plan.finalizeStagedLocally
      },
      relayUrl
    });
    logger.log(
      [
        "Hosted Control V1 staged credential finalized locally.",
        `Config: ${configPath}`,
        `Relay: ${plan.relayOrigin}`,
        "Registration: completed"
      ].join("\n")
    );
    return;
  }
  const updated = plan
    ? await runHostedPair({ dependencies, configPath, plan, relayUrl })
    : await runLegacyPair({
        options,
        dependencies,
        configPath,
        config: (dependencies.readConfig ?? readCliConfig)(configPath),
        relayUrl
      });

  logger.log(
    formatPairRelaySummary({
      configPath,
      config: updated,
      relayUrl,
      registered: plan
        ? updated.daemon.controlRegistration?.state === "paired"
        : options.register !== false
    })
  );
}
