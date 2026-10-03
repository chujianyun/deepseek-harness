---
description: "Desktop Skills page for the dsh web client: the skills installed on this machine as cards, switched on and off, chatted with, edited, revealed, or uninstalled."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skills

English | [中文](README.zh.md)

## Summary

The Skills page adds a **Skills** entry to the sidebar and opens the installed skills of this machine in the main column. Custom skills appear as cards with a name initial, the name, a two-line description, an on/off switch, and an actions menu: chat with it, edit, open folder, and uninstall after a confirmation. It reads and acts through the [`installedSkills` Remote](../../skill/skill-controller/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `skill-controller` row; the web-app bundle enables both only for the `desktop` profile. The page injects `remote.installedSkills`, `uiWorkspace`, `sessions`, and `conversation`, registers into the root `main` keyed slot under the panel id `skills`, and adds its icon to `sidebar.panellist` at order 5.

The page reads the list each time it mounts and shows twelve cards per "load more" step. A switch moves at once and returns to its previous position when the Host refuses; while one skill's action is in flight its switch and menu stay disabled. A refused action shows its message above the groups until the next action or a dismissal. An uninstalled card leaves only after the Host confirms the move to the trash. "Chat with it" starts a New Session in the Workspace the sidebar's New Session would use and writes `/<name> ` into its draft without sending; with no Workspace at all, the blank New Session page opens without a draft. A disabled skill cannot start a chat.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the skill registry: switching a skill off here removes it from the model's skill catalog, and "chat with it" only prepares a draft the user still sends.

#### KV Cache effect

No direct effect; catalog changes reach the model through the skill catalog consumer's replacement message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Custom skills only** — the page lists the user-level skills on this machine; the Skill Hub market grid, market-installed skills, and uploading arrive with later tickets (#29, #30, #31).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The page keeps no state that another observation could contradict; the Host catalog is the only source.
