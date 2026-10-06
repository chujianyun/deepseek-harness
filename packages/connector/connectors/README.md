---
description: "Desktop connectors: office platforms reached through their official CLIs, installed at the versions a release pins, and the connectors Remote."
kind: "package-reference"
---
# Connectors

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-connectors` owns the built-in [connectors](../../../docs/glossary.md#connector), as the Host service `ctx.connectors` and the `connectors` Remote namespace. A connector reaches an office platform through that platform's unmodified official CLI; this package lists the connectors, installs and uninstalls their CLIs, and signs the current Hub tenant in to the platform and checks that connection. Feishu installs [`lark-cli`](https://github.com/larksuite/cli); DingTalk is listed as coming soon. Why connectors use the official CLIs is recorded in the [connectors Agent Note](../../../.agents/notes/proposed/feature/2026-10-06-connectors-over-official-clis.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in the Desktop profile beside `hub-account`, `skill`, and `shell-env`, which it injects. The web-app bundle enables it for the `desktop` profile with a configured user center, beside the knowledge bases, and `ui-connectors` renders its page.

`getState()` and `watch()` return one view per connector, Feishu then DingTalk, with its status: `coming-soon` while DSH does not support it, `unsupported` when its CLI has no build for this platform, `not-installed`, `installing`, and, once its CLI is installed, the current tenant's [connection status](../../../docs/glossary.md#connector-status) — `disconnected` (red), `connecting`, `connected` (green), or `degraded` (yellow). A view carries the CLI name and the version this release installs, download progress while installing, the reason the last install failed, the sign-in under way, the reason the last sign-in failed, the signed-in account's name, and the reason the connection is degraded.

`installConnector(id)` installs the connector's CLI in the background and returns at once; installing an installed or installing connector changes nothing. The install downloads this platform's archive of the pinned version from the configured mirrors in order (npmmirror's binary mirror, then GitHub releases, as the CLI's own npm installer does), resuming a partial download and verifying size and sha256 through [`dsh-verified-download`](../../util/verified-download/README.md). It unpacks only the executable beside the version directory, runs it with `--version` and requires the pinned version in the output, and then renames it to `<dshHome>/connectors/<id>/<version>/`. A failed install leaves the connector `not-installed` with `error` set to `network` (no mirror served the archive), `verification` (the archive is not the pinned one), `storage` (it could not be written or has no executable), or `launch` (the executable did not run or reported another version); installing again clears it. One CLI serves every tenant of the machine, nothing is installed globally, and a CLI the user installed themselves — on `PATH` or with its own configuration directory — is never read or changed.

The connection belongs to the tenant of the current [Hub sign-in](../../../docs/glossary.md#skill-hub). Every CLI run for a tenant gets that tenant's own configuration, data, and log directories under `<dshHome>/connectors/<id>/tenants/<tenantId>/` (for Feishu `LARKSUITE_CLI_CONFIG_DIR`, `LARKSUITE_CLI_DATA_DIR`, and `LARKSUITE_CLI_LOG_DIR`) and none of the caller's `LARKSUITE_CLI_*`, `OPENCLAW_HOME`, or `HERMES_HOME` variables, so the user's own `~/.lark-cli` is never read or changed. Each tenant creates its own Feishu app, so the tokens and app secret lark-cli keeps in the system keychain, keyed by app, never mix either.

`connect(id)` starts the current tenant's sign-in in the background and returns at once; a sign-in under way or a connected connector changes nothing. For Feishu it follows lark-cli's agent flow: a tenant without an app first runs `config init --new`, where the user creates the app in the browser, then `auth login --recommend --json`, where the user authorizes their own identity. While a step waits, the view's `login` carries the step, the address the CLI printed, and a QR code of it drawn by `auth qrcode`. When the user finishes, a health check decides the connection; a step that fails sets `loginError` with the step and the CLI's message (an app the platform refused to create reads as `create-app`). `cancelConnect(id)` ends the step's process. A failed or cancelled sign-in that created the tenant's app runs `config remove` and deletes the tenant's directory, so nothing half done remains; a sign-in that only authorizes keeps the existing app.

A health check runs `auth status --json --verify`, which asks the server whether the user's token still works: `ready` or `needs_refresh` is `connected` with the user's name, `missing` and an unconfigured tenant are `disconnected`, and anything else — `verify_failed`, `error`, output that cannot be read, or a CLI that does not run — is `degraded` with the reason. Checks run for every installed connector at startup, after an install, when the tenant changes, every `checkIntervalMs`, and on `check()`, which the Connectors page calls when it opens; a check that a sign-in, disconnect, or tenant switch overtook is dropped. Signing in to another tenant stops a sign-in under way and shows that tenant's own connection.

While a connector is installed and switched on for the current tenant, the model shell finds a `lark-cli` script in `<dshHome>/connectors/<id>/bin/<tenantId>/`, which this package puts ahead of `PATH` through `ctx.shellEnv.registerPath()`. Connected or degraded, the script drops the caller's lark-cli variables and runs the installed CLI with the tenant's configuration and data directories, so a command reaches DSH's CLI and the tenant's sign-in rather than a CLI or `~/.lark-cli` the user set up; its logs go under the system temporary directory, which a sandboxed model shell may write. Disconnected, the script refuses with a message that asks the user to connect on the Connectors page. When a command fails, the script adds that the Connectors page may help, and the service, which observes `tools/result`, runs a health check after any bash call of `lark-cli` that failed. The script is rewritten whenever the tenant, the connection, or the switch changes.

Before a bash call runs, the service's `tools/pre-execute` listener reads what the call does through a connected, switched-on Feishu connector. It splits the command into words and separators and finds each `lark-cli` invocation; its risk is the `Risk:` line of `lark-cli <command> --help` (`read`, `write`, or `high-risk-write`), read once per command. `--help`, `--version`, `--dry-run`, or no arguments read. A command without a stated risk, an argument built from a variable, and a command that hides its lark-cli call — command substitution, `eval`, `sh -c`, `xargs` — count as `unknown` and are confirmed like a write. A call that only reads runs unasked; any other returns `ask` with the commands as the audit reason and a localized `displayReason`, so the user approves it once in the approval panel, and a rejection reaches the model as the tool's denial. A `high-risk-write` call's reason opens with a ⚠️ warning; once the user allows it, the model shell gets `DSH_CONNECTOR_CONFIRMED` for that call only, naming its high-risk commands one per line, and the `lark-cli` script adds `--yes` to an invocation of those commands unless already present; the call's other lark-cli invocations run unchanged. The call's `tools/result` ends that approval. Another listener's denial or ask stands unchanged.

While a connector is connected or degraded and switched on, the Skills its CLI embeds reach the model through `ctx.skills`, from the `connectors` provider with source `connector-<id>` and rank 350 — ahead of the user's own Skill directories, so a stale copy there never shadows the Skill matching the installed CLI, and behind project Skills. The provider is registered with `everyLayer`, so this order also holds inside an agent preset that discovers local Skills in its own layer. The list comes from `skills list`, read once per CLI version, and a Skill's instructions from `skills read <name>` without its frontmatter; its files are read with `lark-cli skills read <name> <path>`. Each view lists the installed CLI's Skills for the card. `setEnabled(id, enabled)` switches a connector on or off for the current tenant in the volatile `disabled` list, through the Settings service: off, the connector stays signed in, but the model gets neither its Skills nor its CLI, and a user's own `lark-cli` is left as it is.

`disconnect(id)` stops a sign-in under way, runs `config remove`, which clears the tenant's app configuration and tokens, keychain entries included, and deletes the tenant's directory; the CLI stays. `uninstallConnector(id)` stops a running install or sign-in, runs `config remove` for every tenant on the machine, and deletes `<dshHome>/connectors/<id>`, downloads included. Every method refuses an unknown id with `connectors/not-found` and a connector that is coming soon or unsupported here with `connectors/unavailable`; `connect` also refuses a connector that is not installed with `connectors/not-installed`, and `connect` and `disconnect` refuse while signed out of the Hub with `hub-account/signed-out`.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home; connector CLIs live under `<dshHome>/connectors`. |
| `feishu` | `lark-cli` 1.0.97 | The Feishu CLI: `binary`, `version`, `mirrors` (URL templates with `{version}` and `{file}`), and one `archives` entry per platform with its `file`, `size`, and `sha256`. |
| `checkIntervalMs` | `1800000` (30 minutes) | Time between periodic health checks of the connections. |
| `disabled` | `[]` | Connectors switched off, as `<tenantId>/<id>`; volatile, written by `setEnabled()`. |

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the skill registry and the bash tool: a connected, switched-on connector's Skills join the model's skill catalog, and its `lark-cli` runs in bash; disconnecting or switching it off takes the Skills out of the catalog. The script adds one of two lines to a command's stderr, which the bash result carries: `DSH: the Feishu connector is not connected for this company. Ask the user to connect Feishu on the DSH Connectors page (连接器), then try again.` when it refuses, and `DSH: lark-cli exited with status <n>. If signing in to Feishu or a missing permission is the cause, ask the user to check the Feishu connector on the DSH Connectors page (连接器).` after a failed command. A Feishu command that writes stops for the user's approval first; a rejection reaches the model as the tool's denial, `Error: the user rejected tool "bash"`.

#### KV Cache effect

No direct effect; the skill catalog consumer appends a replacement catalog message when the connector's Skills join or leave, as for any other Skill switched on or off.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No separate high-risk style** — the approval panel shows a high-risk command like any other approval; only the ⚠️ text of its reason sets it apart.
- **Approval is per call** — every writing call asks again; there is no "always allow" for a connector command.
- **Sandboxed writes** — in a sandboxed model shell, a lark-cli command that writes into the tenant's configuration or data directory (outside the writable roots) is refused, and the model is offered the sandbox's escalation; commands that only read and log are unaffected.
- **Bash only, POSIX only** — the `lark-cli` script is a POSIX shell script on `PATH` for `dsh-tool-bash`; PowerShell and Windows get no script.
- **No install cancel** — a running install stops only through uninstalling.
- **One app per tenant member** — the Feishu sign-in creates a self-built app per tenant on this machine; a company that forbids employees to create apps cannot connect until an administrator-provided tenant app is supported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The service is the only owner of each connector's install state, which it derives from its own directory at startup, and of the connection, which it reads from the CLI's own `auth status` on every check, so there is no second observation that could diverge.
