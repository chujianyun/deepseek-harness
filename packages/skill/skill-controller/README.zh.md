---
description: "本机已安装的用户级 skill 的 Host Remote owner：带启用状态的列表、启用与停用、显示位置、编辑以及移到废纸篓。"
kind: "package-reference"
---
# Skill Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-skill-controller` 为 Desktop 的「我安装的」页面提供生成的 `ctx.remote.installedSkills` namespace。它列出用户自己放到本机的自定义 skill（来源为 `user-dsh` 与 `user-agents`），通过 `ctx.skills.setDisabled()` 启用或停用某个 skill，用原生文件管理器或文本编辑器显示或编辑其指令文件，并把它的目录（或扁平文件）移到平台废纸篓。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在浏览器需要展示已安装 skill 的 profile 中把本包挂载为 Loader 条目；它注入 `skills`。挂载了 `agentPresets` 时，`list()` 通过默认 agent preset 的 scope 读取目录，否则读取全局层；读取使用一个没有任何项目根的工作目录，因此每个用户级 skill 都保留其用户级来源。项目级、runtime、随包附带以及 `customSkillDirs` 中的 skill 一律不列出；custom 目录属于部署配置（随附的 preset 用它指向打包的 skill），不算用户安装。

从 Skill Hub 市场安装的 Skill（来源 `market`，来自 [`@deepseek-ai/dsh-skill-market`](../skill-market/README.zh.md)）也会列出，`group` 为 `'market'`；它们的开关是市场按租户的设置（`ctx.skillMarket.setDisabled()`），市场未挂载时切换会以 `installed-skills/rejected` 失败。

其余方法都先在同一份列表里解析名称，其他 skill 一律以 `installed-skills/not-found` 失败，因此项目级与随包附带的 skill 无法在这里启停、显示或删除。`setEnabled(name, enabled)` 通过注册表的 `disabledSkills` 设置持久化，profile 无法写入时以 `installed-skills/rejected` 失败。`reveal(name)` 与 `edit(name)` 把指令文件交给 `revealNativePath` 与 `openNativeTextFile`。`uninstall(name)` 在 macOS 上把安装处的条目——其根目录下的 `<name>/` 或扁平的 `<name>.md`；安装的是符号链接时只移动链接本身，绝不移动它指向的目录——移到 `~/.Trash`，像 Finder 一样把重名命名为 `<name> 2`、`<name> 3`……，废纸篓在另一个卷上时改为复制后删除；在 Windows 上通过 PowerShell 移到回收站；随后清除该 skill 的停用状态（这一步失败只记日志，卸载仍算成功）；其他平台以 `installed-skills/rejected` 失败。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|

本包没有 Config 字段；它所编辑的停用名单属于 [`@deepseek-ai/dsh-skill`](../skill/README.zh.md)。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 skill 注册表：在这里停用的 skill 会离开模型的 skill 目录，被删除的 skill 会在文件系统提供方观察到删除后消失。

#### KV Cache 影响

无直接影响；与其他目录变化一样，skill 目录消费方会在可见集合变化时追加一条替换目录消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Windows 错误对话框**——移到回收站时向 `Microsoft.VisualBasic` 请求 `OnlyErrorDialogs`，这是仍能进回收站的最安静选项；隐藏的 PowerShell 进程里一旦弹出错误对话框，会一直等到调用方的 signal 中止命令。
- **Linux 没有废纸篓支持**——由于 Desktop 产品只面向 macOS 与 Windows，`uninstall` 在 Linux 上直接拒绝；Linux Host 需要 XDG 废纸篓布局。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。skill 注册表拥有目录与停用名单，本包只把用户级条目与文件操作投影到 wire 上。
