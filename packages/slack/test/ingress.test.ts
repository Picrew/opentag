import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeSlackSignature,
  createSlackEventsApp,
  createSlackEventsAppRuntime,
  startSlackIngress
} from "../src/ingress.js";

describe("Slack Events API delivery lanes", () => {
  const now = "2024-06-24T00:00:00.000Z";
  const currentTimestamp = "1719187200";
  const currentClock = () => Number(currentTimestamp) * 1000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function sign(rawBody: string, timestamp = currentTimestamp) {
    return computeSlackSignature({ signingSecret: "secret", timestamp, rawBody });
  }

  function eventBody(eventId: string, text: string) {
    return JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: eventId,
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: `<@U_APP> ${text}`,
        ts: `${currentTimestamp}.${eventId.replace(/\D/gu, "").padStart(6, "0").slice(-6)}`,
        channel: "C123"
      }
    });
  }

  function deliver(app: ReturnType<typeof createSlackEventsApp>, rawBody: string, contentType = "application/json") {
    return app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-slack-request-timestamp": currentTimestamp,
        "x-slack-signature": sign(rawBody)
      },
      body: rawBody
    });
  }

  function baseInput() {
    return {
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => now,
      clock: currentClock
    };
  }

  it("keeps url_verification synchronous and echoes the challenge", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const response = await deliver(createSlackEventsApp(baseInput()), rawBody);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("abc123");
  });

  it.each(["/linear", "linear"])("acks the exact %j query before the slow query and reply finish", async (command) => {
    const queryGate = deferred();
    const linear = vi.fn(async () => {
      await queryGate.promise;
      return "Linear backlog";
    });
    const reply = vi.fn(async () => {});
    const app = createSlackEventsApp({ ...baseInput(), linear, reply });

    const response = await deliver(app, eventBody(`EvLinear${command.length}`, command));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(linear).toHaveBeenCalledOnce());
    expect(reply).not.toHaveBeenCalled();

    queryGate.resolve();
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ channelId: "C123", threadTs: expect.any(String), text: "Linear backlog" })
    );
  });

  it("keeps normal run creation synchronous instead of acknowledging memory-only work", async () => {
    const createRunGate = deferred();
    const createRun = vi.fn(async () => {
      await createRunGate.promise;
      return { runId: "run_1" };
    });
    const app = createSlackEventsApp({ ...baseInput(), createRun });
    let requestSettled = false;

    const responsePromise = deliver(app, eventBody("EvRun1", "fix this")).finally(() => {
      requestSettled = true;
    });

    await vi.waitFor(() => expect(createRun).toHaveBeenCalledOnce());
    expect(requestSettled).toBe(false);
    createRunGate.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("allows a failed control delivery to be retried because it is never marked seen in memory", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const createRun = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("dispatcher unavailable");
      return { runId: "run_retry" };
    });
    const app = createSlackEventsApp({ ...baseInput(), createRun });
    const rawBody = eventBody("EvRunRetry1", "fix this");

    expect((await deliver(app, rawBody)).status).toBe(500);
    const retry = await deliver(app, rawBody);

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ ok: true });
    expect(createRun).toHaveBeenCalledTimes(2);
  });

  it("keeps /linear usage errors synchronous because they do not call Linear", async () => {
    const replyGate = deferred();
    const linear = vi.fn(async () => "should not run");
    const reply = vi.fn(async () => {
      await replyGate.promise;
    });
    const app = createSlackEventsApp({ ...baseInput(), linear, reply });
    let requestSettled = false;

    const responsePromise = deliver(app, eventBody("EvLinearUsage1", "/linear unexpected")).finally(() => {
      requestSettled = true;
    });

    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(requestSettled).toBe(false);
    expect(linear).not.toHaveBeenCalled();
    replyGate.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, selfService: "linear", usage: true });
  });

  it("keeps block action approval processing synchronous", async () => {
    const actionGate = deferred();
    const submitThreadAction = vi.fn(async () => {
      await actionGate.promise;
      return {};
    });
    const interactivePayload = {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "U456", username: "alice" },
      channel: { id: "C123" },
      message: { ts: `${currentTimestamp}.000500`, thread_ts: `${currentTimestamp}.000100` },
      trigger_id: "trigger_apply_1",
      actions: [
        {
          type: "button",
          action_id: "opentag:apply:1",
          value: JSON.stringify({ version: 1, command: "apply 1", proposalId: "proposal_1", intentId: "intent_1" })
        }
      ]
    };
    const rawBody = new URLSearchParams({ payload: JSON.stringify(interactivePayload) }).toString();
    const app = createSlackEventsApp({ ...baseInput(), submitThreadAction });
    let requestSettled = false;

    const responsePromise = deliver(app, rawBody, "application/x-www-form-urlencoded").finally(() => {
      requestSettled = true;
    });

    await vi.waitFor(() => expect(submitThreadAction).toHaveBeenCalledOnce());
    expect(requestSettled).toBe(false);
    actionGate.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it.each([
    ["maxLinearQueryConcurrency", { maxLinearQueryConcurrency: 0 }],
    ["maxLinearQueryOutstanding", { maxLinearQueryOutstanding: 0 }]
  ])("preserves a zero %s setting so startup validation rejects it", (name, limits) => {
    expect(() =>
      startSlackIngress({
        signingSecret: "secret",
        dispatcherUrl: "http://127.0.0.1:1",
        port: -1,
        ...limits
      })
    ).toThrow(`${name} must be a positive integer.`);
  });

  it("bounds only /linear query work and returns 503 without starting overflow work", async () => {
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const audits: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const app = createSlackEventsApp({
      ...baseInput(),
      maxLinearQueryConcurrency: 1,
      maxLinearQueryOutstanding: 2,
      async linear(context) {
        started.push(context.threadTs);
        await new Promise<void>((resolve) => releases.push(resolve));
        return "Linear backlog";
      },
      async reply() {},
      async recordControlPlaneEvent(event) {
        audits.push(event);
      }
    });

    const first = await deliver(app, eventBody("EvLinearBound1", "/linear"));
    const second = await deliver(app, eventBody("EvLinearBound2", "/linear"));
    const overflow = await deliver(app, eventBody("EvLinearBound3", "/linear"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(overflow.status).toBe(503);
    await expect(overflow.json()).resolves.toEqual({ error: "slack_linear_query_queue_full" });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    await vi.waitFor(() =>
      expect(audits).toContainEqual(
        expect.objectContaining({
          type: "availability.backpressure",
          payload: expect.objectContaining({
            lane: "linear_query",
            reason: "linear_query_queue_full",
            maxLinearQueryOutstanding: 2
          })
        })
      )
    );

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    releases.shift()?.();
  });

  it("does not let a saturated /linear query lane block normal control work", async () => {
    const queryGate = deferred();
    const createRun = vi.fn(async () => ({ runId: "run_control" }));
    const app = createSlackEventsApp({
      ...baseInput(),
      createRun,
      maxLinearQueryConcurrency: 1,
      maxLinearQueryOutstanding: 1,
      async linear() {
        await queryGate.promise;
        return "Linear backlog";
      },
      async reply() {}
    });

    expect((await deliver(app, eventBody("EvLinearBusy1", "/linear"))).status).toBe(200);
    expect((await deliver(app, eventBody("EvLinearBusy2", "/linear"))).status).toBe(503);

    const controlResponse = await deliver(app, eventBody("EvControl1", "fix this"));
    expect(controlResponse.status).toBe(200);
    await expect(controlResponse.json()).resolves.toEqual({ ok: true });
    expect(createRun).toHaveBeenCalledOnce();

    queryGate.resolve();
  });

  it("deduplicates only pending or completed /linear queries and permits retry after failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const replyGate = deferred();
    const linear = vi.fn(async () => "Linear backlog");
    let replyAttempts = 0;
    const reply = vi.fn(async () => {
      replyAttempts += 1;
      if (replyAttempts === 1) {
        await replyGate.promise;
        throw new Error("Slack reply failed");
      }
    });
    const app = createSlackEventsApp({ ...baseInput(), linear, reply });
    const rawBody = eventBody("EvLinearRetry1", "/linear");

    expect((await deliver(app, rawBody)).status).toBe(200);
    const pendingDuplicate = await deliver(app, rawBody);
    await expect(pendingDuplicate.json()).resolves.toEqual({ ok: true, ignored: "duplicate_linear_query" });
    expect(linear).toHaveBeenCalledOnce();

    replyGate.resolve();
    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "[slack] async /linear query processing failed:",
        expect.objectContaining({ message: "Slack reply failed" })
      )
    );

    expect((await deliver(app, rawBody)).status).toBe(200);
    await vi.waitFor(() => expect(linear).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));

    const completedDuplicate = await deliver(app, rawBody);
    await expect(completedDuplicate.json()).resolves.toEqual({ ok: true, ignored: "duplicate_linear_query" });
    expect(linear).toHaveBeenCalledTimes(2);
  });

  it("drains active and queued /linear queries when the app runtime closes", async () => {
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const runtime = createSlackEventsAppRuntime({
      ...baseInput(),
      maxLinearQueryConcurrency: 1,
      maxLinearQueryOutstanding: 2,
      async linear(context) {
        started.push(context.threadTs);
        await new Promise<void>((resolve) => releases.push(resolve));
        return "Linear backlog";
      },
      async reply() {}
    });

    expect((await deliver(runtime.app, eventBody("EvLinearDrain1", "/linear"))).status).toBe(200);
    expect((await deliver(runtime.app, eventBody("EvLinearDrain2", "/linear"))).status).toBe(200);
    await vi.waitFor(() => expect(started).toHaveLength(1));

    let closeSettled = false;
    const closePromise = runtime.close().finally(() => {
      closeSettled = true;
    });
    expect(closeSettled).toBe(false);

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(closeSettled).toBe(false);
    releases.shift()?.();

    await closePromise;
    expect(closeSettled).toBe(true);
  });

  it("still returns 400 synchronously for malformed JSON without invoking the processor", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const rawBody = "{not-json";
    const response = await deliver(createSlackEventsApp({ ...baseInput(), createRun }), rawBody);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    expect(createRun).not.toHaveBeenCalled();
  });
});
