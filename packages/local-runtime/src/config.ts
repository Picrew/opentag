import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  canonicalJsonStringify,
  FreshRunnerCredentialRotationResponseV1Schema,
  OpenTagManagedChannelBindingOwnershipSchema,
  ReceiptDigestSchema,
  RunnerCredentialCurrentStateResponseV1Schema,
  RunnerCredentialRevocationResponseV1Schema,
  RunnerCredentialRevocationRequestV1Schema,
  RunnerCredentialMetadataV1Schema,
  RunnerCredentialRotationMetadataV1Schema,
  RunnerCredentialRotationRequestV1Schema,
  ReplayedRunnerCredentialRotationResponseV1Schema,
  type RunnerCredentialCurrentStateResponseV1,
  type RunnerCredentialRevocationRequestV1,
  type RunnerCredentialRotationRequestV1,
} from "@opentag/core";
import { z } from "zod";

const BUILT_IN_EXECUTOR_IDS = ["echo", "codex", "claude-code", "cursor", "opencode", "hermes", "openclaw"] as const;

// Accept any trimmed non-empty executor id. Custom executors registered by a
// standalone runner are valid, but daemon ACP agents cannot replace built-ins.
const ExecutorSchema = z.string().trim().min(1);
const KeepWorktreeSchema = z.enum(["always", "on_failure", "never"]);
const PositiveIntegerSchema = z.number().int().positive();

export const HostedControlRegistrationMetadataSchema = RunnerCredentialMetadataV1Schema.omit({
  operationId: true,
});

export type HostedControlRegistrationMetadata = z.infer<typeof HostedControlRegistrationMetadataSchema>;

const HostedControlInitialRegistrationSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.literal("unpaired"),
    flow: z.literal("registration"),
    operationId: z.string().trim().min(1),
    reason: z.enum(["pending", "outcome_unknown"])
  })
  .strict();

const HostedControlReprovisionRegistrationSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.literal("unpaired"),
    flow: z.literal("reprovision"),
    operationId: z.string().trim().min(1),
    reason: z.enum(["pending", "outcome_unknown"]),
    recoveryCredentialId: z.string().trim().min(1),
    registration: HostedControlRegistrationMetadataSchema
  })
  .strict();

const HostedControlRecoveryRequiredRegistrationSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.literal("unpaired"),
    reason: z.literal("recovery_required"),
    registration: HostedControlRegistrationMetadataSchema
  })
  .strict();

const HostedControlStagedRegistrationSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.literal("credential_staged"),
    operationId: z.string().trim().min(1),
    registration: HostedControlRegistrationMetadataSchema
  })
  .strict();

const HostedControlPairedRegistrationSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.literal("paired"),
    operationId: z.string().trim().min(1),
    registration: HostedControlRegistrationMetadataSchema
  })
  .strict();

export type HostedCredentialMutationRequest =
  | RunnerCredentialRotationRequestV1
  | RunnerCredentialRevocationRequestV1;
type ReplayedRunnerCredentialRotationResponseV1 = z.infer<
  typeof ReplayedRunnerCredentialRotationResponseV1Schema
>;

const HostedControlRotationPendingSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.enum(["rotation_pending", "rotation_outcome_unknown"]),
    endpoint: z.literal("rotate"),
    origin: z.literal("paired"),
    canonicalRequestDigest: ReceiptDigestSchema,
    request: RunnerCredentialRotationRequestV1Schema,
    registration: HostedControlRegistrationMetadataSchema
  })
  .strict();

const HostedCredentialConflictEvidenceSchema = z
  .object({
    originalRequest: RunnerCredentialRotationRequestV1Schema,
    originalCanonicalRequestDigest: ReceiptDigestSchema,
    replay: ReplayedRunnerCredentialRotationResponseV1Schema,
    current: RunnerCredentialCurrentStateResponseV1Schema,
    successorAttempted: z.boolean(),
    provenance: z
      .object({
        origin: z.literal("lost_201_replay"),
        source: z.enum([
          "verified_metadata_replay_and_current_state",
          "metadata_replay_mismatch",
          "current_state_unsafe"
        ])
      })
      .strict()
  })
  .strict();

const HostedControlRotationSuccessorPendingSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.enum(["rotation_pending", "rotation_outcome_unknown"]),
    endpoint: z.literal("rotate"),
    origin: z.literal("lost_201_successor"),
    canonicalRequestDigest: ReceiptDigestSchema,
    request: RunnerCredentialRotationRequestV1Schema,
    registration: HostedControlRegistrationMetadataSchema,
    predecessorConflict: HostedCredentialConflictEvidenceSchema.extend({
      successorAttempted: z.literal(true)
    })
  })
  .strict();

const HostedControlRotationStagedFromPairedSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.literal("rotation_staged"),
    endpoint: z.literal("rotate"),
    origin: z.literal("paired"),
    canonicalRequestDigest: ReceiptDigestSchema,
    request: RunnerCredentialRotationRequestV1Schema,
    rotation: RunnerCredentialRotationMetadataV1Schema
  })
  .strict();

const HostedControlRotationStagedFromSuccessorSchema = HostedControlRotationStagedFromPairedSchema
  .omit({ origin: true })
  .extend({
    origin: z.literal("lost_201_successor"),
    predecessorConflict: HostedCredentialConflictEvidenceSchema.extend({
      successorAttempted: z.literal(true)
    })
  })
  .strict();

const HostedControlRevocationPendingSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.enum(["revocation_pending", "revocation_outcome_unknown"]),
    endpoint: z.literal("revoke"),
    canonicalRequestDigest: ReceiptDigestSchema,
    request: RunnerCredentialRevocationRequestV1Schema,
    registration: HostedControlRegistrationMetadataSchema
  })
  .strict();

const HostedControlRevokedSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.literal("revoked"),
    endpoint: z.literal("revoke"),
    canonicalRequestDigest: ReceiptDigestSchema,
    request: RunnerCredentialRevocationRequestV1Schema,
    registration: HostedControlRegistrationMetadataSchema,
    revocation: RunnerCredentialRevocationResponseV1Schema
  })
  .strict();

const HostedControlCredentialConflictSchema = z
  .object({
    kind: z.literal("hosted_control_v1"),
    state: z.literal("credential_conflict"),
    endpoint: z.literal("rotate"),
    canonicalRequestDigest: ReceiptDigestSchema,
    request: RunnerCredentialRotationRequestV1Schema,
    replay: ReplayedRunnerCredentialRotationResponseV1Schema,
    current: RunnerCredentialCurrentStateResponseV1Schema,
    successorAttempted: z.literal(false),
    provenance: z
      .object({
        origin: z.literal("lost_201_replay"),
        source: z.literal("verified_metadata_replay_and_current_state")
      })
      .strict()
  })
  .strict();

const HostedControlLifecycleRecoveryBaseShape = {
  kind: z.literal("hosted_control_v1"),
  state: z.literal("unpaired"),
  reason: z.literal("recovery_required"),
  registration: HostedControlRegistrationMetadataSchema
};

const HostedCredentialReconciliationFailureEvidenceSchema = z
  .object({
    kind: z.literal("reconciliation_failure"),
    originalRequest: RunnerCredentialRotationRequestV1Schema,
    originalCanonicalRequestDigest: ReceiptDigestSchema,
    failure: z
      .object({
        reason: z.enum(["membership_verification_failed", "current_state_read_failed"]),
        code: z.enum([
          "membership_unavailable",
          "membership_forbidden",
          "current_state_unavailable",
          "current_state_forbidden",
          "invalid_response"
        ])
      })
      .strict(),
    provenance: z
      .object({
        origin: z.literal("lost_201_reconciliation"),
        source: z.literal("redacted_local_failure")
      })
      .strict()
  })
  .strict();

const HostedControlEvidenceRecoveryRequiredSchema = z
  .object({
    ...HostedControlLifecycleRecoveryBaseShape,
    recoveryReason: z.enum(["replay_mismatch", "current_state_unsafe"]),
    evidence: HostedCredentialConflictEvidenceSchema
  })
  .strict();

const HostedControlFailureRecoveryRequiredSchema = z
  .object({
    ...HostedControlLifecycleRecoveryBaseShape,
    recoveryReason: z.enum(["membership_verification_failed", "current_state_read_failed"]),
    evidence: HostedCredentialReconciliationFailureEvidenceSchema
  })
  .strict();

const HostedControlSuccessorRecoveryRequiredSchema = z
  .object({
    ...HostedControlLifecycleRecoveryBaseShape,
    recoveryReason: z.enum(["successor_replay_without_token", "successor_replay_mismatch"]),
    evidence: HostedCredentialConflictEvidenceSchema.extend({
      successorAttempted: z.literal(true)
    }),
    successorRequest: RunnerCredentialRotationRequestV1Schema,
    successorCanonicalRequestDigest: ReceiptDigestSchema,
    successorReplay: ReplayedRunnerCredentialRotationResponseV1Schema
  })
  .strict();

const HostedControlLifecycleRecoveryRequiredSchema = z.union([
  HostedControlEvidenceRecoveryRequiredSchema,
  HostedControlFailureRecoveryRequiredSchema,
  HostedControlSuccessorRecoveryRequiredSchema
]);

export const HostedControlRegistrationSchema = z.union([
  HostedControlInitialRegistrationSchema,
  HostedControlReprovisionRegistrationSchema,
  HostedControlRecoveryRequiredRegistrationSchema,
  HostedControlLifecycleRecoveryRequiredSchema,
  HostedControlCredentialConflictSchema,
  HostedControlStagedRegistrationSchema,
  HostedControlPairedRegistrationSchema,
  HostedControlRotationPendingSchema,
  HostedControlRotationSuccessorPendingSchema,
  HostedControlRotationStagedFromPairedSchema,
  HostedControlRotationStagedFromSuccessorSchema,
  HostedControlRevocationPendingSchema,
  HostedControlRevokedSchema
]);

export type HostedControlRegistration = z.infer<typeof HostedControlRegistrationSchema>;

export function hostedCredentialMutationRequestDigest(requestValue: HostedCredentialMutationRequest): string {
  const request = RunnerCredentialRotationRequestV1Schema.parse(requestValue);
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(request)).digest("hex")}`;
}

function verifiedHostedCredentialMutationDigest(
  request: HostedCredentialMutationRequest,
  suppliedDigest?: string
): string {
  const computedDigest = hostedCredentialMutationRequestDigest(request);
  if (suppliedDigest !== undefined && ReceiptDigestSchema.parse(suppliedDigest) !== computedDigest) {
    throw new Error("Hosted credential mutation digest does not match the canonical strict request.");
  }
  return computedDigest;
}

function rotationReplayMatchesRequest(
  replay: ReplayedRunnerCredentialRotationResponseV1,
  request: RunnerCredentialRotationRequestV1
): boolean {
  return replay.operationId === request.operationId
    && replay.runnerId === request.runnerId
    && replay.registrationGeneration === request.expectedRegistrationGeneration
    && replay.credentialGeneration === request.expectedCredentialGeneration + 1
    && replay.replacedCredentialId === request.expectedCredentialId;
}

function currentStateMatchesRotationReplay(
  current: RunnerCredentialCurrentStateResponseV1,
  replay: ReplayedRunnerCredentialRotationResponseV1
): boolean {
  return current.projectionStatus === "ready"
    && current.credentialState === "active"
    && current.runnerId === replay.runnerId
    && current.registrationGeneration === replay.registrationGeneration
    && current.credentialGeneration === replay.credentialGeneration
    && current.activeCredentialId === replay.credentialId;
}

function defaultLocalStateDirectory(): string {
  if (process.env.OPENTAG_STATE_DIR) return resolve(process.env.OPENTAG_STATE_DIR);
  if (process.env.XDG_STATE_HOME) return resolve(process.env.XDG_STATE_HOME, "opentag");
  return join(homedir(), ".local", "state", "opentag");
}

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, "Path must be absolute.");

const SecretRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("env"),
      name: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      path: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("keychain"),
      service: z.string().trim().min(1),
      account: z.string().trim().min(1)
    })
    .strict()
]);

export type SecretRef = z.infer<typeof SecretRefSchema>;
export type KeychainSecretRef = Extract<SecretRef, { kind: "keychain" }>;

type ExecFileSyncLike = (file: string, args: readonly string[], options: { encoding: "utf8" }) => string | Buffer;

function requireResolvedSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Secret ${label} resolved to an empty value.`);
  }
  return trimmed;
}

export function readKeychainSecret(ref: KeychainSecretRef, execFileSyncImpl: ExecFileSyncLike = execFileSync): string {
  let value: string | Buffer;
  try {
    value = execFileSyncImpl(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", ref.service, "-a", ref.account],
      { encoding: "utf8" }
    );
  } catch {
    throw new Error(`Secret keychain ref ${ref.service}/${ref.account} could not be resolved.`);
  }
  return requireResolvedSecret(String(value), `keychain ref ${ref.service}/${ref.account}`);
}

function resolveSecretRef(ref: SecretRef): string {
  if (ref.kind === "env") {
    const value = process.env[ref.name];
    if (!value) {
      throw new Error(`Secret env ref ${ref.name} is not set.`);
    }
    return requireResolvedSecret(value, `env ref ${ref.name}`);
  }
  if (ref.kind === "file") {
    let value: string;
    try {
      value = readFileSync(ref.path, "utf8");
    } catch {
      throw new Error(`Secret file ref ${ref.path} could not be resolved.`);
    }
    return requireResolvedSecret(value, `file ref ${ref.path}`);
  }
  return readKeychainSecret(ref);
}

const SecretStringSchema = z.union([z.string().min(1), SecretRefSchema]).transform((value) => {
  return typeof value === "string" ? value : resolveSecretRef(value);
});

const HermesAcpConfigSchema = z.object({
  command: z.string().trim().min(1).optional(),
  profile: z.string().trim().min(1).optional(),
  profileTemplate: z.string().trim().min(1).optional()
});

const OpenClawAcpConfigSchema = z.object({
  command: z.string().trim().min(1).optional(),
  profile: z.string().trim().min(1).optional(),
  gatewayUrl: z.string().url().optional(),
  expectedVersion: z.string().trim().min(1).optional()
});

const AgentSessionProfileConfigSchema = z.object({
  profile: z.string().trim().min(1).optional(),
  profileTemplate: z.string().trim().min(1).optional()
});

const RunnerSecurityPolicySchema = z.object({
  mode: z.enum(["enforce", "audit", "off"]).optional(),
  allowedWorkspaceRoot: z.string().min(1).optional(),
  allowUnsafePrompts: z.boolean().optional(),
  extraSafeEnv: z.array(z.string().min(1)).optional()
});

export const AcpAgentConfigSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().trim().min(1).optional(),
    workspaceCwd: z.literal("required"),
    sessionModeId: z.string().trim().min(1).optional(),
    supportsProfile: z.boolean().default(false),
    supportsCancel: z.boolean().default(false),
    readinessTimeoutMs: PositiveIntegerSchema.optional()
  })
  .strict();

export const RepositoryBindingConfigSchema = z.object({
  provider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1),
  checkoutPath: z.string().min(1),
  defaultExecutor: ExecutorSchema.default("echo"),
  baseBranch: z.string().min(1).default("main"),
  pushRemote: z.string().min(1).default("origin"),
  worktreeRoot: z.string().min(1).optional(),
  keepWorktree: KeepWorktreeSchema.default("on_failure")
});

export const SlackChannelBindingConfigSchema = z.object({
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1)
});

export const ChannelBindingConfigSchema = z
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

export const LarkChannelBindingConfigSchema = z.object({
  tenantKey: z.string().min(1),
  chatId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1)
});

export const OpenTagDaemonConfigSchema = z
  .object({
    runnerId: z.string().min(1).default("runner_local"),
    dispatcherUrl: z.string().url().default("http://localhost:3030"),
    repositories: z.array(RepositoryBindingConfigSchema).default([]),
    agents: z.record(z.string(), AcpAgentConfigSchema).default({}),
    scratchRoot: AbsolutePathSchema.default(() => join(defaultLocalStateDirectory(), "scratch")),
    keepScratch: KeepWorktreeSchema.default("on_failure"),
    approvalMode: z.enum(["ask", "auto", "autonomous"]).default("auto"),
    channelBindings: z.array(ChannelBindingConfigSchema).optional(),
    slackChannels: z.array(SlackChannelBindingConfigSchema).optional(),
    larkChannels: z.array(LarkChannelBindingConfigSchema).optional(),
    // Reject removed direct-adapter config instead of silently stripping it from the non-strict daemon schema.
    claudeCode: z.never().optional(),
    hermes: HermesAcpConfigSchema.optional(),
    openclaw: OpenClawAcpConfigSchema.optional(),
    agentSessionProfile: AgentSessionProfileConfigSchema.optional(),
    security: RunnerSecurityPolicySchema.optional(),
    githubToken: SecretStringSchema.optional(),
    githubApplyToken: SecretStringSchema.nullable().optional(),
    preparePullRequestBranch: z.boolean().optional(),
    allowAutoCreatePullRequest: z.boolean().optional(),
    runnerToken: SecretStringSchema.optional(),
    runnerTokens: z.array(SecretStringSchema).optional(),
    revokedRunnerTokenFingerprints: z.array(z.string().trim().min(1)).optional(),
    pairingToken: SecretStringSchema.optional(),
    controlRegistration: HostedControlRegistrationSchema.optional(),
    pollIntervalMs: PositiveIntegerSchema.default(5000),
    heartbeatIntervalMs: PositiveIntegerSchema.default(15000),
    runTimeoutMs: PositiveIntegerSchema.optional()
  })
  .superRefine((config, ctx) => {
    for (const name of Object.keys(config.agents)) {
      if (BUILT_IN_EXECUTOR_IDS.some((executorId) => executorId === name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", name],
          message: `Configured ACP agent '${name}' cannot replace the built-in executor with the same id.`
        });
      }
    }

    const control = config.controlRegistration;
    if (!control) return;

    if (config.runnerTokens?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runnerTokens"],
        message: "Hosted Control V1 configuration must not retain fallback runner tokens."
      });
    }
    const tokenAllowed = control.state === "credential_staged"
      || control.state === "paired"
      || control.state === "rotation_staged";
    if (config.pairingToken && !(control.state === "unpaired" && "flow" in control && control.flow === "registration")) {
      const pairingMessage = control.state === "unpaired" && control.reason === "recovery_required"
        ? "Hosted Control V1 recovery-required configuration must not retain the consumed pairing token."
        : `Hosted Control V1 ${control.state} configuration must not retain a pairing token.`;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pairingToken"],
        message: pairingMessage
      });
    }
    if (tokenAllowed && !config.runnerToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runnerToken"],
        message: `Hosted Control V1 ${control.state} configuration requires a staged runtime runner token.`
      });
    }
    if (!tokenAllowed && config.runnerToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runnerToken"],
        message: `Hosted Control V1 ${control.state} configuration must not contain a runtime runner token.`
      });
    }
    if ("registration" in control && control.registration.runnerId !== config.runnerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "registration", "runnerId"],
        message: "Hosted Control V1 registration runnerId must match daemon runnerId."
      });
    }
    if ("request" in control && control.request.runnerId !== config.runnerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "request", "runnerId"],
        message: "Hosted credential mutation request runnerId must match daemon runnerId."
      });
    }
    if ("current" in control && control.current.runnerId !== config.runnerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "current", "runnerId"],
        message: "Hosted credential current-state identity must match daemon runnerId."
      });
    }
    if (
      "canonicalRequestDigest" in control
      && control.canonicalRequestDigest !== hostedCredentialMutationRequestDigest(control.request)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "canonicalRequestDigest"],
        message: "Hosted credential mutation digest must match the canonical strict request."
      });
    }
    const conflictEvidence = control.state === "credential_conflict"
      ? {
          originalRequest: control.request,
          originalCanonicalRequestDigest: control.canonicalRequestDigest,
          replay: control.replay,
          current: control.current,
          provenance: control.provenance
        }
      : "predecessorConflict" in control
        ? control.predecessorConflict
        : control.state === "unpaired" && "evidence" in control && "replay" in control.evidence
          ? control.evidence
          : undefined;
    if (
      conflictEvidence
      && conflictEvidence.originalCanonicalRequestDigest
        !== hostedCredentialMutationRequestDigest(conflictEvidence.originalRequest)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "evidence", "originalCanonicalRequestDigest"],
        message: "Original credential mutation digest must match its canonical strict request."
      });
    }
    if (
      conflictEvidence
      && (
        conflictEvidence.originalRequest.runnerId !== config.runnerId
        || conflictEvidence.replay.runnerId !== config.runnerId
        || conflictEvidence.current.runnerId !== config.runnerId
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "evidence", "runnerId"],
        message: "Nested credential lifecycle evidence must match daemon runnerId."
      });
    }
    if (
      conflictEvidence
      && conflictEvidence.provenance.source === "verified_metadata_replay_and_current_state"
      && (
        !rotationReplayMatchesRequest(conflictEvidence.replay, conflictEvidence.originalRequest)
        || !currentStateMatchesRotationReplay(conflictEvidence.current, conflictEvidence.replay)
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "evidence"],
        message: "Verified credential-conflict evidence must bind the replay and current credential tuple."
      });
    }
    if (
      "predecessorConflict" in control
      && (
        control.request.operationId === control.predecessorConflict.originalRequest.operationId
        || control.request.requestId === control.predecessorConflict.originalRequest.requestId
        || control.request.expectedRegistrationGeneration
          !== control.predecessorConflict.replay.registrationGeneration
        || control.request.expectedCredentialGeneration
          !== control.predecessorConflict.replay.credentialGeneration
        || control.request.expectedCredentialId !== control.predecessorConflict.replay.credentialId
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "request"],
        message: "Successor rotation must be fresh and target its verified predecessor replay tuple."
      });
    }
    if (control.state === "unpaired" && "evidence" in control) {
      if ("replay" in control.evidence) {
        const expectedSource = control.recoveryReason === "replay_mismatch"
          ? "metadata_replay_mismatch"
          : control.recoveryReason === "current_state_unsafe"
            ? "current_state_unsafe"
            : "verified_metadata_replay_and_current_state";
        const expectedSuccessorAttempted = "successorReplay" in control;
        if (
          control.evidence.provenance.source !== expectedSource
          || control.evidence.successorAttempted !== expectedSuccessorAttempted
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["controlRegistration", "evidence", "provenance"],
            message: "Terminal recovery evidence provenance must match its recovery reason."
          });
        }
      } else if (
        control.evidence.failure.reason !== control.recoveryReason
        || control.evidence.originalCanonicalRequestDigest
          !== hostedCredentialMutationRequestDigest(control.evidence.originalRequest)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controlRegistration", "evidence"],
          message: "Redacted reconciliation failure evidence must bind its reason and canonical request."
        });
      }
    }
    if (
      control.state === "unpaired"
      && "successorReplay" in control
      && control.successorCanonicalRequestDigest !== hostedCredentialMutationRequestDigest(control.successorRequest)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "successorCanonicalRequestDigest"],
        message: "Successor credential mutation digest must match its canonical strict request."
      });
    }
    if (control.state === "unpaired" && "successorReplay" in control) {
      const replayMatches = rotationReplayMatchesRequest(control.successorReplay, control.successorRequest);
      const shouldMatch = control.recoveryReason === "successor_replay_without_token";
      const successorTargetsPredecessor =
        control.successorRequest.operationId !== control.evidence.originalRequest.operationId
        && control.successorRequest.requestId !== control.evidence.originalRequest.requestId
        && control.successorRequest.expectedRegistrationGeneration
          === control.evidence.replay.registrationGeneration
        && control.successorRequest.expectedCredentialGeneration
          === control.evidence.replay.credentialGeneration
        && control.successorRequest.expectedCredentialId === control.evidence.replay.credentialId;
      if (replayMatches !== shouldMatch || !successorTargetsPredecessor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controlRegistration", "successorReplay"],
          message: "Terminal successor replay metadata must match its recovery reason and successor request."
        });
      }
      if (
        control.successorRequest.runnerId !== config.runnerId
        || control.successorReplay.runnerId !== config.runnerId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controlRegistration", "successorReplay", "runnerId"],
          message: "Terminal successor evidence must match daemon runnerId."
        });
      }
    }
    if (
      control.state === "unpaired"
      && "evidence" in control
      && "failure" in control.evidence
      && (
        control.evidence.originalRequest.runnerId !== config.runnerId
        || (
          control.recoveryReason === "membership_verification_failed"
            ? control.evidence.failure.code !== "membership_unavailable"
              && control.evidence.failure.code !== "membership_forbidden"
            : control.evidence.failure.code !== "current_state_unavailable"
              && control.evidence.failure.code !== "current_state_forbidden"
              && control.evidence.failure.code !== "invalid_response"
        )
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "evidence"],
        message: "Reconciliation failure evidence must bind daemon runnerId and a reason-safe redacted code."
      });
    }
    if (
      "request" in control
      && control.state !== "rotation_staged"
      && control.state !== "revoked"
      && control.state !== "credential_conflict"
      && (
        control.request.expectedRegistrationGeneration !== control.registration.registrationGeneration
        || control.request.expectedCredentialGeneration !== control.registration.credentialGeneration
        || control.request.expectedCredentialId !== control.registration.credentialId
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "request"],
        message: "Hosted credential mutation request must describe the currently paired credential."
      });
    }
    if (control.state === "rotation_staged" && (
      control.rotation.operationId !== control.request.operationId
      || control.rotation.runnerId !== control.request.runnerId
      || control.rotation.registrationGeneration !== control.request.expectedRegistrationGeneration
      || control.rotation.credentialGeneration !== control.request.expectedCredentialGeneration + 1
      || control.rotation.replacedCredentialId !== control.request.expectedCredentialId
    )) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "rotation"],
        message: "Staged rotation metadata must advance only the credential generation and identify a fresh credential."
      });
    }
    if (control.state === "revoked" && (
      control.revocation.operationId !== control.request.operationId
      || control.revocation.runnerId !== control.request.runnerId
      || control.revocation.registrationGeneration !== control.request.expectedRegistrationGeneration
      || control.revocation.credentialGeneration !== control.request.expectedCredentialGeneration + 1
      || control.revocation.revokedCredentialId !== control.request.expectedCredentialId
      || control.registration.registrationGeneration !== control.request.expectedRegistrationGeneration
      || control.registration.credentialGeneration !== control.request.expectedCredentialGeneration
      || control.registration.credentialId !== control.request.expectedCredentialId
    )) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlRegistration", "revocation"],
        message: "Revocation metadata must advance only the credential generation and identify the revoked credential."
      });
    }
  });

export type RepositoryBindingConfig = z.infer<typeof RepositoryBindingConfigSchema>;
export type ChannelBindingConfig = z.infer<typeof ChannelBindingConfigSchema>;
export type SlackChannelBindingConfig = z.infer<typeof SlackChannelBindingConfigSchema>;
export type LarkChannelBindingConfig = z.infer<typeof LarkChannelBindingConfigSchema>;
export type AgentSessionProfileConfig = z.infer<typeof AgentSessionProfileConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
export type OpenTagDaemonConfig = z.infer<typeof OpenTagDaemonConfigSchema>;

function channelBindingIdentity(binding: Pick<ChannelBindingConfig, "provider" | "accountId" | "conversationId">): string {
  return JSON.stringify([binding.provider, binding.accountId, binding.conversationId]);
}

function formatChannelBindingIdentity(binding: Pick<ChannelBindingConfig, "provider" | "accountId" | "conversationId">): string {
  return `${binding.provider}:${binding.accountId}/${binding.conversationId}`;
}

function sameChannelBindingTarget(left: ChannelBindingConfig, right: ChannelBindingConfig): boolean {
  return left.repoProvider === right.repoProvider
    && left.owner === right.owner
    && left.repo === right.repo
    && JSON.stringify(left.ownership) === JSON.stringify(right.ownership);
}

function formatChannelBindingTarget(binding: ChannelBindingConfig): string {
  return binding.repoProvider && binding.owner && binding.repo
    ? `${binding.repoProvider}:${binding.owner}/${binding.repo}`
    : "no repository target";
}

export function normalizeChannelBindings(config: OpenTagDaemonConfig): ChannelBindingConfig[] {
  const bindings: ChannelBindingConfig[] = [...(config.channelBindings ?? [])];

  for (const binding of config.slackChannels ?? []) {
    bindings.push({
      provider: "slack",
      accountId: binding.teamId,
      conversationId: binding.channelId,
      repoProvider: binding.repoProvider,
      owner: binding.owner,
      repo: binding.repo
    });
  }

  for (const binding of config.larkChannels ?? []) {
    bindings.push({
      provider: "lark",
      accountId: binding.tenantKey,
      conversationId: binding.chatId,
      repoProvider: binding.repoProvider,
      owner: binding.owner,
      repo: binding.repo
    });
  }

  const normalized = new Map<string, ChannelBindingConfig>();
  for (const binding of bindings) {
    const key = channelBindingIdentity(binding);
    const existing = normalized.get(key);
    if (existing && !sameChannelBindingTarget(existing, binding)) {
      throw new Error(
        `Conflicting channel binding for ${formatChannelBindingIdentity(binding)}: ${formatChannelBindingTarget(existing)} and ${formatChannelBindingTarget(binding)}`
      );
    }
    if (!existing) {
      normalized.set(key, binding);
    }
  }

  return [...normalized.values()];
}

export type InitConfigInput = {
  runnerId?: string;
  dispatcherUrl?: string;
  pairingToken?: string;
  runnerToken?: string;
  owner: string;
  repo: string;
  checkoutPath: string;
  executor?: string;
  baseBranch?: string;
  pushRemote?: string;
  worktreeRoot?: string;
  keepWorktree?: string;
};

function parseNumberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function stringListFromJsonEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  const values = parsed.map((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${name}[${index}] must be a non-empty string.`);
    }
    return value.trim();
  });
  return values.length ? values : undefined;
}

function formatPath(path: PropertyKey[]): string {
  return path.length ? path.map(String).join(".") : "config";
}

export function formatConfigError(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }

  return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join("\n");
}

export function parseDaemonConfig(value: unknown): OpenTagDaemonConfig {
  const parsed = OpenTagDaemonConfigSchema.parse(value);
  normalizeChannelBindings(parsed);
  return parsed;
}

export type HostedCredentialOperation = "rotate" | "revoke" | "reprovision";

export function hostedCredentialOperationProblem(
  control: HostedControlRegistration | undefined,
  operation: HostedCredentialOperation
): string | undefined {
  if (!control) return "Hosted Control V1 is not configured.";
  if (operation === "reprovision") {
    return control.state === "revoked"
      || (control.state === "unpaired" && control.reason === "recovery_required")
      ? undefined
      : "Hosted credential re-provision requires a revoked or recovery-required runner.";
  }
  return control.state === "paired"
    ? undefined
    : `Hosted credential ${operation} requires a paired runner.`;
}

function requirePairedCredentialMutation<Request extends HostedCredentialMutationRequest>(
  config: OpenTagDaemonConfig,
  requestValue: Request,
  operation: "rotate" | "revoke",
  schema: { parse(value: unknown): Request }
): { request: Request; registration: HostedControlRegistrationMetadata } {
  const problem = hostedCredentialOperationProblem(config.controlRegistration, operation);
  if (problem) throw new Error(problem);
  const control = config.controlRegistration;
  if (!control || control.state !== "paired") throw new Error(`Hosted credential ${operation} requires a paired runner.`);
  const request = schema.parse(requestValue);
  if (
    request.runnerId !== config.runnerId
    || request.expectedRegistrationGeneration !== control.registration.registrationGeneration
    || request.expectedCredentialGeneration !== control.registration.credentialGeneration
    || request.expectedCredentialId !== control.registration.credentialId
  ) {
    throw new Error(`Hosted credential ${operation} request does not match the currently paired credential.`);
  }
  return { request, registration: control.registration };
}

function withoutHostedTokens(
  config: OpenTagDaemonConfig
): Omit<OpenTagDaemonConfig, "runnerToken" | "runnerTokens" | "pairingToken"> {
  const { runnerToken: _runnerToken, runnerTokens: _runnerTokens, pairingToken: _pairingToken, ...rest } = config;
  return rest;
}

function registrationFromRotation(
  rotation: z.infer<typeof RunnerCredentialRotationMetadataV1Schema>
): HostedControlRegistrationMetadata {
  return HostedControlRegistrationMetadataSchema.parse({
    schemaVersion: rotation.schemaVersion,
    protocolVersion: rotation.protocolVersion,
    runnerId: rotation.runnerId,
    registrationGeneration: rotation.registrationGeneration,
    credentialGeneration: rotation.credentialGeneration,
    credentialId: rotation.credentialId,
    credentialPurpose: rotation.credentialPurpose,
    createdAt: rotation.createdAt
  });
}

export function beginHostedCredentialRotation(
  config: OpenTagDaemonConfig,
  input: {
    request: RunnerCredentialRotationRequestV1;
    canonicalRequestDigest?: string;
  }
): OpenTagDaemonConfig {
  const { request, registration } = requirePairedCredentialMutation(
    config,
    input.request,
    "rotate",
    RunnerCredentialRotationRequestV1Schema
  );
  const canonicalRequestDigest = verifiedHostedCredentialMutationDigest(request, input.canonicalRequestDigest);
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "rotation_pending",
      endpoint: "rotate",
      origin: "paired",
      canonicalRequestDigest,
      request,
      registration
    }
  });
}

export function markHostedCredentialRotationOutcomeUnknown(config: OpenTagDaemonConfig): OpenTagDaemonConfig {
  const control = config.controlRegistration;
  if (!control || control.state !== "rotation_pending") {
    throw new Error("Only a pending hosted credential rotation can become outcome-unknown.");
  }
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    controlRegistration: { ...control, state: "rotation_outcome_unknown" }
  });
}

export function beginHostedCredentialRotationSuccessor(
  config: OpenTagDaemonConfig,
  input: {
    request: RunnerCredentialRotationRequestV1;
    canonicalRequestDigest?: string;
  }
): OpenTagDaemonConfig {
  const control = config.controlRegistration;
  if (!control || control.state !== "credential_conflict" || control.successorAttempted) {
    throw new Error("A fresh successor rotation requires an unattempted credential-conflict state.");
  }
  const request = RunnerCredentialRotationRequestV1Schema.parse(input.request);
  if (
    request.runnerId !== control.replay.runnerId
    || request.operationId === control.request.operationId
    || request.requestId === control.request.requestId
    || request.expectedRegistrationGeneration !== control.replay.registrationGeneration
    || request.expectedCredentialGeneration !== control.replay.credentialGeneration
    || request.expectedCredentialId !== control.replay.credentialId
  ) {
    throw new Error("Successor rotation must be fresh and target the verified replay credential tuple.");
  }
  const canonicalRequestDigest = verifiedHostedCredentialMutationDigest(request, input.canonicalRequestDigest);
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "rotation_pending",
      endpoint: "rotate",
      origin: "lost_201_successor",
      canonicalRequestDigest,
      request,
      registration: registrationFromRotation(control.replay),
      predecessorConflict: {
        originalRequest: control.request,
        originalCanonicalRequestDigest: control.canonicalRequestDigest,
        replay: control.replay,
        current: control.current,
        successorAttempted: true,
        provenance: control.provenance
      }
    }
  });
}

export function stageHostedCredentialRotation(
  config: OpenTagDaemonConfig,
  responseValue: z.infer<typeof FreshRunnerCredentialRotationResponseV1Schema>
): OpenTagDaemonConfig {
  const control = config.controlRegistration;
  if (
    !control
    || (control.state !== "rotation_pending" && control.state !== "rotation_outcome_unknown")
  ) {
    throw new Error(
      "Only a pending or outcome-unknown hosted credential rotation can stage a fresh 201 response."
    );
  }
  const response = FreshRunnerCredentialRotationResponseV1Schema.parse(responseValue);
  const { runnerToken, replayed: _replayed, ...rotationValue } = response;
  const rotation = RunnerCredentialRotationMetadataV1Schema.parse(rotationValue);
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    runnerToken,
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "rotation_staged",
      endpoint: control.endpoint,
      origin: control.origin,
      canonicalRequestDigest: control.canonicalRequestDigest,
      request: control.request,
      rotation,
      ...(control.origin === "lost_201_successor"
        ? { predecessorConflict: control.predecessorConflict }
        : {})
    }
  });
}

export function reconcileHostedCredentialRotationSuccessorReplay(
  config: OpenTagDaemonConfig,
  replayValue: ReplayedRunnerCredentialRotationResponseV1
): OpenTagDaemonConfig {
  const control = config.controlRegistration;
  if (
    !control
    || control.state !== "rotation_outcome_unknown"
    || control.origin !== "lost_201_successor"
  ) {
    throw new Error("Successor replay reconciliation requires a persisted successor outcome-unknown state.");
  }
  const successorReplay = ReplayedRunnerCredentialRotationResponseV1Schema.parse(replayValue);
  const replayMatches = rotationReplayMatchesRequest(successorReplay, control.request);
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "unpaired",
      reason: "recovery_required",
      recoveryReason: replayMatches
        ? "successor_replay_without_token"
        : "successor_replay_mismatch",
      registration: replayMatches
        ? registrationFromRotation(successorReplay)
        : control.registration,
      evidence: control.predecessorConflict,
      successorRequest: control.request,
      successorCanonicalRequestDigest: control.canonicalRequestDigest,
      successorReplay
    }
  });
}

export function recordHostedCredentialReconciliationFailure(
  config: OpenTagDaemonConfig,
  input: {
    reason: "membership_verification_failed" | "current_state_read_failed";
    code:
      | "membership_unavailable"
      | "membership_forbidden"
      | "current_state_unavailable"
      | "current_state_forbidden"
      | "invalid_response";
  }
): OpenTagDaemonConfig {
  const control = config.controlRegistration;
  if (!control || control.state !== "rotation_outcome_unknown" || control.origin !== "paired") {
    throw new Error("Reconciliation failure requires an authoritative rotation outcome-unknown state.");
  }
  const validCode = input.reason === "membership_verification_failed"
    ? input.code === "membership_unavailable" || input.code === "membership_forbidden"
    : input.code === "current_state_unavailable"
      || input.code === "current_state_forbidden"
      || input.code === "invalid_response";
  if (!validCode) throw new Error("Reconciliation failure code does not match its redacted reason.");
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "unpaired",
      reason: "recovery_required",
      recoveryReason: input.reason,
      registration: control.registration,
      evidence: {
        kind: "reconciliation_failure",
        originalRequest: control.request,
        originalCanonicalRequestDigest: control.canonicalRequestDigest,
        failure: input,
        provenance: {
          origin: "lost_201_reconciliation",
          source: "redacted_local_failure"
        }
      }
    }
  });
}

export function finalizeHostedCredentialRotation(config: OpenTagDaemonConfig): OpenTagDaemonConfig {
  const control = config.controlRegistration;
  if (!control || control.state !== "rotation_staged") {
    throw new Error("Only a staged hosted credential rotation can be finalized.");
  }
  return parseDaemonConfig({
    ...config,
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "paired",
      operationId: control.request.operationId,
      registration: registrationFromRotation(control.rotation)
    }
  });
}

export function beginHostedCredentialRevocation(
  config: OpenTagDaemonConfig,
  input: {
    request: RunnerCredentialRevocationRequestV1;
    canonicalRequestDigest?: string;
  }
): OpenTagDaemonConfig {
  const { request, registration } = requirePairedCredentialMutation(
    config,
    input.request,
    "revoke",
    RunnerCredentialRevocationRequestV1Schema
  );
  const canonicalRequestDigest = verifiedHostedCredentialMutationDigest(request, input.canonicalRequestDigest);
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "revocation_pending",
      endpoint: "revoke",
      canonicalRequestDigest,
      request,
      registration
    }
  });
}

export function markHostedCredentialRevocationOutcomeUnknown(config: OpenTagDaemonConfig): OpenTagDaemonConfig {
  const control = config.controlRegistration;
  if (!control || control.state !== "revocation_pending") {
    throw new Error("Only a pending hosted credential revocation can become outcome-unknown.");
  }
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    controlRegistration: { ...control, state: "revocation_outcome_unknown" }
  });
}

export function confirmHostedCredentialRevocation(
  config: OpenTagDaemonConfig,
  revocation: z.infer<typeof RunnerCredentialRevocationResponseV1Schema>
): OpenTagDaemonConfig {
  const control = config.controlRegistration;
  if (!control || (control.state !== "revocation_pending" && control.state !== "revocation_outcome_unknown")) {
    throw new Error("Only an unresolved hosted credential revocation can be confirmed.");
  }
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "revoked",
      endpoint: control.endpoint,
      canonicalRequestDigest: control.canonicalRequestDigest,
      request: control.request,
      registration: control.registration,
      revocation
    }
  });
}

export function recordHostedCredentialConflict(
  config: OpenTagDaemonConfig,
  input: {
    replay: ReplayedRunnerCredentialRotationResponseV1;
    current: RunnerCredentialCurrentStateResponseV1;
  }
): OpenTagDaemonConfig {
  const control = config.controlRegistration;
  if (!control || control.state !== "rotation_outcome_unknown" || control.origin !== "paired") {
    throw new Error("Credential conflict reconciliation requires an authoritative rotation outcome-unknown state.");
  }
  const replay = ReplayedRunnerCredentialRotationResponseV1Schema.parse(input.replay);
  const current = RunnerCredentialCurrentStateResponseV1Schema.parse(input.current);
  if (current.runnerId !== config.runnerId || replay.runnerId !== config.runnerId) {
    throw new Error("Hosted credential conflict identity must match daemon runnerId.");
  }
  const replayMatches = rotationReplayMatchesRequest(replay, control.request);
  const currentMatches = currentStateMatchesRotationReplay(current, replay);
  const evidence = {
    originalRequest: control.request,
    originalCanonicalRequestDigest: control.canonicalRequestDigest,
    replay,
    current,
    successorAttempted: false,
    provenance: {
      origin: "lost_201_replay" as const,
      source: (replayMatches
        ? currentMatches
          ? "verified_metadata_replay_and_current_state"
          : "current_state_unsafe"
        : "metadata_replay_mismatch") as
          | "verified_metadata_replay_and_current_state"
          | "metadata_replay_mismatch"
          | "current_state_unsafe"
    }
  };
  if (!replayMatches || !currentMatches) {
    return parseDaemonConfig({
      ...withoutHostedTokens(config),
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        reason: "recovery_required",
        recoveryReason: replayMatches ? "current_state_unsafe" : "replay_mismatch",
        registration: replayMatches
          ? registrationFromRotation(replay)
          : control.registration,
        evidence
      }
    });
  }
  return parseDaemonConfig({
    ...withoutHostedTokens(config),
    controlRegistration: {
      kind: "hosted_control_v1",
      state: "credential_conflict",
      endpoint: control.endpoint,
      canonicalRequestDigest: control.canonicalRequestDigest,
      request: control.request,
      replay,
      current,
      successorAttempted: false,
      provenance: evidence.provenance
    }
  });
}

export function hostedRunnerAuthProblem(
  config: Pick<OpenTagDaemonConfig, "runnerId" | "runnerToken" | "pairingToken" | "controlRegistration">
): string | undefined {
  const control = config.controlRegistration;
  if (!control) return undefined;
  if (control.state === "unpaired") {
    return control.reason === "recovery_required"
      ? "Hosted Control V1 runner credential recovery is required; re-provision the runner before starting it."
      : `Hosted Control V1 runner is ${control.reason === "pending" ? "not paired" : "in an outcome-unknown pairing state"}; complete pairing or recovery before starting it.`;
  }
  if (control.state === "credential_staged") {
    return "Hosted Control V1 runner credential is staged but not committed as paired; finish local credential verification before starting it.";
  }
  if (control.state === "rotation_staged") {
    return "Hosted Control V1 runner credential rotation is staged but not finalized; finalize the local rotation before starting it.";
  }
  if (control.state === "rotation_pending" || control.state === "rotation_outcome_unknown") {
    return `Hosted Control V1 runner credential rotation is ${control.state === "rotation_pending" ? "pending" : "outcome-unknown"}; reconcile it before starting the runner.`;
  }
  if (control.state === "revocation_pending" || control.state === "revocation_outcome_unknown") {
    return `Hosted Control V1 runner credential revocation is ${control.state === "revocation_pending" ? "pending" : "outcome-unknown"}; reconcile it before starting the runner.`;
  }
  if (control.state === "credential_conflict") {
    return "Hosted Control V1 runner has a verified credential conflict; attempt the single fresh successor rotation or enter terminal recovery.";
  }
  if (control.state === "revoked") {
    return "Hosted Control V1 runner credential is revoked; re-provision the runner before starting it.";
  }
  if (config.pairingToken) {
    return "Hosted Control V1 paired configuration retains a pairing token; remove it before starting the runner.";
  }
  if (!config.runnerToken) {
    return "Hosted Control V1 paired configuration is missing its runtime runner token; re-provision the runner before starting it.";
  }
  if (!control.registration || control.registration.runnerId !== config.runnerId) {
    return "Hosted Control V1 registration identity does not match daemon runnerId; correct or re-provision the runner before starting it.";
  }
  return undefined;
}

export function runnerDispatcherToken(
  config: Pick<OpenTagDaemonConfig, "runnerId" | "runnerToken" | "pairingToken" | "controlRegistration">
): string | undefined {
  if (config.controlRegistration) {
    return hostedRunnerAuthProblem(config) ? undefined : config.runnerToken;
  }
  return config.runnerToken ?? config.pairingToken;
}

export function createInitialConfig(input: InitConfigInput): OpenTagDaemonConfig {
  return parseDaemonConfig({
    runnerId: input.runnerId ?? "runner_local",
    dispatcherUrl: input.dispatcherUrl ?? "http://localhost:3030",
    ...(input.pairingToken ? { pairingToken: input.pairingToken } : {}),
    ...(input.runnerToken ? { runnerToken: input.runnerToken } : {}),
    repositories: [
      {
        provider: "github",
        owner: input.owner,
        repo: input.repo,
        checkoutPath: input.checkoutPath,
        defaultExecutor: input.executor ?? "echo",
        baseBranch: input.baseBranch ?? "main",
        pushRemote: input.pushRemote ?? "origin",
        ...(input.worktreeRoot ? { worktreeRoot: input.worktreeRoot } : {}),
        keepWorktree: input.keepWorktree ?? "on_failure"
      }
    ]
  });
}

function assertNoLegacyClaudeDirectEnvironment(): void {
  const configured = [
    "OPENTAG_CLAUDE_COMMAND",
    "OPENTAG_CLAUDE_MODEL",
    "OPENTAG_CLAUDE_PERMISSION_MODE",
    "OPENTAG_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS"
  ].filter((name) => process.env[name] !== undefined);
  if (configured.length > 0) {
    throw new Error(
      `${configured.join(", ")} configure the removed Claude direct adapter. Claude Code now uses the Registry-backed ACP launch; remove these variables.`
    );
  }
}

function extraSafeEnvFromEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const names = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return names.length > 0 ? names : undefined;
}

export function loadConfigFromEnv(): OpenTagDaemonConfig {
  assertNoLegacyClaudeDirectEnvironment();
  const configPath = process.env.OPENTAG_CONFIG_PATH;
  if (configPath) {
    return parseDaemonConfig(JSON.parse(readFileSync(configPath, "utf8")));
  }

  const owner = process.env.OPENTAG_REPO_OWNER;
  const repo = process.env.OPENTAG_REPO_NAME;
  const checkoutPath = process.env.OPENTAG_WORKSPACE_PATH;
  const repositoryProvider = process.env.OPENTAG_REPO_PROVIDER ?? process.env.OPENTAG_SLACK_REPO_PROVIDER ?? "github";
  const runnerTokens = stringListFromJsonEnv("OPENTAG_RUNNER_TOKENS_JSON");
  const revokedRunnerTokenFingerprints = stringListFromJsonEnv("OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON");
  const repositories =
    owner && repo && checkoutPath
      ? [
          {
            provider: repositoryProvider,
            owner,
            repo,
            checkoutPath,
            defaultExecutor: process.env.OPENTAG_DEFAULT_EXECUTOR ?? "echo",
            baseBranch: process.env.OPENTAG_BASE_BRANCH ?? "main",
            pushRemote: process.env.OPENTAG_PUSH_REMOTE ?? "origin",
            ...(process.env.OPENTAG_WORKTREE_ROOT ? { worktreeRoot: process.env.OPENTAG_WORKTREE_ROOT } : {}),
            keepWorktree: process.env.OPENTAG_KEEP_WORKTREE ?? "on_failure"
          }
        ]
      : [];

  const config = {
    runnerId: process.env.OPENTAG_RUNNER_ID ?? "runner_local",
    dispatcherUrl: process.env.OPENTAG_DISPATCHER_URL ?? "http://localhost:3030",
    repositories,
    ...(process.env.OPENTAG_SLACK_TEAM_ID && process.env.OPENTAG_SLACK_CHANNEL_ID && owner && repo
      ? {
          slackChannels: [
            {
              teamId: process.env.OPENTAG_SLACK_TEAM_ID,
              channelId: process.env.OPENTAG_SLACK_CHANNEL_ID,
              repoProvider: repositoryProvider,
              owner,
              repo
            }
          ]
        }
      : {}),
    ...(process.env.OPENTAG_LARK_TENANT_KEY && process.env.OPENTAG_LARK_CHAT_ID && owner && repo
      ? {
          larkChannels: [
            {
              tenantKey: process.env.OPENTAG_LARK_TENANT_KEY,
              chatId: process.env.OPENTAG_LARK_CHAT_ID,
              repoProvider: repositoryProvider,
              owner,
              repo
            }
          ]
        }
      : {}),
    ...(process.env.OPENTAG_HERMES_COMMAND || process.env.OPENTAG_HERMES_PROFILE || process.env.OPENTAG_HERMES_PROFILE_TEMPLATE
      ? {
          hermes: {
            ...(process.env.OPENTAG_HERMES_COMMAND ? { command: process.env.OPENTAG_HERMES_COMMAND } : {}),
            ...(process.env.OPENTAG_HERMES_PROFILE ? { profile: process.env.OPENTAG_HERMES_PROFILE } : {}),
            ...(process.env.OPENTAG_HERMES_PROFILE_TEMPLATE ? { profileTemplate: process.env.OPENTAG_HERMES_PROFILE_TEMPLATE } : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_OPENCLAW_COMMAND || process.env.OPENTAG_OPENCLAW_PROFILE || process.env.OPENTAG_OPENCLAW_GATEWAY_URL || process.env.OPENTAG_OPENCLAW_EXPECTED_VERSION
      ? {
          openclaw: {
            ...(process.env.OPENTAG_OPENCLAW_COMMAND ? { command: process.env.OPENTAG_OPENCLAW_COMMAND } : {}),
            ...(process.env.OPENTAG_OPENCLAW_PROFILE ? { profile: process.env.OPENTAG_OPENCLAW_PROFILE } : {}),
            ...(process.env.OPENTAG_OPENCLAW_GATEWAY_URL ? { gatewayUrl: process.env.OPENTAG_OPENCLAW_GATEWAY_URL } : {}),
            ...(process.env.OPENTAG_OPENCLAW_EXPECTED_VERSION ? { expectedVersion: process.env.OPENTAG_OPENCLAW_EXPECTED_VERSION } : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_AGENT_PROFILE || process.env.OPENTAG_AGENT_PROFILE_TEMPLATE
      ? {
          agentSessionProfile: {
            ...(process.env.OPENTAG_AGENT_PROFILE ? { profile: process.env.OPENTAG_AGENT_PROFILE } : {}),
            ...(process.env.OPENTAG_AGENT_PROFILE_TEMPLATE ? { profileTemplate: process.env.OPENTAG_AGENT_PROFILE_TEMPLATE } : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_SECURITY_MODE ||
    process.env.OPENTAG_ALLOWED_WORKSPACE_ROOT ||
    process.env.OPENTAG_ALLOW_UNSAFE_PROMPTS ||
    process.env.OPENTAG_EXTRA_SAFE_ENV
      ? {
          security: {
            ...(process.env.OPENTAG_SECURITY_MODE
              ? { mode: process.env.OPENTAG_SECURITY_MODE as "enforce" | "audit" | "off" }
              : {}),
            ...(process.env.OPENTAG_ALLOWED_WORKSPACE_ROOT
              ? { allowedWorkspaceRoot: process.env.OPENTAG_ALLOWED_WORKSPACE_ROOT }
              : {}),
            ...(process.env.OPENTAG_ALLOW_UNSAFE_PROMPTS
              ? { allowUnsafePrompts: process.env.OPENTAG_ALLOW_UNSAFE_PROMPTS === "true" }
              : {}),
            ...(extraSafeEnvFromEnv(process.env.OPENTAG_EXTRA_SAFE_ENV)
              ? { extraSafeEnv: extraSafeEnvFromEnv(process.env.OPENTAG_EXTRA_SAFE_ENV) }
              : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_GITHUB_TOKEN ? { githubToken: process.env.OPENTAG_GITHUB_TOKEN } : {}),
    ...(process.env.OPENTAG_GITHUB_APPLY_DISABLED === "true"
      ? { githubApplyToken: null }
      : process.env.OPENTAG_GITHUB_APPLY_TOKEN
        ? { githubApplyToken: process.env.OPENTAG_GITHUB_APPLY_TOKEN }
        : {}),
    ...(process.env.OPENTAG_PREPARE_PR_BRANCH ? { preparePullRequestBranch: process.env.OPENTAG_PREPARE_PR_BRANCH === "true" } : {}),
    ...(process.env.OPENTAG_ALLOW_AUTO_CREATE_PR ? { allowAutoCreatePullRequest: process.env.OPENTAG_ALLOW_AUTO_CREATE_PR === "true" } : {}),
    ...(process.env.OPENTAG_PAIRING_TOKEN ? { pairingToken: process.env.OPENTAG_PAIRING_TOKEN } : {}),
    ...(process.env.OPENTAG_RUNNER_TOKEN ? { runnerToken: process.env.OPENTAG_RUNNER_TOKEN } : {}),
    ...(runnerTokens ? { runnerTokens } : {}),
    ...(revokedRunnerTokenFingerprints ? { revokedRunnerTokenFingerprints } : {}),
    ...(process.env.OPENTAG_POLL_INTERVAL_MS ? { pollIntervalMs: parseNumberFromEnv("OPENTAG_POLL_INTERVAL_MS") } : {}),
    ...(process.env.OPENTAG_HEARTBEAT_INTERVAL_MS
      ? { heartbeatIntervalMs: parseNumberFromEnv("OPENTAG_HEARTBEAT_INTERVAL_MS") }
      : {}),
    ...(process.env.OPENTAG_RUN_TIMEOUT_MS ? { runTimeoutMs: parseNumberFromEnv("OPENTAG_RUN_TIMEOUT_MS") } : {})
  };
  return parseDaemonConfig(config);
}
