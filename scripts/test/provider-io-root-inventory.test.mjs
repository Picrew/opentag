import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { framedPathSetDigest } from '../release/git-object-reader.mjs';
import { inventoryProviderIoRoots } from '../release/inventory-provider-io-roots.mjs';

function fixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), 'opentag-provider-roots-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'entry.ts'), "import { send } from './provider.js';\nsend();\n");
  writeFileSync(join(root, 'provider.ts'), "export async function send() { return fetch('https://example.test'); }\n");
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

function workspaceFixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), 'opentag-workspace-roots-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('mkdir', ['-p', 'apps/ingress/src', 'packages/provider/src'], {
    cwd: root,
  });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeFileSync(
    join(root, 'apps/ingress/package.json'),
    JSON.stringify({ name: '@fixture/ingress', dependencies: { '@fixture/provider': 'workspace:*' } }),
  );
  writeFileSync(
    join(root, 'packages/provider/package.json'),
    JSON.stringify({
      name: '@fixture/provider',
      exports: {
        '.': { development: './src/index.ts', import: './dist/index.js' },
        './direct': { development: './src/direct.ts', import: './dist/direct.js' },
      },
    }),
  );
  writeFileSync(
    join(root, 'packages/provider/src/index.ts'),
    "export { start } from './transport.js';\n",
  );
  writeFileSync(
    join(root, 'packages/provider/src/transport.ts'),
    "export function start() { return fetch('https://example.test'); }\n",
  );
  writeFileSync(
    join(root, 'packages/provider/src/direct.ts'),
    "export function direct() { return fetch('https://direct.example.test'); }\n",
  );
  writeFileSync(
    join(root, 'apps/ingress/src/index.ts'),
    "import { start } from '@fixture/provider';\nimport { direct } from '@fixture/provider/direct';\nstart(); direct();\n",
  );
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

test('inventories exact revision bytes and labels static reachability as candidate-only', () => {
  const repository = fixtureRepository();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  writeFileSync(join(repository, 'provider.ts'), 'throw new Error("dirty replacement");\n');

  const inventory = inventoryProviderIoRoots({ repository, revision, entrypoints: ['entry.ts'] });

  assert.equal(inventory.revision, revision);
  assert.equal(inventory.inventoryKind, 'candidate_inventory_only');
  assert.equal(inventory.dynamicReachabilityProven, false);
  assert.deepEqual(inventory.candidateModules, ['entry.ts', 'provider.ts']);
  assert.deepEqual(inventory.roots.map((root) => root.kind), ['http']);
  assert.equal(JSON.stringify(inventory).includes(repository), false);
});

test('fails closed on malformed exact-revision workspace package manifests', () => {
  const repository = workspaceFixtureRepository();
  writeFileSync(join(repository, 'packages/provider/package.json'), '{ malformed');
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'malformed manifest'], { cwd: repository });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

  assert.throws(
    () => inventoryProviderIoRoots({ repository, revision, entrypoints: ['apps/ingress/src/index.ts'] }),
    /malformed exact-revision workspace manifest.*packages\/provider\/package\.json/iu,
  );
});

test('length-frames candidate paths so embedded newlines cannot collide', () => {
  assert.notEqual(framedPathSetDigest(['a\nb']), framedPathSetDigest(['a', 'b']));
});

test('traverses package-name imports through exact-revision workspace package metadata', () => {
  const repository = workspaceFixtureRepository();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();

  const inventory = inventoryProviderIoRoots({
    repository,
    revision,
    entrypoints: ['apps/ingress/src/index.ts'],
  });

  assert.deepEqual(inventory.candidateModules, [
    'apps/ingress/src/index.ts',
    'packages/provider/src/direct.ts',
    'packages/provider/src/index.ts',
    'packages/provider/src/transport.ts',
  ]);
  assert.deepEqual(inventory.roots, [
    { path: 'packages/provider/src/direct.ts', line: 1, kind: 'http' },
    { path: 'packages/provider/src/transport.ts', line: 1, kind: 'http' },
  ]);
});
