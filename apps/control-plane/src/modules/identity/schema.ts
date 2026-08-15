import {
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const organizations = pgTable("cp_organization", {
  organizationId: text("organization_id").primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const operators = pgTable(
  "cp_operator",
  {
    operatorId: text("operator_id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [unique("cp_operator_email_key").on(table.email)],
);

export const memberships = pgTable(
  "cp_membership",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.organizationId),
    operatorId: text("operator_id")
      .notNull()
      .references(() => operators.operatorId),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.operatorId] }),
    check(
      "cp_membership_role_check",
      sql`${table.role} IN ('owner', 'admin', 'operator', 'viewer')`,
    ),
  ],
);

export const sessions = pgTable(
  "cp_session",
  {
    sessionId: text("session_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    operatorId: text("operator_id")
      .notNull()
      .references(() => operators.operatorId),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.operatorId],
      foreignColumns: [memberships.organizationId, memberships.operatorId],
      name: "cp_session_membership_fk",
    }),
    unique("cp_session_token_hash_key").on(table.tokenHash),
  ],
);

export const apiKeys = pgTable(
  "cp_api_key",
  {
    apiKeyId: text("api_key_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.organizationId),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    scope: text("scope").array().notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => operators.operatorId),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [unique("cp_api_key_token_hash_key").on(table.tokenHash)],
);
