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
  chatBody?: string;
  attentionRequired?: boolean;
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
    ...(input.chatBody ? { larkChatBody: input.chatBody } : {}),
    ...(input.attentionRequired ? { larkAttentionRequired: true } : {}),
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
      body: "已完成：success。\n\n这是普通群聊回答。\n\nAudit: opentag status --run run_hello",
      chatBody: "这是普通群聊回答。",
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

  it("keeps an approval visible by moving chat attention into a thread", async () => {
    const reply = vi.fn().mockResolvedValue({ data: { message_id: "om_approval" } });
    const client: LarkReplyClient = { im: { message: { reply } } };
    const producer = createLocalLarkDeliveryProducer({ client });
    const approvalCard = { config: { wide_screen_mode: true }, elements: [{ tag: "action" }] };

    await producer.enqueue(larkBusiness({
      phase: "progress",
      body: "需要确认权限。",
      card: approvalCard,
      interactionMode: "chat",
      replyInThread: false,
      attentionRequired: true
    }));

    expect(reply).toHaveBeenCalledWith({
      path: { message_id: "om_source" },
      data: {
        content: JSON.stringify(approvalCard),
        msg_type: "interactive",
        reply_in_thread: true
      }
    });
  });

  it("posts a fresh final chat reply after an interactive approval card", async () => {
    const reply = vi.fn()
      .mockResolvedValueOnce({ data: { message_id: "om_approval" } })
      .mockResolvedValueOnce({ data: { message_id: "om_answer" } });
    const patch = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const client: LarkReplyClient = { im: { message: { reply, patch, update } } };
    const producer = createLocalLarkDeliveryProducer({ client });

    await producer.enqueue(larkBusiness({
      phase: "progress",
      body: "需要确认权限。",
      card: { config: { wide_screen_mode: true }, elements: [{ tag: "action" }] },
      interactionMode: "chat",
      replyInThread: false,
      attentionRequired: true
    }));
    await producer.enqueue(larkBusiness({
      phase: "final",
      body: "已完成。",
      chatBody: "这是最终答案。",
      interactionMode: "chat",
      replyInThread: false
    }));

    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om_source" },
      data: {
        content: JSON.stringify({ text: "这是最终答案。" }),
        msg_type: "text",
        reply_in_thread: false
      }
    });
    expect(patch).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
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
