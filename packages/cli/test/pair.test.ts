import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readCliConfig,
  readCliRawConfig,
  writeCliConfigAtomic,
  writeHostedControlConfigAtomic
} from "../src/config.js";
import { formatPairRelaySummary, inferRelayProvider, normalizeRelayUrl, runPairCommand } from "../src/pair.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function githubConfig() {
  return createSetupConfig({
    language: "en",
    platform: "github",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    github: {
      token: "ghp_token",
      webhookSecret: "github_webhook_secret",
      owner: "acme",
      repo: "demo",
      webhookPath: "/github/webhooks",
      autoCreatePullRequest: false,
      port: 3050
    }
  });
}

function gitlabConfig() {
  return createSetupConfig({
    language: "en",
    platform: "gitlab",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    gitlab: {
      token: "glpat_token",
      webhookSecret: "gitlab_webhook_secret",
      projectPathWithNamespace: "acme/team/demo",
      baseUrl: "https://gitlab.example.com",
      webhookPath: "/gitlab/webhooks",
      port: 3060
    }
  });
}

function linearConfig() {
  return createSetupConfig({
    language: "en",
    platform: "linear",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    linear: {
      token: "lin_api_token",
      webhookSecret: "linear_webhook_secret",
      webhookPath: "/linear/webhooks",
      port: 3070
    }
  });
}

function discordWebhookConfig() {
  return createSetupConfig({
    language: "en",
    platform: "discord",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    discord: {
      mode: "webhook",
      publicKey: "discord_public_key",
      botToken: "discord_bot_token",
      webhookPath: "/discord/interactions"
    }
  });
}

function discordGatewayConfig() {
  return createSetupConfig({
    language: "en",
    platform: "discord",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    discord: {
      mode: "gateway",
      botToken: "discord_bot_token"
    }
  });
}

function okFetch(): typeof fetch {
  return vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch;
}

function relayCapabilityFetch(platforms: unknown[]): typeof fetch {
  return vi.fn(async (url) => {
    const href = String(url);
    if (href.endsWith("/healthz")) return Response.json({ ok: true });
    if (href.endsWith("/v1/relay/capabilities")) {
      return Response.json({
        schemaVersion: 1,
        relay: true,
        platforms
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function responseAt(body: unknown, status: number, url: string): Response {
  const response = Response.json(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function controlCapabilities(capability: "relay.registration.v1" | "relay.credential-reprovision.v1") {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    registryVersion: "opentag.control.capabilities/v1",
    capabilities: [capability],
    minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
    deployment: { environment: "test", releaseSha: "a".repeat(40) }
  };
}

function credentialResponse(input: {
  operationId: string;
  replayed: boolean;
  runnerId?: string;
  registrationGeneration?: number;
  credentialGeneration?: number;
}) {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    operationId: input.operationId,
    organizationId: "org_1",
    runnerId: input.runnerId ?? "runner_local",
    registrationGeneration: input.registrationGeneration ?? 1,
    credentialGeneration: input.credentialGeneration ?? 1,
    credentialId: "credential_runtime_1",
    credentialPurpose: "runtime",
    createdAt: "2026-08-08T00:00:00.000Z",
    replayed: input.replayed,
    ...(input.replayed ? {} : { runnerToken: "runner_runtime_canary" })
  };
}

describe("OpenTag CLI pair relay", () => {
  it("normalizes and validates relay URLs", () => {
    expect(normalizeRelayUrl(" https://example.up.railway.app/ ")).toBe("https://example.up.railway.app");
    expect(inferRelayProvider("https://example.up.railway.app")).toBe("railway");
    expect(inferRelayProvider("https://relay.example")).toBe("custom");
    expect(() => normalizeRelayUrl("ftp://relay.example")).toThrow("Relay URL must use http or https.");
    expect(() => normalizeRelayUrl("https://relay.example?token=secret")).toThrow("Relay URL must not include a query string");
    expect(normalizeRelayUrl("http://localhost:8787/")).toBe("http://localhost:8787");
  });

  it("rejects public HTTP relay URLs before health checks", async () => {
    const configPath = join(tempDir(), "config.json");
    writeCliConfigAtomic(configPath, githubConfig());
    const fetchImpl = okFetch();

    await expect(
      runPairCommand(
        { config: configPath, relay: "http://relay.example", register: false },
        {
          fetchImpl
        }
      )
    ).rejects.toThrow("Relay URL must use HTTPS unless it points to localhost for local testing.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("updates config for relay mode without dropping existing runner and project target fields", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = githubConfig();
    writeCliConfigAtomic(configPath, source);
    const fetchImpl = okFetch();
    const output: string[] = [];

    await runPairCommand(
      { config: configPath, relay: "https://example.up.railway.app", register: false },
      {
        fetchImpl,
        logger: {
          log(message) {
            output.push(message);
          },
          warn(message) {
            output.push(message);
          }
        }
      }
    );

    const updated = readCliConfig(configPath);
    expect(updated.runtime).toEqual({
      mode: "relay",
      relayUrl: "https://example.up.railway.app",
      relayProvider: "railway"
    });
    expect(updated.daemon.dispatcherUrl).toBe("https://example.up.railway.app");
    expect(updated.daemon.runnerId).toBe(source.daemon.runnerId);
    expect(updated.daemon.repositories).toEqual(source.daemon.repositories);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.up.railway.app/healthz", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(output.join("\n")).toContain("GitHub webhook URL: https://example.up.railway.app/github/webhooks");
    expect(output.join("\n")).toContain("Registration: skipped");
    expect(output.join("\n")).toContain("Security: only pair with a relay you operate or trust");
  });

  it("registers the runner and configured bindings with the relay by default", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = githubConfig();
    source.daemon.channelBindings = [
      {
        provider: "github",
        accountId: "acme",
        conversationId: "demo",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    ];
    writeCliConfigAtomic(configPath, source);
    const calls: string[] = [];

    await runPairCommand(
      { config: configPath, relay: "https://relay.example" },
      {
        fetchImpl: okFetch(),
        bootstrapClient: {
          async registerRunner(name) {
            calls.push(`runner:${name}`);
          },
          async bindRepository(binding) {
            calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
          },
          async bindChannel(binding) {
            calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
          }
        },
        logger: {
          log() {},
          warn() {}
        }
      }
    );

    expect(calls).toEqual([
      "runner:runner_local",
      ...source.daemon.repositories.map((repository) => `repo:${repository.provider}:${repository.owner}/${repository.repo}`),
      "channel:github:acme/demo"
    ]);
  });

  it("does not switch config to relay mode when relay registration fails", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = githubConfig();
    writeCliConfigAtomic(configPath, source);

    await expect(
      runPairCommand(
        { config: configPath, relay: "https://relay.example" },
        {
          fetchImpl: okFetch(),
          bootstrapClient: {
            async registerRunner() {
              throw new Error("registration failed");
            },
            async bindRepository() {},
            async bindChannel() {}
          }
        }
      )
    ).rejects.toThrow("registration failed");

    expect(readCliConfig(configPath).daemon.dispatcherUrl).toBe(source.daemon.dispatcherUrl);
    expect(readCliConfig(configPath).runtime).toEqual(source.runtime);
  });

  it("fails before writing config when relay health is unavailable", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = githubConfig();
    writeCliConfigAtomic(configPath, source);

    await expect(
      runPairCommand(
        { config: configPath, relay: "https://relay.example", register: false },
        {
          fetchImpl: vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
        }
      )
    ).rejects.toThrow("Relay health check failed at https://relay.example/healthz.");
    expect(readCliConfig(configPath).daemon.dispatcherUrl).toBe(source.daemon.dispatcherUrl);
  });

  it("accepts a Linear relay when capabilities advertise the configured ingress", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = linearConfig();
    writeCliConfigAtomic(configPath, source);
    const fetchImpl = relayCapabilityFetch([
      {
        provider: "linear",
        ingress: {
          enabled: true,
          path: "/linear/webhooks",
          signatureVerification: "configured"
        },
        callback: { enabled: true },
        apply: { enabled: true }
      }
    ]);

    await runPairCommand(
      { config: configPath, relay: "https://relay.example", register: false },
      {
        fetchImpl,
        logger: {
          log() {},
          warn() {}
        }
      }
    );

    expect(readCliConfig(configPath).runtime).toEqual({
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://relay.example/v1/relay/capabilities", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("rejects a Linear relay when capabilities do not advertise Linear ingress", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = linearConfig();
    writeCliConfigAtomic(configPath, source);

    await expect(
      runPairCommand(
        { config: configPath, relay: "https://relay.example", register: false },
        {
          fetchImpl: relayCapabilityFetch([])
        }
      )
    ).rejects.toThrow("Relay https://relay.example is not ready for Linear at /linear/webhooks");

    expect(readCliConfig(configPath).daemon.dispatcherUrl).toBe(source.daemon.dispatcherUrl);
    expect(readCliConfig(configPath).runtime).toEqual(source.runtime);
  });

  it("rejects a Linear relay when capabilities advertise ingress without callback/apply readiness", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = linearConfig();
    writeCliConfigAtomic(configPath, source);

    let message = "";
    try {
      await runPairCommand(
        { config: configPath, relay: "https://relay.example", register: false },
        {
          fetchImpl: relayCapabilityFetch([
            {
              provider: "linear",
              ingress: {
                enabled: true,
                path: "/linear/webhooks",
                signatureVerification: "configured"
              },
              callback: {
                enabled: false,
                reason: "OPENTAG_LINEAR_API_KEY or OPENTAG_LINEAR_TOKEN is not configured."
              },
              apply: {
                enabled: false,
                reason: "OPENTAG_LINEAR_API_KEY or OPENTAG_LINEAR_TOKEN is not configured."
              }
            }
          ])
        }
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      "Relay https://relay.example is not ready for Linear at /linear/webhooks: OPENTAG_LINEAR_API_KEY or OPENTAG_LINEAR_TOKEN is not configured."
    );
    expect(message).toContain("OPENTAG_LINEAR_API_KEY=<Linear OAuth access token or raw lin_api_... key>");
    expect(message).toContain("OPENTAG_LINEAR_WEBHOOK_SECRET=<copy platforms.linear.webhookSecret from the local OpenTag config>");
    expect(message).toContain("OPENTAG_LINEAR_WEBHOOK_PATH=/linear/webhooks");
    expect(message).toContain(`OPENTAG_LINEAR_REPO_PROVIDER=${source.platforms.linear!.projectTarget.repoProvider}`);
    expect(message).toContain(`OPENTAG_LINEAR_REPO_OWNER=${source.platforms.linear!.projectTarget.owner}`);
    expect(message).toContain(`OPENTAG_LINEAR_REPO_NAME=${source.platforms.linear!.projectTarget.repo}`);
    expect(message).toContain("Secrets are intentionally not printed here.");
    expect(message).not.toContain("lin_api_token");
    expect(message).not.toContain("linear_webhook_secret");

    expect(readCliConfig(configPath).daemon.dispatcherUrl).toBe(source.daemon.dispatcherUrl);
    expect(readCliConfig(configPath).runtime).toEqual(source.runtime);
  });

  it("formats project targets and next steps", () => {
    const source = githubConfig();
    const checkoutPath = source.daemon.repositories[0]?.checkoutPath;

    const formatted = formatPairRelaySummary({
      configPath: "/tmp/config.json",
      config: source,
      relayUrl: "https://relay.example",
      registered: true
    });

    expect(formatted).toContain("github:acme/demo (hasWorkspacePath=yes)");
    expect(formatted).toContain("opentag service start");
    expect(checkoutPath).toBeTruthy();
    expect(formatted).not.toContain(checkoutPath);
  });

  it("includes the GitLab relay webhook URL when pairing a GitLab config", () => {
    const source = gitlabConfig();

    const formatted = formatPairRelaySummary({
      configPath: "/tmp/config.json",
      config: source,
      relayUrl: "https://relay.example",
      registered: true
    });

    expect(formatted).toContain("GitLab webhook URL: https://relay.example/gitlab/webhooks");
    expect(formatted).toContain("gitlab:acme/team/demo (hasWorkspacePath=yes)");
  });

  it("includes the Linear relay webhook URL when pairing a Linear config", () => {
    const source = linearConfig();

    const formatted = formatPairRelaySummary({
      configPath: "/tmp/config.json",
      config: source,
      relayUrl: "https://relay.example",
      registered: true
    });

    expect(formatted).toContain("Linear webhook URL: https://relay.example/linear/webhooks");
    expect(formatted).toContain("local:");
  });

  it("includes the Discord relay Interactions Endpoint URL only for webhook mode", () => {
    const webhook = formatPairRelaySummary({
      configPath: "/tmp/config.json",
      config: discordWebhookConfig(),
      relayUrl: "https://relay.example",
      registered: true
    });
    const gateway = formatPairRelaySummary({
      configPath: "/tmp/config.json",
      config: discordGatewayConfig(),
      relayUrl: "https://relay.example",
      registered: true
    });

    expect(webhook).toContain("Discord Interactions Endpoint URL: https://relay.example/discord/interactions");
    expect(gateway).not.toContain("Discord Interactions Endpoint URL:");
  });

  it("persists explicit trust and pending operation before strict hosted registration", async () => {
    const configPath = join(tempDir(), "config.json");
    writeCliConfigAtomic(configPath, githubConfig());
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url, init) => {
      requests.push({ url: String(url), init });
      expect(init?.redirect).toBe("manual");
      if (String(url).endsWith("/v1/relay/capabilities")) {
        const daemon = (readCliRawConfig(configPath) as {
          daemon: Record<string, unknown>;
        }).daemon;
        expect(daemon.trustedRelay).toEqual({
          schemaVersion: 1,
          origin: "https://control.example",
          authorizedAt: "2026-08-08T01:00:00.000Z",
          authorizationMethod: "explicit_cli"
        });
        expect(daemon.controlRegistration).toMatchObject({
          state: "unpaired",
          flow: "registration",
          operationId: "operation_hosted_1",
          reason: "pending"
        });
        return responseAt(
          controlCapabilities("relay.registration.v1"),
          200,
          "https://control.example/v1/relay/capabilities"
        );
      }
      expect(String(url)).toBe("https://control.example/v1/runners");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer .+/u);
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request:operation_hosted_1",
        operationId: "operation_hosted_1",
        runnerId: "runner_local",
        capabilities: []
      });
      return responseAt(
        credentialResponse({ operationId: "operation_hosted_1", replayed: false }),
        201,
        "https://control.example/v1/runners"
      );
    }) as unknown as typeof fetch;

    await runPairCommand(
      {
        config: configPath,
        relay: "https://CONTROL.example:443",
        trustRelayOrigin: "https://control.example"
      },
      {
        fetchImpl,
        randomUUID: () => "operation_hosted_1",
        now: () => new Date("2026-08-08T01:00:00.000Z"),
        logger: { log() {}, warn() {} }
      }
    );

    const saved = readCliConfig(configPath);
    expect(saved.daemon.controlRegistration?.state).toBe("paired");
    expect(saved.daemon.runnerToken).toBe("runner_runtime_canary");
    expect(saved.daemon.pairingToken).toBeUndefined();
    expect(requests.map((request) => request.url)).toEqual([
      "https://control.example/v1/relay/capabilities",
      "https://control.example/v1/runners"
    ]);
  });

  it("keeps a 200 hosted registration replay recovery-required and never paired", async () => {
    const configPath = join(tempDir(), "config.json");
    writeCliConfigAtomic(configPath, githubConfig());
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/v1/relay/capabilities")) {
        return responseAt(
          controlCapabilities("relay.registration.v1"),
          200,
          "https://control.example/v1/relay/capabilities"
        );
      }
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
        daemon: Record<string, unknown>;
      };
      raw.daemon.runnerToken = "runner_token_from_previous_attempt";
      writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
      return responseAt(
        credentialResponse({ operationId: "operation_replay_1", replayed: true }),
        200,
        "https://control.example/v1/runners"
      );
    }) as unknown as typeof fetch;

    await runPairCommand(
      {
        config: configPath,
        relay: "https://control.example",
        trustRelayOrigin: "https://control.example"
      },
      {
        fetchImpl,
        randomUUID: () => "operation_replay_1",
        now: () => new Date("2026-08-08T01:00:00.000Z"),
        logger: { log() {}, warn() {} }
      }
    );

    const saved = readCliConfig(configPath);
    expect(saved.daemon.controlRegistration).toMatchObject({
      state: "unpaired",
      reason: "recovery_required"
    });
    expect(saved.daemon.runnerToken).toBeUndefined();
    expect(saved.daemon.pairingToken).toBeUndefined();
    expect((readCliRawConfig(configPath) as {
      daemon: Record<string, unknown>;
    }).daemon).not.toHaveProperty("runnerToken");
  });

  it("fails replay recovery when a writer leaves the previous runner token on disk", async () => {
    const configPath = join(tempDir(), "config.json");
    writeCliConfigAtomic(configPath, githubConfig());
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/v1/relay/capabilities")) {
        return responseAt(
          controlCapabilities("relay.registration.v1"),
          200,
          "https://control.example/v1/relay/capabilities"
        );
      }
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
        daemon: Record<string, unknown>;
      };
      raw.daemon.runnerToken = "runner_token_must_be_removed";
      writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
      return responseAt(
        credentialResponse({ operationId: "operation_replay_writer_1", replayed: true }),
        200,
        "https://control.example/v1/runners"
      );
    }) as unknown as typeof fetch;
    const writeHostedConfig = vi.fn((
      path: string,
      patch: Parameters<typeof writeHostedControlConfigAtomic>[1],
      filesystem?: Parameters<typeof writeHostedControlConfigAtomic>[2]
    ) => {
      if (patch.runnerToken !== null) {
        writeHostedControlConfigAtomic(path, patch, filesystem);
        return;
      }
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const daemon = raw.daemon as Record<string, unknown>;
      raw.runtime = {
        mode: "relay",
        relayUrl: patch.relayUrl,
        ...(patch.relayProvider ? { relayProvider: patch.relayProvider } : {})
      };
      raw.daemon = {
        ...daemon,
        dispatcherUrl: patch.dispatcherUrl,
        controlRegistration: patch.controlRegistration,
        trustedRelay: patch.trustedRelay ?? daemon.trustedRelay
      };
      if (patch.removePairingToken) delete (raw.daemon as Record<string, unknown>).pairingToken;
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    });
    const logger = { log: vi.fn(), warn: vi.fn() };

    await expect(runPairCommand(
      {
        config: configPath,
        relay: "https://control.example",
        trustRelayOrigin: "https://control.example"
      },
      {
        fetchImpl,
        randomUUID: () => "operation_replay_writer_1",
        now: () => new Date("2026-08-08T01:00:00.000Z"),
        readRawConfig: (path) => JSON.parse(readFileSync(path, "utf8")),
        writeHostedConfig,
        logger
      }
    )).rejects.toThrow("Hosted Control V1 staged runner credential failed atomic config readback.");

    expect(logger.log).not.toHaveBeenCalled();
    expect((readCliRawConfig(configPath) as {
      daemon: Record<string, unknown>;
    }).daemon.runnerToken).toBe("runner_token_must_be_removed");
  });

  it("persists outcome_unknown without leaking a transport canary and reuses the operation", async () => {
    const configPath = join(tempDir(), "config.json");
    writeCliConfigAtomic(configPath, githubConfig());
    const secretCanary = "pairing_transport_secret_canary";
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/v1/relay/capabilities")) {
        return responseAt(
          controlCapabilities("relay.registration.v1"),
          200,
          "https://control.example/v1/relay/capabilities"
        );
      }
      throw new Error(secretCanary);
    }) as unknown as typeof fetch;

    let message = "";
    try {
      await runPairCommand(
        {
          config: configPath,
          relay: "https://control.example",
          trustRelayOrigin: "https://control.example"
        },
        {
          fetchImpl,
          randomUUID: () => "operation_unknown_1",
          now: () => new Date("2026-08-08T01:00:00.000Z")
        }
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("outcome is unknown");
    expect(message).not.toContain(secretCanary);
    expect(readCliConfig(configPath).daemon.controlRegistration).toMatchObject({
      operationId: "operation_unknown_1",
      reason: "outcome_unknown"
    });

    const randomUUID = vi.fn(() => "operation_must_not_be_generated");
    await expect(runPairCommand(
      { config: configPath, relay: "https://control.example" },
      { fetchImpl, randomUUID }
    )).rejects.toThrow("outcome is unknown");
    expect(randomUUID).not.toHaveBeenCalled();
    expect(readCliConfig(configPath).daemon.controlRegistration).toMatchObject({
      operationId: "operation_unknown_1",
      reason: "outcome_unknown"
    });
  });

  it("rejects trusted-origin rebinding before fetch, secret reads, clients, or writes", async () => {
    const raw = githubConfig() as unknown as Record<string, unknown>;
    const daemon = (raw.daemon as Record<string, unknown>);
    raw.runtime = { mode: "relay", relayUrl: "https://relay-a.example" };
    daemon.dispatcherUrl = "https://relay-a.example";
    daemon.trustedRelay = {
      schemaVersion: 1,
      origin: "https://relay-a.example",
      authorizedAt: "2026-08-08T00:00:00.000Z",
      authorizationMethod: "explicit_cli"
    };
    daemon.controlRegistration = {
      kind: "hosted_control_v1",
      state: "unpaired",
      flow: "registration",
      operationId: "operation_a",
      reason: "pending"
    };
    daemon.pairingToken = {
      kind: "file",
      path: "/must/not/read/pairing-secret-canary"
    };
    const fetchImpl = vi.fn();
    const readConfig = vi.fn(() => {
      throw new Error("secret resolver must not run");
    });
    const createControlClient = vi.fn();
    const writeHostedConfig = vi.fn();

    await expect(runPairCommand(
      { config: "/unused/config.json", relay: "https://relay-b.example" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readRawConfig: () => raw,
        readConfig,
        createControlClient: createControlClient as never,
        writeHostedConfig
      }
    )).rejects.toThrow("already bound to a different trusted relay origin");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
    expect(createControlClient).not.toHaveBeenCalled();
    expect(writeHostedConfig).not.toHaveBeenCalled();
  });

  it.each(["fresh registration", "recovery", "credential_staged"] as const)(
    "rejects hosted %s with --no-register before every side effect",
    async (scenario) => {
      const raw = githubConfig() as unknown as Record<string, unknown>;
      const daemon = raw.daemon as Record<string, unknown>;
      const options: Parameters<typeof runPairCommand>[0] = {
        config: "/unused/config.json",
        relay: "https://control.example",
        register: false
      };
      if (scenario === "fresh registration") {
        options.trustRelayOrigin = "https://control.example";
        daemon.pairingToken = {
          kind: "file",
          path: "/must/not/read/no-register-pairing-canary"
        };
      } else {
        raw.runtime = { mode: "relay", relayUrl: "https://control.example" };
        daemon.dispatcherUrl = "https://control.example";
        daemon.trustedRelay = {
          schemaVersion: 1,
          origin: "https://control.example",
          authorizedAt: "2026-08-08T00:00:00.000Z",
          authorizationMethod: "explicit_cli"
        };
        delete daemon.pairingToken;
        const registration = {
          schemaVersion: 1,
          protocolVersion: "1.0",
          organizationId: "org_1",
          runnerId: "runner_local",
          registrationGeneration: 1,
          credentialGeneration: 1,
          credentialId: "credential_runtime_1",
          credentialPurpose: "runtime",
          createdAt: "2026-08-08T00:00:00.000Z"
        };
        if (scenario === "recovery") {
          options.recover = "recovery_credential_1";
          daemon.controlRegistration = {
            kind: "hosted_control_v1",
            state: "unpaired",
            reason: "recovery_required",
            registration
          };
        } else {
          daemon.runnerToken = "staged_runner_token_canary";
          daemon.controlRegistration = {
            kind: "hosted_control_v1",
            state: "credential_staged",
            operationId: "operation_staged_1",
            registration
          };
        }
      }
      const fetchImpl = vi.fn();
      const createControlClient = vi.fn();
      const readConfig = vi.fn();
      const readRecoverySecret = vi.fn();
      const randomUUID = vi.fn();
      const writeHostedConfig = vi.fn();

      let message = "";
      try {
        await runPairCommand(options, {
          readRawConfig: () => raw,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          createControlClient: createControlClient as never,
          readConfig: readConfig as never,
          readRecoverySecret: readRecoverySecret as never,
          randomUUID: randomUUID as never,
          writeHostedConfig
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe(
        "--no-register is incompatible with Hosted Control V1 registration, recovery, and staged finalization."
      );
      expect(message).not.toContain("canary");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(createControlClient).not.toHaveBeenCalled();
      expect(readConfig).not.toHaveBeenCalled();
      expect(readRecoverySecret).not.toHaveBeenCalled();
      expect(randomUUID).not.toHaveBeenCalled();
      expect(writeHostedConfig).not.toHaveBeenCalled();
    }
  );

  it("reads the recovery secret only after trust and pending readback, then uses the exact endpoint", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = githubConfig();
    source.runtime = { mode: "relay", relayUrl: "https://control.example" };
    source.daemon.dispatcherUrl = "https://control.example";
    source.daemon.trustedRelay = {
      schemaVersion: 1,
      origin: "https://control.example",
      authorizedAt: "2026-08-08T00:00:00.000Z",
      authorizationMethod: "explicit_cli"
    };
    delete source.daemon.pairingToken;
    source.daemon.controlRegistration = {
      kind: "hosted_control_v1",
      state: "unpaired",
      reason: "recovery_required",
      registration: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        organizationId: "org_1",
        runnerId: source.daemon.runnerId,
        registrationGeneration: 1,
        credentialGeneration: 1,
        credentialId: "credential_runtime_1",
        credentialPurpose: "runtime",
        createdAt: "2026-08-08T00:00:00.000Z"
      }
    };
    writeCliConfigAtomic(configPath, source);
    const readRecoverySecret = vi.fn(() => "recovery_secret_canary");
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init?.redirect).toBe("manual");
      if (String(url).endsWith("/v1/relay/capabilities")) {
        expect(readRecoverySecret).not.toHaveBeenCalled();
        expect((readCliRawConfig(configPath) as {
          daemon: { controlRegistration: unknown };
        }).daemon.controlRegistration).toMatchObject({
          state: "unpaired",
          flow: "reprovision",
          operationId: "operation_recovery_1",
          reason: "pending",
          recoveryCredentialId: "recovery_credential_1"
        });
        return responseAt(
          controlCapabilities("relay.credential-reprovision.v1"),
          200,
          "https://control.example/v1/relay/capabilities"
        );
      }
      expect(String(url)).toBe(
        "https://control.example/v1/runners/runner_local/credentials/reprovision"
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer recovery_secret_canary"
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.credential-reprovision.v1"],
        requestId: "request:operation_recovery_1",
        operationId: "operation_recovery_1",
        runnerId: "runner_local",
        recoveryCredentialId: "recovery_credential_1",
        expectedRegistrationGeneration: 1,
        expectedCredentialGeneration: 1
      });
      return responseAt(
        credentialResponse({
          operationId: "operation_recovery_1",
          replayed: false,
          registrationGeneration: 2,
          credentialGeneration: 2
        }),
        201,
        "https://control.example/v1/runners/runner_local/credentials/reprovision"
      );
    }) as unknown as typeof fetch;

    await runPairCommand(
      {
        config: configPath,
        relay: "https://control.example",
        recover: "recovery_credential_1"
      },
      {
        fetchImpl,
        randomUUID: () => "operation_recovery_1",
        readRecoverySecret,
        logger: { log() {}, warn() {} }
      }
    );

    expect(readRecoverySecret).toHaveBeenCalledOnce();
    expect(readCliConfig(configPath).daemon.controlRegistration?.state).toBe("paired");
  });

  it("finalizes a durable staged credential locally after the paired write failed", async () => {
    const configPath = join(tempDir(), "config.json");
    writeCliConfigAtomic(configPath, githubConfig());
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/v1/relay/capabilities")) {
        return responseAt(
          controlCapabilities("relay.registration.v1"),
          200,
          "https://control.example/v1/relay/capabilities"
        );
      }
      return responseAt(
        credentialResponse({ operationId: "operation_crash_1", replayed: false }),
        201,
        "https://control.example/v1/runners"
      );
    }) as unknown as typeof fetch;
    const failPairedWrite = vi.fn((
      path: string,
      patch: Parameters<typeof writeHostedControlConfigAtomic>[1],
      filesystem?: Parameters<typeof writeHostedControlConfigAtomic>[2]
    ) => {
      if (patch.controlRegistration.state === "paired") {
        throw new Error("simulated paired write failure");
      }
      writeHostedControlConfigAtomic(path, patch, filesystem);
    });

    await expect(runPairCommand(
      {
        config: configPath,
        relay: "https://control.example",
        trustRelayOrigin: "https://control.example"
      },
      {
        fetchImpl,
        randomUUID: () => "operation_crash_1",
        now: () => new Date("2026-08-08T01:00:00.000Z"),
        writeHostedConfig: failPairedWrite,
        logger: { log() {}, warn() {} }
      }
    )).rejects.toThrow("simulated paired write failure");
    expect(readCliConfig(configPath).daemon).toMatchObject({
      runnerToken: "runner_runtime_canary",
      controlRegistration: {
        state: "credential_staged",
        operationId: "operation_crash_1",
        registration: { runnerId: "runner_local" }
      }
    });
    expect(readCliConfig(configPath).daemon.pairingToken).toBeUndefined();

    const retryFetch = vi.fn();
    const retryClient = vi.fn();
    const retryReadConfig = vi.fn(() => {
      throw new Error("SecretRef materialization must not run");
    });
    const retryRecoverySecret = vi.fn();
    const retryUuid = vi.fn(() => "operation_must_not_be_generated");
    await runPairCommand(
      { config: configPath, relay: "https://control.example" },
      {
        fetchImpl: retryFetch as unknown as typeof fetch,
        createControlClient: retryClient as never,
        readConfig: retryReadConfig,
        readRecoverySecret: retryRecoverySecret as never,
        randomUUID: retryUuid,
        logger: { log() {}, warn() {} }
      }
    );

    expect(readCliConfig(configPath).daemon.controlRegistration).toMatchObject({
      state: "paired",
      operationId: "operation_crash_1"
    });
    expect(readCliConfig(configPath).daemon.pairingToken).toBeUndefined();
    expect(retryFetch).not.toHaveBeenCalled();
    expect(retryClient).not.toHaveBeenCalled();
    expect(retryReadConfig).not.toHaveBeenCalled();
    expect(retryRecoverySecret).not.toHaveBeenCalled();
    expect(retryUuid).not.toHaveBeenCalled();
  });

  it.each([
    ["missing token", undefined, "runner_local"],
    ["SecretRef token", { kind: "env", name: "MUST_NOT_READ" }, "runner_local"],
    ["runner mismatch", "runner_runtime_canary", "runner_other"],
    ["extra uncertainty", "runner_runtime_canary", "runner_local"]
  ])("rejects corrupt staged state without writes: %s", async (_name, token, registrationRunnerId) => {
    const raw = githubConfig() as unknown as Record<string, unknown>;
    const daemon = raw.daemon as Record<string, unknown>;
    raw.runtime = { mode: "relay", relayUrl: "https://control.example" };
    daemon.dispatcherUrl = "https://control.example";
    daemon.trustedRelay = {
      schemaVersion: 1,
      origin: "https://control.example",
      authorizedAt: "2026-08-08T00:00:00.000Z",
      authorizationMethod: "explicit_cli"
    };
    delete daemon.pairingToken;
    if (token !== undefined) daemon.runnerToken = token;
    else delete daemon.runnerToken;
    daemon.controlRegistration = {
      kind: "hosted_control_v1",
      state: "credential_staged",
      operationId: "operation_staged_corrupt",
      registration: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        organizationId: "org_1",
        runnerId: registrationRunnerId,
        registrationGeneration: 1,
        credentialGeneration: 1,
        credentialId: "credential_runtime_1",
        credentialPurpose: "runtime",
        createdAt: "2026-08-08T00:00:00.000Z"
      }
    };
    if (_name === "extra uncertainty") {
      (daemon.controlRegistration as Record<string, unknown>).reason = "outcome_unknown";
    }
    const fetchImpl = vi.fn();
    const createControlClient = vi.fn();
    const readConfig = vi.fn();
    const readRecoverySecret = vi.fn();
    const randomUUID = vi.fn();
    const writeHostedConfig = vi.fn();

    await expect(runPairCommand(
      { config: "/unused/config.json", relay: "https://control.example" },
      {
        readRawConfig: () => raw,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        createControlClient: createControlClient as never,
        readConfig: readConfig as never,
        readRecoverySecret: readRecoverySecret as never,
        randomUUID: randomUUID as never,
        writeHostedConfig
      }
    )).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createControlClient).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
    expect(readRecoverySecret).not.toHaveBeenCalled();
    expect(randomUUID).not.toHaveBeenCalled();
    expect(writeHostedConfig).not.toHaveBeenCalled();
  });
});
