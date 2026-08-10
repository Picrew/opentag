/**
 * Local smoke for the zero-config GitHub verified completion path:
 * Slack-bound mention → executor success with PR → waiting for evidence →
 * green checks → satisfied.
 *
 * No live Slack/GitHub credentials required; exercises Slack normalize plus
 * the dispatcher control plane.
 */
import { createDispatcherApp, type CallbackMessage } from "../../packages/dispatcher/src/index.js";
import { normalizeSlackAppMention } from "../../packages/slack/src/index.js";

const HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const RUN_ID = `run_smoke_default_verified_${Date.now()}`;

function slackBoundGitHubEvent() {
  const event = normalizeSlackAppMention({
    teamId: "T123",
    channelId: "C123",
    userId: "U456",
    text: "<@U_APP> fix the flaky test",
    ts: "1719187200.000100",
    eventId: `Ev_${RUN_ID}`,
    eventTime: 1719187200,
    botUserId: "U_APP",
    binding: {
      teamId: "T123",
      channelId: "C123",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }
  });
  if (!event) throw new Error("Slack normalize returned null");
  return {
    ...event,
    actor: { ...event.actor, writeAccess: true as const }
  };
}

function githubSnapshot(input: {
  deliveryId: string;
  checks: Record<string, "passed" | "failed" | "pending">;
  observedAt: string;
}) {
  return {
    provider: "github" as const,
    deliveryId: input.deliveryId,
    eventName: "check_run" as const,
    repository: { owner: "acme", repo: "demo" },
    pullRequest: {
      number: 42,
      resourceRef: "github:acme/demo:pull_request:42",
      headSha: HEAD,
      baseSha: BASE,
      baseBranch: "main",
      state: "open" as const
    },
    checks: input.checks,
    observedAt: input.observedAt,
    payloadDigest: `sha256:${"e".repeat(64)}`
  };
}

async function json(app: ReturnType<typeof createDispatcherApp>, path: string, body?: unknown) {
  const response = await app.request(path, body === undefined
    ? { method: path.includes("claim") ? "POST" : "GET" }
    : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
  const payload = await response.json() as Record<string, unknown>;
  return { status: response.status, payload };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const delivered: CallbackMessage[] = [];
  const app = createDispatcherApp({
    databasePath: ":memory:",
    reassessmentObligations: { autoStart: false },
    callbackSink: {
      async deliver(message) {
        delivered.push(message);
        return { handled: true, outcome: "accepted" } as const;
      }
    }
  });

  console.log("1) Bootstrap runner + GitHub project + Slack channel binding");
  assert((await json(app, "/v1/runners", { runnerId: "runner_1", name: "Local Runner" })).status === 201, "runner create failed");
  assert((await json(app, "/v1/repo-bindings", {
    provider: "github",
    owner: "acme",
    repo: "demo",
    runnerId: "runner_1",
    workspacePath: "/tmp/opentag-smoke-demo",
    defaultExecutor: "echo"
  })).status === 201, "repo binding failed");
  assert((await json(app, "/v1/channel-bindings", {
    provider: "slack",
    accountId: "T123",
    conversationId: "C123",
    repoProvider: "github",
    owner: "acme",
    repo: "demo"
  })).status === 201, "slack channel binding failed");

  console.log("2) Slack @mention bound to GitHub project creates a run with a WorkThread");
  const event = slackBoundGitHubEvent();
  assert(event.workItem?.kind === "thread", "normalized Slack event must carry a thread work item");
  const created = await json(app, "/v1/runs", { runId: RUN_ID, event });
  assert(created.status === 201, `run create failed: ${created.status} ${JSON.stringify(created.payload)}`);
  const stored = await json(app, `/v1/runs/${RUN_ID}`);
  const run = (stored.payload as { run?: { thread?: { id?: string } } }).run;
  assert(run?.thread?.id, `run missing WorkThread: ${JSON.stringify(stored.payload)}`);
  const claim = await json(app, "/v1/runners/runner_1/claim");
  assert(claim.status === 200, "claim failed");
  const claimBody = claim.payload as { attemptId: string; fencingToken: string };

  console.log("3) Executor succeeds and ships a PR");
  const complete = await json(app, `/v1/runners/runner_1/runs/${RUN_ID}/complete`, {
    ...claimBody,
    result: {
      conclusion: "success",
      summary: "Opened a pull request with the fix.",
      createdPullRequestUrl: "https://github.com/acme/demo/pull/42"
    }
  });
  assert(complete.status === 200, `complete failed: ${complete.status}`);
  const afterExec = complete.payload as {
    completion?: {
      execution: string;
      completion: string;
      evidenceBacked: boolean;
      contract: { mode: string };
      missingGateIds: string[];
    };
  };
  console.log(JSON.stringify({ stage: "after_executor", completion: afterExec.completion, callback: delivered.at(-1)?.body }, null, 2));
  assert(afterExec.completion, `complete response missing completion projection: ${JSON.stringify(complete.payload)}`);
  assert(afterExec.completion.execution === "succeeded", "expected execution succeeded");
  assert(afterExec.completion.completion === "pending", "expected completion pending");
  assert(afterExec.completion.evidenceBacked === true, "expected evidence-backed");
  assert(afterExec.completion.contract.mode === "governed", "expected default governed contract");
  assert(
    afterExec.completion.missingGateIds.includes("verified_pull_request"),
    "expected verified_pull_request missing until GitHub confirms the pull request"
  );
  assert(afterExec.completion.missingGateIds.includes("observed_checks"), "expected observed_checks missing");
  assert(
    delivered.at(-1)?.body?.includes("waiting for verified repository evidence")
      || delivered.at(-1)?.body?.includes("verified repository evidence"),
    `callback missing waiting copy: ${delivered.at(-1)?.body ?? "<empty>"}`
  );

  console.log("4) GitHub evidence arrives with a failing check — stays unsatisfied");
  const failing = await json(app, "/v1/completion-evidence/github", githubSnapshot({
    deliveryId: `delivery-fail-${RUN_ID}`,
    checks: { build: "passed", test: "failed" },
    observedAt: "2026-08-07T00:05:00.000Z"
  }));
  assert(failing.status === 201, `failing evidence ingest failed: ${failing.status}`);
  const failingBody = failing.payload as { completion: { completion: string; failedGateIds: string[] } };
  console.log(JSON.stringify({ stage: "checks_failed", completion: failingBody.completion }, null, 2));
  assert(failingBody.completion.completion === "unsatisfied", "expected unsatisfied while checks fail");
  assert(failingBody.completion.failedGateIds.includes("observed_checks"), "expected observed_checks failed");

  console.log("5) Checks turn green — completion becomes satisfied");
  const green = await json(app, "/v1/completion-evidence/github", githubSnapshot({
    deliveryId: `delivery-green-${RUN_ID}`,
    checks: { build: "passed", test: "passed" },
    observedAt: "2026-08-07T00:06:00.000Z"
  }));
  assert(green.status === 201, `green evidence ingest failed: ${green.status}`);
  const greenBody = green.payload as {
    completion: { completion: string; missingGateIds: string[]; failedGateIds: string[]; evidenceBacked: boolean };
  };
  console.log(JSON.stringify({
    stage: "checks_green",
    completion: greenBody.completion,
    callback: delivered.at(-1)?.body
  }, null, 2));
  assert(greenBody.completion.completion === "satisfied", "expected satisfied after green checks");
  assert(greenBody.completion.evidenceBacked === true, "expected evidence-backed satisfaction");
  assert(greenBody.completion.missingGateIds.length === 0, "expected no missing gates");
  assert(greenBody.completion.failedGateIds.length === 0, "expected no failed gates");

  console.log("\nSMOKE PASS: Slack→GitHub PR path reached verified satisfaction without an explicit completion policy.");
}

main().catch((error) => {
  console.error("\nSMOKE FAIL:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
