---
description: "Knowledge selection: the knowledge bases each session may search, logged per session, and the knowledge_search tool over them."
kind: "package-reference"
---
# Knowledge Selection

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-knowledge-selection` lets a conversation use the signed-in tenant's [knowledge bases](../../../docs/glossary.md#knowledge-base). The user selects knowledge bases per session through the `knowledgeSelection` Remote; while a session has a selection, its agent is offered the `knowledge_search` tool, which searches only those knowledge bases, each under its own retrieval settings. The selection is the log-only `knowledge/selection` event, so resume and fork restore it, and the `knowledgeSelection` projection serves it to clients. Knowledge bases themselves belong to [`knowledge-base`](../knowledge-base/README.md); search and storage are described in the [knowledge subsystem reference](../../../docs/subsystems/knowledge.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry beside `knowledge-base`; it injects `agents`, `tools`, `sessionProjections`, and `knowledgeBases`, and resumes a session that is not attached through `sessionController` when the profile has it. The web-app bundle enables it exactly where `knowledge-base` runs — the `desktop` profile with a configured user center — and `ui-knowledge` renders the composer's 知识库 button and the sources below each answer. It takes no configuration.

`select(sessionId, baseIds)` sets the session's selection to the listed knowledge bases of the signed-in tenant, in that order and without repeats; an empty list selects none, which is also where every new session starts. An id the tenant has no knowledge base for is refused with `knowledge-selection/unknown-base`. Between turns the selection is logged at once and the result says `applies: 'now'`. During a turn the result says `applies: 'next-step'`: the turn's next request is assembled with or without the tool at once, and the selection is logged by the next accepted step, before that request is sent. A selection equal to the logged one writes nothing.

`allowedBases(sessionId)` lists the ids of the tenant's knowledge bases the session may select. `restrict(filter)` narrows them, such as to the knowledge bases a session's assistant allows: `select()` refuses one a filter refuses with `knowledge-selection/not-allowed`, the search skips one already selected, and a session whose selection the filters leave empty loses the tool. Every live agent is checked again when a filter is added or removed, and each agent before every step. The returned disposer removes the filter.

`knowledge_search({ query })` searches each selected knowledge base under its own `documentCount` and `threshold`, merges the passages best first, and keeps as many as the largest `documentCount` among the searched knowledge bases. A knowledge base it cannot search does not fail the call: one deleted since it was selected is reported as `missing`, one being rebuilt for a new embedding model as `rebuilding`, one whose local embedding model is not installed as `unavailable`, and one whose search throws as `failed` with the message. The result value carries each passage's knowledge base, item, item kind, source (a folder file's relative path or a page's address), chunk number, score, and text; its presentation metadata carries `citations` — the same fields with the first 160 characters of the text as `snippet` — from which clients derive the sources of a Turn, so a reloaded or replayed session shows the same sources.

-----

<a id="model-experience"></a>
## Model Experience

### Knowledge search tool

#### What the model sees

A session without selected knowledge bases, or whose filters allow none of them, sees no tool from this package. With a selection, the model sees the [`knowledge_search` schema](../../../docs/tool-catalog.md#deepseek-aidsh-knowledge-selection) with a fixed description and one `query` parameter; knowledge base names never appear in the schema. Its result is text that lists each passage as `[n] item (source) — knowledge base "name", chunk n, relevance 0.00` followed by the passage, or says no passage matched, and ends with one `Not searched: "name" — reason.` line per knowledge base it could not search.

##### Result example

```markdown
Found 1 passages for "年假".

[1] 年假制度.docx — knowledge base "公司制度", chunk 1, relevance 0.82
员工入职满一年后享有 5 天带薪年假。

Not searched: "产品资料" — it is being rebuilt for a new embedding model and can be searched once that finishes.
```

#### Token effect

The schema costs about 100 tokens per request while a selection exists, paid according to ToolRuntime mode. Each search result stays in history at the size of its passages: up to the largest selected `documentCount` chunks of up to each knowledge base's `chunkSize` estimated tokens.

#### KV Cache effect

Selecting the first knowledge base or clearing the last one adds or removes the tool, which changes the tool list and invalidates the cached prefix from there. Changing which knowledge bases are selected while some stay selected leaves the request prefix unchanged. Search calls and results extend the conversation normally.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Pending selections are process-local** — a selection made during a turn is logged by the next accepted step, in that turn or the next; if the process exits first, the selection is lost and the logged one applies after resume.
- **Selections name knowledge bases of one tenant** — after signing in to another tenant, a session's selected knowledge bases report `missing` until the user selects again.
- **No reranking** — passages from different knowledge bases are merged by their blended scores, which different embedding models scale differently.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The tool's presence in an agent's scope is derived from the logged selection and the pending one on every selection, step, and agent creation, so there is no second observation that could diverge.
