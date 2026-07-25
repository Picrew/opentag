import { projectTargetRefFromLocalPath } from "@opentag/core";
import { createOpenTagRepository, migrateSchema } from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createAdmissionRuntime } from "../src/admission.js";

const event = {
  id: "evt_1",
  source: "github" as const,
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github" as const, providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix" as const, args: {} },
  context: [],
  permissions: [{ scope: "issue:comment" as const, reason: "reply to source thread" }],
  callback: { provider: "github" as const, uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { repoProvider: "github", owner: "acme", repo: "demo" }
};

describe("Admission Runtime", () => {
  const bindingRepo = (binding: Record<string, unknown>) =>
    ({
      getRunByEventId: async () => null,
      getRepoBinding: async () => binding,
      findActiveRunForConversation: async () => null,
      createFollowUpRequest: async () => {
        throw new Error("should not queue follow-up");
      },
      appendRunEvent: async () => undefined
    }) as never;

  const publicIssueContext = [
    { provider: "github" as const, kind: "issue" as const, uri: "https://github.com/acme/demo/issues/1", visibility: "public" as const }
  ];
  const privateIssueContext = [
    { provider: "github" as const, kind: "issue" as const, uri: "https://github.com/acme/demo/issues/1", visibility: "private" as const }
  ];
  const githubBinding = { provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" };

  it("denies public-repo runs by default when the actor has no platform-reported write access", async () => {
    const admission = createAdmissionRuntime({ repo: bindingRepo(githubBinding) });

    const result = await admission.admitRun({
      requestId: "req_public_stranger",
      event: { ...event, id: "evt_public_stranger", context: publicIssueContext }
    });

    expect(result).toMatchObject({
      outcome: "needs_human_decision",
      decision: { reasonCode: "actor_not_authorized_for_public_repo" }
    });
  });

  it("admits public-repo runs when the actor carries platform-reported write access", async () => {
    const capturedAt = "2026-06-24T00:00:00.000Z";
    const admission = createAdmissionRuntime({ repo: bindingRepo(githubBinding), now: () => capturedAt });

    const result = await admission.admitRun({
      requestId: "req_public_maintainer",
      event: {
        ...event,
        id: "evt_public_maintainer",
        actor: { ...event.actor, writeAccess: true },
        context: publicIssueContext
      }
    });

    expect(result).toMatchObject({
      outcome: "start",
      decision: { decidedAt: capturedAt },
      accessProfileSnapshot: {
        requestedBy: { providerUserId: "42" },
        agentPrincipal: { id: "opentag", kind: "opentag_agent" },
        projectTargets: ["github:acme/demo"],
        constraints: { locality: "local_required", allowedRunnerIds: ["runner_1"] }
      },
      policySnapshotProvenance: { source: "repo_binding", sourceRef: "github:acme/demo", capturedAt }
    });
    if (result.outcome !== "start") throw new Error("expected start");
    expect(result.accessProfileSnapshot.policySnapshotId).toBe(result.policySnapshotProvenance.id);
  });

  it("fails closed when an access checker returns an invalid snapshot", async () => {
    const admission = createAdmissionRuntime({
      repo: bindingRepo(githubBinding),
      agentAccessProfileCheck: async () => ({
        allowed: true,
        accessProfileSnapshot: { id: "incomplete_snapshot" } as never
      })
    });

    const result = await admission.admitRun({
      requestId: "req_invalid_snapshot",
      event: { ...event, id: "evt_invalid_snapshot", context: privateIssueContext }
    });

    expect(result).toMatchObject({
      outcome: "needs_human_decision",
      decision: {
        reasonCode: "agent_access_profile_denied",
        reason: "The captured access profile or policy snapshot is invalid."
      }
    });
  });

  it("keeps private-repo runs open to actors without reported write access", async () => {
    const admission = createAdmissionRuntime({ repo: bindingRepo(githubBinding) });

    const result = await admission.admitRun({
      requestId: "req_private_stranger",
      event: { ...event, id: "evt_private_stranger", context: privateIssueContext }
    });

    expect(result).toMatchObject({ outcome: "start" });
  });

  it("preserves fallback-only executor restrictions from a legacy binding", async () => {
    const admission = createAdmissionRuntime({
      repo: bindingRepo({ ...githubBinding, fallbackExecutorIds: ["hermes", "codex"] })
    });

    const result = await admission.admitRun({
      requestId: "req_fallback_only_executors",
      event: { ...event, id: "evt_fallback_only_executors", context: privateIssueContext }
    });

    expect(result).toMatchObject({
      outcome: "start",
      accessProfileSnapshot: {
        constraints: { allowedExecutorIds: ["hermes", "codex"] }
      },
      routingPolicy: { executorIds: ["hermes", "codex"] }
    });
  });

  it("keeps the admitted routing policy authoritative if the repository binding changes before run creation", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    await repo.createRepoBinding({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner-admitted",
      fallbackRunnerIds: ["runner-admitted-fallback"]
    });
    const admittedEvent = { ...event, id: "evt_binding_interleave", context: privateIssueContext };
    const admission = createAdmissionRuntime({ repo, now: () => "2026-07-25T00:00:00.000Z" });

    const admitted = await admission.admitRun({ requestId: "run_binding_interleave", event: admittedEvent });
    if (admitted.outcome !== "start") throw new Error("expected admitted run");
    expect(admitted.routingPolicy).toEqual({
      runnerIds: ["runner-admitted", "runner-admitted-fallback"],
      executorIds: null
    });

    await repo.createRepoBinding({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner-rebound",
      defaultExecutor: "hermes"
    });
    await repo.createRun({
      id: "run_binding_interleave",
      event: admittedEvent,
      accessProfileSnapshot: admitted.accessProfileSnapshot,
      policySnapshotProvenance: admitted.policySnapshotProvenance,
      routingPolicy: admitted.routingPolicy
    });

    expect(sqlite.prepare(`
      SELECT routing_policy_json AS routingPolicy,
             routing_runner_ids_json AS runnerIds,
             routing_executor_ids_json AS executorIds
      FROM runs WHERE id = ?
    `).get("run_binding_interleave")).toEqual({
      routingPolicy: JSON.stringify(admitted.routingPolicy),
      runnerIds: JSON.stringify(["runner-admitted", "runner-admitted-fallback"]),
      executorIds: null
    });
    await expect(repo.claimNextRun({ runnerId: "runner-admitted", leaseSeconds: 60 })).resolves.toMatchObject({
      run: { id: "run_binding_interleave" },
      executorId: "echo"
    });
  });

  it("lets an explicit allowedActors list override the public-repo default", async () => {
    const admission = createAdmissionRuntime({
      repo: bindingRepo({ ...githubBinding, allowedActors: ["octocat"] })
    });

    const result = await admission.admitRun({
      requestId: "req_public_listed",
      event: {
        ...event,
        id: "evt_public_listed",
        context: publicIssueContext,
        permissions: [
          ...event.permissions,
          { scope: "repo:write" as const, reason: "commit code changes on an isolated run branch" }
        ]
      }
    });

    expect(result).toMatchObject({ outcome: "start" });
  });

  it("still rejects write-capable runs from actors outside a configured allowedActors list", async () => {
    const admission = createAdmissionRuntime({
      repo: bindingRepo({ ...githubBinding, allowedActors: ["someone-else"] })
    });

    const result = await admission.admitRun({
      requestId: "req_listed_denied",
      event: {
        ...event,
        id: "evt_listed_denied",
        context: privateIssueContext,
        permissions: [
          ...event.permissions,
          { scope: "repo:write" as const, reason: "commit code changes on an isolated run branch" }
        ]
      }
    });

    expect(result).toMatchObject({
      outcome: "needs_human_decision",
      decision: { reasonCode: "actor_not_allowed_for_write" }
    });
  });

  it("checks duplicate source events before mutable gates", async () => {
    const getRepoBinding = vi.fn(async () => {
      throw new Error("should not reach mutable gates for duplicate events");
    });
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => ({
          run: {
            id: "run_existing",
            eventId: "evt_1",
            status: "queued",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          event
        }),
        getRepoBinding,
        findActiveRunForConversation: async () => null,
        createFollowUpRequest: async () => {
          throw new Error("should not queue follow-up");
        },
        appendRunEvent: async () => undefined
      } as never
    });

    const result = await admission.admitRun({ requestId: "req_1", event });

    expect(result).toMatchObject({
      outcome: "drop_duplicate",
      decision: { reasonCode: "duplicate_source_event" },
      run: { id: "run_existing" }
    });
    expect(getRepoBinding).not.toHaveBeenCalled();
  });

  it("does not duplicate active-run timeline events for replayed follow-up requests", async () => {
    const appendRunEvent = vi.fn(async () => undefined);
    const createFollowUpRequest = vi.fn(async () => ({
      followUpRequest: {
        id: "follow_up_1",
        sourceEventId: event.id,
        conversationKey: "github:https://api.github.com/repos/acme/demo/issues/1/comments",
        activeRunId: "run_active",
        event,
        decision: {
          action: "queue_follow_up" as const,
          reason: "active run exists",
          reasonCode: "active_run_same_thread" as const,
          decidedAt: "2026-06-24T00:00:00.000Z",
          activeRunId: "run_active",
          eventId: event.id
        },
        status: "queued" as const,
        createdAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:00.000Z"
      },
      created: false
    }));
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => null,
        getRepoBinding: async () => ({
          provider: "github",
          owner: "acme",
          repo: "demo",
          runnerId: "runner_1"
        }),
        findActiveRunForConversation: async () => ({
          run: {
            id: "run_active",
            eventId: "evt_active",
            status: "running",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          event
        }),
        createFollowUpRequest,
        appendRunEvent
      } as never
    });

    const result = await admission.admitRun({ requestId: "follow_up_1", event });

    expect(result).toMatchObject({
      outcome: "follow_up_queued",
      decision: { action: "queue_follow_up" }
    });
    expect(createFollowUpRequest).toHaveBeenCalledWith(expect.objectContaining({
      accessProfileSnapshot: expect.objectContaining({
        requestedBy: expect.objectContaining({ providerUserId: "42" }),
        agentPrincipal: { id: "opentag", kind: "opentag_agent" }
      }),
      policySnapshotProvenance: expect.objectContaining({ source: "repo_binding" }),
      routingPolicy: { runnerIds: ["runner_1"], executorIds: null }
    }));
    expect(appendRunEvent).not.toHaveBeenCalled();
  });

  it("queues issue-scoped GitHub follow-ups against legacy repo-scoped active runs", async () => {
    const checkedConversationKeys: string[] = [];
    const issueScopedEvent = {
      ...event,
      id: "evt_issue_scoped",
      callback: {
        provider: "github" as const,
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 1 }
    };
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => null,
        getRepoBinding: async () => ({
          provider: "github",
          owner: "acme",
          repo: "demo",
          runnerId: "runner_1"
        }),
        findActiveRunForConversation: async ({ conversationKey }: { conversationKey: string }) => {
          checkedConversationKeys.push(conversationKey);
          if (conversationKey !== "github:acme/demo") return null;
          return {
            run: {
              id: "run_legacy_active",
              eventId: "evt_legacy_active",
              status: "running",
              createdAt: "2026-06-24T00:00:00.000Z",
              updatedAt: "2026-06-24T00:00:00.000Z"
            },
            event
          };
        },
        createFollowUpRequest: async () => ({
          followUpRequest: {
            id: "follow_up_legacy",
            sourceEventId: issueScopedEvent.id,
            conversationKey: "github:acme/demo#1",
            activeRunId: "run_legacy_active",
            event: issueScopedEvent,
            decision: {
              action: "queue_follow_up",
              reason: "active run exists",
              reasonCode: "active_run_same_thread",
              decidedAt: "2026-06-24T00:00:00.000Z",
              activeRunId: "run_legacy_active",
              eventId: issueScopedEvent.id
            },
            status: "queued",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          created: true
        }),
        appendRunEvent: async () => undefined
      } as never
    });

    const result = await admission.admitRun({ requestId: "follow_up_legacy", event: issueScopedEvent });

    expect(checkedConversationKeys).toEqual(["github:acme/demo#1", "github:acme/demo"]);
    expect(result).toMatchObject({
      outcome: "follow_up_queued",
      decision: {
        action: "queue_follow_up",
        activeRunId: "run_legacy_active"
      },
      followUpRequest: {
        activeRunId: "run_legacy_active"
      }
    });
  });

  it("admits local Project Target events through the shared project target ref", async () => {
    const localProject = projectTargetRefFromLocalPath("/Users/test/work/app");
    const getRepoBinding = vi.fn(async () => ({
      ...localProject,
      runnerId: "runner_1",
      workspacePath: "/Users/test/work/app"
    }));
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => null,
        getRepoBinding,
        findActiveRunForConversation: async () => null,
        createFollowUpRequest: async () => {
          throw new Error("should not queue follow-up");
        },
        appendRunEvent: async () => undefined
      } as never
    });

    const result = await admission.admitRun({
      requestId: "req_local",
      event: {
        ...event,
        id: "evt_local",
        source: "lark",
        sourceEventId: "message_local",
        actor: { provider: "lark", providerUserId: "ou_user" },
        callback: { provider: "lark", uri: "lark://im/v1/messages", threadKey: "tk|oc|om" },
        metadata: { repoProvider: localProject.provider, owner: localProject.owner, repo: localProject.repo }
      }
    });

    expect(result).toMatchObject({ outcome: "start", binding: { runnerId: "runner_1" } });
    expect(getRepoBinding).toHaveBeenCalledWith(localProject);
  });

  it.each([
    ["github", "missing metadata", {}],
    ["github", "owner+repo without an explicit provider", { owner: "acme", repo: "demo" }],
    ["github", "missing owner", { repoProvider: "github", repo: "demo" }],
    ["github", "missing repo", { repoProvider: "github", owner: "acme" }],
    ["github", "blank provider", { repoProvider: "   ", owner: "acme", repo: "demo" }],
    ["github", "blank owner", { repoProvider: "github", owner: "   ", repo: "demo" }],
    ["github", "blank repo", { repoProvider: "github", owner: "acme", repo: "   " }],
    ["github", "mismatched provider", { repoProvider: "gitlab", owner: "acme", repo: "demo" }],
    ["gitlab", "missing metadata", {}],
    ["gitlab", "owner+repo without an explicit provider", { owner: "acme", repo: "demo" }],
    ["gitlab", "missing owner", { repoProvider: "gitlab", repo: "demo" }],
    ["gitlab", "missing repo", { repoProvider: "gitlab", owner: "acme" }],
    ["gitlab", "blank provider", { repoProvider: "   ", owner: "acme", repo: "demo" }],
    ["gitlab", "blank owner", { repoProvider: "gitlab", owner: "   ", repo: "demo" }],
    ["gitlab", "blank repo", { repoProvider: "gitlab", owner: "acme", repo: "   " }],
    ["gitlab", "mismatched provider", { repoProvider: "github", owner: "acme", repo: "demo" }]
  ] as const)("fails closed when a %s event has %s repository context", async (source, label, metadata) => {
    const getRepoBinding = vi.fn(async () => {
      throw new Error("should not resolve a binding without complete repository context");
    });
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => null,
        getRepoBinding,
        findActiveRunForConversation: async () => null,
        createFollowUpRequest: async () => {
          throw new Error("should not queue follow-up");
        },
        appendRunEvent: async () => undefined
      } as never
    });

    const result = await admission.admitRun({
      requestId: `req_${source}_${label.replaceAll(" ", "_")}`,
      event: {
        ...event,
        id: `evt_${source}_${label.replaceAll(" ", "_")}`,
        source,
        sourceEventId: `note_${label.replaceAll(" ", "_")}`,
        actor: { provider: source, providerUserId: "42", handle: "octocat" },
        callback:
          source === "github"
            ? { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" }
            : { provider: "gitlab", uri: "https://gitlab.example/api/v4/projects/1/notes" },
        context: [],
        metadata
      }
    });

    expect(result).toMatchObject({
      outcome: "needs_human_decision",
      decision: { reasonCode: "repo_context_missing" }
    });
    expect(getRepoBinding).not.toHaveBeenCalled();
  });

  it.each(["github", "gitlab"] as const)(
    "resolves a complete source-bound %s repository context",
    async (source) => {
      const projectTarget = { provider: source, owner: "acme", repo: "demo" };
      const getRepoBinding = vi.fn(async () => ({ ...projectTarget, runnerId: "runner_1" }));
      const admission = createAdmissionRuntime({
        repo: {
          getRunByEventId: async () => null,
          getRepoBinding,
          findActiveRunForConversation: async () => null,
          createFollowUpRequest: async () => {
            throw new Error("should not queue follow-up");
          },
          appendRunEvent: async () => undefined
        } as never
      });

      const result = await admission.admitRun({
        requestId: `req_${source}_complete`,
        event: {
          ...event,
          id: `evt_${source}_complete`,
          source,
          sourceEventId: `note_${source}_complete`,
          actor: { provider: source, providerUserId: "42", handle: "octocat" },
          callback:
            source === "github"
              ? { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" }
              : { provider: "gitlab", uri: "https://gitlab.example/api/v4/projects/1/notes" },
          context: [],
          metadata: { repoProvider: source, owner: "acme", repo: "demo" }
        }
      });

      expect(result).toMatchObject({ outcome: "start", binding: { runnerId: "runner_1" } });
      expect(getRepoBinding).toHaveBeenCalledWith(projectTarget);
    }
  );

  it.each(
    (["slack", "lark"] as const).flatMap((source) =>
      ["repo:read", "repo:write", "pr:create", "pr:update", "git:push", "branch:write"].map(
        (scope) => [source, scope] as const
      )
    )
  )("fails closed when a repository-free %s event requests unsafe scope %s", async (source, scope) => {
    const getRepoBinding = vi.fn(async () => {
      throw new Error("should not resolve a repository binding for channel-native work");
    });
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => null,
        getRepoBinding,
        findActiveRunForConversation: async () => null,
        createFollowUpRequest: async () => {
          throw new Error("should not queue follow-up");
        },
        appendRunEvent: async () => undefined
      } as never
    });
    const isSlack = source === "slack";

    const result = await admission.admitRun({
      requestId: `req_${source}_${scope}`,
      event: {
        ...event,
        id: `evt_${source}_${scope}`,
        source,
        sourceEventId: `message_${source}_${scope}`,
        actor: { provider: source, providerUserId: "channel_user" },
        permissions: [{ scope, reason: "adapter requested authority without a repository target" }],
        callback: isSlack
          ? { provider: "slack", uri: "https://slack.com/api/chat.postMessage", threadKey: "T|C|1.0" }
          : { provider: "lark", uri: "lark://im/v1/messages", threadKey: "tk|oc|om" },
        metadata: isSlack ? { teamId: "T", channelId: "C" } : { tenantKey: "tk", chatId: "oc" }
      }
    });

    expect(result).toMatchObject({
      outcome: "needs_human_decision",
      decision: { reasonCode: "repo_context_missing" }
    });
    expect(getRepoBinding).not.toHaveBeenCalled();
  });

  it.each(["slack", "lark"] as const)("admits repository-free %s channel events", async (source) => {
    const getRepoBinding = vi.fn(async () => {
      throw new Error("should not resolve a repository binding for channel-native work");
    });
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => null,
        getRepoBinding,
        findActiveRunForConversation: async () => null,
        createFollowUpRequest: async () => {
          throw new Error("should not queue follow-up");
        },
        appendRunEvent: async () => undefined
      } as never
    });
    const isSlack = source === "slack";

    const result = await admission.admitRun({
      requestId: `req_${source}_repo_free`,
      event: {
        ...event,
        id: `evt_${source}_repo_free`,
        source,
        sourceEventId: `message_${source}`,
        actor: { provider: source, providerUserId: "channel_user" },
        permissions: [
          { scope: "chat:postMessage", reason: "reply in the source thread" },
          { scope: "reactions:write", reason: "mark the source message as received" },
          { scope: "runner:local", reason: "execute on a paired local daemon" },
          { scope: "issue:create", reason: "create an explicitly requested issue" },
          { scope: "issue:comment", reason: "reply to an issue thread" },
          { scope: "agent:activity", reason: "publish agent activity" },
          { scope: "network:restricted", reason: "use restricted network access" }
        ],
        callback: isSlack
          ? { provider: "slack", uri: "https://slack.com/api/chat.postMessage", threadKey: "T|C|1.0" }
          : { provider: "lark", uri: "lark://im/v1/messages", threadKey: "tk|oc|om" },
        metadata: isSlack ? { teamId: "T", channelId: "C" } : { tenantKey: "tk", chatId: "oc" }
      }
    });

    expect(result).toMatchObject({ outcome: "start" });
    expect(getRepoBinding).not.toHaveBeenCalled();
  });
});
