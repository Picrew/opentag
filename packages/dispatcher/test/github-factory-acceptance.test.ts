import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGitHubFactoryAcceptanceReport,
  normalizeGitHubFactorySourceEvent,
  type GitHubFactoryAcceptanceEvidence
} from "../../../scripts/test/github-factory-acceptance.js";

const digest = `sha256:${"a".repeat(64)}`;

function integrity(value: string): string {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function completion(
  state: string,
  requiredChecks: string,
  merge: string,
  options: {
    assessmentId?: string;
    sequence?: number;
    inputDigest?: string;
    supersedesAssessmentId?: string;
    history?: unknown[];
  } = {}
) {
  const assessment = {
    id: options.assessmentId ?? "assessment_live_42",
    workThreadId: "thread_live_42",
    triggeredByRunId: "run_live_42",
    contractId: "completion:thread_live_42:github-pr",
    contractVersion: 1,
    cycle: 1,
    sequence: options.sequence ?? 3,
    inputDigest: options.inputDigest ?? digest,
    state,
    evidenceBacked: true,
    acceptedAt: state === "satisfied" ? "2026-07-27T00:10:00.000Z" : undefined,
    supersedesAssessmentId: options.supersedesAssessmentId,
    assessedAt: "2026-07-27T00:10:00.000Z",
    assessedBy: "opentag",
    targetBindings: [
      {
        key: "primary_change",
        provider: "github",
        resourceRef: "github:amplifthq/opentag-test:pull_request:7",
        resourceVersion: "abc123"
      }
    ],
    gateResults: [
      { gateId: "required_checks", targetKey: "primary_change", state: requiredChecks, reasonCode: "verification_state" },
      { gateId: "merge", targetKey: "primary_change", state: merge, reasonCode: "external_state" }
    ]
  };
  return {
    completion: state,
    currentAssessment: assessment,
    assessmentHistory: [...(options.history ?? []), assessment]
  };
}

function workstreamMetrics(acceptedWorkThreadCount: number, acceptedGateAdvanceCount: number) {
  return {
    metrics: {
      workstreamId: "workstream_live_42",
      workThreadCount: 1,
      acceptedWorkThreadCount,
      acceptedGateAdvanceCount,
      attributedGateAdvanceCount: acceptedGateAdvanceCount,
      unresolvedGateAdvanceCount: 0,
      runsWithAcceptedProgressCount: 1,
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

function acceptedProgressMetrics(acceptedGateAdvances: number) {
  const segment = {
    completedRuns: 1,
    runsWithAcceptedProgress: 1,
    acceptedGateAdvances
  };
  return {
    metrics: {
      completedRuns: 1,
      runsWithAcceptedProgress: 1,
      acceptedGateAdvances,
      attributedAcceptedGateAdvances: acceptedGateAdvances,
      unresolvedAcceptedGateAdvances: 0,
      byRunner: [{ id: "runner_live", ...segment }],
      byExecutor: [{ id: "phase1-fixture", ...segment }]
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
      beforeProviderEvidence: workstreamMetrics(0, 1),
      afterMerge: workstreamMetrics(1, 5),
      afterRestart: workstreamMetrics(1, 5)
    },
    acceptedProgress: {
      beforeProviderEvidence: acceptedProgressMetrics(1),
      afterMerge: acceptedProgressMetrics(5),
      afterRestart: acceptedProgressMetrics(5)
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

function registryRuntimeArtifact() {
  return {
    expectedVersion: "0.8.0",
    package: "@opentag/cli" as const,
    version: "0.8.0",
    registry: "https://registry.npmjs.org",
    resolved: "https://registry.npmjs.org/@opentag/cli/-/cli-0.8.0.tgz",
    integrity: integrity("cli-0.8.0"),
    sourceNormalizer: {
      package: "@opentag/github" as const,
      version: "0.8.0",
      resolved: "https://registry.npmjs.org/@opentag/github/-/github-0.8.0.tgz",
      integrity: integrity("github-0.8.0")
    },
    eventSchema: {
      package: "@opentag/core" as const,
      version: "0.8.0",
      resolved: "https://registry.npmjs.org/@opentag/core/-/core-0.8.0.tgz",
      integrity: integrity("core-0.8.0")
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
        beforeProviderEvidence: {
          metrics: { terminalRunCount: 1, acceptedWorkThreadCount: 0, acceptedGateAdvanceCount: 1 }
        },
        afterMerge: {
          metrics: { terminalRunCount: 1, acceptedWorkThreadCount: 1, acceptedGateAdvanceCount: 5 }
        }
      },
      acceptedProgress: {
        beforeProviderEvidence: { metrics: { acceptedGateAdvances: 1 } },
        afterMerge: {
          metrics: {
            acceptedGateAdvances: 5,
            attributedAcceptedGateAdvances: 5,
            unresolvedAcceptedGateAdvances: 0,
            byRunner: [{ id: "runner_live", acceptedGateAdvances: 5 }],
            byExecutor: [{ id: "phase1-fixture", acceptedGateAdvances: 5 }]
          }
        }
      },
      excludedScope: ["dag", "operator_console"]
    });
    expect(Object.values(report.assertions).every((value) => value === true)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("fencingToken");
  });

  it("requires registry artifact identity for a registry-installed proof", () => {
    const input = evidence();
    input.runtimeSource = "registry_install";

    expect(() => buildGitHubFactoryAcceptanceReport(input)).toThrow(/registry runtime artifact identity is missing/u);
  });

  it("retains a version- and integrity-bound registry artifact receipt", () => {
    const input = evidence();
    input.runtimeSource = "registry_install";
    input.runtimeArtifact = registryRuntimeArtifact();

    expect(buildGitHubFactoryAcceptanceReport(input)).toMatchObject({
      runtimeSource: "registry_install",
      runtimeArtifact: registryRuntimeArtifact()
    });
  });

  it("rejects stale or incomplete registry artifact identity", () => {
    const stale = evidence();
    stale.runtimeSource = "registry_install";
    stale.runtimeArtifact = {
      ...registryRuntimeArtifact(),
      version: "0.7.0"
    };
    expect(() => buildGitHubFactoryAcceptanceReport(stale)).toThrow(/does not match expected version/u);

    const missingIntegrity = evidence();
    missingIntegrity.runtimeSource = "registry_install";
    missingIntegrity.runtimeArtifact = {
      ...registryRuntimeArtifact(),
      integrity: ""
    };
    expect(() => buildGitHubFactoryAcceptanceReport(missingIntegrity)).toThrow(/CLI integrity is missing/u);

    const staleCore = evidence();
    staleCore.runtimeSource = "registry_install";
    staleCore.runtimeArtifact = {
      ...registryRuntimeArtifact(),
      eventSchema: {
        ...registryRuntimeArtifact().eventSchema,
        version: "0.7.0"
      }
    };
    expect(() => buildGitHubFactoryAcceptanceReport(staleCore)).toThrow(/event schema version/u);

    const untrustedRegistry = evidence();
    untrustedRegistry.runtimeSource = "registry_install";
    untrustedRegistry.runtimeArtifact = {
      ...registryRuntimeArtifact(),
      registry: "https://packages.example.test",
      resolved: "https://packages.example.test/@opentag/cli/-/cli-0.8.0.tgz"
    };
    expect(() => buildGitHubFactoryAcceptanceReport(untrustedRegistry)).toThrow(/trusted npm registry/u);
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
    input.metrics.beforeProviderEvidence = workstreamMetrics(1, 1);

    expect(() => buildGitHubFactoryAcceptanceReport(input)).toThrow(/accepted outcome did not advance 0 -> 1/u);
  });

  it("accepts a semantically identical satisfied reassessment after restart", () => {
    const input = evidence();
    const mergedAssessment = input.completion.afterMerge.currentAssessment as Record<string, unknown>;
    input.completion.afterRestart = completion("satisfied", "passed", "passed", {
      assessmentId: "assessment_live_43",
      sequence: 4,
      inputDigest: `sha256:${"b".repeat(64)}`,
      supersedesAssessmentId: "assessment_live_42",
      history: [mergedAssessment]
    });

    expect(buildGitHubFactoryAcceptanceReport(input).assertions).toMatchObject({
      restartPreservedSatisfiedAssessment: true,
      acceptedProgressAttributedToAttempt: true,
      restartPreservedAcceptedProgress: true
    });
  });

  it("accepts an unbroken multi-hop satisfied reassessment chain", () => {
    const input = evidence();
    const mergedAssessment = input.completion.afterMerge.currentAssessment as Record<string, unknown>;
    const intermediate = completion("satisfied", "passed", "passed", {
      assessmentId: "assessment_live_43",
      sequence: 4,
      inputDigest: `sha256:${"b".repeat(64)}`,
      supersedesAssessmentId: "assessment_live_42",
      history: [mergedAssessment]
    }).currentAssessment as Record<string, unknown>;
    input.completion.afterRestart = completion("satisfied", "passed", "passed", {
      assessmentId: "assessment_live_44",
      sequence: 5,
      inputDigest: `sha256:${"c".repeat(64)}`,
      supersedesAssessmentId: "assessment_live_43",
      history: [mergedAssessment, intermediate]
    });

    expect(buildGitHubFactoryAcceptanceReport(input).assertions.restartPreservedSatisfiedAssessment).toBe(true);
  });

  it("rejects a current assessment that disagrees with the history tail", () => {
    const input = evidence();
    const mergedAssessment = input.completion.afterMerge.currentAssessment as Record<string, unknown>;
    input.completion.afterRestart = completion("satisfied", "passed", "passed", {
      assessmentId: "assessment_live_43",
      sequence: 4,
      inputDigest: `sha256:${"b".repeat(64)}`,
      supersedesAssessmentId: "assessment_live_42",
      history: [mergedAssessment]
    });
    input.completion.afterRestart.currentAssessment = {
      ...input.completion.afterRestart.currentAssessment as object,
      contractId: "completion:different-authority"
    };

    expect(() => buildGitHubFactoryAcceptanceReport(input)).toThrow(/restart changed the durable satisfied completion assessment/u);
  });

  it("rejects broken, non-consecutive, or duplicate reassessment lineage", () => {
    const mergedAssessment = evidence().completion.afterMerge.currentAssessment as Record<string, unknown>;

    const broken = evidence();
    broken.completion.afterRestart = completion("satisfied", "passed", "passed", {
      assessmentId: "assessment_live_44",
      sequence: 5,
      inputDigest: `sha256:${"c".repeat(64)}`,
      supersedesAssessmentId: "assessment_live_43",
      history: [mergedAssessment]
    });
    expect(() => buildGitHubFactoryAcceptanceReport(broken)).toThrow(/restart changed the durable satisfied completion assessment/u);

    const duplicate = evidence();
    duplicate.completion.afterRestart = completion("satisfied", "passed", "passed", {
      assessmentId: "assessment_live_43",
      sequence: 4,
      inputDigest: `sha256:${"b".repeat(64)}`,
      supersedesAssessmentId: "assessment_live_42",
      history: [mergedAssessment, { ...mergedAssessment }]
    });
    expect(() => buildGitHubFactoryAcceptanceReport(duplicate)).toThrow(/restart changed the durable satisfied completion assessment/u);
  });

  it("omits unrelated runner and executor identities from the retained report", () => {
    const input = evidence();
    for (const snapshot of Object.values(input.acceptedProgress)) {
      const snapshotMetrics = snapshot.metrics as Record<string, unknown>;
      snapshotMetrics.byRunner = [
        ...(snapshotMetrics.byRunner as unknown[]),
        { id: "runner_unrelated", completedRuns: 0, runsWithAcceptedProgress: 0, acceptedGateAdvances: 0 }
      ];
      snapshotMetrics.byExecutor = [
        ...(snapshotMetrics.byExecutor as unknown[]),
        { id: "executor_unrelated", completedRuns: 0, runsWithAcceptedProgress: 0, acceptedGateAdvances: 0 }
      ];
    }

    const report = buildGitHubFactoryAcceptanceReport(input);
    expect(JSON.stringify(report.acceptedProgress)).not.toContain("unrelated");
  });

  it("rejects unresolved or misattributed provider-live accepted progress", () => {
    const unresolved = evidence();
    const unresolvedMetrics = unresolved.acceptedProgress.afterMerge.metrics as Record<string, unknown>;
    unresolvedMetrics.unresolvedAcceptedGateAdvances = 1;
    unresolvedMetrics.attributedAcceptedGateAdvances = 4;
    expect(() => buildGitHubFactoryAcceptanceReport(unresolved)).toThrow(/provider-live accepted progress was not fully attributed/u);

    const wrongRunner = evidence();
    const wrongRunnerMetrics = wrongRunner.acceptedProgress.afterMerge.metrics as Record<string, unknown>;
    wrongRunnerMetrics.byRunner = [{
      id: "runner_other",
      completedRuns: 1,
      runsWithAcceptedProgress: 1,
      acceptedGateAdvances: 5
    }];
    expect(() => buildGitHubFactoryAcceptanceReport(wrongRunner)).toThrow(/Attempt runner did not receive accepted progress/u);
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
