---
kind: upgrade-guide
description: "An e-commerce account's Chrome now starts in the background without taking focus, is minimized once, and closes when a turn, a check, or a sign-in ends, instead of staying open minimized."
---

# E-commerce account Chrome runs only while needed

English | [中文](guide.zh.md)

## Change

The `ecommerce-accounts` service kept each signed-in account's Chrome running after DSH quit, started it directly (which on macOS brought it to the front), and restored and minimized its windows again on every check. Chrome now starts only when a check or task needs it: in the background without taking focus (on macOS through `open -g` on Chrome's app bundle), with flags that keep unseen pages running, and with its window minimized once. It closes through `Browser.close` when a turn of any Session ends and no task holds the account, after a check the user asked for, and after a finished sign-in; Chrome restores its session on its next start. The account's `chrome.json` record gains `background`. Desktop users see no Chrome window pop up or flash during tasks, and no account Chrome stays in the Dock between tasks.

## Migration

1. Nothing to change in profiles. A Chrome an earlier DSH left running minimized is reattached to and closed at the next turn end; signing in again starts it on screen.
2. A script that relied on the account's Chrome staying open between bash calls of different turns: take the account over with `dsh-ecommerce browser <id>` in each call, as the Skill says.
3. Confirm: run an e-commerce task on Desktop, check that Chrome never comes to the front, and that it leaves the Dock once the reply is done.
