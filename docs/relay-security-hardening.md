# Relay Security Hardening Memo

OpenTag relay mode keeps code execution local, but it moves ingress and run
leasing to a remote control plane. Treat any relay as trusted infrastructure:
it can observe run metadata, command text, progress, and completion summaries,
and it controls which queued runs the local runner claims.

## P0 Guardrails

These are required for the self-hosted relay MVP:

- Public relay URLs must use HTTPS. The CLI allows HTTP only for localhost
  development URLs such as `http://localhost:8787`.
- `opentag pair --relay` prints an explicit trust warning before telling the
  user to start a relay-backed runner.
- `opentag start` refuses public HTTP relay configs, disables local dispatcher
  and local webhook ingress in relay mode, and reminds the user that the relay
  must verify the configured source-platform webhook secret/signature.
- `opentag status`, `opentag doctor`, and `opentag service status` show relay
  security checks for transport, relay trust, Project Target allowlisting,
  source webhook secret configuration, unsupported relay-mode platforms, and
  missing runner security policy.
- Relay processes expose `/v1/relay/capabilities` without secrets so setup and
  pairing flows can confirm source ingress and direct apply readiness before
  users point provider webhooks at the relay. Outbound delivery readiness is
  derived separately from the activated provider registry and delivery kernel.
- The local daemon refuses claimed runs whose Project Target metadata is
  missing, outside the local config allowlist, or a GitHub source event pointing
  at a non-GitHub Project Target. This check happens before executor startup.

Relay deployments must also verify source-platform webhook signatures before
creating runs. For GitHub repository webhooks, verify
`X-Hub-Signature-256` using `platforms.github.webhookSecret`. For GitLab Note
Hooks, verify `X-Gitlab-Token` using `platforms.gitlab.webhookSecret`. For
Linear workspace webhooks, verify `Linear-Signature` and the webhook timestamp
using `platforms.linear.webhookSecret` for static self-hosted ingress, or the
per-install secret selected by a unique `/linear/webhooks/<install-id>` path for
dynamic relay ingress. Hosted Linear OAuth App ingress uses a fixed
`/linear/oauth/webhooks` path: verify that shared OAuth App signing secret
first, then route the verified payload by `organizationId` to the completed
OAuth installation. Do not accept unsigned source events on `/github/webhooks`,
`/gitlab/webhooks`, or Linear webhook paths.

## P1 Beta Hardening

Before relay mode is treated as beta-ready, split the current shared pairing
token into narrower credentials:

- Registration token: used only during `opentag pair --relay`.
- Runner claim token: used by the local runner to claim, heartbeat, report
  progress, and complete runs.
- Webhook secret: used only for source-platform webhook verification.
- Rotation and revocation: support replacing a runner token without rebuilding
  all Project Target and channel bindings.
- Token display rules: never print full tokens in CLI output, status, doctor,
  service logs, or relay logs.
- Failure behavior: revoked or expired runner tokens should fail closed and
  tell the user to pair again.

The goal is to reduce blast radius: a leaked registration token should not let
an attacker claim runs, and a leaked runner token should be revocable without
reconfiguring the GitHub webhook secret.

Until those narrower credentials exist, relay readiness output should warn that
the self-hosted MVP still uses the daemon pairing token for both registration
and runner calls. When `daemon.runnerToken` is configured, local runner,
status, cancel, and hook-ingest calls prefer that token while `pairingToken`
remains available for legacy pairing/bootstrap compatibility. When the
dispatcher also has `runnerToken` / `OPENTAG_RUNNER_TOKEN`, runner claim,
heartbeat, progress, and completion endpoints reject the pairing token and
require the runner token. Self-hosted dispatchers can also accept additional
runner tokens during a rotation window and reject revoked runner-token
fingerprints without printing token values. This state belongs in
`opentag status`, `opentag doctor`, and `opentag service status` so operators do
not mistake self-hosted relay mode for a beta-ready credential model before
registration, runner, and webhook credentials are independently rotatable and
revocable with durable audit.

## P2 Hosted Relay Requirements

These are required before any public hosted or multi-tenant relay:

- Tenant isolation for runners, Project Targets, channel bindings, webhook
  secrets, and run history.
- Per-install Linear relay secrets and tokens stored server-side, with webhook
  paths that let the relay select the signing secret before parsing trusted
  tenant metadata.
- Audit logs for pairing, binding changes, webhook admission, run creation,
  runner claim, progress, completion, token rotation, and token revocation.
- Rate limits per tenant, source platform, relay token, runner id, and webhook
  endpoint.
- Replay protection for webhook deliveries and runner calls using delivery ids,
  idempotency keys, timestamps, and bounded retention.
- Request body size limits and schema validation on every public endpoint.
- Run provenance: each run should record source delivery id, verified signature
  state, matched Project Target, admission decision, and runner id.
- Alerting for repeated signature failures, unknown Project Targets, token
  misuse, abnormal runner claim rates, and large payload rejection.
- Operational recovery: token revocation should stop new claims immediately
  while preserving audit history.

The self-hosted dispatcher exposes `/v1/control-plane-alerts` as an
authenticated alert-candidate summary over control-plane and run audit events.
The in-process rules currently cover repeated authorization failures, source
webhook signature failures, unknown Project Targets, abnormal runner claim
volume, large payload rejection, malformed/schema-invalid request bodies, and
terminal platform-token misuse. GitHub repository webhook ingress, Slack Events
API ingress, and Telegram webhook secret-token checks record missing, invalid,
or stale verification failures as `security.signature_failed` without storing
raw signatures, secret tokens, or request bodies. Slack Socket Mode records
terminal app-token auth/config failures such as `invalid_auth`,
`token_revoked`, and `token_expired` as `security.token_misuse` without storing
the app token.
`opentag status` also surfaces these candidates when the dispatcher is online,
so operators can see warning signals without calling the API directly. Hosted
deployments should connect these candidates to durable notification, retention,
tenant-aware thresholds, and on-call workflows.

The self-hosted dispatcher also records control-plane audit events for runner
registration, Project Target binding upserts, generic channel binding
upserts/deletes, repository policy-rule upserts, repository mutation-mapping
upserts, and the Slack channel-binding compatibility endpoint. These events
capture safe identifiers, target coordinates, and summary flags such as
`hasWorkspacePath`, `allowedActorsCount`, `hasMetadata`, `hasReason`,
`valueCount`, or `hasDescription`; they intentionally do not store local
workspace paths, token values, request bodies, binding metadata payloads, policy
reason text, or mutation mapping values. Hosted relays still need tenant-scoped
retention, export, and operator review workflows around these management events.

The dispatcher package can enforce an optional in-process fixed-window limit for
`/v1/*` calls keyed by relay-token fingerprint, runner id, source platform,
tenant or account hint, and normalized endpoint. The tenant hint is derived from
safe path dimensions such as GitHub owner, channel account id, or Slack team id;
same-tenant source containers share the same bucket while different tenants do
not consume each other's local fixed-window allowance. A public hosted relay
still needs a durable or edge-backed limiter for multi-instance deployments and
tenant-level quotas.
Self-hosted dispatcher processes can enable the current limiter with
`OPENTAG_RATE_LIMIT_WINDOW_MS` and `OPENTAG_RATE_LIMIT_MAX_REQUESTS`, or leave it
explicitly off with `OPENTAG_RATE_LIMIT_DISABLED=true`. They can also override
the JSON request body cap with `OPENTAG_MAX_REQUEST_BODY_BYTES`. These process
local knobs are hardening aids for MVP/self-hosted deployments, not a hosted
relay quota system.
Local source ingress endpoints also enforce a request body cap before parsing
payloads or verifying signatures that require the raw body. GitHub repository
webhooks, Slack Events API, and Telegram webhooks share the same default cap and
return `413 request_body_too_large` without storing request bodies. They also
validate the payload shape for fields OpenTag consumes before creating runs,
submitting source-thread actions, or dispatching self-service commands; valid but
unsupported platform events remain ignored instead of hard-failing. When
connected to the dispatcher they record `security.request_body_rejected` audit
events for oversized, malformed JSON, and schema-invalid bodies with provider,
endpoint, reason, max bytes when relevant, optional delivery id, and content
length only.
When the dispatcher is started by `opentag service`, persist only these
non-secret knobs with `opentag service install --max-request-body-bytes ...`
and `--rate-limit-window-ms ... --rate-limit-max-requests ...`; launchd will not
inherit an interactive shell's temporary environment.

Runner running, progress, and completion calls accept an idempotency key,
including from local `opentag ingest --idempotency-key ...` hook integrations.
Replaying the same key for the same run returns success but does not append
another `run.running` / `run.progress` / `run.completed` audit event or
source-thread running/progress/final presentation intent. Hosted relays still need durable
idempotency-key retention across instances and for additional runner call types.

Source webhook deliveries are also tracked by source delivery id when the
ingress provides one. The store exposes a bounded-retention prune operation for
stale source delivery replay keys, and it keeps keys for non-terminal runs so
active work remains protected from replay. The dispatcher exposes the explicit
maintenance endpoint `POST /v1/source-deliveries/prune`, and the CLI wraps it as
`opentag maintenance prune-source-deliveries --older-than <iso-timestamp> --limit <n>`.
The operation returns `scanned`, `pruned`, and `retainedActive` counts and
records a control-plane maintenance event without exposing delivery ids or
secrets. Hosted relays still need a scheduled retention policy, tenant-aware
windows, durable metrics, and alerts around pruned versus retained-active
delivery keys.

Hosted relay mode should not expand into hosted code execution unless the
product explicitly changes direction. The local-first boundary remains: relay
handles ingress and dispatch, while user code and agents run on the user's
machine.
