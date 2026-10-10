---
description: "dsh 桌面端的添加自动化任务表单：在自动化任务页点「新建」就地打开，保存时一并创建任务的会话和调度。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-automation-tasks

[English](README.md) | 中文

## 概述

占用[自动化任务页](../ui-schedule/README.zh.md)的 `schedule.task.form` 插槽，使**新建**在列表位置打开**自动化 / 添加自动化任务**表单，而不是新开会话。表单填写任务的名称、工作区、提示词及其智能体、模型和权限、连接器、执行频率和生效日期；**保存**通过 [`automationTasks` Remote](../../schedule/automation-tasks/README.zh.md) 创建任务，一并生成任务的会话和调度。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将浏览器行与宿主 `automation-tasks` 行一起挂载，使用相同的 `disabled` 条件；web-app bundle 在配置了用户中心的 `desktop` profile 中同时启用两者。插件注入 `slots`、`locale`、`workspaces`，以及 `automationTasks`、`assistants`、`session`、`permissionPresets` 和 `connectors` Remote，并在插件存续期间把表单注册到 `schedule.task.form`。

表单打开时一次性读取租户的智能体、模型目录、权限预设（不含 `custom`）和当前登录租户已连接的连接器；读取失败的一项不提供选项。字段依次为：可关闭的提示，说明只有电脑和 MO WorkAI 保持开启时任务才会执行；**名称**（必填，最多 120 个字）；**工作区**，即会话所在的工作区，默认为侧栏顺序中的第一个；**提示词**（必填），下方一行选择智能体（默认**通用模式**）、模型（默认**默认模型**）和权限预设（部署的默认值）；**连接器**，每个已连接的连接器一个复选框，勾选即授权该连接器在任务会话中使用；**执行频率**，可选**周期**（每天、工作日或所选星期几的某个时间）、**按间隔**（每若干整数分钟或小时）或**单次**（某个日期和时间）；以及**生效日期区间**，可选的开始和结束日期。时间和日期按浏览器时区解读。

**取消**和**保存**位于页面底部的操作栏。保存时先检查字段，并在各字段下方显示问题；宿主拒绝保存时，在对应字段下方显示原因，已填写的内容全部保留。保存期间两个按钮都不可用。创建成功后回到列表，目录列出该任务后即选中它；取消则直接回到列表。

-----

<a id="model-experience"></a>
## 模型体验

无，因为表单只收集由宿主编排创建的任务；创建的会话与其他会话一样运行。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只负责创建** — 已有任务的智能体、模型、权限、连接器和生效日期不在这里修改；任务详情修改名称、指令和时间。
- **使用原生日期和时间控件** — 频率和日期字段使用浏览器自带的输入框，而不是任务详情中的选择器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
