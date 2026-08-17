import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organizations } from "../identity/schema.js";

export const jobs = pgTable(
  "cp_job",
  {
    jobId: text("job_id").primaryKey(),
    organizationId: text("organization_id").references(
      () => organizations.organizationId,
    ),
    jobKind: text("job_kind").notNull(),
    payload: jsonb("payload").notNull(),
    requestDigest: text("request_digest").notNull(),
    state: text("state").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "cp_job_state_check",
      sql`${table.state} IN ('pending', 'claimed', 'succeeded', 'failed')`,
    ),
    check(
      "cp_job_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check("cp_job_max_attempts_check", sql`${table.maxAttempts} > 0`),
    check(
      "cp_job_lease_check",
      sql`(
        (${table.state} = 'claimed'
          AND ${table.leaseOwner} IS NOT NULL
          AND ${table.leaseToken} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.state} <> 'claimed')
      )`,
    ),
    index("cp_job_claim_idx").on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
  ],
);

export const jobSettlements = pgTable("cp_job_settlement", {
  jobId: text("job_id")
    .primaryKey()
    .references(() => jobs.jobId),
  leaseToken: text("lease_token").notNull(),
  outcome: jsonb("outcome").notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
});
