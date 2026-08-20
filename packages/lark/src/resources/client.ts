import type { LarkDomain } from "../registration.js";
import type { FeishuDownloadedResource } from "./types.js";
import type { FeishuFetch, FeishuTokenProvider } from "./oauth.js";

export const DEFAULT_FEISHU_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_FEISHU_DOWNLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

export class FeishuOpenApiError extends Error {
  readonly status: number;
  readonly code?: number;

  constructor(message: string, input: { status: number; code?: number }) {
    super(message);
    this.name = "FeishuOpenApiError";
    this.status = input.status;
    if (input.code !== undefined) this.code = input.code;
  }
}

export type FeishuOpenApiClient = {
  requestJson<T>(path: string, options?: {
    method?: "GET" | "POST";
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  }): Promise<T>;
  requestBinary(path: string, options?: {
    query?: Record<string, string | number | boolean | undefined>;
    maxBytes?: number;
  }): Promise<FeishuDownloadedResource>;
};

function apiOrigin(domain: LarkDomain): string {
  return domain === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com";
}

function requestUrl(origin: string, path: string, query?: Record<string, string | number | boolean | undefined>): URL {
  if (!path.startsWith("/open-apis/")) throw new Error("Feishu OpenAPI path must start with /open-apis/.");
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function apiError(response: Response): Promise<FeishuOpenApiError> {
  const payload = (await response.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const code = typeof payload.code === "number" ? payload.code : undefined;
  const detail = typeof payload.msg === "string" ? payload.msg : response.statusText || "request_failed";
  return new FeishuOpenApiError(`Feishu OpenAPI request failed with status ${response.status}: ${detail}`, {
    status: response.status,
    ...(code !== undefined ? { code } : {})
  });
}

function responseFileName(response: Response): string | undefined {
  const disposition = response.headers.get("content-disposition");
  if (!disposition) return undefined;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return disposition.match(/filename="?([^";]+)"?/iu)?.[1];
}

export function createFeishuOpenApiClient(input: {
  tokenProvider: FeishuTokenProvider;
  domain?: LarkDomain;
  fetchImpl?: FeishuFetch;
  timeoutMs?: number;
  downloadLimitBytes?: number;
}): FeishuOpenApiClient {
  const origin = apiOrigin(input.domain ?? "feishu");
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_FEISHU_REQUEST_TIMEOUT_MS;

  async function request(path: string, options: {
    method?: "GET" | "POST";
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  } = {}, retry = true): Promise<Response> {
    const token = await input.tokenProvider.getToken();
    const response = await fetchImpl(requestUrl(origin, path, options.query), {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(options.body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status === 401 && retry && input.tokenProvider.invalidate) {
      input.tokenProvider.invalidate();
      return request(path, options, false);
    }
    return response;
  }

  return {
    async requestJson<T>(path: string, options: {
      method?: "GET" | "POST";
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    } = {}) {
      const response = await request(path, options);
      if (!response.ok) throw await apiError(response);
      const payload = (await response.json()) as { code?: unknown; msg?: unknown; data?: T } & T;
      if (typeof payload.code === "number" && payload.code !== 0) throw await apiError(response);
      return payload.data === undefined ? payload : payload.data;
    },
    async requestBinary(path: string, options: {
      query?: Record<string, string | number | boolean | undefined>;
      maxBytes?: number;
    } = {}) {
      const maxBytes = options.maxBytes ?? input.downloadLimitBytes ?? DEFAULT_FEISHU_DOWNLOAD_LIMIT_BYTES;
      const response = await request(path, options.query ? { query: options.query } : {});
      if (!response.ok) throw await apiError(response);
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        throw new Error(`Feishu resource exceeds the configured ${maxBytes}-byte download limit.`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        throw new Error(`Feishu resource exceeds the configured ${maxBytes}-byte download limit.`);
      }
      const fileName = responseFileName(response);
      const mediaType = response.headers.get("content-type");
      return {
        bytes,
        ...(fileName ? { fileName } : {}),
        ...(mediaType ? { mediaType } : {})
      };
    }
  };
}
