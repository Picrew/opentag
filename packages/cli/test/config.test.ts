import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_CONFIG_FILESYSTEM_OPS,
  CLI_CONFIG_DIRECTORY_DURABILITY,
  CliConfigWriteOutcomeUnknownError,
  defaultConfigPath,
  defaultStateDirectory,
  formatCliConfigError,
  parseCliConfig,
  readCliConfig,
  readCliRawConfig,
  readKeychainSecret,
  readRedactedCliConfig,
  redactedCliConfig,
  relayUrlFromConfig,
  runnerDispatcherToken,
  runtimeModeFromConfig,
  writeCliConfigAtomic,
  writeHostedControlConfigAtomic,
  type CliConfigFilesystemOps,
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

function hostedPatch() {
  return {
    dispatcherUrl: "https://control.example",
    relayUrl: "https://control.example",
    trustedRelay: {
      schemaVersion: 1 as const,
      origin: "https://control.example",
      authorizedAt: "2026-08-08T00:00:00.000Z",
      authorizationMethod: "explicit_cli" as const
    },
    controlRegistration: {
      kind: "hosted_control_v1" as const,
      state: "unpaired" as const,
      flow: "registration" as const,
      operationId: "operation_transaction_test",
      reason: "pending" as const
    },
    runnerToken: null
  };
}

function hostedTrust(origin = "https://relay.example") {
  return {
    schemaVersion: 1 as const,
    origin,
    authorizedAt: "2026-08-08T00:00:00.000Z",
    authorizationMethod: "explicit_cli" as const
  };
}

function tracingFilesystem(): {
  calls: string[];
  filesystem: CliConfigFilesystemOps;
} {
  const calls: string[] = [];
  const filesystem = new Proxy(CLI_CONFIG_FILESYSTEM_OPS, {
    get(target, property: keyof CliConfigFilesystemOps) {
      const operation = target[property];
      if (typeof operation !== "function") return operation;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return (operation as (...parameters: unknown[]) => unknown)(...args);
      };
    }
  }) as CliConfigFilesystemOps;
  return { calls, filesystem };
}

function filesystemFailingAt(
  operationToFail: keyof CliConfigFilesystemOps,
  occurrenceToFail: number
): CliConfigFilesystemOps {
  let occurrence = 0;
  return new Proxy(CLI_CONFIG_FILESYSTEM_OPS, {
    get(target, property: keyof CliConfigFilesystemOps) {
      const operation = target[property];
      if (typeof operation !== "function") return operation;
      return (...args: unknown[]) => {
        if (property === operationToFail) {
          occurrence += 1;
          if (occurrence === occurrenceToFail) {
            throw new Error(`injected ${String(property)} failure ${occurrence}`);
          }
        }
        return (operation as (...parameters: unknown[]) => unknown)(...args);
      };
    }
  }) as CliConfigFilesystemOps;
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

  it("reports the platform-specific config directory durability contract", () => {
    expect(CLI_CONFIG_DIRECTORY_DURABILITY).toBe(
      process.platform === "win32" ? "atomic_replace" : "directory_fsync"
    );
  });

  it("serializes every config writer with the same adjacent lock", () => {
    const path = join(tempDir(), "config.json");
    const source = config();
    writeCliConfigAtomic(path, source);
    const before = readFileSync(path, "utf8");
    const lockPath = `${path}.lock`;
    const lockFile = openSync(lockPath, "wx", 0o600);
    try {
      writeFileSync(lockFile, `${JSON.stringify({
        schemaVersion: 1,
        pid: 4242,
        configPath: path,
        createdAt: "2026-08-08T00:00:00.000Z"
      })}\n`);
      let lockError: unknown;
      try {
        writeCliConfigAtomic(path, { ...source, language: "zh-CN" });
      } catch (error) {
        lockError = error;
      }
      expect(lockError).toBeInstanceOf(Error);
      const lockMessage = (lockError as Error).message;
      expect(lockMessage).toContain("Lock record:");
      expect(lockMessage).toContain('"pid":4242');
      expect(lockMessage).toContain("verify the recorded process identity first");
      expect(lockMessage).toContain(`manually delete the exact lock path ${JSON.stringify(lockPath)}`);
      expect(lockMessage).toContain("will not delete a lock based on PID alone");
      expect(() =>
        writeHostedControlConfigAtomic(path, {
          dispatcherUrl: "https://control.example",
          relayUrl: "https://control.example",
          controlRegistration: {
            kind: "hosted_control_v1",
            state: "unpaired",
            flow: "registration",
            operationId: "operation_locked",
            reason: "pending"
          }
        })
      ).toThrow(/locked by another writer/iu);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(statSync(lockPath).isFile()).toBe(true);
    } finally {
      closeSync(lockFile);
      rmSync(lockPath, { force: true });
    }
  });

  it.each([
    [
      "unknown fields",
      JSON.stringify({
        schemaVersion: 1,
        pid: 4242,
        configPath: "/tmp/config.json",
        createdAt: "2026-08-08T00:00:00.000Z",
        token: "SENTINEL_LOCK_TOKEN",
        nested: { credential: "SENTINEL_NESTED_CREDENTIAL" }
      })
    ],
    [
      "a noncanonical createdAt value",
      JSON.stringify({
        schemaVersion: 1,
        pid: 4242,
        configPath: "/tmp/config.json",
        createdAt: "Sat, 08 Aug 2026 00:00:00 GMT (SENTINEL_CREATED_AT)"
      })
    ],
    ["an oversized record", JSON.stringify({ payload: "SENTINEL_OVERSIZED".repeat(1_000) })]
  ])("never renders credentials from %s in lock diagnostics", (_case, contents) => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, contents, { mode: 0o600, flag: "wx" });

    let error: unknown;
    try {
      writeCliConfigAtomic(path, config());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"status":"unreadable_or_invalid"');
    expect((error as Error).message).not.toContain("SENTINEL_LOCK_TOKEN");
    expect((error as Error).message).not.toContain("SENTINEL_NESTED_CREDENTIAL");
    expect((error as Error).message).not.toContain("SENTINEL_CREATED_AT");
    expect((error as Error).message).not.toContain("SENTINEL_OVERSIZED");
    rmSync(lockPath, { force: true });
  });

  it("does not follow a symbolic-link config lock for diagnostics", () => {
    const directory = tempDir();
    const path = join(directory, "config.json");
    writeCliConfigAtomic(path, config());
    const lockPath = `${path}.lock`;
    const target = join(directory, "foreign-lock.json");
    writeFileSync(target, JSON.stringify({
      schemaVersion: 1,
      pid: 424242,
      configPath: "SENTINEL_SYMLINK_PATH",
      createdAt: "2026-08-08T00:00:00.000Z"
    }), { mode: 0o600 });
    symlinkSync(target, lockPath);

    let error: unknown;
    try {
      writeCliConfigAtomic(path, config());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"status":"unreadable_or_invalid"');
    expect((error as Error).message).not.toContain("424242");
    expect((error as Error).message).not.toContain("SENTINEL_SYMLINK_PATH");
    rmSync(lockPath, { force: true });
  });

  it.each([
    ["schemaVersion", (raw: Record<string, unknown>) => { raw.schemaVersion = 2; }],
    ["platform", (raw: Record<string, unknown>) => {
      const platforms = raw.platforms as { lark: Record<string, unknown> };
      platforms.lark.unexpected = true;
    }],
    ["runnerTokens", (raw: Record<string, unknown>) => {
      const daemon = raw.daemon as Record<string, unknown>;
      daemon.runnerTokens = [42];
    }]
  ])("rejects an invalid unrelated raw %s field without replacing the old config", (_field, mutate) => {
    const path = join(tempDir(), "config.json");
    const raw = JSON.parse(JSON.stringify(config())) as Record<string, unknown>;
    mutate(raw);
    const before = `${JSON.stringify(raw, null, 2)}\n`;
    writeFileSync(path, before, { mode: 0o600 });

    expect(() => writeHostedControlConfigAtomic(path, hostedPatch())).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("does not accept a SecretRef-shaped object in a non-secret raw field", () => {
    const path = join(tempDir(), "config.json");
    const raw = JSON.parse(JSON.stringify(config())) as Record<string, unknown>;
    const daemon = raw.daemon as Record<string, unknown>;
    daemon.runnerId = { kind: "env", name: "NOT_A_SECRET_FIELD" };
    const before = `${JSON.stringify(raw, null, 2)}\n`;
    writeFileSync(path, before, { mode: 0o600 });

    expect(() => writeHostedControlConfigAtomic(path, hostedPatch())).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("performs the hosted replacement in lock-write-fsync-rename-readback-unlock order", () => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const { calls, filesystem } = tracingFilesystem();

    writeHostedControlConfigAtomic(path, hostedPatch(), filesystem);

    expect(calls).toEqual([
      "mkdir",
      "open", "fchmod", "writeFile", "fsync",
      ...(process.platform === "win32" ? [] : ["stat"]),
      "readFile",
      "open", "fchmod", "writeFile", "fsync", "close", "rename",
      ...(process.platform === "win32" ? [] : ["open", "fsync", "close"]),
      "readFile",
      "close", "remove",
      ...(process.platform === "win32" ? [] : ["open", "fsync", "close"])
    ]);
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("uses the filesystem seam for the ordinary atomic writer too", () => {
    const path = join(tempDir(), "config.json");
    const { calls, filesystem } = tracingFilesystem();

    writeCliConfigAtomic(path, config(), filesystem);

    expect(calls).toContain("rename");
    expect(calls.filter((call) => call === "writeFile")).toHaveLength(2);
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it.each([
    ["lock fchmod", "fchmod", 1],
    ["lock write", "writeFile", 1],
    ["lock fsync", "fsync", 1],
    ["temp fchmod", "fchmod", 2],
    ["temp write", "writeFile", 2],
    ["temp fsync", "fsync", 2]
  ] as const)("keeps the old file and releases the lock after a pre-rename %s failure", (
    _stage,
    operation,
    occurrence
  ) => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const before = readFileSync(path, "utf8");

    expect(() => writeHostedControlConfigAtomic(
      path,
      hostedPatch(),
      filesystemFailingAt(operation, occurrence)
    )).toThrow(`injected ${operation} failure ${occurrence}`);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("does not retry an ambiguous temporary-file close failure", () => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const before = readFileSync(path, "utf8");
    const closeFailure = new Error("injected post-close failure");
    let tempFile: number | undefined;
    let tempCloseCalls = 0;
    const filesystem: CliConfigFilesystemOps = {
      ...CLI_CONFIG_FILESYSTEM_OPS,
      open(target, flags, mode) {
        const file = CLI_CONFIG_FILESYSTEM_OPS.open(target, flags, mode);
        if (target.startsWith(`${path}.`) && target.endsWith(".tmp")) tempFile = file;
        return file;
      },
      close(file) {
        if (file !== tempFile) {
          CLI_CONFIG_FILESYSTEM_OPS.close(file);
          return;
        }
        tempCloseCalls += 1;
        CLI_CONFIG_FILESYSTEM_OPS.close(file);
        throw closeFailure;
      }
    };

    expect(() => writeHostedControlConfigAtomic(path, hostedPatch(), filesystem))
      .toThrow(closeFailure);
    expect(tempCloseCalls).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("keeps an ambiguous close failure primary when temporary cleanup also fails", () => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const before = readFileSync(path, "utf8");
    const closeFailure = new Error("injected post-close failure");
    const removeFailure = new Error("injected temp remove failure");
    let tempFile: number | undefined;
    let tempPath: string | undefined;
    const filesystem: CliConfigFilesystemOps = {
      ...CLI_CONFIG_FILESYSTEM_OPS,
      open(target, flags, mode) {
        const file = CLI_CONFIG_FILESYSTEM_OPS.open(target, flags, mode);
        if (target.startsWith(`${path}.`) && target.endsWith(".tmp")) {
          tempFile = file;
          tempPath = target;
        }
        return file;
      },
      close(file) {
        CLI_CONFIG_FILESYSTEM_OPS.close(file);
        if (file === tempFile) throw closeFailure;
      },
      remove(target) {
        if (target === tempPath) throw removeFailure;
        CLI_CONFIG_FILESYSTEM_OPS.remove(target);
      }
    };

    let error: unknown;
    try {
      writeHostedControlConfigAtomic(path, hostedPatch(), filesystem);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.cause).toBe(closeFailure);
    expect(aggregate.errors).toEqual([closeFailure, removeFailure]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(() => statSync(`${path}.lock`)).toThrow();
    if (tempPath) rmSync(tempPath, { force: true });
  });

  it("keeps the original config and releases the lock when rename fails", () => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const before = readFileSync(path, "utf8");
    const filesystem: CliConfigFilesystemOps = {
      ...CLI_CONFIG_FILESYSTEM_OPS,
      rename() {
        throw new Error("injected pre-rename failure");
      }
    };

    expect(() => writeHostedControlConfigAtomic(path, hostedPatch(), filesystem))
      .toThrow("injected pre-rename failure");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("reports outcome unknown after rename and still releases the lock", () => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    let renamed = false;
    const filesystem: CliConfigFilesystemOps = {
      ...CLI_CONFIG_FILESYSTEM_OPS,
      rename(from, to) {
        CLI_CONFIG_FILESYSTEM_OPS.rename(from, to);
        renamed = true;
      },
      readFile(target) {
        if (renamed && target === path) throw new Error("injected readback failure");
        return CLI_CONFIG_FILESYSTEM_OPS.readFile(target);
      }
    };

    expect(() => writeHostedControlConfigAtomic(path, hostedPatch(), filesystem))
      .toThrow(CliConfigWriteOutcomeUnknownError);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      runtime: { mode: "relay", relayUrl: "https://control.example" },
      daemon: {
        dispatcherUrl: "https://control.example",
        controlRegistration: { operationId: "operation_transaction_test" }
      }
    });
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("runs the complete raw schema again during post-rename readback", () => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    let renamed = false;
    const filesystem: CliConfigFilesystemOps = {
      ...CLI_CONFIG_FILESYSTEM_OPS,
      rename(from, to) {
        CLI_CONFIG_FILESYSTEM_OPS.rename(from, to);
        renamed = true;
      },
      readFile(target) {
        const contents = CLI_CONFIG_FILESYSTEM_OPS.readFile(target);
        if (!renamed || target !== path) return contents;
        const invalid = JSON.parse(contents) as Record<string, unknown>;
        invalid.schemaVersion = 2;
        return JSON.stringify(invalid);
      }
    };

    expect(() => writeHostedControlConfigAtomic(path, hostedPatch(), filesystem))
      .toThrow(CliConfigWriteOutcomeUnknownError);
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("keeps directory fsync as the primary cause when directory close also fails", () => {
    if (process.platform === "win32") return;
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const fsyncFailure = new Error("injected directory fsync failure");
    const closeFailure = new Error("injected directory close failure");
    let renamed = false;
    let failedDirectory: number | undefined;
    const filesystem: CliConfigFilesystemOps = {
      ...CLI_CONFIG_FILESYSTEM_OPS,
      rename(from, to) {
        CLI_CONFIG_FILESYSTEM_OPS.rename(from, to);
        renamed = true;
      },
      open(target, flags, mode) {
        const file = CLI_CONFIG_FILESYSTEM_OPS.open(target, flags, mode);
        if (renamed && target === dirname(path) && failedDirectory === undefined) {
          failedDirectory = file;
        }
        return file;
      },
      fsync(file) {
        if (file === failedDirectory) throw fsyncFailure;
        CLI_CONFIG_FILESYSTEM_OPS.fsync(file);
      },
      close(file) {
        if (file === failedDirectory) throw closeFailure;
        CLI_CONFIG_FILESYSTEM_OPS.close(file);
      }
    };

    let error: unknown;
    try {
      writeHostedControlConfigAtomic(path, hostedPatch(), filesystem);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliConfigWriteOutcomeUnknownError);
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    const cause = (error as Error).cause as AggregateError;
    expect(cause.cause).toBe(fsyncFailure);
    expect(cause.errors).toEqual([fsyncFailure, closeFailure]);
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("reports outcome unknown when a successful ordinary write cannot close its lock", () => {
    const path = join(tempDir(), "config.json");
    let lockFile: number | undefined;
    const filesystem: CliConfigFilesystemOps = {
      ...CLI_CONFIG_FILESYSTEM_OPS,
      open(target, flags, mode) {
        const file = CLI_CONFIG_FILESYSTEM_OPS.open(target, flags, mode);
        if (target === `${path}.lock`) lockFile = file;
        return file;
      },
      close(file) {
        if (file === lockFile) throw new Error("injected lock close failure");
        CLI_CONFIG_FILESYSTEM_OPS.close(file);
      }
    };

    expect(() => writeCliConfigAtomic(path, config(), filesystem))
      .toThrow(CliConfigWriteOutcomeUnknownError);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schemaVersion: 1 });
    expect(() => statSync(`${path}.lock`)).toThrow();
  });

  it("preserves outcome-unknown typing when post-rename failure and lock cleanup both fail", () => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const lockPath = `${path}.lock`;
    let renamed = false;
    const filesystem: CliConfigFilesystemOps = {
      ...CLI_CONFIG_FILESYSTEM_OPS,
      rename(from, to) {
        CLI_CONFIG_FILESYSTEM_OPS.rename(from, to);
        renamed = true;
      },
      readFile(target) {
        if (renamed && target === path) throw new Error("injected readback failure");
        return CLI_CONFIG_FILESYSTEM_OPS.readFile(target);
      },
      remove(target) {
        if (target === lockPath) throw new Error("injected lock cleanup failure");
        CLI_CONFIG_FILESYSTEM_OPS.remove(target);
      }
    };

    let error: unknown;
    try {
      writeHostedControlConfigAtomic(path, hostedPatch(), filesystem);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliConfigWriteOutcomeUnknownError);
    expect((error as Error & { code?: string }).code).toBe("config_write_outcome_unknown");
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(statSync(lockPath).isFile()).toBe(true);
    rmSync(lockPath, { force: true });
  });

  it("never removes an existing lock whose record is invalid", () => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "not-json\n", { mode: 0o600, flag: "wx" });
    let removeCalls = 0;
    const filesystem: CliConfigFilesystemOps = {
      ...CLI_CONFIG_FILESYSTEM_OPS,
      remove(target) {
        removeCalls += 1;
        CLI_CONFIG_FILESYSTEM_OPS.remove(target);
      }
    };

    expect(() => writeHostedControlConfigAtomic(path, hostedPatch(), filesystem))
      .toThrow('"status":"unreadable_or_invalid"');
    expect(removeCalls).toBe(0);
    expect(readFileSync(lockPath, "utf8")).toBe("not-json\n");
    rmSync(lockPath, { force: true });
  });

  it("preserves ref-shaped ordinary metadata instead of treating it as a secret", () => {
    const path = join(tempDir(), "config.json");
    const raw = JSON.parse(JSON.stringify(config())) as {
      daemon: Record<string, unknown>;
    };
    raw.daemon.channelBindings = [{
      provider: "lark",
      accountId: "account-1",
      conversationId: "conversation-1",
      metadata: {
        annotation: { kind: "env", name: "ORDINARY_METADATA" }
      }
    }];
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    writeHostedControlConfigAtomic(path, hostedPatch());

    const persisted = JSON.parse(readFileSync(path, "utf8")) as typeof raw;
    expect(persisted.daemon.channelBindings).toEqual(raw.daemon.channelBindings);
  });

  it("rejects a malformed SecretRef in a known raw secret field", () => {
    const path = join(tempDir(), "config.json");
    const raw = JSON.parse(JSON.stringify(config())) as {
      platforms: { lark: Record<string, unknown> };
    };
    raw.platforms.lark.appSecret = { kind: "env", name: "", extra: true };
    const before = `${JSON.stringify(raw, null, 2)}\n`;
    writeFileSync(path, before, { mode: 0o600 });

    expect(() => writeHostedControlConfigAtomic(path, hostedPatch())).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("patches hosted control state without materializing unrelated SecretRefs", () => {
    const path = join(tempDir(), "config.json");
    const source = config();
    const previousAppSecret = process.env.OPENTAG_TEST_LARK_APP_SECRET;
    const previousPairingToken = process.env.OPENTAG_TEST_PAIRING_TOKEN;
    process.env.OPENTAG_TEST_LARK_APP_SECRET = "resolved_lark_secret";
    process.env.OPENTAG_TEST_PAIRING_TOKEN = "resolved_pairing_secret";
    try {
      const raw = JSON.parse(JSON.stringify(source)) as {
        daemon: Record<string, unknown>;
        platforms: { lark: { appSecret: unknown } };
      };
      raw.platforms.lark.appSecret = {
        kind: "env",
        name: "OPENTAG_TEST_LARK_APP_SECRET"
      };
      raw.daemon.pairingToken = {
        kind: "env",
        name: "OPENTAG_TEST_PAIRING_TOKEN"
      };
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);

      writeHostedControlConfigAtomic(path, {
        dispatcherUrl: "https://control.example",
        relayProvider: "custom",
        relayUrl: "https://control.example",
        trustedRelay: hostedTrust("https://control.example"),
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "unpaired",
          flow: "registration",
          operationId: "operation_1",
          reason: "pending"
        },
        runnerToken: null
      });

      const persisted = JSON.parse(readFileSync(path, "utf8")) as {
        daemon: Record<string, unknown>;
        platforms: { lark: { appSecret: unknown } };
      };
      expect(persisted.platforms.lark.appSecret).toEqual({
        kind: "env",
        name: "OPENTAG_TEST_LARK_APP_SECRET"
      });
      expect(persisted.daemon.pairingToken).toEqual({
        kind: "env",
        name: "OPENTAG_TEST_PAIRING_TOKEN"
      });
      expect(persisted.daemon.controlRegistration).toMatchObject({
        state: "unpaired",
        operationId: "operation_1",
        reason: "pending"
      });
      expect(persisted.daemon.trustedRelay).toEqual(
        hostedTrust("https://control.example")
      );
      writeHostedControlConfigAtomic(path, {
        dispatcherUrl: "https://control.example",
        relayProvider: "custom",
        relayUrl: "https://control.example",
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "unpaired",
          flow: "registration",
          operationId: "operation_2",
          reason: "outcome_unknown"
        },
        runnerToken: null
      });
      const preserved = JSON.parse(readFileSync(path, "utf8")) as {
        daemon: Record<string, unknown>;
        platforms: { lark: { appSecret: unknown } };
      };
      expect(preserved.daemon.trustedRelay).toEqual(
        hostedTrust("https://control.example")
      );
      expect(preserved.platforms.lark.appSecret).toEqual(
        raw.platforms.lark.appSecret
      );
      expect(readCliConfig(path).daemon.pairingToken).toBe("resolved_pairing_secret");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      if (previousAppSecret === undefined) delete process.env.OPENTAG_TEST_LARK_APP_SECRET;
      else process.env.OPENTAG_TEST_LARK_APP_SECRET = previousAppSecret;
      if (previousPairingToken === undefined) delete process.env.OPENTAG_TEST_PAIRING_TOKEN;
      else process.env.OPENTAG_TEST_PAIRING_TOKEN = previousPairingToken;
    }
  });

  it("does not resolve unrelated unavailable SecretRef backends during a raw hosted patch", () => {
    const path = join(tempDir(), "config.json");
    const raw = JSON.parse(JSON.stringify(config())) as {
      daemon: Record<string, unknown>;
      platforms: { lark: { appSecret: unknown } };
    };
    delete process.env.OPENTAG_TEST_UNAVAILABLE_SECRET;
    raw.platforms.lark.appSecret = {
      kind: "keychain",
      service: "opentag-test-unavailable",
      account: "missing"
    };
    raw.daemon.pairingToken = {
      kind: "file",
      path: join(tempDir(), "missing-secret")
    };
    raw.daemon.runnerTokens = [
      { kind: "env", name: "OPENTAG_TEST_UNAVAILABLE_SECRET" }
    ];
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);

    expect(() =>
      writeHostedControlConfigAtomic(path, {
        dispatcherUrl: "https://control.example",
        relayUrl: "https://control.example",
        trustedRelay: hostedTrust("https://control.example"),
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "unpaired",
          flow: "registration",
          operationId: "operation_raw_refs",
          reason: "pending"
        },
        runnerToken: null
      })
    ).not.toThrow();

    const persisted = JSON.parse(readFileSync(path, "utf8")) as typeof raw;
    expect(persisted.platforms.lark.appSecret).toEqual(raw.platforms.lark.appSecret);
    expect(persisted.daemon.pairingToken).toEqual(raw.daemon.pairingToken);
    expect(persisted.daemon.runnerTokens).toEqual(raw.daemon.runnerTokens);
  });

  it("rejects non-inline hosted runner credentials before replacing the destination", () => {
    const path = join(tempDir(), "config.json");
    writeCliConfigAtomic(path, config());
    const before = readFileSync(path, "utf8");

    expect(() =>
      writeHostedControlConfigAtomic(path, {
        dispatcherUrl: "https://control.example",
        relayUrl: "https://control.example",
        trustedRelay: hostedTrust("https://control.example"),
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "unpaired",
          flow: "registration",
          operationId: "operation_inline_only",
          reason: "pending"
        },
        runnerToken: { kind: "env", name: "OPENTAG_RUNNER_TOKEN" } as unknown as string
      })
    ).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
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

  it("requires the legacy pairing token when no hosted authority marker exists", () => {
    const source = config();
    delete source.daemon.pairingToken;
    expect(() => parseCliConfig(source)).toThrow("Legacy OpenTag configuration requires daemon.pairingToken");
  });

  it("accepts a paired Hosted Control V1 relay and uses only its runner credential", () => {
    const source = config();
    source.runtime = { mode: "relay", relayUrl: "https://relay.example", relayProvider: "custom" };
    source.daemon.dispatcherUrl = "https://relay.example";
    source.daemon.runnerToken = "runtime_runner_token";
    source.daemon.trustedRelay = hostedTrust();
    delete source.daemon.pairingToken;
    source.daemon.controlRegistration = {
      kind: "hosted_control_v1",
      state: "paired",
      operationId: "operation-1",
      registration: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        runnerId: source.daemon.runnerId,
        registrationGeneration: 1,
        credentialGeneration: 1,
        credentialId: "credential-1",
        credentialPurpose: "runtime",
        createdAt: "2026-08-08T00:00:00.000Z"
      }
    };

    const parsed = parseCliConfig(source);
    expect(runnerDispatcherToken(parsed.daemon)).toBe("runtime_runner_token");
  });

  it("rejects hosted authority outside relay mode or with a mismatched relay URL", () => {
    const source = config();
    source.daemon.controlRegistration = {
      kind: "hosted_control_v1",
      state: "unpaired",
      flow: "registration",
      operationId: "operation-1",
      reason: "pending"
    };
    source.daemon.trustedRelay = hostedTrust("http://localhost:3030");
    expect(() => parseCliConfig(source)).toThrow("runtime.mode=relay");

    source.runtime = { mode: "relay", relayUrl: "https://other.example", relayProvider: "custom" };
    source.daemon.dispatcherUrl = "https://relay.example";
    source.daemon.trustedRelay = hostedTrust();
    expect(() => parseCliConfig(source)).toThrow("relay origin does not match dispatcher origin");
  });

  it("fails closed on hosted trust before resolving SecretRefs", () => {
    const source = config() as unknown as Record<string, unknown>;
    const daemon = source.daemon as Record<string, unknown>;
    source.runtime = { mode: "relay", relayUrl: "https://relay.example" };
    daemon.dispatcherUrl = "https://relay.example";
    daemon.runnerToken = { kind: "file", path: "/definitely/not/read/hosted-token" };
    delete daemon.pairingToken;
    daemon.controlRegistration = {
      kind: "hosted_control_v1",
      state: "paired",
      operationId: "operation-no-trust",
      registration: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        runnerId: daemon.runnerId,
        registrationGeneration: 1,
        credentialGeneration: 1,
        credentialId: "credential-1",
        credentialPurpose: "runtime",
        createdAt: "2026-08-08T00:00:00.000Z"
      }
    };

    expect(() => parseCliConfig(source)).toThrow(/explicit trustedRelay authorization/iu);
  });

  it("reads raw config without materializing SecretRefs", () => {
    const path = join(tempDir(), "config.json");
    const raw = JSON.parse(JSON.stringify(config())) as {
      daemon: Record<string, unknown>;
    };
    raw.daemon.pairingToken = {
      kind: "file",
      path: "/definitely/not-read/raw-config-token"
    };
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    expect((readCliRawConfig(path) as { daemon: Record<string, unknown> })
      .daemon.pairingToken).toEqual(raw.daemon.pairingToken);
  });

  it.each([
    ["canonical host case", "https://RELAY.Example:443", "https://relay.example"],
    ["different port", "https://relay.example:444", "https://relay.example"],
    ["subdomain", "https://api.relay.example", "https://relay.example"],
    ["suffix", "https://relay.example.evil.test", "https://relay.example"],
    ["scheme", "http://relay.example", "https://relay.example"],
    ["path", "https://relay.example/control", "https://relay.example"],
    ["query", "https://relay.example?runner=1", "https://relay.example"],
    ["userinfo", "https://user@relay.example", "https://relay.example"]
  ])("enforces hosted relay origin: %s", (_name, dispatcherUrl, trustedOrigin) => {
    const source = config();
    source.runtime = { mode: "relay", relayUrl: dispatcherUrl };
    source.daemon.dispatcherUrl = dispatcherUrl;
    source.daemon.runnerToken = "runtime_runner_token";
    source.daemon.trustedRelay = hostedTrust(trustedOrigin);
    delete source.daemon.pairingToken;
    source.daemon.controlRegistration = {
      kind: "hosted_control_v1",
      state: "paired",
      operationId: "operation-origin",
      registration: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        runnerId: source.daemon.runnerId,
        registrationGeneration: 1,
        credentialGeneration: 1,
        credentialId: "credential-1",
        credentialPurpose: "runtime",
        createdAt: "2026-08-08T00:00:00.000Z"
      }
    };

    if (_name === "canonical host case") {
      expect(parseCliConfig(source).daemon.dispatcherUrl).toBe(dispatcherUrl);
    } else {
      expect(() => parseCliConfig(source)).toThrow();
    }
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
