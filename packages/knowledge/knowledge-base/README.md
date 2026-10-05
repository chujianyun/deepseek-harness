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

`addFiles(id, paths)` takes absolute paths of files on this machine (the Desktop renderer reads them from dropped or picked files). A file with an unsupported extension, one larger than `maxFileBytes`, or one that cannot be read is refused with its reason; every other file is copied into the knowledge base and queued as a `pending` item. The worker processes the signed-in tenant's pending items one at a time: it reads the text (Word through mammoth, PDF text layers through pdf.js, NFKC-normalized), splits it into chunks of about `chunkSize` estimated tokens that carry up to `chunkOverlap` tokens from the previous chunk, embeds them `embedBatch` at a time, and replaces the item's chunks in one transaction. An item fails as `unreadable` when the file cannot be parsed, `empty` when it has no text (a scanned PDF), `embedding` when the model refuses, fails, or answers the wrong number of vectors, and `storage` when the index refuses the chunks; the worker then moves on to the next item. `reprocessItem()` queues an item again from its stored copy, and `deleteItem()` removes it with its copy and chunks; either first stops the item if it is being processed.

A knowledge base on the local embedding model is `unavailable` while that model is not installed; its items wait as `pending` and are processed once it is. When a tenant becomes the signed-in one — at startup or on sign-in — items an earlier run left `pending` or `processing` resume for the local model, which costs nothing, and fail as `interrupted` for API models, so nothing is billed without the user asking. Signing in to another tenant stops the item being processed; it is settled the same way on return. A knowledge base whose `index.sqlite` cannot be opened is left out of the list, with a warning in the log, and the tenant's other knowledge bases still open.

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
