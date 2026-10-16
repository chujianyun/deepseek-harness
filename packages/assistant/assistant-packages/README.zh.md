---
description: "智能体包：安装企业管理员在用户中心发布的智能体及其引用的技能，并启用或停用它推荐的定时任务。"
kind: "package-reference"
---
# Assistant Packages

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-assistant-packages` 在桌面端安装企业智能体包。企业管理员在用户中心发布智能体包：`agent.json`（名称、版本、头像、Agent preset、技能与连接器子集、推荐定时任务）和四份核心文件。`assistantPackages` Remote 列出已登录员工所在企业提供的智能体包，通过[智能体](../assistants/README.zh.md)服务把其中一个安装为智能体，并从企业 Skill Hub 安装包中引用的技能；把智能体更新到新版本而不覆盖用户的修改；把每条推荐任务启用为[自动化任务](../../schedule/automation-tasks/README.zh.md)或再停用。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包作为 Loader 条目与智能体一起挂载；它注入 `hubAccount` 和 `assistants`，在操作需要时用 `ctx.get` 读取 `skillMarket`、`automationTasks` 和 `schedule`。web-app bundle 在配置了用户中心的桌面端启用它。配置项：`dshHome`、`maxPackageBytes`（最大下载大小，默认 2 MiB）和 `defaultAvatar`（包未指定头像时使用的头像 key，默认 `sun`）。

`getState()` 返回已登录的租户、用户中心为它列出的智能体包（`GET /api/client/agent-packages`，使用 Skill Hub 的 `skills:read` 范围读取；读取失败时为 null 且 `unavailable: true`），以及本机从智能体包安装的智能体，每个都带推荐任务及其是否在运行。`installPackage(packageId)` 下载当前版本，大小或 sha256 与列表不一致、或压缩包中除 `agent.json` 和四份核心文件外还有其他内容时拒绝（`assistant-packages/invalid`）；安装包中引用、既未安装也不是用户放在本机的同名技能（Skill Hub 不提供、新会话也找不到的记为缺失；DSH 自带的 office 技能这类新会话已能找到）；用包的名称、描述、头像、preset 和子集创建智能体，写入核心文件，并把安装记录写到 `<dshHome>/assistant-packages/<tenantId>/installs.json`。智能体创建之后的失败会删除它。安装本机已安装的智能体包会改为更新那个智能体。

`updatePackage(assistantId)` 把安装更新到智能体包的当前版本。核心文件或资料字段（名称、描述、头像、preset、子集）的当前值仍等于智能体包上次写入的值时取新版本的值；用户改过的保留，并返回保留的文件。`enableTask(assistantId, taskId, workspaceId)` 把任务创建为绑定该智能体的自动化任务，带其时区下的运行时间、权限预设以及为无人值守运行声明的 `operations`；`disableTask(assistantId, taskId)` 删除该调度并保留其会话。调度在别处被删除的任务读作已停用；新版本不再推荐的已启用任务，以及用户删除的智能体的所有任务，都会被停用，不会留下没有关闭入口的调度。包中引用的技能不在 Skill Hub 上且新会话也找不到，或安装失败时，记为缺失，其余技能照常安装；没有 Skill 市场的部署把新会话找不到的引用技能全部记为缺失。本版本读不懂的列表项会被略过并记录警告。拒绝：`hub-account/signed-out`、`assistant-packages/not-found`、`assistant-packages/unavailable`（用户中心或自动化任务）、`assistant-packages/not-installed`、`assistant-packages/task-not-found`，以及原样传出的智能体与自动化任务拒绝。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由智能体服务和自动化任务：安装的智能体包写入智能体的核心文件和子集，它们[像智能体的设定一样到达模型](../assistants/README.zh.md#model-experience)；启用的任务是普通的自动化任务，由其[调度](../../schedule/schedule/README.zh.md#model-experience)发送指令。

#### KV Cache 影响

无直接影响；更新改变核心文件时，从下一轮起改变智能体的提示段，与编辑核心文件相同。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **运行中的任务保留原定义** — 更新改变了已启用的任务后，该任务保留之前的运行时间和指令并显示为已过期，直到用户停用后重新启用。
- **安装按机器记录** — 安装记录保存在本机；同一员工的另一台机器需要重新安装。
- **不卸载技能** — 删除智能体不会删除它安装的技能。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
