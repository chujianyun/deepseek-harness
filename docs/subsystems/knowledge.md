# Knowledge bases

English | [中文](knowledge.zh.md)

Local knowledge bases let a Desktop user collect company documents and have them searched. The vocabulary — knowledge base, knowledge item, embedding model, rebuild — is defined in the [glossary](../glossary.md#knowledge-base). [`@deepseek-ai/dsh-knowledge-base`](../../packages/knowledge/knowledge-base/README.md) owns the knowledge bases of the signed-in tenant, their processing queue, and hybrid search; [`@deepseek-ai/dsh-embedding`](../../packages/llm/embedding/README.md) owns the embedding models that vectorize them; [`@deepseek-ai/dsh-knowledge-selection`](../../packages/knowledge/knowledge-selection/README.md) owns the knowledge bases each session may search and the model's search tool over them; [`@deepseek-ai/dsh-client-ui-knowledge`](../../packages/client/ui-knowledge/README.md) renders the Knowledge page, the composer's knowledge selection, and the sources below answers.

## Storage and processing

A knowledge base belongs to the tenant of the current [Hub sign-in](../glossary.md#skill-hub) and lives under `<dshHome>/knowledge/<tenantId>/<baseId>`: `base.json` with its name, embedding model and its measured vector length, chunking and retrieval settings, and whether a rebuild is under way; `files/` with a copy of each added file, a fetched page's Markdown, and each note; and `index.sqlite` with its items, their chunks and embedding vectors, and a contentless FTS5 index of the chunks' keyword terms. A folder's supported files become file items under it, synced when the folder is reprocessed; a web page is fetched on this machine through the `web` service and kept as Markdown; a note is written in DSH. One worker processes the signed-in tenant's pending items in order: read the text (fetching a page first), split it into chunks, embed the chunks, and replace the item's chunks in one transaction. Signing in to another tenant stops the worker; when a tenant becomes the signed-in one again, or at startup, items left unfinished resume for the local embedding model and fail as `interrupted` for API models.

A [rebuild](../glossary.md#rebuild) replaces a knowledge base's embedding model in place: after the new model embeds a trial text, every chunk is dropped and every item queued again, and the knowledge base refuses searches until none is left to process. Chunking changes instead wait for an explicit reprocessing of all items, keeping the old chunks searchable meanwhile.

## Search

Search embeds the query with the knowledge base's model and blends cosine similarity over every chunk vector with the chunk's BM25 keyword score normalized against the best match. Keyword terms split Han text into characters and adjacent pairs, because the default FTS5 tokenizer keeps a whole Han run as one token. The recall test runs the same search under the knowledge base's saved result count and threshold, outside any Session.

## Use in conversations

A [knowledge selection](../glossary.md#knowledge-selection) is logged per session as the whole-value `knowledge/selection` event and folded by the `knowledgeSelection` projection; a new session selects none. While a session's selection is not empty, its agent is offered the `knowledge_search` tool, which runs the same search on each selected knowledge base under that knowledge base's saved result count and threshold, merges the passages best first, and reports knowledge bases that are deleted, rebuilding, unavailable, or failing instead of failing the call. Each result is recorded as `tool/call` and `tool/result`; the result's presentation metadata carries the passages' sources, from which clients show the Turn's sources after a reload or replay. A selection changed during a turn applies from that turn's next request and is logged before it is sent.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * @throws RemoteError `knowledge-selection/unknown-base`, or the session's resolution failure.
 */
@Remote async select(sessionId: SessionId, baseIds: readonly string[]): Promise<KnowledgeSelectionResult>
```

Types: [SessionId](core.md)

Source: [`packages/knowledge/knowledge-selection/src/index.ts`](../../packages/knowledge/knowledge-selection/src/index.ts)
<!-- END GENERATED cordis-surface -->
