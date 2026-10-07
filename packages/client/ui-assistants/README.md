---
description: "Assistants page and new-session picker of the dsh Desktop client: the sidebar entry, the assistant cards, and the picker that binds a new session to an assistant, over the assistants Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-assistants

English | [中文](README.zh.md)

## Summary

The Desktop surfaces of the [assistants](../../../docs/glossary.md#assistant): the **Assistants** entry of the sidebar, the page it opens with the signed-in tenant's assistants as cards, and the picker that leads the new-session screen's workspace row. Both render the [`assistants`](../../assistant/assistants/README.md) Remote's state stream.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `assistants` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. The plugin contributes only in the Desktop renderer (`dshDesktop` present). It injects `remote.assistants` and, once `sessions` and `uiWorkspace` are present, registers the page into the `main` keyed slot as `assistants`, adds the entry to `sidebar.panellist` at order 8, below Connectors, and fills `conversation.hero.assistant`.

The page shows a search box with the number of assistants and one card per assistant: its avatar — a colored disc with the name's first character — its name with a **Default** tag on the tenant default, its description (**No description** when empty), and a **Chat** button. The search matches names and descriptions. Signed out, the page says to sign in to the user center; a tenant without assistants reads **No assistants yet.**

The picker shows the assistant of the session about to start: a pick not yet bound, else the one the main view's blank session is bound to, else the tenant default. Its menu lists every assistant with its avatar and description. A pick binds the blank session the main view shows through `assistants.select()`; without one, the pick waits and binds the blank session the next session-list change brings. **Chat** on a card picks that assistant and opens the new-session screen through `uiWorkspace.startSession()`, so the session it brings starts bound to it. The picker renders nothing outside the main view or when the tenant has no assistants. A refused bind shows as a toast above the composer and as a message above the cards until dismissed.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-assistants`](../../assistant/assistants/README.md#model-experience): a pick binds the session to an assistant, whose core files that service adds to the system prompt.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Preset avatars only** — every assistant draws a preset disc; uploaded images follow with the creation wizard.
- **No management actions** — creating, editing, copying, deleting, and setting the default follow in later tickets.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The page and the picker render the Host's state stream and the session list, and keep only a pick waiting for a blank session.
