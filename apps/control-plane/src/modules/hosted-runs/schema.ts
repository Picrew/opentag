import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../identity/schema.js";
import { runners } from "../runners/schema.js";

export const hostedRuns = pgTable(
  "cp_hosted_run",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.organizationId),
    runId: text("run_id").notNull(),
    admissionId: text("admission_id").notNull(),
    admissionOperationId: text("admission_operation_id").notNull(),
    admissionDigest: text("admission_digest").notNull(),
    sourceIdentityDigest: text("source_identity_digest").notNull(),
    runnerId: text("runner_id").notNull(),
    executorId: text("executor_id").notNull(),
    state: text("state").notNull(),
    currentAttemptNumber: integer("current_attempt_number").notNull().default(0),
    terminalKind: text("terminal_kind"),
    terminalReceipt: jsonb("terminal_receipt"),
    hostedAdmission: jsonb("hosted_admission").notNull(),
    admissionPolicySnapshot: jsonb("admission_policy_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.runId] }),
    unique("cp_hosted_run_organization_id_admission_id_key").on(
      table.organizationId,
      table.admissionId,
    ),
    unique("cp_hosted_run_organization_id_source_identity_digest_key").on(
      table.organizationId,
      table.sourceIdentityDigest,
    ),
    foreignKey({
      columns: [table.organizationId, table.runnerId],
      foreignColumns: [runners.organizationId, runners.runnerId],
    }),
    check(
      "cp_hosted_run_state_check",
      sql`${table.state} IN ('pending', 'claimed', 'running', 'cancelled', 'completed', 'rejected')`,
    ),
    check(
      "cp_hosted_run_current_attempt_number_check",
      sql`${table.currentAttemptNumber} >= 0`,
    ),
    check(
      "cp_hosted_run_terminal_kind_check",
      sql`${table.terminalKind} IN ('cancelled', 'completed', 'rejected')`,
    ),
    check(
      "cp_hosted_run_terminal_receipt_check",
      sql`(${table.terminalKind} IS NULL) = (${table.terminalReceipt} IS NULL)`,
    ),
    index("cp_hosted_run_claim_idx").on(
      table.organizationId,
      table.runnerId,
      table.state,
      table.createdAt,
    ),
  ],
);

export const hostedAttempts = pgTable(
  "cp_hosted_attempt",
  {
    organizationId: text("organization_id").notNull(),
    runId: text("run_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    attemptId: text("attempt_id").notNull(),
    runnerId: text("runner_id").notNull(),
    credentialId: text("credential_id").notNull(),
    fencingTokenDigest: text("fencing_token_digest").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    state: text("state").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.runId, table.attemptNumber],
    }),
    unique("cp_hosted_attempt_organization_id_attempt_id_key").on(
      table.organizationId,
      table.attemptId,
    ),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [hostedRuns.organizationId, hostedRuns.runId],
    }),
    check(
      "cp_hosted_attempt_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "cp_hosted_attempt_state_check",
      sql`${table.state} IN ('claimed', 'running', 'cancelled', 'completed', 'rejected', 'expired')`,
    ),
  ],
);

export const hostedClaims = pgTable(
  "cp_hosted_claim",
  {
    organizationId: text("organization_id").notNull(),
    operationId: text("operation_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    runId: text("run_id").notNull(),
    claim: jsonb("claim").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.operationId] }),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [hostedRuns.organizationId, hostedRuns.runId],
    }),
  ],
);

export const hostedLifecycleReceipts = pgTable(
  "cp_hosted_lifecycle_receipt",
  {
    organizationId: text("organization_id").notNull(),
    operationId: text("operation_id").notNull(),
    requestId: text("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    action: text("action").notNull(),
    receipt: jsonb("receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.operationId] }),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [hostedRuns.organizationId, hostedRuns.runId],
    }),
    check(
      "cp_hosted_lifecycle_receipt_action_check",
      sql`${table.action} IN ('heartbeat', 'running', 'progress', 'reject_start', 'executor_result', 'cancel')`,
    ),
  ],
);

export const hostedAuditEvents = pgTable(
  "cp_hosted_audit_event",
  {
    sequenceId: bigint("sequence_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    organizationId: text("organization_id").notNull(),
    runId: text("run_id").notNull(),
    eventKind: text("event_kind").notNull(),
    event: jsonb("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [hostedRuns.organizationId, hostedRuns.runId],
    }),
    index("cp_hosted_audit_run_idx").on(
      table.organizationId,
      table.runId,
      table.sequenceId,
    ),
  ],
);

export const permissionRequests = pgTable(
  "cp_permission_request",
  {
    organizationId: text("organization_id").notNull(),
    permissionRequestId: text("permission_request_id").notNull(),
    runId: text("run_id").notNull(),
    runnerId: text("runner_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    actionId: text("action_id").notNull(),
    resolutionId: text("resolution_id").notNull(),
    permissionRequestDigest: text("permission_request_digest").notNull(),
    policySnapshotDigest: text("policy_snapshot_digest").notNull(),
    state: text("state").notNull(),
    request: jsonb("request").notNull(),
    currentReceipt: jsonb("current_receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.permissionRequestId] }),
    unique(
      "cp_permission_request_organization_id_run_id_attempt_id_action_id_key",
    ).on(
      table.organizationId,
      table.runId,
      table.attemptId,
      table.actionId,
    ),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [hostedRuns.organizationId, hostedRuns.runId],
    }),
    foreignKey({
      columns: [table.organizationId, table.runId, table.attemptNumber],
      foreignColumns: [
        hostedAttempts.organizationId,
        hostedAttempts.runId,
        hostedAttempts.attemptNumber,
      ],
    }),
    check(
      "cp_permission_request_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "cp_permission_request_state_check",
      sql`${table.state} IN ('waiting', 'authorized', 'denied')`,
    ),
    index("cp_permission_current_idx").on(
      table.organizationId,
      table.runId,
      table.state,
      table.updatedAt.desc(),
    ),
  ],
);

export const permissionOperations = pgTable(
  "cp_permission_operation",
  {
    organizationId: text("organization_id").notNull(),
    operationId: text("operation_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    permissionRequestId: text("permission_request_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    receipt: jsonb("receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.operationId] }),
    foreignKey({
      columns: [table.organizationId, table.permissionRequestId],
      foreignColumns: [
        permissionRequests.organizationId,
        permissionRequests.permissionRequestId,
      ],
    }),
    check(
      "cp_permission_operation_operation_kind_check",
      sql`${table.operationKind} IN ('request', 'decision')`,
    ),
  ],
);

export const materialActionReceipts = pgTable(
  "cp_material_action_receipt",
  {
    organizationId: text("organization_id").notNull(),
    receiptId: text("receipt_id").notNull(),
    operationId: text("operation_id").notNull(),
    runId: text("run_id").notNull(),
    runnerId: text("runner_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    actionId: text("action_id").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    outcome: text("outcome").notNull(),
    receipt: jsonb("receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.receiptId] }),
    unique("cp_material_action_receipt_organization_id_operation_id_key").on(
      table.organizationId,
      table.operationId,
    ),
    unique("cp_material_action_receipt_organization_id_receipt_digest_key").on(
      table.organizationId,
      table.receiptDigest,
    ),
    foreignKey({
      columns: [table.organizationId, table.runId],
      foreignColumns: [hostedRuns.organizationId, hostedRuns.runId],
    }),
    foreignKey({
      columns: [table.organizationId, table.runId, table.attemptNumber],
      foreignColumns: [
        hostedAttempts.organizationId,
        hostedAttempts.runId,
        hostedAttempts.attemptNumber,
      ],
    }),
    check(
      "cp_material_action_receipt_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "cp_material_action_receipt_outcome_check",
      sql`${table.outcome} IN ('succeeded', 'failed', 'outcome_unknown')`,
    ),
    index("cp_material_action_run_idx").on(
      table.organizationId,
      table.runId,
      table.createdAt,
      table.receiptId,
    ),
  ],
);

export const materialActionCurrent = pgTable(
  "cp_material_action_current",
  {
    organizationId: text("organization_id").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    actionId: text("action_id").notNull(),
    receiptId: text("receipt_id").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    outcome: text("outcome").notNull(),
    receipt: jsonb("receipt").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.runId,
        table.attemptId,
        table.actionId,
      ],
    }),
    foreignKey({
      columns: [table.organizationId, table.receiptId],
      foreignColumns: [
        materialActionReceipts.organizationId,
        materialActionReceipts.receiptId,
      ],
    }),
    check(
      "cp_material_action_current_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "cp_material_action_current_outcome_check",
      sql`${table.outcome} IN ('succeeded', 'failed', 'outcome_unknown')`,
    ),
  ],
);
