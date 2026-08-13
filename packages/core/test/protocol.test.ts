import { describe, expect, it } from "vitest";
import {
  assembleContextPacketFromEvent,
  conversationKeysFromEvent,
  contextPacketFromEvent,
  createAdapterMutationCompilerRegistry,
  defaultRunEventMetadata,
  preflightMutationIntent,
  protocolRunFieldsFromEvent,
  workThreadFromEvent
} from "../src/protocol.js";
import { ContextPacketSchema, type OpenTagEvent } from "../src/schema.js";

const githubEvent: OpenTagEvent = {
  id: "evt_github_comment_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix the flaky test", intent: "fix", args: {} },
  context: [
    { provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/7", visibility: "public" },
    { provider: "github", kind: "comment", uri: "https://github.com/acme/demo/issues/7#issuecomment-1", visibility: "public" }
  ],
  workItem: {
    provider: "github",
    kind: "issue",
    externalId: "acme/demo#7",
    uri: "https://github.com/acme/demo/issues/7",
    ownerContainer: {
      provider: "github",
      id: "acme/demo",
      uri: "https://github.com/acme/demo"
    }
  },
  permissions: [
    { scope: "issue:comment", reason: "reply to source thread" },
    { scope: "repo:write", reason: "commit on isolated branch" },
    { scope: "pr:create", reason: "open a pull request" }
  ],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/7/comments", threadKey: "acme/demo" },
  metadata: { owner: "acme", repo: "demo", issueNumber: 7 }
};

describe("protocol helpers", () => {
  it("derives a work thread for a canonical GitHub issue event", () => {
    const thread = workThreadFromEvent(githubEvent);

    expect(thread).toMatchObject({
      workItemReference: {
        provider: "github",
        kind: "issue",
        externalId: "acme/demo#7"
      },
      primaryAnchor: {
        provider: "github",
        controlPlane: true,
        canApprove: true
      }
    });
  });

  it("keeps a legacy repo conversation key alias for GitHub issue-scoped threads", () => {
    const issueScopedEvent: OpenTagEvent = {
      ...githubEvent,
      callback: {
        ...githubEvent.callback,
        threadKey: "acme/demo#7"
      }
    };

    expect(conversationKeysFromEvent(issueScopedEvent)).toEqual(["github:acme/demo#7", "github:acme/demo"]);
    expect(conversationKeysFromEvent(githubEvent)).toEqual(["github:acme/demo"]);
  });

  it("keeps a canonical Teams thread alias when the reply conversation id includes messageid", () => {
    const teamsEvent: OpenTagEvent = {
      ...githubEvent,
      id: "evt_teams_1",
      source: "teams",
      sourceEventId: "activity_1",
      actor: { provider: "teams", providerUserId: "aad-1", handle: "Ada" },
      callback: {
        provider: "teams",
        uri: "https://smba.trafficmanager.net/amer/",
        threadKey: "https://smba.trafficmanager.net/amer/|19:abc@thread.tacv2;messageid=root-1|root-1"
      },
      metadata: { tenantId: "tenant-1", conversationId: "19:abc@thread.tacv2;messageid=root-1" }
    };

    expect(conversationKeysFromEvent(teamsEvent)).toEqual([
      "teams:https://smba.trafficmanager.net/amer/|19:abc@thread.tacv2;messageid=root-1|root-1",
      "teams:https://smba.trafficmanager.net/amer/|19:abc@thread.tacv2|root-1"
    ]);
  });

  it("does not invent a canonical work item when only a Slack thread is known", () => {
    const { workItem: _githubWorkItem, ...githubEventWithoutWorkItem } = githubEvent;
    const slackEvent: OpenTagEvent = {
      ...githubEventWithoutWorkItem,
      id: "evt_slack_1",
      source: "slack",
      sourceEventId: "Ev123",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      context: [
        { provider: "slack", kind: "message", uri: "slack://team/T123/channel/C123/message/1710000000.000100", visibility: "organization" },
        { kind: "text", uri: "<@U999> fix this", visibility: "organization" }
      ],
      permissions: [{ scope: "chat:postMessage", reason: "reply in Slack thread" }],
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      },
      metadata: { owner: "acme", repo: "demo", repoProvider: "github" }
    };

    expect(workThreadFromEvent(slackEvent)).toBeUndefined();
    expect(protocolRunFieldsFromEvent(slackEvent)).toMatchObject({
      contextPacket: {
        summary: "fix the flaky test"
      }
    });
  });

  it("builds a context packet with assembly metadata and write-scope risk", () => {
    const packet = contextPacketFromEvent(githubEvent);

    expect(packet.sourcePointers).toHaveLength(2);
    expect(packet.intent).toMatchObject({
      rawText: "fix the flaky test",
      normalizedIntent: "fix",
      requestedBy: { provider: "github", providerUserId: "42", handle: "octocat" }
    });
    expect(packet.sources?.map((source) => source.role)).toEqual(["primary", "primary"]);
    expect(packet.assembly?.stages).toEqual(["collect", "classify", "filter", "preserve", "summarize", "budget", "emit"]);
    expect(packet.risks?.[0]).toContain("repo:write");
    expect(packet.exclusions?.[0]).toContain("explicit capability");
  });

  it("emits a schema-valid packet when the command rawText is empty", () => {
    const emptyRawTextEvent: OpenTagEvent = {
      ...githubEvent,
      command: { ...githubEvent.command, rawText: "" }
    };

    const packet = contextPacketFromEvent(emptyRawTextEvent);

    // OpenTagCommandSchema.rawText allows "" but ContextPacketIntentSchema.rawText
    // is min length 1. The packet must remain valid so the store does not accept it
    // on write (createRun) and then throw on read (runFromRow parse).
    // `intent` is optional on ContextPacketSchema, so assert it is defined before
    // dereferencing to keep the test type-checking cleanly under strictNullChecks.
    expect(packet.intent).toBeDefined();
    expect(packet.intent?.rawText).toBe(packet.summary);
    expect(() => ContextPacketSchema.parse(packet)).not.toThrow();
  });

  it("preflights provider-neutral issue creation as a Linear external write", () => {
    const denied = preflightMutationIntent({
      intent: {
        intentId: "intent_create_issue",
        domain: "issue",
        action: "create_issue",
        summary: "Create a Linear issue.",
        params: { title: "Fix OAuth callback error", teamKey: "ENG" }
      },
      permissions: githubEvent.permissions,
      policyRules: [],
      adapter: "linear"
    });
    expect(denied.outcome).toMatchObject({
      intentId: "intent_create_issue",
      outcome: "unsupported",
      message: "Missing platform permission for capability create_issue."
    });

    const allowed = preflightMutationIntent({
      intent: {
        intentId: "intent_create_issue",
        domain: "issue",
        action: "create_issue",
        summary: "Create a Linear issue.",
        params: { title: "Fix OAuth callback error", teamKey: "ENG" }
      },
      permissions: [...githubEvent.permissions, { scope: "issue:create", reason: "create Linear issues after approval" }],
      policyRules: [{ id: "manual", scope: "primary_anchor_override", effect: "allow", capabilityId: "create_issue", reason: "Approved." }],
      adapter: "linear"
    });
    expect(allowed.outcome).toMatchObject({
      intentId: "intent_create_issue",
      outcome: "skipped",
      message: "Preflight passed for create_issue; adapter execution is not implemented in this protocol slice."
    });
  });

  it("falls back to summary when the command rawText is whitespace-only", () => {
    const whitespaceRawTextEvent: OpenTagEvent = {
      ...githubEvent,
      command: { ...githubEvent.command, rawText: "   " }
    };

    const packet = contextPacketFromEvent(whitespaceRawTextEvent);

    // A whitespace-only rawText is functionally empty: it must fall back to the
    // non-empty summary rather than being treated as truthy and stored as-is.
    expect(packet.intent).toBeDefined();
    expect(packet.intent?.rawText).toBe(packet.summary);
    expect(packet.intent?.rawText.trim().length).toBeGreaterThan(0);
    expect(() => ContextPacketSchema.parse(packet)).not.toThrow();
  });

  it("applies context packet budget as an explicit assembly stage", () => {
    const packet = assembleContextPacketFromEvent(
      {
        ...githubEvent,
        context: [
          ...githubEvent.context,
          { provider: "github", kind: "repo", uri: "https://github.com/acme/demo", visibility: "public" },
          { kind: "url", uri: "https://example.com/background", visibility: "public" }
        ]
      },
      "2026-06-24T00:00:00.000Z",
      { budgetTokens: 500 }
    );

    expect(packet.sourcePointers).toHaveLength(1);
    expect(packet.assembly?.budgetTokens).toBe(500);
    expect(packet.assembly?.stages).toContain("budget");
  });

  it("allows context packet assembly hooks to customize stages", () => {
    const packet = assembleContextPacketFromEvent(githubEvent, "2026-06-24T00:00:00.000Z", {
      hooks: {
        collect({ pointers }) {
          return pointers.slice(0, 1);
        },
        summarize({ summary }) {
          return `Hooked: ${summary}`;
        },
        preserve({ facts }) {
          return [...facts, { text: "hook-added fact" }];
        }
      }
    });

    expect(packet.summary).toBe("Hooked: fix the flaky test");
    expect(packet.sourcePointers).toHaveLength(1);
    expect(packet.facts?.map((fact) => fact.text)).toContain("hook-added fact");
  });

  it("shares default run event metadata across runtime layers", () => {
    expect(defaultRunEventMetadata("delivery.intent.queued")).toEqual({
      visibility: "audit",
      importance: "normal"
    });
    expect(defaultRunEventMetadata("delivery.activation_blocked")).toEqual({
      visibility: "human",
      importance: "blocking"
    });
    expect(defaultRunEventMetadata("run.waiting_for_permission")).toEqual({
      visibility: "audit",
      importance: "blocking"
    });
    expect(defaultRunEventMetadata("run.created")).toEqual({
      visibility: "audit",
      importance: "low"
    });
  });

  it("compiles mutation intents through adapter compiler registry", () => {
    const registry = createAdapterMutationCompilerRegistry([
      {
        adapter: "test",
        compile(intent) {
          return {
            ok: true,
            adapter: "test",
            intentId: intent.intentId,
            operation: { action: intent.action }
          };
        }
      }
    ]);

    expect(
      registry.compile("test", [{ intentId: "intent_1", domain: "labels", action: "add_label", summary: "Add label." }])
    ).toEqual([{ ok: true, adapter: "test", intentId: "intent_1", operation: { action: "add_label" } }]);
    expect(registry.compile("missing", [{ intentId: "intent_2", domain: "labels", action: "add_label", summary: "Add label." }])).toEqual([
      {
        ok: false,
        adapter: "missing",
        outcome: {
          intentId: "intent_2",
          outcome: "unsupported",
          message: "No adapter mutation compiler is registered for missing."
        }
      }
    ]);
  });

  it("preflights mutation intents through platform permission and OpenTag policy", () => {
    const intent = {
      intentId: "intent_label_1",
      domain: "labels" as const,
      action: "add_label",
      summary: "Add the bug label.",
      params: { label: "bug" }
    };

    const denied = preflightMutationIntent({
      intent,
      permissions: githubEvent.permissions,
      policyRules: []
    });
    expect(denied.outcome).toMatchObject({
      intentId: "intent_label_1",
      outcome: "unsupported"
    });
    expect(denied.outcome.message).toContain("policy denied");

    const allowed = preflightMutationIntent({
      intent,
      permissions: githubEvent.permissions,
      policyRules: [
        {
          id: "manual_approval",
          scope: "primary_anchor_override",
          effect: "allow",
          capabilityId: "set_labels",
          reason: "Manual approval selected this label intent."
        }
      ]
    });
    expect(allowed.policyResolution?.decision).toBe("allow");
    expect(allowed.outcome).toMatchObject({
      intentId: "intent_label_1",
      outcome: "skipped"
    });
  });

  it("treats request_review as an explicit external write capability", () => {
    const intent = {
      intentId: "intent_review_1",
      domain: "review" as const,
      action: "request_review",
      summary: "Request Alice's review.",
      params: { reviewer: "alice" }
    };

    expect(
      preflightMutationIntent({
        intent,
        adapter: "github",
        permissions: githubEvent.permissions,
        policyRules: [{ id: "manual", scope: "primary_anchor_override", effect: "allow", capabilityId: "request_review", reason: "Approved." }]
      }).outcome
    ).toMatchObject({
      intentId: "intent_review_1",
      outcome: "unsupported"
    });

    const allowed = preflightMutationIntent({
      intent,
      adapter: "github",
      permissions: [...githubEvent.permissions, { scope: "pr:update", reason: "request PR reviewers" }],
      policyRules: [{ id: "manual", scope: "primary_anchor_override", effect: "allow", capabilityId: "request_review", reason: "Approved." }]
    });
    expect(allowed.capability?.capabilityClass).toBe("external_write");
    expect(allowed.outcome).toMatchObject({
      intentId: "intent_review_1",
      outcome: "skipped"
    });
  });
});
