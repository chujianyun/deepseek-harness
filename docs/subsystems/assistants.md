# Assistants

English | [中文](assistants.zh.md)

Assistants let a Desktop user turn the roles they work with into named assistants, each with its own core files, and start a session with one. The vocabulary — assistant, core files, and assistant template — is defined in the [glossary](../glossary.md#assistant), and why assistants sit on top of Agent presets is recorded in the [assistants Agent Note](../../.agents/notes/proposed/feature/2026-10-07-assistants-over-agent-presets.md). [`@deepseek-ai/dsh-assistants`](../../packages/assistant/assistants/README.md) owns the assistants and session binding; [`@deepseek-ai/dsh-client-ui-assistants`](../../packages/client/ui-assistants/README.md) renders the Assistants page and the new-session picker.

## Storage

Assistants belong to the tenant of the current Hub sign-in and live under `<dshHome>/assistants/<tenantId>/<assistantId>/`, with `assistant.json` and the core files `IDENTITY.md`, `SOUL.md`, `USER.md`, and `AGENTS.md`. The tenant's `tenant.json` records its default assistant and that its first assistant was created: the first sign-in of a tenant creates one from the Daily Assistant template and makes it the default, and no later sign-in creates another.

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
