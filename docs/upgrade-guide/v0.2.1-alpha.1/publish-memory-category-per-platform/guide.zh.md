---
kind: upgrade-guide
description: "电商发品记忆按平台分别保存产品线类目，记忆文件和 dsh-ecommerce 输出随之改变。"
---

# 发品记忆的类目按平台分开

[English](guide.md) | 中文

## 变更

`<dshHome>/ecommerce/<tenantId>/publish-memory.json` 和 `dsh-ecommerce memory` 输出的 JSON 里，`categories` 原来是「产品线 → 一个带 `platform` 字段的类目」，记第二个平台会覆盖第一个。现在改为「产品线 → 平台 → `catId`、`categoryPath`、`updatedAt`」。`dsh-ecommerce remember` 的 `category` 写法不变，但只替换该平台那一项，`platform` 必须是 `tmall`、`taobao`、`pinduoduo` 或 `doudian`；`forget.categories` 也接受 `{line, platform}`。之前写下的文件按每个产品线保存时的平台读取，下次 `remember` 时以新格式写回。之前的版本会把改写后的文件当作损坏而拒绝。受影响的是使用发品技能的租户，以及从文件或命令输出读取 `categories` 的脚本。

## 迁移

1. 同时升级 DSH 和 Skill Hub 上的发品技能；技能读取 `categories[<产品线>][<平台>]`。
2. 把读取 `categories[<产品线>].platform` 或 `.catId` 的脚本改为读取 `categories[<产品线>][<平台>].catId`。
3. 在 DSH 的 shell 调用里运行 `dsh-ecommerce memory`，确认每个记住的产品线都按平台名列出类目。`remember` 之后不要再用之前的版本读这份记忆。
