# OpenTag Control Plane

The Control Plane is OpenTag's optional shared coordination service. It owns
tenant identity, runner pairing, Project Targets, public ingress, hosted run
leases, governed permissions, evidence receipts, durable jobs, and retained
audit projections. Repositories, source-control credentials, coding-agent
credentials, worktrees, context packets, and coding-agent execution remain on
user-controlled runners.

The service is an independently authored Node application:

- Hono exposes a Web-standard `Request`/`Response` application interface;
- `@hono/node-server` is the production Node adapter;
- PostgreSQL is the only durable database in v1;
- Drizzle declares module-owned schemas while checked-in SQL is the reviewed
  migration authority;
- `pg` provides the bounded connection pool and transaction clients;
- the operator console is a static Vite/React application using TanStack
  Router, TanStack Query, and React Hook Form;
- one OCI image runs migrations, administrator bootstrap, HTTP, and durable
  jobs.

TanStack Start, Cloudflare Workers, D1, KV, R2, Redis, a message broker, and an
object store are not runtime dependencies. Cloudflare may be placed in front
of the canonical HTTPS origin as an optional edge provider.

GitHub ingress is a default-disabled local foundation. Signature, durable
delivery reservation, replay, and hosted admission are covered, but audited
binding-secret rotation and disable/re-enable recovery are not implemented.
Do not activate a production GitHub webhook until that lifecycle is added and
reviewed.

## Run with Docker Compose

The supported open-source profile is in
[`deploy/compose`](../../deploy/compose/README.md). From that directory:

```bash
cp .env.example .env
# Replace every placeholder secret in .env.
docker compose --env-file .env up --build
```

The profile starts PostgreSQL, applies all migrations, provisions the initial
owner idempotently, serves the API and console, and starts the durable job
loop. Open `OPENTAG_PUBLIC_URL` after the `control-plane` service is healthy.

## Local development

Requires Node.js 22.14 or newer, pnpm, and PostgreSQL 17 or another currently
supported PostgreSQL release.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @opentag/control-protocol build
corepack pnpm --dir apps/control-plane build
```

Set the variables documented in
[`deploy/compose/.env.example`](../../deploy/compose/.env.example), use a
locally reachable `DATABASE_URL`, and run the process roles explicitly:

```bash
node apps/control-plane/dist/index.js migrate
node apps/control-plane/dist/index.js bootstrap-admin
node apps/control-plane/dist/index.js serve
node apps/control-plane/dist/index.js jobs
```

`jobs --once` claims at most one due job and is useful for bounded operational
execution. `/healthz` reports process liveness. `/readyz` fails closed when
PostgreSQL is unavailable or the checked-in migration corpus is not current.

## Test

Unit tests that do not need PostgreSQL run normally. The integration corpus is
enabled with `OPENTAG_TEST_DATABASE_URL` and creates isolated schemas inside
the supplied disposable database:

```bash
OPENTAG_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/opentag_test \
  corepack pnpm --dir apps/control-plane exec vitest run
```

The real-PostgreSQL suite covers migrations, runner credentials and recovery,
concurrent hosted claims, fencing, cancellation versus late completion,
permissions, material evidence, durable jobs, GitHub ingress replay, console
authorization, and tenant-scoped projections.

The browser E2E builds the production OCI image, creates a disposable Compose
project and PostgreSQL volume, and drives Chromium through the public console.
Install Chromium once, then run the root command:

```bash
corepack pnpm --dir apps/control-plane e2e:install
corepack pnpm e2e:control-plane
```

The journeys cover anonymous-route protection, owner login/session/logout,
one-time API-key material and revocation, real runner pairing through
`@opentag/client`, Project Target and GitHub binding creation, same-origin
mutation enforcement, reload persistence, and browser diagnostics. The same
run then exercises signed GitHub admission, claim, permission, material
evidence, cancellation, credential reprovisioning, and recurring job
settlement through the public Control V1 client before exact PostgreSQL row
verification. Finally, it restarts the HTTP and jobs services, waits for HTTP
readiness, proves the restarted jobs process can settle new work, restores a
fresh database from a byte-preserving PostgreSQL dump, and verifies the
restored migration ledger, durable records, and a non-ASCII data canary.
The runner creates random local-only secrets and removes its
containers, network, secret file, and volume in `finally`.

## Authority boundaries

- `@opentag/control-protocol` is the Control V1 schema and digest authority.
  The application does not maintain private wire-schema copies.
- The hosted coordinator is the only owner of claim, retry, cancellation, and
  terminal run state.
- Permission and material-action modules append governed receipts; provider
  evidence corroborates a result but cannot settle a run.
- Browser sessions, runner credentials, API keys, and provider principals are
  separate authorities. Payload metadata cannot manufacture a principal.
- Runtime credentials and API-key material are returned once and stored only
  as hashes. The optional recovery secret can reprovision a runner credential
  without making old material valid again.
- Durable login throttling stores only environment-keyed HMAC identifiers,
  purges expired rows opportunistically, and never treats forwarded address
  headers as a client principal. Deployments behind one shared proxy peer must
  use the explicit trusted-edge mode with verified edge rate limiting.
- A hosted claim derives its live fencing token from a deployment secret and
  immutable claim identity. The Control Plane stores only its digest and never
  persists the live fencing token in claims, permission requests, audit, or
  console projections.
- Local OpenTag continues to work without a Control Plane URL or credential.

See [the runtime architecture](../../docs/control-plane-runtime-architecture.md),
[ADR 0003](../../docs/adr/0003-node-postgresql-control-plane.md), and the
[deployment runbook](../../docs/control-plane-deployment.md).
