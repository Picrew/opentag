import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSlackInstallationRegistry } from "../src/slack-installation-registry.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const record = (overrides: Record<string, unknown> = {}) => ({ recordVersion: 1 as const, installationId: "install_1", teamId: "T1", appId: "A1",
  providerInstanceId: "slack_install_1", bindingDigest: digest("binding"), principalDigest: digest("principal"), configGeneration: 3,
  principalAssurance: "provider_verified" as const, lifecycle: "active" as const, configGenerationDigest: digest("config-3"),
  credentialReference: { custody: "local" as const, id: "slack.bot.install_1" }, channelIds: ["C1"], ...overrides });

describe("Slack installation registry", () => {
  it("resolves only an exact team, app, and authorized channel", () => {
    const registry = createSlackInstallationRegistry([record()]);
    expect(registry.findExact({ teamId: "T1", appId: "A1", channelId: "C1" })).toMatchObject({ installationId: "install_1" });
    expect(registry.findExact({ teamId: "T1", appId: "A1", channelId: "C2" })).toBeUndefined();
    expect(registry.findExact({ teamId: "T1", appId: "A2", channelId: "C1" })).toBeUndefined();
  });

  it("rejects duplicate current records, duplicate authority, and malformed input", () => {
    expect(() => createSlackInstallationRegistry([record(), record({ installationId: "install_2" })])).toThrow(/ambiguous/iu);
    expect(() => createSlackInstallationRegistry([record({ bindingDigest: "sha256:0" })])).toThrow();
    expect(() => createSlackInstallationRegistry([record({ principalDigest: `sha256:${"0".repeat(64)}` })])).toThrow(/digest/iu);
    expect(() => createSlackInstallationRegistry([record({ credentialReference: { custody: "local", id: "xoxb-secret" } })])).toThrow(/credential/iu);
    expect(() => createSlackInstallationRegistry([record(), record({ configGeneration: 4, configGenerationDigest: digest("config-4") })])).toThrow(/duplicate/iu);
  });
});
