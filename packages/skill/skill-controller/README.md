---
description: "Host Remote owner for the user-level skills installed on this machine: listing with enabled state, switching on and off, revealing, editing, and moving to the trash."
kind: "package-reference"
---
# Skill Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-skill-controller` exposes the generated `ctx.remote.installedSkills` namespace for the Desktop "installed skills" page. It lists the custom skills the user placed on this machine (sources `user-dsh`, `user-agents`, and `custom`), switches one on or off through `ctx.skills.setDisabled()`, reveals or edits its instruction file with the native file manager or text editor, and moves its folder (or flat file) to the platform trash.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile whose browser shows installed skills; it injects `skills`. `list()` reads the catalog through the default agent preset scope when `agentPresets` is mounted, otherwise through the global layer, with a working directory that has no project roots, so every user-level skill keeps its user source. Project-level, runtime, and bundled skills are never listed.

Every other method resolves the name against that same list first and fails with `installed-skills/not-found` for any other skill, so project and bundled skills cannot be toggled, revealed, or removed here. `setEnabled(name, enabled)` persists through the registry's `disabledSkills` setting and fails with `installed-skills/rejected` when the profile cannot be written. `reveal(name)` and `edit(name)` hand the instruction file to `revealNativePath` and `openNativeTextFile`. `uninstall(name)` moves `<name>/` (or the flat `<name>.md`) to `~/.Trash` on macOS, naming collisions `<name> 2`, `<name> 3`, … as Finder does, or to the recycle bin through PowerShell on Windows, and then clears the skill's disabled state; other platforms fail with `installed-skills/rejected`.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|

The package has no Config fields; the disabled list it edits belongs to [`@deepseek-ai/dsh-skill`](../skill/README.md).

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the skill registry: a skill switched off here leaves the model's skill catalog, and a removed skill disappears once the filesystem provider observes the deletion.

#### KV Cache effect

No direct effect; the skill catalog consumer appends a replacement catalog message when the visible set changes, as for any other catalog change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No trash on Linux** — `uninstall` refuses on Linux because the Desktop product ships for macOS and Windows only; a Linux Host would need the XDG trash layout.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The skill registry owns the catalog and the disabled list, while this package only projects user-level entries and file actions onto the wire.
