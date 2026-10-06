---
description: "Connectors page of the dsh Desktop client: the sidebar entry and the connector cards that install their CLIs."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-connectors

English | [中文](README.zh.md)

## Summary

Adds a **Connectors** entry to the Desktop sidebar, below Knowledge, and the page it opens: one card per built-in [connector](../../../docs/glossary.md#connector), with its install control or [connection status](../../../docs/glossary.md#connector-status) in the top-right corner, and the sign-in dialog. It reads and acts through the [`connectors` Remote](../../connector/connectors/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `connectors` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. The plugin contributes only in the Desktop renderer (`dshDesktop` present). It injects `remote.connectors`, registers the page into the `main` keyed slot as `connectors`, and adds the entry to `sidebar.panellist` at order 7.

Each card shows the platform's name, what its official CLI gives access to, and the CLI with the version this release installs. The top-right corner shows `+` while the CLI is not installed and a spinner while it installs (with a progress bar and the downloaded percentage, then **Checking…** once every byte arrived). A connector DSH does not support yet reads **Coming soon**, and one whose CLI has no build for this system reads **Not available on this system**; neither offers `+`. After a failed install the card says why — the download sources were unreachable, the download failed verification, the install folder could not be written, or the CLI did not run — and offers `+` again.

Once installed, the corner shows the current tenant's connection: a red dot with **Not connected** and a **Connect** button, a spinner with **Connecting**, a green dot with **Connected** and the signed-in account below, or a yellow dot with **Problem** and the reason below. The **⋯** menu offers **Connect** (or **Reconnect** when degraded), **Check again** and **Disconnect** while signed in, and **Uninstall**. Next to the menu, a switch turns the connector on or off for conversations in the current company; switched off, the card dims and says the model does not use the platform while the sign-in stays. Once the CLI is installed, the card lists the Skills it adds — eight names, then **N more** — with each description as its tooltip. Disconnecting and uninstalling ask for confirmation: disconnecting deletes the sign-in DSH keeps for the current company and keeps the CLI; uninstalling also removes every company's sign-in, and a CLI the user installed themselves is not affected. Opening the page checks every connection.

Connecting opens the sign-in dialog, which shows the two Feishu steps — creating the Feishu app, then authorizing the account — with the current one marked, a spinner until the CLI reports the step's address, then its QR code, an **Open in browser** button, and the address. The page opens each step's address in the system browser once, for a sign-in it started. **Cancel connecting**, the close button, and Escape cancel the sign-in; the dialog closes by itself when the sign-in ends. A failed step is explained on the card: an app that could not be created points to the administrator, and an unfinished authorization asks to connect again. Card state comes only from the streamed state; an action's answer only reports a refusal, shown above the cards until dismissed.

-----

<a id="model-experience"></a>
## Model Experience

None, as the page only installs connector CLIs and signs in to their platforms.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Closing the sign-in dialog cancels it** — the dialog cannot be hidden while a sign-in continues in the background.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The page renders the Host's state stream and keeps only the confirmation being asked, the in-flight actions, and the sign-in addresses it already opened.
