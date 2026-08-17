# Microsoft Teams Setup

Use this guide when `opentag setup --platform teams` asks for Microsoft Teams values.

OpenTag receives Microsoft Teams channel messages through a Bot Framework webhook. Teams only delivers activities over HTTPS, so this platform always needs a public HTTPS Messaging endpoint pointed at your local dispatcher (unlike Discord's default Gateway mode or Telegram's default polling mode).

Teams ingress currently runs only in OpenTag's local runtime (background service or terminal mode). Hosted/custom relay mode does not yet mount the Teams webhook and is reported as unsupported by `opentag status` and `opentag doctor`.

## End-To-End Setup Checklist

Use this checklist before diving into the detailed sections:

1. Confirm you can sign in to a Microsoft 365 tenant that has Teams enabled.
2. Confirm you can upload/install a custom Teams app, or that a Teams admin can do it for you.
3. Create an Azure Bot resource and copy the Microsoft App ID.
4. Copy the app/Tenant ID from Microsoft Entra ID.
5. Create and safely store the Azure Bot client secret **Value**.
6. Add the Microsoft Teams channel to the Azure Bot resource.
7. Start a public HTTPS tunnel to local port `3030` (`ngrok` is easiest for inspection; `devtunnel` must use `--allow-anonymous`).
8. Set the Azure Bot Messaging endpoint to `https://<tunnel-host>/teams/messages`.
9. Create or download a Teams app package that references the Microsoft App ID, then install it into the target team/channel.
10. Run `opentag setup --platform teams` and enter the Teams credentials locally.
11. Bind the Teams channel (`tenantId` + base `conversationId`) to the intended repository.
12. Send `@OpenTag investigate ...` to test read-only delivery.
13. Send `@OpenTag fix ...` to test a write-capable Claude/Codex run.
14. Optional: configure a GitHub/GitLab repo binding and apply token, then test `@OpenTag apply 1`.

## What You Need

- A Microsoft 365 tenant with Microsoft Teams enabled. You do **not** need to be a Microsoft 365 Developer Program member, but a personal Gmail/Outlook Microsoft account alone is not enough.
- Permission to install or upload a custom Teams app in the target team, or a Teams admin who can approve/install it for you.
- An Azure subscription that can create an **Azure Bot** resource. The **F0 (free)** pricing tier is enough for development and smoke tests.
- The bot's **Microsoft App ID**, the bot/app **Tenant ID**, and a **client secret value** (this is the `appPassword` OpenTag asks for).
- A public HTTPS tunnel (`ngrok` or `devtunnel`) to expose the local dispatcher's webhook endpoint while you develop.
- The bot installed into a **team** and added to the target **channel**.

Keep all secrets private. Do not paste client secrets, bot tokens, GitHub tokens, or one-time verification codes into chat, issues, or docs.

## Create The Azure Bot Resource

1. Open the [Azure Portal](https://portal.azure.com) and create a new **Azure Bot** resource.
2. Choose the **F0** pricing tier for free development use (upgrade to **S1** only if you need production-scale message volume).
3. For new bots, prefer a **single-tenant** app in your Microsoft 365 tenant.
4. After creation, open the Bot resource's **Configuration** page and copy the **Microsoft App ID**.
5. In the app registration's **Overview** page in Microsoft Entra ID, copy the **Tenant ID**.
6. Under **Certificates & secrets**, create a new **client secret**. Copy the secret **Value** immediately — Azure only shows it once. This value is the `appPassword` OpenTag stores.
7. In the Azure Bot resource's **Channels** page, add the **Microsoft Teams** channel.

See Microsoft's official [Bot Framework registration quickstart](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) and [Teams bot guide](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams) for the full Azure walkthrough.

## Expose The Local Dispatcher

Teams needs a public HTTPS URL for the bot's Messaging endpoint. Start a tunnel pointed at the local dispatcher port (default `3030`).

Recommended for debugging:

```bash
ngrok http 3030
```

`ngrok` prints a forwarding URL such as:

```text
https://example.ngrok-free.dev -> http://localhost:3030
```

It also provides a local inspector at:

```text
http://127.0.0.1:4040
```

Use the inspector to confirm Teams sends `POST /teams/messages` and to read non-secret Activity fields such as `conversation.id`, `channelData.channel.id`, and `channelData.tenant.id`.

If you use `devtunnel`, allow anonymous access:

```bash
devtunnel host -p 3030 --allow-anonymous
```

Without `--allow-anonymous`, the tunnel URL can redirect to a Microsoft sign-in page. Bot Framework cannot complete that interactive login, so Teams messages will not reach OpenTag.

Verify the public tunnel can reach OpenTag:

```bash
curl https://<tunnel-host>/healthz
```

Expected response:

```json
{"ok":true}
```

Set the Azure Bot **Messaging endpoint** (Azure Bot resource → **Configuration**) to:

```text
https://<tunnel-host>/teams/messages
```

If you configure a non-default path with `--teams-webhook-path /your/path`, use the matching URL in Azure.

## Install The Bot Into A Team

Teams requires an app package that references your Azure Bot's Microsoft App ID.

The easiest path is the [Teams Developer Portal](https://dev.teams.microsoft.com):

1. Create a new app.
2. Add a bot or choose an existing bot.
3. Enter the Azure Bot **Microsoft App ID**.
4. Enable the **Team** scope. OpenTag v1 supports team/channel conversations; personal and group chats are out of scope.
5. Download the app package.
6. In Teams, upload the custom app and add it to the target team/channel.

A Teams app package is a `.zip` containing at least:

```text
manifest.json
color.png
outline.png
```

Org tenants often restrict custom app installation. If uploading is disabled, ask a Teams admin to approve the app or enable custom app upload for your tenant.

## Run OpenTag Setup

Interactive setup is safest for secrets because it avoids putting the client secret in shell history:

```bash
opentag setup --platform teams
```

When prompted, enter:

```text
Microsoft App ID: <microsoft-app-id>
App password: <client-secret-value>
Tenant ID: <tenant-id>          # recommended for single-tenant apps
Webhook path: /teams/messages   # default
```

Do not put the client secret in command-line arguments, including
`--teams-app-password`; shell history and process listings can expose it. For
unattended operation, provision `platforms.teams.appPassword` through an
operator-managed ignored config or secret store before starting OpenTag. Keep
scripted command-line flags limited to non-secret values.

The setup command saves:

- `platforms.teams.appId`
- `platforms.teams.appPassword`
- `platforms.teams.tenantId` (when provided)
- `platforms.teams.webhookPath` (defaults to `/teams/messages`)

Start OpenTag:

```bash
opentag start
# or, for background mode:
opentag service start
```

OpenTag prints the local Teams webhook and reminds you to configure the public tunnel host in Azure.

### Claude Code In Service Mode

If `opentag service` runs under macOS LaunchAgent, its `PATH` may not include your interactive shell's `~/.local/bin`. If a run fails with:

If the Claude executor is not ready, complete the normal local Claude login and
restart the service. The Claude ACP adapter uses a pinned Registry package
through `npx`, so there is no direct Claude CLI path
setting:

```bash
opentag service restart
```

## Bind The Teams Channel

Teams channel bindings are keyed on `(tenantId, conversationId)`.

In real Teams channel messages, you may see both forms:

```text
channelData.channel.id: 19:...@thread.tacv2
conversation.id:        19:...@thread.tacv2;messageid=<root-message-id>
```

Prefer binding the base channel id from `channelData.channel.id` or `channelData.teamsChannelId`:

```text
provider: teams
accountId / tenantId: <tenant-id>
conversationId: 19:...@thread.tacv2
```

OpenTag also handles full thread conversation ids containing `;messageid=...` for replies and thread actions. Replies use the full Teams conversation id so they land in the same thread.

If the channel is not configured yet, OpenTag acknowledges inbound activities but cannot start a run. Use the dispatcher API or local config to create a Teams channel binding. A repository target is optional for general ACP work and required only for repository-backed coding or pull-request tasks.

## Trigger Runs

After setup and binding, mention the bot in the target channel:

```text
@OpenTag investigate this failing test
```

Use `investigate`, `review`, or `explain` for read-oriented work. For requests that should modify the repository, start with `fix` or `run` so OpenTag grants `repo:write` to the local executor:

```text
@OpenTag fix README.md by adding one sentence saying "Test from Teams."
```

If you omit `fix` or `run`, Claude Code may run in plan mode and return a plan without changing files.

Expected behavior:

- Teams posts the Activity to your Messaging endpoint over the tunnel.
- OpenTag validates the inbound Bot Framework JWT signature, issuer, audience, required `serviceUrl` claim, and the signing key's `msteams` endorsement before processing. The signed `serviceUrl` must exactly match the Activity body, so a body-controlled reply URL cannot receive the bot Connector token.
- The local runner starts in the configured repository checkout or in an isolated scratch workspace for repository-free work.
- OpenTag replies in the same Teams channel/thread as plain text.

## Apply Actions And Create Pull Requests

`@OpenTag apply 1` is supported from Teams threads, but creating a pull request requires a GitHub or GitLab repository target and apply credentials. Before any apply/reject decision or adapter mutation, OpenTag revalidates the proposal's stored Teams tenant/channel against the current channel binding and, for repository actions, requires it to still point at the same repository. Historical actions fail closed if the channel was removed or rebound.

For GitHub pull request apply, configure the repository as GitHub, not local-only:

```json
{
  "provider": "github",
  "owner": "<github-owner>",
  "repo": "<github-repo>",
  "checkoutPath": "/path/to/local/checkout",
  "defaultExecutor": "claude-code",
  "baseBranch": "main",
  "pushRemote": "origin"
}
```

Also configure a GitHub token/apply token and enable branch preparation:

```json
{
  "daemon": {
    "githubToken": "<redacted>",
    "githubApplyToken": "<redacted>",
    "preparePullRequestBranch": true
  }
}
```

Then bind the Teams channel to that GitHub repo:

```text
provider: teams
accountId: <tenant-id>
conversationId: <teams-channel-conversation-id>
repoProvider: github
owner: <github-owner>
repo: <github-repo>
```

A successful write run should show **Ready to apply**. After reviewing the receipt, approve from the same Teams thread:

```text
@OpenTag apply 1
```

If the receipt says direct apply is not configured, check that the channel binding points to a GitHub/GitLab repo and that apply credentials are configured.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No request reaches OpenTag | Azure Messaging endpoint is wrong, the Teams app is not installed, or the bot was not mentioned | Check the endpoint URL, install the app into the team, and mention the bot by name |
| Tunnel URL redirects to sign-in | `devtunnel` was started without anonymous access | Restart with `devtunnel host -p 3030 --allow-anonymous` |
| Public tunnel works but Teams returns 401 | App ID / tenant / secret mismatch, or an outdated Teams adapter build | Confirm Azure Bot App ID matches `platforms.teams.appId`, then restart OpenTag |
| Claude executor is not ready | Local Claude authentication is missing or invalid | Complete the local Claude login, restart OpenTag, and run `opentag doctor` |
| Claude returns only a plan | The command did not request write permission | Use `@OpenTag fix ...` or `@OpenTag run ...` |
| Receipt says direct apply is not configured | Repo binding is local-only or apply token is missing | Bind the channel to a GitHub/GitLab repo and configure apply credentials |
| `apply 1` cannot find or authorize an action | The command is outside the proposal thread, the service is outdated, or the channel was unbound/rebound after the proposal | Reply in the same thread, confirm the current channel binding still targets the proposal repository, and update OpenTag |

## Official References

- [Bot Framework registration quickstart](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration)
- [Create a bot for Microsoft Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams)
- [Upload custom apps in Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload)
- [Send proactive messages](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rest-api/send-proactive-messages)

## Current Scope (v1)

Supported now:

- CLI setup through `opentag setup --platform teams`.
- Bot Framework webhook ingest at `/teams/messages`, with fail-closed JWT validation (JWKS signature, issuer, audience, required matching `serviceUrl`, and `msteams` key endorsement).
- `@OpenTag` mention handling in **channel** conversations.
- `@OpenTag apply N` action routing from Teams threads.
- Plain-text channel replies.

Not yet implemented / out of scope for v1:

- Adaptive Cards or clickable Apply buttons.
- Personal chats and group chats (channels only).
- Hosted/custom relay ingress for Teams — the webhook currently runs only inside the local dispatcher.
- A standalone Teams events service.
