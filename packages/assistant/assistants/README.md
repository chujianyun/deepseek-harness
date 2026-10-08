---
description: "Desktop assistants: named roles with their own core files, kept per tenant of the Hub sign-in and bound to sessions, and the assistants Remote."
kind: "package-reference"
---
# Assistants

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-assistants` owns the [assistants](../../../docs/glossary.md#assistant), as the Host service `ctx.assistants` and the `assistants` Remote namespace. An assistant is a named role whose four [core files](../../../docs/glossary.md#assistant-core-files) — identity, soul, user information, and working method — reach the model in its sessions. This package stores each tenant's assistants, creates them from a [template](../../../docs/glossary.md#assistant-template) or blank, edits, copies, and deletes them, limits their sessions' Skills, connectors, and knowledge bases, binds sessions to them with their model and Agent preset, and records the bound assistant's core files for the model. Why assistants sit on top of Agent presets is recorded in the [assistants Agent Note](../../../.agents/notes/proposed/feature/2026-10-07-assistants-over-agent-presets.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in the Desktop profile beside `hub-account`, which it injects with `sessionProjections` and `agents`; it uses `agentPresets` and `sessionController` when the profile composes them. The web-app bundle enables it for the `desktop` profile with a configured user center, and `ui-assistants` renders its page and the new-session picker.

Assistants belong to the tenant of the current [Hub sign-in](../../../docs/glossary.md#skill-hub) and live under `<dshHome>/assistants/<tenantId>/<assistantId>/`: `assistant.json` (`version`, `id`, `name`, `description`, `avatar` — a preset key or an uploaded image's data URL — optional `preset`, `model`, and `templateId`, `createdAt`) and the core files `IDENTITY.md`, `SOUL.md`, `USER.md`, and `AGENTS.md`. The tenant's `tenant.json` records its default assistant and that its first assistant was created. The first time a tenant signs in, the service creates an assistant from the Daily Assistant template and makes it the default; it never creates one again for that tenant, even after the user deletes every assistant. An assistant is written in a hidden staging directory and renamed into place, so an interrupted creation leaves no assistant. A directory without `assistant.json` is skipped, and a malformed one is skipped with a warning. `getState()` and `watch()` return the signed-in tenant's assistants in creation order with the default's id and the built-in templates, plus `otherTenantAssistantIds`: the ids of the assistants other tenants keep under `<dshHome>/assistants/`, read when the tenant is switched, so a client can tell a session of another company's assistant from one whose assistant was deleted; nothing else about them is exposed. Signed out, the state has no tenant, no assistants, and no other tenants' ids.

`createAssistant(input)` creates an assistant for the signed-in tenant from `templateId` — `daily` or `ecommerce` — or blank when it is `null`, and returns its id with the new state. The name is trimmed and must be 1 to `maxNameLength` characters (`assistants/invalid-name`), the description at most `maxDescriptionLength` (`assistants/invalid-description`); an uploaded avatar must be a PNG, JPEG, or WebP data URL no longer than `maxAvatarLength` (`assistants/invalid-avatar`), and a `preset` must be one the deployment composes (`assistants/preset-unavailable`). The core files come from the template, or are headings only when blank; the name replaces the `**名称**` line of `IDENTITY.md`, and `USER.md` is written from `user` — what to call the user, preferred language, notes, and background — so it reaches the prompt. The E-commerce Manager template serves Tmall, Pinduoduo, and Douyin stores across operations and customer service, and asks for confirmation before any change that reaches a platform.

`getAssistant(assistantId)` returns one assistant with the text of its four core files; a file missing on disk reads empty. `updateAssistant(assistantId, input)` changes any of `name`, `description`, `avatar`, `model`, `preset`, and `files`, a map of core file names to new text; `model: null` and `preset: null` return the assistant to the global model and the deployment's default preset, and keys other than the four core file names are ignored. It validates like `createAssistant`, and refuses a core file longer than `maxCoreFileLength` with `assistants/invalid-file`. Renaming also writes the new name into the `**名称**` line of `IDENTITY.md`. Core files and the name reach every session bound to the assistant on its next step, including sessions in progress; a changed model or preset applies to sessions bound afterward, and is installed at once in blank main sessions already bound to it. `setDefault(assistantId)` makes an assistant the one new sessions bind and moves blank main sessions bound to the previous default to it. `duplicateAssistant(assistantId)` copies the configuration and core files into a new assistant named `<name> 副本`, shortening the name to fit `maxNameLength`, and copies no sessions. `deleteAssistant(assistantId)` removes `assistant.json` first and then the directory, so an interrupted deletion leaves no assistant. Sessions bound to a deleted assistant remain and can continue, without its core files from their next step; blank main sessions move to the default. Deleting the default makes the first remaining assistant the default; with none left, new sessions bind no assistant and run as before assistants existed. Each refuses while signed out with `hub-account/signed-out` and an unknown id with `assistants/not-found`.

Each assistant may limit what its sessions use through `subsets`: `skills` (Skill names), `connectors` (connector ids such as `feishu`), and `knowledgeBases` (knowledge base ids). A kind without a list allows everything, including items added later; a list allows only the ids it names, and an id whose item was uninstalled, switched off, or deleted simply allows nothing, without an error. Lists are stored without empty or repeated ids, and a subsets value with no list is not stored. `createAssistant` takes `subsets`, or the template's when absent — the E-commerce Manager starts with only Feishu among the connectors; `updateAssistant` replaces them, and `duplicateAssistant` copies them. The service enforces them where each capability is decided: a skill view filter keeps a session's Skill catalog, `skill` tool, and `/name` invocations to the allowed Skills, leaving connector Skills to the connector subset and letting through the Skills DSH plugins register at runtime (provider `runtime`, such as `ecommerce-accounts`), which every session gets like an account-wide Skill in Accio Work; `connectors.restrict()` keeps the other connectors' Skills and CLIs out of the session; and `knowledgeSelection.restrict()` keeps its knowledge selection and search to the allowed knowledge bases. A subagent follows the session it works for, and a session bound to no assistant, or to one deleted or outside the signed-in tenant, is not limited. A change applies from the session's next read, step, or shell call. `capabilityOptions()` lists what subsets can name now: the Skills a new session's default Agent preset discovers outside any project, without connector Skills, runtime Skills, model-invisible, or disabled ones; the connectors installed and switched on for the tenant; and the tenant's knowledge bases; a service the deployment does not compose offers none.

A main session binds one assistant while it is blank, recorded as `assistant/selected` (`assistantId`). When the service sees a blank main session that has no assistant, it binds the tenant's default. `select(sessionId, assistantId)` binds another one before the first turn: an assistant with a `preset` first switches the session to that Agent preset through `agentPresets.select()`, and one with a `model` installs it for the session through `sessionController.useModel()`, which never changes the global default. Binding happens the same way for the default assistant of a new session. A preset the deployment no longer composes, or a model removed from Settings, is skipped, and the session keeps the deployment's default preset or the global model. Picking, in the same blank session, an assistant without a preset or model after one that set it returns the session to the deployment's default preset or the global model; otherwise binding leaves the session's own choice alone. Binding an assistant whose `knowledgeBases` subset is a list also selects the listed knowledge bases that still exist for the session through `knowledgeSelection.select()`, logged as `knowledge/selection`, so the model can search them from the first turn and the user can still clear or change them in the composer; a listed id whose knowledge base was deleted is skipped. Binding one without a knowledge subset, or no assistant once the last one is deleted, clears that preselection, and editing an assistant's knowledge subset selects again in the blank main sessions bound to it. Only a selection that still equals the last preselection, or a session that never selected any, is replaced: a selection the user changed is kept. The service remembers the last preselection in memory, so after a restart a blank session's preselection counts as the user's. A session that started a turn is never rebound, so its selection is untouched; when the preselection fails, the binding stands and a warning is logged. It refuses while signed out with `hub-account/signed-out`, an id the tenant lacks with `assistants/not-found`, and a session that already started a turn with `assistants/locked`. Subagent sessions bind no assistant. The `assistant` Session projection carries the bound id to the client's session summaries.

Every main session gets the `assistant:core-files` prompt section at order `ASSISTANT_CORE_FILES`, after the deployment persona. Before each turn step, an assembly listener in the session's scope reads the bound assistant's core files, renders them, and, when the text differs from the last record, appends `assistant/instructions` (`text`); the section carries the recorded text, so an edit made on disk reaches the model on the next step and every prompt is reconstructable from the session log. A core file deleted on disk contributes nothing; one that cannot be read fails the step. An assistant deleted, or not in the signed-in tenant, renders an empty text, as does one whose core files are all blank. Because every turn's system prompt stays in the conversation, a session that already carried core files then gets the `CORE_FILES_WITHDRAWN` text instead, telling the model that the earlier core files no longer apply; a session that never carried any gets no section. Assemblies outside a turn, such as an inspection, record nothing and use the last recorded text.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home; assistants live under `<dshHome>/assistants`. |
| `maxNameLength` | `32` | Longest assistant name, in characters. |
| `maxDescriptionLength` | `200` | Longest assistant description, in characters. |
| `maxAvatarLength` | `700000` | Largest uploaded avatar, as the length of its data URL. |
| `maxCoreFileLength` | `20000` | Longest core file `updateAssistant` saves, in characters; every turn carries the core files. |

-----

<a id="model-experience"></a>
## Model Experience

### Bound assistant's core files

#### What the model sees

A main session bound to an assistant whose core files are not all blank gets the `assistant:core-files` section after the deployment persona: the introduction below with the assistant's name, then each non-blank core file trimmed in a `<core_file name="…">` block, in the order `IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`. The text is literal; `{{…}}` in a core file is not interpolated. Unbound sessions and subagent sessions get no section. Once the bound assistant is deleted, leaves the signed-in tenant, or has every core file emptied, a session that already carried core files gets the withdrawal notice below instead; one that never carried any gets no section.

##### Section introduction

```markdown
You are the assistant "<name>". The user wrote the core files below to define your identity, personality, what you know about them, and how you work. They replace any earlier version in this conversation; follow them.
```

##### Withdrawal notice

```markdown
The core files given earlier in this conversation no longer apply: the assistant they defined is no longer available or no longer has them. Stop following their identity, personality, user information, and working method, including any required openings, signatures, or formats, and work as a general assistant.
```

#### Token effect

Conditional and retained: every request of a bound session carries the introduction and the core files' full text, about the size of the four files. Saving through `updateAssistant` caps each file at `maxCoreFileLength` characters; a file edited on disk has no cap.

#### KV Cache effect

Prefix-stable while the core files stay unchanged. Editing a core file, renaming the assistant, binding another assistant before the first turn, or deleting the assistant replaces the section at the next step and invalidates the cached prefix from that section on.

### Capability subsets

#### What the model sees

A session whose assistant sets a subset sees only the allowed Skills in its skill catalog, only the allowed connectors' Skills and CLIs, and the `knowledge_search` tool only over allowed knowledge bases. A session bound to an assistant whose knowledge subset names existing knowledge bases has them selected, so it is offered the `knowledge_search` tool from its first turn. A call that names the CLI of a connector left out is denied with the reason `dsh-connectors` documents; the catalog and tool texts belong to `dsh-tool-skill` and `dsh-knowledge-selection`.

#### Token effect

A shorter list shortens the skill catalog, and a knowledge subset that leaves none of the selection removes the search tool's schema. A knowledge subset that names existing knowledge bases adds the search tool's schema to the first request of a session bound to its assistant.

#### KV Cache effect

Changing a subset during a session appends a replacement skill catalog, or adds or removes the search tool, at the next step, invalidating the cached prefix from that point.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Persona shifts mid-session** — a core file edited during a session changes the model's behavior from the next step.
- **Project Skills are not offered** — `capabilityOptions()` reads Skills outside any project, so a project's own Skills cannot be named in a subset and are left out of a session whose Skills are limited.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
