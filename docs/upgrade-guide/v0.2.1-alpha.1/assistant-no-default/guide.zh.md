---
kind: upgrade-guide
description: "Desktop 不再有默认智能体：新会话不绑定智能体，setDefault Remote 和 defaultId 状态已移除。"
---

# 新会话不绑定智能体

[English](guide.md) | 中文

## 变更

以前每个新的 Desktop 会话都会绑定租户的默认智能体（最初是日常助手），智能体页提供**设为默认**。现在新会话不绑定智能体，行为与没有智能体时一样；输入框上方的选择器先列出**不使用智能体**，可以在第一轮之前绑定一个智能体或改回不绑定。`assistants.setDefault()` Remote 和 `AssistantsState` 的 `defaultId` 字段已移除，`assistants.select(sessionId, assistantId)` 也接受 `null`，记录为 `assistantId` 为空的 `assistant/selected`。`tenant.json` 中已有的 `defaultId` 会被忽略。依赖默认智能体的 Desktop 用户，以及调用 `setDefault` 或读取 `defaultId` 的 Remote、SDK 调用方会受到影响。

## 迁移

1. Desktop 用户：在新会话选择器中选择智能体，或在智能体卡片上点**对话**，开始一个绑定它的会话。
2. Remote 调用方：去掉对 `assistants.setDefault()` 的调用和对 `state.defaultId` 的读取；用 `assistants.select(sessionId, assistantId)` 绑定会话，传 `null` 表示不绑定。
3. 读取原始会话日志的程序：把 `assistantId` 为空的 `assistant/selected` 视为没有智能体。
