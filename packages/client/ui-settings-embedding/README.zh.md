---
description: "dsh Desktop 设置中的「嵌入模型」分区：本地模型的下载进度、暂停、修复和删除，以及通过已配置提供商路由使用的 API 嵌入模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-embedding

[English](README.md) | 中文

## 概述

在 Desktop 设置的**模型**之后新增**嵌入模型**分区。它展示本地嵌入模型的状态，提供下载进度和**暂停**、**继续**、**重试**、**修复**、**删除**操作；并列出 API 嵌入模型，提供在已配置提供商上添加模型的表单。它通过 [`embedding` Remote](../../llm/embedding/README.zh.md) 读取状态和执行操作；知识库从这些模型中选择。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把浏览器行挂在 Host 的 `embedding` 行旁边，`disabled` 条件与它相同；web-app bundle 只在 `desktop` profile 下启用这两行。插件只在 Desktop 渲染器（存在 `dshDesktop`）中生效。它注入 `remote.embedding`，以 id `embedding`、顺序 11 注册到 `settings.section`。

本地模型卡片显示模型名称，说明它离线运行、不需要 API Key，安装后还显示向量维度。状态标签为**未下载**、**下载中**、**已暂停**、**已安装**、**下载失败**、**需要修复**或**此电脑不支持**。下载中、已暂停，以及失败但磁盘上已有部分内容时，进度条显示已下载和总大小。失败时说明原因（网络、校验或存储）并提供**重试**；文件损坏时提供**修复**；不支持的电脑只显示说明，不提供操作。**删除**会就地要求确认，并提示下次启动会重新下载。

API 卡片列出每个模型的提供商和向量维度，提供商路由已不存在的模型标为不可用，并可删除。添加表单提供 Host 列出的已配置提供商（分区挂载时刷新）和模型 ID 输入框；Host 测量向量维度期间，**添加**显示为**正在测试…**，成功后清空输入框。操作被拒绝时显示 Host 返回的信息；删除正被知识库使用的模型时，改为列出这些知识库。没有可用提供商时卡片会说明，**去配置模型**会打开设置中的「模型」分区。另有一行说明：使用 API 嵌入模型时，文档内容会发送到对应的提供商。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该分区只渲染嵌入模型的状态。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 无。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。界面渲染 Host 的状态流，不保存独立的模型状态。
