---
description: "Knowledge page of the dsh Desktop client, the composer's knowledge selection, and the sources below answers."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-knowledge

English | [中文](README.zh.md)

## Summary

Adds a **Knowledge** entry to the Desktop sidebar, below Skills, and the page it opens: the signed-in tenant's [knowledge bases](../../../docs/glossary.md#knowledge-base) on the left and the selected one's sources on the right, with dialogs to create, rename, and delete a knowledge base, its settings, and a recall test. It reads and acts through the [`knowledgeBases` Remote](../../knowledge/knowledge-base/README.md) and offers the models of the [`embedding` Remote](../../llm/embedding/README.md). In conversations it adds a **Knowledge** button to the composer that selects the knowledge bases the session may search, through the [`knowledgeSelection` Remote](../../knowledge/knowledge-selection/README.md), and shows the sources the model searched below each answer.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `knowledge-base` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. The plugin contributes only in the Desktop renderer (`dshDesktop` present). Mount the Host `knowledge-selection` row with the same condition. It injects `remote.knowledgeBases`, `remote.embedding`, `remote.knowledgeSelection`, `sessions`, and `uiConversation`, registers the page into the `main` keyed slot as `knowledge`, adds the entry to `sidebar.panellist` at order 6, the knowledge button to `conversation.input.left`, the sources to `conversation.chat.turnTail`, and a Chat node definition for `knowledge_search` results.

Signed out, the page asks to sign in. Otherwise the list shows each knowledge base with its file count, and the first is selected until another is chosen. **New knowledge base** opens a dialog for a name and an embedding model: the local model, marked as available once downloaded while it is not installed, and each API embedding model with its provider; choosing an API model shows that document content is sent to its provider, and with no model available the dialog points to Settings → Embedding models. Why a creation was refused is shown in the dialog.

The detail shows the knowledge base's embedding model, a notice while that model is unavailable, **Rename** and **Delete knowledge base** (deletion asks for confirmation), and its sources in four tabs — **Files**, **Folders**, **Web pages**, and **Notes** — each labeled with its count and listing name, size, status, and chunk count. A failed source shows its reason; a done or failed one can be processed again, and any can be deleted. Files dropped on the drop zone or chosen with **Add files** are added by their local paths, which the Desktop preload reads from each file; files without one are explained instead. After an addition the page reports how many files were added and why any were refused.

**Folders** adds a folder picked with **Add folder** (its path is the picked files' common folder, so an empty folder cannot be picked) or dropped on the drop zone. Each folder shows its path, file count, progress, and chunks; **Expand** lists its files by relative path with their status, and **N files skipped** lists the unsupported files and those past the limit, the first 500 by name and the rest as a count. Reprocessing a folder scans it again. **Web pages** adds an address; a page shows its title and address, and one that became unreachable keeps its chunk count beside the reason. **Notes** writes and edits notes in a dialog with a title, a Markdown body, and a character count that refuses saving past 1,000,000 characters; editing loads the saved note.

The page keeps the newer of an action's answer and a streamed state, by their `revision`, so a late answer never takes the page back.

Tabs at the top right switch the detail between **Sources**, **Settings**, and **Recall test**. While the knowledge base is rebuilt for a new embedding model, every tab shows how many of its documents are processed, with a progress bar.

**Settings** replicates Cherry Studio's knowledge base settings without a rerank model, in four sections: file processing (built-in parsing, the only processor for now), the embedding model (with its measured vector dimensions and, for an API model, the notice that content is sent to its provider), chunking (smart chunking, separator, chunk size, and overlap), and retrieval (documents returned, 1–50, and similarity threshold, 0–1). Sizes accept digits only, and Cherry's rules hold: a size above zero, an overlap below the size, and a separator when smart chunking is off. **Save** sends only the changed settings; **Revert** drops unsaved edits. Changing the embedding model of a knowledge base with documents asks first, as every document is chunked and embedded again and search is unavailable until that ends. Chunking changes apply to documents added afterwards; **Reprocess all documents**, enabled once they are saved, applies them to the existing ones.

**Recall test** searches with a question under the saved retrieval settings and lists the hits, best first, with their rank, source file and chunk number, relevance score, and text, after the result count, the time taken, and the top score. The previous hits stay on screen while a new search runs. A recall test enters no session.

The composer's **Knowledge** button, shown while signed in, opens a checklist of the tenant's knowledge bases, marking those being rebuilt or unavailable; it lists only the knowledge bases `knowledgeSelection.allowedBases()` allows for the session, read each time it opens, plus any already selected so they can be cleared, and says so when the conversation's assistant leaves some out; it reads **Knowledge N** while N are selected, and a new session starts with none, or with those its assistant is limited to. Ticking or clearing one selects at once; during a turn the list notes that the change applies from the model's next step, and a refused selection shows why. Below a Turn whose model searched knowledge bases, **Sources** lists each cited item once, best passage first, with its knowledge base, chunk number, and the passage's start. Clicking a file or note opens its copy in the knowledge base with this machine's default application, saying so when the copy is gone; clicking a web page opens its address in the browser. The sources come from the logged search results, so they survive a reload.

-----

<a id="model-experience"></a>
## Model Experience

None, as the page only edits knowledge bases and the composer button only selects them; the model-facing tool belongs to [`knowledge-selection`](../../knowledge/knowledge-selection/README.md#model-experience).

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Sources open copies** — a cited file opens the copy kept in the knowledge base, not the original file it was added from.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The page renders the Host's state streams; it keeps only the selected knowledge base and dialog drafts, and the composer button renders the session's `knowledgeSelection` projection.
