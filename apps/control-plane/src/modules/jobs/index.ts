import { computeControlPayloadDigestV1 } from "@opentag/control-protocol";
import type { Pool } from "pg";
import { withPostgresTransaction } from "../../database/postgres.js";

type Clock = { now(): Date };

type JobRow = {
  job_id: string;
  organization_id: string | null;
  job_kind: string;
  payload: unknown;
  request_digest: string;
  state: "pending" | "claimed" | "succeeded" | "failed";
  available_at: Date;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
};

function claimedJob(row: JobRow) {
  if (!row.lease_token || !row.lease_owner || !row.lease_expires_at) {
    throw new Error("invalid_claimed_job_state");
  }
  return {
    jobId: row.job_id,
    organizationId: row.organization_id,
    kind: row.job_kind,
    payload: row.payload,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
  };
}

export function createDurableJobQueue(input: {
  pool: Pool;
  clock: Clock;
  leaseDurationMs: number;
  tokenFactory(): string;
}) {
  if (input.leaseDurationMs < 1_000) throw new Error("invalid_job_lease_duration");
  return {
    async enqueue(command: {
      jobId: string;
      organizationId: string | null;
      kind: string;
      payload: unknown;
      maxAttempts: number;
      availableAt?: Date;
    }) {
      if (
        !command.jobId
        || !command.kind
        || !Number.isInteger(command.maxAttempts)
        || command.maxAttempts < 1
        || command.maxAttempts > 100
      ) {
        throw new Error("invalid_job_command");
      }
      const requestDigest = await computeControlPayloadDigestV1({
        organizationId: command.organizationId,
        kind: command.kind,
        payload: command.payload,
        maxAttempts: command.maxAttempts,
        availableAt: command.availableAt?.toISOString() ?? null,
      });
      const now = input.clock.now();
      return withPostgresTransaction(input.pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO cp_job(
             job_id, organization_id, job_kind, payload, request_digest,
             state, available_at, attempt_count, max_attempts,
             created_at, updated_at
           ) VALUES($1, $2, $3, $4, $5, 'pending', $6, 0, $7, $8, $8)
           ON CONFLICT (job_id) DO NOTHING
           RETURNING job_id`,
          [
            command.jobId,
            command.organizationId,
            command.kind,
            command.payload,
            requestDigest,
            command.availableAt ?? now,
            command.maxAttempts,
            now,
          ],
        ) as { rows: Array<{ job_id: string }> };
        if (inserted.rows[0]) return { kind: "created" } as const;
        const existing = await client.query(
          "SELECT request_digest FROM cp_job WHERE job_id = $1 FOR UPDATE",
          [command.jobId],
        ) as { rows: Array<{ request_digest: string }> };
        return existing.rows[0]?.request_digest === requestDigest
          ? { kind: "replayed" } as const
          : { kind: "conflict" } as const;
      });
    },

    async claim(workerId: string) {
      if (!workerId || workerId !== workerId.trim()) {
        throw new Error("invalid_worker_id");
      }
      const now = input.clock.now();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
      const leaseToken = input.tokenFactory();
      return withPostgresTransaction(input.pool, async (client) => {
        await client.query(
          `WITH exhausted AS (
             SELECT job_id FROM cp_job
             WHERE state = 'claimed' AND lease_expires_at <= $1
               AND attempt_count >= max_attempts
             FOR UPDATE SKIP LOCKED
           )
           UPDATE cp_job job
           SET state = 'failed', lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, last_error_code = 'lease_expired',
               updated_at = $1
           FROM exhausted WHERE job.job_id = exhausted.job_id`,
          [now],
        );
        const result = await client.query(
          `WITH candidate AS (
             SELECT job_id FROM cp_job
             WHERE attempt_count < max_attempts
               AND (
                 (state = 'pending' AND available_at <= $1)
                 OR (state = 'claimed' AND lease_expires_at <= $1)
               )
             ORDER BY available_at, created_at, job_id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE cp_job job
           SET state = 'claimed', attempt_count = job.attempt_count + 1,
               lease_owner = $2, lease_token = $3, lease_expires_at = $4,
               updated_at = $1
           FROM candidate
           WHERE job.job_id = candidate.job_id
           RETURNING job.*`,
          [now, workerId, leaseToken, leaseExpiresAt],
        ) as { rows: JobRow[] };
        const row = result.rows[0];
        return row
          ? { kind: "claimed", job: claimedJob(row) } as const
          : { kind: "empty" } as const;
      });
    },

    async succeed(command: {
      jobId: string;
      leaseToken: string;
      outcome: unknown;
    }) {
      const now = input.clock.now();
      return withPostgresTransaction(input.pool, async (client) => {
        const settlement = await client.query(
          "SELECT lease_token, outcome FROM cp_job_settlement WHERE job_id = $1",
          [command.jobId],
        ) as { rows: Array<{ lease_token: string; outcome: unknown }> };
        const settled = settlement.rows[0];
        if (settled) {
          const [existingDigest, requestedDigest] = await Promise.all([
            computeControlPayloadDigestV1(settled.outcome),
            computeControlPayloadDigestV1(command.outcome),
          ]);
          return settled.lease_token === command.leaseToken
            && existingDigest === requestedDigest
            ? { kind: "replayed" } as const
            : { kind: "stale_lease" } as const;
        }
        const job = await client.query(
          "SELECT * FROM cp_job WHERE job_id = $1 FOR UPDATE",
          [command.jobId],
        ) as { rows: JobRow[] };
        const row = job.rows[0];
        if (
          !row
          || row.state !== "claimed"
          || row.lease_token !== command.leaseToken
          || !row.lease_expires_at
          || row.lease_expires_at.getTime() <= now.getTime()
        ) {
          return { kind: "stale_lease" } as const;
        }
        await client.query(
          `UPDATE cp_job
           SET state = 'succeeded', lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = $2
           WHERE job_id = $1`,
          [command.jobId, now],
        );
        await client.query(
          `INSERT INTO cp_job_settlement(job_id, lease_token, outcome, settled_at)
           VALUES($1, $2, $3, $4)`,
          [command.jobId, command.leaseToken, command.outcome, now],
        );
        return { kind: "settled" } as const;
      });
    },

    async fail(command: {
      jobId: string;
      leaseToken: string;
      errorCode: string;
      retryAt?: Date;
    }) {
      const now = input.clock.now();
      return withPostgresTransaction(input.pool, async (client) => {
        const job = await client.query(
          "SELECT * FROM cp_job WHERE job_id = $1 FOR UPDATE",
          [command.jobId],
        ) as { rows: JobRow[] };
        const row = job.rows[0];
        if (
          !row
          || row.state !== "claimed"
          || row.lease_token !== command.leaseToken
          || !row.lease_expires_at
          || row.lease_expires_at.getTime() <= now.getTime()
        ) {
          return { kind: "stale_lease" } as const;
        }
        if (command.retryAt && row.attempt_count < row.max_attempts) {
          await client.query(
            `UPDATE cp_job
             SET state = 'pending', available_at = $2, lease_owner = NULL,
                 lease_token = NULL, lease_expires_at = NULL,
                 last_error_code = $3, updated_at = $4
             WHERE job_id = $1`,
            [command.jobId, command.retryAt, command.errorCode, now],
          );
          return { kind: "retry_scheduled" } as const;
        }
        await client.query(
          `UPDATE cp_job
           SET state = 'failed', lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, last_error_code = $2, updated_at = $3
           WHERE job_id = $1`,
          [command.jobId, command.errorCode, now],
        );
        await client.query(
          `INSERT INTO cp_job_settlement(job_id, lease_token, outcome, settled_at)
           VALUES($1, $2, $3, $4)`,
          [
            command.jobId,
            command.leaseToken,
            { errorCode: command.errorCode },
            now,
          ],
        );
        return { kind: "failed" } as const;
      });
    },
  };
}

export type DurableJobQueue = ReturnType<typeof createDurableJobQueue>;

const MAINTENANCE_WINDOW_MS = 60_000;

export async function scheduleControlPlaneMaintenance(input: {
  queue: Pick<DurableJobQueue, "enqueue">;
  clock: Clock;
}): Promise<void> {
  const windowStart = new Date(
    Math.floor(input.clock.now().getTime() / MAINTENANCE_WINDOW_MS)
      * MAINTENANCE_WINDOW_MS,
  ).toISOString();
  const commands = [
    {
      jobId: `hosted-attempt-reconciliation:${windowStart}`,
      organizationId: null,
      kind: "hosted-attempt-reconciliation",
      payload: { windowStart },
      maxAttempts: 5,
    },
    {
      jobId: `runner-readiness-retention:${windowStart}`,
      organizationId: null,
      kind: "runner-readiness-retention",
      payload: { windowStart },
      maxAttempts: 5,
    },
  ] as const;
  const outcomes = await Promise.all(
    commands.map((command) => input.queue.enqueue(command)),
  );
  if (outcomes.some((outcome) => outcome.kind === "conflict")) {
    throw new Error("maintenance_job_schedule_conflict");
  }
}
