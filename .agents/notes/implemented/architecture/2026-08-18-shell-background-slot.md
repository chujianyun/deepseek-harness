# Agent Note: frame-wide shell background slot

Status: implemented

English | [中文](2026-08-18-shell-background-slot.zh.md)

## Problem

Visual plugins need a supported way to render a continuous background behind the sidebar, conversation, and details columns. Registering into a column fragments the image, while DOM injection depends on private markup and cannot participate in normal plugin disposal. Theme token overrides can make surfaces translucent, but they cannot own an image or another rendered background.

The shell must preserve its existing appearance when no background plugin is installed. A background contribution must also stay below column content and interaction affordances, and removing its plugin must restore that fallback without coordinating with the layout or theme implementations.

## Decision

`ui-layout` declares `shell.background` as a root-scoped `single` slot in the same registration that owns AppFrame. AppFrame renders the slot once in an absolutely positioned, frame-filling layer before the three columns. The layer has no pointer events. Sidebar, conversation, and details render above it; drag handles remain above the columns; `shell.overlay` remains the highest frame layer.

The slot owns only rendered background content. AppFrame retains its existing `--dsw-alias-bg-base` background, so an empty slot has no visual effect. The ordinary slot lifecycle removes the contribution when its plugin or the AppFrame declaration is disposed. The fallback becomes visible immediately, with no DOM cleanup protocol and no theme mutation from `ui-layout`.

Because the slot is `single`, installing a second background provider replaces the first provider's render authority rather than composing two backgrounds. A provider that also changes surface transparency owns those theme overrides separately and must dispose them through its own plugin lifecycle.

## Alternatives considered

**Inject background elements into AppFrame DOM.** This depends on private selectors and ordering, bypasses the slot ownership ledger, and makes reload and disposal cleanup provider-specific.

**Represent the background only with theme tokens.** Tokens can control colors and translucent surfaces, but they cannot render an image, preserve image loading state, or expose ordinary React lifecycle behavior.

**Add one background slot per column.** Separate occupants cannot guarantee a continuous image across changing column widths and would duplicate loading, positioning, and disposal work.

**Use a list slot.** Stacking independent full-frame backgrounds makes opacity and ownership order ambiguous. One provider is the complete background authority; additional visual layers belong inside that provider or in `shell.overlay` when they are foreground UI.

## Consequences

Background plugins gain a stable render location without access to AppFrame internals. Empty and disposed states preserve the shipped theme exactly, and pointer input continues to reach the columns and shell controls. The slot's single-occupant rule prevents accidental background stacking and makes provider replacement deterministic.

The shell now carries one additional absolute layer and public slot key. Background providers that make the native surfaces translucent must coordinate their own rendered background and theme override lifecycles; the layout package intentionally does not infer or apply transparency.

## Verification

The `ui-layout` apply spec asserts the root-scoped single declaration and its removal with the owning fiber. The AppFrame spec asserts that the background layer is rendered before the columns and below `shell.overlay`; existing layout interaction specs continue to exercise drag handles and column behavior with the new layer present.
