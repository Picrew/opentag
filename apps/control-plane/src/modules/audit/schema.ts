import { bigint, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "../identity/schema.js";

export const managementAuditEvents = pgTable(
  "cp_management_audit_event",
  {
    sequenceId: bigint("sequence_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.organizationId),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    outcome: text("outcome").notNull(),
    event: jsonb("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("cp_management_audit_tenant_idx").on(
      table.organizationId,
      table.sequenceId,
    ),
  ],
);
