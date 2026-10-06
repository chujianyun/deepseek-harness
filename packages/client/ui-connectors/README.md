---
description: "Connectors page of the dsh Desktop client: the sidebar entry and the connector cards that install their CLIs."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-connectors

English | [中文](README.zh.md)

## Summary

Adds a **Connectors** entry to the Desktop sidebar, below Knowledge, and the page it opens: one card per built-in [connector](../../../docs/glossary.md#connector), with its install control or status in the top-right corner. It reads and acts through the [`connectors` Remote](../../connector/connectors/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `connectors` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. The plugin contributes only in the Desktop renderer (`dshDesktop` present). It injects `remote.connectors`, registers the page into the `main` keyed slot as `connectors`, and adds the entry to `sidebar.panellist` at order 7.

Each card shows the platform's name, what its official CLI gives access to, and the CLI with the version this release installs. The top-right corner shows `+` while the CLI is not installed, a spinner while it installs (with a progress bar and the downloaded percentage, then **Checking…** once every byte arrived), and a red dot with **Not connected** once it is installed. A connector DSH does not support yet reads **Coming soon**, and one whose CLI has no build for this system reads **Not available on this system**; neither offers `+`. After a failed install the card says why — the download sources were unreachable, the download failed verification, the install folder could not be written, or the CLI did not run — and offers `+` again. The installed card's **⋯** menu offers **Uninstall**, which asks for confirmation and states that a CLI the user installed themselves is not affected. Card state comes only from the streamed state; an action's answer only reports a refusal, shown above the cards until dismissed.

-----

<a id="model-experience"></a>
## Model Experience

None, as the page only installs and uninstalls connector CLIs.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No sign-in yet** — an installed connector shows **Not connected** until platform sign-in exists.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The page renders the Host's state stream and keeps only the connector being uninstalled and the in-flight actions.
