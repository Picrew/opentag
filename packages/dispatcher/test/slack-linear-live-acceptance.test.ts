import { describe, expect, it } from "vitest";
import {
  appendSlackLinearCleanupFailure,
  buildSlackLinearDiagnosticLog,
  buildRegistrySlackLinearConfig,
  buildRegistrySlackLinearChildEnv,
  buildRegistryInstallerEnv,
  describeLinearProjectDiscoveryFailure,
  expectedLinearBacklogPageCount,
  hasExpectedLinearBacklogProjectMapping,
  isGracefulCliExit,
  normalizeLinearIssueRef,
  runSlackLinearCleanupActions,
  selectLinearProjectFromDiscoveryResponse,
  selectCorrelatedSlackLinearReply,
  selectSlackChannelBinding,
  stopSlackLinearProcessForCleanup,
  summarizeSlackLinearReply,
  validateLinearLiveGraphqlUrl
} from "../../../scripts/test/slack-linear-live-acceptance.js";

describe("Slack /linear registry live acceptance helpers", () => {
  it("selects an exact legacy Slack binding without carrying repository authority", () => {
    expect(
      selectSlackChannelBinding(
        {
          slackChannels: [
            { teamId: "T1", channelId: "C1", owner: "example", repo: "one" },
            { teamId: "T2", channelId: "C2", owner: "example", repo: "two" }
          ]
        },
        "C2"
      )
    ).toEqual({ teamId: "T2", channelId: "C2" });
  });

  it("selects the configured Slack platform binding", () => {
    expect(
      selectSlackChannelBinding({
        platforms: { slack: { teamId: "T-live", channelId: "C-live" } }
      })
    ).toEqual({ teamId: "T-live", channelId: "C-live" });
  });

  it("fails closed when an explicit channel is not configured", () => {
    expect(() =>
      selectSlackChannelBinding(
        { slackChannels: [{ teamId: "T1", channelId: "C1", owner: "example", repo: "one" }] },
        "C-missing"
      )
    ).toThrow(/No Slack channel binding/);
  });

  it("normalizes Linear issue URLs and identifiers", () => {
    expect(normalizeLinearIssueRef("https://linear.app/acme/issue/ENG-123/example")).toBe("ENG-123");
    expect(normalizeLinearIssueRef("ENG-456")).toBe("ENG-456");
  });

  it("distinguishes auth, missing-issue, and provider failures", () => {
    for (const status of [401, 403]) {
      expect(describeLinearProjectDiscoveryFailure({ status, messages: [] })).toMatch(
        /Reauthorize.*OPENTAG_LINEAR_SMOKE_TOKEN/u
      );
    }
    expect(
      describeLinearProjectDiscoveryFailure({ status: 200, messages: ["Authentication required, not authenticated"] })
    ).toMatch(/Reauthorize.*OPENTAG_LINEAR_SMOKE_TOKEN/u);
    expect(describeLinearProjectDiscoveryFailure({ status: 200, messages: ["Entity not found: Issue."] })).toMatch(
      /Update OPENTAG_LINEAR_SMOKE_ISSUE/u
    );
    for (const status of [429, 500]) {
      expect(describeLinearProjectDiscoveryFailure({ status, messages: [] })).toMatch(/Retry.*Linear API status/u);
    }
    expect(describeLinearProjectDiscoveryFailure({ status: 200, messages: ["Unexpected schema failure"] })).toMatch(
      /Retry.*Linear API status/u
    );
  });

  it("distinguishes a missing issue, an unmapped issue, and a malformed provider response", () => {
    expect(() => selectLinearProjectFromDiscoveryResponse({ status: 200, body: { data: { issue: null } } })).toThrow(
      /Update OPENTAG_LINEAR_SMOKE_ISSUE/u
    );
    expect(() =>
      selectLinearProjectFromDiscoveryResponse({ status: 200, body: { data: { issue: { project: null } } } })
    ).toThrow(/not assigned to a project/u);
    expect(() => selectLinearProjectFromDiscoveryResponse({ status: 200, body: {} })).toThrow(
      /Linear provider project discovery failed/u
    );
    expect(
      selectLinearProjectFromDiscoveryResponse({
        status: 200,
        body: { data: { issue: { project: { id: "project-1", name: "Factory" } } } }
      })
    ).toEqual({ id: "project-1", name: "Factory" });
  });

  it("always builds a redacted diagnostic log for early failure, empty CLI output, and success", () => {
    expect(
      buildSlackLinearDiagnosticLog({
        cliOutput: "",
        failureMessage: "Slack auth failed with xoxb-private and pairing-private",
        sensitiveValues: ["xoxb-private", "pairing-private"]
      })
    ).toBe(
      "[opentag-live] no CLI output was captured.\n[opentag-live] harness failure: Slack auth failed with [REDACTED] and [REDACTED]\n"
    );
    expect(buildSlackLinearDiagnosticLog({ cliOutput: "" })).toBe(
      "[opentag-live] no CLI output was captured.\n"
    );
    expect(buildSlackLinearDiagnosticLog({ cliOutput: "OpenTag is running.\n" })).toBe("OpenTag is running.\n");
  });

  it("requires at least one matching Linear project identifier and rejects every mismatch", () => {
    expect(hasExpectedLinearBacklogProjectMapping({ projectId: "project-1" }, "project-1")).toBe(true);
    expect(hasExpectedLinearBacklogProjectMapping({ projectKey: "project-1" }, "project-1")).toBe(true);
    expect(
      hasExpectedLinearBacklogProjectMapping({ projectId: "project-1", projectKey: "project-1" }, "project-1")
    ).toBe(true);
    expect(hasExpectedLinearBacklogProjectMapping({}, "project-1")).toBe(false);
    expect(hasExpectedLinearBacklogProjectMapping({ projectId: "project-2" }, "project-1")).toBe(false);
    expect(
      hasExpectedLinearBacklogProjectMapping({ projectId: "project-1", projectKey: "project-2" }, "project-1")
    ).toBe(false);
  });

  it("derives the authoritative pagination depth from the accepted open count", () => {
    expect(expectedLinearBacklogPageCount(10, 2)).toBe(5);
    expect(expectedLinearBacklogPageCount(3, 2)).toBe(2);
    expect(expectedLinearBacklogPageCount(0, 2)).toBe(1);
    expect(() => expectedLinearBacklogPageCount(-1, 2)).toThrow(/non-negative safe integer/u);
    expect(() => expectedLinearBacklogPageCount(10, 0)).toThrow(/positive safe integer/u);
  });

  it("fails cleanup after a SIGTERM timeout and preserves both primary and cleanup failures", async () => {
    const signals: string[] = [];
    let cleanupFailure: unknown;
    try {
      await stopSlackLinearProcessForCleanup({
        sendSignal: (signal) => {
          signals.push(signal);
          return signal === "SIGTERM";
        },
        waitForExit: async () => {
          throw new Error("shutdown timeout");
        }
      });
    } catch (error) {
      cleanupFailure = error;
    }

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(cleanupFailure).toBeInstanceOf(Error);
    expect((cleanupFailure as Error).message).toMatch(/SIGTERM sent=true, SIGKILL sent=false/u);
    const failure = appendSlackLinearCleanupFailure("provider failed", cleanupFailure);
    expect(buildSlackLinearDiagnosticLog({ cliOutput: "", failureMessage: failure })).toContain(
      "provider failed; cleanup failed: Registry CLI cleanup did not complete"
    );
  });

  it("attempts every cleanup action and reports every failure", async () => {
    const calls: string[] = [];
    let cleanupFailure: unknown;
    try {
      await runSlackLinearCleanupActions([
        {
          name: "child",
          run: async () => {
            calls.push("child");
            throw new Error("shutdown timeout");
          }
        },
        {
          name: "proxy",
          run: async () => {
            calls.push("proxy");
            throw new Error("close failed");
          }
        }
      ]);
    } catch (error) {
      cleanupFailure = error;
    }

    expect(calls).toEqual(["child", "proxy"]);
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    expect((cleanupFailure as AggregateError).message).toMatch(/child: shutdown timeout; proxy: close failed/u);
  });

  it("accepts only the canonical live Linear GraphQL endpoint", () => {
    expect(validateLinearLiveGraphqlUrl("https://api.linear.app/graphql")).toBe("https://api.linear.app/graphql");
    for (const value of [
      "http://api.linear.app/graphql",
      "https://api.linear.app/graphql?fixture=true",
      "https://api.linear.app/graphql#fixture",
      "https://user:pass@api.linear.app/graphql",
      "https://localhost/graphql",
      "https://api.linear.app/graphql/"
    ]) {
      expect(() => validateLinearLiveGraphqlUrl(value)).toThrow(/canonical Linear GraphQL endpoint/);
    }
  });

  it("gives the registry child only the required runtime and provider environment", () => {
    const childEnv = buildRegistrySlackLinearChildEnv({
      baseEnv: {
        HOME: "/Users/example",
        PATH: "/usr/bin:/bin",
        TMPDIR: "/tmp",
        LANG: "en_US.UTF-8",
        NODE_OPTIONS: "--import=/tmp/inject.mjs",
        NODE_PATH: "/tmp/injected-modules",
        LINEAR_OAUTH_CLIENT_SECRET: "must-not-cross",
        OPENTAG_GITHUB_TOKEN: "must-not-cross"
      },
      appToken: "xapp-test",
      botToken: "xoxb-test",
      linearToken: "linear-read-test",
      pairingToken: "pairing-test"
    });

    expect(childEnv).toMatchObject({
      HOME: "/Users/example",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      OPENTAG_SLACK_APP_TOKEN: "xapp-test",
      OPENTAG_SLACK_BOT_TOKEN: "xoxb-test",
      OPENTAG_LINEAR_SMOKE_TOKEN: "linear-read-test",
      OPENTAG_SLACK_LINEAR_PAIRING_TOKEN: "pairing-test"
    });
    expect(childEnv).not.toHaveProperty("NODE_OPTIONS");
    expect(childEnv).not.toHaveProperty("NODE_PATH");
    expect(childEnv).not.toHaveProperty("LINEAR_OAUTH_CLIENT_SECRET");
    expect(childEnv).not.toHaveProperty("OPENTAG_GITHUB_TOKEN");
  });

  it("installs the registry artifact without ambient Node hooks or npm configuration", () => {
    const env = buildRegistryInstallerEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/example",
        NODE_OPTIONS: "--import=/tmp/inject.mjs",
        NPM_CONFIG_REGISTRY: "https://registry.example.test",
        NPM_TOKEN: "must-not-cross"
      },
      cacheDirectory: "/tmp/acceptance-npm-cache",
      userConfigPath: "/tmp/acceptance-npm-userconfig",
      globalConfigPath: "/tmp/acceptance-npm-globalconfig"
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin:/bin",
      NPM_CONFIG_CACHE: "/tmp/acceptance-npm-cache",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
      NPM_CONFIG_USERCONFIG: "/tmp/acceptance-npm-userconfig",
      NPM_CONFIG_GLOBALCONFIG: "/tmp/acceptance-npm-globalconfig"
    });
    expect(env.NPM_CONFIG_USERCONFIG).not.toBe(env.NPM_CONFIG_GLOBALCONFIG);
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("NPM_TOKEN");
  });

  it("distinguishes a handled SIGTERM exit from direct signal termination", () => {
    expect(isGracefulCliExit({ code: 0, signal: null })).toBe(true);
    expect(isGracefulCliExit({ code: null, signal: "SIGTERM" })).toBe(false);
    expect(isGracefulCliExit({ code: 1, signal: null })).toBe(false);
  });

  it("builds a query-only config that contains SecretRefs instead of credential values", () => {
    const config = buildRegistrySlackLinearConfig({
      stateDirectory: "/tmp/state",
      databasePath: "/tmp/state/opentag.db",
      worktreeRoot: "/tmp/worktrees",
      dispatcherUrl: "http://127.0.0.1:31234",
      graphqlUrl: "http://127.0.0.1:31235/graphql",
      teamId: "T1",
      channelId: "C1",
      projectId: "project-1"
    });

    expect(config).toMatchObject({
      schemaVersion: 1,
      daemon: {
        repositories: [],
        pairingToken: { kind: "env", name: "OPENTAG_SLACK_LINEAR_PAIRING_TOKEN" }
      },
      platforms: {
        slack: {
          mode: "socket_mode",
          appToken: { kind: "env", name: "OPENTAG_SLACK_APP_TOKEN" },
          botToken: { kind: "env", name: "OPENTAG_SLACK_BOT_TOKEN" },
          teamId: "T1",
          channelId: "C1"
        },
        linear: {
          connections: {
            default: { token: { kind: "env", name: "OPENTAG_LINEAR_SMOKE_TOKEN" } }
          },
          channels: [{ teamId: "T1", channelId: "C1", projectId: "project-1", connection: "default" }]
        }
      }
    });
    expect(config.platforms.linear).not.toHaveProperty("token");
    expect(config.platforms.linear).not.toHaveProperty("webhookSecret");
    expect(JSON.stringify(config)).not.toContain("xox");
  });

  it("accepts only a successful, timestamped Linear backlog reply", () => {
    expect(
      summarizeSlackLinearReply("*Factory backlog · 3 open*\n• ENG-1 item\n\n_Linear · queried 08:10 UTC_")
    ).toEqual({ kind: "backlog", displayedIssueCount: 1, reportedOpenCount: 3 });
    expect(summarizeSlackLinearReply("*Factory backlog · 0 open* 🎉\nNo unfinished issues in this Linear project.\n\n_Linear · queried 08:10 UTC_")).toEqual({
      kind: "empty",
      displayedIssueCount: 0,
      reportedOpenCount: 0
    });
    expect(() => summarizeSlackLinearReply("Linear API is unavailable right now; try again later.")).toThrow(
      /not a successful \/linear reply/
    );
  });

  it("rejects a competing successful reply before the audited Linear query completes", () => {
    expect(() =>
      selectCorrelatedSlackLinearReply({
        messages: [
          {
            ts: "200.000000",
            user: "U_BOT",
            text: "*Factory backlog · 1 open*\n• ENG-1 item\n\n_Linear · queried 08:10 UTC_"
          }
        ],
        threadTs: "100.000000",
        botUserId: "U_BOT",
        correlationMarker: "OpenTagLive-marker"
      })
    ).toThrow(/before the audited Linear query completed/);
  });

  it("requires exact bot authorship, completed-query ordering, and the runtime marker", () => {
    const matchingText =
      "*Factory · OpenTagLive-marker · 1 open*\n• ENG-1 item\n\n_Linear · queried 08:10 UTC_";
    expect(
      selectCorrelatedSlackLinearReply({
        messages: [
          { ts: "200.000000", user: "U_OTHER", text: matchingText },
          { ts: "201.000000", user: "U_BOT", text: matchingText }
        ],
        threadTs: "100.000000",
        botUserId: "U_BOT",
        correlationMarker: "OpenTagLive-marker",
        auditCompletedAtMs: 200_500
      })
    ).toMatchObject({ message: { ts: "201.000000", user: "U_BOT" } });

    expect(() =>
      selectCorrelatedSlackLinearReply({
        messages: [{ ts: "201.000000", user: "U_BOT", text: matchingText.replace("OpenTagLive-marker", "other") }],
        threadTs: "100.000000",
        botUserId: "U_BOT",
        correlationMarker: "OpenTagLive-marker",
        auditCompletedAtMs: 200_500
      })
    ).toThrow(/does not carry the registry runtime correlation marker/);
  });

  it("rejects duplicate successful replies even when one carries the runtime marker", () => {
    expect(() =>
      selectCorrelatedSlackLinearReply({
        messages: [
          {
            ts: "201.000000",
            user: "U_BOT",
            text: "*Factory · OpenTagLive-marker · 1 open*\n• ENG-1 item\n\n_Linear · queried 08:10 UTC_"
          },
          {
            ts: "202.000000",
            user: "U_BOT",
            text: "*Factory backlog · 1 open*\n• ENG-1 item\n\n_Linear · queried 08:10 UTC_"
          }
        ],
        threadTs: "100.000000",
        botUserId: "U_BOT",
        correlationMarker: "OpenTagLive-marker",
        auditCompletedAtMs: 200_500
      })
    ).toThrow(/multiple successful Slack \/linear replies/);
  });
});
