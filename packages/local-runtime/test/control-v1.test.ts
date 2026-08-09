import { describe, expect, it, vi } from "vitest";
import { RunnerReadinessReceiptEnvelopeV1Schema } from "@opentag/core";
import { serveDaemon, type DaemonClient } from "../src/daemon.js";
import { assertHostedClaimCurrentAuthorityV1, assertRunnerControlContextRegistrationV1, buildHostedClaimRequestV1, buildHostedCompletionMetadataForControlV1, buildHostedProgressMetadataForControlV1, buildRunnerReadinessReceipt, createHostedControlLoop, isRunnerControlContextFreshV1, pumpControlPlaneProjections, type ControlPlaneProjectionOutboxEntry, type ControlProjectionClient, type ControlProjectionRepository } from "../src/control-v1.js";

const now = new Date("2026-08-09T00:00:00.000Z");

function callbackEntry(): ControlPlaneProjectionOutboxEntry {
  return {
    receiptId: "receipt_callback_1",
    destinationId: "cloud",
    organizationId: "org_1",
    runId: "run_1",
    workThreadId: "work_thread_1",
    receiptKind: "callback_intent_observation",
    identity: { namespace: "opentag.control.receipt/callback-intent-observation/v1", parts: ["org_1", "work_thread_1", "intent_1"], key: "identity" },
    operationId: "operation_1",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    receiptDigest: `sha256:${"b".repeat(64)}`,
    envelope: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      receiptKind: "callback_intent_observation",
      receiptId: "receipt_callback_1",
      organizationId: "org_1",
      operationId: "operation_1",
      requiredCapabilities: ["relay.callback-observation.v1"],
      producer: { kind: "local_opentag", id: "runner_1" },
      identity: { namespace: "opentag.control.receipt/callback-intent-observation/v1", parts: ["org_1", "work_thread_1", "intent_1"] },
      observedAt: now.toISOString(),
      payloadDigest: `sha256:${"a".repeat(64)}`,
      receiptDigest: `sha256:${"b".repeat(64)}`,
      runId: "run_1",
      workThreadId: "work_thread_1",
      payload: {
        localIntentId: "intent_1",
        assessmentRef: "assessment_1",
        assessmentDigest: `sha256:${"c".repeat(64)}`,
        provider: "github",
        sourceThreadIdentityDigest: `sha256:${"d".repeat(64)}`,
        operationId: "operation_1",
        payloadDigest: `sha256:${"e".repeat(64)}`,
        createdAt: now.toISOString(),
      },
    },
    state: "leased",
    attemptCount: 1,
    leaseOwner: "pump_1",
    leaseToken: "lease_1",
    leaseExpiresAt: "2026-08-09T00:01:30.000Z",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function harness(entry: ControlPlaneProjectionOutboxEntry) {
  let current: ControlPlaneProjectionOutboxEntry | undefined = entry;
  const repo: ControlProjectionRepository = {
    recoverExpiredControlPlaneProjectionLeases: vi.fn(async () => ({ recovered: 0, entries: [] })),
    claimDueControlPlaneProjections: vi.fn(async () => ({ entries: current ? [current] : [] })),
    acknowledgeControlPlaneProjection: vi.fn(async () => { current = undefined; return { outcome: "acknowledged" as const }; }),
    retryControlPlaneProjection: vi.fn(async () => { current = undefined; return { outcome: "retried" as const }; }),
    markControlPlaneProjectionAttention: vi.fn(async () => { current = undefined; return { outcome: "attention" as const }; }),
  };
  const client = {
    reportRunnerReadinessControlV1: vi.fn(),
    projectWorkThreadRefControlV1: vi.fn(),
    projectCompletionContractRefControlV1: vi.fn(),
    projectCompletionAssessmentControlV1: vi.fn(),
    projectCallbackObservationControlV1: vi.fn(async (receipt) => ({ status: 201 as const, replayed: false as const, outcome: "accepted" as const, receipt })),
  } satisfies ControlProjectionClient;
  return { repo, client };
}

describe("Control V1 projection pump", () => {
  it("keeps raw executor progress and completion evidence out of Cloud lifecycle metadata", async () => {
    const secret = "ghp_secret /Users/alice/private/repo/src/token.ts";
    const progress = await buildHostedProgressMetadataForControlV1({
      at: now.toISOString(),
      message: secret,
      type: "tool_output",
    } as never);
    expect(progress.progressId).toMatch(/^progress_[0-9a-f]{64}$/u);
    expect(progress.progressDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const completion = await buildHostedCompletionMetadataForControlV1({
      conclusion: "failure",
      summary: secret,
      changedFiles: ["/Users/alice/private/repo/src/token.ts"],
      artifacts: [{ title: secret, uri: "local://artifact", summary: secret }],
      verification: [{ command: secret, outcome: "failed", excerpt: secret }],
    });
    expect(completion).toMatchObject({
      conclusion: "failure",
      reasonCode: "executor_failure",
    });
    expect(completion.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(completion.artifactDigests).toHaveLength(1);
    expect(completion.evidenceDigests).toHaveLength(1);
    const serialized = JSON.stringify({ progress, completion });
    expect(serialized).not.toContain("ghp_secret");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("local://artifact");
    for (const conclusion of [
      "success",
      "failure",
      "cancelled",
      "interrupted",
      "timed_out",
      "needs_human",
    ] as const) {
      const metadata = await buildHostedCompletionMetadataForControlV1({
        conclusion,
        summary: secret,
      });
      expect(metadata.reasonCode).toBe(`executor_${conclusion}`);
      expect(metadata.reasonCode).not.toMatch(
        /ghp_|sk_|raw-token|private-message|unknown_safe_failure/u,
      );
    }
  });

  it("accepts fresh readiness before a strict hosted claim and treats 204 as no work", async () => {
    const events: string[] = [];
    const context = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: "credential_1",
      registrationGeneration: 1,
      credentialGeneration: 1,
      capabilities: [
        "relay.claim-fence.v1",
        "relay.hosted-admission.v1",
        "relay.hosted-claim.v1",
        "relay.lifecycle.v1",
        "relay.readiness.v1",
      ] as const,
      targets: [],
      observedAt: now.toISOString(),
    };
    const client = {
      getRunnerControlContextV1: vi.fn(async () => {
        events.push("context");
        return context;
      }),
      reportRunnerReadinessControlV1: vi.fn(async (receipt) => {
        events.push("readiness");
        return { status: 201 as const, replayed: false as const, outcome: "accepted" as const, receipt };
      }),
      claimHostedRunControlV1: vi.fn()
        .mockImplementationOnce(async () => {
          events.push("claim");
          throw new Error("transport_outcome_unknown");
        })
        .mockImplementationOnce(async () => {
        events.push("claim");
        return null;
        }),
    } as never;
    let pending: { operationId: string; requestId: string; request: unknown } | null = null;
    const repo = {
      getHostedAssignedRunForRecovery: vi.fn(async () => null),
      getHostedClaimOperationForRetry: vi.fn(async () => pending),
      beginHostedClaimOperation: vi.fn(async ({ request }) => {
        events.push("journal");
        pending = {
          operationId: request.operationId,
          requestId: request.requestId,
          request,
        };
        return { outcome: "created" as const, operation: pending };
      }),
      acknowledgeHostedClaimEmpty: vi.fn(async () => {
        events.push("empty");
      }),
    } as never;
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "https://control.example",
        runnerToken: "runtime_secret",
        githubToken: "github_secret",
        repositories: [],
        agents: {},
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "paired",
          operationId: "pair_1",
          registration: {
            schemaVersion: 1,
            protocolVersion: "1.0",
            organizationId: "org_1",
            runnerId: "runner_1",
            credentialId: "credential_1",
            registrationGeneration: 1,
            credentialGeneration: 1,
            credentialPurpose: "runtime",
            createdAt: now.toISOString(),
          },
        },
      } as never,
      databasePath: ":memory:",
      executors: {},
      now: () => now,
      controlClient: client,
      governanceStore: { repo, close: vi.fn() },
      executeClaimedRunImpl: vi.fn() as never,
    });
    await expect(loop?.beforeIteration()).rejects.toThrow("transport_outcome_unknown");
    const firstRequest = (client.claimHostedRunControlV1 as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].request;
    await expect(loop?.beforeIteration()).resolves.toBe(false);
    const secondRequest = (client.claimHostedRunControlV1 as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].request;
    expect(events).toEqual([
      "context",
      "readiness",
      "journal",
      "claim",
      "context",
      "claim",
      "empty",
    ]);
    expect(firstRequest).toEqual(secondRequest);
    expect(client.reportRunnerReadinessControlV1).toHaveBeenCalledTimes(1);
    expect(repo.beginHostedClaimOperation).toHaveBeenCalledTimes(1);
    expect(repo.acknowledgeHostedClaimEmpty).toHaveBeenCalledTimes(1);
    await loop?.close();
  });

  it("replays an uncertain hosted heartbeat and renews again only from the accepted local lease", async () => {
    const repository = {
      provider: "github",
      owner: "acme",
      repo: "widget",
      checkoutPath: process.cwd(),
      defaultExecutor: "reviewer",
      baseBranch: "main",
      pushRemote: "origin",
      keepWorktree: "on_failure" as const,
    };
    const executor = {
      id: "reviewer",
      displayName: "Review Agent",
      capability: { id: "reviewer", protocol: "acp" },
      canRun: vi.fn(async () => ({ ready: true })),
    } as never;
    const context = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: "credential_1",
      registrationGeneration: 3,
      credentialGeneration: 2,
      capabilities: [
        "relay.claim-fence.v1",
        "relay.hosted-admission.v1",
        "relay.hosted-claim.v1",
        "relay.lifecycle.v1",
        "relay.readiness.v1",
      ] as const,
      targets: [{
        projectTargetId: "target_1",
        bindingDigest: `sha256:${"a".repeat(64)}`,
        provider: "github",
        owner: "acme",
        repo: "widget",
        defaultExecutor: "reviewer",
        defaultBranch: "main",
      }],
      observedAt: now.toISOString(),
    };
    const readiness = await buildRunnerReadinessReceipt({
      context,
      executors: { reviewer: executor },
      repositories: [repository],
      now: () => now,
    });
    const executorCapabilityDigest = readiness.payload.executors[0]
      ?.capabilityDigest;
    expect(executorCapabilityDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const lease = {
      attemptId: "attempt_1",
      fencingToken: `fence_${"f".repeat(64)}`,
    };
    let acceptedLeaseExpiresAt = "2026-08-09T00:01:00.000Z";
    let pending: { operationId: string; requestId: string; request: unknown }
      | null = null;
    const beginHostedHeartbeatOperation = vi.fn(async ({ request }) => {
      pending = {
        operationId: request.operationId,
        requestId: request.requestId,
        request,
      };
      return { outcome: "created" as const, operation: pending };
    });
    const applyHostedHeartbeatReceipt = vi.fn(async () => {
      acceptedLeaseExpiresAt = acceptedLeaseExpiresAt
        === "2026-08-09T00:01:00.000Z"
        ? "2026-08-09T00:02:00.000Z"
        : "2026-08-09T00:03:00.000Z";
      pending = null;
      return "accepted" as const;
    });
    const repo = {
      getHostedAssignedRunForRecovery: vi.fn(async () => ({
        claimed: {
          run: { id: "run_1" },
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
        },
        leaseExpiresAt: acceptedLeaseExpiresAt,
        hostedAuthority: {
          organizationId: "org_1",
          runnerId: "runner_1",
          runId: "run_1",
          credentialId: "credential_1",
          registrationGeneration: 3,
          credentialGeneration: 2,
          projectTargetId: "target_1",
          bindingId: "binding_1",
          targetBindingDigest: `sha256:${"a".repeat(64)}`,
          admissionPolicyReceiptId: "policy_receipt_1",
          admissionPolicySnapshotId: "policy_1",
          admissionPolicySnapshotDigest: `sha256:${"b".repeat(64)}`,
          runnerReadinessReceiptId: "readiness_1",
          runnerReadinessReceiptDigest: `sha256:${"c".repeat(64)}`,
          targetReadinessReceiptId: "readiness_1",
          targetReadinessReceiptDigest: `sha256:${"d".repeat(64)}`,
          executorId: "reviewer",
          executorCapabilityDigest,
          attemptId: lease.attemptId,
          attemptNumber: 1,
          epoch: 1,
          fencingTokenDigest: `sha256:${"e".repeat(64)}`,
          claimOperationId: "claim_operation_1",
          projectTargetVersion: 1,
          admissionPolicySnapshotVersion: 1,
          policyReceiptDigest: `sha256:${"f".repeat(64)}`,
        },
      })),
      acquireHostedExecutionStart: vi.fn(async () => true),
      isHostedExecutionCurrent: vi.fn(async () => true),
      getHostedExecutionLease: vi.fn(async () => ({
        leaseExpiresAt: acceptedLeaseExpiresAt,
      })),
      getHostedHeartbeatOperationForRetry: vi.fn(async () => pending),
      beginHostedHeartbeatOperation,
      applyHostedHeartbeatReceipt,
    } as never;
    const heartbeatHostedRunControlV1 = vi.fn()
      .mockRejectedValueOnce(new Error("transport_outcome_unknown"))
      .mockImplementation(async ({ request }) => ({
        status: 201 as const,
        replayed: false as const,
        outcome: "accepted" as const,
        receipt: { requestId: request.requestId },
      }));
    const executeClaimedRunImpl = vi.fn(async (execution) => {
      await expect(execution.client.heartbeat("run_1", lease)).rejects.toThrow(
        "transport_outcome_unknown",
      );
      await execution.client.heartbeat("run_1", lease);
      await execution.client.heartbeat("run_1", lease);
      await expect(
        execution.hostedExecutionAuthority?.readAcceptedLeaseExpiresAt?.(),
      ).resolves.toBe("2026-08-09T00:03:00.000Z");
      return true;
    });
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "https://control.example",
        runnerToken: "runtime_secret",
        repositories: [repository],
        agents: {},
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "paired",
          operationId: "pair_1",
          registration: {
            schemaVersion: 1,
            protocolVersion: "1.0",
            organizationId: "org_1",
            runnerId: "runner_1",
            credentialId: "credential_1",
            registrationGeneration: 3,
            credentialGeneration: 2,
            credentialPurpose: "runtime",
            createdAt: now.toISOString(),
          },
        },
      } as never,
      databasePath: ":memory:",
      executors: { reviewer: executor },
      now: () => now,
      controlClient: {
        getRunnerControlContextV1: vi.fn(async () => context),
        heartbeatHostedRunControlV1,
      } as never,
      governanceStore: { repo, close: vi.fn() },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
    });

    await expect(loop?.beforeIteration()).resolves.toBe(true);
    const requests = heartbeatHostedRunControlV1.mock.calls.map(
      ([call]) => call.request,
    );
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[2]).not.toEqual(requests[1]);
    expect(requests[0]?.expectedLeaseExpiresAt).toBe(
      "2026-08-09T00:01:00.000Z",
    );
    expect(requests[2]?.expectedLeaseExpiresAt).toBe(
      "2026-08-09T00:02:00.000Z",
    );
    expect(beginHostedHeartbeatOperation).toHaveBeenCalledTimes(2);
    expect(applyHostedHeartbeatReceipt).toHaveBeenCalledTimes(2);
    await loop?.close();
  });

  it("fails closed when Cloud context belongs to a different organization", () => {
    const context = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      organizationId: "org_cloud_other",
      runnerId: "runner_1",
      credentialId: "credential_1",
      registrationGeneration: 1,
      credentialGeneration: 1,
      capabilities: ["relay.readiness.v1"] as const,
      targets: [],
      observedAt: now.toISOString(),
    };
    const registration = {
      kind: "hosted_control_v1" as const,
      state: "paired" as const,
      operationId: "operation_1",
      registration: {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        organizationId: "org_locally_paired",
        runnerId: "runner_1",
        credentialId: "credential_1",
        registrationGeneration: 1,
        credentialGeneration: 1,
        credentialPurpose: "runtime" as const,
        createdAt: now.toISOString(),
      },
    };

    expect(() => assertRunnerControlContextRegistrationV1({
      context,
      registration,
    })).toThrow("runner_control_context_organization_mismatch");
  });

  it("rejects future and expired server context at the one-minute readiness boundary", () => {
    expect(isRunnerControlContextFreshV1(
      "2026-08-08T23:59:00.000Z",
      now,
    )).toBe(true);
    expect(isRunnerControlContextFreshV1(
      "2026-08-08T23:58:59.999Z",
      now,
    )).toBe(false);
    expect(isRunnerControlContextFreshV1(
      "2026-08-09T00:00:00.001Z",
      now,
    )).toBe(false);
  });

  it("builds readiness only from authoritative control context and public capability digests", async () => {
    const canRun = vi.fn(async () => ({ ready: true }));
    const receipt = await buildRunnerReadinessReceipt({
      context: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        contextKind: "runner_control",
        organizationId: "org_1",
        runnerId: "runner_1",
        credentialId: "credential_1",
        registrationGeneration: 1,
        credentialGeneration: 2,
        capabilities: ["relay.readiness.v1", "relay.work-thread-ref.v1"],
        targets: [{
          projectTargetId: "target_1",
          bindingDigest: `sha256:${"a".repeat(64)}`,
          provider: "github",
          owner: "acme",
          repo: "app",
          defaultExecutor: "echo",
          defaultBranch: "main",
        }],
        observedAt: now.toISOString(),
      },
      executors: {
        echo: {
          id: "echo",
          displayName: "Echo",
          capability: { id: "echo" },
          canRun,
        } as never,
      },
      repositories: [{
        provider: "github",
        owner: "acme",
        repo: "app",
        checkoutPath: process.cwd(),
        defaultExecutor: "echo",
        baseBranch: "main",
        pushRemote: "origin",
        keepWorktree: "on_failure",
      }],
      now: () => new Date("2026-08-09T00:01:00.000Z"),
    });
    expect(RunnerReadinessReceiptEnvelopeV1Schema.safeParse(receipt).success).toBe(true);
    expect(receipt).toMatchObject({
      organizationId: "org_1",
      producer: { id: "runner_1", credentialId: "credential_1", registrationGeneration: 1 },
      payload: {
        runnerId: "runner_1",
        targets: [{ projectTargetId: "target_1", state: "ready" }],
        observedAt: "2026-08-09T00:01:00.000Z",
        executors: [{ executorId: "echo", state: "ready" }],
      },
    });
    expect(canRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "control-v1-readiness",
      workspace: { kind: "repository", path: process.cwd() },
    }));
    expect(JSON.stringify(receipt)).not.toContain("runtime_secret");
    const unmatched = await buildRunnerReadinessReceipt({
      context: {
        ...receipt.payload,
        schemaVersion: 1,
        protocolVersion: "1.0",
        contextKind: "runner_control",
        organizationId: "org_1",
        credentialId: "credential_1",
        credentialGeneration: 2,
        targets: [{
          projectTargetId: "target_1",
          bindingDigest: `sha256:${"a".repeat(64)}`,
          provider: "github",
          owner: "acme",
          repo: "app",
          defaultExecutor: "codex",
          defaultBranch: "main",
        }],
      },
      executors: {},
      repositories: [{
        provider: "github",
        owner: "acme",
        repo: "app",
        checkoutPath: process.cwd(),
        defaultExecutor: "echo",
        baseBranch: "main",
        pushRemote: "origin",
        keepWorktree: "on_failure",
      }],
    });
    expect(unmatched.payload.targets).toEqual([{
      projectTargetId: "target_1",
      bindingDigest: `sha256:${"a".repeat(64)}`,
      state: "unknown",
      reasonCode: "target_binding_stale",
    }]);
    await expect(buildRunnerReadinessReceipt({
      context: { ...receipt.payload, schemaVersion: 1, protocolVersion: "1.0", contextKind: "runner_control", organizationId: "org_1", credentialId: "credential_1", credentialGeneration: 2, capabilities: [], targets: [], observedAt: now.toISOString() },
      executors: {},
      repositories: [],
    } as never)).rejects.toThrow("runner_control_context_missing_readiness_capability");
  });

  it("matches mixed-case GitHub identities but preserves non-GitHub case sensitivity", async () => {
    const baseContext = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: "credential_1",
      registrationGeneration: 1,
      credentialGeneration: 1,
      capabilities: ["relay.readiness.v1"] as const,
      observedAt: now.toISOString(),
    };
    const repository = {
      checkoutPath: process.cwd(),
      defaultExecutor: "echo",
      baseBranch: "main",
      pushRemote: "origin",
      keepWorktree: "on_failure" as const,
    };
    const executors = {
      echo: {
        id: "echo",
        displayName: "Echo",
        capability: { id: "echo" },
        canRun: vi.fn(async () => ({ ready: true })),
      } as never,
    };
    const target = {
      projectTargetId: "target_1",
      bindingDigest: `sha256:${"a".repeat(64)}`,
      defaultExecutor: "echo",
      defaultBranch: "main",
    };
    const github = await buildRunnerReadinessReceipt({
      context: {
        ...baseContext,
        targets: [{ ...target, provider: "github", owner: "acme", repo: "app" }],
      },
      executors,
      repositories: [{
        ...repository,
        provider: "GitHub",
        owner: "AcMe",
        repo: "App",
      }],
      now: () => now,
    });
    const gitlab = await buildRunnerReadinessReceipt({
      context: {
        ...baseContext,
        targets: [{ ...target, provider: "GitLab", owner: "AcMe", repo: "App" }],
      },
      executors,
      repositories: [{
        ...repository,
        provider: "GitLab",
        owner: "acme",
        repo: "App",
      }],
      now: () => now,
    });

    expect(github.payload.targets[0]?.state).toBe("ready");
    expect(gitlab.payload.targets[0]).toMatchObject({
      state: "unknown",
      reasonCode: "target_binding_stale",
    });
  });

  it("acks callback custody once and does not duplicate the provider observation on replay", async () => {
    const { repo, client } = harness(callbackEntry());
    const clock = vi.fn()
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(new Date("2026-08-09T00:01:00.000Z"))
      .mockReturnValue(now);
    const input = { repo, client, destinationId: "cloud", organizationId: "org_1", leaseOwner: "pump_1", now: clock };
    await expect(pumpControlPlaneProjections(input)).resolves.toEqual({ delivered: 1, retried: 0, attention: 0 });
    expect(repo.acknowledgeControlPlaneProjection).toHaveBeenCalledWith(expect.objectContaining({
      now: new Date("2026-08-09T00:01:00.000Z"),
    }));
    await expect(pumpControlPlaneProjections(input)).resolves.toEqual({ delivered: 0, retried: 0, attention: 0 });
    expect(client.projectCallbackObservationControlV1).toHaveBeenCalledTimes(1);
    expect(repo.acknowledgeControlPlaneProjection).toHaveBeenCalledTimes(1);
  });

  it("retries transport failures with bounded backoff and leaves no false acknowledgement", async () => {
    const { repo, client } = harness(callbackEntry());
    client.projectCallbackObservationControlV1.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }));
    const clock = vi.fn()
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(new Date("2026-08-09T00:00:05.000Z"));
    await expect(pumpControlPlaneProjections({ repo, client, destinationId: "cloud", organizationId: "org_1", leaseOwner: "pump_1", retryBaseMs: 2_000, now: clock }))
      .resolves.toEqual({ delivered: 0, retried: 1, attention: 0 });
    expect(repo.retryControlPlaneProjection).toHaveBeenCalledWith(expect.objectContaining({
      now: new Date("2026-08-09T00:00:05.000Z"),
      nextAttemptAt: "2026-08-09T00:00:07.000Z",
      reasonCode: "http_503",
    }));
    expect(repo.acknowledgeControlPlaneProjection).not.toHaveBeenCalled();
  });

  it("retries an explicitly classified status-zero transport failure", async () => {
    const { repo, client } = harness(callbackEntry());
    client.projectCallbackObservationControlV1.mockRejectedValueOnce(
      Object.assign(new Error("transport_failed"), { status: 0 }),
    );
    await expect(pumpControlPlaneProjections({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "pump_1",
      limit: 1,
      now: () => now,
    })).resolves.toEqual({ delivered: 0, retried: 1, attention: 0 });
    expect(repo.retryControlPlaneProjection).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "transport_failed" }),
    );
  });

  it("honors Retry-After when it exceeds exponential backoff", async () => {
    const { repo, client } = harness(callbackEntry());
    client.projectCallbackObservationControlV1.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { status: 429, retryAfterSeconds: 11 }),
    );
    await expect(pumpControlPlaneProjections({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "pump_1",
      retryBaseMs: 2_000,
      now: () => now,
    })).resolves.toEqual({ delivered: 0, retried: 1, attention: 0 });
    expect(repo.retryControlPlaneProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        nextAttemptAt: "2026-08-09T00:00:11.000Z",
        reasonCode: "http_429",
      }),
    );
  });

  it("sends an unexpected ordinary error to attention instead of retrying it as transport", async () => {
    const { repo, client } = harness(callbackEntry());
    client.projectCallbackObservationControlV1.mockRejectedValueOnce(new Error("adapter_bug"));
    await expect(pumpControlPlaneProjections({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "pump_1",
      now: () => now,
    })).resolves.toEqual({ delivered: 0, retried: 0, attention: 1 });
    expect(repo.retryControlPlaneProjection).not.toHaveBeenCalled();
    expect(repo.markControlPlaneProjectionAttention).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "unexpected_error" }),
    );
  });

  it("claims each projection independently after a slow first transfer", async () => {
    const first = callbackEntry();
    const second = {
      ...callbackEntry(),
      receiptId: "receipt_callback_2",
      leaseToken: "lease_2",
      leaseExpiresAt: "2026-08-09T00:02:10.000Z",
    };
    const queue = [first, second];
    const repo: ControlProjectionRepository = {
      recoverExpiredControlPlaneProjectionLeases: vi.fn(async () => ({ recovered: 0 })),
      claimDueControlPlaneProjections: vi.fn(async () => ({ entries: queue.length ? [queue[0]!] : [] })),
      acknowledgeControlPlaneProjection: vi.fn(async () => { queue.shift(); return { outcome: "acknowledged" as const }; }),
      retryControlPlaneProjection: vi.fn(async () => ({ outcome: "retried" as const })),
      markControlPlaneProjectionAttention: vi.fn(async () => ({ outcome: "attention" as const })),
    };
    const client = harness(callbackEntry()).client;
    const clock = vi.fn()
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(new Date("2026-08-09T00:00:40.000Z"))
      .mockReturnValueOnce(new Date("2026-08-09T00:00:40.000Z"))
      .mockReturnValueOnce(new Date("2026-08-09T00:00:40.000Z"))
      .mockReturnValueOnce(new Date("2026-08-09T00:00:41.000Z"));
    await expect(pumpControlPlaneProjections({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "pump_1",
      limit: 2,
      now: clock,
    })).resolves.toEqual({ delivered: 2, retried: 0, attention: 0 });
    expect(repo.claimDueControlPlaneProjections).toHaveBeenCalledTimes(2);
    expect(repo.claimDueControlPlaneProjections).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ limit: 1, leaseSeconds: 90, now }),
    );
    expect(repo.claimDueControlPlaneProjections).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        limit: 1,
        now: new Date("2026-08-09T00:00:40.000Z"),
      }),
    );
  });

  it("does not send when the remaining lease cannot cover the transfer window", async () => {
    const entry = { ...callbackEntry(), leaseExpiresAt: "2026-08-09T00:00:34.999Z" };
    const { repo, client } = harness(entry);
    await expect(pumpControlPlaneProjections({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "pump_1",
      limit: 1,
      now: () => now,
    })).resolves.toEqual({ delivered: 0, retried: 1, attention: 0 });
    expect(client.projectCallbackObservationControlV1).not.toHaveBeenCalled();
    expect(repo.retryControlPlaneProjection).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "lease_window_insufficient" }),
    );
  });

  it("does not count a slow delivery as acknowledged after its lease becomes stale", async () => {
    const { repo, client } = harness(callbackEntry());
    vi.mocked(repo.acknowledgeControlPlaneProjection).mockResolvedValueOnce({
      outcome: "stale_lease",
    });
    const clock = vi.fn()
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(new Date("2026-08-09T00:00:31.000Z"));
    await expect(pumpControlPlaneProjections({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "pump_1",
      limit: 1,
      now: clock,
    })).resolves.toEqual({ delivered: 0, retried: 0, attention: 0 });
    expect(repo.acknowledgeControlPlaneProjection).toHaveBeenCalledWith(
      expect.objectContaining({ now: new Date("2026-08-09T00:00:31.000Z") }),
    );
  });

  it("normalizes an omitted local branch to null and caches deep readiness probes within TTL", async () => {
    const canRun = vi.fn(async () => ({ ready: true }));
    const cache = new Map();
    const context = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: "credential_1",
      registrationGeneration: 1,
      credentialGeneration: 1,
      capabilities: ["relay.readiness.v1"] as const,
      targets: [{
        projectTargetId: "target_1",
        bindingDigest: `sha256:${"a".repeat(64)}`,
        provider: "github",
        owner: "acme",
        repo: "app",
        defaultExecutor: "echo",
        defaultBranch: null,
      }],
      observedAt: now.toISOString(),
    };
    const common = {
      executors: {
        echo: {
          id: "echo",
          displayName: "Echo",
          capability: { id: "echo" },
          canRun,
        } as never,
      },
      repositories: [{
        provider: "github",
        owner: "acme",
        repo: "app",
        checkoutPath: process.cwd(),
        defaultExecutor: "echo",
      }],
      readinessProbeCache: cache,
      ttlMs: 60_000,
    };
    const first = await buildRunnerReadinessReceipt({
      ...common,
      context,
      now: () => now,
    });
    const second = await buildRunnerReadinessReceipt({
      ...common,
      context: { ...context, observedAt: "2026-08-09T00:00:10.000Z" },
      now: () => new Date("2026-08-09T00:00:20.000Z"),
    });
    expect(first.payload.targets[0]?.state).toBe("ready");
    expect(second.payload.targets[0]?.state).toBe("ready");
    expect(canRun).toHaveBeenCalledTimes(1);
  });

  it("runs only the Control V1 sidecar and never calls the legacy claim path", async () => {
    const abort = new AbortController();
    const events: string[] = [];
    const client = {
      claim: vi.fn(async () => null),
    } as unknown as DaemonClient;
    await serveDaemon({
      mode: "control-v1-sidecar",
      pollIntervalMs: 1,
      signal: abort.signal,
      controlLoop: {
        beforeIteration: async () => { events.push("before"); abort.abort(); return true; },
        afterIteration: async () => { events.push("after"); },
        abort: () => { events.push("abort"); },
        close: async () => { events.push("close"); },
      },
    });
    expect(events).toEqual(["before", "abort", "after", "close"]);
    expect(client.claim).not.toHaveBeenCalled();
  });

  it("keeps the legacy daemon claim path when Control V1 is absent", async () => {
    const abort = new AbortController();
    const client = {
      claim: vi.fn(async () => { abort.abort(); return null; }),
    } as unknown as DaemonClient;
    await serveDaemon({
      mode: "legacy",
      runnerId: "runner_legacy",
      repositories: [],
      executors: {},
      pollIntervalMs: 1,
      signal: abort.signal,
      client,
    });
    expect(client.claim).toHaveBeenCalledTimes(1);
  });
});
