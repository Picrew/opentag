# OpenTag Agent Work Protocol

## Status

Long-horizon protocol direction, 2026-06-24.

This document captures the broader Agent Work Protocol shape and product
direction. For the current v0.2 runtime-alignment changes that are intended to
match the codebase, see [Thread Runtime Alignment](./thread-runtime-design.md).

This document extends the original OpenTag design from "open agent mentions" to
an auditable Agent Work Protocol. It is intentionally a design document, not an
implementation checklist. The goal is to capture product boundaries before we
turn internal Chat-OPS lessons into public APIs.

## Current Runtime Surface

The current v0 runtime should be read as a **thread-native model action layer**,
not as a full governance product.

The primary product path is:

```text
mention -> run -> executor -> final presentation with suggested actions
       -> source-thread reply such as apply 1 or continue 1
       -> ApprovalDecision -> ApplyPlan or explicit continuation run
```

The implemented loop should now be read as artifact-first and ledger-backed:

```text
source event -> admission decision -> context packet snapshot
             -> executor capability snapshot -> artifacts / suggested actions
             -> quiet source-thread presentation -> agent work ledger
```

The ledger is not a new workspace surface. It is the local audit/status view that
lets OpenTag keep source-thread presentations concise while preserving source
event, context, capability, artifact, approval, delivery-intent, and
final-outcome evidence.

Ingress apps and product integrations should prefer
`@opentag/client.submitThreadAction(...)` for source-thread replies. That path
preserves the user's thread context, applies actor authorization against the
existing Project Target binding, uses stable approval/apply identifiers for
webhook retry safety, and only presents direct apply as the primary path when a
capability/preflight check proves the adapter can execute the model's intent.
When direct apply is not available, the same thread can still carry an explicit
continuation request.

The lower-level proposal, approval, apply-plan, policy-rule, and
adapter-mapping HTTP routes are **experimental protocol APIs**. They are useful
for adapter authors, smoke tests, and runtime diagnostics, but they should not
be presented as the default v0 product surface. Keeping the vocabulary in the
protocol is intentional; selling the product as an enterprise approval dashboard
before the thread-native action loop proves demand is not.

## Summary

OpenTag should not become a generic project management system, a Lark Base
automation tool, a hosted AI workspace, or a noisy multi-agent chat surface.
Its core should stay small: normalize a tagged work request, construct bounded
context, dispatch to an approved runner, record an auditable timeline, and
return the right amount of information to the source workspace.

The next design step is to make three ideas first-class:

- **Attention Budget**: human attention is a scarce system resource.
- **Context Packet**: executor input should be curated, bounded, and auditable.
- **Quiet Agent Protocol**: agents should know when not to speak.

For the concrete Slack and GitHub approval rendering pattern that follows these
principles, see [Source-Thread Action Receipts](./source-thread-action-receipts.md).
For external local runtimes that report lifecycle hooks instead of behaving like
a simple spawn wrapper, see the [Hook Ingest Contract](./hook-ingest.md).

Together, these shift OpenTag from a mention router to a protocol for bringing
agents into real team workflows without flooding people, leaking context, or
turning every workspace thread into an AI log stream.

OpenTag is not another AI workspace. It is an open way to bring agents into the
places where work already has context.

## Problem

The first OpenTag loop proves that a GitHub or Slack mention can become a
dispatcher run, be claimed by a local daemon, execute with an adapter, and report
back. That is necessary, but not sufficient for organizational use.

Real teams need answers to a broader set of questions:

- Who asked the agent to act?
- What workspace context was included, and what was intentionally excluded?
- What permissions did the run receive?
- Which runner or executor handled it?
- What state is the run in now?
- When should humans be interrupted?
- Where did the result go?
- What can be audited later without posting it into the human thread?

Internal Invoko/Lark Chat-OPS practice exposed the same failure modes from a
different direction. The hard problems were not only "can the model do the
task?" They were:

- feedback in chat is natural, but unstructured;
- keyword automation can create noisy or self-triggering records;
- thread replies often correct priority, owner, or status;
- default tool settings can silently flatten important signals;
- "done" from an executor is not the same as organizational closure;
- users lose trust when work finishes but the source surface still says running;
- context needs boundaries, not infinite copy-paste;
- agent chatter can overwhelm the very people it is supposed to help.

OpenTag should absorb the cross-cutting lessons without hard-coding Invoko's
specific Lark Base fields, SLA thresholds, or workflow states.

The deeper product risk is not only noisy automation. It is adding yet another
AI-shaped place that teams must monitor:

- another inbox;
- another permission surface;
- another history;
- another context migration step;
- another stream of machine-generated attention demand.

OpenTag should move in the opposite direction. It should bring simplicity into
existing workspaces instead of laying another AI workspace on top of them.

## Product Position

OpenTag is the open Agent Work Protocol for bounded context, quiet presentations,
and auditable execution in real team workflows.

That means:

- It is not a clone of any single chat-to-agent workflow.
- It is not a hosted IDE or a general agent framework.
- It is not an AI project management system.
- It is a protocol layer between workspace surfaces and approved agent runners.
- It treats agents as pluggable capabilities, not as a new destination where
  humans must move their work.

The core promise is:

```text
Tag an agent where work already happens.
OpenTag curates the context, scopes the permission, dispatches execution,
records the timeline, and returns only the presentations humans need.
```

An equally important anti-promise is:

```text
Do not ask teams to move context into yet another AI workspace.
Bring the agent to the work, not the work to the agent.
```

## Product Direction

OpenTag should be developed as a **two-layer product on top of one protocol**.

### Layer 1: Thin Invocation Layer

This is the default surface for broad developers and teams:

- invoke an agent from an existing work surface;
- get a quick ack;
- receive a useful final result;
- avoid learning or monitoring a new AI workspace;
- keep the default experience quiet and lightweight.

The promise at this layer is not governance sophistication. It is:

```text
Do not make me move context.
Let me call an agent where the work already lives.
```

### Layer 2: Governance Layer

This is the value layer for deeper, higher-frequency, or more sensitive teams:

- Attention Budget
- Context Packet
- Quiet Agent Protocol
- approval and apply semantics
- audit and lineage
- router and policy controls
- local execution boundaries

The promise at this layer is:

```text
Do not let agents pollute my organization.
Make their actions reviewable, bounded, and quiet by default.
```

### Product Consequence

OpenTag should not force a choice between "simple mention utility" and
"governed enterprise workflow." It should expose a minimal invocation path by
default while allowing teams to opt into deeper governance semantics as usage
intensifies.

Broad developers buy:

- less context copying;
- less surface switching;
- faster invocation.

Deeper teams buy:

- clearer authority boundaries;
- safer external writes;
- quieter source-thread output;
- stronger audit and routing guarantees.

## Core Thesis

OpenTag looks like tagged invocation on the surface, but the real product shape
is three layers:

- **Invocation**: humans summon an agent from an existing work surface.
- **Governance**: the system decides what the agent may see, do, and return.
- **Compression**: the system turns a large internal process into a small number
  of outcomes humans actually need to consume.

Many AI workspace products mostly optimize the first layer and present the
result as chat. OpenTag should differentiate by taking the second and third
layers seriously.

## V1 Contract

OpenTag v1 should make a narrow but strong promise:

```text
Given an engineering work item thread, OpenTag can invoke an approved agent,
produce a bounded and auditable run, and return at least one artifact that
meaningfully moves the work item forward without requiring a new AI workspace.
```

### Canonical V1 Job

The primary v1 job is not "chat with an agent" and not even "analyze for its
own sake." It is:

**make progress on an engineering work item**

That progress may begin as investigation, but it must end in an artifact that
can be consumed, reviewed, approved, or executed.

### V1 Minimum Acceptable Output

The minimum acceptable output is:

- a `SuggestedChangesSnapshot`
- plus a `nextAction`

This is the lowest useful floor. Under stronger executor, policy, and local
runner conditions, OpenTag may go further:

- root-cause note + next action
- suggested changes snapshot + next action
- concrete patch
- pull request

But v1 must at least produce a machine-addressable suggestion artifact that can
push the work item forward.

### V1 External Write Contract

OpenTag v1 may write back to external systems, but external state mutation is
not a universal default side effect.

Default behavior:

- enqueue source-thread presentations
- attach artifacts
- emit audit events

Explicit capability behavior:

- create PR
- change status
- change assignee
- change priority
- change labels or fields

These stronger actions require explicit intent or policy-based approval. This is
what keeps OpenTag from turning into an unbounded automation layer.

### Capability Contract

To keep "explicit capability" from becoming hand-wavy, OpenTag should maintain a
clear capability contract for any external write that affects a system of
record.

At a minimum, each capability should answer:

- what semantic action it enables;
- whether it is read-only, presentation-only, or system-mutating;
- whether it requires explicit user intent;
- whether it may be auto-applied by policy;
- which adapters can resolve it;
- which executor or runner conditions must hold.

An initial capability matrix could look like this:

| Capability | Default class | Requires explicit intent | May be policy-auto-applied | Typical adapter targets |
| --- | --- | --- | --- | --- |
| `reply_thread` | presentation | No | Yes | GitHub, Slack, Lark |
| `attach_artifact` | presentation | No | Yes | GitHub, Slack, Lark |
| `create_pr` | external write | Usually yes | Yes, if allowed | GitHub |
| `set_status` | external write | Usually yes | Yes, if allowed | GitHub, Linear, Jira, Lark-mapped |
| `set_assignee` | external write | Usually yes | Yes, if allowed | GitHub, Linear, Jira, Lark-mapped |
| `set_priority` | external write | Usually yes | Yes, if allowed | Linear, Jira, Lark-mapped |
| `set_labels` | external write | Usually yes | Yes, if allowed | GitHub, Linear, Jira, Lark-mapped |

This matters because "Slack can create a PR" and "any GitHub-targeted run can
create a PR" are not the same product claim. The capability contract should let
OpenTag express that distinction cleanly.

### V1 Interaction Contract

The default interaction model is:

- invoke from a primary anchor
- receive `ack`
- receive `final`
- inspect `SuggestedChangesSnapshot`
- explicitly approve or trigger the next action when governance is needed

This means OpenTag v1 is not promising autonomous end-to-end work
orchestration by default. It is promising:

- invocation that respects existing work context;
- governance that respects authority and platform truth;
- compression that returns usable artifacts instead of chat exhaust.

### V1 System Boundary

OpenTag v1 is:

- an agent protocol for engineering work item threads
- model-neutral
- executor-neutral
- source-of-truth preserving
- quiet by default

OpenTag v1 is not:

- a replacement for GitHub, Linear, Jira, or Lark Base
- an all-purpose enterprise work management system
- a chat room where agents and humans cohabitate by default
- a promise that every invocation ends in direct code mutation

The v1 bet is narrower and stronger:

```text
When teams already have work items and threads, OpenTag should be the cleanest
way to bring agents into that flow without creating another place to work.
```

## Design Principles

### Mention, Not Ambient Surveillance

OpenTag should prefer explicit mentions, commands, or approvals over passive
ambient monitoring. Platform recipes may support richer listening, but core
OpenTag should not assume every workspace message is a potential task.

### Agent As Capability, Not Place

The agent should behave like a pluggable capability inside Slack, GitHub, Lark,
Linear, Notion, Jira, or local workflows. It should not require the team to
adopt a new AI-shaped place as the center of collaboration.

### Human Attention Is A Scarce Resource

Human-facing presentations must justify why they enter the source thread. Full run
details belong in audit by default. The main thread should receive outcomes,
blockers, approvals, and high-value progress only.

### Context Should Be Curated, Not Dumped

Raw workspace material should not be blindly passed to the executor. OpenTag
should build a Context Packet that captures intent, relevant facts, source
links, permission scope, risks, exclusions, and must-preserve original material.

### Silence Is A Product Feature

Agents should not compete to speak. Router-level coordination, audit-only
intermediate events, and quiet defaults should prevent agent-to-agent chatter
from leaking into human threads.

### Model Neutrality Is A Stability Layer

OpenTag should not treat Claude, Codex, Hermes, OpenClaw, or any future agent
runtime as the center of the product. Intelligence changes too quickly for
teams to rebuild their workflows around one vendor. The stable layer should be
invocation, governance, delivery, and audit, not the current best model.

### Result Artifacts Over Conversation Exhaust

The most valuable output is usually not a long conversational transcript. It is
an artifact humans can consume, verify, hand off, or approve: a PR, patch,
summary, risk note, test result, follow-up task, or decision record.

### Audit Everything, Interrupt Rarely

OpenTag should record enough to reconstruct what happened. That does not mean
every event should be posted back to GitHub, Slack, Lark, or another workspace.

### Core Stays Protocol-Shaped

Invoko/Lark workflows are a rich source of design evidence, but OpenTag core
should only include primitives that remain meaningful across providers,
executors, and organizations.

## Attention Budget

Attention Budget treats human attention as a system resource. It turns presentations
from "messages the bot feels like posting" into a policy-governed stream.

### Presentation Layers

OpenTag presentations should be grouped into four layers:

| Layer | Purpose | Human-facing default |
| --- | --- | --- |
| `ack` | Confirm the request was received and queued or rejected | Yes, short |
| `progress` | Report long-running milestones, blockers, approvals, or risk changes | Conditional |
| `final` | Summarize conclusion, changes, verification, artifacts, and next action | Yes |
| `audit` | Record full detail for later inspection | No |

The important distinction is not "short vs long." It is whether the event
deserves human attention now.

### Event Visibility

Core run events should eventually distinguish visibility from event type:

```ts
type RunEventVisibility = "human" | "audit" | "debug";

type RunEventImportance = "low" | "normal" | "high" | "blocking";
```

Examples:

- `run.created` can be `audit`.
- `delivery.intent.queued` can be `human` only when presentation policy calls
  for a visible acknowledgement.
- `executor.log_chunk` should usually be `debug` or `audit`.
- `run.waiting_for_permission` should be `human` and `blocking`.
- `verification.failed` may be `human` if it changes the next action.

This lets adapters decide how to render events without losing the core policy
intent.

### Presentation Defaults

For v0.x, the default policy should be conservative:

- Always send one ack when a run is accepted.
- Do not stream routine internal steps into the human thread.
- Send progress only for long tasks, approval waits, blockers, or material phase
  changes.
- Send one final result with conclusion, verification, artifacts, and next
  action.
- Keep tool logs, full prompts, internal planning, and agent-to-agent chatter in
  audit/debug channels.

This is more than terseness. It is an explicit attention policy: agents should
earn human attention instead of assuming they deserve it whenever they can speak.

## Context Packet

Context Packet, or Context Capsule, is the curated execution input passed from
OpenTag to an executor. It sits between raw workspace events and executor
prompts.

### Why It Exists

Without a Context Packet, systems tend to dump everything into the executor:

- full Slack or Lark threads;
- GitHub issue bodies and all comments;
- entire PR diffs;
- CI logs;
- unrelated bot messages;
- stale prior attempts;
- sensitive information that was visible to the platform but not necessary for
  the task.

This creates context explosion, context pollution, privacy risk, and weaker
executor behavior. A Context Packet is the boundary object that makes execution
input reviewable.

### Packet Contents

A mature packet should be able to represent:

| Field | Meaning |
| --- | --- |
| `intent` | The requested action and concise task summary |
| `facts` | Relevant facts extracted from source materials |
| `sourceLinks` | Pointers back to original messages, issues, diffs, logs, docs |
| `permissionScope` | What the executor may read, write, comment, create, or access |
| `risks` | Known product, code, privacy, security, or compatibility risks |
| `exclusions` | Explicit non-goals and boundaries |
| `mustPreserve` | Original user text, logs, or claims that must not be paraphrased away |
| `redactions` | Material withheld from the executor and why |

The packet should preserve traceability. A summarized fact is less useful if we
cannot recover its source.

### Minimal V0 Shape

We should not overbuild this before multiple adapters need it. A practical first
step is:

```ts
type ContextPacket = {
  summary: string;
  sourcePointers: ContextPointer[];
  facts?: Array<{ text: string; sourceUri?: string }>;
  risks?: string[];
  exclusions?: string[];
};
```

The runner can receive both:

- raw `context` pointers from the OpenTag event;
- the generated `contextPacket` as the curated executor input.

Over time, packet generation can become adapter-specific or policy-driven, but
core should define the concept early.

The Context Packet should be understood as context hygiene, not just context
formatting. Its job is not to squeeze more raw material into the prompt. Its
job is to decide what deserves to enter the run at all.

### Assembly Pipeline

OpenTag should define a packet assembly pipeline before packet structure becomes
part of the schema. Otherwise adapters will all construct packets differently
and the product will lose one of its strongest protocol claims.

A practical v1 assembly pipeline is:

1. **Collect**
   - gather raw context pointers from the source surface
   - gather any linked work-item sources such as issue, PR, CI log, or file
   - gather prior OpenTag artifacts that are still relevant

2. **Classify**
   - mark each source as primary evidence, supporting context, background noise,
     or sensitive material
   - distinguish human-authored source material from machine-authored source
     material

3. **Filter**
   - exclude sources that are irrelevant to the current intent
   - exclude sources blocked by policy or permission scope
   - exclude stale or superseded artifacts unless explicitly requested

4. **Preserve**
   - keep exact excerpts for must-preserve source material
   - retain source links for every summarized fact

5. **Summarize**
   - compress large logs, long threads, and diffs into task-relevant facts
   - preserve redaction boundaries and uncertainty notes

6. **Budget**
   - enforce context size limits
   - prefer dropping low-signal background before dropping must-preserve material

7. **Emit**
   - produce the `ContextPacket`
   - record assembly metadata in audit for traceability

This pipeline should eventually be adapter-aware, but the stage vocabulary
should remain stable across providers.

## Quiet Agent Protocol

Quiet Agent Protocol defines when agents should not speak.

This is deliberately different from Attention Budget:

- Attention Budget decides which events deserve human attention.
- Quiet Agent Protocol constrains agents from entering human threads by default.

### Default Rules

OpenTag should bias toward these rules:

- If an agent was not tagged, routed, approved, or explicitly configured, it does
  not reply in the human thread.
- If multiple agents could respond, a router or dispatcher speaks first; agents
  do not all post competing messages.
- Low-confidence suggestions should not masquerade as authoritative thread
  replies.
- Agent-to-agent coordination goes to audit/debug channels unless humans asked
  to observe it.
- The human thread receives outcomes, blockers, approvals, and final summaries,
  not every intermediate token.

### Protocol Implications

Quiet behavior should affect API and product design:

- the delivery producer needs an audit-only presentation path;
- run events need visibility metadata;
- executors should be instructed to separate final user-facing output from
  internal logs;
- multi-agent routing should produce one human-facing voice by default;
- adapters should avoid echoing every runner status event into source threads.

## Result Artifact First

OpenTag should prefer structured outcome artifacts over conversational output.

Examples of first-class artifacts:

- pull request;
- patch;
- verification summary;
- incident triage note;
- risk memo;
- follow-up task;
- audit trail;
- decision record.

This principle matters because most collaborative work is handed off, reviewed,
approved, retried, or summarized later. A stream of assistant chatter is weak
handoff material. An artifact with provenance is stronger.

At the protocol level, this suggests that `OpenTagRunResult` should stay focused
on decision-grade outputs instead of becoming a transcript bucket.

### Artifact Taxonomy

To make "artifact-first" concrete, OpenTag should define a small v1 taxonomy of
 result objects. The goal is not exhaustive ontology design; it is to ensure
 different executors return compatible artifacts.

Suggested v1 artifact classes:

| Artifact | Purpose | Can trigger next action | Can be approved/applied |
| --- | --- | --- | --- |
| `root_cause_note` | explain what happened and why | Yes | No |
| `suggested_changes_snapshot` | propose semantic mutations | Yes | Yes |
| `verification_summary` | summarize tests, checks, and evidence | Yes | No |
| `patch` | concrete code or config diff | Yes | Sometimes |
| `pull_request` | reviewable external artifact in GitHub | Yes | No |
| `risk_note` | surface known uncertainty or rollout risk | Yes | No |
| `follow_up_task` | create or link next task | Yes | No |

This taxonomy should anchor:

- what can appear in `OpenTagRunResult`;
- what counts as the minimum useful output;
- which artifact types can generate `nextAction`;
- which artifact types participate in approval and apply flows.

## Agent-To-Agent Workbench Is Not Chat

If OpenTag later supports multi-agent coordination, humans should not be forced
to watch agents imitate an IM thread.

Agent-to-agent coordination is better represented as:

- task graph;
- contracts and scoped sub-assignments;
- artifact exchange;
- state machine transitions;
- trace timeline;
- conflict or escalation points.

The human-facing interface should optimize for oversight:

- which subtasks exist;
- which runner or agent handled each step;
- what artifacts were produced;
- where evidence comes from;
- where human decisions are needed.

This is compatible with audit logging, but it avoids confusing "observability"
with "show every intermediate sentence."

## Core Protocol Primitives

The following primitives are core candidates because they remain meaningful
across GitHub, Slack, Lark, CLI, webhook, and future workspace surfaces.

### Canonical V1 Scope

OpenTag v1 should narrow its first serious protocol object to the
**engineering work item thread**.

That means:

- the canonical work item lives in an external system of record such as GitHub,
  Linear, Jira, or a mapped Lark object;
- the first-class conversational surface is the thread attached to that work
  item;
- OpenTag enhances the thread with invocation, governance, compression,
  callbacks, and audit;
- OpenTag does not become the source of truth for the work item itself.

This is intentionally narrower than "all collaborative work." It matches the
current executor, artifact, verification, and local-runner strengths without
pretending that v1 is already a universal work protocol.

### `OpenTagEvent`

Represents the normalized source event:

- source provider;
- source event id;
- actor;
- target agent;
- command;
- raw context pointers;
- permission grants;
- source-thread delivery target;
- metadata.

### `ContextPointer`

Points to source material without implying the whole source should be copied
into the executor.

Platform-specific sources should be expressed with an open `provider` plus a
stable adapter-owned `kind`, without making core depend on platform SDKs or
platform enum churn:

```ts
{ provider: "github", kind: "repo", uri: "https://github.com/acme/demo" }
{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/1" }
{ provider: "slack", kind: "message", uri: "slack://team/T/channel/C/message/123" }
{ provider: "lark", kind: "message", uri: "lark://tenant/T/chat/C/message/M" }
{ kind: "file", uri: "src/index.ts" }
{ kind: "url", uri: "https://example.com/background" }
{ kind: "text", uri: "original user-authored text" }
```

Adding the kinds does not mean every adapter must implement them immediately.

### `PermissionGrant`

Scopes what a run may do. Grants should stay narrow and explain their reason.

The current model already supports the right direction:

```text
repo:read
repo:write
issue:comment
chat:postMessage
pr:create
pr:update
runner:local
network:restricted
```

Future grants may need provider-specific extensions, but core should preserve
the small-reversible-permissions principle.

### Source-Thread Delivery Target

Defines where OpenTag may present results. The target is not just a transport
detail; it is the promise that work returns to the original context. The
provider-specific request is resolved later by the delivery adapter.

### `OpenTagRun`

Tracks lifecycle state. The current states are enough for the first loop:

```text
queued
assigned
running
needs_approval
succeeded
failed
cancelled
```

Before adding many organization-specific states, prefer run events for detail.
For example, `waiting_for_input` and `waiting_for_permission` can start as event
types before becoming top-level statuses. Delivery failure belongs to the
delivery journal rather than the run-status vocabulary.

### `RunEvent`

RunEvent is the natural home for the Agent Work Protocol expansion:

- lifecycle transition;
- progress checkpoint;
- permission wait;
- context packet generation;
- delivery intent enqueue or activation block;
- verification result;
- executor log reference;
- audit/debug-only detail.

RunEvent should eventually support:

- event type;
- timestamp;
- visibility;
- importance;
- message or structured payload;
- source pointer, when applicable.

### `OpenTagRunResult`

The final result should optimize for decision-making:

- conclusion;
- summary;
- changed files;
- created PR or artifact URLs;
- verification commands and outcomes;
- next action.

It should not be a raw transcript of executor output.

This is where "result artifact first" becomes concrete. The result object should
privilege what humans can review and reuse, not what the executor happened to
say along the way.

## Canonical V1 Object Model

The first durable object in OpenTag should not be the run. It should be the
combination of:

- **`workItemReference`**: the canonical external work item in the system of
  record;
- **`conversationAnchor`**: the specific thread or comment context where this
  invocation lives and where presentations return by default.

`run` is then an execution instance attached to that pair.

### Why The Durable Object Is Not `run`

Runs are transient attempts. The longer-lived object is the threaded work
conversation around a canonical work item:

- the same work item may produce many runs over time;
- a conversation anchor may generate proposals, approvals, reruns, and apply
  actions;
- audit, supersession, and approvals need a stable frame that outlives any one
  executor attempt.

### V1 Shape

In protocol terms, the model should feel closer to:

```ts
type WorkThread = {
  workItemReference: WorkItemReference;
  primaryAnchor: ConversationAnchor;
  secondaryAnchors?: ConversationAnchor[];
};

type OpenTagRun = {
  id: string;
  thread: WorkThreadRef;
  parentRunId?: string;
  triggeredByAction?: ActionHint;
  sourceProposalId?: string;
  sourceApplyPlanId?: string;
  status: RunStatus;
  result?: OpenTagRunResult;
};
```

The exact schema can wait, but the object boundaries should not.

### `WorkItemReference`

The canonical work item is external. OpenTag should not create a shadow task
model in core.

Examples:

- GitHub issue
- Linear ticket
- Jira issue
- mapped Lark work record

The implication is strong:

**OpenTag is the agent protocol attached to a work item thread, not the source
of truth for the work item.**

### `ConversationAnchor`

The anchor identifies where invocation and default presentations occur.

Examples:

- GitHub issue comment thread
- PR review comment thread
- Slack thread
- Lark thread

V1 should maintain:

- one **canonical work item**;
- one **primary anchor**;
- zero or more **secondary anchors**.

### Primary vs Secondary Anchors

The primary anchor is the control plane by default:

- default presentations return here;
- default approvals happen here;
- default proposal lineage is presented here.

Secondary anchors exist as linked context or optional delivery targets. They are
not equal peers in v1.

By default:

- secondary anchors do not receive presentations unless explicitly subscribed or
  selected by policy;
- secondary anchors are read surfaces, not approval surfaces;
- a secondary anchor only becomes a control plane if policy explicitly grants it
  that role.

This protects both the attention model and the single-anchor narrative.

## Proposal And Mutation Model

V1 should not treat a proposal as a sentence in a thread. It should be a
durable protocol object.

### `SuggestedChangesSnapshot`

Suggested changes should be represented as an immutable, addressable snapshot.

Key properties:

- it has a stable `proposal_id`;
- it is immutable once created;
- it can be approved, superseded, referenced, and audited later;
- it is not defined as "the latest suggestion in the thread."

This prevents approval from becoming ambiguous when multiple runs happen under
the same thread.

### Mutation Language

The core payload of a proposal should be **semantic mutation intents**, not raw
platform patches.

Examples:

- `set_priority(P1)`
- `set_assignee(Alice)`
- `transition_status(in_progress)`
- `add_label(bug)`
- `remove_label(needs-triage)`
- `request_review(team-security)`
- `link_artifact(pr_url)`

Adapter-specific patches are still important, but they are derived execution
plans, not the protocol body.

This keeps the protocol stable while allowing GitHub, Linear, Jira, and mapped
Lark systems to resolve the same semantic suggestion differently.

### Canonical Mutation Domains

To reason about supersession and approvals, core should define a small canonical
domain vocabulary. A practical v1 set is:

- `status`
- `assignee`
- `priority`
- `labels`
- `schedule`
- `review`
- `artifact_links`

Adapters may extend this when necessary, but core should not start from a
field-by-field mirror of every platform.

### Domain-Scoped Supersession

Supersession should default to the **mutation domain**, not the whole proposal.

If proposal A contains:

- `set_priority(P1)`
- `set_assignee(Alice)`

and proposal B later contains:

- `set_priority(P0)`

then B should supersede A only in the `priority` domain. The old assignment
intent should not be thrown away just because a later run refined a different
dimension of the work item.

So:

- proposal snapshots remain immutable bundles;
- current actionability is computed per domain;
- the "current proposal lineage" is really a domain-scoped lineage.

### Proposal Preconditions

A proposal should never be treated as timeless. It is valid only with respect
to the world it observed.

Each snapshot should carry preconditions such as:

- external work item state at proposal time;
- revision, version, `updated_at`, or equivalent freshness markers when the
  adapter can provide them;
- anchor-level or thread-level observations that materially shaped the proposal;
- supersession relationships.

This is what allows the system to mark a proposal as `stale` or `conflicted`
instead of blindly applying it later.

## Approval Model

Approval should be a first-class protocol concern, not an implicit effect of
someone typing "apply" in any visible place.

### Approval Authority

Approval authority should be defined as:

```text
platform capability ∩ OpenTag policy
```

That means:

- platform write permissions are necessary but not sufficient;
- OpenTag policy decides who may approve which domains;
- authority may differ for `priority`, `assignee`, `status`, `labels`, and
  future domains.

This prevents "whoever can comment can approve" from becoming the accidental
security model.

### Approval Granularity

A proposal is an immutable bundle, but approvals should support sub-selection.

That means:

- each intent should have a stable `intent_id`;
- a human may approve all intents;
- a human may approve only a subset of intents;
- a human may reject the remainder.

This should not mutate the original proposal snapshot. Instead, approval should
create a separate decision object.

### `ApprovalDecision`

The conceptual shape is:

```ts
type ApprovalDecision = {
  id: string;
  proposalId: string;
  approvedIntentIds: string[];
  rejectedIntentIds?: string[];
  approvedBy: ActorIdentity;
  approvedAt: string;
  scope: "manual" | "policy";
};
```

The exact names can change, but the separateness should not. Proposal and
approval are different objects.

### Default Approval Path

OpenTag should support many approval surfaces eventually, but the default should
stay simple and portable:

- a proposal appears in the primary anchor;
- it includes both human-readable explanation and machine-readable intent ids;
- a second explicit command approves it, such as `apply suggested changes`.

Richer approval UI such as buttons or auto-approval policies can be layered on
top later.

## Apply Model

Applying suggested changes should also become a durable object rather than a
thread side effect.

### `ApplyPlan`

An apply plan is derived from:

- a proposal snapshot;
- an approval decision;
- selected intent ids;
- an adapter-specific execution resolution.

Conceptually:

```ts
type ApplyPlan = {
  id: string;
  proposalId: string;
  approvalDecisionId: string;
  selectedIntentIds: string[];
  adapterPlan?: unknown;
};
```

Again, the exact schema can wait. The object boundary matters now.

### Default Apply Semantics

V1 should not pretend to have global transactionality across external systems.

The default behavior should be:

1. **Preflight**
   - validate authority
   - validate current permissions
   - validate adapter capability
   - validate proposal preconditions against the current world

2. **Execution**
   - run the adapter-specific patch plan

3. **Per-intent outcome**
   - `applied`
   - `skipped`
   - `failed`
   - `stale`
   - `unsupported`

Only adapters that can genuinely provide transactional guarantees should be
allowed to declare atomic apply behavior.

This is intentionally "preflight first, then per-intent outcome," not fake
atomicity.

## Next Action And Run Lineage

OpenTag v1 should guarantee that a run ends with something that can move the
work item forward. The minimum acceptable result is:

- `SuggestedChangesSnapshot`
- plus `nextAction`

### `nextAction`

`nextAction` should not be just prose. It should have two layers:

- a human-readable summary;
- a machine-readable action hint.

Examples:

- `apply_suggested_changes`
- `generate_patch`
- `request_human_decision`
- `link_to_work_item`
- `request_review`

This allows OpenTag to stay artifact-first without turning every next step into
manual interpretation.

### Next Actions Create New Runs

OpenTag should avoid hidden long transactions.

So the default rule should be:

- a run ends when it produces its result;
- executing a `nextAction` creates a **new run**;
- the new run carries lineage back to the previous run, proposal, and apply
  plan.

This keeps:

- permissions explicit;
- world-state checks fresh;
- audit timelines understandable;
- continuation from becoming an unbounded hidden session.

### Run Lineage

Useful lineage references include:

- `parent_run_id`
- `triggered_by_action`
- `source_proposal_id`
- `source_apply_plan_id`

Lineage is what makes a chain of small runs feel like one coherent piece of
work without collapsing them into one giant mutable transaction.

## Bootstrapping Without A Canonical Work Item

V1 should not treat every tagged conversation as permission to silently create a
new task system entry.

If there is no canonical work item yet, OpenTag should default to:

- suggesting a link to an existing work item;
- proposing creation of a canonical work item in an external system;
- or following a recipe/policy that explicitly allows automatic creation.

What it should not do by default:

- create an internal shadow work item as source of truth;
- silently convert every tagged thread into a new external issue or ticket.

This keeps the "not another workspace" promise honest.

## Layering

OpenTag should use layered ownership to prevent internal practice from hardening into
over-specific public APIs.

### 1. Core

Core owns stable protocol primitives:

- event;
- command;
- context pointer;
- context packet;
- permission grant;
- source-thread delivery target;
- run state;
- run event / timeline;
- runner binding;
- executor result.

Rule: if the concept still matters after removing Invoko, Lark, GitHub, and any
single executor, it may belong in core.

### 2. Official Adapters

Adapters connect workspace surfaces:

- GitHub issue, PR, comment, diff, CI, and source-thread presentations;
- Slack app mentions, thread keys, channel bindings, thread replies;
- Lark messages, threads, docs, Base links, and source-thread replies;
- webhooks and CLI events.

Adapters normalize platform shapes into core protocol. They should not define a
team's project management method.

### 3. Recipes

Recipes package opinionated workflows:

- GitHub PR review agent;
- Lark Chat-OPS feedback triage;
- support ticket investigation;
- bug reproduction handoff;
- release readiness review.

Recipes can define how to interpret platform-specific replies, fields, or
commands, but they should be optional.

### 4. Policies

Policies govern organization-specific behavior:

- stale run reminders;
- needs-acceptance flow;
- presentation verbosity;
- approval thresholds;
- context redaction;
- Base sync field mapping;
- quiet-agent defaults.

Policies should be configuration or plugin territory, not core assumptions.

### Policy Resolution Order

Policies need a deterministic resolution model or the governance layer will
collapse into surprising behavior.

The default precedence should be:

1. organization default
2. adapter / surface default
3. work context owner container policy
   - repo
   - project
   - space
4. optional work-item override
5. optional primary-anchor override

Conflict handling should follow two principles:

- more specific scope beats less specific scope;
- explicit deny beats implicit allow.

This gives OpenTag a stable answer to questions like:

- can this repo auto-create PRs?
- can this project auto-apply status transitions?
- can this secondary anchor approve anything?
- does this work item require manual approval regardless of higher defaults?

If we do not specify this now, "policy" will devolve into implementation
branches rather than protocol behavior.

### 5. Routers

Routers decide which executor, runner, or agent path should handle a run.

Routing may eventually consider:

- task type;
- repo policy;
- privacy constraints;
- cost and latency;
- historical executor performance;
- whether local execution is mandatory.

Router behavior should not be hard-wired into a single model preference. It is
the system expression of model neutrality.

## What Should Not Enter Core

The following should stay out of OpenTag core:

- Invoko-specific fields such as "具体问题", "谁接手了", "滞后时间", or "解决人备注".
- Fixed workflow states such as "待处理", "处理中", "已解决待验收", "已处理待发版", "Archive".
- Fixed `P0` / `P1` / `P2` meanings or SLA durations.
- Morning report behavior.
- Lark Base as mandatory storage.
- Passive monitoring of every group message.
- An agent chat room as the canonical place where work must move in order to
  involve AI.
- A complex management dashboard before the protocol has proven usage.

OpenTag may support all of these through adapters, recipes, and policies. It
should not be defined by them.

## Proposed Roadmap

## Success Metrics

OpenTag's product claim is not just "agent mentions work." It is that they work
with less context migration, less thread pollution, and more actionable output.

A useful v1 metric set should include:

| Metric | Why it matters |
| --- | --- |
| `time_to_first_useful_artifact` | Measures whether OpenTag helps users make progress quickly |
| `thread_attention_cost` | Human-facing presentation count and importance; validates Attention Budget without treating audit-event volume as noise |
| `artifact_acceptance_rate` | Measures whether `SuggestedChangesSnapshot` and related outputs are actually useful |
| `context_reuse_rate` | Measures whether users are reducing manual copy-paste and re-explanation |
| `external_write_approval_rate` | Measures whether explicit capability flows are understandable and trusted |
| `stale_proposal_rate` | Measures whether proposals remain actionable long enough to be useful |

These are product metrics, not just ops metrics. They tell us whether OpenTag
is actually reducing coordination drag.

### v0.2: Run Governance

Goal: make a run understandable without flooding the source thread.

- Add or document a first-class run event timeline.
- Add event visibility and importance concepts.
- Standardize acknowledgement/progress/final/audit presentation phases.
- Make delivery intent and journal evidence inspectable without inferring a
  provider outcome.
- Introduce the minimal Context Packet shape.
- Keep source threads quiet by default.

### v0.3: Lark As A First-Class Adapter

Goal: support China-native workspace surfaces without baking Lark workflows into
core.

- Normalize Lark message mentions into OpenTag events.
- Support Lark source-thread delivery targets.
- Add Lark context pointer kinds.
- Treat Lark docs and Base records as pointers first, not mandatory storage.
- Keep Base sync as optional recipe/policy behavior.

### v0.4: Chat-OPS Recipes

Goal: show the organizational pattern without making it universal.

- Add `examples/lark-chatops-feedback`.
- Demonstrate optional Base sync.
- Demonstrate thread correction as recipe logic.
- Demonstrate quiet presentations and audit-only details.
- Demonstrate stale-run reminder as policy.

### v0.5: Executor Routing And Oversight

Goal: make model neutrality operational instead of rhetorical.

- Add router interfaces for executor selection.
- Support policy-driven local vs hosted execution.
- Make audit and artifact views good enough for human oversight.
- Keep multi-agent coordination out of the human thread by default.

### v0.6: Policy And Adapter Ecosystem

Goal: let teams bring their own surfaces, executors, and governance rules.

- Executor adapter SDK.
- Workspace adapter SDK.
- Policy plugin interface.
- Context packet builder interface.
- Redaction hook interface.
- Hosted and self-hosted deployment guides.

## Open Questions

- Should `ContextPacket` become a required field on `OpenTagRun`, or remain an
  optional artifact generated by dispatcher/adapter policy?
- Should event `visibility` and `importance` live in core schema immediately, or
  first be documented as presentation policy?
- Which Lark primitives should be supported first: message mention,
  source-thread delivery, doc context, or Base record context?
- How should OpenTag expose audit logs: API only, CLI rendering, or a small web
  viewer?
- Should `waiting_for_input` and `waiting_for_permission` become statuses, or
  remain run events until workflows stabilize?
- How do we keep context redaction explainable without leaking the redacted
  content into audit logs?
- Should routing be a dispatcher concern, a runner concern, or a separate policy
  layer with explainable output?
- What is the smallest useful artifact vocabulary for `OpenTagRunResult` before
  we overfit to coding workflows?

## Implementation Notes

The safest path is incremental:

1. Document the protocol concepts before changing schemas.
2. Add non-breaking optional fields where existing types already have extension
   points.
3. Prefer run events over new top-level statuses until several workflows need
   the same state.
4. Build the Lark path as an adapter plus recipe, not core behavior.
5. Treat UI/dashboard ideas as downstream consumers of timeline and audit APIs.
6. Keep the protocol optimized for invocation, governance, and compression, not
   for simulating agent chat as a primary product surface.

## Decision Frame

When evaluating a feature, ask:

1. Is this cross-platform and executor-neutral? If yes, consider core.
2. Is this provider-specific? Put it in an adapter.
3. Is this an opinionated organizational method? Put it in a recipe or policy.
4. Is this only true for Invoko's current workflow? Keep it in an example.

The guiding sentence:

```text
Turn pain into narrative, commonality into protocol, platform differences into
adapters, organizational methods into recipes, and governance rules into policy.
```

An even shorter version:

```text
Invocation. Governance. Compression.
```
