---
description: "dsh Desktop 客户端的智能体页面和新会话选择器：侧边栏入口、智能体卡片，以及把新会话绑定到智能体的选择器，基于 assistants Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-assistants

[English](README.md) | 中文

## 概述

[智能体](../../../docs/glossary.zh.md#assistant)在 Desktop 中的界面：侧边栏的**智能体**入口、它打开的页面（以卡片显示已登录租户的智能体）和每个智能体的详情页，以及新会话页工作区那一行最前面的选择器。两者都渲染 [`assistants`](../../assistant/assistants/README.zh.md) Remote 的状态流。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把浏览器行挂在 Host 的 `assistants` 行旁边，`disabled` 条件相同；web-app bundle 在 `desktop` profile 且配置了用户中心时同时启用两者。插件只在 Desktop 渲染器（存在 `dshDesktop`）中生效。它注入 `remote.assistants`，并在 `sessions` 和 `uiWorkspace` 出现后，把页面以 `assistants` 注册到 `main` 键控插槽，把入口以顺序 8 加到 `sidebar.panellist`（在连接器下方），并填充 `conversation.hero.assistant`。

页面显示一个搜索框和智能体数量，每个智能体一张卡片：头像（彩色圆底加名字首字）、名称（租户默认智能体带**默认**标签）、描述（为空时显示**暂无描述**），以及**设为默认**（默认智能体上没有）、**复制**、**删除**和**对话**按钮。搜索匹配名称和描述。未登录时页面提示登录用户中心；没有智能体的租户显示**还没有智能体。**

页头的**新建智能体**打开创建向导，共四步，可**上一步**、**下一步**：起点——日常助手或电商管家模板，或空白；身份与模型——名称（1 到 32 个字符，**下一步**之前校验）、头像、描述和模型；能力底座——`agentPresets.list()` 中的一个 Agent preset 或默认；以及如何称呼用户、偏好语言、备注和背景。选择模板会预填名称、描述和头像。头像可从十六个预设圆底中选，每次显示八个，可**换一批**；也可上传 PNG、JPG 或 WebP 图片，浏览器把它裁成居中的正方形、缩放到 256 像素并编码为 WebP；其他文件类型会被拒绝。模型列表来自 `session.modelCatalog()`，默认为**跟随全局**，选中的模型若有思考级别，会从它的默认级别开始提供选择。**创建**调用 `assistants.createAssistant()`；成功后向导关闭，否则显示 Host 的拒绝原因。Remote 无法提供的模型和 preset 不会出现。

点击卡片的头像、名称或描述会打开它的详情页，内容通过 `assistants.getAssistant()` 读取；页面顶部是**返回智能体列表**，下面的页头重复卡片上的按钮。详情页像向导一样编辑身份与模型字段和能力底座，并以标签页编辑四份核心文件——身份、人格、用户信息和工作方法，每份都是纯文本编辑框。部署已不再提供的模型或 preset 会标为不可用。**保存**只把修改过的字段通过 `assistants.updateAssistant()` 发出，再读回保存后的智能体，因为改名会改写身份文件；**放弃修改**恢复已保存的值，两者在有改动之前都不可用。**复制**会打开副本的详情页。卡片或详情页上的**删除**会先弹出确认框，写明智能体名称，以及会话列表中有多少个已开始的会话绑定了它，然后调用 `assistants.deleteAssistant()`；已打开的详情页在智能体被删除后回到列表。被拒绝的操作会在卡片上方或详情页页头下方显示消息，直到关闭。

选择器显示即将开始的会话所用的智能体：尚未绑定的选择优先，其次是主视图空白会话已绑定的智能体，再其次是租户默认智能体。它的菜单列出每个智能体及其头像和描述。选择后通过 `assistants.select()` 绑定主视图显示的空白会话；没有空白会话时，选择会等待，并在下一次会话列表变化带来空白会话时绑定。卡片上的**对话**会选中该智能体，并通过 `uiWorkspace.startSession()` 打开新会话页，所以随之出现的会话一开始就绑定了它。在主视图之外，或租户没有智能体时，选择器不渲染任何内容。被拒绝的绑定会在输入框上方以提示条显示，并在卡片上方显示消息直到关闭。

-----

<a id="model-experience"></a>
## 模型体验

间接通过 [`dsh-assistants`](../../assistant/assistants/README.zh.md#model-experience)：选择会把会话绑定到一个智能体，该服务把它的核心文件加进系统提示词。

#### KV Cache 影响

没有直接影响。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- **详情页没有最近会话** —— 详情页不列出智能体的会话；在会话上显示智能体由后续票实现。
- **会话数来自已加载的列表** —— 删除确认框统计会话列表中的会话；未打开的会话，其智能体来自投影缓存。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布伴随状态。页面和选择器渲染 Host 的状态流和会话列表，只保存一个等待空白会话的选择。
