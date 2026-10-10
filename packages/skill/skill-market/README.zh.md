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

`list(query)` 代理 `/api/client/skills`（搜索词、分类、页码、每页数量），`categories()` 代理本租户的分类，`detail(id)` 返回当前版本的 SKILL.md 和文件清单。每张卡片带 `displayName`（Hub 的显示名称，例如天猫发品；Hub 没有给出时为 slug `name`）、`installedVersion`（该 Hub Skill 在本租户下已安装的版本，没有则为 null）、`updateAvailable`（已安装且 Hub 上的版本更新，按数字比较）和 `conflict`（用户放在 `~/.dsh/skills` 或 `~/.agents/skills` 的 Skill 与之同名）。`installSkill(id)` 遇到同名冲突时以 `skill-market/name-conflict` 拒绝，然后下载当前版本，并在落地之前校验：每个条目都必须位于 `<name>/` 之下且不含 `.`/`..` 段，必须有 `SKILL.md`，文件必须与发布版本的 sha256 清单完全一致。文件先写到目标旁边的暂存目录，再用一次 rename 移到位（已有的安装同样整体替换），`.hub-install.json` 记录 Hub Skill id、显示名称、版本、安装时间和每个文件的 sha256。任何一步失败都会删除暂存目录，不会留下半成品。在已有安装之上再次安装就是更新：替换之前，`installSkill(id, options)` 会把已装副本与安装记录比对，发现改动时以 `skill-market/local-changes` 拒绝（列出所有被修改、新增或删除的文件），除非设置了 `options.overwriteLocalChanges`；没有安装记录的同名目录视为本地文件。`installedStatus()` 向 Hub 查询本租户每个已装市场 Skill，返回其显示名称（优先取 Hub 当前的，其次取安装时记录的，再次为 slug）和状态：有新版本时为 `update`，否则 `current`；Hub 不再向该员工展示（下架、删除或不可见）时为 `unavailable`，本地副本保留且照常可用，绝不自动删除；Hub 无法访问时为 `unknown`。Hub 出错报 `skill-market/unavailable`，Skill 不存在报 `skill-market/not-found`，安装包不合格报 `skill-market/invalid-package`。

上传把本地文件夹发布到 Hub。`uploadSources()` 列出用户放在 `~/.dsh/skills` 或 `~/.agents/skills` 的 Skill 及其文件夹。`inspectFolder(dir)` 只读不改：读取 SKILL.md 的 `name` 和 `description`、将上传的文件（只含普通文件；排除 `.DS_Store`、`.git`、`node_modules`、`__pycache__` 和 `.hub-install.json`）及其数量与总大小、阻止上传的问题（`unreadable`、`no-skill-md`、`no-frontmatter`、`invalid-yaml`、`invalid-name`、`no-description`），以及该员工在 Hub 上同名的自有 Skill，并以下一个补丁版本作为建议版本（新 Skill 为 `1.0.0`）。`uploadOptions()` 返回分类，以及与 Hub 网页上传表单相同的部门和员工选项；完全不能上传的账号（代入租户的超级管理员）得到带 Hub 原因的 `skill-market/upload-rejected`。`uploadSkill(request)` 再次检查文件夹，有问题时以 `skill-market/invalid-folder` 拒绝，新 Skill 的显示名称缺失、超过 40 个字符或包含换行、不可见字符时以 `skill-market/invalid-display-name` 拒绝（与 Skill Hub 的规则相同），把文件打包到 `<name>/` 之下，作为新 Skill（带显示名称、可见范围、部门或员工、分类）或该员工自有 Skill 的新版本提交。返回结果说明版本是在等待审核（附 Hub 的审核链接）还是已直接发布（管理员上传）。Hub 拒绝上传的原因（版本号格式、名称重复、版本号不高于已有版本、已有版本在审核中、安装包过大）原样以 `skill-market/upload-rejected` 返回；Hub 无法访问时报 `skill-market/unavailable`。本地文件夹始终保持不变，仍属于用户自定义 Skill。

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

- **上传读取的是文件夹**——`uploadSkill` 打包本机上的文件夹，不能直接上传现成的 `.zip`。
- **更新靠拉取而非推送**——`installedStatus()` 在页面打开时询问 Hub；没有后台检查，只有用户要求时才安装更新。
- **本地改动检测只比对普通文件**——用户在市场 Skill 目录里新加的符号链接不会被报告为本地修改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。租户目录及其中的安装记录是唯一的状态；每次失效时目录都从它们重新推导。
