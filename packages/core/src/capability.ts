export type OpenTagPlatformId = "github" | "gitlab" | "linear" | "slack" | "lark" | "telegram" | "discord" | "teams";

export type PlatformLivenessStrategy = "source_receipt" | "status_update" | "thread_reply" | "pull_status";

export type PlatformCapabilityDescriptor = {
  id: OpenTagPlatformId;
  receivesEvents: boolean;
  repliesToSourceThread: boolean;
  supportsStatusUpdates: boolean;
  supportsRichPresentation: boolean;
  supportsActionReplies: boolean;
  requiresExplicitAddressing: boolean;
  livenessStrategy: PlatformLivenessStrategy;
};

export const OPEN_TAG_PLATFORM_CAPABILITIES: Record<OpenTagPlatformId, PlatformCapabilityDescriptor> = {
  github: {
    id: "github",
    receivesEvents: true,
    repliesToSourceThread: true,
    supportsStatusUpdates: true,
    supportsRichPresentation: false,
    supportsActionReplies: true,
    requiresExplicitAddressing: true,
    livenessStrategy: "status_update"
  },
  gitlab: {
    id: "gitlab",
    receivesEvents: true,
    repliesToSourceThread: true,
    supportsStatusUpdates: false,
    supportsRichPresentation: false,
    supportsActionReplies: true,
    requiresExplicitAddressing: true,
    livenessStrategy: "thread_reply"
  },
  linear: {
    id: "linear",
    receivesEvents: true,
    repliesToSourceThread: true,
    supportsStatusUpdates: false,
    supportsRichPresentation: false,
    supportsActionReplies: true,
    requiresExplicitAddressing: true,
    livenessStrategy: "thread_reply"
  },
  slack: {
    id: "slack",
    receivesEvents: true,
    repliesToSourceThread: true,
    supportsStatusUpdates: true,
    supportsRichPresentation: true,
    supportsActionReplies: true,
    requiresExplicitAddressing: true,
    livenessStrategy: "source_receipt"
  },
  lark: {
    id: "lark",
    receivesEvents: true,
    repliesToSourceThread: true,
    supportsStatusUpdates: false,
    supportsRichPresentation: true,
    supportsActionReplies: false,
    requiresExplicitAddressing: true,
    livenessStrategy: "source_receipt"
  },
  telegram: {
    id: "telegram",
    receivesEvents: true,
    repliesToSourceThread: true,
    supportsStatusUpdates: true,
    supportsRichPresentation: true,
    supportsActionReplies: false,
    requiresExplicitAddressing: false,
    livenessStrategy: "status_update"
  },
  discord: {
    id: "discord",
    receivesEvents: true,
    repliesToSourceThread: true,
    supportsStatusUpdates: true,
    supportsRichPresentation: true,
    supportsActionReplies: true,
    requiresExplicitAddressing: true,
    livenessStrategy: "status_update"
  },
  teams: {
    id: "teams",
    receivesEvents: true,
    repliesToSourceThread: true,
    supportsStatusUpdates: true,
    supportsRichPresentation: false,
    supportsActionReplies: true,
    requiresExplicitAddressing: true,
    livenessStrategy: "status_update"
  }
};

export function isOpenTagPlatformId(value: string): value is OpenTagPlatformId {
  return Object.prototype.hasOwnProperty.call(OPEN_TAG_PLATFORM_CAPABILITIES, value);
}

export function platformCapabilityForProvider(provider: string): PlatformCapabilityDescriptor | undefined {
  return isOpenTagPlatformId(provider) ? OPEN_TAG_PLATFORM_CAPABILITIES[provider] : undefined;
}

export function shouldDeliverRunStatusPresentation(provider: string): boolean {
  const strategy = platformCapabilityForProvider(provider)?.livenessStrategy;
  if (!strategy) return true;
  return strategy === "status_update" || strategy === "thread_reply";
}

export function shouldDeliverProgressPresentation(provider: string): boolean {
  const strategy = platformCapabilityForProvider(provider)?.livenessStrategy;
  if (!strategy) return true;
  return strategy === "status_update";
}

export function shouldDeliverSourceReceipt(provider: string): boolean {
  return platformCapabilityForProvider(provider)?.livenessStrategy === "source_receipt";
}
