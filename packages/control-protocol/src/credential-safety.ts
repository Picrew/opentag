const CREDENTIAL_NAME_PATTERN = /(?:^|[_-])(?:auth(?:orization|entication)?|bearer|cookie|credential|password|passphrase|private[_-]?key|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|session|signature|signed)(?:$|[_-])/iu;
const KNOWN_TOKEN_PATTERN = /(?:\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}\b|\bglpat-[A-Za-z0-9_-]{8,}\b|\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{8,}\b|\bsk_(?:live|test)_[A-Za-z0-9_-]{8,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b)/u;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu;
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:authorization|authentication|cookie|credential|password|passphrase|private[ _-]?key|secret|token|api[ _-]?key|access[ _-]?key|client[ _-]?secret|refresh[ _-]?token|signature)\s*[:=]\s*\S+/iu;
const SAFE_DISPLAY_RESOURCE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:", "git+http:", "git+https:", "git+ssh:"]);
const PRIVATE_KEY_BEGIN_PREFIX = "-----BEGIN ";
const PRIVATE_KEY_END_PREFIX = "-----END ";

type PrivateKeyBoundary = {
  kind: "begin" | "end";
  start: number;
  end: number;
};

function isPrivateKeyLabel(value: string): boolean {
  if (!value.endsWith("PRIVATE KEY")) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character !== " " && !(code >= 48 && code <= 57) && !(code >= 65 && code <= 90)) return false;
  }
  return true;
}

function privateKeyBoundaryAt(value: string, start: number, kind: "begin" | "end"): PrivateKeyBoundary | null {
  const prefix = kind === "begin" ? PRIVATE_KEY_BEGIN_PREFIX : PRIVATE_KEY_END_PREFIX;
  const labelStart = start + prefix.length;
  const labelEnd = value.indexOf("-----", labelStart);
  if (labelEnd < 0 || !isPrivateKeyLabel(value.slice(labelStart, labelEnd))) return null;
  return { kind, start, end: labelEnd + 5 };
}

function privateKeyBoundaries(value: string): PrivateKeyBoundary[] {
  const boundaries: PrivateKeyBoundary[] = [];
  let searchFrom = 0;
  let nextBegin = value.indexOf(PRIVATE_KEY_BEGIN_PREFIX, searchFrom);
  let nextEnd = value.indexOf(PRIVATE_KEY_END_PREFIX, searchFrom);
  while (nextBegin >= 0 || nextEnd >= 0) {
    const kind = nextEnd < 0 || (nextBegin >= 0 && nextBegin < nextEnd) ? "begin" : "end";
    const start = kind === "begin" ? nextBegin : nextEnd;
    const boundary = privateKeyBoundaryAt(value, start, kind);
    searchFrom = boundary?.end ?? start + 5;
    if (boundary) boundaries.push(boundary);
    if (nextBegin >= 0 && nextBegin < searchFrom) nextBegin = value.indexOf(PRIVATE_KEY_BEGIN_PREFIX, searchFrom);
    if (nextEnd >= 0 && nextEnd < searchFrom) nextEnd = value.indexOf(PRIVATE_KEY_END_PREFIX, searchFrom);
  }
  return boundaries;
}

function redactPrivateKeyMaterial(value: string): string {
  const boundaries = privateKeyBoundaries(value);
  const nextEndByIndex = new Array<number>(boundaries.length).fill(-1);
  let nextEnd = -1;
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    nextEndByIndex[index] = nextEnd;
    if (boundaries[index]!.kind === "end") nextEnd = index;
  }

  const output: string[] = [];
  let cursor = 0;
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]!;
    if (boundary.kind !== "begin" || boundary.start < cursor) continue;
    const endIndex = nextEndByIndex[index]!;
    output.push(value.slice(cursor, boundary.start));
    if (endIndex >= 0) {
      const endBoundary = boundaries[endIndex]!;
      output.push("[redacted private key]");
      cursor = endBoundary.end;
    } else {
      output.push("[redacted private key]");
      cursor = value.length;
    }
  }
  output.push(value.slice(cursor));
  return output.join("");
}

export function isCredentialFieldName(value: string): boolean {
  const normalized = value.trim().replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  return CREDENTIAL_NAME_PATTERN.test(`_${normalized}_`) || /^(?:x-amz|x-goog|x-oss|x-ms)-(?:credential|signature|security-token|algorithm)$/u.test(normalized);
}

export function containsCredentialLikeData(value: string): boolean {
  if (KNOWN_TOKEN_PATTERN.test(value) || JWT_PATTERN.test(value) || BEARER_PATTERN.test(value) ||
    privateKeyBoundaries(value).some((boundary) => boundary.kind === "begin") || CREDENTIAL_ASSIGNMENT_PATTERN.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    for (const [key, queryValue] of url.searchParams) {
      if (isCredentialFieldName(key) || KNOWN_TOKEN_PATTERN.test(queryValue) || JWT_PATTERN.test(queryValue) || BEARER_PATTERN.test(queryValue)) return true;
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return true;
    }
    return KNOWN_TOKEN_PATTERN.test(decodedPath) || JWT_PATTERN.test(decodedPath) || BEARER_PATTERN.test(decodedPath) || CREDENTIAL_ASSIGNMENT_PATTERN.test(decodedPath);
  } catch {
    return false;
  }
}

export function isCredentialSafeText(value: string): boolean {
  return !containsCredentialLikeData(value);
}

export function isCredentialSafeDisplayResource(value: string): boolean {
  if (!isCredentialSafeText(value)) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return true;
  try {
    const url = new URL(value);
    return SAFE_DISPLAY_RESOURCE_PROTOCOLS.has(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isCredentialSafeValue(value: unknown): boolean {
  if (typeof value === "string") return isCredentialSafeText(value);
  if (Array.isArray(value)) return value.every(isCredentialSafeValue);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .every(([key, child]) => !isCredentialFieldName(key) && isCredentialSafeValue(child));
  }
  return value === null || value === undefined || typeof value === "number" || typeof value === "boolean";
}

export function redactCredentialLikeData(value: string): string {
  return redactPrivateKeyMaterial(value)
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}\b/gu, "[redacted]")
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .replace(/\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{8,}\b/gu, "[redacted]")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [redacted]")
    .replace(/((?:authorization|authentication|cookie|credential|password|passphrase|private[ _-]?key|secret|token|api[ _-]?key|access[ _-]?key|client[ _-]?secret|refresh[ _-]?token|signature)\s*[:=]\s*)\S+/giu, "$1[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu, "$1");
}

export type CredentialSafetyOptions = {
  /** Runtime-only opaque values, such as the active attempt fencing token. */
  secrets?: readonly string[];
};

export function sanitizeCredentialLikeValue<T>(value: T, options: CredentialSafetyOptions = {}): T {
  const secrets = [...new Set(options.secrets?.filter((secret) => secret.length > 0) ?? [])];

  function sanitize(child: unknown): unknown {
    if (typeof child === "string") {
      const withoutRuntimeSecrets = secrets.reduce(
        (safe, secret) => safe.split(secret).join("[redacted]"),
        child
      );
      return redactCredentialLikeData(withoutRuntimeSecrets);
    }
    if (Array.isArray(child)) return child.map((entry) => sanitize(entry));
    if (child && typeof child === "object") {
      return Object.fromEntries(
        Object.entries(child as Record<string, unknown>)
          .filter(([key]) => !isCredentialFieldName(key))
          .map(([key, entry]) => [key, sanitize(entry)])
      );
    }
    return child;
  }

  return sanitize(value) as T;
}
