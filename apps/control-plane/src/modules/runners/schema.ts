import { sql } from "drizzle-orm";
import {
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

export const runners = pgTable(
  "cp_runner",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.organizationId),
    runnerId: text("runner_id").notNull(),
    displayName: text("display_name"),
    registrationGeneration: integer("registration_generation").notNull(),
    credentialGeneration: integer("credential_generation").notNull(),
    currentCredentialId: text("current_credential_id").notNull(),
    capabilities: jsonb("capabilities").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.runnerId] }),
    unique("cp_runner_organization_id_current_credential_id_key").on(
      table.organizationId,
      table.currentCredentialId,
    ),
    check(
      "cp_runner_registration_generation_check",
      sql`${table.registrationGeneration} > 0`,
    ),
    check(
      "cp_runner_credential_generation_check",
      sql`${table.credentialGeneration} > 0`,
    ),
  ],
);

export const runnerCredentials = pgTable(
  "cp_runner_credential",
  {
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    credentialId: text("credential_id").notNull(),
    credentialGeneration: integer("credential_generation").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.credentialId] }),
    unique("cp_runner_credential_token_hash_key").on(table.tokenHash),
    unique(
      "cp_runner_credential_organization_id_runner_id_credential_generation_key",
    ).on(
      table.organizationId,
      table.runnerId,
      table.credentialGeneration,
    ),
    foreignKey({
      columns: [table.organizationId, table.runnerId],
      foreignColumns: [runners.organizationId, runners.runnerId],
    }),
    check(
      "cp_runner_credential_credential_generation_check",
      sql`${table.credentialGeneration} > 0`,
    ),
  ],
);

export const runnerOperations = pgTable(
  "cp_runner_operation",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.organizationId),
    operationId: text("operation_id").notNull(),
    requestId: text("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    operationKind: text("operation_kind").notNull(),
    runnerId: text("runner_id").notNull(),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.operationId] }),
  ],
);

export const runnerReadiness = pgTable(
  "cp_runner_readiness",
  {
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    receiptId: text("receipt_id").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    receipt: jsonb("receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.receiptId] }),
    unique("cp_runner_readiness_organization_id_runner_id_receipt_digest_key").on(
      table.organizationId,
      table.runnerId,
      table.receiptDigest,
    ),
    foreignKey({
      columns: [table.organizationId, table.runnerId],
      foreignColumns: [runners.organizationId, runners.runnerId],
    }),
    index("cp_runner_readiness_current_idx").on(
      table.organizationId,
      table.runnerId,
      table.observedAt.desc(),
    ),
  ],
);

export const projectTargets = pgTable(
  "cp_project_target",
  {
    organizationId: text("organization_id").notNull(),
    projectTargetId: text("project_target_id").notNull(),
    runnerId: text("runner_id").notNull(),
    bindingDigest: text("binding_digest").notNull(),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    defaultExecutor: text("default_executor").notNull(),
    defaultBranch: text("default_branch"),
    version: integer("version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.projectTargetId] }),
    foreignKey({
      columns: [table.organizationId, table.runnerId],
      foreignColumns: [runners.organizationId, runners.runnerId],
    }),
    check("cp_project_target_version_check", sql`${table.version} > 0`),
  ],
);
