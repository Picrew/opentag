# Live E2E Smoke Harness

The smoke harness inventories local contract checks and the provider-live cases
that remain valid after the single-stack delivery cutover.

## Cases

| Case | Live | Scope |
| --- | --- | --- |
| `protocol-runtime` | No | GitHub-shaped run lifecycle through a captured unified delivery producer |
| `slack-protocol` | No | Slack-shaped presentations, quiet progress, and Block Kit final rendering through the unified producer |
| `factory-conformance` | No | Restart-safe recipe, workstream, batch, runner, and delivery-presentation conformance |
| `builtin-acp` | Yes | Real built-in ACP readiness, isolated worktree, and cancellation behavior |
| `openclaw-acp` | Yes | Real OpenClaw Gateway ACP conformance |
| `slack-linear-registry-live` | Yes | Exact registry release, real Slack `/linear`, read-only Linear queries, and a provider-visible Slack reply |

List the authoritative cases directly from the harness:

```bash
corepack pnpm smoke:live -- --list
```

Preflight without provider or executor side effects:

```bash
corepack pnpm smoke:live -- --case protocol-runtime,slack-protocol,factory-conformance --dry-run
corepack pnpm smoke:live -- --case slack-linear-registry-live --dry-run --allow-missing
```

Run the credential-free cases:

```bash
corepack pnpm smoke:live -- --case protocol-runtime,slack-protocol,factory-conformance
```

## Evidence boundary

The local protocol cases prove that dispatcher presentations reach the unified
producer and that successful enqueue emits `delivery.intent.queued`. They do
not claim a provider accepted a message. A missing production composition emits
`delivery.activation_blocked` and means no provider I/O was attempted.

Provider outcomes belong to the delivery journal or verified hosted delivery
observations. The harness must not synthesize `delivered` from run events,
metrics, external IDs, or executor success.

## Registry-installed provider case

The Slack `/linear` case installs a declared release into a fresh directory.
For the current release line, the install shape is:

```bash
smoke_root="$(mktemp -d)"
(
  set -euo pipefail
  cd "$smoke_root"
  npm init -y >/dev/null
  npm install --no-audit --no-fund @opentag/cli@0.11.0
  ./node_modules/.bin/opentag --version
)
```

The live case additionally verifies exact lockfile package identities and
integrities before accepting a real human Slack command. It fails closed on
Linear mutations and retains redacted evidence only. Follow its printed
preflight requirements; do not place provider tokens in reports or command-line
arguments.

## Reports

Use `--report` to retain a local JSON result:

```bash
corepack pnpm smoke:live -- \
  --case protocol-runtime,slack-protocol,factory-conformance \
  --report .omx/live-e2e/local-delivery-contracts.json
```

The report records commands, preflight state, exit status, and elapsed time. It
does not turn a local contract smoke into provider-live evidence. Keep release
identity, delivery journal truth, and provider-visible proof as separate
receipts.
