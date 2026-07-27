import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoctorCheck } from "@opentag/local-runtime";
import { appendCliDoctorChecks, formatCliDoctorChecks, runDoctorCommand } from "../src/doctor.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function relayConfig(relayUrl: string) {
  const built = createSetupConfig({
    language: "en",
    platform: "github",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    github: {
      token: "ghp_token",
      webhookSecret: "github_webhook_secret",
      owner: "acme",
      repo: "demo",
      webhookPath: "/github/webhooks",
      autoCreatePullRequest: false,
      port: 3050
    }
  });
  built.runtime = {
    mode: "relay",
    relayUrl,
    relayProvider: "custom"
  };
  built.daemon.dispatcherUrl = relayUrl;
  return built;
}

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

afterEach(() => {
  consoleLogSpy.mockClear();
  process.exitCode = undefined;
});

describe("OpenTag CLI doctor relay checks", () => {
  it("appends relay security checks and preserves existing checks", () => {
    const baseChecks: DoctorCheck[] = [
      { status: "ok", name: "dispatcher health", message: "https://relay.example" },
      {
        status: "ok",
        name: "hook ingest auth",
        message: "Runner-scoped dispatcher token is configured for claim/progress/completion and local hook ingest."
      }
    ];
    const checks = appendCliDoctorChecks(relayConfig("https://relay.example"), baseChecks);
    const formatted = formatCliDoctorChecks(checks);

    expect(formatted).toContain("OpenTag doctor");
    expect(formatted).toContain("OK dispatcher health: https://relay.example");
    expect(formatted).toContain("OK hook ingest auth:");
    expect(formatted).toContain("Runner-scoped dispatcher token is configured");
    expect(formatted).toContain("OK credential sources:");
    expect(formatted).toContain("daemon.pairingToken: inline (redacted)");
    expect(formatted).toContain("daemon.runnerToken: daemon.pairingToken fallback");
    expect(formatted).toContain("platforms.github.webhookSecret: inline (redacted)");
    expect(formatted).not.toContain("github_webhook_secret");
    expect(formatted).toContain("OK capability catalog:");
    expect(formatted).toContain("platform GitHub:");
    expect(formatted).toContain("liveness=status_update");
    expect(formatted).toContain("executor Echo:");
    expect(formatted).toContain("isolation=none");
    expect(formatted).toContain("secrets=none");
    expect(formatted).toContain("completion=process_exit");
    expect(formatted).toContain("OK relay transport: HTTPS is enabled.");
    expect(formatted).toContain("OK GitHub webhook secret: Configured locally; the relay /github/webhooks endpoint must verify this secret before creating runs.");
    expect(formatted).toContain("WARN relay trust: Use only a relay you operate or trust");
    expect(formatted).toContain("WARN relay token scope: This self-hosted MVP still uses the daemon pairing token for registration and runner calls");
  });

  it("warns when legacy global Linear projectId does not authorize /linear and redacts credentials", () => {
    const built = relayConfig("https://relay.example");
    built.platforms.slack = {
      mode: "events_api",
      signingSecret: "slack_secret",
      botToken: "xoxb-secret",
      teamId: "T123",
      channelId: "C123"
    } as never;
    built.platforms.linear = { token: "lin_supersecret", projectId: "legacy_project" } as never;

    const formatted = formatCliDoctorChecks(appendCliDoctorChecks(built, []));
    expect(formatted).toContain("WARN Linear /linear channel mapping:");
    expect(formatted).toContain("platforms.linear.projectId no longer authorizes Slack channels");
    expect(formatted).not.toContain("lin_supersecret");
  });

  it("warns once per unsupported Linear connection without exposing its token", () => {
    const built = relayConfig("https://relay.example");
    built.platforms.slack = {
      mode: "events_api",
      signingSecret: "slack_secret",
      botToken: "xoxb-secret",
      teamId: "T123",
      channelId: "C123"
    } as never;
    built.platforms.linear = {
      connections: { other: { token: "lin_other_secret" } },
      channels: [
        { teamId: "T123", channelId: "C1", projectId: "P1", connection: "other" },
        { teamId: "T123", channelId: "C2", projectId: "P2", connection: "other" }
      ]
    } as never;

    const formatted = formatCliDoctorChecks(appendCliDoctorChecks(built, []));
    expect(formatted.match(/WARN Linear workspace connection:/gu)).toHaveLength(1);
    expect(formatted).toContain("connection other");
    expect(formatted).not.toContain("lin_other_secret");
  });

  it("fails legacy public HTTP relay configs", () => {
    const formatted = formatCliDoctorChecks(appendCliDoctorChecks(relayConfig("http://relay.example"), []));

    expect(formatted).toContain("FAIL relay transport: Public relay URLs must use HTTPS.");
  });

  it("reports malformed relay URLs as doctor failures instead of throwing", () => {
    const malformed = relayConfig("https://relay.example");
    malformed.runtime = { mode: "relay", relayUrl: "not a url", relayProvider: "custom" };
    malformed.daemon.dispatcherUrl = "not a url";

    const formatted = formatCliDoctorChecks(appendCliDoctorChecks(malformed, []));

    expect(formatted).toContain("FAIL relay URL: Relay URL is malformed");
  });

  it("reports unresolved SecretRef credentials without printing secret values", async () => {
    const path = join(tempDir(), "config.json");
    const config = relayConfig("https://relay.example");
    writeFileSync(
      path,
      `${JSON.stringify({
        ...config,
        platforms: {
          ...config.platforms,
          github: {
            ...config.platforms.github!,
            webhookSecret: { kind: "env", name: "OPENTAG_MISSING_WEBHOOK_SECRET" }
          }
        }
      })}\n`,
      { mode: 0o600 }
    );
    delete process.env.OPENTAG_MISSING_WEBHOOK_SECRET;

    await runDoctorCommand({ config: path });

    const output = consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain("OpenTag doctor");
    expect(output).toContain("OK credential sources:");
    expect(output).toContain("platforms.github.webhookSecret: env ref (OPENTAG_MISSING_WEBHOOK_SECRET)");
    expect(output).toContain("FAIL credential resolution: Secret env ref OPENTAG_MISSING_WEBHOOK_SECRET is not set.");
    expect(output).not.toContain("github_webhook_secret");
    expect(output).not.toContain("ghp_token");
  });

  it("reports config parse failures even when redacted config cannot be loaded", async () => {
    const path = join(tempDir(), "config.json");
    writeFileSync(path, "{ not-json\n", { mode: 0o600 });

    await runDoctorCommand({ config: path });

    const output = consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain("OpenTag doctor");
    expect(output).toContain("FAIL credential resolution:");
    expect(output).not.toContain("OK credential sources:");
  });
});
