import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LarkDomain } from "@opentag/lark";
import { assertPrivateConfigFile, type OpenTagCliConfig } from "../../config.js";

const SavedLarkCredentialsSchema = z
  .object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    domain: z.enum(["lark", "feishu"]),
    botOpenId: z.string().min(1).optional()
  })
  .passthrough();

export type SavedLarkCredentials = {
  appId: string;
  appSecret: string;
  domain: LarkDomain;
  botOpenId?: string;
  source: "opentag_config" | "legacy_start_lark";
  path?: string;
};

export function savedLarkCredentialsFromCliConfig(config: OpenTagCliConfig): SavedLarkCredentials | undefined {
  const lark = config.platforms.lark;
  if (!lark) return undefined;
  return {
    appId: lark.appId,
    appSecret: lark.appSecret,
    domain: lark.domain,
    ...(lark.botOpenId ? { botOpenId: lark.botOpenId } : {}),
    source: "opentag_config"
  };
}

export function legacyLarkConfigPath(projectPath: string): string {
  return join(projectPath, ".opentag", "lark", "lark.local.json");
}

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Saved Lark config at ${path} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readLegacyLarkCredentials(projectPath: string): SavedLarkCredentials | undefined {
  const path = legacyLarkConfigPath(projectPath);
  if (!existsSync(path)) return undefined;
  assertPrivateConfigFile(path);

  const parsed = SavedLarkCredentialsSchema.safeParse(parseJsonFile(path));
  if (!parsed.success) {
    throw new Error(`Saved Lark config at ${path} is invalid: ${parsed.error.message}`);
  }

  return {
    appId: parsed.data.appId,
    appSecret: parsed.data.appSecret,
    domain: parsed.data.domain,
    ...(parsed.data.botOpenId ? { botOpenId: parsed.data.botOpenId } : {}),
    source: "legacy_start_lark",
    path
  };
}
