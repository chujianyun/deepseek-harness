# 知识库

[English](knowledge.md) | 中文

本地知识库让 Desktop 用户收集公司文档并对其检索。知识库、知识库条目、嵌入模型、重建等术语见[术语表](../glossary.zh.md#knowledge-base)。[`@deepseek-ai/dsh-knowledge-base`](../../packages/knowledge/knowledge-base/README.zh.md) 负责当前登录租户的知识库、其处理队列与混合检索；[`@deepseek-ai/dsh-embedding`](../../packages/llm/embedding/README.zh.md) 负责对其向量化的嵌入模型；[`@deepseek-ai/dsh-knowledge-selection`](../../packages/knowledge/knowledge-selection/README.zh.md) 负责每个会话可检索的知识库以及模型在其上检索的工具；[`@deepseek-ai/dsh-client-ui-knowledge`](../../packages/client/ui-knowledge/README.zh.md) 渲染知识库页面、输入框中的知识库选择以及回答下方的来源。

## 存储与处理

知识库属于当前 [Hub 登录](../glossary.zh.md#skill-hub)所在的租户，位于 `<dshHome>/knowledge/<tenantId>/<baseId>`：`base.json` 保存名称、嵌入模型及其测得的向量维度、分块与检索设置，以及是否正在重建；`files/` 保存每个加入文件的副本、抓取网页的 Markdown 和每条笔记；`index.sqlite` 保存条目、条目的分块与嵌入向量，以及分块关键词的无内容 FTS5 索引。文件夹中受支持的文件成为其下的文件条目，在重新处理文件夹时同步；网页通过 `web` 服务在本机抓取并保存为 Markdown；笔记在 DSH 中编写。一个处理器按顺序处理当前登录租户的待处理条目：读取文本（网页先抓取）、分块、对分块向量化，并在一个事务中替换该条目的分块。登录另一个租户会停止处理器；当某租户再次成为当前登录租户时（或启动时），未完成的条目中使用本地嵌入模型的继续处理，使用 API 模型的以 `interrupted` 失败。

[重建](../glossary.zh.md#rebuild)会原地更换知识库的嵌入模型：新模型先对一段试用文本向量化，随后删除全部分块、所有条目重新排队，知识库在没有剩余待处理条目之前拒绝检索。分块设置的修改则要等用户明确「重新处理全部文档」，期间旧分块仍可检索。

## 检索

检索用知识库的模型对查询向量化，把与每个分块向量的余弦相似度，和该分块按最佳匹配归一化的 BM25 关键词得分加权合并。关键词把汉字文本切分为单字与相邻两字，因为 FTS5 默认分词器会把一整段汉字当成一个词。召回测试按知识库保存的返回数量与阈值执行同样的检索，不进入任何会话。

## 在对话中使用

[知识库选择](../glossary.zh.md#knowledge-selection)按会话记录为完整值的 `knowledge/selection` 事件，由 `knowledgeSelection` 投影折叠；新会话不选择任何知识库，除非它的智能体只允许部分知识库，此时由 `dsh-assistants` 为它选中这些知识库。会话的选择不为空时，其智能体会获得 `knowledge_search` 工具：它对每个选中的知识库按该知识库保存的返回数量与阈值执行同样的检索，把片段按得分从高到低合并，并对已删除、重建中、不可用或检索失败的知识库给出说明，而不是让调用失败。每次检索记录为 `tool/call` 和 `tool/result`；结果的展示元数据带有片段来源，客户端据此在重新加载或回放后显示该 Turn 的来源。一轮进行中修改的选择从该轮下一次请求开始生效，并在该请求发出前写入日志。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxknowledgebases--knowledgebaseservice"></a>

### `ctx.knowledgeBases` — `KnowledgeBaseService`

Host owner of the knowledge bases and of the `knowledgeBases` Remote namespace.

```ts cordis-catalog
/**
 * Read the signed-in tenant's knowledge bases with their items.
 * @returns the state the Knowledge page shows.
 */
@Remote getState(): Promise<KnowledgeState>

/**
 * Stream the state.
 * @param signal - stream lifetime.
 * @returns the current state, then every change.
 */
@Remote({ mode: 'stream' }) async *watch(signal: AbortSignal): AsyncIterable<KnowledgeState>

/**
 * Create a knowledge base for the signed-in tenant.
 * @param name - display name, unique within the tenant.
 * @param embeddingModelId - an embedding model Settings → Embedding models offers.
 * @returns the state with the new knowledge base last.
 * @throws RemoteError `hub-account/signed-out`, `knowledge/invalid-name`, `knowledge/duplicate-name`,
 *   or `knowledge/embedding-model-unavailable`.
 */
@Remote createBase(name: string, embeddingModelId: string): Promise<KnowledgeState>

/**
 * Rename a knowledge base.
 * @param id - knowledge base id.
 * @param name - new name, unique within the tenant.
 * @returns the state.
 * @throws RemoteError `knowledge/not-found`, `knowledge/invalid-name`, or `knowledge/duplicate-name`.
 */
@Remote renameBase(id: string, name: string): Promise<KnowledgeState>

/**
 * Change a knowledge base's embedding model, chunking, or retrieval settings. A new embedding
 * model must embed a trial text first, which measures its vector length; with items present the
 * knowledge base is then rebuilt in place: every chunk is dropped and every item processed again,
 * and it cannot be searched until that ends. Chunking changes apply to items processed afterwards.
 * @param id - knowledge base id.
 * @param patch - settings to change.
 * @returns the state.
 * @throws RemoteError `knowledge/not-found`, `knowledge/invalid-settings`, `knowledge/embedding-model-unavailable`,
 *   or `knowledge/embedding-probe-failed`.
 */
@Remote updateSettings(id: string, patch: KnowledgeSettingsPatch): Promise<KnowledgeState>

/**
 * Process every item of a knowledge base again, as after a chunking change. Old chunks stay
 * searchable until each item's new ones replace them.
 * @param id - knowledge base id.
 * @returns the state with every item pending.
 * @throws RemoteError `knowledge/not-found`.
 */
@Remote reprocessAll(id: string): Promise<KnowledgeState>

/**
 * Recall test: search a knowledge base under its own retrieval settings, outside any session.
 * @param id - knowledge base id.
 * @param query - question or keywords.
 * @returns the hits and how long the search took.
 * @throws RemoteError `knowledge/not-found`, `knowledge/rebuilding`, or the embedding model's failure.
 */
@Remote async recall(id: string, query: string): Promise<KnowledgeRecallResult>

/**
 * Delete a knowledge base with its files and index.
 * @param id - knowledge base id.
 * @returns the state without it.
 * @throws RemoteError `knowledge/not-found`.
 */
@Remote deleteBase(id: string): Promise<KnowledgeState>

/**
 * Add files to a knowledge base: each supported file within the size limit is copied in and queued.
 * @param id - knowledge base id.
 * @param paths - absolute paths of files on this machine.
 * @returns how many were added and which were refused.
 * @throws RemoteError `knowledge/not-found`.
 */
@Remote addFiles(id: string, paths: readonly string[]): Promise<KnowledgeAddResult>

/**
 * Add a folder: each supported file in it and its subfolders, up to `maxFolderFiles`, is copied in
 * as a file item of the folder; unsupported files and those past the limit are listed as skipped.
 * The folder is not watched; reprocessing it scans it again.
 * @param id - knowledge base id.
 * @param path - absolute path of a folder on this machine.
 * @returns the state with the folder last.
 * @throws RemoteError `knowledge/not-found` or `knowledge/not-a-folder`.
 */
@Remote addFolder(id: string, path: string): Promise<KnowledgeState>

/**
 * Add a web page, fetched on this machine when processed; only that page is read.
 * @param id - knowledge base id.
 * @param url - an http or https address.
 * @returns the state with the page last.
 * @throws RemoteError `knowledge/not-found`, `knowledge/invalid-url`, or `knowledge/credentials-in-url` for an
 *   address carrying a user name or password.
 */
@Remote addUrl(id: string, url: string): Promise<KnowledgeState>

/**
 * Write a new note.
 * @param id - knowledge base id.
 * @param title - 1 to `maxNoteTitleLength` characters.
 * @param content - Markdown body of at most `maxNoteChars` characters.
 * @returns the state with the note last.
 * @throws RemoteError `knowledge/not-found` or `knowledge/invalid-note`.
 */
@Remote createNote(id: string, title: string, content: string): Promise<KnowledgeState>

/**
 * Change a note; only that note is processed again.
 * @param id - knowledge base id.
 * @param itemId - the note.
 * @param title - 1 to `maxNoteTitleLength` characters.
 * @param content - Markdown body of at most `maxNoteChars` characters.
 * @returns the state.
 * @throws RemoteError `knowledge/not-found` or `knowledge/invalid-note`.
 */
@Remote updateNote(id: string, itemId: string, title: string, content: string): Promise<KnowledgeState>

/**
 * Read a note for editing.
 * @param id - knowledge base id.
 * @param itemId - the note.
 * @returns its title and body.
 * @throws RemoteError `knowledge/not-found`.
 */
@Remote async getNote(id: string, itemId: string): Promise<KnowledgeNote>

/**
 * Open an item's own copy with this machine's default application: a file's copy, a page's
 * fetched Markdown, or a note. A page's address is the caller's to open in a browser.
 * @param id - knowledge base id.
 * @param itemId - item id.
 * @throws RemoteError `knowledge/not-found`, or `knowledge/cannot-open` for a folder, a page never
 *   fetched, or a Host that cannot open files.
 */
@Remote async openItem(id: string, itemId: string): Promise<void>

/**
 * Process an item again from its stored copy.
 * @param id - knowledge base id.
 * @param itemId - item id.
 * @returns the state with the item pending.
 * @throws RemoteError `knowledge/not-found`.
 */
@Remote reprocessItem(id: string, itemId: string): Promise<KnowledgeState>

/**
 * Delete an item with its copy and chunks.
 * @param id - knowledge base id.
 * @param itemId - item id.
 * @returns the state without it.
 * @throws RemoteError `knowledge/not-found`.
 */
@Remote deleteItem(id: string, itemId: string): Promise<KnowledgeState>

/**
 * Search one of the signed-in tenant's knowledge bases. Host only.
 * @param id - knowledge base id.
 * @param query - question or keywords.
 * @param options - most hits, and least blended score (0–1).
 * @param signal - cancels the query embedding.
 * @returns hits, best first.
 * @throws RemoteError `knowledge/not-found`, `knowledge/rebuilding`, or the embedding model's failure.
 */
async search( id: string, query: string, options: { limit: number; threshold: number }, signal?: AbortSignal, ): Promise<KnowledgeSearchHit[]>
```

Source: [`packages/knowledge/knowledge-base/src/index.ts`](../../packages/knowledge/knowledge-base/src/index.ts)

<a id="ctxknowledgeselection--knowledgeselectionservice"></a>

### `ctx.knowledgeSelection` — `KnowledgeSelectionService`

Host owner of the knowledge selection and of the `knowledgeSelection` Remote namespace.

```ts cordis-catalog
/**
 * Select the knowledge bases a session searches; an empty list selects none. Between turns the
 * selection is logged at once; during a turn it applies from the turn's next step.
 * @param sessionId - the session.
 * @param baseIds - knowledge bases of the signed-in tenant, in the order to show them.
 * @returns the selection and when it applies.
 * @throws RemoteError `knowledge-selection/unknown-base`, `knowledge-selection/not-allowed` for a
 *   knowledge base the session may not search, or the session's resolution failure.
 */
@Remote async select(sessionId: SessionId, baseIds: readonly string[]): Promise<KnowledgeSelectionResult>

/**
 * List the signed-in tenant's knowledge bases a session may select.
 * @param sessionId - the session.
 * @returns the ids, in the tenant's order.
 * @throws the session's resolution failure.
 */
@Remote async allowedBases(sessionId: SessionId): Promise<readonly string[]>

/**
 * Narrow the knowledge bases sessions may select and search. A session can no longer select a
 * knowledge base a filter refuses, and its search skips one already selected; the search tool
 * leaves a session whose selection the filters empty. Every live agent is checked again when a
 * filter is added or removed, and each agent before every step.
 * @param filter - returns false for a knowledge base the agent's session must not search.
 * @returns the disposer that removes the filter.
 */
restrict(filter: KnowledgeFilter): () => void
```

Types: [SessionId](core.zh.md)

Source: [`packages/knowledge/knowledge-selection/src/index.ts`](../../packages/knowledge/knowledge-selection/src/index.ts)
<!-- END GENERATED cordis-surface -->
