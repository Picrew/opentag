import { randomBytes } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/database/schema.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

type CatalogSnapshot = {
  columns: unknown[];
  constraints: unknown[];
  indexes: unknown[];
};

async function readCatalog(pool: Pool): Promise<CatalogSnapshot> {
  const [columns, constraints, indexes] = await Promise.all([
    pool.query(
      `SELECT relation.relname AS table_name,
              attribute.attname AS column_name,
              format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
              attribute.attnotnull AS not_null,
              attribute.attidentity AS identity_kind,
              pg_get_expr(default_value.adbin, default_value.adrelid, true)
                AS default_expression
       FROM pg_attribute attribute
       JOIN pg_class relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_attrdef default_value
         ON default_value.adrelid = relation.oid
        AND default_value.adnum = attribute.attnum
       WHERE namespace.nspname = current_schema()
         AND relation.relkind = 'r'
         AND relation.relname LIKE 'cp\\_%' ESCAPE '\\'
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       ORDER BY relation.relname, attribute.attname`,
    ),
    pool.query(
      `SELECT relation.relname AS table_name,
              constraint_record.contype AS constraint_type,
              pg_get_constraintdef(constraint_record.oid, true) AS definition
       FROM pg_constraint constraint_record
       JOIN pg_class relation ON relation.oid = constraint_record.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = current_schema()
         AND relation.relname LIKE 'cp\\_%' ESCAPE '\\'
       ORDER BY relation.relname, constraint_record.contype, definition`,
    ),
    pool.query(
      `SELECT relation.relname AS table_name,
              index_relation.relname AS index_name,
              access_method.amname AS access_method,
              index_record.indisunique AS is_unique,
              index_record.indnullsnotdistinct AS nulls_not_distinct,
              ARRAY(
                SELECT pg_get_indexdef(index_record.indexrelid, position, true)
                FROM generate_series(1, index_record.indnkeyatts) position
                ORDER BY position
              ) AS key_expressions
       FROM pg_index index_record
       JOIN pg_class relation ON relation.oid = index_record.indrelid
       JOIN pg_class index_relation
         ON index_relation.oid = index_record.indexrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_am access_method ON access_method.oid = index_relation.relam
       WHERE namespace.nspname = current_schema()
         AND relation.relname LIKE 'cp\\_%' ESCAPE '\\'
         AND NOT EXISTS (
           SELECT 1 FROM pg_constraint constraint_record
           WHERE constraint_record.conindid = index_record.indexrelid
         )
       ORDER BY relation.relname, index_relation.relname`,
    ),
  ]);
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  };
}

function emptyDrizzleSnapshot(
  current: ReturnType<typeof generateDrizzleJson>,
): ReturnType<typeof generateDrizzleJson> {
  return {
    ...structuredClone(current),
    id: "00000000-0000-0000-0000-000000000000",
    prevId: "",
    tables: {},
    enums: {},
    schemas: {},
    sequences: {},
    roles: {},
    policies: {},
    views: {},
    _meta: { tables: {}, columns: {}, schemas: {} },
  };
}

describe.skipIf(!TEST_DATABASE_URL)(
  "Drizzle and checked-in migration semantic parity",
  () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    let generatedPool: Pool;
    let generatedSchema: string;

    beforeAll(async () => {
      fixture = await createIsolatedPostgres();
      await fixture.migrate();
      generatedSchema = `cp_drizzle_${randomBytes(8).toString("hex")}`;
      await fixture.admin.query(`CREATE SCHEMA ${generatedSchema}`);
      generatedPool = new Pool({
        connectionString: TEST_DATABASE_URL,
        max: 2,
        options: `-c search_path=${generatedSchema}`,
      });

      const current = generateDrizzleJson(schema);
      const statements = await generateMigration(
        emptyDrizzleSnapshot(current),
        current,
      );
      for (const statement of statements) {
        await generatedPool.query(
          statement.replaceAll('"public".', `"${generatedSchema}".`),
        );
      }
    });

    afterAll(async () => {
      await generatedPool.end();
      await fixture.admin.query(`DROP SCHEMA ${generatedSchema} CASCADE`);
      await fixture.close();
    });

    it("matches columns, defaults, constraints, references, checks, and indexes", async () => {
      const [migrated, generated] = await Promise.all([
        readCatalog(fixture.pool),
        readCatalog(generatedPool),
      ]);

      expect(migrated).toEqual(generated);
    });
  },
);
