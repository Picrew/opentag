# Contributing to OpenTag

Thanks for helping improve OpenTag. This project is still young, so small, focused pull requests are easiest to review and merge.

## Development setup

OpenTag uses Node.js and pnpm.

- Node.js 22.x
- pnpm 9.x

Install dependencies from the repository root:

```bash
pnpm install
```

## Local CLI development

Build the local CLI and install a checkout-backed `opentag-dev` command:

```bash
corepack pnpm opentag-dev
```

This creates or updates `~/.local/bin/opentag-dev` so it runs `packages/cli/dist/index.js` from your current checkout. It does not install or shadow the future official `opentag` command, so a published CLI and your local development CLI can exist side by side.

After setup, use the development CLI from any terminal:

```bash
opentag-dev --help
opentag-dev config path
```

If your shell cannot find `opentag-dev`, add `~/.local/bin` to `PATH`.

## Local checks

Before opening a pull request, run the checks that match your change. For code changes, the full local check sequence is:

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

For documentation-only changes, run:

```bash
git diff origin/main...HEAD --check
```

## Pull request guidelines

- Keep PRs small and focused on one change.
- Link the issue, source thread, or design document that explains the change when one exists.
- Include a clear summary and the validation you ran.
- Prefer adding or updating tests when behavior changes.
- Call out authorization, privacy, provider side effects, compatibility, migration, and release risks explicitly.
- Do not commit generated local state such as SQLite databases, temporary worktrees, or `.tsbuildinfo` files.
- Do not commit secrets. Keep `.env`, Slack tokens, GitHub tokens, private keys, and webhook secrets out of git.

Pull requests to `main` must pass the required CI check, receive a code-owner approval, and resolve review conversations before merge. New commits invalidate stale approvals. Force pushes and branch deletion are blocked on `main`.

Security vulnerabilities must not be reported in a public issue. Follow [SECURITY.md](SECURITY.md) to report them privately.

## Configuration

Use `docs/configuration.md` as the reference for local environment variables and daemon configuration. If you are configuring a repeatable local daemon setup, prefer an explicit `OPENTAG_CONFIG_PATH` JSON file over ad-hoc environment variables.
