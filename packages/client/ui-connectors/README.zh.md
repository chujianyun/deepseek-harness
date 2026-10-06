---
description: "dsh 桌面客户端的连接器页面：侧栏入口，以及安装各自 CLI 的连接器卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-connectors

[English](README.md) | 中文

## 概述

在桌面版侧栏「知识库」下方添加 **连接器** 入口及其打开的页面：每个内置[连接器](../../../docs/glossary.zh.md#connector)一张卡片，右上角显示安装控件或状态。它通过 [`connectors` Remote](../../connector/connectors/README.zh.md) 读取和操作。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Host 的 `connectors` 行旁边挂载浏览器行，并使用相同的 `disabled` 条件；web-app bundle 在配置了用户中心的 `desktop` profile 中同时启用两者。插件只在桌面渲染进程中（存在 `dshDesktop`）生效。它注入 `remote.connectors`，把页面以 `connectors` 注册到 `main` 键控插槽，并以顺序 7 把入口加入 `sidebar.panellist`。

每张卡片显示平台名称、其官方 CLI 能访问的内容，以及本发行版安装的 CLI 和版本。右上角在 CLI 未安装时显示 `+`，安装中显示转圈（并显示进度条和已下载百分比，全部字节到达后显示 **正在检查…**），安装完成后显示红点和 **未连接**。DSH 尚未支持的连接器显示 **即将支持**，CLI 没有本系统构建的显示 **此系统暂不支持**；两者都不提供 `+`。安装失败后，卡片说明原因（下载源不可达、下载校验未通过、无法写入安装目录，或 CLI 无法运行），并再次提供 `+`。已安装卡片的 **⋯** 菜单提供 **卸载**，卸载前需要确认，并说明用户自己安装的 CLI 不受影响。卡片状态只来自流式推送的状态；操作的应答只报告拒绝，拒绝信息显示在卡片上方，直到被关闭。

-----

<a id="model-experience"></a>
## 模型体验

无，因为页面只安装和卸载连接器 CLI。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **尚无登录** — 在实现平台登录之前，已安装的连接器显示 **未连接**。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。页面渲染 Host 的状态流，只保留正在卸载的连接器和进行中的操作。
