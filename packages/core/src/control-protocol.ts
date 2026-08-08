import { z } from "zod";
import { CompletionReasonCodeSchema } from "./schema.js";

export const CONTROL_SCHEMA_VERSION = 1 as const;
export const CONTROL_PROTOCOL_VERSION = "1.0" as const;
export const CONTROL_CAPABILITY_REGISTRY_VERSION = "opentag.control.capabilities/v1" as const;

export const ControlSchemaVersionSchema = z.literal(CONTROL_SCHEMA_VERSION);
export const ControlProtocolVersionSchema = z.literal(CONTROL_PROTOCOL_VERSION);
export const ControlCapabilityRegistryVersionSchema = z.literal(CONTROL_CAPABILITY_REGISTRY_VERSION);

export const RelayCapabilitySchema = z.enum([
  "relay.registration.v1",
  "relay.credential-reprovision.v1",
  "relay.credential-rotation.v1",
  "relay.readiness.v1",
  "relay.repository-binding.v1",
  "relay.hosted-admission.v1",
  "relay.claim-fence.v1",
  "relay.lifecycle.v1",
  "relay.permission.v1",
  "relay.material-receipt.v1",
  "relay.cancel-resume.v1",
  "relay.follow-up.v1",
  "relay.work-thread-ref.v1",
  "relay.completion-contract-ref.v1",
  "relay.completion-assessment.v1",
  "relay.callback-observation.v1",
  "relay.check-observation.v1",
]);

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function sortedUniqueArray<T extends z.ZodType<string>>(item: T) {
  return z.array(item).superRefine((values, ctx) => {
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      if (previous === undefined || current === undefined) continue;
      if (compareUnicodeCodePoints(previous, current) >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Values must be sorted by Unicode code point and contain no duplicates.",
        });
      }
    }
  });
}

export const RequiredRelayCapabilitiesSchema = sortedUniqueArray(RelayCapabilitySchema).min(1);
export const RelayCapabilitiesSchema = sortedUniqueArray(RelayCapabilitySchema);
export const ReceiptDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const ControlTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }, "Timestamp must be a real RFC 3339 UTC millisecond instant.");
export const WorkerReleaseShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
export const NpmPackageVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u,
  );

const UnpaddedNonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), "Value must not contain leading or trailing whitespace.");
const NonEmptyIdSchema = UnpaddedNonEmptyStringSchema;
const DigestSetSchema = sortedUniqueArray(ReceiptDigestSchema);

export const RunnerReadinessReasonCodeV1Schema = z.enum([
  "credential_unavailable",
  "executor_unavailable",
  "registration_stale",
  "target_binding_stale",
  "target_unavailable",
]);

export const CallbackObservationReasonCodeV1Schema = z.enum([
  "provider_accepted",
  "provider_error",
  "provider_receipt_missing",
  "provider_rejected",
  "provider_timeout",
]);

export const ControlVersionNegotiationV1Schema = z
  .object({
    schemaVersion: ControlSchemaVersionSchema,
    protocolVersion: ControlProtocolVersionSchema,
  })
  .strict();

export const ArtifactIdentityV1Schema = z
  .object({
    packageName: UnpaddedNonEmptyStringSchema,
    packageVersion: NpmPackageVersionSchema,
  })
  .strict();

export const RelayCapabilitiesResponseV1Schema = z
  .object({
    schemaVersion: ControlSchemaVersionSchema,
    protocolVersion: ControlProtocolVersionSchema,
    registryVersion: ControlCapabilityRegistryVersionSchema,
    capabilities: RelayCapabilitiesSchema,
    minimumClient: ControlVersionNegotiationV1Schema,
    deployment: z
      .object({
        environment: UnpaddedNonEmptyStringSchema,
        releaseSha: WorkerReleaseShaSchema,
      })
      .strict(),
    artifact: ArtifactIdentityV1Schema.optional(),
  })
  .strict();

const ControlMutationRequestV1Shape = {
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: RequiredRelayCapabilitiesSchema,
  requestId: NonEmptyIdSchema,
  operationId: NonEmptyIdSchema,
};

export const ControlMutationRequestV1Schema = z.object(ControlMutationRequestV1Shape).strict();

const VersionedResponseShape = {
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
};

export const ControlWaitingResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    state: z.literal("waiting"),
    requestId: NonEmptyIdSchema,
    resolutionRef: NonEmptyIdSchema,
    nextAction: NonEmptyIdSchema,
  })
  .strict();

export const ControlWaitingHttpResponseV1Schema = z
  .object({ status: z.literal(202), body: ControlWaitingResponseV1Schema })
  .strict();

export const ControlInvalidRequestResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.enum(["invalid_request_body", "digest_mismatch"]),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlInvalidCredentialResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("invalid_credential"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlInsufficientScopeResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("insufficient_scope"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlConcealedNotFoundResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("missing_or_concealed"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlConflictResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.enum(["stale_attempt", "stale_credential", "idempotency_conflict", "invalid_state_transition"]),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlRateLimitedResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("rate_limited"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
    retryAfterSeconds: z.number().int().positive(),
  })
  .strict();

export const ControlCapabilityRequiredResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("capability_required"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
    requiredCapabilities: RequiredRelayCapabilitiesSchema,
  })
  .strict();

export const ControlRequestBodyTooLargeResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("request_body_too_large"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlObservationPolicyMismatchResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("observation_policy_mismatch"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlProtocolUpgradeResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("protocol_upgrade_required"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
    supported: z
      .object({
        schemaVersions: z.tuple([z.literal(1)]),
        protocolVersions: z.tuple([z.literal("1.0")]),
      })
      .strict(),
    nextAction: z.literal("upgrade_client"),
  })
  .strict();

const ControlInvalidRequestHttpResponseV1Schema = z
  .object({ status: z.literal(400), body: ControlInvalidRequestResponseV1Schema })
  .strict();
const ControlInvalidCredentialHttpResponseV1Schema = z
  .object({ status: z.literal(401), body: ControlInvalidCredentialResponseV1Schema })
  .strict();
const ControlInsufficientScopeHttpResponseV1Schema = z
  .object({ status: z.literal(403), body: ControlInsufficientScopeResponseV1Schema })
  .strict();
const ControlConcealedNotFoundHttpResponseV1Schema = z
  .object({ status: z.literal(404), body: ControlConcealedNotFoundResponseV1Schema })
  .strict();
const ControlConflictHttpResponseV1Schema = z
  .object({ status: z.literal(409), body: ControlConflictResponseV1Schema })
  .strict();
const ControlCapabilityRequiredHttpResponseV1Schema = z
  .object({ status: z.literal(412), body: ControlCapabilityRequiredResponseV1Schema })
  .strict();
const ControlRequestBodyTooLargeHttpResponseV1Schema = z
  .object({ status: z.literal(413), body: ControlRequestBodyTooLargeResponseV1Schema })
  .strict();
const ControlObservationPolicyMismatchHttpResponseV1Schema = z
  .object({ status: z.literal(422), body: ControlObservationPolicyMismatchResponseV1Schema })
  .strict();
const ControlProtocolUpgradeHttpResponseV1Schema = z
  .object({ status: z.literal(426), body: ControlProtocolUpgradeResponseV1Schema })
  .strict();
const ControlRateLimitedHttpResponseV1Schema = z
  .object({ status: z.literal(429), body: ControlRateLimitedResponseV1Schema })
  .strict();

export const ControlErrorHttpResponseV1Schema = z.union([
  ControlInvalidRequestHttpResponseV1Schema,
  ControlInvalidCredentialHttpResponseV1Schema,
  ControlInsufficientScopeHttpResponseV1Schema,
  ControlConcealedNotFoundHttpResponseV1Schema,
  ControlConflictHttpResponseV1Schema,
  ControlCapabilityRequiredHttpResponseV1Schema,
  ControlRequestBodyTooLargeHttpResponseV1Schema,
  ControlObservationPolicyMismatchHttpResponseV1Schema,
  ControlProtocolUpgradeHttpResponseV1Schema,
  ControlRateLimitedHttpResponseV1Schema,
]);

export const RunnerRegistrationRequestV1Schema = z
  .object({
    ...ControlMutationRequestV1Shape,
    runnerId: NonEmptyIdSchema,
    displayName: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => value === value.trim(), "Display name must not contain leading or trailing whitespace.")
      .optional(),
    capabilities: RelayCapabilitiesSchema,
  })
  .strict()
  .refine((request) => request.requiredCapabilities.includes("relay.registration.v1"), {
    path: ["requiredCapabilities"],
    message: "Runner registration requires relay.registration.v1.",
  });

export const RunnerCredentialReprovisionRequestV1Schema = z
  .object({
    ...ControlMutationRequestV1Shape,
    runnerId: NonEmptyIdSchema,
    recoveryCredentialId: NonEmptyIdSchema,
    expectedRegistrationGeneration: z.number().int().positive(),
    expectedCredentialGeneration: z.number().int().positive(),
  })
  .strict()
  .refine((request) => request.requiredCapabilities.includes("relay.credential-reprovision.v1"), {
    path: ["requiredCapabilities"],
    message: "Credential re-provision requires relay.credential-reprovision.v1.",
  });

export const RunnerCredentialMetadataV1Schema = z
  .object({
    ...VersionedResponseShape,
    operationId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    credentialId: NonEmptyIdSchema,
    credentialPurpose: z.literal("runtime"),
    createdAt: ControlTimestampSchema,
  })
  .strict();

export const FreshRunnerCredentialResponseV1Schema = RunnerCredentialMetadataV1Schema.extend({
  runnerToken: z.string().min(1),
  replayed: z.literal(false),
});

export const ReplayedRunnerCredentialResponseV1Schema = RunnerCredentialMetadataV1Schema.extend({
  replayed: z.literal(true),
});

export const RunnerCredentialResponseV1Schema = z.discriminatedUnion("replayed", [
  FreshRunnerCredentialResponseV1Schema,
  ReplayedRunnerCredentialResponseV1Schema,
]);
export const RunnerRegistrationResponseV1Schema = RunnerCredentialResponseV1Schema;
export const RunnerCredentialReprovisionResponseV1Schema = RunnerCredentialResponseV1Schema;
export const RunnerCredentialHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(201), body: FreshRunnerCredentialResponseV1Schema }).strict(),
  z.object({ status: z.literal(200), body: ReplayedRunnerCredentialResponseV1Schema }).strict(),
  ControlErrorHttpResponseV1Schema,
]);

const RunnerCredentialMutationRequestV1Shape = {
  ...ControlMutationRequestV1Shape,
  requiredCapabilities: z.tuple([z.literal("relay.credential-rotation.v1")]),
  runnerId: NonEmptyIdSchema,
  expectedRegistrationGeneration: z.number().int().positive(),
  expectedCredentialGeneration: z.number().int().positive(),
  expectedCredentialId: NonEmptyIdSchema,
};

export const RunnerCredentialRotationRequestV1Schema = z
  .object(RunnerCredentialMutationRequestV1Shape)
  .strict();

export const RunnerCredentialRevocationRequestV1Schema = z
  .object(RunnerCredentialMutationRequestV1Shape)
  .strict();

export const RunnerCredentialRotationMetadataV1Schema = z
  .object({
    ...VersionedResponseShape,
    operationId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    replacedCredentialId: NonEmptyIdSchema,
    credentialId: NonEmptyIdSchema,
    credentialPurpose: z.literal("runtime"),
    createdAt: ControlTimestampSchema,
  })
  .strict()
  .refine((response) => response.credentialId !== response.replacedCredentialId, {
    path: ["credentialId"],
    message: "Rotated credential must have a new credential ID.",
  });

export const FreshRunnerCredentialRotationResponseV1Schema =
  RunnerCredentialRotationMetadataV1Schema.safeExtend({
    runnerToken: z.string().min(1),
    replayed: z.literal(false),
  });

export const ReplayedRunnerCredentialRotationResponseV1Schema =
  RunnerCredentialRotationMetadataV1Schema.safeExtend({
    replayed: z.literal(true),
  });

export const RunnerCredentialRotationResponseV1Schema = z.discriminatedUnion("replayed", [
  FreshRunnerCredentialRotationResponseV1Schema,
  ReplayedRunnerCredentialRotationResponseV1Schema,
]);

export const RunnerCredentialRevocationResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    operationId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    credentialState: z.literal("revoked"),
    revokedCredentialId: NonEmptyIdSchema,
    credentialPurpose: z.literal("runtime"),
    activeCredentialId: z.null(),
    revokedAt: ControlTimestampSchema,
    replayed: z.boolean(),
  })
  .strict();

export const RunnerCredentialCurrentStateResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    activeCredentialId: NonEmptyIdSchema.nullable(),
    credentialState: z.enum(["active", "revoked"]),
    observedAt: ControlTimestampSchema,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.credentialState === "active" && response.activeCredentialId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeCredentialId"],
        message: "Active credential state requires an active credential ID.",
      });
    }
    if (response.credentialState === "revoked" && response.activeCredentialId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeCredentialId"],
        message: "Revoked credential state cannot expose an active credential ID.",
      });
    }
  });

const RunnerCredentialMutationConflictResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.enum(["stale_credential", "idempotency_conflict", "invalid_state_transition"]),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

const RunnerCredentialMutationErrorHttpResponseV1Schema = z.union([
  ControlInvalidRequestHttpResponseV1Schema,
  ControlInvalidCredentialHttpResponseV1Schema,
  ControlInsufficientScopeHttpResponseV1Schema,
  ControlConcealedNotFoundHttpResponseV1Schema,
  z.object({ status: z.literal(409), body: RunnerCredentialMutationConflictResponseV1Schema }).strict(),
  ControlCapabilityRequiredHttpResponseV1Schema,
  ControlRequestBodyTooLargeHttpResponseV1Schema,
  ControlProtocolUpgradeHttpResponseV1Schema,
  ControlRateLimitedHttpResponseV1Schema,
]);

export const RunnerCredentialRotationHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(201), body: FreshRunnerCredentialRotationResponseV1Schema }).strict(),
  z.object({ status: z.literal(200), body: ReplayedRunnerCredentialRotationResponseV1Schema }).strict(),
  RunnerCredentialMutationErrorHttpResponseV1Schema,
]);

export const RunnerCredentialRevocationHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(200), body: RunnerCredentialRevocationResponseV1Schema }).strict(),
  RunnerCredentialMutationErrorHttpResponseV1Schema,
]);

export const RunnerCredentialCurrentStateHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(200), body: RunnerCredentialCurrentStateResponseV1Schema }).strict(),
  ControlInvalidCredentialHttpResponseV1Schema,
  ControlInsufficientScopeHttpResponseV1Schema,
  ControlConcealedNotFoundHttpResponseV1Schema,
  ControlRateLimitedHttpResponseV1Schema,
]);

export const ReceiptAttemptRefV1Schema = z
  .object({
    attemptId: NonEmptyIdSchema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingTokenDigest: ReceiptDigestSchema,
  })
  .strict();

export const ReceiptProducerV1Schema = z
  .object({
    kind: z.enum(["cloud", "runner", "local_opentag"]),
    id: NonEmptyIdSchema,
    credentialId: NonEmptyIdSchema.optional(),
    registrationGeneration: z.number().int().positive().optional(),
  })
  .strict();

export const RunnerReadinessProducerV1Schema = z
  .object({
    kind: z.literal("runner"),
    id: NonEmptyIdSchema,
    credentialId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
  })
  .strict();

export const ReceiptIdentityV1Schema = z
  .object({
    namespace: z.string().regex(/^opentag\.control\.receipt\/[a-z0-9-]+\/v1$/u),
    parts: z.array(NonEmptyIdSchema).min(2),
  })
  .strict();

const ReceiptEnvelopeBaseShape = {
  ...VersionedResponseShape,
  receiptId: NonEmptyIdSchema,
  organizationId: NonEmptyIdSchema,
  operationId: NonEmptyIdSchema,
  requiredCapabilities: RequiredRelayCapabilitiesSchema,
  producer: ReceiptProducerV1Schema,
  identity: ReceiptIdentityV1Schema,
  predecessorReceiptDigests: DigestSetSchema.optional(),
  observedAt: ControlTimestampSchema,
  payloadDigest: ReceiptDigestSchema,
  receiptDigest: ReceiptDigestSchema,
};

function hasExactReceiptIdentity(
  identity: z.infer<typeof ReceiptIdentityV1Schema>,
  namespace: string,
  parts: string[],
): boolean {
  return identity.namespace === namespace &&
    identity.parts.length === parts.length &&
    identity.parts.every((part, index) => part === parts[index]);
}

export const ReadinessStateV1Schema = z.enum(["ready", "degraded", "blocked", "unknown"]);
const ReadinessReasonShape = { reasonCode: RunnerReadinessReasonCodeV1Schema.optional() };

export const RunnerReadinessPayloadV1Schema = z
  .object({
    readinessId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    capabilities: RelayCapabilitiesSchema,
    executors: z.array(
      z
        .object({
          executorId: NonEmptyIdSchema,
          adapterVersion: UnpaddedNonEmptyStringSchema,
          capabilityDigest: ReceiptDigestSchema,
          state: ReadinessStateV1Schema,
          ...ReadinessReasonShape,
        })
        .strict(),
    ),
    targets: z.array(
      z
        .object({
          projectTargetId: NonEmptyIdSchema,
          bindingDigest: ReceiptDigestSchema,
          state: ReadinessStateV1Schema,
          ...ReadinessReasonShape,
        })
        .strict(),
    ),
    observedAt: ControlTimestampSchema,
    expiresAt: ControlTimestampSchema,
  })
  .strict()
  .superRefine((readiness, ctx) => {
    if (Date.parse(readiness.expiresAt) <= Date.parse(readiness.observedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Readiness expiry must be later than its observation time.",
      });
    }
    for (const [collectionName, entries] of [
      ["executors", readiness.executors],
      ["targets", readiness.targets],
    ] as const) {
      entries.forEach((entry, index) => {
        if (entry.state !== "ready" && entry.reasonCode === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [collectionName, index, "reasonCode"],
            message: "Non-ready attestations require an allowlisted reason code.",
          });
        }
      });
    }
  });

export const RunnerReadinessReceiptEnvelopeV1Schema = z
  .object({
    ...ReceiptEnvelopeBaseShape,
    producer: RunnerReadinessProducerV1Schema,
    receiptKind: z.literal("runner_readiness"),
    payload: RunnerReadinessPayloadV1Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!receipt.requiredCapabilities.includes("relay.readiness.v1")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredCapabilities"], message: "Readiness capability is required." });
    }
    if (receipt.producer.id !== receipt.payload.runnerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["producer", "id"], message: "Readiness producer must match the attested Runner." });
    }
    if (receipt.producer.registrationGeneration !== receipt.payload.registrationGeneration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["producer", "registrationGeneration"],
        message: "Readiness producer registration generation must match the attestation.",
      });
    }
    if (receipt.payload.observedAt !== receipt.observedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "observedAt"],
        message: "Readiness payload observation time must match the envelope.",
      });
    }
    if (!hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/runner-readiness/v1", [
      receipt.organizationId,
      receipt.payload.runnerId,
      String(receipt.payload.registrationGeneration),
      receipt.payload.readinessId,
    ])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity"], message: "Readiness identity tuple is invalid." });
    }
  });

export const AdmissionPolicySnapshotPayloadV1Schema = z
  .object({
    snapshotId: NonEmptyIdSchema,
    capturedAt: ControlTimestampSchema,
    tenant: z.object({ organizationId: NonEmptyIdSchema }).strict(),
    actor: z
      .object({
        provider: NonEmptyIdSchema,
        providerUserId: NonEmptyIdSchema,
        login: NonEmptyIdSchema,
        authorizationRef: NonEmptyIdSchema,
      })
      .strict(),
    target: z
      .object({
        projectTargetId: NonEmptyIdSchema,
        bindingId: NonEmptyIdSchema,
        providerRepositoryId: NonEmptyIdSchema,
        defaultBranch: NonEmptyIdSchema,
      })
      .strict(),
    runner: z.object({ runnerId: NonEmptyIdSchema, readinessReceiptDigest: ReceiptDigestSchema }).strict(),
    executor: z.object({ executorId: NonEmptyIdSchema, capabilityDigest: ReceiptDigestSchema }).strict(),
    requiredRelayCapabilities: RequiredRelayCapabilitiesSchema,
    admissionRules: z
      .object({
        profile: NonEmptyIdSchema,
        requiredCheckNames: sortedUniqueArray(NonEmptyIdSchema),
        mergeRequired: z.boolean(),
        humanApprovalRequiredFor: sortedUniqueArray(NonEmptyIdSchema),
      })
      .strict(),
  })
  .strict();

export const AdmissionPolicySnapshotReceiptEnvelopeV1Schema = z
  .object({
    ...ReceiptEnvelopeBaseShape,
    receiptKind: z.literal("admission_policy_snapshot"),
    runId: NonEmptyIdSchema,
    payload: AdmissionPolicySnapshotPayloadV1Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!receipt.requiredCapabilities.includes("relay.hosted-admission.v1")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredCapabilities"], message: "Hosted admission capability is required." });
    }
    if (receipt.producer.kind !== "cloud") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["producer", "kind"], message: "Cloud is the policy snapshot authority." });
    }
    if (
      receipt.payload.tenant.organizationId !== receipt.organizationId ||
      !hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/admission-policy-snapshot/v1", [
        receipt.organizationId,
        receipt.runId,
        receipt.payload.snapshotId,
      ])
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "tenant"], message: "Policy snapshot must be tenant scoped." });
    }
  });

export const WorkThreadRefPayloadV1Schema = z
  .object({
    workThreadId: NonEmptyIdSchema,
    sourceIdentityDigest: ReceiptDigestSchema,
    localCreationReceiptId: NonEmptyIdSchema,
    localCreationReceiptDigest: ReceiptDigestSchema,
    lineageKind: NonEmptyIdSchema,
    createdAt: ControlTimestampSchema,
  })
  .strict();

export const CompletionContractRefPayloadV1Schema = z
  .object({
    contractId: NonEmptyIdSchema,
    version: z.number().int().positive(),
    cycle: z.number().int().positive(),
    mode: z.enum(["execution_compat", "governed"]),
    contentDigest: ReceiptDigestSchema,
    resolvedTargetDigests: DigestSetSchema,
    requiredGateIds: sortedUniqueArray(NonEmptyIdSchema),
    createdAt: ControlTimestampSchema,
    supersedesContractId: NonEmptyIdSchema.optional(),
  })
  .strict();

const ContractAssessmentRefV1Schema = z
  .object({
    contractId: NonEmptyIdSchema,
    version: z.number().int().positive(),
    cycle: z.number().int().positive(),
    contentDigest: ReceiptDigestSchema,
  })
  .strict();

export const CompletionAssessmentPayloadV1Schema = z
  .object({
    assessmentId: NonEmptyIdSchema,
    workThreadId: NonEmptyIdSchema,
    contract: ContractAssessmentRefV1Schema,
    admissionPolicySnapshot: z.object({ snapshotId: NonEmptyIdSchema, digest: ReceiptDigestSchema }).strict(),
    runId: NonEmptyIdSchema,
    attempt: ReceiptAttemptRefV1Schema,
    assessmentInputDigest: ReceiptDigestSchema,
    evidenceReceiptDigests: DigestSetSchema,
    gateResults: z.array(
      z
        .object({
          gateId: NonEmptyIdSchema,
          state: z.enum(["pending", "satisfied", "unsatisfied", "blocked", "waived"]),
          reasonCode: CompletionReasonCodeSchema,
          evidenceReceiptDigests: DigestSetSchema,
        })
        .strict(),
    ),
    conclusion: z.enum(["pending", "satisfied", "unsatisfied", "blocked", "waived"]),
    assessedAt: ControlTimestampSchema,
    assessedBy: NonEmptyIdSchema,
    supersedesAssessmentId: NonEmptyIdSchema.optional(),
    waiver: z
      .object({
        ref: NonEmptyIdSchema,
        actorRef: NonEmptyIdSchema,
        reasonDigest: ReceiptDigestSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((assessment, ctx) => {
    if (assessment.conclusion === "waived" && assessment.waiver === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["waiver"], message: "A human waiver reference is required." });
    }
    if (assessment.conclusion !== "waived" && assessment.waiver !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["waiver"], message: "Waiver data is only valid for waived assessments." });
    }
  });

const GovernedReceiptEnvelopeShape = {
  ...ReceiptEnvelopeBaseShape,
  runId: NonEmptyIdSchema,
  workThreadId: NonEmptyIdSchema,
};

export const WorkThreadRefReceiptEnvelopeV1Schema = z
  .object({
    ...GovernedReceiptEnvelopeShape,
    receiptKind: z.literal("work_thread_ref"),
    payload: WorkThreadRefPayloadV1Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!receipt.requiredCapabilities.includes("relay.work-thread-ref.v1")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredCapabilities"], message: "WorkThread ref capability is required." });
    }
    if (
      receipt.producer.kind !== "local_opentag" ||
      receipt.payload.workThreadId !== receipt.workThreadId ||
      !hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/work-thread-ref/v1", [
        receipt.organizationId,
        receipt.runId,
        receipt.workThreadId,
      ])
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "WorkThread refs are locally authoritative and tenant scoped." });
    }
  });

export const CompletionContractRefReceiptEnvelopeV1Schema = z
  .object({
    ...GovernedReceiptEnvelopeShape,
    receiptKind: z.literal("completion_contract_ref"),
    payload: CompletionContractRefPayloadV1Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!receipt.requiredCapabilities.includes("relay.completion-contract-ref.v1")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredCapabilities"], message: "Completion contract ref capability is required." });
    }
    if (
      receipt.producer.kind !== "local_opentag" ||
      !hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/completion-contract-ref/v1", [
        receipt.organizationId,
        receipt.workThreadId,
        receipt.payload.contractId,
        String(receipt.payload.version),
        String(receipt.payload.cycle),
      ])
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["producer", "kind"], message: "Completion contracts remain locally authoritative." });
    }
  });

export const CompletionAssessmentReceiptEnvelopeV1Schema = z
  .object({
    ...GovernedReceiptEnvelopeShape,
    receiptKind: z.literal("completion_assessment"),
    attempt: ReceiptAttemptRefV1Schema,
    payload: CompletionAssessmentPayloadV1Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!receipt.requiredCapabilities.includes("relay.completion-assessment.v1")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredCapabilities"], message: "Completion assessment capability is required." });
    }
    if (receipt.producer.kind !== "local_opentag") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["producer", "kind"], message: "Completion assessments are locally authoritative." });
    }
    if (
      receipt.payload.runId !== receipt.runId ||
      receipt.payload.workThreadId !== receipt.workThreadId ||
      receipt.payload.attempt.attemptId !== receipt.attempt.attemptId ||
      receipt.payload.attempt.attemptNumber !== receipt.attempt.attemptNumber ||
      receipt.payload.attempt.epoch !== receipt.attempt.epoch ||
      receipt.payload.attempt.fencingTokenDigest !== receipt.attempt.fencingTokenDigest ||
      !hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/completion-assessment/v1", [
        receipt.organizationId,
        receipt.workThreadId,
        receipt.payload.assessmentId,
      ])
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "Assessment refs must match the envelope identity." });
    }
  });

export const CallbackIntentObservationPayloadV1Schema = z
  .object({
    localIntentId: NonEmptyIdSchema,
    assessmentRef: NonEmptyIdSchema,
    assessmentDigest: ReceiptDigestSchema,
    provider: NonEmptyIdSchema,
    sourceThreadIdentityDigest: ReceiptDigestSchema,
    operationId: NonEmptyIdSchema,
    payloadDigest: ReceiptDigestSchema,
    createdAt: ControlTimestampSchema,
  })
  .strict();

export const CallbackAttemptObservationPayloadV1Schema = z
  .object({
    localIntentId: NonEmptyIdSchema,
    localAttemptId: NonEmptyIdSchema,
    attemptNumber: z.number().int().positive(),
    requestDigest: ReceiptDigestSchema,
    outcome: z.enum(["accepted", "rejected", "outcome_unknown"]),
    reasonCode: CallbackObservationReasonCodeV1Schema,
    nextAction: NonEmptyIdSchema.optional(),
    owner: NonEmptyIdSchema.optional(),
    attemptedAt: ControlTimestampSchema,
    observedAt: ControlTimestampSchema,
  })
  .strict()
  .superRefine((observation, ctx) => {
    const compatibleReasonCodes = {
      accepted: ["provider_accepted"],
      rejected: ["provider_rejected"],
      outcome_unknown: ["provider_receipt_missing", "provider_timeout"],
    } as const;
    if (!(compatibleReasonCodes[observation.outcome] as readonly string[]).includes(observation.reasonCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCode"],
        message: "Callback attempt reason code is incompatible with its outcome.",
      });
    }
    if (observation.outcome === "outcome_unknown" && (!observation.nextAction || !observation.owner)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "Unknown callback attempts require a next action and owner.",
      });
    }
    if (Date.parse(observation.observedAt) < Date.parse(observation.attemptedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedAt"],
        message: "Callback observation cannot precede the attempt.",
      });
    }
  });

export const CallbackProviderObservationPayloadV1Schema = z
  .object({
    localIntentId: NonEmptyIdSchema,
    localAttemptId: NonEmptyIdSchema,
    providerReceiptId: NonEmptyIdSchema,
    resourceIdentity: NonEmptyIdSchema,
    outcome: z.enum(["succeeded", "failed", "outcome_unknown"]),
    observedAt: ControlTimestampSchema,
    reasonCode: CallbackObservationReasonCodeV1Schema.optional(),
    nextAction: NonEmptyIdSchema.optional(),
    owner: NonEmptyIdSchema.optional(),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const compatibleReasonCodes = {
      succeeded: ["provider_accepted"],
      failed: ["provider_error", "provider_rejected"],
      outcome_unknown: ["provider_receipt_missing", "provider_timeout"],
    } as const;
    if (
      observation.reasonCode !== undefined &&
      !(compatibleReasonCodes[observation.outcome] as readonly string[]).includes(observation.reasonCode)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCode"],
        message: "Callback provider reason code is incompatible with its outcome.",
      });
    }
    if (observation.outcome === "outcome_unknown" && (!observation.reasonCode || !observation.nextAction || !observation.owner)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "Unknown callback outcomes require a reason, next action, and owner.",
      });
    }
  });

function callbackEnvelope<const TReceiptKind extends string, TPayload extends z.ZodType>(
  receiptKind: TReceiptKind,
  payload: TPayload,
) {
  return z
    .object({
      ...GovernedReceiptEnvelopeShape,
      receiptKind: z.literal(receiptKind),
      payload,
    })
    .strict()
    .superRefine((receipt, ctx) => {
      if (!receipt.requiredCapabilities.includes("relay.callback-observation.v1")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredCapabilities"], message: "Callback observation capability is required." });
      }
      if (receipt.producer.kind !== "local_opentag") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["producer", "kind"], message: "Callback observations are locally authoritative." });
      }
    });
}

export const CallbackIntentObservationReceiptEnvelopeV1Schema = callbackEnvelope(
  "callback_intent_observation",
  CallbackIntentObservationPayloadV1Schema,
).superRefine((receipt, ctx) => {
  if (!hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/callback-intent-observation/v1", [
    receipt.organizationId,
    receipt.workThreadId,
    receipt.payload.localIntentId,
  ])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity"], message: "Callback intent identity tuple is invalid." });
  }
  if (receipt.payload.operationId !== receipt.operationId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "operationId"], message: "Callback operation identity must match the envelope." });
  }
});
export const CallbackAttemptObservationReceiptEnvelopeV1Schema = callbackEnvelope(
  "callback_attempt_observation",
  CallbackAttemptObservationPayloadV1Schema,
).superRefine((receipt, ctx) => {
  if (!hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/callback-attempt-observation/v1", [
    receipt.organizationId,
    receipt.workThreadId,
    receipt.payload.localIntentId,
    receipt.payload.localAttemptId,
  ])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity"], message: "Callback attempt identity tuple is invalid." });
  }
  if (receipt.payload.observedAt !== receipt.observedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "observedAt"],
      message: "Callback attempt observation time must match the envelope.",
    });
  }
});
export const CallbackProviderObservationReceiptEnvelopeV1Schema = callbackEnvelope(
  "callback_provider_observation",
  CallbackProviderObservationPayloadV1Schema,
).superRefine((receipt, ctx) => {
  if (!hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/callback-provider-observation/v1", [
    receipt.organizationId,
    receipt.workThreadId,
    receipt.payload.localIntentId,
    receipt.payload.localAttemptId,
    receipt.payload.providerReceiptId,
  ])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity"], message: "Callback provider identity tuple is invalid." });
  }
  if (receipt.payload.observedAt !== receipt.observedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "observedAt"],
      message: "Callback provider observation time must match the envelope.",
    });
  }
});

export type RelayCapability = z.infer<typeof RelayCapabilitySchema>;
export type ControlMutationRequestV1 = z.infer<typeof ControlMutationRequestV1Schema>;
export type RunnerRegistrationRequestV1 = z.infer<typeof RunnerRegistrationRequestV1Schema>;
export type RunnerCredentialReprovisionRequestV1 = z.infer<typeof RunnerCredentialReprovisionRequestV1Schema>;
export type RunnerCredentialMetadataV1 = z.infer<typeof RunnerCredentialMetadataV1Schema>;
export type RunnerCredentialResponseV1 = z.infer<typeof RunnerCredentialResponseV1Schema>;
export type RunnerCredentialRotationRequestV1 = z.infer<typeof RunnerCredentialRotationRequestV1Schema>;
export type RunnerCredentialRevocationRequestV1 = z.infer<typeof RunnerCredentialRevocationRequestV1Schema>;
export type RunnerCredentialRotationResponseV1 = z.infer<typeof RunnerCredentialRotationResponseV1Schema>;
export type RunnerCredentialRevocationResponseV1 = z.infer<typeof RunnerCredentialRevocationResponseV1Schema>;
export type RunnerCredentialCurrentStateResponseV1 = z.infer<
  typeof RunnerCredentialCurrentStateResponseV1Schema
>;
export type RunnerReadinessReceiptEnvelopeV1 = z.infer<typeof RunnerReadinessReceiptEnvelopeV1Schema>;
export type AdmissionPolicySnapshotReceiptEnvelopeV1 = z.infer<typeof AdmissionPolicySnapshotReceiptEnvelopeV1Schema>;
export type WorkThreadRefReceiptEnvelopeV1 = z.infer<typeof WorkThreadRefReceiptEnvelopeV1Schema>;
export type CompletionContractRefReceiptEnvelopeV1 = z.infer<typeof CompletionContractRefReceiptEnvelopeV1Schema>;
export type CompletionAssessmentReceiptEnvelopeV1 = z.infer<typeof CompletionAssessmentReceiptEnvelopeV1Schema>;
