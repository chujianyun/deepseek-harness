---
description: "Desktop 本地知识库：按租户保存的文档集合，分块、向量化并建立混合检索索引，以及 knowledgeBases Remote。"
kind: "package-reference"
---
# Knowledge Base

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-knowledge-base` 以 Host 服务 `ctx.knowledgeBases` 和 `knowledgeBases` Remote 命名空间的形式，提供当前登录租户的[知识库](../../../docs/glossary.zh.md#knowledge-base)。用户基于某个[嵌入模型](../../llm/embedding/README.zh.md)创建知识库，向其中加入 Word（`.docx`）、PDF、Markdown 与文本文件，由一个处理器读取、分块、向量化并建立索引。Host 中的使用方通过 `search(id, query, options)` 检索知识库。存储与检索见[知识库子系统参考](../../../docs/subsystems/knowledge.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop profile 中把本包挂成 Loader 条目，与 `hub-account`、`embedding` 并列；它注入 `embedding` 与 `hubAccount`。web-app bundle 在 `desktop` profile 且配置了用户中心时启用它，由 `ui-knowledge` 渲染页面。

知识库属于当前 Hub 登录所在的租户：未登录时没有知识库，登录另一个租户时看到的是那个租户的。`createBase(name, embeddingModelId)` 要求名称为 1 到 50 个字且在租户内唯一，嵌入模型必须是「设置 → 嵌入模型」提供的（本地模型，除非本平台无法运行；或已添加的 API 模型）。`renameBase()` 与 `deleteBase()` 修改知识库；删除会移除其目录。

`addFiles(id, paths)` 接收本机文件的绝对路径（Desktop 渲染器从拖入或选中的文件读取）。扩展名不受支持、大于 `maxFileBytes` 或无法读取的文件会被拒绝并说明原因；其余文件复制进知识库并作为 `pending` 条目排队。处理器逐个处理当前登录租户的待处理条目：读取文本（Word 用 mammoth，PDF 用 pdf.js 读取文本层，并做 NFKC 规范化），切分为约 `chunkSize` 个估算 token 的分块（每块最多带上前一块末尾 `chunkOverlap` 个 token），按每批 `embedBatch` 个向量化，并在一个事务中替换该条目的分块。文件无法解析时条目以 `unreadable` 失败，没有文字（扫描版 PDF）时以 `empty` 失败，嵌入模型拒绝、出错或返回的向量数量不对时以 `embedding` 失败，索引拒绝写入分块时以 `storage` 失败；之后处理器继续处理下一个条目。`reprocessItem()` 从保存的副本重新排队一个条目，`deleteItem()` 删除条目及其副本与分块；两者都会先停止正在处理的该条目。

使用本地嵌入模型的知识库在该模型未安装期间为 `unavailable`；其条目保持 `pending`，等模型安装后再处理。某个租户成为当前登录租户时（启动时或登录时），之前运行遗留的 `pending` 或 `processing` 条目中，使用本地模型的继续处理（不产生费用），使用 API 模型的以 `interrupted` 失败，避免在用户不知情时产生费用。登录另一个租户会停止正在处理的条目；回到原租户时按同样规则处理。`index.sqlite` 无法打开的知识库不出现在列表中（日志里有警告），该租户的其他知识库照常打开。

本包通过 `embedding.registerUsage()` 登记使用方：本机任何租户的任何知识库正在使用的嵌入模型都不能删除。

`search(id, query, { limit, threshold })` 用知识库的模型对查询向量化，返回已完成条目中合并得分（0.7 × 余弦相似度 + 0.3 × 按最佳关键词匹配归一化的 BM25）不低于 `threshold` 的最多 `limit` 个分块，按得分从高到低。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Harness 主目录；知识库位于 `<dshHome>/knowledge`。 |
| `maxFileBytes` | `104857600`（100 MB） | 接受的最大文件。 |
| `chunkSize` | `1024` | 新知识库的分块大小，单位为估算 token。 |
| `chunkOverlap` | `200` | 新知识库的分块从前一块带过来的 token 数。 |
| `embedBatch` | `16` | 每次嵌入调用向量化的分块数。 |
| `maxNameLength` | `50` | 知识库名称的最大长度。 |

-----

<a id="model-experience"></a>
## 模型体验

无，因为知识库在会话之外管理和检索，目前没有模型请求携带它们。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只支持文件** — 文件夹、网页和笔记稍后提供；条目类型目前总是 `file`。
- **估算 token** — 分块大小为估算值（每个汉字算一个 token，其他字符每四个算一个），不使用嵌入模型的分词器计数。
- **只读取文本层** — 扫描版 PDF 没有文本层，会以 `empty` 失败；OCR 延后提供。
- **全量比对相似度** — 检索时在 SQLite 中把查询与每个分块向量逐一比较；超大知识库需要 sqlite-vec 等向量索引。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。每个知识库的目录就是其状态；服务在每次切换租户时重新打开它，并据此处理未完成的条目。
