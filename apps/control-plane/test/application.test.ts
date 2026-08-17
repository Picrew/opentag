import { RelayCapabilitiesResponseV1Schema } from "@opentag/control-protocol";
import { describe, expect, it, vi } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";

const capabilities = RelayCapabilitiesResponseV1Schema.parse({
  schemaVersion: 1,
  protocolVersion: "1.0",
  registryVersion: "opentag.control.capabilities/v1",
  capabilities: ["relay.readiness.v1"],
  minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
  deployment: { environment: "local", releaseSha: "local" },
  artifact: {
    packageName: "@opentag/control-plane",
    packageVersion: "0.0.0",
  },
});

describe("Control Plane Fetch application", () => {
  it("keeps liveness independent from database readiness", async () => {
    let readinessChecks = 0;
    const application = createControlPlaneApplication({
      capabilities,
      readiness: {
        async check() {
          readinessChecks += 1;
          return { ready: false, reason: "database_unavailable" };
        },
      },
    });

    const response = await application.fetch(new Request("http://control.test/healthz"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(readinessChecks).toBe(0);
  });

  it("fails readiness closed without leaking dependency details", async () => {
    const application = createControlPlaneApplication({
      capabilities,
      readiness: {
        async check() {
          return { ready: false, reason: "database_unavailable" };
        },
      },
    });

    const response = await application.fetch(new Request("http://control.test/readyz"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      reason: "database_unavailable",
    });
  });

  it("serves canonical anonymous Control V1 capabilities", async () => {
    const application = createControlPlaneApplication({
      capabilities,
      readiness: {
        async check() {
          return { ready: true };
        },
      },
    });

    const response = await application.fetch(
      new Request("http://control.test/v1/relay/capabilities"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(capabilities);
    expect(RelayCapabilitiesResponseV1Schema.safeParse(body).success).toBe(true);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("prevents caching authenticated console and secret responses", async () => {
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      console: {
        publicOrigin: "http://control.test",
        identity: {} as never,
        reads: {} as never,
      },
    });

    const response = await application.fetch(
      new Request("http://control.test/api/console/session"),
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("returns a bounded retry response when console login is throttled", async () => {
    let observedNetworkKey: string | undefined;
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      console: {
        publicOrigin: "http://control.test",
        identity: {
          login: async (command: { networkKey?: string }) => {
            observedNetworkKey = command.networkKey;
            return {
              kind: "rate_limited" as const,
              retryAfterMs: 120_000,
            };
          },
        } as never,
        reads: {} as never,
      },
    });
    const response = await application.fetch(new Request(
      "http://control.test/api/console/session",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://control.test",
        },
        body: JSON.stringify({
          email: "owner@example.test",
          password: "wrong password value",
        }),
      },
    ));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(observedNetworkKey).toBe("direct-fetch");
  });

  it("never trusts forwarded client addresses and disables the network bucket behind a trusted edge", async () => {
    let observedNetworkKey: string | undefined;
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      console: {
        publicOrigin: "https://control.test",
        loginNetworkMode: "trusted-edge",
        identity: {
          login: async (command: { networkKey?: string }) => {
            observedNetworkKey = command.networkKey;
            return { kind: "invalid_credential" as const };
          },
        } as never,
        reads: {} as never,
      },
    });
    const response = await application.fetch(new Request(
      "https://control.test/api/console/session",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://control.test",
          "x-forwarded-for": "198.51.100.22",
          "cf-connecting-ip": "198.51.100.23",
        },
        body: JSON.stringify({
          email: "owner@example.test",
          password: "wrong password value",
        }),
      },
    ));

    expect(response.status).toBe(401);
    expect(observedNetworkKey).toBeUndefined();
  });

  it("returns a bounded JSON 404 for an unknown API path", async () => {
    const application = createControlPlaneApplication({
      capabilities,
      readiness: {
        async check() {
          return { ready: true };
        },
      },
    });

    const response = await application.fetch(new Request("http://control.test/v1/unknown"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Route not found." },
    });
  });

  it("does not misclassify unexpected console failures as client errors", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretCanaries = [
      "postgresql://operator:database-secret@db/private",
      "Bearer github-token-secret",
      "eyJhbGciOiJIUzI1NiJ9.jwt-secret",
      "-----BEGIN PRIVATE KEY-----private-key-secret",
    ];
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      console: {
        publicOrigin: "http://control.test",
        identity: {
          authenticateSession: async () => ({
            kind: "authenticated" as const,
            principal: {
              operatorId: "operator_1",
              organizationId: "org_1",
              role: "owner" as const,
              email: "owner@example.test",
              displayName: "Owner",
            },
          }),
        } as never,
        reads: {} as never,
        targets: {
          declareProjectTarget: async () => {
            throw new Error(secretCanaries.join(" "));
          },
        },
      },
    });

    const response = await application.fetch(new Request(
      "http://control.test/api/console/project-targets",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "opentag_session=session_1",
          origin: "http://control.test",
        },
        body: JSON.stringify({
          projectTargetId: "target_1",
          runnerId: "runner_1",
          bindingDigest: `sha256:${"a".repeat(64)}`,
          provider: "github",
          owner: "amplifthq",
          repo: "opentag",
          defaultExecutor: "codex",
          defaultBranch: "main",
          version: 1,
        }),
      },
    ));
    const body = await response.json() as {
      error: string;
      requestId: string;
    };

    expect(response.status).toBe(500);
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    for (const canary of secretCanaries) {
      expect(JSON.stringify(body)).not.toContain(canary);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(canary);
    }
    expect(errorLog).toHaveBeenCalledWith(
      "control_plane_request_failed",
      expect.objectContaining({
        method: "POST",
        path: "/api/console/project-targets",
        classification: "unexpected_error",
      }),
    );
    errorLog.mockRestore();
  });

  it("preserves raw GitHub webhook bytes and keeps ingress disabled by omission", async () => {
    const rawBody = '{"body":"line\\nfeed"}';
    const receive = vi.fn(async () => ({ kind: "accepted" as const, runId: "run_1" }));
    const base = {
      capabilities,
      readiness: { check: async () => ({ ready: true as const }) },
    };
    const disabled = createControlPlaneApplication(base);
    expect((await disabled.fetch(new Request(
      "http://control.test/v1/providers/github/webhooks/binding_1",
      { method: "POST", body: rawBody },
    ))).status).toBe(404);

    const enabled = createControlPlaneApplication({
      ...base,
      github: {
        receive,
      },
    });
    const response = await enabled.fetch(new Request(
      "http://control.test/v1/providers/github/webhooks/binding_1",
      {
        method: "POST",
        headers: {
          "x-github-delivery": "delivery_1",
          "x-github-event": "issue_comment",
          "x-hub-signature-256": `sha256:${"a".repeat(64)}`,
        },
        body: rawBody,
      },
    ));
    expect(response.status).toBe(202);
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: "binding_1",
      body: new TextEncoder().encode(rawBody),
      deliveryId: "delivery_1",
      eventName: "issue_comment",
    }));
  });

  it("accepts GitHub deliveries above the generic Control V1 body limit", async () => {
    const rawBody = JSON.stringify({ body: "x".repeat(300 * 1024) });
    const receive = vi.fn(async () => ({
      kind: "evidence_recorded" as const,
    }));
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      github: { receive },
    });

    const response = await application.fetch(new Request(
      "http://control.test/v1/providers/github/webhooks/binding_large",
      {
        method: "POST",
        headers: {
          "x-github-delivery": "delivery_large",
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256:${"a".repeat(64)}`,
        },
        body: rawBody,
      },
    ));

    expect(response.status).toBe(202);
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ byteLength: expect.any(Number) }),
    }));
    expect(receive.mock.calls[0]?.[0].body.byteLength).toBeGreaterThan(
      256 * 1024,
    );
  });

  it("rejects GitHub deliveries above the dedicated webhook limit", async () => {
    const receive = vi.fn();
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      github: { receive },
    });
    const response = await application.fetch(new Request(
      "http://control.test/v1/providers/github/webhooks/binding_too_large",
      {
        method: "POST",
        headers: {
          "content-length": String(10 * 1024 * 1024 + 1),
          "x-github-delivery": "delivery_too_large",
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256:${"a".repeat(64)}`,
        },
        body: "{}",
      },
    ));

    expect(response.status).toBe(413);
    expect(receive).not.toHaveBeenCalled();
  });
});
