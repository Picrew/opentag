#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { createDispatcherAdminClient } from "@opentag/client";
import { Command } from "commander";
import {
  createInitialConfig,
  effectiveMaxConcurrentRuns,
  formatConfigError,
  loadConfigFromEnv,
  normalizeChannelBindings
} from "./config.js";
import { runOneDaemonIteration, serveDaemon } from "./daemon.js";
import { doctorHasFailures, formatDoctorChecks, runDoctor } from "./doctor.js";
import { createDaemonRuntimeInput, executorsFromConfig, runnerExecutorRegistrations } from "./runtime.js";

const program = new Command();
const databasePath = process.env.OPENTAG_DATABASE_PATH ?? "opentag.db";

function loadConfigOrExit() {
  try {
    const config = loadConfigFromEnv();
    normalizeChannelBindings(config);
    return config;
  } catch (error) {
    console.error(`Invalid OpenTag daemon config:\n${formatConfigError(error)}`);
    process.exit(1);
  }
}

async function bindConfiguredProjectTargets(): Promise<void> {
  const config = loadConfigOrExit();
  const client = createDispatcherAdminClient({
    dispatcherUrl: config.dispatcherUrl,
    runnerId: config.runnerId,
    ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
  });
  for (const repository of config.repositories) {
    await client.bindRepository({
      provider: repository.provider,
      owner: repository.owner,
      repo: repository.repo,
      checkoutPath: repository.checkoutPath,
      defaultExecutor: repository.defaultExecutor
    });
    console.log(`Bound Project Target ${repository.provider}:${repository.owner}/${repository.repo} to ${repository.checkoutPath}`);
  }
  if (config.repositories.length === 0) {
    console.log("No Project Targets configured. Set OPENTAG_CONFIG_PATH or OPENTAG_REPO_OWNER/OPENTAG_REPO_NAME/OPENTAG_WORKSPACE_PATH.");
  }
}

program
  .name("opentagd")
  .description("OpenTag local daemon");

program
  .command("init")
  .description("Create a minimal OpenTag local daemon config")
  .requiredOption("--owner <owner>", "GitHub repository owner")
  .requiredOption("--repo <repo>", "GitHub repository name")
  .requiredOption("--checkout <path>", "Local checkout path")
  .option("--output <path>", "Config file path", "opentag.local.json")
  .option("--runner-id <id>", "Runner id", "runner_local")
  .option("--dispatcher-url <url>", "Dispatcher URL", "http://localhost:3030")
  .option("--pairing-token <token>", "Dispatcher pairing token")
  .option("--runner-token <token>", "Runner-scoped dispatcher token for claim/progress/completion")
  .option("--executor <executor>", "Default executor: echo, codex, claude-code, cursor, opencode, hermes, or openclaw", "echo")
  .option("--base-branch <branch>", "Base branch for PR creation", "main")
  .option("--push-remote <remote>", "Git remote for PR branches", "origin")
  .option("--worktree-root <path>", "Directory for Codex run worktrees")
  .option("--keep-worktree <policy>", "Worktree retention: always, on_failure, or never", "on_failure")
  .action((options: {
    owner: string;
    repo: string;
    checkout: string;
    output: string;
    runnerId: string;
    dispatcherUrl: string;
    pairingToken?: string;
    runnerToken?: string;
    executor: "echo" | "codex" | "claude-code" | "cursor" | "opencode" | "hermes" | "openclaw";
    baseBranch: string;
    pushRemote: string;
    worktreeRoot?: string;
    keepWorktree: "always" | "on_failure" | "never";
  }) => {
    try {
      const config = createInitialConfig({
        owner: options.owner,
        repo: options.repo,
        checkoutPath: options.checkout,
        runnerId: options.runnerId,
        dispatcherUrl: options.dispatcherUrl,
        ...(options.pairingToken ? { pairingToken: options.pairingToken } : {}),
        ...(options.runnerToken ? { runnerToken: options.runnerToken } : {}),
        executor: options.executor,
        baseBranch: options.baseBranch,
        pushRemote: options.pushRemote,
        ...(options.worktreeRoot ? { worktreeRoot: options.worktreeRoot } : {}),
        keepWorktree: options.keepWorktree
      });
      writeFileSync(options.output, `${JSON.stringify(config, null, 2)}\n`);
      chmodSync(options.output, 0o600);
      console.log(`Wrote OpenTag config to ${options.output}`);
    } catch (error) {
      console.error(`Could not create config:\n${formatConfigError(error)}`);
      process.exit(1);
    }
  });

program
  .command("register-runner")
  .description("Register this local daemon with the dispatcher")
  .action(async () => {
    const config = loadConfigOrExit();
    await createDispatcherAdminClient({
      dispatcherUrl: config.dispatcherUrl,
      runnerId: config.runnerId,
      ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
    }).registerRunner(config.runnerId, {
      locality: "local",
      executors: runnerExecutorRegistrations(executorsFromConfig(config)),
      maxConcurrentRuns: effectiveMaxConcurrentRuns(config)
    });
    console.log(`Registered OpenTag runner ${config.runnerId}`);
  });

program
  .command("bind-project-targets")
  .description("Sync configured Project Target bindings to the dispatcher")
  .action(bindConfiguredProjectTargets);

program
  .command("bind-repos", { hidden: true })
  .description("Compatibility alias for bind-project-targets")
  .action(bindConfiguredProjectTargets);

program
  .command("bind-slack-channels")
  .description("Sync configured Slack channel bindings to the dispatcher")
  .action(async () => {
    const config = loadConfigOrExit();
    const client = createDispatcherAdminClient({
      dispatcherUrl: config.dispatcherUrl,
      runnerId: config.runnerId,
      ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
    });
    for (const binding of config.slackChannels ?? []) {
      await client.bindChannel({
        provider: "slack",
        accountId: binding.teamId,
        conversationId: binding.channelId,
        repoProvider: binding.repoProvider,
        owner: binding.owner,
        repo: binding.repo
      });
      console.log(`Bound Slack ${binding.teamId}/${binding.channelId} to ${binding.owner}/${binding.repo}`);
    }
    if (!(config.slackChannels?.length ?? 0)) {
      console.log("No Slack channels configured.");
    }
  });

program
  .command("bind-channels")
  .description("Sync configured generic channel bindings to the dispatcher")
  .action(async () => {
    const config = loadConfigOrExit();
    const client = createDispatcherAdminClient({
      dispatcherUrl: config.dispatcherUrl,
      runnerId: config.runnerId,
      ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
    });
    const bindings = normalizeChannelBindings(config);
    for (const binding of bindings) {
      await client.bindChannel({
        provider: binding.provider,
        accountId: binding.accountId,
        conversationId: binding.conversationId,
        ...(binding.repoProvider && binding.owner && binding.repo
          ? { repoProvider: binding.repoProvider, owner: binding.owner, repo: binding.repo }
          : {}),
        ...(binding.metadata ? { metadata: binding.metadata } : {}),
        ...(binding.ownership ? { ownership: binding.ownership } : {})
      });
      const target = binding.repoProvider && binding.owner && binding.repo
        ? `${binding.repoProvider}:${binding.owner}/${binding.repo}`
        : "general agent execution";
      console.log(
        `Bound ${binding.provider}:${binding.accountId}/${binding.conversationId} to ${target}`
      );
    }
    if (!bindings.length) {
      console.log("No channel bindings configured.");
    }
  });

program
  .command("bind-lark-channels")
  .description("Sync configured Lark channel bindings to the dispatcher")
  .action(async () => {
    const config = loadConfigOrExit();
    const client = createDispatcherAdminClient({
      dispatcherUrl: config.dispatcherUrl,
      runnerId: config.runnerId,
      ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
    });
    for (const binding of config.larkChannels ?? []) {
      await client.bindChannel({
        provider: "lark",
        accountId: binding.tenantKey,
        conversationId: binding.chatId,
        repoProvider: binding.repoProvider,
        owner: binding.owner,
        repo: binding.repo
      });
      console.log(`Bound Lark ${binding.tenantKey}/${binding.chatId} to ${binding.owner}/${binding.repo}`);
    }
    if (!(config.larkChannels?.length ?? 0)) {
      console.log("No Lark channels configured.");
    }
  });

program
  .command("doctor")
  .description("Check dispatcher, bindings, checkouts, and executors")
  .action(async () => {
    const config = loadConfigOrExit();
    const checks = await runDoctor({
      config,
      executors: executorsFromConfig(config)
    });
    console.log(formatDoctorChecks(checks));
    if (doctorHasFailures(checks)) {
      process.exit(1);
    }
  });

program
  .command("run-once")
  .description("Claim and execute one run if available")
  .action(async () => {
    const config = loadConfigOrExit();
    const runtime = createDaemonRuntimeInput(config, { databasePath });
    if (runtime.mode === "control-v1-sidecar") {
      await runtime.controlLoop.close();
      throw new Error(
        "opentagd run-once is unavailable for Hosted Control V1; use opentagd serve to run the context/readiness/outbox sidecar."
      );
    }
    const didWork = await runOneDaemonIteration(runtime);
    console.log(didWork ? "OpenTag run completed" : "No OpenTag run available");
  });

program
  .command("serve")
  .description("Continuously poll for and execute OpenTag runs")
  .action(async () => {
    const config = loadConfigOrExit();
    await serveDaemon(createDaemonRuntimeInput(config, { databasePath }));
  });

await program.parseAsync(process.argv);
