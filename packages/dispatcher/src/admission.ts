import { createHash } from "node:crypto";
import {
  AgentAccessProfileSnapshotSchema,
  conversationKeysFromEvent,
  isRepositoryFreePermissionScope,
  projectTargetRefFromEvent,
  PolicySnapshotProvenanceSchema,
  RunAdmissionDecisionSchema,
  type OpenTagEvent,
  type OpenTagRun,
  type AgentAccessProfileSnapshot,
  type PolicyRule,
  type PolicySnapshotProvenance,
  type RunAdmissionDecision,
  type RunAdmissionReasonCode
} from "@opentag/core";
import { type FollowUpRequest, type RepoBinding, type createOpenTagRepository } from "@opentag/store";

type Repository = ReturnType<typeof createOpenTagRepository>;

export type AgentAccessProfileCheckInput = {
  event: OpenTagEvent;
  binding: RepoBinding;
};

export type AgentAccessProfileCheckResult =
  | {
      allowed: true;
      accessProfileSnapshot?: AgentAccessProfileSnapshot;
      policySnapshotProvenance?: PolicySnapshotProvenance;
    }
  | {
      allowed: false;
      reason: string;
      reasonCode?: Extract<RunAdmissionReasonCode, "agent_access_profile_denied" | "policy_rejected">;
    };

export type AgentAccessProfileCheck = (input: AgentAccessProfileCheckInput) => Promise<AgentAccessProfileCheckResult>;

export type AdmitRunInput = {
  requestId: string;
  event: OpenTagEvent;
};

export type AdmitRunResult =
  | {
      outcome: "start";
      decision: RunAdmissionDecision;
      accessProfileSnapshot: AgentAccessProfileSnapshot;
      policySnapshotProvenance: PolicySnapshotProvenance;
      binding?: RepoBinding;
    }
  | {
      outcome: "drop_duplicate";
      decision: RunAdmissionDecision;
      run: OpenTagRun;
      idempotentReplay: true;
    }
  | {
      outcome: "follow_up_queued";
      decision: RunAdmissionDecision;
      followUpRequest: FollowUpRequest;
    }
  | {
      outcome: "needs_human_decision";
      decision: RunAdmissionDecision;
    };

function isWriteCapable(event: OpenTagEvent): boolean {
  return event.permissions.some((permission) => ["repo:write", "pr:create", "pr:update"].includes(permission.scope));
}

function sourceRequiresRepositoryContext(source: OpenTagEvent["source"]): source is "github" | "gitlab" {
  return source === "github" || source === "gitlab";
}

function nativeRepositoryContextMatchesSource(event: OpenTagEvent): boolean {
  if (!sourceRequiresRepositoryContext(event.source)) return true;
  const metadata = event.metadata ?? {};
  return (
    typeof metadata["repoProvider"] === "string" &&
    metadata["repoProvider"].trim().length > 0 &&
    metadata["repoProvider"] === event.source &&
    typeof metadata["owner"] === "string" &&
    metadata["owner"].trim().length > 0 &&
    typeof metadata["repo"] === "string" &&
    metadata["repo"].trim().length > 0
  );
}

function actorInAllowedList(event: OpenTagEvent, allowedActors: string[]): boolean {
  return allowedActors.includes(event.actor.handle ?? "") || allowedActors.includes(event.actor.providerUserId);
}

const SOURCE_WORK_ITEM_KINDS = new Set(["issue", "pull_request", "merge_request"]);

/** True when the event originated from a work item on a public GitHub/GitLab
 * repository. Uses the work-item context pointers, whose visibility the
 * platform adapters derive from the repository's own private/visibility flag
 * (GitLab "internal" is already collapsed to private by its adapter). */
export function sourceRepoIsPublic(event: OpenTagEvent): boolean {
  if (event.source !== "github" && event.source !== "gitlab") return false;
  return event.context.some(
    (pointer) => SOURCE_WORK_ITEM_KINDS.has(pointer.kind) && pointer.visibility === "public"
  );
}

type ActorGateResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      reasonCode: Extract<RunAdmissionReasonCode, "actor_not_allowed_for_write" | "actor_not_authorized_for_public_repo">;
    };

/** Decides whether the requesting actor may start a run for this binding.
 *
 * With an explicit `allowedActors` list the operator's intent wins: the list
 * gates write-capable runs, matching the pre-existing contract.
 *
 * Without a list, the default is platform-aware instead of allow-all:
 * anyone inside a closed surface (Slack workspace, Lark tenant, private
 * GitHub/GitLab repository) may trigger runs, but on a public repository the
 * actor must carry platform-reported write access (`actor.writeAccess`).
 * Platforms that cannot report access (GitLab Note Hooks) leave it unset, so
 * public projects there stay closed until `allowedActors` is configured. */
function evaluateActorGate(event: OpenTagEvent, allowedActors: string[] | undefined): ActorGateResult {
  if (allowedActors?.length) {
    if (isWriteCapable(event) && !actorInAllowedList(event, allowedActors)) {
      return {
        allowed: false,
        reason: "The requesting actor is not allowed to start a write-capable run in this repository.",
        reasonCode: "actor_not_allowed_for_write"
      };
    }
    return { allowed: true };
  }

  if (sourceRepoIsPublic(event) && event.actor.writeAccess !== true) {
    return {
      allowed: false,
      reason:
        "This repository is public and the requesting actor does not have write access to it. Ask a maintainer to grant write access, or configure allowedActors on the repository binding.",
      reasonCode: "actor_not_authorized_for_public_repo"
    };
  }

  return { allowed: true };
}

function admissionDecision(input: {
  action: RunAdmissionDecision["action"];
  reason: string;
  reasonCode: RunAdmissionReasonCode;
  event: OpenTagEvent;
  activeRunId?: string;
  decidedAt: string;
}): RunAdmissionDecision {
  return RunAdmissionDecisionSchema.parse({
    action: input.action,
    reason: input.reason,
    reasonCode: input.reasonCode,
    decidedAt: input.decidedAt,
    ...(input.activeRunId ? { activeRunId: input.activeRunId } : {}),
    eventId: input.event.id
  });
}

async function defaultAgentAccessProfileCheck(): Promise<AgentAccessProfileCheckResult> {
  return { allowed: true };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function defaultAdmissionSnapshots(input: {
  event: OpenTagEvent;
  binding?: RepoBinding;
  rules: PolicyRule[];
  capturedAt: string;
}): { accessProfileSnapshot: AgentAccessProfileSnapshot; policySnapshotProvenance: PolicySnapshotProvenance } {
  const projectTarget = projectTargetRefFromEvent(input.event);
  const sourceRef = projectTarget ? `${projectTarget.provider}:${projectTarget.owner}/${projectTarget.repo}` : undefined;
  const policySource = input.binding ? "repo_binding" as const : "repository_free" as const;
  const policyContent = {
    source: policySource,
    ...(sourceRef ? { sourceRef } : {}),
    rules: input.rules,
    ...(input.binding
      ? {
          binding: {
            runnerId: input.binding.runnerId,
            ...(input.binding.defaultExecutor ? { defaultExecutor: input.binding.defaultExecutor } : {}),
            allowedActors: [...(input.binding.allowedActors ?? [])].sort()
          }
        }
      : {})
  };
  const contentDigest = sha256Digest(policyContent);
  const policyIdentity = {
    eventId: input.event.id,
    contentDigest,
    capturedAt: input.capturedAt
  };
  const policySnapshotProvenance = PolicySnapshotProvenanceSchema.parse({
    id: `policy_snapshot_${sha256Digest(policyIdentity).slice("sha256:".length, "sha256:".length + 24)}`,
    source: policySource,
    ...(sourceRef ? { sourceRef } : {}),
    rules: input.rules,
    contentDigest,
    capturedAt: input.capturedAt
  });
  const accessIdentity = {
    eventId: input.event.id,
    agentId: input.event.target.agentId,
    requester: `${input.event.actor.provider}:${input.event.actor.providerUserId}`,
    policySnapshotId: policySnapshotProvenance.id
  };
  const accessProfileSnapshot = AgentAccessProfileSnapshotSchema.parse({
    id: `access_snapshot_${sha256Digest(accessIdentity).slice("sha256:".length, "sha256:".length + 24)}`,
    agentPrincipal: {
      id: input.event.target.agentId,
      kind: input.event.target.agentId === "opentag" ? "opentag_agent" : "custom"
    },
    requestedBy: input.event.actor,
    projectTargets: sourceRef ? [sourceRef] : [],
    connectionRefs: [],
    permissions: input.event.permissions,
    constraints: {
      locality: "local_required",
      maximumRiskTier: "high",
      ...(input.binding?.defaultExecutor ? { allowedExecutorIds: [input.binding.defaultExecutor] } : {}),
      ...(input.binding ? { allowedRunnerIds: [input.binding.runnerId] } : {})
    },
    policySnapshotId: policySnapshotProvenance.id,
    capturedAt: input.capturedAt
  });
  return { accessProfileSnapshot, policySnapshotProvenance };
}

function validateAdmissionSnapshots(input: {
  event: OpenTagEvent;
  accessProfileSnapshot: AgentAccessProfileSnapshot;
  policySnapshotProvenance: PolicySnapshotProvenance;
  now: string;
}): string | null {
  const accessResult = AgentAccessProfileSnapshotSchema.safeParse(input.accessProfileSnapshot);
  const policyResult = PolicySnapshotProvenanceSchema.safeParse(input.policySnapshotProvenance);
  if (!accessResult.success || !policyResult.success) {
    return "The captured access profile or policy snapshot is invalid.";
  }
  const access = accessResult.data;
  const policy = policyResult.data;
  if (access.policySnapshotId !== policy.id) return "The access profile does not reference the captured policy snapshot.";
  if (
    access.requestedBy.provider !== input.event.actor.provider
    || access.requestedBy.providerUserId !== input.event.actor.providerUserId
  ) return "The access profile requester does not match the requesting human.";
  if (access.agentPrincipal.id !== input.event.target.agentId) {
    return "The access profile agent principal does not match the targeted agent.";
  }
  const projectTarget = projectTargetRefFromEvent(input.event);
  if (projectTarget) {
    const expected = `${projectTarget.provider}:${projectTarget.owner}/${projectTarget.repo}`;
    if (!access.projectTargets.includes(expected)) return "The access profile does not include the requested project target.";
  }
  if (access.expiresAt && Date.parse(access.expiresAt) <= Date.parse(input.now)) {
    return "The agent access profile expired before this run could start.";
  }
  if (access.revokedAt && Date.parse(access.revokedAt) <= Date.parse(input.now)) {
    return "The agent access profile was revoked before this run could start.";
  }
  return null;
}

export function createAdmissionRuntime(input: {
  repo: Repository;
  agentAccessProfileCheck?: AgentAccessProfileCheck;
  now?: () => string;
}) {
  const agentAccessProfileCheck = input.agentAccessProfileCheck ?? defaultAgentAccessProfileCheck;
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async admitRun(request: AdmitRunInput): Promise<AdmitRunResult> {
      const admittedAt = now();
      const existingRun = await input.repo.getRunByEventId({ eventId: request.event.id });
      if (existingRun) {
        return {
          outcome: "drop_duplicate",
          decision: admissionDecision({
            action: "drop_duplicate",
            reason: "Source event already created a run.",
            reasonCode: "duplicate_source_event",
            event: request.event,
            activeRunId: existingRun.run.id,
            decidedAt: admittedAt
          }),
          run: existingRun.run,
          idempotentReplay: true
        };
      }

      const repoKey = projectTargetRefFromEvent(request.event);
      let binding: RepoBinding | undefined;
      const metadata = request.event.metadata ?? {};
      const hasRepositoryMetadata = ["repoProvider", "owner", "repo"].some((key) => metadata[key] !== undefined);
      const hasUnsafeRepositoryFreePermission = request.event.permissions.some(
        (permission) => !isRepositoryFreePermissionScope(permission.scope)
      );
      const nativeRepositoryContextInvalid =
        sourceRequiresRepositoryContext(request.event.source) && !nativeRepositoryContextMatchesSource(request.event);

      if (
        nativeRepositoryContextInvalid ||
        (!repoKey && (hasRepositoryMetadata || hasUnsafeRepositoryFreePermission))
      ) {
        return {
          outcome: "needs_human_decision",
          decision: admissionDecision({
            action: "needs_human_decision",
            reason: "The repository-bearing event did not resolve to a complete repository context.",
            reasonCode: "repo_context_missing",
            event: request.event,
            decidedAt: admittedAt
          })
        };
      }

      if (repoKey) {
        binding = (await input.repo.getRepoBinding(repoKey)) ?? undefined;
        if (!binding) {
          return {
            outcome: "needs_human_decision",
            decision: admissionDecision({
              action: "needs_human_decision",
              reason: "No repository binding is configured for this work context.",
              reasonCode: "repo_not_bound",
              event: request.event,
              decidedAt: admittedAt
            })
          };
        }

        const actorGate = evaluateActorGate(request.event, binding.allowedActors);
        if (!actorGate.allowed) {
          return {
            outcome: "needs_human_decision",
            decision: admissionDecision({
              action: "needs_human_decision",
              reason: actorGate.reason,
              reasonCode: actorGate.reasonCode,
              event: request.event,
              decidedAt: admittedAt
            })
          };
        }

      }

      const capturedAt = admittedAt;
      const rules = repoKey && typeof input.repo.listRepoPolicyRules === "function"
        ? await input.repo.listRepoPolicyRules(repoKey)
        : [];
      const defaults = defaultAdmissionSnapshots({
        event: request.event,
        ...(binding ? { binding } : {}),
        rules,
        capturedAt
      });
      const checked = binding ? await agentAccessProfileCheck({ event: request.event, binding }) : { allowed: true as const };
      if (!checked.allowed) {
        return {
          outcome: "needs_human_decision",
          decision: admissionDecision({
            action: "needs_human_decision",
            reason: checked.reason,
            reasonCode: checked.reasonCode ?? "agent_access_profile_denied",
            event: request.event,
            decidedAt: admittedAt
          })
        };
      }
      const snapshots = {
        accessProfileSnapshot: checked.accessProfileSnapshot ?? defaults.accessProfileSnapshot,
        policySnapshotProvenance: checked.policySnapshotProvenance ?? defaults.policySnapshotProvenance
      };
      const invalidSnapshotReason = validateAdmissionSnapshots({ event: request.event, ...snapshots, now: capturedAt });
      if (invalidSnapshotReason) {
        return {
          outcome: "needs_human_decision",
          decision: admissionDecision({
            action: "needs_human_decision",
            reason: invalidSnapshotReason,
            reasonCode: "agent_access_profile_denied",
            event: request.event,
            decidedAt: admittedAt
          })
        };
      }

      let activeRun: { run: OpenTagRun; event: OpenTagEvent } | null = null;
      for (const conversationKey of conversationKeysFromEvent(request.event)) {
        activeRun = await input.repo.findActiveRunForConversation({ conversationKey });
        if (activeRun) break;
      }
      if (activeRun) {
        const decision = admissionDecision({
          action: "queue_follow_up",
          reason: "A run is already active for this thread; queue the new request as follow-up work.",
          reasonCode: isWriteCapable(request.event) ? "active_write_run_same_thread" : "active_run_same_thread",
          event: request.event,
          activeRunId: activeRun.run.id,
          decidedAt: admittedAt
        });
        const { followUpRequest, created } = await input.repo.createFollowUpRequest({
          id: request.requestId,
          event: request.event,
          decision,
          activeRunId: activeRun.run.id,
          ...snapshots
        });
        if (created) {
          await input.repo.appendRunEvent({
            runId: activeRun.run.id,
            type: "follow_up_request.queued",
            payload: { followUpRequestId: followUpRequest.id, sourceEventId: request.event.id },
            visibility: "audit",
            importance: "normal",
            message: decision.reason
          });
        }
        return {
          outcome: "follow_up_queued",
          decision,
          followUpRequest
        };
      }

      return {
        outcome: "start",
        decision: admissionDecision({
          action: "start",
          reason: "Source event accepted and ready to create a run.",
          reasonCode: "new_event",
          event: request.event,
          decidedAt: admittedAt
        }),
        ...snapshots,
        ...(binding ? { binding } : {})
      };
    }
  };
}
