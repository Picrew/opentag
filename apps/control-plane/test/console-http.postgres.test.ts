import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";
import { createConsoleReadModel } from "../src/modules/console-reads/index.js";
import {
  createIdentityModule,
  createLoginThrottleKeyFactory,
} from "../src/modules/identity/index.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("same-origin console HTTP identity", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let identityNumber = 0;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("sets an HTTP-only session, scopes reads, and enforces mutation origin", async () => {
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T11:00:00.000Z") },
      idFactory: (kind) => `${kind}_http_${++identityNumber}`,
      opaqueBearerFactory: (kind) => `console_${kind}_bearer_material`.padEnd(48, "_"),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory: createLoginThrottleKeyFactory("t".repeat(32)),
    });
    await identity.provisionOwner({
      organizationId: "org_console_http",
      organizationName: "Console HTTP",
      email: "owner-http@example.test",
      displayName: "HTTP owner",
      password: "correct horse battery staple",
    });
    const runnerDirectory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T11:00:00.000Z") },
      idFactory: () => "credential_console_http",
      tokenFactory: () => "runtime_console_http_secret",
    });
    await runnerDirectory.register({
      organizationId: "org_console_http",
      organizationName: "Console HTTP",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_console_http_runner",
        operationId: "operation_console_http_runner",
        runnerId: "runner_console_http",
        capabilities: ["relay.readiness.v1"],
      },
    });
    const application = createControlPlaneApplication({
      capabilities: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1",
        capabilities: [],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "local", releaseSha: "local" },
      },
      readiness: { check: async () => ({ ready: true }) },
      console: {
        identity,
        reads: createConsoleReadModel({ pool: fixture.pool }),
        publicOrigin: "http://control.test",
        targets: runnerDirectory,
      },
    });

    const login = await application.fetch(
      new Request("http://control.test/api/console/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://control.test",
        },
        body: JSON.stringify({
          email: "owner-http@example.test",
          password: "correct horse battery staple",
        }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toMatch(/opentag_session=.*HttpOnly.*SameSite=Strict/iu);
    expect(cookie).not.toMatch(/correct horse/iu);

    const session = await application.fetch(
      new Request("http://control.test/api/console/session", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      principal: {
        organizationId: "org_console_http",
        role: "owner",
      },
    });

    const forbiddenLogout = await application.fetch(
      new Request("http://control.test/api/console/session", {
        method: "DELETE",
        headers: {
          cookie: cookie?.split(";")[0] ?? "",
          origin: "https://attacker.test",
        },
      }),
    );
    expect(forbiddenLogout.status).toBe(403);

    const runners = await application.fetch(
      new Request("http://control.test/api/console/runners", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(runners.status).toBe(200);
    expect(await runners.json()).toMatchObject({
      runners: [{ runnerId: "runner_console_http" }],
    });

    const targets = await application.fetch(
      new Request("http://control.test/api/console/project-targets", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(targets.status).toBe(200);
    expect(await targets.json()).toEqual({ bindings: [], targets: [] });

    const evidence = await application.fetch(
      new Request("http://control.test/api/console/evidence", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toEqual({
      materialActions: [],
      permissions: [],
    });

    const createdTarget = await application.fetch(
      new Request("http://control.test/api/console/project-targets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookie?.split(";")[0] ?? "",
          origin: "http://control.test",
        },
        body: JSON.stringify({
          projectTargetId: "target_console_http",
          runnerId: "runner_console_http",
          bindingDigest: `sha256:${"a".repeat(64)}`,
          provider: "github",
          owner: "amplifthq",
          repo: "opentag",
          defaultExecutor: "codex",
          defaultBranch: "main",
          version: 1,
        }),
      }),
    );
    expect(createdTarget.status).toBe(201);

    const targetsAfterCreate = await application.fetch(
      new Request("http://control.test/api/console/project-targets", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(await targetsAfterCreate.json()).toMatchObject({
      targets: [{
        projectTargetId: "target_console_http",
        runnerId: "runner_console_http",
        owner: "amplifthq",
        repo: "opentag",
      }],
    });

    const createdKey = await application.fetch(
      new Request("http://control.test/api/console/api-keys", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookie?.split(";")[0] ?? "",
          origin: "http://control.test",
        },
        body: JSON.stringify({ label: "operator", scopes: ["run:read"] }),
      }),
    );
    expect(createdKey.status).toBe(201);
    expect(await createdKey.json()).toMatchObject({
      apiKey: { label: "operator", scopes: ["run:read"] },
      token: "console_api_key_bearer_material".padEnd(48, "_"),
    });

    const listedKeys = await application.fetch(
      new Request("http://control.test/api/console/api-keys", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(listedKeys.status).toBe(200);
    expect(JSON.stringify(await listedKeys.json())).not.toContain(
      "console_api_key_secret",
    );

    const forbiddenKeyCreation = await application.fetch(
      new Request("http://control.test/api/console/api-keys", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookie?.split(";")[0] ?? "",
          origin: "https://attacker.test",
        },
        body: JSON.stringify({ label: "forbidden", scopes: ["run:read"] }),
      }),
    );
    expect(forbiddenKeyCreation.status).toBe(403);
  });
});
