---
description: "The knowledge group map: local knowledge bases whose documents are chunked, embedded, and indexed for search, for users and maintainers navigating the group."
kind: "package-group"
---

# knowledge/ — local knowledge bases

English | [中文](README.zh.md)

## Summary

The knowledge family keeps company documents on the user's machine, per tenant of the Hub sign-in, and makes them searchable: files added to a knowledge base are read, split into chunks, embedded with an [embedding model](../llm/embedding/README.md), and indexed for hybrid vector and keyword search. Desktop renders it as the Knowledge page.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`knowledge-base/`](knowledge-base/README.md) | The signed-in tenant's knowledge bases: management, file processing queue, and hybrid search, over the `knowledgeBases` Remote | `ctx.knowledgeBases` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Knowledge subsystem reference](../../docs/subsystems/knowledge.md) — storage layout, processing, and search.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
