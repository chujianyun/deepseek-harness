---
description: "Desktop e-commerce accounts: platform sign-ins kept by the system Google Chrome on each account's own browser data, per tenant, and the ecommerceAccounts Remote."
kind: "package-reference"
---
# E-commerce accounts

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-ecommerce-accounts` owns the current tenant's [e-commerce accounts](../../../docs/glossary.md#ecommerce-account), as the Host service `ctx.ecommerceAccounts` and the `ecommerceAccounts` Remote namespace. The user signs each account in to its platform in the system Google Chrome, on that account's own browser data; Chrome keeps the sign-in, and DSH stores no password or cookie. Tmall [merchant accounts](../../../docs/glossary.md#merchant-account) can be added now. Why accounts work this way is recorded in the [e-commerce accounts Agent Note](../../../.agents/notes/proposed/feature/2026-10-07-ecommerce-accounts-over-store-session.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in the Desktop profile beside `hub-account`, which it injects. The web-app bundle enables it for the `desktop` profile with a configured user center, and `ui-ecommerce-accounts` renders its Settings section.

Accounts belong to the tenant of the current Hub sign-in and live under `<dshHome>/ecommerce/<tenantId>/`: `accounts.json` lists them in the order they were added, and `browsers/<accountId>/` holds each account's Chrome data (`user-data/`) and the record of its running Chrome (`chrome.json`, its process id and remote-debugging port). Switching tenants stops sign-ins under way and shows the other tenant's accounts; signed out of the Hub, there are none, and every method refuses with `hub-account/signed-out`.

`getState()` and `watch()` return the accounts and whether Chrome can run them. `chrome.status` is `ready`, `missing` when Google Chrome is not at the platform's standard install path (or `chromePath`), or `outdated` when its major version is below `minChromeVersion`, with the version Chrome reports and where to download it. Each account carries its platform, kind, store name, account name, when it was added, its status — `signed-out`, `signing-in`, `checking`, `signed-in`, or `check-failed` when the platform could not be asked — the name the platform reported at the last successful check (`signedInAs`), and when that check ran.

`addAccount(input)` adds an account that starts signed out. Only `tmall` / `merchant` can be added; anything else is refused with `ecommerce-accounts/unsupported`. The store name and account are trimmed and must be 1 to `maxNameLength` characters, otherwise `ecommerce-accounts/invalid-field` names the field; the same platform, kind, and account a second time is refused with `ecommerce-accounts/duplicate`. A store's main account and a sub-account are two accounts.

`startSignIn(id)` checks Chrome first (`ecommerce-accounts/chrome-missing`, `ecommerce-accounts/chrome-outdated`), reattaches to the account's Chrome or starts it, opens the platform's sign-in page in a new tab, and brings its window on screen; a Chrome that cannot be started or reached is refused with `ecommerce-accounts/browser-failed`. Chrome is started detached, with `--user-data-dir` set to the account's data, a remote-debugging port on `127.0.0.1`, `--restore-last-session`, and its preferences set to restore the last session, and DSH's own variables are removed from its environment. The account is `signing-in` until the platform says it is signed in or `signInTimeoutMs` passes, when it returns to `signed-out`. Every `signInPollMs` the service looks at the sign-in tab; once the tab leaves the sign-in page or is closed, or every `signInCheckEveryMs`, it checks the account. `confirmSignIn(id)`, behind the **I have signed in** button, checks at once.

A check opens the platform's business page in a background tab and reads the platform's own answer there, retrying once: for Tmall, the `mtop.user.getusersimple` response and its nick. The tab closes afterwards. A signed-in account is `signed-in` with that nick, and its Chrome windows are minimized, so Chrome keeps running unseen (macOS keeps part of any window moved off screen visible); a response without a nick is `signed-out`; no response within `checkTimeoutMs` is `check-failed`, which keeps the last nick. Checks of one account never run together. Every account is checked when the tenant's accounts load and on `refresh()`, which the Settings section calls when it opens and which also looks for Chrome again.

Chrome outlives DSH. The next DSH reattaches to an account's Chrome through its record; when that Chrome is gone, an account that was ever signed in has Chrome started again and minimized, restoring its last session, and an account never signed in stays `signed-out` without starting Chrome. `deleteAccount(id)` stops a sign-in under way, closes the account's Chrome through `Browser.close` so it writes its cookies (then `SIGTERM`, then `SIGKILL`), and deletes the account's browser data and its ledger row. Unknown ids are refused with `ecommerce-accounts/not-found`.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home; accounts live under `<dshHome>/ecommerce`. |
| `chromePath` | the standard Google Chrome install | Chrome executable to use instead. |
| `minChromeVersion` | `120` | Oldest Chrome major version accounts run on. |
| `signInTimeoutMs` | `600000` (10 minutes) | How long a sign-in waits for the user. |
| `checkTimeoutMs` | `20000` | How long one check waits for the platform's response. |
| `chromeTimeoutMs` | `20000` | How long DSH waits for Chrome to start or close. |
| `signInPollMs` | `3000` | Time between looks at the sign-in tab. |
| `signInCheckEveryMs` | `30000` | Time after which a sign-in is checked even before its tab leaves the sign-in page. |
| `maxNameLength` | `64` | Longest store or account name, in characters. |

-----

<a id="model-experience"></a>
## Model Experience

None, as accounts are added, signed in, and checked outside any Session; no model request carries them yet.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Tmall merchant accounts only** — Taobao, JD, Pinduoduo, Douyin, and buyer accounts cannot be added yet.
- **No model use yet** — no tool reads a store's data through a signed-in account.
- **Platform session lifetime** — a sign-in lasts as long as the platform keeps the session; after a computer restart, Chrome restores session cookies only when the platform kept them, otherwise the account reads `signed-out` and must sign in again.
- **Chrome stays running** — a signed-in account's Chrome keeps running minimized after DSH quits, and the user sees it in the Dock.
- **Local debugging port** — a signed-in account's Chrome listens on a remote-debugging port on `127.0.0.1`, so any program the user runs can drive it while it runs.
- **No Windows verification** — Windows runs only in CI; signing in there was not exercised on a real machine.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The service owns the ledger; the sign-in itself is read from the platform's own response on every check, so there is no second record of it that could diverge.
