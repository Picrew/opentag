import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("platform setup docs contract", () => {
  it("keeps the superseded 0.10.0-next.0 candidate procedure fail-closed and next-only", () => {
    const prereleaseGuide = repoFile("docs/npm-prerelease.md");
    const normalizedPrereleaseGuide = prereleaseGuide.replace(/\s+/g, " ");
    const versioningGuide = repoFile("docs/versioning.md");
    const readme = repoFile("README.md");
    const readmeZh = repoFile("README.zh-CN.md");

    expect(normalizedPrereleaseGuide).toContain(
      "exactly `0.10.0-next.0` for all 18 public packages"
    );
    expect(prereleaseGuide).toContain("npm `next` only");
    expect(prereleaseGuide).toContain("Absence must be a confirmed registry `404`");
    expect(prereleaseGuide).toContain("never issue `npm publish` for that version again");
    expect(prereleaseGuide).toContain(
      "npm publish <preserved-tarball> --access public --tag next --provenance"
    );
    expect(normalizedPrereleaseGuide).toContain(
      "all recorded pre-publication `latest` dist-tags are unchanged"
    );
    expect(normalizedPrereleaseGuide).toContain(
      "the automatically discovered 18-package topological order"
    );
    expect(normalizedPrereleaseGuide).toContain(
      "all 18 exact versions resolve from the public registry"
    );
    expect(normalizedPrereleaseGuide).toContain(
      "all 18 `next` dist-tags resolve to `0.10.0-next.0`"
    );
    expect(normalizedPrereleaseGuide).not.toMatch(/(?:16-package|all 16)/u);
    expect(normalizedPrereleaseGuide).toContain(
      "If a future release is explicitly approved to publish a stable version directly to `latest`, do not use this document"
    );
    expect(normalizedPrereleaseGuide).toContain(
      "Never report `published` from local output alone"
    );
    expect(normalizedPrereleaseGuide).toContain(
      "stable promotion is outside this procedure"
    );
    expect(prereleaseGuide).not.toContain("npm publish <preserved-tarball> --access public --tag latest");
    expect(normalizedPrereleaseGuide).toContain(
      "The `0.10.0-next.0` candidate described here was never published"
    );
    expect(versioningGuide).toContain("coordinated `0.10.0` release");
    expect(readme).toContain("[npm prerelease candidate guide](docs/npm-prerelease.md)");
    expect(readmeZh).toContain("[npm prerelease 候选发布指南](docs/npm-prerelease.md)");
  });

  it("keeps the 0.10.0 release procedure explicit and concurrency-safe", () => {
    const releaseGuide = repoFile("docs/npm-release.md");
    const liveGuide = repoFile("docs/live-e2e-smoke-harness.md");

    expect(liveGuide).toContain("npm install --no-audit --no-fund @opentag/cli@0.10.0");
    expect(liveGuide).toContain('smoke_root="$(mktemp -d)"\n(\n  set -euo pipefail');
    expect(releaseGuide).toContain("refs/heads/release-lock/npm-dist-tags");
    expect(releaseGuide).toContain("npm-dist-tags.lock-sha");
    expect(releaseGuide).toContain("release-commit-sha");
    expect(releaseGuide).toContain("lock_nonce=\"$(openssl rand -hex 16)\"");
    expect(releaseGuide).toContain("parents[]=$release_commit");
    expect(releaseGuide).toContain(".parents[0].sha");
    expect(releaseGuide).toContain('= "$lock_commit"');
    expect(releaseGuide).toContain('current_latest="$(jq -er');
    expect(releaseGuide).toContain('current_next="$(jq -er');
    expect(releaseGuide).toContain('test "$current_next" = "0.10.0"');
    expect(releaseGuide).toContain("First-publication exception");
    expect(releaseGuide.match(/if \[ "\$package" = "@opentag\/control-protocol" \]; then/gu)).toHaveLength(3);
    expect(releaseGuide).toContain("no previous `latest` to restore");
    expect(releaseGuide.match(/test "\$previous_latest" = "0\.9\.0"/gu)).toHaveLength(3);
    expect(
      releaseGuide.match(
        /awk -F '\\t' '\$1 != "@opentag\/control-protocol" \{ print \$2 \}' "\$(?:snapshot_tmp|rollback_file)" \| sort -u\)" = "0\.9\.0"/gu
      )
    ).toHaveLength(3);
    expect(releaseGuide).not.toContain('"0.8.0"');
    expect(releaseGuide.match(/test "\$\("\$smoke_root\/node_modules\/\.bin\/opentag" --version\)" = "0\.10\.0"/gu))
      .toHaveLength(2);
    expect(releaseGuide).toContain('smoke_root="$(mktemp -d)"\n(\n  set -euo pipefail');
    expect(releaseGuide).toContain(
      'Also verify every package and its canary tag before promotion:\n\n```bash\n(\n  set -euo pipefail'
    );
    expect(releaseGuide).toContain('git tag -a v0.10.0 "$release_commit" -m "OpenTag v0.10.0"');
    expect(releaseGuide).toContain(
      "if ! gh api --include --silent repos/amplifthq/opentag/git/ref/tags/v0.10.0"
    );
    expect(releaseGuide).toContain("only a confirmed 404 permits tag creation");
    expect(releaseGuide).toContain("release_tag_status=\"$(awk 'toupper($1) ~ /^HTTP\\//");
    expect(releaseGuide).toContain('case "$release_tag_status" in\n    200)');
    expect(releaseGuide).toContain("    404)\n      if git show-ref --verify --quiet refs/tags/v0.10.0; then");
    expect(releaseGuide).toContain("Refusing tag creation after upstream lookup returned HTTP");
    expect(releaseGuide).toContain("git show-ref --verify --quiet refs/tags/v0.10.0");
    expect(releaseGuide).toContain("git cat-file -t refs/tags/v0.10.0");
    expect(releaseGuide).toContain('git rev-parse \'v0.10.0^{}\'');
    expect(releaseGuide).toContain("git push origin refs/tags/v0.10.0");
    expect(releaseGuide).toContain('git/tags/$release_tag_object');
    expect(releaseGuide).toContain("gh api --paginate 'repos/amplifthq/opentag/releases?per_page=100'");
    expect(releaseGuide).toContain('case "$existing_release_state" in');
    expect(releaseGuide).toContain("$'v0.10.0\\tfalse\\tfalse\\ttrue'");
    expect(releaseGuide).toContain("'.draft'");
    expect(releaseGuide).toContain("'.prerelease'");
    expect(releaseGuide).toContain('.published_at | select(type == "string" and length > 0)');
  });

  it("keeps the agent-readable install guide aligned with OpenTag source-thread boundaries", () => {
    const guide = repoFile("docs/agent-install.md");
    const readme = repoFile("README.md");
    const normalizedGuide = guide.replace(/\s+/g, " ");

    expect(readme).toContain("[Agent-readable install guide](docs/agent-install.md)");
    expect(guide).toContain("OpenTag is a source-thread action layer for coding agents");
    expect(normalizedGuide).toContain("OpenTag is not a general chat remote-control cockpit");
    expect(guide).toContain("Project Target");
    expect(guide).toContain("RunScope");
    expect(guide).toContain("Readiness");
    expect(guide).toContain("OpenTagRunResult.artifacts");
    expect(normalizedGuide).toContain("patches, reports, screenshots, log summaries, and pull request links");
    expect(guide).toContain("opentag platforms");
    expect(guide).toContain("opentag executors");
    expect(guide).toContain("opentag service status");
    expect(guide).toContain("opentag doctor");
    expect(guide).toContain("opentag status");
    expect(guide).toContain("Keep external runtime integration on OpenTag-owned APIs and data shapes.");
    expect(normalizedGuide).toContain("run lifecycle, idempotency key, terminal semantics, audit visibility");
    expect(guide).toContain("runner-scoped authentication");
    expect(guide).not.toContain("register_ack");
    expect(guide).not.toContain("ws://");
  });

  it("keeps the OpenTag skill aligned with Codex askhuman setup guidance", () => {
    const skill = repoFile("skills/opentag/SKILL.md");

    expect(skill).toContain("request_user_input");
    expect(skill).toContain("askhuman");
    expect(skill).toContain("Codex Plan mode");
    expect(skill).toContain("Codex Default mode cannot render askhuman choice cards");
    expect(skill).toContain("runtime-provided Plan-mode transition");
    expect(skill).toContain("askhuman cannot render from Default mode");
    expect(skill).toContain("Do not claim a Plan-mode handoff happened");
    expect(skill).toContain("do not ask the user to switch modes");
    expect(skill).toContain("do not ask the same choices in plain text");
    expect(skill).toContain("do not present a plain-text fallback");
    expect(skill).toContain("do not continue with CLI defaults");
    expect(skill).toContain("Never request secrets through askhuman");
    expect(skill).toContain("Do not ask setup users to invoke an agent directly");
    expect(skill).toContain("built-in Generic ACP launches for Codex, Claude Code, Cursor, OpenCode, Hermes, and OpenClaw");
    expect(skill).toContain("built-in ACP conformance gate");
    expect(skill).toContain("Npm Registry And Network Failures");
    expect(skill).toContain("ENOTFOUND");
    expect(skill).toContain("EAI_AGAIN");
    expect(skill).toContain("ETIMEDOUT");
    expect(skill).toContain("ECONNRESET");
    expect(skill).toContain("TLS certificate errors");
    expect(skill).toContain("npm config get registry");
    expect(skill).toContain("npm config get proxy");
    expect(skill).toContain("npm config get https-proxy");
    expect(skill).toContain("registry.npmjs.org");
    expect(skill).toContain("npm view @opentag/cli version --fetch-timeout=15000");
    expect(skill).toContain("proxy-scoped npm registry retry");
    expect(skill).toContain(
      'HTTPS_PROXY="<proxy-url>" HTTP_PROXY="<proxy-url>" npm view @opentag/cli version --fetch-timeout=15000'
    );
    expect(skill).toContain("Only after npm registry metadata is reachable");
    expect(skill).toContain("npx --yes @opentag/cli --help");
    expect(skill).toContain("do not permanently change `npm config` without explicit user confirmation");
    expect(skill).toContain("Only use a proxy URL the user provides or that is already active in the environment");
    expect(skill).toContain("npm cache metadata exists");
    expect(skill).toContain("`npx --offline` or `npm pack --offline`");
    expect(skill).toContain("do not claim the CLI is available offline");
    expect(skill).toContain("Platform: Slack, GitHub, GitLab, Linear, Lark / Feishu, Telegram, or Discord");
    expect(skill).toContain("Coding agent: Codex, Claude Code, Cursor, OpenCode, Hermes, OpenClaw, or Echo");
    expect(skill).toContain("Local project: the current working directory");
    expect(skill).toContain("Slack Socket Mode vs Events API");
    expect(skill).toContain("Lark / Feishu tenant for manual app setup");
    expect(skill).toContain("Lark scan vs manual setup");
    expect(skill).toContain("default project binding vs bind later");
    expect(skill).toContain("--platform");
    expect(skill).toContain("--executor");
    expect(skill).toContain("--project");
    expect(skill).toContain("--slack-mode");
    expect(skill).toContain("--tenant");
    expect(skill).toContain("--lark-setup");
    expect(skill).toContain("--binding");
    expect(skill).toContain(
      "Stop before entering any credential, token, app ID, app secret, signing secret, channel ID, repository name, or unconfirmed project path."
    );
    expect(skill).not.toContain("agent-owned flow control");
    expect(skill).not.toContain("trigger the Codex Plan-mode transition or handoff first");
    expect(skill).not.toContain("ask for the same choices in plain text instead");
  });

  it("keeps Slack setup docs aligned with the official Socket Mode and Events API requirements", () => {
    const english = repoFile("docs/platforms/slack.en.md");
    const chinese = repoFile("docs/platforms/slack.zh-CN.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).toContain("https://docs.slack.dev/apis/events-api/using-socket-mode/");
    expect(combined).toContain("https://docs.slack.dev/authentication/verifying-requests-from-slack/");
    expect(combined).toContain("https://api.slack.com/apps");
    expect(combined).toContain("connections:write");
    expect(combined).toContain("app_mentions:read");
    expect(combined).toContain("chat:write");
    expect(combined).toContain("app_mention");
    expect(combined).toContain("Do not enter a Request URL for Socket Mode");
    expect(combined).toContain("Socket Mode 不需要填写 Request URL");
    expect(combined).toContain("Create from manifest");
    expect(combined).toContain("/invite @OpenTag");
    expect(combined).toContain("GitHub repository target");
    expect(combined).toContain("GitHub token");
  });

  it("keeps GitHub setup docs aligned with webhook, token, and apply-1 pull request requirements", () => {
    const english = repoFile("docs/platforms/github.en.md");
    const chinese = repoFile("docs/platforms/github.zh-CN.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).toContain("https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks");
    expect(combined).toContain("https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries");
    expect(combined).toContain("https://github.com/settings/personal-access-tokens/new");
    expect(combined).toContain("Issue comments");
    expect(combined).toContain("Pull request review comments");
    expect(combined).toContain("Issues");
    expect(combined).toContain("Pull requests");
    expect(combined).toContain("apply 1");
    expect(combined).toContain("Content type");
    expect(combined).toContain("application/json");
    expect(combined).toContain("3050");
    expect(combined).toContain("--github-port");
  });

  it("keeps Telegram setup docs aligned with BotFather, polling defaults, and webhook requirements", () => {
    const english = repoFile("docs/platforms/telegram.en.md");
    const chinese = repoFile("docs/platforms/telegram.zh-CN.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).toContain("https://t.me/BotFather");
    expect(combined).toContain("https://core.telegram.org/bots/api#getupdates");
    expect(combined).toContain("getUpdates");
    expect(combined).toContain("polling");
    expect(combined).toContain("not required in polling mode");
    expect(combined).toContain("不需要公网 tunnel");
    expect(combined).toContain("https://core.telegram.org/bots/api#setwebhook");
    expect(combined).toContain("setWebhook");
    expect(combined).toContain("secret_token");
    expect(combined).toContain("X-Telegram-Bot-Api-Secret-Token");
    expect(combined).toContain("/telegram/events/<bot_id>");
    expect(combined).toContain("3030");
    expect(combined).toContain("--telegram-mode webhook");
    expect(combined).toContain("--telegram-bot-token");
    expect(combined).toContain("--telegram-binding-admin-user-ids");
  });

  it("keeps Discord setup docs aligned with Gateway defaults, Interactions Endpoint, and slash-command requirements", () => {
    const english = repoFile("docs/platforms/discord.en.md");
    const chinese = repoFile("docs/platforms/discord.zh-CN.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).toContain("https://discord.com/developers/applications");
    expect(combined).toContain("https://docs.discord.com/developers/events/gateway-events#interaction-create");
    expect(combined).toContain("https://docs.discord.com/developers/interactions/overview");
    expect(combined).toContain("https://docs.discord.com/developers/interactions/application-commands");
    expect(combined).toContain("Gateway");
    expect(combined).toContain("INTERACTION_CREATE");
    expect(combined).toContain("not required in Gateway mode");
    expect(combined).toContain("不需要公网 tunnel");
    expect(combined).toContain("Interactions Endpoint URL");
    expect(combined).toContain("X-Signature-Ed25519");
    expect(combined).toContain("X-Signature-Timestamp");
    expect(combined).toContain("/discord/interactions");
    expect(combined).toContain("/opentag");
    expect(combined).toContain("--discord-mode webhook");
    expect(combined).toContain("--discord-public-key");
    expect(combined).toContain("--discord-webhook-path");
  });

  it("keeps Linear setup docs aligned with GraphQL, webhooks, and issue apply requirements", () => {
    const english = repoFile("docs/platforms/linear.en.md");
    const chinese = repoFile("docs/platforms/linear.zh-CN.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).toContain("https://linear.app/settings/api");
    expect(combined).toContain("https://linear.app/developers/graphql");
    expect(combined).toContain("https://linear.app/developers/webhooks");
    expect(combined).toContain("Comment events");
    expect(combined).toContain("Linear-Signature");
    expect(combined).toContain("webhook timestamp");
    expect(combined).toContain("/linear/webhooks");
    expect(combined).toContain("3070");
    expect(combined).toContain("--linear-token");
    expect(combined).toContain("--linear-team-id");
    expect(combined).toContain("apply 1");
    expect(combined).toContain("state id");
    expect(combined).toContain("label id");
  });
});
