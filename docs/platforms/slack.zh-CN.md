# Slack 配置教程

当 `opentag setup` 询问 Slack 配置时，用这份教程对照填写。

OpenTag 支持两种 Slack 连接方式：

- **本地 Socket Mode**：推荐在这台电脑上运行 OpenTag 时使用，不需要公网 URL。
- **公网 Events API**：适合云端部署，或者高级用户用 tunnel 做本地测试。

两种方式最终都支持同一个核心体验：在 Slack 里 mention 这个 app，OpenTag 把这个 Slack thread 变成一个可治理的 agent 工作回路，在本机运行 coding agent，然后把简洁产物、状态和安全下一步回复回同一个 Slack thread。详细过程留在本地 audit/status 里，不把 Slack 变成 agent 内部日志流。

Slack-only setup 证明的是 Slack 这条链路。它不会自动获得 GitHub 写权限。如果某次 run 产出了 pull request action，只有在 OpenTag 同时配置了 GitHub repository target 和 GitHub token 时，Slack thread 里的 `apply 1` 才能直接创建 GitHub PR。

Suggested action 按钮依赖 Slack Block Kit interactivity。需要在 Slack app 里开启 **Interactivity & Shortcuts**，这样 **Apply 1**、**Continue**、**Reject** 这类状态驱动按钮才会提交和手动 thread reply 相同的 source-thread action。

## 官方入口

- [Slack App 管理页](https://api.slack.com/apps)
- [Slack App Quickstart](https://docs.slack.dev/quickstart/)
- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack interactivity](https://api.slack.com/interactivity)
- [Slack OAuth scopes](https://api.slack.com/scopes)

## 推荐：本地 Socket Mode

如果你想让这台电脑上的本地 OpenTag runtime 直接接收 Slack mention，选这个模式。

### 你需要准备什么

- 一个安装到 Slack workspace 的 Slack App。
- 这个 app 已开启 Socket Mode。
- 一个以 `xapp-` 开头的 Slack App-Level Token。
- 一个以 `xoxb-` 开头的 Slack Bot User OAuth Token。
- 一个用于测试的 Slack channel。

### 创建 Slack App

1. 打开 [Slack API Apps](https://api.slack.com/apps)。
2. 创建一个新的 app，选择 **From scratch**。
3. 选择要测试的 workspace。
4. 保持这个 app 页面打开。OpenTag 后面问到的 Slack 值都从这个页面拿。

如果 Slack 提供 **Create from manifest**，这条路更快。Manifest 里一次性配置：

- 开启 Socket Mode。
- Bot scopes: `app_mentions:read`, `chat:write`, `reactions:write`, `channels:history`。
- Bot event subscriptions: `app_mention`, `message.channels`。

后面仍然需要安装 app，并创建 App-Level Token。

### 开启 Socket Mode

1. 在 [Slack API Apps](https://api.slack.com/apps) 里打开你的 app。
2. 进入 **Socket Mode**。
3. 打开 Socket Mode。
4. 创建一个 App-Level Token，添加这个 scope：
   - `connections:write`
5. 复制 App-Level Token。它一般以 `xapp-` 开头。

OpenTag 里对应这个字段：

```text
Slack App-Level Token
```

### 添加 Bot 权限

1. 在同一个 Slack app 里进入 **OAuth & Permissions**。
2. 在 **Bot Token Scopes** 里添加：
   - `app_mentions:read`
   - `chat:write`
   - `reactions:write`
   - `channels:history`
3. 安装或重新安装 app 到 workspace。
4. 复制 **Bot User OAuth Token**。它一般以 `xoxb-` 开头。

OpenTag 里对应这个字段：

```text
Slack Bot User OAuth Token
```

### 订阅 App Mention 事件

1. 在同一个 Slack app 里进入 **Event Subscriptions**。
2. 打开事件订阅。
3. 在 **Subscribe to bot events** 里添加：
   - `app_mention`
   - `message.channels`
4. 保存设置。

Socket Mode 不需要填写 Request URL。`opentag start` 会主动连到 Slack WebSocket，Slack 会通过这条连接把事件推回来。

`message.channels` 用来接收 public channel 里的 thread reply，比如用户回复 `apply 1`。如果你要在 private channel 里测试，还要添加 `groups:history` bot scope，并订阅 `message.groups`。

### 开启按钮交互

1. 在同一个 Slack app 里进入 **Interactivity & Shortcuts**。
2. 打开 **Interactivity**。
3. Socket Mode 不需要填写 Request URL。Slack 会通过同一条 Socket Mode WebSocket 连接发送 Block Kit button action。
4. 保存设置。

这一步会让 Slack 里的 **Apply 1**、**Continue**、**Reject** 按钮真正可用。如果没有开启 Interactivity，OpenTag 仍然可以接收用户手打的 thread reply，但点击按钮会在 Slack 侧失败，事件不会到达 OpenTag。

## 高级：公网 Events API

如果 OpenTag 有一个稳定的公网 endpoint，或者你明确要用 tunnel 做本地测试，选这个模式。

### 你需要准备什么

- 一个安装到 Slack workspace 的 Slack App。
- 一个可以转发到本机 OpenTag Slack ingress 的公网 URL。
- Slack Signing Secret。
- Slack Bot User OAuth Token。
- 一个用于测试的 Slack channel。

本地测试时，可以先用 tunnel 暴露 OpenTag。Cloudflare Tunnel 很适合快速手动测试：

```bash
cloudflared tunnel --url http://localhost:3040
```

也可以用 ngrok：

```bash
ngrok http 3040
```

验证 Slack app 时，保持 tunnel 进程运行。免费的 Cloudflare `trycloudflare.com` 地址会在重启 `cloudflared` 后变化，所以每次重启 tunnel 后都要更新 Slack 里的 Request URL。

Slack 的 Request URL 应该长这样：

```text
https://<你的 tunnel 域名>/slack/events
```

不要把 `http://localhost:3040/slack/events` 填进 Slack Request URL。Slack 会从 Slack 自己的服务器访问并验证这个 URL，所以它必须是一个会转发到本机 OpenTag Slack ingress 的公网 HTTPS URL。

### 配置 Events API

1. 在 [Slack API Apps](https://api.slack.com/apps) 里打开你的 app。
2. 进入 **Basic Information** -> **App Credentials**，复制 **Signing Secret**。
3. 进入 **OAuth & Permissions**，添加同样的 bot scopes：
   - `app_mentions:read`
   - `chat:write`
   - `reactions:write`
   - `channels:history`
4. 安装或重新安装 app。
5. 进入 **Event Subscriptions**。
6. 打开事件订阅。
7. 填入 Request URL：

```text
https://<你的 tunnel 域名>/slack/events
```

8. 在 **Subscribe to bot events** 里添加：
   - `app_mention`
   - `message.channels`
9. 保存设置。

### 配置按钮交互

1. 在同一个 Slack app 里进入 **Interactivity & Shortcuts**。
2. 打开 **Interactivity**。
3. 填入同一个公网 Request URL：

```text
https://<你的 tunnel 域名>/slack/events
```

4. 保存设置。

这条 Events API 路线不要开启 Socket Mode，否则你会调错接入方式。

`message.channels` 用来接收 public channel 里的 thread reply，比如用户回复 `apply 1`。如果你要在 private channel 里测试，还要添加 `groups:history` bot scope，并订阅 `message.groups`。

**Event Subscriptions** 和 **Interactivity & Shortcuts** 都使用同一个 `/slack/events` URL。OpenTag 会对两类请求都做 Slack 签名校验，然后把按钮点击转成和手动回复相同的 `/v1/thread-actions` 流程。

如果 Slack 提示 Request URL 没有返回 challenge value，优先检查这三件事：

1. `opentag start` 或 Slack Events ingress 正在本机 `3040` 端口运行。
2. tunnel 转发的是 `http://localhost:3040`，不是 dispatcher 端口。
3. Slack 里的 Request URL 以 `/slack/events` 结尾，并且使用的是当前 tunnel hostname。

## 找到 Team ID 和 Channel ID

OpenTag 会继续问：

```text
Slack Team ID
Slack Channel ID
```

最简单的获取方式：

1. 用浏览器打开 Slack。
2. 进入目标 channel。
3. 复制浏览器地址栏里的 channel URL，它通常包含这两个 ID：

```text
https://app.slack.com/client/T0123456789/C0123456789
```

在这个例子里：

- Team ID 是 `T0123456789`
- Channel ID 是 `C0123456789`

测试前记得把 Slack app 邀请进这个 channel。在目标 channel 里运行：

```text
/invite @OpenTag
```

如果你改过 app 显示名称，就用实际的 app 名称。

## 测试

setup 完成后，先确认 OpenTag 正在运行：

```bash
opentag service status
```

如果你选择的是前台终端模式，或者当前平台暂不支持后台 service，就改用 `opentag start`，并保持这个终端打开。

然后在绑定的 Slack channel 里 mention 这个 app：

```text
@OpenTag summarize this thread
```

OpenTag 应该会先确认收到请求，执行完成后再回到同一个 Slack thread 里回复。
默认确认方式是在你的源消息上加一个轻量的 `eyes` reaction，而不是额外发一条 thread reply。

Slack 自服务命令仍然围绕 Project Target：

- `@OpenTag /help`：查看支持的 Slack 命令和 action reply 规则。
- `@OpenTag /bind <owner>/<repo>` 或 `@OpenTag /bind <provider>:<owner>/<repo>`：把这个 Slack channel 连接到一个 Project Target。
- `@OpenTag /status`：查看当前绑定的 Project Target、active run、排队 follow-up 和下一步安全操作。
- `@OpenTag /doctor`：查看这个 Slack channel 的 redacted readiness summary。
- `@OpenTag /stop [run_id]`：请求取消当前 Slack channel 的 active run，或取消指定 run。停止请求不会被当作成功完成。
- `@OpenTag /unbind confirm`：解除这个 Slack channel 和 Project Target 的连接。它不会删除本机 checkout 配置、repository binding 或 allowlist。

这些命令不接受本机绝对 checkout 路径。本机路径只应该留在 runner config 和 allowlist 里，不应该写进 Slack 历史。Slack channel 的绑定变更还要求发送者的 Slack user id 出现在 `OPENTAG_SLACK_BINDING_ADMIN_USER_IDS`；否则应从本机配置或 dispatcher API 更新绑定。详细过程和 audit 数据默认留在本机；需要更深排查时用 `opentag status --run <run_id>` 或 `opentag service status`。

只读的 `@OpenTag /linear` 命令使用独立的 channel allowlist，不会把
repository Project Target binding 当作授权依据。请在
`platforms.linear.channels` 中加入精确匹配的 `(teamId, channelId)`，并在该
entry 中指定这个 channel 可以查询的 Linear `projectId`。未列入 allowlist
的 channel 会在读取 Linear credential 或调用 Linear API 之前被拒绝；
`platforms.linear.projectId` 和 `OPENTAG_LINEAR_PROJECT_ID` 都不会作为全局
project fallback。

在 Events API 模式里，只有精确的 `@OpenTag /linear` 或 `@OpenTag linear`
查询会进入受限的异步 query lane。这个 lane 是 best-effort：正常关闭时会
drain 已接收查询，队列满时返回 `503`；如果进程突然退出，已经 ACK 的查询
仍可能丢失，此时可以安全地重新执行 `/linear`。创建 run、stop/bind/unbind、
审批和交互按钮都不会进入这条内存队列；OpenTag 会等它们处理完成后再返回
对应的 Events API HTTP 响应。

query-only credential 建议配置在
`platforms.linear.connections.default.token`。它只能用于 backlog read，
不会创建 Agent Run，也不会启用 Linear mutation；query-only 配置不需要
`webhookSecret`。可选的 `connection` 字段目前只支持 `default`，其他名称会
fail closed，不会回退到别的 workspace token。

当 OpenTag 发出 suggested actions 时，先看 receipt state。如果显示 **Ready to apply**，可以在 Slack 里点击 **Apply 1**，也可以在线程里手动回复 `apply 1`。两种方式都会应用同一个 source-thread action。
如果 receipt 显示 **Needs setup**，OpenTag 会显示 **Continue** 或 setup hint，而不是把 **Apply 1** 当成主路径。想让 Slack receipt 直接创建 PR，需要先配置 GitHub repository target。

Slack 也可以作为创建 Linear issue 的 source thread：例如让 OpenTag “create a Linear issue”，run 的 final result 可以给出 `issue/create_issue` action receipt。默认不会静默创建，仍需要点击 **Apply 1** 或回复 `apply 1`；成功后 Slack thread 会收到 Linear issue URL。这个动作需要 OpenTag 同时配置 Linear OAuth App / actor=app token，并且能确定 Linear team：action 里提供 `teamId`，或使用 Linear metadata discovery 生成的 `team/teamKey -> teamId` mapping。多 team workspace 如果没有明确 team，会显示 setup/continue hint。

Slack -> Linear issue create 不需要额外给 Linear 创建动作准备公网地址；创建 issue 是 OpenTag 到 Linear GraphQL 的 outbound 请求。是否需要公网 URL 只取决于你选择的 Slack ingress：Socket Mode 不需要公网 URL，Events API 仍需要 Slack 可访问的 HTTPS endpoint。Discord、Lark、GitHub 后续可以复用同一个 `issue/create_issue` action 设计，但本 Slack 文档只说明 Slack 路径。

如果 suggested action 按钮能看到，但点击后 Slack 提示失败，优先检查 **Interactivity & Shortcuts**：

- Socket Mode：Interactivity 已开启，不需要 Request URL。
- Events API：Interactivity 已开启，Request URL 是 `https://<你的 tunnel 域名>/slack/events`。
