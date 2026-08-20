import { describe, expect, it, vi } from "vitest";
import type { OpenTagDaemonConfig } from "../src/index.js";
import {
  createDaemonClient,
  createDaemonRuntimeInput,
  pullRequestOptionsFromConfig,
  serveDaemon,
} from "../src/index.js";

const pairedConfig: OpenTagDaemonConfig = {
  runnerId: "runner_hosted",
  dispatcherUrl: "https://control.example",
  repositories: [],
  agents: {},
  scratchRoot: "/tmp/opentag-scratch",
  keepScratch: "on_failure",
  approvalMode: "auto",
  runnerToken: "runtime_token",
  trustedRelay: {
    schemaVersion: 1,
    origin: "https://control.example",
    authorizedAt: "2026-08-08T00:00:00.000Z",
    authorizationMethod: "explicit_cli",
  },
  controlRegistration: {
    kind: "hosted_control_v1",
    state: "paired",
    operationId: "operation_pair_1",
    registration: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      organizationId: "org_1",
      runnerId: "runner_hosted",
      registrationGeneration: 1,
      credentialGeneration: 1,
      credentialId: "credential_runtime_1",
      credentialPurpose: "runtime",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
  },
  pollIntervalMs: 1,
  heartbeatIntervalMs: 15_000,
};

describe("local-runtime public authority boundary", () => {
  it("accepts the non-persisted E2E GitHub origin only for the sentinel Hosted Control runtime", async () => {
    const config = {
      ...pairedConfig,
      githubToken: "opentag_e2e_no_provider_credential_v1",
    };
    expect(pullRequestOptionsFromConfig(config)).toBeUndefined();
    const runtime = createDaemonRuntimeInput(config, {
      databasePath: ":memory:",
      githubApiOrigin: "http://127.0.0.1:43123",
    });
    expect(runtime.mode).toBe("control-v1-sidecar");
    if (runtime.mode === "control-v1-sidecar") {
      await runtime.controlLoop.close();
    }
  });

  it("rejects E2E GitHub origins outside Hosted Control without exposing values", () => {
    const { controlRegistration: _registration, ...legacyConfig } = pairedConfig;
    const apiOrigin = "http://127.0.0.1:43123";
    expect(() => createDaemonRuntimeInput(legacyConfig, { githubApiOrigin: apiOrigin }))
      .toThrow(/requires paired Hosted Control V1/u);
    expect(() => createDaemonRuntimeInput({
      ...pairedConfig,
      githubToken: "opentag_e2e_no_provider_credential_v1",
    }, {
      databasePath: ":memory:",
      githubApiOrigin: "",
    })).toThrow("github_source_api_origin_invalid");

    const token = "real_provider_secret";
    try {
      createDaemonRuntimeInput({ ...pairedConfig, githubToken: token }, {
        databasePath: ":memory:",
        githubApiOrigin: apiOrigin,
      });
      throw new Error("expected E2E origin rejection");
    } catch (error) {
      const loggable = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      expect(loggable).toContain("github_source_api_origin_invalid");
      expect(loggable).not.toContain(token);
      expect(loggable).not.toContain(apiOrigin);
    }
  });

  it("rejects a legacy claim-capable client for paired Control V1 config", () => {
    expect(() => createDaemonClient(pairedConfig)).toThrow(
      /does not expose a legacy claim-capable daemon client/iu
    );
  });

  it("rejects a legacy runtime carrying a HostedControlLoop even through any", async () => {
    await expect(serveDaemon({
      mode: "legacy",
      runnerId: "runner_legacy",
      repositories: [],
      executors: {},
      client: { claim: vi.fn() },
      controlLoop: {
        async beforeIteration() { return true; },
        async afterIteration() {},
        abort() {},
        async close() {},
      },
    } as any)).rejects.toThrow(/forbids a HostedControlLoop/iu);
  });

  it("rejects a Control V1 sidecar missing its HostedControlLoop even through any", async () => {
    await expect(serveDaemon({
      mode: "control-v1-sidecar",
    } as any)).rejects.toThrow(/requires a HostedControlLoop/iu);
  });

  it("rejects the removed boolean authority boundary without claiming", async () => {
    const claim = vi.fn(async () => null);
    await expect(serveDaemon({
      mode: "legacy",
      controlV1SidecarOnly: true,
      runnerId: "runner_legacy",
      repositories: [],
      executors: {},
      client: { claim },
    } as any)).rejects.toThrow(/not a valid authority boundary/iu);
    expect(claim).not.toHaveBeenCalled();
  });

  it("runs a valid Control V1 sidecar without exposing or invoking claim", async () => {
    const abort = new AbortController();
    const claim = vi.fn();
    const events: string[] = [];
    await serveDaemon({
      mode: "control-v1-sidecar",
      pollIntervalMs: 1,
      signal: abort.signal,
      controlLoop: {
        async beforeIteration() {
          events.push("before");
          abort.abort();
          return true;
        },
        async afterIteration() { events.push("after"); },
        abort() { events.push("abort"); },
        async close() { events.push("close"); },
      },
    });
    expect(claim).not.toHaveBeenCalled();
    expect(events).toEqual(["before", "abort", "after", "close"]);
  });

  it("immediately continues the Control V1 sidecar after useful work", async () => {
    const abort = new AbortController();
    let iterations = 0;
    const safetyAbort = setTimeout(() => abort.abort(), 100);
    try {
      await serveDaemon({
        mode: "control-v1-sidecar",
        pollIntervalMs: 60_000,
        signal: abort.signal,
        controlLoop: {
          async beforeIteration() {
            iterations += 1;
            if (iterations === 2) abort.abort();
            return true;
          },
          async afterIteration() {},
          abort() {},
          async close() {},
        },
      });
    } finally {
      clearTimeout(safetyAbort);
    }

    expect(iterations).toBe(2);
  });

  it("keeps the valid legacy claim loop unchanged", async () => {
    const abort = new AbortController();
    const claim = vi.fn(async () => {
      abort.abort();
      return null;
    });
    await serveDaemon({
      mode: "legacy",
      runnerId: "runner_legacy",
      repositories: [],
      executors: {},
      pollIntervalMs: 1,
      signal: abort.signal,
      client: {
        claim,
        async markRunning() {},
        async heartbeat() {},
        async progress() {},
        async complete() {},
        async requestActionPermission() { throw new Error("should not run"); },
        async resolveActionPermission() { throw new Error("should not run"); },
        async recordMaterialActionReceipt() { throw new Error("should not run"); },
      },
    });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("polls independent legacy workers up to the configured concurrency", async () => {
    const abort = new AbortController();
    let enteredClaims = 0;
    let releaseClaims!: () => void;
    const claimsReleased = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    const claim = vi.fn(async () => {
      enteredClaims += 1;
      if (enteredClaims === 3) {
        abort.abort();
        releaseClaims();
      }
      await claimsReleased;
      return null;
    });

    await serveDaemon({
      mode: "legacy",
      runnerId: "runner_parallel",
      repositories: [],
      executors: {},
      maxConcurrentRuns: 3,
      pollIntervalMs: 60_000,
      signal: abort.signal,
      client: {
        claim,
        async markRunning() {},
        async heartbeat() {},
        async progress() {},
        async complete() {},
        async requestActionPermission() { throw new Error("should not run"); },
        async resolveActionPermission() { throw new Error("should not run"); },
        async recordMaterialActionReceipt() { throw new Error("should not run"); }
      }
    });

    expect(claim).toHaveBeenCalledTimes(3);
  });
});
