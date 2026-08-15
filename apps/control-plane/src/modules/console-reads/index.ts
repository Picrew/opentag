import type { Pool } from "pg";
import type { ConsolePrincipal } from "../identity/index.js";

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("invalid_read_limit");
  }
  return value;
}

export function createConsoleReadModel(input: { pool: Pool }) {
  return {
    async overview(principal: ConsolePrincipal) {
      const result = await input.pool.query<{
        runner_count: number;
        ready_runner_count: number;
        active_run_count: number;
        terminal_run_count: number;
        pending_job_count: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM cp_runner
           WHERE organization_id = $1) AS runner_count,
          (SELECT count(*)::int FROM cp_runner runner
           WHERE runner.organization_id = $1
             AND EXISTS (
               SELECT 1 FROM cp_runner_readiness readiness
               WHERE readiness.organization_id = runner.organization_id
                 AND readiness.runner_id = runner.runner_id
                 AND readiness.expires_at > clock_timestamp()
             )) AS ready_runner_count,
          (SELECT count(*)::int FROM cp_hosted_run
           WHERE organization_id = $1
             AND terminal_kind IS NULL) AS active_run_count,
          (SELECT count(*)::int FROM cp_hosted_run
           WHERE organization_id = $1
             AND terminal_kind IS NOT NULL) AS terminal_run_count,
          (SELECT count(*)::int FROM cp_job
           WHERE organization_id = $1
             AND state IN ('pending', 'claimed')) AS pending_job_count`,
        [principal.organizationId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("console_overview_unavailable");
      return {
        runnerCount: row.runner_count,
        readyRunnerCount: row.ready_runner_count,
        activeRunCount: row.active_run_count,
        terminalRunCount: row.terminal_run_count,
        pendingJobCount: row.pending_job_count,
      };
    },

    async listRunners(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        runner_id: string;
        display_name: string | null;
        registration_generation: number;
        credential_generation: number;
        capabilities: string[];
        readiness: unknown | null;
        updated_at: Date;
      }>(
        `SELECT runner.runner_id, runner.display_name,
                runner.registration_generation,
                runner.credential_generation, runner.capabilities,
                readiness.receipt AS readiness, runner.updated_at
         FROM cp_runner runner
         LEFT JOIN LATERAL (
           SELECT receipt FROM cp_runner_readiness
           WHERE organization_id = runner.organization_id
             AND runner_id = runner.runner_id
           ORDER BY observed_at DESC LIMIT 1
         ) readiness ON true
         WHERE runner.organization_id = $1
         ORDER BY runner.runner_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        runnerId: row.runner_id,
        displayName: row.display_name,
        registrationGeneration: row.registration_generation,
        credentialGeneration: row.credential_generation,
        capabilities: row.capabilities,
        readiness: row.readiness,
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listRuns(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        run_id: string;
        runner_id: string;
        executor_id: string;
        state: string;
        current_attempt_number: number;
        terminal_kind: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT run_id, runner_id, executor_id, state,
                current_attempt_number, terminal_kind, created_at, updated_at
         FROM cp_hosted_run
         WHERE organization_id = $1
         ORDER BY created_at DESC, run_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        runId: row.run_id,
        runnerId: row.runner_id,
        executorId: row.executor_id,
        state: row.state,
        currentAttemptNumber: row.current_attempt_number,
        terminalKind: row.terminal_kind,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listAudit(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        sequence_id: string;
        run_id: string | null;
        event_kind: string;
        event: unknown;
        created_at: Date;
      }>(
        `SELECT sequence_id, run_id, event_kind, event, created_at
         FROM (
           SELECT 'run:' || sequence_id::text AS sequence_id,
                  run_id, event_kind, event, created_at
           FROM cp_hosted_audit_event
           WHERE organization_id = $1
           UNION ALL
           SELECT 'management:' || sequence_id::text AS sequence_id,
                  NULL::text AS run_id, operation_kind AS event_kind,
                  jsonb_build_object(
                    'actor', jsonb_build_object('kind', actor_kind, 'id', actor_id),
                    'resource', jsonb_build_object('kind', resource_kind, 'id', resource_id),
                    'outcome', outcome,
                    'detail', event
                  ) AS event,
                  created_at
           FROM cp_management_audit_event
           WHERE organization_id = $1
         ) audit
         ORDER BY created_at DESC, sequence_id DESC
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        sequenceId: row.sequence_id,
        runId: row.run_id,
        eventKind: row.event_kind,
        event: row.event,
        createdAt: row.created_at.toISOString(),
      }));
    },

    async listPermissions(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        permission_request_id: string;
        run_id: string;
        runner_id: string;
        attempt_id: string;
        action_id: string;
        state: string;
        request: unknown;
        current_receipt: unknown;
        updated_at: Date;
      }>(
        `SELECT permission_request_id, run_id, runner_id, attempt_id,
                action_id, state, request, current_receipt, updated_at
         FROM cp_permission_request
         WHERE organization_id = $1
         ORDER BY updated_at DESC, permission_request_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        permissionRequestId: row.permission_request_id,
        runId: row.run_id,
        runnerId: row.runner_id,
        attemptId: row.attempt_id,
        actionId: row.action_id,
        state: row.state,
        request: row.request,
        currentReceipt: row.current_receipt,
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listMaterialActions(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        run_id: string;
        attempt_id: string;
        action_id: string;
        receipt_id: string;
        receipt_digest: string;
        outcome: string;
        receipt: unknown;
        updated_at: Date;
      }>(
        `SELECT run_id, attempt_id, action_id, receipt_id, receipt_digest,
                outcome, receipt, updated_at
         FROM cp_material_action_current
         WHERE organization_id = $1
         ORDER BY updated_at DESC, run_id, action_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        runId: row.run_id,
        attemptId: row.attempt_id,
        actionId: row.action_id,
        receiptId: row.receipt_id,
        receiptDigest: row.receipt_digest,
        outcome: row.outcome,
        receipt: row.receipt,
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listProjectTargets(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        project_target_id: string;
        runner_id: string;
        provider: string;
        owner: string;
        repo: string;
        default_executor: string;
        default_branch: string | null;
        version: number;
        updated_at: Date;
      }>(
        `SELECT project_target_id, runner_id, provider, owner, repo,
                default_executor, default_branch, version, updated_at
         FROM cp_project_target
         WHERE organization_id = $1
         ORDER BY project_target_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        projectTargetId: row.project_target_id,
        runnerId: row.runner_id,
        provider: row.provider,
        owner: row.owner,
        repo: row.repo,
        defaultExecutor: row.default_executor,
        defaultBranch: row.default_branch,
        version: row.version,
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listGithubBindings(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        binding_id: string;
        provider_repository_id: string;
        owner: string;
        repo: string;
        runner_id: string;
        project_target_id: string;
        secret_version: string;
        allowed_actor_ids: string[];
        enabled: boolean;
        updated_at: Date;
      }>(
        `SELECT binding_id, provider_repository_id, owner, repo, runner_id,
                project_target_id, secret_version, allowed_actor_ids,
                enabled, updated_at
         FROM cp_github_binding
         WHERE organization_id = $1
         ORDER BY binding_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        bindingId: row.binding_id,
        providerRepositoryId: row.provider_repository_id,
        owner: row.owner,
        repo: row.repo,
        runnerId: row.runner_id,
        projectTargetId: row.project_target_id,
        secretVersion: row.secret_version,
        allowedActorIds: row.allowed_actor_ids,
        enabled: row.enabled,
        updatedAt: row.updated_at.toISOString(),
      }));
    },
  };
}

export type ConsoleReadModel = ReturnType<typeof createConsoleReadModel>;
