#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const openclawCommand = process.env.OPENTAG_OPENCLAW_COMMAND || "openclaw";
const hermesCommand = process.env.OPENTAG_HERMES_COMMAND || "hermes";
const builtInAcpAgents = process.env.OPENTAG_BUILTIN_ACP_AGENTS?.split(",").map((value) => value.trim())
  ?? ["codex", "claude-code", "cursor", "opencode", "hermes", "openclaw"];
const githubWebhookExecutor = process.env.OPENTAG_GH_LIVE_EXECUTOR || "claude-code";

function requiredCommandsForBuiltInAcpAgent(agent) {
  if (["codex", "claude-code", "opencode"].includes(agent)) return ["npx"];
  if (agent === "cursor") return ["cursor-agent"];
  if (agent === "hermes") return [hermesCommand];
  if (agent === "openclaw") return [openclawCommand];
  return [];
}

const cases = [
  {
    id: "protocol-runtime",
    label: "In-memory GitHub-shaped protocol smoke",
    live: false,
    command: "corepack pnpm smoke:protocol",
    requiredCommands: ["corepack"]
  },
  {
    id: "slack-protocol",
    label: "In-memory Slack-shaped protocol smoke",
    live: false,
    command: "corepack pnpm smoke:slack-protocol",
    requiredCommands: ["corepack"]
  },
  {
    id: "factory-conformance",
    label: "Restart-safe recipe factory conformance",
    live: false,
    command: "corepack pnpm smoke:factory-conformance",
    requiredCommands: ["corepack", "git", "node"],
    notes: [
      "Runs one file-backed recipe/workstream/batch loop through the dispatcher and local daemon.",
      "Exercises the Echo and deterministic local ACP fixture executor paths without provider credentials.",
      "Proves durable replay, bounded batch exceptions, and current-assessment accepted-outcome attribution; it is not a provider-live public proof."
    ]
  },
  {
    id: "builtin-acp",
    label: "Live built-in coding-agent ACP conformance",
    live: true,
    command: "corepack pnpm smoke:acp-conformance",
    requiredCommands: [
      "corepack",
      "git",
      ...new Set(builtInAcpAgents.flatMap(requiredCommandsForBuiltInAcpAgent))
    ],
    notes: [
      "Runs real readiness, scratch cwd, isolated worktree, and declared process-tree cancellation cases.",
      "Set OPENTAG_BUILTIN_ACP_AGENTS to a comma-separated subset of codex,claude-code,cursor,opencode,hermes,openclaw.",
      "OpenClaw declares best-effort cancellation, so its process-tree case is not applicable; use openclaw-acp for the strict upstream probe.",
      "Codex and Claude require working local authentication; Hermes requires a usable OPENTAG_HERMES_PROFILE provider."
    ]
  },
  {
    id: "openclaw-acp",
    label: "Live OpenClaw Gateway ACP conformance",
    live: true,
    command: "corepack pnpm smoke:openclaw-acp-conformance",
    requiredCommands: ["corepack", "git", openclawCommand],
    notes: [
      "Requires OpenClaw 2026.7.1 and a running Gateway for OPENTAG_OPENCLAW_PROFILE (default: opentag-conformance).",
      "Uses real model and file tools in temporary worktree and scratch fixtures, then exercises live cancellation.",
      "Stock 2026.7.1 currently fails the strict hard-cancellation probe because its cancelled shell can still reach the completion marker; built-in support remains available with cancel=no.",
      "The profile owns Gateway authentication; never put its token in the integration manifest."
    ]
  },
  {
    id: "github-webhook-live",
    label: "Live GitHub completion-governance smoke",
    live: true,
    command: "scripts/dev/run-github-webhook-live-test.sh",
    requiredCommands: [
      "corepack",
      "curl",
      "gh",
      "lsof",
      "node",
      "python3",
      "sqlite3",
      ...requiredCommandsForBuiltInAcpAgent(githubWebhookExecutor)
    ],
    optionalCommands: ["ngrok"],
    notes: [
      "Requires gh auth with ADMIN or MAINTAIN access to OPENTAG_GH_REPO.",
      "Requires npx plus working local authentication for the selected Registry-backed ACP launch.",
      "Set OPENTAG_GH_LIVE_EXECUTOR=phase1-fixture to isolate the real GitHub/governance chain from model-provider readiness while retaining a real ACP worktree write.",
      "Set OPENTAG_GH_PUBLIC_URL or allow ngrok with OPENTAG_GH_LIVE_START_NGROK=true.",
      "Strict mode creates and merges a real PR, records a current-head GitHub status, and writes sanitized evidence under .omx/live-e2e."
    ]
  },
  {
    id: "github-factory-live",
    label: "Live GitHub recipe-driven factory acceptance",
    live: true,
    command: "OPENTAG_GH_LIVE_FACTORY=true scripts/dev/run-github-webhook-live-test.sh",
    requiredCommands: [
      "corepack",
      "curl",
      "gh",
      "lsof",
      "node",
      "python3",
      "sqlite3",
      ...requiredCommandsForBuiltInAcpAgent(githubWebhookExecutor)
    ],
    optionalCommands: ["ngrok"],
    notes: [
      "Uses a real GitHub issue comment as the external planning source, then admits it through WorkThread ensure, an immutable recipe, a WorkThread-only workstream, and a durable batch.",
      "Executes locally, creates and merges a real PR, verifies the required check against the current head, and requires provider-verified accepted completion.",
      "Restarts the stack, replays the exact batch receipt, verifies the source-thread receipt is not duplicated, and proves accepted gate advances remain fully attributed to the fenced Attempt runner and executor.",
      "Set OPENTAG_GH_LIVE_EXECUTOR=phase1-fixture to prove the GitHub/factory/governance chain with the deterministic local ACP worktree writer.",
      "This case keeps planning external and explicitly excludes a DAG and operator console."
    ]
  },
  {
    id: "github-cli-live",
    label: "Live GitHub dispatcher-assisted local executor smoke",
    live: true,
    command: "scripts/dev/run-gh-claude-local-test.sh",
    requiredCommands: ["gh", "node", "npx"],
    requiredOneOfEnv: [["OPENTAG_GH_TEST_ISSUE", "OPENTAG_GH_CREATE_ISSUE=true"]],
    notes: [
      "Uses gh auth to create or reuse a real GitHub issue thread.",
      "Set OPENTAG_WORKSPACE_PATH to a clean checkout when not testing this repo."
    ]
  },
  {
    id: "slack-linear-registry-live",
    label: "Registry-installed live Slack /linear acceptance",
    live: true,
    command: "scripts/dev/run-slack-linear-backlog-live-test.sh",
    requiredCommands: ["corepack", "node", "npm"],
    notes: [
      "Loads .env.slack-test and .env.linear by default; override the two OPENTAG_SLACK_LINEAR_*_ENV_FILE paths for an isolated worktree.",
      "Installs the exact expected @opentag/cli release from npm, verifies CLI/Slack/Linear/Core lockfile sha512 receipts, and runs the installed CLI in Slack Socket Mode.",
      "Requires one real human Slack message containing exactly @OpenTag /linear, then verifies the provider-delivered source event, real Linear GraphQL reads, and provider-visible Slack thread reply.",
      "The Linear audit proxy fails closed on mutations; retained evidence is mode 0600 and contains hashes/counts instead of credentials, Linear issue titles, or raw Slack messages."
    ]
  },
  {
    id: "slack-local-live",
    label: "Live Slack dispatcher-assisted local executor smoke",
    live: true,
    command: "scripts/dev/run-slack-claude-local-test.sh",
    requiredCommands: ["node", "python3", "npx"],
    optionalCommands: ["gh"],
    requiredEnv: ["OPENTAG_CONFIG_PATH", "OPENTAG_SLACK_BOT_TOKEN"],
    notes: [
      "Usually load OPENTAG_CONFIG_PATH and OPENTAG_SLACK_BOT_TOKEN from .env.slack-test.",
      "Set OPENTAG_SLACK_APPLY_PR_ACTION=true only when GitHub apply credentials are ready."
    ]
  },
  {
    id: "slack-ui-live",
    label: "Live Slack UI-triggered source-thread smoke",
    live: true,
    command: "scripts/dev/run-slack-ui-trigger-local-test.sh",
    requiredCommands: ["curl", "node", "python3", "sqlite3", "lsof", "npx"],
    optionalCommands: ["ngrok"],
    requiredEnv: ["OPENTAG_CONFIG_PATH", "OPENTAG_SLACK_BOT_TOKEN"],
    requiredOneOfEnv: [["OPENTAG_SLACK_APP_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET"]],
    notes: [
      "Socket Mode uses OPENTAG_SLACK_APP_TOKEN or SLACK_APP_TOKEN.",
      "Events API mode uses SLACK_SIGNING_SECRET plus a public URL or ngrok."
    ]
  },
  {
    id: "lark-patch-live",
    label: "Live Lark card reply and patch smoke",
    live: true,
    command:
      "NODE_OPTIONS='--conditions=development' corepack pnpm --dir apps/dispatcher exec tsx ../../scripts/dev/run-lark-message-patch-live-test.ts",
    requiredCommands: [process.env.OPENTAG_LARK_CLI || "lark-cli"],
    notes: [
      "Requires lark-cli auth status to report a ready bot identity and either a ready user identity or cached user openId.",
      "Optionally set OPENTAG_LARK_LIVE_CHAT_ID and OPENTAG_LARK_LIVE_SOURCE_MESSAGE_ID together."
    ]
  },
  {
    id: "linear-workspace-live",
    label: "Live Linear workspace webhook, comment, and issue update smoke",
    live: true,
    command:
      "NODE_OPTIONS='--conditions=development' corepack pnpm --dir apps/dispatcher exec tsx ../../scripts/dev/run-linear-workspace-live-test.ts",
    requiredCommands: ["corepack", "node"],
    requiredEnv: ["OPENTAG_LINEAR_SMOKE_TOKEN"],
    requiredOneOfEnv: [["OPENTAG_LINEAR_SMOKE_ISSUE", "OPENTAG_LINEAR_SMOKE_ISSUE_ID"]],
    notes: [
      "Uses a real Linear workspace issue for GraphQL commentCreate and issueUpdate.",
      "By default the token must resolve to a Linear OAuth app actor (viewer.app=true); set OPENTAG_LINEAR_SMOKE_ALLOW_NON_APP_TOKEN=true only for API-key compatibility smoke runs.",
      "Also runs Linear metadata discovery for teams, users, workflow states, and labels, then verifies mapping generation.",
      "OPENTAG_LINEAR_SMOKE_ISSUE accepts a Linear issue key, model UUID, or issue URL; OPENTAG_LINEAR_SMOKE_ISSUE_ID remains supported for compatibility.",
      "The script registers a temporary relay installation and submits signed webhook payloads locally to the fixed /linear/oauth/webhooks hosted OAuth path, so no public tunnel is required for this smoke.",
      "Optionally set OPENTAG_LINEAR_SMOKE_AGENT_SESSION_ID to validate AgentSessionEvent created/prompted, queued follow-up promotion, agentSessionUpdate, and agentActivityCreate.",
      "Optionally set OPENTAG_LINEAR_SMOKE_OAUTH_WEBHOOK_SECRET, OPENTAG_LINEAR_SMOKE_OAUTH_WEBHOOK_PATH, or OPENTAG_LINEAR_SMOKE_ORGANIZATION_ID to match a specific hosted OAuth relay setup.",
      "Set OPENTAG_LINEAR_SMOKE_GRAPHQL_URL only when testing a non-default Linear GraphQL endpoint."
    ]
  }
];

function usage() {
  return [
    "Usage: node scripts/test/live-e2e-smoke.mjs [options]",
    "",
    "Options:",
    "  --case <id>         Select a case. Repeat or pass comma-separated ids.",
    "  --all               Select every case.",
    "  --dry-run           Print plan and preflight without executing commands.",
    "  --allow-missing     Skip selected cases with missing commands/env instead of failing.",
    "  --report <path>     Write a JSON report.",
    "  --json              Print JSON instead of text.",
    "  --list              List cases and exit.",
    "  --help              Show this help.",
    "",
    "Cases:",
    ...cases.map((testCase) => `  ${testCase.id}${testCase.live ? " (live)" : " (local)"} - ${testCase.label}`)
  ].join("\n");
}

function parseArgs(argv) {
  const selected = new Set();
  const options = {
    all: false,
    allowMissing: false,
    dryRun: false,
    json: false,
    list: false,
    reportPath: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--allow-missing") {
      options.allowMissing = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--case") {
      const value = argv[index + 1];
      if (!value) throw new Error("--case requires a value.");
      for (const id of value.split(",")) selected.add(id.trim());
      index += 1;
      continue;
    }
    if (arg === "--report") {
      const value = argv[index + 1];
      if (!value) throw new Error("--report requires a value.");
      options.reportPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { ...options, selected };
}

function commandExists(command) {
  const result = spawnSync("command", ["-v", command], {
    cwd: rootDir,
    shell: true,
    stdio: "ignore"
  });
  return result.status === 0;
}

function envPresent(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

function envRequirementMet(requirement) {
  const [name, expected] = requirement.split("=");
  if (!name) return false;
  if (expected === undefined) return envPresent(name);
  return process.env[name]?.trim().toLowerCase() === expected.toLowerCase();
}

function preflight(testCase) {
  const missing = [];
  const warnings = [];

  for (const command of testCase.requiredCommands ?? []) {
    if (!commandExists(command)) missing.push(`command:${command}`);
  }
  for (const envName of testCase.requiredEnv ?? []) {
    if (!envPresent(envName)) missing.push(`env:${envName}`);
  }
  for (const alternatives of testCase.requiredOneOfEnv ?? []) {
    if (!alternatives.some(envRequirementMet)) missing.push(`env:${alternatives.join("|")}`);
  }
  for (const command of testCase.optionalCommands ?? []) {
    if (!commandExists(command)) warnings.push(`optional command missing: ${command}`);
  }

  return { missing, warnings };
}

function selectedCases(options) {
  if (options.list) return [];
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  if (options.all) return cases;
  if (options.selected.size === 0) return [];
  const output = [];
  for (const id of options.selected) {
    const testCase = byId.get(id);
    if (!testCase) {
      throw new Error(`Unknown case: ${id}. Run with --list to see available cases.`);
    }
    output.push(testCase);
  }
  return output;
}

async function runCommand(command) {
  const startedAt = Date.now();
  const child = spawn(command, {
    cwd: rootDir,
    env: process.env,
    shell: true,
    stdio: "inherit"
  });
  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  return {
    exitCode,
    durationMs: Date.now() - startedAt
  };
}

function renderText(report) {
  const lines = [
    `Live E2E smoke harness: ${report.selectedCases.length} selected case(s)`,
    `Started: ${report.startedAt}`,
    ""
  ];
  if (report.selectedCases.length === 0) {
    lines.push("No cases selected. Use --case <id>, --all, or --list.");
    return lines.join("\n");
  }

  for (const result of report.results) {
    lines.push(`${result.status.toUpperCase()} ${result.id}: ${result.label}`);
    lines.push(`  command: ${result.command}`);
    if (result.missing.length > 0) lines.push(`  missing: ${result.missing.join(", ")}`);
    if (result.warnings.length > 0) lines.push(`  warnings: ${result.warnings.join(", ")}`);
    if (result.notes.length > 0) lines.push(...result.notes.map((note) => `  note: ${note}`));
    if (typeof result.durationMs === "number") lines.push(`  durationMs: ${result.durationMs}`);
    if (typeof result.exitCode === "number") lines.push(`  exitCode: ${result.exitCode}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function writeReport(path, report) {
  const absolute = resolve(rootDir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    console.log(usage());
    return;
  }

  const selected = selectedCases(options);
  const report = {
    ok: true,
    dryRun: options.dryRun,
    startedAt: new Date().toISOString(),
    selectedCases: selected.map((testCase) => testCase.id),
    results: []
  };

  for (const testCase of selected) {
    const { missing, warnings } = preflight(testCase);
    const result = {
      id: testCase.id,
      label: testCase.label,
      live: testCase.live,
      command: testCase.command,
      status: "planned",
      missing,
      warnings,
      notes: testCase.notes ?? []
    };

    if (missing.length > 0) {
      if (options.allowMissing) {
        result.status = "skipped";
        report.results.push(result);
        continue;
      }
      result.status = "failed";
      report.ok = false;
      report.results.push(result);
      continue;
    }

    if (options.dryRun) {
      result.status = "planned";
      report.results.push(result);
      continue;
    }

    const execution = await runCommand(testCase.command);
    result.exitCode = execution.exitCode;
    result.durationMs = execution.durationMs;
    result.status = execution.exitCode === 0 ? "passed" : "failed";
    if (execution.exitCode !== 0) report.ok = false;
    report.results.push(result);
  }

  report.finishedAt = new Date().toISOString();

  if (options.reportPath) {
    writeReport(options.reportPath, report);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
    if (options.reportPath) console.log(`Report: ${resolve(rootDir, options.reportPath)}`);
  }

  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
