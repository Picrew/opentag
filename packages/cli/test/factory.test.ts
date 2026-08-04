import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createDispatcherApp } from "@opentag/dispatcher";
import { describe, expect, it, vi } from "vitest";
import {
  createFactoryRecipeFromConfig,
  createFactoryWorkstreamFromConfig,
  ensureFactoryWorkThreadFromConfig,
  formatFactoryCommandOutput,
  getFactoryBatchFromConfig,
  getFactoryRecipeFromConfig,
  getFactoryWorkstreamFromConfig,
  submitFactoryBatchFromConfig
} from "../src/factory.js";
import { createSetupConfig } from "../src/setup.js";

const digest = `sha256:${"a".repeat(64)}`;
const createdAt = "2026-07-26T00:00:00.000Z";
const completedAt = "2026-07-26T00:01:00.000Z";

const recipeInput = {
  id: "recipe_release",
  version: 1,
  name: "Release factory",
  budgets: {
    maxConcurrentRuns: 2,
    maxAttemptsPerRun: 3,
    maxCostUnits: 20,
    costUnitsPerAttempt: 1,
    allowedLocalities: ["local"]
  }
} as const;

const recipe = { ...recipeInput, createdAt, contentDigest: digest };

const workstreamInput = {
  id: "workstream_release",
  recipeId: recipe.id,
  recipeVersion: recipe.version,
  name: "Release factory",
  members: [{ kind: "work_thread", workThreadId: "thread_1" }]
} as const;

const workstream = { ...workstreamInput, createdAt, contentDigest: digest };

const event = {
  id: "event_1",
  source: "github",
  sourceEventId: "event_1",
  receivedAt: createdAt,
  actor: { provider: "github", providerUserId: "actor_1" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "Please fix the release.", intent: "fix", args: {} },
  context: [],
  permissions: [],
  callback: { provider: "github", uri: "https://api.github.test/issues/1/comments" },
  metadata: {}
} as const;

const batchInput = {
  id: "batch_release",
  workstreamId: workstream.id,
  items: [{ itemId: "item_1", runId: "run_1", workThreadId: "thread_1", event }]
} as const;

const batchReceipt = {
  batch: { ...batchInput, createdAt, contentDigest: digest },
  status: "completed" as const,
  items: [{
    itemId: "item_1",
    index: 0,
    runId: "run_1",
    workThreadId: "thread_1",
    status: "completed" as const,
    result: {
      itemId: "item_1",
      index: 0,
      runId: "run_1",
      status: "created" as const,
      statusCode: 201,
      admittedRunId: "run_1"
    }
  }],
  result: {
    batchId: batchInput.id,
    workstreamId: workstream.id,
    inputDigest: digest,
    results: [{
      itemId: "item_1",
      index: 0,
      runId: "run_1",
      status: "created" as const,
      statusCode: 201,
      admittedRunId: "run_1"
    }],
    summary: {
      totalItems: 1,
      createdCount: 1,
      idempotentReplayCount: 0,
      followUpQueuedCount: 0,
      waitActiveRunCount: 0,
      needsHumanDecisionCount: 0,
      rejectedCount: 0,
      exceptionCount: 0,
      exceptions: [],
      omittedExceptionCount: 0
    },
    completedAt
  },
  updatedAt: completedAt,
  completedAt
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-factory-test-"));
}

function config() {
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
  built.daemon.dispatcherUrl = "https://relay.example";
  built.daemon.pairingToken = "legacy_pairing_token";
  built.daemon.runnerToken = "runner_secret";
  return built;
}

function responseFor(url: string): unknown {
  if (url.includes("/v1/factory-recipes")) return { recipe };
  if (url.includes("/v1/workstreams")) return { workstream };
  if (url.includes("/v1/workstream-batches")) return { receipt: batchReceipt };
  throw new Error(`Unexpected URL: ${url}`);
}

describe("OpenTag factory CLI", () => {
  it("ensures an external WorkThread from stdin and reports an idempotent replay", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const workThread = {
      id: "thread_github_acme/demo#1_comment_1",
      workItemReference: {
        provider: "github",
        kind: "issue",
        externalId: "acme/demo#1",
        uri: "https://github.com/acme/demo/issues/1"
      },
      primaryAnchor: {
        provider: "github",
        kind: "github_thread",
        externalId: event.callback.uri,
        uri: event.callback.uri,
        controlPlane: true,
        canApprove: true
      }
    };
    const normalizedEvent = { ...event, workItem: workThread.workItemReference };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ workThread, created: false });
    }) as unknown as typeof fetch;

    const result = await ensureFactoryWorkThreadFromConfig({
      config: config(),
      inputPath: "-",
      stdin: Readable.from([JSON.stringify(normalizedEvent)]),
      fetchImpl
    });

    expect(result).toEqual({ workThread, created: false });
    expect(requests[0]?.url).toBe("https://relay.example/v1/work-threads/ensure");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(normalizedEvent);
    expect(formatFactoryCommandOutput(result, { action: "ensured" })).toContain(
      "Factory work thread ensured: thread_github_acme/demo#1_comment_1 (already existed)"
    );
  });

  it("creates a recipe from a JSON file with pairing-scoped factory authority", async () => {
    const path = join(tempDir(), "recipe.json");
    writeFileSync(path, JSON.stringify(recipeInput));
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json(responseFor(String(url)), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await createFactoryRecipeFromConfig({
      config: config(),
      inputPath: path,
      fetchImpl
    });

    expect(result).toEqual({ recipe });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://relay.example/v1/factory-recipes");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer legacy_pairing_token"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(recipeInput);
  });

  it("uses pairing authority against the dispatcher and never expands runner-token scope", async () => {
    const configured = config();
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: configured.daemon.pairingToken,
      runnerToken: configured.daemon.runnerToken
    });
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => (
      app.fetch(new Request(input, init))
    )) as typeof fetch;

    await expect(createFactoryRecipeFromConfig({
      config: configured,
      inputPath: "recipe.json",
      readText: async () => JSON.stringify(recipeInput),
      fetchImpl
    })).resolves.toMatchObject({ recipe: { id: recipeInput.id, version: recipeInput.version } });

    const runnerScoped = await app.request("/v1/factory-recipes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${configured.daemon.runnerToken}`
      },
      body: JSON.stringify({ ...recipeInput, id: "recipe_runner_denied" })
    });
    expect(runnerScoped.status).toBe(401);
    await expect(runnerScoped.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: "invalid_pairing_token"
    });

    const runnerToken = configured.daemon.runnerToken ?? "";
    const revokedApp = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: configured.daemon.pairingToken,
      runnerToken,
      revokedRunnerTokenFingerprints: [createHash("sha256").update(runnerToken).digest("hex")]
    });
    const revokedRunner = await revokedApp.request("/v1/factory-recipes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${runnerToken}`
      },
      body: JSON.stringify({ ...recipeInput, id: "recipe_revoked_runner_denied" })
    });
    expect(revokedRunner.status).toBe(401);
    await expect(revokedRunner.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: "runner_token_revoked"
    });
  });

  it("creates a workstream and submits a batch from stdin JSON", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json(responseFor(String(url)), { status: 201 });
    }) as unknown as typeof fetch;
    const configured = config();

    await createFactoryWorkstreamFromConfig({
      config: configured,
      inputPath: "-",
      stdin: Readable.from([JSON.stringify(workstreamInput)]),
      fetchImpl
    });
    await submitFactoryBatchFromConfig({
      config: configured,
      inputPath: "-",
      stdin: Readable.from([JSON.stringify(batchInput)]),
      fetchImpl
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://relay.example/v1/workstreams",
      "https://relay.example/v1/workstream-batches"
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(workstreamInput);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(batchInput);
  });

  it("gets recipes, workstreams, and batches with encoded identities", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      return Response.json(responseFor(String(url)));
    }) as unknown as typeof fetch;
    const configured = config();

    await getFactoryRecipeFromConfig({ config: configured, id: "release/candidate", version: "1", fetchImpl });
    await getFactoryWorkstreamFromConfig({ config: configured, id: "release/candidate", fetchImpl });
    await getFactoryBatchFromConfig({ config: configured, id: "release/candidate", fetchImpl });

    expect(requests).toEqual([
      "https://relay.example/v1/factory-recipes/release%2Fcandidate/versions/1",
      "https://relay.example/v1/workstreams/release%2Fcandidate",
      "https://relay.example/v1/workstream-batches/release%2Fcandidate"
    ]);
  });

  it("rejects invalid input and invalid recipe versions before network access", async () => {
    const path = join(tempDir(), "invalid.json");
    writeFileSync(path, "{not-json");
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(createFactoryRecipeFromConfig({ config: config(), inputPath: path, fetchImpl })).rejects.toThrow(
      "must contain valid JSON"
    );
    await expect(getFactoryRecipeFromConfig({ config: config(), id: "recipe_1", version: "0", fetchImpl })).rejects.toThrow(
      "--version must be a positive integer"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints structured JSON or concise operator-facing summaries", () => {
    expect(formatFactoryCommandOutput({ recipe }, { json: true, action: "created" })).toBe(
      JSON.stringify({ recipe }, null, 2)
    );
    expect(formatFactoryCommandOutput({ workstream }, { action: "retrieved" })).toContain(
      "Factory workstream retrieved: workstream_release"
    );
    expect(formatFactoryCommandOutput({ receipt: batchReceipt }, { action: "submitted" })).toContain(
      "Admission batch submitted: batch_release (completed)"
    );
  });
});
