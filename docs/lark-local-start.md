# Start OpenTag For Lark Locally

Use this guide when you want the shortest local loop:

```text
Lark message -> OpenTag dispatcher -> opentagd on this computer -> executor -> Lark reply
```

This is the current MVP setup path. It shows a Lark/Feishu Personal Agent QR
code, stores the created app credentials locally, and avoids manually starting
the dispatcher, daemon, and Lark ingress in separate terminals.

## What You Need

- Node 22.14 or newer
- Git
- A Lark or Feishu account
- A local git checkout for the project the agent should run in
- An existing login or provider configuration for Codex, Claude Code, Cursor, OpenCode, Hermes, or OpenClaw

The `echo` executor is still available for plumbing checks, but the real demo
path should choose `codex`.

## Start

From the OpenTag repository:

```bash
./scripts/dev/start-lark.sh
```

The script prompts for:

- Project Target path, which is the local codebase this agent should work on
- executor: `codex`, `claude-code`, `cursor`, `opencode`, `hermes`, `openclaw`, or `echo`
- Lark app setup: `scan` or `manual`, only when no saved app exists
- a QR scan when using `scan` for the first time; the link may start on the Feishu bootstrap page, and OpenTag saves the real tenant returned by Lark / Feishu
- Lark / Feishu tenant: `feishu` or `lark`, only when using `manual`; pass `--tenant lark` for an existing Lark global app
- `LARK_APP_ID` and `LARK_APP_SECRET` only when using `manual`
- `LARK_BOT_OPEN_ID` only when group chat support cannot be detected automatically

It then:

1. Installs workspace dependencies if needed.
2. Creates a Lark/Feishu Personal Agent from the QR scan, unless manual app
   credentials or saved local credentials are available.
3. Saves Personal Agent credentials to `.opentag/lark/lark.local.json`.
4. Generates `.opentag/lark/opentag.local.json`.
5. Starts the dispatcher.
6. Registers the local runner.
7. Binds the selected local checkout.
8. Starts `opentagd`.
9. Starts the Lark long-connection ingress.

## Restarting

After the first successful QR or manual setup, rerun the same command:

```bash
./scripts/dev/start-lark.sh
```

The script reuses `.opentag/lark/lark.local.json`, so you do not need to scan a
new QR code. To create a new Personal Agent app intentionally, set
`OPENTAG_LARK_APP_SETUP=scan` or `OPENTAG_LARK_APP_SETUP=manual`.

## Project Target

The Lark MVP path is Project Target first. A Project Target is the local
codebase this agent works on. The script asks for the local path for this Project Target
and connects the first Lark chat to it. The first-run path does not require a
GitHub repo.

For local-only Project Targets, OpenTag derives the internal `local:path_...`
identity from the canonical local path used during setup. That keeps symlinked
and real paths pointed at the same checkout on the same computer aligned without
asking users to understand the internal ref.

## First Message

In a direct chat with the bot, send:

```text
say hello from my local computer
```

In a group chat, send:

```text
@OpenTag say hello from my local computer
```

The first chat that messages the bot is automatically connected to the selected
Project Target. This keeps the first-run path short.

## Advanced GitHub Target

GitHub repository settings are optional for the Lark local loop. Use them later
when you want GitHub-specific behavior such as repository policy, branch push, or
pull request creation. Set `OPENTAG_REPO_OWNER` and `OPENTAG_REPO_NAME` before
starting the script to attach a GitHub repository identity to the Project Target.

## Expected Result

1. The terminal shows the local daemon claiming and running the task.
2. Lark replies with the agent's final result.

## Useful In-Chat Checks

After the bot is connected, you can inspect the source-container state from
Lark without exposing local paths or secrets:

```text
@OpenTag /status
@OpenTag /doctor
@OpenTag /stop
```

- `/status` shows the bound Project Target, active run, queued follow-ups, and
  the next safe action.
- `/doctor` shows a redacted source-container readiness summary. It confirms
  whether the dispatcher can read runtime state for this chat, then points local
  service, connector, executor, and heartbeat checks back to
  `opentag service status`.
- `/stop [run_id]` requests cancellation for the active chat run or the
  specified run. OpenTag records cancellation separately from successful
  completion.

## Current Limits

- The QR flow creates a Personal Agent app, but the user still finishes the app
  creation page opened by Lark/Feishu after scanning.
- Group chat triggers require the bot open id. The script tries to detect it
  automatically; if detection fails, direct chat still works.
- Code tasks still need a local git checkout because the Codex ACP executor runs
  them in isolated worktrees.
- The future package CLI should replace this repo-local script with
  `npx opentag lark`.
