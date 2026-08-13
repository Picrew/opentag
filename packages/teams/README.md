# @opentag/teams

Microsoft Teams adapter primitives for OpenTag.

This package receives Microsoft Teams Bot Framework `message` activities,
normalizes supported messages into `OpenTagEvent`s, verifies Bot Framework JWTs,
renders OpenTag delivery presentations, and posts replies back to the source Teams
conversation through the Bot Connector REST API. It is mounted by the
`local-runtime` dispatcher; this package does not run a standalone service by
itself, and Teams relay ingress is not currently supported.

## v1 scope

- Team channel messages only.
- The bot must be @mentioned to create or update an OpenTag run.
- Plain text / Markdown replies.
- Source-thread action commands such as `apply 1` / `reject 1` are routed back
  to the originating OpenTag run.
- Personal chats, group chats outside channels, rich Adaptive Card flows, and
  proactive messages are intentionally out of scope for v1.

## Main modules

- `normalize.ts` converts Teams activities into OpenTag events.
- `auth.ts` validates Bot Framework bearer tokens.
- `token.ts` obtains Connector API access tokens.
- `connector.ts` posts replies through the Bot Connector REST API.
- `render.ts` converts OpenTag presentations into Teams-friendly text.
- `webhook-app.ts` wires auth, normalization, dispatcher calls, and source-thread
  replies for the `/teams/messages` endpoint.
- `thread-key.ts` builds stable OpenTag thread keys for Teams source threads.

## Real Teams integration notes

These details came from local simulation plus a real Teams smoke test against an
Azure Bot and Microsoft 365 tenant.

### Bot Framework auth

`auth.ts` is intentionally fail-closed:

- JWT signature validation is required.
- Expected issuer validation is required.
- Expected audience validation is required; it must match the Microsoft App ID
  configured for the bot.
- The inbound activity `channelId` must be `msteams`.
- The JWT `serviceUrl` claim is required and must match the Activity body
  `serviceUrl`. OpenTag never trusts a body-controlled reply URL unless the
  Bot Framework token binds the same URL.
- The signing JWK must include a Teams endorsement (`msteams`) before the
  request can create a run, submit an action, or trigger any outbound Connector
  call.

For local JWT simulation, `OPENTAG_TEAMS_OPENID_METADATA_URL` can point at a
local JWKS endpoint. Test JWKS keys must include `endorsements: ["msteams"]`.
Production should use Microsoft metadata.

### Conversation IDs and bindings

A channel activity can include a conversation id like:

```text
19:<channel-id>@thread.tacv2;messageid=<activity-id>
```

The durable channel binding should use the base channel conversation id, not the
reply-specific suffix:

```text
19:<channel-id>@thread.tacv2
```

`local-runtime` also has a fallback that strips `;messageid=...` so an incoming
full conversation id can still match a binding created with the base id.
Dispatcher source-thread lookup keeps both the full reply identity and a
canonical base-conversation alias, while the delivery presentation retains the full
conversation id needed to reply to the correct Teams thread.

The binding identity is effectively:

- `tenantId`
- base Teams channel conversation id
- optional repository target / owner / repo / executor config for coding tasks

### Source-thread actions

Teams replies have their own `activity.id`. When a user replies `apply 1` under
a proposal, the original proposal/root activity id is carried in
`conversation.id` as `;messageid=<root-activity-id>`.

`webhook-app.ts` must route source-thread actions with the root activity id, not
the reply activity id. Otherwise dispatcher lookup cannot find the action
receipt and the user sees a generic failure for `apply 1` / `reject 1`.
Before recording a decision, creating an ApplyPlan, or executing an adapter
mutation, Dispatcher revalidates the tenant/channel stored on the proposal and
requires the current Teams channel binding to retain the same identity and, for
repository actions, the same repository target. Removed, rebound, or
identity-incomplete bindings fail closed.

### Source-thread delivery

The Teams delivery adapter posts status updates back into the same channel thread.
For proposal receipts, the rendered message should clearly indicate the target
system of record, impact, preconditions, and exact Teams command to approve or
reject the action.

## Testing

Use `pnpm` directly in this repo; do not rely on `corepack pnpm` in local
maintainer shells where Corepack is unavailable.

Targeted regression tests:

```bash
pnpm vitest run \
  packages/teams/test/auth.test.ts \
  packages/teams/test/webhook-app.test.ts \
  packages/local-runtime/test/dispatcher.teams.test.ts
```

Type checks:

```bash
pnpm --dir packages/teams exec tsc --noEmit
pnpm --dir packages/local-runtime exec tsc --noEmit
```

Local Bot Framework/JWKS simulation should cover normal @mention run creation,
`apply` action routing, forged-key rejection, and wrong-audience rejection. Keep
simulation helpers outside the published repo if they are only development
notebook artifacts.

## Troubleshooting for maintainers

| Symptom | Likely cause | What to inspect |
| --- | --- | --- |
| `401` from `/teams/messages` | Wrong Microsoft App ID, wrong tenant/app secret, bad JWT metadata, or invalid audience | Bot App ID config, Azure Bot messaging endpoint, auth test fixtures, tunnel request body and headers |
| No request reaches local OpenTag | Teams app/bot not installed, bot not @mentioned, tunnel URL wrong, or dev tunnel requires auth | ngrok `http://127.0.0.1:4040`, devtunnel `--allow-anonymous`, Azure Bot Messaging endpoint |
| Channel binding not found | Binding used full `conversation.id` with `;messageid=...` or wrong tenant/channel | Compare `tenantId`, `channelData.channel.id`, base conversation id, and OpenTag config |
| `apply 1` says action could not be processed | Action routed with reply activity id instead of proposal/root activity id, or apply credentials are missing | `webhook-app.ts` thread key derivation, dispatcher source-thread receipt, GitHub/GitLab apply config |
| Claude executor is not ready | Local Claude authentication is missing or invalid | Complete the local Claude login, restart OpenTag, and run `opentag doctor` |

## Configuration surface

User-facing setup is documented in:

- `docs/platforms/teams.en.md`
- `docs/platforms/teams.zh-CN.md`

Keep those guides in sync with package behavior whenever auth, binding,
delivery, or action-routing semantics change.
