# Linear Setup

Use this guide when `opentag setup --platform linear` asks for Linear values.

OpenTag treats a Linear issue comment as a source thread. A comment like `@opentag investigate this` creates a local run; a later source-thread action such as `apply 1` can post a Linear comment or update supported Linear issue fields through the Linear GraphQL API.

The current CLI path recommends a Linear OAuth App / actor=app install and still supports manual API keys for compatibility. `opentag setup` can discover Linear team/state/user/label metadata and persist adapter mappings. For Linear Agent runs, OpenTag accepts `AgentSessionEvent` webhooks, updates the Linear Agent Session plan, and posts progress/final callbacks as Agent Activities.

## What You Need

- A Linear workspace where you can create OAuth apps and webhooks.
- A Linear OAuth app for GraphQL callbacks and issue updates; for quick local validation, a workspace API key is still supported.
- A local project checkout that OpenTag can bind as the Project Target.
- A public HTTPS tunnel for local webhook delivery, for example ngrok, or a trusted OpenTag relay URL that is already configured for Linear.

Official references:

- Linear API / Webhooks settings: <https://linear.app/settings/api>
- Linear OAuth docs: <https://linear.app/developers/oauth-2-0-authentication>
- Linear Agent docs: <https://linear.app/developers/agents>
- Linear GraphQL API docs: <https://linear.app/developers/graphql>
- Linear Webhooks docs: <https://linear.app/developers/webhooks>

## Create A Linear OAuth App

Open Linear Developer / API settings, create an OAuth app for the workspace, and configure its redirect URI. OpenTag setup generates an `actor=app` authorization URL. Recommended scopes:

```text
read write comments:create app:assignable app:mentionable
```

After approval, paste the `code` from the redirect URL back into setup. OpenTag exchanges the code, saves the OAuth access/refresh token metadata, and uses the token to discover Linear metadata. When the saved OAuth App token is close to expiry, local runtime refreshes it with the saved refresh token and writes the new access/refresh token metadata back to the OpenTag config.

## API Key Compatibility Mode

For quick local validation, you can still open <https://linear.app/settings/api> and create an API key for the workspace.

OpenTag uses this key to:

- post OpenTag acknowledgement, progress, and final-result comments back to the Linear issue
- execute supported Linear issue mutations after you reply with an approved action such as `apply 1`

Do not paste the key into chat. Enter it only when `opentag setup` prompts for it, or pass it through a local environment/config secret.

## Run Setup

From the project checkout that should handle Linear runs:

```bash
opentag setup \
  --platform linear \
  --linear-auth oauth_app \
  --linear-oauth-client-id <linear-client-id> \
  --linear-oauth-client-secret <linear-client-secret> \
  --linear-oauth-redirect-uri <linear-redirect-uri>
```

Setup prints a Linear authorization URL. After approval, continue with the authorization code:

```bash
opentag setup \
  --platform linear \
  --linear-auth oauth_app \
  --linear-oauth-client-id <linear-client-id> \
  --linear-oauth-client-secret <linear-client-secret> \
  --linear-oauth-redirect-uri <linear-redirect-uri> \
  --linear-oauth-code <code-from-redirect>
```

API-key compatibility mode:

```bash
opentag setup \
  --platform linear \
  --linear-auth api_key \
  --linear-token <linear-api-key>
```

Useful optional flags:

```bash
opentag setup \
  --platform linear \
  --linear-team-id <linear-team-id> \
  --linear-team-key ENG \
  --linear-discover-metadata \
  --linear-port 3070
```

If you have a trusted relay that advertises hosted OAuth install support,
setup can create the pending relay install without collecting Linear secrets
locally:

```bash
opentag setup \
  --platform linear \
  --relay https://<your-relay-host>
```

Setup writes `auth.method: "hosted_oauth_app"`, prints a Linear OAuth install
URL, and records the relay installation id. The user-facing webhook URL remains
the fixed OAuth App webhook path, usually
`https://<your-relay-host>/linear/oauth/webhooks`. The relay stores the OAuth
token and installation record after Linear returns to `/linear/oauth/callback`.
The OAuth App webhook signing secret is app-level relay configuration
(`OPENTAG_LINEAR_OAUTH_WEBHOOK_SECRET`), not a per-install secret users copy
into Linear. The OAuth app's webhook settings still need to be configured by
the relay/app operator; the current backend provides the
install/callback/storage/webhook path, while a polished self-service install
portal or marketplace listing can wire that UX end to end later.
If Linear later sends an `OAuthApp` `revoked` webhook for the workspace, the
relay removes the stored hosted install token and records a
`linear.oauth_install.revoked` control-plane event so future callbacks fail
closed instead of using stale credentials.

If you use a static-token relay instead, setup can write relay mode and upload
the local Linear token/signing-secret config to the relay. When the local config
uses `auth.method: "oauth_app"`, the upload also includes non-client-secret
OAuth refresh metadata so the relay can refresh the Linear access token before
callbacks and direct apply:

```bash
opentag setup \
  --platform linear \
  --linear-auth oauth_app \
  --linear-oauth-client-id <linear-client-id> \
  --linear-oauth-client-secret <linear-client-secret> \
  --linear-oauth-redirect-uri <linear-redirect-uri> \
  --linear-oauth-code <code-from-redirect> \
  --relay https://<your-relay-host>
```

Depending on the auth mode, setup writes:

- `platforms.linear.token` unless `auth.method` is `hosted_oauth_app`
- `platforms.linear.auth`
- `platforms.linear.webhookSecret` unless `auth.method` is `hosted_oauth_app`
- `platforms.linear.webhookPath`
- `platforms.linear.port`
- `platforms.linear.projectTarget`
- optional `platforms.linear.teamId`
- optional `platforms.linear.teamKey`
- optional `platforms.linear.graphqlUrl`
- optional `platforms.linear.mappings`

By default, the webhook path is `/linear/webhooks` and the local webhook port is `3070`.

## Configure The Linear Webhook

Start OpenTag locally:

```bash
opentag start
```

In local mode, OpenTag prints values like:

```text
Linear local webhook: http://127.0.0.1:3070/linear/webhooks
Linear webhook URL: https://<your-tunnel-host>/linear/webhooks
Linear settings: https://linear.app/settings/api
Linear events: Comment and Agent session events (enable Webhooks on the Linear OAuth app and point them at the webhook URL above)
Tunnel example: ngrok http 3070
```

In relay mode, OpenTag prints the relay URL instead and no local tunnel is required:

```text
Webhook URL: https://<your-relay-host>/linear/oauth/webhooks
Relay mode: Linear should call the relay URL above; no ngrok/cloudflared tunnel is needed.
```

**Default path (OAuth App install)**: the webhook is configured on the **OAuth
app itself**, not as a workspace webhook. Enable Webhooks in the Linear OAuth
app settings:

- URL: your public tunnel plus `/linear/webhooks`
- Events: **Comment and Agent session events** — Agent session events route
  mentions through Linear's native Agent Session panel (plan, activity
  timeline, stop) instead of loose top-level comments
- Signing secret: copy the signing secret the OAuth app's Webhooks settings
  generate into `platforms.linear.webhookSecret` in your OpenTag config (or
  setup's `--linear-webhook-secret`)

When one mention produces both a Comment and an Agent Session event, OpenTag
deduplicates twice over: delegation flows mark Linear's synthetic anchor
comment with `isArtificialAgentSessionRoot`, which the comment channel skips
outright; real user comments carry no such marker and arrive about a second
before their AgentSessionEvent, so in OAuth App mode comment runs are deferred
for a short grace window (2.5s by default) — if a session event whose
`agentSession.commentId` points at the comment lands inside the window, the
Agent Session channel owns the run and nothing double-triggers. OpenTag also
ignores comments authored by OAuth app actors (`@oauthapp.linear.app` emails),
so a posted summary that quotes `@opentag` can never re-trigger the agent.

**API key compatibility mode**: create a workspace webhook in Linear API /
Webhooks settings:

- URL: in local mode, your public tunnel plus `/linear/webhooks`; in dynamic relay mode, the exact `/linear/webhooks/<install-id>` URL printed by setup
- Resource/event: Comment events (API key mode has no Agent Session panel; OpenTag replies appear as threaded replies under the triggering comment)
- Signing secret: must match `platforms.linear.webhookSecret` in your OpenTag config; if Linear does not accept a custom secret, copy the value Linear generates back into the config

For hosted OAuth App installs, webhook delivery is configured on the OAuth app
itself rather than from the local OpenTag config. The relay/app operator should
configure the app webhook endpoint to
`https://<your-relay-host>/linear/oauth/webhooks` (or the configured
`OPENTAG_LINEAR_OAUTH_WEBHOOK_PATH`) and enable Comment plus Agent Session
events before distributing the install URL.

The ingress verifies `Linear-Signature` and the webhook timestamp before creating a run.

## Test

On a Linear issue, add a comment that explicitly mentions OpenTag:

```text
@opentag summarize what needs to change here
```

Expected behavior:

- Linear sends the Comment webhook to your public tunnel or configured relay.
- OpenTag verifies the signature and timestamp, then creates a run.
- The local runner claims the run and executes in the configured checkout.
- OpenTag posts acknowledgement/progress/final comments back to the same Linear issue.

If a final result proposes Linear issue actions, reply with an action command such as:

```text
apply 1
```

Linear issue apply currently supports:

- creating a new Linear issue: `issue/create_issue` actions call Linear `issueCreate`
- adding a comment
- transitioning status when a Linear state id or configured mapping is available
- setting assignee by Linear user id, including unassigning
- setting numeric priority
- setting labels by Linear label ids

When Slack or another source thread creates a Linear issue, Slack/Discord/Lark/GitHub are only the source surfaces; the Linear adapter performs the write. The first version is manual by default: OpenTag renders an action receipt in the source thread, and only calls `issueCreate` after the user clicks **Apply 1** or replies with `apply 1`. Linear issue creation requires at least a title and Linear team. Provide `teamId` directly, or use metadata-discovered `team/teamKey -> teamId` mappings. If a workspace has multiple teams and the action does not identify one, the receipt falls back to setup/continue instead of silently creating an issue. After creation, OpenTag replies to the original source thread with the Linear issue URL.

Slack -> Linear issue creation does not require a separate public URL for the Linear create action itself; `issueCreate` is an outbound GraphQL request from OpenTag to Linear. Public URL requirements only come from the source ingress mode: Slack Socket Mode does not need a public URL, while Slack Events API still needs a Slack-reachable HTTPS endpoint.

Pull request creation still needs a repository-backed target. Linear events created by setup include a Project Target so code runs can stay bound to the local checkout, but Linear itself is not a git hosting provider.

## Relay Mode

Linear relay mode is for a relay you operate or have confirmed is configured for Linear. It supports two setup shapes:

- Hosted OAuth App install: the trusted relay advertises `oauthInstall.enabled=true`, `setup --relay` asks the relay to create a pending Linear install, and the user completes the Linear `actor=app` authorization URL. The relay callback exchanges the code, generates/stores the webhook signing secret, stores the OAuth token/refresh metadata, and returns only non-secret install metadata to the CLI. The local CLI does not ask for or upload a Linear API key, OAuth access token, or webhook signing secret in this mode.
- Static token relay: a self-hosted or manually provisioned relay stores a Linear token, webhook signing secret, Project Target, and optional GraphQL URL either through `/v1/linear-relay-installations` or through relay environment variables.

Both shapes use a unique `/linear/webhooks/<install-id>` path when dynamically provisioned. The relay can select the install-specific signing secret from the path before verifying `Linear-Signature`, which avoids unsafe pre-verification routing when multiple workspaces share one relay.

Legacy self-hosted relays can still use the global `/linear/webhooks` path plus environment variables. Do not point a Linear workspace webhook at a generic hosted relay unless the relay operator explicitly confirms that hosted OAuth install or dynamic Linear installation provisioning is enabled, or that your workspace's signing secret and API key have already been configured. Without relay-side configuration, use local `opentag start` plus a public tunnel.

For new Linear setup, pass `--relay https://<your-relay-host>` to `opentag setup`. Setup validates the relay health endpoint. If the trusted relay advertises hosted OAuth install support, setup creates the pending OAuth install and prints the Linear authorization URL. Otherwise, for static-token relay configs, setup generates a unique Linear webhook path and calls `/v1/linear-relay-installations` while registering the runner/repo binding. It then writes `runtime.mode=relay` and prints the exact Linear webhook URL. For an existing config, run `opentag pair --relay https://<your-relay-host>` to pair the checkout with the relay; if the config already uses a static-token `/linear/webhooks/<install-id>` config, pair uploads that installation config again.

If you explicitly configure the legacy `/linear/webhooks` path, setup/pair falls back to static relay readiness checks. When the relay exposes `/v1/relay/capabilities`, the CLI verifies Linear ingress and direct apply readiness before writing relay mode. Outbound delivery is activated independently through the provider registry and delivery kernel.

If the relay advertises Linear support but is missing ingress/apply readiness,
`setup --relay` and `pair --relay` fail before writing relay mode and print a
sanitized relay-side env template. The template includes the non-secret Project
Target values and placeholders for the Linear token/signing secret, so secrets
are not copied into terminal logs.

When Linear metadata discovery produced team/status/user/label mappings, relay
pairing also uploads those mappings to the dispatcher's repository
mutation-mappings so relay-side direct apply can use the same semantic values as
the local config.

For a hosted-compatible relay:

```text
https://<your-relay-host>/linear/webhooks/<install-id>
```

The relay must verify `Linear-Signature` and the webhook timestamp before creating runs.

Static-token OpenTag-compatible relays expose `/v1/linear-relay-installations`
for storing per-install Linear token / signing secret / Project Target data.
This endpoint requires the dispatcher admin token, and responses do not echo the
token or signing secret. Runs created by dynamic webhooks include the non-secret
`linearRelayInstallationId` in metadata, so later comment callbacks, Agent
Activities, and direct apply can resolve the token from relay storage.

When the relay is configured with `OPENTAG_LINEAR_OAUTH_CLIENT_ID` and
`OPENTAG_LINEAR_OAUTH_REDIRECT_URI`, it can also start hosted Linear OAuth App
installs through `POST /v1/linear-oauth-installations`. When the relay is also
configured with `OPENTAG_LINEAR_OAUTH_WEBHOOK_SECRET`, it accepts fixed OAuth
App webhooks at `/linear/oauth/webhooks` and routes them to the completed
install by `organizationId`. The install endpoint returns a Linear authorization
URL using `actor=app`; the public `/linear/oauth/callback` exchanges the
returned code, stores the per-install OAuth token / refresh token metadata, runs
best-effort team/state/user/label metadata discovery into relay-side mutation
mappings, and returns only the non-secret installation summary.

`opentag setup --relay <url> --platform linear` uses that hosted OAuth App path
by default when the trusted relay advertises Linear OAuth install support. In
that mode setup does not ask for a Linear API key or local OAuth authorization
code; it creates a pending relay install, stores `auth.method:
"hosted_oauth_app"`, records the returned installation id, keeps the fixed
`/linear/oauth/webhooks` webhook path in local config, and prints the Linear
OAuth install URL for the user to finish in Linear.
This provides the CLI-backed hosted install flow; a polished marketplace portal
UI can still be added later.

OpenTag-compatible self-hosted relays also expose `/v1/relay/capabilities`.
When static Linear env is enabled, the response lists `provider: "linear"` with
ingress enabled at `/linear/webhooks`, plus callback and apply enabled. When
hosted OAuth install env is enabled, the response also includes
`oauthInstall.enabled=true`. Older relays that do not expose this endpoint
remain pairable, but setup cannot confirm their Linear readiness before trying
the relay request.

For the current self-hosted dispatcher relay, configure the relay process with:

```bash
OPENTAG_LINEAR_API_KEY='<linear-oauth-access-token-or-lin_api_key>'
OPENTAG_LINEAR_WEBHOOK_SECRET='<linear-webhook-signing-secret>'
OPENTAG_LINEAR_WEBHOOK_PATH=/linear/webhooks
OPENTAG_LINEAR_REPO_PROVIDER=github
OPENTAG_LINEAR_REPO_OWNER=<owner>
OPENTAG_LINEAR_REPO_NAME=<repo>
```

OAuth access tokens may be provided with or without the `Bearer ` prefix.
Linear API keys should be provided as the raw `lin_api_...` value.

`OPENTAG_LINEAR_REPO_PROVIDER`, `OPENTAG_LINEAR_REPO_OWNER`, and `OPENTAG_LINEAR_REPO_NAME` identify the Project Target metadata embedded into Linear-created runs. They must match a repository binding registered by `opentag setup --relay ...` or `opentag pair --relay ...`; otherwise the local runner will reject the run before executor startup.

## Supported Today

- CLI setup through `opentag setup --platform linear`.
- Local Linear webhook ingress at `/linear/webhooks`.
- Signed Linear Comment webhooks.
- Linear issue comments for OpenTag callbacks.
- Reused Linear status comments for the same run, so progress updates edit one status comment instead of creating a new comment every time.
- Source-thread controls and action replies from Linear comments.
- Linear issue mutation apply for issue creation, comments, state, assignee, priority, and labels.
- `opentag setup` support for OAuth App / `actor=app` authorization URLs and code exchange.
- Runtime OAuth App token refresh for Linear callbacks and direct issue apply.
- `opentag setup` metadata discovery for teams, workflow states, users, labels, and adapter mappings; team mappings can drive source-thread `issue/create_issue`.
- `opentag setup --relay` for Linear-capable hosted/self-hosted relay pairing, so a local ngrok/cloudflared tunnel is not required after relay setup.
- Hosted-compatible OAuth install backend endpoints: authenticated `POST /v1/linear-oauth-installations` plus public `/linear/oauth/callback`.
- A credential-gated live Linear workspace smoke harness for webhook -> run -> `commentCreate` -> `issueUpdate`.
- Native Linear Agent path for `AgentSessionEvent` webhooks: OpenTag creates a run from `created` events, treats `prompted` activity bodies as follow-up commands, immediately updates the Agent Session plan / accepted activity, and posts later progress/final callbacks as `agentActivityCreate` activities.
- Linear Agent `stop` signals from prompt activities route to OpenTag source-thread cancellation for the active Agent Session run instead of creating a new run. A stop request is not treated as successful completion.

## Not Supported Yet

- Linear Agent support follows Linear's Developer Preview API surface and may need updates if that API changes.
- OpenTag does not yet provide a polished hosted OAuth install portal / marketplace listing for arbitrary Linear workspaces; the backend install endpoints and fixed OAuth App webhook ingress still require a Linear-capable relay URL you operate or trust.
- The real Linear workspace smoke harness is not part of default CI and still requires explicit Linear workspace credentials.
- Native Linear project/document mutations beyond the issue fields listed above.
- Discord/Lark/GitHub sources can reuse the same `issue/create_issue` action design, but this page does not claim those source surfaces have completed real end-to-end validation yet.
