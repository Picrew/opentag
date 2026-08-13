#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

: "${OPENTAG_CONFIG_PATH:?Set OPENTAG_CONFIG_PATH to your local runner config JSON}"
: "${OPENTAG_GITHUB_TOKEN:?Set OPENTAG_GITHUB_TOKEN for GitHub direct apply}"
: "${OPENTAG_PAIRING_TOKEN:=dev_pairing_token}"
: "${OPENTAG_DISPATCHER_PORT:=3031}"
: "${OPENTAG_GITHUB_PORT:=3000}"
: "${APP_ID:?Set APP_ID to the GitHub App ID}"
: "${WEBHOOK_SECRET:?Set WEBHOOK_SECRET to the GitHub App webhook secret}"
: "${PRIVATE_KEY_PATH:?Set PRIVATE_KEY_PATH to the GitHub App private key path}"

cd "$ROOT_DIR"

echo "Starting dispatcher on :$OPENTAG_DISPATCHER_PORT"
(
  export PORT="$OPENTAG_DISPATCHER_PORT"
  export OPENTAG_DATABASE_PATH="${OPENTAG_DATABASE_PATH:-opentag.github-test.db}"
  export OPENTAG_PAIRING_TOKEN
  export OPENTAG_GITHUB_TOKEN
  apps/dispatcher/node_modules/.bin/tsx apps/dispatcher/src/index.ts
) &
DISPATCHER_PID=$!

trap 'kill $DISPATCHER_PID $DAEMON_PID $PROBOT_PID 2>/dev/null || true' EXIT

sleep 2

echo "Registering runner and binding repository"
export OPENTAG_CONFIG_PATH
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts register-runner
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-repos

echo "Starting local daemon"
(
  export OPENTAG_CONFIG_PATH
  apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts serve
) &
DAEMON_PID=$!

echo "Starting Probot ingress on :$OPENTAG_GITHUB_PORT"
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

echo
echo "GitHub smoke-test stack is running."
echo "- Dispatcher: http://localhost:$OPENTAG_DISPATCHER_PORT"
echo "- Probot: http://localhost:$OPENTAG_GITHUB_PORT"
echo "- Remember to expose port $OPENTAG_GITHUB_PORT with ngrok and point your GitHub App webhook to /github/webhooks"
echo
wait
