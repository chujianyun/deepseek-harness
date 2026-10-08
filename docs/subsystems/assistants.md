# Assistants

English | [中文](assistants.zh.md)

Assistants let a Desktop user turn the roles they work with into named assistants, each with its own core files, and start a session with one. The vocabulary — assistant, core files, and assistant template — is defined in the [glossary](../glossary.md#assistant), and why assistants sit on top of Agent presets is recorded in the [assistants Agent Note](../../.agents/notes/proposed/feature/2026-10-07-assistants-over-agent-presets.md). [`@deepseek-ai/dsh-assistants`](../../packages/assistant/assistants/README.md) owns the assistants and session binding; [`@deepseek-ai/dsh-client-ui-assistants`](../../packages/client/ui-assistants/README.md) renders the Assistants page and the new-session picker.

## Storage

Assistants belong to the tenant of the current Hub sign-in and live under `<dshHome>/assistants/<tenantId>/<assistantId>/`, with `assistant.json` and the core files `IDENTITY.md`, `SOUL.md`, `USER.md`, and `AGENTS.md`. The tenant's `tenant.json` records its default assistant and that its first assistant was created: the first sign-in of a tenant creates one from the Daily Assistant template and makes it the default, and no later sign-in creates another.

## Managing assistants

The detail page edits an assistant's fields and its four core files through the `assistants` Remote. Saved core files and a new name reach every session bound to the assistant on its next step, including sessions in progress; a new model or preset applies to sessions bound afterward. Setting another default moves blank sessions bound to the previous default to it. A copy carries the configuration and core files under the name `<name> 副本`, without sessions. Deleting an assistant keeps its sessions, which continue without its core files: since earlier turns stay in the conversation, their next turn tells the model that those core files no longer apply; the first remaining assistant becomes the default, and with none left new sessions bind no assistant.

## Sessions and their assistant

Each session row in the sidebar shows the avatar of its assistant, named on hover and in the row's hover card; a session whose assistant belongs to another company on this machine shows an other-company mark that names nothing about it, one whose assistant was deleted shows a deleted-assistant mark, and one bound to none shows nothing. An assistant's detail page lists its recent sessions, latest first, and opens one on click.

## Capability subsets

An assistant can limit the Skills, connectors, and knowledge bases of its sessions: each kind either follows global, including items added later, or allows only the items selected. Each limit is enforced by the service that decides that capability — the skill registry's view filter, the connectors service, and the knowledge selection service — so the model sees and uses only the allowed items, and an item that is later uninstalled, switched off, or deleted simply drops out. A new session bound to an assistant that allows only selected knowledge bases starts with those that still exist selected, so the model can search them at once; the user can still clear or change them in the composer, and switching to an assistant that follows global clears them; a selection the user changed is kept. The E-commerce Manager template starts with only Feishu among the connectors.

## Session binding

A main session binds one assistant while it is blank, recorded as `assistant/selected`; a blank session without one takes the tenant's default, and the new-session picker binds another before the first turn. An assistant with an Agent preset switches the session to it first. Before each turn step, the bound assistant's core files are read and, when they changed, recorded as `assistant/instructions`; the `assistant:core-files` prompt section after the deployment persona carries the recorded text, so the model sees an edit on the next step and the session log reconstructs every prompt. Subagent sessions bind no assistant.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md)

Source: [`packages/assistant/assistants/src/index.ts`](../../packages/assistant/assistants/src/index.ts)
<!-- END GENERATED cordis-surface -->
