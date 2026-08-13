import { readFileSync } from 'node:fs';
import { dirname, extname, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  assertSafeRepositoryPath,
  framedContentDigest,
  framedPathSetDigest,
  listRevisionFiles,
  readRevisionFile,
  resolveCommit,
  sha256,
} from './git-object-reader.mjs';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

const ROOT_RULES = [
  ['external_process', /(?:node:child_process|child_process|\bspawnSync\s*\(|\bspawn\s*\(|\bexecFileSync\s*\(|\bexecFile\s*\()/u],
  ['http', /(?:\bfetch\s*\(|\bfetchImpl\s*\(|\.request\s*\()/u],
  ['sdk', /(?:\.chat\.|\.reactions\.|\.messages\.|\.issues\.|\.pulls\.|\.mergeRequests\.|\.comments\.|replyLarkMessage\s*\(|patchLarkMessageCard\s*\(|updateLarkTextMessage\s*\(|addLarkMessageReaction\s*\()/u],
  ['token', /(?:getToken\s*\(|exchangeLinearOAuthCode|refreshLinearOAuthToken|oauth\/token|ClientSecretCredential)/u],
  ['readback', /(?:reconcil|readback|fetchLinearViewerIdentity|fetchLinearWorkspaceIdentity|requested_reviewers|check-runs)/iu],
  ['delivery_callback', /(?:deliverAuditedMessage\s*\(|deliverDirectMessage\s*\(|callbackSink\.deliver\s*\(|sourceReceiptSink)/u],
];

function packageSourceTarget(value, packageDirectory, files) {
  if (typeof value === 'string') {
    const path = posix.normalize(posix.join(packageDirectory, value));
    return SOURCE_EXTENSIONS.includes(extname(path)) && files.has(path) ? path : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const condition of ['development', 'source', 'import', 'default']) {
    const resolved = packageSourceTarget(value[condition], packageDirectory, files);
    if (resolved) return resolved;
  }
  return null;
}

function workspacePackageSources(files, readSource) {
  const packages = new Map();
  if (!files.has('pnpm-workspace.yaml')) return packages;
  const patterns = readSource('pnpm-workspace.yaml')
    .split(/\r?\n/u)
    .map((line) => /^\s*-\s*["']?([^"']+)["']?\s*$/u.exec(line)?.[1])
    .filter(Boolean);
  const manifests = [...files].filter((candidate) => {
    if (!candidate.endsWith('/package.json')) return false;
    const directory = dirname(candidate);
    return patterns.some((pattern) => {
      if (!pattern.endsWith('/*')) return directory === pattern;
      const prefix = pattern.slice(0, -1);
      return directory.startsWith(prefix) && !directory.slice(prefix.length).includes('/');
    });
  });
  for (const path of manifests.sort()) {
    let manifest;
    try {
      manifest = JSON.parse(readSource(path));
    } catch (error) {
      throw new Error(`Malformed exact-revision workspace manifest: ${path}`, { cause: error });
    }
    if (typeof manifest.name !== 'string') continue;
    const packageDirectory = dirname(path) === '.' ? '' : dirname(path);
    const exports = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports : {};
    const rootExport = exports['.'] ?? manifest.exports;
    const rootTarget =
      packageSourceTarget(rootExport, packageDirectory, files) ??
      SOURCE_EXTENSIONS.map((extension) => posix.join(packageDirectory, `src/index${extension}`)).find((candidate) =>
        files.has(candidate),
      );
    if (rootTarget) packages.set(manifest.name, rootTarget);
    for (const [subpath, value] of Object.entries(exports)) {
      if (!subpath.startsWith('./') || subpath.includes('*')) continue;
      const target = packageSourceTarget(value, packageDirectory, files);
      if (target) packages.set(`${manifest.name}/${subpath.slice(2)}`, target);
    }
  }
  return packages;
}

function resolveRelativeImport(from, specifier, files) {
  if (!specifier.startsWith('.')) return null;
  const imported = posix.normalize(posix.join(dirname(from), specifier));
  const extension = extname(imported);
  const extensionless = SOURCE_EXTENSIONS.includes(extension)
    ? imported.slice(0, -extension.length)
    : imported;
  const paths = SOURCE_EXTENSIONS.includes(extension)
    ? [imported, ...SOURCE_EXTENSIONS.map((sourceExtension) => `${extensionless}${sourceExtension}`)]
    : extname(imported)
      ? [imported]
    : [
        ...SOURCE_EXTENSIONS.map((sourceExtension) => `${imported}${sourceExtension}`),
        ...SOURCE_EXTENSIONS.map((sourceExtension) => posix.join(imported, `index${sourceExtension}`)),
      ];
  return paths.find((path) => files.has(path)) ?? null;
}

function staticImports(source) {
  return [...source.matchAll(IMPORT_PATTERN)]
    .map((match) => match[1] ?? match[2])
    .filter((value) => value !== undefined);
}

export function inventoryProviderIoRoots(input) {
  const revision = resolveCommit(input.repository, input.revision);
  const allFiles = new Set(listRevisionFiles(input.repository, revision));
  const entrypoints = [...new Set(input.entrypoints)].sort();
  for (const entrypoint of entrypoints) {
    assertSafeRepositoryPath(entrypoint);
    if (!allFiles.has(entrypoint)) throw new Error(`Entrypoint is absent at ${revision}: ${entrypoint}`);
  }

  const sourceCache = new Map();
  const readSource = (path) => {
    if (!sourceCache.has(path)) {
      sourceCache.set(path, readRevisionFile(input.repository, revision, path).toString('utf8'));
    }
    return sourceCache.get(path);
  };
  const packageSources = workspacePackageSources(allFiles, readSource);
  const candidateModules = new Set(entrypoints);
  const pending = [...entrypoints];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const specifier of staticImports(readSource(current))) {
      const resolved =
        resolveRelativeImport(current, specifier, allFiles) ?? packageSources.get(specifier) ?? null;
      if (resolved && !candidateModules.has(resolved)) {
        candidateModules.add(resolved);
        pending.push(resolved);
      }
    }
  }

  for (const path of input.requiredCandidates ?? []) {
    assertSafeRepositoryPath(path);
    if (!allFiles.has(path)) throw new Error(`Required candidate is absent at ${revision}: ${path}`);
    candidateModules.add(path);
  }

  const sortedCandidates = [...candidateModules].sort();
  const candidateFiles = sortedCandidates.map((path) => ({
    path,
    bytes: readRevisionFile(input.repository, revision, path),
  }));
  const roots = [];
  for (const { path, bytes } of candidateFiles) {
    const lines = bytes.toString('utf8').split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const [kind, pattern] of ROOT_RULES) {
        if (pattern.test(line)) roots.push({ path, line: index + 1, kind });
      }
    }
  }

  const inventory = {
    schemaVersion: 'ProviderIoRootInventoryV1',
    inventoryKind: 'candidate_inventory_only',
    dynamicReachabilityProven: false,
    revision,
    framing: {
      contentDigest: 'uint32be(path_utf8_bytes_length) || path_utf8_bytes || uint64be(content_bytes_length) || content_bytes',
      inventoryDigest: 'sha256 of UTF-8 JSON.stringify(inventory without inventoryDigest)',
    },
    candidateFileSetDigest: framedPathSetDigest(sortedCandidates),
    candidateContentDigest: framedContentDigest(candidateFiles),
    entrypoints,
    candidateModules: sortedCandidates,
    candidateFiles: candidateFiles.map(({ path, bytes }) => ({
      path,
      bytes: bytes.length,
      digest: sha256(bytes),
    })),
    roots,
    counts: {
      candidateModules: candidateModules.size,
      candidateBytes: candidateFiles.reduce((total, file) => total + file.bytes.length, 0),
      roots: roots.length,
    },
    exclusions: input.exclusions ?? [
      { pattern: '**/test/**', reason: 'test_only' },
      { pattern: '**/*.test.ts', reason: 'test_only' },
      { pattern: '**/dist/**', reason: 'generated_build_output' },
      { pattern: '**/node_modules/**', reason: 'third_party_dependency' },
    ],
    caveats: [
      'Static relative-import and exact-revision workspace package-export traversal plus reviewed required candidates do not prove dynamic registration reachability.',
      'Line matches are candidates for review; they do not prove that a Provider operation executes in production.',
    ],
    sourceRepository: 'opentag',
  };
  return {
    ...inventory,
    inventoryDigest: sha256(Buffer.from(JSON.stringify(inventory))),
  };
}

function parseCliArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key ?? '<end>'}`);
    values.set(key, value);
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseCliArguments(process.argv.slice(2));
  const manifestPath = args.get('--manifest');
  const config = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const entrypoints = (args.get('--entrypoints') ?? '').split(',').filter(Boolean);
  const requiredCandidates = (args.get('--required-candidates') ?? '').split(',').filter(Boolean);
  const inventory = inventoryProviderIoRoots({
    repository: args.get('--repository') ?? '.',
    revision: args.get('--revision') ?? config.revision ?? 'HEAD',
    entrypoints: entrypoints.length > 0 ? entrypoints : config.entrypoints ?? [],
    requiredCandidates:
      requiredCandidates.length > 0 ? requiredCandidates : config.requiredCandidates ?? [],
    exclusions: config.exclusions,
  });
  const expectedPath = args.get('--verify-against');
  if (expectedPath) {
    const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
    if (!isDeepStrictEqual(inventory, expected)) {
      throw new Error(`Generated inventory differs from checked-in evidence: ${expectedPath}`);
    }
    process.stdout.write(
      `${JSON.stringify({
        verified: true,
        revision: inventory.revision,
        counts: inventory.counts,
        inventoryDigest: inventory.inventoryDigest,
      })}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  }
}
