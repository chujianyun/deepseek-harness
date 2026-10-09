---
kind: upgrade-guide
description: "Desktop 打包需要用户中心地址与 DSH 客户端 ID，安装包现在内置二者。"
---

# Desktop 安装包内置用户中心

[English](guide.md) | 中文

## 变更

此前打包后的 Desktop 只从启动环境的 `DSH_HUB_ORIGIN` 和 `DSH_HUB_CLIENT_ID` 读取用户中心，因此未设置它们就启动的安装副本会在启动时以 `desktop welcome: Web request failed` 失败。现在打包要求 `apps/desktop/.env.macos` 或 `.env.windows` 中提供 `DSH_DESKTOP_HUB_ORIGIN` 和 `DSH_DESKTOP_HUB_CLIENT_ID`，并把它们嵌入安装包；缺少任一项时，准备、未签名和已签名构建都会以 `desktop package: DSH_DESKTOP_HUB_ORIGIN requires an HTTPS origin` 或 `desktop package: DSH_DESKTOP_HUB_CLIENT_ID requires the DSH client id registered in the user center` 停止。启动环境中的值仍会替换内置值。两者都没有的 Desktop 现在会显示启动对话框，说明没有配置用户中心。负责打包 Desktop 的人受影响。

## 迁移

1. 请用户中心超级管理员登记一个 `public` DSH 客户端，回调地址为 `http://127.0.0.1/callback`，权限为 `profile`、`skills:read` 和 `skills:write`，并记下其客户端 ID。
2. 把两项设置加入本地 dotenv 文件，参照 [`.env.macos.example`](../../../../apps/desktop/.env.macos.example)：

   ```dotenv
   DSH_DESKTOP_HUB_ORIGIN=https://hub.example.com
   DSH_DESKTOP_HUB_CLIENT_ID=dsh_0123456789abcdef01234567
   ```

3. 打包后在未设置 `DSH_HUB_ORIGIN` 的情况下启动安装好的应用：欢迎窗口提供用户中心登录。
