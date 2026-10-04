---
description: "dsh Web 客户端里 Desktop 的 Hub 登录门禁：未登录时的全屏登录页，以及设置中可切换租户、退出登录的账号分区。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hub-account

[English](README.md) | 中文

## 概述

Host 报告没有 Hub 登录时，门禁用一个全屏登录页盖住整个应用；设置里新增 **Skill Hub 账号** 分区，显示已登录的昵称、租户和手机号，并提供 **切换租户** 和 **退出登录**。它通过 [`hubAccount` Remote](../../credentials/hub-account/README.zh.md) 读取状态和执行操作。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把浏览器行挂在 Host 的 `hub-account` 行旁边，`disabled` 条件与它相同；web-app bundle 只在 `desktop` profile 且配置了用户中心时启用这两行。插件只在 Desktop 渲染器（存在 `dshDesktop`）中生效，同一套插件的浏览器标签页不会被门禁拦住。它注入 `remote.hubAccount`，把门禁以 id `hub-gate` 注册到 `shell.overlay`，把账号分区以 id `hub-account`、顺序 -20 注册到 `settings.section`。

收到第一份状态之前，门禁显示正在检查。未登录时提供 **用用户中心登录**；从本窗口发起的登录在 Host 发布授权页后立即在系统浏览器中打开，其他地方发起的尝试只显示不打开。等待时提供 **重新打开登录页** 和 **取消**。失败的尝试显示原因和 **重新登录**；登录失效时说明正在运行的会话会继续，但新消息要等重新登录。门禁 portal 到 document body，层级高于 Desktop 引导页，因此下面的任何内容都无法使用。切换租户会先退出，所以在新的登录完成之前门禁会重新出现。

-----

<a id="model-experience"></a>
## 模型体验

无，因为门禁和账号分区只渲染登录状态，是否接受一条消息由 Host 决定。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **被盖住的应用仍可用键盘聚焦**——门禁是盖在应用之上的模态对话框，但不把应用设为 inert，因为 inert 状态在 Desktop 引导页存活期间归引导页所有。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。视图只渲染 Host 的状态流，不保存独立的登录状态。
