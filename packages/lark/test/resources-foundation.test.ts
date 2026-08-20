import { describe, expect, it, vi } from "vitest";
import {
  buildFeishuOAuthAuthorizationUrl,
  createFeishuOpenApiClient,
  createFeishuUserTokenProvider,
  exchangeFeishuOAuthCode,
  findFeishuResourceReferences,
  parseFeishuResourceReference
} from "../src/index.js";

describe("Feishu resource references", () => {
  it("parses supported Feishu URLs and deduplicates references", () => {
    expect(parseFeishuResourceReference("https://acme.feishu.cn/docx/doccn123?from=chat")).toEqual({
      token: "doccn123",
      type: "document",
      sourceUrl: "https://acme.feishu.cn/docx/doccn123?from=chat"
    });
    expect(parseFeishuResourceReference("https://acme.feishu.cn/wiki/wikcn456")).toMatchObject({
      token: "wikcn456",
      type: "wiki"
    });
    expect(findFeishuResourceReferences(
      "read https://acme.feishu.cn/docx/doccn123 and https://acme.feishu.cn/docx/doccn123."
    )).toHaveLength(1);
  });

  it("rejects lookalike hosts and insecure resource URLs", () => {
    expect(() => parseFeishuResourceReference("https://feishu.cn.example.test/docx/doccn1")).toThrow(/Feishu resource URL/u);
    expect(() => parseFeishuResourceReference("http://acme.feishu.cn/docx/doccn1")).toThrow(/HTTPS/u);
  });
});

describe("Feishu user OAuth", () => {
  it("builds a user authorization URL with bounded read scopes", () => {
    const url = new URL(buildFeishuOAuthAuthorizationUrl({
      appId: "cli_1",
      redirectUri: "http://localhost:3000/callback",
      state: "state_1"
    }));
    expect(url.origin).toBe("https://accounts.feishu.cn");
    expect(url.searchParams.get("app_id")).toBe("cli_1");
    expect(url.searchParams.get("scope")).toContain("docx:document:readonly");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("exchanges an OAuth code without exposing credentials in errors", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({
        code: 0,
        access_token: "access_1",
        refresh_token: "refresh_1",
        expires_in: 7200,
        refresh_expires_in: 2592000,
        scope: "offline_access docx:document:readonly"
      });
    }) as unknown as typeof fetch;

    await expect(exchangeFeishuOAuthCode({
      appId: "cli_1",
      appSecret: "secret_1",
      code: "code_1",
      redirectUri: "http://localhost:3000/callback",
      fetchImpl
    })).resolves.toMatchObject({ accessToken: "access_1", refreshToken: "refresh_1" });

    expect(requests[0]?.url).toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token");
    expect(requests[0]?.body).toMatchObject({ grant_type: "authorization_code", client_id: "cli_1", code: "code_1" });
  });

  it("coalesces concurrent refreshes and persists rotated tokens", async () => {
    const onTokensChanged = vi.fn();
    const fetchImpl = vi.fn(async () => Response.json({
      code: 0,
      access_token: "access_2",
      refresh_token: "refresh_2",
      expires_in: 7200
    })) as unknown as typeof fetch;
    const provider = createFeishuUserTokenProvider({
      appId: "cli_1",
      appSecret: "secret_1",
      tokens: {
        accessToken: "access_1",
        refreshToken: "refresh_1",
        accessTokenExpiresAt: "2026-01-01T00:00:00.000Z"
      },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
      fetchImpl,
      onTokensChanged
    });

    await expect(Promise.all([provider.getToken(), provider.getToken()])).resolves.toEqual(["access_2", "access_2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onTokensChanged).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "refresh_2" }));
  });
});

describe("Feishu OpenAPI client", () => {
  it("adds user authorization, unwraps data, and retries one unauthorized request", async () => {
    let calls = 0;
    const tokenProvider = {
      getToken: vi.fn(async () => calls === 0 ? "expired" : "current"),
      invalidate: vi.fn()
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return Response.json({ code: 99991663, msg: "token expired" }, { status: 401 });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer current");
      return Response.json({ code: 0, data: { value: "ok" } });
    }) as unknown as typeof fetch;
    const client = createFeishuOpenApiClient({ tokenProvider, fetchImpl });

    await expect(client.requestJson<{ value: string }>("/open-apis/example/v1/resource")).resolves.toEqual({ value: "ok" });
    expect(tokenProvider.invalidate).toHaveBeenCalledOnce();
  });

  it("enforces the binary resource size limit", async () => {
    const client = createFeishuOpenApiClient({
      tokenProvider: { getToken: async () => "access" },
      downloadLimitBytes: 3,
      fetchImpl: vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "application/pdf" }
      })) as unknown as typeof fetch
    });
    await expect(client.requestBinary("/open-apis/im/v1/resource")).rejects.toThrow(/download limit/u);
  });
});
