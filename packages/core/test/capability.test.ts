import { describe, expect, it } from "vitest";
import {
  OPEN_TAG_PLATFORM_CAPABILITIES,
  isOpenTagPlatformId,
  platformCapabilityForProvider,
  shouldDeliverProgressPresentation,
  shouldDeliverRunStatusPresentation,
  shouldDeliverSourceReceipt
} from "../src/capability.js";

describe("platform capability catalog", () => {
  it("declares source-thread liveness strategies for built-in platforms", () => {
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.github.livenessStrategy).toBe("status_update");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.gitlab.livenessStrategy).toBe("thread_reply");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.linear.livenessStrategy).toBe("thread_reply");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.slack.livenessStrategy).toBe("source_receipt");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.lark.livenessStrategy).toBe("source_receipt");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.telegram.livenessStrategy).toBe("status_update");
  });

  it("declares provider-native presentation capabilities separately from action replies", () => {
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.lark.supportsRichPresentation).toBe(true);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.lark.supportsActionReplies).toBe(false);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.slack.supportsRichPresentation).toBe(true);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.slack.supportsActionReplies).toBe(true);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.gitlab.supportsRichPresentation).toBe(false);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.gitlab.supportsActionReplies).toBe(true);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.linear.supportsRichPresentation).toBe(false);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.linear.supportsActionReplies).toBe(true);
  });

  it("maps liveness strategies to delivery presentation behavior", () => {
    expect(shouldDeliverRunStatusPresentation("github")).toBe(true);
    expect(shouldDeliverRunStatusPresentation("gitlab")).toBe(true);
    expect(shouldDeliverRunStatusPresentation("linear")).toBe(true);
    expect(shouldDeliverRunStatusPresentation("telegram")).toBe(true);
    expect(shouldDeliverRunStatusPresentation("slack")).toBe(false);
    expect(shouldDeliverRunStatusPresentation("lark")).toBe(false);
    expect(shouldDeliverRunStatusPresentation("custom")).toBe(true);

    expect(shouldDeliverProgressPresentation("github")).toBe(true);
    expect(shouldDeliverProgressPresentation("gitlab")).toBe(false);
    expect(shouldDeliverProgressPresentation("linear")).toBe(false);
    expect(shouldDeliverProgressPresentation("telegram")).toBe(true);
    expect(shouldDeliverProgressPresentation("slack")).toBe(false);
    expect(shouldDeliverProgressPresentation("lark")).toBe(false);
    expect(shouldDeliverProgressPresentation("custom")).toBe(true);

    expect(shouldDeliverSourceReceipt("slack")).toBe(true);
    expect(shouldDeliverSourceReceipt("github")).toBe(false);
    expect(shouldDeliverSourceReceipt("lark")).toBe(true);
    expect(shouldDeliverSourceReceipt("custom")).toBe(false);
  });

  it("returns undefined for providers outside the shared catalog", () => {
    expect(platformCapabilityForProvider("custom")).toBeUndefined();
  });
});

describe("teams platform capability", () => {
  it("registers teams as a known platform", () => {
    expect(isOpenTagPlatformId("teams")).toBe(true);
  });
  it("uses the status_update liveness strategy so progress presentations are delivered", () => {
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.teams.livenessStrategy).toBe("status_update");
    expect(shouldDeliverProgressPresentation("teams")).toBe(true);
  });
  it("requires explicit addressing (the bot must be @mentioned)", () => {
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.teams.requiresExplicitAddressing).toBe(true);
  });
});
