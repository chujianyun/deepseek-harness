---
kind: upgrade-guide
description: "Desktop 不再解析、嵌入或执行强制更新策略；相关打包设置、工作流输入和壳层测试鉴权设置已移除。"
---

# Desktop 移除强制更新策略

[English](guide.md) | 中文

## 变更

打包 Desktop 此前会轮询配置的强制更新策略服务 `/api/v0/check_client_update`，在收到 `40005` 决定时打开阻塞式更新窗口，并在本地壳层设置允许时提供飞书测试鉴权。打包从 `.env.windows` 或 `.env.macos` 中的 `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN`、`DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN` 和 `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG` 读取策略源站与选项，Windows 手动工作流要求填写 `policy_origin`，测试部署还需填写 `login_origins`。壳层创建并读取 `app.getPath('userData')/desktop/settings.json` 中的 `updates.allowTestAuthPopupWindow`。

Desktop 现在不发送任何更新策略请求，阻塞式更新窗口已移除且无替代。打包不再解析或嵌入策略；dotenv 文件将已移除的 `DSH_DESKTOP_MANDATORY_UPDATE_*` 设置拒绝为不支持的设置，工作流也删除了两个输入。壳层设置文件不再被读取或创建。仍嵌入策略的旧安装包元数据会被忽略。常规更新检查、本地版本显示和安装包生成保持不变。

受影响对象包括使用策略源站打包 Desktop 的部署、Windows 手动 `windows-package.yml` 工作流的操作者，以及开启过测试鉴权弹窗的用户。

## 迁移

1. 从 `apps/desktop/.env.windows` 和 `apps/desktop/.env.macos` 删除 `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN`、`DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN` 和 `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG`；保留这些设置会使打包失败。当前 `.env.windows.example` 和 `.env.macos.example` 列出了可接受的设置。
2. 派发 Windows 手动工作流时不再填写 `policy_origin` 和 `login_origins`；只保留更新清单 `deployment` 选择。
3. 如果 `app.getPath('userData')/desktop/settings.json` 只包含已移除的 `updates.allowTestAuthPopupWindow` 字段，删除该文件；应用不再读取它。Windows 卸载本就会删除此文件。
4. 用清理后的 dotenv 文件完成一次打包来确认迁移：打包成功，且打包后的应用不发出 `/api/v0/check_client_update` 请求。
