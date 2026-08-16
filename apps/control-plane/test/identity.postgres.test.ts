import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createIdentityModule,
  createLoginThrottleKeyFactory,
} from "../src/modules/identity/index.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("Console identity PostgreSQL module", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let sessionNumber = 0;
  const clock = { now: () => new Date("2026-08-15T09:00:00.000Z") };
  const bearer = (label: string) => label.padEnd(48, "_");
  const throttleKeyFactory = createLoginThrottleKeyFactory("t".repeat(32));

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("provisions one owner without storing the password and issues hashed sessions", async () => {
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock,
      idFactory: (kind) => `${kind}_owner`,
      opaqueBearerFactory: () => bearer(`session_${++sessionNumber}`),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory,
    });
    await expect(
      identity.provisionOwner({
        organizationId: "org_console",
        organizationName: "Console",
        email: "owner@example.test",
        displayName: "Owner",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ kind: "created", operatorId: "operator_owner" });

    const login = await identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
    });
    expect(login).toMatchObject({
      kind: "authenticated",
      session: {
        token: bearer("session_1"),
        principal: {
          operatorId: "operator_owner",
          organizationId: "org_console",
          role: "owner",
        },
      },
    });
    if (login.kind !== "authenticated") throw new Error("login failed");
    await expect(identity.authenticateSession(login.session.token)).resolves.toEqual({
      kind: "authenticated",
      principal: login.session.principal,
    });

    const stored = await fixture.pool.query<{
      password_hash: string;
      token_hash: string;
    }>(
      `SELECT operator.password_hash, session.token_hash
       FROM cp_operator operator
       JOIN cp_session session USING (operator_id)
       WHERE operator.email = $1`,
      ["owner@example.test"],
    );
    expect(stored.rows[0]?.password_hash).not.toContain(
      "correct horse battery staple",
    );
    expect(stored.rows[0]?.token_hash).not.toContain(bearer("session_1"));
    const audit = await fixture.pool.query<{
      operation_kind: string;
      event: unknown;
    }>(
      `SELECT operation_kind, event
       FROM cp_management_audit_event
       WHERE organization_id = 'org_console'
       ORDER BY sequence_id`,
    );
    expect(audit.rows.map(({ operation_kind }) => operation_kind)).toEqual([
      "owner.provision",
      "session.create",
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(bearer("session_1"));
  });

  it("uses the same closed response for unknown email and wrong password", async () => {
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock,
      idFactory: (kind) => `${kind}_unused`,
      opaqueBearerFactory: () => bearer("unused"),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory,
    });
    await expect(
      identity.login({
        email: "missing@example.test",
        password: "wrong password value",
        networkKey: "test-network-missing",
      }),
    ).resolves.toEqual({ kind: "invalid_credential" });
    await expect(
      identity.login({
        email: "owner@example.test",
        password: "wrong password value",
        networkKey: "test-network-owner",
      }),
    ).resolves.toEqual({ kind: "invalid_credential" });
  });

  it("uses environment-keyed throttle identifiers and purges only expired rows", async () => {
    let now = new Date("2026-08-15T12:00:00.000Z");
    const keyedFactory = createLoginThrottleKeyFactory("a".repeat(32));
    const otherEnvironmentFactory = createLoginThrottleKeyFactory("b".repeat(32));
    const expiredEmail = "expired-throttle@example.test";
    const expiredKey = `email:${keyedFactory("email", expiredEmail)}`;
    expect(expiredKey).not.toBe(
      `email:${createHash("sha256").update(expiredEmail).digest("hex")}`,
    );
    expect(keyedFactory("email", expiredEmail)).not.toBe(
      otherEnvironmentFactory("email", expiredEmail),
    );

    const identity = createIdentityModule({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: (kind) => `${kind}_retention`,
      opaqueBearerFactory: () => bearer("session_retention"),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory: keyedFactory,
      loginRateLimit: {
        maxFailures: 3,
        windowMs: 1_000,
        lockoutMs: 2_000,
      },
    });
    await identity.login({
      email: expiredEmail,
      password: "wrong password value",
      networkKey: "retention-network-expired",
    });
    const activeKey = `network:${keyedFactory("network", "active-network")}`;
    await fixture.pool.query(
      `INSERT INTO cp_login_throttle(
         throttle_key, failure_count, window_started_at, locked_until, updated_at
       ) VALUES($1, 3, $2, $3, $2)`,
      [activeKey, now, new Date(now.getTime() + 60_000)],
    );

    now = new Date(now.getTime() + 5_000);
    await identity.login({
      email: "new-throttle@example.test",
      password: "wrong password value",
      networkKey: "retention-network-new",
    });
    const rows = await fixture.pool.query<{ throttle_key: string }>(
      "SELECT throttle_key FROM cp_login_throttle ORDER BY throttle_key",
    );
    expect(rows.rows.map(({ throttle_key }) => throttle_key)).not.toContain(
      expiredKey,
    );
    expect(rows.rows.map(({ throttle_key }) => throttle_key)).toContain(activeKey);
    expect(JSON.stringify(rows.rows)).not.toContain(expiredEmail);
    await fixture.pool.query("DELETE FROM cp_login_throttle");
  });

  it("rate limits both repeated network failures and repeated email failures", async () => {
    let sequence = 0;
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock,
      idFactory: (kind) => `${kind}_rate_${++sequence}`,
      opaqueBearerFactory: () => bearer(`session_rate_${++sequence}`),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory,
      loginRateLimit: {
        maxFailures: 2,
        windowMs: 60_000,
        lockoutMs: 120_000,
      },
    });

    for (const email of ["missing-one@example.test", "missing-two@example.test"]) {
      await expect(identity.login({
        email,
        password: "wrong password value",
        networkKey: "network-shared",
      })).resolves.toEqual({ kind: "invalid_credential" });
    }
    await expect(identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
      networkKey: "network-shared",
    })).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 120_000 });
    await expect(identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
      networkKey: "network-clean",
    })).resolves.toMatchObject({ kind: "authenticated" });

    for (const networkKey of ["network-email-one", "network-email-two"]) {
      await expect(identity.login({
        email: "owner@example.test",
        password: "wrong password value",
        networkKey,
      })).resolves.toEqual({ kind: "invalid_credential" });
    }
    await expect(identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
      networkKey: "network-email-three",
    })).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 120_000 });
    await fixture.pool.query("DELETE FROM cp_login_throttle");
  });

  it("does not let a valid account reset a shared network failure budget", async () => {
    let sequence = 0;
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock,
      idFactory: (kind) => `${kind}_network_budget_${++sequence}`,
      opaqueBearerFactory: () => bearer(`session_network_budget_${++sequence}`),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory,
      loginRateLimit: {
        maxFailures: 2,
        windowMs: 60_000,
        lockoutMs: 120_000,
      },
    });

    await expect(identity.login({
      email: "missing-network-one@example.test",
      password: "wrong password value",
      networkKey: "network-preserved",
    })).resolves.toEqual({ kind: "invalid_credential" });
    await expect(identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
      networkKey: "network-preserved",
    })).resolves.toMatchObject({ kind: "authenticated" });
    await expect(identity.login({
      email: "missing-network-two@example.test",
      password: "wrong password value",
      networkKey: "network-preserved",
    })).resolves.toEqual({ kind: "invalid_credential" });
    await expect(identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
      networkKey: "network-preserved",
    })).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 120_000 });
    await fixture.pool.query("DELETE FROM cp_login_throttle");
  });

  it("maps concurrent owner bootstrap email conflicts to a closed outcome", async () => {
    let operator = 0;
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock,
      idFactory: (kind) => `${kind}_bootstrap_race_${++operator}`,
      opaqueBearerFactory: () => bearer("unused_bootstrap_race"),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory,
    });
    const provision = (organizationId: string) => identity.provisionOwner({
      organizationId,
      organizationName: organizationId,
      email: "bootstrap-race@example.test",
      displayName: "Bootstrap race",
      password: "correct horse battery staple",
    });

    const outcomes = await Promise.all([
      provision("org_bootstrap_race_a"),
      provision("org_bootstrap_race_b"),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "conflict",
      "created",
    ]);
  });

  it("rejects factories that do not issue sufficiently long opaque bearer material", async () => {
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock,
      idFactory: (kind) => `${kind}_weak_bearer`,
      opaqueBearerFactory: () => "predictable",
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory,
    });

    await expect(identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
    })).rejects.toThrow("invalid_opaque_bearer_material");
    const sessions = await fixture.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cp_session WHERE session_id = 'session_weak_bearer'",
    );
    expect(sessions.rows[0]?.count).toBe("0");
  });

  it("binds every browser session to one explicit tenant", async () => {
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock,
      idFactory: (kind) => `${kind}_tenant_bound`,
      opaqueBearerFactory: () => bearer("session_tenant_bound"),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory,
    });
    await fixture.pool.query(
      `INSERT INTO cp_organization(organization_id, display_name)
       VALUES('org_console_secondary', 'Secondary')`,
    );
    await fixture.pool.query(
      `INSERT INTO cp_membership(
         organization_id, operator_id, role, created_at
       ) VALUES('org_console_secondary', 'operator_owner', 'viewer', $1)`,
      [clock.now()],
    );

    await expect(identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
    })).resolves.toEqual({ kind: "organization_required" });

    const login = await identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
      organizationId: "org_console_secondary",
    });
    expect(login).toMatchObject({
      kind: "authenticated",
      session: {
        principal: {
          organizationId: "org_console_secondary",
          role: "viewer",
        },
      },
    });
    if (login.kind !== "authenticated") throw new Error("login failed");

    await fixture.pool.query(
      `INSERT INTO cp_organization(organization_id, display_name)
       VALUES('aaa_console_other', 'Other')`,
    );
    await fixture.pool.query(
      `INSERT INTO cp_membership(
         organization_id, operator_id, role, created_at
       ) VALUES('aaa_console_other', 'operator_owner', 'admin', $1)`,
      [clock.now()],
    );
    await expect(identity.authenticateSession(login.session.token)).resolves.toEqual({
      kind: "authenticated",
      principal: login.session.principal,
    });

    await fixture.pool.query(
      "DELETE FROM cp_session WHERE session_id = 'session_tenant_bound'",
    );
    await fixture.pool.query(
      `DELETE FROM cp_membership
       WHERE operator_id = 'operator_owner'
         AND organization_id IN ('org_console_secondary', 'aaa_console_other')`,
    );
    await fixture.pool.query(
      `DELETE FROM cp_management_audit_event
       WHERE organization_id IN ('org_console_secondary', 'aaa_console_other')`,
    );
    await fixture.pool.query(
      `DELETE FROM cp_organization
       WHERE organization_id IN ('org_console_secondary', 'aaa_console_other')`,
    );
  });

  it("revokes a session without affecting another tenant authority", async () => {
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock,
      idFactory: (kind) => `${kind}_second`,
      opaqueBearerFactory: () => bearer("session_second"),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory,
    });
    const login = await identity.login({
      email: "owner@example.test",
      password: "correct horse battery staple",
    });
    if (login.kind !== "authenticated") throw new Error("login failed");
    await identity.logout(login.session.token);
    await expect(identity.authenticateSession(login.session.token)).resolves.toEqual({
      kind: "invalid_credential",
    });
  });

  it("issues one-time tenant API-key material and enforces administrative roles", async () => {
    let tokenNumber = 0;
    const identity = createIdentityModule({
      pool: fixture.pool,
      clock,
      idFactory: (kind) => `${kind}_machine`,
      opaqueBearerFactory: () => bearer(`api_key_${++tokenNumber}`),
      sessionDurationMs: 8 * 60 * 60 * 1_000,
      throttleKeyFactory,
    });
    const owner = {
      operatorId: "operator_owner",
      organizationId: "org_console",
      role: "owner" as const,
      email: "owner@example.test",
      displayName: "Owner",
    };

    const created = await identity.createApiKey(owner, {
      label: "automation",
      scopes: ["permission:resolve", "run:read", "runner:read"],
    });
    expect(created).toEqual({
      apiKey: expect.objectContaining({
        apiKeyId: "api_key_machine",
        label: "automation",
        scopes: ["permission:resolve", "run:read", "runner:read"],
      }),
      token: bearer("api_key_1"),
    });
    expect(JSON.stringify(await identity.listApiKeys(owner))).not.toContain(
      bearer("api_key_1"),
    );
    await expect(identity.authenticateApiKey(bearer("api_key_1"))).resolves.toEqual({
      kind: "authenticated",
      principal: {
        apiKeyId: "api_key_machine",
        organizationId: "org_console",
        scopes: ["permission:resolve", "run:read", "runner:read"],
      },
    });

    await identity.revokeApiKey(owner, "api_key_machine");
    await expect(identity.authenticateApiKey(bearer("api_key_1"))).resolves.toEqual({
      kind: "invalid_credential",
    });
    const audit = await fixture.pool.query<{ operation_kind: string }>(
      `SELECT operation_kind FROM cp_management_audit_event
       WHERE organization_id = 'org_console'
         AND resource_id = 'api_key_machine'
       ORDER BY sequence_id`,
    );
    expect(audit.rows.map(({ operation_kind }) => operation_kind)).toEqual([
      "api_key.create",
      "api_key.revoke",
    ]);
    await expect(
      identity.createApiKey({ ...owner, role: "viewer" }, {
        label: "forbidden",
        scopes: ["run:read"],
      }),
    ).rejects.toThrow("forbidden_action");
  });
});
