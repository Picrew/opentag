# OpenTag Thread Runtime Alignment

## Status

Implemented runtime-alignment baseline for v0.2, 2026-06-25.

This document aligns the existing OpenTag protocol objects with the runtime
seams that now use them. It is not a proposal to invent a second thread runtime.

Current code already defines the main protocol objects:

- `ContextPacket`
- `WorkThread`
- `RunEvent.visibility`
- `RunEvent.importance`
- `OpenTagRun.contextPacket`

The landed v0.2 delta is smaller than a new runtime: add an explicit admission
decision seam, persist context packets as stable execution input, pass packets
to executors, keep run event metadata consistent across layers, and introduce a
minimal durable follow-up path.

## Goal

OpenTag should keep the user-facing loop simple:

```text
source thread mention
  -> normalized event
  -> scoped run
  -> approved runner
  -> quiet callback and audit timeline
```

The v0.2 goal is to make the existing loop more auditable without changing the
basic mention-to-run experience.

## V0.2 Scope

V0.2 now focuses on runtime alignment for these seams:

1. `RunAdmissionDecision`: new public protocol object and dispatcher seam.
2. `ContextPacket`: existing protocol object, now treated as stable run input.
3. `RunEvent` metadata: existing visibility and importance enums, reused
   consistently instead of redefined per package.
4. durable follow-up requests for same-thread work that arrives while a run is
   already active.
5. a default-pass agent access profile check hook at admission time.

## V0.2 Non-Scope

These remain future direction, not current implementation commitments:

- durable `WorkThread` table or standalone work-thread lifecycle;
- configurable `ProjectionPolicy`;
- delivery presentation policy driven directly by `RunEvent.visibility`;
- live active-run input updates;
- generalized guardrails for automatic run lineage;
- operator review UI;
- audit timeline UI;
- full redaction or token-budget enforcement.

## Existing Protocol Baseline

### Context Packet

`ContextPacket` already exists in core. Its current shape includes:

```ts
type ContextPacket = {
  summary: string;
  sourcePointers: ContextPointer[];
  facts?: Array<{ text: string; sourceUri?: string }>;
  risks?: string[];
  exclusions?: string[];
  mustPreserve?: string[];
  redactions?: Array<{ reason: string; sourceUri?: string }>;
  assembly?: {
    stages: ContextPacketAssemblyStage[];
    budgetTokens?: number;
    emittedAt?: string;
  };
};
```

V0.2 should not remove `redactions`, `assembly`, or `budgetTokens`. They are
valid optional metadata. The important boundary is that their presence does not
mean OpenTag already enforces full redaction policy or token-budget policy.

### Run Event Metadata

`RunEvent` already carries protocol metadata:

```ts
type RunEventVisibility = "human" | "audit" | "debug";
type RunEventImportance = "low" | "normal" | "high" | "blocking";
```

V0.2 should keep these enums. Do not rename them to a nicer vocabulary unless
there is a concrete migration reason. `operator` visibility can be added later
when an operator surface exists.

### Work Thread

`WorkThread` already exists as a protocol object attached to runs. V0.2 should
not create a separate durable work-thread store unless follow-up queues,
secondary anchors, approvals, or cross-run continuity require it.

## Delta 1: Run Admission Decision

The only new public protocol object in this document is `RunAdmissionDecision`.
It records what the dispatcher decided to do with an incoming event before or
while creating a run.

```ts
type RunAdmissionAction =
  | "start"
  | "drop_duplicate"
  | "queue_follow_up"
  | "attach_to_active_run"
  | "needs_human_decision";

type RunAdmissionReasonCode =
  | "new_event"
  | "duplicate_source_event"
  | "active_run_same_thread"
  | "active_write_run_same_thread"
  | "scope_change_requires_decision"
  | "policy_rejected";

type RunAdmissionDecision = {
  action: RunAdmissionAction;
  reason: string;
  reasonCode: RunAdmissionReasonCode;
  decidedAt: string;
  activeRunId?: string;
  eventId?: string;
};
```

V0.2 should implement only the decisions it can make honestly:

| Action | V0.2 behavior |
| --- | --- |
| `start` | Create a normal run. |
| `drop_duplicate` | Reuse the existing run for the same source event and record an audit event. |

`queue_follow_up` is now implemented as a durable follow-up record that can be
viewed and later promoted into a new run.

`attach_to_active_run` and `needs_human_decision` are future-compatible actions.
`needs_human_decision` is already emitted as a stable API response when the
dispatcher cannot safely create a run. `attach_to_active_run` remains reserved
until a runner supports live thread updates.

## Delta 2: Admission Seam

The dispatcher should route run creation through one seam:

```ts
type AdmitRunInput = {
  runId: string;
  event: OpenTagEvent;
  receivedAt: string;
};

type AdmitRunResult =
  | { decision: RunAdmissionDecision; createRun: true }
  | { decision: RunAdmissionDecision; createRun: false; existingRunId?: string };
```

The seam now owns:

- duplicate source-event detection;
- policy rejection that happens before run creation;
- agent access profile checks when provider credentials are involved;
- active-run checks when those become available;
- admission audit metadata.

This keeps deduplication, future follow-up handling, and policy rejection from
being scattered across route handlers and repository helpers.

## Delta 3: Admission Timeline Events

Admission decisions should be recorded in the run timeline.

Suggested event names should follow the current code style:

| Event type | Purpose |
| --- | --- |
| `admission.decided` | The dispatcher made an admission decision. |
| `run.created` | A run record was created. |
| `run.create_idempotent_replay` | A duplicate source event reused an existing run. |
| `context_packet.generated` | A context packet snapshot was generated. |

Delivery observations must preserve what OpenTag actually knows. The run
timeline records `delivery.intent.queued` when the unified producer accepts an
intent and `delivery.activation_blocked` when activation prevents submission.
Provider acceptance and settlement belong to the delivery journal or a
verified hosted observation; the run timeline must not infer a delivered
outcome.

## Delta 4: Stable Context Packet Snapshot

`ContextPacket` must behave like stable execution input, not a value that
changes whenever read-time derivation logic changes.

The current risk is:

```text
run row stores source event
read path derives protocol fields from source event
assembly logic changes later
old run reads back with a different contextPacket
```

V0.2 should choose one stable snapshot strategy:

| Option | Tradeoff |
| --- | --- |
| Store `context_packet_json` on the run row | Simple read path and explicit durable input. |
| Read `context_packet.generated` event payload when reconstructing a run | Avoids schema column churn but makes reconstruction depend on event lookup. |

The simpler default is to persist a run-level context packet snapshot. If that
is too much migration work for v0.2, reconstructing from the
`context_packet.generated` event is acceptable, but recomputing from the source
event is not.

## Delta 5: Context Packet Shape Migration

The current `ContextPacket` shape is valid but could become more explainable.
The next schema change should be additive:

```ts
type ContextPacket = {
  summary: string;
  sourcePointers: ContextPointer[];
  intent?: {
    rawText: string;
    normalizedIntent: string;
    requestedBy: ActorIdentity;
  };
  sources?: Array<{
    pointer: ContextPointer;
    role: "primary" | "supporting" | "background";
    included: boolean;
    reason: string;
  }>;
  facts?: Array<{
    text: string;
    sourceUri?: string;
    source?: ContextPointer;
    confidence?: "observed" | "inferred" | "uncertain";
  }>;
  risks?: string[];
  exclusions?: string[];
  mustPreserve?: string[];
  redactions?: Array<{ reason: string; sourceUri?: string }>;
  assembly?: {
    stages: ContextPacketAssemblyStage[];
    budgetTokens?: number;
    emittedAt?: string;
  };
};
```

Keep `sourcePointers` for compatibility. Add `intent` and `sources` to explain
why input was selected. Do not remove existing optional metadata just because
the first v0.2 runtime does not enforce every part of it.

## Delta 6: Executor Handoff

`ContextPacket` should reach executors. Otherwise it is only an audit artifact,
not the execution input boundary.

Executor input should become:

```ts
type ExecutorRunInput = {
  runId: string;
  workspacePath: string;
  command: OpenTagCommand;
  context: ContextPointer[];
  contextPacket?: ContextPacket;
  permissions?: PermissionGrant[];
  baseBranch?: string;
  worktreeRoot?: string;
  keepWorktree?: "always" | "on_failure" | "never";
};
```

Prompt builders should prefer the packet when present:

```text
OpenTag context packet:
- summary
- intent
- selected sources
- facts
- exclusions

Source links:
- raw context pointers
```

Runners that do not understand `contextPacket` must continue to work with raw
context pointers.

## Delta 7: Shared Run Event Defaults

Run event default metadata is protocol behavior. It should not be a private
helper in one storage package if other packages need the same interpretation.

V0.2 should move default metadata into core:

```ts
function defaultRunEventMetadata(type: string): {
  visibility: RunEventVisibility;
  importance: RunEventImportance;
};
```

The store can call the shared helper, and future dispatcher/client code can use
the same defaults.

## Future Direction

### Agent Access Profiles

Future admission policy should distinguish the human actor who requested a run
from the agent access profile used for execution. A run should be admitted only
when the source container, target agent, runner binding, permission grants, and
credential mode agree.

This keeps OpenTag from borrowing a human user's ambient permissions by default.
Agent actions should be auditable under a stable agent-controlled access
profile, scoped to the source container and work binding.

The admission seam now exposes a hook for these checks. The default
implementation is pass-through. Richer profile resolution and provider-specific
credential mode handling remain future work.

### Follow-Up Requests

`queue_follow_up` now persists a durable follow-up request with:

- the source event;
- the queued admission decision;
- the active run it is waiting behind;
- a stable read API;
- a promotion path into a later run.

OpenTag now auto-promotes the first queued follow-up after the active run
reaches a natural terminal completion. Manual `/stop` cancellation does not
start the next queued item automatically, because a human stop request may mean
"pause this source thread" rather than "skip to the next item."

What remains future work is richer acknowledgement copy, configurable
auto-promotion policy, and thread-aware prioritization across multiple queued
follow-ups.

### Active-Run Input

`attach_to_active_run` should wait until at least one runner supports live input
or controlled restart semantics.

### Projection Policy

Run event metadata can eventually drive delivery presentation policy. The
current runtime instead creates semantic acknowledgement/final presentations,
then passes them through the single producer and kernel boundary.

### Durable Work Thread

A separate work-thread store is useful only when OpenTag needs continuity
across multiple runs beyond what `OpenTagRun.thread`, run lineage, and source
events already provide.

## Implementation Order

1. `RunAdmissionDecision` schema, exports, and tests landed in `@opentag/core`.
2. `ContextPacket.intent` and `ContextPacket.sources` landed as additive fields.
3. `defaultRunEventMetadata(type)` moved into `@opentag/core`.
4. Dispatcher run creation now routes through `admitRun(...)`.
5. `admission.decided` is recorded for created runs and duplicate source-event replays.
6. `ContextPacket` now persists as a stable snapshot instead of being derived only at read time.
7. Executors now receive optional `contextPacket`, and Codex / Claude Code prompts prefer packet summary, facts, and exclusions.
8. Same-thread active runs now queue durable follow-up requests that can later be promoted into runs.
9. `needs_human_decision` now has a stable API response shape.
10. Natural terminal completion now auto-promotes the first queued follow-up,
    while explicit human cancellation leaves queued follow-ups paused.

## Tests To Add

- Core schema accepts `RunAdmissionDecision`.
- Core schema accepts `ContextPacket` with both old `sourcePointers` and new
  `sources`.
- `defaultRunEventMetadata` returns current visibility and importance defaults.
- Dispatcher duplicate source event records an admission decision.
- Store timeline includes `admission.decided` before or alongside `run.created`.
- Returned runs preserve the generated context packet snapshot.
- Daemon fake executor receives `contextPacket`.
- Codex and Claude Code prompt builders include packet summary, facts, and
  exclusions when a packet exists.
- Same-thread active runs return durable follow-up requests that can be viewed
  with a safe command summary and promoted into runs.
- Old runs without a context packet still execute from raw context pointers.

## Decision Frame

The v0.2 design is successful if OpenTag can say:

```text
OpenTag records why a mention became a run, preserves the curated context used
for execution, and gives every run event shared audit metadata without changing
the simple mention-to-run experience.
```
