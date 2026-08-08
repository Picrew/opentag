import { describe, expect, it, vi } from "vitest";
import { probeControlV1Capabilities } from "../src/health.js";

const exactControlV1 = {
  schemaVersion: 1,
  protocolVersion: "1.0",
  registryVersion: "opentag.control.capabilities/v1",
  capabilities: ["relay.registration.v1"],
  minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
  deployment: {
    environment: "test",
    releaseSha: "0123456789abcdef0123456789abcdef01234567"
  }
};

async function probe(fetchImpl: typeof fetch) {
  return probeControlV1Capabilities({
    dispatcherUrl: "https://relay.example",
    fetchImpl,
    timeoutMs: 10
  });
}

describe("strict Control V1 capability probing", () => {
  it("accepts an exact Control V1 document", async () => {
    await expect(probe(vi.fn(async () => Response.json(exactControlV1)) as unknown as typeof fetch))
      .resolves.toMatchObject({ status: "control_v1", capabilities: exactControlV1 });
  });

  it("classifies an explicit legacy relay document without treating it as malformed Control V1", async () => {
    await expect(probe(vi.fn(async () => Response.json({ schemaVersion: 1, relay: true, platforms: [] })) as unknown as typeof fetch))
      .resolves.toEqual({ status: "not_control_v1" });
  });

  it("classifies a Control-looking malformed document as incompatible", async () => {
    await expect(probe(vi.fn(async () => Response.json({ ...exactControlV1, deployment: {} })) as unknown as typeof fetch))
      .resolves.toMatchObject({ status: "incompatible_control", reason: expect.stringContaining("malformed") });
  });

  it("classifies unsupported Control versions as incompatible", async () => {
    await expect(probe(vi.fn(async () => Response.json({ ...exactControlV1, protocolVersion: "2.0" })) as unknown as typeof fetch))
      .resolves.toMatchObject({ status: "incompatible_control", reason: expect.stringContaining("incompatible") });
  });

  it.each([
    ["protocolVersion", { protocolVersion: "2.0" }],
    ["registryVersion", { registryVersion: "opentag.control.capabilities/v2" }],
    ["minimumClient", { minimumClient: { schemaVersion: 1, protocolVersion: "2.0" } }],
    ["deployment", { deployment: {} }]
  ])("does not downgrade a hybrid legacy + malformed Control document with %s", async (_field, override) => {
    const hybrid = {
      schemaVersion: 1,
      relay: true,
      platforms: [],
      ...exactControlV1,
      ...override
    };
    await expect(probe(vi.fn(async () => Response.json(hybrid)) as unknown as typeof fetch))
      .resolves.toMatchObject({ status: "incompatible_control" });
  });

  it.each([404, 503])("classifies HTTP %s as unavailable", async (status) => {
    await expect(probe(vi.fn(async () => new Response("no", { status })) as unknown as typeof fetch))
      .resolves.toEqual({ status: "unavailable", reason: `HTTP ${status}` });
  });

  it("classifies a non-JSON response as unavailable", async () => {
    await expect(probe(vi.fn(async () => new Response("not json")) as unknown as typeof fetch))
      .resolves.toEqual({ status: "unavailable", reason: "capabilities response was not JSON" });
  });

  it("classifies timeout/transport failure as unavailable", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;
    await expect(probe(fetchImpl)).resolves.toEqual({ status: "unavailable", reason: "aborted" });
  });
});
