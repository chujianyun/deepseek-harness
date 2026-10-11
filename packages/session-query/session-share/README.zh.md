---
description: "会话分享：把一个会话的对话快照上传到 Hub 登录所在的用户中心，读取它的链接，以及取消分享。"
kind: "package-reference"
---
# Session Share

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-session-share` 把一个会话分享给用户所在的公司。`sessionShare` Remote 的 `share(request)` 把对话快照上传到当前 [Hub 登录](../../credentials/hub-account/README.zh.md)所在的用户中心，由用户中心通过链接提供给同公司已登录的成员查看。用户中心为每个会话、每位员工保留一条分享，因此再次分享会替换快照并保持链接不变。`revoke` 取消分享，删除本机分享过的会话也会取消分享。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包作为 Loader 条目与 Hub 登录一起挂载；它注入 `hubAccount` 和 `sessionQuery`，并用 `ctx.get` 读取 `assistants` 来得到会话所绑定智能体的名称。web-app bundle 在配置了用户中心的桌面端启用它。`requestTimeoutMs`（默认 60000）是每次用户中心请求的时限，`dshHome`（默认 `$DSH_HOME` 或 `~/.dsh`）存放分享记录。

`status({ sessionId })` 返回 `{ signedIn, link }`：`link` 是该会话的分享（`shareId`、`url`、`createdAt`、`updatedAt`），未分享时为 null；未登录时不发请求，直接返回 `{ signedIn: false, link: null }`。`share({ sessionId, title })` 读取会话日志、生成快照，连同标题和所绑定智能体的名称一起上传（未绑定，或该租户已没有这个智能体时为 null），并返回链接。`revoke({ sessionId })` 取消分享，未分享的会话保持原样。

服务在 `<dshHome>/session-shares.json` 记录它分享过的会话，每条带登录所在的租户和分享 id：`share` 成功或 `status` 查到分享时记下，`revoke` 或 `status` 查不到分享时在同一租户下删掉记录。收到 `session/deleted` 时，只有记录过的会话才在后台取消分享，所以删除从未分享的会话不发任何请求。登录的是同一租户时取消该分享；否则记录日志，分享留在用户中心。无论哪种情况都删掉记录，取消失败会记录日志。记录文件损坏时按空处理，下次写入时替换。

### 快照包含什么

快照是一组消息，每条带 `role`、`text` 和时间 `at`：

- **用户消息**：用户输入的文字。每个文件或图片占一行，只写名称（`[附件：name]`），内容不上传。来自调度、子智能体或其他来源的用户角色消息不包含在内。
- **助手回复**：每次回复一条消息，不是用户输入的用户角色消息不会把它拆开；按顺序包含各步骤的文字，以及 `tools`：每次工具调用的名称和一行标量参数摘要，最长 120 个字符。推理过程、工具结果和嵌套的参数值不包含在内。

会话分享的是它自己的日志，分叉出来的会话包含它继承的轮次。子智能体会话是独立的日志，不在快照里。

### 错误

没有 Hub 登录时，`share` 和 `revoke` 以 `session-share/signed-out` 拒绝。日志里没有可分享的消息时，`share` 以 `session-share/empty` 拒绝。用户中心的拒绝，或应答不是带 ISO 8601 时间的分享链接，是 `session-share/refused`，带它的 HTTP `status`，消息是它给出的原因；状态 413 表示对话超过了用户中心的大小上限。请求没有得到应答或超过时限，是 `session-share/unreachable`。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只读取会话日志、不向其中写入；这里没有任何内容进入模型请求。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **是快照，不是实时** —— 链接显示的是最近一次 `share` 时的对话；之后的轮次要再次分享才会出现。
- **过长的对话会被拒绝** —— 用户中心限制一条分享的大小和消息条数，超过即拒绝；快照不会为此被截短。
- **删除时取消分享需要同一登录和网络** —— 在未登录、登录了其他租户或离线时删除的会话，它的分享会留在用户中心，直到分享人或公司管理员在分享页取消。记录只写租户、不写员工，所以本机登录的同租户其他员工也取消不了。
- **附件标注是中文** —— 无论界面语言是什么，标注附件的那一行都用中文写。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
