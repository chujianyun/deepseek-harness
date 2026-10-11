---
description: "Session sharing: upload a snapshot of one Session's conversation to the user center of the Hub sign-in, read its link, and withdraw it."
kind: "package-reference"
---
# Session Share

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-session-share` shares one Session with the user's company. The `sessionShare` Remote's `share(request)` uploads a snapshot of the conversation to the user center of the current [Hub sign-in](../../credentials/hub-account/README.md), which serves it at a link to signed-in members of the same company. The user center keeps one share per Session and employee, so sharing again replaces the snapshot and keeps the link. `revoke` withdraws it, and deleting a Session this machine shared withdraws it too.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry beside the Hub sign-in; it injects `hubAccount` and `sessionQuery` and reads `assistants` with `ctx.get` to name the Session's assistant. The web-app bundle enables it for Desktop with a configured user center. `requestTimeoutMs` (default 60000) is the deadline of each user-center request, and `dshHome` (default `$DSH_HOME` or `~/.dsh`) holds the share record.

`status({ sessionId })` answers `{ signedIn, link }`: `link` is the Session's share (`shareId`, `url`, `createdAt`, `updatedAt`) or null when it is not shared, and while signed out it answers `{ signedIn: false, link: null }` without a request. `share({ sessionId, title })` reads the Session's log, builds the snapshot, and uploads it with the title and the name of the bound assistant (null for none, or one the tenant no longer has); it returns the link. `revoke({ sessionId })` withdraws the share and leaves a Session that is not shared as is.

The service records in `<dshHome>/session-shares.json` the Sessions it shared, each with the tenant of the sign-in and the share's id: a successful `share`, or a `status` that finds a share, records it, and a `revoke`, or a `status` that finds none, forgets it for the same tenant. On `session/deleted` it withdraws the share in the background only when the Session is recorded, so deleting Sessions never shared sends no request. A recorded share is withdrawn when the same tenant is signed in; otherwise it is logged and left on the user center. Either way the record is forgotten, and a failed withdrawal is logged. A damaged record file reads as empty and is replaced on the next write.

### What the snapshot holds

The snapshot is a list of messages with `role`, `text`, and the time `at`:

- **User messages** the user typed, with their text. Each file or image is one line naming it (`[附件：name]`); its content is not uploaded. User-role messages from a schedule, a subagent, or another producer are left out.
- **Assistant replies**, one message per reply, which a user-role message the user did not type does not split: the text of its steps in order, and `tools` listing each tool call by name with a one-line summary of its scalar arguments, at most 120 characters. Reasoning, tool results, and nested argument values are left out.

A Session shares its own log, which for a fork includes the turns it inherited. Subagent Sessions are separate logs and are not part of the snapshot.

### Errors

`share` and `revoke` refuse with `session-share/signed-out` without a Hub sign-in. `share` refuses with `session-share/empty` when the log holds no message to share. A refusal by the user center, or an answer that is not a share link with ISO 8601 times, is `session-share/refused` with its HTTP `status` and its own reason as the message; status 413 means the conversation exceeds the user center's size limits. A request that gets no answer, or misses the deadline, is `session-share/unreachable`.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package reads the Session log and writes nothing to it; nothing here reaches a model request.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Snapshot, not live** — the link shows the conversation as it was at the last `share`; later turns appear only after sharing again.
- **Long conversations are refused** — the user center caps a share's size and message count and refuses a larger one; the snapshot is not shortened to fit.
- **Withdrawal on delete needs the same sign-in and a connection** — a Session deleted while signed out, signed in to another tenant, or offline keeps its share on the user center until its owner or a company administrator withdraws it on the share page. The record names the tenant, not the employee, so another employee of the same tenant signed in on this machine cannot withdraw it either.
- **Attachment label is Chinese** — the line naming an attachment is written in Chinese whatever the UI language.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
