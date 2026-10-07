---
description: "dsh 桌面版设置中的电商账号分区：账号列表、新增账号，以及在 Google Chrome 中跟进登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-ecommerce-accounts

[English](README.md) | 中文

## 概述

在桌面版设置中添加**电商账号**分区：按平台分组的当前租户[电商账号](../../../docs/glossary.zh.md#ecommerce-account)、新增账号的表单、在 Google Chrome 中跟进登录的登录对话框，以及每个账号的详情。它通过 [`ecommerceAccounts` Remote](../../ecommerce/ecommerce-accounts/README.zh.md) 读取和操作。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把浏览器端条目挂载在 Host 端 `ecommerce-accounts` 条目旁边，并使用相同的 `disabled` 条件；web-app bundle 在配置了用户中心的 `desktop` profile 中同时启用两者。插件只在 Desktop 渲染进程中生效（存在 `dshDesktop`）。它注入 `remote.ecommerceAccounts`，在桌面版登录用户中心期间把分区以 `ecommerce-accounts` 注册到 `settings.section`，顺序为 -10，退出登录时移除。

打开分区会检查每个账号。没有账号时显示**添加第一个账号**按钮；否则账号按平台分在可折叠的分组中并显示数量，每行显示店铺名、账号、账号类型以及带颜色圆点的状态。搜索框按店铺名或账号筛选。Google Chrome 缺失或低于 DSH 所需版本时，列表上方的提示条会说明，并提供**前往下载**按钮。

**新增账号**打开一个表单，其说明文字指出本功能需要搭配 Google 浏览器使用。平台（天猫）和账号类型（商家账号）目前固定；店铺名和账号必填。**去登录**添加账号并打开其登录对话框；已添加过的账号会被拒绝并提示**当前账号已添加**。登录对话框说明已在 Google Chrome 中打开平台登录页，账号登录后会自动更新，并提供**我已完成登录**以立即检查；它会提示 Chrome 缺失或版本过低（附**前往下载**）、登录等待超时以及检查失败。

选中一个账号会打开其详情——平台、店铺名、账号、账号类型、登录状态、平台显示的账号和上次检查时间——并提供**重新登录**（或**去登录**）和**删除账号**；删除前会确认，并说明该账号的浏览器数据会一起删除。

-----

<a id="model-experience"></a>
## 模型体验

无，本分区只添加、登录和删除电商账号。

#### KV Cache 影响

无影响。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **只有一种平台与类型** — 平台和账号类型下拉框只提供天猫商家账号。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。本分区渲染 Host 的状态流，只保存当前打开的账号、打开的对话框和最近一次拒绝。
