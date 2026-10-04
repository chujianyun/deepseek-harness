---
description: "Desktop 的 Skill Hub 市场：按租户区分的 market skill 来源、以登录员工身份浏览 Hub，以及先校验再落地的一键安装。"
kind: "package-reference"
---
# Skill Market

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-skill-market` 把从 Skill Hub 安装的 Skill 以 `market` 来源加入 `ctx.skills`，并为 Desktop 的 Skills 页面提供生成的 `ctx.remote.skillMarket` namespace。市场 Skill 存放在 `<dshHome>/skills-market/<tenantId>/<name>/`；只发现当前登录租户的目录，每个 Skill 目录里有一份安装记录。浏览和下载都通过 [`@deepseek-ai/dsh-hub-account`](../../credentials/hub-account/README.zh.md) 的 Hub 登录完成。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包挂载为 Loader 条目，与 `hub-account` 放在一起；它注入 `skills` 和 `hubAccount`。web-app bundle 在启用 `hub-account` 时同时启用本包。

provider 通过 `ctx.skills.registerProvider()` 注册，借助文件系统 provider 发现当前登录租户的目录，来源为 `market`、rank 为 550：排在用户级目录之后、随包附带的 Skill 之前，所以同名的项目级 Skill 在该项目里仍然优先。切换租户时会换成新租户的目录；未登录时什么也不发现。

`list(query)` 代理 `/api/client/skills`（搜索词、分类、页码、每页数量），`categories()` 代理本租户的分类，`detail(id)` 返回当前版本的 SKILL.md 和文件清单。每张卡片带 `installedVersion`（该 Hub Skill 在本租户下已安装的版本，没有则为 null）和 `conflict`（用户放在 `~/.dsh/skills` 或 `~/.agents/skills` 的 Skill 与之同名）。`installSkill(id)` 遇到同名冲突时以 `skill-market/name-conflict` 拒绝，然后下载当前版本，并在落地之前校验：每个条目都必须位于 `<name>/` 之下且不含 `.`/`..` 段，必须有 `SKILL.md`，文件必须与发布版本的 sha256 清单完全一致。文件先写到目标旁边的暂存目录，再用一次 rename 移到位（已有的安装同样整体替换），`.hub-install.json` 记录 Hub Skill id、版本、安装时间和每个文件的 sha256。任何一步失败都会删除暂存目录，不会留下半成品。Hub 出错报 `skill-market/unavailable`，Skill 不存在报 `skill-market/not-found`，安装包不合格报 `skill-market/invalid-package`。

`setDisabled(name, disabled)` 只对当前登录租户停用某个市场 Skill，在 `disabledSkills` 中记录 `<tenantId>/<name>`；停用的市场 Skill 仍然列出，但 provider 会同时对模型和用户关闭它的调用。[`@deepseek-ai/dsh-skill-controller`](../skill-controller/README.zh.md) 的已安装 Skill Remote 把市场 Skill 列在单独的分组里，并把它们的开关交给这里。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 其下的 `skills-market` 目录存放市场 Skill。 |
| `disabledSkills` | `[]` | 停用的市场 Skill，记为 `<tenantId>/<name>`；volatile，通过 `setDisabled()` 修改。 |
| `watch` | `true` | 监视租户目录，发现 DSH 之外的改动。 |
| `maxPackageBytes` | 64 MiB | 可安装的安装包上限。 |

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 skill 注册表：安装的市场 Skill 和其他 Skill 一样进入模型的 skill 目录，停用后离开。

#### KV Cache 影响

无直接影响；与其他目录变化一样，skill 目录消费方会在可见集合变化时追加一条替换目录消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **还没有更新与本地改动检测**——安装记录保存了每个文件的 sha256 供此使用，但与 Hub 和磁盘的比对是单独的一步。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。租户目录及其中的安装记录是唯一的状态；每次失效时目录都从它们重新推导。
