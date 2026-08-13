import {
  isCredentialSafeText,
} from '@opentag/core';
import { z } from 'zod';

export const DELIVERY_DIGEST_DOMAINS = {
  intentProjection: 'opentag.delivery.intent-projection.v2',
  attemptObservation: 'opentag.delivery.attempt-observation.v2',
  providerObservation: 'opentag.delivery.provider-observation.v2',
  authorizationClaims: 'opentag.delivery.authorization-claims.v2',
  authorizationEnvelope: 'opentag.delivery.authorization-envelope.v2',
  localBeginOutcomeReceipt: 'opentag.delivery.local-begin-outcome-receipt.v2',
  publicKeySet: 'opentag.delivery.public-key-set.v2',
} as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const safeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine(isCredentialSafeText, 'Identifier contains credential-like data.');
const opaqueId = z
  .string()
  .min(1)
  .max(512)
  .refine((value: string) => isCredentialSafeText(value), 'Opaque identifier contains credential-like data.')
  .refine(
    (value) =>
      !value.includes('/') &&
      !value.includes('\\') &&
      !/[?#]/u.test(value) &&
      !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value),
    'Opaque identifier must not be a URI or local path.',
  );
const positiveInteger = z.number().int().positive();
const timestamp = z.string().datetime({ offset: true });
function canonicalBase64Url(byteLength: number) {
  return z.string().refine((value) => {
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length !== Math.ceil(byteLength * 4 / 3)) return false;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const finalValue = alphabet.indexOf(value.at(-1) ?? '');
    const remainder = byteLength % 3;
    return remainder === 0 || (remainder === 1 ? (finalValue & 15) === 0 : (finalValue & 3) === 0);
  }, `Expected canonical base64url for ${byteLength} bytes.`);
}

export const EstablishedProviderBindingV1Schema = z
  .object({
    bindingKind: z.literal('established'),
    providerId: safeId,
    providerInstanceId: opaqueId,
    connectionId: safeId.optional(),
    connectionIdDigest: digest.optional(),
    providerPrincipalDigest: digest,
    principalAssurance: z.enum(['provider_verified', 'configured_declared']),
    providerConfigGeneration: positiveInteger,
    providerConfigGenerationDigest: digest,
    lifecycle: z.literal('active'),
    bindingDigest: digest,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.connectionId === undefined) !== (value.connectionIdDigest === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'connectionId and connectionIdDigest must appear together.',
      });
    }
  });

export const ProvisioningProviderBindingV1Schema = z
  .object({
    bindingKind: z.literal('provisioning'),
    providerId: safeId,
    providerInstanceId: opaqueId,
    connectionId: safeId.optional(),
    connectionIdDigest: digest.optional(),
    installationId: safeId,
    runtimeGeneration: positiveInteger,
    providerApplicationDigest: digest,
    providerTenantDigest: digest,
    installationRequestDigest: digest,
    credentialSlotDigest: digest,
    provisioningRevision: positiveInteger,
    expectedPriorPrincipalDigest: z.null(),
    expectedPriorConfigGeneration: z.literal(0),
    lifecycle: z.literal('provisioning'),
    bindingDigest: digest,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.connectionId === undefined) !== (value.connectionIdDigest === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'connectionId and connectionIdDigest must appear together.',
      });
    }
  });

export const ProviderBindingV1Schema = z.union([
  EstablishedProviderBindingV1Schema,
  ProvisioningProviderBindingV1Schema,
]);

const BusinessProvenanceSchema = z
  .object({
    kind: z.literal('business'),
    repositoryIdentityDigest: digest,
    runId: safeId,
    authorityLineageDigest: digest,
  })
  .strict();

const SourceThreadControlProvenanceSchema = z
  .object({
    kind: z.literal('source_thread_control'),
    providerInstanceId: opaqueId,
    inboundEventDigest: digest,
    sourceThreadDigest: digest,
    providerBindingDigest: digest,
    installationId: safeId,
    runtimeGeneration: positiveInteger,
    scopeId: opaqueId,
  })
  .strict();

const ProviderInstanceProvenanceSchema = z
  .object({
    kind: z.literal('provider_instance'),
    installationId: safeId,
    runtimeGeneration: positiveInteger,
  })
  .strict();

const ScopeSchema = z
  .object({
    kind: z.enum(['hosted_control', 'local_repository', 'provider_instance']),
    id: opaqueId,
  })
  .strict();

const businessEnvelope = {
  contractVersion: z.literal(2),
  sideEffectIntentId: safeId,
  causalId: safeId,
  provenance: BusinessProvenanceSchema,
  providerBinding: EstablishedProviderBindingV1Schema,
  targetDigest: digest,
  authorityKind: z.enum(['run_authority', 'hosted_send_authority']),
  authoritySnapshotDigest: digest,
  evidencePolicy: z.enum(['local_audit', 'hosted_control']),
  idempotencyKey: safeId,
  scope: ScopeSchema,
  createdAt: timestamp,
  initialAttemptSequence: positiveInteger,
};

function assertBusinessEnvelope(
  value: {
    evidencePolicy: 'local_audit' | 'hosted_control';
    authorityKind: 'run_authority' | 'hosted_send_authority';
    scope: { kind: 'hosted_control' | 'local_repository' | 'provider_instance' };
  },
  context: z.RefinementCtx,
): void {
  if (value.scope.kind === 'provider_instance') {
    context.addIssue({ code: 'custom', message: 'Business intent requires repository or Hosted scope.' });
  }
  const hosted = value.evidencePolicy === 'hosted_control';
  if (
    hosted !== (value.authorityKind === 'hosted_send_authority') ||
    hosted !== (value.scope.kind === 'hosted_control')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Hosted evidence, authority, and scope must be selected together.',
    });
  }
}

const BusinessDeliveryIntentV2Schema = z
  .object({
    ...businessEnvelope,
    intentKind: z.literal('delivery'),
    operation: z.enum(['create', 'update']),
    deliveryKind: z.enum(['message', 'reaction']),
    presentationDigest: digest,
    statusMessageId: safeId.optional(),
  })
  .strict()
  .superRefine(assertBusinessEnvelope);

const SourceThreadControlDeliveryIntentV2Schema = z
  .object({
    contractVersion: z.literal(2), sideEffectIntentId: safeId, causalId: safeId,
    intentKind: z.literal('delivery'),
    operation: z.literal('control_reply'),
    deliveryKind: z.literal('message'), presentationDigest: digest,
    provenance: SourceThreadControlProvenanceSchema,
    providerBinding: EstablishedProviderBindingV1Schema, targetDigest: digest,
    authorityKind: z.literal('local_source_thread_control'),
    authoritySnapshotDigest: digest, evidencePolicy: z.literal('local_audit'),
    idempotencyKey: safeId,
    scope: z.object({ kind: z.literal('provider_instance'), id: opaqueId }).strict(),
    createdAt: timestamp, initialAttemptSequence: positiveInteger,
    installationId: safeId, runtimeGeneration: positiveInteger,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.provenance.providerInstanceId !== value.providerBinding.providerInstanceId ||
      value.provenance.providerBindingDigest !== value.providerBinding.bindingDigest ||
      value.provenance.installationId !== value.installationId ||
      value.provenance.runtimeGeneration !== value.runtimeGeneration ||
      value.provenance.scopeId !== value.scope.id
    ) context.addIssue({ code: 'custom', message: 'Source-thread provenance must bind the active provider instance.' });
  });

export const DeliveryIntentV2Schema = z.union([
  BusinessDeliveryIntentV2Schema,
  SourceThreadControlDeliveryIntentV2Schema,
]);

export const MaterialActionIntentV2Schema = z
  .object({
    ...businessEnvelope,
    intentKind: z.literal('material_action'),
    operation: safeId,
    reviewedMaterialSelectorDigest: digest,
    materialDigest: digest,
  })
  .strict()
  .superRefine(assertBusinessEnvelope);

export const ReadbackIntentV2Schema = z
  .object({
    ...businessEnvelope,
    intentKind: z.literal('readback'),
    operation: z.enum(['read', 'reconcile']),
    authoritativeReadSelectorDigest: digest,
    priorAttemptId: safeId,
    priorResourceDigest: digest,
  })
  .strict()
  .superRefine(assertBusinessEnvelope);

const credentialEnvelope = {
  contractVersion: z.literal(2),
  sideEffectIntentId: safeId,
  causalId: safeId,
  intentKind: z.literal('credential_refresh'),
  provenance: ProviderInstanceProvenanceSchema,
  targetDigest: digest,
  authorityKind: z.literal('provider_instance_authority'),
  authoritySnapshotDigest: digest,
  evidencePolicy: z.enum(['local_audit', 'hosted_control']),
  idempotencyKey: safeId,
  scope: ScopeSchema,
  createdAt: timestamp,
  initialAttemptSequence: positiveInteger,
  installationId: safeId,
  runtimeGeneration: positiveInteger,
  providerApplicationDigest: digest,
  providerTenantDigest: digest,
  installationRequestDigest: digest,
  credentialSlotDigest: digest,
  singleFlightKey: safeId,
};

const CredentialAcquireIntentV2Schema = z
  .object({
    ...credentialEnvelope,
    operation: z.literal('acquire'),
    providerBinding: ProvisioningProviderBindingV1Schema,
    expectedPriorPrincipalDigest: z.null(),
    expectedPriorConfigGeneration: z.literal(0),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope.kind !== 'provider_instance' || value.evidencePolicy !== 'local_audit') {
      context.addIssue({ code: 'custom', message: 'Credential acquisition requires local provider-instance scope.' });
    }
    if (
      value.installationId !== value.provenance.installationId ||
      value.runtimeGeneration !== value.provenance.runtimeGeneration ||
      value.installationId !== value.providerBinding.installationId ||
      value.runtimeGeneration !== value.providerBinding.runtimeGeneration
    ) {
      context.addIssue({ code: 'custom', message: 'Acquire provenance and binding must match.' });
    }
  });

const CredentialRefreshExistingIntentV2Schema = z
  .object({
    ...credentialEnvelope,
    operation: z.literal('refresh'),
    providerBinding: EstablishedProviderBindingV1Schema,
    expectedPriorPrincipalDigest: digest,
    expectedPriorConfigGeneration: positiveInteger,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope.kind !== 'provider_instance' || value.evidencePolicy !== 'local_audit') {
      context.addIssue({ code: 'custom', message: 'Credential refresh requires local provider-instance scope.' });
    }
    if (
      value.installationId !== value.provenance.installationId ||
      value.runtimeGeneration !== value.provenance.runtimeGeneration ||
      value.expectedPriorPrincipalDigest !== value.providerBinding.providerPrincipalDigest ||
      value.expectedPriorConfigGeneration !== value.providerBinding.providerConfigGeneration
    ) {
      context.addIssue({ code: 'custom', message: 'Refresh must bind the exact prior principal and generation.' });
    }
  });

export const CredentialRefreshIntentV2Schema = z.union([
  CredentialAcquireIntentV2Schema,
  CredentialRefreshExistingIntentV2Schema,
]);

export const SideEffectIntentV2Schema = z.union([
  DeliveryIntentV2Schema,
  MaterialActionIntentV2Schema,
  ReadbackIntentV2Schema,
  CredentialRefreshIntentV2Schema,
]);

const observationEnvelope = {
  contractVersion: z.literal(2),
  observationId: safeId,
  sideEffectIntentId: safeId,
  scope: ScopeSchema,
  recordedAt: timestamp,
};

export const HostedDeliveryAuthorizationClaimsV2Schema = z
  .object({
    issuer: safeId,
    audience: safeId,
    signingKeyId: safeId,
    authorityKind: z.literal('hosted_delivery_authorization'),
    keyUse: z.literal('opentag_hosted_provider_io_authorization_v2'),
    signatureAlgorithm: z.literal('Ed25519'),
    contractVersion: z.literal(2),
    deploymentVersion: safeId,
    capabilityVersion: safeId,
    operationGateEpoch: positiveInteger,
    cutoverId: safeId,
    canaryAllowlistDigest: digest,
    publicKeySetDigest: digest,
    installationId: safeId,
    scope: ScopeSchema,
    destinationId: safeId,
    organizationId: safeId,
    runnerPrincipalDigest: digest,
    runnerGeneration: positiveInteger,
    runId: safeId,
    workThreadId: safeId,
    hostedAttemptId: safeId,
    hostedAttemptFenceDigest: digest,
    completionAssessmentDigest: digest,
    completionPredecessorDigest: digest,
    authoritySnapshotDigest: digest,
    sourceRowId: safeId,
    sideEffectIntentId: safeId,
    causalId: safeId,
    localAttemptTokenId: safeId,
    initialAttemptSequence: positiveInteger,
    attemptId: safeId,
    attemptSequence: positiveInteger,
    localAttemptRevision: positiveInteger,
    localAttemptLeaseFenceDigest: digest,
    idempotencyKey: safeId,
    providerId: safeId,
    providerInstanceId: opaqueId,
    sqliteIdentityDigest: digest,
    deliveryId: safeId,
    connectionId: safeId.optional(),
    connectionIdDigest: digest.optional(),
    providerPrincipalDigest: digest,
    principalAssurance: z.literal('provider_verified'),
    providerBindingDigest: digest,
    providerConfigGeneration: positiveInteger,
    providerConfigGenerationDigest: digest,
    targetDigest: digest,
    operationDigest: digest,
    presentationDigest: digest,
    sideEffectApprovalId: safeId,
    sideEffectApprovalTupleDigest: digest,
    maxClockSkewMs: z.number().int().min(0).max(30_000),
    issuedAt: timestamp,
    expiresAt: timestamp,
    tokenId: safeId,
    nonce: canonicalBase64Url(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope.kind !== 'hosted_control') {
      context.addIssue({ code: 'custom', message: 'Hosted authorization requires hosted_control scope.' });
    }
    const issuedAt = Date.parse(value.issuedAt);
    const expiresAt = Date.parse(value.expiresAt);
    if (!(issuedAt < expiresAt && expiresAt - issuedAt <= 30_000)) {
      context.addIssue({ code: 'custom', message: 'Hosted authorization expiry must be after issue and at most 30 seconds.' });
    }
    if ((value.connectionId === undefined) !== (value.connectionIdDigest === undefined)) {
      context.addIssue({ code: 'custom', message: 'connectionId and connectionIdDigest must appear together.' });
    }
  });

export const HostedDeliveryAuthorizationV2Schema = z
  .object({
    protectedClaims: HostedDeliveryAuthorizationClaimsV2Schema,
    protectedClaimsDigest: digest,
    authorizationDigest: digest,
    publicKeyId: safeId,
    signature: canonicalBase64Url(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.publicKeyId !== value.protectedClaims.signingKeyId) {
      context.addIssue({ code: 'custom', message: 'publicKeyId must equal the protected signingKeyId.' });
    }
  });

export const LocalBeginOutcomeReceiptV2Schema = z
  .object({
    tokenId: safeId,
    authorizationDigest: digest,
    localAttemptTokenId: safeId,
    sideEffectApprovalId: safeId,
    sideEffectApprovalTupleDigest: digest,
    operationGateEpoch: positiveInteger,
    canaryAllowlistDigest: digest,
    installationId: safeId,
    scope: ScopeSchema,
    sideEffectIntentId: safeId,
    attemptId: safeId,
    attemptSequence: positiveInteger,
    localAttemptRevision: positiveInteger,
    localAttemptLeaseFenceDigest: digest,
    providerInstanceId: opaqueId,
    providerId: safeId,
    providerPrincipalDigest: digest,
    principalAssurance: z.literal('provider_verified'),
    providerBindingDigest: digest,
    providerConfigGeneration: positiveInteger,
    providerConfigGenerationDigest: digest,
    providerIoBegun: z.literal(true),
    providerIoBegunAt: timestamp,
    installationBeginMarkerId: safeId,
    installationBeginMarkerDigest: digest,
    scopeBeginMarkerId: safeId,
    scopeBeginMarkerDigest: digest,
    outcome: z.enum(['accepted', 'rejected', 'outcome_unknown', 'attention']),
    outcomeRecordedAt: timestamp,
    evidenceDigest: digest,
    receiptDigest: digest,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope.kind !== 'hosted_control') {
      context.addIssue({ code: 'custom', message: 'Hosted receipt requires hosted_control scope.' });
    }
    if (!(Date.parse(value.providerIoBegunAt) <= Date.parse(value.outcomeRecordedAt))) {
      context.addIssue({ code: 'custom', message: 'Provider I/O begin must not follow outcome recording.' });
    }
  });

const HostedObservationLineageV2Schema = z
  .object({
    authorization: HostedDeliveryAuthorizationV2Schema,
    receipt: LocalBeginOutcomeReceiptV2Schema,
  })
  .strict();

function assertHostedLineage(
  value: { scope: { kind: string }; hostedLineage?: unknown },
  context: z.RefinementCtx,
): void {
  const hosted = value.scope.kind === 'hosted_control';
  if (hosted !== (value.hostedLineage !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Hosted scope requires exact Hosted authorization lineage; local scope forbids it.' });
  }
}

function isWithinSignedAuthorizationWindow(
  providerIoBegunAt: string,
  claims: z.infer<typeof HostedDeliveryAuthorizationClaimsV2Schema>,
): boolean {
  const begunAt = Date.parse(providerIoBegunAt);
  return begunAt >= Date.parse(claims.issuedAt) - claims.maxClockSkewMs &&
    begunAt <= Date.parse(claims.expiresAt) + claims.maxClockSkewMs;
}

function hostedIdentityMatches(
  value: {
    scope: { kind: string; id: string };
    sideEffectIntentId: string;
    installationId?: string | undefined;
  },
  claims: z.infer<typeof HostedDeliveryAuthorizationClaimsV2Schema>,
  receipt: z.infer<typeof LocalBeginOutcomeReceiptV2Schema>,
): boolean {
  return claims.scope.kind === value.scope.kind &&
    claims.scope.id === value.scope.id &&
    receipt.scope.kind === value.scope.kind &&
    receipt.scope.id === value.scope.id &&
    claims.sideEffectIntentId === value.sideEffectIntentId &&
    receipt.sideEffectIntentId === value.sideEffectIntentId &&
    claims.installationId === receipt.installationId &&
    (value.installationId === undefined ||
      (claims.installationId === value.installationId &&
        receipt.installationId === value.installationId));
}

function assertHostedCrossFields(
  value: {
    scope: { kind: string; id: string }; sideEffectIntentId: string; attemptId: string;
    attemptSequence?: number | undefined; providerId?: string | undefined;
    providerInstanceId?: string | undefined; authoritySnapshotDigest: string;
    providerConfigGeneration: number; providerConfigGenerationDigest: string;
    beginMarkerId: string; beginMarkerDigest: string; outcome: string;
    evidenceDigest: string;
    hostedLineage: z.infer<typeof HostedObservationLineageV2Schema>;
  },
  context: z.RefinementCtx,
): void {
  assertHostedLineage(value, context);
  const claims = value.hostedLineage.authorization.protectedClaims;
  const receipt = value.hostedLineage.receipt;
  if (
    !hostedIdentityMatches(value, claims, receipt) ||
    receipt.attemptId !== value.attemptId || claims.tokenId !== receipt.tokenId ||
    value.hostedLineage.authorization.authorizationDigest !== receipt.authorizationDigest ||
    claims.localAttemptTokenId !== receipt.localAttemptTokenId ||
    claims.authoritySnapshotDigest !== value.authoritySnapshotDigest ||
    claims.attemptId !== receipt.attemptId ||
    claims.attemptSequence !== receipt.attemptSequence ||
    claims.localAttemptRevision !== receipt.localAttemptRevision ||
    claims.localAttemptLeaseFenceDigest !== receipt.localAttemptLeaseFenceDigest ||
    (value.attemptSequence !== undefined && receipt.attemptSequence !== value.attemptSequence) ||
    (value.providerId !== undefined && claims.providerId !== value.providerId) ||
    (value.providerInstanceId !== undefined && claims.providerInstanceId !== value.providerInstanceId) ||
    claims.providerInstanceId !== receipt.providerInstanceId ||
    claims.providerId !== receipt.providerId ||
    claims.providerPrincipalDigest !== receipt.providerPrincipalDigest ||
    claims.principalAssurance !== receipt.principalAssurance ||
    claims.providerBindingDigest !== receipt.providerBindingDigest ||
    claims.providerConfigGeneration !== value.providerConfigGeneration ||
    claims.providerConfigGenerationDigest !== value.providerConfigGenerationDigest ||
    receipt.providerConfigGeneration !== value.providerConfigGeneration ||
    receipt.providerConfigGenerationDigest !== value.providerConfigGenerationDigest ||
    claims.operationGateEpoch !== receipt.operationGateEpoch ||
    claims.canaryAllowlistDigest !== receipt.canaryAllowlistDigest ||
    claims.sideEffectApprovalId !== receipt.sideEffectApprovalId ||
    claims.sideEffectApprovalTupleDigest !== receipt.sideEffectApprovalTupleDigest ||
    !isWithinSignedAuthorizationWindow(receipt.providerIoBegunAt, claims) ||
    receipt.scopeBeginMarkerId !== value.beginMarkerId || receipt.scopeBeginMarkerDigest !== value.beginMarkerDigest ||
    receipt.outcome !== value.outcome || receipt.evidenceDigest !== value.evidenceDigest
  ) {
    context.addIssue({ code: 'custom', message: 'Hosted authorization and local receipt do not match the observation.' });
  }
}

const CloudIntentProjectionV2Schema = z
  .object({
    intentKind: z.enum(['delivery', 'material_action', 'readback']),
    operation: safeId,
    providerId: safeId,
    providerInstanceId: opaqueId,
    targetDigest: digest,
    authoritySnapshotDigest: digest,
    evidencePolicy: z.literal('hosted_control'),
    initialAttemptSequence: positiveInteger,
  })
  .strict();

export const HostedCloudIntentObservationV2Schema = z
  .object({
    ...observationEnvelope,
    observationKind: z.literal('intent'),
    scope: z.object({ kind: z.literal('hosted_control'), id: opaqueId }).strict(),
    installationId: safeId,
    intent: CloudIntentProjectionV2Schema,
    intentDigest: digest,
    hostedLineage: HostedObservationLineageV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const claims = value.hostedLineage.authorization.protectedClaims;
    const receipt = value.hostedLineage.receipt;
    if (
      !hostedIdentityMatches(value, claims, receipt) ||
      claims.providerId !== value.intent.providerId ||
      claims.providerInstanceId !== value.intent.providerInstanceId ||
      claims.targetDigest !== value.intent.targetDigest ||
      claims.authoritySnapshotDigest !== value.intent.authoritySnapshotDigest ||
      claims.initialAttemptSequence !== value.intent.initialAttemptSequence ||
      claims.tokenId !== receipt.tokenId ||
      claims.localAttemptTokenId !== receipt.localAttemptTokenId ||
      claims.attemptId !== receipt.attemptId ||
      claims.attemptSequence !== receipt.attemptSequence ||
      claims.localAttemptRevision !== receipt.localAttemptRevision ||
      claims.localAttemptLeaseFenceDigest !== receipt.localAttemptLeaseFenceDigest ||
      claims.providerId !== receipt.providerId ||
      claims.providerInstanceId !== receipt.providerInstanceId ||
      claims.providerPrincipalDigest !== receipt.providerPrincipalDigest ||
      claims.principalAssurance !== receipt.principalAssurance ||
      claims.providerBindingDigest !== receipt.providerBindingDigest ||
      claims.providerConfigGeneration !== receipt.providerConfigGeneration ||
      claims.providerConfigGenerationDigest !== receipt.providerConfigGenerationDigest ||
      claims.operationGateEpoch !== receipt.operationGateEpoch ||
      claims.canaryAllowlistDigest !== receipt.canaryAllowlistDigest ||
      claims.sideEffectApprovalId !== receipt.sideEffectApprovalId ||
      claims.sideEffectApprovalTupleDigest !== receipt.sideEffectApprovalTupleDigest ||
      value.hostedLineage.authorization.authorizationDigest !== receipt.authorizationDigest ||
      !isWithinSignedAuthorizationWindow(receipt.providerIoBegunAt, claims)
    ) {
      context.addIssue({ code: 'custom', message: 'Hosted authorization does not match the intent observation.' });
    }
  });

const LocalIntentProjectionV2Schema = z
  .object({
    intentKind: z.enum(['delivery', 'material_action', 'readback', 'credential_refresh']),
    operation: safeId,
    providerId: safeId,
    providerInstanceId: opaqueId,
    targetDigest: digest,
    authoritySnapshotDigest: digest,
    evidencePolicy: z.literal('local_audit'),
    initialAttemptSequence: positiveInteger,
  })
  .strict();

const LocalSanitizedIntentObservationV2Schema = z
  .object({
    ...observationEnvelope,
    observationKind: z.literal('intent'),
    scope: z.object({ kind: z.enum(['local_repository', 'provider_instance']), id: opaqueId }).strict(),
    intent: LocalIntentProjectionV2Schema,
    intentDigest: digest,
  })
  .strict();

export const HostedCloudAttemptObservationV2Schema = z
  .object({
    ...observationEnvelope,
    observationKind: z.literal('attempt'),
    scope: z.object({ kind: z.literal('hosted_control'), id: opaqueId }).strict(),
    attemptId: safeId,
    attemptSequence: positiveInteger,
    intentDigest: digest,
    authoritySnapshotDigest: digest,
    beginMarkerId: safeId,
    beginMarkerDigest: digest,
    providerConfigGeneration: positiveInteger,
    providerConfigGenerationDigest: digest,
    hostedLineage: HostedObservationLineageV2Schema,
    attemptDigest: digest,
    outcome: z.enum(['accepted', 'rejected', 'outcome_unknown', 'attention']),
    evidenceDigest: digest,
  })
  .strict()
  .superRefine(assertHostedCrossFields);

export const HostedCloudProviderObservationV2Schema = z
  .object({
    ...observationEnvelope,
    observationKind: z.literal('provider'),
    scope: z.object({ kind: z.literal('hosted_control'), id: opaqueId }).strict(),
    attemptId: safeId,
    providerId: safeId,
    providerInstanceId: opaqueId,
    intentDigest: digest,
    attemptDigest: digest,
    authoritySnapshotDigest: digest,
    beginMarkerId: safeId,
    beginMarkerDigest: digest,
    providerConfigGeneration: positiveInteger,
    providerConfigGenerationDigest: digest,
    hostedLineage: HostedObservationLineageV2Schema,
    providerObservationDigest: digest,
    outcome: z.enum(['accepted', 'rejected', 'outcome_unknown', 'attention']),
    evidenceDigest: digest,
    externalResourceDigest: digest.optional(),
  })
  .strict()
  .superRefine(assertHostedCrossFields);

export const HostedCloudDeliveryObservationV2Schema = z
  .union([
    HostedCloudIntentObservationV2Schema,
    HostedCloudAttemptObservationV2Schema,
    HostedCloudProviderObservationV2Schema,
  ]);
export const CloudIntentObservationV2Schema = HostedCloudIntentObservationV2Schema;
export const CloudAttemptObservationV2Schema = HostedCloudAttemptObservationV2Schema;
export const CloudProviderObservationV2Schema = HostedCloudProviderObservationV2Schema;
export const CloudDeliveryObservationV2Schema = HostedCloudDeliveryObservationV2Schema;
export const SanitizedDeliveryObservationV2Schema = z.union([
  HostedCloudDeliveryObservationV2Schema,
  LocalSanitizedIntentObservationV2Schema,
]);

export type EstablishedProviderBindingV1 = z.infer<typeof EstablishedProviderBindingV1Schema>;
export type ProvisioningProviderBindingV1 = z.infer<typeof ProvisioningProviderBindingV1Schema>;
export type DeliveryIntentV2 = z.infer<typeof DeliveryIntentV2Schema>;
export type MaterialActionIntentV2 = z.infer<typeof MaterialActionIntentV2Schema>;
export type ReadbackIntentV2 = z.infer<typeof ReadbackIntentV2Schema>;
export type CredentialRefreshIntentV2 = z.infer<typeof CredentialRefreshIntentV2Schema>;
export type SideEffectIntentV2 = z.infer<typeof SideEffectIntentV2Schema>;
export type CloudDeliveryObservationV2 = z.infer<typeof CloudDeliveryObservationV2Schema>;
export type HostedCloudDeliveryObservationV2 = z.infer<typeof HostedCloudDeliveryObservationV2Schema>;
export type SanitizedDeliveryObservationV2 = z.infer<typeof SanitizedDeliveryObservationV2Schema>;
export type HostedDeliveryAuthorizationV2 = z.infer<typeof HostedDeliveryAuthorizationV2Schema>;
export type HostedDeliveryAuthorizationClaimsV2 = z.infer<typeof HostedDeliveryAuthorizationClaimsV2Schema>;
export type LocalBeginOutcomeReceiptV2 = z.infer<typeof LocalBeginOutcomeReceiptV2Schema>;
