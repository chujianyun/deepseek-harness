# Agent Note: Assistants layered over Agent presets

Status: proposed

English | [中文](2026-10-07-assistants-over-agent-presets.zh.md)

## Problem

Desktop users want named working roles, the way Accio Work offers "agents": a daily assistant, an e-commerce manager, each with its own avatar, personality, model, and the Skills, connectors, and knowledge bases it works with. DSH already has the engine pieces (Agent presets choose tools, prompts, and Skills; `dsh-persona` gives one agent its own system-prompt persona), but nothing a user can create, name, edit, and pick when starting a session. How such a role relates to presets, and where its definition lives, decides whether the two mechanisms fight over the same choices and whether the definition can later be shared, exported, or written back by the model.

## Proposal

An [assistant](../../../../docs/glossary.md#assistant) sits **on top of** an Agent preset: it names one preset as its capability base and adds who it is and what it carries.

- **The preset still owns tools.** The assistant chooses a preset (standard, minimal, PTC, …) and never toggles individual tools, so tool selection stays in one mechanism.
- **Core files define who it is.** Each assistant has four Markdown [core files](../../../../docs/glossary.md#assistant-core-files): identity, soul, user information, and working method. They reach the model through the persona mechanism scoped to that session's agent, and are read again for every turn, so an edit takes effect on the next turn.
- **Capability subsets.** Skills, connectors, and knowledge bases each follow either "all (follow global)" or "only selected"; a selected item that is later uninstalled simply drops out.
- **One directory per assistant, per tenant.** An assistant is a directory holding its configuration and core files, kept under the tenant of the current [hub sign-in](../../../../docs/glossary.md#skill-hub), because the connectors and knowledge bases it carries already belong to that tenant.
- **Bound at session creation.** A session binds one assistant when it is created and never switches; a deleted assistant leaves its sessions readable and usable without a persona.
- **Templates are starting points.** Daily Assistant and E-commerce Manager are built in as [assistant templates](../../../../docs/glossary.md#assistant-template); the first launch creates a default assistant from Daily Assistant.

## Alternatives considered

### Why not replace Agent presets with assistants?

Presets are declarative Cordis compositions that profiles, the creator mode, and the Web preset picker already depend on. Replacing them would rewrite a working mechanism to add identity, which is a separate concern.

### Why not generate one preset per assistant?

A generated preset would duplicate the base preset's plugin rows for every assistant, and every later change to that base would have to be propagated into each copy. Referencing the base keeps one source of truth for tools.

### Why not store assistants in the profile configuration?

Configuration entries suit short values, not several pages of Markdown the user edits. Plain files per assistant are readable and editable outside DSH, and they are the shape that later export and import, team sharing, and memory written back by the model need.

## Acceptance criteria

- A session created with an assistant sends that assistant's core files as its persona and only the Skills, connectors, and knowledge bases its subsets allow.
- Editing a core file changes the persona from the next turn of an open session.
- An assistant created in one tenant is not visible after signing in to another tenant.

## Risks

- **Persona changes mid-session.** Because core files are read every turn, an edit made during a session shifts the model's behavior abruptly.
- **Silent capability loss.** An uninstalled item in an "only selected" subset disappears without an error; the detail page has to mark it.
- **Persona shadows the deployment persona.** The assistant's persona replaces the deployment-level persona for that session, so deployment branding text that lives there must also reach assistants some other way.
