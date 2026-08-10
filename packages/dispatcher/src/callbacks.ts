import {
  addLarkMessageReaction,
  createLarkReplyClient,
  patchLarkMessageCard,
  type LarkCard,
  type LarkReplyClient,
  parseLarkThreadKey,
  replyLarkMessage,
  updateLarkTextMessage
} from "@opentag/lark";
import {
  createLinearAgentActivity,
  createLinearIssueCommentRecord,
  linearAgentSessionIdFromCallbackUri,
  linearIssueIdFromCallbackUri,
  linearParentCommentIdFromCallbackUri,
  updateLinearAgentSession,
  updateLinearComment,
  type FetchLike as LinearFetchLike
} from "@opentag/linear";
import {
  createSlackPostMessagePayload,
  createSlackReactionPayload,
  createSlackUpdateMessagePayload,
  parseSlackThreadKey,
  slackSourceReceiptReactionName
} from "@opentag/slack";
import {
  createTelegramEditMessageTextPayload,
  createTelegramSendMessagePayload,
  parseTelegramThreadKey,
  telegramMessageRichPayloadFromUnknown
} from "@opentag/telegram";
import {
  parseGitHubIssueCommentsTargetV1,
  sanitizeCredentialLikeValue,
  type GitHubIssueCommentsTargetV1
} from "@opentag/core";
import { createTeamsConnector, createTeamsTokenProvider, parseTeamsThreadKey } from "@opentag/teams";
import type { CallbackDeliveryResult, CallbackMessage, CallbackSink, SourceReceipt, SourceReceiptSink } from "./server.js";

export type FetchLike = typeof fetch;
export type LinearTokenProvider = () => Promise<string | undefined> | string | undefined;

type CallbackObservationInput = {
  producerId?: string;
};

export type CallbackProviderOutcomeUnknownClassification = {
  handled: true;
  outcome: "outcome_unknown";
  reasonCode: "provider_receipt_missing" | "provider_timeout";
  nextAction: "reconcile-provider";
};

/**
 * Preserves an explicitly ambiguous provider observation without pretending a
 * local adapter failure is provider evidence. The callback worker must catch
 * this error, add its authoritative producer id as `owner`, and journal the
 * unknown outcome; it must not feed the delivery into a generic retry path.
 */
export class CallbackProviderOutcomeUnknownError extends Error {
  readonly classification: CallbackProviderOutcomeUnknownClassification;

  constructor(reasonCode: CallbackProviderOutcomeUnknownClassification["reasonCode"]) {
    super(`Callback provider outcome is unknown: ${reasonCode}.`);
    this.name = "CallbackProviderOutcomeUnknownError";
    this.classification = {
      handled: true,
      outcome: "outcome_unknown",
      reasonCode,
      nextAction: "reconcile-provider"
    };
  }
}

/**
 * An adapter's process-local unknown-outcome latch has no clear operation.
 * Once the caller has durably reconciled the provider result, it must discard
 * that sink instance and build a new one. Supplying an external message id to
 * the existing sink never releases the latch.
 */
export const CALLBACK_OUTCOME_UNKNOWN_RELEASE_BOUNDARY =
  "sink-rebuild-after-durable-reconciliation" as const;

type CallbackOutcomeUnknownResult = Extract<
  CallbackDeliveryResult,
  { handled: true; outcome: "outcome_unknown" }
>;
type CallbackOutcomeUnknownObservation =
  | CallbackOutcomeUnknownResult
  | CallbackProviderOutcomeUnknownError;

const DEFAULT_SLACK_SOURCE_RECEIPT_TIMEOUT_MS = 5_000;
const DEFAULT_GITHUB_CALLBACK_DEADLINE_MS = 20_000;
const DEFAULT_LARK_RECEIVED_REACTION = "Typing";

export type CallbackSinkPreflightResult =
  | { handled: true }
  | {
      handled: false;
      reasonCode:
        | "provider_not_supported"
        | "provider_not_configured"
        | "callback_target_invalid"
        | "delivery_aborted";
    };

export type CallbackSinkWithPreflight = CallbackSink & {
  preflight(message: CallbackMessage): Promise<CallbackSinkPreflightResult>;
};

function callbackProducerId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ||
    sanitizeCredentialLikeValue(value) !== value
  ) {
    throw new Error("Callback provider observation producerId must be a credential-safe stable local producer id.");
  }
  return value;
}

function callbackOutcomeUnknown(input: {
  producerId: string | undefined;
  reasonCode: CallbackProviderOutcomeUnknownClassification["reasonCode"];
}): CallbackDeliveryResult {
  if (!input.producerId) {
    throw new CallbackProviderOutcomeUnknownError(input.reasonCode);
  }
  return {
    handled: true,
    outcome: "outcome_unknown",
    reasonCode: input.reasonCode,
    nextAction: "reconcile-provider",
    owner: input.producerId
  };
}

function callbackRejected(): CallbackDeliveryResult {
  return { handled: true, outcome: "rejected", reasonCode: "provider_rejected" };
}

function callbackHttpFailure(input: {
  response: Response;
  producerId: string | undefined;
}): CallbackDeliveryResult | undefined {
  if (input.response.ok) return undefined;
  if (input.response.status >= 400 && input.response.status < 500 && input.response.status !== 408) {
    return callbackRejected();
  }
  return callbackOutcomeUnknown({ producerId: input.producerId, reasonCode: "provider_timeout" });
}

function stableProviderReceiptId(value: unknown): string | undefined {
  // This is provider-native evidence (for example GitHub `123`), not the
  // governed Core callback ID. The durable callback worker must normalize it
  // deterministically (for example `comment_123`) and schema-parse before it
  // journals or projects a Core receipt.
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof normalized === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)
    && sanitizeCredentialLikeValue(normalized) === normalized
    ? normalized
    : undefined;
}

function stableProviderResourceUri(value: string | undefined): string | undefined {
  if (!value || sanitizeCredentialLikeValue(value) !== value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      !["discord:", "http:", "https:", "lark:", "linear:", "slack:", "teams:", "telegram:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      (parsed.hash !== "" && !/^#[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(parsed.hash))
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function callbackThrownFailure(input: {
  error: unknown;
  producerId: string | undefined;
  authoritativeRejection?: boolean;
}): CallbackDeliveryResult {
  if (input.error instanceof CallbackProviderOutcomeUnknownError) throw input.error;
  const message = input.error instanceof Error ? input.error.message : "";
  if (/missing (?:a )?(?:string )?(?:activity |message |comment )?id|returned no data|invalid json|unexpected end/i.test(message)) {
    return callbackOutcomeUnknown({ producerId: input.producerId, reasonCode: "provider_receipt_missing" });
  }
  if (/(?:failed(?::| with status)|status)\s+408\b/i.test(message)) {
    return callbackOutcomeUnknown({ producerId: input.producerId, reasonCode: "provider_timeout" });
  }
  if (
    input.authoritativeRejection &&
    (/(?:failed(?::| with status)|status)\s+4\d\d\b/i.test(message) || /success=false|permission denied|forbidden|unauthorized/i.test(message))
  ) {
    return callbackRejected();
  }
  return callbackOutcomeUnknown({ producerId: input.producerId, reasonCode: "provider_timeout" });
}

function replayCallbackOutcomeUnknown(
  observation: CallbackOutcomeUnknownObservation | undefined
): CallbackOutcomeUnknownResult | undefined {
  if (observation instanceof CallbackProviderOutcomeUnknownError) throw observation;
  return observation;
}

function trackCallbackOutcomeUnknown(
  delivery: Promise<CallbackDeliveryResult>,
  observations: Map<string, CallbackOutcomeUnknownObservation>,
  statusKey: string
): Promise<CallbackDeliveryResult> {
  return delivery.then(
    (result) => {
      if (result.handled && result.outcome === "outcome_unknown") {
        observations.set(statusKey, result);
      }
      return result;
    },
    (error: unknown) => {
      if (error instanceof CallbackProviderOutcomeUnknownError) {
        observations.set(statusKey, error);
      }
      throw error;
    }
  );
}

async function serializeCallbackDelivery(input: {
  deliveries: Map<string, Promise<CallbackDeliveryResult>>;
  deliver: () => Promise<CallbackDeliveryResult>;
  observations: Map<string, CallbackOutcomeUnknownObservation>;
  statusKey: string;
}): Promise<CallbackDeliveryResult> {
  const previous = input.deliveries.get(input.statusKey)
    ?? Promise.resolve<CallbackDeliveryResult>({ handled: false });
  const attempted = previous
    .catch(() => ({ handled: false } as const))
    .then(async () => {
      const latchedUnknown = replayCallbackOutcomeUnknown(
        input.observations.get(input.statusKey)
      );
      return latchedUnknown ?? await input.deliver();
    });
  const current = trackCallbackOutcomeUnknown(
    attempted,
    input.observations,
    input.statusKey
  );
  input.deliveries.set(input.statusKey, current);
  return await current.finally(() => {
    if (input.deliveries.get(input.statusKey) === current) {
      input.deliveries.delete(input.statusKey);
    }
  });
}

function isLarkClientCapabilityError(error: unknown): boolean {
  return error instanceof Error
    && /^Lark client does not support message\.(?:patch|reply|update)\.$/u.test(error.message);
}

function slackUpdateUriFrom(postMessageUri: string): string {
  return postMessageUri.replace(/\/chat\.postMessage$/, "/chat.update");
}

type GitHubCommentReceipt = {
  id?: unknown;
  url?: unknown;
  issue_url?: unknown;
};

function githubCommentId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function githubExternalCommentId(value: string | undefined): number | undefined {
  const match = /^comment_([1-9][0-9]*)$/u.exec(value ?? "");
  if (!match) return undefined;
  const commentId = Number(match[1]);
  return Number.isSafeInteger(commentId) ? commentId : undefined;
}

function githubIssueUri(target: GitHubIssueCommentsTargetV1): string {
  return `https://api.github.com/repos/${target.owner}/${target.repo}/issues/${target.issueNumber}`;
}

function githubCommentUri(target: GitHubIssueCommentsTargetV1, commentId: number): string {
  return `https://api.github.com/repos/${target.owner}/${target.repo}/issues/comments/${commentId}`;
}

function parseGitHubCommentReceipt(input: {
  body: GitHubCommentReceipt;
  target: GitHubIssueCommentsTargetV1;
  expectedCommentId?: number;
}): { commentId: number; providerReceiptId: string; providerResourceUri: string } {
  const commentId = githubCommentId(input.body.id);
  if (!commentId || (input.expectedCommentId !== undefined && commentId !== input.expectedCommentId)) {
    throw new CallbackProviderOutcomeUnknownError("provider_receipt_missing");
  }
  const providerResourceUri = githubCommentUri(input.target, commentId);
  if (
    input.body.url !== providerResourceUri ||
    input.body.issue_url !== githubIssueUri(input.target)
  ) {
    throw new CallbackProviderOutcomeUnknownError("provider_receipt_missing");
  }
  return {
    commentId,
    providerReceiptId: `comment_${commentId}`,
    providerResourceUri
  };
}

function gitlabNoteUriFrom(input: { notesUri: string; responseBody: { id?: number | string } | null | undefined }): string | undefined {
  if (input.responseBody && (typeof input.responseBody.id === "number" || typeof input.responseBody.id === "string")) {
    return `${input.notesUri.replace(/\/$/, "")}/${encodeURIComponent(String(input.responseBody.id))}`;
  }
  return undefined;
}

function slackBotTokenFor(input: {
  botToken?: string | undefined;
  botTokensByAgentId?: Record<string, string> | undefined;
  agentId?: string | undefined;
}): string | undefined {
  if (
    input.agentId &&
    input.botTokensByAgentId &&
    Object.hasOwn(input.botTokensByAgentId, input.agentId) &&
    typeof input.botTokensByAgentId[input.agentId] === "string"
  ) {
    return input.botTokensByAgentId[input.agentId];
  }
  return input.botToken;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function slackSourceMessageTarget(receipt: SourceReceipt): { channelId: string; messageTs: string } | null {
  if (receipt.provider !== "slack") return null;
  const channelId = metadataString(receipt.event.metadata, "channelId");
  const messageTs = metadataString(receipt.event.metadata, "messageTs");
  return channelId && messageTs ? { channelId, messageTs } : null;
}

function larkSourceMessageTarget(receipt: SourceReceipt): { messageId: string } | null {
  if (receipt.provider !== "lark" || receipt.state !== "received") return null;
  const threadKey = receipt.event.callback.threadKey;
  if (!threadKey) return null;
  return { messageId: parseLarkThreadKey(threadKey).messageId };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function resolveLinearToken(input: { token?: string; getToken?: LinearTokenProvider }): Promise<string | undefined> {
  const token = input.getToken ? await input.getToken() : input.token;
  const trimmed = token?.trim();
  return trimmed ? trimmed : undefined;
}

function linearAgentSessionPlanFor(message: CallbackMessage) {
  const completed = message.kind === "final";
  return [
    {
      content: "Accept the Linear agent session",
      status: "completed" as const
    },
    {
      content: "Run OpenTag on the paired local checkout",
      status: completed ? ("completed" as const) : ("inProgress" as const)
    },
    {
      content: "Report the result back to Linear",
      status: completed ? ("completed" as const) : ("pending" as const)
    }
  ];
}

async function fetchWithTimeout(input: {
  fetchImpl: FetchLike;
  uri: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    return await input.fetchImpl(input.uri, { ...input.init, signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) return null;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createGitHubCallbackSink(input: {
  token?: string;
  fetchImpl?: FetchLike;
  deadlineMs?: number;
  signal?: AbortSignal;
} & CallbackObservationInput): CallbackSinkWithPreflight {
  const fetchImpl = input.fetchImpl ?? fetch;
  callbackProducerId(input.producerId);
  const suppliedToken = input.token;
  const token = suppliedToken && suppliedToken.trim() === suppliedToken && suppliedToken.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(suppliedToken)
    ? suppliedToken
    : undefined;
  const deadlineMs = input.deadlineMs ?? DEFAULT_GITHUB_CALLBACK_DEADLINE_MS;
  const deadlineIsValid = Number.isSafeInteger(deadlineMs) && deadlineMs > 0;
  const commentIdByKey = new Map<string, number>();
  const deliveryByKey = new Map<string, Promise<CallbackDeliveryResult>>();
  const unknownByKey = new Map<string, CallbackOutcomeUnknownObservation>();

  const preflight = async (
    message: CallbackMessage
  ): Promise<CallbackSinkPreflightResult & { target?: GitHubIssueCommentsTargetV1 }> => {
    if (message.provider !== "github") {
      return { handled: false, reasonCode: "provider_not_supported" };
    }
    if (!token || !deadlineIsValid) {
      return { handled: false, reasonCode: "provider_not_configured" };
    }
    if (input.signal?.aborted) {
      return { handled: false, reasonCode: "delivery_aborted" };
    }
    if (
      message.externalMessageId !== undefined &&
      (!message.statusMessageKey || githubExternalCommentId(message.externalMessageId) === undefined)
    ) {
      return { handled: false, reasonCode: "callback_target_invalid" };
    }
    if (!message.threadKey) {
      return { handled: false, reasonCode: "callback_target_invalid" };
    }
    try {
      return {
        handled: true,
        target: await parseGitHubIssueCommentsTargetV1(message.uri, message.threadKey)
      };
    } catch {
      return { handled: false, reasonCode: "callback_target_invalid" };
    }
  };

  return {
    async preflight(message: CallbackMessage): Promise<CallbackSinkPreflightResult> {
      const result = await preflight(message);
      return result.handled ? { handled: true } : result;
    },
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult> {
      const ready = await preflight(message);
      if (!ready.handled || !ready.target) return { handled: false };
      const target = ready.target;

      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const previous = deliveryByKey.get(statusKey) ?? Promise.resolve<CallbackDeliveryResult>({ handled: false });
      const attempted = previous.catch(() => ({ handled: false } as const)).then(async (): Promise<CallbackDeliveryResult> => {
        const latchedUnknown = replayCallbackOutcomeUnknown(unknownByKey.get(statusKey));
        if (latchedUnknown) return latchedUnknown;
        const commentId = message.statusMessageKey && message.externalMessageId
          ? githubExternalCommentId(message.externalMessageId)
          : commentIdByKey.get(statusKey);
        const uri = commentId ? githubCommentUri(target, commentId) : target.canonicalUri;
        const controller = new AbortController();
        const abort = () => controller.abort();
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) {
          input.signal.removeEventListener("abort", abort);
          return { handled: false };
        }
        const timeout = setTimeout(abort, deadlineMs);
        let response: Response;
        try {
          response = await fetchImpl(uri, {
            method: commentId ? "PATCH" : "POST",
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "x-github-api-version": "2022-11-28"
            },
            body: JSON.stringify({ body: message.body }),
            signal: controller.signal
          });
        } catch {
          throw new CallbackProviderOutcomeUnknownError("provider_timeout");
        } finally {
          clearTimeout(timeout);
          input.signal?.removeEventListener("abort", abort);
        }
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && response.status !== 408) {
            return callbackRejected();
          }
          throw new CallbackProviderOutcomeUnknownError("provider_timeout");
        }

        let body: GitHubCommentReceipt;
        try {
          const parsed: unknown = await response.json();
          body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as GitHubCommentReceipt
            : {};
        } catch {
          throw new CallbackProviderOutcomeUnknownError("provider_receipt_missing");
        }
        const receipt = parseGitHubCommentReceipt({
          body,
          target,
          ...(commentId ? { expectedCommentId: commentId } : {})
        });
        commentIdByKey.set(statusKey, receipt.commentId);
        if (message.kind === "final") commentIdByKey.delete(statusKey);
        return {
          handled: true,
          outcome: "accepted",
          externalMessageId: receipt.providerReceiptId,
          providerReceiptId: receipt.providerReceiptId,
          providerResourceUri: receipt.providerResourceUri
        };
      });
      const current = trackCallbackOutcomeUnknown(attempted, unknownByKey, statusKey);
      deliveryByKey.set(statusKey, current);
      return await current.finally(() => {
        if (deliveryByKey.get(statusKey) === current) {
          deliveryByKey.delete(statusKey);
        }
      });
    }
  };
}

export function createGitLabCallbackSink(input: {
  token?: string;
  fetchImpl?: FetchLike;
} & CallbackObservationInput): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const producerId = callbackProducerId(input.producerId);
  const noteUriByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<CallbackDeliveryResult>>();
  const unknownByKey = new Map<string, CallbackOutcomeUnknownObservation>();

  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult> {
      if (message.provider !== "gitlab") return { handled: false };
      const token = input.token;
      if (!token) return { handled: false };

      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const previous = deliveryByKey.get(statusKey) ?? Promise.resolve<CallbackDeliveryResult>({ handled: false });
      const attempted = previous.catch(() => ({ handled: false } as const)).then(async (): Promise<CallbackDeliveryResult> => {
        const latchedUnknown = replayCallbackOutcomeUnknown(unknownByKey.get(statusKey));
        if (latchedUnknown) return latchedUnknown;
        const existingNoteUri = noteUriByKey.get(statusKey);
        let response: Response;
        try {
          response = await fetchImpl(existingNoteUri ?? message.uri, {
            method: existingNoteUri ? "PUT" : "POST",
            headers: {
              "PRIVATE-TOKEN": token,
              "content-type": "application/json"
            },
            body: JSON.stringify({ body: message.body })
          });
        } catch {
          return callbackOutcomeUnknown({ producerId, reasonCode: "provider_timeout" });
        }
        const failure = callbackHttpFailure({ response, producerId });
        if (failure) return failure;

        if (existingNoteUri) {
          const providerResourceUri = stableProviderResourceUri(existingNoteUri);
          const providerReceiptId = stableProviderReceiptId(existingNoteUri.split("/").at(-1));
          if (!providerResourceUri || !providerReceiptId) {
            return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
          }
          if (message.kind === "final") noteUriByKey.delete(statusKey);
          return {
            handled: true,
            outcome: "accepted",
            providerReceiptId,
            providerResourceUri
          };
        }

        let body: { id?: number | string } | null;
        try {
          const parsed: unknown = await response.json();
          body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as { id?: number | string }
            : null;
        } catch {
          return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
        }
        const providerReceiptId = stableProviderReceiptId(body?.id);
        const providerResourceUri = stableProviderResourceUri(
          gitlabNoteUriFrom({ notesUri: message.uri, responseBody: body })
        );
        if (!providerReceiptId || !providerResourceUri) {
          return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
        }
        noteUriByKey.set(statusKey, providerResourceUri);
        if (message.kind === "final") noteUriByKey.delete(statusKey);
        return {
          handled: true,
          outcome: "accepted",
          providerReceiptId,
          providerResourceUri
        };
      });
      const current = trackCallbackOutcomeUnknown(attempted, unknownByKey, statusKey);
      deliveryByKey.set(statusKey, current);
      return await current.finally(() => {
        if (deliveryByKey.get(statusKey) === current) {
          deliveryByKey.delete(statusKey);
        }
      });
    }
  };
}

export function createLinearCallbackSink(input: {
  token?: string;
  getToken?: LinearTokenProvider;
  graphqlUrl?: string;
  fetchImpl?: LinearFetchLike;
} & CallbackObservationInput): CallbackSink {
  const producerId = callbackProducerId(input.producerId);
  const commentIdByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<CallbackDeliveryResult>>();
  const unknownByKey = new Map<string, CallbackOutcomeUnknownObservation>();

  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult> {
      if (message.provider !== "linear") return { handled: false };
      const token = await resolveLinearToken(input);
      if (!token) return { handled: false };

      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      return await serializeCallbackDelivery({
        deliveries: deliveryByKey,
        observations: unknownByKey,
        statusKey,
        deliver: async () => {
          const agentSessionId = linearAgentSessionIdFromCallbackUri(message.uri);
          if (agentSessionId) {
            try {
              await updateLinearAgentSession({
                token,
                ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
                agentSessionId,
                plan: linearAgentSessionPlanFor(message),
                ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
              });
              const activityId = stableProviderReceiptId(
                await createLinearAgentActivity({
                  token,
                  ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
                  activity: {
                    agentSessionId,
                    type: message.kind === "final" ? "response" : "thought",
                    body: message.body,
                    ephemeral: message.kind === "progress"
                  },
                  ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
                })
              );
              const providerResourceUri = activityId
                ? stableProviderResourceUri(
                    `linear://agent-session/${encodeURIComponent(agentSessionId)}/activities/${encodeURIComponent(activityId)}`
                  )
                : undefined;
              if (!activityId || !providerResourceUri) {
                return callbackOutcomeUnknown({
                  producerId,
                  reasonCode: "provider_receipt_missing"
                });
              }
              return {
                handled: true,
                outcome: "accepted",
                externalMessageId: activityId,
                providerReceiptId: activityId,
                providerResourceUri
              };
            } catch (error) {
              return callbackThrownFailure({ error, producerId });
            }
          }

          const issueId = linearIssueIdFromCallbackUri(message.uri);
          if (!issueId) {
            throw new Error("deliver Linear callback failed: invalid callback URI.");
          }
          const existingCommentId = message.statusMessageKey
            ? message.externalMessageId ?? commentIdByKey.get(statusKey)
            : undefined;
          if (existingCommentId) {
            try {
              const updatedUri = await updateLinearComment({
                token,
                commentId: existingCommentId,
                body: message.body,
                ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
                ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
              });
              const providerReceiptId = stableProviderReceiptId(existingCommentId);
              const providerResourceUri = stableProviderResourceUri(
                updatedUri ?? `linear://comment/${existingCommentId}`
              );
              if (!providerReceiptId || !providerResourceUri) {
                return callbackOutcomeUnknown({
                  producerId,
                  reasonCode: "provider_receipt_missing"
                });
              }
              if (message.kind === "final") commentIdByKey.delete(statusKey);
              return {
                handled: true,
                outcome: "accepted",
                externalMessageId: providerReceiptId,
                providerReceiptId,
                providerResourceUri
              };
            } catch (error) {
              return callbackThrownFailure({
                error,
                producerId,
                authoritativeRejection: true
              });
            }
          }

          try {
            const parentId = linearParentCommentIdFromCallbackUri(message.uri);
            const comment = await createLinearIssueCommentRecord({
              token,
              issueId,
              body: message.body,
              ...(parentId ? { parentId } : {}),
              ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
              ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
            });
            const providerReceiptId = stableProviderReceiptId(comment.id);
            const providerResourceUri = stableProviderResourceUri(comment.url);
            if (!providerReceiptId || !providerResourceUri) {
              return callbackOutcomeUnknown({
                producerId,
                reasonCode: "provider_receipt_missing"
              });
            }
            if (message.statusMessageKey) {
              commentIdByKey.set(statusKey, providerReceiptId);
            }
            if (message.kind === "final") commentIdByKey.delete(statusKey);
            return {
              handled: true,
              outcome: "accepted",
              ...(message.statusMessageKey
                ? { externalMessageId: providerReceiptId }
                : {}),
              providerReceiptId,
              providerResourceUri
            };
          } catch (error) {
            return callbackThrownFailure({
              error,
              producerId,
              authoritativeRejection: true
            });
          }
        }
      });
    }
  };
}

// Discord rejects message content longer than 2000 characters with a 400 (code 50035),
// which would fail the whole delivery. Truncate so long summaries/diffs still post.
const DISCORD_MAX_CONTENT = 2000;

function truncateDiscordContent(body: string): string {
  return body.length > DISCORD_MAX_CONTENT ? `${body.slice(0, DISCORD_MAX_CONTENT - 3)}...` : body;
}

export function createDiscordCallbackSink(input: {
  token?: string;
  fetchImpl?: FetchLike;
} & CallbackObservationInput): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const producerId = callbackProducerId(input.producerId);
  const messageIdByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<CallbackDeliveryResult>>();
  const unknownByKey = new Map<string, CallbackOutcomeUnknownObservation>();

  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult> {
      if (message.provider !== "discord") return { handled: false };
      const token = input.token;
      if (!token) return { handled: false };

      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const previous = deliveryByKey.get(statusKey) ?? Promise.resolve<CallbackDeliveryResult>({ handled: false });
      // Swallow a prior failure so a transient error on one update does not permanently
      // break the edit chain for the subsequent progress/final messages of the same run.
      const attempted = previous.catch(() => ({ handled: false } as const)).then(async (): Promise<CallbackDeliveryResult> => {
        const latchedUnknown = replayCallbackOutcomeUnknown(unknownByKey.get(statusKey));
        if (latchedUnknown) return latchedUnknown;
        const existingMessageId = messageIdByKey.get(statusKey);
        // status_update edit chain: POST the first message, PATCH the same one after.
        // message.uri is the channel `/messages` endpoint, so the edit URL appends the id.
        let response: Response;
        try {
          response = await fetchImpl(existingMessageId ? `${message.uri.replace(/\/$/, "")}/${existingMessageId}` : message.uri, {
            method: existingMessageId ? "PATCH" : "POST",
            headers: {
              authorization: `Bot ${token}`,
              "content-type": "application/json"
            },
            // allowed_mentions suppresses @everyone/role/user pings that may appear
            // in executor output or user-provided text echoed into the summary.
            body: JSON.stringify({ content: truncateDiscordContent(message.body), allowed_mentions: { parse: [] } }),
            // Bound the request so a hung POST/PATCH can't stall every later status
            // update for this run (deliveries are serialized through the edit chain).
            signal: AbortSignal.timeout(10_000)
          });
        } catch {
          return callbackOutcomeUnknown({ producerId, reasonCode: "provider_timeout" });
        }
        const failure = callbackHttpFailure({ response, producerId });
        if (failure) return failure;

        let providerReceiptId = stableProviderReceiptId(existingMessageId);
        if (!providerReceiptId) {
          try {
            const body = (await response.json()) as { id?: unknown } | null;
            providerReceiptId = stableProviderReceiptId(body?.id);
          } catch {
            return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
          }
        }
        const providerResourceUri = providerReceiptId
          ? stableProviderResourceUri(`${message.uri.replace(/\/$/, "")}/${encodeURIComponent(providerReceiptId)}`)
          : undefined;
        if (!providerReceiptId || !providerResourceUri) {
          return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
        }
        if (!existingMessageId) messageIdByKey.set(statusKey, providerReceiptId);
        if (message.kind === "final") messageIdByKey.delete(statusKey);
        return {
          handled: true,
          outcome: "accepted",
          externalMessageId: providerReceiptId,
          providerReceiptId,
          providerResourceUri
        };
      });
      const current = trackCallbackOutcomeUnknown(attempted, unknownByKey, statusKey);
      deliveryByKey.set(statusKey, current);
      return await current.finally(() => {
        if (deliveryByKey.get(statusKey) === current) {
          deliveryByKey.delete(statusKey);
        }
      });
    }
  };
}

export function createTeamsCallbackSink(input: {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  fetchImpl?: FetchLike;
} & CallbackObservationInput): CallbackSink {
  // Reject partial credentials so a misconfigured sink fails at startup, not silently.
  if (Boolean(input.appId) !== Boolean(input.appPassword)) {
    throw new Error("Teams callback sink requires both appId and appPassword (or neither).");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const producerId = callbackProducerId(input.producerId);
  const tokenProvider =
    input.appId && input.appPassword
      ? createTeamsTokenProvider({
          appId: input.appId,
          appPassword: input.appPassword,
          ...(input.tenantId ? { tenantId: input.tenantId } : {}),
          fetchImpl
        })
      : undefined;
  const activityIdByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<CallbackDeliveryResult>>();
  const unknownByKey = new Map<string, CallbackOutcomeUnknownObservation>();

  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult> {
      if (message.provider !== "teams") return { handled: false };
      if (!tokenProvider) return { handled: false };
      if (!message.threadKey) {
        throw new Error("Teams callback message is missing threadKey.");
      }

      const { serviceUrl, conversationId } = parseTeamsThreadKey(message.threadKey);
      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const previous = deliveryByKey.get(statusKey) ?? Promise.resolve<CallbackDeliveryResult>({ handled: false });
      // Swallow a prior failure so a transient error on one update does not permanently
      // break the edit chain for the subsequent progress/final messages of the same run.
      const attempted = previous.catch(() => ({ handled: false } as const)).then(async (): Promise<CallbackDeliveryResult> => {
        const latchedUnknown = replayCallbackOutcomeUnknown(unknownByKey.get(statusKey));
        if (latchedUnknown) return latchedUnknown;
        let providerIoBegan = false;
        const connector = createTeamsConnector({
          getToken: () => tokenProvider.getToken(),
          fetchImpl: async (url, init) => {
            if (String(url).includes("/v3/conversations/")) providerIoBegan = true;
            return fetchImpl(url, init);
          }
        });
        try {
          const existingActivityId = activityIdByKey.get(statusKey);
          // status_update edit chain: POST the first message, PUT (edit) the same one after.
          if (existingActivityId) {
            await connector.updateMessage({ serviceUrl, conversationId, activityId: existingActivityId, text: message.body });
            const providerReceiptId = stableProviderReceiptId(existingActivityId);
            const providerResourceUri = providerReceiptId
              ? stableProviderResourceUri(
                  `teams://conversation/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(providerReceiptId)}`
                )
              : undefined;
            if (!providerReceiptId || !providerResourceUri) {
              return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
            }
            if (message.kind === "final") activityIdByKey.delete(statusKey);
            return {
              handled: true,
              outcome: "accepted",
              externalMessageId: providerReceiptId,
              providerReceiptId,
              providerResourceUri
            };
          } else {
            const { activityId } = await connector.postMessage({ serviceUrl, conversationId, text: message.body });
            const providerReceiptId = stableProviderReceiptId(activityId);
            const providerResourceUri = providerReceiptId
              ? stableProviderResourceUri(
                  `teams://conversation/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(providerReceiptId)}`
                )
              : undefined;
            if (!providerReceiptId || !providerResourceUri) {
              return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
            }
            activityIdByKey.set(statusKey, providerReceiptId);
            if (message.kind === "final") activityIdByKey.delete(statusKey);
            return {
              handled: true,
              outcome: "accepted",
              externalMessageId: providerReceiptId,
              providerReceiptId,
              providerResourceUri
            };
          }
        } catch (error) {
          if (!providerIoBegan) throw error;
          return callbackThrownFailure({ error, producerId, authoritativeRejection: true });
        }
      });
      const current = trackCallbackOutcomeUnknown(attempted, unknownByKey, statusKey);
      deliveryByKey.set(statusKey, current);
      return await current.finally(() => {
        if (deliveryByKey.get(statusKey) === current) {
          deliveryByKey.delete(statusKey);
        }
      });
    }
  };
}

export function createSlackCallbackSink(input: {
  botToken?: string;
  botTokensByAgentId?: Record<string, string>;
  fetchImpl?: FetchLike;
} & CallbackObservationInput): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const producerId = callbackProducerId(input.producerId);
  const statusMessageTsByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<CallbackDeliveryResult>>();
  const unknownByKey = new Map<string, CallbackOutcomeUnknownObservation>();

  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult> {
      message = sanitizeCredentialLikeValue(message);
      if (message.provider !== "slack") return { handled: false };
      const botToken = slackBotTokenFor({
        botToken: input.botToken,
        botTokensByAgentId: input.botTokensByAgentId,
        agentId: message.agentId
      });
      if (!botToken) return { handled: false };

      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      return await serializeCallbackDelivery({
        deliveries: deliveryByKey,
        observations: unknownByKey,
        statusKey,
        deliver: async () => {
          const thread = parseSlackThreadKey(message.threadKey ?? "");
          const existingStatusTs = message.externalMessageId
            ?? (message.statusMessageKey ? statusMessageTsByKey.get(message.statusMessageKey) : undefined);
          let response: Response;
          try {
            response = await fetchImpl(existingStatusTs ? slackUpdateUriFrom(message.uri) : message.uri, {
              method: "POST",
              headers: {
                authorization: `Bearer ${botToken}`,
                "content-type": "application/json"
              },
              body: JSON.stringify(
                existingStatusTs
                  ? createSlackUpdateMessagePayload({
                      channelId: thread.channelId,
                      text: message.body,
                      textFormat: "mrkdwn",
                      messageTs: existingStatusTs,
                      ...(message.blocks?.length ? { blocks: message.blocks } : {})
                    })
                  : createSlackPostMessagePayload({
                      channelId: thread.channelId,
                      text: message.body,
                      textFormat: "mrkdwn",
                      threadTs: thread.threadTs,
                      ...(message.blocks?.length ? { blocks: message.blocks } : {})
                    })
              )
            });
          } catch {
            return callbackOutcomeUnknown({ producerId, reasonCode: "provider_timeout" });
          }
          const failure = callbackHttpFailure({ response, producerId });
          if (failure) return failure;

          let body: { ok?: boolean; ts?: string };
          try {
            const parsed: unknown = await response.json();
            body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed as { ok?: boolean; ts?: string }
              : {};
          } catch {
            return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
          }
          if (body.ok === false) return callbackRejected();

          const providerReceiptId = stableProviderReceiptId(existingStatusTs ?? body.ts);
          const providerResourceUri = providerReceiptId
            ? stableProviderResourceUri(
                `slack://channel/${encodeURIComponent(thread.channelId)}/message/${encodeURIComponent(providerReceiptId)}`
              )
            : undefined;
          if (!providerReceiptId || !providerResourceUri) {
            return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
          }
          if (message.statusMessageKey && !existingStatusTs) {
            statusMessageTsByKey.set(message.statusMessageKey, providerReceiptId);
          }
          if (message.kind === "final") {
            for (const key of statusMessageTsByKey.keys()) {
              if (key.startsWith(`${message.runId}:`)) {
                statusMessageTsByKey.delete(key);
              }
            }
          }
          return {
            handled: true,
            outcome: "accepted",
            externalMessageId: providerReceiptId,
            providerReceiptId,
            providerResourceUri
          };
        }
      });
    }
  };
}

export function createSlackSourceReceiptSink(input: {
  botToken?: string;
  botTokensByAgentId?: Record<string, string>;
  fetchImpl?: FetchLike;
  reactionsAddUri?: string;
  timeoutMs?: number;
}): SourceReceiptSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const reactionsAddUri = input.reactionsAddUri ?? "https://slack.com/api/reactions.add";
  const timeoutMs = input.timeoutMs ?? DEFAULT_SLACK_SOURCE_RECEIPT_TIMEOUT_MS;

  return {
    async deliver(receipt: SourceReceipt) {
      const target = slackSourceMessageTarget(receipt);
      if (!target) return { delivered: false };

      const botToken = slackBotTokenFor({
        botToken: input.botToken,
        botTokensByAgentId: input.botTokensByAgentId,
        agentId: receipt.agentId
      });
      if (!botToken) return { delivered: false };

      const response = await fetchWithTimeout({
        fetchImpl,
        uri: reactionsAddUri,
        timeoutMs,
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${botToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createSlackReactionPayload({
              channelId: target.channelId,
              messageTs: target.messageTs,
              name: slackSourceReceiptReactionName(receipt.state)
            })
          )
        }
      });
      if (!response) return { delivered: false };

      if (!response.ok) {
        throw new Error(`deliver Slack source receipt failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } | null;
      if (body?.ok === false && body.error !== "already_reacted") {
        throw new Error(`deliver Slack source receipt failed: ${body?.error ?? "unknown_error"}`);
      }
      return { delivered: true };
    }
  };
}

export function createLarkSourceReceiptSink(input: {
  appId?: string;
  appSecret?: string;
  domain?: "lark" | "feishu";
  client?: LarkReplyClient;
  receivedEmojiType?: string;
}): SourceReceiptSink {
  if (!input.client && Boolean(input.appId) !== Boolean(input.appSecret)) {
    throw new Error("Lark source receipt sink requires both appId and appSecret (or neither).");
  }

  const client: LarkReplyClient | undefined =
    input.client ??
    (input.appId && input.appSecret
      ? createLarkReplyClient({ appId: input.appId, appSecret: input.appSecret, ...(input.domain ? { domain: input.domain } : {}) })
      : undefined);
  const receivedEmojiType = input.receivedEmojiType ?? DEFAULT_LARK_RECEIVED_REACTION;

  return {
    async deliver(receipt: SourceReceipt) {
      const target = larkSourceMessageTarget(receipt);
      if (!target || !client) return { delivered: false };
      await addLarkMessageReaction(client, {
        messageId: target.messageId,
        emojiType: receivedEmojiType
      });
      return { delivered: true };
    }
  };
}

export function createLarkCallbackSink(input: {
  appId?: string;
  appSecret?: string;
  domain?: "lark" | "feishu";
  client?: LarkReplyClient;
} & CallbackObservationInput): CallbackSink {
  // Reject partial credentials so a misconfigured sink fails at startup, not silently.
  if (!input.client && Boolean(input.appId) !== Boolean(input.appSecret)) {
    throw new Error("Lark callback sink requires both appId and appSecret (or neither).");
  }

  const client: LarkReplyClient | undefined =
    input.client ??
    (input.appId && input.appSecret
      ? createLarkReplyClient({ appId: input.appId, appSecret: input.appSecret, ...(input.domain ? { domain: input.domain } : {}) })
      : undefined);
  const producerId = callbackProducerId(input.producerId);
  const messageIdByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<CallbackDeliveryResult>>();
  const unknownByKey = new Map<string, CallbackOutcomeUnknownObservation>();

  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult> {
      message = sanitizeCredentialLikeValue(message);
      if (message.provider !== "lark") return { handled: false };
      // A lark run was accepted, so a missing client/threadKey is a real failure, not a silent success.
      if (!client) {
        throw new Error("Lark callback sink received a lark message but has no client configured (missing appId/appSecret).");
      }
      const threadKey = message.threadKey;
      if (!threadKey) {
        throw new Error("Lark callback message is missing threadKey.");
      }

      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      return await serializeCallbackDelivery({
        deliveries: deliveryByKey,
        observations: unknownByKey,
        statusKey,
        deliver: async () => {
          const existingMessageId = message.externalMessageId
            ?? (message.statusMessageKey ? messageIdByKey.get(statusKey) : undefined);
          if (existingMessageId) {
            try {
              if (message.rich?.provider === "lark") {
                await patchLarkMessageCard(client, {
                  messageId: existingMessageId,
                  card: message.rich.payload as LarkCard
                });
              } else {
                await updateLarkTextMessage(client, {
                  messageId: existingMessageId,
                  text: message.body
                });
              }
            } catch (error) {
              if (isLarkClientCapabilityError(error)) throw error;
              return callbackThrownFailure({
                error,
                producerId,
                authoritativeRejection: true
              });
            }
            const providerReceiptId = stableProviderReceiptId(existingMessageId);
            const providerResourceUri = providerReceiptId
              ? stableProviderResourceUri(
                  `lark://message/${encodeURIComponent(providerReceiptId)}`
                )
              : undefined;
            if (!providerReceiptId || !providerResourceUri) {
              return callbackOutcomeUnknown({
                producerId,
                reasonCode: "provider_receipt_missing"
              });
            }
            if (message.kind === "final") messageIdByKey.delete(statusKey);
            return {
              handled: true,
              outcome: "accepted",
              externalMessageId: providerReceiptId,
              providerReceiptId,
              providerResourceUri
            };
          }

          const { messageId } = parseLarkThreadKey(threadKey);
          try {
            const reply = await replyLarkMessage(client, {
              messageId,
              text: message.body,
              ...(message.rich?.provider === "lark"
                ? { card: message.rich.payload as LarkCard }
                : {})
            });
            const providerReceiptId = stableProviderReceiptId(reply.messageId);
            const providerResourceUri = providerReceiptId
              ? stableProviderResourceUri(
                  `lark://message/${encodeURIComponent(providerReceiptId)}`
                )
              : undefined;
            if (!providerReceiptId || !providerResourceUri) {
              return callbackOutcomeUnknown({
                producerId,
                reasonCode: "provider_receipt_missing"
              });
            }
            if (message.statusMessageKey) {
              messageIdByKey.set(statusKey, providerReceiptId);
            }
            if (message.kind === "final") messageIdByKey.delete(statusKey);
            return {
              handled: true,
              outcome: "accepted",
              externalMessageId: providerReceiptId,
              providerReceiptId,
              providerResourceUri
            };
          } catch (error) {
            if (isLarkClientCapabilityError(error)) throw error;
            return callbackThrownFailure({
              error,
              producerId,
              authoritativeRejection: true
            });
          }
        }
      });
    }
  };
}

export function createTelegramCallbackSink(input: {
  botToken?: string;
  botTokensByAgentId?: Record<string, string>;
  fetchImpl?: FetchLike;
} & CallbackObservationInput): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const producerId = callbackProducerId(input.producerId);
  const messageIdByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<CallbackDeliveryResult>>();
  const unknownByKey = new Map<string, CallbackOutcomeUnknownObservation>();

  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult> {
      if (message.provider !== "telegram") return { handled: false };
      const botToken = slackBotTokenFor({
        botToken: input.botToken,
        botTokensByAgentId: input.botTokensByAgentId,
        agentId: message.agentId
      });
      if (!botToken) return { handled: false };

      const thread = parseTelegramThreadKey(message.threadKey ?? "");
      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      return await serializeCallbackDelivery({
        deliveries: deliveryByKey,
        observations: unknownByKey,
        statusKey,
        deliver: async () => {
          const rich =
            message.rich?.provider === "telegram" ? telegramMessageRichPayloadFromUnknown(message.rich.payload) ?? undefined : undefined;
          const existingMessageId = message.externalMessageId ?? messageIdByKey.get(statusKey);
          const parsedExistingMessageId = existingMessageId ? Number(existingMessageId) : undefined;
          const canEdit = parsedExistingMessageId !== undefined && Number.isInteger(parsedExistingMessageId) && parsedExistingMessageId > 0;

          let response: Response;
          try {
            response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${canEdit ? "editMessageText" : "sendMessage"}`, {
              method: "POST",
              headers: {
                "content-type": "application/json"
              },
              body: JSON.stringify(
                canEdit
                  ? createTelegramEditMessageTextPayload({
                      chatId: thread.chatId,
                      messageId: parsedExistingMessageId,
                      text: message.body,
                      ...(rich ? { rich } : {})
                    })
                  : createTelegramSendMessagePayload({
                      chatId: thread.chatId,
                      text: message.body,
                      ...(rich ? { rich } : {}),
                      ...(thread.messageThreadId ? { messageThreadId: thread.messageThreadId } : {})
                    })
              )
            });
          } catch {
            return callbackOutcomeUnknown({ producerId, reasonCode: "provider_timeout" });
          }
          const failure = callbackHttpFailure({ response, producerId });
          if (failure) return failure;

          let body: { ok?: boolean; result?: { message_id?: unknown } };
          try {
            const parsed: unknown = await response.json();
            body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed as { ok?: boolean; result?: { message_id?: unknown } }
              : {};
          } catch {
            return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
          }
          if (body.ok === false) return callbackRejected();

          if (canEdit) {
            const providerReceiptId = stableProviderReceiptId(String(parsedExistingMessageId));
            const providerResourceUri = providerReceiptId
              ? stableProviderResourceUri(
                  `telegram://chat/${encodeURIComponent(thread.chatId)}/message/${encodeURIComponent(providerReceiptId)}`
                )
              : undefined;
            if (!providerReceiptId || !providerResourceUri) {
              return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
            }
            if (message.kind === "final") {
              messageIdByKey.delete(statusKey);
            }
            return {
              handled: true,
              outcome: "accepted",
              externalMessageId: providerReceiptId,
              providerReceiptId,
              providerResourceUri
            };
          }
          const deliveredMessageId = stableProviderReceiptId(body.result?.message_id);
          const providerResourceUri = deliveredMessageId
            ? stableProviderResourceUri(
                `telegram://chat/${encodeURIComponent(thread.chatId)}/message/${encodeURIComponent(deliveredMessageId)}`
              )
            : undefined;
          if (!deliveredMessageId || !providerResourceUri) {
            return callbackOutcomeUnknown({ producerId, reasonCode: "provider_receipt_missing" });
          }
          if (deliveredMessageId && message.statusMessageKey) {
            messageIdByKey.set(statusKey, deliveredMessageId);
          }
          if (message.kind === "final") {
            messageIdByKey.delete(statusKey);
          }
          return {
            handled: true,
            outcome: "accepted",
            externalMessageId: deliveredMessageId,
            providerReceiptId: deliveredMessageId,
            providerResourceUri
          };
        }
      });
    }
  };
}

function callbackSinkWithPreflight(sink: CallbackSink): sink is CallbackSinkWithPreflight {
  return "preflight" in sink && typeof sink.preflight === "function";
}

export function createCompositeCallbackSink(sinks: CallbackSink[]): CallbackSinkWithPreflight {
  return {
    async preflight(message: CallbackMessage): Promise<CallbackSinkPreflightResult> {
      let localFailure: CallbackSinkPreflightResult | undefined;
      for (const sink of sinks) {
        if (!callbackSinkWithPreflight(sink)) continue;
        const result = await sink.preflight(message);
        if (result.handled) return result;
        if (result.reasonCode !== "provider_not_supported" && localFailure === undefined) {
          localFailure = result;
        }
      }
      return localFailure ?? { handled: false, reasonCode: "provider_not_supported" };
    },
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult> {
      const failures: unknown[] = [];
      for (const sink of sinks) {
        try {
          const result = await sink.deliver(message);
          if (!result.handled) continue;
          return result;
        } catch (error) {
          if (error instanceof CallbackProviderOutcomeUnknownError) throw error;
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Composite callback delivery failed for every sink.");
      }
      throw new Error(`No callback sink handled provider ${message.provider}.`);
    }
  };
}

export function createCompositeSourceReceiptSink(sinks: SourceReceiptSink[]): SourceReceiptSink {
  return {
    async deliver(receipt: SourceReceipt) {
      let delivered = false;
      const failures: unknown[] = [];
      for (const sink of sinks) {
        try {
          const result = await sink.deliver(receipt);
          delivered ||= result.delivered;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!delivered && failures.length > 0) {
        throw new AggregateError(failures, "Composite source receipt delivery failed for every sink.");
      }
      return { delivered };
    }
  };
}
