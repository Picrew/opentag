import { canonicalJson, domainSeparatedCanonicalBytes } from './canonical-json.js';
import {
  CloudAttemptObservationV2Schema,
  CloudIntentObservationV2Schema,
  CloudProviderObservationV2Schema,
  DELIVERY_DIGEST_DOMAINS,
  type CloudDeliveryObservationV2,
  HostedDeliveryAuthorizationClaimsV2Schema,
} from './contracts.js';

export type DigestProvider = {
  sha256(bytes: Uint8Array): string | Promise<string>;
};

export type SignatureVerifier = {
  verifyEd25519(input: {
    publicKeyId: string;
    signature: string;
    signingBytes: Uint8Array;
  }): boolean | Promise<boolean>;
};

export async function domainSeparatedCanonicalDigest(
  provider: DigestProvider,
  domain: string,
  value: unknown,
): Promise<string> {
  const digest = await provider.sha256(domainSeparatedCanonicalBytes(domain, value));
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new TypeError('DigestProvider returned an invalid SHA-256 digest.');
  }
  return digest;
}

export function hostedAuthorizationSigningBytes(input: unknown): Uint8Array {
  const claims = HostedDeliveryAuthorizationClaimsV2Schema.parse(input);
  return domainSeparatedCanonicalBytes(
    DELIVERY_DIGEST_DOMAINS.authorizationClaims,
    claims,
  );
}

export async function verifyHostedObservationIntegrity(
  provider: DigestProvider,
  signatureVerifier: SignatureVerifier,
  input: unknown,
): Promise<CloudDeliveryObservationV2> {
  const observationKind = (input as { observationKind?: unknown })?.observationKind;
  if (observationKind === 'intent') {
    const value = CloudIntentObservationV2Schema.parse(input);
    const expected = await domainSeparatedCanonicalDigest(
      provider,
      DELIVERY_DIGEST_DOMAINS.intentProjection,
      value.intent,
    );
    if (value.intentDigest !== expected) throw new Error('intentDigest does not match canonical intent projection.');
    await verifyHostedLineage(provider, signatureVerifier, value.hostedLineage);
    return value;
  }
  if (observationKind === 'attempt') {
    const value = CloudAttemptObservationV2Schema.parse(input);
    if (value.hostedLineage) await verifyHostedLineage(provider, signatureVerifier, value.hostedLineage);
    const { attemptDigest: _attemptDigest, ...digestInput } = value;
    const expected = await domainSeparatedCanonicalDigest(
      provider,
      DELIVERY_DIGEST_DOMAINS.attemptObservation,
      digestInput,
    );
    if (value.attemptDigest !== expected) throw new Error('attemptDigest does not match canonical attempt observation.');
    return value;
  }
  const value = CloudProviderObservationV2Schema.parse(input);
  if (value.hostedLineage) await verifyHostedLineage(provider, signatureVerifier, value.hostedLineage);
  const { providerObservationDigest: _providerObservationDigest, ...digestInput } = value;
  const expected = await domainSeparatedCanonicalDigest(
    provider,
    DELIVERY_DIGEST_DOMAINS.providerObservation,
    digestInput,
  );
  if (value.providerObservationDigest !== expected) {
    throw new Error('providerObservationDigest does not match canonical provider observation.');
  }
  return value;
}

type HostedObservationPolicyBase = {
  expectedIssuer: string;
  expectedAudience: string;
  expectedPublicKeySetDigest: string;
  expectedDeploymentVersion: string;
  expectedCapabilityVersion: string;
};
export type HostedObservationPolicy = HostedObservationPolicyBase & (
  { mode: 'historical_append' }
);

export function verifyHostedObservationPolicy(
  input: CloudDeliveryObservationV2,
  policy: HostedObservationPolicy,
): CloudDeliveryObservationV2 {
  const claims = input.hostedLineage.authorization.protectedClaims;
  if (
    claims.issuer !== policy.expectedIssuer ||
    claims.audience !== policy.expectedAudience ||
    claims.publicKeySetDigest !== policy.expectedPublicKeySetDigest ||
    claims.deploymentVersion !== policy.expectedDeploymentVersion ||
    claims.capabilityVersion !== policy.expectedCapabilityVersion
  ) throw new Error('Hosted authorization does not satisfy expected policy.');
  return input;
}

type Authorization = import('./contracts.js').HostedDeliveryAuthorizationV2;
type Claims = import('./contracts.js').HostedDeliveryAuthorizationClaimsV2;

export type HostedLocalBeginExpectation = Omit<Claims, 'issuedAt' | 'expiresAt' | 'nonce' | 'contractVersion' |
  'authorityKind' | 'keyUse' | 'signatureAlgorithm' | 'signingKeyId'> & {
    now: string;
    signingKeyId: string;
};
export const MAX_HOSTED_BEGIN_CLOCK_SKEW_MS = 30_000;

export async function verifyHostedAuthorizationForLocalBegin(
  provider: DigestProvider,
  signatureVerifier: SignatureVerifier,
  input: unknown,
  expected: HostedLocalBeginExpectation,
): Promise<Authorization> {
  const authorization = (await import('./contracts.js')).HostedDeliveryAuthorizationV2Schema.parse(input);
  await verifyAuthorizationDigests(provider, authorization);
  const signatureValid = await signatureVerifier.verifyEd25519({
    publicKeyId: authorization.publicKeyId,
    signature: authorization.signature,
    signingBytes: hostedAuthorizationSigningBytes(authorization.protectedClaims),
  });
  if (!signatureValid) throw new Error('Hosted authorization signature is invalid.');
  const claims = authorization.protectedClaims;
  const { now, ...expectedClaims } = expected;
  const maxClockSkewMs = expected.maxClockSkewMs;
  if (!Number.isSafeInteger(maxClockSkewMs) ||
    maxClockSkewMs < 0 || maxClockSkewMs > MAX_HOSTED_BEGIN_CLOCK_SKEW_MS) {
    throw new Error('Hosted authorization is outside its local-begin time window.');
  }
  const actualComparable = Object.fromEntries(Object.entries(claims).filter(([key]) =>
    !['issuedAt', 'expiresAt', 'nonce', 'contractVersion', 'authorityKind', 'keyUse', 'signatureAlgorithm'].includes(key),
  ));
  if (canonicalJson(actualComparable) !== canonicalJson(expectedClaims)) {
    throw new Error('Hosted authorization does not match the exact local-begin expectation.');
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) ||
    nowMs + maxClockSkewMs < Date.parse(claims.issuedAt) ||
    nowMs - maxClockSkewMs > Date.parse(claims.expiresAt)) {
    throw new Error('Hosted authorization is outside its local-begin time window.');
  }
  return authorization;
}

type Receipt = import('./contracts.js').LocalBeginOutcomeReceiptV2;

async function verifyAuthorizationDigests(provider: DigestProvider, authorization: Authorization): Promise<void> {
  const claimsDigest = await domainSeparatedCanonicalDigest(
    provider,
    DELIVERY_DIGEST_DOMAINS.authorizationClaims,
    authorization.protectedClaims,
  );
  if (authorization.protectedClaimsDigest !== claimsDigest) throw new Error('protectedClaimsDigest mismatch.');
  const { authorizationDigest: _authorizationDigest, ...envelope } = authorization;
  const authorizationDigest = await domainSeparatedCanonicalDigest(
    provider,
    DELIVERY_DIGEST_DOMAINS.authorizationEnvelope,
    envelope,
  );
  if (authorization.authorizationDigest !== authorizationDigest) throw new Error('authorizationDigest mismatch.');
}

async function verifyHostedLineage(
  provider: DigestProvider,
  signatureVerifier: SignatureVerifier,
  lineage: { authorization: Authorization; receipt: Receipt },
): Promise<void> {
  await verifyAuthorizationDigests(provider, lineage.authorization);
  const signatureValid = await signatureVerifier.verifyEd25519({
    publicKeyId: lineage.authorization.publicKeyId,
    signature: lineage.authorization.signature,
    signingBytes: hostedAuthorizationSigningBytes(lineage.authorization.protectedClaims),
  });
  if (!signatureValid) throw new Error('Hosted authorization signature is invalid.');
  const { receiptDigest: _receiptDigest, ...receipt } = lineage.receipt;
  const receiptDigest = await domainSeparatedCanonicalDigest(
    provider,
    DELIVERY_DIGEST_DOMAINS.localBeginOutcomeReceipt,
    receipt,
  );
  if (lineage.receipt.receiptDigest !== receiptDigest) throw new Error('receiptDigest mismatch.');
}
