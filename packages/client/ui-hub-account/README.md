---
description: "Desktop Hub sign-in gate for the dsh web client: the full-screen sign-in page while signed out, and the Settings account section with tenant switching and sign-out."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hub-account

English | [中文](README.zh.md)

## Summary

The gate covers the whole application with a full-screen sign-in page while the Host reports no Hub sign-in, and adds a **Skill Hub account** section to Settings showing the signed-in nickname, tenant, and phone with **Switch tenant** and **Sign out**. It reads and acts through the [`hubAccount` Remote](../../credentials/hub-account/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `hub-account` row with the same `disabled` condition; the web-app bundle enables both only for the `desktop` profile with a configured user center. The plugin contributes only in the Desktop renderer (`dshDesktop` present), so a browser tab of the same roster is never gated. It injects `remote.hubAccount`, registers the gate into `shell.overlay` with the id `hub-gate`, and registers the account section into `settings.section` with the id `hub-account` at order -20.

Until the first state arrives the gate shows a checking message. Signed out, it offers **Sign in with the user center**; a sign-in started from this window opens the published authorization page in the system browser as soon as the Host publishes it, while an attempt started elsewhere is only shown. While waiting it offers **Open the sign-in page again** and **Cancel**. A failed attempt shows its reason and **Sign in again**; an expired sign-in explains that running sessions continue but new messages wait for a sign-in. The gate is portaled to the document body above the Desktop onboarding stage, so nothing underneath can be used. Switching tenant signs out first, so the gate returns until the new sign-in completes.

-----

<a id="model-experience"></a>
## Model Experience

None, as the gate and the section only render sign-in state and the Host decides whether a prompt is admitted.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The covered application stays focusable by keyboard** — the gate is a modal dialog drawn over the application, but it does not make the application inert, because the Desktop onboarding stage owns that state for its own lifetime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The view renders the Host's state stream; it keeps no independent sign-in state.
