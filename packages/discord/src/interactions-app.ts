import { createHash } from "node:crypto";
import { parseThreadActionCommand, readRequestTextWithLimit, RequestBodyTooLargeError, type OpenTagEvent } from "@opentag/core";
import { Hono } from "hono";
import { encodeDiscordThreadKey, normalizeDiscordInteraction, type DiscordChannelBinding } from "./normalize.js";
import { verifyDiscordSignature } from "./signature.js";

/** `submitThreadAction` payload for `apply N` / `approve N` bodies. Mirrors the
 * GitHub / GitLab / Slack shape so one dispatcher consumer handles all providers. */
export type DiscordThreadActionInput = {
  /** Idempotency key; includes the body hash so redeliveries collapse to one id. */
  id: string;
  rawText: string;
  actor: {
    provider: "discord";
    providerUserId: string;
    handle: string;
  };
  callback: {
    provider: "discord";
    uri: string;
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

export type DiscordInteractionsAppInput = {
  /** Discord application Ed25519 public key (hex), from the Developer Portal. */
  publicKey: string;
  webhookPath?: string;
  callbackBaseUrl?: string;
  /** Returns `null` when the channel is not bound (handler then declines to run). */
  resolveChannelBinding(input: { applicationId: string; channelId: string }): Promise<DiscordChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: DiscordThreadActionInput): Promise<unknown>;
  /** Posts a plain notice to a channel via the bot token. Used for outcomes that
   * are only known after the interaction was already acknowledged (unbound
   * channel, failed run/action submission). */
  notifyChannel?(input: { channelId: string; content: string }): Promise<void>;
  /** Called when deferred work (binding/run/action) fails after the interaction
   * was acknowledged. Defaults to console.error so failures stay visible. */
  onBackgroundError?(error: unknown): void;
  now(): string;
};

const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const RESPONSE_TYPE_PONG = 1;
const RESPONSE_TYPE_CHANNEL_MESSAGE = 4;

// Defence-in-depth cap before the body reaches the JSON parser (matches GitLab ingress).
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
// Suppress @everyone/role/user pings in anything we echo back to the channel.
const NO_MENTIONS = { parse: [] as string[] };

function parseJsonPayload(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

type ExtractedInteraction = {
  interactionId: string;
  applicationId: string;
  channelId: string;
  guildId?: string;
  userId: string;
  username?: string;
  prompt: string;
  executor?: string;
};

function optionValue(options: unknown, name: string): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const option of options) {
    if (option && typeof option === "object" && (option as { name?: unknown }).name === name) {
      const value = (option as { value?: unknown }).value;
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

/** Extract required fields from an APPLICATION_COMMAND payload; `null` if any is
 * missing (a partial payload must not synthesize an event with `undefined` ids).
 * The invoking user is under `member.user` in a guild but `user` in a DM. */
function extractInteraction(payload: Record<string, unknown>): ExtractedInteraction | null {
  const interactionId = typeof payload.id === "string" ? payload.id : undefined;
  const applicationId = typeof payload.application_id === "string" ? payload.application_id : undefined;
  const channelId = typeof payload.channel_id === "string" ? payload.channel_id : undefined;
  const guildId = typeof payload.guild_id === "string" ? payload.guild_id : undefined;

  const member = payload.member as { user?: { id?: unknown; username?: unknown } } | undefined;
  const directUser = payload.user as { id?: unknown; username?: unknown } | undefined;
  const user = member?.user ?? directUser;
  const userId = typeof user?.id === "string" ? user.id : undefined;
  const username = typeof user?.username === "string" ? user.username : undefined;

  const data = payload.data as { options?: unknown } | undefined;
  const prompt = optionValue(data?.options, "prompt");
  const executor = optionValue(data?.options, "executor");

  if (!interactionId || !applicationId || !channelId || !userId || !prompt) return null;

  return {
    interactionId,
    applicationId,
    channelId,
    ...(guildId ? { guildId } : {}),
    userId,
    ...(username ? { username } : {}),
    prompt,
    ...(executor ? { executor } : {})
  };
}

/** `approval_discord_<interactionId>_<sha256(rawBody)[:12]>` — same shape as the
 * GitLab action id; body hash makes redeliveries collapse to one id. */
function actionId(interactionId: string, rawBody: string): string {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex").slice(0, 12);
  return `approval_discord_${interactionId}_${bodyHash}`;
}

/**
 * Hono app handling Discord interaction webhooks (streamed size limit →
 * signature → PING → APPLICATION_COMMAND). The command handler acknowledges
 * within Discord's 3-second deadline with a `type 4` message and performs
 * binding resolution / run creation / thread-action submission as deferred
 * work (floating promise — fine in the long-lived dispatcher process);
 * progress/final are delivered later by the provider adapter over the bot-token
 * REST API (never the 15-minute interaction token). Mount via `app.route` into
 * the dispatcher, or serve standalone.
 */
export function createDiscordInteractionsApp(input: DiscordInteractionsAppInput) {
  const app = new Hono();
  const webhookPath = input.webhookPath ?? "/discord/interactions";
  if (!webhookPath.startsWith("/")) {
    throw new Error("Discord interactions path must start with /.");
  }
  const reportBackgroundError =
    input.onBackgroundError ??
    ((error: unknown) => {
      console.error("Discord interaction background task failed:", error);
    });
  const safelyReportBackgroundError = (error: unknown) => {
    try {
      reportBackgroundError(error);
    } catch (reportError) {
      console.error("Discord interaction background error reporter failed:", reportError);
    }
  };

  app.post(webhookPath, async (c) => {
    const contentLengthHeader = c.req.header("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared >= MAX_WEBHOOK_BODY_BYTES) {
        return c.json({ error: "payload_too_large" }, 413);
      }
    }

    const signature = c.req.header("x-signature-ed25519");
    const timestamp = c.req.header("x-signature-timestamp");
    if (!signature || !timestamp) {
      return c.json({ error: "missing_signature" }, 401);
    }
    // The limit is enforced while streaming, so a spoofed/absent content-length
    // header cannot force a full oversized buffer before rejection.
    let rawBody: string;
    try {
      rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: MAX_WEBHOOK_BODY_BYTES });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return c.json({ error: "payload_too_large" }, 413);
      }
      throw error;
    }
    if (!verifyDiscordSignature({ publicKey: input.publicKey, signature, timestamp, rawBody })) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    const payload = parseJsonPayload(rawBody);
    if (!payload || typeof payload !== "object") {
      return c.json({ error: "invalid_json" }, 400);
    }
    const body = payload as Record<string, unknown>;

    if (body.type === INTERACTION_TYPE_PING) {
      return c.json({ type: RESPONSE_TYPE_PONG });
    }

    if (body.type === INTERACTION_TYPE_APPLICATION_COMMAND) {
      const interaction = extractInteraction(body);
      if (!interaction) {
        return c.json({ error: "invalid_payload" }, 422);
      }
      if (!interaction.prompt.trim()) {
        return c.json({
          type: RESPONSE_TYPE_CHANNEL_MESSAGE,
          data: { content: "Please include a prompt after /opentag.", allowed_mentions: NO_MENTIONS }
        });
      }

      // Deferred work runs after the type-4 ACK below so Discord's 3-second
      // deadline never depends on dispatcher/DB latency. Failures are reported
      // and surfaced to the channel as a bot-token notice instead of a 500.
      const runDeferred = (work: () => Promise<void>, failureNotice: string) => {
        void Promise.resolve()
          .then(work)
          .catch((error) => {
            safelyReportBackgroundError(error);
            input
              .notifyChannel?.({ channelId: interaction.channelId, content: failureNotice })
              .catch(safelyReportBackgroundError);
          });
      };

      // apply/approve N → submitThreadAction, no run (mirrors the GitLab ingress).
      if (parseThreadActionCommand(interaction.prompt)) {
        const submitThreadAction = input.submitThreadAction;
        if (!submitThreadAction) {
          // Never fall through to createRun: "apply N" is not a valid run prompt.
          return c.json({
            type: RESPONSE_TYPE_CHANNEL_MESSAGE,
            data: { content: "Thread actions are not supported on this dispatcher.", allowed_mentions: NO_MENTIONS }
          });
        }
        const action: DiscordThreadActionInput = {
          id: actionId(interaction.interactionId, rawBody),
          rawText: interaction.prompt,
          actor: {
            provider: "discord",
            providerUserId: interaction.userId,
            handle: interaction.username ?? interaction.userId
          },
          callback: {
            provider: "discord",
            uri: `${input.callbackBaseUrl ?? "https://discord.com/api/v10"}/channels/${interaction.channelId}/messages`,
            threadKey: encodeDiscordThreadKey({
              ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
              channelId: interaction.channelId,
              anchorId: interaction.interactionId
            })
          },
          metadata: {
            repoProvider: "discord",
            applicationId: interaction.applicationId,
            channelId: interaction.channelId,
            ...(interaction.guildId ? { guildId: interaction.guildId } : {})
          }
        };
        runDeferred(async () => {
          await submitThreadAction(action);
        }, "Sorry, that action couldn't be processed. Please try again.");
        return c.json({ type: RESPONSE_TYPE_CHANNEL_MESSAGE, data: { content: "Received.", allowed_mentions: NO_MENTIONS } });
      }

      // The run id is not included in the ACK — the dispatcher's acknowledgement
      // presentation carries it after durable enqueue.
      runDeferred(async () => {
        const binding = await input.resolveChannelBinding({
          applicationId: interaction.applicationId,
          channelId: interaction.channelId
        });
        if (!binding) {
          await input.notifyChannel?.({
            channelId: interaction.channelId,
            content: "This channel is not bound to a repository. Bind it before using /opentag."
          });
          return;
        }
        const event = normalizeDiscordInteraction({
          interactionId: interaction.interactionId,
          applicationId: interaction.applicationId,
          channelId: interaction.channelId,
          ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
          userId: interaction.userId,
          ...(interaction.username ? { username: interaction.username } : {}),
          prompt: interaction.prompt,
          ...(interaction.executor ? { executor: interaction.executor } : {}),
          binding,
          ...(input.callbackBaseUrl ? { callbackBaseUrl: input.callbackBaseUrl } : {}),
          receivedAt: input.now()
        });
        if (event) {
          await input.createRun(event);
        }
      }, "Sorry, OpenTag couldn't start this run. Please try again.");
      return c.json({
        type: RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: { content: "Received. OpenTag is working.", allowed_mentions: NO_MENTIONS }
      });
    }

    return c.json({ type: RESPONSE_TYPE_CHANNEL_MESSAGE, data: { content: "Unsupported interaction.", allowed_mentions: NO_MENTIONS } });
  });

  return app;
}
