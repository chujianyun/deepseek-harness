---
kind: upgrade-guide
description: "企业版桌面端会话头部去掉打开方式和更多操作菜单（下载 Session 日志、反馈、/export）；头部的反馈入口是问题反馈。"
---

# 企业版桌面端头部只保留问题反馈

[English](guide.md) | 中文

## 变更

配置了用户中心的桌面端，会话头部原有打开方式分体按钮（访达、VS Code、终端）和更多操作菜单（**下载 Session 日志**、**反馈**），输入框也接受 `/export`。web-app bundle 现在在这个组合里不挂载 `open-in-app`、`ui-open-in-app` 和 `session-log-download`：头部只显示**问题反馈**和侧栏开关，文件树和文档预览里的打开方式控件随之消失，`/export` 不再是命令。需要排查时，问题反馈可以附上会话内容发给用户中心的超管，代替下载日志。桌面端用户能看到这个变化；Web 版和未配置用户中心的桌面端保留这三行。

## 迁移

1. 原来下载会话日志交给支持人员的用户：改用**问题反馈**，并勾选**附上当前会话内容**。
2. 想在企业版桌面端恢复这些控件的部署：在 profile 的 `cordis.patch.yml` 里把 `open-in-app`、`ui-open-in-app` 或 `session-log-download` 行设为 `disabled: false`。
3. 确认：登录用户中心后启动桌面端，打开一个会话，检查头部只有**问题反馈**，没有打开方式按钮和更多操作菜单。
