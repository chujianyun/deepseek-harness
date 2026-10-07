# 智能体

[English](assistants.md) | 中文

智能体让桌面版用户把常用的工作角色做成具名的智能体，每个都有自己的核心文件，并可以用它开始一个会话。相关词汇——智能体、核心文件和智能体模板——在[术语表](../glossary.zh.md#assistant)中定义，智能体为何叠在 Agent preset 之上记录在[智能体 Agent Note](../../.agents/notes/proposed/feature/2026-10-07-assistants-over-agent-presets.zh.md)中。[`@deepseek-ai/dsh-assistants`](../../packages/assistant/assistants/README.zh.md) 拥有智能体和会话绑定；[`@deepseek-ai/dsh-client-ui-assistants`](../../packages/client/ui-assistants/README.zh.md) 渲染智能体页面和新会话选择器。

## 存放

智能体属于当前 Hub 登录所在的租户，保存在 `<dshHome>/assistants/<tenantId>/<assistantId>/`，包含 `assistant.json` 和核心文件 `IDENTITY.md`、`SOUL.md`、`USER.md`、`AGENTS.md`。租户的 `tenant.json` 记录它的默认智能体，以及它的第一个智能体已经创建过：租户第一次登录时用日常助手模板创建一个并设为默认，之后的登录不再创建。

## 管理智能体

详情页通过 `assistants` Remote 编辑智能体的字段和四份核心文件。保存后的核心文件和新名称会在下一步到达所有绑定该智能体的会话，进行中的会话也一样；新的模型或 preset 对之后绑定的会话生效。把另一个智能体设为默认时，绑定旧默认智能体的空白会话会改绑到它。副本带着配置和核心文件，名称为 `<名称> 副本`，不带会话。删除智能体会保留它的会话，这些会话继续进行但不再带它的核心文件：由于之前的轮次仍留在对话中，下一轮会告诉模型那些核心文件不再适用；剩下的第一个智能体成为默认，全部删光后新会话不绑定智能体。

## 能力子集

智能体可以限制其会话的 Skill、连接器和知识库：每一类要么跟随全局（包括之后新增的），要么只允许选中的项目。每项限制由决定该能力的服务执行——skill 注册表的视图过滤器、连接器服务和知识库选择服务——所以模型只能看到、只能使用允许的项目；之后被卸载、关闭或删除的项目只是不再出现。电商管家模板的连接器默认只有飞书。

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
 * Create an assistant for the signed-in tenant from a template or blank.
 * @param input - the wizard's choices: start, identity, avatar, model, preset, and user information.
 * @returns the new assistant's id and the state with it last.
 * @throws RemoteError `hub-account/signed-out`, `assistants/template-not-found`, `assistants/invalid-name`,
 *   `assistants/invalid-description`, `assistants/invalid-avatar`, or `assistants/preset-unavailable`.
 */
@Remote createAssistant(input: CreateAssistantInput): Promise<CreateAssistantResult>

/**
 * List the Skills, connectors, and knowledge bases available now, which subsets can name.
 * Skills are those a new session's default Agent preset discovers outside any project; a
 * service the deployment does not compose offers none.
 * @returns enabled model-usable Skills other than connector Skills, connectors installed and
 *   switched on for the tenant (named by id), and the tenant's knowledge bases.
 */
@Remote async capabilityOptions(): Promise<AssistantCapabilityOptions>

/**
 * Read one assistant with the text of its core files.
 * @param assistantId - the assistant to read.
 * @returns the assistant and its core files.
 * @throws RemoteError `hub-account/signed-out` or `assistants/not-found`.
 */
@Remote getAssistant(assistantId: string): Promise<AssistantDetail>

/**
 * Change an assistant. Core files and the name reach every session bound to it on its next turn;
 * a changed model or preset applies to sessions bound afterward and to blank sessions bound now.
 * Renaming also rewrites the `**名称**` line of the identity file.
 * @param assistantId - the assistant to change.
 * @param input - the fields to change.
 * @returns the state with the change.
 * @throws RemoteError `hub-account/signed-out`, `assistants/not-found`, `assistants/invalid-name`,
 *   `assistants/invalid-description`, `assistants/invalid-avatar`, `assistants/preset-unavailable`, or `assistants/invalid-file`.
 */
@Remote updateAssistant(assistantId: string, input: UpdateAssistantInput): Promise<AssistantsState>

/**
 * Make an assistant the one new sessions bind; blank sessions bound to the previous default move to it.
 * @param assistantId - the new default.
 * @returns the state with the new default.
 * @throws RemoteError `hub-account/signed-out` or `assistants/not-found`.
 */
@Remote setDefault(assistantId: string): Promise<AssistantsState>

/**
 * Copy an assistant's configuration and core files into a new assistant named «name 副本»; sessions are not copied.
 * @param assistantId - the assistant to copy.
 * @returns the copy's id and the state with it last.
 * @throws RemoteError `hub-account/signed-out` or `assistants/not-found`.
 */
@Remote duplicateAssistant(assistantId: string): Promise<CreateAssistantResult>

/**
 * Delete an assistant. Its sessions remain and carry no core files from their next turn. Deleting
 * the default makes the first remaining assistant the default; blank sessions bound to the deleted
 * one move to the default, or bind none when no assistant remains.
 * @param assistantId - the assistant to delete.
 * @returns the state without it.
 * @throws RemoteError `hub-account/signed-out` or `assistants/not-found`.
 */
@Remote deleteAssistant(assistantId: string): Promise<AssistantsState>

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
