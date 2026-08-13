import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/canonical-json.js';
import { verifyDeliveryFixtureCorpus } from '../../../scripts/test/verify-delivery-fixture-corpus.js';

const authoredCorpus = new URL(
  '../fixtures/relay.delivery-observation.v2/',
  import.meta.url,
);

describe('delivery fixture corpus verifier', () => {
  it('accepts the authored corpus with its exact byte set', async () => {
    await expect(verifyDeliveryFixtureCorpus(authoredCorpus)).resolves.toMatchObject({
      ok: true,
      fileCount: 6,
    });
  });

  it('rejects byte drift and extra files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opentag-delivery-corpus-'));
    await cp(authoredCorpus, directory, { recursive: true });
    await writeFile(join(directory, 'unexpected.json'), '{}\n');
    await expect(verifyDeliveryFixtureCorpus(directory)).rejects.toThrow(/extra|file set/iu);
  });

  it('rejects fixture byte drift', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opentag-delivery-corpus-'));
    await cp(authoredCorpus, directory, { recursive: true });
    const fixturePath = join(directory, '06-provider.json');
    const fixture = await readFile(fixturePath, 'utf8');
    await writeFile(fixturePath, fixture.replace('accepted', 'rejected'));
    await expect(verifyDeliveryFixtureCorpus(directory)).rejects.toThrow(/byte digest drift/iu);
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['duplicate keys', Buffer.from('{"contractVersion":2,"contractVersion":2}\n')],
    ['non-canonical JSON', Buffer.from('{ "contractVersion": 2 }\n')],
  ])('rejects %s before accepting fixture semantics', async (_label, bytes) => {
    const directory = await mkdtemp(join(tmpdir(), 'opentag-delivery-corpus-'));
    await cp(authoredCorpus, directory, { recursive: true });
    const fixturePath = join(directory, '06-provider.json');
    await writeFile(fixturePath, bytes);
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const entry = manifest.files.find((file) => file.path === '06-provider.json');
    if (!entry) throw new Error('Missing fixture manifest entry.');
    entry.sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(verifyDeliveryFixtureCorpus(directory)).rejects.toThrow(
      /UTF-8|canonical|duplicate/iu,
    );
  });

  it('rejects a corpus-directory symlink', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'opentag-delivery-corpus-'));
    const link = join(parent, 'corpus-link');
    await symlink(authoredCorpus, link, 'dir');
    await expect(verifyDeliveryFixtureCorpus(link)).rejects.toThrow(/symlink/iu);
  });

  it('rejects symlinks before reading fixture content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opentag-delivery-corpus-'));
    await symlink('/dev/null', join(directory, 'manifest.json'));
    await expect(verifyDeliveryFixtureCorpus(directory)).rejects.toThrow(/symlink|regular file/iu);
  });

  it('rejects duplicate public verification key IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opentag-delivery-corpus-'));
    await cp(authoredCorpus, directory, { recursive: true });
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      publicVerificationKeys: Array<{
        crv: 'Ed25519'; kid: string; kty: 'OKP'; use: 'sig'; x: string;
      }>;
    };
    manifest.publicVerificationKeys.push({ ...manifest.publicVerificationKeys[0] });
    await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);

    await expect(verifyDeliveryFixtureCorpus(directory)).rejects.toThrow(
      /duplicate public verification key/iu,
    );
  });

  it('requires public verification keys in canonical kid order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opentag-delivery-corpus-'));
    await cp(authoredCorpus, directory, { recursive: true });
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      publicVerificationKeys: Array<{
        crv: 'Ed25519'; kid: string; kty: 'OKP'; use: 'sig'; x: string;
      }>;
    };
    manifest.publicVerificationKeys.push({
      ...manifest.publicVerificationKeys[0],
      kid: 'fixture_ed25519_00',
    });
    await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);

    await expect(verifyDeliveryFixtureCorpus(directory)).rejects.toThrow(
      /public verification key order/iu,
    );
  });
});
