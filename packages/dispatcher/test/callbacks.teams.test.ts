import { describe, expect, it, vi } from "vitest";
import { createTeamsCallbackSink } from "../src/callbacks.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const threadKey = "https://smba.example.com|19:conv@thread.tacv2|act-1";
const encodedConversationId = "19%3Aconv%40thread.tacv2";
const uri = "https://smba.example.com";

describe("createTeamsCallbackSink", () => {
  it("posts the first message then edits the same activity for later updates", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return jsonResponse({ access_token: "tok", expires_in: 3600 });
      if (init?.method === "POST") return jsonResponse({ id: "reply-1" }, 201);
      if (init?.method === "PUT") return jsonResponse({}, 200);
      return jsonResponse({}, 200);
    });
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl: fetchImpl as unknown as typeof fetch });

    await sink.deliver({
      runId: "run_1",
      kind: "acknowledgement",
      provider: "teams",
      uri,
      threadKey,
      body: "Received. OpenTag is working.\nRun: run_1"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "teams",
      uri,
      threadKey,
      body: "Finished with success.\n\ndone"
    });

    const connectorCalls = fetchImpl.mock.calls.filter(([callUrl]) => String(callUrl).includes("/v3/conversations/"));
    expect(connectorCalls).toHaveLength(2);
    expect(connectorCalls[0]?.[1]?.method).toBe("POST");
    expect(connectorCalls[1]?.[1]?.method).toBe("PUT");
    expect(String(connectorCalls[0]?.[0])).toContain(`/v3/conversations/${encodedConversationId}/activities`);
    expect(String(connectorCalls[1]?.[0])).toContain("/activities/reply-1");
  });

  it("classifies an authoritative 4xx connector response as rejected", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/oauth2/")) return jsonResponse({ access_token: "tok", expires_in: 3600 });
      return new Response("forbidden", { status: 403 });
    });
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      sink.deliver({ runId: "run_x", kind: "acknowledgement", provider: "teams", uri, threadKey, body: "ack" })
    ).resolves.toEqual({ handled: true, outcome: "rejected", reasonCode: "provider_rejected" });
  });

  it("does not issue a second write after an earlier provider result is unknown", async () => {
    let connectorCalls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return jsonResponse({ access_token: "tok", expires_in: 3600 });
      connectorCalls += 1;
      if (connectorCalls === 1) return new Response("boom", { status: 500 });
      return jsonResponse({ id: "reply-2" }, 201);
    });
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl: fetchImpl as unknown as typeof fetch });

    // Start the second delivery before the first settles so it chains onto the failing one.
    const first = sink.deliver({ runId: "run_2", kind: "progress", provider: "teams", uri, threadKey, body: "first" });
    const second = sink.deliver({ runId: "run_2", kind: "final", provider: "teams", uri, threadKey, body: "second" });
    const results = await Promise.allSettled([first, second]);

    expect(results).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" })
    ]);
    expect(connectorCalls).toBe(1);
  });

  it("replays an unknown edit result without issuing another provider write", async () => {
    let connectorCalls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return jsonResponse({ access_token: "tok", expires_in: 3600 });
      connectorCalls += 1;
      if (connectorCalls === 1 && init?.method === "POST") return jsonResponse({ id: "reply-1" }, 201);
      if (connectorCalls === 2 && init?.method === "PUT") return new Response("boom", { status: 500 });
      if (connectorCalls === 3 && init?.method === "POST") return jsonResponse({ id: "reply-2" }, 201);
      return jsonResponse({}, 200);
    });
    const sink = createTeamsCallbackSink({
      appId: "app",
      appPassword: "s",
      producerId: "runner_local_1",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await sink.deliver({ runId: "run_cleanup", kind: "acknowledgement", provider: "teams", uri, threadKey, body: "ack" });
    const unknown = {
      handled: true,
      outcome: "outcome_unknown",
      reasonCode: "provider_timeout",
      nextAction: "reconcile-provider",
      owner: "runner_local_1"
    } as const;
    await expect(
      sink.deliver({ runId: "run_cleanup", kind: "final", provider: "teams", uri, threadKey, body: "final" })
    ).resolves.toEqual(unknown);
    await expect(
      sink.deliver({ runId: "run_cleanup", kind: "progress", provider: "teams", uri, threadKey, body: "later" })
    ).resolves.toEqual(unknown);

    const connectorRequests = fetchImpl.mock.calls.filter(([callUrl]) => String(callUrl).includes("/v3/conversations/"));
    expect(connectorRequests.map(([, init]) => init?.method)).toEqual(["POST", "PUT"]);
  });

  it("ignores non-Teams callback messages", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not call fetch");
    });
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      sink.deliver({ runId: "run_3", kind: "final", provider: "discord", uri, body: "done" })
    ).resolves.toEqual({ handled: false });
  });

  it("does nothing when credentials are not configured", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not call fetch");
    });
    const sink = createTeamsCallbackSink({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      sink.deliver({ runId: "run_4", kind: "acknowledgement", provider: "teams", uri, threadKey, body: "ack" })
    ).resolves.toEqual({ handled: false });
  });
});
