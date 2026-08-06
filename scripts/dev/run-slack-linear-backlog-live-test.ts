#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectRegistryCliPackageSet, inspectRegistryInstalledDependency } from "../test/github-registry-artifact.js";
import {
  appendSlackLinearCleanupFailure,
  buildSlackLinearDiagnosticLog,
  buildRegistrySlackLinearConfig,
  buildRegistrySlackLinearChildEnv,
  buildRegistryInstallerEnv,
  expectedLinearBacklogPageCount,
  hasExpectedLinearBacklogProjectMapping,
  isGracefulCliExit,
  normalizeLinearIssueRef,
  runSlackLinearCleanupActions,
  selectLinearProjectFromDiscoveryResponse,
  selectCorrelatedSlackLinearReply,
  selectSlackChannelBinding,
  stopSlackLinearProcessForCleanup,
  validateLinearLiveGraphqlUrl
} from "../test/slack-linear-live-acceptance.js";

const execFile = promisify(execFileCallback);
const DEFAULT_LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const DEFAULT_WAIT_SECONDS = 300;
const REPLY_DUPLICATE_OBSERVATION_MS = 10_000;
const EXPECTED_BETTER_SQLITE3_VERSION = "13.0.2";
const MAX_LOG_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;

type SlackApiResponse = JsonObject & { ok?: boolean; error?: string };

type LinearProxyEvidence = {
  requestCount: number;
  backlogQueryCount: number;
  correlationInjectionCount: number;
  mutationAttemptCount: number;
  requests: Array<{
    receivedAtMs: number;
    completedAtMs?: number;
    after: string | null;
  }>;
  upstreamErrorCount: number;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Slack /linear registry live acceptance.`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function integerEnv(name: string, fallback: number, minimum = 1): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return value;
}

function linearAuthorizationHeader(token: string): string {
  const trimmed = token.trim();
  if (/^bearer\s+/iu.test(trimmed)) return trimmed;
  if (trimmed.startsWith("lin_api_")) return trimmed;
  return `Bearer ${trimmed}`;
}

async function slackApi<T extends SlackApiResponse>(method: string, token: string, query?: URLSearchParams): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (query) url.search = query.toString();
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  const body = (await response.json().catch(() => ({}))) as T;
  if (!response.ok || !body.ok) throw new Error(`Slack ${method} failed: ${body.error ?? `http_${response.status}`}`);
  return body;
}

async function fetchLinearProject(input: { token: string; issueRef: string; graphqlUrl: string }) {
  const response = await fetch(input.graphqlUrl, {
    method: "POST",
    headers: {
      authorization: linearAuthorizationHeader(input.token),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query: `query OpenTagSlackLinearLiveIssue($id: String!) {
  issue(id: $id) { id identifier project { id name } }
}`,
      variables: { id: input.issueRef }
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.json().catch(() => undefined);
  return selectLinearProjectFromDiscoveryResponse({ status: response.status, body });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not resolve local acceptance proxy port.");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

async function startLinearAuditProxy(input: {
  upstreamUrl: string;
  forcedPageSize: number;
  expectedProjectId: string;
  correlationMarker: string;
}): Promise<{ server: Server; url: string; evidence: LinearProxyEvidence }> {
  const evidence: LinearProxyEvidence = {
    requestCount: 0,
    backlogQueryCount: 0,
    correlationInjectionCount: 0,
    mutationAttemptCount: 0,
    requests: [],
    upstreamErrorCount: 0
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/graphql") {
        response.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of request) {
        raw += String(chunk);
        if (raw.length > 1024 * 1024) throw new Error("Linear proxy request exceeded 1 MiB.");
      }
      const body = JSON.parse(raw) as { query?: unknown; variables?: unknown };
      const query = typeof body.query === "string" ? body.query : "";
      const variables = isObject(body.variables) ? { ...body.variables } : {};
      evidence.requestCount += 1;
      if (/\bmutation\b/iu.test(query)) {
        evidence.mutationAttemptCount += 1;
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ errors: [{ message: "Mutation blocked by Slack /linear live acceptance." }] }));
        return;
      }
      if (!/\bquery\s+OpenTagProjectBacklog\b/u.test(query)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ errors: [{ message: "Unexpected GraphQL operation in Slack /linear live acceptance." }] }));
        return;
      }
      if (!hasExpectedLinearBacklogProjectMapping(variables, input.expectedProjectId)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ errors: [{ message: "Linear backlog query used an unexpected project mapping." }] }));
        return;
      }
      evidence.backlogQueryCount += 1;
      const receipt: LinearProxyEvidence["requests"][number] = {
        receivedAtMs: Date.now(),
        after: typeof variables.after === "string" ? variables.after : null
      };
      evidence.requests.push(receipt);
      variables.first = input.forcedPageSize;

      const upstream = await fetch(input.upstreamUrl, {
        method: "POST",
        headers: {
          authorization: String(request.headers.authorization ?? ""),
          "content-type": "application/json"
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000)
      });
      let upstreamBody = await upstream.text();
      if (upstream.ok) {
        const providerBody = JSON.parse(upstreamBody) as unknown;
        if (!isObject(providerBody) || !isObject(providerBody.data) || !isObject(providerBody.data.project)) {
          throw new Error("Linear backlog response did not contain the audited project receipt.");
        }
        const projectName = providerBody.data.project.name;
        if (typeof projectName !== "string" || !projectName.trim()) {
          throw new Error("Linear backlog response did not contain an auditable project name.");
        }
        providerBody.data.project.name = `${projectName} · ${input.correlationMarker}`;
        upstreamBody = JSON.stringify(providerBody);
        evidence.correlationInjectionCount += 1;
      }
      receipt.completedAtMs = Date.now();
      if (!upstream.ok) evidence.upstreamErrorCount += 1;
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      response.end(upstreamBody);
    } catch (error) {
      evidence.upstreamErrorCount += 1;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ errors: [{ message: error instanceof Error ? error.message : "Linear proxy failure" }] }));
    }
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}/graphql`, evidence };
}

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function waitForLog(input: { child: ChildProcess; readLog: () => string; pattern: RegExp; timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.pattern.test(input.readLog())) return;
    if (input.child.exitCode !== null) throw new Error(`Registry OpenTag CLI exited before readiness with code ${input.child.exitCode}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for registry OpenTag CLI readiness (${input.pattern.source}).`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for registry OpenTag CLI shutdown.")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
}

type SlackMessage = {
  ts?: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
};

async function waitForSlackSourceMessage(input: {
  token: string;
  channelId: string;
  botUserId: string;
  startedAt: number;
  timeoutMs: number;
}): Promise<SlackMessage & { ts: string }> {
  const deadline = Date.now() + input.timeoutMs;
  const expectedText = `<@${input.botUserId}> /linear`;
  while (Date.now() < deadline) {
    const body = await slackApi<SlackApiResponse & { messages?: SlackMessage[] }>(
      "conversations.history",
      input.token,
      new URLSearchParams({ channel: input.channelId, oldest: input.startedAt.toFixed(6), limit: "20", inclusive: "true" })
    );
    const messages = body.messages?.filter(
      (candidate) =>
        candidate.ts &&
        Number(candidate.ts) >= input.startedAt &&
        candidate.user &&
        candidate.user !== input.botUserId &&
        !candidate.bot_id &&
        !candidate.subtype &&
        candidate.text?.trim() === expectedText
    );
    if ((messages?.length ?? 0) > 1) throw new Error("Observed multiple matching human Slack /linear source messages; correlation is ambiguous.");
    const message = messages?.[0];
    if (message?.ts) return { ...message, ts: message.ts };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Timed out waiting for a real Slack message containing exactly ${expectedText}.`);
}

async function waitForSlackReply(input: {
  token: string;
  channelId: string;
  threadTs: string;
  botUserId: string;
  correlationMarker: string;
  getAuditCompletedAtMs: () => number | undefined;
  timeoutMs: number;
}): Promise<NonNullable<ReturnType<typeof selectCorrelatedSlackLinearReply>>> {
  const deadline = Date.now() + input.timeoutMs;
  let firstSuccessfulReplyObservedAt: number | undefined;
  while (Date.now() < deadline) {
    const body = await slackApi<SlackApiResponse & { messages?: SlackMessage[] }>(
      "conversations.replies",
      input.token,
      new URLSearchParams({ channel: input.channelId, ts: input.threadTs, limit: "30" })
    );
    const auditCompletedAtMs = input.getAuditCompletedAtMs();
    const reply = selectCorrelatedSlackLinearReply({
      messages: body.messages ?? [],
      threadTs: input.threadTs,
      botUserId: input.botUserId,
      correlationMarker: input.correlationMarker,
      ...(auditCompletedAtMs !== undefined ? { auditCompletedAtMs } : {})
    });
    if (reply) {
      firstSuccessfulReplyObservedAt ??= Date.now();
      if (Date.now() - firstSuccessfulReplyObservedAt >= REPLY_DUPLICATE_OBSERVATION_MS) return reply;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  if (firstSuccessfulReplyObservedAt !== undefined) {
    throw new Error("Observed a successful Slack /linear reply but timed out before completing the duplicate-reply observation window.");
  }
  throw new Error("Timed out waiting for the successful Slack /linear thread reply.");
}

async function main(): Promise<void> {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const expectedVersion = optionalEnv("OPENTAG_SLACK_LINEAR_EXPECTED_CLI_VERSION") ?? "0.9.0";
  const configSourcePath = resolve(requiredEnv("OPENTAG_CONFIG_PATH"));
  const botToken = requiredEnv("OPENTAG_SLACK_BOT_TOKEN");
  const appToken = requiredEnv("OPENTAG_SLACK_APP_TOKEN");
  const linearToken = requiredEnv("OPENTAG_LINEAR_SMOKE_TOKEN");
  const linearIssueRef = normalizeLinearIssueRef(
    optionalEnv("OPENTAG_LINEAR_SMOKE_ISSUE") ?? requiredEnv("OPENTAG_LINEAR_SMOKE_ISSUE_ID")
  );
  const linearUpstreamUrl = validateLinearLiveGraphqlUrl(
    optionalEnv("OPENTAG_LINEAR_SMOKE_GRAPHQL_URL") ?? DEFAULT_LINEAR_GRAPHQL_URL
  );
  const waitSeconds = integerEnv("OPENTAG_SLACK_LINEAR_WAIT_SECONDS", DEFAULT_WAIT_SECONDS);
  const forcedPageSize = integerEnv("OPENTAG_SLACK_LINEAR_PROXY_PAGE_SIZE", 2);
  const correlationMarker = `OpenTagLive-${randomBytes(12).toString("hex")}`;
  const tempRoot = await mkdtemp(join(tmpdir(), "opentag-slack-linear-registry-live-"));
  const installRoot = join(tempRoot, "registry-install");
  const stateDirectory = join(tempRoot, "state");
  const configPath = join(tempRoot, "opentag.config.json");
  const cliLogPath = join(tempRoot, "opentag.log");
  const reportPath = resolve(
    optionalEnv("OPENTAG_SLACK_LINEAR_REPORT") ??
      join(rootDir, ".omx", "live-e2e", `slack-linear-registry-live-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}.json`)
  );
  let proxy: Awaited<ReturnType<typeof startLinearAuditProxy>> | undefined;
  let child: ChildProcess | undefined;
  let logText = "";
  let harnessFailure: string | undefined;
  let pairingToken: string | undefined;
  let primaryFailure: unknown;
  let hadPrimaryFailure = false;
  let cleanupFailure: unknown;
  let diagnosticFailure: unknown;
  let gracefulShutdown = false;

  try {
    const sourceConfig = JSON.parse(await readFile(configSourcePath, "utf8")) as unknown;
    const binding = selectSlackChannelBinding(sourceConfig, optionalEnv("OPENTAG_SLACK_CHANNEL_ID"));
    const slackAuth = await slackApi<SlackApiResponse & { team_id?: string; user_id?: string }>("auth.test", botToken);
    if (!slackAuth.team_id || !slackAuth.user_id) throw new Error("Slack auth.test did not return team_id and user_id.");
    if (slackAuth.team_id !== binding.teamId) {
      throw new Error("Slack bot token team does not match the configured Slack channel binding.");
    }
    await slackApi(
      "conversations.history",
      botToken,
      new URLSearchParams({ channel: binding.channelId, oldest: (Date.now() / 1000).toFixed(6), limit: "1" })
    );

    const project = await fetchLinearProject({ token: linearToken, issueRef: linearIssueRef, graphqlUrl: linearUpstreamUrl });
    proxy = await startLinearAuditProxy({
      upstreamUrl: linearUpstreamUrl,
      forcedPageSize,
      expectedProjectId: project.id,
      correlationMarker
    });
    const dispatcherPort = await freeLocalPort();
    pairingToken = randomBytes(32).toString("hex");

    await mkdir(installRoot, { recursive: true });
    await writeFile(
      join(installRoot, "package.json"),
      `${JSON.stringify({ name: "opentag-slack-linear-registry-live", private: true }, null, 2)}\n`,
      { mode: 0o600 }
    );
    console.log(`Installing @opentag/cli@${expectedVersion} from the npm registry into an isolated temp root...`);
    const npmUserConfigPath = join(tempRoot, "npm-userconfig");
    const npmGlobalConfigPath = join(tempRoot, "npm-globalconfig");
    await Promise.all([
      writeFile(npmUserConfigPath, "", { mode: 0o600 }),
      writeFile(npmGlobalConfigPath, "", { mode: 0o600 })
    ]);
    const registryProcessEnv = buildRegistryInstallerEnv({
      baseEnv: process.env,
      cacheDirectory: join(tempRoot, "npm-cache"),
      userConfigPath: npmUserConfigPath,
      globalConfigPath: npmGlobalConfigPath
    });
    await execFile(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `@opentag/cli@${expectedVersion}`],
      {
        cwd: installRoot,
        env: registryProcessEnv,
        maxBuffer: 8 * 1024 * 1024
      }
    );
    const cliBin = join(installRoot, "node_modules", ".bin", "opentag");
    const registryInspection = await inspectRegistryCliPackageSet({
      cliBin,
      expectedVersion,
      packageNames: ["@opentag/slack", "@opentag/linear", "@opentag/core"],
      executableEnv: registryProcessEnv
    });
    const nativeDependencyInspection = await inspectRegistryInstalledDependency({
      cliBin,
      packageName: "better-sqlite3",
      expectedVersion: EXPECTED_BETTER_SQLITE3_VERSION
    });
    await execFile("npm", ["rebuild", "better-sqlite3", "--foreground-scripts", "--no-audit", "--no-fund"], {
      cwd: installRoot,
      env: registryProcessEnv,
      maxBuffer: 8 * 1024 * 1024
    });

    const config = buildRegistrySlackLinearConfig({
      stateDirectory,
      databasePath: join(stateDirectory, "opentag.db"),
      worktreeRoot: join(tempRoot, "worktrees"),
      dispatcherUrl: `http://127.0.0.1:${dispatcherPort}`,
      graphqlUrl: proxy.url,
      teamId: binding.teamId,
      channelId: binding.channelId,
      projectId: project.id
    });
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    child = spawn(cliBin, ["start", "--config", configPath], {
      env: buildRegistrySlackLinearChildEnv({
        baseEnv: process.env,
        appToken,
        botToken,
        linearToken,
        pairingToken
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const collectLog = (chunk: Buffer | string) => {
      logText = `${logText}${String(chunk)}`.slice(-MAX_LOG_BYTES);
    };
    child.stdout?.on("data", collectLog);
    child.stderr?.on("data", collectLog);
    await waitForLog({ child, readLog: () => logText, pattern: /OpenTag is running\./u, timeoutMs: 45_000 });
    await waitForLog({ child, readLog: () => logText, pattern: /Slack: using Socket Mode/u, timeoutMs: 10_000 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    if (child.exitCode !== null) throw new Error(`Registry OpenTag CLI exited after readiness with code ${child.exitCode}.`);
    if (proxy.evidence.requestCount !== 0) {
      throw new Error("Linear audit proxy observed backlog traffic before the selected Slack source message.");
    }

    const startedAt = Date.now() / 1000;
    console.log("Registry-installed Slack → Linear acceptance stack is ready.");
    console.log(`Send exactly this message in the configured Slack channel within ${waitSeconds} seconds:`);
    console.log(`  <@${slackAuth.user_id}> /linear`);
    const sourceMessage = await waitForSlackSourceMessage({
      token: botToken,
      channelId: binding.channelId,
      botUserId: slackAuth.user_id,
      startedAt,
      timeoutMs: waitSeconds * 1_000
    });
    const sourceAtMs = Number(sourceMessage.ts) * 1_000;
    if (!Number.isFinite(sourceAtMs)) throw new Error("Slack source message timestamp is invalid.");
    const queryDeadline = Date.now() + 60_000;
    while (proxy.evidence.requests.length === 0 && Date.now() < queryDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    const firstQuery = proxy.evidence.requests[0];
    if (!firstQuery || firstQuery.receivedAtMs < sourceAtMs - 5_000) {
      throw new Error("The audited Linear backlog query is not causally ordered after the selected Slack source message.");
    }
    const reply = await waitForSlackReply({
      token: botToken,
      channelId: binding.channelId,
      threadTs: sourceMessage.ts,
      botUserId: slackAuth.user_id,
      correlationMarker,
      getAuditCompletedAtMs: () => {
        const requests = proxy?.evidence.requests;
        if (!requests?.length || requests.some((request) => request.completedAtMs === undefined)) {
          return undefined;
        }
        return Math.max(...requests.map((request) => request.completedAtMs!));
      },
      timeoutMs: 75_000
    });
    if (proxy.evidence.backlogQueryCount < 1) throw new Error("No audited Linear backlog query reached the real provider.");
    const expectedPageCount = expectedLinearBacklogPageCount(reply.summary.reportedOpenCount, forcedPageSize);
    if (proxy.evidence.requests.length !== expectedPageCount) {
      throw new Error(
        `Audited Linear pagination used ${proxy.evidence.requests.length} pages; expected ${expectedPageCount} for ${reply.summary.reportedOpenCount} open issues at page size ${forcedPageSize}.`
      );
    }
    if (proxy.evidence.mutationAttemptCount !== 0) throw new Error("The read-only /linear path attempted a Linear mutation.");
    if (proxy.evidence.upstreamErrorCount !== 0) throw new Error("The audited Linear provider path recorded an upstream error.");
    if (proxy.evidence.correlationInjectionCount !== proxy.evidence.backlogQueryCount) {
      throw new Error("Not every audited Linear backlog page received the registry runtime correlation marker.");
    }
    if (/\[slack\] failed to handle Socket Mode event:|linear backlog query failed|deliver Slack self-service reply failed/iu.test(logText)) {
      throw new Error("Registry OpenTag CLI logged a Slack /linear processing or reply failure.");
    }

    child.kill("SIGTERM");
    const exit = await waitForExit(child, 35_000);
    gracefulShutdown = isGracefulCliExit(exit);
    if (!gracefulShutdown) throw new Error(`Registry OpenTag CLI did not shut down gracefully (code=${exit.code}, signal=${exit.signal}).`);
    child = undefined;

    const packageReceipt = Object.fromEntries(
      Object.entries(registryInspection.packages).map(([name, receipt]) => [
        name,
        { version: receipt.version, registry: receipt.registry, integrity: receipt.integrity }
      ])
    );
    const report = {
      schemaVersion: "opentag.slack-linear-registry-live.v1",
      acceptedAt: new Date().toISOString(),
      runtime: {
        source: "registry_install",
        credentialEnvironment: "allowlisted",
        expectedVersion,
        executable: {
          package: registryInspection.executable.package,
          version: registryInspection.executable.version,
          registry: registryInspection.executable.registry,
          integrity: registryInspection.executable.integrity
        },
        packages: packageReceipt,
        nativeDependencies: {
          "better-sqlite3": {
            version: nativeDependencyInspection.version,
            registry: nativeDependencyInspection.registry,
            integrity: nativeDependencyInspection.integrity,
            lifecycleScriptsExecutedAfterReceiptVerification: true
          }
        }
      },
      slack: {
        delivery: "provider_socket_mode",
        authVerified: true,
        teamIdSha256: sha256(binding.teamId),
        channelIdSha256: sha256(binding.channelId),
        sourceThreadObserved: true,
        sourceWasHuman: true,
        runtimeCorrelationMatched: true,
        runtimeCorrelationMarkerSha256: sha256(correlationMarker),
        sourceMessageTsSha256: sha256(sourceMessage.ts),
        replyObserved: true,
        uniqueSuccessfulReply: true,
        replyTsSha256: sha256(reply.message.ts),
        reply: reply.summary,
        sourceToFirstLinearRequestMs: firstQuery.receivedAtMs - sourceAtMs
      },
      linear: {
        provider: new URL(linearUpstreamUrl).origin,
        canonicalEndpointVerified: true,
        projectIdSha256: sha256(project.id),
        queryOnlyConfiguration: true,
        credentialScope: "unknown",
        mutationBlockedByAuditProxy: true,
        tokenSource: "configured_smoke_token",
        forcedPageSize,
        graphqlRequestCount: proxy.evidence.requestCount,
        backlogQueryCount: proxy.evidence.backlogQueryCount,
        pageCount: proxy.evidence.requests.length,
        mutationAttemptCount: proxy.evidence.mutationAttemptCount,
        upstreamErrorCount: proxy.evidence.upstreamErrorCount
      },
      lifecycle: { gracefulShutdown, exitCode: exit.code, exitSignal: exit.signal },
      acceptance: { passed: true }
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await chmod(reportPath, 0o600);
    const mode = (await stat(reportPath)).mode & 0o777;
    if (mode !== 0o600) throw new Error(`Acceptance report permissions are ${mode.toString(8)}; expected 600.`);
    console.log(`Slack → Linear registry-installed live acceptance passed: ${reportPath}`);
  } catch (error) {
    primaryFailure = error;
    hadPrimaryFailure = true;
    harnessFailure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      const cleanupActions: Array<{ name: string; run: () => Promise<void> }> = [];
      if (child && child.exitCode === null && child.signalCode === null) {
        const runningChild = child;
        cleanupActions.push({
          name: "registry CLI cleanup",
          run: async () => {
            await stopSlackLinearProcessForCleanup({
              sendSignal: (signal) => runningChild.kill(signal),
              waitForExit: async () => {
                await waitForExit(runningChild, 35_000);
              }
            });
          }
        });
      }
      if (proxy) {
        const proxyServer = proxy.server;
        cleanupActions.push({ name: "Linear audit proxy cleanup", run: async () => closeServer(proxyServer) });
      }
      await runSlackLinearCleanupActions(cleanupActions);
    } catch (error) {
      cleanupFailure = error;
      harnessFailure = appendSlackLinearCleanupFailure(harnessFailure, error);
    }
    try {
      const diagnosticLog = buildSlackLinearDiagnosticLog({
        cliOutput: logText,
        failureMessage: harnessFailure,
        sensitiveValues: [botToken, appToken, linearToken, pairingToken].filter(
          (value): value is string => value !== undefined
        )
      });
      await writeFile(cliLogPath, diagnosticLog, { mode: 0o600 });
      await chmod(cliLogPath, 0o600);
      console.log(`Temporary diagnostic log retained with mode 0600: ${cliLogPath}`);
    } catch (error) {
      console.error(`Could not retain the temporary CLI diagnostic log: ${error instanceof Error ? error.message : error}`);
      if (!harnessFailure) diagnosticFailure = error;
    }
    console.log(`Temporary acceptance root retained for local audit: ${tempRoot}`);
  }
  if (hadPrimaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (diagnosticFailure) throw diagnosticFailure;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
