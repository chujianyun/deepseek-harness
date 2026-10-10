---
kind: upgrade-guide
description: "企业版 Desktop 侧栏显示 MO 字标，不再显示租户 Logo 或名称，账号入口不再显示公司；ui-hub-account 不再导出 HubBrandName。"
---

# 侧栏品牌行显示 MO 字标

[English](guide.md) | 中文

## 变更

配置了用户中心的 Desktop，展开的侧栏品牌行原来显示当前租户的 Logo 或公司名称，由 `ui-hub-account` 填充。现在显示 `ui-brand-mo` 的 MO WorkAI 立体线框字标，浅色主题下为深色，深色主题下为浅色，与租户无关；收起的侧栏显示 MO 应用图标。`ui-hub-account` 不再占据 `sidebar.brand.name`，其 `./client` 入口不再导出 `HubBrandName` 和 `HubBrandNameProps`。侧栏账号入口只显示员工姓名，不再显示公司或「不属于任何公司」；公司在设置 → Skill Hub 账号中显示。新会话页仍显示租户的 Logo 和标语。Desktop 用户以及导入 `HubBrandName` 的代码会受到影响。

## 迁移

1. 从 `@deepseek-ai/dsh-client-ui-hub-account/client` 导入 `HubBrandName` 或 `HubBrandNameProps` 的代码：去掉这些导入；品牌行现在是 `ui-brand-mo` 的 `MoWordmark`。
2. 让 `ui-brand-mo` 行与 `ui-hub-account` 一起启用；没有它时 Desktop 侧栏回退为外壳的鱼形标志和本地构建标签。
3. 确认：以用户中心账号启动 Desktop，检查侧栏显示 MO 字标和员工姓名，设置 → Skill Hub 账号显示公司，以及租户设置了 Logo 时新会话页显示该 Logo。
