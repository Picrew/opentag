import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFromEnv, parseDaemonConfig, readKeychainSecret, runnerDispatcherToken } from "../src/config.js";
import { builtInAcpOptionsFromConfig, createDaemonClient, executorsFromConfig } from "../src/runtime.js";

const baseRepository = {
  owner: "acme",
  repo: "widgets",
  checkoutPath: "/tmp/acme-widgets"
};

const hostedRegistration = {
  schemaVersion: 1 as const,
  protocolVersion: "1.0" as const,
  runnerId: "runner_hosted",
  registrationGeneration: 1,
  credentialGeneration: 1,
  credentialId: "credential_runtime_1",
  credentialPurpose: "runtime" as const,
  createdAt: "2026-08-08T00:00:00.000Z"
};

function hostedControl(
  state: "credential_staged" | "paired",
  registration = hostedRegistration
) {
  return {
    kind: "hosted_control_v1" as const,
    state,
    operationId: "operation_pair_1",
    registration
  };
}

function acpAgent(input: {
  label: string;
  command: string;
  args?: string[];
  sessionModeId?: string;
  supportsProfile?: boolean;
  supportsCancel?: boolean;
}) {
  return {
    label: input.label,
    command: input.command,
    args: input.args ?? [],
    workspaceCwd: "required" as const,
    ...(input.sessionModeId ? { sessionModeId: input.sessionModeId } : {}),
    ...(input.supportsProfile !== undefined ? { supportsProfile: input.supportsProfile } : {}),
    ...(input.supportsCancel !== undefined ? { supportsCancel: input.supportsCancel } : {})
  };
}

describe("parseDaemonConfig ACP agents", () => {
  it("rejects removed Claude direct-adapter configuration", () => {
    expect(() => parseDaemonConfig({ claudeCode: { command: "claude" } })).toThrow(/never/iu);
  });

  it("runs built-in coding agents through the generic ACP capability contract", () => {
    const executors = executorsFromConfig(parseDaemonConfig({}));

    for (const executorId of ["codex", "claude-code", "cursor", "opencode", "hermes", "openclaw"] as const) {
      expect(executors[executorId]).toMatchObject({
        id: executorId,
        capability: {
          supportsProfile: executorId === "hermes" || executorId === "openclaw",
          supportsStreaming: true,
          supportsCancel: executorId !== "openclaw",
          promptAssembly: "opentag",
          writeActionAccess: "propose",
          workspaceIsolation: "worktree",
          workspaceCwdConformance: "declared"
        }
      });
    }
  });

  it("maps OpenClaw profile and Gateway configuration into the built-in ACP launch", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository, defaultExecutor: "openclaw" }],
      openclaw: {
        command: "/opt/openclaw/bin/openclaw",
        profile: "opentag",
        gatewayUrl: "ws://127.0.0.1:19093",
        expectedVersion: "2026.7.2"
      }
    });

    expect(builtInAcpOptionsFromConfig(config)).toMatchObject({
      openclaw: {
        command: "/opt/openclaw/bin/openclaw",
        profile: "opentag",
        gatewayUrl: "ws://127.0.0.1:19093",
        expectedVersion: "2026.7.2"
      }
    });
    expect(executorsFromConfig(config).openclaw).toMatchObject({
      id: "openclaw",
      capability: { supportsProfile: true, supportsCancel: false }
    });
  });

  it("creates differently named agents through the generic ACP executor path", () => {
    const config = parseDaemonConfig({
      agents: {
        "hermes-acp": acpAgent({ label: "Hermes ACP", command: "hermes", args: ["acp"], supportsProfile: true }),
        "best-effort-acp": acpAgent({
          label: "Best-effort ACP",
          command: "best-effort-agent",
          args: ["acp"],
          supportsCancel: false
        }),
        reviewer: acpAgent({ label: "Review Agent", command: "review-agent", sessionModeId: "review" })
      }
    });

    expect(config.agents?.["hermes-acp"]).toMatchObject({ command: "hermes", args: ["acp"] });
    const executors = executorsFromConfig(config);
    expect(executors["hermes-acp"]).toMatchObject({ id: "hermes-acp", displayName: "Hermes ACP" });
    expect(executors.reviewer).toMatchObject({ id: "reviewer", displayName: "Review Agent" });
    expect(executors.reviewer?.capability).toMatchObject({
      supportsCancel: false,
      workspaceCwdConformance: "declared"
    });
    expect(executors["hermes-acp"]?.capability).toMatchObject({ supportsProfile: true });
    expect(executors["best-effort-acp"]?.capability).toMatchObject({ supportsCancel: false });
    expect(executors["hermes-acp"]?.capability?.completionSignals).toEqual(
      executors.reviewer?.capability?.completionSignals
    );
  });

  it("rejects the removed full ACP manifest shape", () => {
    expect(() => parseDaemonConfig({
      agents: {
        reviewer: {
          protocol: "opentag.integration.v1",
          id: "reviewer",
          label: "Review Agent",
          command: "review-agent"
        }
      }
    })).toThrow(/unrecognized|protocol|id/iu);
  });

  it("requires an explicit workspace cwd conformance attestation", () => {
    expect(() => parseDaemonConfig({
      agents: {
        reviewer: { label: "Review Agent", command: "review-agent" }
      }
    })).toThrow(/workspaceCwd|received undefined/iu);
  });

  it.each(["echo", "codex", "claude-code", "cursor", "opencode", "hermes", "openclaw"])(
    "rejects a configured ACP agent that collides with built-in executor %s",
    (executorId) => {
      expect(() =>
        parseDaemonConfig({
          agents: {
            [executorId]: acpAgent({ label: "Collision", command: "custom-agent" })
          }
        })
      ).toThrow(/built-in executor/iu);
    }
  );

  it("defensively rejects a built-in executor collision when parsed config is bypassed", () => {
    const config = parseDaemonConfig({});
    const bypassed = {
      ...config,
      agents: {
        echo: acpAgent({ label: "Replacement Echo", command: "custom-echo" })
      }
    } as unknown as Parameters<typeof executorsFromConfig>[0];

    expect(() => executorsFromConfig(bypassed)).toThrow(/built-in executor 'echo'/iu);
  });

  it("rejects literal environment values in ACP bindings", () => {
    const configured = acpAgent({ label: "Review Agent", command: "review-agent" });
    expect(() => parseDaemonConfig({
      agents: {
        reviewer: {
          ...configured,
          env: { TOKEN: "literal" }
        }
      }
    })).toThrow(/env|unrecognized/iu);
  });
});

describe("parseDaemonConfig generic channel bindings", () => {
  it("accepts exclusive managed ownership only with bounded provider application identity", () => {
    const config = parseDaemonConfig({
      channelBindings: [{
        provider: "slack",
        accountId: "T123",
        conversationId: "C456",
        ownership: { mode: "managed", exclusive: true, applicationId: "A123", botId: "U123" }
      }]
    });
    expect(config.channelBindings?.[0]?.ownership).toEqual({
      mode: "managed",
      exclusive: true,
      applicationId: "A123",
      botId: "U123"
    });
    expect(() => parseDaemonConfig({
      channelBindings: [{
        provider: "slack",
        accountId: "T123",
        conversationId: "C456",
        ownership: { mode: "managed", exclusive: true, applicationId: "A123\nforged" }
      }]
    })).toThrow();
  });

  it("accepts a channel binding without repository fields", () => {
    const config = parseDaemonConfig({
      channelBindings: [{ provider: "slack", accountId: "T123", conversationId: "C456" }]
    });

    expect(config.channelBindings).toEqual([{ provider: "slack", accountId: "T123", conversationId: "C456" }]);
  });

  it.each([
    { repoProvider: "github" },
    { owner: "acme" },
    { repo: "demo" },
    { repoProvider: "github", owner: "acme" },
    { owner: "acme", repo: "demo" }
  ])("rejects a partial repository target: $repoProvider $owner $repo", (partial) => {
    expect(() =>
      parseDaemonConfig({
        channelBindings: [{ provider: "slack", accountId: "T123", conversationId: "C456", ...partial }]
      })
    ).toThrow();
  });
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-local-runtime-test-"));
}

describe("parseDaemonConfig scratchRoot", () => {
  it("evaluates the default state directory for each parse", () => {
    const previousStateDirectory = process.env.OPENTAG_STATE_DIR;
    const firstStateDirectory = join(tempDir(), "first-state");
    const secondStateDirectory = join(tempDir(), "second-state");

    try {
      process.env.OPENTAG_STATE_DIR = firstStateDirectory;
      expect(parseDaemonConfig({}).scratchRoot).toBe(join(firstStateDirectory, "scratch"));

      process.env.OPENTAG_STATE_DIR = secondStateDirectory;
      expect(parseDaemonConfig({}).scratchRoot).toBe(join(secondStateDirectory, "scratch"));
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.OPENTAG_STATE_DIR;
      } else {
        process.env.OPENTAG_STATE_DIR = previousStateDirectory;
      }
    }
  });
});

describe("parseDaemonConfig defaultExecutor", () => {
  it("accepts the built-in executors", () => {
    for (const executor of ["echo", "codex", "claude-code", "cursor", "opencode", "hermes", "openclaw"]) {
      const config = parseDaemonConfig({
        repositories: [{ ...baseRepository, defaultExecutor: executor }]
      });
      expect(config.repositories[0].defaultExecutor).toBe(executor);
    }
  });

  it("accepts a custom executor id so standalone runners can register their own", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository, defaultExecutor: "custom-runner" }]
    });
    expect(config.repositories[0].defaultExecutor).toBe("custom-runner");
  });

  it("trims executor ids before storing them", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository, defaultExecutor: " custom-runner " }]
    });
    expect(config.repositories[0].defaultExecutor).toBe("custom-runner");
  });

  it("defaults defaultExecutor to echo when omitted", () => {
    const config = parseDaemonConfig({ repositories: [{ ...baseRepository }] });
    expect(config.repositories[0].defaultExecutor).toBe("echo");
  });

  it("rejects an empty executor id", () => {
    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository, defaultExecutor: "" }]
      })
    ).toThrow();
  });

  it("rejects a whitespace-only executor id", () => {
    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository, defaultExecutor: "   " }]
      })
    ).toThrow();
  });
});

describe("parseDaemonConfig Hermes config", () => {
  it("trims Hermes config strings", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository, defaultExecutor: "hermes" }],
      hermes: {
        command: " custom-hermes ",
        profile: " opentag-fixed ",
        profileTemplate: " opentag-{provider}-{owner}-{repo} "
      }
    });

    expect(config.hermes).toEqual({
      command: "custom-hermes",
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{owner}-{repo}"
    });
  });

  it("rejects whitespace-only Hermes config strings", () => {
    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository, defaultExecutor: "hermes" }],
        hermes: {
          profileTemplate: "   "
        }
      })
    ).toThrow();
  });
});

describe("parseDaemonConfig agent session profile", () => {
  it("trims generic agent session profile config strings", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository, defaultExecutor: "codex" }],
      agentSessionProfile: {
        profile: " opentag-fixed ",
        profileTemplate: " opentag-{provider}-{projectTarget}-{actorId} "
      }
    });

    expect(config.agentSessionProfile).toEqual({
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{projectTarget}-{actorId}"
    });
  });

  it("rejects whitespace-only generic agent session profile config strings", () => {
    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository, defaultExecutor: "codex" }],
        agentSessionProfile: {
          profileTemplate: "   "
        }
      })
    ).toThrow();
  });
});

describe("parseDaemonConfig run timeout", () => {
  it("accepts an explicit hard run timeout", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository }],
      runTimeoutMs: 30_000
    });

    expect(config.runTimeoutMs).toBe(30_000);
  });

  it("rejects non-positive hard run timeouts", () => {
    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository }],
        runTimeoutMs: 0
      })
    ).toThrow();
  });
});

describe("Hosted Control V1 credential state", () => {
  it("keeps marker-free legacy token resolution unchanged", () => {
    const config = parseDaemonConfig({
      runnerId: "runner_legacy",
      pairingToken: "legacy_pairing"
    });

    expect(config.controlRegistration).toBeUndefined();
    expect(runnerDispatcherToken(config)).toBe("legacy_pairing");
  });

  it("strictly parses all hosted states and only authenticates a paired runner", () => {
    const unpaired = parseDaemonConfig({
      runnerId: "runner_hosted",
      pairingToken: "pairing_bootstrap",
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        flow: "registration",
        operationId: "operation_pair_1",
        reason: "pending"
      }
    });
    const recoveryRequired = parseDaemonConfig({
      runnerId: "runner_hosted",
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        reason: "recovery_required",
        registration: hostedRegistration
      }
    });
    const staged = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_staged",
      controlRegistration: hostedControl("credential_staged")
    });
    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_committed",
      controlRegistration: hostedControl("paired")
    });
    const reProvisionOutcomeUnknown = parseDaemonConfig({
      runnerId: "runner_hosted",
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        flow: "reprovision",
        operationId: "operation_reprovision_1",
        reason: "outcome_unknown",
        recoveryCredentialId: "credential_recovery_1",
        registration: hostedRegistration
      }
    });

    expect(runnerDispatcherToken(unpaired)).toBeUndefined();
    expect(runnerDispatcherToken(recoveryRequired)).toBeUndefined();
    expect(runnerDispatcherToken(staged)).toBeUndefined();
    expect(runnerDispatcherToken(reProvisionOutcomeUnknown)).toBeUndefined();
    expect(runnerDispatcherToken(paired)).toBe("runtime_committed");
    expect(() => createDaemonClient(unpaired)).toThrow(/not paired/iu);
    expect(() => createDaemonClient(staged)).toThrow(/staged but not committed/iu);
    expect(() => createDaemonClient(paired)).not.toThrow();
  });

  it("rejects unknown hosted fields and invalid metadata", () => {
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        flow: "registration",
        operationId: "operation_pair_1",
        reason: "pending",
        unexpected: true
      }
    })).toThrow(/unrecognized/iu);

    for (const registration of [
      { ...hostedRegistration, createdAt: "not-a-timestamp" },
      { ...hostedRegistration, registrationGeneration: 0 },
      { ...hostedRegistration, credentialGeneration: -1 },
      { ...hostedRegistration, unexpected: true }
    ]) {
      expect(() => parseDaemonConfig({
        runnerId: "runner_hosted",
        runnerToken: "runtime_staged",
        controlRegistration: hostedControl("credential_staged", registration as typeof hostedRegistration)
      })).toThrow();
    }
  });

  it("enforces initial registration and re-provision replay state", () => {
    const registrationWithoutLocalSecret = parseDaemonConfig({
      runnerId: "runner_hosted",
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        flow: "registration",
        operationId: "operation_pair_1",
        reason: "outcome_unknown"
      }
    });
    expect(registrationWithoutLocalSecret.controlRegistration?.state).toBe("unpaired");

    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      pairingToken: "pairing_bootstrap",
      runnerToken: "runtime_must_not_exist",
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        flow: "registration",
        operationId: "operation_pair_1",
        reason: "pending"
      }
    })).toThrow(/must not contain a runtime runner token/iu);

    const reProvision = {
      kind: "hosted_control_v1" as const,
      state: "unpaired" as const,
      flow: "reprovision" as const,
      operationId: "operation_reprovision_1",
      reason: "outcome_unknown" as const,
      recoveryCredentialId: "credential_recovery_1",
      registration: hostedRegistration
    };
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      pairingToken: "pairing_must_not_exist",
      controlRegistration: reProvision
    })).toThrow(/must not retain a pairing token/iu);
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_must_not_exist",
      controlRegistration: reProvision
    })).toThrow(/must not contain a runtime runner token/iu);
  });

  it("requires recovery metadata and rejects every persisted token", () => {
    const recoveryRequired = {
      kind: "hosted_control_v1" as const,
      state: "unpaired" as const,
      reason: "recovery_required" as const
    };
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      controlRegistration: recoveryRequired
    })).toThrow();
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      pairingToken: "pairing_must_not_exist",
      controlRegistration: { ...recoveryRequired, registration: hostedRegistration }
    })).toThrow(/must not retain the consumed pairing token/iu);
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_must_not_exist",
      controlRegistration: { ...recoveryRequired, registration: hostedRegistration }
    })).toThrow(/must not contain a runtime runner token/iu);
  });

  it("rejects unsafe hosted credential persistence combinations", () => {
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_staged",
      pairingToken: "pairing_must_be_deleted",
      controlRegistration: hostedControl("credential_staged")
    })).toThrow(/must not retain/iu);
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      controlRegistration: hostedControl("paired")
    })).toThrow(/requires a staged runtime runner token/iu);
    expect(() => parseDaemonConfig({
      runnerId: "runner_other",
      runnerToken: "runtime_committed",
      controlRegistration: hostedControl("paired")
    })).toThrow(/must match daemon runnerId/iu);
  });
});

describe("parseDaemonConfig secret refs", () => {
  it("resolves env and file secret refs for direct daemon configs", () => {
    const previousPairingToken = process.env.OPENTAG_TEST_PAIRING_TOKEN;
    const previousRunnerToken = process.env.OPENTAG_TEST_RUNNER_TOKEN;
    const previousOldRunnerToken = process.env.OPENTAG_TEST_OLD_RUNNER_TOKEN;
    const previousApplyToken = process.env.OPENTAG_TEST_APPLY_TOKEN;
    const secretPath = join(tempDir(), "github-token.txt");
    writeFileSync(secretPath, "ghp_from_file\n", { mode: 0o600 });
    process.env.OPENTAG_TEST_PAIRING_TOKEN = "pairing_from_env";
    process.env.OPENTAG_TEST_RUNNER_TOKEN = "runner_from_env";
    process.env.OPENTAG_TEST_OLD_RUNNER_TOKEN = "runner_old_from_env";
    process.env.OPENTAG_TEST_APPLY_TOKEN = "apply_from_env";
    try {
      const config = parseDaemonConfig({
        repositories: [{ ...baseRepository }],
        pairingToken: { kind: "env", name: "OPENTAG_TEST_PAIRING_TOKEN" },
        runnerToken: { kind: "env", name: "OPENTAG_TEST_RUNNER_TOKEN" },
        runnerTokens: [{ kind: "env", name: "OPENTAG_TEST_OLD_RUNNER_TOKEN" }],
        revokedRunnerTokenFingerprints: ["abc123"],
        githubToken: { kind: "file", path: secretPath },
        githubApplyToken: { kind: "env", name: "OPENTAG_TEST_APPLY_TOKEN" }
      });

      expect(config.pairingToken).toBe("pairing_from_env");
      expect(config.runnerToken).toBe("runner_from_env");
      expect(config.runnerTokens).toEqual(["runner_old_from_env"]);
      expect(config.revokedRunnerTokenFingerprints).toEqual(["abc123"]);
      expect(runnerDispatcherToken(config)).toBe("runner_from_env");
      expect(config.githubToken).toBe("ghp_from_file");
      expect(config.githubApplyToken).toBe("apply_from_env");
    } finally {
      if (previousPairingToken === undefined) {
        delete process.env.OPENTAG_TEST_PAIRING_TOKEN;
      } else {
        process.env.OPENTAG_TEST_PAIRING_TOKEN = previousPairingToken;
      }
      if (previousRunnerToken === undefined) {
        delete process.env.OPENTAG_TEST_RUNNER_TOKEN;
      } else {
        process.env.OPENTAG_TEST_RUNNER_TOKEN = previousRunnerToken;
      }
      if (previousOldRunnerToken === undefined) {
        delete process.env.OPENTAG_TEST_OLD_RUNNER_TOKEN;
      } else {
        process.env.OPENTAG_TEST_OLD_RUNNER_TOKEN = previousOldRunnerToken;
      }
      if (previousApplyToken === undefined) {
        delete process.env.OPENTAG_TEST_APPLY_TOKEN;
      } else {
        process.env.OPENTAG_TEST_APPLY_TOKEN = previousApplyToken;
      }
    }
  });

  it("keeps null GitHub apply token while resolving other secret refs", () => {
    const previousPairingToken = process.env.OPENTAG_TEST_PAIRING_TOKEN;
    process.env.OPENTAG_TEST_PAIRING_TOKEN = "pairing_from_env";
    try {
      const config = parseDaemonConfig({
        repositories: [{ ...baseRepository }],
        pairingToken: { kind: "env", name: "OPENTAG_TEST_PAIRING_TOKEN" },
        githubApplyToken: null
      });

      expect(config.pairingToken).toBe("pairing_from_env");
      expect(config.githubApplyToken).toBeNull();
    } finally {
      if (previousPairingToken === undefined) {
        delete process.env.OPENTAG_TEST_PAIRING_TOKEN;
      } else {
        process.env.OPENTAG_TEST_PAIRING_TOKEN = previousPairingToken;
      }
    }
  });

  it("falls back to the legacy pairing token for runner calls", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository }],
      pairingToken: "legacy_pairing"
    });

    expect(runnerDispatcherToken(config)).toBe("legacy_pairing");
  });

  it("loads runner token rotation and revocation lists from env", () => {
    const previous = {
      OPENTAG_CONFIG_PATH: process.env.OPENTAG_CONFIG_PATH,
      OPENTAG_RUNNER_TOKENS_JSON: process.env.OPENTAG_RUNNER_TOKENS_JSON,
      OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON: process.env.OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON
    };
    delete process.env.OPENTAG_CONFIG_PATH;
    process.env.OPENTAG_RUNNER_TOKENS_JSON = JSON.stringify(["runner_old"]);
    process.env.OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON = JSON.stringify(["abc123"]);
    try {
      const config = loadConfigFromEnv();

      expect(config.runnerTokens).toEqual(["runner_old"]);
      expect(config.revokedRunnerTokenFingerprints).toEqual(["abc123"]);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("loads the OpenClaw version authority from env without changing the selected profile", () => {
    const previous = {
      OPENTAG_CONFIG_PATH: process.env.OPENTAG_CONFIG_PATH,
      OPENTAG_OPENCLAW_PROFILE: process.env.OPENTAG_OPENCLAW_PROFILE,
      OPENTAG_OPENCLAW_EXPECTED_VERSION: process.env.OPENTAG_OPENCLAW_EXPECTED_VERSION
    };
    delete process.env.OPENTAG_CONFIG_PATH;
    process.env.OPENTAG_OPENCLAW_PROFILE = "opentag";
    process.env.OPENTAG_OPENCLAW_EXPECTED_VERSION = "2026.7.2";
    try {
      expect(loadConfigFromEnv().openclaw).toEqual({
        profile: "opentag",
        expectedVersion: "2026.7.2"
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("uses OPENTAG_REPO_PROVIDER for env-derived Project Target bindings", () => {
    const previous = {
      OPENTAG_CONFIG_PATH: process.env.OPENTAG_CONFIG_PATH,
      OPENTAG_REPO_PROVIDER: process.env.OPENTAG_REPO_PROVIDER,
      OPENTAG_REPO_OWNER: process.env.OPENTAG_REPO_OWNER,
      OPENTAG_REPO_NAME: process.env.OPENTAG_REPO_NAME,
      OPENTAG_WORKSPACE_PATH: process.env.OPENTAG_WORKSPACE_PATH
    };
    delete process.env.OPENTAG_CONFIG_PATH;
    process.env.OPENTAG_REPO_PROVIDER = "gitlab";
    process.env.OPENTAG_REPO_OWNER = "acme";
    process.env.OPENTAG_REPO_NAME = "demo";
    process.env.OPENTAG_WORKSPACE_PATH = "/tmp/acme-demo";
    try {
      const config = loadConfigFromEnv();

      expect(config.repositories[0]).toMatchObject({
        provider: "gitlab",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/acme-demo"
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("resolves keychain secret refs through the macOS security command", () => {
    const calls: Array<{ args: readonly string[]; file: string; options: { encoding: "utf8" } }> = [];
    const value = readKeychainSecret({ kind: "keychain", service: "opentag", account: "pairing-token" }, (file, args, options) => {
      calls.push({ args, file, options });
      return "pairing_from_keychain\n";
    });

    expect(value).toBe("pairing_from_keychain");
    expect(calls).toEqual([
      {
        file: "/usr/bin/security",
        args: ["find-generic-password", "-w", "-s", "opentag", "-a", "pairing-token"],
        options: { encoding: "utf8" }
      }
    ]);
  });

  it("rejects secret refs that cannot resolve to a non-empty value", () => {
    const emptySecretPath = join(tempDir(), "empty-token.txt");
    const missingSecretPath = join(tempDir(), "missing-token.txt");
    writeFileSync(emptySecretPath, "\n", { mode: 0o600 });

    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository }],
        pairingToken: { kind: "file", path: emptySecretPath }
      })
    ).toThrow(`Secret file ref ${emptySecretPath} resolved to an empty value.`);

    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository }],
        pairingToken: { kind: "file", path: missingSecretPath }
      })
    ).toThrow(`Secret file ref ${missingSecretPath} could not be resolved.`);

    expect(() => readKeychainSecret({ kind: "keychain", service: "opentag", account: "pairing-token" }, () => "\n")).toThrow(
      "Secret keychain ref opentag/pairing-token resolved to an empty value."
    );
  });

  it("fails when an env secret ref is not set", () => {
    delete process.env.OPENTAG_TEST_MISSING_SECRET;

    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository }],
        pairingToken: { kind: "env", name: "OPENTAG_TEST_MISSING_SECRET" }
      })
    ).toThrow("Secret env ref OPENTAG_TEST_MISSING_SECRET is not set.");
  });
});
