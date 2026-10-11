---
description: "Problem report of the dsh Desktop client: the Report a problem button in the Session header, the dialog it opens, and the notice after a report is sent to the user center's super administrators."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-feedback-report

English | [中文](README.zh.md)

## Summary

Adds **Report a problem** to the Session header and the dialog it opens. The dialog collects a problem type, a description, up to three screenshots, and whether to include the Session's conversation, and sends them through the [`feedbackReport` Remote](../../feedback/feedback-report/README.md) to the super administrators of the user center.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `feedback-report` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. Like ui-hub-account, it adds nothing outside the Desktop window. The plugin injects `slots`, `locale`, and the `hubAccount` and `feedbackReport` Remotes. For exactly the plugin lifetime it registers the `feedback-report` entry of `conversation.session.header.utilities` at order -8 (left of the schedule catalog), and the `feedback-report` and `feedback-report.notice` entries of `shell.overlay`. The enterprise Desktop composition leaves the header's More actions menu ([session-log-export](../../session-query/session-log-export/README.md)) out, so this button is its feedback entry.

The button shows only while the `hubAccount` state stream reports a sign-in, and asks for the dialog about the open Session.

### The dialog

- **Header** — a warning badge, the title, and a sentence on what to report.
- **Type** — one of Error, Slow, Not working, Wrong result, or Other; required.
- **Description** — required, at most 2000 characters, with a counter.
- **Screenshots** — up to three PNG, JPEG, WebP, or GIF images of at most 5 MB each, picked from the add tile or pasted anywhere in the dialog, with overlapping adds sharing the room; each thumbnail has a remove button. A file over a limit is refused with the reason and the rest are kept.
- **Include this session's conversation** — shown when the report is about a Session, unticked until the user ticks it; its label says the conversation goes to the MO WorkAI platform and not to the company's admins. A ticked conversation over the user center's size limit is dropped by the Host and the report is sent without it.
- **Footer** — a note that the app version, system, and current model are sent along, **Cancel**, and **Submit**, which is enabled once the type and description are set.

While sending, the controls are disabled, a status line says so, and the dialog cannot be closed. A refusal shows in the dialog in the UI language (no sign-in, unreachable server, or the user center's own reason) and the draft stays. A stored report closes the dialog and shows a success notice.

-----

<a id="model-experience"></a>
## Model Experience

None, as the dialog only calls the Host's report service; nothing here reaches a model request.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Session header only** — the button lives in the Session header, so pages without a Session (such as Settings) do not show it.
- **Screenshots are sent as picked** — images are not shrunk before sending, so each must be 5 MB or smaller.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
