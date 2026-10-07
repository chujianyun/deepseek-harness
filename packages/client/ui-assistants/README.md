---
description: "Assistants page and new-session picker of the dsh Desktop client: the sidebar entry, the assistant cards, and the picker that binds a new session to an assistant, over the assistants Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-assistants

English | [中文](README.zh.md)

## Summary

The Desktop surfaces of the [assistants](../../../docs/glossary.md#assistant): the **Assistants** entry of the sidebar, the page it opens with the signed-in tenant's assistants as cards and each assistant's detail page, and the picker that leads the new-session screen's workspace row. Both render the [`assistants`](../../assistant/assistants/README.md) Remote's state stream.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `assistants` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. The plugin contributes only in the Desktop renderer (`dshDesktop` present). It injects `remote.assistants` and, once `sessions` and `uiWorkspace` are present, registers the page into the `main` keyed slot as `assistants`, adds the entry to `sidebar.panellist` at order 8, below Connectors, and fills `conversation.hero.assistant`.

The page shows a search box with the number of assistants and one card per assistant: its avatar — a colored disc with the name's first character — its name with a **Default** tag on the tenant default, its description (**No description** when empty), and the buttons **Make default** (absent on the default), **Duplicate**, **Delete**, and **Chat**. The search matches names and descriptions. Signed out, the page says to sign in to the user center; a tenant without assistants reads **No assistants yet.**

**New assistant** in the header opens the creation wizard, five steps with **Back** and **Next**: the start — the Daily Assistant or E-commerce Manager template, or blank; identity and model — name (1 to 32 characters, checked before **Next**), avatar, description, and model; the capability base — an Agent preset from `agentPresets.list()` or the default; the capability subsets; and what to call the user, preferred language, notes, and background. A template fills in the name, description, and avatar. The avatar is one of sixteen preset discs, eight at a time with **Shuffle**, or an uploaded PNG, JPG, or WebP image, which the browser crops to its centered square, scales to 256 pixels, and encodes as WebP; another file type is refused. The model list comes from `session.modelCatalog()`, defaults to **Follow global**, and offers the chosen model's reasoning efforts starting at its default. **Create** calls `assistants.createAssistant()`; the wizard closes on success and shows the Host's refusal otherwise. Models and presets a Remote cannot supply are left out.

Clicking a card's avatar, name, or description opens its detail page, read through `assistants.getAssistant()`, with **Back to assistants** above a header that repeats the card's buttons. The page edits the identity and model fields, the capability base, and the capability subsets as the wizard does, and the four core files in tabs — Identity, Personality, About you, and Working method — each a plain-text editor. A model or preset the deployment no longer offers shows as unavailable. **Save** sends only the changed fields through `assistants.updateAssistant()` and reads the stored assistant back, since renaming rewrites the identity file; **Discard changes** restores the saved values, and both stay disabled until something changes. **Duplicate** opens the copy's page. **Delete** on a card or the detail page asks for confirmation, naming the assistant and how many started sessions in the session list are bound to it, then calls `assistants.deleteAssistant()`; an open detail page of a deleted assistant returns to the list. A refused action shows as a message above the cards or under the detail header until dismissed.

The capability subsets show Skills, Connectors, and Knowledge bases, each **All (follow global)** or **Only selected**; Only selected lists what `assistants.capabilityOptions()` offers now as checkboxes, connectors named Feishu and DingTalk. An id the assistant allows that is no longer offered — uninstalled, switched off, or deleted — stays checked with an **Unavailable** tag, so it can be cleared. A template fills in its subsets, so the E-commerce Manager starts with only Feishu among the connectors; the detail page saves a subset only when the allowed items changed, whatever their order.

The picker shows the assistant of the session about to start: a pick not yet bound, else the one the main view's blank session is bound to, else the tenant default. Its menu lists every assistant with its avatar and description. A pick binds the blank session the main view shows through `assistants.select()`; without one, the pick waits and binds the blank session the next session-list change brings. **Chat** on a card picks that assistant and opens the new-session screen through `uiWorkspace.startSession()`, so the session it brings starts bound to it. The picker renders nothing outside the main view or when the tenant has no assistants. A refused bind shows as a toast above the composer and as a message above the cards until dismissed.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-assistants`](../../assistant/assistants/README.md#model-experience): a pick binds the session to an assistant, whose core files that service adds to the system prompt.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **No recent sessions on the detail page** — the detail page lists none of the assistant's sessions; showing the assistant on sessions follows in a later ticket.
- **Session count from the loaded list** — the delete confirmation counts the sessions the session list holds, whose assistant comes from the projection cache for sessions not open.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The page and the picker render the Host's state stream and the session list, and keep only a pick waiting for a blank session.
