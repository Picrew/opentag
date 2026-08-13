#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDispatcherClient, createOpenTagClient } from "../../packages/client/src/index.js";
import type { OpenTagEvent, WorkstreamAdmissionBatchInput } from "../../packages/core/src/index.js";
import {
  createDispatcherApp,
  openDispatcherDatabase,
  type DispatcherDeliveryPresentation,
  type GitHubCompletionPolicy,
} from "../../packages/dispatcher/src/index.js";
import { runOneDaemonIteration } from "../../packages/local-runtime/src/index.js";
import {
  createAcpAgentExecutor,
  createEchoExecutor,
  type ExecutorAdapter,
  type ExecutorRunInput
} from "../../packages/runner/src/index.js";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const acpFixture = resolve(repositoryRoot, "packages/runner/test/fixtures/acp-agent.mjs");
const reportPath = process.env.OPENTAG_FACTORY_CONFORMANCE_REPORT?.trim();
const pairingToken = "phase4b-conformance-token";
const runnerId = "runner_phase4b_conformance";
const repositoryOwner = "opentag-conformance";
const repositoryName = "factory";
const completionPolicy: GitHubCompletionPolicy = {
  provider: "github",
  owner: repositoryOwner,
  repo: repositoryName,
  requiredChecks: ["factory-conformance"],
  baseBranch: "main",
  requireMerge: true
};

type ExecutorObservation = {
  executorId: string;
  runId: string;
  workspaceKind: ExecutorRunInput["workspace"]["kind"];
  workspacePath: string;
};

type DispatcherHarness = {
  baseUrl: string;
  close(): Promise<void>;
};

function factoryEvent(input: {
  lane: "echo" | "acp";
  eventId: string;
  sourceEventId: string;
  receivedAt: string;
  workItemExternalId?: string;
}): OpenTagEvent {
  const workItemExternalId = input.workItemExternalId ?? `ticket-${input.lane}`;
  const issueNumber = input.lane === "echo" ? 1 : 2;
  return {
    id: input.eventId,
    source: "github",
    sourceEventId: input.sourceEventId,
    receivedAt: input.receivedAt,
    actor: {
      provider: "github",
      providerUserId: "phase4b-operator",
      handle: "phase4b",
      writeAccess: true
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(input.lane === "acp" ? { executorHint: "custom" as const } : {})
    },
    command: {
      rawText: `Run the deterministic Phase 4B ${input.lane} factory lane.`,
      intent: "run",
      args: { lane: input.lane }
    },
    context: [{
      provider: "github",
      kind: "issue",
      uri: `https://github.com/${repositoryOwner}/${repositoryName}/issues/${issueNumber}`,
      visibility: "public"
    }],
    workItem: {
      provider: "github",
      kind: "issue",
      externalId: workItemExternalId,
      uri: `https://github.com/${repositoryOwner}/${repositoryName}/issues/${issueNumber}`,
      title: `Phase 4B ${input.lane} lane`,
      ownerContainer: {
        provider: "github",
        id: `${repositoryOwner}/${repositoryName}`,
        uri: `https://github.com/${repositoryOwner}/${repositoryName}`
      }
    },
    permissions: input.lane === "acp"
      ? [{
          scope: "repo:write",
          reason: "Allow the local ACP fixture to write its deterministic repository artifact."
        }]
      : [{
          scope: "issue:comment",
          reason: "Return the governed conformance result to its source thread."
        }],
    callback: {
      provider: "github",
      uri: `https://api.github.com/repos/${repositoryOwner}/${repositoryName}/issues/${issueNumber}/comments`,
      threadKey: `${repositoryOwner}/${repositoryName}#${issueNumber}`
    },
    metadata: {
      conformance: "phase4b",
      lane: input.lane,
      repoProvider: "github",
      owner: repositoryOwner,
      repo: repositoryName,
      issueNumber
    }
  };
}

function observedExecutor(adapter: ExecutorAdapter, observations: ExecutorObservation[]): ExecutorAdapter {
  return {
    ...adapter,
    async run(input, sink) {
      observations.push({
        executorId: adapter.id,
        runId: input.runId,
        workspaceKind: input.workspace.kind,
        workspacePath: input.workspace.path
      });
      const result = await adapter.run(input, sink);
      return {
        ...result,
        createdPullRequestUrl: `https://github.com/${repositoryOwner}/${repositoryName}/pull/${adapter.id === "echo" ? 101 : 102}`
      };
    }
  };
}

async function startHarness(input: {
  databasePath: string;
  deliveries: DispatcherDeliveryPresentation[];
}): Promise<DispatcherHarness> {
  const sqlite = openDispatcherDatabase(input.databasePath);
  const app = createDispatcherApp({
    databasePath: input.databasePath,
    sqlite,
    pairingToken,
    completionPolicies: [completionPolicy],
    deliveryProducer: {
      async enqueue(presentation) {
        input.deliveries.push(presentation);
        return {
          outcome: "queued",
          sideEffectIntentId: `intent_factory_conformance_${input.deliveries.length}`
        };
      }
    }
  });
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const address = server.address();
      assert(address && typeof address !== "string", "Dispatcher must listen on a TCP port.");
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const webResponse = await app.fetch(new Request(
        `http://127.0.0.1:${address.port}${request.url ?? "/"}`,
        {
          method: request.method,
          headers: new Headers(request.headers as Record<string, string>),
          ...(body ? { body } : {})
        }
      ));
      response.statusCode = webResponse.status;
      webResponse.headers.forEach((value, key) => response.setHeader(key, value));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Dispatcher must listen on a TCP port.");
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          server.close((error?: Error) => {
            if (error) rejectPromise(error);
            else resolvePromise();
          });
          server.closeAllConnections();
        });
      } finally {
        sqlite.close();
      }
    }
  };
}

function initRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "opentag@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "OpenTag Conformance"], { cwd: path });
  writeFileSync(join(path, "README.md"), "# Phase 4B factory conformance\n");
  execFileSync("git", ["add", "README.md"], { cwd: path });
  execFileSync("git", ["commit", "-m", "Initialize factory conformance fixture"], { cwd: path, stdio: "ignore" });
}

function findNamedFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = findNamedFile(candidate, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function ingestAcceptedGitHubOutcome(
  client: ReturnType<typeof createOpenTagClient>,
  input: { deliveryId: string; pullRequestNumber: number; headSha: string; payloadDigestCharacter: string }
): Promise<void> {
  await client.ingestGitHubCompletionEvidence({
    provider: "github",
    deliveryId: input.deliveryId,
    eventName: "pull_request",
    repository: { owner: repositoryOwner, repo: repositoryName },
    pullRequest: {
      number: input.pullRequestNumber,
      resourceRef: `github:${repositoryOwner}/${repositoryName}:pull_request:${input.pullRequestNumber}`,
      headSha: input.headSha,
      baseSha: "b".repeat(40),
      baseBranch: "main",
      state: "merged"
    },
    checks: { "factory-conformance": "passed" },
    observedAt: "2026-07-26T01:05:00.000Z",
    payloadDigest: `sha256:${input.payloadDigestCharacter.repeat(64)}`
  });
}

function executorRegistration(adapter: ExecutorAdapter) {
  assert(adapter.capability, `${adapter.id} must expose a typed capability contract.`);
  return {
    executorId: adapter.id,
    capability: adapter.capability,
    readiness: "ready" as const,
    reason: "Deterministic conformance adapter is ready."
  };
}

function requireCreatedWorkThread(
  result: Awaited<ReturnType<ReturnType<typeof createOpenTagClient>["createRun"]>>,
  expectedRunId: string
): string {
  assert.equal(result.outcome, "run_created", `${expectedRunId} must create a seed run.`);
  assert.equal(result.run.id, expectedRunId);
  assert(result.run.thread?.id, `${expectedRunId} must create a durable WorkThread.`);
  return result.run.thread.id;
}

async function rawBatchRequest(baseUrl: string, batch: WorkstreamAdmissionBatchInput): Promise<Response> {
  return fetch(`${baseUrl}/v1/workstream-batches`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pairingToken}`
    },
    body: JSON.stringify(batch)
  });
}

function writeReport(report: unknown): void {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    const absolute = resolve(repositoryRoot, reportPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, serialized, { mode: 0o600 });
    chmodSync(absolute, 0o600);
  }
  process.stdout.write(serialized);
}

async function main(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "opentag-factory-conformance-"));
  const databasePath = join(fixtureRoot, "dispatcher.sqlite");
  const scratchRoot = join(fixtureRoot, "scratch");
  const checkoutPath = join(fixtureRoot, "repository");
  const deliveries: DispatcherDeliveryPresentation[] = [];
  const observations: ExecutorObservation[] = [];
  const echoExecutor = observedExecutor(createEchoExecutor(), observations);
  const acpExecutor = observedExecutor(createAcpAgentExecutor({
    id: "custom",
    label: "Local ACP conformance fixture",
    workspaceCwd: "required",
    launch: {
      command: process.execPath,
      args: [acpFixture, "success"]
    },
    capabilities: {
      supportsProfile: false,
      supportsCancel: true
    }
  }), observations);
  let firstHarness: DispatcherHarness | undefined;
  let recoveredHarness: DispatcherHarness | undefined;

  try {
    initRepository(checkoutPath);
    firstHarness = await startHarness({ databasePath, deliveries });
    const firstClient = createOpenTagClient({ dispatcherUrl: firstHarness.baseUrl, pairingToken });
    await firstClient.registerRunner({
      runnerId,
      name: "Phase 4B deterministic conformance runner",
      locality: "local",
      declaredState: "ready",
      maxConcurrentRuns: 2,
      executors: [executorRegistration(echoExecutor), executorRegistration(acpExecutor)]
    });
    await firstClient.bindRepository({
      provider: "github",
      owner: repositoryOwner,
      repo: repositoryName,
      runnerId,
      workspacePath: checkoutPath,
      defaultExecutor: "echo",
      fallbackExecutorIds: ["custom"],
      allowedActors: ["phase4b"]
    });

    const echoThreadId = requireCreatedWorkThread(await firstClient.createRun({
      runId: "run_phase4b_seed_echo",
      event: factoryEvent({
        lane: "echo",
        eventId: "evt_phase4b_seed_echo",
        sourceEventId: "source_phase4b_seed_echo",
        receivedAt: "2026-07-26T01:00:00.000Z"
      })
    }), "run_phase4b_seed_echo");
    const acpThreadId = requireCreatedWorkThread(await firstClient.createRun({
      runId: "run_phase4b_seed_acp",
      event: factoryEvent({
        lane: "acp",
        eventId: "evt_phase4b_seed_acp",
        sourceEventId: "source_phase4b_seed_acp",
        receivedAt: "2026-07-26T01:00:01.000Z"
      })
    }), "run_phase4b_seed_acp");
    await firstClient.cancelRun({ runId: "run_phase4b_seed_echo", reason: "Seeded durable WorkThread." });
    await firstClient.cancelRun({ runId: "run_phase4b_seed_acp", reason: "Seeded durable WorkThread." });
    deliveries.length = 0;

    const { recipe } = await firstClient.createFactoryRecipeSnapshot({
      id: "recipe_phase4b_conformance",
      version: 1,
      name: "Phase 4B deterministic factory loop",
      budgets: {
        maxConcurrentRuns: 2,
        maxAttemptsPerRun: 2,
        maxCostUnits: 4,
        costUnitsPerAttempt: 1,
        allowedLocalities: ["local"]
      }
    });
    const { workstream } = await firstClient.createWorkstream({
      id: "workstream_phase4b_conformance",
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      name: "Phase 4B two-executor loop",
      members: [
        { kind: "work_thread", workThreadId: echoThreadId },
        { kind: "work_thread", workThreadId: acpThreadId }
      ]
    });
    const acceptedBatch: WorkstreamAdmissionBatchInput = {
      id: "batch_phase4b_accepted",
      workstreamId: workstream.id,
      items: [
        {
          itemId: "item_phase4b_echo",
          runId: "run_phase4b_echo",
          workThreadId: echoThreadId,
          event: factoryEvent({
            lane: "echo",
            eventId: "evt_phase4b_echo",
            sourceEventId: "source_phase4b_echo",
            receivedAt: "2026-07-26T01:01:00.000Z"
          })
        },
        {
          itemId: "item_phase4b_acp",
          runId: "run_phase4b_acp",
          workThreadId: acpThreadId,
          event: factoryEvent({
            lane: "acp",
            eventId: "evt_phase4b_acp",
            sourceEventId: "source_phase4b_acp",
            receivedAt: "2026-07-26T01:01:01.000Z"
          })
        }
      ]
    };
    const { receipt: admittedReceipt } = await firstClient.createWorkstreamAdmissionBatch(acceptedBatch);
    assert.equal(admittedReceipt.status, "completed");
    assert.deepEqual(admittedReceipt.result?.summary, {
      totalItems: 2,
      createdCount: 2,
      idempotentReplayCount: 0,
      followUpQueuedCount: 0,
      waitActiveRunCount: 0,
      needsHumanDecisionCount: 0,
      rejectedCount: 0,
      exceptionCount: 0,
      exceptions: [],
      omittedExceptionCount: 0
    });
    assert.equal(deliveries.length, 0, "Batch admission must not enqueue routine delivery presentations.");

    await firstHarness.close();
    firstHarness = undefined;
    recoveredHarness = await startHarness({ databasePath, deliveries });
    const recoveredClient = createOpenTagClient({ dispatcherUrl: recoveredHarness.baseUrl, pairingToken });
    const durableBeforeReplay = await recoveredClient.getWorkstreamAdmissionBatch({ id: acceptedBatch.id });
    assert.deepEqual(durableBeforeReplay.receipt, admittedReceipt, "Restart must preserve the exact durable receipt.");
    const replay = await recoveredClient.createWorkstreamAdmissionBatch(acceptedBatch);
    assert.deepEqual(replay.receipt, admittedReceipt, "Exact replay after restart must return the same receipt.");
    const conflictResponse = await rawBatchRequest(recoveredHarness.baseUrl, {
      ...acceptedBatch,
      items: acceptedBatch.items.map((item, index) => index === 0
        ? {
            ...item,
            event: {
              ...item.event,
              command: { ...item.event.command, rawText: "Conflicting replay body." }
            }
          }
        : item)
    });
    assert.equal(conflictResponse.status, 409, "Conflicting replay must fail with HTTP 409.");
    assert.deepEqual(await conflictResponse.json(), { error: "workstream_batch_conflict" });

    const daemonClient = createDispatcherClient({
      dispatcherUrl: recoveredHarness.baseUrl,
      runnerId,
      pairingToken
    });
    const daemonInput = {
      runnerId,
      repositories: [{
        provider: "github",
        owner: repositoryOwner,
        repo: repositoryName,
        checkoutPath,
        defaultExecutor: "echo",
        fallbackExecutorIds: ["custom"],
        baseBranch: "main",
        pushRemote: "origin",
        keepWorktree: "always" as const
      }],
      executors: { echo: echoExecutor, custom: acpExecutor },
      scratchRoot,
      keepScratch: "always" as const,
      heartbeatIntervalMs: 0,
      client: daemonClient
    };
    assert.equal(await runOneDaemonIteration(daemonInput), true, "First admitted run must execute.");
    assert.equal(await runOneDaemonIteration(daemonInput), true, "Second admitted run must execute.");
    assert.equal(await runOneDaemonIteration(daemonInput), false, "Durable replay must not create duplicate work.");
    const executorIdsObserved = observations.map((entry) => entry.executorId).sort();
    if (executorIdsObserved.length !== 2) {
      const diagnostic = await recoveredClient.getRun({ runId: "run_phase4b_acp" });
      const diagnosticEvents = await recoveredClient.listRunEvents({ runId: "run_phase4b_acp" });
      assert.deepEqual(executorIdsObserved, ["custom", "echo"], JSON.stringify({ diagnostic, diagnosticEvents }));
    }
    assert.deepEqual(executorIdsObserved, ["custom", "echo"]);
    assert(observations.every((entry) => entry.workspaceKind === "repository"));
    const acpObservation = observations.find((entry) => entry.executorId === "custom");
    assert(acpObservation, "The local ACP fixture adapter must execute.");
    const acpFixtureArtifact = findNamedFile(checkoutPath, "acp-output.txt");
    assert(acpFixtureArtifact, "The retained ACP worktree must contain the fixture artifact.");
    assert.equal(
      readFileSync(acpFixtureArtifact, "utf8"),
      "created by the ACP fixture\n",
      "The ACP path must be proven by its fixture artifact."
    );

    const { metrics: preEvidenceWorkstreamMetrics } = await recoveredClient.getWorkstreamMetrics({ id: workstream.id });
    const { metrics: preEvidenceAcceptedMetrics } = await recoveredClient.getAcceptedProgressMetrics();
    assert.equal(preEvidenceWorkstreamMetrics.terminalRunCount, 2);
    assert.equal(preEvidenceWorkstreamMetrics.acceptedWorkThreadCount, 0);
    assert.equal(preEvidenceAcceptedMetrics.completedRuns, 2);
    assert.equal(preEvidenceAcceptedMetrics.runsWithAcceptedProgress, 2);
    assert.equal(preEvidenceAcceptedMetrics.acceptedGateAdvances, 2);
    assert.equal(preEvidenceAcceptedMetrics.attributedAcceptedGateAdvances, 2);
    assert.equal(preEvidenceAcceptedMetrics.unresolvedAcceptedGateAdvances, 0);

    await ingestAcceptedGitHubOutcome(recoveredClient, {
      deliveryId: "delivery_phase4b_echo",
      pullRequestNumber: 101,
      headSha: "1".repeat(40),
      payloadDigestCharacter: "c"
    });
    await ingestAcceptedGitHubOutcome(recoveredClient, {
      deliveryId: "delivery_phase4b_acp",
      pullRequestNumber: 102,
      headSha: "2".repeat(40),
      payloadDigestCharacter: "d"
    });

    const { metrics: workstreamMetrics } = await recoveredClient.getWorkstreamMetrics({ id: workstream.id });
    const { evaluation } = await recoveredClient.getWorkstreamEvaluation({ id: workstream.id });
    assert.equal(workstreamMetrics.runCount, 2);
    assert.equal(workstreamMetrics.terminalRunCount, 2);
    assert.equal(workstreamMetrics.totalAttempts, 2);
    assert.equal(workstreamMetrics.acceptedWorkThreadCount, 2);
    assert.equal(evaluation.status, "healthy");
    assert.equal(evaluation.acceptedWorkThreadCount, 2);

    const { metrics: acceptedMetrics } = await recoveredClient.getAcceptedProgressMetrics();
    assert.equal(acceptedMetrics.completedRuns, 2);
    assert.equal(acceptedMetrics.runsWithAcceptedProgress, 2);
    assert.equal(acceptedMetrics.acceptedGateAdvances, 10);
    assert.equal(acceptedMetrics.attributedAcceptedGateAdvances, 10);
    assert.equal(acceptedMetrics.unresolvedAcceptedGateAdvances, 0);
    for (const executorId of ["echo", "custom"]) {
      const segment = acceptedMetrics.byExecutor.find((entry) => entry.id === executorId);
      assert(segment, `Accepted metrics must include executor '${executorId}'.`);
      assert.deepEqual(segment, {
        id: executorId,
        completedRuns: 1,
        runsWithAcceptedProgress: 1,
        acceptedGateAdvances: 5
      });
    }

    const acceptedAuthorities = await Promise.all([
      { runId: "run_phase4b_echo", workThreadId: echoThreadId, executorId: "echo" },
      { runId: "run_phase4b_acp", workThreadId: acpThreadId, executorId: "custom" }
    ].map(async (expected) => {
      const [{ completion }, { run }, { events }] = await Promise.all([
        recoveredClient.getCompletion({ runId: expected.runId }),
        recoveredClient.getRun({ runId: expected.runId }),
        recoveredClient.listRunEvents({ runId: expected.runId })
      ]);
      assert.equal(run.status, "succeeded", `${expected.runId} must be terminal and successful.`);
      assert.equal(completion.completion, "satisfied");
      assert.equal(completion.currentAssessment.state, "satisfied");
      assert.equal(completion.currentAssessment.workThreadId, expected.workThreadId);
      assert.equal(completion.currentAssessment.triggeredByRunId, expected.runId);
      const claimedEvents = events.filter((event): event is {
        type: string;
        payload: { executorId?: unknown; attemptId?: unknown; attemptNumber?: unknown };
      } => Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "run.claimed"));
      const latestClaim = claimedEvents.at(-1);
      assert(latestClaim, `${expected.runId} must expose its latest claimed Attempt in the public event stream.`);
      assert.equal(latestClaim.payload.executorId, expected.executorId);
      assert.equal(typeof latestClaim.payload.attemptId, "string");
      assert.equal(latestClaim.payload.attemptNumber, 1);
      return {
        runId: expected.runId,
        workThreadId: expected.workThreadId,
        terminalStatus: run.status,
        currentAssessmentId: completion.currentAssessment.id,
        currentAssessmentState: completion.currentAssessment.state,
        currentAssessmentTriggeredByRunId: completion.currentAssessment.triggeredByRunId,
        latestAttemptId: latestClaim.payload.attemptId,
        latestAttemptNumber: latestClaim.payload.attemptNumber,
        latestAttemptExecutorId: latestClaim.payload.executorId
      };
    }));

    const deliveriesBeforeInvalidBatch = deliveries.length;
    const invalidBatch: WorkstreamAdmissionBatchInput = {
      id: "batch_phase4b_bounded_exceptions",
      workstreamId: workstream.id,
      items: Array.from({ length: 12 }, (_, index) => ({
        itemId: `item_phase4b_invalid_${index}`,
        runId: `run_phase4b_invalid_${index}`,
        workThreadId: echoThreadId,
        event: factoryEvent({
          lane: "echo",
          eventId: `evt_phase4b_invalid_${index}`,
          sourceEventId: `source_phase4b_invalid_${index}`,
          receivedAt: `2026-07-26T01:${String(index + 10).padStart(2, "0")}:00.000Z`,
          workItemExternalId: `mismatched-ticket-${index}`
        })
      }))
    };
    const { receipt: invalidReceipt } = await recoveredClient.createWorkstreamAdmissionBatch(invalidBatch);
    assert.equal(invalidReceipt.status, "completed");
    assert.equal(invalidReceipt.result?.summary.totalItems, 12);
    assert.equal(invalidReceipt.result?.summary.rejectedCount, 12);
    assert.equal(invalidReceipt.result?.summary.exceptionCount, 12);
    assert.equal(invalidReceipt.result?.summary.exceptions.length, 10);
    assert.equal(invalidReceipt.result?.summary.omittedExceptionCount, 2);
    assert(invalidReceipt.result?.summary.exceptions.every((entry) => (
      entry.status === "rejected" && entry.reasonCode === "event_work_thread_mismatch"
    )));
    assert.equal(
      deliveries.length - deliveriesBeforeInvalidBatch,
      0,
      "Exceptional batch admission must not enqueue delivery presentations."
    );

    writeReport({
      schemaVersion: 1,
      proof: "opentag.phase4b.factory-conformance",
      proofClass: "deterministic_runtime_conformance",
      providerLive: false,
      statement: "This report proves deterministic OpenTag runtime conformance; it is not provider-live public proof.",
      providerEvidenceMode: "Deterministic GitHub snapshots were submitted through the authenticated public dispatcher ingestion seam.",
      excludedScope: ["dag", "operator_console"],
      recipe: {
        id: recipe.id,
        version: recipe.version,
        contentDigest: recipe.contentDigest
      },
      workstream: {
        id: workstream.id,
        contentDigest: workstream.contentDigest,
        workThreadCount: workstream.members.length
      },
      acceptedBatch: {
        id: admittedReceipt.batch.id,
        contentDigest: admittedReceipt.batch.contentDigest,
        inputDigest: admittedReceipt.result?.inputDigest,
        status: admittedReceipt.status,
        createdCount: admittedReceipt.result?.summary.createdCount
      },
      restartSafety: {
        dispatcherReopenedFromFileDatabase: true,
        durableReceiptPreservedExactly: true,
        exactReplayPreservedExactly: true,
        conflictStatus: conflictResponse.status,
        duplicateWorkClaimedAfterExecution: false
      },
      executorPaths: observations.map((entry) => ({
        executorId: entry.executorId,
        adapter: entry.executorId === "echo" ? "Echo Executor" : "Local ACP conformance fixture",
        runId: entry.runId,
        workspaceKind: entry.workspaceKind,
        ...(entry.executorId === "custom" ? { fixtureArtifactObserved: true } : {})
      })),
      boundedExceptions: {
        batchId: invalidReceipt.batch.id,
        totalItems: invalidReceipt.result?.summary.totalItems,
        exceptionCount: invalidReceipt.result?.summary.exceptionCount,
        recordedExceptionCount: invalidReceipt.result?.summary.exceptions.length,
        omittedExceptionCount: invalidReceipt.result?.summary.omittedExceptionCount,
        deliveryPresentationCount: deliveries.length - deliveriesBeforeInvalidBatch
      },
      authoritativeAcceptedOutcomes: acceptedMetrics,
      acceptedOutcomeAuthorityTransition: {
        beforeVerifiedEvidence: {
          terminalRuns: preEvidenceWorkstreamMetrics.terminalRunCount,
          acceptedWorkThreads: preEvidenceWorkstreamMetrics.acceptedWorkThreadCount,
          completedRuns: preEvidenceAcceptedMetrics.completedRuns,
          acceptedGateAdvances: preEvidenceAcceptedMetrics.acceptedGateAdvances
        },
        afterVerifiedEvidence: {
          terminalRuns: workstreamMetrics.terminalRunCount,
          acceptedWorkThreads: workstreamMetrics.acceptedWorkThreadCount,
          completedRuns: acceptedMetrics.completedRuns,
          acceptedGateAdvances: acceptedMetrics.acceptedGateAdvances
        },
        authorityRule: "Terminal Run success alone is not accepted; current WorkThread acceptance comes only from the current evidence-backed CompletionAssessment."
      },
      acceptedOutcomeAuthority: {
        basis: "current CompletionAssessment authority plus accepted gate-to-target-to-artifact-to-source-Run attribution; terminal Attempts provide execution dimensions only",
        workThreads: acceptedAuthorities
      },
      workstreamMetrics,
      workstreamEvaluation: evaluation
    });
  } finally {
    if (firstHarness) await firstHarness.close().catch(() => undefined);
    if (recoveredHarness) await recoveredHarness.close().catch(() => undefined);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
