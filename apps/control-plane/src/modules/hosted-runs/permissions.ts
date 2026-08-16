import {
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computePermissionFencingTokenDigestV1,
  computePermissionRequestDigestV1,
  HumanPermissionDecisionRequestV1Schema,
  PermissionRequestDigestInputV1Schema,
  PermissionResolutionReceiptEnvelopeV1Schema,
  ReceiptDigestSchema,
  RunnerPermissionCurrentQueryV1Schema,
  RunnerPermissionRequestV1Schema,
  type HumanPermissionDecisionRequestV1,
  type PermissionResolutionReceiptEnvelopeV1,
  type RunnerPermissionCurrentQueryV1,
  type RunnerPermissionRequestV1,
} from "@opentag/control-protocol";
import type { Pool } from "pg";
import { withPostgresTransaction } from "../../database/postgres.js";
import type { RuntimePrincipal } from "../runners/index.js";

type Clock = { now(): Date };
type PermissionIdKind = "permission_receipt" | "permission_resolution";
type ApproverPrincipal = {
  organizationId: string;
  actorId: string;
};
type PermissionState = "waiting" | "authorized" | "denied";

type StoredPermission = {
  runner_id: string;
  run_id: string;
  attempt_id: string;
  attempt_number: number;
  action_id: string;
  resolution_id: string;
  permission_request_digest: string;
  policy_snapshot_digest: string;
  state: PermissionState;
  request: unknown;
  current_receipt: unknown;
};

const StoredPermissionRequestV1Schema = PermissionRequestDigestInputV1Schema.extend({
  permissionRequestDigest: ReceiptDigestSchema,
});
type StoredPermissionRequestV1 = ReturnType<
  typeof StoredPermissionRequestV1Schema.parse
>;

export type PermissionCoordinator = {
  request(input: {
    principal: RuntimePrincipal;
    request: RunnerPermissionRequestV1;
  }): Promise<
    | { kind: "waiting" | "replayed"; receipt: PermissionResolutionReceiptEnvelopeV1 }
    | { kind: "stale_fence" }
    | { kind: "conflict" }
  >;
  resolve(input: {
    principal: ApproverPrincipal;
    runnerId: string;
    decision: HumanPermissionDecisionRequestV1;
  }): Promise<
    | { kind: "resolved" | "replayed"; receipt: PermissionResolutionReceiptEnvelopeV1 }
    | { kind: "stale_fence" }
    | { kind: "conflict" }
  >;
  current(input: {
    principal: RuntimePrincipal;
    query: RunnerPermissionCurrentQueryV1;
  }): Promise<
    | { kind: "waiting" | "resolved"; receipt: PermissionResolutionReceiptEnvelopeV1 }
    | { kind: "stale_fence" }
    | { kind: "missing" }
  >;
};

function permissionDigestInput(request: RunnerPermissionRequestV1) {
  return {
    schemaVersion: request.schemaVersion,
    protocolVersion: request.protocolVersion,
    requiredCapabilities: request.requiredCapabilities,
    organizationId: request.organizationId,
    runnerId: request.runnerId,
    runId: request.runId,
    attempt: {
      attemptId: request.attempt.attemptId,
      attemptNumber: request.attempt.attemptNumber,
      epoch: request.attempt.epoch,
      fencingTokenDigest: request.attempt.fencingTokenDigest,
    },
    permissionRequestId: request.permissionRequestId,
    actionId: request.actionId,
    actionFamily: request.actionFamily,
    riskTier: request.riskTier,
    targetFingerprint: request.targetFingerprint,
    permissionScopes: request.permissionScopes,
    policySnapshotRef: request.policySnapshotRef,
    policySnapshotDigest: request.policySnapshotDigest,
    requestedAt: request.requestedAt,
  };
}

function permissionRequestForStorage(
  request: RunnerPermissionRequestV1,
): StoredPermissionRequestV1 {
  return StoredPermissionRequestV1Schema.parse({
    ...permissionDigestInput(request),
    permissionRequestDigest: request.permissionRequestDigest,
  });
}

async function buildReceipt(input: {
  idFactory(kind: PermissionIdKind): string;
  operationId: string;
  organizationId: string;
  runId: string;
  attempt: RunnerPermissionCurrentQueryV1["attempt"];
  request: StoredPermissionRequestV1;
  resolutionId: string;
  observedAt: string;
  state: PermissionState;
  decision?: {
    decision: "allow_once" | "deny";
    decisionId: string;
    actorId: string;
    decidedAt: string;
  };
}): Promise<PermissionResolutionReceiptEnvelopeV1> {
  const payload = {
    resolutionId: input.resolutionId,
    permissionRequestId: input.request.permissionRequestId,
    permissionRequestDigest: input.request.permissionRequestDigest,
    actionId: input.request.actionId,
    actionFamily: input.request.actionFamily,
    riskTier: input.request.riskTier,
    targetFingerprint: input.request.targetFingerprint,
    permissionScopes: input.request.permissionScopes,
    policySnapshotRef: input.request.policySnapshotRef,
    policySnapshotDigest: input.request.policySnapshotDigest,
    state: input.state,
    ...(input.decision
      ? {
          decision: input.decision.decision,
          decisionRef: input.decision.decisionId,
          decisionActorRef: input.decision.actorId,
          reasonCode: input.decision.decision === "allow_once"
            ? "human_approved" as const
            : "human_denied" as const,
          decidedAt: input.decision.decidedAt,
        }
      : {
          reasonCode: "human_approval_required" as const,
          nextAction: "wait_for_operator" as const,
        }),
    requestedAt: input.request.requestedAt,
    observedAt: input.observedAt,
  };
  const receiptSeed = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptId: input.idFactory("permission_receipt"),
    organizationId: input.organizationId,
    operationId: input.operationId,
    requiredCapabilities: ["relay.permission.v1"] as const,
    producer: { kind: "cloud" as const, id: "control_plane" },
    identity: {
      namespace: "opentag.control.receipt/permission-resolution/v1" as const,
      parts: [
        input.organizationId,
        input.runId,
        input.attempt.attemptId,
        input.request.actionId,
        input.resolutionId,
      ],
    },
    observedAt: input.observedAt,
    payloadDigest: await computeControlPayloadDigestV1(payload),
    receiptDigest: `sha256:${"0".repeat(64)}`,
    receiptKind: "permission_resolution" as const,
    runId: input.runId,
    attempt: input.attempt,
    payload,
  };
  const { receiptDigest: _ignored, ...receiptDigestInput } = receiptSeed;
  return PermissionResolutionReceiptEnvelopeV1Schema.parse({
    ...receiptSeed,
    receiptDigest: await computeControlReceiptDigestV1(receiptDigestInput),
  });
}

async function currentAttemptMatches(
  client: { query(text: string, values?: readonly unknown[]): Promise<unknown> },
  input: {
    organizationId: string;
    runnerId: string;
    credentialId?: string;
    runId: string;
    attemptId: string;
    attemptNumber: number;
    fencingTokenDigest: string;
    policySnapshotRef?: string;
    policySnapshotDigest?: string;
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
       AND ($7::text IS NULL OR attempt.credential_id = $7)
       AND attempt.lease_expires_at > $8
       AND ($9::text IS NULL
         OR run.admission_policy_snapshot ->> 'receiptDigest' = $9)
       AND ($10::text IS NULL
         OR run.admission_policy_snapshot -> 'payload' ->> 'snapshotId' = $10)
     FOR UPDATE OF run, attempt`,
    [
      input.organizationId,
      input.runId,
      input.runnerId,
      input.attemptId,
      input.attemptNumber,
      input.fencingTokenDigest,
      input.credentialId ?? null,
      input.now,
      input.policySnapshotDigest ?? null,
      input.policySnapshotRef ?? null,
    ],
  ) as { rows: unknown[] };
  return result.rows.length === 1;
}

export function createPermissionCoordinator(input: {
  pool: Pool;
  clock: Clock;
  idFactory(kind: PermissionIdKind): string;
}): PermissionCoordinator {
  return {
    async request(command) {
      const request = RunnerPermissionRequestV1Schema.parse(command.request);
      if (
        request.organizationId !== command.principal.organizationId
        || request.runnerId !== command.principal.runnerId
        || request.attempt.fencingTokenDigest
          !== await computePermissionFencingTokenDigestV1(
            request.attempt.fencingToken,
          )
        || request.permissionRequestDigest
          !== await computePermissionRequestDigestV1(
            permissionDigestInput(request),
          )
      ) {
        return { kind: "conflict" };
      }
      const operationDigest = await computeControlPayloadDigestV1(request);
      return withPostgresTransaction(input.pool, async (client) => {
        const operation = await client.query(
          `SELECT request_digest, operation_kind, receipt
           FROM cp_permission_operation
           WHERE organization_id = $1 AND operation_id = $2`,
          [command.principal.organizationId, request.operationId],
        ) as {
          rows: Array<{
            request_digest: string;
            operation_kind: string;
            receipt: unknown;
          }>;
        };
        const replay = operation.rows[0];
        if (replay) {
          if (
            replay.request_digest !== operationDigest
            || replay.operation_kind !== "request"
          ) return { kind: "conflict" } as const;
          return {
            kind: "replayed",
            receipt: PermissionResolutionReceiptEnvelopeV1Schema.parse(
              replay.receipt,
            ),
          } as const;
        }
        if (!(await currentAttemptMatches(client, {
          organizationId: command.principal.organizationId,
          runnerId: command.principal.runnerId,
          credentialId: command.principal.credentialId,
          runId: request.runId,
          attemptId: request.attempt.attemptId,
          attemptNumber: request.attempt.attemptNumber,
          fencingTokenDigest: request.attempt.fencingTokenDigest,
          policySnapshotRef: request.policySnapshotRef,
          policySnapshotDigest: request.policySnapshotDigest,
          now: input.clock.now(),
        }))) {
          return { kind: "stale_fence" } as const;
        }
        const existing = await client.query(
          `SELECT permission_request_digest
           FROM cp_permission_request
           WHERE organization_id = $1 AND (
             permission_request_id = $2
             OR (run_id = $3 AND attempt_id = $4 AND action_id = $5)
           ) FOR UPDATE`,
          [
            command.principal.organizationId,
            request.permissionRequestId,
            request.runId,
            request.attempt.attemptId,
            request.actionId,
          ],
        ) as { rows: Array<{ permission_request_digest: string }> };
        if (existing.rows.length > 0) return { kind: "conflict" } as const;
        const observedAt = input.clock.now().toISOString();
        const resolutionId = input.idFactory("permission_resolution");
        const receipt = await buildReceipt({
          idFactory: input.idFactory,
          operationId: request.operationId,
          organizationId: command.principal.organizationId,
          runId: request.runId,
          attempt: {
            attemptId: request.attempt.attemptId,
            attemptNumber: request.attempt.attemptNumber,
            epoch: request.attempt.epoch,
            fencingTokenDigest: request.attempt.fencingTokenDigest,
          },
          request: permissionRequestForStorage(request),
          resolutionId,
          observedAt,
          state: "waiting",
        });
        await client.query(
          `INSERT INTO cp_permission_request(
             organization_id, permission_request_id, run_id, runner_id,
             attempt_id, attempt_number, action_id, resolution_id,
             permission_request_digest, policy_snapshot_digest, state,
             request, current_receipt, created_at, updated_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    'waiting', $11::jsonb, $12::jsonb, $13, $13)`,
          [
            command.principal.organizationId,
            request.permissionRequestId,
            request.runId,
            request.runnerId,
            request.attempt.attemptId,
            request.attempt.attemptNumber,
            request.actionId,
            resolutionId,
            request.permissionRequestDigest,
            request.policySnapshotDigest,
            JSON.stringify(permissionRequestForStorage(request)),
            JSON.stringify(receipt),
            observedAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_permission_operation(
             organization_id, operation_id, request_digest,
             permission_request_id, operation_kind, receipt, created_at
           ) VALUES($1, $2, $3, $4, 'request', $5::jsonb, $6)`,
          [
            command.principal.organizationId,
            request.operationId,
            operationDigest,
            request.permissionRequestId,
            JSON.stringify(receipt),
            observedAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_hosted_audit_event(
             organization_id, run_id, event_kind, event, created_at
           ) VALUES($1, $2, 'permission_waiting', $3::jsonb, $4)`,
          [
            command.principal.organizationId,
            request.runId,
            JSON.stringify({
              permissionRequestId: request.permissionRequestId,
              actionId: request.actionId,
              receiptDigest: receipt.receiptDigest,
            }),
            observedAt,
          ],
        );
        return { kind: "waiting", receipt } as const;
      });
    },

    async resolve(command) {
      const decision = HumanPermissionDecisionRequestV1Schema.parse(
        command.decision,
      );
      if (decision.organizationId !== command.principal.organizationId) {
        return { kind: "conflict" };
      }
      const operationDigest = await computeControlPayloadDigestV1(decision);
      return withPostgresTransaction(input.pool, async (client) => {
        const operation = await client.query(
          `SELECT request_digest, operation_kind, receipt
           FROM cp_permission_operation
           WHERE organization_id = $1 AND operation_id = $2`,
          [command.principal.organizationId, decision.operationId],
        ) as {
          rows: Array<{
            request_digest: string;
            operation_kind: string;
            receipt: unknown;
          }>;
        };
        const replay = operation.rows[0];
        if (replay) {
          if (
            replay.request_digest !== operationDigest
            || replay.operation_kind !== "decision"
          ) return { kind: "conflict" } as const;
          return {
            kind: "replayed",
            receipt: PermissionResolutionReceiptEnvelopeV1Schema.parse(
              replay.receipt,
            ),
          } as const;
        }
        const result = await client.query(
          `SELECT runner_id, run_id, attempt_id, attempt_number, action_id,
                  resolution_id, permission_request_digest,
                  policy_snapshot_digest, state, request, current_receipt
           FROM cp_permission_request
           WHERE organization_id = $1 AND permission_request_id = $2
           FOR UPDATE`,
          [command.principal.organizationId, decision.permissionRequestId],
        ) as { rows: StoredPermission[] };
        const stored = result.rows[0];
        if (
          !stored
          || stored.state !== "waiting"
          || stored.runner_id !== command.runnerId
          || stored.run_id !== decision.runId
          || stored.attempt_id !== decision.attempt.attemptId
          || stored.attempt_number !== decision.attempt.attemptNumber
          || stored.action_id !== decision.actionId
          || stored.permission_request_digest
            !== decision.permissionRequestDigest
          || stored.policy_snapshot_digest !== decision.policySnapshotDigest
        ) return { kind: "conflict" } as const;
        if (!(await currentAttemptMatches(client, {
          organizationId: command.principal.organizationId,
          runnerId: command.runnerId,
          runId: decision.runId,
          attemptId: decision.attempt.attemptId,
          attemptNumber: decision.attempt.attemptNumber,
          fencingTokenDigest: decision.attempt.fencingTokenDigest,
          now: input.clock.now(),
        }))) return { kind: "stale_fence" } as const;
        const request = StoredPermissionRequestV1Schema.parse(stored.request);
        const state = decision.decision === "allow_once"
          ? "authorized" as const
          : "denied" as const;
        const observedAt = input.clock.now().toISOString();
        const receipt = await buildReceipt({
          idFactory: input.idFactory,
          operationId: decision.operationId,
          organizationId: command.principal.organizationId,
          runId: decision.runId,
          attempt: decision.attempt,
          request,
          resolutionId: stored.resolution_id,
          observedAt,
          state,
          decision: {
            decision: decision.decision,
            decisionId: decision.decisionId,
            actorId: command.principal.actorId,
            decidedAt: decision.decidedAt,
          },
        });
        await client.query(
          `UPDATE cp_permission_request
           SET state = $3, current_receipt = $4::jsonb, updated_at = $5
           WHERE organization_id = $1 AND permission_request_id = $2`,
          [
            command.principal.organizationId,
            decision.permissionRequestId,
            state,
            JSON.stringify(receipt),
            observedAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_permission_operation(
             organization_id, operation_id, request_digest,
             permission_request_id, operation_kind, receipt, created_at
           ) VALUES($1, $2, $3, $4, 'decision', $5::jsonb, $6)`,
          [
            command.principal.organizationId,
            decision.operationId,
            operationDigest,
            decision.permissionRequestId,
            JSON.stringify(receipt),
            observedAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_hosted_audit_event(
             organization_id, run_id, event_kind, event, created_at
           ) VALUES($1, $2, 'permission_resolved', $3::jsonb, $4)`,
          [
            command.principal.organizationId,
            decision.runId,
            JSON.stringify({
              permissionRequestId: decision.permissionRequestId,
              actionId: decision.actionId,
              decision: decision.decision,
              decisionRef: decision.decisionId,
              decisionActorRef: command.principal.actorId,
              receiptDigest: receipt.receiptDigest,
            }),
            observedAt,
          ],
        );
        return { kind: "resolved", receipt } as const;
      });
    },

    async current(command) {
      const query = RunnerPermissionCurrentQueryV1Schema.parse(command.query);
      if (
        query.organizationId !== command.principal.organizationId
        || query.runnerId !== command.principal.runnerId
      ) return { kind: "missing" };
      return withPostgresTransaction(input.pool, async (client) => {
        if (!(await currentAttemptMatches(client, {
          organizationId: command.principal.organizationId,
          runnerId: command.principal.runnerId,
          credentialId: command.principal.credentialId,
          runId: query.runId,
          attemptId: query.attempt.attemptId,
          attemptNumber: query.attempt.attemptNumber,
          fencingTokenDigest: query.attempt.fencingTokenDigest,
          now: input.clock.now(),
        }))) return { kind: "stale_fence" } as const;
        const result = await client.query(
          `SELECT runner_id, run_id, attempt_id, attempt_number, action_id,
                  resolution_id, permission_request_digest,
                  policy_snapshot_digest, state, request, current_receipt
           FROM cp_permission_request
           WHERE organization_id = $1 AND permission_request_id = $2`,
          [command.principal.organizationId, query.permissionRequestId],
        ) as { rows: StoredPermission[] };
        const stored = result.rows[0];
        if (
          !stored
          || stored.runner_id !== query.runnerId
          || stored.run_id !== query.runId
          || stored.attempt_id !== query.attempt.attemptId
          || stored.attempt_number !== query.attempt.attemptNumber
          || stored.action_id !== query.actionId
          || stored.permission_request_digest !== query.permissionRequestDigest
        ) return { kind: "missing" } as const;
        return {
          kind: stored.state === "waiting" ? "waiting" : "resolved",
          receipt: PermissionResolutionReceiptEnvelopeV1Schema.parse(
            stored.current_receipt,
          ),
        } as const;
      });
    },
  };
}
