---
description: "dsh Web 客户端里 Desktop 的 Skill Hub 账号：侧栏账号入口（员工），新会话页的租户 Logo 与标语，以及设置分区——已登录员工及切换租户、退出登录，或未登录时的登录状态和登录入口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hub-account

[English](README.md) | 中文

## 概述

注册侧栏账号入口（`settings.launcher`）：显示员工姓名首字和昵称（公司在设置分区中显示），菜单提供 **设置** 和 **退出登录**。在新会话页显示当前租户的 Logo 和标语。在设置里新增 **Skill Hub 账号** 分区，显示已登录的昵称、租户和手机号，并提供 **切换租户** 和 **退出登录**；未登录时显示登录状态和 **登录 Skill Hub**。它通过 [`hubAccount` Remote](../../credentials/hub-account/README.zh.md) 读取状态和执行操作。Desktop [欢迎窗口](../../../apps/desktop/README.zh.md)在未登录时不打开工作区，所以渲染器没有自己的登录门禁。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把浏览器行挂在 Host 的 `hub-account` 行旁边，`disabled` 条件与它相同；web-app bundle 只在 `desktop` profile 且配置了用户中心时启用这两行。插件只在 Desktop 渲染器（存在 `dshDesktop`）中生效，同一套插件的浏览器标签页不显示该分区。它注入 `remote.hubAccount`，把账号入口注册到 `settings.launcher`，把账号分区以 id `hub-account`、顺序 -20 注册到 `settings.section`。账号入口替代 DeepSeek 账号菜单，因此 Desktop 组合不挂载 `ui-settings-account`：`settings.launcher` 只容纳一个注册，同时挂载两个插件会使后挂载的那个加载失败；[升级指南](../../../docs/upgrade-guide/v0.2.0-rc.2/desktop-user-center-sign-in/guide.zh.md)要求部署不要重新启用它。侧栏品牌行属于 [ui-brand-mo](../ui-brand-mo/README.zh.md)，它在那里替代 `ui-brand-official`；web-app bundle 在相同条件下停用 `ui-brand-official`。新会话页的占位者（`conversation.hero.brand.mark`、`conversation.hero.brand.headline`）替代输入框上方的鲸鱼和标题：租户 Logo 按标志位 34px 的高度显示，深色主题下垫一块浅色底板；标语原样显示，不随界面语言变化。哪一项没设置就不显示哪一项，两项都没设置时这一行留空；「预览版」标签不再显示。每当状态帧的 `branding` 标记变化，新会话页通过 `hubAccount.getBranding()` 重新读取品牌。

收到第一份状态之前，分区显示正在检查。未登录时显示 **未登录 Skill Hub** 并提供 **登录 Skill Hub**；从本窗口发起的登录或切换租户在 Host 发布授权页后立即在系统浏览器中打开，其他地方发起的尝试只显示不打开。等待时提供 **重新打开登录页** 和 **取消**。失败的尝试显示原因和 **重新登录**；登录失效时说明正在运行的会话会继续，但新消息要等重新登录。已登录但没有租户的账号，租户显示为 **不属于任何公司**。

-----

<a id="model-experience"></a>
## 模型体验

无，因为账号分区只渲染登录状态，是否接受一条消息由 Host 决定。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 无。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。视图只渲染 Host 的状态流，不保存独立的登录状态。
