---
description: "knowledge 分组导航：把文档分块、向量化并建立检索索引的本地知识库，供浏览本分组的用户与维护者阅读。"
kind: "package-group"
---

# knowledge/ — 本地知识库

[English](README.md) | 中文

## 概述

knowledge 家族把公司文档按 Hub 登录的租户保存在用户本机，并使其可检索：加入知识库的文件会被读取、分块、用[嵌入模型](../llm/embedding/README.zh.md)向量化，并建立向量与关键词混合检索的索引。Desktop 将其呈现为知识库页面。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`knowledge-base/`](knowledge-base/README.zh.md) | 当前登录租户的知识库：管理、文件处理队列与混合检索，通过 `knowledgeBases` Remote 提供 | `ctx.knowledgeBases` |

-----

<a id="related-documentation"></a>
## 相关文档

- [知识库子系统参考](../../docs/subsystems/knowledge.zh.md) — 存储布局、处理与检索。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
