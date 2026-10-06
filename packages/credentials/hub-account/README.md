---
description: "Hub sign-in for Desktop: the user center's OAuth2 authorization code flow with PKCE over a loopback callback, token refresh, the hubAccount Remote, and refusal of new prompts while signed out."
kind: "package-reference"
---
# Hub Account

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-hub-account` signs Desktop in to the Skill Hub's user center. It registers a `dsh-authorization` flow for the credential record `hub-account/default` that runs the OAuth2 authorization code flow with PKCE (`S256`) as a public client, receiving the code on `http://127.0.0.1:<random port>/callback` after the human signs in in the system browser, and it exposes the sign-in state as the generated `ctx.remote.hubAccount` namespace. Tokens stay on the Host; the access token is refreshed before it expires, and while no sign-in is stored the Host refuses new prompts. Model credentials (`deepseek-account`, API keys) are a separate chain this package never touches.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in the Desktop profile with the user center's origin and the `client_id` of the public client registered for DSH; it injects `credentials` and `authorization`. The web-app bundle enables the row only for the `desktop` profile when `DSH_HUB_ORIGIN` is set (`DSH_HUB_CLIENT_ID` names the client), and a private patch may restate the row instead. Pair it with [`@deepseek-ai/dsh-client-ui-hub-account`](../../client/ui-hub-account/README.md), the Settings section that renders this state; the Desktop [welcome window](../../../apps/desktop/README.md) reads the same state and opens the workspace only while signed in.

`signIn()` starts one attempt, or returns the running one: it listens on an ephemeral loopback port, publishes the authorization page (`/oauth/authorize` with `response_type=code`, the configured `scope`, `state`, and an `S256` `code_challenge`) on the attempt's `authorizeUrl`, and waits for the browser. A callback with the wrong `state` gets 400 and the attempt keeps waiting; an `error` from the user center ends it as `failed` (`denied` for `access_denied`). The code is exchanged at `/oauth/token` with the `code_verifier` and the same `redirect_uri`, `/oauth/userinfo` supplies the nickname, phone, tenant, and administrator flag, and the grant is committed through the authorization session. The browser page answers only after the attempt settles. `cancelSignIn(attemptId)` withdraws it, `signOut()` deletes the local grant and revokes the refresh token at `/oauth/revoke` in the background, and `switchTenant()` signs out and starts a new attempt, so the user center offers the tenant choice again. `watch()` streams the state; `getState()` reads it once. Neither ever carries a token.

The access token is refreshed `refreshMarginMs` before it expires, rotating the refresh token. A refresh answered with HTTP 400 or 401 (employee or tenant disabled, grant revoked or expired) deletes the grant, sets `reason: 'expired'`, and emits `hub-account/session-expired`; a network failure or server error keeps the sign-in and retries after `refreshRetryMs`. A stored grant from another user center or client is treated as absent. `accessToken()` returns the current token for Host consumers of the user center's client APIs, refreshing first when it is due. `request(path, init)` calls a client API (`/api/client/*`) as the signed-in employee, refreshing once and retrying when the token is rejected, and fails with `hub-account/signed-out` when no sign-in is stored; the token never leaves the Host.

While signed out, the package answers the session controller's `api-session/prompt-admission` with `hub-account/signed-out`, so the Host refuses new prompts. Turns that are already running, and work already queued, continue.

After each sign-in, and once per startup while signed in, the package reads the tenant's branding (login-page logo and welcome title, new-session slogan) from `GET /api/client/branding` and downloads its logo from the fixed path `/api/client/branding/logo` (never from a URL in the response, so the access token stays on the user center). A logo whose type differs from the declared one or is not PNG, JPEG, or SVG, that exceeds 512 KB, or whose sha256 differs from the declared one is left out; a logo whose sha256 matches the cached one is not downloaded again. The result replaces the cache under `<dshHome>/cache/hub-branding` (a record with the user-center origin and tenant id, and the logo file named by its sha256); a tenant that set none of the three clears it, and an answer without `slogan` (a user center before T45) counts as no slogan. A failed or malformed answer keeps the cache. `getBranding()` returns the cached `{tenantId, title, slogan, logo}` with the logo as a `data:` URL for an `<img>`, and every state carries a `branding` stamp (`tenantId`, `title`, `slogan`, `logoSha256`) that changes with the cache. Signed in, both show only the signed-in tenant's branding; signed out, the last-signed-in tenant's. A cache written for another user center is ignored.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `origin` | required | User-center origin serving `/oauth/*`; HTTPS, or HTTP on loopback with `allowLoopbackHttp`. |
| `clientId` | required | `client_id` of the public client registered for DSH. |
| `scope` | `profile skills:read skills:write` | Scopes requested at sign-in. |
| `allowLoopbackHttp` | `false` | Accept an HTTP origin on loopback, for development and tests. |
| `requestTimeoutMs` | `15000` | Deadline of each user-center request. |
| `attemptTimeoutMs` | `600000` | Upper bound of one browser sign-in attempt. |
| `refreshMarginMs` | `300000` | Refresh the access token this long before it expires. |
| `refreshRetryMs` | `60000` | Retry delay after a refresh that failed without a verdict. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home; the branding cache lives under `<dshHome>/cache/hub-branding`. |

-----

<a id="model-experience"></a>
## Model Experience

None, as no sign-in state reaches a model request and a prompt refused while signed out never reaches a Session.

#### KV Cache effect

No effect; a refused prompt never enters a Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One process refreshes** — two Hosts sharing one credential store would race the rotating refresh token, and the loser's refresh is refused; Desktop runs one Host.
- **The gate is the Desktop composition's** — Web and headless compositions do not mount this package, so their prompts are never gated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The credential store owns the grant; the prompt gate and the published state are re-derived from it on every record change.
