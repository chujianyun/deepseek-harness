---
description: "The ecommerce group map: e-commerce platform accounts signed in through the system Google Chrome, for users and maintainers navigating the group."
kind: "package-group"
---

# ecommerce/ — e-commerce accounts

English | [中文](README.zh.md)

## Summary

The ecommerce family links Desktop to the e-commerce platforms a company sells on — Tmall, Taobao, Pinduoduo, and Douyin shops — through accounts the user signs in to in the system Google Chrome, one browser data directory per account. Desktop renders it as the E-commerce accounts section of Settings. The family also holds the Tmall data skills that a tenant uploads to the Skill Hub, which read store data with those accounts.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`ecommerce-accounts/`](ecommerce-accounts/README.md) | The tenant's e-commerce accounts and their Chrome sign-ins, over the `ecommerceAccounts` Remote | `ctx.ecommerceAccounts` |
| [`tmall-skills/`](tmall-skills/README.md) | Tmall data skills uploaded to the Skill Hub for the tenants that need them, and their packaging | — |

-----

<a id="related-documentation"></a>
## Related documentation

- [E-commerce accounts subsystem reference](../../docs/subsystems/ecommerce-accounts.md) — signing in, checking, and keeping account sign-ins.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
