# ADR 0001: Attribute accepted progress from completion evidence

- Status: Accepted
- Date: 2026-08-04
- Decision owners: OpenTag maintainers

## Context

OpenTag keeps execution outcome separate from accepted work completion. A Run
and its fenced Attempts describe what executed and what it cost. A
`CompletionAssessment` describes whether the external WorkItem's configured
completion gates are satisfied by current authoritative evidence.

The existing accepted-completion metric crosses that boundary. When a
WorkThread's current assessment is accepted, the metric credits the latest
terminal Run and its latest terminal Attempt. That is convenient, but it is not
causal evidence. Repository checks, merge state, external-state observations,
human decisions, and artifacts from several Runs may all contribute to one
assessment. A later Run can also become the latest Run without producing the
evidence that advanced a gate.

OpenTag needs a truthful answer to two different questions:

1. Which WorkThreads currently satisfy their completion authority?
2. Which Runs produced evidence that the completion authority accepted as new
   progress?

The first question is already answered by the current
`CompletionAssessment`. This decision defines a derived answer to the second
without introducing another completion authority.

## Decision

### CompletionAssessment remains the sole completion authority

OpenTag will not add a mutable acceptance record or a second accepted-state
ledger. Current WorkThread acceptance continues to come only from the current
`CompletionAssessment`, including its contract identity, cycle, immutable
lineage, gate results, target bindings, waiver attribution, and accepted time.

`triggeredByRunId` records what caused an assessment to be evaluated. It is not
proof that the Run caused every accepted gate result and must not be used as
accepted-progress attribution.

### Accepted progress is a derived projection

OpenTag will expose an `AcceptedProgressAttribution` projection derived from:

- adjacent immutable assessments in the same WorkThread, completion contract
  version, and cycle;
- gate transitions into an accepted evidence state;
- the accepted assessment's resolved target bindings;
- the referenced completion artifact's durable `sourceRunId` provenance.

The projection is recomputable. It does not create a `run_acceptances` table,
does not participate in completion compare-and-swap, and cannot make a
WorkThread accepted.

Assessment supersession remains continuous at the WorkThread head, but
accepted-progress lineage stops when the predecessor belongs to another
contract version or cycle. The first assessment under the new authority is the
start of an independent projection. A referenced predecessor that is absent
from durable history, rather than merely outside the current authority tuple,
is invalid lineage.

An accepted gate advance is a gate whose current result is `passed` and whose
predecessor in the same assessment lineage was absent or was not `passed` for
the same accepted target. Reassessment that preserves an already-passed gate is
not new progress. A new completion cycle is evaluated independently.

When a gate names a `targetKey`, attribution follows the accepted assessment's
target binding to its `artifactId`, then follows that artifact's `sourceRunId`.
The Run is credited only when this chain resolves to exactly one durable Run in
the same WorkThread. No unique provenance means no Run credit.

Artifact producer identity is assigned at the trusted Run-result persistence
boundary. A runner-supplied `sourceRunId` cannot reassign an artifact to another
Run; the durable Run that submitted the result remains its producer. Any future
cross-Run provenance relation must have its own verified authority rather than
reuse a self-declared result field.

Several Runs may contribute different gate advances to one accepted
assessment. OpenTag will retain those contributions independently and will not
invent a single completion owner.

### Human and external authority are not coerced into Run ownership

A waiver, human-acceptance gate, or external-only gate without unique artifact
provenance may advance the CompletionAssessment while remaining unattributed to
a Run. The projection records the advance and an explicit unresolved reason;
it does not fall back to the latest Run, the assessment trigger, the latest
successful Attempt, or the executor that happened to run last.

### Execution usage remains separate

Attempt counts, locality, runner, executor, and cost units continue to be
measured from fenced Attempt records. Accepted-progress metrics may be grouped
by a Run's terminal Attempt only after the gate-to-artifact-to-Run provenance
chain has selected that Run. Execution usage is never evidence of acceptance by
itself.

### Read models and metrics use truthful names

Workstream and status surfaces will distinguish:

- accepted WorkThreads: current CompletionAssessments in `satisfied` or valid
  `waived` state;
- accepted gate advances: derived transitions into accepted evidence states;
- Runs with accepted progress: distinct Runs with at least one uniquely
  attributed accepted gate advance;
- unresolved accepted advances: accepted gate advances for which no unique Run
  provenance exists.

The existing latest-Run `acceptedCompletions` calculation will be removed. A
compatibility field, if retained during migration, must not continue reporting
the false latest-Run attribution.

## Consequences

Positive consequences:

- accepted completion and execution remain separate authorities;
- Run credit is explainable down to an assessment, gate, target, artifact, and
  source Run;
- multiple contributing Runs are represented without forcing a winner;
- replay and restart can recompute the same projection from durable evidence;
- missing provenance fails closed and is visible instead of silently guessed.

Costs and trade-offs:

- accepted-progress queries must load assessment lineage and artifact
  provenance rather than relying on one SQL rank over Runs;
- old acceptance-rate terminology must migrate to gate-advance and
  contributing-Run terminology;
- some accepted WorkThreads will intentionally have zero attributed Runs when
  acceptance came from human or external authority without Run provenance;
- historical assessments created before artifact provenance was retained may
  remain unresolved.

Malformed assessment authority or broken same-authority lineage is not an
unresolved attribution. Aggregate and Workstream reads fail explicitly instead
of omitting the WorkThread and returning valid-looking lower counts.

## Rejected alternatives

### Credit the latest terminal Run

Rejected because temporal order is not causal provenance. It assigns repository
or human evidence to whichever Run happens to sort last.

### Credit `triggeredByRunId`

Rejected because it identifies the reassessment trigger, not the producer of
each accepted gate's evidence.

### Add a durable RunAcceptance entity

Rejected for this phase because it would duplicate derivable facts and risk
becoming a competing acceptance authority. A durable cache may be reconsidered
only if measured query cost requires it, and then it must remain rebuildable
from the assessment and artifact ledgers.

### Force one Run to own the whole completion

Rejected because a WorkThread can legitimately combine artifacts and evidence
from several Runs, plus human or provider-owned authority.

## Deferred decisions

The following are deliberately outside this change:

- A durable `ReassessmentObligation` outbox for provider evidence that must be
  reconciled later. If added, it will be a narrow delivery/retry boundary, not
  another completion state machine.
- Attempt checkpoint or recovery cursors. OpenTag executors do not yet expose a
  portable resume capability, so storing a cursor would imply a guarantee the
  runtime cannot honor.
- A terminal audit checker that verifies every terminal WorkThread has a
  complete derived attribution explanation. This should be a read-only,
  rebuildable checker.
- Provider cost reconciliation, adaptive routing, scheduling dependencies, or
  a new Goal/Todo authority. The external WorkItem remains the business and
  planning authority.

## Validation requirements

The implementation following this ADR must prove:

1. A passed gate with one artifact and one `sourceRunId` credits that Run.
2. An unchanged passed gate does not produce another advance on reassessment.
3. Different gates may credit different Runs in one accepted assessment.
4. A waiver or missing/ambiguous provenance records an unresolved advance and
   credits no Run.
5. A later unrelated Run cannot inherit accepted progress.
6. Restart and replay derive the same attribution and metrics.
7. Current WorkThread acceptance remains unchanged and continues to come from
   the current CompletionAssessment.
8. A new contract version or cycle starts an independent projection while
   preserving the WorkThread supersession edge.
9. A runner cannot transfer artifact credit by supplying another Run's ID.
10. Broken lineage makes aggregate and Workstream metrics fail visibly.
