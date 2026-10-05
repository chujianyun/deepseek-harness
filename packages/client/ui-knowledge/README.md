---
description: "Knowledge page of the dsh Desktop client: the sidebar entry and the signed-in tenant's knowledge bases with their files."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-knowledge

English | [中文](README.zh.md)

## Summary

Adds a **Knowledge** entry to the Desktop sidebar, below Skills, and the page it opens: the signed-in tenant's [knowledge bases](../../../docs/glossary.md#knowledge-base) on the left and the selected one's files on the right, with dialogs to create, rename, and delete a knowledge base, and a drop zone and **Add files** button for documents. It reads and acts through the [`knowledgeBases` Remote](../../knowledge/knowledge-base/README.md) and offers the models of the [`embedding` Remote](../../llm/embedding/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `knowledge-base` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. The plugin contributes only in the Desktop renderer (`dshDesktop` present). It injects `remote.knowledgeBases` and `remote.embedding`, registers the page into the `main` keyed slot as `knowledge`, and adds the entry to `sidebar.panellist` at order 6.

Signed out, the page asks to sign in. Otherwise the list shows each knowledge base with its file count, and the first is selected until another is chosen. **New knowledge base** opens a dialog for a name and an embedding model: the local model, marked as available once downloaded while it is not installed, and each API embedding model with its provider; choosing an API model shows that document content is sent to its provider, and with no model available the dialog points to Settings → Embedding models. A duplicate or invalid name is explained in the dialog.

The detail shows the knowledge base's embedding model, a notice while that model is unavailable, **Rename** and **Delete knowledge base** (deletion asks for confirmation), and the files as a table of name, size, status, and chunk count. A failed file shows its reason; a done or failed file can be processed again, and any file can be deleted. Files dropped on the drop zone or chosen with **Add files** are added by their local paths, which the Desktop preload reads from each file; files without one are explained instead. After an addition the page reports how many files were added and why any were refused.

-----

<a id="model-experience"></a>
## Model Experience

None, as the page only renders and edits knowledge bases.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Files only** — folders, web pages, and notes, the knowledge base settings, and the recall test come later.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The page renders the Host's state streams; it keeps only the selection and dialog drafts.
