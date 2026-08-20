import * as lark from "@larksuiteoapi/node-sdk";

const REGISTRATION_SOURCE = "opentag";
const BOT_INFO_RETRIES = 6;
const BOT_INFO_RETRY_DELAY_MS = 2000;
const PERSONAL_AGENT_TENANT_SCOPES = [
  "im:message:send_as_bot",
  "im:message.p2p_msg:readonly",
  "im:message.group_msg:readonly",
  "im:chat:readonly",
  "docx:document:readonly",
  "drive:drive:readonly",
  "wiki:wiki:readonly",
  "im:message.group_msg",
  "sheets:spreadsheet:readonly",
  "bitable:app:readonly"
] as const;

export type LarkDomain = "lark" | "feishu";

export type LarkRegistrationQrCodeInfo = {
  url: string;
  expireIn: number;
};

export type LarkRegistrationStatusInfo = {
  status: string;
  interval?: number;
};

export type RegisteredLarkPersonalAgent = {
  appId: string;
  appSecret: string;
  domain: LarkDomain;
  operatorOpenId?: string;
  botOpenId?: string;
  botName?: string;
};

export type LarkCredentialValidationResult = {
  botOpenId: string;
  botName: string;
};

type LarkRegisterAppResult = {
  client_id: string;
  client_secret: string;
  user_info?: {
    open_id?: string;
    tenant_brand?: "feishu" | "lark";
  };
};

type LarkRegisterApp = (options: {
  domain?: string;
  larkDomain?: string;
  source?: string;
  signal?: AbortSignal;
  onQRCodeReady: (info: LarkRegistrationQrCodeInfo) => void;
  onStatusChange?: (info: LarkRegistrationStatusInfo) => void;
  appPreset?: { name?: string; desc?: string };
  addons?: {
    scopes?: { tenant?: string[] };
    events?: { items?: { tenant?: string[] } };
    callbacks?: { items?: string[] };
  };
  createOnly?: boolean;
}) => Promise<LarkRegisterAppResult>;

type BotInfoClient = {
  request(input: { url: string; method: "GET" }): Promise<unknown>;
};

export type LarkPersonalAgentRegistrationDependencies = {
  registerApp?: LarkRegisterApp;
  createBotInfoClient?(input: { appId: string; appSecret: string; domain: LarkDomain }): BotInfoClient;
  sleep?(ms: number): Promise<void>;
};

export type LarkCredentialValidationDependencies = {
  createBotInfoClient?(input: { appId: string; appSecret: string; domain: LarkDomain }): BotInfoClient;
};

export type RegisterLarkPersonalAgentInput = {
  signal?: AbortSignal;
  onQrCode(info: LarkRegistrationQrCodeInfo): void;
  onStatus?(info: LarkRegistrationStatusInfo): void;
  onWarning?(message: string): void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function accountDomainFor(domain: LarkDomain): string {
  return domain === "feishu" ? "accounts.feishu.cn" : "accounts.larksuite.com";
}

function sdkDomainFor(domain: LarkDomain): lark.Domain {
  return domain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark;
}

function registrationDomainFromUserInfo(userInfo: LarkRegisterAppResult["user_info"]): LarkDomain {
  if (userInfo?.tenant_brand === "lark") return "lark";
  if (userInfo?.tenant_brand === "feishu") return "feishu";
  return "feishu";
}

function createDefaultBotInfoClient(input: { appId: string; appSecret: string; domain: LarkDomain }): BotInfoClient {
  return new lark.Client({
    appId: input.appId,
    appSecret: input.appSecret,
    domain: sdkDomainFor(input.domain)
  });
}

function botInfoFromResponse(response: unknown): { botOpenId: string; botName: string } | undefined {
  const value = response as { bot?: { open_id?: string; app_name?: string; name?: string }; data?: { bot?: { open_id?: string; app_name?: string; name?: string } } };
  const bot = value.bot ?? value.data?.bot;
  if (!bot?.open_id) {
    return undefined;
  }
  return {
    botOpenId: bot.open_id,
    botName: bot.app_name || bot.name || "OpenTag"
  };
}

export async function validateLarkCredentials(
  input: { appId: string; appSecret: string; domain: LarkDomain },
  dependencies: LarkCredentialValidationDependencies = {}
): Promise<LarkCredentialValidationResult> {
  const client = (dependencies.createBotInfoClient ?? createDefaultBotInfoClient)(input);
  let response: unknown;
  try {
    response = await client.request({
      url: "/open-apis/bot/v3/info",
      method: "GET"
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Lark credentials could not be verified: ${reason}`);
  }

  const botIdentity = botInfoFromResponse(response);
  if (!botIdentity) {
    throw new Error("Lark credentials could not be verified: bot/v3/info response did not include bot.open_id.");
  }
  return botIdentity;
}

async function fetchBotIdentity(
  input: { appId: string; appSecret: string; domain: LarkDomain },
  options: {
    createBotInfoClient: NonNullable<LarkPersonalAgentRegistrationDependencies["createBotInfoClient"]>;
    sleep: (ms: number) => Promise<void>;
    onWarning?: (message: string) => void;
  }
): Promise<Pick<RegisteredLarkPersonalAgent, "botOpenId" | "botName">> {
  const client = options.createBotInfoClient(input);
  let lastError: unknown;

  for (let attempt = 1; attempt <= BOT_INFO_RETRIES; attempt += 1) {
    try {
      const botIdentity = botInfoFromResponse(
        await client.request({
          url: "/open-apis/bot/v3/info",
          method: "GET"
        })
      );
      if (botIdentity) {
        return botIdentity;
      }
      lastError = new Error("bot/v3/info response did not include bot.open_id.");
    } catch (error) {
      lastError = error;
    }

    if (attempt < BOT_INFO_RETRIES) {
      await options.sleep(BOT_INFO_RETRY_DELAY_MS);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  options.onWarning?.(
    `OpenTag could not fetch the Lark bot open_id automatically. Direct chat still works. For group chat, enter the bot open_id manually. Reason: ${reason}`
  );
  return {};
}

export async function registerLarkPersonalAgent(
  input: RegisterLarkPersonalAgentInput,
  dependencies: LarkPersonalAgentRegistrationDependencies = {}
): Promise<RegisteredLarkPersonalAgent> {
  let detectedDomain: LarkDomain | undefined;

  const registerApp = dependencies.registerApp ?? lark.registerApp;
  const registrationOptions = {
    // QR registration does not preselect a tenant. The SDK starts on the Feishu
    // bootstrap host and can switch polling to Lark when it detects an
    // international tenant; the created app's actual tenant is persisted below.
    domain: accountDomainFor("feishu"),
    larkDomain: accountDomainFor("lark"),
    source: REGISTRATION_SOURCE,
    createOnly: true,
    appPreset: {
      name: "OpenTag {user}",
      desc: "Wake your local OpenTag agent from Lark."
    },
    addons: {
      scopes: {
        tenant: [...PERSONAL_AGENT_TENANT_SCOPES]
      },
      events: {
        items: {
          tenant: ["im.message.receive_v1"]
        }
      },
      callbacks: {
        items: ["card.action.trigger"]
      }
    },
    onQRCodeReady: input.onQrCode,
    onStatusChange(info) {
      if (info.status === "domain_switched") {
        detectedDomain = "lark";
      }
      input.onStatus?.(info);
    }
  } satisfies Parameters<LarkRegisterApp>[0];

  const registration = await registerApp({
    ...registrationOptions,
    ...(input.signal ? { signal: input.signal } : {})
  });

  const domain = detectedDomain ?? registrationDomainFromUserInfo(registration.user_info);
  const botIdentity = await fetchBotIdentity(
    {
      appId: registration.client_id,
      appSecret: registration.client_secret,
      domain
    },
    {
      createBotInfoClient: dependencies.createBotInfoClient ?? createDefaultBotInfoClient,
      sleep: dependencies.sleep ?? sleep,
      ...(input.onWarning ? { onWarning: input.onWarning } : {})
    }
  );

  return {
    appId: registration.client_id,
    appSecret: registration.client_secret,
    domain,
    ...(registration.user_info?.open_id ? { operatorOpenId: registration.user_info.open_id } : {}),
    ...(botIdentity.botOpenId ? { botOpenId: botIdentity.botOpenId } : {}),
    ...(botIdentity.botName ? { botName: botIdentity.botName } : {})
  };
}
