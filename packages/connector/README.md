---
description: "The connector group map: office platforms reached through their official CLIs, for users and maintainers navigating the group."
kind: "package-group"
---

# connector/ — office platform connectors

English | [中文](README.zh.md)

## Summary

The connector family links Desktop to the office platforms a company runs on — Feishu now, DingTalk next — through each platform's unmodified official CLI, installed by DSH at the version a release pins. Desktop renders it as the Connectors page.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`connectors/`](connectors/README.md) | The built-in connectors and the install state of their CLIs, over the `connectors` Remote | `ctx.connectors` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Connectors subsystem reference](../../docs/subsystems/connectors.md) — installing and storing the connector CLIs.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
