---
kind: upgrade-guide
description: "电商账号的 Chrome 现在在后台启动、不抢焦点、只最小化一次，并在一轮对话、检查或登录结束时关闭，不再一直以最小化状态开着。"
---

# 电商账号的 Chrome 只在需要时运行

[English](guide.md) | 中文

## 变更

`ecommerce-accounts` 服务原来在 DSH 退出后仍让每个已登录账号的 Chrome 运行，直接启动 Chrome（在 macOS 上会被带到最前面），并在每次检查时把窗口恢复后再最小化。现在只有检查或任务需要时才启动 Chrome：在后台启动、不抢焦点（macOS 上通过 Chrome 应用包的 `open -g`），带上让看不见的页面照常运行的参数，窗口只最小化一次。任何会话的一轮结束且没有任务占用该账号时、用户要求的检查结束后、登录完成后，都通过 `Browser.close` 关闭 Chrome；下次启动时 Chrome 恢复会话。账号的 `chrome.json` 记录新增 `background`。桌面端用户在任务期间不会再看到 Chrome 窗口弹出或闪动，任务之间程序坞里也不会一直留着账号的 Chrome。

## 迁移

1. profile 无需改动。旧版 DSH 留下的以最小化方式运行的 Chrome 会被重新连上，并在下一轮结束时关闭；重新登录会让它显示在屏幕上。
2. 依赖账号 Chrome 在不同轮次的 bash 调用之间一直开着的脚本：按 Skill 的说明，在每次调用中用 `dsh-ecommerce browser <id>` 接管账号。
3. 确认：在桌面端跑一次电商任务，确认 Chrome 从未跑到最前面，回复完成后它从程序坞中消失。
