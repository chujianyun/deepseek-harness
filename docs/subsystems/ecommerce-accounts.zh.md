# 电商账号

[English](ecommerce-accounts.md) | 中文

电商账号让桌面版用户把 DSH 登录到公司经营的电商平台，首先支持天猫商家账号。电商账号、商家账号、买家账号等术语定义在[术语表](../glossary.zh.md#ecommerce-account)中；每个账号为何是一份由系统 Google Chrome 保存的登录，记录在[电商账号 Agent Note](../../.agents/notes/proposed/feature/2026-10-07-ecommerce-accounts-over-store-session.zh.md) 中。[`@deepseek-ai/dsh-ecommerce-accounts`](../../packages/ecommerce/ecommerce-accounts/README.zh.md) 管理账号及其 Chrome 进程；[`@deepseek-ai/dsh-client-ui-ecommerce-accounts`](../../packages/client/ui-ecommerce-accounts/README.zh.md) 渲染设置分区。

## 存储

账号属于当前 Hub 登录所在的租户。`<dshHome>/ecommerce/<tenantId>/accounts.json` 列出账号的平台、类型、店铺名、账号名、平台最近一次报告的名称，以及是否曾经登录成功。每个账号的 Chrome 数据存放在 `browsers/<accountId>/user-data/`，旁边的 `chrome.json` 记录其运行中 Chrome 的进程 id 和远程调试端口。DSH 不保存密码或 cookie：登录态就是那份 Chrome 配置里保存的内容。

## 登录

登录时以脱离方式在该账号的数据上启动系统 Google Chrome，远程调试端口只监听 `127.0.0.1`，并在屏幕上的窗口里打开平台登录页。用户在那里扫码或用密码登录。DSH 通过 Chrome DevTools Protocol 查看该标签页，标签页离开登录页后或每隔半分钟检查一次账号；用户也可以要求立即检查。十分钟内没有完成的登录会结束。

## 检查

一次检查在后台标签页打开平台的业务页面，读取平台自己在该页返回的登录响应（天猫为 `mtop.user.getusersimple`），失败时重试一次。响应中带有账号 nick 即为已登录；没有 nick 为未登录；超时没有响应为检查失败。登录后，该账号的 Chrome 窗口移到屏幕外，Chrome 继续运行。租户的账号加载时以及设置分区打开时，都会检查每个账号。

## 重启之后

Chrome 的生命周期长于 DSH。之后启动的 DSH 会重新连上记录中的 Chrome；它已不在时（例如电脑重启后），曾经登录过的账号会在屏幕外重新启动 Chrome 并恢复上次会话，再由检查判断平台是否保留了登录。删除账号会先关闭其 Chrome 让它写入 cookie，再删除其数据。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 *   `ecommerce-accounts/chrome-missing`, `ecommerce-accounts/chrome-outdated`, or `ecommerce-accounts/browser-failed`.
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
 * Delete an account and its browser data, closing its Chrome first.
 * @param accountId - the account.
 * @returns the state without it.
 * @throws RemoteError `hub-account/signed-out` or `ecommerce-accounts/not-found`.
 */
@Remote async deleteAccount(accountId: string): Promise<EcommerceAccountsState>
```

Source: [`packages/ecommerce/ecommerce-accounts/src/index.ts`](../../packages/ecommerce/ecommerce-accounts/src/index.ts)
<!-- END GENERATED cordis-surface -->
