---
description: "Desktop Skill Hub account section for the dsh web client: the signed-in employee with tenant switching and sign-out, or the sign-in state with a way to sign in."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hub-account

English | [中文](README.zh.md)

## Summary

Adds a **Skill Hub account** section to Settings showing the signed-in nickname, tenant, and phone with **Switch tenant** and **Sign out**, or, while signed out, the sign-in state with **Sign in to Skill Hub**. It reads and acts through the [`hubAccount` Remote](../../credentials/hub-account/README.md). The Desktop [welcome window](../../../apps/desktop/README.md) keeps the workspace closed while signed out, so the renderer has no sign-in gate of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `hub-account` row with the same `disabled` condition; the web-app bundle enables both only for the `desktop` profile with a configured user center. The plugin contributes only in the Desktop renderer (`dshDesktop` present), so a browser tab of the same roster shows no section. It injects `remote.hubAccount` and registers the account section into `settings.section` with the id `hub-account` at order -20.

Until the first state arrives the section shows a checking message. Signed out, it says **Not signed in to Skill Hub** and offers **Sign in to Skill Hub**; a sign-in or tenant switch started from this window opens the published authorization page in the system browser as soon as the Host publishes it, while an attempt started elsewhere is only shown. While waiting it offers **Open the sign-in page again** and **Cancel**. A failed attempt shows its reason and **Sign in again**; an expired sign-in explains that running sessions continue but new messages wait for a sign-in. A signed-in account without a tenant shows **No company** as its tenant.

-----

<a id="model-experience"></a>
## Model Experience

None, as the section only renders sign-in state and the Host decides whether a prompt is admitted.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- None.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The view renders the Host's state stream; it keeps no independent sign-in state.
