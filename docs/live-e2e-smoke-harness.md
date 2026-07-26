# Live E2E Smoke Harness

The replay harness proves protocol behavior without live provider APIs. The live
E2E smoke harness is the next layer: it collects the existing ACP, GitHub,
Slack, Lark, and Linear dogfood scripts behind one safe entry point so a release
or PR reviewer can run the live cases intentionally and keep a JSON evidence
report.

The harness does not run live provider calls by default. You must select cases
with `--case` or `--all`.

## List Cases

```bash
corepack pnpm smoke:live -- --list
```

Current cases:

| Case | Live provider? | Purpose |
| --- | --- | --- |
| `protocol-runtime` | No | In-memory GitHub-shaped protocol smoke using dispatcher/client/store paths |
| `slack-protocol` | No | In-memory Slack-shaped protocol smoke with quiet progress and Block Kit final callback |
| `factory-conformance` | No | File-backed recipe/workstream/batch loop with restart replay, bounded exceptions, authoritative accepted outcomes, and Echo plus local ACP executor paths |
| `openclaw-acp` | Yes | Strict OpenClaw hard-cancellation probe plus worktree cwd, scratch cwd, and fresh-session checks through the generic ACP host |
| `github-webhook-live` | Yes | Real GitHub repository webhook, local CLI stack, current-head required check, merged PR, durable satisfied assessment, and restart-safe final receipt |
| `github-factory-live` | Yes | Real external GitHub source thread admitted through a recipe/workstream batch, local execution, PR/check/merge, authoritative accepted metrics, restart replay, and deduplicated source receipt |
| `github-cli-live` | Yes | Real GitHub issue callback using dispatcher-assisted run creation |
| `slack-local-live` | Yes | Real Slack callback using dispatcher-assisted run creation |
| `slack-ui-live` | Yes | Real Slack source-thread mention or button flow through Socket Mode or Events API |
| `lark-patch-live` | Yes | Real Lark reply plus final card patch through `lark-cli` |
| `linear-workspace-live` | Yes | Real Linear GraphQL `commentCreate` and `issueUpdate` through a signed local Linear webhook payload |

## Dry Run

Use dry-run before any provider call. It checks local commands and required
environment variables, then prints what would run.

```bash
corepack pnpm smoke:live -- --case github-webhook-live --dry-run
OPENTAG_GH_LIVE_EXECUTOR=phase1-fixture \
corepack pnpm smoke:live -- --case github-factory-live --dry-run
corepack pnpm smoke:live -- --case slack-ui-live --dry-run --allow-missing
```

`--allow-missing` turns missing credentials or commands into `SKIPPED` instead
of a failure. This is useful in CI jobs that collect readiness reports without
holding live provider tokens.

## Evidence Report

Every run can write a local JSON report:

```bash
corepack pnpm smoke:live -- \
  --case protocol-runtime \
  --case slack-protocol \
  --report .omx/live-e2e/local-protocol-smoke.json
```

Reports include selected cases, command strings, preflight gaps, warnings,
duration, exit code, and pass/skip/fail status. Reports should not contain raw
provider tokens, local checkout paths beyond the command itself, or raw provider
payloads.

## Recommended Sequence

1. Run local protocol and factory conformance cases first:

```bash
corepack pnpm smoke:live -- \
  --case protocol-runtime \
  --case slack-protocol \
  --case factory-conformance
```

2. Run one live provider at a time with a report path:

```bash
corepack pnpm smoke:live -- \
  --case github-factory-live \
  --report .omx/live-e2e/github-factory-live-harness.json
```

3. Inspect the provider thread and local status:

```bash
opentag status --run <run_id>
```

The live pass is only credible when the source thread has a concise final
callback, `opentag status --run` shows the Context Packet and Agent Work Ledger,
artifacts exist, and provider-visible action receipts do not expose raw executor
logs.

### Factory Conformance

`factory-conformance` wraps `corepack pnpm smoke:factory-conformance`. It uses a
temporary file-backed database and the same public dispatcher client plus local
daemon path used by an operator. One immutable recipe admits a quiet ordered
batch into a WorkThread-only workstream, then the Echo executor and the local
ACP fixture each complete one accepted work loop.

The case closes and reopens the dispatcher against the same database before it
replays the batch. It fails unless the replay returns the durable receipt,
creates no duplicate work, and a changed payload is rejected as an idempotency
conflict. A separate twelve-item exception batch must retain ten bounded
exception samples, report two omitted samples, and produce no routine per-item
source callback. Its accepted-outcome assertions use current
CompletionAssessments and terminal Attempt executor attribution, not successful
Run counts. The case first observes two terminal Runs and zero accepted
outcomes, then submits deterministic current-head/check/merge snapshots through
the authenticated public evidence-ingestion seam and requires the accepted
counts to move to two without changing the terminal Run count.

Set `OPENTAG_FACTORY_CONFORMANCE_REPORT` to retain its sanitized evidence:

```bash
OPENTAG_FACTORY_CONFORMANCE_REPORT=.omx/live-e2e/factory-conformance.json \
corepack pnpm smoke:factory-conformance
```

This is deterministic runtime conformance, not a claim that a public source
provider, model provider, pull request, required check, or merge was exercised;
the GitHub-shaped evidence is a sanitized conformance input, not a provider API
observation.
Use `github-webhook-live` for the real source-control completion loop and
`builtin-acp` for provider-backed executor readiness. No DAG scheduler or
operator console is part of this case.

### GitHub Factory Acceptance

`github-factory-live` sets `OPENTAG_GH_LIVE_FACTORY=true` on the existing real
GitHub harness. It deliberately creates the GitHub issue and source request
before installing the temporary OpenTag webhook. The comment therefore remains
a real, externally durable planning instruction without also creating an
unattributed direct Run. OpenTag fetches that comment, normalizes it through the
GitHub adapter, ensures its canonical WorkThread, and submits the same event as
one item in an immutable recipe-owned workstream batch.

The case then uses the normal runtime and provider path. A local fenced Attempt
changes an isolated worktree, OpenTag creates a real pull request, a required
status is recorded for the exact current head, and completion remains pending
until GitHub reports the merge. The source thread must receive exactly one
provider-verified completion receipt. The harness restarts against the same
database, submits the identical batch again, and requires both the durable
receipt and authoritative workstream metrics to remain byte-equivalent.

The sanitized acceptance report is generated from retained provider and store
observations. It is rejected instead of written when any required relationship
is missing or contradictory. Its proof matrix is:

| Claim | Retained authority |
| --- | --- |
| External planning source | GitHub issue URL, mention URL, issue/comment/event identifiers |
| Factory admission | Canonical WorkThread, immutable recipe/workstream digests, durable batch digest and admitted Run identity |
| Local execution | Run snapshots plus latest fenced Attempt runner, executor, locality, and terminal status |
| PR and check | GitHub PR identity/state and required status tied to the PR head SHA |
| Accepted completion | Completion snapshots before evidence, after the check, after merge, and after restart |
| Accepted metrics | Workstream metrics proving terminal Runs remain `1` while accepted WorkThreads advance `0 -> 1` |
| Restart recovery | Exact batch receipt replay, byte-equivalent satisfied assessment and metrics, and unchanged source-receipt identity, body digest, and count |

Run the provider/governance proof with the deterministic local ACP writer:

```bash
OPENTAG_GH_LIVE_EXECUTOR=phase1-fixture \
OPENTAG_GH_LIVE_REPORT=.omx/live-e2e/github-factory-live.json \
corepack pnpm smoke:live -- --case github-factory-live
```

This proves the real GitHub, local runtime, factory admission, and governance
chain. It does not claim model-provider readiness; run `builtin-acp` separately
for that. GitHub remains the planning and source-control authority. This case
adds neither a dependency DAG nor an operator console.

The first Phase 5 live acceptance passed on 2026-07-26 UTC
(2026-07-27 Asia/Shanghai) against
[`amplifthq/opentag-test` issue #77](https://github.com/amplifthq/opentag-test/issues/77)
and [pull request #78](https://github.com/amplifthq/opentag-test/pull/78).
The PR head `3a65b9788bf26c2e26401ba688c176d0c0c3d239` carried the successful
`opentag-phase1-live` status and was merged as
`3eb6d9a354b6a7140cf396f371aba444cec409d2`. The retained report
`.omx/live-e2e/github-factory-live-phase5.json` records one terminal local
Attempt, accepted WorkThreads advancing from zero to one after provider
evidence, unchanged post-restart metrics, exact batch replay, and one unchanged
provider-verified source receipt. The GitHub issue deliberately remains open:
OpenTag accepted the governed delivery outcome but did not mutate the external
planning system's business status.

## Case Notes

### Batch Coding-Agent ACP

`builtin-acp` wraps `corepack pnpm smoke:acp-conformance`. It runs the same
provider-backed gate for pinned Codex, Claude, and OpenCode ACP packages plus
the installed Cursor, Hermes, and OpenClaw ACP commands: initialize readiness,
exact scratch `cwd`, isolated repository worktree plus commit, and, where the
agent declares `supportsCancel: true`, cancellation of the real shell/tool
process tree. OpenClaw remains in the batch, but its cancellation case is
reported as `not_applicable` because its capability is explicitly best effort.
The process-tree assertion currently targets POSIX hosts; Windows can exercise
ACP cancellation, but descendant-process termination is not yet a claimed gate.

Use `OPENTAG_BUILTIN_ACP_AGENTS` or `OPENTAG_BUILTIN_ACP_CASES` for a
comma-separated subset. Hermes uses `OPENTAG_HERMES_PROFILE` (default:
`opentag`) and must have a working inference provider before its execution cases
can pass. OpenClaw accepts `OPENTAG_OPENCLAW_COMMAND`,
`OPENTAG_OPENCLAW_PROFILE`, and `OPENTAG_OPENCLAW_GATEWAY_URL`; its Gateway must
be ready before execution cases can pass. Cursor must be logged in through
Cursor CLI, and OpenCode must have an authenticated provider. OpenCode's
built-in launch uses pure mode during ACP
sessions, so user-installed external OpenCode plugins are intentionally not
loaded into this transport. For example:

```bash
OPENTAG_BUILTIN_ACP_AGENTS=cursor,opencode \
corepack pnpm smoke:live -- --case builtin-acp
```

### OpenClaw ACP

`openclaw-acp` wraps `corepack pnpm smoke:openclaw-acp-conformance`. It expects
OpenClaw `2026.7.1`, a running Gateway, and an isolated profile named
`opentag-conformance` by default. Override the command, profile, Gateway URL, or
expected version with `OPENTAG_OPENCLAW_COMMAND`, `OPENTAG_OPENCLAW_PROFILE`,
`OPENTAG_OPENCLAW_GATEWAY_URL`, and
`OPENTAG_OPENCLAW_EXPECTED_VERSION`.

The case uses OpenTag's generic ACP executor; it does not invoke a dedicated
OpenClaw adapter. It fails closed unless real file tools write into the exact
OpenTag-created repository worktree and repository-free scratch directory,
each ACP process creates a distinct disposable Gateway session, a long-running
real tool call stops before its completion marker, and no marker appears in the
source checkout or OpenClaw's configured default workspace. The stock OpenClaw
bridge carries the ACP cwd into the Gateway request using its default cwd prefix,
so do not add `--no-prefix-cwd` to the integration binding.

The current stock 2026.7.1 result is intentionally non-zero. Worktree, scratch,
and distinct Gateway session checks pass, but after ACP cancellation marks the
Gateway session `killed`, the in-flight shell still reaches its completion
marker. This result tracks the missing hard-cancellation guarantee; it does not
block the built-in OpenClaw ACP agent. OpenTag exposes that limitation as
`supportsCancel: false` and does not claim that provider-owned tool subprocesses
have stopped.

The test Gateway may use no authentication only when it is isolated and bound
to loopback. A reusable or remote profile must own its Gateway authentication;
do not put tokens in an OpenTag manifest. To retain a sanitized case report:

```bash
OPENTAG_OPENCLAW_CONFORMANCE_REPORT=.omx/live-e2e/openclaw-acp.json \
corepack pnpm smoke:live -- --case openclaw-acp
```

This live case covers OpenClaw-specific workspace, session, and cancellation
behavior. Run it alongside the generic ACP executor tests, governance matrix,
and privacy scan for the permission, Action fencing, presentation, and
credential-isolation parts of the full conformance checklist.

### GitHub Repository Webhook

`github-webhook-live` and `github-factory-live` wrap
`scripts/dev/run-github-webhook-live-test.sh`.
It requires:

- `gh` authenticated as a user with admin or maintain access to
  `OPENTAG_GH_REPO`.
- A working local Claude login when `OPENTAG_GH_LIVE_EXECUTOR` is
  `claude-code`; its exact ACP package is resolved through `npx` from Registry
  launch data.
- `ngrok` unless `OPENTAG_GH_PUBLIC_URL` points at an existing public tunnel.

Strict completion mode is enabled by default. The case creates a real pull
request during the run, verifies that executor success does not satisfy the
completion contract, records
the `opentag-phase1-live` GitHub commit status on the exact PR head, verifies
that completion still waits for merge, merges the PR, and then requires a
provider-verified satisfied assessment. It restarts the CLI stack against the
same database and fails if completion is lost or the final source-thread
receipt is duplicated.

Set `OPENTAG_GH_LIVE_EXECUTOR=phase1-fixture` when the acceptance target is the
GitHub/governance chain itself. The repository's deterministic ACP fixture
still performs a real isolated-worktree write that OpenTag commits, pushes, and
opens as a pull request, but model-provider authentication and availability do
not become part of the Phase 1 completion-governance proof. Run built-in agent
ACP conformance as a separate release gate.

The case writes a sanitized evidence document under `.omx/live-e2e` containing
the issue, run and PR identities, the required check name, assessment snapshots
before and after each provider transition, and restart assertions. Override the
path with `OPENTAG_GH_LIVE_REPORT`. Set
`OPENTAG_GH_LIVE_STRICT_COMPLETION=false` only when intentionally exercising
the older optional `apply 1` compatibility flow.

After publishing a candidate to npm `next`, install `@opentag/cli@0.7.0` into a
fresh directory and set `OPENTAG_GH_LIVE_CLI_BIN` to that installation's
`node_modules/.bin/opentag`. The same strict case then proves the immutable
registry artifacts rather than the source checkout.

### Slack UI

`slack-ui-live` wraps `scripts/dev/run-slack-ui-trigger-local-test.sh`.
It requires:

- `OPENTAG_CONFIG_PATH`.
- `OPENTAG_SLACK_BOT_TOKEN`.
- Socket Mode token via `OPENTAG_SLACK_APP_TOKEN` or `SLACK_APP_TOKEN`, or
  Events API signing secret via `SLACK_SIGNING_SECRET`.

### Lark Patch

`lark-patch-live` wraps `scripts/dev/run-lark-message-patch-live-test.ts`.
It requires `lark-cli` or `OPENTAG_LARK_CLI`, with a ready bot identity and a
ready user identity or cached user `openId`. It can create a private seed
message or reuse an existing message when `OPENTAG_LARK_LIVE_CHAT_ID` and
`OPENTAG_LARK_LIVE_SOURCE_MESSAGE_ID` are set together.

### Linear Workspace

`linear-workspace-live` wraps
`scripts/dev/run-linear-workspace-live-test.ts`. It requires:

- `OPENTAG_LINEAR_SMOKE_TOKEN`: Linear OAuth app actor access token header
  value. Include the `Bearer ` prefix for OAuth access tokens. API-key
  compatibility smoke runs must also set
  `OPENTAG_LINEAR_SMOKE_ALLOW_NON_APP_TOKEN=true`.
- `OPENTAG_LINEAR_SMOKE_ISSUE`: Linear issue key, model UUID, or issue URL to
  use as the smoke source issue. `OPENTAG_LINEAR_SMOKE_ISSUE_ID` remains
  supported for compatibility.

Optional inputs:

- `OPENTAG_LINEAR_SMOKE_WEBHOOK_SECRET`: override the temporary signing secret
  stored on the generated relay installation. When omitted, the script
  generates one for the local signed webhook payloads.
- `OPENTAG_LINEAR_SMOKE_OAUTH_WEBHOOK_SECRET`: override the temporary
  OAuth App webhook signing secret used for the fixed
  `/linear/oauth/webhooks` hosted relay path. When omitted, the script
  generates one.
- `OPENTAG_LINEAR_SMOKE_OAUTH_WEBHOOK_PATH`: fixed hosted OAuth webhook path to
  exercise. Defaults to `/linear/oauth/webhooks`.
- `OPENTAG_LINEAR_SMOKE_ORGANIZATION_ID`: override the Linear organization id
  used to route the fixed OAuth App webhook to the temporary installation. When
  omitted, the script tries to query the workspace organization id and falls
  back to a local smoke id.
- `OPENTAG_LINEAR_SMOKE_GRAPHQL_URL`: Linear GraphQL endpoint override.
- `OPENTAG_LINEAR_SMOKE_ALLOW_NON_APP_TOKEN`: allow API-key compatibility smoke
  runs where `viewer.app` is not `true`. Defaults to `false`.
- `OPENTAG_LINEAR_SMOKE_DISCOVERY_LIMIT`: page size for Linear metadata
  discovery. Defaults to `100`.
- `OPENTAG_LINEAR_SMOKE_AGENT_SESSION_ID`: existing Linear Agent Session id to
  additionally validate the native agent path. When set, the smoke submits both
  `created` and `prompted` `AgentSessionEvent` payloads, verifies the prompted
  activity queues behind the active session run before promotion, and expects
  `agentSessionUpdate` plus `agentActivityCreate` delivery.
- `OPENTAG_LINEAR_SMOKE_REPO_PROVIDER`, `OPENTAG_LINEAR_SMOKE_REPO_OWNER`, and
  `OPENTAG_LINEAR_SMOKE_REPO_NAME`: local Project Target metadata to embed in
  the normalized Linear event.

The script registers a temporary Linear relay installation for token/project
target storage, then submits signed Linear Comment webhook payloads through the
fixed hosted OAuth App webhook path (`/linear/oauth/webhooks` by default). The
dispatcher verifies the app-level signature, verifies the token is a Linear
OAuth app actor by default, routes by `organizationId`, creates a run, completes
it with a safe priority update proposal, submits a second signed Linear
`apply 1` payload, posts a real Linear `commentCreate` callback, executes a real
Linear `issueUpdate`, and runs metadata discovery for teams, users, workflow
states, and labels. By default the issue update re-applies the issue's current
priority value, so it proves the mutation path without intentionally changing
the issue. The metadata step verifies the smoke issue's team appears in
discovery and that status/priority/user/label mapping drafts are generated.
When `OPENTAG_LINEAR_SMOKE_AGENT_SESSION_ID` is set, the same script also
submits signed `created` and `prompted`
`AgentSessionEvent` webhooks and verifies native Linear Agent Session / Agent
Activity GraphQL calls. The prompted payload is sent while the created session
run is still active; the script checks that it first appears as a queued
follow-up, then proves the same follow-up request is promoted into the claimed
follow-up run after the active run completes. Successful runs include
`linearGraphqlEvidence.operationCounts` and
`linearGraphqlEvidence.requiredOperations` so the exact Linear GraphQL paths are
auditable from the JSON output. The output also includes `metadataDiscovery`
counts and mapping value counts, `oauthActor.appActorVerified` for the default
app-token path, and `singleStatusComment.graphql.statusCommentUpdateVerified`
proving `commentUpdate` calls target the reused status comment id.
When Agent Session smoke is enabled, the output also includes
`agentSessionSmoke.prompted` with the queued follow-up id,
`followUpStatus: "promoted"`, and the promoted follow-up run id.

## Boundary

This harness is validation infrastructure, not a product surface. It should not
become an agent workspace, provider dashboard, or external runtime plugin
system. Its job is to prove that the real source threads still exercise the same
protocol evidence as replay fixtures: Context Packet, executor capability,
Action Receipt, Agent Work Ledger, artifacts, quiet callback, and final outcome.
