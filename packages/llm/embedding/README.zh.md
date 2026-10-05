---
description: "Desktop 知识库使用的嵌入模型：启动时下载的本地 Qwen3 嵌入模型、通过已配置提供商路由调用的 API 嵌入模型，以及 embedding Remote。"
kind: "package-reference"
---
# Embedding

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-embedding` 以 Host 服务 `ctx.embedding` 和 `embedding` Remote 命名空间的形式，提供 Desktop 知识库使用的嵌入模型。**本地嵌入模型**（Qwen3-Embedding-0.6B，q8 ONNX，约 614 MB）及运行它的 onnxruntime-node 不随包分发，缺失时下载到 `<dshHome>/models`。**API 嵌入模型**调用「设置 → 模型」中已配置、且端点使用 OpenAI 协议的提供商路由。Host 中的使用方通过 `embed(id, texts)` 向量化文本；凭据不会离开 Host。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop profile 中把本包挂成 Loader 条目；它注入 `llm`。web-app bundle 只在 `desktop` profile 下启用这一行，由 `ui-settings-embedding` 渲染设置分区。

启动时服务检查本地模型。运行时没有对应构建的平台（包括 Intel Mac）上，状态为 `unsupported`。所有文件都在且大小正确、运行时已解压，即为 `installed`；随后服务加载一次模型以得到向量维度，加载失败则为 `damaged`。某个已完成文件大小不对也为 `damaged`，只有修复才会处理它。其余情况为 `missing`，`autoDownload` 开启时不询问、直接在后台开始下载。

下载先取运行时：按 `npmRegistries` 的顺序下载 npm tarball，只把当前平台的原生文件解压到 `<dshHome>/models/runtime/onnxruntime-<version>/node_modules`，包自身对原生绑定的相对 `require` 因此可以解析，无需打补丁。接着按 `modelMirrors` 的顺序（先 ModelScope，后 HuggingFace）下载模型文件。每个文件先写入 `<file>.part`，之后的尝试用 HTTP Range 请求续传；不支持 Range 的镜像会从头重传该文件。完成的文件必须与预期大小和 sha256 一致才会改名就位；不一致则删除并改试下一个镜像。所有镜像都无法提供该文件时，若有镜像提供过错误内容则以 `verification` 失败，否则以 `network` 失败；磁盘拒绝写入的文件立即以 `storage` 失败。进度帧每秒最多推送四次。

`pauseDownload()` 停止传输并保留部分文件（`paused`）。`startDownload()` 用于开始、继续、重试或修复：修复会先校验每个已安装文件的 sha256，并重新下载不一致的文件。若通过 `registerUsage()` 登记的使用方（知识库）报告某个模型正在被使用，删除该模型会以 `embedding/model-in-use` 拒绝，并列出使用方。`removeLocalModel()` 会先停止正在进行的下载，再删除模型文件；下次启动会重新下载。运行时保留，因为在 Windows 上其原生库一经加载就会被锁定。

`listProviders()` 列出已配置、且通过 `llm.routeEndpoint()` 解析出的端点使用 `openai-completions` 或 `openai-responses` 的路由。`addApiModel(provider, model)` 带着路由的凭据和请求头发送一次 `POST <baseURL>/embeddings` 来测量向量维度，然后把 `{provider, model, dimensions}` 存入 `apiModels` 设置；`removeApiModel(id)` 删除它。路由已不存在的 API 模型仍会列出，并标为不可用。API 模型的 id 为 `<provider>/<model>`，本地模型的 id 为 `local/<name>`。

`embed(id, texts, signal)` 为每段文本返回一个向量。本地模型对每段文本分词，截断到 `maxTokens` 并保留最后一个 token，以空的键值缓存运行，返回最后一个 token 的隐藏状态并做 L2 归一化；多次调用依次执行。API 模型把所有文本放在一次请求中，并按 index 重新排序答复；被拒绝时以 `embedding/request-failed` 携带端点返回的状态码和信息；端点无法访问、请求超过 `requestTimeoutMs`，或响应体中途中断，也以同样方式失败。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Harness 主目录；模型位于 `<dshHome>/models`。 |
| `autoDownload` | `true` | 启动时本地模型缺失就下载。 |
| `modelMirrors` | 先 ModelScope，后 HuggingFace | 按顺序尝试的模型文件 URL 模板；替换其中的 `{repo}` 和 `{file}`。 |
| `npmRegistries` | 先 npmmirror，后 npmjs | 按顺序尝试的运行时 tarball 的 npm 镜像地址。 |
| `localModel` | Qwen3-Embedding-0.6B | 模型 id、名称、仓库、权重路径、token 上限，以及每个文件的大小和 sha256。 |
| `runtime` | onnxruntime-node 1.25.1 | 运行时版本、支持的 `<platform>-<arch>`，以及每个 tarball 的大小和 sha256。 |
| `apiModels` | `[]` | 在设置中添加的 API 嵌入模型；实时生效。 |
| `requestTimeoutMs` | `30000` | 每次嵌入 API 请求的超时时间。 |

-----

<a id="model-experience"></a>
## 模型体验

无，因为向量是在会话之外为知识库计算的，不会进入任何模型请求。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有 Intel Mac 构建** — onnxruntime-node 1.25.1 不提供 `darwin-x64` 绑定，因此本地模型在 Intel Mac 上不可用；API 嵌入模型仍然可用。
- **启动时只检查大小** — 大小相同但内容损坏的文件要等模型加载失败或执行修复时才会发现；启动检查不计算哈希，避免每次启动都要读 600 MB。
- **暂停只在本次运行有效** — `autoDownload` 开启时，暂停的下载会在下次启动时重新开始。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。磁盘上的文件就是安装状态；服务在启动时和每次下载后都从文件重新推导状态。
