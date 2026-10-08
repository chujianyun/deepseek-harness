---
description: "Skill Hub 只下发给需要的租户的天猫取数技能：用天猫商家账号读取的万相台营销场景报表与生意参谋店铺经营核心日报，以及生成其上传包的打包步骤。"
kind: "package-reference"
---
# 天猫取数技能

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tmall-skills` 存放两个 DSH 不随包发布的只读 Skill：由租户管理员上传到 [Skill Hub](../../../docs/glossary.zh.md#skill-hub)，该租户的员工自行安装。`tmall-alimama-scene-report` 读取万相台某一天各营销场景的数据；`tmall-sycm-core-daily` 导出生意参谋「店铺经营核心日报」，并把其中的推广花费与万相台核对。两者都通过 `dsh-ecommerce browser` 接管天猫[商家账号](../../../docs/glossary.zh.md#merchant-account)，并以单个 ES 模块由 DSH 自带的 Node 运行，员工无需安装 Python 或任何包。技能为何调用平台页面自己的接口，记录在[电商账号 Agent Note](../../../.agents/notes/proposed/feature/2026-10-07-ecommerce-accounts-over-store-session.zh.md) 中。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`packSkills(outDir)` 把 `SKILLS` 中的每个技能构建到 `<outDir>/<name>/`：`SKILL.md` 取自 `skills/<name>/`，`scripts/` 下每个脚本是用 tsdown 从 `src/` 打包出的单个自包含 ES 模块；再把每个文件夹以 `<name>/` 为根压缩成 `<outDir>/<name>.zip`，即 Skill Hub 接受的格式；之前的构建会被替换。在仓库根目录运行：

```sh
node --input-type=module -e "import { packSkills } from './packages/ecommerce/tmall-skills/src/index.ts'; console.log(await packSkills('dist/tmall-skills'))"
```

每个脚本接受 `--account <id>`（`dsh-ecommerce accounts` 列出的 id）、`--date YYYY-MM-DD`（按北京时间已经结束的一天，默认昨天）和 `--out <目录>`（默认工作目录下的 `天猫报表`）。脚本运行 `dsh-ecommerce browser <id>`，DSH 只在租户已登录时的 bash 调用中应答；不是天猫商家账号的账号会被拒绝；脚本在该账号的 Chrome 中打开一个后台标签页，用完即关闭；最后打印一段 Markdown 摘要和所写文件的路径。成功时退出码为 `0`，平台还没算完当天数据时为 `2`（不写任何文件），账号在平台上已退出登录时为 `3`，命令行有误时为 `64`，其他情况为 `1`，原因写到 stderr。

- `scripts/alimama-scene-report.mjs` 打开万相台当天的账户报表页，截获页面自己发出的场景查询（其中的 `csrfId` 和 `loginPointId` 在运行时生成），带上自己要读的字段再发一次。页面被送到登录框且登录框提供「进入后台」时，进入一次。没有任何场景，或所有场景的去重成交人数（`alipayInshopUv`，约在次日上午 10 点后算完）都是 0 时，以数据未就绪停止。否则写出 `万相台营销场景报表_<店铺>_<日期>.csv`（每个场景一行：花费、展现、点击、成交、加购和自然流量，比率用未舍入的数值重新计算）以及带合计的 `.md` 摘要。
- `scripts/sycm-core-daily.mjs` 调用自助取数的接口：查找「店铺经营核心日报」模板、发起导出、取下载地址（最多轮询两分钟），然后从这个签名地址下载 .xlsx（最近 30 天）。文件里没有这一天即为未就绪，提示中写明文件覆盖的日期和生意参谋显示的数据更新日期。随后在同一标签页中，把关键词推广、精准人群推广、全站推广的花费与万相台场景 371、372、436 比较，允许 1 分钱误差。写出 `生意参谋店铺经营核心日报_<店铺>_<日期>.csv`（这一天的全部列）、导出的 `.xlsx` 和 `.md` 摘要；摘要第一行是 ✅ 一致、❌ 及每一处差异，或 ⚠️ 及未能询问万相台的原因。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由 Skill Hub 安装和 bash 工具；DSH 不加载本包。已安装技能在技能目录中的描述就是其 `SKILL.md` 的 `description`，用中文写给租户员工。正文告诉模型：按 `ecommerce-accounts` 的规则选账号，从 `load_workspace_dependencies` 取得 Node 路径，在一次 bash 调用中按技能基础目录运行脚本，以及各退出码的含义：转述摘要和文件路径；数据未就绪时如实说明，不拼凑数字；已退出登录时请用户到设置页，不换店；花费不一致时把两边的数字都告诉用户。脚本把摘要（几行的表格）打印到 stdout，停止时把一行原因打印到 stderr。

#### KV Cache 影响

无直接影响；安装或移除技能时，技能目录的变化与任何已安装技能相同。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **只支持天猫商家账号** —— 淘宝、拼多多、抖店的数据以及买家账号技能不在本包。
- **页面接口随平台变化** —— 报表查询及其会话字段、自助取数模板名和导出接口都属于万相台和生意参谋；它们改动时脚本会说明原因并停止，直到更新。
- **各凭一个信号判断就绪** —— 万相台以任一场景有成交人数为就绪，生意参谋以导出文件中有当天的行为就绪；当天有投放但没有成交会被判为未就绪。
- **归因数据会变化** —— 万相台会把点击之后几天的成交算进来，同一天稍后再取，成交数字可能更大。
- **生意参谋只有最近 30 天** —— 模板只导出最近 30 天。
- **只交叉校验花费** —— 访客、支付和买家数在这里没有第二个来源。
- **导出会留下记录** —— 每次运行生意参谋技能都会在店铺的自助取数下载列表里多一条导出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

脚本复用 `@deepseek-ai/dsh-ecommerce-accounts` 的 `Cdp`，因此 `ws` 被打包进每个脚本；打包结果除 Node 内置模块外不得有其他 import，`tests/pack.spec.ts` 会检查这一点。

</details>
