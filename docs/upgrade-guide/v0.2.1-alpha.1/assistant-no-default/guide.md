---
kind: upgrade-guide
description: "Desktop no longer has a default assistant: new sessions bind none, and the setDefault Remote and defaultId state are gone."
---

# New sessions bind no assistant

English | [中文](guide.zh.md)

## Change

Previously every new Desktop session bound the tenant's default assistant (first the Daily Assistant), and the Assistants page offered **Make default**. Now a new session binds no assistant and runs as before assistants existed; the composer's picker lists **No assistant** first and binds an assistant, or none, before the first turn. The `assistants.setDefault()` Remote and the `defaultId` field of `AssistantsState` are removed, and `assistants.select(sessionId, assistantId)` also accepts `null`, recorded as `assistant/selected` with an empty `assistantId`. A `defaultId` already in `tenant.json` is ignored. Desktop users who relied on the default assistant, and Remote or SDK callers of `setDefault` or `defaultId`, are affected.

## Migration

1. Desktop users: pick the assistant in the new-session picker, or use **Chat** on its card, which starts a session bound to it.
2. Remote callers: drop calls to `assistants.setDefault()` and reads of `state.defaultId`; bind a session with `assistants.select(sessionId, assistantId)`, or pass `null` for none.
3. Readers of raw session logs: treat an empty `assistant/selected` `assistantId` as no assistant.
