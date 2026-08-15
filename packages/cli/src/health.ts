import { RelayCapabilitiesResponseV1Schema } from "@opentag/control-protocol";

type RelayCapabilitiesResponseV1 = ReturnType<typeof RelayCapabilitiesResponseV1Schema.parse>;

export async function fetchWithTimeout(input: {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    return await fetchImpl(input.url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeDispatcherHealth(input: {
  dispatcherUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<boolean> {
  const healthUrl = `${input.dispatcherUrl.replace(/\/$/, "")}/healthz`;
  try {
    const response = await fetchWithTimeout({
      url: healthUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs: input.timeoutMs
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type RelayIngressRequirement = {
  provider: string;
  path: string;
  requireCallback?: boolean;
  requireApply?: boolean;
};

export type RelayPlatformCapability = {
  provider: string;
  ingress?: {
    enabled?: boolean;
    path?: string;
    reason?: string;
  };
  callback?: {
    enabled?: boolean;
    reason?: string;
  };
  apply?: {
    enabled?: boolean;
    reason?: string;
  };
  oauthInstall?: {
    enabled?: boolean;
    path?: string;
    reason?: string;
  };
};

export type RelayCapabilitiesDocument = {
  schemaVersion: 1;
  relay: true;
  platforms: RelayPlatformCapability[];
};

export type RelayCapabilitiesProbeResult =
  | {
      status: "available";
      capabilities: RelayCapabilitiesDocument;
    }
  | {
      status: "unknown";
      reason: string;
    };

export type ControlV1ProbeResult =
  | { status: "control_v1"; capabilities: RelayCapabilitiesResponseV1 }
  | { status: "not_control_v1" }
  | { status: "incompatible_control"; reason: string }
  | { status: "unavailable"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExplicitLegacyCapabilitiesDocument(value: unknown): boolean {
  return isRecord(value)
    && value["schemaVersion"] === 1
    && value["relay"] === true
    && Array.isArray(value["platforms"]);
}

function looksLikeControlV1Document(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return ["protocolVersion", "registryVersion", "capabilities", "minimumClient", "deployment"]
    .some((key) => key in value);
}

function hasIncompatibleControlVersion(value: Record<string, unknown>): boolean {
  if ("schemaVersion" in value && value["schemaVersion"] !== 1) return true;
  if ("protocolVersion" in value && value["protocolVersion"] !== "1.0") return true;
  if (
    "registryVersion" in value
    && value["registryVersion"] !== "opentag.control.capabilities/v1"
  ) return true;
  const minimumClient = value["minimumClient"];
  return isRecord(minimumClient)
    && (minimumClient["schemaVersion"] !== 1 || minimumClient["protocolVersion"] !== "1.0");
}

export async function probeControlV1Capabilities(input: {
  dispatcherUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<ControlV1ProbeResult> {
  const capabilitiesUrl = `${input.dispatcherUrl.replace(/\/$/, "")}/v1/relay/capabilities`;
  let response: Response;
  try {
    response = await fetchWithTimeout({
      url: capabilitiesUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs: input.timeoutMs
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  if (!response.ok) {
    return { status: "unavailable", reason: `HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", reason: "capabilities response was not JSON" };
  }
  const parsed = RelayCapabilitiesResponseV1Schema.safeParse(body);
  if (parsed.success) return { status: "control_v1", capabilities: parsed.data };
  if (looksLikeControlV1Document(body)) {
    return {
      status: "incompatible_control",
      reason: hasIncompatibleControlVersion(body)
        ? "relay advertises an incompatible OpenTag Control version"
        : "relay returned a malformed OpenTag Control V1 capabilities document"
    };
  }
  if (isExplicitLegacyCapabilitiesDocument(body)) return { status: "not_control_v1" };
  return { status: "unavailable", reason: "capabilities response was not an OpenTag Control document" };
}

function parseRelayCapabilitiesDocument(value: unknown): RelayCapabilitiesDocument | null {
  if (!isRecord(value) || value["schemaVersion"] !== 1 || value["relay"] !== true || !Array.isArray(value["platforms"])) {
    return null;
  }
  const platforms: RelayPlatformCapability[] = [];
  for (const rawPlatform of value["platforms"]) {
    if (!isRecord(rawPlatform) || typeof rawPlatform["provider"] !== "string" || !rawPlatform["provider"].trim()) continue;
    const ingress = isRecord(rawPlatform["ingress"]) ? rawPlatform["ingress"] : undefined;
    const callback = isRecord(rawPlatform["callback"]) ? rawPlatform["callback"] : undefined;
    const apply = isRecord(rawPlatform["apply"]) ? rawPlatform["apply"] : undefined;
    const oauthInstall = isRecord(rawPlatform["oauthInstall"]) ? rawPlatform["oauthInstall"] : undefined;
    platforms.push({
      provider: rawPlatform["provider"],
      ...(ingress
        ? {
            ingress: {
              ...(typeof ingress["enabled"] === "boolean" ? { enabled: ingress["enabled"] } : {}),
              ...(typeof ingress["path"] === "string" ? { path: ingress["path"] } : {}),
              ...(typeof ingress["reason"] === "string" ? { reason: ingress["reason"] } : {})
            }
          }
        : {}),
      ...(callback
        ? {
            callback: {
              ...(typeof callback["enabled"] === "boolean" ? { enabled: callback["enabled"] } : {}),
              ...(typeof callback["reason"] === "string" ? { reason: callback["reason"] } : {})
            }
          }
        : {}),
      ...(apply
        ? {
            apply: {
              ...(typeof apply["enabled"] === "boolean" ? { enabled: apply["enabled"] } : {}),
              ...(typeof apply["reason"] === "string" ? { reason: apply["reason"] } : {})
            }
          }
        : {}),
      ...(oauthInstall
        ? {
            oauthInstall: {
              ...(typeof oauthInstall["enabled"] === "boolean" ? { enabled: oauthInstall["enabled"] } : {}),
              ...(typeof oauthInstall["path"] === "string" ? { path: oauthInstall["path"] } : {}),
              ...(typeof oauthInstall["reason"] === "string" ? { reason: oauthInstall["reason"] } : {})
            }
          }
        : {})
    });
  }
  return {
    schemaVersion: 1,
    relay: true,
    platforms
  };
}

export async function probeRelayCapabilities(input: {
  dispatcherUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<RelayCapabilitiesProbeResult> {
  const capabilitiesUrl = `${input.dispatcherUrl.replace(/\/$/, "")}/v1/relay/capabilities`;
  let response: Response;
  try {
    response = await fetchWithTimeout({
      url: capabilitiesUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs: input.timeoutMs
    });
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  if (!response.ok) {
    return {
      status: "unknown",
      reason: `HTTP ${response.status}`
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      status: "unknown",
      reason: "capabilities response was not JSON"
    };
  }

  const capabilities = parseRelayCapabilitiesDocument(body);
  return capabilities
    ? { status: "available", capabilities }
    : { status: "unknown", reason: "capabilities response did not match the OpenTag relay schema" };
}

export function evaluateRelayIngressCapability(
  capabilities: RelayCapabilitiesDocument,
  requirement: RelayIngressRequirement
): { ok: true } | { ok: false; reason: string } {
  const platform = capabilities.platforms.find((candidate) => candidate.provider === requirement.provider);
  if (!platform) {
    return { ok: false, reason: `${requirement.provider} is not listed in relay capabilities.` };
  }
  if (platform.ingress?.enabled !== true) {
    return { ok: false, reason: platform.ingress?.reason ?? `${requirement.provider} ingress is not enabled.` };
  }
  if (platform.ingress.path && platform.ingress.path !== requirement.path) {
    return {
      ok: false,
      reason: `${requirement.provider} ingress path is ${platform.ingress.path}, but config expects ${requirement.path}.`
    };
  }
  if (requirement.requireCallback && platform.callback?.enabled !== true) {
    return { ok: false, reason: platform.callback?.reason ?? `${requirement.provider} callback is not enabled.` };
  }
  if (requirement.requireApply && platform.apply?.enabled !== true) {
    return { ok: false, reason: platform.apply?.reason ?? `${requirement.provider} apply is not enabled.` };
  }
  return { ok: true };
}
