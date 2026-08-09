import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenTagDaemonConfig } from "../src/config.js";
import { createDaemonRuntimeInput, pullRequestOptionsFromConfig, securityFromConfig } from "../src/runtime.js";

const config: OpenTagDaemonConfig = {
  runnerId: "runner_local",
  dispatcherUrl: "http://localhost:3030",
  agents: {},
  scratchRoot: "/tmp/opentag-scratch",
  keepScratch: "on_failure",
  repositories: [
    {
      provider: "github",
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo",
      defaultExecutor: "codex",
      baseBranch: "main",
      pushRemote: "origin",
      keepWorktree: "on_failure"
    }
  ],
  security: {
    mode: "enforce",
    allowedWorkspaceRoot: "/tmp",
    allowUnsafePrompts: false,
    extraSafeEnv: ["OPENTAG_DEBUG"]
  },
  githubToken: "ghs_test",
  preparePullRequestBranch: true,
  allowAutoCreatePullRequest: true,
  pairingToken: "pairing_test",
  pollIntervalMs: 1000,
  heartbeatIntervalMs: 15000,
  runTimeoutMs: 30_000
};

const pairedConfig: OpenTagDaemonConfig = {
  ...config,
  runnerId: "runner_hosted",
  dispatcherUrl: "https://control.example",
  pairingToken: undefined,
  runnerToken: "runtime_token",
  repositories: [],
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
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opentagd runtime helpers", () => {
  it("normalizes configured runner security policy", () => {
    expect(securityFromConfig(config)).toEqual({
      mode: "enforce",
      allowedWorkspaceRoot: "/tmp",
      allowUnsafePrompts: false,
      extraSafeEnv: ["OPENTAG_DEBUG"]
    });
  });

  it("omits pull request options when GitHub PR creation is not configured", () => {
    const {
      githubToken: _githubToken,
      preparePullRequestBranch: _preparePullRequestBranch,
      allowAutoCreatePullRequest: _allowAutoCreatePullRequest,
      ...configWithoutPullRequests
    } = config;
    expect(pullRequestOptionsFromConfig(configWithoutPullRequests)).toBeUndefined();
  });

  it("creates reusable daemon runtime input from daemon config", () => {
    const input = createDaemonRuntimeInput(config);

    expect(input.runnerId).toBe("runner_local");
    expect(input.repositories).toEqual(config.repositories);
    expect(input.executors.echo.id).toBe("echo");
    expect(input.executors.codex.id).toBe("codex");
    expect(input.executors["claude-code"].id).toBe("claude-code");
    expect(input.security).toEqual(securityFromConfig(config));
    expect(input.pullRequestOptions).toEqual({ githubToken: "ghs_test", preparePullRequestBranch: true, allowAutoCreatePullRequest: true });
    expect(input.pollIntervalMs).toBe(1000);
    expect(input.heartbeatIntervalMs).toBe(15000);
    expect(input.runTimeoutMs).toBe(30_000);
    expect(input.client).toEqual({
      claim: expect.any(Function),
      markRunning: expect.any(Function),
      rejectAttemptStart: expect.any(Function),
      heartbeat: expect.any(Function),
      progress: expect.any(Function),
      complete: expect.any(Function),
      requestActionPermission: expect.any(Function),
      resolveActionPermission: expect.any(Function),
      recordMaterialActionReceipt: expect.any(Function)
    });
  });

  it("fails closed when a paired Control V1 runtime has no authoritative database path", () => {
    expect(() => createDaemonRuntimeInput(pairedConfig)).toThrow(
      /authoritative local dispatcher database path/iu
    );
  });

  it("creates and runs the paired Control V1 context/readiness sidecar with the supplied database path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentagd-control-v1-"));
    const databasePath = join(directory, "opentag.db");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      requests.push(`${init?.method ?? "GET"} ${new URL(requestUrl).pathname}`);
      const body = init?.method === "POST"
        ? JSON.parse(String(init.body))
        : {
            schemaVersion: 1,
            protocolVersion: "1.0",
            contextKind: "runner_control",
            organizationId: "org_1",
            runnerId: "runner_hosted",
            credentialId: "credential_runtime_1",
            registrationGeneration: 1,
            credentialGeneration: 1,
            capabilities: ["relay.readiness.v1"],
            targets: [],
            observedAt: new Date().toISOString(),
          };
      const response = new Response(JSON.stringify(body), {
        status: init?.method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(response, "url", { value: requestUrl });
      return response;
    }));

    const input = createDaemonRuntimeInput(pairedConfig, { databasePath });
    try {
      expect(input.mode).toBe("control-v1-sidecar");
      if (input.mode !== "control-v1-sidecar") {
        throw new Error("Expected a Control V1 sidecar runtime.");
      }
      expect(input).not.toHaveProperty("client");
      await expect(input.controlLoop.beforeIteration()).resolves.toBe(true);
      expect(requests).toEqual([
        "GET /v1/runners/runner_hosted/control-context",
        "POST /v1/runners/runner_hosted/readiness",
      ]);
    } finally {
      if (input.mode === "control-v1-sidecar") await input.controlLoop.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
