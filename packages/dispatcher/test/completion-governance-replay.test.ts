import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenTagEventSchema, OpenTagRunResultSchema, type OpenTagEvent, type OpenTagRunResult } from "@opentag/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { formatCompletionExplanation } from "../../cli/src/status.js";
import {
  createDispatcherApp,
  type CallbackMessage,
  type CompletionExplanation,
  type GitHubCompletionPolicy
} from "../src/index.js";

type GitHubCompletionSnapshot = {
  provider: "github";
  deliveryId: string;
  eventName: "pull_request" | "check_run" | "check_suite" | "status";
  repository: { owner: string; repo: string };
  pullRequest: {
    number: number;
    resourceRef: string;
    headSha: string;
    baseSha: string;
    baseBranch: string;
    state: "open" | "closed" | "merged";
  };
  checks: Record<string, "passed" | "failed" | "pending">;
  observedAt: string;
  payloadDigest: string;
};

type CompletionReplayFixture = {
  name: string;
  runId: string;
  event: OpenTagEvent;
  executorCapability: Record<string, unknown>;
  result: OpenTagRunResult;
  completionPolicy: GitHubCompletionPolicy;
  verifiedSnapshot: GitHubCompletionSnapshot;
  expected: {
    workItemExternalId: string;
    primaryAnchorExternalId: string;
    pullRequestResourceRef: string;
    requiredEvidenceKinds: string[];
    pendingNextAction: {
      kind: "refresh_completion_evidence";
      targetId: string;
      causeGateIds: string[];
      causeReasonCodes: string[];
    };
    finalNextAction: {
      kind: "none";
      causeCount: number;
    };
    finalBodyContains: string;
  };
};

type StoredRunResponse = {
  run: {
    thread?: {
      id?: string;
      workItemReference: { externalId: string };
      primaryAnchor: { externalId: string };
    };
    contextPacket?: unknown;
    result?: OpenTagRunResult;
  };
};

function loadFixture(): CompletionReplayFixture {
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/replay/github-completion-governance.json", import.meta.url), "utf8")
  ) as CompletionReplayFixture;
  return {
    ...raw,
    event: OpenTagEventSchema.parse(raw.event),
    result: OpenTagRunResultSchema.parse(raw.result)
  };
}

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function expectCredentialSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/u);
  expect(serialized).not.toMatch(/\bglpat-[A-Za-z0-9_-]{20,}\b/u);
  expect(serialized).not.toMatch(/\bx(?:ox[baprs]|app)-[A-Za-z0-9-]{20,}\b/u);
  expect(serialized).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/u);
  expect(serialized).not.toMatch(/\/Users\/[A-Za-z0-9._-]+\/(?:repos|Library|Desktop|Downloads|\.config)\//u);
}

describe("GitHub completion governance replay", () => {
  it("proves the sanitized, live-shaped source-to-verified-completion loop", async () => {
    const fixture = loadFixture();
    const tempRoot = mkdtempSync(join(tmpdir(), "opentag-completion-replay-"));
    const databasePath = join(tempRoot, "opentag.db");
    const delivered: CallbackMessage[] = [];

    try {
      const app = createDispatcherApp({
        databasePath,
        completionPolicies: [fixture.completionPolicy],
        callbackSink: {
          async deliver(message) {
            delivered.push(message);
          }
        }
      });

      expect((await app.request("/v1/runners", jsonRequest({
        runnerId: "runner_replay_completion",
        name: "Completion Replay Runner"
      }))).status).toBe(201);
      expect((await app.request("/v1/repo-bindings", jsonRequest({
        provider: "github",
        owner: fixture.completionPolicy.owner,
        repo: fixture.completionPolicy.repo,
        runnerId: "runner_replay_completion",
        workspacePath: "/Users/test/phase1-demo",
        defaultExecutor: "echo",
        allowedActors: [fixture.event.actor.handle]
      }))).status).toBe(201);

      const admissionResponse = await app.request("/v1/runs", jsonRequest({
        runId: fixture.runId,
        event: fixture.event
      }));
      expect(admissionResponse.status).toBe(201);
      await expect(admissionResponse.json()).resolves.toMatchObject({
        decision: { action: "start", reasonCode: "new_event" },
        run: { id: fixture.runId, status: "queued" }
      });

      const storedResponse = await app.request(`/v1/runs/${fixture.runId}`);
      expect(storedResponse.status).toBe(200);
      const stored = await storedResponse.json() as StoredRunResponse;
      expect(stored.run.thread).toMatchObject({
        workItemReference: { externalId: fixture.expected.workItemExternalId },
        primaryAnchor: { externalId: fixture.expected.primaryAnchorExternalId }
      });
      expect(stored.run.thread?.id).toBeTruthy();
      expect(stored.run.contextPacket).toBeDefined();
      const workThreadId = stored.run.thread?.id as string;

      const claimResponse = await app.request("/v1/runners/runner_replay_completion/claim", { method: "POST" });
      expect(claimResponse.status).toBe(200);
      const lease = await claimResponse.json() as { attemptId: string; fencingToken: string };
      expect(lease.attemptId).toBeTruthy();
      expect(lease.fencingToken).toBeTruthy();

      const staleCompletion = await app.request(
        `/v1/runners/runner_replay_completion/runs/${fixture.runId}/complete`,
        jsonRequest({
          attemptId: lease.attemptId,
          fencingToken: "fence_stale_replay_attempt",
          idempotencyKey: `${fixture.runId}:stale-complete`,
          result: fixture.result
        })
      );
      expect(staleCompletion.status).toBe(409);
      await expect(staleCompletion.json()).resolves.toEqual({ error: "stale_attempt" });

      const runningResponse = await app.request(
        `/v1/runners/runner_replay_completion/runs/${fixture.runId}/running`,
        jsonRequest({
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
          executor: "echo",
          executorCapability: fixture.executorCapability,
          idempotencyKey: `${fixture.runId}:running`
        })
      );
      expect(runningResponse.status).toBe(200);

      const completeResponse = await app.request(
        `/v1/runners/runner_replay_completion/runs/${fixture.runId}/complete`,
        jsonRequest({
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
          idempotencyKey: `${fixture.runId}:complete`,
          result: fixture.result
        })
      );
      expect(completeResponse.status).toBe(200);
      await expect(completeResponse.json()).resolves.toMatchObject({
        ok: true,
        completion: {
          execution: "succeeded",
          completion: "pending",
          evidenceBacked: true,
          missingGateIds: ["required_checks", "base_branch", "merge"]
        }
      });
      expect(delivered.at(-1)?.body).toContain("Execution succeeded");
      expect(delivered.at(-1)?.body).toContain("verified repository evidence");

      const pendingResponse = await app.request(`/v1/runs/${fixture.runId}/completion`);
      expect(pendingResponse.status).toBe(200);
      const pending = await pendingResponse.json() as { completion: CompletionExplanation };
      expect(pending.completion).toMatchObject({
        completion: "pending",
        currentAssessment: { state: "pending", sequence: 1 },
        assessmentHistory: [{ state: "pending", sequence: 1 }],
        nextAction: {
          hint: {
            kind: fixture.expected.pendingNextAction.kind,
            targetId: fixture.expected.pendingNextAction.targetId
          }
        }
      });
      expect(pending.completion.nextAction.causes.flatMap((cause) =>
        cause.kind === "completion_gate" ? [cause.gateId] : []
      )).toEqual(fixture.expected.pendingNextAction.causeGateIds);
      expect(pending.completion.nextAction.causes.flatMap((cause) =>
        cause.kind === "completion_gate" ? [cause.reasonCode] : []
      )).toEqual(fixture.expected.pendingNextAction.causeReasonCodes);
      const pendingAssessmentId = pending.completion.currentAssessment.id;

      const callbacksBeforeEvidence = delivered.length;
      const evidenceResponse = await app.request(
        "/v1/completion-evidence/github",
        jsonRequest(fixture.verifiedSnapshot)
      );
      expect(evidenceResponse.status).toBe(201);
      await expect(evidenceResponse.json()).resolves.toMatchObject({
        outcome: "recorded",
        workThreadId,
        completion: {
          execution: "succeeded",
          completion: "satisfied",
          evidenceBacked: true,
          targetBindings: [{
            resourceRef: fixture.expected.pullRequestResourceRef,
            resourceVersion: fixture.verifiedSnapshot.pullRequest.headSha
          }],
          missingGateIds: [],
          failedGateIds: [],
          blockedGateIds: []
        }
      });
      expect(delivered).toHaveLength(callbacksBeforeEvidence + 1);

      const finalProjection = delivered.at(-1)?.body ?? "";
      expect(finalProjection).toContain(fixture.expected.finalBodyContains);
      expect(finalProjection.length).toBeLessThan(700);
      expect(finalProjection).not.toContain("assessment_");
      expect(finalProjection).not.toContain(fixture.verifiedSnapshot.deliveryId);
      expect(finalProjection).not.toContain(fixture.verifiedSnapshot.payloadDigest);
      expect(finalProjection).not.toContain(fixture.verifiedSnapshot.pullRequest.headSha);
      expectCredentialSafe(finalProjection);

      const satisfiedResponse = await app.request(`/v1/runs/${fixture.runId}/completion`);
      expect(satisfiedResponse.status).toBe(200);
      const satisfied = await satisfiedResponse.json() as { completion: CompletionExplanation };
      expect(satisfied.completion).toMatchObject({
        execution: "succeeded",
        completion: "satisfied",
        evidenceBacked: true,
        currentAssessment: {
          state: "satisfied",
          sequence: 2,
          supersedesAssessmentId: pendingAssessmentId,
          acceptedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
        },
        assessmentHistory: [
          { id: pendingAssessmentId, state: "pending", sequence: 1 },
          { state: "satisfied", sequence: 2, supersedesAssessmentId: pendingAssessmentId }
        ],
        openHumanEscalations: [],
        nextAction: { hint: { kind: fixture.expected.finalNextAction.kind } }
      });
      expect(satisfied.completion.nextAction.causes).toHaveLength(fixture.expected.finalNextAction.causeCount);
      expect(satisfied.completion.evidence.map((item) => item.kind)).toEqual(
        expect.arrayContaining(fixture.expected.requiredEvidenceKinds)
      );
      expect(satisfied.completion.evidence.every((item) =>
        item.assurance === "verified"
        && item.subject.resourceRef === fixture.expected.pullRequestResourceRef
        && item.subject.resourceVersion === fixture.verifiedSnapshot.pullRequest.headSha
      )).toBe(true);

      const cliStatus = formatCompletionExplanation(satisfied.completion).join("\n");
      for (const expectedText of [
        "Execution: succeeded",
        "Completion: satisfied",
        "mode=governed",
        "Gates:",
        "Evidence:",
        "Assessment lineage:",
        "Missing requirements: none",
        "Failed requirements: none",
        "Blocked requirements: none",
        "Next action:"
      ]) {
        expect(cliStatus).toContain(expectedText);
      }
      expectCredentialSafe(cliStatus);

      const callbacksBeforeDuplicate = delivered.length;
      const duplicateEvidence = await app.request(
        "/v1/completion-evidence/github",
        jsonRequest(fixture.verifiedSnapshot)
      );
      expect(duplicateEvidence.status).toBe(200);
      await expect(duplicateEvidence.json()).resolves.toMatchObject({
        outcome: "duplicate",
        completion: { currentAssessment: { id: satisfied.completion.currentAssessment.id } }
      });
      expect(delivered).toHaveLength(callbacksBeforeDuplicate);

      const database = new Database(databasePath, { readonly: true });
      try {
        const assessmentEvents = database.prepare(
          "SELECT payload_json FROM governance_events WHERE work_thread_id = ? AND type = 'completion_assessment.appended' ORDER BY id"
        ).all(workThreadId) as Array<{ payload_json: string }>;
        expect(assessmentEvents.map((event) => JSON.parse(event.payload_json))).toMatchObject([
          { sequence: 1, state: "pending" },
          { sequence: 2, state: "satisfied", supersedesAssessmentId: pendingAssessmentId }
        ]);
        const metricEvents = database.prepare(
          "SELECT payload_json FROM governance_events WHERE work_thread_id = ? AND type = 'success_metric.observed' ORDER BY id"
        ).all(workThreadId) as Array<{ payload_json: string }>;
        expect(metricEvents).toHaveLength(1);
        expect(JSON.parse(metricEvents[0]!.payload_json)).toMatchObject({
          metric: "time_to_verified_completion_ms",
          state: "satisfied",
          evidenceBacked: true
        });
        expect(JSON.parse(metricEvents[0]!.payload_json).value).toEqual(expect.any(Number));
      } finally {
        database.close();
      }

      const restarted = createDispatcherApp({
        databasePath,
        completionPolicies: [fixture.completionPolicy]
      });
      const replayedCompletion = await restarted.request(`/v1/runs/${fixture.runId}/completion`);
      expect(replayedCompletion.status).toBe(200);
      await expect(replayedCompletion.json()).resolves.toMatchObject({
        completion: {
          workThreadId,
          completion: "satisfied",
          currentAssessment: { id: satisfied.completion.currentAssessment.id, sequence: 2 },
          assessmentHistory: [{ sequence: 1 }, { sequence: 2 }]
        }
      });

      expectCredentialSafe(fixture);
      expectCredentialSafe(satisfied);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
