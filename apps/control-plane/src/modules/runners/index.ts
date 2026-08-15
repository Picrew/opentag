import { createHash } from "node:crypto";
import {
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  FreshRunnerCredentialResponseV1Schema,
  ReplayedRunnerCredentialResponseV1Schema,
  RunnerCredentialReprovisionRequestV1Schema,
  RunnerControlContextResponseV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  RunnerRegistrationRequestV1Schema,
  type RunnerReadinessReceiptEnvelopeV1,
  type RunnerCredentialReprovisionRequestV1,
  type RunnerRegistrationRequestV1,
} from "@opentag/control-protocol";
import type { Pool } from "pg";
import { z } from "zod";
import { withPostgresTransaction } from "../../database/postgres.js";
import { recordManagementAudit } from "../audit/index.js";

type Clock = { now(): Date };
type IdFactory = (kind: "credential") => string;
type TokenFactory = () => string;

const ProjectTargetDeclarationSchema = z.object({
  projectTargetId: z.string().min(1).max(200).refine((value) => value === value.trim()),
  bindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  provider: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/u),
  owner: z.string().min(1).max(200).refine((value) => value === value.trim()),
  repo: z.string().min(1).max(200).refine((value) => value === value.trim()),
  defaultExecutor: z.string().min(1).max(120).refine((value) => value === value.trim()),
  defaultBranch: z.string().min(1).max(255).refine((value) => value === value.trim()).nullable(),
  version: z.number().int().positive(),
}).strict();

type ProjectTargetDeclaration = z.infer<typeof ProjectTargetDeclarationSchema>;

const UPSERT_PROJECT_TARGET_SQL = `
  INSERT INTO cp_project_target(
    organization_id, project_target_id, runner_id, binding_digest,
    provider, owner, repo, default_executor, default_branch, version,
    updated_at
  ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (organization_id, project_target_id) DO UPDATE SET
    runner_id = EXCLUDED.runner_id,
    binding_digest = EXCLUDED.binding_digest,
    provider = EXCLUDED.provider,
    owner = EXCLUDED.owner,
    repo = EXCLUDED.repo,
    default_executor = EXCLUDED.default_executor,
    default_branch = EXCLUDED.default_branch,
    version = EXCLUDED.version,
    updated_at = EXCLUDED.updated_at
`;

function projectTargetValues(input: {
  organizationId: string;
  runnerId: string;
  target: ProjectTargetDeclaration;
  updatedAt: string;
}) {
  return [
    input.organizationId,
    input.target.projectTargetId,
    input.runnerId,
    input.target.bindingDigest,
    input.target.provider,
    input.target.owner,
    input.target.repo,
    input.target.defaultExecutor,
    input.target.defaultBranch,
    input.target.version,
    input.updatedAt,
  ];
}

export type RuntimePrincipal = {
  organizationId: string;
  runnerId: string;
  credentialId: string;
  registrationGeneration: number;
  credentialGeneration: number;
};

type FreshResponse = ReturnType<typeof FreshRunnerCredentialResponseV1Schema.parse>;
type ReplayedResponse = ReturnType<
  typeof ReplayedRunnerCredentialResponseV1Schema.parse
>;

export type RunnerRegistrationOutcome =
  | { kind: "created"; response: FreshResponse }
  | { kind: "replayed"; response: ReplayedResponse }
  | { kind: "conflict"; reason: "operation_mismatch" | "runner_already_registered" };

export type RunnerReprovisionOutcome =
  | { kind: "created"; response: FreshResponse }
  | { kind: "replayed"; response: ReplayedResponse }
  | { kind: "conflict"; reason: "operation_mismatch" | "stale_recovery" };

export type RunnerDirectory = {
  register(input: {
    organizationId: string;
    organizationName: string;
    request: RunnerRegistrationRequestV1;
  }): Promise<RunnerRegistrationOutcome>;
  reprovision(input: {
    organizationId: string;
    request: RunnerCredentialReprovisionRequestV1;
  }): Promise<RunnerReprovisionOutcome>;
  authenticate(
    token: string,
  ): Promise<
    | { kind: "authenticated"; principal: RuntimePrincipal }
    | { kind: "invalid_credential" }
  >;
  upsertProjectTarget(input: {
    principal: RuntimePrincipal;
    target: {
      projectTargetId: string;
      bindingDigest: string;
      provider: string;
      owner: string;
      repo: string;
      defaultExecutor: string;
      defaultBranch: string | null;
      version: number;
    };
  }): Promise<void>;
  declareProjectTarget(input: {
    organizationId: string;
    runnerId: string;
    actor?: { kind: "operator" | "runner" | "system"; id: string };
    target: ProjectTargetDeclaration;
  }): Promise<{ kind: "created" | "updated" }>;
  recordReadiness(input: {
    principal: RuntimePrincipal;
    receipt: RunnerReadinessReceiptEnvelopeV1;
  }): Promise<
    | { kind: "recorded" | "replayed"; receipt: RunnerReadinessReceiptEnvelopeV1 }
    | { kind: "conflict"; reason: "authority_mismatch" | "receipt_mismatch" }
  >;
  getControlContext(
    principal: RuntimePrincipal,
  ): Promise<ReturnType<typeof RunnerControlContextResponseV1Schema.parse>>;
  pruneExpiredReadiness(
    organizationId: string | null,
  ): Promise<{ deleted: number }>;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createRunnerDirectory(input: {
  pool: Pool;
  clock: Clock;
  idFactory: IdFactory;
  tokenFactory: TokenFactory;
}): RunnerDirectory {
  return {
    async register(command) {
      const request = RunnerRegistrationRequestV1Schema.parse(command.request);
      const requestDigest = await computeControlPayloadDigestV1(request);

      return withPostgresTransaction(input.pool, async (client) => {
        await client.query(
          `INSERT INTO cp_organization(organization_id, display_name)
           VALUES($1, $2)
           ON CONFLICT (organization_id) DO NOTHING`,
          [command.organizationId, command.organizationName],
        );
        await client.query(
          "SELECT organization_id FROM cp_organization WHERE organization_id = $1 FOR UPDATE",
          [command.organizationId],
        );

        const existingOperation = await client.query(
          `SELECT request_digest, runner_id, response
           FROM cp_runner_operation
           WHERE organization_id = $1 AND operation_id = $2`,
          [command.organizationId, request.operationId],
        ) as { rows: Array<{ request_digest: string; runner_id: string; response: unknown }> };
        const replay = existingOperation.rows[0];
        if (replay) {
          if (
            replay.request_digest !== requestDigest
            || replay.runner_id !== request.runnerId
          ) {
            return { kind: "conflict", reason: "operation_mismatch" };
          }
          return {
            kind: "replayed",
            response: ReplayedRunnerCredentialResponseV1Schema.parse(replay.response),
          };
        }

        const existingRunner = await client.query(
          `SELECT 1 FROM cp_runner
           WHERE organization_id = $1 AND runner_id = $2`,
          [command.organizationId, request.runnerId],
        ) as { rows: unknown[] };
        if (existingRunner.rows.length > 0) {
          return { kind: "conflict", reason: "runner_already_registered" };
        }

        const createdAt = input.clock.now().toISOString();
        const credentialId = input.idFactory("credential");
        const runnerToken = input.tokenFactory();
        const metadata = {
          schemaVersion: 1 as const,
          protocolVersion: "1.0" as const,
          operationId: request.operationId,
          organizationId: command.organizationId,
          runnerId: request.runnerId,
          registrationGeneration: 1,
          credentialGeneration: 1,
          credentialId,
          credentialPurpose: "runtime" as const,
          createdAt,
        };
        const fresh = FreshRunnerCredentialResponseV1Schema.parse({
          ...metadata,
          runnerToken,
          replayed: false,
        });
        const replayed = ReplayedRunnerCredentialResponseV1Schema.parse({
          ...metadata,
          replayed: true,
        });

        await client.query(
          `INSERT INTO cp_runner(
             organization_id, runner_id, display_name,
             registration_generation, credential_generation,
             current_credential_id, capabilities, created_at, updated_at
           ) VALUES($1, $2, $3, 1, 1, $4, $5::jsonb, $6, $6)`,
          [
            command.organizationId,
            request.runnerId,
            request.displayName ?? null,
            credentialId,
            JSON.stringify(request.capabilities),
            createdAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_runner_credential(
             organization_id, runner_id, credential_id,
             credential_generation, token_hash, created_at
           ) VALUES($1, $2, $3, 1, $4, $5)`,
          [
            command.organizationId,
            request.runnerId,
            credentialId,
            hashToken(runnerToken),
            createdAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_runner_operation(
             organization_id, operation_id, request_id, request_digest,
             operation_kind, runner_id, response, created_at
           ) VALUES($1, $2, $3, $4, 'register', $5, $6::jsonb, $7)`,
          [
            command.organizationId,
            request.operationId,
            request.requestId,
            requestDigest,
            request.runnerId,
            JSON.stringify(replayed),
            createdAt,
          ],
        );
        await recordManagementAudit(client, {
          organizationId: command.organizationId,
          actor: { kind: "bootstrap", id: "bootstrap_pairing" },
          operationKind: "runner.register",
          resource: { kind: "runner", id: request.runnerId },
          outcome: "created",
          event: {
            credentialId,
            operationId: request.operationId,
            registrationGeneration: 1,
          },
          createdAt,
        });
        return { kind: "created", response: fresh };
      });
    },

    async authenticate(token) {
      if (!token || token !== token.trim()) return { kind: "invalid_credential" };
      const result = await input.pool.query<{
        organization_id: string;
        runner_id: string;
        credential_id: string;
        registration_generation: number;
        credential_generation: number;
      }>(
        `SELECT runner.organization_id, runner.runner_id,
                credential.credential_id, runner.registration_generation,
                credential.credential_generation
         FROM cp_runner_credential credential
         JOIN cp_runner runner
           ON runner.organization_id = credential.organization_id
          AND runner.runner_id = credential.runner_id
          AND runner.current_credential_id = credential.credential_id
         WHERE credential.token_hash = $1
           AND credential.revoked_at IS NULL`,
        [hashToken(token)],
      );
      const row = result.rows[0];
      if (!row) return { kind: "invalid_credential" };
      return {
        kind: "authenticated",
        principal: {
          organizationId: row.organization_id,
          runnerId: row.runner_id,
          credentialId: row.credential_id,
          registrationGeneration: row.registration_generation,
          credentialGeneration: row.credential_generation,
        },
      };
    },

    async reprovision(command) {
      const request = RunnerCredentialReprovisionRequestV1Schema.parse(
        command.request,
      );
      const requestDigest = await computeControlPayloadDigestV1(request);

      return withPostgresTransaction(input.pool, async (client) => {
        const organization = await client.query(
          `SELECT organization_id FROM cp_organization
           WHERE organization_id = $1 FOR UPDATE`,
          [command.organizationId],
        ) as { rows: unknown[] };
        if (organization.rows.length === 0) {
          return { kind: "conflict", reason: "stale_recovery" } as const;
        }
        const existingOperation = await client.query(
          `SELECT request_digest, runner_id, operation_kind, response
           FROM cp_runner_operation
           WHERE organization_id = $1 AND operation_id = $2`,
          [command.organizationId, request.operationId],
        ) as {
          rows: Array<{
            request_digest: string;
            runner_id: string;
            operation_kind: string;
            response: unknown;
          }>;
        };
        const replay = existingOperation.rows[0];
        if (replay) {
          if (
            replay.request_digest !== requestDigest
            || replay.runner_id !== request.runnerId
            || replay.operation_kind !== "reprovision"
          ) {
            return { kind: "conflict", reason: "operation_mismatch" } as const;
          }
          return {
            kind: "replayed",
            response: ReplayedRunnerCredentialResponseV1Schema.parse(
              replay.response,
            ),
          } as const;
        }

        const runnerResult = await client.query(
          `SELECT current_credential_id, registration_generation,
                  credential_generation
           FROM cp_runner
           WHERE organization_id = $1 AND runner_id = $2
           FOR UPDATE`,
          [command.organizationId, request.runnerId],
        ) as {
          rows: Array<{
            current_credential_id: string;
            registration_generation: number;
            credential_generation: number;
          }>;
        };
        const runner = runnerResult.rows[0];
        if (
          !runner
          || runner.current_credential_id !== request.recoveryCredentialId
          || runner.registration_generation
            !== request.expectedRegistrationGeneration
          || runner.credential_generation
            !== request.expectedCredentialGeneration
        ) {
          return { kind: "conflict", reason: "stale_recovery" } as const;
        }

        const createdAt = input.clock.now().toISOString();
        const credentialId = input.idFactory("credential");
        const runnerToken = input.tokenFactory();
        const registrationGeneration = runner.registration_generation + 1;
        const credentialGeneration = runner.credential_generation + 1;
        const metadata = {
          schemaVersion: 1 as const,
          protocolVersion: "1.0" as const,
          operationId: request.operationId,
          organizationId: command.organizationId,
          runnerId: request.runnerId,
          registrationGeneration,
          credentialGeneration,
          credentialId,
          credentialPurpose: "runtime" as const,
          createdAt,
        };
        const fresh = FreshRunnerCredentialResponseV1Schema.parse({
          ...metadata,
          runnerToken,
          replayed: false,
        });
        const replayed = ReplayedRunnerCredentialResponseV1Schema.parse({
          ...metadata,
          replayed: true,
        });

        await client.query(
          `UPDATE cp_runner_credential
           SET revoked_at = $4
           WHERE organization_id = $1 AND runner_id = $2
             AND credential_id = $3 AND revoked_at IS NULL`,
          [
            command.organizationId,
            request.runnerId,
            runner.current_credential_id,
            createdAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_runner_credential(
             organization_id, runner_id, credential_id,
             credential_generation, token_hash, created_at
           ) VALUES($1, $2, $3, $4, $5, $6)`,
          [
            command.organizationId,
            request.runnerId,
            credentialId,
            credentialGeneration,
            hashToken(runnerToken),
            createdAt,
          ],
        );
        await client.query(
          `UPDATE cp_runner
           SET registration_generation = $3,
               credential_generation = $4,
               current_credential_id = $5,
               updated_at = $6
           WHERE organization_id = $1 AND runner_id = $2`,
          [
            command.organizationId,
            request.runnerId,
            registrationGeneration,
            credentialGeneration,
            credentialId,
            createdAt,
          ],
        );
        await client.query(
          `DELETE FROM cp_runner_readiness
           WHERE organization_id = $1 AND runner_id = $2`,
          [command.organizationId, request.runnerId],
        );
        await client.query(
          `INSERT INTO cp_runner_operation(
             organization_id, operation_id, request_id, request_digest,
             operation_kind, runner_id, response, created_at
           ) VALUES($1, $2, $3, $4, 'reprovision', $5, $6::jsonb, $7)`,
          [
            command.organizationId,
            request.operationId,
            request.requestId,
            requestDigest,
            request.runnerId,
            JSON.stringify(replayed),
            createdAt,
          ],
        );
        await recordManagementAudit(client, {
          organizationId: command.organizationId,
          actor: { kind: "recovery", id: "recovery_pairing" },
          operationKind: "runner.reprovision",
          resource: { kind: "runner", id: request.runnerId },
          outcome: "credential_rotated",
          event: {
            credentialGeneration,
            credentialId,
            operationId: request.operationId,
            registrationGeneration,
          },
          createdAt,
        });
        return { kind: "created", response: fresh } as const;
      });
    },

    async upsertProjectTarget(command) {
      const updatedAt = input.clock.now().toISOString();
      const target = ProjectTargetDeclarationSchema.parse(command.target);
      await withPostgresTransaction(input.pool, async (client) => {
        await client.query(
          UPSERT_PROJECT_TARGET_SQL,
          projectTargetValues({
            organizationId: command.principal.organizationId,
            runnerId: command.principal.runnerId,
            target,
            updatedAt,
          }),
        );
        await recordManagementAudit(client, {
          organizationId: command.principal.organizationId,
          actor: { kind: "runner", id: command.principal.runnerId },
          operationKind: "project_target.upsert",
          resource: { kind: "project_target", id: target.projectTargetId },
          outcome: "upserted",
          event: { runnerId: command.principal.runnerId, version: target.version },
          createdAt: updatedAt,
        });
      });
    },

    async declareProjectTarget(command) {
      const target = ProjectTargetDeclarationSchema.parse(command.target);
      return withPostgresTransaction(input.pool, async (client) => {
        const runner = await client.query(
          `SELECT 1 FROM cp_runner
           WHERE organization_id = $1 AND runner_id = $2
           FOR UPDATE`,
          [command.organizationId, command.runnerId],
        ) as { rows: unknown[] };
        if (runner.rows.length === 0) throw new Error("target_runner_not_found");
        const existing = await client.query(
          `SELECT 1 FROM cp_project_target
           WHERE organization_id = $1 AND project_target_id = $2`,
          [command.organizationId, target.projectTargetId],
        ) as { rows: unknown[] };
        const updatedAt = input.clock.now().toISOString();
        await client.query(
          UPSERT_PROJECT_TARGET_SQL,
          projectTargetValues({
            organizationId: command.organizationId,
            runnerId: command.runnerId,
            target,
            updatedAt,
          }),
        );
        const outcome = existing.rows.length === 0 ? "created" : "updated";
        await recordManagementAudit(client, {
          organizationId: command.organizationId,
          actor: command.actor ?? { kind: "system", id: "control_plane" },
          operationKind: "project_target.declare",
          resource: { kind: "project_target", id: target.projectTargetId },
          outcome,
          event: { runnerId: command.runnerId, version: target.version },
          createdAt: updatedAt,
        });
        return { kind: outcome };
      });
    },

    async recordReadiness(command) {
      const receipt = RunnerReadinessReceiptEnvelopeV1Schema.parse(command.receipt);
      const principal = command.principal;
      if (
        receipt.organizationId !== principal.organizationId
        || receipt.payload.runnerId !== principal.runnerId
        || receipt.producer.id !== principal.runnerId
        || receipt.producer.credentialId !== principal.credentialId
        || receipt.producer.registrationGeneration
          !== principal.registrationGeneration
        || receipt.payload.registrationGeneration
          !== principal.registrationGeneration
      ) {
        return { kind: "conflict", reason: "authority_mismatch" };
      }
      const { receiptDigest: _receiptDigest, ...receiptDigestInput } = receipt;
      if (
        receipt.payloadDigest
          !== await computeControlPayloadDigestV1(receipt.payload)
        || receipt.receiptDigest
          !== await computeControlReceiptDigestV1(receiptDigestInput)
      ) {
        return { kind: "conflict", reason: "receipt_mismatch" };
      }

      return withPostgresTransaction(input.pool, async (client) => {
        const existing = await client.query(
          `SELECT receipt_digest, receipt
           FROM cp_runner_readiness
           WHERE organization_id = $1 AND receipt_id = $2`,
          [principal.organizationId, receipt.receiptId],
        ) as { rows: Array<{ receipt_digest: string; receipt: unknown }> };
        const row = existing.rows[0];
        if (row) {
          if (row.receipt_digest !== receipt.receiptDigest) {
            return { kind: "conflict", reason: "receipt_mismatch" } as const;
          }
          return {
            kind: "replayed",
            receipt: RunnerReadinessReceiptEnvelopeV1Schema.parse(row.receipt),
          } as const;
        }
        await client.query(
          `INSERT INTO cp_runner_readiness(
             organization_id, runner_id, receipt_id, receipt_digest,
             observed_at, expires_at, receipt
           ) VALUES($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            principal.organizationId,
            principal.runnerId,
            receipt.receiptId,
            receipt.receiptDigest,
            receipt.observedAt,
            receipt.payload.expiresAt,
            JSON.stringify(receipt),
          ],
        );
        return { kind: "recorded", receipt } as const;
      });
    },

    async getControlContext(principal) {
      const runnerResult = await input.pool.query<{
        capabilities: unknown;
      }>(
        `SELECT capabilities
         FROM cp_runner
         WHERE organization_id = $1 AND runner_id = $2
           AND current_credential_id = $3`,
        [principal.organizationId, principal.runnerId, principal.credentialId],
      );
      const runner = runnerResult.rows[0];
      if (!runner) throw new Error("runner_context_unavailable");
      const targets = await input.pool.query<{
        project_target_id: string;
        binding_digest: string;
        provider: string;
        owner: string;
        repo: string;
        default_executor: string;
        default_branch: string | null;
      }>(
        `SELECT project_target_id, binding_digest, provider, owner, repo,
                default_executor, default_branch
         FROM cp_project_target
         WHERE organization_id = $1 AND runner_id = $2
         ORDER BY project_target_id`,
        [principal.organizationId, principal.runnerId],
      );
      return RunnerControlContextResponseV1Schema.parse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        contextKind: "runner_control",
        organizationId: principal.organizationId,
        runnerId: principal.runnerId,
        credentialId: principal.credentialId,
        registrationGeneration: principal.registrationGeneration,
        credentialGeneration: principal.credentialGeneration,
        capabilities: runner.capabilities,
        targets: targets.rows.map((target) => ({
          projectTargetId: target.project_target_id,
          bindingDigest: target.binding_digest,
          provider: target.provider,
          owner: target.owner,
          repo: target.repo,
          defaultExecutor: target.default_executor,
          defaultBranch: target.default_branch,
        })),
        observedAt: input.clock.now().toISOString(),
      });
    },

    async pruneExpiredReadiness(organizationId: string | null) {
      const result = await input.pool.query(
        `DELETE FROM cp_runner_readiness
         WHERE expires_at <= $1
           AND ($2::text IS NULL OR organization_id = $2)
         RETURNING receipt_id`,
        [input.clock.now(), organizationId],
      );
      return { deleted: result.rowCount ?? 0 };
    },
  };
}
