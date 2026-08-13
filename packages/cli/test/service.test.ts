import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeCliConfigAtomic, type OpenTagCliConfig } from "../src/config.js";
import {
  buildLaunchAgentPlist,
  buildSystemdUserService,
  formatServiceLogs,
  formatServiceStatus,
  getServiceStatus,
  getServiceStatusWithRuntimeReadiness,
  installAndStartService,
  installService,
  runServiceRestartCommand,
  runServiceStatusCommand,
  serviceControllerForPlatform,
  servicePaths,
  type CommandResult
} from "../src/service.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function configPathIn(home: string): string {
  return join(home, ".config", "opentag", "config.json");
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function writeConfig(path: string, mutate?: (config: OpenTagCliConfig) => void): void {
  const projectPath = tempDir();
  const config = createSetupConfig({
    language: "en",
    platform: "github",
    projectPath,
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
  mutate?.(config);
  writeCliConfigAtomic(path, config);
}

function writeRelayConfig(path: string): void {
  const projectPath = tempDir();
  const config = createSetupConfig({
    language: "en",
    platform: "github",
    projectPath,
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
  config.runtime = {
    mode: "relay",
    relayUrl: "https://relay.example",
    relayProvider: "custom"
  };
  config.daemon.dispatcherUrl = "https://relay.example";
  writeCliConfigAtomic(path, config);
}

function launchctl(status: number): (args: string[]) => CommandResult {
  return () => ({
    status,
    stdout: "",
    stderr: status === 0 ? "" : "service is not loaded"
  });
}

const doctorCommandRunner = {
  async run(command: string, args: string[]) {
    if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
  }
};

function runtimeFetch(input: { runnerMissing?: boolean; heartbeatAt?: string | null } = {}): { fetchImpl: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    requests.push(href);
    if (href.endsWith("/healthz")) {
      return Response.json({ ok: true });
    }
    if (href.endsWith("/v1/runners/runner_local")) {
      return input.runnerMissing
        ? Response.json({ error: "runner_not_found" }, { status: 404 })
        : Response.json({
            runner: {
              runnerId: "runner_local",
              name: "runner_local",
              createdAt: "2026-06-24T00:00:00.000Z",
              ...(input.heartbeatAt !== null ? { heartbeatAt: input.heartbeatAt ?? new Date().toISOString() } : {})
            }
          });
    }
    if (href.includes("/v1/repo-bindings/")) {
      return Response.json({
        binding: {
          provider: "github",
          owner: "acme",
          repo: "demo",
          runnerId: "runner_local",
          workspacePath: "/tmp/demo",
          defaultExecutor: "echo"
        }
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("OpenTag CLI service", () => {
  it("generates a LaunchAgent plist with service run arguments and log paths", () => {
    const plist = buildLaunchAgentPlist({
      label: "im.opentag.agent",
      programArguments: ["/usr/local/bin/node", "/opt/opentag/dist/index.js", "service", "run", "--mode", "background"],
      runAtLoad: true,
      keepAlive: true,
      stdoutPath: "/tmp/opentag.log",
      stderrPath: "/tmp/opentag.err.log",
      workingDirectory: "/Users/mingyoo/repos/opentag",
      environment: {
        OPENTAG_CONFIG_PATH: "/tmp/config.json"
      }
    });

    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>im.opentag.agent</string>");
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<string>service</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("/tmp/opentag.log");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain("/tmp/opentag.err.log");
    expect(plist).toContain("<key>WorkingDirectory</key>");
  });

  it("generates a systemd user service unit with service run arguments and log paths", () => {
    const unit = buildSystemdUserService({
      environment: {
        OPENTAG_CONFIG_PATH: "/tmp/config.json",
        OPENTAG_MAX_REQUEST_BODY_BYTES: "4096",
        PATH: "/usr/local/bin:/usr/bin:/bin"
      },
      execStart: ["/usr/local/bin/node", "/opt/opentag/dist/index.js", "service", "run", "--mode", "background"],
      label: "im.opentag.agent",
      stderrPath: "/tmp/opentag.err.log",
      stdoutPath: "/tmp/opentag.log",
      workingDirectory: "/home/mingyoo/opentag"
    });

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=OpenTag local agent");
    expect(unit).toContain("[Service]");
    expect(unit).toContain('WorkingDirectory="/home/mingyoo/opentag"');
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/opentag/dist/index.js" "service" "run" "--mode" "background"');
    expect(unit).toContain('Environment="OPENTAG_CONFIG_PATH=/tmp/config.json"');
    expect(unit).toContain('Environment="OPENTAG_MAX_REQUEST_BODY_BYTES=4096"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("StandardOutput=append:/tmp/opentag.log");
    expect(unit).toContain("StandardError=append:/tmp/opentag.err.log");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("installs the macOS LaunchAgent plist without starting launchctl", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    const paths = installService(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        nodePath: "/usr/local/bin/node",
        cliEntry: "/opt/opentag/dist/index.js",
        uid: 501,
        launchctl: () => {
          throw new Error("install should not call launchctl");
        }
      }
    );

    const plist = readFileSync(paths.plistPath, "utf8");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/opentag/dist/index.js</string>");
    expect(plist).toContain(`<string>${configPath}</string>`);
    expect(plist).toContain(`<string>${paths.stdoutPath}</string>`);
    expect(plist).toContain(`<string>${paths.stderrPath}</string>`);
  });

  it("installs and starts the LaunchAgent for setup service mode", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    const calls: string[] = [];

    const paths = await installAndStartService(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        nodePath: "/usr/local/bin/node",
        cliEntry: "/opt/opentag/dist/index.js",
        uid: 501,
        launchctl(args) {
          calls.push(args.join(" "));
          return { status: 0, stdout: "service = im.opentag.agent", stderr: "" };
        },
        sleep: async () => undefined
      }
    );

    const plist = readFileSync(paths.plistPath, "utf8");
    expect(plist).toContain("<string>/opt/opentag/dist/index.js</string>");
    expect(calls).toContain(`bootstrap gui/501 ${paths.plistPath}`);
    expect(calls).toContain("kickstart -k gui/501/im.opentag.agent");
    expect(calls).toContain("print gui/501/im.opentag.agent");
  });

  it("installs and starts the Linux systemd user service for setup service mode", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    const calls: string[] = [];

    const paths = await installAndStartService(
      { config: configPath },
      {
        platform: "linux",
        homeDir: home,
        nodePath: "/usr/local/bin/node",
        cliEntry: "/opt/opentag/dist/index.js",
        systemctl(args) {
          calls.push(args.join(" "));
          if (args[0] === "is-active") return { status: 0, stdout: "active\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
        sleep: async () => undefined
      }
    );

    const unit = readFileSync(paths.unitPath, "utf8");
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/opentag/dist/index.js" "service" "run" "--mode" "background" "--config"');
    expect(unit).toContain(`"${configPath}"`);
    expect(calls).toEqual([
      "daemon-reload",
      "enable im.opentag.agent.service",
      "daemon-reload",
      "start im.opentag.agent.service",
      "is-active im.opentag.agent.service"
    ]);
  });

  it("installs the LaunchAgent with a conservative CLI PATH for executor binaries", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    const paths = installService(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        nodePath: "/usr/local/bin/node",
        cliEntry: "/opt/opentag/dist/index.js",
        uid: 501,
        launchctl: () => {
          throw new Error("install should not call launchctl");
        }
      }
    );

    const plist = readFileSync(paths.plistPath, "utf8");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>");
    expect(plist).not.toContain(".codex/tmp");
  });

  it("restarts cleanly when service-target bootout and kickstart report stale launchd state", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });

    const calls: string[] = [];
    const logs: string[] = [];
    let loaded = true;
    await runServiceRestartCommand(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        uid: 501,
        launchctl(args) {
          calls.push(args.join(" "));
          if (args[0] === "bootout" && args.length === 2) {
            return { status: 1, stdout: "", stderr: "No such process" };
          }
          if (args[0] === "bootout" && args.length === 3) {
            loaded = false;
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "bootstrap") {
            loaded = true;
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "kickstart") {
            return { status: 1, stdout: "", stderr: "service is not loaded" };
          }
          if (args[0] === "print") {
            return loaded
              ? { status: 0, stdout: "service = im.opentag.agent", stderr: "" }
              : { status: 1, stdout: "", stderr: "service is not loaded" };
          }
          return { status: 1, stdout: "", stderr: `unexpected launchctl ${args.join(" ")}` };
        },
        logger: { log: (message) => logs.push(message) }
      }
    );

    expect(calls).toEqual([
      "bootout gui/501/im.opentag.agent",
      `bootout gui/501 ${servicePaths({ config: configPath }, { homeDir: home }).plistPath}`,
      "print gui/501/im.opentag.agent",
      `bootstrap gui/501 ${servicePaths({ config: configPath }, { homeDir: home }).plistPath}`,
      "kickstart -k gui/501/im.opentag.agent",
      "print gui/501/im.opentag.agent",
      "print gui/501/im.opentag.agent"
    ]);
    expect(logs).toEqual(["OpenTag service restarted: im.opentag.agent"]);
  });

  it("persists only explicit non-secret dispatcher hardening env in the LaunchAgent", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    const paths = installService(
      {
        config: configPath,
        maxRequestBodyBytes: "4096",
        rateLimitWindowMs: "60000",
        rateLimitMaxRequests: "120"
      },
      {
        platform: "darwin",
        homeDir: home,
        nodePath: "/usr/local/bin/node",
        cliEntry: "/opt/opentag/dist/index.js",
        uid: 501,
        launchctl: () => {
          throw new Error("install should not call launchctl");
        }
      }
    );

    const plist = readFileSync(paths.plistPath, "utf8");
    expect(plist).toContain("<key>OPENTAG_CONFIG_PATH</key>");
    expect(plist).toContain("<key>OPENTAG_MAX_REQUEST_BODY_BYTES</key>");
    expect(plist).toContain("<string>4096</string>");
    expect(plist).toContain("<key>OPENTAG_RATE_LIMIT_WINDOW_MS</key>");
    expect(plist).toContain("<string>60000</string>");
    expect(plist).toContain("<key>OPENTAG_RATE_LIMIT_MAX_REQUESTS</key>");
    expect(plist).toContain("<string>120</string>");
    expect(plist).not.toContain("OPENTAG_PAIRING_TOKEN");
    expect(plist).not.toContain("github_webhook_secret");

    const formatted = formatServiceStatus(
      getServiceStatus({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) })
    );
    expect(formatted).toContain("Service Hardening:");
    expect(formatted).toContain("OPENTAG_MAX_REQUEST_BODY_BYTES=4096");
    expect(formatted).toContain("OPENTAG_RATE_LIMIT_WINDOW_MS=60000");
    expect(formatted).toContain("OPENTAG_RATE_LIMIT_MAX_REQUESTS=120");
  });

  it("validates service dispatcher hardening options before writing the LaunchAgent", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);

    expect(() =>
      installService({ config: configPath, rateLimitWindowMs: "60000" }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) })
    ).toThrow("OPENTAG_RATE_LIMIT_WINDOW_MS and OPENTAG_RATE_LIMIT_MAX_REQUESTS must be configured together");

    expect(() =>
      installService(
        {
          config: configPath,
          rateLimitDisabled: true,
          rateLimitWindowMs: "60000",
          rateLimitMaxRequests: "120"
        },
        { platform: "darwin", homeDir: home, launchctl: launchctl(0) }
      )
    ).toThrow("OPENTAG_RATE_LIMIT_DISABLED cannot be true");
  });

  it("formats service status for installed and not installed launchd services", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);

    const missing = getServiceStatus({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(1) });
    expect(missing.installed).toBe(false);
    expect(formatServiceStatus(missing)).toContain("Installed: no");

    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const running = getServiceStatus({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    expect(running.installed).toBe(true);
    expect(running.running).toBe("running");
    expect(formatServiceStatus(running)).toContain("Controller: launchd");
    expect(formatServiceStatus(running)).toContain("Runtime: local");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: unverified");
    expect(formatServiceStatus(running)).toContain("Connectors:");
    expect(formatServiceStatus(running)).toContain(
      "github: ingress=repository_webhook path=/github/webhooks port=3050, delivery=kernel_blocked, apply=ready, target=github:acme/demo"
    );
    expect(formatServiceStatus(running)).toContain("Secrets:");
    expect(formatServiceStatus(running)).toContain("daemon.pairingToken: inline (redacted)");
    expect(formatServiceStatus(running)).toContain("daemon.runnerToken: daemon.pairingToken fallback");
    expect(formatServiceStatus(running)).toContain("daemon.githubToken: inline (redacted)");
    expect(formatServiceStatus(running)).toContain("daemon.githubApplyToken: daemon.githubToken fallback");
    expect(formatServiceStatus(running)).toContain("platforms.github.webhookSecret: inline (redacted)");
    expect(formatServiceStatus(running)).not.toContain("github_webhook_secret");
    expect(formatServiceStatus(running)).toContain("Capabilities:");
    expect(formatServiceStatus(running)).toContain("platform GitHub:");
    expect(formatServiceStatus(running)).toContain("liveness=status_update");
    expect(formatServiceStatus(running)).toContain("executor Echo:");
    expect(formatServiceStatus(running)).toContain("isolation=none");
    expect(formatServiceStatus(running)).toContain("completion=process_exit");
  });

  it("summarizes platform connector readiness without printing secret values", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath, (config) => {
      config.platforms.slack = {
        mode: "events_api",
        signingSecret: "slack_signing_secret",
        botToken: "xoxb_secret",
        teamId: "T123",
        channelId: "C456",
        port: 3060
      };
      config.platforms.lark = {
        appId: "cli_lark",
        appSecret: "lark_secret",
        domain: "lark",
        botOpenId: "ou_bot"
      };
      config.platforms.discord = {
        mode: "webhook",
        publicKey: "discord_public_key",
        botToken: "discord_bot_secret",
        webhookPath: "/discord/interactions"
      };
      config.platforms.linear = {
        token: "linear_api_secret",
        webhookSecret: "linear_webhook_secret",
        webhookPath: "/linear/webhooks",
        projectTarget: {
          repoProvider: "github",
          owner: "acme",
          repo: "demo"
        }
      };
      config.platforms.gitlab = {
        token: "gitlab_api_secret",
        webhookSecret: "gitlab_webhook_secret",
        projectPathWithNamespace: "acme/team/demo",
        baseUrl: "https://gitlab.example.com",
        webhookPath: "/gitlab/webhooks",
        port: 3070
      };
      config.platforms.teams = {
        appId: "teams_app_id",
        appPassword: "teams_app_password",
        tenantId: "teams_tenant_id",
        webhookPath: "/teams/messages"
      };
    });
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });

    const formatted = formatServiceStatus(
      getServiceStatus({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) })
    );

    expect(formatted).toContain("Connectors:");
    expect(formatted).toContain("slack: ingress=events_api ready (signingSecret port=3060), delivery=kernel_blocked, source=T123/C456");
    expect(formatted).toContain("lark: ingress=long_connection tenant=lark ready (appId/appSecret), delivery=kernel_blocked");
    expect(formatted).toContain("addressing=bot_open_id configured");
    expect(formatted).toContain(
      "gitlab: ingress=project_webhook path=/gitlab/webhooks port=3070, delivery=kernel_blocked, target=gitlab:acme/team/demo, baseUrl=https://gitlab.example.com"
    );
    expect(formatted).toContain(
      "linear: ingress=workspace_webhook path=/linear/webhooks port=default, delivery=kernel_blocked, target=github:acme/demo"
    );
    expect(formatted).toContain(
      "discord: ingress=dispatcher_interactions path=/discord/interactions, delivery=kernel_blocked, signature=ready (publicKey)"
    );
    expect(formatted).toContain(
      "teams: ingress=dispatcher_messages path=/teams/messages, delivery=kernel_blocked, tenant=teams_tenant_id"
    );
    expect(formatted).not.toContain("callback=");
    expect(formatted).not.toContain("delivery=ready");
    expect(formatted).toContain("platforms.linear.token: inline (redacted)");
    expect(formatted).toContain("platforms.discord.botToken: inline (redacted)");
    expect(formatted).not.toContain("slack_signing_secret");
    expect(formatted).not.toContain("xoxb_secret");
    expect(formatted).not.toContain("lark_secret");
    expect(formatted).not.toContain("linear_api_secret");
    expect(formatted).not.toContain("linear_webhook_secret");
    expect(formatted).not.toContain("discord_bot_secret");
    expect(formatted).not.toContain("gitlab_api_secret");
    expect(formatted).not.toContain("gitlab_webhook_secret");
    expect(formatted).not.toContain("teams_app_password");
  });

  it("marks a running service ready only after dispatcher health succeeds", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const { fetchImpl, requests } = runtimeFetch();

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, commandRunner: doctorCommandRunner }
    );

    expect(requests).toEqual([
      "http://localhost:3030/healthz",
      "http://localhost:3030/healthz",
      "http://localhost:3030/v1/runners/runner_local",
      expect.stringContaining("http://localhost:3030/v1/repo-bindings/"),
      "http://localhost:3030/v1/repo-bindings/github/acme/demo"
    ]);
    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("ready");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: ready (dispatcher healthz ok; doctor checks ok");
  });

  it("reports disabled launchd autostart separately from installation", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });

    const summary = getServiceStatus(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        launchctl(args) {
          if (args[0] === "print-disabled") {
            return {
              status: 0,
              stdout: 'disabled services = {\n  "im.opentag.agent" => true\n}\n',
              stderr: ""
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
      }
    );

    expect(summary.installed).toBe(true);
    expect(summary.autostart).toBe("disabled");
    expect(formatServiceStatus(summary)).toContain("Autostart: disabled");
  });

  it("marks a launchd-running service degraded when doctor checks fail", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const { fetchImpl } = runtimeFetch({ runnerMissing: true });

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, commandRunner: doctorCommandRunner }
    );

    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("degraded");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: degraded (doctor checks degraded (1 fail, 0 warn))");
    expect(formatServiceStatus(running)).toContain("Runtime Checks:");
    expect(formatServiceStatus(running)).toContain("FAIL runner registration:");
  });

  it("marks a launchd-running service stale when runner heartbeat is old", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const { fetchImpl } = runtimeFetch({ heartbeatAt: "2000-01-01T00:00:00.000Z" });

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, commandRunner: doctorCommandRunner }
    );

    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("stale_heartbeat");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: stale_heartbeat (stale; last heartbeat 2000-01-01T00:00:00.000Z");
    expect(formatServiceStatus(running)).toContain("WARN runner heartbeat: stale;");
  });

  it("marks a launchd-running service starting when no runner heartbeat is visible yet", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const { fetchImpl } = runtimeFetch({ heartbeatAt: null });

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, commandRunner: doctorCommandRunner }
    );

    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("starting");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: starting (no heartbeat observed yet");
  });

  it("marks a launchd-running service degraded when the current runner token is revoked", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath, (config) => {
      config.daemon.runnerToken = "runner_token";
      config.daemon.revokedRunnerTokenFingerprints = [tokenFingerprint("runner_token")];
    });
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const { fetchImpl } = runtimeFetch();

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, commandRunner: doctorCommandRunner }
    );

    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("degraded");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: degraded (doctor checks degraded (1 fail, 0 warn))");
    expect(formatServiceStatus(running)).toContain("FAIL runner token revocation: Current daemon.runnerToken fingerprint is revoked");
  });

  it("marks a launchd-running service unreachable when dispatcher health fails", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, healthTimeoutMs: 5 }
    );

    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("unreachable");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: unreachable (dispatcher healthz failed (http://localhost:3030))");
  });

  it("uses runtime readiness probing in the service status command", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const lines: string[] = [];

    await runServiceStatusCommand(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        launchctl: launchctl(0),
        fetchImpl: runtimeFetch().fetchImpl,
        commandRunner: doctorCommandRunner,
        logger: { log: (message) => lines.push(message) }
      }
    );

    expect(lines.join("\n")).toContain("Running: running");
    expect(lines.join("\n")).toContain("OpenTag runtime: ready");
  });

  it("reports Linux systemd user service status", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    await installAndStartService(
      { config: configPath },
      {
        platform: "linux",
        homeDir: home,
        systemctl(args) {
          if (args[0] === "is-active") return { status: 0, stdout: "active\n", stderr: "" };
          if (args[0] === "is-enabled") return { status: 0, stdout: "enabled\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
        sleep: async () => undefined
      }
    );

    const summary = getServiceStatus(
      { config: configPath },
      {
        platform: "linux",
        homeDir: home,
        systemctl(args) {
          if (args[0] === "is-active") return { status: 0, stdout: "active\n", stderr: "" };
          if (args[0] === "is-enabled") return { status: 0, stdout: "enabled\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
      }
    );

    expect(summary.controller).toBe("systemd");
    expect(summary.installed).toBe(true);
    expect(summary.running).toBe("running");
    expect(summary.autostart).toBe("enabled");
    expect(formatServiceStatus(summary)).toContain("Controller: systemd");
    expect(formatServiceStatus(summary)).toContain("Systemd unit:");
  });

  it("reports unsupported service management without crashing on unsupported platforms", () => {
    const home = tempDir();
    const summary = getServiceStatus({}, { platform: "win32", homeDir: home });

    expect(summary.controller).toBe("unsupported");
    expect(formatServiceStatus(summary)).toContain("service management is supported on macOS and Linux only");
  });

  it("maps service controllers by platform", () => {
    expect(serviceControllerForPlatform("darwin")).toBe("launchd");
    expect(serviceControllerForPlatform("linux")).toBe("systemd");
    expect(serviceControllerForPlatform("win32")).toBe("unsupported");
  });

  it("includes relay security checks in service status", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeRelayConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });

    const formatted = formatServiceStatus(
      getServiceStatus({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) })
    );

    expect(formatted).toContain("Runtime: relay");
    expect(formatted).toContain("Relay Security:");
    expect(formatted).toContain("OK relay transport: HTTPS is enabled.");
    expect(formatted).toContain("WARN relay trust: Use only a relay you operate or trust");
    expect(formatted).toContain("WARN relay token scope: This self-hosted MVP still uses the daemon pairing token for registration and runner calls");
  });

  it("prints recent stdout and stderr logs", () => {
    const home = tempDir();
    const paths = servicePaths({}, { homeDir: home });
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.stdoutPath, "one\ntwo\nthree\n");
    writeFileSync(paths.stderrPath, "err-one\nerr-two\n");

    const logs = formatServiceLogs({ lines: 2 }, { homeDir: home });

    expect(logs).toContain("two\nthree");
    expect(logs).not.toContain("one\ntwo\nthree");
    expect(logs).toContain("err-one\nerr-two");
  });

  it("does not load the beginning of oversized service logs", () => {
    const home = tempDir();
    const paths = servicePaths({}, { homeDir: home });
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.stdoutPath, `old-start-marker\n${"x".repeat(1024 * 1024 + 32)}\nnear-end\nlast\n`);

    const logs = formatServiceLogs({ lines: 10 }, { homeDir: home });

    expect(logs).toContain("near-end\nlast");
    expect(logs).not.toContain("old-start-marker");
  });
});
