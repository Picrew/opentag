import { describe, expect, it } from "vitest";
import {
  checkPostgresReadiness,
  createPoolConfig,
  withPostgresTransaction,
} from "../src/database/postgres.js";

type RecordedQuery = { text: string; values?: readonly unknown[] };

function transactionHarness(options: { failOn?: string } = {}) {
  const queries: RecordedQuery[] = [];
  let releases = 0;
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push(values ? { text, values } : { text });
      if (text === options.failOn) throw new Error("query failed");
      return { rows: [{ value: "ok" }], rowCount: 1 };
    },
    release() {
      releases += 1;
    },
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    },
    queries,
    releases: () => releases,
  };
}

describe("PostgreSQL process boundary", () => {
  it("creates one bounded pool configuration", () => {
    expect(
      createPoolConfig({
        databaseUrl: "postgresql://opentag:secret@postgres:5432/opentag",
        poolMax: 12,
      }),
    ).toEqual({
      application_name: "opentag-control-plane",
      connectionString: "postgresql://opentag:secret@postgres:5432/opentag",
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 12,
    });
  });

  it("uses one checked-out client and releases it after commit", async () => {
    const harness = transactionHarness();

    const result = await withPostgresTransaction(harness.pool, async (client) => {
      await client.query("INSERT INTO example(value) VALUES($1)", ["one"]);
      return "committed";
    });

    expect(result).toBe("committed");
    expect(harness.queries).toEqual([
      { text: "BEGIN" },
      { text: "INSERT INTO example(value) VALUES($1)", values: ["one"] },
      { text: "COMMIT" },
    ]);
    expect(harness.releases()).toBe(1);
  });

  it("rolls back and releases the same client after a transaction failure", async () => {
    const harness = transactionHarness({ failOn: "BROKEN" });

    await expect(
      withPostgresTransaction(harness.pool, async (client) => {
        await client.query("BROKEN");
      }),
    ).rejects.toThrow("query failed");

    expect(harness.queries).toEqual([
      { text: "BEGIN" },
      { text: "BROKEN" },
      { text: "ROLLBACK" },
    ]);
    expect(harness.releases()).toBe(1);
  });

  it("normalizes database probe failures to a closed readiness reason", async () => {
    const ready = await checkPostgresReadiness({
      async query() {
        return { rows: [{ ready: 1 }] };
      },
    });
    const unavailable = await checkPostgresReadiness({
      async query() {
        throw new Error("postgresql://operator:secret@db/private");
      },
    });

    expect(ready).toEqual({ ready: true });
    expect(unavailable).toEqual({ ready: false, reason: "database_unavailable" });
  });
});
