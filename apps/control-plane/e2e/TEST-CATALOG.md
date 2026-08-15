# Control Plane browser E2E catalog

These journeys run against the built OCI image and a disposable PostgreSQL 17
volume. The runner creates unique credentials, starts the complete Compose
profile, drives Chromium against the public HTTP origin, verifies persisted
database rows, and destroys the containers, network, secret file, and volume.

## CP-E2E-001 — protected console and owner session

- An anonymous visit to `/` redirects to `/login`.
- Invalid credentials fail without creating a session.
- The bootstrapped owner can sign in and load live overview metrics.
- A reload preserves the server-side session.
- Sign-out revokes browser access to protected routes.

## CP-E2E-002 — API-key one-time material

- The owner creates an API key through the browser form.
- The one-time token is shown immediately and never after reload.
- The durable key projection remains visible after reload.
- The owner revokes the key and the durable state changes to `revoked`.

## CP-E2E-003 — runner, target, and ingress binding

- A real `@opentag/client` call pairs a runner with the bootstrap credential.
- The paired runner appears in the authenticated browser console.
- The owner declares a Project Target through the real form.
- The owner creates an enabled GitHub ingress binding.
- The binding secret is shown once; the binding persists after reload.
- A cross-origin mutation is rejected before session authorization.

## CP-E2E-004 — governed Control V1 lifecycle and recurring jobs

- A second real `@opentag/client` pairs and reports bounded readiness.
- A locally signed GitHub issue-comment delivery admits exactly one hosted run;
  replay resolves to the same run.
- The runner claims the run, requests governed permission, records material
  evidence, reconciles it, and cancels through the canonical lifecycle route.
- Credential reprovisioning revokes the old runtime token and advances the
  credential generation.
- The production `jobs` role persists and settles both recurring maintenance
  job kinds.
- PostgreSQL is queried directly for the durable browser and job outcomes.

## CP-E2E-005 — restart and backup/restore recovery

- The production HTTP and jobs services restart against the existing volume.
- HTTP returns to ready state and the restarted jobs process settles a newly
  persisted maintenance intent.
- PostgreSQL produces a logical backup without exposing it outside the
  disposable test process.
- The backup restores into a fresh database in the isolated Compose project.
- The restored database contains all four migrations, the exact runner,
  Project Target, and GitHub binding records created by the journeys, and an
  exact non-ASCII organization-name canary.

## Diagnostics and cleanup

- Any browser console error/warning, page error, or same-origin HTTP 5xx fails
  the test and is attached to the Playwright result.
- Screenshots, video, and traces are retained only on failure.
- The runner executes the Control V1 smoke after Chromium and queries
  PostgreSQL for the exact E2E records.
- Cleanup runs in `finally`, including when Compose startup or a browser test
  fails.
