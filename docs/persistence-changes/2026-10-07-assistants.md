---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-assistants

English | [中文](2026-10-07-assistants.zh.md)

## Summary

Adds the assistant/selected and assistant/instructions events and the assistant Session projection: a blank main session binds one assistant, and before each turn step the bound assistant's core files are recorded whenever they differ from the previous record.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-assistants
baseline: false
changes:
  - root: "event:assistant/instructions"
    previous: null
    after: "d670776895699c9f1c0744f7215f125a489a7a916d6fe9b53ec6e519cb49b215"
    decision: same-version
  - root: "event:assistant/selected"
    previous: null
    after: "14f2b844c6a6e201db115093edccf48265f1a4704f817762584babe24ef47379"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New event types and a new projection only; no existing event or projection changes. Logs without them project to no bound assistant and no instructions, so the assistant:core-files prompt section stays empty and older sessions assemble the same prompt as before.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/assistant/assistants: 12 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
