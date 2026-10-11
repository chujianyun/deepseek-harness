---
description: "dsh 桌面端的分享会话操作：会话行菜单项，以及生成、复制、更新和取消会话分享链接的对话框。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-share

[English](README.md) | 中文

## 概述

在[侧栏](../ui-workspace/README.zh.md)会话行的菜单里添加**分享会话**，以及它打开的对话框。对话框通过 [`sessionShare` Remote](../../session-query/session-share/README.zh.md) 读取会话的分享，生成同公司已登录成员可以打开的链接，复制链接，更新分享的内容，以及取消分享。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将浏览器行与 Host 的 `session-share` 行一起挂载，使用相同的 `disabled` 条件；web-app bundle 在配置了用户中心的 `desktop` profile 下同时启用两者。插件注入 `slots`、`locale`，以及 `hubAccount` 和 `sessionShare` Remote。在插件生命周期内，它在 `sidebar.workspaces.session.menu.item` 注册 `share` 条目（order 350，位于分叉与归档之间），并在 `shell.overlay` 注册 `session-share` 条目。

菜单行只在 `hubAccount` 状态流报告已登录时显示。选择它会关闭菜单，并为该会话打开对话框，以侧栏显示的标题称呼它（未命名的会话为**未命名**）；这个标题也是分享携带的标题。

对话框说明谁可以打开链接，以及分享的是当前的对话、不含附件文件。它先读取会话的分享：

- **未分享** —— **生成链接**上传快照并显示链接。
- **已分享** —— 链接显示在只读输入框里，聚焦时自动全选，旁边有**复制链接**和内容上次更新的时间。**更新内容**在同一个链接下上传当前的对话，**取消分享**撤回分享并回到未分享状态，**完成**关闭对话框。

调用进行中时按钮禁用，状态行说明正在做什么，对话框不能关闭。被拒绝时，在链接下方以界面语言显示原因：未登录、会话没有对话、对话超过用户中心的大小上限、其他拒绝时用户中心给出的原因，或连接不上服务器。对话框随后保持原状态，用户可以重试。

-----

<a id="model-experience"></a>
## 模型体验

无，因为对话框只调用 Host 的分享服务；这里没有任何内容进入模型请求。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只在菜单里** —— 操作位于行菜单；会话行没有分享悬停按钮，搜索结果行没有菜单。
- **没有已分享标记** —— 侧栏不标记已分享的会话；分享状态在对话框里显示。
- **空白会话在对话框里被拒绝** —— 没有对话的会话也显示该行，此时**生成链接**会说明它不能分享。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
