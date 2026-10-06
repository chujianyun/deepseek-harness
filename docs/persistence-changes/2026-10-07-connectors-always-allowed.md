---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-connectors-always-allowed

English | [中文](2026-10-07-connectors-always-allowed.zh.md)

## Summary

Adds the log-only connectors/always-allowed audit event, recorded when a bash call runs connector writes without asking because the user always allowed each of them for the signed-in tenant.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-connectors-always-allowed
baseline: false
changes:
  - root: "event:connectors/always-allowed"
    previous: null
    after: "492954dcf5c71ab11312adacc10f9de45eed6bbe90549ec10c21c7e7386efa27"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new event type only; no existing event changes. Older readers ignore an unknown log-only event, it never enters the model transcript, and nothing replays it into state. The approval/asked and approval/decided pair keeps its closed outcome vocabulary.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/connector/connectors/tests/approval.host.spec.ts packages/connector/connectors/tests/dingtalk.host.spec.ts packages/interaction/user-approval: 72 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
