---
description: "企业版桌面端 MO WorkAI 的品牌：名流蓝调色板、侧栏字标和品牌化启动页；供组合或调整企业版外观的维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-mo

[English](README.md) | 中文

## 概述

本包为 MO WorkAI 企业版桌面端提供品牌。主按钮、发送键、链接、焦点环和侧栏当前面板使用名流蓝（浅色 `#2A55F9`、深色 `#5C7CFF`），文字使用品牌灰阶。侧栏显示 MO 字标（浅色主题下为深色），折叠栏显示应用图标；启动页在藏青底上显示图标、**MO WorkAI** 和按用户语言的提示；空白新会话提供配置的快捷任务。不保留运行时状态，也不影响模型请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

web-app bundle 只在 `desktop` profile 且配置了用户中心（`DSH_HUB_ORIGIN`）时挂载本插件，条件与 Skill Hub 账号相关行相同。这个组合就是 MO WorkAI 产品，因此调色板属于产品、对所有租户相同；租户自己的标志与名称来自 ui-hub-account。开源 Web 与桌面组合不挂载它，保持平台调色板。

### 改变了什么

| 位置 | 浅色 | 深色 |
|---|---|---|
| 主按钮（填充 / 悬停） | `#2A55F9` / `#1E44E0` | `#5C7CFF` / `#7B95FF` |
| 发送键、链接、焦点环 | 强调色阶第 500 级（`#2A55F9`） | 强调色阶第 400 级（`#5C7CFF`） |
| 侧栏当前面板（填充 / 文字） | `#E6ECFE` / `#2A55F9` | 18% `#5C7CFF` / `#A9BAFF` |
| 侧栏底色 | `#F5F6F8` | 平台原值 |
| 主要 / 次要 / 第三级文字、墨色 | `#343434` / `#4D4D4D` / `#767676`、`#343434` | 平台原值 |

文字和控件当作前景色读取的墨色 token（`--dsw-alias-brand-primary`、`--dsw-alias-brand-text`）取主要文字灰，使浅色调色板只有一种主墨色。深色调色板加深色阶 800/900、提亮 500，使徽标和信息按钮悬停保持 WCAG AA。

### 快捷任务

`quickTasks` 按顺序列出空白新会话输入框下方 `conversation.hero.dock` 插槽里显示的卡片：`multi-publish`、`business-report`、`product-research`、`asset-organize`；重复的 id 只显示一次。每张卡的标题、说明和提示词来自 `ui-brand-mo` 字典，跟随界面语言；点击会把提示词放进草稿，不会发送。`quickTaskAssistant` 指定点击时同时为新会话选中的智能体模板，通过 [ui-assistants](../ui-assistants/README.zh.md) 的 `assistantPicker` 服务选择；这些任务依赖电商管家的 Skill，因此 web-app bundle 配置为 `ecommerce`。提示词在选择绑定后才填入，因此不会在错误的模式下发出；租户没有该模板的智能体时（有多个时取最早创建的），卡片不填入任何内容，并提示先在「智能体」页新建。部署没有智能体界面时保持当前选择；默认空值不改变选择。默认是空列表；web-app bundle 为企业版桌面端组合全部四张。卡片只在草稿没有文字、引用和附件时显示，因此点击不会替换用户已输入的内容；会话一旦不再空白，卡片就会消失。卡片需要语言注册表和设置表单；缺少它们时主题和侧栏品牌照常生效。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器半部在 `ctx.effect()` 中调用一次 `ctx.theme.overrideTokens()`，因此覆盖层与插件生命周期完全一致，卸载或 HMR 时随之消失。它还占据侧栏的两个品牌位：`sidebar.brand.name` 显示字标（[`src/wordmark.ts`](src/wordmark.ts)，装饰性图片：侧栏对辅助技术隐藏品牌行），`body:not([data-ds-dark-theme])` 规则把它反色为深色；`sidebar.brand.mark` 只在折叠栏显示应用图标；租户不影响这一行。主机半部通过 `webserver/index-inject` 在每次首页渲染时加入两行：[启动页](../web/README.zh.md)读取的 `__DSH_BOOT_BRAND__` 全局变量（图标、名称、按语言分的提示），以及一份样式表：把 `[data-dsh-boot]` 涂成藏青，并在 `html body` 与 `html body[data-ds-dark-theme]` 下声明 token 表，这两个选择器优先于平台调色板，因此第一帧就使用客户端覆盖层随后内联设置的品牌取值。启动页按 `<html lang>` 选择提示，[locale](../locale/README.zh.md) 主机端会把显式语言偏好写入它。主题呈现器把合并后的 token 作为内联变量写到 `body` 上，在两种配色下都优先于样式表调色板。替换平台强调色阶（`--dsw-static-deepseek-*`）会让所有读取它的别名一起变色；主按钮读取 `--dsw-alias-button-primary-fill`，由覆盖层直接设置。侧栏当前面板读取 `--dsw-specific-sidebar-panel-active` 与 `--dsw-specific-sidebar-panel-active-label`，没有主题设置时 `ui-sidebar` 回退到悬停样式。token 表在 [`src/client/tokens.ts`](src/client/tokens.ts)，图标在 [`src/mark.ts`](src/mark.ts)；两个半部都读取它们。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-theme](../ui-theme/README.zh.md)——拥有主题运行时和覆盖层契约。
- [ui-sidebar](../ui-sidebar/README.zh.md)——读取当前面板 token。
- [ui-brand-official](../ui-brand-official/README.zh.md)——企业版桌面端不组合的官方品牌填充。
- [web](../web/README.zh.md)——读取注入品牌的启动页。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


- **页面布局**——页面标题区、卡片和空状态仍由各自组件负责；本包只改颜色、标志和启动页。
- **固定调色板**——取值属于名流品牌；其他企业品牌需要自己的 token 表。
- **深色取值是副本**——覆盖值无法回退到它所替换的样式表取值，因此品牌保留的深色值重复了平台当前的引用，平台调色板以后变化时需要手动跟进。
- **启动样式表的生命周期**——主机写入的调色板会留在已提供的页面中直到重新加载，因此只卸载浏览器半部（HMR、停用该行）时，品牌颜色会保留到重新加载为止。
- **内联图片**——应用图标和字标以 data URI 形式打进主机与客户端 bundle（合计约 40 KB）；字标是 Desktop 欢迎页 `mo-logo.png` 的缩小副本，改版时两处一起更新。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
