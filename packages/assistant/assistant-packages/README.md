---
description: "Assistant packages: install the assistants a tenant administrator published on the user center, with the Skills they name, and switch their recommended scheduled tasks on and off."
kind: "package-reference"
---
# Assistant Packages

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-assistant-packages` installs company assistant packages on Desktop. A tenant administrator publishes a package on the user center: `agent.json` (name, version, avatar, Agent preset, Skill and connector subsets, recommended scheduled tasks) and the four core files. The `assistantPackages` Remote lists the packages the signed-in employee's company offers, installs one as an assistant through the [assistants](../assistants/README.md) service with the Skills it names from the company's Skill Hub, updates it to a newer version without overwriting the user's edits, and switches each recommended task on as an [automation task](../../schedule/automation-tasks/README.md) or off again.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry beside the assistants; it injects `hubAccount` and `assistants`, and reads `skillMarket`, `automationTasks`, and `schedule` with `ctx.get` when an operation needs them. The web-app bundle enables it for Desktop with a configured user center. Config: `dshHome`, `maxPackageBytes` (largest download, default 2 MiB), and `defaultAvatar` (avatar key of a package that names none, default `sun`).

`getState()` returns the signed-in tenant, the packages the user center lists for it (`GET /api/client/agent-packages`, read with the Skill Hub's `skills:read` scope; null with `unavailable: true` when the list cannot be read), and the assistants installed from packages here, each with its recommended tasks and whether they run. `installPackage(packageId)` downloads the current version, refuses bytes whose size or sha256 differs from the listing or an archive holding anything but `agent.json` and the four core files (`assistant-packages/invalid`), installs each named Skill that is neither installed nor a same-name Skill the user placed on this machine (one the Skill Hub does not offer is reported as missing), creates the assistant with the package's name, description, avatar, preset, and subsets, writes the core files, and records the install under `<dshHome>/assistant-packages/<tenantId>/installs.json`. A failure after the assistant exists deletes it. Installing a package already installed here updates that assistant instead.

`updatePackage(assistantId)` moves an install to the package's current version. A core file or profile field (name, description, avatar, preset, subsets) whose current value still equals what the package last wrote takes the new version's; one the user changed is kept, and kept files are returned. `enableTask(assistantId, taskId, workspaceId)` creates the task as an automation task bound to the assistant, with its timing in its time zone, its permission preset, and its connector grant; `disableTask(assistantId, taskId)` deletes that schedule and keeps its Session. A task whose schedule was deleted elsewhere reads as switched off; a switched-on task a new version no longer recommends, and every task of an assistant the user deleted, is switched off, so no schedule keeps running without an off switch. A named Skill that is not on the Skill Hub, or whose install fails, is reported missing while the others still install; a deployment without the Skill market reports every named Skill missing. A listed package this build cannot read is left out of the list with a warning. Refusals: `hub-account/signed-out`, `assistant-packages/not-found`, `assistant-packages/unavailable` (user center or automation tasks), `assistant-packages/not-installed`, `assistant-packages/task-not-found`, and the assistants and automation-task refusals unchanged.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the assistants service and automation tasks: an installed package writes an assistant's core files and subsets, which [reach the model as the assistant's](../assistants/README.md#model-experience), and a switched-on task is an ordinary automation task whose [schedule](../../schedule/schedule/README.md#model-experience) delivers its instruction.

#### KV Cache effect

No direct effect; an update that changes core files changes the assistant's prompt section from the next turn, as editing them does.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Running tasks keep their definition** — after an update changes a switched-on task, the task keeps its earlier timing and instruction and reads as outdated until the user switches it off and on.
- **Installs are per machine** — the install record lives on this machine; another machine of the same employee installs the package again.
- **No uninstall of Skills** — deleting the assistant leaves the Skills it installed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
