---
description: "桌面版连接器：通过各平台官方 CLI 接入的办公平台，按发行版固定的版本安装，以及 connectors Remote。"
kind: "package-reference"
---
# Connectors

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-connectors` 以 Host 服务 `ctx.connectors` 和 `connectors` Remote 命名空间的形式管理内置[连接器](../../../docs/glossary.zh.md#connector)。连接器通过平台未经修改的官方 CLI 接入办公平台；本包列出连接器，并安装和卸载它们的 CLI。飞书安装 [`lark-cli`](https://github.com/larksuite/cli)；钉钉显示为即将支持。连接器为什么使用官方 CLI，记录在[连接器 Agent Note](../../../.agents/notes/proposed/feature/2026-10-06-connectors-over-official-clis.zh.md) 中。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop profile 中把本包作为 Loader 条目挂载。web-app bundle 在配置了用户中心的 `desktop` profile 中启用它，与知识库并列，`ui-connectors` 渲染它的页面。

`getState()` 和 `watch()` 为每个连接器返回一个视图，先飞书后钉钉，并带有状态：DSH 尚未支持时为 `coming-soon`，其 CLI 没有本平台构建时为 `unsupported`，以及 `not-installed`、`installing`，CLI 已安装且没有登录平台账号时为 `disconnected`。视图包含 CLI 名称和本发行版安装的版本、安装中的下载进度，以及上次安装失败的原因。

`installConnector(id)` 在后台安装连接器的 CLI 并立即返回；对已安装或正在安装的连接器调用不改变任何内容。安装会按配置的镜像顺序（先 npmmirror 的二进制镜像，再 GitHub releases，与该 CLI 自己的 npm 安装程序相同）下载固定版本的本平台压缩包，通过 [`dsh-verified-download`](../../util/verified-download/README.zh.md) 续传未完成的下载并校验大小和 sha256。它只把可执行文件解压到版本目录旁边，以 `--version` 运行并要求输出中包含固定版本，然后改名为 `<dshHome>/connectors/<id>/<version>/`。安装失败后连接器保持 `not-installed`，`error` 为 `network`（没有镜像提供压缩包）、`verification`（压缩包不是固定的那一个）、`storage`（无法写入或其中没有可执行文件）或 `launch`（可执行文件无法运行或报告了其他版本）；再次安装会清除它。一份 CLI 供本机所有租户使用，不做全局安装，也从不读取或修改用户自己安装的 CLI（无论在 `PATH` 中还是使用其自己的配置目录）。

`uninstallConnector(id)` 停止正在进行的安装并删除 `<dshHome>/connectors/<id>`，包括下载文件。两个方法对未知 id 以 `connectors/not-found` 拒绝，对即将支持或在本机不受支持的连接器以 `connectors/unavailable` 拒绝。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Harness 主目录；连接器 CLI 位于 `<dshHome>/connectors`。 |
| `feishu` | `lark-cli` 1.0.97 | 飞书 CLI：`binary`、`version`、`mirrors`（含 `{version}` 和 `{file}` 的 URL 模板），以及每个平台一条 `archives`，含 `file`、`size` 和 `sha256`。 |

-----

<a id="model-experience"></a>
## 模型体验

无，因为安装连接器的 CLI 不会向模型请求添加任何内容。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **尚无登录** — 已安装的连接器保持 `disconnected`；平台登录、连接状态以及在对话中使用将在后续实现。
- **不能取消** — 正在进行的安装只能通过卸载停止。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。服务是每个连接器安装状态的唯一所有者，并在启动时从自己的目录推导该状态，因此不存在可能出现分歧的第二个观测。
