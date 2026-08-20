import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { ExecutorRunInput } from "./executor.js";

export const FEISHU_MCP_READ_ONLY_TOOLS = [
  "docx.v1.document.rawContent",
  "docx.builtin.search",
  "drive.v1.file.list",
  "wiki.v2.space.getNode",
  "wiki.v2.space.list",
  "wiki.v2.spaceNode.list",
  "wiki.v1.node.search",
  "im.v1.message.get",
  "im.v1.message.list",
  "bitable.v1.app.get",
  "bitable.v1.appTable.list",
  "bitable.v1.appTableField.list",
  "bitable.v1.appTableRecord.get",
  "bitable.v1.appTableRecord.list",
  "bitable.v1.appTableRecord.search"
] as const;

export const FEISHU_MCP_OAUTH_SCOPES = [
  "offline_access",
  "docx:document:readonly",
  "drive:drive:readonly",
  "wiki:wiki:readonly",
  "im:message.group_msg",
  "sheets:spreadsheet:readonly",
  "bitable:app:readonly"
] as const;

export type AcpMcpServerResolver = (input: ExecutorRunInput) => acp.McpServer[];

export function larkMcpCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@larksuiteoapi/lark-mcp/package.json")), "dist", "cli.js");
}

export function createFeishuMcpServerResolver(input: {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  cliPath?: string;
}): AcpMcpServerResolver {
  if (!input.appId.trim() || !input.appSecret.trim()) throw new Error("Feishu MCP requires appId and appSecret.");
  const apiDomain = input.domain === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com";
  const language = input.domain === "feishu" ? "zh" : "en";
  const cliPath = input.cliPath ?? larkMcpCliPath();
  const tools = FEISHU_MCP_READ_ONLY_TOOLS.join(",");

  return (run) => {
    if (run.metadata?.larkDomain !== input.domain) return [];
    return [{
      name: "feishu-openapi-readonly",
      command: process.execPath,
      args: [
        cliPath,
        "mcp",
        "--oauth",
        "--token-mode",
        "user_access_token",
        "--tools",
        tools,
        "--language",
        language
      ],
      env: [
        { name: "APP_ID", value: input.appId },
        { name: "APP_SECRET", value: input.appSecret },
        { name: "LARK_DOMAIN", value: apiDomain },
        { name: "LARK_TOKEN_MODE", value: "user_access_token" },
        { name: "LARK_TOOLS", value: tools }
      ]
    }];
  };
}
