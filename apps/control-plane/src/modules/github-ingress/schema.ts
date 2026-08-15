import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../identity/schema.js";
import { runners } from "../runners/schema.js";

export const githubBindings = pgTable(
  "cp_github_binding",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.organizationId),
    bindingId: text("binding_id").notNull(),
    providerRepositoryId: text("provider_repository_id").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    runnerId: text("runner_id").notNull(),
    projectTargetId: text("project_target_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    secretVersion: text("secret_version").notNull(),
    allowedActorIds: text("allowed_actor_ids").array().notNull(),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.bindingId] }),
    unique("cp_github_binding_binding_id_key").on(table.bindingId),
    unique("cp_github_binding_provider_repository_id_key").on(
      table.providerRepositoryId,
    ),
    foreignKey({
      columns: [table.organizationId, table.runnerId],
      foreignColumns: [runners.organizationId, runners.runnerId],
    }),
  ],
);

export const githubDeliveries = pgTable(
  "cp_github_delivery",
  {
    organizationId: text("organization_id").notNull(),
    bindingId: text("binding_id").notNull(),
    deliveryId: text("delivery_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    eventName: text("event_name").notNull(),
    normalizedOutcome: jsonb("normalized_outcome").notNull(),
    processingToken: text("processing_token"),
    processingExpiresAt: timestamp("processing_expires_at", {
      withTimezone: true,
    }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.bindingId, table.deliveryId],
    }),
    foreignKey({
      columns: [table.organizationId, table.bindingId],
      foreignColumns: [
        githubBindings.organizationId,
        githubBindings.bindingId,
      ],
    }),
    check(
      "cp_github_delivery_processing_check",
      sql`(
        (${table.normalizedOutcome} = '{"kind":"processing"}'::jsonb
          AND ${table.processingToken} IS NOT NULL
          AND ${table.processingExpiresAt} IS NOT NULL)
        OR
        (${table.normalizedOutcome} <> '{"kind":"processing"}'::jsonb
          AND ${table.processingToken} IS NULL
          AND ${table.processingExpiresAt} IS NULL)
      )`,
    ),
  ],
);

export const providerEvidence = pgTable(
  "cp_provider_evidence",
  {
    evidenceId: text("evidence_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.organizationId),
    runId: text("run_id"),
    provider: text("provider").notNull(),
    evidenceKind: text("evidence_kind").notNull(),
    providerIdentity: text("provider_identity").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    evidence: jsonb("evidence").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique(
      "cp_provider_evidence_organization_id_provider_evidence_kind_provider_identity_key",
    ).on(
      table.organizationId,
      table.provider,
      table.evidenceKind,
      table.providerIdentity,
    ),
  ],
);
