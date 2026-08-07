import { describe, expect, it } from "vitest";
import {
  encodeSlackThreadKey,
  type SlackAppMentionInput,
  normalizeSlackAppMention,
  normalizeSlackChannelMessage,
  parseSlackThreadKey,
  stripSlackAppMention
} from "../src/normalize.js";

describe("Slack normalization", () => {
  it("strips a Slack app mention and preserves the remaining command", () => {
    expect(stripSlackAppMention("<@U_APP> fix this", "U_APP")).toBe("fix this");
  });

  it("strips the full leading mention run when a teammate is mentioned before the bot", () => {
    expect(stripSlackAppMention("<@U_TEAMMATE> <@U_APP> fix this", "U_APP")).toBe("fix this");
  });

  it("matches the bot when its leading mention carries a display-name label", () => {
    expect(stripSlackAppMention("<@U_APP|opentag> fix this", "U_APP")).toBe("fix this");
  });

  it("matches a labeled bot mention even when preceded by a labeled teammate mention", () => {
    expect(
      stripSlackAppMention("<@U_TEAMMATE|alice> <@U_APP|opentag> fix this", "U_APP")
    ).toBe("fix this");
  });

  it("preserves mentions that appear mid-sentence", () => {
    expect(stripSlackAppMention("<@U_APP> ping <@U_TEAMMATE> now", "U_APP")).toBe(
      "ping <@U_TEAMMATE> now"
    );
  });

  it("returns null when the bot is not part of the leading mention run", () => {
    expect(stripSlackAppMention("<@U_TEAMMATE> fix this", "U_APP")).toBeNull();
  });

  it("routes intent correctly when a teammate is mentioned before the bot", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_TEAMMATE> <@U_APP> fix this",
      ts: "1710000000.000100",
      eventId: "Ev999",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: {
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.command.intent).toBe("fix");
  });

  it("normalizes an app_mention into an OpenTagEvent", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> fix this",
      ts: "1710000000.000100",
      eventId: "Ev123",
      eventTime: 1710000000,
      appId: "A123",
      agentId: "gemini",
      botUserId: "U_APP",
      callbackUri: "http://127.0.0.1:3102/github-comment",
      signatureVerified: true,
      binding: {
        teamId: "T123",
        channelId: "C123",
        repoProvider: "gitlab",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.source).toBe("slack");
    expect(event?.command.intent).toBe("fix");
    expect(event?.target).toEqual({
      mention: "<@U_APP>",
      agentId: "gemini"
    });
    expect(event?.metadata).toMatchObject({ teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" });
    expect(event?.metadata).toMatchObject({ repoProvider: "gitlab" });
    expect(event?.metadata).toMatchObject({ slackAppId: "A123", slackBotUserId: "U_APP" });
    expect(event?.metadata).toMatchObject({ channelApplicationId: "A123", channelBotId: "U_APP" });
    expect(event?.metadata).toMatchObject({
      sourceDeliveryId: "Ev123",
      slackEventId: "Ev123",
      webhookSignatureVerified: true,
      signatureState: "verified"
    });
    expect(event?.workItem).toEqual({
      provider: "slack",
      kind: "thread",
      externalId: encodeSlackThreadKey({
        teamId: "T123",
        channelId: "C123",
        threadTs: "1710000000.000100"
      }),
      uri: "slack://team/T123/channel/C123/thread/1710000000.000100",
      ownerContainer: {
        provider: "gitlab",
        id: "acme/demo",
        uri: "https://gitlab.com/acme/demo"
      }
    });
    expect(event?.permissions.map((permission) => permission.scope)).toContain("chat:postMessage");
    expect(event?.permissions.map((permission) => permission.scope)).toContain("reactions:write");
    expect(event?.callback.uri).toBe("http://127.0.0.1:3102/github-comment");
  });

  it("normalizes native Slack ingress through opentag.channel.v1", () => {
    const message = normalizeSlackChannelMessage({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> summarize this thread",
      ts: "1710000000.000100",
      eventId: "EvChannel",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: { teamId: "T123", channelId: "C123" }
    });
    expect(message).toMatchObject({
      protocol: "opentag.channel.v1",
      trigger: "mention",
      source: { channel: { provider: "slack", workspace: "T123", id: "C123" }, actor: { id: "U456" } },
      text: "summarize this thread",
      replyTarget: { purpose: "all" }
    });
  });

  it("encodes and decodes Slack thread keys", () => {
    const key = encodeSlackThreadKey({ teamId: "T123", channelId: "C123", threadTs: "1710000000.000100" });
    expect(parseSlackThreadKey(key)).toEqual({
      teamId: "T123",
      channelId: "C123",
      threadTs: "1710000000.000100"
    });
  });

  it("captures parser hints and preserves requested write scopes", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> fix auth --scope repo:write --executor codex --file src/auth.ts --line 12",
      ts: "1710000000.000100",
      eventId: "Ev789",
      eventTime: 1710000000,
      agentId: "gemini",
      botUserId: "U_APP",
      binding: {
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.target).toMatchObject({ agentId: "gemini", executorHint: "codex" });
    expect(event?.command.parsed?.requestedScopes).toEqual(["repo:write"]);
    expect(event?.permissions.map((permission) => permission.scope)).toEqual(
      expect.arrayContaining(["chat:postMessage", "reactions:write", "runner:local", "repo:read", "repo:write", "pr:create"])
    );
    expect(event?.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", uri: "src/auth.ts", line: 12 })
      ])
    );
  });

  it("grants issue creation permission for explicit Linear issue create requests", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> create a Linear issue for the OAuth callback error",
      ts: "1710000000.000100",
      eventId: "EvLinearIssue",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: {
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.permissions.map((permission) => permission.scope)).toEqual(
      expect.arrayContaining(["chat:postMessage", "reactions:write", "runner:local", "issue:create"])
    );
  });

  it("grants repo write permissions for write-like natural language tasks", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> Add one short sentence to README.md",
      ts: "1710000000.000100",
      eventId: "Ev790",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: {
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.command.intent).toBe("unknown");
    expect(event?.permissions.map((permission) => permission.scope)).toEqual(
      expect.arrayContaining(["chat:postMessage", "reactions:write", "runner:local", "repo:read", "repo:write", "pr:create"])
    );
  });

  it("grants repo write permissions for extensionless repository file targets", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> Add a healthcheck to Dockerfile",
      ts: "1710000000.000100",
      eventId: "Ev792",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: {
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.command.intent).toBe("unknown");
    expect(event?.permissions.map((permission) => permission.scope)).toEqual(
      expect.arrayContaining(["chat:postMessage", "reactions:write", "runner:local", "repo:read", "repo:write", "pr:create"])
    );
  });

  it("keeps non-repo unknown write-like requests read-only", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> Add a support ticket for this customer",
      ts: "1710000000.000100",
      eventId: "Ev791",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: {
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.command.intent).toBe("unknown");
    expect(event?.permissions.map((permission) => permission.scope)).toEqual(["chat:postMessage", "reactions:write", "runner:local"]);
  });

  it.each([
    ["fix", "<@U_APP> fix the login bug"],
    ["run", "<@U_APP> run the test suite"],
    ["write-like", "<@U_APP> Add one short sentence to README.md"]
  ])("keeps repository-free %s commands at channel-and-runner least privilege", (_label, text) => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text,
      ts: "1710000000.000100",
      eventId: "EvRepoFree",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: { teamId: "T123", channelId: "C123" }
    });

    expect(event?.permissions.map((permission) => permission.scope)).toEqual([
      "chat:postMessage",
      "reactions:write",
      "runner:local"
    ]);
    expect(event?.metadata).not.toHaveProperty("repoProvider");
    expect(event?.metadata).not.toHaveProperty("owner");
    expect(event?.metadata).not.toHaveProperty("repo");
  });

  it("filters explicitly requested repository scopes without a complete repository target", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text:
        "<@U_APP> fix auth --scope repo:read --scope repo:write --scope pr:create --scope pr:update --scope issue:create --network restricted",
      ts: "1710000000.000100",
      eventId: "EvExplicitRepoFree",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: { teamId: "T123", channelId: "C123" }
    });

    expect(event?.command.parsed?.requestedScopes).toEqual([
      "repo:read",
      "repo:write",
      "pr:create",
      "pr:update",
      "issue:create",
      "network:restricted"
    ]);
    expect(event?.permissions.map((permission) => permission.scope)).toEqual([
      "chat:postMessage",
      "reactions:write",
      "runner:local",
      "issue:create",
      "network:restricted"
    ]);
  });

  it("treats a partial runtime repository binding as repository-free", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> fix the login bug",
      ts: "1710000000.000100",
      eventId: "EvPartialRepo",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: {
        teamId: "T123",
        channelId: "C123",
        repo: "demo"
      } as SlackAppMentionInput["binding"]
    });

    expect(event?.permissions.map((permission) => permission.scope)).toEqual([
      "chat:postMessage",
      "reactions:write",
      "runner:local"
    ]);
    expect(event?.metadata).not.toHaveProperty("repoProvider");
    expect(event?.metadata).not.toHaveProperty("owner");
    expect(event?.metadata).not.toHaveProperty("repo");
  });
});
