---
description: "Automation tasks: create a task in one call — a named Session with its assistant, model, permission, and connector grant, and the Host schedule bound to it."
kind: "package-reference"
---
# Automation Tasks

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-automation-tasks` creates an automation task the way the Automation tasks form describes it. The `automationTasks` Remote's `create(request)` makes a new Session in the chosen workspace, names it after the task, binds the requested assistant, model, permission preset, and connector grant, and stores the [Host schedule](../schedule/README.md) that sends the task's instruction to that Session at each run. A step that fails archives the new Session, so a refused task leaves nothing behind.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry beside the schedule; it injects `sessionController`, `schedule`, and `workspaceRegistry`, and reads `assistants`, `connectors`, and `permissionPresets` with `ctx.get` only when a request asks for them. The web-app bundle enables it for Desktop with a configured user center, where those services run.

`create(request)` takes the task's `title` (also the Session's name) and `prompt`, an optional `workspaceId` (the default workspace when omitted), an optional `assistantId`, `model` (installed for the Session without changing the default), `permission` preset, and `connectors` list, the `timing` as a schedule timing choice (`at`, `every`, `daily`, `weekly`, or `cron`), and optional effective dates in `window`. It runs the steps in this order: create the Session, rename it, resume its Agent, select the assistant, install the model, set the permission preset, grant the connectors through `connectors.allowInSession()`, and create the schedule. It returns the `sessionId` and the stored schedule `record`.

Asking for an assistant, connectors, or a permission preset where that service is not mounted refuses with `automation-tasks/unavailable` (`field`) before any Session exists. Once the Session exists, any failure archives it through `workspaceRegistry.archiveSession()` with `stopActivity`, then rejects: a Schedule input error as `automation-tasks/invalid` with its Schedule `code` and message, a model the Session cannot use as `automation-tasks/model-unavailable`, and every other step's error unchanged, such as `assistants/not-found` or `connectors/not-found`. A failed archive is logged and the original error still reaches the caller.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package adds nothing to model requests itself; the created Session is an ordinary Session whose assistant, model, and permission preset shape its turns as in any other Session, and [the schedule](../schedule/README.md#model-experience) delivers the instruction.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Create only** — editing a task's Session settings afterwards happens in that Session; the Automation tasks detail edits the name, instruction, and timing.
- **Rollback archives** — a refused task's Session is archived rather than deleted, so it stays among archived Sessions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
