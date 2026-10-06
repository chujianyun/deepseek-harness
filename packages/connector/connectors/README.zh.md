---
description: "桌面版连接器：通过各平台官方 CLI 接入的办公平台，按发行版固定的版本安装，以及 connectors Remote。"
kind: "package-reference"
---
# Connectors

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-connectors` 以 Host 服务 `ctx.connectors` 和 `connectors` Remote 命名空间的形式管理内置[连接器](../../../docs/glossary.zh.md#connector)。连接器通过平台未经修改的官方 CLI 接入办公平台；本包列出连接器，安装和卸载它们的 CLI，让当前 Hub 租户登录平台，并检查该连接。飞书安装 [`lark-cli`](https://github.com/larksuite/cli)；钉钉显示为即将支持。连接器为什么使用官方 CLI，记录在[连接器 Agent Note](../../../.agents/notes/proposed/feature/2026-10-06-connectors-over-official-clis.zh.md) 中。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop profile 中把本包作为 Loader 条目挂载在 `hub-account` 旁边，本包注入 `hub-account`。web-app bundle 在配置了用户中心的 `desktop` profile 中启用它，与知识库并列，`ui-connectors` 渲染它的页面。

`getState()` 和 `watch()` 为每个连接器返回一个视图，先飞书后钉钉，并带有状态：DSH 尚未支持时为 `coming-soon`，其 CLI 没有本平台构建时为 `unsupported`，以及 `not-installed`、`installing`；CLI 安装后为当前租户的[连接状态](../../../docs/glossary.zh.md#connector-status)：`disconnected`（红）、`connecting`、`connected`（绿）或 `degraded`（黄）。视图包含 CLI 名称和本发行版安装的版本、安装中的下载进度、上次安装失败的原因、进行中的登录、上次登录失败的原因、已登录账号的名称，以及连接异常的原因。

`installConnector(id)` 在后台安装连接器的 CLI 并立即返回；对已安装或正在安装的连接器调用不改变任何内容。安装会按配置的镜像顺序（先 npmmirror 的二进制镜像，再 GitHub releases，与该 CLI 自己的 npm 安装程序相同）下载固定版本的本平台压缩包，通过 [`dsh-verified-download`](../../util/verified-download/README.zh.md) 续传未完成的下载并校验大小和 sha256。它只把可执行文件解压到版本目录旁边，以 `--version` 运行并要求输出中包含固定版本，然后改名为 `<dshHome>/connectors/<id>/<version>/`。安装失败后连接器保持 `not-installed`，`error` 为 `network`（没有镜像提供压缩包）、`verification`（压缩包不是固定的那一个）、`storage`（无法写入或其中没有可执行文件）或 `launch`（可执行文件无法运行或报告了其他版本）；再次安装会清除它。一份 CLI 供本机所有租户使用，不做全局安装，也从不读取或修改用户自己安装的 CLI（无论在 `PATH` 中还是使用其自己的配置目录）。

连接属于当前 [Hub 登录](../../../docs/glossary.zh.md#skill-hub)所在的租户。为某个租户运行的每次 CLI 都使用该租户在 `<dshHome>/connectors/<id>/tenants/<tenantId>/` 下自己的配置、数据和日志目录（飞书为 `LARKSUITE_CLI_CONFIG_DIR`、`LARKSUITE_CLI_DATA_DIR` 和 `LARKSUITE_CLI_LOG_DIR`），且不带调用方的任何 `LARKSUITE_CLI_*`、`OPENCLAW_HOME` 或 `HERMES_HOME` 变量，因此从不读取或修改用户自己的 `~/.lark-cli`。每个租户创建自己的飞书应用，因此 lark-cli 按应用存放在系统钥匙串中的令牌和应用 secret 也不会混用。

`connect(id)` 在后台开始当前租户的登录并立即返回；对正在登录或已连接的连接器调用不改变任何内容。飞书按 lark-cli 面向 Agent 的流程进行：没有应用的租户先运行 `config init --new`，用户在浏览器中创建应用，再运行 `auth login --recommend --json`，用户授权自己的身份。每一步等待期间，视图的 `login` 包含当前步骤、CLI 打印的地址，以及由 `auth qrcode` 生成的二维码。用户完成后，由一次健康检查决定连接状态；某一步失败时设置 `loginError`，包含步骤和 CLI 的消息（平台拒绝创建应用时为 `create-app`）。`cancelConnect(id)` 结束该步骤的进程。创建了租户应用的登录失败或取消时，会运行 `config remove` 并删除该租户的目录，不留下半完成的内容；只做授权的登录保留已有应用。

健康检查运行 `auth status --json --verify`，向服务器确认用户令牌是否仍然有效：`ready` 或 `needs_refresh` 为 `connected` 并带上用户名称，`missing` 和未配置的租户为 `disconnected`，其他情况（`verify_failed`、`error`、无法读取的输出，或 CLI 无法运行）为 `degraded` 并带上原因。检查会对每个已安装的连接器在启动时、安装后、租户变化时、每 `checkIntervalMs`，以及调用 `check()` 时运行（连接器页面打开时调用）；被登录、断开或租户切换赶超的检查结果会被丢弃。登录另一个租户会停止进行中的登录，并显示该租户自己的连接。

`disconnect(id)` 停止进行中的登录，运行 `config remove`（清除该租户的应用配置和令牌，包括钥匙串条目），并删除该租户的目录；CLI 保留。`uninstallConnector(id)` 停止正在进行的安装或登录，对本机每个租户运行 `config remove`，并删除 `<dshHome>/connectors/<id>`，包括下载文件。所有方法对未知 id 以 `connectors/not-found` 拒绝，对即将支持或在本机不受支持的连接器以 `connectors/unavailable` 拒绝；`connect` 还以 `connectors/not-installed` 拒绝未安装的连接器，`connect` 和 `disconnect` 在未登录 Hub 时以 `hub-account/signed-out` 拒绝。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Harness 主目录；连接器 CLI 位于 `<dshHome>/connectors`。 |
| `feishu` | `lark-cli` 1.0.97 | 飞书 CLI：`binary`、`version`、`mirrors`（含 `{version}` 和 `{file}` 的 URL 模板），以及每个平台一条 `archives`，含 `file`、`size` 和 `sha256`。 |
| `checkIntervalMs` | `1800000`（30 分钟） | 定期检查连接健康状况的间隔。 |

-----

<a id="model-experience"></a>
## 模型体验

无，因为安装连接器的 CLI 和登录不会向模型请求添加任何内容。

#### KV Cache 影响

无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **尚未用于对话** — 在对话使用连接器之前，已连接连接器的 Skill 不会送达模型。
- **不能取消安装** — 正在进行的安装只能通过卸载停止。
- **每个租户成员一个应用** — 飞书登录会在本机为每个租户创建一个自建应用；禁止员工创建应用的公司，在支持由管理员提供租户应用之前无法连接。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。服务是每个连接器安装状态的唯一所有者（启动时从自己的目录推导），也是连接的唯一所有者（每次检查都从 CLI 自己的 `auth status` 读取），因此不存在可能出现分歧的第二个观测。
