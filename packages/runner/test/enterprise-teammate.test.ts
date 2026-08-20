import { describe, expect, it } from "vitest";
import { renderEnterpriseTeammatePrompt } from "../src/enterprise-teammate.js";
import type { ExecutorRunInput } from "../src/executor.js";

function input(metadata: Record<string, unknown>): ExecutorRunInput {
  return {
    runId: "run_chat",
    workspace: { kind: "scratch", path: "/tmp/opentag-chat" },
    command: { rawText: "这个权限为什么要开？", intent: "unknown", args: {} },
    context: [],
    metadata
  };
}

describe("enterprise teammate runtime prompt", () => {
  it("injects the current Lark chat scene and answer-only posture", () => {
    const prompt = renderEnterpriseTeammatePrompt(input({
      provider: "lark",
      chatType: "group",
      larkInteractionMode: "chat",
      sourceActorId: "ou_user",
      sourceOccurredAt: "2026-08-20T10:00:00.000Z"
    })).join("\n");

    expect(prompt).toContain("platform: lark");
    expect(prompt).toContain("conversation: group");
    expect(prompt).toContain("interaction mode: chat");
    expect(prompt).toContain("speaker id: ou_user");
    expect(prompt).toContain("This is chat mode. Return the conversational answer itself");
    expect(prompt).toContain("Tag: 为了读你明确提到的群消息和文档");
  });

  it("keeps topic tasks action-oriented", () => {
    const prompt = renderEnterpriseTeammatePrompt(input({
      provider: "lark",
      chatType: "group",
      larkInteractionMode: "task",
      rootId: "om_root"
    })).join("\n");

    expect(prompt).toContain("already inside a topic: yes");
    expect(prompt).toContain("This is task mode. Execute the authorized work");
  });
});
