import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultConfigPath,
  defaultStateDirectory,
  ensurePrivateDirectory,
  readCliConfig,
  readRedactedCliConfig,
  relayUrlFromConfig,
  runtimeModeFromConfig,
  type OpenTagCliConfig,
  type PathEnvironment
} from "./config.js";
import {
  dispatcherRuntimeHardeningInputFromEnv,
  doctorHasFailures,
  executorsFromConfig,
  runDoctor,
  type DoctorCheck
} from "@opentag/local-runtime";
import type { CommandRunner } from "@opentag/runner";
import { formatConfiguredCapabilities } from "./catalogs/capabilities.js";
import type { PlatformId } from "./catalogs/platforms.js";
import { formatRelaySecurityChecks, relaySecurityChecksFromConfig } from "./relay-security.js";
import { formatSecretReadiness } from "./secret-readiness.js";
import { probeDispatcherHealth } from "./health.js";
import { runStartCommand } from "./start.js";

export const SERVICE_LABEL = "im.opentag.agent";

export type ServiceCommandOptions = {
  config?: string;
  lines?: string | number;
  maxRequestBodyBytes?: string | number;
  mode?: string;
  rateLimitDisabled?: boolean;
  rateLimitMaxRequests?: string | number;
  rateLimitWindowMs?: string | number;
};

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type ServiceDependencies = {
  cliEntry?: string;
  codexConfigPath?: string;
  commandRunner?: CommandRunner;
  env?: PathEnvironment;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
  homeDir?: string;
  launchctl?: (args: string[]) => CommandResult;
  logger?: Pick<Console, "log">;
  nodePath?: string;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
  systemctl?: (args: string[]) => CommandResult;
  uid?: number;
};

export type ServicePaths = {
  configPath: string;
  label: string;
  logsDir: string;
  plistPath: string;
  stderrPath: string;
  stdoutPath: string;
  unitPath: string;
};

export type ServiceController = "launchd" | "systemd" | "unsupported";

export type ServiceStatusSummary = ServicePaths & {
  autostart: "enabled" | "disabled" | "unknown";
  controller: ServiceController;
  installed: boolean;
  relayUrl?: string;
  relaySecurity: string[];
  running: "running" | "stopped" | "unknown";
  runtimeMode: "local" | "relay" | "unknown";
  runtimeReadiness: "ready" | "starting" | "degraded" | "stale_heartbeat" | "unreachable" | "unverified" | "stopped" | "unknown";
  runtimeReadinessDetail?: string;
  runtimeDiagnostics?: string[];
  connectors: string[];
  secrets: string[];
  capabilities: string[];
  serviceHardening: string[];
};

const serviceHardeningEnvKeys = [
  "OPENTAG_MAX_REQUEST_BODY_BYTES",
  "OPENTAG_RATE_LIMIT_WINDOW_MS",
  "OPENTAG_RATE_LIMIT_MAX_REQUESTS",
  "OPENTAG_RATE_LIMIT_DISABLED"
] as const;

const launchAgentCliPath = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
].join(":");

function linuxServiceCliPath(home: string): string {
  return [
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/local/sbin",
    "/usr/sbin",
    "/sbin"
  ].join(":");
}

function loggerFrom(dependencies: ServiceDependencies): Pick<Console, "log"> {
  return dependencies.logger ?? console;
}

function platformFrom(dependencies: ServiceDependencies): NodeJS.Platform {
  return dependencies.platform ?? process.platform;
}

function homeFrom(dependencies: ServiceDependencies): string {
  return dependencies.homeDir ?? homedir();
}

function uidFrom(dependencies: ServiceDependencies): number {
  return dependencies.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
}

export function serviceControllerForPlatform(platform: NodeJS.Platform = process.platform): ServiceController {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return "unsupported";
}

function serviceControllerFrom(dependencies: ServiceDependencies): ServiceController {
  return serviceControllerForPlatform(platformFrom(dependencies));
}

export function servicePaths(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  const home = homeFrom(dependencies);
  const env = dependencies.env ?? process.env;
  const configPath = options.config ?? defaultConfigPath(env, home);
  const stateDirectory = defaultStateDirectory(env, home);
  const logsDir = join(stateDirectory, "logs");
  return {
    configPath,
    label: SERVICE_LABEL,
    logsDir,
    plistPath: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    stdoutPath: join(logsDir, "opentag.log"),
    stderrPath: join(logsDir, "opentag.err.log"),
    unitPath: join(home, ".config", "systemd", "user", `${SERVICE_LABEL}.service`)
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function plistStringArray(values: string[]): string {
  return values.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
}

export function buildLaunchAgentPlist(input: {
  environment?: Record<string, string>;
  keepAlive: boolean;
  label: string;
  programArguments: string[];
  runAtLoad: boolean;
  stderrPath: string;
  stdoutPath: string;
  workingDirectory: string;
}): string {
  const environmentEntries = Object.entries(input.environment ?? {});
  const environment =
    environmentEntries.length > 0
      ? [
          "  <key>EnvironmentVariables</key>",
          "  <dict>",
          ...environmentEntries.flatMap(([key, value]) => [
            `    <key>${escapeXml(key)}</key>`,
            `    <string>${escapeXml(value)}</string>`
          ]),
          "  </dict>"
        ]
      : [];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(input.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    plistStringArray(input.programArguments),
    "  </array>",
    "  <key>RunAtLoad</key>",
    `  <${input.runAtLoad ? "true" : "false"}/>`,
    "  <key>KeepAlive</key>",
    `  <${input.keepAlive ? "true" : "false"}/>`,
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(input.stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(input.stderrPath)}</string>`,
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(input.workingDirectory)}</string>`,
    ...environment,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("%", "%%")}"`;
}

function systemdPathValue(value: string): string {
  return value.replaceAll("%", "%%");
}

export function buildSystemdUserService(input: {
  environment?: Record<string, string>;
  execStart: string[];
  label: string;
  stderrPath: string;
  stdoutPath: string;
  workingDirectory: string;
}): string {
  const environment = Object.entries(input.environment ?? {}).map(
    ([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`
  );
  return [
    "[Unit]",
    "Description=OpenTag local agent",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdQuote(input.workingDirectory)}`,
    ...environment,
    `ExecStart=${input.execStart.map(systemdQuote).join(" ")}`,
    "Restart=always",
    "RestartSec=3",
    `StandardOutput=append:${systemdPathValue(input.stdoutPath)}`,
    `StandardError=append:${systemdPathValue(input.stderrPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

function launchctlRunner(dependencies: ServiceDependencies): (args: string[]) => CommandResult {
  if (dependencies.launchctl) return dependencies.launchctl;
  return (args: string[]) => {
    const result = spawnSync("launchctl", args, { encoding: "utf8" });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  };
}

function systemctlRunner(dependencies: ServiceDependencies): (args: string[]) => CommandResult {
  if (dependencies.systemctl) return dependencies.systemctl;
  return (args: string[]) => {
    const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  };
}

function launchdDomain(dependencies: ServiceDependencies): string {
  return `gui/${uidFrom(dependencies)}`;
}

function launchdServiceTarget(dependencies: ServiceDependencies): string {
  return `${launchdDomain(dependencies)}/${SERVICE_LABEL}`;
}

function unsupportedMessage(): string {
  return "OpenTag service management is supported on macOS and Linux only. Use `opentag start` in the foreground on this platform.";
}

function assertSupportedServiceController(dependencies: ServiceDependencies): ServiceController {
  const controller = serviceControllerFrom(dependencies);
  if (controller === "unsupported") {
    throw new Error(unsupportedMessage());
  }
  return controller;
}

function runLaunchctlOrThrow(dependencies: ServiceDependencies, args: string[], action: string): CommandResult {
  const result = launchctlRunner(dependencies)(args);
  if (result.status !== 0) {
    const detail = launchctlDetail(result);
    throw new Error(`${action} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

function launchctlDetail(result: CommandResult): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
}

function systemctlDetail(result: CommandResult): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
}

function runSystemctlOrThrow(dependencies: ServiceDependencies, args: string[], action: string): CommandResult {
  const result = systemctlRunner(dependencies)(args);
  if (result.status !== 0) {
    const detail = systemctlDetail(result);
    throw new Error(`${action} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

function printLaunchdService(dependencies: ServiceDependencies): CommandResult {
  return launchctlRunner(dependencies)(["print", launchdServiceTarget(dependencies)]);
}

function systemdUnitName(): string {
  return `${SERVICE_LABEL}.service`;
}

function printSystemdService(dependencies: ServiceDependencies): CommandResult {
  return systemctlRunner(dependencies)(["is-active", systemdUnitName()]);
}

function sleepFrom(dependencies: ServiceDependencies): (ms: number) => Promise<void> {
  return dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
}

async function waitForLaunchdLoaded(
  dependencies: ServiceDependencies,
  input: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<boolean> {
  const intervalMs = input.intervalMs ?? 100;
  const deadline = Date.now() + (input.timeoutMs ?? 1_500);
  while (true) {
    if (printLaunchdService(dependencies).status === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleepFrom(dependencies)(intervalMs);
  }
}

async function waitForLaunchdUnloaded(
  dependencies: ServiceDependencies,
  input: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<boolean> {
  const intervalMs = input.intervalMs ?? 100;
  const deadline = Date.now() + (input.timeoutMs ?? 1_500);
  while (true) {
    if (printLaunchdService(dependencies).status !== 0) return true;
    if (Date.now() >= deadline) return false;
    await sleepFrom(dependencies)(intervalMs);
  }
}

async function waitForSystemdActive(
  dependencies: ServiceDependencies,
  input: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<boolean> {
  const intervalMs = input.intervalMs ?? 100;
  const deadline = Date.now() + (input.timeoutMs ?? 1_500);
  while (true) {
    const result = printSystemdService(dependencies);
    if (result.status === 0 && result.stdout.trim() === "active") return true;
    if (Date.now() >= deadline) return false;
    await sleepFrom(dependencies)(intervalMs);
  }
}

async function waitForSystemdInactive(
  dependencies: ServiceDependencies,
  input: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<boolean> {
  const intervalMs = input.intervalMs ?? 100;
  const deadline = Date.now() + (input.timeoutMs ?? 1_500);
  while (true) {
    const result = printSystemdService(dependencies);
    if (result.status !== 0 || result.stdout.trim() !== "active") return true;
    if (Date.now() >= deadline) return false;
    await sleepFrom(dependencies)(intervalMs);
  }
}

async function waitForServiceLoaded(
  dependencies: ServiceDependencies,
  input: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<boolean> {
  const controller = serviceControllerFrom(dependencies);
  if (controller === "launchd") return waitForLaunchdLoaded(dependencies, input);
  if (controller === "systemd") return waitForSystemdActive(dependencies, input);
  return false;
}

async function waitForServiceUnloaded(
  dependencies: ServiceDependencies,
  input: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<boolean> {
  const controller = serviceControllerFrom(dependencies);
  if (controller === "launchd") return waitForLaunchdUnloaded(dependencies, input);
  if (controller === "systemd") return waitForSystemdInactive(dependencies, input);
  return true;
}

function serviceWorkingDirectory(configPath: string): string {
  const config = readCliConfig(configPath);
  return config.daemon.repositories[0]?.checkoutPath ?? dirname(configPath);
}

function serviceProgramArguments(options: ServiceCommandOptions, dependencies: ServiceDependencies): string[] {
  const paths = servicePaths(options, dependencies);
  return [
    dependencies.nodePath ?? process.execPath,
    dependencies.cliEntry ?? process.argv[1] ?? "opentag",
    "service",
    "run",
    "--mode",
    "background",
    "--config",
    paths.configPath
  ];
}

function positiveIntegerOption(flag: string, value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received ${value}`);
  }
  return String(parsed);
}

function serviceHardeningEnvironment(options: ServiceCommandOptions): Record<string, string> {
  const maxRequestBodyBytes = positiveIntegerOption("--max-request-body-bytes", options.maxRequestBodyBytes);
  const rateLimitWindowMs = positiveIntegerOption("--rate-limit-window-ms", options.rateLimitWindowMs);
  const rateLimitMaxRequests = positiveIntegerOption("--rate-limit-max-requests", options.rateLimitMaxRequests);
  const environment: Record<string, string> = {
    ...(maxRequestBodyBytes ? { OPENTAG_MAX_REQUEST_BODY_BYTES: maxRequestBodyBytes } : {}),
    ...(rateLimitWindowMs ? { OPENTAG_RATE_LIMIT_WINDOW_MS: rateLimitWindowMs } : {}),
    ...(rateLimitMaxRequests ? { OPENTAG_RATE_LIMIT_MAX_REQUESTS: rateLimitMaxRequests } : {}),
    ...(options.rateLimitDisabled ? { OPENTAG_RATE_LIMIT_DISABLED: "true" } : {})
  };
  dispatcherRuntimeHardeningInputFromEnv(environment);
  return environment;
}

function configured(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function connectorStatus(ready: boolean, detail: string): string {
  return ready ? `ready (${detail})` : `missing (${detail})`;
}

function formatConnectorReadiness(config: OpenTagCliConfig): string[] {
  const lines = ["Connectors:"];
  const github = config.platforms.github;
  if (github) {
    const applyReady = config.daemon.githubApplyToken === null ? "disabled" : configured(config.daemon.githubApplyToken ?? config.daemon.githubToken) ? "ready" : "missing";
    lines.push(
      `  github: ingress=repository_webhook path=${github.webhookPath ?? "/github/webhooks"} port=${github.port ?? "default"}, delivery=kernel_blocked, apply=${applyReady}, target=github:${github.owner}/${github.repo}`
    );
  }

  const gitlab = config.platforms.gitlab;
  if (gitlab) {
    lines.push(
      `  gitlab: ingress=project_webhook path=${gitlab.webhookPath ?? "/gitlab/webhooks"} port=${gitlab.port ?? "default"}, delivery=kernel_blocked, target=gitlab:${gitlab.projectPathWithNamespace}, baseUrl=${gitlab.baseUrl}`
    );
  }

  const linear = config.platforms.linear;
  if (linear) {
    const target = linear.projectTarget;
    lines.push(
      `  linear: ingress=workspace_webhook path=${linear.webhookPath ?? "/linear/webhooks"} port=${linear.port ?? "default"}, delivery=kernel_blocked, target=${target ? `${target.repoProvider}:${target.owner}/${target.repo}` : "unset"}`
    );
  }

  const discord = config.platforms.discord;
  if (discord) {
    const mode = discord.mode ?? "gateway";
    if (mode === "webhook") {
      lines.push(
        `  discord: ingress=dispatcher_interactions path=${discord.webhookPath ?? "/discord/interactions"}, delivery=kernel_blocked, signature=${connectorStatus(configured(discord.publicKey), "publicKey")}`
      );
    } else {
      lines.push(`  discord: ingress=gateway ${connectorStatus(configured(discord.botToken), "botToken")}, delivery=kernel_blocked, tunnel=not required`);
    }
  }

  const teams = config.platforms.teams;
  if (teams) {
    lines.push(
      `  teams: ingress=dispatcher_messages path=${teams.webhookPath ?? "/teams/messages"}, delivery=kernel_blocked, tenant=${teams.tenantId ?? "any"}`
    );
  }

  const slack = config.platforms.slack;
  if (slack) {
    const mode = slack.mode ?? "events_api";
    const ingressReady = mode === "socket_mode" ? configured(slack.appToken) : configured(slack.signingSecret);
    const ingressDetail = mode === "socket_mode" ? "appToken" : `signingSecret port=${slack.port ?? "default"}`;
    lines.push(
      `  slack: ingress=${mode} ${connectorStatus(ingressReady, ingressDetail)}, delivery=kernel_blocked, source=${slack.teamId}/${slack.channelId}`
    );
  }

  const lark = config.platforms.lark;
  if (lark) {
    const credentialsReady = configured(lark.appId) && configured(lark.appSecret);
    const addressing = lark.botOpenId ? "bot_open_id configured" : "bot identity may need discovery";
    lines.push(
      `  lark: ingress=long_connection tenant=${lark.domain} ${connectorStatus(credentialsReady, "appId/appSecret")}, delivery=kernel_blocked, addressing=${addressing}`
    );
  }

  return lines.length > 1 ? lines : [...lines, "  none configured"];
}

function serviceCliPath(dependencies: ServiceDependencies): string {
  const controller = serviceControllerFrom(dependencies);
  return controller === "systemd" ? linuxServiceCliPath(homeFrom(dependencies)) : launchAgentCliPath;
}

function serviceEnvironment(options: ServiceCommandOptions, paths: ServicePaths, dependencies: ServiceDependencies): Record<string, string> {
  return {
    OPENTAG_CONFIG_PATH: paths.configPath,
    PATH: serviceCliPath(dependencies),
    ...serviceHardeningEnvironment(options)
  };
}

export function installService(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  const controller = assertSupportedServiceController(dependencies);
  const paths = servicePaths(options, dependencies);
  const workingDirectory = serviceWorkingDirectory(paths.configPath);
  ensurePrivateDirectory(paths.logsDir);
  if (controller === "launchd") {
    mkdirSync(dirname(paths.plistPath), { recursive: true });
    const plist = buildLaunchAgentPlist({
      label: paths.label,
      programArguments: serviceProgramArguments(options, dependencies),
      runAtLoad: true,
      keepAlive: true,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      workingDirectory,
      environment: serviceEnvironment(options, paths, dependencies)
    });
    writeFileSync(paths.plistPath, plist, { mode: 0o644 });
    return paths;
  }
  mkdirSync(dirname(paths.unitPath), { recursive: true });
  const unit = buildSystemdUserService({
    label: paths.label,
    execStart: serviceProgramArguments(options, dependencies),
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    workingDirectory,
    environment: serviceEnvironment(options, paths, dependencies)
  });
  writeFileSync(paths.unitPath, unit, { mode: 0o644 });
  runSystemctlOrThrow(dependencies, ["daemon-reload"], "systemctl --user daemon-reload");
  runSystemctlOrThrow(dependencies, ["enable", systemdUnitName()], "systemctl --user enable");
  return paths;
}

function installed(paths: ServicePaths, controller: ServiceController): boolean {
  if (controller === "launchd") return existsSync(paths.plistPath);
  if (controller === "systemd") return existsSync(paths.unitPath);
  return false;
}

function isNotLoaded(result: CommandResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return text.includes("no such process") || text.includes("could not find service") || text.includes("service is not loaded");
}

function isSystemdNotLoaded(result: CommandResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return text.includes("could not be found") || text.includes("not loaded") || text.includes("not-found") || text.includes("no such");
}

export function startService(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  const controller = assertSupportedServiceController(dependencies);
  const paths = servicePaths(options, dependencies);
  if (!installed(paths, controller)) {
    throw new Error(`OpenTag service is not installed. Run \`opentag service install --config ${paths.configPath}\` first.`);
  }
  if (controller === "systemd") {
    runSystemctlOrThrow(dependencies, ["daemon-reload"], "systemctl --user daemon-reload");
    runSystemctlOrThrow(dependencies, ["start", systemdUnitName()], "systemctl --user start");
    return paths;
  }
  const launchctl = launchctlRunner(dependencies);
  const bootstrap = launchctl(["bootstrap", launchdDomain(dependencies), paths.plistPath]);
  if (bootstrap.status !== 0) {
    const print = printLaunchdService(dependencies);
    if (print.status !== 0) {
      const detail = launchctlDetail(bootstrap);
      throw new Error(`launchctl bootstrap failed${detail ? `: ${detail}` : "."}`);
    }
  }
  const kickstart = launchctl(["kickstart", "-k", launchdServiceTarget(dependencies)]);
  if (kickstart.status !== 0 && printLaunchdService(dependencies).status !== 0) {
    const detail = launchctlDetail(kickstart);
    throw new Error(`launchctl kickstart failed${detail ? `: ${detail}` : "."}`);
  }
  return paths;
}

export function stopService(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  const controller = assertSupportedServiceController(dependencies);
  const paths = servicePaths(options, dependencies);
  if (!installed(paths, controller)) return paths;
  if (controller === "systemd") {
    const result = systemctlRunner(dependencies)(["stop", systemdUnitName()]);
    if (result.status !== 0 && !isSystemdNotLoaded(result)) {
      const detail = systemctlDetail(result);
      throw new Error(`systemctl --user stop failed${detail ? `: ${detail}` : "."}`);
    }
    return paths;
  }
  const launchctl = launchctlRunner(dependencies);
  const first = launchctl(["bootout", launchdServiceTarget(dependencies)]);
  if (first.status !== 0) {
    const second = launchctl(["bootout", launchdDomain(dependencies), paths.plistPath]);
    if (second.status !== 0 && !isNotLoaded(second)) {
      const firstDetail = isNotLoaded(first) ? "" : launchctlDetail(first);
      const detail = [launchctlDetail(second), firstDetail].filter(Boolean).join("\n");
      throw new Error(`launchctl bootout failed${detail ? `: ${detail}` : "."}`);
    }
  }
  return paths;
}

export function uninstallService(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  const controller = assertSupportedServiceController(dependencies);
  const paths = stopService(options, dependencies);
  if (controller === "launchd") {
    rmSync(paths.plistPath, { force: true });
    return paths;
  }
  const disabled = systemctlRunner(dependencies)(["disable", systemdUnitName()]);
  if (disabled.status !== 0 && !isSystemdNotLoaded(disabled)) {
    const detail = systemctlDetail(disabled);
    throw new Error(`systemctl --user disable failed${detail ? `: ${detail}` : "."}`);
  }
  rmSync(paths.unitPath, { force: true });
  runSystemctlOrThrow(dependencies, ["daemon-reload"], "systemctl --user daemon-reload");
  return paths;
}

export function enableServiceAutostart(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  const controller = assertSupportedServiceController(dependencies);
  const candidate = servicePaths(options, dependencies);
  const paths = installed(candidate, controller) ? candidate : installService(options, dependencies);
  if (controller === "systemd") {
    runSystemctlOrThrow(dependencies, ["enable", systemdUnitName()], "systemctl --user enable");
    return paths;
  }
  runLaunchctlOrThrow(dependencies, ["enable", launchdServiceTarget(dependencies)], "launchctl enable");
  return paths;
}

export function disableServiceAutostart(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  const controller = assertSupportedServiceController(dependencies);
  const paths = servicePaths(options, dependencies);
  if (installed(paths, controller)) {
    if (controller === "systemd") {
      runSystemctlOrThrow(dependencies, ["disable", systemdUnitName()], "systemctl --user disable");
      return paths;
    }
    runLaunchctlOrThrow(dependencies, ["disable", launchdServiceTarget(dependencies)], "launchctl disable");
  }
  return paths;
}

function serviceAutostart(paths: ServicePaths, dependencies: ServiceDependencies, isInstalled: boolean): ServiceStatusSummary["autostart"] {
  if (!isInstalled) return "disabled";
  const controller = serviceControllerFrom(dependencies);
  if (controller === "systemd") {
    const result = systemctlRunner(dependencies)(["is-enabled", systemdUnitName()]);
    const text = `${result.stdout}\n${result.stderr}`.trim().toLowerCase();
    if (result.status === 0 && text.includes("enabled")) return "enabled";
    if (text.includes("disabled") || text.includes("not-found") || text.includes("could not be found")) return "disabled";
    return "unknown";
  }
  if (controller !== "launchd") return "unknown";
  const result = launchctlRunner(dependencies)(["print-disabled", launchdDomain(dependencies)]);
  if (result.status !== 0) return "unknown";
  const escapedLabel = SERVICE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const disabledEntry = new RegExp(`"${escapedLabel}"\\s*=>\\s*(true|disabled)`).test(result.stdout);
  if (disabledEntry) return "disabled";
  const enabledEntry = new RegExp(`"${escapedLabel}"\\s*=>\\s*(false|enabled)`).test(result.stdout);
  if (enabledEntry) return "enabled";
  return "enabled";
}

export function getServiceStatus(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServiceStatusSummary {
  const paths = servicePaths(options, dependencies);
  const controller = serviceControllerFrom(dependencies);
  const isInstalled = installed(paths, controller);
  let running: ServiceStatusSummary["running"] = isInstalled ? "stopped" : "unknown";
  if (controller === "launchd" && isInstalled) {
    const result = launchctlRunner(dependencies)(["print", launchdServiceTarget(dependencies)]);
    running = result.status === 0 ? "running" : "stopped";
  } else if (controller === "systemd" && isInstalled) {
    const result = systemctlRunner(dependencies)(["is-active", systemdUnitName()]);
    running = result.status === 0 && result.stdout.trim() === "active" ? "running" : "stopped";
  }

  let runtimeMode: ServiceStatusSummary["runtimeMode"] = "unknown";
  let relayUrl: string | undefined;
  let relaySecurity: string[] = [];
  let connectors: string[] = ["Connectors:", "  unavailable (config missing)"];
  let secrets: string[] = ["Secrets:", "  unavailable (config missing)"];
  let capabilities: string[] = ["Capabilities:", "  platform unknown", "  executor unknown"];
  if (existsSync(paths.configPath)) {
    const config = readCliConfig(paths.configPath);
    runtimeMode = runtimeModeFromConfig(config);
    relayUrl = relayUrlFromConfig(config);
    relaySecurity = formatRelaySecurityChecks(relaySecurityChecksFromConfig(config));
    connectors = formatConnectorReadiness(config);
    secrets = formatSecretReadiness(readRedactedCliConfig(paths.configPath));
    const platforms = Object.entries(config.platforms)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key as PlatformId);
    capabilities = formatConfiguredCapabilities({
      platforms,
      executors: config.daemon.repositories.map((repository) => repository.defaultExecutor)
    });
  }

  return {
    ...paths,
    controller,
    installed: isInstalled,
    running,
    runtimeMode,
    runtimeReadiness: running === "running" ? "unverified" : running === "stopped" ? "stopped" : "unknown",
    ...(relayUrl ? { relayUrl } : {}),
    relaySecurity,
    connectors,
    secrets,
    capabilities,
    serviceHardening: formatServiceHardening(paths),
    autostart: serviceAutostart(paths, dependencies, isInstalled)
  };
}

function readLaunchAgentEnvironment(paths: ServicePaths): Record<string, string> {
  if (!existsSync(paths.plistPath)) return {};
  const plist = readFileSync(paths.plistPath, "utf8");
  const environmentBlock = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  const body = environmentBlock?.[1];
  if (!body) return {};
  return Object.fromEntries(
    Array.from(body.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)).flatMap((match) => {
      const key = match[1];
      const value = match[2];
      return key !== undefined && value !== undefined ? [[unescapeXml(key), unescapeXml(value)]] : [];
    })
  );
}

function unescapeSystemdQuotedValue(value: string): string {
  return value
    .replaceAll("%%", "%")
    .replaceAll('\\"', '"')
    .replaceAll("\\$", "$")
    .replaceAll("\\\\", "\\");
}

function readSystemdEnvironment(paths: ServicePaths): Record<string, string> {
  if (!existsSync(paths.unitPath)) return {};
  const unit = readFileSync(paths.unitPath, "utf8");
  return Object.fromEntries(
    unit.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^Environment=(?:"((?:\\.|[^"])*)"|(.+))$/);
      const raw = match?.[1] ?? match?.[2];
      if (!raw) return [];
      const value = unescapeSystemdQuotedValue(raw);
      const separator = value.indexOf("=");
      if (separator <= 0) return [];
      return [[value.slice(0, separator), value.slice(separator + 1)]];
    })
  );
}

function readServiceEnvironment(paths: ServicePaths): Record<string, string> {
  return {
    ...readLaunchAgentEnvironment(paths),
    ...readSystemdEnvironment(paths)
  };
}

function formatServiceHardening(paths: ServicePaths): string[] {
  const environment = readServiceEnvironment(paths);
  const configured = serviceHardeningEnvKeys
    .filter((key) => environment[key])
    .map((key) => `  ${key}=${environment[key]}`);
  return ["Service Hardening:", ...(configured.length ? configured : ["  dispatcher hardening env not configured in service definition"])];
}

function doctorCounts(checks: DoctorCheck[]): { fail: number; warn: number } {
  return {
    fail: checks.filter((check) => check.status === "fail").length,
    warn: checks.filter((check) => check.status === "warn").length
  };
}

function formatRuntimeDiagnostic(check: DoctorCheck): string {
  return `${check.status.toUpperCase()} ${check.name}: ${check.message}`;
}

function runtimeReadinessFromHeartbeatChecks(checks: DoctorCheck[]): Pick<ServiceStatusSummary, "runtimeReadiness" | "runtimeReadinessDetail"> | null {
  if (checks.some((check) => check.status === "fail")) return null;
  const heartbeat = checks.find((check) => check.name === "runner heartbeat" && check.status === "warn");
  if (!heartbeat) return null;
  if (heartbeat.message.startsWith("stale;")) {
    return {
      runtimeReadiness: "stale_heartbeat",
      runtimeReadinessDetail: heartbeat.message
    };
  }
  if (heartbeat.message.startsWith("no heartbeat observed")) {
    return {
      runtimeReadiness: "starting",
      runtimeReadinessDetail: heartbeat.message
    };
  }
  return null;
}

export async function getServiceStatusWithRuntimeReadiness(
  options: ServiceCommandOptions = {},
  dependencies: ServiceDependencies = {}
): Promise<ServiceStatusSummary> {
  const summary = getServiceStatus(options, dependencies);
  if (summary.running !== "running" || !existsSync(summary.configPath) || summary.controller === "unsupported") {
    return summary;
  }

  const config = readCliConfig(summary.configPath);
  const dispatcherUrl = config.daemon.dispatcherUrl;
  const ready = await probeDispatcherHealth({
    dispatcherUrl,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    timeoutMs: dependencies.healthTimeoutMs ?? 1_000
  });
  if (!ready) {
    return {
      ...summary,
      runtimeReadiness: "unreachable",
      runtimeReadinessDetail: `dispatcher healthz failed (${dispatcherUrl})`
    };
  }

  try {
    const checks = await runDoctor({
      config: config.daemon,
      executors: executorsFromConfig(config.daemon),
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      ...(dependencies.commandRunner ? { commandRunner: dependencies.commandRunner } : {}),
      ...(dependencies.codexConfigPath ? { codexConfigPath: dependencies.codexConfigPath } : {})
    });
    const counts = doctorCounts(checks);
    const diagnostics = checks.filter((check) => check.status !== "ok").map(formatRuntimeDiagnostic);
    const heartbeatReadiness = runtimeReadinessFromHeartbeatChecks(checks);
    if (heartbeatReadiness) {
      return {
        ...summary,
        ...heartbeatReadiness,
        ...(diagnostics.length ? { runtimeDiagnostics: diagnostics } : {})
      };
    }
    if (doctorHasFailures(checks) || counts.warn > 0) {
      return {
        ...summary,
        runtimeReadiness: "degraded",
        runtimeReadinessDetail: `doctor checks degraded (${counts.fail} fail, ${counts.warn} warn)`,
        runtimeDiagnostics: diagnostics
      };
    }
    return {
      ...summary,
      runtimeReadiness: "ready",
      runtimeReadinessDetail: `dispatcher healthz ok; doctor checks ok (${checks.length} checks)`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...summary,
      runtimeReadiness: "degraded",
      runtimeReadinessDetail: `doctor checks failed: ${message}`,
      runtimeDiagnostics: [`FAIL doctor checks: ${message}`]
    };
  }
}

export function formatServiceStatus(summary: ServiceStatusSummary): string {
  const definitionLine =
    summary.controller === "launchd"
      ? `LaunchAgent: ${summary.plistPath}`
      : summary.controller === "systemd"
        ? `Systemd unit: ${summary.unitPath}`
        : undefined;
  return [
    `Controller: ${summary.controller}`,
    `Installed: ${summary.installed ? "yes" : "no"}`,
    `Running: ${summary.running}`,
    `Autostart: ${summary.autostart}`,
    `Config: ${summary.configPath}`,
    `Runtime: ${summary.runtimeMode}`,
    `OpenTag runtime: ${summary.runtimeReadiness}${summary.runtimeReadinessDetail ? ` (${summary.runtimeReadinessDetail})` : ""}`,
    ...(summary.runtimeDiagnostics?.length ? ["Runtime Checks:", ...summary.runtimeDiagnostics.map((diagnostic) => `  ${diagnostic}`)] : []),
    ...(summary.relayUrl ? [`Relay: ${summary.relayUrl}`] : []),
    ...summary.relaySecurity,
    ...summary.connectors,
    ...summary.secrets,
    ...summary.capabilities,
    ...summary.serviceHardening,
    ...(definitionLine ? [definitionLine] : []),
    `Stdout log: ${summary.stdoutPath}`,
    `Stderr log: ${summary.stderrPath}`,
    ...(summary.controller === "unsupported" ? [unsupportedMessage()] : [])
  ].join("\n");
}

function parseLines(value: string | number | undefined): number {
  if (value === undefined) return 80;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--lines must be a positive integer, received ${value}`);
  }
  return parsed;
}

function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) {
    return "(log file does not exist yet)";
  }
  const maxReadBytes = 1024 * 1024;
  const fd = openSync(path, "r");
  let content = "";
  try {
    const stats = fstatSync(fd);
    const bytesToRead = Math.min(stats.size, maxReadBytes);
    const position = stats.size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
    content = buffer.subarray(0, bytesRead).toString("utf8");
    const entries = content.split(/\r?\n/);
    if (entries.at(-1) === "") entries.pop();
    if (position > 0 && entries.length > 1) {
      entries.shift();
    }
    return entries.slice(-lines).join("\n") || "(log file is empty)";
  } finally {
    closeSync(fd);
  }
}

export function formatServiceLogs(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): string {
  const paths = servicePaths(options, dependencies);
  const lines = parseLines(options.lines);
  return [
    `== ${paths.stdoutPath} ==`,
    tailFile(paths.stdoutPath, lines),
    `== ${paths.stderrPath} ==`,
    tailFile(paths.stderrPath, lines)
  ].join("\n");
}

export async function runServiceInstallCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = installService(options, dependencies);
  const controller = serviceControllerFrom(dependencies);
  loggerFrom(dependencies).log(`OpenTag service installed: ${controller === "systemd" ? paths.unitPath : paths.plistPath}`);
  loggerFrom(dependencies).log("It will start at login. Run `opentag service start` to start it now.");
}

export async function installAndStartService(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): Promise<ServicePaths> {
  installService(options, dependencies);
  const paths = startService(options, dependencies);
  if (!(await waitForServiceLoaded(dependencies))) {
    throw new Error("OpenTag service start did not leave the service manager running. Run `opentag service status` and `opentag service logs` for details.");
  }
  return paths;
}

export async function runServiceStartCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = startService(options, dependencies);
  if (!(await waitForServiceLoaded(dependencies))) {
    throw new Error("OpenTag service start did not leave the service manager running. Run `opentag service status` and `opentag service logs` for details.");
  }
  loggerFrom(dependencies).log(`OpenTag service started: ${paths.label}`);
}

export async function runServiceStopCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = stopService(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service stopped: ${paths.label}`);
}

export async function runServiceRestartCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  stopService(options, dependencies);
  await waitForServiceUnloaded(dependencies, { timeoutMs: 1_000 });
  let paths = startService(options, dependencies);
  let loaded = await waitForServiceLoaded(dependencies, { timeoutMs: 500 });
  if (!loaded) {
    paths = startService(options, dependencies);
    loaded = await waitForServiceLoaded(dependencies);
  }
  if (!loaded) {
    throw new Error("OpenTag service restart did not leave the service manager running. Run `opentag service status` and `opentag service logs` for details.");
  }
  loggerFrom(dependencies).log(`OpenTag service restarted: ${paths.label}`);
}

export async function runServiceUninstallCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = uninstallService(options, dependencies);
  const controller = serviceControllerFrom(dependencies);
  loggerFrom(dependencies).log(`OpenTag service uninstalled: ${controller === "systemd" ? paths.unitPath : paths.plistPath}`);
}

export async function runServiceStatusCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const summary = await getServiceStatusWithRuntimeReadiness(options, dependencies);
  loggerFrom(dependencies).log(formatServiceStatus(summary));
  if (summary.controller === "unsupported") {
    process.exitCode = 1;
  }
}

export async function runServiceLogsCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  loggerFrom(dependencies).log(formatServiceLogs(options, dependencies));
}

export async function runServiceAutostartEnableCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = enableServiceAutostart(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service autostart enabled: ${paths.label}`);
}

export async function runServiceAutostartDisableCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = disableServiceAutostart(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service autostart disabled: ${paths.label}`);
}

export async function runServiceRunCommand(options: ServiceCommandOptions): Promise<void> {
  if (options.mode && options.mode !== "background") {
    throw new Error(`Unsupported service run mode: ${options.mode}`);
  }
  await runStartCommand({ ...(options.config ? { config: options.config } : {}), background: true });
}
