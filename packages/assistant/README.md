---
description: "The assistant group map: named roles whose core files reach the model in the sessions bound to them, for users and maintainers navigating the group."
kind: "package-group"
---

# assistant/ — assistants

English | [中文](README.zh.md)

## Summary

The assistant family gives Desktop users named working roles: each tenant's assistants with their core files, and the binding of a session to one of them. Desktop renders it as the Assistants page and the new-session assistant picker.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`assistants/`](assistants/README.md) | Each tenant's assistants, their core files, and session binding, over the `assistants` Remote | `ctx.assistants` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Assistants subsystem reference](../../docs/subsystems/assistants.md) — storing assistants and carrying their core files into sessions.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
