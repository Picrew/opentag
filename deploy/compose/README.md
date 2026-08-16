# OpenTag Control Plane with Docker Compose

This is the reference single-host installation. It runs PostgreSQL and four
roles from one `opentag-control-plane:local` image: migrations, administrator
bootstrap, the HTTP application/static console, and durable jobs.

1. Copy `.env.example` to `.env` and replace every placeholder secret. Use an
   independently generated fencing-token and login-throttle secrets rather
   than reusing the pairing, recovery, administrator, or database secret. Keep
   the file out of version control.
2. Run `docker compose --env-file .env up --build` from this directory.
3. Wait for `control-plane` to become healthy, then open the configured
   `OPENTAG_PUBLIC_URL`.
4. Sign in with the bootstrapped owner and pair a local OpenTag runner with
   `OPENTAG_BOOTSTRAP_PAIRING_TOKEN`.

Useful checks:

```bash
docker compose --env-file .env ps
curl --fail "${OPENTAG_PUBLIC_URL:-http://127.0.0.1:3000}/healthz"
curl --fail "${OPENTAG_PUBLIC_URL:-http://127.0.0.1:3000}/readyz"
docker compose --env-file .env logs --no-log-prefix migrate bootstrap-admin
```

From the repository root, the bounded end-to-end smoke validates the public
Control V1 client, signed GitHub ingress, permission and material receipts,
canonical cancellation, credential reprovisioning, and console projections
against the running Compose stack:

```bash
corepack pnpm smoke:control-plane-compose:typecheck
corepack pnpm --filter @opentag/cli exec tsx \
  --env-file="$PWD/deploy/compose/.env" \
  ../../scripts/test/control-plane-compose-smoke.ts
```

The smoke creates uniquely named test records in the configured database. It
prints only identifiers and bounded outcomes, never the issued credentials or
webhook secret.

For the real browser journey, install Chromium once and run the isolated E2E
from the repository root:

```bash
corepack pnpm --dir apps/control-plane e2e:install
corepack pnpm e2e:control-plane
```

Unlike the protocol smoke above, this command owns a new disposable Compose
project. It builds the production image, applies migrations, bootstraps the
owner, drives Chromium through the public console, verifies the exact durable
records with `psql`, and always removes the test volume and generated secret
file. See the checked-in journey catalog at
`apps/control-plane/e2e/TEST-CATALOG.md`.

The default profile is intentionally PostgreSQL-only. It does not require
Cloudflare, Redis, object storage, a broker, or a platform scheduler. Put a TLS
reverse proxy in front before exposing the service or GitHub webhook publicly.

Back up the database with normal PostgreSQL tooling rather than copying a live
volume. Test restore, runner credential reprovisioning, and old-credential
revocation before relying on this profile for production. Compose is a
single-host availability profile; it is not a substitute for a multi-node
PostgreSQL and container-orchestrator design.

The application uses the same checked-in migrations and image commands in
self-hosted and future managed installations. This profile does not claim a
managed environment exists. See the full
[deployment runbook](../../docs/control-plane-deployment.md) for TLS, image
pinning, pool sizing, upgrade, backup/restore, graceful shutdown, and recovery.

The default `OPENTAG_LOGIN_NETWORK_THROTTLE_MODE=direct-peer` is appropriate
when the Node service observes distinct client peers. If a reverse proxy makes
all requests share one socket peer, configure `trusted-edge` and enforce a
verified client-aware login limit at that edge. The application deliberately
ignores forwarded address headers; its normalized-email bucket remains active.
