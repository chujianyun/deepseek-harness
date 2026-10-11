---
kind: upgrade-guide
description: "电商账号不再在启动时、每 30 分钟或打开设置时检查；显示保存的登录结果，任务只在结果早于 30 分钟时检查账号。"
---

# 电商账号只在需要时检查登录

[English](guide.md) | 中文

## 变更

`ecommerce-accounts` 服务原来在租户的账号加载时和每次打开设置分区（`refresh()`）时检查所有账号，每隔 `checkIntervalMs` 检查商家账号，每次任务接管时还会再检查一次该账号。每次检查都会让账号的 Chrome 窗口闪一下。现在服务把每次检查的结果保存在账本中并一直显示，重启后也是；只在通过新的 Remote 方法 `checkAccounts(ids)` 要求时，或任务接管一个已登录结果早于新选项 `signInReuseMs`（30 分钟）的账号时才检查。`refresh()` 只重新查找 Chrome。`checkIntervalMs` 选项已删除。桌面端用户看到的 Chrome 窗口会少很多；掉线的账号在下次被任务或用户检查时显示为已失效。

## 迁移

1. 在 `ecommerce-accounts` 上设置了 `checkIntervalMs` 的 profile：删掉它；如需调整已登录结果的有效时长，设置 `signInReuseMs`，设为 `0` 则每次接管都检查。
2. 调用 `refresh()` 来检查账号的客户端：改为调用 `checkAccounts()`，传账号 id，不传则检查全部。
3. 确认：登录一个账号后重启桌面端，在 设置 → 电商账号 中看到它仍为已登录、检查时间是之前那次，并且没有弹出 Chrome 窗口。
