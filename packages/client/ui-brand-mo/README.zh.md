---
description: "企业版桌面端 MO WorkAI 的品牌主题：把名流蓝主色与品牌灰阶叠加在平台调色板上；供组合或调整企业版外观的维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-mo

[English](README.md) | 中文

## 概述

本包为 MO WorkAI 企业版桌面端提供名流品牌配色。挂载期间，主按钮、输入框的发送键、链接、焦点环和侧栏当前面板使用名流蓝（浅色 `#2A55F9`、深色 `#5C7CFF`），正文使用品牌灰阶。它只通过主题 token 覆盖层改变颜色；不保留运行时状态，也不影响模型请求。

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

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器半部在 `ctx.effect()` 中调用一次 `ctx.theme.overrideTokens()`，因此覆盖层与插件生命周期完全一致，卸载或 HMR 时随之消失。主题呈现器把合并后的 token 作为内联变量写到 `body` 上，在两种配色下都优先于样式表调色板。替换平台强调色阶（`--dsw-static-deepseek-*`）会让所有读取它的别名一起变色；主按钮读取 `--dsw-alias-button-primary-fill`，由覆盖层直接设置。侧栏当前面板读取 `--dsw-specific-sidebar-panel-active` 与 `--dsw-specific-sidebar-panel-active-label`，没有主题设置时 `ui-sidebar` 回退到悬停样式。token 表在 [`src/client/tokens.ts`](src/client/tokens.ts)；node 半部是一个空 Loader 座位。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-theme](../ui-theme/README.zh.md)——拥有主题运行时和覆盖层契约。
- [ui-sidebar](../ui-sidebar/README.zh.md)——读取当前面板 token。
- [ui-brand-official](../ui-brand-official/README.zh.md)——企业版桌面端不组合的官方品牌填充。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


- **只改颜色**——侧栏标志、启动页和页面布局不在本包的 token 覆盖层之内。
- **固定调色板**——取值属于名流品牌；其他企业品牌需要自己的 token 表。
- **深色取值是副本**——覆盖值无法回退到它所替换的样式表取值，因此品牌保留的深色值重复了平台当前的引用，平台调色板以后变化时需要手动跟进。
- **首帧**——覆盖层在客户端插件加载后才生效，启动的第一帧会短暂显示平台调色板。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
