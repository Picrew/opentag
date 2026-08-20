# Lark / Feishu Setup

Use this guide when `opentag setup` asks how OpenTag should connect to Lark / Feishu.

OpenTag turns a Lark / Feishu source thread into a governed local agent work loop. The chat remains the human workflow surface for concise status, artifacts, and safe next actions; detailed process evidence stays in local audit/status.

## Official Links

- [Lark Developer Console](https://open.larksuite.com/app)
- [Feishu Developer Console](https://open.feishu.cn/app)
- [How to obtain App ID and App Secret](https://open.larksuite.com/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-app-id)
- [Lark long connection / WebSocket events](https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket)
- [Feishu long connection / WebSocket events](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/use-websocket?lang=zh-CN)

## Recommended Path: QR Scan

The easiest setup path is:

```text
Create a new Personal Agent
```

OpenTag shows a QR code. The setup link may start on the Feishu bootstrap page; if you scan with a Lark global tenant, the platform can switch after scan. Finish creating the Personal Agent app and keep the terminal open. OpenTag continues automatically after the app is created and saves the real Lark / Feishu tenant returned by the platform.

Use this path unless you already manage a self-built Lark / Feishu app.

## Saved Personal Agent

If OpenTag has already saved a Personal Agent on this machine, setup shows:

```text
Use saved Personal Agent
```

The CLI also shows safe details such as tenant, App ID prefix, Bot Open ID prefix, and where the saved config came from. Secrets are not printed.

Choose this when you want to reuse the existing app.

## Manual Credentials

Choose manual setup only when you already have a self-built app.

OpenTag asks for:

```text
Lark / Feishu tenant
Lark App ID
Lark App Secret
Lark Bot Open ID (optional)
```

You can find App ID and App Secret in the Lark / Feishu developer console:

1. Open the console that matches your tenant:
   - Lark: [https://open.larksuite.com/app](https://open.larksuite.com/app)
   - Feishu: [https://open.feishu.cn/app](https://open.feishu.cn/app)
2. Open your app.
3. Go to **Credentials & Basic Info**.
4. Copy **App ID** and **App Secret** into OpenTag.

The app must support bot messages and long-connection events. If you are not sure, use the QR scan path instead.
OpenTag verifies saved and manually entered app credentials with the provider
before writing them into the active CLI config, so stale app secrets fail during
setup instead of later at service start.

## Tenant

OpenTag asks which tenant the existing app belongs to:

- `Lark` for larksuite.com tenants
- `Feishu` for feishu.cn tenants

Pick the one that matches the app you created.

For non-interactive setup with an existing app, pass `--tenant feishu` or `--tenant lark`. If you omit `--tenant` in manual setup, OpenTag defaults to `feishu`.

## Read-Only User Resource Access

After the Lark / Feishu platform is configured, authorize OpenTag with your own
user identity:

```bash
opentag feishu login --config <path>
```

Omit `--config` when you use the default OpenTag config. The command opens the
official Lark OpenAPI MCP OAuth flow and stores the resulting user session in
its encrypted local token store. The default callback is
`http://localhost:3000/callback`; add that exact redirect URL to a manually
managed app before logging in. Restart a running OpenTag service after a
successful login.

The app must have these resource permissions enabled in the developer console:

```text
docx:document:readonly
drive:drive:readonly
wiki:wiki:readonly
im:message.group_msg
sheets:spreadsheet:readonly
bitable:app:readonly
```

QR-created Personal Agent apps request these permissions for new apps. For an
existing or manually managed app, enable them and publish the updated app
version before running the login command. `offline_access` is requested during
user OAuth so the local session can refresh; it is not a tenant app permission.

Access requires both an app API scope and the target resource ACL. OpenTag uses
a `user_access_token`, so it can only read content that the authorizing user can
already open. Granting an app scope does not bypass document, folder, Wiki, or
chat membership permissions.

Once enabled, an addressed message can:

- include an explicit Lark / Feishu document, Drive, folder, Wiki, Sheet, or
  Bitable URL for bounded content preloading;
- ask the agent to use read-only tools for documents, Drive discovery, Wiki,
  Bitable, or chat history;
- attach a current-message text file, PDF, DOCX, PPTX, XLSX, or supported
  OpenDocument / RTF file for local text extraction.

Drive and Wiki discover resources, then dispatch them to the matching content
reader. Chat attachments are fetched from the IM message-resource API instead
of Drive. The official OpenAPI MCP does not download message attachments, so
OpenTag's native reader handles that step. Downloads and parsing are limited to
100 MB per resource. Images, audio, and video remain typed attachment
references in this first version; OCR and transcription are disabled.

When an addressed request arrives, OpenTag preloads at most the 20 most recent
relevant messages from the same conversation. Main-channel requests use recent
top-level messages; topic replies use only that topic. This bounded context is
marked as untrusted background, not as new instructions. OpenTag still reads
only explicit URLs, current-message attachments, and resources requested through
a tool. It does not ambiently scan an entire Drive or chat history. Enabling
resource access also does not relax chat addressing: group messages must still
@-mention the bot.

## Group Chat And Task Topics

OpenTag routes addressed requests before delivery:

- Questions, explanations, capability checks, and other answer-only requests
  receive one plain-text reply in the main conversation.
- Code changes, tests, deployments, investigations, and other multi-step work
  run asynchronously and keep status, approvals, and the final result in a topic.
- Replies already inside a topic stay there.
- `/chat` forces an answer-only reply; `/task` forces an asynchronous topic task.
- Unaddressed group conversation remains quiet. A previously accepted task may
  still post its completion without another mention.

## In-Chat Commands

OpenTag keeps Lark / Feishu commands Project Target based:

- `/bind <owner>/<repo>` or `/bind <provider>:<owner>/<repo>` connects the current chat to a Project Target.
- `/unbind confirm` disconnects the current chat from its Project Target; it does not delete local checkout config, repository bindings, or allowlists.
- `/status` shows the bound Project Target, the current active run when one exists, queued follow-ups, and safe next actions.
- `/doctor` shows a redacted readiness summary. Secrets and local paths are not printed in the chat.
- `/stop [run_id]` requests cancellation for the active chat run or the specified run. OpenTag does not treat a stop request as a successful completion.

Group chats must @-mention the bot before commands or runs. Direct messages may be more permissive, but they still use Project Target bindings instead of absolute local paths. In group chats, `/bind` and `/unbind confirm` also require a binding-admin allowlist entry (`OPENTAG_LARK_BINDING_ADMIN_OPEN_IDS`, `OPENTAG_LARK_BINDING_ADMIN_USER_IDS`, or `OPENTAG_LARK_BINDING_ADMIN_UNION_IDS`).

For a newly-created run, OpenTag keeps the chat quiet by default: it marks the
source message with a lightweight "typing" reaction to show that work started.
If the run finishes quickly, OpenTag skips the intermediate status card and posts
only the final result. If the run crosses the delayed-status threshold, OpenTag
posts one updateable status card, throttles routine progress updates, and patches
the final result back into that same card when the platform accepts card updates.
Routine executor details stay in the audit log; use `/status` in the chat or
`opentag status --run <run_id>` locally for active state and audit detail. If the
platform rejects the source receipt, OpenTag falls back to a short received card
so users still get immediate liveness.

## Test

After setup, make sure OpenTag is running:

```bash
opentag service status
```

If you chose terminal mode, or if background service mode is unsupported on your
platform, run `opentag start` instead and keep that terminal open.

Then mention or message the Personal Agent from Lark / Feishu. OpenTag should add
a lightweight received reaction, run the selected coding agent locally, and later
post the final result card in the same conversation. Longer runs may also show
one updateable status card before completion.
