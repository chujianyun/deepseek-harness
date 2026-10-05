---
description: "Local knowledge bases for Desktop: per-tenant document collections chunked, embedded, and indexed for hybrid search, and the knowledgeBases Remote."
kind: "package-reference"
---
# Knowledge Base

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-knowledge-base` owns the [knowledge bases](../../../docs/glossary.md#knowledge-base) of the signed-in tenant, as the Host service `ctx.knowledgeBases` and the `knowledgeBases` Remote namespace. Users create a knowledge base on an [embedding model](../../llm/embedding/README.md), add Word (`.docx`), PDF, Markdown, and text files to it, and one worker reads, chunks, embeds, and indexes them. Host consumers search a knowledge base with `search(id, query, options)`. Storage and search are described in the [knowledge subsystem reference](../../../docs/subsystems/knowledge.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in the Desktop profile beside `hub-account` and `embedding`; it injects `embedding` and `hubAccount`. The web-app bundle enables it for the `desktop` profile with a configured user center, and `ui-knowledge` renders its page.

Knowledge bases belong to the tenant of the current Hub sign-in: signed out there are none, and another tenant's sign-in shows that tenant's. `createBase(name, embeddingModelId)` takes a name of 1 to 50 characters, unique within the tenant, and an embedding model Settings → Embedding models offers (the local model unless this platform cannot run it, or an added API model). `renameBase()` and `deleteBase()` change one; deletion removes its directory.

`addFiles(id, paths)` takes absolute paths of files on this machine (the Desktop renderer reads them from dropped or picked files). A file with an unsupported extension, one larger than `maxFileBytes`, or one that cannot be read is refused with its reason; every other file is copied into the knowledge base and queued as a `pending` item. The worker processes the signed-in tenant's pending items one at a time: it reads the text (Word through mammoth, PDF text layers through pdf.js, NFKC-normalized), splits it into chunks of at most `chunkSize` estimated tokens that repeat up to `chunkOverlap` tokens from the previous chunk, embeds them `embedBatch` at a time, and replaces the item's chunks in one transaction. An item fails as `unreadable` when the file cannot be parsed, `empty` when it has no text (a scanned PDF), `embedding` when the model refuses, fails, or answers the wrong number of vectors, and `storage` when the index refuses the chunks; the worker then moves on to the next item. `reprocessItem()` queues an item again from its stored copy, and `deleteItem()` removes it with its copy and chunks; either first stops the item if it is being processed.

A knowledge base on the local embedding model is `unavailable` while that model is not installed; its items wait as `pending` and are processed once it is. When a tenant becomes the signed-in one — at startup or on sign-in — items an earlier run left `pending` or `processing` resume for the local model, which costs nothing, and fail as `interrupted` for API models, so nothing is billed without the user asking. Signing in to another tenant stops the item being processed; it is settled the same way on return. A knowledge base whose `index.sqlite` cannot be opened is left out of the list, with a warning in the log, and the tenant's other knowledge bases still open.

Each knowledge base keeps its own settings in `base.json`, modeled on Cherry Studio's knowledge base settings without a rerank model; knowledge bases saved before they existed read with the defaults. `updateSettings(id, patch)` changes any of them and refuses an out-of-range value with `knowledge/invalid-settings`, naming the field:

| Setting | Default | Rule |
|---|---|---|
| `chunkStrategy` | `structured` | `structured` (smart chunking) ends chunks at Markdown structure — headings, code fences, rules, blank lines, list items, then lines and sentences — never right after a heading and, where a break before it is in reach, not inside a code fence; the separator is one more paragraph-level break. `delimiter` ends chunks at the separator first, then at blank lines, lines, `。`, `. `, and spaces. |
| `chunkSeparator` | `\n\n` | Typed with `\n`, `\t`, `\r`, and `\\` escapes; required by `delimiter`. |
| `chunkSize` | the `chunkSize` option | A positive integer. |
| `chunkOverlap` | the `chunkOverlap` option | A non-negative integer below `chunkSize`. |
| `documentCount` | `6` | Most chunks a search returns, 1–50. |
| `threshold` | `0` | Least blended score a search keeps, 0–1. |

Either chunking strategy cuts at the best-scoring break in the last quarter of the room a chunk has, nearer breaks scoring higher, and cuts hard when there is none. Chunking changes apply to items processed afterwards; `reprocessAll(id)` queues every item again, and an item's old chunks stay searchable until its new ones replace them.

A new `embeddingModelId` must first embed a trial text, which measures its vector length (`dimensions` in the view; at creation the length Settings reports); a failure refuses the change with `knowledge/embedding-probe-failed` and the model's message. With items present the knowledge base is then rebuilt in place: every chunk is dropped, every item queued again, and the knowledge base reads `rebuilding` — refusing searches with `knowledge/rebuilding` — until no item is left pending or processing. A restart during a rebuild on an API model ends it with the unfinished items failed as `interrupted`.

`recall(id, query)` is the recall test: it searches under the knowledge base's own `documentCount` and `threshold` and returns the hits with the time taken. It changes nothing and enters no Session.

The package registers a usage with `embedding.registerUsage()`: an embedding model used by any knowledge base on this machine, of any tenant, cannot be removed.

`search(id, query, { limit, threshold })` embeds the query with the knowledge base's model and returns up to `limit` chunks of completed items whose blended score (0.7 × cosine similarity + 0.3 × BM25 normalized against the best keyword match) is at least `threshold`, best first.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home; knowledge bases live under `<dshHome>/knowledge`. |
| `maxFileBytes` | `104857600` (100 MB) | Largest file accepted. |
| `chunkSize` | `1024` | Chunk size of a new knowledge base, in estimated tokens. |
| `chunkOverlap` | `200` | Tokens a new knowledge base's chunks carry over from the previous chunk. |
| `embedBatch` | `16` | Chunks embedded per embedding call. |
| `maxNameLength` | `50` | Longest knowledge base name. |

-----

<a id="model-experience"></a>
## Model Experience

None, as knowledge bases are managed and searched outside any Session; no model request carries them yet.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Built-in parsing only** — the settings' file-processing choice has one entry; OCR and MinerU processors are deferred.
- **Files only** — folders, web pages, and notes come later; the item kind is always `file`.
- **Estimated tokens** — chunk sizes are estimated (one token per Han character, one per four other characters), not counted with the embedding model's tokenizer.
- **Text layers only** — a scanned PDF has no text layer and fails as `empty`; OCR is deferred.
- **Whole-index similarity** — search compares the query with every chunk vector in SQLite; very large knowledge bases would need a vector index such as sqlite-vec.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Each knowledge base's directory is its state; the service reopens it on every tenant switch and settles unfinished items from it.
