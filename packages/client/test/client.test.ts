import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { createOpenTagClient, type ChannelBindingInput } from "../src/index.js";

const event: OpenTagEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function completionExplanationFixture() {
  const waivedAt = "2026-07-21T10:05:00.000Z";
  const waiver = {
    id: "waiver-client-1",
    contractId: "contract-client-1",
    contractVersion: 1,
    cycle: 1,
    actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
    reason: "This gate is waived only for the current governed cycle.",
    scope: "selected_gates" as const,
    policyScope: "work_context_owner_container" as const,
    gateIds: ["pull_request"],
    waivedAt
  };
  const contract = {
    id: "contract-client-1",
    version: 1,
    workThreadId: "thread-client-1",
    cycle: 1,
    mode: "governed" as const,
    targetSelectors: [{ key: "primary_change", kind: "change_request" as const, lineage: "current_cycle" as const, cardinality: "exactly_one" as const }],
    resolvedFrom: [{ scope: "work_context_owner_container" as const, ref: "github:acme/demo", version: "1" }],
    gates: [{ id: "pull_request", kind: "artifact" as const, targetKey: "primary_change", artifactKind: "pull_request" as const, minimum: 1 }],
    maxAutomaticRetries: 0,
    onSatisfied: "report_only" as const,
    createdAt: "2026-07-21T10:00:00.000Z"
  };
  const assessment = {
    id: "assessment-client-1",
    workThreadId: "thread-client-1",
    contractId: contract.id,
    contractVersion: 1,
    cycle: 1,
    sequence: 1,
    inputDigest: `sha256:${"a".repeat(64)}`,
    targetBindings: [],
    state: "waived" as const,
    evidenceBacked: false,
    gateResults: [{
      gateId: "pull_request",
      targetKey: "primary_change",
      state: "waived" as const,
      evidenceIds: [],
      reasonCode: "gate_waived" as const,
      reason: "Gate covered by an attributed bounded waiver.",
      evaluatedAt: waivedAt
    }],
    assessedAt: waivedAt,
    assessedBy: "human" as const,
    acceptedAt: waivedAt,
    waiver
  };
  return {
    completion: {
      workThreadId: contract.workThreadId,
      execution: "succeeded" as const,
      completion: "waived" as const,
      evidenceBacked: false,
      contract: { id: contract.id, version: 1, cycle: 1, mode: "governed" as const },
      currentAssessment: assessment,
      targetBindings: [],
      missingGateIds: [],
      failedGateIds: [],
      blockedGateIds: [],
      nextAction: { summary: "No action required.", hint: { kind: "none" as const }, causes: [] },
      contractSnapshot: contract,
      assessmentHistory: [assessment],
      evidence: [],
      openHumanEscalations: []
    },
    waiver
  };
}

describe("@opentag/client", () => {
  it("ensures a durable WorkThread from a normalized event with pairing authorization", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
    const normalizedEvent = {
      ...event,
      workItem: {
        provider: "github",
        kind: "issue",
        externalId: "acme/demo#1",
        uri: "https://github.com/acme/demo/issues/1"
      }
    };
    const workThread = {
      id: "thread_github_acme/demo#1_comment_1",
      workItemReference: normalizedEvent.workItem,
      primaryAnchor: {
        provider: "github",
        kind: "github_thread",
        externalId: normalizedEvent.callback.uri,
        uri: normalizedEvent.callback.uri,
        controlPlane: true,
        canApprove: true
      }
    };
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pairing_token",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        return jsonResponse({ workThread, created: true }, 201);
      }
    });

    await expect(client.ensureWorkThread(normalizedEvent)).resolves.toEqual({ workThread, created: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://dispatcher.test/v1/work-threads/ensure",
      method: "POST",
      body: normalizedEvent
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer pairing_token");
  });

  it("uses the additive factory workstream API routes and parses their contracts", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const digest = `sha256:${"a".repeat(64)}`;
    const recipe = {
      id: "recipe/1",
      version: 2,
      name: "Repository maintenance",
      budgets: {
        maxConcurrentRuns: 2,
        maxAttemptsPerRun: 3,
        maxCostUnits: 12,
        costUnitsPerAttempt: 2,
        allowedLocalities: ["private"]
      },
      createdAt: "2026-07-26T00:00:00.000Z",
      contentDigest: digest
    } as const;
    const workstream = {
      id: "workstream/1",
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      name: "July maintenance",
      members: [{ kind: "work_thread", workThreadId: "thread_1" }],
      createdAt: "2026-07-26T00:01:00.000Z",
      contentDigest: digest
    } as const;
    const batch = {
      id: "batch/1",
      workstreamId: workstream.id,
      items: [{ itemId: "item_1", runId: "run_1", workThreadId: "thread_1", event }],
      createdAt: "2026-07-26T00:02:00.000Z",
      contentDigest: digest
    } as const;
    const result = {
      batchId: batch.id,
      workstreamId: workstream.id,
      inputDigest: digest,
      results: [{ itemId: "item_1", index: 0, runId: "run_1", status: "created" }],
      summary: {
        totalItems: 1,
        createdCount: 1,
        idempotentReplayCount: 0,
        followUpQueuedCount: 0,
        waitActiveRunCount: 0,
        needsHumanDecisionCount: 0,
        rejectedCount: 0,
        exceptionCount: 0,
        omittedExceptionCount: 0,
        exceptions: []
      },
      completedAt: "2026-07-26T00:03:00.000Z"
    } as const;
    const receipt = {
      batch,
      status: "completed",
      items: [{
        itemId: "item_1",
        index: 0,
        runId: "run_1",
        workThreadId: "thread_1",
        status: "completed",
        result: result.results[0]
      }],
      result,
      updatedAt: result.completedAt,
      completedAt: result.completedAt
    } as const;
    const metrics = {
      workstreamId: workstream.id,
      workThreadCount: 1,
      acceptedWorkThreadCount: 1,
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
      totalCostUnits: 2,
      attemptsByLocality: { local: 0, private: 1, hosted: 0, unknown: 0 }
    } as const;
    const evaluation = {
      workstreamId: workstream.id,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      status: "healthy",
      inputDigest: digest,
      evaluatedAt: "2026-07-26T00:04:00.000Z",
      acceptedWorkThreadCount: 1,
      violations: []
    } as const;
    const responses = [
      { recipe }, { recipe }, { workstream }, { workstream }, { receipt }, { receipt }, { metrics }, { evaluation }
    ];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test/",
      pairingToken: "runner_token",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse(responses.shift());
      }
    });

    await expect(client.createFactoryRecipeSnapshot({
      id: recipe.id,
      version: recipe.version,
      name: recipe.name,
      budgets: recipe.budgets
    })).resolves.toEqual({ recipe });
    await expect(client.getFactoryRecipeSnapshot({ id: recipe.id, version: recipe.version })).resolves.toEqual({ recipe });
    await expect(client.createWorkstream({
      id: workstream.id,
      recipeId: workstream.recipeId,
      recipeVersion: workstream.recipeVersion,
      name: workstream.name,
      members: workstream.members
    })).resolves.toEqual({ workstream });
    await expect(client.getWorkstream({ id: workstream.id })).resolves.toEqual({ workstream });
    await expect(client.createWorkstreamAdmissionBatch({
      id: batch.id,
      workstreamId: batch.workstreamId,
      items: batch.items
    })).resolves.toEqual({ receipt });
    await expect(client.getWorkstreamAdmissionBatch({ id: batch.id })).resolves.toEqual({ receipt });
    await expect(client.getWorkstreamMetrics({ id: workstream.id })).resolves.toEqual({ metrics });
    await expect(client.getWorkstreamEvaluation({ id: workstream.id })).resolves.toEqual({ evaluation });

    expect(requests.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual([
      ["http://dispatcher.test/v1/factory-recipes", "POST"],
      ["http://dispatcher.test/v1/factory-recipes/recipe%2F1/versions/2", "GET"],
      ["http://dispatcher.test/v1/workstreams", "POST"],
      ["http://dispatcher.test/v1/workstreams/workstream%2F1", "GET"],
      ["http://dispatcher.test/v1/workstream-batches", "POST"],
      ["http://dispatcher.test/v1/workstream-batches/batch%2F1", "GET"],
      ["http://dispatcher.test/v1/workstreams/workstream%2F1/metrics", "GET"],
      ["http://dispatcher.test/v1/workstreams/workstream%2F1/evaluation", "GET"]
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      id: recipe.id,
      version: recipe.version,
      name: recipe.name,
      budgets: recipe.budgets
    });
    expect(JSON.parse(String(requests[4]?.init?.body))).toEqual({
      id: batch.id,
      workstreamId: batch.workstreamId,
      items: batch.items
    });
  });

  it("preserves factory API response details in HTTP errors", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () => jsonResponse({ error: "workstream_not_found", id: "missing" }, 404)
    });

    await expect(client.getWorkstream({ id: "missing" })).rejects.toMatchObject({
      name: "OpenTagClientHttpError",
      status: 404,
      responseBody: JSON.stringify({ error: "workstream_not_found", id: "missing" })
    });
  });

  it("rejects malformed factory responses instead of returning untyped data", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () => jsonResponse({ metrics: { workstreamId: "workstream_1" } })
    });

    await expect(client.getWorkstreamMetrics({ id: "workstream_1" })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("reports a fenced executor preflight rejection through the runner-scoped route", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test/",
      pairingToken: "runner_token",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ ok: true, replayed: false });
      }
    });

    await client.rejectAttemptStart({
      runnerId: "runner_private",
      runId: "run_preflight",
      attemptId: "attempt_1",
      fencingToken: "fence_1",
      executorId: "codex",
      reason: "Run-specific executor readiness failed."
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://dispatcher.test/v1/runners/runner_private/runs/run_preflight/reject-start"
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer runner_token");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      attemptId: "attempt_1",
      fencingToken: "fence_1",
      executorId: "codex",
      reason: "Run-specific executor readiness failed."
    });
  });

  it("registers and reads explainable runner routing control-plane data", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test/",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        const href = String(url);
        requests.push({ url: href, init });
        if (init?.method === "POST") return jsonResponse({ ok: true }, 201);
        if (href.endsWith("/v1/runners")) {
          return jsonResponse({
            runners: [{
              runnerId: "runner_private",
              name: "Private runner",
              locality: "private",
              declaredState: "ready",
              executors: [{ executorId: "codex", readiness: "ready" }],
              maxConcurrentRuns: 2,
              preference: 10,
              readiness: { state: "ready", reasonCode: "runner_heartbeat_current", reason: "Runner heartbeat is current." },
              capacity: { active: 1, limit: 2 },
              createdAt: "2026-07-25T00:00:00.000Z",
              heartbeatAt: "2026-07-25T00:00:01.000Z"
            }]
          });
        }
        return jsonResponse({
          metrics: {
            completedRuns: 2,
            acceptedCompletions: 1,
            byRunner: [{ id: "runner_private", completedRuns: 2, acceptedCompletions: 1, acceptanceRate: 0.5 }],
            byExecutor: [{ id: "codex", completedRuns: 2, acceptedCompletions: 1, acceptanceRate: 0.5 }]
          }
        });
      }
    });

    await client.registerRunner({
      runnerId: "runner_private",
      name: "Private runner",
      locality: "private",
      executors: [{ executorId: "codex", readiness: "ready" }],
      maxConcurrentRuns: 2,
      preference: 10
    });
    await expect(client.listRunners()).resolves.toMatchObject({
      runners: [{ runnerId: "runner_private", readiness: { state: "ready" }, capacity: { active: 1, limit: 2 } }]
    });
    await expect(client.getAcceptedCompletionMetrics()).resolves.toMatchObject({
      metrics: { completedRuns: 2, acceptedCompletions: 1, byExecutor: [{ id: "codex", acceptanceRate: 0.5 }] }
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://dispatcher.test/v1/runners",
      "http://dispatcher.test/v1/runners",
      "http://dispatcher.test/v1/routing/accepted-completion-metrics"
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      runnerId: "runner_private",
      locality: "private",
      executors: [{ executorId: "codex", readiness: "ready" }],
      maxConcurrentRuns: 2,
      preference: 10
    });
    expect(requests.map((request) => new Headers(request.init?.headers).get("authorization")))
      .toEqual(["Bearer pair_1", "Bearer pair_1", "Bearer pair_1"]);
  });

  it("reads completion explanations and submits attributed bounded waivers", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fixture = completionExplanationFixture();
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test/",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return init?.method === "POST"
          ? jsonResponse({ outcome: "recorded", ...fixture }, 201)
          : jsonResponse({ completion: fixture.completion });
      }
    });

    await expect(client.getCompletion({ runId: "run_completion" })).resolves.toMatchObject({
      completion: { completion: "waived", currentAssessment: { id: "assessment-client-1" } }
    });
    await expect(client.waiveCompletion({
      runId: "run_completion",
      waiver: {
        actor: fixture.waiver.actor,
        reason: fixture.waiver.reason,
        scope: fixture.waiver.scope,
        policyScope: fixture.waiver.policyScope,
        gateIds: fixture.waiver.gateIds,
        waivedAt: fixture.waiver.waivedAt
      }
    })).resolves.toMatchObject({
      outcome: "recorded",
      completion: { completion: "waived" },
      waiver: { id: fixture.waiver.id }
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://dispatcher.test/v1/runs/run_completion/completion",
      "http://dispatcher.test/v1/runs/run_completion/completion/waivers"
    ]);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer pair_1");
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("Bearer pair_1");
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      actor: fixture.waiver.actor,
      reason: fixture.waiver.reason,
      gateIds: ["pull_request"]
    });
  });

  it("reads one governed WorkThread and a bounded work-loop attention view", async () => {
    const fixture = completionExplanationFixture();
    const workThread = {
      id: "thread-client-1",
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
    const requests: string[] = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url) => {
        const href = String(url);
        requests.push(href);
        if (href.endsWith("/v1/work-threads/thread-client-1/completion")) {
          return jsonResponse({ workThread, completion: fixture.completion });
        }
        if (href.endsWith("/v1/work-loops?attention=required&limit=10")) {
          return jsonResponse({ attention: "required", workLoops: [], scanned: 1, scanLimitReached: false });
        }
        return jsonResponse({ error: "unexpected_url" }, 500);
      }
    });

    await expect(client.getWorkThreadCompletion({ workThreadId: workThread.id })).resolves.toMatchObject({
      workThread: { id: workThread.id },
      completion: { completion: "waived", nextAction: { hint: { kind: "none" } } }
    });
    await expect(client.listWorkLoopsRequiringAttention({ limit: 10 })).resolves.toEqual({
      attention: "required",
      workLoops: [],
      scanned: 1,
      scanLimitReached: false
    });
    expect(requests).toEqual([
      "http://dispatcher.test/v1/work-threads/thread-client-1/completion",
      "http://dispatcher.test/v1/work-loops?attention=required&limit=10"
    ]);
    await expect(client.listWorkLoopsRequiringAttention({ limit: 0 })).rejects.toThrow("integer from 1 to 100");
  });

  it("lists, acknowledges, and resolves attributed human escalations", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const escalation = {
      id: "escalation/client?1",
      workThreadId: "thread_client_1",
      runId: "run/client?1",
      class: "missing_input" as const,
      audience: "requester" as const,
      subjectRef: "deployment-target",
      state: "open" as const,
      blocking: true,
      summary: "Choose a deployment target.",
      reason: "No target was provided.",
      openedAt: "2026-07-25T00:00:00.000Z"
    };
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/human-escalations")) return jsonResponse({ escalations: [escalation] });
        if (String(url).endsWith("/acknowledge")) {
          return jsonResponse({
            outcome: "acknowledged",
            escalation: {
              ...escalation,
              state: "acknowledged",
              acknowledgement: {
                actor: { provider: "github", providerUserId: "42" },
                acknowledgedAt: "2026-07-25T00:01:00.000Z"
              }
            }
          }, 201);
        }
        return jsonResponse({
          outcome: "resolved",
          escalation: {
            ...escalation,
            state: "resolved",
            resolution: {
              actor: { provider: "github", providerUserId: "42" },
              reason: "Use staging.",
              resolvedAt: "2026-07-25T00:02:00.000Z"
            }
          },
          resume: { required: true, reason: "Executor stopped.", nextAction: "Send a new task." }
        }, 201);
      }
    });

    await expect(client.listHumanEscalations({ runId: escalation.runId })).resolves.toMatchObject({
      escalations: [{ id: escalation.id, state: "open" }]
    });
    await expect(client.acknowledgeHumanEscalation({
      escalationId: escalation.id,
      actor: { provider: "github", providerUserId: "42" },
      acknowledgedAt: "2026-07-25T00:01:00.000Z"
    })).resolves.toMatchObject({ outcome: "acknowledged", escalation: { state: "acknowledged" } });
    await expect(client.resolveHumanEscalation({
      escalationId: escalation.id,
      actor: { provider: "github", providerUserId: "42" },
      reason: "Use staging.",
      resolvedAt: "2026-07-25T00:02:00.000Z"
    })).resolves.toMatchObject({ outcome: "resolved", resume: { required: true } });
    expect(requests.map((request) => request.url)).toEqual([
      "http://dispatcher.test/v1/runs/run%2Fclient%3F1/human-escalations",
      "http://dispatcher.test/v1/human-escalations/escalation%2Fclient%3F1/acknowledge",
      "http://dispatcher.test/v1/human-escalations/escalation%2Fclient%3F1/resolve"
    ]);
    expect(requests.map((request) => request.init?.method ?? "GET")).toEqual(["GET", "POST", "POST"]);
    expect(requests.map((request) => new Headers(request.init?.headers).get("authorization")))
      .toEqual(["Bearer pair_1", "Bearer pair_1", "Bearer pair_1"]);
  });

  it("sends and reads repo-less channel bindings", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const binding: ChannelBindingInput = {
      provider: "lark",
      accountId: "tenant_1",
      conversationId: "oc_chat",
      metadata: { displayName: "General" }
    };
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (init?.method === "POST") return jsonResponse({ ok: true });
        return jsonResponse({ binding });
      }
    });

    await client.bindChannel(binding);
    await expect(client.getChannelBinding({ provider: "lark", accountId: "tenant_1", conversationId: "oc_chat" })).resolves.toEqual({
      binding
    });

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(binding);
    expect(requests[1]?.url).toBe("http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat");
  });

  it("marks explicit local-admin channel binding mutations for dispatcher audit", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ ok: true }, 201);
      }
    });

    await client.bindChannel(
      {
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
      },
      { adminOverride: true }
    );

    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer pair_1");
    expect(headers.get("x-opentag-channel-admin-override")).toBe("true");
    expect(JSON.parse(String(requests[0]?.init?.body))).not.toHaveProperty("adminOverride");
  });

  it("creates dispatcher runs with validated event payloads and auth headers", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test/",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          decision: {
            action: "start",
            reason: "accepted",
            reasonCode: "new_event",
            decidedAt: "2026-06-24T00:00:00.000Z",
            eventId: "evt_1"
          },
          run: {
            id: "run_1",
            eventId: "evt_1",
            status: "queued",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          }
        });
      }
    });

    const result = await client.createRun({ runId: "run_1", event });

    expect(result).toMatchObject({ outcome: "run_created", run: { id: "run_1" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/runs");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer pair_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      runId: "run_1",
      event: { id: "evt_1", command: { rawText: "fix this" } }
    });
  });

  it("returns null when a runner claim has no available work", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () => new Response(null, { status: 204 })
    });

    await expect(client.claim({ runnerId: "runner_1" })).resolves.toBeNull();
  });

  it("parses claimed run responses", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () =>
        jsonResponse({
          run: {
            id: "run_1",
            eventId: "evt_1",
            status: "assigned",
            assignedRunnerId: "runner_1",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          event,
          attemptId: "attempt_1",
          attemptNumber: 1,
          fencingToken: "fence_1"
        })
    });

    const claimed = await client.claim({ runnerId: "runner_1" });

    expect(claimed?.run.status).toBe("assigned");
    expect(claimed?.event.id).toBe("evt_1");
    expect(claimed).toMatchObject({ attemptId: "attempt_1", attemptNumber: 1, fencingToken: "fence_1" });
  });

  it("parses additive executor and routing decision fields from a claim", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () => jsonResponse({
        run: {
          id: "run_routed",
          eventId: "evt_1",
          status: "assigned",
          assignedRunnerId: "runner_1",
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:01.000Z"
        },
        event,
        attemptId: "attempt_routed",
        attemptNumber: 1,
        fencingToken: "fence_routed",
        executorId: "codex",
        routingDecision: {
          id: "routing_routed",
          runId: "run_routed",
          candidates: [{
            runnerId: "runner_1",
            executorId: "codex",
            eligible: true,
            reasons: [{ code: "executor_ready", message: "Runner reported this executor ready." }]
          }],
          selected: { runnerId: "runner_1", executorId: "codex" },
          reasonCode: "preferred_eligible_candidate",
          reason: "Selected the first eligible target in the configured stable preference order.",
          decidedAt: "2026-07-25T00:00:01.000Z"
        }
      })
    });

    await expect(client.claim({ runnerId: "runner_1" })).resolves.toMatchObject({
      executorId: "codex",
      routingDecision: {
        selected: { runnerId: "runner_1", executorId: "codex" },
        candidates: [{ eligible: true }]
      }
    });
  });

  it("includes dispatcher error bodies in thrown errors", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () => jsonResponse({ error: "repo_not_bound" }, 403)
    });

    await expect(client.createRun({ runId: "run_1", event })).rejects.toThrow(
      'createRun failed: 403 {"error":"repo_not_bound"}'
    );
  });

  it("sends runner hard timeout policy when marking a run as running", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ ok: true });
      }
    });

    await client.markRunning({
      runnerId: "runner_1",
      runId: "run_1",
      executor: "echo",
      attemptId: "attempt_1",
      fencingToken: "fence_1",
      runTimeoutMs: 30_000,
      idempotencyKey: "runner_1:run_1:running"
    });

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/runners/runner_1/runs/run_1/running");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer pair_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      executor: "echo",
      attemptId: "attempt_1",
      fencingToken: "fence_1",
      runTimeoutMs: 30_000,
      idempotencyKey: "runner_1:run_1:running"
    });
  });

  it("sends runner progress idempotency keys to the dispatcher", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ ok: true });
      }
    });

    await client.progress({
      runnerId: "runner_1",
      runId: "run_1",
      attemptId: "attempt_1",
      fencingToken: "fence_1",
      type: "ingest.hermes.post_llm_call",
      message: "LLM call completed.",
      at: "2026-06-24T00:00:01.000Z",
      visibility: "audit",
      idempotencyKey: "hermes:run_1:post_llm_call:1"
    });

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/runners/runner_1/runs/run_1/progress");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer pair_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      type: "ingest.hermes.post_llm_call",
      attemptId: "attempt_1",
      fencingToken: "fence_1",
      message: "LLM call completed.",
      at: "2026-06-24T00:00:01.000Z",
      visibility: "audit",
      idempotencyKey: "hermes:run_1:post_llm_call:1"
    });
  });

  it("forwards fenced governed action requests and parses durable resolutions", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const action = {
      id: "action_1", runId: "run_1", attemptId: "attempt_1", actionFamily: "publish", capability: "publish",
      scope: { permissionScopes: ["npm:publish"] }, target: { title: "Publish package" }, riskTier: "high",
      status: "waiting_approval", idempotencyKey: "action:key", proposalId: "proposal_action_1",
      attemptFenceDigest: "digest", createdAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:00:00.000Z"
    };
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse({ resolution: { state: "waiting", action } }, 202);
      }
    });
    await expect(client.requestActionPermission({
      runnerId: "runner_1", runId: "run_1", attemptId: "attempt_1", fencingToken: "fence_1",
      request: { toolCallId: "tool_1", title: "Publish package", kind: "publish", permissionScopes: ["npm:publish"], mode: "ask", provider: "npm" }
    })).resolves.toMatchObject({ state: "waiting", action: { id: "action_1", attemptFenceDigest: "digest" } });
    expect(requests).toEqual([{
      url: "http://dispatcher.test/v1/runners/runner_1/runs/run_1/action-permissions",
      body: {
        attemptId: "attempt_1", fencingToken: "fence_1",
        request: { toolCallId: "tool_1", title: "Publish package", kind: "publish", permissionScopes: ["npm:publish"], mode: "ask", provider: "npm" }
      }
    }]);
  });

  it("sends runner completion idempotency keys to the dispatcher", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ ok: true });
      }
    });

    await client.complete({
      runnerId: "runner_1",
      runId: "run_1",
      attemptId: "attempt_1",
      fencingToken: "fence_1",
      result: { conclusion: "success", summary: "done" },
      idempotencyKey: "hermes:run_1:complete:agent_end"
    });

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/runners/runner_1/runs/run_1/complete");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer pair_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      result: { conclusion: "success", summary: "done" },
      attemptId: "attempt_1",
      fencingToken: "fence_1",
      idempotencyKey: "hermes:run_1:complete:agent_end"
    });
  });

  it("deletes channel bindings through the dispatcher API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(null, { status: 204 });
      }
    });

    await client.unbindChannel({ provider: "lark", accountId: "tenant 1", conversationId: "oc/chat" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/channel-bindings/lark/tenant%201/oc%2Fchat");
    expect(requests[0]?.init?.method).toBe("DELETE");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer pair_1" });
  });

  it("sends the authenticated channel principal through the Slack compatibility binding route", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      channelPrincipalCredential: "slack_principal_owner",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ ok: true }, 201);
      }
    });

    await client.bindSlackChannel({
      teamId: "T123",
      channelId: "C456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/slack-channel-bindings");
    expect(new Headers(requests[0]?.init?.headers).get("x-opentag-channel-principal")).toBe("slack_principal_owner");
  });

  it("reads channel runtime status through the dispatcher API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      channelPrincipalCredential: "lark_principal_owner",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          binding: {
            provider: "lark",
            accountId: "tenant_1",
            conversationId: "oc_chat"
          },
          activeRun: {
            id: "run_active",
            eventId: "evt_active",
            status: "running",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:01.000Z"
          },
          activeEvent: event,
          runTimeoutPolicy: { hardTimeoutMs: 30_000 },
          queuedFollowUps: [
            {
              id: "follow_up_1",
              sourceEventId: "evt_follow_up",
              conversationKey: "lark:tenant_1|oc_chat|om_msg",
              activeRunId: "run_active",
              event,
              decision: {
                action: "queue_follow_up",
                reason: "A run is already active for this thread.",
                reasonCode: "active_run_same_thread",
                decidedAt: "2026-06-24T00:00:02.000Z",
                activeRunId: "run_active",
                eventId: "evt_follow_up"
              },
              status: "queued",
              createdAt: "2026-06-24T00:00:02.000Z",
              updatedAt: "2026-06-24T00:00:02.000Z"
            }
          ]
        });
      }
    });

    const status = await client.getChannelRuntimeStatus({ provider: "lark", accountId: "tenant_1", conversationId: "oc_chat" });

    expect(status.binding).toEqual({ provider: "lark", accountId: "tenant_1", conversationId: "oc_chat" });

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat/status");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer pair_1");
    expect(headers.get("x-opentag-channel-principal")).toBe("lark_principal_owner");
    expect(status.activeRun?.id).toBe("run_active");
    expect(status.runTimeoutPolicy).toEqual({ hardTimeoutMs: 30_000 });
    expect(status.queuedFollowUps.map((followUp) => followUp.id)).toEqual(["follow_up_1"]);
  });

  it("reads control-plane alert candidates through the dispatcher API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          alerts: [
            {
              id: "repeated_auth_failures:security.auth_failed:token_a",
              type: "repeated_auth_failures",
              severity: "warn",
              eventType: "security.auth_failed",
              count: 3,
              threshold: 3,
              firstSeenAt: "2026-06-24T00:00:00.000Z",
              lastSeenAt: "2026-06-24T00:00:02.000Z",
              subject: "token_a",
              reason: "Repeated dispatcher authorization failures were observed.",
              nextAction: "Check runner credentials."
            }
          ]
        });
      }
    });

    await expect(client.listControlPlaneAlerts({ limit: 25 })).resolves.toMatchObject({
      alerts: [
        {
          type: "repeated_auth_failures",
          subject: "token_a",
          count: 3,
          threshold: 3
        }
      ]
    });
    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/control-plane-alerts?limit=25");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer pair_1" });
  });

  it("records control-plane events through the dispatcher API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ ok: true }, 201);
      }
    });

    await client.recordControlPlaneEvent({
      type: "security.signature_failed",
      severity: "warn",
      subject: "github:POST /github/webhooks",
      payload: { provider: "github", reason: "invalid_signature" }
    });

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/control-plane-events");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer pair_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      type: "security.signature_failed",
      severity: "warn",
      subject: "github:POST /github/webhooks",
      payload: { provider: "github", reason: "invalid_signature" }
    });
  });

  it("submits sanitized GitHub completion evidence through the dispatcher API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ outcome: "recorded" }, 201);
      }
    });
    const snapshot = {
      provider: "github" as const,
      deliveryId: "delivery-completion-1",
      eventName: "pull_request" as const,
      repository: { owner: "acme", repo: "demo" },
      pullRequest: {
        number: 7,
        resourceRef: "github:acme/demo:pull_request:7",
        headSha: "b".repeat(40),
        baseSha: "c".repeat(40),
        baseBranch: "main",
        state: "merged" as const
      },
      checks: { build: "passed" as const },
      observedAt: "2026-07-21T10:00:00.000Z",
      payloadDigest: `sha256:${"d".repeat(64)}`
    };

    await client.ingestGitHubCompletionEvidence(snapshot);

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/completion-evidence/github");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer pair_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(snapshot);
  });

  it("submits GitHub completion reconciliation escalation intents with pairing authorization", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pairing_admin_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ outcome: "recorded" }, 202);
      }
    });
    const request = {
      operation: "open" as const,
      escalation: {
        class: "reconciliation" as const,
        audience: "repo_owner" as const,
        subjectRef: "github:acme/demo:pull_request:7",
        state: "open" as const,
        blocking: true as const,
        summary: "GitHub completion reconciliation needs repository-owner attention.",
        reason: "The authoritative pull request snapshot could not be loaded.",
        dedupeKey: "github:completion-reconciliation:acme/demo:7"
      },
      correlation: {
        provider: "github" as const,
        deliveryId: "delivery-reconcile-1",
        eventName: "check_run" as const,
        repository: { owner: "acme", repo: "demo" },
        pullRequestNumbers: [7],
        headSha: "b".repeat(40)
      }
    };

    await client.requestGitHubCompletionReconciliationEscalation(request);

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/completion-escalations/github");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer pairing_admin_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(request);
  });

  it("prunes source delivery replay keys through the dispatcher API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "runner_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          result: {
            scanned: 3,
            pruned: 2,
            retainedActive: 1
          }
        });
      }
    });

    await expect(
      client.pruneSourceDeliveries({
        olderThan: "2026-06-24T00:00:00.000Z",
        limit: 50
      })
    ).resolves.toEqual({
      scanned: 3,
      pruned: 2,
      retainedActive: 1
    });
    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/source-deliveries/prune");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer runner_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      olderThan: "2026-06-24T00:00:00.000Z",
      limit: 50
    });
  });

  it("requests run cancellation through the dispatcher API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          outcome: "cancelled",
          run: {
            id: "run_1",
            eventId: "evt_1",
            status: "cancelled",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z",
            result: { conclusion: "cancelled", summary: "Stop requested." }
          }
        });
      }
    });

    await expect(client.cancelRun({ runId: "run_1", reason: "Stop requested.", requestedBy: "lark:ou_sender" })).resolves.toMatchObject({
      outcome: "cancelled",
      run: { id: "run_1", status: "cancelled" }
    });

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/runs/run_1/cancel");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer pair_1" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      reason: "Stop requested.",
      requestedBy: "lark:ou_sender"
    });
  });

  it("requests active channel run cancellation through the dispatcher API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      channelPrincipalCredential: "lark_principal_owner",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          outcome: "cancelled",
          run: {
            id: "run_active",
            eventId: "evt_active",
            status: "cancelled",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z",
            result: { conclusion: "cancelled", summary: "Stop requested." }
          }
        });
      }
    });

    await client.cancelActiveChannelRun({
      provider: "lark",
      accountId: "tenant 1",
      conversationId: "oc/chat",
      reason: "Stop requested."
    });

    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/channel-bindings/lark/tenant%201/oc%2Fchat/cancel-active-run");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("x-opentag-channel-principal")).toBe("lark_principal_owner");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ reason: "Stop requested." });
  });

  it("parses follow-up queued run responses", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () =>
        jsonResponse(
          {
            decision: {
              action: "queue_follow_up",
              reason: "active run exists",
              reasonCode: "active_run_same_thread",
              decidedAt: "2026-06-24T00:00:00.000Z",
              activeRunId: "run_active",
              eventId: "evt_1"
            },
            followUpRequest: {
              id: "follow_up_1",
              sourceEventId: "evt_1",
              conversationKey: "github:https://api.github.com/repos/acme/demo/issues/1/comments",
              activeRunId: "run_active",
              event,
              decision: {
                action: "queue_follow_up",
                reason: "active run exists",
                reasonCode: "active_run_same_thread",
                decidedAt: "2026-06-24T00:00:00.000Z",
                activeRunId: "run_active",
                eventId: "evt_1"
              },
              status: "queued",
              createdAt: "2026-06-24T00:00:00.000Z",
              updatedAt: "2026-06-24T00:00:00.000Z"
            }
          },
          202
        )
    });

    await expect(client.createRun({ runId: "run_1", event })).resolves.toMatchObject({
      outcome: "follow_up_queued",
      followUpRequest: { id: "follow_up_1" }
    });
  });

  it("parses needs-human-decision responses", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () =>
        jsonResponse(
          {
            decision: {
              action: "needs_human_decision",
              reason: "repo binding missing",
              reasonCode: "repo_not_bound",
              decidedAt: "2026-06-24T00:00:00.000Z",
              eventId: "evt_1"
            },
            escalation: {
              id: "escalation_admission_1",
              workThreadId: "thread_admission_1",
              class: "configuration",
              audience: "operator",
              subjectRef: "github:acme/demo",
              state: "open",
              blocking: true,
              summary: "Run admission needs human attention.",
              reason: "repo binding missing",
              openedAt: "2026-06-24T00:00:00.000Z"
            }
          },
          202
        )
    });

    await expect(client.createRun({ runId: "run_1", event })).resolves.toMatchObject({
      outcome: "needs_human_decision",
      decision: { reasonCode: "repo_not_bound" },
      escalation: { id: "escalation_admission_1", state: "open" }
    });
  });

  it("loads and promotes follow-up requests", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/create-run")) {
          return jsonResponse({
            followUpRequest: {
              id: "follow_up_1",
              sourceEventId: "evt_1",
              conversationKey: "github:https://api.github.com/repos/acme/demo/issues/1/comments",
              event,
              decision: {
                action: "queue_follow_up",
                reason: "active run exists",
                reasonCode: "active_run_same_thread",
                decidedAt: "2026-06-24T00:00:00.000Z",
                eventId: "evt_1"
              },
              status: "promoted",
              createdRunId: "run_2",
              createdAt: "2026-06-24T00:00:00.000Z",
              updatedAt: "2026-06-24T00:01:00.000Z"
            },
            run: {
              id: "run_2",
              eventId: "evt_1",
              status: "queued",
              createdAt: "2026-06-24T00:01:00.000Z",
              updatedAt: "2026-06-24T00:01:00.000Z"
            }
          });
        }
        return jsonResponse({
          followUpRequest: {
            id: "follow_up_1",
            sourceEventId: "evt_1",
            conversationKey: "github:https://api.github.com/repos/acme/demo/issues/1/comments",
            event,
            decision: {
              action: "queue_follow_up",
              reason: "active run exists",
              reasonCode: "active_run_same_thread",
              decidedAt: "2026-06-24T00:00:00.000Z",
              eventId: "evt_1"
            },
            status: "queued",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          }
        });
      }
    });

    await expect(client.getFollowUpRequest({ id: "follow_up_1" })).resolves.toMatchObject({
      followUpRequest: { id: "follow_up_1", status: "queued" }
    });
    await expect(client.createRunFromFollowUpRequest({ id: "follow_up_1", runId: "run_2" })).resolves.toMatchObject({
      followUpRequest: { id: "follow_up_1", status: "promoted", createdRunId: "run_2" },
      run: { id: "run_2" }
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://dispatcher.test/v1/follow-up-requests/follow_up_1",
      "http://dispatcher.test/v1/follow-up-requests/follow_up_1/create-run"
    ]);
  });

  it("calls proposal approval and apply-plan endpoints", async () => {
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          authorization: new Headers(init?.headers).get("authorization")
        });
        if (String(url).endsWith("/approvals")) {
          return jsonResponse({
            decision: {
              id: "approval_1",
              proposalId: "proposal_1",
              approvedIntentIds: ["intent_1"],
              approvedBy: { provider: "github", providerUserId: "42" },
              approvedAt: "2026-06-24T00:00:00.000Z",
              scope: "manual"
            }
          }, 201);
        }
        return jsonResponse({
          plan: {
            id: "apply_1",
            proposalId: "proposal_1",
            approvalDecisionId: "approval_1",
            selectedIntentIds: ["intent_1"],
            mode: "preflight_then_per_intent",
            outcomes: [{ intentId: "intent_1", outcome: "skipped" }]
          }
        }, 201);
      }
    });

    await expect(
      client.approveProposal({
        proposalId: "proposal_1",
        id: "approval_1",
        approvedIntentIds: ["intent_1"],
        approvedBy: { provider: "github", providerUserId: "42" },
        approvedAt: "2026-06-24T00:00:00.000Z"
      })
    ).resolves.toMatchObject({ decision: { id: "approval_1" } });
    await expect(
      client.createApplyPlan({
        proposalId: "proposal_1",
        id: "apply_1",
        approvalDecisionId: "approval_1",
        adapter: "github"
      })
    ).resolves.toMatchObject({ plan: { id: "apply_1" } });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/proposals/proposal_1/approvals",
        authorization: "Bearer pair_1",
        body: {
          id: "approval_1",
          approvedIntentIds: ["intent_1"],
          approvedBy: { provider: "github", providerUserId: "42" },
          approvedAt: "2026-06-24T00:00:00.000Z"
        }
      },
      {
        url: "http://dispatcher.test/v1/proposals/proposal_1/apply-plans",
        authorization: "Bearer pair_1",
        body: {
          id: "apply_1",
          approvalDecisionId: "approval_1",
          adapter: "github"
        }
      }
    ]);
  });

  it("submits thread-native action replies to the dispatcher", async () => {
    const requests: Array<{ url: string; body?: unknown; authorization: string | null }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          authorization: new Headers(init?.headers).get("authorization")
        });
        return jsonResponse({
          outcome: "applied",
          decision: {
            id: "approval_1",
            proposalId: "proposal_1",
            approvedIntentIds: ["intent_1"],
            approvedBy: { provider: "github", providerUserId: "42" },
            approvedAt: "2026-06-24T00:00:00.000Z",
            scope: "manual"
          }
        }, 201);
      }
    });

    await expect(
      client.submitThreadAction({
        rawText: "apply 1",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        callback: {
          provider: "github",
          uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
          threadKey: "acme/demo"
        },
        metadata: { owner: "acme", repo: "demo", issueNumber: 1 }
      })
    ).resolves.toMatchObject({ outcome: "applied", decision: { id: "approval_1" } });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/thread-actions",
        authorization: "Bearer pair_1",
        body: {
          rawText: "apply 1",
          actor: { provider: "github", providerUserId: "42", handle: "octocat" },
          callback: {
            provider: "github",
            uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
            threadKey: "acme/demo"
          },
          metadata: { owner: "acme", repo: "demo", issueNumber: 1 }
        }
      }
    ]);
  });

  it("calls repo policy rule endpoints", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        if (init?.method === "POST") {
          return jsonResponse({
            rule: {
              id: "repo_allows_labels",
              scope: "work_context_owner_container",
              effect: "allow",
              capabilityId: "set_labels",
              reason: "Repo allows labels."
            }
          }, 201);
        }
        return jsonResponse({
          rules: [
            {
              id: "repo_allows_labels",
              scope: "work_context_owner_container",
              effect: "allow",
              capabilityId: "set_labels",
              reason: "Repo allows labels."
            }
          ]
        });
      }
    });

    await expect(
      client.upsertRepoPolicyRule({
        provider: "github",
        owner: "acme",
        repo: "demo",
        rule: {
          id: "repo_allows_labels",
          scope: "work_context_owner_container",
          effect: "allow",
          capabilityId: "set_labels",
          reason: "Repo allows labels."
        }
      })
    ).resolves.toMatchObject({ rule: { id: "repo_allows_labels" } });
    await expect(client.listRepoPolicyRules({ provider: "github", owner: "acme", repo: "demo" })).resolves.toMatchObject({
      rules: [{ id: "repo_allows_labels" }]
    });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/repo-bindings/github/acme/demo/policy-rules",
        method: "POST",
        body: {
          rule: {
            id: "repo_allows_labels",
            scope: "work_context_owner_container",
            effect: "allow",
            capabilityId: "set_labels",
            reason: "Repo allows labels."
          }
        }
      },
      {
        url: "http://dispatcher.test/v1/repo-bindings/github/acme/demo/policy-rules",
        method: "GET"
      }
    ]);
  });

  it("calls repo mutation mapping endpoints", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const mapping = {
      id: "github_status_labels",
      adapter: "github" as const,
      domain: "status" as const,
      strategy: "label" as const,
      values: { blocked: "status/blocked" }
    };
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        if (init?.method === "POST") {
          return jsonResponse({ mapping }, 201);
        }
        return jsonResponse({ mappings: [mapping] });
      }
    });

    await expect(
      client.upsertRepoMutationMapping({
        provider: "github",
        owner: "acme",
        repo: "demo",
        mapping
      })
    ).resolves.toMatchObject({ mapping: { id: "github_status_labels" } });
    await expect(client.listRepoMutationMappings({ provider: "github", owner: "acme", repo: "demo" })).resolves.toMatchObject({
      mappings: [{ id: "github_status_labels" }]
    });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/repo-bindings/github/acme/demo/mutation-mappings",
        method: "POST",
        body: { mapping }
      },
      {
        url: "http://dispatcher.test/v1/repo-bindings/github/acme/demo/mutation-mappings",
        method: "GET"
      }
    ]);
  });

  it("calls Linear relay installation endpoint without reading secrets back", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pairing_token",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        return jsonResponse(
          {
            installation: {
              id: "install_123",
              webhookPath: "/linear/webhooks/install_123",
              projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" }
            }
          },
          201
        );
      }
    });

    await expect(
      client.upsertLinearRelayInstallation({
        id: "install_123",
        webhookPath: "/linear/webhooks/install_123",
        webhookSecret: "linear_webhook_secret",
        token: "linear_oauth_token",
        auth: {
          method: "oauth_app",
          actor: "app",
          clientId: "linear_client",
          refreshToken: "linear_refresh_token",
          accessTokenExpiresAt: "2026-07-07T00:10:00.000Z",
          scopes: ["read", "comments:create"]
        },
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    ).resolves.toEqual({
      installation: {
        id: "install_123",
        webhookPath: "/linear/webhooks/install_123",
        projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" }
      }
    });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/linear-relay-installations",
        method: "POST",
        body: {
          id: "install_123",
          webhookPath: "/linear/webhooks/install_123",
          webhookSecret: "linear_webhook_secret",
          token: "linear_oauth_token",
          auth: {
            method: "oauth_app",
            actor: "app",
            clientId: "linear_client",
            refreshToken: "linear_refresh_token",
            accessTokenExpiresAt: "2026-07-07T00:10:00.000Z",
            scopes: ["read", "comments:create"]
          },
          repoProvider: "github",
          owner: "acme",
          repo: "demo"
        }
      }
    ]);
  });

  it("calls Linear OAuth installation start endpoint", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pairing_token",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        return jsonResponse(
          {
            authorizationUrl: "https://linear.app/oauth/authorize?state=linear_state",
            stateExpiresAt: "2026-07-07T00:10:00.000Z",
            oauthWebhookPath: "/linear/oauth/webhooks",
            installation: {
              id: "install_123",
              webhookPath: "/linear/webhooks/install_123",
              projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" }
            }
          },
          201
        );
      }
    });

    await expect(
      client.createLinearOAuthInstallation({
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        teamKey: "ENG"
      })
    ).resolves.toMatchObject({
      authorizationUrl: expect.stringContaining("linear.app/oauth/authorize"),
      oauthWebhookPath: "/linear/oauth/webhooks",
      installation: {
        webhookPath: "/linear/webhooks/install_123",
        projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" }
      }
    });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/linear-oauth-installations",
        method: "POST",
        body: {
          repoProvider: "github",
          owner: "acme",
          repo: "demo",
          teamKey: "ENG"
        }
      }
    ]);
  });

  it("calls aggregate metrics endpoints", async () => {
    const requests: string[] = [];
    const metrics = {
      scope: "repo",
      scopeId: "github:acme/demo",
      runCount: 2,
      totalEventCount: 10,
      humanEventCount: 2,
      auditEventCount: 8,
      debugEventCount: 0,
      humanCallbackCount: 2,
      threadNoiseRatio: 0.25,
      suggestedChangesCount: 2,
      approvalDecisionCount: 1,
      applyPlanCount: 1,
      childRunCount: 1,
      applyOutcomeCounts: { applied: 0, skipped: 1, failed: 0, stale: 0, unsupported: 0 },
      staleIntentCount: 0
    };
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async (url) => {
        requests.push(String(url));
        return jsonResponse({ metrics });
      }
    });

    await expect(client.getRepoMetrics({ provider: "github", owner: "acme", repo: "demo" })).resolves.toMatchObject({
      metrics: { scope: "repo", runCount: 2 }
    });
    await expect(client.getWorkThreadMetrics({ threadId: "thread/github/acme/demo#1" })).resolves.toMatchObject({
      metrics: { runCount: 2 }
    });

    expect(requests).toEqual([
      "http://dispatcher.test/v1/repo-bindings/github/acme/demo/metrics",
      "http://dispatcher.test/v1/work-thread-metrics?threadId=thread%2Fgithub%2Facme%2Fdemo%231"
    ]);
  });
});
