import { relayUrlFromConfig, runtimeModeFromConfig, type OpenTagCliConfig } from "./config.js";
export {
  TrustedRelayAuthorizationV1Schema,
  assertHostedRelayAuthorization,
  canonicalHostedRelayOrigin,
  type TrustedRelayAuthorizationV1
} from "@opentag/local-runtime";

export type RelaySecurityCheck = {
  status: "ok" | "warn" | "fail";
  name: string;
  message: string;
};

export function isLocalRelayUrl(relayUrl: string): boolean {
  const url = new URL(relayUrl);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname.endsWith(".localhost");
}

export function assertRelayTransportAllowed(relayUrl: string): void {
  const url = new URL(relayUrl);
  if (url.protocol === "http:" && !isLocalRelayUrl(relayUrl)) {
    throw new Error("Relay URL must use HTTPS unless it points to localhost for local testing.");
  }
}

export function relayTrustWarning(relayUrl: string): string {
  return [
    `Security: only pair with a relay you operate or trust (${relayUrl}).`,
    "The relay can see run metadata, command text, and progress, and it controls which queued runs this local runner claims."
  ].join("\n");
}

export function relaySecurityChecksFromConfig(config: OpenTagCliConfig): RelaySecurityCheck[] {
  if (runtimeModeFromConfig(config) !== "relay") return [];
  const relayUrl = relayUrlFromConfig(config) ?? config.daemon.dispatcherUrl;
  let relay: URL;
  try {
    relay = new URL(relayUrl);
  } catch {
    return [{ status: "fail", name: "relay URL", message: "Relay URL is malformed; fix runtime.relayUrl or daemon.dispatcherUrl." }];
  }
  const checks: RelaySecurityCheck[] = [];

  if (relay.protocol === "https:") {
    checks.push({ status: "ok", name: "relay transport", message: "HTTPS is enabled." });
  } else if (relay.protocol === "http:" && isLocalRelayUrl(relayUrl)) {
    checks.push({ status: "ok", name: "relay transport", message: "HTTP is limited to localhost development." });
  } else {
    checks.push({ status: "fail", name: "relay transport", message: "Public relay URLs must use HTTPS." });
  }

  checks.push({
    status: "warn",
    name: "relay trust",
    message: "Use only a relay you operate or trust; the relay is the remote control plane for this local runner."
  });

  checks.push(
    config.daemon.runnerToken
      ? {
          status: "ok",
          name: "relay token scope",
          message:
            "Runner calls use daemon.runnerToken instead of the pairing token; keep registration, runner, and webhook credentials independently rotatable."
        }
      : {
          status: "warn",
          name: "relay token scope",
          message:
            "This self-hosted MVP still uses the daemon pairing token for registration and runner calls; configure daemon.runnerToken before treating relay credentials as beta-ready."
        }
  );

  if (config.daemon.runnerTokens?.length) {
    checks.push({
      status: config.daemon.runnerToken ? "ok" : "warn",
      name: "runner token rotation",
      message: config.daemon.runnerToken
        ? `${config.daemon.runnerTokens.length} additional runner token(s) configured for the rotation window.`
        : "Additional runner tokens are configured, but daemon.runnerToken is missing; configure the current runner token before relying on rotation."
    });
  }

  if (config.daemon.revokedRunnerTokenFingerprints?.length) {
    checks.push({
      status: "ok",
      name: "runner token revocation",
      message: `${config.daemon.revokedRunnerTokenFingerprints.length} revoked runner token fingerprint(s) configured; revoked tokens fail closed without printing token values.`
    });
  }

  checks.push({
    status: "ok",
    name: "Project Target allowlist",
    message: `${config.daemon.repositories.length} local Project Target(s) configured; the runner refuses unlisted targets before executor startup.`
  });

  if (config.platforms.github) {
    checks.push({
      status: "ok",
      name: "GitHub webhook secret",
      message: "Configured locally; the relay /github/webhooks endpoint must verify this secret before creating runs."
    });
  }

  if (config.platforms.gitlab) {
    const webhookPath = config.platforms.gitlab.webhookPath ?? "/gitlab/webhooks";
    checks.push({
      status: "ok",
      name: "GitLab webhook secret",
      message: `Configured locally; the relay ${webhookPath} endpoint must verify X-Gitlab-Token before creating runs.`
    });
  }

  if (config.platforms.linear) {
    const webhookPath = config.platforms.linear.webhookPath ?? "/linear/webhooks";
    checks.push({
      status: "ok",
      name: "Linear webhook secret",
      message: `Configured locally; the relay ${webhookPath} endpoint must verify Linear-Signature and webhook timestamp before creating runs.`
    });
  }

  if (config.platforms.discord?.mode === "webhook") {
    const webhookPath = config.platforms.discord.webhookPath ?? "/discord/interactions";
    checks.push({
      status: "ok",
      name: "Discord interaction signature",
      message: `Configured locally; the relay ${webhookPath} endpoint must verify the Ed25519 signature before creating runs.`
    });
  }

  if (config.platforms.slack || config.platforms.lark || config.platforms.teams) {
    const unsupported = [
      config.platforms.slack ? "Slack" : undefined,
      config.platforms.lark ? "Lark / Feishu" : undefined,
      config.platforms.teams ? "Microsoft Teams" : undefined
    ]
      .filter((value): value is string => Boolean(value))
      .join(", ");
    checks.push({
      status: "fail",
      name: "relay platform support",
      message: `${unsupported} relay mode is not supported in this MVP; use local mode for those ingress paths.`
    });
  }

  if (!config.daemon.security) {
    checks.push({
      status: "warn",
      name: "runner security policy",
      message: "No explicit daemon.security policy is configured; consider setting allowedWorkspaceRoot for relay-backed runners."
    });
  }

  return checks;
}

export function formatRelaySecurityChecks(checks: RelaySecurityCheck[]): string[] {
  if (!checks.length) return [];
  return ["Relay Security:", ...checks.map((check) => `  ${check.status.toUpperCase()} ${check.name}: ${check.message}`)];
}
