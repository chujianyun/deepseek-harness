---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-assistants

[English](2026-10-07-assistants.md) | 中文

## 概述

新增 assistant/selected 和 assistant/instructions 两种事件，以及 assistant 会话投影：空白的主会话绑定一个智能体；每个轮次步骤开始前，绑定智能体的核心文件只要与上一次记录不同就再记录一次。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

只新增事件类型和投影，不修改任何已有事件或投影。没有这些事件的日志投影为未绑定智能体、没有指令，因此 assistant:core-files 提示词段落保持为空，旧会话组装出的提示词与之前相同。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/assistant/assistants：12 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
