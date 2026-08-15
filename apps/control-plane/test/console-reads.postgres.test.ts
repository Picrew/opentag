import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConsoleReadModel } from "../src/modules/console-reads/index.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("tenant-scoped console read model", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const directory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T10:00:00.000Z") },
      tokenFactory: () => "runtime_console",
      idFactory: () => "credential_console",
    });
    await directory.register({
      organizationId: "org_console_read",
      organizationName: "Console read",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_console_read",
        operationId: "operation_console_read",
        runnerId: "runner_visible",
        displayName: "Visible runner",
        capabilities: ["relay.readiness.v1"],
      },
    });
    const other = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T10:00:00.000Z") },
      tokenFactory: () => "runtime_other",
      idFactory: () => "credential_other",
    });
    await other.register({
      organizationId: "org_other_read",
      organizationName: "Other",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_other_read",
        operationId: "operation_other_read",
        runnerId: "runner_concealed",
        capabilities: [],
      },
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("never returns another tenant's runner or aggregate counts", async () => {
    const reads = createConsoleReadModel({ pool: fixture.pool });
    const principal = {
      operatorId: "operator_console",
      organizationId: "org_console_read",
      role: "viewer" as const,
      email: "viewer@example.test",
      displayName: "Viewer",
    };

    await expect(reads.overview(principal)).resolves.toEqual({
      runnerCount: 1,
      readyRunnerCount: 0,
      activeRunCount: 0,
      terminalRunCount: 0,
      pendingJobCount: 0,
    });
    const runners = await reads.listRunners(principal, { limit: 20 });
    expect(runners).toEqual([
      expect.objectContaining({
        runnerId: "runner_visible",
        displayName: "Visible runner",
      }),
    ]);
    expect(JSON.stringify(runners)).not.toContain("runner_concealed");
  });

  it("lists only tenant-owned Project Targets and provider bindings", async () => {
    await fixture.pool.query(
      `INSERT INTO cp_project_target(
         organization_id, project_target_id, runner_id, binding_digest,
         provider, owner, repo, default_executor, version, updated_at
       ) VALUES
         ('org_console_read', 'target_visible', 'runner_visible', 'digest-visible',
          'github', 'open', 'visible', 'codex', 1, clock_timestamp()),
         ('org_other_read', 'target_concealed', 'runner_concealed', 'digest-hidden',
          'github', 'other', 'hidden', 'codex', 1, clock_timestamp())`,
    );
    await fixture.pool.query(
      `INSERT INTO cp_github_binding(
         organization_id, binding_id, provider_repository_id, owner, repo,
         runner_id, project_target_id, secret_hash, secret_version,
         allowed_actor_ids, enabled, created_at, updated_at
       ) VALUES(
         'org_console_read', 'binding_visible', 'repo-101', 'open', 'visible',
         'runner_visible', 'target_visible', 'hash', 'v1', ARRAY['actor-1'],
         true, clock_timestamp(), clock_timestamp()
       )`,
    );
    const reads = createConsoleReadModel({ pool: fixture.pool });
    const principal = {
      operatorId: "operator_console",
      organizationId: "org_console_read",
      role: "viewer" as const,
      email: "viewer@example.test",
      displayName: "Viewer",
    };

    const targets = await reads.listProjectTargets(principal);
    expect(targets).toEqual([
      expect.objectContaining({ projectTargetId: "target_visible" }),
    ]);
    expect(JSON.stringify(targets)).not.toContain("target_concealed");
    await expect(reads.listGithubBindings(principal)).resolves.toEqual([
      expect.objectContaining({
        bindingId: "binding_visible",
        allowedActorIds: ["actor-1"],
      }),
    ]);
  });
});
