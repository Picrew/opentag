# @opentag/dispatcher

Embeddable dispatcher service for OpenTag.

Use this package when you want to host the OpenTag dispatcher inside another Node or Hono-compatible service instead of running `@opentag/dispatcher-app`.

## Install

```bash
pnpm add @opentag/dispatcher
```

## Exports

- `createDispatcherApp`: creates the Hono app that exposes the OpenTag dispatcher API.
- `createGitHubCallbackSink`: posts callback messages to GitHub issue or PR comments.
- `createSlackCallbackSink`: posts callback messages to Slack threads through `chat.postMessage`.
- `createTelegramCallbackSink`: posts callback messages to Telegram chats through the Bot API `sendMessage` method.
- `createCompositeCallbackSink`: fans callback delivery out to multiple sinks.
- `CallbackMessage`, `CallbackSink`: callback delivery contracts.

## Example

```ts
import {
  createCompositeCallbackSink,
  createDispatcherApp,
  createGitHubCallbackSink,
  createSlackCallbackSink,
  createTelegramCallbackSink
} from "@opentag/dispatcher";

export const dispatcher = createDispatcherApp({
  databasePath: "opentag.db",
  pairingToken: process.env.OPENTAG_PAIRING_TOKEN,
  callbackSink: createCompositeCallbackSink([
    createGitHubCallbackSink({ token: process.env.OPENTAG_GITHUB_TOKEN }),
    createSlackCallbackSink({ botToken: process.env.OPENTAG_SLACK_BOT_TOKEN }),
    createTelegramCallbackSink({ botToken: process.env.OPENTAG_TELEGRAM_BOT_TOKEN })
  ])
});
```

## API Shape

The app exposes `/healthz` and `/v1/*` dispatcher endpoints for runners, Project Target bindings, generic channel bindings, Slack compatibility bindings, runs, progress, heartbeats, completion, and audit event lookup.

Factory-mode callers can additionally create immutable recipe snapshots and
WorkThread-only workstreams, submit replay-safe workstream batches, inspect a
durable batch receipt, and read workstream metrics/evaluation. Every batch item
uses the same managed-channel ownership and Run admission path as `/v1/runs`;
routine per-item source-thread acknowledgements are suppressed in favor of one
bounded exception summary.

When `pairingToken` is set, every `/v1/*` endpoint requires:

```text
Authorization: Bearer <pairingToken>
```

## Stability

The Hono app factory and callback sink interfaces are public API. Individual HTTP endpoint semantics should remain backward compatible within a major version.
