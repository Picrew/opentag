import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenTagClient } from "../../packages/client/src/index.js";
import { createDispatcherApp } from "../../packages/dispatcher/src/server.js";
import type { OpenTagEvent } from "../../packages/core/src/schema.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludes<T>(values: T[], expected: T, message: string): void {
  assert(values.includes(expected), `${message}: expected ${String(expected)} in ${values.map(String).join(", ")}`);
}

const tempDir = await mkdtemp(join(tmpdir(), "opentag-protocol-smoke-"));
const databasePath = join(tempDir, "opentag-smoke.db");

try {
  const app = createDispatcherApp({ databasePath });
  const client = createOpenTagClient({
    dispatcherUrl: "http://opentag-smoke.local",
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    }
  });

  await client.registerRunner({ runnerId: "runner_smoke", name: "Smoke Runner" });
  await client.bindRepository({
    provider: "github",
    owner: "acme",
    repo: "demo",
    runnerId: "runner_smoke",
    workspacePath: "/tmp/acme-demo",
    defaultExecutor: "echo",
    allowedActors: ["octocat"]
  });
  await client.upsertRepoPolicyRule({
    provider: "github",
    owner: "acme",
    repo: "demo",
    rule: {
      id: "repo_allows_label_apply",
      scope: "work_context_owner_container",
      effect: "allow",
      capabilityId: "set_labels",
      reason: "Smoke test repo allows approved label changes."
    }
  });

  const policyRules = await client.listRepoPolicyRules({ provider: "github", owner: "acme", repo: "demo" });
  assert(policyRules.rules.length === 1, "repo policy rule should be stored");

  const event: OpenTagEvent = {
    id: "evt_smoke_1",
    source: "github",
    sourceEventId: "comment_smoke_1",
    receivedAt: "2026-06-24T00:00:00.000Z",
    actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "triage this issue", intent: "run", args: {} },
    context: [
      {
        provider: "github",
        kind: "issue",
        uri: "https://github.com/acme/demo/issues/9",
        visibility: "public"
      },
      {
        provider: "github",
        kind: "comment",
        uri: "https://github.com/acme/demo/issues/9#issuecomment-1",
        visibility: "public"
      }
    ],
    workItem: {
      provider: "github",
      kind: "issue",
      externalId: "acme/demo#9",
      uri: "https://github.com/acme/demo/issues/9",
      ownerContainer: {
        provider: "github",
        id: "acme/demo",
        uri: "https://github.com/acme/demo"
      }
    },
    permissions: [
      { scope: "issue:comment", reason: "reply to source thread" },
      { scope: "repo:write", reason: "apply approved issue metadata changes" },
      { scope: "runner:local", reason: "execute child runs on the paired runner" }
    ],
    callback: {
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/9/comments",
      threadKey: "acme/demo"
    },
    metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 9 }
  };

  const created = await client.createRun({ runId: "run_smoke_1", event });
  assert(
    created.outcome === "run_created",
    `smoke run should be created, received ${created.outcome}: ${created.decision.reasonCode} (${created.decision.reason})`
  );
  assert(created.run.contextPacket?.summary === "triage this issue", "created run should include context packet");
  assert(created.run.thread?.workItemReference.externalId === "acme/demo#9", "created run should include work thread");

  const claimed = await client.claim({ runnerId: "runner_smoke" });
  assert(claimed?.run.id === "run_smoke_1", "runner should claim the smoke run");
  await client.complete({
    runnerId: "runner_smoke",
    runId: "run_smoke_1",
    attemptId: claimed.attemptId,
    fencingToken: claimed.fencingToken,
    result: {
      conclusion: "needs_human",
      summary: "Prepared issue metadata proposal.",
      suggestedChanges: [
        {
          proposalId: "proposal_smoke_1",
          createdAt: "2026-06-24T00:00:01.000Z",
          summary: "Label the issue as a bug.",
          intents: [
            {
              intentId: "intent_smoke_label_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ],
      nextAction: {
        summary: "Approve and apply the proposed label change.",
        hint: {
          kind: "apply_suggested_changes",
          targetId: "proposal_smoke_1",
          selectedIntentIds: ["intent_smoke_label_bug"]
        }
      }
    }
  });

  const proposal = await client.getProposal({ proposalId: "proposal_smoke_1" });
  assert(proposal.runId === "run_smoke_1", "proposal should point back to source run");
  assert(proposal.snapshot.sourceRunId === "run_smoke_1", "proposal should carry sourceRunId");
  assert(proposal.snapshot.workThread?.workItemReference.externalId === "acme/demo#9", "proposal should carry work thread");

  const lineage = await client.getProposalLineage({ proposalId: "proposal_smoke_1" });
  assert(lineage.lineage.entries[0]?.status === "current", "proposal intent should be current");

  const currentIntents = await client.listCurrentMutationIntents({ proposalId: "proposal_smoke_1" });
  assert(currentIntents.intents.some((intent) => intent.intentId === "intent_smoke_label_bug"), "current intent should be listed");

  const threadAction = await client.submitThreadAction({
    id: "approval_smoke_1",
    rawText: "apply 1",
    actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
    callback: event.callback,
    metadata: { source: "smoke", owner: "acme", repo: "demo", issueNumber: 9 }
  });
  assert(threadAction.outcome === "child_run_created", "unconfigured GitHub apply should fall back to a child run");
  assert(threadAction.decision?.id === "approval_smoke_1", "thread action should record an approval decision");
  assert(threadAction.plan?.mode === "preflight_then_per_intent", "thread action should create a protocol apply plan");
  assert(threadAction.plan?.outcomes?.[0]?.outcome === "skipped", "preflight-passed intent should remain unexecuted without GitHub apply config");
  assert(threadAction.run?.parentRunId === "run_smoke_1", "child run should reference parent run");
  assert(threadAction.run?.sourceProposalId === "proposal_smoke_1", "child run should reference source proposal");
  assert(threadAction.run?.sourceApplyPlanId === threadAction.plan?.id, "child run should reference source apply plan");
  assert(threadAction.run?.triggeredByAction?.kind === "apply_suggested_changes", "child run should carry triggering action");

  const events = await client.listRunEvents({ runId: "run_smoke_1" });
  const eventTypes = events.events.map((event) => (event as { type: string }).type);
  for (const expected of [
    "run.created",
    "context_packet.generated",
    "callback.acknowledgement.delivered",
    "proposal.snapshot.created",
    "run.completed",
    "callback.progress.delivered",
    "callback.final.delivered",
    "approval.decision.recorded",
    "apply_plan.created",
    "run.child_created"
  ]) {
    assertIncludes(eventTypes, expected, "parent run audit trail is incomplete");
  }

  const metrics = await client.getRunMetrics({ runId: "run_smoke_1" });
  assert(metrics.metrics.humanCallbackCount === 4, "GitHub-shaped smoke should deliver ack, progress, final, and thread-action fallback callbacks");
  assert(metrics.metrics.auditEventCount > metrics.metrics.humanCallbackCount, "audit events should exceed human callbacks");
  assert(metrics.metrics.threadNoiseRatio < 1, "thread noise ratio should stay below 1");
  assert(metrics.metrics.suggestedChangesCount === 1, "metrics should count suggested changes");
  assert(metrics.metrics.approvalDecisionCount === 1, "metrics should count approvals");
  assert(metrics.metrics.applyPlanCount === 1, "metrics should count apply plans");
  assert(metrics.metrics.childRunCount === 1, "metrics should count child runs");
  assert(metrics.metrics.applyOutcomeCounts.skipped === 1, "metrics should count skipped preflight outcomes");
  assert(metrics.metrics.staleIntentCount === 0, "metrics should count stale intents");

  console.log("protocol-runtime-smoke: ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
