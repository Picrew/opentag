import { describe, expect, it, vi } from "vitest";
import { computeSlackSignature, createSlackEventsApp, verifySlackTimestamp } from "../src/app.js";

describe("Slack events app", () => {
  const now = "2024-06-24T00:00:00.000Z";
  const currentTimestamp = "1719187200";
  const currentClock = () => Number(currentTimestamp) * 1000;

  it("handles Slack url_verification", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("abc123");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("creates a run for a signed app_mention in a bound channel", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "Ev123",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> fix this",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "gitlab", owner: "acme", repo: "demo" };
      },
      createRun,
      now: () => now,
      clock: currentClock,
      callbackUri: "http://127.0.0.1:3102/github-comment"
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledOnce();
    const [event] = createRun.mock.calls[0] ?? [];
    expect(event.target.agentId).toBe("gemini");
    expect(event.metadata.repoProvider).toBe("gitlab");
    expect(event.metadata).toMatchObject({
      sourceDeliveryId: "Ev123",
      slackEventId: "Ev123",
      webhookSignatureVerified: true,
      signatureState: "verified"
    });
  });

  it("replies to /status app mentions without creating a run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const reply = vi.fn(async () => {});
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvStatus",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> /status",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      createRun,
      reply,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, selfService: "status" });
    expect(createRun).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: `${currentTimestamp}.000100`,
      text: expect.stringContaining("OpenTag status:"),
      blocks: expect.arrayContaining([
        expect.objectContaining({
          type: "section",
          text: expect.objectContaining({ text: "*OpenTag status:*" })
        })
      ])
    });
  });

  it("binds a Slack channel from /bind without creating a run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const bindChannel = vi.fn(async () => {});
    const canManageBinding = vi.fn(async () => true);
    const reply = vi.fn(async () => {});
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvBind",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> /bind github:acme/demo",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      bindChannel,
      canManageBinding,
      reply,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, selfService: "bind" });
    expect(createRun).not.toHaveBeenCalled();
    expect(canManageBinding).toHaveBeenCalledWith({
      action: "bind",
      teamId: "T123",
      channelId: "C123",
      threadTs: `${currentTimestamp}.000100`,
      userId: "U456",
      eventId: "EvBind",
      appId: "A_GEMINI"
    });
    expect(bindChannel).toHaveBeenCalledWith({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });
    expect(reply).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: `${currentTimestamp}.000100`,
      text: expect.stringContaining("Connected this Slack channel to Project Target github:acme/demo.")
    });
  });

  it("denies Slack /bind by default before changing the Project Target", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const bindChannel = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvBindDenied",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> /bind github:acme/demo",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      bindChannel,
      reply,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, selfService: "bind", unauthorized: true });
    expect(createRun).not.toHaveBeenCalled();
    expect(bindChannel).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: `${currentTimestamp}.000100`,
      text: expect.stringContaining("Only an authorized Slack binding manager")
    });
  });

  it("replies with usage for malformed /bind and does not create a run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const bindChannel = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvBindUsage",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> /bind /Users/alice/project",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      bindChannel,
      reply,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, selfService: "bind", usage: true });
    expect(createRun).not.toHaveBeenCalled();
    expect(bindChannel).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: `${currentTimestamp}.000100`,
      text: expect.stringContaining("Project Targets never use absolute local paths.")
    });
  });

  it("does not turn /bind into a run when channel binding is unavailable", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const reply = vi.fn(async () => {});
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvBindUnavailable",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> /bind acme/demo",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      reply,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, selfService: "bind", unavailable: true });
    expect(createRun).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: `${currentTimestamp}.000100`,
      text: expect.stringContaining("Slack channel binding from source threads is not configured.")
    });
  });

  it("requests cancellation for /stop app mentions without creating a run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const stopRun = vi.fn(async () => ({ outcome: "cancelled" as const, runId: "run_active" }));
    const reply = vi.fn(async () => {});
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvStop",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> /stop run_active",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      createRun,
      stopRun,
      reply,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      selfService: "stop",
      outcome: "cancelled",
      runId: "run_active"
    });
    expect(createRun).not.toHaveBeenCalled();
    expect(stopRun).toHaveBeenCalledWith({
      teamId: "T123",
      channelId: "C123",
      runId: "run_active",
      requestedBy: "slack:U456"
    });
    expect(reply).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: `${currentTimestamp}.000100`,
      text: expect.stringContaining("Cancellation requested for run run_active.")
    });
  });

  it("submits source-thread action replies from plain Slack messages", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvAction",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "message",
        user: "U456",
        text: "apply label",
        ts: `${currentTimestamp}.000200`,
        thread_ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [
        {
          appId: "A_GEMINI",
          signingSecret: "secret",
          agentId: "gemini",
          callbackUri: "http://127.0.0.1:3102/slack-callback"
        }
      ],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      createRun,
      submitThreadAction,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).toHaveBeenCalledWith({
      id: "approval_slack_EvAction",
      rawText: "apply label",
      actor: {
        provider: "slack",
        providerUserId: "U456",
        handle: "U456",
        organizationId: "T123"
      },
      callback: {
        provider: "slack",
        uri: "http://127.0.0.1:3102/slack-callback",
        threadKey: `T123|C123|${currentTimestamp}.000100`
      },
      metadata: {
        teamId: "T123",
        channelId: "C123",
        messageTs: `${currentTimestamp}.000200`,
        sourceDeliveryId: "EvAction",
        slackEventId: "EvAction",
        slackAppId: "A_GEMINI",
        slackBotUserId: "U_APP",
        webhookSignatureVerified: true,
        signatureState: "verified",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });
  });

  it("submits source-thread actions from Slack Block Kit buttons", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const interactivePayload = {
      type: "block_actions",
      api_app_id: "A_GEMINI",
      team: { id: "T123" },
      user: { id: "U456", username: "alice" },
      channel: { id: "C123" },
      message: {
        ts: `${currentTimestamp}.000500`,
        thread_ts: `${currentTimestamp}.000100`
      },
      container: {
        type: "message",
        channel_id: "C123",
        message_ts: `${currentTimestamp}.000500`,
        thread_ts: `${currentTimestamp}.000100`
      },
      trigger_id: "trigger_apply_1",
      actions: [
        {
          type: "button",
          action_id: "opentag:apply:1",
          block_id: "opentag_actions_1",
          value: JSON.stringify({
            version: 1,
            command: "apply 1",
            proposalId: "proposal_1",
            intentId: "intent_label_1"
          }),
          action_ts: `${currentTimestamp}.000600`
        }
      ]
    };
    const rawBody = new URLSearchParams({ payload: JSON.stringify(interactivePayload) }).toString();
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [
        {
          appId: "A_GEMINI",
          signingSecret: "secret",
          agentId: "gemini",
          callbackUri: "http://127.0.0.1:3102/slack-callback"
        }
      ],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      createRun,
      submitThreadAction,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).toHaveBeenCalledWith({
      id: "approval_slack_block_trigger_apply_1",
      rawText: "apply 1",
      actor: {
        provider: "slack",
        providerUserId: "U456",
        handle: "alice",
        organizationId: "T123"
      },
      callback: {
        provider: "slack",
        uri: "http://127.0.0.1:3102/slack-callback",
        threadKey: `T123|C123|${currentTimestamp}.000100`
      },
      metadata: {
        source: "slack_button",
        teamId: "T123",
        channelId: "C123",
        messageTs: `${currentTimestamp}.000500`,
        slackAppId: "A_GEMINI",
        actionId: "opentag:apply:1",
        blockId: "opentag_actions_1",
        actionTs: `${currentTimestamp}.000600`,
        proposalId: "proposal_1",
        intentId: "intent_label_1",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });
  });

  it("ignores plain non-action messages before resolving channel bindings", async () => {
    const resolveChannelBinding = vi.fn(async () => ({ teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }));
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvPlain",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "message",
        user: "U456",
        text: "thanks, I will look later",
        ts: `${currentTimestamp}.000300`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      resolveChannelBinding,
      createRun,
      submitThreadAction,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(resolveChannelBinding).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).not.toHaveBeenCalled();
  });

  it("ignores Slack message subtypes before validating user-authored message fields", async () => {
    const resolveChannelBinding = vi.fn(async () => ({ teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }));
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvChanged",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C123",
        message: {
          user: "U456",
          text: "apply 1",
          ts: `${currentTimestamp}.000400`
        },
        ts: `${currentTimestamp}.000400`
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      resolveChannelBinding,
      createRun,
      submitThreadAction,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(resolveChannelBinding).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).not.toHaveBeenCalled();
  });

  it("supports multiple Slack apps with different secrets and agent ids", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_2" }));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_DEEPSEEK",
      team_id: "T123",
      event_id: "Ev456",
      event_time: Number(currentTimestamp) + 100,
      authorizations: [{ user_id: "U_DEEP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_DEEP> explain this",
        ts: `${Number(currentTimestamp) + 100}.000100`,
        channel: "C123"
      }
    });
    const timestamp = String(Number(currentTimestamp) + 100);
    const app = createSlackEventsApp({
      slackApps: [
        { appId: "A_GEMINI", signingSecret: "secret_1", agentId: "gemini" },
        { appId: "A_DEEPSEEK", signingSecret: "secret_2", agentId: "deepseek" }
      ],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" };
      },
      createRun,
      now: () => now,
      clock: () => (Number(currentTimestamp) + 100) * 1000
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret_2",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledOnce();
    const [event] = createRun.mock.calls[0] ?? [];
    expect(event.target.agentId).toBe("deepseek");
  });

  it("handles url_verification for one of multiple Slack apps without api_app_id", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [
        { appId: "A_GEMINI", signingSecret: "secret_1", agentId: "gemini" },
        { appId: "A_DEEPSEEK", signingSecret: "secret_2", agentId: "deepseek" }
      ],
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret_2",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("abc123");
  });

  it("returns 400 for malformed JSON payloads", async () => {
    const rawBody = "{not-json";
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("rejects oversized Events API bodies before parsing payloads", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const timestamp = currentTimestamp;
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      recordControlPlaneEvent,
      maxRequestBodyBytes: 8,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(rawBody)),
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_body_too_large", maxBytes: 8 });
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.request_body_rejected",
      severity: "warn",
      subject: "slack:POST /slack/events",
      payload: {
        provider: "slack",
        endpoint: "POST /slack/events",
        reason: "request_body_too_large",
        maxBytes: 8,
        contentLength: String(Buffer.byteLength(rawBody))
      }
    });
  });

  it("returns 400 for payloads that do not match the consumed Slack schema", async () => {
    const rawBody = JSON.stringify({ type: "event_callback", event: "not-an-object" });
    const timestamp = currentTimestamp;
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      recordControlPlaneEvent,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request_body" });
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.request_body_rejected",
      severity: "warn",
      subject: "slack:POST /slack/events",
      payload: {
        provider: "slack",
        endpoint: "POST /slack/events",
        reason: "invalid_request_body",
        contentLength: null
      }
    });
  });

  it("rejects invalid Slack signatures", async () => {
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      recordControlPlaneEvent,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": currentTimestamp,
        "x-slack-signature": "v0=bad"
      },
      body: JSON.stringify({ type: "url_verification", challenge: "abc123" })
    });

    expect(response.status).toBe(401);
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.signature_failed",
      severity: "warn",
      subject: "slack:POST /slack/events",
      payload: {
        provider: "slack",
        endpoint: "POST /slack/events",
        reason: "invalid_signature",
        hasSignature: true,
        hasTimestamp: true
      }
    });
    expect(JSON.stringify(recordControlPlaneEvent.mock.calls)).not.toContain("v0=bad");
  });

  it("rejects stale Slack timestamps", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => {});
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "Ev123",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> fix this",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" };
      },
      createRun,
      recordControlPlaneEvent,
      now: () => now,
      clock: () => (Number(currentTimestamp) + 301) * 1000
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "stale_signature_timestamp" });
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.signature_failed",
      severity: "warn",
      subject: "slack:POST /slack/events",
      payload: {
        provider: "slack",
        endpoint: "POST /slack/events",
        reason: "stale_signature_timestamp",
        hasSignature: true,
        hasTimestamp: true
      }
    });
  });

  it("records missing Slack signature headers before rejecting requests", async () => {
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      recordControlPlaneEvent,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "abc123" })
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "missing_signature_headers" });
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.signature_failed",
      severity: "warn",
      subject: "slack:POST /slack/events",
      payload: {
        provider: "slack",
        endpoint: "POST /slack/events",
        reason: "missing_signature_headers",
        hasSignature: false,
        hasTimestamp: false
      }
    });
  });

  it("validates timestamp age with a five minute default tolerance", () => {
    expect(verifySlackTimestamp({ timestamp: "1710000000", nowMs: 1710000000 * 1000 })).toBe(true);
    expect(verifySlackTimestamp({ timestamp: "1710000000", nowMs: (1710000000 + 300) * 1000 })).toBe(true);
    expect(verifySlackTimestamp({ timestamp: "1710000000", nowMs: (1710000000 + 301) * 1000 })).toBe(false);
  });
});
