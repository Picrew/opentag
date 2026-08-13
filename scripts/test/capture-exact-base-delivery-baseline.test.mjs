import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { captureExactBaseBaseline } from '../release/capture-exact-base-delivery-baseline.mjs';
import { framedContentDigest, framedPathSetDigest, readRevisionFile, sha256 } from '../release/git-object-reader.mjs';

const repository = process.cwd();
const inventory = JSON.parse(
  readFileSync(new URL('../release/manifests/opentag-provider-io-roots.v1.json', import.meta.url), 'utf8'),
);

function resign(changed) {
  const result = { ...changed };
  delete result.inventoryDigest;
  result.inventoryDigest = sha256(Buffer.from(JSON.stringify(result)));
  return result;
}

test('generates a deterministic exact-revision candidate source archive with a bound receipt', () => {
  const first = captureExactBaseBaseline({ repository, inventory });
  const second = captureExactBaseBaseline({ repository, inventory });

  assert.equal(first.revision, inventory.revision);
  assert.ok(first.counts.candidateSourceArchiveBytes > 0);
  assert.equal(first.candidateSourceArchive.digest, second.candidateSourceArchive.digest);
  assert.equal(first.counts.candidateSourceArchiveBytes, second.counts.candidateSourceArchiveBytes);
  assert.deepEqual(first.candidateSourceArchive.receipt.includedFiles, inventory.candidateFiles);
  assert.equal(first.candidateSourceArchive.receipt.inventoryDigest, inventory.inventoryDigest);
  assert.equal(first.candidateSourceArchive.receipt.method, 'git_archive_exact_revision_v1');
  assert.equal(first.candidateSourceArchive.receipt.artifact.regularFile, true);
  assert.equal(first.candidateSourceArchive.receipt.artifact.symlink, false);
  assert.match(first.candidateSourceArchive.receipt.producedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(first.candidateSourceArchive.receipt.provenance.dirtyWorktreeRead, false);
  assert.equal(JSON.stringify(first).includes(repository), false);
});

test('rejects fabricated direct API artifact evidence and arbitrary local files', () => {
  assert.throws(
    () => captureExactBaseBaseline({
      repository,
      revision: inventory.revision,
      includedFiles: ['package.json', 'README.md'],
      packedArtifact: { bytes: Buffer.from('not runtime'), measurement: { method: 'anything', receipt: 'trust me' } },
    }),
    /exact generated inventory is required/iu,
  );
});

test('rejects a self-consistent signed subset inventory containing one exact-base blob', () => {
  const path = inventory.candidateModules[0];
  const bytes = readRevisionFile(repository, inventory.revision, path);
  const file = { path, bytes: bytes.length, digest: sha256(bytes) };
  const forged = resign({
    ...inventory,
    candidateModules: [path],
    candidateFiles: [file],
    candidateFileSetDigest: framedPathSetDigest([path]),
    candidateContentDigest: framedContentDigest([{ path, bytes }]),
    roots: inventory.roots.filter((root) => root.path === path),
    counts: { candidateModules: 1, candidateBytes: bytes.length, roots: 0 },
  });

  assert.throws(
    () => captureExactBaseBaseline({ repository, inventory: forged }),
    /differs from fresh generation using the trusted exact scanner config/iu,
  );
});

test('rejects inventory digest, file-set, and source evidence mutations', () => {
  assert.throws(
    () => captureExactBaseBaseline({ repository, inventory: { ...inventory, inventoryDigest: `sha256:${'0'.repeat(64)}` } }),
    /differs from fresh generation/iu,
  );
  assert.throws(
    () => captureExactBaseBaseline({ repository, inventory: resign({ ...inventory, candidateFileSetDigest: `sha256:${'0'.repeat(64)}` }) }),
    /differs from fresh generation/iu,
  );
  assert.throws(
    () => captureExactBaseBaseline({
      repository,
      inventory: resign({
        ...inventory,
        candidateFiles: inventory.candidateFiles.map((file, index) =>
          index === 0 ? { ...file, digest: `sha256:${'0'.repeat(64)}` } : file),
      }),
    }),
    /differs from fresh generation/iu,
  );
});

test('labels the artifact as candidate source only and makes no runtime or package claim', () => {
  const baseline = captureExactBaseBaseline({ repository, inventory });
  assert.equal(baseline.schemaVersion, 'DeliveryCandidateSourceBaselineV1');
  assert.equal(
    baseline.candidateSourceArchive.receipt.schemaVersion,
    'ExactRevisionCandidateSourceArchiveReceiptV1',
  );
  assert.equal(baseline.status, 'candidate_inventory_only');
  assert.equal(baseline.activationBlocked, true);
  assert.equal(baseline.dynamicReachabilityProven, false);
  assert.match(baseline.candidateSourceArchive.receipt.provenance.claimBoundary, /not a built executable or package/iu);
  assert.match(baseline.candidateSourceArchive.receipt.provenance.claimBoundary, /not proof of runtime or dynamic reachability/iu);
  assert.equal('packedRuntimeBytes' in baseline.counts, false);
  assert.equal('packedArtifact' in baseline, false);
});
