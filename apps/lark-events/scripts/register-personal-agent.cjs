#!/usr/bin/env node
"use strict";

const lark = require("@larksuiteoapi/node-sdk");
const qrcode = require("qrcode-terminal");

const REGISTRATION_SOURCE = "opentag";
const BOT_INFO_RETRIES = 6;
const BOT_INFO_RETRY_DELAY_MS = 2000;

function log(message = "") {
  process.stderr.write(`${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function accountDomainFor(domain) {
  return domain === "feishu" ? "accounts.feishu.cn" : "accounts.larksuite.com";
}

function sdkDomainFor(domain) {
  return domain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark;
}

function registrationDomainFromUserInfo(userInfo) {
  if (userInfo?.tenant_brand === "lark") return "lark";
  if (userInfo?.tenant_brand === "feishu") return "feishu";
  return "feishu";
}

function printQrCode(info) {
  log();
  log("Scan this QR code with Lark or Feishu, then finish creating the Personal Agent app:");
  qrcode.generate(info.url, { small: true }, (qr) => {
    process.stderr.write(`${qr}\n`);
  });
  log(`URL: ${info.url}`);
  log(`This QR code expires in about ${Math.ceil(info.expireIn / 60)} minute(s).`);
  log("Keep this terminal open. OpenTag will continue automatically after the app is created.");
  log();
}

async function fetchBotIdentity(input) {
  const client = new lark.Client({
    appId: input.appId,
    appSecret: input.appSecret,
    domain: sdkDomainFor(input.domain)
  });

  let lastError;
  for (let attempt = 1; attempt <= BOT_INFO_RETRIES; attempt += 1) {
    try {
      const response = await client.request({
        url: "/open-apis/bot/v3/info",
        method: "GET"
      });
      const bot = response?.bot ?? response?.data?.bot;
      if (bot?.open_id) {
        return {
          botOpenId: bot.open_id,
          botName: bot.app_name || bot.name || "OpenTag"
        };
      }
      lastError = new Error(`bot/v3/info response missing bot.open_id: ${JSON.stringify(response).slice(0, 200)}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < BOT_INFO_RETRIES) {
      await sleep(BOT_INFO_RETRY_DELAY_MS);
    }
  }

  log("OpenTag could not fetch the bot open_id automatically.");
  log(`Reason: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  log("Direct chat still works. For group chat, set LARK_BOT_OPEN_ID or enter it when prompted.");
  log();
  return {};
}

async function main() {
  let detectedDomain;

  const registration = await lark.registerApp({
    // The Personal Agent registration flow starts on Feishu and switches to Lark after scan when needed.
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
        tenant: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_msg:readonly",
          "im:message.history:readonly",
          "im:chat:readonly"
        ]
      },
      events: {
        items: {
          tenant: ["im.message.receive_v1"]
        }
      }
    },
    onQRCodeReady: printQrCode,
    onStatusChange(info) {
      if (info.status === "slow_down") {
        log(`Lark asked OpenTag to poll more slowly. Next check in ${info.interval ?? "a few"} seconds.`);
      } else if (info.status === "domain_switched") {
        detectedDomain = "lark";
        log("Detected a Lark tenant. Continuing registration on larksuite.com.");
      }
    }
  });

  const domain = detectedDomain ?? registrationDomainFromUserInfo(registration.user_info);
  const botIdentity = await fetchBotIdentity({
    appId: registration.client_id,
    appSecret: registration.client_secret,
    domain
  });

  log("Personal Agent app created.");
  log(`App ID: ${registration.client_id}`);
  log(`Domain: ${domain}`);
  if (registration.user_info?.open_id) {
    log(`Setup user: ${registration.user_info.open_id}`);
  }
  if (botIdentity.botOpenId) {
    log(`Bot: ${botIdentity.botName} (${botIdentity.botOpenId})`);
  }
  log();

  process.stdout.write(
    `${JSON.stringify({
      appId: registration.client_id,
      appSecret: registration.client_secret,
      domain,
      operatorOpenId: registration.user_info?.open_id,
      botOpenId: botIdentity.botOpenId,
      botName: botIdentity.botName
    })}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
