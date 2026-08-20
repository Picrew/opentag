import type { DispatcherDeliveryPresentation } from "@opentag/dispatcher";
import type { LarkReplyClient } from "@opentag/lark";
import { describe, expect, it, vi } from "vitest";
import { createLocalLarkDeliveryProducer } from "../src/lark-delivery.js";

function larkBusiness(input: {
  phase: "progress" | "final";
  body: string;
  card?: Record<string, unknown>;
  interactionMode?: "chat" | "task";
  replyInThread?: boolean;
}): DispatcherDeliveryPresentation {
  return {
    kind: "business",
    runId: "run_hello",
    provider: "lark",
    uri: "lark://im/v1/messages",
    threadKey: "tenant_1|chat_1|om_source",
    statusMessageKey: "run_hello:status",
    phase: input.phase,
    body: input.body,
    ...(input.interactionMode ? { larkInteractionMode: input.interactionMode } : {}),
    ...(input.replyInThread !== undefined ? { larkReplyInThread: input.replyInThread } : {}),
    ...(input.card ? { rich: { provider: "lark", payload: input.card } } : {})
  };
}

describe("local Lark delivery compatibility path", () => {
  it("creates the running card and patches it with the final answer", async () => {
    const reply = vi.fn().mockResolvedValue({ data: { message_id: "om_status" } });
    const patch = vi.fn().mockResolvedValue({});
    const client: LarkReplyClient = { im: { message: { reply, patch } } };
    const producer = createLocalLarkDeliveryProducer({ client });

    const runningCard = { config: { wide_screen_mode: true }, elements: [] };
    const finalCard = { config: { wide_screen_mode: true }, elements: [{ tag: "div" }] };
    await producer.enqueue(larkBusiness({ phase: "progress", body: "Running.", card: runningCard }));
    await producer.enqueue(larkBusiness({ phase: "final", body: "你好！", card: finalCard }));

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      path: { message_id: "om_source" },
      data: expect.objectContaining({ msg_type: "interactive", reply_in_thread: true })
    }));
    expect(patch).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: "om_status" } }));
  });

  it("suppresses chat lifecycle cards and posts one plain channel reply", async () => {
    const reply = vi.fn().mockResolvedValue({ data: { message_id: "om_answer" } });
    const patch = vi.fn().mockResolvedValue({});
    const client: LarkReplyClient = { im: { message: { reply, patch } } };
    const producer = createLocalLarkDeliveryProducer({ client });

    const card = { config: { wide_screen_mode: true }, elements: [] };
    await producer.enqueue(larkBusiness({
      phase: "progress",
      body: "Running.",
      card,
      interactionMode: "chat",
      replyInThread: false
    }));
    await producer.enqueue(larkBusiness({
      phase: "final",
      body: "这是普通群聊回答。",
      card,
      interactionMode: "chat",
      replyInThread: false
    }));

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      path: { message_id: "om_source" },
      data: {
        content: JSON.stringify({ text: "这是普通群聊回答。" }),
        msg_type: "text",
        reply_in_thread: false
      }
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not call the reaction API for optional source receipts", async () => {
    const request = vi.fn();
    const client: LarkReplyClient = { request, im: { message: {} } };
    const producer = createLocalLarkDeliveryProducer({ client });
    const result = await producer.enqueue({
      kind: "source_receipt",
      runId: "run_hello",
      provider: "lark",
      uri: "lark://im/v1/messages",
      phase: "running"
    });

    expect(result.outcome).toBe("queued");
    expect(request).not.toHaveBeenCalled();
  });
});
