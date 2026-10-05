---
description: "Embedding models for Desktop knowledge bases: the local Qwen3 embedding model downloaded at startup, API embedding models over configured provider routes, and the embedding Remote."
kind: "package-reference"
---
# Embedding

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-embedding` owns the embedding models that Desktop knowledge bases use, as the Host service `ctx.embedding` and the `embedding` Remote namespace. The **local embedding model** (Qwen3-Embedding-0.6B, q8 ONNX, about 614 MB) and the onnxruntime-node build that runs it are downloaded to `<dshHome>/models` when missing, not shipped. **API embedding models** call a provider route configured under Settings → Models whose endpoint speaks an OpenAI protocol. Host consumers embed text with `embed(id, texts)`; credentials never leave the Host.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in the Desktop profile; it injects `llm`. The web-app bundle enables the row for the `desktop` profile only, and `ui-settings-embedding` renders its Settings section.

At startup the service checks the local model. On a platform the runtime has no build for (Intel Macs among them) the model is `unsupported`. Every file present with its expected size and the runtime extracted means `installed`; the service then loads the model once to learn its vector size, and a model that does not load is `damaged`. A finished file with the wrong size also means `damaged`, and only a repair touches it. Anything else is `missing`, and with `autoDownload` the download starts in the background without asking.

The download fetches the runtime first, as npm tarballs from `npmRegistries` in order, extracting only the current platform's native files into `<dshHome>/models/runtime/onnxruntime-<version>/node_modules`; the package's own relative `require` of its binding then resolves, so nothing is patched. Model files follow from `modelMirrors` in order (ModelScope, then HuggingFace). Each file streams into `<file>.part`; a later attempt continues it with an HTTP Range request, and a mirror that ignores Range restarts the file. A finished file must match its size and sha256 before it is renamed into place; one that does not is deleted and the next mirror is tried. When no mirror serves the file, the download fails as `verification` if some mirror served wrong bytes and as `network` otherwise; a file the disk refuses fails at once as `storage`. Progress frames stream at most four times a second.

`pauseDownload()` stops the transfer and keeps partial files (`paused`). `startDownload()` starts, resumes, retries, or repairs: a repair first hashes every installed file and downloads again the ones that do not match. Removing a model is refused with `embedding/model-in-use`, naming its users, while a consumer registered through `registerUsage()` (knowledge bases) reports one. `removeLocalModel()` stops a running download and deletes the model files; the next startup downloads them again. The runtime stays, because Windows locks its native library once it is loaded.

`listProviders()` lists the configured routes whose endpoint, resolved through `llm.routeEndpoint()`, speaks `openai-completions` or `openai-responses`. `addApiModel(provider, model)` sends one `POST <baseURL>/embeddings` with the route's credential and headers to measure the vector size, then stores `{provider, model, dimensions}` in the `apiModels` setting; `removeApiModel(id)` drops it. An API model whose route is gone stays listed as unavailable. Its id is `<provider>/<model>`; the local model's is `local/<name>`.

`embed(id, texts, signal)` returns one vector per text. The local model tokenizes each text, cuts it to `maxTokens` keeping its final token, runs it with an empty key/value cache, and returns the last token's hidden state L2-normalized; runs are serialized. API models are called with up to `apiBatchSize` texts per request, one request after another, and each answer is reordered by index; refusals carry the endpoint's status and message as `embedding/request-failed`, and an unreachable endpoint, a request past `requestTimeoutMs`, or a body cut midway fails the same way.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home; models live under `<dshHome>/models`. |
| `autoDownload` | `true` | Download the local model at startup when it is missing. |
| `modelMirrors` | ModelScope, then HuggingFace | Model file URL templates tried in order; `{repo}` and `{file}` are substituted. |
| `npmRegistries` | npmmirror, then npmjs | npm registry origins tried in order for the runtime tarballs. |
| `localModel` | Qwen3-Embedding-0.6B | Model id, name, repository, weights path, token limit, and each file's size and sha256. |
| `runtime` | onnxruntime-node 1.25.1 | Runtime version, supported `<platform>-<arch>` keys, and each tarball's size and sha256. |
| `apiModels` | `[]` | API embedding models added in Settings; edited live. |
| `requestTimeoutMs` | `30000` | Deadline of each embedding API request. |
| `apiBatchSize` | `10` | Most texts in one embedding API request; Alibaba Cloud Model Studio refuses more than 10. |

-----

<a id="model-experience"></a>
## Model Experience

None, as embeddings are computed for knowledge bases outside any Session and no model request carries them.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No Intel Mac build** — onnxruntime-node 1.25.1 ships no `darwin-x64` binding, so the local model is unsupported there; API embedding models still work.
- **Startup checks sizes only** — a same-size corruption is found when the model fails to load or by a repair, not by the startup check, which avoids hashing 600 MB at every start.
- **Paused is per run** — a paused download starts again at the next startup when `autoDownload` is on.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The files on disk are the install state; the service re-derives its status from them at startup and after each download.
