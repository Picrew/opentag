#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const cases = [
  {
    id: "permission-boundaries",
    label: "Failure and permission boundary matrix",
    command: [
      "corepack pnpm vitest run",
      "packages/dispatcher/test/admission.test.ts",
      "packages/dispatcher/test/delivery/activation-state.test.ts",
      "packages/dispatcher/test/delivery/provider-registry.test.ts",
      "packages/local-runtime/test/dispatcher.test.ts",
      "packages/local-runtime/test/daemon-security.test.ts",
      "packages/slack/test/socket-mode.test.ts",
      "packages/lark/test/registration.test.ts"
    ].join(" "),
    covers: [
      "public repository default denial without write access",
      "allowedActors allow and deny behavior",
      "GitHub apply token disabled without enabling outbound delivery",
      "GitLab ingress and apply token configuration",
      "Slack terminal auth and bot permission failures",
      "Lark credential and bot permission failures",
      "daemon Project Target allowlist enforcement"
    ],
    requiredCommands: ["corepack"]
  },
  {
    id: "source-thread-controls",
    label: "Source-thread command matrix",
    command: [
      "corepack pnpm vitest run",
      "packages/github/test/ingress.test.ts",
      "packages/gitlab/test/ingress.test.ts",
      "packages/lark/test/inbound.test.ts",
      "packages/slack/test/socket-mode.test.ts",
      "packages/dispatcher/test/server.test.ts",
      "packages/cli/test/platform-contract.test.ts"
    ].join(" "),
    covers: [
      "GitHub and GitLab action replies enter submitThreadAction",
      "Slack message replies and buttons enter submitThreadAction",
      "Lark message replies and card buttons enter submitThreadAction",
      "apply 1 creates an apply plan or direct provider write",
      "reject 1 records a rejection without external writes",
      "continue 1 creates a governed child run",
      "stop cancels active source-thread work without auto-promoting queued follow-ups",
      "duplicate and concurrent action replies are idempotent"
    ],
    requiredCommands: ["corepack"]
  },
  {
    id: "recovery-idempotency",
    label: "Daemon, dispatcher, replay, and delivery-kernel recovery matrix",
    command: [
      "corepack pnpm vitest run",
      "packages/store/test/repository.test.ts",
      "packages/store/test/delivery-journal.test.ts",
      "packages/dispatcher/test/admission.test.ts",
      "packages/dispatcher/test/delivery/side-effect-kernel.test.ts",
      "packages/dispatcher/test/delivery/slack-restart-faults.test.ts",
      "packages/dispatcher/test/server.test.ts",
      "apps/opentagd/test/daemon.test.ts",
      "apps/opentagd/test/integration.test.ts",
      "packages/cli/test/status.test.ts"
    ].join(" "),
    covers: [
      "leases expire and runs are claimable after runner loss",
      "runner running/progress/complete retries dedupe by idempotency key",
      "duplicate source events and source deliveries replay without duplicate runs",
      "delivery-intent dedupe, fenced retry, restart recovery, and suppression",
      "daemon heartbeats while executors run",
      "daemon cancellation when control plane no longer owns the run",
      "hard timeout cancellation and failure completion",
      "status output preserves ledger evidence after failure or cancellation"
    ],
    requiredCommands: ["corepack"]
  },
  {
    id: "artifact-ledger-quality",
    label: "Artifact, status, receipt, and ledger quality matrix",
    command: [
      "corepack pnpm vitest run",
      "packages/cli/test/status.test.ts",
      "packages/dispatcher/test/replay-harness.test.ts",
      "packages/github/test/render.test.ts",
      "packages/gitlab/test/render.test.ts",
      "packages/slack/test/render.test.ts",
      "packages/lark/test/render.test.ts"
    ].join(" "),
    covers: [
      "status output includes Context Packet-adjacent provenance, Agent Work Ledger, artifacts, queued delivery intents, activation blocks, and apply outcome metrics",
      "final source-thread receipts stay concise and point to local audit/status instead of raw executor logs",
      "artifact snapshots keep sourceRunId and machine-addressable artifact types",
      "GitHub, GitLab, Slack, and Lark render action receipts without leaking internal proposal or intent identifiers"
    ],
    requiredCommands: ["corepack"]
  },
  {
    id: "apply-failure-ux",
    label: "Apply cleanup and failure experience matrix",
    command: [
      "corepack pnpm vitest run",
      "packages/dispatcher/test/server.test.ts",
      "apps/opentagd/test/pr.test.ts",
      "packages/github/test/pull-request.test.ts",
      "packages/gitlab/test/apply.test.ts"
    ].join(" "),
    covers: [
      "branch already exists and isolated branch readiness are represented as setup or executor conditions",
      "missing source or target branches keep apply disabled before external writes",
      "GitHub PR and GitLab MR create failures fall back to child runs with quiet source-thread receipts",
      "repeated apply replies do not create duplicate PRs or MRs",
      "failed direct apply records apply outcomes while keeping provider tokens and raw headers out of presentations"
    ],
    requiredCommands: ["corepack"]
  },
  {
    id: "replay-parity",
    label: "Replay versus live parity fixture matrix",
    command: "corepack pnpm vitest run packages/dispatcher/test/replay-harness.test.ts",
    covers: [
      "GitHub, Slack, GitLab, and Lark live-shaped source events replay fully in memory",
      "replay preserves receipt, artifact, ledger, delivery-intent, and executor-capability strategy",
      "live-derived fixtures are sanitized before entering the regression harness"
    ],
    requiredCommands: ["corepack"]
  },
  {
    id: "completion-governance",
    label: "GitHub completion governance loop",
    command: [
      "corepack pnpm vitest run",
      "packages/dispatcher/test/completion-governance-replay.test.ts",
      "packages/dispatcher/test/completion-governance.test.ts",
      "packages/github/test/completion-evidence.test.ts",
      "packages/cli/test/completion.test.ts",
      "packages/cli/test/status.test.ts",
      "packages/cli/test/release-package-plan.test.ts"
    ].join(" "),
    covers: [
      "GitHub admission, Context Packet, durable WorkThread, and fenced local attempt",
      "executor success remains pending before current-head provider evidence",
      "verified required checks and merge append a superseding satisfied assessment",
      "duplicate evidence is replay-safe and source-thread projection stays quiet",
      "CLI completion explanation, durable success metric, restart recovery, and packed publication set"
    ],
    requiredCommands: ["corepack"]
  },
  {
    id: "work-loop-actions",
    label: "Governed WorkLoop action and attention matrix",
    command: [
      "corepack pnpm vitest run",
      "packages/governance/test/evaluate.test.ts",
      "packages/dispatcher/test/completion-governance-replay.test.ts",
      "packages/dispatcher/test/completion-governance.test.ts",
      "packages/client/test/client.test.ts",
      "packages/cli/test/status.test.ts"
    ].join(" "),
    covers: [
      "completion gates, human escalations, material actions, and run outcomes produce structured causes",
      "ActionHint primitives select refresh, reconcile, human decision, resume, reassess, or no action",
      "WorkThread completion and bounded attention endpoints expose the same canonical WorkLoop view",
      "active and terminal loops stay out of attention results",
      "CLI text and JSON preserve human-readable summaries plus machine-readable hints and causes",
      "the sanitized completion golden loop transitions from evidence refresh to no action"
    ],
    requiredCommands: ["corepack"]
  },
  {
    id: "privacy-redaction",
    label: "Delivery, report, status, and artifact privacy scan",
    command: [
      "node scripts/test/privacy-redaction-scan.mjs",
      "--allow-missing",
      "--path packages/dispatcher/test/fixtures/replay",
      "--path docs/governance-validation-matrix.md",
      "--path docs/replay-harness.md",
      "--path docs/npm-release.md",
      "--path .omx/live-e2e",
      "--path .omx/governance-matrix"
    ].join(" "),
    covers: [
      "replay fixtures, public governance documentation, and live/governance reports do not contain token-like values",
      "private keys, webhook secrets, Slack bot tokens, GitHub/GitLab tokens, full Lark message ids, and local absolute paths are rejected",
      "scan output redacts matched excerpts before printing them"
    ],
    requiredCommands: ["node"]
  }
];

function usage() {
  return [
    "Usage: node scripts/test/governance-matrix.mjs [options]",
    "",
    "Options:",
    "  --case <id>         Select a case. Repeat or pass comma-separated ids.",
    "  --all               Select every case.",
    "  --dry-run           Print plan and preflight without executing commands.",
    "  --allow-missing     Skip selected cases with missing commands instead of failing.",
    "  --report <path>     Write a JSON report.",
    "  --json              Print JSON instead of text.",
    "  --list              List cases and exit.",
    "  --help              Show this help.",
    "",
    "Cases:",
    ...cases.map((testCase) => `  ${testCase.id} - ${testCase.label}`)
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
      for (const id of value.split(",")) {
        if (id.trim()) selected.add(id.trim());
      }
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

function preflight(testCase) {
  const missing = [];
  for (const command of testCase.requiredCommands ?? []) {
    if (!commandExists(command)) missing.push(`command:${command}`);
  }
  return { missing, warnings: [] };
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
    `Governance matrix harness: ${report.selectedCases.length} selected case(s)`,
    `Started: ${report.startedAt}`,
    ""
  ];

  if (report.selectedCases.length === 0) {
    lines.push("No cases selected. Use --case <id>, --all, or --list.");
    return lines.join("\n");
  }

  for (const result of report.results) {
    lines.push(`${result.status.toUpperCase()} ${result.id} - ${result.label}`);
    lines.push(`  command: ${result.command}`);
    if (result.covers.length > 0) {
      lines.push("  covers:");
      for (const item of result.covers) lines.push(`    - ${item}`);
    }
    if (result.preflight.missing.length > 0) {
      lines.push(`  missing: ${result.preflight.missing.join(", ")}`);
    }
    if (typeof result.exitCode === "number") {
      lines.push(`  exitCode: ${result.exitCode} durationMs: ${result.durationMs}`);
    }
    lines.push("");
  }

  lines.push(`Overall: ${report.ok ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    console.log(usage());
    return;
  }

  const selected = selectedCases(options);
  const report = {
    startedAt: new Date().toISOString(),
    selectedCases: selected.map((testCase) => testCase.id),
    dryRun: options.dryRun,
    ok: true,
    results: []
  };

  for (const testCase of selected) {
    const preflightResult = preflight(testCase);
    const baseResult = {
      id: testCase.id,
      label: testCase.label,
      command: testCase.command,
      covers: testCase.covers,
      preflight: preflightResult
    };

    if (preflightResult.missing.length > 0) {
      const status = options.allowMissing ? "skipped" : "failed";
      report.results.push({ ...baseResult, status, exitCode: null, durationMs: 0 });
      if (!options.allowMissing) report.ok = false;
      continue;
    }

    if (options.dryRun) {
      report.results.push({ ...baseResult, status: "planned", exitCode: null, durationMs: 0 });
      continue;
    }

    const run = await runCommand(testCase.command);
    const status = run.exitCode === 0 ? "passed" : "failed";
    report.results.push({ ...baseResult, status, ...run });
    if (run.exitCode !== 0) report.ok = false;
  }

  report.completedAt = new Date().toISOString();

  if (options.reportPath) {
    const outputPath = resolve(rootDir, options.reportPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
  }

  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
