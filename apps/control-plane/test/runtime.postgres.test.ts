import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneRuntime } from "../src/runtime.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("Control Plane runtime composition", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("keeps readiness closed until the reviewed migration set is current", async () => {
    let closes = 0;
    const runtime = createControlPlaneRuntime({
      config: {
        bootstrapOrganizationId: "org_runtime",
        bootstrapOrganizationName: "Runtime",
        bootstrapPairingToken: "bootstrap_runtime_secret",
        databaseUrl: TEST_DATABASE_URL!,
        environment: "local",
        githubIngressMasterSecret: null,
        host: "127.0.0.1",
        jobLeaseDurationMs: 30_000,
        jobPollIntervalMs: 1_000,
        jobRetryDelayMs: 30_000,
        poolMax: 4,
        port: 3000,
        publicOrigin: "http://127.0.0.1:3000",
        recoveryPairingToken: null,
        releaseSha: "local",
      },
      postgres: {
        pool: fixture.pool,
        async close() {
          closes += 1;
        },
      },
      migrations: fixture.migrations,
    });

    const before = await runtime.application.fetch(
      new Request("http://control.test/readyz"),
    );
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({
      status: "not_ready",
      reason: "migrations_pending",
    });

    await fixture.migrate();
    const after = await runtime.application.fetch(
      new Request("http://control.test/readyz"),
    );
    expect(after.status).toBe(200);
    await runtime.close();
    expect(closes).toBe(1);
  });
});
