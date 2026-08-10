import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  CallbackAttemptObservationReceiptEnvelopeV1Schema,
  CallbackIntentObservationReceiptEnvelopeV1Schema,
  CallbackProviderObservationReceiptEnvelopeV1Schema,
  CompletionAssessmentReceiptEnvelopeV1Schema,
  HostedLifecycleReceiptEnvelopeV1Schema,
  buildHostedLifecycleRequestV1,
  canonicalJsonStringify,
  computeControlPayloadDigestV1
} from "@opentag/core";
import { computeLinearSignature } from "@opentag/linear";
import { parseSlackSuggestedActionButtonValue, type SlackBlock } from "@opentag/slack";
import { createOpenTagRepository } from "@opentag/store";
import { z } from "zod";
import { canonicalSha256Json } from "../../store/src/canonical-json.js";
import { createDefaultCallbackPresentation } from "../src/presentation.js";
import { createDispatcherApp as createRawDispatcherApp, type CallbackMessage } from "../src/server.js";

function createDispatcherApp(input: Parameters<typeof createRawDispatcherApp>[0]): ReturnType<typeof createRawDispatcherApp> {
  const app = createRawDispatcherApp({
    ...input,
    reassessmentObligations: input.reassessmentObligations ?? { autoStart: false }
  });
  const leases = new Map<string, { attemptId: string; fencingToken: string }>();
  const request = app.request.bind(app);
  app.request = (async (requestInput: Request | string, requestInit?: RequestInit) => {
    const path = typeof requestInput === "string" ? requestInput : new URL(requestInput.url).pathname;
    const mutation = path.match(/^\/v1\/runners\/([^/]+)\/runs\/([^/]+)\/(?:running|heartbeat|progress|complete)$/);
    let nextInit = requestInit;
    if (mutation) {
      const lease = leases.get(`${mutation[1]}:${mutation[2]}`);
      if (lease) {
        let body: Record<string, unknown> = {};
        if (typeof requestInit?.body === "string" && requestInit.body.length > 0) {
          body = JSON.parse(requestInit.body) as Record<string, unknown>;
        }
        if (body["attemptId"] === undefined && body["fencingToken"] === undefined) {
          nextInit = {
            ...requestInit,
            method: requestInit?.method ?? "POST",
            headers: { "content-type": "application/json", ...(requestInit?.headers as Record<string, string> | undefined) },
            body: JSON.stringify({ ...body, ...lease })
          };
        }
      }
    }
    const response = await request(requestInput as string, nextInit);
    const claim = path.match(/^\/v1\/runners\/([^/]+)\/claim$/);
    if (claim && response.ok && response.status !== 204) {
      const body = (await response.clone().json()) as {
        run?: { id?: string };
        attemptId?: string;
        fencingToken?: string;
      };
      if (body.run?.id && body.attemptId && body.fencingToken) {
        leases.set(`${claim[1]}:${body.run.id}`, { attemptId: body.attemptId, fencingToken: body.fencingToken });
      }
    }
    return response;
  }) as typeof app.request;
  return app;
}

const validEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
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

const echoExecutorRegistration = {
  executorId: "echo",
  readiness: "ready" as const,
  capability: {
    id: "echo",
    invocation: "spawn" as const,
    supportsProfile: false,
    supportsStreaming: false,
    supportsCancel: false,
    supportsHookCompletion: false,
    progressEvents: "audit" as const,
    approvalMode: "opentag_policy" as const,
    contextAccess: ["context_packet" as const, "context_pointers" as const],
    promptAssembly: "opentag" as const,
    writeAccess: "none" as const,
    conversationAccess: "request" as const,
    promptMutation: "none" as const,
    rawContextAccess: false,
    writeActionAccess: "none" as const,
    workspaceIsolation: "none" as const,
    sourceControl: "none" as const,
    requiredSecrets: [],
    completionSignals: [{ type: "process_exit" as const, required: true, description: "Echo returns immediately." }]
  }
};

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function bindSourceChannel(
  app: ReturnType<typeof createDispatcherApp>,
  event: { source: string; metadata?: Record<string, unknown> }
): Promise<void> {
  if (event.source !== "slack" && event.source !== "lark") return;
  const metadata = event.metadata ?? {};
  const accountId = event.source === "slack" ? metadata["teamId"] : metadata["tenantKey"];
  const conversationId = event.source === "slack" ? metadata["channelId"] : metadata["chatId"];
  if (typeof accountId !== "string" || typeof conversationId !== "string") {
    throw new Error(`Cannot bind incomplete ${event.source} source channel fixture.`);
  }
  const hasRepository = [metadata["repoProvider"], metadata["owner"], metadata["repo"]]
    .every((value) => typeof value === "string" && value.length > 0);
  const response = await app.request("/v1/channel-bindings", jsonRequest({
    provider: event.source,
    accountId,
    conversationId,
    ...(hasRepository
      ? { repoProvider: metadata["repoProvider"], owner: metadata["owner"], repo: metadata["repo"] }
      : {})
  }));
  expect(response.status).toBe(201);
}

function authorizedJsonRequest(body: unknown, token = "pairing_token") {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createControlledTimeouts() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  type ControlledHandle = ReturnType<typeof globalThis.setTimeout> & {
    controlledId: number;
  };
  const setTimeout = ((callback: () => void) => {
    const controlledId = nextId++;
    const handle = {
      controlledId,
      unref() {}
    } as ControlledHandle;
    callbacks.set(controlledId, callback);
    return handle;
  }) as typeof globalThis.setTimeout;
  const clearTimeout = ((handle: ControlledHandle) => {
    callbacks.delete(handle.controlledId);
  }) as typeof globalThis.clearTimeout;
  return {
    setTimeout,
    clearTimeout,
    get pendingCount() {
      return callbacks.size;
    },
    runNext() {
      const next = callbacks.entries().next().value as
        | [number, () => void]
        | undefined;
      if (!next) throw new Error("No controlled timeout is pending.");
      callbacks.delete(next[0]);
      next[1]();
    },
    runAll() {
      while (callbacks.size > 0) this.runNext();
    }
  };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for deterministic test condition.");
}

async function waitForDatabase(
  sqlite: Database.Database,
  query: string,
  predicate: (row: Record<string, unknown> | undefined) => boolean,
  timeoutMs = 5_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastRow: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    lastRow = sqlite.prepare(query).get() as Record<string, unknown> | undefined;
    if (predicate(lastRow)) return lastRow ?? {};
    await wait(20);
  }
  throw new Error(
    `Timed out waiting for database condition: ${query}; last row: ${JSON.stringify(lastRow)}`
  );
}

function receiptWithDigests<T extends { payload: unknown }>(value: T) {
  const withPayloadDigest = {
    ...value,
    payloadDigest: canonicalSha256Json(value.payload)
  };
  return {
    ...withPayloadDigest,
    receiptDigest: canonicalSha256Json(withPayloadDigest)
  };
}

function expireRunnerLease(databasePath: string, runId: string, attemptId: string): void {
  const sqlite = new Database(databasePath);
  try {
    const expiredAt = "2000-01-01T00:00:00.000Z";
    sqlite.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run(expiredAt, runId);
    sqlite.prepare("UPDATE attempts SET lease_expires_at = ? WHERE id = ?").run(expiredAt, attemptId);
  } finally {
    sqlite.close();
  }
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function githubIssueEvent(input: { id: string; sourceEventId: string; threadKey?: string }) {
  return {
    ...validEvent,
    id: input.id,
    sourceEventId: input.sourceEventId,
    permissions: [
      { scope: "issue:comment", reason: "reply to source thread" },
      { scope: "repo:write", reason: "apply approved issue metadata" }
    ],
    callback: {
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      ...(input.threadKey ? { threadKey: input.threadKey } : {})
    },
    metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 1 }
  };
}

function githubPullRequestEvent(input: { id: string; sourceEventId: string; threadKey?: string }) {
  return {
    ...validEvent,
    id: input.id,
    sourceEventId: input.sourceEventId,
    context: [{ provider: "github", kind: "pull_request", uri: "https://github.com/acme/demo/pull/2", visibility: "public" }],
    workItem: {
      provider: "github",
      kind: "pull_request",
      externalId: "acme/demo#2",
      uri: "https://github.com/acme/demo/pull/2",
      ownerContainer: {
        provider: "github",
        id: "acme/demo",
        uri: "https://github.com/acme/demo"
      }
    },
    permissions: [
      { scope: "issue:comment", reason: "reply to source thread" },
      { scope: "pr:update", reason: "request reviewers after explicit approval" }
    ],
    callback: {
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/2/comments",
      ...(input.threadKey ? { threadKey: input.threadKey } : {})
    },
    metadata: { repoProvider: "github", owner: "acme", repo: "demo", pullRequestNumber: 2 }
  };
}

function gitlabIssueEvent(input: { id: string; sourceEventId: string; threadKey?: string }) {
  return {
    ...validEvent,
    id: input.id,
    source: "gitlab",
    sourceEventId: input.sourceEventId,
    context: [{ provider: "gitlab", kind: "issue", uri: "https://gitlab.example.com/acme/demo/-/issues/1", visibility: "private" }],
    workItem: {
      provider: "gitlab",
      kind: "issue",
      externalId: "issue:acme/demo#1",
      uri: "https://gitlab.example.com/acme/demo/-/issues/1",
      ownerContainer: {
        provider: "gitlab",
        id: "acme/demo",
        uri: "https://gitlab.example.com/acme/demo"
      }
    },
    permissions: [
      { scope: "issue:comment", reason: "reply to the source GitLab thread" },
      { scope: "runner:local", reason: "execute the run on a paired local daemon" },
      { scope: "repo:read", reason: "inspect the repository in the paired local checkout" },
      { scope: "repo:write", reason: "commit code changes on an isolated run branch" },
      { scope: "pr:create", reason: "open a merge request for completed code changes" }
    ],
    callback: {
      provider: "gitlab",
      uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      ...(input.threadKey ? { threadKey: input.threadKey } : {})
    },
    metadata: {
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo",
      projectPathWithNamespace: "acme/demo",
      projectId: 42,
      projectVisibility: "private",
      issueIid: 1,
      noteableType: "Issue"
    }
  };
}

function linearIssueEvent(input: { id: string; sourceEventId: string; threadKey?: string }) {
  return {
    ...validEvent,
    id: input.id,
    source: "linear",
    sourceEventId: input.sourceEventId,
    context: [{ provider: "linear", kind: "issue", uri: "https://linear.app/acme/issue/ENG-1/demo", visibility: "organization" }],
    workItem: {
      provider: "linear",
      kind: "issue",
      externalId: "ENG-1",
      uri: "https://linear.app/acme/issue/ENG-1/demo",
      ownerContainer: {
        provider: "linear",
        id: "team_eng",
        uri: "https://linear.app/acme/team/ENG"
      }
    },
    permissions: [
      { scope: "issue:comment", reason: "reply to the source Linear issue" },
      { scope: "runner:local", reason: "execute the run on a paired local daemon" },
      { scope: "repo:read", reason: "inspect the repository in the paired local checkout" },
      { scope: "repo:write", reason: "commit code changes on an isolated run branch" },
      { scope: "pr:create", reason: "open a pull request for completed code changes" }
    ],
    callback: {
      provider: "linear",
      uri: "linear://issue/issue_123/comments",
      ...(input.threadKey ? { threadKey: input.threadKey } : {})
    },
    metadata: {
      repoProvider: "github",
      owner: "acme",
      repo: "demo",
      issueId: "issue_123",
      issueIdentifier: "ENG-1",
      teamId: "team_eng",
      teamKey: "ENG",
      graphqlUrl: "https://linear.example/graphql"
    }
  };
}

function slackRepoEvent(input: { id: string; sourceEventId: string; threadKey: string }) {
  return {
    ...validEvent,
    id: input.id,
    source: "slack",
    sourceEventId: input.sourceEventId,
    actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
    context: [{ provider: "slack", kind: "message", uri: "slack://team/T123/channel/C123/message/1710000000.000100", visibility: "organization" }],
    permissions: [
      { scope: "chat:postMessage", reason: "reply to source thread" },
      { scope: "reactions:write", reason: "mark the source Slack message as received" },
      { scope: "runner:local", reason: "execute on local daemon" },
      { scope: "repo:write", reason: "modify the mapped repository" },
      { scope: "pr:create", reason: "create an approved pull request" }
    ],
    callback: {
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      threadKey: input.threadKey
    },
    metadata: { teamId: "T123", channelId: "C123", messageTs: "1710000000.000100", repoProvider: "github", owner: "acme", repo: "demo" }
  };
}

function teamsRepoEvent(input: {
  id: string;
  sourceEventId: string;
  conversationId?: string;
  threadKey?: string;
  omitTenantId?: boolean;
  omitConversationId?: boolean;
}) {
  const conversationId = input.conversationId ?? "19:channel@thread.tacv2";
  return {
    ...validEvent,
    id: input.id,
    source: "teams",
    sourceEventId: input.sourceEventId,
    actor: { provider: "teams", providerUserId: "aad-user-1", handle: "Ada", organizationId: "team-1" },
    context: [
      {
        provider: "teams",
        kind: "url",
        uri: "teams://team/team-1/channel/channel-1/message/root-activity",
        visibility: "organization"
      }
    ],
    permissions: [
      { scope: "chat:postMessage", reason: "reply in the originating Teams channel thread" },
      { scope: "runner:local", reason: "execute on local daemon" },
      { scope: "repo:write", reason: "modify the mapped repository" }
    ],
    callback: {
      provider: "teams",
      uri: "https://smba.trafficmanager.net/amer/",
      threadKey: input.threadKey ?? `https://smba.trafficmanager.net/amer/|${conversationId}|root-activity`
    },
    metadata: {
      ...(!input.omitTenantId ? { tenantId: "tenant-1" } : {}),
      ...(!input.omitConversationId ? { conversationId } : {}),
      teamId: "team-1",
      channelId: "channel-1",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      repoProvider: "github",
      owner: "acme",
      repo: "demo",
      issueNumber: 1
    }
  };
}

function larkRepoEvent(input: { id: string; sourceEventId: string; chatId?: string; messageId?: string }) {
  const chatId = input.chatId ?? "oc_chat";
  const messageId = input.messageId ?? "om_msg";
  return {
    ...validEvent,
    id: input.id,
    source: "lark",
    sourceEventId: input.sourceEventId,
    actor: { provider: "lark", providerUserId: "ou_sender", handle: "ming", organizationId: "tenant_1" },
    context: [{ provider: "lark", kind: "message", uri: `lark://tenant/tenant_1/chat/${chatId}/message/${messageId}`, visibility: "organization" }],
    permissions: [
      { scope: "chat:postMessage", reason: "reply in source chat" },
      { scope: "runner:local", reason: "execute on local daemon" },
      { scope: "repo:write", reason: "modify the mapped repository" }
    ],
    callback: {
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: `tenant_1|${chatId}|${messageId}`
    },
    metadata: {
      tenantKey: "tenant_1",
      chatId,
      messageId,
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }
  };
}

async function seedCompletedProposal(input: {
  app: ReturnType<typeof createDispatcherApp>;
  runId: string;
  event: unknown;
  suggestedChanges: unknown[];
  allowedActors?: string[];
  repoBinding?: { provider: string; owner: string; repo: string };
}) {
  const repoBinding = input.repoBinding ?? { provider: "github", owner: "acme", repo: "demo" };
  await input.app.request("/v1/repo-bindings", jsonRequest({
    provider: repoBinding.provider,
    owner: repoBinding.owner,
    repo: repoBinding.repo,
    runnerId: "runner_1",
    workspacePath: "/Users/test/demo",
    defaultExecutor: "echo",
    ...(input.allowedActors ? { allowedActors: input.allowedActors } : {})
  }));
  await bindSourceChannel(input.app, input.event);
  const createResponse = await input.app.request("/v1/runs", jsonRequest({ runId: input.runId, event: input.event }));
  expect(createResponse.status).toBe(201);
  await input.app.request("/v1/runners/runner_1/claim", { method: "POST" });
  const completeResponse = await input.app.request(`/v1/runners/runner_1/runs/${input.runId}/complete`, jsonRequest({
    result: {
      conclusion: "needs_human",
      summary: "Prepared suggested actions.",
      suggestedChanges: input.suggestedChanges
    }
  }));
  expect(completeResponse.status).toBe(200);
}

describe("dispatcher API", () => {
  it("requires a bearer token when pairing token auth is configured", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });

    const denied = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    expect(denied.status).toBe(401);

    const allowed = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    expect(allowed.status).toBe(201);

    const audit = await app.request("/v1/control-plane-events?type=security.auth_failed", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(audit.status).toBe(200);
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "security.auth_failed",
        severity: "warn",
        subject: "POST /v1/runners",
        payload: expect.objectContaining({
          reason: "invalid_pairing_token",
          endpoint: "POST /v1/runners",
          hasAuthorization: false,
          tokenFingerprint: "none"
        })
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("pair_test");
  });

  it("separates pairing-token admin calls from runner-token runtime calls", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test", runnerToken: "runner_test" });
    const pairJson = (body: unknown) => ({
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" }
    });
    const runnerJson = (body: unknown) => ({
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer runner_test" }
    });
    const runnerAuth = { authorization: "Bearer runner_test" };

    const runnerCannotRegister = await app.request("/v1/runners", runnerJson({ runnerId: "runner_1", name: "Local Runner" }));
    expect(runnerCannotRegister.status).toBe(401);

    const register = await app.request("/v1/runners", pairJson({
      runnerId: "runner_1",
      name: "Local Runner",
      locality: "local",
      executors: [echoExecutorRegistration],
      maxConcurrentRuns: 2,
      preference: 10
    }));
    expect(register.status).toBe(201);

    const bind = await app.request("/v1/repo-bindings", pairJson({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      fallbackRunnerIds: ["runner_2"],
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo",
      fallbackExecutorIds: ["codex"]
    }));
    expect(bind.status).toBe(201);

    const runnerCanReadRegistration = await app.request("/v1/runners/runner_1", { headers: runnerAuth });
    expect(runnerCanReadRegistration.status).toBe(200);
    await expect(runnerCanReadRegistration.json()).resolves.toMatchObject({
      runner: {
        runnerId: "runner_1",
        locality: "local",
        executors: [{ executorId: "echo", readiness: "ready" }],
        maxConcurrentRuns: 2,
        preference: 10
      }
    });
    const runnerCanReadDirectory = await app.request("/v1/runners", { headers: runnerAuth });
    expect(runnerCanReadDirectory.status).toBe(200);
    await expect(runnerCanReadDirectory.json()).resolves.toMatchObject({
      runners: [{ runnerId: "runner_1", readiness: { state: "ready" }, capacity: { active: 0, limit: 2 } }]
    });
    const runnerCanReadBinding = await app.request("/v1/repo-bindings/github/acme/demo", { headers: runnerAuth });
    expect(runnerCanReadBinding.status).toBe(200);
    await expect(runnerCanReadBinding.json()).resolves.toMatchObject({
      binding: {
        runnerId: "runner_1",
        fallbackRunnerIds: ["runner_2"],
        defaultExecutor: "echo",
        fallbackExecutorIds: ["codex"]
      }
    });
    const runnerCanReadAcceptedProgressMetrics = await app.request(
      "/v1/routing/accepted-progress-metrics",
      { headers: runnerAuth }
    );
    expect(runnerCanReadAcceptedProgressMetrics.status).toBe(200);
    await expect(runnerCanReadAcceptedProgressMetrics.json()).resolves.toEqual({
      metrics: {
        completedRuns: 0,
        runsWithAcceptedProgress: 0,
        acceptedGateAdvances: 0,
        attributedAcceptedGateAdvances: 0,
        unresolvedAcceptedGateAdvances: 0,
        byRunner: [],
        byExecutor: []
      }
    });

    const runnerCannotCreateRun = await app.request("/v1/runs", runnerJson({ runId: "run_scope", event: validEvent }));
    expect(runnerCannotCreateRun.status).toBe(401);

    const createRun = await app.request("/v1/runs", pairJson({ runId: "run_scope", event: validEvent }));
    expect(createRun.status).toBe(201);

    const pairCannotClaimWhenRunnerTokenIsConfigured = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer pair_test" }
    });
    expect(pairCannotClaimWhenRunnerTokenIsConfigured.status).toBe(401);
    await expect(pairCannotClaimWhenRunnerTokenIsConfigured.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: "invalid_runner_token"
    });

    const claim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: runnerAuth
    });
    expect(claim.status).toBe(200);
    const claimed = await claim.json() as { attemptId: string; fencingToken: string; executorId: string };

    const pairCannotRejectStart = await app.request(
      "/v1/runners/runner_1/runs/run_scope/reject-start",
      pairJson({
        attemptId: claimed.attemptId,
        fencingToken: claimed.fencingToken,
        executorId: claimed.executorId,
        reason: "Run-specific executor readiness failed."
      })
    );
    expect(pairCannotRejectStart.status).toBe(401);
    const runnerCanRejectStart = await app.request(
      "/v1/runners/runner_1/runs/run_scope/reject-start",
      runnerJson({
        attemptId: claimed.attemptId,
        fencingToken: claimed.fencingToken,
        executorId: claimed.executorId,
        reason: "Run-specific executor readiness failed."
      })
    );
    expect(runnerCanRejectStart.status).toBe(200);
    await expect(runnerCanRejectStart.json()).resolves.toEqual({ ok: true, replayed: false });

    const runnerCanReadRun = await app.request("/v1/runs/run_scope", { headers: runnerAuth });
    expect(runnerCanReadRun.status).toBe(200);
    const runnerCanReadAlerts = await app.request("/v1/control-plane-alerts", { headers: runnerAuth });
    expect(runnerCanReadAlerts.status).toBe(200);
    const runnerCannotReconcileUnknownAction = await app.request("/v1/material-actions/action_missing/reconcile", runnerJson({
      outcome: "succeeded", idempotencyKey: "admin_only", receiptRef: "provider:lookup"
    }));
    expect(runnerCannotReconcileUnknownAction.status).toBe(401);

    const audit = await app.request("/v1/control-plane-events?type=security.auth_failed", {
      headers: { authorization: "Bearer pair_test" }
    });
    const { events } = await audit.json();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: "POST /v1/runners",
          payload: expect.objectContaining({ reason: "invalid_pairing_token" })
        }),
        expect.objectContaining({
          subject: "POST /v1/runners/:runnerId/claim",
          payload: expect.objectContaining({ reason: "invalid_runner_token" })
        })
      ])
    );
    expect(JSON.stringify(events)).not.toContain("runner_test");
    expect(JSON.stringify(events)).not.toContain("pair_test");
  });

  it("ensures one durable WorkThread from normalized external events and merges new anchors", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_test",
      runnerToken: "runner_test"
    });

    const runnerScoped = await app.request(
      "/v1/work-threads/ensure",
      authorizedJsonRequest(validEvent, "runner_test")
    );
    expect(runnerScoped.status).toBe(401);
    await expect(runnerScoped.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: "invalid_pairing_token"
    });

    const first = await app.request(
      "/v1/work-threads/ensure",
      authorizedJsonRequest(validEvent, "pair_test")
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { workThread: { id: string }; created: boolean };
    expect(firstBody).toMatchObject({
      created: true,
      workThread: {
        id: expect.any(String),
        workItemReference: { provider: "github", externalId: "acme/demo#1" }
      }
    });

    const replay = await app.request(
      "/v1/work-threads/ensure",
      authorizedJsonRequest({
        ...validEvent,
        id: "evt_2",
        sourceEventId: "comment_2",
        callback: {
          ...validEvent.callback,
          uri: "https://api.github.com/repos/acme/demo/issues/1/comments/2",
          threadKey: "acme/demo#1/comment-2"
        }
      }, "pair_test")
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      created: false,
      workThread: {
        id: firstBody.workThread.id,
        secondaryAnchors: [expect.objectContaining({ externalId: "acme/demo#1/comment-2" })]
      }
    });
  });

  it("does not expose readiness ingress without a runner-scoped authenticated principal", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      runnerTokens: ["runner_a_token", "runner_b_token"],
    });
    const response = await app.request("/v1/runners/runner_b/readiness", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer runner_a_token",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
      reason: "invalid_pairing_token",
    });

    const unconfigured = createDispatcherApp({ databasePath: ":memory:" });
    const absent = await unconfigured.request("/v1/runners/runner_b/readiness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(absent.status).toBe(404);
  });

  it("rejects normalized events that cannot derive a durable WorkThread", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });
    const response = await app.request(
      "/v1/work-threads/ensure",
      authorizedJsonRequest({ ...validEvent, workItem: undefined }, "pair_test")
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "work_thread_required" });
  });

  it("allows runner-operator auth to prune source delivery replay keys and audit metrics", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test", runnerToken: "runner_test" });
    const body = {
      olderThan: "2026-06-24T00:00:00.000Z",
      limit: 25
    };

    const denied = await app.request("/v1/source-deliveries/prune", jsonRequest(body));
    expect(denied.status).toBe(401);

    const pruned = await app.request("/v1/source-deliveries/prune", {
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer runner_test" }
    });
    expect(pruned.status).toBe(200);
    await expect(pruned.json()).resolves.toEqual({
      result: {
        scanned: 0,
        pruned: 0,
        retainedActive: 0
      }
    });

    const invalid = await app.request("/v1/source-deliveries/prune", {
      ...jsonRequest({ olderThan: "not-a-date" }),
      headers: { "content-type": "application/json", authorization: "Bearer runner_test" }
    });
    expect(invalid.status).toBe(400);

    const audit = await app.request("/v1/control-plane-events?type=maintenance.source_deliveries_pruned", {
      headers: { authorization: "Bearer pair_test" }
    });
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "maintenance.source_deliveries_pruned",
        severity: "info",
        subject: "source_deliveries",
        payload: expect.objectContaining({
          olderThan: "2026-06-24T00:00:00.000Z",
          limit: 25,
          scanned: 0,
          pruned: 0,
          retainedActive: 0
        })
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("runner_test");
  });

  it("records management audit events for runner registration and binding changes without local paths", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }));
    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/alice/repos/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    );
    await app.request(
      "/v1/channel-bindings",
      jsonRequest({
        provider: "telegram",
        accountId: "bot_123",
        conversationId: "chat_456",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        metadata: { title: "Ops chat" }
      })
    );
    await app.request(
      "/v1/slack-channel-bindings",
      jsonRequest({
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      })
    );
    await app.request("/v1/channel-bindings/telegram/bot_123/chat_456", { method: "DELETE" });

    const audit = await app.request("/v1/control-plane-events?limit=20");
    const { events } = await audit.json();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runner.registered",
          subject: "runner_1",
          payload: expect.objectContaining({
            runnerId: "runner_1",
            name: "Local Runner"
          })
        }),
        expect.objectContaining({
          type: "binding.repository.upserted",
          subject: "github:acme/demo",
          payload: expect.objectContaining({
            provider: "github",
            owner: "acme",
            repo: "demo",
            runnerId: "runner_1",
            hasWorkspacePath: true,
            defaultExecutor: "echo",
            allowedActorsCount: 1
          })
        }),
        expect.objectContaining({
          type: "binding.channel.upserted",
          subject: "telegram:bot_123/chat_456",
          payload: {
            provider: "telegram",
            accountId: "bot_123",
            conversationId: "chat_456",
            repoProvider: "github",
            owner: "acme",
            repo: "demo",
            hasMetadata: true
          }
        }),
        expect.objectContaining({
          type: "binding.channel.upserted",
          subject: "slack:T123/C123",
          payload: expect.objectContaining({
            provider: "slack",
            accountId: "T123",
            conversationId: "C123",
            compatibilityEndpoint: "/v1/slack-channel-bindings"
          })
        }),
        expect.objectContaining({
          type: "binding.channel.deleted",
          subject: "telegram:bot_123/chat_456",
          payload: {
            provider: "telegram",
            accountId: "bot_123",
            conversationId: "chat_456"
          }
        })
      ])
    );
    expect(JSON.stringify(events)).not.toContain("/Users/alice/repos/demo");
  });

  it("rejects ambiguous fallback routing preferences at the HTTP boundary", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const missingPrimaryExecutor = await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      fallbackExecutorIds: ["codex"]
    }));
    expect(missingPrimaryExecutor.status).toBe(400);

    const repeatedPrimaryRunner = await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      fallbackRunnerIds: ["runner_1"]
    }));
    expect(repeatedPrimaryRunner.status).toBe(400);

    const oversizedFallbackSet = await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      fallbackRunnerIds: Array.from({ length: 64 }, (_, index) => `runner_${index + 2}`)
    }));
    expect(oversizedFallbackSet.status).toBe(400);
  });

  it("accepts multiple runner tokens during a rotation window", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_test",
      runnerToken: "runner_new",
      runnerTokens: ["runner_old"]
    });
    const pairJson = (body: unknown) => ({
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" }
    });

    await app.request("/v1/runners", pairJson({ runnerId: "runner_1", name: "Local Runner" }));
    const oldTokenClaim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer runner_old" }
    });
    expect(oldTokenClaim.status).toBe(204);

    const newTokenClaim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer runner_new" }
    });
    expect(newTokenClaim.status).toBe(204);
  });

  it("fails closed when a runner token fingerprint is revoked", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_test",
      runnerToken: "runner_new",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: [tokenFingerprint("runner_old")]
    });
    const pairJson = (body: unknown) => ({
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" }
    });

    await app.request("/v1/runners", pairJson({ runnerId: "runner_1", name: "Local Runner" }));
    const revokedClaim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer runner_old" }
    });
    expect(revokedClaim.status).toBe(401);
    await expect(revokedClaim.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: "runner_token_revoked",
      message: expect.stringContaining("Pair again")
    });

    const currentClaim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer runner_new" }
    });
    expect(currentClaim.status).toBe(204);

    const audit = await app.request("/v1/control-plane-events?type=security.auth_failed", {
      headers: { authorization: "Bearer pair_test" }
    });
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        subject: "POST /v1/runners/:runnerId/claim",
        payload: expect.objectContaining({ reason: "runner_token_revoked" })
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("runner_old");
    expect(JSON.stringify(events)).not.toContain(tokenFingerprint("runner_old"));
  });

  it("rejects a revoked pairing token before runner-runtime fallback auth", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_test",
      revokedRunnerTokenFingerprints: [tokenFingerprint("pair_test")]
    });

    const claim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer pair_test" }
    });

    expect(claim.status).toBe(401);
    await expect(claim.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: "runner_token_revoked"
    });
  });

  it("summarizes repeated control-plane security events as alerts", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });

    for (let index = 0; index < 3; index += 1) {
      const denied = await app.request("/v1/runners/runner_1", {
        headers: { authorization: "Bearer wrong_secret" }
      });
      expect(denied.status).toBe(401);
    }

    const alertsResponse = await app.request("/v1/control-plane-alerts", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(alertsResponse.status).toBe(200);
    const { alerts } = await alertsResponse.json();
    expect(alerts).toEqual([
      expect.objectContaining({
        type: "repeated_auth_failures",
        severity: "warn",
        eventType: "security.auth_failed",
        count: 3,
        threshold: 3,
        subject: expect.not.stringContaining("wrong_secret"),
        reason: "Repeated dispatcher authorization failures were observed."
      })
    ]);
    expect(JSON.stringify(alerts)).not.toContain("wrong_secret");
  });

  it("records ingress signature failures as control-plane events and alert candidates", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });

    for (let index = 0; index < 3; index += 1) {
      const response = await app.request("/v1/control-plane-events", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer pair_test" },
        body: JSON.stringify({
          type: "security.signature_failed",
          severity: "warn",
          subject: "github:POST /github/webhooks",
          payload: {
            provider: "github",
            endpoint: "POST /github/webhooks",
            reason: "invalid_signature"
          }
        })
      });
      expect(response.status).toBe(201);
    }

    const eventsResponse = await app.request("/v1/control-plane-events?type=security.signature_failed", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(eventsResponse.status).toBe(200);
    const { events } = await eventsResponse.json();
    expect(events).toHaveLength(3);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "security.signature_failed",
          severity: "warn",
          subject: "github:POST /github/webhooks",
          payload: expect.objectContaining({ provider: "github", reason: "invalid_signature" })
        })
      ])
    );

    const alertsResponse = await app.request("/v1/control-plane-alerts", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(alertsResponse.status).toBe(200);
    await expect(alertsResponse.json()).resolves.toMatchObject({
      alerts: [
        {
          type: "repeated_signature_failures",
          eventType: "security.signature_failed",
          count: 3,
          threshold: 3,
          subject: "github:POST /github/webhooks"
        }
      ]
    });
  });

  it("summarizes terminal token misuse as an immediate alert candidate", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });

    const response = await app.request("/v1/control-plane-events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" },
      body: JSON.stringify({
        type: "security.token_misuse",
        severity: "warn",
        subject: "slack:app_token",
        payload: {
          provider: "slack",
          endpoint: "apps.connections.open",
          reason: "token_revoked",
          tokenKind: "app_token",
          mode: "socket_mode",
          tokenFingerprint: "sha256:abc123"
        }
      })
    });
    expect(response.status).toBe(201);

    const alertsResponse = await app.request("/v1/control-plane-alerts", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(alertsResponse.status).toBe(200);
    const { alerts } = await alertsResponse.json();
    expect(alerts).toEqual([
      expect.objectContaining({
        type: "token_misuse",
        severity: "warn",
        eventType: "security.token_misuse",
        count: 1,
        threshold: 1,
        subject: "slack:app_token",
        reason: "A platform or relay token failed with a terminal authentication or configuration error."
      })
    ]);
    expect(JSON.stringify(alerts)).not.toContain("xapp-");
  });

  it("summarizes high runner claim volume as an alert candidate", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const registerResponse = await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }));
    expect(registerResponse.status).toBe(201);
    const bindingResponse = await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1"
    }));
    expect(bindingResponse.status).toBe(201);

    for (let index = 0; index < 10; index += 1) {
      const createResponse = await app.request("/v1/runs", jsonRequest({
        runId: `run_claim_alert_${index}`,
        event: githubIssueEvent({
          id: `evt_claim_alert_${index}`,
          sourceEventId: `comment_claim_alert_${index}`
        })
      }));
      expect(createResponse.status).toBe(201);
      const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
      expect(claimResponse.status).toBe(200);
      const completeResponse = await app.request(`/v1/runners/runner_1/runs/run_claim_alert_${index}/complete`, jsonRequest({
        result: { conclusion: "success", summary: "Claimed and completed." }
      }));
      expect(completeResponse.status).toBe(200);
    }

    const alertsResponse = await app.request("/v1/control-plane-alerts");
    expect(alertsResponse.status).toBe(200);
    const { alerts } = await alertsResponse.json();
    expect(alerts).toEqual([
      expect.objectContaining({
        type: "abnormal_runner_claim_rate",
        severity: "warn",
        eventType: "run.claimed",
        count: 10,
        threshold: 10,
        subject: "runner_1",
        reason: "Runner claim volume exceeded the local alert threshold."
      })
    ]);
  });

  it("rate limits by relay token fingerprint and endpoint when enabled", async () => {
    let now = 1_000;
    const app = createDispatcherApp({
      databasePath: ":memory:",
      rateLimit: {
        windowMs: 1_000,
        maxRequests: 1,
        now: () => now
      }
    });

    const first = await app.request("/v1/runners/runner_1", {
      headers: { authorization: "Bearer token_a" }
    });
    expect(first.status).toBe(404);

    const second = await app.request("/v1/runners/runner_1", {
      headers: { authorization: "Bearer token_a" }
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    await expect(second.json()).resolves.toEqual({
      error: "rate_limited",
      retryAfterMs: 1_000,
      maxRequests: 1,
      windowMs: 1_000
    });

    const otherToken = await app.request("/v1/runners/runner_1", {
      headers: { authorization: "Bearer token_b" }
    });
    expect(otherToken.status).toBe(404);

    now = 2_001;
    const afterReset = await app.request("/v1/runners/runner_1", {
      headers: { authorization: "Bearer token_a" }
    });
    expect(afterReset.status).toBe(404);
  });

  it("keeps rate-limit buckets separate by runner id, source platform, and tenant", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      rateLimit: {
        windowMs: 1_000,
        maxRequests: 1,
        now: () => 10_000
      }
    });

    const firstRunnerClaim = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(firstRunnerClaim.status).toBe(204);
    const secondRunnerClaim = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(secondRunnerClaim.status).toBe(429);
    const otherRunnerClaim = await app.request("/v1/runners/runner_2/claim", { method: "POST" });
    expect(otherRunnerClaim.status).toBe(204);

    const firstGitHubBindingLookup = await app.request("/v1/repo-bindings/github/acme/demo");
    expect(firstGitHubBindingLookup.status).toBe(404);
    const secondGitHubBindingLookup = await app.request("/v1/repo-bindings/github/acme/demo");
    expect(secondGitHubBindingLookup.status).toBe(429);
    const otherGitHubOwnerLookup = await app.request("/v1/repo-bindings/github/other/demo");
    expect(otherGitHubOwnerLookup.status).toBe(404);
    const slackBindingLookup = await app.request("/v1/repo-bindings/slack/acme/demo");
    expect(slackBindingLookup.status).toBe(404);

    const firstLarkChannelLookup = await app.request("/v1/channel-bindings/lark/tenant_1/chat_1/status");
    expect(firstLarkChannelLookup.status).toBe(404);
    const sameLarkTenantLookup = await app.request("/v1/channel-bindings/lark/tenant_1/chat_2/status");
    expect(sameLarkTenantLookup.status).toBe(429);
    const otherLarkTenantLookup = await app.request("/v1/channel-bindings/lark/tenant_2/chat_1/status");
    expect(otherLarkTenantLookup.status).toBe(404);
  });

  it("creates and claims an echo run", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const runnerResponse = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    expect(runnerResponse.status).toBe(201);

    const bindingResponse = await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    });
    expect(bindingResponse.status).toBe(201);

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_1", event: validEvent })
    });
    expect(createResponse.status).toBe(201);

    const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(claimResponse.status).toBe(200);
    const claimed = await claimResponse.json();
    expect(claimed.run.id).toBe("run_1");
    expect(claimed.event.command.rawText).toBe("fix this");

    const bindingGetResponse = await app.request("/v1/repo-bindings/github/acme/demo");
    const binding = await bindingGetResponse.json();
    expect(binding.binding).toMatchObject({ runnerId: "runner_1", workspacePath: "/Users/test/demo" });
  });

  it("records dispatcher-created run provenance for relay auditability", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_provenance_http",
        event: {
          ...validEvent,
          id: "evt_provenance_http",
          sourceEventId: "comment_provenance_http",
          metadata: {
            ...validEvent.metadata,
            sourceDeliveryId: "delivery_123",
            webhookSignatureVerified: true
          }
        }
      })
    });
    expect(createResponse.status).toBe(201);

    const eventsResponse = await app.request("/v1/runs/run_provenance_http/events");
    const { events } = await eventsResponse.json();
    expect(events.find((event: { type: string }) => event.type === "run.created")?.payload).toMatchObject({
      eventId: "evt_provenance_http",
      provenance: {
        source: "github",
        sourceEventId: "comment_provenance_http",
        sourceDeliveryId: "delivery_123",
        signatureState: "verified",
        projectTarget: { ref: "github:acme/demo", provider: "github", owner: "acme", repo: "demo" },
        admissionDecision: {
          action: "start",
          reasonCode: "new_event",
          eventId: "evt_provenance_http"
        },
        expectedRunnerId: "runner_1"
      }
    });
  });

  it("returns the existing run for a replayed source event", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const firstResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_duplicate_1", event: validEvent })
    });
    expect(firstResponse.status).toBe(201);

    const secondResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_duplicate_2", event: validEvent })
    });
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      decision: {
        action: "drop_duplicate",
        reasonCode: "duplicate_source_event"
      },
      run: { id: "run_duplicate_1" },
      idempotentReplay: true
    });
  });

  it("queues same-thread work as a durable follow-up when a run is already active", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const first = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_active_1", event: { ...validEvent, id: "evt_active_1", sourceEventId: "comment_active_1" } })
    });
    expect(first.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const second = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "follow_up_1",
        event: {
          ...validEvent,
          id: "evt_follow_up_1",
          sourceEventId: "comment_follow_up_1",
          command: { rawText: "fix this after the current run", intent: "fix", args: {} }
        }
      })
    });
    expect(second.status).toBe(202);
    const secondJson = await second.json();
    expect(secondJson).toMatchObject({
      decision: {
        action: "queue_follow_up",
        reasonCode: "active_run_same_thread",
        activeRunId: "run_active_1"
      },
      followUpRequest: {
        id: "follow_up_1",
        sourceEventId: "evt_follow_up_1",
        status: "queued"
      }
    });
    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: "OpenTag picked this up. Run: `run_active_1`"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_active_1`: Queued follow-up follow_up_1 behind the active run.",
        statusMessageKey: "run_active_1:status"
      }
    ]);

    const getFollowUp = await app.request("/v1/follow-up-requests/follow_up_1");
    expect(getFollowUp.status).toBe(200);
    await expect(getFollowUp.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_1",
        decision: { action: "queue_follow_up" }
      }
    });

    const promote = await app.request("/v1/follow-up-requests/follow_up_1/create-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_from_follow_up_1" })
    });
    expect(promote.status).toBe(201);
    await expect(promote.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_1",
        status: "promoted",
        createdRunId: "run_from_follow_up_1"
      },
      run: {
        id: "run_from_follow_up_1",
        parentRunId: "run_active_1"
      }
    });
  });

  it("auto-promotes the next queued follow-up after a terminal runner completion", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );

    const first = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_auto_promote_active",
        event: githubIssueEvent({ id: "evt_auto_promote_active", sourceEventId: "comment_auto_promote_active" })
      })
    );
    expect(first.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const firstFollowUp = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "follow_up_auto_1",
        event: githubIssueEvent({ id: "evt_follow_up_auto_1", sourceEventId: "comment_follow_up_auto_1" })
      })
    );
    expect(firstFollowUp.status).toBe(202);

    const secondFollowUp = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "follow_up_auto_2",
        event: githubIssueEvent({ id: "evt_follow_up_auto_2", sourceEventId: "comment_follow_up_auto_2" })
      })
    );
    expect(secondFollowUp.status).toBe(202);

    const complete = await app.request(
      "/v1/runners/runner_1/runs/run_auto_promote_active/complete",
      jsonRequest({
        result: { conclusion: "success", summary: "Finished active run." }
      })
    );
    expect(complete.status).toBe(200);
    const completeJson = await complete.json();
    expect(completeJson).toMatchObject({
      ok: true,
      promotedFollowUp: {
        followUpRequest: {
          id: "follow_up_auto_1",
          status: "promoted"
        },
        run: {
          parentRunId: "run_auto_promote_active"
        }
      }
    });
    const promotedRunId = completeJson.promotedFollowUp.run.id;
    expect(promotedRunId).toMatch(/^run_/);
    expect(completeJson.promotedFollowUp.followUpRequest.createdRunId).toBe(promotedRunId);

    await expect((await app.request("/v1/follow-up-requests/follow_up_auto_1")).json()).resolves.toMatchObject({
      followUpRequest: { id: "follow_up_auto_1", status: "promoted", createdRunId: promotedRunId }
    });
    await expect((await app.request("/v1/follow-up-requests/follow_up_auto_2")).json()).resolves.toMatchObject({
      followUpRequest: { id: "follow_up_auto_2", status: "queued" }
    });

    const claimPromoted = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(claimPromoted.status).toBe(200);
    await expect(claimPromoted.json()).resolves.toMatchObject({
      run: { id: promotedRunId, parentRunId: "run_auto_promote_active" }
    });

    const eventsResponse = await app.request("/v1/runs/run_auto_promote_active/events");
    const { events } = await eventsResponse.json();
    expect(events.find((event: { type: string }) => event.type === "follow_up_request.auto_promoted")).toMatchObject({
      payload: {
        followUpRequestId: "follow_up_auto_1",
        createdRunId: promotedRunId
      }
    });
    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: "OpenTag picked this up. Run: `run_auto_promote_active`"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_auto_promote_active`: Queued follow-up follow_up_auto_1 behind the active run.",
        statusMessageKey: "run_auto_promote_active:status"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_auto_promote_active`: Queued follow-up follow_up_auto_2 behind the active run.",
        statusMessageKey: "run_auto_promote_active:status"
      },
      {
        kind: "final",
        body: expect.stringContaining("Finished active run.")
      },
      {
        kind: "acknowledgement",
        body: `OpenTag picked this up. Run: \`${promotedRunId}\``
      }
    ]);
  });

  it("uses the Slack run card for queued follow-ups instead of a text acknowledgement", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );
    await bindSourceChannel(app, slackRepoEvent({
      id: "evt_slack_active_binding",
      sourceEventId: "slack_active_binding",
      threadKey: "T123|C123|1710000000.000100"
    }));

    const first = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_slack_active_1",
        event: slackRepoEvent({ id: "evt_slack_active_1", sourceEventId: "slack_active_1", threadKey: "T123|C123|1710000000.000100" })
      })
    );
    expect(first.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const second = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "follow_up_slack_1",
        event: slackRepoEvent({ id: "evt_slack_follow_up_1", sourceEventId: "slack_follow_up_1", threadKey: "T123|C123|1710000000.000100" })
      })
    );
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_slack_1",
        status: "queued",
        activeRunId: "run_slack_active_1"
      }
    });
    expect(delivered.filter((message) => message.kind === "progress")).toEqual([
      {
        kind: "progress",
        body: expect.stringContaining("*OpenTag: Queued*")
      }
    ]);
  });

  it("stores and returns repo policy rules", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const response = await app.request("/v1/repo-bindings/github/acme/demo/policy-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rule: {
          id: "repo_allows_labels",
          scope: "work_context_owner_container",
          effect: "allow",
          capabilityId: "set_labels",
          reason: "Repo allows approved label changes."
        }
      })
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ rule: { id: "repo_allows_labels" } });

    const listResponse = await app.request("/v1/repo-bindings/github/acme/demo/policy-rules");
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      rules: [{ id: "repo_allows_labels", effect: "allow" }]
    });
  });

  it("stores and returns repo mutation mappings", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const response = await app.request("/v1/repo-bindings/github/acme/demo/mutation-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mapping: {
          id: "github_status_labels",
          adapter: "github",
          domain: "status",
          strategy: "label",
          values: { blocked: "status/blocked" }
        }
      })
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ mapping: { id: "github_status_labels" } });

    const listResponse = await app.request("/v1/repo-bindings/github/acme/demo/mutation-mappings");
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      mappings: [{ id: "github_status_labels", domain: "status" }]
    });
  });

  it("stores Linear relay installations without echoing token or webhook secret", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const response = await app.request(
      "/v1/linear-relay-installations",
      jsonRequest({
        id: "install_123",
        webhookPath: "/linear/webhooks/install_123",
        webhookSecret: "linear_webhook_secret",
        token: "lin_api_token",
        graphqlUrl: "https://linear.example/graphql",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        teamKey: "ENG"
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      installation: {
        id: "install_123",
        webhookPath: "/linear/webhooks/install_123",
        projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" },
        graphqlUrl: "https://linear.example/graphql",
        teamKey: "ENG"
      }
    });
    expect(JSON.stringify(body)).not.toContain("linear_webhook_secret");
    expect(JSON.stringify(body)).not.toContain("lin_api_token");
  });

  it("starts hosted Linear OAuth app installations without leaking generated secrets", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pairing_token",
      linearOAuthInstall: {
        clientId: "linear_client",
        redirectUri: "https://relay.example/linear/oauth/callback",
        scopes: ["read", "comments:create", "app:assignable"],
        authorizationUrl: "https://linear.example/oauth/authorize",
        webhookPath: "/linear/custom/oauth/webhooks",
        now: () => new Date("2026-07-07T00:00:00.000Z"),
        installStateTtlMs: 600_000
      }
    });

    const unauthenticated = await app.request(
      "/v1/linear-oauth-installations",
      jsonRequest({
        owner: "acme",
        repo: "demo"
      })
    );
    expect(unauthenticated.status).toBe(401);

    const response = await app.request(
      "/v1/linear-oauth-installations",
      authorizedJsonRequest({
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        teamKey: "ENG",
        graphqlUrl: "https://linear.example/graphql"
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      oauthWebhookPath: "/linear/custom/oauth/webhooks",
      stateExpiresAt: "2026-07-07T00:10:00.000Z",
      installation: {
        id: expect.stringMatching(/^install_[0-9a-f]{24}$/),
        webhookPath: expect.stringMatching(/^\/linear\/webhooks\/install_[0-9a-f]{24}$/),
        projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" },
        graphqlUrl: "https://linear.example/graphql",
        teamKey: "ENG"
      }
    });
    expect(String(body.authorizationUrl)).toContain("https://linear.example/oauth/authorize?");
    const authorizationUrl = new URL(String(body.authorizationUrl));
    expect(authorizationUrl.searchParams.get("client_id")).toBe("linear_client");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://relay.example/linear/oauth/callback");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("actor")).toBe("app");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizationUrl.searchParams.get("scope")).toBe("read,comments:create,app:assignable");
    expect(authorizationUrl.searchParams.get("state")).toMatch(/^linear_[0-9a-f]{48}$/);
    expect(JSON.stringify(body)).not.toContain("linear_whsec_");
  });

  it("completes hosted Linear OAuth installs and refreshes relay tokens for callbacks", async () => {
    let now = new Date("2026-07-07T00:00:00.000Z");
    const tokenRequests: Array<Record<string, string>> = [];
    const graphqlRequests: Array<{ authorization: string | null; body: { query?: string; variables?: unknown } }> = [];
    const linearFetch = (async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl === "https://linear.example/oauth/token") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        tokenRequests.push(Object.fromEntries(body.entries()));
        if (body.get("grant_type") === "authorization_code") {
          return Response.json({
            access_token: "linear_access_token",
            refresh_token: "linear_refresh_token",
            expires_in: 1,
            scope: "read,write,comments:create,app:assignable,app:mentionable"
          });
        }
        return Response.json({
          access_token: "linear_refreshed_token",
          refresh_token: "linear_refresh_token_2",
          expires_in: 3600,
          scope: "read,write,comments:create,app:assignable,app:mentionable"
        });
      }
      if (requestUrl === "https://linear.example/graphql") {
        const body = JSON.parse(String(init?.body)) as { query?: string; variables?: unknown };
        graphqlRequests.push({ authorization: new Headers(init?.headers).get("authorization"), body });
        if (body.query?.includes("OpenTagLinearWorkspaceIdentity")) {
          return Response.json({
            data: {
              viewer: { id: "app_user_1", name: "OpenTag", app: true },
              organization: { id: "org_linear_1", name: "Acme", urlKey: "acme" }
            }
          });
        }
        if (body.query?.includes("OpenTagLinearMetadata")) {
          return Response.json({
            data: {
              teams: {
                nodes: [{ id: "team_eng", key: "ENG", name: "Engineering" }]
              },
              users: {
                nodes: [{ id: "user_ada", name: "Ada Lovelace", displayName: "Ada", email: "ada@example.com", active: true, app: false }]
              },
              workflowStates: {
                nodes: [{ id: "state_progress", name: "In Progress", type: "started", team: { id: "team_eng", key: "ENG" } }]
              },
              issueLabels: {
                nodes: [{ id: "label_bug", name: "Bug", color: "#ff0000", isGroup: false, team: { id: "team_eng", key: "ENG" } }]
              }
            }
          });
        }
        return Response.json({
          data: {
            commentCreate: {
              success: true,
              comment: {
                id: "linear_comment_1",
                url: "https://linear.app/acme/issue/ENG-1/demo#comment"
              }
            }
          }
        });
      }
      throw new Error(`Unexpected Linear test request: ${requestUrl}`);
    }) as typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = linearFetch;
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pairing_token",
      linearOAuthInstall: {
        clientId: "linear_client",
        clientSecret: "linear_secret",
        redirectUri: "https://relay.example/linear/oauth/callback",
        webhookSecret: "linear_app_webhook_secret",
        authorizationUrl: "https://linear.example/oauth/authorize",
        tokenUrl: "https://linear.example/oauth/token",
        fetchImpl: linearFetch,
        now: () => now,
        refreshSkewMs: 0,
        commentRunDeferMs: 0
      }
    });

    try {
      await app.request("/v1/runners", authorizedJsonRequest({ runnerId: "runner_1", name: "Runner 1" }));
      await app.request(
        "/v1/repo-bindings",
        authorizedJsonRequest({
          provider: "github",
          owner: "acme",
          repo: "demo",
          runnerId: "runner_1"
        })
      );

      const start = await app.request(
        "/v1/linear-oauth-installations",
        authorizedJsonRequest({
          owner: "acme",
          repo: "demo",
          graphqlUrl: "https://linear.example/graphql"
        })
      );
      expect(start.status).toBe(201);
      const started = await start.json();
      const state = new URL(String(started.authorizationUrl)).searchParams.get("state");
      expect(state).toBeTruthy();

      const callback = await app.request(`/linear/oauth/callback?state=${encodeURIComponent(state!)}&code=code_123`);
      expect(callback.status).toBe(200);
      const completed = await callback.json();
      expect(completed).toMatchObject({
        ok: true,
        installation: {
          id: started.installation.id,
          webhookPath: started.installation.webhookPath,
          projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" },
          graphqlUrl: "https://linear.example/graphql",
          organizationId: "org_linear_1",
          teamId: "team_eng",
          teamKey: "ENG"
        }
      });
      expect(JSON.stringify(completed)).not.toContain("linear_access_token");
      expect(JSON.stringify(completed)).not.toContain("linear_refresh_token");
      expect(tokenRequests).toEqual([
        {
          client_id: "linear_client",
          code: "code_123",
          redirect_uri: "https://relay.example/linear/oauth/callback",
          grant_type: "authorization_code",
          client_secret: "linear_secret"
        }
      ]);
      expect(graphqlRequests).toHaveLength(5);
      expect(graphqlRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authorization: "Bearer linear_access_token",
            body: expect.objectContaining({ query: expect.stringContaining("OpenTagLinearWorkspaceIdentity") })
          }),
          expect.objectContaining({
            authorization: "Bearer linear_access_token",
            body: expect.objectContaining({ query: expect.stringContaining("OpenTagLinearMetadataTeams") })
          }),
          expect.objectContaining({
            authorization: "Bearer linear_access_token",
            body: expect.objectContaining({ query: expect.stringContaining("OpenTagLinearMetadataUsers") })
          }),
          expect.objectContaining({
            authorization: "Bearer linear_access_token",
            body: expect.objectContaining({ query: expect.stringContaining("OpenTagLinearMetadataWorkflowStates") })
          }),
          expect.objectContaining({
            authorization: "Bearer linear_access_token",
            body: expect.objectContaining({ query: expect.stringContaining("OpenTagLinearMetadataIssueLabels") })
          })
        ])
      );
      const mappingsResponse = await app.request("/v1/repo-bindings/github/acme/demo/mutation-mappings", {
        headers: { authorization: "Bearer pairing_token" }
      });
      expect(mappingsResponse.status).toBe(200);
      await expect(mappingsResponse.json()).resolves.toMatchObject({
        mappings: expect.arrayContaining([
          expect.objectContaining({
            id: "linear_status_state_id",
            values: expect.objectContaining({ in_progress: "state_progress" })
          }),
          expect.objectContaining({
            id: "linear_assignee_user_id",
            values: expect.objectContaining({ "ada@example.com": "user_ada" })
          }),
          expect.objectContaining({
            id: "linear_label_label_id",
            values: expect.objectContaining({ bug: "label_bug" })
          })
        ])
      });

      graphqlRequests.length = 0;
      const payload = {
        type: "Comment",
        action: "create",
        webhookId: "linear_oauth_webhook_delivery_1",
        organizationId: "org_linear_1",
        createdAt: "2026-07-07T00:00:00.000Z",
        webhookTimestamp: Date.now(),
        data: {
          id: "comment_oauth_1",
          body: "@opentag run from hosted OAuth webhook",
          url: "https://linear.app/acme/issue/ENG-1/demo#comment",
          issue: {
            id: "issue_123",
            identifier: "ENG-1",
            title: "Demo",
            url: "https://linear.app/acme/issue/ENG-1/demo",
            team: { id: "team_eng", key: "ENG" }
          },
          user: { id: "user_ada", name: "Ada Lovelace" }
        }
      };
      const rawBody = JSON.stringify(payload);
      const hostedWebhook = await app.request("/linear/oauth/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_app_webhook_secret", rawBody })
        },
        body: rawBody
      });

      expect(hostedWebhook.status).toBe(200);
      await expect(hostedWebhook.json()).resolves.toMatchObject({ ok: true, runId: expect.any(String) });
      expect(graphqlRequests).toHaveLength(1);
      expect(graphqlRequests[0]).toMatchObject({
        authorization: "Bearer linear_access_token"
      });
      expect(graphqlRequests[0]!.body.query).toContain("commentCreate");

      graphqlRequests.length = 0;
      now = new Date("2026-07-07T00:00:10.000Z");
      const event = linearIssueEvent({ id: "evt_linear_oauth", sourceEventId: "linear_oauth_comment" });
      const createRun = await app.request(
        "/v1/runs",
        authorizedJsonRequest({
          runId: "run_linear_oauth",
          event: {
            ...event,
            metadata: {
              ...event.metadata,
              linearRelayInstallationId: started.installation.id
            }
          }
        })
      );

      expect(createRun.status).toBe(201);
      expect(tokenRequests.map((request) => request["grant_type"])).toEqual(["authorization_code", "refresh_token"]);
      expect(tokenRequests[1]).toMatchObject({
        client_id: "linear_client",
        refresh_token: "linear_refresh_token",
        grant_type: "refresh_token",
        client_secret: "linear_secret"
      });
      expect(graphqlRequests).toHaveLength(1);
      expect(graphqlRequests[0]).toMatchObject({
        authorization: "Bearer linear_refreshed_token"
      });
      expect(graphqlRequests[0]!.body.query).toContain("commentCreate");
      expect(graphqlRequests[0]!.body.variables).toMatchObject({
        input: {
          issueId: "issue_123"
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("removes hosted Linear OAuth installations when Linear sends OAuthApp revoked", async () => {
    const graphqlRequests: Array<{ authorization: string | null; body: { query?: string; variables?: unknown } }> = [];
    const linearFetch = (async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl === "https://linear.example/oauth/token") {
        return Response.json({
          access_token: "linear_access_token",
          refresh_token: "linear_refresh_token",
          expires_in: 3600,
          scope: "read,write,comments:create,app:assignable,app:mentionable"
        });
      }
      if (requestUrl === "https://linear.example/graphql") {
        const body = JSON.parse(String(init?.body)) as { query?: string; variables?: unknown };
        graphqlRequests.push({ authorization: new Headers(init?.headers).get("authorization"), body });
        if (body.query?.includes("OpenTagLinearWorkspaceIdentity")) {
          return Response.json({
            data: {
              viewer: { id: "app_user_1", name: "OpenTag", app: true },
              organization: { id: "org_linear_1", name: "Acme", urlKey: "acme" }
            }
          });
        }
        if (body.query?.includes("OpenTagLinearMetadata")) {
          return Response.json({
            data: {
              teams: { nodes: [] },
              users: { nodes: [] },
              workflowStates: { nodes: [] },
              issueLabels: { nodes: [] }
            }
          });
        }
      }
      throw new Error(`Unexpected Linear test request: ${requestUrl}`);
    }) as typeof fetch;
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pairing_token",
      linearOAuthInstall: {
        clientId: "linear_client",
        clientSecret: "linear_secret",
        redirectUri: "https://relay.example/linear/oauth/callback",
        webhookSecret: "linear_app_webhook_secret",
        authorizationUrl: "https://linear.example/oauth/authorize",
        tokenUrl: "https://linear.example/oauth/token",
        fetchImpl: linearFetch
      }
    });

    const start = await app.request(
      "/v1/linear-oauth-installations",
      authorizedJsonRequest({
        owner: "acme",
        repo: "demo",
        graphqlUrl: "https://linear.example/graphql"
      })
    );
    expect(start.status).toBe(201);
    const started = await start.json();
    const state = new URL(String(started.authorizationUrl)).searchParams.get("state");
    const callback = await app.request(`/linear/oauth/callback?state=${encodeURIComponent(state!)}&code=code_123`);
    expect(callback.status).toBe(200);

    const revokedPayload = {
      type: "OAuthApp",
      action: "revoked",
      webhookId: "linear_oauth_revoked_1",
      webhookTimestamp: Date.now(),
      organizationId: "org_linear_1",
      oauthClientId: "linear_client"
    };
    const revokedRawBody = JSON.stringify(revokedPayload);
    const revoked = await app.request("/linear/oauth/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": computeLinearSignature({ webhookSecret: "linear_app_webhook_secret", rawBody: revokedRawBody })
      },
      body: revokedRawBody
    });

    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ ok: true, revoked: true, installationId: started.installation.id });

    const events = await app.request("/v1/control-plane-events?type=linear.oauth_install.revoked", {
      headers: { authorization: "Bearer pairing_token" }
    });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      events: [
        {
          type: "linear.oauth_install.revoked",
          severity: "warn",
          subject: started.installation.id,
          payload: {
            installationId: started.installation.id,
            organizationId: "org_linear_1",
            oauthClientId: "linear_client"
          }
        }
      ]
    });

    const graphQlRequestCountAfterRevoke = graphqlRequests.length;
    const commentPayload = {
      type: "Comment",
      action: "create",
      webhookId: "linear_oauth_after_revoke",
      organizationId: "org_linear_1",
      createdAt: "2026-07-07T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        id: "comment_after_revoke",
        body: "@opentag should not run after revoke",
        issue: {
          id: "issue_123",
          identifier: "ENG-1",
          url: "https://linear.app/acme/issue/ENG-1/demo",
          team: { id: "team_eng", key: "ENG" }
        },
        user: { id: "user_ada", name: "Ada Lovelace" }
      }
    };
    const commentRawBody = JSON.stringify(commentPayload);
    const afterRevoke = await app.request("/linear/oauth/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": computeLinearSignature({ webhookSecret: "linear_app_webhook_secret", rawBody: commentRawBody })
      },
      body: commentRawBody
    });

    expect(afterRevoke.status).toBe(404);
    await expect(afterRevoke.json()).resolves.toMatchObject({ error: "linear_relay_installation_not_found" });
    expect(graphqlRequests).toHaveLength(graphQlRequestCountAfterRevoke);
  });

  it("routes dynamic Linear relay webhooks through stored installation credentials", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Runner 1" }));
    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    );
    await app.request(
      "/v1/linear-relay-installations",
      jsonRequest({
        id: "install_123",
        webhookPath: "/linear/webhooks/install_123",
        webhookSecret: "linear_webhook_secret",
        token: "lin_api_token",
        graphqlUrl: "https://linear.example/graphql",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    );

    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization?: string | null; body?: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        authorization: init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string> | undefined)?.authorization,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      return Response.json({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "linear_comment_1", url: "https://linear.app/acme/issue/ENG-1#comment" }
          }
        }
      });
    }) as typeof fetch;

    try {
      const payload = {
        type: "Comment",
        action: "create",
        webhookId: "linear_delivery_1",
        organizationId: "org_1",
        createdAt: "2026-07-07T00:00:00.000Z",
        webhookTimestamp: Date.now(),
        data: {
          id: "comment_1",
          body: "@opentag run dynamic relay smoke",
          url: "https://linear.app/acme/issue/ENG-1/demo#comment",
          issue: {
            id: "issue_1",
            identifier: "ENG-1",
            title: "Demo",
            url: "https://linear.app/acme/issue/ENG-1/demo",
            team: { id: "team_1", key: "ENG" }
          },
          user: { id: "user_1", name: "Ada" }
        }
      };
      const rawBody = JSON.stringify(payload);
      const response = await app.request("/linear/webhooks/install_123", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody })
        },
        body: rawBody
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, runId: expect.any(String) });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "https://linear.example/graphql",
        authorization: "lin_api_token"
      });
      expect(String((requests[0]!.body as { query: string }).query)).toContain("commentCreate");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("queues prompted Linear Agent Session events behind an active Agent Session run", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Runner 1" }));
    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    );
    await app.request(
      "/v1/linear-relay-installations",
      jsonRequest({
        id: "install_agent_prompted",
        webhookPath: "/linear/webhooks/install_agent_prompted",
        webhookSecret: "linear_webhook_secret",
        token: "lin_api_token",
        graphqlUrl: "https://linear.example/graphql",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    );

    const originalFetch = globalThis.fetch;
    const graphqlRequests: Array<{ authorization?: string | null; body?: { query?: string; variables?: unknown } }> = [];
    globalThis.fetch = (async (url, init) => {
      if (String(url) !== "https://linear.example/graphql") {
        throw new Error(`Unexpected Linear test request: ${String(url)}`);
      }
      const body = JSON.parse(String(init?.body)) as { query?: string; variables?: unknown };
      graphqlRequests.push({
        authorization: init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string> | undefined)?.authorization,
        body
      });
      if (body.query?.includes("agentActivityCreate")) {
        return Response.json({ data: { agentActivityCreate: { success: true, agentActivity: { id: `activity_${graphqlRequests.length}` } } } });
      }
      return Response.json({ data: { agentSessionUpdate: { success: true } } });
    }) as typeof fetch;

    try {
      const agentSession = {
        id: "agent_session_prompted_1",
        creator: { id: "user_1", name: "Ada" },
        issue: {
          id: "issue_1",
          identifier: "ENG-1",
          title: "Demo",
          url: "https://linear.app/acme/issue/ENG-1/demo",
          team: { id: "team_1", key: "ENG", name: "Engineering" }
        }
      };
      const createdPayload = {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "linear_agent_prompted_created_1",
        organizationId: "org_1",
        createdAt: "2026-07-07T00:00:00.000Z",
        webhookTimestamp: Date.now(),
        promptContext: "<issue identifier=\"ENG-1\">Initial prompt</issue>",
        agentSession
      };
      const createdRawBody = JSON.stringify(createdPayload);
      const created = await app.request("/linear/webhooks/install_agent_prompted", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody: createdRawBody })
        },
        body: createdRawBody
      });

      expect(created.status).toBe(200);
      const createdBody = await created.json();
      const activeRunId = String(createdBody.runId);
      expect(activeRunId).toMatch(/^run_/);
      await app.request("/v1/runners/runner_1/claim", { method: "POST" });
      await app.request(`/v1/runners/runner_1/runs/${activeRunId}/running`, jsonRequest({ executor: "echo" }));
      for (let attempt = 0; attempt < 20 && graphqlRequests.length < 2; attempt += 1) {
        await wait(10);
      }
      graphqlRequests.length = 0;

      const promptText = "Please also update the regression coverage.";
      const promptedPayload = {
        type: "AgentSessionEvent",
        action: "prompted",
        webhookId: "linear_agent_prompted_1",
        organizationId: "org_1",
        createdAt: "2026-07-07T00:00:01.000Z",
        webhookTimestamp: Date.now(),
        promptContext: "This context should not override the prompted activity body.",
        agentActivity: {
          id: "activity_prompted_1",
          body: promptText
        },
        agentSession
      };
      const promptedRawBody = JSON.stringify(promptedPayload);
      const prompted = await app.request("/linear/webhooks/install_agent_prompted", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody: promptedRawBody })
        },
        body: promptedRawBody
      });

      expect(prompted.status).toBe(200);
      await expect(prompted.json()).resolves.toEqual({ ok: true });
      const status = await app.request(
        "/v1/thread-actions",
        jsonRequest({
          rawText: "/status",
          actor: { provider: "linear", providerUserId: "user_1", handle: "Ada", organizationId: "org_1" },
          callback: {
            provider: "linear",
            uri: "linear://agent-session/agent_session_prompted_1/activities",
            threadKey: "ENG|issue|ENG-1"
          },
          metadata: {
            repoProvider: "github",
            owner: "acme",
            repo: "demo",
            agentSessionId: "agent_session_prompted_1",
            linearRelayInstallationId: "install_agent_prompted",
            graphqlUrl: "https://linear.example/graphql"
          }
        })
      );
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({
        outcome: "status",
        activeRun: { id: activeRunId, status: "running" },
        queuedFollowUps: [
          {
            status: "queued",
            activeRunId,
            event: {
              command: {
                rawText: promptText
              },
              metadata: {
                action: "prompted",
                agentSessionId: "agent_session_prompted_1"
              }
            }
          }
        ]
      });
      expect(graphqlRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authorization: "lin_api_token",
            body: expect.objectContaining({
              query: expect.stringContaining("agentActivityCreate"),
              variables: expect.objectContaining({
                input: expect.objectContaining({
                  agentSessionId: "agent_session_prompted_1",
                  content: expect.objectContaining({
                    type: "thought",
                    body: expect.stringContaining("Queued follow-up")
                  })
                })
              })
            })
          })
        ])
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cancels an active Linear Agent Session run when Linear sends a stop signal", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Runner 1" }));
    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    );
    await app.request(
      "/v1/linear-relay-installations",
      jsonRequest({
        id: "install_agent_stop",
        webhookPath: "/linear/webhooks/install_agent_stop",
        webhookSecret: "linear_webhook_secret",
        token: "lin_api_token",
        graphqlUrl: "https://linear.example/graphql",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    );

    const originalFetch = globalThis.fetch;
    const graphqlRequests: Array<{ authorization?: string | null; body?: { query?: string; variables?: unknown } }> = [];
    globalThis.fetch = (async (url, init) => {
      if (String(url) !== "https://linear.example/graphql") {
        throw new Error(`Unexpected Linear test request: ${String(url)}`);
      }
      const body = JSON.parse(String(init?.body)) as { query?: string; variables?: unknown };
      graphqlRequests.push({
        authorization: init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string> | undefined)?.authorization,
        body
      });
      if (body.query?.includes("agentActivityCreate")) {
        return Response.json({ data: { agentActivityCreate: { success: true, agentActivity: { id: `activity_${graphqlRequests.length}` } } } });
      }
      return Response.json({ data: { agentSessionUpdate: { success: true } } });
    }) as typeof fetch;

    try {
      const createdPayload = {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "linear_agent_created_1",
        organizationId: "org_1",
        createdAt: "2026-07-07T00:00:00.000Z",
        webhookTimestamp: Date.now(),
        promptContext: "<issue identifier=\"ENG-1\">Demo</issue>",
        agentSession: {
          id: "agent_session_stop_1",
          creator: { id: "user_1", name: "Ada" },
          issue: {
            id: "issue_1",
            identifier: "ENG-1",
            title: "Demo",
            url: "https://linear.app/acme/issue/ENG-1/demo",
            team: { id: "team_1", key: "ENG", name: "Engineering" }
          }
        }
      };
      const createdRawBody = JSON.stringify(createdPayload);
      const created = await app.request("/linear/webhooks/install_agent_stop", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody: createdRawBody })
        },
        body: createdRawBody
      });

      expect(created.status).toBe(200);
      const createdBody = await created.json();
      const runId = String(createdBody.runId);
      expect(runId).toMatch(/^run_/);

      await app.request("/v1/runners/runner_1/claim", { method: "POST" });
      await app.request(`/v1/runners/runner_1/runs/${runId}/running`, jsonRequest({ executor: "echo" }));
      const followUp = await app.request(
        "/v1/runs",
        jsonRequest({
          runId: "follow_up_linear_agent_stop",
          event: {
            ...linearIssueEvent({ id: "evt_linear_agent_stop_follow_up", sourceEventId: "linear_agent_stop_follow_up" }),
            callback: {
              provider: "linear",
              uri: "linear://agent-session/agent_session_stop_1/activities",
              threadKey: "ENG|issue|ENG-1"
            },
            metadata: {
              repoProvider: "github",
              owner: "acme",
              repo: "demo",
              agentSessionId: "agent_session_stop_1",
              linearRelayInstallationId: "install_agent_stop",
              graphqlUrl: "https://linear.example/graphql"
            }
          }
        })
      );
      expect(followUp.status).toBe(202);
      graphqlRequests.length = 0;

      const stopPayload = {
        type: "AgentSessionEvent",
        action: "prompted",
        webhookId: "linear_agent_stop_1",
        organizationId: "org_1",
        createdAt: "2026-07-07T00:00:01.000Z",
        webhookTimestamp: Date.now(),
        agentActivity: {
          id: "activity_stop_1",
          body: "Stop",
          signal: "stop"
        },
        agentSession: createdPayload.agentSession
      };
      const stopRawBody = JSON.stringify(stopPayload);
      const stopped = await app.request("/linear/webhooks/install_agent_stop", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody: stopRawBody })
        },
        body: stopRawBody
      });

      expect(stopped.status).toBe(200);
      await expect(stopped.json()).resolves.toEqual({ ok: true, action: "stop" });
      const stored = await app.request(`/v1/runs/${runId}`);
      await expect(stored.json()).resolves.toMatchObject({
        run: {
          id: runId,
          status: "cancelled",
          result: { conclusion: "cancelled" }
        }
      });
      const queuedFollowUp = await app.request("/v1/follow-up-requests/follow_up_linear_agent_stop");
      await expect(queuedFollowUp.json()).resolves.toMatchObject({
        followUpRequest: {
          id: "follow_up_linear_agent_stop",
          status: "queued"
        }
      });
      expect(graphqlRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authorization: "lin_api_token",
            body: expect.objectContaining({ query: expect.stringContaining("agentSessionUpdate") })
          }),
          expect.objectContaining({
            authorization: "lin_api_token",
            body: expect.objectContaining({
              query: expect.stringContaining("agentActivityCreate"),
              variables: expect.objectContaining({
                input: expect.objectContaining({
                  agentSessionId: "agent_session_stop_1",
                  content: expect.objectContaining({
                    type: "response",
                    body: expect.stringContaining("Cancellation requested for run")
                  })
                })
              })
            })
          })
        ])
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refreshes OAuth relay installations uploaded through the static relay endpoint", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      linearOAuthInstall: {
        clientId: "linear_client",
        clientSecret: "linear_secret",
        redirectUri: "https://relay.example/linear/oauth/callback",
        tokenUrl: "https://linear.example/oauth/token",
        now: () => new Date("2026-07-07T00:10:00.000Z"),
        refreshSkewMs: 0,
        commentRunDeferMs: 0
      }
    });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Runner 1" }));
    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    );
    const stored = await app.request(
      "/v1/linear-relay-installations",
      jsonRequest({
        id: "install_oauth",
        webhookPath: "/linear/webhooks/install_oauth",
        webhookSecret: "linear_webhook_secret",
        token: "linear_access_old",
        auth: {
          method: "oauth_app",
          actor: "app",
          clientId: "linear_client",
          refreshToken: "linear_refresh_old",
          accessTokenExpiresAt: "2026-07-07T00:00:00.000Z",
          scopes: ["read", "comments:create"]
        },
        graphqlUrl: "https://linear.example/graphql",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    );
    expect(stored.status).toBe(201);
    const storedBody = await stored.json();
    expect(JSON.stringify(storedBody)).not.toContain("linear_access_old");
    expect(JSON.stringify(storedBody)).not.toContain("linear_refresh_old");

    const originalFetch = globalThis.fetch;
    const tokenRequests: Array<Record<string, string>> = [];
    const graphqlRequests: Array<{ authorization?: string | null; body?: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl === "https://linear.example/oauth/token") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        tokenRequests.push(Object.fromEntries(body.entries()));
        return Response.json({
          access_token: "linear_access_refreshed",
          refresh_token: "linear_refresh_new",
          expires_in: 3600,
          scope: "read,comments:create"
        });
      }
      if (requestUrl === "https://linear.example/graphql") {
        graphqlRequests.push({
          authorization: init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string> | undefined)?.authorization,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        return Response.json({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "linear_comment_1", url: "https://linear.app/acme/issue/ENG-1#comment" }
            }
          }
        });
      }
      throw new Error(`Unexpected Linear test request: ${requestUrl}`);
    }) as typeof fetch;

    try {
      const payload = {
        type: "Comment",
        action: "create",
        webhookId: "linear_delivery_oauth",
        organizationId: "org_1",
        createdAt: "2026-07-07T00:00:00.000Z",
        webhookTimestamp: Date.now(),
        data: {
          id: "comment_1",
          body: "@opentag run dynamic oauth relay smoke",
          url: "https://linear.app/acme/issue/ENG-1/demo#comment",
          issue: {
            id: "issue_1",
            identifier: "ENG-1",
            title: "Demo",
            url: "https://linear.app/acme/issue/ENG-1/demo",
            team: { id: "team_1", key: "ENG" }
          },
          user: { id: "user_1", name: "Ada" }
        }
      };
      const rawBody = JSON.stringify(payload);
      const response = await app.request("/linear/webhooks/install_oauth", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody })
        },
        body: rawBody
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, runId: expect.any(String) });
      expect(tokenRequests).toEqual([
        {
          client_id: "linear_client",
          refresh_token: "linear_refresh_old",
          grant_type: "refresh_token",
          client_secret: "linear_secret"
        }
      ]);
      expect(graphqlRequests).toHaveLength(1);
      expect(graphqlRequests[0]).toMatchObject({
        authorization: "Bearer linear_access_refreshed"
      });
      expect(String((graphqlRequests[0]!.body as { query: string }).query)).toContain("commentCreate");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("shares claim state across relay deliveries so a mention's comment and session events yield one run", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      linearOAuthInstall: {
        clientId: "linear_client",
        clientSecret: "linear_secret",
        redirectUri: "https://relay.example/linear/oauth/callback",
        tokenUrl: "https://linear.example/oauth/token",
        now: () => new Date("2026-07-07T00:10:00.000Z"),
        refreshSkewMs: 0,
        commentRunDeferMs: 40
      }
    });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Runner 1" }));
    await app.request(
      "/v1/repo-bindings",
      jsonRequest({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" })
    );
    const stored = await app.request(
      "/v1/linear-relay-installations",
      jsonRequest({
        id: "install_dedupe",
        webhookPath: "/linear/webhooks/install_dedupe",
        webhookSecret: "linear_webhook_secret",
        token: "linear_access_fresh",
        auth: {
          method: "oauth_app",
          actor: "app",
          clientId: "linear_client",
          refreshToken: "linear_refresh_fresh",
          accessTokenExpiresAt: "2026-07-08T00:00:00.000Z"
        },
        graphqlUrl: "https://linear.example/graphql",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    );
    expect(stored.status).toBe(201);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      if (String(url) === "https://linear.example/graphql") {
        return Response.json({
          data: {
            agentSessionUpdate: { success: true },
            agentActivityCreate: { success: true, agentActivity: { id: "activity_ack_1" } }
          }
        });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }) as typeof fetch;

    try {
      const issue = {
        id: "issue_1",
        identifier: "ENG-1",
        title: "Demo",
        url: "https://linear.app/acme/issue/ENG-1/demo",
        team: { id: "team_1", key: "ENG" }
      };
      const commentBody = JSON.stringify({
        type: "Comment",
        action: "create",
        webhookId: "webhook_constant",
        organizationId: "org_1",
        createdAt: "2026-07-07T00:10:00.000Z",
        webhookTimestamp: Date.now(),
        data: {
          id: "comment_mention_dedupe",
          body: "@opentag run relay dedupe smoke",
          url: "https://linear.app/acme/issue/ENG-1/demo#comment",
          issue,
          user: { id: "user_1", name: "Ada" }
        }
      });
      const sessionBody = JSON.stringify({
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "webhook_constant",
        organizationId: "org_1",
        createdAt: "2026-07-07T00:10:00.000Z",
        webhookTimestamp: Date.now(),
        agentSession: {
          id: "agent_session_dedupe",
          commentId: "comment_mention_dedupe",
          creator: { id: "user_1", name: "Ada" },
          comment: { id: "comment_mention_dedupe", body: "@opentag run relay dedupe smoke" },
          issue
        }
      });

      const commentResponse = await app.request("/linear/webhooks/install_dedupe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody: commentBody })
        },
        body: commentBody
      });
      await expect(commentResponse.json()).resolves.toEqual({ ok: true, deferred: true });

      const sessionResponse = await app.request("/linear/webhooks/install_dedupe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody: sessionBody })
        },
        body: sessionBody
      });
      const sessionResult = (await sessionResponse.json()) as { runId?: string };
      expect(sessionResult.runId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 90));

      const firstClaim = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
      expect(firstClaim.status).toBe(200);
      const firstClaimBody = (await firstClaim.json()) as { run: { id: string } };
      expect(firstClaimBody.run.id).toBe(sessionResult.runId);

      const secondClaim = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
      expect(secondClaim.status).toBe(204);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("deduplicates concurrent OAuth relay installation refreshes into a single token request", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      linearOAuthInstall: {
        clientId: "linear_client",
        clientSecret: "linear_secret",
        redirectUri: "https://relay.example/linear/oauth/callback",
        tokenUrl: "https://linear.example/oauth/token",
        now: () => new Date("2026-07-07T00:10:00.000Z"),
        refreshSkewMs: 0,
        commentRunDeferMs: 0
      }
    });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Runner 1" }));
    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    );
    const stored = await app.request(
      "/v1/linear-relay-installations",
      jsonRequest({
        id: "install_oauth",
        webhookPath: "/linear/webhooks/install_oauth",
        webhookSecret: "linear_webhook_secret",
        token: "linear_access_old",
        auth: {
          method: "oauth_app",
          actor: "app",
          clientId: "linear_client",
          refreshToken: "linear_refresh_old",
          accessTokenExpiresAt: "2026-07-07T00:00:00.000Z",
          scopes: ["read", "comments:create"]
        },
        graphqlUrl: "https://linear.example/graphql",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    );
    expect(stored.status).toBe(201);

    const originalFetch = globalThis.fetch;
    const tokenRequests: Array<Record<string, string>> = [];
    const graphqlAuthorizations: Array<string | null | undefined> = [];
    globalThis.fetch = (async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl === "https://linear.example/oauth/token") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        tokenRequests.push(Object.fromEntries(body.entries()));
        await new Promise((resolve) => setTimeout(resolve, 100));
        return Response.json({
          access_token: "linear_access_refreshed",
          refresh_token: "linear_refresh_new",
          expires_in: 3600,
          scope: "read,comments:create"
        });
      }
      if (requestUrl === "https://linear.example/graphql") {
        graphqlAuthorizations.push(
          init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string> | undefined)?.authorization
        );
        return Response.json({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "linear_comment_1", url: "https://linear.app/acme/issue/ENG-1#comment" }
            }
          }
        });
      }
      throw new Error(`Unexpected Linear test request: ${requestUrl}`);
    }) as typeof fetch;

    try {
      const webhookRequest = (input: { webhookId: string; commentId: string }) => {
        const rawBody = JSON.stringify({
          type: "Comment",
          action: "create",
          webhookId: input.webhookId,
          organizationId: "org_1",
          createdAt: "2026-07-07T00:00:00.000Z",
          webhookTimestamp: Date.now(),
          data: {
            id: input.commentId,
            body: "@opentag run concurrent oauth refresh smoke",
            url: `https://linear.app/acme/issue/ENG-1/demo#${input.commentId}`,
            issue: {
              id: "issue_1",
              identifier: "ENG-1",
              title: "Demo",
              url: "https://linear.app/acme/issue/ENG-1/demo",
              team: { id: "team_1", key: "ENG" }
            },
            user: { id: "user_1", name: "Ada" }
          }
        });
        return app.request("/linear/webhooks/install_oauth", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody })
          },
          body: rawBody
        });
      };

      const [first, second] = await Promise.all([
        webhookRequest({ webhookId: "linear_delivery_concurrent_1", commentId: "comment_concurrent_1" }),
        webhookRequest({ webhookId: "linear_delivery_concurrent_2", commentId: "comment_concurrent_2" })
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(tokenRequests).toEqual([
        {
          client_id: "linear_client",
          refresh_token: "linear_refresh_old",
          grant_type: "refresh_token",
          client_secret: "linear_secret"
        }
      ]);
      expect(graphqlAuthorizations).toHaveLength(2);
      expect(graphqlAuthorizations).toEqual(["Bearer linear_access_refreshed", "Bearer linear_access_refreshed"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records management audit events for repo policy and mutation mapping changes without rule details", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request(
      "/v1/repo-bindings/github/acme/demo/policy-rules",
      jsonRequest({
        rule: {
          id: "repo_allows_labels",
          scope: "work_context_owner_container",
          effect: "allow",
          capabilityId: "set_labels",
          reason: "Internal audit detail that should not be copied into control-plane event payloads."
        }
      })
    );
    await app.request(
      "/v1/repo-bindings/github/acme/demo/mutation-mappings",
      jsonRequest({
        mapping: {
          id: "github_status_labels",
          adapter: "github",
          domain: "status",
          strategy: "label",
          values: { blocked: "status/blocked-internal-label" },
          description: "Internal mapping detail that should stay in the mapping record."
        }
      })
    );

    const audit = await app.request("/v1/control-plane-events?limit=20");
    const { events } = await audit.json();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "binding.repository.policy_rule.upserted",
          subject: "github:acme/demo:repo_allows_labels",
          payload: {
            provider: "github",
            owner: "acme",
            repo: "demo",
            ruleId: "repo_allows_labels",
            scope: "work_context_owner_container",
            effect: "allow",
            capabilityId: "set_labels",
            hasReason: true
          }
        }),
        expect.objectContaining({
          type: "binding.repository.mutation_mapping.upserted",
          subject: "github:acme/demo:github_status_labels",
          payload: {
            provider: "github",
            owner: "acme",
            repo: "demo",
            mappingId: "github_status_labels",
            adapter: "github",
            domain: "status",
            strategy: "label",
            valueCount: 1,
            hasDescription: true
          }
        })
      ])
    );
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("Internal audit detail");
    expect(serializedEvents).not.toContain("status/blocked-internal-label");
    expect(serializedEvents).not.toContain("Internal mapping detail");
  });

  it("delivers acknowledgement, human progress, and final callback messages with audit events", async () => {
    const delivered: { kind: string; body: string; blocks?: unknown[] }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body, ...(message.blocks?.length ? { blocks: message.blocks } : {}) });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    });
    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_2", event: { ...validEvent, id: "evt_2", sourceEventId: "comment_2" } })
    });
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_2/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "milestone.progress", message: "running tests", at: "2026-06-24T00:00:01.000Z", visibility: "human" })
    });
    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_2/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { conclusion: "success", summary: "done" } })
    });
    expect(completeResponse.status).toBe(200);

    const getResponse = await app.request("/v1/runs/run_2");
    const stored = await getResponse.json();
    expect(stored.run.status).toBe("succeeded");
    expect(stored.run.result.summary).toBe("done");
    expect(delivered).toEqual([
      { kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_2`" },
      { kind: "progress", body: "OpenTag progress for `run_2`: running tests" },
      { kind: "final", body: "OpenTag finished with **success**.\n\ndone" }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_2/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "agent_access_profile.captured",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "routing.decided",
      "run.claimed",
      "run.progress",
      "callback.progress.queued",
      "callback.progress.delivered",
      "run.completed",
      "callback.final.queued",
      "callback.final.delivered"
    ]);
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      visibility: "human",
      importance: "normal",
      message: "running tests"
    });
    expect(events.find((event: { type: string }) => event.type === "admission.decided")).toMatchObject({
      visibility: "audit",
      importance: "normal"
    });
    expect(events.find((event: { type: string }) => event.type === "context_packet.generated")).toMatchObject({
      visibility: "audit",
      importance: "normal"
    });
    expect(events.find((event: { type: string }) => event.type === "callback.final.delivered")).toMatchObject({
      visibility: "human",
      importance: "high"
    });
  });

  it("keeps default audit progress out of source-thread callbacks", async () => {
    const delivered: { kind: string; body: string }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    });
    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_audit_progress", event: { ...validEvent, id: "evt_audit_progress", sourceEventId: "comment_audit_progress" } })
    });
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const progressResponse = await app.request("/v1/runners/runner_1/runs/run_audit_progress/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "executor.progress", message: "internal tool detail", at: "2026-06-24T00:00:01.000Z" })
    });
    expect(progressResponse.status).toBe(200);

    expect(delivered).toEqual([{ kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_audit_progress`" }]);

    const eventsResponse = await app.request("/v1/runs/run_audit_progress/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "agent_access_profile.captured",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "routing.decided",
      "run.claimed",
      "run.progress"
    ]);
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      visibility: "audit",
      importance: "normal",
      message: "internal tool detail"
    });
  });

  it("keeps hook-ingest progress aliases audit-only by default", async () => {
    const delivered: { kind: string; body: string }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo",
      allowedActors: ["ou_sender"]
    }));
    await bindSourceChannel(app, larkRepoEvent({ id: "evt_hook_binding", sourceEventId: "msg_hook_binding" }));
    const createResponse = await app.request("/v1/runs", jsonRequest({
      runId: "run_hook_ingest_progress",
      event: larkRepoEvent({ id: "evt_hook_ingest_progress", sourceEventId: "msg_hook_ingest_progress" })
    }));
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const progressBody = {
      type: "ingest.hermes.post_llm_call",
      message: "Hermes post_llm_call completed.",
      at: "2026-06-24T00:00:01.000Z",
      idempotencyKey: "hermes:run_hook_ingest_progress:progress:post_llm_call"
    };
    const progressResponse = await app.request(
      "/v1/runners/runner_1/runs/run_hook_ingest_progress/progress",
      jsonRequest(progressBody)
    );
    const replayResponse = await app.request(
      "/v1/runners/runner_1/runs/run_hook_ingest_progress/progress",
      jsonRequest({ ...progressBody, message: "retry should stay invisible" })
    );
    expect(progressResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toEqual({ ok: true, replayed: true });

    expect(delivered.filter((message) => message.kind === "progress")).toEqual([]);

    const eventsResponse = await app.request("/v1/runs/run_hook_ingest_progress/events");
    const { events } = await eventsResponse.json();
    const progressEvents = events.filter((event: { type: string }) => event.type === "run.progress");
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]).toMatchObject({
      visibility: "audit",
      importance: "normal",
      message: "Hermes post_llm_call completed.",
      payload: expect.objectContaining({
        type: "ingest.hermes.post_llm_call"
      })
    });
    expect(progressEvents[0].payload).not.toHaveProperty("idempotencyKey");
    expect(events.some((event: { type: string }) => event.type.startsWith("callback.progress."))).toBe(false);
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("retry should stay invisible");
    expect(serializedEvents).not.toContain(progressBody.idempotencyKey);
    expect(serializedEvents).not.toContain("[redacted]");
  });

  it("requires runner-scoped progress and completion after claim", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Runner One" })
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_scoped_1", event: { ...validEvent, id: "evt_scoped_1", sourceEventId: "comment_scoped_1" } })
    });

    const deprecatedProgress = await app.request("/v1/runs/run_scoped_1/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "executor.progress", message: "running tests" })
    });
    expect(deprecatedProgress.status).toBe(410);

    const deprecatedComplete = await app.request("/v1/runs/run_scoped_1/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { conclusion: "success", summary: "done" } })
    });
    expect(deprecatedComplete.status).toBe(410);
  });

  it("records duplicate source-event admission as an idempotent replay", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Runner One" })
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const first = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_dup_a", event: { ...validEvent, id: "evt_dup_a", sourceEventId: "comment_dup_a" } })
    });
    expect(first.status).toBe(201);

    const replay = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_dup_b", event: { ...validEvent, id: "evt_dup_a", sourceEventId: "comment_dup_a" } })
    });
    expect(replay.status).toBe(200);
    const replayJson = await replay.json();
    expect(replayJson.idempotentReplay).toBe(true);
    expect(replayJson.run.id).toBe("run_dup_a");

    const eventsResponse = await app.request("/v1/runs/run_dup_a/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("admission.decided");
    expect(events.map((event: { type: string }) => event.type)).toContain("run.create_idempotent_replay");
  });

  it("replays duplicate source delivery ids even when event ids differ", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Runner One" })
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const first = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_delivery_a",
        event: {
          ...validEvent,
          id: "evt_delivery_a",
          sourceEventId: "comment_delivery_a",
          metadata: { ...validEvent.metadata, sourceDeliveryId: "delivery_replay_1", webhookSignatureVerified: true }
        }
      })
    );
    expect(first.status).toBe(201);

    const replay = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_delivery_b",
        event: {
          ...validEvent,
          id: "evt_delivery_b",
          sourceEventId: "comment_delivery_b",
          metadata: { ...validEvent.metadata, sourceDeliveryId: "delivery_replay_1", webhookSignatureVerified: true }
        }
      })
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      decision: {
        action: "drop_duplicate",
        reasonCode: "duplicate_source_delivery",
        activeRunId: "run_delivery_a"
      },
      run: { id: "run_delivery_a" },
      idempotentReplay: true
    });

    const eventsResponse = await app.request("/v1/runs/run_delivery_a/events");
    const { events } = await eventsResponse.json();
    expect(events.find((event: { type: string }) => event.type === "run.create_idempotent_replay")?.payload).toMatchObject({
      replayKey: { kind: "source_delivery", source: "github", deliveryId: "delivery_replay_1" },
      provenance: {
        sourceEventId: "comment_delivery_b",
        sourceDeliveryId: "delivery_replay_1",
        signatureState: "verified",
        admissionDecision: { reasonCode: "duplicate_source_delivery" }
      }
    });
  });

  it("returns 404 when promoting a missing follow-up request", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/follow-up-requests/missing/create-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_missing_follow_up" })
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "follow_up_request_not_found" });
  });

  it("returns 409 when promoting a follow-up request that is no longer queued", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_active_for_promote", event: { ...validEvent, id: "evt_active_for_promote", sourceEventId: "comment_active_for_promote" } })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "follow_up_for_promote", event: { ...validEvent, id: "evt_follow_up_for_promote", sourceEventId: "comment_follow_up_for_promote" } })
    });

    const first = await app.request("/v1/follow-up-requests/follow_up_for_promote/create-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_promoted_once" })
    });
    expect(first.status).toBe(201);

    const second = await app.request("/v1/follow-up-requests/follow_up_for_promote/create-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_promoted_twice" })
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: "follow_up_request_not_queued" });
  });

  it("renders Slack callbacks with Slack mrkdwn and keeps progress audit-only", async () => {
    const delivered: { kind: string; body: string; blocks?: unknown[]; statusMessageKey?: string }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.blocks?.length ? { blocks: message.blocks } : {}),
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
          return { handled: true, outcome: "accepted", externalMessageId: message.externalMessageId ?? "slack_status_1" } as const;
        }
      },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const slackEvent = {
      ...validEvent,
      id: "evt_slack_1",
      source: "slack",
      sourceEventId: "Ev123",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      permissions: [{ scope: "chat:postMessage", reason: "reply in thread" }],
      metadata: { ...validEvent.metadata, teamId: "T123", channelId: "C123", channelApplicationId: "A123", channelBotId: "U_APP" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      }
    };
    await bindSourceChannel(app, slackEvent);

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_slack_1", event: slackEvent })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const runningResponse = await app.request("/v1/runners/runner_1/runs/run_slack_1/running", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executor: "hermes" })
    });
    expect(runningResponse.status).toBe(200);
    const progressResponse = await app.request("/v1/runners/runner_1/runs/run_slack_1/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "executor.progress",
        message: "Hermes tool call started",
        at: "2026-06-24T00:00:01.000Z",
        visibility: "human"
      })
    });
    expect(progressResponse.status).toBe(200);
    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_slack_1/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "success",
          summary: "Echoed OpenTag command: introduce yourself",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      })
    });
    expect(completeResponse.status).toBe(200);

    expect(delivered.map(({ kind, statusMessageKey }) => ({ kind, statusMessageKey }))).toEqual([
      { kind: "progress", statusMessageKey: "run_slack_1:status" },
      { kind: "final", statusMessageKey: "run_slack_1:status" }
    ]);
    expect(delivered[0]?.body).toContain("*OpenTag: Running*");
    expect(delivered[0]?.body).toContain("Running with hermes.");
    expect(delivered[1]?.body).toBe(
      "*Finished: success.*\nEchoed OpenTag command: introduce yourself\nVerified: `echo` passed\n\nAudit: `opentag status --run run_slack_1`"
    );
    expect(delivered.some((message) => message.body.includes("Hermes tool call started"))).toBe(false);
    expect(delivered.every((message) => (message as { agentId?: string }).agentId === undefined)).toBe(true);
    expect(delivered.at(-1)?.body).not.toContain("**success**");

    const eventsResponse = await app.request("/v1/runs/run_slack_1/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).not.toContain("callback.progress.suppressed");
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      visibility: "audit",
      importance: "normal",
      message: "Hermes tool call started"
    });
  });

  it("sanitizes every runner-controlled sibling field before persistence or presentation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-safe-runner-ingress-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "dispatcher.sqlite");
    const delivered: unknown[] = [];
    const app = createDispatcherApp({
      databasePath,
      runnerLeaseSeconds: 60,
      callbackSink: {
        async deliver(message) {
          delivered.push(message);
          return { handled: true, outcome: "accepted", externalMessageId: "safe-status" } as const;
        }
      },
      sourceReceiptSink: { async deliver() { return { delivered: true }; } }
    });
    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_safe_ingress",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const event = slackRepoEvent({
      id: "evt_safe_runner_ingress",
      sourceEventId: "EvSafeRunnerIngress",
      threadKey: "T123|C123|1710000000.000100"
    });
    await bindSourceChannel(app, event);
    expect((await app.request("/v1/runs", jsonRequest({ runId: "run_safe_runner_ingress", event }))).status).toBe(201);
    const firstClaim = await app.request("/v1/runners/runner_safe_ingress/claim", { method: "POST" });
    const firstLease = await firstClaim.json() as { attemptId: string; fencingToken: string };
    expireRunnerLease(databasePath, "run_safe_runner_ingress", firstLease.attemptId);
    const secondClaim = await app.request("/v1/runners/runner_safe_ingress/claim", { method: "POST" });
    const lease = await secondClaim.json() as { attemptId: string; fencingToken: string };

    expect((await app.request("/v1/runners/runner_safe_ingress/runs/run_safe_runner_ingress/running", jsonRequest({
      ...lease,
      executor: firstLease.fencingToken,
      executorCapability: { nested: { historicalFence: firstLease.fencingToken, accessToken: "opaque-ingress-token" } },
      idempotencyKey: firstLease.fencingToken
    }))).status).toBe(200);
    expect((await app.request("/v1/runners/runner_safe_ingress/runs/run_safe_runner_ingress/progress", jsonRequest({
      ...lease,
      message: `safe progress ${firstLease.fencingToken}`,
      type: firstLease.fencingToken,
      visibility: "human",
      idempotencyKey: firstLease.fencingToken
    }))).status).toBe(200);
    expect((await app.request("/v1/runners/runner_safe_ingress/runs/run_safe_runner_ingress/complete", jsonRequest({
      ...lease,
      result: {
        conclusion: "success",
        summary: `safe completion ${firstLease.fencingToken}`,
        artifacts: [{ title: "result", uri: "workspace/result.md", metadata: { historicalFence: firstLease.fencingToken } }],
        verification: [{ command: "verify", outcome: "passed", excerpt: firstLease.fencingToken }]
      },
      idempotencyKey: firstLease.fencingToken
    }))).status).toBe(200);

    const run = await (await app.request("/v1/runs/run_safe_runner_ingress")).json();
    const events = await (await app.request("/v1/runs/run_safe_runner_ingress/events")).json();
    const durableAndPresented = JSON.stringify({ run, events, delivered });
    expect(durableAndPresented).not.toContain(firstLease.fencingToken);
    expect(durableAndPresented).not.toContain(lease.fencingToken);
    expect(durableAndPresented).not.toContain("opaque-ingress-token");
    expect(durableAndPresented).toContain("[redacted]");
  });

  it("delivers Slack source receipts and one running run-card update", async () => {
    const callbacks: { kind: string }[] = [];
    const receipts: Array<{ runId: string; provider: string; state: string; agentId?: string; channelId: unknown; messageTs: unknown }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          callbacks.push({ kind: message.kind });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      sourceReceiptSink: {
        async deliver(receipt) {
          receipts.push({
            runId: receipt.runId,
            provider: receipt.provider,
            state: receipt.state,
            ...(receipt.agentId ? { agentId: receipt.agentId } : {}),
            channelId: receipt.event.metadata["channelId"],
            messageTs: receipt.event.metadata["messageTs"]
          });
          return { delivered: true };
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = slackRepoEvent({ id: "evt_slack_receipt", sourceEventId: "EvSlackReceipt", threadKey: "T123|C123|1710000000.000100" });
    await bindSourceChannel(app, event);
    const createResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_slack_receipt", event }));
    expect(createResponse.status).toBe(201);

    const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(claimResponse.status).toBe(200);
    const runningResponse = await app.request("/v1/runners/runner_1/runs/run_slack_receipt/running", jsonRequest({ executor: "echo" }));
    expect(runningResponse.status).toBe(200);

    const replayResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_slack_receipt_replay", event }));
    expect(replayResponse.status).toBe(200);

    expect(callbacks).toEqual([{ kind: "progress" }]);
    expect(receipts).toEqual([
      {
        runId: "run_slack_receipt",
        provider: "slack",
        state: "received",
        agentId: "opentag",
        channelId: "C123",
        messageTs: "1710000000.000100"
      },
      {
        runId: "run_slack_receipt",
        provider: "slack",
        state: "running",
        agentId: "opentag",
        channelId: "C123",
        messageTs: "1710000000.000100"
      }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_slack_receipt/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "agent_access_profile.captured",
      "source_receipt.delivered",
      "routing.decided",
      "run.claimed",
      "run.running",
      "source_receipt.delivered",
      "callback.progress.queued",
      "callback.progress.delivered",
      "admission.decided",
      "run.create_idempotent_replay"
    ]);
    expect(
      events
        .filter((event: { type: string }) => event.type === "source_receipt.delivered")
        .map((event: { visibility: string; importance: string; payload: { provider: string; state: string } }) => ({
          visibility: event.visibility,
          importance: event.importance,
          payload: event.payload
        }))
    ).toEqual([
      {
        visibility: "audit",
        importance: "low",
        payload: {
          provider: "slack",
          state: "received"
        }
      },
      {
        visibility: "audit",
        importance: "low",
        payload: {
          provider: "slack",
          state: "running"
        }
      }
    ]);
  });

  it("falls back to a Slack text acknowledgement when the source receipt is not delivered", async () => {
    const callbacks: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          callbacks.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = slackRepoEvent({ id: "evt_slack_receipt_fallback", sourceEventId: "EvSlackReceiptFallback", threadKey: "T123|C123|1710000000.000100" });
    await bindSourceChannel(app, event);
    const createResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_slack_receipt_fallback", event }));
    expect(createResponse.status).toBe(201);
    expect(callbacks).toEqual([
      {
        kind: "acknowledgement",
        body: "*OpenTag: Received*\nRun: `run_slack_receipt_fallback`"
      }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_slack_receipt_fallback/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "agent_access_profile.captured",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered"
    ]);
  });

  it("delivers Lark received source receipts without posting received cards", async () => {
    const callbacks: { kind: string }[] = [];
    const receipts: Array<{ runId: string; provider: string; state: string; chatId: unknown; messageId: unknown }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          callbacks.push({ kind: message.kind });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      sourceReceiptSink: {
        async deliver(receipt) {
          receipts.push({
            runId: receipt.runId,
            provider: receipt.provider,
            state: receipt.state,
            chatId: receipt.event.metadata["chatId"],
            messageId: receipt.event.metadata["messageId"]
          });
          return { delivered: true };
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_receipt", sourceEventId: "EvLarkReceipt" });
    await bindSourceChannel(app, event);
    const createResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_lark_receipt", event }));
    expect(createResponse.status).toBe(201);

    expect(callbacks).toEqual([]);
    expect(receipts).toEqual([
      {
        runId: "run_lark_receipt",
        provider: "lark",
        state: "received",
        chatId: "oc_chat",
        messageId: "om_msg"
      }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_lark_receipt/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "agent_access_profile.captured",
      "source_receipt.delivered"
    ]);
  });

  it("falls back to a Lark received card when the source receipt is not delivered", async () => {
    const callbacks: Array<{ kind: string; hasRich?: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          callbacks.push({ kind: message.kind, ...(message.rich ? { hasRich: true } : {}) });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_receipt_fallback", sourceEventId: "EvLarkReceiptFallback" });
    await bindSourceChannel(app, event);
    const createResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_lark_receipt_fallback", event }));
    expect(createResponse.status).toBe(201);
    expect(callbacks).toEqual([{ kind: "acknowledgement", hasRich: true }]);
  });

  it("updates the native Lark run card even when the run finishes before the legacy delay", async () => {
    const delivered: Array<{ kind: string; statusMessageKey?: string; externalMessageId?: string; hasRich?: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      larkStatusCards: { delayMs: 20 },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
            ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
            ...(message.rich ? { hasRich: true } : {})
          });
          return { handled: true, outcome: "accepted", externalMessageId: message.externalMessageId ?? "om_final" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_short_status_card", sourceEventId: "EvLarkShortStatusCard" });
    await bindSourceChannel(app, event);
    expect((await app.request("/v1/runs", jsonRequest({ runId: "run_lark_short_status_card", event }))).status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(
      (await app.request("/v1/runners/runner_1/runs/run_lark_short_status_card/running", jsonRequest({ executor: "codex" }))).status
    ).toBe(200);
    expect(
      (await app.request("/v1/runners/runner_1/runs/run_lark_short_status_card/complete", jsonRequest({
        result: {
          conclusion: "success",
          summary: "Done quickly.",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      }))).status
    ).toBe(200);

    await wait(40);

    expect(delivered).toEqual([
      {
        kind: "progress",
        statusMessageKey: "run_lark_short_status_card:status",
        hasRich: true
      },
      {
        kind: "final",
        statusMessageKey: "run_lark_short_status_card:status",
        externalMessageId: "om_final",
        hasRich: true
      }
    ]);
  });

  it("creates a delayed Lark status card for long runs and patches final into the same message", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string; externalMessageId?: string; hasRich?: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      larkStatusCards: { delayMs: 10, minUpdateIntervalMs: 50 },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
            ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
            ...(message.rich ? { hasRich: true } : {})
          });
          return { handled: true, outcome: "accepted", externalMessageId: message.externalMessageId ?? "om_status" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_delayed_status_card", sourceEventId: "EvLarkDelayedStatusCard" });
    await bindSourceChannel(app, event);
    expect((await app.request("/v1/runs", jsonRequest({ runId: "run_lark_delayed_status_card", event }))).status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(
      (await app.request("/v1/runners/runner_1/runs/run_lark_delayed_status_card/running", jsonRequest({ executor: "codex" }))).status
    ).toBe(200);

    await wait(30);

    expect(delivered).toEqual([
      {
        kind: "progress",
        body: ["Running with codex.", "Run: run_lark_delayed_status_card", "Use /status here for details."].join("\n"),
        statusMessageKey: "run_lark_delayed_status_card:status",
        hasRich: true
      }
    ]);

    expect(
      (await app.request("/v1/runners/runner_1/runs/run_lark_delayed_status_card/complete", jsonRequest({
        result: {
          conclusion: "success",
          summary: "Done after status.",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      }))).status
    ).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "progress",
        body: ["Running with codex.", "Run: run_lark_delayed_status_card", "Use /status here for details."].join("\n"),
        statusMessageKey: "run_lark_delayed_status_card:status",
        hasRich: true
      },
      {
        kind: "final",
        body: expect.stringContaining("Finished with success."),
        statusMessageKey: "run_lark_delayed_status_card:status",
        externalMessageId: "om_status",
        hasRich: true
      }
    ]);
  });

  it("keeps routine executor progress audit-only after the Lark run card is visible", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string; externalMessageId?: string; hasRich?: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      larkStatusCards: { delayMs: 10, minUpdateIntervalMs: 1_000 },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
            ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
            ...(message.rich ? { hasRich: true } : {})
          });
          return { handled: true, outcome: "accepted", externalMessageId: message.externalMessageId ?? "om_status" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_progress_status_card", sourceEventId: "EvLarkProgressStatusCard" });
    await bindSourceChannel(app, event);
    expect((await app.request("/v1/runs", jsonRequest({ runId: "run_lark_progress_status_card", event }))).status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_lark_progress_status_card/running", jsonRequest({ executor: "codex" }));
    await wait(30);
    expect(delivered).toHaveLength(1);
    await wait(10);

    expect((await app.request("/v1/runners/runner_1/runs/run_lark_progress_status_card/progress", jsonRequest({
      type: "executor.progress",
      message: "Starting ACP agent codex in scratch workspace"
    }))).status).toBe(200);
    expect((await app.request("/v1/runners/runner_1/runs/run_lark_progress_status_card/progress", jsonRequest({
      type: "executor.progress",
      message: "Still working with internal details"
    }))).status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "progress",
        body: ["Running with codex.", "Run: run_lark_progress_status_card", "Use /status here for details."].join("\n"),
        statusMessageKey: "run_lark_progress_status_card:status",
        hasRich: true
      }
    ]);
    expect(delivered.map((delivery) => delivery.body).join("\n")).not.toContain("Still working with internal details");
  });

  it("renders Lark callbacks with lightweight acknowledgement while keeping process progress audit-only", async () => {
    const delivered: { kind: string; body: string }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const larkEvent = {
      ...validEvent,
      id: "evt_lark_1",
      source: "lark",
      sourceEventId: "EvLark123",
      actor: { provider: "lark", providerUserId: "ou_123", handle: "Felix", organizationId: "tenant_123" },
      permissions: [{ scope: "chat:postMessage", reason: "reply in thread" }],
      callback: {
        provider: "lark",
        uri: "lark://im/v1/messages",
        threadKey: "tk_123|oc_chat|om_msg"
      },
      metadata: {
        ...validEvent.metadata,
        tenantKey: "tenant_123",
        chatId: "oc_chat",
        channelApplicationId: "cli_app_123",
        channelBotId: "ou_bot"
      }
    };
    await bindSourceChannel(app, larkEvent);

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_lark_1", event: larkEvent })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const runningResponse = await app.request("/v1/runners/runner_1/runs/run_lark_1/running", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executor: "echo" })
    });
    expect(runningResponse.status).toBe(200);
    const progressResponse = await app.request("/v1/runners/runner_1/runs/run_lark_1/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "executor.progress",
        message: "Echo executor started",
        at: "2026-06-24T00:00:01.000Z",
        visibility: "human"
      })
    });
    expect(progressResponse.status).toBe(200);

    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_lark_1/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "success",
          summary: "Echoed OpenTag command: introduce yourself",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      })
    });
    expect(completeResponse.status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: ["Received. OpenTag is working.", "Run: run_lark_1", "Use /status here for queue state; audit locally with opentag status --run run_lark_1."].join(
          "\n"
        )
      },
      {
        kind: "progress",
        body: ["Running with echo.", "Run: run_lark_1", "Use /status here for details."].join("\n")
      },
      {
        kind: "final",
        body: "Finished with success.\n\nEchoed OpenTag command: introduce yourself\n\nVerification\n- echo: passed\n\nAudit: opentag status --run run_lark_1"
      }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_lark_1/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "agent_access_profile.captured",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "routing.decided",
      "run.claimed",
      "run.running",
      "callback.progress.queued",
      "callback.progress.delivered",
      "run.progress",
      "run.completed",
      "callback.final.queued",
      "callback.final.delivered"
    ]);
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      visibility: "audit",
      importance: "normal",
      message: "Echo executor started"
    });
    expect(events.map((event: { type: string }) => event.type)).not.toContain("callback.progress.suppressed");
  });

  it("reuses the first Lark status message id when delivering the final card", async () => {
    const delivered: Array<{
      kind: string;
      statusMessageKey?: string;
      externalMessageId?: string;
      hasRich?: boolean;
    }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
            ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
            ...(message.rich ? { hasRich: true } : {})
          });
          return { handled: true, outcome: "accepted", externalMessageId: message.externalMessageId ?? "om_status" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const larkEvent = {
      ...validEvent,
      id: "evt_lark_status_card",
      source: "lark",
      sourceEventId: "EvLarkStatusCard",
      actor: { provider: "lark", providerUserId: "ou_123", handle: "Felix", organizationId: "tenant_123" },
      permissions: [{ scope: "chat:postMessage", reason: "reply in thread" }],
      callback: {
        provider: "lark",
        uri: "lark://im/v1/messages",
        threadKey: "tk_123|oc_chat|om_msg"
      },
      metadata: {
        ...validEvent.metadata,
        tenantKey: "tenant_123",
        chatId: "oc_chat",
        channelApplicationId: "cli_app_123",
        channelBotId: "ou_bot"
      }
    };
    await bindSourceChannel(app, larkEvent);

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_lark_status_card", event: larkEvent })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_lark_status_card/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "success",
          summary: "Done.",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      })
    });
    expect(completeResponse.status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        statusMessageKey: "run_lark_status_card:status",
        hasRich: true
      },
      {
        kind: "final",
        statusMessageKey: "run_lark_status_card:status",
        externalMessageId: "om_status",
        hasRich: true
      }
    ]);
  });

  it("records proposal approval decisions and creates apply plans", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["octocat"]
      })
    });

    const event = {
      ...validEvent,
      id: "evt_protocol",
      sourceEventId: "comment_protocol",
      permissions: [
        ...validEvent.permissions,
        { scope: "repo:write", reason: "mutate labels after approval" }
      ],
      metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 2 }
    };
    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_protocol", event })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_protocol/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "needs_human",
          summary: "Prepared proposal.",
          suggestedChanges: [
            {
              proposalId: "proposal_protocol",
              createdAt: "2026-06-24T00:00:01.000Z",
              sourceRunId: "run_protocol",
              summary: "Add bug label.",
              intents: [
                {
                  intentId: "intent_label_bug",
                  domain: "labels",
                  action: "add_label",
                  summary: "Add the bug label.",
                  params: { label: "bug" }
                }
              ]
            }
          ]
        }
      })
    });

    const proposalResponse = await app.request("/v1/proposals/proposal_protocol");
    expect(proposalResponse.status).toBe(200);
    await expect(proposalResponse.json()).resolves.toMatchObject({
      runId: "run_protocol",
      snapshot: { proposalId: "proposal_protocol" }
    });
    const lineageResponse = await app.request("/v1/proposals/proposal_protocol/lineage");
    expect(lineageResponse.status).toBe(200);
    await expect(lineageResponse.json()).resolves.toMatchObject({
      lineage: {
        entries: [{ proposalId: "proposal_protocol", intentId: "intent_label_bug", status: "current" }]
      }
    });
    const currentIntentsResponse = await app.request("/v1/proposals/proposal_protocol/current-intents");
    expect(currentIntentsResponse.status).toBe(200);
    await expect(currentIntentsResponse.json()).resolves.toMatchObject({
      intents: [{ intentId: "intent_label_bug", status: "current" }]
    });

    const approvalResponse = await app.request("/v1/proposals/proposal_protocol/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "approval_protocol",
        approvedIntentIds: ["intent_label_bug"],
        approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
        approvedAt: "2026-06-24T00:00:02.000Z",
        reason: "Maintainer approved label mutation.",
        metadata: { source: "manual_protocol_test" }
      })
    });
    expect(approvalResponse.status).toBe(201);
    await expect(approvalResponse.json()).resolves.toMatchObject({
      decision: {
        reason: "Maintainer approved label mutation.",
        metadata: { source: "manual_protocol_test" }
      }
    });

    const applyResponse = await app.request("/v1/proposals/proposal_protocol/apply-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "apply_protocol",
        approvalDecisionId: "approval_protocol",
        adapter: "github"
      })
    });
    expect(applyResponse.status).toBe(201);
    await expect(applyResponse.json()).resolves.toMatchObject({
      plan: {
        id: "apply_protocol",
        outcomes: [{ intentId: "intent_label_bug", outcome: "skipped" }]
      }
    });

    const eventsResponse = await app.request("/v1/runs/run_protocol/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining(["proposal.snapshot.created", "approval.decision.recorded", "apply_plan.created"])
    );

    const metricsResponse = await app.request("/v1/runs/run_protocol/metrics");
    expect(metricsResponse.status).toBe(200);
    await expect(metricsResponse.json()).resolves.toMatchObject({
      metrics: {
        runId: "run_protocol",
        suggestedChangesCount: 1,
        approvalDecisionCount: 1,
        applyPlanCount: 1,
        applyOutcomeCounts: { skipped: 1 }
      }
    });
    const repoMetricsResponse = await app.request("/v1/repo-bindings/github/acme/demo/metrics");
    expect(repoMetricsResponse.status).toBe(200);
    await expect(repoMetricsResponse.json()).resolves.toMatchObject({
      metrics: {
        scope: "repo",
        scopeId: "github:acme/demo",
        runCount: 1,
        suggestedChangesCount: 1
      }
    });
    const proposalAgainResponse = await app.request("/v1/proposals/proposal_protocol");
    const proposalAgain = await proposalAgainResponse.json();
    const threadId = proposalAgain.snapshot.workThread.id;
    const threadMetricsResponse = await app.request(`/v1/work-thread-metrics?threadId=${encodeURIComponent(threadId)}`);
    expect(threadMetricsResponse.status).toBe(200);
    await expect(threadMetricsResponse.json()).resolves.toMatchObject({
      metrics: {
        scope: "work_thread",
        scopeId: threadId,
        runCount: 1,
        suggestedChangesCount: 1
      }
    });
  });

  it("rejects approval decisions with overlapping approved and rejected intents", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const response = await app.request("/v1/proposals/proposal_overlap/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approvedIntentIds: ["intent_1"],
        rejectedIntentIds: ["intent_1"],
        approvedBy: { provider: "github", providerUserId: "42" }
      })
    });

    expect(response.status).toBe(400);
  });

  it("creates child runs from next action hints with lineage fields", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_parent", event: { ...validEvent, id: "evt_parent", sourceEventId: "comment_parent" } })
    });

    const childResponse = await app.request("/v1/runs/run_parent/child-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_child",
        action: {
          kind: "apply_suggested_changes",
          targetId: "proposal_parent",
          selectedIntentIds: ["intent_label_bug"]
        },
        commandText: "Apply approved label change"
      })
    });
    expect(childResponse.status).toBe(201);
    await expect(childResponse.json()).resolves.toMatchObject({
      run: {
        id: "run_child",
        parentRunId: "run_parent",
        sourceProposalId: "proposal_parent",
        triggeredByAction: {
          kind: "apply_suggested_changes",
          targetId: "proposal_parent"
        }
      }
    });

    const claimedResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const claimed = await claimedResponse.json();
    expect(claimed.run.id).toBe("run_parent");

    const parentEventsResponse = await app.request("/v1/runs/run_parent/events");
    const { events } = await parentEventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("run.child_created");
  });

  it("executes approved GitHub label and assignee apply plans when explicitly requested", async () => {
    const githubRequests: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "ghs_test",
        fetchImpl: (async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({});
        }) as typeof fetch
      }
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["octocat"]
      })
    });

    const event = {
      ...validEvent,
      id: "evt_execute",
      sourceEventId: "comment_execute",
      permissions: [...validEvent.permissions, { scope: "repo:write", reason: "mutate issue fields after approval" }],
      metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 7 }
    };
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_execute", event })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_execute/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "needs_human",
          summary: "Prepared proposal.",
          suggestedChanges: [
            {
              proposalId: "proposal_execute",
              createdAt: "2026-06-24T00:00:01.000Z",
              sourceRunId: "run_execute",
              summary: "Add bug label and assign owner.",
              intents: [
                {
                  intentId: "intent_label_bug",
                  domain: "labels",
                  action: "add_label",
                  summary: "Add the bug label.",
                  params: { label: "bug" }
                },
                {
                  intentId: "intent_assignee_alice",
                  domain: "assignee",
                  action: "set_assignee",
                  summary: "Assign the issue to Alice.",
                  params: { assignee: "alice" }
                }
              ]
            }
          ]
        }
      })
    });
    githubRequests.length = 0;
    await app.request("/v1/proposals/proposal_execute/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "approval_execute",
        approvedIntentIds: ["intent_label_bug", "intent_assignee_alice"],
        approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
        approvedAt: "2026-06-24T00:00:02.000Z"
      })
    });

    const applyResponse = await app.request("/v1/proposals/proposal_execute/apply-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "apply_execute",
        approvalDecisionId: "approval_execute",
        adapter: "github",
        execute: true
      })
    });
    expect(applyResponse.status).toBe(201);
    await expect(applyResponse.json()).resolves.toMatchObject({
      plan: {
        id: "apply_execute",
        outcomes: [
          { intentId: "intent_label_bug", outcome: "applied", externalUri: "https://github.com/acme/demo/issues/7" },
          { intentId: "intent_assignee_alice", outcome: "applied", externalUri: "https://github.com/acme/demo/issues/7" }
        ]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/7/labels",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { labels: ["bug"] }
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/7",
        method: "PATCH",
        authorization: "Bearer ghs_test",
        body: { assignees: ["alice"] }
      }
    ]);

    const storedPlanResponse = await app.request("/v1/apply-plans/apply_execute");
    await expect(storedPlanResponse.json()).resolves.toMatchObject({
      plan: {
        adapterPlan: { externalWritesExecuted: true },
        outcomes: [
          { intentId: "intent_label_bug", outcome: "applied" },
          { intentId: "intent_assignee_alice", outcome: "applied" }
        ]
      }
    });

    const eventsResponse = await app.request("/v1/runs/run_execute/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("apply_plan.executed");
  });

  it("does not persist apply plans when execution prerequisites fail", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["octocat"]
      })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_apply_prevalidation",
        event: {
          ...validEvent,
          id: "evt_apply_prevalidation",
          sourceEventId: "comment_apply_prevalidation",
          permissions: [...validEvent.permissions, { scope: "repo:write", reason: "mutate labels after approval" }],
          metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 9 }
        }
      })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_apply_prevalidation/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "needs_human",
          summary: "Prepared proposal.",
          suggestedChanges: [
            {
              proposalId: "proposal_apply_prevalidation",
              createdAt: "2026-06-24T00:00:01.000Z",
              sourceRunId: "run_apply_prevalidation",
              summary: "Add bug label.",
              intents: [
                {
                  intentId: "intent_label_bug",
                  domain: "labels",
                  action: "add_label",
                  summary: "Add the bug label.",
                  params: { label: "bug" }
                }
              ]
            }
          ]
        }
      })
    });
    await app.request("/v1/proposals/proposal_apply_prevalidation/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "approval_apply_prevalidation",
        approvedIntentIds: ["intent_label_bug"],
        approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
        approvedAt: "2026-06-24T00:00:02.000Z"
      })
    });

    const applyResponse = await app.request("/v1/proposals/proposal_apply_prevalidation/apply-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "apply_prevalidation",
        approvalDecisionId: "approval_apply_prevalidation",
        adapter: "github",
        execute: true
      })
    });
    expect(applyResponse.status).toBe(422);
    await expect(applyResponse.json()).resolves.toEqual({ error: "github_apply_not_configured" });

    const eventsResponse = await app.request("/v1/runs/run_apply_prevalidation/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).not.toContain("apply_plan.created");
  });

  it("executes approved GitHub status intents through label mappings", async () => {
    const githubRequests: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "ghs_test",
        fetchImpl: (async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({});
        }) as typeof fetch
      }
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["octocat"]
      })
    });
    await app.request("/v1/repo-bindings/github/acme/demo/mutation-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mapping: {
          id: "github_status_labels",
          adapter: "github",
          domain: "status",
          strategy: "label",
          values: { blocked: "status/blocked" }
        }
      })
    });

    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_status_mapping",
        event: {
          ...validEvent,
          id: "evt_status_mapping",
          sourceEventId: "comment_status_mapping",
          permissions: [...validEvent.permissions, { scope: "repo:write", reason: "mutate issue status after approval" }],
          metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 8 }
        }
      })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_status_mapping/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "needs_human",
          summary: "Prepared status proposal.",
          suggestedChanges: [
            {
              proposalId: "proposal_status_mapping",
              createdAt: "2026-06-24T00:00:01.000Z",
              sourceRunId: "run_status_mapping",
              summary: "Mark blocked.",
              intents: [
                {
                  intentId: "intent_status_blocked",
                  domain: "status",
                  action: "transition_status",
                  summary: "Mark blocked.",
                  params: { status: "blocked" }
                }
              ]
            }
          ]
        }
      })
    });
    await app.request("/v1/proposals/proposal_status_mapping/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "approval_status_mapping",
        approvedIntentIds: ["intent_status_blocked"],
        approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
        approvedAt: "2026-06-24T00:00:02.000Z"
      })
    });

    const applyResponse = await app.request("/v1/proposals/proposal_status_mapping/apply-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "apply_status_mapping",
        approvalDecisionId: "approval_status_mapping",
        adapter: "github",
        execute: true
      })
    });
    expect(applyResponse.status).toBe(201);
    await expect(applyResponse.json()).resolves.toMatchObject({
      plan: {
        outcomes: [{ intentId: "intent_status_blocked", outcome: "applied" }]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/8/labels",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { labels: ["status/blocked"] }
      }
    ]);
  });

  it("adds a stable statusMessageKey when progress callbacks are delivered", async () => {
    const delivered: Array<{ kind: string; statusMessageKey?: string }> = [];
    const defaultPresentation = createDefaultCallbackPresentation();
    const app = createDispatcherApp({
      databasePath: ":memory:",
      presentation: {
        ...defaultPresentation,
        shouldDeliverAcknowledgement() {
          return true;
        },
        shouldDeliverStatusUpdate(provider) {
          return provider === "slack";
        },
        shouldDeliverProgress(provider) {
          return provider === "slack";
        },
        acknowledgement({ runId }) {
          return `ack ${runId}`;
        },
        progress({ message }) {
          return `progress ${message}`;
        },
        final() {
          return { body: "final" };
        },
        render(input) {
          if (input.presentation.kind === "run_status" && input.presentation.state === "received") {
            return { body: `ack ${input.presentation.runId}` };
          }
          if (input.presentation.kind === "run_status") {
            return { body: `progress ${input.presentation.message ?? input.presentation.state}` };
          }
          if (input.presentation.kind === "final_summary") {
            return { body: "final" };
          }
          return defaultPresentation.render(input);
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });
    await bindSourceChannel(app, slackRepoEvent({
      id: "evt_status_key_binding",
      sourceEventId: "EvStatusBinding",
      threadKey: "T123|C123|1710000000.000100"
    }));

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_status_key",
        event: {
          ...validEvent,
          id: "evt_status_key",
          source: "slack",
          sourceEventId: "EvStatus",
          actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
          permissions: [{ scope: "chat:postMessage", reason: "reply in thread" }],
          callback: {
            provider: "slack",
            uri: "https://slack.com/api/chat.postMessage",
            threadKey: "T123|C123|1710000000.000100"
          },
          metadata: {
            ...validEvent.metadata,
            teamId: "T123",
            channelId: "C123",
            channelApplicationId: "A123",
            channelBotId: "U_APP"
          }
        }
      })
    });
    expect(response.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const progressResponse = await app.request("/v1/runners/runner_1/runs/run_status_key/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "milestone.progress", message: "working", at: "2026-06-24T00:00:01.000Z", visibility: "human" })
    });
    expect(progressResponse.status).toBe(200);

    expect(delivered).toEqual([
      { kind: "acknowledgement", statusMessageKey: "run_status_key:status" },
      { kind: "progress", statusMessageKey: "run_status_key:status" }
    ]);
  });

  it("uses one editable Telegram status card from acknowledgement through final", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string; externalMessageId?: string; richProvider?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
            ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
            ...(message.rich?.provider ? { richProvider: message.rich.provider } : {})
          });
          return { handled: true, outcome: "accepted", externalMessageId: message.externalMessageId ?? "100" } as const;
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );

    const response = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_telegram_status_card",
        event: {
          ...validEvent,
          id: "evt_telegram_status_card",
          source: "telegram",
          sourceEventId: "EvTelegramStatusCard",
          actor: { provider: "telegram", providerUserId: "789", handle: "alice" },
          permissions: [
            { scope: "chat:postMessage", reason: "reply in Telegram" },
            { scope: "runner:local", reason: "execute locally" }
          ],
          callback: {
            provider: "telegram",
            uri: "https://api.telegram.org/sendMessage",
            threadKey: "bot_123|-1001|789|42"
          },
          metadata: { repoProvider: "github", owner: "acme", repo: "demo", botId: "bot_123", chatId: "-1001" }
        }
      })
    );
    expect(response.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(
      (await app.request(
        "/v1/runners/runner_1/runs/run_telegram_status_card/running",
        jsonRequest({ executor: "echo" })
      )).status
    ).toBe(200);
    expect(
      (await app.request(
        "/v1/runners/runner_1/runs/run_telegram_status_card/complete",
        jsonRequest({
          result: {
            conclusion: "success",
            summary: "Echoed OpenTag command: hi",
            verification: [{ command: "echo", outcome: "passed" }]
          }
        })
      )).status
    ).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: expect.stringContaining("<b>OpenTag picked this up</b>"),
        statusMessageKey: "run_telegram_status_card:status",
        richProvider: "telegram"
      },
      {
        kind: "progress",
        body: expect.stringContaining("<b>OpenTag is working</b>"),
        statusMessageKey: "run_telegram_status_card:status",
        externalMessageId: "100",
        richProvider: "telegram"
      },
      {
        kind: "final",
        body: expect.stringContaining("<b>OpenTag finished</b>"),
        statusMessageKey: "run_telegram_status_card:status",
        externalMessageId: "100",
        richProvider: "telegram"
      }
    ]);
  });

  it("delivers a running liveness status when a status-update provider starts executing", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );

    const response = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_liveness_running",
        event: githubIssueEvent({ id: "evt_liveness_running", sourceEventId: "comment_liveness_running" })
      })
    );
    expect(response.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const runningResponse = await app.request(
      "/v1/runners/runner_1/runs/run_liveness_running/running",
      jsonRequest({ executor: "echo" })
    );
    expect(runningResponse.status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: "OpenTag picked this up. Run: `run_liveness_running`"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_liveness_running`: Running with echo.",
        statusMessageKey: "run_liveness_running:status"
      }
    ]);
  });

  it("deduplicates runner running retries by idempotency key before liveness delivery", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );
    const response = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_running_replay",
        event: githubIssueEvent({ id: "evt_running_replay", sourceEventId: "comment_running_replay" })
      })
    );
    expect(response.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const body = {
      executor: "echo",
      runTimeoutMs: 30_000,
      idempotencyKey: "runner_1:run_running_replay:running"
    };
    const first = await app.request("/v1/runners/runner_1/runs/run_running_replay/running", jsonRequest(body));
    const replay = await app.request("/v1/runners/runner_1/runs/run_running_replay/running", jsonRequest({ ...body, executor: "codex" }));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ ok: true, replayed: true });

    expect(delivered).toEqual([
      { kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_running_replay`" },
      {
        kind: "progress",
        body: "OpenTag progress for `run_running_replay`: Running with echo.",
        statusMessageKey: "run_running_replay:status"
      }
    ]);
    const eventsResponse = await app.request("/v1/runs/run_running_replay/events");
    const { events } = await eventsResponse.json();
    expect(events.filter((event: { type: string }) => event.type === "run.running")).toHaveLength(1);
    expect(events.filter((event: { type: string }) => event.type === "callback.progress.delivered")).toHaveLength(1);
    expect(events.find((event: { type: string }) => event.type === "run.running")).toMatchObject({
      payload: expect.objectContaining({
        executor: "echo",
        runTimeoutMs: 30_000,
        idempotencyKey: "runner_1:run_running_replay:running"
      })
    });
    expect(JSON.stringify(events)).not.toContain("codex");
  });

  it("materializes and links a structured escalation before a needs_human final callback", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );

    const response = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_waiting_approval",
        event: githubIssueEvent({ id: "evt_waiting_approval", sourceEventId: "comment_waiting_approval" })
      })
    );
    expect(response.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const completeResponse = await app.request(
      "/v1/runners/runner_1/runs/run_waiting_approval/complete",
      jsonRequest({
        result: {
          conclusion: "needs_human",
          summary: "Prepared approval request.",
          humanEscalationId: "runner_supplied_id_must_not_be_trusted",
          humanResolutionUnavailableReason: "Runner supplied route state must not be trusted.",
          nextAction: "Approve or reject the proposed action."
        }
      })
    );
    expect(completeResponse.status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: "OpenTag picked this up. Run: `run_waiting_approval`"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_waiting_approval`: Prepared approval request.",
        statusMessageKey: "run_waiting_approval:status"
      },
      {
        kind: "final",
        body: expect.stringContaining("OpenTag finished with **needs_human**.")
      }
    ]);
    const stored = await app.request("/v1/runs/run_waiting_approval");
    const storedBody = await stored.json() as { run: { result: { humanEscalationId?: string; humanResolutionUnavailableReason?: string } } };
    expect(storedBody.run.result.humanEscalationId).toMatch(/^escalation_/u);
    expect(storedBody.run.result.humanEscalationId).not.toBe("runner_supplied_id_must_not_be_trusted");
    expect(storedBody.run.result.humanResolutionUnavailableReason).toBeUndefined();
    const escalationId = storedBody.run.result.humanEscalationId!;
    const listed = await app.request("/v1/runs/run_waiting_approval/human-escalations");
    await expect(listed.json()).resolves.toMatchObject({
      escalations: [{ id: escalationId, runId: "run_waiting_approval", state: "open", audience: "requester" }]
    });
    const acknowledged = await app.request(
      `/v1/human-escalations/${escalationId}/acknowledge`,
      jsonRequest({ actor: { provider: "github", providerUserId: "42", handle: "octocat" } })
    );
    expect(acknowledged.status).toBe(201);
    await expect(acknowledged.json()).resolves.toMatchObject({ outcome: "acknowledged", escalation: { state: "acknowledged" } });
    const resolved = await app.request(
      `/v1/human-escalations/${escalationId}/resolve`,
      jsonRequest({
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        reason: "The missing input was supplied in the source thread."
      })
    );
    expect(resolved.status).toBe(201);
    await expect(resolved.json()).resolves.toMatchObject({
      outcome: "resolved",
      escalation: { state: "resolved", resolution: { actor: { providerUserId: "42" } } },
      resume: {
        required: true,
        reason: "The recorded resolution has no Workstream continuation policy.",
        nextAction: "Configure a governed Workstream continuation policy before requesting automatic continuation."
      }
    });
    const missingAcknowledgement = await app.request(
      "/v1/human-escalations/missing-escalation/acknowledge",
      jsonRequest({ actor: { provider: "github", providerUserId: "42" } })
    );
    expect(missingAcknowledgement.status).toBe(404);
    await expect(missingAcknowledgement.json()).resolves.toEqual({ error: "human_escalation_not_found" });
    const missingResolution = await app.request(
      "/v1/human-escalations/missing-escalation/resolve",
      jsonRequest({ actor: { provider: "github", providerUserId: "42" } })
    );
    expect(missingResolution.status).toBe(404);
    await expect(missingResolution.json()).resolves.toEqual({ error: "human_escalation_not_found" });
  });

  it("resolves a bounded needs-human option from the originating source thread", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: { async deliver(message) { delivered.push({ kind: message.kind, body: message.body }); return { handled: true, outcome: "accepted" } as const; } }
    });
    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    await app.request("/v1/runs", jsonRequest({
      runId: "run_source_resolution",
      event: githubIssueEvent({ id: "evt_source_resolution", sourceEventId: "comment_source_resolution", threadKey: "acme/demo#1" })
    }));
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const completed = await app.request(
      "/v1/runners/runner_1/runs/run_source_resolution/complete",
      jsonRequest({
        result: {
          conclusion: "needs_human",
          summary: "Choose a deployment target.",
          humanEscalation: {
            class: "missing_input",
            audience: "requester",
            summary: "Deployment target is missing.",
            reason: "The task did not specify an environment.",
            options: [
              { id: "staging", label: "Use staging", consequence: "Deploys only to staging." },
              { id: "production", label: "Use production", consequence: "Requires production policy review." }
            ],
            dedupeKey: "deployment-target:v1"
          }
        }
      })
    );
    expect(completed.status).toBe(200);
    const stored = await app.request("/v1/runs/run_source_resolution");
    const storedBody = await stored.json() as { run: { result: { humanEscalationId: string } } };
    const escalationId = storedBody.run.result.humanEscalationId;
    delivered.length = 0;

    const resolved = await app.request("/v1/thread-actions", jsonRequest({
      rawText: `@opentag /resolve ${escalationId} --option staging --reason Use the bounded target`,
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 1 }
    }));

    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({
      outcome: "resolved",
      escalation: { id: escalationId, state: "resolved", resolution: { optionId: "staging", actor: { providerUserId: "42" } } },
      resume: {
        required: true,
        reason: "The recorded resolution has no Workstream continuation policy.",
        nextAction: "Configure a governed Workstream continuation policy before requesting automatic continuation."
      }
    });
    expect(delivered.some((message) => message.body.includes(`Resolved human escalation ${escalationId} with Use staging.`))).toBe(true);
    expect(delivered.some((message) => message.body.includes("The recorded resolution has no Workstream continuation policy"))).toBe(true);
    expect(delivered.some((message) => message.body.includes("Configure a governed Workstream continuation policy"))).toBe(true);
    expect(delivered.some((message) => message.body.includes("Send a new task"))).toBe(false);
  });

  it("deduplicates runner progress retries by idempotency key before callback delivery", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const defaultPresentation = createDefaultCallbackPresentation();
    const app = createDispatcherApp({
      databasePath: ":memory:",
      presentation: {
        ...defaultPresentation,
        shouldDeliverStatusUpdate(provider) {
          return provider === "github";
        },
        shouldDeliverProgress(provider) {
          return provider === "github";
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const createResponse = await app.request("/v1/runs", jsonRequest({
      runId: "run_progress_replay",
      event: { ...validEvent, id: "evt_progress_replay", sourceEventId: "comment_progress_replay" }
    }));
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const initialIdempotencyKey = "runner_1:run_progress_replay:progress:1";
    const firstCredentialLikeKey = "xoxb\x2d1234567890-abcdefghijklmnopqrstuvwxyz";
    const secondCredentialLikeKey = "xoxb\x2d0987654321-zyxwvutsrqponmlkjihgfedcba";
    const body = {
      type: "milestone.progress",
      message: "working",
      at: "2026-06-24T00:00:01.000Z",
      visibility: "human",
      idempotencyKey: initialIdempotencyKey
    };
    const first = await app.request("/v1/runners/runner_1/runs/run_progress_replay/progress", jsonRequest(body));
    const replay = await app.request("/v1/runners/runner_1/runs/run_progress_replay/progress", jsonRequest({ ...body, message: "working retry" }));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ ok: true, replayed: true });

    const [concurrentA, concurrentB] = await Promise.all([
      app.request("/v1/runners/runner_1/runs/run_progress_replay/progress", jsonRequest({
        ...body, message: "parallel A", idempotencyKey: firstCredentialLikeKey
      })),
      app.request("/v1/runners/runner_1/runs/run_progress_replay/progress", jsonRequest({
        ...body, message: "parallel B", idempotencyKey: secondCredentialLikeKey
      }))
    ]);
    expect([concurrentA.status, concurrentB.status]).toEqual([200, 200]);

    expect(delivered.slice(0, 2)).toEqual([
      { kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_progress_replay`" },
      { kind: "progress", body: "OpenTag progress for `run_progress_replay`: working" }
    ]);
    expect(delivered.slice(2).map((message) => message.body).sort()).toEqual([
      "OpenTag progress for `run_progress_replay`: parallel A",
      "OpenTag progress for `run_progress_replay`: parallel B"
    ]);
    const eventsResponse = await app.request("/v1/runs/run_progress_replay/events");
    const { events } = await eventsResponse.json();
    expect(events.filter((event: { type: string }) => event.type === "run.progress")).toHaveLength(3);
    expect(events.filter((event: { type: string }) => event.type === "callback.progress.delivered")).toHaveLength(3);
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      payload: expect.not.objectContaining({ idempotencyKey: expect.anything() })
    });
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("working retry");
    expect(serializedEvents).not.toContain(initialIdempotencyKey);
    expect(serializedEvents).not.toContain(firstCredentialLikeKey);
    expect(serializedEvents).not.toContain(secondCredentialLikeKey);
    expect(serializedEvents).not.toContain("[redacted]");
  });

  it("deduplicates runner completion retries by idempotency key before final callback delivery", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const createResponse = await app.request("/v1/runs", jsonRequest({
      runId: "run_complete_replay",
      event: { ...validEvent, id: "evt_complete_replay", sourceEventId: "comment_complete_replay" }
    }));
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const first = await app.request("/v1/runners/runner_1/runs/run_complete_replay/complete", jsonRequest({
      result: { conclusion: "success", summary: "done" },
      idempotencyKey: "runner_1:run_complete_replay:complete:1"
    }));
    const replay = await app.request("/v1/runners/runner_1/runs/run_complete_replay/complete", jsonRequest({
      result: { conclusion: "failure", summary: "retry should not replace result" },
      idempotencyKey: "runner_1:run_complete_replay:complete:1"
    }));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstBody = await first.json() as {
      completion: { currentAssessment: { id: string }; completion: string };
    };
    expect(firstBody.completion).toMatchObject({ completion: "satisfied" });
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      replayed: true,
      completion: {
        completion: "satisfied",
        currentAssessment: { id: firstBody.completion.currentAssessment.id }
      }
    });

    expect(delivered).toEqual([
      { kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_complete_replay`" },
      { kind: "final", body: "OpenTag finished with **success**.\n\ndone" }
    ]);
    const getResponse = await app.request("/v1/runs/run_complete_replay");
    await expect(getResponse.json()).resolves.toMatchObject({
      run: {
        status: "succeeded",
        result: { conclusion: "success", summary: "done" }
      }
    });
    const eventsResponse = await app.request("/v1/runs/run_complete_replay/events");
    const { events } = await eventsResponse.json();
    expect(events.filter((event: { type: string }) => event.type === "run.completed")).toHaveLength(1);
    expect(events.filter((event: { type: string }) => event.type === "callback.final.delivered")).toHaveLength(1);
    expect(events.find((event: { type: string }) => event.type === "run.completed")).toMatchObject({
      payload: expect.objectContaining({ idempotencyKey: "runner_1:run_complete_replay:complete:1" })
    });
    expect(JSON.stringify(events)).not.toContain("retry should not replace result");
  });

  it("rejects runs for repositories without an explicit binding", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_unbound", event: validEvent })
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        action: "needs_human_decision",
        reasonCode: "repo_not_bound"
      }
    });
    const audit = await app.request("/v1/control-plane-events?type=admission.needs_human_decision");
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "admission.needs_human_decision",
        severity: "warn",
        subject: "run_unbound",
        payload: expect.objectContaining({
          runId: "run_unbound",
          source: "github",
          sourceEventId: "comment_1",
          projectTarget: "github:acme/demo",
          decision: expect.objectContaining({
            action: "needs_human_decision",
            reasonCode: "repo_not_bound"
          })
        })
      })
    ]);
  });

  it("rejects write-capable runs from actors outside the repo binding allowlist", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["someone-else"]
      })
    });
    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_denied",
        event: {
          ...validEvent,
          permissions: [
            ...validEvent.permissions,
            { scope: "repo:write", reason: "write branch" },
            { scope: "pr:create", reason: "open pull request" }
          ]
        }
      })
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        action: "needs_human_decision",
        reasonCode: "actor_not_allowed_for_write"
      }
    });
  });

  it("can require a human decision through an agent access profile hook", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      agentAccessProfileCheck: async () => ({
        allowed: false,
        reason: "The configured agent access profile does not allow this run in the current container.",
        reasonCode: "agent_access_profile_denied"
      })
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_access_denied", event: validEvent })
    });

    expect(response.status).toBe(202);
    const denied = await response.json() as { escalation: { id: string } };
    expect(denied).toMatchObject({
      decision: {
        action: "needs_human_decision",
        reasonCode: "agent_access_profile_denied"
      },
      escalation: {
        class: "security",
        audience: "repo_owner",
        state: "open",
        blocking: true,
        reason: "The configured agent access profile does not allow this run in the current container."
      }
    });
    const resolved = await app.request("/v1/thread-actions", jsonRequest({
      rawText: `@opentag /resolve ${denied.escalation.id} --reason Access policy was corrected`,
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
      metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 1 }
    }));
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({
      outcome: "resolved",
      escalation: { id: denied.escalation.id, state: "resolved", resolution: { actor: { providerUserId: "42" } } },
      resume: { required: true }
    });
  });

  it("accepts runner heartbeat for claimed runs", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_heartbeat", event: validEvent })
    });
    const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const claim = (await claimResponse.json()) as { attemptId: string; fencingToken: string };

    const response = await app.request(
      "/v1/runners/runner_1/runs/run_heartbeat/heartbeat",
      jsonRequest({ attemptId: claim.attemptId, fencingToken: claim.fencingToken })
    );
    expect(response.status).toBe(200);

    const runnerResponse = await app.request("/v1/runners/runner_1");
    await expect(runnerResponse.json()).resolves.toMatchObject({
      runner: {
        runnerId: "runner_1",
        heartbeatAt: expect.any(String)
      }
    });

    const eventsResponse = await app.request("/v1/runs/run_heartbeat/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("run.heartbeat");
  });

  it("rejects every stale runner mutation after a lease is reclaimed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-runner-fencing-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "dispatcher.sqlite");
    const app = createDispatcherApp({ databasePath, runnerLeaseSeconds: 60 });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }));
    await app.request(
      "/v1/repo-bindings",
      jsonRequest({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" })
    );
    await app.request("/v1/runs", jsonRequest({ runId: "run_http_fenced", event: validEvent }));

    const firstResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const first = (await firstResponse.json()) as { attemptId: string; attemptNumber: number; fencingToken: string };
    expireRunnerLease(databasePath, "run_http_fenced", first.attemptId);
    const secondResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const second = (await secondResponse.json()) as { attemptId: string; attemptNumber: number; fencingToken: string };
    expect(first.attemptNumber).toBe(1);
    expect(second.attemptNumber).toBe(2);

    const stale = { attemptId: first.attemptId, fencingToken: first.fencingToken };
    const staleRunning = await app.request(
      "/v1/runners/runner_1/runs/run_http_fenced/running",
      jsonRequest({ ...stale, executor: "late-executor" })
    );
    const staleHeartbeat = await app.request(
      "/v1/runners/runner_1/runs/run_http_fenced/heartbeat",
      jsonRequest(stale)
    );
    const staleProgress = await app.request(
      "/v1/runners/runner_1/runs/run_http_fenced/progress",
      jsonRequest({ ...stale, message: "late progress" })
    );
    const staleComplete = await app.request(
      "/v1/runners/runner_1/runs/run_http_fenced/complete",
      jsonRequest({ ...stale, result: { conclusion: "success", summary: "late completion" } })
    );
    for (const response of [staleRunning, staleHeartbeat, staleProgress, staleComplete]) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "stale_attempt" });
    }

    const beforeActiveRunning = await app.request("/v1/runs/run_http_fenced");
    await expect(beforeActiveRunning.json()).resolves.toMatchObject({ run: { status: "assigned" } });
    const beforeActiveEvents = await app.request("/v1/runs/run_http_fenced/events");
    const beforeActiveEventBody = (await beforeActiveEvents.json()) as { events: Array<{ type: string }> };
    expect(beforeActiveEventBody.events.filter((event) => event.type === "run.running")).toHaveLength(0);

    const active = { attemptId: second.attemptId, fencingToken: second.fencingToken };
    expect(
      (await app.request("/v1/runners/runner_1/runs/run_http_fenced/running", jsonRequest({ ...active, executor: "echo" }))).status
    ).toBe(200);
    expect(
      (await app.request("/v1/runners/runner_1/runs/run_http_fenced/progress", jsonRequest({ ...active, message: "current progress" }))).status
    ).toBe(200);
    expect(
      (
        await app.request(
          "/v1/runners/runner_1/runs/run_http_fenced/complete",
          jsonRequest({ ...active, result: { conclusion: "success", summary: "done" } })
        )
      ).status
    ).toBe(200);

    const eventsResponse = await app.request("/v1/runs/run_http_fenced/events");
    const { events } = (await eventsResponse.json()) as { events: unknown[] };
    expect(JSON.stringify(events)).not.toContain(first.fencingToken);
    expect(JSON.stringify(events)).not.toContain(second.fencingToken);
  });

  it("returns needs_human_decision when the agent access profile hook denies the run", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      agentAccessProfileCheck: async () => ({
        allowed: false,
        reason: "access denied",
        reasonCode: "agent_access_profile_denied"
      })
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_access_denied", event: validEvent })
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        action: "needs_human_decision",
        reasonCode: "agent_access_profile_denied"
      }
    });
  });

  it("stores and returns generic channel bindings", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const create = await app.request("/v1/channel-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "telegram",
        accountId: "bot_123",
        conversationId: "chat_456",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        metadata: { title: "Ops chat" }
      })
    });
    expect(create.status).toBe(201);

    const get = await app.request("/v1/channel-bindings/telegram/bot_123/chat_456");
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.binding).toEqual({
      provider: "telegram",
      accountId: "bot_123",
      conversationId: "chat_456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo",
      metadata: { title: "Ops chat" }
    });
  });

  it("stores a generic channel binding without fabricating a repository target", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const create = await app.request("/v1/channel-bindings", jsonRequest({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      metadata: { title: "General" }
    }));
    expect(create.status).toBe(201);

    const get = await app.request("/v1/channel-bindings/slack/T123/C456");
    await expect(get.json()).resolves.toEqual({
      binding: {
        provider: "slack",
        accountId: "T123",
        conversationId: "C456",
        metadata: { title: "General" }
      }
    });
  });

  it.each([
    {
      source: "slack",
      metadata: { teamId: "T123", channelId: "C456" },
      callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage" }
    },
    {
      source: "lark",
      metadata: { tenantKey: "tenant_1", chatId: "oc_chat" },
      callback: { provider: "lark", uri: "lark://im/v1/messages" }
    }
  ])("rejects $source run admission when its resolved channel has no binding", async ({ source, metadata, callback }) => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const response = await app.request("/v1/runs", jsonRequest({
      runId: `run_${source}_unbound`,
      event: {
        ...validEvent,
        id: `evt_${source}_unbound`,
        source,
        sourceEventId: `message_${source}_unbound`,
        actor: { provider: source, providerUserId: "user_1" },
        context: [],
        permissions: [],
        callback,
        metadata
      }
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "managed_channel_ownership_unverified" });
  });

  it("preserves unbound run admission for non-Slack/Lark channel providers", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const response = await app.request("/v1/runs", jsonRequest({
      runId: "run_teams_unbound",
      event: {
        ...validEvent,
        id: "evt_teams_unbound",
        source: "teams",
        sourceEventId: "message_teams_unbound",
        actor: { provider: "teams", providerUserId: "user_1" },
        context: [],
        permissions: [],
        callback: { provider: "teams", uri: "https://smba.trafficmanager.net/amer/" },
        metadata: { accountId: "tenant_1", conversationId: "conversation_1" }
      }
    }));

    expect(response.status).toBe(201);
  });

  it("fails closed when a managed channel run cannot prove the configured application identity", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_shared",
      channelPrincipals: [
        { provider: "slack", applicationId: "A123", botId: "U_APP", credential: "slack_principal_123" },
        { provider: "slack", applicationId: "A999", botId: "U_OTHER", credential: "slack_principal_999" }
      ]
    });
    const sharedHeaders = { "content-type": "application/json", authorization: "Bearer pair_shared" };
    const nativeHeaders = { ...sharedHeaders, "x-opentag-channel-principal": "slack_principal_123" };
    await app.request("/v1/runners", { ...jsonRequest({ runnerId: "runner_managed", name: "Managed Runner" }), headers: sharedHeaders });
    const binding = await app.request("/v1/channel-bindings", {
      ...jsonRequest({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      ownership: { mode: "managed", exclusive: true, applicationId: "A123", botId: "U_APP" }
      }),
      headers: nativeHeaders
    });
    expect(binding.status).toBe(201);

    const managedEvent = {
      id: "evt_managed_identity",
      source: "slack",
      sourceEventId: "message_managed_identity",
      receivedAt: "2026-07-12T00:00:00.000Z",
      actor: { provider: "slack", providerUserId: "U123", handle: "alice" },
      target: { mention: "@any-display-name", agentId: "opentag", executorHint: "custom" },
      command: { rawText: "summarize this thread", intent: "run", args: {} },
      context: [],
      permissions: [],
      callback: { provider: "slack", uri: "https://example.com/callback" },
      metadata: { teamId: "T123", channelId: "C456" }
    };

    const missing = await app.request("/v1/runs", {
      ...jsonRequest({
        runId: "run_managed_missing",
        event: {
          ...managedEvent,
          metadata: { ...managedEvent.metadata, channelApplicationId: "A123", channelBotId: "U_APP" }
        }
      }),
      headers: sharedHeaders
    });
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toEqual({ error: "managed_channel_ownership_unverified" });

    const mismatch = await app.request("/v1/runs", {
      ...jsonRequest({
        runId: "run_managed_mismatch",
        event: {
          ...managedEvent,
          id: "evt_managed_mismatch",
          sourceEventId: "message_managed_mismatch",
          metadata: { ...managedEvent.metadata, channelApplicationId: "A123", channelBotId: "U_APP" }
        }
      }),
      headers: { ...sharedHeaders, "x-opentag-channel-principal": "slack_principal_999" }
    });
    expect(mismatch.status).toBe(403);

    const accepted = await app.request("/v1/runs", {
      ...jsonRequest({
        runId: "run_managed_verified",
        event: {
          ...managedEvent,
          id: "evt_managed_verified",
          sourceEventId: "message_managed_verified",
          metadata: { ...managedEvent.metadata, channelApplicationId: "A999", channelBotId: "U_OTHER" }
        }
      }),
      headers: nativeHeaders
    });
    expect(accepted.status).toBe(201);
  });

  it("rejects run admission when the matching managed channel binding record is corrupt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-corrupt-binding-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    try {
      const app = createDispatcherApp({
        databasePath,
        pairingToken: "pair_corrupt",
        channelPrincipals: [{ provider: "slack", applicationId: "A123", credential: "principal_corrupt" }]
      });
      const headers = {
        "content-type": "application/json",
        authorization: "Bearer pair_corrupt",
        "x-opentag-channel-principal": "principal_corrupt"
      };
      expect((await app.request("/v1/channel-bindings", {
        ...jsonRequest({
          provider: "slack",
          accountId: "T123",
          conversationId: "C456",
          ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
        }),
        headers
      })).status).toBe(201);

      const sqlite = new Database(databasePath);
      sqlite.prepare(
        "UPDATE channel_bindings SET metadata_json = ? WHERE provider = ? AND account_id = ? AND conversation_id = ?"
      ).run(JSON.stringify({ management: "managed" }), "slack", "T123", "C456");
      sqlite.close();

      const response = await app.request("/v1/runs", {
        ...jsonRequest({
          runId: "run_corrupt_binding",
          event: {
            ...slackRepoEvent({
              id: "evt_corrupt_binding",
              sourceEventId: "EvCorruptBinding",
              threadKey: "T123|C456|1710000000.000100"
            }),
            metadata: { teamId: "T123", channelId: "C456" }
          }
        }),
        headers
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "managed_channel_binding_corrupt" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires the owning adapter principal to rebind or delete a managed channel and audits an explicit admin override", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_admin",
      channelPrincipals: [
        { provider: "slack", applicationId: "A123", credential: "slack_principal_123" },
        { provider: "slack", applicationId: "A999", credential: "slack_principal_999" }
      ]
    });
    const binding = {
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
    };
    const ownerHeaders = {
      "content-type": "application/json",
      authorization: "Bearer pair_admin",
      "x-opentag-channel-principal": "slack_principal_123"
    };
    expect((await app.request("/v1/channel-bindings", { ...jsonRequest(binding), headers: ownerHeaders })).status).toBe(201);

    const foreignHeaders = {
      ...ownerHeaders,
      "x-opentag-channel-principal": "slack_principal_999"
    };
    const foreignRebind = await app.request("/v1/channel-bindings", {
      ...jsonRequest({
        ...binding,
        ownership: { mode: "managed", exclusive: true, applicationId: "A999" }
      }),
      headers: foreignHeaders
    });
    expect(foreignRebind.status).toBe(403);
    const foreignDelete = await app.request("/v1/channel-bindings/slack/T123/C456", {
      method: "DELETE",
      headers: foreignHeaders
    });
    expect(foreignDelete.status).toBe(403);

    const overrideHeaders = {
      "content-type": "application/json",
      authorization: "Bearer pair_admin",
      "x-opentag-channel-admin-override": "true"
    };
    const overridden = await app.request("/v1/channel-bindings", {
      ...jsonRequest({
        ...binding,
        ownership: { mode: "managed", exclusive: true, applicationId: "A999" }
      }),
      headers: overrideHeaders
    });
    expect(overridden.status).toBe(201);

    const audit = await app.request("/v1/control-plane-events?type=binding.channel.admin_override", {
      headers: { authorization: "Bearer pair_admin" }
    });
    expect(audit.status).toBe(200);
    await expect(audit.json()).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          type: "binding.channel.admin_override",
          severity: "warn",
          subject: "slack:T123/C456",
          payload: { provider: "slack", accountId: "T123", conversationId: "C456", operation: "upsert" }
        })
      ]
    });
  });

  it("restricts managed channel status to the owning adapter principal or an audited admin override", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_status",
      channelPrincipals: [
        { provider: "slack", applicationId: "A123", credential: "slack_principal_123" },
        { provider: "slack", applicationId: "A999", credential: "slack_principal_999" }
      ]
    });
    const sharedHeaders = { authorization: "Bearer pair_status" };
    const ownerHeaders = { ...sharedHeaders, "x-opentag-channel-principal": "slack_principal_123" };
    const foreignHeaders = { ...sharedHeaders, "x-opentag-channel-principal": "slack_principal_999" };
    const binding = await app.request("/v1/channel-bindings", {
      ...jsonRequest({
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
      }),
      headers: { "content-type": "application/json", ...ownerHeaders }
    });
    expect(binding.status).toBe(201);

    for (const headers of [sharedHeaders, foreignHeaders]) {
      const denied = await app.request("/v1/channel-bindings/slack/T123/C123/status", { headers });
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toEqual({ error: "managed_channel_principal_required" });
    }

    const owner = await app.request("/v1/channel-bindings/slack/T123/C123/status", { headers: ownerHeaders });
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toMatchObject({
      binding: { provider: "slack", accountId: "T123", conversationId: "C123" },
      queuedFollowUps: []
    });

    const override = await app.request("/v1/channel-bindings/slack/T123/C123/status", {
      headers: { ...sharedHeaders, "x-opentag-channel-admin-override": "true" }
    });
    expect(override.status).toBe(200);

    const audit = await app.request("/v1/control-plane-events?type=binding.channel.admin_override", {
      headers: sharedHeaders
    });
    await expect(audit.json()).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          type: "binding.channel.admin_override",
          severity: "warn",
          subject: "slack:T123/C123",
          payload: { provider: "slack", accountId: "T123", conversationId: "C123", operation: "status" }
        })
      ]
    });
  });

  it("restricts managed channel cancellation without mutating the run on denial", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_cancel",
      channelPrincipals: [
        { provider: "slack", applicationId: "A123", credential: "slack_principal_123" },
        { provider: "slack", applicationId: "A999", credential: "slack_principal_999" }
      ]
    });
    const sharedHeaders = { "content-type": "application/json", authorization: "Bearer pair_cancel" };
    const ownerHeaders = { ...sharedHeaders, "x-opentag-channel-principal": "slack_principal_123" };
    const foreignHeaders = { ...sharedHeaders, "x-opentag-channel-principal": "slack_principal_999" };
    await app.request("/v1/repo-bindings", authorizedJsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_managed_cancel",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }, "pair_cancel"));
    const binding = await app.request("/v1/channel-bindings", {
      ...jsonRequest({
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
      }),
      headers: ownerHeaders
    });
    expect(binding.status).toBe(201);

    const createRunningRun = async (runId: string, eventId: string) => {
      const created = await app.request("/v1/runs", {
        ...jsonRequest({
          runId,
          event: slackRepoEvent({ id: eventId, sourceEventId: `${eventId}_source`, threadKey: "T123|C123|1710000000.000100" })
        }),
        headers: ownerHeaders
      });
      expect(created.status).toBe(201);
      expect((await app.request("/v1/runners/runner_managed_cancel/claim", { method: "POST", headers: sharedHeaders })).status).toBe(200);
      expect((await app.request(`/v1/runners/runner_managed_cancel/runs/${runId}/running`, {
        ...jsonRequest({ executor: "echo" }),
        headers: sharedHeaders
      })).status).toBe(200);
    };

    await createRunningRun("run_managed_cancel_denied", "evt_managed_cancel_denied");
    for (const headers of [sharedHeaders, foreignHeaders]) {
      const denied = await app.request("/v1/channel-bindings/slack/T123/C123/cancel-active-run", {
        ...jsonRequest({ reason: "denied" }),
        headers
      });
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toEqual({ error: "managed_channel_principal_required" });
      const stored = await app.request("/v1/runs/run_managed_cancel_denied", { headers: sharedHeaders });
      await expect(stored.json()).resolves.toMatchObject({ run: { status: "running" } });
    }

    const ownerCancel = await app.request("/v1/channel-bindings/slack/T123/C123/cancel-active-run", {
      ...jsonRequest({ reason: "owner requested" }),
      headers: ownerHeaders
    });
    expect(ownerCancel.status).toBe(200);

    await createRunningRun("run_managed_cancel_override", "evt_managed_cancel_override");
    const override = await app.request("/v1/channel-bindings/slack/T123/C123/cancel-active-run", {
      ...jsonRequest({ reason: "admin requested" }),
      headers: { ...sharedHeaders, "x-opentag-channel-admin-override": "true" }
    });
    expect(override.status).toBe(200);

    const audit = await app.request("/v1/control-plane-events?type=binding.channel.admin_override", {
      headers: sharedHeaders
    });
    await expect(audit.json()).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          type: "binding.channel.admin_override",
          severity: "warn",
          subject: "slack:T123/C123",
          payload: { provider: "slack", accountId: "T123", conversationId: "C123", operation: "cancel" }
        })
      ]
    });
  });

  it("rejects partial repository fields on generic channel bindings", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/channel-bindings", jsonRequest({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      owner: "acme"
    }));

    expect(response.status).toBe(400);
  });

  it("lets a registered runner claim a non-repository run", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_scratch", name: "Scratch Runner" }));
    const ordinaryEvent = {
      id: "evt_scratch_dispatcher",
      source: "slack",
      sourceEventId: "message_scratch_dispatcher",
      receivedAt: "2026-07-12T00:00:00.000Z",
      actor: { provider: "slack", providerUserId: "U123", handle: "alice" },
      target: { mention: "@opentag", agentId: "opentag", executorHint: "custom" },
      command: { rawText: "summarize this thread", intent: "run", args: {} },
      context: [],
      permissions: [],
      callback: { provider: "slack", uri: "https://example.com/callback" },
      metadata: { teamId: "T123", channelId: "C456" }
    };
    await bindSourceChannel(app, ordinaryEvent);
    const created = await app.request("/v1/runs", jsonRequest({ runId: "run_scratch_dispatcher", event: ordinaryEvent }));
    expect([201, 202]).toContain(created.status);

    const claim = await app.request("/v1/runners/runner_scratch/claim", { method: "POST" });
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toMatchObject({ run: { id: "run_scratch_dispatcher" } });
  });

  it("uses legacy terminal callback delivery for a hosted run without a completion assessment", async () => {
    const sqlite = new Database(":memory:");
    const delivered: CallbackMessage[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      sqlite,
      callbackSink: {
        async deliver(message) {
          delivered.push(message);
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });
    onTestFinished(async () => {
      await app.stopBackgroundWorkers();
      sqlite.close();
    });
    const runnerId = "runner_hosted_scratch";
    const runId = "run_hosted_scratch";
    const event = {
      id: "evt_hosted_scratch",
      source: "slack",
      sourceEventId: "message_hosted_scratch",
      receivedAt: "2026-07-12T00:00:00.000Z",
      actor: { provider: "slack", providerUserId: "U123", handle: "alice" },
      target: { mention: "@opentag", agentId: "opentag", executorHint: "custom" },
      command: { rawText: "summarize this thread", intent: "run", args: {} },
      context: [],
      permissions: [],
      callback: { provider: "slack", uri: "https://example.com/callback" },
      metadata: { teamId: "T123", channelId: "C456" }
    };
    expect((await app.request("/v1/runners", jsonRequest({
      runnerId,
      name: "Hosted Scratch Runner"
    }))).status).toBe(201);
    await bindSourceChannel(app, event);
    expect((await app.request("/v1/runs", jsonRequest({ runId, event }))).status)
      .toBe(201);
    const claimResponse = await app.request(`/v1/runners/${runnerId}/claim`, {
      method: "POST"
    });
    expect(claimResponse.status).toBe(200);
    const claim = await claimResponse.json() as {
      attemptId: string;
      fencingToken: string;
    };
    const importedAt = new Date().toISOString();
    sqlite.prepare(`INSERT INTO hosted_run_imports (
      run_id, admission_id, admission_operation_id, claim_operation_id,
      attempt_id, fencing_token_digest, source_identity_digest,
      delivery_payload_digest, admission_envelope_digest, policy_receipt_id,
      policy_payload_digest, policy_receipt_digest, event_digest,
      context_packet_digest, claim_digest, authority_digest, authority_json,
      imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`)
      .run(
        runId,
        "admission_hosted_scratch",
        "admission_operation_hosted_scratch",
        "claim_operation_hosted_scratch",
        claim.attemptId,
        `sha256:${"1".repeat(64)}`,
        `sha256:${"2".repeat(64)}`,
        `sha256:${"3".repeat(64)}`,
        `sha256:${"4".repeat(64)}`,
        "policy_receipt_hosted_scratch",
        `sha256:${"5".repeat(64)}`,
        `sha256:${"6".repeat(64)}`,
        `sha256:${"7".repeat(64)}`,
        `sha256:${"8".repeat(64)}`,
        `sha256:${"9".repeat(64)}`,
        `sha256:${"a".repeat(64)}`,
        importedAt
      );
    delivered.length = 0;

    const complete = await app.request(
      `/v1/runners/${runnerId}/runs/${runId}/complete`,
      jsonRequest({ result: { conclusion: "success", summary: "Scratch run completed." } })
    );

    expect(complete.status).toBe(200);
    expect(delivered).toEqual([
      expect.objectContaining({
        runId,
        kind: "final"
      })
    ]);
    expect(sqlite.prepare(`SELECT dispatch_mode AS dispatchMode, status
      FROM callback_deliveries WHERE run_id = ? AND kind = 'final'`).get(runId))
      .toEqual({ dispatchMode: "legacy", status: "delivered" });
  });

  it("deletes generic channel bindings", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/channel-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "lark",
        accountId: "tenant_1",
        conversationId: "oc_chat",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    });

    const deleted = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat", { method: "DELETE" });
    expect(deleted.status).toBe(204);

    const get = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat");
    expect(get.status).toBe(404);

    const deleteAgain = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat", { method: "DELETE" });
    expect(deleteAgain.status).toBe(404);
  });

  it("cancels the active run for a bound source container", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "lark",
      accountId: "tenant_1",
      conversationId: "oc_chat",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_lark_cancel",
      event: larkRepoEvent({ id: "evt_lark_cancel", sourceEventId: "msg_lark_cancel" })
    }));
    expect(create.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_lark_cancel/running", jsonRequest({ executor: "echo" }));
    const followUp = await app.request("/v1/runs", jsonRequest({
      runId: "follow_up_lark_cancel",
      event: larkRepoEvent({ id: "evt_lark_cancel_follow_up", sourceEventId: "msg_lark_cancel_follow_up" })
    }));
    expect(followUp.status).toBe(202);

    const cancel = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat/cancel-active-run", jsonRequest({
      reason: "Stop requested from Lark.",
      requestedBy: "lark:ou_sender"
    }));
    expect(cancel.status).toBe(200);
    await expect(cancel.json()).resolves.toMatchObject({
      outcome: "cancelled",
      run: {
        id: "run_lark_cancel",
        status: "cancelled",
        result: { conclusion: "cancelled" }
      }
    });

    const lateComplete = await app.request("/v1/runners/runner_1/runs/run_lark_cancel/complete", jsonRequest({
      result: { conclusion: "success", summary: "late success" }
    }));
    expect(lateComplete.status).toBe(409);
    await expect(lateComplete.json()).resolves.toEqual({ error: "stale_attempt" });

    const stored = await app.request("/v1/runs/run_lark_cancel");
    await expect(stored.json()).resolves.toMatchObject({
      run: {
        status: "cancelled",
        result: { conclusion: "cancelled" }
      }
    });

    const queuedFollowUp = await app.request("/v1/follow-up-requests/follow_up_lark_cancel");
    await expect(queuedFollowUp.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_lark_cancel",
        status: "queued"
      }
    });
  });

  it("reports active run and queued follow-ups for a bound source container", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "lark",
      accountId: "tenant_1",
      conversationId: "oc_chat",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_lark_status",
      event: larkRepoEvent({ id: "evt_lark_status", sourceEventId: "msg_lark_status", messageId: "om_thread" })
    }));
    expect(create.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_lark_status/running", jsonRequest({ executor: "echo", runTimeoutMs: 30_000 }));

    const followUp = await app.request("/v1/runs", jsonRequest({
      runId: "follow_up_lark_status",
      event: larkRepoEvent({ id: "evt_lark_status_follow_up", sourceEventId: "msg_lark_status_follow_up", messageId: "om_thread" })
    }));
    expect(followUp.status).toBe(202);

    const status = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat/status");

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      binding: {
        provider: "lark",
        accountId: "tenant_1",
        conversationId: "oc_chat",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      },
      activeRun: {
        id: "run_lark_status",
        status: "running"
      },
      runTimeoutPolicy: {
        hardTimeoutMs: 30_000
      },
      queuedFollowUps: [
        {
          id: "follow_up_lark_status",
          activeRunId: "run_lark_status",
          status: "queued"
        }
      ]
    });
  });

  it("replies to GitHub source-thread /status without creating a run", async () => {
    const delivered: Array<{ kind: string; body: string; runId: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body, runId: message.runId });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_github_thread_status",
      event: githubIssueEvent({ id: "evt_github_thread_status", sourceEventId: "comment_github_thread_status", threadKey: "acme/demo#1" })
    }));
    expect(create.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_github_thread_status/running", jsonRequest({ executor: "echo", runTimeoutMs: 45_000 }));
    const followUp = await app.request("/v1/runs", jsonRequest({
      runId: "follow_up_github_thread_status",
      event: githubIssueEvent({ id: "evt_github_thread_status_follow_up", sourceEventId: "comment_github_thread_status_follow_up", threadKey: "acme/demo#1" })
    }));
    expect(followUp.status).toBe(202);
    delivered.length = 0;

    const status = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "@opentag /status",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueNumber: 1
      }
    }));

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      outcome: "status",
      bindingState: "bound",
      activeRun: {
        id: "run_github_thread_status",
        status: "running"
      },
      queuedFollowUps: [
        {
          id: "follow_up_github_thread_status",
          status: "queued"
        }
      ],
      runTimeoutPolicy: {
        hardTimeoutMs: 45_000
      }
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: "final",
      runId: "run_github_thread_status"
    });
    expect(delivered[0]!.body).toContain("OpenTag status:");
    expect(delivered[0]!.body).toContain("Source container: github:acme/demo#1");
    expect(delivered[0]!.body).toContain("Project Target: github:acme/demo");
    expect(delivered[0]!.body).toContain("Active run: run_github_thread_status (running)");
    expect(delivered[0]!.body).toContain("Queued follow-ups: 1 (follow_up_github_thread_status (queued)");
  });

  it("replies to source-thread /doctor without creating a run when no run is active", async () => {
    const delivered: Array<{ kind: string; body: string; runId: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body, runId: message.runId });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });
    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo"
    }));

    const doctor = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "@opentag /doctor",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueNumber: 1
      }
    }));

    expect(doctor.status).toBe(200);
    await expect(doctor.json()).resolves.toMatchObject({
      outcome: "doctor",
      bindingState: "bound"
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.runId).toMatch(/^control_/);
    expect(delivered[0]!.body).toContain("OpenTag doctor (redacted):");
    expect(delivered[0]!.body).toContain("OK Source thread: github:acme/demo#1");
    const missing = await app.request(`/v1/runs/${delivered[0]!.runId}`);
    expect(missing.status).toBe(404);
  });

  it("cancels a GitLab active source-thread run from /stop without auto-promoting queued follow-ups", async () => {
    const delivered: Array<{ kind: string; body: string; runId: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body, runId: message.runId });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "gitlab",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_gitlab_thread_stop",
      event: gitlabIssueEvent({ id: "evt_gitlab_thread_stop", sourceEventId: "note_gitlab_thread_stop", threadKey: "acme/demo|issue|1" })
    }));
    expect(create.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_gitlab_thread_stop/running", jsonRequest({ executor: "echo" }));
    const followUp = await app.request("/v1/runs", jsonRequest({
      runId: "follow_up_gitlab_thread_stop",
      event: gitlabIssueEvent({ id: "evt_gitlab_thread_stop_follow_up", sourceEventId: "note_gitlab_thread_stop_follow_up", threadKey: "acme/demo|issue|1" })
    }));
    expect(followUp.status).toBe(202);
    delivered.length = 0;

    const stop = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "@opentag /stop",
      actor: { provider: "gitlab", providerUserId: "7", handle: "alice" },
      callback: {
        provider: "gitlab",
        uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        threadKey: "acme/demo|issue|1"
      },
      metadata: {
        repoProvider: "gitlab",
        owner: "acme",
        repo: "demo",
        projectPathWithNamespace: "acme/demo",
        issueIid: 1
      }
    }));

    expect(stop.status).toBe(200);
    await expect(stop.json()).resolves.toMatchObject({
      outcome: "cancelled",
      run: {
        id: "run_gitlab_thread_stop",
        status: "cancelled",
        result: { conclusion: "cancelled" }
      }
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: "final",
      runId: "run_gitlab_thread_stop"
    });
    expect(delivered[0]!.body).toContain("Cancellation requested for run run_gitlab_thread_stop.");

    const lateComplete = await app.request("/v1/runners/runner_1/runs/run_gitlab_thread_stop/complete", jsonRequest({
      result: { conclusion: "success", summary: "late success" }
    }));
    expect(lateComplete.status).toBe(409);
    await expect(lateComplete.json()).resolves.toEqual({ error: "stale_attempt" });
    const queuedFollowUp = await app.request("/v1/follow-up-requests/follow_up_gitlab_thread_stop");
    await expect(queuedFollowUp.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_gitlab_thread_stop",
        status: "queued"
      }
    });
  });

  it("cancels a run by id", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_cancel_by_id",
      event: githubIssueEvent({ id: "evt_cancel_by_id", sourceEventId: "comment_cancel_by_id" })
    }));
    expect(create.status).toBe(201);

    const cancel = await app.request("/v1/runs/run_cancel_by_id/cancel", jsonRequest({ reason: "Stop requested." }));
    expect(cancel.status).toBe(200);
    await expect(cancel.json()).resolves.toMatchObject({
      outcome: "cancelled",
      run: { id: "run_cancel_by_id", status: "cancelled" }
    });

    const cancelAgain = await app.request("/v1/runs/run_cancel_by_id/cancel", jsonRequest({ reason: "Stop again." }));
    expect(cancelAgain.status).toBe(409);
    await expect(cancelAgain.json()).resolves.toMatchObject({ error: "run_already_terminal" });

    const events = await app.request("/v1/runs/run_cancel_by_id/events");
    await expect(events.json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "run.cancel_requested",
          payload: expect.objectContaining({
            terminalReason: "cancelled_by_user",
            terminalSemantics: "A human stop request is not a successful completion and does not auto-promote queued follow-ups."
          })
        })
      ])
    });
  });

  it("keeps Slack channel binding endpoints as compatibility wrappers", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const create = await app.request("/v1/slack-channel-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        teamId: "T123",
        channelId: "C123",
        repoProvider: "gitlab",
        owner: "acme",
        repo: "demo"
      })
    });
    expect(create.status).toBe(201);

    const get = await app.request("/v1/slack-channel-bindings/T123/C123");
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.binding).toEqual({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo"
    });

    const genericGet = await app.request("/v1/channel-bindings/slack/T123/C123");
    expect(genericGet.status).toBe(200);
    await expect(genericGet.json()).resolves.toEqual({
      binding: {
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        repoProvider: "gitlab",
        owner: "acme",
        repo: "demo"
      }
    });
  });

  it("keeps the Slack compatibility binding route inside managed principal authorization", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_compat",
      channelPrincipals: [
        { provider: "slack", applicationId: "A123", credential: "slack_principal_owner" }
      ]
    });
    const pairingHeaders = { "content-type": "application/json", authorization: "Bearer pair_compat" };
    const ownerHeaders = { ...pairingHeaders, "x-opentag-channel-principal": "slack_principal_owner" };
    const binding = {
      provider: "slack",
      accountId: "T_MANAGED",
      conversationId: "C_MANAGED",
      repoProvider: "github",
      owner: "acme",
      repo: "original",
      ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
    };
    expect((await app.request("/v1/channel-bindings", { ...jsonRequest(binding), headers: ownerHeaders })).status).toBe(201);

    const compatibilityRebind = {
      teamId: "T_MANAGED",
      channelId: "C_MANAGED",
      repoProvider: "github",
      owner: "acme",
      repo: "replacement"
    };
    const pairingOnly = await app.request("/v1/slack-channel-bindings", {
      ...jsonRequest(compatibilityRebind),
      headers: pairingHeaders
    });
    expect(pairingOnly.status).toBe(403);
    await expect(pairingOnly.json()).resolves.toEqual({ error: "managed_channel_principal_required" });

    const ownerRebind = await app.request("/v1/slack-channel-bindings", {
      ...jsonRequest(compatibilityRebind),
      headers: ownerHeaders
    });
    expect(ownerRebind.status).toBe(201);

    const adminRebind = await app.request("/v1/slack-channel-bindings", {
      ...jsonRequest({ ...compatibilityRebind, repo: "admin-replacement" }),
      headers: { ...pairingHeaders, "x-opentag-channel-admin-override": "true" }
    });
    expect(adminRebind.status).toBe(201);
    const audit = await app.request("/v1/control-plane-events?type=binding.channel.admin_override", {
      headers: { authorization: "Bearer pair_compat" }
    });
    await expect(audit.json()).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          subject: "slack:T_MANAGED/C_MANAGED",
          payload: expect.objectContaining({ operation: "compatibility_upsert" })
        })
      ]
    });
    const stored = await app.request("/v1/channel-bindings/slack/T_MANAGED/C_MANAGED", {
      headers: { authorization: "Bearer pair_compat" }
    });
    await expect(stored.json()).resolves.toMatchObject({
      binding: {
        repo: "admin-replacement",
        ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
      }
    });
  });

  it("accepts a Slack event when its repo metadata matches a bound GitHub repo", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    });
    await bindSourceChannel(app, slackRepoEvent({
      id: "evt_slack_bound_binding",
      sourceEventId: "EvBoundBinding",
      threadKey: "T123|C123|1710000000.000100"
    }));

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_slack_bound",
        event: {
          id: "evt_slack_bound",
          source: "slack",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "slack", providerUserId: "U456", handle: "U456", organizationId: "T123" },
          target: { mention: "<@U_APP>", agentId: "opentag" },
          command: { rawText: "investigate this", intent: "investigate", args: {} },
          context: [],
          permissions: [
            { scope: "chat:postMessage", reason: "reply in thread" },
            { scope: "runner:local", reason: "execute locally" }
          ],
          callback: {
            provider: "slack",
            uri: "https://slack.com/api/chat.postMessage",
            threadKey: "T123|C123|1710000000.000100"
          },
          metadata: {
            teamId: "T123",
            channelId: "C123",
            messageTs: "1710000000.000100",
            repoProvider: "github",
            owner: "acme",
            repo: "demo"
          }
        }
      })
    });

    expect(response.status).toBe(201);
  });

  it("passes the target agent id through Slack callbacks", async () => {
    const delivered: Array<{ kind: string; agentId?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            ...(message.agentId ? { agentId: message.agentId } : {})
          });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    });

    const slackEvent = {
      ...validEvent,
      id: "evt_slack_agent",
      source: "slack",
      sourceEventId: "EvAgent",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      target: { mention: "<@U_DEEP>", agentId: "deepseek" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      },
      metadata: {
        ...validEvent.metadata,
        teamId: "T123",
        channelId: "C123",
        channelApplicationId: "A123",
        channelBotId: "U_APP"
      }
    };
    await bindSourceChannel(app, slackEvent);

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_slack_agent", event: slackEvent })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_slack_agent/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { conclusion: "success", summary: "done" } })
    });
    expect(completeResponse.status).toBe(200);

    expect(delivered).toEqual([
      { kind: "final", agentId: "deepseek" }
    ]);
  });

  it("applies a model-suggested GitHub label action from a source-thread reply", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_apply",
      event: githubIssueEvent({ id: "evt_thread_apply", sourceEventId: "comment_thread_apply", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_apply",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "applied",
      decision: { proposalId: "proposal_thread_apply", approvedIntentIds: ["intent_label_bug"] },
      plan: {
        proposalId: "proposal_thread_apply",
        selectedIntentIds: ["intent_label_bug"],
        outcomes: [{ intentId: "intent_label_bug", outcome: "applied" }]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1/labels",
        method: "POST",
        body: { labels: ["bug"] },
        authorization: "Bearer gh_test"
      }
    ]);
    expect(delivered.some((message) => message.body.includes("<summary>Ready to apply</summary>"))).toBe(true);
    expect(delivered.at(-1)?.body).toContain("Applied: Add the bug label.");
    expect(delivered.at(-1)?.body).not.toContain("proposal_thread_apply");
    expect(delivered.at(-1)?.body).not.toContain("intent_label_bug");

    const deliveredCountAfterFirstApply = delivered.length;
    const replayResponse = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toMatchObject({
      outcome: "already_applied",
      plan: {
        proposalId: "proposal_thread_apply",
        outcomes: [{ intentId: "intent_label_bug", outcome: "applied" }]
      }
    });
    expect(githubRequests).toHaveLength(1);
    expect(delivered).toHaveLength(deliveredCountAfterFirstApply + 1);
    expect(delivered.at(-1)?.body).toContain("Already applied: Add the bug label.");
    expect(delivered.at(-1)?.body).toContain("No external write was repeated.");
    expect(delivered.at(-1)?.body).not.toContain("proposal_thread_apply");
  });

  it("renders needs-setup receipts without apply commands when GitHub apply is not configured", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_apply_not_configured",
      event: githubIssueEvent({ id: "evt_thread_apply_not_configured", sourceEventId: "comment_thread_apply_not_configured", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_apply_not_configured",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug_not_configured",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("GitHub apply is not configured on this dispatcher.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`continue 1`");
    expect(finalMessage?.body).toContain("`reject 1`");
  });

  it("renders needs-setup receipts when create PR lacks the branch-exists executor condition", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const event = githubIssueEvent({ id: "evt_thread_pr_missing_condition", sourceEventId: "comment_thread_pr_missing_condition", threadKey: "acme/demo" });
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async () => {
          throw new Error("missing executor condition should prevent apply from looking ready");
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_pr_missing_condition",
      event: {
        ...event,
        permissions: [...event.permissions, { scope: "pr:create", reason: "create an approved pull request" }]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_pr_missing_condition",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a pull request.",
          intents: [
            {
              intentId: "intent_pr_missing_condition",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create a pull request for branch opentag/missing-condition.",
              params: {
                title: "OpenTag run missing condition",
                head: "opentag/missing-condition",
                base: "main"
              }
            }
          ]
        }
      ]
    });

    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Create a pull request for branch"));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("Missing executor condition: isolated branch exists.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`continue 1`");
  });

  it("renders needs-setup receipts before GitHub preflight when platform write permission is missing", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async () => {
          throw new Error("missing platform permission should prevent GitHub preflight");
        }
      }
    });
    const event = githubIssueEvent({ id: "evt_thread_missing_permission", sourceEventId: "comment_thread_missing_permission", threadKey: "acme/demo" });

    await seedCompletedProposal({
      app,
      runId: "run_thread_missing_permission",
      event: {
        ...event,
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_missing_permission",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_missing_permission",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("Missing platform permission for set_labels.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`continue 1`");
  });

  it("renders needs-setup receipts when GitHub preflight cannot access the target", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: Array<{ url: string; method?: string; authorization?: string | null; hasSignal: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            authorization: new Headers(init?.headers).get("authorization"),
            hasSignal: Boolean(init?.signal)
          });
          return new Response("forbidden", { status: 403 });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_preflight_forbidden",
      event: githubIssueEvent({ id: "evt_thread_preflight_forbidden", sourceEventId: "comment_thread_preflight_forbidden", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_preflight_forbidden",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_preflight_forbidden",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1",
        method: "GET",
        authorization: "Bearer gh_test",
        hasSignal: true
      }
    ]);
    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("GitHub apply token cannot access GitHub issue or pull request #1.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`continue 1`");
  });

  it("deduplicates receipt preflight requests for multiple intents on the same target", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(String(url));
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_preflight_dedupe",
      event: githubIssueEvent({ id: "evt_thread_preflight_dedupe", sourceEventId: "comment_thread_preflight_dedupe", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_preflight_dedupe",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug_dedupe",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            },
            {
              intentId: "intent_label_help_dedupe",
              domain: "labels",
              action: "add_label",
              summary: "Add the help wanted label.",
              params: { label: "help wanted" }
            }
          ]
        }
      ]
    });

    expect(githubRequests).toEqual(["https://api.github.com/repos/acme/demo/issues/1"]);
    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Ready to apply</summary>");
    expect(finalMessage?.body).toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`apply 2`");
  });

  it("renders needs-setup receipts when GitHub preflight cannot find the target issue or branch", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(String(url));
          return new Response("not found", { status: 404 });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_preflight_not_found",
      event: {
        ...githubIssueEvent({ id: "evt_thread_preflight_not_found", sourceEventId: "comment_thread_preflight_not_found", threadKey: "acme/demo" }),
        permissions: [
          { scope: "issue:comment", reason: "reply to source thread" },
          { scope: "repo:write", reason: "apply approved issue metadata" },
          { scope: "pr:create", reason: "create an approved pull request" }
        ]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_preflight_not_found_issue",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the missing issue.",
          intents: [
            {
              intentId: "intent_label_preflight_not_found",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        },
        {
          proposalId: "proposal_thread_preflight_not_found_branch",
          createdAt: "2026-06-24T00:00:01.000Z",
          summary: "Create a pull request.",
          intents: [
            {
              intentId: "intent_pr_preflight_not_found",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create a pull request for branch opentag/missing-branch.",
              params: {
                title: "OpenTag missing branch",
                head: "opentag/missing-branch",
                base: "main",
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });

    expect(githubRequests).toEqual([
      "https://api.github.com/repos/acme/demo/issues/1",
      "https://api.github.com/repos/acme/demo/branches/opentag%2Fmissing-branch",
      "https://api.github.com/repos/acme/demo/branches/main"
    ]);
    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("GitHub issue or pull request #1 was not found.");
    expect(finalMessage?.body).toContain("GitHub branch opentag/missing-branch was not found.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
  });

  it("renders a stale receipt when applying a superseded source-thread action", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_stale_1",
      event: githubIssueEvent({ id: "evt_thread_stale_1", sourceEventId: "comment_thread_stale_1", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_stale_1",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug_stale",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_stale_2",
      event: githubIssueEvent({ id: "evt_thread_stale_2", sourceEventId: "comment_thread_stale_2", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_stale_2",
          createdAt: "2026-06-24T00:00:01.000Z",
          summary: "Refine the label.",
          intents: [
            {
              intentId: "intent_label_triaged_current",
              domain: "labels",
              action: "add_label",
              summary: "Add the triaged label.",
              params: { label: "triaged" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      },
      metadata: {
        source: "slack_button",
        proposalId: "proposal_thread_stale_1",
        intentId: "intent_label_bug_stale"
      }
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "stale",
      plan: {
        proposalId: "proposal_thread_stale_1",
        outcomes: [{ intentId: "intent_label_bug_stale", outcome: "stale" }]
      }
    });
    expect(githubRequests).toHaveLength(0);
    expect(delivered.at(-1)?.body).toContain("Stale: Add the bug label.");
    expect(delivered.at(-1)?.body).toContain("The target changed since this action was proposed.");
    expect(delivered.at(-1)?.body).toContain("Reply `continue 1` to refresh");
    expect(delivered.at(-1)?.body).not.toContain("Child run:");
    expect(delivered.at(-1)?.body).not.toContain("proposal_thread_stale_1");
  });

  it("resolves issue-scoped action replies against legacy repo-scoped GitHub issue proposals", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
          });
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_apply_legacy",
      event: githubIssueEvent({
        id: "evt_thread_apply_legacy",
        sourceEventId: "comment_thread_apply_legacy",
        threadKey: "acme/demo"
      }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_apply_legacy",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the legacy bug.",
          intents: [
            {
              intentId: "intent_label_legacy_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueNumber: 1
      }
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      decision: { proposalId: "proposal_thread_apply_legacy", approvedIntentIds: ["intent_label_legacy_bug"] },
      plan: {
        proposalId: "proposal_thread_apply_legacy",
        outcomes: [{ intentId: "intent_label_legacy_bug", outcome: "applied" }]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1/labels",
        method: "POST",
        body: { labels: ["bug"] }
      }
    ]);
  });

  it("does not execute the adapter twice for concurrent duplicate apply replies", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_apply_race",
      event: githubIssueEvent({ id: "evt_thread_apply_race", sourceEventId: "comment_thread_apply_race", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_apply_race",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug_race",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const action = {
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    };
    const responses = await Promise.all([
      app.request("/v1/thread-actions", jsonRequest(action)),
      app.request("/v1/thread-actions", jsonRequest(action))
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(bodies.map((body) => body.outcome).sort()).toEqual(["already_planned", "applied"]);
    expect(githubRequests).toHaveLength(1);
    expect(delivered.some((message) => message.body.includes("Already planned: Add the bug label."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("OpenTag did not execute this repeated reply."))).toBe(true);
  });

  it("rejects unauthorized source-thread action actors before approval or adapter execution", async () => {
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_unauthorized",
      event: githubIssueEvent({ id: "evt_thread_unauthorized", sourceEventId: "comment_thread_unauthorized", threadKey: "acme/demo" }),
      allowedActors: ["octocat"],
      suggestedChanges: [
        {
          proposalId: "proposal_thread_unauthorized",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "99", handle: "mallory" },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unauthorized",
      reason: "actor_not_allowed"
    });
    expect(githubRequests).toHaveLength(0);

    const eventsResponse = await app.request("/v1/runs/run_thread_unauthorized/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).not.toContain("approval.decision.recorded");
    expect(events.map((event: { type: string }) => event.type)).not.toContain("apply_plan.created");
  });

  it("rejects public-repo source-thread action actors without write access by default", async () => {
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_public_no_write",
      event: githubIssueEvent({ id: "evt_thread_public_no_write", sourceEventId: "comment_thread_public_no_write", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_public_no_write",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "99", handle: "mallory" },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unauthorized",
      reason: "actor_not_allowed"
    });
    expect(githubRequests).toHaveLength(0);

    const eventsResponse = await app.request("/v1/runs/run_thread_public_no_write/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).not.toContain("approval.decision.recorded");
    expect(events.map((event: { type: string }) => event.type)).not.toContain("apply_plan.created");
  });

  it("rejects Slack thread actions when the source channel binding is missing", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_slack_missing_binding",
      event: {
        ...validEvent,
        id: "evt_thread_slack_missing_binding",
        source: "slack",
        sourceEventId: "slack_thread_missing_binding",
        actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
        callback: {
          provider: "slack",
          uri: "https://slack.com/api/chat.postMessage",
          threadKey: "T123|C123|1719187200.000100"
        },
        metadata: { repoProvider: "github", owner: "acme", repo: "demo", teamId: "T123", channelId: "C123" }
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_slack_missing_binding",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Continue the work.",
          intents: [
            {
              intentId: "intent_continue_slack_missing_binding",
              domain: "follow_up",
              action: "continue_run",
              summary: "Continue in a child run.",
              params: {}
            }
          ]
        }
      ]
    });
    const removedBinding = await app.request("/v1/channel-bindings/slack/T123/C123", { method: "DELETE" });
    expect(removedBinding.status).toBe(204);

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "continue 1",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1719187200.000100"
      }
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unauthorized",
      reason: "channel_binding_mismatch"
    });
  });

  it("rejects Teams apply actions when the source channel binding was removed before mutation", async () => {
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          return Response.json({});
        }
      }
    });
    const conversationId = "19:removed@thread.tacv2";
    const threadKey = `https://smba.trafficmanager.net/amer/|${conversationId}|root-activity`;

    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "teams",
      accountId: "tenant-1",
      conversationId,
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    await seedCompletedProposal({
      app,
      runId: "run_thread_teams_removed_binding",
      event: teamsRepoEvent({
        id: "evt_thread_teams_removed_binding",
        sourceEventId: "teams_thread_removed_binding",
        conversationId,
        threadKey
      }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_teams_removed_binding",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_teams_removed_binding",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const deleteResponse = await app.request(
      `/v1/channel-bindings/teams/tenant-1/${encodeURIComponent(conversationId)}`,
      { method: "DELETE" }
    );
    expect(deleteResponse.status).toBe(204);

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "teams", providerUserId: "aad-user-1", handle: "Ada" },
      callback: {
        provider: "teams",
        uri: "https://smba.trafficmanager.net/amer/",
        threadKey
      }
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unauthorized",
      reason: "channel_binding_mismatch"
    });
    expect(githubRequests).toHaveLength(0);

    const eventsResponse = await app.request("/v1/runs/run_thread_teams_removed_binding/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).not.toContain("approval.decision.recorded");
    expect(events.map((event: { type: string }) => event.type)).not.toContain("apply_plan.created");
  });

  it("rejects Teams reject actions when the source channel was rebound to another repository", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const conversationId = "19:rebound@thread.tacv2";
    const threadKey = `https://smba.trafficmanager.net/amer/|${conversationId}|root-activity`;

    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "teams",
      accountId: "tenant-1",
      conversationId,
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    await seedCompletedProposal({
      app,
      runId: "run_thread_teams_rebound_binding",
      event: teamsRepoEvent({
        id: "evt_thread_teams_rebound_binding",
        sourceEventId: "teams_thread_rebound_binding",
        conversationId,
        threadKey
      }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_teams_rebound_binding",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_teams_rebound_binding",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    const rebindResponse = await app.request("/v1/channel-bindings", jsonRequest({
      provider: "teams",
      accountId: "tenant-1",
      conversationId,
      repoProvider: "github",
      owner: "acme",
      repo: "other-repo"
    }));
    expect(rebindResponse.status).toBe(201);

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "reject 1",
      actor: { provider: "teams", providerUserId: "aad-user-1", handle: "Ada" },
      callback: {
        provider: "teams",
        uri: "https://smba.trafficmanager.net/amer/",
        threadKey
      }
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unauthorized",
      reason: "channel_binding_mismatch"
    });

    const eventsResponse = await app.request("/v1/runs/run_thread_teams_rebound_binding/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).not.toContain("approval.decision.recorded");
    expect(events.map((event: { type: string }) => event.type)).not.toContain("apply_plan.created");
  });

  it("matches a full Teams reply conversation id to a proposal stored with the base conversation id", async () => {
    const githubRequests: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(String(url));
          return Response.json({});
        }
      }
    });
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const baseConversationId = "19:canonical-loop@thread.tacv2";
    const fullConversationId = `${baseConversationId};messageid=root-activity`;
    const baseThreadKey = `${serviceUrl}|${baseConversationId}|root-activity`;
    const fullThreadKey = `${serviceUrl}|${fullConversationId}|root-activity`;

    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "teams",
      accountId: "tenant-1",
      conversationId: baseConversationId,
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    await seedCompletedProposal({
      app,
      runId: "run_thread_teams_canonical_loop",
      event: teamsRepoEvent({
        id: "evt_thread_teams_canonical_loop",
        sourceEventId: "teams_thread_canonical_loop",
        conversationId: baseConversationId,
        threadKey: baseThreadKey
      }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_teams_canonical_loop",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_teams_canonical_loop",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "teams", providerUserId: "aad-user-1", handle: "Ada" },
      callback: {
        provider: "teams",
        uri: serviceUrl,
        threadKey: fullThreadKey
      }
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ outcome: "applied" });
    expect(githubRequests.length).toBeGreaterThan(0);
  });

  it.each([
    { name: "authorizes Teams actions through a base conversation binding", includeExactBinding: false },
    { name: "authorizes Teams actions when exact and base bindings point to the same repository", includeExactBinding: true }
  ])("$name", async ({ includeExactBinding }) => {
    const githubRequests: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(String(url));
          return Response.json({});
        }
      }
    });
    const baseConversationId = "19:base-fallback@thread.tacv2";
    const fullConversationId = `${baseConversationId};messageid=root-activity`;
    const threadKey = `https://smba.trafficmanager.net/amer/|${fullConversationId}|root-activity`;

    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "teams",
      accountId: "tenant-1",
      conversationId: baseConversationId,
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    await seedCompletedProposal({
      app,
      runId: "run_thread_teams_base_binding",
      event: teamsRepoEvent({
        id: "evt_thread_teams_base_binding",
        sourceEventId: "teams_thread_base_binding",
        conversationId: fullConversationId,
        threadKey
      }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_teams_base_binding",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_teams_base_binding",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    if (includeExactBinding) {
      await app.request("/v1/channel-bindings", jsonRequest({
        provider: "teams",
        accountId: "tenant-1",
        conversationId: fullConversationId,
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }));
    }
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "teams", providerUserId: "aad-user-1", handle: "Ada" },
      callback: {
        provider: "teams",
        uri: "https://smba.trafficmanager.net/amer/",
        threadKey
      }
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      decision: { proposalId: "proposal_thread_teams_base_binding" },
      plan: { proposalId: "proposal_thread_teams_base_binding" }
    });
    expect(githubRequests).toEqual(["https://api.github.com/repos/acme/demo/issues/1/labels"]);
  });

  it("rejects Teams actions when exact and base conversation bindings point to different repositories", async () => {
    const githubRequests: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(String(url));
          return Response.json({});
        }
      }
    });
    const baseConversationId = "19:conflicting-bindings@thread.tacv2";
    const fullConversationId = `${baseConversationId};messageid=root-activity`;
    const threadKey = `https://smba.trafficmanager.net/amer/|${fullConversationId}|root-activity`;

    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "teams",
      accountId: "tenant-1",
      conversationId: fullConversationId,
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "teams",
      accountId: "tenant-1",
      conversationId: baseConversationId,
      repoProvider: "github",
      owner: "acme",
      repo: "other-repo"
    }));
    await seedCompletedProposal({
      app,
      runId: "run_thread_teams_conflicting_bindings",
      event: teamsRepoEvent({
        id: "evt_thread_teams_conflicting_bindings",
        sourceEventId: "teams_thread_conflicting_bindings",
        conversationId: fullConversationId,
        threadKey
      }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_teams_conflicting_bindings",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_teams_conflicting_bindings",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "teams", providerUserId: "aad-user-1", handle: "Ada" },
      callback: {
        provider: "teams",
        uri: "https://smba.trafficmanager.net/amer/",
        threadKey
      }
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unauthorized",
      reason: "channel_binding_mismatch"
    });
    expect(githubRequests).toHaveLength(0);
  });

  it("fails closed for Teams proposals missing stored channel identity metadata", async () => {
    for (const missing of ["tenantId", "conversationId"] as const) {
      const app = createDispatcherApp({ databasePath: ":memory:" });
      const suffix = missing === "tenantId" ? "tenant" : "conversation";
      const conversationId = `19:missing-${suffix}@thread.tacv2`;
      const threadKey = `https://smba.trafficmanager.net/amer/|${conversationId}|root-activity`;

      await seedCompletedProposal({
        app,
        runId: `run_thread_teams_missing_${suffix}`,
        event: teamsRepoEvent({
          id: `evt_thread_teams_missing_${suffix}`,
          sourceEventId: `teams_thread_missing_${suffix}`,
          conversationId,
          threadKey,
          ...(missing === "tenantId" ? { omitTenantId: true } : { omitConversationId: true })
        }),
        suggestedChanges: [
          {
            proposalId: `proposal_thread_teams_missing_${suffix}`,
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Label the bug.",
            intents: [
              {
                intentId: `intent_teams_missing_${suffix}`,
                domain: "labels",
                action: "add_label",
                summary: "Add the bug label.",
                params: { label: "bug" }
              }
            ]
          }
        ]
      });

      const response = await app.request("/v1/thread-actions", jsonRequest({
        rawText: "apply 1",
        actor: { provider: "teams", providerUserId: "aad-user-1", handle: "Ada" },
        callback: {
          provider: "teams",
          uri: "https://smba.trafficmanager.net/amer/",
          threadKey
        }
      }));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        outcome: "unauthorized",
        reason: "channel_binding_mismatch"
      });
      const eventsResponse = await app.request(`/v1/runs/run_thread_teams_missing_${suffix}/events`);
      const { events } = await eventsResponse.json();
      expect(events.map((event: { type: string }) => event.type)).not.toContain("approval.decision.recorded");
      expect(events.map((event: { type: string }) => event.type)).not.toContain("apply_plan.created");
    }
  });

  it("does not replay Slack source delivery ids when creating action fallback child runs", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const parentEvent = slackRepoEvent({
      id: "evt_thread_slack_fallback_delivery",
      sourceEventId: "slack_thread_fallback_delivery",
      threadKey: "T123|C123|1710000000.000100"
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_slack_fallback_delivery",
      event: {
        ...parentEvent,
        metadata: {
          ...parentEvent.metadata,
          sourceDeliveryId: "EvSlackFallbackDelivery",
          slackEventId: "EvSlackFallbackDelivery"
        }
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_slack_fallback_delivery",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Ask for review.",
          intents: [
            {
              intentId: "intent_slack_fallback_delivery",
              domain: "review",
              action: "request_review",
              summary: "Ask a human to review the result.",
              params: { surface: "slack" }
            }
          ]
        }
      ]
    });
    await app.request("/v1/slack-channel-bindings", jsonRequest({
      teamId: "T123",
      channelId: "C123",
      owner: "acme",
      repo: "demo"
    }));

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      }
    }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      run: {
        parentRunId: "run_thread_slack_fallback_delivery",
        sourceProposalId: "proposal_thread_slack_fallback_delivery"
      }
    });
    expect(body.run.id).not.toBe("run_thread_slack_fallback_delivery");
    expect(body.run.sourceApplyPlanId).toBe(body.plan.id);

    const parentEvents = await app.request("/v1/runs/run_thread_slack_fallback_delivery/events");
    const { events } = await parentEvents.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("run.child_created");

    const child = await app.request(`/v1/runs/${body.run.id}`);
    expect(child.status).toBe(200);
    const stored = await child.json();
    expect(stored.event.id).toBe(`evt_${body.run.id}`);
    expect(stored.event.sourceEventId).toContain(body.run.id);
    expect(stored.event.metadata).toMatchObject({
      parentRunId: "run_thread_slack_fallback_delivery",
      sourceProposalId: "proposal_thread_slack_fallback_delivery",
      sourceApplyPlanId: body.plan.id
    });
    expect(stored.event.metadata).not.toHaveProperty("sourceDeliveryId");
    expect(stored.event.metadata).not.toHaveProperty("slackEventId");
  });

  it("does not reuse a provided approval id for a different selected action", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_approval_id_conflict",
      event: githubIssueEvent({ id: "evt_thread_approval_id_conflict", sourceEventId: "comment_thread_approval_id_conflict", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_approval_id_conflict",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the issue.",
          intents: [
            {
              intentId: "intent_label_bug_conflict",
              domain: "labels",
              action: "add_label",
              summary: "Add bug label.",
              params: { label: "bug" }
            },
            {
              intentId: "intent_label_help_conflict",
              domain: "labels",
              action: "add_label",
              summary: "Add help wanted label.",
              params: { label: "help wanted" }
            }
          ]
        }
      ]
    });

    const first = await app.request("/v1/thread-actions", jsonRequest({
      id: "approval_ingress_retry_id",
      rawText: "approve 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      decision: { id: "approval_ingress_retry_id", approvedIntentIds: ["intent_label_bug_conflict"] }
    });

    const second = await app.request("/v1/thread-actions", jsonRequest({
      id: "approval_ingress_retry_id",
      rawText: "approve 2",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.decision).toMatchObject({ approvedIntentIds: ["intent_label_help_conflict"] });
    expect(secondBody.decision.id).not.toBe("approval_ingress_retry_id");
  });

  it("records approve-only and reject replies with compact source-thread receipts", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_record_receipts",
      event: githubIssueEvent({ id: "evt_thread_record_receipts", sourceEventId: "comment_thread_record_receipts", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_record_receipts",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the issue.",
          intents: [
            {
              intentId: "intent_label_bug_receipt",
              domain: "labels",
              action: "add_label",
              summary: "Add bug label.",
              params: { label: "bug" }
            },
            {
              intentId: "intent_label_help_receipt",
              domain: "labels",
              action: "add_label",
              summary: "Add help wanted label.",
              params: { label: "help wanted" }
            }
          ]
        }
      ]
    });

    const baseAction = {
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    };
    const approve = await app.request("/v1/thread-actions", jsonRequest({ ...baseAction, rawText: "approve 1" }));
    const reject = await app.request("/v1/thread-actions", jsonRequest({ ...baseAction, rawText: "reject 2" }));

    expect(approve.status).toBe(201);
    expect(reject.status).toBe(201);
    expect(delivered.some((message) => message.body.includes("Approved only: Add bug label."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("No external write was performed."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("Direct apply is not available yet: GitHub apply is not configured on this dispatcher."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("Next: reply `continue 1`"))).toBe(true);
    expect(delivered.some((message) => message.body.includes("Next: reply `apply 1`"))).toBe(false);
    expect(delivered.some((message) => message.body.includes("Rejected: Add help wanted label."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("No external write will be performed for this action."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("proposal_thread_record_receipts"))).toBe(false);
    expect(delivered.some((message) => message.body.includes("intent_label_bug_receipt"))).toBe(false);
  });

  it("keeps the approve-only apply hint only when direct apply preflight is ready", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: Array<{ url: string; method?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({ url: String(url), method: init?.method });
          return Response.json({});
        }
      }
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_approve_ready",
      event: githubIssueEvent({ id: "evt_thread_approve_ready", sourceEventId: "comment_thread_approve_ready", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_approve_ready",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the issue.",
          intents: [
            {
              intentId: "intent_label_bug_approve_ready",
              domain: "labels",
              action: "add_label",
              summary: "Add bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "approve 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));

    expect(response.status).toBe(201);
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1",
        method: "GET"
      }
    ]);
    expect(delivered.at(-1)?.body).toContain("Approved only: Add bug label.");
    expect(delivered.at(-1)?.body).toContain("No external write was performed.");
    expect(delivered.at(-1)?.body).toContain("Next: reply `apply 1` to write it to the system of record");
    expect(delivered.at(-1)?.body).not.toContain("Direct apply is not available yet");
  });

  it("rejects explicit proposal action replies from the wrong source thread", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_cross",
      event: githubIssueEvent({ id: "evt_thread_cross", sourceEventId: "comment_thread_cross", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_cross",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply proposal_thread_cross",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/99/comments",
        threadKey: "acme/demo#wrong"
      }
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "no_match"
    });
  });

  it("applies a model-suggested GitHub PR review request from a source-thread reply", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_review",
      event: githubPullRequestEvent({ id: "evt_thread_review", sourceEventId: "comment_thread_review", threadKey: "acme/demo#2" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_review",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Request PR review.",
          intents: [
            {
              intentId: "intent_review_alice",
              domain: "review",
              action: "request_review",
              summary: "Request Alice's review.",
              params: { reviewer: "alice" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/2/comments",
        threadKey: "acme/demo#2"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        proposalId: "proposal_thread_review",
        outcomes: [
          {
            intentId: "intent_review_alice",
            outcome: "applied",
            externalUri: "https://github.com/acme/demo/pull/2"
          }
        ]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls/2/requested_reviewers",
        method: "GET",
        authorization: "Bearer gh_test"
      },
      {
        url: "https://api.github.com/repos/acme/demo/pulls/2/requested_reviewers",
        method: "POST",
        body: { reviewers: ["alice"] },
        authorization: "Bearer gh_test"
      }
    ]);
  });

  it("applies a model-suggested create PR action from a source-thread reply", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({ html_url: "https://github.com/acme/demo/pull/42" });
        }
      }
    });

    const event = githubIssueEvent({ id: "evt_thread_create_pr", sourceEventId: "comment_thread_create_pr", threadKey: "acme/demo#1" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_create_pr",
      event: {
        ...event,
        permissions: [...event.permissions, { scope: "pr:create", reason: "create an approved pull request" }]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_create_pr",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a pull request for the generated branch.",
          intents: [
            {
              intentId: "intent_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create PR for branch opentag/run_thread_create_pr.",
              params: {
                title: "OpenTag run run_thread_create_pr",
                body: "PR body",
                head: "opentag/run_thread_create_pr",
                base: "main",
                changedFiles: ["src/demo.ts"],
                verification: [{ command: "pnpm test", outcome: "passed" }],
                risks: ["Review before merge."],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        proposalId: "proposal_thread_create_pr",
        outcomes: [
          {
            intentId: "intent_create_pr",
            outcome: "applied",
            externalUri: "https://github.com/acme/demo/pull/42"
          }
        ]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls",
        method: "POST",
        authorization: "Bearer gh_test",
        body: {
          title: "OpenTag run run_thread_create_pr",
          body: [
            "PR body",
            "",
            "## Changed Files",
            "- `src/demo.ts`",
            "",
            "## Risks",
            "- Review before merge.",
            "",
            "## Verification",
            "- `pnpm test`: passed",
            "",
            "## Executor Conditions",
            "- isolated branch exists"
          ].join("\n"),
          head: "opentag/run_thread_create_pr",
          base: "main"
        }
      }
    ]);
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("https://github.com/acme/demo/pull/42"))).toBe(true);
  });

  it("falls back with a quiet receipt when GitHub PR creation fails", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          if (init?.method === "POST") {
            return new Response("Validation Failed: pull request already exists for this head; token ghp_aaaaaaaaaaaaaaaaaaaa; path /home/alice/repos/demo", {
              status: 422
            });
          }
          return Response.json({ name: String(url).split("/").at(-1) });
        }
      }
    });

    const event = githubIssueEvent({ id: "evt_thread_create_pr_failed", sourceEventId: "comment_thread_create_pr_failed", threadKey: "acme/demo#1" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_create_pr_failed",
      event: {
        ...event,
        permissions: [...event.permissions, { scope: "pr:create", reason: "create an approved pull request" }]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_create_pr_failed",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a pull request for the generated branch.",
          intents: [
            {
              intentId: "intent_create_pr_failed",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create PR for branch opentag/run_thread_create_pr_failed.",
              params: {
                title: "OpenTag run run_thread_create_pr_failed",
                body: "PR body",
                head: "opentag/run_thread_create_pr_failed",
                base: "main",
                changedFiles: ["src/demo.ts"],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("Ready to apply"))).toBe(true);
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      plan: {
        proposalId: "proposal_thread_create_pr_failed",
        outcomes: [
          {
            intentId: "intent_create_pr_failed",
            outcome: "failed",
            error: "create pull request failed: 422 Validation Failed: pull request already exists for this head; token [redacted]; path [redacted local path]"
          }
        ]
      },
      run: {
        parentRunId: "run_thread_create_pr_failed",
        sourceProposalId: "proposal_thread_create_pr_failed"
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls",
        method: "POST",
        authorization: "Bearer gh_test",
        body: {
          title: "OpenTag run run_thread_create_pr_failed",
          body: ["PR body", "", "## Changed Files", "- `src/demo.ts`", "", "## Executor Conditions", "- isolated branch exists"].join("\n"),
          head: "opentag/run_thread_create_pr_failed",
          base: "main"
        }
      }
    ]);
    const finalMessage = delivered.at(-1)?.body ?? "";
    expect(finalMessage).toContain("Needs setup before OpenTag can apply this action directly.");
    expect(finalMessage).toContain("Child run:");
    expect(finalMessage).toContain("Reason: Direct apply failed: create pull request failed: 422 Validation Failed: pull request already exists for this head");
    expect(finalMessage).toContain("token [redacted]");
    expect(finalMessage).toContain("path [redacted local path]");
    expect(finalMessage).not.toContain("proposal_thread_create_pr_failed");
    expect(finalMessage).not.toContain("intent_create_pr_failed");
    expect(finalMessage).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaa");
    expect(finalMessage).not.toContain("/home/alice/repos/demo");
    expect(finalMessage).not.toContain("gh_test");
    expect(finalMessage).not.toContain("authorization");
  });

  it("resumes a repo-less ACP permission through the managed source-thread approval path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-reconciliation-fences-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "dispatcher.sqlite");
    const delivered: CallbackMessage[] = [];
    const app = createDispatcherApp({
      databasePath,
      callbackSink: { async deliver(message) { delivered.push(message); return { handled: true, outcome: "accepted" } as const; } }
    });
    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }));
    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "slack", accountId: "T123", conversationId: "C456", metadata: { allowedActors: ["slack:U123"] }
    }));
    const event = {
      id: "evt_acp_permission",
      source: "slack",
      sourceEventId: "msg_acp_permission",
      receivedAt: "2026-07-12T00:00:00.000Z",
      actor: { provider: "slack", providerUserId: "U123", handle: "alice" },
      target: { mention: "@opentag", agentId: "opentag", executorHint: "custom" },
      command: { rawText: "publish the report", intent: "run", args: {} },
      context: [],
      permissions: [],
      callback: { provider: "slack", uri: "https://example.com/slack/callback", threadKey: "T123|C456|171.1" },
      metadata: { teamId: "T123", channelId: "C456" }
    };
    const createRunResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_acp_permission", event }));
    expect(createRunResponse.status, await createRunResponse.clone().text()).toBe(201);
    const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const claim = await claimResponse.json() as { attemptId: string; fencingToken: string };
    const lease = { attemptId: claim.attemptId, fencingToken: claim.fencingToken };
    await app.request("/v1/runners/runner_1/runs/run_acp_permission/running", jsonRequest({ ...lease, executor: "fixture-agent" }));

    const permissionRequest = {
      toolCallId: "tool_publish",
      title: "Publish report",
      kind: "publish",
      provider: "connector",
      connectionId: "connector:team",
      operation: "publish",
      resource: "report:123",
      targetFingerprint: `sha256:${"a".repeat(64)}`,
      permissionScopes: ["report:publish"],
      mode: "ask"
    };
    const requested = await app.request("/v1/runners/runner_1/runs/run_acp_permission/action-permissions", jsonRequest({
      ...lease,
      request: permissionRequest
    }));
    expect(requested.status).toBe(202);
    const requestedBody = await requested.json() as { resolution: { action: { id: string; proposalId: string; proposalHash: string } } };
    const actionId = requestedBody.resolution.action.id;
    const proposalId = requestedBody.resolution.action.proposalId;
    await expect((await app.request("/v1/runs/run_acp_permission")).json()).resolves.toMatchObject({ run: { status: "needs_approval" } });
    expect(delivered.some((message) => message.body.includes("Publish report"))).toBe(true);
    const approvalActions = delivered.at(-1)?.blocks?.find((block) => block.type === "actions");
    if (!approvalActions || approvalActions.type !== "actions") throw new Error("expected native Slack approval actions");
    const allowRunPayload = parseSlackSuggestedActionButtonValue(approvalActions.elements[1]!.value);
    expect(allowRunPayload).toMatchObject({
      command: "approve 1",
      permissionDecision: "allow_run",
      proposalId,
      intentId: `intent_${actionId}`,
      actionId,
      proposalHash: requestedBody.resolution.action.proposalHash,
      approvalEpoch: expect.any(String)
    });

    const actionRequest = {
      rawText: allowRunPayload!.command,
      actor: { provider: "slack", providerUserId: "U123", handle: "alice" },
      callback: { provider: "slack", uri: "https://example.com/slack/callback", threadKey: "T123|C456|171.1" },
      metadata: {
        teamId: "T123",
        channelId: "C456",
        proposalId: allowRunPayload!.proposalId,
        intentId: allowRunPayload!.intentId,
        permissionDecision: allowRunPayload!.permissionDecision,
        proposalHash: allowRunPayload!.proposalHash,
        approvalEpoch: allowRunPayload!.approvalEpoch,
        governedActionId: allowRunPayload!.actionId
      }
    };
    const unauthorized = await app.request("/v1/thread-actions", jsonRequest({
      ...actionRequest,
      actor: { provider: "slack", providerUserId: "U999", handle: "mallory" }
    }));
    expect(unauthorized.status).toBe(403);
    const approval = await app.request("/v1/thread-actions", jsonRequest(actionRequest));
    expect(approval.status).toBe(201);
    expect(delivered.at(-1)?.body).toContain("Allowed for this run: Publish report.");
    expect(delivered.at(-1)?.body).toContain("The agent may now perform this governed action.");
    expect(delivered.at(-1)?.body).not.toContain("Approved only");
    expect(delivered.at(-1)?.body).not.toContain("Direct apply");
    expect(delivered.at(-1)?.body).not.toContain("continue 1");

    const resolved = await app.request(`/v1/runners/runner_1/runs/run_acp_permission/action-permissions/${actionId}/resolve`, jsonRequest(lease));
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({ resolution: { state: "authorized", decision: "allow_run", action: { status: "executing" } } });
    await expect((await app.request("/v1/runs/run_acp_permission")).json()).resolves.toMatchObject({ run: { status: "running" } });

    const trustedReceipt = await app.request(`/v1/runners/runner_1/runs/run_acp_permission/material-actions/${actionId}/receipt`, jsonRequest({
      ...lease,
      receipt: {
        id: "receipt_connector_publish",
        actionId,
        provider: "connector",
        connectionId: "connector:team",
        targetFingerprint: `sha256:${"a".repeat(64)}`,
        receiptRef: "connector:publish:report-123",
        outcome: "succeeded",
        observedAt: "2026-07-12T00:02:00.000Z",
        metadata: { assurance: "trusted_provider", providerOperationId: "report-123" }
      }
    }));
    expect(trustedReceipt.status).toBe(200);
    await expect(trustedReceipt.json()).resolves.toMatchObject({ resolution: { state: "reconciled", action: { status: "succeeded" }, receipt: { id: "receipt_connector_publish" } } });

    const duplicate = await app.request("/v1/runners/runner_1/runs/run_acp_permission/action-permissions", jsonRequest({
      ...lease,
      request: { ...permissionRequest, toolCallId: "tool_publish_retry" }
    }));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ resolution: { state: "reconciled", decision: "deny", receipt: { id: "receipt_connector_publish" } } });

    const unknownPermissionRequest = {
      ...permissionRequest,
      toolCallId: "tool_publish_unknown",
      resource: "report:unknown",
      targetFingerprint: `sha256:${"b".repeat(64)}`,
      mode: "autonomous" as const
    };
    const unknownRequest = await app.request("/v1/runners/runner_1/runs/run_acp_permission/action-permissions", jsonRequest({
      ...lease,
      request: unknownPermissionRequest
    }));
    const unknownBody = await unknownRequest.json() as { resolution: { action: { id: string } } };
    expect(unknownRequest.status).toBe(200);
    const unknownReceipt = await app.request(`/v1/runners/runner_1/runs/run_acp_permission/material-actions/${unknownBody.resolution.action.id}/receipt`, jsonRequest({
      ...lease,
      receipt: {
        id: "receipt_acp_unknown",
        actionId: unknownBody.resolution.action.id,
        provider: "acp",
        receiptRef: "acp:session:tool_publish_unknown",
        outcome: "unknown",
        observedAt: new Date().toISOString()
      }
    }));
    expect(unknownReceipt.status).toBe(200);
    const expiryDb = new Database(databasePath);
    expiryDb.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "run_acp_permission");
    expiryDb.prepare("UPDATE attempts SET lease_expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", lease.attemptId);
    expiryDb.close();
    const secondClaimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(secondClaimResponse.status).toBe(200);
    const secondClaim = await secondClaimResponse.json() as { attemptId: string; fencingToken: string };
    expect(secondClaim.attemptId).not.toBe(lease.attemptId);
    expect(secondClaim.fencingToken).not.toBe(lease.fencingToken);
    const deliveriesBeforeReconciliation = delivered.length;
    const privateKeyBody = "private-key-body-that-must-not-persist";
    const reconciliationBody = {
      outcome: "succeeded",
      idempotencyKey: "provider-check-report-unknown",
      receiptRef: "connector:publish:report-unknown",
      evidence: [{
        id: "provider-check-1",
        kind: "provider_lookup",
        assurance: "verified",
        subjectRef: "report:unknown",
        summary: [
          `Provider confirms success; first fence ${lease.fencingToken}; second fence ${secondClaim.fencingToken}; authorization=Bearer callback-secret`,
          `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n-----END PRIVATE KEY-----`
        ].join("\n"),
        createdAt: new Date().toISOString()
      }]
    };
    const [reconciled, replayed] = await Promise.all([
      app.request(`/v1/material-actions/${unknownBody.resolution.action.id}/reconcile`, jsonRequest(reconciliationBody)),
      app.request(`/v1/material-actions/${unknownBody.resolution.action.id}/reconcile`, jsonRequest(reconciliationBody))
    ]);
    expect([reconciled.status, replayed.status]).toEqual([200, 200]);
    const reconciledPayload = await reconciled.json();
    const replayedPayload = await replayed.json();
    expect(delivered).toHaveLength(deliveriesBeforeReconciliation + 1);
    const publicActionResponse = await app.request("/v1/runners/runner_1/runs/run_acp_permission/action-permissions", jsonRequest({
      ...secondClaim,
      request: { ...unknownPermissionRequest, toolCallId: "tool_publish_unknown_after_reconciliation" }
    }));
    expect(publicActionResponse.status).toBe(200);
    const publicActionPayload = await publicActionResponse.json();
    const runEventsPayload = await (await app.request("/v1/runs/run_acp_permission/events")).json();
    const controlPlanePayload = await (await app.request("/v1/control-plane-events?type=material_action.reconciled")).json();
    const inspectionDb = new Database(databasePath, { readonly: true });
    const receiptRow = inspectionDb.prepare("SELECT receipt_json FROM material_actions WHERE id = ?").get(unknownBody.resolution.action.id) as { receipt_json: string };
    inspectionDb.close();
    const exposedSurfaces = {
      reconciledPayload,
      replayedPayload,
      receiptRow,
      publicActionPayload,
      runEventsPayload,
      controlPlanePayload,
      callbackDeliveryAndProviderPayload: delivered.at(-1)
    };
    const exposedJson = JSON.stringify(exposedSurfaces);
    for (const secret of [lease.fencingToken, secondClaim.fencingToken, "callback-secret", privateKeyBody]) {
      expect(exposedJson).not.toContain(secret);
    }
    expect(exposedSurfaces.callbackDeliveryAndProviderPayload).toMatchObject({
      kind: "progress",
      provider: "slack",
      uri: "https://example.com/slack/callback",
      body: expect.stringContaining("reconciled as succeeded")
    });
    expect(exposedSurfaces.reconciledPayload).toMatchObject({ result: { action: { receipt: { evidence: [{ summary: expect.stringContaining("[redacted]") }] } } } });
    const conflictingReconciliation = await app.request(`/v1/material-actions/${unknownBody.resolution.action.id}/reconcile`, jsonRequest({
      ...reconciliationBody,
      outcome: "failed",
      idempotencyKey: "provider-check-conflict"
    }));
    expect(conflictingReconciliation.status).toBe(409);
    expect(delivered).toHaveLength(deliveriesBeforeReconciliation + 1);
  });

  it("applies a model-suggested create PR action from a GitLab source-thread reply as an MR", async () => {
    const gitlabRequests: Array<{ url: string; method?: string; body?: unknown; token?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      gitlabApply: {
        token: "glpat_test",
        baseUrl: "https://gitlab.example.com",
        fetchImpl: async (url, init) => {
          gitlabRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            token: new Headers(init?.headers).get("PRIVATE-TOKEN")
          });
          if (init?.method === "GET") {
            return Response.json({ name: String(url).split("/").at(-1) });
          }
          return Response.json({ web_url: "https://gitlab.example.com/acme/demo/-/merge_requests/42" });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_create_mr",
      event: gitlabIssueEvent({ id: "evt_thread_create_mr", sourceEventId: "note_thread_create_mr", threadKey: "acme/demo|issue|1" }),
      repoBinding: { provider: "gitlab", owner: "acme", repo: "demo" },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_create_mr",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a merge request for the generated branch.",
          intents: [
            {
              intentId: "intent_create_mr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create MR for branch opentag/run_thread_create_mr.",
              params: {
                title: "OpenTag run run_thread_create_mr",
                body: "MR body",
                head: "opentag/run_thread_create_mr",
                base: "main",
                changedFiles: ["src/demo.ts"],
                verification: [{ command: "pnpm test", outcome: "passed" }],
                risks: ["Review before merge."],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("### Ready to apply"))).toBe(true);
    gitlabRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "gitlab", providerUserId: "7", handle: "alice" },
      callback: {
        provider: "gitlab",
        uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        threadKey: "acme/demo|issue|1"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        adapter: "gitlab",
        proposalId: "proposal_thread_create_mr",
        outcomes: [
          {
            intentId: "intent_create_mr",
            outcome: "applied",
            externalUri: "https://gitlab.example.com/acme/demo/-/merge_requests/42"
          }
        ]
      }
    });
    expect(gitlabRequests).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/merge_requests",
        method: "POST",
        token: "glpat_test",
        body: {
          title: "OpenTag run run_thread_create_mr",
          description: [
            "MR body",
            "",
            "## Changed Files",
            "- `src/demo.ts`",
            "",
            "## Risks",
            "- Review before merge.",
            "",
            "## Verification",
            "- `pnpm test`: passed",
            "",
            "## Executor Conditions",
            "- isolated branch exists"
          ].join("\n"),
          source_branch: "opentag/run_thread_create_mr",
          target_branch: "main"
        }
      }
    ]);
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("https://gitlab.example.com/acme/demo/-/merge_requests/42"))).toBe(true);
  });

  it("applies a model-suggested Linear issue priority update from a Linear source-thread reply", async () => {
    const linearRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      linearApply: {
        async getToken() {
          return "Bearer refreshed_app_token";
        },
        mappings: [
          {
            id: "linear_priority_priority",
            adapter: "linear",
            domain: "priority",
            strategy: "priority",
            values: { high: "2" }
          }
        ],
        fetchImpl: async (url, init) => {
          linearRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({
            data: {
              issueUpdate: {
                success: true,
                issue: { id: "issue_123", url: "https://linear.app/acme/issue/ENG-1/demo" }
              }
            }
          });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_linear_comment",
      event: linearIssueEvent({ id: "evt_linear_comment", sourceEventId: "linear_comment_1", threadKey: "ENG|issue|ENG-1" }),
      repoBinding: { provider: "github", owner: "acme", repo: "demo" },
      suggestedChanges: [
        {
          proposalId: "proposal_linear_comment",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Update Linear issue priority.",
          intents: [
            {
              intentId: "intent_linear_comment",
              domain: "priority",
              action: "set_priority",
              summary: "Set Linear issue priority to high.",
              params: {
                priority: "high"
              }
            }
          ]
        }
      ]
    });
    linearRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "linear", providerUserId: "user_1", handle: "alice" },
      callback: {
        provider: "linear",
        uri: "linear://issue/issue_123/comments",
        threadKey: "ENG|issue|ENG-1"
      }
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        adapter: "linear",
        proposalId: "proposal_linear_comment",
        outcomes: [
          {
            intentId: "intent_linear_comment",
            outcome: "applied",
            externalUri: "https://linear.app/acme/issue/ENG-1/demo"
          }
        ]
      }
    });
    expect(linearRequests).toHaveLength(1);
    expect(linearRequests[0]).toMatchObject({
      url: "https://linear.example/graphql",
      method: "POST",
      authorization: "Bearer refreshed_app_token",
      body: {
        variables: {
          id: "issue_123",
          input: {
            priority: 2
          }
        }
      }
    });
    expect(String((linearRequests[0]!.body as { query: string }).query)).toContain("issueUpdate");
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("https://linear.app/acme/issue/ENG-1/demo"))).toBe(true);
  });

  it("falls back with a quiet receipt when GitLab MR creation fails", async () => {
    const gitlabRequests: Array<{ url: string; method?: string; body?: unknown; token?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      gitlabApply: {
        token: "glpat_test",
        baseUrl: "https://gitlab.example.com",
        fetchImpl: async (url, init) => {
          gitlabRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            token: new Headers(init?.headers).get("PRIVATE-TOKEN")
          });
          if (init?.method === "POST") {
            return new Response("A merge request already exists for this source branch; token glpat-aaaaaaaaaaaaaaaaaaaa; path C:\\Users\\alice\\repo", {
              status: 409
            });
          }
          return Response.json({ name: String(url).split("/").at(-1) });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_create_mr_failed",
      event: gitlabIssueEvent({ id: "evt_thread_create_mr_failed", sourceEventId: "note_thread_create_mr_failed", threadKey: "acme/demo|issue|1" }),
      repoBinding: { provider: "gitlab", owner: "acme", repo: "demo" },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_create_mr_failed",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a merge request for the generated branch.",
          intents: [
            {
              intentId: "intent_create_mr_failed",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create MR for branch opentag/run_thread_create_mr_failed.",
              params: {
                title: "OpenTag run run_thread_create_mr_failed",
                body: "MR body",
                head: "opentag/run_thread_create_mr_failed",
                base: "main",
                changedFiles: ["src/demo.ts"],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("Ready to apply"))).toBe(true);
    gitlabRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "gitlab", providerUserId: "7", handle: "alice" },
      callback: {
        provider: "gitlab",
        uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        threadKey: "acme/demo|issue|1"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      plan: {
        adapter: "gitlab",
        proposalId: "proposal_thread_create_mr_failed",
        outcomes: [
          {
            intentId: "intent_create_mr_failed",
            outcome: "failed",
            error: "create merge request failed: 409 A merge request already exists for this source branch; token [redacted]; path [redacted local path]"
          }
        ]
      },
      run: {
        parentRunId: "run_thread_create_mr_failed",
        sourceProposalId: "proposal_thread_create_mr_failed"
      }
    });
    expect(gitlabRequests).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/merge_requests",
        method: "POST",
        token: "glpat_test",
        body: {
          title: "OpenTag run run_thread_create_mr_failed",
          description: ["MR body", "", "## Changed Files", "- `src/demo.ts`", "", "## Executor Conditions", "- isolated branch exists"].join("\n"),
          source_branch: "opentag/run_thread_create_mr_failed",
          target_branch: "main"
        }
      }
    ]);
    const finalMessage = delivered.at(-1)?.body ?? "";
    expect(finalMessage).toContain("Needs setup before OpenTag can apply this action directly.");
    expect(finalMessage).toContain("Child run:");
    expect(finalMessage).toContain("Reason: Direct apply failed: create merge request failed: 409 A merge request already exists for this source branch");
    expect(finalMessage).toContain("token [redacted]");
    expect(finalMessage).toContain("path [redacted local path]");
    expect(finalMessage).not.toContain("proposal_thread_create_mr_failed");
    expect(finalMessage).not.toContain("intent_create_mr_failed");
    expect(finalMessage).not.toContain("glpat-aaaaaaaaaaaaaaaaaaaa");
    expect(finalMessage).not.toContain("C:\\Users\\alice\\repo");
    expect(finalMessage).not.toContain("glpat_test");
    expect(finalMessage).not.toContain("PRIVATE-TOKEN");
  });

  it("routes repo-level create_pull_request actions from Slack threads to the GitHub adapter", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({ html_url: "https://github.com/acme/demo/pull/43" });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_slack_create_pr",
      event: slackRepoEvent({ id: "evt_slack_create_pr", sourceEventId: "slack_thread_create_pr", threadKey: "T123|C123|1710000000.000100" }),
      suggestedChanges: [
        {
          proposalId: "proposal_slack_create_pr",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a pull request for the generated branch.",
          intents: [
            {
              intentId: "intent_slack_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create PR for branch opentag/run_slack_create_pr.",
              params: {
                title: "OpenTag run run_slack_create_pr",
                body: "PR body",
                head: "opentag/run_slack_create_pr",
                base: "main",
                changedFiles: ["README.md"],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    const bindingResponse = await app.request("/v1/slack-channel-bindings", jsonRequest({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    expect(bindingResponse.status).toBe(201);
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        adapter: "github",
        proposalId: "proposal_slack_create_pr",
        outcomes: [
          {
            intentId: "intent_slack_create_pr",
            outcome: "applied",
            externalUri: "https://github.com/acme/demo/pull/43"
          }
        ]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls",
        method: "POST",
        authorization: "Bearer gh_test",
        body: {
          title: "OpenTag run run_slack_create_pr",
          body: ["PR body", "", "## Changed Files", "- `README.md`", "", "## Executor Conditions", "- isolated branch exists"].join("\n"),
          head: "opentag/run_slack_create_pr",
          base: "main"
        }
      }
    ]);
    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("https://github.com/acme/demo/pull/43"));
    expect(finalMessage?.body).toContain("Applied: Create PR for branch opentag/run_slack_create_pr.");
    expect(finalMessage?.body).not.toContain("..");
    expect(finalMessage?.body).not.toContain("proposal_slack_create_pr");
    expect(finalMessage?.body).not.toContain("intent_slack_create_pr");
  });

  it("routes Slack source-thread Linear issue creation through the Linear adapter", async () => {
    const linearRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      linearApply: {
        token: "Bearer linear_app_token",
        graphqlUrl: "https://linear.example/graphql",
        mappings: [
          {
            id: "linear_team",
            adapter: "linear",
            domain: "team",
            strategy: "team_id",
            values: { eng: "team_eng" }
          },
          {
            id: "linear_priority",
            adapter: "linear",
            domain: "priority",
            strategy: "priority",
            values: { high: "2" }
          },
          {
            id: "linear_label",
            adapter: "linear",
            domain: "label",
            strategy: "label_id",
            values: { bug: "label_bug" }
          }
        ],
        fetchImpl: async (url, init) => {
          linearRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: "issue_created",
                  url: "https://linear.app/acme/issue/ENG-456/fix-oauth-callback-error"
                }
              }
            }
          });
        }
      }
    });

    const event = slackRepoEvent({
      id: "evt_slack_create_linear_issue",
      sourceEventId: "slack_thread_create_linear_issue",
      threadKey: "T123|C123|1710000000.000100"
    });
    await seedCompletedProposal({
      app,
      runId: "run_slack_create_linear_issue",
      event: {
        ...event,
        permissions: [
          ...event.permissions,
          { scope: "issue:create", reason: "create a Linear issue after source-thread approval" }
        ]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_slack_create_linear_issue",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a Linear issue from the Slack thread.",
          intents: [
            {
              intentId: "intent_slack_create_linear_issue",
              domain: "issue",
              action: "create_issue",
              summary: "Create a Linear issue for the OAuth callback error.",
              params: {
                title: "Fix OAuth callback error",
                body: "Created from a Slack thread.",
                teamKey: "ENG",
                priority: "high",
                labels: ["bug"]
              }
            }
          ]
        }
      ]
    });
    const bindingResponse = await app.request("/v1/slack-channel-bindings", jsonRequest({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    expect(bindingResponse.status).toBe(201);
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("Ready to apply"))).toBe(true);
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("Create a Linear issue"))).toBe(true);
    linearRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        adapter: "linear",
        proposalId: "proposal_slack_create_linear_issue",
        outcomes: [
          {
            intentId: "intent_slack_create_linear_issue",
            outcome: "applied",
            externalId: "issue_created",
            externalUri: "https://linear.app/acme/issue/ENG-456/fix-oauth-callback-error"
          }
        ]
      }
    });
    expect(linearRequests).toHaveLength(1);
    expect(linearRequests[0]).toMatchObject({
      url: "https://linear.example/graphql",
      method: "POST",
      authorization: "Bearer linear_app_token",
      body: {
        variables: {
          input: {
            title: "Fix OAuth callback error",
            description: "Created from a Slack thread.",
            teamId: "team_eng",
            priority: 2,
            labelIds: ["label_bug"]
          }
        }
      }
    });
    expect(String((linearRequests[0]!.body as { query: string }).query)).toContain("issueCreate");
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("https://linear.app/acme/issue/ENG-456/fix-oauth-callback-error"))).toBe(true);

    const repeated = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      }
    }));
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({ outcome: "already_applied" });
    expect(linearRequests).toHaveLength(1);
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("No external write was repeated."))).toBe(true);
  });

  it("falls back to a child run when a PR review request lacks reviewer params", async () => {
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_review_missing_reviewer",
      event: githubPullRequestEvent({
        id: "evt_thread_review_missing_reviewer",
        sourceEventId: "comment_thread_review_missing_reviewer",
        threadKey: "acme/demo#2"
      }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_review_missing_reviewer",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Request PR review.",
          intents: [
            {
              intentId: "intent_review_missing_reviewer",
              domain: "review",
              action: "request_review",
              summary: "Request review.",
              params: {}
            }
          ]
        }
      ]
    });

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/2/comments",
        threadKey: "acme/demo#2"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "child_run_created",
      plan: {
        proposalId: "proposal_thread_review_missing_reviewer",
        outcomes: [{ intentId: "intent_review_missing_reviewer", outcome: "failed" }]
      },
      run: {
        parentRunId: "run_thread_review_missing_reviewer",
        sourceProposalId: "proposal_thread_review_missing_reviewer"
      }
    });
    expect(githubRequests).toHaveLength(0);
  });

  it("creates a child run with proposal context when the user replies continue", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      }
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_continue",
      event: githubIssueEvent({ id: "evt_thread_continue", sourceEventId: "comment_thread_continue", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_continue",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Continue the investigation.",
          intents: [
            {
              intentId: "intent_continue_tests",
              domain: "follow_up",
              action: "continue_run",
              summary: "Continue fixing the failing test.",
              params: { focus: "failing test" }
            }
          ]
        }
      ]
    });

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "continue 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      run: {
        parentRunId: "run_thread_continue",
        sourceProposalId: "proposal_thread_continue"
      }
    });

    const runResponse = await app.request(`/v1/runs/${body.run.id}`);
    expect(runResponse.status).toBe(200);
    const stored = await runResponse.json();
    expect(stored.event.command.rawText).toContain("Continue approved OpenTag action");
    expect(stored.event.metadata).toMatchObject({
      parentRunId: "run_thread_continue",
      sourceProposalId: "proposal_thread_continue",
      threadActionVerb: "continue",
      approvalDecisionId: body.decision.id,
      selectedIntentIds: ["intent_continue_tests"],
      previousRunSummary: "Prepared suggested actions."
    });
    expect(stored.event.context.some((pointer: { uri?: string }) => pointer.uri?.includes("OpenTag thread action continuation."))).toBe(true);
    expect(stored.run.contextPacket.facts.map((fact: { text: string }) => fact.text)).toEqual(
      expect.arrayContaining([
        "Action loop thread action: continue",
        "Action loop parent run: run_thread_continue",
        "Action loop proposal: proposal_thread_continue",
        `Action loop approval decision: ${body.decision.id}`,
        "Action loop selected intents: intent_continue_tests",
        "Action loop previous result: Prepared suggested actions."
      ])
    );
    expect(
      delivered.some(
        (message) =>
          message.body.includes("Continuing in OpenTag from this approved action.") &&
          message.body.includes("Action: Continue fixing the failing test.") &&
          message.body.includes(`Child run: \`${body.run.id}\``) &&
          message.body.includes(`Audit: run \`opentag status --run ${body.run.id}\` locally.`) &&
          !message.body.includes("proposal_thread_continue") &&
          !message.body.includes(body.decision.id)
      )
    ).toBe(true);
  });

  it("falls back to a child run when an approved action has no direct adapter operation", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
          return { handled: true, outcome: "accepted" } as const;
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async () => {
          throw new Error("unsupported actions should not call GitHub");
        }
      }
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_fallback",
      event: githubIssueEvent({ id: "evt_thread_fallback", sourceEventId: "comment_thread_fallback", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_fallback",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Ask for review.",
          intents: [
            {
              intentId: "intent_request_review",
              domain: "review",
              action: "request_review",
              summary: "Request a reviewer.",
              params: { reviewer: "maintainer" }
            }
          ]
        }
      ]
    });

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      plan: {
        proposalId: "proposal_thread_fallback",
        outcomes: [{ intentId: "intent_request_review", outcome: "unsupported" }]
      },
      run: {
        parentRunId: "run_thread_fallback",
        sourceProposalId: "proposal_thread_fallback"
      }
    });
    expect(body.run.sourceApplyPlanId).toBe(body.plan.id);
    const runResponse = await app.request(`/v1/runs/${body.run.id}`);
    expect(runResponse.status).toBe(200);
    const stored = await runResponse.json();
    expect(stored.event.metadata).toMatchObject({
      parentRunId: "run_thread_fallback",
      sourceProposalId: "proposal_thread_fallback",
      approvalDecisionId: body.decision.id,
      sourceApplyPlanId: body.plan.id,
      selectedIntentIds: ["intent_request_review"],
      threadActionVerb: "apply",
      previousRunSummary: "Prepared suggested actions."
    });
    expect(stored.event.metadata.fallbackReason).toContain("No selected intent has a direct adapter execution path.");
    expect(stored.event.permissions.map((permission: { scope: string }) => permission.scope)).toEqual(
      expect.arrayContaining(["repo:read", "repo:write"])
    );
    expect(stored.run.contextPacket.facts.map((fact: { text: string }) => fact.text)).toEqual(
      expect.arrayContaining([
        "Action loop thread action: apply",
        "Action loop parent run: run_thread_fallback",
        "Action loop proposal: proposal_thread_fallback",
        `Action loop approval decision: ${body.decision.id}`,
        `Action loop apply plan: ${body.plan.id}`,
        "Action loop selected intents: intent_request_review",
        "Action loop previous result: Prepared suggested actions.",
        "Action loop fallback reason: No selected intent has a direct adapter execution path."
      ])
    );
    expect(
      delivered.some(
        (message) =>
          message.kind === "final" &&
          message.body.includes("Needs setup before OpenTag can apply this action directly.") &&
          message.body.includes("Action: Request a reviewer.") &&
          message.body.includes(`Child run: \`${body.run.id}\``) &&
          message.body.includes("Reason:") &&
          message.body.includes(`Audit: run \`opentag status --run ${body.run.id}\` locally.`) &&
          !message.body.includes(`Approval decision: \`${body.decision.id}\``)
      )
    ).toBe(true);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json"
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("invalid_json_body");
    const audit = await app.request("/v1/control-plane-events?type=security.request_body_rejected");
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "security.request_body_rejected",
        severity: "warn",
        subject: "POST /v1/runners",
        payload: expect.objectContaining({
          reason: "invalid_json_body",
          error: "invalid_json_body",
          endpoint: "POST /v1/runners"
        })
      })
    ]);
  });

  it("returns 400 for a body that fails schema validation", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/runners", jsonRequest({ nope: true }));

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("invalid_request_body");
    const audit = await app.request("/v1/control-plane-events?type=security.request_body_rejected");
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "security.request_body_rejected",
        severity: "warn",
        subject: "POST /v1/runners",
        payload: expect.objectContaining({
          reason: "invalid_request_body",
          error: "invalid_request_body",
          endpoint: "POST /v1/runners"
        })
      })
    ]);
  });

  it("returns 413 before validation when a request body is too large", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", maxRequestBodyBytes: 24 });

    const response = await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_body_too_large", maxBytes: 24 });
    const audit = await app.request("/v1/control-plane-events?type=security.request_body_rejected");
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "security.request_body_rejected",
        severity: "warn",
        subject: "POST /v1/runners",
        payload: expect.objectContaining({
          reason: "request_body_too_large",
          endpoint: "POST /v1/runners",
          maxBytes: 24
        })
      })
    ]);
  });

  it("applies the request body size limit to approval endpoints", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", maxRequestBodyBytes: 24 });

    const response = await app.request("/v1/proposals/proposal_1/approvals", jsonRequest({
      approvedIntentIds: ["intent_1"],
      approvedBy: "octocat",
      reason: "This reason intentionally exceeds the tiny test request body limit."
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_body_too_large", maxBytes: 24 });
  });

  it("does not mask an internal ZodError as a 400 (yields 500)", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    // Simulate a non-request-body ZodError, e.g. a store repository validating a
    // DB row. It must surface as 500 so monitoring alerts on it, not 400.
    app.get("/__test/internal-zod", () => {
      z.object({ value: z.string() }).parse({ value: 123 });
      return new Response("unreachable");
    });

    const response = await app.request("/__test/internal-zod");

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("invalid_request_body");
  });

  it("does not mask an internal SyntaxError as a 400 (yields 500)", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    // Simulate a non-request-body SyntaxError, e.g. JSON.parse of a corrupt DB
    // column or an external API response. It must surface as 500, not 400.
    app.get("/__test/internal-syntax", () => {
      JSON.parse("{ not valid json");
      return new Response("unreachable");
    });

    const response = await app.request("/__test/internal-syntax");

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("invalid_json_body");
  });

  it("schedules exactly one fresh governed callback runtime start after startup failure", async () => {
    const timeouts = createControlledTimeouts();
    const firstStart = deferred();
    const secondStart = deferred();
    let startCalls = 0;
    const app = createDispatcherApp({
      databasePath: ":memory:",
      governedCallbackRuntime: {
        retryDelayMs: 1,
        setTimeout: timeouts.setTimeout,
        clearTimeout: timeouts.clearTimeout,
        create: () => ({
          start() {
            startCalls += 1;
            return startCalls === 1 ? firstStart.promise : secondStart.promise;
          },
          async enqueue() {
            throw new Error("unexpected governed callback enqueue");
          },
          async stop() {}
        })
      }
    });

    firstStart.reject(new Error("startup failed"));
    await waitForCondition(() => timeouts.pendingCount === 1);
    expect(startCalls).toBe(1);

    timeouts.runNext();
    expect(startCalls).toBe(2);
    expect(timeouts.pendingCount).toBe(0);
    secondStart.resolve();
    await app.stopBackgroundWorkers();
  });

  it("cancels a pending governed callback runtime retry when background workers stop", async () => {
    const timeouts = createControlledTimeouts();
    let startCalls = 0;
    const app = createDispatcherApp({
      databasePath: ":memory:",
      governedCallbackRuntime: {
        retryDelayMs: 1,
        setTimeout: timeouts.setTimeout,
        clearTimeout: timeouts.clearTimeout,
        create: () => ({
          async start() {
            startCalls += 1;
            throw new Error("startup failed");
          },
          async enqueue() {
            throw new Error("unexpected governed callback enqueue");
          },
          async stop() {}
        })
      }
    });
    await waitForCondition(() => timeouts.pendingCount === 1);

    await app.stopBackgroundWorkers();

    expect(timeouts.pendingCount).toBe(0);
    timeouts.runAll();
    expect(startCalls).toBe(1);
  });

  it("waits for an in-flight governed callback runtime start before stopping without restarting", async () => {
    const timeouts = createControlledTimeouts();
    const inFlightStart = deferred();
    let startCalls = 0;
    let stopCalls = 0;
    const app = createDispatcherApp({
      databasePath: ":memory:",
      governedCallbackRuntime: {
        retryDelayMs: 1,
        setTimeout: timeouts.setTimeout,
        clearTimeout: timeouts.clearTimeout,
        create: () => ({
          start() {
            startCalls += 1;
            return inFlightStart.promise;
          },
          async enqueue() {
            throw new Error("unexpected governed callback enqueue");
          },
          async stop() {
            stopCalls += 1;
          }
        })
      }
    });

    let stopped = false;
    const stopTask = app.stopBackgroundWorkers().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(stopCalls).toBe(0);

    inFlightStart.reject(new Error("startup failed during stop"));
    await stopTask;

    expect(stopCalls).toBe(1);
    expect(timeouts.pendingCount).toBe(0);
    timeouts.runAll();
    expect(startCalls).toBe(1);
  });

  it("keeps governed callback runtime retries serial across repeated startup failures", async () => {
    const timeouts = createControlledTimeouts();
    const starts: Array<ReturnType<typeof deferred>> = [];
    let concurrentStarts = 0;
    let maxConcurrentStarts = 0;
    const app = createDispatcherApp({
      databasePath: ":memory:",
      governedCallbackRuntime: {
        retryDelayMs: 1,
        setTimeout: timeouts.setTimeout,
        clearTimeout: timeouts.clearTimeout,
        create: () => ({
          start() {
            concurrentStarts += 1;
            maxConcurrentStarts = Math.max(
              maxConcurrentStarts,
              concurrentStarts
            );
            const start = deferred();
            starts.push(start);
            return start.promise.finally(() => {
              concurrentStarts -= 1;
            });
          },
          async enqueue() {
            throw new Error("unexpected governed callback enqueue");
          },
          async stop() {}
        })
      }
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(starts).toHaveLength(attempt + 1);
      starts[attempt]!.reject(new Error(`startup failed ${attempt + 1}`));
      await waitForCondition(() => timeouts.pendingCount === 1);
      expect(concurrentStarts).toBe(0);
      if (attempt < 2) timeouts.runNext();
    }

    expect(maxConcurrentStarts).toBe(1);
    expect(timeouts.pendingCount).toBe(1);
    await app.stopBackgroundWorkers();
  });

  it("keeps hosted terminal callbacks out of the legacy sink until lifecycle authority is acknowledged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-hosted-callback-server-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "dispatcher.sqlite");
    const sqlite = new Database(databasePath);
    const providerDeliveries: CallbackMessage[] = [];
    const callbackSink = {
      async preflight(message: CallbackMessage) {
        return message.provider === "github"
          ? { handled: true } as const
          : { handled: false, reasonCode: "provider_not_supported" } as const;
      },
      async deliver(message: CallbackMessage) {
        providerDeliveries.push(message);
        return {
          handled: true,
          outcome: "accepted",
          externalMessageId: "comment_101",
          providerReceiptId: "comment_101",
          providerResourceUri:
            "https://api.github.com/repos/acme/demo/issues/comments/101"
        } as const;
      }
    };
    const app = createDispatcherApp({
      databasePath,
      sqlite,
      callbackSink,
      reassessmentObligations: {
        autoStart: true,
        pollIntervalMs: 10,
        retryBaseMs: 500,
        retryMaxMs: 500,
        leaseSeconds: 2,
        maxAttempts: 5
      }
    });
    try {
      const runnerId = "runner_hosted_callback";
      const runId = "run_hosted_callback";
      const destinationId = "cloud_hosted_callback";
      const organizationId = "org_hosted_callback";
      const credentialId = "credential_hosted_callback";
      expect((await app.request("/v1/runners", jsonRequest({
        runnerId,
        name: "Hosted callback runner",
        locality: "local",
        executors: [echoExecutorRegistration]
      }))).status).toBe(201);
      expect((await app.request("/v1/repo-bindings", jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId,
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      }))).status).toBe(201);
      expect((await app.request("/v1/runs", jsonRequest({
        runId,
        event: {
          ...validEvent,
          id: "evt_hosted_callback",
          metadata: { ...validEvent.metadata, issueNumber: 1 }
        }
      }))).status).toBe(201);
      const claimResponse = await app.request(`/v1/runners/${runnerId}/claim`, {
        method: "POST"
      });
      expect(claimResponse.status).toBe(200);
      const claim = await claimResponse.json() as {
        attemptId: string;
        fencingToken: string;
      };
      const runRow = sqlite.prepare(`SELECT event_json AS eventJson,
        work_thread_id AS workThreadId FROM runs WHERE id = ?`).get(runId) as {
          eventJson: string;
          workThreadId: string;
        };
      const attemptRow = sqlite.prepare(`SELECT number, runner_locality AS runnerLocality
        FROM attempts WHERE id = ?`).get(claim.attemptId) as {
          number: number;
          runnerLocality: string;
        };
      expect(attemptRow.runnerLocality).toBe("local");
      sqlite.prepare("UPDATE attempts SET runner_locality = 'hosted' WHERE id = ?")
        .run(claim.attemptId);
      expect(sqlite.prepare(`SELECT runner_locality AS runnerLocality
        FROM attempts WHERE id = ?`).get(claim.attemptId)).toEqual({
          runnerLocality: "hosted"
        });

      const fencingTokenDigest = `sha256:${createHash("sha256")
        .update(claim.fencingToken)
        .digest("hex")}`;
      const claimOperationId = "claim_operation_hosted_callback";
      const claimDigest = `sha256:${"d".repeat(64)}`;
      const evidenceDigest = `sha256:${"e".repeat(64)}`;
      const authority = {
        organizationId,
        runnerId,
        runId,
        credentialId,
        registrationGeneration: 1,
        credentialGeneration: 1,
        projectTargetId: "project_target_hosted_callback",
        bindingId: "binding_hosted_callback",
        targetBindingDigest: `sha256:${"6".repeat(64)}`,
        admissionPolicyReceiptId: "policy_receipt_hosted_callback",
        admissionPolicySnapshotId: "policy_snapshot_hosted_callback",
        admissionPolicySnapshotDigest: evidenceDigest,
        runnerReadinessReceiptId: "readiness_receipt_hosted_callback",
        runnerReadinessReceiptDigest: `sha256:${"8".repeat(64)}`,
        targetReadinessReceiptId: "readiness_receipt_hosted_callback",
        targetReadinessReceiptDigest: `sha256:${"8".repeat(64)}`,
        executorId: "echo",
        executorCapabilityDigest: `sha256:${"9".repeat(64)}`,
        attemptId: claim.attemptId,
        attemptNumber: attemptRow.number,
        epoch: attemptRow.number,
        fencingTokenDigest
      };
      const authorityJson = canonicalJsonStringify(authority);
      const authorityDigest = canonicalSha256Json(authority);
      const importedAt = new Date().toISOString();
      sqlite.prepare(`INSERT INTO hosted_claim_operations (
        operation_id, request_id, organization_id, runner_id, destination_id,
        request_digest, request_json, state, run_id, claim_digest,
        authority_digest, authority_json, attempt_id, attempt_number,
        fencing_token_digest, credential_id, execution_started_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'claimed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          claimOperationId,
          "claim_request_hosted_callback",
          organizationId,
          runnerId,
          destinationId,
          `sha256:${"1".repeat(64)}`,
          runId,
          claimDigest,
          authorityDigest,
          authorityJson,
          claim.attemptId,
          attemptRow.number,
          fencingTokenDigest,
          credentialId,
          importedAt,
          importedAt,
          importedAt
        );
      sqlite.prepare(`INSERT INTO hosted_run_imports (
        run_id, admission_id, admission_operation_id, claim_operation_id,
        attempt_id, fencing_token_digest, source_identity_digest,
        delivery_payload_digest, admission_envelope_digest, policy_receipt_id,
        policy_payload_digest, policy_receipt_digest, event_digest,
        context_packet_digest, work_thread_id, claim_digest, authority_digest,
        authority_json, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          runId,
          "admission_hosted_callback",
          "admission_operation_hosted_callback",
          claimOperationId,
          claim.attemptId,
          fencingTokenDigest,
          `sha256:${"2".repeat(64)}`,
          `sha256:${"3".repeat(64)}`,
          `sha256:${"4".repeat(64)}`,
          authority.admissionPolicyReceiptId,
          `sha256:${"5".repeat(64)}`,
          evidenceDigest,
          canonicalSha256Json(JSON.parse(runRow.eventJson)),
          `sha256:${"7".repeat(64)}`,
          runRow.workThreadId,
          claimDigest,
          authorityDigest,
          authorityJson,
          importedAt
        );
      sqlite.prepare(`INSERT INTO hosted_attempt_imports (
        attempt_id, run_id, attempt_number, claim_operation_id,
        fencing_token_digest, claim_digest, authority_digest, authority_json,
        imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          claim.attemptId,
          runId,
          attemptRow.number,
          claimOperationId,
          fencingTokenDigest,
          claimDigest,
          authorityDigest,
          authorityJson,
          importedAt
        );

      const legacyDeliveriesBeforeHostedCompletion = sqlite.prepare(`SELECT
        count(*) AS count FROM callback_deliveries
        WHERE run_id = ? AND dispatch_mode = 'legacy'`).get(runId) as {
          count: number;
        };
      expect(legacyDeliveriesBeforeHostedCompletion).toEqual({ count: 1 });
      providerDeliveries.length = 0;
      const result = { conclusion: "success" as const, summary: "completed locally" };
      const request = await buildHostedLifecycleRequestV1({
        action: "complete",
        organizationId,
        runnerId,
        runId,
        attempt: {
          attemptId: claim.attemptId,
          attemptNumber: attemptRow.number,
          epoch: attemptRow.number,
          fencingToken: claim.fencingToken,
          fencingTokenDigest
        },
        occurredAt: new Date().toISOString(),
        conclusion: "success",
        reasonCode: "executor_success",
        resultDigest: await computeControlPayloadDigestV1(result),
        artifactDigests: [],
        evidenceDigests: []
      });
      const repo = createOpenTagRepository(drizzle(sqlite));
      await expect(repo.completeHostedRunLocally({
        runId,
        result,
        runnerId,
        attemptId: claim.attemptId,
        fencingToken: claim.fencingToken,
        destinationId,
        organizationId,
        credentialId,
        request
      })).resolves.toBe("completed");

      await waitForDatabase(
        sqlite,
        `SELECT state, attempt_count AS attemptCount, last_reason_code AS lastReasonCode
          FROM reassessment_obligations WHERE source_kind = 'run_result_recorded'
          AND source_id = '${runId}'`,
        (row) => row?.["state"] === "pending"
          && Number(row["attemptCount"]) >= 1
          && row["lastReasonCode"] === "reassessment_failed"
      );
      expect(sqlite.prepare("SELECT count(*) AS count FROM governed_callback_intents").get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare(`SELECT count(*) AS count
        FROM control_plane_projection_outbox
        WHERE receipt_kind = 'completion_assessment'`).get()).toEqual({ count: 0 });
      expect(providerDeliveries).toEqual([]);
      const preAcknowledgementAssessment = sqlite.prepare(`SELECT
        work_threads.current_assessment_id AS assessmentId,
        completion_assessments.assessment_json AS assessmentJson,
        (SELECT count(*) FROM completion_assessments
          WHERE work_thread_id = work_threads.id) AS assessmentCount
        FROM work_threads
        JOIN completion_assessments
          ON completion_assessments.id = work_threads.current_assessment_id
        WHERE work_threads.id = ?`).get(runRow.workThreadId) as {
          assessmentId: string;
          assessmentJson: string;
          assessmentCount: number;
        };
      expect(preAcknowledgementAssessment.assessmentCount).toBe(1);
      expect(JSON.parse(preAcknowledgementAssessment.assessmentJson)).toMatchObject({
        id: preAcknowledgementAssessment.assessmentId,
        workThreadId: runRow.workThreadId,
        triggeredByRunId: runId
      });

      const [lifecycle] = await repo.claimDueHostedLifecycleOperations({
        destinationId,
        organizationId,
        leaseOwner: "server-test-lifecycle-pump",
        leaseSeconds: 30,
        now: new Date()
      });
      expect(lifecycle?.operationId).toBe(request.operationId);
      const receipt = HostedLifecycleReceiptEnvelopeV1Schema.parse(receiptWithDigests({
        schemaVersion: 1,
        protocolVersion: "1.0",
        receiptKind: "attempt_lifecycle",
        receiptId: `lifecycle_${canonicalSha256Json({
          organizationId,
          operationId: request.operationId
        }).slice("sha256:".length)}`,
        organizationId,
        requestId: request.requestId,
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        requiredCapabilities: ["relay.lifecycle.v1"],
        producer: { kind: "runner", id: runnerId, credentialId },
        identity: {
          namespace: "opentag.control.receipt/attempt-lifecycle/v1",
          parts: [organizationId, runId, claim.attemptId, "executor_result", request.operationId]
        },
        observedAt: new Date().toISOString(),
        runId,
        attempt: {
          attemptId: claim.attemptId,
          attemptNumber: attemptRow.number,
          epoch: attemptRow.number,
          fencingTokenDigest
        },
        payload: {
          operation: "executor_result",
          occurredAt: request.occurredAt,
          conclusion: "success",
          reasonCode: "executor_success",
          resultDigest: request.resultDigest,
          artifactDigests: [],
          evidenceDigests: []
        }
      }));
      await expect(repo.acknowledgeHostedLifecycleOperation({
        destinationId,
        organizationId,
        operationId: request.operationId,
        leaseToken: lifecycle!.leaseToken!,
        receipt,
        now: new Date()
      })).resolves.toBe("acknowledged");

      const assessmentProjectionRow = sqlite.prepare(`SELECT
        destination_id AS destinationId,
        organization_id AS organizationId,
        run_id AS runId,
        work_thread_id AS workThreadId,
        payload_digest AS payloadDigest,
        receipt_digest AS receiptDigest,
        envelope_json AS envelopeJson,
        requires_lifecycle_operation_id AS requiresLifecycleOperationId
        FROM control_plane_projection_outbox
        WHERE receipt_kind = 'completion_assessment'`).get() as {
          destinationId: string;
          organizationId: string;
          runId: string;
          workThreadId: string;
          payloadDigest: string;
          receiptDigest: string;
          envelopeJson: string;
          requiresLifecycleOperationId: string;
        };
      const assessmentProjection = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
        JSON.parse(assessmentProjectionRow.envelopeJson)
      );
      const currentAssessment = sqlite.prepare(`SELECT current_assessment_id AS assessmentId
        FROM work_threads WHERE id = ?`).get(runRow.workThreadId) as {
          assessmentId: string;
      };
      expect(assessmentProjectionRow).toMatchObject({
        destinationId,
        organizationId,
        runId,
        workThreadId: runRow.workThreadId,
        payloadDigest: assessmentProjection.payloadDigest,
        receiptDigest: assessmentProjection.receiptDigest,
        requiresLifecycleOperationId: request.operationId
      });
      expect(assessmentProjection.payloadDigest).toBe(
        canonicalSha256Json(assessmentProjection.payload)
      );
      const { receiptDigest: _receiptDigest, ...assessmentWithoutReceiptDigest } =
        assessmentProjection;
      expect(assessmentProjection.receiptDigest).toBe(
        canonicalSha256Json(assessmentWithoutReceiptDigest)
      );
      expect(assessmentProjectionRow.requiresLifecycleOperationId).toBe(request.operationId);
      expect(assessmentProjection.identity).toEqual({
        namespace: "opentag.control.receipt/completion-assessment/v1",
        parts: [
          organizationId,
          runRow.workThreadId,
          preAcknowledgementAssessment.assessmentId
        ]
      });
      expect(assessmentProjection.producer).toEqual({
        kind: "local_opentag",
        id: runnerId,
        credentialId,
        registrationGeneration: 1
      });
      expect(assessmentProjection.attempt).toEqual({
        attemptId: claim.attemptId,
        attemptNumber: attemptRow.number,
        epoch: attemptRow.number,
        fencingTokenDigest
      });
      expect(assessmentProjection.predecessorReceiptDigests).toContain(
        receipt.receiptDigest
      );
      expect(currentAssessment.assessmentId).toBe(
        preAcknowledgementAssessment.assessmentId
      );
      expect(assessmentProjection.payload.assessmentId).toBe(
        preAcknowledgementAssessment.assessmentId
      );
      expect(assessmentProjection.payload.executorResultReceiptRef).toEqual({
        receiptId: receipt.receiptId,
        operationId: request.operationId,
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        resultDigest: request.resultDigest
      });

      await waitForDatabase(
        sqlite,
        `SELECT state, attempt_count AS attemptCount,
          last_reason_code AS lastReasonCode, last_error AS lastError,
          satisfied_assessment_id AS satisfiedAssessmentId,
          (SELECT count(*) FROM governed_callback_intents) AS intentCount,
          (SELECT count(*) FROM control_plane_projection_outbox
            WHERE receipt_kind = 'completion_assessment') AS assessmentReceiptCount
          FROM reassessment_obligations WHERE source_kind = 'run_result_recorded'
          AND source_id = '${runId}'`,
        (row) => row?.["state"] === "satisfied"
          && row["lastReasonCode"] === "assessment_satisfied"
          && row["lastError"] === null
          && row["satisfiedAssessmentId"]
            === preAcknowledgementAssessment.assessmentId
          && Number(row["attemptCount"]) >= 2
          && Number(row["attemptCount"]) < 5
          && row["intentCount"] === 1
          && row["assessmentReceiptCount"] === 1
      );
      await waitForDatabase(
        sqlite,
        `SELECT state,
          (SELECT count(*) FROM governed_callback_attempts
            WHERE state = 'accepted') AS acceptedAttemptCount,
          (SELECT count(*) FROM governed_callback_attempts
            WHERE provider_receipt_id IS NOT NULL
              AND provider_receipt_digest IS NOT NULL
              AND provider_receipt_json IS NOT NULL) AS providerReceiptCount
          FROM governed_callback_intents`,
        (row) => row?.["state"] === "accepted"
          && row["acceptedAttemptCount"] === 1
          && row["providerReceiptCount"] === 1
      );
      const intentRow = sqlite.prepare(`SELECT
        local_intent_id AS localIntentId,
        destination_id AS destinationId,
        organization_id AS organizationId,
        runner_id AS runnerId,
        credential_id AS credentialId,
        registration_generation AS registrationGeneration,
        run_id AS runId,
        work_thread_id AS workThreadId,
        run_attempt_id AS runAttemptId,
        run_attempt_number AS runAttemptNumber,
        fencing_token_digest AS fencingTokenDigest,
        admission_id AS admissionId,
        admission_operation_id AS admissionOperationId,
        claim_operation_id AS claimOperationId,
        completion_operation_id AS completionOperationId,
        assessment_receipt_id AS assessmentReceiptId,
        assessment_receipt_digest AS assessmentReceiptDigest,
        state, current_attempt_number AS currentAttemptNumber,
        last_reason_code AS lastReasonCode, terminal_at AS terminalAt
        FROM governed_callback_intents`).get() as {
          localIntentId: string;
          destinationId: string;
          organizationId: string;
          runnerId: string;
          credentialId: string;
          registrationGeneration: number;
          runId: string;
          workThreadId: string;
          runAttemptId: string;
          runAttemptNumber: number;
          fencingTokenDigest: string;
          admissionId: string;
          admissionOperationId: string;
          claimOperationId: string;
          completionOperationId: string;
          assessmentReceiptId: string;
          assessmentReceiptDigest: string;
          state: string;
          currentAttemptNumber: number;
          lastReasonCode: string;
          terminalAt: string;
        };
      expect(intentRow).toMatchObject({
        destinationId,
        organizationId,
        runnerId,
        credentialId,
        registrationGeneration: authority.registrationGeneration,
        runId,
        workThreadId: runRow.workThreadId,
        runAttemptId: claim.attemptId,
        runAttemptNumber: attemptRow.number,
        fencingTokenDigest,
        admissionId: "admission_hosted_callback",
        admissionOperationId: "admission_operation_hosted_callback",
        claimOperationId,
        completionOperationId: request.operationId,
        assessmentReceiptId: assessmentProjection.receiptId,
        assessmentReceiptDigest: assessmentProjection.receiptDigest,
        state: "accepted",
        currentAttemptNumber: 1,
        lastReasonCode: "provider_accepted"
      });
      expect(intentRow.terminalAt).toEqual(expect.any(String));

      const projectionRows = sqlite.prepare(`SELECT receipt_kind AS receiptKind,
        receipt_id AS receiptId, operation_id AS operationId,
        depends_on_receipt_id AS dependsOnReceiptId,
        envelope_json AS envelopeJson
        FROM control_plane_projection_outbox WHERE run_id = ?
        AND receipt_kind IN (
          'completion_assessment', 'callback_intent_observation',
          'callback_attempt_observation', 'callback_provider_observation'
        )`).all(runId) as Array<{
          receiptKind: string;
          receiptId: string;
          operationId: string;
          dependsOnReceiptId: string | null;
          envelopeJson: string;
        }>;
      expect(projectionRows).toHaveLength(4);
      expect(new Set(projectionRows.map((row) => row.operationId)).size).toBe(4);
      const projectionByKind = new Map(
        projectionRows.map((row) => [row.receiptKind, row])
      );
      const intentProjectionRow = projectionByKind.get(
        "callback_intent_observation"
      )!;
      const attemptProjectionRow = projectionByKind.get(
        "callback_attempt_observation"
      )!;
      const providerProjectionRow = projectionByKind.get(
        "callback_provider_observation"
      )!;
      const intentProjection = CallbackIntentObservationReceiptEnvelopeV1Schema
        .parse(JSON.parse(intentProjectionRow.envelopeJson));
      const attemptProjection = CallbackAttemptObservationReceiptEnvelopeV1Schema
        .parse(JSON.parse(attemptProjectionRow.envelopeJson));
      const providerProjection = CallbackProviderObservationReceiptEnvelopeV1Schema
        .parse(JSON.parse(providerProjectionRow.envelopeJson));
      expect(intentProjection.predecessorReceiptDigests).toEqual([
        assessmentProjection.receiptDigest
      ]);
      expect(intentProjection.payload).toMatchObject({
        localIntentId: intentRow.localIntentId,
        assessmentRef: assessmentProjection.payload.assessmentId,
        assessmentDigest: assessmentProjection.receiptDigest,
        provider: "github"
      });
      expect(intentProjectionRow.dependsOnReceiptId).toBe(
        assessmentProjection.receiptId
      );
      expect(attemptProjection.predecessorReceiptDigests).toEqual([
        intentProjection.receiptDigest
      ]);
      expect(attemptProjection.payload).toMatchObject({
        localIntentId: intentRow.localIntentId,
        attemptNumber: 1,
        outcome: "accepted",
        reasonCode: "provider_accepted"
      });
      expect(attemptProjectionRow.dependsOnReceiptId).toBe(
        intentProjection.receiptId
      );
      expect(providerProjection.predecessorReceiptDigests).toEqual([
        attemptProjection.receiptDigest
      ]);
      expect(providerProjection.payload).toMatchObject({
        localIntentId: intentRow.localIntentId,
        providerReceiptId: "comment_101",
        resourceIdentity: "github:comment:101",
        outcome: "succeeded",
        reasonCode: "provider_accepted"
      });
      expect(providerProjectionRow.dependsOnReceiptId).toBe(
        attemptProjection.receiptId
      );
      await wait(100);
      expect(sqlite.prepare(`SELECT count(*) AS count
        FROM callback_deliveries WHERE run_id = ?
        AND dispatch_mode = 'legacy'`).get(runId)).toEqual(
        legacyDeliveriesBeforeHostedCompletion
      );
      expect(sqlite.prepare(`SELECT kind, status, count(*) AS count
        FROM callback_deliveries WHERE run_id = ?
        AND dispatch_mode = 'legacy'
        GROUP BY kind, status`).all(runId)).toEqual([
        { kind: "acknowledgement", status: "delivered", count: 1 }
      ]);
      expect(sqlite.prepare(`SELECT dispatch_mode AS dispatchMode,
        governed_state AS governedState, count(*) AS count
        FROM callback_deliveries WHERE run_id = ?
        AND dispatch_mode = 'governed'
        GROUP BY dispatch_mode, governed_state`).all(runId)).toEqual([
        { dispatchMode: "governed", governedState: "accepted", count: 1 }
      ]);
      expect(sqlite.prepare(`SELECT count(*) AS count
        FROM control_plane_projection_outbox
        WHERE receipt_kind = 'completion_assessment'`).get()).toEqual({ count: 1 });
      expect(sqlite.prepare(`SELECT count(*) AS count FROM completion_assessments
        WHERE work_thread_id = ?`).get(runRow.workThreadId)).toEqual({ count: 1 });
      expect(providerDeliveries).toHaveLength(1);
    } finally {
      await app.stopBackgroundWorkers();
      sqlite.close();
    }
  }, 15_000);
});
