---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-connectors-always-allowed

[English](2026-10-07-connectors-always-allowed.md) | 中文

## 概述

新增仅写入日志的 connectors/always-allowed 审计事件：当某个 bash 调用中的连接器写操作都已被用户对当前租户设为始终允许、因而不再询问时记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

只新增一种事件类型，已有事件不变。旧版读取方忽略未知的仅日志事件；该事件不进入模型对话，也不会被回放成状态。approval/asked 与 approval/decided 这一对事件的结果取值保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/connector/connectors/tests/approval.host.spec.ts packages/connector/connectors/tests/dingtalk.host.spec.ts packages/interaction/user-approval：72 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
