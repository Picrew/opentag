import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Pool } from "pg";
import { createControlPlaneApplication } from "./application.js";
import type { ControlPlaneConfig } from "./config.js";
import {
  checkMigrationReadiness,
  type SqlMigration,
} from "./database/migrations.js";
import {
  checkPostgresReadiness,
  createPostgresRuntime,
} from "./database/postgres.js";
import { createHostedRunCoordinator } from "./modules/hosted-runs/index.js";
import { createPermissionCoordinator } from "./modules/hosted-runs/permissions.js";
import { createMaterialActionCoordinator } from "./modules/hosted-runs/material-actions.js";
import { createConsoleReadModel } from "./modules/console-reads/index.js";
import {
  createIdentityModule,
  createLoginThrottleKeyFactory,
} from "./modules/identity/index.js";
import {
  createDurableJobQueue,
  scheduleControlPlaneMaintenance,
} from "./modules/jobs/index.js";
import { createGithubIngress } from "./modules/github-ingress/index.js";
import { createRunnerDirectory } from "./modules/runners/index.js";

const BASE_CAPABILITIES = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.material-receipt.v1",
  "relay.permission.v1",
  "relay.readiness.v1",
  "relay.registration.v1",
] as const;

type PostgresCapability = {
  pool: Pool;
  close(): Promise<void>;
};

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(left: string, right: string): boolean {
  return timingSafeEqual(secretDigest(left), secretDigest(right));
}

function randomIdentifier(
  kind:
    | "api_key"
    | "attempt"
    | "credential"
    | "operator"
    | "permission_receipt"
    | "permission_resolution"
    | "session",
): string {
  return `${kind}_${randomBytes(16).toString("hex")}`;
}

function runtimeSecret(
  prefix: "api_key" | "job_lease" | "runtime" | "session",
): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function createControlPlaneRuntime(input: {
  config: ControlPlaneConfig;
  migrations: readonly SqlMigration[];
  postgres?: PostgresCapability;
}) {
  const postgres = input.postgres ?? createPostgresRuntime({
    databaseUrl: input.config.databaseUrl,
    poolMax: input.config.poolMax,
  });
  const clock = { now: () => new Date() };
  const runners = createRunnerDirectory({
    pool: postgres.pool,
    clock,
    idFactory: () => randomIdentifier("credential"),
    tokenFactory: () => runtimeSecret("runtime"),
  });
  const hosted = createHostedRunCoordinator({
    pool: postgres.pool,
    clock,
    leaseDurationMs: 60_000,
    idFactory: () => randomIdentifier("attempt"),
    tokenFactory: (context) => `fence_${createHmac(
      "sha256",
      input.config.fencingTokenSecret,
    ).update(JSON.stringify([
      "opentag.control.fencing-token/v1",
      context.organizationId,
      context.operationId,
      context.runId,
      context.attemptId,
      context.attemptNumber,
    ])).digest("base64url")}`,
  });
  const identity = createIdentityModule({
    pool: postgres.pool,
    clock,
    idFactory: (kind) => randomIdentifier(kind),
    opaqueBearerFactory: (kind) => runtimeSecret(kind),
    sessionDurationMs: 8 * 60 * 60 * 1_000,
    throttleKeyFactory: createLoginThrottleKeyFactory(
      input.config.loginRateLimit.secret,
    ),
    loginRateLimit: input.config.loginRateLimit,
  });
  const permissions = createPermissionCoordinator({
    pool: postgres.pool,
    clock,
    idFactory: (kind) => randomIdentifier(kind),
  });
  const materials = createMaterialActionCoordinator({
    pool: postgres.pool,
    clock,
  });
  const reads = createConsoleReadModel({ pool: postgres.pool });
  const jobs = createDurableJobQueue({
    pool: postgres.pool,
    clock,
    leaseDurationMs: input.config.jobLeaseDurationMs,
    tokenFactory: () => runtimeSecret("job_lease"),
  });
  const jobHandlers = {
    "hosted-attempt-reconciliation": async (job: {
      organizationId: string | null;
    }) => hosted.reconcileExpiredAttempts(job.organizationId),
    "runner-readiness-retention": async (job: {
      organizationId: string | null;
    }) => runners.pruneExpiredReadiness(job.organizationId),
  };
  const scheduleJobs = () => scheduleControlPlaneMaintenance({
    queue: jobs,
    clock,
  });
  const github = input.config.githubIngressMasterSecret
    ? createGithubIngress({
        pool: postgres.pool,
        hosted,
        clock,
        masterSecret: input.config.githubIngressMasterSecret,
      })
    : null;
  const application = createControlPlaneApplication({
    capabilities: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      registryVersion: "opentag.control.capabilities/v1",
      capabilities: [
        ...BASE_CAPABILITIES,
        ...(input.config.recoveryPairingToken
          ? ["relay.credential-reprovision.v1" as const]
          : []),
      ].sort(),
      minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
      deployment: {
        environment: input.config.environment,
        releaseSha: input.config.releaseSha,
      },
      artifact: {
        packageName: "@opentag/control-plane",
        packageVersion: "0.0.0",
      },
    },
    readiness: {
      async check() {
        const database = await checkPostgresReadiness(postgres.pool);
        if (!database.ready) return database;
        return checkMigrationReadiness(postgres.pool, input.migrations);
      },
    },
    control: {
      bootstrap: {
        authenticate(token) {
          if (!secretsEqual(token, input.config.bootstrapPairingToken)) {
            return null;
          }
          return {
            organizationId: input.config.bootstrapOrganizationId,
            organizationName: input.config.bootstrapOrganizationName,
          };
        },
      },
      ...(input.config.recoveryPairingToken
        ? {
            recovery: {
              authenticate(token: string) {
                if (!secretsEqual(token, input.config.recoveryPairingToken!)) {
                  return null;
                }
                return {
                  organizationId: input.config.bootstrapOrganizationId,
                };
              },
            },
          }
        : {}),
      runners,
      hosted,
      materials,
      permissions,
      approver: {
        async authenticate(token) {
          const outcome = await identity.authenticateApiKey(token);
          if (outcome.kind !== "authenticated") return outcome;
          if (!outcome.principal.scopes.includes("permission:resolve")) {
            return { kind: "insufficient_scope" as const };
          }
          return {
            kind: "authenticated" as const,
            principal: {
              organizationId: outcome.principal.organizationId,
              actorId: outcome.principal.apiKeyId,
            },
          };
        },
      },
    },
    console: {
      identity,
      reads,
      publicOrigin: input.config.publicOrigin,
      loginNetworkMode: input.config.loginRateLimit.networkMode,
      targets: runners,
    },
    ...(github ? { github } : {}),
  });

  return {
    application,
    hosted,
    github,
    identity,
    jobHandlers,
    jobs,
    scheduleJobs,
    materials,
    permissions,
    reads,
    runners,
    close: () => postgres.close(),
  };
}
