---
description: "dsh 桌面端的问题反馈：窗口右上方的「问题反馈」按钮、它打开的对话框，以及反馈发送给用户中心超管后的提示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-feedback-report

[English](README.md) | 中文

## 概述

在桌面窗口右上方（所有页面）添加**问题反馈**按钮及其打开的对话框。对话框收集问题类型、描述、最多三张截图，以及（在有对话的会话上）是否附上会话内容，通过 [`feedbackReport` Remote](../../feedback/feedback-report/README.zh.md) 发送给用户中心的超管。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将浏览器行与 Host 的 `feedback-report` 行一起挂载，使用相同的 `disabled` 条件；web-app bundle 在配置了用户中心的 `desktop` profile 下同时启用两者。和 ui-hub-account 一样，它在桌面窗口之外不添加任何内容。插件注入 `slots`、`locale`，以及 `hubAccount` 和 `feedbackReport` Remote。在插件生命周期内，它在 `conversation.session.header.utilities` 注册 `feedback-report` 条目（order -8，位于定时任务目录左侧），并在 `shell.overlay` 注册 `feedback-report.corner`、`feedback-report` 与 `feedback-report.notice` 条目。企业版桌面端组合不挂载头部的更多操作菜单（[session-log-export](../../session-query/session-log-export/README.zh.md)），所以这个按钮就是那里的反馈入口。

按钮只在 `hubAccount` 状态流报告已登录时显示。在有对话的会话上，它位于会话头部，点击后为该会话打开对话框。空白新会话会隐藏头部工具区，插件、设置等页面会盖住会话，所以在这些地方由一个角落副本占据同一位置：固定在侧栏开关左侧、Windows 标题栏下方，它打开的对话框没有可附上的对话。右侧面板打开时角落副本隐藏，因为窗口右上方由该面板占据。角落副本显示时，会在文档根节点上公布 `--dsh-feedback-corner-inset`，即从窗口右边缘到它左边缘的距离再加 8px 间隔，隐藏或移除后撤掉，让自身控件位于这个角落下方的页面能把控件留在它左侧；[ui-schedule](../ui-schedule/README.zh.md) 的自动化任务详情条带就是这样做的。

### 对话框

- **头部** —— 警示图标、标题，以及一句说明该反馈什么。
- **问题类型** —— 报错、卡顿、功能不可用、结果异常、其他之一；必选。
- **问题描述** —— 必填，最多 2000 字，带字数统计。
- **截图** —— 最多三张 PNG、JPEG、WebP 或 GIF 图片，每张最多 5 MB，可点添加格选择，也可在对话框任意位置粘贴，同时进行的添加共用剩余名额；每张缩略图有移除按钮。超出限制的文件会被拒绝并说明原因，其余保留。
- **附上当前会话内容** —— 反馈针对一个已有对话的会话时显示，默认不勾选；文字说明对话会发给 MO WorkAI 平台、公司管理员看不到。勾选但超过用户中心大小上限的对话由 Host 去掉，反馈照常发出。
- **底部** —— 提示会附带客户端版本、系统和当前模型，**取消**，以及选好类型、填好描述后可用的**提交**。

发送中控件禁用，状态行说明正在提交，对话框不能关闭。被拒绝时在对话框内以界面语言说明原因（未登录、连接不上服务器，或用户中心给出的原因），草稿保留。保存成功后关闭对话框并显示成功提示。

-----

<a id="model-experience"></a>
## 模型体验

无，因为对话框只调用 Host 的反馈服务；这里没有任何内容进入模型请求。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **角落副本位置固定** —— 在空白新会话或没有会话的页面上，按钮按距窗口右上方的固定偏移放置，而不在布局行内；右侧面板打开时不显示。
- **截图按原样发送** —— 发送前不压缩图片，所以每张必须不超过 5 MB。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
