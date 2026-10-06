---
description: "Desktop connectors: office platforms reached through their official CLIs, installed at the versions a release pins, and the connectors Remote."
kind: "package-reference"
---
# Connectors

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-connectors` owns the built-in [connectors](../../../docs/glossary.md#connector), as the Host service `ctx.connectors` and the `connectors` Remote namespace. A connector reaches an office platform through that platform's unmodified official CLI; this package lists the connectors and installs and uninstalls their CLIs. Feishu installs [`lark-cli`](https://github.com/larksuite/cli); DingTalk is listed as coming soon. Why connectors use the official CLIs is recorded in the [connectors Agent Note](../../../.agents/notes/proposed/feature/2026-10-06-connectors-over-official-clis.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in the Desktop profile. The web-app bundle enables it for the `desktop` profile with a configured user center, beside the knowledge bases, and `ui-connectors` renders its page.

`getState()` and `watch()` return one view per connector, Feishu then DingTalk, with its status: `coming-soon` while DSH does not support it, `unsupported` when its CLI has no build for this platform, `not-installed`, `installing`, or `disconnected` once its CLI is installed and no platform account is signed in. A view carries the CLI name and the version this release installs, download progress while installing, and the reason the last install failed.

`installConnector(id)` installs the connector's CLI in the background and returns at once; installing an installed or installing connector changes nothing. The install downloads this platform's archive of the pinned version from the configured mirrors in order (npmmirror's binary mirror, then GitHub releases, as the CLI's own npm installer does), resuming a partial download and verifying size and sha256 through [`dsh-verified-download`](../../util/verified-download/README.md). It unpacks only the executable beside the version directory, runs it with `--version` and requires the pinned version in the output, and then renames it to `<dshHome>/connectors/<id>/<version>/`. A failed install leaves the connector `not-installed` with `error` set to `network` (no mirror served the archive), `verification` (the archive is not the pinned one), `storage` (it could not be written or has no executable), or `launch` (the executable did not run or reported another version); installing again clears it. One CLI serves every tenant of the machine, nothing is installed globally, and a CLI the user installed themselves — on `PATH` or with its own configuration directory — is never read or changed.

`uninstallConnector(id)` stops a running install and deletes `<dshHome>/connectors/<id>`, downloads included. Both methods refuse an unknown id with `connectors/not-found`, and a connector that is coming soon or unsupported here with `connectors/unavailable`.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home; connector CLIs live under `<dshHome>/connectors`. |
| `feishu` | `lark-cli` 1.0.97 | The Feishu CLI: `binary`, `version`, `mirrors` (URL templates with `{version}` and `{file}`), and one `archives` entry per platform with its `file`, `size`, and `sha256`. |

-----

<a id="model-experience"></a>
## Model Experience

None, as installing a connector's CLI adds nothing to model requests.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No sign-in yet** — an installed connector stays `disconnected`; platform sign-in, connection status, and use in conversations come next.
- **No cancel** — a running install stops only through uninstalling.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The service is the only owner of each connector's install state, which it derives from its own directory at startup, so there is no second observation that could diverge.
