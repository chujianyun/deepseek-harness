---
description: "桌面版连接器：通过各平台官方 CLI 接入的办公平台，按发行版固定的版本安装，以及 connectors Remote。"
kind: "package-reference"
---
# Connectors

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-connectors` 以 Host 服务 `ctx.connectors` 和 `connectors` Remote 命名空间的形式管理内置[连接器](../../../docs/glossary.zh.md#connector)。连接器通过平台未经修改的官方 CLI 接入办公平台；本包列出连接器，安装和卸载它们的 CLI，让当前 Hub 租户登录平台，并检查该连接。飞书安装 [`lark-cli`](https://github.com/larksuite/cli)，钉钉安装 [`dws`](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)，各由一个驱动（`src/lark.ts`、`src/dingtalk.ts`）说明其 CLI 如何隔离租户、登录、报告健康状况、提供 Skill，以及如何声明命令的风险。连接器为什么使用官方 CLI，记录在[连接器 Agent Note](../../../.agents/notes/proposed/feature/2026-10-06-connectors-over-official-clis.zh.md) 中。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop profile 中把本包作为 Loader 条目挂载在 `hub-account`、`skill` 和 `shell-env` 旁边，本包注入它们。web-app bundle 在配置了用户中心的 `desktop` profile 中启用它，与知识库并列，`ui-connectors` 渲染它的页面。

`getState()` 和 `watch()` 为每个连接器返回一个视图，先飞书后钉钉，并带有状态：其 CLI 没有本平台构建时为 `unsupported`，以及 `not-installed`、`installing`；CLI 安装后为当前租户的[连接状态](../../../docs/glossary.zh.md#connector-status)：`disconnected`（红）、`connecting`、`connected`（绿）或 `degraded`（黄）。视图包含 CLI 名称和本发行版安装的版本、安装中的下载进度、上次安装失败的原因、进行中的登录、上次登录失败的原因、已登录账号的名称，以及连接异常的原因。

`installConnector(id)` 在后台安装连接器的 CLI 并立即返回；对已安装或正在安装的连接器调用不改变任何内容。安装会按配置的镜像顺序（`lark-cli` 先 npmmirror 的二进制镜像，再 GitHub releases，与其 npm 安装程序相同；`dws` 用其 GitHub release）下载固定版本的本平台压缩包，通过 [`dsh-verified-download`](../../util/verified-download/README.zh.md) 续传未完成的下载并校验大小和 sha256。另外提供 Skill 压缩包（`dws-skills.zip`）的发行版，也以同样方式下载和校验该压缩包，并把其中按 Skill 分目录的 `multi/<name>/` 解压到 `skills/`；会离开该目录的条目使安装以 `storage` 失败。它只把可执行文件解压到版本目录旁边，以 `--version` 运行并要求输出中包含固定版本，然后改名为 `<dshHome>/connectors/<id>/<version>/`；文件仍被其他进程占用时（Windows 上刚退出的 CLI 或正在扫描的杀毒软件，报 `EBUSY`，Windows 上还有 `EPERM`、`EACCES`）重试约 4.5 秒。安装失败后连接器保持 `not-installed`，`error` 为 `network`（没有镜像提供压缩包）、`verification`（压缩包不是固定的那一个）、`storage`（无法写入或其中没有可执行文件）、`busy`（文件一直被其他进程占用）或 `launch`（可执行文件无法运行或报告了其他版本）；再次安装会清除它。一份 CLI 供本机所有租户使用，不做全局安装，也从不读取或修改用户自己安装的 CLI（无论在 `PATH` 中还是使用其自己的配置目录）。

连接属于当前 [Hub 登录](../../../docs/glossary.zh.md#skill-hub)所在的租户。为某个租户运行的每次 CLI 都使用该租户在 `<dshHome>/connectors/<id>/tenants/<tenantId>/` 下自己的配置、数据和日志目录（飞书为 `LARKSUITE_CLI_CONFIG_DIR`、`LARKSUITE_CLI_DATA_DIR` 和 `LARKSUITE_CLI_LOG_DIR`），且不带调用方的任何 `LARKSUITE_CLI_*`、`OPENCLAW_HOME` 或 `HERMES_HOME` 变量，因此从不读取或修改用户自己的 `~/.lark-cli`。每个租户创建自己的飞书应用，因此 lark-cli 按应用存放在系统钥匙串中的令牌和应用 secret 也不会混用。钉钉的租户目录存放 `dws` 的配置（`DWS_CONFIG_DIR`）和加密凭据库（`DWS_KEYCHAIN_DIR`），每次运行都去掉调用方的 `DWS_*` 变量并设置 `DWS_DISABLE_KEYCHAIN=1`：否则 `dws` 会把凭据库的密钥以对所有目录相同的名字存进系统钥匙串，并在退出登录时清掉这个名字，从而波及用户自己的 `~/.dws` 登录。

`connect(id)` 在后台开始当前租户的登录并立即返回；对正在登录或已连接的连接器调用不改变任何内容。飞书按 lark-cli 面向 Agent 的流程进行：没有应用的租户先运行 `config init --new`，用户在浏览器中创建应用，再运行 `auth login --recommend --json`，用户授权自己的身份。每一步等待期间，视图的 `login` 包含当前步骤、CLI 打印的地址，以及由 `auth qrcode` 生成的二维码。用户完成后，由一次健康检查决定连接状态；某一步失败时设置 `loginError`，包含步骤和 CLI 的消息（平台拒绝创建应用时为 `create-app`）。钉钉用钉钉自己的应用一步登录：`auth login --device --no-browser --format json` 打印带用户码的设备流地址，可在本机浏览器打开，也可用手机扫描 DSH 绘制的二维码（SVG，经 [`uqr`](https://github.com/unjs/uqr)）。视图的 `login.steps` 列出这次登录的各步，因此弹窗为飞书显示两步、为钉钉不显示步骤列表。`cancelConnect(id)` 结束该步骤的进程。创建了租户应用的登录失败或取消时，会运行 `config remove` 并删除该租户的目录，不留下半完成的内容；只做授权的登录保留已有应用。

健康检查运行 `auth status --json --verify`，向服务器确认用户令牌是否仍然有效：`ready` 或 `needs_refresh` 为 `connected` 并带上用户名称，`missing` 和未配置的租户为 `disconnected`，其他情况（`verify_failed`、`error`、无法读取的输出，或 CLI 无法运行）为 `degraded` 并带上原因。钉钉的检查运行 `auth status --readonly --format json`，只读取本地登录态而不刷新：`authenticated` 为 `connected` 并带上用户和企业；未登录且无 reason 为 `disconnected`；未登录但带 `reason`（凭据库无法读取、刷新失败）为 `degraded` 并带上其说明，无法读取的输出同样如此。检查会对每个已安装的连接器在启动时、安装后、租户变化时、每 `checkIntervalMs`，以及调用 `check()` 时运行（连接器页面打开时调用）；被登录、断开或租户切换赶超的检查结果会被丢弃。登录另一个租户会停止进行中的登录，并显示该租户自己的连接。

连接器已安装且当前租户开启它时，模型 shell 会在 `<dshHome>/connectors/<id>/bin/<tenantId>/` 中找到一个以其 CLI 命名的脚本（`lark-cli`、`dws`），本包通过 `ctx.shellEnv.registerPath()` 把该目录放到 `PATH` 最前面。已连接或异常时，脚本去掉调用方的 lark-cli 变量，用该租户的配置和数据目录运行已安装的 CLI，因此命令使用的是 DSH 的 CLI 和该租户的登录，而不是用户自己设置的 CLI 或 `~/.lark-cli`。脚本运行 CLI 期间，服务用 `ctx.sandboxPolicy.registerWritableRoot()` 登记该租户的目录，让受限模型 shell 中的 CLI 能在那里取锁和刷新令牌（`dws` 每次读取登录态的调用都要取锁）；lark-cli 的日志写在系统临时目录下，沙箱中的模型 shell 也能写入，而 `dws` 把日志写在配置目录中，沙箱拒绝写入时照常运行。未连接时，脚本拒绝执行，并提示请用户在连接器页面连接。命令失败时，脚本会补充说明连接器页面可能有帮助；服务监听 `tools/result`，对失败的 bash 命令所运行的每个连接器 CLI 运行一次健康检查。租户、连接或开关变化时，脚本会被重写。

bash 调用运行前，服务的 `tools/pre-execute` 监听器会读取该调用通过每个已连接且开启的连接器做什么。它把命令拆成单词和分隔符，找出该连接器 CLI 的每个调用；其风险取自 `<cli> <command> --help` 的声明，每条命令读取一次。lark-cli 声明 `Risk: read | write | high-risk-write`，高风险写入只在带 `--yes` 时运行。`dws` 声明 `Safety: effect=… risk=… confirmation=…`：`effect=read` 为读取，`effect=destructive` 或 `risk=high` 为高风险写入，其他 `effect=write` 为写入，`confirmation=user_required` 表示只在带 `--yes` 时运行；没有声明安全性的 `auth status`、`version`、`schema`、`profile list`、`shortcut list` 和 `config list` 视为读取。`--help`、`--version`、`--dry-run` 或无参数视为读取。没有声明风险的命令、由变量构成的参数，以及隐藏 lark-cli 调用方式的命令（命令替换、`eval`、`sh -c`、`xargs`）按 `unknown` 处理，像写操作一样确认。只读取的调用直接运行；其他调用返回 `ask`，以命令作为审计原因并带本地化的 `displayReason`，由用户在审批面板中允许一次，拒绝会作为工具的拒绝结果送达模型。`high-risk-write` 调用的原因以 ⚠️ 警告开头；含有 CLI 只在确认后运行的命令时，原因会说明 DSH 将加上 `--yes`。用户允许后，模型 shell 仅为该次调用获得 `DSH_CONNECTOR_CONFIRMED`，以 `<cli> <命令词>` 的形式每行列出一条这些命令，该 CLI 的脚本会为这些命令的调用加上 `--yes`（已确认则不重复：`--yes`，`dws` 还有 `-y`）；该调用中的其他调用保持不变。该调用的 `tools/result` 结束这次批准。其他监听器的拒绝或询问保持不变。当一次调用所询问的命令全部是 CLI 无需确认即可运行的普通 `write` 时，询问还会带上 `onRemember`，审批面板因此提供 **始终允许**：选择后允许本次调用，并把每条命令的命令词按当前租户保存到 `alwaysAllowed`，格式为 `<tenantId>/<id>/<command words>`。之后所询问的命令都已保存的调用不再询问（无论参数是什么），并向会话追加一条仅日志的 `connectors/always-allowed` 事件（`callId`、`commands`）；没有可记录的会话时照常询问。包含高风险、需要确认或 `unknown` 命令的调用从不提供该选项。`revokeAlwaysAllowed()` 撤销一条；断开删除该租户的授权，卸载删除所有租户的授权，退出 Hub 登录删除被登出租户的授权；切换租户时各租户保留自己的授权。

连接器已连接或异常且开启时，其 CLI 内置的 Skill 通过 `ctx.skills` 送达模型，来自 `connectors` provider，来源为 `connector-<id>`，rank 为 350：排在用户自己的 Skill 目录之前，因此那里过期的副本不会遮住与已安装 CLI 匹配的 Skill，排在项目 Skill 之后。provider 以 `everyLayer` 注册，因此在自己的层中发现本地 Skill 的 agent 预设里，这一顺序同样成立。飞书的列表来自 `skills list`，每个 CLI 版本读取一次；Skill 的说明来自去掉 frontmatter 的 `skills read <name>`；其文件用 `lark-cli skills read <name> <path>` 读取。钉钉的 Skill 来自已安装的 `skills/<name>/SKILL.md` 文件，其 frontmatter 中的 `name` 必须与目录一致，Skill 的目录即其资源根目录。每个视图会列出已安装 CLI 的 Skill，供卡片显示。`setEnabled(id, enabled)` 通过 Settings 服务在易变的 `disabled` 列表中为当前租户开启或关闭连接器：关闭后连接器保持登录，但模型既得不到它的 Skill 也得不到它的 CLI，用户自己的 `lark-cli` 保持原样。

`restrict(filter)` 让会话不能使用某些连接器，例如会话的智能体未允许的连接器。对于某个过滤器拒绝其 agent 使用某连接器的模型 shell 调用，该连接器的脚本目录不会加入 `PATH`，其 Skill 通过 skill 视图过滤器离开该会话的目录，按名称或任意路径调用其 CLI 的命令会在运行前被拒绝；隐藏了 CLI 调用方式的命令不在此处拒绝，而是继续进入审批检查。没有 agent 的调用和不属于会话的读取不受过滤。返回的 disposer 移除该过滤器。

`disconnect(id)` 停止进行中的登录，让该租户退出登录（lark-cli 的 `config remove` 清除其应用配置和令牌，包括钥匙串条目；`dws auth logout` 吊销其令牌），并删除该租户的目录；CLI 保留。`uninstallConnector(id)` 停止正在进行的安装或登录，以同样方式让本机每个租户退出登录，并删除 `<dshHome>/connectors/<id>`，包括下载文件。所有方法对未知 id 以 `connectors/not-found` 拒绝，对在本机不受支持的连接器以 `connectors/unavailable` 拒绝；`connect` 还以 `connectors/not-installed` 拒绝未安装的连接器，`connect` 和 `disconnect` 在未登录 Hub 时以 `hub-account/signed-out` 拒绝。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Harness 主目录；连接器 CLI 位于 `<dshHome>/connectors`。 |
| `feishu` | `lark-cli` 1.0.97 | 飞书 CLI：`binary`、`version`、`mirrors`（含 `{version}` 和 `{file}` 的 URL 模板），以及每个平台一条 `archives`，含 `file`、`size` 和 `sha256`。 |
| `dingtalk` | `dws` 1.0.63 | 钉钉 CLI，字段相同，另有 `skills`：发行版的 Skill 压缩包，含 `file`、`size` 和 `sha256`。 |
| `checkIntervalMs` | `1800000`（30 分钟） | 定期检查连接健康状况的间隔。 |
| `disabled` | `[]` | 已关闭的连接器，格式为 `<tenantId>/<id>`；易变字段，由 `setEnabled()` 写入。 |
| `alwaysAllowed` | `[]` | 不再询问的写命令，格式为 `<tenantId>/<id>/<command words>`；易变字段，从审批面板添加，由 `revokeAlwaysAllowed()` 删除。 |

-----

<a id="model-experience"></a>
## 模型体验

间接通过 skill 注册表和 bash 工具：已连接且开启的连接器的 Skill 会加入模型的 skill 目录，其 CLI 在 bash 中运行；断开或关闭后这些 Skill 会离开目录。脚本会向命令的 stderr 追加两行之一，由 bash 结果带给模型：拒绝时为 `DSH: the Feishu connector is not connected for this company. Ask the user to connect Feishu on the DSH Connectors page (连接器), then try again.`，命令失败后为 `DSH: lark-cli exited with status <n>. If signing in to Feishu or a missing permission is the cause, ask the user to check the Feishu connector on the DSH Connectors page (连接器).`；钉钉脚本的提示相同，只是换成 DingTalk 和 `dws`。会写入的连接器命令会先等待用户批准（用户已为该公司始终允许的除外）；拒绝会作为工具的拒绝结果 `Error: the user rejected tool "bash"` 送达模型。调用会话不能使用的连接器的 CLI 时，命令以 `The Feishu connector (lark-cli) is not available in this session.` 被拒绝，钉钉则换成 DingTalk 和 `dws`。

#### KV Cache 影响

无直接影响；连接器的 Skill 加入或离开时，skill 目录的使用方会追加一条替换目录消息，与其他 Skill 的开关相同。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有单独的高风险样式** — 审批面板显示高风险命令与其他审批相同；只有原因中的 ⚠️ 文字把它区分出来。
- **始终允许不区分参数** — 被始终允许的命令无论带什么参数都直接运行，例如发给任意群的消息；没有按群或按文档的授权，也没有只在本会话内有效的授权。
- **模型 shell 可写凭据目录** — 连接器已连接且开启时，其租户目录是沙箱可写根目录，因此受限命令可以修改或删除其中的登录信息，正如它本来就能读取一样。
- **仅 bash、仅 POSIX** — 这些脚本是放在 `dsh-tool-bash` 的 `PATH` 上的 POSIX shell 脚本；PowerShell 和 Windows 没有脚本。
- **钉钉只从 GitHub 下载** — npmmirror 没有 `dws` 的二进制镜像，其 npm 包把所有平台的压缩包（约 105 MB）套在另一个包里；GitHub 访问缓慢或受阻时，安装钉钉会以 `network` 失败。
- **Windows 不支持钉钉** — 在 Windows 上 `dws` 把登录信息存放在用户注册表中，无法按租户目录隔离，因此该连接器为 `unsupported`。
- **钉钉凭据密钥与数据同处** — `DWS_DISABLE_KEYCHAIN` 让租户加密凭据库的密钥与其放在同一目录，而不是系统钥匙串，静态保护更弱；该目录位于用户自己的主目录下。
- **钉钉健康检查只看本地** — `auth status --readonly` 不询问服务器，因此在服务器上被吊销的令牌仍显示为已连接；失败命令的提示会把模型引向连接器页面，在那里重新连接即可重新登录。
- **不能取消安装** — 正在进行的安装只能通过卸载停止。
- **每个租户成员一个应用** — 飞书登录会在本机为每个租户创建一个自建应用；禁止员工创建应用的公司，在支持由管理员提供租户应用之前无法连接。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。服务是每个连接器安装状态的唯一所有者（启动时从自己的目录推导），也是连接的唯一所有者（每次检查都从 CLI 自己的 `auth status` 读取），因此不存在可能出现分歧的第二个观测。
