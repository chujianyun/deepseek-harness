---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-automation-tasks-unattended

English | [中文](2026-10-13-automation-tasks-unattended.zh.md)

## Summary

Adds the log-only automation-tasks/operations and automation-tasks/unattended events: an automation task's declared operations for its unattended runs, and each call a scheduled run answered without anyone.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-automation-tasks-unattended
baseline: false
changes:
  - root: "event:automation-tasks/operations"
    previous: null
    after: "d60ead507685260a63b9f19a000299cf336786adf7c00e6622ddfcf9c68c0b18"
    decision: same-version
  - root: "event:automation-tasks/unattended"
    previous: null
    after: "1a6796bd36dcb998e3c06d848d57d7bdd05c122532b656118232e55bcfcde125"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New roots: existing logs carry neither event, fold to no declared operations, and record no unattended answers, so their scheduled runs behave as before except that a call that would ask is refused instead of waiting. Both events stay out of the model transcript; the automationUnattended projection folds the latest declaration, and the client reads the answers per turn.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/schedule/automation-tasks: 25 tests passed, including the declaration, the projection, allowed and refused calls, and approvals asked outside the tool gate; apps/web/tests/automation-unattended.e2e.ts passed.

<a id="dev-note"></a>
## Dev Note

None.
