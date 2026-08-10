import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenTagEvent } from "@opentag/core";
import { createOpenTagClient, createDispatcherAdminClient, createDispatcherClient } from "@opentag/client";
import { createDispatcherApp } from "@opentag/dispatcher";
import { createEchoExecutor } from "@opentag/runner";
import { describe, expect, it } from "vitest";
import { runOneDaemonIteration } from "../src/daemon.js";

const event: OpenTagEvent = {
  id: "evt_integration",
  source: "github",
  sourceEventId: "comment_integration",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "summarize this", intent: "run", args: {} },
  context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
  workItem: {
    provider: "github",
    kind: "issue",
    externalId: "acme/demo#1",
    uri: "https://github.com/acme/demo/issues/1",
    ownerContainer: {
      provider: "github",
      id: "acme/demo",
      uri: "https://github.com/acme/demo"
    }
  },
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { repoProvider: "github", owner: "acme", repo: "demo" }
};

function fetchForApp(app: ReturnType<typeof createDispatcherApp>): typeof fetch {
  return (async (url, init) => {
    const parsed = new URL(String(url));
    return app.request(`${parsed.pathname}${parsed.search}`, init);
  }) as typeof fetch;
}

function runOpentagd(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.cwd(), "apps/opentagd/node_modules/.bin/tsx"), [
      join(process.cwd(), "apps/opentagd/src/index.ts"),
      ...args
    ], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("opentagd local integration", () => {
  it("preserves managed ownership in generic bind-channels requests", async () => {
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(rawBody) as unknown);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server address.");
    const directory = mkdtempSync(join(tmpdir(), "opentagd-bind-channels-"));
    const configPath = join(directory, "opentag.local.json");
    writeFileSync(configPath, JSON.stringify({
      dispatcherUrl: `http://127.0.0.1:${address.port}`,
      repositories: [],
      channelBindings: [{
        provider: "slack",
        accountId: "T123",
        conversationId: "C456",
        ownership: { mode: "managed", exclusive: true, applicationId: "A123", botId: "U_APP" }
      }]
    }));

    try {
      const result = await runOpentagd(["bind-channels"], {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--conditions=development"].filter(Boolean).join(" "),
        OPENTAG_CONFIG_PATH: configPath
      });

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(requests).toEqual([{
        provider: "slack",
        accountId: "T123",
        conversationId: "C456",
        ownership: { mode: "managed", exclusive: true, applicationId: "A123", botId: "U_APP" }
      }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("registers a runner, creates a run, executes echo once, and records callback queue events", async () => {
    const delivered: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push(`${message.kind}:${message.body}`);
          return { handled: true, outcome: 'accepted' } as const;
        }
      }
    });
    const fetchImpl = fetchForApp(app);
    const dispatcherUrl = "http://dispatcher.test";
    const admin = createDispatcherAdminClient({ dispatcherUrl, runnerId: "runner_1", fetchImpl });
    const client = createOpenTagClient({ dispatcherUrl, fetchImpl });

    await admin.registerRunner("Local Runner");
    await admin.bindRepository({
      provider: "github",
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo",
      defaultExecutor: "echo"
    });
    await client.createRun({ runId: "run_integration", event });

    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [
        {
          provider: "github",
          owner: "acme",
          repo: "demo",
          checkoutPath: "/tmp/demo",
          defaultExecutor: "echo",
          baseBranch: "main",
          pushRemote: "origin"
        }
      ],
      executors: { echo: createEchoExecutor() },
      client: createDispatcherClient({ dispatcherUrl, runnerId: "runner_1", fetchImpl })
    });

    expect(didWork).toBe(true);
    const stored = await client.getRun({ runId: "run_integration" });
    expect(stored.run.status).toBe("succeeded");
    expect(stored.run.result?.summary).toBe("Echoed OpenTag command: summarize this");
    expect(delivered).toEqual([
      "acknowledgement:OpenTag picked this up. Run: `run_integration`",
      "progress:OpenTag progress for `run_integration`: Running with echo.",
      "final:OpenTag finished with **success**.\n\nEchoed OpenTag command: summarize this\n\nVerification:\n- `echo`: passed\n\nArtifacts:\n- report: [Echo diagnosis report](opentag://run/run_integration/echo-report)\n\nNext action: No external state change is suggested for the echo executor result."
    ]);

    const { events } = await client.listRunEvents({ runId: "run_integration" });
    expect(events.map((item) => (item as { type: string }).type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "agent_access_profile.captured",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "routing.decided",
      "run.claimed",
      "run.running",
      "executor.capability.snapshot",
      "callback.progress.queued",
      "callback.progress.delivered",
      "run.progress",
      "run.progress",
      "artifact.created",
      "run.completed",
      "success_metric.observed",
      "callback.final.queued",
      "callback.final.delivered"
    ]);
    expect(events.filter((item) => (item as { type: string }).type === "run.progress")).toEqual([
      expect.objectContaining({ visibility: "audit", message: "Echo executor started for run_integration" }),
      expect.objectContaining({ visibility: "audit", message: "Echo executor completed for run_integration" })
    ]);
  });

  it("blocks a write-capable run through the daemon security gate and records the blocked path", async () => {
    const delivered: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push(`${message.kind}:${message.body}`);
          return { handled: true, outcome: 'accepted' } as const;
        }
      }
    });
    const fetchImpl = fetchForApp(app);
    const dispatcherUrl = "http://dispatcher.test";
    const admin = createDispatcherAdminClient({ dispatcherUrl, runnerId: "runner_1", fetchImpl });
    const client = createOpenTagClient({ dispatcherUrl, fetchImpl });

    await admin.registerRunner("Local Runner");
    await admin.bindRepository({
      provider: "github",
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo",
      defaultExecutor: "codex"
    });
    await client.createRun({
      runId: "run_blocked",
      event: {
        ...event,
        id: "evt_blocked",
        sourceEventId: "comment_blocked",
        command: { rawText: "fix this", intent: "fix", args: {} }
      }
    });

    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [
        {
          provider: "github",
          owner: "acme",
          repo: "demo",
          checkoutPath: "/tmp/demo",
          defaultExecutor: "codex",
          baseBranch: "main",
          pushRemote: "origin"
        }
      ],
      executors: {
        codex: {
          id: "codex",
          displayName: "Codex",
          async canRun() {
            throw new Error("should not reach executor readiness");
          },
          async run() {
            throw new Error("should not reach executor run");
          },
          async cancel() {
            return;
          }
        }
      },
      client: createDispatcherClient({ dispatcherUrl, runnerId: "runner_1", fetchImpl })
    });

    expect(didWork).toBe(true);
    const stored = await client.getRun({ runId: "run_blocked" });
    expect(stored.run.status).toBe("needs_approval");
    expect(stored.run.result?.conclusion).toBe("needs_human");
    expect(stored.run.result?.summary).toContain("permission.repo_write_required");

    const { events } = await client.listRunEvents({ runId: "run_blocked" });
    expect(events.map((item) => (item as { type: string }).type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "agent_access_profile.captured",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "routing.decided",
      "run.claimed",
      "run.progress",
      "run.completed",
      "callback.progress.queued",
      "callback.progress.delivered",
      "callback.final.queued",
      "callback.final.delivered"
    ]);
    expect(events.find((item) => (item as { type: string }).type === "run.progress")).toMatchObject({
      visibility: "audit"
    });
    expect(delivered.at(-1)?.toLowerCase()).toContain("needs_human");
  });
});
