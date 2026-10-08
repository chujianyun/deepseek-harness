---
description: "ecommerce 分组导航：通过系统 Google Chrome 登录的电商平台账号，供浏览本分组的用户与维护者阅读。"
kind: "package-group"
---

# ecommerce/ — 电商账号

[English](README.md) | 中文

## 概述

ecommerce 家族通过用户在系统 Google Chrome 中登录的账号，把桌面版连到公司经营的电商平台（天猫、淘宝、拼多多和抖店），每个账号一份浏览器数据目录。Desktop 将其呈现为设置中的电商账号分区。本家族还包含天猫取数技能：由租户上传到 Skill Hub，用这些账号读取店铺数据。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`ecommerce-accounts/`](ecommerce-accounts/README.zh.md) | 租户的电商账号及其 Chrome 登录，通过 `ecommerceAccounts` Remote 提供 | `ctx.ecommerceAccounts` |
| [`tmall-skills/`](tmall-skills/README.zh.md) | 上传到 Skill Hub、只下发给需要的租户的天猫取数技能（商家报表与买家单品报告），及其打包 | — |

-----

<a id="related-documentation"></a>
## 相关文档

- [电商账号子系统参考](../../docs/subsystems/ecommerce-accounts.zh.md) — 账号登录态的登录、检查与保持。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
