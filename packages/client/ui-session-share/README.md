---
description: "Share session action of the dsh Desktop client: a Session row menu item and the dialog that makes, copies, updates, and withdraws the Session's share link."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-share

English | [中文](README.zh.md)

## Summary

Adds **Share session** to a Session row's menu in the [sidebar](../ui-workspace/README.md) and the dialog it opens. The dialog reads the Session's share through the [`sessionShare` Remote](../../session-query/session-share/README.md), creates the link that signed-in members of the same company can open, copies it, updates the shared content, and stops the share.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `session-share` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. The plugin injects `slots`, `locale`, and the `hubAccount` and `sessionShare` Remotes. For exactly the plugin lifetime it registers the `share` entry of `sidebar.workspaces.session.menu.item` at order 350, between Fork and Archive, and the `session-share` entry of `shell.overlay`.

The menu row shows only while the `hubAccount` state stream reports a sign-in. Selecting it closes the menu and opens the dialog for that Session, named by the title the sidebar shows (**Untitled** for an unnamed Session); that title is also the title the share carries.

The dialog states who can open the link and that the share is the conversation as it is now, without attachment files. It first reads the Session's share:

- **Not shared** — **Create link** uploads the snapshot and shows the link.
- **Shared** — the link sits in a read-only field that selects itself on focus, with **Copy link** and the time the content was last updated. **Update content** uploads the conversation as it is now under the same link, **Stop sharing** withdraws the share and returns to the not-shared state, and **Done** closes the dialog.

While a call is in flight the buttons are disabled, a status line names it, and the dialog cannot be closed. A refusal shows under the link in the UI language: no sign-in, a Session without conversation, a conversation over the user center's size limits, the user center's own reason for any other refusal, or an unreachable server. The dialog then keeps its state, so the user can try again.

-----

<a id="model-experience"></a>
## Model Experience

None, as the dialog only calls the Host's share service; nothing here reaches a model request.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Menu only** — the action is in the row menu; a Session row has no share hover button, and search-result rows have no menu.
- **No shared mark** — the sidebar does not mark Sessions that are shared; the dialog is where the state shows.
- **Blank Sessions are refused in the dialog** — the row also shows for a Session without conversation, and **Create link** then says it cannot be shared.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
