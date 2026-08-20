import { describe, expect, it, vi } from "vitest";
import { runFeishuLoginCommand } from "../src/feishu-login.js";
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
      scopes: expect.arrayContaining(["offline_access", "docx:document:readonly", "im:message.group_msg"])
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
