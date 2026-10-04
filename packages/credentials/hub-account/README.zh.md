---
description: "Desktop 的 Hub 登录：经本机回环回调完成用户中心的 OAuth2 授权码 + PKCE 流程、刷新令牌、hubAccount Remote，以及未登录时拒绝新消息。"
kind: "package-reference"
---
# Hub Account

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-hub-account` 让 Desktop 登录 Skill Hub 的用户中心。它为凭据记录 `hub-account/default` 注册一个 `dsh-authorization` flow：以公共客户端身份走 OAuth2 授权码 + PKCE（`S256`）流程，用户在系统浏览器里登录后，授权码回到 `http://127.0.0.1:<随机端口>/callback`；登录状态通过生成的 `ctx.remote.hubAccount` namespace 对外提供。令牌只留在 Host；access token 在到期前自动刷新；没有登录记录时 Host 拒绝新消息。模型凭据（`deepseek-account`、API Key）是另一条链路，本包从不触碰。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop profile 中把本包挂载为 Loader 条目，配置用户中心地址和为 DSH 登记的公共客户端的 `client_id`；它注入 `credentials` 与 `authorization`。web-app bundle 只在 `desktop` profile 且设置了 `DSH_HUB_ORIGIN` 时启用这一行（`DSH_HUB_CLIENT_ID` 给出客户端），也可以用私有 patch 重写这一行。与之配套的是渲染这份状态的门禁 [`@deepseek-ai/dsh-client-ui-hub-account`](../../client/ui-hub-account/README.zh.md)。

`signIn()` 发起一次登录尝试，已有尝试在进行时直接返回它：在临时的回环端口上监听，把授权页（带 `response_type=code`、配置的 `scope`、`state` 和 `S256` 的 `code_challenge` 的 `/oauth/authorize`）发布在尝试的 `authorizeUrl` 上，然后等待浏览器。`state` 不对的回调得到 400，尝试继续等待；用户中心返回 `error` 时尝试以 `failed` 结束（`access_denied` 记为 `denied`）。授权码带着 `code_verifier` 和同一个 `redirect_uri` 在 `/oauth/token` 换取令牌，`/oauth/userinfo` 提供昵称、手机号、租户和是否管理员，授权记录通过授权会话提交。浏览器页面在尝试结束后才得到应答。`cancelSignIn(attemptId)` 撤回尝试；`signOut()` 删除本地授权记录，并在后台到 `/oauth/revoke` 吊销 refresh token；`switchTenant()` 先退出再发起新的尝试，让用户中心重新给出租户选择。`watch()` 推送状态流，`getState()` 读取一次；两者都不带任何令牌。

access token 在到期前 `refreshMarginMs` 刷新，同时轮换 refresh token。刷新得到 HTTP 400 或 401（员工或租户被停用、授权被吊销或过期）时，删除授权记录、置 `reason: 'expired'` 并发出 `hub-account/session-expired`；网络故障或服务端错误时保留登录，`refreshRetryMs` 后重试。来自其他用户中心或客户端的授权记录视为不存在。`accessToken()` 为 Host 上调用用户中心客户端接口的消费方返回当前令牌，临近到期时先刷新。

未登录时，本包对会话控制器的 `api-session/prompt-admission` 返回 `hub-account/signed-out`，Host 因此拒绝新消息。已经在运行的轮次和已排队的工作照常继续。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `origin` | 必填 | 提供 `/oauth/*` 的用户中心地址；HTTPS，或在 `allowLoopbackHttp` 下的回环 HTTP。 |
| `clientId` | 必填 | 为 DSH 登记的公共客户端的 `client_id`。 |
| `scope` | `profile skills:read skills:write` | 登录时申请的权限范围。 |
| `allowLoopbackHttp` | `false` | 接受回环上的 HTTP 地址，用于开发和测试。 |
| `requestTimeoutMs` | `15000` | 每个用户中心请求的超时。 |
| `attemptTimeoutMs` | `600000` | 一次浏览器登录尝试的上限。 |
| `refreshMarginMs` | `300000` | access token 到期前多久刷新。 |
| `refreshRetryMs` | `60000` | 刷新没有得到明确结论而失败后的重试间隔。 |

-----

<a id="model-experience"></a>
## 模型体验

无，因为登录状态不进入任何模型请求，未登录时被拒绝的消息也不会进入 Session。

#### KV Cache 影响

无影响；被拒绝的消息不会进入 Session。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有一个进程刷新**——共用一个凭据存储的两个 Host 会争抢轮换中的 refresh token，后到的刷新会被拒绝；Desktop 只运行一个 Host。
- **门禁只属于 Desktop 组合**——Web 与 headless 组合不挂载本包，它们的消息不受门禁限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。凭据存储拥有授权记录；门禁和发布的状态在每次记录变化时都从它重新推导。
