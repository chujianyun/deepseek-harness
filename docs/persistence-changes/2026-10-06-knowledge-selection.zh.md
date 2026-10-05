---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-knowledge-selection

[English](2026-10-06-knowledge-selection.md) | 中文

## 概述

新增仅写日志的 knowledge/selection 事件：会话可检索的知识库，以 id 和名称的完整列表记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

这是新的事件类型；已有日志仍然有效，且不会包含它。不认识该类型的构建会拒绝包含它的日志，这是预期行为：选择决定模型能否看到 knowledge_search 工具，忽略它会改变模型看到的内容。从未选择知识库的会话不会写入该事件。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/knowledge/knowledge-selection：12 个测试通过，覆盖重新加载后由投影折叠恢复选择，以及检索时写入的 request/header 和 tool/result 记录。

<a id="dev-note"></a>
## 开发备注

无。
