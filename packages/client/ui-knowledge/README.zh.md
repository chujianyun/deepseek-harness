---
description: "dsh Desktop 客户端的知识库页面：侧栏入口，以及当前登录租户的知识库和其中的文件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-knowledge

[English](README.md) | 中文

## 概述

在 Desktop 侧栏的 Skills 下方新增**知识库**入口及其打开的页面：左侧是当前登录租户的[知识库](../../../docs/glossary.zh.md#knowledge-base)，右侧是选中知识库的文件；提供新建、重命名、删除知识库的对话框，以及用于添加文档的拖放区和**添加文件**按钮。它通过 [`knowledgeBases` Remote](../../knowledge/knowledge-base/README.zh.md) 读取和操作，并提供 [`embedding` Remote](../../llm/embedding/README.zh.md) 中的模型供选择。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把浏览器行挂在 Host 的 `knowledge-base` 行旁边，`disabled` 条件与它相同；web-app bundle 在 `desktop` profile 且配置了用户中心时启用这两行。插件只在 Desktop 渲染器（存在 `dshDesktop`）中生效。它注入 `remote.knowledgeBases` 与 `remote.embedding`，以 `knowledge` 注册到 `main` keyed slot，并以顺序 6 加入 `sidebar.panellist`。

未登录时页面提示登录。登录后列表显示每个知识库及其文件数，在选择其他知识库前默认选中第一个。**新建知识库**打开对话框，填写名称并选择嵌入模型：本地模型（未安装时标注下载完成后可用），以及每个 API 嵌入模型及其提供商；选择 API 模型时提示文档内容会发送到该提供商，没有可用模型时指向「设置 → 嵌入模型」。名称重复或不合法时在对话框中说明。

详情显示知识库的嵌入模型、模型不可用时的提示、**重命名**和**删除知识库**（删除前需确认），以及由名称、大小、状态和分块数组成的文件表格。失败的文件显示原因；已完成或失败的文件可以重新处理，所有文件都可以删除。拖到拖放区或通过**添加文件**选择的文件按本机路径加入，路径由 Desktop 预加载从每个文件读取；无法取得路径的文件会给出说明。添加后页面报告添加了几个文件，以及被拒绝文件的原因。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该页面只渲染和编辑知识库。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只支持文件** — 文件夹、网页和笔记、知识库设置以及召回测试稍后提供。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。页面渲染 Host 的状态流，只保存选中项和对话框草稿。
