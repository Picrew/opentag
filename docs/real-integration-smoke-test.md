# Real Integration Smoke Test

This guide captures the exact sequence that worked for validating OpenTag against real GitHub and Slack services, plus the failure modes we actually hit along the way.

Use this document when you want to prove that OpenTag works beyond local unit tests:

- real GitHub App webhook delivery
- real Slack Events API delivery
- real Lark card reply and patch delivery
- real Linear workspace comment and issue update delivery
- real dispatcher and daemon execution
- real callback messages posted back to the source thread
- real local Claude Code execution
- protocol metrics that show callback noise and artifact flow

For the consolidated runner that wraps the local protocol smoke cases and the
live GitHub/Slack/Lark/Linear scripts, see
[Live E2E Smoke Harness](./live-e2e-smoke-harness.md).

## Goal

A smoke test is complete when all of these are true:

1. A real GitHub comment or Slack app mention reaches the matching ingress service.
2. The dispatcher creates a run and records audit events.
3. The local daemon claims the run and executes the configured executor.
4. The final result is posted back to the original GitHub thread or Slack thread.
5. Metrics show low human callback noise relative to audit events.

## Linear Workspace Live Test

Use this script when you need to prove the real Linear hosted-relay callback and
issue-update path. It registers a temporary Linear relay installation for
token/project-target storage and submits signed Linear webhook payloads locally
to the fixed hosted OAuth App webhook path (`/linear/oauth/webhooks` by
default), so it does not need ngrok, but it does call the real Linear GraphQL
API for `commentCreate` and `issueUpdate`.

```bash
OPENTAG_LINEAR_SMOKE_TOKEN='Bearer <linear-oauth-app-actor-access-token>' \
OPENTAG_LINEAR_SMOKE_ISSUE=<linear-issue-key-or-url-or-uuid> \
corepack pnpm smoke:live -- --case linear-workspace-live
```

By default, the smoke verifies that the token resolves to a Linear OAuth app
actor (`viewer.app=true`) and reports that evidence in `oauthActor`. This keeps
the live validation aligned with the hosted OAuth App / `actor=app` install
path. Set `OPENTAG_LINEAR_SMOKE_ALLOW_NON_APP_TOKEN=true` only when intentionally
running an API-key compatibility smoke.

Expected evidence:

- signed `/linear/oauth/webhooks` payload creates an OpenTag run through the
  hosted OAuth webhook ingress and routes by `organizationId`
- `oauthActor.appActorVerified` is `true` for the default OAuth App smoke token
- acknowledgement/final callback creates or updates a real Linear issue comment
- `singleStatusComment.reusedExternalMessageId` and
  `singleStatusComment.graphql.statusCommentUpdateVerified` are `true`,
  proving the status lifecycle updated one Linear comment instead of creating
  comment noise
- signed `apply 1` payload creates an approval and apply plan
- Linear direct apply executes a real `issueUpdate`
- metadata discovery queries teams, users, workflow states, and labels, then
  reports generated mapping domains and value counts in `metadataDiscovery`
- optional `OPENTAG_LINEAR_SMOKE_AGENT_SESSION_ID` validates native
  `AgentSessionEvent` `created` and `prompted` delivery through
  `agentSessionUpdate` and `agentActivityCreate`
- optional Agent Session output includes `agentSessionSmoke.prompted` with the
  queued follow-up id, the active run it queued behind, `followUpStatus:
  "promoted"`, and the promoted follow-up run id
- `linearGraphqlEvidence.requiredOperations` is `true` for the required Linear
  GraphQL paths, with operation counts included in the JSON output
- the JSON output reports `ok: true` and `applyOutcomeCounts.applied: 1`

`OPENTAG_LINEAR_SMOKE_ISSUE_ID` remains supported for older local scripts, but
new runs should prefer `OPENTAG_LINEAR_SMOKE_ISSUE` because it accepts the
human-readable Linear issue key as well as the model UUID or issue URL.

## Shared Local Prerequisites

- Node 22.14 or newer
- pnpm 9.x
- A clean local checkout for any repository you want to bind
- `pnpm install`

The examples below assume:

- dispatcher on `http://localhost:3031`
- GitHub Probot ingress on `http://localhost:3000`
- Slack Events ingress on `http://localhost:3040`
- a pairing token of `dev_pairing_token`

## Lark Message Patch Live Test

Use this script when you need to prove that OpenTag can send one Lark status
card and then patch that same message for the final callback. It exercises the
real Lark API through `lark-cli`, but keeps dispatcher state in memory and does
not require a long-running daemon.

Prerequisites:

- `lark-cli` is installed and available on `PATH`, or `OPENTAG_LARK_CLI` points
  to the binary.
- `lark-cli auth status` reports the bot identity as ready and the user identity
  as ready, or at least provides a cached user `openId` for bot-to-user seed
  messages.
- The bot identity can send a message to the current user.

Run:

```bash
NODE_OPTIONS='--conditions=development' \
  packages/dispatcher/node_modules/.bin/tsx \
  scripts/dev/run-lark-message-patch-live-test.ts
```

By default the script creates a bot-to-user seed message, creates an in-memory
Lark-shaped run, sends the acknowledgement card as a Lark reply, and completes
the run so the final callback patches the acknowledgement card in place.

Optional inputs:

```bash
OPENTAG_LARK_LIVE_REPO=amplifthq/opentag-test
OPENTAG_LARK_LIVE_CHAT_ID=<existing-chat-id>
OPENTAG_LARK_LIVE_SOURCE_MESSAGE_ID=<existing-source-message-id>
```

Set both `OPENTAG_LARK_LIVE_CHAT_ID` and
`OPENTAG_LARK_LIVE_SOURCE_MESSAGE_ID` to reuse an existing source message. Set
neither to let the script create a private seed message.

Expected evidence:

- `ok: true`
- `createdSeedMessage` shows whether the script created the source message.
- The acknowledgement delivery has `returnedExternal: true`.
- The final delivery has `hasExternal: true` and returns the same redacted
  message id, proving that the final callback patched the first Lark card
  instead of posting a second final card.

The script intentionally prints only a redacted summary. It must not print app
secrets, tokens, full message ids, raw request bodies, binding metadata payloads,
or local workspace paths. Its generated idempotency keys are deliberately short
because Lark rejects overlong keys with field validation errors.

## Recommended Local Config

Create a local runner config that binds the repository you want to test:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3031",
  "pairingToken": "dev_pairing_token",
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 15000,
  "repositories": [
    {
      "provider": "github",
      "owner": "amplifthq",
      "repo": "opentag",
      "checkoutPath": "/absolute/path/to/opentag",
      "defaultExecutor": "echo",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ],
  "slackChannels": [
    {
      "teamId": "T_REAL",
      "channelId": "C_REAL",
      "repoProvider": "github",
      "owner": "amplifthq",
      "repo": "opentag"
    }
  ]
}
```

Start with `"defaultExecutor": "echo"` until the end-to-end callback loop is proven. Switch to `"codex"` or `"claude-code"` only after GitHub or Slack replies are working.

For Claude Code, set the repository binding to:

```json
"defaultExecutor": "claude-code"
```

The Claude ACP adapter is resolved from its pinned Registry package through
`npx`. Complete the normal local Claude login before
starting the daemon. Direct Claude command, model, and permission-mode settings
have been removed. If authentication intentionally comes from
`ANTHROPIC_API_KEY`, add `ANTHROPIC_API_KEY` to `security.extraSafeEnv` so the
ACP child receives it after environment scrubbing.

## GitHub Smoke Test

### GitHub CLI-Assisted Smoke Test

The fastest real GitHub test does not require a GitHub App webhook. It uses the active `gh` CLI login to create a GitHub-shaped run directly in the dispatcher, then lets `opentagd` execute locally and callback to a real issue.

Use an existing issue:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_WORKSPACE_PATH=/absolute/path/to/clean/opentag-test \
OPENTAG_GH_TEST_ISSUE=1 \
scripts/dev/run-gh-claude-local-test.sh
```

Or create a temporary issue:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_WORKSPACE_PATH=/absolute/path/to/clean/opentag-test \
OPENTAG_GH_CREATE_ISSUE=true \
scripts/dev/run-gh-claude-local-test.sh
```

For the thread-native PR flow, prefer:

```bash
OPENTAG_GH_PREPARE_PR_BRANCH=true \
OPENTAG_GH_APPLY_PR_ACTION=true \
scripts/dev/run-gh-claude-local-test.sh
```

### GitHub Repository Webhook Live Test

Use this when you need to prove the real GitHub repository webhook ingress, not
only the dispatcher-assisted path. The script starts the local CLI stack,
exposes the GitHub webhook listener through ngrok, creates a temporary
repository webhook, posts a real issue comment, replies `apply 1`, waits for the
PR, and deletes the temporary webhook on exit.

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
scripts/dev/run-github-webhook-live-test.sh
```

Expected evidence:

- GitHub issue comment creates a dispatcher run through `/github/webhooks`.
- Final GitHub comment renders a ready or mixed-state action receipt and
  advertises `apply 1` only for actions the dispatcher can currently apply.
- Replying `apply 1` through GitHub creates an `ApprovalDecision` and `ApplyPlan`.
- Apply executes through GitHub and comments with the created PR URL.
- The temporary repository webhook is deleted after the run.

To prove the missing-apply-credentials path while keeping GitHub callbacks live,
run the same script with direct apply disabled:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN=true \
scripts/dev/run-github-webhook-live-test.sh
```

Expected evidence for that branch:

- The final GitHub comment renders `### Needs setup`.
- The comment does not advertise `apply 1` as an available direct-apply command.
- The script skips the apply reply because the dispatcher has no GitHub apply
  token.

This path requires `gh` admin or maintain access for the target repository so
the script can create and delete the temporary webhook.

This lets the daemon commit and push the executor-produced run branch, but it does not open the PR immediately. The final callback should render a `create_pull_request` suggested action with the PR title, head branch, base branch, changed files, risks, executor conditions, and any real verification the executor reported. Reply in the source thread with:

```text
apply 1
```

When `OPENTAG_GH_APPLY_PR_ACTION=true` is set, `scripts/dev/run-gh-claude-local-test.sh` submits that same `apply 1` reply through `/v1/thread-actions` after the daemon finishes, so the run can produce a complete dogfood trace without manually copying the reply.

Expected result:

- dispatcher records `approval.decision.recorded`
- dispatcher creates an ApplyPlan for the selected `create_pull_request` intent
- GitHub adapter calls `POST /repos/{owner}/{repo}/pulls`
- source thread receives a final callback containing the pull request URL
- metrics show `approvalDecisionCount: 1`, `applyPlanCount: 1`, and `applyOutcomeCounts.applied: 1`

Set `OPENTAG_GH_CREATE_PR=true` only when you explicitly want the legacy daemon path to commit, push, and create the pull request immediately after executor completion. Without either PR flag, the smoke test validates callback delivery and local execution without opening a PR.

This path has been validated with:

```text
GitHub issue -> dispatcher -> opentagd -> local Claude Code -> commit branch -> push -> PR -> GitHub callback
```

The thread-native action variant should be traced as:

```text
GitHub issue -> dispatcher -> opentagd -> local Claude Code -> pushed run branch -> final callback with create_pr action -> source-thread apply 1 -> ApprovalDecision -> ApplyPlan -> GitHub PR -> final callback with PR URL
```

GitHub callbacks update one comment per run in place. The first callback creates the run comment, and later progress/final callbacks patch that same comment instead of creating a new issue comment for every state change.

### GitHub App Setup

1. Create a GitHub App for local testing.
2. Install it to the target repository.
3. Use a webhook URL that points to your public tunnel and GitHub webhook path.

Recommended webhook path:

```text
/github/webhooks
```

Recommended minimum repository permissions:

- `Issues: Read and write`
- `Pull requests: Read`
- `Metadata: Read`

Recommended subscribed events:

- `Issue comment`
- `Pull request review comment`

### Public Tunnel

Expose the Probot ingress port:

```bash
ngrok http 3000
```

Use the resulting public URL in the GitHub App webhook URL:

```text
https://<ngrok-host>/github/webhooks
```

### Local Processes

Start the dispatcher with a GitHub callback token:

```bash
OPENTAG_DATABASE_PATH=opentag.github-test.db \
OPENTAG_PAIRING_TOKEN=dev_pairing_token \
OPENTAG_GITHUB_TOKEN=<github-token> \
PORT=3031 \
apps/dispatcher/node_modules/.bin/tsx apps/dispatcher/src/index.ts
```

Register the runner and bind the repository:

```bash
OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts register-runner

OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-repos
```

Start the daemon:

```bash
OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts serve
```

Start Probot from built output:

```bash
APP_ID=<github-app-id> \
WEBHOOK_SECRET=<github-webhook-secret> \
PRIVATE_KEY_PATH=/absolute/path/to/github-app.private-key.pem \
PORT=3000 \
WEBHOOK_PATH=/github/webhooks \
OPENTAG_DISPATCHER_URL=http://localhost:3031 \
OPENTAG_DISPATCHER_TOKEN=dev_pairing_token \
OPENTAG_DISPATCHER_OWNS_CALLBACKS=true \
pnpm --filter @opentag/github-probot exec probot run ./dist/index.js
```

### Real Trigger

Create or reuse a real issue, then post:

```text
@opentag investigate this
```

Expected result:

- Probot receives `issue_comment`
- dispatcher creates a run
- daemon claims and executes the run
- GitHub thread receives:
  - acknowledgement
  - progress
  - final result

For GitHub App webhook testing, keep `OPENTAG_DISPATCHER_OWNS_CALLBACKS=true` on the Probot app so the dispatcher owns the run comment lifecycle.

### GitHub Failure Modes We Hit

- **Probot setup mode**
  This happened when Probot did not receive `APP_ID`, `WEBHOOK_SECRET`, and `PRIVATE_KEY_PATH` in the names it expects. `GITHUB_APP_ID` is not enough by itself.

- **Webhook path mismatch**
  The GitHub App must point to the actual Probot webhook path, not just the tunnel root.

- **App installed but repo missing**
  The App installation must explicitly include the repository you are testing.

- **PR push failed because no commit existed**
  Local executors leave file changes in the run branch. `opentagd` now stages and commits changed files before pushing a run branch for PR creation.

## Slack Smoke Test

### Slack API-Assisted Smoke Test

The fastest real Slack test does not require a public Events API tunnel. It uses the configured Slack bot token to post a seed message in the bound channel, then creates a Slack-shaped OpenTag run against that thread.

```bash
OPENTAG_ENV_FILE=/absolute/path/to/.env.slack-test \
scripts/dev/run-slack-claude-local-test.sh
```

By default this script reads `OPENTAG_CONFIG_PATH` from the env file, creates a temporary clean checkout for the configured repo, executes local Claude Code, and prints the run metrics plus Slack thread replies.

To validate the thread-native PR action loop from Slack, let the daemon prepare the executor branch and submit `apply 1` after the final callback:

```bash
OPENTAG_ENV_FILE=/absolute/path/to/.env.slack-test \
OPENTAG_SLACK_APPLY_PR_ACTION=true \
scripts/dev/run-slack-claude-local-test.sh
```

`OPENTAG_SLACK_APPLY_PR_ACTION=true` automatically enables PR branch preparation. The dispatcher must also have a GitHub token available through `OPENTAG_GITHUB_TOKEN` or an authenticated `gh` CLI, because the approved `create_pull_request` intent is applied through the GitHub adapter even though the source thread is Slack.

This path has been validated with:

```text
Slack thread -> dispatcher -> opentagd -> local Claude Code -> Slack final callback + metrics
```

With `OPENTAG_SLACK_APPLY_PR_ACTION=true`, the expected action-loop shape is:

```text
Slack thread -> dispatcher -> opentagd -> local Claude Code -> pushed run branch
-> Slack final callback with create_pr action -> apply 1 -> ApprovalDecision
-> ApplyPlan(adapter=github) -> GitHub PR -> Slack final callback with PR URL
```

Expected Slack thread shape:

- original user/bot seed message
- OpenTag `eyes` reaction receipt on the source message
- OpenTag final result
- optional `apply 1` reply when validating the action loop
- optional apply result callback containing the PR URL
- if direct apply is not available, the receipt should show `Needs setup` or `Continue` instead of presenting `Apply` as the primary path

Routine acknowledgement and progress stay out of Slack thread replies by default, so they should not produce additional Slack messages.

### Slack App Setup

Required bot scopes:

- `app_mentions:read`
- `chat:write`
- `reactions:write`

Required bot event:

- `app_mention`

Install the app to the workspace, then collect:

- `App-Level Token` for Socket Mode, or `Signing Secret` for Events API
- `Bot User OAuth Token`
- target `teamId`
- target `channelId`

Invite the bot user into the test channel before sending any mention.

### Socket Mode Transport

For local README recordings, prefer Socket Mode. It avoids public Request URL
drift and sends app mentions plus Block Kit button actions through Slack's
WebSocket connection:

```bash
OPENTAG_SLACK_APP_TOKEN=xapp-... \
  scripts/dev/run-slack-ui-trigger-local-test.sh
```

Slack Interactivity still needs to be enabled, but Socket Mode does not require
an Interactivity Request URL.

### Events API Transport

Use Events API only when you intentionally want to validate a public Request URL
or hosted ingress. Disable Socket Mode for that specific app setup.

If Socket Mode is still enabled, Slack may give confusing signals in the dashboard and you end up debugging the wrong transport.

### Public Tunnel

Expose the Slack Events ingress port:

```bash
cloudflared tunnel --url http://localhost:3040
```

ngrok works too:

```bash
ngrok http 3040
```

Use the resulting public URL in Slack Event Subscriptions:

```text
https://<tunnel-host>/slack/events
```

Do not use `http://localhost:3040/slack/events` in Slack. Slack validates the Request URL from Slack's servers, so the URL must be public HTTPS and must forward to the local Slack ingress port `3040`.

### Local Processes

Start the dispatcher with both GitHub and Slack callback tokens when you want both integrations live:

```bash
OPENTAG_DATABASE_PATH=opentag.github-test.db \
OPENTAG_PAIRING_TOKEN=dev_pairing_token \
OPENTAG_GITHUB_TOKEN=<github-token> \
OPENTAG_SLACK_BOT_TOKEN=<xoxb-token> \
PORT=3031 \
apps/dispatcher/node_modules/.bin/tsx apps/dispatcher/src/index.ts
```

Bind the Slack channel to the repository:

```bash
OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-slack-channels
```

Start Slack ingress:

```bash
SLACK_SIGNING_SECRET=<signing-secret> \
OPENTAG_DISPATCHER_URL=http://localhost:3031 \
OPENTAG_DISPATCHER_TOKEN=dev_pairing_token \
PORT=3040 \
apps/slack-events/node_modules/.bin/tsx apps/slack-events/src/index.ts
```

The daemon process can be the same one already running for GitHub.

### Real Trigger

In the bound channel, post:

```text
@little_pig investigate this
```

Expected result:

- `slack-events` receives `app_mention`
- dispatcher creates a run
- daemon claims and executes the run
- the Slack thread receives:
  - reaction receipt (`eyes`)
  - final result

Routine progress should be visible in dispatcher audit events, not as Slack replies.

### Slack Failure Modes We Hit

- **Request URL pointed at the wrong port**
  We accidentally reused a tunnel that still pointed at `3000` for GitHub, while Slack needed `3040`.

- **`url_verification` returned the wrong shape**
  Slack validation required the raw `challenge` body. Returning a JSON object caused dashboard verification to fail. The correct behavior now lives in `apps/slack-events/src/app.ts`.

- **Channel binding missing**
  Slack requests were accepted but ignored as `unbound_channel` until the dispatcher had a Slack channel binding.

- **Bot token missing on dispatcher**
  Runs executed successfully, but nothing appeared in Slack because the dispatcher callback sink started without `OPENTAG_SLACK_BOT_TOKEN`.

- **Replies show up in the thread, not the main channel stream**
  Slack callback delivery uses `thread_ts`, so the most reliable place to check for bot replies is the message thread you mentioned the bot in.

## Protocol Metrics Checks

Every real smoke test should inspect run metrics:

```bash
curl -H "authorization: Bearer $OPENTAG_PAIRING_TOKEN" \
  http://localhost:3031/v1/runs/<run-id>/metrics
```

Important fields:

- `humanCallbackCount`
- `auditEventCount`
- `threadNoiseRatio`
- `suggestedChangesCount`
- `approvalDecisionCount`
- `applyPlanCount`
- `childRunCount`
- `applyOutcomeCounts`

For Slack, `humanCallbackCount` should normally be `1` for a completed run: the final callback. The source receipt is a reaction, and routine progress stays audit-only. A low `threadNoiseRatio` means OpenTag is recording detail in audit without flooding the human thread.

## Dogfood Trace: Thread-Native Action Loop

Use this trace when validating the model action layer against a real GitHub issue or Slack thread. Record concrete IDs and URLs; do not count the run as complete from local logs alone.

| Step | Evidence to capture |
| --- | --- |
| Mention | Source thread URL and exact mention text |
| Run created | Dispatcher `runId`, source `eventId`, and `run.created` audit event |
| Executor result | Branch name, changed files, executor conditions, optional real verification, and final callback body |
| Suggested action | Rendered `create_pull_request` action with title, head branch, base branch, risks, executor conditions, and optional real verification |
| Approval/apply reply | Source-thread reply text such as `apply 1` and actor identity |
| ApprovalDecision | `approval.decision.recorded` event and selected intent IDs |
| ApplyPlan | `apply_plan.created` event, adapter, selected intent IDs, and preflight outcomes |
| Adapter or setup path | PR URL when applied, or a `Needs setup` / continuation reason when the adapter cannot apply |
| Final callback | Source-thread callback containing the PR URL or child-run continuation context |
| Metrics | `approvalDecisionCount`, `applyPlanCount`, `childRunCount`, and `applyOutcomeCounts` |

Expected GitHub create-PR success shape:

```text
mention -> run -> executor changed files -> final callback with Ready to apply source-thread action receipt
apply 1 -> approval decision -> apply plan -> POST /pulls -> callback with https://github.com/<owner>/<repo>/pull/<number>
```

Expected unavailable-apply shape when the branch is not pushed or the adapter cannot apply:

```text
final callback -> Needs setup or Continue -> no primary Apply button
```

The receipt must explain why direct apply is not possible. A manually typed
`continue 1` can still start a follow-up run when a human explicitly chooses to
carry the proposal context forward.

### Recorded Trace: 2026-06-30 GitHub repository webhook receipt preflight

This trace validated both sides of the source-thread receipt state machine
against the real `amplifthq/opentag-test` repository webhook path.

#### Ready-to-apply path

| Field | Value |
| --- | --- |
| Source issue | `https://github.com/amplifthq/opentag-test/issues/46` |
| Mention comment | `https://github.com/amplifthq/opentag-test/issues/46#issuecomment-4837078185` |
| Apply comment | `https://github.com/amplifthq/opentag-test/issues/46#issuecomment-4837085850` |
| Run ID | `run_afeb0d55-7f40-473e-887d-fb652750881b` |
| Created PR | `https://github.com/amplifthq/opentag-test/pull/47` |
| Head branch | `opentag/run_afeb0d55-7f40-473e-887d-fb652750881b` |
| Base branch | `main` |

Observed behavior:

- The real GitHub issue comment triggered the dispatcher through
  `/github/webhooks`.
- The final GitHub callback rendered `### Ready to apply`.
- The real `apply 1` reply created an `ApprovalDecision` and `ApplyPlan`.
- The GitHub adapter created PR #47.
- The apply receipt included `Applied:` and the created PR URL.

Observed metrics after apply:

```json
{
  "approvalDecisionCount": 1,
  "applyPlanCount": 1,
  "childRunCount": 0,
  "applyOutcomeCounts": {
    "applied": 1,
    "failed": 0,
    "skipped": 0,
    "stale": 0,
    "unsupported": 0
  },
  "suggestedChangesCount": 3,
  "threadNoiseRatio": 0.2857142857142857
}
```

#### Missing-apply-token path

| Field | Value |
| --- | --- |
| Source issue | `https://github.com/amplifthq/opentag-test/issues/48` |
| Mention comment | `https://github.com/amplifthq/opentag-test/issues/48#issuecomment-4837099441` |
| Run ID | `run_08c68db8-36d0-44ba-8f06-954ecb40b5bc` |
| Head branch | `opentag/run_08c68db8-36d0-44ba-8f06-954ecb40b5bc` |

Command shape:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN=true \
scripts/dev/run-github-webhook-live-test.sh
```

Observed behavior:

- GitHub callbacks still worked because the callback token remained configured.
- Dispatcher direct apply was unavailable because the apply token was disabled.
- The final GitHub callback rendered `### Needs setup`.
- The receipt did not advertise `apply 1` as an available command.
- No approval decision, apply plan, child run, or external write was created.

Observed metrics:

```json
{
  "approvalDecisionCount": 0,
  "applyPlanCount": 0,
  "childRunCount": 0,
  "applyOutcomeCounts": {
    "applied": 0,
    "failed": 0,
    "skipped": 0,
    "stale": 0,
    "unsupported": 0
  },
  "suggestedChangesCount": 3,
  "threadNoiseRatio": 0.25
}
```

Repository cleanup:

- Temporary repository webhook `647717865` was deleted by the ready-to-apply run.
- Temporary repository webhook `647718589` was deleted by the missing-apply-token
  run.
- The live script removed temporary config files after each run because they
  contain local credentials.

### Recorded Trace: 2026-06-30 GitHub repository webhook `create_pull_request`

This trace validated the repository-webhook path against the real
`amplifthq/opentag-test` repository. Unlike the CLI-assisted smoke test, both
the initial mention and `apply 1` reply entered through the real GitHub
repository webhook listener.

| Field | Value |
| --- | --- |
| Source issue | `https://github.com/amplifthq/opentag-test/issues/44` |
| Mention comment | `https://github.com/amplifthq/opentag-test/issues/44#issuecomment-4836858128` |
| Apply comment | `https://github.com/amplifthq/opentag-test/issues/44#issuecomment-4836863316` |
| Run ID | `run_5384bdb9-9b6e-4639-94f4-2b2055be6e56` |
| Proposal ID | `proposal_run_5384bdb9-9b6e-4639-94f4-2b2055be6e56` |
| Applied intent | `proposal_run_5384bdb9-9b6e-4639-94f4-2b2055be6e56_create_pr` |
| Approval ID | `approval_github_comment_4836863316` |
| ApplyPlan ID | `apply_ef9146b4f45d` |
| Created PR | `https://github.com/amplifthq/opentag-test/pull/45` |
| Head branch | `opentag/run_5384bdb9-9b6e-4639-94f4-2b2055be6e56` |
| Base branch | `main` |

Command shape:

```bash
OPENTAG_GH_LIVE_KILL_PORTS=true \
scripts/dev/run-github-webhook-live-test.sh
```

Observed source-thread callbacks:

- Mention comment: `@opentag run Add one short sentence to README.md saying GitHub can trigger local Claude Code through OpenTag. Keep the change small and do not modify anything else.`
- Final run callback rendered a source-thread action receipt with `apply 1`
  available for the create-PR action.
- Real `apply 1` issue comment returned `Applied: Create a pull request for branch opentag/run_5384bdb9-9b6e-4639-94f4-2b2055be6e56.` plus the PR URL.

Observed metrics after apply:

```json
{
  "approvalDecisionCount": 1,
  "applyPlanCount": 1,
  "childRunCount": 0,
  "applyOutcomeCounts": {
    "applied": 1,
    "skipped": 0,
    "failed": 0,
    "stale": 0,
    "unsupported": 0
  },
  "suggestedChangesCount": 3,
  "threadNoiseRatio": 0.2857142857142857
}
```

Repository cleanup:

- Temporary repository webhook `647712049` was deleted by the script.
- `gh api repos/amplifthq/opentag-test/hooks` returned `[]` after cleanup.

### Recorded Trace: 2026-06-27 GitHub `create_pull_request`

This trace validated the thread-native PR flow against the real `amplifthq/opentag-test` repository.

| Field | Value |
| --- | --- |
| Source issue | `https://github.com/amplifthq/opentag-test/issues/20` |
| Run ID | `run_gh_claude_1782542192` |
| Proposal ID | `proposal_run_gh_claude_1782542192` |
| Applied intent | `proposal_run_gh_claude_1782542192_create_pr` |
| Approval ID | `approval_a1a014f1213d` |
| ApplyPlan ID | `apply_a7fa7b1514ac` |
| Created PR | `https://github.com/amplifthq/opentag-test/pull/21` |
| Head branch | `opentag/run_gh_claude_1782542192` |
| Base branch | `main` |

Command shape:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_WORKSPACE_PATH=/tmp/opentag-dogfood-worktree \
OPENTAG_GH_TEST_ISSUE=20 \
OPENTAG_DATABASE_PATH=/tmp/opentag-dogfood-action-loop.db \
OPENTAG_GH_PREPARE_PR_BRANCH=true \
OPENTAG_GH_APPLY_PR_ACTION=true \
scripts/dev/run-gh-claude-local-test.sh
```

Observed source-thread callbacks:

- Final run callback rendered Suggested action `1. Create a pull request for branch opentag/run_gh_claude_1782542192.`
- The rendered action included title `OpenTag run run_gh_claude_1782542192`, branch `opentag/run_gh_claude_1782542192 -> main`, changed file `README.md`, risk note, and executor condition `isolated branch exists`.
- The automatic `apply 1` thread action returned a final callback with `proposal_run_gh_claude_1782542192_create_pr: applied (https://github.com/amplifthq/opentag-test/pull/21)`.

Observed audit events:

- `proposal.snapshot.created`
- `approval.decision.recorded`
- `apply_plan.created`
- `apply_plan.executed`
- final callback delivery for the PR URL

Observed ApplyPlan outcome:

```json
{
  "adapter": "github",
  "selectedIntentIds": ["proposal_run_gh_claude_1782542192_create_pr"],
  "outcomes": [
    {
      "intentId": "proposal_run_gh_claude_1782542192_create_pr",
      "outcome": "applied",
      "externalUri": "https://github.com/amplifthq/opentag-test/pull/21"
    }
  ]
}
```

### Recorded Trace: 2026-06-27 GitHub App ingress `create_pull_request`

This trace validated the same action loop through a real GitHub App
`issue_comment.created` webhook delivered to Probot through the public webhook
URL. Unlike the script-assisted trace above, the source-thread `apply 1` reply
also entered through the GitHub App webhook.

| Field | Value |
| --- | --- |
| Source issue | `https://github.com/amplifthq/opentag-test/issues/24` |
| Mention comment | `https://github.com/amplifthq/opentag-test/issues/24#issuecomment-4816025393` |
| Apply comment | `https://github.com/amplifthq/opentag-test/issues/24#issuecomment-4816029160` |
| Run ID | `run_1782548134282` |
| Proposal ID | `proposal_run_1782548134282` |
| Applied intent | `proposal_run_1782548134282_create_pr` |
| Approval ID | `approval_github_comment_4816029160` |
| ApplyPlan ID | `apply_023a7401d573` |
| Created PR | `https://github.com/amplifthq/opentag-test/pull/25` |
| Head branch | `opentag/run_1782548134282` |
| Base branch | `main` |

Observed source-thread callbacks:

- Acknowledgement: `OpenTag picked this up. Run: run_1782548134282`.
- Final run callback rendered Suggested action `1. Create a pull request for branch opentag/run_1782548134282.`
- The rendered action included title `OpenTag run run_1782548134282`, branch `opentag/run_1782548134282 -> main`, changed file `README.md`, risk note, and executor condition `isolated branch exists`.
- The real `apply 1` issue comment returned a final callback with `proposal_run_1782548134282_create_pr: applied (https://github.com/amplifthq/opentag-test/pull/25)`.

Observed thread identity:

```text
proposal_run_1782548134282 | run_1782548134282 |
thread_github_amplifthq/opentag-test#24_amplifthq/opentag-test#24 |
primaryAnchor.threadKey=amplifthq/opentag-test#24 |
workItemReference.externalId=amplifthq/opentag-test#24
```

The issue-scoped thread key matters: source-thread approvals should not share a
repo-wide action namespace across unrelated issues.

Observed audit events:

- `context_packet.generated`
- `run.created`
- `run.claimed`
- `proposal.snapshot.created`
- `run.completed`
- `approval.decision.recorded`
- `apply_plan.created`
- `apply_plan.executed`
- final callback delivery for the PR URL

Observed ApprovalDecision:

```json
{
  "id": "approval_github_comment_4816029160",
  "proposalId": "proposal_run_1782548134282",
  "approvedIntentIds": ["proposal_run_1782548134282_create_pr"],
  "approvedBy": {
    "provider": "github",
    "handle": "mingyooagi"
  },
  "metadata": {
    "source": "thread_action",
    "rawText": "apply 1",
    "callback": {
      "provider": "github",
      "threadKey": "amplifthq/opentag-test#24"
    }
  }
}
```

Observed ApplyPlan outcome:

```json
{
  "id": "apply_023a7401d573",
  "proposalId": "proposal_run_1782548134282",
  "approvalDecisionId": "approval_github_comment_4816029160",
  "selectedIntentIds": ["proposal_run_1782548134282_create_pr"],
  "adapter": "github",
  "outcomes": [
    {
      "intentId": "proposal_run_1782548134282_create_pr",
      "outcome": "applied",
      "externalUri": "https://github.com/amplifthq/opentag-test/pull/25"
    }
  ]
}
```

Dogfood findings fixed from this trace:

- GitHub issue mentions now use issue-scoped callback thread keys such as `owner/repo#24`, matching the thread action replies submitted by Probot.
- If preparing the PR action branch fails after the executor finishes, the daemon completes the run with a `needs_human` result instead of crashing and leaving a stale running lease.

### Recorded Trace: 2026-06-27 Slack `create_pull_request`

This trace validated the same thread-native PR flow from a real Slack thread into the real `amplifthq/opentag-test` repository. It also verifies that repo-level `create_pull_request` intents from Slack are applied through the GitHub adapter instead of being trapped behind the Slack source adapter.

| Field | Value |
| --- | --- |
| Source thread | Slack `T098U4EM971/C0BCC83S54P/1782543299.304939` |
| Run ID | `run_slack_claude_real_1782543299` |
| Proposal ID | `proposal_run_slack_claude_real_1782543299` |
| Applied intent | `proposal_run_slack_claude_real_1782543299_create_pr` |
| Approval ID | `approval_2d103709b771` |
| ApplyPlan ID | `apply_092634c6720a` |
| ApplyPlan adapter | `github` |
| Created PR | `https://github.com/amplifthq/opentag-test/pull/22` |
| Head branch | `opentag/run_slack_claude_real_1782543299` |
| Base branch | `main` |

Command shape:

```bash
OPENTAG_ENV_FILE=/absolute/path/to/opentag/.env.slack-test \
OPENTAG_DATABASE_PATH=/tmp/opentag-slack-action-loop-3.db \
OPENTAG_SLACK_APPLY_PR_ACTION=true \
scripts/dev/run-slack-claude-local-test.sh
```

Observed Slack thread callbacks:

- Final run callback rendered Suggested action `1. Create a pull request for branch opentag/run_slack_claude_real_1782543299.`
- The rendered action included title `OpenTag run run_slack_claude_real_1782543299`, branch `opentag/run_slack_claude_real_1782543299 -> main`, changed file `README.md`, risk note, and executor condition `isolated branch exists`.
- The `apply 1` thread action returned a final Slack callback with `proposal_run_slack_claude_real_1782543299_create_pr: applied (https://github.com/amplifthq/opentag-test/pull/22)`.

Observed metrics:

```json
{
  "suggestedChangesCount": 3,
  "approvalDecisionCount": 1,
  "applyPlanCount": 1,
  "childRunCount": 0,
  "applyOutcomeCounts": { "applied": 1, "skipped": 0, "failed": 0, "stale": 0, "unsupported": 0 }
}
```

Observed audit events:

- `proposal.snapshot.created`
- `approval.decision.recorded`
- `apply_plan.created`
- `apply_plan.executed`
- final callback delivery for the PR URL

## Debugging Order

When something is broken, debug in this order:

1. **Public tunnel**
   Confirm it points at the right local port.
2. **Ingress health**
   Confirm the ingress process is listening locally.
3. **Platform handshake**
   GitHub webhook delivery or Slack `url_verification` must succeed first.
4. **Binding**
   Confirm repository binding or Slack channel binding exists in the dispatcher.
5. **Run creation**
   Confirm the dispatcher recorded `run.created`.
6. **Claim and execution**
   Confirm the daemon recorded `run.claimed`, `run.running`, `run.completed`.
7. **Callback token**
   Confirm the dispatcher was started with the right token for the platform being tested.

## Recommendation

For real integration work, keep two separate public tunnels or be deliberate about switching one tunnel between GitHub and Slack. Reusing the same public hostname across both ports is possible, but it is an easy way to lose half an hour to the wrong endpoint.

## Combined GitHub + Slack + Claude Code Stack

After the individual GitHub and Slack paths work, you can run both ingress services against one local Claude Code daemon:

```bash
OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
OPENTAG_GITHUB_TOKEN=<github-token> \
OPENTAG_SLACK_BOT_TOKEN=<xoxb-token> \
SLACK_SIGNING_SECRET=<signing-secret> \
APP_ID=<github-app-id> \
WEBHOOK_SECRET=<github-webhook-secret> \
PRIVATE_KEY_PATH=/absolute/path/to/github-app.private-key.pem \
scripts/dev/start-github-slack-claude-test.sh
```

The config file should bind the target repository and Slack channel, and the repository binding should use `"defaultExecutor": "claude-code"`.

Use `scripts/dev/run-gh-claude-local-test.sh` and `scripts/dev/run-slack-claude-local-test.sh` first. They are easier to debug because they do not require public webhook tunnels. Use the combined stack once both assisted paths work.
