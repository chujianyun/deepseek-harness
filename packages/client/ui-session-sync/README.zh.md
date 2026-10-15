---
description: "dsh 桌面端里来自其他电脑的对话：会话行上的标记和悬停说明，以及只读的输入区。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-sync

[English](README.md) | 中文

## 概述

标出[侧栏](../ui-workspace/README.zh.md)里哪些对话来自员工的其他电脑（由 [`sessionSync` Remote](../../session-query/session-sync/README.zh.md) 拉取）。这些会话行带一个电脑标记，悬停卡片里写明来自哪台电脑。打开这样的对话时，输入区换成只读说明。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把浏览器端条目挂在 Host 端 `session-sync` 条目旁边，使用相同的 `disabled` 条件；web-app bundle 在配置了用户中心的 `desktop` profile 上同时启用两者。在桌面窗口之外它什么也不添加，因为浏览器标签页没有自己的 Hub 登录。插件注入 `slots`、`locale`、`sessions` 和 `sessionSync` Remote，并在插件存续期间注册：

- `sidebar.session.row.badge` 里的 `session-sync-badge`（order 20）：拉取来的对话所在行上的小电脑标记，标签为 **来自其他电脑：{电脑名}**。
- `sidebar.session.row.hover` 里的 `session-sync-hover`（order 6）：行悬停卡片里的一行 **来自其他电脑 · {电脑名}**。
- `conversation.composer` 链上 priority -5 的条目：接管拉取来的对话的输入区，显示 **来自「{电脑名}」的对话**，并说明在这台电脑上只能查看，不能继续对话。

它订阅 `sessionSync` 的状态流。状态里的 `changes` 计数增加时，它会重新加载会话列表，因为同步写入和删除日志时不会产生列表事件；并从日志读取每个新拉取或有新版本的对话的投影（标题和智能体），因为 Host 的投影缓存可能还没有它们。窗口重新获得焦点或变为可见时，它调用 `refresh()`，让 Host 立即拉取其他电脑的变化。

-----

<a id="model-experience"></a>
## 模型体验

无，插件只是根据 Host 的同步服务标记会话行、替换输入区；这里的内容都不会进入模型请求。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **行菜单不变** —— 拉取来的对话的行菜单保留原有条目；Host 会拒绝重命名它，分叉则在本机生成一份普通副本。
- **暂无接着聊** —— 把拉取来的对话作为新对话继续是后续功能。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
