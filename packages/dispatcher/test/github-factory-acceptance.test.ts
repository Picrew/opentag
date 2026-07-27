import { describe, expect, it } from "vitest";
import {
  buildGitHubFactoryAcceptanceReport,
  normalizeGitHubFactorySourceEvent,
  type GitHubFactoryAcceptanceEvidence
} from "../../../scripts/test/github-factory-acceptance.js";

const digest = `sha256:${"a".repeat(64)}`;

function completion(state: string, requiredChecks: string, merge: string) {
  return {
    completion: state,
    currentAssessment: {
      id: "assessment_live_42",
      inputDigest: digest,
      state,
      targetBindings: [
        {
          key: "primary_change",
          provider: "github",
          resourceRef: "github:amplifthq/opentag-test:pull_request:7",
          resourceVersion: "abc123"
        }
      ],
      gateResults: [
        { gateId: "required_checks", state: requiredChecks },
        { gateId: "merge", state: merge }
      ]
    }
  };
}

function workstreamMetrics(acceptedWorkThreadCount: number) {
  return {
    metrics: {
      workstreamId: "workstream_live_42",
      workThreadCount: 1,
      acceptedWorkThreadCount,
      runCount: 1,
      queuedRunCount: 0,
      activeRunCount: 0,
      needsHumanRunCount: 0,
      terminalRunCount: 1,
      failedRunCount: 0,
      budgetBlockedRunCount: 0,
      exceptionCount: 0,
      totalAttempts: 1,
      attemptsPerRunExceededCount: 0,
      totalCostUnits: 1,
      attemptsByLocality: { local: 1, private: 0, hosted: 0, unknown: 0 }
    }
  };
}

function receipt() {
  return {
    receipt: {
      batch: { id: "batch_live_42", contentDigest: digest },
      status: "completed",
      result: {
        results: [{ itemId: "item_live_42", status: "created", admittedRunId: "run_live_42" }]
      }
    }
  };
}

function evidence(): GitHubFactoryAcceptanceEvidence {
  return {
    recordedAt: "2026-07-27T00:00:00.000Z",
    repository: "amplifthq/opentag-test",
    runtimeSource: "source_checkout",
    source: {
      issueUrl: "https://github.com/amplifthq/opentag-test/issues/42",
      mentionUrl: "https://github.com/amplifthq/opentag-test/issues/42#issuecomment-100",
      issueNumber: 42,
      issueState: "OPEN",
      commentId: "100",
      eventId: "evt_github_comment_100"
    },
    factory: {
      workThreadId: "thread_live_42",
      recipe: { id: "recipe_live_42", version: 1, contentDigest: digest },
      workstream: { id: "workstream_live_42", contentDigest: digest },
      batch: {
        id: "batch_live_42",
        inputDigest: digest,
        initialReceipt: receipt(),
        replayedReceipt: receipt()
      }
    },
    run: {
      id: "run_live_42",
      status: "succeeded",
      workThreadId: "thread_live_42",
      workstreamId: "workstream_live_42",
      admissionBatchId: "batch_live_42",
      contextPacketCaptured: true,
      accessProfileCaptured: true,
      policyProvenanceCaptured: true
    },
    attempt: {
      id: "attempt_live_42",
      runnerId: "runner_live",
      executorId: "phase1-fixture",
      locality: "local",
      status: "succeeded",
      hasFencingToken: true
    },
    pullRequest: {
      number: 7,
      state: "MERGED",
      url: "https://github.com/amplifthq/opentag-test/pull/7",
      headRefOid: "abc123",
      mergedAt: "2026-07-27T00:10:00.000Z",
      mergeCommit: { oid: "def456" }
    },
    requiredCheck: {
      context: "opentag-phase5-live",
      headSha: "abc123",
      state: "success",
      targetUrl: "https://github.com/amplifthq/opentag-test/pull/7"
    },
    completion: {
      afterExecutorSuccess: completion("pending", "missing", "missing"),
      afterRequiredCheck: completion("pending", "passed", "missing"),
      afterMerge: completion("satisfied", "passed", "passed"),
      afterRestart: completion("satisfied", "passed", "passed")
    },
    metrics: {
      beforeProviderEvidence: workstreamMetrics(0),
      afterMerge: workstreamMetrics(1),
      afterRestart: workstreamMetrics(1)
    },
    assessmentCount: 3,
    sourceReceipt: {
      matchedPhrase: "provider-verified completion requirements are satisfied",
      beforeRestart: {
        id: "200",
        url: "https://github.com/amplifthq/opentag-test/issues/42#issuecomment-200",
        bodyDigest: digest
      },
      afterRestart: {
        id: "200",
        url: "https://github.com/amplifthq/opentag-test/issues/42#issuecomment-200",
        bodyDigest: digest
      },
      countBeforeRestart: 1,
      countAfterRestart: 1
    }
  };
}

describe("GitHub factory live acceptance report", () => {
  it("normalizes one real-source-shaped issue comment into a factory admission event", () => {
    const event = normalizeGitHubFactorySourceEvent({
      id: "100",
      commentBody: "@opentag run Update README.md",
      commentUrl: "https://github.com/amplifthq/opentag-test/issues/42#issuecomment-100",
      apiCommentsUrl: "https://api.github.com/repos/amplifthq/opentag-test/issues/42/comments",
      issueUrl: "https://github.com/amplifthq/opentag-test/issues/42",
      issueNumber: 42,
      owner: "amplifthq",
      repo: "opentag-test",
      actorId: 7,
      actorLogin: "operator",
      authorAssociation: "MEMBER",
      actorWriteAccess: true,
      private: false,
      receivedAt: "2026-07-27T00:00:00.000Z"
    });

    expect(event).toMatchObject({
      id: "evt_github_comment_100",
      source: "github",
      sourceEventId: "100",
      command: { intent: "run", args: { prompt: "Update README.md" } },
      workItem: { externalId: "amplifthq/opentag-test#42" },
      callback: { threadKey: "amplifthq/opentag-test#42" }
    });
  });

  it("derives the public factory proof only from consistent observed evidence", () => {
    const report = buildGitHubFactoryAcceptanceReport(evidence());

    expect(report).toMatchObject({
      schemaVersion: 1,
      case: "github-factory-live",
      factory: {
        workThreadId: "thread_live_42",
        batch: { admittedRunId: "run_live_42", restartReplayMatched: true }
      },
      metrics: {
        beforeProviderEvidence: { metrics: { terminalRunCount: 1, acceptedWorkThreadCount: 0 } },
        afterMerge: { metrics: { terminalRunCount: 1, acceptedWorkThreadCount: 1 } }
      },
      excludedScope: ["dag", "operator_console"]
    });
    expect(Object.values(report.assertions).every((value) => value === true)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("fencingToken");
  });

  it("rejects a required check that is not bound to the pull request head", () => {
    const input = evidence();
    input.requiredCheck.headSha = "stale-head";

    expect(() => buildGitHubFactoryAcceptanceReport(input)).toThrow(/required check is not bound to the PR head/u);
  });

  it("rejects a proof that changed the external planning issue state", () => {
    const input = evidence();
    input.source.issueState = "CLOSED";

    expect(() => buildGitHubFactoryAcceptanceReport(input)).toThrow(/mutated the external planning issue state/u);
  });

  it("rejects accepted metrics that advance before provider-verified completion", () => {
    const input = evidence();
    input.metrics.beforeProviderEvidence = workstreamMetrics(1);

    expect(() => buildGitHubFactoryAcceptanceReport(input)).toThrow(/accepted outcome did not advance 0 -> 1/u);
  });

  it("rejects a restart that changes the durable batch receipt or completion assessment", () => {
    const changedReceipt = evidence();
    changedReceipt.factory.batch.replayedReceipt = {
      ...changedReceipt.factory.batch.replayedReceipt,
      unexpected: true
    };
    expect(() => buildGitHubFactoryAcceptanceReport(changedReceipt)).toThrow(/restart replay changed the durable batch receipt/u);

    const changedAssessment = evidence();
    changedAssessment.completion.afterRestart.currentAssessment = {
      ...changedAssessment.completion.afterRestart.currentAssessment as object,
      id: "assessment_replaced_after_restart"
    };
    expect(() => buildGitHubFactoryAcceptanceReport(changedAssessment)).toThrow(/restart changed the durable satisfied completion assessment/u);
  });

  it("rejects a replaced or duplicated final source receipt after restart", () => {
    const replacedReceipt = evidence();
    replacedReceipt.sourceReceipt.afterRestart = {
      ...replacedReceipt.sourceReceipt.afterRestart,
      id: "201"
    };
    expect(() => buildGitHubFactoryAcceptanceReport(replacedReceipt)).toThrow(/restart changed or replaced the final source-thread receipt/u);

    const duplicateReceipt = evidence();
    duplicateReceipt.sourceReceipt.countAfterRestart = 2;
    expect(() => buildGitHubFactoryAcceptanceReport(duplicateReceipt)).toThrow(/expected exactly one provider-verified source-thread receipt after restart/u);
  });
});
