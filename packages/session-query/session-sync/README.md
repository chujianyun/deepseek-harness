---
description: "Session sync: upload every conversation, with its subagent Sessions and attachments, to the user center of the Hub sign-in, and delete it there when it is deleted here."
kind: "package-reference"
---
# Session Sync

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-session-sync` uploads the employee's conversations to the user center of the current [Hub sign-in](../../credentials/hub-account/README.md), so the employee's other machines can read them. Each top-level Session uploads as one bundle with its subagent Sessions after each of its turns ends, and the first scan after sign-in uploads the Sessions already on this machine. Attachments upload once per content digest. Deleting a Session deletes it on the user center. Requests that fail are retried, and a deletion recorded while offline is sent after a restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry beside the Hub sign-in and Session storage; it injects `hubAccount`, `sessionQuery`, and `sessionPersistence`, and reads `attachments` with `ctx.get`. The web-app bundle enables it for Desktop with a configured user center. It has no Remote: it works in the background whenever an employee of a tenant is signed in, and stops while signed out.

| Field | Default | Meaning |
|---|---|---|
| `requestTimeoutMs` | `300000` | Deadline of each user-center request |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Holds the sync record `session-sync.json` |
| `deviceName` | host name without `.local` | Name of this machine as other machines show it |
| `debounceMs` | `2000` | Wait after a turn ends, so turns in quick succession upload once |
| `scanIntervalMs` | `300000` | Interval of the scan that uploads Sessions changed without a turn ending, such as a rename |
| `retryMs` | `60000` | Wait before retrying after the user center could not be reached |

### What one upload carries

A top-level Session is a stored Session that is not a subagent Session; a fork is a top-level Session of its own. Its bundle is gzip-compressed JSON `{ format: 1, sessions }`: the Session's complete log first, then the logs of every subagent Session below it, ordered by id, each with its header and inherited event count. A Session whose log holds no user message is not uploaded. When one of the logs cannot be read, the whole bundle waits until it can. The upload names the revision, the working directory (null over 1000 characters), the device, the latest title (cut to 200 characters), the bound assistant's id, the attachments, and the time of the latest event.

Attachments are found anywhere in the events by their `sha256:<hex>` ids. The service asks which of them the user center lacks, uploads those through the attachment store, which verifies the bytes, and lists the ones the user center holds. An attachment over 100 MB, past the first 1000, no longer readable on this machine, or refused by the user center is left out of the list while the bundle still references it.

### When it uploads

A pass runs `debounceMs` after a turn ends, at sign-in and whenever the signed-in account changes, every `scanIntervalMs`, and after a deletion. A pass first sends the pending deletions of the signed-in account. A scan then looks at every top-level Session, newest first; a Session is read again only when the byte sizes of its logs (or, where the backend reports none, their revisions) changed since it was last read, and uploaded only when the content digest of its bundle changed. A Session left out because it has no user message or cannot be read is not read again until it changes. A turn's Session is always read and compared. Bundles are compressed off the event loop. Revisions start at 1 and rise by one per accepted upload.

The record `<dshHome>/session-sync.json` keeps, for each top-level Session, the account it syncs as, the last revision, the content digest, the storage change token, and why a bundle is held back. A change reaches the record only once it is written; a missing, unreadable, or damaged record reads as empty, and every Session is read and compared again.

### Answers from the user center

| Answer | Result |
|---|---|
| Accepted | The revision and digest are recorded |
| `409 stale_revision` | The upload is sent again with the user center's revision plus one; after three uploads the Session waits for the next pass while the others go on |
| `409 missing_attachments` | The attachments are checked and uploaded again, then the upload is sent again |
| `410` | The Session was deleted on another machine; it is not uploaded again |
| `400` or `413` | The bundle is held back until its content changes |
| `403` | The sign-in may not sync (it is not a company member); passes stop until the sign-in changes |
| Anything else, no answer, or a changed sign-in | The pass stops and runs again after `retryMs` |

### Accounts and deletion

An account is the tenant and phone number of a sign-in, which name one employee. Each Session syncs as the account it first uploaded as; another account's sign-in, of another tenant or another employee of the same one, leaves it alone. Deleting a Session that synced records a pending deletion for its account, which is sent while that account is signed in. A Session deleted while it was being read or uploaded records no entry, and its deletion follows. Deleting a Session that never synced sends nothing. Deleting a subagent Session sends nothing either; the next scan uploads its top-level Session again.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package reads Session logs and writes nothing to them; nothing here reaches a model request.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Upload only** — other machines read the uploaded conversations through a later package; this one neither downloads nor deletes local Sessions deleted elsewhere.
- **A deletion that cannot be recorded is lost** — when the record cannot be written at the moment of deletion, the Session stays on the user center.
- **Sign-in switch during a request** — each request checks the account before it is sent; one already sent when the sign-in switches completes under the sign-in it was sent with.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The user center side is new-dsh-ms `/api/client/sync/*` (T186); its limits are mirrored as protocol constants in `src/index.ts`.

</details>
