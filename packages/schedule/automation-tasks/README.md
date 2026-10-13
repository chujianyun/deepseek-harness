---
description: "Automation tasks: create a task in one call — a named Session with its assistant, model, permission, and connector grant, and the Host schedule bound to it."
kind: "package-reference"
---
# Automation Tasks

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-automation-tasks` creates an automation task the way the Automation tasks form describes it. The `automationTasks` Remote's `create(request)` makes a new Session in the chosen workspace, names it after the task, binds the requested assistant, model, permission preset, connector grant, and declared operations, and stores the [Host schedule](../schedule/README.md) that sends the task's instruction to that Session at each run. A failed step archives the new Session. In a scheduled run nobody answers approvals: a call that would ask runs when it is a declared operation and is refused otherwise, and each answer is logged.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry beside the schedule; it injects `sessionController`, `schedule`, `workspaceRegistry`, and `sessionProjections`, and reads `assistants`, `connectors`, and `permissionPresets` with `ctx.get` only when a request asks for them. The web-app bundle enables it for Desktop with a configured user center, where those services run.

`create(request)` takes the task's `title` (also the Session's name) and `prompt`, the `workspaceId` the Session is filed under, an optional `assistantId`, `model` (installed for the Session without changing the default), `permission` preset, `connectors` list, and `operations` its scheduled runs may run without asking, the `timing` as a schedule timing choice (`at`, `every`, `daily`, `weekly`, or `cron`), and optional effective dates in `window`. It first checks everything it can without a Session: the schedule's `validate()` with the same request and window, and that the permission preset is one the catalog offers (not `custom`). It then runs the steps in this order, with a Session id it generates: create the Session in the workspace, rename it, resume its Agent, select the assistant, install the model, set the permission preset, grant the connectors through `connectors.allowInSession()`, record the declared operations as `automation-tasks/operations`, and create the schedule. It returns the `sessionId` and the stored schedule `record`.

Asking for an assistant, connectors, or a permission preset where that service is not mounted refuses with `automation-tasks/unavailable` (`field`), a Schedule input error with `automation-tasks/invalid` and its Schedule `code`, an unknown preset with `automation-tasks/invalid` and code `unknown_permission`, and a refused declaration with `automation-tasks/invalid` and code `too_many`, `too_long`, or `shell_character`, all before any Session exists. Once creation starts, any failure, including one inside creation after the Session exists, archives the generated id through `workspaceRegistry.archiveSession()` with `stopActivity`, then rejects: a Schedule input error as `automation-tasks/invalid` with its Schedule `code` and message, a model the Session cannot use as `automation-tasks/model-unavailable`, and every other step's error unchanged, such as `assistants/not-found` or `connectors/not-found`. A failed archive is logged and the original error still reaches the caller.

An operation is a command's first words, such as `lark-cli im +messages-send` or `dsh-ecommerce browser`. `readOperations()` (also at the browser-safe `@deepseek-ai/dsh-automation-tasks/operations`) trims each entry, joins its words with one space, and drops blanks and repeats; it refuses more than 50 operations, one longer than 200 characters, a word holding a character a shell gives a meaning, and (`not_declarable`) an operation without a command after its program or whose program runs other commands (`RUNNERS`: shells, `env`, `sudo`, `timeout`, `find`, `xargs`, interpreters such as `node` and `python`). The `automationUnattended` Session projection folds the latest declaration and marks a turn whose first user message the schedule sent, until a person writes in it or `turn/end`; a turn a person opened asks as usual, also when a schedule message joins it.

In a scheduled turn, the outermost `tools/pre-execute` listener (registered with `prepend`) sees the decision every other gate reached. An `allow` or `deny` stands; an `ask` becomes `allow` when the call is a bash or PowerShell command whose every simple command starts with an operation's program by its bare name followed by the operation's other words, none built from a variable, and `deny` otherwise, with a refusal that names the declared operations; the words after them are free. `readCommand()` splits the command reading only single and double quotes, a backslash escape in bash, whitespace, `;`, `|`, `&&`, `||`, and output redirections; a comment, `$'…'` quoting, command or process substitution, a backtick, input redirection or a here-document, a lone `&`, parentheses or braces, `!`, a line break, or an unclosed quote makes the command unreadable, and it never matches, nor does a path or a leading variable assignment in place of the program. An approval asked outside the tool gate in such a turn, such as running a command outside the sandbox, is answered first by a prepended `approval/request` listener with the same rule, which also refuses a redirection, and `rejected` for a call it has no command for. The answerer does not delegate in such a turn: nobody is there to answer, so it answers itself. Each answer appends `automation-tasks/unattended` (`callId`, `turn`, `command` cut to 500 characters, `allowed`, and the matched `operations`). Under the `never` approval policy the approval service rejects before any answerer, so only the tool gate's answers apply there.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Session and the tool gate: the created Session is an ordinary Session whose assistant, model, and permission preset shape its turns as in any other Session, and [the schedule](../schedule/README.md#model-experience) delivers the instruction. In a scheduled run, a call refused because it is not a declared operation reaches the model as the tool's denial, naming the declared operations: `This run of the automation task is unattended: nobody can approve this call, and it is not one of the operations the task may run without asking (it declares: …), so it was not run. Run each declared operation as a command of its own, or report that this step needs a person.` The answers themselves are log-only.

#### KV Cache effect

No effect: the refusal is an ordinary tool result appended after the cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Create only** — editing a task's Session settings afterwards happens in that Session; the Automation tasks detail edits the name, instruction, and timing.
- **Rollback archives** — a refused task's Session is archived rather than deleted, so it stays among archived Sessions; when even the archive fails, the error is logged and the Session, with any permission or connector grant already applied, stays live.
- **Shell commands only** — a declared operation matches a bash or PowerShell command; another tool's call that would ask is refused in a scheduled run, and a script's own subprocesses are not seen.
- **Session names are shorter** — the session-title service caps a name by bytes, so a long task name can show shortened in the Session list while the task keeps it whole.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
