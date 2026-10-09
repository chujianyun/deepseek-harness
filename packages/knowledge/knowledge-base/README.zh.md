---
description: "Desktop 本地知识库：按租户保存的文档集合，分块、向量化并建立混合检索索引，以及 knowledgeBases Remote。"
kind: "package-reference"
---
# Knowledge Base

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-knowledge-base` 以 Host 服务 `ctx.knowledgeBases` 和 `knowledgeBases` Remote 命名空间的形式，提供当前登录租户的[知识库](../../../docs/glossary.zh.md#knowledge-base)。用户基于某个[嵌入模型](../../llm/embedding/README.zh.md)创建知识库，向其中加入 Word（`.docx`）、PDF、Markdown 与文本文件、包含这些文件的文件夹、网页和笔记，由一个处理器读取、分块、向量化并建立索引。Host 中的使用方通过 `search(id, query, options)` 检索知识库。存储与检索见[知识库子系统参考](../../../docs/subsystems/knowledge.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop profile 中把本包挂成 Loader 条目，与 `hub-account`、`embedding` 并列；它注入 `embedding` 与 `hubAccount`，profile 中有 `web` 时通过它抓取网页。web-app bundle 在 `desktop` profile 且配置了用户中心时启用它，由 `ui-knowledge` 渲染页面。

知识库属于当前 Hub 登录所在的租户：未登录时没有知识库，登录另一个租户时看到的是那个租户的。`createBase(name, embeddingModelId)` 要求名称为 1 到 50 个字且在租户内唯一，嵌入模型必须是「设置 → 嵌入模型」提供的（本地模型，除非本平台无法运行；或已添加的 API 模型）。`renameBase()` 与 `deleteBase()` 修改知识库；删除会移除其目录。

`addFiles(id, paths)` 接收本机文件的绝对路径（Desktop 渲染器从拖入或选中的文件读取）。扩展名不受支持、大于 `maxFileBytes` 或无法读取的文件会被拒绝并说明原因；其余文件复制进知识库并作为 `pending` 条目排队。处理器逐个处理当前登录租户的待处理条目：读取文本（Word 用 mammoth，PDF 用 pdf.js 读取文本层，并做 NFKC 规范化），切分为最多 `chunkSize` 个估算 token 的分块（每块开头最多重复前一块末尾 `chunkOverlap` 个 token），按每批 `embedBatch` 个向量化，并在一个事务中替换该条目的分块。文件无法解析时条目以 `unreadable` 失败，没有文字（扫描版 PDF）时以 `empty` 失败，嵌入模型拒绝、出错或返回的向量数量不对时以 `embedding` 失败，索引拒绝写入分块时以 `storage` 失败；之后处理器继续处理下一个条目。`reprocessItem()` 从保存的副本重新排队一个条目，`deleteItem()` 删除条目及其副本与分块；两者都会先停止正在处理的该条目。条目的分块在新的处理结果替换前始终可检索，与其状态无关。

`addFolder(id, path)` 遍历文件夹及其子文件夹，跳过名称以点开头的条目和符号链接。每个受支持的文件（按路径顺序，最多 `maxFolderFiles` 个）复制进来，成为 `file` 条目，其 `parentId` 指向 `folder` 条目，`source` 为相对文件夹的路径；不支持的文件和超出上限的文件计入文件夹的 `skippedCount`，其中前 500 个列在 `skipped` 中。不会监听文件夹：对文件夹调用 `reprocessItem()` 时重新扫描，加入新文件、移除已删除的文件，并重新复制、排队已变化（大小或修改时间不同）或失败的文件。文件夹不存在时以 `folder-missing` 失败，其中的文件保持不变。文件夹本身不参与处理；其视图的进度、大小与分块数取自其中的文件，删除文件夹会一并删除这些文件。

`addUrl(id, url)` 把一个 http 或 https 网页排队。处理时通过 `ctx.web.fetch`（本地抓取 provider，带地址、大小与超时限制）抓取，用 Mozilla Readability 在 linkedom 文档上提取正文，用 turndown 写成 Markdown，并以网页标题命名条目；只读取这一页。重新处理会再次抓取。网页无法抓取时（出错、非 2xx 状态码，或没有 `web` 服务），重新索引上次抓取的副本并以 `unreachable` 失败（web 服务按策略拒绝该地址时，即 `WEB_BLOCKED_URL`，以 `blocked` 失败），这样原有内容仍可检索。

`createNote(id, title, content)` 与 `updateNote(id, itemId, title, content)` 保存笔记：标题 1 到 `maxNoteTitleLength` 个字符，Markdown 正文最多 `maxNoteChars` 个字符，超出时以 `knowledge/invalid-note` 拒绝；保存后只把这一条排队。`getNote()` 读回一条笔记。笔记以标题作为一级标题一起建立索引。

每个状态都带有随每次变化增长的 `revision`（Host 重启后仍继续增长），页面据此在操作返回的状态与推送的状态先后颠倒时保留较新的那个。

使用本地嵌入模型的知识库在该模型未安装期间为 `unavailable`；其条目保持 `pending`，等模型安装后再处理。某个租户成为当前登录租户时（启动时或登录时），之前运行遗留的 `pending` 或 `processing` 条目中，使用本地模型的继续处理（不产生费用），使用 API 模型的以 `interrupted` 失败，避免在用户不知情时产生费用。登录另一个租户会停止正在处理的条目；回到原租户时按同样规则处理。`index.sqlite` 无法打开的知识库不出现在列表中（日志里有警告），该租户的其他知识库照常打开。

每个知识库在 `base.json` 中保存自己的设置，参照 Cherry Studio 的知识库设置，不含重排模型；这些设置出现之前保存的知识库按默认值读取。`updateSettings(id, patch)` 修改其中任意几项，超出范围的值以 `knowledge/invalid-settings` 拒绝，并指明字段：

| 设置 | 默认值 | 规则 |
|---|---|---|
| `chunkStrategy` | `structured` | `structured`（智能分段）在 Markdown 结构处结束分块——标题、代码块边界、分隔线、空行、列表项，其次是换行和句末——从不在标题后紧接着结束，并且只要前面够得到别的切分点，就不在代码块内部切开；分隔符作为一个段落级切分点。`delimiter` 优先在分隔符处结束分块，其次是空行、换行、`。`、`. ` 和空格。 |
| `chunkSeparator` | `\n\n` | 用 `\n`、`\t`、`\r`、`\\` 转义书写；`delimiter` 必填。 |
| `chunkSize` | 配置项 `chunkSize` | 正整数。 |
| `chunkOverlap` | 配置项 `chunkOverlap` | 小于 `chunkSize` 的非负整数。 |
| `documentCount` | `6` | 一次检索最多返回的分块数，1–50。 |
| `threshold` | `0` | 检索保留的最低合并得分，0–1。 |

两种策略都在分块剩余空间的最后四分之一里选得分最高的切分点，越靠近上限得分越高；找不到切分点时硬切。分块设置的修改只对之后处理的条目生效；`reprocessAll(id)` 把所有条目重新排队，每个条目的旧分块在新分块替换前仍可检索。

更换 `embeddingModelId` 时，新模型必须先对一段试用文本向量化，同时测出向量维度（视图中的 `dimensions`；创建时取「设置」报告的维度）；失败则以 `knowledge/embedding-probe-failed` 拒绝更换并带上模型的报错。已有条目时随后原地重建：删除全部分块、所有条目重新排队，知识库状态为 `rebuilding`，期间以 `knowledge/rebuilding` 拒绝检索，直到没有待处理或处理中的条目。使用 API 模型重建时若 DSH 重启，未完成的条目以 `interrupted` 失败，重建随之结束。

`recall(id, query)` 是召回测试：按知识库自己的 `documentCount` 与 `threshold` 检索，返回命中结果和耗时。它不修改任何内容，也不进入任何会话。

本包通过 `embedding.registerUsage()` 登记使用方：本机任何租户的任何知识库正在使用的嵌入模型都不能删除。

`search(id, query, { limit, threshold })` 用知识库的模型对查询向量化，返回合并得分（0.7 × 余弦相似度 + 0.3 × 按最佳关键词匹配归一化的 BM25）不低于 `threshold` 的最多 `limit` 个分块，按得分从高到低。每个命中结果给出其条目、条目类型和来源（文件夹中文件的相对路径或网页地址）。

`openItem(id, itemId)` 用本机默认应用打开条目自己的副本：文件的副本、网页抓取的 Markdown 或笔记。对文件夹、从未抓取成功的网页，以及无法打开文件的 Host，它以 `knowledge/cannot-open` 拒绝。

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
| `maxFolderFiles` | `1000` | 一个文件夹最多加入的文件数，其余跳过。 |
| `maxNoteTitleLength` | `100` | 笔记标题的最大长度。 |
| `maxNoteChars` | `1000000` | 笔记正文的最大字符数。 |

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包自身不向模型请求加入任何内容；[`knowledge-selection`](../knowledge-selection/README.zh.md#model-experience) 的 `knowledge_search` 工具携带 `search()` 返回的片段。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有内置解析** — 设置中的文档处理只有一个选项；OCR 与 MinerU 处理服务延后提供。
- **不监听文件夹** — 只有重新处理时，知识库中的文件夹才会变化。
- **每个网址只读一页** — 不跟随链接；需要脚本才能显示正文的网页能提取到的内容很少。
- **只能抓取公网网页** — 本地抓取 provider 拒绝内网和本机地址，内网网页会以 `blocked` 失败。
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
