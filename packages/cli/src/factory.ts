import { readFile } from "node:fs/promises";
import { createOpenTagClient, type OpenTagClient } from "@opentag/client";
import {
  FactoryRecipeSnapshotInputSchema,
  OpenTagEventSchema,
  WorkstreamAdmissionBatchInputSchema,
  WorkstreamInputSchema,
  type FactoryRecipeSnapshot,
  type WorkThread,
  type Workstream,
  type WorkstreamAdmissionBatchReceipt
} from "@opentag/core";
import {
  defaultConfigPath,
  readCliConfig,
  type OpenTagCliConfig
} from "./config.js";

type FactoryAction = "created" | "ensured" | "retrieved" | "submitted";

export type FactoryWorkThreadEnsureOptions = {
  config?: string;
  input?: string;
  json?: boolean;
};

export type FactoryRecipeCreateOptions = {
  config?: string;
  input?: string;
  json?: boolean;
};

export type FactoryRecipeGetOptions = {
  config?: string;
  id?: string;
  version?: string | number;
  json?: boolean;
};

export type FactoryWorkstreamCreateOptions = {
  config?: string;
  input?: string;
  json?: boolean;
};

export type FactoryWorkstreamGetOptions = {
  config?: string;
  id?: string;
  json?: boolean;
};

export type FactoryBatchSubmitOptions = {
  config?: string;
  input?: string;
  json?: boolean;
};

export type FactoryBatchGetOptions = {
  config?: string;
  id?: string;
  json?: boolean;
};

type FactoryCommandResult =
  | { recipe: FactoryRecipeSnapshot }
  | { workThread: WorkThread & { id: string }; created: boolean }
  | { workstream: Workstream }
  | { receipt: WorkstreamAdmissionBatchReceipt };

type FactoryInputDependencies = {
  readText?(path: string): Promise<string>;
  stdin?: AsyncIterable<string | Uint8Array>;
};

export type FactoryCommandDependencies = FactoryInputDependencies & {
  fetchImpl?: typeof fetch;
  logger?: Pick<typeof console, "log">;
};

function nonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function positiveInteger(value: string | number | undefined, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

async function readStdin(stdin: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stdin) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function loadJsonInput(inputPath: string | undefined, dependencies: FactoryInputDependencies): Promise<unknown> {
  const path = nonEmpty(inputPath, "--input");
  const source = path === "-" ? "stdin" : path;
  let text: string;
  try {
    if (path === "-") {
      text = await readStdin(dependencies.stdin ?? process.stdin);
    } else {
      text = await (dependencies.readText ?? ((filePath) => readFile(filePath, "utf8")))(path);
    }
  } catch (error) {
    throw new Error(`Could not read factory JSON input from ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Factory input ${source} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function factoryClient(config: OpenTagCliConfig, fetchImpl?: typeof fetch): OpenTagClient {
  const pairingToken = config.daemon.pairingToken?.trim();
  if (!pairingToken) {
    throw new Error("Factory operations require daemon.pairingToken; a runner token cannot authorize WorkThread, recipe, or workstream admission.");
  }
  return createOpenTagClient({
    dispatcherUrl: config.daemon.dispatcherUrl,
    pairingToken,
    ...(fetchImpl ? { fetchImpl } : {})
  });
}

export async function createFactoryRecipeFromConfig(input: {
  config: OpenTagCliConfig;
  inputPath: string;
  fetchImpl?: typeof fetch;
} & FactoryInputDependencies): Promise<{ recipe: FactoryRecipeSnapshot }> {
  const document = await loadJsonInput(input.inputPath, input);
  return factoryClient(input.config, input.fetchImpl).createFactoryRecipeSnapshot(
    FactoryRecipeSnapshotInputSchema.parse(document)
  );
}

export async function ensureFactoryWorkThreadFromConfig(input: {
  config: OpenTagCliConfig;
  inputPath: string;
  fetchImpl?: typeof fetch;
} & FactoryInputDependencies): Promise<{ workThread: WorkThread & { id: string }; created: boolean }> {
  const document = await loadJsonInput(input.inputPath, input);
  return factoryClient(input.config, input.fetchImpl).ensureWorkThread(OpenTagEventSchema.parse(document));
}

export async function getFactoryRecipeFromConfig(input: {
  config: OpenTagCliConfig;
  id: string;
  version: string | number;
  fetchImpl?: typeof fetch;
}): Promise<{ recipe: FactoryRecipeSnapshot }> {
  return factoryClient(input.config, input.fetchImpl).getFactoryRecipeSnapshot({
    id: nonEmpty(input.id, "--id"),
    version: positiveInteger(input.version, "--version")
  });
}

export async function createFactoryWorkstreamFromConfig(input: {
  config: OpenTagCliConfig;
  inputPath: string;
  fetchImpl?: typeof fetch;
} & FactoryInputDependencies): Promise<{ workstream: Workstream }> {
  const document = await loadJsonInput(input.inputPath, input);
  return factoryClient(input.config, input.fetchImpl).createWorkstream(WorkstreamInputSchema.parse(document));
}

export async function getFactoryWorkstreamFromConfig(input: {
  config: OpenTagCliConfig;
  id: string;
  fetchImpl?: typeof fetch;
}): Promise<{ workstream: Workstream }> {
  return factoryClient(input.config, input.fetchImpl).getWorkstream({ id: nonEmpty(input.id, "--id") });
}

export async function submitFactoryBatchFromConfig(input: {
  config: OpenTagCliConfig;
  inputPath: string;
  fetchImpl?: typeof fetch;
} & FactoryInputDependencies): Promise<{ receipt: WorkstreamAdmissionBatchReceipt }> {
  const document = await loadJsonInput(input.inputPath, input);
  return factoryClient(input.config, input.fetchImpl).createWorkstreamAdmissionBatch(
    WorkstreamAdmissionBatchInputSchema.parse(document)
  );
}

export async function getFactoryBatchFromConfig(input: {
  config: OpenTagCliConfig;
  id: string;
  fetchImpl?: typeof fetch;
}): Promise<{ receipt: WorkstreamAdmissionBatchReceipt }> {
  return factoryClient(input.config, input.fetchImpl).getWorkstreamAdmissionBatch({ id: nonEmpty(input.id, "--id") });
}

export function formatFactoryCommandOutput(
  result: FactoryCommandResult,
  options: { action: FactoryAction; json?: boolean }
): string {
  if (options.json) return JSON.stringify(result, null, 2);
  if ("workThread" in result) {
    return [
      `Factory work thread ${options.action}: ${result.workThread.id} (${result.created ? "created" : "already existed"})`,
      `Source: ${result.workThread.workItemReference.provider}`,
      `External work item: ${result.workThread.workItemReference.externalId}`,
      `Anchors: ${1 + (result.workThread.secondaryAnchors?.length ?? 0)}`
    ].join("\n");
  }
  if ("recipe" in result) {
    return [
      `Factory recipe ${options.action}: ${result.recipe.id} v${result.recipe.version}`,
      `Name: ${result.recipe.name}`,
      `Digest: ${result.recipe.contentDigest}`
    ].join("\n");
  }
  if ("workstream" in result) {
    return [
      `Factory workstream ${options.action}: ${result.workstream.id}`,
      `Recipe: ${result.workstream.recipeId} v${result.workstream.recipeVersion}`,
      `Members: ${result.workstream.members.length}`,
      `Digest: ${result.workstream.contentDigest}`
    ].join("\n");
  }
  const summary = result.receipt.result?.summary;
  return [
    `Admission batch ${options.action}: ${result.receipt.batch.id} (${result.receipt.status})`,
    `Workstream: ${result.receipt.batch.workstreamId}`,
    `Items: ${result.receipt.items.length}`,
    ...(summary
      ? [
        `Created: ${summary.createdCount}`,
        `Idempotent replays: ${summary.idempotentReplayCount}`,
        `Follow-ups queued: ${summary.followUpQueuedCount}`,
        `Waiting on active Runs: ${summary.waitActiveRunCount}`,
        `Needs human decision: ${summary.needsHumanDecisionCount}`,
        `Rejected: ${summary.rejectedCount}`,
        `Exceptions: ${summary.exceptionCount}${summary.omittedExceptionCount ? ` (${summary.omittedExceptionCount} omitted from samples)` : ""}`
      ]
      : [])
  ].join("\n");
}

function commandConfig(configPath: string | undefined): { configPath: string; config: OpenTagCliConfig } {
  const resolved = configPath ?? defaultConfigPath();
  return { configPath: resolved, config: readCliConfig(resolved) };
}

export async function runFactoryRecipeCreateCommand(
  options: FactoryRecipeCreateOptions,
  dependencies: FactoryCommandDependencies = {}
): Promise<void> {
  const { config } = commandConfig(options.config);
  const result = await createFactoryRecipeFromConfig({
    config,
    inputPath: nonEmpty(options.input, "--input"),
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    ...(dependencies.readText ? { readText: dependencies.readText } : {}),
    ...(dependencies.stdin ? { stdin: dependencies.stdin } : {})
  });
  (dependencies.logger ?? console).log(formatFactoryCommandOutput(result, { action: "created", json: options.json ?? false }));
}

export async function runFactoryWorkThreadEnsureCommand(
  options: FactoryWorkThreadEnsureOptions,
  dependencies: FactoryCommandDependencies = {}
): Promise<void> {
  const { config } = commandConfig(options.config);
  const result = await ensureFactoryWorkThreadFromConfig({
    config,
    inputPath: nonEmpty(options.input, "--input"),
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    ...(dependencies.readText ? { readText: dependencies.readText } : {}),
    ...(dependencies.stdin ? { stdin: dependencies.stdin } : {})
  });
  (dependencies.logger ?? console).log(formatFactoryCommandOutput(result, { action: "ensured", json: options.json ?? false }));
}

export async function runFactoryRecipeGetCommand(
  options: FactoryRecipeGetOptions,
  dependencies: FactoryCommandDependencies = {}
): Promise<void> {
  const { config } = commandConfig(options.config);
  const result = await getFactoryRecipeFromConfig({
    config,
    id: nonEmpty(options.id, "--id"),
    version: positiveInteger(options.version, "--version"),
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
  });
  (dependencies.logger ?? console).log(formatFactoryCommandOutput(result, { action: "retrieved", json: options.json ?? false }));
}

export async function runFactoryWorkstreamCreateCommand(
  options: FactoryWorkstreamCreateOptions,
  dependencies: FactoryCommandDependencies = {}
): Promise<void> {
  const { config } = commandConfig(options.config);
  const result = await createFactoryWorkstreamFromConfig({
    config,
    inputPath: nonEmpty(options.input, "--input"),
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    ...(dependencies.readText ? { readText: dependencies.readText } : {}),
    ...(dependencies.stdin ? { stdin: dependencies.stdin } : {})
  });
  (dependencies.logger ?? console).log(formatFactoryCommandOutput(result, { action: "created", json: options.json ?? false }));
}

export async function runFactoryWorkstreamGetCommand(
  options: FactoryWorkstreamGetOptions,
  dependencies: FactoryCommandDependencies = {}
): Promise<void> {
  const { config } = commandConfig(options.config);
  const result = await getFactoryWorkstreamFromConfig({
    config,
    id: nonEmpty(options.id, "--id"),
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
  });
  (dependencies.logger ?? console).log(formatFactoryCommandOutput(result, { action: "retrieved", json: options.json ?? false }));
}

export async function runFactoryBatchSubmitCommand(
  options: FactoryBatchSubmitOptions,
  dependencies: FactoryCommandDependencies = {}
): Promise<void> {
  const { config } = commandConfig(options.config);
  const result = await submitFactoryBatchFromConfig({
    config,
    inputPath: nonEmpty(options.input, "--input"),
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    ...(dependencies.readText ? { readText: dependencies.readText } : {}),
    ...(dependencies.stdin ? { stdin: dependencies.stdin } : {})
  });
  (dependencies.logger ?? console).log(formatFactoryCommandOutput(result, { action: "submitted", json: options.json ?? false }));
}

export async function runFactoryBatchGetCommand(
  options: FactoryBatchGetOptions,
  dependencies: FactoryCommandDependencies = {}
): Promise<void> {
  const { config } = commandConfig(options.config);
  const result = await getFactoryBatchFromConfig({
    config,
    id: nonEmpty(options.id, "--id"),
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
  });
  (dependencies.logger ?? console).log(formatFactoryCommandOutput(result, { action: "retrieved", json: options.json ?? false }));
}
