---
description: "MO WorkAI brand for the enterprise Desktop client: the 名流蓝 palette, the wordmark in the sidebar, and the branded boot page; for maintainers composing or changing the enterprise look."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-mo

English | [中文](README.zh.md)

## Summary

This package gives the MO WorkAI enterprise Desktop client its brand. Primary buttons, the send button, links, focus rings, and the active sidebar panel use 名流蓝 (`#2A55F9` light, `#5C7CFF` dark) and text uses the brand greys. The sidebar shows the MO wordmark (dark on the light theme) and the collapsed rail the app icon; the boot page shows the icon, **MO WorkAI**, and a hint in the user's language on navy; a blank new session offers configured quick tasks. It has no runtime state and does not affect model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The web-app bundle mounts this plugin only for the `desktop` profile with a configured user center (`DSH_HUB_ORIGIN`), the same condition as the Skill Hub account rows. That composition is the MO WorkAI product, so the palette is the product's for every tenant; a tenant's own logo and name come from ui-hub-account. Open-source Web and Desktop compositions do not mount it and keep the platform palette.

### What changes

| Surface | Light | Dark |
|---|---|---|
| Primary buttons (fill / hover) | `#2A55F9` / `#1E44E0` | `#5C7CFF` / `#7B95FF` |
| Send button, links, focus rings | accent ramp step 500 (`#2A55F9`) | accent ramp step 400 (`#5C7CFF`) |
| Active sidebar panel (fill / label) | `#E6ECFE` / `#2A55F9` | 18% `#5C7CFF` / `#A9BAFF` |
| Sidebar fill | `#F5F6F8` | platform value |
| Text primary / secondary / tertiary, ink | `#343434` / `#4D4D4D` / `#767676`, `#343434` | platform values |

The ink tokens (`--dsw-alias-brand-primary`, `--dsw-alias-brand-text`), which text and controls read as a foreground, take the primary text grey so the light palette has one primary ink. The dark palette darkens ramp steps 800/900 and lightens 500 so badges and info-button hovers stay at WCAG AA.

### Quick tasks

`quickTasks` lists the cards shown in the `conversation.hero.dock` slot under the composer of a blank new session, in order: `multi-publish`, `business-report`, `product-research`, `asset-organize`; a repeated id shows once. Each card's title, description, and prompt come from the `ui-brand-mo` dictionary in the UI language; a click puts the prompt in the draft and does not send it. `quickTaskAssistant` names the template of the assistant a click also picks for the new session through the [ui-assistants](../ui-assistants/README.md) `assistantPicker` service; the tasks need 电商管家's Skills, so the web-app bundle sets `ecommerce`. The prompt lands only after the pick binds, so it cannot be sent in the wrong mode; when the tenant has no assistant from the template (the earliest created one wins when several exist), the card fills nothing and says to create one on the Assistants page. A deployment without the assistants UI keeps the current pick, and the default empty value never changes it. The default is an empty list; the web-app bundle composes all four for enterprise Desktop. The cards show only while the draft has no text, reference, or attachment, so a click never replaces what the user entered, and they leave once the session is no longer blank. The cards need the locale registry and the settings forms; without them the theme and the sidebar brand still apply.

`defaultSessionGrouping` names the grouping the sidebar's Session list shows until the user picks one, set through the [ui-workspace](../ui-workspace/README.md) `uiWorkspace.setDefaultSessionGrouping` while both plugins are mounted: a built-in view (`workspace`, `workspace-tree`, `flat`) or a registered grouping's id such as `assistant` or `date`. The web-app bundle sets `assistant` for enterprise Desktop, because operators divide work by assistant rather than by folder. The default empty value keeps the sidebar's own default, and an id nothing provides shows the Workspace view. `sessionsPerGroup` (default 5, at least 1) is how many idle Sessions each sidebar group lists before **Show more**, set through `uiWorkspace.setSessionGroupLimit`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The browser half calls `ctx.theme.overrideTokens()` once inside `ctx.effect()`, so the layer exists for exactly the plugin lifetime and disappears on unload or HMR. It also occupies both sidebar brand slots: `sidebar.brand.name` with the wordmark ([`src/wordmark.ts`](src/wordmark.ts), decorative: the sidebar hides the brand row from assistive technology), which a `body:not([data-ds-dark-theme])` rule inverts to dark, and `sidebar.brand.mark` with the app icon on the collapsed rail only; the tenant does not change the row. The host half adds two rows to every index render through `webserver/index-inject`: the `__DSH_BOOT_BRAND__` global that the [boot page](../web/README.md) reads (icon, name, hint keyed by language), and a stylesheet that paints `[data-dsh-boot]` navy and declares the token table under `html body` and `html body[data-ds-dark-theme]`, which outrank the platform palette, so the first frame already uses the brand values the client layer later sets inline. The boot page picks the hint from `<html lang>`, which the [locale](../locale/README.md) host writes from an explicit language preference. The theme presenter writes the folded tokens as inline variables on `body`, which take precedence over the stylesheet palette in both color schemes. Replacing the platform accent ramp (`--dsw-static-deepseek-*`) recolors every alias that reads it; primary buttons read `--dsw-alias-button-primary-fill`, which the layer sets directly. The active sidebar panel reads `--dsw-specific-sidebar-panel-active` and `--dsw-specific-sidebar-panel-active-label`, which `ui-sidebar` falls back to its hover look when no theme sets them. The token table lives in [`src/client/tokens.ts`](src/client/tokens.ts) and the icon in [`src/mark.ts`](src/mark.ts); both faces read them.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-theme](../ui-theme/README.md) — owns the theme runtime and the override-layer contract.
- [ui-sidebar](../ui-sidebar/README.md) — reads the active-panel tokens.
- [ui-brand-official](../ui-brand-official/README.md) — the official brand occupants that enterprise Desktop leaves out.
- [web](../web/README.md) — the boot page that reads the injected brand.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package contributes browser presentation only and nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


- **Page layouts** — page headers, cards, and empty states keep their own components; this package changes colors, the mark, and the boot page only.
- **Fixed palette** — the values are the 名流 brand's; another enterprise brand needs its own token table.
- **Dark values are copies** — an override cannot defer to the stylesheet value it replaces, so dark values the brand keeps repeat the platform's current references and must follow later palette changes by hand.
- **Boot stylesheet lifetime** — the host's seeded palette stays in the served page until it reloads, so unloading only the browser half (HMR, a disabled row) keeps the brand colors until then.
- **Unchecked default grouping** — `defaultSessionGrouping` is not validated: groupings register at any time, so an id nothing provides (a typo, or a plugin left out of the composition) shows the Workspace view without a warning.
- **Inline artwork** — the app icon and the wordmark ship as data URIs in the host and client bundles (about 40 KB together); the wordmark is a downscaled copy of the Desktop welcome page's `mo-logo.png`, so a redesign updates both.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
