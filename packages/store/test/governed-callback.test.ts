import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CallbackAttemptObservationReceiptEnvelopeV1Schema,
  CallbackIntentObservationReceiptEnvelopeV1Schema,
  CallbackProviderObservationReceiptEnvelopeV1Schema,
  CompletionAssessmentReceiptEnvelopeV1Schema,
  HostedCompleteRequestV1Schema,
  HostedLifecycleReceiptEnvelopeV1Schema,
  canonicalJsonStringify
} from "@opentag/core";
import { describe, expect, it } from "vitest";
import { canonicalSha256Json } from "../src/canonical-json.js";
import {
  GovernedCallbackConflictError,
  createOpenTagRepository
} from "../src/repository.js";
import { migrateSchema } from "../src/schema.js";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const SOURCE_DIGEST = `sha256:${"1".repeat(64)}`;
const FENCE_DIGEST = `sha256:${createHash("sha256").update("raw-fence").digest("hex")}`;
const DELIVERY_TARGET = "https://example.test/callback";
const DELIVERY_BODY = "governed callback";
const PAYLOAD_DIGEST = canonicalSha256Json({
  method: "POST",
  mode: "progress",
  target: DELIVERY_TARGET,
  body: DELIVERY_BODY,
  threadKey: null,
  agentId: null,
  statusMessageKey: null,
  blocks: null,
  rich: null
});
const EVIDENCE_DIGEST = `sha256:${"5".repeat(64)}`;
const RUN_RESULT = { conclusion: "success" as const, summary: "completed locally" };
type TerminalResult =
  | typeof RUN_RESULT
  | { conclusion: "failure"; summary: string }
  | {
      conclusion: "needs_human";
      summary: string;
      humanResolutionUnavailableReason: string;
    };
const RESULT_DIGEST = canonicalSha256Json(RUN_RESULT);
const RUN_ID = "run-callback-1";
const WORK_THREAD_ID = "work_thread_1";
const RUN_ATTEMPT_ID = "attempt_1";
const CLAIM_OPERATION_ID = "claim_operation_1";
const ASSESSMENT_REF = "assessment_1";
const ASSESSMENT_RECEIPT_ID = "assessment_receipt_1";
const PRODUCER = {
  kind: "local_opentag" as const,
  id: "local_opentag",
  credentialId: "credential_ref_1",
  registrationGeneration: 1
};
const AUTHORITY = {
  attemptId: RUN_ATTEMPT_ID,
  attemptNumber: 1,
  epoch: 1,
  fencingTokenDigest: FENCE_DIGEST,
  admissionId: "admission_1",
  admissionOperationId: "admission_operation_1",
  claimOperationId: CLAIM_OPERATION_ID
};

const CLAIM_AUTHORITY = {
  organizationId: "org_1",
  runnerId: "runner_1",
  runId: RUN_ID,
  credentialId: PRODUCER.credentialId,
  registrationGeneration: PRODUCER.registrationGeneration,
  credentialGeneration: 1,
  projectTargetId: "project_target_1",
  bindingId: "binding_1",
  targetBindingDigest: `sha256:${"6".repeat(64)}`,
  admissionPolicyReceiptId: "policy_receipt_1",
  admissionPolicySnapshotId: "policy_snapshot_1",
  admissionPolicySnapshotDigest: EVIDENCE_DIGEST,
  runnerReadinessReceiptId: "readiness_receipt_1",
  runnerReadinessReceiptDigest: `sha256:${"8".repeat(64)}`,
  targetReadinessReceiptId: "readiness_receipt_1",
  targetReadinessReceiptDigest: `sha256:${"8".repeat(64)}`,
  executorId: "executor_1",
  executorCapabilityDigest: `sha256:${"9".repeat(64)}`,
  attemptId: RUN_ATTEMPT_ID,
  attemptNumber: 1,
  epoch: 1,
  fencingTokenDigest: FENCE_DIGEST
};

const COMPLETION_COMMON = {
  operation: "complete",
  organizationId: "org_1",
  runnerId: "runner_1",
  runId: RUN_ID,
  schemaVersion: 1,
  protocolVersion: "1.0",
  requiredCapabilities: ["relay.lifecycle.v1"],
  attempt: {
    attemptId: RUN_ATTEMPT_ID,
    attemptNumber: 1,
    epoch: 1,
    fencingTokenDigest: FENCE_DIGEST
  },
  occurredAt: NOW.toISOString(),
  conclusion: "success",
  reasonCode: "executor_success",
  resultDigest: RESULT_DIGEST,
  artifactDigests: [],
  evidenceDigests: []
};
const COMPLETION_REQUEST_DIGEST = canonicalSha256Json(COMPLETION_COMMON);
const COMPLETION_OPERATION_ID = `op_${COMPLETION_REQUEST_DIGEST.slice("sha256:".length)}`;
const COMPLETION_REQUEST_ID = `req_${canonicalSha256Json({
  purpose: "opentag-hosted-lifecycle-request-id-v1",
  operationId: COMPLETION_OPERATION_ID,
  requestDigest: COMPLETION_REQUEST_DIGEST
}).slice("sha256:".length)}`;
const COMPLETION_REQUEST = HostedCompleteRequestV1Schema.parse({
  schemaVersion: 1,
  protocolVersion: "1.0",
  requiredCapabilities: ["relay.lifecycle.v1"],
  requestId: COMPLETION_REQUEST_ID,
  operationId: COMPLETION_OPERATION_ID,
  attempt: { ...COMPLETION_COMMON.attempt, fencingToken: "raw-fence" },
  requestDigest: COMPLETION_REQUEST_DIGEST,
  occurredAt: NOW.toISOString(),
  conclusion: "success",
  reasonCode: "executor_success",
  resultDigest: RESULT_DIGEST,
  artifactDigests: [],
  evidenceDigests: []
});

const COMPLETION_RECEIPT = HostedLifecycleReceiptEnvelopeV1Schema.parse(withDigests({
  schemaVersion: 1,
  protocolVersion: "1.0",
  receiptKind: "attempt_lifecycle",
  receiptId: `lifecycle_${canonicalSha256Json({
    organizationId: "org_1",
    operationId: COMPLETION_OPERATION_ID
  }).slice("sha256:".length)}`,
  organizationId: "org_1",
  requestId: COMPLETION_REQUEST_ID,
  operationId: COMPLETION_OPERATION_ID,
  requestDigest: COMPLETION_REQUEST_DIGEST,
  requiredCapabilities: ["relay.lifecycle.v1"],
  producer: { kind: "runner", id: "runner_1", credentialId: PRODUCER.credentialId },
  identity: {
    namespace: "opentag.control.receipt/attempt-lifecycle/v1",
    parts: ["org_1", RUN_ID, RUN_ATTEMPT_ID, "executor_result", COMPLETION_OPERATION_ID]
  },
  observedAt: NOW.toISOString(),
  runId: RUN_ID,
  attempt: COMPLETION_COMMON.attempt,
  payload: {
    operation: "executor_result",
    occurredAt: NOW.toISOString(),
    conclusion: "success",
    reasonCode: "executor_success",
    resultDigest: RESULT_DIGEST,
    artifactDigests: [],
    evidenceDigests: []
  }
}));

const ASSESSMENT_RECEIPT = CompletionAssessmentReceiptEnvelopeV1Schema.parse(withDigests({
  schemaVersion: 1,
  protocolVersion: "1.0",
  receiptKind: "completion_assessment",
  receiptId: ASSESSMENT_RECEIPT_ID,
  organizationId: "org_1",
  operationId: "operation_assessment_1",
  requiredCapabilities: ["relay.completion-assessment.v1"],
  producer: PRODUCER,
  identity: {
    namespace: "opentag.control.receipt/completion-assessment/v1",
    parts: ["org_1", WORK_THREAD_ID, ASSESSMENT_REF]
  },
  predecessorReceiptDigests: [COMPLETION_RECEIPT.receiptDigest],
  observedAt: NOW.toISOString(),
  runId: RUN_ID,
  workThreadId: WORK_THREAD_ID,
  attempt: COMPLETION_COMMON.attempt,
  payload: {
    assessmentId: ASSESSMENT_REF,
    workThreadId: WORK_THREAD_ID,
    contract: {
      contractId: "contract_1",
      version: 1,
      cycle: 1,
      contentDigest: EVIDENCE_DIGEST
    },
    admissionPolicySnapshot: { snapshotId: "policy_snapshot_1", digest: EVIDENCE_DIGEST },
    runId: RUN_ID,
    attempt: COMPLETION_COMMON.attempt,
    executorResultReceiptRef: {
      receiptId: COMPLETION_RECEIPT.receiptId,
      operationId: COMPLETION_OPERATION_ID,
      requestId: COMPLETION_REQUEST_ID,
      requestDigest: COMPLETION_REQUEST_DIGEST,
      resultDigest: RESULT_DIGEST
    },
    assessmentInputDigest: EVIDENCE_DIGEST,
    evidenceReceiptDigests: [EVIDENCE_DIGEST],
    gateResults: [{
      gateId: "checks",
      state: "satisfied",
      reasonCode: "verification_passed",
      evidenceReceiptDigests: [EVIDENCE_DIGEST]
    }],
    conclusion: "satisfied",
    assessedAt: NOW.toISOString(),
    assessedBy: "local_opentag"
  }
}));

function withDigests<T extends { payload: unknown }>(value: T) {
  const withPayloadDigest = { ...value, payloadDigest: canonicalSha256Json(value.payload) };
  return { ...withPayloadDigest, receiptDigest: canonicalSha256Json(withPayloadDigest) };
}

function governedDelivery(body = DELIVERY_BODY) {
  return {
    provider: "github" as const,
    mode: "progress" as const,
    target: DELIVERY_TARGET,
    body
  };
}

function seedAuthority(sqlite: Database.Database): void {
  const authorityJson = canonicalJsonStringify(CLAIM_AUTHORITY);
  const authorityDigest = canonicalSha256Json(CLAIM_AUTHORITY);
  const claimDigest = `sha256:${"d".repeat(64)}`;
  const eventJson = JSON.stringify({
    id: "event_1",
    source: "github",
    sourceEventId: "comment_1",
    receivedAt: NOW.toISOString(),
    actor: { provider: "github", providerUserId: "42", handle: "octocat" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "complete", intent: "fix", args: {} },
    context: [],
    permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
    callback: { provider: "github", uri: DELIVERY_TARGET },
    metadata: { owner: "acme", repo: "demo", issueNumber: 1 }
  });
  sqlite.prepare(`INSERT INTO runs (
    id, event_id, status, event_json, assigned_runner_id, repo_provider, work_thread_id,
    current_attempt_id,
    routing_rejections_json, created_at, updated_at
  ) VALUES (?, 'event_1', 'running', ?, 'runner_1', 'github', ?, ?, '[]', ?, ?)`)
    .run(
      RUN_ID,
      eventJson,
      WORK_THREAD_ID,
      RUN_ATTEMPT_ID,
      NOW.toISOString(),
      NOW.toISOString()
    );
  sqlite.prepare(`INSERT INTO attempts (
    id, run_id, number, runner_id, runner_locality, fencing_token, status,
    started_at, heartbeat_at, lease_expires_at, finished_at, created_at, updated_at
  ) VALUES (?, ?, 1, 'runner_1', 'hosted', 'raw-fence', 'running', ?, ?, ?, NULL, ?, ?)`)
    .run(
      RUN_ATTEMPT_ID,
      RUN_ID,
      NOW.toISOString(),
      NOW.toISOString(),
      "2099-08-10T01:00:00.000Z",
      NOW.toISOString(),
      NOW.toISOString()
    );
  sqlite.prepare(`INSERT INTO hosted_claim_operations (
    operation_id, request_id, organization_id, runner_id, destination_id,
    request_digest, request_json, state, run_id, claim_digest, authority_digest,
    authority_json, attempt_id, attempt_number, fencing_token_digest, credential_id,
    execution_started_at,
    created_at, updated_at
  ) VALUES (?, 'claim_request_1', 'org_1', 'runner_1', 'cloud_1', ?, '{}',
    'claimed', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run(
      CLAIM_OPERATION_ID,
      SOURCE_DIGEST,
      RUN_ID,
      claimDigest,
      authorityDigest,
      authorityJson,
      RUN_ATTEMPT_ID,
      FENCE_DIGEST,
      PRODUCER.credentialId,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString()
    );
  sqlite.prepare(`INSERT INTO hosted_run_imports (
    run_id, admission_id, admission_operation_id, claim_operation_id,
    attempt_id, fencing_token_digest, source_identity_digest,
    delivery_payload_digest, admission_envelope_digest, policy_receipt_id,
    policy_payload_digest, policy_receipt_digest, event_digest,
    context_packet_digest, work_thread_id, claim_digest, authority_digest,
    authority_json, imported_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'policy_receipt_1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      RUN_ID,
      AUTHORITY.admissionId,
      AUTHORITY.admissionOperationId,
      CLAIM_OPERATION_ID,
      RUN_ATTEMPT_ID,
      FENCE_DIGEST,
      SOURCE_DIGEST,
      `sha256:${"7".repeat(64)}`,
      `sha256:${"8".repeat(64)}`,
      `sha256:${"9".repeat(64)}`,
      `sha256:${"a".repeat(64)}`,
      `sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
      WORK_THREAD_ID,
      claimDigest,
      authorityDigest,
      authorityJson,
      NOW.toISOString()
    );
  sqlite.prepare(`INSERT INTO hosted_attempt_imports (
    attempt_id, run_id, attempt_number, claim_operation_id,
    fencing_token_digest, claim_digest, authority_digest, authority_json,
    imported_at
  ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(
      RUN_ATTEMPT_ID,
      RUN_ID,
      CLAIM_OPERATION_ID,
      FENCE_DIGEST,
      claimDigest,
      authorityDigest,
      authorityJson,
      NOW.toISOString()
    );
  sqlite.prepare(`INSERT INTO callback_deliveries (
    id, run_id, kind, provider, uri, body, status, attempts, created_at, updated_at
  ) VALUES (1, ?, 'progress', 'github', ?, ?, 'queued', 0, ?, ?)`)
    .run(RUN_ID, DELIVERY_TARGET, DELIVERY_BODY, NOW.toISOString(), NOW.toISOString());
  sqlite.prepare(`INSERT INTO work_threads (
    id, scope_id, canonical_key, provider, owner_container_id, work_item_kind,
    external_id, thread_json, current_assessment_id, created_at, updated_at
  ) VALUES (?, 'scope_1', 'thread_key_1', 'github', 'owner_1', 'issue',
    '1', '{}', ?, ?, ?)`)
    .run(WORK_THREAD_ID, ASSESSMENT_REF, NOW.toISOString(), NOW.toISOString());
  const assessment = {
    id: ASSESSMENT_REF,
    workThreadId: WORK_THREAD_ID,
    triggeredByRunId: RUN_ID,
    contractId: "contract_1",
    contractVersion: 1,
    cycle: 1,
    sequence: 1,
    inputDigest: EVIDENCE_DIGEST,
    targetBindings: [{
      key: "primary_change",
      provider: "github",
      resourceRef: "github:acme/demo:pull_request:1",
      resourceVersion: "abc123",
      artifactId: "artifact_1"
    }],
    state: "satisfied",
    evidenceBacked: true,
    gateResults: [{
      gateId: "checks",
      targetKey: "primary_change",
      state: "passed",
      evidenceIds: ["evidence_1"],
      reasonCode: "verification_passed",
      reason: "Required verification passed.",
      evaluatedAt: NOW.toISOString()
    }],
    assessedAt: NOW.toISOString(),
    assessedBy: "opentag",
    acceptedAt: NOW.toISOString()
  };
  sqlite.prepare(`INSERT INTO completion_assessments (
    id, work_thread_id, contract_id, contract_version, cycle, sequence,
    input_digest, state, assessment_json, created_at
  ) VALUES (?, ?, 'contract_1', 1, 1, 1, ?, 'satisfied', ?, ?)`)
    .run(
      ASSESSMENT_REF,
      WORK_THREAD_ID,
      EVIDENCE_DIGEST,
      JSON.stringify(assessment),
      NOW.toISOString()
    );
  sqlite.prepare(`INSERT INTO control_plane_projection_outbox (
    receipt_id, destination_id, organization_id, run_id,
    work_thread_id, receipt_kind, identity_namespace, identity_parts_json,
    identity_key, operation_id, requires_lifecycle_operation_id,
    payload_digest, receipt_digest, envelope_json, state, attempt_count,
    next_attempt_at, created_at, updated_at
  ) VALUES (?, 'cloud_1', 'org_1', ?, ?, 'completion_assessment',
    ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
    .run(
      ASSESSMENT_RECEIPT.receiptId,
      RUN_ID,
      WORK_THREAD_ID,
      ASSESSMENT_RECEIPT.identity.namespace,
      JSON.stringify(ASSESSMENT_RECEIPT.identity.parts),
      canonicalSha256Json(ASSESSMENT_RECEIPT.identity),
      ASSESSMENT_RECEIPT.operationId,
      COMPLETION_OPERATION_ID,
      ASSESSMENT_RECEIPT.payloadDigest,
      ASSESSMENT_RECEIPT.receiptDigest,
      canonicalJsonStringify(ASSESSMENT_RECEIPT),
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function completeAndAcknowledge(
  repo: ReturnType<typeof createOpenTagRepository>
): Promise<void> {
  await expect(repo.completeHostedRunLocally({
    runId: RUN_ID,
    result: RUN_RESULT,
    runnerId: "runner_1",
    attemptId: RUN_ATTEMPT_ID,
    fencingToken: "raw-fence",
    destinationId: "cloud_1",
    organizationId: "org_1",
    credentialId: PRODUCER.credentialId,
    request: COMPLETION_REQUEST
  })).resolves.toBe("completed");
  const claimNow = new Date();
  const [operation] = await repo.claimDueHostedLifecycleOperations({
    destinationId: "cloud_1",
    organizationId: "org_1",
    leaseOwner: "lifecycle_pump",
    leaseSeconds: 30,
    now: claimNow
  });
  expect(operation?.operationId).toBe(COMPLETION_OPERATION_ID);
  await expect(repo.acknowledgeHostedLifecycleOperation({
    destinationId: "cloud_1",
    organizationId: "org_1",
    operationId: COMPLETION_OPERATION_ID,
    leaseToken: operation!.leaseToken!,
    receipt: COMPLETION_RECEIPT,
    now: new Date(claimNow.getTime() + 1_000)
  })).resolves.toBe("acknowledged");
}

async function setup() {
  const sqlite = new Database(":memory:");
  migrateSchema(sqlite);
  seedAuthority(sqlite);
  const repo = createOpenTagRepository(drizzle(sqlite));
  await completeAndAcknowledge(repo);
  return { sqlite, repo };
}

function terminalLifecycleFixtures(result: TerminalResult) {
  const resultDigest = canonicalSha256Json(result);
  const reasonCode = result.conclusion === "success"
    ? "executor_success"
    : result.conclusion === "failure" ? "executor_failure" : "executor_needs_human";
  const common = {
    ...COMPLETION_COMMON,
    conclusion: result.conclusion,
    reasonCode,
    resultDigest
  };
  const requestDigest = canonicalSha256Json(common);
  const operationId = `op_${requestDigest.slice("sha256:".length)}`;
  const requestId = `req_${canonicalSha256Json({
    purpose: "opentag-hosted-lifecycle-request-id-v1",
    operationId,
    requestDigest
  }).slice("sha256:".length)}`;
  const request = HostedCompleteRequestV1Schema.parse({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.lifecycle.v1"],
    requestId,
    operationId,
    attempt: { ...COMPLETION_COMMON.attempt, fencingToken: "raw-fence" },
    requestDigest,
    occurredAt: NOW.toISOString(),
    conclusion: result.conclusion,
    reasonCode,
    resultDigest,
    artifactDigests: [],
    evidenceDigests: []
  });
  const receipt = HostedLifecycleReceiptEnvelopeV1Schema.parse(withDigests({
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "attempt_lifecycle",
    receiptId: `lifecycle_${canonicalSha256Json({
      organizationId: "org_1",
      operationId
    }).slice("sha256:".length)}`,
    organizationId: "org_1",
    requestId,
    operationId,
    requestDigest,
    requiredCapabilities: ["relay.lifecycle.v1"],
    producer: { kind: "runner", id: "runner_1", credentialId: PRODUCER.credentialId },
    identity: {
      namespace: "opentag.control.receipt/attempt-lifecycle/v1",
      parts: ["org_1", RUN_ID, RUN_ATTEMPT_ID, "executor_result", operationId]
    },
    observedAt: NOW.toISOString(),
    runId: RUN_ID,
    attempt: COMPLETION_COMMON.attempt,
    payload: {
      operation: "executor_result",
      occurredAt: NOW.toISOString(),
      conclusion: result.conclusion,
      reasonCode,
      resultDigest,
      artifactDigests: [],
      evidenceDigests: []
    }
  }));
  const {
    receiptDigest: _receiptDigest,
    payloadDigest: _payloadDigest,
    ...assessmentBase
  } = ASSESSMENT_RECEIPT;
  const assessmentReceipt = CompletionAssessmentReceiptEnvelopeV1Schema.parse(withDigests({
    ...assessmentBase,
    predecessorReceiptDigests: [receipt.receiptDigest],
    payload: {
      ...ASSESSMENT_RECEIPT.payload,
      executorResultReceiptRef: {
        receiptId: receipt.receiptId,
        operationId,
        requestId,
        requestDigest,
        resultDigest
      }
    }
  }));
  return { result, request, receipt, assessmentReceipt, operationId };
}

async function setupTerminalResult(result: TerminalResult) {
  const sqlite = new Database(":memory:");
  migrateSchema(sqlite);
  seedAuthority(sqlite);
  const repo = createOpenTagRepository(drizzle(sqlite));
  const fixtures = terminalLifecycleFixtures(result);
  await repo.completeHostedRunLocally({
    runId: RUN_ID,
    result,
    runnerId: "runner_1",
    attemptId: RUN_ATTEMPT_ID,
    fencingToken: "raw-fence",
    destinationId: "cloud_1",
    organizationId: "org_1",
    credentialId: PRODUCER.credentialId,
    request: fixtures.request
  });
  const claimedAt = new Date(NOW.getTime() + 1_000);
  const [operation] = await repo.claimDueHostedLifecycleOperations({
    destinationId: "cloud_1",
    organizationId: "org_1",
    leaseOwner: "lifecycle_pump",
    leaseSeconds: 30,
    now: claimedAt
  });
  await repo.acknowledgeHostedLifecycleOperation({
    destinationId: "cloud_1",
    organizationId: "org_1",
    operationId: fixtures.operationId,
    leaseToken: operation!.leaseToken!,
    receipt: fixtures.receipt,
    now: new Date(claimedAt.getTime() + 1_000)
  });
  sqlite.exec("DROP TRIGGER control_plane_projection_outbox_immutable_update_guard");
  sqlite.prepare(`UPDATE control_plane_projection_outbox
    SET operation_id = ?, requires_lifecycle_operation_id = ?,
      payload_digest = ?, receipt_digest = ?, envelope_json = ?
    WHERE receipt_id = ?`).run(
      fixtures.assessmentReceipt.operationId,
      fixtures.operationId,
      fixtures.assessmentReceipt.payloadDigest,
      fixtures.assessmentReceipt.receiptDigest,
      canonicalJsonStringify(fixtures.assessmentReceipt),
      ASSESSMENT_RECEIPT_ID
    );
  return { sqlite, repo, ...fixtures };
}

function intentReceipt(localIntentId = "intent_1", overrides: Record<string, unknown> = {}) {
  const organizationId = typeof overrides.organizationId === "string"
    ? overrides.organizationId
    : "org_1";
  const { organizationId: _organizationId, ...receiptOverrides } = overrides;
  return CallbackIntentObservationReceiptEnvelopeV1Schema.parse(withDigests({
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "callback_intent_observation",
    receiptId: `receipt_${localIntentId}`,
    organizationId,
    operationId: `operation_${localIntentId}`,
    requiredCapabilities: ["relay.callback-observation.v1"],
    producer: PRODUCER,
    identity: {
      namespace: "opentag.control.receipt/callback-intent-observation/v1",
      parts: [organizationId, WORK_THREAD_ID, localIntentId]
    },
    predecessorReceiptDigests: [ASSESSMENT_RECEIPT.receiptDigest],
    observedAt: NOW.toISOString(),
    runId: RUN_ID,
    workThreadId: WORK_THREAD_ID,
    payload: {
      localIntentId,
      assessmentRef: ASSESSMENT_REF,
      assessmentDigest: ASSESSMENT_RECEIPT.receiptDigest,
      provider: "github",
      sourceThreadIdentityDigest: SOURCE_DIGEST,
      operationId: `operation_${localIntentId}`,
      payloadDigest: PAYLOAD_DIGEST,
      createdAt: NOW.toISOString()
    },
    ...receiptOverrides
  }));
}

function mismatchedAssessmentReceipt(
  kind: "contract" | "executor"
): typeof ASSESSMENT_RECEIPT {
  const {
    receiptDigest: _receiptDigest,
    payloadDigest: _payloadDigest,
    ...base
  } = ASSESSMENT_RECEIPT;
  const payload = kind === "contract"
    ? {
        ...ASSESSMENT_RECEIPT.payload,
        contract: { ...ASSESSMENT_RECEIPT.payload.contract, version: 2 }
      }
    : {
        ...ASSESSMENT_RECEIPT.payload,
        executorResultReceiptRef: {
          ...ASSESSMENT_RECEIPT.payload.executorResultReceiptRef,
          resultDigest: `sha256:${"0".repeat(64)}`
        }
      };
  return CompletionAssessmentReceiptEnvelopeV1Schema.parse(withDigests({
    ...base,
    payload
  }));
}

function replaceAssessmentProjection(
  sqlite: Database.Database,
  envelope: typeof ASSESSMENT_RECEIPT
): void {
  sqlite.exec("DROP TRIGGER control_plane_projection_outbox_immutable_update_guard");
  sqlite.prepare(`UPDATE control_plane_projection_outbox
    SET payload_digest = ?, receipt_digest = ?, envelope_json = ?
    WHERE receipt_id = ?`).run(
      envelope.payloadDigest,
      envelope.receiptDigest,
      canonicalJsonStringify(envelope),
      ASSESSMENT_RECEIPT_ID
    );
}

function intentReceiptForAssessment(
  localIntentId: string,
  assessment: typeof ASSESSMENT_RECEIPT
): ReturnType<typeof intentReceipt> {
  const current = intentReceipt(localIntentId);
  const {
    receiptDigest: _receiptDigest,
    payloadDigest: _payloadDigest,
    ...base
  } = current;
  return CallbackIntentObservationReceiptEnvelopeV1Schema.parse(withDigests({
    ...base,
    payload: {
      ...current.payload,
      assessmentDigest: assessment.receiptDigest
    }
  }));
}

function intentReceiptWithPayloadDigest(localIntentId: string, payloadDigest: string) {
  const current = intentReceipt(localIntentId);
  const { receiptDigest: _receiptDigest, payloadDigest: _payloadDigest, ...base } = current;
  return CallbackIntentObservationReceiptEnvelopeV1Schema.parse(withDigests({
    ...base,
    payload: { ...current.payload, payloadDigest }
  }));
}

function attemptReceipt(input: {
  localIntentId: string;
  localAttemptId: string;
  attemptNumber: number;
  requestDigest: string;
  intentReceiptDigest: string;
  attemptedAt: string;
  outcome: "accepted" | "rejected" | "outcome_unknown";
}) {
  const observedAt = new Date(Date.parse(input.attemptedAt) + 1_000).toISOString();
  const reasonCode = input.outcome === "accepted"
    ? "provider_accepted"
    : input.outcome === "rejected" ? "provider_rejected" : "provider_timeout";
  return CallbackAttemptObservationReceiptEnvelopeV1Schema.parse(withDigests({
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "callback_attempt_observation",
    receiptId: `receipt_${input.localAttemptId}`,
    organizationId: "org_1",
    operationId: `operation_${input.localAttemptId}`,
    requiredCapabilities: ["relay.callback-observation.v1"],
    producer: PRODUCER,
    identity: {
      namespace: "opentag.control.receipt/callback-attempt-observation/v1",
      parts: ["org_1", WORK_THREAD_ID, input.localIntentId, input.localAttemptId]
    },
    predecessorReceiptDigests: [input.intentReceiptDigest],
    observedAt,
    runId: RUN_ID,
    workThreadId: WORK_THREAD_ID,
    payload: {
      localIntentId: input.localIntentId,
      localAttemptId: input.localAttemptId,
      attemptNumber: input.attemptNumber,
      requestDigest: input.requestDigest,
      outcome: input.outcome,
      reasonCode,
      ...(input.outcome === "outcome_unknown"
        ? { nextAction: "reconcile-provider", owner: PRODUCER.id }
        : {}),
      attemptedAt: input.attemptedAt,
      observedAt
    }
  }));
}

function providerReceipt(input: {
  localIntentId: string;
  localAttemptId: string;
  outcome: "accepted" | "rejected" | "outcome_unknown";
  observedAt: string;
  attemptReceiptDigest: string;
  predecessorReceiptDigest?: string;
  resourceIdentity?: string;
  producer?: typeof PRODUCER;
  providerReceiptId?: string;
}) {
  const providerOutcome = input.outcome === "accepted"
    ? "succeeded"
    : input.outcome === "rejected" ? "failed" : "outcome_unknown";
  const reasonCode = input.outcome === "accepted"
    ? "provider_accepted"
    : input.outcome === "rejected" ? "provider_rejected" : "provider_timeout";
  const providerReceiptId = input.providerReceiptId ?? `provider_receipt_${input.localAttemptId}`;
  return CallbackProviderObservationReceiptEnvelopeV1Schema.parse(withDigests({
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "callback_provider_observation",
    receiptId: `receipt_${providerReceiptId}`,
    organizationId: "org_1",
    operationId: `operation_${providerReceiptId}`,
    requiredCapabilities: ["relay.callback-observation.v1"],
    producer: input.producer ?? PRODUCER,
    identity: {
      namespace: "opentag.control.receipt/callback-provider-observation/v1",
      parts: ["org_1", WORK_THREAD_ID, input.localIntentId, input.localAttemptId, providerReceiptId]
    },
    predecessorReceiptDigests: [
      input.predecessorReceiptDigest ?? input.attemptReceiptDigest
    ],
    observedAt: input.observedAt,
    runId: RUN_ID,
    workThreadId: WORK_THREAD_ID,
    payload: {
      localIntentId: input.localIntentId,
      localAttemptId: input.localAttemptId,
      providerReceiptId,
      resourceIdentity: input.resourceIdentity ?? "github:comment:123",
      outcome: providerOutcome,
      reasonCode,
      ...(input.outcome === "outcome_unknown"
        ? { nextAction: "reconcile-provider", owner: PRODUCER.id }
        : {}),
      observedAt: input.observedAt
    }
  }));
}

async function enqueueAndClaim(
  repo: ReturnType<typeof createOpenTagRepository>,
  localIntentId = "intent_1"
) {
  const receipt = intentReceipt(localIntentId);
  await repo.enqueueGovernedCallbackIntent({
    destinationId: "cloud_1",
    runnerId: "runner_1",
    idempotencyKey: `idempotency_${localIntentId}`,
    delivery: governedDelivery(),
    completionOperationId: COMPLETION_OPERATION_ID,
    authority: AUTHORITY,
    receipt,
    now: NOW
  });
  const [claimed] = await repo.claimGovernedCallbackIntents({
    destinationId: "cloud_1",
    organizationId: "org_1",
    leaseOwner: "worker_1",
    leaseSeconds: 30,
    now: NOW
  });
  return { receipt, claimed: claimed! };
}

describe("governed callback ledger", () => {
  it("derives the complete governed enqueue context without mutating durable state", async () => {
    const { sqlite, repo } = await setup();
    const before = sqlite.prepare("SELECT total_changes() AS changes").get();
    await expect(repo.getGovernedCallbackEnqueueContext({
      runId: RUN_ID,
      assessmentId: ASSESSMENT_REF
    })).resolves.toEqual({
      outcome: "ready",
      destinationId: "cloud_1",
      organizationId: "org_1",
      runnerId: "runner_1",
      producer: PRODUCER,
      sourceThreadIdentityDigest: SOURCE_DIGEST,
      assessmentReceipt: ASSESSMENT_RECEIPT,
      completionOperationId: COMPLETION_OPERATION_ID,
      authority: AUTHORITY
    });
    expect(sqlite.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
  });

  it("accepts every supported terminal completion only with matching released attempt evidence", async () => {
    const results: TerminalResult[] = [
      RUN_RESULT,
      { conclusion: "failure", summary: "executor failed locally" },
      {
        conclusion: "needs_human",
        summary: "operator input is required",
        humanResolutionUnavailableReason: "No operator response is available."
      }
    ];
    for (const result of results) {
      const isolated = await setupTerminalResult(result);
      await expect(isolated.repo.getGovernedCallbackEnqueueContext({
        runId: RUN_ID,
        assessmentId: ASSESSMENT_REF
      }), result.conclusion).resolves.toMatchObject({
        outcome: "ready",
        completionOperationId: isolated.operationId,
        assessmentReceipt: isolated.assessmentReceipt,
        authority: AUTHORITY
      });
      isolated.sqlite.close();
    }
  });

  it("fails closed when terminal run or attempt evidence is resurrected or corrupted", async () => {
    const conflicts: Array<{
      name: string;
      mutate: (database: Database.Database) => void;
    }> = [
      {
        name: "run resurrection",
        mutate(database) {
          database.prepare(`UPDATE runs SET status = 'running', assigned_runner_id = 'runner_1',
            current_attempt_id = ? WHERE id = ?`).run(RUN_ATTEMPT_ID, RUN_ID);
        }
      },
      {
        name: "run result digest",
        mutate(database) {
          database.prepare("UPDATE runs SET result_json = ? WHERE id = ?")
            .run(JSON.stringify({ conclusion: "success", summary: "tampered" }), RUN_ID);
        }
      },
      {
        name: "attempt status",
        mutate(database) {
          database.prepare("UPDATE attempts SET status = 'running' WHERE id = ?")
            .run(RUN_ATTEMPT_ID);
        }
      },
      {
        name: "attempt result",
        mutate(database) {
          database.prepare("UPDATE attempts SET result_json = ? WHERE id = ?")
            .run(JSON.stringify({ conclusion: "success", summary: "tampered" }), RUN_ATTEMPT_ID);
        }
      },
      {
        name: "actual attempt runner",
        mutate(database) {
          database.prepare("UPDATE attempts SET runner_id = 'runner_other' WHERE id = ?")
            .run(RUN_ATTEMPT_ID);
        }
      },
      {
        name: "raw fencing token",
        mutate(database) {
          database.prepare("UPDATE attempts SET fencing_token = 'tampered-fence' WHERE id = ?")
            .run(RUN_ATTEMPT_ID);
        }
      }
    ];
    for (const conflict of conflicts) {
      const isolated = await setup();
      conflict.mutate(isolated.sqlite);
      await expect(isolated.repo.getGovernedCallbackEnqueueContext({
        runId: RUN_ID,
        assessmentId: ASSESSMENT_REF
      }), conflict.name).resolves.toEqual({ outcome: "authority_conflict" });
      isolated.sqlite.close();
    }
  });

  it("propagates SQLite infrastructure failures instead of reporting authority conflict", async () => {
    const { sqlite, repo } = await setup();
    sqlite.exec("DROP TABLE attempts");
    await expect(repo.getGovernedCallbackEnqueueContext({
      runId: RUN_ID,
      assessmentId: ASSESSMENT_REF
    })).rejects.toThrow(/no such table: attempts/u);
  });

  it("distinguishes absent enqueue roots from conflicting persisted authority", async () => {
    const { repo } = await setup();
    await expect(repo.getGovernedCallbackEnqueueContext({
      runId: "run_missing",
      assessmentId: ASSESSMENT_REF
    })).resolves.toEqual({ outcome: "not_found" });
    await expect(repo.getGovernedCallbackEnqueueContext({
      runId: RUN_ID,
      assessmentId: "assessment_missing"
    })).resolves.toEqual({ outcome: "authority_conflict" });

    const conflicts: Array<{
      name: string;
      mutate: (database: Database.Database) => void;
    }> = [
      {
        name: "historical assessment",
        mutate(database) {
          database.prepare(
            "UPDATE work_threads SET current_assessment_id = 'assessment_other' WHERE id = ?"
          ).run(WORK_THREAD_ID);
        }
      },
      {
        name: "run work thread mismatch",
        mutate(database) {
          database.prepare("UPDATE runs SET work_thread_id = 'work_thread_other' WHERE id = ?")
            .run(RUN_ID);
        }
      },
      {
        name: "run attempt mismatch",
        mutate(database) {
          database.prepare("UPDATE runs SET current_attempt_id = 'attempt_other' WHERE id = ?")
            .run(RUN_ID);
        }
      },
      {
        name: "run runner mismatch",
        mutate(database) {
          database.prepare("UPDATE runs SET assigned_runner_id = 'runner_other' WHERE id = ?")
            .run(RUN_ID);
        }
      },
      {
        name: "assessment run mismatch",
        mutate(database) {
          const row = database.prepare(
            "SELECT assessment_json AS assessmentJson FROM completion_assessments WHERE id = ?"
          ).get(ASSESSMENT_REF) as { assessmentJson: string };
          database.prepare("UPDATE completion_assessments SET assessment_json = ? WHERE id = ?")
            .run(JSON.stringify({
              ...JSON.parse(row.assessmentJson),
              triggeredByRunId: "run_other"
            }), ASSESSMENT_REF);
        }
      },
      {
        name: "claim authority mismatch",
        mutate(database) {
          database.exec("DROP TRIGGER hosted_claim_authority_shell_immutable_guard");
          database.prepare(
            "UPDATE hosted_claim_operations SET authority_digest = ?"
          ).run(`sha256:${"0".repeat(64)}`);
        }
      },
      {
        name: "claim tenant mismatch",
        mutate(database) {
          database.prepare(
            "UPDATE hosted_claim_operations SET organization_id = 'org_other'"
          ).run();
        }
      },
      {
        name: "claim no longer executable",
        mutate(database) {
          database.prepare(
            "UPDATE hosted_claim_operations SET execution_started_at = NULL"
          ).run();
        }
      },
      {
        name: "completion mismatch",
        mutate(database) {
          database.exec("DROP TRIGGER hosted_lifecycle_operations_immutable_guard");
          database.prepare(
            "UPDATE hosted_lifecycle_operations SET run_id = 'run_other' WHERE action = 'complete'"
          ).run();
        }
      },
      {
        name: "projection tenant mismatch",
        mutate(database) {
          database.exec("DROP TRIGGER control_plane_projection_outbox_immutable_update_guard");
          database.prepare(
            "UPDATE control_plane_projection_outbox SET organization_id = 'org_other' WHERE receipt_id = ?"
          ).run(ASSESSMENT_RECEIPT_ID);
        }
      },
      {
        name: "projection lifecycle mismatch",
        mutate(database) {
          database.exec("DROP TRIGGER control_plane_projection_outbox_immutable_update_guard");
          database.prepare(`UPDATE control_plane_projection_outbox
            SET requires_lifecycle_operation_id = 'operation_other' WHERE receipt_id = ?`)
            .run(ASSESSMENT_RECEIPT_ID);
        }
      },
      {
        name: "projection run mismatch",
        mutate(database) {
          database.exec("DROP TRIGGER control_plane_projection_outbox_immutable_update_guard");
          database.prepare(
            "UPDATE control_plane_projection_outbox SET run_id = 'run_other' WHERE receipt_id = ?"
          ).run(ASSESSMENT_RECEIPT_ID);
        }
      },
      {
        name: "assessment admission policy mismatch",
        mutate(database) {
          const { receiptDigest: _receiptDigest, payloadDigest: _payloadDigest, ...base }
            = ASSESSMENT_RECEIPT;
          const envelope = CompletionAssessmentReceiptEnvelopeV1Schema.parse(withDigests({
            ...base,
            payload: {
              ...ASSESSMENT_RECEIPT.payload,
              admissionPolicySnapshot: {
                ...ASSESSMENT_RECEIPT.payload.admissionPolicySnapshot,
                digest: `sha256:${"0".repeat(64)}`
              }
            }
          }));
          replaceAssessmentProjection(database, envelope);
        }
      }
    ];
    for (const conflict of conflicts) {
      const isolated = await setup();
      conflict.mutate(isolated.sqlite);
      await expect(isolated.repo.getGovernedCallbackEnqueueContext({
        runId: RUN_ID,
        assessmentId: ASSESSMENT_REF
      }), conflict.name).resolves.toEqual({ outcome: "authority_conflict" });
    }
  });

  it("discovers active and recoverable scopes from real callback state transitions", async () => {
    const { sqlite, repo } = await setup();
    const scope = [{ destinationId: "cloud_1", organizationId: "org_1" }];

    const accepted = await enqueueAndClaim(repo, "intent_scope_accepted");
    const acceptedAt = new Date(NOW.getTime() + 1_000);
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: accepted.claimed.intent.localIntentId,
      localAttemptId: accepted.claimed.attempt.localAttemptId,
      leaseToken: accepted.claimed.attempt.leaseToken!,
      now: acceptedAt
    });
    const acceptedAttempt = attemptReceipt({
      localIntentId: accepted.claimed.intent.localIntentId,
      localAttemptId: accepted.claimed.attempt.localAttemptId,
      attemptNumber: accepted.claimed.attempt.attemptNumber,
      requestDigest: accepted.claimed.attempt.requestDigest,
      intentReceiptDigest: accepted.claimed.intentReceiptDigest,
      attemptedAt: acceptedAt.toISOString(),
      outcome: "accepted"
    });
    await repo.finalizeGovernedCallbackAttempt({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: accepted.claimed.intent.localIntentId,
      localAttemptId: accepted.claimed.attempt.localAttemptId,
      leaseToken: accepted.claimed.attempt.leaseToken!,
      attemptReceipt: acceptedAttempt,
      providerReceipt: providerReceipt({
        localIntentId: accepted.claimed.intent.localIntentId,
        localAttemptId: accepted.claimed.attempt.localAttemptId,
        outcome: "accepted",
        observedAt: acceptedAttempt.observedAt,
        attemptReceiptDigest: acceptedAttempt.receiptDigest
      }),
      now: new Date(NOW.getTime() + 2_000)
    });
    await expect(repo.listGovernedCallbackScopes()).resolves.toEqual([]);

    const expiredLeased = await enqueueAndClaim(repo, "intent_scope_expired_leased");
    const expiredSending = await enqueueAndClaim(repo, "intent_scope_expired_sending");
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: expiredSending.claimed.intent.localIntentId,
      localAttemptId: expiredSending.claimed.attempt.localAttemptId,
      leaseToken: expiredSending.claimed.attempt.leaseToken!,
      now: new Date(NOW.getTime() + 1_000)
    });
    await repo.enqueueGovernedCallbackIntent({
      destinationId: "cloud_1",
      runnerId: "runner_1",
      idempotencyKey: "idempotency_intent_scope_nonexpired",
      delivery: governedDelivery(),
      completionOperationId: COMPLETION_OPERATION_ID,
      authority: AUTHORITY,
      receipt: intentReceipt("intent_scope_nonexpired"),
      now: NOW
    });
    const [nonexpired] = await repo.claimGovernedCallbackIntents({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "worker_long_lease",
      leaseSeconds: 300,
      limit: 1,
      now: NOW
    });
    expect(nonexpired?.intent.localIntentId).toBe("intent_scope_nonexpired");
    await expect(repo.listGovernedCallbackScopes()).resolves.toEqual(scope);

    await expect(repo.recoverExpiredGovernedCallbacks({
      destinationId: "cloud_1",
      organizationId: "org_1",
      now: new Date(NOW.getTime() + 31_000)
    })).resolves.toEqual({ requeued: 1, outcomeUnknown: 1 });
    expect(sqlite.prepare(`SELECT state FROM governed_callback_intents
      WHERE local_intent_id = ?`).get(expiredSending.claimed.intent.localIntentId))
      .toEqual({ state: "attention" });
    expect(sqlite.prepare(`SELECT state FROM governed_callback_attempts
      WHERE local_attempt_id = ?`).get(expiredSending.claimed.attempt.localAttemptId))
      .toEqual({ state: "outcome_unknown" });
    expect(sqlite.prepare(`SELECT state FROM governed_callback_intents
      WHERE local_intent_id = ?`).get(nonexpired!.intent.localIntentId))
      .toEqual({ state: "leased" });

    const [reclaimed] = await repo.claimGovernedCallbackIntents({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "worker_restarted",
      leaseSeconds: 30,
      limit: 1,
      now: new Date(NOW.getTime() + 32_000)
    });
    expect(reclaimed?.intent.localIntentId).toBe(expiredLeased.claimed.intent.localIntentId);
    expect(reclaimed?.attempt.localAttemptId).toBe(expiredLeased.claimed.attempt.localAttemptId);
    await expect(repo.listGovernedCallbackScopes()).resolves.toEqual(scope);
  });

  it("rolls governed delivery custody back when intent creation aborts", async () => {
    const { sqlite, repo } = await setup();
    sqlite.exec(`CREATE TRIGGER reject_governed_intent
      BEFORE INSERT ON governed_callback_intents
      BEGIN SELECT RAISE(ABORT, 'injected intent failure'); END;`);
    await expect(repo.enqueueGovernedCallbackIntent({
      destinationId: "cloud_1",
      runnerId: "runner_1",
      idempotencyKey: "atomic_rollback",
      delivery: governedDelivery(),
      completionOperationId: COMPLETION_OPERATION_ID,
      authority: AUTHORITY,
      receipt: intentReceipt("intent_atomic_rollback"),
      now: NOW
    })).rejects.toThrow("injected intent failure");
    expect(sqlite.prepare(
      "SELECT count(*) AS count FROM callback_deliveries WHERE dispatch_mode = 'governed'"
    ).get()).toEqual({ count: 0 });
  });

  it("replays canonically equivalent rich delivery metadata regardless of key order", async () => {
    const { repo } = await setup();
    const canonicalPayload = {
      method: "POST",
      mode: "progress",
      target: DELIVERY_TARGET,
      body: DELIVERY_BODY,
      threadKey: null,
      agentId: null,
      statusMessageKey: null,
      blocks: [{ a: 1, b: 2 }],
      rich: { a: 1, b: 2 }
    };
    const input = {
      destinationId: "cloud_1",
      runnerId: "runner_1",
      idempotencyKey: "canonical_metadata",
      completionOperationId: COMPLETION_OPERATION_ID,
      authority: AUTHORITY,
      receipt: intentReceiptWithPayloadDigest(
        "intent_canonical_metadata",
        canonicalSha256Json(canonicalPayload)
      ),
      now: NOW
    };
    await expect(repo.enqueueGovernedCallbackIntent({
      ...input,
      delivery: { ...governedDelivery(), blocks: [{ a: 1, b: 2 }], rich: { a: 1, b: 2 } }
    })).resolves.toMatchObject({ outcome: "created" });
    await expect(repo.enqueueGovernedCallbackIntent({
      ...input,
      delivery: { ...governedDelivery(), blocks: [{ b: 2, a: 1 }], rich: { b: 2, a: 1 } }
    })).resolves.toMatchObject({ outcome: "replayed" });
  });

  it("keeps governed custody out of legacy claiming and freezes its database roots", async () => {
    const { sqlite, repo } = await setup();
    const { claimed } = await enqueueAndClaim(repo, "intent_custody_guards");
    expect(claimed).toMatchObject({
      delivery: { dispatchMode: "governed", governedState: "leased" },
      producer: PRODUCER,
      intentReceiptDigest: expect.stringMatching(/^sha256:/)
    });
    const legacy = await repo.claimPendingCallbackDeliveries({ limit: 20, now: NOW });
    expect(legacy.every((delivery) => delivery.dispatchMode === "legacy")).toBe(true);
    expect(legacy.some((delivery) => delivery.id === claimed.delivery.id)).toBe(false);
    expect(() => sqlite.prepare(
      "UPDATE governed_callback_intents SET state = 'accepted' WHERE local_intent_id = ?"
    ).run(claimed.intent.localIntentId)).toThrow("invalid governed callback intent state transition");
    expect(() => sqlite.prepare(
      "UPDATE governed_callback_attempts SET request_digest = ? WHERE local_attempt_id = ?"
    ).run(`sha256:${"0".repeat(64)}`, claimed.attempt.localAttemptId))
      .toThrow("governed_callback_attempt_authority_immutable");
    sqlite.prepare("UPDATE governed_callback_attempts SET state = 'sending' WHERE local_attempt_id = ?")
      .run(claimed.attempt.localAttemptId);
    expect(() => sqlite.prepare(
      "UPDATE governed_callback_attempts SET state = 'accepted' WHERE local_attempt_id = ?"
    ).run(claimed.attempt.localAttemptId))
      .toThrow("incomplete governed callback terminal receipt tuple");
    expect(() => sqlite.prepare(`UPDATE governed_callback_attempts SET
      state = 'outcome_unknown', attempt_receipt_id = 'attempt_receipt_direct',
      attempt_receipt_digest = ?, attempt_receipt_json = '{}',
      provider_receipt_id = 'provider_receipt_partial'
      WHERE local_attempt_id = ?`).run(
      `sha256:${"0".repeat(64)}`,
      claimed.attempt.localAttemptId
    )).toThrow("incomplete governed callback terminal receipt tuple");
    expect(() => sqlite.prepare(
      "UPDATE governed_callback_attempts SET attempt_receipt_id = 'late' WHERE local_attempt_id = ?"
    ).run(claimed.attempt.localAttemptId))
      .toThrow("governed callback receipts require sending terminal transition");
    expect(() => sqlite.prepare(
      "UPDATE callback_deliveries SET body = 'mutated' WHERE id = ?"
    ).run(claimed.delivery.id)).toThrow("governed callback delivery custody is immutable");
    expect(() => sqlite.prepare("DELETE FROM governed_callback_intents WHERE local_intent_id = ?")
      .run(claimed.intent.localIntentId)).toThrow("governed_callback_intent_delete_forbidden");
    expect(() => sqlite.prepare("DELETE FROM callback_deliveries WHERE id = ?")
      .run(claimed.delivery.id)).toThrow("governed callback delivery delete forbidden");
  });

  it("keeps exact intent replay and custody-safe V1 rows physically separate from legacy callbacks", async () => {
    const { sqlite, repo } = await setup();
    const receipt = intentReceipt();
    const input = {
      destinationId: "cloud_1",
      runnerId: "runner_1",
      idempotencyKey: "idempotency_1",
      delivery: governedDelivery(),
      completionOperationId: COMPLETION_OPERATION_ID,
      authority: AUTHORITY,
      receipt,
      now: NOW
    };
    await expect(repo.enqueueGovernedCallbackIntent(input)).resolves.toMatchObject({ outcome: "created" });
    await expect(repo.enqueueGovernedCallbackIntent(input)).resolves.toMatchObject({ outcome: "replayed" });
    await expect(repo.enqueueGovernedCallbackIntent({
      ...input,
      delivery: governedDelivery("different body")
    })).rejects.toMatchObject({ code: "GOVERNED_CALLBACK_INVALID" });
    await expect(repo.enqueueGovernedCallbackIntent({
      ...input,
      completionOperationId: `op_${"0".repeat(64)}`
    })).rejects.toMatchObject({ code: "GOVERNED_CALLBACK_CONFLICT" });
    await expect(repo.enqueueGovernedCallbackIntent({
      ...input,
      idempotencyKey: "idempotency_conflict"
    })).rejects.toBeInstanceOf(GovernedCallbackConflictError);
    await repo.enqueueCallbackDelivery({
      runId: RUN_ID,
      kind: "progress",
      provider: "github",
      uri: "https://example.test/callback",
      body: "legacy callback"
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM callback_deliveries").get()).toEqual({ count: 3 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM governed_callback_intents").get()).toEqual({ count: 1 });
    const columns = sqlite.prepare("PRAGMA table_info(governed_callback_intents)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      "uri", "url", "body", "raw_error", "response", "token"
    ]));
    const stored = sqlite.prepare(
      `SELECT intent_receipt_json AS receiptJson,
        local_delivery_id AS localDeliveryId,
        completion_operation_id AS completionOperationId,
        assessment_receipt_id AS assessmentReceiptId,
        assessment_receipt_digest AS assessmentReceiptDigest
      FROM governed_callback_intents`
    ).get() as {
      receiptJson: string;
      localDeliveryId: number;
      completionOperationId: string;
      assessmentReceiptId: string;
      assessmentReceiptDigest: string;
    };
    expect(stored).toMatchObject({
      localDeliveryId: expect.any(Number),
      completionOperationId: COMPLETION_OPERATION_ID,
      assessmentReceiptId: ASSESSMENT_RECEIPT_ID,
      assessmentReceiptDigest: ASSESSMENT_RECEIPT.receiptDigest
    });
    expect(ASSESSMENT_RECEIPT_ID).not.toBe(ASSESSMENT_REF);
    expect(stored.receiptJson).not.toContain("https://");
    expect(stored.receiptJson).not.toContain("legacy callback");
  });

  it("fails closed on missing delivery, completion, assessment, and frozen claim lineage", async () => {
    const cases: Array<{
      name: string;
      mutate: (sqlite: Database.Database) => void;
      input?: { completionOperationId?: string };
      receipt?: (id: string) => ReturnType<typeof intentReceipt>;
    }> = [
      {
        name: "missing completion operation",
        mutate: () => {},
        input: { completionOperationId: `op_${"0".repeat(64)}` }
      },
      {
        name: "non-current assessment",
        mutate: (sqlite) => sqlite.prepare(
          "UPDATE work_threads SET current_assessment_id = 'assessment_other' WHERE id = ?"
        ).run(WORK_THREAD_ID)
      },
      {
        name: "assessment digest mismatch",
        mutate: () => {},
        receipt: (id) => {
          const current = intentReceipt(id);
          const {
            receiptDigest: _receiptDigest,
            payloadDigest: _payloadDigest,
            ...base
          } = current;
          return CallbackIntentObservationReceiptEnvelopeV1Schema.parse(withDigests({
            ...base,
            payload: {
              ...current.payload,
              assessmentDigest: `sha256:${"0".repeat(64)}`
            }
          }));
        }
      },
      {
        name: "assessment predecessor mismatch",
        mutate: () => {},
        receipt: (id) => {
          const current = intentReceipt(id);
          const { receiptDigest: _receiptDigest, payloadDigest: _payloadDigest, ...base } = current;
          return CallbackIntentObservationReceiptEnvelopeV1Schema.parse(withDigests({
            ...base,
            predecessorReceiptDigests: [`sha256:${"0".repeat(64)}`]
          }));
        }
      },
      {
        name: "assessment ref mismatch",
        mutate: () => {},
        receipt: (id) => {
          const current = intentReceipt(id);
          const {
            receiptDigest: _receiptDigest,
            payloadDigest: _payloadDigest,
            ...base
          } = current;
          return CallbackIntentObservationReceiptEnvelopeV1Schema.parse(withDigests({
            ...base,
            payload: { ...current.payload, assessmentRef: "assessment_other" }
          }));
        }
      },
      {
        name: "assessment contract lineage mismatch",
        mutate: (sqlite) => replaceAssessmentProjection(
          sqlite,
          mismatchedAssessmentReceipt("contract")
        ),
        receipt: (id) => intentReceiptForAssessment(
          id,
          mismatchedAssessmentReceipt("contract")
        )
      },
      {
        name: "assessment completion lineage mismatch",
        mutate: (sqlite) => replaceAssessmentProjection(
          sqlite,
          mismatchedAssessmentReceipt("executor")
        ),
        receipt: (id) => intentReceiptForAssessment(
          id,
          mismatchedAssessmentReceipt("executor")
        )
      },
      {
        name: "claim credential",
        mutate: (sqlite) => {
          sqlite.exec("DROP TRIGGER hosted_claim_authority_shell_immutable_guard");
          sqlite.exec("DROP TRIGGER hosted_run_imports_immutable_update_guard");
          sqlite.exec("DROP TRIGGER hosted_attempt_imports_immutable_update_guard");
          sqlite.prepare(
            "UPDATE hosted_claim_operations SET credential_id = 'credential_other'"
          ).run();
        }
      },
      {
        name: "claim attempt number",
        mutate: (sqlite) => {
          sqlite.exec("DROP TRIGGER hosted_claim_authority_shell_immutable_guard");
          sqlite.prepare("UPDATE hosted_claim_operations SET attempt_number = 2").run();
        }
      },
      {
        name: "claim fence",
        mutate: (sqlite) => {
          sqlite.exec("DROP TRIGGER hosted_claim_authority_shell_immutable_guard");
          sqlite.prepare(
            "UPDATE hosted_claim_operations SET fencing_token_digest = ?"
          ).run(`sha256:${"0".repeat(64)}`);
        }
      },
      {
        name: "claim execution not started",
        mutate: (sqlite) => sqlite.prepare(
          "UPDATE hosted_claim_operations SET execution_started_at = NULL"
        ).run()
      },
      {
        name: "authority registration generation",
        mutate: (sqlite) => {
          sqlite.exec("DROP TRIGGER hosted_claim_authority_shell_immutable_guard");
          sqlite.exec("DROP TRIGGER hosted_run_imports_immutable_update_guard");
          sqlite.exec("DROP TRIGGER hosted_attempt_imports_immutable_update_guard");
          const authority = { ...CLAIM_AUTHORITY, registrationGeneration: 2 };
          const authorityJson = canonicalJsonStringify(authority);
          const authorityDigest = canonicalSha256Json(authority);
          sqlite.prepare(
            "UPDATE hosted_run_imports SET authority_json = ?, authority_digest = ?"
          ).run(authorityJson, authorityDigest);
          sqlite.prepare(
            "UPDATE hosted_attempt_imports SET authority_json = ?, authority_digest = ?"
          ).run(authorityJson, authorityDigest);
          sqlite.prepare(
            "UPDATE hosted_claim_operations SET authority_json = ?, authority_digest = ?"
          ).run(authorityJson, authorityDigest);
        }
      }
    ];
    for (const testCase of cases) {
      const { sqlite, repo } = await setup();
      testCase.mutate(sqlite);
      const id = `intent_${testCase.name.replaceAll(" ", "_")}`;
      await expect(repo.enqueueGovernedCallbackIntent({
        destinationId: "cloud_1",
        runnerId: "runner_1",
        idempotencyKey: `idempotency_${id}`,
        delivery: governedDelivery(),
        completionOperationId:
          testCase.input?.completionOperationId ?? COMPLETION_OPERATION_ID,
        authority: AUTHORITY,
        receipt: testCase.receipt?.(id) ?? intentReceipt(id),
        now: NOW
      }), testCase.name).rejects.toMatchObject({
        code: "GOVERNED_CALLBACK_AUTHORITY_CONFLICT"
      });
      sqlite.close();
    }
  });

  it("uses CAS leases, persists sending before I/O, and never reclaims stale sending after restart", async () => {
    const { sqlite, repo } = await setup();
    const { claimed } = await enqueueAndClaim(repo);
    await expect(repo.claimGovernedCallbackIntents({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "worker_2",
      leaseSeconds: 30,
      now: NOW
    })).resolves.toEqual([]);
    const sendingAt = new Date(NOW.getTime() + 1_000);
    await expect(repo.beginGovernedCallbackSending({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      now: sendingAt
    })).resolves.toEqual({ outcome: "sending", attemptedAt: sendingAt.toISOString() });
    expect(sqlite.prepare(
      "SELECT state, attempted_at AS attemptedAt FROM governed_callback_attempts"
    ).get()).toEqual({ state: "sending", attemptedAt: sendingAt.toISOString() });
    await expect(repo.recoverExpiredGovernedCallbacks({
      destinationId: "cloud_1",
      organizationId: "org_1",
      now: new Date(NOW.getTime() + 31_000)
    })).resolves.toEqual({ requeued: 0, outcomeUnknown: 1 });
    const restarted = createOpenTagRepository(drizzle(sqlite));
    await expect(restarted.claimGovernedCallbackIntents({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "worker_2",
      leaseSeconds: 30,
      now: new Date(NOW.getTime() + 32_000)
    })).resolves.toEqual([]);
    expect(sqlite.prepare("SELECT state FROM governed_callback_intents").get()).toEqual({ state: "attention" });
    expect(sqlite.prepare("SELECT state FROM governed_callback_attempts").get()).toEqual({ state: "outcome_unknown" });
    expect(sqlite.prepare(
      "SELECT count(*) AS count FROM control_plane_projection_outbox"
    ).get()).toEqual({ count: 3 });
    await expect(repo.reconcileGovernedCallbackOutcome({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      providerReceipt: providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: "accepted",
        observedAt: new Date(NOW.getTime() + 32_000).toISOString(),
        attemptReceiptDigest: `sha256:${"0".repeat(64)}`,
        providerReceiptId: "provider_receipt_unverified"
      }),
      now: new Date(NOW.getTime() + 32_000)
    })).rejects.toMatchObject({ code: "GOVERNED_CALLBACK_RECONCILIATION_REQUIRED" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM governed_callback_reconciliations").get())
      .toEqual({ count: 0 });
  });

  it("requeues an expired pre-send lease without creating a new attempt", async () => {
    const { sqlite, repo } = await setup();
    const { claimed } = await enqueueAndClaim(repo);
    await expect(repo.recoverExpiredGovernedCallbacks({
      destinationId: "cloud_1",
      organizationId: "org_1",
      now: new Date(NOW.getTime() + 31_000)
    })).resolves.toEqual({ requeued: 1, outcomeUnknown: 0 });
    const [second] = await repo.claimGovernedCallbackIntents({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "worker_2",
      leaseSeconds: 30,
      now: new Date(NOW.getTime() + 32_000)
    });
    expect(second?.attempt).toMatchObject({ attemptNumber: 1 });
    expect(second?.attempt.localAttemptId).toBe(claimed.attempt.localAttemptId);
    const rows = sqlite.prepare(
      "SELECT attempt_number AS attemptNumber, state FROM governed_callback_attempts ORDER BY attempt_number"
    ).all();
    expect(rows).toEqual([
      { attemptNumber: 1, state: "leased" }
    ]);
  });

  it("finalizes accepted atomically and projects intent then attempt then provider", async () => {
    const { sqlite, repo } = await setup();
    const { receipt: intent, claimed } = await enqueueAndClaim(repo);
    const sendingAt = new Date(NOW.getTime() + 1_000);
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      now: sendingAt
    });
    sqlite.prepare("UPDATE work_threads SET current_assessment_id = 'assessment_2' WHERE id = ?")
      .run(WORK_THREAD_ID);
    const attempt = attemptReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      intentReceiptDigest: claimed.intentReceiptDigest,
      attemptedAt: sendingAt.toISOString(),
      outcome: "accepted"
    });
    const provider = providerReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      outcome: "accepted",
      observedAt: attempt.observedAt,
      attemptReceiptDigest: attempt.receiptDigest
    });
    sqlite.exec(`CREATE TRIGGER reject_callback_final_event
      BEFORE INSERT ON run_events
      WHEN NEW.type = 'callback.governed.accepted'
      BEGIN SELECT RAISE(ABORT, 'injected callback finalize failure'); END;`);
    await expect(repo.finalizeGovernedCallbackAttempt({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      attemptReceipt: attempt,
      providerReceipt: provider,
      now: new Date(NOW.getTime() + 2_000)
    })).rejects.toThrow("injected callback finalize failure");
    expect(sqlite.prepare("SELECT state FROM governed_callback_intents").get()).toEqual({ state: "sending" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM control_plane_projection_outbox").get()).toEqual({ count: 2 });
    sqlite.exec("DROP TRIGGER reject_callback_final_event");
    await expect(repo.finalizeGovernedCallbackAttempt({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      attemptReceipt: attempt,
      providerReceipt: provider,
      now: new Date(NOW.getTime() + 2_000)
    })).resolves.toBe("finalized");
    expect(sqlite.prepare("SELECT state FROM governed_callback_intents").get()).toEqual({ state: "accepted" });
    const projections = sqlite.prepare(`SELECT receipt_id AS receiptId,
      depends_on_receipt_id AS dependsOnReceiptId,
      requires_lifecycle_operation_id AS requiresLifecycleOperationId,
      receipt_kind AS receiptKind
      FROM control_plane_projection_outbox ORDER BY created_at, receipt_kind`).all();
    expect(projections).toEqual(expect.arrayContaining([
      {
        receiptId: intent.receiptId,
        dependsOnReceiptId: ASSESSMENT_RECEIPT_ID,
        requiresLifecycleOperationId: COMPLETION_OPERATION_ID,
        receiptKind: "callback_intent_observation"
      },
      {
        receiptId: attempt.receiptId,
        dependsOnReceiptId: intent.receiptId,
        requiresLifecycleOperationId: null,
        receiptKind: "callback_attempt_observation"
      },
      {
        receiptId: provider.receiptId,
        dependsOnReceiptId: attempt.receiptId,
        requiresLifecycleOperationId: null,
        receiptKind: "callback_provider_observation"
      }
    ]));
  });

  it("lets finalize and expired-sending recovery race on persisted state instead of wall clock", async () => {
    const { repo } = await setup();
    const { claimed } = await enqueueAndClaim(repo);
    const sendingAt = new Date(NOW.getTime() + 1_000);
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      now: sendingAt
    });
    const attempt = attemptReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      intentReceiptDigest: claimed.intentReceiptDigest,
      attemptedAt: sendingAt.toISOString(),
      outcome: "accepted"
    });
    await expect(repo.finalizeGovernedCallbackAttempt({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      attemptReceipt: attempt,
      providerReceipt: providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: "accepted",
        observedAt: attempt.observedAt,
        attemptReceiptDigest: attempt.receiptDigest
      }),
      now: new Date(NOW.getTime() + 60_000)
    })).resolves.toBe("finalized");
    await expect(repo.recoverExpiredGovernedCallbacks({
      destinationId: "cloud_1",
      organizationId: "org_1",
      now: new Date(NOW.getTime() + 61_000)
    })).resolves.toEqual({ requeued: 0, outcomeUnknown: 0 });
  });

  it("moves one poisoned due row to attention without rolling back the claim batch", async () => {
    const { sqlite, repo } = await setup();
    for (const id of ["intent_poison", "intent_healthy"]) {
      await repo.enqueueGovernedCallbackIntent({
        destinationId: "cloud_1",
        runnerId: "runner_1",
        idempotencyKey: `idempotency_${id}`,
        delivery: governedDelivery(),
        completionOperationId: COMPLETION_OPERATION_ID,
        authority: AUTHORITY,
        receipt: intentReceipt(id),
        now: NOW
      });
    }
    sqlite.exec("DROP TRIGGER callback_deliveries_governed_immutable_guard");
    sqlite.prepare(`UPDATE callback_deliveries SET body = 'poisoned'
      WHERE id = (SELECT local_delivery_id FROM governed_callback_intents
        WHERE local_intent_id = 'intent_poison')`).run();
    const claimed = await repo.claimGovernedCallbackIntents({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "worker_1",
      leaseSeconds: 30,
      limit: 10,
      now: NOW
    });
    expect(claimed.map((entry) => entry.intent.localIntentId)).toEqual(["intent_healthy"]);
    expect(sqlite.prepare(`SELECT state, last_reason_code AS reason
      FROM governed_callback_intents WHERE local_intent_id = 'intent_poison'`).get())
      .toEqual({ state: "attention", reason: "authority_conflict" });
    expect(sqlite.prepare(`SELECT governed_state AS state FROM callback_deliveries
      WHERE id = (SELECT local_delivery_id FROM governed_callback_intents
        WHERE local_intent_id = 'intent_poison')`).get()).toEqual({ state: "attention" });
  });

  it("quarantines a pending intent bound to terminal delivery without starving healthy work", async () => {
    const { sqlite, repo } = await setup();
    for (const id of ["intent_terminal_poison", "intent_terminal_healthy"]) {
      await repo.enqueueGovernedCallbackIntent({
        destinationId: "cloud_1",
        runnerId: "runner_1",
        idempotencyKey: `idempotency_${id}`,
        delivery: governedDelivery(),
        completionOperationId: COMPLETION_OPERATION_ID,
        authority: AUTHORITY,
        receipt: intentReceipt(id),
        now: NOW
      });
    }
    sqlite.exec("DROP TRIGGER callback_deliveries_governed_state_transition_guard");
    sqlite.prepare(`UPDATE callback_deliveries SET governed_state = 'accepted'
      WHERE id = (SELECT local_delivery_id FROM governed_callback_intents
        WHERE local_intent_id = 'intent_terminal_poison')`).run();
    const claimed = await repo.claimGovernedCallbackIntents({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "worker_1",
      leaseSeconds: 30,
      limit: 10,
      now: NOW
    });
    expect(claimed.map((entry) => entry.intent.localIntentId))
      .toEqual(["intent_terminal_healthy"]);
    expect(sqlite.prepare(`SELECT state FROM governed_callback_intents
      WHERE local_intent_id = 'intent_terminal_poison'`).get()).toEqual({ state: "attention" });
    expect(sqlite.prepare(`SELECT governed_state AS state FROM callback_deliveries
      WHERE id = (SELECT local_delivery_id FROM governed_callback_intents
        WHERE local_intent_id = 'intent_terminal_poison')`).get()).toEqual({ state: "accepted" });
  });

  it("allows only one winner when two database connections claim the same attempt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-governed-callback-"));
    const databasePath = join(directory, "store.sqlite");
    const firstSqlite = new Database(databasePath);
    const secondSqlite = new Database(databasePath);
    try {
      migrateSchema(firstSqlite);
      seedAuthority(firstSqlite);
      const first = createOpenTagRepository(drizzle(firstSqlite));
      const second = createOpenTagRepository(drizzle(secondSqlite));
      await completeAndAcknowledge(first);
      await first.enqueueGovernedCallbackIntent({
        destinationId: "cloud_1",
        runnerId: "runner_1",
        idempotencyKey: "idempotency_two_connections",
        delivery: governedDelivery(),
        completionOperationId: COMPLETION_OPERATION_ID,
        authority: AUTHORITY,
        receipt: intentReceipt("intent_two_connections"),
        now: NOW
      });
      const [left, right] = await Promise.all([
        first.claimGovernedCallbackIntents({
          destinationId: "cloud_1",
          organizationId: "org_1",
          leaseOwner: "worker_left",
          leaseSeconds: 30,
          now: NOW
        }),
        second.claimGovernedCallbackIntents({
          destinationId: "cloud_1",
          organizationId: "org_1",
          leaseOwner: "worker_right",
          leaseSeconds: 30,
          now: NOW
        })
      ]);
      expect(left.length + right.length).toBe(1);
      expect(firstSqlite.prepare("SELECT count(*) AS count FROM governed_callback_attempts").get())
        .toEqual({ count: 1 });
    } finally {
      secondSqlite.close();
      firstSqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["rejected", "outcome_unknown"] as const)(
    "persists and projects a strict %s outcome",
    async (outcome) => {
      const { sqlite, repo } = await setup();
      const { claimed } = await enqueueAndClaim(repo, `intent_${outcome}`);
      const sendingAt = new Date(NOW.getTime() + 1_000);
      await repo.beginGovernedCallbackSending({
        destinationId: "cloud_1",
        organizationId: "org_1",
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        leaseToken: claimed.attempt.leaseToken!,
        now: sendingAt
      });
      const attempt = attemptReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        attemptNumber: claimed.attempt.attemptNumber,
        requestDigest: claimed.attempt.requestDigest,
        intentReceiptDigest: claimed.intentReceiptDigest,
        attemptedAt: sendingAt.toISOString(),
        outcome
      });
      await expect(repo.finalizeGovernedCallbackAttempt({
        destinationId: "cloud_1",
        organizationId: "org_1",
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        leaseToken: claimed.attempt.leaseToken!,
        attemptReceipt: attempt,
        ...(outcome === "rejected" ? {
          providerReceipt: providerReceipt({
            localIntentId: claimed.intent.localIntentId,
            localAttemptId: claimed.attempt.localAttemptId,
            outcome: "rejected",
            observedAt: attempt.observedAt,
            attemptReceiptDigest: attempt.receiptDigest
          })
        } : {}),
        now: new Date(NOW.getTime() + 2_000)
      })).resolves.toBe("finalized");
      expect(sqlite.prepare("SELECT state FROM governed_callback_intents").get()).toEqual({ state: outcome });
      expect(sqlite.prepare("SELECT count(*) AS count FROM control_plane_projection_outbox").get())
        .toEqual({ count: outcome === "rejected" ? 4 : 3 });
    }
  );

  it("fails closed when known provider evidence is missing, predates send, or breaks predecessors", async () => {
    const { repo } = await setup();
    const { claimed } = await enqueueAndClaim(repo, "intent_provider_evidence_guards");
    const sendingAt = new Date(NOW.getTime() + 1_000);
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      now: sendingAt
    });
    const attempt = attemptReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      intentReceiptDigest: claimed.intentReceiptDigest,
      attemptedAt: sendingAt.toISOString(),
      outcome: "rejected"
    });
    const base = {
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      attemptReceipt: attempt,
      now: new Date(NOW.getTime() + 2_000)
    };
    await expect(repo.finalizeGovernedCallbackAttempt(base)).resolves.toBe("stale_lease");
    const predatingProvider = providerReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      outcome: "rejected",
      observedAt: new Date(NOW.getTime() + 500).toISOString(),
      attemptReceiptDigest: attempt.receiptDigest
    });
    await expect(repo.finalizeGovernedCallbackAttempt({
      ...base,
      providerReceipt: predatingProvider
    })).resolves.toBe("stale_lease");
    const { receiptDigest: _receiptDigest, payloadDigest: _payloadDigest, ...attemptBase } = attempt;
    const wrongPredecessor = CallbackAttemptObservationReceiptEnvelopeV1Schema.parse(withDigests({
      ...attemptBase,
      predecessorReceiptDigests: [`sha256:${"0".repeat(64)}`]
    }));
    await expect(repo.finalizeGovernedCallbackAttempt({
      ...base,
      attemptReceipt: wrongPredecessor,
      providerReceipt: providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: "rejected",
        observedAt: attempt.observedAt,
        attemptReceiptDigest: wrongPredecessor.receiptDigest
      })
    })).resolves.toBe("stale_lease");
  });

  it.each(["accepted", "rejected"] as const)(
    "reconciles unknown to %s only from a new chained positive provider receipt",
    async (resolution) => {
      const { sqlite, repo } = await setup();
      const { claimed } = await enqueueAndClaim(repo, `intent_reconcile_${resolution}`);
      const sendingAt = new Date(NOW.getTime() + 1_000);
      await repo.beginGovernedCallbackSending({
        destinationId: "cloud_1", organizationId: "org_1",
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        leaseToken: claimed.attempt.leaseToken!, now: sendingAt
      });
      const unknownAttempt = attemptReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        attemptNumber: claimed.attempt.attemptNumber,
        requestDigest: claimed.attempt.requestDigest,
        intentReceiptDigest: claimed.intentReceiptDigest,
        attemptedAt: sendingAt.toISOString(), outcome: "outcome_unknown"
      });
      const unknownProvider = providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: "outcome_unknown", observedAt: unknownAttempt.observedAt,
        attemptReceiptDigest: unknownAttempt.receiptDigest
      });
      await repo.finalizeGovernedCallbackAttempt({
        destinationId: "cloud_1", organizationId: "org_1",
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        leaseToken: claimed.attempt.leaseToken!, attemptReceipt: unknownAttempt,
        providerReceipt: unknownProvider, now: new Date(NOW.getTime() + 2_000)
      });
      const positive = providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: resolution, observedAt: new Date(NOW.getTime() + 3_000).toISOString(),
        attemptReceiptDigest: unknownAttempt.receiptDigest,
        predecessorReceiptDigest: unknownProvider.receiptDigest,
        providerReceiptId: `provider_receipt_positive_${resolution}`
      });
      const reconcileInput = {
        destinationId: "cloud_1", organizationId: "org_1",
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        providerReceipt: positive,
        now: new Date(NOW.getTime() + 3_000)
      };
      await expect(repo.reconcileGovernedCallbackOutcome(reconcileInput))
        .resolves.toEqual({ outcome: "recorded" });
      await expect(repo.reconcileGovernedCallbackOutcome(reconcileInput))
        .resolves.toEqual({ outcome: "replayed" });
      expect(sqlite.prepare("SELECT state FROM governed_callback_intents").get())
        .toEqual({ state: resolution });
      expect(sqlite.prepare(`SELECT resolution, evidence_digest AS evidenceDigest,
        evidence_json AS evidenceJson FROM governed_callback_reconciliations`).get())
        .toEqual({
          resolution,
          evidenceDigest: positive.receiptDigest,
          evidenceJson: canonicalJsonStringify(positive)
        });
      expect(sqlite.prepare("SELECT count(*) AS count FROM governed_callback_attempts").get())
        .toEqual({ count: 1 });
    }
  );

  it("rejects unknown, unchained, mismatched, stale, and foreign reconciliation receipts", async () => {
    const { sqlite, repo } = await setup();
    const { claimed } = await enqueueAndClaim(repo, "intent_reconcile_rejections");
    const sendingAt = new Date(NOW.getTime() + 1_000);
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1", organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!, now: sendingAt
    });
    const unknownAttempt = attemptReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      intentReceiptDigest: claimed.intentReceiptDigest,
      attemptedAt: sendingAt.toISOString(), outcome: "outcome_unknown"
    });
    const unknownProvider = providerReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      outcome: "outcome_unknown", observedAt: unknownAttempt.observedAt,
      attemptReceiptDigest: unknownAttempt.receiptDigest
    });
    await repo.finalizeGovernedCallbackAttempt({
      destinationId: "cloud_1", organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!, attemptReceipt: unknownAttempt,
      providerReceipt: unknownProvider, now: new Date(NOW.getTime() + 2_000)
    });
    const candidate = (overrides: Partial<Parameters<typeof providerReceipt>[0]> = {}) =>
      providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: "accepted",
        observedAt: new Date(NOW.getTime() + 3_000).toISOString(),
        attemptReceiptDigest: unknownAttempt.receiptDigest,
        predecessorReceiptDigest: unknownProvider.receiptDigest,
        providerReceiptId: "provider_receipt_positive_candidate",
        ...overrides
      });
    const rejected = [
      unknownProvider,
      providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: "outcome_unknown",
        observedAt: new Date(NOW.getTime() + 3_000).toISOString(),
        attemptReceiptDigest: unknownAttempt.receiptDigest,
        predecessorReceiptDigest: unknownProvider.receiptDigest,
        providerReceiptId: "provider_receipt_new_unknown"
      }),
      candidate({ predecessorReceiptDigest: unknownAttempt.receiptDigest }),
      candidate({ resourceIdentity: "github:comment:other", providerReceiptId: "provider_receipt_wrong_resource" }),
      candidate({ observedAt: sendingAt.toISOString(), providerReceiptId: "provider_receipt_stale" }),
      candidate({
        producer: { ...PRODUCER, id: "other_opentag" },
        providerReceiptId: "provider_receipt_foreign_producer"
      })
    ];
    for (const providerObservation of rejected) {
      await expect(repo.reconcileGovernedCallbackOutcome({
        destinationId: "cloud_1", organizationId: "org_1",
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        providerReceipt: providerObservation,
        now: new Date(NOW.getTime() + 3_000)
      })).rejects.toBeInstanceOf(GovernedCallbackConflictError);
    }
    expect(sqlite.prepare("SELECT state FROM governed_callback_intents").get())
      .toEqual({ state: "outcome_unknown" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM governed_callback_reconciliations").get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM governed_callback_attempts").get())
      .toEqual({ count: 1 });
  });

  it("fails closed for non-normalized provider IDs, cross-tenant input, and stale run authority", async () => {
    const { sqlite, repo } = await setup();
    await expect(repo.enqueueGovernedCallbackIntent({
      destinationId: "cloud_1",
      runnerId: "runner_1",
      idempotencyKey: "cross_tenant",
      delivery: governedDelivery(),
      completionOperationId: COMPLETION_OPERATION_ID,
      authority: AUTHORITY,
      receipt: intentReceipt("intent_cross", { organizationId: "org_2" }),
      now: NOW
    })).rejects.toBeInstanceOf(GovernedCallbackConflictError);
    const { claimed } = await enqueueAndClaim(repo);
    const sendingAt = new Date(NOW.getTime() + 1_000);
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      now: sendingAt
    });
    const attempt = attemptReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      intentReceiptDigest: claimed.intentReceiptDigest,
      attemptedAt: sendingAt.toISOString(),
      outcome: "accepted"
    });
    expect(() => providerReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      outcome: "accepted",
      observedAt: attempt.observedAt,
      attemptReceiptDigest: attempt.receiptDigest,
      providerReceiptId: "123"
    })).toThrow();
    sqlite.prepare("UPDATE runs SET repo_provider = 'linear' WHERE id = ?")
      .run(RUN_ID);
    await expect(repo.finalizeGovernedCallbackAttempt({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      attemptReceipt: attempt,
      providerReceipt: providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: "accepted",
        observedAt: attempt.observedAt,
        attemptReceiptDigest: attempt.receiptDigest
      }),
      now: new Date(NOW.getTime() + 2_000)
    })).resolves.toBe("finalized");
    expect(sqlite.prepare("SELECT state FROM governed_callback_intents").get()).toEqual({ state: "accepted" });
  });
});
