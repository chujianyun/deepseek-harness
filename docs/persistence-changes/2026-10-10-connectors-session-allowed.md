---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-10-connectors-session-allowed

English | [中文](2026-10-10-connectors-session-allowed.zh.md)

## Summary

Adds the log-only connectors/session-allowed event, which grants a session's plain connector writes for the listed connectors.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-connectors-session-allowed
baseline: false
changes:
  - root: "event:connectors/session-allowed"
    previous: null
    after: "956295ef80fc57b1eb589c8b9106ae2f5f5bd81af3b129c5fd4abee0c4527962"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new root: existing logs carry no such event and fold to an empty grant, so their sessions keep asking as before. The event stays out of the model transcript; the connectorGrants projection folds the latest one, and an empty list withdraws the grant.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/connector/connectors: 117 tests passed, including grant, withdrawal, restart, and unknown-connector cases.

<a id="dev-note"></a>
## Dev Note

None.
