---
description: "connector 分组导航：通过官方 CLI 接入的办公平台，供浏览本分组的用户与维护者阅读。"
kind: "package-group"
---

# connector/ — 办公平台连接器

[English](README.md) | 中文

## 概述

connector 家族通过各平台未经修改的官方 CLI，把桌面版连到公司使用的办公平台（目前是飞书，接下来是钉钉），CLI 由 DSH 按发行版固定的版本安装。Desktop 将其呈现为连接器页面。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`connectors/`](connectors/README.zh.md) | 内置连接器及其 CLI 的安装状态，通过 `connectors` Remote 提供 | `ctx.connectors` |

-----

<a id="related-documentation"></a>
## 相关文档

- [连接器子系统参考](../../docs/subsystems/connectors.zh.md) — 连接器 CLI 的安装与存放。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
