import { describe, expect, it } from "vitest";
import {
  createFeishuMcpServerResolver,
  FEISHU_MCP_OAUTH_SCOPES,
  FEISHU_MCP_READ_ONLY_TOOLS
} from "../src/feishu-mcp.js";
import type { ExecutorRunInput } from "../src/executor.js";

function run(metadata: Record<string, unknown>): ExecutorRunInput {
  return {
    runId: "run_1",
    workspace: { kind: "scratch", path: "/tmp/work" },
    command: { rawText: "read docs", intent: "run", args: {} },
    context: [],
    metadata
  };
}

describe("Feishu MCP session configuration", () => {
  it("attaches only to matching Lark/Feishu runs", () => {
    const resolve = createFeishuMcpServerResolver({
      appId: "cli_1",
      appSecret: "secret_1",
      domain: "feishu",
      cliPath: "/opt/lark-mcp/cli.js"
    });
    expect(resolve(run({ larkDomain: "lark" }))).toEqual([]);
    expect(resolve(run({}))).toEqual([]);
    expect(resolve(run({ larkDomain: "feishu" }))).toEqual([expect.objectContaining({
      name: "feishu-openapi-readonly",
      command: process.execPath,
      args: expect.arrayContaining(["/opt/lark-mcp/cli.js", "--oauth", "user_access_token"]),
      env: expect.arrayContaining([
        { name: "APP_ID", value: "cli_1" },
        { name: "APP_SECRET", value: "secret_1" },
        { name: "LARK_TOKEN_MODE", value: "user_access_token" }
      ])
    })]);
  });

  it("exposes only read operations and requests user OAuth scopes", () => {
    expect(FEISHU_MCP_READ_ONLY_TOOLS).toContain("docx.v1.document.rawContent");
    expect(FEISHU_MCP_READ_ONLY_TOOLS).toContain("im.v1.message.list");
    expect(FEISHU_MCP_READ_ONLY_TOOLS.some((tool) => /create|update|delete|patch|reply/iu.test(tool))).toBe(false);
    expect(FEISHU_MCP_OAUTH_SCOPES).toContain("offline_access");
    expect(FEISHU_MCP_OAUTH_SCOPES).toContain("im:message.group_msg");
  });
});
