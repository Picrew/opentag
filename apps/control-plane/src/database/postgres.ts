import { drizzle } from "drizzle-orm/node-postgres";
import {
  Pool,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import type { ReadinessResult } from "../application.js";

export type PostgresPoolInput = {
  databaseUrl: string;
  poolMax: number;
};

export function createPoolConfig(input: PostgresPoolInput): PoolConfig {
  return {
    application_name: "opentag-control-plane",
    connectionString: input.databaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: input.poolMax,
  };
}

type TransactionClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rowCount" | "rows">>;
  release(): void;
};

type TransactionPool = {
  connect(): Promise<TransactionClient>;
};

export async function withPostgresTransaction<T>(
  pool: TransactionPool,
  operation: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type ReadinessPool = {
  query(text: string): Promise<Pick<QueryResult, "rows">>;
};

export async function checkPostgresReadiness(
  pool: ReadinessPool,
): Promise<ReadinessResult> {
  try {
    await pool.query("SELECT 1 AS ready");
    return { ready: true };
  } catch {
    return { ready: false, reason: "database_unavailable" };
  }
}

export function createPostgresRuntime(input: PostgresPoolInput) {
  const pool = new Pool(createPoolConfig(input));
  return {
    pool,
    database: drizzle({ client: pool }),
    async close() {
      await pool.end();
    },
  };
}
