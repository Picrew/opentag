import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { inventoryProviderIoRoots } from '../release/inventory-provider-io-roots.mjs';

const config = JSON.parse(
  readFileSync(new URL('../release/manifests/opentag-provider-io-roots.config.v1.json', import.meta.url), 'utf8'),
);
const expectedInventory = JSON.parse(
  readFileSync(new URL('../release/manifests/opentag-provider-io-roots.v1.json', import.meta.url), 'utf8'),
);

test('the exact accepted-base candidate inventory covers every required Provider I/O root family', () => {
  const inventory = inventoryProviderIoRoots({
    repository: process.cwd(),
    revision: config.revision,
    entrypoints: config.entrypoints,
    requiredCandidates: config.requiredCandidates,
    exclusions: config.exclusions,
  });
  const kinds = new Set(inventory.roots.map((root) => root.kind));
  for (const required of config.requiredRootKinds) assert.ok(kinds.has(required), `missing ${required} roots`);
  for (const required of config.requiredCandidates) {
    assert.ok(inventory.candidateModules.includes(required), `missing required candidate: ${required}`);
  }
  assert.equal(inventory.revision, config.revision);
  assert.equal(inventory.dynamicReachabilityProven, false);
  assert.equal(inventory.inventoryKind, 'candidate_inventory_only');
  assert.deepEqual(inventory.exclusions, config.exclusions);
  for (const required of [
    'apps/slack-events/src/index.ts',
    'packages/slack/src/index.ts',
    'packages/slack/src/dispatcher-events.ts',
    'packages/slack/src/events.ts',
    'packages/slack/src/ingress.ts',
    'packages/slack/src/socket-mode.ts',
  ]) {
    assert.ok(inventory.candidateModules.includes(required), `missing reachable Slack module: ${required}`);
  }
  assert.ok(
    inventory.roots.some((root) => root.path === 'packages/slack/src/dispatcher-events.ts' && root.kind === 'http'),
    'missing dispatcher-events HTTP root',
  );
  assert.ok(
    inventory.roots.some((root) => root.path === 'packages/slack/src/socket-mode.ts' && root.kind === 'http'),
    'missing socket-mode HTTP root',
  );
  assert.deepEqual(inventory, expectedInventory, 'checked-in exact-base inventory drifted; regenerate it');
});
