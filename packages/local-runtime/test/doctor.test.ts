import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpExecutor, createBuiltInAcpExecutors, type CommandRunner, type ExecutorAdapter } from "@opentag/runner";
import type { OpenTagDaemonConfig } from "../src/config.js";
import { doctorHasFailures, formatDoctorChecks, runDoctor } from "../src/doctor.js";

const commandRunner: CommandRunner = {
  async run(command, args) {
    if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
  }
};

const codexExecutor: ExecutorAdapter = {
  ...createBuiltInAcpExecutors().codex,
  async canRun() {
    return { ready: true };
  },
  async run() {
    throw new Error("not used in doctor tests");
  },
  async cancel() {}
};

function withUnverifiedWorkspaceCapability(executor: ExecutorAdapter): ExecutorAdapter {
  if (!executor.capability) throw new Error("Expected executor capability in doctor test fixture.");
  return {
    ...executor,
    capability: {
      ...executor.capability,
      writeAccess: "external",
      workspaceIsolation: "external",
      workspaceCwdConformance: "unverified"
    }
  };
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const hostedRegistration = {
  schemaVersion: 1 as const,
  protocolVersion: "1.0" as const,
  runnerId: "runner_local",
  registrationGeneration: 1,
  credentialGeneration: 1,
  credentialId: "credential_runtime_1",
  credentialPurpose: "runtime" as const,
  createdAt: "2026-08-08T00:00:00.000Z"
};

function hostedControl(state: "credential_staged" | "paired", runnerId = "runner_local") {
  return {
    kind: "hosted_control_v1" as const,
    state,
    operationId: "operation_pair_1",
    registration: { ...hostedRegistration, runnerId }
  };
}

async function runCodexDoctor(
  codexConfig: string,
  configOverrides: Partial<OpenTagDaemonConfig> = {},
  options: {
    executors?: Record<string, ExecutorAdapter>;
    env?: Record<string, string | undefined>;
    repositoryDefaultExecutor?: string;
    requestObserver?: (url: string, init?: RequestInit) => void;
    repositoryFree?: boolean;
    runnerResponse?: () => Response;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "opentag-local-runtime-doctor-"));
  const checkoutPath = join(root, "demo");
  const codexConfigPath = join(root, "codex-config.toml");
  mkdirSync(checkoutPath, { recursive: true });
  writeFileSync(join(checkoutPath, ".git"), "gitdir: /tmp/fake-git\n");
  writeFileSync(codexConfigPath, codexConfig);

  try {
    return await runDoctor({
      config: {
        runnerId: "runner_local",
        dispatcherUrl: "http://dispatcher.test",
        repositories: options.repositoryFree
          ? []
          : [
              {
                provider: "github",
                owner: "acme",
                repo: "demo",
                checkoutPath,
                defaultExecutor: options.repositoryDefaultExecutor ?? "codex",
                baseBranch: "main",
                pushRemote: "origin",
                keepWorktree: "on_failure"
              }
            ],
        githubToken: "ghs_test",
        pollIntervalMs: 5000,
        heartbeatIntervalMs: 15000,
        ...configOverrides
      },
      executors: options.executors ?? { codex: codexExecutor },
      commandRunner,
      codexConfigPath,
      ...(options.env ? { env: options.env } : {}),
      fetchImpl: async (url, init) => {
        const stringUrl = String(url);
        options.requestObserver?.(stringUrl, init);
        if (stringUrl.endsWith("/healthz")) {
          return Response.json({ ok: true });
        }
        if (stringUrl.endsWith("/v1/runners/runner_local")) {
          if (options.runnerResponse) return options.runnerResponse();
          return Response.json({
            runner: { runnerId: "runner_local", name: "Local Runner", createdAt: "2026-06-24T00:00:00.000Z" }
          });
        }
        if (stringUrl.endsWith("/v1/repo-bindings/github/acme/demo")) {
          return Response.json({
            binding: {
              provider: "github",
              owner: "acme",
              repo: "demo",
              runnerId: "runner_local",
              workspacePath: checkoutPath,
              defaultExecutor: "codex"
            }
          });
        }
        return new Response("not found", { status: 404 });
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("local-runtime doctor", () => {
  it("passes when the Codex service tier is supported", async () => {
    const checks = await runCodexDoctor('service_tier = "fast" # use the low-latency tier\n');

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK   Codex config: service_tier=fast");
    expect(formatDoctorChecks(checks)).toContain("WARN hook ingest auth: No runner-scoped dispatcher token is configured");
    expect(formatDoctorChecks(checks)).toContain("OK   codex capability: invocation=spawn, profile=no");
    expect(formatDoctorChecks(checks)).toContain("progress=audit, approval=opentag_policy");
    expect(formatDoctorChecks(checks)).toContain("context=context_packet,context_pointers,workspace");
    expect(formatDoctorChecks(checks)).toContain("prompt=opentag, write=workspace");
    expect(formatDoctorChecks(checks)).toContain("conversation=request, prompt_mutation=none, raw_context=no, write_actions=propose");
    expect(formatDoctorChecks(checks)).toContain("isolation=worktree, cwd_conformance=declared");
    expect(formatDoctorChecks(checks)).toContain("OK   github:acme/demo checkout: Workspace path configured (hasWorkspacePath=yes).");
    expect(formatDoctorChecks(checks)).not.toContain("opentag-local-runtime-doctor-");
  });

  it("reports a repository-free executor's unverified workspace capability", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "scratch-agent",
      label: "Scratch ACP Agent",
      bindings: {
        agent: { kind: "stdio" as const, command: "scratch-agent", args: ["acp"] }
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
    const executor = withUnverifiedWorkspaceCapability(createAcpExecutor({ manifest }));
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { repositories: [], agents: { "scratch-agent": manifest } },
      { executors: { "scratch-agent": executor } }
    );
    const output = formatDoctorChecks(checks);

    expect(output).toContain("OK   scratch-agent configured agent: Scratch ACP Agent (scratch-agent)");
    expect(output).toContain("FAIL scratch-agent capability:");
    expect(output).toContain("isolation=external, cwd_conformance=unverified");
    expect(doctorHasFailures(checks)).toBe(true);
  });

  it("passes repository-free doctor checks for a declared scratch-only ACP agent", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "declared-agent",
      label: "Declared ACP Agent",
      bindings: { agent: { kind: "stdio" as const, command: "declared-agent" } },
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
    const executor = createAcpExecutor({ manifest });
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { repositories: [], agents: { "declared-agent": manifest } },
      { executors: { "declared-agent": executor } }
    );
    const output = formatDoctorChecks(checks);

    expect(output).toContain("OK   repository config: 1 configured agent supports repository-free Runs.");
    expect(output).toContain("OK   declared-agent capability:");
    expect(doctorHasFailures(checks)).toBe(false);
  });

  it("fails repository configuration when neither repositories nor agents are configured", async () => {
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { repositories: [], agents: {} },
      { executors: {} }
    );

    expect(formatDoctorChecks(checks)).toContain(
      "FAIL repository config: No repositories or agents are configured."
    );
    expect(doctorHasFailures(checks)).toBe(true);
  });

  it("fails when a repository-free configured ACP agent has no local executor", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "missing-agent",
      label: "Missing ACP Agent",
      bindings: { agent: { kind: "stdio" as const, command: "missing-agent" } },
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
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { repositories: [], agents: { "missing-agent": manifest } },
      { executors: {} }
    );

    expect(formatDoctorChecks(checks)).toContain(
      "FAIL missing-agent configured agent: No local executor is configured with this id."
    );
  });

  it("does not duplicate an unverified executor capability already covered by a repository default", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "repo-agent",
      label: "Repository ACP Agent",
      bindings: { agent: { kind: "stdio" as const, command: "repo-agent" } },
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
    const acpExecutor = withUnverifiedWorkspaceCapability(createAcpExecutor({ manifest }));
    const executor: ExecutorAdapter = { ...acpExecutor, canRun: async () => ({ ready: true }) };
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { agents: { "repo-agent": manifest } },
      { executors: { "repo-agent": executor }, repositoryDefaultExecutor: "repo-agent" }
    );
    const output = formatDoctorChecks(checks);

    expect(output.match(/repo-agent capability:/gu)).toHaveLength(1);
    expect(output).toContain("FAIL repo-agent capability:");
    expect(output).not.toContain("repo-agent configured agent:");
    expect(doctorHasFailures(checks)).toBe(true);
  });

  it("fails a healthy repository doctor when a secondary configured ACP agent is unverified", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "secondary-agent",
      label: "Secondary ACP Agent",
      bindings: { agent: { kind: "stdio" as const, command: "secondary-agent" } },
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
    const secondaryExecutor = withUnverifiedWorkspaceCapability(createAcpExecutor({ manifest }));
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { agents: { "secondary-agent": manifest } },
      { executors: { codex: codexExecutor, "secondary-agent": secondaryExecutor } }
    );
    const output = formatDoctorChecks(checks);

    expect(output).toContain("OK   github:acme/demo git repo: Git checkout detected");
    expect(output).toContain("FAIL secondary-agent capability:");
    expect(output).toContain("cwd_conformance=unverified");
    expect(doctorHasFailures(checks)).toBe(true);
  });

  it("fails Hermes readiness when the configured fixed profile is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "opentag-hermes-doctor-"));
    const checkoutPath = join(root, "demo");
    mkdirSync(checkoutPath, { recursive: true });
    writeFileSync(join(checkoutPath, ".git"), "gitdir: /tmp/fake-git\n");
    const hermesExecutor = createBuiltInAcpExecutors({ hermes: { profile: "opentag-fixed" } }).hermes;
    const unavailableHermesExecutor: ExecutorAdapter = {
      ...hermesExecutor,
      async canRun() {
        return {
          ready: false,
          reason: "Hermes profile 'opentag-fixed' is not ready: Profile 'opentag-fixed' does not exist"
        };
      }
    };

    try {
      const checks = await runDoctor({
        config: {
          runnerId: "runner_local",
          dispatcherUrl: "http://dispatcher.test",
          repositories: [
            {
              provider: "github",
              owner: "acme",
              repo: "demo",
              checkoutPath,
              defaultExecutor: "hermes",
              baseBranch: "main",
              pushRemote: "origin",
              keepWorktree: "on_failure"
            }
          ],
          hermes: { profile: "opentag-fixed" },
          pollIntervalMs: 5000,
          heartbeatIntervalMs: 15000
        },
        executors: { hermes: unavailableHermesExecutor },
        commandRunner,
        fetchImpl: async (url) => {
          const stringUrl = String(url);
          if (stringUrl.endsWith("/healthz")) return Response.json({ ok: true });
          if (stringUrl.endsWith("/v1/runners/runner_local")) {
            return Response.json({ runner: { runnerId: "runner_local", name: "Local Runner", createdAt: "2026-06-24T00:00:00.000Z" } });
          }
          if (stringUrl.endsWith("/v1/repo-bindings/github/acme/demo")) {
            return Response.json({
              binding: {
                provider: "github",
                owner: "acme",
                repo: "demo",
                runnerId: "runner_local",
                workspacePath: checkoutPath,
                defaultExecutor: "hermes"
              }
            });
          }
          return new Response("not found", { status: 404 });
        }
      });

      expect(doctorHasFailures(checks)).toBe(true);
      expect(formatDoctorChecks(checks)).toContain(
        "FAIL hermes executor: Hermes profile 'opentag-fixed' is not ready: Profile 'opentag-fixed' does not exist"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns that legacy Hermes profile templates are ignored in favor of the fixed profile", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      hermes: {
        profile: "opentag-fixed",
        profileTemplate: "opentag-{provider}-{conversationId}"
      }
    });

    expect(formatDoctorChecks(checks)).toContain(
      "WARN Hermes profile configuration: Hermes configuration warning: daemon.hermes.profileTemplate is not used"
    );
    expect(formatDoctorChecks(checks)).toContain("OpenTag will use the fixed profile 'opentag-fixed'");
  });

  it("checks executor required env secrets without printing secret values", async () => {
    const secretExecutor: ExecutorAdapter = {
      ...codexExecutor,
      capability: {
        ...codexExecutor.capability!,
        requiredSecrets: [
          {
            id: "agent_token",
            label: "Agent token",
            required: true,
            env: "AGENT_TOKEN",
            description: "Needed for the external runtime."
          }
        ]
      }
    };

    const missing = await runCodexDoctor('service_tier = "fast"\n', {}, { executors: { codex: secretExecutor }, env: {} });
    expect(doctorHasFailures(missing)).toBe(true);
    expect(formatDoctorChecks(missing)).toContain(
      "FAIL codex secret agent_token: Agent token is required but env AGENT_TOKEN is not configured. Needed for the external runtime."
    );

    const configured = await runCodexDoctor(
      'service_tier = "fast"\n',
      {},
      { executors: { codex: secretExecutor }, env: { AGENT_TOKEN: "super-secret-value" } }
    );
    const formatted = formatDoctorChecks(configured);
    expect(doctorHasFailures(configured)).toBe(false);
    expect(formatted).toContain("OK   codex secret agent_token: Agent token configured via env AGENT_TOKEN (required).");
    expect(formatted).not.toContain("super-secret-value");
  });

  it("fails when the Codex service tier is a known deprecated value", async () => {
    const checks = await runCodexDoctor("service_tier = 'default' # old setting\n");

    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatDoctorChecks(checks)).toContain("FAIL Codex config: Deprecated service_tier 'default'");
  });

  it("passes when the Codex service tier is priority", async () => {
    const checks = await runCodexDoctor('service_tier = "priority"\n');

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK   Codex config: service_tier=priority");
  });

  it("passes when the Codex service tier is a catalog-provided id", async () => {
    const checks = await runCodexDoctor('service_tier = "acme-enterprise-tier"\n');

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK   Codex config: service_tier=acme-enterprise-tier");
  });

  it("warns when direct GitHub apply is explicitly disabled", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      preparePullRequestBranch: true,
      githubApplyToken: null
    });

    expect(formatDoctorChecks(checks)).toContain(
      "WARN GitHub PR actions: Run branches can be pushed, but a GitHub apply token is required for direct `apply 1` PR creation"
    );
  });

  it("reports legacy pairing-token fallback for hook ingest", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token"
    });

    expect(formatDoctorChecks(checks)).toContain(
      "OK   hook ingest auth: Legacy daemon pairing token is configured for runner calls and local hook ingest"
    );
  });

  it("reports runner-scoped auth when a separate runner token protects hook ingest", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token",
      runnerToken: "runner_token"
    });

    expect(formatDoctorChecks(checks)).toContain(
      "OK   hook ingest auth: Runner-scoped dispatcher token is configured separately from the pairing token"
    );
  });

  it("fails closed for an unpaired hosted runner without sending pairing auth", async () => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        pairingToken: "pairing_secret_must_not_leak",
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "unpaired",
          flow: "registration",
          operationId: "operation_pair_1",
          reason: "pending"
        }
      },
      {
        requestObserver(url, init) {
          const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
          requests.push({ url, ...(authorization ? { authorization } : {}) });
        }
      }
    );

    const formatted = formatDoctorChecks(checks);
    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatted).toContain("FAIL hosted runner auth: Hosted Control V1 runner is not paired");
    expect(formatted).not.toContain("pairing_secret_must_not_leak");
    expect(requests.filter(({ url }) => url.includes("/v1/"))).toEqual([]);
  });

  it("accepts recovery-required state while making no authenticated request", async () => {
    const runnerRequests: string[] = [];
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "unpaired",
          reason: "recovery_required",
          registration: hostedRegistration
        }
      },
      {
        requestObserver(url) {
          if (url.includes("/v1/")) runnerRequests.push(url);
        }
      }
    );

    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatDoctorChecks(checks)).toContain(
      "FAIL hosted runner auth: Hosted Control V1 runner credential recovery is required"
    );
    expect(runnerRequests).toEqual([]);
  });

  it("does not authenticate a staged hosted credential", async () => {
    const runnerRequests: string[] = [];
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        runnerToken: "runtime_staged_secret",
        controlRegistration: hostedControl("credential_staged")
      },
      {
        requestObserver(url) {
          if (url.includes("/v1/")) runnerRequests.push(url);
        }
      }
    );

    const formatted = formatDoctorChecks(checks);
    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatted).toContain("FAIL hosted runner auth: Hosted Control V1 runner credential is staged");
    expect(formatted).not.toContain("runtime_staged_secret");
    expect(runnerRequests).toEqual([]);
  });

  it("uses the runtime token for a valid paired hosted runner", async () => {
    const authorizations: string[] = [];
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        runnerToken: "runtime_paired_secret",
        controlRegistration: hostedControl("paired")
      },
      {
        requestObserver(url, init) {
          if (!url.includes("/v1/")) return;
          const authorization = new Headers(init?.headers).get("authorization");
          if (authorization) authorizations.push(authorization);
        }
      }
    );

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK   hosted runner auth: Hosted Control V1 paired runtime credential is configured and selected");
    expect(authorizations).toContain("Bearer runtime_paired_secret");
  });

  it("fails hosted remote auth without exposing the dispatcher response body", async () => {
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        runnerToken: "runtime_paired_secret",
        controlRegistration: hostedControl("paired")
      },
      {
        repositoryFree: true,
        runnerResponse: () => Response.json(
          { error: "unauthorized", detail: "remote_body_secret_must_not_leak" },
          { status: 401 }
        )
      }
    );

    const formatted = formatDoctorChecks(checks);
    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatted).toContain("FAIL runner registration: Dispatcher request failed with HTTP 401 (unauthorized).");
    expect(formatted).toContain("remote authentication is checked separately");
    expect(formatted).not.toContain("remote_body_secret_must_not_leak");
    expect(formatted).not.toContain("runtime_paired_secret");
  });

  it("fails closed on hosted identity mismatch and pairing-token residue without leaking secrets", async () => {
    for (const configOverrides of [
      {
        runnerToken: "runtime_mismatch_secret",
        controlRegistration: hostedControl("paired", "runner_other")
      },
      {
        pairingToken: "pairing_residue_secret",
        runnerToken: "runtime_paired_secret",
        controlRegistration: hostedControl("paired")
      }
    ]) {
      const runnerRequests: string[] = [];
      const checks = await runCodexDoctor('service_tier = "fast"\n', configOverrides, {
        requestObserver(url) {
          if (url.includes("/v1/")) runnerRequests.push(url);
        }
      });
      const formatted = formatDoctorChecks(checks);

      expect(doctorHasFailures(checks)).toBe(true);
      expect(formatted).toContain("FAIL hosted runner auth:");
      expect(formatted).not.toContain("runtime_mismatch_secret");
      expect(formatted).not.toContain("pairing_residue_secret");
      expect(formatted).not.toContain("runtime_paired_secret");
      expect(runnerRequests).toEqual([]);
    }
  });

  it("reports runner token rotation and revocation readiness", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token",
      runnerToken: "runner_token",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: [tokenFingerprint("runner_older")]
    });

    const formatted = formatDoctorChecks(checks);
    expect(formatted).toContain("OK   runner token rotation: 1 additional runner token(s) configured for the rotation window.");
    expect(formatted).toContain("OK   runner token revocation: 1 revoked runner token fingerprint(s) configured");
  });

  it("fails when the current runner token has been revoked", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token",
      runnerToken: "runner_token",
      revokedRunnerTokenFingerprints: [tokenFingerprint("runner_token")]
    });

    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatDoctorChecks(checks)).toContain("FAIL runner token revocation: Current daemon.runnerToken fingerprint is revoked");
  });

  it("fails when a configured rotation runner token has been revoked", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token",
      runnerToken: "runner_token",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: [tokenFingerprint("runner_old")]
    });

    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatDoctorChecks(checks)).toContain("FAIL runner token revocation: 1 daemon.runnerTokens fingerprint(s) are revoked");
  });
});
