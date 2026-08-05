import { createOpenTagClient, type SourceDeliveryPruneResult } from "@opentag/client";
import { z } from "zod";
import { defaultConfigPath, readCliConfig, runnerDispatcherToken, type OpenTagCliConfig } from "./config.js";

export type MaintenancePruneSourceDeliveriesOptions = {
  config?: string;
  olderThan?: string;
  limit?: string | number;
};

export type PruneSourceDeliveriesSummary = {
  configPath: string;
  dispatcherUrl: string;
  olderThan: string;
  limit?: number;
  result: SourceDeliveryPruneResult;
};

function parsePositiveInteger(name: string, value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parsePruneSourceDeliveriesOptions(options: MaintenancePruneSourceDeliveriesOptions): {
  olderThan: string;
  limit?: number;
} {
  const olderThan = options.olderThan?.trim();
  if (!olderThan) {
    throw new Error("--older-than is required.");
  }
  if (!z.string().datetime().safeParse(olderThan).success) {
    throw new Error("--older-than must be a valid ISO timestamp.");
  }
  const limit = parsePositiveInteger("--limit", options.limit);
  return {
    olderThan,
    ...(limit ? { limit } : {})
  };
}

export async function pruneSourceDeliveriesFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  olderThan: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<PruneSourceDeliveriesSummary> {
  const token = runnerDispatcherToken(input.config.daemon);
  const client = createOpenTagClient({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(token ? { pairingToken: token } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const result = await client.pruneSourceDeliveries({
    olderThan: input.olderThan,
    ...(input.limit !== undefined ? { limit: input.limit } : {})
  });
  return {
    configPath: input.configPath,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    olderThan: input.olderThan,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    result
  };
}

export function formatPruneSourceDeliveriesSummary(summary: PruneSourceDeliveriesSummary): string {
  return [
    "Source delivery replay-key prune:",
    `Config: ${summary.configPath}`,
    `Dispatcher: ${summary.dispatcherUrl}`,
    `Older than: ${summary.olderThan}`,
    `Limit: ${summary.limit ?? "default"}`,
    `Scanned: ${summary.result.scanned}`,
    `Pruned: ${summary.result.pruned}`,
    `Retained active: ${summary.result.retainedActive}`
  ].join("\n");
}

export async function runMaintenancePruneSourceDeliveriesCommand(options: MaintenancePruneSourceDeliveriesOptions): Promise<void> {
  const parsed = parsePruneSourceDeliveriesOptions(options);
  const configPath = options.config ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  const summary = await pruneSourceDeliveriesFromConfig({
    config,
    configPath,
    ...parsed
  });
  console.log(formatPruneSourceDeliveriesSummary(summary));
}
