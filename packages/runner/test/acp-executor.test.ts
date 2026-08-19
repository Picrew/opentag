import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpExecutor, type AcpPermissionResolver } from "../src/acp-executor.js";
import type { CommandRunner } from "../src/command.js";

const fixture = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `opentag-acp-${name}-`));
  tempRoots.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(): string {
  const repo = tempDir("repo");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "opentag@example.test"]);
  git(repo, ["config", "user.name", "OpenTag Test"]);
  writeFileSync(join(repo, "README.md"), "# ACP test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function manifest(mode = "success") {
  return {
    protocol: "opentag.integration.v1" as const,
    id: "fixture-agent",
    label: "Fixture ACP Agent",
    bindings: {
      agent: {
        kind: "stdio" as const,
        command: process.execPath,
        args: [fixture, mode]
      }
    },
    roles: {
      agent: {
        protocol: "agent-client-protocol" as const,
        protocolVersion: 1 as const,
        binding: "agent",
        workspace: { sessionCwd: "required" as const }
      }
    },
    resources: {}
  };
}

function unverifiedManifest(mode = "success") {
  const configured = manifest(mode);
  return {
    ...configured,
    roles: {
      agent: {
        protocol: configured.roles.agent.protocol,
        protocolVersion: configured.roles.agent.protocolVersion,
        binding: configured.roles.agent.binding
      }
    }
  };
}

function manifestWithCwd(cwd: string, mode = "success") {
  const configured = manifest(mode);
  return {
    ...configured,
    bindings: {
      agent: {
        ...configured.bindings.agent,
        cwd
      }
    }
  };
}

function permissionManifest() {
  return manifest("permission");
}

function permissionWorkspace(name: string, config: Record<string, string>): string {
  const scratch = tempDir(name);
  writeFileSync(join(scratch, ".acp-test-config.json"), `${JSON.stringify(config)}\n`);
  return scratch;
}

function input(workspace: { kind: "repository" | "scratch"; path: string }, runId = "run_acp") {
  return {
    runId,
    workspace,
    command: { rawText: "prepare the report", intent: "run" as const, args: {} },
    context: [{ kind: "file", uri: "README.md", visibility: "private" as const, title: "Readme" }],
    contextPacket: {
      summary: "Only the selected readme is relevant.",
      conversationHistory: [
        {
          role: "user" as const,
          content: "Remember that the release color is indigo.",
          runId: "run_previous",
          occurredAt: "2026-08-19T12:00:00.000Z"
        },
        {
          role: "assistant" as const,
          content: "Noted: the release color is indigo.",
          runId: "run_previous",
          occurredAt: "2026-08-19T12:00:01.000Z"
        }
      ],
      sources: [
        {
          pointer: { kind: "file", uri: "README.md", visibility: "private" as const },
          role: "primary" as const,
          reason: "Explicitly selected"
        }
      ],
      exclusions: ["Do not inspect .env files"]
    },
    permissions: [{ scope: "github.repository.read", reason: "Read the selected repository" }],
    baseBranch: "main",
    keepWorktree: "never" as const
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processIsAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for process ${pid} to exit`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForJsonFile<T>(path: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for valid JSON in ${path}`, { cause: lastError });
}

describe("ACP executor", () => {
  it("derives workspace capability from the required manifest conformance declaration", () => {
    expect(createAcpExecutor({ manifest: manifest() }).capability).toMatchObject({
      writeAccess: "workspace",
      workspaceIsolation: "worktree",
      workspaceCwdConformance: "declared"
    });
  });

  it("rejects an ACP manifest before executor construction when session cwd conformance is undeclared", () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    expect(() =>
      createAcpExecutor({ manifest: unverifiedManifest() as never, runner: { run } })
    ).toThrow(/workspace/u);

    expect(run).not.toHaveBeenCalled();
  });

  it("proves ACP protocol initialization before reporting scratch readiness", async () => {
    const scratch = tempDir("readiness");
    const executor = createAcpExecutor({ manifest: manifest() });

    await expect(executor.canRun(input({ kind: "scratch", path: scratch }, "run_readiness"))).resolves.toEqual({ ready: true });
  });

  it("fails closed before ACP startup when a provider compatibility preflight rejects the runtime", async () => {
    const scratch = tempDir("preflight-rejected");
    const preflight = vi.fn(async () => ({
      ready: false as const,
      reason: "OpenClaw CLI 2026.7.1 is incompatible with the selected 2026.7.2 profile."
    }));
    const executor = createAcpExecutor({ manifest: manifest(), preflight });

    await expect(executor.canRun(input({ kind: "scratch", path: scratch }, "run_preflight_readiness"))).resolves.toEqual({
      ready: false,
      reason: "OpenClaw CLI 2026.7.1 is incompatible with the selected 2026.7.2 profile."
    });
    await expect(
      executor.run(input({ kind: "scratch", path: scratch }, "run_preflight_rejected"), { emit: async () => undefined })
    ).rejects.toThrow(/incompatible with the selected 2026\.7\.2 profile/u);
    expect(existsSync(join(scratch, "acp-session.json"))).toBe(false);
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it("reports an unavailable ACP adapter as not ready", async () => {
    const scratch = tempDir("readiness-missing");
    const configured = manifest();
    configured.bindings.agent.command = "definitely-missing-opentag-acp-readiness-executable";
    const executor = createAcpExecutor({ manifest: configured });

    const readiness = await executor.canRun(input({ kind: "scratch", path: scratch }, "run_readiness_missing"));

    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toMatch(/could not initialize the ACP adapter/iu);
  });

  it("preserves a bounded redacted readiness diagnostic for setup failures", async () => {
    const scratch = tempDir("readiness-diagnostic");
    const configured = manifest();
    configured.bindings.agent.args = [
      "--eval",
      "console.error('Authentication required for token sk_test_abcdefghijk'); process.exit(1)"
    ];
    const executor = createAcpExecutor({ manifest: configured });

    const readiness = await executor.canRun(input({ kind: "scratch", path: scratch }, "run_readiness_diagnostic"));

    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toMatch(/Authentication required/iu);
    expect(readiness.reason).not.toContain("sk_test_abcdefghijk");
  });

  it("streams normalized plan, tool, and message updates and commits repository changes", async () => {
    const repo = initRepo();
    const executor = createAcpExecutor({ manifest: manifest() });
    const events: string[] = [];

    const result = await executor.run(input({ kind: "repository", path: repo }), {
      emit: async (event) => void events.push(`${event.type}:${event.message}`)
    });

    expect(events.some((event) => event.includes("Plan: Complete the OpenTag run"))).toBe(true);
    expect(events.some((event) => event.includes("Tool: Write ACP output"))).toBe(true);
    expect(events.some((event) => event.includes("ACP fixture completed"))).toBe(true);
    expect(events.every((event) => !event.includes('"jsonrpc"'))).toBe(true);
    expect(result.conclusion).toBe("success");
    expect(result.changedFiles).toEqual(["acp-output.txt", "acp-prompt.json", "acp-session.json"]);
    expect(git(repo, ["show", "opentag/run_acp:acp-output.txt"])).toContain("ACP fixture");
    const prompt = JSON.parse(git(repo, ["show", "opentag/run_acp:acp-prompt.json"]));
    expect(prompt.text).toContain("prepare the report");
    expect(prompt.text).toContain("Conversation history (oldest to newest; the current command takes priority)");
    expect(prompt.text).toContain("User: Remember that the release color is indigo.");
    expect(prompt.text).toContain("Assistant: Noted: the release color is indigo.");
    expect(prompt.text).toContain("Do not inspect .env files");
    expect(prompt.text).toContain("github.repository.read");
    expect(prompt.text).not.toContain("Read the selected repository");
  }, 15_000);

  it.skipIf(process.platform === "win32")("does not signal a foreign process group after the ACP child exits", async () => {
    const scratch = tempDir("foreign-process-group");
    const executor = createAcpExecutor({ manifest: manifest(), cancelGraceMs: 100 });
    const originalKill = process.kill.bind(process);
    const foreignGroups = new Set<number>();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && foreignGroups.has(pid)) {
        const error = new Error("kill EPERM") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      try {
        return originalKill(pid, signal);
      } catch (error) {
        if (pid < 0 && error instanceof Error && "code" in error && error.code === "ESRCH") {
          foreignGroups.add(pid);
          const denied = new Error("kill EPERM") as NodeJS.ErrnoException;
          denied.code = "EPERM";
          throw denied;
        }
        throw error;
      }
    }) as typeof process.kill);

    try {
      await expect(
        executor.run(input({ kind: "scratch", path: scratch }, "run_foreign_process_group"), { emit: async () => undefined })
      ).resolves.toMatchObject({ conclusion: "success" });
    } finally {
      killSpy.mockRestore();
    }
  }, 15_000);

  it("reassembles ACP message chunks without inserting characters", async () => {
    const scratch = tempDir("chunked-output");
    const executor = createAcpExecutor({ manifest: manifest("chunked-output") });

    const result = await executor.run(input({ kind: "scratch", path: scratch }, "run_chunked_output"), {
      emit: async () => undefined
    });

    expect(result.summary).toContain("OPENTAG_CHUNK_OK");
    expect(result.summary).not.toContain("OPENTAG_\nCHUNK_OK");
  }, 15_000);

  it("selects a required ACP session mode before prompting", async () => {
    const scratch = tempDir("session-mode");
    const executor = createAcpExecutor({ manifest: manifest("session-mode"), sessionModeId: "default" });

    const result = await executor.run(input({ kind: "scratch", path: scratch }, "run_session_mode"), {
      emit: async () => undefined
    });

    expect(result.conclusion).toBe("success");
    expect(JSON.parse(readFileSync(join(scratch, "acp-session-mode.json"), "utf8"))).toEqual({ modeId: "default" });
  }, 15_000);

  it("maps allow-once approval to the matching ACP option", async () => {
    const scratch = tempDir("allow");
    const resolver: AcpPermissionResolver = async (request) => {
      expect(request.toolCall.title).toBe("Publish report");
      expect(request.options.map((option) => option.kind)).toContain("allow_once");
      return { decision: "allow_once" };
    };
    const executor = createAcpExecutor({ manifest: manifest("permission"), permissionResolver: resolver });

    await executor.run(input({ kind: "scratch", path: scratch }, "run_allow"), { emit: async () => undefined });

    expect(JSON.parse(readFileSync(join(scratch, "acp-permission.json"), "utf8"))).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" }
    });
  }, 15_000);

  it("never selects an allow option when OpenTag denies permission", async () => {
    const scratch = tempDir("deny");
    const executor = createAcpExecutor({
      manifest: manifest("permission"),
      permissionResolver: async () => ({ decision: "deny" })
    });

    await executor.run(input({ kind: "scratch", path: scratch }, "run_deny"), { emit: async () => undefined });

    expect(JSON.parse(readFileSync(join(scratch, "acp-permission.json"), "utf8"))).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" }
    });
  }, 15_000);

  it("pauses on the governed resolver and records an unverified ACP material outcome as unknown", async () => {
    const scratch = tempDir("governed");
    const reports: Array<{ actionId: string; outcome: string; receiptRef: string }> = [];
    const executor = createAcpExecutor({ manifest: manifest("permission") });

    await executor.run({
      ...input({ kind: "scratch", path: scratch }, "run_governed"),
      permissionResolver: async (request) => {
        expect(request).toMatchObject({
          toolCallId: "material-1",
          title: "Publish report",
          provider: "npm",
          targetFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
        });
        expect(JSON.stringify(request)).not.toContain("fixture-secret-token");
        return { actionId: "action_publish", decision: "allow_once", material: true };
      },
      materialActionReporter: async (report) => void reports.push(report)
    }, { emit: async () => undefined });

    expect(JSON.parse(readFileSync(join(scratch, "acp-permission.json"), "utf8"))).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" }
    });
    expect(reports).toEqual([
      expect.objectContaining({ actionId: "action_publish", outcome: "unknown", receiptRef: expect.stringContaining("material-1") })
    ]);
  }, 15_000);

  it("removes credential values from ACP target identity while retaining structured resource changes", async () => {
    const requests: Array<{ provider?: string; targetFingerprint?: string; connectionId?: string; operation?: string; resource?: string; resourceVersion?: string }> = [];
    for (const [index, env] of [
      { OPENTAG_ACP_TEST_SECRET: "secret-one", OPENTAG_ACP_TEST_RESOURCE: "@acme/report" },
      { OPENTAG_ACP_TEST_SECRET: "secret-two", OPENTAG_ACP_TEST_RESOURCE: "@acme/report" },
      { OPENTAG_ACP_TEST_SECRET: "secret-two", OPENTAG_ACP_TEST_RESOURCE: "@acme/other" }
    ].entries()) {
      const executor = createAcpExecutor({ manifest: permissionManifest() });
      await executor.run({
        ...input({ kind: "scratch", path: permissionWorkspace(`safe-target-${index}`, env) }, `run_safe_target_${index}`),
        permissionResolver: async (request) => {
          requests.push(request);
          return { actionId: `action_${index}`, decision: "allow_once", material: true };
        }
      }, { emit: async () => undefined });
    }

    expect(requests[0]).toMatchObject({
      provider: "npm",
      connectionId: "npm:team",
      operation: "execute",
      resource: "@acme/report",
      resourceVersion: "next"
    });
    expect(requests[0]?.targetFingerprint).toBe(requests[1]?.targetFingerprint);
    expect(requests[2]?.targetFingerprint).not.toBe(requests[1]?.targetFingerprint);
    expect(JSON.stringify(requests)).not.toContain("secret-one");
    expect(JSON.stringify(requests)).not.toContain("secret-two");
  }, 15_000);

  it("separates display URLs from canonical disclosed query constraints", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const resources = [
      "https://example.test/deploy?environment=staging&force=false",
      "https://example.test/deploy?force=false&environment=staging",
      "https://example.test/deploy?environment=production&force=false",
      "https://example.test/deploy?environment=staging&force=true"
    ];
    for (const [index, resource] of resources.entries()) {
      const executor = createAcpExecutor({ manifest: permissionManifest() });
      await executor.run({
        ...input({ kind: "scratch", path: permissionWorkspace(`query-identity-${index}`, { OPENTAG_ACP_TEST_RESOURCE: resource }) }, `run_query_identity_${index}`),
        permissionResolver: async (request) => {
          requests.push(request);
          return { actionId: `action_query_${index}`, decision: "allow_once", material: true };
        }
      }, { emit: async () => undefined });
    }
    expect(requests.map((request) => request["resource"])).toEqual(Array(4).fill("https://example.test/deploy"));
    expect(requests[0]?.["targetFingerprint"]).toBe(requests[1]?.["targetFingerprint"]);
    expect(requests[2]?.["targetFingerprint"]).not.toBe(requests[0]?.["targetFingerprint"]);
    expect(requests[3]?.["targetFingerprint"]).not.toBe(requests[0]?.["targetFingerprint"]);
    expect(requests[0]?.["targetConstraints"]).toEqual({
      queryMode: "canonical",
      reuse: "exact",
      urlQuery: { environment: "staging", force: "false" }
    });
  }, 20_000);

  it("strips signed URL credentials and marks credential or unclassified queries non-reusable", async () => {
    const requests: Array<Record<string, unknown>> = [];
    for (const [index, resource] of [
      "https://user:password@example.test/deploy?environment=staging&X-Amz-Signature=signed-secret#token",
      "https://example.test/deploy?custom_target=blue",
      "https://operator:password@example.test/deploy",
      "https://example test/deploy"
    ].entries()) {
      const executor = createAcpExecutor({ manifest: permissionManifest() });
      await executor.run({
        ...input({ kind: "scratch", path: permissionWorkspace(`query-deny-${index}`, { OPENTAG_ACP_TEST_RESOURCE: resource }) }, `run_query_deny_${index}`),
        permissionResolver: async (request) => {
          requests.push(request);
          return { actionId: `action_query_deny_${index}`, decision: "allow_once", material: true };
        }
      }, { emit: async () => undefined });
    }
    expect(requests[0]).toMatchObject({
      resource: "https://example.test/deploy",
      targetConstraints: { queryMode: "credential_stripped", reuse: "deny", urlQuery: { environment: "staging" } }
    });
    expect(requests[1]).toMatchObject({
      resource: "https://example.test/deploy",
      targetConstraints: { queryMode: "unclassified_exact", reuse: "deny", urlQuery: { custom_target: "blue" } }
    });
    expect(requests[2]).toMatchObject({
      resource: "https://example.test/deploy",
      targetConstraints: { resourceMode: "credential_stripped", reuse: "deny" }
    });
    expect(requests[3]).toMatchObject({
      targetConstraints: { resourceMode: "invalid_url", reuse: "deny" }
    });
    expect(requests[3]?.["resource"]).toBeUndefined();
    expect(JSON.stringify(requests)).not.toMatch(/password|operator|signed-secret|X-Amz-Signature|#token|example test/iu);
  }, 15_000);

  it("derives stable target fingerprints only from sanitized reusable identity", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const resources = [
      "https://first-user:first-password@example.test/deploy?environment=staging&access_token=first-secret#token=first",
      "https://second-user:second-password@example.test/deploy?environment=staging&access_token=second-secret#token=second",
      "https://example.test/deploy?custom_target=blue",
      "https://example.test/deploy?custom_target=green"
    ];
    for (const [index, resource] of resources.entries()) {
      const executor = createAcpExecutor({ manifest: permissionManifest() });
      await executor.run({
        ...input({ kind: "scratch", path: permissionWorkspace(`credential-safe-fingerprint-${index}`, { OPENTAG_ACP_TEST_RESOURCE: resource }) }, `run_credential_safe_fingerprint_${index}`),
        permissionResolver: async (request) => {
          requests.push(request);
          return { actionId: `action_credential_safe_fingerprint_${index}`, decision: "allow_once", material: true };
        }
      }, { emit: async () => undefined });
    }

    expect(requests[0]?.["targetFingerprint"]).toBe(requests[1]?.["targetFingerprint"]);
    expect(requests[2]?.["targetFingerprint"]).toBe(requests[3]?.["targetFingerprint"]);
    expect(requests.every((request) => request["resource"] === "https://example.test/deploy")).toBe(true);
    expect(JSON.stringify(requests)).not.toMatch(/resourceFingerprint|queryFingerprint|first-password|second-password|first-secret|second-secret/iu);
  }, 20_000);

  it("fingerprints generic ACP version, environment, force, visibility, and provider constraints exactly", async () => {
    const fingerprints: string[] = [];
    const variants: Array<Record<string, string>> = [
      {},
      { OPENTAG_ACP_TEST_VERSION: "stable" },
      { OPENTAG_ACP_TEST_ENVIRONMENT: "production" },
      { OPENTAG_ACP_TEST_FORCE: "true" },
      { OPENTAG_ACP_TEST_VISIBILITY: "public" },
      { OPENTAG_ACP_TEST_PROVIDER: "registry" }
    ];
    for (const [index, env] of variants.entries()) {
      const executor = createAcpExecutor({ manifest: permissionManifest() });
      await executor.run({
        ...input({ kind: "scratch", path: permissionWorkspace(`exact-generic-scope-${index}`, env) }, `run_exact_generic_scope_${index}`),
        permissionResolver: async (request) => {
          fingerprints.push(request.targetFingerprint!);
          return { actionId: `action_exact_${index}`, decision: "allow_once", material: true };
        }
      }, { emit: async () => undefined });
    }
    expect(new Set(fingerprints)).toHaveLength(variants.length);
  }, 20_000);

  it("normalizes URL resources and bounds structured target labels before policy or presentation", async () => {
    let captured: Record<string, unknown> | undefined;
    const executor = createAcpExecutor({ manifest: permissionManifest() });
    const workspace = permissionWorkspace("safe-url-target", {
      OPENTAG_ACP_TEST_RESOURCE: `https://user:password@example.test/reports/latest?access_token=secret#credential=${"x".repeat(600)}`,
      OPENTAG_ACP_TEST_CONNECTION: `npm:team\n${"x".repeat(300)}`,
      OPENTAG_ACP_TEST_VERSION: `next\t${"y".repeat(300)}`
    });
    await executor.run({
      ...input({ kind: "scratch", path: workspace }, "run_safe_url_target"),
      permissionResolver: async (request) => {
        captured = request;
        return { actionId: "action_safe_url", decision: "allow_once", material: true };
      }
    }, { emit: async () => undefined });

    expect(captured).toMatchObject({ provider: "npm", resource: "https://example.test/reports/latest" });
    expect(String(captured?.["connectionId"])).not.toMatch(/[\r\n]/u);
    expect(String(captured?.["connectionId"]).length).toBeLessThanOrEqual(128);
    expect(String(captured?.["resourceVersion"])).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(String(captured?.["resourceVersion"]).length).toBeLessThanOrEqual(128);
    expect(JSON.stringify(captured)).not.toContain("access_token");
    expect(JSON.stringify(captured)).not.toContain("password");
    expect(JSON.stringify(captured)).not.toContain("credential=");
  }, 15_000);

  it.each([
    ["ssh", "ssh://git:password@example.test/acme/report.git?token=secret#credential", "ssh://example.test/acme/report.git"],
    ["git+https", "git+https://user:password@example.test/acme/report.git?signature=secret#token", "git+https://example.test/acme/report.git"],
    ["signed https", "https://example.test/acme/report.git?X-Amz-Signature=secret&X-Amz-Credential=private", "https://example.test/acme/report.git"],
    ["ftp", "ftp://user:password@example.test/acme/report.git?token=secret", undefined],
    ["token path", "https://example.test/acme/token=secret/report.git", undefined]
  ])("sanitizes or rejects %s resource URLs before identity and presentation", async (_label, resource, expected) => {
    let captured: Record<string, unknown> | undefined;
    const executor = createAcpExecutor({ manifest: permissionManifest() });
    await executor.run({
      ...input({ kind: "scratch", path: permissionWorkspace(`safe-scheme-${_label}`, { OPENTAG_ACP_TEST_RESOURCE: resource }) }, `run_safe_scheme_${_label}`),
      permissionResolver: async (request) => {
        captured = request;
        return { actionId: `action_${_label}`, decision: "allow_once", material: true };
      }
    }, { emit: async () => undefined });
    expect(captured?.["resource"]).toBe(expected);
    expect(captured?.["targetFingerprint"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(captured)).not.toMatch(/password|token=|signature=|credential=|secret/iu);
  }, 15_000);

  it("redacts credential-like tool titles before progress or durable permission paths", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const progress: string[] = [];
    const executor = createAcpExecutor({ manifest: permissionManifest() });
    const workspace = permissionWorkspace("safe-title", {
      OPENTAG_ACP_TEST_TOOL_TITLE: "Write with password=hunter2",
      OPENTAG_ACP_TEST_PERMISSION_TITLE: "Publish with token=fixture-secret"
    });
    await executor.run({
      ...input({ kind: "scratch", path: workspace }, "run_safe_title"),
      permissionResolver: async (request) => {
        requests.push(request);
        return { actionId: "action_safe_title", decision: "allow_once", material: true };
      }
    }, { emit: async (update) => void progress.push(update.message) });
    expect(requests[0]?.["title"]).toBe("Sensitive tool action");
    expect(JSON.stringify({ requests, progress })).not.toMatch(/hunter2|fixture-secret|password=|token=/iu);
  }, 15_000);

  it("fails the Attempt after both durable unknown-report attempts fail", async () => {
    let reportAttempts = 0;
    const executor = createAcpExecutor({ manifest: manifest("permission") });
    await expect(executor.run({
      ...input({ kind: "scratch", path: tempDir("report-failure") }, "run_report_failure"),
      permissionResolver: async () => ({ actionId: "action_report_failure", decision: "allow_once", material: true }),
      materialActionReporter: async () => {
        reportAttempts += 1;
        throw new Error("dispatcher unavailable");
      }
    }, { emit: async () => undefined })).rejects.toThrow("dispatcher unavailable");
    expect(reportAttempts).toBe(2);
  }, 15_000);

  it.each(["allow_once", "allow_run"] as const)(
    "rejects a reconciled known-success permission even when the resolver returns %s",
    async (decision) => {
      const scratch = tempDir(`reconciled-${decision}`);
      const reports: unknown[] = [];
      const progress: string[] = [];
      const executor = createAcpExecutor({ manifest: manifest("permission") });

      await executor.run({
        ...input({ kind: "scratch", path: scratch }, `run_reconciled_${decision}`),
        permissionResolver: async () => ({
          actionId: "action_publish",
          decision,
          reconciled: true,
          material: true,
          receipt: { receiptRef: "npm:publish:pkg@1", outcome: "succeeded" }
        }),
        materialActionReporter: async (report) => void reports.push(report)
      }, { emit: async (event) => void progress.push(event.message) });

      expect(JSON.parse(readFileSync(join(scratch, "acp-permission.json"), "utf8"))).toEqual({
        outcome: { outcome: "selected", optionId: "reject-once" }
      });
      expect(progress).toContain("Material action action_publish already has a durable receipt; skipping duplicate execution.");
      expect(reports).toEqual([]);
    },
    15_000
  );

  it("sends ACP cancellation and terminates a bounded child run", async () => {
    const scratch = tempDir("cancel");
    const executor = createAcpExecutor({ manifest: manifest("cancel"), cancelGraceMs: 500 });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_cancel"), { emit: async () => undefined });
    await waitForFile(join(scratch, "acp-waiting.json"));

    await executor.cancel("run_cancel");
    const result = await running;

    expect(result.conclusion).toBe("cancelled");
    expect(existsSync(join(scratch, "acp-cancelled.json"))).toBe(true);
  }, 15_000);

  it("does not claim provider process termination for best-effort cancellation", async () => {
    const scratch = tempDir("best-effort-cancel");
    const executor = createAcpExecutor({
      manifest: manifest("cancel"),
      cancelGraceMs: 500,
      capabilityOverrides: { supportsCancel: false }
    });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_best_effort_cancel"), {
      emit: async () => undefined
    });
    await waitForFile(join(scratch, "acp-waiting.json"));

    await executor.cancel("run_best_effort_cancel");
    const result = await running;

    expect(result).toMatchObject({
      conclusion: "cancelled",
      summary: expect.stringContaining("provider-owned tool subprocess termination is not confirmed"),
      nextAction: "Inspect provider-owned processes before starting another Attempt."
    });
  }, 15_000);

  it("returns cancelled without spawning when cancellation wins the startup race", async () => {
    const scratch = tempDir("immediate-cancel");
    const executor = createAcpExecutor({ manifest: manifest(), cancelGraceMs: 100 });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_immediate_cancel"), {
      emit: async () => undefined
    });

    await executor.cancel("run_immediate_cancel");
    const result = await running;

    expect(result).toMatchObject({
      conclusion: "cancelled",
      summary: "Fixture ACP Agent cancelled the ACP attempt."
    });
    expect(existsSync(join(scratch, "acp-session.json"))).toBe(false);
    expect(existsSync(join(scratch, "acp-prompt.json"))).toBe(false);
  }, 15_000);

  it("uses Windows taskkill tree termination as observed cancellation evidence", async () => {
    const scratch = tempDir("windows-tree-cancel");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const runner: CommandRunner = {
      run: vi.fn(async (command, args) => {
        expect(command).toBe("taskkill");
        expect(args.slice(0, 1)).toEqual(["/PID"]);
        expect(args.slice(2)).toEqual(["/T", "/F"]);
        process.kill(Number(args[1]), "SIGKILL");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
    };
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const executor = createAcpExecutor({
        manifest: manifest("cancel"),
        cancelGraceMs: 100,
        capabilityOverrides: { supportsCancel: true },
        runner
      });
      const running = executor.run(input({ kind: "scratch", path: scratch }, "run_windows_tree_cancel"), {
        emit: async () => undefined
      });
      await waitForFile(join(scratch, "acp-waiting.json"));

      await executor.cancel("run_windows_tree_cancel");
      const result = await running;

      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        conclusion: "cancelled",
        summary: "Fixture ACP Agent cancelled the ACP attempt."
      });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  }, 15_000);

  it("does not claim Windows process-tree termination when taskkill fails", async () => {
    const scratch = tempDir("windows-tree-cancel-failure");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const runner: CommandRunner = {
      run: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "taskkill failed" }))
    };
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const executor = createAcpExecutor({
        manifest: manifest("cancel"),
        cancelGraceMs: 100,
        capabilityOverrides: { supportsCancel: true },
        runner
      });
      const running = executor.run(input({ kind: "scratch", path: scratch }, "run_windows_tree_cancel_failure"), {
        emit: async () => undefined
      });
      await waitForFile(join(scratch, "acp-waiting.json"));

      await executor.cancel("run_windows_tree_cancel_failure");
      const result = await running;

      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        conclusion: "cancelled",
        summary: expect.stringContaining("provider-owned tool subprocess termination is not confirmed")
      });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  }, 15_000);

  it("cancels a delayed session/new without ever submitting a prompt", async () => {
    const scratch = tempDir("delayed-session");
    const executor = createAcpExecutor({ manifest: manifest("delay-session"), cancelGraceMs: 100 });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_delayed_session"), {
      emit: async () => undefined
    });
    await waitForFile(join(scratch, "acp-session-new-started.json"));

    await executor.cancel("run_delayed_session");
    const result = await running;

    expect(result.conclusion).toBe("cancelled");
    expect(existsSync(join(scratch, "acp-prompt.json"))).toBe(false);
  }, 15_000);

  it("kills the child even when the ACP cancellation notification is rejected", async () => {
    const scratch = tempDir("cancel-notify-failure");
    const executor = createAcpExecutor({ manifest: manifest("cancel-notify-failure"), cancelGraceMs: 100 });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_cancel_notify_failure"), {
      emit: async () => undefined
    });
    await waitForFile(join(scratch, "acp-waiting.json"));
    const { pid } = JSON.parse(readFileSync(join(scratch, "acp-session.json"), "utf8"));

    await executor.cancel("run_cancel_notify_failure");
    const result = await running;

    expect(result.conclusion).toBe("cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it.skipIf(process.platform === "win32")("terminates ACP adapter descendants when a run is cancelled", async () => {
    const scratch = tempDir("cancel-process-tree");
    const executor = createAcpExecutor({ manifest: manifest("cancel-process-tree"), cancelGraceMs: 100 });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_cancel_process_tree"), {
      emit: async () => undefined
    });
    const { pid } = await waitForJsonFile<{ pid: number }>(join(scratch, "acp-descendant.json"));

    try {
      expect(processIsAlive(pid)).toBe(true);
      await executor.cancel("run_cancel_process_tree");
      const result = await running;
      await waitForProcessExit(pid);

      expect(result.conclusion).toBe("cancelled");
      expect(processIsAlive(pid)).toBe(false);
    } finally {
      if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 15_000);

  it("strictly rejects malformed NDJSON and kills a child that stays alive", async () => {
    const scratch = tempDir("malformed");
    const executor = createAcpExecutor({ manifest: manifest("malformed-live"), cancelGraceMs: 100 });
    const events: string[] = [];

    await expect(
      executor.run(input({ kind: "scratch", path: scratch }, "run_malformed"), { emit: async (event) => void events.push(event.message) })
    ).rejects.toThrow(/ACP agent fixture-agent.*(?:protocol|exit)/i);
    expect(events.join("\n")).toMatch(/ACP diagnostic \(protocol\).*invalid NDJSON/iu);
    const pid = Number(readFileSync(join(scratch, "acp-child-pid.txt"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("rejects an oversized complete ACP frame by UTF-8 bytes through protocol cleanup", async () => {
    const scratch = tempDir("oversized-complete");
    const executor = createAcpExecutor({ manifest: manifest("oversized-complete"), cancelGraceMs: 100 });
    const events: string[] = [];

    await expect(
      executor.run(input({ kind: "scratch", path: scratch }, "run_oversized_complete"), { emit: async (event) => void events.push(event.message) })
    ).rejects.toThrow(/ACP agent fixture-agent.*(?:protocol|exit)/i);
    expect(events.join("\n")).toMatch(/ACP diagnostic \(protocol\).*invalid NDJSON/iu);
    const pid = Number(readFileSync(join(scratch, "acp-child-pid.txt"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("rejects an oversized incomplete ACP frame by UTF-8 bytes before EOF", async () => {
    const scratch = tempDir("oversized-incomplete");
    const executor = createAcpExecutor({ manifest: manifest("oversized-incomplete"), cancelGraceMs: 100 });
    const events: string[] = [];

    await expect(
      executor.run(input({ kind: "scratch", path: scratch }, "run_oversized_incomplete"), { emit: async (event) => void events.push(event.message) })
    ).rejects.toThrow(/ACP agent fixture-agent.*(?:protocol|exit)/i);
    expect(events.join("\n")).toMatch(/ACP diagnostic \(protocol\).*invalid NDJSON/iu);
    const pid = Number(readFileSync(join(scratch, "acp-child-pid.txt"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("does not leak child stderr through errors or normalized events", async () => {
    const scratch = tempDir("child-exit");
    const executor = createAcpExecutor({ manifest: manifest("child-exit"), cancelGraceMs: 100 });
    const events: string[] = [];
    let thrown = "";
    try {
      await executor.run(input({ kind: "scratch", path: scratch }, "run_child_exit"), {
        emit: async (event) => void events.push(event.message)
      });
    } catch (error) {
      thrown = String(error);
    }

    expect(thrown).toMatch(/ACP agent fixture-agent.*(?:protocol|exit)/i);
    expect(thrown).not.toContain("SENTINEL_CHILD_STDERR_SECRET");
    expect(events.join("\n")).not.toContain("SENTINEL_CHILD_STDERR_SECRET");
    expect(events.join("\n")).toMatch(/ACP diagnostic \(exit\).*exitCode=7.*\[redacted\]/iu);
  }, 15_000);

  it("records a sanitized spawn diagnostic while keeping the public error stable", async () => {
    const scratch = tempDir("missing-executable");
    const configured = manifest();
    configured.bindings.agent.command = "definitely-missing-opentag-acp-executable";
    const executor = createAcpExecutor({ manifest: configured, cancelGraceMs: 100 });
    const events: string[] = [];

    await expect(executor.run(input({ kind: "scratch", path: scratch }, "run_missing_executable"), {
      emit: async (event) => void events.push(event.message)
    })).rejects.toThrow("ACP agent fixture-agent protocol or exit failure.");
    expect(events.join("\n")).toMatch(/ACP diagnostic \(spawn\).*spawnCode=ENOENT/iu);
    expect(events.join("\n")).not.toContain(scratch);
  });

  it("uses an absolute scratch cwd without invoking repository isolation", async () => {
    const scratch = tempDir("scratch");
    const executor = createAcpExecutor({ manifest: manifest() });

    const result = await executor.run(input({ kind: "scratch", path: scratch }, "run_scratch"), { emit: async () => undefined });

    const session = JSON.parse(readFileSync(join(scratch, "acp-session.json"), "utf8"));
    expect(session).toMatchObject({ cwd: realpathSync(scratch), mcpServers: [], inheritedSecret: null, explicitValue: null });
    expect(result.conclusion).toBe("success");
    expect(result.changedFiles).toEqual([]);
    expect(existsSync(join(scratch, ".git"))).toBe(false);
  }, 15_000);

  it("uses an isolated absolute worktree cwd for repository runs", async () => {
    const repo = initRepo();
    const executor = createAcpExecutor({ manifest: manifest() });

    await executor.run(input({ kind: "repository", path: repo }, "run_repo_cwd"), { emit: async () => undefined });

    const session = JSON.parse(git(repo, ["show", "opentag/run_repo_cwd:acp-session.json"]));
    expect(session.cwd).toContain("/.worktrees/opentag/run_repo_cwd");
    expect(session.cwd.startsWith("/")).toBe(true);
  }, 15_000);

  it("uses a real contained binding cwd for both the child and ACP session", async () => {
    const scratch = tempDir("contained-cwd");
    const nested = join(scratch, "nested");
    mkdirSync(nested);
    const executor = createAcpExecutor({ manifest: manifestWithCwd("nested") });

    await executor.run(input({ kind: "scratch", path: scratch }, "run_contained_cwd"), { emit: async () => undefined });

    const session = JSON.parse(readFileSync(join(nested, "acp-session.json"), "utf8"));
    expect(session.cwd).toBe(realpathSync(nested));
    expect(existsSync(join(nested, "acp-output.txt"))).toBe(true);
  }, 15_000);

  it.each([
    ["scratch traversal", "scratch" as const, ".."],
    ["scratch absolute", "scratch" as const, "/tmp"],
    ["repository traversal", "repository" as const, ".."]
  ])("rejects an escaping binding cwd: %s", async (_label, kind, cwd) => {
    const workspace = kind === "repository" ? initRepo() : tempDir("unsafe-cwd");
    const executor = createAcpExecutor({ manifest: manifestWithCwd(cwd) });

    await expect(
      executor.run(input({ kind, path: workspace }, `run_${kind}_unsafe_cwd`), { emit: async () => undefined })
    ).rejects.toThrow(/binding cwd/i);
  }, 15_000);

  it("rejects a binding cwd symlink that escapes the attempt workspace", async () => {
    const scratch = tempDir("symlink-cwd");
    const outside = tempDir("symlink-outside");
    symlinkSync(outside, join(scratch, "escape"));
    const executor = createAcpExecutor({ manifest: manifestWithCwd("escape") });

    await expect(
      executor.run(input({ kind: "scratch", path: scratch }, "run_symlink_cwd"), { emit: async () => undefined })
    ).rejects.toThrow(/binding cwd/i);
  }, 15_000);

  it("scrubs inherited secrets and rejects literal binding environment", async () => {
    const scratch = tempDir("environment");
    const previous = process.env.OPENTAG_ACP_HOST_SECRET;
    process.env.OPENTAG_ACP_HOST_SECRET = "must-not-reach-agent";
    try {
      expect(() => createAcpExecutor({
        manifest: {
          ...manifest(),
          bindings: {
            agent: { ...manifest().bindings.agent, env: { OPENTAG_ACP_EXPLICIT: "configured-value" } }
          }
        }
      })).toThrow();
      const executor = createAcpExecutor({ manifest: manifest() });
      await executor.run(input({ kind: "scratch", path: scratch }, "run_env"), { emit: async () => undefined });
      const session = JSON.parse(readFileSync(join(scratch, "acp-session.json"), "utf8"));
      expect(session.inheritedSecret).toBeNull();
      expect(session.explicitValue).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OPENTAG_ACP_HOST_SECRET;
      else process.env.OPENTAG_ACP_HOST_SECRET = previous;
    }
  }, 15_000);

  it("passes credential-free fixed launch environment while rejecting credential fields", async () => {
    const scratch = tempDir("fixed-environment");
    const executor = createAcpExecutor({
      manifest: manifest(),
      launchEnvironment: { OPENTAG_ACP_EXPLICIT: "configured-value" }
    });

    await executor.run(input({ kind: "scratch", path: scratch }, "run_fixed_env"), { emit: async () => undefined });

    const session = JSON.parse(readFileSync(join(scratch, "acp-session.json"), "utf8"));
    expect(session.explicitValue).toBe("configured-value");
    expect(() => createAcpExecutor({
      manifest: manifest(),
      launchEnvironment: { OPENAI_API_KEY: "must-not-reach-agent" }
    })).toThrow(/launch environment/iu);
  }, 15_000);

  it("does not commit or discard repository changes when an ACP attempt refuses", async () => {
    const repo = initRepo();
    const executor = createAcpExecutor({ manifest: manifest("refusal") });

    const result = await executor.run(input({ kind: "repository", path: repo }, "run_refusal"), { emit: async () => undefined });

    expect(result.conclusion).toBe("needs_human");
    expect(() => git(repo, ["show", "opentag/run_refusal:acp-output.txt"])).toThrow();
    expect(existsSync(join(repo, ".worktrees", "opentag", "run_refusal", "acp-output.txt"))).toBe(true);
  }, 15_000);

  it("retains a cancelled repository delta even when keepWorktree is never", async () => {
    const repo = initRepo();
    const worktree = join(repo, ".worktrees", "opentag", "run_cancel_recovery");
    const executor = createAcpExecutor({ manifest: manifest("cancel"), cancelGraceMs: 100 });
    const running = executor.run(input({ kind: "repository", path: repo }, "run_cancel_recovery"), {
      emit: async () => undefined
    });
    await waitForFile(join(worktree, "acp-waiting.json"));

    await executor.cancel("run_cancel_recovery");
    const result = await running;

    expect(result.conclusion).toBe("cancelled");
    expect(readFileSync(join(worktree, "acp-output.txt"), "utf8")).toContain("recoverable cancellation delta");
    expect(() => git(repo, ["show", "opentag/run_cancel_recovery:acp-output.txt"])).toThrow();
  }, 15_000);
});
