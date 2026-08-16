# ADR 0003: Rebuild the Control Plane on Node and PostgreSQL

- Status: Accepted
- Date: 2026-08-15
- Decision owners: OpenTag maintainers

## Context

OpenTag needs an optional shared Control Plane for identity, runner pairing,
public ingress, tenant-scoped coordination, and retained audit projections.
Repository contents, source-control credentials, coding-agent credentials,
context packets, worktrees, and coding-agent execution remain on
user-controlled runners.

A previous private reference implementation combined a full-stack web runtime,
provider-specific storage, scheduled events, and inherited SaaS application
scaffolding. That reference is not present in this clean worktree and must not
become the public architectural base:

- deleted proprietary source would remain in reachable Git history;
- framework conventions still shape server routing, auth, and deployment;
- Cloudflare bindings remain ambient dependencies instead of explicit
  operational choices;
- the primary callers are OpenTag CLI, runners, provider webhooks, and
  operators, not an SSR page tree;
- Control V1 cannot use UI-private Server Functions as its canonical
  Interface.

OpenTag also needs a credible self-hosted deployment. A design that requires a
Cloudflare account, D1, KV, Wrangler, or Worker-specific configuration would
make the code visible without making the service operationally portable.

The initial proposal attempted to support Node/PostgreSQL for self-hosting and
Workers/D1 for OpenTag Cloud. That creates two application bootstraps, two
database implementations, two migration systems, and a continuing behavioral
conformance burden before there is evidence that the second stack is needed.
That is the wrong default for an early open-source Control Plane.

## Decision

### Use one Node HTTP runtime

The Control Plane uses Hono as its HTTP application implementation and
`@hono/node-server` as the production HTTP Adapter. The application exposes a
standard Fetch Interface internally:

```ts
type ControlPlaneApplication = {
  fetch(request: Request): Promise<Response>;
};
```

Routing, authentication, tenant authorization, validation, admission,
coordination, and error normalization sit behind that Interface. Transport
tests exercise the same seam that the Node bootstrap serves.

Hono is transport infrastructure, not a protocol owner. Control V1 schemas
live in the focused `@opentag/control-protocol` package. `@opentag/core`
preserves an identity-equal compatibility re-export, while the application and
new clients import the focused package directly. Hono-inferred types, database
row types, and console types are not external contracts.

The application may continue to use Web-standard `Request` and `Response`
objects. This keeps transport code testable and avoids unnecessary Node HTTP
coupling inside domain Modules, but it is not a promise to maintain a second
Worker runtime in v1.

### Use a static React console

The authenticated operator console is a Vite-built React single-page
application using TanStack Router and TanStack Query. The console and HTTP
application deploy on one origin by default.

This is a minimal installation-operations console, not the broad hosted SaaS
control plane excluded by `docs/design.md`. It exposes only the authority and
read models already required to operate the optional service. It does not add
planning, source custody, hosted execution, billing, marketing, or general
workspace features, and it does not imply that a managed service is deployed.

TanStack Start will not be part of the new runtime. The Control Plane does not
currently justify SSR, streaming, hydration, route loaders with server
execution, or UI-private Server Functions. Public marketing, documentation,
and content publishing are not Control Plane responsibilities.

### Own a narrow identity implementation

The first open-source release uses a small PostgreSQL-backed identity Module
instead of importing a general SaaS authentication framework. It supports the
needed surface only: idempotent initial-owner provisioning, scrypt password
verification, hashed and revocable first-party sessions, tenant roles, and
hashed scoped API keys.

Cookie-authenticated mutations require the exact configured origin and use an
HTTP-only, `SameSite=Strict` cookie that is secure on HTTPS origins. Runner
credentials, recovery authority, provider principals, API keys, and browser
sessions remain separate authentication mechanisms.

This is not a promise to grow a general identity product. Replacing the
implementation later is possible behind the normalized principal boundary,
but the replacement must preserve tenant scoping, origin checks, one-time
credential material, and closed errors.

### Use PostgreSQL for self-hosted and managed installations

PostgreSQL is the only v1 durable database. The open-source Docker Compose
profile and managed OpenTag Cloud both run the same schema, migration corpus,
and PostgreSQL-backed domain implementation.

Drizzle is the schema, migration-generation, and typed-query toolkit.
`drizzle-orm/node-postgres` runs on `pg` (node-postgres). `pg` is selected
because it is the widely adopted Node.js PostgreSQL driver, has a mature pool
and transaction model, and is directly supported by Drizzle.

The Node bootstrap owns one bounded `pg.Pool` per process. Transactional
operations check out one client, execute every statement on that client, and
release it in `finally`; transaction bodies must not call `pool.query`. During
graceful shutdown the HTTP server stops admitting new work, durable workers
stop claiming work, and the pool drains through `pool.end()`.

PostgreSQL constraints, locking, and transactions must preserve:

- tenant-scoped uniqueness;
- idempotent admission and replay handling;
- one active claim lease per attempt;
- compare-and-set lifecycle fencing;
- cancellation versus late-completion determinism;
- exactly one terminal settlement and audit receipt;
- durable job claim, retry, and settlement.

### Keep persistence local to the domain owner

The redesign will not introduce a universal database Interface, a generic
Repository, or a public swappable database driver merely to anticipate
SQLite, D1, or another future database.

Each deep domain Module owns its PostgreSQL tables, queries, transactions, and
invariants privately. Its external Interface exposes domain commands, typed
outcomes, and closed errors. Drizzle queries, table definitions, database
rows, `Pool`, and `PoolClient` do not cross that Interface.

The important ownership boundaries are:

- hosted admission, claim leases, lifecycle fencing, cancellation, and
  terminal settlement share one coordination owner;
- runner registration, credentials, readiness, and Project Targets share one
  runner-directory owner;
- ingress bindings, replay protection, and provider evidence share one
  provider-ingress owner;
- console reads are projections and cannot mutate coordination truth;
- provider receipts corroborate outcomes but cannot become competing terminal
  writers.

Tests call these Module Interfaces against a real temporary PostgreSQL
database. Test doubles remain appropriate for clocks, identifiers, mail,
signatures, and other real replaceable capabilities; PostgreSQL is not hidden
behind a hypothetical cross-database abstraction in v1.

### Ship one OCI artifact

Docker Compose is the canonical open-source deployment. The same OCI image is
also the canonical managed OpenTag Cloud artifact.

The reference profile contains:

- PostgreSQL with a named volume;
- the Control Plane image in a one-shot migration role;
- the same image as the HTTP application and static console;
- the same image in an optional durable job-processing role;
- an optional reverse proxy for HTTPS termination.

The minimum profile does not require Redis, object storage, a message broker,
or a Cloudflare account. The managed service may use any conforming container
host and managed PostgreSQL provider, but it must not fork the application,
schema, migrations, or protocol behavior.

### Keep Cloudflare optional and outside application authority

Cloudflare may be used in front of the canonical HTTPS origin for DNS, CDN,
TLS, WAF, or bounded rate limiting. It is not a required v1 application
runtime or persistence provider.

No Control Plane correctness may depend on Workers, D1, KV, R2, Wrangler,
scheduled events, `ExecutionContext`, or a Cloudflare-specific request
context. Edge configuration cannot own authentication, tenant authorization,
admission, claims, retries, cancellation, or terminal outcomes.

A future Worker or D1 runtime would require a separate ADR, a measured product
or operational need, a real second implementation, and its own lifecycle and
migration acceptance. This ADR deliberately does not create that seam in
advance.

### Rebuild from clean provenance

The public implementation is independently authored on top of a public OpenTag
history that does not contain the prior private implementation. That
implementation may be used only as a black-box behavior oracle. Its source,
copy, assets, layout, component structure, and history are not copied.

OpenTag-specific code may be moved only when its provenance is verified.
Otherwise its behavior must be reimplemented from canonical protocols,
fixtures, and independently authored acceptance tests.

## Alternatives considered

### Keep TanStack Start

TanStack Start can provide SSR, server functions, and multiple hosting
targets.

Rejected because the Control Plane is primarily an external HTTP coordination
service with an authenticated console. Its stable endpoints still require
explicit server routes, while SSR and Server Functions create another server
invocation model without reducing the difficult authority and persistence
work.

### Use Hono with server-rendered JSX or HTMX

This would reduce client build complexity.

Rejected for the primary console because readiness, run timelines, pairing,
permissions, audit views, and incremental status updates benefit from a stable
client-side state model. Tiny operational pages may use server-rendered HTML
only if that does not create a second UI architecture.

### Deploy the frontend and API on separate origins

Rejected as the reference profile because CORS, cookie, CSRF, and public URL
configuration make self-hosting harder. The static build remains separable,
but the canonical image serves it from the Control Plane origin.

### Use Workers and D1 for the managed service

This would preserve the existing hosting shape and could reduce some managed
infrastructure work.

Rejected for v1 because it creates a second runtime, database implementation,
migration corpus, transaction model, and acceptance matrix. It also makes
self-hosted and managed behavior diverge at the deepest stateful boundary.
Cloudflare remains an optional edge provider.

### Use SQLite as the canonical database

SQLite would produce a smaller installation and an excellent single-node
demonstration.

Rejected as the production reference because hosted claim competition,
leases, fencing, cancellation races, durable jobs, and terminal settlement
are core rather than incidental behaviors. Starting with SQLite would either
constrain the product to one writer and one replica or create an early
SQLite-to-PostgreSQL migration. A deliberately single-node development
profile may be evaluated later without changing the v1 authority model.

### Support PostgreSQL for self-hosting and D1 for managed hosting

Rejected because sharing Drizzle does not make the two databases behaviorally
equivalent. This option still requires two schemas, two migration systems, two
transaction implementations, and permanent concurrency conformance work.

### Use raw node-postgres without Drizzle

Rejected because Drizzle provides useful typed schema/query authoring and
checked-in migration generation while retaining visible SQL. Raw `pg` may be
used inside an owning Module for a narrowly justified operation, but it must
not bypass that Module's transaction and audit invariants.

### Use postgres.js under Drizzle

This is a supported Drizzle configuration. Rejected for the reference profile
because `pg` has broader ecosystem adoption and established pool operations.
Changing the internal PostgreSQL driver later would not change Control V1 or a
domain Module Interface.

## Consequences

Positive consequences:

- self-hosted and managed deployments use one runtime artifact;
- PostgreSQL is the single durable source of truth in v1;
- one schema and migration corpus serves every installation;
- external APIs remain explicit and independent of the console framework;
- the React console can change without changing Control V1;
- Cloudflare becomes an optional operational choice;
- the public implementation has a clean provenance path;
- the project avoids premature cross-database and cross-runtime abstractions.

Costs and trade-offs:

- every installation needs PostgreSQL;
- the managed service needs a container host and managed PostgreSQL service;
- operators must size and monitor connection pools and database capacity;
- the console needs an explicit client instead of Server Functions;
- self-hosters must configure a public URL, TLS, backups, and mail;
- adding a non-Node runtime or non-PostgreSQL database later will require an
  explicit architectural decision and real compatibility evidence;
- the clean rebuild delays feature work while protocol and behavior parity are
  established.

## Release evidence requirements

Accepting this architectural decision does not activate a deployment. A
release or production claim requires the applicable evidence below:

1. One versioned OCI image boots in Docker Compose and in a managed
   pre-production container environment.
2. Docker Compose starts from an empty volume, applies migrations, becomes
   ready, and completes the hosted pairing and claim lifecycle.
3. Real PostgreSQL tests cover duplicate admission, concurrent claims,
   fencing, cancellation races, late completion, rollback, durable jobs, and
   terminal single-writer behavior.
4. PostgreSQL transaction tests prove one checked-out client per transaction,
   release on success and failure, a bounded pool, and graceful pool drain.
5. The existing OpenTag client negotiates capabilities, pairs, registers,
   claims, reports progress, and completes without deployment-specific fields.
6. GitHub webhook verification consumes the raw body and is tenant- and
   repository-bound independently of the React console.
7. Deleting static console assets leaves Control V1 and provider ingress
   operational.
8. The new application package has no runtime dependency on
   `cloudflare:workers`, D1, KV, R2, or Wrangler.
9. Node HTTP and process imports are localized to the Node bootstrap and
   deployment utilities.
10. The minimum Compose profile works without cache, object storage, Redis, or
    a message broker.
11. Self-hosted and managed profiles use the same PostgreSQL migrations and
    application image digest.
12. The public Git history and release artifact contain no prior private
    implementation source, assets, or copied product language.

The local clean rebuild currently proves the Node/PostgreSQL application,
canonical protocol seam, real-PostgreSQL lifecycle corpus, and Docker Compose
profile. A managed pre-production deployment, multi-replica verification,
publication, and production activation remain separately authorized work and
must not be inferred from local evidence.

The detailed design and current implementation status are recorded in
[Node/PostgreSQL Control Plane architecture](../control-plane-runtime-architecture.md).

## References

- [Hono Node.js adapter](https://hono.dev/docs/getting-started/nodejs)
- [Hono Web Standards](https://hono.dev/docs/concepts/web-standard)
- [Vite production build](https://vite.dev/guide/build)
- [Drizzle PostgreSQL driver](https://orm.drizzle.team/docs/get-started-postgresql)
- [node-postgres pooling](https://node-postgres.com/features/pooling)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
- [PostgreSQL backup and restore](https://www.postgresql.org/docs/current/backup.html)
