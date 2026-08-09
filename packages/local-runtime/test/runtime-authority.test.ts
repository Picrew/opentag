import { describe, expect, it, vi } from "vitest";
import type { OpenTagDaemonConfig } from "../src/index.js";
import {
  createDaemonClient,
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
});
