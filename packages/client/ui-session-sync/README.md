---
description: "Conversations from other computers in the dsh Desktop client: a mark and a hover line on their Session rows and a view-only composer."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-sync

English | [中文](README.zh.md)

## Summary

Shows which conversations in the [sidebar](../ui-workspace/README.md) came from the employee's other computers, as pulled by the [`sessionSync` Remote](../../session-query/session-sync/README.md). Their rows carry a computer mark and name the computer in the hover card. An open one shows a view-only notice in place of the composer.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `session-sync` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. It adds nothing outside the Desktop window, since a browser tab has no Hub sign-in of its own. The plugin injects `slots`, `locale`, `sessions`, and the `sessionSync` Remote. For exactly the plugin lifetime it registers:

- `session-sync-badge` in `sidebar.session.row.badge` (order 20): a small computer mark on a pulled conversation's row, labelled **From another computer: {computer}**.
- `session-sync-hover` in `sidebar.session.row.hover` (order 6): the line **From another computer · {computer}** in the row's hover card.
- A `conversation.composer` chain entry at priority -5 that claims the composer of a pulled conversation and shows **Conversation from "{computer}"** with the note that it can be read here, not continued.

It follows the `sessionSync` state stream. When the state's `changes` count grows, it reloads the Session list, because the sync writes and removes logs without a list event, and reads the projections (title and assistant) of each new or newer pulled conversation from its log, since the Host's projection cache may not hold them yet. When the window regains focus or becomes visible, it calls `refresh()`, so the Host pulls the other computers' changes right away.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only marks rows and replaces the composer from the Host sync service; nothing here reaches a model request.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Row menu unchanged** — the row menu of a pulled conversation keeps its entries; the Host refuses renaming it, and forking makes an ordinary copy of this computer.
- **No continue action yet** — carrying a pulled conversation on as a new one is a later feature.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
