---
kind: upgrade-guide
description: "E-commerce accounts are no longer checked at startup, every 30 minutes, or when Settings opens; the saved sign-in answer shows, and a task checks an account only when its answer is older than 30 minutes."
---

# E-commerce accounts check sign-ins only when needed

English | [中文](guide.zh.md)

## Change

The `ecommerce-accounts` service checked every account when the tenant's accounts loaded and whenever the Settings section opened (`refresh()`), checked merchant accounts every `checkIntervalMs`, and checked an account again on every task take-over. Each check flashed the account's Chrome window. The service now saves each check's answer in the ledger and shows it, also after a restart, and checks only when asked through the new `checkAccounts(ids)` Remote method, or when a task takes over an account whose signed-in answer is older than the new `signInReuseMs` option (30 minutes). `refresh()` only looks for Chrome again. The `checkIntervalMs` option is gone. Desktop users see fewer Chrome windows; an account that lost its sign-in shows as expired when a task or the user next checks it.

## Migration

1. A profile that sets `checkIntervalMs` on `ecommerce-accounts`: remove it; set `signInReuseMs` to change how long a signed-in answer stands, or `0` to check on every take-over.
2. A client that called `refresh()` to check the accounts: call `checkAccounts()` instead, with the account ids or none for all.
3. Confirm: sign in an account, restart Desktop, and check that Settings → E-commerce accounts shows it signed in with the earlier check time and that no Chrome window appears.
