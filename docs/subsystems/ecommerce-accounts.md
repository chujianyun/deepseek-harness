# E-commerce accounts

English | [中文](ecommerce-accounts.zh.md)

E-commerce accounts let a Desktop user sign DSH in to the e-commerce platforms their company sells on, with merchant accounts on Tmall, Taobao, Pinduoduo, and Douyin shops (抖店). The vocabulary — e-commerce account, merchant account, buyer account — is defined in the [glossary](../glossary.md#ecommerce-account), and why each account is a sign-in kept by the system Google Chrome is recorded in the [e-commerce accounts Agent Note](../../.agents/notes/proposed/feature/2026-10-07-ecommerce-accounts-over-store-session.md). [`@deepseek-ai/dsh-ecommerce-accounts`](../../packages/ecommerce/ecommerce-accounts/README.md) owns the accounts and their Chrome processes; [`@deepseek-ai/dsh-client-ui-ecommerce-accounts`](../../packages/client/ui-ecommerce-accounts/README.md) renders the Settings section.

## Storage

Accounts belong to the tenant of the current Hub sign-in. `<dshHome>/ecommerce/<tenantId>/accounts.json` lists them with their platform, kind, store name, account name, the name the platform last reported, and whether a sign-in ever succeeded. Each account's Chrome data lives in `browsers/<accountId>/user-data/`, beside `chrome.json`, the process id and remote-debugging port of its running Chrome. DSH stores no password or cookie: the sign-in is whatever that Chrome profile holds.

## Signing in

Signing in starts the system Google Chrome detached on the account's data, with a remote-debugging port on `127.0.0.1`, and opens the platform's sign-in page in a window on screen. The user signs in there, by scanning the QR code or with a password. DSH watches the tab over the Chrome DevTools Protocol and, once it leaves the sign-in page or every half minute, checks the account; the user can also ask for a check at once. A sign-in not finished within ten minutes ends.

## Checking

A check opens the platform's business page in a background tab and reads the platform's own sign-in response there, retrying once: Tmall's `mtop.user.getusersimple` (which names the account), Taobao Qianniu's `mtop.taobao.jdy.resource.shop.info.get`, Pinduoduo's `janus/api/checkLogin`, or a Douyin shop's `byteshop/menu/list/v2`; Pinduoduo and Douyin shop pages also name the store, which the Settings section compares with the store name entered. A page the platform sends to sign in is signed out at once. A check that gets no answer in time, cannot load the page, or finds the account's browser data held by a Chrome DSH did not start fails with that problem — timeout, network, or busy — and keeps the last answer. Accounts are checked when they load, when the Settings section opens, and every 30 minutes; an account that was signed in and is now signed out is expired, which the Desktop announces with a notice that opens the section. Once signed in, the account's Chrome windows are minimized and Chrome keeps running. Every account is checked when the tenant's accounts load and when the Settings section opens.

## Across restarts

Chrome outlives DSH. A later DSH reattaches to the recorded Chrome; when it is gone, as after a computer restart, an account that was ever signed in has Chrome started again, minimized, with its last session restored, and the check tells whether the platform kept the sign-in. Deleting an account closes its Chrome so it writes its cookies, then deletes its data.

## Use by the model

While a tenant is signed in, the `ecommerce-accounts` Skill tells the model how to use the accounts and pick a merchant account, and the `dsh-ecommerce` command on the model shell's `PATH` reaches them through a loopback endpoint with a token valid for one bash call. `dsh-ecommerce accounts` lists the accounts without paths or cookies; `dsh-ecommerce browser <id>` checks the account, reserves its browser for the call, and hands over its remote-debugging address, which Skill scripts connect to. A signed-out account stops the task with the way to Settings; an account another task uses is refused until that call ends.

## Buyer accounts and risk protection

Buyer accounts on Tmall and Taobao only view public product pages, and DSH, not the model, keeps them safe: while a task uses an account, DSH watches its browser through its own DevTools connection and pauses every page load. A merchant account opens no public product or search page. A buyer account opens at most the tenant's daily page limit (20 by default, set in Settings), counted by calendar day; once the platform's risk control shows, DSH loads nothing more for the task and rests the account for 72 hours. `dsh-ecommerce buyer` picks the usable buyer account that opened the fewest pages today, or says why none can be used. Buyer accounts are not checked in the background, since each check opens a page the platform counts.

## Tmall data skills

The skills that use the accounts are not shipped with DSH: [`@deepseek-ai/dsh-tmall-skills`](../../packages/ecommerce/tmall-skills/README.md) builds `tmall-alimama-scene-report` (Alimama's figures per marketing scene for one day) and `tmall-sycm-core-daily` (Business Advisor's 「店铺经营核心日报」, with its advertising spend checked against Alimama) into Skill Hub upload packages, which a tenant's admin publishes to that tenant only. Each skill's script takes over a Tmall merchant account with `dsh-ecommerce browser`, calls the API the platform's own page calls, and runs under the Node that `load_workspace_dependencies` returns; it writes nothing when the platform has not finished the day. A third skill, `tmall-item-report`, uses `dsh-ecommerce buyer` instead: it opens one public item page per item with the buyer account DSH picks, reads the item, 问大家, and reviews through the page's own APIs, stops at the first risk control or when the account's pages for the day are used, and keeps everything read before.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxecommerceaccounts--ecommerceaccountsservice"></a>

### `ctx.ecommerceAccounts` — `EcommerceAccountsService`

Host owner of the e-commerce accounts and of the `ecommerceAccounts` Remote namespace.

```ts cordis-catalog
/**
 * Read the signed-in tenant's accounts and whether Chrome can run them.
 * @returns the state the settings page shows.
 */
@Remote getState(): Promise<EcommerceAccountsState>

/**
 * Stream the state.
 * @param signal - stream lifetime.
 * @returns the current state, then every change.
 */
@Remote({ mode: 'stream' }) async *watch(signal: AbortSignal): AsyncIterable<EcommerceAccountsState>

/**
 * Add an account for the signed-in tenant; it starts signed out.
 * @param input - platform, kind, store name, and account.
 * @returns the new account's id and the state with it last.
 * @throws RemoteError `hub-account/signed-out`, `ecommerce-accounts/unsupported`,
 *   `ecommerce-accounts/invalid-field`, or `ecommerce-accounts/duplicate`.
 */
@Remote addAccount(input: AddEcommerceAccountInput): Promise<AddEcommerceAccountResult>

/**
 * Open the platform's sign-in page in the account's own Chrome and wait for the user to sign in;
 * the account turns signed in by itself once the platform says so.
 * @param accountId - the account.
 * @returns the state with the account signing in.
 * @throws RemoteError `hub-account/signed-out`, `ecommerce-accounts/not-found`,
 *   `ecommerce-accounts/chrome-missing`, `ecommerce-accounts/chrome-outdated`, `ecommerce-accounts/browser-busy`,
 *   or `ecommerce-accounts/browser-failed`.
 */
@Remote async startSignIn(accountId: string): Promise<EcommerceAccountsState>

/**
 * Check now whether the user finished signing in, as the "I have signed in" button asks.
 * @param accountId - the account.
 * @returns the state after the check.
 * @throws RemoteError `hub-account/signed-out` or `ecommerce-accounts/not-found`.
 */
@Remote async confirmSignIn(accountId: string): Promise<EcommerceAccountsState>

/**
 * Check every account that is not signing in, and look for Chrome again.
 * @returns the state after the checks.
 */
@Remote async refresh(): Promise<EcommerceAccountsState>

/**
 * Set the tenant's daily page limit for buyer accounts.
 * @param pages - the most pages a task may open with one buyer account in a calendar day.
 * @returns the state with the new limit.
 * @throws RemoteError `hub-account/signed-out`, or `ecommerce-accounts/invalid-field` for a
 *   limit that is not a whole number from 1 to 1000.
 */
@Remote setBuyerDailyPages(pages: number): Promise<EcommerceAccountsState>

/**
 * Change the account or store name the user entered, such as to the name the platform reports.
 * @param accountId - the account.
 * @param changes - the new account name, store name, or both; a field left out stays.
 * @returns the state with the account renamed.
 * @throws RemoteError `hub-account/signed-out`, `ecommerce-accounts/not-found`,
 *   `ecommerce-accounts/invalid-field`, or `ecommerce-accounts/duplicate`.
 */
@Remote renameAccount(accountId: string, changes: RenameEcommerceAccountInput): Promise<EcommerceAccountsState>

/**
 * Delete an account and its browser data, closing its Chrome first.
 * @param accountId - the account.
 * @returns the state without it.
 * @throws RemoteError `hub-account/signed-out` or `ecommerce-accounts/not-found`.
 */
@Remote async deleteAccount(accountId: string): Promise<EcommerceAccountsState>
```

Source: [`packages/ecommerce/ecommerce-accounts/src/index.ts`](../../packages/ecommerce/ecommerce-accounts/src/index.ts)
<!-- END GENERATED cordis-surface -->
