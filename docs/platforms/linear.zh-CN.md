# Linear 配置

当 `opentag setup --platform linear` 询问 Linear 参数时，请使用这份指南。

OpenTag 会把 Linear issue comment 当成 source thread。比如在 issue 里评论 `@opentag investigate this` 会创建一个本地 run；之后继续在同一个 Linear issue 里回复 `apply 1`，可以让 OpenTag 通过 Linear GraphQL API 回写 comment 或更新受支持的 issue 字段。

当前 CLI 路径推荐使用 Linear OAuth App / actor=app 安装，并继续兼容手动 API key。`opentag setup` 可以自动 discovery Linear team/state/user/label metadata 并写入 mapping。对于 Linear Agent run，OpenTag 可以接收 `AgentSessionEvent` webhook，更新 Linear Agent Session plan，并把 progress/final callback 作为 Agent Activity 回写。

## 你需要准备

- 一个你有权限创建 OAuth app 和 webhook 的 Linear workspace。
- 一个 Linear OAuth app，用于 GraphQL 回写和 issue 更新；快速本地验证时也可以继续使用 workspace API key。
- 一个本地项目 checkout，作为 OpenTag 的 Project Target。
- 一个公网 HTTPS tunnel，例如 ngrok，用于把 Linear webhook 转发到本机；或者一个已经配置好 Linear 能力、可信任的 OpenTag relay URL。

官方参考：

- Linear API / Webhooks 设置页：<https://linear.app/settings/api>
- Linear OAuth 文档：<https://linear.app/developers/oauth-2-0-authentication>
- Linear Agent 文档：<https://linear.app/developers/agents>
- Linear GraphQL API 文档：<https://linear.app/developers/graphql>
- Linear Webhooks 文档：<https://linear.app/developers/webhooks>

## 创建 Linear OAuth App

打开 Linear Developer / API 设置，为当前 workspace 创建 OAuth app，并配置 redirect URI。OpenTag setup 会生成 `actor=app` 授权 URL，推荐 scopes：

```text
read write comments:create app:assignable app:mentionable
```

授权后，把 redirect URL 中的 `code` 粘贴回 setup。OpenTag 会 exchange code，保存 OAuth access token / refresh token，并用该 token 自动 discovery Linear metadata。当保存的 OAuth App token 接近过期时，本地 runtime 会使用 refresh token 刷新，并把新的 access / refresh token metadata 写回 OpenTag config。

## API Key 兼容模式

如果只是快速本地验证，也可以打开 <https://linear.app/settings/api>，为当前 workspace 创建 API key。

OpenTag 会用这个 key：

- 把 OpenTag acknowledgement、progress 和 final result 作为 comment 回写到 Linear issue
- 当你回复 `apply 1` 之类的已批准 action 时，执行受支持的 Linear issue mutation

不要把 key 粘贴进聊天。只在 `opentag setup` 提示时输入，或者用本地环境变量 / config secret 传入。

## 运行 Setup

在需要处理 Linear run 的项目 checkout 下运行：

```bash
opentag setup \
  --platform linear \
  --linear-auth oauth_app \
  --linear-oauth-client-id <linear-client-id> \
  --linear-oauth-client-secret <linear-client-secret> \
  --linear-oauth-redirect-uri <linear-redirect-uri>
```

setup 会打印 Linear 授权 URL。授权后，继续运行并传入 authorization code：

```bash
opentag setup \
  --platform linear \
  --linear-auth oauth_app \
  --linear-oauth-client-id <linear-client-id> \
  --linear-oauth-client-secret <linear-client-secret> \
  --linear-oauth-redirect-uri <linear-redirect-uri> \
  --linear-oauth-code <code-from-redirect>
```

API key 兼容模式：

```bash
opentag setup \
  --platform linear \
  --linear-auth api_key \
  --linear-token <linear-api-key>
```

常用可选参数：

```bash
opentag setup \
  --platform linear \
  --linear-team-id <linear-team-id> \
  --linear-team-key ENG \
  --linear-discover-metadata \
  --linear-port 3070
```

如果你有一个可信 relay，并且它的 capabilities 标明支持 hosted OAuth install，setup
可以创建 pending relay install，不需要在本地收集 Linear secret：

```bash
opentag setup \
  --platform linear \
  --relay https://<your-relay-host>
```

setup 会写入 `auth.method: "hosted_oauth_app"`，打印 Linear OAuth install
URL，并记录 relay installation id。用户可见的 webhook URL 仍是固定 OAuth App
webhook path，通常是 `https://<your-relay-host>/linear/oauth/webhooks`。Linear
回调到 `/linear/oauth/callback` 后，relay 会保存 OAuth token 和 installation
记录。OAuth App 的 webhook signing secret 是 relay 侧 app-level 配置
（`OPENTAG_LINEAR_OAUTH_WEBHOOK_SECRET`），不是让用户复制到 Linear 的
per-install secret。OAuth app 的 webhook settings 仍需要由 relay / app
运营方配置；当前后端已经提供 install / callback / storage / webhook 路径，完整
self-service install portal 或 marketplace listing 可以之后再把这段 UX 串成闭环。
如果 Linear 之后发送该 workspace 的 `OAuthApp` `revoked` webhook，relay 会删除
已保存的 hosted install token，并记录 `linear.oauth_install.revoked`
control-plane event，后续 callback 会 fail closed，不会继续使用过期凭证。

如果你使用 static-token relay，setup 也可以写入 relay 模式，并把本地 Linear
token / signing-secret config 上传到 relay。当本地配置使用
`auth.method: "oauth_app"` 时，上传内容也会包含不含 client secret 的 OAuth
refresh metadata，让 relay 可以在 callback 和 direct apply 前刷新 Linear access
token：

```bash
opentag setup \
  --platform linear \
  --linear-auth oauth_app \
  --linear-oauth-client-id <linear-client-id> \
  --linear-oauth-client-secret <linear-client-secret> \
  --linear-oauth-redirect-uri <linear-redirect-uri> \
  --linear-oauth-code <code-from-redirect> \
  --relay https://<your-relay-host>
```

根据 auth mode 不同，setup 会写入：

- `platforms.linear.token`，除非 `auth.method` 是 `hosted_oauth_app`
- `platforms.linear.auth`
- `platforms.linear.webhookSecret`，除非 `auth.method` 是 `hosted_oauth_app`
- `platforms.linear.webhookPath`
- `platforms.linear.port`
- `platforms.linear.projectTarget`
- 可选 `platforms.linear.teamId`
- 可选 `platforms.linear.teamKey`
- 可选 `platforms.linear.graphqlUrl`
- 可选 `platforms.linear.mappings`

默认 webhook path 是 `/linear/webhooks`，本地 webhook 端口是 `3070`。

## 配置 Linear Webhook

启动本地 OpenTag：

```bash
opentag start
```

本地模式下，OpenTag 会打印类似信息：

```text
Linear local webhook: http://127.0.0.1:3070/linear/webhooks
Linear webhook URL: https://<your-tunnel-host>/linear/webhooks
Linear settings: https://linear.app/settings/api
Linear events: Comment and Agent session events (enable Webhooks on the Linear OAuth app and point them at the webhook URL above)
Tunnel example: ngrok http 3070
```

relay 模式下，OpenTag 会打印 relay URL，并且不需要本地 tunnel：

```text
Webhook URL: https://<your-relay-host>/linear/oauth/webhooks
Relay mode: Linear should call the relay URL above; no ngrok/cloudflared tunnel is needed.
```

**默认路径（OAuth App 安装）**：webhook 配置在 **OAuth app 本身**，不是 workspace webhook。
在 Linear 的 OAuth app 设置里启用 Webhooks：

- URL：公网 tunnel 加 `/linear/webhooks`
- Events：**Comment 和 Agent session events**——Agent session events 让 @提及 走
  Linear 原生 Agent Session 面板（plan、活动时间线、stop），而不是散落的普通评论
- Signing secret：把 OAuth app Webhooks 生成的 signing secret 写回 OpenTag config 的
  `platforms.linear.webhookSecret`（或 setup 的 `--linear-webhook-secret`）

当同一次 @提及 同时产生 Comment 和 Agent Session 事件时，OpenTag 双重去重：
delegate 场景下 Linear 会把合成的锚点评论标记为 `isArtificialAgentSessionRoot`，
comment 通道直接跳过；真人评论没有该标记，且 Comment 事件比对应的
AgentSessionEvent 早到约 1 秒，因此 OAuth App 模式下 comment run 会延迟一个短暂
的宽限窗口（默认 2.5s）——窗口内若收到 `agentSession.commentId` 指向该评论的
session 事件，run 由 Agent Session 通道独占创建，不会双触发。OpenTag 也会忽略
OAuth app actor（`@oauthapp.linear.app` 邮箱）自己发出的评论，避免回写的总结里
出现 `@opentag` 字样时把自己再次触发。

**API key 兼容模式**：在 Linear API / Webhooks 设置页创建 workspace webhook：

- URL：本地模式使用公网 tunnel 加 `/linear/webhooks`；动态 relay 模式使用 setup 打印的完整 `/linear/webhooks/<install-id>` URL
- Resource/event：Comment events（API key 模式没有 Agent Session 面板，OpenTag 回复以嵌套评论形式出现在触发评论的 thread 里）
- Signing secret：与 OpenTag config 里的 `platforms.linear.webhookSecret` 保持一致；如果 Linear 不允许自定义 secret，把 Linear 生成的值写回 config

Hosted OAuth App install 的 webhook delivery 是在 OAuth app 本身配置，而不是从本地
OpenTag config 里读取。relay / app 运营方需要在分发 install URL 前配置 app
webhook endpoint 为 `https://<your-relay-host>/linear/oauth/webhooks`（或配置的
`OPENTAG_LINEAR_OAUTH_WEBHOOK_PATH`），并启用 Comment 和 Agent Session events。

ingress 会先校验 `Linear-Signature` 和 webhook timestamp，通过后才会创建 run。

## 测试

在一个 Linear issue 里添加明确 mention OpenTag 的 comment：

```text
@opentag summarize what needs to change here
```

预期行为：

- Linear 把 Comment webhook 发到你的公网 tunnel 或已配置好的 relay。
- OpenTag 校验签名和 timestamp，然后创建 run。
- 本地 runner claim 这个 run，并在配置的 checkout 中执行。
- OpenTag 把 acknowledgement、progress 和 final comment 回写到同一个 Linear issue。

如果 final result 提出了 Linear issue action，可以继续回复：

```text
apply 1
```

当前 Linear issue apply 支持：

- 创建新的 Linear issue：`issue/create_issue` action 会调用 Linear `issueCreate`
- 添加 comment
- 在提供 Linear state id 或配置映射后切换状态
- 用 Linear user id 设置 assignee，也支持取消 assignee
- 设置数字 priority
- 用 Linear label id 设置 labels

从 Slack 等其他 source thread 创建 Linear issue 时，Slack/Discord/Lark/GitHub 只是来源；真正执行写入的是 Linear adapter。第一版默认仍需要人工确认：OpenTag 在源 thread 里展示 action receipt，用户点击 **Apply 1** 或回复 `apply 1` 后才调用 `issueCreate`。Linear issue create 至少需要 title 和 Linear team：可以直接提供 `teamId`，也可以使用 metadata discovery 生成的 `team/teamKey -> teamId` mapping；如果 workspace 有多个 team 且 action 没有明确 team，receipt 会进入 setup/continue 路径而不是静默创建。创建成功后，Linear issue URL 会回写到原 source thread。

Slack -> Linear issue create 不需要为了 Linear 创建动作再额外准备公网地址；`issueCreate` 是 OpenTag 到 Linear GraphQL 的 outbound 请求。是否需要公网地址只取决于 source ingress：Slack Socket Mode 不需要公网 URL，Slack Events API 仍需要 Slack 能访问的 HTTPS endpoint。

创建 pull request 仍然需要 repo-backed target。setup 创建的 Linear 事件会包含 Project Target，确保代码 run 绑定到本地 checkout；但 Linear 本身不是 git hosting provider。

## Relay 模式

Linear relay 模式适用于你自己运营的 relay，或者已经确认配置了 Linear 能力的 relay。它支持两种 setup 形态：

- Hosted OAuth App install：可信 relay 的 capabilities 标明 `oauthInstall.enabled=true`，`setup --relay` 请求 relay 创建 pending Linear install，用户打开 Linear `actor=app` authorization URL 完成授权。relay callback 会交换 code，生成并保存 webhook signing secret，保存 OAuth token / refresh metadata，并且只把不含 secret 的 install metadata 返回给 CLI。这个模式下本地 CLI 不会要求用户输入或上传 Linear API key、OAuth access token、webhook signing secret。
- Static token relay：self-hosted 或手动 provision 的 relay 通过 `/v1/linear-relay-installations` 或 relay 环境变量保存 Linear token、webhook signing secret、Project Target 和可选 GraphQL URL。

两种动态 provision 形态都会使用唯一的 `/linear/webhooks/<install-id>` path。这样 relay 可以先按 path 找到 install-specific signing secret，再校验 `Linear-Signature`，避免多个 workspace 共用一个 `/linear/webhooks` 时在验签前无法安全路由。

旧版 self-hosted relay 仍可使用全局 `/linear/webhooks` + env 配置。不要把 Linear workspace webhook 指向一个泛用 hosted relay，除非 relay 运营方明确确认已经启用 hosted OAuth install 或 Linear dynamic installation provisioning，或者已经为你的 workspace 配置匹配的 Linear signing secret 和 API key。没有 relay 侧配置时，请使用本地 `opentag start` 加公网 tunnel。

新的 Linear setup 可以直接给 `opentag setup` 传入 `--relay https://<your-relay-host>`。setup 会校验 relay health endpoint；如果可信 relay 标明支持 hosted OAuth install，setup 会创建 pending OAuth install 并打印 Linear authorization URL。否则，对于 static-token relay config，setup 会生成唯一 Linear webhook path，并在注册 runner / repo binding 时调用 `/v1/linear-relay-installations`。之后 setup 会写入 `runtime.mode=relay` 并打印准确的 Linear webhook URL。已有 config 可以运行 `opentag pair --relay https://<your-relay-host>` 来完成配对；如果 config 已经是 static-token `/linear/webhooks/<install-id>` 形式，pair 会重新上传这份 installation config。

如果你显式配置旧的 `/linear/webhooks` path，setup/pair 会回退到静态 relay readiness 检查：如果 relay 暴露 `/v1/relay/capabilities`，会在写入 relay 模式前确认 Linear ingress 和 direct apply 已启用。出站投递由 provider registry 与 delivery kernel 独立激活。

如果 relay 宣称支持 Linear 但缺 ingress/apply readiness，`setup --relay` 和
`pair --relay` 会在写入 relay 模式前失败，并打印一份脱敏的 relay 侧 env 模板。
模板会包含非敏感的 Project Target 值，以及 Linear token / signing secret 的
占位说明，避免把 secret 写进终端日志。

如果 Linear metadata discovery 生成了 team/status/user/label mappings，relay 配对
也会把这些 mappings 上传到 dispatcher 的 repository mutation-mappings，让
relay 侧 direct apply 使用和本地 config 一致的语义映射。

已配置 hosted-compatible relay 时，webhook URL 形如：

```text
https://<你的 relay 域名>/linear/webhooks/<install-id>
```

relay 必须先校验 `Linear-Signature` 和 webhook timestamp，通过后才能创建 run。

Static-token OpenTag 兼容 relay 会暴露 `/v1/linear-relay-installations`，用于保存 per-install Linear token / signing secret / Project Target。这个 endpoint 需要 dispatcher admin token；响应不会回显 token 或 signing secret。动态 webhook 创建的 run 会在 metadata 中记录非敏感的 `linearRelayInstallationId`，后续 comment callback、Agent Activity 和 direct apply 会用这个 id 从 relay DB 找回 token。

如果 relay 配置了 `OPENTAG_LINEAR_OAUTH_CLIENT_ID` 和
`OPENTAG_LINEAR_OAUTH_REDIRECT_URI`，还可以通过
`POST /v1/linear-oauth-installations` 启动 hosted Linear OAuth App install。
如果同时配置了 `OPENTAG_LINEAR_OAUTH_WEBHOOK_SECRET`，relay 会在
`/linear/oauth/webhooks` 接收固定 OAuth App webhook，并按 payload 的
`organizationId` 路由到完成安装的 workspace。install endpoint 会返回使用
`actor=app` 的 Linear authorization URL；公开的 `/linear/oauth/callback` 会交换
code，保存 per-install OAuth token / refresh token metadata，并以 best-effort
方式把 team/state/user/label metadata discovery 写成 relay 侧 mutation mappings，
最后只返回不含 secret 的 installation summary。

当 trusted relay 的 capabilities 标明支持 Linear OAuth install 时，`opentag
setup --relay <url> --platform linear` 会默认使用这条 hosted OAuth App 安装
路径。这个模式不会再要求用户输入 Linear API key 或本地 OAuth authorization
code；CLI 会请求 relay 创建 pending install，把 `auth.method:
"hosted_oauth_app"`、返回的 installation id 和 Linear OAuth install URL 写入本地
config，并保留固定 `/linear/oauth/webhooks` webhook path，然后把 install URL 打印出来让用户在 Linear 里完成安装。
这已经提供了 CLI-backed hosted install flow；更完整的 marketplace / 安装门户 UI
可以之后再做。

OpenTag 兼容 self-hosted relay 也会暴露 `/v1/relay/capabilities`。启用静态 Linear env 时，响应会列出
`provider: "linear"`，并标记 `/linear/webhooks` ingress enabled，同时标记 callback
和 apply enabled。启用 hosted OAuth install env 时，响应还会包含
`oauthInstall.enabled=true`。老版本 relay 如果没有这个端点仍然可以配对，但 setup
无法在发起 relay 请求前确认 Linear readiness。

当前 self-hosted dispatcher relay 可以用下面的环境变量配置：

```bash
OPENTAG_LINEAR_API_KEY='<linear-oauth-access-token-or-lin_api_key>'
OPENTAG_LINEAR_WEBHOOK_SECRET='<linear-webhook-signing-secret>'
OPENTAG_LINEAR_WEBHOOK_PATH=/linear/webhooks
OPENTAG_LINEAR_REPO_PROVIDER=github
OPENTAG_LINEAR_REPO_OWNER=<owner>
OPENTAG_LINEAR_REPO_NAME=<repo>
```

OAuth access token 可以带或不带 `Bearer ` 前缀；Linear API key 应该使用原始
`lin_api_...` 值。

`OPENTAG_LINEAR_REPO_PROVIDER`、`OPENTAG_LINEAR_REPO_OWNER`、`OPENTAG_LINEAR_REPO_NAME` 会写进 Linear 创建的 run 的 Project Target metadata。它们必须匹配 `opentag setup --relay ...` 或 `opentag pair --relay ...` 已注册的 repository binding；否则本地 runner 会在 executor 启动前拒绝这个 run。

## 当前支持

- `opentag setup --platform linear` CLI setup。
- `/linear/webhooks` 本地 Linear webhook ingress。
- 已签名的 Linear Comment webhook。
- OpenTag callback 作为 Linear issue comment 回写。
- 同一个 run 的 Linear status callback 会复用并更新同一条 status comment，减少 comment 噪音。
- 从 Linear comment 触发 source-thread controls 和 action replies。
- Linear issue mutation apply：create issue、comment、status、assignee、priority、labels。
- `opentag setup` 支持 OAuth App / `actor=app` authorization URL 和 code exchange。
- runtime 会为 Linear callback 和直接 issue apply 自动刷新 OAuth App token。
- `opentag setup` 支持 metadata discovery：查询 teams、workflow states、users、labels，并写入 adapter mappings；team mapping 可用于 source-thread `issue/create_issue`。
- `opentag setup --relay` 支持 Linear-capable hosted/self-hosted relay 配对；relay 配好后，本地不再需要 ngrok/cloudflared tunnel。
- Hosted-compatible OAuth install 后端 endpoint：需要认证的 `POST /v1/linear-oauth-installations` 和公开的 `/linear/oauth/callback`。
- 已有需要凭据显式开启的真实 Linear workspace smoke harness，覆盖 webhook -> run -> `commentCreate` -> `issueUpdate`。
- Linear Agent 原生路径：`AgentSessionEvent` webhook 会从 `created` 事件创建 OpenTag run，把 `prompted` activity body 作为后续指令继续执行，立即更新 Agent Session plan / accepted activity，并通过 `agentActivityCreate` 回写后续 progress/final activity。
- Linear Agent prompt activity 的 `stop` signal 会路由到 OpenTag source-thread cancellation，取消当前 Agent Session run，而不是创建新的 run。stop request 不会被当作成功完成。

## 暂不支持

- Linear Agent 支持仍基于 Linear 官方 Developer Preview API；如果 API 变化，需要同步更新。
- OpenTag 还没有面向任意 Linear workspace 的完整 hosted OAuth 安装门户 / marketplace listing；已有的后端安装 endpoint 和固定 OAuth App webhook ingress 仍需要你自己运营或信任的 Linear-capable relay URL。
- 真实 Linear workspace smoke harness 不在默认 CI 中运行，仍需要显式提供 Linear workspace 凭据。
- 除上述 issue 字段外的 Linear project / document mutation。
- Discord/Lark/GitHub 来源创建 Linear issue 复用同一个 `issue/create_issue` action 设计，但本页不声明这些来源已完成真实端到端验证。
