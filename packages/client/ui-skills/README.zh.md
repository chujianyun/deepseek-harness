---
description: "dsh Web 客户端的 Desktop Skills 页面：以卡片展示本机已安装的 skill，可启用、停用、去对话、编辑、打开文件夹或卸载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skills

[English](README.md) | 中文

## 概述

Skills 页面在侧栏加入 **Skills** 入口，并在主栏打开 Skill Hub 市场：带搜索、分类 Tab 和加载更多的卡片，展示渲染后的 SKILL.md 与文件清单的详情对话框，以及通过 [`skillMarket` Remote](../../skill/skill-market/README.zh.md) 一键安装。**我安装的（N）** 打开本机已安装的 skill，分为用户自定义和来自市场两组。已安装的 skill 以卡片展示：名称首字母、名称（来自市场的 Skill 显示 Hub 上的显示名称，旁边是 slug）、两行描述、启用开关，以及操作菜单——去对话、编辑、打开文件夹，以及确认后卸载。它通过 [`installedSkills` Remote](../../skill/skill-controller/README.zh.md) 读取和操作。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把浏览器条目与 Host 的 `skill-controller` 条目一起挂载；web-app bundle 只在 `desktop` profile 下启用两者。页面注入 `remote.installedSkills`、`remote.skillMarket`、`uiWorkspace`、`sessions` 与 `conversation`（**选择文件夹…** 调用 `remote.directoryPicker`，该 Remote 不存在时仍可手动输入路径），以面板 id `skills` 注册到 root 的 `main` keyed slot，并以 order 5 把图标加入 `sidebar.panellist`。

市场每次打开时读取分类和第一页（十二张卡片），同时读取已安装数量；搜索或切换分类 Tab 会重新读取第 1 页，「加载更多」追加下一页。卡片和详情显示 Skill 的显示名称，详情中还列出它的 slug。卡片上的 **+** 安装该 Skill；已安装的 Skill 显示其版本，名称已被自定义 Skill 占用的 Skill 不能安装并给出提示。详情对话框把去掉 frontmatter 的 SKILL.md 作为不可信 Markdown 渲染（原始 HTML 保持为文本），安装方式相同。Hub 上有新版本的已装 Skill 会显示 **更新到 vX** 而不是版本号；「来自市场」中的卡片显示可更新和 **更新** 按钮，Hub 已下架时显示 **市场已不可用**。更新会覆盖本地修改时，对话框列出被修改的文件，只有点 **覆盖并更新** 才更新。被拒绝的安装会显示其消息，直到下一次操作或被关闭。

市场标题栏的 **添加技能** 打开上传对话框：可以选择用户自定义的 Skill、输入文件夹路径，或点 **选择文件夹…**；读取文件夹后显示名称、描述、文件夹、文件数量与大小，或者无法上传的原因。新 Skill 需要填写显示名称（必填，最多 40 个字符并显示字数；缺失、超长或包含不可见字符时说明原因，**上传** 不可用）、版本号（预填 `1.0.0`）、可见范围（租户可见、特定部门、特定员工或仅自己）和可选的分类；该员工在 Hub 上已有的同名 Skill 作为它的新版本上传（预填下一个补丁版本），显示名称保持不变。上传后对话框显示 **已提交审核**、审核链接和复制按钮；如果 Hub 直接发布，则显示 **已发布**，并重新读取市场列表。Hub 拒绝上传的原因原样显示。本地这份 Skill 保持原样，仍在用户自定义分组中。

「我安装的」每次打开时读取列表以及每个已装市场 Skill 在市场上的状态，每个分组每次「加载更多」展示十二张卡片。开关会立即切换，Host 拒绝时回到原位；某个 skill 的操作进行中时，它的开关与菜单保持禁用。被拒绝的操作会在分组上方显示其消息，直到下一次操作或被关闭。卡片只在 Host 确认移到废纸篓后才消失。「去对话」在侧栏「新建会话」会使用的 Workspace 中新建会话，并把 `/<name> ` 写入草稿而不发送；一个 Workspace 都没有时，会打开不带草稿的空白新建会话页面。停用的 skill 不能去对话。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 skill 注册表：在这里停用 skill 会把它从模型的 skill 目录中移除；「去对话」只准备一份仍需用户发送的草稿。

#### KV Cache 影响

无直接影响；目录变化经由 skill 目录消费方的替换消息到达模型。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **选择文件夹仅限 Desktop**——**选择文件夹…** 打开系统的选择窗口；其他环境下需要手动输入文件夹路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。页面不保存任何可能与其他观测相矛盾的状态；Host 目录是唯一来源。
