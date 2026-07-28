#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${OPENTAG_SLACK_LINEAR_SLACK_ENV_FILE:=$ROOT_DIR/.env.slack-test}"
: "${OPENTAG_SLACK_LINEAR_LINEAR_ENV_FILE:=$ROOT_DIR/.env.linear}"

load_env_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing live acceptance env file: $path" >&2
    exit 1
  fi
  echo "Loading live acceptance env: $path"
  set -a
  # shellcheck disable=SC1090
  source "$path"
  set +a
}

load_env_file "$OPENTAG_SLACK_LINEAR_SLACK_ENV_FILE"
load_env_file "$OPENTAG_SLACK_LINEAR_LINEAR_ENV_FILE"

: "${OPENTAG_CONFIG_PATH:?Set OPENTAG_CONFIG_PATH in the Slack env file.}"
: "${OPENTAG_SLACK_BOT_TOKEN:?Set OPENTAG_SLACK_BOT_TOKEN in the Slack env file.}"
: "${OPENTAG_SLACK_APP_TOKEN:?Set OPENTAG_SLACK_APP_TOKEN in the Slack env file for real Socket Mode delivery.}"
: "${OPENTAG_LINEAR_SMOKE_TOKEN:?Set a currently valid OPENTAG_LINEAR_SMOKE_TOKEN in the Linear env file.}"
if [[ -z "${OPENTAG_LINEAR_SMOKE_ISSUE:-${OPENTAG_LINEAR_SMOKE_ISSUE_ID:-}}" ]]; then
  echo "Set OPENTAG_LINEAR_SMOKE_ISSUE or OPENTAG_LINEAR_SMOKE_ISSUE_ID in the Linear env file." >&2
  exit 1
fi

cd "$ROOT_DIR"
exec node --import ./apps/dispatcher/node_modules/tsx/dist/loader.mjs scripts/dev/run-slack-linear-backlog-live-test.ts
