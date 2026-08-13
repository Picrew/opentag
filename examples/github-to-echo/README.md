# GitHub To Echo Demo

This demo proves the OpenTag v0 loop without needing a real coding agent.

## Flow

```text
@opentag fix this
-> GitHub Probot ingress
-> hosted dispatcher run
-> opentagd local daemon
-> echo executor
-> final delivery presentation intent
```

## Local Manual Path

1. Start the dispatcher:

```bash
OPENTAG_DATABASE_PATH=opentag.db pnpm --filter @opentag/dispatcher-app dev
```

`OPENTAG_GITHUB_TOKEN` is for GitHub direct apply. Provider delivery requires an
activated GitHub adapter in the unified registry; there is no token-based
dispatcher fallback. For local smoke tests, inspect `/events` for queued intent
or activation-blocked truth.

Set `OPENTAG_PAIRING_TOKEN=dev_pairing_token` on the dispatcher if you want to exercise authenticated local pairing.

2. Create a local daemon config:

```bash
cat > opentag.local.json <<'JSON'
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3030",
  "pairingToken": "dev_pairing_token",
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 15000,
  "repositories": [
    {
      "provider": "github",
      "owner": "acme",
      "repo": "demo",
      "checkoutPath": "/Users/example/repos/demo",
      "defaultExecutor": "echo",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ]
}
JSON
```

3. Register the runner and bind its repository:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- register-runner
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-repos
```

4. Create a run with a normalized event payload:

```bash
curl -X POST http://localhost:3030/v1/runs \
  -H 'content-type: application/json' \
  -d '{
    "runId": "run_demo_1",
    "event": {
      "id": "evt_demo_1",
      "source": "github",
      "sourceEventId": "comment_demo_1",
      "receivedAt": "2026-06-24T00:00:00.000Z",
      "actor": { "provider": "github", "providerUserId": "42", "handle": "octocat" },
      "target": { "mention": "@opentag", "agentId": "opentag" },
      "command": { "rawText": "fix this", "intent": "fix", "args": {} },
      "context": [
        { "provider": "github", "kind": "issue", "uri": "https://github.com/acme/demo/issues/1", "visibility": "public" }
      ],
      "workItem": {
        "provider": "github",
        "kind": "issue",
        "externalId": "acme/demo#1",
        "uri": "https://github.com/acme/demo/issues/1",
        "ownerContainer": {
          "provider": "github",
          "id": "acme/demo",
          "uri": "https://github.com/acme/demo"
        }
      },
      "permissions": [
        { "scope": "issue:comment", "reason": "reply to source thread" }
      ],
      "callback": {
        "provider": "github",
        "uri": "https://api.github.com/repos/acme/demo/issues/1/comments"
      },
      "metadata": { "owner": "acme", "repo": "demo" }
    }
  }'
```

5. Run the daemon once:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- run-once
```

Or keep it polling continuously:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- serve
```

6. Inspect the stored run and audit events:

```bash
curl http://localhost:3030/v1/runs/run_demo_1
curl http://localhost:3030/v1/runs/run_demo_1/events
```

## Codex And PR Path

Switch the config to `"defaultExecutor": "codex"` to run Codex through the bundled ACP adapter in the mapped checkout. To let OpenTag create pull requests, add a GitHub token:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3030",
  "pairingToken": "dev_pairing_token",
  "githubToken": "ghs_optional_token_for_pr_creation",
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 15000,
  "repositories": [
    {
      "provider": "github",
      "owner": "acme",
      "repo": "demo",
      "checkoutPath": "/Users/example/repos/demo",
      "defaultExecutor": "codex",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ]
}
```

When a `fix` command changes files, OpenTag creates an `opentag/<runId>` branch, pushes it, and opens a PR against `baseBranch`.

## Slack Path

Slack reuses the same dispatcher and local daemon:

1. Start `apps/slack-events` with `SLACK_SIGNING_SECRET`, `OPENTAG_DISPATCHER_URL`, and `OPENTAG_DISPATCHER_TOKEN` when needed.
2. Add Slack channel bindings by putting `slackChannels` into the daemon config and running:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-slack-channels
```

Example config fragment:

```json
{
  "slackChannels": [
    {
      "teamId": "T123",
      "channelId": "C123",
      "repoProvider": "github",
      "owner": "acme",
      "repo": "demo"
    }
  ]
}
```

3. Point Slack **Event Subscriptions** to `/slack/events` on `apps/slack-events`.
4. Enable Slack **Interactivity & Shortcuts** and point its Request URL to the same `/slack/events` endpoint. This lets Block Kit buttons such as **Apply 1** submit the same source-thread action as typing `apply 1`.
5. Send an `app_mention` in the bound channel. OpenTag will add a lightweight reaction receipt, keep routine progress audit-only, and post the final summary back to that Slack thread.
