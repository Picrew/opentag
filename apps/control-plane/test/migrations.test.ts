import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkMigrationReadiness,
  runMigrations,
  type SqlMigration,
} from "../src/database/migrations.js";

type RecordedQuery = { text: string; values?: readonly unknown[] };

function migrationHarness(
  applied: Array<{ name: string; checksum: string }> = [],
  options: { failUnlock?: boolean } = {},
) {
  const queries: RecordedQuery[] = [];
  let released = 0;
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push(values ? { text, values } : { text });
      if (text.includes("SELECT name, checksum")) return { rows: applied };
      if (options.failUnlock && text.includes("pg_advisory_unlock")) {
        throw new Error("unlock_failed");
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      released += 1;
    },
  };
  return {
    pool: {
      async connect() {
        return client;
      },
      async query(text: string, values?: readonly unknown[]) {
        return client.query(text, values);
      },
    },
    queries,
    released: () => released,
  };
}

const migration = (name: string, sql: string): SqlMigration => ({
  name,
  sql,
  checksum: createHash("sha256").update(sql).digest("hex"),
});

describe("checked-in PostgreSQL migrations", () => {
  it("serializes migration application and records the reviewed checksum", async () => {
    const harness = migrationHarness();
    const first = migration("0000_control_plane.sql", "CREATE TABLE example(id text)");

    await runMigrations(harness.pool, [first]);

    expect(harness.queries.map(({ text }) => text)).toEqual([
      "SELECT pg_advisory_lock($1)",
      expect.stringContaining("CREATE TABLE IF NOT EXISTS control_plane_migrations"),
      expect.stringContaining("SELECT name, checksum"),
      "BEGIN",
      first.sql,
      expect.stringContaining("INSERT INTO control_plane_migrations"),
      "COMMIT",
      "SELECT pg_advisory_unlock($1)",
    ]);
    expect(harness.queries[5]?.values).toEqual([first.name, first.checksum]);
    expect(harness.released()).toBe(1);
  });

  it("refuses an edited migration that was already applied", async () => {
    const current = migration("0000_control_plane.sql", "SELECT 2");
    const harness = migrationHarness([
      { name: current.name, checksum: "edited-checksum" },
    ]);

    await expect(runMigrations(harness.pool, [current])).rejects.toThrow(
      "migration_checksum_mismatch",
    );

    expect(harness.queries.at(-1)?.text).toBe("SELECT pg_advisory_unlock($1)");
    expect(harness.released()).toBe(1);
  });

  it("refuses an applied migration that is absent from the image", async () => {
    const current = migration("0000_control_plane.sql", "SELECT 1");
    const harness = migrationHarness([
      { name: current.name, checksum: current.checksum },
      { name: "0001_future_schema.sql", checksum: "future-checksum" },
    ]);

    await expect(runMigrations(harness.pool, [current])).rejects.toThrow(
      "migration_unknown_applied",
    );

    expect(harness.queries.at(-1)?.text).toBe("SELECT pg_advisory_unlock($1)");
    expect(harness.released()).toBe(1);
  });

  it("releases the pooled client even when advisory unlock fails", async () => {
    const harness = migrationHarness([], { failUnlock: true });

    await expect(runMigrations(harness.pool, [])).rejects.toThrow(
      "unlock_failed",
    );

    expect(harness.released()).toBe(1);
  });

  it("fails readiness closed when migrations are missing or edited", async () => {
    const current = migration("0000_control_plane.sql", "SELECT 1");

    await expect(
      checkMigrationReadiness(migrationHarness().pool, [current]),
    ).resolves.toEqual({ ready: false, reason: "migrations_pending" });
    await expect(
      checkMigrationReadiness(
        migrationHarness([{ name: current.name, checksum: "wrong" }]).pool,
        [current],
      ),
    ).resolves.toEqual({ ready: false, reason: "migrations_pending" });
    await expect(
      checkMigrationReadiness(
        migrationHarness([{ name: current.name, checksum: current.checksum }]).pool,
        [current],
      ),
    ).resolves.toEqual({ ready: true });
    await expect(
      checkMigrationReadiness(
        migrationHarness([
          { name: current.name, checksum: current.checksum },
          { name: "0001_future_schema.sql", checksum: "future-checksum" },
        ]).pool,
        [current],
      ),
    ).resolves.toEqual({ ready: false, reason: "migrations_pending" });
  });
});
