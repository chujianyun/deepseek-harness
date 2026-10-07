# 智能体

[English](assistants.md) | 中文

智能体让桌面版用户把常用的工作角色做成具名的智能体，每个都有自己的核心文件，并可以用它开始一个会话。相关词汇——智能体、核心文件和智能体模板——在[术语表](../glossary.zh.md#assistant)中定义，智能体为何叠在 Agent preset 之上记录在[智能体 Agent Note](../../.agents/notes/proposed/feature/2026-10-07-assistants-over-agent-presets.zh.md)中。[`@deepseek-ai/dsh-assistants`](../../packages/assistant/assistants/README.zh.md) 拥有智能体和会话绑定；[`@deepseek-ai/dsh-client-ui-assistants`](../../packages/client/ui-assistants/README.zh.md) 渲染智能体页面和新会话选择器。

## 存放

智能体属于当前 Hub 登录所在的租户，保存在 `<dshHome>/assistants/<tenantId>/<assistantId>/`，包含 `assistant.json` 和核心文件 `IDENTITY.md`、`SOUL.md`、`USER.md`、`AGENTS.md`。租户的 `tenant.json` 记录它的默认智能体，以及它的第一个智能体已经创建过：租户第一次登录时用日常助手模板创建一个并设为默认，之后的登录不再创建。

## 会话绑定

主会话在空白时绑定一个智能体，记录为 `assistant/selected`；没有绑定的空白会话使用租户的默认智能体，新会话选择器可以在第一轮之前改绑另一个。带 Agent preset 的智能体会先把会话切换到该 preset。每个轮次步骤开始前，读取所绑定智能体的核心文件，有变化时记录为 `assistant/instructions`；位于部署人设之后的 `assistant:core-files` 提示词段落携带记录下来的文本，所以模型在下一步就能看到修改，会话日志可以还原每个提示词。子智能体会话不绑定智能体。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxassistants--assistantsservice"></a>

### `ctx.assistants` — `AssistantsService`

Host owner of the assistants and of the `assistants` Remote namespace.

```ts cordis-catalog
/**
 * Read the signed-in tenant's assistants.
 * @returns the state the Assistants page and the new-session picker show.
 */
@Remote getState(): Promise<AssistantsState>

/**
 * Stream the state.
 * @param signal - stream lifetime.
 * @returns the current state, then every change.
 */
@Remote({ mode: 'stream' }) async *watch(signal: AbortSignal): AsyncIterable<AssistantsState>

/**
 * Bind a blank session to one of the signed-in tenant's assistants.
 * @param agent - the session's Agent.
 * @param assistantId - the assistant to bind.
 * @returns the bound assistant id.
 * @throws RemoteError `hub-account/signed-out`, `assistants/not-found`, or `assistants/locked` once the session started.
 */
@Remote('select') select(agent: Agent, assistantId: string): Promise<string>
```

Types: [Agent](core.zh.md)

Source: [`packages/assistant/assistants/src/index.ts`](../../packages/assistant/assistants/src/index.ts)
<!-- END GENERATED cordis-surface -->
