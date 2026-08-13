# @opentag/telegram

Telegram message normalization and source-thread presentation helpers for
OpenTag.

Use this package to normalize Telegram bot messages into `OpenTagEvent` objects
and to encode or parse Telegram source-thread keys.

## Install

```bash
pnpm add @opentag/telegram
```

## Exports

- `normalizeTelegramMessage`: converts a Telegram message into an `OpenTagEvent`.
- `encodeTelegramThreadKey`: encodes bot, chat, and message coordinates for source-thread delivery.
- `parseTelegramThreadKey`: decodes a Telegram source-thread key.
- `renderTelegramAcknowledgement`: renders the Telegram acknowledgement body.
- `renderTelegramFinalResult`: renders the Telegram final result body.
- `createTelegramSendMessagePayload`: creates a Telegram Bot API `sendMessage` payload.

## Example

```ts
import { normalizeTelegramMessage } from "@opentag/telegram";

const event = normalizeTelegramMessage({
  botId: "bot_123",
  botUsername: "opentag_bot",
  chatId: "456",
  chatType: "private",
  userId: "789",
  username: "alice",
  text: "investigate this deploy failure",
  messageId: 101,
  updateId: 202,
  binding: {
    botId: "bot_123",
    chatId: "456",
    repoProvider: "github",
    owner: "acme",
    repo: "demo"
  }
});

if (event) {
  // Send the event to @opentag/client or your own OpenTag-compatible control plane.
}
```

## Stability

Telegram thread key format is part of the source-thread identity shared by
ingress and delivery. A breaking format change must update both sides
atomically.
