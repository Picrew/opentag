import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import { loadSqlMigrations, runMigrations } from "../src/database/migrations.js";

export const TEST_DATABASE_URL = process.env.OPENTAG_TEST_DATABASE_URL;

if (
  process.env.OPENTAG_REQUIRE_TEST_DATABASE === "1"
  && !TEST_DATABASE_URL
) {
  throw new Error("OPENTAG_TEST_DATABASE_URL is required by this test run");
}

export async function createIsolatedPostgres() {
  if (!TEST_DATABASE_URL) throw new Error("OPENTAG_TEST_DATABASE_URL is required");
  const schema = `cp_test_${randomBytes(8).toString("hex")}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 8,
    options: `-c search_path=${schema}`,
  });
  const migrationDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../migrations",
  );
  const migrations = await loadSqlMigrations(migrationDirectory);

  return {
    admin,
    migrations,
    pool,
    schema,
    async migrate() {
      await runMigrations(pool, migrations);
    },
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
