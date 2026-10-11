---
description: "Problem reports from Desktop: category, description, images, environment details, and optionally the Session conversation, sent to the super administrators of the user center."
kind: "package-reference"
---
# Feedback Report

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-feedback-report` sends problem reports to the user center of the current [Hub sign-in](../../credentials/hub-account/README.md), where its super administrators list and handle them. The `feedbackReport` Remote's `submit(request)` sends the user's category, description, and images with the environment this Host sees, and optionally the conversation snapshot of the Session the report is about. Thumbs-down feedback the user explained with a category or note is reported the same way.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry beside the Hub sign-in; it injects `hubAccount` and `sessionQuery` and reads `assistants` with `ctx.get` to name the Session's assistant. The web-app bundle enables it for Desktop with a configured user center. `appVersion` is the Desktop client version shown to administrators (the bundle passes `DSH_CLIENT_VERSION`), and `requestTimeoutMs` (default 120000) is the deadline of each report.

`submit({ category, description, sessionId, attachSession, images, uiLanguage })` takes a category (`error`, `lag`, `unavailable`, `wrong-result`, or `other`), a description of 1 to 2000 characters after trimming, the Session the report is about (or null), whether to attach its conversation, at most three images (PNG, JPEG, WebP, or GIF, base64, at most 5 MB each), and the UI language. It returns the stored report's `id` and `createdAt`.

### What a report carries

- **Environment**: `appVersion`, `os` (platform and release), `arch`, `locale` (the UI language), `tenant` (the signed-in tenant's name), and, read from the Session's log, `model` (provider, model, and reasoning effort of its last selection, or the model its last request was sent to when that came later, as for a Session that kept the default) and `assistant` (the name of its bound assistant, when the tenant still has it). A thumbs-down report adds `ratedReply`, the first 200 characters of the rated reply. Absent values are left out; a Session whose log cannot be read is reported without its details.
- **Session**: with `attachSession` and a Session that holds a conversation, its title (from the log's last `session/title`) and the same snapshot [session-share](../../session-query/session-share/README.md) shares: typed user messages and assistant replies with tool calls by name and summary. Attachment contents and subagent logs stay out. When the user center refuses the report with status 413 while a conversation is attached, the report is sent again without it and with `sessionOmitted: too-large` in the environment.

On [`feedback/message-recorded`](../message-feedback/README.md), when a rating becomes a thumbs-down with a category or note (a new one, or one that was not explained before), the service reports it once in the background; editing an explained thumbs-down does not report it again. The report carries source `message`, the feedback category (`other` when none), the note as the description (a placeholder when none), and the Session snapshot. A plain rating or a thumbs-up is not reported; a failed report is logged and the rating stays recorded in the Session.

### Errors

`feedback-report/signed-out` without a Hub sign-in. `feedback-report/invalid` before anything is sent, with `reason` `description`, `images`, `image-type`, or `image-size`. A refusal by the user center, or an answer that is not a receipt with an ISO 8601 time, is `feedback-report/refused` with its HTTP `status` and its own reason as the message. A request that gets no answer, or misses the deadline, is `feedback-report/unreachable`.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package reads the Session log and writes nothing to it; nothing here reaches a model request.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No outbox** — a report that fails is not kept for a later retry; the user sends it again.
- **Images travel as base64** — images cross the Remote as base64 strings, so the browser shrinks screenshots before sending.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
