import { describe, expect, it } from "vitest";
import {
  createSlackEventProcessor,
  isSlackLinearBacklogQuery,
  type SlackEventEnvelope,
  type SlackEventProcessorInput,
  type SlackThreadActionInput
} from "../src/events.js";

function repoFreeProcessor(submitted: SlackThreadActionInput[]) {
  return createSlackEventProcessor({
    async resolveChannelBinding() {
      return { teamId: "T123", channelId: "C123" };
    },
    async createRun() {
      return { runId: "run_unused" };
    },
    async submitThreadAction(action) {
      submitted.push(action);
    },
    now: () => "2026-07-13T00:00:00.000Z"
  });
}

function expectRepoFreeMetadata(metadata: Record<string, unknown>): void {
  expect(metadata).not.toHaveProperty("repoProvider");
  expect(metadata).not.toHaveProperty("owner");
  expect(metadata).not.toHaveProperty("repo");
}

describe("Slack thread action metadata", () => {
  it("omits repository metadata for a button action in a repository-free channel", async () => {
    const submitted: SlackThreadActionInput[] = [];

    await repoFreeProcessor(submitted).process(
      {
        type: "block_actions",
        api_app_id: "A123",
        team: { id: "T123" },
        user: { id: "U456", username: "alice" },
        channel: { id: "C123" },
        message: { ts: "1719187200.000500", thread_ts: "1719187200.000100" },
        trigger_id: "trigger_apply_1",
        actions: [
          {
            type: "button",
            action_id: "opentag:apply:1",
            value: JSON.stringify({ version: 1, command: "apply 1", proposalId: "proposal_1", intentId: "intent_1" })
          }
        ]
      },
      { agentId: "opentag" }
    );

    expect(submitted).toHaveLength(1);
    expectRepoFreeMetadata(submitted[0]!.metadata);
  });

  it("omits repository metadata for a message action in a repository-free channel", async () => {
    const submitted: SlackThreadActionInput[] = [];

    await repoFreeProcessor(submitted).process(
      {
        type: "event_callback",
        team_id: "T123",
        event_id: "EvApply1",
        event: {
          type: "message",
          user: "U456",
          text: "apply 1",
          ts: "1719187200.000500",
          thread_ts: "1719187200.000100",
          channel: "C123"
        }
      },
      { agentId: "opentag" }
    );

    expect(submitted).toHaveLength(1);
    expectRepoFreeMetadata(submitted[0]!.metadata);
  });
});

describe("Slack /linear self-service command", () => {
  type Reply = Parameters<NonNullable<SlackEventProcessorInput["reply"]>>[0];

  function linearProcessor(input: {
    replies: Reply[];
    runs: string[];
    linearCalls?: number[];
    linearReply?: string | { text: string; textFormat?: "mrkdwn" };
    withLinearHandler?: boolean;
  }) {
    return createSlackEventProcessor({
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      async createRun() {
        input.runs.push("run_created");
        return { runId: "run_1" };
      },
      async reply(reply) {
        input.replies.push(reply);
      },
      ...(input.withLinearHandler === false
        ? {}
        : {
            async linear() {
              input.linearCalls?.push(1);
              return input.linearReply ?? "OpenTag project backlog — 1 open issue";
            }
          }),
      now: () => "2026-07-16T00:00:00.000Z"
    });
  }

  function mentionEvent(text: string) {
    return {
      type: "event_callback" as const,
      team_id: "T123",
      api_app_id: "A123",
      event_id: "EvLinear1",
      event_time: 1719187200,
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "app_mention" as const,
        channel: "C123",
        user: "U456",
        text,
        ts: "1719187200.000100"
      }
    };
  }

  function processVerified(processor: ReturnType<typeof createSlackEventProcessor>, payload: SlackEventEnvelope) {
    return processor.process(payload, { agentId: "opentag", appId: "A123" }, { signatureVerified: true });
  }

  it.each([
    ["team_id", (payload: SlackEventEnvelope) => delete payload.team_id],
    ["event_id", (payload: SlackEventEnvelope) => delete payload.event_id],
    ["event.user", (payload: SlackEventEnvelope) => payload.event && delete payload.event.user],
    ["event.text", (payload: SlackEventEnvelope) => payload.event && delete payload.event.text],
    ["event.ts", (payload: SlackEventEnvelope) => payload.event && delete payload.event.ts],
    ["event.channel", (payload: SlackEventEnvelope) => payload.event && delete payload.event.channel]
  ])("consistently rejects /linear payloads missing %s before routing or processing", async (_field, omitField) => {
    const replies: Reply[] = [];
    const runs: string[] = [];
    const linearCalls: number[] = [];
    const payload: SlackEventEnvelope = mentionEvent("<@UBOT> /linear");
    omitField(payload);

    expect(isSlackLinearBacklogQuery(payload)).toBe(false);
    await expect(
      processVerified(linearProcessor({ replies, runs, linearCalls }), payload)
    ).resolves.toMatchObject({ status: 400, body: { error: "invalid_event_payload" } });
    expect(linearCalls).toHaveLength(0);
    expect(replies).toHaveLength(0);
    expect(runs).toHaveLength(0);
  });

  it.each(["<@UBOT> linear", "<@UBOT> /linear", "<@UBOT> LINEAR", "<@UBOT>  /Linear  "])(
    "replies with the backlog and does not create a run for %j",
    async (text) => {
      const replies: Reply[] = [];
      const runs: string[] = [];
      const linearCalls: number[] = [];

      const result = await processVerified(linearProcessor({ replies, runs, linearCalls }), mentionEvent(text));

      expect(result.body).toMatchObject({ ok: true, selfService: "linear" });
      expect(linearCalls).toHaveLength(1);
      expect(runs).toHaveLength(0);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        cause: { assurance: "verified_http_signature", command: "linear", channelId: "C123", threadTs: "1719187200.000100" }
      });
      expect(replies[0]!.presentation.text).toContain("OpenTag project backlog");
    }
  );

  it("passes Slack identity context with binding:null and never resolves a Project Target binding", async () => {
    const contexts: unknown[] = [];
    const replies: Reply[] = [];
    const runs: string[] = [];
    let bindingCalls = 0;
    const processor = createSlackEventProcessor({
      async resolveChannelBinding() {
        bindingCalls += 1;
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      async createRun() {
        runs.push("run_created");
        return { runId: "run_1" };
      },
      async linear(context) {
        contexts.push(context);
        return { text: "• <https://x|AMP-1>", textFormat: "mrkdwn" };
      },
      async reply(reply) {
        replies.push(reply);
      },
      now: () => "2026-07-16T00:00:00.000Z"
    });
    const payload = mentionEvent("<@UBOT> /linear");
    payload.event.thread_ts = "1719187000.000050";

    await processVerified(processor, payload);

    expect(bindingCalls).toBe(0);
    expect(runs).toHaveLength(0);
    expect(contexts).toEqual([{
      teamId: "T123",
      channelId: "C123",
      threadTs: "1719187000.000050",
      userId: "U456",
      binding: null
    }]);
    expect(replies[0]).toMatchObject({
      cause: { command: "linear", channelId: "C123", threadTs: "1719187000.000050" },
      presentation: { text: "• <https://x|AMP-1>", textFormat: "mrkdwn" }
    });
  });

  it("replies usage for /linear with extra arguments and does not create a run", async () => {
    const replies: Reply[] = [];
    const runs: string[] = [];
    const linearCalls: number[] = [];

    const result = await processVerified(
      linearProcessor({ replies, runs, linearCalls }),
      mentionEvent("<@UBOT> /linear something else")
    );

    expect(result.body).toMatchObject({ ok: true, selfService: "linear", usage: true });
    expect(linearCalls).toHaveLength(0);
    expect(runs).toHaveLength(0);
    expect(replies[0]!.presentation.text).toContain("Usage");
  });

  it("does NOT intercept a bare linear mention with extra words (normal run flow)", async () => {
    const replies: Reply[] = [];
    const runs: string[] = [];
    const linearCalls: number[] = [];

    await processVerified(
      linearProcessor({ replies, runs, linearCalls }),
      mentionEvent("<@UBOT> linear regression in the parser, please fix")
    );

    expect(linearCalls).toHaveLength(0);
    expect(runs).toHaveLength(1);
  });

  it("replies a safe unavailable message when no linear handler is configured", async () => {
    const replies: Reply[] = [];
    const runs: string[] = [];

    const result = await processVerified(
      linearProcessor({ replies, runs, withLinearHandler: false }),
      mentionEvent("<@UBOT> /linear")
    );

    expect(result.body).toMatchObject({ ok: true, selfService: "linear", unavailable: true });
    expect(runs).toHaveLength(0);
    expect(replies[0]!.presentation.text).toContain("not available");
  });

  it("lists /linear in help output", async () => {
    const replies: Reply[] = [];

    await processVerified(linearProcessor({ replies, runs: [] }), mentionEvent("<@UBOT> /help"));

    expect(replies[0]!.presentation.text).toContain("/linear");
  });

  it("forwards textFormat: mrkdwn from a linear handler reply so links are not re-escaped", async () => {
    const replies: Reply[] = [];
    const runs: string[] = [];

    await processVerified(
      linearProcessor({
        replies,
        runs,
        linearReply: { text: "• <https://x|AMP-1> — t", textFormat: "mrkdwn" }
      }),
      mentionEvent("<@UBOT> /linear")
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ presentation: { text: "• <https://x|AMP-1> — t", textFormat: "mrkdwn" } });
  });
});
