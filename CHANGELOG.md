# Changelog

## Unreleased

OpenTag now applies a zero-config verified completion tier to GitHub-backed
runs. When a run ships a pull request and the repository has no explicit
completion policy, the run stays open after executor success until GitHub
webhook evidence verifies that the pull request exists and every observed
check passes on the current head. Runs that ship no pull request keep
executor-success semantics.

### Added

- A default `governed` completion contract for GitHub-backed pull-request runs
  without a configured completion policy, gating completion on a verified
  pull-request artifact and an all-observed-checks-passing rollup, without
  requiring merge.
- A `source_control.observed_checks_rollup` verified evidence fact derived
  from every reconciled GitHub pull-request snapshot, aggregating observed
  check states into one passed/failed/pending outcome.
- A compatibility thread that starts with informational runs upgrades to the
  default verified contract when a later run in the same WorkThread ships a
  pull request.
- Opt-out and plumbing: `defaultGitHubCompletion` on the dispatcher app and
  local runtime, the daemon config field `daemon.defaultGitHubCompletion`, and
  the `OPENTAG_GITHUB_DEFAULT_COMPLETION` environment variable (`governed`
  default, `compat` preserves legacy executor-success semantics).

### Compatibility and migration

- Existing explicit completion policies are unchanged and still take
  precedence for their repositories.
- Runs that do not produce a pull request, non-GitHub runs, and threads with
  an existing governed contract behave exactly as before.
- To restore the previous default for pull-request runs, set
  `OPENTAG_GITHUB_DEFAULT_COMPLETION=compat` or
  `daemon.defaultGitHubCompletion: "compat"`.

## v0.9.0 - 2026-07-28

OpenTag 0.9.0 adds a read-only Linear project-backlog query to the Slack source
thread without turning Linear into an internal planning system or silently
starting agent work. Authorized channels can request `@OpenTag /linear`, receive
an ordered backlog summary in the same thread, and safely retry a failed or
interrupted query. Existing run creation, approval, binding, and mutation paths
retain their prior delivery semantics.

### Added

- A public `@opentag/linear` backlog query that fetches every unfinished issue
  page within fixed time and page bounds, validates the Linear response, and
  orders the complete result by workflow state, priority, and issue identifier.
- Slack parsing and rendering for the exact `@OpenTag /linear` and
  `@OpenTag linear` commands, including project name, issue state and priority,
  safe links, query time, and an explicit display limit.
- Additive CLI configuration, startup, and doctor support for exact
  `(teamId, channelId) -> projectId` query authorization and a query-only
  `platforms.linear.connections.default.token` credential.

### Changed

- Only read-only `/linear` queries use a dedicated bounded asynchronous Slack
  Events API lane. Run creation, stop, bind/unbind, approvals, and interactive
  actions remain synchronous so a processing failure is not acknowledged as a
  successful control-plane delivery.
- Linear backlog queries read the live OAuth token when available, complete
  pagination before applying the global display order, and fail closed when the
  mapped project is missing, inaccessible, over the page bound, or over the
  request deadline.

### Fixed

- Slack-controlled and Linear-controlled text and URLs are escaped before
  rendering so issue content cannot inject Slack mrkdwn or malformed links.
- A failed non-2xx `/linear` processing attempt no longer enters completed-event
  deduplication and remains safe to retry.
- Graceful Slack ingress shutdown drains the query lane when possible but
  resolves after a 30-second maximum wait instead of blocking indefinitely.

### Security

- Slack `/linear` authorization requires an exact team and channel match before
  OpenTag reads a Linear credential or calls the provider; legacy global project
  settings do not authorize a channel.
- Query-only Linear credentials are kept out of mutation dispatcher wiring, and
  unsupported named connections fail closed instead of falling back to another
  workspace token.

### Compatibility and migration

- The release is additive and introduces no breaking TypeScript or HTTP
  contract. Existing Linear webhook, callback, and issue-creation paths remain
  available and continue to require their mutation-capable configuration.
- To enable `/linear`, add an exact entry under `platforms.linear.channels` and
  configure the `default` query connection. `platforms.linear.projectId` and
  `OPENTAG_LINEAR_PROJECT_ID` are not channel authorization fallbacks.

### Release validation note

Before promotion from npm `next` to `latest`, the exact registry-installed
`@opentag/cli@0.9.0` candidate must pass the coordinated package checks and the
real GitHub factory acceptance loop. The Slack-to-Linear query path must also be
validated with provider-backed credentials or left explicitly unclaimed; source
tests alone do not prove live Slack or Linear delivery.

## v0.8.0 - 2026-07-27

OpenTag 0.8.0 completes the first provider-live, recipe-driven software-factory
control loop on top of external planning systems. It adds access identity,
bounded human escalation, deterministic runner placement, immutable factory
recipes and WorkThread-only workstreams, restart-safe batch admission,
authoritative accepted-outcome metrics, and a real GitHub-backed acceptance
path. OpenTag still does not own backlog state, dependency DAGs, or an operator
console; source systems own planning, Git owns changes, and provider evidence
must satisfy completion gates.

### Added

- Additive agent access-profile and policy-provenance snapshots that preserve
  the requesting human, executing agent principal, project targets,
  permissions, and routing constraints for runs and queued follow-ups.
- Structured human-escalation acknowledgement and resolution through the
  source thread, dispatcher API, TypeScript client, and CLI, including bounded
  options, audience, expiry, deduplication, and attributed audit events.
- Explainable multi-runner routing contracts, deterministic governance
  evaluation, durable routing snapshots, pairing-authenticated APIs, CLI status,
  locality constraints, and frozen fallback decisions.
- Immutable factory recipe snapshots, WorkThread-only workstreams, bounded
  budgets, ordered durable admission batches, restart-safe lease recovery,
  bounded exception summaries, workstream evaluation, and client/CLI control
  surfaces.
- Accepted-outcome metrics attributed only through the current authoritative
  CompletionAssessment and the latest terminal fenced Attempt, including
  runner and executor breakdowns without per-Run queries.
- An idempotent WorkThread ensure command that derives canonical governance
  identity from a normalized external event without creating a seed Run.
- A deterministic factory conformance path covering Echo and local ACP executor
  adapters, exact restart replay, conflicting digest rejection, bounded
  exception handling, and authoritative metrics.
- A real GitHub factory acceptance path from an external issue comment through
  admission, local execution, pull request, current-head required status,
  provider merge, accepted completion, source-thread receipt, restart recovery,
  and workstream metrics.

### Changed

- Runner claims now skip runs outside the captured runner eligibility and fail
  closed before creating an attempt when the access profile is expired or
  revoked. Inactive snapshots open a durable security escalation when the run
  has a resolvable work thread.
- Executor `needs_human` results are atomically correlated with a durable
  escalation. Callers receive a stable reason instead when no human-resolution
  route exists.
- Human resolution is persisted as follow-up context; OpenTag no longer implies
  that a stopped executor can receive live input. Conflicting acknowledgement
  or resolution replays are rejected instead of rewriting history.
- Attempt creation now enforces the immutable routing decision, selected runner,
  executor placement, access profile, locality, attempt budget, concurrency
  budget, and fencing authority in the same durable control path.
- Factory batches persist every item before admission, process items in stable
  order, keep routine per-item callbacks quiet, and return the exact durable
  receipt for an idempotent replay after restart.
- Workstream status now leads with state and next action, then accepted outcomes,
  budget use, bounded exceptions, and historical run detail.
- GitHub completion evidence remains bound to the current pull-request head;
  executor success and a successful check cannot bypass the merge gate.
- Provider compatibility checks, ACP readiness behavior, and the published
  dependency graph were hardened, including updated Hono server and protobuf
  runtime dependencies.
- Registry-installed factory acceptance now fails closed unless the selected
  CLI reports the target version and the clean npm lockfile binds the CLI,
  installed GitHub source normalizer, and installed Core event schema to the
  trusted public npm origin and sha512 integrity receipts; source normalization
  and validation also run through those installed packages rather than workspace
  product code.
- npm `latest` promotion now preserves one non-overwritable pre-promotion
  rollback snapshot across every partial-promotion retry, holds an atomic
  cross-operator release lock, and aborts before replacing drifted registry tags.

### Fixed

- Completion-waiver time tests now use a stable clock boundary.
- Human-escalation acknowledgement and resolution reject concurrent or
  conflicting attempts without rewriting durable history.
- Workstream metrics reject malformed, waived-without-authority, stale, or
  cross-WorkThread assessments and retain latest-run authority at scale.
- The factory acceptance report now rejects replaced assessments or edited,
  replaced, or duplicated source receipts across restart.

### Security

- Expired or revoked access profiles fail closed before Attempt creation and
  can open a durable security escalation for the governed WorkThread.
- Runner and executor fallback cannot widen captured access or recipe locality.
- Pairing credentials authorize factory administration; runner credentials
  cannot invoke WorkThread, recipe, workstream, or batch control operations.

### Release validation note

The source-checkout provider-live proof completed against a real GitHub issue,
pull request, current-head required status, merge, final source receipt, and
restart recovery. Before promotion from npm `next` to `latest`, the exact
registry-installed `@opentag/cli@0.8.0` candidate must repeat that factory loop
and the coordinated registry, ACP, governance, privacy, package-audit, and live
provider gates. This changelog does not claim those immutable registry artifacts
have passed before publication.

## v0.7.0 - 2026-07-22

OpenTag 0.7.0 completes the Phase 1 completion-governance vertical slice. A
successful executor result is now distinct from evidence-backed completion:
OpenTag can persist a work loop, evaluate its configured contract against
current-cycle evidence, explain blockers, and accept narrowly scoped human
waivers. This is a coordinated release of all 16 public packages, including
`@opentag/governance` as a first-class member of the package family.

### Added

- Additive `WorkThread`, `CompletionContract`, `CompletionGateResult`,
  `CompletionAssessment`, and `HumanEscalation` protocol schemas and JSON Schema
  exports in `@opentag/core`.
- Durable work-thread, contract, assessment, escalation, waiver, evidence, and
  delivery records in `@opentag/store`, including assessment history and
  completion metrics.
- The public `@opentag/governance` package, with a deterministic evaluator and
  a small command/query surface for reassessment, evidence ingestion, and
  bounded completion waivers.
- GitHub pull-request, required-check, head-SHA, and merge evidence
  normalization, plus dispatcher correlation from verified webhook facts to
  the current work thread.
- CLI completion explanation and pairing-authenticated waiver commands. Waivers
  are limited to selected gates in the current contract, carry an expiry, and
  remain attributable to a human actor.
- A replay fixture and governance-matrix scenario covering the GitHub
  completion path from executor success through current-head checks, merge
  evidence, reassessment, source-thread projection, and restart recovery.

### Changed

- Completion is evaluated from the latest run attached to a work thread. Run
  artifacts and receipts from older delivery epochs cannot satisfy the current
  contract, and external evidence must be observed during the current epoch.
- Dispatcher reassessment is idempotent and replay-safe across duplicate
  result/evidence delivery and process restarts. Conflicting or stale inputs
  fail closed instead of silently advancing completion.
- Local CLI startup accepts strict GitHub completion policies and forwards them
  to the dispatcher runtime, closing the configuration path needed for a real
  webhook-to-assessment run.
- Hermes ACP readiness allows the adapter's observed startup latency instead of
  inheriting the generic three-second probe deadline.
- Package discovery, packed-install validation, and release documentation now
  cover the complete 16-package publication set.

### Release validation note

The repository fixtures and release gates cover the deterministic and packaged
paths. A registry-installed, credentialed live GitHub chain must still pass
before `0.7.0` is promoted from `next` to `latest`; this changelog does not claim
that live proof in advance.

## v0.6.0 - 2026-07-16

OpenTag 0.6.0 moves every built-in coding agent onto the Generic ACP host,
adds Cursor, OpenCode, and OpenClaw as built-in executors, and hardens ACP
workspace isolation, cancellation evidence, source-thread summaries, and the
coordinated npm release gate. It is a coordinated release of all 15 public
packages and contains breaking Runner, daemon-configuration, and Node.js
support changes described below.

### Added

- Built-in Generic ACP definitions for Codex, Claude Code, Cursor, OpenCode,
  Hermes, and OpenClaw. Registry-backed Codex, Claude Code, and OpenCode
  launchers are pinned to `@agentclientprotocol/codex-acp@1.1.2`,
  `@agentclientprotocol/claude-agent-acp@0.59.0`, and
  `opencode-ai@1.18.1`, while installed Cursor, Hermes, and OpenClaw commands
  reuse their existing local authentication and profiles.
- Public `@opentag/runner` helpers for registry-driven ACP integrations:
  `createAcpAgentExecutor`, `createAcpAgentManifest`,
  `builtInAcpAgentDefinitions`, `builtInAcpAgentManifests`, and
  `createBuiltInAcpExecutors`.
- Compact custom ACP launch definitions under `daemon.agents`, including
  command, arguments, relative working directory, session mode, readiness
  timeout, profile capability, cancellation capability, and the required
  workspace-cwd conformance declaration.
- Streaming ACP progress and cancellation support for the built-in agents that
  can prove cancellation, plus a shared conformance harness covering
  repository worktrees, scratch workspaces, session cwd, completion, refusal,
  and cancellation behavior.
- A fail-closed OpenClaw ACP conformance gate. OpenClaw remains declared with
  `supportsCancel: false` until its Gateway can prove that cancelling a Run
  terminates the active tool process as well as the ACP session. Stock
  OpenClaw 2026.7.1 passes worktree, scratch, and disposable-session checks but
  can let a Gateway-owned shell subprocess finish after ACP cancellation, so
  cancellation remains explicitly best effort.
- Built-in CLI discovery and capability reporting for Cursor, OpenCode, and
  OpenClaw alongside Codex, Claude Code, Hermes, and Echo.

### Changed

- Codex, Claude Code, and Hermes no longer use dedicated direct executor
  adapters. The Local Runtime now launches all built-in coding agents through
  the same Generic ACP executor and OpenTag-owned worktree or scratch
  isolation.
- Hermes now starts as `hermes -p <profile> acp`; the 0.5.x `hermes -z`
  execution path is removed.
- Daemon `agents` entries are compact ACP launch definitions instead of full
  integration manifests. Built-in IDs cannot be overridden, and each custom
  entry must explicitly require a workspace cwd.
- The deprecated `daemon.claudeCode` configuration and `OPENTAG_CLAUDE_*`
  environment overrides are rejected. Configure built-in launchers through
  their supported local CLI authentication and the Generic ACP options.
- `@opentag/cli`, `@opentag/local-runtime`, and `@opentag/runner` now require
  Node.js 22 or newer.
- Slack final summaries preserve multiline content, are escaped exactly once,
  and are truncated on Unicode code-point boundaries after mrkdwn escaping to
  stay inside a 2500-character platform-safe output budget. Plain-text
  fallbacks no longer re-encode rich callback text.
- The Lark adapter and runnable Lark events app now use
  `@larksuiteoapi/node-sdk ^1.71.1`, whose relaxed Axios range allows patched
  Axios 1.x releases. The workspace lock resolves Axios 1.18.1.

### Security

- ACP `cwd` transport is no longer accepted as proof of workspace isolation.
  The formal ACP execution session that may invoke file tools starts in an
  OpenTag-created worktree for repository Runs or an attempt-scoped scratch
  directory for non-repository Runs. Readiness probes may start earlier in the
  configured repository workspace but do not execute Run file tools.
- Full ACP integration manifests must declare
  `roles.agent.workspace.sessionCwd: "required"`; compact `daemon.agents`
  definitions must declare `workspaceCwd: "required"`. Missing declarations
  fail schema validation instead of becoming unverified runtime claims.
- Built-in ACP children receive a scrubbed environment. Launch overrides reject
  invalid names and credential-like fields or values unconditionally.
  `security.extraSafeEnv` separately allows exact variables inherited from the
  parent process after explicit administrator review.
- OpenClaw cancellation capability fails closed when the runtime cannot prove
  hard cancellation of descendant tool processes.
- Slack source-thread fallbacks keep final summaries human-readable without
  double encoding or bypassing the bounded presentation path.

### Migration: Runner and daemon configuration

- Replace imports of `createCodexExecutor`, `createClaudeCodeExecutor`, and
  `createHermesExecutor` with `builtInAcpAgentDefinitions`,
  `builtInAcpAgentManifests`, or `createBuiltInAcpExecutors` from
  `@opentag/runner`.
- Remove `daemon.claudeCode`. Codex and Claude Code use the pinned ACP launchers
  and their existing local login state; Hermes uses the fixed configured
  profile through `hermes -p <profile> acp`.
- Remove `OPENTAG_CLAUDE_COMMAND`, `OPENTAG_CLAUDE_MODEL`,
  `OPENTAG_CLAUDE_PERMISSION_MODE`, and
  `OPENTAG_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS`; startup now rejects these
  removed overrides instead of silently ignoring them.
- Rewrite custom `daemon.agents` values as compact launch definitions with
  `command`, optional `args`, and `workspaceCwd: "required"`. Custom agents
  cannot replace the built-in `codex`, `claude-code`, `cursor`, `opencode`,
  `hermes`, or `openclaw` IDs.
- Consumers that call the lower-level `createAcpExecutor` with a complete
  integration manifest must add
  `roles.agent.workspace.sessionCwd: "required"` after verifying that the
  integration's real file tools honor both worktree and scratch cwd.
- Upgrade deployment and development environments to Node.js 22 before
  installing the 0.6.x CLI, Local Runtime, or Runner packages.

## v0.5.0 - 2026-07-14

OpenTag 0.5.0 adds Discord, Linear, and Microsoft Teams adapters and moves
agent execution onto durable, governed Attempts. It is a coordinated release
of all 15 public packages and contains breaking Client and Runner contract
changes described below.

### Added

- Published `@opentag/discord`, `@opentag/linear`, and `@opentag/teams` as
  first-class members of the coordinated package family.
- Discord Gateway and interactions-webhook ingest, channel replies, runtime
  readiness checks, and local-first CLI setup.
- Linear webhook ingest, issue comments, OAuth/API-key setup, workspace
  discovery, issue creation and mutation application, and source-thread action
  receipts.
- Microsoft Teams Bot Framework webhook ingest, tenant-aware authentication,
  channel replies, action application, and CLI/runtime setup.
- A generic stdio ACP host backed by the official ACP SDK. Named ACP agents can
  execute repository Attempts in isolated worktrees or ordinary non-repository
  Attempts in attempt-scoped scratch workspaces.
- Durable Attempt records with monotonically numbered claims, lease recovery,
  opaque fencing tokens, and attempt-scoped cancellation.
- Provider-neutral Channel protocol objects for normalized inbound messages,
  Run Card updates, approval prompts, action receipts, and final summaries.
- Governed ACP permission requests with `allow_once`, `allow_run`, and `deny`
  decisions delivered through the existing source-thread approval path.
- Material Action records for external side effects such as push, deploy,
  publish, and connector writes. Actions now carry stable IDs and idempotency
  keys, store normalized receipts, prevent duplicate execution, and require an
  explicit administrative reconciliation when an outcome remains `unknown`.
- Source-thread runtime controls and richer action receipts across supported
  chat and repository providers, plus local ledger/status evidence for runs,
  Attempts, artifacts, callbacks, and apply outcomes.

### Changed

- Every mutating runner operation now belongs to the active Attempt. Claims
  return `attemptId`, `attemptNumber`, and `fencingToken`; mark-running,
  heartbeat, progress, completion, permission, and material-action receipt
  calls must send the active Attempt lease.
- Lease expiry interrupts the prior Attempt before a new claim is issued. A
  stale worker receives `409 { "error": "stale_attempt" }` and can no longer
  append progress, complete the Run, resolve permissions, or write receipts.
- Agent integrations now use ACP instead of the unshipped
  `opentag.executor.v1` / `stdio-jsonl-basic` protocol. ACP sessions are
  disposable runtime state below durable Runs and Attempts.
- Repository execution uses OpenTag-owned isolation while non-repository ACP
  work uses scratch isolation. Failed, refused, cancelled, and interrupted ACP
  Attempts retain their workspace evidence instead of publishing a commit.
- Source-thread presentation is quieter: routine ACP/tool progress remains in
  audit evidence, while approvals, blockers, material-action receipts, and
  final summaries remain visible to people.
- CLI setup, start, status, doctor, pairing, service, and capability discovery
  now cover the expanded adapter family, ACP agent profiles, runtime readiness,
  secret readiness, and the installed CLI version.
- GitHub and GitLab source threads can run status/doctor/stop controls without
  creating a new Run, and supported source-thread actions reuse the governed
  approval/apply path.

### Security

- Run admission on public GitHub/GitLab repositories now requires
  platform-reported write access by default. GitHub commenters are checked via
  the repository collaborator permission API when the GitHub App path is used;
  GitLab Note Hooks carry no access level, so public GitLab projects stay
  closed until `allowedActors` is configured on the repository binding.
  Private repositories, Slack, and Lark behavior is unchanged, and an explicit
  `allowedActors` list still overrides the default for write-capable runs.
- Source-thread approvals (`apply`, `approve`, ...) from public GitHub/GitLab
  threads follow the same default: without an `allowedActors` list, only
  actors with write access can approve or apply proposed actions.
- The Claude Code executor now matches the Codex executor's protections: it
  runs the pre-execution security assessment, spawns `claude` with a scrubbed
  environment (secrets-like variables are dropped; add auth variables to
  `security.extraSafeEnv` if the CLI authenticates from environment), and
  executes in an isolated git worktree instead of a branch in the main
  checkout.
- Codex runs admitted without a write scope now use the read-only sandbox
  (`--sandbox read-only`) instead of `--full-auto`, so granted permission
  scopes are enforced at the executor level.
- Claude Code runs admitted without `repo:write` now use `--permission-mode
  plan`; repo-write runs default to `acceptEdits` unless a narrower
  `permissionMode` is configured.
- Enabling `dangerouslySkipPermissions` for Claude Code now emits an audit
  warning on every run so the bypass stays visible in the run timeline.
- Fencing tokens are accepted only on authenticated runner mutation requests.
  They are redacted from Attempt records, audit events, callbacks, errors,
  snapshots, logs, and material-action receipts.
- ACP children receive a scrubbed environment, an explicit contained workspace,
  strict NDJSON framing, bounded cancellation, and no dispatcher/channel
  credentials. Child stderr and raw ACP frames do not enter durable Run results
  or source-thread messages.
- Credential-like values, local absolute paths, hidden reasoning, and provider
  secrets are sanitized at progress, completion, receipt, callback, and
  control-plane boundaries.
- Channel roles and ACP agent roles use separate credentials, lifecycle, and
  capability grants; a channel integration cannot silently inherit executor
  authority.
- Attempt lifecycle state and its audit evidence commit atomically so a failed
  evidence write cannot leave a partially advanced lease or terminal Run.

### Migration: Client and custom runners

`@opentag/client` consumers that claim Runs must keep the lease returned by
`claim` and pass it to every mutation:

```ts
import { createOpenTagClient } from "@opentag/client";

const runnerId = "runner_custom";
const client = createOpenTagClient({
  dispatcherUrl: "http://localhost:3030",
  pairingToken: process.env.OPENTAG_PAIRING_TOKEN
});

const claimed = await client.claim({ runnerId });
if (!claimed) throw new Error("No Run available");

const lease = {
  attemptId: claimed.attemptId,
  fencingToken: claimed.fencingToken
};

await client.markRunning({
  runnerId,
  runId: claimed.run.id,
  ...lease,
  executor: "custom"
});
await client.heartbeat({ runnerId, runId: claimed.run.id, ...lease });
await client.progress({
  runnerId,
  runId: claimed.run.id,
  ...lease,
  type: "executor.progress",
  message: "Working on the request"
});
await client.complete({
  runnerId,
  runId: claimed.run.id,
  ...lease,
  result: { conclusion: "success", summary: "Done" }
});
```

- `createDispatcherClient` callers must pass the lease as the new argument to
  `markRunning(runId, executor, lease, options)`, `heartbeat(runId, lease)`,
  `progress(runId, lease, input)`, and
  `complete(runId, lease, result, options)`.
- Direct HTTP runners must use the runner-scoped `/v1/runners/:runnerId/runs/*`
  endpoints and include `attemptId` plus `fencingToken` in every mutation body.
  The old unscoped running/progress/complete endpoints now return `410`.
- Treat `stale_attempt` as loss of ownership: cancel local execution and do not
  retry the mutation with the expired lease. Never log or persist a fencing
  token outside the active runner process.
- Custom `@opentag/runner` adapters must replace `input.workspacePath` with
  `input.workspace.path` (or `executorWorkspacePath(input)`). The workspace is
  now explicitly `{ kind: "repository" | "scratch", path }`, and
  `cancel(runId, attemptId?)` may receive the Attempt to cancel.
- Adapters that execute material side effects should use the injected
  `permissionResolver` before execution and `materialActionReporter` afterward
  so the action remains fenced, receipted, and retry-safe.
- Integrations built on the removed custom stdio protocol must migrate their
  manifest to an ACP agent role and use `createAcpExecutor`.

### Packages

- `@opentag/core`
- `@opentag/client`
- `@opentag/discord`
- `@opentag/github`
- `@opentag/gitlab`
- `@opentag/lark`
- `@opentag/linear`
- `@opentag/runner`
- `@opentag/slack`
- `@opentag/store`
- `@opentag/teams`
- `@opentag/telegram`
- `@opentag/dispatcher`
- `@opentag/local-runtime`
- `@opentag/cli`

## v0.3.0 - 2026-06-30

OpenTag 0.3.0 improves the local CLI setup path and makes source-thread
approvals clearer in Slack and GitHub.

### Added

- Slack source-thread action buttons for `apply`, `approve`, `reject`, and
  `continue`
- Slack Events API and Socket Mode handling for interactive Block Kit actions
- Slack source-message receipt reactions with a text acknowledgement fallback
- Custom executor command support in CLI setup and local runtime config
- Structured executor report parsing for Codex and Claude Code summaries
- GitHub suggested-action rendering with clearer action details and verification
  rows
- Real Slack UI trigger dogfood script for live end-to-end validation

### Changed

- Slack final callbacks are quieter and keep internal proposal metadata out of
  the main thread
- GitHub and Slack action decisions now route through the same source-thread
  action path as typed commands
- Executor summaries avoid presenting source-control handoff steps as manual
  user blockers
- `opentag doctor` catches deprecated Codex model tiers
- Public README setup flow now points users at the published CLI first

### Fixed

- Common repository-edit requests for extensionless files such as `Dockerfile`
  and `Makefile` receive the right local write scope
- GitHub suggested-action details keep summary-only verification rows visible
- Slack receipt delivery is bounded without silently losing acknowledgement
  fallback behavior

### Packages

- `@opentag/cli`
- `@opentag/local-runtime`
- `@opentag/core`
- `@opentag/client`
- `@opentag/dispatcher`
- `@opentag/github`
- `@opentag/lark`
- `@opentag/slack`
- `@opentag/telegram`
- `@opentag/runner`
- `@opentag/store`

## v0.2.0 - 2026-06-29

Coordinated package release that made the local CLI the primary published entry
point.

### Added

- Published `@opentag/cli` package with the `opentag` binary
- Published `@opentag/local-runtime`
- Published Lark / Feishu and Telegram adapter packages
- CLI setup, doctor, status, config, platform, and executor commands
- Release preflight that builds, packs, installs, and verifies the published
  CLI command from tarballs

### Changed

- README and release docs now point users at `npm install -g @opentag/cli` and
  `npx @opentag/cli`
- Public package versions are aligned across the `@opentag/*` package family

## v0.1.0 - 2026-06-24

Initial public v0 release of OpenTag.

### Added

- Core OpenTag event and run schemas
- GitHub issue and pull request comment mention normalization
- Slack app mention normalization
- Embeddable dispatcher package
- SQLite-backed store package
- Local daemon for polling and running assigned work
- Echo executor for local smoke tests
- Codex executor adapter
- GitHub and Slack callback helpers
- Local GitHub-to-echo smoke-test example
- Public `@opentag/*` npm package family

### Packages

- `@opentag/core`
- `@opentag/client`
- `@opentag/dispatcher`
- `@opentag/github`
- `@opentag/slack`
- `@opentag/store`
- `@opentag/runner`

### Notes

OpenTag is still a young v0 project. This release is intended for local evaluation, integration experiments, and early SDK feedback. Production multi-tenant dispatcher deployments need additional hardening.
