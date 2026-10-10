---
description: "自动化任务：一次调用创建任务——一个以任务命名、绑定智能体、模型、权限与连接器授权的会话，以及绑定到它的宿主调度。"
kind: "package-reference"
---
# Automation Tasks

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-automation-tasks` 按自动化任务表单的描述创建任务。`automationTasks` Remote 的 `create(request)` 在所选工作区新建会话，以任务名命名，绑定所请求的智能体、模型、权限预设和连接器授权，并保存[宿主调度](../schedule/README.zh.md)，在每次执行时把任务指令发送到这个会话。任何一步失败都会归档新建的会话，因此被拒绝的任务不留下任何东西。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包作为 Loader 条目与调度一起挂载；它注入 `sessionController`、`schedule` 和 `workspaceRegistry`，仅在请求需要时用 `ctx.get` 读取 `assistants`、`connectors` 和 `permissionPresets`。web-app bundle 在配置了用户中心的桌面端启用它，那里运行着这些服务。

`create(request)` 接受任务的 `title`（同时作为会话名称）和 `prompt`、可选的 `workspaceId`（省略时为默认工作区）、可选的 `assistantId`、`model`（为会话安装且不改变默认模型）、`permission` 预设和 `connectors` 列表、作为调度时间选择的 `timing`（`at`、`every`、`daily`、`weekly` 或 `cron`），以及 `window` 中可选的生效日期。各步骤按以下顺序执行：创建会话、重命名、恢复其 Agent、选择智能体、安装模型、设置权限预设、通过 `connectors.allowInSession()` 授权连接器、创建调度。它返回 `sessionId` 和已保存的调度 `record`。

在未挂载相应服务时请求智能体、连接器或权限预设，会在创建任何会话之前以 `automation-tasks/unavailable`（`field`）拒绝。会话创建后，任何失败都会通过带 `stopActivity` 的 `workspaceRegistry.archiveSession()` 归档它，然后拒绝：调度输入错误变为带调度 `code` 和消息的 `automation-tasks/invalid`，会话无法使用的模型变为 `automation-tasks/model-unavailable`，其他步骤的错误原样传出，例如 `assistants/not-found` 或 `connectors/not-found`。归档失败会记入日志，原始错误仍然传给调用方。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包自身不向模型请求加入任何内容；创建的会话是普通会话，其智能体、模型和权限预设与其他会话一样影响其对话轮次，由[调度](../schedule/README.zh.md#model-experience)发送指令。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只负责创建** — 之后修改任务会话的设置在该会话中进行；自动化任务详情页修改名称、指令和时间。
- **回滚即归档** — 被拒绝的任务的会话会被归档而不是删除，因此仍留在已归档会话中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
