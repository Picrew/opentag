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

type StoredAuthInfo = {
  clientId: string;
  token: string;
  scopes: string[];
  expiresAt?: number;
  extra?: { refreshToken?: string };
};

type LarkMcpAuthStore = {
  getLocalAccessToken(appId: string): Promise<string | undefined>;
  getToken(accessToken: string): Promise<StoredAuthInfo | undefined>;
  removeToken(accessToken: string): Promise<void>;
  storeLocalAccessToken(accessToken: string, appId: string): Promise<string>;
};

type LarkMcpOAuthProvider = {
  exchangeRefreshToken(
    client: { client_id: string; redirect_uris: string[] },
    refreshToken: string,
    scopes: string[]
  ): Promise<{ access_token: string }>;
};

export type LarkMcpUserTokenProvider = {
  getToken(): Promise<string>;
  invalidate(): void;
};

export function larkMcpCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@larksuiteoapi/lark-mcp/package.json")), "dist", "cli.js");
}

function larkMcpPackageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@larksuiteoapi/lark-mcp/package.json"));
}

function defaultAuthDependencies(input: { appId: string; appSecret: string; domain: "feishu" | "lark" }): {
  store: LarkMcpAuthStore;
  provider: LarkMcpOAuthProvider;
} {
  const require = createRequire(import.meta.url);
  const root = larkMcpPackageRoot();
  const store = (require(join(root, "dist", "auth", "store.js")) as { authStore: LarkMcpAuthStore }).authStore;
  const Provider = (require(join(root, "dist", "auth", "provider", "oauth.js")) as {
    LarkOAuth2OAuthServerProvider: new (options: Record<string, unknown>) => LarkMcpOAuthProvider;
  }).LarkOAuth2OAuthServerProvider;
  return {
    store,
    provider: new Provider({
      appId: input.appId,
      appSecret: input.appSecret,
      domain: input.domain === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com",
      host: "localhost",
      port: "3000",
      callbackUrl: "http://localhost:3000/callback"
    })
  };
}

export function createLarkMcpUserTokenProvider(
  input: { appId: string; appSecret: string; domain: "feishu" | "lark"; refreshSkewSeconds?: number },
  dependencies?: { store: LarkMcpAuthStore; provider: LarkMcpOAuthProvider; now?: () => number }
): LarkMcpUserTokenProvider {
  const auth = dependencies ?? { ...defaultAuthDependencies(input), now: () => Date.now() };
  const now = auth.now ?? (() => Date.now());
  const refreshSkewSeconds = Math.max(input.refreshSkewSeconds ?? 300, 0);
  let invalidated = false;
  let refreshInFlight: Promise<string> | undefined;

  async function current(): Promise<{ accessToken: string; info: StoredAuthInfo }> {
    const accessToken = await auth.store.getLocalAccessToken(input.appId);
    if (!accessToken) throw new Error("Feishu user OAuth session is missing. Run `opentag feishu login`.");
    const info = await auth.store.getToken(accessToken);
    if (!info) throw new Error("Feishu user OAuth session is unreadable. Run `opentag feishu login` again.");
    return { accessToken, info };
  }

  async function refresh(): Promise<string> {
    const { accessToken, info } = await current();
    const refreshToken = info.extra?.refreshToken;
    if (!refreshToken) throw new Error("Feishu user OAuth session cannot be refreshed. Run `opentag feishu login` again.");
    const token = await auth.provider.exchangeRefreshToken(
      { client_id: info.clientId, redirect_uris: ["http://localhost:3000/callback"] },
      refreshToken,
      info.scopes
    );
    await auth.store.storeLocalAccessToken(token.access_token, input.appId);
    if (token.access_token !== accessToken) await auth.store.removeToken(accessToken);
    invalidated = false;
    return token.access_token;
  }

  return {
    async getToken() {
      const { accessToken, info } = await current();
      const expiresSoon = info.expiresAt !== undefined && info.expiresAt <= now() / 1000 + refreshSkewSeconds;
      if (!invalidated && !expiresSoon) return accessToken;
      refreshInFlight ??= refresh().finally(() => { refreshInFlight = undefined; });
      return refreshInFlight;
    },
    invalidate() {
      invalidated = true;
    }
  };
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
