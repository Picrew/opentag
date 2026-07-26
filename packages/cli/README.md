# @opentag/cli

OpenTag CLI for setting up and running a local source-thread agent work loop.

OpenTag turns an existing work thread into a governed agent work loop. The CLI configures the local dispatcher, platform listener, runner, executor capability checks, context packet snapshots, action receipts, artifacts, and local audit/status surfaces that keep that loop source-thread-native and local-first.

## Install

```bash
npm install -g @opentag/cli@latest
```

Then run:

```bash
opentag setup
opentag service status
opentag doctor
```

`opentag setup` walks through the local governed-loop configuration:

- Choose a language.
- Choose a platform: Lark / Feishu, Slack, GitHub, GitLab, Linear, Telegram, or Discord.
- Choose a coding agent: Codex, Claude Code, Cursor, OpenCode, Hermes, OpenClaw, or Echo for local testing, including its executor capability boundary. OpenClaw reports `cancel=no` until its Gateway can prove tool-process termination.
- Configure platform credentials.
- Bind the selected project.
- Choose how OpenTag should run.

The recommended setup option keeps OpenTag running after the terminal closes. It installs and starts a background service on macOS and Linux. If background service mode is unsupported or you choose terminal mode, use `opentag start` and keep that terminal open.

For GitHub, GitLab, Linear, or Discord webhook deployments that use an already configured relay, `opentag setup --relay https://<relay-host>` writes relay mode directly and pairs the local checkout with that relay.

`opentag status --run <run_id>` shows the local context packet, agent work ledger, produced artifacts, callback delivery, and safe next actions without turning the source thread into an agent log stream.

`opentag status --workstream <workstream_id>` shows the workstream state and next action first, followed by recipe budgets, accepted outcomes, and bounded exception detail. Healthy workstreams stay quiet. Add `--json` to receive structured `workstream`, `recipe`, `metrics`, and `evaluation` objects for automation.

External local runtimes can report lifecycle hooks through the public [Hook Ingest Contract](../../docs/hook-ingest.md): `opentag ingest-template --format manifest` prints the manifest, and `opentag ingest` records audit-visible progress or terminal state through runner-scoped auth.

## Commands

```bash
opentag setup
opentag start
opentag service start
opentag service stop
opentag service status
opentag service logs
opentag status
opentag doctor
opentag config path
opentag config show
opentag platforms
opentag executors
```

## Local Config

OpenTag stores local configuration at:

```text
~/.config/opentag/config.json
```

The config contains local secrets, so the CLI writes it with private file permissions.

## Platform Guides

The setup wizard links to the matching guide for each platform:

- Lark / Feishu: `docs/platforms/lark.en.md`
- Slack: `docs/platforms/slack.en.md`
- GitHub: `docs/platforms/github.en.md`
- GitLab: `docs/platforms/gitlab.en.md`
- Linear: `docs/platforms/linear.en.md`
- Telegram: `docs/platforms/telegram.en.md`
- Discord: `docs/platforms/discord.en.md`

## Requirements

- Node.js 22 or newer.
- An existing local login or provider configuration for the selected Codex, Claude Code, Cursor, OpenCode, Hermes, or OpenClaw ACP agent.
- Platform credentials for the platform you connect.

## No Install

The scoped CLI package supports one-off runs without a global install:

```bash
npx @opentag/cli doctor
npx @opentag/cli setup
npx @opentag/cli start
```

For background service mode, install the CLI globally first so the generated service definition points at a stable CLI path instead of an `npx` temporary location.

## Local Development

Inside the OpenTag monorepo, install the development command:

```bash
corepack pnpm opentag-dev
```

Then run:

```bash
opentag-dev setup
opentag-dev start
```
