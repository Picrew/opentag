import { describe, expect, it } from "vitest";
import { patchLarkMessageCard, replyLarkMessage, updateLarkTextMessage, type LarkReplyClient } from "../src/outbound.js";

describe("Lark outbound messages", () => {
  it("replies with text or interactive card content", async () => {
    const calls: unknown[] = [];
    const client: LarkReplyClient = {
      im: {
        message: {
          async reply(payload) {
            calls.push(payload);
          }
        }
      }
    };

    const textReply = await replyLarkMessage(client, { messageId: "om_source", text: "Received." });
    const cardReply = await replyLarkMessage(client, {
      messageId: "om_source",
      text: "fallback",
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: "blue",
          title: { tag: "plain_text", content: "OpenTag" }
        },
        elements: [{ tag: "div", text: { tag: "lark_md", content: "Working" } }]
      }
    });
    await replyLarkMessage(client, {
      messageId: "om_source",
      text: "A conversational answer.",
      replyInThread: false
    });

    expect(textReply).toEqual({});
    expect(cardReply).toEqual({});
    expect(calls).toEqual([
      {
        path: { message_id: "om_source" },
        data: {
          content: JSON.stringify({ text: "Received." }),
          msg_type: "text",
          reply_in_thread: true
        }
      },
      {
        path: { message_id: "om_source" },
        data: {
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            header: {
              template: "blue",
              title: { tag: "plain_text", content: "OpenTag" }
            },
            elements: [{ tag: "div", text: { tag: "lark_md", content: "Working" } }]
          }),
          msg_type: "interactive",
          reply_in_thread: true
        }
      },
      {
        path: { message_id: "om_source" },
        data: {
          content: JSON.stringify({ text: "A conversational answer." }),
          msg_type: "text",
          reply_in_thread: false
        }
      }
    ]);
  });

  it("patches an existing interactive card message", async () => {
    const calls: unknown[] = [];
    const client: LarkReplyClient = {
      im: {
        v1: {
          message: {
            async patch(payload) {
              calls.push(payload);
            }
          }
        }
      }
    };

    await patchLarkMessageCard(client, {
      messageId: "om_status",
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: "green",
          title: { tag: "plain_text", content: "Finished" }
        },
        elements: [{ tag: "div", text: { tag: "lark_md", content: "Done" } }]
      }
    });

    expect(calls).toEqual([
      {
        path: { message_id: "om_status" },
        data: {
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            header: {
              template: "green",
              title: { tag: "plain_text", content: "Finished" }
            },
            elements: [{ tag: "div", text: { tag: "lark_md", content: "Done" } }]
          })
        }
      }
    ]);
  });

  it("updates an existing text message without using the card patch API", async () => {
    const calls: unknown[] = [];
    const client: LarkReplyClient = {
      im: {
        v1: {
          message: {
            async update(payload) {
              calls.push(payload);
            }
          }
        }
      }
    };

    await updateLarkTextMessage(client, { messageId: "om_text", text: "OpenTag is working." });

    expect(calls).toEqual([
      {
        path: { message_id: "om_text" },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: "OpenTag is working." })
        }
      }
    ]);
  });
});
