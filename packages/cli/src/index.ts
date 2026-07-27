#!/usr/bin/env node
import { Command } from "commander";
import {
  defaultConfigPath,
  formatCliConfigError,
  readRedactedCliConfig
} from "./config.js";
import { runExecutorsCommand } from "./commands/executors.js";
import { runPlatformsCommand } from "./commands/platforms.js";
import { runCancelCommand } from "./cancel.js";
import {
  runCompletionAcknowledgeCommand,
  runCompletionEscalationsCommand,
  runCompletionResolveCommand,
  runCompletionWaiveCommand
} from "./completion.js";
import { runDoctorCommand } from "./doctor.js";
import {
  runFactoryBatchGetCommand,
  runFactoryBatchSubmitCommand,
  runFactoryRecipeCreateCommand,
  runFactoryRecipeGetCommand,
  runFactoryWorkThreadEnsureCommand,
  runFactoryWorkstreamCreateCommand,
  runFactoryWorkstreamGetCommand
} from "./factory.js";
import { runIngestCommand, runIngestTemplateCommand } from "./ingest.js";
import { runMaintenancePruneSourceDeliveriesCommand } from "./maintenance.js";
import { runPairCommand } from "./pair.js";
import {
  runServiceAutostartDisableCommand,
  runServiceAutostartEnableCommand,
  runServiceInstallCommand,
  runServiceLogsCommand,
  runServiceRestartCommand,
  runServiceRunCommand,
  runServiceStartCommand,
  runServiceStatusCommand,
  runServiceStopCommand,
  runServiceUninstallCommand
} from "./service.js";
import { runSetupCommand } from "./commands/setup.js";
import { runStartCommand } from "./start.js";
import { runStatusCommand } from "./status.js";
import { CLI_VERSION } from "./version.js";

const program = new Command();

program.version(CLI_VERSION);

function handleError(error: unknown): never {
  console.error(formatCliConfigError(error));
  process.exit(1);
}

function runCliAction<T extends unknown[]>(handler: (...args: T) => Promise<void> | void): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await handler(...args);
    } catch (error) {
      handleError(error);
    }
  };
}

program.name(process.env.OPENTAG_CLI_NAME?.trim() || "opentag").description("OpenTag CLI");

program
  .command("setup")
  .description("Create a local OpenTag config")
  .option("--platform <platform>", "Platform to configure")
  .option("--config <path>", "Config file path")
  .option("--project <path>", "Project checkout path")
  .option("--language <language>", "Setup language: en or zh-CN")
  .option("--executor <executor>", "Default executor: echo, codex, claude-code, cursor, opencode, hermes, or openclaw")
  .option("--hermes-command <command>", "Hermes CLI command")
  .option("--hermes-profile <profile>", "Fixed, pre-existing Hermes profile (default: opentag)")
  .option("--agent-profile <profile>", "Executor-neutral agent session profile")
  .option("--agent-profile-template <template>", "Executor-neutral agent session profile template")
  .option("--lark-setup <method>", "Lark setup method: saved, scan, or manual")
  .option("--lark-app-id <id>", "Lark app id")
  .option("--lark-app-secret <secret>", "Lark app secret")
  .option("--tenant <tenant>", "Manual Lark / Feishu tenant: feishu or lark")
  .option("--lark-bot-open-id <openId>", "Lark bot open id for group mentions")
  .option("--slack-mode <mode>", "Slack connection mode: socket_mode or events_api")
  .option("--slack-app-token <token>", "Slack app-level token for Socket Mode")
  .option("--slack-signing-secret <secret>", "Slack signing secret")
  .option("--slack-bot-token <token>", "Slack bot user OAuth token")
  .option("--slack-app-id <id>", "Slack app id")
  .option("--slack-team-id <id>", "Slack team id")
  .option("--slack-channel-id <id>", "Slack channel id")
  .option("--slack-port <port>", "Local Slack Events API port")
  .option("--github-token <token>", "GitHub token for comments and apply-1 pull requests")
  .option("--github-webhook-secret <secret>", "GitHub webhook secret; generated when omitted")
  .option("--github-repository <ownerRepo>", "GitHub repository as owner/repo")
  .option("--github-webhook-path <path>", "GitHub webhook path")
  .option("--github-port <port>", "Local GitHub webhook port")
  .option("--github-auto-create-pr", "Create pull requests immediately after runs")
  .option("--no-github-auto-create-pr", "Use the default apply-1 pull request flow")
  .option("--gitlab-token <token>", "GitLab access token for source-thread replies")
  .option("--gitlab-project <path>", "GitLab project path, for example group/subgroup/project")
  .option("--gitlab-base-url <url>", "GitLab instance base URL")
  .option("--gitlab-webhook-secret <secret>", "GitLab webhook secret token; generated when omitted")
  .option("--gitlab-webhook-path <path>", "GitLab webhook path")
  .option("--gitlab-port <port>", "Local GitLab webhook port")
  .option("--linear-auth <method>", "Linear auth method: oauth_app or api_key")
  .option("--linear-token <token>", "Linear API key for source-thread replies")
  .option("--linear-oauth-client-id <id>", "Linear OAuth app client id")
  .option("--linear-oauth-client-secret <secret>", "Linear OAuth app client secret")
  .option("--linear-oauth-redirect-uri <uri>", "Linear OAuth app redirect URI")
  .option("--linear-oauth-code <code>", "Linear OAuth authorization code")
  .option("--linear-oauth-access-token <token>", "Linear OAuth access token, when exchanged outside setup")
  .option("--linear-oauth-refresh-token <token>", "Linear OAuth refresh token, when exchanged outside setup")
  .option("--linear-oauth-expires-at <iso>", "Linear OAuth access-token expiry timestamp")
  .option("--linear-oauth-scopes <scopes>", "Linear OAuth scopes, comma- or space-separated")
  .option("--linear-oauth-state <state>", "Linear OAuth state value")
  .option("--linear-discover-metadata", "Discover Linear teams, states, users, and labels during setup")
  .option("--no-linear-discover-metadata", "Skip Linear metadata discovery during setup")
  .option("--linear-discovery-limit <n>", "Linear metadata discovery page size")
  .option("--linear-team-id <id>", "Linear team id")
  .option("--linear-team-key <key>", "Linear team key")
  .option("--linear-webhook-secret <secret>", "Linear webhook signing secret; generated when omitted")
  .option("--linear-webhook-path <path>", "Linear webhook path")
  .option("--linear-port <port>", "Local Linear webhook port")
  .option("--linear-graphql-url <url>", "Linear GraphQL endpoint override")
  .option("--telegram-mode <mode>", "Telegram delivery mode: polling or webhook")
  .option("--telegram-bot-token <token>", "Telegram bot token from BotFather")
  .option("--telegram-bot-id <id>", "Telegram bot id; derived from the bot token when omitted")
  .option("--telegram-bot-username <username>", "Telegram bot username for group mentions")
  .option("--telegram-secret-token <secret>", "Telegram webhook secret token; generated when omitted")
  .option("--telegram-binding-admin-user-ids <ids>", "Comma-separated Telegram user ids allowed to bind/unbind group chats")
  .option("--telegram-callback-uri <uri>", "Telegram callback URI override")
  .option("--discord-mode <mode>", "Discord delivery mode: gateway or webhook")
  .option("--discord-public-key <key>", "Discord application public key for webhook mode")
  .option("--discord-bot-token <token>", "Discord bot token for channel replies")
  .option("--discord-webhook-path <path>", "Discord interactions webhook path")
  .option("--teams-app-id <id>", "Microsoft Teams app id")
  .option("--teams-app-password <password>", "Microsoft Teams app password")
  .option("--teams-tenant-id <id>", "Microsoft Teams tenant id (optional; single-tenant apps)")
  .option("--teams-webhook-path <path>", "Microsoft Teams messaging webhook path")
  .option("--binding <method>", "Binding method: default_project or bind_later")
  .option("--force", "Overwrite an existing config")
  .option("--relay <url>", "Configure this setup to use a trusted remote relay instead of local public tunnels")
  .option("--start", "Start OpenTag immediately after setup")
  .option("--no-start", "Do not ask to start OpenTag after setup")
  .option("--service", "Install and start OpenTag as a background service after setup")
  .option("-y, --yes", "Skip setup confirmation")
  .action(runCliAction(runSetupCommand));

program
  .command("pair")
  .description("Pair this local runner with a remote relay")
  .option("--config <path>", "Config file path")
  .option("--relay <url>", "Remote relay dispatcher URL")
  .option("--no-register", "Update config without registering runner and project targets")
  .action(runCliAction(runPairCommand));

program
  .command("start")
  .description("Start the local OpenTag stack")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runStartCommand));

program
  .command("status")
  .description("Show the local OpenTag status")
  .option("--config <path>", "Config file path")
  .option("--run <runId>", "Show audit details for one run")
  .option("--channel <provider:account/conversation>", "Show active run and queued follow-ups for one source container")
  .option("--workstream <workstreamId>", "Show budget and accepted-outcome health for one factory workstream")
  .option("--json", "Print structured --workstream status as JSON")
  .action(runCliAction(runStatusCommand));

program
  .command("cancel")
  .description("Request cancellation for a run or the active run in a source container")
  .option("--config <path>", "Config file path")
  .option("--run <runId>", "Cancel one run by id")
  .option("--channel <provider:account/conversation>", "Cancel the active run for one source container")
  .option("--reason <reason>", "Audit reason for cancellation")
  .option("--requested-by <actor>", "Audit actor requesting cancellation")
  .action(runCliAction(runCancelCommand));

const factoryCommand = program.command("factory").description("Operate recipe-driven software factory workstreams");

const factoryWorkThreadCommand = factoryCommand.command("work-thread").description("Ensure external work threads are available to factory workstreams");

factoryWorkThreadCommand
  .command("ensure")
  .description("Ensure a durable WorkThread from a normalized OpenTag event")
  .option("--config <path>", "Config file path")
  .requiredOption("--input <path>", "Normalized OpenTag event JSON file path, or - for stdin")
  .option("--json", "Print the structured dispatcher response as JSON")
  .action(runCliAction(runFactoryWorkThreadEnsureCommand));

const factoryRecipeCommand = factoryCommand.command("recipe").description("Create or inspect immutable factory recipes");

factoryRecipeCommand
  .command("create")
  .description("Create an immutable factory recipe from a JSON document")
  .option("--config <path>", "Config file path")
  .requiredOption("--input <path>", "Recipe JSON file path, or - for stdin")
  .option("--json", "Print the structured dispatcher response as JSON")
  .action(runCliAction(runFactoryRecipeCreateCommand));

factoryRecipeCommand
  .command("get")
  .description("Get one immutable factory recipe version")
  .option("--config <path>", "Config file path")
  .requiredOption("--id <recipeId>", "Factory recipe id")
  .requiredOption("--version <version>", "Positive recipe version")
  .option("--json", "Print the structured dispatcher response as JSON")
  .action(runCliAction(runFactoryRecipeGetCommand));

const factoryWorkstreamCommand = factoryCommand.command("workstream").description("Create or inspect factory workstreams");

factoryWorkstreamCommand
  .command("create")
  .description("Create a factory workstream from a JSON document")
  .option("--config <path>", "Config file path")
  .requiredOption("--input <path>", "Workstream JSON file path, or - for stdin")
  .option("--json", "Print the structured dispatcher response as JSON")
  .action(runCliAction(runFactoryWorkstreamCreateCommand));

factoryWorkstreamCommand
  .command("get")
  .description("Get one factory workstream")
  .option("--config <path>", "Config file path")
  .requiredOption("--id <workstreamId>", "Factory workstream id")
  .option("--json", "Print the structured dispatcher response as JSON")
  .action(runCliAction(runFactoryWorkstreamGetCommand));

const factoryBatchCommand = factoryCommand.command("batch").description("Submit or inspect restart-safe admission batches");

factoryBatchCommand
  .command("submit")
  .description("Submit a workstream admission batch from a JSON document")
  .option("--config <path>", "Config file path")
  .requiredOption("--input <path>", "Admission batch JSON file path, or - for stdin")
  .option("--json", "Print the structured dispatcher response as JSON")
  .action(runCliAction(runFactoryBatchSubmitCommand));

factoryBatchCommand
  .command("get")
  .description("Get one durable workstream admission batch receipt")
  .option("--config <path>", "Config file path")
  .requiredOption("--id <batchId>", "Admission batch id")
  .option("--json", "Print the structured dispatcher response as JSON")
  .action(runCliAction(runFactoryBatchGetCommand));

const completionCommand = program.command("completion").description("Inspect or govern completion state");

completionCommand
  .command("escalations")
  .description("List attributed human escalations for a run")
  .option("--config <path>", "Config file path")
  .requiredOption("--run <runId>", "Run whose human escalations should be listed")
  .action(runCliAction(runCompletionEscalationsCommand));

completionCommand
  .command("acknowledge")
  .description("Acknowledge a human escalation without resolving it")
  .option("--config <path>", "Config file path")
  .requiredOption("--escalation <escalationId>", "Human escalation id")
  .requiredOption("--actor-provider <provider>", "Provider identifying the human actor")
  .requiredOption("--actor-id <id>", "Stable provider user id for the human actor")
  .option("--actor-handle <handle>", "Human-readable actor handle")
  .option("--acknowledged-at <iso>", "Attributed acknowledgement timestamp; defaults to now")
  .action(runCliAction(runCompletionAcknowledgeCommand));

completionCommand
  .command("resolve")
  .description("Resolve a human escalation with an attributed bounded decision")
  .option("--config <path>", "Config file path")
  .requiredOption("--escalation <escalationId>", "Human escalation id")
  .requiredOption("--actor-provider <provider>", "Provider identifying the human actor")
  .requiredOption("--actor-id <id>", "Stable provider user id for the human actor")
  .option("--actor-handle <handle>", "Human-readable actor handle")
  .option("--option <optionId>", "One option offered by the escalation")
  .option("--reason <reason>", "Auditable resolution reason")
  .option("--resolved-at <iso>", "Attributed resolution timestamp; defaults to now")
  .action(runCliAction(runCompletionResolveCommand));

completionCommand
  .command("waive")
  .description("Apply an attributed waiver to selected gates on the current completion contract")
  .option("--config <path>", "Config file path")
  .requiredOption("--run <runId>", "Run whose WorkThread owns the current completion contract")
  .requiredOption("--gate <gateIds...>", "One or more current completion gate ids")
  .requiredOption("--reason <reason>", "Auditable reason for the waiver")
  .requiredOption("--actor-provider <provider>", "Provider identifying the human actor")
  .requiredOption("--actor-id <id>", "Stable provider user id for the human actor")
  .option("--actor-handle <handle>", "Human-readable actor handle")
  .requiredOption("--scope <scope>", "Waiver scope; Phase 1 requires selected_gates")
  .requiredOption("--policy-scope <scope>", "Contract authority scope for this waiver")
  .option("--waived-at <iso>", "Attributed waiver timestamp; defaults to now")
  .option("--expires-at <iso>", "Optional waiver expiry timestamp")
  .action(runCliAction(runCompletionWaiveCommand));

program
  .command("doctor")
  .description("Check dispatcher, bindings, checkouts, and executors")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runDoctorCommand));

program
  .command("ingest")
  .description("Ingest a fenced local external agent progress or completion event")
  .option("--config <path>", "Config file path")
  .requiredOption("--run <runId>", "OpenTag run id")
  .requiredOption("--event <event>", "Event: progress, post_llm_call, before_agent_finalize, agent_end, failed, cancelled, timed_out, or interrupted")
  .option("--source <source>", "External agent runtime source label")
  .option("--message <message>", "Progress or completion summary")
  .option("--type <type>", "Progress event type")
  .option("--idempotency-key <key>", "Stable replay-protection key for retrying the same progress event")
  .option("--result-json <json>", "Complete run with an OpenTagRunResult JSON object")
  .option("--conclusion <conclusion>", "Completion conclusion when --result-json is omitted")
  .option("--summary <summary>", "Completion summary when --result-json is omitted")
  .action(runCliAction(runIngestCommand));

program
  .command("ingest-template")
  .description("Print a shell template or manifest for local external agent hook ingest")
  .option("--source <source>", "External agent runtime source label")
  .option("--command <command>", "OpenTag CLI command to use in the template")
  .option("--format <format>", "Template format: shell or manifest")
  .action(runCliAction(runIngestTemplateCommand));

const serviceCommand = program.command("service").description("Install and control the OpenTag background service");

serviceCommand
  .command("install")
  .description("Install the OpenTag background service")
  .option("--config <path>", "Config file path")
  .option("--max-request-body-bytes <bytes>", "Persist dispatcher request body limit in the service definition")
  .option("--rate-limit-window-ms <ms>", "Persist dispatcher rate-limit window in the service definition")
  .option("--rate-limit-max-requests <n>", "Persist dispatcher rate-limit max requests in the service definition")
  .option("--rate-limit-disabled", "Persist an explicit disabled dispatcher rate-limit state in the service definition")
  .action(runCliAction(runServiceInstallCommand));

serviceCommand
  .command("start")
  .description("Start the OpenTag background service")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runServiceStartCommand));

serviceCommand
  .command("stop")
  .description("Stop the OpenTag background service")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runServiceStopCommand));

serviceCommand
  .command("restart")
  .description("Restart the OpenTag background service")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runServiceRestartCommand));

serviceCommand
  .command("status")
  .description("Show the OpenTag background service status")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runServiceStatusCommand));

serviceCommand
  .command("logs")
  .description("Show recent OpenTag background service logs")
  .option("--config <path>", "Config file path")
  .option("--lines <n>", "Number of lines per log file")
  .action(runCliAction(runServiceLogsCommand));

serviceCommand
  .command("uninstall")
  .description("Uninstall the OpenTag background service")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runServiceUninstallCommand));

const autostartCommand = serviceCommand.command("autostart").description("Control OpenTag service login autostart");

autostartCommand
  .command("enable")
  .description("Enable OpenTag service login autostart")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runServiceAutostartEnableCommand));

autostartCommand
  .command("disable")
  .description("Disable OpenTag service login autostart")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runServiceAutostartDisableCommand));

serviceCommand
  .command("run", { hidden: true })
  .description("Run the OpenTag service payload")
  .option("--config <path>", "Config file path")
  .option("--mode <mode>", "Service run mode", "background")
  .action(runCliAction(runServiceRunCommand));

program
  .command("platforms")
  .description("List OpenTag platform setup support and runtime capabilities")
  .action(() => {
    runPlatformsCommand();
  });

program
  .command("executors")
  .description("List available coding agents and runtime capabilities")
  .action(() => {
    runExecutorsCommand();
  });

const maintenanceCommand = program.command("maintenance").description("Run explicit OpenTag maintenance operations");

maintenanceCommand
  .command("prune-source-deliveries")
  .description("Prune stale source delivery replay keys after their runs are terminal")
  .option("--config <path>", "Config file path")
  .requiredOption("--older-than <timestamp>", "Prune delivery replay keys created before this ISO timestamp")
  .option("--limit <n>", "Maximum delivery replay keys to scan")
  .action(runCliAction(runMaintenancePruneSourceDeliveriesCommand));

const configCommand = program.command("config").description("Inspect OpenTag config");

configCommand
  .command("path")
  .description("Print the OpenTag config path")
  .action(() => {
    console.log(defaultConfigPath());
  });

configCommand
  .command("show")
  .description("Print the OpenTag config with secrets redacted")
  .option("--config <path>", "Config file path")
  .action(runCliAction((options) => {
    console.log(JSON.stringify(readRedactedCliConfig(options.config ?? defaultConfigPath()), null, 2));
  }));

await program.parseAsync(process.argv);
