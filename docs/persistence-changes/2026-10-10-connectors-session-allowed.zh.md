---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-10-connectors-session-allowed

[English](2026-10-10-connectors-session-allowed.md) | 中文

## 概述

新增仅记日志的 connectors/session-allowed 事件，为会话授权所列连接器的普通写操作。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

新增根：已有日志没有该事件，折叠为空授权，因此这些会话仍和以前一样逐次确认。该事件不进入模型对话记录；connectorGrants 投影折叠最近一条，空列表表示撤销授权。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/connector/connectors：117 个测试通过，包括授权、撤销、重启后仍有效和未知连接器的用例。

<a id="dev-note"></a>
## 开发备注

无。
