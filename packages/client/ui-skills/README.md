---
description: "Desktop Skills page for the dsh web client: the skills installed on this machine as cards, switched on and off, chatted with, edited, revealed, or uninstalled."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skills

English | [中文](README.zh.md)

## Summary

The **Skills** sidebar entry opens the Skill Hub market: cards with search, category tabs, and load more, a detail dialog with the rendered SKILL.md and file list, and one-click install through the [`skillMarket` Remote](../../skill/skill-market/README.md). **Installed (N)** shows this machine's skills in two groups, custom and from the market, as cards with a name initial, the name (a market Skill shows its Hub display name with the slug beside it), a two-line description, a pin button, an on/off switch, and an actions menu: chat with it, edit, open folder, and uninstall after a confirmation. It reads and acts through the [`installedSkills` Remote](../../skill/skill-controller/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `skill-controller` row; the web-app bundle enables both only for the `desktop` profile. The page injects `remote.installedSkills`, `remote.skillMarket`, `uiWorkspace`, `sessions`, and `conversation` (and calls `remote.directoryPicker` for **Choose folder…**, which fails over to the typed path when that Remote is absent), registers into the root `main` keyed slot under the panel id `skills`, and adds its icon to `sidebar.panellist` at order 5.

The market reads its categories and first page (twelve cards) each time it opens, together with the installed count; a search (Enter in the search box, beside the compact category tabs) or category tab reads page 1 again and "load more" appends the next page. Cards and the detail show the Skill's display name; the detail also lists its slug. A card's avatar takes a fixed tint per category. A card's **Install** installs the Skill; an installed Skill shows **Installed vX** in the success colour instead, and a Skill whose name a custom Skill already uses cannot be installed and says so. The detail dialog renders SKILL.md without its frontmatter as untrusted Markdown (raw HTML stays text) and installs the same way. An installed Skill with a newer Hub version shows **Update to vX** instead of its version, and its card under "from the market" shows the update with an **Update** button, **Withdrawn** with its switch locked when the platform withdrew it from the tenant (it can still be uninstalled; after the Hub check that runs when the page opens, the list is read again without the loading state, so a withdrawal or its end shows at once), or **No longer in the market** when the Hub no longer offers it for another reason. When an update would overwrite local edits, a dialog lists the edited files and updates only after **Overwrite and update**. A refused install shows its message until the next action or a dismissal.

**Add skill** in the market header opens the upload dialog. It offers the user's custom Skills, a typed folder path, and **Choose folder…**; reading a folder shows its name, description, folder, and file count and size, or the reasons it cannot be uploaded. A new Skill takes a required display name (up to 40 characters with a counter; a missing, over-long, or invisible-character name shows why and keeps **Upload** disabled), a version (prefilled `1.0.0`), a visibility (whole tenant, chosen departments, chosen employees, or only the uploader) and an optional category; a Skill the employee already owns on the Hub is uploaded as its next version (prefilled with the next patch version) and keeps its display name. After the upload the dialog shows **Submitted for review** with the review link and a copy button, or **Published** when the Hub published it at once, in which case the market reads its list again. The Hub's reason for a refused upload is shown verbatim. The local Skill stays as it was, in the custom group.

The installed view reads its list, and the market's status of each installed market Skill, each time it opens and shows twelve cards per "load more" step in each group. A switch moves at once and returns to its previous position when the Host refuses; while one skill's action is in flight its switch and menu stay disabled. A refused action shows its message above the groups until the next action or a dismissal. An uninstalled card leaves only after the Host confirms the move to the trash. A pin button on each card puts it first in its group (the most recently pinned first); pins are kept in this window's browser storage, so they stay on this machine, and a user Skill and a market Skill of the same name are pinned apart. **Manage in bulk** adds a checkbox to every card and a toolbar with select all, the selected count, **Enable**, **Disable**, **Uninstall** (after one confirmation naming the count), and **Done**; the actions run one skill after another through the same Remote calls, enabling skips withdrawn Skills, uninstalled skills leave the selection, and the skills the Host refused are named above the groups. "Chat with it" starts a New Session in the Workspace the sidebar's New Session would use and writes `/<name> ` into its draft without sending; with no Workspace at all, the blank New Session page opens without a draft. A disabled skill cannot start a chat.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the skill registry: switching a skill off here removes it from the model's skill catalog, and "chat with it" only prepares a draft the user still sends.

#### KV Cache effect

No direct effect; catalog changes reach the model through the skill catalog consumer's replacement message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The folder chooser is Desktop-only** — **Choose folder…** opens the native chooser; elsewhere the folder path is typed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The page keeps no state that another observation could contradict; the Host catalog is the only source.
