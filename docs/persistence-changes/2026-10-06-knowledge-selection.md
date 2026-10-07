---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-knowledge-selection

English | [中文](2026-10-06-knowledge-selection.zh.md)

## Summary

Adds the log-only knowledge/selection event: the knowledge bases a session may search, as a whole-value list of ids and names.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-knowledge-selection
baseline: false
changes:
  - root: "event:knowledge/selection"
    previous: null
    after: "3e931d3bb95ac1863f816b3cf3d5d4c6722d433d061e69f937a30f1ceb2b2b92"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new event type; existing logs remain valid and never contain it. Builds that do not know the type refuse a log that contains it, which is intended: the selection decides whether the model is offered the knowledge_search tool, so ignoring it would change what the model saw. Sessions that never select a knowledge base write no such event.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/knowledge/knowledge-selection: 12 tests passed, including the selection restored by projection fold after reload and the request/header and tool/result records written for a search.

<a id="dev-note"></a>
## Dev Note

None.
