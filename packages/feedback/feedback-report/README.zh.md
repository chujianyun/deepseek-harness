---
description: "桌面端的问题反馈：问题类型、描述、图片、环境信息，可选附上会话内容，发送给用户中心的超管。"
kind: "package-reference"
---
# Feedback Report

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-feedback-report` 把问题反馈发送到当前 [Hub 登录](../../credentials/hub-account/README.zh.md)所在的用户中心，由超管在那里查看和处理。`feedbackReport` Remote 的 `submit(request)` 发送用户选择的问题类型、描述和图片，连同本 Host 看到的环境信息，并可附上反馈所针对会话的对话快照。用户选了类别或写了说明的点踩反馈也以同样方式上报。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包作为 Loader 条目与 Hub 登录一起挂载；它注入 `hubAccount` 和 `sessionQuery`，并用 `ctx.get` 读取 `assistants` 来得到会话所绑定智能体的名称。web-app bundle 在配置了用户中心的桌面端启用它。`appVersion` 是给超管看的桌面客户端版本（bundle 传入 `DSH_CLIENT_VERSION`），`requestTimeoutMs`（默认 120000）是每次反馈请求的时限。

`submit({ category, description, sessionId, attachSession, images, uiLanguage })` 接收问题类型（`error`、`lag`、`unavailable`、`wrong-result` 或 `other`）、去掉首尾空白后 1 到 2000 个字符的描述、反馈针对的会话（或 null）、是否附上会话内容、最多三张图片（PNG、JPEG、WebP 或 GIF，base64，每张最多 5 MB），以及界面语言。它返回已保存反馈的 `id` 和 `createdAt`。

### 反馈包含什么

- **环境信息**：`appVersion`、`os`（平台与版本）、`arch`、`locale`（界面语言）、`tenant`（登录租户名称），以及从会话日志读取的 `model`（最近一次选择的提供方、模型与推理强度；若之后还有请求，或会话一直用默认模型，则取最近一次请求所用的模型）和 `assistant`（所绑定智能体的名称，该租户仍有这个智能体时）。点踩上报另加 `ratedReply`，即被点踩回复的前 200 个字符。没有的值不出现；读不出日志的会话按不带这些信息上报。
- **会话**：`attachSession` 为真且会话有对话时，附上会话标题（取日志里最后一条 `session/title`）和与 [session-share](../../session-query/session-share/README.zh.md) 相同的快照：用户输入的消息和助手回复，工具调用只带名称和摘要。附件内容与子智能体日志不包含在内。附上会话时用户中心以 413 拒绝，就去掉会话再发一次，并在环境信息里写 `sessionOmitted: too-large`。

收到 [`feedback/message-recorded`](../message-feedback/README.zh.md)，且评分变成带类别或说明的差评时（新建的，或之前没有说明的），服务在后台上报一次；修改已说明的差评不会再次上报。上报内容：来源 `message`、反馈分类（没有时为 `other`）、作为描述的说明（没有时用占位文字），以及会话快照。单纯的评分和点赞不上报；上报失败只记日志，评分仍记录在会话里。

### 错误

没有 Hub 登录时为 `feedback-report/signed-out`。发送前发现超出限制时为 `feedback-report/invalid`，`reason` 为 `description`、`images`、`image-type` 或 `image-size`。用户中心的拒绝，或应答不是带 ISO 8601 时间的回执，为 `feedback-report/refused`，带它的 HTTP `status`，消息是它给出的原因。请求没有得到应答或超过时限，为 `feedback-report/unreachable`。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只读取会话日志、不向其中写入；这里没有任何内容进入模型请求。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有待发队列** —— 发送失败的反馈不会保留下来稍后重试，需要用户再次发送。
- **图片以 base64 传输** —— 图片以 base64 字符串经过 Remote，所以浏览器在发送前会缩小截图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
