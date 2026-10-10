---
description: "Add automation task form of the dsh Desktop client: New on the Automation tasks page opens it in place, and Save creates the task's Session and schedule."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-automation-tasks

English | [中文](README.zh.md)

## Summary

Occupies the [Automation tasks page](../ui-schedule/README.md)'s `schedule.task.form` slot, so **New** opens the **Automation / Add automation task** form in place of the list instead of starting a Session. The form takes the task's name, workspace, prompt with its assistant, model, and permission, connectors, frequency, and effective dates; **Save** creates the task through the [`automationTasks` Remote](../../schedule/automation-tasks/README.md), which makes the task's Session and schedule together.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `automation-tasks` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. The plugin injects `slots`, `locale`, `workspaces`, and the `automationTasks`, `assistants`, `session`, `permissionPresets`, and `connectors` Remotes, and registers the form in `schedule.task.form` for exactly the plugin lifetime.

When the form opens it reads, once, the tenant's assistants, the model catalog, the permission presets (without `custom` and the current-Session `auto`), and the connectors connected for the signed-in tenant; a read that fails offers nothing from it. The fields are, in order: a dismissible notice that tasks run only while the computer and MO WorkAI stay on; **Name** (required, at most 120 characters); **Workspace**, the Session's workspace, starting with the first in sidebar order and falling back to it when the chosen one goes, with the automatic default workspace under its localized name; **Prompt** (required), with a row of selects for the assistant (**General mode** by default), the model (**Default model** by default), and the permission preset (the deployment's default; a built-in preset still named by its value reads localized, and **Full access** applies only after the same risk acknowledgement the composer asks for, since the task runs unattended); **Connectors**, a checkbox per connected connector, granting it for the task's Session; **Frequency**, as **Recurring** (every day, weekdays, or chosen days of the week at a time), **Interval** (every whole number of minutes or hours), or **Once** (a date and time); and **Effective dates**, an optional start and end date. Times and dates are read in the browser's zone.

**Cancel** and **Save** sit on a bar at the bottom of the page. Save checks the fields first and shows each problem under its field, which editing that field clears; a refused save shows the Host's reason under the matching field — a timing refusal blames the effective dates only when they are set — or, for any other refusal, the Host's message above the buttons, and keeps everything entered. Both buttons are disabled while saving. A created task returns to the list, which selects it once the catalog lists it; Cancel returns without one.

-----

<a id="model-experience"></a>
## Model Experience

None, as the form only collects a task the Host composer creates; the created Session runs like any other.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Create only** — an existing task's assistant, model, permission, connectors, and effective dates are not edited here; the task detail edits its name, instruction, and timing.
- **Native date and time controls** — the frequency and date fields use the browser's own inputs rather than the task detail's pickers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
