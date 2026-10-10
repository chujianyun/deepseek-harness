---
description: "MO WorkAI brand theme for the enterprise Desktop client: the 名流蓝 accent and brand greys layered over the platform palette; for maintainers composing or changing the enterprise look."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-mo

English | [中文](README.zh.md)

## Summary

This package gives the MO WorkAI enterprise Desktop client the 名流 brand palette. While it is mounted, primary buttons, the composer's send button, links, focus rings, and the active sidebar panel use 名流蓝 (`#2A55F9` light, `#5C7CFF` dark), and body text uses the brand greys. It changes colors only through a theme token layer; it has no runtime state and does not affect model requests.

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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The browser half calls `ctx.theme.overrideTokens()` once inside `ctx.effect()`, so the layer exists for exactly the plugin lifetime and disappears on unload or HMR. The theme presenter writes the folded tokens as inline variables on `body`, which take precedence over the stylesheet palette in both color schemes. Replacing the platform accent ramp (`--dsw-static-deepseek-*`) recolors every alias that reads it; primary buttons read `--dsw-alias-button-primary-fill`, which the layer sets directly. The active sidebar panel reads `--dsw-specific-sidebar-panel-active` and `--dsw-specific-sidebar-panel-active-label`, which `ui-sidebar` falls back to its hover look when no theme sets them. The token table lives in [`src/client/tokens.ts`](src/client/tokens.ts); the node half is an empty Loader seat.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-theme](../ui-theme/README.md) — owns the theme runtime and the override-layer contract.
- [ui-sidebar](../ui-sidebar/README.md) — reads the active-panel tokens.
- [ui-brand-official](../ui-brand-official/README.md) — the official brand occupants that enterprise Desktop leaves out.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package contributes browser presentation only and nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


- **Colors only** — the sidebar mark, the boot screen, and page layouts are outside this package's token layer.
- **Fixed palette** — the values are the 名流 brand's; another enterprise brand needs its own token table.
- **Dark values are copies** — an override cannot defer to the stylesheet value it replaces, so dark values the brand keeps repeat the platform's current references and must follow later palette changes by hand.
- **First paint** — the layer applies once the client plugins load, so the boot frame shows the platform palette for a moment.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
