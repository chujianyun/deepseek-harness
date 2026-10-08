---
description: "Desktop e-commerce accounts: platform sign-ins kept by the system Google Chrome on each account's own browser data, per tenant, and the ecommerceAccounts Remote."
kind: "package-reference"
---
# E-commerce accounts

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-ecommerce-accounts` owns the current tenant's [e-commerce accounts](../../../docs/glossary.md#ecommerce-account), as the Host service `ctx.ecommerceAccounts` and the `ecommerceAccounts` Remote namespace. The user signs each account in to its platform in the system Google Chrome, on that account's own browser data; Chrome keeps the sign-in, and DSH stores no password or cookie. [Merchant accounts](../../../docs/glossary.md#merchant-account) on Tmall, Taobao, Pinduoduo, and Douyin shops (抖店), and [buyer accounts](../../../docs/glossary.md#buyer-account) on Tmall and Taobao, can be added now. Why accounts work this way is recorded in the [e-commerce accounts Agent Note](../../../.agents/notes/proposed/feature/2026-10-07-ecommerce-accounts-over-store-session.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in the Desktop profile beside `hub-account`, `skill`, and `shell-env`, which it injects. The web-app bundle enables it for the `desktop` profile with a configured user center, and `ui-ecommerce-accounts` renders its Settings section.

Accounts belong to the tenant of the current Hub sign-in and live under `<dshHome>/ecommerce/<tenantId>/`: `accounts.json` lists them in the order they were added, and `browsers/<accountId>/` holds each account's Chrome data (`user-data/`) and the record of its running Chrome (`chrome.json`, its process id and remote-debugging port). Switching tenants stops sign-ins under way and shows the other tenant's accounts; signed out of the Hub, there are none, and every method refuses with `hub-account/signed-out`.

`getState()` and `watch()` return the accounts and whether Chrome can run them. `chrome.status` is `ready`, `missing` when Google Chrome is not at the platform's standard install path (or `chromePath`), or `outdated` when its major version is below `minChromeVersion`, with the version Chrome reports and where to download it. Each account carries its platform, kind, store name, account name, when it was added, its status — `signed-out`, `signing-in`, `checking`, `signed-in`, or `check-failed` when the platform could not be asked — with the `problem` of a failed check, `expired` when an account that was signed in before is signed out now, the account and store names the platform reported at the last successful check (`signedInAs`, `signedInStore`, only from platforms that report them), and when that check ran.

`addAccount(input)` adds an account that starts signed out. Merchant accounts on `tmall`, `taobao`, `pinduoduo`, and `doudian`, and buyer accounts on `tmall` and `taobao`, can be added; anything else is refused with `ecommerce-accounts/unsupported`. A buyer account has only an account name: its store name is ignored and stays empty. The store name and account are trimmed and must be 1 to `maxNameLength` characters, otherwise `ecommerce-accounts/invalid-field` names the field; the same platform, kind, and account a second time is refused with `ecommerce-accounts/duplicate`. A store's main account and a sub-account are two accounts. `renameAccount(id, { account, storeName })` changes the account name, the store name, or both, such as to the names the platform reports, with the same checks; a field left out stays.

`startSignIn(id)` checks Chrome first (`ecommerce-accounts/chrome-missing`, `ecommerce-accounts/chrome-outdated`), refuses with `ecommerce-accounts/browser-busy` while a Chrome DSH did not start holds the account's data (the `SingletonLock` Chrome keeps there names a running process), reattaches to the account's Chrome or starts it, opens the platform's sign-in page in a new tab, and brings its window on screen; a Chrome that cannot be started or reached is refused with `ecommerce-accounts/browser-failed`. Chrome is started detached, with `--user-data-dir` set to the account's data, a remote-debugging port on `127.0.0.1`, `--restore-last-session`, and its preferences set to restore the last session, and DSH's own variables are removed from its environment. Once a started Chrome answers, DSH closes the blank tabs it gathered beside the restored ones, keeping one when every tab is blank. The account is `signing-in` until the platform says it is signed in or `signInTimeoutMs` passes, when it returns to `signed-out`. Every `signInPollMs` the service looks at the sign-in tab; once the tab leaves the sign-in page or is closed, or every `signInCheckEveryMs`, it checks the account. `confirmSignIn(id)`, behind the **I have signed in** button, checks at once.

A check opens the platform's business page in a background tab and reads the platform's own answer there, retrying once. Tmall's home page sends `mtop.user.getusersimple`, signed in with a nick; Taobao's Qianniu workbench sends `mtop.taobao.jdy.resource.shop.info.get`, signed in when it succeeds; Pinduoduo's backend home page sends `janus/api/checkLogin`, which says `result.login`, and `earth/api/mallInfo/querySimpleCredential`, which names the store; a Douyin shop's home page sends `byteshop/menu/list/v2`, signed in with a non-empty menu, and `center/qualification/shop/info`, which names the store. A signed-in answer waits for the store name until `checkTimeoutMs` and stays signed in without it. A business page sent to the platform's sign-in page is signed out at once. The tab closes afterwards. A signed-in account is `signed-in`, and its Chrome windows are minimized, so Chrome keeps running unseen (macOS keeps part of any window moved off screen visible). A check that fails keeps the last answer and is `check-failed` with a `problem`: `timeout` when no answer came within `checkTimeoutMs`, `network` when the business page could not be loaded (Chrome's navigation error), or `busy` when a Chrome DSH did not start holds the account's data, in which case DSH starts none. Checks of one account never run together. Every account is checked when the tenant's accounts load and on `refresh()`, and merchant accounts also every `checkIntervalMs` — a buyer account is not, since each check opens a page the platform counts; which the Settings section calls when it opens and which also looks for Chrome again.

Chrome outlives DSH. The next DSH reattaches to an account's Chrome through its record; when that Chrome is gone, an account that was ever signed in has Chrome started again and minimized, restoring its last session, and an account never signed in stays `signed-out` without starting Chrome. `deleteAccount(id)` stops a sign-in under way, closes the account's Chrome through `Browser.close` so it writes its cookies (then `SIGTERM`, then `SIGKILL`), and deletes the account's browser data and its ledger row. Unknown ids are refused with `ecommerce-accounts/not-found`.

While a tenant is signed in, the model and Skill scripts use the accounts through the `dsh-ecommerce` command, which this package writes to `<dshHome>/ecommerce/bin/` and puts ahead of the model shell's `PATH` through `ctx.shellEnv.registerPath()`. The command is a POSIX shell script that calls a loopback HTTP endpoint with `curl`; each bash call gets the endpoint's address in `DSH_ECOMMERCE_URL` with a random token of its own, which ends at the call's `tools/result`. `dsh-ecommerce accounts` prints the tenant's accounts as JSON — id, platform, store, account, kind, status, and the problem of a failed check — and never a path, cookie, or the browser's address. `dsh-ecommerce browser <id>` reserves the account's browser for the call, checks the account at once, and prints the account with `cdpUrl`, the remote-debugging address of its signed-in Chrome; a failed check ends a new reservation, and the reservation ends with the call. A second call asking for a reserved account, or one being signed in, is refused, and so are `startSignIn()` and `deleteAccount()` (`ecommerce-accounts/in-use`) while a task uses it; `refresh()` leaves a reserved account to its task. The account view's `inUse` tells the Settings section. The `ecommerce-accounts` Skill, registered through `ctx.skills.register()` while a tenant is signed in, tells the model the commands and how to pick a merchant account.

While a call holds an account, DSH watches its browser through a DevTools connection of its own: `Target.setAutoAttach` attaches it to every tab before the tab runs, and `Fetch` pauses every page load. A page DSH refuses fails with `net::ERR_BLOCKED_BY_CLIENT`, so the task's own connection cannot get around it. A merchant account opens no public product or search page (`PUBLIC_PAGE`: item.taobao.com, detail.tmall.com, s.taobao.com, list.tmall.com). A buyer account opens at most the tenant's daily page limit (`buyerDailyPages`, set with `setBuyerDailyPages(pages)` from 1 to 1000, or the `buyerDailyPages` option); every page a task opens counts once however many redirects it takes, and the count, kept in the ledger by calendar day, starts again the next day. When the platform's risk control shows (`RISK_PAGE`), DSH loads nothing more for the task and, for a buyer account, records a rest of `cooldownHours`. `dsh-ecommerce browser` refuses a buyer account that is resting or out of pages for the day, and `dsh-ecommerce buyer [tmall|taobao]` takes over the buyer account that can be used and has opened the fewest pages today, or names why each cannot. A buyer view carries `pagesToday` and, while it rests, `cooldownUntil`; the state carries `buyerDailyPages`.

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
| `checkIntervalMs` | `1800000` (30 minutes) | Time between background checks of every merchant account. |
| `buyerDailyPages` | `20` | Most pages a task may open with one buyer account in a calendar day, until a tenant sets its own with `setBuyerDailyPages()`. |
| `cooldownHours` | `72` | How long a buyer account rests after the platform's risk control showed. |
| `maxNameLength` | `64` | Longest store or account name, in characters. |

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the skill registry and the bash tool. While a tenant is signed in, the skill catalog lists `ecommerce-accounts`, whose description reads `Read store data with the e-commerce accounts (Tmall, Taobao, Pinduoduo, Douyin shop) the user signed in to in DSH, through the dsh-ecommerce command: list the accounts, pick the merchant account, and take over its signed-in Chrome.`; its body (`SKILL_CONTENT` in `src/skill.ts`) explains the commands, what DSH enforces (merchant accounts open no public pages, a buyer account's daily page limit, and stopping at risk control), and the rules for picking a merchant account: use the only signed-in one and say which store, ask when there are several, one account per task, no switching after a failure, stop and point to Settings when none is signed in, and only read. `dsh-ecommerce` prints the accounts or the browser address to stdout, which the bash result carries, or one of these lines to stderr with exit status 1: `DSH: the <platform> account "<store>" is signed out. Stop, and ask the user to sign in again in DSH Settings → E-commerce accounts (设置 → 电商账号).`, `DSH: the <platform> account "<store>" could not be checked: <reason>. Stop, and tell the user; they can check it in DSH Settings → E-commerce accounts (设置 → 电商账号).`, `DSH: the <platform> account "<store>" is in use by another task. Tell the user and stop; do not switch to another account.`, `DSH: the <platform> account "<store>" is being signed in in DSH Settings. Tell the user and stop.`, `DSH: there is no e-commerce account "<id>". Run dsh-ecommerce accounts to list them.`, `DSH: the <platform> buyer account "<account>" is resting after the platform's risk control until <time>. Do not use it before then.`, `DSH: the <platform> buyer account "<account>" has opened its <n> pages for today. It can be used again tomorrow.`, `DSH: no buyer account can be used now. Stop, and tell the user why:` followed by one line per buyer account, `DSH: there is no buyer account for this. Stop, and ask the user to add one in DSH Settings → E-commerce accounts (设置 → 电商账号).`, `DSH: buyer accounts are on tmall and taobao, not "<platform>".`, `DSH: DSH is signed out of the user center, so there are no e-commerce accounts.`, or `DSH: this shell call can no longer reach the e-commerce accounts.` once the call has ended; a page DSH's watch refuses fails in the script with `net::ERR_BLOCKED_BY_CLIENT`.

#### KV Cache effect

No direct effect; the skill catalog consumer appends a replacement catalog message when the Skill joins or leaves, on signing in to or out of the user center.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No JD or 1688** — and buyer accounts only on Tmall and Taobao.
- **Risk control seen only as a page** — DSH notices the platform's risk control by its verification or block page (`_____tmd_____`, `/punish`); a degraded answer such as `pcIdentityRisk` does not rest the account.
- **Pages counted while a task uses the account** — pages opened by hand in the account's Chrome, or by DSH's own checks, do not count toward the daily limit.
- **Names the platforms report** — only Tmall names the signed-in account; Pinduoduo and Douyin shops name the store instead, which the Settings section compares with the store name entered, and Taobao names neither.
- **Checks follow the platforms' pages** — each check depends on one page and API of its platform; when a platform changes them, its accounts read `timeout` or `signed-out` until the check is updated.
- **Bash only, POSIX only** — `dsh-ecommerce` is a POSIX shell script that needs `curl`; PowerShell and Windows get no command.
- **Reservations last one bash call** — a task that needs an account across several bash calls takes it again in each; another task may take it in between.
- **The browser address grants full control** — a script given `cdpUrl` can do anything the signed-in account can; only the Skill's instructions keep it to reading.
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
