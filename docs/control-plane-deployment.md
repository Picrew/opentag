# OpenTag Control Plane deployment runbook

This runbook covers the open-source, single-host Docker Compose profile. It is
also the operational baseline for any managed deployment: the managed service
must run the same OCI image, PostgreSQL schema, migration corpus, and process
commands. This document does not claim that a managed environment is deployed.

## Minimum topology

The reference profile has four application roles and one durable dependency:

| Service | Authority |
| --- | --- |
| `postgres` | All durable Control Plane, identity, audit, and job state |
| `migrate` | One-shot checked-in SQL migration runner |
| `bootstrap-admin` | Idempotent initial owner provisioning |
| `control-plane` | Hono API, operational endpoints, and static console |
| `jobs` | PostgreSQL-leased reconciliation and retention work |

No Cloudflare service, Redis instance, broker, object store, or external
scheduler is required. Compose is a single-host availability profile; it is
not a multi-node high-availability design.

## Secrets and configuration

Copy `deploy/compose/.env.example` to an ignored `.env` and replace all
placeholder values. Generate each secret independently. Never commit the
resulting file or pass secrets through a `VITE_` variable.

Required values:

- `POSTGRES_PASSWORD`: database password used only inside the installation;
- `OPENTAG_BOOTSTRAP_PAIRING_TOKEN`: initial runner-pairing authority;
- `OPENTAG_FENCING_TOKEN_SECRET`: independent, at least 32-character authority
  used to derive live fencing tokens. PostgreSQL stores only a
  fencing-token digest, never the live token. Outside `local` the server
  refuses to start when this value equals the bootstrap, recovery, or GitHub
  ingress authority;
- `OPENTAG_LOGIN_THROTTLE_SECRET`: a different, independently generated
  at-least-32-character HMAC authority. Durable throttle rows contain only
  pseudonymous keyed identifiers and are bounded by expiry cleanup;
- `OPENTAG_BOOTSTRAP_ADMIN_EMAIL`, `...NAME`, and `...PASSWORD`: initial owner;
- `OPENTAG_PUBLIC_URL`: the exact browser and webhook origin.

Recommended values:

- `OPENTAG_RECOVERY_PAIRING_TOKEN`: separate emergency authority used only to
  reprovision a paired runner credential;
- `OPENTAG_GITHUB_INGRESS_MASTER_SECRET`: at least 32 characters, and only when
  GitHub ingress is intentionally enabled for local testing;
- `OPENTAG_RELEASE_SHA`: the immutable 40-character Git commit for staging or
  production. `local` is accepted only in the local environment.

Login throttling is durable and applies independently to normalized email and
optionally to the direct network peer observed by the Node server:

- `OPENTAG_LOGIN_NETWORK_THROTTLE_MODE`: `direct-peer` by default. Set
  `trusted-edge` only when a verified external edge enforces a client-aware
  login rate limit; that mode disables the application network bucket while
  retaining the email bucket;

- `OPENTAG_LOGIN_MAX_FAILURES`: failures allowed per normalized email in the
  accounting window, default `5`;
- `OPENTAG_LOGIN_NETWORK_MAX_FAILURES`: failures allowed per direct network
  peer across all emails, default `50`. The higher default keeps one shared
  egress address (office NAT, VPN) from becoming a collective lockout after a
  few unrelated typos while still bounding single-source password spraying;
- `OPENTAG_LOGIN_WINDOW_MS`: accounting window, default `300000`;
- `OPENTAG_LOGIN_LOCKOUT_MS`: lockout after the limit is reached, default
  `900000`.

Do not trust arbitrary forwarded-address headers as a login principal. The
application ignores them in both modes. A reverse proxy must either preserve
meaningful direct peer addresses or use `trusted-edge` with independently
verified client-aware rate limiting; leaving `direct-peer` enabled behind a
single shared proxy can turn that proxy into a site-wide lockout bucket.

Runtime and API-key tokens are one-time material. Store them in the runner or
operator secret store when issued. A live hosted-claim fencing token is derived
from the deployment secret and the immutable claim tuple. The database retains
only credential hashes and the fencing-token digest, so replay can reconstruct
the same response without making the token recoverable from a database dump.

## TLS and public ingress

Do not expose the plain HTTP Compose port directly to the Internet. Terminate
TLS in a reverse proxy or load balancer and set `OPENTAG_PUBLIC_URL` to that
exact HTTPS origin. Forward the original `Host` and scheme consistently.

GitHub ingress is absent unless its master secret is configured and a binding
has been created. The current open-source foundation does not yet implement
audited binding-secret rotation or disable/re-enable recovery. Keep the master
secret empty and do not register a production provider webhook until that
lifecycle exists and has incident-recovery evidence. Local disposable tests
may enable it to verify signature, delivery reservation, replay, and admission.
Accepted webhook delivery means the intent was durably admitted; it does not
mean execution began or a provider mutation completed.

Cloudflare DNS/CDN/WAF may proxy the origin, but it is optional. Do not cache
Control V1, console API, authentication, or provider-ingress responses.

## Installation and upgrade

Pin a reviewed image digest in production. For the local source profile:

```bash
docker compose --env-file .env build
docker image inspect opentag-control-plane:local --format '{{.Id}}'
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Startup is ordered by health and completion: PostgreSQL, migration, bootstrap,
HTTP readiness, then jobs. Migrations take a PostgreSQL advisory lock, verify
the checksum of every already-applied file, and only append new migrations.
Never edit a migration after it has been released.

For an upgrade:

1. Back up PostgreSQL and verify the backup artifact is readable.
2. Pull or build the exact reviewed image digest.
3. Run the `migrate` role and wait for successful completion.
4. Restart HTTP and jobs on the same image digest.
5. Verify `/readyz`, capability discovery, console login, runner readiness,
   and a non-destructive hosted lifecycle smoke.
6. Retain the prior image until rollback compatibility is understood.

A database migration may make application rollback unsafe. Rollback is an
explicit release decision, not an automatic response to a failed healthcheck.

## PostgreSQL sizing and connections

`OPENTAG_DB_POOL_MAX` is per process. The total possible connections are:

```text
(HTTP replica count + jobs replica count) * OPENTAG_DB_POOL_MAX
+ migration/bootstrap headroom
+ operator and monitoring headroom
```

Keep that total below the server or provider connection limit. Start with the
default of 10 only when the installation can afford it; small installations
can use a lower value. Monitor pool wait time, long transactions, locks, job
lease age, database storage, and backup age.

The HTTP process stops accepting new requests on `SIGTERM`/`SIGINT`, drains
the server, and closes the pool. The jobs process aborts its poll loop, releases
resources, and closes the pool. Give both roles a termination grace period
longer than normal request/transaction duration.

## Backup and restore rehearsal

Back up with normal PostgreSQL tooling. A custom-format example:

```bash
docker compose --env-file .env exec -T postgres \
  pg_dump -U opentag -d opentag --format=custom > opentag-control-plane.dump
```

Restore into a new database or disposable installation, not over the only
copy:

```bash
createdb opentag_restore
pg_restore --exit-on-error --no-owner --dbname=opentag_restore \
  opentag-control-plane.dump
```

After restore, point the same application image at the restored database and
verify migrations, `/readyz`, tenant counts, runner registrations, hosted run
terminal states, permission receipts, material-action receipts, jobs, and
audit records. A backup without a successful restore rehearsal is not recovery
evidence.

## Credential recovery and re-pairing

If runtime credential material is lost, call the credential-reprovision route
with the separately stored recovery token. Successful reprovisioning increments
the credential generation, revokes the prior credential, and returns new
material once. Confirm that the old credential receives `401` before relying
on the recovery result.

If the recovery token is unavailable or compromised, rotate installation
secrets under an incident plan and re-pair affected runners. Do not attempt to
recover plaintext credential material from PostgreSQL; it is intentionally not
stored.

## Verification and truthful limits

Before production use, require:

- exact image digest and source revision;
- clean empty-volume installation;
- upgrade from the previous migration corpus;
- backup and restore rehearsal;
- runner pair/re-pair and credential revocation;
- concurrent claim/fencing and cancellation race tests;
- permission and material-receipt tests;
- provider signature, replay, and tenant-mismatch negatives;
- audited provider-binding secret rotation and disable/re-enable recovery;
- graceful shutdown and connection-budget checks.

The repository proves the local Compose profile only after those checks are
run against the exact image. A managed deployment, multi-replica behavior,
DNS, TLS, provider registration, or production activation requires separate
environment evidence and authorization.
