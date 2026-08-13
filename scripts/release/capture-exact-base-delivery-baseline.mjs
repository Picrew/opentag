import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  assertSafeRepositoryPath,
  framedContentDigest,
  framedPathSetDigest,
  readRevisionFile,
  resolveCommit,
  revisionFileMode,
  sha256,
} from './git-object-reader.mjs';
import { inventoryProviderIoRoots } from './inventory-provider-io-roots.mjs';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TRUSTED_CONFIG_URL = new URL(
  './manifests/opentag-provider-io-roots.config.v1.json',
  import.meta.url,
);
const trustedInventoryCache = new Map();

function regenerateTrustedInventory(repository) {
  const configBytes = readFileSync(TRUSTED_CONFIG_URL);
  const cacheKey = `${repository}\0${sha256(configBytes)}`;
  const cached = trustedInventoryCache.get(cacheKey);
  if (cached) return cached;
  const config = JSON.parse(configBytes.toString('utf8'));
  const inventory = inventoryProviderIoRoots({
    repository,
    revision: config.revision,
    entrypoints: config.entrypoints,
    requiredCandidates: config.requiredCandidates,
    exclusions: config.exclusions,
  });
  trustedInventoryCache.set(cacheKey, inventory);
  return inventory;
}

function assertExactInventory(repository, inventory) {
  if (!inventory || inventory.schemaVersion !== 'ProviderIoRootInventoryV1') {
    throw new Error('An exact generated inventory is required.');
  }
  if (!/^[0-9a-f]{40}$/u.test(inventory.revision)) {
    throw new Error('Inventory revision must be a full exact revision SHA.');
  }
  const revision = resolveCommit(repository, inventory.revision);
  if (revision !== inventory.revision) throw new Error('Inventory revision is not canonical.');
  const withoutDigest = { ...inventory };
  delete withoutDigest.inventoryDigest;
  if (!SHA256_PATTERN.test(inventory.inventoryDigest) || sha256(Buffer.from(JSON.stringify(withoutDigest))) !== inventory.inventoryDigest) {
    throw new Error('Inventory digest mismatch.');
  }
  if (!Array.isArray(inventory.candidateModules) || inventory.candidateModules.length === 0) {
    throw new Error('Inventory candidate modules must not be empty.');
  }
  const paths = [...new Set(inventory.candidateModules)].sort();
  if (!isDeepStrictEqual(paths, inventory.candidateModules)) {
    throw new Error('Inventory candidate modules must be unique and sorted.');
  }
  if (framedPathSetDigest(paths) !== inventory.candidateFileSetDigest) {
    throw new Error('Inventory candidate file-set digest mismatch.');
  }
  const files = paths.map((path) => {
    assertSafeRepositoryPath(path);
    if (revisionFileMode(repository, revision, path) !== '100644') {
      throw new Error(`Candidate source archive accepts only regular Git blob files: ${path}`);
    }
    return { path, bytes: readRevisionFile(repository, revision, path) };
  });
  const fileEvidence = files.map(({ path, bytes }) => ({ path, bytes: bytes.length, digest: sha256(bytes) }));
  if (!isDeepStrictEqual(fileEvidence, inventory.candidateFiles)) {
    throw new Error('Inventory candidate file evidence does not match exact Git objects.');
  }
  if (framedContentDigest(files) !== inventory.candidateContentDigest) {
    throw new Error('Inventory candidate content digest mismatch.');
  }
  return { revision, paths, files, fileEvidence };
}

export function captureExactBaseBaseline(input) {
  if (!input.inventory) throw new Error('An exact generated inventory is required.');
  const trustedInventory = regenerateTrustedInventory(input.repository);
  if (!isDeepStrictEqual(input.inventory, trustedInventory)) {
    throw new Error('Inventory differs from fresh generation using the trusted exact scanner config.');
  }
  const { revision, paths, files, fileEvidence } = assertExactInventory(
    input.repository,
    trustedInventory,
  );
  const artifact = execFileSync('git', ['-C', input.repository, 'archive', '--format=tar', revision, '--', ...paths], {
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (artifact.length <= 0) throw new Error('Generated candidate source archive has zero bytes.');
  const artifactDirectory = mkdtempSync(join(tmpdir(), 'opentag-exact-pack-'));
  const artifactPath = join(artifactDirectory, 'candidate-source.tar');
  let verifiedArtifact;
  try {
    writeFileSync(artifactPath, artifact, { flag: 'wx', mode: 0o600 });
    const stat = lstatSync(artifactPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Generated candidate source archive must be a regular file and not a symlink.');
    }
    verifiedArtifact = readFileSync(artifactPath);
  } finally {
    try {
      unlinkSync(artifactPath);
    } catch {}
    rmdirSync(artifactDirectory);
  }
  if (verifiedArtifact.length !== artifact.length || !verifiedArtifact.equals(artifact)) {
    throw new Error('Generated candidate source archive changed during regular-file verification.');
  }
  const artifactDigest = sha256(verifiedArtifact);
  const sourceBytes = files.reduce((total, file) => total + file.bytes.length, 0);
  const nonblankLoc = files.reduce(
    (total, file) => total + file.bytes.toString('utf8').split(/\r?\n/u).filter((line) => line.trim() !== '').length,
    0,
  );
  const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  const receipt = {
    schemaVersion: 'ExactRevisionCandidateSourceArchiveReceiptV1',
    method: 'git_archive_exact_revision_v1',
    revision,
    inventoryDigest: trustedInventory.inventoryDigest,
    candidateFileSetDigest: trustedInventory.candidateFileSetDigest,
    candidateContentDigest: trustedInventory.candidateContentDigest,
    includedFiles: fileEvidence,
    command: ['git', 'archive', '--format=tar', revision, '--', ...paths],
    tool: { name: 'git', version: gitVersion },
    artifact: { bytes: verifiedArtifact.length, digest: artifactDigest, regularFile: true, symlink: false },
    producedAt: new Date().toISOString(),
    provenance: {
      source: 'exact_git_objects',
      dirtyWorktreeRead: false,
      artifactVerification: 'exclusive_temp_file_lstat_readback',
      claimBoundary:
        'Candidate source archive only; not a built executable or package and not proof of runtime or dynamic reachability.',
    },
  };
  return {
    schemaVersion: 'DeliveryCandidateSourceBaselineV1',
    status: 'candidate_inventory_only',
    activationBlocked: true,
    dynamicReachabilityProven: false,
    revision,
    includedFiles: fileEvidence,
    exclusions: trustedInventory.exclusions,
    counts: {
      sourceBytes,
      nonblankLoc,
      candidateSourceArchiveBytes: verifiedArtifact.length,
    },
    sourceContentDigest: trustedInventory.candidateContentDigest,
    candidateSourceArchive: { digest: artifactDigest, receipt },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const inventoryPath = value('--inventory-manifest');
  if (!inventoryPath) throw new Error('--inventory-manifest is required.');
  process.stdout.write(`${JSON.stringify(captureExactBaseBaseline({
    repository: value('--repository') ?? '.',
    inventory: JSON.parse(readFileSync(inventoryPath, 'utf8')),
  }), null, 2)}\n`);
}
