import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  canonicalJson,
  domainSeparatedCanonicalBytes,
  type DeliveryIntentV2,
} from '@opentag/delivery-contract';

const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const CREDENTIAL = /^(?:xox[baprs]-|gh[pousr]_|github_pat_|sk-)/iu;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const STAGED_OBJECT = /^([a-f0-9]{64})\.staged$/u;
const B64 = /^[A-Za-z0-9_-]+$/u;
const MAX_PAYLOAD = 512 * 1024;
const MAX_ENVELOPE = MAX_PAYLOAD + 4096;
const AAD_DOMAIN = 'opentag.delivery.payload-custody-aad.v2';
const CONFIGURATION = 'delivery_payload_custody_configuration';
const MISSING = 'delivery_payload_custody_missing';
const MISMATCH = 'delivery_payload_custody_mismatch';
const CLEANUP = 'delivery_payload_custody_cleanup';
const DESCRIPTOR_FIELDS = [
  'intentId', 'journalIntentDigest', 'providerId', 'providerInstanceId',
  'providerBindingDigest', 'providerConfigGeneration',
  'providerConfigGenerationDigest', 'runtimeOwnerId', 'runtimeGeneration',
  'schemaGeneration',
] as const;

export type DeliveryPayloadCustodyDescriptor = Readonly<{
  intentId: string;
  journalIntentDigest: string;
  providerId: string;
  providerInstanceId: string;
  providerBindingDigest: string;
  providerConfigGeneration: number;
  providerConfigGenerationDigest: string;
  runtimeOwnerId: string;
  runtimeGeneration: number;
  schemaGeneration: number;
}>;
export type DeliveryPayloadCustodyEnvelope = Readonly<{
  intent: DeliveryIntentV2;
  persistedPayload: unknown;
}>;

export interface DeliveryPayloadCustody {
  stage(input: DeliveryPayloadCustodyDescriptor & {
    envelope: DeliveryPayloadCustodyEnvelope;
  }): { commit(): void; rollback(): void };
  read(input: DeliveryPayloadCustodyDescriptor): DeliveryPayloadCustodyEnvelope;
  recoverJournaled(input: readonly DeliveryPayloadCustodyDescriptor[]): number;
  reconcile(input: {
    journaled: readonly DeliveryPayloadCustodyDescriptor[];
    orphanGraceMs: number;
    nowMs?: number;
  }): Readonly<{ finalized: number; removed: number }>;
}

type Identity = Readonly<{ id: string; metadata: Buffer }>;
type Envelope = Readonly<Record<'iv' | 'tag' | 'data', string>>;

const fail = (code: string): never => { throw new Error(code); };

const isCustodyError = (error: unknown): error is Error => error instanceof Error &&
  [CONFIGURATION, MISSING, MISMATCH, CLEANUP].includes(error.message);

const isFsError = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

function pathFree<T>(
  code: string,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (isCustodyError(error)) throw error;
    return fail(code);
  }
}

function identify(input: DeliveryPayloadCustodyDescriptor): Identity {
  if (
    !OWNER.test(input.runtimeOwnerId) || CREDENTIAL.test(input.runtimeOwnerId) ||
    !input.intentId || !input.providerId || !input.providerInstanceId ||
    !DIGEST.test(input.journalIntentDigest) ||
    !DIGEST.test(input.providerBindingDigest) ||
    !DIGEST.test(input.providerConfigGenerationDigest) ||
    [input.providerConfigGeneration, input.runtimeGeneration, input.schemaGeneration].some(
      (generation) => !Number.isSafeInteger(generation) || generation <= 0,
    )
  ) return fail(MISMATCH);
  const descriptor = Object.fromEntries(
    DESCRIPTOR_FIELDS.map((field) => [field, input[field]]),
  );
  const metadata = Buffer.from(
    domainSeparatedCanonicalBytes(AAD_DOMAIN, descriptor),
  );
  return { id: crypto.createHash('sha256').update(metadata).digest('hex'), metadata };
}

function seal(key: Buffer, identity: Identity, plaintext: string): Envelope {
  if (Buffer.byteLength(plaintext) > MAX_PAYLOAD) return fail(MISMATCH);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(identity.metadata);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
}

export function createEncryptedFileDeliveryPayloadCustody(options: {
  directory: string;
  trustedBoundary: string;
  key: Uint8Array;
  fault?: (point: 'after_stage_publish' | 'before_finalize' | 'after_finalize') => void;
}): DeliveryPayloadCustody {
  const { directory, trustedBoundary, key: rawKey, fault } = options;
  if (typeof directory !== 'string' || typeof trustedBoundary !== 'string' ||
    !isAbsolute(directory) || !isAbsolute(trustedBoundary) ||
    !(rawKey instanceof Uint8Array) || rawKey.length !== 32) return fail(CONFIGURATION);
  const child = relative(trustedBoundary, directory);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return fail(CONFIGURATION);
  const key = Buffer.from(rawKey);
  const uid = process.getuid?.();
  const parts = child ? child.split(sep).filter(Boolean) : [];
  const assertRoot = (create = false): void => {
    let current = trustedBoundary;
    for (let index = 0; index <= parts.length; index += 1) {
      if (index) current = join(current, parts[index - 1]!);
      if (index && create) {
        fs.mkdirSync(current, { mode: 0o700, recursive: true });
      }
      const stats = fs.lstatSync(current);
      const stickyBoundary = index === 0 && (stats.mode & 0o1000) !== 0;
      if (!stats.isDirectory() || stats.isSymbolicLink() ||
        (uid !== undefined && stats.uid !== uid && stats.uid !== 0) ||
        (!stickyBoundary && (stats.mode & 0o022) !== 0)) {
        return fail(CONFIGURATION);
      }
    }
  };
  pathFree(CONFIGURATION, () => assertRoot(true));
  const objectPath = (id: string, type: 'payload' | 'staged') => join(directory, `${id}.${type}`);
  const syncRoot = (): void => {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  const linkExclusive = (source: string, target: string): boolean => {
    try {
      fs.linkSync(source, target);
      syncRoot();
      return true;
    } catch (error) {
      if (isFsError(error, 'EEXIST')) return false;
      return fail(MISMATCH);
    }
  };
  const readPayload = (path: string, identity: Identity) => {
    let descriptor: number | undefined;
    try {
      assertRoot();
      descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || (before.mode & 0o077) !== 0 || before.size === 0 ||
        (uid !== undefined && before.uid !== uid) || before.size > MAX_ENVELOPE) {
        return fail(MISMATCH);
      }
      const bytes = Buffer.alloc(before.size + 1);
      const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      const after = fs.fstatSync(descriptor);
      if (length !== before.size || after.size !== before.size ||
        after.ino !== before.ino) return fail(MISMATCH);
      const value = JSON.parse(bytes.subarray(0, length).toString('utf8')) as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'data,iv,tag' ||
        !['iv', 'tag', 'data'].every(
          (name) => typeof value[name] === 'string' && B64.test(value[name] as string),
        )) return fail(MISMATCH);
      const envelope = value as Envelope;
      const iv = Buffer.from(envelope.iv, 'base64url');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(identity.metadata);
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const canonical = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      if (Buffer.byteLength(canonical) > MAX_PAYLOAD) return fail(MISMATCH);
      const payload = JSON.parse(canonical) as unknown;
      if (canonicalJson(payload) !== canonical) return fail(MISMATCH);
      return { iv: envelope.iv, value: payload, canonical };
    } catch (error) {
      if (isCustodyError(error)) throw error;
      return fail(isFsError(error, 'ENOENT') ? MISSING : MISMATCH);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  const remove = (path: string): void => pathFree(CLEANUP, () => {
    fs.rmSync(path, { force: true });
    syncRoot();
  });
  const publish = (target: string, bytes: string): boolean => {
    const temporary = join(directory, `.tmp-${crypto.randomUUID()}`);
    try {
      return pathFree(MISMATCH, () => {
        assertRoot();
        fs.writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
        return linkExclusive(temporary, target);
      });
    } finally {
      pathFree(CLEANUP, () => fs.rmSync(temporary, { force: true }));
    }
  };
  const finalize = (identity: Identity): void => {
    const staged = objectPath(identity.id, 'staged');
    const target = objectPath(identity.id, 'payload');
    const expected = readPayload(staged, identity).canonical;
    fault?.('before_finalize');
    linkExclusive(staged, target);
    if (readPayload(target, identity).canonical !== expected) return fail(MISMATCH);
    fault?.('after_finalize');
    remove(staged);
  };
  const recoverJournaled = (journaled: readonly DeliveryPayloadCustodyDescriptor[]) => journaled.reduce((count, descriptor) => {
    const identity = identify(descriptor);
    try { readPayload(objectPath(identity.id, 'payload'), identity); try { finalize(identity); } catch (error) { if (!(isCustodyError(error) && error.message === MISSING)) throw error; } return count; } catch (error) {
      if (!(isCustodyError(error) && error.message === MISSING)) throw error; finalize(identity); return count + 1; }
  }, 0);
  return {
    stage(input) {
      const identity = identify(input);
      const payload = canonicalJson(input.envelope);
      const staged = objectPath(identity.id, 'staged');
      try {
        const existing = readPayload(objectPath(identity.id, 'payload'), identity);
        if (existing.canonical !== payload) return fail(MISMATCH);
        return { commit() {}, rollback() {} };
      } catch (error) {
        if (!(isCustodyError(error) && error.message === MISSING)) throw error;
      }
      const envelope = seal(key, identity, payload);
      const created = publish(staged, canonicalJson(envelope));
      if (readPayload(staged, identity).canonical !== payload) return fail(MISMATCH);
      fault?.('after_stage_publish');
      let closed = false;
      return {
        commit() {
          if (!closed) finalize(identity);
          closed = true;
        },
        rollback() {
          if (closed) return;
          closed = true;
          if (created && readPayload(staged, identity).iv === envelope.iv) remove(staged);
        },
      };
    },
    read(input) {
      const identity = identify(input);
      return readPayload(objectPath(identity.id, 'payload'), identity)
        .value as DeliveryPayloadCustodyEnvelope;
    },
    recoverJournaled,
    reconcile(input) {
      if (!Number.isSafeInteger(input.orphanGraceMs) ||
        input.orphanGraceMs < 0) return fail(CONFIGURATION);
      const live = new Map(input.journaled.map((descriptor) => {
        const identity = identify(descriptor);
        return [identity.id, identity] as const;
      }));
      const result = { finalized: recoverJournaled(input.journaled), removed: 0 };
      for (const name of pathFree(MISMATCH, () => fs.readdirSync(directory))) {
        const match = STAGED_OBJECT.exec(name);
        if (!match) continue;
        const identity = live.get(match[1]!);
        if (identity) continue;
        const path = join(directory, name);
        const modifiedAt = pathFree(MISMATCH, () => fs.lstatSync(path)).mtimeMs;
        const age = (input.nowMs ?? Date.now()) - modifiedAt;
        if (age >= input.orphanGraceMs) {
          remove(path);
          result.removed += 1;
        }
      }
      return result;
    },
  };
}
