import { spawn } from "node:child_process";
import {
  createFeishuMcpServerResolver,
  FEISHU_MCP_OAUTH_SCOPES,
  larkMcpCliPath,
  type AcpMcpServerResolver
} from "@opentag/runner";
import {
  defaultConfigPath,
  readCliConfig,
  writeCliConfigAtomic,
  type OpenTagCliConfig
} from "./config.js";

export type FeishuLoginCommandOptions = { config?: string };

export type FeishuLoginDependencies = {
  readConfig?(path: string): OpenTagCliConfig;
  writeConfig?(path: string, config: OpenTagCliConfig): void;
  login?(input: { appId: string; appSecret: string; domain: "feishu" | "lark"; scopes: readonly string[] }): Promise<void>;
  logger?: Pick<typeof console, "log">;
};

function apiDomain(domain: "feishu" | "lark"): string {
  return domain === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com";
}

async function officialMcpLogin(input: {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  scopes: readonly string[];
}): Promise<void> {
  await new Promise<void>((resolveLogin, rejectLogin) => {
    const child = spawn(process.execPath, [
      larkMcpCliPath(),
      "login",
      "--scope",
      input.scopes.join(" ")
    ], {
      env: {
        ...process.env,
        APP_ID: input.appId,
        APP_SECRET: input.appSecret,
        LARK_DOMAIN: apiDomain(input.domain)
      },
      stdio: "inherit"
    });
    child.once("error", rejectLogin);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveLogin();
      else rejectLogin(new Error(`Feishu OAuth login failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}).`));
    });
  });
}

export function feishuMcpServersFromCliConfig(config: OpenTagCliConfig): AcpMcpServerResolver | undefined {
  const lark = config.platforms.lark;
  if (!lark?.userResourceAccess?.enabled) return undefined;
  return createFeishuMcpServerResolver({ appId: lark.appId, appSecret: lark.appSecret, domain: lark.domain });
}

export async function runFeishuLoginCommand(
  options: FeishuLoginCommandOptions,
  dependencies: FeishuLoginDependencies = {}
): Promise<void> {
  const configPath = options.config ?? defaultConfigPath();
  const readConfig = dependencies.readConfig ?? readCliConfig;
  const writeConfig = dependencies.writeConfig ?? writeCliConfigAtomic;
  const config = readConfig(configPath);
  const lark = config.platforms.lark;
  if (!lark) throw new Error("Feishu OAuth login requires a configured Lark / Feishu platform. Run `opentag setup` first.");

  await (dependencies.login ?? officialMcpLogin)({
    appId: lark.appId,
    appSecret: lark.appSecret,
    domain: lark.domain,
    scopes: FEISHU_MCP_OAUTH_SCOPES
  });

  writeConfig(configPath, {
    ...config,
    platforms: {
      ...config.platforms,
      lark: { ...lark, userResourceAccess: { enabled: true } }
    }
  });
  (dependencies.logger ?? console).log("Feishu user resource access enabled. Restart OpenTag for running services to pick up the MCP tools.");
}
