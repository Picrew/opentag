import { createHmac, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { DEFAULT_MAX_REQUEST_BODY_BYTES, RequestBodyTooLargeError, readRequestTextWithLimit } from "@opentag/core";
import { Hono } from "hono";
import { createSlackDispatcherEventProcessorInput, type SlackChannelPrincipalConfig } from "./dispatcher-events.js";
import {
  createSlackEventProcessor,
  isSlackLinearBacklogQuery,
  type SlackAppRuntimeConfig,
  type SlackEventProcessorInput,
  type SlackIngressPayload
} from "./events.js";

export type SlackEventsAppInput = {
  slackApps: Array<
    SlackAppRuntimeConfig & {
      signingSecret: string;
    }
  >;
  clock?: () => number;
  recordControlPlaneEvent?(event: {
    type: string;
    severity?: "info" | "warn" | "error";
    subject?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  maxRequestBodyBytes?: number;
  maxLinearQueryConcurrency?: number;
  maxLinearQueryOutstanding?: number;
} & SlackEventProcessorInput;

export type SlackEventsApiIngressConfig = {
  signingSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  botToken?: string;
  port?: number;
  agentId?: string;
  callbackUri?: string;
  bindingAdminUserIds?: string[];
  runTimeoutMs?: number;
  maxRequestBodyBytes?: number;
  maxLinearQueryConcurrency?: number;
  maxLinearQueryOutstanding?: number;
  linear?: SlackEventProcessorInput["linear"];
} & SlackChannelPrincipalConfig;

export type SlackIngressConfig = SlackEventsApiIngressConfig;

const DEFAULT_LINEAR_QUERY_CONCURRENCY = 8;
const DEFAULT_LINEAR_QUERY_MAX_OUTSTANDING = 100;
const MAX_COMPLETED_LINEAR_QUERY_EVENT_IDS = 1000;

type AsyncTask = () => Promise<void>;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer.`);
  return resolved;
}

function createBoundedAsyncExecutor(input: {
  concurrency: number;
  maxOutstanding: number;
  onError(error: unknown): void;
}) {
  let active = 0;
  let accepting = true;
  const queue: AsyncTask[] = [];
  const idleWaiters = new Set<() => void>();

  function resolveIdleWaiters(): void {
    if (active !== 0 || queue.length !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function drain(): void {
    while (active < input.concurrency && queue.length > 0) {
      const task = queue.shift()!;
      active += 1;
      void Promise.resolve()
        .then(task)
        .catch(input.onError)
        .finally(() => {
          active -= 1;
          drain();
          resolveIdleWaiters();
        });
    }
  }

  return {
    tryEnqueue(task: AsyncTask): boolean {
      if (!accepting || active + queue.length >= input.maxOutstanding) return false;
      queue.push(task);
      drain();
      return true;
    },
    closeAndDrain(): Promise<void> {
      accepting = false;
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    }
  };
}

function recordSlackLinearQueryQueueFull(input: {
  recordControlPlaneEvent?: SlackEventsAppInput["recordControlPlaneEvent"];
  apiAppId?: string;
  maxLinearQueryConcurrency: number;
  maxLinearQueryOutstanding: number;
}): void {
  void (async () => {
    try {
      await input.recordControlPlaneEvent?.({
        type: "availability.backpressure",
        severity: "warn",
        subject: "slack:POST /slack/events",
        payload: {
          provider: "slack",
          endpoint: "POST /slack/events",
          lane: "linear_query",
          reason: "linear_query_queue_full",
          maxLinearQueryConcurrency: input.maxLinearQueryConcurrency,
          maxLinearQueryOutstanding: input.maxLinearQueryOutstanding,
          ...(input.apiAppId ? { apiAppId: input.apiAppId } : {})
        }
      });
    } catch {
      // Backpressure must remain visible to Slack even when audit reporting is unavailable.
    }
  })();
}

export type SlackIngressHandle = {
  url: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

export type SlackEventsAppRuntime = {
  app: Hono;
  close(): Promise<void>;
};

export function computeSlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
}): string {
  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const digest = createHmac("sha256", input.signingSecret).update(base).digest("hex");
  return `v0=${digest}`;
}

export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
}): boolean {
  const expected = computeSlackSignature(input);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(input.signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifySlackTimestamp(input: { timestamp: string; nowMs: number; toleranceSeconds?: number }): boolean {
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  const ageSeconds = Math.abs(Math.floor(input.nowMs / 1000) - timestampSeconds);
  return ageSeconds <= toleranceSeconds;
}

async function recordSlackSignatureFailure(input: {
  recordControlPlaneEvent?: SlackEventsAppInput["recordControlPlaneEvent"];
  reason: "missing_signature_headers" | "stale_signature_timestamp" | "invalid_signature" | "unknown_slack_app";
  hasSignature: boolean;
  hasTimestamp: boolean;
  apiAppId?: string;
}): Promise<void> {
  try {
    await input.recordControlPlaneEvent?.({
      type: "security.signature_failed",
      severity: "warn",
      subject: "slack:POST /slack/events",
      payload: {
        provider: "slack",
        endpoint: "POST /slack/events",
        reason: input.reason,
        hasSignature: input.hasSignature,
        hasTimestamp: input.hasTimestamp,
        ...(input.apiAppId ? { apiAppId: input.apiAppId } : {})
      }
    });
  } catch {
    // Signature rejection should not turn into a 5xx if audit reporting is unavailable.
  }
}

async function recordSlackRequestBodyRejected(input: {
  recordControlPlaneEvent?: SlackEventsAppInput["recordControlPlaneEvent"];
  reason: "request_body_too_large" | "invalid_json_body" | "invalid_request_body";
  maxBytes?: number;
  contentLength: string | null;
  apiAppId?: string;
}): Promise<void> {
  try {
    await input.recordControlPlaneEvent?.({
      type: "security.request_body_rejected",
      severity: "warn",
      subject: "slack:POST /slack/events",
      payload: {
        provider: "slack",
        endpoint: "POST /slack/events",
        reason: input.reason,
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        contentLength: input.contentLength,
        ...(input.apiAppId ? { apiAppId: input.apiAppId } : {})
      }
    });
  } catch {
    // Oversized-payload rejection should still fail closed if audit reporting is unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOptionalStringProperties(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === "string");
}

function isSlackEventEnvelope(value: Record<string, unknown>): boolean {
  if (value.type !== "url_verification" && value.type !== "event_callback") return false;
  if (!hasOptionalStringProperties(value, ["token", "challenge", "team_id", "api_app_id", "event_id"])) return false;
  if (value.event_time !== undefined && typeof value.event_time !== "number") return false;
  if (value.authorizations !== undefined) {
    if (!Array.isArray(value.authorizations)) return false;
    if (
      !value.authorizations.every(
        (authorization) =>
          isRecord(authorization) && (authorization.user_id === undefined || typeof authorization.user_id === "string")
      )
    ) {
      return false;
    }
  }
  if (value.event !== undefined) {
    if (!isRecord(value.event) || typeof value.event.type !== "string") return false;
    if (!hasOptionalStringProperties(value.event, ["user", "text", "ts", "thread_ts", "channel", "subtype", "bot_id"])) {
      return false;
    }
  }
  return true;
}

function isSlackInteractivePayload(value: Record<string, unknown>): boolean {
  if (value.type !== "block_actions") return false;
  if (!hasOptionalStringProperties(value, ["api_app_id", "trigger_id"])) return false;
  if (value.team !== undefined && (!isRecord(value.team) || !hasOptionalStringProperties(value.team, ["id", "domain"]))) return false;
  if (value.user !== undefined && (!isRecord(value.user) || !hasOptionalStringProperties(value.user, ["id", "username", "name"]))) return false;
  if (value.channel !== undefined && (!isRecord(value.channel) || !hasOptionalStringProperties(value.channel, ["id", "name"]))) return false;
  if (value.message !== undefined && (!isRecord(value.message) || !hasOptionalStringProperties(value.message, ["ts", "thread_ts"]))) return false;
  if (
    value.container !== undefined &&
    (!isRecord(value.container) ||
      !hasOptionalStringProperties(value.container, ["type", "channel_id", "message_ts", "thread_ts"]))
  ) {
    return false;
  }
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) return false;
    return value.actions.every(
      (action) =>
        isRecord(action) &&
        hasOptionalStringProperties(action, ["type", "action_id", "block_id", "value", "action_ts"])
    );
  }
  return true;
}

function isSlackIngressPayload(value: unknown): value is SlackIngressPayload {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  return isSlackEventEnvelope(value) || isSlackInteractivePayload(value);
}

export function createSlackEventsAppRuntime(input: SlackEventsAppInput): SlackEventsAppRuntime {
  const app = new Hono();
  const processor = createSlackEventProcessor(input);
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const maxLinearQueryConcurrency = positiveInteger(
    input.maxLinearQueryConcurrency,
    DEFAULT_LINEAR_QUERY_CONCURRENCY,
    "maxLinearQueryConcurrency"
  );
  const maxLinearQueryOutstanding = positiveInteger(
    input.maxLinearQueryOutstanding,
    DEFAULT_LINEAR_QUERY_MAX_OUTSTANDING,
    "maxLinearQueryOutstanding"
  );
  const linearQueryExecutor = createBoundedAsyncExecutor({
    concurrency: maxLinearQueryConcurrency,
    maxOutstanding: maxLinearQueryOutstanding,
    onError(error) {
      console.error("[slack] async /linear query processing failed:", error);
    }
  });
  const pendingLinearQueryEventIds = new Set<string>();
  const completedLinearQueryEventIds = new Set<string>();

  function rememberCompletedLinearQuery(eventId: string): void {
    completedLinearQueryEventIds.add(eventId);
    if (completedLinearQueryEventIds.size <= MAX_COMPLETED_LINEAR_QUERY_EVENT_IDS) return;
    const oldest = completedLinearQueryEventIds.values().next().value;
    if (oldest !== undefined) completedLinearQueryEventIds.delete(oldest);
  }

  function parseSlackPayload(rawBody: string, contentType?: string): unknown | null {
    try {
      if (contentType?.includes("application/x-www-form-urlencoded") || rawBody.startsWith("payload=")) {
        const interactivePayload = new URLSearchParams(rawBody).get("payload");
        if (!interactivePayload) return null;
        return JSON.parse(interactivePayload) as SlackIngressPayload;
      }
      return JSON.parse(rawBody) as SlackIngressPayload;
    } catch {
      return null;
    }
  }

  function resolveSlackApp(inputValue: {
    apiAppId?: string;
    rawBody: string;
    signature: string;
    timestamp: string;
  }) {
    const candidates = inputValue.apiAppId
      ? input.slackApps.filter((candidate) => !candidate.appId || candidate.appId === inputValue.apiAppId)
      : input.slackApps;
    if (candidates.length === 0) {
      return { error: "unknown_slack_app" as const };
    }
    const slackApp = candidates.find((candidate) =>
      verifySlackSignature({
        signingSecret: candidate.signingSecret,
        timestamp: inputValue.timestamp,
        rawBody: inputValue.rawBody,
        signature: inputValue.signature
      })
    );
    return slackApp ? { slackApp } : { error: "invalid_signature" as const };
  }

  app.post("/slack/events", async (c) => {
    const timestamp = c.req.header("x-slack-request-timestamp");
    const signature = c.req.header("x-slack-signature");
    if (!timestamp || !signature) {
      await recordSlackSignatureFailure({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        reason: "missing_signature_headers",
        hasSignature: Boolean(signature),
        hasTimestamp: Boolean(timestamp)
      });
      return c.json({ error: "missing_signature_headers" }, 401);
    }
    if (!verifySlackTimestamp({ timestamp, nowMs: input.clock?.() ?? Date.now() })) {
      await recordSlackSignatureFailure({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        reason: "stale_signature_timestamp",
        hasSignature: true,
        hasTimestamp: true
      });
      return c.json({ error: "stale_signature_timestamp" }, 401);
    }
    let rawBody: string;
    try {
      rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: maxRequestBodyBytes });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        await recordSlackRequestBodyRejected({
          recordControlPlaneEvent: input.recordControlPlaneEvent,
          reason: "request_body_too_large",
          maxBytes: error.maxBytes,
          contentLength: c.req.raw.headers.get("content-length")
        });
        return c.json({ error: "request_body_too_large", maxBytes: error.maxBytes }, 413);
      }
      throw error;
    }
    const payload = parseSlackPayload(rawBody, c.req.header("content-type"));
    if (!payload) {
      await recordSlackRequestBodyRejected({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        reason: "invalid_json_body",
        contentLength: c.req.raw.headers.get("content-length")
      });
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!isSlackIngressPayload(payload)) {
      await recordSlackRequestBodyRejected({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        reason: "invalid_request_body",
        contentLength: c.req.raw.headers.get("content-length"),
        ...(isRecord(payload) && typeof payload.api_app_id === "string" ? { apiAppId: payload.api_app_id } : {})
      });
      return c.json({ error: "invalid_request_body" }, 400);
    }
    const resolvedSlackApp = resolveSlackApp({
      rawBody,
      signature,
      timestamp,
      ...(payload.api_app_id ? { apiAppId: payload.api_app_id } : {})
    });
    if ("error" in resolvedSlackApp) {
      await recordSlackSignatureFailure({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        reason: resolvedSlackApp.error,
        hasSignature: true,
        hasTimestamp: true,
        ...(payload.api_app_id ? { apiAppId: payload.api_app_id } : {})
      });
      return c.json({ error: resolvedSlackApp.error }, 401);
    }
    if (isSlackLinearBacklogQuery(payload)) {
      if (pendingLinearQueryEventIds.has(payload.event_id) || completedLinearQueryEventIds.has(payload.event_id)) {
        return c.json({ ok: true, ignored: "duplicate_linear_query" }, 200);
      }
      pendingLinearQueryEventIds.add(payload.event_id);
      const accepted = linearQueryExecutor.tryEnqueue(async () => {
        try {
          await processor.process(payload, resolvedSlackApp.slackApp, { signatureVerified: true });
          rememberCompletedLinearQuery(payload.event_id);
        } finally {
          pendingLinearQueryEventIds.delete(payload.event_id);
        }
      });
      if (!accepted) pendingLinearQueryEventIds.delete(payload.event_id);
      if (accepted) return c.json({ ok: true }, 200);

      recordSlackLinearQueryQueueFull({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        ...(payload.api_app_id ? { apiAppId: payload.api_app_id } : {}),
        maxLinearQueryConcurrency,
        maxLinearQueryOutstanding
      });
      return c.json({ error: "slack_linear_query_queue_full" }, 503);
    }

    const result = await processor.process(payload, resolvedSlackApp.slackApp, { signatureVerified: true });
    if (result.kind === "text") return c.text(result.body, result.status);
    return c.json(result.body, result.status);
  });

  return {
    app,
    close() {
      return linearQueryExecutor.closeAndDrain();
    }
  };
}

export function createSlackEventsApp(input: SlackEventsAppInput) {
  return createSlackEventsAppRuntime(input).app;
}

export function startSlackIngress(config: SlackEventsApiIngressConfig): SlackIngressHandle {
  const port = config.port ?? 3040;
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
  });
  const eventsApp = createSlackEventsAppRuntime({
    slackApps: [
      {
        signingSecret: config.signingSecret,
        agentId: config.agentId ?? "opentag",
        ...(config.appId ? { appId: config.appId } : {}),
        ...(config.callbackUri ? { callbackUri: config.callbackUri } : {})
      }
    ],
    ...(config.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: config.maxRequestBodyBytes } : {}),
    ...(config.maxLinearQueryConcurrency !== undefined
      ? { maxLinearQueryConcurrency: config.maxLinearQueryConcurrency }
      : {}),
    ...(config.maxLinearQueryOutstanding !== undefined
      ? { maxLinearQueryOutstanding: config.maxLinearQueryOutstanding }
      : {}),
    async recordControlPlaneEvent(event) {
      await dispatcherClient.recordControlPlaneEvent(event);
    },
    ...createSlackDispatcherEventProcessorInput(config)
  });
  const server = serve({
    fetch: eventsApp.app.fetch,
    port
  });

  return {
    url: `http://localhost:${port}`,
    server,
    async close() {
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await Promise.all([serverClosed, eventsApp.close()]);
    }
  };
}
