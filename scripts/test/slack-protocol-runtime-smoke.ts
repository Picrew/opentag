import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenTagClient } from "../../packages/client/src/index.js";
import { createDispatcherApp, type CallbackMessage } from "../../packages/dispatcher/src/server.js";
import { normalizeSlackAppMention } from "../../packages/slack/src/normalize.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludes<T>(values: T[], expected: T, message: string): void {
  assert(values.includes(expected), `${message}: expected ${String(expected)} in ${values.map(String).join(", ")}`);
}

const tempDir = await mkdtemp(join(tmpdir(), "opentag-slack-protocol-smoke-"));
const databasePath = join(tempDir, "opentag-slack-smoke.db");
const delivered: CallbackMessage[] = [];

try {
  const app = createDispatcherApp({
    databasePath,
    callbackSink: {
      async deliver(message) {
        delivered.push(message);
        return { handled: true, outcome: 'accepted' } as const;
      }
    }
  });
  const client = createOpenTagClient({
    dispatcherUrl: "http://opentag-slack-smoke.local",
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    }
  });

  await client.registerRunner({ runnerId: "runner_slack_smoke", name: "Slack Smoke Runner" });
  await client.bindRepository({
    provider: "github",
    owner: "acme",
    repo: "demo",
    runnerId: "runner_slack_smoke",
    workspacePath: "/tmp/acme-demo",
    defaultExecutor: "echo",
    allowedActors: ["U123"]
  });
  await client.bindSlackChannel({
    teamId: "T123",
    channelId: "C123",
    owner: "acme",
    repo: "demo"
  });

  const event = normalizeSlackAppMention({
    teamId: "T123",
    channelId: "C123",
    userId: "U123",
    text: "<@U999> investigate the flaky smoke test",
    ts: "1710000000.000100",
    threadTs: "1710000000.000100",
    eventId: "EvSlackSmoke",
    eventTime: Math.floor(Date.parse("2026-06-24T00:00:00.000Z") / 1000),
    appId: "A123",
    agentId: "opentag",
    botUserId: "U999",
    binding: {
      teamId: "T123",
      channelId: "C123",
      owner: "acme",
      repo: "demo"
    }
  });
  assert(event, "Slack mention should normalize into an OpenTag event");

  const created = await client.createRun({ runId: "run_slack_smoke_1", event });
  assert(created.run.contextPacket?.summary === "investigate the flaky smoke test", "Slack run should include context packet");
  assert(
    created.run.thread?.workItemReference.externalId === event.workItem?.externalId,
    "Bound Slack threads should preserve their canonical work item on the work thread"
  );
  assert(delivered.length === 1, "Slack acknowledgement should be delivered");
  assert(delivered[0]?.provider === "slack", "acknowledgement should target Slack");
  assert(delivered[0]?.kind === "acknowledgement", "first Slack callback should be acknowledgement");

  const claimed = await client.claim({ runnerId: "runner_slack_smoke" });
  assert(claimed?.run.id === "run_slack_smoke_1", "runner should claim the Slack smoke run");
  assert(claimed.event.source === "slack", "claimed event should remain Slack-shaped");

  const progressResponse = await client.progress({
    runnerId: "runner_slack_smoke",
    runId: "run_slack_smoke_1",
    attemptId: claimed.attemptId,
    fencingToken: claimed.fencingToken,
    type: "executor.progress",
    message: "working quietly",
    at: "2026-06-24T00:00:01.000Z"
  });
  assert(progressResponse === undefined, "progress call should complete");
  assert(delivered.length === 1, "Slack progress should remain audit-only by default");

  await client.complete({
    runnerId: "runner_slack_smoke",
    runId: "run_slack_smoke_1",
    attemptId: claimed.attemptId,
    fencingToken: claimed.fencingToken,
    result: {
      conclusion: "needs_human",
      summary: "Prepared a Slack-originated follow-up task.",
      suggestedChanges: [
        {
          proposalId: "proposal_slack_smoke_1",
          createdAt: "2026-06-24T00:00:02.000Z",
          summary: "Request review in the primary Slack thread.",
          intents: [
            {
              intentId: "intent_slack_review",
              domain: "review",
              action: "request_review",
              summary: "Ask a human to review the investigation summary.",
              params: { surface: "slack" }
            }
          ]
        }
      ],
      nextAction: {
        summary: "Ask for human review in the Slack thread.",
        hint: {
          kind: "request_review",
          targetId: "proposal_slack_smoke_1",
          selectedIntentIds: ["intent_slack_review"]
        }
      }
    }
  });

  const finalCallbacks = delivered.filter((message) => message.kind === "final");
  assert(finalCallbacks.length === 1, "Slack should deliver exactly one final callback");
  const finalCallback = finalCallbacks[0];
  assert(finalCallback?.provider === "slack", "final callback should target Slack");
  assert(finalCallback.body.includes("Prepared a Slack-originated follow-up task."), "final Slack body should include summary");
  assert(finalCallback.blocks && finalCallback.blocks.length > 0, "final Slack callback should include Block Kit blocks");

  const proposal = await client.getProposal({ proposalId: "proposal_slack_smoke_1" });
  assert(proposal.runId === "run_slack_smoke_1", "Slack proposal should point to source run");
  assert(proposal.snapshot.sourceRunId === "run_slack_smoke_1", "Slack proposal should carry sourceRunId");
  assert(
    proposal.snapshot.workThread?.workItemReference.externalId === event.workItem?.externalId,
    "Slack proposal should preserve the bound thread work item"
  );

  const lineage = await client.getProposalLineage({ proposalId: "proposal_slack_smoke_1" });
  assert(lineage.lineage.entries[0]?.status === "current", "Slack proposal intent should be current");

  const threadAction = await client.submitThreadAction({
    id: "approval_slack_smoke_1",
    rawText: "apply 1",
    actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
    callback: event.callback,
    metadata: { source: "smoke", teamId: "T123", channelId: "C123" }
  });
  assert(threadAction.outcome === "child_run_created", "Slack apply should fall back to a child run when no direct adapter compiler exists");
  assert(threadAction.decision?.id === "approval_slack_smoke_1", "Slack thread action should record approval");
  assert(threadAction.plan?.outcomes?.[0]?.outcome === "unsupported", "Slack request_review should not direct-apply without a PR update capability");
  assert(threadAction.run?.parentRunId === "run_slack_smoke_1", "Slack child run should reference parent");
  assert(threadAction.run?.sourceProposalId === "proposal_slack_smoke_1", "Slack child run should reference proposal");
  assert(threadAction.run?.sourceApplyPlanId === threadAction.plan?.id, "Slack child run should reference apply plan");
  assert(threadAction.run?.triggeredByAction?.kind === "apply_suggested_changes", "Slack child run should carry apply action");

  const events = await client.listRunEvents({ runId: "run_slack_smoke_1" });
  const eventTypes = events.events.map((event) => (event as { type: string }).type);
  for (const expected of [
    "run.created",
    "context_packet.generated",
    "callback.acknowledgement.delivered",
    "run.progress",
    "proposal.snapshot.created",
    "run.completed",
    "callback.final.delivered",
    "approval.decision.recorded",
    "apply_plan.created",
    "run.child_created"
  ]) {
    assertIncludes(eventTypes, expected, "Slack parent run audit trail is incomplete");
  }

  const metrics = await client.getRunMetrics({ runId: "run_slack_smoke_1" });
  assert(metrics.metrics.humanCallbackCount === delivered.length, "Slack callback metrics should match the delivered sink messages");
  assert(metrics.metrics.humanCallbackCount >= 3 && metrics.metrics.humanCallbackCount <= 4, "Slack smoke should stay within its compact callback budget");
  assert(metrics.metrics.auditEventCount > metrics.metrics.humanCallbackCount, "Slack audit events should exceed human callbacks");
  assert(metrics.metrics.threadNoiseRatio < 1, "Slack thread noise ratio should stay below 1");
  assert(metrics.metrics.suggestedChangesCount === 1, "Slack metrics should count suggested changes");
  assert(metrics.metrics.approvalDecisionCount === 1, "Slack metrics should count approvals");
  assert(metrics.metrics.applyPlanCount === 1, "Slack metrics should count apply plans");
  assert(metrics.metrics.childRunCount === 1, "Slack metrics should count child runs");
  assert(metrics.metrics.applyOutcomeCounts.unsupported === 1, "Slack metrics should count unsupported direct-apply outcomes");

  console.log("slack-protocol-runtime-smoke: ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
