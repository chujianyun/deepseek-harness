---
description: "自动化任务：一次调用创建任务——一个以任务命名、绑定智能体、模型、权限与连接器授权的会话，以及绑定到它的宿主调度。"
kind: "package-reference"
---
# Automation Tasks

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-automation-tasks` 按自动化任务表单的描述创建任务。`automationTasks` Remote 的 `create(request)` 在所选工作区新建会话，以任务名命名，绑定所请求的智能体、模型、权限预设、连接器授权和声明的操作，并保存[宿主调度](../schedule/README.zh.md)，在每次执行时把任务指令发送到这个会话。任何一步失败都会归档新建的会话。定时运行中没有人应答审批：需要确认的调用是声明的操作时直接执行，否则被拒绝，每次应答都记入日志。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包作为 Loader 条目与调度一起挂载；它注入 `sessionController`、`schedule`、`workspaceRegistry` 和 `sessionProjections`，仅在请求需要时用 `ctx.get` 读取 `assistants`、`connectors` 和 `permissionPresets`。web-app bundle 在配置了用户中心的桌面端启用它，那里运行着这些服务。

`create(request)` 接受任务的 `title`（同时作为会话名称）和 `prompt`、会话所归属的 `workspaceId`、可选的 `assistantId`、`model`（为会话安装且不改变默认模型）、`permission` 预设、`connectors` 列表和定时运行时可免确认执行的 `operations`、作为调度时间选择的 `timing`（`at`、`every`、`daily`、`weekly` 或 `cron`），以及 `window` 中可选的生效日期。它先检查不需要会话就能检查的内容：用同样的请求和生效区间调用调度的 `validate()`，并确认权限预设是目录提供的预设（不是 `custom`）。然后使用自己生成的会话 id，按以下顺序执行各步骤：在工作区中创建会话、重命名、恢复其 Agent、选择智能体、安装模型、设置权限预设、通过 `connectors.allowInSession()` 授权连接器、以 `automation-tasks/operations` 记录声明的操作、创建调度。它返回 `sessionId` 和已保存的调度 `record`。

在未挂载相应服务时请求智能体、连接器或权限预设以 `automation-tasks/unavailable`（`field`）拒绝，调度输入错误以带调度 `code` 的 `automation-tasks/invalid` 拒绝，未知的预设以代码为 `unknown_permission` 的 `automation-tasks/invalid` 拒绝，不合规的声明以代码为 `too_many`、`too_long` 或 `shell_character` 的 `automation-tasks/invalid` 拒绝，这些都发生在创建任何会话之前。开始创建后，任何失败（包括会话已存在后创建过程中的失败）都会通过带 `stopActivity` 的 `workspaceRegistry.archiveSession()` 归档生成的 id，然后拒绝：调度输入错误变为带调度 `code` 和消息的 `automation-tasks/invalid`，会话无法使用的模型变为 `automation-tasks/model-unavailable`，其他步骤的错误原样传出，例如 `assistants/not-found` 或 `connectors/not-found`。归档失败会记入日志，原始错误仍然传给调用方。

一条操作是一条命令开头的几个词，例如 `lark-cli im +messages-send` 或 `dsh-ecommerce browser`。`readOperations()`（也可从浏览器安全的 `@deepseek-ai/dsh-automation-tasks/operations` 导入）去掉每条的首尾空白、词间只留一个空格，并去掉空行和重复项；超过 50 条、单条超过 200 个字符、某个词包含 shell 有特殊含义的字符，或（`not_declarable`）程序名后没有具体命令、程序本身会执行别的命令（`RUNNERS`：各种 shell、`env`、`sudo`、`timeout`、`find`、`xargs`，以及 `node`、`python` 等解释器）时拒绝。`automationUnattended` 会话投影折叠最新的声明，并把第一条用户消息由调度发出的轮次标记为定时运行，直到有人在其中发消息或 `turn/end`；有人发起的轮次照常询问，即使其中混入了调度消息。

在定时运行的轮次中，最外层的 `tools/pre-execute` 监听器（以 `prepend` 注册）看到其他所有关口得出的决定。`allow` 或 `deny` 保持不变；`ask` 在调用是 bash 或 PowerShell 命令、且其中每条简单命令都以某条操作的程序名（不带路径）开头并紧跟该操作的其余词、且这些词都不由变量构成时变为 `allow`，否则变为 `deny`，拒绝说明中列出声明的操作；其后的词不限。`readCommand()` 拆分命令时只认单引号、双引号、bash 的反斜杠转义、空白、`;`、`|`、`&&`、`||` 和输出重定向；注释、`$'…'` 引号、命令或进程替换、反引号、输入重定向或 here-document、单独的 `&`、括号或花括号、`!`、换行或未闭合的引号会使命令无法读懂，这样的命令永远不匹配，程序名写成路径或前面带变量赋值的也不匹配。在这类轮次中于工具关口之外发起的审批（例如在沙箱外运行命令），先由以 `prepend` 注册的 `approval/request` 监听器按同一规则应答，此时还拒绝重定向，找不到命令的调用应答 `rejected`。这类轮次里应答者不再往下传递：没有人能应答，所以由它自行应答。每次应答都追加 `automation-tasks/unattended`（`callId`、`turn`、截断到 500 个字符的 `command`、`allowed` 和匹配到的 `operations`）。审批策略为 `never` 时审批服务在任何应答者之前就拒绝，因此那里只有工具关口的应答生效。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由会话和工具关口：创建的会话是普通会话，其智能体、模型和权限预设与其他会话一样影响其对话轮次，由[调度](../schedule/README.zh.md#model-experience)发送指令。在定时运行中，因不是声明的操作而被拒绝的调用以工具拒绝的形式到达模型，其中列出声明的操作：`This run of the automation task is unattended: nobody can approve this call, and it is not one of the operations the task may run without asking (it declares: …), so it was not run. Run each declared operation as a command of its own, or report that this step needs a person.` 应答本身只写入日志。

#### KV Cache 影响

无影响：拒绝说明是追加在缓存前缀之后的普通工具结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只负责创建** — 之后修改任务会话的设置在该会话中进行；自动化任务详情页修改名称、指令和时间。
- **回滚即归档** — 被拒绝的任务的会话会被归档而不是删除，因此仍留在已归档会话中；连归档也失败时只记录日志，该会话连同已应用的权限或连接器授权保持可用。
- **只匹配 shell 命令** — 声明的操作只匹配 bash 或 PowerShell 命令；其他工具在定时运行中需要确认的调用会被拒绝，脚本自己启动的子进程也看不到。
- **会话名称可能更短** — 会话标题服务按字节限制名称长度，因此较长的任务名在会话列表中可能显示为缩短后的名称，任务本身保留完整名称。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
