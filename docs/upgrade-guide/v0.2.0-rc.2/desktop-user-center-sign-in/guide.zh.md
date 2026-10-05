---
kind: upgrade-guide
description: "Desktop 产品只用公司用户中心登录，不再挂载 DeepSeek 账号相关的行。"
---

# Desktop 只用公司用户中心登录

[English](guide.md) | 中文

## 变更

在 v0.2.0-rc.2 中，Desktop 欢迎窗口用 DeepSeek 账号登录或保存官方 API Key，工作区挂载 DeepSeek 账号相关的行：`deepseek-account`、`llm-deepseek-account`、`account-controller`、`ui-settings-account` 和 `product-analytics`。

下一版本只有在登录公司用户中心（`hub-account` 行，由 `DSH_HUB_ORIGIN` 和 `DSH_HUB_CLIENT_ID` 配置）后才打开 Desktop 工作区；未配置用户中心时 Desktop 报告启动错误。上述五行对 `desktop` profile 设为 `disabled`（`product-analytics` 在所有 profile 中禁用）；侧栏账号菜单换成用户中心入口，设置中不再有账号与余额、充值、赠金提醒、首次额度引导和意见反馈入口。`$DSH_HOME/.credentials.yaml` 中已保存的 DeepSeek 账号授权保留但不再读取。没有可用模型提供商时，Desktop 新会话会显示首次 API Key 引导（Desktop 标记不再抑制它），其中也提供「使用其他模型提供商」；没有 Key 时发送消息会显示「去配置模型」。欢迎窗口不再显示 DeepSeek Harness Logo 和「欢迎使用 DeepSeek Harness」：改为显示用户中心为本机上次登录租户设置的 Logo 和欢迎标题，首次登录前两者都不显示。工作区侧栏品牌行显示租户 Logo 或公司名称及版本号；配置了用户中心的 Desktop 上 `ui-brand-official` 设为 `disabled`。`sidebar.brand.mark` 的占位者现在会收到 `placement`，`sidebar.brand.name` 的占位者会收到 `version`。CLI 和 Web profile 不变。

## 迁移

1. 为 Desktop 进程设置 `DSH_HUB_ORIGIN` 和 `DSH_HUB_CLIENT_ID`，指向用户中心及其登记的 DSH 客户端；只有本机测试用户中心才设置 `DSH_HUB_ALLOW_LOOPBACK_HTTP=1`。
2. 在设置 → 模型中用 API Key 或自定义路由配置模型；Desktop 上不再提供 DeepSeek 账号模型路由。
3. 不要在 Desktop 上重新启用 DeepSeek 账号相关的行：`ui-settings-account` 与 `ui-hub-account` 都占用唯一的侧栏账号入口位置，且账号版首次引导不再为用户中心产品维护。同样保持 `ui-brand-official` 关闭：它与 `ui-hub-account` 都占用侧栏品牌位置。
4. 确认：启动 Desktop，在浏览器中用公司账号登录，检查侧栏显示员工和公司，侧栏品牌行显示租户 Logo 或名称。
