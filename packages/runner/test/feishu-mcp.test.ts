import { describe, expect, it, vi } from "vitest";
import {
  createFeishuMcpServerResolver,
  createLarkMcpUserTokenProvider,
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

  it("coalesces refresh and rotates the official local token mapping", async () => {
    let localToken = "expired";
    const tokens = new Map([["expired", {
      clientId: "local",
      token: "expired",
      scopes: ["offline_access"],
      expiresAt: 1,
      extra: { refreshToken: "refresh_1" }
    }]]);
    const store = {
      getLocalAccessToken: async () => localToken,
      getToken: async (token: string) => tokens.get(token),
      storeLocalAccessToken: async (token: string) => { localToken = token; return token; },
      removeToken: async (token: string) => { tokens.delete(token); }
    };
    const provider = { exchangeRefreshToken: vi.fn(async () => {
      tokens.set("current", { clientId: "local", token: "current", scopes: [], expiresAt: 9999999999 });
      return { access_token: "current" };
    }) };
    const tokensProvider = createLarkMcpUserTokenProvider(
      { appId: "cli_1", appSecret: "secret_1", domain: "feishu" },
      { store, provider, now: () => 10_000 }
    );
    await expect(Promise.all([tokensProvider.getToken(), tokensProvider.getToken()])).resolves.toEqual(["current", "current"]);
    expect(provider.exchangeRefreshToken).toHaveBeenCalledOnce();
    expect(localToken).toBe("current");
    expect(tokens.has("expired")).toBe(false);
  });
});
