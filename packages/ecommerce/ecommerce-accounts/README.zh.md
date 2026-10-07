---
description: "桌面版电商账号：平台登录由系统 Google Chrome 在每个账号自己的浏览器数据中保存，按租户隔离，并提供 ecommerceAccounts Remote。"
kind: "package-reference"
---
# 电商账号

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-ecommerce-accounts` 管理当前租户的[电商账号](../../../docs/glossary.zh.md#ecommerce-account)，对应 Host 服务 `ctx.ecommerceAccounts` 和 `ecommerceAccounts` Remote 命名空间。用户在系统 Google Chrome 中、在该账号自己的浏览器数据上登录平台；登录态由 Chrome 保存，DSH 不保存密码或 cookie。目前可添加天猫、淘宝、拼多多和抖店的[商家账号](../../../docs/glossary.zh.md#merchant-account)。采用这种做法的原因记录在[电商账号 Agent Note](../../../.agents/notes/proposed/feature/2026-10-07-ecommerce-accounts-over-store-session.zh.md) 中。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop profile 中把本包作为 Loader 条目挂载在 `hub-account`、`skill` 和 `shell-env` 旁边，本包注入这些服务。web-app bundle 在配置了用户中心的 `desktop` profile 中启用它，由 `ui-ecommerce-accounts` 渲染其设置分区。

账号属于当前 Hub 登录所在的租户，存放在 `<dshHome>/ecommerce/<tenantId>/` 下：`accounts.json` 按添加顺序列出账号，`browsers/<accountId>/` 存放每个账号的 Chrome 数据（`user-data/`）和其运行中 Chrome 的记录（`chrome.json`，即进程 id 与远程调试端口）。切换租户会停止进行中的登录并显示另一租户的账号；退出 Hub 登录后没有账号，所有方法都以 `hub-account/signed-out` 拒绝。

`getState()` 与 `watch()` 返回账号列表以及 Chrome 能否运行它们。`chrome.status` 为 `ready`；Google Chrome 不在平台标准安装路径（或 `chromePath`）时为 `missing`；主版本低于 `minChromeVersion` 时为 `outdated`，同时给出 Chrome 报告的版本和下载地址。每个账号带有平台、类型、店铺名、账号名、添加时间、状态——`signed-out`、`signing-in`、`checking`、`signed-in`，或无法询问平台时的 `check-failed`——检查失败时附带 `problem`；曾经登录过、现在未登录的账号带有 `expired`；以及最近一次成功检查时平台报告的账号名和店铺名（`signedInAs`、`signedInStore`，只有会报告的平台才有）和该次检查的时间。

`addAccount(input)` 添加一个初始为未登录的账号。可添加 `tmall`、`taobao`、`pinduoduo`、`doudian` 的商家账号；其余（例如买家账号）以 `ecommerce-accounts/unsupported` 拒绝。店铺名和账号会去掉首尾空白，长度须为 1 到 `maxNameLength` 个字符，否则以 `ecommerce-accounts/invalid-field` 指出字段；平台、类型和账号都相同的账号再次添加时以 `ecommerce-accounts/duplicate` 拒绝。同一店铺的主账号和子账号是两个账号。`renameAccount(id, { account, storeName })` 修改账号名、店铺名或两者（例如改为平台报告的名称），检查规则相同；未给出的字段保持不变。

`startSignIn(id)` 先检查 Chrome（`ecommerce-accounts/chrome-missing`、`ecommerce-accounts/chrome-outdated`）；若该账号的数据正被一个不是 DSH 启动的 Chrome 占用（Chrome 在其中留下的 `SingletonLock` 指向一个运行中的进程），则以 `ecommerce-accounts/browser-busy` 拒绝；然后重新连上该账号的 Chrome 或启动它，在新标签页打开平台登录页，并把窗口移到屏幕上；Chrome 无法启动或连接时以 `ecommerce-accounts/browser-failed` 拒绝。Chrome 以脱离方式启动：`--user-data-dir` 指向该账号的数据，远程调试端口只监听 `127.0.0.1`，带 `--restore-last-session`，偏好设置为恢复上次会话，并从其环境中去掉 DSH 自己的变量。启动的 Chrome 能连上后，DSH 会关闭它在恢复的标签之外积累的空白页；所有标签都是空白页时保留一个。账号保持 `signing-in`，直到平台表示已登录，或超过 `signInTimeoutMs` 后回到 `signed-out`。服务每隔 `signInPollMs` 查看登录标签页；标签页离开登录页或被关闭后，或每隔 `signInCheckEveryMs`，检查该账号。**我已完成登录**按钮背后的 `confirmSignIn(id)` 立即检查。

一次检查在后台标签页打开平台的业务页面，读取平台自己在该页返回的结果，失败时重试一次。天猫首页发出 `mtop.user.getusersimple`，带 nick 即为已登录；淘宝千牛工作台发出 `mtop.taobao.jdy.resource.shop.info.get`，成功即为已登录；拼多多后台首页发出 `janus/api/checkLogin`（看其 `result.login`）和给出店铺名的 `earth/api/mallInfo/querySimpleCredential`；抖店首页发出 `byteshop/menu/list/v2`（菜单非空即为已登录）和给出店铺名的 `center/qualification/shop/info`。已登录的答复会等店铺名到 `checkTimeoutMs` 为止，没等到也仍为已登录。业务页面被平台转到登录页时，立即判为未登录。之后关闭该标签页。已登录的账号为 `signed-in`，其 Chrome 窗口被最小化，Chrome 在看不见的地方继续运行（macOS 会让移到屏幕外的窗口始终露出一部分）。检查失败时保留上次的结果，状态为 `check-failed` 并附带 `problem`：在 `checkTimeoutMs` 内没有答复为 `timeout`；业务页面无法加载（Chrome 的导航错误）为 `network`；账号数据正被一个不是 DSH 启动的 Chrome 占用为 `busy`，此时 DSH 不启动 Chrome。同一账号的检查不会同时进行。租户的账号加载时、每隔 `checkIntervalMs`、以及调用 `refresh()` 时检查每个账号；设置分区打开时会调用 `refresh()`，它也会重新查找 Chrome。

Chrome 的生命周期长于 DSH。下一次启动的 DSH 通过记录重新连上账号的 Chrome；该 Chrome 已不在时，曾经登录过的账号会重新启动 Chrome、将其最小化并恢复上次会话，从未登录过的账号保持 `signed-out`，不启动 Chrome。`deleteAccount(id)` 停止进行中的登录，通过 `Browser.close` 关闭该账号的 Chrome 让其写入 cookie（之后依次 `SIGTERM`、`SIGKILL`），再删除该账号的浏览器数据及其账本行。未知 id 以 `ecommerce-accounts/not-found` 拒绝。

租户已登录时，模型和 Skill 脚本通过 `dsh-ecommerce` 命令使用这些账号：本包把它写到 `<dshHome>/ecommerce/bin/`，并通过 `ctx.shellEnv.registerPath()` 放在模型 shell 的 `PATH` 前面。该命令是一个用 `curl` 调用本地回环 HTTP 端点的 POSIX shell 脚本；每次 bash 调用都通过 `DSH_ECOMMERCE_URL` 拿到带有自己随机令牌的端点地址，令牌在该调用的 `tools/result` 时失效。`dsh-ecommerce accounts` 以 JSON 输出租户的账号——id、平台、店铺、账号、类型、状态以及检查失败的原因——从不输出路径、cookie 或浏览器地址。`dsh-ecommerce browser <id>` 为该调用占用账号的浏览器，立即检查账号，并输出账号及 `cdpUrl`，即其已登录 Chrome 的远程调试地址；新占用在检查失败时解除，占用随调用结束而结束。别的调用请求已被占用或正在登录的账号会被拒绝；任务使用账号期间，`startSignIn()` 和 `deleteAccount()` 也会被拒绝（`ecommerce-accounts/in-use`），`refresh()` 不检查被占用的账号。账号视图的 `inUse` 让设置分区知道这一点。租户登录期间通过 `ctx.skills.register()` 注册的 `ecommerce-accounts` Skill 向模型说明这些命令和挑选商家账号的规则。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Harness 主目录；账号存放在 `<dshHome>/ecommerce` 下。 |
| `chromePath` | 标准 Google Chrome 安装 | 改用的 Chrome 可执行文件。 |
| `minChromeVersion` | `120` | 账号可运行的最低 Chrome 主版本。 |
| `signInTimeoutMs` | `600000`（10 分钟） | 一次登录等待用户的时长。 |
| `checkTimeoutMs` | `20000` | 一次检查等待平台响应的时长。 |
| `chromeTimeoutMs` | `20000` | DSH 等待 Chrome 启动或关闭的时长。 |
| `signInPollMs` | `3000` | 两次查看登录标签页的间隔。 |
| `signInCheckEveryMs` | `30000` | 即使登录标签页尚未离开登录页，也要检查一次的间隔。 |
| `checkIntervalMs` | `1800000`（30 分钟） | 后台检查所有账号的间隔。 |
| `maxNameLength` | `64` | 店铺名或账号的最大字符数。 |

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过 skill registry 和 bash 工具。租户登录期间，Skill 目录列出 `ecommerce-accounts`，其描述为 `Read store data with the e-commerce accounts (Tmall, Taobao, Pinduoduo, Douyin shop) the user signed in to in DSH, through the dsh-ecommerce command: list the accounts, pick the merchant account, and take over its signed-in Chrome.`；其正文（`src/skill.ts` 中的 `SKILL_CONTENT`）说明这些命令以及挑选商家账号的规则：只有一个已登录的就直接用并说明用了哪家店，有多个时先问，一次任务只用一个账号，失败后不换店，没有已登录的就停止并引导到设置页，并且只读。`dsh-ecommerce` 把账号列表或浏览器地址输出到 stdout，由 bash 结果带给模型；或以退出码 1 在 stderr 输出以下之一：`DSH: the <platform> account "<store>" is signed out. Stop, and ask the user to sign in again in DSH Settings → E-commerce accounts (设置 → 电商账号).`、`DSH: the <platform> account "<store>" could not be checked: <reason>. Stop, and tell the user; they can check it in DSH Settings → E-commerce accounts (设置 → 电商账号).`、`DSH: the <platform> account "<store>" is in use by another task. Tell the user and stop; do not switch to another account.`、`DSH: the <platform> account "<store>" is being signed in in DSH Settings. Tell the user and stop.`、`DSH: there is no e-commerce account "<id>". Run dsh-ecommerce accounts to list them.`、`DSH: DSH is signed out of the user center, so there are no e-commerce accounts.`，或调用结束后的 `DSH: this shell call can no longer reach the e-commerce accounts.`。

#### KV Cache 影响

无直接影响；登录或退出用户中心使该 Skill 加入或离开目录时，Skill 目录的使用方会追加一条替换目录的消息。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **仅支持商家账号** — 买家账号、京东和 1688 暂不能添加。
- **平台报告的名称** — 只有天猫报告登录的账号名；拼多多和抖店报告店铺名，设置分区会把它与填写的店铺名比较；淘宝两者都不报告。
- **检查依赖平台页面** — 每个检查都依赖平台的一个页面和接口；平台改版后，在检查更新之前，其账号会显示 `timeout` 或 `signed-out`。
- **仅限 bash、仅限 POSIX** — `dsh-ecommerce` 是需要 `curl` 的 POSIX shell 脚本；PowerShell 和 Windows 没有该命令。
- **占用只持续一次 bash 调用** — 需要在多次 bash 调用中使用同一账号的任务，每次都要重新占用；其间别的任务可能占用它。
- **浏览器地址等于完全控制** — 拿到 `cdpUrl` 的脚本可以做该已登录账号能做的任何事；只有 Skill 的说明约束它只读。
- **平台会话时长** — 登录态的有效期取决于平台保留会话的时长；电脑重启后，只有平台保留的会话 cookie 才会被 Chrome 恢复，否则账号显示 `signed-out`，需要重新登录。
- **Chrome 持续运行** — DSH 退出后，已登录账号的 Chrome 仍以最小化状态运行，用户会在程序坞中看到它。
- **本地调试端口** — 已登录账号的 Chrome 在 `127.0.0.1` 上监听远程调试端口，运行期间用户运行的任何程序都能操控它。
- **未在 Windows 上验证** — Windows 只在 CI 中运行，未在真机上测试登录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。服务拥有账本；登录态本身在每次检查时都从平台自己的响应读取，不存在可能与之不一致的第二份记录。
