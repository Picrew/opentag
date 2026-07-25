# @opentag/governance

Deterministic execution governance for OpenTag work loops.

This package owns the Phase 1 completion predicate and its small command/query orchestration surface. It keeps executor success separate from evidence-backed work completion.

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

## Responsibilities

- Evaluate finite completion gates against immutable artifacts, normalized evidence, material-action receipts, and bounded waivers.
- Bind delivery gates to one work cycle, change request, and resource version.
- Produce explainable `CompletionAssessment` snapshots with stable reason codes.
- Coordinate reassessment through injected repository, clock, and ID ports.
- Preserve legacy behavior through an explicit execution-compatibility contract whose assessments are not evidence-backed.

The package does not import provider SDKs, own SQLite, call executors, or render source-channel messages. Provider adapters normalize facts; the store enforces durability; the dispatcher composes those boundaries.
