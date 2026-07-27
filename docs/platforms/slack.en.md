# Slack Setup

Use this guide when `opentag setup` asks for Slack credentials.

OpenTag supports two Slack connection modes:

- **Local Socket Mode**: recommended for running OpenTag on this computer. No public URL is required.
- **Public Events API**: best for hosted OpenTag, or advanced local testing with a tunnel.

Both modes support the same core product flow: mention the Slack app, let OpenTag turn that Slack thread into a governed agent work loop, run a local coding agent, and get concise artifacts, status, and safe next actions back in the same Slack thread. Detailed process stays in local audit/status instead of becoming Slack noise.

Slack-only setup proves the Slack loop. It does not by itself grant GitHub write access. If a run proposes a pull request action, `apply 1` can create a GitHub PR only when OpenTag also has a GitHub repository target and GitHub token configured.

Suggested action buttons use Slack Block Kit interactivity. Enable **Interactivity & Shortcuts** in the Slack app so state-driven buttons such as **Apply 1**, **Continue**, and **Reject** can submit the same source-thread action as a typed thread reply.

## Official Links

- [Slack app settings](https://api.slack.com/apps)
- [Slack app quickstart](https://docs.slack.dev/quickstart/)
- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack interactivity](https://api.slack.com/interactivity)
- [Slack OAuth scopes](https://api.slack.com/scopes)

## Recommended: Local Socket Mode

Choose this mode when you want the local OpenTag runtime on your computer to receive Slack mentions directly.

### What You Need

- A Slack app installed in your workspace.
- Socket Mode enabled for that app.
- A Slack App-Level Token that starts with `xapp-`.
- A Slack Bot User OAuth Token that starts with `xoxb-`.
- The target Slack channel where people will mention the app.

### Create the Slack App

1. Open [Slack API Apps](https://api.slack.com/apps).
2. Create a new app from scratch.
3. Choose the workspace where you want to test OpenTag.
4. Keep this app page open. Every Slack value OpenTag asks for comes from this page.

If Slack offers **Create from manifest**, that is the fastest path. Use a manifest with:

- Socket Mode enabled.
- Bot scopes: `app_mentions:read`, `chat:write`, `reactions:write`, `channels:history`.
- Bot event subscriptions: `app_mention`, `message.channels`.

You still need to install the app and create the App-Level Token in the steps below.

### Enable Socket Mode

1. In [Slack API Apps](https://api.slack.com/apps), open your app.
2. Go to **Socket Mode**.
3. Enable Socket Mode.
4. Create an App-Level Token with this scope:
   - `connections:write`
5. Copy the App-Level Token. It starts with `xapp-`.

OpenTag asks for this as:

```text
Slack App-Level Token
```

### Add Bot Permissions

1. In the same Slack app, go to **OAuth & Permissions**.
2. Under **Bot Token Scopes**, add:
   - `app_mentions:read`
   - `chat:write`
   - `reactions:write`
   - `channels:history`
3. Install or reinstall the app to your workspace.
4. Copy **Bot User OAuth Token**. It starts with `xoxb-`.

OpenTag asks for this as:

```text
Slack Bot User OAuth Token
```

### Subscribe to App Mentions

1. In the same Slack app, go to **Event Subscriptions**.
2. Enable events.
3. Under **Subscribe to bot events**, add:
   - `app_mention`
   - `message.channels`
4. Save changes.

Do not enter a Request URL for Socket Mode. Slack delivers the event through the WebSocket connection opened by `opentag start`.

`message.channels` lets OpenTag receive thread replies such as `apply 1` in public channels. For private channels, also add the `groups:history` bot scope and subscribe to `message.groups`.

### Enable Interactivity For Buttons

1. In the same Slack app, go to **Interactivity & Shortcuts**.
2. Turn **Interactivity** on.
3. Do not enter a Request URL for Socket Mode. Slack sends Block Kit button actions over the same Socket Mode WebSocket connection.
4. Save changes.

This is what makes Slack buttons such as **Apply 1**, **Continue**, and **Reject** work. If Interactivity is off, OpenTag can still receive typed thread replies, but clicking a button will fail in Slack before it reaches OpenTag.

## Advanced: Public Events API

Choose this mode when OpenTag has a stable public endpoint, or when you intentionally want to test with a tunnel.

### What You Need

- A Slack app installed in your workspace.
- A public URL that forwards to your local OpenTag Slack ingress.
- A Slack Signing Secret.
- A Slack Bot User OAuth Token.
- The target Slack channel where people will mention the app.

For local testing, expose OpenTag with a tunnel. Cloudflare Tunnel works well for quick manual tests:

```bash
cloudflared tunnel --url http://localhost:3040
```

ngrok works too:

```bash
ngrok http 3040
```

Keep the tunnel process running while you verify the Slack app. The free Cloudflare `trycloudflare.com` URL changes when you restart `cloudflared`, so update Slack's Request URL after each restart.

Your Slack Request URL should look like:

```text
https://<your-tunnel-host>/slack/events
```

Do not use `http://localhost:3040/slack/events` as the Slack Request URL. Slack validates the URL from Slack's servers, so it must be a public HTTPS URL that forwards to your local OpenTag Slack ingress.

### Configure Events API

1. In [Slack API Apps](https://api.slack.com/apps), open your app.
2. Go to **Basic Information** -> **App Credentials** and copy **Signing Secret**.
3. Go to **OAuth & Permissions** and add the same bot scopes:
   - `app_mentions:read`
   - `chat:write`
   - `reactions:write`
   - `channels:history`
4. Install or reinstall the app.
5. Go to **Event Subscriptions**.
6. Enable events.
7. Paste your Request URL:

```text
https://<your-tunnel-host>/slack/events
```

8. Under **Subscribe to bot events**, add:
   - `app_mention`
   - `message.channels`
9. Save changes.

### Configure Interactivity For Buttons

1. In the same Slack app, go to **Interactivity & Shortcuts**.
2. Turn **Interactivity** on.
3. Paste the same public Request URL:

```text
https://<your-tunnel-host>/slack/events
```

4. Save changes.

Do not enable Socket Mode for this Events API setup.

`message.channels` lets OpenTag receive thread replies such as `apply 1` in public channels. For private channels, also add the `groups:history` bot scope and subscribe to `message.groups`.

Use the same `/slack/events` URL for **Event Subscriptions** and **Interactivity & Shortcuts**. OpenTag verifies the Slack signature for both request types, then routes button clicks into the same `/v1/thread-actions` flow used by typed replies.

If Slack says the Request URL did not respond with the challenge value, check these three things:

1. `opentag start` or the Slack Events ingress is running locally on port `3040`.
2. Your tunnel forwards to `http://localhost:3040`, not the dispatcher port.
3. The Request URL in Slack ends with `/slack/events` and uses the current tunnel hostname.

## Find Team and Channel IDs

OpenTag asks for:

```text
Slack Team ID
Slack Channel ID
```

You can find them in Slack:

1. Open Slack in the browser.
2. Open the target channel.
3. Copy the channel URL. It usually contains both IDs:

```text
https://app.slack.com/client/T0123456789/C0123456789
```

In that example:

- Team ID: `T0123456789`
- Channel ID: `C0123456789`

Invite the Slack app to the channel before testing. In the target channel, run:

```text
/invite @OpenTag
```

Use your app's actual display name if you renamed it.

## Test

After setup, make sure OpenTag is running:

```bash
opentag service status
```

If you chose terminal mode, or if background service mode is unsupported on your
platform, run `opentag start` instead and keep that terminal open.

Then mention the app in the bound channel:

```text
@OpenTag summarize this thread
```

OpenTag should acknowledge the request and later reply in the same Slack thread.
By default, the acknowledgement is a lightweight `eyes` reaction on your source message instead of a new thread reply.

Slack self-service commands stay Project Target based:

- `@OpenTag /help` shows the supported Slack commands and action-reply rules.
- `@OpenTag /bind <owner>/<repo>` or `@OpenTag /bind <provider>:<owner>/<repo>` connects this Slack channel to a Project Target.
- `@OpenTag /status` shows the bound Project Target, active run, queued follow-ups, and the next safe action.
- `@OpenTag /doctor` shows a redacted readiness summary for this Slack channel.
- `@OpenTag /stop [run_id]` requests cancellation for the active Slack channel run or a specific run. A stop request is not treated as successful completion.
- `@OpenTag /unbind confirm` disconnects this Slack channel from its Project Target. It does not delete local checkout config, repository bindings, or allowlists.

These commands do not accept absolute local checkout paths. Local paths belong in runner config and allowlists, not in Slack history. Channel binding changes also require the sender's Slack user id to be listed in `OPENTAG_SLACK_BINDING_ADMIN_USER_IDS`; otherwise update bindings from local config or the dispatcher API. Detailed process and audit data stay local; use `opentag status --run <run_id>` or `opentag service status` for deeper inspection.

The read-only `@OpenTag /linear` command uses a separate channel allowlist;
it does not use the repository Project Target binding as authorization. Add an
exact `(teamId, channelId)` entry under `platforms.linear.channels`, with the
Linear `projectId` that channel may query. An unlisted channel is denied before
OpenTag reads a Linear credential or calls Linear, and there is no global
project fallback from `platforms.linear.projectId` or
`OPENTAG_LINEAR_PROJECT_ID`.

In Events API mode, only an exact `@OpenTag /linear` or `@OpenTag linear` query
uses the bounded asynchronous query lane. The lane is best effort: it is drained
for up to 30 seconds on graceful shutdown, returns `503` when full, and may lose
an acknowledged query after that drain bound or if the process exits abruptly.
Re-run `/linear` in that case. Run
creation, stop/bind/unbind commands, approvals, and interactive buttons remain
outside this lane and finish processing before OpenTag returns their HTTP
response.

For query-only credentials, prefer
`platforms.linear.connections.default.token`. That credential only powers
backlog reads and does not create an Agent Run or enable Linear mutations. A
query-only setup does not need `webhookSecret`. The optional `connection` field
currently supports only `default`; other names fail closed instead of falling
back to another workspace token.

When OpenTag posts suggested actions, follow the receipt state. If it says **Ready to apply**, click **Apply 1** in Slack or type `apply 1` in the thread. Both paths apply the same source-thread action.
If the receipt says **Needs setup**, OpenTag will show **Continue** or a setup hint instead of presenting **Apply 1** as the primary path. Configure GitHub as a repository target before expecting Slack receipts to create PRs directly.

Slack can also be the source thread for creating Linear issues. For example, ask OpenTag to "create a Linear issue"; the run's final result can show an `issue/create_issue` action receipt. OpenTag does not create the issue silently by default: click **Apply 1** or reply with `apply 1`, then the Slack thread receives the created Linear issue URL. This requires Linear OAuth App / actor=app credentials in OpenTag and a resolvable Linear team: provide `teamId` in the action, or use Linear metadata discovery to map `team/teamKey -> teamId`. Multi-team workspaces without an explicit team show setup/continue guidance instead of creating an issue.

Slack -> Linear issue creation does not require an extra public URL for the Linear create action; issue creation is an outbound GraphQL request from OpenTag to Linear. Public URL needs only depend on the Slack ingress mode: Socket Mode needs no public URL, while Events API still needs a Slack-reachable HTTPS endpoint. Discord, Lark, and GitHub can reuse the same `issue/create_issue` action design later, but this Slack guide only documents the Slack path.

If suggested action buttons are visible but clicking them shows an error in Slack, re-check **Interactivity & Shortcuts**:

- Socket Mode: Interactivity is on, and no Request URL is required.
- Events API: Interactivity is on, and the Request URL is `https://<your-tunnel-host>/slack/events`.
