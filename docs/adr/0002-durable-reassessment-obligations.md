# ADR 0002: Make completion reassessment a durable obligation

- Status: Accepted
- Date: 2026-08-04
- Decision owners: OpenTag maintainers

## Context

OpenTag records governance-relevant facts durably before it evaluates their
effect on completion. Examples include a terminal Run result, verification
evidence attached to a WorkThread, a material-action receipt, a reconciled
unknown outcome, a human-escalation transition, and a completion waiver.

The durable facts are correct, but their delivery into completion governance is
currently process-local. Request handlers call reassessment after their store
transaction commits, and startup recovery performs a one-shot scan of completed
Runs. A process exit between those steps can leave a committed fact unapplied.
The scan does not cover every source fact, one failed item can interrupt a
batch, and a continuation decision with a future `notBefore` has no durable
wake-up when no new webhook arrives.

`CompletionAssessment` must remain the sole authority for whether a WorkThread
has satisfied its completion contract. OpenTag nevertheless needs a durable,
retryable answer to a narrower question: which committed facts still require a
reassessment and continuation decision?

## Decision

### Add one narrow durable primitive

OpenTag will add `ReassessmentObligation` as the only new durable primitive in
this change. It is an outbox item proving that one committed source fact must be
processed by completion governance for one WorkThread.

An obligation contains only delivery and recovery data:

- a stable obligation ID and WorkThread ID;
- a closed `sourceKind`, source ID, and canonical source digest;
- a `notBefore` time;
- delivery state: `pending`, `leased`, `satisfied`, or `blocked`;
- lease owner, expiry, and an opaque fencing token;
- attempt count and the latest typed outcome reason;
- a sanitized last error for operator diagnosis;
- the satisfying assessment ID when reassessment produced one;
- creation and update times.

The closed source kinds are:

- `run_result_recorded`;
- `verification_evidence_attached`;
- `material_action_receipt_recorded`;
- `material_action_reconciled`;
- `human_escalation_changed`;
- `completion_waiver_changed`;
- `continuation_not_before`.

The obligation will not contain a title, description, priority, assignee,
arbitrary command, arbitrary payload, parent Goal, parent Todo, or a second
business-completion state.

### Source facts and obligations commit atomically

Every producing repository operation will insert its obligation in the same
database transaction as the durable source fact or its WorkThread attachment.
If the transaction rolls back, neither fact nor obligation is visible. If it
commits, recovery can discover the obligation without reconstructing intent
from an unbounded historical scan.

`(sourceKind, sourceId, sourceDigest)` is the idempotency identity. Replaying the
same source delivery returns the existing obligation. A changed digest is a new
fact and therefore a new obligation. The source identity cannot be reused to
silently replace the content of an existing obligation.

### Processing uses a fenced lease

Workers claim due obligations with a bounded lease. A successful claim:

1. changes `pending` to `leased`, or reclaims an expired `leased` obligation;
2. assigns a lease owner, expiry, and fresh opaque fencing token;
3. increments the attempt count;
4. returns the exact claimed obligation.

Only a mutation carrying the current fencing token may satisfy, reschedule, or
block the obligation. The token is required even when the lease owner string is
unchanged: a worker with the same identity can reacquire an expired lease while
an old execution is still running. The stale execution must not be able to
write after that reacquisition.

The state transitions are:

```text
pending --claim when due------------------------> leased
leased  --lease expires, then a new claim-------> leased (new token)
leased  --transient/deferred outcome------------> pending (new notBefore)
leased  --governance delivery is complete-------> satisfied
leased  --typed non-retryable operator action---> blocked
```

`satisfied` and `blocked` are terminal for that source fact. A later source fact
creates a distinct obligation rather than reopening history. Processing
failure is never recorded as success. A stale or mismatched fence has no state
effect and returns an explicit stale-lease result.

### CompletionAssessment remains the only completion authority

The processor loads the obligation's durable source fact, invokes the existing
completion-governance reassessment, synchronizes the existing human-escalation
projection, derives the existing continuation decision, and then chooses one
of three delivery outcomes:

- satisfy because governance has incorporated the fact and continuation is
  terminal, not eligible, or already represented by a deterministic child Run;
- reschedule because a retry or `notBefore` wake-up is required;
- block because durable authority is missing or operator action is required.

An obligation in `satisfied` state means only that its delivery responsibility
has been fulfilled. It does not mean the WorkThread is accepted, the Run
succeeded, or every completion gate passed. Those statements continue to come
from their existing durable authorities.

The processor may retain the assessment ID that covered the fact for diagnosis,
but that reference cannot mutate, supersede, waive, or reinterpret the
assessment.

### Continuation remains a derived decision

This change will not add a durable `ContinuationWatch`. The processor reuses
the existing deterministic continuation evaluator. When its decision includes
a future `notBefore`, the current obligation is rescheduled or a
`continuation_not_before` obligation is idempotently produced. Due obligations
are polled and claimed without requiring a new provider webhook.

Continuation Run identity remains deterministic. Concurrent request-path and
recovery processing may attempt the same continuation, but they must converge
on the existing child Run rather than create duplicates.

### Recovery isolates individual obligations

Startup and periodic recovery drain due obligations instead of relying on one
historical completed-Run scan. Each claimed obligation is processed in its own
error boundary. A malformed or blocked obligation remains visible and does not
prevent later due obligations from being attempted.

Request handlers may trigger an immediate bounded drain after their source
transaction to preserve low latency. Correctness does not depend on that
optimization: restart and the due worker must produce the same durable result.

### Outcomes use typed reason codes

The durable reason vocabulary is deliberately small:

- `assessment_satisfied`;
- `continuation_dispatched`;
- `continuation_terminal`;
- `continuation_deferred`;
- `source_missing`;
- `authority_missing`;
- `reassessment_failed`;
- `needs_human`.

Lease contention, not-due selection, and stale fences are repository operation
outcomes, not persisted business reasons. Error text is diagnostic only,
sanitized before persistence, and never used as a state-machine input.

## Consequences

Positive consequences:

- every committed governance-relevant fact has a bounded durable repair path;
- crash/restart no longer depends on reconstructing delivery intent from Run
  history;
- future `notBefore` decisions wake without another provider event;
- source replay, concurrent processors, and continuation retries converge
  through idempotency and fencing;
- one poisoned obligation does not stop unrelated reassessments;
- status surfaces can expose real pending, leased, blocked, and oldest-due
  state without inventing progress or an ETA.

Costs and trade-offs:

- each source-fact transaction performs one additional idempotent insert;
- the dispatcher owns a small due-queue loop and lease lifecycle;
- source integrations must provide a stable source identity and canonical
  digest;
- operators must diagnose blocked obligations rather than relying on an
  implicit startup scan;
- obligation retention and cleanup policy may need later operational tuning,
  but cleanup cannot erase unresolved obligations.

## Rejected alternatives

### Keep handler-local reassessment plus startup scanning

Rejected because it leaves a commit-to-reassessment crash window, cannot
provide a precise future wake-up, and couples recovery cost to historical data.

### Add another completion state machine

Rejected because `CompletionAssessment` already owns completion authority. An
outbox state describes delivery, not business acceptance.

### Add a generic durable Todo, job, or Goal primitive

Rejected because arbitrary payloads and commands would broaden this change
into a scheduler and create a competing planning authority. The external
WorkItem remains the business and planning authority.

### Use only lease owner and expiry as the fence

Rejected because the same owner identity can reacquire an expired lease. A
stale execution from the earlier claim could then pass an owner-only check and
overwrite the newer result.

### Add a durable ContinuationWatch

Rejected because continuation state is derived from durable WorkThread facts,
policy, assessments, Run history, and the current obligation. Persisting a
second watch state would create avoidable reconciliation rules.

### Add an Attempt recovery cursor

Rejected because current executors do not expose a portable, verified resume
contract. Reassessment delivery must not imply that arbitrary execution can be
resumed safely.

## Deferred decisions

The following remain outside this change:

- Attempt checkpoint/resume semantics;
- Goal, Todo, DAG, priority, and assignee models;
- a second completion or acceptance authority;
- a durable ContinuationWatch or terminal-audit ledger;
- general-purpose job scheduling;
- retention or archival of terminal obligations beyond safe operational
  defaults.

## Validation requirements

The implementation following this ADR must prove:

1. A source fact and its obligation either both commit or both roll back.
2. Exact source replay produces one obligation.
3. A changed source digest produces a distinct obligation without overwriting
   history.
4. Only one worker can hold the current fenced lease.
5. Reclaiming an expired lease issues a new fence, and the stale execution
   cannot satisfy, reschedule, or block the obligation.
6. Due obligations are claimed in deterministic order while future obligations
   remain pending.
7. Satisfy, reschedule, and block transitions preserve typed reasons and reject
   invalid state transitions.
8. One failed obligation does not prevent a later due obligation from being
   processed.
9. A process exit after source commit but before reassessment is repaired after
   restart.
10. A future `notBefore` is processed without a new provider webhook.
11. Concurrent request-path and recovery processing create at most one
    deterministic continuation Run.
12. The same real provider delivery replay produces one obligation, one
    assessment transition for the same input, and no duplicate continuation or
    material-action receipt.
13. Current WorkThread acceptance remains unchanged and comes only from the
    current `CompletionAssessment`.
14. Diagnostics report durable queue facts and a concrete next action without
    claiming that pending work has completed.
