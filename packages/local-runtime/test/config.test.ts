import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  beginHostedCredentialRevocation,
  beginHostedCredentialRotation,
  beginHostedCredentialRotationSuccessor,
  confirmHostedCredentialRevocation,
  finalizeHostedCredentialRotation,
  hostedCredentialOperationProblem,
  hostedCredentialMutationRequestDigest,
  loadConfigFromEnv,
  markHostedCredentialRevocationOutcomeUnknown,
  markHostedCredentialRotationOutcomeUnknown,
  parseDaemonConfig,
  readKeychainSecret,
  reconcileHostedCredentialRotationSuccessorReplay,
  recordHostedCredentialConflict,
  recordHostedCredentialReconciliationFailure,
  runnerDispatcherToken,
  stageHostedCredentialRotation
} from "../src/config.js";
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

const hostedCredentialMutationRequest = {
  schemaVersion: 1 as const,
  protocolVersion: "1.0" as const,
  requiredCapabilities: ["relay.credential-rotation.v1"] as const,
  requestId: "request_rotate_1",
  operationId: "operation_rotate_1",
  runnerId: "runner_hosted",
  expectedRegistrationGeneration: 1,
  expectedCredentialGeneration: 1,
  expectedCredentialId: "credential_runtime_1"
};

const hostedCredentialMutationDigest = hostedCredentialMutationRequestDigest(hostedCredentialMutationRequest);

function rotationInput(request = hostedCredentialMutationRequest) {
  return { request, canonicalRequestDigest: hostedCredentialMutationRequestDigest(request) };
}

function revocationInput(request = hostedCredentialMutationRequest) {
  return { request, canonicalRequestDigest: hostedCredentialMutationRequestDigest(request) };
}

const rotatedHostedRotation = {
  schemaVersion: 1 as const,
  protocolVersion: "1.0" as const,
  operationId: "operation_rotate_1",
  runnerId: "runner_hosted",
  registrationGeneration: 1,
  credentialGeneration: 2,
  replacedCredentialId: "credential_runtime_1",
  credentialId: "credential_runtime_2",
  credentialPurpose: "runtime" as const,
  createdAt: "2026-08-08T00:01:00.000Z"
};

const replayedHostedRotation = {
  ...rotatedHostedRotation,
  replayed: true as const
};

function freshHostedRotation(
  rotation = rotatedHostedRotation,
  runnerToken = "runtime_new"
) {
  return { ...rotation, runnerToken, replayed: false as const };
}

const currentAfterLostRotation = {
  schemaVersion: 1 as const,
  protocolVersion: "1.0" as const,
  runnerId: "runner_hosted",
  registrationGeneration: 1,
  credentialGeneration: 2,
  activeCredentialId: "credential_runtime_2",
  credentialState: "active" as const,
  observedAt: "2026-08-08T00:03:00.000Z"
};

const successorRotationRequest = {
  ...hostedCredentialMutationRequest,
  requestId: "request_rotate_successor_1",
  operationId: "operation_rotate_successor_1",
  expectedCredentialGeneration: 2,
  expectedCredentialId: "credential_runtime_2"
};

const successorRotationMetadata = {
  ...rotatedHostedRotation,
  operationId: "operation_rotate_successor_1",
  credentialGeneration: 3,
  replacedCredentialId: "credential_runtime_2",
  credentialId: "credential_runtime_3",
  createdAt: "2026-08-08T00:04:00.000Z"
};

const rotatedHostedRegistration = {
  schemaVersion: rotatedHostedRotation.schemaVersion,
  protocolVersion: rotatedHostedRotation.protocolVersion,
  runnerId: rotatedHostedRotation.runnerId,
  registrationGeneration: rotatedHostedRotation.registrationGeneration,
  credentialGeneration: rotatedHostedRotation.credentialGeneration,
  credentialId: rotatedHostedRotation.credentialId,
  credentialPurpose: rotatedHostedRotation.credentialPurpose,
  createdAt: rotatedHostedRotation.createdAt
};

function hostedRevocation(operationId: string, registrationGeneration = 1) {
  return {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    operationId,
    runnerId: "runner_hosted",
    registrationGeneration,
    credentialGeneration: 2,
    credentialState: "revoked" as const,
    revokedCredentialId: "credential_runtime_1",
    credentialPurpose: "runtime" as const,
    activeCredentialId: null,
    revokedAt: "2026-08-08T00:02:00.000Z",
    replayed: false
  };
}

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

function hostedCredentialConflictConfig() {
  const paired = parseDaemonConfig({
    runnerId: "runner_hosted",
    runnerToken: "runtime_old",
    controlRegistration: hostedControl("paired")
  });
  return recordHostedCredentialConflict(
    markHostedCredentialRotationOutcomeUnknown(
      beginHostedCredentialRotation(paired, rotationInput())
    ),
    { replay: replayedHostedRotation, current: currentAfterLostRotation }
  );
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
      { ...hostedRegistration, createdAt: "2026-08-08T08:00:00.000+08:00" },
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

    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_staged",
      controlRegistration: hostedControl("credential_staged", hostedRegistration)
    })).not.toThrow();
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

  it("persists the complete non-secret rotation request and fails closed while unresolved", () => {
    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_old",
      controlRegistration: hostedControl("paired")
    });

    const pending = beginHostedCredentialRotation(paired, rotationInput());
    expect(pending.runnerToken).toBeUndefined();
    expect(pending.pairingToken).toBeUndefined();
    expect(pending.controlRegistration).toEqual({
      kind: "hosted_control_v1",
      state: "rotation_pending",
      endpoint: "rotate",
      origin: "paired",
      canonicalRequestDigest: hostedCredentialMutationDigest,
      request: hostedCredentialMutationRequest,
      registration: hostedRegistration
    });
    expect(runnerDispatcherToken(pending)).toBeUndefined();
    expect(() => createDaemonClient(pending)).toThrow(/rotation is pending/iu);

    const restarted = parseDaemonConfig(JSON.parse(JSON.stringify(pending)));
    const outcomeUnknown = markHostedCredentialRotationOutcomeUnknown(restarted);
    expect(outcomeUnknown.controlRegistration?.state).toBe("rotation_outcome_unknown");
    expect(outcomeUnknown.runnerToken).toBeUndefined();
    expect(runnerDispatcherToken(outcomeUnknown)).toBeUndefined();
  });

  it("stages a fresh rotation token for restart-safe local finalization", () => {
    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_old",
      controlRegistration: hostedControl("paired")
    });
    const pending = beginHostedCredentialRotation(paired, rotationInput());
    const staged = stageHostedCredentialRotation(pending, freshHostedRotation());
    expect(staged.controlRegistration?.state).toBe("rotation_staged");
    expect(staged.runnerToken).toBe("runtime_new");
    expect(runnerDispatcherToken(staged)).toBeUndefined();
    expect(() => createDaemonClient(staged)).toThrow(/rotation is staged/iu);

    const restarted = parseDaemonConfig(JSON.parse(JSON.stringify(staged)));
    const finalized = finalizeHostedCredentialRotation(restarted);
    expect(finalized.runnerToken).toBe("runtime_new");
    expect(finalized.controlRegistration).toEqual({
      kind: "hosted_control_v1",
      state: "paired",
      operationId: "operation_rotate_1",
      registration: rotatedHostedRegistration
    });
    expect(runnerDispatcherToken(finalized)).toBe("runtime_new");
  });

  it("persists revocation replay state and atomically removes token custody on confirmation", () => {
    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_old",
      controlRegistration: hostedControl("paired")
    });
    const request = {
      ...hostedCredentialMutationRequest,
      requestId: "request_revoke_1",
      operationId: "operation_revoke_1"
    };
    const pending = beginHostedCredentialRevocation(paired, revocationInput(request));
    expect(pending.runnerToken).toBeUndefined();
    expect(pending.controlRegistration).toMatchObject({ state: "revocation_pending", request });
    const unknown = markHostedCredentialRevocationOutcomeUnknown(
      parseDaemonConfig(JSON.parse(JSON.stringify(pending)))
    );
    expect(unknown.controlRegistration?.state).toBe("revocation_outcome_unknown");
    expect(runnerDispatcherToken(unknown)).toBeUndefined();

    const revoked = confirmHostedCredentialRevocation(unknown, hostedRevocation("operation_revoke_1"));
    expect(revoked.runnerToken).toBeUndefined();
    expect(revoked.controlRegistration).toMatchObject({
      state: "revoked",
      revocation: {
        registrationGeneration: 1,
        credentialGeneration: 2,
        revokedCredentialId: "credential_runtime_1"
      }
    });
    expect(parseDaemonConfig(JSON.parse(JSON.stringify(revoked)))).toEqual(revoked);
    expect(runnerDispatcherToken(revoked)).toBeUndefined();
    expect(() => createDaemonClient(revoked)).toThrow(/is revoked/iu);
  });

  it("records stale-credential conflicts with both expected and current credential metadata", () => {
    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_old",
      controlRegistration: hostedControl("paired")
    });
    const current = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      runnerId: "runner_hosted",
      registrationGeneration: 1,
      credentialGeneration: 2,
      activeCredentialId: "credential_runtime_2",
      credentialState: "active" as const,
      observedAt: "2026-08-08T00:03:00.000Z"
    };
    const outcomeUnknown = markHostedCredentialRotationOutcomeUnknown(
      beginHostedCredentialRotation(paired, rotationInput())
    );
    const conflict = recordHostedCredentialConflict(outcomeUnknown, {
      replay: replayedHostedRotation,
      current
    });
    expect(conflict.runnerToken).toBeUndefined();
    expect(conflict.controlRegistration).toEqual({
      kind: "hosted_control_v1",
      state: "credential_conflict",
      endpoint: "rotate",
      canonicalRequestDigest: hostedCredentialMutationDigest,
      request: hostedCredentialMutationRequest,
      replay: replayedHostedRotation,
      current,
      successorAttempted: false,
      provenance: {
        origin: "lost_201_replay",
        source: "verified_metadata_replay_and_current_state"
      }
    });
    expect(runnerDispatcherToken(conflict)).toBeUndefined();
  });

  it("derives credential-conflict authority only from a verified rotation replay", () => {
    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_old",
      controlRegistration: hostedControl("paired")
    });
    expect(() => recordHostedCredentialConflict(paired, {
      replay: replayedHostedRotation,
      current: currentAfterLostRotation
    })).toThrow(/authoritative rotation outcome-unknown/iu);

    const revocationUnknown = markHostedCredentialRevocationOutcomeUnknown(
      beginHostedCredentialRevocation(paired, revocationInput())
    );
    expect(() => recordHostedCredentialConflict(revocationUnknown, {
      replay: replayedHostedRotation,
      current: currentAfterLostRotation
    })).toThrow(/authoritative rotation outcome-unknown/iu);
    const directlyRevoked = confirmHostedCredentialRevocation(
      revocationUnknown,
      { ...hostedRevocation("operation_rotate_1"), replayed: true }
    );
    expect(directlyRevoked.controlRegistration?.state).toBe("revoked");
  });

  it("keeps credential conflict independent and permits exactly one fresh successor", () => {
    const conflict = parseDaemonConfig(JSON.parse(JSON.stringify(hostedCredentialConflictConfig())));
    expect(conflict.controlRegistration?.state).toBe("credential_conflict");
    expect(hostedCredentialOperationProblem(conflict.controlRegistration, "reprovision")).toMatch(/requires/iu);
    expect(runnerDispatcherToken(conflict)).toBeUndefined();

    const successor = beginHostedCredentialRotationSuccessor(conflict, {
      request: successorRotationRequest
    });
    expect(successor.controlRegistration).toMatchObject({
      state: "rotation_pending",
      origin: "lost_201_successor",
      request: successorRotationRequest,
      predecessorConflict: {
        originalRequest: hostedCredentialMutationRequest,
        replay: replayedHostedRotation,
        current: currentAfterLostRotation,
        successorAttempted: true,
        provenance: {
          origin: "lost_201_replay",
          source: "verified_metadata_replay_and_current_state"
        }
      }
    });
    expect(() => beginHostedCredentialRotationSuccessor(successor, {
      request: successorRotationRequest
    })).toThrow(/unattempted credential-conflict/iu);

    const staged = stageHostedCredentialRotation(
      parseDaemonConfig(JSON.parse(JSON.stringify(successor))),
      freshHostedRotation(successorRotationMetadata, "runtime_successor")
    );
    const finalized = finalizeHostedCredentialRotation(
      parseDaemonConfig(JSON.parse(JSON.stringify(staged)))
    );
    expect(finalized.runnerToken).toBe("runtime_successor");
    expect(finalized.controlRegistration).toMatchObject({
      state: "paired",
      registration: {
        registrationGeneration: 1,
        credentialGeneration: 3,
        credentialId: "credential_runtime_3"
      }
    });
  });

  it("persists successor transport uncertainty until a strict replay proves terminal recovery", () => {
    const successor = beginHostedCredentialRotationSuccessor(
      hostedCredentialConflictConfig(),
      { request: successorRotationRequest }
    );
    const outcomeUnknown = markHostedCredentialRotationOutcomeUnknown(
      parseDaemonConfig(JSON.parse(JSON.stringify(successor)))
    );
    expect(outcomeUnknown.controlRegistration).toMatchObject({
      state: "rotation_outcome_unknown",
      origin: "lost_201_successor",
      predecessorConflict: { successorAttempted: true }
    });
    expect(parseDaemonConfig(JSON.parse(JSON.stringify(outcomeUnknown)))).toEqual(outcomeUnknown);
    expect(() => beginHostedCredentialRotationSuccessor(outcomeUnknown, {
      request: successorRotationRequest
    })).toThrow(/unattempted credential-conflict/iu);
    const stagedFromFreshReplay = stageHostedCredentialRotation(
      parseDaemonConfig(JSON.parse(JSON.stringify(outcomeUnknown))),
      freshHostedRotation(successorRotationMetadata, "runtime_successor_replayed_fresh")
    );
    const finalizedFromFreshReplay = finalizeHostedCredentialRotation(
      parseDaemonConfig(JSON.parse(JSON.stringify(stagedFromFreshReplay)))
    );
    expect(finalizedFromFreshReplay.runnerToken).toBe("runtime_successor_replayed_fresh");
    expect(finalizedFromFreshReplay.controlRegistration).toMatchObject({
      state: "paired",
      registration: {
        registrationGeneration: 1,
        credentialGeneration: 3,
        credentialId: "credential_runtime_3"
      }
    });
    const successorReplay = { ...successorRotationMetadata, replayed: true as const };
    expect(() => stageHostedCredentialRotation(
      outcomeUnknown,
      successorReplay as never
    )).toThrow();
    const terminal = reconcileHostedCredentialRotationSuccessorReplay(
      outcomeUnknown,
      successorReplay
    );
    expect(terminal.controlRegistration).toMatchObject({
      state: "unpaired",
      reason: "recovery_required",
      recoveryReason: "successor_replay_without_token",
      successorRequest: successorRotationRequest,
      successorReplay
    });
    expect(hostedCredentialOperationProblem(terminal.controlRegistration, "reprovision")).toBeUndefined();
    expect(parseDaemonConfig(JSON.parse(JSON.stringify(terminal)))).toEqual(terminal);

    const mismatchTerminal = reconcileHostedCredentialRotationSuccessorReplay(
      outcomeUnknown,
      { ...successorReplay, operationId: "operation_wrong_successor" }
    );
    expect(mismatchTerminal.controlRegistration).toMatchObject({
      state: "unpaired",
      recoveryReason: "successor_replay_mismatch"
    });

    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_old",
      controlRegistration: hostedControl("paired")
    });
    const rotationUnknown = markHostedCredentialRotationOutcomeUnknown(
      beginHostedCredentialRotation(paired, rotationInput())
    );
    const replayMismatch = recordHostedCredentialConflict(rotationUnknown, {
      replay: { ...replayedHostedRotation, operationId: "operation_other" },
      current: currentAfterLostRotation
    });
    expect(replayMismatch.controlRegistration).toMatchObject({
      state: "unpaired",
      recoveryReason: "replay_mismatch"
    });
    expect(hostedCredentialOperationProblem(replayMismatch.controlRegistration, "reprovision")).toBeUndefined();

    const currentUnsafe = recordHostedCredentialConflict(rotationUnknown, {
      replay: replayedHostedRotation,
      current: {
        ...currentAfterLostRotation,
        credentialState: "revoked",
        activeCredentialId: null
      }
    });
    expect(currentUnsafe.controlRegistration).toMatchObject({
      state: "unpaired",
      recoveryReason: "current_state_unsafe"
    });
  });

  it("records membership and current-read failures as redacted terminal evidence", () => {
    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_old",
      controlRegistration: hostedControl("paired")
    });
    const rotationUnknown = markHostedCredentialRotationOutcomeUnknown(
      beginHostedCredentialRotation(paired, rotationInput())
    );
    const membershipFailure = recordHostedCredentialReconciliationFailure(rotationUnknown, {
      reason: "membership_verification_failed",
      code: "membership_unavailable"
    });
    expect(membershipFailure.controlRegistration).toMatchObject({
      state: "unpaired",
      recoveryReason: "membership_verification_failed",
      evidence: {
        kind: "reconciliation_failure",
        failure: {
          reason: "membership_verification_failed",
          code: "membership_unavailable"
        },
        provenance: {
          origin: "lost_201_reconciliation",
          source: "redacted_local_failure"
        }
      }
    });
    expect(JSON.stringify(membershipFailure)).not.toMatch(/token|stack|message/iu);

    const currentFailure = recordHostedCredentialReconciliationFailure(rotationUnknown, {
      reason: "current_state_read_failed",
      code: "invalid_response"
    });
    expect(currentFailure.controlRegistration).toMatchObject({
      recoveryReason: "current_state_read_failed",
      evidence: { failure: { code: "invalid_response" } }
    });
    expect(() => recordHostedCredentialReconciliationFailure(rotationUnknown, {
      reason: "membership_verification_failed",
      code: "current_state_unavailable"
    })).toThrow(/code does not match/iu);
  });

  it("stages only a complete fresh 201 response", () => {
    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_old",
      controlRegistration: hostedControl("paired")
    });
    const pending = beginHostedCredentialRotation(paired, rotationInput());
    const outcomeUnknown = markHostedCredentialRotationOutcomeUnknown(pending);
    expect(stageHostedCredentialRotation(
      outcomeUnknown,
      freshHostedRotation()
    ).runnerToken).toBe("runtime_new");
    expect(() => stageHostedCredentialRotation(
      outcomeUnknown,
      replayedHostedRotation as never
    )).toThrow();
    expect(() => stageHostedCredentialRotation(
      pending,
      replayedHostedRotation as never
    )).toThrow();
    expect(() => stageHostedCredentialRotation(
      pending,
      { rotation: rotatedHostedRotation, runnerToken: "runtime_old" } as never
    )).toThrow();
    expect(stageHostedCredentialRotation(pending, freshHostedRotation()).runnerToken).toBe("runtime_new");
  });

  it("rejects nested lifecycle identity, successor tuple, and terminal-field corruption", () => {
    const conflict = hostedCredentialConflictConfig();
    const successor = beginHostedCredentialRotationSuccessor(conflict, {
      request: successorRotationRequest
    });
    for (const mutate of [
      (raw: any) => { raw.controlRegistration.predecessorConflict.originalRequest.runnerId = "runner_other"; },
      (raw: any) => { raw.controlRegistration.predecessorConflict.replay.runnerId = "runner_other"; },
      (raw: any) => { raw.controlRegistration.predecessorConflict.current.runnerId = "runner_other"; },
      (raw: any) => {
        raw.controlRegistration.request.operationId = hostedCredentialMutationRequest.operationId;
        raw.controlRegistration.canonicalRequestDigest = hostedCredentialMutationRequestDigest(
          raw.controlRegistration.request
        );
      },
      (raw: any) => {
        raw.controlRegistration.request.expectedCredentialId = "credential_other";
        raw.controlRegistration.canonicalRequestDigest = hostedCredentialMutationRequestDigest(
          raw.controlRegistration.request
        );
      }
    ]) {
      const raw = JSON.parse(JSON.stringify(successor));
      mutate(raw);
      expect(() => parseDaemonConfig(raw)).toThrow();
    }

    const successorUnknown = markHostedCredentialRotationOutcomeUnknown(successor);
    const successorTerminal = reconcileHostedCredentialRotationSuccessorReplay(
      successorUnknown,
      { ...successorRotationMetadata, replayed: true }
    );
    const corruptedSuccessorTerminal = JSON.parse(JSON.stringify(successorTerminal));
    corruptedSuccessorTerminal.controlRegistration.successorReplay.runnerId = "runner_other";
    expect(() => parseDaemonConfig(corruptedSuccessorTerminal)).toThrow(/runnerId|successor/iu);
    const corruptedSuccessorTuple = JSON.parse(JSON.stringify(successorTerminal));
    corruptedSuccessorTuple.controlRegistration.successorRequest.expectedCredentialId = "credential_other";
    corruptedSuccessorTuple.controlRegistration.successorCanonicalRequestDigest =
      hostedCredentialMutationRequestDigest(corruptedSuccessorTuple.controlRegistration.successorRequest);
    expect(() => parseDaemonConfig(corruptedSuccessorTuple)).toThrow(/successor/iu);

    const normalUnknown = markHostedCredentialRotationOutcomeUnknown(
      beginHostedCredentialRotation(
        parseDaemonConfig({
          runnerId: "runner_hosted",
          runnerToken: "runtime_old",
          controlRegistration: hostedControl("paired")
        }),
        rotationInput()
      )
    );
    const nonSuccessorTerminal = recordHostedCredentialReconciliationFailure(normalUnknown, {
      reason: "current_state_read_failed",
      code: "current_state_unavailable"
    });
    expect(() => parseDaemonConfig({
      ...nonSuccessorTerminal,
      controlRegistration: {
        ...nonSuccessorTerminal.controlRegistration,
        successorRequest: successorRotationRequest,
        successorCanonicalRequestDigest: hostedCredentialMutationRequestDigest(successorRotationRequest)
      }
    })).toThrow(/unrecognized/iu);
    const corruptedFailureCode = JSON.parse(JSON.stringify(nonSuccessorTerminal));
    corruptedFailureCode.controlRegistration.evidence.failure.code = "membership_unavailable";
    expect(() => parseDaemonConfig(corruptedFailureCode)).toThrow(/redacted code/iu);
  });

  it("binds every persisted mutation digest to the canonical strict request", () => {
    const wrongDigest = `sha256:${"f".repeat(64)}`;
    const paired = parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_old",
      controlRegistration: hostedControl("paired")
    });
    expect(() => beginHostedCredentialRotation(paired, {
      request: hostedCredentialMutationRequest,
      canonicalRequestDigest: wrongDigest
    })).toThrow(/digest does not match/iu);
    expect(() => beginHostedCredentialRevocation(paired, {
      request: hostedCredentialMutationRequest,
      canonicalRequestDigest: wrongDigest
    })).toThrow(/digest does not match/iu);

    const conflict = hostedCredentialConflictConfig();
    expect(() => parseDaemonConfig({
      ...conflict,
      controlRegistration: {
        ...conflict.controlRegistration,
        canonicalRequestDigest: wrongDigest
      }
    })).toThrow(/digest must match/iu);
    expect(() => beginHostedCredentialRotationSuccessor(conflict, {
      request: successorRotationRequest,
      canonicalRequestDigest: wrongDigest
    })).toThrow(/digest does not match/iu);
  });

  it("rejects revoked snapshots whose pre-revocation tuple is corrupted", () => {
    const revoked = confirmHostedCredentialRevocation(
      beginHostedCredentialRevocation(
        parseDaemonConfig({
          runnerId: "runner_hosted",
          runnerToken: "runtime_old",
          controlRegistration: hostedControl("paired")
        }),
        revocationInput()
      ),
      hostedRevocation("operation_rotate_1")
    );
    const control = revoked.controlRegistration;
    if (!control || control.state !== "revoked") throw new Error("Expected revoked fixture.");
    for (const registration of [
      { ...control.registration, registrationGeneration: 2 },
      { ...control.registration, credentialGeneration: 2 },
      { ...control.registration, credentialId: "credential_other" }
    ]) {
      expect(() => parseDaemonConfig({
        ...revoked,
        controlRegistration: { ...control, registration }
      })).toThrow(/revocation metadata must advance/iu);
    }
  });

  it("allows rotate and revoke only from paired, while revoked permits only re-provision", () => {
    const paired = hostedControl("paired");
    expect(hostedCredentialOperationProblem(paired, "rotate")).toBeUndefined();
    expect(hostedCredentialOperationProblem(paired, "revoke")).toBeUndefined();
    expect(hostedCredentialOperationProblem(paired, "reprovision")).toMatch(/requires/iu);

    const revoked = confirmHostedCredentialRevocation(
      beginHostedCredentialRevocation(
        parseDaemonConfig({
          runnerId: "runner_hosted",
          runnerToken: "runtime_old",
          controlRegistration: paired
        }),
        revocationInput({
          ...hostedCredentialMutationRequest,
          operationId: "operation_revoke_1"
        })
      ),
      hostedRevocation("operation_revoke_1")
    );
    expect(hostedCredentialOperationProblem(revoked.controlRegistration, "reprovision")).toBeUndefined();
    expect(hostedCredentialOperationProblem(revoked.controlRegistration, "rotate")).toMatch(/paired/iu);
    expect(hostedCredentialOperationProblem(revoked.controlRegistration, "revoke")).toMatch(/paired/iu);
    expect(() => beginHostedCredentialRotation(revoked, rotationInput())).toThrow(/paired/iu);
  });

  it("rejects unknown mutation fields, secrets in fail-closed states, and invalid generation transitions", () => {
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "rotation_pending",
        endpoint: "rotate",
        origin: "paired",
        canonicalRequestDigest: hostedCredentialMutationDigest,
        request: { ...hostedCredentialMutationRequest, operatorToken: "must_not_persist" },
        registration: hostedRegistration
      }
    })).toThrow(/unrecognized/iu);
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "must_not_survive",
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "revocation_outcome_unknown",
        endpoint: "revoke",
        canonicalRequestDigest: hostedCredentialMutationDigest,
        request: hostedCredentialMutationRequest,
        registration: hostedRegistration
      }
    })).toThrow(/must not contain a runtime runner token/iu);
    expect(() => parseDaemonConfig({
      runnerId: "runner_hosted",
      runnerToken: "runtime_current",
      runnerTokens: ["runtime_old_grace_token"],
      controlRegistration: hostedControl("paired")
    })).toThrow(/must not retain fallback runner tokens/iu);

    const pending = beginHostedCredentialRotation(
      parseDaemonConfig({
        runnerId: "runner_hosted",
        runnerToken: "runtime_old",
        controlRegistration: hostedControl("paired")
      }),
      rotationInput()
    );
    expect(() => stageHostedCredentialRotation(
      pending,
      freshHostedRotation({ ...rotatedHostedRotation, credentialGeneration: 3 })
    )).toThrow(/advance only the credential generation/iu);
    expect(() => confirmHostedCredentialRevocation(
      beginHostedCredentialRevocation(
        parseDaemonConfig({
          runnerId: "runner_hosted",
          runnerToken: "runtime_old",
          controlRegistration: hostedControl("paired")
        }),
        revocationInput()
      ),
      hostedRevocation("operation_rotate_1", 2)
    )).toThrow(/advance only the credential generation/iu);
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
