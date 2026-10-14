---
description: "The ecommerce group map: e-commerce platform accounts signed in through the system Google Chrome, for users and maintainers navigating the group."
kind: "package-group"
---

# ecommerce/ — e-commerce accounts

English | [中文](README.zh.md)

## Summary

The ecommerce family links Desktop to the e-commerce platforms a company sells on — Tmall, Taobao, Pinduoduo, Douyin shops, and Tmall Health Brand Yuntai — through accounts the user signs in to in the system Google Chrome, one browser data directory per account. Desktop renders it as the E-commerce accounts section of Settings. The family also holds the Tmall skills that a tenant uploads to the Skill Hub, which read store data and publish rules with those accounts.

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
| [`mingliu-skills/`](mingliu-skills/README.md) | 名流's operations skills (department AI inspection and its monthly configuration, advertising ROI inspection, 拼多多 meeting to-do sync, video performance report) uploaded to 名流's Skill Hub only, the recommended tasks of its operations assistant, and their packaging | — |
| [`tmall-skills/`](tmall-skills/README.md) | Tmall skills (merchant reports, publish categories and field rules, the buyer item report, product drafts from material folders, and publishing them to Tmall warehouses and Pinduoduo and Douyin shop 草稿箱, one store or several) uploaded to the Skill Hub for the tenants that need them, and their packaging | — |

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
