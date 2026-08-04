import { createServer, type Server } from "node:net";
import { createOpenTagClient } from "@opentag/client";
import type { OpenTagEvent } from "@opentag/core";
import { computeLinearSignature } from "@opentag/linear";
import { describe, expect, it, vi } from "vitest";
import {
  dispatcherRuntimeInputFromEnv,
  reassessmentObligationTestRuntimeInputFromEnv,
  startDispatcher,
  type LocalDispatcherRuntimeInput
} from "../src/dispatcher.js";

async function listenOnRandomPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Expected test server to listen on a TCP port.");
  }
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function availablePort(): Promise<number> {
  const { server, port } = await listenOnRandomPort();
  await closeServer(server);
  return port;
}

async function withDispatcherServer(
  input: Omit<LocalDispatcherRuntimeInput, "port" | "databasePath">,
  test: (baseUrl: string) => Promise<void>
) {
  const handle = startDispatcher({ ...input, port: 0, databasePath: ":memory:" });
  const address = handle.server.address();
  if (!address || typeof address === "string") {
    await handle.close();
    throw new Error("Expected dispatcher server to listen on a TCP port.");
  }
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await handle.close();
  }
}

function managedChannelEvent(input: {
  provider: "slack" | "lark";
  accountId: string;
  conversationId: string;
  suffix: string;
}): OpenTagEvent {
  return {
    id: `evt_${input.suffix}`,
    source: input.provider,
    sourceEventId: `message_${input.suffix}`,
    receivedAt: "2026-07-13T00:00:00.000Z",
    actor: { provider: input.provider, providerUserId: "user_1" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "summarize this channel", intent: "run", args: {} },
    context: [],
    permissions: [],
    callback: { provider: "test", uri: "https://example.invalid/callback" },
    metadata:
      input.provider === "slack"
        ? { teamId: input.accountId, channelId: input.conversationId }
        : { tenantKey: input.accountId, chatId: input.conversationId }
  };
}

describe("local dispatcher runtime", () => {
  it("holds reassessment only for the exact live-test switch", () => {
    expect(reassessmentObligationTestRuntimeInputFromEnv({
      OPENTAG_REASSESSMENT_OBLIGATION_TEST_HOLD: "true"
    })).toEqual({ autoStart: false, inline: false });
    expect(reassessmentObligationTestRuntimeInputFromEnv({
      OPENTAG_REASSESSMENT_OBLIGATION_TEST_HOLD: "TRUE"
    })).toBeUndefined();
    expect(reassessmentObligationTestRuntimeInputFromEnv({
      OPENTAG_REASSESSMENT_OBLIGATION_TEST_HOLD: "false"
    })).toBeUndefined();
    expect(dispatcherRuntimeInputFromEnv({
      OPENTAG_REASSESSMENT_OBLIGATION_TEST_HOLD: "true"
    }).reassessmentObligations).toEqual({ autoStart: false, inline: false });
  });

  it("parses explicit GitHub completion policies from env", () => {
    expect(dispatcherRuntimeInputFromEnv({
      OPENTAG_GITHUB_COMPLETION_POLICIES_JSON: JSON.stringify([{
        provider: "github",
        owner: " acme ",
        repo: " demo ",
        requiredChecks: [" build ", "test"],
        baseBranch: " main ",
        requireMerge: true
      }])
    }).completionPolicies).toEqual([{
      provider: "github",
      owner: "acme",
      repo: "demo",
      requiredChecks: ["build", "test"],
      baseBranch: "main",
      requireMerge: true
    }]);
  });

  it("rejects incomplete GitHub completion policies", () => {
    expect(() => dispatcherRuntimeInputFromEnv({
      OPENTAG_GITHUB_COMPLETION_POLICIES_JSON: JSON.stringify([{
        provider: "github",
        owner: "acme",
        repo: "demo",
        requiredChecks: []
      }])
    })).toThrow("requiredChecks must be a non-empty string array");
  });

  it("registers matching standalone Slack and Lark channel principals from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_SLACK_APP_ID: "A123",
        OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL: "slack_principal_123",
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        LARK_BOT_OPEN_ID: "ou_bot",
        OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL: "lark_principal_test"
      }).channelPrincipals
    ).toEqual([
      { provider: "slack", applicationId: "A123", credential: "slack_principal_123" },
      { provider: "lark", applicationId: "cli_test", botId: "ou_bot", credential: "lark_principal_test" }
    ]);
  });

  it.each([
    {
      name: "Slack application without a credential",
      env: { OPENTAG_SLACK_APP_ID: "A123" },
      error: "OPENTAG_SLACK_APP_ID and OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together."
    },
    {
      name: "Slack credential without an application",
      env: { OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL: "slack_principal_123" },
      error: "OPENTAG_SLACK_APP_ID and OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together."
    },
    {
      name: "blank Slack credential",
      env: { OPENTAG_SLACK_APP_ID: "A123", OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL: "   " },
      error: "OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL must be a non-empty string"
    },
    {
      name: "Lark application without a credential",
      env: { LARK_APP_ID: "cli_test", LARK_APP_SECRET: "secret_test" },
      error: "LARK_APP_ID and OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together."
    },
    {
      name: "Lark credential without an application",
      env: { OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL: "lark_principal_test" },
      error: "LARK_APP_ID and OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together."
    },
    {
      name: "blank Lark credential",
      env: {
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL: "   "
      },
      error: "OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL must be a non-empty string"
    }
  ])("rejects $name", ({ env, error }) => {
    expect(() => dispatcherRuntimeInputFromEnv(env)).toThrow(error);
  });

  it.each([
    {
      provider: "slack" as const,
      env: {
        OPENTAG_SLACK_APP_ID: "A123",
        OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL: "slack_principal_123"
      },
      applicationId: "A123",
      credential: "slack_principal_123",
      accountId: "T123",
      conversationId: "C123"
    },
    {
      provider: "lark" as const,
      env: {
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        LARK_BOT_OPEN_ID: "ou_bot",
        OPENTAG_LARK_CHANNEL_PRINCIPAL_CREDENTIAL: "lark_principal_test"
      },
      applicationId: "cli_test",
      credential: "lark_principal_test",
      botId: "ou_bot",
      accountId: "tenant_1",
      conversationId: "oc_chat"
    }
  ])("admits a managed $provider run only for the env-derived adapter principal", async (input) => {
    const runtimeInput = dispatcherRuntimeInputFromEnv(input.env);
    await withDispatcherServer(runtimeInput, async (baseUrl) => {
      const owner = createOpenTagClient({
        dispatcherUrl: baseUrl,
        channelPrincipalCredential: input.credential
      });
      await owner.bindChannel({
        provider: input.provider,
        accountId: input.accountId,
        conversationId: input.conversationId,
        ownership: {
          mode: "managed",
          exclusive: true,
          applicationId: input.applicationId,
          ...(input.botId ? { botId: input.botId } : {})
        }
      });

      const missing = await fetch(`${baseUrl}/v1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: `run_${input.provider}_missing_principal`,
          event: managedChannelEvent({ ...input, suffix: `${input.provider}_missing_principal` })
        })
      });
      expect(missing.status).toBe(403);
      await expect(missing.json()).resolves.toEqual({ error: "managed_channel_ownership_unverified" });

      const foreign = createOpenTagClient({
        dispatcherUrl: baseUrl,
        channelPrincipalCredential: `${input.credential}_wrong`
      });
      await expect(
        foreign.createRun({
          runId: `run_${input.provider}_foreign_principal`,
          event: managedChannelEvent({ ...input, suffix: `${input.provider}_foreign_principal` })
        })
      ).rejects.toThrow("403");

      await expect(
        owner.createRun({
          runId: `run_${input.provider}_owner_principal`,
          event: managedChannelEvent({ ...input, suffix: `${input.provider}_owner_principal` })
        })
      ).resolves.toMatchObject({ outcome: "run_created" });
    });
  });

  it("parses per-agent Slack bot tokens from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_SLACK_BOT_TOKENS_JSON: JSON.stringify({ reviewer: "xoxb-reviewer" })
      }).slackBotTokensByAgentId
    ).toEqual({ reviewer: "xoxb-reviewer" });
  });

  it("rejects non-string per-agent bot tokens", () => {
    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_SLACK_BOT_TOKENS_JSON: JSON.stringify({ reviewer: 123 })
      })
    ).toThrow("Token for agent reviewer must be a non-empty string");
  });

  it("can split GitHub callback and apply tokens from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_GITHUB_TOKEN: "ghp_callback_and_apply",
        OPENTAG_GITHUB_CALLBACK_TOKEN: "ghp_callback",
        OPENTAG_GITHUB_APPLY_TOKEN: "ghp_apply"
      })
    ).toMatchObject({
      githubToken: "ghp_callback_and_apply",
      githubCallbackToken: "ghp_callback",
      githubApplyToken: "ghp_apply"
    });
  });

  it("parses GitLab callback/apply settings from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_GITLAB_TOKEN: "glpat_callback_and_apply",
        OPENTAG_GITLAB_BASE_URL: "https://gitlab.example.com",
        OPENTAG_GITLAB_WEBHOOK_SECRET: "gitlab_webhook_secret",
        OPENTAG_GITLAB_WEBHOOK_PATH: "/gitlab/webhooks"
      })
    ).toMatchObject({
      gitlabToken: "glpat_callback_and_apply",
      gitlabBaseUrl: "https://gitlab.example.com",
      gitlabWebhookSecret: "gitlab_webhook_secret",
      gitlabWebhookPath: "/gitlab/webhooks"
    });
  });

  it("parses Linear callback/apply settings from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_LINEAR_API_KEY: "lin_api_callback_and_apply",
        OPENTAG_LINEAR_GRAPHQL_URL: "https://linear.example/graphql",
        OPENTAG_LINEAR_WEBHOOK_SECRET: "linear_webhook_secret",
        OPENTAG_LINEAR_WEBHOOK_PATH: "/linear/webhooks",
        OPENTAG_LINEAR_REPO_PROVIDER: "github",
        OPENTAG_LINEAR_REPO_OWNER: "acme",
        OPENTAG_LINEAR_REPO_NAME: "demo"
      })
    ).toMatchObject({
      linearToken: "lin_api_callback_and_apply",
      linearGraphqlUrl: "https://linear.example/graphql",
      linearWebhookSecret: "linear_webhook_secret",
      linearWebhookPath: "/linear/webhooks",
      linearProjectTarget: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });
  });

  it("parses Linear hosted OAuth install settings from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_LINEAR_OAUTH_CLIENT_ID: "linear_client",
        OPENTAG_LINEAR_OAUTH_CLIENT_SECRET: "linear_secret",
        OPENTAG_LINEAR_OAUTH_REDIRECT_URI: "https://relay.example/linear/oauth/callback",
        OPENTAG_LINEAR_OAUTH_WEBHOOK_SECRET: "linear_app_webhook_secret",
        OPENTAG_LINEAR_OAUTH_WEBHOOK_PATH: "/linear/oauth/webhooks",
        OPENTAG_LINEAR_OAUTH_SCOPES: "read,write comments:create app:assignable"
      })
    ).toMatchObject({
      linearOAuthInstall: {
        clientId: "linear_client",
        clientSecret: "linear_secret",
        redirectUri: "https://relay.example/linear/oauth/callback",
        webhookSecret: "linear_app_webhook_secret",
        webhookPath: "/linear/oauth/webhooks",
        scopes: ["read", "write", "comments:create", "app:assignable"]
      }
    });
  });

  it("advertises Linear hosted OAuth install support when configured", async () => {
    await withDispatcherServer(
      {
        linearOAuthInstall: {
          clientId: "linear_client",
          redirectUri: "https://relay.example/linear/oauth/callback",
          webhookSecret: "linear_app_webhook_secret"
        }
      },
      async (baseUrl) => {
        const capabilities = await fetch(`${baseUrl}/v1/relay/capabilities`);
        expect(capabilities.status).toBe(200);
        await expect(capabilities.json()).resolves.toMatchObject({
          relay: true,
          platforms: [
            {
              provider: "linear",
              ingress: {
                enabled: true,
                path: "/linear/oauth/webhooks",
                signatureVerification: "configured"
              },
              oauthInstall: {
                enabled: true,
                path: "/v1/linear-oauth-installations"
              }
            }
          ]
        });
      }
    );
  });

  it("rejects incomplete Linear hosted OAuth install settings", () => {
    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_LINEAR_OAUTH_CLIENT_ID: "linear_client"
      })
    ).toThrow("OPENTAG_LINEAR_OAUTH_CLIENT_ID and OPENTAG_LINEAR_OAUTH_REDIRECT_URI must be configured together.");

    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_LINEAR_OAUTH_REDIRECT_URI: "https://relay.example/linear/oauth/callback"
      })
    ).toThrow("OPENTAG_LINEAR_OAUTH_CLIENT_ID and OPENTAG_LINEAR_OAUTH_REDIRECT_URI must be configured together.");
  });

  it("uses the env-derived Project Target for Linear relay ingress when Linear-specific repo env is omitted", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_LINEAR_API_KEY: "lin_api_callback_and_apply",
        OPENTAG_LINEAR_WEBHOOK_SECRET: "linear_webhook_secret",
        OPENTAG_REPO_OWNER: "amplifthq",
        OPENTAG_REPO_NAME: "opentag",
        OPENTAG_REPO_PROVIDER: "github"
      })
    ).toMatchObject({
      linearProjectTarget: {
        repoProvider: "github",
        owner: "amplifthq",
        repo: "opentag"
      }
    });
  });

  it("rejects incomplete Linear relay Project Target env", () => {
    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_LINEAR_API_KEY: "lin_api_callback_and_apply",
        OPENTAG_LINEAR_WEBHOOK_SECRET: "linear_webhook_secret",
        OPENTAG_LINEAR_REPO_OWNER: "acme"
      })
    ).toThrow("OPENTAG_LINEAR_REPO_OWNER and OPENTAG_LINEAR_REPO_NAME must be configured together.");
  });

  it("can split pairing and runner dispatcher tokens from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_PAIRING_TOKEN: "pairing_token",
        OPENTAG_RUNNER_TOKEN: "runner_token",
        OPENTAG_RUNNER_TOKENS_JSON: JSON.stringify(["runner_old"]),
        OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON: JSON.stringify(["abc123"])
      })
    ).toMatchObject({
      pairingToken: "pairing_token",
      runnerToken: "runner_token",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: ["abc123"]
    });
  });

  it("rejects invalid runner token rotation lists", () => {
    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RUNNER_TOKENS_JSON: JSON.stringify(["runner_old", ""])
      })
    ).toThrow("Entry 1 must be a non-empty string");
  });

  it("can disable GitHub direct apply while leaving callback token configured", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_GITHUB_TOKEN: "ghp_callback",
        OPENTAG_GITHUB_APPLY_DISABLED: "true"
      })
    ).toMatchObject({
      githubToken: "ghp_callback",
      githubApplyToken: null
    });
  });

  it("parses dispatcher request body and rate-limit hardening env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_MAX_REQUEST_BODY_BYTES: "4096",
        OPENTAG_RATE_LIMIT_WINDOW_MS: "60000",
        OPENTAG_RATE_LIMIT_MAX_REQUESTS: "120"
      })
    ).toMatchObject({
      maxRequestBodyBytes: 4096,
      rateLimit: {
        windowMs: 60000,
        maxRequests: 120
      }
    });
  });

  it("rejects partial or invalid dispatcher hardening env", () => {
    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_MAX_REQUEST_BODY_BYTES: "0"
      })
    ).toThrow("OPENTAG_MAX_REQUEST_BODY_BYTES must be a positive integer");

    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RATE_LIMIT_WINDOW_MS: "60000"
      })
    ).toThrow("OPENTAG_RATE_LIMIT_WINDOW_MS and OPENTAG_RATE_LIMIT_MAX_REQUESTS must be configured together");

    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RATE_LIMIT_DISABLED: "yes"
      })
    ).toThrow("OPENTAG_RATE_LIMIT_DISABLED must be either true or false");
  });

  it("makes dispatcher rate limiting explicitly disableable", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RATE_LIMIT_DISABLED: "true"
      })
    ).toMatchObject({ rateLimit: false });

    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RATE_LIMIT_DISABLED: "true",
        OPENTAG_RATE_LIMIT_WINDOW_MS: "60000",
        OPENTAG_RATE_LIMIT_MAX_REQUESTS: "120"
      })
    ).toThrow("OPENTAG_RATE_LIMIT_DISABLED cannot be true");
  });

  it("wires configured request body limits into the started dispatcher", async () => {
    await withDispatcherServer({ maxRequestBodyBytes: 24 }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/runners`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "request_body_too_large", maxBytes: 24 });
    });
  });

  it("wires configured rate limits into the started dispatcher", async () => {
    await withDispatcherServer(
      {
        rateLimit: {
          windowMs: 1_000,
          maxRequests: 1,
          now: () => 10_000
        }
      },
      async (baseUrl) => {
        const first = await fetch(`${baseUrl}/v1/runners/runner_1`, {
          headers: { authorization: "Bearer token_a" }
        });
        expect(first.status).toBe(404);

        const second = await fetch(`${baseUrl}/v1/runners/runner_1`, {
          headers: { authorization: "Bearer token_a" }
        });
        expect(second.status).toBe(429);
        await expect(second.json()).resolves.toEqual({
          error: "rate_limited",
          retryAfterMs: 1_000,
          maxRequests: 1,
          windowMs: 1_000
        });
      }
    );
  });

  it("mounts GitLab webhook ingress on the dispatcher when a relay secret is configured", async () => {
    const port = await availablePort();
    const handle = startDispatcher({
      port,
      databasePath: ":memory:",
      gitlabBaseUrl: "https://gitlab.example.com",
      gitlabWebhookSecret: "gitlab_webhook_secret",
      gitlabWebhookPath: "/gitlab/webhooks"
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const capabilities = await fetch(`${baseUrl}/v1/relay/capabilities`);
      expect(capabilities.status).toBe(200);
      await expect(capabilities.json()).resolves.toMatchObject({
        relay: true,
        platforms: [
          {
            provider: "gitlab",
            ingress: {
              enabled: true,
              path: "/gitlab/webhooks",
              signatureVerification: "configured"
            },
            callback: {
              enabled: false
            },
            apply: {
              enabled: false
            }
          }
        ]
      });

      const binding = await fetch(`${baseUrl}/v1/repo-bindings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "gitlab",
          owner: "acme/team",
          repo: "demo",
          runnerId: "runner_1",
          workspacePath: "/Users/test/demo",
          defaultExecutor: "echo"
        })
      });
      expect(binding.status).toBe(201);

      const webhook = await fetch(`${baseUrl}/gitlab/webhooks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-event": "Note Hook",
          "x-gitlab-token": "gitlab_webhook_secret"
        },
        body: JSON.stringify({
          object_kind: "note",
          object_attributes: {
            id: 1004,
            note: "@opentag investigate this issue",
            url: "https://gitlab.example.com/acme/team/demo/-/issues/7#note_1004",
            noteable_type: "Issue"
          },
          project: {
            id: 42,
            path_with_namespace: "acme/team/demo",
            visibility: "private",
            web_url: "https://gitlab.example.com/acme/team/demo"
          },
          issue: {
            iid: 7,
            url: "https://gitlab.example.com/acme/team/demo/-/issues/7"
          },
          user: {
            id: 9,
            username: "alice"
          }
        })
      });
      expect(webhook.status).toBe(200);
      await expect(webhook.json()).resolves.toEqual({ ok: true });

      const claim = await fetch(`${baseUrl}/v1/runners/runner_1/claim`, { method: "POST" });
      expect(claim.status).toBe(200);
      await expect(claim.json()).resolves.toMatchObject({
        event: {
          source: "gitlab",
          metadata: {
            repoProvider: "gitlab",
            owner: "acme/team",
            repo: "demo"
          }
        },
        run: {
          status: "assigned"
        }
      });
    } finally {
      await handle.close();
    }
  });

  it("mounts Linear webhook ingress on the dispatcher when a relay secret is configured", async () => {
    const port = await availablePort();
    const handle = startDispatcher({
      port,
      databasePath: ":memory:",
      linearWebhookSecret: "linear_webhook_secret",
      linearWebhookPath: "/linear/webhooks",
      linearProjectTarget: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const capabilities = await fetch(`${baseUrl}/v1/relay/capabilities`);
      expect(capabilities.status).toBe(200);
      await expect(capabilities.json()).resolves.toMatchObject({
        relay: true,
        platforms: [
          {
            provider: "linear",
            ingress: {
              enabled: true,
              path: "/linear/webhooks",
              signatureVerification: "configured"
            },
            callback: {
              enabled: false
            },
            apply: {
              enabled: false
            }
          }
        ]
      });

      const binding = await fetch(`${baseUrl}/v1/repo-bindings`, {
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
      expect(binding.status).toBe(201);

      const webhookTimestamp = Date.now();
      const body = JSON.stringify({
        type: "Comment",
        action: "create",
        webhookId: "webhook_1",
        organizationId: "org_1",
        createdAt: "2026-06-24T00:00:00.000Z",
        webhookTimestamp,
        data: {
          id: "comment_1",
          body: "@opentag investigate this issue",
          url: "https://linear.app/acme/issue/ENG-1#comment_1",
          issue: {
            id: "issue_123",
            identifier: "ENG-1",
            title: "Demo issue",
            url: "https://linear.app/acme/issue/ENG-1/demo",
            team: {
              id: "team_eng",
              key: "ENG",
              name: "Engineering"
            }
          },
          user: {
            id: "user_1",
            name: "alice"
          }
        }
      });
      const webhook = await fetch(`${baseUrl}/linear/webhooks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody: body }),
          "linear-timestamp": String(webhookTimestamp)
        },
        body
      });
      expect(webhook.status).toBe(200);
      await expect(webhook.json()).resolves.toEqual({ ok: true, runId: expect.any(String) });

      const claim = await fetch(`${baseUrl}/v1/runners/runner_1/claim`, { method: "POST" });
      expect(claim.status).toBe(200);
      await expect(claim.json()).resolves.toMatchObject({
        event: {
          source: "linear",
          metadata: {
            repoProvider: "github",
            owner: "acme",
            repo: "demo",
            issueId: "issue_123",
            issueIdentifier: "ENG-1"
          }
        },
        run: {
          status: "assigned"
        }
      });
    } finally {
      await handle.close();
    }
  });

  it("acknowledges Linear AgentSessionEvent webhooks from dispatcher-mounted relay ingress", async () => {
    const port = await availablePort();
    const originalFetch = globalThis.fetch;
    const linearRequests: Array<{ authorization: string | null; body: { query?: string; variables?: unknown } }> = [];
    vi.stubGlobal("fetch", (async (url, init) => {
      if (String(url) === "https://linear.example/graphql") {
        const body = JSON.parse(String(init?.body)) as { query?: string; variables?: unknown };
        linearRequests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body
        });
        if (body.query?.includes("agentActivityCreate")) {
          return Response.json({ data: { agentActivityCreate: { success: true, agentActivity: { id: "activity_accepted" } } } });
        }
        return Response.json({ data: { agentSessionUpdate: { success: true } } });
      }
      return originalFetch(url, init);
    }) as typeof fetch);
    const handle = startDispatcher({
      port,
      databasePath: ":memory:",
      linearToken: "app_access",
      linearGraphqlUrl: "https://linear.example/graphql",
      linearWebhookSecret: "linear_webhook_secret",
      linearWebhookPath: "/linear/webhooks",
      linearProjectTarget: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const binding = await fetch(`${baseUrl}/v1/repo-bindings`, {
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
      expect(binding.status).toBe(201);

      const webhookTimestamp = Date.now();
      const body = JSON.stringify({
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "webhook_agent_1",
        organizationId: "org_1",
        createdAt: "2026-06-24T00:00:00.000Z",
        webhookTimestamp,
        promptContext: "<issue identifier=\"ENG-1\">Demo issue</issue>",
        agentSession: {
          id: "agent_session_1",
          creator: { id: "user_1", name: "alice" },
          issue: {
            id: "issue_123",
            identifier: "ENG-1",
            title: "Demo issue",
            url: "https://linear.app/acme/issue/ENG-1/demo",
            team: {
              id: "team_eng",
              key: "ENG",
              name: "Engineering"
            }
          }
        }
      });
      const webhook = await fetch(`${baseUrl}/linear/webhooks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": computeLinearSignature({ webhookSecret: "linear_webhook_secret", rawBody: body }),
          "linear-timestamp": String(webhookTimestamp)
        },
        body
      });
      expect(webhook.status).toBe(200);
      await expect(webhook.json()).resolves.toEqual({ ok: true, runId: expect.any(String) });

      await vi.waitFor(() => {
        expect(linearRequests).toHaveLength(2);
      });
      expect(linearRequests.map((request) => request.authorization)).toEqual(["Bearer app_access", "Bearer app_access"]);
      expect(linearRequests[0]!.body.query).toContain("agentSessionUpdate");
      expect(linearRequests[0]!.body.variables).toMatchObject({
        agentSessionId: "agent_session_1",
        input: {
          plan: [
            { content: "Accept the Linear agent session", status: "completed" },
            { content: "Run OpenTag on the paired local checkout", status: "inProgress" },
            { content: "Report the result back to Linear", status: "pending" }
          ]
        }
      });
      expect(linearRequests[1]!.body.query).toContain("agentActivityCreate");
      expect(linearRequests[1]!.body.variables).toMatchObject({
        input: {
          agentSessionId: "agent_session_1",
          content: {
            type: "thought",
            body: expect.stringContaining("OpenTag picked this up")
          }
        }
      });
    } finally {
      vi.unstubAllGlobals();
      await handle.close();
    }
  });
});
