# OpenTag Design

## Status

Architecture baseline, 2026-06-24.

This document captures the original OpenTag system shape and package
boundaries. For the current runtime-alignment work that matches the codebase,
see [Thread Runtime Alignment](./thread-runtime-design.md).

For the proposed next product and architecture direction—OpenTag as the open
control plane for governed software factories—see the repository-level
[Product Design](../DESIGN.md) and [Software Factory Control Plane](./software-factory-control-plane.md).

For the optional shared service—identity, runner pairing, public
ingress, tenant-scoped coordination, and retained audit while execution stays
local—see the [Node/PostgreSQL Control Plane architecture](./control-plane-runtime-architecture.md)
and [ADR 0003](./adr/0003-node-postgresql-control-plane.md). The clean-room
Node/PostgreSQL implementation exists locally; managed deployment, publication,
and production activation are not implied.

## One-Liner

OpenTag turns an existing work thread into a governed agent work loop: tag any approved agent from a workspace surface, route the request through bounded context, scoped permissions, executor capability checks, an append-only work ledger, and artifact-first delivery presentations, then let a local or user-controlled runner execute the work and report back without creating a new AI workspace.

## Why Now

Agent mentions are becoming a natural interaction pattern inside team
collaboration tools. The opportunity for OpenTag is to make that pattern open,
vendor-neutral, and protocol-first:

- OpenTag brings approved agents into existing workspace surfaces.
- OpenTag supports multiple executors instead of binding the workflow to one model.
- OpenTag treats local runners and auditable source-thread context as core product boundaries.
- OpenTag treats artifacts and agent work ledger entries as the durable output of a run; chat presentations are concise projections, not the system of record.
- OpenTag should stay protocol-first, executor-neutral, and local-runner friendly.

The first release should move fast enough to ride the conversation while still proving the idea with a real end-to-end task flow.

## Product Goal

OpenTag should let a person write something like:

```text
@opentag fix this flaky test
```

from GitHub, Slack, or a similar workspace surface, then have OpenTag:

1. Recognize the tagged agent request.
2. Normalize the workspace event into a stable OpenTag event.
3. Check actor, target, context, and permission scope.
4. Create a run with auditable state.
5. Persist a context packet snapshot and ledger entries that make the work replayable.
6. Dispatch the run to an approved local or user-controlled executor with declared capability.
7. Return concise artifacts, action receipts, and safe next actions to the original surface.

## First Release Scope

The first release combines a fast open-source launch with one real MVP:

- A public repository with a clear README, design document, and protocol draft.
- A GitHub App MVP powered by Probot at the edge.
- An extremely thin hosted dispatcher for public webhook ingress, run persistence, runner lease claiming, and delivery-intent enqueueing.
- A local runner daemon that can receive or poll for OpenTag runs.
- At least one executor adapter for a coding agent, plus a smoke-test executor.
- A provider delivery adapter that posts status and final results back to GitHub.

The first release should not attempt to support every workspace, every agent, every permission model, or every deployment shape.

## Non-Goals For V0

- No additional workspace apps in the first implementation milestone.
- No custom hosted IDE or chat UI.
- No general-purpose agent framework.
- No dependency on a single executor framework.
- No broad multi-tenant SaaS control plane until the local GitHub flow proves demand.
- No Rust requirement for v0. Keep the default implementation in TypeScript unless packaging, security, or performance constraints prove otherwise.
- No autonomous background execution without an explicit mention, command, or approval boundary.

## Core Product Principles

- Open core, closed surfaces optional: the protocol and local runner path should be usable without depending on a hosted SaaS.
- Protocol at the center: GitHub, Slack, and future surfaces are adapters, not the architecture.
- Local-first execution: the runner can live on the user's machine so repo access, credentials, build tools, and private context stay local.
- Auditable by default: every run records who asked, what context was provided, what permissions were granted, which executor ran, and where the result was posted.
- Small reversible permissions: each tagged run receives a narrow grant instead of inheriting broad ambient authority.
- Adapter neutrality: built-in, local CLI, hook-ingest, workflow, and custom agent runtimes should all be possible executors.

## System Shape

```text
Workspace Surface
  GitHub issue comment / PR comment
  Slack app mention
        |
        v
GitHub Ingress App
  Probot webhook handler
Slack Ingress App
  Events API webhook handler
        |
        v
OpenTag Core
  event normalization
  target parsing
  policy check
  run creation
        |
        v
Dispatch Layer
  thin hosted dispatcher
  run queue, leases, audit events, delivery intents
        |
        v
OpenTag Local Daemon
  workspace checkout access
  executor adapter
  progress streaming
        |
        v
Executor
  built-in / local CLI / hook-ingest / custom
        |
        v
Delivery Kernel + Provider Adapter
  GitHub status comment / PR / summary
  Slack thread reply
```

## Runtime Readiness And Interaction Model

The next runtime hardening track should treat service health, credentials,
platform capability, executor capability, source-thread commands, delivery
safety, and user-visible status as one product model instead of separate
features. OpenTag should make it obvious whether a request can be accepted,
executed, stopped, and reported back before a powerful local runner starts work.

```text
Source Thread
  Slack / Lark / Feishu / GitHub
        |
        v
Project Target + Admission
  actor, target, permissions, binding, capability
        |
        v
Run Lifecycle
  active run, follow-up queue, duplicate guard, stop, timeout
        |
        v
Executor Runtime
  spawn, hook ingest, session profile, workspace isolation
        |
        v
Presentation
  concise presentation, action receipt, status card, audit detail
        |
        v
Readiness Plane
  service health, secret refs, platform capability, executor capability
```

### Readiness Plane

OpenTag needs a first-class readiness model that can be used by `setup`,
`doctor`, `status`, `service status`, source-thread `/doctor`, and future UI
surfaces. A process can be managed by the OS and still be unusable; a credential
can be present and still be invalid; a provider can support plain replies but
not rich cards or message updates. The readiness plane should report those
differences directly.

Readiness checks should be grouped into four families:

- `ServiceCapability`: whether the OS controller is installed/running, whether
  the OpenTag runtime has a recent heartbeat, whether connectors are connected,
  and whether an exact provider delivery adapter is activated.
- `CredentialCapability`: where each secret comes from, whether the reference
  is resolvable, whether the credential has been verified against the provider,
  and whether it is safe to display only as a redacted reference.
- `PlatformCapability`: whether a platform can receive events, reply in the
  source thread, update a status message, render rich presentation, receive
  action replies, and enforce mention/addressing rules.
- `ExecutorCapability`: whether an executor exists, can run in the target
  workspace, supports session profiles, supports cancellation, supports
  streaming or hook completion, and requires any additional credentials.

Manual Lark or Feishu credentials should be verified before OpenTag writes them
to local configuration. A partial or invalid app ID/secret pair should fail
during setup instead of creating a configuration that only fails later at
service start.

Secrets should not depend only on `chmod 600`. Local file permissions remain a
useful baseline, but config should allow secret references:

```ts
type SecretRef =
  | { kind: "env"; name: string }
  | { kind: "keychain"; service: string; account: string }
  | { kind: "file"; path: string };
```

The CLI can still support inline local secrets for early development, but
status output, config printing, logs, and source-thread diagnostics must render
the reference and verification state rather than the secret value.

`opentag service status` should distinguish controller state from runtime
readiness. A healthy launchd job is only one layer. The command should report at
least:

- `controller`: unsupported, installed, running, or stopped.
- `runtime`: ready, starting, degraded, stale heartbeat, or unreachable.
- `connectors`: per-platform ingress, delivery, and direct-apply readiness.
- `executor`: selected executor availability and important capability gaps.
- `secrets`: redacted references plus verification status.

### Project Target Self-Service

Source-thread self-service should reinforce the Project Target model. A chat,
channel, or thread can bind to a project target such as
`github:owner/repo`; it should not bind directly to an absolute local checkout
path. Local paths belong in local runner configuration and allowlists, not in
group chat history.

The initial command set should stay small and safe:

- `/bind <owner>/<repo>` or `/bind <provider>:<owner>/<repo>` connects the
  current source container to a Project Target.
- `/status` shows the current Project Target, active run, pending follow-ups,
  and the next safe action.
- `/help` shows supported commands and platform-specific addressing rules.
- `/doctor` shows a redacted readiness summary for this source container.
- `/stop [run_id]` requests cancellation for the active run in this scope.
- `/unbind` disconnects the source container from its Project Target after an
  explicit confirmation or admin-capable authorization check.

Group chats should require explicit addressing before they trigger a run or
mutate a binding. Direct messages may be more permissive, but they still must
respect Project Target binding and actor policy.

When a source container is unbound, OpenTag should guide the user toward an
explicit binding instead of silently creating rooms, silently choosing a target,
or replaying old messages into a new project context. Project room proposals can
be a helpful onboarding flow, but the user should choose the target and the
binding should start from that point forward.

### Run Scope, Queueing, Stop, And Timeout

Run admission, duplicate protection, follow-up queueing, cancellation, and
timeout behavior should be scoped consistently. The scope should be:

```ts
type RunScope = {
  projectTarget: string;
  sourceProvider: string;
  sourceThreadKey: string;
};
```

Within a `RunScope`, OpenTag should maintain at most one active run. New work in
the same scope should become a durable follow-up unless the incoming event is a
duplicate replay. This gives users predictable behavior:

- duplicate source events reuse the existing run and record an audit event.
- same-thread follow-ups are queued behind the active run.
- natural terminal completion promotes the next queued follow-up, while
  explicit human stop leaves queued follow-ups paused until a later promotion.
- status surfaces show the active run and queued follow-ups, including a safe
  command summary for queued requests when one is available.
- cancellation acts on the active run unless a run ID is supplied.
- timeout policy is visible before and during execution.

Source-thread delivery needs duplicate-storm safety. The unified producer
creates an immutable delivery intent with an idempotency key before provider
I/O. The side-effect kernel owns leasing, fenced settlement, and retry. A
provider outcome is true only when recorded by the delivery journal or a signed
provider observation; run events record queued intent or activation block only.

The core `RunStatus` schema uses `succeeded`, `failed`, `cancelled`,
`interrupted`, and `timed_out` for terminal run states. Higher-level terminal
reasons should still distinguish:

- `succeeded`: the executor finished successfully.
- `failed`: execution or verification failed.
- `cancelled`: a human requested stop and OpenTag acknowledged it.
- `interrupted`: the process/session ended without a normal completion signal.
- `timed_out`: idle or hard timeout policy ended the run.

`/stop` should not be treated as a successful completion signal. If the selected
executor supports cancellation, OpenTag should call it. If it does not, OpenTag
should mark the run as cancellation-requested, suppress further nonessential
human-facing presentations, and report whether the underlying process may continue outside
OpenTag's control.

### Presentation Model

OpenTag should produce semantic presentation objects before rendering
provider-specific messages. Provider adapters can then choose plain text, rich
cards, message updates, reactions, or thread replies based on capability.

```ts
type OpenTagPresentation =
  | { kind: "run_status"; runId: string; state: string; nextAction?: string }
  | { kind: "action_receipt"; title: string; actions: SourceThreadAction[] }
  | { kind: "doctor_summary"; checks: ReadinessCheck[] }
  | { kind: "final_summary"; outcome: string; changedFiles?: string[]; nextActions?: string[]; auditRunId?: string };
```

Default source-thread output should stay concise. A normal run should produce a
light acknowledgement when useful, a clear final summary, and explicit next
actions. Internal executor steps, tool traces, and detailed process messages
belong in audit/status surfaces by default, not in the human thread.

Richer cards should improve readability without changing the trust boundary.
They are appropriate for:

- final summaries.
- readiness or doctor summaries.
- active-run and queue status.
- source-thread action receipts.

They should not become a default stream of internal agent process messages.
Detailed progress can be pulled through `/status`, `opentag status`, logs, or
the audit timeline. If an executor or hook requests human-visible progress but
the platform liveness strategy keeps that source thread quiet, OpenTag should
record an audit-visible suppression event with the provider strategy and reason
instead of silently dropping the presentation. `opentag status --run` should
surface that liveness strategy, queued delivery intents, activation blocks, and
any suppressed progress presentations. Provider outcomes come from the delivery
journal or signed observations, never inference from the enqueue event.
Final-summary renderers should preserve the audit/status pointer in both rich
native UI and plain text fallback, so every provider has a source-thread-visible
path back to local audit detail without exposing internal process messages by
default.

OpenTag should support lightweight liveness where the platform allows it. A
provider may show "received", "queued", "running", or "waiting for approval"
through typing indicators, reactions, message updates, or short status cards.
The capability catalog decides which mechanism is available, and presentation
renderers should consume that shared catalog instead of hard-coding provider
names. Current liveness strategies are:

- `status_update`: deliver concise run-status presentations when the provider can
  keep them concise or updatable.
- `source_receipt`: use a native receipt/reaction path first, with text
  acknowledgement only as fallback. Receipt-capable platforms can represent
  low-noise states such as `received` and `running` without posting executor
  progress into the human thread.
- `thread_reply`: use a short source-thread reply because the provider has no
  better liveness primitive.
- `pull_status`: keep the thread quiet by default and make users pull detail
  through `/status`, `opentag status`, logs, or audit.

### Executor Runtime Capability

The executor adapter contract should grow from a process wrapper into a runtime
capability contract. OpenTag still routes work to executor targets, but each
executor must declare enough behavior for setup, doctor, service status, stop,
and completion handling to be honest.

```ts
type ExecutorCapability = {
  id: string;
  invocation: "spawn" | "hook_ingest" | "hybrid";
  supportsProfile: boolean;
  supportsStreaming: boolean;
  supportsCancel: boolean;
  supportsHookCompletion: boolean;
  progressEvents: "none" | "audit" | "human";
  approvalMode: "none" | "opentag_policy" | "executor_managed";
  contextAccess: Array<"context_packet" | "context_pointers" | "workspace">;
  promptAssembly: "opentag" | "executor_adapter" | "external_runtime";
  writeAccess: "none" | "workspace" | "external";
  conversationAccess: "none" | "request" | "thread_transcript";
  promptMutation: "none" | "append" | "replace";
  rawContextAccess: boolean;
  writeActionAccess: "none" | "propose" | "execute";
  workspaceIsolation: "none" | "branch" | "worktree" | "external";
  workspaceCwdConformance?: "declared" | "unverified";
  requiredSecrets: SecretRefRequirement[];
  completionSignals: CompletionSignalDescriptor[];
};
```

`workspaceCwdConformance` is a shared audit surface for executor adapters.
Generic ACP manifests require the explicit `declared` attestation and fail
schema parsing without it; `unverified` remains available for other adapters
that must report they cannot attest session-cwd behavior. Transport of the path
alone is not evidence that an agent's real file tools honor it.

Spawn-based executors remain the simplest path: OpenTag creates an isolated
branch or worktree, starts the command with bounded context, captures output,
and reports a structured result. Hook-ingest executors let an external local
agent runtime report progress or final completion back to OpenTag through a
local authenticated channel. Hybrid executors may use both.

Hook ingest should be local-first and explicitly authenticated. A future
`opentag ingest` command or loopback endpoint can accept normalized progress and
completion events, but it should require a local token or secret reference and
should map external event names into OpenTag's own lifecycle vocabulary.
Templates should expose both a runnable local shell shape and a machine-readable
manifest that declares event mappings, terminal semantics, idempotency keys, and
hook permission boundaries.
Executor progress declarations should describe where process updates are safe to
show by default. Built-in local executors use audit-visible progress, keeping
source threads concise while still making status and diagnostics useful.
Approval declarations should make it clear whether OpenTag policy controls
write boundaries or whether an external runtime manages its own approval loop.
Context, prompt, and write-access declarations make plugin-like executor trust
boundaries explicit: a source-thread user should be able to tell whether an
executor reads only the curated context packet, also sees raw context pointers,
can inspect the local workspace, assembles its own prompt, or can write back to
workspace or external systems.
Conversation, prompt-mutation, raw-context, and write-action gates should stay
separate from workspace write access. A future external runtime might be allowed
to read only the triggering request but not the full source-thread transcript,
append diagnostic context without replacing OpenTag policy prompt text, see only
curated context rather than raw provider payloads, and propose source-thread
actions without executing them directly.

Session/profile identity should become executor-neutral. A run may need a
stable agent session profile derived from source provider, source thread,
Project Target, and actor policy. That profile controls tool access, memory,
configuration, and session behavior for the executor, without exposing local
paths or secrets to the source thread.

### Implementation Order

The hardening path should start with safety and observability before deeper
runtime integrations:

1. Verify manual Lark/Feishu credentials before saving them.
2. Add `SecretRef` support for env, file, and local secret-manager references;
   keep redaction consistent in config, logs, status, and source-thread
   diagnostics.
3. Split service status into controller state and runtime readiness.
4. Add the minimal platform and executor capability catalog needed by setup,
   doctor, status, and service status.
5. Use one immutable delivery-intent journal with fenced settlement and
   duplicate-storm protection.
6. Improve source-thread `/help`, `/status`, and `/doctor` around Project
   Target binding, active runs, queued follow-ups, and safe next actions.
7. Add `/stop` and explicit timeout UX on top of executor cancellation
   capability.
8. Route semantic presentations through the unified producer with rich-card
   adapters where supported and plain-text fallback everywhere.
9. Generalize agent session profiles across executors.
10. Add authenticated local hook ingest for external agent runtimes after the
    lifecycle and readiness model is stable. Start with local CLI templates that
    map source-specific hook names into OpenTag lifecycle semantics; native
    plugins can come later once the capability and presentation contracts are
    stable.

## Package Boundaries

Suggested repository layout:

```text
packages/opentag-core
packages/opentag-client
packages/opentag-dispatcher
packages/opentag-github
packages/opentag-slack
packages/opentag-runner
packages/opentag-store
apps/github-probot
apps/slack-events
apps/dispatcher
apps/opentagd
examples/github-to-codex
examples/github-to-omp
docs/
```

### `packages/opentag-core`

Owns the stable OpenTag domain model. It must not import Probot, Octokit, Slack SDKs, workspace SDKs, or executor-specific packages.

Responsibilities:

- `OpenTagEvent` types.
- `OpenTagRun` lifecycle.
- target parsing rules.
- permission grant model.
- source-thread delivery target model.
- run status vocabulary.
- serialization and validation.

### `packages/opentag-client`

Owns the HTTP client contract for systems that create, claim, or update runs through a dispatcher.

Responsibilities:

- create dispatcher runs from normalized `OpenTagEvent` objects.
- register runners and bind repositories or Slack channels.
- claim runs for local or user-controlled runners.
- report runner heartbeat, progress, running status, and final results.
- validate dispatcher responses at the package boundary.

### `packages/opentag-dispatcher`

Owns the embeddable dispatcher application, unified delivery producer, and
side-effect kernel interfaces.

Responsibilities:

- expose the Hono app factory for services that want to host OpenTag themselves.
- accept normalized OpenTag events from ingress apps.
- persist runs and audit events through `packages/opentag-store`.
- expose runner pairing and polling endpoints.
- implement lease-based run claiming.
- receive runner status updates.
- enqueue provider-neutral presentations and record only truthful intent audit
  events; provider outcomes are settled through the delivery journal.

### `packages/opentag-github`

Owns GitHub-specific ingress translation and presentation rendering.

Responsibilities:

- convert GitHub webhook payloads into `OpenTagEvent`.
- map repository, issue, PR, branch, and comment context.
- post status comments.
- optionally open branches or PRs in later milestones.

### `packages/opentag-slack`

Owns Slack-specific ingress translation and delivery adaptation.

Responsibilities:

- convert Slack `app_mention` payloads into `OpenTagEvent`.
- encode and decode Slack thread keys for source-thread delivery.
- map bound channels to repository context.

### `apps/github-probot`

Owns the Probot GitHub App edge.

Responsibilities:

- receive GitHub webhooks.
- validate installation and event type.
- detect `@opentag` mentions.
- call `packages/opentag-github` and `packages/opentag-core`.
- enqueue a run for the dispatcher.

Probot is intentionally an edge dependency only. If future deployment requires Octokit directly, Cloudflare Workers, or a different webhook server, this app can be replaced without changing the core protocol.

### `apps/slack-events`

Owns the Slack Events API edge.

Responsibilities:

- verify Slack request signatures.
- answer `url_verification`.
- normalize `app_mention` events from bound channels.
- create dispatcher runs using the same control-plane contract as GitHub ingress.

### `apps/dispatcher`

Owns the runnable Node process for the extremely thin hosted control plane.

Responsibilities:

- read deployment configuration from environment variables.
- compose the unified delivery producer, provider registry, and side-effect
  kernel.
- start the `packages/opentag-dispatcher` Hono app with `@hono/node-server`.

The dispatcher should stay boring. It is not an agent runtime, workflow engine,
hosted IDE, or chat product. It admits public workspace events, coordinates
private/local runners, and enqueues provider-neutral delivery presentations
without requiring the user's machine to expose an inbound port.

### `packages/opentag-store`

Owns persistence schemas and repository-style accessors.

Responsibilities:

- run storage.
- audit event storage.
- runner registration storage.
- repository-to-runner binding storage.
- lease claiming primitives.

The v0 store can be SQLite or libSQL with a simple state machine. Avoid Redis, Temporal, Trigger.dev, Inngest, or other durable workflow platforms until the run lifecycle proves it needs them.

### `apps/opentagd`

Owns the local daemon.

Responsibilities:

- authenticate with the dispatcher.
- poll or receive assigned runs.
- resolve local workspace paths.
- start executor adapters.
- stream logs, status, and final artifacts.
- report completion or failure.

The local daemon is the main product differentiator. It lets OpenTag work with existing local coding environments instead of forcing all execution into a hosted black box.

### `packages/opentag-runner`

Owns executor-neutral runner contracts and common lifecycle handling.

Responsibilities:

- executor adapter interface.
- process spawning contract.
- timeout and cancellation.
- status normalization.
- artifact and patch reporting.
- structured final result.

## Core Data Model

### OpenTag Event

```ts
type OpenTagEvent = {
  id: string;
  source: string;
  sourceEventId: string;
  receivedAt: string;
  actor: ActorIdentity;
  target: AgentTarget;
  command: OpenTagCommand;
  context: ContextPointer[];
  workItem?: WorkItemReference;
  permissions: PermissionGrant[];
  deliveryTarget: SourceThreadDeliveryTarget;
  metadata: Record<string, unknown>;
};
```

### Actor Identity

```ts
type ActorIdentity = {
  provider: string;
  providerUserId: string;
  handle?: string;
  displayName?: string;
  organizationId?: string;
};
```

### Agent Target

```ts
type AgentTarget = {
  mention: string;
  agentId: string;
  executorHint?: "claude-code" | "codex" | "hermes" | "openclaw" | "custom";
  workspaceHint?: string;
};
```

### Command

```ts
type OpenTagCommand = {
  rawText: string;
  intent: "fix" | "review" | "investigate" | "explain" | "run" | "unknown";
  args: Record<string, string | boolean | number>;
};
```

### Context Pointer

```ts
type ContextPointer = {
  provider?: string;
  kind: string; // e.g. "issue", "pull_request", "message", "file", "url", "text"
  uri: string;
  title?: string;
  visibility: "public" | "private" | "organization";
};
```

### Permission Grant

```ts
type PermissionGrant = {
  scope: string;
  reason: string;
  expiresAt?: string;
};
```

### Source-Thread Delivery Target

```ts
type SourceThreadDeliveryTarget = {
  provider: string;
  uri: string;
  threadKey?: string;
};
```

### Run

```ts
type OpenTagRun = {
  id: string;
  eventId: string;
  status:
    | "queued"
    | "assigned"
    | "running"
    | "needs_approval"
    | "succeeded"
    | "failed"
    | "cancelled";
  assignedRunnerId?: string;
  executor?: string;
  createdAt: string;
  updatedAt: string;
  result?: OpenTagRunResult;
};
```

## Hosted Dispatcher

The v0 hosted dispatcher exists because GitHub webhooks need a public endpoint while the executor should remain local-first. It should be as small as possible:

- receive normalized events from `apps/github-probot`.
- create and persist `OpenTagRun` records.
- let paired local daemons poll for eligible runs.
- lease a run to exactly one daemon at a time.
- accept status/result updates from the daemon.
- enqueue acknowledgement, progress, and final presentations through the
  unified delivery producer.

The dispatcher should not inspect local files, hold provider credentials,
execute agent code, or own workspace-specific business logic. Provider
credentials belong to exact provider-instance adapters.

### V0 Run State Machine

```text
queued
  -> assigned
  -> running
  -> needs_approval
  -> succeeded
  -> failed
  -> cancelled
```

Lease fields should be explicit:

```ts
type RunLease = {
  runId: string;
  runnerId: string;
  leasedAt: string;
  leaseExpiresAt: string;
  heartbeatAt?: string;
};
```

If a lease expires, the dispatcher can move the run back to `queued` or mark it `failed` depending on retry policy.

### V0 Storage

Start with four tables:

- `runs`: current run state and normalized event snapshot.
- `run_events`: append-only audit events.
- `runners`: registered local daemon identities.
- `repo_bindings`: provider repo to runner/workspace mapping.

This is enough for a real demo without introducing a workflow platform.

## GitHub And Slack MVP Flow

### Trigger

The v0 trigger is an issue comment, pull request review comment, or Slack app mention:

```text
@opentag fix this
@opentag review this PR
@opentag investigate the failing test
<@opentag> fix this
```

### Ingress

`apps/github-probot` listens for:

- `issue_comment.created`
- `pull_request_review_comment.created`

The handler ignores events without a configured OpenTag mention.

`apps/slack-events` listens for:

- `url_verification`
- `event_callback` where `event.type === "app_mention"`

The Slack handler ignores mentions from unbound channels and rejects invalid signatures.

### Normalization

The GitHub adapter extracts:

- repository owner/name.
- issue or pull request number.
- comment URL and body.
- actor login and ID.
- installation ID.
- source-thread delivery target.

It creates an `OpenTagEvent` and stores or enqueues it.

The Slack adapter extracts:

- team ID and channel ID.
- source user ID and thread timestamp.
- bound repository owner/name from the channel mapping.
- source-thread target used by the Slack delivery adapter.

It creates an `OpenTagEvent` and stores or enqueues it.

### Runner Assignment

For v0, runner assignment can be simple:

- a single local daemon is paired with a single GitHub installation or repo.
- the daemon polls for eligible runs.
- the dispatcher returns one queued run at a time.
- the daemon claims the run before execution.

### Execution

The local daemon:

1. Finds the configured local checkout.
2. Creates an isolated worktree or branch for the run.
3. Starts the selected executor with a bounded prompt.
4. Streams status back to OpenTag.
5. Produces a structured final result.

### Delivery

The GitHub delivery adapter posts:

- initial acknowledgement: "OpenTag picked this up."
- progress checkpoints for long runs.
- final success/failure summary.
- optional PR link when the executor creates a change.

The Slack delivery adapter posts:

- initial acknowledgement in the source thread.
- progress checkpoints in the same thread.
- final success/failure summary.
- optional PR link when one is created.

## Executor Adapter Contract

An executor adapter should hide tool-specific process details behind one interface:

```ts
type ExecutorAdapter = {
  id: string;
  displayName: string;
  canRun(input: ExecutorRunInput): Promise<ExecutorReadiness>;
  run(input: ExecutorRunInput, sink: ExecutorEventSink): Promise<ExecutorRunResult>;
  cancel(runId: string): Promise<void>;
};
```

The first executor adapter can be intentionally narrow. For example:

- run a command-line coding agent in a local checkout.
- pass the normalized task prompt and context.
- capture stdout/stderr and final summary.
- report whether files changed.

The adapter should not decide OpenTag permissions. It receives an already-authorized run and reports what it did.

## Framework Choices

### TypeScript As The Default Stack

Use TypeScript across the v0 repository: Probot app, dispatcher, protocol schemas, runner contracts, CLI, and local daemon.

Reasons:

- GitHub, Slack, Probot, Octokit, and most agent SDK ecosystems are already TypeScript-friendly.
- One type system can cover the protocol, adapters, dispatcher, and daemon.
- Zod or a similar schema library can validate runtime payloads and export public JSON Schema.
- A TypeScript daemon is easier to iterate while the runner contract is still changing.

### Rust Deferred For V0

Do not choose Rust as a default implementation language for v0.

Rust may become useful later for:

- a hardened local daemon with stronger process isolation.
- native packaging and auto-update flows.
- high-volume log streaming or patch processing.
- a security-sensitive sandbox boundary.

For the first release, Rust adds cross-language build complexity before the architecture has proven the tag-to-run loop. Keep Rust as a future local-runtime optimization, not a product prerequisite.

### Probot For GitHub V0

Use Probot for the first GitHub App because it is the fastest way to receive GitHub App webhooks and call GitHub APIs from Node.js.

Constraint:

- Probot must stay at the edge. No Probot types in `opentag-core`.

Rejected alternative:

- Direct Octokit for v0. Octokit gives more control and may be better for a future custom edge gateway, but it requires more webhook and app-auth wiring before OpenTag has proven the core flow.

### Optional Orchestration Layer

Workflow engines, agent abstractions, memory systems, observability layers, and
model-routing libraries should remain optional implementation details. They
must not define the OpenTag protocol or leak provider-native concepts into
shared schemas.

V0 should only introduce a dedicated orchestration layer if it materially
reduces implementation time for run orchestration. Otherwise, lightweight
TypeScript primitives are preferable until the domain model stabilizes.

### Shared Action Surface

OpenTag actions should be reusable across UI, HTTP, MCP, CLI, and agents
without making any one app-native action framework a required dependency.

### Cloud Demo Option

A cloud demo can be useful for showing the workspace mention loop, especially
for chat-first teams. It should be treated as an optional adapter path, not the
core product shape.

### Executor Adapters

Specific coding agents are best treated as executor targets. OpenTag can route a
run to an approved executor, but OpenTag should not become a remote-control
wrapper for any single agent runtime.

## Permissions And Trust

OpenTag needs explicit trust boundaries because mentions can look casual while execution may be powerful.

V0 policy:

- Only configured repositories can trigger runs.
- Only configured actors or teams can invoke write-capable tasks.
- Every event gets an explicit permission grant list.
- Local runner pairing is explicit.
- The runner should reject runs outside configured workspace paths.
- Dangerous operations require either local confirmation or a future approval state.

Important future policy questions:

- Should `@opentag fix` be allowed to push directly, or only open a PR?
- Should a reviewer approval be required before write operations?
- Should organization admins define agent allowlists centrally?
- How should local secrets be protected from prompt-injected repo content?

## Audit Log

Each run should preserve:

- original source event ID and URL.
- actor identity.
- normalized command.
- context pointers.
- permission grants.
- assigned runner.
- executor adapter.
- start/end timestamps.
- status transitions.
- delivery intent and provider-outcome evidence.
- artifact or PR links.

The audit log is part of the product, not an implementation detail. It is how OpenTag earns trust as an open alternative to opaque chat-agent execution.

## Local Runner Pairing

The initial pairing model can be simple:

1. User installs `opentagd`.
2. User logs in or registers the daemon with a pairing token.
3. User maps a GitHub repo to a local checkout path.
4. User selects a default executor adapter.
5. The daemon starts polling for assigned runs.

Example config:

```json
{
  "runnerId": "runner_local_mingyoo_macbook",
  "repositories": [
    {
      "provider": "github",
      "owner": "example",
      "repo": "demo",
      "checkoutPath": "/Users/mingyoo/repos/demo",
      "defaultExecutor": "codex"
    }
  ]
}
```

## Result Model

The final result should be structured so each surface can render it consistently:

```ts
type OpenTagRunResult = {
  conclusion: "success" | "failure" | "cancelled" | "needs_human";
  summary: string;
  changedFiles?: string[];
  createdPullRequestUrl?: string;
  artifacts?: { title: string; uri: string }[];
  verification?: {
    command: string;
    outcome: "passed" | "failed" | "not_run";
    excerpt?: string;
  }[];
  nextAction?: string;
};
```

## User-Facing Voice

OpenTag should sound concrete, open, and developer-native.

Good copy:

```text
OpenTag is the open mention layer for agents.
Tag approved coding agents or your own local runner from GitHub or Slack.
```

```text
Bring approved agents into the workspace where the request already has context.
```

```text
Your workspace stays collaborative. Your execution stays under your control.
```

Avoid:

- "AI teammate platform" as the primary phrase, because it sounds generic.
- "Slack bot clone", because it loses the protocol and local-runner angle.
- "Agent framework", because OpenTag should route agents, not replace them.

## Milestones

### Milestone 0: Public Concept

Deliverables:

- repository created.
- README with one-liner, comparison, and demo target.
- this design document.
- protocol draft with `OpenTagEvent`, `OpenTagRun`, and presentation types.

Success:

- a developer can understand the idea in less than one minute.
- a future contributor can see what to build first.

### Milestone 1: GitHub Mention To Queued Run

Deliverables:

- Probot app receives GitHub comments.
- `@opentag` mention detection works.
- GitHub event normalizes into `OpenTagEvent`.
- run is created in a simple store.
- acknowledgement comment is posted.

Success:

- commenting `@opentag investigate this` on an allowed issue creates a run and posts an acknowledgement.

### Milestone 2: Local Daemon Claim And Execute

Deliverables:

- `opentagd` can pair with the app.
- repo-to-local-path mapping exists.
- daemon polls for queued runs.
- daemon claims and starts an executor adapter.
- status updates are posted back.

Success:

- a local runner receives a GitHub-triggered run and executes a no-op or echo adapter end to end.

### Milestone 3: Coding Agent Adapter

Deliverables:

- first real coding-agent adapter.
- worktree or branch isolation.
- final summary capture.
- changed-file detection.
- GitHub final comment.

Success:

- `@opentag fix this` can produce a local code change and report what happened.

### Milestone 4: Pull Request Path

Deliverables:

- branch creation.
- push or patch export path.
- PR creation.
- verification summary in PR body.

Success:

- a tagged GitHub issue can result in a linked PR.

## Resolved V0 Decisions

- First real executor: a local coding-agent adapter, with echo retained as the smoke-test executor.
- First public demo: local CLI/HTTP replay, while the Probot GitHub App path remains implemented for real installations.
- Minimum write approval model: write-capable work is constrained to an isolated branch plus pull request; direct writes to the target branch are not part of v0.
- Protocol schema: TypeScript/Zod schemas are the source of truth and `@opentag/core` exports public JSON Schema definitions for `OpenTagEvent`, `OpenTagRun`, and `OpenTagRunResult`.
- Orchestration framework: no required workflow dependency in v0; use lightweight TypeScript primitives until workflows justify a dedicated framework.

## Recommended First Implementation Decision

Use Probot for GitHub ingress, a very thin hosted dispatcher for run persistence and runner leasing, TypeScript for v0 implementation, and the local daemon as the differentiating path.

This gives the project a fast demo without sacrificing the bigger thesis:

```text
OpenTag is not a GitHub bot.
OpenTag is not an agent framework.
OpenTag is the open Agent Work Protocol between collaboration surfaces and user-controlled agent executors.
```
