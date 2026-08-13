import { describe, expect, it } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as contract from '../src/index.js';
import { nodeSha256DigestProvider } from '../src/node.js';

const semanticDigest = (domain: string, value: unknown) =>
  nodeSha256DigestProvider.sha256(contract.domainSeparatedCanonicalBytes(domain, value)) as string;

const digest = `sha256:${'b'.repeat(64)}`;
const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(
  new URL(`../fixtures/relay.delivery-observation.v2/${name}`, import.meta.url),
), 'utf8'));
const validHostedProvider = fixture('06-provider.json');
const validHostedIntent = fixture('01-delivery-intent.json');
const fixtureManifest = fixture('manifest.json');
const safe = {
  contractVersion: 2,
  observationKind: 'provider',
  observationId: 'provider_observation_01',
  sideEffectIntentId: 'intent_01',
  attemptId: 'attempt_01',
  providerId: 'github',
  providerInstanceId: 'instance-01',
  scope: { kind: 'local_repository', id: digest },
  outcome: 'accepted',
  evidenceDigest: digest,
  externalResourceDigest: digest,
  recordedAt: '2026-08-13T00:00:00.000Z',
};
const safeWithDigest = {
  ...safe,
  intentDigest: digest,
  attemptDigest: digest,
  authoritySnapshotDigest: digest,
  beginMarkerId: 'begin_01',
  beginMarkerDigest: digest,
  providerConfigGeneration: 1,
  providerConfigGenerationDigest: digest,
  providerObservationDigest: semanticDigest(
    contract.DELIVERY_DIGEST_DOMAINS.providerObservation,
    {
      ...safe,
      intentDigest: digest,
      attemptDigest: digest,
      authoritySnapshotDigest: digest,
      beginMarkerId: 'begin_01',
      beginMarkerDigest: digest,
      providerConfigGeneration: 1,
      providerConfigGenerationDigest: digest,
    },
  ),
};
describe('CloudDeliveryObservationV2', () => {
  it('does not accept local audit records on the Cloud wire', () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    expect(() => api.CloudDeliveryObservationV2Schema.parse(safeWithDigest)).toThrow();
  });

  it.each([
    ['raw URI', { rawUri: 'https://example.test/resource?access_token=value' }],
    ['headers', { headers: { authorization: 'Bearer placeholder-value' } }],
    ['provider response', { providerResponse: { ok: true } }],
    ['presentation', { body: 'completed' }],
    ['credential material', { accessToken: 'not-a-real-token' }],
    ['secret-derived hash', { accessTokenDigest: digest }],
    ['custody locator', { credentialLocator: 'keychain://entry' }],
    ['local path', { localPath: '/Users/example/private.txt' }],
  ])('rejects %s fields', (_label, unsafe) => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    expect(api.HostedCloudDeliveryObservationV2Schema.parse(validHostedProvider)).toEqual(validHostedProvider);
    expect(() =>
      api.HostedCloudDeliveryObservationV2Schema.parse({ ...validHostedProvider, ...unsafe }),
    ).toThrow();
  });

  it.each([
    'https://example.test/path?key=value',
    '/Users/example/private.txt',
    'Bearer abcdefghijklmnop',
    'ghp_abcdefghijklmnopqrstuvwxyz',
  ])('rejects unsafe opaque provider instance value %s', (providerInstanceId) => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    const poisoned = structuredClone(validHostedProvider);
    poisoned.providerInstanceId = providerInstanceId;
    poisoned.hostedLineage.authorization.protectedClaims.providerInstanceId = providerInstanceId;
    poisoned.hostedLineage.receipt.providerInstanceId = providerInstanceId;
    expect(() => api.HostedCloudDeliveryObservationV2Schema.parse(poisoned)).toThrow(
      /Opaque identifier must not be a URI or local path|credential-like/iu,
    );
  });

  it('rejects credential-shaped fields recursively inside intent projections', () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    expect(api.HostedCloudDeliveryObservationV2Schema.parse(validHostedIntent)).toEqual(validHostedIntent);
    expect(() =>
      api.HostedCloudDeliveryObservationV2Schema.parse({
        ...validHostedIntent,
        intent: {
          ...validHostedIntent.intent,
          nested: { refreshToken: 'placeholder' },
        },
      }),
    ).toThrow();
  });

  it('binds Hosted intent scope and installation across observation, claims, and receipt', () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    const claims = validHostedIntent.hostedLineage.authorization.protectedClaims;
    expect(validHostedIntent.installationId).toBe(claims.installationId);
    expect(api.HostedCloudDeliveryObservationV2Schema.parse(validHostedIntent)).toEqual(
      validHostedIntent,
    );

    for (const mutateFixture of [
      (value: typeof validHostedIntent) => {
        value.scope.id = 'destination_tampered:organization_fixture';
      },
      (value: typeof validHostedIntent) => {
        value.installationId = 'installation_tampered';
      },
      (value: typeof validHostedIntent) => {
        value.hostedLineage.receipt.scope.kind = 'local_repository';
      },
      (value: typeof validHostedIntent) => {
        value.hostedLineage.receipt.scope.id =
          'destination_tampered:organization_fixture';
      },
      (value: typeof validHostedIntent) => {
        value.hostedLineage.receipt.installationId = 'installation_tampered';
      },
    ]) {
      const tampered = structuredClone(validHostedIntent);
      const receipt = tampered.hostedLineage.receipt;
      mutateFixture(tampered);
      const { receiptDigest: _receiptDigest, ...receiptWithoutDigest } = receipt;
      receipt.receiptDigest = semanticDigest(
        contract.DELIVERY_DIGEST_DOMAINS.localBeginOutcomeReceipt,
        receiptWithoutDigest,
      );

      expect(() => api.HostedCloudDeliveryObservationV2Schema.parse(tampered)).toThrow(
        /match/iu,
      );
    }
  });

  it('requires complete Hosted authorization and begin lineage for Hosted observations', async () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    const hosted = {
      ...safe,
      scope: { kind: 'hosted_control', id: 'destination_01:organization_01' },
      intentDigest: digest,
      attemptDigest: digest,
      authoritySnapshotDigest: digest,
      beginMarkerId: 'begin_01',
      beginMarkerDigest: digest,
      providerConfigGeneration: 1,
      providerConfigGenerationDigest: digest,
    };
    const claims = {
      issuer: 'opentag-cloud', audience: 'opentag-runtime', signingKeyId: 'key_01',
      authorityKind: 'hosted_delivery_authorization',
      keyUse: 'opentag_hosted_provider_io_authorization_v2', signatureAlgorithm: 'Ed25519',
      contractVersion: 2, deploymentVersion: 'deployment_01', capabilityVersion: 'capability_01',
      operationGateEpoch: 1, cutoverId: 'cutover_01', canaryAllowlistDigest: digest,
      publicKeySetDigest: digest,
      installationId: 'installation_01', scope: hosted.scope,
      destinationId: 'destination_01', organizationId: 'organization_01',
      runnerPrincipalDigest: digest, runnerGeneration: 1, runId: 'run_01', workThreadId: 'thread_01',
      hostedAttemptId: 'hosted_attempt_01', hostedAttemptFenceDigest: digest,
      completionAssessmentDigest: digest, completionPredecessorDigest: digest,
      authoritySnapshotDigest: digest, sourceRowId: 'source_01', sideEffectIntentId: hosted.sideEffectIntentId,
      causalId: 'causal_01', localAttemptTokenId: 'local_token_01', initialAttemptSequence: 1,
      attemptId: hosted.attemptId, attemptSequence: 1, localAttemptRevision: 1,
      localAttemptLeaseFenceDigest: digest,
      idempotencyKey: 'idem_01', providerId: hosted.providerId,
      providerInstanceId: hosted.providerInstanceId, sqliteIdentityDigest: digest,
      deliveryId: 'delivery_01', providerPrincipalDigest: digest,
      principalAssurance: 'provider_verified',
      providerBindingDigest: digest, providerConfigGeneration: 1,
      providerConfigGenerationDigest: digest, targetDigest: digest, operationDigest: digest,
      presentationDigest: digest, sideEffectApprovalId: 'approval_01',
      sideEffectApprovalTupleDigest: digest, maxClockSkewMs: 1_000,
      issuedAt: '2026-08-13T00:00:00.000Z',
      expiresAt: '2026-08-13T00:00:30.000Z', tokenId: 'token_01',
      nonce: 'A'.repeat(43),
    };
    const receipt = {
      tokenId: claims.tokenId, authorizationDigest: digest,
      localAttemptTokenId: claims.localAttemptTokenId,
      sideEffectApprovalId: claims.sideEffectApprovalId,
      sideEffectApprovalTupleDigest: claims.sideEffectApprovalTupleDigest,
      operationGateEpoch: claims.operationGateEpoch, canaryAllowlistDigest: claims.canaryAllowlistDigest,
      installationId: claims.installationId, scope: hosted.scope,
      sideEffectIntentId: hosted.sideEffectIntentId, attemptId: hosted.attemptId, attemptSequence: 1,
      localAttemptRevision: 1, localAttemptLeaseFenceDigest: digest,
      providerId: hosted.providerId, providerInstanceId: hosted.providerInstanceId,
      providerPrincipalDigest: digest, principalAssurance: 'provider_verified',
      providerBindingDigest: digest, providerConfigGeneration: 1,
      providerConfigGenerationDigest: digest, providerIoBegun: true,
      providerIoBegunAt: '2026-08-13T00:00:01.000Z',
      installationBeginMarkerId: 'installation_begin_01', installationBeginMarkerDigest: digest,
      scopeBeginMarkerId: hosted.beginMarkerId, scopeBeginMarkerDigest: hosted.beginMarkerDigest,
      outcome: hosted.outcome, outcomeRecordedAt: '2026-08-13T00:00:02.000Z',
      evidenceDigest: hosted.evidenceDigest, receiptDigest: digest,
    };
    const authorizationWithoutDigest = {
        protectedClaims: claims,
        protectedClaimsDigest: semanticDigest('opentag.delivery.authorization-claims.v2', claims),
        publicKeyId: 'key_01', signature: `${'a'.repeat(85)}g`,
    };
    const authorization = {
      ...authorizationWithoutDigest,
      authorizationDigest: semanticDigest(
        contract.DELIVERY_DIGEST_DOMAINS.authorizationEnvelope,
        authorizationWithoutDigest,
      ),
    };
    receipt.authorizationDigest = authorization.authorizationDigest;
    const { receiptDigest: _receiptDigest, ...receiptWithoutDigest } = receipt;
    receipt.receiptDigest = semanticDigest(
      contract.DELIVERY_DIGEST_DOMAINS.localBeginOutcomeReceipt,
      receiptWithoutDigest,
    );
    const hostedLineage = { authorization, receipt };
    const valid = {
      ...hosted,
      hostedLineage,
      providerObservationDigest: semanticDigest(
        contract.DELIVERY_DIGEST_DOMAINS.providerObservation,
        { ...hosted, hostedLineage },
      ),
    };
    const acceptingVerifier = { verifyEd25519: () => true };
    await expect(contract.verifyHostedObservationIntegrity(nodeSha256DigestProvider, acceptingVerifier, valid)).resolves.toEqual(valid);
    await expect(contract.verifyHostedObservationIntegrity(
      nodeSha256DigestProvider, acceptingVerifier,
      { ...valid, outcome: 'rejected' },
    )).rejects.toThrow(/match|digest/iu);
    const { hostedLineage: _lineage, ...missing } = valid;
    expect(() => api.CloudProviderObservationV2Schema.parse(missing)).toThrow(/Hosted/iu);
    expect(() =>
      api.CloudProviderObservationV2Schema.parse({
        ...safeWithDigest,
        hostedLineage,
      }),
    ).toThrow(/local|Hosted/iu);
    expect(() =>
      api.CloudProviderObservationV2Schema.parse({
        ...valid,
        hostedLineage: { ...hostedLineage, receipt: { ...receipt, tokenId: 'token_tampered' } },
      }),
    ).toThrow(/match/iu);
    const tamperedAuthorization = {
      ...authorization,
      protectedClaims: {
        ...authorization.protectedClaims,
        destinationId: 'destination_tampered',
      },
    };
    const tamperedLineage = { authorization: tamperedAuthorization, receipt };
    const tampered = {
      ...hosted,
      hostedLineage: tamperedLineage,
      providerObservationDigest: semanticDigest(
        contract.DELIVERY_DIGEST_DOMAINS.providerObservation,
        { ...hosted, hostedLineage: tamperedLineage },
      ),
    };
    await expect(
      contract.verifyHostedObservationIntegrity(
        nodeSha256DigestProvider,
        acceptingVerifier,
        tampered,
      ),
    ).rejects.toThrow(/protectedClaimsDigest/iu);
    await expect(contract.verifyHostedObservationIntegrity(
      nodeSha256DigestProvider,
      { verifyEd25519: () => false },
      valid,
    )).rejects.toThrow(/signature/iu);
    expect(contract.verifyHostedObservationPolicy(valid as never, {
      mode: 'historical_append',
      expectedIssuer: claims.issuer,
      expectedAudience: claims.audience,
      expectedPublicKeySetDigest: claims.publicKeySetDigest,
      expectedDeploymentVersion: claims.deploymentVersion,
      expectedCapabilityVersion: claims.capabilityVersion,
    })).toEqual(valid);
    const { issuedAt: _issuedAt, expiresAt: _expiresAt, nonce: _nonce,
      contractVersion: _contractVersion, authorityKind: _authorityKind,
      keyUse: _keyUse, signatureAlgorithm: _signatureAlgorithm,
      ...expectedClaims } = claims;
    const beginExpectation = {
      ...expectedClaims,
      now: '2026-08-13T00:00:01.000Z',
      maxClockSkewMs: claims.maxClockSkewMs,
    };
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider,
      acceptingVerifier,
      authorization,
      beginExpectation,
    )).resolves.toEqual(authorization);
    const reorderedExpectation = Object.fromEntries(Object.entries(beginExpectation).reverse()) as typeof beginExpectation;
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider, acceptingVerifier, authorization, reorderedExpectation,
    )).resolves.toEqual(authorization);
    for (const [key, value] of [
      ['issuer', 'wrong-issuer'], ['installationId', 'wrong-installation'],
      ['destinationId', 'wrong-destination'], ['attemptId', 'wrong-attempt'],
      ['providerInstanceId', 'wrong-instance'], ['targetDigest', `sha256:${'c'.repeat(64)}`],
      ['operationGateEpoch', 2], ['localAttemptRevision', 2],
    ] as const) {
      await expect(contract.verifyHostedAuthorizationForLocalBegin(
        nodeSha256DigestProvider, acceptingVerifier, authorization,
        { ...beginExpectation, [key]: value },
      )).rejects.toThrow(/expectation/iu);
    }
    for (const maxClockSkewMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 30_001]) {
      await expect(contract.verifyHostedAuthorizationForLocalBegin(
        nodeSha256DigestProvider, acceptingVerifier, authorization,
        { ...beginExpectation, maxClockSkewMs },
      )).rejects.toThrow(/time window/iu);
    }
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider, acceptingVerifier, authorization,
      { ...beginExpectation, now: '2026-08-12T23:59:59.000Z' },
    )).resolves.toEqual(authorization);
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider, acceptingVerifier, authorization,
      { ...beginExpectation, now: '2026-08-12T23:59:58.999Z' },
    )).rejects.toThrow(/time window/iu);
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider, acceptingVerifier, authorization,
      { ...beginExpectation, now: '2026-08-13T00:00:31.000Z' },
    )).resolves.toEqual(authorization);
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider, acceptingVerifier, authorization,
      { ...beginExpectation, now: '2026-08-13T00:00:31.001Z' },
    )).rejects.toThrow(/time window/iu);
    for (const providerIoBegunAt of [
      '2026-08-12T23:59:59.000Z',
      '2026-08-13T00:00:31.000Z',
    ]) {
      const withinSignedSkew = structuredClone(valid);
      withinSignedSkew.hostedLineage.receipt.providerIoBegunAt = providerIoBegunAt;
      withinSignedSkew.hostedLineage.receipt.outcomeRecordedAt = '2026-08-13T00:00:32.000Z';
      expect(api.HostedCloudDeliveryObservationV2Schema.safeParse(withinSignedSkew).success).toBe(true);
    }
    for (const providerIoBegunAt of [
      '2026-08-12T23:59:58.999Z',
      '2026-08-13T00:00:31.001Z',
    ]) {
      const outsideSignedSkew = structuredClone(valid);
      outsideSignedSkew.hostedLineage.receipt.providerIoBegunAt = providerIoBegunAt;
      outsideSignedSkew.hostedLineage.receipt.outcomeRecordedAt = '2026-08-13T00:00:32.000Z';
      expect(api.HostedCloudDeliveryObservationV2Schema.safeParse(outsideSignedSkew).success).toBe(false);
    }
    const strictClaims = { ...claims, maxClockSkewMs: 0 };
    const strictAuthorizationWithoutDigest = {
      ...authorization,
      protectedClaims: strictClaims,
      protectedClaimsDigest: semanticDigest(contract.DELIVERY_DIGEST_DOMAINS.authorizationClaims, strictClaims),
    };
    const { authorizationDigest: _strictDigest, ...strictEnvelope } = strictAuthorizationWithoutDigest;
    const strictAuthorization = {
      ...strictAuthorizationWithoutDigest,
      authorizationDigest: semanticDigest(contract.DELIVERY_DIGEST_DOMAINS.authorizationEnvelope, strictEnvelope),
    };
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider, acceptingVerifier, strictAuthorization,
      { ...beginExpectation, maxClockSkewMs: 0, now: strictClaims.issuedAt },
    )).resolves.toEqual(strictAuthorization);
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider, acceptingVerifier, strictAuthorization,
      { ...beginExpectation, maxClockSkewMs: 0, now: '2026-08-12T23:59:59.999Z' },
    )).rejects.toThrow(/time window/iu);
    const strictHosted = structuredClone(valid);
    strictHosted.hostedLineage.authorization = strictAuthorization;
    strictHosted.hostedLineage.receipt.authorizationDigest = strictAuthorization.authorizationDigest;
    strictHosted.hostedLineage.receipt.providerIoBegunAt = strictClaims.issuedAt;
    expect(api.HostedCloudDeliveryObservationV2Schema.safeParse(strictHosted).success).toBe(true);
    strictHosted.hostedLineage.receipt.providerIoBegunAt = '2026-08-12T23:59:59.999Z';
    expect(api.HostedCloudDeliveryObservationV2Schema.safeParse(strictHosted).success).toBe(false);
    const fixtureAuthorization = validHostedIntent.hostedLineage.authorization;
    const fixtureClaims = fixtureAuthorization.protectedClaims;
    const { issuedAt, expiresAt, nonce, contractVersion, authorityKind, keyUse,
      signatureAlgorithm, ...fixtureExpected } = fixtureClaims;
    const fixtureKey = fixtureManifest.publicVerificationKeys[0];
    const fixtureVerifier = { async verifyEd25519({ signature, signingBytes }: {
      signature: string; signingBytes: Uint8Array;
    }) {
      return verify(null, signingBytes, createPublicKey({ key: fixtureKey, format: 'jwk' }), Buffer.from(signature, 'base64url'));
    } };
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider,
      fixtureVerifier,
      fixtureAuthorization,
      { ...fixtureExpected, now: issuedAt },
    )).resolves.toEqual(fixtureAuthorization);
    expect(api.HostedCloudDeliveryObservationV2Schema.safeParse(validHostedIntent).success).toBe(true);
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider, fixtureVerifier, fixtureAuthorization,
      { ...fixtureExpected, maxClockSkewMs: fixtureClaims.maxClockSkewMs - 1, now: issuedAt },
    )).rejects.toThrow(/expectation/iu);
    const skewTamperedClaims = {
      ...fixtureClaims,
      maxClockSkewMs: fixtureClaims.maxClockSkewMs + 1,
    };
    const skewTamperedWithoutAuthorizationDigest = {
      ...fixtureAuthorization,
      protectedClaims: skewTamperedClaims,
      protectedClaimsDigest: semanticDigest(
        contract.DELIVERY_DIGEST_DOMAINS.authorizationClaims,
        skewTamperedClaims,
      ),
    };
    const { authorizationDigest: _skewDigest, ...skewTamperedEnvelope } =
      skewTamperedWithoutAuthorizationDigest;
    const skewTamperedAuthorization = {
      ...skewTamperedWithoutAuthorizationDigest,
      authorizationDigest: semanticDigest(
        contract.DELIVERY_DIGEST_DOMAINS.authorizationEnvelope,
        skewTamperedEnvelope,
      ),
    };
    await expect(contract.verifyHostedAuthorizationForLocalBegin(
      nodeSha256DigestProvider, fixtureVerifier, skewTamperedAuthorization,
      { ...fixtureExpected, maxClockSkewMs: skewTamperedClaims.maxClockSkewMs, now: issuedAt },
    )).rejects.toThrow(/signature/iu);
    expect(() =>
      api.CloudProviderObservationV2Schema.parse({
        ...valid,
        hostedLineage: {
          ...hostedLineage,
          receipt: { ...receipt, operationGateEpoch: 2 },
        },
      }),
    ).toThrow(/match/iu);
    expect(contract.hostedAuthorizationSigningBytes(claims)).toEqual(
      contract.domainSeparatedCanonicalBytes(
        contract.DELIVERY_DIGEST_DOMAINS.authorizationClaims,
        claims,
      ),
    );
  });

  it('rejects malformed digest-provider output', async () => {
    await expect(contract.domainSeparatedCanonicalDigest({ sha256: () => 'bad' }, 'domain-a', {})).rejects.toThrow(
      /DigestProvider/iu,
    );
  });
});
