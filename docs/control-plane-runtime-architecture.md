# Node/PostgreSQL Control Plane architecture

## Status

Accepted design; local clean-room implementation in verification, 2026-08-15.

This document expands
[ADR 0003](./adr/0003-node-postgresql-control-plane.md). It describes a clean
implementation of the optional shared Control Plane. A previous private
reference is a black-box behavior oracle only and is not present in this clean
worktree. The Node/PostgreSQL replacement is implemented locally. It has not
been published, deployed to a managed environment, or activated in production.

The current product scope and authority model remain defined by
[Software Factory Control Plane](./software-factory-control-plane.md) and
[Relay security hardening](./relay-security-hardening.md). Control V1 schemas
live in the focused `@opentag/control-protocol` package without changing
runtime identity or wire behavior; `@opentag/core` provides an identity-equal
compatibility re-export. `@opentag/delivery-contract` remains the
delivery-observation owner.

## Outcome

Build one open-source Control Plane that:

- runs as a Node application in one versioned OCI image;
- uses PostgreSQL as the only v1 durable database;
- runs the same image, schema, and migrations in Docker Compose and managed
  OpenTag Cloud;
- exposes canonical Control V1 through a small Hono HTTP application;
- serves an independently authored Vite/React console from the same origin;
- never receives local repository contents or local execution credentials;
- has one claim, retry, cancellation, and terminal-outcome owner per hosted
  Run;
- does not inherit source, UI structure, copy, or Git history from the
  prior private implementation;
- does not require Cloudflare, Redis, object storage, or a message broker.

The v1 technology decisions are intentionally explicit:

| Concern | Decision |
| --- | --- |
| HTTP runtime | Node.js |
| HTTP framework | Hono through `@hono/node-server` |
| Console | Vite + React + TanStack Router/Query |
| Durable database | PostgreSQL |
| Schema and query toolkit | Drizzle |
| PostgreSQL driver | `pg` (node-postgres) |
| Open-source deployment | Docker Compose |
| Managed deployment | The same OCI image with managed PostgreSQL |
| Cloudflare | Optional DNS/CDN/TLS/WAF edge only |

## Product surface

The Control Plane has four product surfaces:

1. **Control V1 transport** for OpenTag CLI and user-controlled runners.
2. **Provider ingress** for signed, tenant-bound external events.
3. **Console HTTP interface** for the authenticated operator UI.
4. **Operational interface** for liveness, readiness, migrations, jobs, and
   diagnostics.

The React console is a client of the Control Plane. It is not the protocol
source, coordination owner, or authorization authority.

Public marketing, blog, pricing, billing, newsletter, user file storage, and a
hosted coding runtime are outside this design.

## Architectural invariants

| Invariant | Required behavior |
| --- | --- |
| Protocol ownership | Control V1 lives in `@opentag/control-protocol`; `@opentag/core` provides an identity-equal compatibility re-export. |
| Execution custody | Source, credentials, context packets, worktrees, and coding-agent execution stay local. |
| Local independence | Local OpenTag remains useful when no Control Plane is configured or reachable. |
| Principal authority | Authentication and tenant scope come from trusted credentials, never provider display data. |
| Coordination authority | One hosted Run has one claim, retry, cancellation, and terminal writer. |
| Provider evidence | Provider receipts corroborate state; they do not independently complete a Run. |
| Deployment parity | Self-hosted and managed installations run the same application image and PostgreSQL schema. |
| Persistence authority | PostgreSQL is the only v1 durable source of truth. |
| Module locality | Each deep Module owns its PostgreSQL state and transactions; no universal Repository owns every table. |
| Optional infrastructure | Cache, object storage, Redis, and message brokers cannot be required for the minimum lifecycle. |
| Console independence | Removing static console assets does not disable Control V1 or provider ingress. |
| Edge neutrality | DNS, CDN, TLS, and WAF providers do not own product state or lifecycle transitions. |
| Provenance | Public history and artifacts contain no prior private implementation or product language. |

## System shape

```text
OpenTag CLI -----------+
Local runner ----------+
Provider webhook ------+--> Hono application --> Deep domain Modules
React console ---------+         |                       |
                                 |                       +--> PostgreSQL
                                 |
                                 +--> Auth / Mail / Rate-limit capabilities

Node bootstrap --> HTTP server / process lifecycle / pg.Pool
OCI image ------> Compose self-hosting or managed container platform
Optional edge --> DNS / CDN / TLS / WAF --> canonical HTTPS origin
```

There is one application and one state model. The managed service is a
deployment of the open-source Control Plane, not a Cloudflare-specific fork.

## Hono application Interface

The Hono application is a deep Module with a deliberately small external
Interface:

```ts
export type ControlPlaneApplication = {
  fetch(request: Request): Promise<Response>;
};

export type CreateControlPlaneApplication = (
  dependencies: ControlPlaneDependencies,
) => ControlPlaneApplication;
```

The implementation hides:

- route matching;
- strict body parsing and canonical schema validation;
- authentication and tenant authorization;
- rate-limit decisions;
- idempotency and replay protection;
- hosted admission and lifecycle coordination;
- error normalization and safe response rendering;
- audit production;
- console query composition.

Tests invoke the same Fetch Interface served by `@hono/node-server`. They do
not construct internal route handlers or database helpers directly except in
focused Module and PostgreSQL tests.

Web-standard `Request`, `Response`, `Headers`, and Web Crypto usage inside the
application keep the transport boundary small and testable. This is an
implementation property, not a commitment to ship a Worker runtime.

## HTTP interface groups

### Control V1

Control V1 retains the existing versioned paths and canonical request/response
schemas for:

- anonymous capability discovery;
- credentialed runner registration;
- credential lifecycle and control context;
- readiness and Project Target reporting;
- hosted admission and claim;
- heartbeat, running, progress, reject-start, cancellation, and completion;
- permissions and governed receipts;
- retained execution and delivery evidence.

Every request is parsed with the canonical schema before entering a domain
Module. Every response is parsed or constructed from the canonical response
schema before leaving the application.

Hono route inference may improve local authoring but cannot replace the public
schema package. `@opentag/client` must call Control V1 without importing the
Control Plane application.

### Provider ingress

Provider ingress remains separately addressable under the existing provider
path family. GitHub ingress preserves:

- raw-body signature verification before JSON trust;
- exact tenant binding, repository numeric ID, and actor numeric ID;
- stable login plus numeric actor identity where required;
- one globally addressable active binding with one-time secret material;
- replay and idempotency protection;
- explicit admission rather than direct execution;
- append-only PR-opened, merged, and closed evidence;
- no server custody of a local runner's source-read credential.

Provider ingress calls the same hosted-admission Module as other trusted
admission paths. It does not write hosted-run tables directly.

The current local foundation deliberately exposes binding creation only.
Audited secret rotation and disable/re-enable operations are not implemented,
so GitHub ingress is not ready for public production activation. Local tests
may enable it with disposable secrets to prove signature, reservation, replay,
and admission behavior; deployment operators must leave it disabled until the
recovery lifecycle is implemented and reviewed.

Required-check ingestion (`check_run` or `check_suite`) and reconciliation are
also not implemented in this foundation. The GitHub ingress Module must not be
described as producing required-check evidence until that bounded event seam,
replay model, and reconciliation evidence exist.

### Console HTTP interface

The console uses explicit same-origin JSON endpoints under a private console
path family. These endpoints are not Control V1 and may evolve more quickly.

Console operations include:

- current session and organization context;
- runner and readiness projections;
- Project Target and ingress-binding management;
- run, claim, evidence, and audit projections;
- API-key and security management;
- bounded administrative operations.

Console mutations call the same domain Modules as external routes. UI
visibility, disabled buttons, and client-side route guards are never
authorization controls.

The browser client uses explicit input and output schemas. It may use generated
helpers, but it does not export Hono-inferred types as a public package.

### Operational interface

The process exposes separate operational behavior:

- `/healthz`: process liveness only;
- `/readyz`: configuration, migration, and database readiness;
- one-shot migration command;
- continuously leased or one-shot durable job command;
- redacted diagnostics for configuration and dependency readiness.

Readiness fails closed when required secrets are missing, the public origin is
invalid, migrations are behind, PostgreSQL is unavailable, or the coordination
Module cannot preserve its transaction contract.

## Deep domain Modules

### Hosted run coordinator

This Module owns:

- hosted admission and idempotency;
- claim eligibility, leases, and fencing tokens;
- running, progress, heartbeat, reject-start, and cancellation transitions;
- executor lifecycle completion validation and terminal settlement;
- governed permission state linked to an attempt;
- append-only lifecycle and audit receipts;
- reconciliation state whose ownership belongs to OpenTag.

Its Interface accepts authenticated, tenant-scoped commands and returns typed
outcomes. It does not expose SQL transactions, Drizzle query builders, or raw
database rows.

The Module is the only writer of hosted lifecycle truth. Provider evidence,
console projections, and job processors call it; none can finalize a Run
independently.

`complete` in this Module means that the currently fenced executor Attempt
reported its terminal lifecycle result. It does not assert that the software
factory's configured completion gates are satisfied and it does not write a
`CompletionAssessment`. Factory completion remains a separate, evidence-backed
authority in `docs/software-factory-control-plane.md`.

### Runner directory

This Module owns:

- runner registration and stable runner identity;
- credential issuance, rotation, revocation, and bounded recovery;
- runner capabilities and readiness observations;
- Project Targets and tenant-scoped assignment;
- current control context;
- credential-safe diagnostics.

Plaintext runtime credentials are returned only at their creation boundary and
are never recoverable from PostgreSQL. Stored credentials use one-way hashes
or encrypted secret references according to the canonical credential contract.

### Provider ingress

Each provider ingress Module owns provider-specific verification and
normalization. It depends on:

- its own tenant-scoped bindings and replay records;
- the hosted coordinator's admission Interface;
- append-only provider evidence recording.

An ingress Module verifies and normalizes a provider event, derives a trusted
principal from the binding, and submits a bounded intent. A provider payload
cannot manufacture tenant or runner authority.

### Console read model

The console read Module owns bounded, tenant-scoped projections. It may join
normalized tables and derive presentation status, but it cannot become a
second write path into coordination state.

Read-model freshness and unavailable sections are explicit. A query failure
must not be rendered as an empty result.

### Durable jobs

Retention, reconciliation, delivery observation, credential cleanup, and
similar delayed work run as durable job Modules, not process-local timers
inside the HTTP server.

A durable job:

- persists intent before returning acceptance;
- uses PostgreSQL leases and fencing;
- is safe under duplicate delivery;
- records retry and terminal state;
- invokes a domain Module rather than editing domain tables directly;
- can run in a continuously polling `jobs` process or a one-shot command.

The v1 implementation does not require Redis, a broker, or a cloud scheduler.
PostgreSQL is the durable queue authority. A platform scheduler may invoke the
one-shot command, but it does not own job state.

## PostgreSQL ownership and locality

PostgreSQL is a concrete implementation choice, not an interchangeable
provider hidden behind one wide database Interface.

Each deep Module owns, beside its domain code:

- its Drizzle table declarations;
- its queries and row mapping;
- its transaction boundaries;
- its database constraints and indexes;
- its migration requirements;
- its PostgreSQL-backed tests.

The application bootstrap supplies a configured database capability when it
constructs a Module. The Module does not export that capability through its
public Interface.

```text
modules/
  hosted-runs/
    index.ts                 # exported domain Interface and factory
    service.ts               # lifecycle policy
    postgres.ts              # private queries and transactions
    schema.ts                # owned tables and indexes
    postgres.test.ts         # real PostgreSQL lifecycle tests
  runners/
    index.ts
    service.ts
    postgres.ts
    schema.ts
```

A small database bootstrap area may create the pool, aggregate schema metadata
for Drizzle Kit, and run checked-in migrations. It does not become a universal
Repository or owner of domain transitions.

When one invariant requires state and audit to commit together, one operation
inside the owning Module writes both in the same transaction. The application
must not start independent Module transactions and try to coordinate them
afterward.

### Drizzle and node-postgres

The implementation uses `drizzle-orm/node-postgres` with `pg`.

The Node bootstrap:

- creates one bounded `pg.Pool` per process;
- validates connection, TLS, timeout, and pool settings;
- injects the Drizzle database and pool lifecycle capability;
- stops new HTTP or job work before draining the pool;
- calls `pool.end()` during graceful shutdown.

Single-statement operations may use the pool through the Module's private
PostgreSQL implementation. Every multi-statement transaction must:

1. acquire one `PoolClient`;
2. execute `BEGIN` on that client;
3. execute every statement on the same client;
4. `COMMIT` on success or `ROLLBACK` on failure;
5. release the client in `finally`.

`pool.query` is forbidden inside a transaction body because PostgreSQL scopes
a transaction to one client.

Pool sizing is an operational invariant. The total maximum across HTTP and job
replicas must stay below the server's usable connection limit with headroom
for migrations, operators, and failover. Readiness reports exhaustion and
connection failure without exposing the database URL.

Expected PostgreSQL conflicts, unique violations, serialization failures, and
lock timeouts are normalized inside the owning Module. Neither `Pool`,
`PoolClient`, Drizzle query objects, table definitions, nor database row types
cross a domain Interface.

### Concurrency and fencing

Lifecycle correctness uses explicit PostgreSQL semantics rather than process
mutexes:

- unique indexes for idempotency and stable tenant-scoped identities;
- row locks or atomic compare-and-set updates for lifecycle transitions;
- monotonically increasing fence values for claim ownership;
- `FOR UPDATE SKIP LOCKED` or equivalent bounded claim behavior for workers;
- database timestamps or explicitly tested clock policy for lease comparison;
- one transaction for state transition plus corresponding audit receipt.

The exact statement shape is private to the owning Module, but its observable
outcomes are fixed by canonical protocol and lifecycle tests.

### Schema and migrations

There is one PostgreSQL schema model and one ordered migration corpus for
self-hosted and managed installations.

Drizzle Kit may generate migration candidates. Migrations are reviewed,
checked in, and applied by the versioned Control Plane image. Production does
not use an implicit schema push.

The HTTP process does not apply unbounded or destructive migrations during
ordinary startup. A dedicated migration command:

- acquires a PostgreSQL advisory migration lock;
- records migration identity and checksum;
- applies pending migrations in order;
- refuses unknown or edited applied migrations;
- leaves failures visible and keeps readiness closed;
- exits before the HTTP and job processes become ready.

Deployments use expand-and-contract changes when rolling compatibility is
required. A rollback plan distinguishes application rollback from schema
rollback; destructive down migrations are not assumed to be safe.

CI creates a fresh PostgreSQL database, applies every migration, checks schema
drift, and runs the lifecycle corpus. Upgrade tests start from the previous
supported schema, migrate forward, and run the same corpus.

### PostgreSQL lifecycle corpus

Real PostgreSQL tests must prove at least:

1. duplicate admission returns one durable identity;
2. concurrent claimers produce one winner;
3. a stale fence cannot heartbeat, progress, cancel, or complete;
4. cancellation racing with completion produces one terminal outcome;
5. late completion cannot reopen a terminal Run;
6. replayed provider delivery records evidence once;
7. a failed transaction leaves no half-written state or audit;
8. lease expiry and reclaim preserve attempt identity rules;
9. terminal reconciliation is idempotent;
10. durable jobs are claimed and settled once under competing workers;
11. tenant mismatch fails before data disclosure;
12. migration from every supported schema version preserves these behaviors.

Unit tests may isolate pure policy, but an in-memory fake, SQLite, or PGlite
does not replace this PostgreSQL corpus.

## Application capabilities

The application uses narrow capabilities for concerns that genuinely have
multiple implementations or require deterministic tests. The current local
implementation injects the clock and identifier/token generators. Mail and
application-level rate limiting are approved future capability shapes, not
active product claims:

```ts
type Clock = {
  now(): Date;
};

type IdGenerator = {
  next(kind: string): string;
};

type MailSender = {
  send(message: BoundedMail): Promise<MailOutcome>;
};

type RateLimiter = {
  consume(input: RateLimitInput): Promise<RateLimitOutcome>;
};
```

These Interfaces represent real seams. A local development mail sink and an
SMTP/API provider are real Mail Adapters. A deterministic clock is a real test
Adapter. PostgreSQL does not need a corresponding `DatabaseDriver` Interface
until a second database is an approved, implemented requirement.

The current console recovery route therefore fails closed without sending
mail, and capability discovery does not advertise outbound mail or external
rate limiting. Request body limits are present but are not described as rate
limiting. Enabling either optional capability requires its Adapter, bounded
configuration, negative tests, and truthful capability reporting.

The minimum installation may use a PostgreSQL-backed rate limiter. A managed
deployment may put additional rate limiting at its edge, but edge denial is
defense in depth and cannot replace application authorization or
tenant-scoped limits.

Cache is not part of the required correctness path. Expensive projections may
be cached later only behind an explicit read-model capability with invalidation
and stale-read semantics. An unavailable cache degrades performance, not
coordination correctness.

## Node runtime and process topology

### HTTP process

The Node bootstrap:

- validates server configuration once at startup;
- creates the bounded PostgreSQL pool and domain Modules;
- creates the Hono application;
- serves it through `@hono/node-server`;
- serves the Vite static build and SPA fallback;
- handles `SIGTERM` and `SIGINT` gracefully;
- exposes liveness and readiness for the container runtime.

The configured public base URL is authoritative. The application does not
derive security-sensitive origins from arbitrary forwarded headers unless the
operator has explicitly configured a trusted proxy boundary.

No Node `IncomingMessage` or `ServerResponse` object crosses into a domain
Module. Node HTTP details remain in the bootstrap Adapter.

### Migration process

The same image starts with a migration command. It connects with a migration
role, acquires the migration lock, applies checked-in SQL, records the result,
and exits. The normal HTTP and job roles do not need DDL privileges after
migration.

### Job process

The same image starts with a durable job command. It uses its own bounded pool,
claims due work through PostgreSQL, invokes domain Modules, and respects the
same graceful-shutdown deadline as the HTTP process.

The HTTP and job process may run in one container for a minimal development
profile, but the canonical production topology separates them so HTTP scaling
does not multiply schedulers or lease pollers accidentally.

### Capability reporting

Capability discovery reports provider-neutral product behavior, not deployment
internals. It must not expose PostgreSQL or a container host as coordination
semantics.

Examples include:

- scheduled retention active;
- outbound auth mail configured;
- external rate limiting active;
- provider ingress enabled;
- required-check reconciliation active (future capability; absent today).

An absent optional capability fails closed where required and does not change
the meaning of an accepted Control V1 transition.

## Managed OpenTag Cloud deployment

OpenTag Cloud runs the same immutable OCI image used by self-hosters. A managed
environment supplies:

- a container platform capable of health checks and graceful shutdown;
- managed PostgreSQL with backups, restore, and capacity monitoring;
- secrets through the platform's secret mechanism;
- a stable HTTPS origin;
- optional separate HTTP and job replicas;
- logs and metrics that do not become state authority.

The exact container and PostgreSQL providers are deployment decisions, not
application architecture. Provider-specific configuration stays under a
deployment directory or private operations repository. It cannot introduce a
second protocol, schema, migration path, or business-logic fork.

Managed acceptance compares the deployed image digest and migration set to the
open-source release. A managed-only feature must still be expressed through a
bounded product capability and must not change the meaning of a canonical
Control V1 transition.

### Optional Cloudflare edge

Cloudflare may proxy the managed or self-hosted HTTPS origin for DNS, CDN, TLS,
WAF, bot filtering, or coarse rate limiting. Another edge provider may do the
same.

The edge layer:

- forwards authenticated application traffic to the canonical origin;
- does not read or write Control Plane PostgreSQL state;
- does not issue runner credentials;
- does not admit, claim, retry, cancel, or complete Runs;
- does not verify provider events on behalf of the application unless the
  origin independently verifies the canonical raw request;
- preserves provider webhook bytes exactly for origin signature verification;
- does not cache Control V1, auth, console API, or provider-ingress responses;
  CDN caching is limited to immutable static assets;
- is not required for local development, tests, Compose, or managed product
  correctness.

The v1 application package therefore has no runtime dependency on
`cloudflare:workers`, D1, KV, R2, Wrangler, or Worker scheduled events.

## React console

The console is a static Vite application using:

- React;
- TanStack Router for client-side routes;
- TanStack Query for server state;
- React Hook Form and Zod for forms;
- an independently authored OpenTag component system.

The initial route set is deliberately small:

- login and account recovery;
- dashboard and readiness;
- runners and pairing;
- Project Targets and ingress bindings;
- Runs and evidence;
- audit;
- API keys;
- profile and security.

The first version uses polling and explicit refresh where appropriate. It does
not require WebSockets or a new event-stream protocol. Realtime transport may
be added only when measured product need justifies another seam.

Legal documents may ship as static content. A public marketing site, blog,
pricing surface, or documentation portal is separately scoped rather than a
reason to add SSR to the Control Plane.

## Authentication and authorization

The initial implementation is a focused PostgreSQL identity Module rather than
a general SaaS authentication framework. It owns only initial-owner
provisioning, scrypt password verification, hashed/revocable sessions, tenant
roles, and hashed scoped API keys. It remains behind the Control Plane's
authenticated-principal Interface and does not own hosted-run policy.

Identity and Control Plane state live in the installation's authoritative
PostgreSQL database and move through the same migration and backup lifecycle.
Auth tables remain auth-owned; domain Modules do not edit them directly.

The reference deployment uses one origin so session cookies remain
first-party. Production policy requires:

- secure, HTTP-only session cookies;
- explicit trusted-origin validation;
- exact configured-origin checks for cookie-authenticated mutations;
- tenant resolution before loading tenant data;
- server-side role and action checks for every console mutation;
- API-key and runner-token authentication separate from browser sessions;
- redacted logs and error responses;
- no authorization derived from provider display names or browser route state.

An authenticated principal is normalized before entering a domain Module:

```ts
type ControlPlanePrincipal =
  | { kind: 'console_user'; tenantId: string; userId: string; roles: string[] }
  | { kind: 'runner'; tenantId: string; runnerId: string; credentialId: string }
  | { kind: 'provider'; tenantId: string; bindingId: string; actorId: string };
```

The exact canonical type may differ, but payload metadata cannot manufacture
one of these principals.

## Docker Compose reference profile

The canonical Compose profile contains:

| Process | Responsibility |
| --- | --- |
| `postgres` | Durable Control Plane and auth data with a named volume. |
| `migrate` | One-shot schema migration using the Control Plane image. |
| `control-plane` | Hono HTTP application plus static console. |
| `jobs` | Optional durable job loop using the same image and database leases. |
| `proxy` | Optional HTTPS and public-origin profile. |

Startup ordering is based on readiness, not container creation order:

1. PostgreSQL accepts connections.
2. Migrations complete successfully.
3. The Control Plane starts and passes `/readyz`.
4. The optional jobs process starts and claims work through database leases.
5. The reverse proxy publishes the configured origin.

The minimum documented configuration includes:

- public base URL;
- PostgreSQL connection URL and pool limits;
- session and signing secrets;
- initial administrator bootstrap policy;
- mail configuration when email login or recovery is enabled;
- provider-ingress secrets only when that provider is enabled;
- retention and job settings.

No secret is accepted through a `VITE_` client variable. Diagnostics show
secret references and readiness, never secret values.

Self-hosting documentation covers:

- TLS and public webhook reachability;
- PostgreSQL backup and restore rehearsal;
- schema upgrade and application rollback compatibility;
- volume ownership;
- graceful shutdown;
- image digest pinning;
- pool sizing;
- runner re-pairing after credential rotation;
- single-host scope and the limits of Compose availability.

The OCI image is also usable with Kubernetes, Nomad, Railway, Fly.io, or other
container systems. Those are deployment configurations, not new Control Plane
implementations.

## Build and repository layout

The implemented layout is:

```text
apps/control-plane/
  src/
    application.ts
    index.ts
    node-server.ts
    runtime.ts
    database/
      migrations.ts
      postgres.ts
      schema.ts
    modules/
      hosted-runs/
      runners/
      github-ingress/
      identity/
      jobs/
      console-reads/
  web/
    main.tsx
    router.tsx
    api.ts
  package.json
  Dockerfile
  vite.config.ts

deploy/
  compose/
    compose.yaml
    .env.example

packages/
  control-protocol/
  delivery-contract/
  client/
```

The first implementation stays in one `apps/control-plane` package. Internal
Modules are extracted only after a second real consumer exists. Directory
count is not modularity; deep Interfaces, single ownership, and locality are.

`database/schema.ts` aggregates Module-owned schemas only for migration
tooling. It does not own domain tables or export a generic persistence API.

The production build emits one runnable Node server artifact, static web
assets, and one OCI image. The same image supports `serve`, `migrate`, and
`jobs` commands. Managed deployment must use this artifact rather than rebuild
from a provider-specific source entry.

## Error model

External Control V1 errors remain closed, typed, and versioned by the canonical
protocol. Console errors use a separate closed envelope suitable for UI
presentation.

Every error response has:

- a stable machine code;
- a safe human message;
- a request or audit correlation ID when disclosure is safe;
- retryability where meaningful;
- no stack, SQL, token, signature, database URL, or tenant data leakage.

An admission acknowledgement means the intent was durably accepted. It does
not mean a runner claimed it, execution started, a provider mutation occurred,
or a completion authority accepted the result.

## Observability and audit

Structured operational logs and durable audit are distinct:

- logs diagnose process and Adapter behavior and may be retained externally;
- audit records governed transitions in PostgreSQL and is part of the product
  data model;
- metrics aggregate behavior but do not become state authority;
- traces must not contain credentials, provider secrets, source contents, or
  unbounded context.

Every state-changing request records enough information to answer:

- which trusted principal acted;
- for which tenant and resource;
- which operation was attempted;
- which idempotency identity applied;
- which state transition occurred;
- which fence authorized it;
- which bounded evidence supports the result;
- what the next operator action is when blocked.

Database metrics include pool occupancy and wait time, transaction duration,
lock timeout, serialization retry, job lease age, migration version, and
backup/restore readiness. Metrics must not include credentials or tenant
payloads.

## Clean-room implementation and history

The previous private implementation branch is not the public implementation
base. This clean worktree starts from a public OpenTag commit that does not
contain that implementation in reachable history.

Implementation rules:

1. Start from official framework scaffolds or independently authored files.
2. Use this document, canonical schemas, and independently authored fixtures
   as requirements.
3. Treat the existing application as a private behavior oracle only.
4. Do not copy private source, structure, copy, styles, screenshots, assets,
   or distinctive component composition.
5. Verify provenance before moving any existing OpenTag-specific source.
6. Keep a change ledger identifying newly authored, verified-moved, generated,
   and third-party files.
7. Scan the final repository and packed artifacts for excluded names, copy,
   license markers, dormant routes, and dependencies.
8. Verify the public branch history, not only the final working tree.

This design documentation may move to the clean branch because it describes
OpenTag's independently chosen architecture and contains no private
implementation.

## Delivery sequence

| Stage | Current status |
| --- | --- |
| 0 — canonical behavior and protocol | Implemented and covered by protocol/Core/Client compatibility tests |
| 1 — headless Node/PostgreSQL application | Implemented; real-PostgreSQL and Compose lifecycle verified locally |
| 2 — identity and minimal console | Implemented with the focused identity Module and static console; verified locally |
| 3 — durable jobs and GitHub ingress | Partially implemented; recurring PostgreSQL jobs and local ingress safety tests pass, but binding rotation/disable and required-check evidence remain activation blockers |
| 4 — managed parity | Not performed; no managed deployment or multi-replica evidence exists |
| 5 — public cutover | Not performed; the implementation is under pull-request review and no merge, publish, deploy, or activation is implied |

### Stage 0: Freeze observable behavior — implemented locally

- Select canonical Control V1 and delivery-contract versions.
- Extract Control V1 from `@opentag/core` into
  `@opentag/control-protocol`; retain an identity-equal Core compatibility
  re-export so existing clients do not fork the contract.
- Preserve accepted request, response, and negative fixtures.
- Record compatibility identifiers that cannot be renamed silently.
- Define the PostgreSQL lifecycle corpus before implementing persistence.
- Define clean-room provenance and artifact scans.

Exit evidence: an independently authored test harness describes required
transport, authority, and lifecycle behavior without importing the old app;
Core, Client, and the new Control Plane consume the same schema identities and
fixture corpus.

### Stage 1: Build the headless Node/PostgreSQL application — implemented locally

- Create the Hono application and Node bootstrap.
- Implement principal normalization, strict parsing, and error envelopes.
- Implement hosted-runs and runner-directory Modules with private PostgreSQL
  state.
- Add checked-in migrations, liveness, readiness, and graceful shutdown.
- Bring up PostgreSQL and the headless application through Compose.

Exit evidence: CLI and runner complete the hosted lifecycle with no React
console present.

### Stage 2: Add identity and the minimal console — implemented locally

- Mount the focused PostgreSQL identity Module through Hono.
- Add tenant and action authorization.
- Build the Vite/React console from independently authored components.
- Serve the static build from the same origin.
- Cover login, runner pairing, Project Targets, Runs, evidence, audit, API
  keys, profile, and security.

Exit evidence: a new self-hosted installation completes admin bootstrap,
runner pairing, and one governed Run through the UI and CLI.

### Stage 3: Add durable jobs and provider ingress — local foundation only

- Implement PostgreSQL job leasing and one-shot job commands.
- Implement signed GitHub ingress creation, reservation, and replay safety.
- Add retention and reconciliation without process-local correctness.
- Prove restart, replay, fencing, and fail-closed provider behavior.

Current evidence: competing workers and duplicate ingress converge to one
authorized lifecycle and one terminal writer in local PostgreSQL tests. Stage
3 is not complete until audited GitHub binding rotation and disable/re-enable
operations are implemented, required-check evidence and reconciliation are
bounded, and those recovery paths are tested.

### Stage 4: Prove managed deployment parity — not performed

- Deploy the exact release OCI image to an isolated pre-production container
  environment.
- Use managed PostgreSQL with the same migrations and lifecycle tests.
- Exercise multiple HTTP and job replicas, shutdown, pool sizing, backup, and
  restore.
- Optionally place an edge proxy in front of the canonical origin without
  changing application behavior.
- Compare deployed image digest and schema version with the public release.

Exit evidence: Compose and managed pre-production pass the same hosted pilot
from the same image and PostgreSQL migration corpus.

### Stage 5: Cut over cleanly — not performed

- Run protocol, PostgreSQL, security, Compose, managed, and UI acceptance.
- Verify clean public provenance and packed artifacts.
- Replace `apps/control-plane` atomically on a clean public-history branch.
- Archive behavior evidence without merging private source or history.
- Keep the old private deployment disabled until a separately authorized data
  migration and production rollout.

No stage authorizes deployment, publication, DNS changes, provider mutation,
production database migration, or live runner claims by itself.

The existing local-only OpenTag path remains a standing regression gate.
Adding, removing, or upgrading the Control Plane cannot make local admission,
execution, or provider delivery require a hosted capability probe.

## Verification matrix

| Claim | Required evidence |
| --- | --- |
| One deployable product | Compose and managed pre-production run the same OCI image digest. |
| PostgreSQL authority | Real PostgreSQL lifecycle corpus covers races, rollback, jobs, and terminal settlement. |
| Schema semantics | Fresh checked-in migrations and Drizzle-generated DDL produce identical PostgreSQL catalog columns, defaults, constraints, references, checks, and indexes. |
| Migration parity | Self-hosted and managed environments apply the same checked-in migration set. |
| Compose self-hosting | Empty-volume install, migration, readiness, pairing, claim, restart, backup/restore smoke. |
| Managed scalability | Multiple HTTP/job replicas preserve fencing and stay within the pool budget. |
| Protocol compatibility | Existing OpenTag client and canonical fixtures pass without deployment-specific fields. |
| Local independence | Local admission and execution pass with no Control Plane URL or credentials configured. |
| Console independence | Headless lifecycle passes with static assets absent. |
| Authorization | Tenant mismatch, role mismatch, CSRF, runner token, API key, and provider-principal negatives. |
| Provider safety | Raw-body signature, replay, binding mismatch, disabled ingress, and evidence-only provider events. |
| Single terminal writer | Cancellation, late completion, reclaim, and provider-receipt races converge deterministically. |
| Pool safety | Bounded pools, client release, shutdown drain, and connection-budget checks pass. |
| Optional infrastructure | Minimum profile passes with cache, object storage, Redis, broker, and Cloudflare absent. |
| Clean provenance | Reachable-history scan, packed-artifact scan, license inventory, and independent UI review. |

## Deferred decisions

These decisions do not block the architecture:

- the exact managed container host and PostgreSQL provider;
- the exact migration command UX and migration generation workflow;
- whether the optional HTTPS profile uses Caddy or another proxy;
- whether a deliberately single-node SQLite development profile is worth
  maintaining later;
- whether console realtime updates ever justify SSE or WebSockets;
- whether the public marketing site becomes a separate repository or app;
- Kubernetes manifests and multi-region deployment;
- managed billing, usage metering, or subscription packaging;
- object storage for future export artifacts;
- the DNS, CDN, TLS, or WAF provider;
- a future Worker or D1 implementation, which requires its own ADR and
  measured need rather than an unused v1 Interface.

Each deferred decision must preserve the Hono application Interface, canonical
protocol, PostgreSQL authority, state ownership, deployment parity, and clean
provenance rules in this design.

## Review checklist

Before release or cutover, reviewers should be able to answer yes to:

- Do self-hosted and managed installations run the same OCI image and
  PostgreSQL migrations?
- Can the product run without Cloudflare?
- Can the React console be removed without affecting runner coordination?
- Does each mutable transition have one canonical owner?
- Does each domain Module own its PostgreSQL state and transaction boundary?
- Have we avoided a universal Repository or hypothetical database Adapter?
- Are Node process APIs localized to the bootstrap and deployment utilities?
- Does the minimum Compose profile avoid speculative infrastructure?
- Can the public implementation be built without the prior private code or
  its reachable history?
- Are local code, credentials, context, worktrees, and execution still outside
  Control Plane custody?
