import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ControlPlaneApplication } from "./application.js";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function isApplicationRequest(pathname: string): boolean {
  return pathname === "/healthz"
    || pathname === "/readyz"
    || pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/v1"
    || pathname.startsWith("/v1/");
}

function safeAssetPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(root, `.${decoded}`);
  return candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

async function staticResponse(path: string, immutable: boolean) {
  try {
    const body = await readFile(path);
    return new Response(body, {
      headers: {
        "cache-control": immutable
          ? "public, max-age=31536000, immutable"
          : "no-store",
        "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        ...(extname(path) === ".html"
          ? {
              "content-security-policy": [
                "default-src 'self'",
                "base-uri 'none'",
                "connect-src 'self'",
                "form-action 'self'",
                "frame-ancestors 'none'",
                "img-src 'self' data:",
                "object-src 'none'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline'",
              ].join("; "),
            }
          : {}),
      },
    });
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error.code === "ENOENT" || error.code === "EISDIR")
    ) {
      return null;
    }
    throw error;
  }
}

export function createConsoleAssetApplication(input: {
  application: ControlPlaneApplication;
  assetsDirectory: string;
}): ControlPlaneApplication {
  const root = resolve(input.assetsDirectory);
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (isApplicationRequest(pathname) || !["GET", "HEAD"].includes(request.method)) {
        return input.application.fetch(request);
      }

      if (pathname.startsWith("/assets/")) {
        const path = safeAssetPath(root, pathname);
        if (!path) return new Response(null, { status: 404 });
        const response = await staticResponse(path, true);
        if (!response) return new Response(null, { status: 404 });
        return request.method === "HEAD"
          ? new Response(null, { headers: response.headers, status: response.status })
          : response;
      }

      const response = await staticResponse(resolve(root, "index.html"), false);
      if (!response) return input.application.fetch(request);
      return request.method === "HEAD"
        ? new Response(null, { headers: response.headers, status: response.status })
        : response;
    },
  };
}
