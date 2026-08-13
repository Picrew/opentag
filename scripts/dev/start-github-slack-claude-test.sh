#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

: "${OPENTAG_CONFIG_PATH:?Set OPENTAG_CONFIG_PATH to your local runner config JSON with defaultExecutor set to claude-code}"
: "${OPENTAG_GITHUB_TOKEN:?Set OPENTAG_GITHUB_TOKEN for GitHub callbacks and apply execution}"
: "${SLACK_SIGNING_SECRET:?Set SLACK_SIGNING_SECRET from your Slack App}"
: "${OPENTAG_SLACK_BOT_TOKEN:?Set OPENTAG_SLACK_BOT_TOKEN to the Slack xoxb token}"
: "${APP_ID:?Set APP_ID to the GitHub App ID}"
: "${WEBHOOK_SECRET:?Set WEBHOOK_SECRET to the GitHub App webhook secret}"
: "${PRIVATE_KEY_PATH:?Set PRIVATE_KEY_PATH to the GitHub App private key path}"
: "${OPENTAG_PAIRING_TOKEN:=dev_pairing_token}"
: "${OPENTAG_DISPATCHER_PORT:=3031}"
: "${OPENTAG_GITHUB_PORT:=3000}"
: "${OPENTAG_SLACK_PORT:=3040}"

cd "$ROOT_DIR"

echo "Starting dispatcher on :$OPENTAG_DISPATCHER_PORT"
(
  export PORT="$OPENTAG_DISPATCHER_PORT"
  export OPENTAG_DATABASE_PATH="${OPENTAG_DATABASE_PATH:-opentag.claude-real-test.db}"
  export OPENTAG_PAIRING_TOKEN
  export OPENTAG_GITHUB_TOKEN
  export OPENTAG_SLACK_BOT_TOKEN
  apps/dispatcher/node_modules/.bin/tsx apps/dispatcher/src/index.ts
) &
DISPATCHER_PID=$!
DAEMON_PID=""
PROBOT_PID=""
SLACK_PID=""

cleanup() {
  for pid in "$DISPATCHER_PID" "$DAEMON_PID" "$PROBOT_PID" "$SLACK_PID"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

sleep 2

echo "Registering runner, binding repositories, and binding Slack channels"
export OPENTAG_CONFIG_PATH
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts register-runner
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-repos
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-slack-channels

echo "Starting local daemon with configured Claude Code executor"
(
  export OPENTAG_CONFIG_PATH
  apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts serve
) &
DAEMON_PID=$!

echo "Starting GitHub Probot ingress on :$OPENTAG_GITHUB_PORT"
(
  export APP_ID
  export WEBHOOK_SECRET
  export PRIVATE_KEY_PATH
  export PORT="$OPENTAG_GITHUB_PORT"
  export WEBHOOK_PATH="${WEBHOOK_PATH:-/github/webhooks}"
  export OPENTAG_DISPATCHER_URL="http://localhost:$OPENTAG_DISPATCHER_PORT"
  export OPENTAG_DISPATCHER_TOKEN="$OPENTAG_PAIRING_TOKEN"
  pnpm --filter @opentag/github-probot exec probot run ./dist/index.js
) &
PROBOT_PID=$!

echo "Starting Slack Events ingress on :$OPENTAG_SLACK_PORT"
(
  export SLACK_SIGNING_SECRET
  export OPENTAG_DISPATCHER_URL="http://localhost:$OPENTAG_DISPATCHER_PORT"
  export OPENTAG_DISPATCHER_TOKEN="$OPENTAG_PAIRING_TOKEN"
  export PORT="$OPENTAG_SLACK_PORT"
  apps/slack-events/node_modules/.bin/tsx apps/slack-events/src/index.ts
) &
SLACK_PID=$!

echo
echo "GitHub + Slack + Claude Code smoke-test stack is running."
echo "- Dispatcher: http://localhost:$OPENTAG_DISPATCHER_PORT"
echo "- GitHub Probot ingress: http://localhost:$OPENTAG_GITHUB_PORT/github/webhooks"
echo "- Slack Events ingress: http://localhost:$OPENTAG_SLACK_PORT/slack/events"
echo "- Expose GitHub and Slack ingress ports with public tunnels."
echo "- Ensure your config repository binding uses \"defaultExecutor\": \"claude-code\"."
echo
wait
