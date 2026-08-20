# Lark/飞书配置教程

当 `opentag setup` 询问 Lark/飞书连接方式时，用这份教程对照选择。

OpenTag 会把 Lark/飞书 source thread 变成本地可治理的 agent 工作回路。群聊或会话仍然是人的工作界面，只接收简洁状态、产物和安全下一步；详细过程证据留在本地 audit/status。

## 官方入口

- [Lark 开发者后台](https://open.larksuite.com/app)
- [飞书开发者后台](https://open.feishu.cn/app)
- [如何获取应用 ID 和应用密钥（App ID / App Secret）](https://open.larksuite.com/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-app-id)
- [Lark 长连接（WebSocket）事件](https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket)
- [飞书长连接（WebSocket）事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/use-websocket?lang=zh-CN)

## 推荐方式：扫码创建个人代理应用

最简单的方式是：

```text
扫码创建个人代理应用
```

OpenTag 会显示一个二维码。这个设置链接可能从飞书 bootstrap 页面开始；如果你用 Lark 国际租户扫码，平台可以在扫码后切换。完成个人代理应用创建后保持终端打开，OpenTag 会继续设置，并保存平台返回的真实 Lark/飞书租户。

除非你已经有自己维护的 Lark/飞书自建应用，否则优先选这个方式。

## 使用已保存的个人代理应用

如果这台电脑上已经保存过个人代理应用，设置向导会显示：

```text
使用已保存的个人代理应用
```

命令行会显示一些安全信息，例如租户、应用 ID 前后缀、机器人 Open ID 前后缀，以及这个配置来自哪里。应用密钥不会被打印出来。

如果你想复用之前创建过的应用，就选这个。

## 手动填写凭据

只有当你已经有 Lark/飞书自建应用时，才选手动填写。

OpenTag 会问：

```text
Lark/飞书租户
Lark 应用 ID
Lark 应用密钥
Lark 机器人 Open ID（可选）
```

应用 ID 和应用密钥可以在 Lark/飞书开发者后台找到：

1. 打开你租户对应的后台：
   - Lark: [https://open.larksuite.com/app](https://open.larksuite.com/app)
   - 飞书: [https://open.feishu.cn/app](https://open.feishu.cn/app)
2. 打开你的应用。
3. 进入 **Credentials & Basic Info / 凭证与基础信息**。
4. 复制 **App ID** 和 **App Secret**，填回 OpenTag。

这个应用需要支持机器人消息和长连接事件。如果你不确定这些是什么，直接用扫码创建个人代理应用会更稳。
OpenTag 会在写入当前 CLI 配置前向平台验证复用的历史凭据和手动填写的应用凭据，
所以过期或错误的 app secret 会在 setup 阶段失败，而不是等到 service start 才暴露。

## 租户

只有手动填写已有应用时，OpenTag 才会询问这个应用属于哪个租户：

- `Lark` 对应 larksuite.com 租户
- `Feishu` 对应 feishu.cn 租户

选择你创建应用时所在的租户。扫码创建时不需要预选，OpenTag 会保存平台返回的结果。

如果用命令行配置已有应用，传 `--tenant feishu` 或 `--tenant lark`。手动配置时如果省略 `--tenant`，OpenTag 默认使用 `feishu`。

## 只读用户资源访问

完成 Lark/飞书平台配置后，用当前飞书用户身份授权 OpenTag：

```bash
opentag feishu login --config <path>
```

使用默认 OpenTag 配置时可以省略 `--config`。命令会启动飞书官方 OpenAPI MCP 的
OAuth 流程，并把用户会话保存在它的本地加密 token store 中。默认回调地址是
`http://localhost:3000/callback`；如果使用自己维护的应用，需要先在开发者后台添加
这个完整的重定向 URL。登录成功后，正在运行的 OpenTag 服务需要重启才能加载工具。

应用需要在开发者后台启用以下资源权限：

```text
docx:document:readonly
drive:drive:readonly
wiki:wiki:readonly
im:message.group_msg
sheets:spreadsheet:readonly
bitable:app:readonly
```

扫码新建的个人代理应用会请求这些权限。已有应用或手动维护的应用需要先添加权限，
并发布更新后的应用版本，再执行登录命令。用户 OAuth 还会请求 `offline_access`，用于
在本机刷新会话；它不是 tenant 应用权限。

访问权限由“应用 API Scope + 目标资源 ACL”共同决定。OpenTag 使用
`user_access_token`，所以只能读取当前授权用户原本就能打开的内容；应用获得 API
权限并不会绕过文档、文件夹、知识库或群成员权限。

启用后，明确发给机器人的消息可以：

- 携带 Lark/飞书文档、云盘文件、文件夹、Wiki、Sheet 或 Bitable URL，OpenTag 会在
  有界限制内预加载内容；
- 让 Agent 使用只读工具读取文档、发现云盘资源、遍历 Wiki、读取 Bitable 或查询群聊历史；
- 附带当前消息中的文本、PDF、DOCX、PPTX、XLSX，以及支持的 OpenDocument/RTF
  文件，在本机提取文本。

Drive 和 Wiki 只负责发现资源，之后会分发给对应内容 Reader。群聊附件通过 IM
Message Resource API 获取，不从 Drive 扫描。飞书官方 OpenAPI MCP 本身不下载消息
附件，所以这一步由 OpenTag 原生 Reader 完成。单个资源下载和解析上限为 100 MB。
首版对图片、音频和视频只保留类型化附件引用，不启用 OCR 或转录。

OpenTag 只读取显式 URL、当前消息附件，以及 Agent 明确调用工具请求的资源，不会
自动扫描整个云盘或完整群历史。开启资源访问也不会放宽聊天触发边界：群聊中仍然
必须 @ 机器人。

## 聊天内命令

OpenTag 在 Lark/飞书里的命令都围绕 Project Target，而不是本机绝对路径：

- `/bind <owner>/<repo>` 或 `/bind <provider>:<owner>/<repo>`：把当前会话连接到一个 Project Target。
- `/unbind confirm`：解除当前会话和 Project Target 的连接；不会删除本机 checkout 配置、仓库绑定或 allowlist。
- `/status`：查看当前绑定的 Project Target、真实 active run、排队 follow-up 和下一步安全操作。
- `/doctor`：查看脱敏后的 readiness 摘要。聊天里不会打印 secret 或本机路径。
- `/stop [run_id]`：请求取消当前会话里的 active run，或取消指定 run。OpenTag 不会把 stop 请求当成成功完成。

群聊里必须先 @ 机器人，命令或任务才会生效。私聊可以更宽松，但仍然通过 Project Target 绑定工作，不接受本机绝对路径。群聊里的 `/bind` 和 `/unbind confirm` 还需要命令发送者命中绑定管理员 allowlist：`OPENTAG_LARK_BINDING_ADMIN_OPEN_IDS`、`OPENTAG_LARK_BINDING_ADMIN_USER_IDS` 或 `OPENTAG_LARK_BINDING_ADMIN_UNION_IDS`。

新 run 创建后，OpenTag 默认会尽量减少刷屏：先在源消息上加一个轻量的“正在输入”
reaction，表示已经开始处理。如果任务很快完成，就不创建中间状态卡，只发送最终
结果；如果任务超过 delayed-status 阈值，OpenTag 才会创建一张可更新状态卡，节流
普通 progress 更新，并在平台接受 card update 时把最终结果 patch 回同一张卡。普通
executor 细节默认留在 audit log 里，不刷进会话。要看 active 状态和 audit detail，
用聊天里的 `/status` 或本机的 `opentag status --run <run_id>`。如果平台拒绝 source
receipt，OpenTag 会 fallback 到简短 received 卡片，避免用户完全没有即时反馈。

## 测试

设置完成后，先确认 OpenTag 正在运行：

```bash
opentag service status
```

如果你选择的是前台终端模式，或者当前平台暂不支持后台 service，就改用 `opentag start`，并保持这个终端打开。

然后在 Lark/飞书里向个人代理应用发消息，或在群聊里 @ 它。OpenTag 应该会先添加轻量 received reaction，在本机运行你选择的编码代理，然后回到同一个会话里发送最终结果卡片。较长任务可能会在完成前显示一张可更新状态卡。
