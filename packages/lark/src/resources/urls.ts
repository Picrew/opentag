import type { FeishuResourceReference, FeishuResourceType } from "./types.js";

const RESOURCE_PATH_TYPES: Readonly<Record<string, FeishuResourceType>> = {
  docx: "document",
  docs: "document",
  wiki: "wiki",
  drive: "file",
  file: "file",
  folder: "folder",
  sheets: "sheet",
  sheet: "sheet",
  base: "bitable",
  bitable: "bitable"
};

export function isFeishuHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "feishu.cn"
    || normalized.endsWith(".feishu.cn")
    || normalized === "larksuite.com"
    || normalized.endsWith(".larksuite.com");
}

export function parseFeishuResourceReference(urlOrId: string, expectedType: FeishuResourceType = "document"): FeishuResourceReference {
  const input = urlOrId.trim();
  if (!input) throw new Error("Feishu resource reference must not be empty.");

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { token: input, type: expectedType };
  }

  if (url.protocol !== "https:" || !isFeishuHost(url.hostname)) {
    throw new Error("Feishu resource URL must use HTTPS on a feishu.cn or larksuite.com host.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const kindIndex = parts.findIndex((part) => RESOURCE_PATH_TYPES[part.toLowerCase()] !== undefined);
  const kind = kindIndex >= 0 ? parts[kindIndex]?.toLowerCase() : undefined;
  const token = kindIndex >= 0 ? parts[kindIndex + 1] : undefined;
  if (!kind || !token) {
    throw new Error("Feishu resource URL does not contain a supported resource token.");
  }

  return {
    token: decodeURIComponent(token),
    type: RESOURCE_PATH_TYPES[kind] ?? expectedType,
    sourceUrl: url.toString()
  };
}

export function findFeishuResourceReferences(text: string): FeishuResourceReference[] {
  const matches = text.match(/https:\/\/[^\s<>()\[\]{}"']+/gu) ?? [];
  const references: FeishuResourceReference[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const candidate = match.replace(/[.,;:!?，。；：！？]+$/u, "");
    try {
      const reference = parseFeishuResourceReference(candidate);
      const key = `${reference.type}:${reference.token}`;
      if (!seen.has(key)) {
        references.push(reference);
        seen.add(key);
      }
    } catch {
      // Non-Feishu and unsupported URLs remain ordinary command references.
    }
  }
  return references;
}
