# 知识库

[English](knowledge.md) | 中文

本地知识库让 Desktop 用户收集公司文档并对其检索。知识库、知识库条目、嵌入模型、重建等术语见[术语表](../glossary.zh.md#knowledge-base)。[`@deepseek-ai/dsh-knowledge-base`](../../packages/knowledge/knowledge-base/README.zh.md) 负责当前登录租户的知识库、其处理队列与混合检索；[`@deepseek-ai/dsh-embedding`](../../packages/llm/embedding/README.zh.md) 负责对其向量化的嵌入模型；[`@deepseek-ai/dsh-client-ui-knowledge`](../../packages/client/ui-knowledge/README.zh.md) 渲染知识库页面。

## 存储与处理

知识库属于当前 [Hub 登录](../glossary.zh.md#skill-hub)所在的租户，位于 `<dshHome>/knowledge/<tenantId>/<baseId>`：`base.json` 保存名称、嵌入模型及其测得的向量维度、分块与检索设置，以及是否正在重建；`files/` 保存每个加入文件的副本、抓取网页的 Markdown 和每条笔记；`index.sqlite` 保存条目、条目的分块与嵌入向量，以及分块关键词的无内容 FTS5 索引。文件夹中受支持的文件成为其下的文件条目，在重新处理文件夹时同步；网页通过 `web` 服务在本机抓取并保存为 Markdown；笔记在 DSH 中编写。一个处理器按顺序处理当前登录租户的待处理条目：读取文本（网页先抓取）、分块、对分块向量化，并在一个事务中替换该条目的分块。登录另一个租户会停止处理器；当某租户再次成为当前登录租户时（或启动时），未完成的条目中使用本地嵌入模型的继续处理，使用 API 模型的以 `interrupted` 失败。

[重建](../glossary.zh.md#rebuild)会原地更换知识库的嵌入模型：新模型先对一段试用文本向量化，随后删除全部分块、所有条目重新排队，知识库在没有剩余待处理条目之前拒绝检索。分块设置的修改则要等用户明确「重新处理全部文档」，期间旧分块仍可检索。

## 检索

检索用知识库的模型对查询向量化，把与每个分块向量的余弦相似度，和该分块按最佳匹配归一化的 BM25 关键词得分加权合并。关键词把汉字文本切分为单字与相邻两字，因为 FTS5 默认分词器会把一整段汉字当成一个词。召回测试按知识库保存的返回数量与阈值执行同样的检索，不进入任何会话。

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
 * @throws RemoteError `knowledge/not-found` or `knowledge/invalid-url`.
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
<!-- END GENERATED cordis-surface -->
