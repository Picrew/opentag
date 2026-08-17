import { fileURLToPath } from "node:url";
import {
  parseAdminBootstrapConfig,
  parseControlPlaneConfig,
} from "./config.js";
import {
  loadSqlMigrations,
  runMigrations,
} from "./database/migrations.js";
import { createPostgresRuntime } from "./database/postgres.js";
import { startNodeServer } from "./node-server.js";
import { runJobLoop, runOneJob } from "./modules/jobs/worker.js";
import { createControlPlaneRuntime } from "./runtime.js";

const migrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export async function main(input: {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
} = {}): Promise<void> {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const command = argv[0] ?? "serve";
  const config = parseControlPlaneConfig(env);
  const migrations = await loadSqlMigrations(migrationDirectory);

  if (command === "migrate") {
    const postgres = createPostgresRuntime({
      databaseUrl: config.databaseUrl,
      poolMax: 1,
    });
    try {
      await runMigrations(postgres.pool, migrations);
    } finally {
      await postgres.close();
    }
    return;
  }

  if (command === "bootstrap-admin") {
    const runtime = createControlPlaneRuntime({ config, migrations });
    try {
      const admin = parseAdminBootstrapConfig(env);
      const outcome = await runtime.identity.provisionOwner({
        organizationId: config.bootstrapOrganizationId,
        organizationName: config.bootstrapOrganizationName,
        email: admin.email,
        displayName: admin.displayName,
        password: admin.password,
      });
      if (outcome.kind === "conflict") {
        throw new Error("bootstrap_admin_conflict");
      }
    } finally {
      await runtime.close();
    }
    return;
  }

  if (command === "jobs") {
    const runtime = createControlPlaneRuntime({ config, migrations });
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    process.once("SIGTERM", abort);
    process.once("SIGINT", abort);
    try {
      const readiness = await runtime.application.fetch(
        new Request(`${config.publicOrigin}/readyz`),
      );
      if (!readiness.ok) throw new Error("control_plane_not_ready");
      const workerInput = {
        queue: runtime.jobs,
        workerId: `jobs_${process.pid}`,
        handlers: runtime.jobHandlers,
        retryDelayMs: config.jobRetryDelayMs,
        clock: { now: () => new Date() },
        beforeClaim: runtime.scheduleJobs,
      };
      if (argv.includes("--once")) {
        await runOneJob(workerInput);
      } else {
        await runJobLoop({
          ...workerInput,
          pollIntervalMs: config.jobPollIntervalMs,
          signal: abortController.signal,
        });
      }
    } finally {
      process.off("SIGTERM", abort);
      process.off("SIGINT", abort);
      await runtime.close();
    }
    return;
  }

  if (command !== "serve") {
    throw new Error("unsupported_control_plane_command");
  }

  const runtime = createControlPlaneRuntime({ config, migrations });
  const server = startNodeServer({
    application: runtime.application,
    consoleAssetsDirectory: fileURLToPath(new URL("./console", import.meta.url)),
    host: config.host,
    port: config.port,
    drain: runtime.close,
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
