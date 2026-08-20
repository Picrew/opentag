import { afterEach, describe, expect, it, vi } from "vitest";
import { feishuResourceContextFromCliConfig, runFeishuLoginCommand } from "../src/feishu-login.js";
import type { OpenTagCliConfig } from "../src/config.js";

function config(): OpenTagCliConfig {
  return {
    version: 1,
    language: "zh-CN",
    runtime: { mode: "local" },
    daemon: {
      dispatcherUrl: "http://127.0.0.1:3210",
      runnerId: "runner_1",
      repositories: [],
      agents: {}
    },
    state: { databasePath: "/tmp/opentag.db" },
    platforms: {
      lark: { appId: "cli_1", appSecret: "secret_1", domain: "feishu" }
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Feishu OAuth login command", () => {
  it("enables MCP access only after successful user OAuth", async () => {
    const source = config();
    const login = vi.fn(async () => {});
    const writeConfig = vi.fn();
    const logger = { log: vi.fn() };
    await runFeishuLoginCommand({ config: "/tmp/config.json" }, {
      readConfig: () => source,
      writeConfig,
      login,
      logger
    });
    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      appId: "cli_1",
      appSecret: "secret_1",
      domain: "feishu",
      scopes: expect.arrayContaining([
        "offline_access",
        "docx:document:readonly",
        "im:message.group_msg:get_as_user",
        "im:message:readonly"
      ])
    }));
    expect(writeConfig).toHaveBeenCalledWith("/tmp/config.json", expect.objectContaining({
      platforms: { lark: expect.objectContaining({ userResourceAccess: { enabled: true } }) }
    }));
  });

  it("does not update config when OAuth fails", async () => {
    const writeConfig = vi.fn();
    await expect(runFeishuLoginCommand({}, {
      readConfig: () => config(),
      writeConfig,
      login: async () => { throw new Error("denied"); }
    })).rejects.toThrow("denied");
    expect(writeConfig).not.toHaveBeenCalled();
  });
});

describe("Feishu runtime resource context", () => {
  it("reads group history with the bot tenant identity without requiring user OAuth", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        return Response.json({ code: 0, tenant_access_token: "tenant_1", expire: 7200 });
      }
      if (href.includes("/open-apis/im/v1/messages?")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tenant_1");
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            items: [{
              message_id: "om-before",
              msg_type: "text",
              create_time: "1787230000000",
              sender: { id: "ou-1" },
              body: { content: JSON.stringify({ text: "Earlier group decision" }) }
            }]
          }
        });
      }
      return Response.json({ code: 1, msg: "unexpected request" }, { status: 500 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const resolve = feishuResourceContextFromCliConfig(config());
    await expect(resolve?.({
      tenantKey: "tenant_1",
      chatId: "oc_1",
      chatType: "group",
      messageId: "om-current",
      text: "总结上面的讨论",
      attachments: []
    })).resolves.toEqual([
      expect.objectContaining({ text: expect.stringContaining("Earlier group decision") })
    ]);
  });
});
