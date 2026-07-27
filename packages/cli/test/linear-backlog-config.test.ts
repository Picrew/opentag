import { describe, expect, it } from "vitest";
import type { OpenTagCliConfig } from "../src/config.js";
import {
  linearBacklogConfigDiagnostics,
  resolveDefaultLinearBacklogToken,
  resolveLinearBacklogChannel
} from "../src/linear-backlog-config.js";

function config(linear: OpenTagCliConfig["platforms"]["linear"]): OpenTagCliConfig {
  return {
    schemaVersion: 1,
    state: { directory: "/tmp/state", databasePath: "/tmp/state/db.sqlite", worktreeRoot: "/tmp/worktrees" },
    daemon: {
      runnerId: "runner_1",
      repositories: [],
      pairingToken: "pairing",
      dispatcherUrl: "http://127.0.0.1:3030",
      pollIntervalMs: 1000,
      heartbeatIntervalMs: 1000
    },
    platforms: {
      slack: { botToken: "xoxb", signingSecret: "signing", teamId: "T1", channelId: "C1" },
      ...(linear ? { linear } : {})
    }
  };
}

describe("resolveLinearBacklogChannel", () => {
  it("resolves an authorized channel to its mapped project", () => {
    expect(
      resolveLinearBacklogChannel({
        linear: {
          token: "lin",
          channels: [{ teamId: "T1", channelId: "C1", projectId: "P1" }],
          graphqlUrl: "https://linear.example/graphql"
        },
        teamId: "T1",
        channelId: "C1"
      })
    ).toEqual({ kind: "authorized", projectId: "P1", connection: "default", graphqlUrl: "https://linear.example/graphql" });
  });

  it.each([undefined, []])("returns not-configured when channels are %j", (channels) => {
    expect(resolveLinearBacklogChannel({ linear: { token: "lin", channels }, teamId: "T1", channelId: "C1" })).toEqual({
      kind: "not-configured",
      reason: "channels-missing"
    });
  });

  it("returns unauthorized when an allowlist exists but the channel does not match", () => {
    expect(
      resolveLinearBacklogChannel({
        linear: { token: "lin", channels: [{ teamId: "T1", channelId: "C2", projectId: "P2" }] },
        teamId: "T1",
        channelId: "C1"
      })
    ).toEqual({ kind: "unauthorized" });
  });

  it("routes multiple channels to different projects", () => {
    const linear = {
      token: "lin",
      channels: [
        { teamId: "T1", channelId: "C1", projectId: "P1" },
        { teamId: "T1", channelId: "C2", projectId: "P2" }
      ]
    };
    expect(resolveLinearBacklogChannel({ linear, teamId: "T1", channelId: "C1" })).toMatchObject({ projectId: "P1" });
    expect(resolveLinearBacklogChannel({ linear, teamId: "T1", channelId: "C2" })).toMatchObject({ projectId: "P2" });
  });

  it("does not match the same channelId across teams or with different case", () => {
    const linear = { token: "lin", channels: [{ teamId: "T1", channelId: "C1", projectId: "P1" }] };
    expect(resolveLinearBacklogChannel({ linear, teamId: "T2", channelId: "C1" })).toEqual({ kind: "unauthorized" });
    expect(resolveLinearBacklogChannel({ linear, teamId: "t1", channelId: "C1" })).toEqual({ kind: "unauthorized" });
    expect(resolveLinearBacklogChannel({ linear, teamId: "T1", channelId: "c1" })).toEqual({ kind: "unauthorized" });
  });

  it("fails closed for a non-default connection", () => {
    expect(
      resolveLinearBacklogChannel({
        linear: {
          connections: { workspace_two: { token: "lin_two" } },
          channels: [{ teamId: "T1", channelId: "C1", projectId: "P1", connection: "workspace_two" }]
        },
        teamId: "T1",
        channelId: "C1"
      })
    ).toEqual({ kind: "unsupported-connection", connection: "workspace_two" });
  });

  it("does not use legacy config or OPENTAG_LINEAR_PROJECT_ID as a route", () => {
    expect(
      resolveLinearBacklogChannel({
        linear: { token: "lin", projectId: "legacy" },
        teamId: "T1",
        channelId: "C1",
        env: { OPENTAG_LINEAR_PROJECT_ID: "env-project" }
      })
    ).toEqual({ kind: "not-configured", reason: "channels-missing" });
  });
});

describe("resolveDefaultLinearBacklogToken", () => {
  it("uses default connection, top-level, API key, then legacy env token priority", () => {
    expect(
      resolveDefaultLinearBacklogToken({
        linear: { connections: { default: { token: "connection" } }, token: "top" },
        env: { OPENTAG_LINEAR_API_KEY: "api", OPENTAG_LINEAR_TOKEN: "legacy" }
      })
    ).toBe("connection");
    expect(
      resolveDefaultLinearBacklogToken({
        linear: { token: "top" },
        env: { OPENTAG_LINEAR_API_KEY: "api", OPENTAG_LINEAR_TOKEN: "legacy" }
      })
    ).toBe("top");
    expect(resolveDefaultLinearBacklogToken({ env: { OPENTAG_LINEAR_API_KEY: "api", OPENTAG_LINEAR_TOKEN: "legacy" } })).toBe("api");
    expect(resolveDefaultLinearBacklogToken({ env: { OPENTAG_LINEAR_TOKEN: "legacy" } })).toBe("legacy");
  });

  it("ignores blank higher-priority values", () => {
    expect(
      resolveDefaultLinearBacklogToken({
        linear: { connections: { default: { token: "   " } }, token: "  " },
        env: { OPENTAG_LINEAR_API_KEY: " api " }
      })
    ).toBe("api");
  });
});

describe("linearBacklogConfigDiagnostics", () => {
  it("warns when a legacy projectId has no channel mappings", () => {
    expect(linearBacklogConfigDiagnostics(config({ token: "lin", projectId: "legacy" }))).toEqual([
      expect.objectContaining({ code: "legacy-project-id", message: expect.stringContaining("no longer authorizes") })
    ]);
  });

  it("warns once per unsupported connection and does not include tokens", () => {
    const diagnostics = linearBacklogConfigDiagnostics(
      config({
        connections: { two: { token: "supersecret" } },
        channels: [
          { teamId: "T1", channelId: "C1", projectId: "P1", connection: "two" },
          { teamId: "T1", channelId: "C2", projectId: "P2", connection: "two" }
        ]
      })
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: "unsupported-connection" });
    expect(JSON.stringify(diagnostics)).not.toContain("supersecret");
  });

  it("does not emit /linear diagnostics without both Slack and Linear", () => {
    const built = config({ token: "lin", projectId: "legacy" });
    built.platforms.slack = undefined;
    expect(linearBacklogConfigDiagnostics(built)).toEqual([]);
  });
});
