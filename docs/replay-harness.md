# OpenTag Replay Harness

OpenTag's replay harness keeps the product from drifting back into a plain connector. A replay fixture captures a source-thread event, the expected executor result, and the governed-loop evidence that must appear after dispatch.

Use replay fixtures for source-thread behavior that should stay stable:

- admission and duplicate handling;
- context packet snapshot generation;
- executor capability ledger entries;
- artifact-first final results;
- source-thread action receipt shape;
- delivery-intent projection without internal process noise;
- agent work ledger categories;
- completion governance from executor success through provider-verified
  current-head checks and merge.

## Fixture Location

Dispatcher replay fixtures live under:

```text
packages/dispatcher/test/fixtures/replay/
```

Each fixture is JSON so it can be reviewed independently from test code. A fixture contains:

- `runId`: stable run identifier for the replay.
- `event`: an `OpenTagEvent` source-thread event.
- `executorCapability`: the capability snapshot the runner reports at `running`.
- `result`: an `OpenTagRunResult` with artifacts and optional suggested actions.
- `expected`: compact assertions for artifact types, ledger categories, and the
  final source-thread presentation text.

The strict GitHub completion fixture also carries a sanitized
`completionPolicy` and `verifiedSnapshot`. These are test inputs for the local
governance boundary, not raw webhook payloads or a claim that the test contacted
GitHub.

## Add A Replay Case

1. Add a new JSON file in `packages/dispatcher/test/fixtures/replay/`.
2. Use a realistic source-thread event from GitHub, Slack, GitLab, Lark / Feishu, or another adapter.
3. If the case came from a live run, preserve the live shape but sanitize it before committing:
   replace real repository names, user IDs, project IDs, chat IDs, message IDs,
   and branch suffixes with reviewable placeholders.
4. Keep secrets and live provider IDs out of the fixture.
5. Do not copy raw provider API responses, webhook headers, local absolute
   checkout paths, executor stdout/stderr, full Lark message IDs, or Slack bot
   tokens into the fixture.
6. Include at least one machine-addressable artifact with `id`, `type`, `title`, `uri`, and `summary`.
7. Add ordinary source-thread fixtures to
   `packages/dispatcher/test/replay-harness.test.ts`. Add strict completion
   fixtures to a dedicated test that keeps executor output and provider evidence
   as separate lifecycle steps.
8. Run:

```bash
corepack pnpm vitest run packages/dispatcher/test/replay-harness.test.ts
corepack pnpm vitest run packages/dispatcher/test/completion-governance-replay.test.ts
```

Replay tests should not call live provider APIs. They exercise the dispatcher app in memory and prove that OpenTag still produces a bounded context packet, an executor capability snapshot, artifacts, callbacks, and a ledger view for the source thread.

The strict completion replay additionally proves a durable WorkThread,
attempt-fencing rejection, pending completion after process success,
provider-verified evidence on one current PR head, superseding assessment
lineage, a single end-to-end completion metric, restart recovery, and concise
CLI/source-thread explanations. A real provider proof remains a separate live
gate with configured credentials, signed ingress, and API reconciliation.

## Workstream Evaluation Replay

A Phase 4A workstream replay adds recipe and batch facts without weakening the
single-Run proof. The normalized input includes:

- one immutable recipe snapshot and its budget digest;
- a WorkThread-only workstream membership snapshot;
- a batch id, normalized request digest, ordered stable item ids, and durable
  per-item receipts;
- the Run, routing, fenced Attempt, evidence, and CompletionAssessment facts
  already exercised by the strict completion replay;
- a fixed evaluation timestamp.

Replay the same input once in a fresh database and once after reopening the
database. The canonical workstream metrics and evaluation digest must match.
The test must also prove that an exact batch replay does not repeat completed
items or callbacks, a conflicting digest is rejected, stale Attempt fencing is
preserved, and accepted outcomes come only from the authoritative current
CompletionAssessment. No provider API is called and the evaluation cannot
write a CompletionAssessment.

## Phase 4B Runtime Conformance

The Phase 4A replay remains the narrow deterministic store/dispatcher contract.
Phase 4B adds a process-level conformance case without replacing that coverage:

```bash
corepack pnpm smoke:factory-conformance
```

The conformance case opens a real loopback dispatcher over a file-backed
database, operates the recipe, workstream, and batch APIs, runs two admitted
items through the local daemon using Echo and a deterministic ACP fixture, then
reopens the database and proves exact replay without duplicate work. It also
locks the ten-sample exception bound and current-assessment authority for
accepted-outcome metrics: successful terminal Runs remain unaccepted until
deterministic verified evidence advances their current CompletionAssessments.

This case is safe for ordinary CI because it has no provider credentials or
external writes. It proves the live OpenTag runtime seams, not a public provider
loop; the GitHub webhook smoke remains the separate external proof. Neither
case introduces dependency scheduling, a DAG, or an operator console.

## Product Boundary

Replay fixtures should reinforce OpenTag's boundary:

- The source thread remains the human workflow surface.
- The local runner remains the execution boundary.
- The agent work ledger is the durable audit surface.
- Final presentations compress the outcome and point to artifacts/status.
- OpenTag does not become a new AI workspace or a stream of internal agent logs.
