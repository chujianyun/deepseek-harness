---
description: "知识库选择：每个会话可检索的知识库，按会话写入日志，以及在其上检索的 knowledge_search 工具。"
kind: "package-reference"
---
# Knowledge Selection

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-knowledge-selection` 让对话可以使用当前登录租户的[知识库](../../../docs/glossary.zh.md#knowledge-base)。用户通过 `knowledgeSelection` Remote 按会话选择知识库；会话有选择时，其智能体会获得 `knowledge_search` 工具，该工具只检索这些知识库，并分别使用每个知识库自己的检索设置。选择记录为仅写日志的 `knowledge/selection` 事件，因此恢复和分叉会话时会还原它，`knowledgeSelection` 投影把它提供给客户端。知识库本身由 [`knowledge-base`](../knowledge-base/README.zh.md) 管理；检索与存储见[知识库子系统参考](../../../docs/subsystems/knowledge.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `knowledge-base` 旁把本包作为 Loader 条目挂载；它注入 `agents`、`tools`、`sessionProjections` 和 `knowledgeBases`，profile 中有 `sessionController` 时，通过它恢复尚未接入的会话。web-app bundle 只在 `knowledge-base` 运行的地方启用它，即配置了用户中心的 `desktop` profile；`ui-knowledge` 渲染输入框的「知识库」按钮以及每条回答下方的来源。本包没有配置项。

`select(sessionId, baseIds)` 把会话的选择设为当前登录租户的这些知识库，保持给出的顺序并去除重复；空列表表示不选择，每个新会话也都从不选择开始，直到 `dsh-assistants` 为它选中其智能体限定的知识库。租户没有对应知识库的 id 会以 `knowledge-selection/unknown-base` 拒绝。两轮之间，选择会立即写入日志，结果为 `applies: 'now'`。一轮进行中，结果为 `applies: 'next-step'`：本轮下一次请求会立即按新选择带上或去掉工具，选择则在下一个被接受的步骤、该请求发出之前写入日志。与已记录选择相同的选择不写入任何内容。

`allowedBases(sessionId)` 列出会话可以选择的租户知识库 id。`restrict(filter)` 收窄这一范围，例如只允许会话的智能体允许的知识库：`select()` 以 `knowledge-selection/not-allowed` 拒绝过滤器不允许的知识库，检索会跳过已选中但不再允许的知识库，过滤后选择为空的会话会失去该工具。添加或移除过滤器时会重新检查每个存活的 agent，每一步之前也会检查。返回的 disposer 移除该过滤器。

`knowledge_search({ query })` 按每个选中知识库自己的 `documentCount` 和 `threshold` 检索，把片段按得分从高到低合并，保留的数量取被检索知识库中最大的 `documentCount`。无法检索的知识库不会让调用失败：选择后被删除的报告为 `missing`，正在为新嵌入模型重建的报告为 `rebuilding`，本地嵌入模型尚未安装的报告为 `unavailable`，检索抛出错误的报告为 `failed` 并附带消息。结果值包含每个片段的知识库、条目、条目类型、来源（文件夹中文件的相对路径或网页地址）、块序号、得分和正文；其展示元数据中的 `citations` 包含相同字段，并以正文前 160 个字符作为 `snippet`。客户端由此推导每个 Turn 的来源，因此重新加载或回放的会话显示相同的来源。

-----

<a id="model-experience"></a>
## 模型体验

### 知识库检索工具

#### 模型看到的内容

没有选择知识库、或过滤器一个都不允许的会话看不到本包的任何工具。有选择时，模型看到 [`knowledge_search` 的 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-knowledge-selection)，其描述固定，只有一个 `query` 参数；知识库名称不会出现在 schema 中。其结果为文本：每个片段列为 `[n] item (source) — knowledge base "name", chunk n, relevance 0.00`，后接片段正文，或说明没有匹配的片段；最后对每个无法检索的知识库给出一行 `Not searched: "name" — reason.`。

##### 结果示例

```markdown
Found 1 passages for "年假".

[1] 年假制度.docx — knowledge base "公司制度", chunk 1, relevance 0.82
员工入职满一年后享有 5 天带薪年假。

Not searched: "产品资料" — it is being rebuilt for a new embedding model and can be searched once that finishes.
```

#### Token 影响

存在选择时，schema 每次请求约占 100 个 token，按 ToolRuntime 模式计费。每次检索结果按片段大小留在历史中：最多为所选知识库中最大的 `documentCount` 个分块，每块最多为对应知识库 `chunkSize` 个估算 token。

#### KV Cache 影响

选择第一个知识库或清除最后一个知识库会加入或移除该工具，从而改变工具列表，使该处之后的缓存前缀失效。在仍有知识库被选中时改变选择不会改变请求前缀。检索调用和结果按正常方式扩展对话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **待生效的选择只在进程内** — 一轮进行中做出的选择由下一个被接受的步骤写入日志，可能在本轮也可能在下一轮；如果进程先退出，该选择丢失，恢复后使用已记录的选择。
- **选择指向一个租户的知识库** — 登录另一个租户后，会话已选的知识库会报告为 `missing`，直到用户重新选择。
- **不重排** — 不同知识库的片段按混合得分合并，而不同嵌入模型的得分尺度不同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。工具是否出现在智能体作用域中，在每次选择、步骤和智能体创建时由已记录选择与待生效选择推导，因此不存在可能出现分歧的第二个观测。
