# Telegram Setup

Use this guide when `opentag setup --platform telegram` asks for Telegram values.

OpenTag receives Telegram bot messages locally through `getUpdates` polling by default. No public tunnel is required in the default mode: the local dispatcher keeps running, polls Telegram, starts local runs, and replies back to the originating Telegram chat.

Webhook delivery is still available as an advanced mode when you want Telegram to push updates to a public HTTPS endpoint.

## What You Need

- A Telegram bot token from [BotFather](https://t.me/BotFather).
- Optional: the bot username, for group mentions such as `@opentag_bot` or `/opentag@opentag_bot`.
- Optional: Telegram user IDs allowed to run `/bind` and `/unbind` in group chats.
- Optional for advanced webhook mode only: a public HTTPS tunnel that forwards to the local dispatcher.

## Create The Bot

1. Open [BotFather](https://t.me/BotFather).
2. Use `/newbot`, or open an existing bot.
3. Copy the bot token. It looks like:

```text
123456789:AA...
```

The numeric prefix is the bot id. OpenTag derives it from the token unless you pass `--telegram-bot-id`.

Optional but recommended: configure bot commands in BotFather:

```text
opentag - Start an OpenTag run or source-thread control command
help - Show OpenTag commands
status - Show bound Project Target and active run state
doctor - Show redacted readiness
stop - Request cancellation
bind - Bind this chat to a Project Target
unbind - Remove this chat binding
```

## Run OpenTag Setup

Default polling mode:

```bash
opentag setup \
  --platform telegram \
  --telegram-bot-token 123456789:replace-me
```

For group chats, allow specific Telegram users to change the Project Target binding:

```bash
opentag setup \
  --platform telegram \
  --telegram-bot-token 123456789:replace-me \
  --telegram-bot-username opentag_bot \
  --telegram-binding-admin-user-ids 111111,222222
```

The setup command saves:

- `platforms.telegram.mode` as `polling`
- `platforms.telegram.botId`
- `platforms.telegram.agentId`
- `platforms.telegram.botUsername`
- `platforms.telegram.botToken`
- `platforms.telegram.bindingAdminUserIds`

OpenTag stores the token in the local config file and redacts it in `opentag status` and `opentag doctor`.

## Start Polling

Start OpenTag:

```bash
opentag start
```

OpenTag prints:

```text
Telegram: using getUpdates polling
Telegram tunnel: not required in polling mode
```

Polling mode calls Telegram's `deleteWebhook` once on startup because Telegram does not allow `getUpdates` while a webhook is configured. It then receives updates with `getUpdates` long polling.

Official reference: [Telegram Bot API `getUpdates`](https://core.telegram.org/bots/api#getupdates).

## Advanced Webhook Mode

Use webhook mode only when you want Telegram to push updates to a public HTTPS URL:

```bash
opentag setup \
  --platform telegram \
  --telegram-mode webhook \
  --telegram-bot-token 123456789:replace-me
```

Start OpenTag and point a tunnel at the dispatcher:

```bash
ngrok http 3030
opentag start
```

OpenTag prints:

```text
Telegram local webhook: http://127.0.0.1:3030/telegram/events/<bot_id>
Telegram webhook URL: https://<your-tunnel-host>/telegram/events/<bot_id>
```

Set the Telegram webhook with the public HTTPS URL and the secret token printed by setup:

```bash
curl "https://api.telegram.org/bot<bot-token>/setWebhook" \
  --get \
  --data-urlencode "url=https://<your-tunnel-host>/telegram/events/<bot_id>" \
  --data-urlencode "secret_token=<opentag-secret-token>"
```

Telegram sends the secret token back as `X-Telegram-Bot-Api-Secret-Token`. OpenTag verifies that header before accepting webhook updates.

Official reference: [Telegram Bot API `setWebhook`](https://core.telegram.org/bots/api#setwebhook).

## Bind And Test

In a private chat with the bot:

```text
/bind github:acme/demo
fix this failing test
```

In a group chat, address the bot:

```text
@opentag_bot /bind github:acme/demo
@opentag_bot investigate this bug
```

Expected behavior:

- `/bind` connects the Telegram chat to a Project Target.
- A task message creates an OpenTag run.
- OpenTag replies in the same Telegram chat.
- `/status`, `/doctor`, and `/stop [run_id]` work as source-thread controls and do not create a new run.

## Current Scope

Supported now:

- CLI setup through `opentag setup --platform telegram`.
- Default local `getUpdates` polling with no public tunnel.
- Advanced local dispatcher webhook at `/telegram/events/<bot_id>`.
- Bot API delivery and self-service replies.
- Private-chat binding through `/bind`.
- Group-chat binding when `--telegram-binding-admin-user-ids` is configured.
- Source-thread controls: `/help`, `/bind`, `/unbind confirm`, `/status`, `/doctor`, and `/stop [run_id]`.

Not yet implemented:

- Automatic `setWebhook` registration.
- Telegram inline buttons for action receipts.
- Hosted relay mode for Telegram.
