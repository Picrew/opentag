import { describe, expect, it, vi } from "vitest";
import type { LarkReplyClient } from "@opentag/lark";
import { createLarkCallbackSink } from "../src/callbacks.js";
import type { CallbackMessage } from "../src/server.js";

function larkMessage(overrides?: Partial<CallbackMessage>): CallbackMessage {
  return {
    runId: "run_1",
    kind: "final",
    provider: "lark",
    uri: "lark://im/v1/messages",
    body: "done",
    threadKey: "tk_123|oc_chat|om_msg",
    ...overrides
  };
}

function mockClient() {
  const reply = vi.fn(async () => ({ data: { message_id: "om_reply" } }));
  const client: LarkReplyClient = { im: { message: { reply } } };
  return { client, reply };
}

describe("createLarkCallbackSink", () => {
  it("replies in-thread to the trigger message via the Lark client", async () => {
    const { client, reply } = mockClient();
    const sink = createLarkCallbackSink({ client });
    await sink.deliver(larkMessage());
    expect(reply).toHaveBeenCalledTimes(1);
    const arg = reply.mock.calls[0]?.[0];
    expect(arg?.path.message_id).toBe("om_msg");
    expect(arg?.data.reply_in_thread).toBe(true);
    expect(arg?.data.msg_type).toBe("text");
    expect(JSON.parse(arg?.data.content ?? "{}").text).toBe("done");
  });

  it("ignores non-lark messages", async () => {
    const { client, reply } = mockClient();
    const sink = createLarkCallbackSink({ client });
    await sink.deliver(larkMessage({ provider: "slack" }));
    expect(reply).not.toHaveBeenCalled();
  });

  it("throws on partial credentials (appId without appSecret)", () => {
    expect(() => createLarkCallbackSink({ appId: "cli_x" })).toThrow(/both appId and appSecret/);
  });

  it("does not throw when neither credential is set", () => {
    expect(() => createLarkCallbackSink({})).not.toThrow();
  });

  it("throws when a lark message arrives but no client is configured", async () => {
    const sink = createLarkCallbackSink({});
    await expect(sink.deliver(larkMessage())).rejects.toThrow(/no client configured/);
  });

  it("throws when threadKey is missing", async () => {
    const { client } = mockClient();
    const sink = createLarkCallbackSink({ client });
    const msg: CallbackMessage = {
      runId: "run_1",
      kind: "final",
      provider: "lark",
      uri: "lark://im/v1/messages",
      body: "done"
    };
    await expect(sink.deliver(msg)).rejects.toThrow(/missing threadKey/);
  });
});
