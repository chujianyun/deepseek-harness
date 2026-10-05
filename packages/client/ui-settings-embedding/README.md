---
description: "Embedding models section of the dsh Desktop Settings: the local model's download with progress, pause, repair, and delete, and API embedding models over configured provider routes."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-embedding

English | [中文](README.zh.md)

## Summary

Adds an **Embedding models** section to Desktop Settings, after **Models**. It shows the local embedding model's state, with download progress, **Pause**, **Resume**, **Retry**, **Repair**, and **Delete**, and the API embedding models with a form to add one on a configured provider. It reads and acts through the [`embedding` Remote](../../llm/embedding/README.md); knowledge bases choose among these models.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `embedding` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile only. The plugin contributes only in the Desktop renderer (`dshDesktop` present). It injects `remote.embedding` and registers the section into `settings.section` with the id `embedding` at order 11.

The local model card names the model, says it runs offline without an API key, and, once installed, its vector size. A status tag reads **Not downloaded**, **Downloading**, **Paused**, **Installed**, **Download failed**, **Needs repair**, or **Not supported here**. While downloading or paused, and after a failure with bytes on disk, a progress bar shows the bytes received out of the total. A failure states its reason (network, verification, or storage) with **Retry**; a damaged install offers **Repair**; an unsupported computer is explained without actions. **Delete** asks for confirmation inline and notes that the next start downloads the model again.

The API card lists each model with its provider and vector size, tags one whose provider route is gone as unavailable, and deletes it. The add form offers the configured providers the Host lists, refreshed when the section mounts, and a model id; **Add** shows **Testing…** while the Host measures the vector size, and clears the field when it succeeds. A refused action shows the Host's message; deleting a model a knowledge base uses names those knowledge bases instead. With no usable provider the card says so and **Configure models** opens Settings on Models. A note says document content is sent to the provider of an API embedding model.

-----

<a id="model-experience"></a>
## Model Experience

None, as the section only renders embedding model state.

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

**Runtime invariant:** No companion is published. The view renders the Host's state stream; it keeps no independent model state.
