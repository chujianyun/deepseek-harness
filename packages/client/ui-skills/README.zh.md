---
description: "dsh Web 客户端的 Desktop Skills 页面：以卡片展示本机已安装的 skill，可启用、停用、去对话、编辑、打开文件夹或卸载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skills

[English](README.md) | 中文

## 概述

Skills 页面在侧栏加入 **Skills** 入口，并在主栏打开本机已安装的 skill。自定义 skill 以卡片展示：名称首字母、名称、两行描述、启用开关，以及操作菜单——去对话、编辑、打开文件夹，以及确认后卸载。它通过 [`installedSkills` Remote](../../skill/skill-controller/README.zh.md) 读取和操作。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把浏览器条目与 Host 的 `skill-controller` 条目一起挂载；web-app bundle 只在 `desktop` profile 下启用两者。页面注入 `remote.installedSkills`、`uiWorkspace`、`sessions` 与 `conversation`，以面板 id `skills` 注册到 root 的 `main` keyed slot，并以 order 5 把图标加入 `sidebar.panellist`。

页面每次挂载时读取列表，每次「加载更多」展示十二张卡片。开关会立即切换，Host 拒绝时回到原位；某个 skill 的操作进行中时，它的开关与菜单保持禁用。被拒绝的操作会在分组上方显示其消息，直到下一次操作或被关闭。卡片只在 Host 确认移到废纸篓后才消失。「去对话」在侧栏「新建会话」会使用的 Workspace 中新建会话，并把 `/<name> ` 写入草稿而不发送；一个 Workspace 都没有时，会打开不带草稿的空白新建会话页面。停用的 skill 不能去对话。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 skill 注册表：在这里停用 skill 会把它从模型的 skill 目录中移除；「去对话」只准备一份仍需用户发送的草稿。

#### KV Cache 影响

无直接影响；目录变化经由 skill 目录消费方的替换消息到达模型。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有自定义 skill**——页面只列出本机的用户级 skill；Skill Hub 市场网格、从市场安装的 skill 与上传将在后续工单中实现（#29、#30、#31）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。页面不保存任何可能与其他观测相矛盾的状态；Host 目录是唯一来源。
