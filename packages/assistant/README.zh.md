---
description: "assistant 分组导航：核心文件会进入所绑定会话、交给模型的具名角色，供浏览本分组的用户与维护者阅读。"
kind: "package-group"
---

# assistant/ — 智能体

[English](README.md) | 中文

## 概述

assistant 家族为桌面版用户提供具名的工作角色：每个租户的智能体及其核心文件，以及会话与其中一个智能体的绑定。Desktop 将其呈现为智能体页面和新会话的智能体选择器。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`assistants/`](assistants/README.zh.md) | 每个租户的智能体、它们的核心文件以及会话绑定，通过 `assistants` Remote 提供 | `ctx.assistants` |

-----

<a id="related-documentation"></a>
## 相关文档

- [智能体子系统参考](../../docs/subsystems/assistants.zh.md) — 智能体的存放，以及把核心文件带进会话。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
