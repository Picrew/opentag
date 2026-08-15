import { z } from "zod";

const ReleaseShaSchema = z.union([
  z.literal("local"),
  z.string().regex(/^[a-f0-9]{40}$/u),
]);

const RawConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    OPENTAG_BOOTSTRAP_ORGANIZATION_ID: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => value === value.trim()),
    OPENTAG_BOOTSTRAP_PAIRING_TOKEN: z
      .string()
      .min(16)
      .max(4096)
      .refine((value) => value === value.trim()),
    OPENTAG_RECOVERY_PAIRING_TOKEN: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().min(16).max(4096).refine((value) => value === value.trim()).optional(),
    ),
    OPENTAG_ENVIRONMENT: z.enum(["local", "staging", "production"]).default("local"),
    OPENTAG_HOST: z.string().min(1).default("0.0.0.0"),
    OPENTAG_GITHUB_INGRESS_MASTER_SECRET: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().min(32).max(4096).optional(),
    ),
    OPENTAG_JOB_LEASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
    OPENTAG_JOB_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
    OPENTAG_JOB_RETRY_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(30_000),
    OPENTAG_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
    OPENTAG_PUBLIC_URL: z.string().min(1),
    OPENTAG_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    OPENTAG_RELEASE_SHA: ReleaseShaSchema.default("local"),
  })
  .passthrough();

export type ControlPlaneConfig = {
  bootstrapOrganizationId: string;
  bootstrapOrganizationName: string;
  bootstrapPairingToken: string;
  databaseUrl: string;
  environment: "local" | "staging" | "production";
  githubIngressMasterSecret: string | null;
  host: string;
  jobLeaseDurationMs: number;
  jobPollIntervalMs: number;
  jobRetryDelayMs: number;
  poolMax: number;
  port: number;
  publicOrigin: string;
  recoveryPairingToken: string | null;
  releaseSha: "local" | string;
};

const AdminBootstrapConfigSchema = z
  .object({
    OPENTAG_BOOTSTRAP_ADMIN_EMAIL: z
      .string()
      .email()
      .transform((value) => value.toLowerCase()),
    OPENTAG_BOOTSTRAP_ADMIN_NAME: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => value === value.trim()),
    OPENTAG_BOOTSTRAP_ADMIN_PASSWORD: z
      .string()
      .min(12)
      .max(1024),
  })
  .passthrough();

export function parseAdminBootstrapConfig(
  input: Record<string, string | undefined>,
) {
  try {
    const parsed = AdminBootstrapConfigSchema.parse(input);
    return {
      email: parsed.OPENTAG_BOOTSTRAP_ADMIN_EMAIL,
      displayName: parsed.OPENTAG_BOOTSTRAP_ADMIN_NAME,
      password: parsed.OPENTAG_BOOTSTRAP_ADMIN_PASSWORD,
    };
  } catch {
    throw new Error("configuration_invalid");
  }
}

function parseDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("unsupported database protocol");
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    throw new Error("database URL is incomplete");
  }
  return raw;
}

function parsePublicOrigin(
  raw: string,
  environment: ControlPlaneConfig["environment"],
): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("public URL must be an origin");
  }
  if (environment === "local") {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("local public URL must use HTTP or HTTPS");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("non-local public URL must use HTTPS");
  }
  return url.origin;
}

export function parseControlPlaneConfig(
  input: Record<string, string | undefined>,
): ControlPlaneConfig {
  try {
    const parsed = RawConfigSchema.parse(input);
    if (parsed.OPENTAG_ENVIRONMENT !== "local" && parsed.OPENTAG_RELEASE_SHA === "local") {
      throw new Error("non-local deployments require an immutable release identity");
    }
    if (
      parsed.OPENTAG_RECOVERY_PAIRING_TOKEN !== undefined
      && parsed.OPENTAG_RECOVERY_PAIRING_TOKEN === parsed.OPENTAG_BOOTSTRAP_PAIRING_TOKEN
    ) {
      throw new Error("recovery authority must be independent");
    }
    return {
      bootstrapOrganizationId: parsed.OPENTAG_BOOTSTRAP_ORGANIZATION_ID,
      bootstrapOrganizationName: parsed.OPENTAG_BOOTSTRAP_ORGANIZATION_NAME,
      bootstrapPairingToken: parsed.OPENTAG_BOOTSTRAP_PAIRING_TOKEN,
      databaseUrl: parseDatabaseUrl(parsed.DATABASE_URL),
      environment: parsed.OPENTAG_ENVIRONMENT,
      githubIngressMasterSecret: parsed.OPENTAG_GITHUB_INGRESS_MASTER_SECRET ?? null,
      host: parsed.OPENTAG_HOST,
      jobLeaseDurationMs: parsed.OPENTAG_JOB_LEASE_MS,
      jobPollIntervalMs: parsed.OPENTAG_JOB_POLL_MS,
      jobRetryDelayMs: parsed.OPENTAG_JOB_RETRY_MS,
      poolMax: parsed.OPENTAG_DB_POOL_MAX,
      port: parsed.OPENTAG_PORT,
      publicOrigin: parsePublicOrigin(
        parsed.OPENTAG_PUBLIC_URL,
        parsed.OPENTAG_ENVIRONMENT,
      ),
      recoveryPairingToken: parsed.OPENTAG_RECOVERY_PAIRING_TOKEN ?? null,
      releaseSha: parsed.OPENTAG_RELEASE_SHA,
    };
  } catch {
    throw new Error("configuration_invalid");
  }
}
