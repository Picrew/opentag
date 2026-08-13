import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as contract from '../src/index.js';
import { nodeSha256DigestProvider } from '../src/node.js';

const corpusDirectory = fileURLToPath(
  new URL('../fixtures/relay.delivery-observation.v2', import.meta.url),
);

describe('canonical JSON', () => {
  it('makes object insertion order irrelevant while preserving array order', async () => {
    const api = contract as Record<string, (...args: unknown[]) => unknown>;
    const first = { z: [1, 2], a: { second: true, first: 'value' } };
    const reordered = { a: { first: 'value', second: true }, z: [1, 2] };

    expect(api.canonicalJson(first)).toBe(
      '{"a":{"first":"value","second":true},"z":[1,2]}',
    );
    expect(api.canonicalJson(reordered)).toBe(api.canonicalJson(first));
    expect(await contract.domainSeparatedCanonicalDigest(nodeSha256DigestProvider, 'test', reordered)).toBe(
      await contract.domainSeparatedCanonicalDigest(nodeSha256DigestProvider, 'test', first),
    );
    expect(await contract.domainSeparatedCanonicalDigest(nodeSha256DigestProvider, 'test', { ...first, z: [2, 1] })).not.toBe(
      await contract.domainSeparatedCanonicalDigest(nodeSha256DigestProvider, 'test', first),
    );
  });

  it('keeps portable canonical bytes separate from Node hashing and separates domains', async () => {
    expect(new TextDecoder().decode(contract.domainSeparatedCanonicalBytes('domain-a', { value: 1 }))).toBe(
      'domain-a\0{"value":1}',
    );
    expect(await contract.domainSeparatedCanonicalDigest(nodeSha256DigestProvider, 'domain-a', { value: 1 })).not.toBe(
      await contract.domainSeparatedCanonicalDigest(nodeSha256DigestProvider, 'domain-b', { value: 1 }),
    );
  });

  it.each([
    { value: undefined, label: 'undefined' },
    { value: Number.NaN, label: 'non-finite number' },
    { value: 1n, label: 'bigint' },
    { value: new Date('2026-08-13T00:00:00.000Z'), label: 'prototype' },
  ])('rejects $label instead of coercing it', ({ value }) => {
    const api = contract as Record<string, (...args: unknown[]) => unknown>;
    expect(() => api.canonicalJson(value)).toThrow();
  });

  it('rejects cyclic objects', () => {
    const api = contract as Record<string, (...args: unknown[]) => unknown>;
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => api.canonicalJson(value)).toThrow(/cycle/iu);
  });

  it.each([
    { value: [, 'value'], label: 'sparse arrays' },
    { value: { [Symbol('hidden')]: 'value' }, label: 'symbol keys' },
    {
      value: Object.defineProperty({}, 'value', { get: () => 'value', enumerable: true }),
      label: 'accessors',
    },
  ])('rejects $label instead of silently losing semantics', ({ value }) => {
    const api = contract as Record<string, (...args: unknown[]) => unknown>;
    expect(() => api.canonicalJson(value)).toThrow();
  });

  it.each(['\ud800', '\udc00'])(
    'rejects unpaired Unicode surrogate %s',
    (value) => expect(() => contract.canonicalJson(value)).toThrow(/surrogate/iu),
  );

  it('rejects lossy object and array properties', () => {
    const record = Object.defineProperty({ visible: true }, 'hidden', { value: true });
    const array = ['value'] as string[] & { label?: string };
    array.label = 'hidden';
    expect(() => contract.canonicalJson(record)).toThrow(/non-enumerable/iu);
    expect(() => contract.canonicalJson(array)).toThrow(/named array/iu);
    expect(() => contract.canonicalJson({ ['\ud800']: true })).toThrow(/surrogate/iu);
  });

  it.each([
    [
      'getter',
      () => Object.defineProperty([], '0', {
        get: () => 'value',
        enumerable: true,
      }),
      /accessor/iu,
    ],
    [
      'setter',
      () => Object.defineProperty([], '0', {
        set: (_value: unknown) => undefined,
        enumerable: true,
      }),
      /accessor/iu,
    ],
    [
      'non-enumerable data property',
      () => Object.defineProperty([], '0', {
        value: 'value',
        enumerable: false,
      }),
      /non-enumerable/iu,
    ],
  ])('rejects array index %s descriptors', (_label, createValue, expected) => {
    expect(() => contract.canonicalJson(createValue())).toThrow(expected);
  });

  it('freezes Unicode key order, non-BMP strings, and number formatting', () => {
    expect(contract.canonicalJson({ '\uffff': 1, '\ud83d\ude00': 2, a: 1e-7, b: -0 })).toBe(
      '{"a":1e-7,"b":0,"😀":2,"￿":1}',
    );
  });
});

describe('authored fixture corpus', () => {
  it('contains schema-valid intent, attempt, and provider observations', async () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    const manifest = JSON.parse(
      await readFile(`${corpusDirectory}/manifest.json`, 'utf8'),
    ) as { files: Array<{ path: string; kind: string }> };
    const seenKinds = new Set<string>();
    const seenIntentKinds = new Set<string>();

    for (const entry of manifest.files) {
      const value = JSON.parse(
        await readFile(`${corpusDirectory}/${entry.path}`, 'utf8'),
      ) as { observationKind: string; intent?: { intentKind?: string } };
      api.SanitizedDeliveryObservationV2Schema.parse(value);
      seenKinds.add(value.observationKind);
      if (value.intent?.intentKind) seenIntentKinds.add(value.intent.intentKind);
    }

    expect([...seenKinds].sort()).toEqual(['attempt', 'intent', 'provider']);
    expect([...seenIntentKinds].sort()).toEqual([
      'credential_refresh',
      'delivery',
      'material_action',
      'readback',
    ]);
  });

  it('contains valid fixed Ed25519 signatures for every Hosted relay fixture', async () => {
    const manifest = JSON.parse(await readFile(`${corpusDirectory}/manifest.json`, 'utf8')) as {
      files: Array<{ audience: string; path: string }>;
      publicVerificationKeys: Array<{ kid: string; kty: 'OKP'; crv: 'Ed25519'; x: string; use: 'sig' }>;
    };
    const keys = new Map(manifest.publicVerificationKeys.map((entry) => [entry.kid, entry]));
    for (const entry of manifest.files.filter((candidate) => candidate.audience === 'hosted_relay')) {
      const value = JSON.parse(await readFile(`${corpusDirectory}/${entry.path}`, 'utf8')) as {
        hostedLineage: { authorization: contract.HostedDeliveryAuthorizationV2 };
      };
      const authorization = value.hostedLineage.authorization;
      const key = keys.get(authorization.publicKeyId);
      expect(key).toBeDefined();
      expect(verify(
        null,
        contract.hostedAuthorizationSigningBytes(authorization.protectedClaims),
        createPublicKey({ key: key!, format: 'jwk' }),
        Buffer.from(authorization.signature, 'base64url'),
      )).toBe(true);
    }
  });

  it('keeps the credential fixture generic-local and outside the Hosted route', async () => {
    const value = JSON.parse(await readFile(`${corpusDirectory}/04-credential-intent.json`, 'utf8'));
    expect(contract.SanitizedDeliveryObservationV2Schema.safeParse(value).success).toBe(true);
    expect(contract.HostedCloudDeliveryObservationV2Schema.safeParse(value).success).toBe(false);
  });
});
