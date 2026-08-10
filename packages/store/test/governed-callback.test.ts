import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CallbackAttemptObservationReceiptEnvelopeV1Schema,
  CallbackIntentObservationReceiptEnvelopeV1Schema,
  CallbackProviderObservationReceiptEnvelopeV1Schema,
  CompletionAssessmentReceiptEnvelopeV1Schema,
  CompletionContractRefReceiptEnvelopeV1Schema,
  CompletionEvidenceObservationReceiptEnvelopeV1Schema,
  HostedCompleteRequestV1Schema,
  HostedLifecycleReceiptEnvelopeV1Schema,
  OpenTagEventSchema,
  WorkThreadRefReceiptEnvelopeV1Schema,
  canonicalJsonStringify
} from "@opentag/core";
import { evaluateCompletion } from "@opentag/governance";
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
const DELIVERY_TARGET = "https://api.github.com/repos/acme/demo/issues/1/comments";
const TARGET_IDENTITY_DIGEST = canonicalSha256Json({
  provider: "github",
  owner: "acme",
  repo: "demo",
  issueNumber: 1
});
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
const PRODUCER = {
  kind: "local_opentag" as const,
  id: "runner_1",
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

const COMPLETION_CONTRACT = {
  id: "contract_1",
  version: 1,
  workThreadId: WORK_THREAD_ID,
  cycle: 1,
  mode: "governed" as const,
  targetSelectors: [{
    key: "primary_change",
    kind: "change_request" as const,
    lineage: "current_cycle" as const,
    cardinality: "exactly_one" as const
  }],
  resolvedFrom: [],
  gates: [{
    id: "checks",
    kind: "verification" as const,
    targetKey: "primary_change",
    evidenceKind: "test",
    requiredOutcome: "passed" as const,
    minimumAssurance: "reported" as const
  }],
  maxAutomaticRetries: 0,
  onSatisfied: "report_only" as const,
  createdAt: NOW.toISOString()
};
const CONTRACT_CONTENT_DIGEST = `sha256:${createHash("sha256")
  .update(JSON.stringify(COMPLETION_CONTRACT)).digest("hex")}`;
const COMPLETION_ASSESSMENT = {
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
    provider: "github" as const,
    resourceRef: "github:acme/demo:pull_request:1",
    resourceVersion: "abc123",
    artifactId: "artifact_1"
  }],
  state: "satisfied" as const,
  evidenceBacked: true,
  gateResults: [{
    gateId: "checks",
    targetKey: "primary_change",
    state: "passed" as const,
    evidenceIds: ["evidence_1"],
    reasonCode: "verification_passed" as const,
    reason: "Required verification passed.",
    evaluatedAt: NOW.toISOString()
  }],
  assessedAt: NOW.toISOString(),
  assessedBy: "opentag" as const,
  acceptedAt: NOW.toISOString()
};
const COMPLETION_FACT = {
  id: "evidence_1",
  workThreadId: WORK_THREAD_ID,
  cycle: 1,
  kind: "test",
  assurance: "verified" as const,
  subject: {
    provider: "github",
    resourceRef: "github:acme/demo:pull_request:1",
    resourceVersion: "abc123"
  },
  claim: {
    predicate: "result",
    outcome: "passed"
  },
  provenance: {
    adapter: "governed-callback-test",
    adapterVersion: "1",
    payloadDigest: EVIDENCE_DIGEST,
    providerDeliveryId: "delivery_evidence_1"
  },
  observedAt: NOW.toISOString(),
  receivedAt: NOW.toISOString()
};
const VERIFICATION_EVIDENCE = {
  id: COMPLETION_FACT.id,
  kind: COMPLETION_FACT.kind,
  assurance: COMPLETION_FACT.assurance,
  subjectRef: `${COMPLETION_FACT.subject.resourceRef}@${COMPLETION_FACT.subject.resourceVersion}`,
  summary: "The required verification passed for the assessed revision.",
  createdAt: COMPLETION_FACT.observedAt,
  metadata: { completionFact: COMPLETION_FACT }
};
const ASSESSMENT_IDENTITY = {
  namespace: "opentag.control.receipt/completion-assessment/v1" as const,
  parts: ["org_1", WORK_THREAD_ID, ASSESSMENT_REF]
};
const ASSESSMENT_PROJECTION_KEY = canonicalSha256Json({
  purpose: "opentag-completion-assessment-projection-v1",
  identity: ASSESSMENT_IDENTITY
}).slice("sha256:".length);
const ASSESSMENT_RECEIPT_ID = `assessment_receipt_${ASSESSMENT_PROJECTION_KEY}`;
const LOCAL_WORK_THREAD_CREATION_AUTHORITY = {
  schemaVersion: 1,
  kind: "work_thread_created",
  workThreadId: WORK_THREAD_ID,
  scopeId: "scope_1",
  canonicalKey: "thread_key_1",
  provider: "github",
  ownerContainerId: "owner_1",
  workItemKind: "issue",
  externalId: "1",
  createdAt: NOW.toISOString()
};
const LOCAL_WORK_THREAD_CREATION_DIGEST = canonicalSha256Json(
  LOCAL_WORK_THREAD_CREATION_AUTHORITY
);
const WORK_THREAD_RECEIPT_IDENTITY = {
  namespace: "opentag.control.receipt/work-thread-ref/v1" as const,
  parts: ["org_1", RUN_ID, WORK_THREAD_ID]
};
const WORK_THREAD_PROJECTION_KEY = canonicalSha256Json({
  purpose: "opentag-work-thread-ref-projection-v1",
  identity: WORK_THREAD_RECEIPT_IDENTITY
}).slice("sha256:".length);
const WORK_THREAD_RECEIPT = WorkThreadRefReceiptEnvelopeV1Schema.parse(withDigests({
  schemaVersion: 1,
  protocolVersion: "1.0",
  receiptKind: "work_thread_ref",
  receiptId: `work_thread_receipt_${WORK_THREAD_PROJECTION_KEY}`,
  organizationId: "org_1",
  operationId: `work_thread_operation_${WORK_THREAD_PROJECTION_KEY}`,
  requiredCapabilities: ["relay.work-thread-ref.v1"],
  producer: PRODUCER,
  identity: WORK_THREAD_RECEIPT_IDENTITY,
  predecessorReceiptDigests: [
    canonicalSha256Json(CLAIM_AUTHORITY),
    CLAIM_AUTHORITY.admissionPolicySnapshotDigest
  ].sort(),
  observedAt: NOW.toISOString(),
  runId: RUN_ID,
  workThreadId: WORK_THREAD_ID,
  payload: {
    workThreadId: WORK_THREAD_ID,
    sourceIdentityDigest: SOURCE_DIGEST,
    localCreationReceiptId: `local_work_thread_creation_${LOCAL_WORK_THREAD_CREATION_DIGEST
      .slice("sha256:".length)}`,
    localCreationReceiptDigest: LOCAL_WORK_THREAD_CREATION_DIGEST,
    lineageKind: "hosted_source_identity",
    hostedAuthorityRef: {
      claimOperationId: CLAIM_OPERATION_ID,
      authorityDigest: canonicalSha256Json(CLAIM_AUTHORITY),
      attempt: COMPLETION_COMMON.attempt,
      admissionPolicySnapshot: {
        receiptId: CLAIM_AUTHORITY.admissionPolicyReceiptId,
        snapshotId: CLAIM_AUTHORITY.admissionPolicySnapshotId,
        digest: CLAIM_AUTHORITY.admissionPolicySnapshotDigest
      }
    },
    createdAt: NOW.toISOString()
  }
}));
const CONTRACT_RECEIPT_IDENTITY = {
  namespace: "opentag.control.receipt/completion-contract-ref/v1" as const,
  parts: ["org_1", RUN_ID, WORK_THREAD_ID, COMPLETION_CONTRACT.id, "1", "1"]
};
const CONTRACT_PROJECTION_KEY = canonicalSha256Json({
  purpose: "opentag-completion-contract-ref-projection-v1",
  identity: CONTRACT_RECEIPT_IDENTITY
}).slice("sha256:".length);
const CONTRACT_RECEIPT = CompletionContractRefReceiptEnvelopeV1Schema.parse(withDigests({
  schemaVersion: 1,
  protocolVersion: "1.0",
  receiptKind: "completion_contract_ref",
  receiptId: `completion_contract_receipt_${CONTRACT_PROJECTION_KEY}`,
  organizationId: "org_1",
  operationId: `completion_contract_operation_${CONTRACT_PROJECTION_KEY}`,
  requiredCapabilities: ["relay.completion-contract-ref.v1"],
  producer: PRODUCER,
  identity: CONTRACT_RECEIPT_IDENTITY,
  predecessorReceiptDigests: [WORK_THREAD_RECEIPT.receiptDigest],
  observedAt: NOW.toISOString(),
  runId: RUN_ID,
  workThreadId: WORK_THREAD_ID,
  payload: {
    contractId: COMPLETION_CONTRACT.id,
    version: COMPLETION_CONTRACT.version,
    cycle: COMPLETION_CONTRACT.cycle,
    mode: COMPLETION_CONTRACT.mode,
    contentDigest: CONTRACT_CONTENT_DIGEST,
    resolvedTargetDigests: [],
    requiredGateIds: COMPLETION_CONTRACT.gates.map((gate) => gate.id).sort(),
    createdAt: COMPLETION_CONTRACT.createdAt
  }
}));
const EVIDENCE_PAYLOAD = {
  evidenceType: "verification_evidence" as const,
  evidenceId: COMPLETION_FACT.id,
  authorityDigest: canonicalSha256Json(COMPLETION_FACT),
  evidenceKind: COMPLETION_FACT.kind,
  assurance: COMPLETION_FACT.assurance,
  subject: COMPLETION_FACT.subject,
  claim: {
    predicate: COMPLETION_FACT.claim.predicate,
    outcome: COMPLETION_FACT.claim.outcome
  },
  provenancePayloadDigest: COMPLETION_FACT.provenance.payloadDigest,
  observedAt: COMPLETION_FACT.observedAt,
  receivedAt: COMPLETION_FACT.receivedAt
};
const EVIDENCE_RECEIPT_IDENTITY = {
  namespace: "opentag.control.receipt/completion-evidence-observation/v1" as const,
  parts: [
    "org_1",
    WORK_THREAD_ID,
    RUN_ID,
    EVIDENCE_PAYLOAD.evidenceType,
    EVIDENCE_PAYLOAD.evidenceId,
    EVIDENCE_PAYLOAD.authorityDigest,
    CONTRACT_RECEIPT.receiptDigest
  ]
};
const EVIDENCE_PROJECTION_KEY = canonicalSha256Json({
  purpose: "opentag-completion-evidence-projection-v1",
  identity: EVIDENCE_RECEIPT_IDENTITY
}).slice("sha256:".length);
const EVIDENCE_RECEIPT = CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
  withDigests({
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "completion_evidence_observation",
    receiptId: `completion_evidence_receipt_${EVIDENCE_PROJECTION_KEY}`,
    organizationId: "org_1",
    operationId: `completion_evidence_operation_${EVIDENCE_PROJECTION_KEY}`,
    requiredCapabilities: ["relay.completion-evidence.v1"],
    producer: PRODUCER,
    identity: EVIDENCE_RECEIPT_IDENTITY,
    predecessorReceiptDigests: [
      COMPLETION_RECEIPT.receiptDigest,
      CONTRACT_RECEIPT.receiptDigest
    ].sort(),
    observedAt: COMPLETION_FACT.observedAt,
    runId: RUN_ID,
    workThreadId: WORK_THREAD_ID,
    attempt: COMPLETION_COMMON.attempt,
    payload: EVIDENCE_PAYLOAD
  })
);

const ASSESSMENT_RECEIPT = CompletionAssessmentReceiptEnvelopeV1Schema.parse(withDigests({
  schemaVersion: 1,
  protocolVersion: "1.0",
  receiptKind: "completion_assessment",
  receiptId: ASSESSMENT_RECEIPT_ID,
  organizationId: "org_1",
  operationId: `assessment_operation_${ASSESSMENT_PROJECTION_KEY}`,
  requiredCapabilities: ["relay.completion-assessment.v1"],
  producer: PRODUCER,
  identity: ASSESSMENT_IDENTITY,
  predecessorReceiptDigests: [
    COMPLETION_RECEIPT.receiptDigest,
    CONTRACT_RECEIPT.receiptDigest,
    EVIDENCE_RECEIPT.receiptDigest
  ].sort(),
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
      mode: "governed",
      contentDigest: CONTRACT_CONTENT_DIGEST
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
    evidenceReceiptDigests: [EVIDENCE_RECEIPT.receiptDigest],
    gateResults: [{
      gateId: "checks",
      state: "satisfied",
      reasonCode: "verification_passed",
      evidenceReceiptDigests: [EVIDENCE_RECEIPT.receiptDigest]
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

function seedAuthority(
  sqlite: Database.Database,
  options: {
    includeAssessment?: boolean;
    includeAssessmentProjection?: boolean;
  } = {}
): void {
  const authorityJson = canonicalJsonStringify(CLAIM_AUTHORITY);
  const authorityDigest = canonicalSha256Json(CLAIM_AUTHORITY);
  const claimDigest = `sha256:${"d".repeat(64)}`;
  const event = OpenTagEventSchema.parse({
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
  const eventJson = JSON.stringify(event);
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
      canonicalSha256Json(event),
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
    .run(
      WORK_THREAD_ID,
      options.includeAssessment === false ? null : ASSESSMENT_REF,
      NOW.toISOString(),
      NOW.toISOString()
    );
  sqlite.prepare(`INSERT INTO completion_contracts (
    id, version, work_thread_id, cycle, contract_json, content_digest, created_at
  ) VALUES ('contract_1', 1, ?, 1, ?, ?, ?)`)
    .run(
      WORK_THREAD_ID,
      JSON.stringify(COMPLETION_CONTRACT),
      CONTRACT_CONTENT_DIGEST,
      NOW.toISOString()
    );
  sqlite.prepare(`INSERT INTO verification_evidence (
    id, work_thread_id, provider, delivery_id, subject_ref, subject_version,
    kind, assurance, evidence_json, payload_digest, observed_at, received_at
  ) VALUES (?, ?, 'github', 'delivery_evidence_1',
    'github:acme/demo:pull_request:1', 'abc123', ?, ?, ?, ?, ?, ?)`).run(
      VERIFICATION_EVIDENCE.id,
      WORK_THREAD_ID,
      VERIFICATION_EVIDENCE.kind,
      VERIFICATION_EVIDENCE.assurance,
      JSON.stringify(VERIFICATION_EVIDENCE),
      EVIDENCE_DIGEST,
      NOW.toISOString(),
      NOW.toISOString()
    );
  if (options.includeAssessment !== false) sqlite.prepare(`INSERT INTO completion_assessments (
    id, work_thread_id, contract_id, contract_version, cycle, sequence,
    input_digest, state, assessment_json, created_at
  ) VALUES (?, ?, 'contract_1', 1, 1, 1, ?, 'satisfied', ?, ?)`)
    .run(
      ASSESSMENT_REF,
      WORK_THREAD_ID,
      EVIDENCE_DIGEST,
      JSON.stringify(COMPLETION_ASSESSMENT),
      NOW.toISOString()
    );
  if (
    options.includeAssessment !== false
    && options.includeAssessmentProjection === true
  ) sqlite.prepare(`INSERT INTO control_plane_projection_outbox (
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
  seedAuthority(sqlite, { includeAssessmentProjection: false });
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
  const escalationRow = (sqlite.prepare(`SELECT escalation_json AS escalationJson
    FROM human_escalations ORDER BY id`).all() as Array<{
      escalationJson: string;
    }>).find((row) => JSON.parse(row.escalationJson).runId === RUN_ID);
  const activeEscalation = escalationRow
    ? JSON.parse(escalationRow.escalationJson) as {
        id: string;
        reason: string;
        openedAt: string;
      }
    : undefined;
  const { acceptedAt: _acceptedAt, ...assessmentWithoutAcceptance } = COMPLETION_ASSESSMENT;
  const terminalAssessment = activeEscalation
    ? {
          ...assessmentWithoutAcceptance,
          state: "blocked" as const,
          gateResults: [
            ...COMPLETION_ASSESSMENT.gateResults,
            {
              gateId: `human_escalation:${activeEscalation.id}`,
              state: "unknown" as const,
              evidenceIds: [activeEscalation.id],
              reasonCode: "human_acceptance_missing" as const,
              reason: activeEscalation.reason,
              evaluatedAt: activeEscalation.openedAt
            }
          ]
        }
    : COMPLETION_ASSESSMENT;
  sqlite.prepare(`UPDATE completion_assessments
    SET state = ?, assessment_json = ? WHERE id = ?`).run(
      terminalAssessment.state,
      JSON.stringify(terminalAssessment),
      ASSESSMENT_REF
    );
  const claimedAt = new Date(Math.max(Date.now(), NOW.getTime()) + 1_000);
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
  const assessmentProjection = sqlite.prepare(`SELECT envelope_json AS envelopeJson
    FROM control_plane_projection_outbox
    WHERE receipt_kind = 'completion_assessment'`).get() as { envelopeJson: string };
  const assessmentReceipt = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
    JSON.parse(assessmentProjection.envelopeJson)
  );
  return { sqlite, repo, ...fixtures, assessmentReceipt };
}

async function setupCompatibilityTerminal(result: TerminalResult) {
  const sqlite = new Database(":memory:");
  migrateSchema(sqlite);
  seedAuthority(sqlite, {
    includeAssessment: false,
    includeAssessmentProjection: false
  });
  const contract = {
    ...COMPLETION_CONTRACT,
    mode: "execution_compat" as const,
    targetSelectors: [],
    gates: [{
      id: "execution",
      kind: "material_action" as const,
      actionFamily: "executor_run",
      requiredOutcome: "succeeded" as const
    }]
  };
  const contentDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(contract)).digest("hex")}`;
  sqlite.prepare(`UPDATE completion_contracts
    SET contract_json = ?, content_digest = ?
    WHERE id = ? AND version = ?`).run(
      JSON.stringify(contract),
      contentDigest,
      contract.id,
      contract.version
    );
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
  const claimedAt = new Date(Math.max(Date.now(), NOW.getTime()) + 1_000);
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
  return { sqlite, repo, contract, contentDigest, ...fixtures };
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
  outcome: "accepted" | "rejected" | "outcome_unknown" | "attention";
}) {
  const observedAt = new Date(Date.parse(input.attemptedAt) + 1_000).toISOString();
  const reasonCode = input.outcome === "accepted"
    ? "provider_accepted"
    : input.outcome === "rejected"
      ? "provider_rejected"
      : input.outcome === "attention" ? "callback_sink_unhandled" : "provider_timeout";
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
      ...(input.outcome === "outcome_unknown" || input.outcome === "attention"
        ? {
            nextAction: input.outcome === "attention"
              ? "repair-local-callback"
              : "reconcile-provider",
            owner: PRODUCER.id
          }
        : {}),
      attemptedAt: input.attemptedAt,
      observedAt
    }
  }));
}

function providerReceipt(input: {
  localIntentId: string;
  localAttemptId: string;
  outcome: "accepted" | "rejected";
  observedAt: string;
  attemptReceiptDigest: string;
  predecessorReceiptDigest?: string;
  resourceIdentity?: string;
  producer?: typeof PRODUCER;
  providerReceiptId?: string;
  targetIdentityDigest?: string;
}) {
  const providerOutcome = input.outcome === "accepted" ? "succeeded" : "failed";
  const reasonCode = input.outcome === "accepted"
    ? "provider_accepted"
    : "provider_rejected";
  const providerReceiptId = input.providerReceiptId
    ?? (input.outcome === "accepted" ? "comment_123" : `provider_receipt_${input.localAttemptId}`);
  const acceptedCommentId = /^comment_([1-9][0-9]*)$/u.exec(providerReceiptId)?.[1];
  const envelopeId = canonicalSha256Json({
    providerReceiptId,
    localAttemptId: input.localAttemptId
  }).slice("sha256:".length, "sha256:".length + 32);
  return CallbackProviderObservationReceiptEnvelopeV1Schema.parse(withDigests({
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "callback_provider_observation",
    receiptId: `receipt_provider_${envelopeId}`,
    organizationId: "org_1",
    operationId: `operation_provider_${envelopeId}`,
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
      resourceIdentity: input.resourceIdentity
        ?? (input.outcome === "accepted"
          ? `github:comment:${acceptedCommentId ?? "123"}`
          : "github:issue:1"),
      targetIdentityDigest: input.targetIdentityDigest ?? TARGET_IDENTITY_DIGEST,
      outcome: providerOutcome,
      reasonCode,
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

function expectGeneratedAssessmentProjection(sqlite: Database.Database): void {
  const rows = sqlite.prepare(`SELECT
    destination_id AS destinationId,
    organization_id AS organizationId,
    requires_lifecycle_operation_id AS requiresLifecycleOperationId,
    envelope_json AS envelopeJson
    FROM control_plane_projection_outbox
    WHERE receipt_kind = 'completion_assessment'`).all() as Array<{
      destinationId: string;
      organizationId: string;
      requiresLifecycleOperationId: string;
      envelopeJson: string;
    }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    destinationId: "cloud_1",
    organizationId: "org_1",
    requiresLifecycleOperationId: COMPLETION_OPERATION_ID
  });
  const envelope = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
    JSON.parse(rows[0]!.envelopeJson)
  );
  expect(envelope).toEqual(ASSESSMENT_RECEIPT);
  expect(envelope.payloadDigest).toBe(canonicalSha256Json(envelope.payload));
  const { receiptDigest: _receiptDigest, ...base } = envelope;
  expect(envelope.receiptDigest).toBe(canonicalSha256Json(base));
}

function assessmentProjectionEnvelopes(
  sqlite: Database.Database
): Array<ReturnType<typeof CompletionAssessmentReceiptEnvelopeV1Schema.parse>> {
  return (sqlite.prepare(`SELECT envelope_json AS envelopeJson
    FROM control_plane_projection_outbox
    WHERE receipt_kind = 'completion_assessment'
    ORDER BY created_at, receipt_id`).all() as Array<{ envelopeJson: string }>)
    .map((row) => CompletionAssessmentReceiptEnvelopeV1Schema.parse(
      JSON.parse(row.envelopeJson)
    ));
}

function insertCompletionFact(
  sqlite: Database.Database,
  input: {
    id: string;
    outcome: string;
    observedAt: string;
    receivedAt?: string;
    cycle?: number;
    kind?: string;
    predicate?: string;
  }
) {
  const deliveryId = `delivery_${input.id}`;
  const payloadDigest = canonicalSha256Json({
    purpose: "governed-callback-test-evidence",
    evidenceId: input.id
  });
  const fact = {
    ...COMPLETION_FACT,
    id: input.id,
    cycle: input.cycle ?? COMPLETION_FACT.cycle,
    kind: input.kind ?? COMPLETION_FACT.kind,
    claim: {
      ...COMPLETION_FACT.claim,
      predicate: input.predicate ?? COMPLETION_FACT.claim.predicate,
      outcome: input.outcome
    },
    provenance: {
      ...COMPLETION_FACT.provenance,
      payloadDigest,
      providerDeliveryId: deliveryId
    },
    observedAt: input.observedAt,
    receivedAt: input.receivedAt ?? input.observedAt
  };
  const evidence = {
    ...VERIFICATION_EVIDENCE,
    id: fact.id,
    kind: fact.kind,
    createdAt: fact.observedAt,
    metadata: { completionFact: fact }
  };
  sqlite.prepare(`INSERT INTO verification_evidence (
    id, work_thread_id, provider, delivery_id, subject_ref, subject_version,
    kind, assurance, evidence_json, payload_digest, observed_at, received_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    fact.id,
    WORK_THREAD_ID,
    fact.subject.provider,
    deliveryId,
    fact.subject.resourceRef,
    fact.subject.resourceVersion,
    fact.kind,
    fact.assurance,
    JSON.stringify(evidence),
    payloadDigest,
    fact.observedAt,
    fact.receivedAt
  );
  return fact;
}

function rejectedAssessmentMutationSnapshot(
  sqlite: Database.Database
): string {
  return JSON.stringify({
    assessments: sqlite.prepare(`SELECT * FROM completion_assessments
      ORDER BY id`).all(),
    threadHead: sqlite.prepare(`SELECT current_assessment_id AS currentAssessmentId
      FROM work_threads WHERE id = ?`).get(WORK_THREAD_ID),
    outbox: sqlite.prepare(`SELECT * FROM control_plane_projection_outbox
      ORDER BY receipt_id`).all(),
    governance: sqlite.prepare(`SELECT * FROM governance_events
      ORDER BY id`).all(),
    callbackIntents: sqlite.prepare(`SELECT * FROM governed_callback_intents
      ORDER BY local_intent_id`).all(),
    callbackDeliveries: sqlite.prepare(`SELECT * FROM callback_deliveries
      ORDER BY id`).all()
  });
}

function durableCompletionChainFixture(sqlite: Database.Database): string {
  const rows = sqlite.prepare(`SELECT
    receipt_id AS receiptId,
    receipt_kind AS receiptKind,
    depends_on_receipt_id AS dependsOnReceiptId,
    requires_lifecycle_operation_id AS requiresLifecycleOperationId,
    envelope_json AS envelopeJson
    FROM control_plane_projection_outbox
    WHERE run_id = ?
    ORDER BY receipt_id`).all(RUN_ID) as Array<{
      receiptId: string;
      receiptKind: string;
      dependsOnReceiptId: string | null;
      requiresLifecycleOperationId: string;
      envelopeJson: string;
    }>;
  const byParent = new Map<string | null, typeof rows>();
  for (const row of rows) {
    byParent.set(row.dependsOnReceiptId, [
      ...(byParent.get(row.dependsOnReceiptId) ?? []),
      row
    ]);
  }
  const ordered: typeof rows = [];
  let parent: string | null = null;
  while (ordered.length < rows.length) {
    const children = byParent.get(parent) ?? [];
    if (children.length !== 1) {
      throw new Error("fixture_completion_chain_is_not_linear");
    }
    const [child] = children;
    ordered.push(child!);
    parent = child!.receiptId;
  }
  const entries = ordered.map((row, index) => ({
    ordinal: index + 1,
    receiptId: row.receiptId,
    receiptKind: row.receiptKind,
    dependsOnReceiptId: row.dependsOnReceiptId,
    requiresLifecycleOperationId: row.requiresLifecycleOperationId,
    envelope: JSON.parse(row.envelopeJson) as unknown
  }));
  return `${JSON.stringify({
    schemaVersion: 1,
    fixtureKind: "opentag.control.store-completion-chain/v1",
    chainDigest: canonicalSha256Json(entries),
    entries
  }, null, 2)}\n`;
}

describe("governed callback ledger", () => {
  it("matches the frozen Store-produced completion chain fixture byte for byte", async () => {
    const { sqlite } = await setup();
    const actual = durableCompletionChainFixture(sqlite);
    const expected = readFileSync(
      new URL("./fixtures/control-v1-store-completion-chain.json", import.meta.url),
      "utf8"
    );
    expect(actual).toBe(expected);
    sqlite.close();
  });

  it("claims the completion chain in dependency order across repository restarts", async () => {
    const initialized = await setup();
    const { sqlite } = initialized;
    let repo = initialized.repo;
    const expectedKinds = [
      "work_thread_ref",
      "completion_contract_ref",
      "completion_evidence_observation",
      "completion_assessment"
    ];
    const claimedKinds: string[] = [];
    const startedAt = Math.max(Date.now(), NOW.getTime()) + 10_000;
    for (const [index, expectedKind] of expectedKinds.entries()) {
      const claimAt = new Date(startedAt + index * 2_000);
      const claim = await repo.claimDueControlPlaneProjections({
        destinationId: "cloud_1",
        organizationId: "org_1",
        leaseOwner: `projection_pump_${index}`,
        leaseSeconds: 30,
        limit: 10,
        now: claimAt
      });
      expect(claim.rejected).toEqual([]);
      expect(claim.entries).toHaveLength(1);
      expect(claim.entries[0]?.receiptKind).toBe(expectedKind);
      claimedKinds.push(claim.entries[0]!.receiptKind);
      await expect(repo.acknowledgeControlPlaneProjection({
        destinationId: "cloud_1",
        organizationId: "org_1",
        receiptId: claim.entries[0]!.receiptId,
        leaseToken: claim.entries[0]!.leaseToken!,
        httpStatus: 200,
        now: new Date(claimAt.getTime() + 1_000)
      })).resolves.toMatchObject({ outcome: "acknowledged" });
      repo = createOpenTagRepository(drizzle(sqlite));
    }
    expect(claimedKinds).toEqual(expectedKinds);
    const beforeReplay = JSON.stringify(sqlite.prepare(`SELECT *
      FROM control_plane_projection_outbox ORDER BY receipt_id`).all());
    await expect(repo.appendCompletionAssessment({
      assessment: COMPLETION_ASSESSMENT,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "duplicate" });
    expect(JSON.stringify(sqlite.prepare(`SELECT *
      FROM control_plane_projection_outbox ORDER BY receipt_id`).all()))
      .toBe(beforeReplay);
    await expect(repo.claimDueControlPlaneProjections({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "projection_pump_done",
      leaseSeconds: 30,
      limit: 10,
      now: new Date(startedAt + 20_000)
    })).resolves.toEqual({ entries: [], rejected: [] });
    sqlite.close();
  });

  it("materializes every hosted assessment in lineage order when complete is acknowledged late", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));

    await expect(repo.appendCompletionAssessment({
      assessment: COMPLETION_ASSESSMENT,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const assessmentB = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_2",
      sequence: 2,
      supersedesAssessmentId: COMPLETION_ASSESSMENT.id,
      inputDigest: `sha256:${"2".repeat(64)}`,
      assessedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      acceptedAt: COMPLETION_ASSESSMENT.acceptedAt
    };
    await expect(repo.appendCompletionAssessment({
      assessment: assessmentB,
      expectedCurrentAssessmentId: COMPLETION_ASSESSMENT.id
    })).resolves.toMatchObject({ outcome: "recorded" });
    expect(sqlite.prepare(`SELECT count(*) AS count
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_assessment'`).get()).toEqual({ count: 0 });

    await completeAndAcknowledge(repo);
    const projected = assessmentProjectionEnvelopes(sqlite);
    expect(projected).toHaveLength(2);
    expect(projected.map((envelope) => envelope.payload.assessmentId).sort())
      .toEqual([COMPLETION_ASSESSMENT.id, assessmentB.id]);
    const projectedB = projected.find((envelope) =>
      envelope.payload.assessmentId === assessmentB.id
    );
    expect(projectedB?.payload.supersedesAssessmentId)
      .toBe(COMPLETION_ASSESSMENT.id);
    const lineageRows = sqlite.prepare(`SELECT
      receipt_id AS receiptId,
      receipt_kind AS receiptKind,
      depends_on_receipt_id AS dependsOnReceiptId,
      requires_lifecycle_operation_id AS requiresLifecycleOperationId,
      envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      ORDER BY created_at, receipt_id`).all() as Array<{
        receiptId: string;
        receiptKind: string;
        dependsOnReceiptId: string | null;
        requiresLifecycleOperationId: string;
        envelopeJson: string;
      }>;
    const assessmentRows = lineageRows.filter((row) =>
      row.receiptKind === "completion_assessment"
    );
    const assessmentARow = assessmentRows.find((row) =>
      CompletionAssessmentReceiptEnvelopeV1Schema.parse(
        JSON.parse(row.envelopeJson)
      ).payload.assessmentId === COMPLETION_ASSESSMENT.id
    )!;
    const assessmentBRow = assessmentRows.find((row) =>
      CompletionAssessmentReceiptEnvelopeV1Schema.parse(
        JSON.parse(row.envelopeJson)
      ).payload.assessmentId === assessmentB.id
    )!;
    expect(assessmentARow.dependsOnReceiptId).toBe(EVIDENCE_RECEIPT.receiptId);
    expect(assessmentBRow).toMatchObject({
      dependsOnReceiptId: assessmentARow.receiptId,
      requiresLifecycleOperationId: COMPLETION_OPERATION_ID
    });
    expect(projectedB?.predecessorReceiptDigests).toEqual([
      COMPLETION_RECEIPT.receiptDigest,
      CONTRACT_RECEIPT.receiptDigest,
      EVIDENCE_RECEIPT.receiptDigest,
      projected.find((envelope) =>
        envelope.payload.assessmentId === COMPLETION_ASSESSMENT.id
      )!.receiptDigest
    ].sort());
    expect(await repo.getCurrentCompletionAssessment({ workThreadId: WORK_THREAD_ID }))
      .toMatchObject({
        id: assessmentB.id,
        supersedesAssessmentId: COMPLETION_ASSESSMENT.id,
        assessedAt: assessmentB.assessedAt,
        acceptedAt: COMPLETION_ASSESSMENT.acceptedAt
      });
    await expect(repo.appendCompletionAssessment({
      assessment: COMPLETION_ASSESSMENT,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(repo.appendCompletionAssessment({
      assessment: assessmentB,
      expectedCurrentAssessmentId: COMPLETION_ASSESSMENT.id
    })).resolves.toMatchObject({ outcome: "duplicate" });
    expect(assessmentProjectionEnvelopes(sqlite)).toHaveLength(2);
    sqlite.close();
  });

  it("rejects a sub-millisecond first acceptance before assessedAt", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const prematureAcceptance = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_premature_acceptance",
      assessedAt: "2026-08-10T00:00:00.0009Z",
      acceptedAt: "2026-08-10T00:00:00.0001Z"
    };
    const before = rejectedAssessmentMutationSnapshot(sqlite);

    await expect(repo.appendCompletionAssessment({
      assessment: prematureAcceptance,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(rejectedAssessmentMutationSnapshot(sqlite)).toBe(before);
    sqlite.close();
  });

  it("projects a monotonic same-run contract successor with explicit supersession", async () => {
    const { sqlite, repo } = await setup();
    const contractB = {
      ...COMPLETION_CONTRACT,
      id: "contract_2",
      version: 2
    };
    await expect(repo.recordCompletionContract({ contract: contractB }))
      .resolves.toMatchObject({ created: true });
    const assessmentB = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_contract_2",
      contractId: contractB.id,
      contractVersion: contractB.version,
      sequence: 2,
      supersedesAssessmentId: COMPLETION_ASSESSMENT.id,
      inputDigest: `sha256:${"2".repeat(64)}`
    };

    await expect(repo.appendCompletionAssessment({
      assessment: assessmentB,
      expectedCurrentAssessmentId: COMPLETION_ASSESSMENT.id
    })).resolves.toMatchObject({ outcome: "recorded" });

    const rows = sqlite.prepare(`SELECT
      receipt_id AS receiptId,
      receipt_kind AS receiptKind,
      depends_on_receipt_id AS dependsOnReceiptId,
      requires_lifecycle_operation_id AS requiresLifecycleOperationId,
      envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      ORDER BY created_at, receipt_id`).all() as Array<{
        receiptId: string;
        receiptKind: string;
        dependsOnReceiptId: string | null;
        requiresLifecycleOperationId: string;
        envelopeJson: string;
      }>;
    const assessmentRows = rows.filter((row) =>
      row.receiptKind === "completion_assessment"
    );
    const assessmentARow = assessmentRows.find((row) =>
      CompletionAssessmentReceiptEnvelopeV1Schema.parse(
        JSON.parse(row.envelopeJson)
      ).payload.assessmentId === COMPLETION_ASSESSMENT.id
    )!;
    const assessmentBRow = assessmentRows.find((row) =>
      CompletionAssessmentReceiptEnvelopeV1Schema.parse(
        JSON.parse(row.envelopeJson)
      ).payload.assessmentId === assessmentB.id
    )!;
    const contractBRow = rows.find((row) => {
      if (row.receiptKind !== "completion_contract_ref") return false;
      return CompletionContractRefReceiptEnvelopeV1Schema.parse(
        JSON.parse(row.envelopeJson)
      ).payload.contractId === contractB.id;
    })!;
    const contractBEnvelope = CompletionContractRefReceiptEnvelopeV1Schema.parse(
      JSON.parse(contractBRow.envelopeJson)
    );
    const evidenceBRow = rows.find((row) => {
      if (row.receiptKind !== "completion_evidence_observation") return false;
      const envelope = CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
        JSON.parse(row.envelopeJson)
      );
      return envelope.identity.parts[6] === contractBEnvelope.receiptDigest;
    })!;
    const evidenceBEnvelope = CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(evidenceBRow.envelopeJson)
    );
    const workThreadRow = rows.find((row) => row.receiptKind === "work_thread_ref")!;

    expect(contractBEnvelope.identity.parts).toEqual([
      "org_1",
      RUN_ID,
      WORK_THREAD_ID,
      contractB.id,
      "2",
      "1"
    ]);
    expect(contractBEnvelope.payload).toMatchObject({
      contractId: contractB.id,
      version: 2,
      cycle: 1,
      supersedesContractId: COMPLETION_CONTRACT.id,
      resolvedTargetDigests: []
    });
    expect(contractBRow).toMatchObject({
      dependsOnReceiptId: assessmentARow.receiptId,
      requiresLifecycleOperationId: COMPLETION_OPERATION_ID
    });
    expect(contractBEnvelope.predecessorReceiptDigests).toEqual([
      JSON.parse(workThreadRow.envelopeJson).receiptDigest,
      JSON.parse(assessmentARow.envelopeJson).receiptDigest
    ].sort());
    expect(evidenceBRow).toMatchObject({
      dependsOnReceiptId: contractBRow.receiptId,
      requiresLifecycleOperationId: COMPLETION_OPERATION_ID
    });
    expect(evidenceBEnvelope.predecessorReceiptDigests).toEqual([
      COMPLETION_RECEIPT.receiptDigest,
      contractBEnvelope.receiptDigest
    ].sort());
    expect(assessmentBRow).toMatchObject({
      dependsOnReceiptId: evidenceBRow.receiptId,
      requiresLifecycleOperationId: COMPLETION_OPERATION_ID
    });
    expect(CompletionAssessmentReceiptEnvelopeV1Schema.parse(
      JSON.parse(assessmentBRow.envelopeJson)
    ).predecessorReceiptDigests).toEqual([
      COMPLETION_RECEIPT.receiptDigest,
      contractBEnvelope.receiptDigest,
      evidenceBEnvelope.receiptDigest,
      JSON.parse(assessmentARow.envelopeJson).receiptDigest
    ].sort());

    const beforeReplay = JSON.stringify(rows);
    await expect(repo.appendCompletionAssessment({
      assessment: assessmentB,
      expectedCurrentAssessmentId: COMPLETION_ASSESSMENT.id
    })).resolves.toMatchObject({ outcome: "duplicate" });
    expect(JSON.stringify(sqlite.prepare(`SELECT
      receipt_id AS receiptId,
      receipt_kind AS receiptKind,
      depends_on_receipt_id AS dependsOnReceiptId,
      requires_lifecycle_operation_id AS requiresLifecycleOperationId,
      envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      ORDER BY created_at, receipt_id`).all())).toBe(beforeReplay);
    sqlite.close();
  });

  it("rejects a non-monotonic same-run contract successor without advancing authority", async () => {
    const { sqlite, repo } = await setup();
    const nonMonotonicContract = {
      ...COMPLETION_CONTRACT,
      id: "contract_non_monotonic"
    };
    await repo.recordCompletionContract({ contract: nonMonotonicContract });
    const outboxBefore = JSON.stringify(sqlite.prepare(`SELECT *
      FROM control_plane_projection_outbox ORDER BY receipt_id`).all());
    const governanceCountBefore = sqlite.prepare(`SELECT count(*) AS count
      FROM governance_events`).get();
    const assessmentB = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_non_monotonic",
      contractId: nonMonotonicContract.id,
      sequence: 2,
      supersedesAssessmentId: COMPLETION_ASSESSMENT.id,
      inputDigest: `sha256:${"3".repeat(64)}`
    };

    await expect(repo.appendCompletionAssessment({
      assessment: assessmentB,
      expectedCurrentAssessmentId: COMPLETION_ASSESSMENT.id
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(await repo.getCurrentCompletionAssessment({ workThreadId: WORK_THREAD_ID }))
      .toMatchObject({ id: COMPLETION_ASSESSMENT.id });
    expect(sqlite.prepare(`SELECT count(*) AS count FROM completion_assessments`).get())
      .toEqual({ count: 1 });
    expect(JSON.stringify(sqlite.prepare(`SELECT *
      FROM control_plane_projection_outbox ORDER BY receipt_id`).all()))
      .toBe(outboxBefore);
    expect(sqlite.prepare(`SELECT count(*) AS count FROM governance_events`).get())
      .toEqual(governanceCountBefore);
    sqlite.close();
  });

  it("chains cross-run supersession through the predecessor and the current lifecycle", async () => {
    const { sqlite, repo } = await setup();
    const runIdB = "run-callback-2";
    const attemptIdB = "attempt_2";
    const claimOperationIdB = "claim_operation_2";
    const rawFenceB = "raw-fence-2";
    const fenceDigestB = `sha256:${createHash("sha256")
      .update(rawFenceB).digest("hex")}`;
    const claimAuthorityB = {
      ...CLAIM_AUTHORITY,
      runId: runIdB,
      attemptId: attemptIdB,
      fencingTokenDigest: fenceDigestB
    };
    const completionCommonB = {
      ...COMPLETION_COMMON,
      runId: runIdB,
      attempt: {
        attemptId: attemptIdB,
        attemptNumber: 1,
        epoch: 1,
        fencingTokenDigest: fenceDigestB
      }
    };
    const completionRequestDigestB = canonicalSha256Json(completionCommonB);
    const completionOperationIdB = `op_${completionRequestDigestB
      .slice("sha256:".length)}`;
    const completionRequestIdB = `req_${canonicalSha256Json({
      purpose: "opentag-hosted-lifecycle-request-id-v1",
      operationId: completionOperationIdB,
      requestDigest: completionRequestDigestB
    }).slice("sha256:".length)}`;
    const completionRequestB = HostedCompleteRequestV1Schema.parse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.lifecycle.v1"],
      requestId: completionRequestIdB,
      operationId: completionOperationIdB,
      attempt: { ...completionCommonB.attempt, fencingToken: rawFenceB },
      requestDigest: completionRequestDigestB,
      occurredAt: NOW.toISOString(),
      conclusion: "success",
      reasonCode: "executor_success",
      resultDigest: RESULT_DIGEST,
      artifactDigests: [],
      evidenceDigests: []
    });
    const completionReceiptB = HostedLifecycleReceiptEnvelopeV1Schema.parse(withDigests({
      schemaVersion: 1,
      protocolVersion: "1.0",
      receiptKind: "attempt_lifecycle",
      receiptId: `lifecycle_${canonicalSha256Json({
        organizationId: "org_1",
        operationId: completionOperationIdB
      }).slice("sha256:".length)}`,
      organizationId: "org_1",
      requestId: completionRequestIdB,
      operationId: completionOperationIdB,
      requestDigest: completionRequestDigestB,
      requiredCapabilities: ["relay.lifecycle.v1"],
      producer: {
        kind: "runner" as const,
        id: "runner_1",
        credentialId: PRODUCER.credentialId
      },
      identity: {
        namespace: "opentag.control.receipt/attempt-lifecycle/v1" as const,
        parts: ["org_1", runIdB, attemptIdB, "executor_result", completionOperationIdB]
      },
      observedAt: NOW.toISOString(),
      runId: runIdB,
      attempt: completionCommonB.attempt,
      payload: {
        operation: "executor_result" as const,
        occurredAt: NOW.toISOString(),
        conclusion: "success" as const,
        reasonCode: "executor_success",
        resultDigest: RESULT_DIGEST,
        artifactDigests: [],
        evidenceDigests: []
      }
    }));
    const eventB = OpenTagEventSchema.parse({
      id: "event_2",
      source: "github",
      sourceEventId: "comment_2",
      receivedAt: NOW.toISOString(),
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "complete again", intent: "fix", args: {} },
      context: [],
      permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
      callback: { provider: "github", uri: DELIVERY_TARGET },
      metadata: { owner: "acme", repo: "demo", issueNumber: 1 }
    });
    const authorityJsonB = canonicalJsonStringify(claimAuthorityB);
    const authorityDigestB = canonicalSha256Json(claimAuthorityB);
    const claimDigestB = `sha256:${"e".repeat(64)}`;
    sqlite.prepare(`INSERT INTO runs (
      id, event_id, status, event_json, assigned_runner_id, repo_provider,
      work_thread_id, current_attempt_id, routing_rejections_json, created_at,
      updated_at
    ) VALUES (?, 'event_2', 'running', ?, 'runner_1', 'github', ?, ?, '[]', ?, ?)`)
      .run(
        runIdB,
        JSON.stringify(eventB),
        WORK_THREAD_ID,
        attemptIdB,
        NOW.toISOString(),
        NOW.toISOString()
      );
    sqlite.prepare(`INSERT INTO attempts (
      id, run_id, number, runner_id, runner_locality, fencing_token, status,
      started_at, heartbeat_at, lease_expires_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, 1, 'runner_1', 'hosted', ?, 'running', ?, ?, ?, NULL, ?, ?)`)
      .run(
        attemptIdB,
        runIdB,
        rawFenceB,
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
      execution_started_at, created_at, updated_at
    ) VALUES (?, 'claim_request_2', 'org_1', 'runner_1', 'cloud_1', ?, '{}',
      'claimed', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(
        claimOperationIdB,
        `sha256:${"2".repeat(64)}`,
        runIdB,
        claimDigestB,
        authorityDigestB,
        authorityJsonB,
        attemptIdB,
        fenceDigestB,
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
    ) VALUES (?, 'admission_2', 'admission_operation_2', ?, ?, ?, ?, ?, ?,
      'policy_receipt_1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        runIdB,
        claimOperationIdB,
        attemptIdB,
        fenceDigestB,
        `sha256:${"0".repeat(64)}`,
        `sha256:${"3".repeat(64)}`,
        `sha256:${"4".repeat(64)}`,
        `sha256:${"9".repeat(64)}`,
        `sha256:${"a".repeat(64)}`,
        canonicalSha256Json(eventB),
        `sha256:${"b".repeat(64)}`,
        WORK_THREAD_ID,
        claimDigestB,
        authorityDigestB,
        authorityJsonB,
        NOW.toISOString()
      );
    sqlite.prepare(`INSERT INTO hosted_attempt_imports (
      attempt_id, run_id, attempt_number, claim_operation_id,
      fencing_token_digest, claim_digest, authority_digest, authority_json,
      imported_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(
        attemptIdB,
        runIdB,
        claimOperationIdB,
        fenceDigestB,
        claimDigestB,
        authorityDigestB,
        authorityJsonB,
        NOW.toISOString()
      );

    await expect(repo.completeHostedRunLocally({
      runId: runIdB,
      result: RUN_RESULT,
      runnerId: "runner_1",
      attemptId: attemptIdB,
      fencingToken: rawFenceB,
      destinationId: "cloud_1",
      organizationId: "org_1",
      credentialId: PRODUCER.credentialId,
      request: completionRequestB
    })).resolves.toBe("completed");
    const claimNow = new Date(Math.max(Date.now(), NOW.getTime()) + 2_000);
    const [completionOperationB] = await repo.claimDueHostedLifecycleOperations({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "lifecycle_pump_b",
      leaseSeconds: 30,
      now: claimNow
    });
    expect(completionOperationB?.operationId).toBe(completionOperationIdB);
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud_1",
      organizationId: "org_1",
      operationId: completionOperationIdB,
      leaseToken: completionOperationB!.leaseToken!,
      receipt: completionReceiptB,
      now: new Date(claimNow.getTime() + 1_000)
    })).resolves.toBe("acknowledged");

    const assessmentB = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_cross_run_2",
      triggeredByRunId: runIdB,
      sequence: 2,
      supersedesAssessmentId: COMPLETION_ASSESSMENT.id,
      inputDigest: `sha256:${"f".repeat(64)}`
    };
    await expect(repo.appendCompletionAssessment({
      assessment: assessmentB,
      expectedCurrentAssessmentId: COMPLETION_ASSESSMENT.id
    })).resolves.toMatchObject({ outcome: "recorded" });

    const rows = sqlite.prepare(`SELECT
      receipt_id AS receiptId,
      receipt_kind AS receiptKind,
      run_id AS runId,
      depends_on_receipt_id AS dependsOnReceiptId,
      requires_lifecycle_operation_id AS requiresLifecycleOperationId,
      envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      ORDER BY created_at, receipt_id`).all() as Array<{
        receiptId: string;
        receiptKind: string;
        runId: string;
        dependsOnReceiptId: string | null;
        requiresLifecycleOperationId: string;
        envelopeJson: string;
      }>;
    const assessmentARow = rows.find((row) =>
      row.receiptKind === "completion_assessment" && row.runId === RUN_ID
    )!;
    const rowsB = rows.filter((row) => row.runId === runIdB);
    const workThreadBRow = rowsB.find((row) => row.receiptKind === "work_thread_ref")!;
    const contractBRow = rowsB.find((row) =>
      row.receiptKind === "completion_contract_ref"
    )!;
    const evidenceBRow = rowsB.find((row) =>
      row.receiptKind === "completion_evidence_observation"
    )!;
    const assessmentBRow = rowsB.find((row) =>
      row.receiptKind === "completion_assessment"
    )!;
    expect(completionOperationIdB).not.toBe(COMPLETION_OPERATION_ID);
    expect(rowsB).toHaveLength(4);
    expect(rowsB.map((row) => row.requiresLifecycleOperationId))
      .toEqual(Array(4).fill(completionOperationIdB));
    expect(workThreadBRow.dependsOnReceiptId).toBe(assessmentARow.receiptId);
    expect(contractBRow.dependsOnReceiptId).toBe(workThreadBRow.receiptId);
    expect(evidenceBRow.dependsOnReceiptId).toBe(contractBRow.receiptId);
    expect(assessmentBRow.dependsOnReceiptId).toBe(evidenceBRow.receiptId);

    const workThreadBEnvelope = WorkThreadRefReceiptEnvelopeV1Schema.parse(
      JSON.parse(workThreadBRow.envelopeJson)
    );
    const contractBEnvelope = CompletionContractRefReceiptEnvelopeV1Schema.parse(
      JSON.parse(contractBRow.envelopeJson)
    );
    const evidenceBEnvelope = CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(evidenceBRow.envelopeJson)
    );
    const assessmentBEnvelope = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
      JSON.parse(assessmentBRow.envelopeJson)
    );
    const assessmentAEnvelope = CompletionAssessmentReceiptEnvelopeV1Schema.parse(
      JSON.parse(assessmentARow.envelopeJson)
    );
    expect(workThreadBEnvelope.predecessorReceiptDigests).toEqual([
      authorityDigestB,
      claimAuthorityB.admissionPolicySnapshotDigest,
      assessmentAEnvelope.receiptDigest
    ].sort());
    expect(contractBEnvelope.identity.parts).toEqual([
      "org_1",
      runIdB,
      WORK_THREAD_ID,
      COMPLETION_CONTRACT.id,
      "1",
      "1"
    ]);
    expect(contractBEnvelope.payload).not.toHaveProperty("supersedesContractId");
    expect(contractBEnvelope.predecessorReceiptDigests)
      .toEqual([workThreadBEnvelope.receiptDigest]);
    expect(evidenceBEnvelope.identity.parts[6]).toBe(contractBEnvelope.receiptDigest);
    expect(evidenceBEnvelope.predecessorReceiptDigests).toEqual([
      completionReceiptB.receiptDigest,
      contractBEnvelope.receiptDigest
    ].sort());
    expect(assessmentBEnvelope.predecessorReceiptDigests).toEqual([
      completionReceiptB.receiptDigest,
      contractBEnvelope.receiptDigest,
      evidenceBEnvelope.receiptDigest,
      assessmentAEnvelope.receiptDigest
    ].sort());
    expect(assessmentBEnvelope.payload.executorResultReceiptRef).toEqual({
      receiptId: completionReceiptB.receiptId,
      operationId: completionOperationIdB,
      requestId: completionRequestIdB,
      requestDigest: completionRequestDigestB,
      resultDigest: RESULT_DIGEST
    });
    sqlite.close();
  });

  it("ensures the current hosted assessment when assessment is appended after complete ack", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));

    await completeAndAcknowledge(repo);
    expect(sqlite.prepare(`SELECT count(*) AS count
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_assessment'`).get()).toEqual({ count: 0 });
    await expect(repo.appendCompletionAssessment({
      assessment: COMPLETION_ASSESSMENT,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    expectGeneratedAssessmentProjection(sqlite);
    sqlite.close();
  });

  it("ignores generic verification evidence that does not claim completion authority", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    await expect(repo.recordVerificationEvidence({
      id: "evidence_generic_review",
      workThreadId: WORK_THREAD_ID,
      provider: "github",
      deliveryId: "delivery_generic_review",
      subjectRef: "github:acme/demo:pull_request:1",
      subjectVersion: "abc123",
      evidence: {
        id: "evidence_generic_review",
        kind: "source_control.review",
        assurance: "verified",
        subjectRef: "github:acme/demo:pull_request:1@abc123",
        summary: "A review exists, but it is not a completion fact.",
        createdAt: NOW.toISOString()
      },
      payloadDigest: `sha256:${"7".repeat(64)}`,
      observedAt: NOW.toISOString(),
      receivedAt: NOW.toISOString()
    })).resolves.toMatchObject({ created: true });

    await expect(repo.appendCompletionAssessment({
      assessment: COMPLETION_ASSESSMENT,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    expect(assessmentProjectionEnvelopes(sqlite)).toHaveLength(1);
    const evidence = sqlite.prepare(`SELECT envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'`).all() as Array<{
        envelopeJson: string;
      }>;
    expect(evidence).toHaveLength(1);
    expect(CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(evidence[0]!.envelopeJson)
    ).payload.evidenceId).toBe(COMPLETION_FACT.id);
    sqlite.close();
  });

  it("rejects malformed evidence that explicitly claims completion authority", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    await expect(repo.recordVerificationEvidence({
      id: "evidence_malformed_completion",
      workThreadId: WORK_THREAD_ID,
      provider: "github",
      deliveryId: "delivery_malformed_completion",
      subjectRef: "github:acme/demo:pull_request:1",
      subjectVersion: "abc123",
      evidence: {
        id: "evidence_malformed_completion",
        kind: "test",
        assurance: "verified",
        subjectRef: "github:acme/demo:pull_request:1@abc123",
        summary: "This record claims completion authority but is incomplete.",
        createdAt: NOW.toISOString(),
        metadata: { completionFact: { id: "evidence_malformed_completion" } }
      },
      payloadDigest: `sha256:${"6".repeat(64)}`,
      observedAt: NOW.toISOString(),
      receivedAt: NOW.toISOString()
    })).resolves.toMatchObject({ created: true });
    const before = rejectedAssessmentMutationSnapshot(sqlite);

    await expect(repo.appendCompletionAssessment({
      assessment: COMPLETION_ASSESSMENT,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(rejectedAssessmentMutationSnapshot(sqlite)).toBe(before);
    sqlite.close();
  });

  it("structurally validates and then ignores valid completion facts from another cycle", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    insertCompletionFact(sqlite, {
      id: "evidence_other_cycle_failure",
      outcome: "failed",
      observedAt: NOW.toISOString(),
      cycle: 2
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);

    await expect(repo.appendCompletionAssessment({
      assessment: COMPLETION_ASSESSMENT,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const evidence = sqlite.prepare(`SELECT envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'`).all() as Array<{
        envelopeJson: string;
      }>;
    expect(evidence).toHaveLength(1);
    expect(CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(evidence[0]!.envelopeJson)
    ).payload.evidenceId).toBe(COMPLETION_FACT.id);
    sqlite.close();
  });

  it("rolls back an assessment whose evidence reference has no durable authority", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const unresolved = {
      ...COMPLETION_ASSESSMENT,
      gateResults: COMPLETION_ASSESSMENT.gateResults.map((gate) => ({
        ...gate,
        evidenceIds: ["evidence_missing"]
      }))
    };

    await expect(repo.appendCompletionAssessment({
      assessment: unresolved,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(sqlite.prepare(`SELECT count(*) AS count
      FROM completion_assessments`).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(`SELECT current_assessment_id AS currentAssessmentId
      FROM work_threads WHERE id = ?`).get(WORK_THREAD_ID))
      .toEqual({ currentAssessmentId: null });
    expect(assessmentProjectionEnvelopes(sqlite)).toHaveLength(0);
    sqlite.close();
  });

  it("rejects a verification evidence reference owned by another work thread", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    sqlite.prepare(`INSERT INTO work_threads (
      id, scope_id, canonical_key, provider, owner_container_id, work_item_kind,
      external_id, thread_json, current_assessment_id, created_at, updated_at
    ) VALUES ('work_thread_other', 'scope_1', 'thread_key_other', 'github',
      'owner_1', 'issue', '2', '{}', NULL, ?, ?)`).run(
        NOW.toISOString(),
        NOW.toISOString()
      );
    sqlite.prepare(`UPDATE verification_evidence
      SET work_thread_id = 'work_thread_other' WHERE id = ?`)
      .run(VERIFICATION_EVIDENCE.id);
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);

    await expect(repo.appendCompletionAssessment({
      assessment: COMPLETION_ASSESSMENT,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(sqlite.prepare(`SELECT count(*) AS count
      FROM completion_assessments`).get()).toEqual({ count: 0 });
    expect(assessmentProjectionEnvelopes(sqlite)).toHaveLength(0);
    sqlite.close();
  });

  it("rejects verification evidence received before the hosted run authority window", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    sqlite.prepare(`UPDATE verification_evidence SET received_at = ? WHERE id = ?`)
      .run(new Date(NOW.getTime() - 1_000).toISOString(), VERIFICATION_EVIDENCE.id);
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);

    await expect(repo.appendCompletionAssessment({
      assessment: COMPLETION_ASSESSMENT,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(sqlite.prepare(`SELECT count(*) AS count
      FROM completion_assessments`).get()).toEqual({ count: 0 });
    expect(assessmentProjectionEnvelopes(sqlite)).toHaveLength(0);
    sqlite.close();
  });

  it("rejects a satisfied assessment when a newer authoritative fact fails", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const failedAt = new Date(NOW.getTime() + 1_000).toISOString();
    const assessedAt = new Date(NOW.getTime() + 2_000).toISOString();
    insertCompletionFact(sqlite, {
      id: "evidence_newer_failure",
      outcome: "failed",
      observedAt: failedAt
    });
    const staleAssessment = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_stale_pass",
      inputDigest: `sha256:${"a".repeat(64)}`,
      assessedAt,
      acceptedAt: assessedAt
    };
    const before = rejectedAssessmentMutationSnapshot(sqlite);

    await expect(repo.appendCompletionAssessment({
      assessment: staleAssessment,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(rejectedAssessmentMutationSnapshot(sqlite)).toBe(before);
    sqlite.close();
  });

  it("rejects an evidence-free satisfied assessment without any durable writes", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const evidenceFreeAssessment = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_evidence_free",
      inputDigest: `sha256:${"b".repeat(64)}`,
      gateResults: COMPLETION_ASSESSMENT.gateResults.map((gate) => ({
        ...gate,
        evidenceIds: []
      }))
    };
    const before = rejectedAssessmentMutationSnapshot(sqlite);

    await expect(repo.appendCompletionAssessment({
      assessment: evidenceFreeAssessment,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow();
    expect(rejectedAssessmentMutationSnapshot(sqlite)).toBe(before);
    sqlite.close();
  });

  it("rejects an assessment that cites an extra stale verification fact", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const currentAt = new Date(NOW.getTime() + 1_000).toISOString();
    const assessedAt = new Date(NOW.getTime() + 2_000).toISOString();
    insertCompletionFact(sqlite, {
      id: "evidence_current_pass",
      outcome: "passed",
      observedAt: currentAt
    });
    const overCitedAssessment = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_extra_evidence",
      inputDigest: `sha256:${"c".repeat(64)}`,
      assessedAt,
      acceptedAt: assessedAt,
      gateResults: COMPLETION_ASSESSMENT.gateResults.map((gate) => ({
        ...gate,
        evidenceIds: ["evidence_current_pass", COMPLETION_FACT.id]
      }))
    };
    const before = rejectedAssessmentMutationSnapshot(sqlite);

    await expect(repo.appendCompletionAssessment({
      assessment: overCitedAssessment,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(rejectedAssessmentMutationSnapshot(sqlite)).toBe(before);
    sqlite.close();
  });

  it("projects only the deterministic winner from tied successful verification facts", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const currentAt = new Date(NOW.getTime() + 1_000).toISOString();
    const assessedAt = new Date(NOW.getTime() + 2_000).toISOString();
    insertCompletionFact(sqlite, {
      id: "evidence_tied_pass_a",
      outcome: "passed",
      observedAt: currentAt
    });
    insertCompletionFact(sqlite, {
      id: "evidence_tied_pass_b",
      outcome: "passed",
      observedAt: currentAt
    });
    const canonicalAssessment = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_canonical_tied_evidence",
      inputDigest: `sha256:${"d".repeat(64)}`,
      assessedAt,
      acceptedAt: assessedAt,
      gateResults: COMPLETION_ASSESSMENT.gateResults.map((gate) => ({
        ...gate,
        evidenceIds: ["evidence_tied_pass_a"]
      }))
    };

    await expect(repo.appendCompletionAssessment({
      assessment: canonicalAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const evidence = sqlite.prepare(`SELECT envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'`).all() as Array<{
        envelopeJson: string;
      }>;
    expect(evidence).toHaveLength(1);
    expect(CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(evidence[0]!.envelopeJson)
    ).payload.evidenceId).toBe("evidence_tied_pass_a");
    sqlite.close();
  });

  it("retains every tied authoritative fact when their completion claims conflict", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const currentAt = new Date(NOW.getTime() + 1_000).toISOString();
    const assessedAt = new Date(NOW.getTime() + 2_000).toISOString();
    insertCompletionFact(sqlite, {
      id: "evidence_tied_conflict_a",
      outcome: "passed",
      observedAt: currentAt
    });
    insertCompletionFact(sqlite, {
      id: "evidence_tied_conflict_b",
      outcome: "failed",
      observedAt: currentAt
    });
    const { acceptedAt: _acceptedAt, ...assessmentBase } = COMPLETION_ASSESSMENT;
    const conflictedAssessment = {
      ...assessmentBase,
      id: "assessment_tied_evidence_conflict",
      inputDigest: `sha256:${"4".repeat(64)}`,
      state: "blocked" as const,
      assessedAt,
      gateResults: COMPLETION_ASSESSMENT.gateResults.map((gate) => ({
        ...gate,
        state: "unknown" as const,
        evidenceIds: ["evidence_tied_conflict_a", "evidence_tied_conflict_b"],
        reasonCode: "verification_assurance_insufficient" as const,
        reason: "Equally current authoritative verification observations conflict.",
        evaluatedAt: assessedAt
      }))
    };

    await expect(repo.appendCompletionAssessment({
      assessment: conflictedAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const evidence = (sqlite.prepare(`SELECT envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'`).all() as Array<{
        envelopeJson: string;
      }>).map((row) => CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(row.envelopeJson)
    ).payload.evidenceId).sort();
    expect(evidence).toEqual([
      "evidence_tied_conflict_a",
      "evidence_tied_conflict_b"
    ]);
    sqlite.close();
  });

  it("projects an unresolved verification target only as missing with no evidence", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const { acceptedAt: _acceptedAt, ...assessmentBase } = COMPLETION_ASSESSMENT;
    const pendingAssessment = {
      ...assessmentBase,
      id: "assessment_verification_missing",
      targetBindings: [],
      state: "pending" as const,
      evidenceBacked: false,
      gateResults: [{
        ...COMPLETION_ASSESSMENT.gateResults[0]!,
        state: "missing" as const,
        evidenceIds: [],
        reasonCode: "verification_missing" as const,
        reason: "The delivery target has not been resolved."
      }]
    };
    const corrupted = {
      ...pendingAssessment,
      gateResults: pendingAssessment.gateResults.map((gate) => ({
        ...gate,
        state: "passed" as const
      }))
    };

    await expect(repo.appendCompletionAssessment({
      assessment: corrupted,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow();
    expect(sqlite.prepare("SELECT count(*) AS count FROM completion_assessments").get())
      .toEqual({ count: 0 });
    await expect(repo.appendCompletionAssessment({
      assessment: pendingAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const [projection] = assessmentProjectionEnvelopes(sqlite);
    expect(projection?.payload).toMatchObject({
      evidenceReceiptDigests: [],
      gateResults: [{
        gateId: "checks",
        state: "pending",
        reasonCode: "verification_missing",
        evidenceReceiptDigests: []
      }]
    });
    sqlite.close();
  });

  it("binds external-state subject mismatch to a proven provider mismatch", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const externalContract = {
      ...COMPLETION_CONTRACT,
      gates: [{
        id: "merge",
        kind: "external_state" as const,
        targetKey: "primary_change",
        provider: "gitlab",
        requiredState: "merged",
        minimumAssurance: "reported" as const
      }]
    };
    const externalContractDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(externalContract)).digest("hex")}`;
    sqlite.prepare(`UPDATE completion_contracts
      SET contract_json = ?, content_digest = ?
      WHERE id = ? AND version = ?`).run(
        JSON.stringify(externalContract),
        externalContractDigest,
        externalContract.id,
        externalContract.version
      );
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const { acceptedAt: _acceptedAt, ...assessmentBase } = COMPLETION_ASSESSMENT;
    const blockedAssessment = {
      ...assessmentBase,
      id: "assessment_external_provider_mismatch",
      state: "blocked" as const,
      evidenceBacked: false,
      gateResults: [{
        gateId: "merge",
        targetKey: "primary_change",
        state: "unknown" as const,
        evidenceIds: [],
        reasonCode: "external_state_subject_mismatch" as const,
        reason: "The resolved target provider does not match this gate.",
        evaluatedAt: NOW.toISOString()
      }]
    };
    const corrupted = {
      ...blockedAssessment,
      gateResults: blockedAssessment.gateResults.map((gate) => ({
        ...gate,
        state: "missing" as const
      }))
    };

    await expect(repo.appendCompletionAssessment({
      assessment: corrupted,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow();
    await expect(repo.appendCompletionAssessment({
      assessment: blockedAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const [projection] = assessmentProjectionEnvelopes(sqlite);
    expect(projection?.payload.gateResults).toEqual([{
      gateId: "merge",
      state: "blocked",
      reasonCode: "external_state_subject_mismatch",
      evidenceReceiptDigests: []
    }]);
    sqlite.close();
  });

  it("rejects a stale material fence and projects exact Governance time", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const materialContract = {
      ...COMPLETION_CONTRACT,
      targetSelectors: [],
      gates: [{
        id: "deploy",
        kind: "material_action" as const,
        actionFamily: "deploy",
        requiredOutcome: "succeeded" as const
      }]
    };
    const materialContractDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(materialContract)).digest("hex")}`;
    sqlite.prepare(`UPDATE completion_contracts
      SET contract_json = ?, content_digest = ?
      WHERE id = ? AND version = ?`).run(
        JSON.stringify(materialContract),
        materialContractDigest,
        materialContract.id,
        materialContract.version
      );
    const receipt = {
      id: "material_receipt_1",
      actionId: "material_action_1",
      provider: "github" as const,
      receiptRef: "github:deployment:1",
      outcome: "succeeded" as const,
      observedAt: "2026-08-10T00:00:00.0009Z",
      metadata: { actionFamily: "deploy" }
    };
    sqlite.prepare(`INSERT INTO material_actions (
      id, run_id, attempt_id, action_family, capability, scope_json, target_json,
      risk_tier, status, idempotency_key, attempt_fence_digest, receipt_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'deploy', 'deploy:write', '{}', '{}', 'high',
      'succeeded', 'deploy-once', ?, ?, ?, ?)`).run(
        receipt.actionId,
        RUN_ID,
        RUN_ATTEMPT_ID,
        "0".repeat(64),
        JSON.stringify(receipt),
        NOW.toISOString(),
        NOW.toISOString()
      );
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const materialAssessment = evaluateCompletion({
      contract: materialContract,
      runResults: [{
        runId: RUN_ID,
        result: RUN_RESULT,
        recordedAt: NOW.toISOString()
      }],
      artifacts: [],
      evidence: [],
      materialActionReceipts: [receipt],
      waivers: [],
      blockingEscalations: [],
      lineage: { sequence: 1 }
    });
    expect(materialAssessment).toMatchObject({
      state: "satisfied",
      assessedAt: receipt.observedAt,
      acceptedAt: receipt.observedAt
    });

    await expect(repo.appendCompletionAssessment({
      assessment: materialAssessment,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    sqlite.prepare(`UPDATE material_actions SET attempt_fence_digest = ? WHERE id = ?`)
      .run(FENCE_DIGEST.slice("sha256:".length), receipt.actionId);
    await expect(repo.appendCompletionAssessment({
      assessment: materialAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const evidence = sqlite.prepare(`SELECT envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'`).get() as {
        envelopeJson: string;
      };
    expect(CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(evidence.envelopeJson)
    ).payload).toMatchObject({
      evidenceType: "material_action",
      evidenceId: receipt.id,
      actionId: receipt.actionId,
      actionFamily: "deploy",
      outcome: "succeeded",
      observedAt: NOW.toISOString()
    });
    expect(assessmentProjectionEnvelopes(sqlite)[0]?.payload.assessedAt)
      .toBe(NOW.toISOString());
    sqlite.close();
  });

  it("rolls back lifecycle acknowledgement when delayed evidence cannot be resolved", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    const unresolved = {
      ...COMPLETION_ASSESSMENT,
      gateResults: COMPLETION_ASSESSMENT.gateResults.map((gate) => ({
        ...gate,
        evidenceIds: ["evidence_missing"]
      }))
    };
    await expect(repo.appendCompletionAssessment({
      assessment: unresolved,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
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
    await expect(repo.acknowledgeHostedLifecycleOperation({
      destinationId: "cloud_1",
      organizationId: "org_1",
      operationId: COMPLETION_OPERATION_ID,
      leaseToken: operation!.leaseToken!,
      receipt: COMPLETION_RECEIPT,
      now: new Date(claimNow.getTime() + 1_000)
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(sqlite.prepare(`SELECT state, receipt_json AS receiptJson
      FROM hosted_lifecycle_operations WHERE operation_id = ?`)
      .get(COMPLETION_OPERATION_ID)).toEqual({ state: "leased", receiptJson: null });
    expect(assessmentProjectionEnvelopes(sqlite)).toHaveLength(0);
    sqlite.close();
  });

  it("binds a synthetic blocking escalation gate to its scoped durable digest", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const escalation = {
      id: "escalation_1",
      workThreadId: WORK_THREAD_ID,
      runId: RUN_ID,
      attemptId: RUN_ATTEMPT_ID,
      class: "verification" as const,
      audience: "operator" as const,
      subjectRef: "github:acme/demo:pull_request:1",
      state: "open" as const,
      blocking: true,
      summary: "Verification authority needs operator attention.",
      reason: "A required result is outcome-unknown.",
      openedAt: NOW.toISOString()
    };
    await expect(repo.openHumanEscalation({ escalation }))
      .resolves.toMatchObject({ created: true });
    const { acceptedAt: _acceptedAt, ...assessmentBase } = COMPLETION_ASSESSMENT;
    const blockedAssessment = {
      ...assessmentBase,
      id: "assessment_blocked_1",
      state: "blocked" as const,
      gateResults: [
        ...COMPLETION_ASSESSMENT.gateResults,
        {
          gateId: `human_escalation:${escalation.id}`,
          state: "unknown" as const,
          evidenceIds: [escalation.id],
          reasonCode: "human_acceptance_missing" as const,
          reason: escalation.reason,
          evaluatedAt: NOW.toISOString()
        }
      ]
    };

    await expect(repo.appendCompletionAssessment({
      assessment: blockedAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const [envelope] = assessmentProjectionEnvelopes(sqlite);
    const evidenceReceipts = (sqlite.prepare(`SELECT
      envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'
      ORDER BY receipt_id`).all() as Array<{ envelopeJson: string }>).map((row) =>
      CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
        JSON.parse(row.envelopeJson)
      )
    );
    const escalationReceipt = evidenceReceipts.find((receipt) =>
      receipt.payload.evidenceType === "human_escalation"
    );
    const verificationReceipt = evidenceReceipts.find((receipt) =>
      receipt.payload.evidenceType === "verification_evidence"
    );
    expect(escalationReceipt?.payload).toMatchObject({
      evidenceType: "human_escalation",
      evidenceId: escalation.id,
      authorityDigest: canonicalSha256Json(escalation),
      reasonDigest: canonicalSha256Json(escalation.reason)
    });
    expect(verificationReceipt?.predecessorReceiptDigests)
      .toContain(escalationReceipt?.receiptDigest);
    expect(envelope?.payload.gateResults).toContainEqual({
      gateId: `human_escalation:${escalation.id}`,
      state: "blocked",
      reasonCode: "human_acceptance_missing",
      evidenceReceiptDigests: [escalationReceipt?.receiptDigest]
    });
    expect(envelope?.payload.evidenceReceiptDigests).toEqual([
      escalationReceipt!.receiptDigest,
      verificationReceipt!.receiptDigest
    ].sort());
    sqlite.close();
  });

  it("replaces old callback triggers after adding target digest authority", async () => {
    const { sqlite, repo } = await setup();
    sqlite.exec(`
      DROP TRIGGER governed_callback_intents_target_digest_guard;
      DROP TRIGGER governed_callback_intents_authority_immutable_guard;
      DROP TRIGGER governed_callback_attempts_state_transition_guard;
      DROP TRIGGER governed_callback_attempts_terminal_receipt_guard;
      DROP TRIGGER governed_callback_attempts_receipt_write_guard;
      ALTER TABLE governed_callback_intents DROP COLUMN target_identity_digest;
      CREATE TRIGGER governed_callback_intents_authority_immutable_guard
      BEFORE UPDATE OF destination_id, organization_id, runner_id, producer_id,
        credential_id, registration_generation, run_id, work_thread_id,
        run_attempt_id, run_attempt_number, fencing_token_digest, admission_id,
        admission_operation_id, claim_operation_id, completion_operation_id,
        assessment_receipt_id, assessment_receipt_digest, local_delivery_id,
        provider, operation_id, payload_digest, intent_receipt_id,
        intent_receipt_digest, intent_receipt_json
      ON governed_callback_intents
      BEGIN SELECT RAISE(ABORT, 'old intent authority'); END;
      CREATE TRIGGER governed_callback_attempts_state_transition_guard
      BEFORE UPDATE OF state ON governed_callback_attempts
      WHEN NEW.state <> OLD.state AND NOT (
        (OLD.state = 'pending' AND NEW.state IN ('leased', 'attention'))
        OR (OLD.state = 'leased' AND NEW.state IN ('pending', 'sending', 'attention'))
        OR (OLD.state = 'sending' AND NEW.state IN
          ('accepted', 'rejected', 'outcome_unknown'))
      ) BEGIN SELECT RAISE(ABORT, 'old attempt transition'); END;
      CREATE TRIGGER governed_callback_attempts_terminal_receipt_guard
      BEFORE UPDATE OF state ON governed_callback_attempts
      WHEN OLD.state = 'sending' AND NEW.state IN ('accepted', 'rejected')
        AND NEW.provider_receipt_json IS NULL
      BEGIN SELECT RAISE(ABORT, 'old terminal tuple'); END;
      CREATE TRIGGER governed_callback_attempts_receipt_write_guard
      BEFORE UPDATE OF attempt_receipt_id, attempt_receipt_digest,
        attempt_receipt_json, provider_receipt_id, resource_identity,
        provider_receipt_digest, provider_receipt_json
      ON governed_callback_attempts
      WHEN NEW.state = OLD.state OR OLD.state <> 'sending'
      BEGIN SELECT RAISE(ABORT, 'old receipt write'); END;
    `);
    expect(() => migrateSchema(sqlite)).not.toThrow();
    const columns = sqlite.prepare("PRAGMA table_info(governed_callback_intents)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "target_identity_digest")).toBe(true);

    const leased = await enqueueAndClaim(repo, "intent_upgrade_leased_attention");
    const leasedAttention = attemptReceipt({
      localIntentId: leased.claimed.intent.localIntentId,
      localAttemptId: leased.claimed.attempt.localAttemptId,
      attemptNumber: leased.claimed.attempt.attemptNumber,
      requestDigest: leased.claimed.attempt.requestDigest,
      intentReceiptDigest: leased.claimed.intentReceiptDigest,
      attemptedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      outcome: "attention"
    });
    await expect(repo.quarantineGovernedCallbackAttempt({
      destinationId: "cloud_1", organizationId: "org_1",
      localIntentId: leased.claimed.intent.localIntentId,
      localAttemptId: leased.claimed.attempt.localAttemptId,
      leaseToken: leased.claimed.attempt.leaseToken!,
      attemptReceipt: leasedAttention,
      now: new Date(NOW.getTime() + 2_000)
    })).resolves.toBe("quarantined");

    const sending = await enqueueAndClaim(repo, "intent_upgrade_sending_attention");
    const sendingAt = new Date(NOW.getTime() + 3_000);
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1", organizationId: "org_1",
      localIntentId: sending.claimed.intent.localIntentId,
      localAttemptId: sending.claimed.attempt.localAttemptId,
      leaseToken: sending.claimed.attempt.leaseToken!, now: sendingAt
    });
    await expect(repo.finalizeGovernedCallbackAttempt({
      destinationId: "cloud_1", organizationId: "org_1",
      localIntentId: sending.claimed.intent.localIntentId,
      localAttemptId: sending.claimed.attempt.localAttemptId,
      leaseToken: sending.claimed.attempt.leaseToken!,
      attemptReceipt: attemptReceipt({
        localIntentId: sending.claimed.intent.localIntentId,
        localAttemptId: sending.claimed.attempt.localAttemptId,
        attemptNumber: sending.claimed.attempt.attemptNumber,
        requestDigest: sending.claimed.attempt.requestDigest,
        intentReceiptDigest: sending.claimed.intentReceiptDigest,
        attemptedAt: sendingAt.toISOString(), outcome: "attention"
      }),
      now: new Date(NOW.getTime() + 4_000)
    })).resolves.toBe("finalized");
    expect(() => sqlite.prepare(`UPDATE governed_callback_intents
      SET target_identity_digest = NULL WHERE local_intent_id = ?`)
      .run(sending.claimed.intent.localIntentId))
      .toThrow("governed_callback_intent_authority_immutable");
  });

  it("backfills old pending, leased, sending, and accepted target identities", async () => {
    const { sqlite, repo } = await setup();
    const states = ["pending", "leased", "sending", "accepted"] as const;
    for (const state of states) {
      const localIntentId = `intent_upgrade_backfill_${state}`;
      await repo.enqueueGovernedCallbackIntent({
        destinationId: "cloud_1",
        runnerId: "runner_1",
        idempotencyKey: `idempotency_${localIntentId}`,
        delivery: governedDelivery(),
        completionOperationId: COMPLETION_OPERATION_ID,
        authority: AUTHORITY,
        receipt: intentReceipt(localIntentId),
        now: NOW
      });
    }
    sqlite.exec(`
      DROP TRIGGER governed_callback_intents_target_digest_guard;
      DROP TRIGGER governed_callback_intents_authority_immutable_guard;
      DROP TRIGGER governed_callback_intents_state_transition_guard;
      DROP TRIGGER governed_callback_attempts_state_transition_guard;
      DROP TRIGGER callback_deliveries_governed_state_transition_guard;
      ALTER TABLE governed_callback_intents DROP COLUMN target_identity_digest;
    `);
    for (const state of states) {
      const localIntentId = `intent_upgrade_backfill_${state}`;
      sqlite.prepare(`UPDATE governed_callback_intents SET state = ?
        WHERE local_intent_id = ?`).run(state, localIntentId);
      sqlite.prepare(`UPDATE governed_callback_attempts SET state = ?
        WHERE local_intent_id = ?`).run(state, localIntentId);
      sqlite.prepare(`UPDATE callback_deliveries SET governed_state = ? WHERE id = (
        SELECT local_delivery_id FROM governed_callback_intents
        WHERE local_intent_id = ?
      )`).run(state, localIntentId);
    }

    expect(() => migrateSchema(sqlite)).not.toThrow();
    expect(sqlite.prepare(`SELECT state, target_identity_digest AS targetIdentityDigest
      FROM governed_callback_intents
      WHERE local_intent_id LIKE 'intent_upgrade_backfill_%'
      ORDER BY local_intent_id`).all()).toEqual([
      { state: "accepted", targetIdentityDigest: TARGET_IDENTITY_DIGEST },
      { state: "leased", targetIdentityDigest: TARGET_IDENTITY_DIGEST },
      { state: "pending", targetIdentityDigest: TARGET_IDENTITY_DIGEST },
      { state: "sending", targetIdentityDigest: TARGET_IDENTITY_DIGEST }
    ]);
  });

  it("fails closed when an old target identity cannot be proven", async () => {
    const { sqlite, repo } = await setup();
    const localIntentId = "intent_upgrade_unverifiable";
    await repo.enqueueGovernedCallbackIntent({
      destinationId: "cloud_1",
      runnerId: "runner_1",
      idempotencyKey: `idempotency_${localIntentId}`,
      delivery: governedDelivery(),
      completionOperationId: COMPLETION_OPERATION_ID,
      authority: AUTHORITY,
      receipt: intentReceipt(localIntentId),
      now: NOW
    });
    sqlite.exec(`
      DROP TRIGGER governed_callback_intents_target_digest_guard;
      DROP TRIGGER governed_callback_intents_authority_immutable_guard;
      DROP TRIGGER callback_deliveries_governed_immutable_guard;
      ALTER TABLE governed_callback_intents DROP COLUMN target_identity_digest;
    `);
    sqlite.prepare(`UPDATE callback_deliveries
      SET uri = 'https://api.github.com/repos/other/demo/issues/1/comments'
      WHERE id = (SELECT local_delivery_id FROM governed_callback_intents
        WHERE local_intent_id = ?)`)
      .run(localIntentId);

    expect(() => migrateSchema(sqlite))
      .toThrow("governed_callback_target_backfill_attention_required");
    expect(sqlite.prepare(`SELECT target_identity_digest AS targetIdentityDigest
      FROM governed_callback_intents WHERE local_intent_id = ?`)
      .get(localIntentId)).toEqual({ targetIdentityDigest: null });
  });

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

  for (const result of [
    RUN_RESULT,
    { conclusion: "failure", summary: "executor failed locally" },
    {
      conclusion: "needs_human",
      summary: "operator input is required",
      humanResolutionUnavailableReason: "No operator response is available."
    }
  ] satisfies TerminalResult[]) {
    it(`accepts a ${result.conclusion} terminal completion only with matching released attempt evidence`, async () => {
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
    });
  }

  it("projects execution-compat success without governed evidence", async () => {
    const isolated = await setupCompatibilityTerminal(RUN_RESULT);
    const compatibilityAssessment = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_compat_success",
      targetBindings: [],
      evidenceBacked: false,
      gateResults: [{
        gateId: "execution",
        state: "passed" as const,
        evidenceIds: [RUN_ID],
        reasonCode: "execution_succeeded" as const,
        reason: "Executor run succeeded under the compatibility contract.",
        evaluatedAt: NOW.toISOString()
      }]
    };

    await expect(isolated.repo.appendCompletionAssessment({
      assessment: compatibilityAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const [projection] = assessmentProjectionEnvelopes(isolated.sqlite);
    expect(projection?.payload).toMatchObject({
      contract: { mode: "execution_compat" },
      evidenceReceiptDigests: [],
      gateResults: [{
        gateId: "execution",
        state: "satisfied",
        reasonCode: "execution_succeeded",
        evidenceReceiptDigests: []
      }],
      conclusion: "satisfied"
    });
    isolated.sqlite.close();
  });

  it("cross-checks execution-compat terminal failure against the run result", async () => {
    const result = {
      conclusion: "failure" as const,
      summary: "executor failed locally"
    };
    const isolated = await setupCompatibilityTerminal(result);
    const { acceptedAt: _acceptedAt, ...assessmentBase } = COMPLETION_ASSESSMENT;
    const invalidPendingAssessment = {
      ...assessmentBase,
      id: "assessment_compat_incomplete",
      inputDigest: `sha256:${"e".repeat(64)}`,
      targetBindings: [],
      state: "pending" as const,
      evidenceBacked: false,
      gateResults: [{
        gateId: "execution",
        state: "missing" as const,
        evidenceIds: [],
        reasonCode: "execution_incomplete" as const,
        reason: "No terminal executor result is available.",
        evaluatedAt: NOW.toISOString()
      }]
    };
    const before = rejectedAssessmentMutationSnapshot(isolated.sqlite);

    await expect(isolated.repo.appendCompletionAssessment({
      assessment: invalidPendingAssessment,
      expectedCurrentAssessmentId: null
    })).rejects.toThrow("completion_assessment_projection_authority_conflict");
    expect(rejectedAssessmentMutationSnapshot(isolated.sqlite)).toBe(before);

    const failureAssessment = {
      ...invalidPendingAssessment,
      id: "assessment_compat_failure",
      inputDigest: `sha256:${"f".repeat(64)}`,
      state: "unsatisfied" as const,
      gateResults: [{
        ...invalidPendingAssessment.gateResults[0]!,
        state: "failed" as const,
        reasonCode: "execution_not_succeeded" as const,
        reason: "The terminal executor result did not succeed."
      }]
    };
    await expect(isolated.repo.appendCompletionAssessment({
      assessment: failureAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const [projection] = assessmentProjectionEnvelopes(isolated.sqlite);
    expect(projection?.payload).toMatchObject({
      contract: { mode: "execution_compat" },
      gateResults: [{
        gateId: "execution",
        state: "unsatisfied",
        reasonCode: "execution_not_succeeded",
        evidenceReceiptDigests: []
      }],
      conclusion: "unsatisfied"
    });
    isolated.sqlite.close();
  });

  it("allows one canonical waiver to override a failed execution-compat gate", async () => {
    const result = {
      conclusion: "failure" as const,
      summary: "executor failed locally"
    };
    const isolated = await setupCompatibilityTerminal(result);
    const waiver = {
      id: "waiver_compat_execution",
      runId: RUN_ID,
      contractId: isolated.contract.id,
      contractVersion: isolated.contract.version,
      cycle: isolated.contract.cycle,
      actor: {
        provider: "github",
        providerUserId: "owner-1",
        handle: "repo-owner"
      },
      reason: "The failed compatibility run is accepted for this bounded cycle.",
      scope: "selected_gates" as const,
      policyScope: "work_context_owner_container" as const,
      gateIds: ["execution"],
      waivedAt: NOW.toISOString()
    };
    await isolated.repo.recordCompletionWaiver({ waiver });
    const waivedAssessment = {
      ...COMPLETION_ASSESSMENT,
      id: "assessment_compat_waived",
      inputDigest: `sha256:${"0".repeat(64)}`,
      targetBindings: [],
      state: "waived" as const,
      evidenceBacked: false,
      gateResults: [{
        gateId: "execution",
        state: "waived" as const,
        evidenceIds: [],
        reasonCode: "gate_waived" as const,
        reason: "The execution gate was waived by the repository owner.",
        evaluatedAt: NOW.toISOString()
      }],
      assessedBy: "human" as const,
      waiver
    };

    await expect(isolated.repo.appendCompletionAssessment({
      assessment: waivedAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const [projection] = assessmentProjectionEnvelopes(isolated.sqlite);
    expect(projection?.payload).toMatchObject({
      contract: { mode: "execution_compat" },
      conclusion: "waived",
      waiver: { ref: waiver.id },
      gateResults: [{
        gateId: "execution",
        state: "waived",
        reasonCode: "gate_waived"
      }]
    });
    expect(projection?.payload.evidenceReceiptDigests).toHaveLength(1);
    const evidenceRows = isolated.sqlite.prepare(`SELECT envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'`).all() as Array<{
        envelopeJson: string;
      }>;
    expect(evidenceRows).toHaveLength(1);
    expect(CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(evidenceRows[0]!.envelopeJson)
    ).payload).toMatchObject({
      evidenceType: "completion_waiver",
      evidenceId: waiver.id
    });
    isolated.sqlite.close();
  });

  it("projects the exact Governance assessment using one global canonical waiver", async () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    const contract = {
      ...COMPLETION_CONTRACT,
      id: "contract_global_waiver",
      gates: [
        COMPLETION_CONTRACT.gates[0]!,
        { ...COMPLETION_CONTRACT.gates[0]!, id: "merge_checks" }
      ]
    };
    await expect(repo.recordCompletionContract({ contract }))
      .resolves.toMatchObject({ created: true });
    const tiedWaiver = {
      id: "waiver_z_checks_tied",
      runId: RUN_ID,
      contractId: contract.id,
      contractVersion: contract.version,
      cycle: contract.cycle,
      actor: {
        provider: "github" as const,
        providerUserId: "owner-1",
        handle: "repo-owner"
      },
      reason: "A same-instant bounded exception for the first gate.",
      scope: "selected_gates" as const,
      policyScope: "work_context_owner_container" as const,
      gateIds: ["checks"],
      waivedAt: NOW.toISOString()
    };
    const canonicalWaiver = {
      ...tiedWaiver,
      id: "waiver_a_merge_tied",
      reason: "The code-point winner applies only to merge checks.",
      gateIds: ["merge_checks"],
      waivedAt: "2026-08-10T00:00:00Z"
    };
    const invalidNewerWaiver = {
      ...tiedWaiver,
      id: "waiver_unknown_gate_newest",
      reason: "This waiver is outside the current contract and cannot be selected.",
      gateIds: ["not_in_contract"],
      waivedAt: new Date(NOW.getTime() + 2_000).toISOString()
    };
    for (const waiver of [tiedWaiver, canonicalWaiver, invalidNewerWaiver]) {
      await expect(repo.recordCompletionWaiver({ waiver }))
        .resolves.toMatchObject({ created: true });
    }
    await completeAndAcknowledge(repo);
    const assessment = evaluateCompletion({
      contract,
      runResults: [{
        runId: RUN_ID,
        result: RUN_RESULT,
        recordedAt: NOW.toISOString()
      }],
      artifacts: [{
        id: "artifact_1",
        kind: "pull_request",
        sourceRunId: RUN_ID,
        uri: "https://github.com/acme/demo/pull/1",
        target: {
          key: "primary_change",
          provider: "github",
          resourceRef: COMPLETION_FACT.subject.resourceRef,
          resourceVersion: COMPLETION_FACT.subject.resourceVersion
        },
        recordedAt: NOW.toISOString()
      }],
      evidence: [COMPLETION_FACT],
      materialActionReceipts: [],
      waivers: [tiedWaiver, canonicalWaiver, invalidNewerWaiver],
      blockingEscalations: [],
      evaluatedAt: new Date(NOW.getTime() + 3_000).toISOString(),
      lineage: { sequence: 1 }
    });
    expect(assessment).toMatchObject({
      state: "waived",
      waiver: { id: canonicalWaiver.id },
      gateResults: [
        { gateId: "checks", state: "passed", evidenceIds: [COMPLETION_FACT.id] },
        { gateId: "merge_checks", state: "waived", evidenceIds: [] }
      ]
    });

    await expect(repo.appendCompletionAssessment({
      assessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded", assessment });
    const [projection] = assessmentProjectionEnvelopes(sqlite);
    expect(projection?.payload).toMatchObject({
      conclusion: "waived",
      waiver: { ref: canonicalWaiver.id },
      gateResults: [
        { gateId: "checks", state: "satisfied" },
        { gateId: "merge_checks", state: "waived" }
      ]
    });
    const evidenceTypes = (sqlite.prepare(`SELECT envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'`).all() as Array<{
        envelopeJson: string;
      }>).map((row) => CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(row.envelopeJson)
    ).payload).map((payload) => [payload.evidenceType, payload.evidenceId]).sort();
    expect(evidenceTypes).toEqual([
      ["completion_waiver", canonicalWaiver.id],
      ["verification_evidence", COMPLETION_FACT.id]
    ]);
    sqlite.close();
  });

  it.each([
    ["whole-second", "2026-08-10T00:00:01Z", "2026-08-10T00:00:01Z"],
    [
      "sub-millisecond",
      "2026-08-10T00:00:00.0001Z",
      "2026-08-10T00:00:00.0009Z"
    ]
  ])("projects Governance %s evidence through the V1 timestamp bridge", async (
    _precision,
    observedAt,
    receivedAt
  ) => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const preciseFact = {
      ...COMPLETION_FACT,
      observedAt,
      receivedAt
    };
    const preciseEvidence = {
      ...VERIFICATION_EVIDENCE,
      createdAt: preciseFact.observedAt,
      metadata: { completionFact: preciseFact }
    };
    sqlite.prepare(`UPDATE verification_evidence
      SET evidence_json = ?, observed_at = ?, received_at = ?
      WHERE id = ?`).run(
        JSON.stringify(preciseEvidence),
        preciseFact.observedAt,
        preciseFact.receivedAt,
        preciseFact.id
      );
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const assessment = evaluateCompletion({
      contract: COMPLETION_CONTRACT,
      runResults: [{
        runId: RUN_ID,
        result: RUN_RESULT,
        recordedAt: NOW.toISOString()
      }],
      artifacts: [{
        id: "artifact_1",
        kind: "pull_request",
        sourceRunId: RUN_ID,
        uri: "https://github.com/acme/demo/pull/1",
        target: {
          key: "primary_change",
          provider: "github",
          resourceRef: COMPLETION_FACT.subject.resourceRef,
          resourceVersion: COMPLETION_FACT.subject.resourceVersion
        },
        recordedAt: NOW.toISOString()
      }],
      evidence: [preciseFact],
      materialActionReceipts: [],
      waivers: [],
      blockingEscalations: [],
      lineage: { sequence: 1 }
    });
    expect(assessment).toMatchObject({
      state: "satisfied",
      assessedAt: preciseFact.receivedAt,
      acceptedAt: preciseFact.receivedAt
    });

    await expect(repo.appendCompletionAssessment({
      assessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded", assessment });
    const [projection] = assessmentProjectionEnvelopes(sqlite);
    expect(projection?.payload.assessedAt).toBe(
      new Date(preciseFact.receivedAt).toISOString()
    );
    const evidence = sqlite.prepare(`SELECT envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'`).get() as {
        envelopeJson: string;
      };
    expect(CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(evidence.envelopeJson)
    ).payload).toMatchObject({
      observedAt: new Date(preciseFact.observedAt).toISOString(),
      receivedAt: new Date(preciseFact.receivedAt).toISOString()
    });
    sqlite.close();
  });

  it.each([
    [
      "newer non-matching role",
      "2026-08-10T00:00:00.001Z",
      "2026-08-10T00:00:00.002Z"
    ],
    [
      "same-instant conflicting role",
      "2026-08-10T00:00:00.002Z",
      "2026-08-10T00:00:00.002Z"
    ]
  ])("projects authoritative human acceptance for %s", async (
    _scenario,
    ownerObservedAt,
    reviewerObservedAt
  ) => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    seedAuthority(sqlite, {
      includeAssessment: false,
      includeAssessmentProjection: false
    });
    const contract = {
      ...COMPLETION_CONTRACT,
      targetSelectors: [],
      gates: [{
        id: "approval",
        kind: "human_acceptance" as const,
        requiredRole: "owner"
      }]
    };
    const contentDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(contract)).digest("hex")}`;
    sqlite.prepare(`UPDATE completion_contracts
      SET contract_json = ?, content_digest = ?
      WHERE id = ? AND version = ?`).run(
        JSON.stringify(contract),
        contentDigest,
        contract.id,
        contract.version
      );
    const owner = insertCompletionFact(sqlite, {
      id: "acceptance_owner",
      kind: "human.acceptance",
      predicate: "role",
      outcome: "owner",
      observedAt: ownerObservedAt
    });
    const reviewer = insertCompletionFact(sqlite, {
      id: "acceptance_reviewer",
      kind: "human.acceptance",
      predicate: "role",
      outcome: "reviewer",
      observedAt: reviewerObservedAt
    });
    const repo = createOpenTagRepository(drizzle(sqlite));
    await completeAndAcknowledge(repo);
    const assessment = evaluateCompletion({
      contract,
      runResults: [{
        runId: RUN_ID,
        result: RUN_RESULT,
        recordedAt: NOW.toISOString()
      }],
      artifacts: [],
      evidence: [owner, reviewer],
      materialActionReceipts: [],
      waivers: [],
      blockingEscalations: [],
      lineage: { sequence: 1 }
    });
    expect(assessment).toMatchObject({
      state: "pending",
      gateResults: [{
        gateId: "approval",
        state: "missing",
        reasonCode: "human_acceptance_missing",
        evidenceIds: []
      }]
    });

    await expect(repo.appendCompletionAssessment({
      assessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded", assessment });
    expect(assessmentProjectionEnvelopes(sqlite)[0]?.payload.gateResults)
      .toEqual([{
        gateId: "approval",
        state: "pending",
        reasonCode: "human_acceptance_missing",
        evidenceReceiptDigests: []
      }]);
    sqlite.close();
  });

  it("preserves a waived gate when a blocking escalation dominates the conclusion", async () => {
    const isolated = await setupCompatibilityTerminal({
      conclusion: "failure",
      summary: "executor failed locally"
    });
    const waiver = {
      id: "waiver_compat_blocked",
      runId: RUN_ID,
      contractId: isolated.contract.id,
      contractVersion: isolated.contract.version,
      cycle: isolated.contract.cycle,
      actor: {
        provider: "github",
        providerUserId: "owner-1",
        handle: "repo-owner"
      },
      reason: "The execution gate is waived while operator input remains blocking.",
      scope: "selected_gates" as const,
      policyScope: "work_context_owner_container" as const,
      gateIds: ["execution"],
      waivedAt: NOW.toISOString()
    };
    const escalation = {
      id: "escalation_compat_blocked",
      workThreadId: WORK_THREAD_ID,
      runId: RUN_ID,
      attemptId: RUN_ATTEMPT_ID,
      class: "missing_input" as const,
      audience: "operator" as const,
      subjectRef: "compatibility:execution",
      state: "open" as const,
      blocking: true,
      summary: "Operator input is still required.",
      reason: "The execution waiver does not resolve the blocking input request.",
      openedAt: NOW.toISOString()
    };
    await isolated.repo.recordCompletionWaiver({ waiver });
    await isolated.repo.openHumanEscalation({ escalation });
    const { acceptedAt: _acceptedAt, ...assessmentBase } = COMPLETION_ASSESSMENT;
    const blockedAssessment = {
      ...assessmentBase,
      id: "assessment_compat_blocked_waiver",
      inputDigest: `sha256:${"1".repeat(64)}`,
      targetBindings: [],
      state: "blocked" as const,
      evidenceBacked: false,
      gateResults: [
        {
          gateId: "execution",
          state: "waived" as const,
          evidenceIds: [],
          reasonCode: "gate_waived" as const,
          reason: "The execution gate was waived by the repository owner.",
          evaluatedAt: NOW.toISOString()
        },
        {
          gateId: `human_escalation:${escalation.id}`,
          state: "unknown" as const,
          evidenceIds: [escalation.id],
          reasonCode: "human_acceptance_missing" as const,
          reason: escalation.reason,
          evaluatedAt: NOW.toISOString()
        }
      ],
      assessedBy: "human" as const,
      waiver
    };

    await expect(isolated.repo.appendCompletionAssessment({
      assessment: blockedAssessment,
      expectedCurrentAssessmentId: null
    })).resolves.toMatchObject({ outcome: "recorded" });
    const [projection] = assessmentProjectionEnvelopes(isolated.sqlite);
    expect(projection?.payload).toMatchObject({
      conclusion: "blocked",
      waiver: { ref: waiver.id },
      gateResults: [
        { gateId: "execution", state: "waived", reasonCode: "gate_waived" },
        {
          gateId: `human_escalation:${escalation.id}`,
          state: "blocked",
          reasonCode: "human_acceptance_missing"
        }
      ]
    });
    expect(projection?.payload.evidenceReceiptDigests).toHaveLength(2);
    const evidenceTypes = (isolated.sqlite.prepare(`SELECT envelope_json AS envelopeJson
      FROM control_plane_projection_outbox
      WHERE receipt_kind = 'completion_evidence_observation'`).all() as Array<{
        envelopeJson: string;
      }>).map((row) => CompletionEvidenceObservationReceiptEnvelopeV1Schema.parse(
        JSON.parse(row.envelopeJson)
      ).payload.evidenceType).sort();
    expect(evidenceTypes).toEqual(["completion_waiver", "human_escalation"]);
    isolated.sqlite.close();
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
      intentReceiptDigest: expect.stringMatching(/^sha256:/),
      targetIdentityDigest: TARGET_IDENTITY_DIGEST
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
    expect(() => sqlite.prepare(
      "UPDATE governed_callback_intents SET target_identity_digest = NULL WHERE local_intent_id = ?"
    ).run(claimed.intent.localIntentId))
      .toThrow("governed_callback_intent_authority_immutable");
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
    ).get()).toEqual({ count: 6 });
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
    })).rejects.toMatchObject({ code: "GOVERNED_CALLBACK_AUTHORITY_CONFLICT" });
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

  it("quarantines an expired claimed callback when frozen authority is invalid", async () => {
    const { sqlite, repo } = await setup();
    const { claimed } = await enqueueAndClaim(
      repo,
      "intent_expired_authority_conflict"
    );
    sqlite.prepare("UPDATE runs SET event_json = '{}' WHERE id = ?")
      .run(RUN_ID);

    await expect(repo.recoverExpiredGovernedCallbacks({
      destinationId: "cloud_1",
      organizationId: "org_1",
      now: new Date(NOW.getTime() + 31_000)
    })).resolves.toEqual({ requeued: 0, outcomeUnknown: 0 });

    expect(sqlite.prepare(`SELECT state, last_reason_code AS reasonCode
      FROM governed_callback_intents WHERE local_intent_id = ?`)
      .get(claimed.intent.localIntentId)).toEqual({
      state: "attention",
      reasonCode: "callback_local_error"
    });
    const attemptRow = sqlite.prepare(`SELECT state, attempt_receipt_digest AS receiptDigest,
      attempt_receipt_json AS receiptJson, provider_receipt_id AS providerReceiptId,
      resource_identity AS resourceIdentity,
      provider_receipt_digest AS providerReceiptDigest,
      provider_receipt_json AS providerReceiptJson
      FROM governed_callback_attempts WHERE local_attempt_id = ?`)
      .get(claimed.attempt.localAttemptId) as {
        state: string;
        receiptDigest: string;
        receiptJson: string;
        providerReceiptId: string | null;
        resourceIdentity: string | null;
        providerReceiptDigest: string | null;
        providerReceiptJson: string | null;
      };
    expect(attemptRow).toMatchObject({
      state: "attention",
      providerReceiptId: null,
      resourceIdentity: null,
      providerReceiptDigest: null,
      providerReceiptJson: null
    });
    const receipt = CallbackAttemptObservationReceiptEnvelopeV1Schema.parse(
      JSON.parse(attemptRow.receiptJson)
    );
    const { receiptDigest, payloadDigest, ...receiptBase } = receipt;
    expect(payloadDigest).toBe(canonicalSha256Json(receipt.payload));
    expect(receiptDigest).toBe(canonicalSha256Json({
      ...receiptBase,
      payloadDigest
    }));
    expect(attemptRow.receiptDigest).toBe(receiptDigest);
    expect(receipt.predecessorReceiptDigests).toEqual([
      claimed.intentReceiptDigest
    ]);
    expect(receipt.payload).toMatchObject({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      outcome: "attention",
      reasonCode: "callback_local_error",
      nextAction: "repair-local-callback",
      owner: PRODUCER.id
    });
    expect(sqlite.prepare(`SELECT governed_state AS state
      FROM callback_deliveries WHERE id = ?`)
      .get(claimed.delivery.id)).toEqual({ state: "attention" });
    await expect(repo.claimGovernedCallbackIntents({
      destinationId: "cloud_1",
      organizationId: "org_1",
      leaseOwner: "worker_2",
      leaseSeconds: 30,
      now: new Date(NOW.getTime() + 32_000)
    })).resolves.toEqual([]);
    const audit = sqlite.prepare(`SELECT payload_json AS payloadJson
      FROM run_events WHERE run_id = ? AND type = 'callback.governed.attention'
      ORDER BY id DESC LIMIT 1`).get(RUN_ID) as { payloadJson: string };
    expect(JSON.parse(audit.payloadJson)).toMatchObject({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      detail: "authority_conflict"
    });
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
    expect(sqlite.prepare("SELECT count(*) AS count FROM control_plane_projection_outbox").get()).toEqual({ count: 5 });
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
      expect(sqlite.prepare("SELECT state FROM governed_callback_intents").get())
        .toEqual({ state: outcome === "outcome_unknown" ? "attention" : outcome });
      expect(sqlite.prepare("SELECT count(*) AS count FROM control_plane_projection_outbox").get())
        .toEqual({ count: outcome === "rejected" ? 7 : 6 });
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
      await repo.finalizeGovernedCallbackAttempt({
        destinationId: "cloud_1", organizationId: "org_1",
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        leaseToken: claimed.attempt.leaseToken!, attemptReceipt: unknownAttempt,
        now: new Date(NOW.getTime() + 2_000)
      });
      const positive = providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: resolution, observedAt: new Date(NOW.getTime() + 3_000).toISOString(),
        attemptReceiptDigest: unknownAttempt.receiptDigest,
        predecessorReceiptDigest: unknownAttempt.receiptDigest,
        providerReceiptId: resolution === "accepted"
          ? "comment_456"
          : "provider_receipt_positive_rejected"
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
    await repo.finalizeGovernedCallbackAttempt({
      destinationId: "cloud_1", organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!, attemptReceipt: unknownAttempt,
      now: new Date(NOW.getTime() + 2_000)
    });
    const candidate = (overrides: Partial<Parameters<typeof providerReceipt>[0]> = {}) =>
      providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: "accepted",
        observedAt: new Date(NOW.getTime() + 3_000).toISOString(),
        attemptReceiptDigest: unknownAttempt.receiptDigest,
        predecessorReceiptDigest: unknownAttempt.receiptDigest,
        providerReceiptId: "comment_789",
        ...overrides
      });
    const rejected = [
      candidate({ predecessorReceiptDigest: `sha256:${"0".repeat(64)}` }),
      candidate({ resourceIdentity: "github:comment:788" }),
      candidate({ observedAt: new Date(NOW.getTime() + 500).toISOString() }),
      candidate({ targetIdentityDigest: `sha256:${"0".repeat(64)}` }),
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
      .toEqual({ state: "attention" });
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

  it("binds GitHub targets to the frozen event digest, repository, and issue or PR", async () => {
    const invalidTargets = [
      "https://example.test/callback",
      "https://api.github.com/repos/acme/other/issues/1/comments",
      "https://api.github.com/repos/acme/demo/issues/2/comments"
    ];
    for (const [index, target] of invalidTargets.entries()) {
      const { repo } = await setup();
      await expect(repo.enqueueGovernedCallbackIntent({
        destinationId: "cloud_1",
        runnerId: "runner_1",
        idempotencyKey: `target_invalid_${index}`,
        delivery: { ...governedDelivery(), target },
        completionOperationId: COMPLETION_OPERATION_ID,
        authority: AUTHORITY,
        receipt: intentReceipt(`intent_target_invalid_${index}`),
        now: NOW
      })).rejects.toBeInstanceOf(GovernedCallbackConflictError);
    }

    const digestMismatch = await setup();
    digestMismatch.sqlite.exec("DROP TRIGGER hosted_run_imports_immutable_update_guard");
    digestMismatch.sqlite.prepare(
      "UPDATE hosted_run_imports SET event_digest = ? WHERE run_id = ?"
    ).run(`sha256:${"0".repeat(64)}`, RUN_ID);
    await expect(digestMismatch.repo.enqueueGovernedCallbackIntent({
      destinationId: "cloud_1",
      runnerId: "runner_1",
      idempotencyKey: "target_event_digest_mismatch",
      delivery: governedDelivery(),
      completionOperationId: COMPLETION_OPERATION_ID,
      authority: AUTHORITY,
      receipt: intentReceipt("intent_target_event_digest_mismatch"),
      now: NOW
    })).rejects.toMatchObject({ code: "GOVERNED_CALLBACK_AUTHORITY_CONFLICT" });

    const pullRequest = await setup();
    pullRequest.sqlite.exec("DROP TRIGGER hosted_run_imports_immutable_update_guard");
    const run = pullRequest.sqlite.prepare("SELECT event_json AS eventJson FROM runs WHERE id = ?")
      .get(RUN_ID) as { eventJson: string };
    const event = OpenTagEventSchema.parse({
      ...JSON.parse(run.eventJson),
      metadata: { owner: "acme", repo: "demo", pullRequestNumber: 1 }
    });
    pullRequest.sqlite.prepare("UPDATE runs SET event_json = ? WHERE id = ?")
      .run(JSON.stringify(event), RUN_ID);
    pullRequest.sqlite.prepare("UPDATE hosted_run_imports SET event_digest = ? WHERE run_id = ?")
      .run(canonicalSha256Json(event), RUN_ID);
    await expect(pullRequest.repo.enqueueGovernedCallbackIntent({
      destinationId: "cloud_1",
      runnerId: "runner_1",
      idempotencyKey: "target_pr",
      delivery: governedDelivery(),
      completionOperationId: COMPLETION_OPERATION_ID,
      authority: AUTHORITY,
      receipt: intentReceipt("intent_target_pr"),
      now: NOW
    })).resolves.toMatchObject({ outcome: "created" });
  });

  it("quarantines a claimed preflight failure before provider I/O", async () => {
    const { sqlite, repo } = await setup();
    const { claimed } = await enqueueAndClaim(repo, "intent_preflight_attention");
    const receipt = attemptReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      intentReceiptDigest: claimed.intentReceiptDigest,
      attemptedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      outcome: "attention"
    });
    await expect(repo.quarantineGovernedCallbackAttempt({
      destinationId: "cloud_1",
      organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      attemptReceipt: receipt,
      now: new Date(NOW.getTime() + 2_000)
    })).resolves.toBe("quarantined");
    expect(sqlite.prepare(`SELECT state, reason_code AS reasonCode,
      next_action AS nextAction, provider_receipt_json AS providerReceiptJson
      FROM governed_callback_attempts`).get()).toEqual({
      state: "attention",
      reasonCode: "callback_sink_unhandled",
      nextAction: "repair-local-callback",
      providerReceiptJson: null
    });
    expect(sqlite.prepare("SELECT state FROM governed_callback_intents").get())
      .toEqual({ state: "attention" });
    expect(sqlite.prepare("SELECT governed_state AS state FROM callback_deliveries WHERE dispatch_mode = 'governed'").get())
      .toEqual({ state: "attention" });
    await expect(repo.recoverExpiredGovernedCallbacks({
      destinationId: "cloud_1",
      organizationId: "org_1",
      now: new Date(NOW.getTime() + 60_000)
    })).resolves.toEqual({ requeued: 0, outcomeUnknown: 0 });
  });

  it("rejects an unknown attempt carrying any forged provider receipt tuple", async () => {
    const { sqlite, repo } = await setup();
    const { claimed } = await enqueueAndClaim(repo, "intent_unknown_tuple_guard");
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1", organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      now: new Date(NOW.getTime() + 1_000)
    });
    expect(() => sqlite.prepare(`UPDATE governed_callback_attempts SET
      state = 'outcome_unknown', attempt_receipt_id = 'receipt_attempt',
      attempt_receipt_digest = ?, attempt_receipt_json = '{}',
      provider_receipt_id = 'provider_receipt_forged',
      resource_identity = 'github:issue:1', provider_receipt_digest = ?,
      provider_receipt_json = '{}' WHERE local_attempt_id = ?`).run(
      `sha256:${"1".repeat(64)}`,
      `sha256:${"2".repeat(64)}`,
      claimed.attempt.localAttemptId
    )).toThrow("incomplete governed callback terminal receipt tuple");
  });

  it("returns the persisted unknown attempt anchor when recovery wins a late finalize race", async () => {
    const { repo } = await setup();
    const { claimed } = await enqueueAndClaim(repo, "intent_late_finalize");
    const sendingAt = new Date(NOW.getTime() + 1_000);
    await repo.beginGovernedCallbackSending({
      destinationId: "cloud_1", organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!, now: sendingAt
    });
    await repo.recoverExpiredGovernedCallbacks({
      destinationId: "cloud_1", organizationId: "org_1",
      now: new Date(NOW.getTime() + 31_000)
    });
    const accepted = attemptReceipt({
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      attemptNumber: claimed.attempt.attemptNumber,
      requestDigest: claimed.attempt.requestDigest,
      intentReceiptDigest: claimed.intentReceiptDigest,
      attemptedAt: sendingAt.toISOString(), outcome: "accepted"
    });
    await expect(repo.finalizeGovernedCallbackAttempt({
      destinationId: "cloud_1", organizationId: "org_1",
      localIntentId: claimed.intent.localIntentId,
      localAttemptId: claimed.attempt.localAttemptId,
      leaseToken: claimed.attempt.leaseToken!,
      attemptReceipt: accepted,
      providerReceipt: providerReceipt({
        localIntentId: claimed.intent.localIntentId,
        localAttemptId: claimed.attempt.localAttemptId,
        outcome: "accepted",
        observedAt: new Date(NOW.getTime() + 32_000).toISOString(),
        attemptReceiptDigest: accepted.receiptDigest
      }),
      now: new Date(NOW.getTime() + 32_000)
    })).resolves.toMatchObject({
      outcome: "reconciliation_required",
      attemptReceiptId: `receipt_${claimed.attempt.localAttemptId}`
    });
  });

  it("finds one durable accepted GitHub comment without latest-wins ambiguity", async () => {
    const { repo } = await setup();
    const record = async (id: string, commentId: number, reconcile = false) => {
      const delivery = { ...governedDelivery(), statusMessageKey: "final-status" };
      const intent = intentReceiptWithPayloadDigest(id, canonicalSha256Json({
        method: "POST",
        mode: delivery.mode,
        target: delivery.target,
        body: delivery.body,
        threadKey: null,
        agentId: null,
        statusMessageKey: delivery.statusMessageKey,
        blocks: null,
        rich: null
      }));
      await repo.enqueueGovernedCallbackIntent({
        destinationId: "cloud_1",
        runnerId: "runner_1",
        idempotencyKey: `lookup_${id}`,
        delivery,
        completionOperationId: COMPLETION_OPERATION_ID,
        authority: AUTHORITY,
        receipt: intent,
        now: NOW
      });
      const [claimed] = await repo.claimGovernedCallbackIntents({
        destinationId: "cloud_1", organizationId: "org_1",
        leaseOwner: `worker_${id}`, leaseSeconds: 30, now: NOW
      });
      const sendingAt = new Date(NOW.getTime() + 1_000);
      await repo.beginGovernedCallbackSending({
        destinationId: "cloud_1", organizationId: "org_1",
        localIntentId: claimed!.intent.localIntentId,
        localAttemptId: claimed!.attempt.localAttemptId,
        leaseToken: claimed!.attempt.leaseToken!, now: sendingAt
      });
      const attempt = attemptReceipt({
        localIntentId: claimed!.intent.localIntentId,
        localAttemptId: claimed!.attempt.localAttemptId,
        attemptNumber: claimed!.attempt.attemptNumber,
        requestDigest: claimed!.attempt.requestDigest,
        intentReceiptDigest: claimed!.intentReceiptDigest,
        attemptedAt: sendingAt.toISOString(),
        outcome: reconcile ? "outcome_unknown" : "accepted"
      });
      await repo.finalizeGovernedCallbackAttempt({
        destinationId: "cloud_1", organizationId: "org_1",
        localIntentId: claimed!.intent.localIntentId,
        localAttemptId: claimed!.attempt.localAttemptId,
        leaseToken: claimed!.attempt.leaseToken!,
        attemptReceipt: attempt,
        ...(!reconcile ? {
          providerReceipt: providerReceipt({
            localIntentId: claimed!.intent.localIntentId,
            localAttemptId: claimed!.attempt.localAttemptId,
            outcome: "accepted" as const,
            observedAt: attempt.observedAt,
            attemptReceiptDigest: attempt.receiptDigest,
            providerReceiptId: `comment_${commentId}`
          })
        } : {}),
        now: new Date(NOW.getTime() + 2_000)
      });
      if (reconcile) {
        await repo.reconcileGovernedCallbackOutcome({
          destinationId: "cloud_1", organizationId: "org_1",
          localIntentId: claimed!.intent.localIntentId,
          localAttemptId: claimed!.attempt.localAttemptId,
          providerReceipt: providerReceipt({
            localIntentId: claimed!.intent.localIntentId,
            localAttemptId: claimed!.attempt.localAttemptId,
            outcome: "accepted",
            observedAt: new Date(NOW.getTime() + 3_000).toISOString(),
            attemptReceiptDigest: attempt.receiptDigest,
            providerReceiptId: `comment_${commentId}`
          }),
          now: new Date(NOW.getTime() + 3_000)
        });
      }
    };
    const lookup = () => repo.getPriorAcceptedGovernedGitHubResource({
      destinationId: "cloud_1",
      organizationId: "org_1",
      runId: RUN_ID,
      workThreadId: WORK_THREAD_ID,
      statusMessageKey: "final-status",
      targetIdentityDigest: TARGET_IDENTITY_DIGEST
    });
    await expect(lookup()).resolves.toEqual({ outcome: "not_found" });
    await record("intent_lookup_direct", 123);
    await expect(lookup()).resolves.toEqual({
      outcome: "found",
      providerReceiptId: "comment_123",
      resourceIdentity: "github:comment:123",
      targetIdentityDigest: TARGET_IDENTITY_DIGEST
    });
    await record("intent_lookup_reconciled", 123, true);
    await expect(lookup()).resolves.toMatchObject({
      outcome: "found",
      resourceIdentity: "github:comment:123"
    });
    await record("intent_lookup_conflict", 456);
    await expect(lookup()).resolves.toEqual({ outcome: "conflict" });
  });

  it("keeps legacy callback attention out of all retry claiming", async () => {
    const { repo } = await setup();
    const delivery = await repo.enqueueCallbackDelivery({
      runId: RUN_ID,
      kind: "final",
      provider: "github",
      uri: DELIVERY_TARGET,
      body: "requires operator repair"
    });
    await repo.markCallbackAttention({
      deliveryId: delivery.id,
      reasonCode: "provider_outcome_unknown",
      nextAction: "reconcile-provider",
      owner: "local_opentag"
    });
    await expect(repo.listPendingCallbackDeliveries({ limit: 10 })).resolves.toEqual([]);
    await expect(repo.claimPendingCallbackDeliveries({ limit: 10 })).resolves.toEqual([]);
    await expect(repo.listRunEvents({ runId: RUN_ID })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({
        type: "callback.final.attention",
        payload: expect.objectContaining({ status: "attention", attempts: 1 })
      })])
    );
  });
});
