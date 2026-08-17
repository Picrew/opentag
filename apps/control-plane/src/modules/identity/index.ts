import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { withPostgresTransaction } from "../../database/postgres.js";
import { recordManagementAudit } from "../audit/index.js";

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_BYTES = 64;
const MINIMUM_OPAQUE_BEARER_LENGTH = 43;
const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = Buffer.alloc(PASSWORD_KEY_BYTES).toString("hex");

type Clock = { now(): Date };
type IdentityId = "api_key" | "operator" | "session";
type ConsoleRole = "owner" | "admin" | "operator" | "viewer";
type LoginRateLimit = {
  maxFailures: number;
  networkMaxFailures: number;
  windowMs: number;
  lockoutMs: number;
};
type LoginThrottleKind = "email" | "network";
type LoginThrottleKeyFactory = (
  kind: LoginThrottleKind,
  normalizedValue: string,
) => string;
type LoginThrottleRow = {
  throttle_key: string;
  failure_count: number;
  window_started_at: Date;
  locked_until: Date | null;
};
const API_KEY_SCOPES = new Set([
  "audit:read",
  "permission:resolve",
  "run:read",
  "runner:read",
  "target:read",
]);

export type ConsolePrincipal = {
  operatorId: string;
  organizationId: string;
  role: ConsoleRole;
  email: string;
  displayName: string;
};

function requireAdministrator(principal: ConsolePrincipal): void {
  if (principal.role !== "owner" && principal.role !== "admin") {
    throw new Error("forbidden_action");
  }
}

function digestOpaqueBearer(bearer: string): string {
  return createHash("sha256").update(bearer, "utf8").digest("hex");
}

export function createLoginThrottleKeyFactory(
  secret: string,
): LoginThrottleKeyFactory {
  if (secret.length < 32 || secret.length > 4096 || secret !== secret.trim()) {
    throw new Error("invalid_login_throttle_secret");
  }
  return (kind, normalizedValue) => createHmac("sha256", secret)
    .update(JSON.stringify([
      "opentag.control.login-throttle/v1",
      kind,
      normalizedValue,
    ]))
    .digest("base64url");
}

function isOperatorEmailConflict(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505"
    && "constraint" in error
    && error.constraint === "cp_operator_email_key";
}

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, PASSWORD_KEY_BYTES) as Buffer;
  return `scrypt$v1$${salt}$${key.toString("hex")}`;
}

async function passwordMatches(password: string, encoded: string | null): Promise<boolean> {
  const parts = encoded?.split("$") ?? [];
  const validEncoding = parts.length === 4
    && parts[0] === "scrypt"
    && parts[1] === "v1"
    && /^[a-f0-9]{32}$/u.test(parts[2] ?? "")
    && /^[a-f0-9]{128}$/u.test(parts[3] ?? "");
  const salt = validEncoding ? (parts[2] ?? DUMMY_SALT) : DUMMY_SALT;
  const expected = Buffer.from(
    validEncoding ? (parts[3] ?? DUMMY_HASH) : DUMMY_HASH,
    "hex",
  );
  const actual = await scrypt(password, salt, PASSWORD_KEY_BYTES) as Buffer;
  return validEncoding && timingSafeEqual(actual, expected);
}

export function createIdentityModule(input: {
  pool: Pool;
  clock: Clock;
  idFactory(kind: IdentityId): string;
  opaqueBearerFactory(kind: "api_key" | "session"): string;
  sessionDurationMs: number;
  throttleKeyFactory: LoginThrottleKeyFactory;
  loginRateLimit?: LoginRateLimit;
}) {
  const loginRateLimit = input.loginRateLimit ?? {
    maxFailures: 5,
    networkMaxFailures: 50,
    windowMs: 300_000,
    lockoutMs: 900_000,
  };
  const throttleRetentionMs = Math.max(
    loginRateLimit.windowMs,
    loginRateLimit.lockoutMs,
  ) * 2;

  function issueOpaqueBearer(kind: "api_key" | "session"): string {
    const bearer = input.opaqueBearerFactory(kind);
    if (
      bearer.length < MINIMUM_OPAQUE_BEARER_LENGTH
      || bearer.length > 4096
      || bearer !== bearer.trim()
    ) {
      throw new Error("invalid_opaque_bearer_material");
    }
    return bearer;
  }

  return {
    async provisionOwner(command: {
      organizationId: string;
      organizationName: string;
      email: string;
      displayName: string;
      password: string;
    }): Promise<
      | { kind: "created" | "replayed"; operatorId: string }
      | { kind: "conflict" }
    > {
      if (command.password.length < 12 || command.password.length > 1024) {
        throw new Error("invalid_password_policy");
      }
      const email = command.email.trim().toLowerCase();
      if (!email || !email.includes("@")) throw new Error("invalid_email");
      const encodedPassword = await passwordHash(command.password);
      try {
        return await withPostgresTransaction(input.pool, async (client) => {
          await client.query(
            `INSERT INTO cp_organization(organization_id, display_name)
             VALUES($1, $2)
             ON CONFLICT (organization_id) DO NOTHING`,
            [command.organizationId, command.organizationName],
          );
          await client.query(
            "SELECT organization_id FROM cp_organization WHERE organization_id = $1 FOR UPDATE",
            [command.organizationId],
          );
          const existing = await client.query(
            "SELECT operator_id FROM cp_operator WHERE email = $1 FOR UPDATE",
            [email],
          ) as { rows: Array<{ operator_id: string }> };
          const row = existing.rows[0];
          if (row) {
            const membership = await client.query(
              `SELECT role FROM cp_membership
               WHERE organization_id = $1 AND operator_id = $2`,
              [command.organizationId, row.operator_id],
            ) as { rows: Array<{ role: string }> };
            return membership.rows[0]?.role === "owner"
              ? { kind: "replayed", operatorId: row.operator_id } as const
              : { kind: "conflict" } as const;
          }
          const operatorId = input.idFactory("operator");
          const createdAt = input.clock.now().toISOString();
          await client.query(
            `INSERT INTO cp_operator(
               operator_id, email, display_name, password_hash, created_at
             ) VALUES($1, $2, $3, $4, $5)`,
            [operatorId, email, command.displayName, encodedPassword, createdAt],
          );
          await client.query(
            `INSERT INTO cp_membership(
               organization_id, operator_id, role, created_at
             ) VALUES($1, $2, 'owner', $3)`,
            [command.organizationId, operatorId, createdAt],
          );
          await recordManagementAudit(client, {
            organizationId: command.organizationId,
            actor: { kind: "bootstrap", id: operatorId },
            operationKind: "owner.provision",
            resource: { kind: "operator", id: operatorId },
            outcome: "created",
            event: { role: "owner" },
            createdAt,
          });
          return { kind: "created", operatorId } as const;
        });
      } catch (error) {
        if (isOperatorEmailConflict(error)) return { kind: "conflict" };
        throw error;
      }
    },

    async login(command: {
      email: string;
      password: string;
      organizationId?: string;
      networkKey?: string;
    }) {
      const email = command.email.trim().toLowerCase();
      const organizationId = command.organizationId?.trim() || null;
      const suppliedNetworkKey = command.networkKey?.trim();
      if (suppliedNetworkKey && suppliedNetworkKey.length > 512) {
        throw new Error("invalid_network_key");
      }
      const emailThrottleKey = `email:${input.throttleKeyFactory("email", email)}`;
      const networkThrottleKey = suppliedNetworkKey
        ? `network:${input.throttleKeyFactory("network", suppliedNetworkKey)}`
        : null;
      const throttleKeys = [
        emailThrottleKey,
        ...(networkThrottleKey ? [networkThrottleKey] : []),
      ].sort();
      return withPostgresTransaction(input.pool, async (client) => {
        const now = input.clock.now();
        const retentionCutoff = new Date(now.getTime() - throttleRetentionMs);
        await client.query(
          `DELETE FROM cp_login_throttle
           WHERE throttle_key IN (
             SELECT throttle_key
             FROM cp_login_throttle
             WHERE updated_at < $1
               AND (locked_until IS NULL OR locked_until <= $2)
             ORDER BY updated_at
             LIMIT 1000
             FOR UPDATE SKIP LOCKED
           )`,
          [retentionCutoff, now],
        );
        for (const throttleKey of throttleKeys) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [
              JSON.stringify([
                "opentag.control.console-login-throttle/v1",
                throttleKey,
              ]),
            ],
          );
        }
        const throttles = await client.query<LoginThrottleRow>(
          `SELECT throttle_key, failure_count, window_started_at, locked_until
           FROM cp_login_throttle
           WHERE throttle_key = ANY($1::text[])
           FOR UPDATE`,
          [throttleKeys],
        );
        const retryAfterMs = throttles.rows.reduce((remaining, throttle) => {
          const retry = throttle.locked_until
            ? throttle.locked_until.getTime() - now.getTime()
            : 0;
          return Math.max(remaining, retry);
        }, 0);
        if (retryAfterMs > 0) {
          return {
            kind: "rate_limited",
            retryAfterMs: Math.max(1, retryAfterMs),
          } as const;
        }
        const result = await client.query<{
          operator_id: string;
          password_hash: string | null;
          organization_id: string;
          role: ConsoleRole;
          display_name: string;
        }>(
          `SELECT operator.operator_id, operator.password_hash,
                  operator.display_name, membership.organization_id,
                  membership.role
           FROM cp_operator operator
           JOIN cp_membership membership USING (operator_id)
           WHERE operator.email = $1 AND operator.disabled_at IS NULL
             AND ($2::text IS NULL OR membership.organization_id = $2)
           ORDER BY membership.organization_id
           LIMIT 2`,
          [email, organizationId],
        );
        const row = result.rows[0];
        if (!(await passwordMatches(command.password, row?.password_hash ?? null)) || !row) {
          const storedByKey = new Map(
            throttles.rows.map((throttle) => [throttle.throttle_key, throttle]),
          );
          for (const throttleKey of throttleKeys) {
            const stored = storedByKey.get(throttleKey);
            const withinWindow = stored
              && now.getTime() - stored.window_started_at.getTime()
                < loginRateLimit.windowMs;
            const failureCount = withinWindow
              ? stored.failure_count + 1
              : 1;
            const windowStartedAt = withinWindow
              ? stored.window_started_at
              : now;
            const maxFailures = throttleKey === networkThrottleKey
              ? loginRateLimit.networkMaxFailures
              : loginRateLimit.maxFailures;
            const lockedUntil = failureCount >= maxFailures
              ? new Date(now.getTime() + loginRateLimit.lockoutMs)
              : null;
            await client.query(
              `INSERT INTO cp_login_throttle(
                 throttle_key, failure_count, window_started_at,
                 locked_until, updated_at
               ) VALUES($1, $2, $3, $4, $5)
               ON CONFLICT (throttle_key) DO UPDATE SET
                 failure_count = EXCLUDED.failure_count,
                 window_started_at = EXCLUDED.window_started_at,
                 locked_until = EXCLUDED.locked_until,
                 updated_at = EXCLUDED.updated_at`,
              [throttleKey, failureCount, windowStartedAt, lockedUntil, now],
            );
          }
          return { kind: "invalid_credential" } as const;
        }
        await client.query(
          "DELETE FROM cp_login_throttle WHERE throttle_key = $1",
          [emailThrottleKey],
        );
        if (organizationId === null && result.rows.length > 1) {
          return { kind: "organization_required" } as const;
        }
        const sessionId = input.idFactory("session");
        const bearer = issueOpaqueBearer("session");
        const createdAt = now;
        const expiresAt = new Date(createdAt.getTime() + input.sessionDurationMs);
        const principal: ConsolePrincipal = {
          operatorId: row.operator_id,
          organizationId: row.organization_id,
          role: row.role,
          email,
          displayName: row.display_name,
        };
        await client.query(
          `INSERT INTO cp_session(
             session_id, organization_id, operator_id, token_hash, expires_at,
             created_at
           ) VALUES($1, $2, $3, $4, $5, $6)`,
          [
            sessionId,
            row.organization_id,
            row.operator_id,
            digestOpaqueBearer(bearer),
            expiresAt,
            createdAt,
          ],
        );
        await recordManagementAudit(client, {
          organizationId: row.organization_id,
          actor: { kind: "operator", id: row.operator_id },
          operationKind: "session.create",
          resource: { kind: "session", id: sessionId },
          outcome: "created",
          createdAt,
        });
        return {
          kind: "authenticated",
          session: {
            token: bearer,
            expiresAt: expiresAt.toISOString(),
            principal,
          },
        } as const;
      });
    },

    async authenticateSession(presentedBearer: string) {
      if (!presentedBearer || presentedBearer !== presentedBearer.trim()) {
        return { kind: "invalid_credential" } as const;
      }
      const result = await input.pool.query<{
        operator_id: string;
        organization_id: string;
        role: ConsoleRole;
        email: string;
        display_name: string;
      }>(
        `SELECT operator.operator_id, membership.organization_id,
                membership.role, operator.email, operator.display_name
         FROM cp_session session
         JOIN cp_operator operator USING (operator_id)
         JOIN cp_membership membership
           ON membership.organization_id = session.organization_id
          AND membership.operator_id = session.operator_id
         WHERE session.token_hash = $1
           AND session.revoked_at IS NULL
           AND session.expires_at > $2
           AND operator.disabled_at IS NULL
         LIMIT 1`,
        [digestOpaqueBearer(presentedBearer), input.clock.now()],
      );
      const row = result.rows[0];
      return row
        ? {
            kind: "authenticated",
            principal: {
              operatorId: row.operator_id,
              organizationId: row.organization_id,
              role: row.role,
              email: row.email,
              displayName: row.display_name,
            } satisfies ConsolePrincipal,
          } as const
        : { kind: "invalid_credential" } as const;
    },

    async logout(presentedBearer: string): Promise<void> {
      await withPostgresTransaction(input.pool, async (client) => {
        const revokedAt = input.clock.now();
        const result = await client.query<{
          organization_id: string;
          operator_id: string;
          session_id: string;
        }>(
          `UPDATE cp_session SET revoked_at = $2
           WHERE token_hash = $1 AND revoked_at IS NULL
           RETURNING organization_id, operator_id, session_id`,
          [digestOpaqueBearer(presentedBearer), revokedAt],
        );
        const session = result.rows[0];
        if (session) {
          await recordManagementAudit(client, {
            organizationId: session.organization_id,
            actor: { kind: "operator", id: session.operator_id },
            operationKind: "session.revoke",
            resource: { kind: "session", id: session.session_id },
            outcome: "revoked",
            createdAt: revokedAt,
          });
        }
      });
    },

    async createApiKey(
      principal: ConsolePrincipal,
      command: { label: string; scopes: string[] },
    ) {
      requireAdministrator(principal);
      const label = command.label.trim();
      const scopes = [...new Set(command.scopes)];
      if (
        !label
        || label.length > 100
        || scopes.length < 1
        || scopes.length > API_KEY_SCOPES.size
        || scopes.some((scope) => !API_KEY_SCOPES.has(scope))
      ) {
        throw new Error("invalid_api_key_request");
      }
      const apiKeyId = input.idFactory("api_key");
      const bearer = issueOpaqueBearer("api_key");
      const createdAt = input.clock.now();
      await withPostgresTransaction(input.pool, async (client) => {
        await client.query(
          `INSERT INTO cp_api_key(
             api_key_id, organization_id, label, token_hash, scope,
             created_by, created_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7)`,
          [
            apiKeyId,
            principal.organizationId,
            label,
            digestOpaqueBearer(bearer),
            scopes,
            principal.operatorId,
            createdAt,
          ],
        );
        await recordManagementAudit(client, {
          organizationId: principal.organizationId,
          actor: { kind: "operator", id: principal.operatorId },
          operationKind: "api_key.create",
          resource: { kind: "api_key", id: apiKeyId },
          outcome: "created",
          event: { label, scopes },
          createdAt,
        });
      });
      return {
        apiKey: {
          apiKeyId,
          label,
          scopes,
          createdAt: createdAt.toISOString(),
          revokedAt: null,
        },
        token: bearer,
      };
    },

    async listApiKeys(principal: ConsolePrincipal) {
      const result = await input.pool.query<{
        api_key_id: string;
        label: string;
        scope: string[];
        created_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT api_key_id, label, scope, created_at, revoked_at
         FROM cp_api_key
         WHERE organization_id = $1
         ORDER BY created_at DESC, api_key_id`,
        [principal.organizationId],
      );
      return result.rows.map((row) => ({
        apiKeyId: row.api_key_id,
        label: row.label,
        scopes: row.scope,
        createdAt: row.created_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
      }));
    },

    async revokeApiKey(
      principal: ConsolePrincipal,
      apiKeyId: string,
    ): Promise<void> {
      requireAdministrator(principal);
      await withPostgresTransaction(input.pool, async (client) => {
        const revokedAt = input.clock.now();
        const result = await client.query(
          `UPDATE cp_api_key SET revoked_at = $3
           WHERE organization_id = $1 AND api_key_id = $2 AND revoked_at IS NULL
           RETURNING api_key_id`,
          [principal.organizationId, apiKeyId, revokedAt],
        );
        if (result.rowCount === 1) {
          await recordManagementAudit(client, {
            organizationId: principal.organizationId,
            actor: { kind: "operator", id: principal.operatorId },
            operationKind: "api_key.revoke",
            resource: { kind: "api_key", id: apiKeyId },
            outcome: "revoked",
            createdAt: revokedAt,
          });
        }
      });
    },

    async authenticateApiKey(presentedBearer: string) {
      if (!presentedBearer || presentedBearer !== presentedBearer.trim()) {
        return { kind: "invalid_credential" } as const;
      }
      const result = await input.pool.query<{
        api_key_id: string;
        organization_id: string;
        scope: string[];
      }>(
        `SELECT api_key_id, organization_id, scope
         FROM cp_api_key
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [digestOpaqueBearer(presentedBearer)],
      );
      const row = result.rows[0];
      return row
        ? {
            kind: "authenticated",
            principal: {
              apiKeyId: row.api_key_id,
              organizationId: row.organization_id,
              scopes: row.scope,
            },
          } as const
        : { kind: "invalid_credential" } as const;
    },
  };
}

export type IdentityModule = ReturnType<typeof createIdentityModule>;
