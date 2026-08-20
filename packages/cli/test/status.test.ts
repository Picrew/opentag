import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionExplanation } from "@opentag/client";
import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import {
  channelStatusFromConfig,
  formatChannelStatus,
  formatCompletionExplanation,
  formatWorkLoopAttentionStatus,
  formatRunStatus,
  formatStatus,
  formatWorkThreadStatus,
  formatWorkstreamStatus,
  getStatusSummary,
  runStatusCommand,
  runStatusFromConfig,
  statusFromConfig,
  workLoopAttentionStatusFromConfig,
  workLoopAttentionStatusJson,
  workThreadStatusFromConfig,
  workThreadStatusJson,
  workstreamStatusFromConfig,
  workstreamStatusJson,
  type WorkstreamStatusSummary
} from "../src/status.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config() {
  return createSetupConfig({
    language: "en",
    platform: "lark",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    lark: {
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      setupMethod: "scan",
      bindingMethod: "default_project"
    }
  });
}

function githubRelayConfig() {
  const built = createSetupConfig({
    language: "en",
    platform: "github",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    github: {
      token: "ghp_token",
      webhookSecret: "github_webhook_secret",
      owner: "acme",
      repo: "demo",
      webhookPath: "/github/webhooks",
      autoCreatePullRequest: false,
      port: 3050
    }
  });
  built.runtime = {
    mode: "relay",
    relayUrl: "https://relay.example",
    relayProvider: "custom"
  };
  built.daemon.dispatcherUrl = "https://relay.example";
  return built;
}

function gitlabRelayConfig() {
  const built = createSetupConfig({
    language: "en",
    platform: "gitlab",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    gitlab: {
      token: "glpat_token",
      webhookSecret: "gitlab_webhook_secret",
      projectPathWithNamespace: "acme/team/demo",
      baseUrl: "https://gitlab.example.com",
      webhookPath: "/gitlab/webhooks",
      port: 3060
    }
  });
  built.runtime = {
    mode: "relay",
    relayUrl: "https://relay.example",
    relayProvider: "custom"
  };
  built.daemon.dispatcherUrl = "https://relay.example";
  return built;
}

function linearRelayConfig() {
  const built = createSetupConfig({
    language: "en",
    platform: "linear",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    linear: {
      token: "lin_api_token",
      webhookSecret: "linear_webhook_secret",
      webhookPath: "/linear/webhooks",
      port: 3070
    }
  });
  built.runtime = {
    mode: "relay",
    relayUrl: "https://relay.example",
    relayProvider: "custom"
  };
  built.daemon.dispatcherUrl = "https://relay.example";
  return built;
}

function discordWebhookRelayConfig() {
  const built = createSetupConfig({
    language: "en",
    platform: "discord",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    discord: {
      mode: "webhook",
      publicKey: "discord_public_key",
      botToken: "discord_bot_token",
      webhookPath: "/discord/interactions"
    }
  });
  built.runtime = {
    mode: "relay",
    relayUrl: "https://relay.example",
    relayProvider: "custom"
  };
  built.daemon.dispatcherUrl = "https://relay.example";
  return built;
}

function hangingFetch(): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch;
}

const runEvent: OpenTagEvent = {
  id: "evt_status_run",
  source: "github",
  sourceEventId: "comment_status_run",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "label this bug", intent: "fix", args: {} },
  context: [],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

function workstreamStatusFixture(overrides: {
  state?: "healthy" | "attention_required" | "blocked";
  acceptedWorkThreadCount?: number;
  violations?: WorkstreamStatusSummary["evaluation"]["violations"];
  alerts?: WorkstreamStatusSummary["alerts"];
} = {}): WorkstreamStatusSummary {
  const digest = `sha256:${"a".repeat(64)}`;
  const workstreamId = "workstream_cli_1";
  const acceptedWorkThreadCount = overrides.acceptedWorkThreadCount ?? 2;
  return {
    configPath: "/tmp/opentag.json",
    dispatcherUrl: "http://dispatcher.test",
    recipe: {
      id: "recipe_cli_1",
      version: 1,
      name: "Maintenance",
      budgets: {
        maxConcurrentRuns: 2,
        maxAttemptsPerRun: 3,
        maxCostUnits: 20,
        costUnitsPerAttempt: 2,
        allowedLocalities: ["private"]
      },
      createdAt: "2026-07-26T00:00:00.000Z",
      contentDigest: digest
    },
    workstream: {
      id: workstreamId,
      recipeId: "recipe_cli_1",
      recipeVersion: 1,
      name: "July maintenance",
      members: [
        { kind: "work_thread", workThreadId: "thread_1" },
        { kind: "work_thread", workThreadId: "thread_2" }
      ],
      createdAt: "2026-07-26T00:01:00.000Z",
      contentDigest: digest
    },
    metrics: {
      workstreamId,
      workThreadCount: 2,
      acceptedWorkThreadCount,
      acceptedGateAdvanceCount: acceptedWorkThreadCount,
      attributedGateAdvanceCount: acceptedWorkThreadCount,
      unresolvedGateAdvanceCount: 0,
      runsWithAcceptedProgressCount: acceptedWorkThreadCount,
      runCount: 2,
      queuedRunCount: 0,
      activeRunCount: 0,
      needsHumanRunCount: 0,
      terminalRunCount: 2,
      failedRunCount: 0,
      budgetBlockedRunCount: 0,
      exceptionCount: 0,
      totalAttempts: 2,
      attemptsPerRunExceededCount: 0,
      totalCostUnits: 4,
      attemptsByLocality: { local: 0, private: 2, hosted: 0, unknown: 0 }
    },
    evaluation: {
      workstreamId,
      recipeId: "recipe_cli_1",
      recipeVersion: 1,
      status: overrides.state ?? "healthy",
      inputDigest: digest,
      evaluatedAt: "2026-07-26T00:05:00.000Z",
      acceptedWorkThreadCount,
      violations: overrides.violations ?? []
    },
    alerts: overrides.alerts ?? []
  };
}

function completionExplanationFixture(): CompletionExplanation {
  const evaluatedAt = "2026-07-21T10:05:00.000Z";
  const contract = {
    id: "contract-cli-1",
    version: 1,
    workThreadId: "thread-cli-1",
    cycle: 1,
    mode: "governed" as const,
    targetSelectors: [{ key: "primary_change", kind: "change_request" as const, lineage: "current_cycle" as const, cardinality: "exactly_one" as const }],
    resolvedFrom: [{ scope: "work_context_owner_container" as const, ref: "github:acme/demo", version: "1" }],
    gates: [
      { id: "pull_request", kind: "artifact" as const, targetKey: "primary_change", artifactKind: "pull_request" as const, minimum: 1 },
      {
        id: "required_checks",
        kind: "verification" as const,
        targetKey: "primary_change",
        evidenceKind: "source_control.required_checks",
        requiredObservations: ["build"],
        requiredOutcome: "passed" as const,
        minimumAssurance: "verified" as const
      }
    ],
    maxAutomaticRetries: 1,
    onSatisfied: "report_only" as const,
    createdAt: "2026-07-21T10:00:00.000Z"
  };
  const target = {
    key: "primary_change",
    provider: "github",
    resourceRef: "github:acme/demo:pull_request:7",
    resourceVersion: "b".repeat(40),
    artifactId: "artifact-pr-7"
  };
  const assessment = {
    id: "assessment-cli-1",
    workThreadId: contract.workThreadId,
    contractId: contract.id,
    contractVersion: 1,
    cycle: 1,
    sequence: 1,
    inputDigest: `sha256:${"a".repeat(64)}`,
    targetBindings: [target],
    state: "blocked" as const,
    evidenceBacked: false,
    gateResults: [
      {
        gateId: "pull_request",
        targetKey: "primary_change",
        state: "passed" as const,
        evidenceIds: ["artifact-pr-7"],
        reasonCode: "artifact_requirement_satisfied" as const,
        reason: "The pull request artifact exists.",
        evaluatedAt
      },
      {
        gateId: "required_checks",
        targetKey: "primary_change",
        state: "unknown" as const,
        evidenceIds: ["evidence-cli-1"],
        reasonCode: "verification_assurance_insufficient" as const,
        reason: "The check result is reported but not provider-verified.",
        evaluatedAt
      }
    ],
    assessedAt: evaluatedAt,
    assessedBy: "opentag" as const
  };
  return {
    workThreadId: contract.workThreadId,
    execution: "succeeded",
    completion: "blocked",
    evidenceBacked: false,
    contract: { id: contract.id, version: 1, cycle: 1, mode: "governed" },
    currentAssessment: assessment,
    targetBindings: [target],
    missingGateIds: [],
    failedGateIds: [],
    blockedGateIds: ["required_checks"],
    nextAction: {
      summary: "Ask the repository owner to restore verified check evidence.",
      hint: { kind: "request_human_decision", targetId: "escalation-cli-1" },
      causes: [{
        kind: "completion_gate",
        gateId: "required_checks",
        state: "unknown",
        reasonCode: "verification_assurance_insufficient"
      }]
    },
    contractSnapshot: contract,
    assessmentHistory: [assessment],
    evidence: [{
      id: "evidence-cli-1",
      kind: "source_control.required_checks",
      assurance: "reported",
      subject: { provider: "github", resourceRef: target.resourceRef, resourceVersion: target.resourceVersion },
      claim: { predicate: "checks", outcome: "passed", observations: { build: "passed" } },
      observedAt: evaluatedAt,
      receivedAt: evaluatedAt
    }],
    openHumanEscalations: [{
      id: "escalation-cli-1",
      workThreadId: contract.workThreadId,
      class: "verification",
      audience: "repo_owner",
      subjectRef: target.resourceRef,
      state: "open",
      blocking: true,
      summary: "Verified check evidence is unavailable.",
      reason: "Only reported evidence exists for the current head.",
      dedupeKey: "verification:required_checks:primary_change",
      openedAt: evaluatedAt
    }]
  };
}

function governedWorkThreadFixture() {
  return {
    id: "thread-cli-1",
    workItemReference: {
      provider: "github",
      kind: "issue",
      externalId: "acme/demo#1",
      uri: "https://github.com/acme/demo/issues/1"
    },
    primaryAnchor: {
      provider: "github",
      kind: "github_thread",
      externalId: "https://api.github.com/repos/acme/demo/issues/1/comments",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      controlPlane: true,
      canApprove: true
    }
  };
}

function acceptedProgressFixture() {
  const acceptedAt = "2026-07-27T00:02:00.000Z";
  return {
    workThreadId: "thread-cli-1",
    contract: { id: "contract-cli-1", version: 1, cycle: 1 },
    currentAssessmentId: "assessment-cli-1",
    advances: [{
      workThreadId: "thread-cli-1",
      contractId: "contract-cli-1",
      contractVersion: 1,
      cycle: 1,
      assessmentId: "assessment-cli-1",
      assessmentSequence: 1,
      gateId: "pull_request",
      targetKey: "primary_change",
      acceptedState: "passed" as const,
      evidenceIds: [],
      acceptedAt,
      resolution: {
        status: "attributed" as const,
        artifactId: "artifact-cli-1",
        sourceRunId: "run-cli-1"
      }
    }],
    acceptedGateAdvanceCount: 1,
    attributedGateAdvanceCount: 1,
    unresolvedGateAdvanceCount: 0,
    runIdsWithAcceptedProgress: ["run-cli-1"]
  };
}

function workLoopViewFixture() {
  const completion = completionExplanationFixture();
  return {
    workThreadId: completion.workThreadId,
    execution: completion.execution,
    completion: completion.completion,
    evidenceBacked: completion.evidenceBacked,
    contract: completion.contract,
    currentAssessment: completion.currentAssessment,
    targetBindings: completion.targetBindings,
    missingGateIds: completion.missingGateIds,
    failedGateIds: completion.failedGateIds,
    blockedGateIds: completion.blockedGateIds,
    nextAction: completion.nextAction
  };
}

function completionStatusFetch(input: {
  completionResponse: () => Response;
  authorizations?: Array<{ url: string; authorization: string | null }>;
}): typeof fetch {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    input.authorizations?.push({
      url: href,
      authorization: new Headers(init?.headers).get("authorization")
    });
    if (href.endsWith("/v1/runs/run_completion_auth")) {
      return Response.json({
        run: {
          id: "run_completion_auth",
          eventId: runEvent.id,
          status: "succeeded",
          createdAt: "2026-07-21T10:00:00.000Z",
          updatedAt: "2026-07-21T10:05:00.000Z",
          result: { conclusion: "success", summary: "Executor finished." }
        },
        event: runEvent
      });
    }
    if (href.endsWith("/v1/runs/run_completion_auth/events")) return Response.json({ events: [] });
    if (href.endsWith("/v1/runs/run_completion_auth/metrics")) {
      return Response.json({
        metrics: {
          runId: "run_completion_auth",
          totalEventCount: 0,
          humanEventCount: 0,
          auditEventCount: 0,
          debugEventCount: 0,
          suggestedChangesCount: 0,
          approvalDecisionCount: 0,
          applyPlanCount: 0,
          childRunCount: 0,
          applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
          staleIntentCount: 0
        }
      });
    }
    if (href.endsWith("/v1/runs/run_completion_auth/ledger")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (href.endsWith("/v1/runs/run_completion_auth/completion")) return input.completionResponse();
    return Response.json({ error: "unexpected_url" }, { status: 500 });
  }) as unknown as typeof fetch;
}

describe("OpenTag CLI status", () => {
  it("rejects invalid hosted auth before any status fetch", async () => {
    const configured = config();
    configured.runtime = { mode: "relay", relayUrl: "https://relay.example", relayProvider: "custom" };
    configured.daemon.dispatcherUrl = "https://relay.example";
    configured.daemon.controlRegistration = {
      kind: "hosted_control_v1",
      state: "unpaired",
      flow: "registration",
      operationId: "operation-1",
      reason: "pending"
    };
    const fetchImpl = vi.fn();

    await expect(statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toThrow("Hosted Control V1 runner is not paired");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains completion independently from executor success", () => {
    const formatted = formatCompletionExplanation(completionExplanationFixture()).join("\n");

    expect(formatted).toContain("Execution: succeeded");
    expect(formatted).toContain("Completion: blocked");
    expect(formatted).toContain("Contract: contract-cli-1 v1 cycle=1 mode=governed");
    expect(formatted).toContain("required_checks: unknown (verification_assurance_insufficient)");
    expect(formatted).toContain("assurance=reported subject=github:acme/demo:pull_request:7@");
    expect(formatted).toContain("provider=github");
    expect(formatted).toContain("Blocked requirements: required_checks");
    expect(formatted).toContain("escalation-cli-1: verification/open");
    expect(formatted).toContain("Next action: Ask the repository owner to restore verified check evidence.");
  });

  it("uses the runner credential for ordinary reads and the pairing credential for completion governance reads", async () => {
    const configured = config();
    configured.daemon.runnerToken = "runner_mutation_token";
    configured.daemon.pairingToken = "pairing_admin_token";
    const authorizations: Array<{ url: string; authorization: string | null }> = [];

    const summary = await runStatusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      runId: "run_completion_auth",
      fetchImpl: completionStatusFetch({
        completionResponse: () => Response.json({ completion: completionExplanationFixture() }),
        authorizations
      })
    });

    expect(summary.completion?.completion).toBe("blocked");
    expect(authorizations.find((request) => request.url.endsWith("/completion"))?.authorization).toBe("Bearer pairing_admin_token");
    expect(
      authorizations
        .filter((request) => !request.url.endsWith("/completion"))
        .every((request) => request.authorization === "Bearer runner_mutation_token")
    ).toBe(true);
  });

  it("uses only the runtime runner credential for Hosted Control run status reads", async () => {
    const configured = config();
    configured.runtime = {
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    };
    configured.daemon.dispatcherUrl = "https://relay.example";
    configured.daemon.runnerToken = "hosted_runtime_token";
    configured.daemon.pairingToken = "legacy_pairing_token";
    configured.daemon.controlRegistration = {
      kind: "hosted_control_v1",
      state: "paired",
      operationId: "operation-1",
      registration: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        organizationId: "org_1",
        runnerId: configured.daemon.runnerId,
        registrationGeneration: 1,
        credentialGeneration: 1,
        credentialId: "credential-1",
        credentialPurpose: "runtime",
        createdAt: "2026-08-08T00:00:00.000Z"
      }
    };
    const authorizations: Array<{ url: string; authorization: string | null }> = [];

    const summary = await runStatusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      runId: "run_completion_auth",
      fetchImpl: completionStatusFetch({
        completionResponse: () => Response.json({ completion: completionExplanationFixture() }),
        authorizations
      })
    });

    expect(summary.completion?.completion).toBe("blocked");
    expect(authorizations).not.toHaveLength(0);
    expect(authorizations.every((request) => request.authorization === "Bearer hosted_runtime_token")).toBe(true);
  });

  it("keeps ordinary status reads available when only a runner credential is configured", async () => {
    const configured = config();
    configured.daemon.runnerToken = "runner_mutation_token";
    delete configured.daemon.pairingToken;
    const authorizations: Array<{ url: string; authorization: string | null }> = [];

    const summary = await runStatusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      runId: "run_completion_auth",
      fetchImpl: completionStatusFetch({
        completionResponse: () => Response.json({ completion: completionExplanationFixture() }),
        authorizations
      })
    });

    expect(summary.completion).toBeUndefined();
    expect(authorizations).not.toHaveLength(0);
    expect(authorizations.some((request) => request.url.endsWith("/completion"))).toBe(false);
    expect(authorizations.every((request) => request.authorization === "Bearer runner_mutation_token")).toBe(true);
  });

  it("suppresses only an explicit completion_not_available compatibility 404", async () => {
    const summary = await runStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      runId: "run_completion_auth",
      fetchImpl: completionStatusFetch({
        completionResponse: () => Response.json({ error: "completion_not_available" }, { status: 404 })
      })
    });

    expect(summary.completion).toBeUndefined();
  });

  it("surfaces unrelated completion 404 failures", async () => {
    await expect(runStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      runId: "run_completion_auth",
      fetchImpl: completionStatusFetch({
        completionResponse: () => Response.json({ error: "run_not_found" }, { status: 404 })
      })
    })).rejects.toMatchObject({ status: 404 });
  });

  it.each([401, 403, 500])("surfaces completion HTTP %s failures", async (status) => {
    await expect(runStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      runId: "run_completion_auth",
      fetchImpl: completionStatusFetch({
        completionResponse: () => Response.json({ error: "completion_unavailable" }, { status })
      })
    })).rejects.toThrow(`getCompletion failed: ${status}`);
  });

  it("surfaces malformed completion JSON", async () => {
    await expect(runStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      runId: "run_completion_auth",
      fetchImpl: completionStatusFetch({
        completionResponse: () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
      })
    })).rejects.toThrow();
  });

  it("surfaces completion schema failures", async () => {
    const invalidCompletion = completionExplanationFixture() as CompletionExplanation & {
      currentAssessment: { state: string };
    };
    invalidCompletion.currentAssessment = {
      ...invalidCompletion.currentAssessment,
      state: "not_a_completion_state"
    };

    await expect(runStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      runId: "run_completion_auth",
      fetchImpl: completionStatusFetch({
        completionResponse: () => Response.json({ completion: invalidCompletion })
      })
    })).rejects.toThrow();
  });

  it("reports offline dispatcher without failing the config summary", async () => {
    const configured = config();
    const checkoutPath = configured.daemon.repositories[0]?.checkoutPath;
    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      })
    });

    const formatted = formatStatus(summary);
    expect(summary.dispatcher).toBe("offline");
    expect(formatted).toContain("Dispatcher: offline");
    expect(formatted).toContain("Runner Directory:\n  unavailable (dispatcher offline)");
    expect(formatted).toContain("Accepted Progress:\n  unavailable (dispatcher offline)");
    expect(formatted).toContain("Run Timeout: hard timeout after 10 minute(s)");
    expect(formatted).toContain("Secrets:");
    expect(formatted).toContain("daemon.pairingToken: inline (redacted)");
    expect(formatted).toContain("daemon.runnerToken: daemon.pairingToken fallback");
    expect(formatted).toContain("platforms.lark.appSecret: inline (redacted)");
    expect(formatted).not.toContain("secret_test");
    expect(formatted).toContain("Agent Session Profile:");
    expect(formatted).toContain(
      "default template: opentag-{provider}-{accountId}-{conversationId}-{owner}-{repo}-{actorId}"
    );
    expect(formatted).toContain("session identity excludes checkout paths and secrets");
    expect(formatted).toContain("Platforms: lark");
    expect(formatted).toContain("Capabilities:");
    expect(formatted).toContain("platform Lark / Feishu:");
    expect(formatted).toContain("rich=yes");
    expect(formatted).toContain("liveness=source_receipt");
    expect(formatted).toContain("executor Echo:");
    expect(formatted).toContain("isolation=none");
    expect(formatted).toContain("secrets=none");
    expect(formatted).toContain("completion=process_exit");
    expect(formatted).toContain("Project Targets:");
    expect(formatted).toContain("local:path_");
    expect(formatted).toContain("(hasWorkspacePath=yes)");
    expect(checkoutPath).toBeTruthy();
    expect(formatted).not.toContain(checkoutPath);
  });

  it("reports offline when dispatcher health hangs until timeout", async () => {
    const fetchImpl = hangingFetch();

    const summary = await statusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl,
      healthTimeoutMs: 5
    });

    expect(summary.dispatcher).toBe("offline");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("formats configured agent session profile identity rules in the config summary", async () => {
    const configured = config();
    configured.daemon.agentSessionProfile = {
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{projectTarget}-{actorId}"
    };

    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      })
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("Agent Session Profile:");
    expect(formatted).toContain("fixed profile: opentag-fixed");
    expect(formatted).toContain("template ignored while fixed profile is set: opentag-{provider}-{projectTarget}-{actorId}");
    expect(formatted).not.toContain("checkoutPath");
  });

  it("formats secret refs in the config summary without printing resolved values", async () => {
    const configured = config();
    const configPath = join(tempDir(), "config.json");
    const previous = process.env.OPENTAG_TEST_LARK_SECRET;
    process.env.OPENTAG_TEST_LARK_SECRET = "secret_from_env";
    writeFileSync(
      configPath,
      `${JSON.stringify({
        ...configured,
        platforms: {
          ...configured.platforms,
          lark: {
            ...configured.platforms.lark!,
            appSecret: { kind: "env", name: "OPENTAG_TEST_LARK_SECRET" }
          }
        }
      })}\n`,
      { mode: 0o600 }
    );

    try {
      const summary = await getStatusSummary({
        configPath,
        fetchImpl: vi.fn(async () => Response.json({ ok: true }))
      });

      const formatted = formatStatus(summary);
      expect(formatted).toContain("platforms.lark.appSecret: env ref (OPENTAG_TEST_LARK_SECRET)");
      expect(formatted).not.toContain("secret_from_env");
      expect(formatted).not.toContain("secret_test");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENTAG_TEST_LARK_SECRET;
      } else {
        process.env.OPENTAG_TEST_LARK_SECRET = previous;
      }
    }
  });

  it("formats relay security checks in the config summary", async () => {
    const summary = await statusFromConfig({
      config: githubRelayConfig(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("Runtime: relay");
    expect(formatted).toContain("Relay: https://relay.example");
    expect(formatted).toContain("Relay Security:");
    expect(formatted).toContain("OK relay transport: HTTPS is enabled.");
    expect(formatted).toContain("OK GitHub webhook secret: Configured locally; the relay /github/webhooks endpoint must verify this secret before creating runs.");
    expect(formatted).toContain("WARN relay token scope: This self-hosted MVP still uses the daemon pairing token for registration and runner calls");
    expect(formatted).toContain("WARN runner security policy: No explicit daemon.security policy is configured");
  });

  it("formats GitLab relay security as supported when a GitLab webhook secret is configured", async () => {
    const summary = await statusFromConfig({
      config: gitlabRelayConfig(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("Runtime: relay");
    expect(formatted).toContain("OK GitLab webhook secret: Configured locally; the relay /gitlab/webhooks endpoint must verify X-Gitlab-Token before creating runs.");
    expect(formatted).not.toContain("GitLab relay mode is not supported");
  });

  it("reports Microsoft Teams relay ingress as unsupported", async () => {
    const relayConfig = githubRelayConfig();
    relayConfig.platforms.teams = {
      appId: "teams_app_id",
      appPassword: "teams_app_password",
      webhookPath: "/teams/messages"
    };
    const summary = await statusFromConfig({
      config: relayConfig,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("FAIL relay platform support: Microsoft Teams relay mode is not supported in this MVP; use local mode for those ingress paths.");
    expect(formatted).not.toContain("OK Microsoft Teams Bot Framework JWT");
  });

  it("formats Linear relay security as supported when a Linear webhook secret is configured", async () => {
    const summary = await statusFromConfig({
      config: linearRelayConfig(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("Runtime: relay");
    expect(formatted).toContain(
      "OK Linear webhook secret: Configured locally; the relay /linear/webhooks endpoint must verify Linear-Signature and webhook timestamp before creating runs."
    );
    expect(formatted).not.toContain("Linear relay mode is not supported");
  });

  it("formats Discord relay signature requirements for webhook mode", async () => {
    const summary = await statusFromConfig({
      config: discordWebhookRelayConfig(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("Runtime: relay");
    expect(formatted).toContain("OK Discord interaction signature: Configured locally; the relay /discord/interactions endpoint must verify the Ed25519 signature before creating runs.");
  });

  it("formats relay token scope as split when runnerToken is configured", async () => {
    const configured = githubRelayConfig();
    configured.daemon.runnerToken = "runner_token";
    configured.daemon.runnerTokens = ["runner_old"];
    configured.daemon.revokedRunnerTokenFingerprints = ["abc123"];
    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("OK relay token scope: Runner calls use daemon.runnerToken instead of the pairing token");
    expect(formatted).toContain("OK runner token rotation: 1 additional runner token(s) configured for the rotation window.");
    expect(formatted).toContain("OK runner token revocation: 1 revoked runner token fingerprint(s) configured");
    expect(formatted).not.toContain("still uses the daemon pairing token for registration and runner calls");
  });


  it("formats configured run timeout policy in the config summary", async () => {
    const configured = config();
    configured.daemon.runTimeoutMs = 30_000;

    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    expect(formatStatus(summary)).toContain("Run Timeout: hard timeout after 30 second(s)");
  });

  it("formats control-plane alert candidates in the config summary", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const configured = config();
    configured.daemon.runnerToken = "runner_token";
    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        requests.push({ url: href, init });
        if (href.endsWith("/healthz")) return Response.json({ ok: true });
        if (href.endsWith("/v1/control-plane-alerts?limit=5")) {
          return Response.json({
            alerts: [
              {
                id: "abnormal_runner_claim_rate:run.claimed:runner_local",
                type: "abnormal_runner_claim_rate",
                severity: "warn",
                eventType: "run.claimed",
                count: 10,
                threshold: 10,
                firstSeenAt: "2026-06-24T00:00:00.000Z",
                lastSeenAt: "2026-06-24T00:01:00.000Z",
                subject: "runner_local",
                reason: "Runner claim volume exceeded the local alert threshold.",
                nextAction: "Check for runaway runner loops."
              },
              {
                id: "token_misuse:security.token_misuse:slack:app_token",
                type: "token_misuse",
                severity: "warn",
                eventType: "security.token_misuse",
                count: 1,
                threshold: 1,
                firstSeenAt: "2026-06-24T00:02:00.000Z",
                lastSeenAt: "2026-06-24T00:02:00.000Z",
                subject: "slack:app_token",
                reason: "A platform or relay token failed with a terminal authentication or configuration error.",
                nextAction: "Rotate or replace the affected token, then restart or re-pair the ingress or runner that owns it."
              }
            ]
          });
        }
        if (href.endsWith("/v1/runners")) {
          return Response.json({
            runners: [{
              runnerId: "runner_local",
              name: "Local runner",
              locality: "local",
              declaredState: "ready",
              executors: [{ executorId: "codex", readiness: "unknown" }],
              maxConcurrentRuns: 2,
              preference: 0,
              readiness: { state: "ready", reasonCode: "runner_heartbeat_current", reason: "Runner heartbeat is current." },
              capacity: { active: 1, limit: 2 },
              createdAt: "2026-07-25T00:00:00.000Z",
              heartbeatAt: "2026-07-25T00:00:01.000Z"
            }]
          });
        }
        if (href.endsWith("/v1/routing/accepted-progress-metrics")) {
          return Response.json({
            metrics: {
              completedRuns: 2,
              runsWithAcceptedProgress: 1,
              acceptedGateAdvances: 2,
              attributedAcceptedGateAdvances: 1,
              unresolvedAcceptedGateAdvances: 1,
              byRunner: [{ id: "runner_local", completedRuns: 2, runsWithAcceptedProgress: 1, acceptedGateAdvances: 1 }],
              byExecutor: [{ id: "codex", completedRuns: 2, runsWithAcceptedProgress: 1, acceptedGateAdvances: 1 }]
            }
          });
        }
        return Response.json({ error: "unexpected_url" }, { status: 500 });
      }) as unknown as typeof fetch
    });

    const formatted = formatStatus(summary);
    expect(requests.map((request) => request.url)).toEqual([
      "http://localhost:3030/healthz",
      "http://localhost:3030/v1/control-plane-alerts?limit=5",
      "http://localhost:3030/v1/runners",
      "http://localhost:3030/v1/routing/accepted-progress-metrics"
    ]);
    expect(requests[1]?.init?.headers).toMatchObject({ authorization: "Bearer runner_token" });
    expect(requests[2]?.init?.headers).toMatchObject({ authorization: "Bearer runner_token" });
    expect(requests[3]?.init?.headers).toMatchObject({ authorization: "Bearer runner_token" });
    expect(formatted).toContain("Control Plane Alerts:");
    expect(formatted).toContain("WARN abnormal_runner_claim_rate: runner_local count=10 threshold=10 last=2026-06-24T00:01:00.000Z");
    expect(formatted).toContain("Runner claim volume exceeded the local alert threshold.");
    expect(formatted).toContain("Next: Check for runaway runner loops.");
    expect(formatted).toContain("WARN token_misuse: slack:app_token count=1 threshold=1 last=2026-06-24T00:02:00.000Z");
    expect(formatted).toContain("A platform or relay token failed with a terminal authentication or configuration error.");
    expect(formatted).toContain("Next: Rotate or replace the affected token, then restart or re-pair the ingress or runner that owns it.");
    expect(formatted).toContain("Runner Directory:");
    expect(formatted).toContain("runner_local: ready; locality=local; capacity=1/2; executors=codex");
    expect(formatted).toContain("Accepted Progress:");
    expect(formatted).toContain("gate advances=2 (1 attributed, 1 unresolved)");
    expect(formatted).toContain("total: runs=1; gate advances=2");
    expect(formatted).toContain("runner_local: runs=1; gate advances=1; completed runs=2");
    expect(formatted).toContain("codex: runs=1; gate advances=1; completed runs=2");
    expect(formatted).not.toContain("xapp-");
  });

  it("formats one run audit summary from dispatcher status endpoints", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      requests.push(href);
      if (href.endsWith("/v1/runs/run_status_1")) {
        return Response.json({
          run: {
            id: "run_status_1",
            eventId: "evt_status_run",
            status: "succeeded",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:01:00.000Z",
            result: {
              conclusion: "success",
              summary: "Done.",
              changedFiles: ["README.md"],
              artifacts: [
                { kind: "patch", title: "Generated patch", uri: "opentag/run_status_1" },
                { kind: "report", title: "Run report", uri: "opentag://run/run_status_1/report" },
                { kind: "log_summary", title: "Log summary", uri: "opentag://run/run_status_1/log-summary" }
              ],
              verification: [{ command: "corepack pnpm test", outcome: "passed" }]
            }
          },
          event: runEvent
        });
      }
      if (href.endsWith("/v1/runs/run_status_1/events")) {
        return Response.json({
          events: [
            {
              type: "run.created",
              visibility: "audit",
              importance: "normal",
              message: "Queued run.",
              createdAt: "2026-06-24T00:00:00.000Z"
            },
            {
              type: "delivery.intent.queued",
              visibility: "audit",
              importance: "normal",
              message: "Delivery intent queued for the provider side-effect kernel.",
              payload: { presentationKind: "final", deliveryOutcome: "queued", sideEffectIntentId: "intent_status_1" },
              createdAt: "2026-06-24T00:01:00.000Z"
            },
            {
              type: "delivery.activation_blocked",
              visibility: "audit",
              importance: "blocking",
              message: "Delivery activation is blocked; no provider I/O was attempted.",
              payload: { presentationKind: "final", deliveryOutcome: "activation_blocked" },
              createdAt: "2026-06-24T00:01:01.000Z"
            }
          ]
        });
      }
      if (href.endsWith("/v1/runs/run_status_1/metrics")) {
        return Response.json({
          metrics: {
            runId: "run_status_1",
            totalEventCount: 3,
            humanEventCount: 0,
            auditEventCount: 3,
            debugEventCount: 0,
            suggestedChangesCount: 1,
            approvalDecisionCount: 0,
            applyPlanCount: 0,
            childRunCount: 0,
            applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
            staleIntentCount: 0
          }
        });
      }
      if (href.endsWith("/v1/runs/run_status_1/ledger")) {
        return Response.json({
          ledger: {
            runId: "run_status_1",
            entries: [
              {
                type: "source_event.received",
                category: "source_event",
                visibility: "audit",
                importance: "normal",
                message: "github source event comment_status_run received.",
                createdAt: "2026-06-24T00:00:00.000Z"
              },
              {
                type: "context_packet.generated",
                category: "context_packet",
                visibility: "audit",
                importance: "normal",
                message: "label this bug",
                createdAt: "2026-06-24T00:00:00.000Z"
              },
              {
                type: "executor.capability.snapshot",
                category: "executor_capability",
                visibility: "audit",
                importance: "normal",
                message: "Captured executor capability.",
                createdAt: "2026-06-24T00:00:10.000Z"
              },
              {
                type: "artifact.created",
                category: "artifact",
                visibility: "audit",
                importance: "normal",
                message: "Stored run artifacts.",
                createdAt: "2026-06-24T00:00:50.000Z"
              },
              {
                type: "delivery.intent.queued",
                category: "delivery",
                visibility: "audit",
                importance: "normal",
                message: "Delivery intent queued for the provider side-effect kernel.",
                createdAt: "2026-06-24T00:01:00.000Z"
              },
              {
                type: "delivery.activation_blocked",
                category: "delivery",
                visibility: "audit",
                importance: "blocking",
                message: "Delivery activation is blocked; no provider I/O was attempted.",
                createdAt: "2026-06-24T00:01:01.000Z"
              }
            ]
          }
        });
      }
      if (href.endsWith("/v1/runs/run_status_1/completion")) {
        return Response.json({ error: "completion_not_available" }, { status: 404 });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const summary = await runStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      runId: "run_status_1",
      fetchImpl
    });

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/v1/runs/run_status_1"),
        expect.stringContaining("/v1/runs/run_status_1/events"),
        expect.stringContaining("/v1/runs/run_status_1/metrics"),
        expect.stringContaining("/v1/runs/run_status_1/ledger")
      ])
    );
    expect(formatRunStatus(summary)).toContain("Run: run_status_1");
    expect(formatRunStatus(summary)).toContain("Status: succeeded (success)");
    expect(formatRunStatus(summary)).toContain("Result:");
    expect(formatRunStatus(summary)).toContain("summary: Done.");
    expect(formatRunStatus(summary)).toContain("changed files: README.md");
    expect(formatRunStatus(summary)).toContain("artifacts:");
    expect(formatRunStatus(summary)).toContain("- patch: Generated patch: opentag/run_status_1");
    expect(formatRunStatus(summary)).toContain("- report: Run report: opentag://run/run_status_1/report");
    expect(formatRunStatus(summary)).toContain("- log_summary: Log summary: opentag://run/run_status_1/log-summary");
    expect(formatRunStatus(summary)).toContain("- corepack pnpm test: passed");
    expect(formatRunStatus(summary)).toContain("Metrics: 3 events, 1 suggested action(s), 0 apply plan(s), 0 stale intent(s)");
    expect(formatRunStatus(summary)).toContain("Agent Work Ledger:");
    expect(formatRunStatus(summary)).toContain(
      "entries: 6 (source_event=1, context_packet=1, executor_capability=1, artifact=1, delivery=2)"
    );
    expect(formatRunStatus(summary)).toContain("source_event: source_event.received - github source event comment_status_run received.");
    expect(formatRunStatus(summary)).toContain("executor_capability: executor.capability.snapshot - Captured executor capability.");
    expect(formatRunStatus(summary)).toContain("artifact: artifact.created - Stored run artifacts.");
    expect(formatRunStatus(summary)).toContain("delivery: delivery.intent.queued - Delivery intent queued for the provider side-effect kernel.");
    expect(formatRunStatus(summary)).toContain("delivery: delivery.activation_blocked - Delivery activation is blocked; no provider I/O was attempted.");
    expect(formatRunStatus(summary)).toContain("Liveness:");
    expect(formatRunStatus(summary)).toContain("Provider: github (status_update)");
    expect(formatRunStatus(summary)).toContain("Progress delivery: source thread can receive concise status/progress updates.");
    expect(formatRunStatus(summary)).toContain("Delivery:");
    expect(formatRunStatus(summary)).toContain("intents queued: 1");
    expect(formatRunStatus(summary)).toContain("activation blocked: 1");
    expect(formatRunStatus(summary)).toContain("Provider outcomes: unavailable in the run event read model.");
    expect(formatRunStatus(summary)).not.toMatch(/\bdelivered\b/i);
  });

  it("reports queued and activation-blocked unified delivery without claiming provider success", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/v1/runs/run_delivery_blocked")) {
        return Response.json({
          run: {
            id: "run_delivery_blocked",
            eventId: "evt_status_run",
            status: "succeeded",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:01:00.000Z",
            result: { conclusion: "success", summary: "Done locally." }
          },
          event: runEvent
        });
      }
      if (href.endsWith("/v1/runs/run_delivery_blocked/events")) {
        return Response.json({
          events: [
            {
              type: "delivery.intent.queued",
              visibility: "audit",
              importance: "normal",
              message: "Final delivery intent queued.",
              payload: {
                presentationKind: "final",
                deliveryOutcome: "queued"
              },
              createdAt: "2026-06-24T00:01:00.000Z"
            },
            {
              type: "delivery.activation_blocked",
              visibility: "audit",
              importance: "blocking",
              message: "Delivery activation is blocked.",
              payload: {
                presentationKind: "final",
                deliveryOutcome: "activation_blocked"
              },
              createdAt: "2026-06-24T00:01:01.000Z"
            }
          ]
        });
      }
      if (href.endsWith("/v1/runs/run_delivery_blocked/metrics")) {
        return Response.json({
          metrics: {
            runId: "run_delivery_blocked",
            totalEventCount: 2,
            humanEventCount: 0,
            auditEventCount: 2,
            debugEventCount: 0,
            suggestedChangesCount: 0,
            approvalDecisionCount: 0,
            applyPlanCount: 0,
            childRunCount: 0,
            applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
            staleIntentCount: 0
          }
        });
      }
      if (href.endsWith("/v1/runs/run_delivery_blocked/completion")) {
        return Response.json({ error: "completion_not_available" }, { status: 404 });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const summary = await runStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      runId: "run_delivery_blocked",
      fetchImpl
    });

    const formatted = formatRunStatus(summary);
    expect(formatted).toContain("Delivery:");
    expect(formatted).toContain("intents queued: 1");
    expect(formatted).toContain("activation blocked: 1");
    expect(formatted).toContain("Provider outcomes: unavailable in the run event read model.");
    expect(formatted).toContain("Attention: delivery activation was blocked; no provider I/O was attempted.");
    expect(formatted).not.toMatch(/\bdelivered\b/i);
  });

  it("formats human stop semantics for cancelled runs", () => {
    const formatted = formatRunStatus({
      configPath: "/tmp/opentag/config.json",
      dispatcherUrl: "http://localhost:3030",
      run: {
        id: "run_cancelled_by_user",
        eventId: "evt_status_run",
        status: "cancelled",
        createdAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:01:00.000Z",
        result: { conclusion: "cancelled", summary: "Stop requested from Lark." }
      },
      event: runEvent,
      metrics: {
        runId: "run_cancelled_by_user",
        totalEventCount: 1,
        humanEventCount: 0,
        auditEventCount: 1,
        debugEventCount: 0,
        suggestedChangesCount: 0,
        approvalDecisionCount: 0,
        applyPlanCount: 0,
        childRunCount: 0,
        applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
        staleIntentCount: 0
      },
      events: [
        {
          type: "run.cancel_requested",
          visibility: "audit",
          importance: "high",
          message: "Stop requested from Lark.",
          createdAt: "2026-06-24T00:01:00.000Z",
          payload: {
            terminalReason: "cancelled_by_user",
            terminalSemantics: "A human stop request is not a successful completion and does not auto-promote queued follow-ups."
          }
        }
      ]
    });

    expect(formatted).toContain("Status: cancelled (cancelled)");
    expect(formatted).toContain("Terminal reason: cancelled_by_user");
    expect(formatted).toContain(
      "Terminal semantics: A human stop request is not a successful completion and does not auto-promote queued follow-ups."
    );
  });

  it("formats run-specific timeout policy from running audit events", () => {
    const formatted = formatRunStatus({
      configPath: "/tmp/opentag/config.json",
      dispatcherUrl: "http://localhost:3030",
      run: {
        id: "run_timeout_visible",
        eventId: "evt_status_run",
        status: "running",
        createdAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:01:00.000Z"
      },
      event: runEvent,
      metrics: {
        runId: "run_timeout_visible",
        totalEventCount: 1,
        humanEventCount: 0,
        auditEventCount: 1,
        debugEventCount: 0,
        suggestedChangesCount: 0,
        approvalDecisionCount: 0,
        applyPlanCount: 0,
        childRunCount: 0,
        applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
        staleIntentCount: 0
      },
      runTimeoutPolicy: "hard timeout after 30 second(s)",
      events: [
        {
          type: "run.running",
          visibility: "audit",
          importance: "normal",
          createdAt: "2026-06-24T00:00:30.000Z",
          payload: {
            executor: "echo",
            runTimeoutMs: 45_000
          }
        }
      ]
    });

    expect(formatted).toContain("Run Timeout: hard timeout after 45 second(s)");
    expect(formatted).not.toContain("Run Timeout: hard timeout after 30 second(s)");
  });

  it("formats run provenance from creation audit payloads", () => {
    const formatted = formatRunStatus({
      configPath: "/tmp/opentag/config.json",
      dispatcherUrl: "https://relay.example",
      run: {
        id: "run_provenance_visible",
        eventId: "evt_status_run",
        status: "succeeded",
        createdAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:01:00.000Z",
        result: { conclusion: "success", summary: "Done." }
      },
      event: {
        ...runEvent,
        metadata: {
          ...runEvent.metadata,
          sourceDeliveryId: "delivery_from_event",
          signatureState: "unverified"
        }
      },
      metrics: {
        runId: "run_provenance_visible",
        totalEventCount: 3,
        humanEventCount: 0,
        auditEventCount: 3,
        debugEventCount: 0,
        suggestedChangesCount: 0,
        approvalDecisionCount: 0,
        applyPlanCount: 0,
        childRunCount: 0,
        applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
        staleIntentCount: 0
      },
      events: [
        {
          type: "run.created",
          visibility: "audit",
          importance: "low",
          createdAt: "2026-06-24T00:00:00.000Z",
          payload: {
            eventId: "evt_status_run",
            provenance: {
              source: "github",
              sourceEventId: "comment_status_run",
              sourceDeliveryId: "delivery_123",
              signatureState: "verified",
              projectTarget: { ref: "github:acme/demo", provider: "github", owner: "acme", repo: "demo" },
              admissionDecision: {
                action: "start",
                reasonCode: "new_event",
                eventId: "evt_status_run"
              },
              expectedRunnerId: "runner_1"
            }
          }
        },
        {
          type: "routing.decided",
          visibility: "audit",
          importance: "normal",
          createdAt: "2026-06-24T00:00:05.000Z",
          payload: {
            id: "routing_status_1",
            runId: "run_provenance_visible",
            candidates: [
              {
                runnerId: "runner_1",
                executorId: "codex",
                eligible: true,
                reasons: [{ code: "executor_ready", message: "Runner reported this executor ready." }],
                locality: "local",
                readiness: "ready",
                capacity: { active: 0, limit: 1 }
              },
              {
                runnerId: "runner_2",
                executorId: "codex",
                eligible: false,
                reasons: [{ code: "runner_at_capacity", message: "Runner has no free concurrency slot." }],
                locality: "private",
                readiness: "at_capacity",
                capacity: { active: 1, limit: 1 }
              }
            ],
            selected: { runnerId: "runner_1", executorId: "codex" },
            reasonCode: "preferred_eligible_candidate",
            reason: "Selected the first eligible target in the configured stable preference order.",
            decidedAt: "2026-06-24T00:00:05.000Z"
          }
        },
        {
          type: "run.claimed",
          visibility: "audit",
          importance: "normal",
          createdAt: "2026-06-24T00:00:10.000Z",
          payload: {
            runnerId: "runner_1"
          }
        }
      ]
    });

    expect(formatted).toContain("Provenance:");
    expect(formatted).toContain("Source delivery: delivery_123");
    expect(formatted).toContain("Signature: verified");
    expect(formatted).toContain("Project Target: github:acme/demo");
    expect(formatted).toContain("Admission: start (new_event); event=evt_status_run");
    expect(formatted).toContain("Expected runner: runner_1");
    expect(formatted).toContain("Claimed runner: runner_1");
    expect(formatted).toContain("Routing:");
    expect(formatted).toContain("Selected: runner_1/codex");
    expect(formatted).toContain("eligible runner_1/codex; capacity=0/1: executor_ready");
    expect(formatted).toContain("rejected runner_2/codex; capacity=1/1: runner_at_capacity");
    expect(formatted).not.toContain("delivery_from_event");
    expect(formatted).not.toContain("checkoutPath");
    expect(formatted).not.toContain("localPath");
  });

  it("formats configured liveness strategy without legacy callback counters", async () => {
    const larkEvent: OpenTagEvent = {
      ...runEvent,
      id: "evt_lark_status_run",
      source: "lark",
      sourceEventId: "msg_lark_status_run",
      actor: { provider: "lark", providerUserId: "ou_sender", handle: "ming", organizationId: "tenant_1" },
      context: [{ provider: "lark", kind: "message", uri: "lark://tenant/tenant_1/chat/oc_chat/message/om_msg", visibility: "organization" }],
      callback: {
        provider: "lark",
        uri: "lark://im/v1/messages",
        threadKey: "tenant_1|oc_chat|om_msg"
      },
      metadata: { tenantKey: "tenant_1", chatId: "oc_chat", repoProvider: "github", owner: "acme", repo: "demo" }
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/v1/runs/run_lark_quiet")) {
        return Response.json({
          run: {
            id: "run_lark_quiet",
            eventId: "evt_lark_status_run",
            status: "running",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:01:00.000Z"
          },
          event: larkEvent
        });
      }
      if (href.endsWith("/v1/runs/run_lark_quiet/events")) {
        return Response.json({
          events: [
            {
              type: "run.progress",
              visibility: "human",
              importance: "normal",
              message: "External runtime requested a human-visible progress update.",
              createdAt: "2026-06-24T00:00:30.000Z"
            }
          ]
        });
      }
      if (href.endsWith("/v1/runs/run_lark_quiet/metrics")) {
        return Response.json({
          metrics: {
            runId: "run_lark_quiet",
            totalEventCount: 1,
            humanEventCount: 1,
            auditEventCount: 0,
            debugEventCount: 0,
            suggestedChangesCount: 0,
            approvalDecisionCount: 0,
            applyPlanCount: 0,
            childRunCount: 0,
            applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
            staleIntentCount: 0
          }
        });
      }
      if (href.endsWith("/v1/runs/run_lark_quiet/completion")) {
        return Response.json({ error: "completion_not_available" }, { status: 404 });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const summary = await runStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      runId: "run_lark_quiet",
      fetchImpl
    });

    const formatted = formatRunStatus(summary);
    expect(formatted).toContain("Provider: lark (source_receipt)");
    expect(formatted).toContain("Progress delivery: source thread uses native receipts first; routine progress stays in audit/status.");
    expect(formatted).not.toContain("Human callbacks:");
    expect(formatted).not.toContain("thread noise ratio:");
  });

  it("formats one source container runtime summary from dispatcher status endpoints", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      requests.push(href);
      return Response.json({
        binding: {
          provider: "lark",
          accountId: "tenant_1",
          conversationId: "oc_chat",
          repoProvider: "github",
          owner: "acme",
          repo: "demo"
        },
        activeRun: {
          id: "run_active",
          eventId: "evt_status_run",
          status: "running",
          createdAt: "2026-06-24T00:00:00.000Z",
          updatedAt: "2026-06-24T00:02:00.000Z"
        },
        activeEvent: runEvent,
        runTimeoutPolicy: { hardTimeoutMs: 45_000 },
        queuedFollowUps: [
          {
            id: "follow_up_1",
            sourceEventId: "evt_follow_up",
            conversationKey: "lark:tenant_1|oc_chat|om_thread",
            activeRunId: "run_active",
            event: runEvent,
            decision: {
              action: "queue_follow_up",
              reason: "A run is already active for this thread.",
              reasonCode: "active_run_same_thread",
              decidedAt: "2026-06-24T00:02:10.000Z",
              activeRunId: "run_active",
              eventId: "evt_follow_up"
            },
            status: "queued",
            createdAt: "2026-06-24T00:02:10.000Z",
            updatedAt: "2026-06-24T00:02:10.000Z"
          }
        ]
      });
    }) as unknown as typeof fetch;

    const configured = config();
    configured.daemon.runTimeoutMs = 30_000;
    const summary = await channelStatusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      channel: "lark:tenant_1/oc_chat",
      fetchImpl
    });

    expect(requests).toEqual(["http://localhost:3030/v1/channel-bindings/lark/tenant_1/oc_chat/status"]);
    expect(formatChannelStatus(summary)).toContain("Source container: lark:tenant_1/oc_chat");
    expect(formatChannelStatus(summary)).toContain("Project Target: github:acme/demo");
    expect(formatChannelStatus(summary)).toContain("Active run: run_active (running), updated 2026-06-24T00:02:00.000Z");
    expect(formatChannelStatus(summary)).toContain("Command: label this bug");
    expect(formatChannelStatus(summary)).toContain("Queued follow-ups: 1 (follow_up_1 (queued): label this bug)");
    expect(formatChannelStatus(summary)).toContain("opentag cancel --run run_active");
    expect(formatChannelStatus(summary)).toContain("Stop/timeout: cancellation is explicit and is not reported as successful completion; timeout policy: hard timeout after 45 second(s).");
  });

  it("keeps healthy workstream output quiet and orders state before budget detail", () => {
    const formatted = formatWorkstreamStatus(workstreamStatusFixture());

    expect(formatted.split("\n").slice(0, 3)).toEqual([
      "Workstream: workstream_cli_1 (July maintenance)",
      "State: healthy",
      "Next action: No action required; continue monitoring accepted outcomes."
    ]);
    expect(formatted).toContain("Completion Authority:\n  accepted work threads: 2/2");
    expect(formatted).toContain("Accepted Progress:\n  gate advances: 2 (2 attributed, 0 unresolved)\n  contributing runs: 2\nBudget:");
    expect(formatted).toContain("cost units: 4/20; per attempt=2");
    expect(formatted).not.toContain("Exceptions:");
  });

  it("shows a bounded exception summary for blocked workstreams", () => {
    const violations = Array.from({ length: 6 }, (_, index) => ({
      code: "budget_blocked_runs" as const,
      message: `Blocked run ${index + 1}`,
      actual: index + 1,
      limit: 0
    }));
    const formatted = formatWorkstreamStatus(workstreamStatusFixture({ state: "blocked", violations }));

    expect(formatted).toContain("State: blocked");
    expect(formatted).toContain("Next action: Resolve the blocking budget violations");
    expect(formatted).toContain("Blocked run 5");
    expect(formatted).not.toContain("Blocked run 6");
    expect(formatted).toContain("1 more violation(s) omitted");
  });

  it("calls the workstream status endpoints and returns structured JSON data", async () => {
    const fixture = workstreamStatusFixture();
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      requests.push(href);
      if (href.endsWith("/v1/workstreams/workstream_cli_1")) return Response.json({ workstream: fixture.workstream });
      if (href.endsWith("/v1/factory-recipes/recipe_cli_1/versions/1")) return Response.json({ recipe: fixture.recipe });
      if (href.endsWith("/v1/workstreams/workstream_cli_1/metrics")) return Response.json({ metrics: fixture.metrics });
      if (href.endsWith("/v1/workstreams/workstream_cli_1/evaluation")) return Response.json({ evaluation: fixture.evaluation });
      if (href.endsWith("/v1/control-plane-alerts?limit=100")) {
        return Response.json({
          alerts: [{
            id: "alert_other",
            type: "workstream_budget",
            severity: "warn",
            eventType: "factory.workstream.budget_blocked",
            count: 1,
            threshold: 1,
            firstSeenAt: "2026-07-26T00:04:00.000Z",
            lastSeenAt: "2026-07-26T00:04:00.000Z",
            subject: "another_workstream",
            reason: "Another workstream needs attention.",
            nextAction: "Inspect it."
          }, ...Array.from({ length: 6 }, (_, index) => ({
            id: `alert_${index + 1}`,
            type: "workstream_budget",
            severity: "warn" as const,
            eventType: "factory.workstream.budget_blocked",
            count: 1,
            threshold: 1,
            firstSeenAt: "2026-07-26T00:04:00.000Z",
            lastSeenAt: "2026-07-26T00:04:00.000Z",
            subject: "workstream_cli_1",
            reason: `Workstream alert ${index + 1}.`,
            nextAction: "Inspect it."
          }))]
        });
      }
      return Response.json({ error: "unexpected_url", href }, { status: 500 });
    }) as unknown as typeof fetch;

    const summary = await workstreamStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      workstreamId: fixture.workstream.id,
      fetchImpl
    });

    expect(requests).toHaveLength(5);
    expect(summary.alerts).toHaveLength(6);
    expect(formatWorkstreamStatus(summary)).toContain("alert: 1 more alert(s) omitted");
    expect(workstreamStatusJson(summary)).toMatchObject({
      state: "healthy",
      workstream: { id: "workstream_cli_1" },
      metrics: { acceptedWorkThreadCount: 2 },
      evaluation: { status: "healthy" }
    });
  });

  it("prints structured workstream status in command JSON mode", async () => {
    const fixture = workstreamStatusFixture();
    const configPath = join(tempDir(), "config.json");
    writeFileSync(configPath, JSON.stringify(config()), { mode: 0o600 });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/v1/workstreams/workstream_cli_1")) return Response.json({ workstream: fixture.workstream });
      if (href.endsWith("/v1/factory-recipes/recipe_cli_1/versions/1")) return Response.json({ recipe: fixture.recipe });
      if (href.endsWith("/v1/workstreams/workstream_cli_1/metrics")) return Response.json({ metrics: fixture.metrics });
      if (href.endsWith("/v1/workstreams/workstream_cli_1/evaluation")) return Response.json({ evaluation: fixture.evaluation });
      if (href.endsWith("/v1/control-plane-alerts?limit=100")) return Response.json({ alerts: [] });
      return Response.json({ error: "unexpected_url", href }, { status: 500 });
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchImpl);

    try {
      await runStatusCommand({ config: configPath, workstream: fixture.workstream.id, json: true });
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        state: "healthy",
        workstream: { id: "workstream_cli_1" },
        metrics: { acceptedWorkThreadCount: 2 },
        evaluation: { status: "healthy" }
      });
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("explains zero accepted outcomes without changing the healthy evaluation", () => {
    const summary = workstreamStatusFixture({ acceptedWorkThreadCount: 0 });
    expect(formatWorkstreamStatus(summary)).toContain(
      "Next action: Wait for governed completion evidence; no work thread has an accepted outcome yet."
    );
    expect(workstreamStatusJson(summary)).toMatchObject({ state: "healthy", metrics: { acceptedWorkThreadCount: 0 } });
  });

  it("preserves a workstream API 404 instead of rendering fabricated status", async () => {
    await expect(workstreamStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      workstreamId: "missing",
      fetchImpl: async () => Response.json({ error: "workstream_not_found" }, { status: 404 })
    })).rejects.toMatchObject({ status: 404 });
  });

  it("does not hide control-plane alert failures from workstream status", async () => {
    const fixture = workstreamStatusFixture();
    await expect(workstreamStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      workstreamId: fixture.workstream.id,
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.endsWith("/v1/workstreams/workstream_cli_1")) return Response.json({ workstream: fixture.workstream });
        if (href.endsWith("/v1/factory-recipes/recipe_cli_1/versions/1")) return Response.json({ recipe: fixture.recipe });
        if (href.endsWith("/v1/workstreams/workstream_cli_1/metrics")) return Response.json({ metrics: fixture.metrics });
        if (href.endsWith("/v1/workstreams/workstream_cli_1/evaluation")) return Response.json({ evaluation: fixture.evaluation });
        return Response.json({ error: "alerts_unavailable" }, { status: 503 });
      }
    })).rejects.toMatchObject({ status: 503 });
  });

  it("uses native WorkThread and next-action primitives for detail and attention status", async () => {
    const completion = completionExplanationFixture();
    const workThread = governedWorkThreadFixture();
    const view = workLoopViewFixture();
    const acceptedProgress = acceptedProgressFixture();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/v1/work-threads/thread-cli-1/completion")) {
        return Response.json({ workThread, completion, acceptedProgress });
      }
      if (href.endsWith("/v1/work-loops?attention=required&limit=25")) {
        return Response.json({
          attention: "required",
          workLoops: [{ workThread, completion: view }],
          scanned: 3,
          scanLimitReached: false
        });
      }
      return Response.json({ error: "unexpected_url", href }, { status: 500 });
    }) as unknown as typeof fetch;
    const configured = config();
    const detail = await workThreadStatusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      workThreadId: workThread.id,
      fetchImpl
    });
    const attention = await workLoopAttentionStatusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl
    });

    expect(formatWorkThreadStatus(detail)).toContain("WorkThread: thread-cli-1");
    expect(formatWorkThreadStatus(detail)).toContain("Action hint: request_human_decision target=escalation-cli-1");
    expect(formatWorkThreadStatus(detail)).toContain("gate advances: 1 (1 attributed, 0 unresolved)");
    expect(formatWorkThreadStatus(detail)).toContain("pull_request: run=run-cli-1; artifact=artifact-cli-1");
    expect(workThreadStatusJson(detail)).toMatchObject({
      workThread: { id: "thread-cli-1" },
      completion: { nextAction: { hint: { kind: "request_human_decision" } } },
      acceptedProgress: { runIdsWithAcceptedProgress: ["run-cli-1"] }
    });
    expect(formatWorkLoopAttentionStatus(attention)).toContain("Work loops requiring attention: 1 (scanned 3)");
    expect(formatWorkLoopAttentionStatus(attention)).toContain("gate:required_checks/unknown/verification_assurance_insufficient");
    expect(workLoopAttentionStatusJson(attention)).toMatchObject({
      attention: "required",
      workLoops: [{ workThread: { id: "thread-cli-1" } }],
      scanned: 3
    });
  });

  it("prints structured WorkThread and attention status in command JSON mode", async () => {
    const completion = completionExplanationFixture();
    const workThread = governedWorkThreadFixture();
    const view = workLoopViewFixture();
    const acceptedProgress = acceptedProgressFixture();
    const configPath = join(tempDir(), "config.json");
    writeFileSync(configPath, JSON.stringify(config()), { mode: 0o600 });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/v1/work-threads/thread-cli-1/completion")) {
        return Response.json({ workThread, completion, acceptedProgress });
      }
      if (href.endsWith("/v1/work-loops?attention=required&limit=25")) {
        return Response.json({
          attention: "required",
          workLoops: [{ workThread, completion: view }],
          scanned: 1,
          scanLimitReached: false
        });
      }
      return Response.json({ error: "unexpected_url", href }, { status: 500 });
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchImpl);

    try {
      await runStatusCommand({ config: configPath, workThread: workThread.id, json: true });
      await runStatusCommand({ config: configPath, attention: true, json: true });
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        workThread: { id: workThread.id },
        acceptedProgress: { acceptedGateAdvanceCount: 1 }
      });
      expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
        attention: "required",
        workLoops: [{ workThread: { id: workThread.id } }]
      });
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("rejects ambiguous run and channel status requests", async () => {
    await expect(runStatusCommand({ run: "run_1", channel: "lark:tenant_1/oc_chat" })).rejects.toThrow(
      "Use only one of --run, --channel, --workstream, --work-thread, or --attention."
    );
  });

  it("rejects workstream status combined with legacy status selectors", async () => {
    await expect(runStatusCommand({ run: "run_1", workstream: "workstream_1" })).rejects.toThrow(
      "Use only one of --run, --channel, --workstream, --work-thread, or --attention."
    );
    await expect(runStatusCommand({ channel: "lark:tenant_1/oc_chat", workstream: "workstream_1" })).rejects.toThrow(
      "Use only one of --run, --channel, --workstream, --work-thread, or --attention."
    );
    await expect(runStatusCommand({ workThread: "thread_1", attention: true })).rejects.toThrow(
      "Use only one of --run, --channel, --workstream, --work-thread, or --attention."
    );
  });

  it("rejects JSON mode without a workstream selector", async () => {
    await expect(runStatusCommand({ json: true })).rejects.toThrow("Use --json with --workstream, --work-thread, or --attention.");
  });
});
