# 电商账号

[English](ecommerce-accounts.md) | 中文

电商账号让桌面版用户把 DSH 登录到公司经营的电商平台，支持天猫、淘宝、拼多多和抖店的商家账号。电商账号、商家账号、买家账号等术语定义在[术语表](../glossary.zh.md#ecommerce-account)中；每个账号为何是一份由系统 Google Chrome 保存的登录，记录在[电商账号 Agent Note](../../.agents/notes/proposed/feature/2026-10-07-ecommerce-accounts-over-store-session.zh.md) 中。[`@deepseek-ai/dsh-ecommerce-accounts`](../../packages/ecommerce/ecommerce-accounts/README.zh.md) 管理账号及其 Chrome 进程；[`@deepseek-ai/dsh-client-ui-ecommerce-accounts`](../../packages/client/ui-ecommerce-accounts/README.zh.md) 渲染设置分区。

## 存储

账号属于当前 Hub 登录所在的租户。`<dshHome>/ecommerce/<tenantId>/accounts.json` 列出账号的平台、类型、店铺名、账号名、平台最近一次报告的名称，以及是否曾经登录成功。每个账号的 Chrome 数据存放在 `browsers/<accountId>/user-data/`，旁边的 `chrome.json` 记录其运行中 Chrome 的进程 id 和远程调试端口。DSH 不保存密码或 cookie：登录态就是那份 Chrome 配置里保存的内容。

## 登录

登录时以脱离方式在该账号的数据上启动系统 Google Chrome，远程调试端口只监听 `127.0.0.1`，并在屏幕上的窗口里打开平台登录页。用户在那里扫码或用密码登录。DSH 通过 Chrome DevTools Protocol 查看该标签页，标签页离开登录页后或每隔半分钟检查一次账号；用户也可以要求立即检查。十分钟内没有完成的登录会结束。

## 检查

一次检查在后台标签页打开平台的业务页面，读取平台自己在该页返回的登录响应，失败时重试一次：天猫的 `mtop.user.getusersimple`（会给出账号名）、淘宝千牛的 `mtop.taobao.jdy.resource.shop.info.get`、拼多多的 `janus/api/checkLogin`，或抖店的 `byteshop/menu/list/v2`；拼多多和抖店的页面还会给出店铺名，设置分区会把它与填写的店铺名比较。页面被平台转到登录页时立即判为未登录。在规定时间内没有答复、页面无法加载，或账号的浏览器数据正被一个不是 DSH 启动的 Chrome 占用时，检查以对应的问题（超时、网络、占用）失败，并保留上次的结果。账号在加载时、设置分区打开时以及每隔 30 分钟检查一次；曾经登录、现在未登录的账号为登录过期，桌面版会弹出提示，可直接打开该分区。登录后，该账号的 Chrome 窗口被最小化，Chrome 继续运行。租户的账号加载时以及设置分区打开时，都会检查每个账号。

## 重启之后

Chrome 的生命周期长于 DSH。之后启动的 DSH 会重新连上记录中的 Chrome；它已不在时（例如电脑重启后），曾经登录过的账号会重新启动 Chrome、将其最小化并恢复上次会话，再由检查判断平台是否保留了登录。删除账号会先关闭其 Chrome 让它写入 cookie，再删除其数据。

## 模型使用

租户登录期间，`ecommerce-accounts` Skill 告诉模型如何使用这些账号以及如何挑选商家账号；模型 shell 的 `PATH` 上的 `dsh-ecommerce` 命令通过一个本地回环端点访问它们，令牌只在一次 bash 调用内有效。`dsh-ecommerce accounts` 列出账号，不含路径和 cookie；`dsh-ecommerce browser <id>` 检查账号、为该调用占用其浏览器，并交出远程调试地址，供 Skill 脚本连接。账号未登录时任务停止并给出去设置页的指引；别的任务正在使用的账号会被拒绝，直到那次调用结束。

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
