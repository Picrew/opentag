import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenTagClient, type OpenTagClient } from "@opentag/client";
import {
  createDispatcherApp,
  type DispatcherDeliveryPresentation
} from "@opentag/dispatcher";
import { computeGitHubSignature, createGitHubWebhookApp } from "@opentag/github";
import { runOneDaemonIteration } from "@opentag/local-runtime";
import { createExecutorRunResult, type ExecutorAdapter } from "@opentag/runner";
import { startSlackSocketModeApp } from "@opentag/slack";
import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import { bootstrapLocalDispatcher, dispatcherRuntimeInputFromCliConfig, type BootstrapClient } from "../src/start.js";

class FakeWebSocket extends EventEmitter {
  readonly sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.emit("close");
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-contract-"));
}

function fetchForApp(app: ReturnType<typeof createDispatcherApp>): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    return app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function adminClientFrom(client: OpenTagClient, runnerId: string): BootstrapClient {
  return {
    registerRunner(name?: string): Promise<void> {
      return client.registerRunner({ runnerId, name: name ?? runnerId });
    },
    bindRepository(binding): Promise<void> {
      return client.bindRepository({
        provider: binding.provider,
        owner: binding.owner,
        repo: binding.repo,
        runnerId,
        workspacePath: binding.checkoutPath,
        ...(binding.defaultExecutor ? { defaultExecutor: binding.defaultExecutor } : {})
      });
    },
    bindChannel(binding: {
      provider: string;
      accountId: string;
      conversationId: string;
      repoProvider: string;
      owner: string;
      repo: string;
      metadata?: Record<string, unknown>;
    }): Promise<void> {
      return client.bindChannel(binding);
    }
  };
}

const changingExecutor: ExecutorAdapter = {
  id: "codex",
  displayName: "Codex",
  async canRun() {
    return { ready: true };
  },
  async run(input) {
    return createExecutorRunResult({
      executorName: "Codex",
      runId: input.runId,
      branchName: `opentag/${input.runId}`,
      baseBranch: input.baseBranch,
      output: "changed README through the contract test",
      changedFiles: ["README.md"]
    });
  }
};

async function createGitHubConfiguredDispatcher() {
  const config = createSetupConfig({
    language: "en",
    platform: "github",
    projectPath: tempDir(),
    executor: "codex",
    stateDirectory: join(tempDir(), "state"),
    github: {
      token: "ghp_contract",
      webhookSecret: "github_webhook_secret",
      owner: "acme",
      repo: "demo",
      webhookPath: "/github/webhooks",
      autoCreatePullRequest: false,
      port: 3050
    }
  });
  const githubRequests: Array<{ url: string; method?: string; authorization?: string | null; body?: unknown }> = [];
  const delivered: DispatcherDeliveryPresentation[] = [];
  const dispatcherApp = createDispatcherApp({
    databasePath: ":memory:",
    ...(config.daemon.pairingToken ? { pairingToken: config.daemon.pairingToken } : {}),
    githubApply: {
      token: config.daemon.githubToken!,
      fetchImpl: async (url, init) => {
        githubRequests.push({
          url: String(url),
          method: init?.method,
          authorization: new Headers(init?.headers).get("authorization"),
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        return Response.json({ html_url: "https://github.com/acme/demo/pull/123" }, { status: 201 });
      }
    },
    deliveryProducer: {
      async enqueue(presentation) {
        delivered.push(presentation);
        return { outcome: "queued", sideEffectIntentId: "intent_github_contract" };
      }
    }
  });
  const dispatcherFetch = fetchForApp(dispatcherApp);
  const client = createOpenTagClient({
    dispatcherUrl: config.daemon.dispatcherUrl,
    pairingToken: config.daemon.pairingToken,
    fetchImpl: dispatcherFetch
  });

  await bootstrapLocalDispatcher(config, adminClientFrom(client, config.daemon.runnerId));

  return { config, client, dispatcherFetch, githubRequests, delivered };
}

describe("CLI platform contract smoke", () => {
  it("uses setup GitHub config for signed issue comments, daemon execution, and apply-1 pull requests", async () => {
    const { config, client, dispatcherFetch, githubRequests, delivered } = await createGitHubConfiguredDispatcher();
    expect(dispatcherRuntimeInputFromCliConfig(config)).toMatchObject({
      githubToken: "ghp_contract"
    });
    expect(config.daemon.preparePullRequestBranch).toBe(true);

    const githubIngress = createGitHubWebhookApp({
      webhookSecret: config.platforms.github!.webhookSecret,
      async createRun(event) {
        const created = await client.createRun({ runId: "run_github_contract", event });
        return created.outcome === "run_created" ? { runId: created.run.id } : {};
      },
      async submitThreadAction(action) {
        return client.submitThreadAction(action);
      },
      resolveActorWriteAccess: async () => true,
      now: () => "2026-06-27T00:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "created",
      comment: {
        id: 1001,
        body: "@opentag fix README",
        html_url: "https://github.com/acme/demo/issues/7#issuecomment-1001",
        author_association: "OWNER"
      },
      issue: {
        html_url: "https://github.com/acme/demo/issues/7",
        comments_url: "https://api.github.com/repos/acme/demo/issues/7/comments",
        number: 7
      },
      repository: { name: "demo", private: false, owner: { login: "acme" } },
      sender: { id: 42, login: "octocat" }
    });

    const mention = await githubIngress.request("/github/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": computeGitHubSignature({ webhookSecret: config.platforms.github!.webhookSecret, rawBody: body })
      },
      body
    });
    expect(mention.status).toBe(200);

    const gitCommands: string[] = [];
    await runOneDaemonIteration({
      runnerId: config.daemon.runnerId,
      repositories: config.daemon.repositories,
      executors: { codex: changingExecutor },
      pullRequestOptions: {
        preparePullRequestBranch: true,
        commandRunner: {
          async run(command, args) {
            gitCommands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      },
      client: {
        claim: () => client.claim({ runnerId: config.daemon.runnerId }),
        markRunning: (runId, executor, lease) => client.markRunning({ runnerId: config.daemon.runnerId, runId, ...lease, executor }),
        heartbeat: (runId, lease) => client.heartbeat({ runnerId: config.daemon.runnerId, runId, ...lease }),
        progress: (runId, lease, input) => client.progress({ runnerId: config.daemon.runnerId, runId, ...lease, ...input }),
        complete: (runId, lease, result) => client.complete({ runnerId: config.daemon.runnerId, runId, ...lease, result })
      }
    });

    expect(gitCommands).toEqual([
      "git add -- README.md",
      "git commit -m OpenTag run run_github_contract",
      "git push -u origin opentag/run_github_contract"
    ]);
    expect(delivered.some((message) =>
      message.kind === "business"
      && message.phase === "final"
      && message.body?.includes("Create a pull request")
    )).toBe(true);

    const applyBody = JSON.stringify({
      action: "created",
      comment: {
        id: 1002,
        body: "apply 1",
        html_url: "https://github.com/acme/demo/issues/7#issuecomment-1002",
        author_association: "OWNER"
      },
      issue: {
        html_url: "https://github.com/acme/demo/issues/7",
        comments_url: "https://api.github.com/repos/acme/demo/issues/7/comments",
        number: 7
      },
      repository: { name: "demo", private: false, owner: { login: "acme" } },
      sender: { id: 42, login: "octocat" }
    });
    const apply = await githubIngress.request("/github/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": computeGitHubSignature({ webhookSecret: config.platforms.github!.webhookSecret, rawBody: applyBody })
      },
      body: applyBody
    });
    expect(apply.status).toBe(200);

    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/branches/opentag%2Frun_github_contract",
        method: "GET",
        authorization: "Bearer ghp_contract"
      },
      {
        url: "https://api.github.com/repos/acme/demo/branches/main",
        method: "GET",
        authorization: "Bearer ghp_contract"
      },
      {
        url: "https://api.github.com/repos/acme/demo/pulls",
        method: "POST",
        authorization: "Bearer ghp_contract",
        body: {
          title: "OpenTag run run_github_contract",
          body: [
            "## Summary",
            "",
            "changed README through the contract test",
            "",
            "## Changed Files",
            "- `README.md`",
            "",
            "## Risks",
            "- Creates a pull request from the executor-produced branch; review the diff before merging.",
            "",
            "## Executor Conditions",
            "- isolated branch exists"
          ].join("\n"),
          head: "opentag/run_github_contract",
          base: "main"
        }
      }
    ]);
    await expect(client.getRun({ runId: "run_github_contract" })).resolves.toMatchObject({
      run: { id: "run_github_contract", status: "succeeded" },
      event: { source: "github" }
    });
    await expect(dispatcherFetch(`${config.daemon.dispatcherUrl}/healthz`)).resolves.toMatchObject({ status: 200 });
  });

  it("uses setup Slack Socket Mode config for app mentions and Slack thread action replies", async () => {
    const config = createSetupConfig({
      language: "en",
      platform: "slack",
      projectPath: tempDir(),
      executor: "codex",
      stateDirectory: join(tempDir(), "state"),
      slack: {
        mode: "socket_mode",
        appToken: "xapp-contract",
        botToken: "xoxb-contract",
        appId: "A123",
        teamId: "T123",
        channelId: "C123",
        bindingMethod: "default_project"
      }
    });
    const delivered: DispatcherDeliveryPresentation[] = [];
    const dispatcherApp = createDispatcherApp({
      databasePath: ":memory:",
      ...(config.daemon.pairingToken ? { pairingToken: config.daemon.pairingToken } : {}),
      deliveryProducer: {
        async enqueue(presentation) {
          delivered.push(presentation);
          return { outcome: "queued", sideEffectIntentId: "intent_slack_contract" };
        }
      }
    });
    const dispatcherFetch = fetchForApp(dispatcherApp);
    const client = createOpenTagClient({
      dispatcherUrl: config.daemon.dispatcherUrl,
      pairingToken: config.daemon.pairingToken,
      fetchImpl: dispatcherFetch
    });
    await bootstrapLocalDispatcher(config, adminClientFrom(client, config.daemon.runnerId));

    const socket = new FakeWebSocket();
    const socketErrors: unknown[] = [];
    const threadActionResults: unknown[] = [];
    const handle = startSlackSocketModeApp(
      {
        appToken: config.platforms.slack!.appToken!,
        slackApp: {
          agentId: "opentag",
          appId: config.platforms.slack!.appId,
          callbackUri: "https://slack.com/api/chat.postMessage"
        },
        async resolveChannelBinding(input) {
          const { binding } = await client.getChannelBinding({
            provider: "slack",
            accountId: input.teamId,
            conversationId: input.channelId
          });
          return {
            teamId: binding.accountId,
            channelId: binding.conversationId,
            repoProvider: binding.repoProvider,
            owner: binding.owner,
            repo: binding.repo
          };
        },
        async createRun(event) {
          const created = await client.createRun({ runId: "run_slack_contract", event });
          return created.outcome === "run_created" ? { runId: created.run.id } : {};
        },
        async submitThreadAction(action) {
          const result = await client.submitThreadAction(action);
          threadActionResults.push(result);
          return result;
        },
        now: () => "2026-06-27T00:00:00.000Z"
      },
      {
        fetchImpl: vi.fn(async () => Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch,
        reconnectDelayMs: 1,
        createWebSocket: () => socket as unknown as WebSocket,
        log() {},
        logError(_message, error) {
          socketErrors.push(error ?? _message);
        }
      }
    );

    await eventually(() => expect(socket.listenerCount("message")).toBeGreaterThan(0));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "events_api",
          envelope_id: "envelope_mention",
          payload: {
            type: "event_callback",
            api_app_id: "A123",
            team_id: "T123",
            event_id: "EvMention",
            event_time: 1782540000,
            authorizations: [{ user_id: "U_APP" }],
            event: {
              type: "app_mention",
              user: "U456",
              text: "<@U_APP> fix README",
              ts: "1782540000.000100",
              channel: "C123"
            }
          }
        })
      )
    );
    await eventually(async () => {
      await expect(client.getRun({ runId: "run_slack_contract" })).resolves.toMatchObject({
        run: { id: "run_slack_contract" },
        event: { source: "slack" }
      });
    });

    await runOneDaemonIteration({
      runnerId: config.daemon.runnerId,
      repositories: config.daemon.repositories,
      executors: { codex: changingExecutor },
      client: {
        claim: () => client.claim({ runnerId: config.daemon.runnerId }),
        markRunning: (runId, executor, lease) => client.markRunning({ runnerId: config.daemon.runnerId, runId, ...lease, executor }),
        heartbeat: (runId, lease) => client.heartbeat({ runnerId: config.daemon.runnerId, runId, ...lease }),
        progress: (runId, lease, input) => client.progress({ runnerId: config.daemon.runnerId, runId, ...lease, ...input }),
        complete: (runId, lease, result) => client.complete({ runnerId: config.daemon.runnerId, runId, ...lease, result })
      }
    });

    expect(socket.sent).toContain(JSON.stringify({ envelope_id: "envelope_mention" }));
    await eventually(() =>
      expect(delivered.some((message) =>
        message.kind === "business"
        && message.phase === "final"
        && message.provider === "slack"
        && message.body?.includes("Create a pull request")
      )).toBe(true)
    );

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "events_api",
          envelope_id: "envelope_apply",
          payload: {
            type: "event_callback",
            api_app_id: "A123",
            team_id: "T123",
            event_id: "EvApply",
            event_time: 1782540001,
            authorizations: [{ user_id: "U_APP" }],
            event: {
              type: "message",
              user: "U456",
              text: "apply 1",
              ts: "1782540001.000200",
              thread_ts: "1782540000.000100",
              channel: "C123"
            }
          }
        })
      )
    );

    await eventually(() => expect(socket.sent).toContain(JSON.stringify({ envelope_id: "envelope_apply" })));
    expect(socketErrors).toEqual([]);
    await eventually(() => expect(threadActionResults.length).toBe(1));
    expect(threadActionResults[0]).toMatchObject({
      outcome: "child_run_created",
      plan: { adapter: "slack" },
      run: { id: expect.any(String) }
    });
    await handle.close();
  });
});
