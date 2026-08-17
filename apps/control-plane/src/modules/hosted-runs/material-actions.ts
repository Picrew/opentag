import {
  computeMaterialActionFencingTokenDigestV1,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  MaterialActionReceiptEnvelopeV1Schema,
  RunnerMaterialActionReconcileRequestV1Schema,
  type MaterialActionReceiptEnvelopeV1,
  type RunnerMaterialActionReconcileRequestV1,
} from "@opentag/control-protocol";
import type { Pool } from "pg";
import { withPostgresTransaction } from "../../database/postgres.js";
import type { RuntimePrincipal } from "../runners/index.js";

type Clock = { now(): Date };
type CurrentReceipt = {
  receipt_id: string;
  receipt_digest: string;
  outcome: "succeeded" | "failed" | "outcome_unknown";
  receipt: unknown;
};

export type MaterialActionCoordinator = {
  record(input: {
    principal: RuntimePrincipal;
    fencingToken: string;
    receipt: MaterialActionReceiptEnvelopeV1;
  }): Promise<
    | { kind: "recorded" | "replayed"; receipt: MaterialActionReceiptEnvelopeV1 }
    | { kind: "stale_fence" | "conflict" }
  >;
  reconcile(input: {
    principal: RuntimePrincipal;
    request: RunnerMaterialActionReconcileRequestV1;
  }): Promise<
    | {
        kind: "resolved" | "outcome_unknown";
        receipt: MaterialActionReceiptEnvelopeV1;
      }
    | { kind: "stale_fence" | "conflict" | "missing" }
  >;
};

async function currentAttemptMatches(
  client: { query(text: string, values?: readonly unknown[]): Promise<unknown> },
  input: {
    principal: RuntimePrincipal;
    runId: string;
    attemptId: string;
    attemptNumber: number;
    fencingTokenDigest: string;
    now: Date;
  },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM cp_hosted_run run
     JOIN cp_hosted_attempt attempt
       ON attempt.organization_id = run.organization_id
      AND attempt.run_id = run.run_id
      AND attempt.attempt_number = run.current_attempt_number
     WHERE run.organization_id = $1 AND run.run_id = $2
       AND run.runner_id = $3 AND run.terminal_kind IS NULL
       AND attempt.attempt_id = $4 AND attempt.attempt_number = $5
       AND attempt.fencing_token_digest = $6
       AND attempt.credential_id = $7
       AND attempt.lease_expires_at > $8
     FOR UPDATE OF run, attempt`,
    [
      input.principal.organizationId,
      input.runId,
      input.principal.runnerId,
      input.attemptId,
      input.attemptNumber,
      input.fencingTokenDigest,
      input.principal.credentialId,
      input.now,
    ],
  ) as { rows: unknown[] };
  return result.rows.length === 1;
}

function exactPredecessor(
  receipt: MaterialActionReceiptEnvelopeV1,
  current: CurrentReceipt | undefined,
): boolean {
  const predecessors = receipt.predecessorReceiptDigests ?? [];
  return current
    ? predecessors.length === 1 && predecessors[0] === current.receipt_digest
    : predecessors.length === 0;
}

export function createMaterialActionCoordinator(input: {
  pool: Pool;
  clock: Clock;
}): MaterialActionCoordinator {
  return {
    async record(command) {
      const receipt = MaterialActionReceiptEnvelopeV1Schema.parse(
        command.receipt,
      );
      const expectedFenceDigest = await computeMaterialActionFencingTokenDigestV1(
        command.fencingToken,
      );
      const expectedPayloadDigest = await computeMaterialActionPayloadDigestV1(
        receipt.payload,
      );
      const { receiptDigest: _ignored, ...receiptDigestInput } = receipt;
      const expectedReceiptDigest = await computeMaterialActionReceiptDigestV1(
        receiptDigestInput,
      );
      if (
        receipt.organizationId !== command.principal.organizationId
        || receipt.producer.id !== command.principal.runnerId
        || receipt.attempt.fencingTokenDigest !== expectedFenceDigest
        || receipt.payloadDigest !== expectedPayloadDigest
        || receipt.receiptDigest !== expectedReceiptDigest
      ) return { kind: "conflict" };

      return withPostgresTransaction(input.pool, async (client) => {
        const operation = await client.query(
          `SELECT receipt_digest, receipt
           FROM cp_material_action_receipt
           WHERE organization_id = $1 AND operation_id = $2`,
          [command.principal.organizationId, receipt.operationId],
        ) as { rows: Array<{ receipt_digest: string; receipt: unknown }> };
        const replay = operation.rows[0];
        if (replay) {
          return replay.receipt_digest === receipt.receiptDigest
            ? {
                kind: "replayed" as const,
                receipt: MaterialActionReceiptEnvelopeV1Schema.parse(
                  replay.receipt,
                ),
              }
            : { kind: "conflict" as const };
        }
        if (!(await currentAttemptMatches(client, {
          principal: command.principal,
          runId: receipt.runId,
          attemptId: receipt.attempt.attemptId,
          attemptNumber: receipt.attempt.attemptNumber,
          fencingTokenDigest: receipt.attempt.fencingTokenDigest,
          now: input.clock.now(),
        }))) return { kind: "stale_fence" as const };

        const currentResult = await client.query(
          `SELECT receipt_id, receipt_digest, outcome, receipt
           FROM cp_material_action_current
           WHERE organization_id = $1 AND run_id = $2
             AND attempt_id = $3 AND action_id = $4
           FOR UPDATE`,
          [
            command.principal.organizationId,
            receipt.runId,
            receipt.attempt.attemptId,
            receipt.payload.actionId,
          ],
        ) as { rows: CurrentReceipt[] };
        const current = currentResult.rows[0];
        if (
          (current && current.outcome !== "outcome_unknown")
          || !exactPredecessor(receipt, current)
        ) return { kind: "conflict" as const };

        const createdAt = input.clock.now();
        await client.query(
          `INSERT INTO cp_material_action_receipt(
             organization_id, receipt_id, operation_id, run_id, runner_id,
             attempt_id, attempt_number, action_id, receipt_digest, outcome,
             receipt, created_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
          [
            command.principal.organizationId,
            receipt.receiptId,
            receipt.operationId,
            receipt.runId,
            command.principal.runnerId,
            receipt.attempt.attemptId,
            receipt.attempt.attemptNumber,
            receipt.payload.actionId,
            receipt.receiptDigest,
            receipt.payload.outcome,
            JSON.stringify(receipt),
            createdAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_material_action_current(
             organization_id, run_id, attempt_id, attempt_number, action_id,
             receipt_id, receipt_digest, outcome, receipt, updated_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (organization_id, run_id, attempt_id, action_id)
           DO UPDATE SET receipt_id = EXCLUDED.receipt_id,
             receipt_digest = EXCLUDED.receipt_digest,
             outcome = EXCLUDED.outcome, receipt = EXCLUDED.receipt,
             updated_at = EXCLUDED.updated_at`,
          [
            command.principal.organizationId,
            receipt.runId,
            receipt.attempt.attemptId,
            receipt.attempt.attemptNumber,
            receipt.payload.actionId,
            receipt.receiptId,
            receipt.receiptDigest,
            receipt.payload.outcome,
            JSON.stringify(receipt),
            createdAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_hosted_audit_event(
             organization_id, run_id, event_kind, event, created_at
           ) VALUES($1, $2, 'material_action_observed', $3::jsonb, $4)`,
          [
            command.principal.organizationId,
            receipt.runId,
            JSON.stringify({
              actionId: receipt.payload.actionId,
              outcome: receipt.payload.outcome,
              receiptDigest: receipt.receiptDigest,
              receiptId: receipt.receiptId,
            }),
            createdAt,
          ],
        );
        return { kind: "recorded", receipt } as const;
      });
    },

    async reconcile(command) {
      const request = RunnerMaterialActionReconcileRequestV1Schema.parse(
        command.request,
      );
      if (
        request.organizationId !== command.principal.organizationId
        || request.runnerId !== command.principal.runnerId
        || request.attempt.fencingTokenDigest
          !== await computeMaterialActionFencingTokenDigestV1(
            request.attempt.fencingToken,
          )
      ) return { kind: "conflict" };
      return withPostgresTransaction(input.pool, async (client) => {
        if (!(await currentAttemptMatches(client, {
          principal: command.principal,
          runId: request.runId,
          attemptId: request.attempt.attemptId,
          attemptNumber: request.attempt.attemptNumber,
          fencingTokenDigest: request.attempt.fencingTokenDigest,
          now: input.clock.now(),
        }))) return { kind: "stale_fence" as const };
        const result = await client.query(
          `SELECT receipt_id, receipt_digest, outcome, receipt
           FROM cp_material_action_current
           WHERE organization_id = $1 AND run_id = $2
             AND attempt_id = $3 AND action_id = $4`,
          [
            command.principal.organizationId,
            request.runId,
            request.attempt.attemptId,
            request.actionId,
          ],
        ) as { rows: CurrentReceipt[] };
        const current = result.rows[0];
        if (!current) return { kind: "missing" as const };
        if (
          request.expectedCurrentReceiptId !== undefined
          && (
            request.expectedCurrentReceiptId !== current.receipt_id
            || request.expectedCurrentReceiptDigest !== current.receipt_digest
          )
        ) return { kind: "conflict" as const };
        return {
          kind: current.outcome === "outcome_unknown"
            ? "outcome_unknown" as const
            : "resolved" as const,
          receipt: MaterialActionReceiptEnvelopeV1Schema.parse(current.receipt),
        };
      });
    },
  };
}
