import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCliConfig, writeCliConfigAtomic } from "../src/config.js";
import { createSetupConfig } from "../src/setup.js";
import {
  assertStartPortsAvailable,
  bootstrapLocalDispatcher,
  createLinearOAuthTokenProvider,
  dispatcherRuntimeInputFromCliConfig,
  githubIngressConfigFromCliConfig,
  gitlabIngressConfigFromCliConfig,
  linearIngressConfigFromCliConfig,
  larkIngressConfigFromCliConfig,
  shouldRethrowAbortReason,
  slackIngressConfigFromCliConfig,
  slackSocketModeIngressConfigFromCliConfig,
  startFromConfig,
  type StartRuntimeDependencies,
  waitForDispatcher
} from "../src/start.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config() {
  return createSetupConfig({
    language: "en",
    platform: "lark",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    lark: {
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      botOpenId: "ou_bot",
      setupMethod: "scan",
      bindingMethod: "default_project"
    }
  });
}

function slackConfig() {
  return createSetupConfig({
    language: "en",
    platform: "slack",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    slack: {
      mode: "events_api",
      signingSecret: "slack_signing_secret",
      botToken: "xoxb-token",
      appId: "A123",
      teamId: "T123",
      channelId: "C123",
      bindingMethod: "default_project"
    }
  });
}

function slackSocketModeConfig() {
  return createSetupConfig({
    language: "en",
    platform: "slack",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    slack: {
      mode: "socket_mode",
      appToken: "xapp-token",
      botToken: "xoxb-token",
      appId: "A123",
      teamId: "T123",
      channelId: "C123",
      bindingMethod: "default_project"
    }
  });
}

function githubConfig(port?: number) {
  return createSetupConfig({
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
      port: port ?? 3050
    }
  });
}

function gitlabConfig(port?: number) {
  return createSetupConfig({
    language: "en",
    platform: "gitlab",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    gitlab: {
      token: "glpat_token",
      webhookSecret: "gitlab_webhook_secret",
      projectPathWithNamespace: "acme/team/demo",
      baseUrl: "https://gitlab.example.com",
      webhookPath: "/gitlab/webhooks",
      port: port ?? 3060
    }
  });
}

function linearConfig(port?: number) {
  return createSetupConfig({
    language: "en",
    platform: "linear",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    linear: {
      token: "lin_api_token",
      webhookSecret: "linear_webhook_secret",
      teamId: "team_eng",
      teamKey: "ENG",
      graphqlUrl: "https://linear.example/graphql",
      webhookPath: "/linear/webhooks",
      port: port ?? 3070,
      mappings: [
        {
          id: "linear_priority_priority",
          adapter: "linear",
          domain: "priority",
          strategy: "priority",
          values: { high: "2" }
        }
      ]
    }
  });
}

function linearOAuthConfig() {
  const built = linearConfig();
  built.platforms.linear!.token = "access_old";
  built.platforms.linear!.auth = {
    method: "oauth_app",
    actor: "app",
    clientId: "linear_client_id",
    clientSecret: "linear_client_secret",
    redirectUri: "https://opentag.example/oauth/linear/callback",
    refreshToken: "refresh_old",
    accessTokenExpiresAt: "2026-07-07T00:04:00.000Z",
    scopes: ["read"]
  };
  return built;
}

function telegramConfig() {
  return createSetupConfig({
    language: "en",
    platform: "telegram",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    telegram: {
      mode: "polling",
      botId: "123456789",
      agentId: "opentag",
      botUsername: "opentag_bot",
      botToken: "123456789:telegram_secret",
      bindingAdminUserIds: ["111", "222"]
    }
  });
}

function discordConfig() {
  return createSetupConfig({
    language: "en",
    platform: "discord",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    discord: {
      mode: "gateway",
      botToken: "discord_bot_token"
    }
  });
}

async function listenOnRandomPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a test port.");
  }
  return { server, port: address.port };
}

function hangingFetch(): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch;
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("OpenTag CLI start wiring", () => {
  it("derives dispatcher input with the Lark callback sink credentials", () => {
    const built = config();
    built.daemon.runnerToken = "runner_token";
    built.daemon.runnerTokens = ["runner_old"];
    built.daemon.revokedRunnerTokenFingerprints = ["abc123"];
    const dispatcher = dispatcherRuntimeInputFromCliConfig(built);

    expect(dispatcher).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      runnerToken: "runner_token",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: ["abc123"],
      lark: {
        appId: "cli_test",
        appSecret: "secret_test",
        domain: "lark"
      },
      channelPrincipals: [
        {
          provider: "lark",
          applicationId: "cli_test",
          botId: "ou_bot",
          credential: expect.any(String)
        }
      ]
    });
    expect(dispatcher.channelPrincipals?.[0]?.credential).toBe(
      larkIngressConfigFromCliConfig(built).channelPrincipalCredential
    );
  });

  it("adds dispatcher hardening env to the local dispatcher without overriding config authority", () => {
    const built = config();
    built.daemon.pairingToken = "config_pairing_token";
    const dispatcher = dispatcherRuntimeInputFromCliConfig(built, {
      env: {
        OPENTAG_PAIRING_TOKEN: "env_pairing_token",
        OPENTAG_MAX_REQUEST_BODY_BYTES: "4096",
        OPENTAG_RATE_LIMIT_WINDOW_MS: "60000",
        OPENTAG_RATE_LIMIT_MAX_REQUESTS: "120"
      }
    });

    expect(dispatcher).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: "config_pairing_token",
      maxRequestBodyBytes: 4096,
      rateLimit: {
        windowMs: 60000,
        maxRequests: 120
      }
    });
  });

  it("derives dispatcher and ingress input for Slack without Lark", () => {
    const built = slackConfig();
    built.daemon.runTimeoutMs = 30_000;

    const dispatcher = dispatcherRuntimeInputFromCliConfig(built);
    expect(dispatcher).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      slackBotToken: "xoxb-token",
      channelPrincipals: [
        {
          provider: "slack",
          applicationId: "A123",
          credential: expect.any(String)
        }
      ]
    });
    const ingress = slackIngressConfigFromCliConfig(built);
    expect(ingress).toMatchObject({
      signingSecret: "slack_signing_secret",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      botToken: "xoxb-token",
      appId: "A123",
      channelPrincipalCredential: expect.any(String),
      runTimeoutMs: 30_000
    });
    expect(dispatcher.channelPrincipals?.[0]?.credential).toBe(ingress.channelPrincipalCredential);
  });

  it("passes the service request body limit to Slack Events API ingress", () => {
    const built = slackConfig();

    expect(
      slackIngressConfigFromCliConfig(built, {
        env: { OPENTAG_MAX_REQUEST_BODY_BYTES: "8192" }
      })
    ).toMatchObject({
      maxRequestBodyBytes: 8192
    });
  });

  it("derives Slack Socket Mode input without requiring a public Events URL", () => {
    const built = slackSocketModeConfig();
    built.daemon.runTimeoutMs = 30_000;

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      slackBotToken: "xoxb-token"
    });
    expect(slackSocketModeIngressConfigFromCliConfig(built)).toMatchObject({
      appToken: "xapp-token",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      botToken: "xoxb-token",
      appId: "A123",
      channelPrincipalCredential: expect.any(String),
      runTimeoutMs: 30_000
    });
  });

  it("derives dispatcher and ingress input for GitHub without Lark", () => {
    const built = githubConfig();

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      githubToken: "ghp_token",
      githubCallbackToken: "ghp_token",
      githubApplyToken: "ghp_token"
    });
    expect(githubIngressConfigFromCliConfig(built)).toMatchObject({
      webhookSecret: "github_webhook_secret",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      requestCompletionReconciliationEscalation: expect.any(Function),
      webhookPath: "/github/webhooks"
    });
  });

  it("forwards daemon GitHub completion policies through the local start path", async () => {
    const built = githubConfig();
    built.daemon.completionPolicies = [
      {
        provider: "github",
        owner: "acme",
        repo: "demo",
        requiredChecks: ["build", "test"],
        baseBranch: "main",
        requireMerge: true
      }
    ];
    let dispatcherInput: Parameters<NonNullable<StartRuntimeDependencies["startDispatcher"]>>[0] | undefined;

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {},
        startDispatcher(input) {
          dispatcherInput = input;
          return {
            url: "http://localhost:3030",
            server: {} as ReturnType<typeof import("@hono/node-server").serve>,
            async close() {}
          };
        },
        async waitForDispatcher() {},
        async bootstrapDispatcher() {},
        async serveDaemon() {},
        startGitHubIngress() {
          return {
            url: "http://127.0.0.1:3050",
            webhookPath: "/github/webhooks",
            server: {} as ReturnType<typeof import("@hono/node-server").serve>,
            async close() {}
          };
        },
        logger: { log() {} }
      }
    });

    expect(dispatcherInput?.completionPolicies).toEqual(built.daemon.completionPolicies);
  });

  it("wires GitHub reconciliation escalation intents to the pairing-authenticated dispatcher client", async () => {
    const built = githubConfig();
    built.daemon.pairingToken = "pairing_admin_token";
    built.daemon.runnerToken = "runner_mutation_token";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const ingress = githubIngressConfigFromCliConfig(built, {
      dispatcherFetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({ outcome: "recorded" }, { status: 202 });
      }
    });
    const request = {
      operation: "resolve" as const,
      escalation: {
        class: "reconciliation" as const,
        audience: "repo_owner" as const,
        subjectRef: "github:acme/demo:pull_request:7",
        state: "resolved" as const,
        blocking: true as const,
        summary: "GitHub completion reconciliation recovered.",
        reason: "The authoritative pull request snapshot is available again.",
        dedupeKey: "github:completion-reconciliation:acme/demo:7"
      },
      correlation: {
        provider: "github" as const,
        deliveryId: "delivery-reconcile-resolved-1",
        eventName: "pull_request" as const,
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [7],
        headSha: "b".repeat(40)
      }
    };

    await ingress.requestCompletionReconciliationEscalation?.(request);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:3030/v1/completion-escalations/github");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer pairing_admin_token");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).not.toBe("Bearer runner_mutation_token");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(request);
  });

  it("derives dispatcher and ingress input for GitLab without Lark", () => {
    const built = gitlabConfig();

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      gitlabToken: "glpat_token",
      gitlabBaseUrl: "https://gitlab.example.com"
    });
    expect(gitlabIngressConfigFromCliConfig(built)).toMatchObject({
      webhookSecret: "gitlab_webhook_secret",
      baseUrl: "https://gitlab.example.com",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      webhookPath: "/gitlab/webhooks",
      port: 3060
    });
  });

  it("derives dispatcher and ingress input for Linear without Lark", () => {
    const built = linearConfig();

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      linearToken: "lin_api_token",
      linearGraphqlUrl: "https://linear.example/graphql",
      linearMappings: built.platforms.linear!.mappings,
      linearProjectTarget: built.platforms.linear!.projectTarget
    });
    expect(linearIngressConfigFromCliConfig(built)).toMatchObject({
      webhookSecret: "linear_webhook_secret",
      linearToken: "lin_api_token",
      graphqlUrl: "https://linear.example/graphql",
      projectTarget: built.platforms.linear!.projectTarget,
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      webhookPath: "/linear/webhooks",
      port: 3070
    });
  });

  it("does not forward the Linear token to the dispatcher for a query-only Linear config", () => {
    const built = linearConfig();
    built.platforms.linear = { token: "lin_api_qo", projectId: "proj_qo" } as never;

    expect(dispatcherRuntimeInputFromCliConfig(built)).not.toHaveProperty("linearToken");
  });

  it("does not forward a top-level token used only by channel-routed /linear queries", () => {
    const built = slackConfig();
    built.platforms.linear = {
      token: "lin_query_only",
      channels: [{ teamId: "T123", channelId: "C123", projectId: "proj_qo" }]
    } as never;

    expect(dispatcherRuntimeInputFromCliConfig(built)).not.toHaveProperty("linearToken");
  });

  it("does not forward connections.default query credentials to the dispatcher", () => {
    const built = slackConfig();
    built.platforms.linear = {
      connections: { default: { token: "lin_query_only" } },
      channels: [{ teamId: "T123", channelId: "C123", projectId: "proj_qo" }]
    } as never;

    expect(dispatcherRuntimeInputFromCliConfig(built)).not.toHaveProperty("linearToken");
  });

  it("refreshes and persists Linear OAuth app tokens before they expire", async () => {
    const built = linearOAuthConfig();
    const configPath = join(tempDir(), "config.json");
    writeCliConfigAtomic(configPath, built);

    const provider = createLinearOAuthTokenProvider({
      config: built,
      configPath,
      now: () => new Date("2026-07-07T00:00:00.000Z"),
      async refreshLinearOAuthToken(input) {
        expect(input).toEqual({
          clientId: "linear_client_id",
          clientSecret: "linear_client_secret",
          refreshToken: "refresh_old"
        });
        return {
          accessToken: "access_new",
          refreshToken: "refresh_new",
          expiresIn: 86_400,
          scope: ["read", "write", "comments:create"]
        };
      }
    });

    await expect(provider?.()).resolves.toBe("access_new");

    const saved = readCliConfig(configPath);
    expect(saved.platforms.linear).toMatchObject({
      token: "access_new",
      auth: {
        method: "oauth_app",
        refreshToken: "refresh_new",
        accessTokenExpiresAt: "2026-07-08T00:00:00.000Z",
        scopes: ["read", "write", "comments:create"]
      }
    });
    expect(built.platforms.linear).toMatchObject({
      token: "access_new",
      auth: {
        refreshToken: "refresh_new"
      }
    });
  });

  it("passes a Linear OAuth token provider into the local dispatcher", async () => {
    const built = linearOAuthConfig();
    let capturedTokenProvider: unknown;

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {},
        startDispatcher(input) {
          capturedTokenProvider = input.linearTokenProvider;
          return {
            url: "http://localhost:3030",
            server: {} as ReturnType<typeof import("@hono/node-server").serve>,
            async close() {}
          };
        },
        async waitForDispatcher() {},
        async bootstrapDispatcher() {},
        startLinearIngress() {
          return {
            url: "http://127.0.0.1:3070",
            webhookPath: "/linear/webhooks",
            server: {} as ReturnType<typeof import("@hono/node-server").serve>,
            async close() {}
          };
        },
        async serveDaemon() {},
        logger: { log() {} },
        readConfig() {
          return built;
        },
        writeConfig() {},
        async refreshLinearOAuthToken() {
          throw new Error("provider should not refresh until callback or apply needs a token");
        }
      }
    });

    expect(capturedTokenProvider).toEqual(expect.any(Function));
  });

  it("keeps query-only Linear OAuth refresh out of the dispatcher while preserving it for Slack /linear", async () => {
    const built = slackConfig();
    built.platforms.linear = {
      token: "access_old",
      auth: {
        method: "oauth_app",
        actor: "app",
        clientId: "linear_client_id",
        refreshToken: "refresh_old",
        accessTokenExpiresAt: "2026-07-07T00:04:00.000Z"
      },
      channels: [{ teamId: "T123", channelId: "C123", projectId: "proj_query_only" }]
    } as never;
    let dispatcherInput: Parameters<NonNullable<StartRuntimeDependencies["startDispatcher"]>>[0] | undefined;
    let linearHandler: ReturnType<typeof slackIngressConfigFromCliConfig>["linear"];
    let refreshCalls = 0;

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {},
        startDispatcher(input) {
          dispatcherInput = input;
          return {
            url: "http://localhost:3030",
            server: {} as ReturnType<typeof import("@hono/node-server").serve>,
            async close() {}
          };
        },
        async waitForDispatcher() {},
        async bootstrapDispatcher() {},
        startSlackIngress(input) {
          linearHandler = input.linear;
          return {
            url: "http://127.0.0.1:3040",
            server: {} as ReturnType<typeof import("@hono/node-server").serve>,
            async close() {}
          };
        },
        async serveDaemon() {},
        logger: { log() {} },
        now: () => new Date("2026-07-07T00:00:00.000Z"),
        readConfig() {
          return built;
        },
        writeConfig() {},
        async refreshLinearOAuthToken() {
          refreshCalls += 1;
          return { accessToken: "access_new", refreshToken: "refresh_new", expiresIn: 86_400 };
        }
      }
    });

    expect(dispatcherInput).not.toHaveProperty("linearToken");
    expect(dispatcherInput).not.toHaveProperty("linearTokenProvider");
    expect(linearHandler).toEqual(expect.any(Function));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access_new");
      return new Response(
        JSON.stringify({
          data: {
            project: { name: "opentag" },
            issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
          }
        }),
        { status: 200 }
      );
    });
    try {
      const reply = await linearHandler?.({
        teamId: "T123",
        channelId: "C123",
        threadTs: "1.0",
        userId: "U123",
        binding: null
      });
      expect(typeof reply === "string" ? reply : reply?.text).toContain("0 open");
      expect(refreshCalls).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("derives dispatcher input for Telegram from saved setup config", () => {
    const built = telegramConfig();

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      telegramBotToken: "123456789:telegram_secret",
      telegramBots: [
        {
          botId: "123456789",
          agentId: "opentag",
          botUsername: "opentag_bot",
          botToken: "123456789:telegram_secret",
          bindingAdminUserIds: ["111", "222"]
        }
      ]
    });
  });

  it("derives dispatcher input for Discord from saved setup config before env fallback", () => {
    const built = discordConfig();

    expect(
      dispatcherRuntimeInputFromCliConfig(built, {
        env: {
          OPENTAG_DISCORD_PUBLIC_KEY: "env_public_key",
          OPENTAG_DISCORD_BOT_TOKEN: "env_bot_token",
          OPENTAG_DISCORD_WEBHOOK_PATH: "/env/discord"
        }
      })
    ).toMatchObject({
      discordMode: "gateway",
      discordBotToken: "discord_bot_token"
    });
  });

  it("passes the service request body limit to GitHub webhook ingress", () => {
    const built = githubConfig();

    expect(
      githubIngressConfigFromCliConfig(built, {
        env: { OPENTAG_MAX_REQUEST_BODY_BYTES: "8192" }
      })
    ).toMatchObject({
      maxRequestBodyBytes: 8192
    });
  });

  it("can keep GitHub callbacks enabled while disabling direct apply capability", () => {
    const built = githubConfig();
    built.daemon.githubApplyToken = null;

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      githubToken: "ghp_token",
      githubCallbackToken: "ghp_token",
      githubApplyToken: null
    });
  });

  it("uses the CLI GitHub webhook port default for legacy configs without a saved port", () => {
    const built = githubConfig();
    delete built.platforms.github!.port;

    expect(githubIngressConfigFromCliConfig(built)).toMatchObject({
      port: 3050
    });
  });

  it("fails before start when the GitHub webhook port is already in use", async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const built = githubConfig(port);

      await expect(assertStartPortsAvailable(built)).rejects.toThrow(
        `OpenTag cannot start GitHub local webhook because port ${port} is already in use.`
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails before start when the GitLab webhook port is already in use", async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const built = gitlabConfig(port);

      await expect(assertStartPortsAvailable(built)).rejects.toThrow(
        `OpenTag cannot start GitLab local webhook because port ${port} is already in use.`
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails before start when the Linear webhook port is already in use", async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const built = linearConfig(port);

      await expect(assertStartPortsAvailable(built)).rejects.toThrow(
        `OpenTag cannot start Linear local webhook because port ${port} is already in use.`
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails fast for GitHub when run branches are not prepared for apply actions", () => {
    const built = githubConfig();
    built.daemon.preparePullRequestBranch = false;
    built.daemon.allowAutoCreatePullRequest = false;

    expect(() => dispatcherRuntimeInputFromCliConfig(built)).toThrow(
      "GitHub platform requires daemon.preparePullRequestBranch=true unless legacy daemon.allowAutoCreatePullRequest is enabled."
    );
  });

  it("fails fast when the Discord public key is set without a bot token", () => {
    const built = config();

    expect(() =>
      dispatcherRuntimeInputFromCliConfig(built, { env: { OPENTAG_DISCORD_PUBLIC_KEY: "pubkey" } })
    ).toThrow("Discord platform requires platforms.discord.botToken or OPENTAG_DISCORD_BOT_TOKEN.");
  });

  it("passes the documented Discord webhook path through to the runtime input", () => {
    const built = config();

    expect(
      dispatcherRuntimeInputFromCliConfig(built, {
        env: {
          OPENTAG_DISCORD_MODE: "webhook",
          OPENTAG_DISCORD_PUBLIC_KEY: "pubkey",
          OPENTAG_DISCORD_BOT_TOKEN: "bot",
          OPENTAG_DISCORD_WEBHOOK_PATH: "/custom/discord"
        }
      })
    ).toMatchObject({
      discordMode: "webhook",
      discordPublicKey: "pubkey",
      discordBotToken: "bot",
      discordWebhookPath: "/custom/discord"
    });
  });

  it("derives Lark ingress config with a default repo binding for one Project Target", () => {
    const built = config();
    built.daemon.runTimeoutMs = 30_000;
    const ingress = larkIngressConfigFromCliConfig(built);
    const repository = built.daemon.repositories[0]!;

    expect(ingress).toMatchObject({
      appId: "cli_test",
      appSecret: "secret_test",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      agentId: "opentag",
      channelPrincipalCredential: expect.any(String),
      botOpenId: "ou_bot",
      runTimeoutMs: 30_000,
      defaultRepoBinding: {
        repoProvider: repository.provider,
        owner: repository.owner,
        repo: repository.repo
      }
    });
  });

  it("omits default Lark repo binding when setup chose bind later", () => {
    const built = config();
    built.platforms.lark!.defaultProjectBinding = false;

    expect(larkIngressConfigFromCliConfig(built).defaultRepoBinding).toBeUndefined();
  });

  it("bootstraps runner, Project Target, and channel bindings in dispatcher state", async () => {
    const built = config();
    built.daemon.channelBindings = [
      {
        provider: "lark",
        accountId: "tenant_1",
        conversationId: "chat_1",
        repoProvider: built.daemon.repositories[0]!.provider,
        owner: built.daemon.repositories[0]!.owner,
        repo: built.daemon.repositories[0]!.repo
      }
    ];
    const calls: string[] = [];

    await bootstrapLocalDispatcher(built, {
      async registerRunner(name) {
        calls.push(`runner:${name}`);
      },
      async bindRepository(binding) {
        calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
      },
      async bindChannel(binding) {
        calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
      }
    });

    expect(calls).toEqual([
      "runner:runner_local",
      `repo:${built.daemon.repositories[0]!.provider}:${built.daemon.repositories[0]!.owner}/${built.daemon.repositories[0]!.repo}`,
      "channel:lark:tenant_1/chat_1"
    ]);
  });

  it("bootstraps a repository-free managed channel without creating a repository binding", async () => {
    const built = slackSocketModeConfig();
    built.daemon.repositories = [];
    built.daemon.channelBindings = [
      {
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        ownership: {
          mode: "managed",
          exclusive: true,
          applicationId: "A123",
          botId: "U123"
        }
      }
    ];
    const calls: string[] = [];

    await bootstrapLocalDispatcher(built, {
      async registerRunner(name) {
        calls.push(`runner:${name}`);
      },
      async bindRepository(binding) {
        calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
      },
      async bindChannel(binding) {
        calls.push(
          `channel:${binding.provider}:${binding.accountId}/${binding.conversationId}:${binding.ownership?.applicationId ?? "unmanaged"}`
        );
      }
    });

    expect(calls).toEqual(["runner:runner_local", "channel:slack:T123/C123:A123"]);
  });

  it("uploads discovered Linear mutation mappings during dispatcher bootstrap", async () => {
    const built = linearConfig();
    const calls: string[] = [];

    await bootstrapLocalDispatcher(built, {
      async registerRunner(name) {
        calls.push(`runner:${name}`);
      },
      async bindRepository(binding) {
        calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
      },
      async upsertRepoMutationMapping(input) {
        calls.push(`mapping:${input.provider}:${input.owner}/${input.repo}:${input.mapping.id}`);
      },
      async bindChannel(binding) {
        calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
      }
    });

    const linear = built.platforms.linear!;
    expect(calls).toEqual([
      "runner:runner_local",
      `repo:${built.daemon.repositories[0]!.provider}:${built.daemon.repositories[0]!.owner}/${built.daemon.repositories[0]!.repo}`,
      `mapping:${linear.projectTarget.repoProvider}:${linear.projectTarget.owner}/${linear.projectTarget.repo}:linear_priority_priority`
    ]);
  });

  it("uploads dynamic Linear relay installation config during dispatcher bootstrap", async () => {
    const built = linearConfig();
    built.platforms.linear!.webhookPath = "/linear/webhooks/install_123";
    const calls: string[] = [];

    await bootstrapLocalDispatcher(built, {
      async registerRunner(name) {
        calls.push(`runner:${name}`);
      },
      async bindRepository(binding) {
        calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
      },
      async upsertLinearRelayInstallation(input) {
        calls.push(`linear:${input.id}:${input.webhookPath}:${input.repoProvider}:${input.owner}/${input.repo}`);
      },
      async bindChannel(binding) {
        calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
      }
    });

    const linear = built.platforms.linear!;
    expect(calls).toEqual([
      "runner:runner_local",
      `repo:${built.daemon.repositories[0]!.provider}:${built.daemon.repositories[0]!.owner}/${built.daemon.repositories[0]!.repo}`,
      `linear:install_123:/linear/webhooks/install_123:${linear.projectTarget.repoProvider}:${linear.projectTarget.owner}/${linear.projectTarget.repo}`
    ]);
  });

  it("uploads Linear OAuth relay auth metadata without leaking the client secret", async () => {
    const built = linearOAuthConfig();
    built.platforms.linear!.webhookPath = "/linear/webhooks/install_oauth";
    let uploaded: unknown;

    await bootstrapLocalDispatcher(built, {
      async registerRunner() {},
      async bindRepository() {},
      async upsertLinearRelayInstallation(input) {
        uploaded = input;
      },
      async bindChannel() {}
    });

    expect(uploaded).toMatchObject({
      id: "install_oauth",
      webhookPath: "/linear/webhooks/install_oauth",
      token: "access_old",
      auth: {
        method: "oauth_app",
        actor: "app",
        clientId: "linear_client_id",
        refreshToken: "refresh_old",
        accessTokenExpiresAt: "2026-07-07T00:04:00.000Z",
        scopes: ["read"]
      }
    });
    expect(JSON.stringify(uploaded)).not.toContain("linear_client_secret");
  });

  it("persists the fixed OAuth webhook path returned by hosted Linear installs", async () => {
    const built = linearConfig();
    built.platforms.linear = {
      ...built.platforms.linear!,
      webhookPath: "/linear/oauth/webhooks",
      auth: {
        method: "hosted_oauth_app",
        actor: "app",
        scopes: ["read", "comments:create", "app:assignable"]
      }
    };
    delete built.platforms.linear.token;
    delete built.platforms.linear.webhookSecret;
    const calls: string[] = [];

    await bootstrapLocalDispatcher(built, {
      async registerRunner(name) {
        calls.push(`runner:${name}`);
      },
      async bindRepository(binding) {
        calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
      },
      async upsertRepoMutationMapping(input) {
        calls.push(`mapping:${input.provider}:${input.owner}/${input.repo}:${input.mapping.id}`);
      },
      async createLinearOAuthInstallation(input) {
        calls.push(`oauth:${input.repoProvider}:${input.owner}/${input.repo}:${input.teamKey}:${input.scopes?.join(",")}`);
        return {
          authorizationUrl: "https://linear.example/oauth/authorize?state=linear_state",
          stateExpiresAt: "2026-07-07T01:00:00.000Z",
          oauthWebhookPath: "/linear/custom/oauth/webhooks",
          installation: {
            id: "install_hosted",
            webhookPath: "/linear/webhooks/install_hosted",
            graphqlUrl: "https://linear.example/custom/graphql",
            teamKey: "OPS",
            projectTarget: {
              repoProvider: input.repoProvider ?? "github",
              owner: input.owner,
              repo: input.repo
            }
          }
        };
      },
      async bindChannel(binding) {
        calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
      }
    });

    expect(calls).toEqual([
      "runner:runner_local",
      `repo:${built.daemon.repositories[0]!.provider}:${built.daemon.repositories[0]!.owner}/${built.daemon.repositories[0]!.repo}`,
      `mapping:${built.platforms.linear!.projectTarget.repoProvider}:${built.platforms.linear!.projectTarget.owner}/${built.platforms.linear!.projectTarget.repo}:linear_priority_priority`,
      `oauth:${built.platforms.linear!.projectTarget.repoProvider}:${built.platforms.linear!.projectTarget.owner}/${built.platforms.linear!.projectTarget.repo}:ENG:read,comments:create,app:assignable`
    ]);
    expect(built.platforms.linear).toMatchObject({
      webhookPath: "/linear/custom/oauth/webhooks",
      graphqlUrl: "https://linear.example/custom/graphql",
      teamKey: "OPS",
      auth: {
        method: "hosted_oauth_app",
        installationId: "install_hosted",
        authorizationUrl: "https://linear.example/oauth/authorize?state=linear_state",
        stateExpiresAt: "2026-07-07T01:00:00.000Z"
      }
    });
  });

  it("starts relay mode without local dispatcher, local port checks, or GitHub ingress", async () => {
    const built = githubConfig();
    built.runtime = {
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    };
    built.daemon.dispatcherUrl = "https://relay.example";
    built.daemon.hermes = {
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{conversationId}"
    };
    const calls: string[] = [];
    const logs: string[] = [];
    const dispatcherHandle = {
      url: "http://localhost:3030",
      server: {},
      async close() {
        calls.push("dispatcher.close");
      }
    } as ReturnType<NonNullable<StartRuntimeDependencies["startDispatcher"]>>;

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {
          calls.push("ports");
        },
        startDispatcher() {
          calls.push("dispatcher");
          return dispatcherHandle;
        },
        startGitHubIngress() {
          calls.push("github-ingress");
          throw new Error("GitHub ingress should not start in relay mode");
        },
        async waitForDispatcher() {
          calls.push("wait");
        },
        async bootstrapDispatcher() {
          calls.push("bootstrap");
        },
        async serveDaemon() {
          calls.push("daemon");
        },
        logger: {
          log(message) {
            logs.push(message);
          }
        }
      }
    });

    expect(calls).toEqual(["wait", "bootstrap", "daemon"]);
    expect(logs.join("\n")).toContain("OpenTag is running in relay mode.");
    expect(logs.join("\n")).toContain("Local dispatcher: disabled");
    expect(logs.join("\n")).toContain("Security: only pair with a relay you operate or trust");
    expect(logs.join("\n")).toContain("GitHub webhook URL: https://relay.example/github/webhooks");
    expect(logs.join("\n")).toContain("GitHub webhook secret: the relay must verify the configured secret before creating runs.");
    expect(logs.join("\n")).toContain("daemon.hermes.profileTemplate is not used");
    expect(logs.join("\n")).toContain("OpenTag will use the fixed profile 'opentag-fixed'");
  });

  it("starts relay mode for GitLab without local dispatcher, local port checks, or local GitLab ingress", async () => {
    const built = gitlabConfig();
    built.runtime = {
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    };
    built.daemon.dispatcherUrl = "https://relay.example";
    const calls: string[] = [];
    const logs: string[] = [];

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {
          calls.push("ports");
        },
        startDispatcher() {
          calls.push("dispatcher");
          throw new Error("local dispatcher should not start in relay mode");
        },
        startGitLabIngress() {
          calls.push("gitlab-ingress");
          throw new Error("GitLab ingress should not start in relay mode");
        },
        async waitForDispatcher() {
          calls.push("wait");
        },
        async bootstrapDispatcher() {
          calls.push("bootstrap");
        },
        async serveDaemon() {
          calls.push("daemon");
        },
        logger: {
          log(message) {
            logs.push(message);
          }
        }
      }
    });

    expect(calls).toEqual(["wait", "bootstrap", "daemon"]);
    expect(logs.join("\n")).toContain("OpenTag is running in relay mode.");
    expect(logs.join("\n")).toContain("GitLab webhook URL: https://relay.example/gitlab/webhooks");
    expect(logs.join("\n")).toContain("GitLab webhook secret: the relay must verify X-Gitlab-Token before creating runs.");
  });

  it("starts relay mode for Linear without local dispatcher, local port checks, or local Linear ingress", async () => {
    const built = linearConfig();
    built.runtime = {
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    };
    built.daemon.dispatcherUrl = "https://relay.example";
    const calls: string[] = [];
    const logs: string[] = [];

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {
          calls.push("ports");
        },
        startDispatcher() {
          calls.push("dispatcher");
          throw new Error("local dispatcher should not start in relay mode");
        },
        startLinearIngress() {
          calls.push("linear-ingress");
          throw new Error("Linear ingress should not start in relay mode");
        },
        async waitForDispatcher() {
          calls.push("wait");
        },
        async bootstrapDispatcher() {
          calls.push("bootstrap");
        },
        async serveDaemon() {
          calls.push("daemon");
        },
        logger: {
          log(message) {
            logs.push(message);
          }
        }
      }
    });

    expect(calls).toEqual(["wait", "bootstrap", "daemon"]);
    expect(logs.join("\n")).toContain("OpenTag is running in relay mode.");
    expect(logs.join("\n")).toContain("Linear webhook URL: https://relay.example/linear/webhooks");
    expect(logs.join("\n")).toContain(
      "Linear webhook secret: the relay must verify Linear-Signature and webhook timestamp before creating runs."
    );
  });

  it("refuses public HTTP relay configs before connecting", async () => {
    const built = githubConfig();
    built.runtime = {
      mode: "relay",
      relayUrl: "http://relay.example",
      relayProvider: "custom"
    };
    built.daemon.dispatcherUrl = "http://relay.example";
    const calls: string[] = [];

    await expect(
      startFromConfig({
        config: built,
        configPath: "/tmp/opentag/config.json",
        signal: abortedSignal(),
        listenForProcessSignals: false,
        dependencies: {
          async waitForDispatcher() {
            calls.push("wait");
          },
          logger: {
            log() {}
          }
        }
      })
    ).rejects.toThrow("Relay URL must use HTTPS unless it points to localhost for local testing.");
    expect(calls).toEqual([]);
  });

  it("keeps local mode on the local dispatcher and platform ingress path", async () => {
    const built = config();
    const calls: string[] = [];
    const dispatcherHandle = {
      url: "http://localhost:3030",
      server: {},
      async close() {
        calls.push("dispatcher.close");
      }
    } as ReturnType<NonNullable<StartRuntimeDependencies["startDispatcher"]>>;

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {
          calls.push("ports");
        },
        startDispatcher() {
          calls.push("dispatcher");
          return dispatcherHandle;
        },
        async waitForDispatcher() {
          calls.push("wait");
        },
        async bootstrapDispatcher() {
          calls.push("bootstrap");
        },
        async serveDaemon() {
          calls.push("daemon");
        },
        startLarkIngress() {
          calls.push("lark-ingress");
          return {
            startPromise: new Promise<void>(() => {}),
            async handleCardAction() {
              return { status: "ignored_card_action_not_opentag" as const };
            },
            async close() {
              calls.push("lark.close");
            }
          };
        },
        logger: {
          log() {}
        }
      }
    });

    expect(calls.slice(0, 2)).toEqual(["ports", "dispatcher"]);
    expect(calls).toEqual(expect.arrayContaining(["wait", "bootstrap", "daemon", "lark-ingress", "lark.close", "dispatcher.close"]));
  });

  it("logs mounted Telegram and Discord dispatcher endpoints in local mode", async () => {
    const built = telegramConfig();
    built.platforms.discord = discordConfig().platforms.discord;
    const calls: string[] = [];
    const logs: string[] = [];
    const dispatcherHandle = {
      url: "http://localhost:3030",
      server: {},
      async close() {
        calls.push("dispatcher.close");
      }
    } as ReturnType<NonNullable<StartRuntimeDependencies["startDispatcher"]>>;

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {
          calls.push("ports");
        },
        startDispatcher() {
          calls.push("dispatcher");
          return dispatcherHandle;
        },
        async waitForDispatcher() {
          calls.push("wait");
        },
        async bootstrapDispatcher() {
          calls.push("bootstrap");
        },
        async serveDaemon() {
          calls.push("daemon");
        },
        logger: {
          log(message) {
            logs.push(message);
          }
        }
      }
    });

    expect(logs.join("\n")).toContain("Telegram: using getUpdates polling");
    expect(logs.join("\n")).toContain("Telegram tunnel: not required in polling mode");
    expect(logs.join("\n")).toContain("Discord: using Gateway connection");
    expect(logs.join("\n")).toContain("Discord tunnel: not required in Gateway mode");
  });

  it("logs the Teams endpoint with the configured dispatcher port", async () => {
    const built = config();
    delete built.platforms.lark;
    built.platforms.teams = {
      appId: "teams_app_id",
      appPassword: "teams_app_password",
      webhookPath: "/teams/messages"
    };
    built.daemon.dispatcherUrl = "http://localhost:4040";
    const logs: string[] = [];
    const dispatcherHandle = {
      url: "http://localhost:4040",
      server: {},
      async close() {}
    } as ReturnType<NonNullable<StartRuntimeDependencies["startDispatcher"]>>;

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {},
        startDispatcher() {
          return dispatcherHandle;
        },
        async waitForDispatcher() {},
        async bootstrapDispatcher() {},
        async serveDaemon() {},
        logger: {
          log(message) {
            logs.push(message);
          }
        }
      }
    });

    expect(logs).toContain("Microsoft Teams local messaging endpoint: http://127.0.0.1:4040/teams/messages");
    expect(logs).toContain("Tunnel example: ngrok http 4040");
  });

  it("fails clearly for relay mode platform ingress that is not supported in the MVP", async () => {
    const built = config();
    built.runtime = {
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    };
    built.daemon.dispatcherUrl = "https://relay.example";

    await expect(
      startFromConfig({
        config: built,
        configPath: "/tmp/opentag/config.json",
        signal: abortedSignal(),
        listenForProcessSignals: false,
        dependencies: {
          async waitForDispatcher() {
            throw new Error("health should not run before platform validation");
          },
          logger: {
            log() {}
          }
        }
      })
    ).rejects.toThrow("Relay mode currently supports GitHub/GitLab/Linear-backed ingress only.");
  });

  it("waits for dispatcher health instead of assuming the port is ready", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(
      waitForDispatcher({
        dispatcherUrl: "http://localhost:3030",
        fetchImpl,
        attempts: 2,
        delayMs: 1
      })
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("times out each dispatcher health attempt", async () => {
    const fetchImpl = hangingFetch();

    await expect(
      waitForDispatcher({
        dispatcherUrl: "http://localhost:3030",
        fetchImpl,
        attempts: 1,
        delayMs: 1,
        timeoutMs: 5
      })
    ).rejects.toThrow("Dispatcher did not become healthy at http://localhost:3030/healthz.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats Ctrl-C shutdown as normal but still rethrows subsystem failures", () => {
    expect(shouldRethrowAbortReason({ shutdownRequested: true, reason: new Error("AbortError") })).toBe(false);
    expect(shouldRethrowAbortReason({ shutdownRequested: false, reason: new Error("daemon crashed") })).toBe(true);
    expect(shouldRethrowAbortReason({ shutdownRequested: false, reason: "stopped" })).toBe(false);
  });
});

describe("slack linear backlog wiring (AMP-153)", () => {
  it("attaches a linear handler to the Socket Mode ingress config", () => {
    const built = slackSocketModeConfig();
    const ingressConfig = slackSocketModeIngressConfigFromCliConfig(built, { env: {} });
    expect(typeof ingressConfig.linear).toBe("function");
  });

  it("attaches a linear handler to the Events API ingress config", () => {
    const built = slackConfig();
    const ingressConfig = slackIngressConfigFromCliConfig(built, { env: {} });
    expect(typeof ingressConfig.linear).toBe("function");
  });

  it("still attaches a linear handler when a linearTokenProvider is threaded through Socket Mode config", () => {
    const built = slackSocketModeConfig();
    const ingressConfig = slackSocketModeIngressConfigFromCliConfig(built, {
      env: {},
      linearTokenProvider: async () => "fresh_token"
    });
    expect(typeof ingressConfig.linear).toBe("function");
  });

  it("still attaches a linear handler when a linearTokenProvider is threaded through Events API config", () => {
    const built = slackConfig();
    const ingressConfig = slackIngressConfigFromCliConfig(built, {
      env: {},
      linearTokenProvider: async () => "fresh_token"
    });
    expect(typeof ingressConfig.linear).toBe("function");
  });
});
