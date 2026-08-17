import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseAdminBootstrapConfig,
  parseControlPlaneConfig,
} from "../src/config.js";

describe("Control Plane configuration", () => {
  it("parses a bounded local Node/PostgreSQL configuration", () => {
    expect(
      parseControlPlaneConfig({
        DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
        OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
        OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
        OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
        OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
      }),
    ).toEqual({
      bootstrapOrganizationId: "org_local",
      bootstrapOrganizationName: "Local OpenTag",
      bootstrapPairingToken: "bootstrap_secret",
      recoveryPairingToken: null,
      databaseUrl: "postgresql://opentag:secret@postgres:5432/opentag",
      environment: "local",
      fencingTokenSecret: "bootstrap_secret",
      githubIngressMasterSecret: null,
      host: "0.0.0.0",
      jobLeaseDurationMs: 30_000,
      jobPollIntervalMs: 1_000,
      jobRetryDelayMs: 30_000,
      loginRateLimit: {
        secret: createHash("sha256").update(JSON.stringify([
          "opentag.control.local-login-throttle-secret/v1",
          "bootstrap_secret",
        ])).digest("hex"),
        networkMode: "direct-peer",
        maxFailures: 5,
        networkMaxFailures: 50,
        windowMs: 300_000,
        lockoutMs: 900_000,
      },
      poolMax: 10,
      port: 3000,
      publicOrigin: "http://127.0.0.1:3000",
      releaseSha: "local",
    });
  });

  it("requires HTTPS and an immutable release identity outside local development", () => {
    expect(() =>
      parseControlPlaneConfig({
        DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
        OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
        OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
        OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
        OPENTAG_FENCING_TOKEN_SECRET: "f".repeat(32),
        OPENTAG_LOGIN_THROTTLE_SECRET: "l".repeat(32),
        OPENTAG_ENVIRONMENT: "production",
        OPENTAG_PUBLIC_URL: "http://control.example.test",
        OPENTAG_RELEASE_SHA: "local",
      }),
    ).toThrow(/configuration_invalid/iu);

    expect(
      parseControlPlaneConfig({
        DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
        OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
        OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
        OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
        OPENTAG_FENCING_TOKEN_SECRET: "f".repeat(32),
        OPENTAG_LOGIN_THROTTLE_SECRET: "l".repeat(32),
        OPENTAG_ENVIRONMENT: "production",
        OPENTAG_PUBLIC_URL: "https://control.example.test",
        OPENTAG_RELEASE_SHA: "a".repeat(40),
      }).releaseSha,
    ).toBe("a".repeat(40));
    expect(() => parseControlPlaneConfig({
      DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
      OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
      OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
      OPENTAG_ENVIRONMENT: "production",
      OPENTAG_PUBLIC_URL: "https://control.example.test",
      OPENTAG_RELEASE_SHA: "a".repeat(40),
    })).toThrow("configuration_invalid");
  });

  it("requires independent login-throttle authority and supports trusted-edge mode", () => {
    const base = {
      DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
      OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
      OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "b".repeat(32),
      OPENTAG_FENCING_TOKEN_SECRET: "f".repeat(32),
      OPENTAG_ENVIRONMENT: "production",
      OPENTAG_PUBLIC_URL: "https://control.example.test",
      OPENTAG_RELEASE_SHA: "a".repeat(40),
    };
    expect(() => parseControlPlaneConfig(base)).toThrow("configuration_invalid");
    expect(() => parseControlPlaneConfig({
      ...base,
      OPENTAG_LOGIN_THROTTLE_SECRET: "f".repeat(32),
    })).toThrow("configuration_invalid");
    expect(parseControlPlaneConfig({
      ...base,
      OPENTAG_LOGIN_THROTTLE_SECRET: "l".repeat(32),
      OPENTAG_LOGIN_NETWORK_THROTTLE_MODE: "trusted-edge",
    }).loginRateLimit).toMatchObject({
      secret: "l".repeat(32),
      networkMode: "trusted-edge",
    });
  });

  it("requires independent fencing-token authority outside local", () => {
    const base = {
      DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
      OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
      OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "b".repeat(32),
      OPENTAG_LOGIN_THROTTLE_SECRET: "l".repeat(32),
      OPENTAG_ENVIRONMENT: "production",
      OPENTAG_PUBLIC_URL: "https://control.example.test",
      OPENTAG_RELEASE_SHA: "a".repeat(40),
    };
    expect(() => parseControlPlaneConfig({
      ...base,
      OPENTAG_FENCING_TOKEN_SECRET: "b".repeat(32),
    })).toThrow("configuration_invalid");
    expect(() => parseControlPlaneConfig({
      ...base,
      OPENTAG_RECOVERY_PAIRING_TOKEN: "r".repeat(32),
      OPENTAG_FENCING_TOKEN_SECRET: "r".repeat(32),
    })).toThrow("configuration_invalid");
    expect(() => parseControlPlaneConfig({
      ...base,
      OPENTAG_GITHUB_INGRESS_MASTER_SECRET: "g".repeat(32),
      OPENTAG_FENCING_TOKEN_SECRET: "g".repeat(32),
    })).toThrow("configuration_invalid");
    expect(parseControlPlaneConfig({
      ...base,
      OPENTAG_FENCING_TOKEN_SECRET: "f".repeat(32),
    }).fencingTokenSecret).toBe("f".repeat(32));
    expect(parseControlPlaneConfig({
      DATABASE_URL: base.DATABASE_URL,
      OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
      OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "b".repeat(32),
      OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
    }).fencingTokenSecret).toBe("b".repeat(32));
  });

  it("rejects unchanged .env.example placeholder secrets", () => {
    const base = {
      DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
      OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
      OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
      OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
    };
    for (const placeholder of [
      { OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "replace-with-at-least-16-random-characters" },
      { OPENTAG_RECOVERY_PAIRING_TOKEN: "replace-with-a-different-at-least-16-character-secret" },
      { OPENTAG_FENCING_TOKEN_SECRET: "replace-with-at-least-32-independent-random-characters" },
      { OPENTAG_LOGIN_THROTTLE_SECRET: "replace-with-a-different-at-least-32-character-secret" },
      { OPENTAG_GITHUB_INGRESS_MASTER_SECRET: "replace-with-at-least-32-more-random-characters" },
    ]) {
      expect(() => parseControlPlaneConfig({ ...base, ...placeholder }))
        .toThrow("configuration_invalid");
    }
    expect(() =>
      parseAdminBootstrapConfig({
        OPENTAG_BOOTSTRAP_ADMIN_EMAIL: "owner@example.test",
        OPENTAG_BOOTSTRAP_ADMIN_NAME: "OpenTag Owner",
        OPENTAG_BOOTSTRAP_ADMIN_PASSWORD: "replace-with-a-long-random-password",
      }),
    ).toThrow("configuration_invalid");
    expect(() => parseControlPlaneConfig({
      ...base,
      DATABASE_URL:
        "postgresql://opentag:replace-with-a-random-database-password@postgres:5432/opentag",
    })).toThrow("configuration_invalid");
  });

  it("keeps the network login budget separate from the email budget", () => {
    const base = {
      DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
      OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
      OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
      OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
    };
    expect(parseControlPlaneConfig({
      ...base,
      OPENTAG_LOGIN_MAX_FAILURES: "3",
      OPENTAG_LOGIN_NETWORK_MAX_FAILURES: "200",
    }).loginRateLimit).toMatchObject({
      maxFailures: 3,
      networkMaxFailures: 200,
    });
    expect(() => parseControlPlaneConfig({
      ...base,
      OPENTAG_LOGIN_NETWORK_MAX_FAILURES: "0",
    })).toThrow("configuration_invalid");
  });

  it("rejects invalid database and public origins without echoing credentials", () => {
    const databaseSecret = "database-password-canary";
    const originSecret = "origin-password-canary";

    for (const input of [
      {
        DATABASE_URL: `sqlite://${databaseSecret}@local.db`,
        OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
        OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
        OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
        OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
      },
      {
        DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
        OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
        OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
        OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
        OPENTAG_PUBLIC_URL: `https://operator:${originSecret}@control.example.test`,
      },
    ]) {
      let message = "";
      try {
        parseControlPlaneConfig(input);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/configuration_invalid/iu);
      expect(message).not.toContain(databaseSecret);
      expect(message).not.toContain(originSecret);
    }
  });

  it("enforces bounded integer port and pool settings", () => {
    expect(() =>
      parseControlPlaneConfig({
        DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
        OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
        OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
        OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
        OPENTAG_DB_POOL_MAX: "0",
        OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
      }),
    ).toThrow(/configuration_invalid/iu);
    expect(() =>
      parseControlPlaneConfig({
        DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
        OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
        OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
        OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
        OPENTAG_PORT: "70000",
        OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
      }),
    ).toThrow(/configuration_invalid/iu);
  });

  it("requires explicit bootstrap authority and never reports its secret", () => {
    const secret = "bootstrap-secret-canary";
    expect(() =>
      parseControlPlaneConfig({
        DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
        OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
        OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
        OPENTAG_BOOTSTRAP_PAIRING_TOKEN: ` ${secret} `,
        OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
      }),
    ).toThrow("configuration_invalid");
    try {
      parseControlPlaneConfig({
        DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
        OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      return;
    }
    throw new Error("missing bootstrap configuration was accepted");
  });

  it("enables GitHub ingress only with an explicit high-entropy master secret", () => {
    const base = {
      DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
      OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
      OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
      OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
    };
    expect(() => parseControlPlaneConfig({
      ...base,
      OPENTAG_GITHUB_INGRESS_MASTER_SECRET: "too-short",
    })).toThrow("configuration_invalid");
    expect(parseControlPlaneConfig({
      ...base,
      OPENTAG_GITHUB_INGRESS_MASTER_SECRET: "g".repeat(32),
    }).githubIngressMasterSecret).toBe("g".repeat(32));
    expect(parseControlPlaneConfig({
      ...base,
      OPENTAG_GITHUB_INGRESS_MASTER_SECRET: "",
    }).githubIngressMasterSecret).toBeNull();
  });

  it("enables credential recovery only with a separate explicit secret", () => {
    const base = {
      DATABASE_URL: "postgresql://opentag:secret@postgres:5432/opentag",
      OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_local",
      OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Local OpenTag",
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
      OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
    };
    expect(parseControlPlaneConfig(base).recoveryPairingToken).toBeNull();
    expect(parseControlPlaneConfig({
      ...base,
      OPENTAG_RECOVERY_PAIRING_TOKEN: "recovery_secret_value",
    }).recoveryPairingToken).toBe("recovery_secret_value");
    expect(() => parseControlPlaneConfig({
      ...base,
      OPENTAG_RECOVERY_PAIRING_TOKEN: "short",
    })).toThrow("configuration_invalid");
    expect(() => parseControlPlaneConfig({
      ...base,
      OPENTAG_RECOVERY_PAIRING_TOKEN: "bootstrap_secret",
    })).toThrow("configuration_invalid");
  });

  it("parses the one-shot owner bootstrap separately from server config", () => {
    expect(
      parseAdminBootstrapConfig({
        OPENTAG_BOOTSTRAP_ADMIN_EMAIL: "owner@example.test",
        OPENTAG_BOOTSTRAP_ADMIN_NAME: "OpenTag Owner",
        OPENTAG_BOOTSTRAP_ADMIN_PASSWORD: "correct horse battery staple",
      }),
    ).toEqual({
      email: "owner@example.test",
      displayName: "OpenTag Owner",
      password: "correct horse battery staple",
    });
    expect(() => parseAdminBootstrapConfig({})).toThrow(
      "configuration_invalid",
    );
  });
});
