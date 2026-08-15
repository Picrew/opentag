import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMigrationReadiness } from "../src/database/migrations.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL migration corpus", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("migrates an empty schema and is idempotently ready", async () => {
    expect(fixture.migrations.map(({ name }) => name)).toEqual([
      "0000_control_plane.sql",
      "0001_permissions.sql",
      "0002_material_actions.sql",
      "0003_bind_session_tenant.sql",
    ]);

    await expect(fixture.migrate()).resolves.toBeUndefined();
    await expect(fixture.migrate()).resolves.toBeUndefined();
    await expect(
      checkMigrationReadiness(fixture.pool, fixture.migrations),
    ).resolves.toEqual({ ready: true });

    const result = await fixture.pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [fixture.schema],
    );
    expect(result.rows.map(({ table_name }) => table_name)).toEqual(
      expect.arrayContaining([
        "control_plane_migrations",
        "cp_runner",
        "cp_hosted_run",
        "cp_hosted_attempt",
        "cp_job",
        "cp_permission_request",
        "cp_permission_operation",
        "cp_material_action_receipt",
        "cp_material_action_current",
        "cp_management_audit_event",
      ]),
    );

    const sessionTenantColumn = await fixture.pool.query<{
      is_nullable: string;
    }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'cp_session'
         AND column_name = 'organization_id'`,
      [fixture.schema],
    );
    expect(sessionTenantColumn.rows).toEqual([{ is_nullable: "NO" }]);

    const sessionTenantForeignKey = await fixture.pool.query<{
      constraint_name: string;
    }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE table_schema = $1
         AND table_name = 'cp_session'
         AND constraint_type = 'FOREIGN KEY'
         AND constraint_name = 'cp_session_membership_fk'`,
      [fixture.schema],
    );
    expect(sessionTenantForeignKey.rows).toEqual([
      { constraint_name: "cp_session_membership_fk" },
    ]);
  });
});
