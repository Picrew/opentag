import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TASK4_BASE_REVISION,
  TASK4_BLOCKED_REASONS,
  TASK4_REGRESSION_SUITE_COMMAND,
  TASK4_SEMANTIC_INPUT_SPEC,
  TASK4_SEMANTIC_RUNNER_COMMAND,
  SemanticReceiptVerificationError,
  classifyTask4ProductionPath,
  collectTask4SemanticInputs,
  createTask4SemanticReceipt,
  evaluateTask4Gates,
  markTask4SemanticReceiptIncomplete,
  publishTask4SemanticReceipt,
  scanTask4SlackKernel,
  verifyTask4SemanticReceipt,
} from '../release/verify-slack-kernel-cutover.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

function semanticCases() {
  return {
    lifecycleRestartUpdate: {
      passed: true,
      createOutcome: 'accepted',
      updateOutcome: 'accepted',
      closeReopenCount: 1,
      createCount: 1,
      updateCount: 1,
      providerIoCount: 2,
      sameExternalResource: true,
    },
    sourceReceiptReaction: {
      passed: true,
      settlementOutcome: 'accepted',
      reactionCount: 1,
      providerIoCount: 1,
    },
    sourceThreadControl: {
      passed: true,
      settlementOutcome: 'accepted',
      canonicalIntentCount: 1,
      journalIntentCount: 1,
      providerIoCount: 1,
      provenanceKind: 'source_thread_control',
      inventedRunAuthority: false,
    },
    selfServiceIngress: {
      passed: true,
      ingressOutcome: 'processed',
      authenticatedCommandCount: 7,
      sharedSinkDeliveryCount: 7,
      canonicalIntentCount: 7,
      journalIntentCount: 7,
      settlementOutcome: 'accepted',
      providerIoCount: 7,
    },
    crossBinding: blockedCase(),
    crossTarget: blockedCase(),
    ambiguousLifecycle: blockedCase(),
  };
}

function blockedCase() {
  return {
    passed: true,
    producerOutcome: 'activation_blocked',
    credentialResolutionCount: 0,
    providerIoCount: 0,
  };
}

function semanticFixture() {
  const repository = mkdtempSync(join(tmpdir(), 'task4-semantic-verifier-'));
  const files = {
    source: join(repository, 'source.ts'),
    runner: join(repository, 'runner.ts'),
    verifier: join(repository, 'verifier.mjs'),
    test: join(repository, 'regression.test.ts'),
    receipt: join(repository, 'receipt.json'),
  };
  for (const [name, path] of Object.entries(files)) {
    if (name !== 'receipt') writeFileSync(path, `${name}\n`);
  }
  const inputSpec = {
    productionSources: [{ id: 'source', file: 'source.ts' }],
    tooling: [
      { id: 'semantic_runner', file: 'runner.ts' },
      { id: 'semantic_verifier', file: 'verifier.mjs' },
    ],
    regressionTests: [{ id: 'regression', file: 'regression.test.ts' }],
    semanticRunnerCommand: 'semantic runner',
    regressionSuiteCommand: 'regression suite',
  };
  const inputs = collectTask4SemanticInputs({ repository, inputSpec });
  const receipt = createTask4SemanticReceipt({
    baseRevision: TASK4_BASE_REVISION,
    acceptedInventoryDigest: digest,
    inputs,
    activation: {
      active: false,
      status: 'blocked',
      releaseStatus: 'non_releasable',
      reasons: TASK4_BLOCKED_REASONS,
      attemptedOverrideIgnored: true,
      producerOutcome: 'activation_blocked',
      deliveryJournalSqlCount: 0,
      credentialResolutionCount: 0,
      providerIoCount: 0,
    },
    cases: semanticCases(),
  });
  writeFileSync(files.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  return { repository, files, inputSpec, receipt };
}

test('fails closed on any legacy root or activation-capable surface', () => {
  const gates = evaluateTask4Gates({
    production: { addedNonblankLoc: 800, deletedNonblankLoc: 1200, netNonblankLoc: -400 },
    forbiddenRoots: [{ kind: 'legacy_callback_module', count: 1 }],
    architecture: { slackTransports: 1, deliveryStateMachines: 1, exactPairRegistries: 1 },
    activation: { active: false, releaseStatus: 'non_releasable', completeBlockedReasons: true },
    inventory: { revisionMatches: true, claim: 'candidate_inventory_only' },
    semanticReceipt: { passed: true },
  });

  assert.equal(gates.passed, false);
  assert.ok(gates.failures.some((failure) => failure.code === 'forbidden_legacy_roots'));
});

test('quantitative thresholds are immutable and candidate inventory is not production proof', () => {
  const gates = evaluateTask4Gates({
    production: { addedNonblankLoc: 1251, deletedNonblankLoc: 999, netNonblankLoc: -98 },
    forbiddenRoots: [],
    architecture: { slackTransports: 1, deliveryStateMachines: 1, exactPairRegistries: 1 },
    activation: { active: false, releaseStatus: 'non_releasable', completeBlockedReasons: true },
    inventory: { revisionMatches: true, claim: 'candidate_inventory_only' },
    semanticReceipt: { passed: true },
  });

  assert.deepEqual(
    gates.failures.map(({ code }) => code),
    ['gross_deletion_shortfall', 'production_addition_budget_exceeded', 'net_deletion_shortfall'],
  );
});

test('authorized Task 4 addition cap accepts 1250 lines without weakening other gates', () => {
  const gates = evaluateTask4Gates({
    production: { addedNonblankLoc: 1250, deletedNonblankLoc: 1350, netNonblankLoc: -100 },
    forbiddenRoots: [],
    architecture: { slackTransports: 1, deliveryStateMachines: 1, exactPairRegistries: 1 },
    activation: { active: false, releaseStatus: 'non_releasable', completeBlockedReasons: true },
    inventory: { revisionMatches: true, claim: 'candidate_inventory_only' },
    semanticReceipt: { passed: true },
  });

  assert.deepEqual(gates.failures, []);
  assert.equal(gates.passed, true);
});

test('scans only files present in the current artifact for forbidden roots', () => {
  const report = scanTask4SlackKernel({ repository: process.cwd() });

  assert.equal(report.baseRevision, TASK4_BASE_REVISION);
  assert.equal(report.inventory.claim, 'candidate_inventory_only');
  assert.equal(report.inventory.productionReachabilityProven, false);
  assert.equal(report.activation.active, false);
  assert.equal(report.activation.releaseStatus, 'non_releasable');
  assert.ok(report.categories.production.changedFiles > 0);
  assert.ok(report.productionScope.task4.changedFiles >= 24);
  assert.ok(report.productionScope.priorTask.changedFiles > 0);
  assert.equal(report.productionScope.unclassified.changedFiles, 0);
  assert.equal(
    report.forbiddenRoots.some(({ kind }) => kind === 'legacy_callback_module'),
    false,
  );
  assert.equal(report.gates.passed, true);
});

test('classifies every Task 4 production seam without absorbing the prior contract task', () => {
  for (const path of [
    'apps/github-probot/src/app.ts',
    'packages/cli/src/status.ts',
    'packages/client/src/index.ts',
    'packages/core/src/capability.ts',
    'packages/discord/src/interactions-app.ts',
    'packages/dispatcher/src/server.ts',
    'packages/lark/src/inbound.ts',
    'packages/local-runtime/src/dispatcher.ts',
    'packages/slack/src/events.ts',
    'packages/slack/src/ingress.ts',
    'packages/slack/src/socket-mode.ts',
    'packages/store/src/delivery-repository.ts',
  ]) {
    assert.equal(classifyTask4ProductionPath(path), 'task4', path);
  }
  assert.equal(
    classifyTask4ProductionPath('packages/delivery-contract/src/contracts.ts'),
    'prior_task',
  );
  assert.equal(classifyTask4ProductionPath('packages/runner/src/index.ts'), null);
});

test('pins the semantic harness and the exact nine regression inputs', () => {
  assert.deepEqual(
    TASK4_SEMANTIC_INPUT_SPEC.regressionTests.map(({ file }) => file),
    [
      'packages/dispatcher/test/delivery/side-effect-kernel.test.ts',
      'packages/dispatcher/test/delivery/provider-registry.test.ts',
      'packages/store/test/delivery-journal.test.ts',
      'packages/store/test/delivery-payload-custody.test.ts',
      'packages/slack/test/delivery-adapter.test.ts',
      'packages/dispatcher/test/delivery/slack-producers.test.ts',
      'packages/dispatcher/test/delivery/slack-restart-faults.test.ts',
      'packages/dispatcher/test/delivery/slack-lifecycle-composition.test.ts',
      'packages/dispatcher/test/delivery/activation-state.test.ts',
    ],
  );
  assert.equal(
    TASK4_SEMANTIC_INPUT_SPEC.semanticRunnerCommand,
    TASK4_SEMANTIC_RUNNER_COMMAND,
  );
  assert.equal(
    TASK4_SEMANTIC_INPUT_SPEC.regressionSuiteCommand,
    TASK4_REGRESSION_SUITE_COMMAND,
  );
  assert.ok(
    TASK4_SEMANTIC_INPUT_SPEC.productionSources.some(
      ({ file }) => file === 'packages/store/src/delivery-payload-custody.ts',
    ),
  );
  assert.deepEqual(
    TASK4_SEMANTIC_INPUT_SPEC.productionSources.find(
      ({ file }) => file === 'packages/dispatcher/src/callbacks.ts',
    ),
    {
      id: 'legacy_callbacks_absent',
      file: 'packages/dispatcher/src/callbacks.ts',
      expected: 'absent',
    },
  );
  const verifierSource = readFileSync(
    new URL('../release/verify-slack-kernel-cutover.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(verifierSource.match(/execFileSync\s*\(/gu)?.length, 1);
  assert.match(verifierSource, /return execFileSync\('git'/u);
  assert.doesNotMatch(verifierSource, /execFileSync\([^\n]*vitest/iu);
  assert.doesNotMatch(verifierSource, /(?:spawn|fork|execSync)\s*\(/u);
});

test('accepts only a closed, content-addressed semantic receipt over fresh inputs', () => {
  const fixture = semanticFixture();
  const verified = verifyTask4SemanticReceipt({
    repository: fixture.repository,
    receiptPath: 'receipt.json',
    baseRevision: TASK4_BASE_REVISION,
    acceptedInventoryDigest: digest,
    inputSpec: fixture.inputSpec,
  });

  assert.deepEqual(verified, {
    passed: true,
    status: 'implementation_evidence_only',
    productionReachabilityProven: false,
    allCasesPassed: true,
    receiptDigest: fixture.receipt.receiptDigest,
    inputsDigest: fixture.receipt.inputsDigest,
  });
  assert.doesNotMatch(JSON.stringify(verified), /(?:path|uri|stdout|channel|team|providerInstance|bindingDigest)/iu);
});

test('rejects missing, symlinked, malformed, incomplete, and open-schema receipts', () => {
  const fixture = semanticFixture();
  const verify = (receiptPath) => verifyTask4SemanticReceipt({
    repository: fixture.repository,
    receiptPath,
    baseRevision: TASK4_BASE_REVISION,
    acceptedInventoryDigest: digest,
    inputSpec: fixture.inputSpec,
  });

  assert.throws(() => verify('missing.json'), hasCode('semantic_receipt_missing'));
  symlinkSync(fixture.files.receipt, join(fixture.repository, 'receipt-link.json'));
  assert.throws(() => verify('receipt-link.json'), hasCode('semantic_receipt_symlink'));
  const realDirectory = join(fixture.repository, 'real');
  mkdirSync(realDirectory);
  writeFileSync(join(realDirectory, 'receipt.json'), JSON.stringify(fixture.receipt));
  symlinkSync(realDirectory, join(fixture.repository, 'linked'));
  assert.throws(
    () => verify('linked/receipt.json'),
    hasCode('semantic_receipt_symlink'),
  );
  writeFileSync(fixture.files.receipt, '{');
  assert.throws(() => verify('receipt.json'), hasCode('semantic_receipt_parse_failed'));
  writeFileSync(fixture.files.receipt, JSON.stringify({ schemaVersion: 'Task4SlackKernelSemanticReceiptIncompleteV1', status: 'incomplete' }));
  assert.throws(() => verify('receipt.json'), hasCode('semantic_receipt_incomplete'));
  writeFileSync(fixture.files.receipt, JSON.stringify({ ...fixture.receipt, unexpected: true }));
  assert.throws(() => verify('receipt.json'), hasCode('semantic_receipt_schema_invalid'));
});

test('rejects receipt, source, test, command, inventory, base, and case drift', () => {
  const mutations = [
    ['semantic_receipt_digest_mismatch', (fixture) => {
      fixture.receipt.receiptDigest = digest;
      writeFileSync(fixture.files.receipt, JSON.stringify(fixture.receipt));
    }],
    ['semantic_receipt_input_drift', (fixture) => writeFileSync(fixture.files.source, 'changed\n')],
    ['semantic_receipt_input_drift', (fixture) => writeFileSync(fixture.files.runner, 'changed\n')],
    ['semantic_receipt_input_drift', (fixture) => writeFileSync(fixture.files.test, 'changed\n')],
    ['semantic_receipt_input_drift', (fixture) => { fixture.inputSpec.semanticRunnerCommand = 'changed'; }],
    ['semantic_receipt_inventory_mismatch', (fixture) => { fixture.acceptedInventoryDigest = `sha256:${'b'.repeat(64)}`; }],
    ['semantic_receipt_base_mismatch', (fixture) => { fixture.baseRevision = 'f'.repeat(40); }],
    ['semantic_receipt_case_failed', (fixture) => {
      fixture.receipt.cases.crossTarget.passed = false;
      fixture.receipt = createTask4SemanticReceipt(fixture.receipt, { validate: false });
      writeFileSync(fixture.files.receipt, JSON.stringify(fixture.receipt));
    }],
  ];

  for (const [expectedCode, mutate] of mutations) {
    const fixture = semanticFixture();
    fixture.baseRevision = TASK4_BASE_REVISION;
    fixture.acceptedInventoryDigest = digest;
    mutate(fixture);
    assert.throws(
      () => verifyTask4SemanticReceipt({
        repository: fixture.repository,
        receiptPath: 'receipt.json',
        baseRevision: fixture.baseRevision,
        acceptedInventoryDigest: fixture.acceptedInventoryDigest,
        inputSpec: fixture.inputSpec,
      }),
      hasCode(expectedCode),
      expectedCode,
    );
  }
});

test('rejects privacy-unsafe evidence even when it is re-sealed', () => {
  const fixture = semanticFixture();
  const unsafe = {
    ...fixture.receipt,
    cases: {
      ...fixture.receipt.cases,
      selfServiceIngress: {
        ...fixture.receipt.cases.selfServiceIngress,
        stdout: 'https://slack.com/api/chat.postMessage',
      },
    },
  };
  const receipt = createTask4SemanticReceipt(unsafe, { validate: false });
  writeFileSync(fixture.files.receipt, JSON.stringify(receipt));

  assert.throws(
    () => verifyTask4SemanticReceipt({
      repository: fixture.repository,
      receiptPath: 'receipt.json',
      baseRevision: TASK4_BASE_REVISION,
      acceptedInventoryDigest: digest,
      inputSpec: fixture.inputSpec,
    }),
    hasCode('semantic_receipt_privacy_violation'),
  );
});

test('publishes through a fail-closed sentinel and leaves no partial receipt', () => {
  const fixture = semanticFixture();
  writeFileSync(fixture.files.receipt, 'stale-valid-evidence\n', { mode: 0o644 });

  markTask4SemanticReceiptIncomplete({
    repository: fixture.repository,
    receiptPath: 'receipt.json',
  });

  assert.deepEqual(JSON.parse(readFileSync(fixture.files.receipt, 'utf8')), {
    schemaVersion: 'Task4SlackKernelSemanticReceiptIncompleteV1',
    status: 'incomplete',
  });
  assert.equal(lstatSync(fixture.files.receipt).mode & 0o777, 0o600);

  const failed = createTask4SemanticReceipt(
    {
      ...fixture.receipt,
      cases: {
        ...fixture.receipt.cases,
        crossBinding: { ...fixture.receipt.cases.crossBinding, passed: false },
      },
    },
    { validate: false },
  );
  assert.throws(
    () =>
      publishTask4SemanticReceipt({
        repository: fixture.repository,
        receiptPath: 'receipt.json',
        receipt: failed,
      }),
    hasCode('semantic_receipt_case_failed'),
  );
  assert.equal(
    JSON.parse(readFileSync(fixture.files.receipt, 'utf8')).status,
    'incomplete',
  );

  publishTask4SemanticReceipt({
    repository: fixture.repository,
    receiptPath: 'receipt.json',
    receipt: fixture.receipt,
  });
  assert.deepEqual(
    JSON.parse(readFileSync(fixture.files.receipt, 'utf8')),
    fixture.receipt,
  );
  assert.equal(lstatSync(fixture.files.receipt).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(fixture.repository).filter((name) => name.includes('.pending-')),
    [],
  );
});

function hasCode(code) {
  return (error) => error instanceof SemanticReceiptVerificationError && error.code === code;
}
