import type { DispatcherDeliveryPresentation } from "@opentag/dispatcher";
import {
  createLarkReplyClient,
  parseLarkThreadKey,
  patchLarkMessageCard,
  replyLarkMessage,
  updateLarkTextMessage,
  type LarkCard,
  type LarkReplyClient
} from "@opentag/lark";

type DeliveryResult =
  | { outcome: "queued"; sideEffectIntentId: string }
  | { outcome: "activation_blocked" };

type LarkDeliveryProducer = {
  enqueue(presentation: DispatcherDeliveryPresentation): Promise<DeliveryResult>;
};

function larkPresentation(input: DispatcherDeliveryPresentation): {
  threadKey?: string;
  body: string;
  card?: LarkCard;
  statusMessageKey?: string;
  idempotencyKey?: string;
} | null {
  const provider = input.kind === "source_thread_control" ? input.request.callback.provider : input.provider;
  if (provider !== "lark" || input.kind === "source_receipt") return null;

  if (input.kind === "source_thread_control") {
    const rich = input.rich?.provider === "lark" ? input.rich.payload as LarkCard : undefined;
    return {
      ...(input.request.callback.threadKey ? { threadKey: input.request.callback.threadKey } : {}),
      body: input.body ?? "",
      ...(rich ? { card: rich } : {})
    };
  }

  const rich = input.rich?.provider === "lark" ? input.rich.payload as LarkCard : undefined;
  return {
    ...(input.threadKey ? { threadKey: input.threadKey } : {}),
    body: input.body ?? "",
    ...(rich ? { card: rich } : {}),
    ...(input.statusMessageKey ? { statusMessageKey: input.statusMessageKey } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
  };
}

/**
 * Compatibility delivery path for Lark/Feishu while unified delivery is not
 * released. It deliberately handles only provider output; receipts remain
 * disabled so a missing reaction permission can never suppress the reply.
 */
export function createLocalLarkDeliveryProducer(input: {
  appId?: string;
  appSecret?: string;
  domain?: "lark" | "feishu";
  client?: LarkReplyClient;
}): LarkDeliveryProducer {
  if (!input.client && (!input.appId || !input.appSecret)) {
    throw new Error("Local Lark delivery requires appId/appSecret or an injected client.");
  }

  const client = input.client ?? createLarkReplyClient({
    appId: input.appId!,
    appSecret: input.appSecret!,
    ...(input.domain ? { domain: input.domain } : {})
  });
  const statusMessageIds = new Map<string, string>();
  const deliveredIdempotencyKeys = new Set<string>();

  return {
    async enqueue(presentation) {
      const provider = presentation.kind === "source_thread_control"
        ? presentation.request.callback.provider
        : presentation.provider;
      if (provider !== "lark") return { outcome: "activation_blocked" };

      // Source receipts are optional liveness hints. Treat them as accepted
      // without provider I/O; the running/final card is the user-visible path.
      if (presentation.kind === "source_receipt") {
        return { outcome: "queued", sideEffectIntentId: `${presentation.runId}:${presentation.phase}:receipt` };
      }

      const message = larkPresentation(presentation);
      if (!message?.threadKey) {
        throw new Error("Local Lark delivery is missing a callback thread key.");
      }
      if (message.idempotencyKey && deliveredIdempotencyKeys.has(message.idempotencyKey)) {
        return { outcome: "queued", sideEffectIntentId: message.idempotencyKey };
      }

      const existingMessageId = message.statusMessageKey
        ? statusMessageIds.get(message.statusMessageKey)
        : undefined;
      if (existingMessageId) {
        if (message.card) {
          await patchLarkMessageCard(client, { messageId: existingMessageId, card: message.card });
        } else {
          await updateLarkTextMessage(client, { messageId: existingMessageId, text: message.body });
        }
      } else {
        const { messageId: sourceMessageId } = parseLarkThreadKey(message.threadKey);
        const reply = await replyLarkMessage(client, {
          messageId: sourceMessageId,
          text: message.body,
          ...(message.card ? { card: message.card } : {})
        });
        if (message.statusMessageKey && reply.messageId) {
          statusMessageIds.set(message.statusMessageKey, reply.messageId);
        }
      }

      if (message.idempotencyKey) deliveredIdempotencyKeys.add(message.idempotencyKey);
      return {
        outcome: "queued",
        sideEffectIntentId: message.idempotencyKey
          ?? `${presentation.kind === "source_thread_control" ? presentation.auditRunId ?? "control" : presentation.runId}:${presentation.kind}`
      };
    }
  };
}
