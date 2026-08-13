# @opentag/discord

Discord interactions normalization and presentation rendering for OpenTag.

Turns a Discord `/opentag` slash-command interaction into an `OpenTagEvent`,
verifies the Ed25519 request signature, and renders acknowledgement / progress
/ final presentations. The interactions app is a Hono application meant to be
mounted into the OpenTag dispatcher process (see
`@opentag/local-runtime`), mirroring the GitLab webhook ingress.

## Exports

- `verifyDiscordSignature` — Ed25519 verification over `timestamp + rawBody`
  (uses `node:crypto`, no third-party dependency).
- `normalizeDiscordInteraction` — `APPLICATION_COMMAND` → `OpenTagEvent`.
- `encodeDiscordThreadKey` / `parseDiscordThreadKey` — `guildId|channelId|anchorId`.
- `renderDiscord*` / `createDiscordSendMessagePayload` — presentation rendering.
- `createDiscordInteractionsApp` — Hono app handling PING / signature / command.

Slash-command MVP (Interactions Webhook route). The `@mention` (Gateway) route
is not implemented in this slice.
