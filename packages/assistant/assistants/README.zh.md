---
description: "Desktop 智能体：带有自己核心文件的具名角色，按 Hub 登录的租户保存并绑定到会话，以及 assistants Remote。"
kind: "package-reference"
---
# 智能体

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-assistants` 以 Host 服务 `ctx.assistants` 和 `assistants` Remote 命名空间拥有[智能体](../../../docs/glossary.zh.md#assistant)。智能体是一个具名角色，它的四份[核心文件](../../../docs/glossary.zh.md#assistant-core-files)——身份、人格、用户信息和工作方法——会进入每个绑定到它的会话交给模型。本包保存每个租户的智能体，从[模板](../../../docs/glossary.zh.md#assistant-template)或空白创建智能体，编辑、复制和删除智能体，把会话连同其模型和 Agent preset 绑定到智能体，并为模型记录所绑定智能体的核心文件。智能体为何叠在 Agent preset 之上，记录在[智能体 Agent Note](../../../.agents/notes/proposed/feature/2026-10-07-assistants-over-agent-presets.zh.md)中。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop profile 中把本包作为 Loader 条目挂在 `hub-account` 旁边，它注入 `hub-account`、`sessionProjections` 和 `agents`；profile 组合了 `agentPresets` 和 `sessionController` 时也会使用它们。web-app bundle 在 `desktop` profile 且配置了用户中心时启用它，由 `ui-assistants` 渲染它的页面和新会话选择器。

智能体属于当前 [Hub 登录](../../../docs/glossary.zh.md#skill-hub)所在的租户，保存在 `<dshHome>/assistants/<tenantId>/<assistantId>/`：`assistant.json`（`version`、`id`、`name`、`description`、`avatar`——预设键或上传图片的 data URL——可选的 `preset`、`model` 和 `templateId`，`createdAt`）和核心文件 `IDENTITY.md`、`SOUL.md`、`USER.md`、`AGENTS.md`。租户的 `tenant.json` 记录它的默认智能体，以及它的第一个智能体已经创建过。某个租户第一次登录时，服务用日常助手模板创建一个智能体并设为默认；此后不再为该租户创建，即使用户删除了全部智能体。智能体先写进一个隐藏的暂存目录，再重命名到位，所以中断的创建不会留下智能体。没有 `assistant.json` 的目录被跳过，格式不对的会被跳过并记录警告。`getState()` 和 `watch()` 按创建顺序返回已登录租户的智能体、默认智能体的 id 和内置模板；未登录时状态里没有租户，也没有智能体。

`createAssistant(input)` 为已登录租户创建智能体：`templateId` 为 `daily` 或 `ecommerce` 时从该模板创建，为 `null` 时从空白创建，返回新智能体的 id 和新状态。名称去掉首尾空白后须为 1 到 `maxNameLength` 个字符（`assistants/invalid-name`），描述最多 `maxDescriptionLength` 个字符（`assistants/invalid-description`）；上传的头像须是不超过 `maxAvatarLength` 的 PNG、JPEG 或 WebP data URL（`assistants/invalid-avatar`），`preset` 须是部署组合了的（`assistants/preset-unavailable`）。核心文件来自模板，空白时只有标题；名称替换 `IDENTITY.md` 中的 `**名称**` 行，`USER.md` 按 `user`——如何称呼用户、偏好语言、备注和背景——写入，因此会进入提示词。电商管家模板面向天猫、拼多多、抖店，覆盖运营和客服，任何会影响平台的改动都先确认。

`getAssistant(assistantId)` 返回一个智能体及其四份核心文件的文本；磁盘上缺失的文件读作空文本。`updateAssistant(assistantId, input)` 可修改 `name`、`description`、`avatar`、`model`、`preset` 和 `files` 中的任意几项，`files` 是核心文件名到新文本的映射；`model: null` 和 `preset: null` 让智能体回到全局模型和部署的默认 preset，四个核心文件名以外的键会被忽略。它按 `createAssistant` 的规则校验，核心文件超过 `maxCoreFileLength` 时以 `assistants/invalid-file` 拒绝。改名时也会把新名称写进 `IDENTITY.md` 的 `**名称**` 行。核心文件和名称会在下一步到达所有绑定该智能体的会话，进行中的会话也一样；修改模型或 preset 对之后绑定的会话生效，已经绑定它的空白主会话会立即装上。`setDefault(assistantId)` 把一个智能体设为新会话绑定的默认智能体，并把绑定旧默认智能体的空白主会话改绑到它。`duplicateAssistant(assistantId)` 把配置和核心文件复制成一个名为 `<名称> 副本` 的新智能体，名称超出 `maxNameLength` 时截短，不复制会话。`deleteAssistant(assistantId)` 先删除 `assistant.json` 再删除目录，所以中断的删除不会留下智能体。绑定已删除智能体的会话会保留并可以继续，从下一步起不再带它的核心文件；空白主会话改绑到默认智能体。删除默认智能体时，剩下的第一个智能体成为默认；全部删光后，新会话不绑定智能体，行为与没有智能体时一样。未登录时都以 `hub-account/signed-out` 拒绝，未知 id 以 `assistants/not-found` 拒绝。

主会话在空白时绑定一个智能体，记录为 `assistant/selected`（`assistantId`）。服务看到一个尚未绑定智能体的空白主会话时，会绑定租户的默认智能体。`select(sessionId, assistantId)` 在第一轮之前改绑另一个：带 `preset` 的智能体会先通过 `agentPresets.select()` 把会话切换到那个 Agent preset，带 `model` 的智能体会通过 `sessionController.useModel()` 为会话安装该模型，且从不改变全局默认。新会话绑定默认智能体时也是如此。部署已不再组合的 preset，或已从设置中删除的模型会被跳过，会话保留部署的默认 preset 或全局模型。在同一个空白会话里，先选了设置过 preset 或模型的智能体、再改选没有设置的智能体时，会话回到部署的默认 preset 或全局模型；其他情况下绑定不改动会话自己的选择。未登录时以 `hub-account/signed-out` 拒绝，租户没有该 id 时以 `assistants/not-found` 拒绝，会话已经开始过一轮时以 `assistants/locked` 拒绝。子智能体会话不绑定智能体。`assistant` 会话投影把绑定的 id 带到客户端的会话摘要中。

每个主会话都有 `assistant:core-files` 提示词段落，顺序为 `ASSISTANT_CORE_FILES`，位于部署人设之后。每个轮次步骤开始前，会话作用域里的组装监听器读取所绑定智能体的核心文件并渲染；文本与上一次记录不同时追加 `assistant/instructions`（`text`）。段落携带记录下来的文本，所以在磁盘上修改的内容会在下一步到达模型，每个提示词都能从会话日志还原。在磁盘上删除的核心文件不贡献内容；无法读取的核心文件会让这一步失败。已删除的智能体、不属于已登录租户的智能体，以及核心文件全为空的智能体，都渲染为空文本。由于每一轮的系统提示词都会留在对话中，已经带过核心文件的会话此时改为得到 `CORE_FILES_WITHDRAWN` 文本，告诉模型之前的核心文件不再适用；从未带过核心文件的会话没有这个段落。轮次之外的组装（例如查看提示词）不做记录，使用上一次记录的文本。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Harness 主目录；智能体保存在 `<dshHome>/assistants` 下。 |
| `maxNameLength` | `32` | 智能体名称的最大字符数。 |
| `maxDescriptionLength` | `200` | 智能体描述的最大字符数。 |
| `maxAvatarLength` | `700000` | 上传头像的最大大小，按 data URL 的长度计。 |
| `maxCoreFileLength` | `20000` | `updateAssistant` 保存的单个核心文件的最大字符数；每一轮都会携带核心文件。 |

-----

<a id="model-experience"></a>
## 模型体验

### 所绑定智能体的核心文件

#### 模型看到的内容

绑定了智能体、且其核心文件不全为空的主会话，会在部署人设之后得到 `assistant:core-files` 段落：先是下面带智能体名称的开场说明，再按 `IDENTITY.md`、`SOUL.md`、`USER.md`、`AGENTS.md` 的顺序，把每份非空核心文件去掉首尾空白后放进一个 `<core_file name="…">` 块。文本按原样发送；核心文件里的 `{{…}}` 不做插值。未绑定的会话和子智能体会话没有这个段落。所绑定的智能体被删除、不再属于已登录租户，或核心文件全被清空后，已经带过核心文件的会话改为得到下面的失效说明；从未带过的会话没有这个段落。

##### 段落开场说明

```markdown
You are the assistant "<name>". The user wrote the core files below to define your identity, personality, what you know about them, and how you work. They replace any earlier version in this conversation; follow them.
```

##### 失效说明

```markdown
The core files given earlier in this conversation no longer apply: the assistant they defined is no longer available or no longer has them. Stop following their identity, personality, user information, and working method, including any required openings, signatures, or formats, and work as a general assistant.
```

#### Token 影响

有条件且持续存在：绑定会话的每次请求都携带开场说明和核心文件的全文，大小约等于四个文件之和。通过 `updateAssistant` 保存时，每个文件最多 `maxCoreFileLength` 个字符；在磁盘上直接修改的文件没有上限。

#### KV Cache 影响

核心文件不变时前缀保持稳定。修改核心文件、给智能体改名、在第一轮之前改绑另一个智能体，或删除该智能体，会在下一步替换该段落，并使从该段落起的缓存前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **会话中途人设变化** —— 会话进行中修改核心文件，会从下一步起改变模型的表现。
- **还没有能力子集** —— 智能体使用会话原本拥有的全部 Skill、连接器和知识库。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
