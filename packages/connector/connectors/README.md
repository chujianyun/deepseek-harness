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

Mount this package as a Loader entry in the Desktop profile beside `hub-account`, which it injects. The web-app bundle enables it for the `desktop` profile with a configured user center, beside the knowledge bases, and `ui-connectors` renders its page.

`getState()` and `watch()` return one view per connector, Feishu then DingTalk, with its status: `coming-soon` while DSH does not support it, `unsupported` when its CLI has no build for this platform, `not-installed`, `installing`, and, once its CLI is installed, the current tenant's [connection status](../../../docs/glossary.md#connector-status) — `disconnected` (red), `connecting`, `connected` (green), or `degraded` (yellow). A view carries the CLI name and the version this release installs, download progress while installing, the reason the last install failed, the sign-in under way, the reason the last sign-in failed, the signed-in account's name, and the reason the connection is degraded.

`installConnector(id)` installs the connector's CLI in the background and returns at once; installing an installed or installing connector changes nothing. The install downloads this platform's archive of the pinned version from the configured mirrors in order (npmmirror's binary mirror, then GitHub releases, as the CLI's own npm installer does), resuming a partial download and verifying size and sha256 through [`dsh-verified-download`](../../util/verified-download/README.md). It unpacks only the executable beside the version directory, runs it with `--version` and requires the pinned version in the output, and then renames it to `<dshHome>/connectors/<id>/<version>/`. A failed install leaves the connector `not-installed` with `error` set to `network` (no mirror served the archive), `verification` (the archive is not the pinned one), `storage` (it could not be written or has no executable), or `launch` (the executable did not run or reported another version); installing again clears it. One CLI serves every tenant of the machine, nothing is installed globally, and a CLI the user installed themselves — on `PATH` or with its own configuration directory — is never read or changed.

The connection belongs to the tenant of the current [Hub sign-in](../../../docs/glossary.md#skill-hub). Every CLI run for a tenant gets that tenant's own configuration, data, and log directories under `<dshHome>/connectors/<id>/tenants/<tenantId>/` (for Feishu `LARKSUITE_CLI_CONFIG_DIR`, `LARKSUITE_CLI_DATA_DIR`, and `LARKSUITE_CLI_LOG_DIR`) and none of the caller's `LARKSUITE_CLI_*`, `OPENCLAW_HOME`, or `HERMES_HOME` variables, so the user's own `~/.lark-cli` is never read or changed. Each tenant creates its own Feishu app, so the tokens and app secret lark-cli keeps in the system keychain, keyed by app, never mix either.

`connect(id)` starts the current tenant's sign-in in the background and returns at once; a sign-in under way or a connected connector changes nothing. For Feishu it follows lark-cli's agent flow: a tenant without an app first runs `config init --new`, where the user creates the app in the browser, then `auth login --recommend --json`, where the user authorizes their own identity. While a step waits, the view's `login` carries the step, the address the CLI printed, and a QR code of it drawn by `auth qrcode`. When the user finishes, a health check decides the connection; a step that fails sets `loginError` with the step and the CLI's message (an app the platform refused to create reads as `create-app`). `cancelConnect(id)` ends the step's process. A failed or cancelled sign-in that created the tenant's app runs `config remove` and deletes the tenant's directory, so nothing half done remains; a sign-in that only authorizes keeps the existing app.

A health check runs `auth status --json --verify`, which asks the server whether the user's token still works: `ready` or `needs_refresh` is `connected` with the user's name, `missing` and an unconfigured tenant are `disconnected`, and anything else — `verify_failed`, `error`, output that cannot be read, or a CLI that does not run — is `degraded` with the reason. Checks run for every installed connector at startup, after an install, when the tenant changes, every `checkIntervalMs`, and on `check()`, which the Connectors page calls when it opens; a check that a sign-in, disconnect, or tenant switch overtook is dropped. Signing in to another tenant stops a sign-in under way and shows that tenant's own connection.

`disconnect(id)` stops a sign-in under way, runs `config remove`, which clears the tenant's app configuration and tokens, keychain entries included, and deletes the tenant's directory; the CLI stays. `uninstallConnector(id)` stops a running install or sign-in, runs `config remove` for every tenant on the machine, and deletes `<dshHome>/connectors/<id>`, downloads included. Every method refuses an unknown id with `connectors/not-found` and a connector that is coming soon or unsupported here with `connectors/unavailable`; `connect` also refuses a connector that is not installed with `connectors/not-installed`, and `connect` and `disconnect` refuse while signed out of the Hub with `hub-account/signed-out`.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home; connector CLIs live under `<dshHome>/connectors`. |
| `feishu` | `lark-cli` 1.0.97 | The Feishu CLI: `binary`, `version`, `mirrors` (URL templates with `{version}` and `{file}`), and one `archives` entry per platform with its `file`, `size`, and `sha256`. |
| `checkIntervalMs` | `1800000` (30 minutes) | Time between periodic health checks of the connections. |

-----

<a id="model-experience"></a>
## Model Experience

None, as installing a connector's CLI and signing in add nothing to model requests.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Not in conversations yet** — a connected connector's Skills do not reach the model until conversations use connectors.
- **No install cancel** — a running install stops only through uninstalling.
- **One app per tenant member** — the Feishu sign-in creates a self-built app per tenant on this machine; a company that forbids employees to create apps cannot connect until an administrator-provided tenant app is supported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The service is the only owner of each connector's install state, which it derives from its own directory at startup, and of the connection, which it reads from the CLI's own `auth status` on every check, so there is no second observation that could diverge.
