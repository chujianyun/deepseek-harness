# Glossary

English | [中文](glossary.zh.md)

Domain vocabulary for DeepSeek Harness uses one canonical term per concept. Terms link to their entries with standard Markdown anchors; implementation detail stays in package READMEs and Agent Notes.

## capability-seam

- **seam** — a *swappable capability* with three roles: a **Service Definition** (the Cordis `Service` that owns its `ctx.<key>` and vocabulary types — an abstract class such as `ShellExecutor`, or a concrete registry such as `WebRuntime`, never a TypeScript `interface`), one or more **Service Providers**, and one or more **Consumers** that inject the service. `packages/shell` is the canonical example: `dsh-shell` (Service Definition), `dsh-bash-local` / `dsh-bash-sandbox` (providers), and `dsh-tool-bash` (Consumer). Roles normally occupy separate packages when they evolve independently, but a package may own multiple roles when they are one concern (`dsh-user-approval` owns the approval seam's Service Definition and its concrete implementation in one package). The seam is the complete capability, never one role; reserve the term for that meaning and name a constituent by its role, class, service, contract, or extension point.

## agent-scope

- **scope** — the unit of per-agent registration: a contribution (tool, prompt section, variable, restriction, listener) is either *global* (visible to every agent) or *scoped* (owned by exactly one [scope key](#scope-key)). Two levels, flat: scoped registrations do not inherit down to subagents; subtree behavior is expressed with [lineage](#lineage) data, never scope structure.
- **scope key** — the opaque identity a scope is keyed by, compared by object identity. The harness convention: a live agent is the key of its own scope. <a id="scope-key"></a>
- **agent context (`agent.ctx`)** — the agent's scoped context; registrations through it are scope-visible AND scope-lifetime (one fact drives both), and listeners on it participate in that agent's scope-filtered dispatches. Registry-subject events may remain deliberately unfiltered under their own event contracts.
- **scope carrier** — the `thisArg` a scope-filtered dispatch carries (built by `scopeTarget`); its filter admits untagged listeners plus the subject's own. A *subject-less* carrier (no key) admits untagged listeners only.
- **scoped dispatch** — the rule: an event about one agent's activity dispatches with that agent's carrier. Events about a registry itself (a tool was added) are *registry-subject* and stay unfiltered.
- **shadowing** — most-specific-wins name resolution: a scoped tool/section/variable replaces its same-named global twin for that scope alone. The per-agent persona and per-agent tool-variant mechanism.
- **restriction / scope-local registration** — a restriction (`tools.restrict`) filters the GLOBAL tool set for one scope (compose by intersection); scope-local registrations are merged after that filter. A filtered-away global tool is absent from the prompt AND refuses execution, indistinguishably from a nonexistent one.
- **setup window** — the creation slot where a creator composes an agent's scoped world (`CreateAgentOptions.setup`): after the scope and agent object exist but before the agent or session is published, `agent/created` fires, or the first prompt is assembled. Setup registers; it never drives the agent.
- **lineage** — parent/child facts carried as data (`parentSession`, durable `delegationDepth`, runtime `subagentDepth`); never affects visibility. <a id="lineage"></a>

## goal

- **goal** — one durable completion objective attached to an existing session, with a revisioned `active` / `paused` / `blocked` / `complete` phase and a goal-round cap; `blocked` retains a policy code and explanation. A goal is state, not a scheduler or a separate conversation; the session log remains its source of truth.
- **goal round** — one continuation cycle admitted for the current goal. The same-session driver materializes a goal round as one goal-sourced [turn](#turn), which can contain zero or more steps; unrelated human turns in the same session do not consume the goal-round cap. <a id="goal-round"></a>
- **goal activation** — process-local permission for a continuation consumer to admit another goal round. Activation is either `armed` or `disarmed`; it is deliberately absent from durable replay, so resume and fork require a later human-authorized resume mutation through `/goal` or the model tool before automatic work.

## human command

- **human command** — a slash-prefixed instruction interpreted and executed by a human-facing adapter through `ctx.commands`, without becoming a model message. It is distinct from a model-facing tool and from shell command execution through `ctx.shell`.
- **command plane** — discovery, parsing, dispatch, cancellation, and result rendering owned by UI adapters and command plugins. Command output is UI state unless the handler separately mutates a durable domain.
- **goal command** — the `/goal` human command contributed by `dsh-command-goal`; it observes or mutates the current goal directly while the goal domain owns every durable, model-visible record.

## loop hierarchy

- **turn** — one drain of admitted input in a session, ending after the model and its tools stop or a terminal policy intervenes. <a id="turn"></a>
- **step** — one model request plus the tool executions caused by its response; a turn contains zero or more steps. <a id="step"></a>
- **round** — an outer policy iteration containing a turn, such as a [goal round](#goal-round) or one fresh-agent Ralph attempt. Round counters belong to that policy and do not count every turn in a session. <a id="round"></a>

## Ralph

- **Ralph loop** — one foreground fresh-agent workflow run toward an immutable objective. It is a model-facing tool policy composed from workflow and subagent primitives, not a same-session goal, agent-loop mode, scheduler, or generic workflow-script feature. <a id="ralph-loop"></a>
- **Ralph round** — one fresh child session in a [Ralph loop](#ralph-loop). The child receives no parent or prior-child conversation seed; the shared workspace and one bounded [Ralph handoff](#ralph-handoff) carry cross-round state. <a id="ralph-round"></a>
- **Ralph handoff** — the normalized bounded structured report passed from one continuing Ralph round to the next, containing status, summary, evidence, next steps, and blocker text. It supplements the shared workspace rather than replacing it as authority. <a id="ralph-handoff"></a>

## Skill Hub

- **Skill Hub** — the tenant-scoped Skill marketplace hosted by the external user center (new-dsh-ms). DSH browses and installs the Skills it is allowed to see there; DSH never owns Skill review, visibility, or publishing. <a id="skill-hub"></a>
- **hub sign-in** — the user-center sign-in that gates the whole application. One sign-in is bound to exactly one tenant employee profile; switching tenant is a fresh sign-in. It is independent of the model credentials (DeepSeek account or API key). _Avoid_: account, login (alone).
- **market Skill** — a Skill installed into the user's machine from the [Skill Hub](#skill-hub); it remembers which hub Skill and which version it came from, so DSH can offer an update when the hub's current version is newer. <a id="market-skill"></a>
- **custom Skill** — a user-level Skill the user placed on their machine themselves (user DSH or agents directory). Project-level, bundled, and deployment-configured custom-directory Skills are neither custom nor [market](#market-skill) Skills. <a id="custom-skill"></a>
- **disabled Skill** — an installed Skill the user switched off: its files stay in place, but it is absent from the model's catalog and cannot be invoked with `/name`. _Avoid_: uninstalled, hidden.

## knowledge base

- **knowledge base** — a named, local collection of [knowledge items](#knowledge-item) that the model can search during a conversation. It belongs to the tenant of the current [hub sign-in](#skill-hub): signing in to another tenant shows that tenant's knowledge bases. Each knowledge base is bound to exactly one [embedding model](#embedding-model); its retrieval is hybrid (vector plus keyword). _Avoid_: library, dataset, RAG. <a id="knowledge-base"></a>
- **knowledge item** — one source added to a knowledge base: an uploaded file (Word `.docx`, text, Markdown, PDF), a folder whose supported files become child items, a web page fetched by URL, or a note written in DSH. An item is split into chunks, and each chunk is embedded. <a id="knowledge-item"></a>
- **embedding model** — a model that turns text into vectors for a knowledge base: either the **local embedding model** that DSH downloads and runs on the machine, or an **API embedding model** served by a provider already configured under Settings → Models. Distinct from the chat model; DSH has no reranking model. <a id="embedding-model"></a>
- **rebuild** — re-chunking and re-embedding every item of a knowledge base in place, after its embedding model changes; the knowledge base cannot be searched until it finishes. Reprocessing every item after a chunking change is not a rebuild: each item's old chunks stay searchable until its new ones replace them. _Avoid_: restore (Cherry Studio's copy-into-a-new-base flow, which DSH does not use). <a id="rebuild"></a>
- **recall test** — a query run against one knowledge base from its page, showing the matched chunks and their scores so the user can judge the chunking and threshold settings; it never enters a session.
- **knowledge selection** — the knowledge bases the user ticked for one session in the composer; the model searches only those, through a search tool whose calls are recorded in the session. <a id="knowledge-selection"></a>

## Connectors

- **connector** — a built-in link from DSH to one office platform (DingTalk, Feishu, or WeCom) through that platform's official CLI and the Skills it ships, so the model can act there as the signed-in user. The CLI program is shared by the machine; the platform sign-in belongs to the tenant of the current [hub sign-in](#skill-hub). An installed, connected connector is available in every session unless the user switches it off. _Avoid_: integration, plugin, channel, MCP server. <a id="connector"></a>
- **connector status** — what a connector card shows: green when it is installed, signed in, and its last health check passed; yellow when it is signed in but something is wrong (a token refresh failed, the check timed out, the network is unreachable); red when it is installed but not signed in, disconnected by the user, or its sign-in expired and must be redone. A connector that is not installed shows `+` instead of a status; installing or signing in shows progress, not a color. <a id="connector-status"></a>

## Assistants

- **assistant** — a named role the user creates: it has a name, an avatar, and its own [core files](#assistant-core-files), takes one Agent preset as its capability base, and may carry only some of the Skills, [connectors](#connector), and [knowledge bases](#knowledge-base). A session binds one assistant when it is created and cannot switch afterwards; switching assistants means starting a new session. It is neither the runtime agent instance nor a Cordis configuration profile. _Avoid_: role, persona, profile. <a id="assistant"></a>
- **core files** — the Markdown files that define who an [assistant](#assistant) is: identity (IDENTITY), soul (SOUL), user information (USER), and working method (AGENTS). The user can view and edit them directly. <a id="assistant-core-files"></a>
- **assistant template** — an optional starting point when creating an [assistant](#assistant), with its core files and capability choices filled in. Two templates are built in, Daily Assistant and E-commerce Manager; the user can also start blank. <a id="assistant-template"></a>

## E-commerce accounts

- **e-commerce account** — one e-commerce platform account the user signs in to in DSH, either a [merchant account](#merchant-account) or a [buyer account](#buyer-account). Each e-commerce account uses its own Google Chrome browser data, which keeps the sign-in itself; DSH never stores a password or cookie. A store's main account and a sub-account are two e-commerce accounts. An e-commerce account belongs to the tenant of the current [hub sign-in](#skill-hub). It is not a [connector](#connector): a connector reaches an office platform through its official CLI, while an e-commerce account signs in to an e-commerce platform through a browser. _Avoid_: store account, store, platform account. <a id="ecommerce-account"></a>
- **merchant account** — an [e-commerce account](#ecommerce-account) that can enter a store's back office; it has a store name and is used to read that store's own business data. A merchant account is never used to scrape public product pages, so the store's back-office account is not put at risk of platform risk control. <a id="merchant-account"></a>
- **buyer account** — an [e-commerce account](#ecommerce-account) with an ordinary buyer identity, used only to view public product pages. DSH limits how many pages each buyer account opens per day and cools it down for a while after platform risk control; when there are several buyer accounts, DSH picks an available one. <a id="buyer-account"></a>
