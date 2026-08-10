import { describe, expect, it, vi } from "vitest";
import { buildHostedLifecycleRequestV1, computeHostedAdmissionEnvelopeDigestV1, computeHostedClaimFencingTokenDigestV1, HostedCompleteRequestV1Schema, RunnerReadinessReceiptEnvelopeV1Schema, type HostedClaimRequestV1 } from "@opentag/core";
import { serveDaemon, type DaemonClient } from "../src/daemon.js";
import { assertHostedClaimCurrentAuthorityV1, assertRunnerControlContextRegistrationV1, buildHostedClaimRequestV1, buildHostedCompletionMetadataForControlV1, buildHostedProgressMetadataForControlV1, buildRunnerReadinessReceipt, createHostedControlLoop, hasSameRunnerReadinessAuthorityV1, isRunnerControlContextFreshV1, pumpControlPlaneProjections, pumpHostedLifecycleOperations, runnerReadinessReuseWindowV1, type ControlPlaneProjectionOutboxEntry, type ControlProjectionClient, type ControlProjectionRepository, type HostedLifecycleOperationEntry, type HostedLifecycleRepository } from "../src/control-v1.js";

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

function completionEvidenceEntry(): ControlPlaneProjectionOutboxEntry {
  const authorityDigest = `sha256:${"a".repeat(64)}`;
  const contractReceiptDigest = `sha256:${"e".repeat(64)}`;
  const payloadDigest = `sha256:${"c".repeat(64)}`;
  const receiptDigest = `sha256:${"d".repeat(64)}`;
  return {
    receiptId: "completion_evidence_receipt_1",
    destinationId: "cloud",
    organizationId: "org_1",
    runId: "run_1",
    workThreadId: "work_thread_1",
    receiptKind: "completion_evidence_observation",
    identity: {
      namespace:
        "opentag.control.receipt/completion-evidence-observation/v1",
      parts: [
        "org_1",
        "work_thread_1",
        "run_1",
        "human_escalation",
        "escalation_1",
        authorityDigest,
        contractReceiptDigest,
      ],
      key: "identity",
    },
    operationId: "completion_evidence_operation_1",
    payloadDigest,
    receiptDigest,
    envelope: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      receiptKind: "completion_evidence_observation",
      receiptId: "completion_evidence_receipt_1",
      organizationId: "org_1",
      operationId: "completion_evidence_operation_1",
      requiredCapabilities: ["relay.completion-evidence.v1"],
      producer: {
        kind: "local_opentag",
        id: "runner_1",
        credentialId: "runtime_credential_1",
        registrationGeneration: 1,
      },
      identity: {
        namespace:
          "opentag.control.receipt/completion-evidence-observation/v1",
        parts: [
          "org_1",
          "work_thread_1",
          "run_1",
          "human_escalation",
          "escalation_1",
          authorityDigest,
          contractReceiptDigest,
        ],
      },
      predecessorReceiptDigests: [contractReceiptDigest],
      observedAt: now.toISOString(),
      payloadDigest,
      receiptDigest,
      runId: "run_1",
      workThreadId: "work_thread_1",
      attempt: {
        attemptId: "attempt_1",
        attemptNumber: 1,
        epoch: 1,
        fencingTokenDigest: `sha256:${"b".repeat(64)}`,
      },
      payload: {
        evidenceType: "human_escalation",
        evidenceId: "escalation_1",
        authorityDigest,
        class: "human_acceptance_missing",
        state: "open",
        blocking: true,
        reasonDigest: `sha256:${"b".repeat(64)}`,
        observedAt: now.toISOString(),
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
    projectCompletionEvidenceControlV1: vi.fn(async (receipt) => ({ status: 201 as const, replayed: false as const, outcome: "accepted" as const, receipt })),
    projectCallbackObservationControlV1: vi.fn(async (receipt) => ({ status: 201 as const, replayed: false as const, outcome: "accepted" as const, receipt })),
  } satisfies ControlProjectionClient;
  return { repo, client };
}

function memoryProjectionRepository() {
  const entries = new Map<string, ControlPlaneProjectionOutboxEntry>();
  return {
    enqueueControlPlaneProjection: vi.fn(async ({ envelope, now: enqueuedAt }) => {
      const readiness = RunnerReadinessReceiptEnvelopeV1Schema.parse(envelope);
      const existing = entries.get(readiness.receiptId);
      if (existing) return { outcome: "replay" as const, entry: existing };
      const at = (enqueuedAt ?? now).toISOString();
      const entry: ControlPlaneProjectionOutboxEntry = {
        receiptId: readiness.receiptId,
        destinationId: "cloud",
        organizationId: readiness.organizationId,
        runnerId: readiness.payload.runnerId,
        receiptKind: "runner_readiness",
        identity: {
          namespace: readiness.identity.namespace,
          parts: [...readiness.identity.parts],
          key: `key_${readiness.receiptId}`,
        },
        operationId: readiness.operationId,
        payloadDigest: readiness.payloadDigest,
        receiptDigest: readiness.receiptDigest,
        envelope: readiness,
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      };
      entries.set(entry.receiptId, entry);
      return { outcome: "created" as const, entry };
    }),
    getControlPlaneProjection: vi.fn(async ({ receiptId }) =>
      entries.get(receiptId) ?? null),
    getLatestRunnerReadinessProjection: vi.fn(async () =>
      [...entries.values()].sort((left, right) =>
        right.envelope.payload.observedAt.localeCompare(
          left.envelope.payload.observedAt,
        )
      )[0] ?? null),
    recoverExpiredControlPlaneProjectionLeases: vi.fn(async () => ({
      recovered: 0,
      entries: [],
    })),
    claimDueControlPlaneProjections: vi.fn(async () => {
      const entry = [...entries.values()].find(
        (candidate) => candidate.state === "pending",
      );
      if (!entry) return { entries: [] };
      Object.assign(entry, {
        state: "leased" as const,
        attemptCount: entry.attemptCount + 1,
        leaseOwner: "runner_runner_1",
        leaseToken: `lease_${entry.attemptCount + 1}`,
        leaseExpiresAt: "2026-08-09T00:01:30.000Z",
      });
      return { entries: [entry] };
    }),
    acknowledgeControlPlaneProjection: vi.fn(async ({ receiptId }) => {
      const entry = entries.get(receiptId);
      if (!entry) return { outcome: "not_found" as const };
      Object.assign(entry, { state: "acknowledged" as const });
      return { outcome: "acknowledged" as const };
    }),
    retryControlPlaneProjection: vi.fn(async ({ receiptId }) => {
      const entry = entries.get(receiptId);
      if (!entry) return { outcome: "not_found" as const };
      Object.assign(entry, { state: "pending" as const });
      return { outcome: "retried" as const };
    }),
    markControlPlaneProjectionAttention: vi.fn(async ({ receiptId }) => {
      const entry = entries.get(receiptId);
      if (!entry) return { outcome: "not_found" as const };
      Object.assign(entry, { state: "attention" as const });
      return { outcome: "attention" as const };
    }),
  };
}

function emptyLifecycleRepository() {
  return {
    ...memoryProjectionRepository(),
    getHostedPreImportAuthorityRecovery: vi.fn(async () => null),
    getHostedClaimOperationForRetry: vi.fn(async () => null),
    recoverExpiredHostedLifecycleOperations: vi.fn(async () => 0),
    claimDueHostedLifecycleOperations: vi.fn(async () => []),
    acknowledgeHostedLifecycleOperation: vi.fn(async () => "acknowledged" as const),
    retryHostedLifecycleOperation: vi.fn(async () => "retried" as const),
    markHostedLifecycleOperationAttention: vi.fn(async () => "attention" as const),
  };
}

async function validHostedClaim(input: {
  request: HostedClaimRequestV1;
  executorCapabilityDigest: string;
}) {
  const admissionBase = {
    kind: "hosted_admission" as const,
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.hosted-admission.v1"] as const,
    admissionId: "admission_1",
    operationId: "admission_operation_1",
    organizationId: "org_1",
    bindingId: "binding_1",
    bindingSecretVersion: "secret_v1",
    provider: "github" as const,
    deliveryId: "delivery_1",
    deliveryPayloadDigest: `sha256:${"b".repeat(64)}`,
    sourceIdentityDigest: `sha256:${"c".repeat(64)}`,
    eventName: "issue_comment" as const,
    action: "created" as const,
    repository: {
      providerRepositoryId: "123",
      owner: "acme",
      repo: "widget",
    },
    sourceThread: {
      kind: "issue" as const,
      providerThreadId: "456",
      number: 42,
    },
    sourceEvent: {
      providerEventId: "789",
      kind: "issue_comment" as const,
    },
    verifiedActor: {
      providerUserId: "1001",
      login: "octocat",
      authorization: {
        decision: "allowed" as const,
        grantRef: "grant_1",
        grantVersion: 1,
        grantDigest: `sha256:${"d".repeat(64)}`,
      },
    },
    projectTarget: {
      projectTargetId: "target_1",
      version: 1,
      digest: `sha256:${"a".repeat(64)}`,
    },
    runnerId: "runner_1",
    admissionPolicySnapshot: {
      snapshotId: "policy_1",
      digest: `sha256:${"e".repeat(64)}`,
    },
    receivedAt: now.toISOString(),
    envelopeDigest: `sha256:${"0".repeat(64)}`,
  };
  const fencingToken = `fence_${"f".repeat(64)}`;
  return {
    kind: "hosted_claim" as const,
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: [
      "relay.claim-fence.v1",
      "relay.hosted-admission.v1",
      "relay.hosted-claim.v1",
      "relay.lifecycle.v1",
      "relay.readiness.v1",
    ] as const,
    requestId: input.request.requestId,
    operationId: input.request.operationId,
    organizationId: "org_1",
    runnerId: "runner_1",
    runId: "run_1",
    executorId: "reviewer",
    hostedAdmission: {
      ...admissionBase,
      envelopeDigest:
        await computeHostedAdmissionEnvelopeDigestV1(admissionBase),
    },
    admissionPolicySnapshot: {
      payload: { snapshotId: "policy_1" },
      receiptDigest: `sha256:${"e".repeat(64)}`,
    },
    attempt: {
      id: "attempt_1",
      number: 1,
      epoch: 1,
      fencingToken,
      fencingTokenDigest:
        await computeHostedClaimFencingTokenDigestV1(fencingToken),
      leaseExpiresAt: "2026-08-09T00:05:00.000Z",
    },
    authority: {
      organizationId: "org_1",
      runnerId: "runner_1",
      runId: "run_1",
      credentialId: "credential_1",
      registrationGeneration: 1,
      credentialGeneration: 1,
      projectTargetId: "target_1",
      targetBindingDigest: `sha256:${"a".repeat(64)}`,
      executorId: "reviewer",
      executorCapabilityDigest: input.executorCapabilityDigest,
      runnerReadinessReceiptId:
        input.request.expectedAuthority.runnerReadinessReceiptId,
      runnerReadinessReceiptDigest:
        input.request.expectedAuthority.runnerReadinessReceiptDigest,
    },
  };
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

  it("replays the exact hosted lifecycle request after an uncertain response", async () => {
    const result = { conclusion: "success" as const, summary: "done" };
    const metadata = await buildHostedCompletionMetadataForControlV1(result);
    const request = HostedCompleteRequestV1Schema.parse(
      await buildHostedLifecycleRequestV1({
        action: "complete",
        organizationId: "org_1",
        runnerId: "runner_1",
        runId: "run_1",
        attempt: {
          attemptId: "attempt_1",
          attemptNumber: 1,
          epoch: 1,
          fencingToken: `fence_${"f".repeat(64)}`,
          fencingTokenDigest: `sha256:${"e".repeat(64)}`,
        },
        occurredAt: now.toISOString(),
        ...metadata,
      }),
    );
    let state: "pending" | "acknowledged" = "pending";
    let nextAttemptAt = now.toISOString();
    let leaseSequence = 0;
    const repo: HostedLifecycleRepository = {
      recoverExpiredHostedLifecycleOperations: vi.fn(async () => 0),
      claimDueHostedLifecycleOperations: vi.fn(async ({ now: claimedAt }) => {
        if (
          state !== "pending"
          || Date.parse(nextAttemptAt) > (claimedAt ?? now).getTime()
        ) return [];
        leaseSequence += 1;
        return [{
          destinationId: "cloud",
          organizationId: "org_1",
          runnerId: "runner_1",
          credentialId: "credential_1",
          operationId: request.operationId,
          requestId: request.requestId,
          action: "complete",
          runId: "run_1",
          request,
          state: "leased",
          attemptCount: leaseSequence,
          leaseToken: `lease_${leaseSequence}`,
        }];
      }),
      acknowledgeHostedLifecycleOperation: vi.fn(async () => {
        state = "acknowledged";
        return "acknowledged" as const;
      }),
      retryHostedLifecycleOperation: vi.fn(async ({ nextAttemptAt: retryAt }) => {
        nextAttemptAt = retryAt;
        return "retried" as const;
      }),
      markHostedLifecycleOperationAttention: vi.fn(async () => "attention" as const),
    };
    const completeHostedRunControlV1 = vi.fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce({
        status: 200,
        replayed: true,
        outcome: "accepted",
        receipt: { receiptId: "receipt_1" },
      });
    const client = { completeHostedRunControlV1 } as never;

    await expect(pumpHostedLifecycleOperations({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "runner_1",
      limit: 1,
      now: () => now,
    })).resolves.toEqual({ delivered: 0, retried: 1, attention: 0 });
    await expect(pumpHostedLifecycleOperations({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "runner_1",
      limit: 1,
      now: () => new Date("2026-08-09T00:00:01.000Z"),
    })).resolves.toEqual({ delivered: 1, retried: 0, attention: 0 });

    const requests = completeHostedRunControlV1.mock.calls.map(
      ([call]) => call.request,
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(repo.retryHostedLifecycleOperation).toHaveBeenCalledTimes(1);
    expect(repo.acknowledgeHostedLifecycleOperation).toHaveBeenCalledTimes(1);
    expect(state).toBe("acknowledged");
  });

  it("performs no lifecycle repository or provider work after cancellation", async () => {
    const request = HostedCompleteRequestV1Schema.parse(
      await buildHostedLifecycleRequestV1({
        action: "complete",
        organizationId: "org_1",
        runnerId: "runner_1",
        runId: "run_1",
        attempt: {
          attemptId: "attempt_1",
          attemptNumber: 1,
          epoch: 1,
          fencingToken: `fence_${"f".repeat(64)}`,
          fencingTokenDigest: `sha256:${"e".repeat(64)}`,
        },
        occurredAt: now.toISOString(),
        ...await buildHostedCompletionMetadataForControlV1({
          conclusion: "success",
          summary: "done",
        }),
      }),
    );
    const provider = vi.fn();
    const initiallyCancelledRepo = emptyLifecycleRepository();
    await expect(pumpHostedLifecycleOperations({
      repo: initiallyCancelledRepo,
      client: { completeHostedRunControlV1: provider } as never,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "runner_1",
      cancelled: () => true,
    })).resolves.toEqual({ delivered: 0, retried: 0, attention: 0 });
    expect(
      initiallyCancelledRepo.recoverExpiredHostedLifecycleOperations,
    ).not.toHaveBeenCalled();
    expect(
      initiallyCancelledRepo.claimDueHostedLifecycleOperations,
    ).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();

    let cancelled = false;
    const claimAfterCancellationRepo = {
      ...emptyLifecycleRepository(),
      claimDueHostedLifecycleOperations: vi.fn(async () => {
        cancelled = true;
        return [{
          destinationId: "cloud",
          organizationId: "org_1",
          runnerId: "runner_1",
          credentialId: "credential_1",
          operationId: request.operationId,
          requestId: request.requestId,
          action: "complete" as const,
          runId: "run_1",
          request,
          state: "leased" as const,
          attemptCount: 1,
          leaseToken: "lease_1",
        }];
      }),
    };
    await expect(pumpHostedLifecycleOperations({
      repo: claimAfterCancellationRepo,
      client: { completeHostedRunControlV1: provider } as never,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "runner_1",
      cancelled: () => cancelled,
    })).resolves.toEqual({ delivered: 0, retried: 0, attention: 0 });
    expect(
      claimAfterCancellationRepo.claimDueHostedLifecycleOperations,
    ).toHaveBeenCalledTimes(1);
    expect(provider).not.toHaveBeenCalled();
    expect(
      claimAfterCancellationRepo.acknowledgeHostedLifecycleOperation,
    ).not.toHaveBeenCalled();
  });

  it("keeps progress and completion behind an unacknowledged running operation", async () => {
    const attempt = {
      attemptId: "attempt_1",
      attemptNumber: 1,
      epoch: 1,
      fencingToken: `fence_${"f".repeat(64)}`,
      fencingTokenDigest: `sha256:${"e".repeat(64)}`,
    };
    const common = {
      organizationId: "org_1",
      runnerId: "runner_1",
      runId: "run_1",
      attempt,
    };
    const running = await buildHostedLifecycleRequestV1({
      ...common,
      action: "running",
      occurredAt: now.toISOString(),
      executorId: "reviewer",
      executorCapabilityDigest: `sha256:${"a".repeat(64)}`,
    });
    const progressMetadata = await buildHostedProgressMetadataForControlV1({
      at: "2026-08-09T00:00:01.000Z",
    });
    const progress = await buildHostedLifecycleRequestV1({
      ...common,
      action: "progress",
      occurredAt: "2026-08-09T00:00:01.000Z",
      ...progressMetadata,
    });
    const completionResult = {
      conclusion: "success" as const,
      summary: "done",
    };
    const complete = await buildHostedLifecycleRequestV1({
      ...common,
      action: "complete",
      occurredAt: "2026-08-09T00:00:02.000Z",
      ...await buildHostedCompletionMetadataForControlV1(completionResult),
    });
    const entries = [
      { action: "running" as const, request: running },
      { action: "progress" as const, request: progress },
      { action: "complete" as const, request: complete },
    ].map(({ action, request }) => ({
      destinationId: "cloud",
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: "credential_1",
      operationId: request.operationId,
      requestId: request.requestId,
      action,
      runId: "run_1",
      request,
      state: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: now.toISOString(),
    }));
    const repo: HostedLifecycleRepository = {
      recoverExpiredHostedLifecycleOperations: vi.fn(async () => 0),
      claimDueHostedLifecycleOperations: vi.fn(async ({ now: claimedAt }) => {
        const index = entries.findIndex((entry, candidateIndex) =>
          entry.state === "pending"
          && Date.parse(entry.nextAttemptAt) <= (claimedAt ?? now).getTime()
          && entries.slice(0, candidateIndex).every(
            (predecessor) => predecessor.state === "acknowledged",
          )
        );
        if (index < 0) return [];
        const entry = entries[index]!;
        entry.state = "leased";
        entry.attemptCount += 1;
        return [{
          ...entry,
          leaseToken: `lease_${entry.attemptCount}`,
        }] as HostedLifecycleOperationEntry[];
      }),
      acknowledgeHostedLifecycleOperation: vi.fn(async ({ operationId }) => {
        const entry = entries.find((candidate) =>
          candidate.operationId === operationId
        );
        if (entry) entry.state = "acknowledged";
        return "acknowledged" as const;
      }),
      retryHostedLifecycleOperation: vi.fn(async ({
        operationId,
        nextAttemptAt,
      }) => {
        const entry = entries.find((candidate) =>
          candidate.operationId === operationId
        );
        if (entry) {
          entry.state = "pending";
          entry.nextAttemptAt = nextAttemptAt;
        }
        return "retried" as const;
      }),
      markHostedLifecycleOperationAttention: vi.fn(
        async () => "attention" as const,
      ),
    };
    const markHostedRunRunningControlV1 = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("unavailable"), {
        status: 503,
      }))
      .mockResolvedValueOnce({ receipt: { receiptId: "running_receipt" } });
    const progressHostedRunControlV1 = vi.fn(async () => ({
      receipt: { receiptId: "progress_receipt" },
    }));
    const completeHostedRunControlV1 = vi.fn(async () => ({
      receipt: { receiptId: "complete_receipt" },
    }));
    const client = {
      markHostedRunRunningControlV1,
      progressHostedRunControlV1,
      completeHostedRunControlV1,
    } as never;

    await expect(pumpHostedLifecycleOperations({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "runner_1",
      now: () => now,
    })).resolves.toEqual({ delivered: 0, retried: 1, attention: 0 });
    expect(progressHostedRunControlV1).not.toHaveBeenCalled();
    expect(completeHostedRunControlV1).not.toHaveBeenCalled();

    await expect(pumpHostedLifecycleOperations({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "runner_1",
      now: () => new Date("2026-08-09T00:00:01.000Z"),
    })).resolves.toEqual({ delivered: 3, retried: 0, attention: 0 });
    expect(entries.map((entry) => entry.state)).toEqual([
      "acknowledged",
      "acknowledged",
      "acknowledged",
    ]);
    expect(progressHostedRunControlV1).toHaveBeenCalledTimes(1);
    expect(completeHostedRunControlV1).toHaveBeenCalledTimes(1);
  });

  it("commits completion locally during outage and replays it before a restart can claim work", async () => {
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
      registrationGeneration: 1,
      credentialGeneration: 1,
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
    const lease = {
      attemptId: "attempt_1",
      fencingToken: `fence_${"f".repeat(64)}`,
    };
    let terminal = false;
    let journal: HostedLifecycleOperationEntry | undefined;
    let acknowledgedRunning: HostedLifecycleOperationEntry | undefined;
    let nextAttemptAt = now.toISOString();
    let leaseCount = 0;
    const projectionNoops = memoryProjectionRepository();
    const repo = {
      ...projectionNoops,
      getHostedPreImportAuthorityRecovery: vi.fn(async () => null),
      recoverExpiredHostedLifecycleOperations: vi.fn(async () => 0),
      claimDueHostedLifecycleOperations: vi.fn(async ({ now: claimedAt }) => {
        if (!journal || Date.parse(nextAttemptAt) > claimedAt.getTime()) return [];
        leaseCount += 1;
        journal = {
          ...journal,
          state: "leased",
          attemptCount: leaseCount,
          leaseToken: `lease_${leaseCount}`,
        };
        return [journal];
      }),
      acknowledgeHostedLifecycleOperation: vi.fn(async () => {
        if (journal?.action === "running") {
          acknowledgedRunning = { ...journal, state: "acknowledged" };
        }
        journal = undefined;
        return "acknowledged" as const;
      }),
      retryHostedLifecycleOperation: vi.fn(async ({ nextAttemptAt: retryAt }) => {
        nextAttemptAt = retryAt;
        if (journal) journal = { ...journal, state: "pending", leaseToken: undefined };
        return "retried" as const;
      }),
      markHostedLifecycleOperationAttention: vi.fn(async () => "attention" as const),
      getHostedAssignedRunForRecovery: vi.fn(async () => terminal ? null : ({
        claimed: {
          run: { id: "run_1" },
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
        },
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
        hostedAuthority: {
          organizationId: "org_1",
          runnerId: "runner_1",
          runId: "run_1",
          credentialId: "credential_1",
          registrationGeneration: 1,
          credentialGeneration: 1,
          projectTargetId: "target_1",
          targetBindingDigest: `sha256:${"a".repeat(64)}`,
          executorId: "reviewer",
          executorCapabilityDigest: readiness.payload.executors[0]?.capabilityDigest,
          attemptId: "attempt_1",
          attemptNumber: 1,
          epoch: 1,
          fencingTokenDigest: `sha256:${"e".repeat(64)}`,
          admissionPolicySnapshotId: "policy_1",
          policyReceiptDigest: `sha256:${"b".repeat(64)}`,
          importedAt: now.toISOString(),
        },
      })),
      markHostedRunRunningLocally: vi.fn(async ({ request }) => {
        if (acknowledgedRunning) {
          return {
            outcome: "duplicate" as const,
            operation: acknowledgedRunning,
          };
        }
        if (!journal) {
          journal = {
            destinationId: "cloud",
            organizationId: "org_1",
            runnerId: "runner_1",
            credentialId: "credential_1",
            operationId: request.operationId,
            requestId: request.requestId,
            action: "running",
            runId: "run_1",
            request,
            state: "pending",
            attemptCount: 0,
          };
          return { outcome: "running" as const, operation: journal };
        }
        return { outcome: "duplicate" as const, operation: journal };
      }),
      acquireHostedExecutionStart: vi.fn(async () => true),
      isHostedExecutionCurrent: vi.fn(async () => true),
      getHostedExecutionLease: vi.fn(async () => ({
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
      })),
      completeHostedRunLocally: vi.fn(async ({ request }) => {
        terminal = true;
        journal = {
          destinationId: "cloud",
          organizationId: "org_1",
          runnerId: "runner_1",
          credentialId: "credential_1",
          operationId: request.operationId,
          requestId: request.requestId,
          action: "complete",
          runId: "run_1",
          request,
          state: "pending",
          attemptCount: 0,
        };
        return "completed" as const;
      }),
      getHostedClaimOperationForRetry: vi.fn(async () => null),
      beginHostedClaimOperation: vi.fn(async ({ request }) => ({
        outcome: "created" as const,
        operation: { operationId: request.operationId, requestId: request.requestId, request },
      })),
      acknowledgeHostedClaimEmpty: vi.fn(async () => undefined),
    } as never;
    const completeHostedRunControlV1 = vi.fn()
      .mockRejectedValueOnce(new TypeError("cloud offline"))
      .mockResolvedValueOnce({
        status: 200,
        replayed: true,
        outcome: "accepted",
        receipt: { receiptId: "receipt_1" },
      });
    const markHostedRunRunningControlV1 = vi.fn(async () => ({
      status: 201,
      replayed: false,
      outcome: "accepted",
      receipt: { receiptId: "receipt_running_1" },
    }));
    const executeClaimedRunImpl = vi.fn(async (execution) => {
      await execution.client.markRunning(
        "run_1",
        "reviewer",
        lease,
        { executorCapability: executor.capability },
      );
      await execution.client.complete("run_1", lease, {
        conclusion: "success",
        summary: "done",
      });
      return true;
    });
    const config = {
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
          registrationGeneration: 1,
          credentialGeneration: 1,
          credentialPurpose: "runtime",
          createdAt: now.toISOString(),
        },
      },
    } as never;
    const client = {
      getRunnerControlContextV1: vi.fn(async () => context),
      markHostedRunRunningControlV1,
      completeHostedRunControlV1,
      reportRunnerReadinessControlV1: vi.fn(async (receipt) => ({
        status: 201,
        replayed: false,
        outcome: "accepted",
        receipt,
      })),
      claimHostedRunControlV1: vi.fn(async () => null),
    } as never;
    const first = createHostedControlLoop({
      config,
      databasePath: ":memory:",
      executors: { reviewer: executor },
      now: () => now,
      controlClient: client,
      governanceStore: { repo, close: vi.fn() },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
    });

    await expect(first?.beforeIteration()).resolves.toBe(true);
    expect(terminal).toBe(true);
    expect(journal?.state).toBe("pending");
    expect(completeHostedRunControlV1).not.toHaveBeenCalled();
    await expect(first?.afterIteration()).resolves.toBeUndefined();
    expect(journal?.state).toBe("pending");
    expect(executeClaimedRunImpl).toHaveBeenCalledTimes(1);
    await first?.close();

    const restartNow = new Date("2026-08-09T00:00:02.000Z");
    const restarted = createHostedControlLoop({
      config,
      databasePath: ":memory:",
      executors: { reviewer: executor },
      now: () => restartNow,
      controlClient: client,
      governanceStore: { repo, close: vi.fn() },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
    });
    await expect(restarted?.beforeIteration()).resolves.toBe(false);

    expect(journal).toBeUndefined();
    expect(completeHostedRunControlV1).toHaveBeenCalledTimes(2);
    expect(completeHostedRunControlV1.mock.calls[1]?.[0].request)
      .toEqual(completeHostedRunControlV1.mock.calls[0]?.[0].request);
    expect(executeClaimedRunImpl).toHaveBeenCalledTimes(1);
    expect(repo.acknowledgeHostedLifecycleOperation).toHaveBeenCalledTimes(2);
    expect(client.claimHostedRunControlV1).toHaveBeenCalledTimes(1);
    await restarted?.close();
  });

  it("replays an outcome-unknown claim exactly after readiness TTL expiry", async () => {
    const events: string[] = [];
    let currentNow = now;
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
        return { ...context, observedAt: currentNow.toISOString() };
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
          throw new Error("transport_outcome_unknown");
        })
        .mockImplementationOnce(async () => {
        events.push("claim");
        return null;
        }),
    } as never;
    let pending: { operationId: string; requestId: string; request: unknown } | null = null;
    const repo = {
      ...emptyLifecycleRepository(),
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
      now: () => currentNow,
      controlClient: client,
      governanceStore: { repo, close: vi.fn() },
      executeClaimedRunImpl: vi.fn() as never,
    });
    await expect(loop?.beforeIteration()).rejects.toThrow("transport_outcome_unknown");
    const firstRequest = (client.claimHostedRunControlV1 as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].request;
    const exactReadsAfterFirst = repo.getControlPlaneProjection.mock.calls.length;
    const latestReadsAfterFirst =
      repo.getLatestRunnerReadinessProjection.mock.calls.length;
    repo.getControlPlaneProjection.mockResolvedValue(null);
    repo.getLatestRunnerReadinessProjection.mockResolvedValue(null);
    currentNow = new Date(now.getTime() + 55_000);
    await expect(loop?.beforeIteration()).rejects.toThrow("transport_outcome_unknown");
    const finalWindowRequest = (client.claimHostedRunControlV1 as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].request;
    currentNow = new Date(now.getTime() + 60_001);
    await expect(loop?.beforeIteration()).resolves.toBe(false);
    const expiredRequest = (client.claimHostedRunControlV1 as ReturnType<typeof vi.fn>).mock.calls[2]?.[0].request;
    expect(events).toEqual([
      "context",
      "readiness",
      "journal",
      "claim",
      "context",
      "claim",
      "context",
      "claim",
      "empty",
    ]);
    expect(finalWindowRequest).toEqual(firstRequest);
    expect(expiredRequest).toEqual(firstRequest);
    expect(repo.getControlPlaneProjection).toHaveBeenCalledTimes(
      exactReadsAfterFirst,
    );
    expect(repo.getLatestRunnerReadinessProjection).toHaveBeenCalledTimes(
      latestReadsAfterFirst,
    );
    expect(client.reportRunnerReadinessControlV1).toHaveBeenCalledTimes(1);
    expect(repo.beginHostedClaimOperation).toHaveBeenCalledTimes(1);
    expect(repo.acknowledgeHostedClaimEmpty).toHaveBeenCalledTimes(1);
    await loop?.close();
  });

  it("rejects a claim when fresh readiness capabilities diverge from the current context", async () => {
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
      registrationGeneration: 1,
      credentialGeneration: 1,
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
    const request = buildHostedClaimRequestV1({
      context,
      readiness,
      requestId: "request_capability_mismatch",
      operationId: "operation_capability_mismatch",
    });
    const claim = await validHostedClaim({
      request,
      executorCapabilityDigest:
        readiness.payload.executors[0]!.capabilityDigest,
    });
    const mismatchedReadiness = {
      ...readiness,
      payload: {
        ...readiness.payload,
        capabilities: readiness.payload.capabilities.filter(
          (capability) => capability !== "relay.lifecycle.v1",
        ),
      },
    };

    await expect(assertHostedClaimCurrentAuthorityV1({
      claim,
      context,
      readiness: mismatchedReadiness,
      request,
      now,
    })).rejects.toThrow("hosted_claim_current_capability_mismatch");
  });

  it("persists an outcome-unknown claim before capability revocation and replays its exact rejection after restart", async () => {
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
    let currentNow = now;
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
    let currentContext = context;
    let claimOperation: {
      operationId: string;
      requestId: string;
      request: unknown;
    } | null = null;
    let shellPersisted = false;
    let rejection: HostedLifecycleOperationEntry | undefined;
    let nextAttemptAt = now.toISOString();
    const events: string[] = [];
    const importHostedAssignedRun = vi.fn();
    const refetchGitHubIssueCommentImpl = vi.fn();
    const executeClaimedRunImpl = vi.fn();
    let persistCount = 0;
    const persistHostedClaimAuthorityShell = vi.fn(async () => {
      events.push("authority_shell");
      shellPersisted = true;
      persistCount += 1;
      if (persistCount === 1) throw new Error("crash_after_authority_shell");
      return { outcome: "replayed" as const, operation: claimOperation };
    });
    const rejectHostedAttemptStartLocally = vi.fn(async ({ request }) => {
      events.push("local_reject");
      rejection = {
        destinationId: "cloud",
        organizationId: "org_1",
        runnerId: "runner_1",
        credentialId: "credential_1",
        operationId: request.operationId,
        requestId: request.requestId,
        action: "reject-start",
        runId: "run_1",
        request,
        state: "pending",
        attemptCount: 0,
      };
      return { outcome: "journaled" as const, operation: rejection };
    });
    const repo = {
      ...emptyLifecycleRepository(),
      claimDueHostedLifecycleOperations: vi.fn(async ({ now: claimedAt }) => {
        if (
          !rejection
          || rejection.state !== "pending"
          || Date.parse(nextAttemptAt) > (claimedAt ?? currentNow).getTime()
        ) return [];
        rejection = {
          ...rejection,
          state: "leased",
          attemptCount: rejection.attemptCount + 1,
          leaseToken: `reject_lease_${rejection.attemptCount + 1}`,
        };
        return [rejection];
      }),
      retryHostedLifecycleOperation: vi.fn(async ({ nextAttemptAt: retryAt }) => {
        nextAttemptAt = retryAt;
        if (rejection) {
          rejection = {
            ...rejection,
            state: "pending",
            leaseToken: undefined,
          };
        }
        return "retried" as const;
      }),
      acknowledgeHostedLifecycleOperation: vi.fn(async () => {
        events.push("reject_ack");
        rejection = undefined;
        shellPersisted = false;
        claimOperation = null;
        return "acknowledged" as const;
      }),
      getHostedAssignedRunForRecovery: vi.fn(async () => null),
      getHostedPreImportAuthorityRecovery: vi.fn(async () => {
        if (!shellPersisted || !claimOperation) return null;
        if (!rejection) {
          return { state: "claim_retry" as const, operation: claimOperation };
        }
        return {
          state: rejection.state === "attention"
            ? "reject_attention" as const
            : "reject_pending" as const,
          operation: claimOperation,
          lifecycleOperation: rejection,
        };
      }),
      getHostedClaimOperationForRetry: vi.fn(async () =>
        shellPersisted ? null : claimOperation
      ),
      beginHostedClaimOperation: vi.fn(async ({ request }) => {
        claimOperation = {
          operationId: request.operationId,
          requestId: request.requestId,
          request,
        };
        return { outcome: "created" as const, operation: claimOperation };
      }),
      persistHostedClaimAuthorityShell,
      rejectHostedAttemptStartLocally,
      importHostedAssignedRun,
      acknowledgeHostedClaimEmpty: vi.fn(async () => undefined),
    } as never;
    const rejectHostedAttemptStartControlV1 = vi.fn()
      .mockImplementationOnce(async ({ request }) => {
        events.push("reject_send_1");
        throw new TypeError(`response lost for ${request.operationId}`);
      })
      .mockImplementationOnce(async () => {
        events.push("reject_send_2");
        return { receipt: { receiptId: "receipt_reject_1" } };
      });
    let claimCount = 0;
    const claimHostedRunControlV1 = vi.fn(async ({ request }) => {
      events.push("claim");
      claimCount += 1;
      if (claimCount > 2) return null;
      const readiness = await buildRunnerReadinessReceipt({
        context,
        executors: { reviewer: executor },
        repositories: [repository],
        now: () => currentNow,
      });
      const admissionBase = {
        kind: "hosted_admission" as const,
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        requiredCapabilities: ["relay.hosted-admission.v1"] as const,
        admissionId: "admission_1",
        operationId: "admission_operation_1",
        organizationId: "org_1",
        bindingId: "binding_1",
        bindingSecretVersion: "secret_v1",
        provider: "github" as const,
        deliveryId: "delivery_1",
        deliveryPayloadDigest: `sha256:${"b".repeat(64)}`,
        sourceIdentityDigest: `sha256:${"c".repeat(64)}`,
        eventName: "issue_comment" as const,
        action: "created" as const,
        repository: {
          providerRepositoryId: "123",
          owner: "acme",
          repo: "widget",
        },
        sourceThread: {
          kind: "issue" as const,
          providerThreadId: "456",
          number: 42,
        },
        sourceEvent: {
          providerEventId: "789",
          kind: "issue_comment" as const,
        },
        verifiedActor: {
          providerUserId: "1001",
          login: "octocat",
          authorization: {
            decision: "allowed" as const,
            grantRef: "grant_1",
            grantVersion: 1,
            grantDigest: `sha256:${"d".repeat(64)}`,
          },
        },
        projectTarget: {
          projectTargetId: "target_1",
          version: 1,
          digest: `sha256:${"a".repeat(64)}`,
        },
        runnerId: "runner_1",
        admissionPolicySnapshot: {
          snapshotId: "policy_1",
          digest: `sha256:${"e".repeat(64)}`,
        },
        receivedAt: now.toISOString(),
        envelopeDigest: `sha256:${"0".repeat(64)}`,
      };
      const hostedAdmission = {
        ...admissionBase,
        envelopeDigest:
          await computeHostedAdmissionEnvelopeDigestV1(admissionBase),
      };
      const fencingToken = `fence_${"f".repeat(64)}`;
      return {
        kind: "hosted_claim",
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: context.capabilities,
        requestId: request.requestId,
        operationId: request.operationId,
        organizationId: "org_1",
        runnerId: "runner_1",
        runId: "run_1",
        executorId: "reviewer",
        hostedAdmission,
        admissionPolicySnapshot: {
          payload: { snapshotId: "policy_1" },
          receiptDigest: `sha256:${"e".repeat(64)}`,
        },
        attempt: {
          id: "attempt_1",
          number: 1,
          epoch: 1,
          fencingToken,
          fencingTokenDigest:
            await computeHostedClaimFencingTokenDigestV1(fencingToken),
          leaseExpiresAt: "2026-08-09T00:05:00.000Z",
        },
        authority: {
          organizationId: "org_1",
          runnerId: "runner_1",
          runId: "run_1",
          credentialId: "credential_1",
          registrationGeneration: 1,
          credentialGeneration: 1,
          projectTargetId: "target_1",
          targetBindingDigest: `sha256:${"a".repeat(64)}`,
          executorId: "reviewer",
          executorCapabilityDigest:
            readiness.payload.executors[0]?.capabilityDigest,
          runnerReadinessReceiptId:
            request.expectedAuthority.runnerReadinessReceiptId,
          runnerReadinessReceiptDigest:
            request.expectedAuthority.runnerReadinessReceiptDigest,
        },
      };
    });
    const client = {
      getRunnerControlContextV1: vi.fn(async () => ({
        ...currentContext,
        observedAt: currentNow.toISOString(),
      })),
      reportRunnerReadinessControlV1: vi.fn(async (receipt) => ({
        status: 201,
        replayed: false,
        outcome: "accepted",
        receipt,
      })),
      claimHostedRunControlV1,
      rejectHostedAttemptStartControlV1,
    } as never;
    const config = {
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
          registrationGeneration: 1,
          credentialGeneration: 1,
          credentialPurpose: "runtime",
          createdAt: now.toISOString(),
        },
      },
    } as never;
    const first = createHostedControlLoop({
      config,
      databasePath: ":memory:",
      executors: { reviewer: executor },
      now: () => currentNow,
      controlClient: client,
      governanceStore: { repo, close: vi.fn() },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
      refetchGitHubIssueCommentImpl: refetchGitHubIssueCommentImpl as never,
    });

    await expect(first?.beforeIteration()).rejects.toThrow(
      "crash_after_authority_shell",
    );
    expect(events).toEqual(["claim", "authority_shell"]);
    const firstClaimRequest = claimHostedRunControlV1.mock.calls[0]?.[0].request;
    await first?.close();

    currentContext = {
      ...context,
      capabilities: [
        "relay.claim-fence.v1",
        "relay.hosted-admission.v1",
        "relay.hosted-claim.v1",
        "relay.readiness.v1",
      ],
    };

    const restarted = createHostedControlLoop({
      config,
      databasePath: ":memory:",
      executors: { reviewer: executor },
      now: () => currentNow,
      controlClient: client,
      governanceStore: { repo, close: vi.fn() },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
      refetchGitHubIssueCommentImpl: refetchGitHubIssueCommentImpl as never,
    });
    await expect(restarted?.beforeIteration()).rejects.toThrow(
      "hosted_claim_current_capability_mismatch",
    );
    currentContext = context;
    expect(claimHostedRunControlV1.mock.calls[1]?.[0].request)
      .toEqual(firstClaimRequest);
    expect(repo.beginHostedClaimOperation).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "claim",
      "authority_shell",
      "claim",
      "authority_shell",
      "local_reject",
      "reject_send_1",
    ]);
    expect(persistHostedClaimAuthorityShell).toHaveBeenCalledBefore(
      rejectHostedAttemptStartLocally,
    );
    const firstRejectRequest = rejectHostedAttemptStartControlV1
      .mock.calls[0]?.[0].request;

    await expect(restarted?.beforeIteration()).resolves.toBe(false);
    expect(rejectHostedAttemptStartControlV1).toHaveBeenCalledTimes(1);
    expect(claimHostedRunControlV1).toHaveBeenCalledTimes(2);
    expect(repo.beginHostedClaimOperation).toHaveBeenCalledTimes(1);
    expect(client.reportRunnerReadinessControlV1).toHaveBeenCalledTimes(1);
    expect(refetchGitHubIssueCommentImpl).not.toHaveBeenCalled();
    expect(importHostedAssignedRun).not.toHaveBeenCalled();
    expect(executeClaimedRunImpl).not.toHaveBeenCalled();

    if (rejection) rejection = { ...rejection, state: "attention" };
    await expect(restarted?.beforeIteration()).resolves.toBe(false);
    expect(rejectHostedAttemptStartControlV1).toHaveBeenCalledTimes(1);
    expect(claimHostedRunControlV1).toHaveBeenCalledTimes(2);
    expect(repo.beginHostedClaimOperation).toHaveBeenCalledTimes(1);
    expect(client.reportRunnerReadinessControlV1).toHaveBeenCalledTimes(1);
    expect(refetchGitHubIssueCommentImpl).not.toHaveBeenCalled();
    expect(importHostedAssignedRun).not.toHaveBeenCalled();
    expect(executeClaimedRunImpl).not.toHaveBeenCalled();

    if (rejection) rejection = { ...rejection, state: "pending" };
    currentNow = new Date("2026-08-09T00:00:01.000Z");
    await expect(restarted?.beforeIteration()).resolves.toBe(false);
    expect(rejectHostedAttemptStartControlV1.mock.calls[1]?.[0].request)
      .toEqual(firstRejectRequest);
    expect(claimHostedRunControlV1).toHaveBeenCalledTimes(2);
    expect(repo.beginHostedClaimOperation).toHaveBeenCalledTimes(1);
    expect(client.reportRunnerReadinessControlV1).toHaveBeenCalledTimes(1);
    expect(refetchGitHubIssueCommentImpl).not.toHaveBeenCalled();
    expect(importHostedAssignedRun).not.toHaveBeenCalled();
    expect(executeClaimedRunImpl).not.toHaveBeenCalled();
    expect(events).toContain("reject_ack");
    expect(claimHostedRunControlV1).toHaveBeenCalledTimes(2);
    expect(repo.beginHostedClaimOperation).toHaveBeenCalledTimes(1);
    expect(client.reportRunnerReadinessControlV1).toHaveBeenCalledTimes(1);
    await restarted?.close();
  });

  it("keeps a claimed authority shell fail-closed when Cloud rejects its exact replay", async () => {
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
    const readiness = await buildRunnerReadinessReceipt({
      context,
      executors: {},
      repositories: [],
      now: () => now,
    });
    const request = buildHostedClaimRequestV1({
      context,
      readiness,
      requestId: "request_claimed_409",
      operationId: "operation_claimed_409",
    });
    const operation = {
      operationId: request.operationId,
      requestId: request.requestId,
      request,
      state: "claimed" as const,
    };
    const abandonHostedClaimOperation = vi.fn();
    const beginHostedClaimOperation = vi.fn();
    const repo = {
      ...emptyLifecycleRepository(),
      getHostedAssignedRunForRecovery: vi.fn(async () => null),
      getHostedPreImportAuthorityRecovery: vi.fn(async () => ({
        state: "claim_retry" as const,
        operation,
      })),
      getHostedClaimOperationForRetry: vi.fn(async () => null),
      beginHostedClaimOperation,
      abandonHostedClaimOperation,
    } as never;
    const claimError = Object.assign(new Error("stale claimed authority"), {
      status: 409,
      code: "stale_control_authority",
    });
    const claimHostedRunControlV1 = vi.fn(async () => {
      throw claimError;
    });
    const reportRunnerReadinessControlV1 = vi.fn();
    const executeClaimedRunImpl = vi.fn();
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "https://control.example",
        runnerToken: "runtime_secret",
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
      controlClient: {
        getRunnerControlContextV1: vi.fn(async () => context),
        reportRunnerReadinessControlV1,
        claimHostedRunControlV1,
      } as never,
      governanceStore: { repo, close: vi.fn() },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
    });

    await expect(loop?.beforeIteration()).rejects.toBe(claimError);
    expect(claimHostedRunControlV1).toHaveBeenCalledWith({
      runnerId: "runner_1",
      request,
    });
    expect(abandonHostedClaimOperation).not.toHaveBeenCalled();
    expect(beginHostedClaimOperation).not.toHaveBeenCalled();
    expect(reportRunnerReadinessControlV1).not.toHaveBeenCalled();
    expect(executeClaimedRunImpl).not.toHaveBeenCalled();
    await loop?.close();
  });

  it("does not start an executor until the local running operation is acknowledged", async () => {
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
    let currentNow = now;
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
      now: () => currentNow,
    });
    const lease = {
      attemptId: "attempt_1",
      fencingToken: `fence_${"f".repeat(64)}`,
    };
    let state: "pending" | "leased" | "acknowledged" | null = null;
    let operation: HostedLifecycleOperationEntry | null = null;
    let nextAttemptAt = now.toISOString();
    const runningRequests: unknown[] = [];
    const acquireHostedExecutionStart = vi.fn(async () => true);
    let delayRunningReplay = false;
    let markRunningLocalCount = 0;
    let resolveRunningReplay: ((value: unknown) => void) | undefined;
    const delayedRunningReplay = new Promise((resolve) => {
      resolveRunningReplay = resolve;
    });
    const repo = {
      ...emptyLifecycleRepository(),
      recoverExpiredHostedLifecycleOperations: vi.fn(async () => 0),
      claimDueHostedLifecycleOperations: vi.fn(async ({ now: claimedAt }) => {
        if (
          !operation
          || state !== "pending"
          || Date.parse(nextAttemptAt) > (claimedAt ?? currentNow).getTime()
        ) return [];
        state = "leased";
        operation = {
          ...operation,
          state,
          attemptCount: operation.attemptCount + 1,
          leaseToken: `lease_${operation.attemptCount + 1}`,
        };
        return [operation];
      }),
      retryHostedLifecycleOperation: vi.fn(async ({ nextAttemptAt: retryAt }) => {
        nextAttemptAt = retryAt;
        state = "pending";
        if (operation) operation = { ...operation, state, leaseToken: undefined };
        return "retried" as const;
      }),
      acknowledgeHostedLifecycleOperation: vi.fn(async () => {
        state = "acknowledged";
        if (operation) operation = { ...operation, state, leaseToken: undefined };
        return "acknowledged" as const;
      }),
      getHostedAssignedRunForRecovery: vi.fn(async () => ({
        claimed: {
          run: { id: "run_1" },
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
        },
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
        hostedAuthority: {
          organizationId: "org_1",
          runnerId: "runner_1",
          runId: "run_1",
          credentialId: "credential_1",
          registrationGeneration: 1,
          credentialGeneration: 1,
          projectTargetId: "target_1",
          targetBindingDigest: `sha256:${"a".repeat(64)}`,
          executorId: "reviewer",
          executorCapabilityDigest:
            readiness.payload.executors[0]?.capabilityDigest,
          attemptId: lease.attemptId,
          attemptNumber: 1,
          epoch: 1,
          fencingTokenDigest: `sha256:${"e".repeat(64)}`,
          admissionPolicySnapshotId: "policy_1",
          policyReceiptDigest: `sha256:${"b".repeat(64)}`,
          importedAt: now.toISOString(),
        },
      })),
      markHostedRunRunningLocally: vi.fn(async ({ request }) => {
        markRunningLocalCount += 1;
        runningRequests.push(request);
        if (!operation) {
          state = "pending";
          operation = {
            destinationId: "cloud",
            organizationId: "org_1",
            runnerId: "runner_1",
            credentialId: "credential_1",
            operationId: request.operationId,
            requestId: request.requestId,
            action: "running",
            runId: "run_1",
            request,
            state,
            attemptCount: 0,
          };
          return { outcome: "running" as const, operation };
        }
        if (delayRunningReplay && markRunningLocalCount === 6) {
          return delayedRunningReplay;
        }
        return { outcome: "duplicate" as const, operation };
      }),
      acquireHostedExecutionStart,
      isHostedExecutionCurrent: vi.fn(async () => true),
      getHostedExecutionLease: vi.fn(async () => ({
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
      })),
    } as never;
    const markHostedRunRunningControlV1 = vi.fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce({
        status: 201,
        replayed: true,
        outcome: "accepted",
        receipt: { receiptId: "receipt_running_1" },
      });
    let executorBodyCount = 0;
    const closeStore = vi.fn();
    const executeClaimedRunImpl = vi.fn(async (execution) => {
      await execution.client.markRunning(
        "run_1",
        "reviewer",
        lease,
        { executorCapability: executor.capability },
      );
      executorBodyCount += 1;
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
            registrationGeneration: 1,
            credentialGeneration: 1,
            credentialPurpose: "runtime",
            createdAt: now.toISOString(),
          },
        },
      } as never,
      databasePath: ":memory:",
      executors: { reviewer: executor },
      now: () => currentNow,
      controlClient: {
        getRunnerControlContextV1: vi.fn(async () => context),
        markHostedRunRunningControlV1,
      } as never,
      governanceStore: { repo, close: closeStore },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
      closeDrainTimeoutMs: 1,
    });

    await expect(loop?.beforeIteration()).rejects.toThrow(
      "hosted_running_not_acknowledged",
    );
    expect(acquireHostedExecutionStart).not.toHaveBeenCalled();
    expect(executorBodyCount).toBe(0);

    currentNow = new Date("2026-08-09T00:00:01.000Z");
    await expect(loop?.beforeIteration()).resolves.toBe(true);
    expect(acquireHostedExecutionStart).toHaveBeenCalledTimes(1);
    expect(executorBodyCount).toBe(1);
    expect(markHostedRunRunningControlV1).toHaveBeenCalledTimes(2);
    expect(markHostedRunRunningControlV1.mock.calls[1]?.[0].request)
      .toEqual(markHostedRunRunningControlV1.mock.calls[0]?.[0].request);
    expect(runningRequests.every((request) =>
      JSON.stringify(request) === JSON.stringify(runningRequests[0])
    )).toBe(true);

    delayRunningReplay = true;
    const cancelledIteration = loop!.beforeIteration();
    await vi.waitFor(() => {
      expect(repo.markHostedRunRunningLocally).toHaveBeenCalledTimes(6);
    });
    await loop!.close();
    expect(closeStore).not.toHaveBeenCalled();
    resolveRunningReplay?.({ outcome: "duplicate", operation });
    await expect(cancelledIteration).rejects.toThrow(
      "hosted_control_operation_cancelled",
    );
    await vi.waitFor(() => {
      expect(closeStore).toHaveBeenCalledTimes(1);
    });
    expect(acquireHostedExecutionStart).toHaveBeenCalledTimes(1);
    expect(executorBodyCount).toBe(1);
  });

  it("requeues hosted pre-execution completion paths without inventing running", async () => {
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
      registrationGeneration: 1,
      credentialGeneration: 1,
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
    const lease = {
      attemptId: "attempt_1",
      fencingToken: `fence_${"f".repeat(64)}`,
    };
    const events: string[] = [];
    let rejection: HostedLifecycleOperationEntry | undefined;
    const acquireHostedExecutionStart = vi.fn(async () => true);
    const completeHostedRunLocally = vi.fn();
    const repo = {
      ...emptyLifecycleRepository(),
      claimDueHostedLifecycleOperations: vi.fn(async () => {
        if (!rejection || rejection.state !== "pending") return [];
        rejection = {
          ...rejection,
          state: "leased",
          attemptCount: 1,
          leaseToken: "lease_reject_1",
        };
        return [rejection];
      }),
      acknowledgeHostedLifecycleOperation: vi.fn(async () => {
        events.push("ack");
        if (rejection) rejection = { ...rejection, state: "acknowledged" };
        return "acknowledged" as const;
      }),
      getHostedAssignedRunForRecovery: vi.fn(async () => ({
        claimed: {
          run: { id: "run_1" },
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
        },
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
        hostedAuthority: {
          organizationId: "org_1",
          runnerId: "runner_1",
          runId: "run_1",
          credentialId: "credential_1",
          registrationGeneration: 1,
          credentialGeneration: 1,
          projectTargetId: "target_1",
          targetBindingDigest: `sha256:${"a".repeat(64)}`,
          executorId: "reviewer",
          executorCapabilityDigest:
            readiness.payload.executors[0]?.capabilityDigest,
          attemptId: lease.attemptId,
          attemptNumber: 1,
          epoch: 1,
          fencingTokenDigest: `sha256:${"e".repeat(64)}`,
          admissionPolicySnapshotId: "policy_1",
          policyReceiptDigest: `sha256:${"b".repeat(64)}`,
          importedAt: now.toISOString(),
        },
      })),
      rejectHostedAttemptStartLocally: vi.fn(async ({ request }) => {
        events.push("local_reject");
        rejection = {
          destinationId: "cloud",
          organizationId: "org_1",
          runnerId: "runner_1",
          credentialId: "credential_1",
          operationId: request.operationId,
          requestId: request.requestId,
          action: "reject-start",
          runId: "run_1",
          request,
          state: "pending",
          attemptCount: 0,
        };
        return { outcome: "requeued" as const, operation: rejection };
      }),
      acquireHostedExecutionStart,
      completeHostedRunLocally,
      isHostedExecutionCurrent: vi.fn(async () => true),
      getHostedExecutionLease: vi.fn(async () => ({
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
      })),
    } as never;
    const rejectHostedAttemptStartControlV1 = vi.fn(async () => {
      events.push("cloud_reject");
      return { receipt: { receiptId: "receipt_reject_1" } };
    });
    const markHostedRunRunningControlV1 = vi.fn();
    const completeHostedRunControlV1 = vi.fn();
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
            registrationGeneration: 1,
            credentialGeneration: 1,
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
        rejectHostedAttemptStartControlV1,
        markHostedRunRunningControlV1,
        completeHostedRunControlV1,
      } as never,
      governanceStore: { repo, close: vi.fn() },
      executeClaimedRunImpl: vi.fn(async (execution) => {
        await execution.client.complete("run_1", lease, {
          conclusion: "needs_human",
          summary: "Hosted V1 cannot execute this work context safely.",
        });
        return true;
      }) as never,
    });

    await expect(loop?.beforeIteration()).resolves.toBe(true);
    expect(events).toEqual(["local_reject", "cloud_reject", "ack"]);
    expect(acquireHostedExecutionStart).not.toHaveBeenCalled();
    expect(markHostedRunRunningControlV1).not.toHaveBeenCalled();
    expect(completeHostedRunLocally).not.toHaveBeenCalled();
    expect(completeHostedRunControlV1).not.toHaveBeenCalled();
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
    let currentNow = now;
    let nextAttemptAt = now.toISOString();
    let pending: HostedLifecycleOperationEntry | null = null;
    let delayHeartbeatRequest = false;
    let heartbeatRequestInput: Parameters<
      typeof buildHostedLifecycleRequestV1
    >[0] | undefined;
    let resolveHeartbeatRequest: ((value: unknown) => void) | undefined;
    const delayedHeartbeatRequest = new Promise((resolve) => {
      resolveHeartbeatRequest = resolve;
    });
    const buildHostedLifecycleRequestImpl = vi.fn((requestInput) => {
      if (delayHeartbeatRequest && requestInput.action === "heartbeat") {
        heartbeatRequestInput = requestInput;
        return delayedHeartbeatRequest;
      }
      return buildHostedLifecycleRequestV1(requestInput);
    });
    const beginHostedHeartbeatOperation = vi.fn(async ({ request }) => {
      pending = {
        destinationId: "cloud",
        organizationId: "org_1",
        runnerId: "runner_1",
        credentialId: "credential_1",
        operationId: request.operationId,
        requestId: request.requestId,
        action: "heartbeat",
        runId: "run_1",
        request,
        state: "pending",
        attemptCount: 0,
      };
      return { outcome: "created" as const, operation: pending };
    });
    const acknowledgeHostedLifecycleOperation = vi.fn(async () => {
      acceptedLeaseExpiresAt = acceptedLeaseExpiresAt
        === "2026-08-09T00:01:00.000Z"
        ? "2026-08-09T00:02:00.000Z"
        : "2026-08-09T00:03:00.000Z";
      pending = null;
      return "acknowledged" as const;
    });
    const repo = {
      ...emptyLifecycleRepository(),
      claimDueHostedLifecycleOperations: vi.fn(async ({ now: claimedAt }) => {
        if (
          !pending
          || Date.parse(nextAttemptAt) > (claimedAt ?? currentNow).getTime()
        ) return [];
        pending = {
          ...pending,
          state: "leased",
          attemptCount: pending.attemptCount + 1,
          leaseToken: `lease_${pending.attemptCount + 1}`,
        };
        return [pending];
      }),
      acknowledgeHostedLifecycleOperation,
      retryHostedLifecycleOperation: vi.fn(async ({ nextAttemptAt: retryAt }) => {
        nextAttemptAt = retryAt;
        if (pending) {
          pending = { ...pending, state: "pending", leaseToken: undefined };
        }
        return "retried" as const;
      }),
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
          importedAt: now.toISOString(),
        },
      })),
      acquireHostedExecutionStart: vi.fn(async () => true),
      isHostedExecutionCurrent: vi.fn(async () => true),
      getHostedExecutionLease: vi.fn(async () => ({
        leaseExpiresAt: acceptedLeaseExpiresAt,
      })),
      getHostedHeartbeatOperationForRetry: vi.fn(async () => pending),
      beginHostedHeartbeatOperation,
    } as never;
    const heartbeatHostedRunControlV1 = vi.fn()
      .mockRejectedValueOnce(new TypeError("transport_outcome_unknown"))
      .mockImplementation(async ({ request }) => ({
        status: 201 as const,
        replayed: false as const,
        outcome: "accepted" as const,
        receipt: { requestId: request.requestId },
      }));
    const executeClaimedRunImpl = vi.fn(async (execution) => {
      await expect(execution.client.heartbeat("run_1", lease)).rejects.toThrow(
        "hosted_heartbeat_receipt_rejected",
      );
      currentNow = new Date("2026-08-09T00:00:01.000Z");
      await execution.client.heartbeat("run_1", lease);
      await execution.client.heartbeat("run_1", lease);
      await expect(
        execution.hostedExecutionAuthority?.readAcceptedLeaseExpiresAt?.(),
      ).resolves.toBe("2026-08-09T00:03:00.000Z");
      delayHeartbeatRequest = true;
      await execution.client.heartbeat("run_1", lease);
      return true;
    });
    const closeStore = vi.fn();
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
      now: () => currentNow,
      controlClient: {
        getRunnerControlContextV1: vi.fn(async () => context),
        heartbeatHostedRunControlV1,
      } as never,
      governanceStore: { repo, close: closeStore },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
      buildHostedLifecycleRequestImpl:
        buildHostedLifecycleRequestImpl as never,
      closeDrainTimeoutMs: 1,
    });

    const iteration = loop!.beforeIteration();
    await vi.waitFor(() => {
      expect(buildHostedLifecycleRequestImpl).toHaveBeenCalledTimes(3);
    });
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
    expect(acknowledgeHostedLifecycleOperation).toHaveBeenCalledTimes(2);
    await loop.close();
    expect(closeStore).not.toHaveBeenCalled();
    resolveHeartbeatRequest?.(
      await buildHostedLifecycleRequestV1(heartbeatRequestInput!),
    );
    await expect(iteration).rejects.toThrow(
      "hosted_control_operation_cancelled",
    );
    expect(beginHostedHeartbeatOperation).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(closeStore).toHaveBeenCalledTimes(1);
    });
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

  it("compares durable readiness by semantic authority and enforces the five-second safety window", async () => {
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
      targets: [],
      observedAt: now.toISOString(),
    };
    const first = await buildRunnerReadinessReceipt({
      context,
      executors: {},
      repositories: [],
      now: () => now,
    });
    const secondObservedAt = new Date(now.getTime() + 1_000);
    const second = await buildRunnerReadinessReceipt({
      context: { ...context, observedAt: secondObservedAt.toISOString() },
      executors: {},
      repositories: [],
      now: () => secondObservedAt,
    });

    expect(first.receiptId).not.toBe(second.receiptId);
    expect(hasSameRunnerReadinessAuthorityV1(first, second)).toBe(true);
    expect(hasSameRunnerReadinessAuthorityV1(first, {
      ...second,
      producer: { ...second.producer, credentialId: "credential_2" },
    })).toBe(false);
    expect(runnerReadinessReuseWindowV1(
      first,
      new Date(now.getTime() + 54_999),
    )).toBe("reusable");
    expect(runnerReadinessReuseWindowV1(
      first,
      new Date(now.getTime() + 55_000),
    )).toBe("final_window");
    expect(runnerReadinessReuseWindowV1(
      first,
      new Date(now.getTime() + 60_001),
    )).toBe("expired");
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

  it("routes completion evidence through its typed endpoint before callback fallback", async () => {
    const { repo, client } = harness(completionEvidenceEntry());
    await expect(pumpControlPlaneProjections({
      repo,
      client,
      destinationId: "cloud",
      organizationId: "org_1",
      leaseOwner: "pump_1",
      now,
    })).resolves.toEqual({ delivered: 1, retried: 0, attention: 0 });
    expect(client.projectCompletionEvidenceControlV1).toHaveBeenCalledTimes(1);
    expect(client.projectCallbackObservationControlV1).not.toHaveBeenCalled();
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

  it("retries an outcome-unknown transport exception instead of requiring attention", async () => {
    const { repo, client } = harness(callbackEntry());
    client.projectCallbackObservationControlV1.mockRejectedValueOnce(
      new TypeError("fetch failed after request dispatch"),
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
    expect(repo.markControlPlaneProjectionAttention).not.toHaveBeenCalled();
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

  it("bounds shutdown when an in-flight control transport ignores abort", async () => {
    const closeStore = vi.fn();
    let resolveContext: ((value: unknown) => void) | undefined;
    const delayedContext = new Promise((resolve) => {
      resolveContext = resolve;
    });
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "https://control.example",
        runnerToken: "runtime_secret",
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
      controlClient: {
        getRunnerControlContextV1: vi.fn(() => delayedContext),
      } as never,
      governanceStore: { repo: {} as never, close: closeStore },
      closeDrainTimeoutMs: 1,
    });

    const iteration = loop?.beforeIteration();
    await expect(loop?.close()).resolves.toBeUndefined();
    expect(closeStore).not.toHaveBeenCalled();
    resolveContext?.({});
    await expect(iteration).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(closeStore).toHaveBeenCalledTimes(1);
    });
  });

  it("does not execute a recovery that resolves after close", async () => {
    let resolveRecovery: ((value: unknown) => void) | undefined;
    const delayedRecovery = new Promise((resolve) => {
      resolveRecovery = resolve;
    });
    const executeClaimedRunImpl = vi.fn();
    const importHostedAssignedRun = vi.fn();
    const acquireHostedExecutionStart = vi.fn();
    const lifecycleProvider = vi.fn();
    const closeStore = vi.fn();
    const repo = {
      ...emptyLifecycleRepository(),
      getHostedAssignedRunForRecovery: vi.fn(() => delayedRecovery),
      getHostedClaimOperationForRetry: vi.fn(async () => null),
      importHostedAssignedRun,
      acquireHostedExecutionStart,
    } as never;
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
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "https://control.example",
        runnerToken: "runtime_secret",
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
      controlClient: {
        getRunnerControlContextV1: vi.fn(async () => context),
        completeHostedRunControlV1: lifecycleProvider,
      } as never,
      governanceStore: { repo, close: closeStore },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
      closeDrainTimeoutMs: 1,
    });
    const iteration = loop!.beforeIteration();
    await vi.waitFor(() => {
      expect(repo.getHostedAssignedRunForRecovery).toHaveBeenCalledTimes(1);
    });

    await loop!.close();
    expect(closeStore).not.toHaveBeenCalled();
    resolveRecovery?.({ claimed: { run: { id: "run_1" } } });
    await expect(iteration).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(closeStore).toHaveBeenCalledTimes(1);
    });
    expect(executeClaimedRunImpl).not.toHaveBeenCalled();
    expect(importHostedAssignedRun).not.toHaveBeenCalled();
    expect(acquireHostedExecutionStart).not.toHaveBeenCalled();
    expect(lifecycleProvider).not.toHaveBeenCalled();
  });

  it("keeps delayed execution authority checks fail closed after close", async () => {
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
      registrationGeneration: 1,
      credentialGeneration: 1,
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
    let resolveCurrent: ((value: boolean) => void) | undefined;
    const delayedCurrent = new Promise<boolean>((resolve) => {
      resolveCurrent = resolve;
    });
    let resolveLease: ((value: { leaseExpiresAt: string }) => void) | undefined;
    const delayedLease = new Promise<{ leaseExpiresAt: string }>((resolve) => {
      resolveLease = resolve;
    });
    const closeStore = vi.fn();
    const repo = {
      ...emptyLifecycleRepository(),
      getHostedAssignedRunForRecovery: vi.fn(async () => ({
        claimed: {
          run: { id: "run_1" },
          attemptId: "attempt_1",
          fencingToken: `fence_${"f".repeat(64)}`,
        },
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
        hostedAuthority: {
          organizationId: "org_1",
          runnerId: "runner_1",
          runId: "run_1",
          credentialId: "credential_1",
          registrationGeneration: 1,
          credentialGeneration: 1,
          projectTargetId: "target_1",
          targetBindingDigest: `sha256:${"a".repeat(64)}`,
          executorId: "reviewer",
          executorCapabilityDigest:
            readiness.payload.executors[0]?.capabilityDigest,
          attemptId: "attempt_1",
          attemptNumber: 1,
          epoch: 1,
          fencingTokenDigest: `sha256:${"e".repeat(64)}`,
          admissionPolicySnapshotId: "policy_1",
          policyReceiptDigest: `sha256:${"b".repeat(64)}`,
          importedAt: now.toISOString(),
        },
      })),
      isHostedExecutionCurrent: vi.fn(() => delayedCurrent),
      getHostedExecutionLease: vi.fn(() => delayedLease),
    } as never;
    let authorityResults: [boolean, string | null] | undefined;
    const executeClaimedRunImpl = vi.fn(async (execution) => {
      authorityResults = await Promise.all([
        execution.hostedExecutionAuthority!.assertCurrent!(),
        execution.hostedExecutionAuthority!.readAcceptedLeaseExpiresAt!(),
      ]);
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
            registrationGeneration: 1,
            credentialGeneration: 1,
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
      } as never,
      governanceStore: { repo, close: closeStore },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
      closeDrainTimeoutMs: 1,
    });
    const iteration = loop!.beforeIteration();
    await vi.waitFor(() => {
      expect(repo.isHostedExecutionCurrent).toHaveBeenCalledTimes(1);
      expect(repo.getHostedExecutionLease).toHaveBeenCalledTimes(1);
    });

    await loop!.close();
    expect(closeStore).not.toHaveBeenCalled();
    resolveCurrent?.(true);
    resolveLease?.({ leaseExpiresAt: "2026-08-09T00:05:00.000Z" });
    await expect(iteration).resolves.toBe(false);
    expect(authorityResults).toEqual([false, null]);
    await vi.waitFor(() => {
      expect(closeStore).toHaveBeenCalledTimes(1);
    });
  });

  it("does not probe readiness or recovery after a delayed claim retry lookup closes", async () => {
    let resolveClaimRetry: ((value: null) => void) | undefined;
    const delayedClaimRetry = new Promise<null>((resolve) => {
      resolveClaimRetry = resolve;
    });
    const lifecycle = emptyLifecycleRepository();
    const getHostedAssignedRunForRecovery = vi.fn(async () => null);
    const reportRunnerReadinessControlV1 = vi.fn();
    const claimHostedRunControlV1 = vi.fn();
    const executeClaimedRunImpl = vi.fn();
    const closeStore = vi.fn();
    const repo = {
      ...lifecycle,
      getHostedClaimOperationForRetry: vi.fn(() => delayedClaimRetry),
      getHostedAssignedRunForRecovery,
    } as never;
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
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "https://control.example",
        runnerToken: "runtime_secret",
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
      controlClient: {
        getRunnerControlContextV1: vi.fn(async () => context),
        reportRunnerReadinessControlV1,
        claimHostedRunControlV1,
      } as never,
      governanceStore: { repo, close: closeStore },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
      closeDrainTimeoutMs: 1,
    });
    const iteration = loop!.beforeIteration();
    await vi.waitFor(() => {
      expect(repo.getHostedClaimOperationForRetry).toHaveBeenCalledTimes(1);
    });

    await loop!.close();
    expect(closeStore).not.toHaveBeenCalled();
    resolveClaimRetry?.(null);
    await expect(iteration).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(closeStore).toHaveBeenCalledTimes(1);
    });
    expect(lifecycle.recoverExpiredHostedLifecycleOperations)
      .not.toHaveBeenCalled();
    expect(lifecycle.claimDueHostedLifecycleOperations).not.toHaveBeenCalled();
    expect(reportRunnerReadinessControlV1).not.toHaveBeenCalled();
    expect(getHostedAssignedRunForRecovery).not.toHaveBeenCalled();
    expect(claimHostedRunControlV1).not.toHaveBeenCalled();
    expect(executeClaimedRunImpl).not.toHaveBeenCalled();
  });

  it("does not reject or import a claim when close wins a delayed refetch", async () => {
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
      registrationGeneration: 1,
      credentialGeneration: 1,
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
    const executorCapabilityDigest =
      readiness.payload.executors[0]?.capabilityDigest;
    expect(executorCapabilityDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    let rejectRefetch: ((reason: Error) => void) | undefined;
    const delayedRefetch = new Promise<never>((_resolve, reject) => {
      rejectRefetch = reject;
    });
    const refetchGitHubIssueCommentImpl = vi.fn(() => delayedRefetch);
    const rejectHostedAttemptStartLocally = vi.fn();
    const importHostedAssignedRun = vi.fn();
    const executeClaimedRunImpl = vi.fn();
    const closeStore = vi.fn();
    const repo = {
      ...emptyLifecycleRepository(),
      getHostedAssignedRunForRecovery: vi.fn(async () => null),
      getHostedClaimOperationForRetry: vi.fn(async () => null),
      beginHostedClaimOperation: vi.fn(async ({ request }) => ({
        outcome: "created" as const,
        operation: {
          operationId: request.operationId,
          requestId: request.requestId,
          request,
        },
      })),
      persistHostedClaimAuthorityShell: vi.fn(async () => ({
        outcome: "created" as const,
      })),
      rejectHostedAttemptStartLocally,
      importHostedAssignedRun,
      acknowledgeHostedClaimEmpty: vi.fn(async () => undefined),
    } as never;
    const rejectHostedAttemptStartControlV1 = vi.fn();
    const client = {
      getRunnerControlContextV1: vi.fn(async () => context),
      reportRunnerReadinessControlV1: vi.fn(async (receipt) => ({
        status: 201,
        replayed: false,
        outcome: "accepted",
        receipt,
      })),
      claimHostedRunControlV1: vi.fn(async ({ request }) =>
        validHostedClaim({
          request,
          executorCapabilityDigest: executorCapabilityDigest!,
        })
      ),
      rejectHostedAttemptStartControlV1,
    } as never;
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "https://control.example",
        runnerToken: "runtime_secret",
        githubToken: "github_secret",
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
            registrationGeneration: 1,
            credentialGeneration: 1,
            credentialPurpose: "runtime",
            createdAt: now.toISOString(),
          },
        },
      } as never,
      databasePath: ":memory:",
      executors: { reviewer: executor },
      now: () => now,
      controlClient: client,
      governanceStore: { repo, close: closeStore },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
      githubApiOrigin: "http://127.0.0.1:43123",
      refetchGitHubIssueCommentImpl: refetchGitHubIssueCommentImpl as never,
      closeDrainTimeoutMs: 1,
    });
    const iteration = loop!.beforeIteration();
    await vi.waitFor(() => {
      expect(refetchGitHubIssueCommentImpl).toHaveBeenCalledTimes(1);
    });
    expect(refetchGitHubIssueCommentImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        apiOrigin: "http://127.0.0.1:43123",
        token: "github_secret",
      }),
    );

    await loop!.close();
    expect(closeStore).not.toHaveBeenCalled();
    rejectRefetch?.(new Error("refetch failed after close"));
    await expect(iteration).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(closeStore).toHaveBeenCalledTimes(1);
    });
    expect(rejectHostedAttemptStartLocally).not.toHaveBeenCalled();
    expect(rejectHostedAttemptStartControlV1).not.toHaveBeenCalled();
    expect(importHostedAssignedRun).not.toHaveBeenCalled();
    expect(executeClaimedRunImpl).not.toHaveBeenCalled();
  });

  it("does not journal rejection when close wins delayed reject request construction", async () => {
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
      registrationGeneration: 1,
      credentialGeneration: 1,
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
    const executorCapabilityDigest =
      readiness.payload.executors[0]?.capabilityDigest;
    let resolveRejectRequest: ((value: unknown) => void) | undefined;
    let rejectRequestInput: Parameters<
      typeof buildHostedLifecycleRequestV1
    >[0] | undefined;
    const delayedRejectRequest = new Promise((resolve) => {
      resolveRejectRequest = resolve;
    });
    const buildHostedLifecycleRequestImpl = vi.fn((requestInput) => {
      rejectRequestInput = requestInput;
      return delayedRejectRequest;
    });
    const rejectHostedAttemptStartLocally = vi.fn();
    const rejectHostedAttemptStartControlV1 = vi.fn();
    const importHostedAssignedRun = vi.fn();
    const executeClaimedRunImpl = vi.fn();
    const closeStore = vi.fn();
    const repo = {
      ...emptyLifecycleRepository(),
      getHostedAssignedRunForRecovery: vi.fn(async () => null),
      getHostedClaimOperationForRetry: vi.fn(async () => null),
      beginHostedClaimOperation: vi.fn(async ({ request }) => ({
        outcome: "created" as const,
        operation: {
          operationId: request.operationId,
          requestId: request.requestId,
          request,
        },
      })),
      persistHostedClaimAuthorityShell: vi.fn(async () => ({
        outcome: "created" as const,
      })),
      rejectHostedAttemptStartLocally,
      importHostedAssignedRun,
      acknowledgeHostedClaimEmpty: vi.fn(async () => undefined),
    } as never;
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "https://control.example",
        runnerToken: "runtime_secret",
        githubToken: "github_secret",
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
            registrationGeneration: 1,
            credentialGeneration: 1,
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
        reportRunnerReadinessControlV1: vi.fn(async (receipt) => ({
          status: 201,
          replayed: false,
          outcome: "accepted",
          receipt,
        })),
        claimHostedRunControlV1: vi.fn(async ({ request }) =>
          validHostedClaim({
            request,
            executorCapabilityDigest: executorCapabilityDigest!,
          })
        ),
        rejectHostedAttemptStartControlV1,
      } as never,
      governanceStore: { repo, close: closeStore },
      executeClaimedRunImpl: executeClaimedRunImpl as never,
      refetchGitHubIssueCommentImpl: vi.fn(async () => {
        throw new Error("refetch failed");
      }) as never,
      buildHostedLifecycleRequestImpl:
        buildHostedLifecycleRequestImpl as never,
      closeDrainTimeoutMs: 1,
    });
    const iteration = loop!.beforeIteration();
    await vi.waitFor(() => {
      expect(buildHostedLifecycleRequestImpl).toHaveBeenCalledTimes(1);
    });

    await loop!.close();
    expect(closeStore).not.toHaveBeenCalled();
    expect(rejectRequestInput?.action).toBe("reject-start");
    resolveRejectRequest?.(
      await buildHostedLifecycleRequestV1(rejectRequestInput!),
    );
    await expect(iteration).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(closeStore).toHaveBeenCalledTimes(1);
    });
    expect(rejectHostedAttemptStartLocally).not.toHaveBeenCalled();
    expect(rejectHostedAttemptStartControlV1).not.toHaveBeenCalled();
    expect(importHostedAssignedRun).not.toHaveBeenCalled();
    expect(executeClaimedRunImpl).not.toHaveBeenCalled();
  });

  it("keeps the Store open until a timed-out shutdown pump settles", async () => {
    const completion = { conclusion: "success" as const, summary: "done" };
    const request = HostedCompleteRequestV1Schema.parse(
      await buildHostedLifecycleRequestV1({
        action: "complete",
        organizationId: "org_1",
        runnerId: "runner_1",
        runId: "run_1",
        attempt: {
          attemptId: "attempt_1",
          attemptNumber: 1,
          epoch: 1,
          fencingToken: `fence_${"f".repeat(64)}`,
          fencingTokenDigest: `sha256:${"e".repeat(64)}`,
        },
        occurredAt: now.toISOString(),
        ...await buildHostedCompletionMetadataForControlV1(completion),
      }),
    );
    let pending: HostedLifecycleOperationEntry | undefined;
    let resolveDelivery: ((value: unknown) => void) | undefined;
    const delayedDelivery = new Promise((resolve) => {
      resolveDelivery = resolve;
    });
    const acknowledge = vi.fn(async () => "acknowledged" as const);
    const closeStore = vi.fn();
    const repo = {
      ...memoryProjectionRepository(),
      recoverExpiredHostedLifecycleOperations: vi.fn(async () => 0),
      claimDueHostedLifecycleOperations: vi.fn(async () => pending ? [pending] : []),
      acknowledgeHostedLifecycleOperation: acknowledge,
      retryHostedLifecycleOperation: vi.fn(async () => "retried" as const),
      markHostedLifecycleOperationAttention: vi.fn(async () => "attention" as const),
      getHostedPreImportAuthorityRecovery: vi.fn(async () => null),
      getHostedAssignedRunForRecovery: vi.fn(async () => null),
      getHostedClaimOperationForRetry: vi.fn(async () => null),
      beginHostedClaimOperation: vi.fn(async ({ request: claimRequest }) => ({
        outcome: "created" as const,
        operation: {
          operationId: claimRequest.operationId,
          requestId: claimRequest.requestId,
          request: claimRequest,
        },
      })),
      acknowledgeHostedClaimEmpty: vi.fn(async () => undefined),
    } as never;
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
      getRunnerControlContextV1: vi.fn(async () => context),
      reportRunnerReadinessControlV1: vi.fn(async (receipt) => ({
        status: 201,
        replayed: false,
        outcome: "accepted",
        receipt,
      })),
      claimHostedRunControlV1: vi.fn(async () => null),
      completeHostedRunControlV1: vi.fn(() => delayedDelivery),
    } as never;
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "https://control.example",
        runnerToken: "runtime_secret",
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
      governanceStore: { repo, close: closeStore },
      closeDrainTimeoutMs: 1,
    });
    await expect(loop?.beforeIteration()).resolves.toBe(false);
    pending = {
      destinationId: "cloud",
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: "credential_1",
      operationId: request.operationId,
      requestId: request.requestId,
      action: "complete",
      runId: "run_1",
      request,
      state: "leased",
      attemptCount: 1,
      leaseToken: "lease_1",
    };

    await expect(loop?.close()).resolves.toBeUndefined();
    expect(closeStore).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    resolveDelivery?.({
      status: 200,
      replayed: true,
      outcome: "accepted",
      receipt: { receiptId: "receipt_1" },
    });
    await vi.waitFor(() => {
      expect(closeStore).toHaveBeenCalledTimes(1);
    });
    expect(acknowledge).not.toHaveBeenCalled();
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
