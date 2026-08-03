# @opentag/governance

Deterministic execution governance for OpenTag work loops.

This package owns the Phase 1 completion predicate and its small command/query orchestration surface. It keeps executor success separate from evidence-backed work completion.

It also owns pure, deterministic routing and factory-workstream evaluation.
Persistence, batch processing, Attempt leasing, and operator presentation remain
outside this package.

## Install

```bash
pnpm add @opentag/governance
```

## Routing

`evaluateRouting` accepts an ordered runner/executor directory snapshot plus
captured Project Target and access constraints. It applies hard eligibility
filters, selects the first eligible target in stable order, and returns one
validated `RoutingDecision` that explains both the selection and every rejected
alternative. The function is pure: persistence, polling, and Attempt leasing
remain dispatcher/store responsibilities.

Explicit empty allowlists deny all placements. Modern executors must report
ready state and a capability contract that satisfies the Run requirements;
unknown readiness or missing capability fails closed. A previously rejected
run-specific placement is also ineligible, allowing the store to requeue before
execution and advance to a deterministic fallback.

Wildcard placement evaluates only the deterministic top 256 entries in the
executor directory snapshot. A ready, capable runner outside that bounded
candidate window is not considered; exact runner allowlists use their own
bounded partition so explicitly selected runners remain reachable.

Routing does not use executor self-reported success or accepted-completion
metrics to bypass policy. Those metrics are an operator-facing evaluation
signal until an explicit, reviewable ranking policy is introduced.

## Workstream evaluation

`evaluateWorkstream` evaluates one immutable recipe snapshot, its WorkThread-only
workstream, and metrics derived from durable Runs, fenced Attempts, and current
CompletionAssessments. It returns a canonical input digest and one of
`healthy`, `attention_required`, or `blocked`.

Concurrency, per-Run attempts, fixed abstract cost units, and immutable Attempt
locality are fail-closed budget signals. Cost units are capacity accounting, not
currency. The function has no provider calls and cannot update a live
CompletionAssessment.

## Workstream continuation

`evaluateWorkstreamContinuation` is the pure decision boundary between a
WorkLoop that says `resume_work_thread` and any runtime that may create a new
Run. Automatic continuation is disabled when a recipe omits `continuation` or
declares `mode: manual`.

An evidence-driven policy selects explicit trigger kinds, a per-WorkThread
continuation limit, a minimum interval, and bounded exponential backoff. The
decision also checks the canonical Workstream evaluation, active Run ids,
trigger replay/staleness, and the current WorkLoop action. It returns
`eligible`, `wait`, `needs_human`, or `terminal` with a stable reason code and,
when delayed, `notBefore`. It does not create Runs, schedule timers, or call a
provider.

## Responsibilities

- Evaluate finite completion gates against immutable artifacts, normalized evidence, material-action receipts, and bounded waivers.
- Bind delivery gates to one work cycle, change request, and resource version.
- Produce explainable `CompletionAssessment` snapshots with stable reason codes.
- Coordinate reassessment through injected repository, clock, and ID ports.
- Preserve legacy behavior through an explicit execution-compatibility contract whose assessments are not evidence-backed.

The package does not import provider SDKs, own SQLite, call executors, or render source-channel messages. Provider adapters normalize facts; the store enforces durability; the dispatcher composes those boundaries.
