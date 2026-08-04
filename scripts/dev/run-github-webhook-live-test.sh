#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Script failed at line $LINENO." >&2' ERR

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'EOF'
Run a real GitHub repository-webhook OpenTag dogfood session.

This starts the local OpenTag CLI stack, exposes the GitHub webhook listener
through ngrok, creates a temporary repository webhook, posts a real GitHub issue
comment, waits for OpenTag to finish, and by default proves strict PR/check/merge
completion with a durable restart. Disable strict mode only to exercise the
older optional `apply 1` compatibility path.

Required:
  gh CLI authenticated as a user with admin access to the target repository.
  The selected built-in ACP agent command is installed and authenticated; Claude Code uses npx by default.
  ngrok installed when OPENTAG_GH_LIVE_START_NGROK=true.

Helpful env:
  OPENTAG_GH_REPO                 owner/repo, default amplifthq/opentag-test
  OPENTAG_GH_PUBLIC_URL           fixed public tunnel URL, if already running
  OPENTAG_GH_LIVE_COMMAND         prompt after `@opentag run`
  OPENTAG_GH_LIVE_EXECUTOR        built-in ACP agent, default claude-code; use
                                     phase1-fixture for the deterministic
                                     repository-writing ACP fixture
  OPENTAG_GH_LIVE_APPLY           true/false, default true
  OPENTAG_GH_LIVE_STRICT_COMPLETION
                                     true/false, default true. Enables the
                                     Phase 1 PR/check/merge completion policy,
                                     creates the PR during the run, records a
                                     real commit status, merges the PR, and
                                     verifies restart-safe completion.
  OPENTAG_GH_LIVE_REQUIRED_CHECK  required commit-status context, default
                                     opentag-phase1-live
  OPENTAG_GH_LIVE_FACTORY         true/false, default false. Routes one real
                                     GitHub issue comment through WorkThread
                                     ensure, recipe, workstream, and durable
                                     batch admission before local execution.
  OPENTAG_GH_LIVE_REASSESSMENT_CRASH
                                     true/false, default false. Holds the
                                     obligation worker until real merge evidence
                                     is durably committed, terminates the first
                                     stack, then proves restart-only recovery.
  OPENTAG_GH_LIVE_REPORT          optional structured evidence JSON path
  OPENTAG_GH_LIVE_CLI_BIN         optional installed `opentag` executable;
                                     defaults to the source CLI through tsx
  OPENTAG_GH_LIVE_EXPECTED_CLI_VERSION
                                     required with OPENTAG_GH_LIVE_CLI_BIN;
                                     binds the executable and npm lockfile
                                     integrity to the retained report
  OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN
                                     true/false, default false. Keeps GitHub
                                     callbacks working but verifies Needs setup
                                     when direct apply is unavailable.
  OPENTAG_GH_LIVE_KEEP_WEBHOOK    true/false, default false
  OPENTAG_GH_LIVE_KILL_PORTS      true/false, default false

Example:
  OPENTAG_GH_REPO=amplifthq/opentag-test \
    scripts/dev/run-github-webhook-live-test.sh
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

: "${OPENTAG_PAIRING_TOKEN:=dev_pairing_token}"
: "${OPENTAG_DISPATCHER_PORT:=3033}"
: "${OPENTAG_GITHUB_PORT:=3050}"
: "${OPENTAG_RUNNER_ID:=runner_github_webhook_live}"
: "${OPENTAG_GH_REPO:=amplifthq/opentag-test}"
: "${OPENTAG_GH_LIVE_START_NGROK:=true}"
: "${OPENTAG_GH_LIVE_APPLY:=true}"
: "${OPENTAG_GH_LIVE_TIMEOUT_SECONDS:=900}"
: "${OPENTAG_GH_LIVE_COMMAND:=Add one short sentence to README.md saying GitHub can trigger local Claude Code through OpenTag. Keep the change small and do not modify anything else.}"
: "${OPENTAG_GH_LIVE_EXECUTOR:=claude-code}"
: "${OPENTAG_GH_LIVE_KEEP_WEBHOOK:=false}"
: "${OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN:=false}"
: "${OPENTAG_GH_LIVE_STRICT_COMPLETION:=true}"
: "${OPENTAG_GH_LIVE_REQUIRED_CHECK:=opentag-phase1-live}"
: "${OPENTAG_GH_LIVE_FACTORY:=false}"
: "${OPENTAG_GH_LIVE_REASSESSMENT_CRASH:=false}"

cd "$ROOT_DIR"

CLI_PID=""
NGROK_PID=""
TMP_ROOT=""
CONFIG_PATH=""
DATABASE_PATH=""
NGROK_LOG=""
HOOK_ID=""
ISSUE_NUMBER=""
PUBLIC_URL=""
PR_URL=""
PR_NUMBER=""
PR_HEAD_SHA=""
COMPLETION_PAYLOAD=""
REPORT_PATH=""
MENTION_URL=""
COMMENT_ID=""
EVENT_ID=""
EVENT_PATH=""
WORK_THREAD_ID=""
RECIPE_ID=""
WORKSTREAM_ID=""
BATCH_ID=""
BATCH_INPUT_DIGEST=""
INITIAL_BATCH_RECEIPT_PATH=""
REPLAYED_BATCH_RECEIPT_PATH=""
RUNTIME_ARTIFACT_PATH=""
REASSESSMENT_HOLD_ACTIVE="false"
REASSESSMENT_OBLIGATION_BEFORE_CRASH_PATH=""
REASSESSMENT_OBLIGATION_AFTER_RESTART_PATH=""
ASSESSMENT_COUNT_BEFORE_CRASH=""
ASSESSMENT_COUNT_AFTER_RECOVERY=""
ASSESSMENT_COUNT_AFTER_SECOND_RESTART=""
EVIDENCE_RECORD_COUNT_BEFORE_CRASH=""
EVIDENCE_RECORD_COUNT_AFTER_RECOVERY=""

bool_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

sqlite_one() {
  sqlite3 -cmd ".timeout 5000" -noheader "$DATABASE_PATH" "$1" 2>/dev/null || true
}

kill_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "$HOOK_ID" ]] && ! bool_true "$OPENTAG_GH_LIVE_KEEP_WEBHOOK"; then
    echo "Deleting temporary GitHub webhook $HOOK_ID..."
    gh api "repos/${OWNER}/${REPO}/hooks/${HOOK_ID}" --method DELETE >/dev/null 2>&1 || true
  fi

  kill_pid "$CLI_PID"
  kill_pid "$NGROK_PID"

  if [[ -n "$CONFIG_PATH" && -f "$CONFIG_PATH" ]]; then
    rm -f "$CONFIG_PATH"
  fi

  if [[ -n "$TMP_ROOT" ]]; then
    echo "Preserved temp root: $TMP_ROOT"
    echo "Removed temporary config file because it contains local credentials."
  fi
  if [[ -n "$DATABASE_PATH" ]]; then
    echo "Dispatcher DB: $DATABASE_PATH"
  fi
  if [[ -n "$ISSUE_NUMBER" ]]; then
    echo "Issue: https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}"
  fi

  exit "$status"
}
trap cleanup EXIT INT TERM

require_cmd curl
require_cmd corepack
require_cmd gh
require_cmd git
require_cmd lsof
require_cmd node
require_cmd python3
require_cmd sqlite3
if bool_true "$OPENTAG_GH_LIVE_START_NGROK"; then
  require_cmd ngrok
fi

OWNER="${OPENTAG_GH_REPO%%/*}"
REPO="${OPENTAG_GH_REPO#*/}"
if [[ -z "$OWNER" || -z "$REPO" || "$OWNER" == "$REPO" ]]; then
  echo "OPENTAG_GH_REPO must be owner/repo." >&2
  exit 1
fi
export OWNER REPO

PERMISSION="$(gh repo view "$OWNER/$REPO" --json viewerPermission --jq '.viewerPermission')"
if [[ "$PERMISSION" != "ADMIN" && "$PERMISSION" != "MAINTAIN" ]]; then
  echo "GitHub repository webhook creation requires ADMIN or MAINTAIN access; current permission is $PERMISSION." >&2
  exit 1
fi
GITHUB_TOKEN="$(gh auth token)"
export GITHUB_TOKEN
export OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN OPENTAG_GH_LIVE_STRICT_COMPLETION OPENTAG_GH_LIVE_REQUIRED_CHECK OPENTAG_GH_LIVE_FACTORY OPENTAG_GH_LIVE_REASSESSMENT_CRASH

if bool_true "$OPENTAG_GH_LIVE_FACTORY" && ! bool_true "$OPENTAG_GH_LIVE_STRICT_COMPLETION"; then
  echo "Factory acceptance requires OPENTAG_GH_LIVE_STRICT_COMPLETION=true." >&2
  exit 1
fi
if bool_true "$OPENTAG_GH_LIVE_REASSESSMENT_CRASH" && ! bool_true "$OPENTAG_GH_LIVE_FACTORY"; then
  echo "Reassessment crash acceptance requires OPENTAG_GH_LIVE_FACTORY=true." >&2
  exit 1
fi
if bool_true "$OPENTAG_GH_LIVE_FACTORY" && ! bool_true "$OPENTAG_GH_LIVE_REASSESSMENT_CRASH"; then
  echo "Factory acceptance requires OPENTAG_GH_LIVE_REASSESSMENT_CRASH=true." >&2
  exit 1
fi

if bool_true "$OPENTAG_GH_LIVE_STRICT_COMPLETION"; then
  if [[ "$OPENTAG_GH_LIVE_EXECUTOR" == "echo" ]]; then
    echo "Strict completion requires an executor that can create a real repository change." >&2
    exit 1
  fi
  if [[ -z "${OPENTAG_GH_LIVE_REQUIRED_CHECK// }" ]]; then
    echo "OPENTAG_GH_LIVE_REQUIRED_CHECK must be non-empty in strict completion mode." >&2
    exit 1
  fi
  if bool_true "$OPENTAG_GH_LIVE_APPLY"; then
    echo "Strict completion creates the pull request during the run; disabling the later apply-comment path."
    OPENTAG_GH_LIVE_APPLY=false
  fi
fi

if bool_true "$OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN" && bool_true "$OPENTAG_GH_LIVE_APPLY"; then
  echo "GitHub apply token is disabled for this run; skipping apply-comment execution and expecting Needs setup."
  OPENTAG_GH_LIVE_APPLY=false
fi

TMP_ROOT="$(mktemp -d /tmp/opentag-gh-webhook-live.XXXXXX)"
CONFIG_PATH="$TMP_ROOT/opentag-github-webhook-live.config.json"
DATABASE_PATH="${OPENTAG_DATABASE_PATH:-$TMP_ROOT/opentag-github-webhook-live.db}"
CHECKOUT_PATH="${OPENTAG_WORKSPACE_PATH:-$TMP_ROOT/$REPO}"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
STATE_DIR="$TMP_ROOT/state"
NGROK_LOG="$TMP_ROOT/ngrok.log"
WEBHOOK_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
BASE_BRANCH="${OPENTAG_BASE_BRANCH:-main}"
PUSH_REMOTE="${OPENTAG_PUSH_REMOTE:-origin}"
export CHECKOUT_PATH WORKTREE_ROOT STATE_DIR CONFIG_PATH DATABASE_PATH WEBHOOK_SECRET BASE_BRANCH PUSH_REMOTE
export OPENTAG_PAIRING_TOKEN OPENTAG_DISPATCHER_PORT OPENTAG_GITHUB_PORT OPENTAG_RUNNER_ID
export OPENTAG_GH_LIVE_EXECUTOR ROOT_DIR

ensure_port_free() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  if bool_true "${OPENTAG_GH_LIVE_KILL_PORTS:-false}"; then
    echo "Killing existing $label process(es) on :$port: $pids"
    for pid in $pids; do
      kill "$pid" 2>/dev/null || true
    done
    sleep 1
    return 0
  fi
  echo "Port :$port is already in use by: $pids" >&2
  echo "Stop that process or rerun with OPENTAG_GH_LIVE_KILL_PORTS=true." >&2
  exit 1
}

wait_for_http() {
  local url="$1"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $url." >&2
  exit 1
}

wait_for_github_ingress() {
  local deadline=$((SECONDS + 60))
  local code
  while (( SECONDS < deadline )); do
    code="$(curl -sS -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${OPENTAG_GITHUB_PORT}/github/webhooks" -H "content-type: application/json" --data '{}' || true)"
    if [[ "$code" == "401" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for local GitHub ingress on :${OPENTAG_GITHUB_PORT}." >&2
  exit 1
}

ngrok_url_for_port() {
  local port="$1"
  python3 - "$port" <<'PY' 2>/dev/null || true
import json
import sys
import urllib.request

port = sys.argv[1]
with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as resp:
    payload = json.loads(resp.read())
for tunnel in payload.get("tunnels", []):
    public_url = tunnel.get("public_url", "")
    addr = str(tunnel.get("config", {}).get("addr", ""))
    if public_url.startswith("https://") and (addr.endswith(":" + port) or addr.endswith("//localhost:" + port) or addr.endswith("//127.0.0.1:" + port)):
        print(public_url.rstrip("/"))
        break
PY
}

wait_for_ngrok_url() {
  local port="$1"
  local deadline=$((SECONDS + 45))
  local url=""
  while (( SECONDS < deadline )); do
    url="$(ngrok_url_for_port "$port")"
    if [[ -n "$url" ]]; then
      printf "%s" "$url"
      return 0
    fi
    sleep 1
  done
  echo "ngrok did not expose an HTTPS tunnel for port $port." >&2
  if [[ -n "$NGROK_LOG" && -f "$NGROK_LOG" ]]; then
    tail -n 80 "$NGROK_LOG" >&2 || true
  fi
  exit 1
}

public_ingress_probe() {
  local public_url="$1"
  local code=""
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    code="$(curl -sS -o "$TMP_ROOT/github-ingress-probe.json" -w "%{http_code}" -X POST "$public_url/github/webhooks" -H "content-type: application/json" --data '{}' || true)"
    if [[ "$code" == "401" ]]; then
      echo "Public GitHub ingress probe reached OpenTag (401 without GitHub signature is expected)."
      return 0
    fi
    sleep 1
  done
  echo "Public GitHub ingress probe returned HTTP ${code:-unknown}, expected 401." >&2
  if [[ -f "$TMP_ROOT/github-ingress-probe.json" ]]; then
    sed -n '1,40p' "$TMP_ROOT/github-ingress-probe.json" >&2 || true
  fi
  exit 1
}

print_metrics() {
  local run_id="$1"
  local payload
  payload="$(curl -fsS -H "authorization: Bearer $OPENTAG_PAIRING_TOKEN" "http://localhost:${OPENTAG_DISPATCHER_PORT}/v1/runs/${run_id}/metrics" || true)"
  if [[ -z "$payload" ]]; then
    echo "Could not fetch run metrics."
    return 0
  fi
  python3 - "$payload" <<'PY' || true
import json
import sys
payload = json.loads(sys.argv[1])
metrics = payload.get("metrics", {})
summary = {
    "humanCallbackCount": metrics.get("humanCallbackCount"),
    "suggestedChangesCount": metrics.get("suggestedChangesCount"),
    "approvalDecisionCount": metrics.get("approvalDecisionCount"),
    "applyPlanCount": metrics.get("applyPlanCount"),
    "childRunCount": metrics.get("childRunCount"),
    "threadNoiseRatio": metrics.get("threadNoiseRatio"),
    "applyOutcomeCounts": metrics.get("applyOutcomeCounts"),
}
print("Run metrics:", json.dumps(summary, sort_keys=True))
PY
}

run_cli() {
  if [[ -n "${OPENTAG_GH_LIVE_CLI_BIN:-}" ]]; then
    "$OPENTAG_GH_LIVE_CLI_BIN" "$@"
  else
    NODE_OPTIONS='--conditions=development' corepack pnpm --dir apps/dispatcher exec tsx ../../packages/cli/src/index.ts "$@"
  fi
}

run_factory_acceptance_tool() {
  NODE_OPTIONS='--conditions=development' corepack pnpm --dir apps/dispatcher exec tsx ../../scripts/test/github-factory-acceptance.ts "$@"
}

run_registry_artifact_tool() {
  corepack pnpm --dir apps/dispatcher exec tsx ../../scripts/test/github-registry-artifact.ts "$@"
}

capture_workstream_metrics() {
  local output_path="$1"
  curl -fsS \
    -H "authorization: Bearer $OPENTAG_PAIRING_TOKEN" \
    -o "$output_path" \
    "http://localhost:${OPENTAG_DISPATCHER_PORT}/v1/workstreams/${WORKSTREAM_ID}/metrics"
  chmod 600 "$output_path"
}

capture_accepted_progress_metrics() {
  local output_path="$1"
  curl -fsS \
    -H "authorization: Bearer $OPENTAG_PAIRING_TOKEN" \
    -o "$output_path" \
    "http://localhost:${OPENTAG_DISPATCHER_PORT}/v1/routing/accepted-progress-metrics"
  chmod 600 "$output_path"
}

completion_payload() {
  local run_id="$1"
  curl -fsS \
    -H "authorization: Bearer $OPENTAG_PAIRING_TOKEN" \
    "http://localhost:${OPENTAG_DISPATCHER_PORT}/v1/runs/${run_id}/completion"
}

wait_for_completion() {
  local run_id="$1"
  local expected_states="$2"
  local gate_id="${3:-}"
  local expected_gate_state="${4:-}"
  local deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
  local payload=""
  while (( SECONDS < deadline )); do
    payload="$(completion_payload "$run_id" 2>/dev/null || true)"
    if [[ -n "$payload" ]]; then
      if python3 -c '
import json
import sys
payload = json.loads(sys.argv[1]).get("completion", {})
expected_states = sys.argv[2].split(",")
if payload.get("completion") not in expected_states:
    raise SystemExit(1)
gate_id = sys.argv[3]
expected_gate_state = sys.argv[4]
if gate_id:
    gates = {gate.get("gateId"): gate.get("state") for gate in payload.get("currentAssessment", {}).get("gateResults", [])}
    if gates.get(gate_id) != expected_gate_state:
        raise SystemExit(1)
' "$payload" "$expected_states" "$gate_id" "$expected_gate_state"; then
        COMPLETION_PAYLOAD="$payload"
        return 0
      fi
    fi
    sleep 2
  done
  echo "Timed out waiting for completion in [$expected_states]${gate_id:+ and $gate_id=$expected_gate_state}." >&2
  if [[ -n "$payload" ]]; then
    python3 -m json.tool <<<"$payload" >&2 || true
  fi
  exit 1
}

wait_for_issue_comment() {
  local pattern="$1"
  local deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if issue_comments_contain "$pattern"; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for GitHub issue comment containing: $pattern" >&2
  exit 1
}

completion_receipt_count() {
  gh api --paginate "repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments" \
    --jq '.[].body' \
    | grep -F -c "provider-verified completion requirements are satisfied" \
    || true
}

stable_completion_receipt_count() {
  local stable_window_seconds="${1:-10}"
  local deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
  local stable_since="$SECONDS"
  local previous_count
  local current_count
  previous_count="$(completion_receipt_count)"
  while (( SECONDS < deadline )); do
    sleep 1
    current_count="$(completion_receipt_count)"
    if [[ "$current_count" != "$previous_count" ]]; then
      previous_count="$current_count"
      stable_since="$SECONDS"
      continue
    fi
    if (( SECONDS - stable_since >= stable_window_seconds )); then
      printf '%s\n' "$current_count"
      return 0
    fi
  done
  echo "Timed out waiting for the provider-verified completion receipt count to stabilize." >&2
  exit 1
}

start_cli_stack() {
  echo "Starting OpenTag CLI stack on dispatcher :${OPENTAG_DISPATCHER_PORT}, GitHub ingress :${OPENTAG_GITHUB_PORT}"
  if [[ -n "${OPENTAG_GH_LIVE_CLI_BIN:-}" ]]; then
    if [[ ! -x "$OPENTAG_GH_LIVE_CLI_BIN" ]]; then
      echo "OPENTAG_GH_LIVE_CLI_BIN is not executable: $OPENTAG_GH_LIVE_CLI_BIN" >&2
      exit 1
    fi
    OPENTAG_REASSESSMENT_OBLIGATION_TEST_HOLD="$REASSESSMENT_HOLD_ACTIVE" \
      "$OPENTAG_GH_LIVE_CLI_BIN" start --config "$CONFIG_PATH" &
  else
    OPENTAG_REASSESSMENT_OBLIGATION_TEST_HOLD="$REASSESSMENT_HOLD_ACTIVE" \
      NODE_OPTIONS='--conditions=development' corepack pnpm --dir apps/dispatcher exec tsx ../../packages/cli/src/index.ts start --config "$CONFIG_PATH" &
  fi
  CLI_PID=$!
  wait_for_http "http://localhost:${OPENTAG_DISPATCHER_PORT}/healthz"
  wait_for_github_ingress
}

stop_cli_stack() {
  kill_pid "$CLI_PID"
  if [[ -n "$CLI_PID" ]]; then
    wait "$CLI_PID" 2>/dev/null || true
  fi
  CLI_PID=""
}

issue_comments_contain() {
  local pattern="$1"
  gh api --paginate "repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments" \
    --jq '.[].body' | grep -F "$pattern" >/dev/null
}

applied_receipt_has_double_period() {
  gh api --paginate "repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments" --jq '
    .[].body
    | split("\n")[]
    | select(startswith("Applied:"))
  ' | grep -E '\.\.$' >/dev/null
}

latest_apply_plan_for_run() {
  local run_id_sql
  run_id_sql="$(sql_escape "$1")"
  sqlite_one "select ap.plan_json from apply_plans ap join suggested_changes sc on sc.proposal_id = ap.proposal_id where sc.run_id = '$run_id_sql' order by ap.created_at desc limit 1;"
}

if [[ ! -d "$CHECKOUT_PATH/.git" ]]; then
  echo "Cloning $OWNER/$REPO into temporary checkout..."
  git \
    -c credential.helper= \
    -c 'credential.helper=!gh auth git-credential' \
    clone --depth=1 "https://github.com/${OWNER}/${REPO}.git" "$CHECKOUT_PATH" >/dev/null
fi
if [[ -n "$(git -C "$CHECKOUT_PATH" status --porcelain)" ]]; then
  echo "Checkout is dirty: $CHECKOUT_PATH" >&2
  exit 1
fi

python3 - <<'PY'
import json
import os
from pathlib import Path

config = {
    "schemaVersion": 1,
    "state": {
        "directory": os.environ["STATE_DIR"],
        "databasePath": os.environ["DATABASE_PATH"],
        "worktreeRoot": os.environ["WORKTREE_ROOT"],
    },
    "preferences": {
        "language": "en",
        "lastSetup": {
            "platforms": ["github"],
            "executor": os.environ["OPENTAG_GH_LIVE_EXECUTOR"],
            "projectPath": os.environ["CHECKOUT_PATH"],
            "githubOwner": os.environ["OWNER"],
            "githubRepo": os.environ["REPO"],
            "githubPort": int(os.environ["OPENTAG_GITHUB_PORT"]),
        },
    },
    "daemon": {
        "runnerId": os.environ["OPENTAG_RUNNER_ID"],
        "dispatcherUrl": f"http://localhost:{os.environ['OPENTAG_DISPATCHER_PORT']}",
        "repositories": [
            {
                "provider": "github",
                "owner": os.environ["OWNER"],
                "repo": os.environ["REPO"],
                "checkoutPath": os.environ["CHECKOUT_PATH"],
                "defaultExecutor": os.environ["OPENTAG_GH_LIVE_EXECUTOR"],
                "baseBranch": os.environ["BASE_BRANCH"],
                "pushRemote": os.environ["PUSH_REMOTE"],
                "worktreeRoot": os.environ["WORKTREE_ROOT"],
                "keepWorktree": "on_failure",
            }
        ],
        **(
            {
                "agents": {
                    "phase1-fixture": {
                        "label": "Phase 1 live deterministic ACP fixture",
                        "command": "node",
                        "args": [
                            os.path.join(
                                os.environ["ROOT_DIR"],
                                "packages/runner/test/fixtures/acp-agent.mjs",
                            ),
                            "success",
                        ],
                        "workspaceCwd": "required",
                        "supportsCancel": True,
                        "readinessTimeoutMs": 30_000,
                    }
                }
            }
            if os.environ["OPENTAG_GH_LIVE_EXECUTOR"] == "phase1-fixture"
            else {}
        ),
        "githubToken": os.environ["GITHUB_TOKEN"],
        **(
            {"githubApplyToken": None}
            if os.environ.get("OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN", "").lower() in {"1", "true", "yes", "y"}
            else {}
        ),
        "preparePullRequestBranch": True,
        **(
            {
                "allowAutoCreatePullRequest": True,
                "completionPolicies": [
                    {
                        "provider": "github",
                        "owner": os.environ["OWNER"],
                        "repo": os.environ["REPO"],
                        "requiredChecks": [os.environ["OPENTAG_GH_LIVE_REQUIRED_CHECK"]],
                        "baseBranch": os.environ["BASE_BRANCH"],
                        "requireMerge": True,
                    }
                ],
            }
            if os.environ.get("OPENTAG_GH_LIVE_STRICT_COMPLETION", "").lower() in {"1", "true", "yes", "y"}
            else {}
        ),
        "pairingToken": os.environ["OPENTAG_PAIRING_TOKEN"],
        "pollIntervalMs": 1000,
        "heartbeatIntervalMs": 15000,
    },
    "platforms": {
        "github": {
            "webhookSecret": os.environ["WEBHOOK_SECRET"],
            "owner": os.environ["OWNER"],
            "repo": os.environ["REPO"],
            "webhookPath": "/github/webhooks",
            "port": int(os.environ["OPENTAG_GITHUB_PORT"]),
        }
    },
}

path = Path(os.environ["CONFIG_PATH"])
path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
path.chmod(0o600)
PY

ensure_port_free "$OPENTAG_DISPATCHER_PORT" "dispatcher"
ensure_port_free "$OPENTAG_GITHUB_PORT" "GitHub ingress"

if [[ -n "${OPENTAG_GH_LIVE_CLI_BIN:-}" ]]; then
  if [[ -z "${OPENTAG_GH_LIVE_EXPECTED_CLI_VERSION:-}" ]]; then
    echo "OPENTAG_GH_LIVE_EXPECTED_CLI_VERSION is required with OPENTAG_GH_LIVE_CLI_BIN." >&2
    exit 1
  fi
  RUNTIME_ARTIFACT_PATH="$TMP_ROOT/registry-runtime-artifact.json"
  run_registry_artifact_tool inspect \
    "$OPENTAG_GH_LIVE_CLI_BIN" \
    "$OPENTAG_GH_LIVE_EXPECTED_CLI_VERSION" \
    "$RUNTIME_ARTIFACT_PATH"
  echo "Verified registry CLI package version and npm lockfile integrity."
fi

start_cli_stack

PUBLIC_URL="${OPENTAG_GH_PUBLIC_URL:-}"
if bool_true "$OPENTAG_GH_LIVE_START_NGROK"; then
  existing_tunnel="$(ngrok_url_for_port "$OPENTAG_GITHUB_PORT")"
  if [[ -n "$existing_tunnel" && -z "$PUBLIC_URL" ]]; then
    PUBLIC_URL="$existing_tunnel"
    echo "Using existing ngrok tunnel for GitHub ingress: $PUBLIC_URL"
  elif [[ -z "$existing_tunnel" ]]; then
    if [[ -n "$(lsof -ti tcp:4040 2>/dev/null || true)" ]]; then
      echo "ngrok API port :4040 is in use, but no tunnel points at :${OPENTAG_GITHUB_PORT}." >&2
      echo "Stop that ngrok process, or set OPENTAG_GH_PUBLIC_URL to a tunnel that points at this GitHub ingress." >&2
      exit 1
    fi
    echo "Starting ngrok for GitHub ingress"
    if [[ -n "$PUBLIC_URL" ]]; then
      ngrok http "$OPENTAG_GITHUB_PORT" --url "${PUBLIC_URL#https://}" --log stdout >"$NGROK_LOG" 2>&1 &
    else
      ngrok http "$OPENTAG_GITHUB_PORT" --log stdout >"$NGROK_LOG" 2>&1 &
    fi
    NGROK_PID=$!
    STARTED_URL="$(wait_for_ngrok_url "$OPENTAG_GITHUB_PORT")"
    if [[ -z "$PUBLIC_URL" ]]; then
      PUBLIC_URL="$STARTED_URL"
    fi
  fi
fi
if [[ -z "$PUBLIC_URL" ]]; then
  echo "Set OPENTAG_GH_PUBLIC_URL or enable OPENTAG_GH_LIVE_START_NGROK=true." >&2
  exit 1
fi
PUBLIC_URL="${PUBLIC_URL%/}"
public_ingress_probe "$PUBLIC_URL"

if bool_true "$OPENTAG_GH_LIVE_FACTORY"; then
  ISSUE_URL="$(gh issue create --repo "${OWNER}/${REPO}" \
    --title "OpenTag GitHub factory live acceptance" \
    --body "External planning source for one recipe-driven OpenTag factory acceptance loop. OpenTag will retain governance authority without creating an internal DAG or operator console.")"
  ISSUE_NUMBER="${ISSUE_URL##*/}"
  echo "Created external planning issue: $ISSUE_URL"

  MENTION_BODY="@opentag run ${OPENTAG_GH_LIVE_COMMAND}"
  echo "Posting the external source-thread request before installing the temporary OpenTag webhook..."
  MENTION_URL="$(gh issue comment "$ISSUE_NUMBER" --repo "${OWNER}/${REPO}" --body "$MENTION_BODY")"
  COMMENT_ID="${MENTION_URL##*issuecomment-}"
  if [[ -z "$COMMENT_ID" || "$COMMENT_ID" == "$MENTION_URL" ]]; then
    echo "Could not derive the GitHub comment id from: $MENTION_URL" >&2
    exit 1
  fi
  echo "Source mention: $MENTION_URL"

  SOURCE_COMMENT_PATH="$TMP_ROOT/source-comment.json"
  SOURCE_EVENT_INPUT_PATH="$TMP_ROOT/source-event-input.json"
  EVENT_PATH="$TMP_ROOT/source-event.json"
  gh api "repos/${OWNER}/${REPO}/issues/comments/${COMMENT_ID}" >"$SOURCE_COMMENT_PATH"
  REPOSITORY_PRIVATE="$(gh api "repos/${OWNER}/${REPO}" --jq '.private')"
  python3 - "$SOURCE_COMMENT_PATH" "$SOURCE_EVENT_INPUT_PATH" "$ISSUE_URL" "$ISSUE_NUMBER" "$OWNER" "$REPO" "$REPOSITORY_PRIVATE" <<'PY'
import json
import sys
from pathlib import Path

comment_path, output_path, issue_url, issue_number, owner, repo, private = sys.argv[1:]
comment = json.loads(Path(comment_path).read_text(encoding="utf-8"))
payload = {
    "id": str(comment["id"]),
    "commentBody": comment["body"],
    "commentUrl": comment["html_url"],
    "apiCommentsUrl": f"https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}/comments",
    "issueUrl": issue_url,
    "issueNumber": int(issue_number),
    "owner": owner,
    "repo": repo,
    "actorId": int(comment["user"]["id"]),
    "actorLogin": comment["user"]["login"],
    "authorAssociation": comment.get("author_association"),
    "actorWriteAccess": True,
    "private": private.lower() == "true",
    "receivedAt": comment["created_at"],
}
Path(output_path).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
Path(output_path).chmod(0o600)
PY
  if [[ -n "$RUNTIME_ARTIFACT_PATH" ]]; then
    run_registry_artifact_tool event "$RUNTIME_ARTIFACT_PATH" "$SOURCE_EVENT_INPUT_PATH" "$EVENT_PATH"
  else
    run_factory_acceptance_tool event "$SOURCE_EVENT_INPUT_PATH" "$EVENT_PATH"
  fi
  EVENT_ID="$(python3 - "$EVENT_PATH" <<'PY'
import json
import sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["id"])
PY
)"
fi

echo "Creating temporary GitHub repository webhook for ${OWNER}/${REPO}"
HOOK_ID="$(
  python3 - <<PY | gh api "repos/${OWNER}/${REPO}/hooks" --method POST --input - --jq '.id'
import json
print(json.dumps({
    "name": "web",
    "active": True,
    "events": ["issue_comment", "pull_request_review_comment", "pull_request", "check_run", "check_suite", "status"],
    "config": {
        "url": "${PUBLIC_URL}/github/webhooks",
        "content_type": "json",
        "secret": "${WEBHOOK_SECRET}",
        "insecure_ssl": "0",
    },
}))
PY
)"
echo "Temporary webhook id: $HOOK_ID"

RUN_ID=""
if bool_true "$OPENTAG_GH_LIVE_FACTORY"; then
  WORK_THREAD_RESPONSE_PATH="$TMP_ROOT/work-thread.json"
  RECIPE_INPUT_PATH="$TMP_ROOT/recipe-input.json"
  RECIPE_RESPONSE_PATH="$TMP_ROOT/recipe.json"
  WORKSTREAM_INPUT_PATH="$TMP_ROOT/workstream-input.json"
  WORKSTREAM_RESPONSE_PATH="$TMP_ROOT/workstream.json"
  BATCH_INPUT_PATH="$TMP_ROOT/batch-input.json"
  INITIAL_BATCH_RECEIPT_PATH="$TMP_ROOT/batch-initial.json"
  RECIPE_ID="recipe_github_live_${COMMENT_ID}"
  WORKSTREAM_ID="workstream_github_live_${COMMENT_ID}"
  BATCH_ID="batch_github_live_${COMMENT_ID}"
  RUN_ID="run_github_live_${COMMENT_ID}"

  run_cli factory work-thread ensure --config "$CONFIG_PATH" --input "$EVENT_PATH" --json >"$WORK_THREAD_RESPONSE_PATH"
  WORK_THREAD_ID="$(python3 - "$WORK_THREAD_RESPONSE_PATH" <<'PY'
import json
import sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["workThread"]["id"])
PY
)"

  python3 - \
    "$EVENT_PATH" "$RECIPE_INPUT_PATH" "$WORKSTREAM_INPUT_PATH" "$BATCH_INPUT_PATH" \
    "$RECIPE_ID" "$WORKSTREAM_ID" "$BATCH_ID" "$RUN_ID" "$WORK_THREAD_ID" "$COMMENT_ID" <<'PY'
import json
import sys
from pathlib import Path

(
    event_path,
    recipe_path,
    workstream_path,
    batch_path,
    recipe_id,
    workstream_id,
    batch_id,
    run_id,
    work_thread_id,
    comment_id,
) = sys.argv[1:]
event = json.loads(Path(event_path).read_text(encoding="utf-8"))
documents = {
    recipe_path: {
        "id": recipe_id,
        "version": 1,
        "name": "GitHub provider-live factory acceptance",
        "budgets": {
            "maxConcurrentRuns": 1,
            "maxAttemptsPerRun": 3,
            "maxCostUnits": 3,
            "costUnitsPerAttempt": 1,
            "allowedLocalities": ["local"],
        },
    },
    workstream_path: {
        "id": workstream_id,
        "recipeId": recipe_id,
        "recipeVersion": 1,
        "name": "GitHub source thread factory acceptance",
        "members": [{"kind": "work_thread", "workThreadId": work_thread_id}],
    },
    batch_path: {
        "id": batch_id,
        "workstreamId": workstream_id,
        "items": [{
            "itemId": f"item_github_live_{comment_id}",
            "runId": run_id,
            "workThreadId": work_thread_id,
            "event": event,
        }],
    },
}
for path, document in documents.items():
    target = Path(path)
    target.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    target.chmod(0o600)
PY

  run_cli factory recipe create --config "$CONFIG_PATH" --input "$RECIPE_INPUT_PATH" --json >"$RECIPE_RESPONSE_PATH"
  run_cli factory workstream create --config "$CONFIG_PATH" --input "$WORKSTREAM_INPUT_PATH" --json >"$WORKSTREAM_RESPONSE_PATH"
  run_cli factory batch submit --config "$CONFIG_PATH" --input "$BATCH_INPUT_PATH" --json >"$INITIAL_BATCH_RECEIPT_PATH"
  BATCH_INPUT_DIGEST="$(python3 - "$INITIAL_BATCH_RECEIPT_PATH" "$RUN_ID" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
receipt = payload["receipt"]
result = receipt.get("result", {})
items = result.get("results", [])
if receipt.get("status") != "completed" or len(items) != 1:
    raise SystemExit("Factory admission did not produce one completed result.")
if items[0].get("status") != "created" or items[0].get("admittedRunId") != sys.argv[2]:
    raise SystemExit(f"Factory admission did not create the intended Run: {items[0]}")
print(receipt["batch"]["contentDigest"])
PY
)"
  echo "Factory batch $BATCH_ID admitted attributed Run $RUN_ID for WorkThread $WORK_THREAD_ID."
else
  ISSUE_URL="$(gh issue create --repo "${OWNER}/${REPO}" \
    --title "OpenTag GitHub webhook live test" \
    --body "Temporary issue for validating OpenTag repository webhook -> local agent -> GitHub source-thread action receipts.")"
  ISSUE_NUMBER="${ISSUE_URL##*/}"
  echo "Created issue: $ISSUE_URL"

  WAIT_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  MENTION_BODY="@opentag run ${OPENTAG_GH_LIVE_COMMAND}"
  echo "Posting mention comment through GitHub..."
  MENTION_URL="$(gh issue comment "$ISSUE_NUMBER" --repo "${OWNER}/${REPO}" --body "$MENTION_BODY")"
  echo "Mention comment: $MENTION_URL"

  ISSUE_SQL="$(sql_escape "$ISSUE_NUMBER")"
  STARTED_SQL="$(sql_escape "$WAIT_STARTED_AT")"
  deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    RUN_ID="$(
      sqlite_one "select id from runs where json_extract(event_json, '$.source') = 'github' and json_extract(event_json, '$.metadata.issueNumber') = $ISSUE_SQL and created_at >= '$STARTED_SQL' order by created_at desc limit 1;"
    )"
    if [[ -n "$RUN_ID" ]]; then
      break
    fi
    sleep 2
  done
  if [[ -z "$RUN_ID" ]]; then
    echo "Timed out waiting for GitHub webhook-created run." >&2
    exit 1
  fi
  echo "Detected GitHub webhook-created run: $RUN_ID"
fi

last_status=""
deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  status="$(sqlite_one "select status from runs where id = '$(sql_escape "$RUN_ID")';")"
  if [[ "$status" != "$last_status" && -n "$status" ]]; then
    echo "Run status: $status"
    last_status="$status"
  fi
  case "$status" in
    succeeded|failed|cancelled|needs_approval) break ;;
  esac
  sleep 3
done
if [[ -z "${status:-}" || "$status" == "queued" || "$status" == "assigned" || "$status" == "running" ]]; then
  echo "Timed out waiting for run completion. Last status: ${status:-unknown}" >&2
  exit 1
fi
if [[ "$status" != "succeeded" ]]; then
  echo "GitHub webhook run did not succeed. Final status: $status" >&2
  exit 1
fi
print_metrics "$RUN_ID"
if bool_true "$OPENTAG_GH_LIVE_FACTORY"; then
  METRICS_BEFORE_PROVIDER_PATH="$TMP_ROOT/workstream-metrics-before-provider.json"
  ACCEPTED_PROGRESS_BEFORE_PROVIDER_PATH="$TMP_ROOT/accepted-progress-before-provider.json"
  capture_workstream_metrics "$METRICS_BEFORE_PROVIDER_PATH"
  capture_accepted_progress_metrics "$ACCEPTED_PROGRESS_BEFORE_PROVIDER_PATH"
fi

if bool_true "$OPENTAG_GH_LIVE_STRICT_COMPLETION"; then
  echo "Verifying executor success does not satisfy completion before provider evidence is complete..."
  wait_for_completion "$RUN_ID" "pending,unsatisfied"
  INITIAL_COMPLETION_PATH="$TMP_ROOT/completion-initial.json"
  printf '%s\n' "$COMPLETION_PAYLOAD" >"$INITIAL_COMPLETION_PATH"

  deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    PR_URL="$(sqlite_one "select json_extract(result_json, '$.createdPullRequestUrl') from runs where id = '$(sql_escape "$RUN_ID")';")"
    if [[ -n "$PR_URL" ]]; then
      break
    fi
    sleep 2
  done
  if [[ -z "$PR_URL" ]]; then
    echo "Strict completion run did not record a created pull request URL." >&2
    exit 1
  fi

  PR_INFO_PATH="$TMP_ROOT/pull-request.json"
  gh pr view "$PR_URL" --json number,state,headRefName,headRefOid,baseRefName,url >"$PR_INFO_PATH"
  PR_NUMBER="$(python3 - "$PR_INFO_PATH" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["number"])
PY
)"
  PR_HEAD_SHA="$(python3 - "$PR_INFO_PATH" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["headRefOid"])
PY
)"
  echo "Created governed PR #$PR_NUMBER at head $PR_HEAD_SHA: $PR_URL"

  echo "Recording real GitHub commit status '$OPENTAG_GH_LIVE_REQUIRED_CHECK' on the current PR head..."
  gh api "repos/${OWNER}/${REPO}/statuses/${PR_HEAD_SHA}" \
    --method POST \
    -f state=success \
    -f context="$OPENTAG_GH_LIVE_REQUIRED_CHECK" \
    -f description="OpenTag provider-live completion acceptance" \
    -f target_url="$PR_URL" >/dev/null

  REQUIRED_CHECKS_PATH="$TMP_ROOT/required-checks.json"
  gh api "repos/${OWNER}/${REPO}/commits/${PR_HEAD_SHA}/status" >"$REQUIRED_CHECKS_PATH"

  wait_for_completion "$RUN_ID" "pending,unsatisfied" "required_checks" "passed"
  CHECKED_COMPLETION_PATH="$TMP_ROOT/completion-after-check.json"
  printf '%s\n' "$COMPLETION_PAYLOAD" >"$CHECKED_COMPLETION_PATH"
  echo "Required check passed for the current head; completion remains unsatisfied until merge."

  if bool_true "$OPENTAG_GH_LIVE_REASSESSMENT_CRASH"; then
    echo "Restarting once to arm the deterministic pre-reassessment crash gate..."
    stop_cli_stack
    REASSESSMENT_HOLD_ACTIVE="true"
    deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
      if [[ -z "$(lsof -ti "tcp:${OPENTAG_DISPATCHER_PORT}" 2>/dev/null || true)" && -z "$(lsof -ti "tcp:${OPENTAG_GITHUB_PORT}" 2>/dev/null || true)" ]]; then
        break
      fi
      sleep 1
    done
    ensure_port_free "$OPENTAG_DISPATCHER_PORT" "dispatcher"
    ensure_port_free "$OPENTAG_GITHUB_PORT" "GitHub ingress"
    start_cli_stack
  fi

  echo "Merging governed PR #$PR_NUMBER after OpenTag observed the required check..."
  ASSESSMENT_COUNT_BEFORE_CRASH="$(sqlite_one "select count(*) from completion_assessments where work_thread_id = (select work_thread_id from runs where id = '$(sql_escape "$RUN_ID")');")"
  gh pr merge "$PR_URL" --merge --delete-branch

  gh pr view "$PR_URL" \
    --json number,state,headRefName,headRefOid,baseRefName,url,mergedAt,mergeCommit \
    >"$PR_INFO_PATH"
  if bool_true "$OPENTAG_GH_LIVE_REASSESSMENT_CRASH"; then
    echo "Waiting for real merged-provider evidence and its pending durable reassessment obligation..."
    deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
    OBLIGATION_SOURCE_ID=""
    while (( SECONDS < deadline )); do
      OBLIGATION_SOURCE_ID="$(sqlite_one "
        select ro.source_id
        from reassessment_obligations ro
        where ro.work_thread_id = '$(sql_escape "$WORK_THREAD_ID")'
          and ro.source_kind = 'verification_evidence_attached'
          and ro.state = 'pending'
          and exists (
            select 1 from verification_evidence ve
            where ve.work_thread_id = ro.work_thread_id
              and ve.kind = 'source_control.pull_request_state'
              and lower(json_extract(ve.evidence_json, '$.metadata.completionFactTemplate.claim.outcome')) = 'merged'
              and ro.source_id = ve.provider || ':' || ve.delivery_id || ':' || ve.subject_ref || ':' || ve.work_thread_id
          )
        order by ro.created_at desc, ro.id desc
        limit 1;
      ")"
      CURRENT_ASSESSMENT_COUNT="$(sqlite_one "select count(*) from completion_assessments where work_thread_id = '$(sql_escape "$WORK_THREAD_ID")';")"
      if [[ -n "$OBLIGATION_SOURCE_ID" && "$CURRENT_ASSESSMENT_COUNT" == "$ASSESSMENT_COUNT_BEFORE_CRASH" ]]; then
        break
      fi
      sleep 1
    done
    if [[ -z "$OBLIGATION_SOURCE_ID" ]]; then
      echo "Merged-provider evidence did not commit a pending reassessment obligation before timeout." >&2
      exit 1
    fi
    if [[ "$CURRENT_ASSESSMENT_COUNT" != "$ASSESSMENT_COUNT_BEFORE_CRASH" ]]; then
      echo "Merge evidence was assessed before the deterministic crash gate ($ASSESSMENT_COUNT_BEFORE_CRASH -> $CURRENT_ASSESSMENT_COUNT)." >&2
      exit 1
    fi
    OBLIGATION_SOURCE_DIGEST="$(sqlite_one "select source_digest from reassessment_obligations where source_id = '$(sql_escape "$OBLIGATION_SOURCE_ID")' order by created_at desc limit 1;")"
    REASSESSMENT_OBLIGATION_BEFORE_CRASH_PATH="$TMP_ROOT/reassessment-obligation-before-crash.json"
    sqlite3 -json -cmd ".timeout 5000" "$DATABASE_PATH" "
      select source_kind as sourceKind, source_id as sourceId, source_digest as sourceDigest,
        state, satisfied_assessment_id as assessmentId, attempt_count as attemptCount,
        (select count(*) from reassessment_obligations matching
          where matching.source_kind = ro.source_kind
            and matching.source_id = ro.source_id
            and matching.source_digest = ro.source_digest) as matchingCount
      from reassessment_obligations ro
      where source_kind = 'verification_evidence_attached'
        and source_id = '$(sql_escape "$OBLIGATION_SOURCE_ID")'
        and source_digest = '$(sql_escape "$OBLIGATION_SOURCE_DIGEST")';
    " >"$REASSESSMENT_OBLIGATION_BEFORE_CRASH_PATH"
    EVIDENCE_RECORD_COUNT_BEFORE_CRASH="$(sqlite_one "select count(*) from verification_evidence where work_thread_id = '$(sql_escape "$WORK_THREAD_ID")';")"

    echo "Terminating the first stack inside the committed-fact / pre-reassessment crash window..."
    stop_cli_stack
    REASSESSMENT_HOLD_ACTIVE="false"
    deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
      if [[ -z "$(lsof -ti "tcp:${OPENTAG_DISPATCHER_PORT}" 2>/dev/null || true)" && -z "$(lsof -ti "tcp:${OPENTAG_GITHUB_PORT}" 2>/dev/null || true)" ]]; then
        break
      fi
      sleep 1
    done
    ensure_port_free "$OPENTAG_DISPATCHER_PORT" "dispatcher"
    ensure_port_free "$OPENTAG_GITHUB_PORT" "GitHub ingress"
    start_cli_stack
    deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
    while (( SECONDS < deadline )); do
      OBLIGATION_STATE="$(sqlite_one "select state from reassessment_obligations where source_kind = 'verification_evidence_attached' and source_id = '$(sql_escape "$OBLIGATION_SOURCE_ID")' and source_digest = '$(sql_escape "$OBLIGATION_SOURCE_DIGEST")';")"
      if [[ "$OBLIGATION_STATE" == "satisfied" ]]; then
        break
      fi
      sleep 1
    done
    if [[ "$OBLIGATION_STATE" != "satisfied" ]]; then
      echo "Restart did not satisfy the pending merge-evidence reassessment obligation; state=$OBLIGATION_STATE." >&2
      exit 1
    fi
  fi

  wait_for_completion "$RUN_ID" "satisfied" "merge" "passed"
  FINAL_COMPLETION_PATH="$TMP_ROOT/completion-final.json"
  printf '%s\n' "$COMPLETION_PAYLOAD" >"$FINAL_COMPLETION_PATH"
  wait_for_issue_comment "provider-verified completion requirements are satisfied"
  RECEIPTS_BEFORE_RESTART="$(completion_receipt_count)"
  SOURCE_COMMENTS_PATH="$TMP_ROOT/source-comments-before-restart.json"
  SOURCE_ISSUE_PATH="$TMP_ROOT/source-issue-after-completion.json"
  gh api "repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments?per_page=100" >"$SOURCE_COMMENTS_PATH"
  gh api "repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}" >"$SOURCE_ISSUE_PATH"
  if bool_true "$OPENTAG_GH_LIVE_FACTORY"; then
    METRICS_AFTER_MERGE_PATH="$TMP_ROOT/workstream-metrics-after-merge.json"
    ACCEPTED_PROGRESS_AFTER_MERGE_PATH="$TMP_ROOT/accepted-progress-after-merge.json"
    capture_workstream_metrics "$METRICS_AFTER_MERGE_PATH"
    capture_accepted_progress_metrics "$ACCEPTED_PROGRESS_AFTER_MERGE_PATH"
  fi
  if bool_true "$OPENTAG_GH_LIVE_REASSESSMENT_CRASH"; then
    deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
    while (( SECONDS < deadline )); do
      UNRESOLVED_OBLIGATION_COUNT="$(sqlite_one "select count(*) from reassessment_obligations where work_thread_id = '$(sql_escape "$WORK_THREAD_ID")' and state in ('pending', 'leased');")"
      if [[ "$UNRESOLVED_OBLIGATION_COUNT" == "0" ]]; then
        break
      fi
      sleep 1
    done
    if [[ "$UNRESOLVED_OBLIGATION_COUNT" != "0" ]]; then
      echo "Restart left $UNRESOLVED_OBLIGATION_COUNT unresolved reassessment obligations for the WorkThread." >&2
      exit 1
    fi
    REASSESSMENT_OBLIGATION_AFTER_RESTART_PATH="$TMP_ROOT/reassessment-obligation-after-restart.json"
    sqlite3 -json -cmd ".timeout 5000" "$DATABASE_PATH" "
      select source_kind as sourceKind, source_id as sourceId, source_digest as sourceDigest,
        state, satisfied_assessment_id as satisfiedAssessmentId, attempt_count as attemptCount,
        (select count(*) from reassessment_obligations matching
          where matching.source_kind = ro.source_kind
            and matching.source_id = ro.source_id
            and matching.source_digest = ro.source_digest) as matchingCount
      from reassessment_obligations ro
      where source_kind = 'verification_evidence_attached'
        and source_id = '$(sql_escape "$OBLIGATION_SOURCE_ID")'
        and source_digest = '$(sql_escape "$OBLIGATION_SOURCE_DIGEST")';
    " >"$REASSESSMENT_OBLIGATION_AFTER_RESTART_PATH"
    ASSESSMENT_COUNT_AFTER_RECOVERY="$(sqlite_one "select count(*) from completion_assessments where work_thread_id = '$(sql_escape "$WORK_THREAD_ID")';")"
    EVIDENCE_RECORD_COUNT_AFTER_RECOVERY="$(sqlite_one "select count(*) from verification_evidence where work_thread_id = '$(sql_escape "$WORK_THREAD_ID")';")"
  fi

  echo "Restarting the CLI stack to verify durable satisfied completion and callback deduplication..."
  stop_cli_stack
  deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if [[ -z "$(lsof -ti "tcp:${OPENTAG_DISPATCHER_PORT}" 2>/dev/null || true)" && -z "$(lsof -ti "tcp:${OPENTAG_GITHUB_PORT}" 2>/dev/null || true)" ]]; then
      break
    fi
    sleep 1
  done
  ensure_port_free "$OPENTAG_DISPATCHER_PORT" "dispatcher"
  ensure_port_free "$OPENTAG_GITHUB_PORT" "GitHub ingress"
  start_cli_stack
  wait_for_completion "$RUN_ID" "satisfied" "merge" "passed"
  if bool_true "$OPENTAG_GH_LIVE_FACTORY"; then
    REPLAYED_BATCH_RECEIPT_PATH="$TMP_ROOT/batch-after-restart.json"
    run_cli factory batch submit --config "$CONFIG_PATH" --input "$BATCH_INPUT_PATH" --json >"$REPLAYED_BATCH_RECEIPT_PATH"
    wait_for_completion "$RUN_ID" "satisfied" "merge" "passed"
  fi
  RESTARTED_COMPLETION_PATH="$TMP_ROOT/completion-after-restart.json"
  printf '%s\n' "$COMPLETION_PAYLOAD" >"$RESTARTED_COMPLETION_PATH"
  RECEIPTS_AFTER_RESTART="$(stable_completion_receipt_count 10)"
  if [[ "$RECEIPTS_AFTER_RESTART" != "$RECEIPTS_BEFORE_RESTART" ]]; then
    echo "Restart emitted a duplicate provider-verified completion receipt ($RECEIPTS_BEFORE_RESTART -> $RECEIPTS_AFTER_RESTART)." >&2
    exit 1
  fi
  SOURCE_COMMENTS_AFTER_RESTART_PATH="$TMP_ROOT/source-comments-after-restart.json"
  gh api "repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments?per_page=100" >"$SOURCE_COMMENTS_AFTER_RESTART_PATH"
  if bool_true "$OPENTAG_GH_LIVE_FACTORY"; then
    METRICS_AFTER_RESTART_PATH="$TMP_ROOT/workstream-metrics-after-restart.json"
    ACCEPTED_PROGRESS_AFTER_RESTART_PATH="$TMP_ROOT/accepted-progress-after-restart.json"
    capture_workstream_metrics "$METRICS_AFTER_RESTART_PATH"
    capture_accepted_progress_metrics "$ACCEPTED_PROGRESS_AFTER_RESTART_PATH"
  fi

  if bool_true "$OPENTAG_GH_LIVE_FACTORY"; then
    REPORT_PATH="${OPENTAG_GH_LIVE_REPORT:-$ROOT_DIR/.omx/live-e2e/github-factory-live-$(date -u +%Y%m%dT%H%M%SZ).json}"
  else
    REPORT_PATH="${OPENTAG_GH_LIVE_REPORT:-$ROOT_DIR/.omx/live-e2e/github-completion-governance-$(date -u +%Y%m%dT%H%M%SZ).json}"
  fi
  if [[ "$REPORT_PATH" != /* ]]; then
    REPORT_PATH="$ROOT_DIR/$REPORT_PATH"
  fi
  mkdir -p "$(dirname "$REPORT_PATH")"
  ASSESSMENT_COUNT="$(sqlite_one "select count(*) from completion_assessments where work_thread_id = (select work_thread_id from runs where id = '$(sql_escape "$RUN_ID")');")"
  if bool_true "$OPENTAG_GH_LIVE_REASSESSMENT_CRASH"; then
    ASSESSMENT_COUNT_AFTER_SECOND_RESTART="$ASSESSMENT_COUNT"
  fi
  RUNTIME_SOURCE="source_checkout"
  if [[ -n "${OPENTAG_GH_LIVE_CLI_BIN:-}" ]]; then
    RUNTIME_SOURCE="registry_install"
  fi
  if bool_true "$OPENTAG_GH_LIVE_FACTORY"; then
    RUN_EVIDENCE_PATH="$TMP_ROOT/run-evidence.json"
    ATTEMPT_EVIDENCE_PATH="$TMP_ROOT/attempt-evidence.json"
    EVIDENCE_INPUT_PATH="$TMP_ROOT/github-factory-evidence.json"
    sqlite3 -json -cmd ".timeout 5000" "$DATABASE_PATH" \
      "select id, status, work_thread_id as workThreadId, workstream_id as workstreamId, admission_batch_id as admissionBatchId, context_packet_json is not null as contextPacketCaptured, access_profile_snapshot_json is not null as accessProfileCaptured, policy_snapshot_provenance_json is not null as policyProvenanceCaptured from runs where id = '$(sql_escape "$RUN_ID")';" \
      >"$RUN_EVIDENCE_PATH"
    sqlite3 -json -cmd ".timeout 5000" "$DATABASE_PATH" \
      "select a.id, a.runner_id as runnerId, coalesce(a.selected_executor_id, r.executor) as executorId, a.runner_locality as locality, a.status, length(a.fencing_token) > 0 as hasFencingToken from attempts a join runs r on r.id = a.run_id where a.run_id = '$(sql_escape "$RUN_ID")' order by a.number desc limit 1;" \
      >"$ATTEMPT_EVIDENCE_PATH"
    python3 - \
      "$EVIDENCE_INPUT_PATH" "$INITIAL_COMPLETION_PATH" "$CHECKED_COMPLETION_PATH" "$FINAL_COMPLETION_PATH" "$RESTARTED_COMPLETION_PATH" \
      "$PR_INFO_PATH" "$REQUIRED_CHECKS_PATH" "$RECIPE_RESPONSE_PATH" "$WORKSTREAM_RESPONSE_PATH" \
      "$INITIAL_BATCH_RECEIPT_PATH" "$REPLAYED_BATCH_RECEIPT_PATH" "$RUN_EVIDENCE_PATH" "$ATTEMPT_EVIDENCE_PATH" \
      "$METRICS_BEFORE_PROVIDER_PATH" "$METRICS_AFTER_MERGE_PATH" "$METRICS_AFTER_RESTART_PATH" "$SOURCE_COMMENTS_PATH" "$SOURCE_COMMENTS_AFTER_RESTART_PATH" "$SOURCE_ISSUE_PATH" \
      "$ACCEPTED_PROGRESS_BEFORE_PROVIDER_PATH" "$ACCEPTED_PROGRESS_AFTER_MERGE_PATH" "$ACCEPTED_PROGRESS_AFTER_RESTART_PATH" \
      "$REASSESSMENT_OBLIGATION_BEFORE_CRASH_PATH" "$REASSESSMENT_OBLIGATION_AFTER_RESTART_PATH" \
      "$ASSESSMENT_COUNT_BEFORE_CRASH" "$ASSESSMENT_COUNT_AFTER_RECOVERY" "$ASSESSMENT_COUNT_AFTER_SECOND_RESTART" \
      "$EVIDENCE_RECORD_COUNT_BEFORE_CRASH" "$EVIDENCE_RECORD_COUNT_AFTER_RECOVERY" \
      "$OWNER/$REPO" "$ISSUE_URL" "$MENTION_URL" "$ISSUE_NUMBER" "$COMMENT_ID" "$EVENT_ID" "$WORK_THREAD_ID" \
      "$RECIPE_ID" "$WORKSTREAM_ID" "$BATCH_ID" "$BATCH_INPUT_DIGEST" "$ASSESSMENT_COUNT" \
      "$RECEIPTS_BEFORE_RESTART" "$RECEIPTS_AFTER_RESTART" "$RUNTIME_SOURCE" "$RUNTIME_ARTIFACT_PATH" "$OPENTAG_GH_LIVE_REQUIRED_CHECK" <<'PY'
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

(
    evidence_path,
    initial_path,
    checked_path,
    final_path,
    restarted_path,
    pr_path,
    required_checks_path,
    recipe_path,
    workstream_path,
    initial_batch_path,
    replayed_batch_path,
    run_path,
    attempt_path,
    metrics_before_path,
    metrics_merged_path,
    metrics_restarted_path,
    comments_before_restart_path,
    comments_after_restart_path,
    source_issue_path,
    accepted_progress_before_path,
    accepted_progress_merged_path,
    accepted_progress_restarted_path,
    obligation_before_crash_path,
    obligation_after_restart_path,
    assessment_count_before_crash,
    assessment_count_after_recovery,
    assessment_count_after_second_restart,
    evidence_record_count_before_crash,
    evidence_record_count_after_recovery,
    repository,
    issue_url,
    mention_url,
    issue_number,
    comment_id,
    event_id,
    work_thread_id,
    recipe_id,
    workstream_id,
    batch_id,
    batch_input_digest,
    assessment_count,
    receipts_before_restart,
    receipts_after_restart,
    runtime_source,
    runtime_artifact_path,
    required_check_context,
) = sys.argv[1:]

def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

run_rows = read(run_path)
attempt_rows = read(attempt_path)
if len(run_rows) != 1 or len(attempt_rows) != 1:
    raise SystemExit("Factory acceptance requires exactly one durable Run and latest Attempt.")
run = run_rows[0]
run["contextPacketCaptured"] = bool(run["contextPacketCaptured"])
run["accessProfileCaptured"] = bool(run["accessProfileCaptured"])
run["policyProvenanceCaptured"] = bool(run["policyProvenanceCaptured"])
attempt = attempt_rows[0]
attempt["hasFencingToken"] = bool(attempt["hasFencingToken"])

combined_status = read(required_checks_path)
statuses = [item for item in combined_status.get("statuses", []) if item.get("context") == required_check_context]
if len(statuses) != 1:
    raise SystemExit(f"Expected exactly one retained required status for {required_check_context}; observed {len(statuses)}.")
required_check = statuses[0]
required_check_head = combined_status.get("sha")

phrase = "provider-verified completion requirements are satisfied"

def receipt_observation(path, expected_count, phase):
    receipts = [comment for comment in read(path) if phrase in (comment.get("body") or "")]
    if len(receipts) != int(expected_count):
        raise SystemExit(f"Retained source comments {phase} do not match the observed completion receipt count.")
    if not receipts:
        raise SystemExit(f"No provider-verified source-thread completion receipt was retained {phase}.")
    receipt = receipts[-1]
    body = receipt["body"]
    return {
        "id": str(receipt["id"]),
        "url": receipt["html_url"],
        "bodyDigest": f"sha256:{hashlib.sha256(body.encode('utf-8')).hexdigest()}",
    }

receipt_before_restart = receipt_observation(
    comments_before_restart_path, receipts_before_restart, "before restart"
)
receipt_after_restart = receipt_observation(
    comments_after_restart_path, receipts_after_restart, "after restart"
)

recipe = read(recipe_path)["recipe"]
workstream = read(workstream_path)["workstream"]
source_issue = read(source_issue_path)
obligation_before_rows = read(obligation_before_crash_path)
obligation_after_rows = read(obligation_after_restart_path)
if len(obligation_before_rows) != 1 or len(obligation_after_rows) != 1:
    raise SystemExit("Factory acceptance requires exactly one retained reassessment obligation before and after restart.")
obligation_before = obligation_before_rows[0]
obligation_after = obligation_after_rows[0]
if (
    obligation_before["sourceKind"] != obligation_after["sourceKind"]
    or obligation_before["sourceId"] != obligation_after["sourceId"]
    or obligation_before["sourceDigest"] != obligation_after["sourceDigest"]
):
    raise SystemExit("Reassessment obligation identity changed across restart.")
evidence = {
    "recordedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "repository": repository,
    "runtimeSource": runtime_source,
    "source": {
        "issueUrl": issue_url,
        "mentionUrl": mention_url,
        "issueNumber": int(issue_number),
        "issueState": source_issue["state"].upper(),
        "commentId": comment_id,
        "eventId": event_id,
    },
    "factory": {
        "workThreadId": work_thread_id,
        "recipe": {"id": recipe_id, "version": 1, "contentDigest": recipe["contentDigest"]},
        "workstream": {"id": workstream_id, "contentDigest": workstream["contentDigest"]},
        "batch": {
            "id": batch_id,
            "inputDigest": batch_input_digest,
            "initialReceipt": read(initial_batch_path),
            "replayedReceipt": read(replayed_batch_path),
        },
    },
    "run": run,
    "attempt": attempt,
    "pullRequest": read(pr_path),
    "requiredCheck": {
        "context": required_check["context"],
        "headSha": required_check_head,
        "state": required_check["state"],
        **({"targetUrl": required_check["target_url"]} if required_check.get("target_url") else {}),
    },
    "completion": {
        "afterExecutorSuccess": read(initial_path)["completion"],
        "afterRequiredCheck": read(checked_path)["completion"],
        "afterMerge": read(final_path)["completion"],
        "afterRestart": read(restarted_path)["completion"],
    },
    "metrics": {
        "beforeProviderEvidence": read(metrics_before_path),
        "afterMerge": read(metrics_merged_path),
        "afterRestart": read(metrics_restarted_path),
    },
    "acceptedProgress": {
        "beforeProviderEvidence": read(accepted_progress_before_path),
        "afterMerge": read(accepted_progress_merged_path),
        "afterRestart": read(accepted_progress_restarted_path),
    },
    "reassessmentObligation": {
        "sourceKind": obligation_before["sourceKind"],
        "sourceId": obligation_before["sourceId"],
        "sourceDigest": obligation_before["sourceDigest"],
        "beforeCrash": {
            "state": obligation_before["state"],
            "assessmentId": obligation_before.get("assessmentId"),
            "assessmentCount": int(assessment_count_before_crash),
            "evidenceRecordCount": int(evidence_record_count_before_crash),
        },
        "afterRestart": {
            "state": obligation_after["state"],
            "attemptCount": int(obligation_after["attemptCount"]),
            "satisfiedAssessmentId": obligation_after["satisfiedAssessmentId"],
            "assessmentCount": int(assessment_count_after_recovery),
            "evidenceRecordCount": int(evidence_record_count_after_recovery),
        },
        "afterSecondRestartAssessmentCount": int(assessment_count_after_second_restart),
        "matchingCount": int(obligation_after["matchingCount"]),
    },
    "assessmentCount": int(assessment_count),
    "sourceReceipt": {
        "matchedPhrase": phrase,
        "beforeRestart": receipt_before_restart,
        "afterRestart": receipt_after_restart,
        "countBeforeRestart": int(receipts_before_restart),
        "countAfterRestart": int(receipts_after_restart),
    },
}
if runtime_source == "registry_install":
    if not runtime_artifact_path:
        raise SystemExit("Registry-installed factory acceptance is missing runtime artifact evidence.")
    evidence["runtimeArtifact"] = read(runtime_artifact_path)["runtimeArtifact"]
target = Path(evidence_path)
target.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
target.chmod(0o600)
PY
    run_factory_acceptance_tool report "$EVIDENCE_INPUT_PATH" "$REPORT_PATH"
    echo "Structured GitHub factory acceptance evidence: $REPORT_PATH"
  else
    python3 - \
      "$REPORT_PATH" "$INITIAL_COMPLETION_PATH" "$CHECKED_COMPLETION_PATH" "$FINAL_COMPLETION_PATH" "$RESTARTED_COMPLETION_PATH" "$PR_INFO_PATH" \
      "$OWNER/$REPO" "$ISSUE_URL" "$RUN_ID" "$OPENTAG_GH_LIVE_REQUIRED_CHECK" "$ASSESSMENT_COUNT" "$RECEIPTS_AFTER_RESTART" "$RUNTIME_SOURCE" "$RUNTIME_ARTIFACT_PATH" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

(
    report_path,
    initial_path,
    checked_path,
    final_path,
    restarted_path,
    pr_path,
    repository,
    issue_url,
    run_id,
    required_check,
    assessment_count,
    receipt_count,
    runtime_source,
    runtime_artifact_path,
) = sys.argv[1:]

def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

report = {
    "schemaVersion": 1,
    "case": "github-completion-governance-live",
    "recordedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "repository": repository,
    "issueUrl": issue_url,
    "runId": run_id,
    "requiredCheck": required_check,
    "runtimeSource": runtime_source,
    "pullRequest": read(pr_path),
    "completion": {
        "afterExecutorSuccess": read(initial_path)["completion"],
        "afterRequiredCheck": read(checked_path)["completion"],
        "afterMerge": read(final_path)["completion"],
        "afterRestart": read(restarted_path)["completion"],
    },
    "assessmentCount": int(assessment_count),
    "providerVerifiedReceiptCount": int(receipt_count),
}
if runtime_source == "registry_install":
    if not runtime_artifact_path:
        raise SystemExit("Registry-installed completion acceptance is missing runtime artifact evidence.")
    report["runtimeArtifact"] = read(runtime_artifact_path)["runtimeArtifact"]
Path(report_path).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
Path(report_path).chmod(0o600)
PY
    echo "Structured completion-governance evidence: $REPORT_PATH"
  fi
else
echo "Recent issue comments after final receipt:"
gh api "repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments?sort=created&direction=desc&per_page=4" \
  --jq 'reverse[] | {author: .user.login, body: (.body | split("\n")[0:8] | join("\n"))}'
EXPECTED_HEADING="<summary>Ready to apply</summary>"
if bool_true "$OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN"; then
  EXPECTED_HEADING="<summary>Needs setup</summary>"
fi
if [[ "$OPENTAG_GH_LIVE_EXECUTOR" == "echo" ]]; then
  if ! issue_comments_contain "OpenTag finished with **success**."; then
    echo "Expected the Echo smoke to post a successful final receipt." >&2
    exit 1
  fi
  if issue_comments_contain '`apply 1`'; then
    echo "Expected the Echo smoke not to advertise apply actions." >&2
    exit 1
  fi
elif bool_true "$OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN"; then
  if ! issue_comments_contain "$EXPECTED_HEADING"; then
    echo "Expected the final GitHub receipt to render '$EXPECTED_HEADING'." >&2
    exit 1
  fi
  if issue_comments_contain '`apply 1`'; then
    echo "Expected the missing-apply-token receipt not to advertise the apply command." >&2
    exit 1
  fi
elif ! issue_comments_contain "### Ready to apply" &&
  ! issue_comments_contain "<summary>Ready to apply</summary>" &&
  ! issue_comments_contain "action ready to apply" &&
  ! issue_comments_contain "actions ready to apply" &&
  ! issue_comments_contain "### Some actions need setup" &&
  ! issue_comments_contain "<summary>Needs setup</summary>" &&
  ! issue_comments_contain "### Some actions need attention" &&
  ! issue_comments_contain "<summary>Needs attention</summary>" &&
  ! issue_comments_contain "### Needs review"; then
  echo "Expected the final GitHub receipt to render a ready or mixed-state action heading." >&2
  exit 1
elif ! issue_comments_contain '`apply 1`'; then
  echo "Expected the final GitHub receipt to advertise apply 1 for the ready action." >&2
  exit 1
fi

if bool_true "$OPENTAG_GH_LIVE_APPLY"; then
  before_count="$(sqlite_one "select count(*) from approval_decisions;")"
  echo "Replying apply 1 through GitHub..."
  APPLY_URL="$(gh issue comment "$ISSUE_NUMBER" --repo "${OWNER}/${REPO}" --body "apply 1")"
  echo "Apply comment: $APPLY_URL"

  deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    after_count="$(sqlite_one "select count(*) from approval_decisions;")"
    if [[ -n "$after_count" && -n "$before_count" && "$after_count" -gt "$before_count" ]]; then
      break
    fi
    sleep 2
  done
  if [[ "${after_count:-0}" -le "${before_count:-0}" ]]; then
    echo "Timed out waiting for approval decision from GitHub apply comment." >&2
    exit 1
  fi

  PR_URL=""
  deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    plan_json="$(latest_apply_plan_for_run "$RUN_ID")"
    if [[ -n "$plan_json" ]]; then
      PR_URL="$(python3 - "$plan_json" <<'PY' || true
import json
import sys
plan = json.loads(sys.argv[1])
for outcome in plan.get("outcomes", []):
    if outcome.get("externalUri"):
        print(outcome["externalUri"])
        break
PY
)"
      executed="$(python3 - "$plan_json" <<'PY' || true
import json
import sys
plan = json.loads(sys.argv[1])
print("true" if plan.get("adapterPlan", {}).get("externalWritesExecuted") else "false")
PY
)"
      if [[ -n "$PR_URL" && "$executed" == "true" ]]; then
        break
      fi
    fi
    sleep 2
  done
  if [[ -z "$PR_URL" ]]; then
    echo "Timed out waiting for applied PR URL." >&2
    latest_apply_plan_for_run "$RUN_ID" | python3 -m json.tool || true
    exit 1
  fi
  echo "Created PR: $PR_URL"
  gh pr view "$PR_URL" --json number,state,headRefName,baseRefName,url --jq '{number,state,headRefName,baseRefName,url}'
  print_metrics "$RUN_ID"
  echo "Recent issue comments after apply receipt:"
  gh api "repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments?sort=created&direction=desc&per_page=5" \
    --jq 'reverse[] | {author: .user.login, body: (.body | split("\n")[0:8] | join("\n"))}'
  if ! issue_comments_contain "Applied:"; then
    echo "Expected the GitHub thread to contain an applied receipt." >&2
    exit 1
  fi
  if applied_receipt_has_double_period; then
    echo "Applied receipt ended with duplicate punctuation." >&2
    exit 1
  fi
fi
fi

echo
echo "GitHub repository-webhook live test completed."
echo "- Issue: https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}"
echo "- Run ID: $RUN_ID"
if [[ -n "${PR_URL:-}" ]]; then
  echo "- Pull request: $PR_URL"
fi
