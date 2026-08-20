import { commandFromRawText } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { classifyLarkInteraction } from "../src/interaction.js";

function classify(text: string, isThreadReply = false) {
  return classifyLarkInteraction({ text, command: commandFromRawText(text), isThreadReply });
}

describe("classifyLarkInteraction", () => {
  it.each([
    "这个项目为什么会使用 Claude Code？",
    "飞书群机器人有哪些能力",
    "请解释一下这个概念",
    "只回答：这个接口有什么作用",
    "部署是什么意思？",
    "怎么配置飞书回调？",
    "How do I deploy this service?"
  ])("keeps conversational prompt in the channel: %s", (text) => {
    expect(classify(text)).toMatchObject({ mode: "chat", replyInThread: false });
  });

  it.each([
    "fix the login bug",
    "帮我实现群聊回复功能",
    "请修改代码并跑一下测试",
    "请部署这个服务",
    "部署到本地让我测试",
    "task: inspect the process and report back"
  ])("routes execution prompt to an asynchronous thread: %s", (text) => {
    expect(classify(text)).toMatchObject({ mode: "task", replyInThread: true });
  });

  it("honors an explicit chat override before action language", () => {
    expect(classify("/chat 解释怎么部署，但不要执行")).toMatchObject({
      mode: "chat",
      replyInThread: false,
      reason: "explicit_chat_override"
    });
  });

  it("keeps a conversational follow-up inside an existing thread", () => {
    expect(classify("为什么这样改？", true)).toMatchObject({ mode: "chat", replyInThread: true });
  });
});
