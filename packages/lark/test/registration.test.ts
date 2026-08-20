import { describe, expect, it, vi } from "vitest";
import { registerLarkPersonalAgent, validateLarkCredentials } from "../src/registration.js";

describe("Lark Personal Agent registration", () => {
  it("registers a Personal Agent and fetches the bot identity", async () => {
    const qrCodes: string[] = [];
    const statuses: string[] = [];
    const registerApp = vi.fn(async (options) => {
      options.onQRCodeReady({ url: "https://scan.example", expireIn: 600 });
      options.onStatusChange?.({ status: "domain_switched" });
      return {
        client_id: "cli_test",
        client_secret: "secret_test",
        user_info: { open_id: "ou_operator", tenant_brand: "lark" as const }
      };
    });
    const request = vi.fn(async () => ({
      bot: { open_id: "ou_bot", app_name: "OpenTag Felix" }
    }));

    const result = await registerLarkPersonalAgent(
      {
        onQrCode(info) {
          qrCodes.push(info.url);
        },
        onStatus(info) {
          statuses.push(info.status);
        }
      },
      {
        registerApp,
        createBotInfoClient() {
          return { request };
        },
        sleep: vi.fn()
      }
    );

    expect(registerApp).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "accounts.feishu.cn",
        larkDomain: "accounts.larksuite.com",
        createOnly: true,
        source: "opentag",
        addons: expect.objectContaining({
          scopes: expect.objectContaining({
            tenant: [
              "im:message:send_as_bot",
              "im:message.p2p_msg:readonly",
              "im:message.group_msg:readonly",
              "im:chat:readonly",
              "docx:document:readonly",
              "drive:drive:readonly",
              "wiki:wiki:readonly",
              "im:message.group_msg",
              "sheets:spreadsheet:readonly",
              "bitable:app:readonly"
            ]
          }),
          callbacks: expect.objectContaining({
            items: expect.arrayContaining(["card.action.trigger"])
          })
        })
      })
    );
    expect(qrCodes).toEqual(["https://scan.example"]);
    expect(statuses).toEqual(["domain_switched"]);
    expect(request).toHaveBeenCalledWith({ url: "/open-apis/bot/v3/info", method: "GET" });
    expect(result).toEqual({
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      operatorOpenId: "ou_operator",
      botOpenId: "ou_bot",
      botName: "OpenTag Felix"
    });
  });

  it("keeps credentials when bot identity lookup fails", async () => {
    const warnings: string[] = [];

    const result = await registerLarkPersonalAgent(
      {
        onQrCode() {},
        onWarning(message) {
          warnings.push(message);
        }
      },
      {
        async registerApp() {
          return {
            client_id: "cli_test",
            client_secret: "secret_test",
            user_info: { tenant_brand: "lark" as const }
          };
        },
        createBotInfoClient() {
          return {
            async request() {
              throw new Error("not ready");
            }
          };
        },
        sleep: vi.fn()
      }
    );

    expect(result).toEqual({
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark"
    });
    expect(warnings[0]).toContain("could not fetch the Lark bot open_id");
  });

  it("starts Lark registrations through the SDK's Feishu bootstrap domain", async () => {
    const registerApp = vi.fn(async () => ({
      client_id: "cli_test",
      client_secret: "secret_test",
      user_info: { tenant_brand: "lark" as const }
    }));

    await registerLarkPersonalAgent(
      {
        onQrCode() {}
      },
      {
        registerApp,
        createBotInfoClient() {
          return {
            async request() {
              return { bot: { open_id: "ou_bot" } };
            }
          };
        },
        sleep: vi.fn()
      }
    );

    expect(registerApp).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "accounts.feishu.cn",
        larkDomain: "accounts.larksuite.com"
      })
    );
  });

  it("falls back to Feishu when registration does not report a tenant", async () => {
    const result = await registerLarkPersonalAgent(
      {
        onQrCode() {}
      },
      {
        async registerApp() {
          return {
            client_id: "cli_test",
            client_secret: "secret_test"
          };
        },
        createBotInfoClient() {
          return {
            async request() {
              return { bot: { open_id: "ou_bot" } };
            }
          };
        },
        sleep: vi.fn()
      }
    );

    expect(result.domain).toBe("feishu");
  });

  it("validates manual credentials by fetching bot identity", async () => {
    const request = vi.fn(async () => ({ data: { bot: { open_id: "ou_bot", name: "OpenTag" } } }));

    await expect(
      validateLarkCredentials(
        {
          appId: "cli_test",
          appSecret: "secret_test",
          domain: "lark"
        },
        {
          createBotInfoClient() {
            return { request };
          }
        }
      )
    ).resolves.toEqual({
      botOpenId: "ou_bot",
      botName: "OpenTag"
    });
    expect(request).toHaveBeenCalledWith({ url: "/open-apis/bot/v3/info", method: "GET" });
  });

  it("rejects manual credentials when bot identity cannot be verified", async () => {
    await expect(
      validateLarkCredentials(
        {
          appId: "cli_test",
          appSecret: "bad_secret",
          domain: "feishu"
        },
        {
          createBotInfoClient() {
            return {
              async request() {
                throw new Error("invalid app secret");
              }
            };
          }
        }
      )
    ).rejects.toThrow("Lark credentials could not be verified");
  });
});
