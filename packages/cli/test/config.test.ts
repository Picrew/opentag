import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfigPath,
  defaultStateDirectory,
  formatCliConfigError,
  parseCliConfig,
  readCliConfig,
  readKeychainSecret,
  readRedactedCliConfig,
  redactedCliConfig,
  relayUrlFromConfig,
  runtimeModeFromConfig,
  writeCliConfigAtomic,
  type OpenTagCliConfig
} from "../src/config.js";
import { legacyLarkConfigPath, readLegacyLarkCredentials } from "../src/platforms/lark/saved-config.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config(): OpenTagCliConfig {
  const projectPath = tempDir();
  return createSetupConfig({
    language: "en",
    platform: "lark",
    projectPath,
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    lark: {
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      botOpenId: "ou_bot",
      setupMethod: "scan",
      bindingMethod: "default_project"
    }
  });
}

describe("OpenTag CLI config", () => {
  it("resolves config and state paths from XDG-style environment", () => {
    const home = tempDir();
    expect(defaultConfigPath({ XDG_CONFIG_HOME: join(home, "xdg-config") }, home)).toBe(
      join(home, "xdg-config", "opentag", "config.json")
    );
    expect(defaultStateDirectory({ XDG_STATE_HOME: join(home, "xdg-state") }, home)).toBe(join(home, "xdg-state", "opentag"));
  });

  it("rejects empty config instead of filling daemon defaults", () => {
    expect(() => parseCliConfig({})).toThrow("schemaVersion");
  });

  it("rejects removed Claude direct-adapter configuration", () => {
    const source = config();
    expect(() => parseCliConfig({
      ...source,
      daemon: { ...source.daemon, claudeCode: { command: "claude" } }
    })).toThrow(/unrecognized/iu);
  });

  it("accepts OpenClaw ACP launch configuration", () => {
    const source = config();
    const parsed = parseCliConfig({
      ...source,
      daemon: {
        ...source.daemon,
        openclaw: {
          command: "/opt/openclaw/bin/openclaw",
          profile: "opentag",
          gatewayUrl: "ws://127.0.0.1:19093",
          expectedVersion: "2026.7.2"
        }
      }
    });

    expect(parsed.daemon.openclaw).toEqual({
      command: "/opt/openclaw/bin/openclaw",
      profile: "opentag",
      gatewayUrl: "ws://127.0.0.1:19093",
      expectedVersion: "2026.7.2"
    });
  });

  it("accepts strict GitHub completion policies in daemon JSON", () => {
    const source = config();
    const parsed = parseCliConfig({
      ...source,
      daemon: {
        ...source.daemon,
        completionPolicies: [
          {
            provider: "github",
            owner: " acme ",
            repo: " demo ",
            requiredChecks: [" build ", "test"],
            baseBranch: " main ",
            requireMerge: true
          }
        ]
      }
    });

    expect(parsed.daemon.completionPolicies).toEqual([
      {
        provider: "github",
        owner: "acme",
        repo: "demo",
        requiredChecks: ["build", "test"],
        baseBranch: "main",
        requireMerge: true
      }
    ]);
  });

  it("rejects invalid GitHub completion policies with a config path", () => {
    const source = config();
    let error: unknown;
    try {
      parseCliConfig({
        ...source,
        daemon: {
          ...source.daemon,
          completionPolicies: [
            {
              provider: "github",
              owner: "acme",
              repo: "demo",
              requiredChecks: []
            }
          ]
        }
      });
    } catch (caught) {
      error = caught;
    }

    expect(formatCliConfigError(error)).toContain("daemon.completionPolicies.0.requiredChecks");
  });

  it("writes config atomically with private file permissions", () => {
    const path = join(tempDir(), "config.json");
    const expected = config();

    writeCliConfigAtomic(path, expected);

    expect(readCliConfig(path)).toEqual(expected);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("parses explicit relay runtime without dropping daemon fields", () => {
    const source = config();
    const parsed = parseCliConfig({
      ...source,
      runtime: {
        mode: "relay",
        relayUrl: "https://example.up.railway.app",
        relayProvider: "railway"
      },
      daemon: {
        ...source.daemon,
        dispatcherUrl: "https://example.up.railway.app"
      }
    });

    expect(runtimeModeFromConfig(parsed)).toBe("relay");
    expect(relayUrlFromConfig(parsed)).toBe("https://example.up.railway.app");
    expect(parsed.daemon.runnerId).toBe(source.daemon.runnerId);
    expect(parsed.daemon.repositories).toEqual(source.daemon.repositories);
  });

  it("treats legacy configs without runtime as local mode", () => {
    const source = config();
    const parsed = parseCliConfig({
      ...source,
      runtime: undefined
    });

    expect(runtimeModeFromConfig(parsed)).toBe("local");
    expect(relayUrlFromConfig(parsed)).toBeUndefined();
  });

  it("accepts a repository-free managed Slack channel backed by an ACP agent", () => {
    const source = config();
    const parsed = parseCliConfig({
      ...source,
      daemon: {
        ...source.daemon,
        repositories: [],
        agents: {
          reviewer: {
            label: "Review Agent",
            command: "review-agent",
            args: ["acp"],
            workspaceCwd: "required"
          }
        },
        channelBindings: [
          {
            provider: "slack",
            accountId: "T123",
            conversationId: "C123",
            ownership: {
              mode: "managed",
              exclusive: true,
              applicationId: "A123",
              botId: "U123"
            }
          }
        ]
      },
      platforms: {
        slack: {
          mode: "socket_mode",
          appToken: "xapp-token",
          botToken: "xoxb-token",
          appId: "A123",
          teamId: "T123",
          channelId: "C123"
        }
      }
    });

    expect(parsed.daemon.repositories).toEqual([]);
    expect(parsed.daemon.agents.reviewer).toMatchObject({
      label: "Review Agent",
      command: "review-agent",
      args: ["acp"],
      workspaceCwd: "required",
      supportsCancel: false
    });
    expect(parsed.daemon.channelBindings).toEqual([
      {
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        ownership: {
          mode: "managed",
          exclusive: true,
          applicationId: "A123",
          botId: "U123"
        }
      }
    ]);
  });

  it("rejects a repository-free channel binding with only part of a repository target", () => {
    const source = config();
    expect(() =>
      parseCliConfig({
        ...source,
        daemon: {
          ...source.daemon,
          repositories: [],
          channelBindings: [
            {
              provider: "slack",
              accountId: "T123",
              conversationId: "C123",
              repoProvider: "github"
            }
          ]
        }
      })
    ).toThrow("repoProvider, owner, and repo must be provided together");
  });

  it("does not chmod an existing custom config directory", () => {
    const parent = tempDir();
    chmodSync(parent, 0o755);
    const beforeMode = statSync(parent).mode & 0o777;
    const path = join(parent, "config.json");

    writeCliConfigAtomic(path, config());

    expect(statSync(parent).mode & 0o777).toBe(beforeMode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to read config files that expose secrets to group or others", () => {
    const path = join(tempDir(), "config.json");
    writeFileSync(path, `${JSON.stringify(config())}\n`, { mode: 0o600 });
    chmodSync(path, 0o644);

    expect(() => readCliConfig(path)).toThrow(`Fix it with: chmod 600 ${path}`);
  });

  it("refuses to reuse legacy Lark credentials from a non-private file", () => {
    const projectPath = tempDir();
    const path = legacyLarkConfigPath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ appId: "cli_test", appSecret: "secret_test", domain: "lark" }), { mode: 0o600 });
    chmodSync(path, 0o644);

    expect(() => readLegacyLarkCredentials(projectPath)).toThrow(`Fix it with: chmod 600 ${path}`);
  });

  it("reuses legacy Lark credentials from a private file", () => {
    const projectPath = tempDir();
    const path = legacyLarkConfigPath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ appId: "cli_test", appSecret: "secret_test", domain: "lark" }), { mode: 0o600 });
    chmodSync(path, 0o600);

    expect(readLegacyLarkCredentials(projectPath)).toMatchObject({
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      source: "legacy_start_lark",
      path
    });
  });

  it("redacts secrets in config output", () => {
    const source = config();
    source.daemon.githubApplyToken = "apply_secret";
    source.daemon.runnerToken = "runner_secret";
    source.daemon.runnerTokens = ["runner_old_secret"];
    source.platforms.telegram = {
      mode: "webhook",
      botId: "123456789",
      botToken: "telegram_bot_secret",
      secretToken: "telegram_webhook_secret"
    };
    source.platforms.discord = {
      mode: "webhook",
      publicKey: "discord_public_key",
      botToken: "discord_bot_secret",
      webhookPath: "/discord/interactions"
    };
    source.platforms.linear = {
      token: "linear_api_secret",
      auth: {
        method: "oauth_app",
        actor: "app",
        clientId: "linear_client_id",
        clientSecret: "linear_client_secret",
        refreshToken: "linear_refresh_secret"
      },
      webhookSecret: "linear_webhook_secret",
      webhookPath: "/linear/webhooks",
      projectTarget: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    };
    const redacted = redactedCliConfig(source);

    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
    expect(JSON.stringify(redacted)).not.toContain("secret_test");
    expect(JSON.stringify(redacted)).not.toContain("apply_secret");
    expect(JSON.stringify(redacted)).not.toContain("runner_secret");
    expect(JSON.stringify(redacted)).not.toContain("runner_old_secret");
    expect(JSON.stringify(redacted)).not.toContain("telegram_bot_secret");
    expect(JSON.stringify(redacted)).not.toContain("telegram_webhook_secret");
    expect(JSON.stringify(redacted)).not.toContain("discord_bot_secret");
    expect(JSON.stringify(redacted)).not.toContain("linear_api_secret");
    expect(JSON.stringify(redacted)).not.toContain("linear_client_secret");
    expect(JSON.stringify(redacted)).not.toContain("linear_refresh_secret");
    expect(JSON.stringify(redacted)).not.toContain("linear_webhook_secret");
    expect(JSON.stringify(redacted)).toContain("linear_client_id");
    expect(JSON.stringify(redacted)).toContain("discord_public_key");
  });

  it("resolves env secret refs when reading runtime config", () => {
    const previous = process.env.OPENTAG_TEST_LARK_SECRET;
    process.env.OPENTAG_TEST_LARK_SECRET = "secret_from_env";
    try {
      const source = config();
      const parsed = parseCliConfig({
        ...source,
        platforms: {
          ...source.platforms,
          lark: {
            ...source.platforms.lark!,
            appSecret: { kind: "env", name: "OPENTAG_TEST_LARK_SECRET" }
          }
        }
      });

      expect(parsed.platforms.lark?.appSecret).toBe("secret_from_env");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENTAG_TEST_LARK_SECRET;
      } else {
        process.env.OPENTAG_TEST_LARK_SECRET = previous;
      }
    }
  });

  it("resolves file secret refs when reading runtime config", () => {
    const secretPath = join(tempDir(), "lark-secret.txt");
    writeFileSync(secretPath, "secret_from_file\n", { mode: 0o600 });
    const source = config();
    const parsed = parseCliConfig({
      ...source,
      platforms: {
        ...source.platforms,
        lark: {
          ...source.platforms.lark!,
          appSecret: { kind: "file", path: secretPath }
        }
      }
    });

    expect(parsed.platforms.lark?.appSecret).toBe("secret_from_file");
  });

  it("rejects file secret refs that cannot resolve to a non-empty value", () => {
    const emptySecretPath = join(tempDir(), "empty-lark-secret.txt");
    writeFileSync(emptySecretPath, "\n", { mode: 0o600 });
    const missingSecretPath = join(tempDir(), "missing-lark-secret.txt");
    const source = config();

    expect(() =>
      parseCliConfig({
        ...source,
        platforms: {
          ...source.platforms,
          lark: {
            ...source.platforms.lark!,
            appSecret: { kind: "file", path: emptySecretPath }
          }
        }
      })
    ).toThrow(`Secret file ref ${emptySecretPath} resolved to an empty value.`);

    expect(() =>
      parseCliConfig({
        ...source,
        platforms: {
          ...source.platforms,
          lark: {
            ...source.platforms.lark!,
            appSecret: { kind: "file", path: missingSecretPath }
          }
        }
      })
    ).toThrow(`Secret file ref ${missingSecretPath} could not be resolved.`);
  });

  it("resolves keychain secret refs through the macOS security command", () => {
    const calls: Array<{ args: readonly string[]; file: string; options: { encoding: "utf8" } }> = [];
    const value = readKeychainSecret({ kind: "keychain", service: "opentag", account: "lark-app-secret" }, (file, args, options) => {
      calls.push({ args, file, options });
      return "secret_from_keychain\n";
    });

    expect(value).toBe("secret_from_keychain");
    expect(calls).toEqual([
      {
        file: "/usr/bin/security",
        args: ["find-generic-password", "-w", "-s", "opentag", "-a", "lark-app-secret"],
        options: { encoding: "utf8" }
      }
    ]);
  });

  it("rejects keychain secret refs that resolve to an empty value", () => {
    expect(() =>
      readKeychainSecret({ kind: "keychain", service: "opentag", account: "lark-app-secret" }, () => "\n")
    ).toThrow("Secret keychain ref opentag/lark-app-secret resolved to an empty value.");
  });

  it("includes macOS keychain guidance when keychain lookup fails", () => {
    expect(() =>
      readKeychainSecret({ kind: "keychain", service: "opentag", account: "lark-app-secret" }, () => {
        throw new Error("security command unavailable");
      })
    ).toThrow(
      "Secret keychain ref opentag/lark-app-secret could not be resolved via macOS Keychain (/usr/bin/security). Keychain SecretRefs are only supported on macOS. security command unavailable"
    );
  });

  it("shows secret refs without resolving them in redacted config output", () => {
    const path = join(tempDir(), "config.json");
    const source = config();
    writeFileSync(
      path,
      `${JSON.stringify({
        ...source,
        platforms: {
          ...source.platforms,
          lark: {
            ...source.platforms.lark!,
            appSecret: { kind: "env", name: "OPENTAG_LARK_APP_SECRET" }
          }
        }
      })}\n`,
      { mode: 0o600 }
    );

    const redacted = readRedactedCliConfig(path) as { platforms: { lark: { appSecret: string } } };

    expect(redacted.platforms.lark.appSecret).toBe("[env:OPENTAG_LARK_APP_SECRET]");
    expect(JSON.stringify(redacted)).not.toContain("secret_test");
  });

  it("shows runner token secret refs without resolving them in redacted config output", () => {
    const path = join(tempDir(), "config.json");
    const source = config();
    writeFileSync(
      path,
      `${JSON.stringify({
        ...source,
        daemon: {
          ...source.daemon,
          runnerToken: { kind: "env", name: "OPENTAG_RUNNER_TOKEN" },
          runnerTokens: [{ kind: "env", name: "OPENTAG_OLD_RUNNER_TOKEN" }]
        }
      })}\n`,
      { mode: 0o600 }
    );

    const redacted = readRedactedCliConfig(path) as { daemon: { runnerToken: string; runnerTokens: string[] } };

    expect(redacted.daemon.runnerToken).toBe("[env:OPENTAG_RUNNER_TOKEN]");
    expect(redacted.daemon.runnerTokens).toEqual(["[env:OPENTAG_OLD_RUNNER_TOKEN]"]);
    expect(JSON.stringify(redacted)).not.toContain("runner_secret");
  });

  it("shows file secret refs without resolving them in redacted config output", () => {
    const path = join(tempDir(), "config.json");
    const secretPath = join(tempDir(), "lark-secret.txt");
    writeFileSync(secretPath, "secret_from_file\n", { mode: 0o600 });
    const source = config();
    writeFileSync(
      path,
      `${JSON.stringify({
        ...source,
        platforms: {
          ...source.platforms,
          lark: {
            ...source.platforms.lark!,
            appSecret: { kind: "file", path: secretPath }
          }
        }
      })}\n`,
      { mode: 0o600 }
    );

    const redacted = readRedactedCliConfig(path) as { platforms: { lark: { appSecret: string } } };

    expect(redacted.platforms.lark.appSecret).toBe(`[file:${secretPath}]`);
    expect(JSON.stringify(redacted)).not.toContain("secret_from_file");
  });

  it("shows keychain secret refs without resolving them in redacted config output", () => {
    const path = join(tempDir(), "config.json");
    const source = config();
    writeFileSync(
      path,
      `${JSON.stringify({
        ...source,
        platforms: {
          ...source.platforms,
          lark: {
            ...source.platforms.lark!,
            appSecret: { kind: "keychain", service: "opentag", account: "lark-app-secret" }
          }
        }
      })}\n`,
      { mode: 0o600 }
    );

    const redacted = readRedactedCliConfig(path) as { platforms: { lark: { appSecret: string } } };

    expect(redacted.platforms.lark.appSecret).toBe("[keychain:opentag/lark-app-secret]");
    expect(JSON.stringify(redacted)).not.toContain("secret_test");
  });

  it("keeps an explicit null GitHub apply token visible in redacted config output", () => {
    const source = config();
    source.daemon.githubApplyToken = null;

    const redacted = redactedCliConfig(source) as { daemon: { githubApplyToken: null } };

    expect(redacted.daemon.githubApplyToken).toBeNull();
  });

  it("normalizes Hermes daemon config strings", () => {
    const parsed = parseCliConfig({
      ...config(),
      daemon: {
        ...config().daemon,
        hermes: {
          command: " custom-hermes ",
          profile: " opentag-fixed ",
          profileTemplate: " opentag-{provider}-{owner}-{repo} "
        }
      }
    });

    expect(parsed.daemon.hermes).toEqual({
      command: "custom-hermes",
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{owner}-{repo}"
    });
  });

  it("rejects whitespace-only Hermes daemon config strings", () => {
    expect(() =>
      parseCliConfig({
        ...config(),
        daemon: {
          ...config().daemon,
          hermes: {
            profileTemplate: "   "
          }
        }
      })
    ).toThrow();
  });

  it("normalizes generic agent session profile daemon config strings", () => {
    const parsed = parseCliConfig({
      ...config(),
      daemon: {
        ...config().daemon,
        agentSessionProfile: {
          profile: " opentag-fixed ",
          profileTemplate: " opentag-{provider}-{projectTarget}-{actorId} "
        }
      }
    });

    expect(parsed.daemon.agentSessionProfile).toEqual({
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{projectTarget}-{actorId}"
    });
  });

  it("rejects whitespace-only generic agent session profile daemon config strings", () => {
    expect(() =>
      parseCliConfig({
        ...config(),
        daemon: {
          ...config().daemon,
          agentSessionProfile: {
            profileTemplate: "   "
          }
        }
      })
    ).toThrow();
  });

  it("builds a local Project Target and state-backed worktree root during setup", () => {
    const projectPath = tempDir();
    const checkoutPath = realpathSync.native(projectPath);
    const stateDirectory = join(tempDir(), "state");
    const built = createSetupConfig({
      language: "zh-CN",
      platform: "lark",
      projectPath,
      stateDirectory,
      executor: "codex",
      lark: {
        appId: "cli_test",
        appSecret: "secret_test",
        domain: "feishu",
        setupMethod: "manual",
        bindingMethod: "bind_later"
      }
    });

    expect(built.daemon.repositories[0]).toMatchObject({
      provider: "local",
      repo: projectPath.split("/").at(-1),
      checkoutPath,
      defaultExecutor: "codex",
      worktreeRoot: join(stateDirectory, "worktrees")
    });
    expect(built.state.databasePath).toBe(join(stateDirectory, "opentag.db"));
    expect(built.daemon).toMatchObject({
      agents: {},
      scratchRoot: join(stateDirectory, "scratch"),
      keepScratch: "on_failure",
      approvalMode: "auto"
    });
    expect(built.platforms.lark?.domain).toBe("feishu");
    expect(built.platforms.lark?.defaultProjectBinding).toBe(false);
    expect(built.preferences?.language).toBe("zh-CN");
    expect(built.preferences?.lastSetup).toMatchObject({
      platforms: ["lark"],
      executor: "codex",
      larkSetupMethod: "manual",
      bindingMethod: "bind_later"
    });
  });
});

describe("query-only Linear platform config (AMP-153)", () => {
  it("accepts token + projectId without webhookSecret", () => {
    const source = config();
    source.platforms.linear = { token: "lin_api_secret", projectId: "proj_123" } as never;
    const parsed = parseCliConfig(JSON.parse(JSON.stringify(source)));
    expect(parsed.platforms.linear?.projectId).toBe("proj_123");
    expect(parsed.platforms.linear?.webhookSecret).toBeUndefined();
  });

  it("still rejects a Linear config with neither webhookSecret nor projectId", () => {
    const source = config();
    source.platforms.linear = { token: "lin_api_secret" } as never;
    expect(() => parseCliConfig(JSON.parse(JSON.stringify(source)))).toThrow(/webhookSecret/);
  });

  it("still rejects a Linear config without a token", () => {
    const source = config();
    source.platforms.linear = { projectId: "proj_123" } as never;
    expect(() => parseCliConfig(JSON.parse(JSON.stringify(source)))).toThrow(/token/);
  });
});

describe("Linear backlog channel config", () => {
  it("parses query-only channels and default connection credentials without a webhook secret", () => {
    const source = config();
    const parsed = parseCliConfig({
      ...source,
      platforms: {
        ...source.platforms,
        linear: {
          connections: { default: { token: "lin_query_only" } },
          channels: [{ teamId: " T123 ", channelId: " C123 ", projectId: " project_1 " }]
        }
      }
    });

    expect(parsed.platforms.linear).toMatchObject({
      connections: { default: { token: "lin_query_only" } },
      channels: [{ teamId: "T123", channelId: "C123", projectId: "project_1" }]
    });
    expect(parsed.platforms.linear?.webhookSecret).toBeUndefined();
  });

  it("resolves a SecretRef used by connections.default.token", () => {
    const previous = process.env.OPENTAG_TEST_LINEAR_QUERY_TOKEN;
    process.env.OPENTAG_TEST_LINEAR_QUERY_TOKEN = "lin_from_env";
    try {
      const source = config();
      const parsed = parseCliConfig({
        ...source,
        platforms: {
          ...source.platforms,
          linear: {
            connections: { default: { token: { kind: "env", name: "OPENTAG_TEST_LINEAR_QUERY_TOKEN" } } },
            channels: [{ teamId: "T123", channelId: "C123", projectId: "project_1" }]
          }
        }
      });

      expect(parsed.platforms.linear?.connections?.default?.token).toBe("lin_from_env");
    } finally {
      if (previous === undefined) delete process.env.OPENTAG_TEST_LINEAR_QUERY_TOKEN;
      else process.env.OPENTAG_TEST_LINEAR_QUERY_TOKEN = previous;
    }
  });

  it("rejects a channel mapping without projectId", () => {
    const source = config();
    expect(() =>
      parseCliConfig({
        ...source,
        platforms: {
          ...source.platforms,
          linear: {
            token: "lin_query_only",
            channels: [{ teamId: "T123", channelId: "C123" }]
          }
        }
      })
    ).toThrow(/projectId/iu);
  });

  it("rejects duplicate team/channel mappings after trimming", () => {
    const source = config();
    expect(() =>
      parseCliConfig({
        ...source,
        platforms: {
          ...source.platforms,
          linear: {
            token: "lin_query_only",
            channels: [
              { teamId: "T123", channelId: "C123", projectId: "project_1" },
              { teamId: " T123 ", channelId: " C123 ", projectId: "project_2" }
            ]
          }
        }
      })
    ).toThrow(/Duplicate Linear channel mapping/iu);
  });

  it("accepts a non-default connection for fail-closed runtime handling", () => {
    const source = config();
    const parsed = parseCliConfig({
      ...source,
      platforms: {
        ...source.platforms,
        linear: {
          connections: { workspace_two: { token: "lin_workspace_two" } },
          channels: [{ teamId: "T123", channelId: "C123", projectId: "project_1", connection: "workspace_two" }]
        }
      }
    });

    expect(parsed.platforms.linear?.channels?.[0]?.connection).toBe("workspace_two");
  });

  it("keeps legacy projectId-only query config parseable", () => {
    const source = config();
    const parsed = parseCliConfig({
      ...source,
      platforms: { ...source.platforms, linear: { token: "lin_legacy", projectId: "project_legacy" } }
    });

    expect(parsed.platforms.linear?.projectId).toBe("project_legacy");
  });

  it("rejects channels config without any static credential or hosted OAuth", () => {
    const source = config();
    expect(() =>
      parseCliConfig({
        ...source,
        platforms: {
          ...source.platforms,
          linear: { channels: [{ teamId: "T123", channelId: "C123", projectId: "project_1" }] }
        }
      })
    ).toThrow(/token/iu);
  });

  it("does not allow a query-only connection token to power webhook mutations", () => {
    const source = config();
    expect(() =>
      parseCliConfig({
        ...source,
        platforms: {
          ...source.platforms,
          linear: {
            connections: { default: { token: "lin_query_only" } },
            webhookSecret: "linear_webhook_secret",
            projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" }
          }
        }
      })
    ).toThrow(/query-only/iu);
  });

  it.each(["teamId", "channelId", "projectId", "connection"] as const)("rejects a blank %s", (field) => {
    const source = config();
    const channel = { teamId: "T123", channelId: "C123", projectId: "project_1", connection: "default" };
    channel[field] = "   ";
    expect(() =>
      parseCliConfig({
        ...source,
        platforms: { ...source.platforms, linear: { token: "lin_query_only", channels: [channel] } }
      })
    ).toThrow();
  });

  it("redacts nested connection tokens", () => {
    const source = config();
    source.platforms.linear = {
      connections: { default: { token: "lin_nested_secret" } },
      channels: [{ teamId: "T123", channelId: "C123", projectId: "project_1" }]
    };

    const text = JSON.stringify(redactedCliConfig(source));
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("lin_nested_secret");
  });
});
