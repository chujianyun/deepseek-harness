---
description: "Host Remote owner for settings and credential configuration surfaces, including redacted reads, writes, credential references, account sign-in, and native document opening."
kind: "package-reference"
---
# Settings Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-settings-controller` exposes generated `ctx.remote.settings`, `ctx.remote.credentials`, and `ctx.remote.authorization` namespaces for browser configuration surfaces. It returns redacted settings and credential metadata, supports settings and credential writes without returning secret values, runs account sign-in flows to a stored credential, and opens provider-owned settings or Agent preset locations on the Host desktop. When a provider is absent, the namespace remains registered and returns an actionable configuration error.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile that serves browser configuration. The entry registers all three namespaces independently of their providers so a missing provider produces a named configuration error at invocation. Its generated descriptors enter the strict Typert registry, while the settings and credential Definitions remain plain Cordis Services with no wire obligations of their own.

`describe(refs)` answers one map keyed by the requested names, so a settings page describing every reference its rows carry settles those rows together. It accepts at most 64 names per call, reports an invalid name or empty write value as `bad-request`, and copies each answer field by field — a provider returning more than `CredentialInfo` declares cannot widen what crosses. Valid `set(ref, value)` and `unset(ref)` calls report a provider refusal as `credential-rejected`, carrying the provider's message with only the reference in its details. Secret values cross in this direction only: no method here returns one.

`authorization.list()` describes every flow registered with `ctx.authorization`: its credential record key, label, methods, whether a credential is stored, and the latest attempt started here. `begin(key, method?)` starts an attempt or returns the one already running for that key, so two open pages share it; a key no flow claims, a method the flow does not offer, a method other than the running attempt's, or an attempt another surface is running is refused as `authorization-rejected`, and malformed arguments as `bad-request`. The attempt keeps the flow's notices — pages to open and device codes — and its open questions; `answer(attemptId, promptId, value)` and `decline(attemptId, promptId)` settle a question, `cancel(attemptId)` withdraws the attempt, and a stale attempt or question is refused as `authorization-not-found`. A failed attempt shows a fixed message: a flow's own error can quote the token server's response, so only the text before any embedded JSON reaches the Host log. `signOut(key)` cancels a running attempt, waits for it to end — one already committing finishes its write — and then deletes the stored record. `watch()` streams every flow's view now and after each change; answers, including `secret` ones, never appear in a view.

`settings.describe()` returns deployment facts and every namespace under `redactSecrets: true`. `settings.update`, `settings.replace`, and `settings.mutate` expose the settings service's three write operations and return the namespace's new redacted view; stale writes use `settings-conflict` and other provider refusals use `settings-rejected`.

`settings.openSettingsDocument()` prepares the provider-owned document and opens it with the native text editor; it accepts no browser-supplied filesystem target.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-settings-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as settings, credential, and sign-in configuration are browser and Host state and register no prompt, tool, or session event.

#### KV Cache effect

No direct effect; reading or writing these configuration values does not alter model requests already in flight.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The batch bound is fixed at 64 references and is not a deployment-configurable field.
- An attempt keeps its latest 20 notices; the bound is fixed, like the batch bound.
- A sign-in attempt lives in the Host process: restarting the Host abandons it, and `watch()` reports a flow registered after the stream opened only with the next change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
