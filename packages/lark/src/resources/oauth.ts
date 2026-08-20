import type { LarkDomain } from "../registration.js";

export const DEFAULT_FEISHU_USER_SCOPES = [
  "offline_access",
  "docx:document:readonly",
  "drive:drive:readonly",
  "wiki:wiki:readonly",
  "im:message.group_msg:get_as_user",
  "im:message:readonly",
  "sheets:spreadsheet:readonly",
  "bitable:app:readonly"
] as const;

export type FeishuOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
  scope?: string[];
};

export type FeishuStoredOAuthTokens = FeishuOAuthTokens & {
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
};

export type FeishuTokenProvider = {
  getToken(): Promise<string>;
  invalidate?(): void;
};

export type FeishuFetch = typeof fetch;

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

type FeishuTenantTokenResponse = {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

function openApiOrigin(domain: LarkDomain): string {
  return domain === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com";
}

function accountOrigin(domain: LarkDomain): string {
  return domain === "feishu" ? "https://accounts.feishu.cn" : "https://accounts.larksuite.com";
}

export function createFeishuTenantTokenProvider(input: {
  appId: string;
  appSecret: string;
  domain?: LarkDomain;
  fetchImpl?: FeishuFetch;
  now?: () => number;
  refreshSkewMs?: number;
  timeoutMs?: number;
}): FeishuTokenProvider {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const refreshSkewMs = Math.max(input.refreshSkewMs ?? TOKEN_REFRESH_SKEW_MS, 0);
  let accessToken: string | undefined;
  let refreshAt = 0;
  let inFlight: Promise<string> | undefined;

  async function refresh(): Promise<string> {
    const response = await fetchImpl(
      `${openApiOrigin(input.domain ?? "feishu")}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
        body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
        signal: AbortSignal.timeout(input.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS)
      }
    );
    const payload = (await response.json().catch(() => ({}))) as FeishuTenantTokenResponse;
    if (
      !response.ok ||
      payload.code !== 0 ||
      typeof payload.tenant_access_token !== "string" ||
      payload.tenant_access_token.length === 0
    ) {
      const detail = typeof payload.msg === "string" ? payload.msg : response.statusText || "unknown_error";
      throw new Error(`Feishu tenant token request failed with status ${response.status}: ${detail}`);
    }
    accessToken = payload.tenant_access_token;
    const lifetimeMs = Math.max((payload.expire ?? 7200) * 1000, 0);
    refreshAt = now() + Math.max(lifetimeMs - refreshSkewMs, 0);
    return accessToken;
  }

  return {
    async getToken() {
      if (accessToken && now() < refreshAt) return accessToken;
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    invalidate() {
      refreshAt = 0;
    }
  };
}

function parseScope(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (typeof value === "string") return value.split(/[\s,]+/u).filter(Boolean);
  return undefined;
}

async function parseOAuthResponse(response: Response): Promise<FeishuOAuthTokens> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const code = typeof payload.code === "number" ? payload.code : 0;
  if (!response.ok || code !== 0 || typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    const detail = typeof payload.error_description === "string"
      ? payload.error_description
      : typeof payload.msg === "string"
        ? payload.msg
        : typeof payload.error === "string"
          ? payload.error
          : "unknown_error";
    throw new Error(`Feishu OAuth failed with status ${response.status}: ${detail}`);
  }
  const scope = parseScope(payload.scope);
  return {
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
    ...(typeof payload.token_type === "string" ? { tokenType: payload.token_type } : {}),
    ...(typeof payload.expires_in === "number" ? { expiresIn: payload.expires_in } : {}),
    ...(typeof payload.refresh_expires_in === "number" ? { refreshExpiresIn: payload.refresh_expires_in } : {}),
    ...(scope ? { scope } : {})
  };
}

export function buildFeishuOAuthAuthorizationUrl(input: {
  appId: string;
  redirectUri: string;
  state: string;
  domain?: LarkDomain;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    app_id: input.appId,
    redirect_uri: input.redirectUri,
    state: input.state
  });
  const scopes = input.scopes ?? DEFAULT_FEISHU_USER_SCOPES;
  if (scopes.length > 0) params.set("scope", scopes.join(" "));
  return `${accountOrigin(input.domain ?? "feishu")}/open-apis/authen/v1/authorize?${params.toString()}`;
}

async function requestOAuthToken(input: {
  appId: string;
  appSecret: string;
  grant: Record<string, string>;
  domain?: LarkDomain;
  fetchImpl?: FeishuFetch;
  timeoutMs?: number;
}): Promise<FeishuOAuthTokens> {
  const response = await (input.fetchImpl ?? fetch)(`${openApiOrigin(input.domain ?? "feishu")}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
    body: JSON.stringify({
      grant_type: input.grant.grant_type,
      client_id: input.appId,
      client_secret: input.appSecret,
      ...input.grant
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS)
  });
  return parseOAuthResponse(response);
}

export function exchangeFeishuOAuthCode(input: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
  domain?: LarkDomain;
  fetchImpl?: FeishuFetch;
  timeoutMs?: number;
}): Promise<FeishuOAuthTokens> {
  return requestOAuthToken({
    ...input,
    grant: { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }
  });
}

export function refreshFeishuOAuthToken(input: {
  appId: string;
  appSecret: string;
  refreshToken: string;
  domain?: LarkDomain;
  fetchImpl?: FeishuFetch;
  timeoutMs?: number;
}): Promise<FeishuOAuthTokens> {
  return requestOAuthToken({
    ...input,
    grant: { grant_type: "refresh_token", refresh_token: input.refreshToken }
  });
}

export function feishuTokensWithExpiry(tokens: FeishuOAuthTokens, now = new Date()): FeishuStoredOAuthTokens {
  return {
    ...tokens,
    ...(tokens.expiresIn !== undefined
      ? { accessTokenExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000).toISOString() }
      : {}),
    ...(tokens.refreshExpiresIn !== undefined
      ? { refreshTokenExpiresAt: new Date(now.getTime() + tokens.refreshExpiresIn * 1000).toISOString() }
      : {})
  };
}

export function createFeishuUserTokenProvider(input: {
  appId: string;
  appSecret: string;
  tokens: FeishuStoredOAuthTokens;
  domain?: LarkDomain;
  fetchImpl?: FeishuFetch;
  now?: () => Date;
  refreshSkewMs?: number;
  onTokensChanged?(tokens: FeishuStoredOAuthTokens): Promise<void> | void;
}): FeishuTokenProvider {
  const now = input.now ?? (() => new Date());
  const refreshSkewMs = input.refreshSkewMs ?? TOKEN_REFRESH_SKEW_MS;
  let tokens = { ...input.tokens };
  let invalidated = false;
  let inFlight: Promise<string> | undefined;

  async function refresh(): Promise<string> {
    if (!tokens.refreshToken) throw new Error("Feishu user access token expired and no refresh token is configured.");
    const refreshed = await refreshFeishuOAuthToken({
      appId: input.appId,
      appSecret: input.appSecret,
      refreshToken: tokens.refreshToken,
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
    });
    tokens = feishuTokensWithExpiry({
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken
    }, now());
    invalidated = false;
    await input.onTokensChanged?.({ ...tokens });
    return tokens.accessToken;
  }

  return {
    async getToken() {
      const expiry = tokens.accessTokenExpiresAt ? Date.parse(tokens.accessTokenExpiresAt) : Number.NaN;
      const shouldRefresh = invalidated || (Number.isFinite(expiry) && expiry <= now().getTime() + refreshSkewMs);
      if (!shouldRefresh) return tokens.accessToken;
      if (!inFlight) {
        inFlight = refresh().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
    invalidate() {
      invalidated = true;
    }
  };
}
