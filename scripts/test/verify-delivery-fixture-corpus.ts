import { lstat, readdir, readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalJson,
  DELIVERY_DIGEST_DOMAINS,
  HostedCloudDeliveryObservationV2Schema,
  SanitizedDeliveryObservationV2Schema,
  verifyHostedObservationIntegrity,
} from '../../packages/delivery-contract/src/index.js';
import { nodeSha256DigestProvider } from '../../packages/delivery-contract/src/node.js';

type ManifestEntry = {
  id: string;
  kind: 'intent' | 'attempt' | 'provider';
  path: string;
  sha256: string;
  audience: 'hosted_relay' | 'local_audit';
};

type Manifest = {
  contract: 'relay.delivery-observation.v2';
  framing: 'u32be-path-length:path:u64be-content-length:content';
  files: ManifestEntry[];
  corpusDigest: string;
  publicVerificationKeys: Array<{ kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; use: 'sig' }>;
};

function digest(bytes: Uint8Array): string {
  const value = nodeSha256DigestProvider.sha256(bytes);
  if (typeof value !== 'string') throw new TypeError('Node digest provider must be synchronous.');
  return value;
}

function frame(entries: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(entry.bytes.length));
    chunks.push(pathLength, pathBytes, contentLength, Buffer.from(entry.bytes));
  }
  return Buffer.concat(chunks);
}

function assertSafeRelativePath(path: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/u.test(path)) {
    throw new Error(`Unsafe fixture path: ${path}`);
  }
}

function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  const whitespace = /\s/u;
  const skipWhitespace = () => {
    while (whitespace.test(text[index] ?? '')) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      } else index += 1;
    }
    throw new Error('Invalid JSON string.');
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = text[index];
    if (character === '"') {
      parseString();
      return;
    }
    if (character === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (index < text.length) {
        if (text[index] !== '"') throw new Error('Invalid JSON object key.');
        const key = parseString();
        if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') throw new Error('Invalid JSON object separator.');
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') throw new Error('Invalid JSON object delimiter.');
        index += 1;
        skipWhitespace();
      }
    }
    if (character === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') throw new Error('Invalid JSON array delimiter.');
        index += 1;
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(index));
    if (!match) throw new Error('Invalid JSON value.');
    index += match[0].length;
  };
  parseValue();
  skipWhitespace();
  if (index !== text.length) throw new Error('Trailing JSON content.');
}

function parseCanonicalJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  if (text.startsWith('\uFEFF')) throw new Error(`${label} must not contain a UTF-8 BOM.`);
  assertNoDuplicateJsonKeys(text);
  const parsed: unknown = JSON.parse(text);
  if (text !== `${canonicalJson(parsed)}\n`) throw new Error(`${label} bytes are not canonical JSON.`);
  return parsed;
}

export async function verifyDeliveryFixtureCorpus(
  corpusDirectory: string | URL,
): Promise<{ ok: true; fileCount: number; corpusDigest: string }> {
  const rawDirectory = corpusDirectory instanceof URL ? fileURLToPath(corpusDirectory) : corpusDirectory;
  const directoryStat = await lstat(rawDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Corpus root must be a non-symlink directory.');
  }
  const directory = resolve(rawDirectory);
  const manifestPath = resolve(directory, 'manifest.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('Manifest must be a non-symlink regular file.');
  }
  const manifest = parseCanonicalJson(await readFile(manifestPath), 'Manifest') as Manifest;
  const manifestKeys = Object.keys(manifest).sort();
  if (
    JSON.stringify(manifestKeys) !==
      JSON.stringify(['contract', 'corpusDigest', 'files', 'framing', 'publicVerificationKeys']) ||
    manifest.contract !== 'relay.delivery-observation.v2' ||
    manifest.framing !== 'u32be-path-length:path:u64be-content-length:content' ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('Invalid delivery fixture manifest.');
  }
  for (const entry of manifest.files) {
    if (
      JSON.stringify(Object.keys(entry).sort()) !==
      JSON.stringify(['audience', 'id', 'kind', 'path', 'sha256']) ||
      !['intent', 'attempt', 'provider'].includes(entry.kind) ||
      !['hosted_relay', 'local_audit'].includes(entry.audience) ||
      !/^sha256:[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error('Invalid delivery fixture manifest entry.');
    }
  }
  for (const key of manifest.publicVerificationKeys) {
    if (JSON.stringify(Object.keys(key).sort()) !== JSON.stringify(['crv', 'kid', 'kty', 'use', 'x']) ||
      key.kty !== 'OKP' || key.crv !== 'Ed25519' || key.use !== 'sig' ||
      Buffer.from(key.x, 'base64url').length !== 32 || Buffer.from(key.x, 'base64url').toString('base64url') !== key.x) {
      throw new Error('Invalid Ed25519 public verification key.');
    }
  }
  const publicKeyIds = manifest.publicVerificationKeys.map((key) => key.kid);
  if (new Set(publicKeyIds).size !== publicKeyIds.length) {
    throw new Error('Duplicate public verification key ID.');
  }
  const canonicalPublicKeyIds = [...publicKeyIds].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (publicKeyIds.some((kid, index) => kid !== canonicalPublicKeyIds[index])) {
    throw new Error('Public verification key order must be canonical ascending kid order.');
  }

  const paths = manifest.files.map((entry) => entry.path);
  const sortedPaths = [...paths].sort();
  if (paths.some((path, index) => path !== sortedPaths[index])) {
    throw new Error('Manifest file order drift.');
  }
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate fixture path.');
  const ids = manifest.files.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate fixture ID.');

  const actualPaths: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = resolve(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error(`Corpus entry must be a non-symlink regular file: ${entry.name}`);
      }
      if (entry.isDirectory()) await walk(entryPath);
      else if (entryPath !== manifestPath) actualPaths.push(relative(directory, entryPath));
    }
  }
  await walk(directory);
  actualPaths.sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(sortedPaths)) {
    throw new Error('Corpus file set has missing or extra files.');
  }

  const contents: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of manifest.files) {
    assertSafeRelativePath(entry.path);
    const path = resolve(directory, entry.path);
    if (relative(directory, path) !== entry.path) throw new Error(`Unsafe fixture path: ${entry.path}`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Fixture must be a non-symlink regular file: ${entry.path}`);
    }
    const bytes = await readFile(path);
    if (digest(bytes) !== entry.sha256) throw new Error(`Fixture byte digest drift: ${entry.path}`);
    const raw = parseCanonicalJson(bytes, `Fixture ${entry.path}`);
    const parsed = SanitizedDeliveryObservationV2Schema.parse(raw);
    if (entry.audience === 'hosted_relay') {
      const hosted = HostedCloudDeliveryObservationV2Schema.parse(raw);
      const publicKeySetDigest = await import('../../packages/delivery-contract/src/index.js').then(
        ({ domainSeparatedCanonicalDigest }) => domainSeparatedCanonicalDigest(
          nodeSha256DigestProvider,
          DELIVERY_DIGEST_DOMAINS.publicKeySet,
          manifest.publicVerificationKeys,
        ),
      );
      if (hosted.hostedLineage.authorization.protectedClaims.publicKeySetDigest !== publicKeySetDigest) {
        throw new Error(`Hosted authorization publicKeySetDigest drift: ${entry.path}`);
      }
      await verifyHostedObservationIntegrity(nodeSha256DigestProvider, {
        verifyEd25519({ publicKeyId, signature, signingBytes }) {
          const jwk = manifest.publicVerificationKeys.find((key) => key.kid === publicKeyId);
          if (!jwk) return false;
          return verify(null, signingBytes, createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
        },
      }, hosted);
    } else if (HostedCloudDeliveryObservationV2Schema.safeParse(raw).success) {
      throw new Error(`Local-audit fixture is accepted by Hosted relay schema: ${entry.path}`);
    }
    if (parsed.observationKind !== entry.kind || parsed.observationId !== entry.id) {
      throw new Error(`Fixture identity or kind drift: ${entry.path}`);
    }
    contents.push({ path: entry.path, bytes });
  }
  const corpusDigest = digest(frame(contents));
  if (corpusDigest !== manifest.corpusDigest) throw new Error('Corpus digest drift.');
  return { ok: true, fileCount: contents.length, corpusDigest };
}

async function main(): Promise<void> {
  const argument = process.argv[2];
  if (!argument) throw new Error('Usage: verify-delivery-fixture-corpus <corpus-directory>');
  const result = await verifyDeliveryFixtureCorpus(argument);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
