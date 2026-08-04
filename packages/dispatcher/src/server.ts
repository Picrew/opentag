import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AdapterMutationMappingSchema,
  ActorIdentitySchema,
  ActionHintSchema,
  actionScopeAllowsRunReuse,
  ActionPermissionRequestSchema,
  OpenTagApprovalPromptPresentationSchema,
  OpenTagManagedChannelBindingOwnershipSchema,
  MaterialActionReceiptSchema,
  HumanEscalationSchema,
  VerificationEvidenceSchema,
  capabilityForMutationIntent,
  channelProgressVisibility,
  conversationKeysFromCallback,
  conversationKeysFromEvent,
  parseThreadActionCommand,
  parseThreadControlCommand,
  permissionScopesAllowCapability,
  redactCredentialLikeData,
  sanitizeCredentialLikeValue,
  projectTargetRefFromEvent,
  protocolRunFieldsFromEvent,
  suggestedActionCandidatesFromSnapshots,
  type ActorIdentity,
  type HumanEscalation,
  type ActionReceiptCapability,
  type ActionReceiptContext,
  type AdapterMutationMapping,
  type ApplyIntentOutcome,
  type ApplyPlan,
  type MutationIntent,
  type OpenTagEvent,
  type OpenTagRunResult,
  type OpenTagRun,
  type PermissionGrant,
  type SuggestedChangesSnapshot,
  type SuggestedActionCandidate,
  type ThreadActionCommand,
  type WorkLoopView,
  type WorkstreamContinuationDecision,
  type WorkstreamContinuationRecord,
  type WorkstreamContinuationTriggerEvent,
  createAdapterMutationCompilerRegistry,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  FactoryRecipeSnapshotSchema,
  FactoryRecipeSnapshotInputSchema,
  WorkstreamAdmissionBatchInputSchema,
  WorkstreamAdmissionBatchItemResultSchema,
  WorkstreamAdmissionBatchReceiptSchema,
  WorkstreamAdmissionBatchResultSchema,
  WorkstreamAdmissionBatchSchema,
  WorkstreamMetricsSchema,
  WorkstreamInputSchema,
  WorkstreamSchema,
  WorkThreadSchema,
  PolicyRuleSchema,
  PolicyScopeSchema,
  RunnerRegistrationRequestSchema,
  RunnerRegistrationInputSchema,
  RunEventImportanceSchema,
  RunEventVisibilitySchema,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  platformCapabilityForProvider,
  readRequestTextWithLimit,
  shouldDeliverSourceReceipt
} from "@opentag/core";
import { evaluateWorkstream, evaluateWorkstreamContinuation } from "@opentag/governance";
import {
  applyGitHubIssueMutationOperation,
  createGitHubIssueMutationCompiler,
  type FetchLike as GitHubFetchLike
} from "@opentag/github";
import type { GitHubIssueMutationOperation } from "@opentag/github";
import type { GitHubCompletionReconciliationEscalationRequest } from "@opentag/github";
import {
  applyGitLabMutationOperation,
  createGitLabMutationCompiler,
  normalizeGitLabBaseUrl,
  type FetchLike as GitLabFetchLike
} from "@opentag/gitlab";
import type { GitLabMutationOperation } from "@opentag/gitlab";
import {
  acknowledgeLinearAgentSession,
  applyLinearMutationOperation,
  buildLinearOAuthAuthorizationUrl,
  createLinearAgentActivity,
  createLinearAdapterMappingDrafts,
  createLinearIssueCommentRecord,
  createLinearMutationCompiler,
  createLinearWebhookApp,
  DEFAULT_LINEAR_COMMENT_RUN_DEFER_MS,
  DEFAULT_LINEAR_AGENT_OAUTH_SCOPES,
  discoverLinearMetadata,
  exchangeLinearOAuthCode,
  fetchLinearWorkspaceIdentity,
  linearAgentSessionIdFromCallbackUri,
  linearIssueIdFromCallbackUri,
  linearParentCommentIdFromCallbackUri,
  refreshLinearOAuthToken,
  updateLinearAgentSession,
  updateLinearComment,
  verifyLinearSignature,
  verifyLinearWebhookTimestamp,
  type FetchLike as LinearFetchLike,
  type LinearWebhookPayload,
  type LinearOAuthTokenResponse,
  type LinearMutationOperation
} from "@opentag/linear";
import type { SlackBlock } from "@opentag/slack";
import {
  ActiveConversationRaceError,
  ChannelBindingCorruptionError,
  ManagedChannelAuthorityError,
  createOpenTagRepository,
  managedChannelBindingAuthorityDigest,
  migrateSchema
} from "@opentag/store";
import type { DurableWorkThread, LinearRelayInstallation, LinearRelayInstallationAuth } from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/**
 * Parse and validate a request body, mapping ONLY request-body parse failures to
 * HTTP client errors. Oversized bodies return 413, malformed JSON returns 400,
 * and request-schema validation failures return 400 so the global onError
 * handler can return them to the client without masking unrelated internal
 * ZodError/SyntaxError as 400s. Any other error is rethrown unchanged and falls
 * through to a 500.
 */
export type DispatcherRateLimitOptions = {
  windowMs: number;
  maxRequests: number;
  now?(): number;
};

export type RelayPlatformCapability = {
  provider: string;
  ingress?: {
    enabled: boolean;
    path?: string;
    signatureVerification?: "configured" | "not_configured" | "not_required";
    reason?: string;
  };
  callback?: {
    enabled: boolean;
    reason?: string;
  };
  apply?: {
    enabled: boolean;
    reason?: string;
  };
  oauthInstall?: {
    enabled: boolean;
    path?: string;
    reason?: string;
  };
};

export type RelayCapabilities = {
  schemaVersion: 1;
  relay: true;
  platforms: RelayPlatformCapability[];
};

type DispatcherRateLimitBucket = {
  count: number;
  resetAt: number;
};

class RequestBodyRejectedError extends Error {
  readonly reason: "invalid_json_body" | "invalid_request_body";
  readonly publicError: string;

  constructor(input: { reason: "invalid_json_body" | "invalid_request_body"; publicError?: string }) {
    super(input.reason);
    this.name = "RequestBodyRejectedError";
    this.reason = input.reason;
    this.publicError = input.publicError ?? input.reason;
  }
}

function requestBodyTooLarge(c: Context, maxBytes: number): HTTPException {
  return new HTTPException(413, {
    res: c.json({ error: "request_body_too_large", maxBytes }, 413)
  });
}

async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
  options: { maxBytes?: number; invalidBodyError?: string } = {}
): Promise<z.infer<S>> {
  let json: unknown;
  try {
    const rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: options.maxBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES });
    json = JSON.parse(rawBody);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) throw requestBodyTooLarge(c, err.maxBytes);
    if (err instanceof HTTPException) throw err;
    if (err instanceof SyntaxError) {
      throw new HTTPException(400, {
        res: c.json({ error: "invalid_json_body" }, 400),
        cause: new RequestBodyRejectedError({ reason: "invalid_json_body" })
      });
    }
    throw err;
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const publicError = options.invalidBodyError ?? "invalid_request_body";
    throw new HTTPException(400, {
      res: c.json({ error: publicError, issues: result.error.issues }, 400),
      cause: new RequestBodyRejectedError({ reason: "invalid_request_body", publicError })
    });
  }
  return result.data;
}

function normalizeRateLimitedEndpoint(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
    .replace(/^([A-Z]+) \/v1\/runners\/[^/]+\/runs\/[^/]+/, "$1 /v1/runners/:runnerId/runs/:runId")
    .replace(/^([A-Z]+) \/v1\/runners\/[^/]+/, "$1 /v1/runners/:runnerId")
    .replace(/^([A-Z]+) \/v1\/repo-bindings\/[^/]+\/[^/]+\/[^/]+/, "$1 /v1/repo-bindings/:provider/:owner/:repo")
    .replace(/^([A-Z]+) \/v1\/channel-bindings\/[^/]+\/[^/]+\/[^/]+/, "$1 /v1/channel-bindings/:provider/:accountId/:conversationId")
    .replace(/^([A-Z]+) \/v1\/slack-channel-bindings\/[^/]+\/[^/]+/, "$1 /v1/slack-channel-bindings/:teamId/:channelId")
    .replace(/^([A-Z]+) \/v1\/follow-up-requests\/[^/]+/, "$1 /v1/follow-up-requests/:id")
    .replace(/^([A-Z]+) \/v1\/proposals\/[^/]+/, "$1 /v1/proposals/:proposalId")
    .replace(/^([A-Z]+) \/v1\/approvals\/[^/]+/, "$1 /v1/approvals/:approvalDecisionId")
    .replace(/^([A-Z]+) \/v1\/apply-plans\/[^/]+/, "$1 /v1/apply-plans/:applyPlanId")
    .replace(/^([A-Z]+) \/v1\/runs\/[^/]+/, "$1 /v1/runs/:runId");
}

function rateLimitRunnerId(path: string): string {
  return path.match(/^\/v1\/runners\/([^/]+)/)?.[1] ?? "none";
}

function rateLimitSourcePlatform(path: string): string {
  const channelProvider = path.match(/^\/v1\/channel-bindings\/([^/]+)/)?.[1];
  if (channelProvider) return channelProvider;
  const repoProvider = path.match(/^\/v1\/repo-bindings\/([^/]+)/)?.[1];
  if (repoProvider) return repoProvider;
  if (path.startsWith("/v1/slack-channel-bindings/")) return "slack";
  return "unknown";
}

function safeDecodeRateLimitSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rateLimitTenant(path: string): string {
  const channel = path.match(/^\/v1\/channel-bindings\/([^/]+)\/([^/]+)/);
  if (channel) {
    const provider = safeDecodeRateLimitSegment(channel[1]) ?? "unknown";
    const accountId = safeDecodeRateLimitSegment(channel[2]) ?? "unknown";
    return `${provider}:${accountId}`;
  }

  const legacySlack = path.match(/^\/v1\/slack-channel-bindings\/([^/]+)/);
  if (legacySlack) return `slack:${safeDecodeRateLimitSegment(legacySlack[1]) ?? "unknown"}`;

  const repo = path.match(/^\/v1\/repo-bindings\/([^/]+)\/([^/]+)/);
  if (repo) {
    const provider = safeDecodeRateLimitSegment(repo[1]) ?? "unknown";
    const owner = safeDecodeRateLimitSegment(repo[2]) ?? "unknown";
    return `${provider}:${owner}`;
  }

  return "unknown";
}

function rateLimitTokenFingerprint(authorization: string | null): string {
  if (!authorization) return "none";
  return createHash("sha256").update(authorization).digest("hex").slice(0, 16);
}

function rawTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rateLimitKey(c: Context): string {
  const path = new URL(c.req.url).pathname;
  return [
    `token=${rateLimitTokenFingerprint(c.req.raw.headers.get("authorization"))}`,
    `runner=${rateLimitRunnerId(path)}`,
    `source=${rateLimitSourcePlatform(path)}`,
    `tenant=${rateLimitTenant(path)}`,
    `endpoint=${normalizeRateLimitedEndpoint(c.req.method, path)}`
  ].join("|");
}

function createDispatcherRateLimitMiddleware(options: DispatcherRateLimitOptions) {
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new Error("rateLimit.windowMs must be a positive number.");
  }
  if (!Number.isFinite(options.maxRequests) || options.maxRequests <= 0) {
    throw new Error("rateLimit.maxRequests must be a positive number.");
  }

  const buckets = new Map<string, DispatcherRateLimitBucket>();
  const now = options.now ?? (() => Date.now());

  return async (c: Context, next: () => Promise<void>) => {
    const currentTime = now();
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) buckets.delete(bucketKey);
    }
    const key = rateLimitKey(c);
    const existing = buckets.get(key);
    const bucket =
      existing && existing.resetAt > currentTime
        ? existing
        : { count: 0, resetAt: currentTime + options.windowMs };

    if (bucket.count >= options.maxRequests) {
      const retryAfterMs = Math.max(0, bucket.resetAt - currentTime);
      c.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
      return c.json(
        {
          error: "rate_limited",
          retryAfterMs,
          maxRequests: options.maxRequests,
          windowMs: options.windowMs
        },
        429
      );
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    await next();
  };
}
import { createAdmissionRuntime, sourceRepoIsPublic, type AgentAccessProfileCheck } from "./admission.js";
import { continuationResumePresentation } from "./continuation-presentation.js";
import { sha256Digest } from "./digest.js";
import { createDefaultCallbackPresentation, type CallbackPresentation, type LarkRenderLocale } from "./presentation.js";
import {
  createDispatcherCompletionGovernance,
  currentWorkThreadRun,
  type GitHubCompletionPolicy
} from "./completion-governance.js";
import { createSourceThreadControlHandler } from "./source-thread-control.js";

type CallbackRunStatusState = Parameters<CallbackPresentation["runStatusPresentation"]>[0]["state"];
type DelayedLarkStatusPhase = "queued" | "running" | "progress";
type DelayedLarkStatusTimer = ReturnType<typeof globalThis.setTimeout>;

export type LarkDelayedStatusCardOptions = {
  enabled?: boolean;
  delayMs?: number;
  minUpdateIntervalMs?: number;
  now?(): number;
  setTimeout?(callback: () => void, delayMs: number): DelayedLarkStatusTimer;
  clearTimeout?(handle: DelayedLarkStatusTimer): void;
};

export type LinearOAuthInstallOptions = {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: readonly string[];
  webhookSecret?: string;
  webhookPath?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  installStateTtlMs?: number;
  refreshSkewMs?: number;
  commentRunDeferMs?: number;
  fetchImpl?: LinearFetchLike;
  now?(): Date;
};

type DelayedLarkStatusState = {
  timer?: DelayedLarkStatusTimer;
  cardCreated: boolean;
  lastPhase?: DelayedLarkStatusPhase;
  lastUpdateAt?: number;
};

function larkRenderLocaleFromEvent(event: OpenTagEvent): LarkRenderLocale | undefined {
  const locale = event.metadata?.["larkRenderLocale"];
  if (locale === "en-US" || locale === "zh-CN") return locale;
  const domain = event.metadata?.["larkDomain"];
  if (domain === "feishu") return "zh-CN";
  if (domain === "lark") return "en-US";
  return undefined;
}

function larkRenderLocaleRenderOption(event: OpenTagEvent): { larkRenderLocale: LarkRenderLocale } | {} {
  const locale = larkRenderLocaleFromEvent(event);
  return locale ? { larkRenderLocale: locale } : {};
}

function shouldDeliverRunStatusUpdate(
  presentation: CallbackPresentation,
  input: { provider: string; state: CallbackRunStatusState }
): boolean {
  return presentation.shouldDeliverRunStatusUpdate?.(input) ?? presentation.shouldDeliverStatusUpdate(input.provider);
}

function lifecycleStatusMessageKey(input: { provider: string; runId: string }): string | undefined {
  return input.provider === "slack" || input.provider === "lark" || input.provider === "linear" || input.provider === "telegram"
    ? `${input.runId}:status`
    : undefined;
}

const DEFAULT_LINEAR_OAUTH_INSTALL_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LINEAR_OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function generateLinearRelayInstallationId(): string {
  return `install_${randomBytes(12).toString("hex")}`;
}

function generateLinearRelayWebhookSecret(): string {
  return `linear_whsec_${randomBytes(24).toString("hex")}`;
}

function generateLinearOAuthState(): string {
  return `linear_${randomBytes(24).toString("hex")}`;
}

function linearAccessTokenExpiresAt(input: { token: LinearOAuthTokenResponse; now: Date }): string | undefined {
  return typeof input.token.expiresIn === "number" && Number.isFinite(input.token.expiresIn)
    ? new Date(input.now.getTime() + input.token.expiresIn * 1000).toISOString()
    : undefined;
}

function isTerminalRun(run: OpenTagRun): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status);
}

function shouldUseDelayedLarkStatusCard(
  provider: string,
  options: LarkDelayedStatusCardOptions,
  nativeStatusDelivery: boolean
): boolean {
  return provider === "lark" && options.enabled !== false && !nativeStatusDelivery;
}

function safeExecutorLabel(executor: string | undefined): string {
  if (!executor || !/^[a-z0-9._-]{1,40}$/i.test(executor)) return "the selected agent";
  return executor;
}

const CreateRunnerSchema = RunnerRegistrationRequestSchema;

const CreateRepoBindingSchema = z.object({
  provider: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  runnerId: z.string().min(1),
  fallbackRunnerIds: z.array(z.string().min(1)).max(63).optional(),
  workspacePath: z.string().min(1).optional(),
  defaultExecutor: z.string().min(1).optional(),
  fallbackExecutorIds: z.array(z.string().min(1)).max(63).optional(),
  allowedActors: z.array(z.string().min(1)).optional()
}).superRefine((binding, ctx) => {
  const validatePreference = (primary: string | undefined, fallback: string[] | undefined, path: string) => {
    if (!fallback?.length) return;
    if (!primary) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Fallback ${path} ids require a primary ${path} id.`, path: [`fallback${path[0]!.toUpperCase()}${path.slice(1)}Ids`] });
      return;
    }
    if (fallback.includes(primary)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Fallback ${path} ids cannot repeat the primary ${path} id.`, path: [`fallback${path[0]!.toUpperCase()}${path.slice(1)}Ids`] });
    }
    if (new Set(fallback).size !== fallback.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Fallback ${path} ids must be unique.`, path: [`fallback${path[0]!.toUpperCase()}${path.slice(1)}Ids`] });
    }
  };
  validatePreference(binding.runnerId, binding.fallbackRunnerIds, "runner");
  validatePreference(binding.defaultExecutor, binding.fallbackExecutorIds, "executor");
});

const CreateSlackChannelBindingSchema = z.object({
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1)
});

const CreateChannelBindingSchema = z
  .object({
    provider: z.string().min(1),
    accountId: z.string().min(1),
    conversationId: z.string().min(1),
    repoProvider: z.string().min(1).optional(),
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    ownership: OpenTagManagedChannelBindingOwnershipSchema.optional()
  })
  .superRefine((binding, ctx) => {
    const present = [binding.repoProvider, binding.owner, binding.repo].filter((value) => value !== undefined).length;
    if (present !== 0 && present !== 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repoProvider"],
        message: "Channel binding repository fields repoProvider, owner, and repo must be provided together."
      });
    }
  });

function channelBindingScopeFromEvent(event: OpenTagEvent): { accountId: string; conversationId: string } | null {
  const metadata = event.metadata ?? {};
  const accountId = metadataString(metadata, "accountId")
    ?? metadataString(metadata, "teamId")
    ?? metadataString(metadata, "tenantKey")
    ?? metadataString(metadata, "botId");
  const conversationId = metadataString(metadata, "conversationId")
    ?? metadataString(metadata, "channelId")
    ?? metadataString(metadata, "chatId");
  return accountId && conversationId ? { accountId, conversationId } : null;
}

async function managedChannelOwnershipVerified(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  event: OpenTagEvent;
  principal?: ChannelPrincipalIdentity;
}): Promise<boolean> {
  const scope = channelBindingScopeFromEvent(input.event);
  if (!scope) return input.event.source !== "slack" && input.event.source !== "lark";
  const binding = await input.repo.getChannelBinding({ provider: input.event.source, ...scope });
  if (!binding) return input.event.source !== "slack" && input.event.source !== "lark";
  if (!binding.ownership) return true;
  return input.principal?.provider === input.event.source
    && input.principal.applicationId === binding.ownership.applicationId
    && (!binding.ownership.botId || input.principal.botId === binding.ownership.botId);
}

export type ChannelPrincipalCredential = {
  provider: string;
  applicationId: string;
  botId?: string;
  credential: string;
};

type ChannelPrincipalIdentity = Omit<ChannelPrincipalCredential, "credential">;

const MANAGED_CHANNEL_ATTESTATION_KEY = "opentagManagedChannelOwnership";

function eventWithManagedChannelAttestation(
  event: OpenTagEvent,
  principal: ChannelPrincipalIdentity | undefined
): OpenTagEvent {
  const metadata = { ...(event.metadata ?? {}) };
  delete metadata[MANAGED_CHANNEL_ATTESTATION_KEY];
  if (principal) {
    metadata[MANAGED_CHANNEL_ATTESTATION_KEY] = {
      provider: principal.provider,
      applicationId: principal.applicationId,
      ...(principal.botId ? { botId: principal.botId } : {})
    };
  }
  return { ...event, metadata };
}

function managedChannelAttestationFromEvent(event: OpenTagEvent): ChannelPrincipalIdentity | undefined {
  const value = event.metadata?.[MANAGED_CHANNEL_ATTESTATION_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = typeof record["provider"] === "string" ? record["provider"] : undefined;
  const applicationId = typeof record["applicationId"] === "string" ? record["applicationId"] : undefined;
  const botId = typeof record["botId"] === "string" ? record["botId"] : undefined;
  if (!provider || provider !== event.source || !applicationId) return undefined;
  return { provider, applicationId, ...(botId ? { botId } : {}) };
}

function channelPrincipalCredentialDigest(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

function configuredChannelPrincipals(principals: ChannelPrincipalCredential[] | undefined): Map<string, ChannelPrincipalIdentity> {
  const configured = new Map<string, ChannelPrincipalIdentity>();
  for (const principal of principals ?? []) {
    const credential = principal.credential.trim();
    if (!credential || !principal.provider.trim() || !principal.applicationId.trim()) {
      throw new Error("Channel principals require provider, applicationId, and credential.");
    }
    const digest = channelPrincipalCredentialDigest(credential);
    if (configured.has(digest)) throw new Error("Channel principal credentials must be unique per adapter.");
    configured.set(digest, {
      provider: principal.provider,
      applicationId: principal.applicationId,
      ...(principal.botId ? { botId: principal.botId } : {})
    });
  }
  return configured;
}

function channelPrincipalFromRequest(request: Request, principals: Map<string, ChannelPrincipalIdentity>): ChannelPrincipalIdentity | undefined {
  const credential = request.headers.get("x-opentag-channel-principal")?.trim();
  return credential ? principals.get(channelPrincipalCredentialDigest(credential)) : undefined;
}

function principalOwnsManagedBinding(principal: ChannelPrincipalIdentity | undefined, binding: {
  provider: string;
  ownership?: { applicationId: string; botId?: string | undefined } | undefined;
}): boolean {
  if (!binding.ownership) return true;
  return principal?.provider === binding.provider
    && principal.applicationId === binding.ownership.applicationId
    && (!binding.ownership.botId || principal.botId === binding.ownership.botId);
}

async function managedChannelSourceAuthority(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  event: OpenTagEvent;
}): Promise<HumanEscalation["sourceAuthority"] | undefined> {
  if (!["slack", "lark"].includes(input.event.source)) return undefined;
  const scope = channelBindingScopeFromEvent(input.event);
  if (!scope) return undefined;
  const binding = await input.repo.getChannelBinding({ provider: input.event.source, ...scope });
  if (!binding) return undefined;
  const authority = {
    provider: input.event.source,
    ...scope,
    ...(binding.ownership ? { ownership: binding.ownership } : {})
  };
  return {
    ...authority,
    bindingDigest: managedChannelBindingAuthorityDigest(authority)
  };
}

const UpsertPolicyRuleSchema = z.object({
  rule: PolicyRuleSchema
});

const UpsertMutationMappingSchema = z.object({
  mapping: AdapterMutationMappingSchema
});

const LinearRelayInstallationAuthSchema = z.union([
  z
    .object({
      method: z.literal("api_key")
    })
    .strict(),
  z
    .object({
      method: z.literal("oauth_app"),
      actor: z.literal("app"),
      clientId: z.string().min(1).optional(),
      refreshToken: z.string().min(1).optional(),
      accessTokenExpiresAt: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional()
    })
    .strict()
]);

const LinearRelayInstallationSchema = z
  .object({
    id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/),
    webhookPath: z
      .string()
      .min(1)
      .refine((value) => value.startsWith("/linear/webhooks/"), {
        message: "Linear relay webhook path must start with /linear/webhooks/."
      }),
    webhookSecret: z.string().min(1),
    token: z.string().min(1),
    auth: LinearRelayInstallationAuthSchema.optional(),
    graphqlUrl: z.string().url().optional(),
    repoProvider: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    organizationId: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
    teamKey: z.string().min(1).optional()
  })
  .strict();

type ParsedLinearRelayInstallationAuth = z.infer<typeof LinearRelayInstallationAuthSchema>;

function linearRelayInstallationAuthFromParsed(auth: ParsedLinearRelayInstallationAuth | undefined): LinearRelayInstallationAuth {
  if (!auth || auth.method === "api_key") return { method: "api_key" };
  return {
    method: "oauth_app",
    actor: "app",
    ...(auth.clientId ? { clientId: auth.clientId } : {}),
    ...(auth.refreshToken ? { refreshToken: auth.refreshToken } : {}),
    ...(auth.accessTokenExpiresAt ? { accessTokenExpiresAt: auth.accessTokenExpiresAt } : {}),
    ...(auth.scopes?.length ? { scopes: auth.scopes } : {})
  };
}

const CreateLinearOAuthInstallationSchema = z
  .object({
    repoProvider: z.string().min(1).default("github"),
    owner: z.string().min(1),
    repo: z.string().min(1),
    teamId: z.string().min(1).optional(),
    teamKey: z.string().min(1).optional(),
    graphqlUrl: z.string().url().optional(),
    redirectUri: z.string().url().optional(),
    scopes: z.array(z.string().min(1)).optional()
  })
  .strict();

const CreateRunSchema = z.object({
  runId: z.string().min(1),
  event: OpenTagEventSchema
});

const RecordControlPlaneEventSchema = z.object({
  type: z.string().min(1),
  severity: z.enum(["info", "warn", "error"]).optional(),
  subject: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime().optional()
});

const GitHubCompletionEvidenceSchema = z.object({
  provider: z.literal("github"),
  deliveryId: z.string().min(1).max(256),
  eventName: z.enum(["pull_request", "check_run", "check_suite", "status"]),
  repository: z.object({ owner: z.string().min(1), repo: z.string().min(1) }).strict(),
  pullRequest: z.object({
    number: z.number().int().positive(),
    resourceRef: z.string().min(1),
    headSha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
    baseBranch: z.string().min(1),
    state: z.enum(["open", "closed", "merged"])
  }).strict(),
  checks: z.record(z.string().min(1), z.enum(["passed", "failed", "pending"])),
  observedAt: z.string().datetime(),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
}).strict();

const GitHubCompletionEvidenceBatchSchema = z.object({
  snapshots: z.array(GitHubCompletionEvidenceSchema).min(1).max(100)
}).strict();

const CompletionWaiverInputSchema = z.object({
  actor: ActorIdentitySchema,
  reason: z.string().min(1).max(2_000),
  scope: z.literal("selected_gates"),
  policyScope: PolicyScopeSchema,
  gateIds: z.array(z.string().min(1)).min(1).max(50),
  waivedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional()
}).strict();

const HumanEscalationAcknowledgeInputSchema = z.object({
  actor: ActorIdentitySchema,
  acknowledgedAt: z.string().datetime().optional()
}).strict();

const HumanEscalationResolveInputSchema = z.object({
  actor: ActorIdentitySchema,
  optionId: z.string().min(1).optional(),
  reason: z.string().min(1).max(2_000).optional(),
  resolvedAt: z.string().datetime().optional()
}).strict();

const PruneSourceDeliveriesSchema = z.object({
  olderThan: z.string().datetime(),
  limit: z.number().int().positive().max(100_000).optional()
});

const PromoteFollowUpRequestSchema = z.object({
  runId: z.string().min(1)
});

const AttemptLeaseSchema = z.object({
  attemptId: z.string().min(1),
  fencingToken: z.string().min(1)
});

const ActionPermissionInputSchema = AttemptLeaseSchema.extend({ request: ActionPermissionRequestSchema });
const ActionPermissionResolutionInputSchema = AttemptLeaseSchema;
const MaterialActionReceiptInputSchema = AttemptLeaseSchema.extend({ receipt: MaterialActionReceiptSchema });
const ReconcileUnknownMaterialActionSchema = z.object({
  outcome: z.enum(["succeeded", "failed"]),
  idempotencyKey: z.string().min(1).max(256),
  receiptRef: z.string().min(1).max(512),
  evidence: z.array(VerificationEvidenceSchema).max(20).optional()
}).strict();

const CompleteRunSchema = AttemptLeaseSchema.extend({
  result: OpenTagRunResultSchema,
  idempotencyKey: z.string().min(1).max(256).optional()
});

function normalizeNeedsHumanResult(input: {
  run: OpenTagRun;
  result: OpenTagRunResult;
  attemptId: string;
  openedAt: string;
}): { result: OpenTagRunResult; escalation?: HumanEscalation } {
  if (input.result.conclusion !== "needs_human") return { result: input.result };
  const normalizedResult = { ...input.result };
  delete normalizedResult.humanEscalationId;
  delete normalizedResult.humanResolutionUnavailableReason;
  const workThreadId = input.run.thread?.id;
  if (!workThreadId) {
    return {
      result: OpenTagRunResultSchema.parse({
        ...normalizedResult,
        humanResolutionUnavailableReason:
          "No durable WorkThread is available for an attributable human resolution; retry from a bound source work item."
      })
    };
  }
  const request = input.result.humanEscalation;
  if (request?.expiresAt && Date.parse(request.expiresAt) <= Date.parse(input.openedAt)) {
    return {
      result: OpenTagRunResultSchema.parse({
        ...normalizedResult,
        humanResolutionUnavailableReason: "The requested human resolution expired before the run completion was recorded."
      })
    };
  }
  const escalationClass = request?.class
    ?? ((input.result.suggestedChanges?.length ?? 0) > 0 ? "approval" : "missing_input");
  const subjectRef = request?.subjectRef
    ?? input.result.suggestedChanges?.[0]?.proposalId
    ?? input.run.id;
  const dedupeKey = request?.dedupeKey ?? `run-result:${escalationClass}:${subjectRef}:v1`;
  const id = `escalation_${createHash("sha256")
    .update(`${input.run.id}\0${dedupeKey}`)
    .digest("hex")
    .slice(0, 24)}`;
  const nextAction = request?.nextAction
    ?? (typeof input.result.nextAction === "object" ? input.result.nextAction.hint : undefined)
    ?? { kind: "request_human_decision" as const, targetId: subjectRef };
  const escalation = HumanEscalationSchema.parse({
    id,
    workThreadId,
    runId: input.run.id,
    attemptId: input.attemptId,
    class: escalationClass,
    audience: request?.audience ?? "requester",
    subjectRef,
    state: "open",
    blocking: request?.blocking ?? true,
    summary: request?.summary ?? input.result.summary,
    reason: request?.reason ?? "The executor reported that human input is required before work can continue.",
    ...(request?.options ? { options: request.options } : {}),
    nextAction,
    dedupeKey,
    openedAt: input.openedAt,
    ...(request?.expiresAt ? { expiresAt: request.expiresAt } : {})
  });
  return {
    result: OpenTagRunResultSchema.parse({
      ...normalizedResult,
      humanEscalationId: escalation.id
    }),
    escalation
  };
}

const MarkRunningSchema = AttemptLeaseSchema.extend({
  executor: z.string().min(1),
  executorCapability: z.record(z.string(), z.unknown()).optional(),
  runTimeoutMs: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(256).optional()
});

const RejectAttemptStartSchema = AttemptLeaseSchema.extend({
  executorId: z.string().min(1),
  reason: z.string().min(1).max(2_000)
});

const CancelRunSchema = z.object({
  reason: z.string().min(1).optional(),
  requestedBy: z.string().min(1).optional()
});

const ApprovalDecisionInputSchema = z.object({
  id: z.string().min(1).optional(),
  approvedIntentIds: z.array(z.string().min(1)),
  rejectedIntentIds: z.array(z.string().min(1)).optional(),
  approvedBy: ActorIdentitySchema,
  approvedAt: z.string().datetime().optional(),
  scope: z.enum(["manual", "policy"]).default("manual"),
  reason: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).refine((value) => {
  const rejected = new Set(value.rejectedIntentIds ?? []);
  return value.approvedIntentIds.every((intentId) => !rejected.has(intentId));
}, {
  message: "approvedIntentIds and rejectedIntentIds must not overlap"
});

const ApplyPlanInputSchema = z.object({
  id: z.string().min(1).optional(),
  approvalDecisionId: z.string().min(1),
  selectedIntentIds: z.array(z.string().min(1)).optional(),
  adapter: z.string().min(1).optional(),
  execute: z.boolean().optional()
});

const ThreadActionInputSchema = z.object({
  id: z.string().min(1).optional(),
  rawText: z.string().min(1),
  actor: ActorIdentitySchema,
  callback: z.object({
    provider: z.string().min(1),
    uri: z.string().min(1),
    threadKey: z.string().min(1).optional()
  }),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const ChildRunInputSchema = z.object({
  runId: z.string().min(1),
  action: ActionHintSchema,
  commandText: z.string().min(1).optional(),
  sourceProposalId: z.string().min(1).optional(),
  sourceApplyPlanId: z.string().min(1).optional()
});

const CHILD_EVENT_METADATA_REPLAY_KEYS = [
  "sourceDeliveryId",
  "webhookDeliveryId",
  "deliveryId",
  "githubDeliveryId",
  "githubDeliveryGuid",
  "slackEventId",
  "larkEventId",
  "signatureState",
  "signatureVerified",
  "verifiedSignature",
  "webhookSignatureVerified",
  "githubSignatureVerified"
] as const;

const ProgressSchema = AttemptLeaseSchema.extend({
  type: z.string().min(1).optional(),
  message: z.string().min(1),
  at: z.string().datetime().optional(),
  visibility: RunEventVisibilitySchema.optional(),
  importance: RunEventImportanceSchema.optional(),
  idempotencyKey: z.string().min(1).max(256).optional()
});

function childEventMetadata(parentMetadata: OpenTagEvent["metadata"], metadata?: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...parentMetadata };
  for (const key of CHILD_EVENT_METADATA_REPLAY_KEYS) {
    delete sanitized[key];
  }
  return {
    ...sanitized,
    ...(metadata ?? {})
  };
}

function childEventFromParent(input: {
  parentEvent: OpenTagEvent;
  childRunId: string;
  commandText?: string;
  actionKind: string;
  receivedAt: string;
  extraContext?: OpenTagEvent["context"];
  metadata?: Record<string, unknown>;
  permissions?: PermissionGrant[];
}): OpenTagEvent {
  return {
    ...input.parentEvent,
    id: `evt_${input.childRunId}`,
    sourceEventId: `${input.parentEvent.sourceEventId}:${input.childRunId}`,
    receivedAt: input.receivedAt,
    context: [...input.parentEvent.context, ...(input.extraContext ?? [])],
    command: {
      rawText: input.commandText ?? `Execute next action: ${input.actionKind}`,
      intent: "run",
      args: {
        parentSourceEventId: input.parentEvent.sourceEventId,
        actionKind: input.actionKind
      }
    },
    metadata: childEventMetadata(input.parentEvent.metadata, input.metadata),
    permissions: input.permissions ?? input.parentEvent.permissions
  };
}

function mappingsFromAdapterPlan(adapterPlan: unknown) {
  if (!adapterPlan || typeof adapterPlan !== "object" || Array.isArray(adapterPlan)) return [];
  const mappings = (adapterPlan as { mappings?: unknown }).mappings;
  if (!Array.isArray(mappings)) return [];
  return mappings.map((mapping) => AdapterMutationMappingSchema.parse(mapping));
}

function mappingsForAdapterPlan(adapterPlan: unknown, defaults: AdapterMutationMapping[] = []): AdapterMutationMapping[] {
  const planMappings = mappingsFromAdapterPlan(adapterPlan);
  if (planMappings.length === 0) return defaults;
  const planMappingIds = new Set(planMappings.map((mapping) => mapping.id));
  return [...planMappings, ...defaults.filter((mapping) => !planMappingIds.has(mapping.id))];
}

function conversationKeyFromCallback(input: { provider: string; uri: string; threadKey?: string | undefined }): string {
  return `${input.provider}:${input.threadKey ?? input.uri}`;
}

function metadataIssueNumber(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.["issueNumber"];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sourceContainerMetadata(input: { provider: string; accountId: string; conversationId: string }): Record<string, string> {
  if (input.provider === "lark") {
    return { tenantKey: input.accountId, chatId: input.conversationId };
  }
  if (input.provider === "slack") {
    return { teamId: input.accountId, channelId: input.conversationId };
  }
  if (input.provider === "telegram") {
    return { botId: input.accountId, chatId: input.conversationId };
  }
  return { accountId: input.accountId, conversationId: input.conversationId };
}

function latestRunTimeoutMs(events: Array<{ type: string; payload: unknown }>): number | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "run.running" || !event.payload || typeof event.payload !== "object") continue;
    const runTimeoutMs = (event.payload as { runTimeoutMs?: unknown }).runTimeoutMs;
    if (typeof runTimeoutMs === "number" && Number.isInteger(runTimeoutMs) && runTimeoutMs > 0) {
      return runTimeoutMs;
    }
  }
  return undefined;
}

function githubIssueWorkItemExternalId(metadata: Record<string, unknown> | undefined): string | undefined {
  const owner = metadataString(metadata, "owner");
  const repo = metadataString(metadata, "repo");
  const issueNumber = metadataIssueNumber(metadata);
  if (!owner || !repo || !issueNumber) return undefined;
  return `${owner}/${repo}#${issueNumber}`;
}

function conversationKeysFromThreadAction(input: {
  callback: { provider: string; uri: string; threadKey?: string | undefined };
  metadata?: Record<string, unknown> | undefined;
}): string[] {
  const keys = conversationKeysFromCallback(input.callback);
  const issueNumber = metadataIssueNumber(input.metadata);
  if (input.callback.provider === "github" && input.callback.threadKey && issueNumber) {
    const suffix = `#${issueNumber}`;
    if (input.callback.threadKey.endsWith(suffix)) {
      keys.push(`github:${input.callback.threadKey.slice(0, -suffix.length)}`);
    }
  }
  return [...new Set(keys)];
}

function proposalMatchesWorkItem(proposal: ActionProposal, externalId: string): boolean {
  return proposal.snapshot.workThread?.workItemReference.externalId === externalId || proposal.event.workItem?.externalId === externalId;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stableId(prefix: string, parts: unknown[]): string {
  return `${prefix}_${stableHash(JSON.stringify(parts))}`;
}

function actorKeys(actor: ActorIdentity): string[] {
  return [
    actor.providerUserId,
    actor.handle,
    `${actor.provider}:${actor.providerUserId}`,
    actor.handle ? `${actor.provider}:${actor.handle}` : undefined
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function actorAllowedByList(actor: ActorIdentity, allowedActors: string[] | undefined): boolean {
  if (!allowedActors?.length) return true;
  const keys = new Set(actorKeys(actor));
  return allowedActors.some((allowedActor) => keys.has(allowedActor));
}

type ActionProposal = {
  runId: string;
  run: OpenTagRun;
  event: OpenTagEvent;
  snapshot: SuggestedChangesSnapshot;
};

type ResolvedThreadAction = {
  proposal: ActionProposal;
  selectedIntentIds: string[];
  selectedCandidates: Array<SuggestedActionCandidate & { proposal: ActionProposal }>;
};

type ResolveThreadActionResult =
  | { ok: true; resolved: ResolvedThreadAction }
  | { ok: false; reason: "no_proposal" | "no_match" | "ambiguous"; message: string; runId?: string | undefined };

function actionCandidatesFor(proposals: ActionProposal[]): Array<SuggestedActionCandidate & { proposal: ActionProposal }> {
  const candidates: Array<SuggestedActionCandidate & { proposal: ActionProposal }> = [];
  let startIndex = 1;
  for (const proposal of proposals) {
    const proposalCandidates = suggestedActionCandidatesFromSnapshots([proposal.snapshot], startIndex).map((candidate) => ({
      ...candidate,
      proposal
    }));
    candidates.push(...proposalCandidates);
    startIndex += proposalCandidates.length;
  }
  return candidates;
}

function resolveCandidateSelection(input: {
  command: ThreadActionCommand;
  proposals: ActionProposal[];
}): ResolveThreadActionResult {
  const candidates = actionCandidatesFor(input.proposals);
  if (candidates.length === 0) {
    return { ok: false, reason: "no_proposal", message: "I could not find any suggested actions for this thread." };
  }

  let selected: Array<SuggestedActionCandidate & { proposal: ActionProposal }> = [];
  const selection = input.command.selection;
  if (selection.kind === "all") {
    selected = candidates;
  } else if (selection.kind === "index") {
    selected = candidates.filter((candidate) => candidate.index === selection.index);
  } else if (selection.kind === "proposal") {
    selected = candidates.filter((candidate) => candidate.proposalId === selection.proposalId);
  } else if (selection.kind === "intent") {
    selected = candidates.filter((candidate) => candidate.intent.intentId === selection.intentId);
  } else if (selection.kind === "domain") {
    selected = candidates.filter((candidate) => candidate.intent.domain === selection.domain);
  } else if (candidates.length === 1) {
    selected = candidates;
  } else {
    return {
      ok: false,
      reason: "ambiguous",
      runId: candidates[0]?.proposal.runId,
      message: `I found ${candidates.length} suggested actions. Please reply with ${candidates
        .map((candidate) => `\`${input.command.verb} ${candidate.index}\``)
        .join(", ")} or \`${input.command.verb} all\`.`
    };
  }

  if (selected.length === 0) {
    return {
      ok: false,
      reason: "no_match",
      runId: candidates[0]?.proposal.runId,
      message: "I could not match that reply to a suggested action. Please use an action number like `apply 1`."
    };
  }

  const proposalIds = new Set(selected.map((candidate) => candidate.proposalId));
  if (proposalIds.size !== 1) {
    return {
      ok: false,
      reason: "ambiguous",
      runId: selected[0]?.proposal.runId,
      message: "That selection spans multiple proposals. Please apply or approve one proposal at a time using its action number."
    };
  }

  return {
    ok: true,
    resolved: {
      proposal: selected[0]!.proposal,
      selectedIntentIds: selected.map((candidate) => candidate.intent.intentId),
      selectedCandidates: selected
    }
  };
}

async function resolveThreadAction(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  command: ThreadActionCommand;
  callback: { provider: string; uri: string; threadKey?: string | undefined };
  metadata?: Record<string, unknown> | undefined;
}): Promise<ResolveThreadActionResult> {
  const conversationKeys = conversationKeysFromThreadAction({
    callback: input.callback,
    ...(input.metadata ? { metadata: input.metadata } : {})
  });
  const primaryConversationKey = conversationKeys[0];
  const targetWorkItemExternalId = githubIssueWorkItemExternalId(input.metadata);
  const metadataProposalId = metadataString(input.metadata, "proposalId");
  const metadataIntentId = metadataString(input.metadata, "intentId");
  if (
    metadataProposalId &&
    (input.command.selection.kind === "index" || input.command.selection.kind === "latest")
  ) {
    const stored = await input.repo.getSuggestedChanges({ proposalId: metadataProposalId });
    if (!stored) {
      return { ok: false, reason: "no_proposal", message: `I could not find proposal \`${metadataProposalId}\`.` };
    }
    const claimed = await input.repo.getRun({ runId: stored.runId });
    if (!claimed) {
      return { ok: false, reason: "no_proposal", message: "I found the proposal but not its source run." };
    }
    const proposalConversationKeys = conversationKeysFromEvent(claimed.event);
    if (!proposalConversationKeys.some((key) => conversationKeys.includes(key))) {
      return { ok: false, reason: "no_match", runId: stored.runId, message: "That proposal does not belong to this source thread." };
    }
    const proposal = { runId: stored.runId, run: claimed.run, event: claimed.event, snapshot: stored.snapshot };
    if (targetWorkItemExternalId && !proposalMatchesWorkItem(proposal, targetWorkItemExternalId)) {
      return { ok: false, reason: "no_match", runId: stored.runId, message: "That proposal does not belong to this source thread." };
    }
    return resolveCandidateSelection({
      command: metadataIntentId
        ? { ...input.command, selection: { kind: "intent", intentId: metadataIntentId } }
        : { ...input.command, selection: { kind: "proposal", proposalId: metadataProposalId } },
      proposals: [proposal]
    });
  }
  if (input.command.selection.kind === "proposal") {
    const stored = await input.repo.getSuggestedChanges({ proposalId: input.command.selection.proposalId });
    if (!stored) {
      return { ok: false, reason: "no_proposal", message: `I could not find proposal \`${input.command.selection.proposalId}\`.` };
    }
    const claimed = await input.repo.getRun({ runId: stored.runId });
    if (!claimed) {
      return { ok: false, reason: "no_proposal", message: `I found the proposal but not its source run.` };
    }
    const proposalConversationKeys = conversationKeysFromEvent(claimed.event);
    if (!proposalConversationKeys.some((key) => conversationKeys.includes(key))) {
      return { ok: false, reason: "no_match", runId: stored.runId, message: "That proposal does not belong to this source thread." };
    }
    const proposal = { runId: stored.runId, run: claimed.run, event: claimed.event, snapshot: stored.snapshot };
    if (targetWorkItemExternalId && !proposalMatchesWorkItem(proposal, targetWorkItemExternalId)) {
      return { ok: false, reason: "no_match", runId: stored.runId, message: "That proposal does not belong to this source thread." };
    }
    return resolveCandidateSelection({
      command: input.command,
      proposals: [proposal]
    });
  }

  for (const conversationKey of conversationKeys) {
    const proposals = await input.repo.listLatestSuggestedChangesForConversation({ conversationKey });
    const scopedProposals =
      conversationKey !== primaryConversationKey && targetWorkItemExternalId
        ? proposals.filter((proposal) => proposalMatchesWorkItem(proposal, targetWorkItemExternalId))
        : proposals;
    if (scopedProposals.length > 0) return resolveCandidateSelection({ command: input.command, proposals: scopedProposals });
  }
  return resolveCandidateSelection({ command: input.command, proposals: [] });
}

function isGitHubRepoEvent(event: OpenTagEvent): boolean {
  const repoProvider = event.metadata["repoProvider"];
  return repoProvider === "github" || (event.source === "github" && repoProvider === undefined);
}

function isGitLabRepoEvent(event: OpenTagEvent): boolean {
  const repoProvider = event.metadata["repoProvider"];
  return repoProvider === "gitlab" || event.source === "gitlab";
}

function hasGitHubRepoTarget(event: OpenTagEvent): boolean {
  return isGitHubRepoEvent(event) && typeof event.metadata["owner"] === "string" && typeof event.metadata["repo"] === "string";
}

function gitlabProjectPathFromEvent(event: OpenTagEvent): string | null {
  if (!isGitLabRepoEvent(event)) return null;
  const projectPathWithNamespace = event.metadata["projectPathWithNamespace"];
  if (typeof projectPathWithNamespace === "string" && projectPathWithNamespace.length > 0) {
    return projectPathWithNamespace;
  }
  const owner = event.metadata["owner"];
  const repoName = event.metadata["repo"];
  if (typeof owner === "string" && owner.length > 0 && typeof repoName === "string" && repoName.length > 0) {
    return `${owner}/${repoName}`;
  }
  return null;
}

function hasGitLabRepoTarget(event: OpenTagEvent): boolean {
  return gitlabProjectPathFromEvent(event) !== null;
}

function isLinearIssueEvent(event: OpenTagEvent): boolean {
  return event.source === "linear" || event.callback.provider === "linear";
}

function hasLinearIssueTarget(event: OpenTagEvent): boolean {
  return isLinearIssueEvent(event) && typeof event.metadata["issueId"] === "string" && event.metadata["issueId"].length > 0;
}

function hasGitHubIssueOrPullTarget(event: OpenTagEvent): boolean {
  return typeof event.metadata["issueNumber"] === "number" || typeof event.metadata["pullRequestNumber"] === "number";
}

function isRepoLevelGitHubIntent(intent: MutationIntent): boolean {
  return intent.action === "create_pull_request";
}

function stringIntentParam(intent: MutationIntent, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = intent.params?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function targetAdapterForIntent(intent: MutationIntent): string | undefined {
  return stringIntentParam(intent, "targetAdapter", "target_adapter", "adapter", "provider")?.toLowerCase();
}

function isCreateIssueIntent(intent: MutationIntent): boolean {
  return intent.action === "create_issue" || (intent.domain === "issue" && intent.action === "create");
}

function isLinearIssueCreateIntent(intent: MutationIntent): boolean {
  if (!isCreateIssueIntent(intent)) return false;
  const targetAdapter = targetAdapterForIntent(intent);
  return !targetAdapter || targetAdapter === "linear";
}

function isLinearIssueIntent(intent: MutationIntent): boolean {
  return isLinearIssueCreateIntent(intent) || intent.action !== "create_pull_request";
}

function adapterForAction(input: { event: OpenTagEvent; callbackProvider: string; selectedIntents: MutationIntent[] }): string {
  if (hasGitHubRepoTarget(input.event) &&
    (hasGitHubIssueOrPullTarget(input.event) ||
      (input.selectedIntents.length > 0 && input.selectedIntents.every((intent) => isRepoLevelGitHubIntent(intent))))
  ) {
    return "github";
  }
  if (input.selectedIntents.length > 0 && input.selectedIntents.every((intent) => isLinearIssueCreateIntent(intent))) {
    return "linear";
  }
  if (hasGitLabRepoTarget(input.event)) {
    return "gitlab";
  }
  if (hasLinearIssueTarget(input.event) && input.selectedIntents.length > 0 && input.selectedIntents.every((intent) => isLinearIssueIntent(intent))) {
    return "linear";
  }
  return input.callbackProvider;
}

function executorConditionsFromIntent(intent: { params?: Record<string, unknown> | undefined }): string[] {
  const value = intent.params?.["executorConditions"];
  if (!Array.isArray(value)) return [];
  return value.filter((condition): condition is string => typeof condition === "string" && condition.length > 0);
}

const GITHUB_PREFLIGHT_TIMEOUT_MS = 5_000;
const GITLAB_PREFLIGHT_TIMEOUT_MS = 5_000;

type GitHubPreflightCache = Map<string, Promise<ActionReceiptCapability | null>>;
type GitLabPreflightCache = Map<string, Promise<ActionReceiptCapability | null>>;

function githubPreflightCacheKey(input: { owner: string; repo: string; path: string }): string {
  return `${input.owner}/${input.repo}${input.path}`;
}

function createGitHubPreflightDeadline(timeoutMs: number): { signal?: AbortSignal; clear: () => void; didTimeout: () => boolean } {
  if (typeof AbortController === "undefined") return { clear: () => {}, didTimeout: () => false };
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
    didTimeout: () => didTimeout
  };
}

type GitHubPreflightInput = {
  githubApply: GitHubApplyOptions;
  owner: string;
  repo: string;
  path: string;
  description: string;
  notFoundReason: string;
  cache?: GitHubPreflightCache;
};

async function githubPreflight(input: GitHubPreflightInput): Promise<ActionReceiptCapability | null> {
  if (input.cache) {
    const cacheKey = githubPreflightCacheKey(input);
    const cached = input.cache.get(cacheKey);
    if (cached) return await cached;
    const pending = githubPreflightUncached(input);
    input.cache.set(cacheKey, pending);
    return await pending;
  }
  return await githubPreflightUncached(input);
}

async function githubPreflightUncached(input: Omit<GitHubPreflightInput, "cache">): Promise<ActionReceiptCapability | null> {
  let response: Response;
  const deadline = createGitHubPreflightDeadline(GITHUB_PREFLIGHT_TIMEOUT_MS);
  try {
    response = await (input.githubApply.fetchImpl ?? fetch)(`https://api.github.com/repos/${input.owner}/${input.repo}${input.path}`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.githubApply.token}`,
        "x-github-api-version": "2022-11-28"
      },
      ...(deadline.signal ? { signal: deadline.signal } : {})
    });
  } catch (error) {
    if (deadline.didTimeout()) {
      return {
        state: "needs_setup",
        setupReason: `GitHub preflight timed out for ${input.description} after ${GITHUB_PREFLIGHT_TIMEOUT_MS}ms.`
      };
    }
    return {
      state: "needs_setup",
      setupReason: `GitHub preflight failed for ${input.description}: ${error instanceof Error ? error.message : String(error)}.`
    };
  } finally {
    deadline.clear();
  }

  if (response.ok) return null;

  if (response.status === 401 || response.status === 403) {
    return {
      state: "needs_setup",
      setupReason: `GitHub apply token cannot access ${input.description}. Check repository permissions and token scopes.`
    };
  }
  if (response.status === 404) {
    return {
      state: "needs_setup",
      setupReason: input.notFoundReason
    };
  }
  return {
    state: "needs_setup",
    setupReason: `GitHub preflight failed for ${input.description}: HTTP ${response.status}.`
  };
}

async function preflightGitHubOperation(input: {
  githubApply: GitHubApplyOptions;
  target: NonNullable<ReturnType<typeof githubTargetFromEvent>>;
  operation: GitHubIssueMutationOperation;
  preflightCache?: GitHubPreflightCache;
}): Promise<ActionReceiptCapability | null> {
  const base = {
    githubApply: input.githubApply,
    owner: input.target.owner,
    repo: input.target.repoName,
    ...(input.preflightCache ? { cache: input.preflightCache } : {})
  };

  if (input.operation.kind === "create_pull_request") {
    const head = encodeURIComponent(input.operation.head);
    const baseBranch = encodeURIComponent(input.operation.base);
    const [headPreflight, basePreflight] = await Promise.all([
      githubPreflight({
        ...base,
        path: `/branches/${head}`,
        description: `GitHub branch ${input.operation.head}`,
        notFoundReason: `GitHub branch ${input.operation.head} was not found.`
      }),
      githubPreflight({
        ...base,
        path: `/branches/${baseBranch}`,
        description: `GitHub base branch ${input.operation.base}`,
        notFoundReason: `GitHub base branch ${input.operation.base} was not found.`
      })
    ]);
    return headPreflight ?? basePreflight;
  }

  if (input.operation.kind === "request_review") {
    if (typeof input.target.pullRequestNumber !== "number") {
      return {
        state: "needs_setup",
        setupReason: "The source thread does not include a GitHub pull request target."
      };
    }
    return await githubPreflight({
      ...base,
      path: `/pulls/${input.target.pullRequestNumber}`,
      description: `GitHub pull request #${input.target.pullRequestNumber}`,
      notFoundReason: `GitHub pull request #${input.target.pullRequestNumber} was not found.`
    });
  }

  if (typeof input.target.issueNumber !== "number") {
    return {
      state: "needs_setup",
      setupReason: "The source thread does not include a GitHub issue or pull request target."
    };
  }
  return await githubPreflight({
    ...base,
    path: `/issues/${input.target.issueNumber}`,
    description: `GitHub issue or pull request #${input.target.issueNumber}`,
    notFoundReason: `GitHub issue or pull request #${input.target.issueNumber} was not found.`
  });
}

function gitlabPreflightCacheKey(input: { baseUrl?: string; projectPathWithNamespace: string; path: string }): string {
  return `${normalizeGitLabBaseUrl(input.baseUrl)}:${input.projectPathWithNamespace}${input.path}`;
}

type GitLabPreflightInput = {
  gitlabApply: GitLabApplyOptions;
  projectPathWithNamespace: string;
  path: string;
  description: string;
  notFoundReason: string;
  cache?: GitLabPreflightCache;
};

async function gitlabPreflight(input: GitLabPreflightInput): Promise<ActionReceiptCapability | null> {
  if (input.cache) {
    const cacheKey = gitlabPreflightCacheKey({
      projectPathWithNamespace: input.projectPathWithNamespace,
      path: input.path,
      ...(input.gitlabApply.baseUrl ? { baseUrl: input.gitlabApply.baseUrl } : {})
    });
    const cached = input.cache.get(cacheKey);
    if (cached) return await cached;
    const pending = gitlabPreflightUncached(input);
    input.cache.set(cacheKey, pending);
    return await pending;
  }
  return await gitlabPreflightUncached(input);
}

async function gitlabPreflightUncached(input: Omit<GitLabPreflightInput, "cache">): Promise<ActionReceiptCapability | null> {
  let response: Response;
  const deadline = createGitHubPreflightDeadline(GITLAB_PREFLIGHT_TIMEOUT_MS);
  const encodedProject = encodeURIComponent(input.projectPathWithNamespace);
  try {
    response = await (input.gitlabApply.fetchImpl ?? fetch)(`${normalizeGitLabBaseUrl(input.gitlabApply.baseUrl)}/api/v4/projects/${encodedProject}${input.path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "PRIVATE-TOKEN": input.gitlabApply.token
      },
      ...(deadline.signal ? { signal: deadline.signal } : {})
    });
  } catch (error) {
    if (deadline.didTimeout()) {
      return {
        state: "needs_setup",
        setupReason: `GitLab preflight timed out for ${input.description} after ${GITLAB_PREFLIGHT_TIMEOUT_MS}ms.`
      };
    }
    return {
      state: "needs_setup",
      setupReason: `GitLab preflight failed for ${input.description}: ${error instanceof Error ? error.message : String(error)}.`
    };
  } finally {
    deadline.clear();
  }

  if (response.ok) return null;

  if (response.status === 401 || response.status === 403) {
    return {
      state: "needs_setup",
      setupReason: `GitLab apply token cannot access ${input.description}. Check project permissions and token scopes.`
    };
  }
  if (response.status === 404) {
    return {
      state: "needs_setup",
      setupReason: input.notFoundReason
    };
  }
  return {
    state: "needs_setup",
    setupReason: `GitLab preflight failed for ${input.description}: HTTP ${response.status}.`
  };
}

async function preflightGitLabOperation(input: {
  gitlabApply: GitLabApplyOptions;
  target: NonNullable<ReturnType<typeof gitlabTargetFromEvent>>;
  operation: GitLabMutationOperation;
  preflightCache?: GitLabPreflightCache;
}): Promise<ActionReceiptCapability | null> {
  if (input.operation.kind !== "create_merge_request") return null;
  const base = {
    gitlabApply: input.gitlabApply,
    projectPathWithNamespace: input.target.projectPathWithNamespace,
    ...(input.preflightCache ? { cache: input.preflightCache } : {})
  };
  const sourceBranch = encodeURIComponent(input.operation.sourceBranch);
  const targetBranch = encodeURIComponent(input.operation.targetBranch);
  const [sourcePreflight, targetPreflight] = await Promise.all([
    gitlabPreflight({
      ...base,
      path: `/repository/branches/${sourceBranch}`,
      description: `GitLab branch ${input.operation.sourceBranch}`,
      notFoundReason: `GitLab branch ${input.operation.sourceBranch} was not found.`
    }),
    gitlabPreflight({
      ...base,
      path: `/repository/branches/${targetBranch}`,
      description: `GitLab target branch ${input.operation.targetBranch}`,
      notFoundReason: `GitLab target branch ${input.operation.targetBranch} was not found.`
    })
  ]);
  return sourcePreflight ?? targetPreflight;
}

async function directApplyReceiptCapability(input: {
  event: OpenTagEvent;
  callbackProvider: string;
  intent: MutationIntent;
  githubApply?: GitHubApplyOptions;
  gitlabApply?: GitLabApplyOptions;
  linearApply?: LinearApplyOptions;
  preflightCache?: GitHubPreflightCache;
  gitlabPreflightCache?: GitLabPreflightCache;
}): Promise<ActionReceiptCapability> {
  const capability = capabilityForMutationIntent(input.intent);
  if (!capability) {
    return {
      state: "unsupported",
      setupReason: `No source-thread apply capability is registered for ${input.intent.action}.`
    };
  }
  if (capability.capabilityClass !== "external_write") {
    return {
      state: "unsupported",
      setupReason: "This action is audit-only for now; continue if a follow-up run should handle it."
    };
  }

  const adapter = adapterForAction({
    event: input.event,
    callbackProvider: input.callbackProvider,
    selectedIntents: [input.intent]
  });
  if (adapter !== "github" && adapter !== "gitlab" && adapter !== "linear") {
    return {
      state: "needs_setup",
      setupReason: `Direct apply for ${adapter} actions is not configured on this dispatcher.`
    };
  }
  if (!permissionScopesAllowCapability(input.event.permissions ?? [], capability)) {
    return {
      state: "needs_setup",
      setupReason: `Missing platform permission for ${capability.id}.`
    };
  }

  const missingExecutorConditions = (capability.requiredExecutorConditions ?? []).filter(
    (condition) => !executorConditionsFromIntent(input.intent).includes(condition)
  );
  if (missingExecutorConditions.length > 0) {
    return {
      state: "needs_setup",
      setupReason: `Missing executor condition: ${missingExecutorConditions.join(", ")}.`
    };
  }

  if (adapter === "github") {
    if (!input.githubApply) {
      return {
        state: "needs_setup",
        setupReason: "GitHub apply is not configured on this dispatcher."
      };
    }
    if (!hasGitHubRepoTarget(input.event)) {
      return {
        state: "needs_setup",
        setupReason: "The source thread does not include a GitHub repository target."
      };
    }
    if (!isRepoLevelGitHubIntent(input.intent) && !hasGitHubIssueOrPullTarget(input.event)) {
      return {
        state: "needs_setup",
        setupReason: "The source thread does not include a GitHub issue or pull request target."
      };
    }
    const githubTarget = githubTargetFromEvent(input.event);
    if (!githubTarget) {
      return {
        state: "needs_setup",
        setupReason: "The source thread does not include a GitHub repository target."
      };
    }
    const compilation = createGitHubIssueMutationCompiler({
      ...(githubTarget?.targetKind ? { targetKind: githubTarget.targetKind } : {})
    }).compile(input.intent);
    if (!compilation.ok) {
      return {
        state: compilation.outcome.outcome === "unsupported" ? "unsupported" : "needs_setup",
        setupReason: compilation.outcome.message ?? "GitHub cannot apply this action from the current source thread."
      };
    }

    const preflight = await preflightGitHubOperation({
      githubApply: input.githubApply,
      target: githubTarget,
      operation: compilation.operation as GitHubIssueMutationOperation,
      ...(input.preflightCache ? { preflightCache: input.preflightCache } : {})
    });
    if (preflight) return preflight;
    return { state: "ready_to_apply" };
  }

  if (adapter === "linear") {
    if (!input.linearApply) {
      return {
        state: "needs_setup",
        setupReason: "Linear apply is not configured on this dispatcher."
      };
    }
    const compilation = createLinearMutationCompiler({
      ...(input.linearApply.mappings ? { mappings: input.linearApply.mappings } : {})
    }).compile(input.intent);
    if (!compilation.ok) {
      return {
        state: compilation.outcome.outcome === "unsupported" ? "unsupported" : "needs_setup",
        setupReason: compilation.outcome.message ?? "Linear cannot apply this action from the current source thread."
      };
    }
    const operation = compilation.operation as LinearMutationOperation;
    if (operation.kind !== "create_issue" && !linearTargetFromEvent(input.event)) {
      return {
        state: "needs_setup",
        setupReason: "The source thread does not include a Linear issue target."
      };
    }
    return { state: "ready_to_apply", targetLabel: "Linear issue" };
  }

  if (!input.gitlabApply) {
    return {
      state: "needs_setup",
      setupReason: "GitLab apply is not configured on this dispatcher."
    };
  }
  const gitlabTarget = gitlabTargetFromEvent(input.event);
  if (!gitlabTarget) {
    return {
      state: "needs_setup",
      setupReason: "The source thread does not include a GitLab project target."
    };
  }
  const compilation = createGitLabMutationCompiler().compile(input.intent);
  if (!compilation.ok) {
    return {
      state: compilation.outcome.outcome === "unsupported" ? "unsupported" : "needs_setup",
      setupReason: compilation.outcome.message ?? "GitLab cannot apply this action from the current source thread."
    };
  }
  const preflight = await preflightGitLabOperation({
    gitlabApply: input.gitlabApply,
    target: gitlabTarget,
    operation: compilation.operation as GitLabMutationOperation,
    ...(input.gitlabPreflightCache ? { preflightCache: input.gitlabPreflightCache } : {})
  });
  if (preflight) return preflight;

  return { state: "ready_to_apply", targetLabel: "GitLab merge request" };
}

async function actionReceiptContextForFinal(input: {
  event: OpenTagEvent;
  result: OpenTagRunResult;
  githubApply?: GitHubApplyOptions;
  gitlabApply?: GitLabApplyOptions;
  linearApply?: LinearApplyOptions;
}): Promise<ActionReceiptContext> {
  const preflightCache: GitHubPreflightCache = new Map();
  const gitlabPreflightCache: GitLabPreflightCache = new Map();
  const capabilityEntries = await Promise.all(
    (input.result.suggestedChanges ?? []).flatMap((snapshot) =>
      snapshot.intents.map(async (intent) => {
        const capability = await directApplyReceiptCapability({
          event: input.event,
          callbackProvider: input.event.callback.provider,
          intent,
          ...(input.githubApply ? { githubApply: input.githubApply } : {}),
          ...(input.gitlabApply ? { gitlabApply: input.gitlabApply } : {}),
          ...(input.linearApply ? { linearApply: input.linearApply } : {}),
          preflightCache,
          gitlabPreflightCache
        });
        return [intent.intentId, capability] as const;
      })
    )
  );
  return { capabilityByIntentId: Object.fromEntries(capabilityEntries) };
}

function threadActionChannelBindingMismatch(): { ok: false; reason: string; message: string } {
  return {
    ok: false,
    reason: "channel_binding_mismatch",
    message: "The source channel binding is missing or no longer points at the proposal repository."
  };
}

function baseTeamsConversationId(conversationId: string): string {
  return conversationId.replace(/;messageid=[^;]+$/i, "");
}

async function getTeamsThreadActionChannelBinding(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  tenantId: string;
  conversationId: string;
}) {
  const exactBinding = await input.repo.getChannelBinding({
    provider: "teams",
    accountId: input.tenantId,
    conversationId: input.conversationId
  });

  const baseConversationId = baseTeamsConversationId(input.conversationId);
  if (baseConversationId === input.conversationId) return exactBinding;

  const baseBinding = await input.repo.getChannelBinding({
    provider: "teams",
    accountId: input.tenantId,
    conversationId: baseConversationId
  });
  if (
    exactBinding &&
    baseBinding &&
    (exactBinding.repoProvider !== baseBinding.repoProvider ||
      exactBinding.owner !== baseBinding.owner ||
      exactBinding.repo !== baseBinding.repo)
  ) {
    return null;
  }

  return exactBinding ?? baseBinding;
}

async function authorizeThreadAction(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  resolved: ResolvedThreadAction;
  actor: ActorIdentity;
}): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  const repoKey = projectTargetRefFromEvent(input.resolved.proposal.event);
  if (!repoKey) {
    const event = input.resolved.proposal.event;
    const metadata = event.metadata ?? {};
    const accountId = metadataString(metadata, "accountId") ?? metadataString(metadata, "teamId") ?? metadataString(metadata, "tenantKey") ?? metadataString(metadata, "botId");
    const conversationId = metadataString(metadata, "conversationId") ?? metadataString(metadata, "channelId") ?? metadataString(metadata, "chatId");
    if (!accountId || !conversationId || input.actor.provider !== event.source) {
      return { ok: false, reason: "channel_identity_missing", message: "The non-repository proposal does not resolve to a managed source-channel identity." };
    }
    const channelBinding = await input.repo.getChannelBinding({ provider: event.source, accountId, conversationId });
    if (!channelBinding || channelBinding.repoProvider || channelBinding.owner || channelBinding.repo) {
      return { ok: false, reason: "channel_binding_mismatch", message: "The non-repository proposal is not owned by the expected managed channel binding." };
    }
    const allowedActors = Array.isArray(channelBinding.metadata?.["allowedActors"])
      ? channelBinding.metadata["allowedActors"].filter((value): value is string => typeof value === "string")
      : undefined;
    if (!actorAllowedByList(input.actor, allowedActors)) {
      return { ok: false, reason: "actor_not_allowed", message: "This actor is not allowed to approve actions for the managed channel." };
    }
    return { ok: true };
  }

  const binding = await input.repo.getRepoBinding(repoKey);
  if (!binding) {
    return { ok: false, reason: "repo_binding_not_found", message: "No repository binding is configured for this proposal." };
  }

  if (!actorAllowedByList(input.actor, binding.allowedActors)) {
    return {
      ok: false,
      reason: "actor_not_allowed",
      message: "This actor is not allowed to approve or apply actions for the bound repository."
    };
  }

  // Same default as run admission: without an explicit allowlist, approvals
  // arriving from a public GitHub/GitLab thread require platform-reported
  // write access, so a drive-by commenter cannot approve a pending action.
  if (
    !binding.allowedActors?.length &&
    sourceRepoIsPublic(input.resolved.proposal.event) &&
    input.actor.writeAccess !== true
  ) {
    return {
      ok: false,
      reason: "actor_not_allowed",
      message: "This repository is public, so only actors with write access can approve or apply actions."
    };
  }

  if (input.resolved.proposal.event.source === "slack") {
    const teamId = input.resolved.proposal.event.metadata["teamId"];
    const channelId = input.resolved.proposal.event.metadata["channelId"];
    if (typeof teamId === "string" && typeof channelId === "string") {
      const channelBinding = await input.repo.getChannelBinding({
        provider: "slack",
        accountId: teamId,
        conversationId: channelId
      });
      if (
        !channelBinding ||
        channelBinding.repoProvider !== repoKey.provider ||
        channelBinding.owner !== repoKey.owner ||
        channelBinding.repo !== repoKey.repo
      ) {
        return threadActionChannelBindingMismatch();
      }
    }
  }

  if (input.resolved.proposal.event.source === "teams") {
    const tenantId = input.resolved.proposal.event.metadata["tenantId"];
    const conversationId = input.resolved.proposal.event.metadata["conversationId"];
    if (typeof tenantId !== "string" || !tenantId.trim() || typeof conversationId !== "string" || !conversationId.trim()) {
      return threadActionChannelBindingMismatch();
    }

    const channelBinding = await getTeamsThreadActionChannelBinding({
      repo: input.repo,
      tenantId,
      conversationId
    });

    if (
      !channelBinding ||
      channelBinding.repoProvider !== repoKey.provider ||
      channelBinding.owner !== repoKey.owner ||
      channelBinding.repo !== repoKey.repo
    ) {
      return threadActionChannelBindingMismatch();
    }
  }

  return { ok: true };
}

function stableApprovalId(input: {
  providedId?: string;
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  actor: ActorIdentity;
}): string {
  return input.providedId ?? stableId("approval", [
    input.resolved.proposal.snapshot.proposalId,
    input.command.verb,
    [...input.resolved.selectedIntentIds].sort(),
    actorKeys(input.actor).sort()
  ]);
}

function sortedValues(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

function sameStringSet(left: string[] | undefined, right: string[] | undefined): boolean {
  return JSON.stringify(sortedValues(left)) === JSON.stringify(sortedValues(right));
}

function sameActor(left: ActorIdentity, right: ActorIdentity): boolean {
  return left.provider === right.provider &&
    left.providerUserId === right.providerUserId &&
    (left.handle ?? "") === (right.handle ?? "") &&
    (left.organizationId ?? "") === (right.organizationId ?? "");
}

function approvalDecisionMatchesThreadAction(input: {
  decision: NonNullable<Awaited<ReturnType<ReturnType<typeof createOpenTagRepository>["getApprovalDecision"]>>>;
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  actor: ActorIdentity;
}): boolean {
  const approvedIntentIds = input.command.verb === "reject" ? [] : input.resolved.selectedIntentIds;
  const rejectedIntentIds = input.command.verb === "reject" ? input.resolved.selectedIntentIds : [];
  const metadata = input.decision.metadata;
  const verb = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata["verb"] : undefined;
  return input.decision.proposalId === input.resolved.proposal.snapshot.proposalId &&
    sameStringSet(input.decision.approvedIntentIds, approvedIntentIds) &&
    sameStringSet(input.decision.rejectedIntentIds, rejectedIntentIds) &&
    sameActor(input.decision.approvedBy, input.actor) &&
    verb === input.command.verb;
}

function stableApplyPlanId(input: { resolved: ResolvedThreadAction; adapter: string }): string {
  return stableId("apply", [
    input.resolved.proposal.snapshot.proposalId,
    input.adapter,
    [...input.resolved.selectedIntentIds].sort()
  ]);
}

function stableChildRunId(input: {
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  sourceApplyPlanId?: string;
  fallbackReason?: string;
}): string {
  return stableId("run_child", [
    input.resolved.proposal.runId,
    input.resolved.proposal.snapshot.proposalId,
    input.command.verb,
    [...input.resolved.selectedIntentIds].sort(),
    input.sourceApplyPlanId ?? "",
    input.fallbackReason ?? ""
  ]);
}

function selectedIntentsAlreadyApplied(input: { plan: ApplyPlan; selectedIntentIds: string[] }): boolean {
  return input.selectedIntentIds.every((intentId) =>
    input.plan.outcomes?.some((outcome) => outcome.intentId === intentId && outcome.outcome === "applied")
  );
}

function selectedPlanOutcomes(input: { plan: ApplyPlan; selectedIntentIds: string[] }): ApplyIntentOutcome[] {
  return (input.plan.outcomes ?? []).filter((outcome) => input.selectedIntentIds.includes(outcome.intentId));
}

function selectedIntentsHaveStaleOutcome(input: { plan: ApplyPlan; selectedIntentIds: string[] }): boolean {
  const outcomes = selectedPlanOutcomes(input);
  return outcomes.some((outcome) => outcome.outcome === "stale") && outcomes.every((outcome) => outcome.outcome !== "applied");
}

function githubTargetFromEvent(event: OpenTagEvent):
  | {
      owner: string;
      repoName: string;
      issueNumber?: number;
      pullRequestNumber?: number;
      targetKind?: "issue" | "pull_request";
    }
  | null {
  const owner = event.metadata["owner"];
  const repoName = event.metadata["repo"];
  const issueNumber = event.metadata["issueNumber"];
  const pullRequestNumber = event.metadata["pullRequestNumber"];
  if (!hasGitHubRepoTarget(event)) return null;
  if (typeof owner !== "string" || typeof repoName !== "string") return null;
  if (typeof pullRequestNumber === "number") {
    return { owner, repoName, issueNumber: pullRequestNumber, pullRequestNumber, targetKind: "pull_request" };
  }
  if (typeof issueNumber === "number") {
    return { owner, repoName, issueNumber, targetKind: "issue" };
  }
  return { owner, repoName };
}

function gitlabTargetFromEvent(event: OpenTagEvent): { projectPathWithNamespace: string } | null {
  const projectPathWithNamespace = gitlabProjectPathFromEvent(event);
  return projectPathWithNamespace ? { projectPathWithNamespace } : null;
}

function linearTargetFromEvent(event: OpenTagEvent): { issueId: string; graphqlUrl?: string } | null {
  const issueId = event.metadata["issueId"];
  if (typeof issueId !== "string" || issueId.length === 0) return null;
  const graphqlUrl = event.metadata["graphqlUrl"];
  return {
    issueId,
    ...(typeof graphqlUrl === "string" && graphqlUrl.length > 0 ? { graphqlUrl } : {})
  };
}

function selectedActionSummary(candidates: ResolvedThreadAction["selectedCandidates"]): string {
  return candidates.map((candidate) => `${candidate.index}. ${candidate.intent.summary}`).join("; ");
}

function selectedActionReceiptTitle(selectionText: string): string {
  return selectionText
    .split(";")
    .map((part) => part.trim().replace(/^\d+\.\s*/, ""))
    .filter(Boolean)
    .join("; ");
}

function sentenceWithTerminalPunctuation(value: string): string {
  return /[.!?。！？]$/u.test(value) ? value : `${value}.`;
}

function addPermissionGrant(permissions: PermissionGrant[], grant: PermissionGrant): PermissionGrant[] {
  if (permissions.some((permission) => permission.scope === grant.scope)) return permissions;
  return [...permissions, grant];
}

function childRunPermissionsForThreadAction(input: { resolved: ResolvedThreadAction; command: ThreadActionCommand }): PermissionGrant[] {
  let permissions = [...(input.resolved.proposal.event.permissions ?? [])];
  if (input.command.verb === "apply" || input.command.verb === "continue") {
    permissions = addPermissionGrant(permissions, {
      scope: "repo:read",
      reason: "inspect the repository while continuing an approved source-thread action"
    });
    permissions = addPermissionGrant(permissions, {
      scope: "repo:write",
      reason: "apply an approved source-thread mutation on a run branch"
    });
  }
  if (input.resolved.selectedCandidates.some((candidate) => candidate.intent.action === "create_pull_request")) {
    permissions = addPermissionGrant(permissions, {
      scope: "pr:create",
      reason: "create the pull request approved in the source thread"
    });
  }
  return permissions;
}

function renderChildRunCreatedBody(input: {
  lead: string;
  resolved: ResolvedThreadAction;
  childRun: OpenTagRun;
  provider?: string;
  selectionText?: string;
  approvalDecisionId?: string;
  sourceApplyPlanId?: string;
  fallbackReason?: string;
}): string {
  const title = selectedActionReceiptTitle(input.selectionText ?? selectedActionSummary(input.resolved.selectedCandidates));
  if (input.provider === "slack") {
    return [
      input.lead,
      `Action: ${title}`,
      ...(input.fallbackReason ? [`Reason: ${input.fallbackReason}`] : [])
    ].join("\n");
  }
  return [
    input.lead,
    "",
    `Action: ${title}`,
    "",
    `Child run: \`${input.childRun.id}\``,
    "",
    ...(input.fallbackReason ? [`Reason: ${input.fallbackReason}`, ""] : []),
    `Audit: run \`opentag status --run ${input.childRun.id}\` locally.`
  ].join("\n");
}

function applyOutcomeSummary(outcome: ApplyIntentOutcome): string {
  if (outcome.externalUri) return `${outcome.outcome}: ${outcome.externalUri}`;
  if (outcome.message) return `${outcome.outcome}: ${outcome.message}`;
  return `${outcome.outcome}.`;
}

function applyOutcomeReceiptLines(outcomes: ApplyIntentOutcome[]): string[] {
  if (outcomes.length === 0) return ["Result: applied."];
  if (outcomes.length === 1) {
    const outcome = outcomes[0]!;
    if (outcome.externalUri) return [`Result: ${outcome.externalUri}`];
    if (outcome.message) return [`Result: ${outcome.outcome}. ${outcome.message}`];
    return [`Result: ${outcome.outcome}.`];
  }
  return ["Results:", ...outcomes.map((outcome) => `- ${applyOutcomeSummary(outcome)}`)];
}

function sanitizeApplyFailureDetail(detail: unknown): string {
  return redactCredentialLikeData(String(detail ?? ""))
    .replace(/\/Users\/[A-Za-z0-9._-]+\/(?:repos|Library|Desktop|Downloads|\.config)\/[^\s"'`]+/g, "[redacted local path]")
    .replace(/\/(?:home|root)\/[A-Za-z0-9._-]+\/[^\s"'`]+/g, "[redacted local path]")
    .replace(/[A-Za-z]:\\Users\\[^\s"'`]+/g, "[redacted local path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function sanitizeApplyOutcomeForStorage(outcome: ApplyIntentOutcome): ApplyIntentOutcome {
  return {
    ...outcome,
    ...(outcome.message ? { message: sanitizeApplyFailureDetail(outcome.message) } : {}),
    ...(outcome.error ? { error: sanitizeApplyFailureDetail(outcome.error) } : {})
  };
}

function applyFallbackReason(input: { plan: ApplyPlan; selectedIntentIds: string[] }): string {
  const selected = (input.plan.outcomes ?? []).filter((outcome) => input.selectedIntentIds.includes(outcome.intentId));
  const failed = selected.find((outcome) => outcome.outcome === "failed");
  if (failed) {
    const detail = failed.message ?? failed.error;
    return detail ? `Direct apply failed: ${sanitizeApplyFailureDetail(detail)}` : "Direct apply failed.";
  }
  const unsupported = selected.find((outcome) => outcome.outcome === "unsupported");
  if (unsupported) {
    const detail = unsupported.message ?? unsupported.error;
    return detail ? `Direct apply is unsupported: ${sanitizeApplyFailureDetail(detail)}` : "Direct apply is unsupported for this action.";
  }
  return "Some selected intents were not directly applied.";
}

function renderAppliedThreadActionBody(input: {
  selectionText: string;
  selectedIntentIds: string[];
  outcomes: ApplyIntentOutcome[];
}): string {
  const selectedOutcomes = input.outcomes.filter((outcome) => input.selectedIntentIds.includes(outcome.intentId));
  return [`Applied: ${sentenceWithTerminalPunctuation(selectedActionReceiptTitle(input.selectionText))}`, ...applyOutcomeReceiptLines(selectedOutcomes)].join("\n");
}

function renderAlreadyAppliedThreadActionBody(input: { selectionText: string }): string {
  return [`Already applied: ${sentenceWithTerminalPunctuation(selectedActionReceiptTitle(input.selectionText))}`, "No external write was repeated."].join("\n");
}

function renderAlreadyPlannedThreadActionBody(input: { selectionText: string }): string {
  return [`Already planned: ${sentenceWithTerminalPunctuation(selectedActionReceiptTitle(input.selectionText))}`, "OpenTag did not execute this repeated reply."].join("\n");
}

function renderStaleThreadActionBody(input: { selectionText: string; continueIndex: number }): string {
  return [
    `Stale: ${sentenceWithTerminalPunctuation(selectedActionReceiptTitle(input.selectionText))}`,
    "The target changed since this action was proposed.",
    `Reply \`continue ${input.continueIndex}\` to refresh from the current thread state.`
  ].join("\n");
}

function renderThreadActionRecordedBody(input: {
  verb: "approve" | "reject";
  selectionText: string;
  applyIndex?: number;
  directApply?: { ready: boolean; reason?: string };
}): string {
  const title = selectedActionReceiptTitle(input.selectionText);
  if (input.verb === "approve") {
    const index = input.applyIndex ?? 1;
    const nextLines = input.directApply?.ready
      ? [`Next: reply \`apply ${index}\` to write it to the system of record, or \`continue ${index}\` to continue in OpenTag.`]
      : [
          ...(input.directApply?.reason
            ? [`Direct apply is not available yet: ${sentenceWithTerminalPunctuation(input.directApply.reason)}`]
            : ["Direct apply is not available yet."]),
          `Next: reply \`continue ${index}\` to continue in OpenTag.`
        ];
    return [
      `Approved only: ${sentenceWithTerminalPunctuation(title)}`,
      "No external write was performed.",
      ...nextLines
    ].join("\n");
  }
  return [`Rejected: ${sentenceWithTerminalPunctuation(title)}`, "No external write will be performed for this action."].join("\n");
}

type GovernedPermissionDecision = "allow_once" | "allow_run" | "deny";

function governedPermissionDecision(value: unknown): GovernedPermissionDecision | undefined {
  return value === "allow_once" || value === "allow_run" || value === "deny" ? value : undefined;
}

function renderGovernedPermissionDecisionBody(input: {
  decision: GovernedPermissionDecision;
  selectionText: string;
}): string {
  const title = sentenceWithTerminalPunctuation(
    selectedActionReceiptTitle(input.selectionText).replace(/^Allow\s+/iu, "")
  );
  if (input.decision === "allow_once") {
    return [`Allowed once: ${title}`, "Permission recorded for this attempt. The agent may now perform this governed action."].join("\n");
  }
  if (input.decision === "allow_run") {
    return [`Allowed for this run: ${title}`, "Permission recorded for this run. The agent may now perform this governed action."].join("\n");
  }
  return [`Denied: ${title}`, "The agent was not allowed to perform this governed action."].join("\n");
}

async function selectedDirectApplyStatus(input: {
  event: OpenTagEvent;
  callbackProvider: string;
  candidates: ResolvedThreadAction["selectedCandidates"];
  githubApply?: GitHubApplyOptions;
  gitlabApply?: GitLabApplyOptions;
  linearApply?: LinearApplyOptions;
}): Promise<{ ready: boolean; reason?: string }> {
  if (input.candidates.length === 0) return { ready: false, reason: "No selected action was found." };
  const preflightCache: GitHubPreflightCache = new Map();
  const gitlabPreflightCache: GitLabPreflightCache = new Map();
  for (const candidate of input.candidates) {
    const capability = await directApplyReceiptCapability({
      event: input.event,
      callbackProvider: input.callbackProvider,
      intent: candidate.intent,
      ...(input.githubApply ? { githubApply: input.githubApply } : {}),
      ...(input.gitlabApply ? { gitlabApply: input.gitlabApply } : {}),
      ...(input.linearApply ? { linearApply: input.linearApply } : {}),
      preflightCache,
      gitlabPreflightCache
    });
    if (capability.state !== "ready_to_apply") {
      return {
        ready: false,
        reason: capability.setupReason ?? `Receipt state is ${capability.state}.`
      };
    }
  }
  return { ready: true };
}

function actionContextPointer(input: {
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  approvalDecisionId?: string;
  applyPlanId?: string;
  fallbackReason?: string;
}): OpenTagEvent["context"][number] {
  const lines = [
    "OpenTag thread action continuation.",
    `User reply: ${input.command.rawText}`,
    `Action: ${input.command.verb}`,
    `Proposal: ${input.resolved.proposal.snapshot.proposalId}`,
    `Proposal summary: ${input.resolved.proposal.snapshot.summary}`,
    `Selected actions: ${selectedActionSummary(input.resolved.selectedCandidates)}`,
    `Selected intents: ${input.resolved.selectedIntentIds.join(", ")}`,
    `Previous run: ${input.resolved.proposal.runId}`,
    `Previous summary: ${input.resolved.proposal.run.result?.summary ?? input.resolved.proposal.snapshot.summary}`
  ];
  if (input.approvalDecisionId) lines.push(`Approval decision: ${input.approvalDecisionId}`);
  if (input.applyPlanId) lines.push(`Apply plan: ${input.applyPlanId}`);
  if (input.fallbackReason) lines.push(`Fallback reason: ${input.fallbackReason}`);
  return {
    kind: "text",
    uri: lines.join("\n"),
    visibility: input.resolved.proposal.event.source === "github" ? "public" : "organization",
    title: "OpenTag approved action context"
  };
}

async function createChildRunForThreadAction(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  runId?: string;
  approvalDecisionId?: string;
  sourceApplyPlanId?: string;
  fallbackReason?: string;
}): Promise<OpenTagRun> {
  const runId = input.runId ?? stableChildRunId(input);
  const action = ActionHintSchema.parse({
    kind: "apply_suggested_changes",
    targetId: input.resolved.proposal.snapshot.proposalId,
    selectedIntentIds: input.resolved.selectedIntentIds,
    metadata: {
      threadActionVerb: input.command.verb,
      rawText: input.command.rawText,
      ...(input.command.reason ? { reason: input.command.reason } : {}),
      ...(input.approvalDecisionId ? { approvalDecisionId: input.approvalDecisionId } : {}),
      ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {})
    }
  });
  const previousRunSummary = input.resolved.proposal.run.result?.summary ?? input.resolved.proposal.snapshot.summary;
  const commandText =
    input.command.verb === "continue"
      ? `Continue approved OpenTag action: ${selectedActionSummary(input.resolved.selectedCandidates)}`
      : `Continue because OpenTag could not directly apply approved action: ${selectedActionSummary(input.resolved.selectedCandidates)}`;
  const { run } = await input.repo.createRun({
    id: runId,
    event: childEventFromParent({
      parentEvent: input.resolved.proposal.event,
      childRunId: runId,
      actionKind: action.kind,
      commandText,
      receivedAt: new Date().toISOString(),
      extraContext: [
        actionContextPointer({
          command: input.command,
          resolved: input.resolved,
          ...(input.approvalDecisionId ? { approvalDecisionId: input.approvalDecisionId } : {}),
          ...(input.sourceApplyPlanId ? { applyPlanId: input.sourceApplyPlanId } : {}),
          ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {})
        })
      ],
      metadata: {
        parentRunId: input.resolved.proposal.runId,
        sourceProposalId: input.resolved.proposal.snapshot.proposalId,
        selectedIntentIds: input.resolved.selectedIntentIds,
        threadActionVerb: input.command.verb,
        previousRunSummary,
        ...(input.approvalDecisionId ? { approvalDecisionId: input.approvalDecisionId } : {}),
        ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {}),
        ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {})
      },
      permissions: childRunPermissionsForThreadAction({ resolved: input.resolved, command: input.command })
    }),
    parentRunId: input.resolved.proposal.runId,
    triggeredByAction: action,
    rejectIfAutomaticContinuationActive: true,
    sourceProposalId: input.resolved.proposal.snapshot.proposalId,
    ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {})
  });
  return run;
}

export type CallbackMessage = {
  runId: string;
  kind: "acknowledgement" | "progress" | "final";
  provider: string;
  uri: string;
  body: string;
  idempotencyKey?: string;
  agentId?: string;
  threadKey?: string;
  statusMessageKey?: string;
  externalMessageId?: string;
  blocks?: SlackBlock[];
  rich?: {
    provider: string;
    payload: unknown;
  };
};

export type CallbackDeliveryResult = {
  externalMessageId?: string;
};

export type CallbackSink = {
  deliver(message: CallbackMessage): Promise<void | CallbackDeliveryResult>;
};

export type SourceReceiptState = "received" | "running";

export type SourceReceiptDelivery = {
  delivered: boolean;
};

export type SourceReceipt = {
  runId: string;
  provider: string;
  state: SourceReceiptState;
  event: OpenTagEvent;
  agentId?: string;
};

export type SourceReceiptSink = {
  deliver(receipt: SourceReceipt): Promise<SourceReceiptDelivery>;
};

export type CallbackRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: Date;
};

export type GitHubApplyOptions = {
  token: string;
  fetchImpl?: GitHubFetchLike;
};

export type GitLabApplyOptions = {
  token: string;
  baseUrl?: string;
  fetchImpl?: GitLabFetchLike;
};

export type LinearApplyOptions = {
  token?: string;
  getToken?: () => Promise<string | undefined> | string | undefined;
  graphqlUrl?: string;
  mappings?: AdapterMutationMapping[];
  fetchImpl?: LinearFetchLike;
};

async function resolveLinearApplyToken(input: LinearApplyOptions): Promise<string | undefined> {
  const token = input.getToken ? await input.getToken() : input.token;
  return token?.trim() ? token : undefined;
}

function executableIntentsForPlan(input: { plan: ApplyPlan; resolved: ResolvedThreadAction }): MutationIntent[] {
  const preflightOutcomeByIntentId = new Map((input.plan.outcomes ?? []).map((outcome) => [outcome.intentId, outcome]));
  return input.resolved.proposal.snapshot.intents.filter((intent) => {
    if (!input.resolved.selectedIntentIds.includes(intent.intentId)) return false;
    const outcome = preflightOutcomeByIntentId.get(intent.intentId);
    return outcome?.outcome === "skipped" && outcome.message?.startsWith("Preflight passed");
  });
}

async function updateExecutedApplyPlan(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  plan: ApplyPlan;
  resolved: ResolvedThreadAction;
  executedOutcomes: ApplyIntentOutcome[];
}): Promise<{ plan: ApplyPlan; executed: boolean; fallbackReason?: string }> {
  const executedOutcomeByIntentId = new Map(input.executedOutcomes.map((outcome) => {
    const sanitized = sanitizeApplyOutcomeForStorage(outcome);
    return [sanitized.intentId, sanitized];
  }));
  const mergedOutcomes = (input.plan.outcomes ?? []).map((outcome) => executedOutcomeByIntentId.get(outcome.intentId) ?? outcome);
  const updated = await input.repo.updateApplyPlanOutcomes({
    id: input.plan.id,
    outcomes: mergedOutcomes,
    externalWritesExecuted: true
  });
  const plan = updated ?? input.plan;
  const allSelectedApplied = input.resolved.selectedIntentIds.every((intentId) =>
    plan.outcomes?.some((outcome) => outcome.intentId === intentId && outcome.outcome === "applied")
  );
  return {
    plan,
    executed: allSelectedApplied,
    ...(allSelectedApplied ? {} : { fallbackReason: applyFallbackReason({ plan, selectedIntentIds: input.resolved.selectedIntentIds }) })
  };
}

async function executeDirectApplyPlan(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  plan: ApplyPlan;
  resolved: ResolvedThreadAction;
  githubApply?: GitHubApplyOptions;
  gitlabApply?: GitLabApplyOptions;
  linearApply?: LinearApplyOptions;
}): Promise<{ plan: ApplyPlan; executed: boolean; fallbackReason?: string }> {
  if (input.plan.adapter !== "github" && input.plan.adapter !== "gitlab" && input.plan.adapter !== "linear") {
    return { plan: input.plan, executed: false, fallbackReason: `Adapter ${input.plan.adapter ?? "unknown"} is not directly executable yet.` };
  }

  const executableIntents = executableIntentsForPlan(input);
  if (executableIntents.length === 0) {
    return { plan: input.plan, executed: false, fallbackReason: "No selected intent has a direct adapter execution path." };
  }

  if (input.plan.adapter === "gitlab") {
    if (!input.gitlabApply) {
      return { plan: input.plan, executed: false, fallbackReason: "GitLab apply is not configured on this dispatcher." };
    }
    const target = gitlabTargetFromEvent(input.resolved.proposal.event);
    if (!target) {
      return { plan: input.plan, executed: false, fallbackReason: "The source run does not include a GitLab project target." };
    }

    const executedOutcomes: ApplyIntentOutcome[] = [];
    const compilerRegistry = createAdapterMutationCompilerRegistry([createGitLabMutationCompiler()]);
    for (const compilation of compilerRegistry.compile("gitlab", executableIntents)) {
      if (!compilation.ok) {
        executedOutcomes.push(compilation.outcome);
        continue;
      }
      executedOutcomes.push(
        await applyGitLabMutationOperation({
          target: {
            token: input.gitlabApply.token,
            projectPathWithNamespace: target.projectPathWithNamespace,
            ...(input.gitlabApply.baseUrl ? { baseUrl: input.gitlabApply.baseUrl } : {})
          },
          operation: compilation.operation as GitLabMutationOperation,
          ...(input.gitlabApply.fetchImpl ? { fetchImpl: input.gitlabApply.fetchImpl } : {})
        })
      );
    }
    return await updateExecutedApplyPlan({ repo: input.repo, plan: input.plan, resolved: input.resolved, executedOutcomes });
  }

  if (input.plan.adapter === "linear") {
    if (!input.linearApply) {
      return { plan: input.plan, executed: false, fallbackReason: "Linear apply is not configured on this dispatcher." };
    }
    const linearToken = await resolveLinearApplyToken(input.linearApply);
    if (!linearToken) {
      return { plan: input.plan, executed: false, fallbackReason: "Linear apply token is not available on this dispatcher." };
    }
    const target = linearTargetFromEvent(input.resolved.proposal.event);

    const executedOutcomes: ApplyIntentOutcome[] = [];
    const compilerRegistry = createAdapterMutationCompilerRegistry([
      createLinearMutationCompiler({
        mappings: mappingsForAdapterPlan(input.plan.adapterPlan, input.linearApply.mappings)
      })
    ]);
    for (const compilation of compilerRegistry.compile("linear", executableIntents)) {
      if (!compilation.ok) {
        executedOutcomes.push(compilation.outcome);
        continue;
      }
      const operation = compilation.operation as LinearMutationOperation;
      if (operation.kind !== "create_issue" && !target) {
        executedOutcomes.push({
          intentId: compilation.intentId,
          outcome: "failed",
          message: "The source run does not include a Linear issue target."
        });
        continue;
      }
      const linearGraphqlUrl = input.linearApply.graphqlUrl ?? target?.graphqlUrl;
      executedOutcomes.push(
        await applyLinearMutationOperation({
          target: {
            token: linearToken,
            ...(target?.issueId ? { issueId: target.issueId } : {}),
            ...(linearGraphqlUrl ? { graphqlUrl: linearGraphqlUrl } : {})
          },
          operation,
          ...(input.linearApply.fetchImpl ? { fetchImpl: input.linearApply.fetchImpl } : {})
        })
      );
    }
    return await updateExecutedApplyPlan({ repo: input.repo, plan: input.plan, resolved: input.resolved, executedOutcomes });
  }

  if (!input.githubApply) {
    return { plan: input.plan, executed: false, fallbackReason: "GitHub apply is not configured on this dispatcher." };
  }
  const target = githubTargetFromEvent(input.resolved.proposal.event);
  if (!target) {
    return { plan: input.plan, executed: false, fallbackReason: "The source run does not include a GitHub issue or pull request target." };
  }

  const executedOutcomes: ApplyIntentOutcome[] = [];
  const compilerRegistry = createAdapterMutationCompilerRegistry([
    createGitHubIssueMutationCompiler({
      mappings: mappingsFromAdapterPlan(input.plan.adapterPlan),
      ...(target.targetKind ? { targetKind: target.targetKind } : {})
    })
  ]);
  for (const compilation of compilerRegistry.compile("github", executableIntents)) {
    if (!compilation.ok) {
      executedOutcomes.push(compilation.outcome);
      continue;
    }
    executedOutcomes.push(
      await applyGitHubIssueMutationOperation({
        target: {
          token: input.githubApply.token,
          owner: target.owner,
          repo: target.repoName,
          ...(typeof target.issueNumber === "number" ? { issueNumber: target.issueNumber } : {}),
          ...(target.pullRequestNumber ? { pullRequestNumber: target.pullRequestNumber } : {})
        },
        operation: compilation.operation as GitHubIssueMutationOperation,
        ...(input.githubApply.fetchImpl ? { fetchImpl: input.githubApply.fetchImpl } : {})
      })
    );
  }

  return await updateExecutedApplyPlan({ repo: input.repo, plan: input.plan, resolved: input.resolved, executedOutcomes });
}

const noopCallbackSink: CallbackSink = {
  async deliver() {
    return;
  }
};

const noopSourceReceiptSink: SourceReceiptSink = {
  async deliver() {
    return { delivered: false };
  }
};

function nextCallbackAttemptAt(input: { attempts: number } & CallbackRetryOptions): string | undefined {
  const maxAttempts = input.maxAttempts ?? 5;
  const nextAttempt = input.attempts + 1;
  if (nextAttempt >= maxAttempts) return undefined;

  const baseDelayMs = input.baseDelayMs ?? 5_000;
  const maxDelayMs = input.maxDelayMs ?? 300_000;
  const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, input.attempts));
  return new Date((input.now ?? new Date()).getTime() + delayMs).toISOString();
}

async function deliverCallbackDelivery(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: CallbackSink;
  delivery: import("@opentag/store").CallbackDelivery;
  retry?: CallbackRetryOptions;
}): Promise<boolean> {
  try {
    const externalMessageId =
      input.delivery.externalMessageId ??
      (input.delivery.statusMessageKey
        ? await input.repo.findCallbackExternalMessageId({
            runId: input.delivery.runId,
            provider: input.delivery.provider,
            ...(input.delivery.threadKey ? { threadKey: input.delivery.threadKey } : {}),
            statusMessageKey: input.delivery.statusMessageKey
          })
        : undefined);
    const deliveryResult = await input.sink.deliver({
      runId: input.delivery.runId,
      kind: input.delivery.kind,
      provider: input.delivery.provider,
      uri: input.delivery.uri,
      body: input.delivery.body,
      ...(input.delivery.threadKey ? { threadKey: input.delivery.threadKey } : {}),
      ...(input.delivery.agentId ? { agentId: input.delivery.agentId } : {}),
      ...(input.delivery.statusMessageKey ? { statusMessageKey: input.delivery.statusMessageKey } : {}),
      ...(externalMessageId ? { externalMessageId } : {}),
      ...(input.delivery.blocks ? { blocks: input.delivery.blocks as SlackBlock[] } : {}),
      ...(input.delivery.rich ? { rich: input.delivery.rich as NonNullable<CallbackMessage["rich"]> } : {})
    });
    const deliveredExternalMessageId = deliveryResult?.externalMessageId ?? externalMessageId;
    await input.repo.markCallbackDelivered({
      deliveryId: input.delivery.id,
      ...(deliveredExternalMessageId ? { externalMessageId: deliveredExternalMessageId } : {})
    });
    return true;
  } catch (error) {
    const maxAttempts = input.retry?.maxAttempts ?? 5;
    const nextAttemptAt = nextCallbackAttemptAt({ attempts: input.delivery.attempts, ...(input.retry ?? {}) });
    await input.repo.markCallbackFailed({
      deliveryId: input.delivery.id,
      error: error instanceof Error ? error.message : String(error),
      maxAttempts,
      ...(nextAttemptAt ? { nextAttemptAt } : {})
    });
    return false;
  }
}

export async function processPendingCallbacks(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: CallbackSink;
  limit?: number;
  retry?: CallbackRetryOptions;
}): Promise<{ processed: number; delivered: number; failed: number }> {
  const maxAttempts = input.retry?.maxAttempts ?? 5;
  const deliveries = await input.repo.claimPendingCallbackDeliveries({
    limit: input.limit ?? 20,
    ...(input.retry?.now ? { now: input.retry.now } : {}),
    maxAttempts
  });
  const result = { processed: 0, delivered: 0, failed: 0 };
  for (const delivery of deliveries) {
    result.processed += 1;
    const delivered = await deliverCallbackDelivery({
      repo: input.repo,
      sink: input.sink,
      delivery,
      ...(input.retry ? { retry: input.retry } : {})
    });
    if (delivered) {
      result.delivered += 1;
    } else {
      result.failed += 1;
    }
  }
  return result;
}

async function deliverAndAudit(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: CallbackSink;
  message: CallbackMessage;
  retry?: CallbackRetryOptions;
}): Promise<boolean> {
  const safeMessage = sanitizeCredentialLikeValue(input.message);
  const delivery = await input.repo.enqueueCallbackDelivery({
    runId: safeMessage.runId,
    kind: safeMessage.kind,
    provider: safeMessage.provider,
    uri: safeMessage.uri,
    body: safeMessage.body,
    ...(safeMessage.idempotencyKey ? { idempotencyKey: safeMessage.idempotencyKey } : {}),
    ...(safeMessage.threadKey ? { threadKey: safeMessage.threadKey } : {}),
    ...(safeMessage.agentId ? { agentId: safeMessage.agentId } : {}),
    ...(safeMessage.statusMessageKey ? { statusMessageKey: safeMessage.statusMessageKey } : {}),
    ...(safeMessage.blocks ? { blocks: safeMessage.blocks } : {}),
    ...(safeMessage.rich ? { rich: safeMessage.rich } : {})
  });
  if (delivery.enqueueOutcome === "duplicate") return delivery.status === "delivered";
  return deliverCallbackDelivery({
    repo: input.repo,
    sink: input.sink,
    delivery,
    ...(input.retry ? { retry: input.retry } : {})
  });
}

async function deliverSourceReceiptBestEffort(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: SourceReceiptSink;
  receipt: SourceReceipt;
}): Promise<SourceReceiptDelivery> {
  try {
    const result = await input.sink.deliver(input.receipt);
    if (!result.delivered) return result;
    await input.repo.appendRunEvent({
      runId: input.receipt.runId,
      type: "source_receipt.delivered",
      payload: {
        provider: input.receipt.provider,
        state: input.receipt.state
      },
      visibility: "audit",
      importance: "low",
      message: `Source ${input.receipt.state} receipt delivered.`
    });
    return result;
  } catch (error) {
    await input.repo.appendRunEvent({
      runId: input.receipt.runId,
      type: "source_receipt.failed",
      payload: {
        provider: input.receipt.provider,
        state: input.receipt.state,
        error: error instanceof Error ? error.message : String(error)
      },
      visibility: "audit",
      importance: "low",
      message: `Source ${input.receipt.state} receipt failed.`
    });
    return { delivered: false };
  }
}

type DispatcherAuthScope = "pairing" | "runner_runtime" | "runner_operator";
type DispatcherAuthResult =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid_pairing_token" | "invalid_runner_token" | "invalid_dispatcher_token" | "runner_token_revoked";
      message?: string;
    };

function isRunnerRuntimeEndpoint(method: string, path: string): boolean {
  if (method !== "POST") return false;
  if (/^\/v1\/runners\/[^/]+\/claim$/.test(path)) return true;
  if (/^\/v1\/runners\/[^/]+\/runs\/[^/]+\/(running|reject-start|heartbeat|progress|complete|action-permissions)$/.test(path)) return true;
  if (/^\/v1\/runners\/[^/]+\/runs\/[^/]+\/action-permissions\/[^/]+\/resolve$/.test(path)) return true;
  if (/^\/v1\/runners\/[^/]+\/runs\/[^/]+\/material-actions\/[^/]+\/receipt$/.test(path)) return true;
  return /^\/v1\/runs\/[^/]+\/(running|progress|complete)$/.test(path);
}

function isRunnerOperatorEndpoint(method: string, path: string): boolean {
  if (method === "GET") {
    if (path === "/v1/control-plane-alerts") return true;
    if (path === "/v1/runners") return true;
    if (path === "/v1/routing/accepted-progress-metrics") return true;
    if (/^\/v1\/runners\/[^/]+$/.test(path)) return true;
    if (/^\/v1\/repo-bindings\/[^/]+\/[^/]+\/[^/]+$/.test(path)) return true;
    if (/^\/v1\/channel-bindings\/[^/]+\/[^/]+\/[^/]+(?:\/status)?$/.test(path)) return true;
    return /^\/v1\/runs\/[^/]+(?:\/events|\/metrics)?$/.test(path);
  }
  if (method !== "POST") return false;
  if (path === "/v1/source-deliveries/prune") return true;
  if (/^\/v1\/runs\/[^/]+\/cancel$/.test(path)) return true;
  return /^\/v1\/channel-bindings\/[^/]+\/[^/]+\/[^/]+\/cancel-active-run$/.test(path);
}

function dispatcherAuthScope(request: Request): DispatcherAuthScope {
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  if (isRunnerRuntimeEndpoint(method, path)) return "runner_runtime";
  if (isRunnerOperatorEndpoint(method, path)) return "runner_operator";
  return "pairing";
}

function authMatches(request: Request, token: string | undefined): boolean {
  return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

function configuredRunnerTokens(input: { runnerToken?: string; runnerTokens?: string[] }): string[] {
  return [...new Set([input.runnerToken, ...(input.runnerTokens ?? [])].map((token) => token?.trim()).filter((token): token is string => Boolean(token)))];
}

function normalizeRevokedRunnerTokenFingerprints(fingerprints: string[] | undefined): Set<string> {
  return new Set((fingerprints ?? []).map((fingerprint) => fingerprint.trim().toLowerCase()).filter(Boolean));
}

function authMatchesAny(request: Request, tokens: string[]): boolean {
  return tokens.some((token) => authMatches(request, token));
}

function requestUsesRevokedRunnerToken(input: { request: Request; revokedRunnerTokenFingerprints: Set<string> }): boolean {
  const token = bearerToken(input.request);
  if (!token) return false;
  return input.revokedRunnerTokenFingerprints.has(rawTokenFingerprint(token).toLowerCase());
}

function revokedRunnerTokenResult(): DispatcherAuthResult {
  return {
    ok: false,
    reason: "runner_token_revoked",
    message: "Runner token has been revoked or expired. Pair again or update daemon.runnerToken before retrying."
  };
}

function authorizeDispatcherRequest(input: {
  request: Request;
  pairingToken: string | undefined;
  runnerTokens: string[];
  revokedRunnerTokenFingerprints: Set<string>;
}): DispatcherAuthResult {
  if (!input.pairingToken && input.runnerTokens.length === 0) return { ok: true };

  const revokedRunnerToken = requestUsesRevokedRunnerToken({
    request: input.request,
    revokedRunnerTokenFingerprints: input.revokedRunnerTokenFingerprints
  });
  if (revokedRunnerToken) return revokedRunnerTokenResult();

  const scope = dispatcherAuthScope(input.request);
  const pairingMatches = authMatches(input.request, input.pairingToken);
  const runnerMatches = authMatchesAny(input.request, input.runnerTokens);

  if (scope === "pairing") {
    return pairingMatches ? { ok: true } : { ok: false, reason: "invalid_pairing_token" };
  }

  if (scope === "runner_runtime") {
    if (input.runnerTokens.length > 0) {
      return runnerMatches ? { ok: true } : { ok: false, reason: "invalid_runner_token" };
    }
    return pairingMatches ? { ok: true } : { ok: false, reason: "invalid_pairing_token" };
  }

  return runnerMatches || pairingMatches ? { ok: true } : { ok: false, reason: "invalid_dispatcher_token" };
}

export function openDispatcherDatabase(databasePath: string): InstanceType<typeof Database> {
  return new Database(databasePath);
}

export function createDispatcherApp(input: {
  databasePath: string;
  sqlite?: InstanceType<typeof Database>;
  callbackSink?: CallbackSink;
  sourceReceiptSink?: SourceReceiptSink;
  pairingToken?: string;
  runnerToken?: string;
  runnerTokens?: string[];
  revokedRunnerTokenFingerprints?: string[];
  channelPrincipals?: ChannelPrincipalCredential[];
  presentation?: CallbackPresentation;
  githubApply?: GitHubApplyOptions;
  gitlabApply?: GitLabApplyOptions;
  linearApply?: LinearApplyOptions;
  linearOAuthInstall?: LinearOAuthInstallOptions;
  callbackRetry?: CallbackRetryOptions;
  larkStatusCards?: LarkDelayedStatusCardOptions;
  agentAccessProfileCheck?: AgentAccessProfileCheck;
  maxRequestBodyBytes?: number;
  rateLimit?: DispatcherRateLimitOptions | false;
  runnerLeaseSeconds?: number;
  relayCapabilities?: {
    platforms?: RelayPlatformCapability[];
  };
  completionPolicies?: GitHubCompletionPolicy[];
  completionNow?: () => string;
}) {
  const sqlite = input.sqlite ?? openDispatcherDatabase(input.databasePath);
  migrateSchema(sqlite);
  const repo = createOpenTagRepository(drizzle(sqlite));
  const workstreamBatchLeaseSeconds = 300;
  const workstreamBatchHeartbeatMs = Math.floor(workstreamBatchLeaseSeconds * 1_000 / 3);

  async function withWorkstreamAdmissionLease<T>(lease: {
    batchId: string;
    itemId: string;
    leaseOwner: string;
  }, task: () => Promise<T>): Promise<T> {
    let renewalFailure: Error | undefined;
    let renewalChain = Promise.resolve();
    const renew = async () => {
      if (renewalFailure) return;
      const renewed = await repo.renewWorkstreamAdmissionBatchLease({
        ...lease,
        leaseSeconds: workstreamBatchLeaseSeconds
      });
      if (renewed.outcome !== "renewed") {
        throw new Error(
          `Workstream batch item ${lease.itemId} lease could not be renewed: ${renewed.outcome}.`
        );
      }
    };
    const scheduleRenewal = () => {
      renewalChain = renewalChain.then(renew).catch((error: unknown) => {
        renewalFailure = error instanceof Error ? error : new Error(String(error));
      });
    };
    const heartbeat = globalThis.setInterval(scheduleRenewal, workstreamBatchHeartbeatMs);
    try {
      const result = await task();
      await renewalChain;
      if (renewalFailure) throw renewalFailure;
      await renew();
      return result;
    } finally {
      globalThis.clearInterval(heartbeat);
      await renewalChain;
    }
  }
  const completionGovernance = createDispatcherCompletionGovernance({
    repo,
    policies: input.completionPolicies ?? [],
    ...(input.completionNow ? { now: input.completionNow } : {})
  });
  const app = new Hono();
  const channelPrincipals = configuredChannelPrincipals(input.channelPrincipals);
  const configuredCallbackSink = input.callbackSink ?? noopCallbackSink;
  const sourceReceiptSink = input.sourceReceiptSink ?? noopSourceReceiptSink;
  const presentation = input.presentation ?? createDefaultCallbackPresentation();
  const callbackRetry = input.callbackRetry ?? {};
  const larkStatusCardOptions = input.larkStatusCards ?? {};
  const larkStatusCardDelayMs = larkStatusCardOptions.delayMs ?? 10_000;
  const larkStatusCardMinUpdateIntervalMs = larkStatusCardOptions.minUpdateIntervalMs ?? 5_000;
  const larkStatusCardNow = larkStatusCardOptions.now ?? (() => Date.now());
  const setLarkStatusCardTimeout = larkStatusCardOptions.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clearLarkStatusCardTimeout = larkStatusCardOptions.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
  const delayedLarkStatusCards = new Map<string, DelayedLarkStatusState>();

  async function deliverCompletionTransition(workThreadId: string): Promise<void> {
    const transition = await completionGovernance.getSourceThreadTransition(workThreadId);
    if (!transition) return;
    const state = transition.completion.completion;
    const projection = state === "satisfied"
      ? { state: "completed" as const, message: "Complete: provider-verified completion requirements are satisfied." }
      : state === "waived"
        ? { state: "completed" as const, message: "Complete: the remaining gates were covered by an attributed bounded waiver." }
        : state === "blocked"
          ? { state: "failed" as const, message: "Work completion is blocked and needs human attention." }
          : state === "unsatisfied"
            ? { state: "failed" as const, message: "Execution finished, but the completion requirements are not satisfied." }
            : { state: "running" as const, message: "Execution succeeded; work completion is waiting for verified evidence." };
    if (!presentation.shouldDeliverStatusUpdate(transition.event.callback.provider)) return;
    const semantic = presentation.runStatusPresentation({
      runId: transition.runId,
      state: projection.state,
      message: projection.message,
      nextAction: transition.completion.nextAction.summary,
      detailVisibility: "source_thread"
    });
    const rendered = presentation.render({
      provider: transition.event.callback.provider,
      ...larkRenderLocaleRenderOption(transition.event),
      presentation: semantic
    });
    const statusMessageKey = lifecycleStatusMessageKey({
      provider: transition.event.callback.provider,
      runId: transition.runId
    });
    await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId: transition.runId,
        kind: projection.state === "completed" ? "final" : "progress",
        provider: transition.event.callback.provider,
        uri: transition.event.callback.uri,
        body: rendered.body,
        ...(transition.event.target.agentId ? { agentId: transition.event.target.agentId } : {}),
        ...(transition.event.callback.threadKey ? { threadKey: transition.event.callback.threadKey } : {}),
        ...(statusMessageKey ? { statusMessageKey } : {}),
        ...(rendered.blocks?.length ? { blocks: rendered.blocks } : {}),
        ...(rendered.rich ? { rich: rendered.rich } : {}),
        idempotencyKey: transition.transitionKey
      }
    });
  }
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const runnerLeaseSeconds = input.runnerLeaseSeconds ?? 60;
  const runnerTokens = configuredRunnerTokens(input);
  const revokedRunnerTokenFingerprints = normalizeRevokedRunnerTokenFingerprints(input.revokedRunnerTokenFingerprints);
  const requestEndpoint = (c: Context) => normalizeRateLimitedEndpoint(c.req.method, new URL(c.req.url).pathname);
  const linearOAuthInstall = input.linearOAuthInstall;
  async function linearRelayInstallationFromEvent(event: OpenTagEvent) {
    const installationId = event.metadata["linearRelayInstallationId"];
    return typeof installationId === "string" && installationId.length > 0 ? await repo.getLinearRelayInstallation({ id: installationId }) : null;
  }
  function linearInstallationTokenIsFresh(input: { accessTokenExpiresAt?: string; now: Date; refreshSkewMs: number }): boolean {
    const expiresAtMs = input.accessTokenExpiresAt ? Date.parse(input.accessTokenExpiresAt) : Number.NaN;
    return Number.isFinite(expiresAtMs) && expiresAtMs - input.now.getTime() > input.refreshSkewMs;
  }
  const inFlightLinearInstallationTokenRefreshes = new Map<string, Promise<string>>();
  async function resolveLinearRelayInstallationToken(
    installation: NonNullable<Awaited<ReturnType<typeof linearRelayInstallationFromEvent>>>
  ): Promise<string> {
    const auth = installation.auth;
    if (!linearOAuthInstall || auth?.method !== "oauth_app" || !auth.refreshToken) return installation.token;

    const oauthInstall = linearOAuthInstall;
    const now = oauthInstall.now?.() ?? new Date();
    const refreshSkewMs = oauthInstall.refreshSkewMs ?? DEFAULT_LINEAR_OAUTH_REFRESH_SKEW_MS;
    if (linearInstallationTokenIsFresh({ ...(auth.accessTokenExpiresAt ? { accessTokenExpiresAt: auth.accessTokenExpiresAt } : {}), now, refreshSkewMs })) {
      return installation.token;
    }

    const inFlight = inFlightLinearInstallationTokenRefreshes.get(installation.id);
    if (inFlight) return inFlight;

    const refresh = (async () => {
      const latest = (await repo.getLinearRelayInstallation({ id: installation.id })) ?? installation;
      const latestAuth = latest.auth;
      if (latestAuth?.method !== "oauth_app" || !latestAuth.refreshToken) return latest.token;
      if (
        linearInstallationTokenIsFresh({
          ...(latestAuth.accessTokenExpiresAt ? { accessTokenExpiresAt: latestAuth.accessTokenExpiresAt } : {}),
          now,
          refreshSkewMs
        })
      ) {
        return latest.token;
      }

      const refreshed = await refreshLinearOAuthToken({
        clientId: latestAuth.clientId ?? oauthInstall.clientId,
        ...(oauthInstall.clientSecret ? { clientSecret: oauthInstall.clientSecret } : {}),
        refreshToken: latestAuth.refreshToken,
        ...(oauthInstall.tokenUrl ? { tokenUrl: oauthInstall.tokenUrl } : {}),
        ...(oauthInstall.fetchImpl ? { fetchImpl: oauthInstall.fetchImpl } : {})
      });
      const accessTokenExpiresAt = linearAccessTokenExpiresAt({ token: refreshed, now });
      const refreshedAuth = {
        method: "oauth_app" as const,
        actor: "app" as const,
        clientId: latestAuth.clientId ?? oauthInstall.clientId,
        refreshToken: refreshed.refreshToken ?? latestAuth.refreshToken,
        ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
        ...(refreshed.scope?.length ? { scopes: refreshed.scope } : latestAuth.scopes?.length ? { scopes: latestAuth.scopes } : {})
      };
      const updated = await repo.upsertLinearRelayInstallation({
        id: latest.id,
        webhookPath: latest.webhookPath,
        webhookSecret: latest.webhookSecret,
        token: refreshed.accessToken,
        auth: refreshedAuth,
        ...(latest.graphqlUrl ? { graphqlUrl: latest.graphqlUrl } : {}),
        repoProvider: latest.repoProvider,
        owner: latest.owner,
        repo: latest.repo,
        ...(latest.organizationId ? { organizationId: latest.organizationId } : {}),
        ...(latest.teamId ? { teamId: latest.teamId } : {}),
        ...(latest.teamKey ? { teamKey: latest.teamKey } : {})
      });
      return updated.token;
    })();
    inFlightLinearInstallationTokenRefreshes.set(installation.id, refresh);
    try {
      return await refresh;
    } finally {
      inFlightLinearInstallationTokenRefreshes.delete(installation.id);
    }
  }
  async function linearRelayInstallationForCallback(message: CallbackMessage) {
    if (message.provider !== "linear") return null;
    const stored = await repo.getRun({ runId: message.runId });
    return stored ? linearRelayInstallationFromEvent(stored.event) : null;
  }
  async function linearApplyOptionsForEvent(event: OpenTagEvent): Promise<LinearApplyOptions | undefined> {
    if (input.linearApply) return input.linearApply;
    const installation = await linearRelayInstallationFromEvent(event);
    if (!installation) return undefined;
    const mappings = await repo.listRepoMutationMappings({
      provider: installation.repoProvider,
      owner: installation.owner,
      repo: installation.repo
    });
    const token = await resolveLinearRelayInstallationToken(installation);
    return {
      token,
      ...(installation.graphqlUrl ? { graphqlUrl: installation.graphqlUrl } : {}),
      ...(mappings.length ? { mappings } : {})
    };
  }
  async function postInternalDispatcher(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (input.pairingToken) headers.authorization = `Bearer ${input.pairingToken}`;
    const response = await app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const responseBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`internal dispatcher request ${path} failed: ${response.status}`);
    }
    return { status: response.status, body: responseBody };
  }
  // The webhook app owns the comment-vs-agent-session claim state, so it must live
  // across deliveries: recreating it per request would let one mention double-trigger.
  // Cached per installation and rebuilt when the installation row changes.
  const linearRelayWebhookApps = new Map<string, { fingerprint: string; app: Hono }>();
  function linearRelayWebhookAppForInstallation(input: {
    installation: LinearRelayInstallation;
    webhookSecret: string;
    webhookPath: string;
  }): Hono {
    const fingerprint = JSON.stringify([input.installation.updatedAt, input.webhookSecret, input.webhookPath]);
    const cached = linearRelayWebhookApps.get(input.installation.id);
    if (cached && cached.fingerprint === fingerprint) return cached.app;
    const app = createLinearRelayWebhookAppForInstallation(input);
    linearRelayWebhookApps.set(input.installation.id, { fingerprint, app });
    return app;
  }
  function createLinearRelayWebhookAppForInstallation(input: {
    installation: LinearRelayInstallation;
    webhookSecret: string;
    webhookPath: string;
  }) {
    return createLinearWebhookApp({
      webhookSecret: input.webhookSecret,
      ...(input.installation.graphqlUrl ? { graphqlUrl: input.installation.graphqlUrl } : {}),
      projectTarget: {
        repoProvider: input.installation.repoProvider,
        owner: input.installation.owner,
        repo: input.installation.repo
      },
      webhookPath: input.webhookPath,
      // OAuth-app installs receive both Comment and AgentSessionEvent webhooks for one
      // mention; defer comment runs so the session channel can claim them.
      ...(input.installation.auth?.method === "oauth_app"
        ? { commentRunDeferMs: linearOAuthInstall?.commentRunDeferMs ?? DEFAULT_LINEAR_COMMENT_RUN_DEFER_MS }
        : {}),
      ...(input.installation.auth?.method === "oauth_app" && input.installation.auth.appUserId
        ? { appUserId: input.installation.auth.appUserId }
        : {}),
      onAgentSessionAccepted: async ({ agentSessionId, runId }) => {
        const token = await resolveLinearRelayInstallationToken(input.installation);
        await acknowledgeLinearAgentSession({
          token,
          agentSessionId,
          ...(runId ? { runId } : {}),
          ...(input.installation.graphqlUrl ? { graphqlUrl: input.installation.graphqlUrl } : {})
        });
      },
      async createRun(event) {
        const runId = `run_${randomUUID()}`;
        const eventWithInstallation: OpenTagEvent = {
          ...event,
          metadata: {
            ...event.metadata,
            linearRelayInstallationId: input.installation.id
          }
        };
        const created = await postInternalDispatcher("/v1/runs", { runId, event: eventWithInstallation });
        const run = created.body["run"];
        if (run && typeof run === "object" && "id" in run && typeof (run as { id?: unknown }).id === "string") {
          return { runId: (run as { id: string }).id };
        }
        return {};
      },
      async submitThreadAction(action) {
        await postInternalDispatcher("/v1/thread-actions", action);
      },
      now: () => new Date().toISOString()
    });
  }
  function parseLinearWebhookPayload(rawBody: string): LinearWebhookPayload | null {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as LinearWebhookPayload) : null;
    } catch {
      return null;
    }
  }
  function stringPayloadValue(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  function numberPayloadValue(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return null;
  }
  function isLinearOAuthAppRevokedPayload(payload: LinearWebhookPayload): boolean {
    return payload.type === "OAuthApp" && payload.action === "revoked";
  }
  function linearAgentSessionPlanFor(message: CallbackMessage) {
    const finished = message.kind === "final";
    return [
      { content: "Accept the Linear agent session", status: "completed" as const },
      { content: "Run OpenTag on the paired local checkout", status: finished ? ("completed" as const) : ("inProgress" as const) },
      { content: "Report the result back to Linear", status: finished ? ("completed" as const) : ("pending" as const) }
    ];
  }
  async function deliverLinearRelayCallback(
    message: CallbackMessage,
    installation: NonNullable<Awaited<ReturnType<typeof linearRelayInstallationForCallback>>>
  ): Promise<CallbackDeliveryResult | void> {
    const token = await resolveLinearRelayInstallationToken(installation);
    const agentSessionId = linearAgentSessionIdFromCallbackUri(message.uri);
    if (agentSessionId) {
      await updateLinearAgentSession({
        token,
        ...(installation.graphqlUrl ? { graphqlUrl: installation.graphqlUrl } : {}),
        agentSessionId,
        plan: linearAgentSessionPlanFor(message)
      });
      const activityId = await createLinearAgentActivity({
        token,
        ...(installation.graphqlUrl ? { graphqlUrl: installation.graphqlUrl } : {}),
        activity: {
          agentSessionId,
          type: message.kind === "final" ? "response" : "thought",
          body: message.body,
          ephemeral: message.kind === "progress"
        }
      });
      return activityId ? { externalMessageId: activityId } : undefined;
    }

    const issueId = linearIssueIdFromCallbackUri(message.uri);
    if (!issueId) {
      throw new Error(`deliver Linear relay callback failed: invalid callback URI ${message.uri}`);
    }
    if (message.statusMessageKey && message.externalMessageId) {
      await updateLinearComment({
        token,
        commentId: message.externalMessageId,
        body: message.body,
        ...(installation.graphqlUrl ? { graphqlUrl: installation.graphqlUrl } : {})
      });
      return { externalMessageId: message.externalMessageId };
    }
    const comment = await createLinearIssueCommentRecord({
      token,
      issueId,
      body: message.body,
      ...(linearParentCommentIdFromCallbackUri(message.uri) ? { parentId: linearParentCommentIdFromCallbackUri(message.uri)! } : {}),
      ...(installation.graphqlUrl ? { graphqlUrl: installation.graphqlUrl } : {})
    });
    return message.statusMessageKey && comment.id ? { externalMessageId: comment.id } : undefined;
  }
  const callbackSink: CallbackSink = {
    async deliver(message) {
      const installation = await linearRelayInstallationForCallback(message);
      if (installation) return deliverLinearRelayCallback(message, installation);
      return configuredCallbackSink.deliver(message);
    }
  };
  const relayCapabilities: RelayCapabilities = {
    schemaVersion: 1,
    relay: true,
    platforms: [...(input.relayCapabilities?.platforms ?? [])].sort((left, right) => left.provider.localeCompare(right.provider))
  };
  const recordControlPlaneEvent = async (input: {
    type: string;
    severity?: "info" | "warn" | "error" | undefined;
    subject?: string | undefined;
    idempotencyKey?: string | undefined;
    payload?: Record<string, unknown> | undefined;
    createdAt?: string | undefined;
  }) => {
    await repo.appendControlPlaneEvent({
      type: input.type,
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {})
    });
  };
  async function structureAdmissionHumanDecision(inputValue: {
    requestId: string;
    event: OpenTagEvent;
    decision: import("@opentag/core").RunAdmissionDecision;
    deliverSourceCallback?: boolean;
  }): Promise<{ escalation?: HumanEscalation; resolutionUnavailableReason?: string }> {
    const protocol = protocolRunFieldsFromEvent(inputValue.event, inputValue.decision.decidedAt);
    if (!protocol.thread) {
      return {
        resolutionUnavailableReason:
          "Admission requires human action, but this event has no durable WorkThread; retry from a bound source work item after correcting the reported reason."
      };
    }
    const workThread = (await repo.upsertWorkThread({
      thread: protocol.thread,
      recordedAt: inputValue.decision.decidedAt
    })).thread;
    const projectTarget = projectTargetRefFromEvent(inputValue.event);
    const subjectRef = projectTarget
      ? `${projectTarget.provider}:${projectTarget.owner}/${projectTarget.repo}`
      : `${workThread.workItemReference.provider}:${workThread.workItemReference.kind}:${workThread.workItemReference.externalId}`;
    const securityReason = [
      "actor_not_allowed_for_write",
      "actor_not_authorized_for_public_repo",
      "agent_access_profile_denied",
      "policy_rejected"
    ].includes(inputValue.decision.reasonCode);
    const escalationClass = securityReason ? "security" as const : "configuration" as const;
    const audience = securityReason ? "repo_owner" as const : "operator" as const;
    const dedupeKey = `admission:${inputValue.decision.reasonCode}:${subjectRef}:v1`;
    const sourceAuthority = await managedChannelSourceAuthority({ repo, event: inputValue.event });
    const escalation = HumanEscalationSchema.parse({
      id: `escalation_${createHash("sha256")
        .update(`${workThread.id}\0${dedupeKey}`)
        .digest("hex")
        .slice(0, 24)}`,
      workThreadId: workThread.id,
      ...(sourceAuthority ? { sourceAuthority } : {}),
      class: escalationClass,
      audience,
      subjectRef,
      state: "open",
      blocking: true,
      summary: "Run admission needs human attention.",
      reason: inputValue.decision.reason,
      nextAction: { kind: "request_human_decision", targetId: subjectRef },
      dedupeKey,
      openedAt: inputValue.decision.decidedAt
    });
    const opened = await repo.openHumanEscalation({ escalation });
    if (
      inputValue.deliverSourceCallback !== false
      && opened.created
      && presentation.shouldDeliverStatusUpdate(inputValue.event.callback.provider)
    ) {
      const semantic = presentation.runStatusPresentation({
        runId: inputValue.requestId,
        state: "waiting_for_human",
        message: opened.escalation.summary,
        nextAction: `${opened.escalation.reason} Resolve ${opened.escalation.id} locally, correct the configuration or authority, then retry the source request.`,
        detailVisibility: "source_thread"
      });
      const rendered = presentation.render({
        provider: inputValue.event.callback.provider,
        ...larkRenderLocaleRenderOption(inputValue.event),
        presentation: semantic
      });
      await callbackSink.deliver({
        runId: inputValue.requestId,
        kind: "final",
        provider: inputValue.event.callback.provider,
        uri: inputValue.event.callback.uri,
        body: rendered.body,
        ...(inputValue.event.target.agentId ? { agentId: inputValue.event.target.agentId } : {}),
        ...(inputValue.event.callback.threadKey ? { threadKey: inputValue.event.callback.threadKey } : {}),
        ...(rendered.blocks?.length ? { blocks: rendered.blocks } : {}),
        ...(rendered.rich ? { rich: rendered.rich } : {})
      });
    }
    return { escalation: opened.escalation };
  }

  type RunAdmissionHttpResult = {
    body: Record<string, unknown>;
    status: 200 | 201 | 202 | 403 | 409;
    batchStatus: "created" | "idempotent_replay" | "follow_up_queued" | "wait_active_run" | "needs_human_decision" | "rejected";
    reasonCode?: string;
    admittedRunId?: string;
    followUpRequestId?: string;
    humanEscalationId?: string;
  };

  async function admitAndCreateRun(inputValue: {
    runId: string;
    event: OpenTagEvent;
    channelPrincipal?: ChannelPrincipalIdentity;
    quiet?: boolean;
    workstreamId?: string;
    admissionBatchId?: string;
    activeRaceRetry?: boolean;
  }): Promise<RunAdmissionHttpResult> {
    let ownershipVerified = false;
    try {
      ownershipVerified = await managedChannelOwnershipVerified({
        repo,
        event: inputValue.event,
        ...(inputValue.channelPrincipal ? { principal: inputValue.channelPrincipal } : {})
      });
    } catch (error) {
      if (!(error instanceof ChannelBindingCorruptionError)) throw error;
      await recordControlPlaneEvent({
        type: "admission.managed_channel_binding_corrupt",
        severity: "error",
        subject: inputValue.runId,
        payload: {
          runId: inputValue.runId,
          source: inputValue.event.source,
          sourceEventId: inputValue.event.sourceEventId
        }
      });
      return {
        body: { error: "managed_channel_binding_corrupt" },
        status: 403,
        batchStatus: "rejected",
        reasonCode: "managed_channel_binding_corrupt"
      };
    }
    if (!ownershipVerified) {
      await recordControlPlaneEvent({
        type: "admission.managed_channel_ownership_unverified",
        severity: "warn",
        subject: inputValue.runId,
        payload: {
          runId: inputValue.runId,
          source: inputValue.event.source,
          sourceEventId: inputValue.event.sourceEventId
        }
      });
      return {
        body: { error: "managed_channel_ownership_unverified" },
        status: 403,
        batchStatus: "rejected",
        reasonCode: "managed_channel_ownership_unverified"
      };
    }

    const admittedEvent = eventWithManagedChannelAttestation(inputValue.event, inputValue.channelPrincipal);

    const admitted = await admission.admitRun({
      requestId: inputValue.runId,
      event: admittedEvent,
      ...(inputValue.workstreamId ? { workstreamId: inputValue.workstreamId } : {}),
      ...(inputValue.admissionBatchId ? { admissionBatchId: inputValue.admissionBatchId } : {})
    });
    if (admitted.outcome === "needs_human_decision") {
      const projectTarget = projectTargetRefFromEvent(admittedEvent);
      await recordControlPlaneEvent({
        type: "admission.needs_human_decision",
        severity: ["repo_context_missing", "repo_not_bound"].includes(admitted.decision.reasonCode) ? "warn" : "info",
        subject: inputValue.runId,
        payload: {
          runId: inputValue.runId,
          decision: admitted.decision,
          source: admittedEvent.source,
          sourceEventId: admittedEvent.sourceEventId,
          projectTarget: projectTarget ? `${projectTarget.provider}:${projectTarget.owner}/${projectTarget.repo}` : null
        }
      });
      const humanDecision = await structureAdmissionHumanDecision({
        requestId: inputValue.runId,
        event: admittedEvent,
        decision: admitted.decision,
        deliverSourceCallback: !inputValue.quiet
      });
      return {
        body: { decision: admitted.decision, ...humanDecision },
        status: 202,
        batchStatus: "needs_human_decision",
        reasonCode: admitted.decision.reasonCode,
        ...(humanDecision.escalation ? { humanEscalationId: humanDecision.escalation.id } : {})
      };
    }

    if (admitted.outcome === "drop_duplicate") {
      const replay = await repo.createRun({
        id: inputValue.runId,
        event: admittedEvent,
        ...(inputValue.workstreamId ? { workstreamId: inputValue.workstreamId } : {}),
        ...(inputValue.admissionBatchId ? { admissionBatchId: inputValue.admissionBatchId } : {})
      });
      const decision = replay.created ? admitted.decision : replay.replayDecision;
      return {
        body: { decision, run: replay.run, idempotentReplay: true },
        status: 200,
        batchStatus: "idempotent_replay",
        admittedRunId: replay.run.id
      };
    }

    if (admitted.outcome === "follow_up_queued") {
      const event = admitted.followUpRequest.event;
      const activeRunId = admitted.followUpRequest.activeRunId;
      if (
        !inputValue.quiet
        && activeRunId
        && shouldDeliverRunStatusUpdate(presentation, { provider: event.callback.provider, state: "queued" })
      ) {
        const queuedPresentation = presentation.runStatusPresentation({
          runId: activeRunId,
          state: "queued",
          message: `Queued follow-up ${admitted.followUpRequest.id} behind the active run.`,
          nextAction: "Wait for the active run final reply, send another follow-up to queue more context, or request cancellation with /stop.",
          detailVisibility: "source_thread"
        });
        const queued = presentation.render({
          provider: event.callback.provider,
          ...larkRenderLocaleRenderOption(event),
          presentation: queuedPresentation
        });
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: activeRunId,
            kind: "progress",
            provider: event.callback.provider,
            uri: event.callback.uri,
            body: queued.body,
            ...(event.target.agentId ? { agentId: event.target.agentId } : {}),
            ...(event.callback.threadKey ? { threadKey: event.callback.threadKey } : {}),
            ...(queued.blocks?.length ? { blocks: queued.blocks } : {}),
            ...(queued.rich ? { rich: queued.rich } : {}),
            statusMessageKey: `${activeRunId}:status`
          }
        });
      }
      return {
        body: { decision: admitted.decision, followUpRequest: admitted.followUpRequest },
        status: 202,
        batchStatus: "follow_up_queued",
        followUpRequestId: admitted.followUpRequest.id,
        ...(activeRunId ? { admittedRunId: activeRunId } : {})
      };
    }

    if (admitted.outcome === "wait_active_run") {
      return {
        body: { decision: admitted.decision },
        status: 202,
        batchStatus: "wait_active_run",
        reasonCode: admitted.decision.reasonCode,
        ...(admitted.decision.activeRunId ? { admittedRunId: admitted.decision.activeRunId } : {})
      };
    }

    let createdRun;
    try {
      createdRun = await repo.createRun({
        id: inputValue.runId,
        event: admittedEvent,
        accessProfileSnapshot: admitted.accessProfileSnapshot,
        policySnapshotProvenance: admitted.policySnapshotProvenance,
        routingPolicy: admitted.routingPolicy,
        ...(inputValue.workstreamId ? { workstreamId: inputValue.workstreamId } : {}),
        ...(inputValue.admissionBatchId ? { admissionBatchId: inputValue.admissionBatchId } : {}),
        rejectIfAutomaticContinuationActive: true
      });
    } catch (error) {
      if (!(error instanceof ActiveConversationRaceError)) throw error;
      if (!inputValue.activeRaceRetry) {
        return admitAndCreateRun({ ...inputValue, activeRaceRetry: true });
      }
      return {
        body: {
          error: "active_conversation_race",
          activeRunId: error.activeRunId
        },
        status: 409,
        batchStatus: "rejected",
        reasonCode: "active_run_same_thread"
      };
    }
    if (!createdRun.created) {
      return {
        body: { decision: createdRun.replayDecision, run: createdRun.run, idempotentReplay: true },
        status: 200,
        batchStatus: "idempotent_replay",
        admittedRunId: createdRun.run.id
      };
    }
    const { run } = createdRun;
    if (!inputValue.quiet) {
      const sourceReceiptDelivery = await deliverSourceReceiptBestEffort({
        repo,
        sink: sourceReceiptSink,
        receipt: {
          runId: run.id,
          provider: inputValue.event.callback.provider,
          state: "received",
          event: inputValue.event,
          ...(inputValue.event.target.agentId ? { agentId: inputValue.event.target.agentId } : {})
        }
      });
      if (sourceReceiptDelivery.delivered) scheduleDelayedLarkStatusCard({ run, event: inputValue.event });
      const shouldDeliverAcknowledgement =
        presentation.shouldDeliverAcknowledgement(inputValue.event.callback.provider)
        || (shouldDeliverSourceReceipt(inputValue.event.callback.provider) && !sourceReceiptDelivery.delivered);
      if (shouldDeliverAcknowledgement) {
        const acknowledgementPresentation = presentation.acknowledgementPresentation({ runId: run.id });
        const acknowledgement = presentation.render({
          provider: inputValue.event.callback.provider,
          ...larkRenderLocaleRenderOption(inputValue.event),
          presentation: acknowledgementPresentation
        });
        const statusMessageKey = lifecycleStatusMessageKey({ provider: inputValue.event.callback.provider, runId: run.id });
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: run.id,
            kind: "acknowledgement",
            provider: inputValue.event.callback.provider,
            uri: inputValue.event.callback.uri,
            body: acknowledgement.body,
            ...(inputValue.event.target.agentId ? { agentId: inputValue.event.target.agentId } : {}),
            ...(inputValue.event.callback.threadKey ? { threadKey: inputValue.event.callback.threadKey } : {}),
            ...(statusMessageKey ? { statusMessageKey } : {}),
            ...(acknowledgement.blocks?.length ? { blocks: acknowledgement.blocks } : {}),
            ...(acknowledgement.rich ? { rich: acknowledgement.rich } : {})
          }
        });
      }
    }
    return { body: { decision: admitted.decision, run }, status: 201, batchStatus: "created", admittedRunId: run.id };
  }

  type WorkstreamContinuationDispatch = {
    outcome: "not_configured" | "not_eligible" | "ambiguous" | "created" | "replayed" | "deferred" | "needs_human" | "rejected" | "error";
    workThreadId: string;
    trigger: WorkstreamContinuationTriggerEvent;
    decisions: WorkstreamContinuationDecision[];
    reasonCode?: string;
    activeRunId?: string;
    notBefore?: string;
    run?: OpenTagRun;
    escalation?: HumanEscalation;
  };

  function humanResolutionContinuationContext(escalation: HumanEscalation): {
    pointer: OpenTagEvent["context"][number];
    metadata: Record<string, unknown>;
  } | undefined {
    const resolution = escalation.resolution;
    if (!resolution) return undefined;
    const selectedOption = resolution.optionId
      ? escalation.options?.find((option) => option.id === resolution.optionId)
      : undefined;
    const snapshot = sanitizeCredentialLikeValue({
      humanEscalationId: escalation.id,
      ...(resolution.optionId ? { optionId: resolution.optionId } : {}),
      ...(selectedOption ? {
        optionLabel: selectedOption.label,
        optionConsequence: selectedOption.consequence
      } : {}),
      ...(resolution.reason ? { reason: resolution.reason } : {}),
      resolver: resolution.actor,
      resolvedAt: resolution.resolvedAt
    });
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
    return {
      pointer: {
        kind: "text",
        title: "OpenTag human resolution",
        uri: [
          "OpenTag durable human resolution.",
          `Human escalation: ${snapshot.humanEscalationId}`,
          ...(typeof snapshot.optionId === "string" ? [`Selected option: ${snapshot.optionId}`] : []),
          ...(typeof snapshot.optionLabel === "string" ? [`Selected option label: ${snapshot.optionLabel}`] : []),
          ...(typeof snapshot.optionConsequence === "string" ? [`Selected option consequence: ${snapshot.optionConsequence}`] : []),
          ...(typeof snapshot.reason === "string" ? [`Resolution reason: ${snapshot.reason}`] : []),
          `Resolver: ${snapshot.resolver.provider}:${snapshot.resolver.providerUserId}${snapshot.resolver.handle ? ` (${snapshot.resolver.handle})` : ""}`,
          `Resolved at: ${snapshot.resolvedAt}`,
          `Resolution digest: ${digest}`
        ].join("\n"),
        visibility: "organization"
      },
      metadata: {
        humanEscalationId: escalation.id,
        humanResolutionDigest: digest
      }
    };
  }

  async function dispatchWorkstreamContinuation(inputValue: {
    workThreadId: string;
    trigger: WorkstreamContinuationTriggerEvent;
    preferredParentRunId?: string;
    continuationActor?: ActorIdentity;
    continuationPrincipal?: ChannelPrincipalIdentity;
    continuationContext?: {
      pointer: OpenTagEvent["context"][number];
      metadata: Record<string, unknown>;
    };
  }): Promise<WorkstreamContinuationDispatch> {
    const { workThreadId, trigger } = inputValue;
    const storedWorkstreams = await repo.listFactoryWorkstreamsForWorkThread({ workThreadId, limit: 101 });
    const base = { workThreadId, trigger };
    if (storedWorkstreams.length === 0) {
      return { ...base, outcome: "not_configured", decisions: [], reasonCode: "workstream_not_configured" };
    }
    if (storedWorkstreams.length > 100) {
      await recordControlPlaneEvent({
        type: "workstream.continuation.ambiguous",
        severity: "warn",
        subject: workThreadId,
        idempotencyKey: stableId("continuation_ambiguous", [workThreadId, trigger.id, "workstream_limit"]),
        payload: { workThreadId, trigger, workstreamCount: storedWorkstreams.length, reasonCode: "workstream_limit_exceeded" }
      });
      return { ...base, outcome: "ambiguous", decisions: [], reasonCode: "workstream_limit_exceeded" };
    }

    const workLoop = await completionGovernance.getWorkLoop(workThreadId);
    if (!workLoop) {
      return { ...base, outcome: "not_eligible", decisions: [], reasonCode: "completion_not_available" };
    }
    const runs = await repo.listRunsForWorkThread({ workThreadId });
    const activeRunIds = runs
      .filter(({ run }) =>
        ["queued", "assigned", "running"].includes(run.status)
        || (run.status === "needs_approval" && !run.result)
      )
      .map(({ run }) => run.id);
    const now = input.completionNow?.() ?? new Date().toISOString();
    const evaluatedAt = Date.parse(trigger.occurredAt) > Date.parse(now)
      ? trigger.occurredAt
      : now;
    const decisions: WorkstreamContinuationDecision[] = [];
    let missingRecipeAuthority = false;

    for (const storedWorkstream of storedWorkstreams) {
      const storedRecipe = await repo.getFactoryRecipeSnapshot({
        id: storedWorkstream.recipeId,
        version: storedWorkstream.recipeVersion
      });
      if (!storedRecipe) {
        missingRecipeAuthority = true;
        await recordControlPlaneEvent({
          type: "workstream.continuation.authority_missing",
          severity: "error",
          subject: storedWorkstream.id,
          idempotencyKey: stableId("continuation_authority_missing", [storedWorkstream.id, trigger.id]),
          payload: {
            workstreamId: storedWorkstream.id,
            workThreadId,
            recipeId: storedWorkstream.recipeId,
            recipeVersion: storedWorkstream.recipeVersion,
            trigger
          }
        });
        continue;
      }
      const recipe = FactoryRecipeSnapshotSchema.parse({
        ...storedRecipe.recipe,
        createdAt: storedRecipe.createdAt,
        contentDigest: storedRecipe.contentDigest
      });
      const workstream = WorkstreamSchema.parse({
        ...storedWorkstream.workstream,
        createdAt: storedWorkstream.createdAt,
        contentDigest: storedWorkstream.contentDigest
      });
      const metrics = WorkstreamMetricsSchema.parse(await repo.getWorkstreamMetrics({ workstreamId: workstream.id }));
      const evaluation = evaluateWorkstream({ recipe, workstream, metrics, evaluatedAt });
      const continuations: WorkstreamContinuationRecord[] = runs.flatMap(({ run }) => {
        const metadata = run.triggeredByAction?.metadata;
        if (
          run.triggeredByAction?.kind !== "resume_work_thread"
          || metadata?.["workstreamContinuation"] !== true
          || metadataString(metadata, "workstreamId") !== workstream.id
          || metadataString(metadata, "workThreadId") !== workThreadId
        ) {
          return [];
        }
        const triggerId = metadataString(metadata, "triggerId");
        if (!triggerId) return [];
        return [{
          workstreamId: workstream.id,
          workThreadId,
          runId: run.id,
          triggerId,
          startedAt: run.createdAt,
          ...(run.result ? { conclusion: run.result.conclusion } : {})
        }];
      });
      decisions.push(evaluateWorkstreamContinuation({
        recipe,
        workstream,
        evaluation,
        workLoop,
        trigger,
        activeRunIds,
        continuations,
        evaluatedAt
      }));
    }

    if (missingRecipeAuthority) {
      return { ...base, outcome: "rejected", decisions, reasonCode: "recipe_authority_missing" };
    }

    const eligible = decisions.filter((decision) => decision.action === "eligible");
    if (eligible.length !== 1) {
      const waitDecision = decisions.find((decision) => decision.action === "wait");
      const humanDecision = decisions.find((decision) => decision.action === "needs_human");
      const deferredReasonCodes = new Set(["active_run", "backoff_not_elapsed", "cadence_not_elapsed"]);
      const allDecisionsDeferred = decisions.length > 0 && decisions.every(
        (decision) => decision.action === "wait" && deferredReasonCodes.has(decision.reasonCode)
      );
      const outcome = eligible.length > 1
        ? "ambiguous" as const
        : humanDecision
          ? "needs_human" as const
          : allDecisionsDeferred
            ? "deferred" as const
          : "not_eligible" as const;
      const reasonCode = eligible.length > 1
        ? "multiple_eligible_workstreams"
        : outcome === "needs_human"
          ? humanDecision!.reasonCode
          : outcome === "deferred"
            ? waitDecision?.reasonCode ?? "active_run"
            : decisions[0]?.reasonCode ?? "recipe_authority_missing";
      await recordControlPlaneEvent({
        type: eligible.length > 1 ? "workstream.continuation.ambiguous" : "workstream.continuation.evaluated",
        severity: eligible.length > 1 ? "warn" : humanDecision ? "warn" : "info",
        subject: workThreadId,
        idempotencyKey: stableId("continuation_evaluated", [workThreadId, trigger.id, decisions.map((decision) => decision.inputDigest)]),
        payload: { workThreadId, trigger, outcome, reasonCode, decisions }
      });
      return {
        ...base,
        outcome,
        decisions,
        reasonCode,
        ...(outcome === "deferred" && reasonCode === "active_run" && activeRunIds[0]
          ? { activeRunId: activeRunIds[0] }
          : {}),
        ...(outcome === "deferred" && waitDecision?.notBefore ? { notBefore: waitDecision.notBefore } : {})
      };
    }

    const decision = eligible[0]!;
    const parent = inputValue.preferredParentRunId
      ? runs.find(({ run }) => run.id === inputValue.preferredParentRunId)
      : runs.at(-1);
    if (!parent) {
      return { ...base, outcome: "rejected", decisions, reasonCode: "parent_run_not_found" };
    }
    if (trigger.kind === "human_escalation_resolved" && !inputValue.continuationActor) {
      return { ...base, outcome: "rejected", decisions, reasonCode: "human_resolution_actor_missing" };
    }
    const runId = stableId("run_continuation", [decision.workstreamId, workThreadId, trigger.id]);
    const continuationMetadata = {
      ...(inputValue.continuationContext?.metadata ?? {}),
      workstreamContinuation: true,
      workstreamId: decision.workstreamId,
      workThreadId,
      triggerId: trigger.id,
      triggerKind: trigger.kind,
      decisionInputDigest: decision.inputDigest,
      parentRunId: parent.run.id
    };
    const action = ActionHintSchema.parse({
      kind: "resume_work_thread",
      targetId: workThreadId,
      metadata: continuationMetadata
    });
    const event = childEventFromParent({
      parentEvent: inputValue.continuationActor
        ? { ...parent.event, actor: inputValue.continuationActor }
        : parent.event,
      childRunId: runId,
      actionKind: action.kind,
      commandText: `Resume WorkThread ${workThreadId} after ${trigger.kind}.`,
      receivedAt: evaluatedAt,
      extraContext: [
        {
          kind: "text",
          title: "OpenTag governed WorkLoop continuation",
          uri: [
            "OpenTag evidence-driven continuation.",
            `Workstream: ${decision.workstreamId}`,
            `WorkThread: ${workThreadId}`,
            `Trigger: ${trigger.kind} (${trigger.id})`,
            `Previous run: ${parent.run.id}`,
            `Next action: ${decision.nextAction.summary}`
          ].join("\n"),
          visibility: parent.event.source === "github" ? "public" : "organization"
        },
        ...(inputValue.continuationContext ? [inputValue.continuationContext.pointer] : [])
      ],
      metadata: continuationMetadata
    });

    let ownershipVerified = false;
    try {
      const inheritedPrincipal = managedChannelAttestationFromEvent(event);
      ownershipVerified = await managedChannelOwnershipVerified({
        repo,
        event,
        ...(inheritedPrincipal ? { principal: inheritedPrincipal } : {})
      });
    } catch (error) {
      if (!(error instanceof ChannelBindingCorruptionError)) throw error;
      return { ...base, outcome: "rejected", decisions, reasonCode: "managed_channel_binding_corrupt" };
    }
    if (!ownershipVerified) {
      return { ...base, outcome: "rejected", decisions, reasonCode: "managed_channel_ownership_unverified" };
    }
    if (trigger.kind === "human_escalation_resolved" && ["slack", "lark"].includes(event.source)) {
      if (!inputValue.continuationPrincipal) {
        return { ...base, outcome: "rejected", decisions, reasonCode: "managed_channel_request_principal_missing" };
      }
      const requestOwnershipVerified = await managedChannelOwnershipVerified({
        repo,
        event,
        principal: inputValue.continuationPrincipal
      });
      if (!requestOwnershipVerified) {
        return { ...base, outcome: "rejected", decisions, reasonCode: "managed_channel_request_principal_mismatch" };
      }
    }

    const admitted = await admission.admitRun({
      requestId: runId,
      event,
      workstreamId: decision.workstreamId,
      activeRunPolicy: "wait"
    });
    if (admitted.outcome === "wait_active_run") {
      return {
        ...base,
        outcome: "deferred",
        decisions,
        reasonCode: admitted.decision.reasonCode,
        ...(admitted.decision.activeRunId ? { activeRunId: admitted.decision.activeRunId } : {})
      };
    }
    if (admitted.outcome === "needs_human_decision") {
      const humanDecision = await structureAdmissionHumanDecision({
        requestId: runId,
        event,
        decision: admitted.decision,
        deliverSourceCallback: false
      });
      return {
        ...base,
        outcome: "needs_human",
        decisions,
        reasonCode: admitted.decision.reasonCode,
        ...(humanDecision.escalation ? { escalation: humanDecision.escalation } : {})
      };
    }
    if (admitted.outcome === "follow_up_queued") {
      return {
        ...base,
        outcome: "deferred",
        decisions,
        reasonCode: admitted.decision.reasonCode,
        ...(admitted.decision.activeRunId ? { activeRunId: admitted.decision.activeRunId } : {})
      };
    }
    if (admitted.outcome === "drop_duplicate") {
      return { ...base, outcome: "replayed", decisions, run: admitted.run };
    }

    let createdRun;
    try {
      createdRun = await repo.createRun({
        id: runId,
        event,
        accessProfileSnapshot: admitted.accessProfileSnapshot,
        policySnapshotProvenance: admitted.policySnapshotProvenance,
        routingPolicy: admitted.routingPolicy,
        parentRunId: parent.run.id,
        triggeredByAction: action,
        workstreamId: decision.workstreamId,
        rejectIfActiveConversation: true
      });
    } catch (error) {
      if (error instanceof ActiveConversationRaceError) {
        return {
          ...base,
          outcome: "deferred",
          decisions,
          reasonCode: "active_run_same_thread",
          activeRunId: error.activeRunId
        };
      }
      throw error;
    }
    const outcome = createdRun.created ? "created" as const : "replayed" as const;
    await recordControlPlaneEvent({
      type: "workstream.continuation.dispatched",
      severity: "info",
      subject: decision.workstreamId,
      idempotencyKey: stableId("continuation_dispatched", [decision.workstreamId, workThreadId, trigger.id]),
      payload: {
        outcome,
        runId: createdRun.run.id,
        parentRunId: parent.run.id,
        workstreamId: decision.workstreamId,
        workThreadId,
        trigger,
        decision
      }
    });
    return { ...base, outcome, decisions, run: createdRun.run };
  }

  async function attemptWorkstreamContinuation(inputValue: {
    workThreadId: string;
    trigger: WorkstreamContinuationTriggerEvent;
    preferredParentRunId?: string;
    continuationActor?: ActorIdentity;
    continuationPrincipal?: ChannelPrincipalIdentity;
    continuationContext?: {
      pointer: OpenTagEvent["context"][number];
      metadata: Record<string, unknown>;
    };
  }): Promise<WorkstreamContinuationDispatch> {
    try {
      return await dispatchWorkstreamContinuation(inputValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordControlPlaneEvent({
        type: "workstream.continuation.failed",
        severity: "error",
        subject: inputValue.workThreadId,
        idempotencyKey: stableId("continuation_failed", [inputValue.workThreadId, inputValue.trigger.id, message]),
        payload: { workThreadId: inputValue.workThreadId, trigger: inputValue.trigger, message }
      });
      return {
        outcome: "error",
        workThreadId: inputValue.workThreadId,
        trigger: inputValue.trigger,
        decisions: [],
        reasonCode: "continuation_dispatch_failed"
      };
    }
  }

  async function authorizeManagedHumanEscalationChange(
    escalation: HumanEscalation,
    principal?: ChannelPrincipalIdentity
  ): Promise<{ allowed: boolean; reasonCode?: string }> {
    if (!escalation.runId) return { allowed: true };
    const stored = await repo.getRun({ runId: escalation.runId });
    if (!stored) {
      return { allowed: false, reasonCode: "managed_channel_authority_unavailable" };
    }
    if (!["slack", "lark"].includes(stored.event.source)) return { allowed: true };
    try {
      const allowed = await managedChannelOwnershipVerified({
        repo,
        event: stored.event,
        ...(principal ? { principal } : {})
      });
      return allowed
        ? { allowed: true }
        : { allowed: false, reasonCode: "managed_channel_principal_required" };
    } catch (error) {
      if (!(error instanceof ChannelBindingCorruptionError)) throw error;
      return { allowed: false, reasonCode: "managed_channel_binding_corrupt" };
    }
  }

  const sourceThreadControl = createSourceThreadControlHandler({
    repo,
    presentation,
    conversationKeysFromThreadAction,
    latestRunTimeoutMs,
    deliverAuditedMessage: (message) => deliverAndAudit({ repo, sink: callbackSink, retry: callbackRetry, message }),
    deliverDirectMessage: (message) => callbackSink.deliver(message),
    recordControlPlaneEvent,
    authorizeHumanEscalationChange: authorizeManagedHumanEscalationChange,
    onHumanEscalationChanged: async (escalation, actor, channelPrincipal) => {
      if (escalation.runId) await completionGovernance.reassessRun(escalation.runId);
      await deliverCompletionTransition(escalation.workThreadId);
      if (escalation.state === "resolved") {
        const resolutionContext = humanResolutionContinuationContext(escalation);
        const continuation = await attemptWorkstreamContinuation({
          workThreadId: escalation.workThreadId,
          trigger: {
            id: `human-escalation:${escalation.id}`,
            kind: "human_escalation_resolved",
            occurredAt: escalation.resolution?.resolvedAt ?? new Date().toISOString()
          },
          continuationActor: actor,
          ...(channelPrincipal ? { continuationPrincipal: channelPrincipal } : {}),
          ...(resolutionContext ? { continuationContext: resolutionContext } : {}),
          ...(escalation.runId ? { preferredParentRunId: escalation.runId } : {})
        });
        return {
          outcome: continuation.outcome,
          ...(continuation.reasonCode ? { reasonCode: continuation.reasonCode } : {}),
          ...(continuation.activeRunId ? { activeRunId: continuation.activeRunId } : {}),
          ...(continuation.notBefore ? { notBefore: continuation.notBefore } : {}),
          ...(continuation.run ? { resumedRunId: continuation.run.id } : {}),
          ...(continuation.escalation ? { humanEscalationId: continuation.escalation.id } : {})
        };
      }
    },
    ...(input.completionNow ? { now: input.completionNow } : {})
  });
  queueMicrotask(() => {
    void (async () => {
      const completedRuns = await repo.listRunsWithResults();
      const workThreadIds = [...new Set(completedRuns.flatMap((stored) =>
        stored.run.thread?.id ? [stored.run.thread.id] : []
      ))].sort();
      for (const workThreadId of workThreadIds) {
        const latest = currentWorkThreadRun(await repo.listRunsForWorkThread({ workThreadId }));
        if (!latest?.run.result) continue;
        await completionGovernance.ingestRunResult(latest.run.id);
        await deliverCompletionTransition(workThreadId);
      }
    })().catch(async (error) => {
      try {
        await recordControlPlaneEvent({
          type: "completion_governance.recovery_failed",
          severity: "error",
          payload: { error: error instanceof Error ? error.message : String(error) }
        });
      } catch {
        // The owning process may already be shutting down and its SQLite file
        // may have been removed. Recovery failure reporting must not create an
        // unhandled rejection during teardown.
      }
    });
  });
  const parseDispatcherBody = async <S extends z.ZodTypeAny>(
    c: Context,
    schema: S,
    options: { invalidBodyError?: string } = {}
  ): Promise<z.infer<S>> => {
    try {
      return await parseBody(c, schema, { maxBytes: maxRequestBodyBytes, ...options });
    } catch (err) {
      if (err instanceof HTTPException && err.status === 413) {
        await recordControlPlaneEvent({
          type: "security.request_body_rejected",
          severity: "warn",
          subject: requestEndpoint(c),
          payload: {
            reason: "request_body_too_large",
            endpoint: requestEndpoint(c),
            maxBytes: maxRequestBodyBytes,
            contentLength: c.req.raw.headers.get("content-length") ?? null
          }
        });
      }
      if (err instanceof HTTPException && err.status === 400 && err.cause instanceof RequestBodyRejectedError) {
        await recordControlPlaneEvent({
          type: "security.request_body_rejected",
          severity: "warn",
          subject: requestEndpoint(c),
          payload: {
            reason: err.cause.reason,
            error: err.cause.publicError,
            endpoint: requestEndpoint(c),
            contentLength: c.req.raw.headers.get("content-length") ?? null
          }
        });
      }
      throw err;
    }
  };

  const appendSuppressedRunStatusCallback = async (input: {
    runId: string;
    provider: string;
    state: CallbackRunStatusState;
  }): Promise<void> => {
    const capability = platformCapabilityForProvider(input.provider);
    await repo.appendRunEvent({
      runId: input.runId,
      type: "callback.progress.suppressed",
      payload: {
        provider: input.provider,
        reason: "platform_liveness_strategy",
        requestedStatus: input.state,
        livenessStrategy: capability?.livenessStrategy ?? "unknown"
      },
      visibility: "audit",
      importance: "low",
      message: "Run status callback suppressed by platform liveness strategy; use status or audit for details."
    });
  };

  function delayedLarkStatusMessage(input: { run: OpenTagRun; phase: DelayedLarkStatusPhase }): string {
    if (input.phase === "queued") return "Waiting for the local runner.";
    if (input.phase === "progress") return "OpenTag is still working.";
    return `Running with ${safeExecutorLabel(input.run.executor)}.`;
  }

  function delayedLarkStatusState(input: { run: OpenTagRun; phase: DelayedLarkStatusPhase }): CallbackRunStatusState {
    if (input.phase === "queued") return "queued";
    return "running";
  }

  async function appendDelayedLarkStatusFailure(input: { runId: string; error: unknown }): Promise<void> {
    await repo.appendRunEvent({
      runId: input.runId,
      type: "callback.progress.failed",
      payload: {
        provider: "lark",
        reason: "delayed_status_card",
        error: input.error instanceof Error ? input.error.message : String(input.error)
      },
      visibility: "audit",
      importance: "low",
      message: "Delayed Lark status card update failed."
    });
  }

  async function deliverDelayedLarkStatusCard(input: {
    run: OpenTagRun;
    event: OpenTagEvent;
    phase: DelayedLarkStatusPhase;
    createIfMissing?: boolean;
  }): Promise<boolean> {
    if (!shouldUseDelayedLarkStatusCard(
      input.event.callback.provider,
      larkStatusCardOptions,
      presentation.shouldDeliverStatusUpdate(input.event.callback.provider)
    )) return false;
    if (!input.event.callback.threadKey) return false;
    if (isTerminalRun(input.run)) return false;

    const statusMessageKey = lifecycleStatusMessageKey({ provider: input.event.callback.provider, runId: input.run.id });
    if (!statusMessageKey) return false;

    const state = delayedLarkStatusCards.get(input.run.id) ?? { cardCreated: false };
    delayedLarkStatusCards.set(input.run.id, state);

    if (!input.createIfMissing && !state.cardCreated) return false;

    const now = larkStatusCardNow();
    const phaseChanged = state.lastPhase !== input.phase;
    const intervalElapsed = !state.lastUpdateAt || now - state.lastUpdateAt >= larkStatusCardMinUpdateIntervalMs;
    if (!input.createIfMissing && !phaseChanged && !intervalElapsed) return false;

    const statusPresentation = presentation.runStatusPresentation({
      runId: input.run.id,
      state: delayedLarkStatusState({ run: input.run, phase: input.phase }),
      message: delayedLarkStatusMessage({ run: input.run, phase: input.phase }),
      nextAction: "Use /status here for active-run and queue state, or wait for the final result.",
      detailVisibility: "source_thread"
    });
    const rendered = presentation.render({
      provider: input.event.callback.provider,
      ...larkRenderLocaleRenderOption(input.event),
      presentation: statusPresentation
    });

    const delivered = await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId: input.run.id,
        kind: "progress",
        provider: input.event.callback.provider,
        uri: input.event.callback.uri,
        body: rendered.body,
        ...(input.event.target.agentId ? { agentId: input.event.target.agentId } : {}),
        threadKey: input.event.callback.threadKey,
        ...(rendered.blocks?.length ? { blocks: rendered.blocks } : {}),
        ...(rendered.rich ? { rich: rendered.rich } : {}),
        statusMessageKey
      }
    });
    if (!delivered) return false;

    state.cardCreated = true;
    state.lastPhase = input.phase;
    state.lastUpdateAt = now;
    return true;
  }

  function scheduleDelayedLarkStatusCard(input: { run: OpenTagRun; event: OpenTagEvent }): void {
    if (!shouldUseDelayedLarkStatusCard(
      input.event.callback.provider,
      larkStatusCardOptions,
      presentation.shouldDeliverStatusUpdate(input.event.callback.provider)
    )) return;
    if (!input.event.callback.threadKey) return;
    if (larkStatusCardDelayMs < 0) return;
    const existing = delayedLarkStatusCards.get(input.run.id);
    if (existing?.timer || existing?.cardCreated) return;

    const state = existing ?? { cardCreated: false };
    const timer = setLarkStatusCardTimeout(() => {
      delete state.timer;
      void (async () => {
        try {
          const latestRun = await repo.getRun({ runId: input.run.id });
          if (!latestRun || isTerminalRun(latestRun.run)) {
            delayedLarkStatusCards.delete(input.run.id);
            return;
          }
          const phase: DelayedLarkStatusPhase = latestRun.run.status === "queued" ? "queued" : "running";
          await deliverDelayedLarkStatusCard({
            run: latestRun.run,
            event: input.event,
            phase,
            createIfMissing: true
          });
        } catch (error) {
          await appendDelayedLarkStatusFailure({ runId: input.run.id, error });
        }
      })();
    }, larkStatusCardDelayMs);
    if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    state.timer = timer;
    delayedLarkStatusCards.set(input.run.id, state);
  }

  function cancelPendingDelayedLarkStatusCard(runId: string): void {
    const state = delayedLarkStatusCards.get(runId);
    if (!state?.timer) return;
    clearLarkStatusCardTimeout(state.timer);
    delete state.timer;
  }

  function clearDelayedLarkStatusCard(runId: string): void {
    cancelPendingDelayedLarkStatusCard(runId);
    delayedLarkStatusCards.delete(runId);
  }

  async function patchDelayedLarkStatusCard(input: {
    run: OpenTagRun;
    event: OpenTagEvent;
    phase: DelayedLarkStatusPhase;
  }): Promise<void> {
    let state = delayedLarkStatusCards.get(input.run.id);
    if (!state?.cardCreated) {
      const statusMessageKey = lifecycleStatusMessageKey({ provider: input.event.callback.provider, runId: input.run.id });
      const externalMessageId =
        statusMessageKey && input.event.callback.threadKey
          ? await repo.findCallbackExternalMessageId({
              runId: input.run.id,
              provider: input.event.callback.provider,
              threadKey: input.event.callback.threadKey,
              statusMessageKey
            })
          : undefined;
      if (!externalMessageId) return;
      state = state ?? { cardCreated: true };
      state.cardCreated = true;
      delayedLarkStatusCards.set(input.run.id, state);
    }
    try {
      await deliverDelayedLarkStatusCard({
        run: input.run,
        event: input.event,
        phase: input.phase
      });
    } catch (error) {
      await appendDelayedLarkStatusFailure({ runId: input.run.id, error });
    }
  }

  async function deliverPromotedFollowUpAcknowledgement(input: {
    run: OpenTagRun;
    event: OpenTagEvent;
  }): Promise<void> {
    if (!presentation.shouldDeliverAcknowledgement(input.event.callback.provider)) return;
    const acknowledgementPresentation = presentation.acknowledgementPresentation({ runId: input.run.id });
    const acknowledgement = presentation.render({
      provider: input.event.callback.provider,
      ...larkRenderLocaleRenderOption(input.event),
      presentation: acknowledgementPresentation
    });
    const statusMessageKey = lifecycleStatusMessageKey({ provider: input.event.callback.provider, runId: input.run.id });
    await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId: input.run.id,
        kind: "acknowledgement",
        provider: input.event.callback.provider,
        uri: input.event.callback.uri,
        body: acknowledgement.body,
        ...(input.event.target.agentId ? { agentId: input.event.target.agentId } : {}),
        ...(input.event.callback.threadKey ? { threadKey: input.event.callback.threadKey } : {}),
        ...(statusMessageKey ? { statusMessageKey } : {}),
        ...(acknowledgement.blocks?.length ? { blocks: acknowledgement.blocks } : {}),
        ...(acknowledgement.rich ? { rich: acknowledgement.rich } : {})
      }
    });
  }

  async function promoteFollowUpRequest(input: {
    followUpRequestId: string;
    runId: string;
  }): Promise<{ followUpRequest: import("@opentag/core").FollowUpRequest; run: OpenTagRun }> {
    const promoted = await repo.createRunFromFollowUpRequest(input);
    await deliverPromotedFollowUpAcknowledgement({
      run: promoted.run,
      event: promoted.followUpRequest.event
    });
    return promoted;
  }

  async function promoteNextFollowUpAfterTerminalRun(input: {
    activeRunId: string;
  }): Promise<{ followUpRequest: import("@opentag/core").FollowUpRequest; run: OpenTagRun } | null> {
    const [next] = await repo.listQueuedFollowUpsForActiveRun({ activeRunId: input.activeRunId });
    if (!next) return null;

    try {
      const promoted = await promoteFollowUpRequest({
        followUpRequestId: next.id,
        runId: `run_${randomUUID()}`
      });
      await repo.appendRunEvent({
        runId: input.activeRunId,
        type: "follow_up_request.auto_promoted",
        payload: {
          followUpRequestId: promoted.followUpRequest.id,
          createdRunId: promoted.run.id
        },
        visibility: "audit",
        importance: "normal",
        message: `Promoted queued follow-up ${promoted.followUpRequest.id} into run ${promoted.run.id}.`
      });
      return promoted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const automaticContinuationRace = error instanceof ActiveConversationRaceError;
      await repo.appendRunEvent({
        runId: input.activeRunId,
        type: automaticContinuationRace
          ? "follow_up_request.auto_promote_deferred"
          : "follow_up_request.auto_promote_failed",
        payload: {
          followUpRequestId: next.id,
          ...(automaticContinuationRace
            ? { activeContinuationRunId: error.activeRunId }
            : { error: message })
        },
        visibility: "audit",
        importance: automaticContinuationRace ? "normal" : "high",
        message: automaticContinuationRace
          ? `Deferred queued follow-up ${next.id} behind the automatic Workstream continuation.`
          : `Could not auto-promote queued follow-up ${next.id}.`
      });
      return null;
    }
  }
  const admission = createAdmissionRuntime({
    repo,
    ...(input.agentAccessProfileCheck ? { agentAccessProfileCheck: input.agentAccessProfileCheck } : {})
  });

  function linearInstallationSummary(input: {
    id: string;
    webhookPath: string;
    repoProvider: string;
    owner: string;
    repo: string;
    graphqlUrl?: string;
    organizationId?: string;
    teamId?: string;
    teamKey?: string;
  }) {
    return {
      id: input.id,
      webhookPath: input.webhookPath,
      projectTarget: {
        repoProvider: input.repoProvider,
        owner: input.owner,
        repo: input.repo
      },
      ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.teamKey ? { teamKey: input.teamKey } : {})
    };
  }

  function linearMappingsFromMetadata(snapshot: Awaited<ReturnType<typeof discoverLinearMetadata>>): AdapterMutationMapping[] {
    return createLinearAdapterMappingDrafts(snapshot).map((draft) => ({
      id: `linear_${draft.domain}_${draft.strategy}`,
      ...draft,
      description: `Discovered from Linear ${draft.domain} metadata during hosted OAuth install.`
    }));
  }

  function singleDiscoveredLinearTeam(input: { snapshot: Awaited<ReturnType<typeof discoverLinearMetadata>>; teamId?: string; teamKey?: string }) {
    const team =
      (input.teamId ? input.snapshot.teams.find((candidate) => candidate.id === input.teamId) : undefined) ??
      (input.teamKey ? input.snapshot.teams.find((candidate) => candidate.key === input.teamKey) : undefined) ??
      (input.snapshot.teams.length === 1 ? input.snapshot.teams[0] : undefined);
    return {
      ...(!input.teamId && team?.id ? { teamId: team.id } : {}),
      ...(!input.teamKey && team?.key ? { teamKey: team.key } : {})
    };
  }

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/relay/capabilities", (c) => c.json(relayCapabilities));

  app.get("/linear/oauth/callback", async (c) => {
    if (!linearOAuthInstall) return c.json({ error: "linear_oauth_install_not_configured" }, 404);

    const error = c.req.query("error");
    if (error) {
      return c.json(
        {
          error: "linear_oauth_error",
          linearError: error,
          ...(c.req.query("error_description") ? { description: c.req.query("error_description") } : {})
        },
        400
      );
    }

    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) return c.json({ error: "missing_linear_oauth_code_or_state" }, 400);

    const pending = await repo.getLinearOAuthInstallState({ state });
    if (!pending) return c.json({ error: "linear_oauth_state_not_found" }, 400);
    if (pending.completedAt) return c.json({ error: "linear_oauth_state_already_completed" }, 409);

    const now = linearOAuthInstall.now?.() ?? new Date();
    const expiresAtMs = Date.parse(pending.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
      return c.json({ error: "linear_oauth_state_expired" }, 410);
    }

    const token = await exchangeLinearOAuthCode({
      clientId: linearOAuthInstall.clientId,
      ...(linearOAuthInstall.clientSecret ? { clientSecret: linearOAuthInstall.clientSecret } : {}),
      code,
      redirectUri: pending.redirectUri,
      ...(linearOAuthInstall.tokenUrl ? { tokenUrl: linearOAuthInstall.tokenUrl } : {}),
      ...(linearOAuthInstall.fetchImpl ? { fetchImpl: linearOAuthInstall.fetchImpl } : {})
    });
    const accessTokenExpiresAt = linearAccessTokenExpiresAt({ token, now });
    let organizationId: string | undefined;
    let appUserId: string | undefined;
    try {
      const identity = await fetchLinearWorkspaceIdentity({
        token: token.accessToken,
        ...(pending.graphqlUrl ? { graphqlUrl: pending.graphqlUrl } : {}),
        ...(linearOAuthInstall.fetchImpl ? { fetchImpl: linearOAuthInstall.fetchImpl } : {})
      });
      organizationId = identity.organization?.id;
      appUserId = identity.viewer.id;
    } catch (error) {
      await recordControlPlaneEvent({
        type: "linear.oauth_install.identity_failed",
        severity: "warn",
        subject: pending.installationId,
        payload: {
          installationId: pending.installationId,
          repoProvider: pending.repoProvider,
          owner: pending.owner,
          repo: pending.repo,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
    let discoveredTeam: { teamId?: string; teamKey?: string } = {};
    let discoverySummary: Record<string, unknown> | undefined;
    try {
      const snapshot = await discoverLinearMetadata({
        token: token.accessToken,
        ...(pending.graphqlUrl ? { graphqlUrl: pending.graphqlUrl } : {}),
        ...(linearOAuthInstall.fetchImpl ? { fetchImpl: linearOAuthInstall.fetchImpl } : {})
      });
      discoveredTeam = singleDiscoveredLinearTeam({
        snapshot,
        ...(pending.teamId ? { teamId: pending.teamId } : {}),
        ...(pending.teamKey ? { teamKey: pending.teamKey } : {})
      });
      const mappings = linearMappingsFromMetadata(snapshot);
      for (const mapping of mappings) {
        await repo.upsertRepoMutationMapping({
          provider: pending.repoProvider,
          owner: pending.owner,
          repo: pending.repo,
          mapping
        });
      }
      discoverySummary = {
        teamCount: snapshot.teams.length,
        stateCount: snapshot.workflowStates.length,
        userCount: snapshot.users.length,
        labelCount: snapshot.issueLabels.length,
        mappingCount: mappings.length
      };
    } catch (error) {
      await recordControlPlaneEvent({
        type: "linear.oauth_install.discovery_failed",
        severity: "warn",
        subject: pending.installationId,
        payload: {
          installationId: pending.installationId,
          repoProvider: pending.repoProvider,
          owner: pending.owner,
          repo: pending.repo,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
    const installation = await repo.upsertLinearRelayInstallation({
      id: pending.installationId,
      webhookPath: pending.webhookPath,
      webhookSecret: pending.webhookSecret,
      token: token.accessToken,
      auth: {
        method: "oauth_app",
        actor: "app",
        clientId: linearOAuthInstall.clientId,
        ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
        ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
        ...(appUserId ? { appUserId } : {}),
        ...((token.scope ?? pending.scopes).length ? { scopes: token.scope ?? pending.scopes } : {})
      },
      ...(pending.graphqlUrl ? { graphqlUrl: pending.graphqlUrl } : {}),
      repoProvider: pending.repoProvider,
      owner: pending.owner,
      repo: pending.repo,
      ...(organizationId ? { organizationId } : {}),
      ...(pending.teamId ?? discoveredTeam.teamId ? { teamId: pending.teamId ?? discoveredTeam.teamId } : {}),
      ...(pending.teamKey ?? discoveredTeam.teamKey ? { teamKey: pending.teamKey ?? discoveredTeam.teamKey } : {})
    });
    await repo.completeLinearOAuthInstallState({ state, completedAt: now.toISOString() });
    await recordControlPlaneEvent({
      type: "linear.oauth_install.completed",
      severity: "info",
      subject: installation.id,
      payload: {
        installationId: installation.id,
        webhookPath: installation.webhookPath,
        repoProvider: installation.repoProvider,
        owner: installation.owner,
        repo: installation.repo,
        ...(organizationId ? { organizationId } : {}),
        ...(appUserId ? { appUserId } : {}),
        hasRefreshToken: Boolean(token.refreshToken),
        hasAccessTokenExpiresAt: Boolean(accessTokenExpiresAt),
        ...(discoverySummary ? { discovery: discoverySummary } : {})
      }
    });
    return c.json({ ok: true, installation: linearInstallationSummary(installation) });
  });

  if (linearOAuthInstall?.webhookSecret) {
    const oauthWebhookPath = linearOAuthInstall.webhookPath ?? "/linear/oauth/webhooks";
    const oauthWebhookSecret = linearOAuthInstall.webhookSecret;
    app.post(oauthWebhookPath, async (c) => {
      let rawBody: string;
      try {
        rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: maxRequestBodyBytes });
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return c.json({ error: "request_body_too_large", maxBytes: error.maxBytes }, 413);
        }
        throw error;
      }

      const signature = c.req.header("linear-signature") ?? c.req.header("Linear-Signature");
      if (!signature || !verifyLinearSignature({ webhookSecret: oauthWebhookSecret, rawBody, signature })) {
        return c.json({ error: "invalid_signature" }, 401);
      }

      const payload = parseLinearWebhookPayload(rawBody);
      if (!payload) return c.json({ error: "invalid_json_body" }, 400);
      if (
        !verifyLinearWebhookTimestamp({
          timestampMs: numberPayloadValue(payload.webhookTimestamp),
          nowMs: Date.now()
        })
      ) {
        return c.json({ error: "invalid_timestamp" }, 400);
      }

      const organizationId = stringPayloadValue(payload.organizationId);
      if (!organizationId) return c.json({ error: "missing_linear_organization_id" }, 400);

      const installation = await repo.getLinearRelayInstallationByOrganizationId({ organizationId });
      if (!installation) {
        if (isLinearOAuthAppRevokedPayload(payload)) {
          return c.json({ ok: true, revoked: true, installationFound: false });
        }
        return c.json({ error: "linear_relay_installation_not_found", organizationId }, 404);
      }

      if (isLinearOAuthAppRevokedPayload(payload)) {
        if (installation.auth?.method === "oauth_app") {
          await repo.deleteLinearRelayInstallation({ id: installation.id });
          linearRelayWebhookApps.delete(installation.id);
          await recordControlPlaneEvent({
            type: "linear.oauth_install.revoked",
            severity: "warn",
            subject: installation.id,
            payload: {
              installationId: installation.id,
              organizationId,
              ...(stringPayloadValue(payload.oauthClientId) ? { oauthClientId: stringPayloadValue(payload.oauthClientId) } : {})
            }
          });
          return c.json({ ok: true, revoked: true, installationId: installation.id });
        }
        return c.json({ ok: true, ignored: true, reason: "linear_installation_not_oauth_app" });
      }

      const linearApp = linearRelayWebhookAppForInstallation({
        installation,
        webhookSecret: oauthWebhookSecret,
        webhookPath: oauthWebhookPath
      });
      return linearApp.request(oauthWebhookPath, {
        method: "POST",
        headers: c.req.raw.headers,
        body: rawBody
      });
    });
  }

  app.post("/linear/webhooks/:installationId", async (c) => {
    const webhookPath = new URL(c.req.url).pathname;
    const installation = await repo.getLinearRelayInstallationByWebhookPath({ webhookPath });
    if (!installation) {
      return c.json({ error: "linear_relay_installation_not_found" }, 404);
    }

    const linearApp = linearRelayWebhookAppForInstallation({
      installation,
      webhookSecret: installation.webhookSecret,
      webhookPath
    });
    return linearApp.fetch(c.req.raw);
  });

  if (input.rateLimit) {
    app.use("/v1/*", createDispatcherRateLimitMiddleware(input.rateLimit));
  }

  app.use("/v1/*", async (c, next) => {
    const authorization = authorizeDispatcherRequest({
      request: c.req.raw,
      pairingToken: input.pairingToken,
      runnerTokens,
      revokedRunnerTokenFingerprints
    });
    if (!authorization.ok) {
      await recordControlPlaneEvent({
        type: "security.auth_failed",
        severity: "warn",
        subject: requestEndpoint(c),
        payload: {
          reason: authorization.reason,
          endpoint: requestEndpoint(c),
          hasAuthorization: Boolean(c.req.raw.headers.get("authorization")),
          tokenFingerprint: rateLimitTokenFingerprint(c.req.raw.headers.get("authorization"))
        }
      });
      return c.json(
        {
          error: "unauthorized",
          reason: authorization.reason,
          ...(authorization.message ? { message: authorization.message } : {})
        },
        401
      );
    }
    await next();
  });

  app.get("/v1/control-plane-events", async (c) => {
    const limitValue = Number(c.req.query("limit") ?? 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.floor(limitValue))) : 100;
    const eventQuery: { limit: number; type?: string; severity?: "info" | "warn" | "error" } = { limit };
    const type = c.req.query("type");
    const severity = c.req.query("severity");
    if (type) eventQuery.type = type;
    if (severity === "info" || severity === "warn" || severity === "error") eventQuery.severity = severity;
    const events = await repo.listControlPlaneEvents(eventQuery);
    return c.json({ events });
  });

  app.post("/v1/control-plane-events", async (c) => {
    const parsed = await parseDispatcherBody(c, RecordControlPlaneEventSchema);
    await recordControlPlaneEvent(parsed);
    return c.json({ ok: true }, 201);
  });

  app.post("/v1/completion-evidence/github", async (c) => {
    const snapshot = await parseDispatcherBody(c, GitHubCompletionEvidenceSchema);
    const expectedRef = `github:${snapshot.repository.owner}/${snapshot.repository.repo}:pull_request:${snapshot.pullRequest.number}`;
    if (snapshot.pullRequest.resourceRef !== expectedRef) {
      return c.json({ error: "invalid_completion_evidence_identity" }, 400);
    }
    let result;
    try {
      result = await completionGovernance.ingestGitHubSnapshot(snapshot);
    } catch (error) {
      if (error instanceof Error && error.message.includes("delivery payload conflicts")) {
        return c.json({ error: "completion_evidence_delivery_conflict", message: error.message }, 409);
      }
      throw error;
    }
    if (result.workThreadId) await deliverCompletionTransition(result.workThreadId);
    const continuation = result.outcome === "recorded" && result.workThreadId
      ? await attemptWorkstreamContinuation({
          workThreadId: result.workThreadId,
          trigger: {
            id: `github-evidence:${snapshot.deliveryId}`,
            kind: "completion_evidence_changed",
            occurredAt: new Date().toISOString()
          }
        })
      : null;
    return c.json({ ...result, ...(continuation ? { continuation } : {}) }, result.outcome === "recorded" ? 201 : 200);
  });

  app.post("/v1/completion-evidence/github/batch", async (c) => {
    const { snapshots } = await parseDispatcherBody(c, GitHubCompletionEvidenceBatchSchema);
    let result;
    try {
      result = await completionGovernance.ingestGitHubSnapshotSet(snapshots);
    } catch (error) {
      if (error instanceof Error && error.message.includes("delivery payload conflicts")) {
        return c.json({ error: "completion_evidence_delivery_conflict", message: error.message }, 409);
      }
      throw error;
    }
    const continuations: WorkstreamContinuationDispatch[] = [];
    for (const workThreadId of result.workThreadIds) {
      await deliverCompletionTransition(workThreadId);
      if (result.outcome === "recorded") {
        continuations.push(await attemptWorkstreamContinuation({
          workThreadId,
          trigger: {
            id: `github-evidence-batch:${result.manifestDigest}:${workThreadId}`,
            kind: "completion_evidence_changed",
            occurredAt: new Date().toISOString()
          }
        }));
      }
    }
    return c.json({ ...result, ...(continuations.length > 0 ? { continuations } : {}) }, result.outcome === "recorded" ? 201 : 200);
  });

  app.post("/v1/completion-escalations/github", async (c) => {
    const request = await parseDispatcherBody(c, z.object({
      operation: z.enum(["open", "resolve"]),
      escalation: z.object({
        class: z.literal("reconciliation"),
        audience: z.literal("repo_owner"),
        subjectRef: z.string().min(1),
        state: z.enum(["open", "resolved"]),
        blocking: z.literal(true),
        summary: z.string().min(1),
        reason: z.string().min(1),
        dedupeKey: z.string().min(1)
      }).strict(),
      correlation: z.object({
        provider: z.literal("github"),
        deliveryId: z.string().min(1),
        eventName: z.enum(["pull_request", "check_run", "check_suite", "status"]),
        repository: z.object({ owner: z.string().min(1), repo: z.string().min(1) }).strict(),
        pullRequestNumbers: z.array(z.number().int().positive()),
        headSha: z.string().min(1).optional()
      }).strict().superRefine((correlation, ctx) => {
        if (correlation.pullRequestNumbers.length === 0 && !correlation.headSha) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A pull request number or head SHA is required." });
        }
      })
    }).strict()) as GitHubCompletionReconciliationEscalationRequest;
    const result = await completionGovernance.handleGitHubReconciliationEscalation(request);
    if (result.workThreadId) await deliverCompletionTransition(result.workThreadId);
    const status = result.outcome === "opened" ? 201 : result.outcome === "uncorrelated" ? 404 : result.outcome === "ambiguous" ? 409 : 200;
    return c.json(result, status);
  });

  app.get("/v1/control-plane-alerts", async (c) => {
    const limitValue = Number(c.req.query("limit") ?? 5_000);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(10_000, Math.floor(limitValue))) : 5_000;
    const since = c.req.query("since");
    const alerts = await repo.summarizeControlPlaneAlerts({
      limit,
      ...(since ? { since } : {})
    });
    return c.json({ alerts });
  });

  app.post("/v1/source-deliveries/prune", async (c) => {
    const parsed = await parseDispatcherBody(c, PruneSourceDeliveriesSchema);
    const pruneInput = {
      olderThan: parsed.olderThan,
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {})
    };
    const result = await repo.pruneSourceDeliveries(pruneInput);
    await recordControlPlaneEvent({
      type: "maintenance.source_deliveries_pruned",
      severity: "info",
      subject: "source_deliveries",
      payload: {
        olderThan: parsed.olderThan,
        limit: parsed.limit ?? null,
        scanned: result.scanned,
        pruned: result.pruned,
        retainedActive: result.retainedActive
      }
    });
    return c.json({ result });
  });

  app.post("/v1/runners", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateRunnerSchema);
    const registration = RunnerRegistrationInputSchema.parse(parsed);
    await repo.registerRunner(parsed);
    await recordControlPlaneEvent({
      type: "runner.registered",
      severity: "info",
      subject: parsed.runnerId,
      payload: {
        runnerId: parsed.runnerId,
        name: parsed.name,
        locality: registration.locality,
        declaredState: registration.declaredState,
        executorIds: registration.executors.map((executor) => executor.executorId),
        maxConcurrentRuns: registration.maxConcurrentRuns,
        preference: registration.preference
      }
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/runners/:runnerId", async (c) => {
    const runner = await repo.getRunner({ runnerId: c.req.param("runnerId") });
    if (!runner) return c.json({ error: "runner_not_found" }, 404);
    return c.json({ runner });
  });

  app.get("/v1/runners", async (c) => {
    return c.json({ runners: await repo.listRunners() });
  });

  app.post("/v1/repo-bindings", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateRepoBindingSchema);
    await repo.createRepoBinding({
      provider: parsed.provider,
      owner: parsed.owner,
      repo: parsed.repo,
      runnerId: parsed.runnerId,
      ...(parsed.fallbackRunnerIds?.length ? { fallbackRunnerIds: parsed.fallbackRunnerIds } : {}),
      ...(parsed.workspacePath ? { workspacePath: parsed.workspacePath } : {}),
      ...(parsed.defaultExecutor ? { defaultExecutor: parsed.defaultExecutor } : {}),
      ...(parsed.fallbackExecutorIds?.length ? { fallbackExecutorIds: parsed.fallbackExecutorIds } : {}),
      ...(parsed.allowedActors?.length ? { allowedActors: parsed.allowedActors } : {})
    });
    await recordControlPlaneEvent({
      type: "binding.repository.upserted",
      severity: "info",
      subject: `${parsed.provider}:${parsed.owner}/${parsed.repo}`,
      payload: {
        provider: parsed.provider,
        owner: parsed.owner,
        repo: parsed.repo,
        runnerId: parsed.runnerId,
        fallbackRunnerIds: parsed.fallbackRunnerIds ?? [],
        hasWorkspacePath: Boolean(parsed.workspacePath),
        ...(parsed.defaultExecutor ? { defaultExecutor: parsed.defaultExecutor } : {}),
        fallbackExecutorIds: parsed.fallbackExecutorIds ?? [],
        allowedActorsCount: parsed.allowedActors?.length ?? 0
      }
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo", async (c) => {
    const binding = await repo.getRepoBinding({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    if (!binding) return c.json({ error: "repo_binding_not_found" }, 404);
    return c.json({ binding });
  });

  app.post("/v1/repo-bindings/:provider/:owner/:repo/policy-rules", async (c) => {
    const parsed = await parseDispatcherBody(c, UpsertPolicyRuleSchema);
    const provider = c.req.param("provider");
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const rule = await repo.upsertRepoPolicyRule({
      provider,
      owner,
      repo: repoName,
      rule: parsed.rule
    });
    await recordControlPlaneEvent({
      type: "binding.repository.policy_rule.upserted",
      severity: "info",
      subject: `${provider}:${owner}/${repoName}:${rule.id}`,
      payload: {
        provider,
        owner,
        repo: repoName,
        ruleId: rule.id,
        scope: rule.scope,
        effect: rule.effect,
        ...(rule.capabilityId ? { capabilityId: rule.capabilityId } : {}),
        ...(rule.mutationDomain ? { mutationDomain: rule.mutationDomain } : {}),
        hasReason: Boolean(rule.reason)
      }
    });
    return c.json({ rule }, 201);
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo/policy-rules", async (c) => {
    const rules = await repo.listRepoPolicyRules({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    return c.json({ rules });
  });

  app.post("/v1/repo-bindings/:provider/:owner/:repo/mutation-mappings", async (c) => {
    const parsed = await parseDispatcherBody(c, UpsertMutationMappingSchema);
    const provider = c.req.param("provider");
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const mapping = await repo.upsertRepoMutationMapping({
      provider,
      owner,
      repo: repoName,
      mapping: parsed.mapping
    });
    await recordControlPlaneEvent({
      type: "binding.repository.mutation_mapping.upserted",
      severity: "info",
      subject: `${provider}:${owner}/${repoName}:${mapping.id}`,
      payload: {
        provider,
        owner,
        repo: repoName,
        mappingId: mapping.id,
        adapter: mapping.adapter,
        domain: mapping.domain,
        strategy: mapping.strategy,
        valueCount: Object.keys(mapping.values).length,
        hasDescription: Boolean(mapping.description)
      }
    });
    return c.json({ mapping }, 201);
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo/mutation-mappings", async (c) => {
    const mappings = await repo.listRepoMutationMappings({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    return c.json({ mappings });
  });

  app.post("/v1/linear-oauth-installations", async (c) => {
    if (!linearOAuthInstall) return c.json({ error: "linear_oauth_install_not_configured" }, 422);
    const parsed = await parseDispatcherBody(c, CreateLinearOAuthInstallationSchema);
    const now = linearOAuthInstall.now?.() ?? new Date();
    const installationId = generateLinearRelayInstallationId();
    const webhookPath = `/linear/webhooks/${installationId}`;
    const scopes = uniqueStrings(parsed.scopes ?? linearOAuthInstall.scopes ?? DEFAULT_LINEAR_AGENT_OAUTH_SCOPES);
    const redirectUri = parsed.redirectUri ?? linearOAuthInstall.redirectUri;
    const state = generateLinearOAuthState();
    const expiresAt = new Date(now.getTime() + (linearOAuthInstall.installStateTtlMs ?? DEFAULT_LINEAR_OAUTH_INSTALL_STATE_TTL_MS)).toISOString();
    const pending = await repo.createLinearOAuthInstallState({
      state,
      installationId,
      webhookPath,
      webhookSecret: generateLinearRelayWebhookSecret(),
      redirectUri,
      ...(parsed.graphqlUrl ? { graphqlUrl: parsed.graphqlUrl } : {}),
      repoProvider: parsed.repoProvider,
      owner: parsed.owner,
      repo: parsed.repo,
      ...(parsed.teamId ? { teamId: parsed.teamId } : {}),
      ...(parsed.teamKey ? { teamKey: parsed.teamKey } : {}),
      scopes,
      expiresAt
    });
    const authorizationUrl = buildLinearOAuthAuthorizationUrl({
      clientId: linearOAuthInstall.clientId,
      redirectUri,
      state,
      scopes,
      actor: "app",
      prompt: "consent",
      ...(linearOAuthInstall.authorizationUrl ? { authorizationUrl: linearOAuthInstall.authorizationUrl } : {})
    });
    await recordControlPlaneEvent({
      type: "linear.oauth_install.started",
      severity: "info",
      subject: pending.installationId,
      payload: {
        installationId: pending.installationId,
        webhookPath: pending.webhookPath,
        repoProvider: pending.repoProvider,
        owner: pending.owner,
        repo: pending.repo,
        scopeCount: scopes.length,
        expiresAt
      }
    });
    return c.json(
      {
        authorizationUrl,
        stateExpiresAt: expiresAt,
        oauthWebhookPath: linearOAuthInstall.webhookPath ?? "/linear/oauth/webhooks",
        installation: linearInstallationSummary({
          id: pending.installationId,
          webhookPath: pending.webhookPath,
          repoProvider: pending.repoProvider,
          owner: pending.owner,
          repo: pending.repo,
          ...(pending.graphqlUrl ? { graphqlUrl: pending.graphqlUrl } : {}),
          ...(pending.teamId ? { teamId: pending.teamId } : {}),
          ...(pending.teamKey ? { teamKey: pending.teamKey } : {})
        })
      },
      201
    );
  });

  app.post("/v1/linear-relay-installations", async (c) => {
    const parsed = await parseDispatcherBody(c, LinearRelayInstallationSchema);
    const installation = await repo.upsertLinearRelayInstallation({
      id: parsed.id,
      webhookPath: parsed.webhookPath,
      webhookSecret: parsed.webhookSecret,
      token: parsed.token,
      auth: linearRelayInstallationAuthFromParsed(parsed.auth),
      ...(parsed.graphqlUrl ? { graphqlUrl: parsed.graphqlUrl } : {}),
      repoProvider: parsed.repoProvider,
      owner: parsed.owner,
      repo: parsed.repo,
      ...(parsed.organizationId ? { organizationId: parsed.organizationId } : {}),
      ...(parsed.teamId ? { teamId: parsed.teamId } : {}),
      ...(parsed.teamKey ? { teamKey: parsed.teamKey } : {})
    });
    await recordControlPlaneEvent({
      type: "linear.relay_installation.upserted",
      severity: "info",
      subject: installation.id,
      payload: {
        installationId: installation.id,
        webhookPath: installation.webhookPath,
        repoProvider: installation.repoProvider,
        owner: installation.owner,
        repo: installation.repo,
        hasGraphqlUrl: Boolean(installation.graphqlUrl),
        hasTeamId: Boolean(installation.teamId),
        hasTeamKey: Boolean(installation.teamKey)
      }
    });
    return c.json(
      {
        installation: linearInstallationSummary(installation)
      },
      201
    );
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo/metrics", async (c) => {
    const metrics = await repo.getRepoMetrics({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    return c.json({ metrics });
  });

  app.get("/v1/work-thread-metrics", async (c) => {
    const threadId = c.req.query("threadId");
    if (!threadId) return c.json({ error: "thread_id_required" }, 422);
    const metrics = await repo.getWorkThreadMetrics({ threadId });
    return c.json({ metrics });
  });

  app.get("/v1/routing/accepted-progress-metrics", async (c) => {
    return c.json({ metrics: await repo.getAcceptedProgressMetrics() });
  });

  app.post("/v1/channel-bindings", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateChannelBindingSchema);
    const principal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
    const adminOverride = c.req.header("x-opentag-channel-admin-override") === "true"
      && authMatches(c.req.raw, input.pairingToken);
    const existing = await repo.getChannelBinding({
      provider: parsed.provider,
      accountId: parsed.accountId,
      conversationId: parsed.conversationId
    });
    const requestedManagedBinding = parsed.ownership
      ? { provider: parsed.provider, ownership: parsed.ownership }
      : undefined;
    if (
      (requestedManagedBinding && !principalOwnsManagedBinding(principal, requestedManagedBinding))
      || (existing?.ownership && !principalOwnsManagedBinding(principal, existing))
    ) {
      if (!adminOverride) return c.json({ error: "managed_channel_principal_required" }, 403);
      await recordControlPlaneEvent({
        type: "binding.channel.admin_override",
        severity: "warn",
        subject: `${parsed.provider}:${parsed.accountId}/${parsed.conversationId}`,
        payload: { provider: parsed.provider, accountId: parsed.accountId, conversationId: parsed.conversationId, operation: "upsert" }
      });
    }
    try {
      await repo.upsertChannelBinding({
        provider: parsed.provider,
        accountId: parsed.accountId,
        conversationId: parsed.conversationId,
        ...(parsed.repoProvider && parsed.owner && parsed.repo
          ? { repoProvider: parsed.repoProvider, owner: parsed.owner, repo: parsed.repo }
          : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        ...(parsed.ownership ? { ownership: parsed.ownership } : {}),
        ...(adminOverride ? { allowManagedOwnershipOverride: true } : {})
      });
    } catch (error) {
      if (error instanceof Error && /Exclusive managed channel binding/u.test(error.message)) {
        return c.json({ error: "managed_channel_binding_conflict" }, 409);
      }
      throw error;
    }
    await recordControlPlaneEvent({
      type: "binding.channel.upserted",
      severity: "info",
      subject: `${parsed.provider}:${parsed.accountId}/${parsed.conversationId}`,
      payload: {
        provider: parsed.provider,
        accountId: parsed.accountId,
        conversationId: parsed.conversationId,
        ...(parsed.repoProvider && parsed.owner && parsed.repo
          ? { repoProvider: parsed.repoProvider, owner: parsed.owner, repo: parsed.repo }
          : {}),
        hasMetadata: Boolean(parsed.metadata),
        ...(parsed.ownership ? { managedOwnership: true } : {})
      }
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/channel-bindings/:provider/:accountId/:conversationId", async (c) => {
    const binding = await repo.getChannelBinding({
      provider: c.req.param("provider"),
      accountId: c.req.param("accountId"),
      conversationId: c.req.param("conversationId")
    });
    if (!binding) return c.json({ error: "channel_binding_not_found" }, 404);
    return c.json({ binding });
  });

  app.get("/v1/channel-bindings/:provider/:accountId/:conversationId/status", async (c) => {
    const provider = c.req.param("provider");
    const accountId = c.req.param("accountId");
    const conversationId = c.req.param("conversationId");
    const binding = await repo.getChannelBinding({ provider, accountId, conversationId });
    if (!binding) return c.json({ error: "channel_binding_not_found" }, 404);
    const principal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
    const adminOverride = c.req.header("x-opentag-channel-admin-override") === "true"
      && authMatches(c.req.raw, input.pairingToken);
    if (binding.ownership && !principalOwnsManagedBinding(principal, binding)) {
      if (!adminOverride) return c.json({ error: "managed_channel_principal_required" }, 403);
      await recordControlPlaneEvent({
        type: "binding.channel.admin_override",
        severity: "warn",
        subject: `${provider}:${accountId}/${conversationId}`,
        payload: { provider, accountId, conversationId, operation: "status" }
      });
    }
    const active = await repo.findCancelableRunForSourceContainer({
      source: provider,
      ...(binding.repoProvider && binding.owner && binding.repo
        ? { repoProvider: binding.repoProvider, owner: binding.owner, repo: binding.repo }
        : {}),
      metadata: sourceContainerMetadata({ provider, accountId, conversationId })
    });
    const queuedFollowUps = active ? await repo.listQueuedFollowUpsForActiveRun({ activeRunId: active.run.id }) : [];
    const runTimeoutMs = active ? latestRunTimeoutMs(await repo.listRunEvents({ runId: active.run.id })) : undefined;
    return c.json({
      binding,
      ...(active ? { activeRun: active.run, activeEvent: active.event } : {}),
      ...(runTimeoutMs ? { runTimeoutPolicy: { hardTimeoutMs: runTimeoutMs } } : {}),
      queuedFollowUps
    });
  });

  app.delete("/v1/channel-bindings/:provider/:accountId/:conversationId", async (c) => {
    const provider = c.req.param("provider");
    const accountId = c.req.param("accountId");
    const conversationId = c.req.param("conversationId");
    const existing = await repo.getChannelBinding({ provider, accountId, conversationId });
    if (!existing) return c.json({ error: "channel_binding_not_found" }, 404);
    const principal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
    const adminOverride = c.req.header("x-opentag-channel-admin-override") === "true"
      && authMatches(c.req.raw, input.pairingToken);
    if (existing.ownership && !principalOwnsManagedBinding(principal, existing) && !adminOverride) {
      return c.json({ error: "managed_channel_principal_required" }, 403);
    }
    if (existing.ownership && adminOverride && !principalOwnsManagedBinding(principal, existing)) {
      await recordControlPlaneEvent({
        type: "binding.channel.admin_override",
        severity: "warn",
        subject: `${provider}:${accountId}/${conversationId}`,
        payload: { provider, accountId, conversationId, operation: "delete" }
      });
    }
    const deleted = await repo.deleteChannelBinding({
      provider,
      accountId,
      conversationId,
      expectedBinding: existing
    });
    if (!deleted) return c.json({ error: "channel_binding_changed" }, 409);
    await recordControlPlaneEvent({
      type: "binding.channel.deleted",
      severity: "info",
      subject: `${provider}:${accountId}/${conversationId}`,
      payload: {
        provider,
        accountId,
        conversationId
      }
    });
    return c.body(null, 204);
  });

  app.post("/v1/channel-bindings/:provider/:accountId/:conversationId/cancel-active-run", async (c) => {
    const provider = c.req.param("provider");
    const accountId = c.req.param("accountId");
    const conversationId = c.req.param("conversationId");
    const parsed = await parseDispatcherBody(c, CancelRunSchema);
    const binding = await repo.getChannelBinding({ provider, accountId, conversationId });
    if (!binding) return c.json({ error: "channel_binding_not_found" }, 404);
    const principal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
    const adminOverride = c.req.header("x-opentag-channel-admin-override") === "true"
      && authMatches(c.req.raw, input.pairingToken);
    if (binding.ownership && !principalOwnsManagedBinding(principal, binding)) {
      if (!adminOverride) return c.json({ error: "managed_channel_principal_required" }, 403);
      await recordControlPlaneEvent({
        type: "binding.channel.admin_override",
        severity: "warn",
        subject: `${provider}:${accountId}/${conversationId}`,
        payload: { provider, accountId, conversationId, operation: "cancel" }
      });
    }
    const active = await repo.findCancelableRunForSourceContainer({
      source: provider,
      ...(binding.repoProvider && binding.owner && binding.repo
        ? { repoProvider: binding.repoProvider, owner: binding.owner, repo: binding.repo }
        : {}),
      metadata: sourceContainerMetadata({ provider, accountId, conversationId })
    });
    if (!active) return c.json({ error: "active_run_not_found" }, 404);
    const outcome = await repo.cancelRun({
      runId: active.run.id,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(parsed.requestedBy ? { requestedBy: parsed.requestedBy } : {})
    });
    if (outcome.outcome === "not_found") return c.json({ error: "run_not_found" }, 404);
    if (outcome.outcome === "already_terminal") {
      return c.json({ error: "run_already_terminal", run: outcome.run }, 409);
    }
    return c.json({ outcome: "cancelled", run: outcome.run });
  });

  app.post("/v1/slack-channel-bindings", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateSlackChannelBindingSchema);
    const existing = await repo.getChannelBinding({
      provider: "slack",
      accountId: parsed.teamId,
      conversationId: parsed.channelId
    });
    const principal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
    const adminOverride = c.req.header("x-opentag-channel-admin-override") === "true"
      && authMatches(c.req.raw, input.pairingToken);
    if (existing?.ownership && !principalOwnsManagedBinding(principal, existing)) {
      if (!adminOverride) return c.json({ error: "managed_channel_principal_required" }, 403);
      await recordControlPlaneEvent({
        type: "binding.channel.admin_override",
        severity: "warn",
        subject: `slack:${parsed.teamId}/${parsed.channelId}`,
        payload: {
          provider: "slack",
          accountId: parsed.teamId,
          conversationId: parsed.channelId,
          operation: "compatibility_upsert"
        }
      });
    }
    await repo.upsertChannelBinding({
      provider: "slack",
      accountId: parsed.teamId,
      conversationId: parsed.channelId,
      repoProvider: parsed.repoProvider ?? "github",
      owner: parsed.owner,
      repo: parsed.repo,
      ...(existing?.metadata ? { metadata: existing.metadata } : {}),
      ...(existing?.ownership ? { ownership: existing.ownership } : {}),
      ...(adminOverride ? { allowManagedOwnershipOverride: true } : {})
    });
    await recordControlPlaneEvent({
      type: "binding.channel.upserted",
      severity: "info",
      subject: `slack:${parsed.teamId}/${parsed.channelId}`,
      payload: {
        provider: "slack",
        accountId: parsed.teamId,
        conversationId: parsed.channelId,
        repoProvider: parsed.repoProvider ?? "github",
        owner: parsed.owner,
        repo: parsed.repo,
        compatibilityEndpoint: "/v1/slack-channel-bindings",
        hasMetadata: false
      }
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/slack-channel-bindings/:teamId/:channelId", async (c) => {
    const binding = await repo.getSlackChannelBinding({
      teamId: c.req.param("teamId"),
      channelId: c.req.param("channelId")
    });
    if (!binding) return c.json({ error: "slack_channel_binding_not_found" }, 404);
    return c.json({ binding });
  });

  app.post("/v1/work-threads/ensure", async (c) => {
    const event = await parseDispatcherBody(c, OpenTagEventSchema);
    const thread = protocolRunFieldsFromEvent(event, event.receivedAt).thread;
    if (!thread) return c.json({ error: "work_thread_required" }, 422);
    const outcome = await repo.upsertWorkThread({ thread, recordedAt: event.receivedAt });
    return c.json({
      workThread: WorkThreadSchema.parse(outcome.thread),
      created: outcome.created
    }, outcome.created ? 201 : 200);
  });

  app.post("/v1/factory-recipes", async (c) => {
    const recipe = await parseDispatcherBody(c, FactoryRecipeSnapshotInputSchema);
    const outcome = await repo.createFactoryRecipeSnapshot({
      id: recipe.id,
      version: recipe.version,
      recipe
    });
    if (outcome.outcome === "conflict") return c.json({ error: "factory_recipe_conflict" }, 409);
    return c.json({ recipe: FactoryRecipeSnapshotSchema.parse({
      ...outcome.recipeSnapshot.recipe,
      createdAt: outcome.recipeSnapshot.createdAt,
      contentDigest: outcome.recipeSnapshot.contentDigest
    }) }, outcome.outcome === "created" ? 201 : 200);
  });

  app.get("/v1/factory-recipes/:id/versions/:version", async (c) => {
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1) return c.json({ error: "invalid_factory_recipe_version" }, 400);
    const stored = await repo.getFactoryRecipeSnapshot({ id: c.req.param("id"), version });
    if (!stored) return c.json({ error: "factory_recipe_not_found" }, 404);
    return c.json({ recipe: FactoryRecipeSnapshotSchema.parse({
      ...stored.recipe,
      createdAt: stored.createdAt,
      contentDigest: stored.contentDigest
    }) });
  });

  app.post("/v1/workstreams", async (c) => {
    const workstream = await parseDispatcherBody(c, WorkstreamInputSchema);
    const outcome = await repo.createFactoryWorkstream({
      id: workstream.id,
      recipeId: workstream.recipeId,
      recipeVersion: workstream.recipeVersion,
      workstream,
      workThreadIds: workstream.members.map((member) => member.workThreadId)
    });
    if (outcome.outcome === "recipe_not_found") return c.json({ error: "factory_recipe_not_found" }, 404);
    if (outcome.outcome === "work_thread_not_found") {
      return c.json({ error: "work_thread_not_found", workThreadId: outcome.workThreadId }, 404);
    }
    if (outcome.outcome === "conflict") return c.json({ error: "workstream_conflict" }, 409);
    const stored = outcome.workstream;
    if (!stored) throw new Error(`Workstream ${workstream.id} was not returned after ${outcome.outcome}.`);
    return c.json({ workstream: WorkstreamSchema.parse({
      ...stored.workstream,
      createdAt: stored.createdAt,
      contentDigest: stored.contentDigest
    }) }, outcome.outcome === "created" ? 201 : 200);
  });

  app.get("/v1/workstreams/:id", async (c) => {
    const stored = await repo.getFactoryWorkstream({ id: c.req.param("id") });
    if (!stored) return c.json({ error: "workstream_not_found" }, 404);
    return c.json({ workstream: WorkstreamSchema.parse({
      ...stored.workstream,
      createdAt: stored.createdAt,
      contentDigest: stored.contentDigest
    }) });
  });

  async function emitWorkstreamBatchSummary(resultValue: z.infer<typeof WorkstreamAdmissionBatchResultSchema>): Promise<void> {
    await recordControlPlaneEvent({
      type: "workstream.batch.exceptions",
      severity: resultValue.summary.exceptionCount > 0 ? "warn" : "info",
      subject: resultValue.workstreamId,
      idempotencyKey: `workstream.batch.exceptions:${resultValue.batchId}`,
      payload: {
        workstreamId: resultValue.workstreamId,
        inputDigest: resultValue.inputDigest,
        summary: resultValue.summary
      }
    });
  }

  function workstreamBatchReceipt(stored: Awaited<ReturnType<typeof repo.getWorkstreamAdmissionBatch>>) {
    if (!stored) throw new Error("Cannot project a missing workstream admission batch.");
    return WorkstreamAdmissionBatchReceiptSchema.parse({
      batch: WorkstreamAdmissionBatchSchema.parse({
        ...WorkstreamAdmissionBatchInputSchema.parse(stored.request),
        createdAt: stored.createdAt,
        contentDigest: stored.requestDigest
      }),
      status: stored.status,
      items: stored.items.map((item) => ({
        itemId: item.itemId,
        index: item.ordinal,
        runId: item.runId,
        workThreadId: item.workThreadId,
        status: item.status,
        ...(item.result ? { result: WorkstreamAdmissionBatchItemResultSchema.parse(item.result) } : {})
      })),
      ...(stored.result ? { result: WorkstreamAdmissionBatchResultSchema.parse(stored.result) } : {}),
      updatedAt: stored.updatedAt,
      ...(stored.completedAt ? { completedAt: stored.completedAt } : {})
    });
  }

  app.post("/v1/workstream-batches", async (c) => {
    const batch = await parseDispatcherBody(c, WorkstreamAdmissionBatchInputSchema);
    const inputDigest = sha256Digest(batch);
    const leaseOwner = `dispatcher_${randomUUID()}`;
    const existedBeforeAdmission = Boolean(await repo.getWorkstreamAdmissionBatch({ id: batch.id }));
    const started = await repo.beginWorkstreamAdmissionBatch({
      id: batch.id,
      workstreamId: batch.workstreamId,
      requestDigest: inputDigest,
      request: batch,
      items: batch.items,
      leaseOwner,
      leaseSeconds: workstreamBatchLeaseSeconds
    });
    if (started.outcome === "conflict") return c.json({ error: "workstream_batch_conflict" }, 409);
    if (started.outcome === "workstream_not_found") return c.json({ error: "workstream_not_found" }, 404);
    if (started.outcome === "invalid_member") {
      return c.json({ error: "workstream_member_mismatch", workThreadId: started.workThreadId }, 409);
    }
    if (!started.batch) throw new Error(`Workstream batch ${batch.id} did not return its durable state.`);
    if (started.outcome === "in_progress") {
      return c.json({ receipt: workstreamBatchReceipt(started.batch) }, 200);
    }
    if (started.outcome === "replay") {
      const durableResult = WorkstreamAdmissionBatchResultSchema.parse(started.batch.result);
      await emitWorkstreamBatchSummary(durableResult);
      return c.json({ receipt: workstreamBatchReceipt(started.batch) }, 200);
    }

    const channelPrincipal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
    const results: z.infer<typeof WorkstreamAdmissionBatchResultSchema>["results"] = [];
    for (const durableItem of started.batch.items) {
      if (durableItem.status === "completed") {
        results.push(WorkstreamAdmissionBatchItemResultSchema.parse(durableItem.result));
        continue;
      }
      const claimed = await repo.claimWorkstreamAdmissionBatchItem({
        batchId: batch.id,
        itemId: durableItem.itemId,
        leaseOwner,
        leaseSeconds: workstreamBatchLeaseSeconds
      });
      if (claimed.outcome === "completed" && claimed.item?.result) {
        results.push(WorkstreamAdmissionBatchItemResultSchema.parse(claimed.item.result));
        continue;
      }
      if (claimed.outcome !== "claimed" || !claimed.item) {
        throw new Error(`Workstream batch item ${durableItem.itemId} could not be claimed: ${claimed.outcome}.`);
      }

      const item = claimed.item;
      const eventThreadId = protocolRunFieldsFromEvent(item.event, item.event.receivedAt).thread?.id;
      const durableThread = await repo.getWorkThread({ workThreadId: item.workThreadId });
      const itemResult = await withWorkstreamAdmissionLease({
        batchId: batch.id,
        itemId: item.itemId,
        leaseOwner
      }, async (): Promise<z.infer<typeof WorkstreamAdmissionBatchResultSchema>["results"][number]> => {
        if (!durableThread || eventThreadId !== item.workThreadId) {
          return {
            itemId: item.itemId,
            index: item.ordinal,
            runId: item.runId,
            status: "rejected",
            statusCode: 409,
            reasonCode: !durableThread ? "work_thread_not_found" : "event_work_thread_mismatch"
          };
        }
        try {
          const admissionResult = await admitAndCreateRun({
            runId: item.runId,
            event: item.event,
            quiet: true,
            workstreamId: batch.workstreamId,
            admissionBatchId: batch.id,
            ...(channelPrincipal ? { channelPrincipal } : {})
          });
          return {
            itemId: item.itemId,
            index: item.ordinal,
            runId: item.runId,
            status: admissionResult.batchStatus,
            statusCode: admissionResult.status,
            ...(admissionResult.reasonCode ? { reasonCode: admissionResult.reasonCode } : {}),
            ...(admissionResult.admittedRunId ? { admittedRunId: admissionResult.admittedRunId } : {}),
            ...(admissionResult.followUpRequestId ? { followUpRequestId: admissionResult.followUpRequestId } : {}),
            ...(admissionResult.humanEscalationId ? { humanEscalationId: admissionResult.humanEscalationId } : {})
          };
        } catch (error) {
          const reasonCode = error instanceof Error && error.message.startsWith("FACTORY_")
            ? error.message.toLowerCase()
            : null;
          if (!reasonCode) throw error;
          return {
            itemId: item.itemId,
            index: item.ordinal,
            runId: item.runId,
            status: "rejected",
            statusCode: 409,
            reasonCode
          };
        }
      });
      const completed = await repo.completeWorkstreamAdmissionBatchItem({
        batchId: batch.id,
        itemId: item.itemId,
        leaseOwner,
        result: itemResult
      });
      if (completed.outcome !== "completed" && completed.outcome !== "duplicate") {
        throw new Error(`Workstream batch item ${item.itemId} could not be completed: ${completed.outcome}.`);
      }
      results.push(itemResult);
    }

    results.sort((left, right) => left.index - right.index);
    const exceptions = results.filter((item) => item.status === "needs_human_decision" || item.status === "rejected");
    const summary = {
      totalItems: results.length,
      createdCount: results.filter((item) => item.status === "created").length,
      idempotentReplayCount: results.filter((item) => item.status === "idempotent_replay").length,
      followUpQueuedCount: results.filter((item) => item.status === "follow_up_queued").length,
      waitActiveRunCount: results.filter((item) => item.status === "wait_active_run").length,
      needsHumanDecisionCount: results.filter((item) => item.status === "needs_human_decision").length,
      rejectedCount: results.filter((item) => item.status === "rejected").length,
      exceptionCount: exceptions.length,
      exceptions: exceptions.slice(0, 10).map((item) => ({
        itemId: item.itemId,
        index: item.index,
        runId: item.runId,
        status: item.status as "needs_human_decision" | "rejected",
        ...(item.reasonCode ? { reasonCode: item.reasonCode } : {})
      })),
      omittedExceptionCount: Math.max(0, exceptions.length - 10)
    };
    const result = WorkstreamAdmissionBatchResultSchema.parse({
      batchId: batch.id,
      workstreamId: batch.workstreamId,
      inputDigest,
      results,
      summary,
      completedAt: new Date().toISOString()
    });
    const finalLease = await repo.renewWorkstreamAdmissionBatchLease({
      batchId: batch.id,
      leaseOwner,
      leaseSeconds: workstreamBatchLeaseSeconds
    });
    if (finalLease.outcome !== "renewed") {
      throw new Error(`Workstream batch ${batch.id} lease could not be renewed before finalization: ${finalLease.outcome}.`);
    }
    const finalized = await repo.finalizeWorkstreamAdmissionBatch({ id: batch.id, leaseOwner, result });
    if (finalized.outcome === "replay" && finalized.batch?.result) {
      const durableResult = WorkstreamAdmissionBatchResultSchema.parse(finalized.batch.result);
      await emitWorkstreamBatchSummary(durableResult);
      return c.json({ receipt: workstreamBatchReceipt(finalized.batch) }, 200);
    }
    if (finalized.outcome !== "completed") {
      throw new Error(`Workstream batch ${batch.id} could not be finalized: ${finalized.outcome}.`);
    }
    await emitWorkstreamBatchSummary(result);
    if (!finalized.batch) throw new Error(`Workstream batch ${batch.id} finalized without durable state.`);
    return c.json({ receipt: workstreamBatchReceipt(finalized.batch) }, existedBeforeAdmission ? 200 : 201);
  });

  app.get("/v1/workstream-batches/:id", async (c) => {
    const batch = await repo.getWorkstreamAdmissionBatch({ id: c.req.param("id") });
    if (!batch) return c.json({ error: "workstream_batch_not_found" }, 404);
    return c.json({ receipt: workstreamBatchReceipt(batch) });
  });

  app.get("/v1/workstreams/:id/metrics", async (c) => {
    const metrics = await repo.getWorkstreamMetrics({ workstreamId: c.req.param("id") });
    if (!metrics) return c.json({ error: "workstream_not_found" }, 404);
    return c.json({ metrics: WorkstreamMetricsSchema.parse(metrics) });
  });

  app.get("/v1/workstreams/:id/evaluation", async (c) => {
    const storedWorkstream = await repo.getFactoryWorkstream({ id: c.req.param("id") });
    if (!storedWorkstream) return c.json({ error: "workstream_not_found" }, 404);
    const workstream = WorkstreamSchema.parse({
      ...storedWorkstream.workstream,
      createdAt: storedWorkstream.createdAt,
      contentDigest: storedWorkstream.contentDigest
    });
    const storedRecipe = await repo.getFactoryRecipeSnapshot({ id: workstream.recipeId, version: workstream.recipeVersion });
    if (!storedRecipe) return c.json({ error: "factory_recipe_not_found" }, 404);
    const metrics = await repo.getWorkstreamMetrics({ workstreamId: workstream.id });
    if (!metrics) return c.json({ error: "workstream_not_found" }, 404);
    const evaluation = evaluateWorkstream({
      recipe: FactoryRecipeSnapshotSchema.parse({
        ...storedRecipe.recipe,
        createdAt: storedRecipe.createdAt,
        contentDigest: storedRecipe.contentDigest
      }),
      workstream,
      metrics: WorkstreamMetricsSchema.parse(metrics),
      evaluatedAt: input.completionNow?.() ?? new Date().toISOString()
    });
    return c.json({ evaluation });
  });

  app.post("/v1/runs", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateRunSchema);
    const channelPrincipal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
    const result = await admitAndCreateRun({
      runId: parsed.runId,
      event: parsed.event,
      ...(channelPrincipal ? { channelPrincipal } : {})
    });
    return c.json(result.body, result.status);
  });

  app.post("/v1/thread-actions", async (c) => {
    const parsed = await parseDispatcherBody(c, ThreadActionInputSchema);
    const controlCommand = parseThreadControlCommand(parsed.rawText);
    if (controlCommand) {
      const channelPrincipal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
      return sourceThreadControl.handle({
        request: parsed,
        command: controlCommand,
        ...(channelPrincipal ? { channelPrincipal } : {})
      });
    }

    const command = parseThreadActionCommand(parsed.rawText);
    if (!command) {
      return c.json({ outcome: "ignored", reason: "not_action_command" }, 202);
    }

    const resolved = await resolveThreadAction({
      repo,
      command,
      callback: parsed.callback,
      ...(parsed.metadata ? { metadata: parsed.metadata } : {})
    });
    if (!resolved.ok) {
      if (resolved.runId) {
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: resolved.runId,
            kind: "final",
            provider: parsed.callback.provider,
            uri: parsed.callback.uri,
            body: resolved.message,
            ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
          }
        });
      }
      return c.json({ outcome: resolved.reason, message: resolved.message }, resolved.reason === "no_proposal" ? 404 : 409);
    }

    const authorization = await authorizeThreadAction({
      repo,
      resolved: resolved.resolved,
      actor: parsed.actor
    });
    if (!authorization.ok) {
      return c.json({ outcome: "unauthorized", reason: authorization.reason, message: authorization.message }, 403);
    }

    const proposalMetadata = resolved.resolved.proposal.snapshot.metadata;
    const governedPermission = proposalMetadata?.["kind"] === "acp_permission";
    const requestedPermissionDecision = governedPermissionDecision(parsed.metadata?.["permissionDecision"]);
    if (governedPermission) {
      const expectedActionId = proposalMetadata?.["actionId"];
      const expectedProposalHash = proposalMetadata?.["proposalHash"];
      const expectedApprovalEpoch = proposalMetadata?.["approvalEpoch"];
      const expectedIntentId = typeof expectedActionId === "string" ? `intent_${expectedActionId}` : undefined;
      const compatibleVerb = requestedPermissionDecision === "deny" ? command.verb === "reject" : command.verb === "approve";
      if (
        !requestedPermissionDecision ||
        parsed.metadata?.["proposalHash"] !== expectedProposalHash ||
        parsed.metadata?.["approvalEpoch"] !== expectedApprovalEpoch ||
        parsed.metadata?.["governedActionId"] !== expectedActionId ||
        parsed.metadata?.["proposalId"] !== resolved.resolved.proposal.snapshot.proposalId ||
        parsed.metadata?.["intentId"] !== expectedIntentId ||
        !compatibleVerb
      ) {
        return c.json({ outcome: "approval_identity_mismatch", message: "The governed approval payload does not match the immutable proposal." }, 409);
      }
    }

    const selectionText = selectedActionSummary(resolved.resolved.selectedCandidates);
    const selectedIntents = resolved.resolved.proposal.snapshot.intents.filter((intent) =>
      resolved.resolved.selectedIntentIds.includes(intent.intentId)
    );
    const adapter = adapterForAction({
      event: resolved.resolved.proposal.event,
      callbackProvider: parsed.callback.provider,
      selectedIntents
    });
    const applyPlanId = stableApplyPlanId({ resolved: resolved.resolved, adapter });
    if (command.verb === "apply") {
      const existingPlan = await repo.getApplyPlan({ id: applyPlanId });
      if (existingPlan) {
        const existingDecision = await repo.getApprovalDecision({ id: existingPlan.approvalDecisionId });
        if (selectedIntentsAlreadyApplied({ plan: existingPlan, selectedIntentIds: resolved.resolved.selectedIntentIds })) {
          await deliverAndAudit({
            repo,
            sink: callbackSink,
            retry: callbackRetry,
            message: {
              runId: resolved.resolved.proposal.runId,
              kind: "final",
              provider: parsed.callback.provider,
              uri: parsed.callback.uri,
              body: renderAlreadyAppliedThreadActionBody({ selectionText }),
              ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
            }
          });
          return c.json({ outcome: "already_applied", decision: existingDecision, plan: existingPlan }, 200);
        }
        const isStale = selectedIntentsHaveStaleOutcome({
          plan: existingPlan,
          selectedIntentIds: resolved.resolved.selectedIntentIds
        });
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: resolved.resolved.proposal.runId,
            kind: "final",
            provider: parsed.callback.provider,
            uri: parsed.callback.uri,
            body: isStale
              ? renderStaleThreadActionBody({
                  selectionText,
                  continueIndex: resolved.resolved.selectedCandidates[0]?.index ?? 1
                })
              : renderAlreadyPlannedThreadActionBody({ selectionText }),
            ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
          }
        });
        return c.json({ outcome: isStale ? "stale" : "already_planned", decision: existingDecision, plan: existingPlan }, 200);
      }
    }

    const providedDecision = parsed.id ? await repo.getApprovalDecision({ id: parsed.id }) : null;
    const canReuseProvidedDecision = providedDecision
      ? approvalDecisionMatchesThreadAction({
          decision: providedDecision,
          command,
          resolved: resolved.resolved,
          actor: parsed.actor
        })
      : false;
    const approvalId = parsed.id && (!providedDecision || canReuseProvidedDecision)
      ? parsed.id
      : stableApprovalId({
          command,
          resolved: resolved.resolved,
          actor: parsed.actor
        });
    const existingDecision = canReuseProvidedDecision
      ? providedDecision
      : await repo.getApprovalDecision({ id: approvalId });
    const decision = existingDecision ?? await repo.recordApprovalDecision({
      id: approvalId,
      proposalId: resolved.resolved.proposal.snapshot.proposalId,
      approvedIntentIds: command.verb === "reject" ? [] : resolved.resolved.selectedIntentIds,
      ...(command.verb === "reject" ? { rejectedIntentIds: resolved.resolved.selectedIntentIds } : {}),
      approvedBy: parsed.actor,
      approvedAt: new Date().toISOString(),
      scope: "manual",
      ...(command.reason ? { reason: command.reason } : {}),
      metadata: {
        source: "thread_action",
        rawText: command.rawText,
        verb: command.verb,
        selection: command.selection,
        callback: parsed.callback,
        ...(governedPermission
          ? {
              permissionDecision: requestedPermissionDecision,
              actionId: proposalMetadata?.["actionId"],
              proposalHash: proposalMetadata?.["proposalHash"],
              approvalEpoch: proposalMetadata?.["approvalEpoch"]
            }
          : parsed.metadata?.["permissionDecision"] === "allow_run" || /(?:always|this run|本次运行|同类任务)/iu.test(command.reason ?? "")
            ? { permissionDecision: "allow_run" }
            : { permissionDecision: command.verb === "reject" ? "deny" : "allow_once" }),
        ...(parsed.metadata ? { ingressMetadata: parsed.metadata } : {})
      }
    });
    if (!decision) {
      return c.json({ error: "proposal_not_found" }, 404);
    }

    if (command.verb === "reject") {
      if (existingDecision) {
        return c.json({ outcome: "already_rejected", decision }, 200);
      }
      const body = governedPermission && requestedPermissionDecision
        ? renderGovernedPermissionDecisionBody({ decision: requestedPermissionDecision, selectionText })
        : renderThreadActionRecordedBody({ verb: "reject", selectionText });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body,
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "rejected", decision }, 201);
    }

    if (command.verb === "approve") {
      if (existingDecision) {
        return c.json({ outcome: "already_approved", decision }, 200);
      }
      let body: string;
      if (governedPermission && requestedPermissionDecision) {
        body = renderGovernedPermissionDecisionBody({ decision: requestedPermissionDecision, selectionText });
      } else {
        const linearApply = await linearApplyOptionsForEvent(resolved.resolved.proposal.event);
        const directApply = await selectedDirectApplyStatus({
          event: resolved.resolved.proposal.event,
          callbackProvider: parsed.callback.provider,
          candidates: resolved.resolved.selectedCandidates,
          ...(input.githubApply ? { githubApply: input.githubApply } : {}),
          ...(input.gitlabApply ? { gitlabApply: input.gitlabApply } : {}),
          ...(linearApply ? { linearApply } : {})
        });
        body = renderThreadActionRecordedBody({
          verb: "approve",
          selectionText,
          applyIndex: resolved.resolved.selectedCandidates[0]?.index ?? 1,
          directApply
        });
      }
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body,
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "approved", decision }, 201);
    }

    if (command.verb === "continue") {
      let childRun: OpenTagRun;
      try {
        childRun = await createChildRunForThreadAction({
          repo,
          command,
          resolved: resolved.resolved,
          runId: stableChildRunId({ command, resolved: resolved.resolved }),
          approvalDecisionId: decision.id
        });
      } catch (error) {
        if (!(error instanceof ActiveConversationRaceError)) throw error;
        return c.json({
          outcome: "deferred",
          decision,
          activeRunId: error.activeRunId,
          reason: "An automatic Workstream continuation already owns this source conversation."
        }, 409);
      }
      const body = renderChildRunCreatedBody({
        lead: "Continuing in OpenTag from this approved action.",
        resolved: resolved.resolved,
        childRun,
        provider: parsed.callback.provider,
        selectionText,
        approvalDecisionId: decision.id
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body,
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "child_run_created", decision, run: childRun }, 201);
    }

    const planResult = await repo.createApplyPlanOnce({
      id: applyPlanId,
      proposalId: resolved.resolved.proposal.snapshot.proposalId,
      approvalDecisionId: decision.id,
      selectedIntentIds: resolved.resolved.selectedIntentIds,
      adapter
    });
    if (!planResult) {
      return c.json({ error: "proposal_or_approval_not_found" }, 404);
    }
    if (!planResult.created) {
      if (selectedIntentsAlreadyApplied({ plan: planResult.plan, selectedIntentIds: resolved.resolved.selectedIntentIds })) {
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: resolved.resolved.proposal.runId,
            kind: "final",
            provider: parsed.callback.provider,
            uri: parsed.callback.uri,
            body: renderAlreadyAppliedThreadActionBody({ selectionText }),
            ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
          }
        });
        return c.json({ outcome: "already_applied", decision, plan: planResult.plan }, 200);
      }
      const isStale = selectedIntentsHaveStaleOutcome({
        plan: planResult.plan,
        selectedIntentIds: resolved.resolved.selectedIntentIds
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body: isStale
            ? renderStaleThreadActionBody({
                selectionText,
                continueIndex: resolved.resolved.selectedCandidates[0]?.index ?? 1
              })
            : renderAlreadyPlannedThreadActionBody({ selectionText }),
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: isStale ? "stale" : "already_planned", decision, plan: planResult.plan }, 200);
    }
    const plan = planResult.plan;
    const linearApply = await linearApplyOptionsForEvent(resolved.resolved.proposal.event);

    const execution = await executeDirectApplyPlan({
      repo,
      plan,
      resolved: resolved.resolved,
      ...(input.githubApply ? { githubApply: input.githubApply } : {}),
      ...(input.gitlabApply ? { gitlabApply: input.gitlabApply } : {}),
      ...(linearApply ? { linearApply } : {})
    });
    if (execution.executed) {
      const outcomes = execution.plan.outcomes ?? [];
      const body = renderAppliedThreadActionBody({
        selectionText,
        selectedIntentIds: resolved.resolved.selectedIntentIds,
        outcomes
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body,
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "applied", decision, plan: execution.plan }, 201);
    }

    if (selectedIntentsHaveStaleOutcome({ plan: execution.plan, selectedIntentIds: resolved.resolved.selectedIntentIds })) {
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body: renderStaleThreadActionBody({
            selectionText,
            continueIndex: resolved.resolved.selectedCandidates[0]?.index ?? 1
          }),
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "stale", decision, plan: execution.plan }, 200);
    }

    let childRun: OpenTagRun;
    try {
      childRun = await createChildRunForThreadAction({
        repo,
        command,
        resolved: resolved.resolved,
        runId: stableChildRunId({
          command,
          resolved: resolved.resolved,
          sourceApplyPlanId: execution.plan.id,
          fallbackReason: execution.fallbackReason ?? "OpenTag cannot directly apply this intent yet."
        }),
        approvalDecisionId: decision.id,
        sourceApplyPlanId: execution.plan.id,
        fallbackReason: execution.fallbackReason ?? "OpenTag cannot directly apply this intent yet."
      });
    } catch (error) {
      if (!(error instanceof ActiveConversationRaceError)) throw error;
      return c.json({
        outcome: "deferred",
        decision,
        plan: execution.plan,
        activeRunId: error.activeRunId,
        reason: "An automatic Workstream continuation already owns this source conversation."
      }, 409);
    }
    const body = renderChildRunCreatedBody({
      lead: "Needs setup before OpenTag can apply this action directly.",
      resolved: resolved.resolved,
      childRun,
      provider: parsed.callback.provider,
      selectionText,
      approvalDecisionId: decision.id,
      sourceApplyPlanId: execution.plan.id,
      fallbackReason: execution.fallbackReason ?? "The adapter could not execute the selected intent."
    });
    await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId: resolved.resolved.proposal.runId,
        kind: "final",
        provider: parsed.callback.provider,
        uri: parsed.callback.uri,
        body,
        ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
      }
    });
    return c.json({ outcome: "child_run_created", decision, plan: execution.plan, run: childRun }, 201);
  });

  app.get("/v1/follow-up-requests/:id", async (c) => {
    const followUpRequest = await repo.getFollowUpRequest({ id: c.req.param("id") });
    if (!followUpRequest) return c.json({ error: "follow_up_request_not_found" }, 404);
    return c.json({ followUpRequest });
  });

  app.post("/v1/follow-up-requests/:id/create-run", async (c) => {
    const parsed = await parseDispatcherBody(c, PromoteFollowUpRequestSchema);
    let promoted;
    try {
      promoted = await promoteFollowUpRequest({
        followUpRequestId: c.req.param("id"),
        runId: parsed.runId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Follow-up request not found:")) {
        return c.json({ error: "follow_up_request_not_found" }, 404);
      }
      if (message.includes("is not queued")) {
        return c.json({ error: "follow_up_request_not_queued" }, 409);
      }
      if (error instanceof ActiveConversationRaceError) {
        return c.json({
          error: "active_conversation_race",
          activeRunId: error.activeRunId
        }, 409);
      }
      throw error;
    }
    const followUpRequest = promoted.followUpRequest;
    return c.json({ followUpRequest, run: promoted.run }, 201);
  });

  app.post("/v1/runners/:runnerId/claim", async (c) => {
    const claimed = await repo.claimNextRun({ runnerId: c.req.param("runnerId"), leaseSeconds: runnerLeaseSeconds });
    if (!claimed) return c.body(null, 204);
    return c.json(claimed, 200);
  });

  app.post("/v1/runners/:runnerId/runs/:runId/heartbeat", async (c) => {
    const body = await parseDispatcherBody(c, AttemptLeaseSchema);
    const outcome = await repo.heartbeat({
      runnerId: c.req.param("runnerId"),
      runId: c.req.param("runId"),
      attemptId: body.attemptId,
      fencingToken: body.fencingToken
    });
    if (outcome === "not_found") return c.json({ error: "run_not_claimed_by_runner" }, 404);
    if (outcome === "stale_attempt") return c.json({ error: "stale_attempt" }, 409);
    return c.json({ ok: true });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/action-permissions", async (c) => {
    const runnerId = c.req.param("runnerId");
    const runId = c.req.param("runId");
    const body = await parseDispatcherBody(c, ActionPermissionInputSchema);
    const resolution = await repo.requestActionPermission({
      runnerId,
      runId,
      attemptId: body.attemptId,
      fencingToken: body.fencingToken,
      request: body.request
    });
    if (!resolution) return c.json({ error: "stale_attempt" }, 409);
    if (resolution.state === "waiting" && resolution.action.proposalId) {
      const stored = await repo.getRun({ runId });
      const proposal = await repo.getSuggestedChanges({ proposalId: resolution.action.proposalId });
      const approvalEpoch = proposal?.snapshot.metadata?.["approvalEpoch"];
      if (stored && proposal && resolution.action.proposalHash && typeof approvalEpoch === "string") {
        const approvalPrompt = OpenTagApprovalPromptPresentationSchema.parse({
          kind: "approval_prompt",
          runId,
          approvalId: `approval_${resolution.action.id}`,
          proposalId: proposal.snapshot.proposalId,
          intentId: `intent_${resolution.action.id}`,
          actionId: resolution.action.id,
          proposalHash: resolution.action.proposalHash,
          approvalEpoch,
          title: `Allow ${resolution.action.actionFamily}?`,
          summary: proposal.snapshot.summary,
          target: {
            provider: resolution.action.target["provider"],
            connectionId: resolution.action.target["connectionId"],
            operation: resolution.action.target["operation"],
            resource: resolution.action.target["resource"],
            ...(typeof resolution.action.target["resourceVersion"] === "string" ? { resourceVersion: resolution.action.target["resourceVersion"] } : {})
          },
          runScope: resolution.action.scope,
          decisions: actionScopeAllowsRunReuse(resolution.action.scope) ? ["allow_once", "allow_run", "deny"] : ["allow_once", "deny"]
        });
        const rendered = presentation.render({
          provider: stored.event.callback.provider,
          ...larkRenderLocaleRenderOption(stored.event),
          presentation: approvalPrompt
        });
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId,
            kind: "progress",
            provider: stored.event.callback.provider,
            uri: stored.event.callback.uri,
            body: rendered.body,
            ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
            ...(rendered.blocks?.length ? { blocks: rendered.blocks } : {}),
            ...(rendered.rich ? { rich: rendered.rich } : {}),
            idempotencyKey: `action-permission:${resolution.action.id}`,
            statusMessageKey: `${runId}:status`
          }
        });
      }
    }
    return c.json({ resolution }, resolution.state === "waiting" ? 202 : 200);
  });

  app.post("/v1/runners/:runnerId/runs/:runId/action-permissions/:actionId/resolve", async (c) => {
    const body = await parseDispatcherBody(c, ActionPermissionResolutionInputSchema);
    const resolution = await repo.resolveActionPermission({
      runnerId: c.req.param("runnerId"),
      runId: c.req.param("runId"),
      actionId: c.req.param("actionId"),
      attemptId: body.attemptId,
      fencingToken: body.fencingToken
    });
    if (!resolution) return c.json({ error: "action_not_found" }, 404);
    return c.json({ resolution }, resolution.state === "waiting" ? 202 : resolution.state === "stale" ? 409 : 200);
  });

  app.post("/v1/runners/:runnerId/runs/:runId/material-actions/:actionId/receipt", async (c) => {
    const body = await parseDispatcherBody(c, MaterialActionReceiptInputSchema);
    const resolution = await repo.recordMaterialActionReceipt({
      runnerId: c.req.param("runnerId"),
      runId: c.req.param("runId"),
      actionId: c.req.param("actionId"),
      attemptId: body.attemptId,
      fencingToken: body.fencingToken,
      receipt: body.receipt
    });
    if (!resolution) return c.json({ error: "action_not_found" }, 404);
    if (resolution.state === "stale") return c.json({ error: "stale_attempt", resolution }, 409);
    const completion = await completionGovernance.reassessRun(c.req.param("runId"));
    if (completion) await deliverCompletionTransition(completion.assessment.workThreadId);
    return c.json({ resolution, ...(completion ? { completion: completion.view } : {}) }, 200);
  });

  app.post("/v1/material-actions/:actionId/reconcile", async (c) => {
    const body = await parseDispatcherBody(c, ReconcileUnknownMaterialActionSchema);
    const result = await repo.reconcileUnknownMaterialAction({
      actionId: c.req.param("actionId"),
      outcome: body.outcome,
      idempotencyKey: body.idempotencyKey,
      receiptRef: body.receiptRef,
      source: "control_plane_admin",
      actorId: "pairing-authenticated-admin",
      ...(body.evidence ? { evidence: body.evidence } : {})
    });
    if (result.outcome === "not_found") return c.json({ error: "action_not_found" }, 404);
    if (result.outcome === "conflict") return c.json({ error: "reconciliation_conflict", action: result.action }, 409);
    if (result.outcome === "reconciled" && result.action) {
      const completion = await completionGovernance.reassessRun(result.action.runId);
      if (completion) await deliverCompletionTransition(completion.assessment.workThreadId);
      const stored = await repo.getRun({ runId: result.action.runId });
      if (stored) {
        const bodyText = `Material action ${result.action.id} reconciled as ${result.action.status}.`;
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: result.action.runId,
            kind: "progress",
            provider: stored.event.callback.provider,
            uri: stored.event.callback.uri,
            body: bodyText,
            ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
            idempotencyKey: `material-action-reconciliation:${body.idempotencyKey}`
          }
        });
      }
    }
    return c.json({ result, replayed: result.outcome === "replayed" }, 200);
  });

  app.post("/v1/runs/:runId/running", async (c) => {
    return c.json({
      error: "runner_scoped_endpoint_required",
      message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
    }, 410);
  });

  app.post("/v1/runners/:runnerId/runs/:runId/reject-start", async (c) => {
    const runId = c.req.param("runId");
    const body = await parseDispatcherBody(c, RejectAttemptStartSchema);
    const outcome = await repo.rejectAttemptStart({
      runId,
      runnerId: c.req.param("runnerId"),
      attemptId: body.attemptId,
      fencingToken: body.fencingToken,
      executorId: body.executorId,
      reason: body.reason
    });
    if (outcome === "not_found") return c.json({ error: "run_not_found" }, 404);
    if (outcome === "stale_attempt") return c.json({ error: "stale_attempt" }, 409);
    return c.json({ ok: true, replayed: outcome === "duplicate" });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/running", async (c) => {
    const runId = c.req.param("runId");
    const body = await parseDispatcherBody(c, MarkRunningSchema);
    const headerIdempotencyKey = c.req.header("idempotency-key")?.trim();
    const idempotencyKey = body.idempotencyKey?.trim() || headerIdempotencyKey;
    const safeRunningFields = sanitizeCredentialLikeValue({
      executor: body.executor,
      ...(body.executorCapability !== undefined ? { executorCapability: body.executorCapability } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {})
    }, { secrets: [body.fencingToken] });
    const runningOutcome = await repo.markRunning({
      runId,
      runnerId: c.req.param("runnerId"),
      attemptId: body.attemptId,
      fencingToken: body.fencingToken,
      executor: safeRunningFields.executor,
      ...(safeRunningFields.executorCapability !== undefined ? { executorCapability: safeRunningFields.executorCapability } : {}),
      ...(body.runTimeoutMs ? { runTimeoutMs: body.runTimeoutMs } : {}),
      ...(safeRunningFields.idempotencyKey ? { idempotencyKey: safeRunningFields.idempotencyKey } : {})
    });
    if (runningOutcome === "not_found") return c.json({ error: "run_not_claimed_by_runner" }, 404);
    if (runningOutcome === "stale_attempt") return c.json({ error: "stale_attempt" }, 409);
    if (runningOutcome === "duplicate") return c.json({ ok: true, replayed: true });
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const provider = stored.event.callback.provider;
    if (shouldDeliverSourceReceipt(provider)) {
      await deliverSourceReceiptBestEffort({
        repo,
        sink: sourceReceiptSink,
        receipt: {
          runId,
          provider,
          state: "running",
          event: stored.event,
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {})
        }
      });
    }
    if (shouldDeliverRunStatusUpdate(presentation, { provider, state: "running" })) {
      const runningPresentation = presentation.runStatusPresentation({
        runId,
        state: "running",
        message: `Running with ${safeExecutorLabel(stored.run.executor)}.`,
        nextAction: "Wait for the final reply, send a follow-up to queue more context, or request cancellation with /stop.",
        detailVisibility: "source_thread"
      });
      const running = presentation.render({
        provider,
        ...larkRenderLocaleRenderOption(stored.event),
        presentation: runningPresentation
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId,
          kind: "progress",
          provider,
          uri: stored.event.callback.uri,
          body: running.body,
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
          ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
          ...(running.blocks?.length ? { blocks: running.blocks } : {}),
          ...(running.rich ? { rich: running.rich } : {}),
          statusMessageKey: `${runId}:status`
        }
      });
    } else if (presentation.shouldDeliverStatusUpdate(provider)) {
      await appendSuppressedRunStatusCallback({ runId, provider, state: "running" });
    }
    await patchDelayedLarkStatusCard({
      run: stored.run,
      event: stored.event,
      phase: "running"
    });
    return c.json({ ok: true });
  });

  app.post("/v1/runs/:runId/progress", async () => {
    return new Response(JSON.stringify({
      error: "runner_scoped_endpoint_required",
      message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
    }), { status: 410, headers: { "content-type": "application/json" } });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/progress", async (c) => {
    const runId = c.req.param("runId");
    const body = await parseDispatcherBody(c, ProgressSchema);
    const headerIdempotencyKey = c.req.header("idempotency-key")?.trim();
    const idempotencyKey = body.idempotencyKey?.trim() || headerIdempotencyKey;
    const safeProgressFields = sanitizeCredentialLikeValue({
      message: body.message,
      ...(body.type ? { type: body.type } : {})
    }, { secrets: [body.fencingToken] });
    const progressVisibility = channelProgressVisibility({
      ...(safeProgressFields.type ? { type: safeProgressFields.type } : {}),
      ...(body.visibility ? { requested: body.visibility } : {})
    });
    const progressOutcome = await repo.recordProgress({
      runId,
      runnerId: c.req.param("runnerId"),
      attemptId: body.attemptId,
      fencingToken: body.fencingToken,
      message: safeProgressFields.message,
      ...(safeProgressFields.type ? { type: safeProgressFields.type } : {}),
      ...(body.at ? { at: body.at } : {}),
      visibility: progressVisibility,
      ...(body.importance ? { importance: body.importance } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
    if (progressOutcome === "not_found") return c.json({ error: "run_not_claimed_by_runner" }, 404);
    if (progressOutcome === "stale_attempt") return c.json({ error: "stale_attempt" }, 409);
    if (typeof progressOutcome === "object" && progressOutcome.outcome === "duplicate") return c.json({ ok: true, replayed: true });
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const shouldDeliverProgress = presentation.shouldDeliverProgress(stored.event.callback.provider);
    if (progressVisibility === "human" && shouldDeliverProgress) {
      const progressPresentation = presentation.progressPresentation({
        runId,
        message: typeof progressOutcome === "object" ? progressOutcome.event.message ?? "Progress update recorded." : "Progress update recorded."
      });
      const progress = presentation.render({
        provider: stored.event.callback.provider,
        ...larkRenderLocaleRenderOption(stored.event),
        presentation: progressPresentation
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId,
          kind: "progress",
          provider: stored.event.callback.provider,
          uri: stored.event.callback.uri,
          body: progress.body,
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
          ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
          ...(progress.blocks?.length ? { blocks: progress.blocks } : {}),
          ...(progress.rich ? { rich: progress.rich } : {}),
          ...(typeof progressOutcome === "object" ? { idempotencyKey: `run-progress:${progressOutcome.event.id}` } : {}),
          statusMessageKey: `${runId}:status`
        }
      });
    } else if (progressVisibility === "human") {
      const capability = platformCapabilityForProvider(stored.event.callback.provider);
      await repo.appendRunEvent({
        runId,
        type: "callback.progress.suppressed",
        payload: {
          provider: stored.event.callback.provider,
          reason: "platform_liveness_strategy",
          requestedVisibility: progressVisibility,
          livenessStrategy: capability?.livenessStrategy ?? "unknown"
        },
        visibility: "audit",
        importance: "low",
        message: "Progress callback suppressed by platform liveness strategy; use status or audit for details."
      });
    }
    await patchDelayedLarkStatusCard({
      run: stored.run,
      event: stored.event,
      phase: "progress"
    });
    return c.json({ ok: true });
  });

  app.post("/v1/runs/:runId/complete", async () => {
    return new Response(JSON.stringify({
      error: "runner_scoped_endpoint_required",
      message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
    }), { status: 410, headers: { "content-type": "application/json" } });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/complete", async (c) => {
    const runId = c.req.param("runId");
    const parsed = await parseDispatcherBody(c, CompleteRunSchema);
    const headerIdempotencyKey = c.req.header("idempotency-key")?.trim();
    const idempotencyKey = parsed.idempotencyKey?.trim() || headerIdempotencyKey;
    const safeCompleteFields = sanitizeCredentialLikeValue({
      result: parsed.result,
      ...(idempotencyKey ? { idempotencyKey } : {})
    }, { secrets: [parsed.fencingToken] });
    const safeResult = OpenTagRunResultSchema.parse(safeCompleteFields.result);
    const completingRun = await repo.getRun({ runId });
    const needsHuman = completingRun
      ? normalizeNeedsHumanResult({
          run: completingRun.run,
          result: safeResult,
          attemptId: parsed.attemptId,
          openedAt: input.completionNow?.() ?? new Date().toISOString()
        })
      : { result: safeResult };
    const outcome = await repo.completeRun({
      runId,
      runnerId: c.req.param("runnerId"),
      attemptId: parsed.attemptId,
      fencingToken: parsed.fencingToken,
      result: needsHuman.result,
      ...(needsHuman.escalation ? { humanEscalation: needsHuman.escalation } : {}),
      ...(safeCompleteFields.idempotencyKey ? { idempotencyKey: safeCompleteFields.idempotencyKey } : {})
    });
    if (outcome === "not_found") return c.json({ error: "run_not_claimed_by_runner" }, 404);
    if (outcome === "stale_attempt") return c.json({ error: "stale_attempt" }, 409);
    if (outcome === "duplicate") {
      const replayedRun = await repo.getRun({ runId });
      const completion = replayedRun?.run.thread?.id
        ? (await completionGovernance.ingestRunResult(runId))?.view ?? await completionGovernance.getWorkLoop(replayedRun.run.thread.id)
        : null;
      return c.json({ ok: true, replayed: true, ...(completion ? { completion } : {}) });
    }
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const completedResult = OpenTagRunResultSchema.parse(stored.run.result);
    const completionResult = await completionGovernance.ingestRunResult(runId);
    cancelPendingDelayedLarkStatusCard(runId);
    const linearApply = await linearApplyOptionsForEvent(stored.event);
    const receiptContext = await actionReceiptContextForFinal({
      event: stored.event,
      result: completedResult,
      ...(input.githubApply ? { githubApply: input.githubApply } : {}),
      ...(input.gitlabApply ? { gitlabApply: input.gitlabApply } : {}),
      ...(linearApply ? { linearApply } : {})
    });
    if (
      completedResult.conclusion === "needs_human" &&
      completedResult.humanEscalationId &&
      shouldDeliverRunStatusUpdate(presentation, { provider: stored.event.callback.provider, state: "waiting_for_human" })
    ) {
      const workThreadId = stored.run.thread?.id;
      const storedEscalations = workThreadId ? await repo.listHumanEscalations({ workThreadId }) : [];
      const escalation = needsHuman.escalation
        ?? storedEscalations.find((item) => item.id === completedResult.humanEscalationId);
      const waitingPresentation = presentation.runStatusPresentation({
        runId,
        state: "waiting_for_human",
        message: escalation?.summary ?? "Waiting for human input.",
        nextAction: escalation
          ? `Resolve ${escalation.id} from this source thread with /resolve ${escalation.id}, or use the local completion escalation command.`
          : `Resolve ${completedResult.humanEscalationId} from the source thread or local CLI.`,
        detailVisibility: "source_thread"
      });
      const waiting = presentation.render({
        provider: stored.event.callback.provider,
        ...larkRenderLocaleRenderOption(stored.event),
        presentation: waitingPresentation
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId,
          kind: "progress",
          provider: stored.event.callback.provider,
          uri: stored.event.callback.uri,
          body: waiting.body,
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
          ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
          ...(waiting.blocks?.length ? { blocks: waiting.blocks } : {}),
          ...(waiting.rich ? { rich: waiting.rich } : {}),
          statusMessageKey: `${runId}:status`
        }
      });
    }
    const strictExecutionWaiting = completedResult.conclusion === "success"
      && completionResult?.view.contract.mode === "governed"
      && completionResult.assessment.state !== "satisfied"
      && completionResult.assessment.state !== "waived";
    const strictExecutionNotComplete = completionResult?.view.contract.mode === "governed"
      && (
        completedResult.conclusion === "failure"
        || completedResult.conclusion === "cancelled"
        || completedResult.conclusion === "interrupted"
        || completedResult.conclusion === "timed_out"
      );
    const finalPresentation = strictExecutionWaiting
      ? presentation.runStatusPresentation({
          runId,
          state: "running",
          message: "Execution succeeded; work completion is waiting for verified repository evidence.",
          nextAction: completionResult.view.nextAction.summary,
          detailVisibility: "source_thread"
        })
      : strictExecutionNotComplete
        ? presentation.runStatusPresentation({
            runId,
            state: completedResult.conclusion === "failure"
              ? "failed"
              : completedResult.conclusion === "cancelled"
                ? "cancelled"
                : completedResult.conclusion === "interrupted"
                  ? "interrupted"
                  : "timed_out",
            message: `Execution ${completedResult.conclusion}; work is not complete.`,
            nextAction: completionResult.view.nextAction.summary,
            detailVisibility: "source_thread"
          })
      : presentation.finalPresentation({
          result: completedResult,
          runId,
          receiptContext
        });
    const finalCallback = presentation.render({
      provider: stored.event.callback.provider,
      ...larkRenderLocaleRenderOption(stored.event),
      presentation: finalPresentation
    });
    const statusMessageKey = lifecycleStatusMessageKey({ provider: stored.event.callback.provider, runId });
    await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId,
        kind: "final",
        provider: stored.event.callback.provider,
        uri: stored.event.callback.uri,
        body: finalCallback.body,
        ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
        ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
        ...(statusMessageKey ? { statusMessageKey } : {}),
        ...(finalCallback.blocks?.length ? { blocks: finalCallback.blocks } : {}),
        ...(finalCallback.rich ? { rich: finalCallback.rich } : {})
      }
    });
    clearDelayedLarkStatusCard(runId);
    const shouldPromoteFollowUp = completedResult.conclusion !== "needs_human" && completedResult.conclusion !== "cancelled";
    const promotedFollowUp = shouldPromoteFollowUp ? await promoteNextFollowUpAfterTerminalRun({ activeRunId: runId }) : null;
    const retryableFailure = ["failure", "interrupted", "timed_out"].includes(completedResult.conclusion);
    const continuation = !promotedFollowUp && retryableFailure && stored.run.thread?.id
      ? await attemptWorkstreamContinuation({
          workThreadId: stored.run.thread.id,
          trigger: {
            id: `run-terminal:${runId}`,
            kind: "retryable_run_failure",
            occurredAt: stored.run.updatedAt
          },
          preferredParentRunId: runId
        })
      : null;
    return c.json({
      ok: true,
      ...(completionResult ? { completion: completionResult.view } : {}),
      ...(continuation ? { continuation } : {}),
      ...(promotedFollowUp
        ? {
            promotedFollowUp: {
              followUpRequest: promotedFollowUp.followUpRequest,
              run: promotedFollowUp.run
            }
          }
        : {})
    });
  });

  app.get("/v1/proposals/:proposalId", async (c) => {
    const proposal = await repo.getSuggestedChanges({ proposalId: c.req.param("proposalId") });
    if (!proposal) return c.json({ error: "proposal_not_found" }, 404);
    return c.json(proposal);
  });

  app.get("/v1/proposals/:proposalId/lineage", async (c) => {
    const lineage = await repo.getProposalLineage({ proposalId: c.req.param("proposalId") });
    if (!lineage) return c.json({ error: "proposal_not_found" }, 404);
    return c.json({ lineage });
  });

  app.get("/v1/proposals/:proposalId/current-intents", async (c) => {
    const intents = await repo.listCurrentMutationIntents({ proposalId: c.req.param("proposalId") });
    if (!intents) return c.json({ error: "proposal_not_found" }, 404);
    return c.json({ intents });
  });

  app.post("/v1/proposals/:proposalId/approvals", async (c) => {
    const proposalId = c.req.param("proposalId");
    const body = await parseDispatcherBody(c, ApprovalDecisionInputSchema, { invalidBodyError: "invalid_approval_decision" });
    const decision = await repo.recordApprovalDecision({
      id: body.id ?? `approval_${proposalId}_${Date.now()}`,
      proposalId,
      approvedIntentIds: body.approvedIntentIds,
      ...(body.rejectedIntentIds?.length ? { rejectedIntentIds: body.rejectedIntentIds } : {}),
      approvedBy: body.approvedBy,
      approvedAt: body.approvedAt ?? new Date().toISOString(),
      scope: body.scope,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {})
    });
    if (!decision) return c.json({ error: "proposal_not_found" }, 404);
    return c.json({ decision }, 201);
  });

  app.get("/v1/approvals/:approvalDecisionId", async (c) => {
    const decision = await repo.getApprovalDecision({ id: c.req.param("approvalDecisionId") });
    if (!decision) return c.json({ error: "approval_decision_not_found" }, 404);
    return c.json({ decision });
  });

  app.post("/v1/proposals/:proposalId/apply-plans", async (c) => {
    const proposalId = c.req.param("proposalId");
    const body = await parseDispatcherBody(c, ApplyPlanInputSchema);
    let executableTarget:
      | {
          adapter: "github";
          proposal: NonNullable<Awaited<ReturnType<typeof repo.getSuggestedChanges>>>;
          target: NonNullable<ReturnType<typeof githubTargetFromEvent>>;
        }
        | {
          adapter: "gitlab";
          proposal: NonNullable<Awaited<ReturnType<typeof repo.getSuggestedChanges>>>;
          target: NonNullable<ReturnType<typeof gitlabTargetFromEvent>>;
        }
        | {
          adapter: "linear";
          proposal: NonNullable<Awaited<ReturnType<typeof repo.getSuggestedChanges>>>;
          target?: NonNullable<ReturnType<typeof linearTargetFromEvent>>;
        }
      | undefined;

    if (body.execute) {
      if (body.adapter !== "github" && body.adapter !== "gitlab" && body.adapter !== "linear") {
        return c.json({ error: "apply_execution_adapter_not_supported" }, 422);
      }
      if (body.adapter === "github" && !input.githubApply) {
        return c.json({ error: "github_apply_not_configured" }, 422);
      }
      if (body.adapter === "gitlab" && !input.gitlabApply) {
        return c.json({ error: "gitlab_apply_not_configured" }, 422);
      }
      const proposal = await repo.getSuggestedChanges({ proposalId });
      if (!proposal) return c.json({ error: "proposal_not_found" }, 404);
      const stored = await repo.getRun({ runId: proposal.runId });
      if (!stored) return c.json({ error: "run_not_found" }, 404);
      if (body.adapter === "github") {
        const target = githubTargetFromEvent(stored.event);
        if (!target) {
          return c.json({ error: "github_target_missing" }, 422);
        }
        executableTarget = { adapter: "github", proposal, target };
      } else if (body.adapter === "gitlab") {
        const target = gitlabTargetFromEvent(stored.event);
        if (!target) {
          return c.json({ error: "gitlab_target_missing" }, 422);
        }
        executableTarget = { adapter: "gitlab", proposal, target };
      } else {
        const target = linearTargetFromEvent(stored.event);
        const selectedIntentIds = body.selectedIntentIds ?? proposal.snapshot.intents.map((intent) => intent.intentId);
        const selectedIntents = proposal.snapshot.intents.filter((intent) => selectedIntentIds.includes(intent.intentId));
        const needsExistingLinearIssue = selectedIntents.some((intent) => !isLinearIssueCreateIntent(intent));
        if (needsExistingLinearIssue && !target) {
          return c.json({ error: "linear_target_missing" }, 422);
        }
        executableTarget = { adapter: "linear", proposal, ...(target ? { target } : {}) };
      }
    }

    const applyPlanInput = {
      id: body.id ?? `apply_${proposalId}_${Date.now()}`,
      proposalId,
      approvalDecisionId: body.approvalDecisionId,
      ...(body.selectedIntentIds !== undefined ? { selectedIntentIds: body.selectedIntentIds } : {}),
      ...(body.adapter ? { adapter: body.adapter } : {})
    };
    let plan: ApplyPlan;
    if (body.execute) {
      const planResult = await repo.createApplyPlanOnce(applyPlanInput);
      if (!planResult) return c.json({ error: "proposal_or_approval_not_found" }, 404);
      plan = planResult.plan;
      if (!planResult.created) {
        return c.json({ plan, alreadyPlanned: true }, 200);
      }
    } else {
      const planResult = await repo.createApplyPlan(applyPlanInput);
      if (!planResult) return c.json({ error: "proposal_or_approval_not_found" }, 404);
      plan = planResult;
    }
    if (body.execute && executableTarget) {
      const preflightOutcomeByIntentId = new Map((plan.outcomes ?? []).map((outcome) => [outcome.intentId, outcome]));
      const executableIntents = executableTarget.proposal.snapshot.intents.filter((intent) => {
        const outcome = preflightOutcomeByIntentId.get(intent.intentId);
        return outcome?.outcome === "skipped" && outcome.message?.startsWith("Preflight passed");
      });
      const executedOutcomes: ApplyIntentOutcome[] = [];
      if (executableTarget.adapter === "github") {
        const githubApply = input.githubApply;
        if (!githubApply) {
          return c.json({ error: "github_apply_not_configured" }, 422);
        }
        const target = {
          token: githubApply.token,
          owner: executableTarget.target.owner,
          repo: executableTarget.target.repoName,
          ...(typeof executableTarget.target.issueNumber === "number" ? { issueNumber: executableTarget.target.issueNumber } : {}),
          ...(executableTarget.target.pullRequestNumber ? { pullRequestNumber: executableTarget.target.pullRequestNumber } : {})
        };
        const compilerRegistry = createAdapterMutationCompilerRegistry([
          createGitHubIssueMutationCompiler({
            mappings: mappingsFromAdapterPlan(plan.adapterPlan),
            ...(executableTarget.target.targetKind ? { targetKind: executableTarget.target.targetKind } : {})
          })
        ]);
        for (const compilation of compilerRegistry.compile("github", executableIntents)) {
          if (!compilation.ok) {
            executedOutcomes.push(compilation.outcome);
            continue;
          }
          executedOutcomes.push(
            await applyGitHubIssueMutationOperation({
              target,
              operation: compilation.operation as GitHubIssueMutationOperation,
              ...(githubApply.fetchImpl ? { fetchImpl: githubApply.fetchImpl } : {})
            })
          );
        }
      } else if (executableTarget.adapter === "gitlab") {
        const gitlabApply = input.gitlabApply;
        if (!gitlabApply) {
          return c.json({ error: "gitlab_apply_not_configured" }, 422);
        }
        const compilerRegistry = createAdapterMutationCompilerRegistry([createGitLabMutationCompiler()]);
        for (const compilation of compilerRegistry.compile("gitlab", executableIntents)) {
          if (!compilation.ok) {
            executedOutcomes.push(compilation.outcome);
            continue;
          }
          executedOutcomes.push(
            await applyGitLabMutationOperation({
              target: {
                token: gitlabApply.token,
                projectPathWithNamespace: executableTarget.target.projectPathWithNamespace,
                ...(gitlabApply.baseUrl ? { baseUrl: gitlabApply.baseUrl } : {})
              },
              operation: compilation.operation as GitLabMutationOperation,
              ...(gitlabApply.fetchImpl ? { fetchImpl: gitlabApply.fetchImpl } : {})
            })
          );
        }
      } else {
        const sourceRun = await repo.getRun({ runId: executableTarget.proposal.runId });
        const linearApply = sourceRun ? await linearApplyOptionsForEvent(sourceRun.event) : input.linearApply;
        if (!linearApply) {
          return c.json({ error: "linear_apply_not_configured" }, 422);
        }
        const linearToken = await resolveLinearApplyToken(linearApply);
        if (!linearToken) {
          return c.json({ error: "linear_apply_token_unavailable" }, 422);
        }
        const compilerRegistry = createAdapterMutationCompilerRegistry([
          createLinearMutationCompiler({
            mappings: mappingsForAdapterPlan(plan.adapterPlan, linearApply.mappings)
          })
        ]);
        for (const compilation of compilerRegistry.compile("linear", executableIntents)) {
          if (!compilation.ok) {
            executedOutcomes.push(compilation.outcome);
            continue;
          }
          const operation = compilation.operation as LinearMutationOperation;
          if (operation.kind !== "create_issue" && !executableTarget.target) {
            executedOutcomes.push({
              intentId: compilation.intentId,
              outcome: "failed",
              message: "The source run does not include a Linear issue target."
            });
            continue;
          }
          const linearGraphqlUrl = linearApply.graphqlUrl ?? executableTarget.target?.graphqlUrl;
          executedOutcomes.push(
            await applyLinearMutationOperation({
              target: {
                token: linearToken,
                ...(executableTarget.target?.issueId ? { issueId: executableTarget.target.issueId } : {}),
                ...(linearGraphqlUrl ? { graphqlUrl: linearGraphqlUrl } : {})
              },
              operation,
              ...(linearApply.fetchImpl ? { fetchImpl: linearApply.fetchImpl } : {})
            })
          );
        }
      }
      const executedOutcomeByIntentId = new Map(executedOutcomes.map((outcome) => {
        const sanitized = sanitizeApplyOutcomeForStorage(outcome);
        return [sanitized.intentId, sanitized];
      }));
      const mergedOutcomes = (plan.outcomes ?? []).map((outcome) => executedOutcomeByIntentId.get(outcome.intentId) ?? outcome);
      const executedPlan = await repo.updateApplyPlanOutcomes({
        id: plan.id,
        outcomes: mergedOutcomes,
        externalWritesExecuted: true
      });
      return c.json({ plan: executedPlan ?? plan }, 201);
    }
    return c.json({ plan }, 201);
  });

  app.get("/v1/apply-plans/:applyPlanId", async (c) => {
    const plan = await repo.getApplyPlan({ id: c.req.param("applyPlanId") });
    if (!plan) return c.json({ error: "apply_plan_not_found" }, 404);
    return c.json({ plan });
  });

  app.post("/v1/runs/:runId/child-runs", async (c) => {
    const parentRunId = c.req.param("runId");
    const body = await parseDispatcherBody(c, ChildRunInputSchema);
    const parent = await repo.getRun({ runId: parentRunId });
    if (!parent) return c.json({ error: "parent_run_not_found" }, 404);
    const receivedAt = new Date().toISOString();
    const sourceProposalId = body.sourceProposalId ?? body.action.targetId;
    let run: OpenTagRun;
    try {
      ({ run } = await repo.createRun({
        id: body.runId,
        event: childEventFromParent({
          parentEvent: parent.event,
          childRunId: body.runId,
          ...(body.commandText ? { commandText: body.commandText } : {}),
          actionKind: body.action.kind,
          receivedAt
        }),
        parentRunId,
        triggeredByAction: body.action,
        rejectIfAutomaticContinuationActive: true,
        ...(sourceProposalId ? { sourceProposalId } : {}),
        ...(body.sourceApplyPlanId ? { sourceApplyPlanId: body.sourceApplyPlanId } : {})
      }));
    } catch (error) {
      if (!(error instanceof ActiveConversationRaceError)) throw error;
      return c.json({
        error: "active_conversation_race",
        activeRunId: error.activeRunId,
        reason: "An automatic Workstream continuation already owns this source conversation."
      }, 409);
    }
    return c.json({ run }, 201);
  });

  app.get("/v1/runs/:runId", async (c) => {
    const stored = await repo.getRun({ runId: c.req.param("runId") });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    return c.json(stored);
  });

  app.get("/v1/work-threads/:workThreadId/completion", async (c) => {
    const workThreadId = c.req.param("workThreadId");
    const workThread = await repo.getWorkThread({ workThreadId });
    if (!workThread) return c.json({ error: "work_thread_not_found" }, 404);
    const completion = await completionGovernance.explainWorkThread(workThreadId);
    if (!completion) return c.json({ error: "completion_not_available" }, 404);
    return c.json({ workThread, completion });
  });

  app.get("/v1/work-loops", async (c) => {
    const attention = c.req.query("attention");
    if (attention !== "required") {
      return c.json({ error: "invalid_attention_filter", message: "Use attention=required." }, 400);
    }
    const requestedLimit = Number(c.req.query("limit") ?? "25");
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      return c.json({ error: "invalid_limit", message: "limit must be an integer from 1 to 100." }, 400);
    }
    const scanLimit = Math.min(500, Math.max(100, requestedLimit * 5));
    const threads = await repo.listWorkThreads({ limit: scanLimit });
    const workLoops: Array<{ workThread: DurableWorkThread; completion: WorkLoopView }> = [];
    for (const workThread of threads) {
      if (workLoops.length >= requestedLimit) break;
      const [completion, runs] = await Promise.all([
        completionGovernance.readWorkLoop(workThread.id),
        repo.listRunsForWorkThread({ workThreadId: workThread.id })
      ]);
      if (!completion) continue;
      const latestRun = runs.at(-1)?.run;
      if (latestRun && (latestRun.status === "queued" || latestRun.status === "assigned" || latestRun.status === "running")) {
        continue;
      }
      if (
        completion.completion === "satisfied"
        || completion.completion === "waived"
        || completion.nextAction.hint.kind === "none"
      ) {
        continue;
      }
      workLoops.push({ workThread, completion });
    }
    return c.json({ attention: "required", workLoops, scanned: threads.length, scanLimitReached: threads.length === scanLimit });
  });

  app.get("/v1/runs/:runId/completion", async (c) => {
    const stored = await repo.getRun({ runId: c.req.param("runId") });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const completion = await completionGovernance.explainRun(stored.run.id);
    if (!completion) return c.json({ error: "completion_not_available" }, 404);
    if (stored.run.thread?.id) await deliverCompletionTransition(stored.run.thread.id);
    return c.json({ completion });
  });

  app.get("/v1/runs/:runId/human-escalations", async (c) => {
    const runId = c.req.param("runId");
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const workThreadId = stored.run.thread?.id;
    if (!workThreadId) {
      return c.json({
        escalations: [],
        resolutionUnavailableReason: stored.run.result?.humanResolutionUnavailableReason
          ?? "This run has no durable WorkThread for an attributable human resolution."
      });
    }
    const expired = await repo.expireHumanEscalations({
      workThreadId,
      runId,
      at: input.completionNow?.() ?? new Date().toISOString()
    });
    if (expired.expired > 0) await completionGovernance.reassessRun(runId);
    const escalations = (await repo.listHumanEscalations({ workThreadId }))
      .filter((escalation) => escalation.runId === runId);
    return c.json({ escalations });
  });

  app.post("/v1/human-escalations/:escalationId/acknowledge", async (c) => {
    const escalationId = c.req.param("escalationId");
    const parsed = HumanEscalationAcknowledgeInputSchema.parse(sanitizeCredentialLikeValue(
      await parseDispatcherBody(c, HumanEscalationAcknowledgeInputSchema)
    ));
    const existingEscalation = await repo.getHumanEscalation({ id: escalationId });
    if (!existingEscalation) {
      return c.json({ error: "human_escalation_not_found" }, 404);
    }
    const channelPrincipal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
    const authorization = await authorizeManagedHumanEscalationChange(
      existingEscalation,
      channelPrincipal
    );
    if (!authorization.allowed) {
      return c.json({ error: authorization.reasonCode ?? "managed_channel_principal_required" }, 403);
    }
    try {
      const result = await repo.transitionHumanEscalation({
        id: escalationId,
        toState: "acknowledged",
        actor: parsed.actor,
        ...(channelPrincipal ? { channelPrincipal } : {}),
        at: parsed.acknowledgedAt ?? input.completionNow?.() ?? new Date().toISOString()
      });
      if (result.escalation.state === "expired") {
        return c.json({
          error: "human_escalation_expired",
          message: "The human escalation expired without implicit approval.",
          escalation: result.escalation
        }, 409);
      }
      return c.json({ outcome: result.changed ? "acknowledged" : "duplicate", escalation: result.escalation }, result.changed ? 201 : 200);
    } catch (error) {
      if (error instanceof ManagedChannelAuthorityError) {
        return c.json({ error: error.reasonCode }, 403);
      }
      if (error instanceof ChannelBindingCorruptionError) {
        return c.json({ error: "managed_channel_binding_corrupt" }, 403);
      }
      const message = error instanceof Error ? error.message : "Invalid human escalation acknowledgement.";
      return c.json({ error: "invalid_human_escalation_transition", message }, 409);
    }
  });

  app.post("/v1/human-escalations/:escalationId/resolve", async (c) => {
    const escalationId = c.req.param("escalationId");
    const parsed = HumanEscalationResolveInputSchema.parse(sanitizeCredentialLikeValue(
      await parseDispatcherBody(c, HumanEscalationResolveInputSchema)
    ));
    const existingEscalation = await repo.getHumanEscalation({ id: escalationId });
    if (!existingEscalation) {
      return c.json({ error: "human_escalation_not_found" }, 404);
    }
    const channelPrincipal = channelPrincipalFromRequest(c.req.raw, channelPrincipals);
    const authorization = await authorizeManagedHumanEscalationChange(
      existingEscalation,
      channelPrincipal
    );
    if (!authorization.allowed) {
      return c.json({ error: authorization.reasonCode ?? "managed_channel_principal_required" }, 403);
    }
    try {
      const result = await repo.transitionHumanEscalation({
        id: escalationId,
        toState: "resolved",
        actor: parsed.actor,
        ...(channelPrincipal ? { channelPrincipal } : {}),
        ...(parsed.optionId ? { optionId: parsed.optionId } : {}),
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        at: parsed.resolvedAt ?? input.completionNow?.() ?? new Date().toISOString()
      });
      if (result.escalation.state === "expired") {
        return c.json({
          error: "human_escalation_expired",
          message: "The human escalation expired without implicit approval.",
          escalation: result.escalation
        }, 409);
      }
      let completion = null;
      if (result.escalation.runId) {
        await completionGovernance.reassessRun(result.escalation.runId);
        await deliverCompletionTransition(result.escalation.workThreadId);
        completion = await completionGovernance.explainRun(result.escalation.runId);
      }
      const resolutionContext = humanResolutionContinuationContext(result.escalation);
      const continuation = result.changed
        ? await attemptWorkstreamContinuation({
            workThreadId: result.escalation.workThreadId,
            trigger: {
              id: `human-escalation:${result.escalation.id}`,
              kind: "human_escalation_resolved",
              occurredAt: result.escalation.resolution?.resolvedAt ?? new Date().toISOString()
            },
            continuationActor: parsed.actor,
            ...(channelPrincipal ? { continuationPrincipal: channelPrincipal } : {}),
            ...(resolutionContext ? { continuationContext: resolutionContext } : {}),
            ...(result.escalation.runId ? { preferredParentRunId: result.escalation.runId } : {})
          })
        : null;
      const resume = continuation
        ? continuationResumePresentation({
            outcome: continuation.outcome,
            ...(continuation.reasonCode ? { reasonCode: continuation.reasonCode } : {}),
            ...(continuation.activeRunId ? { activeRunId: continuation.activeRunId } : {}),
            ...(continuation.notBefore ? { notBefore: continuation.notBefore } : {}),
            ...(continuation.run ? { resumedRunId: continuation.run.id } : {}),
            ...(continuation.escalation ? { humanEscalationId: continuation.escalation.id } : {})
          })
        : {
            required: false,
            reason: "The human escalation resolution was already recorded; no continuation was evaluated.",
            nextAction: "Follow the existing WorkThread state."
          };
      return c.json({
        outcome: result.changed ? "resolved" : "duplicate",
        escalation: result.escalation,
        ...(completion ? { completion } : {}),
        ...(continuation ? { continuation } : {}),
        resume
      }, result.changed ? 201 : 200);
    } catch (error) {
      if (error instanceof ManagedChannelAuthorityError) {
        return c.json({ error: error.reasonCode }, 403);
      }
      if (error instanceof ChannelBindingCorruptionError) {
        return c.json({ error: "managed_channel_binding_corrupt" }, 403);
      }
      const message = error instanceof Error ? error.message : "Invalid human escalation resolution.";
      return c.json({ error: "invalid_human_escalation_transition", message }, 409);
    }
  });

  app.post("/v1/runs/:runId/completion/waivers", async (c) => {
    const runId = c.req.param("runId");
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const input = CompletionWaiverInputSchema.parse(sanitizeCredentialLikeValue(
      await parseDispatcherBody(c, CompletionWaiverInputSchema)
    ));
    try {
      const result = await completionGovernance.applyWaiverForRun(runId, input);
      if (!result) return c.json({ error: "completion_not_available" }, 404);
      await deliverCompletionTransition(result.assessment.workThreadId);
      const completion = await completionGovernance.explainRun(runId);
      if (!completion || !result.assessment.waiver) return c.json({ error: "completion_not_available" }, 404);
      return c.json({ outcome: result.outcome, completion, waiver: result.assessment.waiver }, result.outcome === "recorded" ? 201 : 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid completion waiver.";
      return c.json({ error: "invalid_completion_waiver", message }, 400);
    }
  });

  app.post("/v1/runs/:runId/cancel", async (c) => {
    const parsed = await parseDispatcherBody(c, CancelRunSchema);
    const outcome = await repo.cancelRun({
      runId: c.req.param("runId"),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(parsed.requestedBy ? { requestedBy: parsed.requestedBy } : {})
    });
    if (outcome.outcome === "not_found") return c.json({ error: "run_not_found" }, 404);
    if (outcome.outcome === "already_terminal") {
      return c.json({ error: "run_already_terminal", run: outcome.run }, 409);
    }
    return c.json({ outcome: "cancelled", run: outcome.run });
  });

  app.get("/v1/runs/:runId/metrics", async (c) => {
    const runId = c.req.param("runId");
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const metrics = await repo.getRunMetrics({ runId });
    return c.json({ metrics });
  });

  app.get("/v1/runs/:runId/events", async (c) => {
    const events = await repo.listRunEvents({ runId: c.req.param("runId") });
    return c.json({ events });
  });

  app.get("/v1/runs/:runId/ledger", async (c) => {
    const ledger = await repo.getRunLedger({ runId: c.req.param("runId") });
    if (!ledger) return c.json({ error: "run_not_found" }, 404);
    return c.json({ ledger });
  });

  app.onError((err, c) => {
    // Preserve explicit HTTP errors raised by handlers/middleware. Request-body
    // parse failures are surfaced as tagged HTTPException(4xx) by parseBody(),
    // so they are returned to the client here. Crucially, we no longer map raw
    // ZodError/SyntaxError to 400 globally: an internal ZodError (e.g. a store
    // repository validating a DB row) or a SyntaxError from an internal
    // JSON.parse must remain a 500 so monitoring still alerts on it.
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    // Unknown errors (including internal ZodError/SyntaxError) remain 500 so
    // monitoring still alerts on genuine server faults.
    console.error("dispatcher unhandled error", err);
    return c.json({ error: "internal_server_error" }, 500);
  });

  return app;
}
