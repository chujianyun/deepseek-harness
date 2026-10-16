---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-automation-tasks-unattended

[English](2026-10-13-automation-tasks-unattended.md) | 中文

## 概述

新增只写日志的 automation-tasks/operations 与 automation-tasks/unattended 事件：自动化任务为无人值守运行声明的操作，以及定时运行中每个未经人工应答的调用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

新的根类型：已有日志没有这两种事件，折叠为未声明任何操作、没有无人值守应答，因此其定时运行行为不变，只是需要确认的调用会被拒绝而不是一直等待。两种事件都不进入模型对话记录；automationUnattended 投影折叠最新的声明，客户端按回合读取应答。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/schedule/automation-tasks：25 个测试通过，覆盖声明、投影、放行与拒绝的调用以及工具关口之外发起的审批；apps/web/tests/automation-unattended.e2e.ts 通过。

<a id="dev-note"></a>
## 开发备注

无。
