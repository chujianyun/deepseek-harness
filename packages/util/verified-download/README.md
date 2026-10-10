---
description: "Resumable file download over an ordered mirror list, verified by size and sha256 before the file is renamed into place."
kind: "package-reference"
---

# @deepseek-ai/dsh-verified-download

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-verified-download` fetches one file whose size and sha256 are known in advance, from the first of several mirrors that serves it. Bytes land in `<dest>.part`; a later attempt resumes from that length with an HTTP Range request, and the finished file is renamed to `<dest>` only after its size and digest match. Packages that download pinned artifacts at runtime — the local embedding model — use it as a direct library dependency, not through `cordis.yml`.

## Table of Contents

- [Use this package](#use-this-package)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```ts
import { downloadFile } from '@deepseek-ai/dsh-verified-download'

let received = 0
await downloadFile({
  urls: ['https://mirror-a.example/tool.tar.gz', 'https://mirror-b.example/tool.tar.gz'],
  dest: '/tmp/tool.tar.gz',
  size: 13_964_426,
  sha256: '64e856a05c8dfdac5dbecd316766e4b05299f230f54833b674a623df3ac13f1c',
}, (bytes) => { received += bytes }, AbortSignal.timeout(60_000))
```

`downloadFile` tries `urls` in order. An unreachable mirror, an HTTP error, a dropped connection, and bytes that fail verification all move on to the next mirror; a mirror that ignores Range restarts the file and reports the discarded partial length as a negative byte count. When every mirror fails it throws `DownloadError` with code `verification` if any mirror served wrong bytes and `network` otherwise; a file that cannot be written throws `storage` at once. Aborting the signal rejects with the abort reason and keeps the partial file for the next attempt. `bytesOnDisk(dest)` reports the finished or partial length, and `sha256File(path)` hashes a file.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Redirects are followed without a host check** — verification by size and sha256 is the integrity control; the mirror list is not an allowlist.
- **One file per call** — callers sequence multiple files and own their progress totals.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published; this stateless utility owns no event stream or runtime data, and its behavior is pinned by unit tests.
