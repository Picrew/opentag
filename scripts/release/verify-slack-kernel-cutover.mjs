import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TASK4_BASE_REVISION = '92c41240ea1d1173cbc4affc6c94f8136c3dddd3';
export const TASK4_SEMANTIC_RECEIPT_PATH =
  '.superpowers/sdd/prd-unified-delivery-breaking-cutover/task-4-slack-kernel-semantic-receipt.json';
export const TASK4_SEMANTIC_RUNNER_COMMAND =
  'NODE_OPTIONS=--conditions=development corepack pnpm --dir apps/dispatcher exec tsx ../../scripts/test/task4-slack-kernel-semantic-receipt.ts --output ../../.superpowers/sdd/prd-unified-delivery-breaking-cutover/task-4-slack-kernel-semantic-receipt.json';

export const TASK4_BLOCKED_REASONS = Object.freeze([
  'full_provider_root_set_incomplete',
  'cloud_consumer_cutover_incomplete',
  'production_inventory_incomplete',
  'migration_incomplete',
  'operations_incomplete',
]);

const RECEIPT_SCHEMA = 'Task4SlackKernelSemanticReceiptV1';
const INCOMPLETE_RECEIPT_SCHEMA = 'Task4SlackKernelSemanticReceiptIncompleteV1';
const IMPLEMENTATION_STATUS = 'implementation_evidence_only';
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const INPUT_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_RECEIPT_BYTES = 256 * 1024;
const PRIVACY_FIELD = /^(?:path|uri|url|stdout|stderr|body|token|secret|credential|channelId|teamId|providerInstanceId|bindingDigest|externalResourceId|resourceId|threadTs|messageTs|timestamp|ts)$/iu;
const PRIVACY_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:ghp|glpat-|xox[baprs]|xapp-)[_A-Za-z0-9-]+|(?:^|[\\/])(?:Users|home|root|tmp|var)[\\/]|^[a-z][a-z0-9+.-]*:\/\/|^\d{1,20}\.\d{1,20}$)/iu;

const PRODUCTION_INPUTS = Object.freeze([
  ['github_probot_app', 'apps/github-probot/src/app.ts'],
  ['cli_service', 'packages/cli/src/service.ts'],
  ['cli_start', 'packages/cli/src/start.ts'],
  ['cli_status', 'packages/cli/src/status.ts'],
  ['cli_config', 'packages/cli/src/config.ts'],
  ['client_rpc', 'packages/client/src/index.ts'],
  ['core_capability', 'packages/core/src/capability.ts'],
  ['core_integration_protocol', 'packages/core/src/integration-protocol.ts'],
  ['core_protocol', 'packages/core/src/protocol.ts'],
  ['core_schema', 'packages/core/src/schema.ts'],
  ['delivery_contract_canonical_json', 'packages/delivery-contract/src/canonical-json.ts'],
  ['delivery_contract_contracts', 'packages/delivery-contract/src/contracts.ts'],
  ['delivery_contract_digest', 'packages/delivery-contract/src/digest.ts'],
  ['discord_interactions', 'packages/discord/src/interactions-app.ts'],
  ['activation_state', 'packages/dispatcher/src/delivery/activation-state.ts'],
  ['delivery_producer', 'packages/dispatcher/src/delivery/producer.ts'],
  ['provider_registry', 'packages/dispatcher/src/delivery/provider-registry.ts'],
  ['side_effect_kernel', 'packages/dispatcher/src/delivery/side-effect-kernel.ts'],
  ['slack_lifecycle_composition', 'packages/dispatcher/src/delivery/slack-lifecycle-composition.ts'],
  ['store_repository_adapter_absent', 'packages/dispatcher/src/delivery/store-repository-adapter.ts', 'absent'],
  ['dispatcher_index', 'packages/dispatcher/src/index.ts'],
  ['dispatcher_presentation', 'packages/dispatcher/src/presentation.ts'],
  ['dispatcher_server', 'packages/dispatcher/src/server.ts'],
  ['source_thread_control', 'packages/dispatcher/src/source-thread-control.ts'],
  [
    'legacy_callbacks_absent',
    'packages/dispatcher/src/callbacks.ts',
    'absent',
  ],
  ['lark_inbound', 'packages/lark/src/inbound.ts'],
  ['local_runtime_dispatcher', 'packages/local-runtime/src/dispatcher.ts'],
  ['slack_delivery_adapter', 'packages/slack/src/delivery-adapter.ts'],
  ['slack_dispatcher_events', 'packages/slack/src/dispatcher-events.ts'],
  ['slack_events', 'packages/slack/src/events.ts'],
  ['slack_index', 'packages/slack/src/index.ts'],
  ['slack_ingress', 'packages/slack/src/ingress.ts'],
  ['slack_normalize', 'packages/slack/src/normalize.ts'],
  ['slack_render', 'packages/slack/src/render.ts'],
  ['slack_socket_mode', 'packages/slack/src/socket-mode.ts'],
  ['delivery_repository', 'packages/store/src/delivery-repository.ts'],
  ['delivery_payload_custody', 'packages/store/src/delivery-payload-custody.ts'],
  ['delivery_schema', 'packages/store/src/delivery-schema.ts'],
  ['slack_installation_registry', 'packages/store/src/slack-installation-registry.ts'],
  ['store_index', 'packages/store/src/index.ts'],
  ['store_repository', 'packages/store/src/repository.ts'],
  ['store_schema', 'packages/store/src/schema.ts'],
]);

const REGRESSION_INPUTS = Object.freeze([
  ['side_effect_kernel_test', 'packages/dispatcher/test/delivery/side-effect-kernel.test.ts'],
  ['provider_registry_test', 'packages/dispatcher/test/delivery/provider-registry.test.ts'],
  ['delivery_journal_test', 'packages/store/test/delivery-journal.test.ts'],
  ['delivery_payload_custody_test', 'packages/store/test/delivery-payload-custody.test.ts'],
  ['slack_delivery_adapter_test', 'packages/slack/test/delivery-adapter.test.ts'],
  ['slack_producers_test', 'packages/dispatcher/test/delivery/slack-producers.test.ts'],
  ['slack_restart_faults_test', 'packages/dispatcher/test/delivery/slack-restart-faults.test.ts'],
  ['slack_lifecycle_composition_test', 'packages/dispatcher/test/delivery/slack-lifecycle-composition.test.ts'],
  ['activation_state_test', 'packages/dispatcher/test/delivery/activation-state.test.ts'],
]);

export const TASK4_REGRESSION_SUITE_COMMAND =
  `corepack pnpm exec vitest run ${REGRESSION_INPUTS.map(([, path]) => path).join(' ')}`;

export const TASK4_SEMANTIC_INPUT_SPEC = Object.freeze({
  productionSources: PRODUCTION_INPUTS.map(([id, file, expected]) => ({
    id,
    file,
    ...(expected ? { expected } : {}),
  })),
  tooling: [
    { id: 'semantic_runner', file: 'scripts/test/task4-slack-kernel-semantic-receipt.ts' },
    { id: 'semantic_verifier', file: 'scripts/release/verify-slack-kernel-cutover.mjs' },
    { id: 'accepted_inventory', file: 'scripts/release/manifests/opentag-provider-io-roots.v1.json' },
  ],
  regressionTests: REGRESSION_INPUTS.map(([id, file]) => ({ id, file })),
  semanticRunnerCommand: TASK4_SEMANTIC_RUNNER_COMMAND,
  regressionSuiteCommand: TASK4_REGRESSION_SUITE_COMMAND,
});

const THRESHOLDS = Object.freeze({
  minimumDeletedProductionNonblankLoc: 1000,
  maximumAddedProductionNonblankLoc: 1250,
  targetAddedProductionNonblankLoc: 1150,
  maximumNetProductionNonblankLoc: -100,
});

export class SemanticReceiptVerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SemanticReceiptVerificationError';
    this.code = code;
  }
}

function semanticError(code) {
  throw new SemanticReceiptVerificationError(code);
}

function git(repository, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function currentFiles(repository) {
  return git(repository, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
}

function baseFiles(repository, baseRevision) {
  return git(repository, ['ls-tree', '-r', '-z', '--name-only', baseRevision])
    .split('\0')
    .filter(Boolean)
    .sort();
}

function readBase(repository, baseRevision, path) {
  try {
    return git(repository, ['show', `${baseRevision}:${path}`]);
  } catch {
    return '';
  }
}

function readCurrent(repository, path) {
  const absolute = resolve(repository, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
}

function category(path) {
  if (/(?:^|\/)(?:test|tests|fixtures)(?:\/|$)|\.test\.[cm]?[jt]sx?$/u.test(path)) {
    return 'testsFixturesGenerated';
  }
  if (/^(?:scripts\/release|scripts\/test)\//u.test(path)) {
    return 'temporaryReleaseTooling';
  }
  if (classifyTask4ProductionPath(path) === 'task4') return 'production';
  return 'other';
}

export function classifyTask4ProductionPath(path) {
  if (/^packages\/delivery-contract\/src\//u.test(path)) return 'prior_task';
  if (
    /^(?:apps\/github-probot\/src\/app\.ts$|packages\/(?:cli|client|core|dispatcher|slack)\/src\/|packages\/discord\/src\/interactions-app\.ts$|packages\/lark\/src\/inbound\.ts$|packages\/local-runtime\/src\/dispatcher\.ts$|packages\/store\/src\/)/u.test(
      path,
    )
  ) {
    return 'task4';
  }
  return null;
}

function nonblankLines(value) {
  return value.split(/\r?\n/u).filter((line) => line.trim().length > 0);
}

function changedNonblankLoc(before, after) {
  const left = nonblankLines(before);
  const right = nonblankLines(after);
  const row = new Uint32Array(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex];
      row[rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? diagonal + 1
          : Math.max(row[rightIndex], row[rightIndex - 1]);
      diagonal = previous;
    }
  }
  const retained = row[right.length];
  return { added: right.length - retained, deleted: left.length - retained };
}

function scanChanges(repository, baseRevision) {
  const before = new Set(baseFiles(repository, baseRevision));
  const after = new Set(currentFiles(repository));
  const paths = [...new Set([...before, ...after])].sort();
  const totals = {
    production: emptyLocBucket(),
    testsFixturesGenerated: emptyLocBucket(),
    temporaryReleaseTooling: emptyLocBucket(),
    other: emptyLocBucket(),
  };
  for (const path of paths) {
    const oldSource = before.has(path) ? readBase(repository, baseRevision, path) : '';
    const newSource = after.has(path) ? readCurrent(repository, path) : '';
    if (oldSource === newSource) continue;
    const delta = changedNonblankLoc(oldSource, newSource);
    const bucket = totals[category(path)];
    bucket.addedNonblankLoc += delta.added;
    bucket.deletedNonblankLoc += delta.deleted;
    bucket.changedFiles += 1;
  }
  for (const value of Object.values(totals)) {
    value.netNonblankLoc = value.addedNonblankLoc - value.deletedNonblankLoc;
  }
  return totals;
}

function scanProductionScope(repository, baseRevision) {
  const changed = changedProductionPaths(repository, baseRevision);
  const summary = (paths) => ({
    changedFiles: paths.length,
    pathsDigest: domainDigest('opentag.task4.production-paths.v1', [...paths].sort()),
  });
  return {
    task4: summary(changed.filter((path) => classifyTask4ProductionPath(path) === 'task4')),
    priorTask: summary(changed.filter((path) => classifyTask4ProductionPath(path) === 'prior_task')),
    unclassified: summary(changed.filter((path) => classifyTask4ProductionPath(path) === null)),
  };
}

function changedProductionPaths(repository, baseRevision) {
  const before = new Set(baseFiles(repository, baseRevision));
  const after = new Set(currentFiles(repository));
  return [...new Set([...before, ...after])]
    .filter((path) => /^(?:apps|packages)\/[^/]+\/src\//u.test(path))
    .filter((path) => {
      const oldSource = before.has(path) ? readBase(repository, baseRevision, path) : '';
      const newSource = after.has(path) ? readCurrent(repository, path) : '';
      return oldSource !== newSource;
    })
    .sort();
}

function emptyLocBucket() {
  return {
    addedNonblankLoc: 0,
    deletedNonblankLoc: 0,
    netNonblankLoc: 0,
    changedFiles: 0,
  };
}

function productionSources(repository) {
  return currentFiles(repository)
    .filter(
      (path) =>
        /^(?:packages|apps)\/[^/]+\/src\//u.test(path) &&
        !/\.gen\.[cm]?[jt]sx?$/u.test(path),
    )
    .filter((path) => existsSync(resolve(repository, path)))
    .map((path) => ({ path, source: readCurrent(repository, path) }));
}

function scanForbiddenRoots(repository) {
  const counts = new Map();
  const record = (kind) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
  for (const file of productionSources(repository)) {
    const checks = [
      ['legacy_callback_module', file.path === 'packages/dispatcher/src/callbacks.ts'],
      [
        'legacy_callback_state',
        /callback_deliveries|callbackDeliver(?:y|ies)|CallbackSink|createSlackCallbackSink|claimCallbackDelivery|enqueueCallbackDelivery|markCallbackDelivery/u.test(
          file.source,
        ),
      ],
      ['legacy_composite_sink', /createCompositeSourceReceiptSink/u.test(file.source)],
      [
        'provider_id_only_lookup',
        /\.resolve\(\s*(?:intent\.)?providerId\s*\)/u.test(file.source),
      ],
      [
        'direct_slack_transport',
        file.path !== 'packages/slack/src/delivery-adapter.ts' &&
          /slack\.com\/api\/(?:chat\.(?:postMessage|update)|reactions\.add)/u.test(
            file.source,
          ) &&
          /(?:\bfetch\s*\(|\.apiCall\s*\(|\.chat\.(?:postMessage|update)\s*\(|\.reactions\.add\s*\()/u.test(
            file.source,
          ),
      ],
    ];
    for (const [kind, matched] of checks) if (matched) record(kind);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({ kind, count }));
}

function countArchitecture(repository) {
  const sources = productionSources(repository);
  const countFiles = (pattern) =>
    sources.filter(({ source }) => pattern.test(source)).length;
  return {
    slackTransports: countFiles(
      /class SlackDeliveryAdapter|function createSlackDeliveryAdapter/u,
    ),
    deliveryStateMachines: countFiles(
      /CREATE TABLE(?: IF NOT EXISTS)? delivery_attempts/iu,
    ),
    exactPairRegistries: countFiles(/class ProviderAdapterRegistry/u),
  };
}

function scanActivation(repository) {
  const source = readCurrent(
    repository,
    'packages/dispatcher/src/delivery/activation-state.ts',
  );
  return {
    active: false,
    status: 'blocked',
    releaseStatus: 'non_releasable',
    reasons: TASK4_BLOCKED_REASONS,
    completeBlockedReasons:
      TASK4_BLOCKED_REASONS.every((reason) => source.includes(`'${reason}'`)) &&
      /_attemptedOverride\?: unknown/u.test(source) &&
      /return BLOCKED_STATE/u.test(source),
  };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new TypeError('Unsupported canonical JSON value');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function domainDigest(domain, value) {
  return sha256(`${domain}\0${canonicalJson(value)}`);
}

function commandDigest(command) {
  return sha256(`opentag.task4.semantic-command.v1\0${command}`);
}

function fileDigest(repository, input) {
  if (!INPUT_ID.test(input.id) || typeof input.file !== 'string') {
    semanticError('semantic_receipt_input_spec_invalid');
  }
  const absolute = containedPath(repository, input.file);
  assertNoSymlinkComponents(
    repository,
    absolute,
    'semantic_receipt_input_drift',
  );
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    if (input.expected === 'absent') {
      return {
        id: input.id,
        digest: domainDigest('opentag.task4.absent-source.v1', input.id),
      };
    }
    semanticError('semantic_receipt_input_drift');
  }
  if (input.expected === 'absent') semanticError('semantic_receipt_input_drift');
  if (input.expected !== undefined) {
    semanticError('semantic_receipt_input_spec_invalid');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    semanticError('semantic_receipt_input_drift');
  }
  return { id: input.id, digest: sha256(readFileSync(absolute)) };
}

function containedPath(repository, path) {
  if (typeof path !== 'string' || path.length === 0) {
    semanticError('semantic_receipt_location_invalid');
  }
  const root = resolve(repository);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    semanticError('semantic_receipt_location_invalid');
  }
  return absolute;
}

function assertNoSymlinkComponents(repository, absolute, code) {
  const root = resolve(repository);
  const child = relative(root, absolute);
  let current = root;
  for (const segment of child.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) semanticError(code);
    } catch (error) {
      if (error instanceof SemanticReceiptVerificationError) throw error;
      return;
    }
  }
}

export function collectTask4SemanticInputs({
  repository,
  inputSpec = TASK4_SEMANTIC_INPUT_SPEC,
}) {
  const root = resolve(repository);
  if (inputSpec === TASK4_SEMANTIC_INPUT_SPEC) {
    assertTask4SemanticSourceCoverage(root, TASK4_BASE_REVISION, inputSpec);
  }
  const inputs = {
    productionSources: inputSpec.productionSources.map((input) =>
      fileDigest(root, input),
    ),
    tooling: inputSpec.tooling.map((input) => fileDigest(root, input)),
    regressionTests: inputSpec.regressionTests.map((input) =>
      fileDigest(root, input),
    ),
    semanticRunnerCommandDigest: commandDigest(inputSpec.semanticRunnerCommand),
    regressionSuiteCommandDigest: commandDigest(
      inputSpec.regressionSuiteCommand,
    ),
  };
  assertUniqueInputIds(inputs);
  return inputs;
}

function assertTask4SemanticSourceCoverage(repository, baseRevision, inputSpec) {
  const declared = new Map(
    inputSpec.productionSources.map((input) => [input.file, input.expected]),
  );
  for (const path of changedProductionPaths(repository, baseRevision)) {
    if (classifyTask4ProductionPath(path) !== 'task4') continue;
    const expected = declared.get(path);
    const exists = existsSync(resolve(repository, path));
    if (
      expected === undefined && !declared.has(path) ||
      (exists && expected === 'absent') ||
      (!exists && expected !== 'absent')
    ) {
      semanticError('semantic_receipt_source_coverage_drift');
    }
  }
}

function assertUniqueInputIds(inputs) {
  const ids = [
    ...inputs.productionSources,
    ...inputs.tooling,
    ...inputs.regressionTests,
  ].map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    semanticError('semantic_receipt_input_spec_invalid');
  }
}

function receiptBody(input) {
  const body = {
    schemaVersion: RECEIPT_SCHEMA,
    status: IMPLEMENTATION_STATUS,
    productionReachabilityProven: false,
    baseRevision: input.baseRevision,
    acceptedInventoryDigest: input.acceptedInventoryDigest,
    inputs: input.inputs,
    inputsDigest: domainDigest('opentag.task4.semantic-inputs.v1', input.inputs),
    activation: input.activation,
    cases: input.cases,
    allCasesPassed: Object.values(input.cases).every(
      (entry) => isRecord(entry) && entry.passed === true,
    ),
  };
  return body;
}

export function createTask4SemanticReceipt(input, { validate = true } = {}) {
  const body = receiptBody(input);
  const receipt = {
    ...body,
    receiptDigest: domainDigest('opentag.task4.semantic-receipt.v1', body),
  };
  if (validate) validateSemanticReceiptSchema(receipt);
  return receipt;
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, keys) {
  if (!isRecord(value)) semanticError('semantic_receipt_schema_invalid');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    semanticError('semantic_receipt_schema_invalid');
  }
}

function assertBoolean(value) {
  if (typeof value !== 'boolean') semanticError('semantic_receipt_schema_invalid');
}

function assertCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    semanticError('semantic_receipt_schema_invalid');
  }
}

function validateInputArray(value) {
  if (!Array.isArray(value) || value.length === 0) {
    semanticError('semantic_receipt_schema_invalid');
  }
  for (const input of value) {
    exactKeys(input, ['id', 'digest']);
    if (!INPUT_ID.test(input.id) || !SHA256.test(input.digest)) {
      semanticError('semantic_receipt_schema_invalid');
    }
  }
}

function validateActivation(value) {
  exactKeys(value, [
    'active',
    'status',
    'releaseStatus',
    'reasons',
    'attemptedOverrideIgnored',
    'producerOutcome',
    'deliveryJournalSqlCount',
    'credentialResolutionCount',
    'providerIoCount',
  ]);
  assertBoolean(value.active);
  assertBoolean(value.attemptedOverrideIgnored);
  assertCount(value.deliveryJournalSqlCount);
  assertCount(value.credentialResolutionCount);
  assertCount(value.providerIoCount);
  if (!Array.isArray(value.reasons) || value.reasons.some((item) => typeof item !== 'string')) {
    semanticError('semantic_receipt_schema_invalid');
  }
}

function validateCases(cases) {
  exactKeys(cases, [
    'lifecycleRestartUpdate',
    'sourceReceiptReaction',
    'sourceThreadControl',
    'selfServiceIngress',
    'crossBinding',
    'crossTarget',
    'ambiguousLifecycle',
  ]);
  exactKeys(cases.lifecycleRestartUpdate, [
    'passed',
    'createOutcome',
    'updateOutcome',
    'closeReopenCount',
    'createCount',
    'updateCount',
    'providerIoCount',
    'sameExternalResource',
  ]);
  for (const key of ['passed', 'sameExternalResource']) {
    assertBoolean(cases.lifecycleRestartUpdate[key]);
  }
  for (const key of [
    'closeReopenCount',
    'createCount',
    'updateCount',
    'providerIoCount',
  ]) {
    assertCount(cases.lifecycleRestartUpdate[key]);
  }
  exactKeys(cases.sourceReceiptReaction, [
    'passed',
    'settlementOutcome',
    'reactionCount',
    'providerIoCount',
  ]);
  assertBoolean(cases.sourceReceiptReaction.passed);
  assertCount(cases.sourceReceiptReaction.reactionCount);
  assertCount(cases.sourceReceiptReaction.providerIoCount);
  exactKeys(cases.sourceThreadControl, [
    'passed',
    'settlementOutcome',
    'canonicalIntentCount',
    'journalIntentCount',
    'providerIoCount',
    'provenanceKind',
    'inventedRunAuthority',
  ]);
  assertBoolean(cases.sourceThreadControl.passed);
  assertBoolean(cases.sourceThreadControl.inventedRunAuthority);
  for (const key of [
    'canonicalIntentCount',
    'journalIntentCount',
    'providerIoCount',
  ]) {
    assertCount(cases.sourceThreadControl[key]);
  }
  exactKeys(cases.selfServiceIngress, [
    'passed',
    'ingressOutcome',
    'authenticatedCommandCount',
    'sharedSinkDeliveryCount',
    'canonicalIntentCount',
    'journalIntentCount',
    'settlementOutcome',
    'providerIoCount',
  ]);
  assertBoolean(cases.selfServiceIngress.passed);
  for (const key of [
    'authenticatedCommandCount',
    'sharedSinkDeliveryCount',
    'canonicalIntentCount',
    'journalIntentCount',
    'providerIoCount',
  ]) {
    assertCount(cases.selfServiceIngress[key]);
  }
  for (const key of ['crossBinding', 'crossTarget', 'ambiguousLifecycle']) {
    const value = cases[key];
    exactKeys(value, [
      'passed',
      'producerOutcome',
      'credentialResolutionCount',
      'providerIoCount',
    ]);
    assertBoolean(value.passed);
    assertCount(value.credentialResolutionCount);
    assertCount(value.providerIoCount);
  }
}

function validateSemanticReceiptSchema(receipt) {
  exactKeys(receipt, [
    'schemaVersion',
    'status',
    'productionReachabilityProven',
    'baseRevision',
    'acceptedInventoryDigest',
    'inputs',
    'inputsDigest',
    'activation',
    'cases',
    'allCasesPassed',
    'receiptDigest',
  ]);
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA ||
    receipt.status !== IMPLEMENTATION_STATUS ||
    receipt.productionReachabilityProven !== false ||
    !REVISION.test(receipt.baseRevision) ||
    !SHA256.test(receipt.acceptedInventoryDigest) ||
    !SHA256.test(receipt.inputsDigest) ||
    !SHA256.test(receipt.receiptDigest)
  ) {
    semanticError('semantic_receipt_schema_invalid');
  }
  assertBoolean(receipt.allCasesPassed);
  exactKeys(receipt.inputs, [
    'productionSources',
    'tooling',
    'regressionTests',
    'semanticRunnerCommandDigest',
    'regressionSuiteCommandDigest',
  ]);
  validateInputArray(receipt.inputs.productionSources);
  validateInputArray(receipt.inputs.tooling);
  validateInputArray(receipt.inputs.regressionTests);
  if (
    !SHA256.test(receipt.inputs.semanticRunnerCommandDigest) ||
    !SHA256.test(receipt.inputs.regressionSuiteCommandDigest)
  ) {
    semanticError('semantic_receipt_schema_invalid');
  }
  assertUniqueInputIds(receipt.inputs);
  validateActivation(receipt.activation);
  validateCases(receipt.cases);
}

function assertPrivacySafe(value) {
  if (Array.isArray(value)) {
    for (const child of value) assertPrivacySafe(child);
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === 'string' && PRIVACY_VALUE.test(value)) {
      semanticError('semantic_receipt_privacy_violation');
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PRIVACY_FIELD.test(key)) semanticError('semantic_receipt_privacy_violation');
    assertPrivacySafe(child);
  }
}

function assertCasesPassed(receipt) {
  const expected = {
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
    cases: {
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
      crossBinding: blockedSemanticCase(),
      crossTarget: blockedSemanticCase(),
      ambiguousLifecycle: blockedSemanticCase(),
    },
  };
  if (
    receipt.allCasesPassed !== true ||
    canonicalJson(receipt.activation) !== canonicalJson(expected.activation) ||
    canonicalJson(receipt.cases) !== canonicalJson(expected.cases)
  ) {
    semanticError('semantic_receipt_case_failed');
  }
}

function assertReceiptSelfConsistent(receipt) {
  const expectedInputsDigest = domainDigest(
    'opentag.task4.semantic-inputs.v1',
    receipt.inputs,
  );
  if (receipt.inputsDigest !== expectedInputsDigest) {
    semanticError('semantic_receipt_input_drift');
  }
  const { receiptDigest, ...body } = receipt;
  if (
    receiptDigest !==
    domainDigest('opentag.task4.semantic-receipt.v1', body)
  ) {
    semanticError('semantic_receipt_digest_mismatch');
  }
}

function atomicWritePrivateJson(absolute, value) {
  const pending = `${absolute}.pending-${process.pid}-${createHash('sha256')
    .update(String(process.hrtime.bigint()))
    .digest('hex')
    .slice(0, 16)}`;
  let descriptor;
  try {
    descriptor = openSync(pending, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(pending, absolute);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(pending, { force: true });
  }
}

function writeIncompletePrivateJson(absolute) {
  let descriptor;
  try {
    descriptor = openSync(
      absolute,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        schemaVersion: INCOMPLETE_RECEIPT_SCHEMA,
        status: 'incomplete',
      })}\n`,
      'utf8',
    );
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function markTask4SemanticReceiptIncomplete({
  repository,
  receiptPath = TASK4_SEMANTIC_RECEIPT_PATH,
}) {
  const root = resolve(repository);
  const absolute = containedPath(root, receiptPath);
  assertNoSymlinkComponents(root, absolute, 'semantic_receipt_symlink');
  if (existsSync(absolute)) {
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) semanticError('semantic_receipt_symlink');
    if (!stats.isFile()) semanticError('semantic_receipt_invalid_file');
  }
  mkdirSync(dirname(absolute), { recursive: true });
  assertNoSymlinkComponents(root, absolute, 'semantic_receipt_symlink');
  writeIncompletePrivateJson(absolute);
}

export function publishTask4SemanticReceipt({
  repository,
  receiptPath = TASK4_SEMANTIC_RECEIPT_PATH,
  receipt,
}) {
  const root = resolve(repository);
  const absolute = containedPath(root, receiptPath);
  assertNoSymlinkComponents(root, absolute, 'semantic_receipt_symlink');
  let current;
  try {
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) semanticError('semantic_receipt_symlink');
    if (!stats.isFile()) semanticError('semantic_receipt_invalid_file');
    current = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    if (error instanceof SemanticReceiptVerificationError) throw error;
    semanticError('semantic_receipt_incomplete_sentinel_missing');
  }
  if (
    !isRecord(current) ||
    canonicalJson(current) !==
      canonicalJson({
        schemaVersion: INCOMPLETE_RECEIPT_SCHEMA,
        status: 'incomplete',
      })
  ) {
    semanticError('semantic_receipt_incomplete_sentinel_missing');
  }
  assertPrivacySafe(receipt);
  validateSemanticReceiptSchema(receipt);
  assertReceiptSelfConsistent(receipt);
  assertCasesPassed(receipt);
  atomicWritePrivateJson(absolute, receipt);
}

function blockedSemanticCase() {
  return {
    passed: true,
    producerOutcome: 'activation_blocked',
    credentialResolutionCount: 0,
    providerIoCount: 0,
  };
}

export function verifyTask4SemanticReceipt({
  repository,
  receiptPath = TASK4_SEMANTIC_RECEIPT_PATH,
  baseRevision = TASK4_BASE_REVISION,
  acceptedInventoryDigest,
  inputSpec = TASK4_SEMANTIC_INPUT_SPEC,
}) {
  const root = resolve(repository);
  const absolute = containedPath(root, receiptPath);
  assertNoSymlinkComponents(root, absolute, 'semantic_receipt_symlink');
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    semanticError('semantic_receipt_missing');
  }
  if (stats.isSymbolicLink()) semanticError('semantic_receipt_symlink');
  if (!stats.isFile() || stats.size > MAX_RECEIPT_BYTES) {
    semanticError('semantic_receipt_invalid_file');
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    semanticError('semantic_receipt_parse_failed');
  }
  if (
    isRecord(receipt) &&
    (receipt.schemaVersion === INCOMPLETE_RECEIPT_SCHEMA || receipt.status === 'incomplete')
  ) {
    semanticError('semantic_receipt_incomplete');
  }
  assertPrivacySafe(receipt);
  validateSemanticReceiptSchema(receipt);
  if (receipt.baseRevision !== baseRevision) {
    semanticError('semantic_receipt_base_mismatch');
  }
  if (receipt.acceptedInventoryDigest !== acceptedInventoryDigest) {
    semanticError('semantic_receipt_inventory_mismatch');
  }
  const freshInputs = collectTask4SemanticInputs({ repository: root, inputSpec });
  const freshInputsDigest = domainDigest(
    'opentag.task4.semantic-inputs.v1',
    freshInputs,
  );
  if (
    canonicalJson(receipt.inputs) !== canonicalJson(freshInputs) ||
    receipt.inputsDigest !== freshInputsDigest
  ) {
    semanticError('semantic_receipt_input_drift');
  }
  assertReceiptSelfConsistent(receipt);
  const { receiptDigest } = receipt;
  assertCasesPassed(receipt);
  return {
    passed: true,
    status: IMPLEMENTATION_STATUS,
    productionReachabilityProven: false,
    allCasesPassed: true,
    receiptDigest,
    inputsDigest: freshInputsDigest,
  };
}

export function evaluateTask4Gates(input) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });
  if (
    input.production.deletedNonblankLoc <
    THRESHOLDS.minimumDeletedProductionNonblankLoc
  ) {
    fail('gross_deletion_shortfall', input.production);
  }
  if (
    input.production.addedNonblankLoc >
    THRESHOLDS.maximumAddedProductionNonblankLoc
  ) {
    fail('production_addition_budget_exceeded', input.production);
  }
  if (
    input.production.netNonblankLoc > THRESHOLDS.maximumNetProductionNonblankLoc
  ) {
    fail('net_deletion_shortfall', input.production);
  }
  if (input.forbiddenRoots.length > 0) {
    fail('forbidden_legacy_roots', input.forbiddenRoots);
  }
  if (input.architecture.slackTransports !== 1) {
    fail('slack_transport_count', input.architecture.slackTransports);
  }
  if (input.architecture.deliveryStateMachines !== 1) {
    fail('delivery_state_machine_count', input.architecture.deliveryStateMachines);
  }
  if (input.architecture.exactPairRegistries !== 1) {
    fail('exact_pair_registry_count', input.architecture.exactPairRegistries);
  }
  if (
    input.activation.active ||
    input.activation.releaseStatus !== 'non_releasable' ||
    !input.activation.completeBlockedReasons
  ) {
    fail('activation_not_blocked', input.activation);
  }
  if (!input.inventory.revisionMatches) {
    fail('accepted_inventory_revision_mismatch', input.inventory);
  }
  if (input.productionScope?.unclassified.changedFiles > 0) {
    fail('unclassified_production_changes', input.productionScope.unclassified);
  }
  if (!input.semanticReceipt?.passed) {
    fail('semantic_delivery_receipt_failed', input.semanticReceipt);
  }
  return { passed: failures.length === 0, failures };
}

export function scanTask4SlackKernel({
  repository,
  baseRevision = TASK4_BASE_REVISION,
  inventoryPath = 'scripts/release/manifests/opentag-provider-io-roots.v1.json',
  semanticReceiptPath = TASK4_SEMANTIC_RECEIPT_PATH,
} = {}) {
  const resolvedRepository = resolve(repository ?? process.cwd());
  const exactBase = git(resolvedRepository, [
    'rev-parse',
    '--verify',
    `${baseRevision}^{commit}`,
  ]).trim();
  if (exactBase !== TASK4_BASE_REVISION) {
    throw new Error(`Task 4 base must be ${TASK4_BASE_REVISION}`);
  }
  const inventory = JSON.parse(
    readFileSync(resolve(resolvedRepository, inventoryPath), 'utf8'),
  );
  const categories = scanChanges(resolvedRepository, exactBase);
  const productionScope = scanProductionScope(resolvedRepository, exactBase);
  let semanticReceipt;
  try {
    semanticReceipt = verifyTask4SemanticReceipt({
      repository: resolvedRepository,
      receiptPath: semanticReceiptPath,
      baseRevision: exactBase,
      acceptedInventoryDigest: inventory.inventoryDigest,
    });
  } catch (error) {
    semanticReceipt = {
      passed: false,
      status: IMPLEMENTATION_STATUS,
      productionReachabilityProven: false,
      errorCode:
        error instanceof SemanticReceiptVerificationError
          ? error.code
          : 'semantic_receipt_verification_failed',
    };
  }
  const report = {
    schemaVersion: 'Task4SlackKernelScanV1',
    baseRevision: exactBase,
    status: IMPLEMENTATION_STATUS,
    productionReachabilityProven: false,
    categories,
    productionScope,
    forbiddenRoots: scanForbiddenRoots(resolvedRepository),
    architecture: countArchitecture(resolvedRepository),
    activation: scanActivation(resolvedRepository),
    inventory: {
      revision: inventory.revision,
      revisionMatches: inventory.revision === exactBase,
      digest: inventory.inventoryDigest,
      claim: 'candidate_inventory_only',
      productionReachabilityProven: false,
    },
    semanticReceipt,
    thresholds: THRESHOLDS,
  };
  report.gates = evaluateTask4Gates({
    production: categories.production,
    forbiddenRoots: report.forbiddenRoots,
    architecture: report.architecture,
    activation: report.activation,
    inventory: report.inventory,
    productionScope,
    semanticReceipt,
  });
  return report;
}

function parseCli(argv) {
  const options = {};
  const names = new Map([
    ['--base-revision', 'baseRevision'],
    ['--accepted-inventory', 'inventoryPath'],
    ['--semantic-receipt', 'semanticReceiptPath'],
    ['--report', 'reportPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    options[key] = argv[index + 1];
    index += 1;
  }
  return options;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const options = parseCli(process.argv.slice(2));
  const report = scanTask4SlackKernel({
    repository: process.cwd(),
    ...options,
  });
  if (options.reportPath) {
    const reportPath = resolve(process.cwd(), options.reportPath);
    mkdirSync(dirname(reportPath), { recursive: true });
    atomicWritePrivateJson(reportPath, report);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.gates.passed) process.exitCode = 1;
}
