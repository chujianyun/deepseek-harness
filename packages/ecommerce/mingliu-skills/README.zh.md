---
description: "名流运营技能，只由名流的 Skill Hub 下发——天猫一店与拼多多部门 AI 巡检及其月度配置更新，站外投流 ROI 巡检，以及拼多多日会待办同步——名流运营日报助手的推荐任务，以及构建技能上传包的步骤。"
kind: "package-reference"
---
# 名流运营技能

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-mingliu-skills` 保存名流（上海名流卫生用品）从 Aily AI 工作伙伴迁移过来的技能，不随 DSH 发布：由名流管理员只上传到名流的 [Skill Hub](../../../docs/glossary.zh.md#skill-hub)。内容包括天猫一店与拼多多部门巡检及其月度配置（`ai-inspection`、`inspection-config-update`）、站外投流 ROI 巡检（`roi-inspection`），以及拼多多日会待办同步（`pdd-meeting-todos`）。本包还保存名流运营日报助手的推荐任务，由[智能体包](../../assistant/assistant-packages/README.zh.md)携带。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`packSkills(outDir)` 把 `SKILLS` 中的每个技能——`skills/<name>/` 下的整个文件夹，即 `SKILL.md` 及其旁边的参考文件，不含隐藏文件——以 `<name>/` 为根压缩成 `<outDir>/<name>.zip`，即 Skill Hub 接受的格式，条目名在所有平台上都用 `/` 分隔；之前的构建会被替换。它返回各 zip 的路径。在仓库根目录运行：

```sh
node --input-type=module -e "import { packSkills } from './packages/ecommerce/mingliu-skills/src/index.ts'; console.log(await packSkills('dist/mingliu-skills'))"
```

`readTasks()` 按文件名顺序读取推荐任务（`agent/tasks/` 下每个任务一个 JSON 文件），与智能体包 `agent.json` 列出的格式相同：id、标题、指令、运行时间及时区、免确认普通写操作的连接器（`ai-inspection` 不授予，它唯一的写操作是发卡片）、权限预设，以及无人值守运行可执行的[操作](../../schedule/automation-tasks/README.zh.md)。`ai-inspection` 在工作日 11:00（Asia/Shanghai）运行，指令沿用它所替代的 Aily 任务，从配置文档读取当月表格映射；名流测试期间，卡片只发到巡检测试群。`roi-internal-report`（工作日 09:30）与 `roi-provider-reminder`（周一、三、五 10:00）只出预览、不声明操作：用户在该会话回复「发送内部日报」或「发送外部提醒」后才发出日报或提醒；运行断点存于智能体工作区的 `roi-inspection/checkpoint.json`，发送后才前移，所以下一次运行不会重复统计同几天。名流测试期间，日报发到测试群，所有提醒发到测试群的 webhook。`pdd-meeting-todos`（工作日 17:00）只声明 `lark-cli base +record-batch-create`，并把记录放在 JSON 文件里传给它：只追加当天的待办，从不修改或删除记录。它的会议表、待办表、日会组织者和负责人 open_id 来自智能体工作区的 `pdd-meeting-todos/config.json`，旁边是已同步的会议（`synced.json`）和人工删除过、永不再写入的待办（`exclusions.json`）。

技能把一切会变的内容——当月表格 token 和列、推送目标、预警线、人员——都从名流的飞书配置文档《AI巡检固化配置》和《投流ROI巡检配置》读取，不写在自己的文件里；发送时经飞书连接器的 `lark-cli` 以智能体自身的飞书身份（`--as bot`）发出。服务商提醒经技能的 `scripts/send_webhook.py` 签名后发到群 webhook；脚本从智能体工作区的 `roi-inspection/webhook_mapping.json` 自己读取各 webhook 的地址和签名密钥，密钥不出现在命令里。飞书接受消息时退出码为 0，未送达为 1，结果未知、消息可能已送达为 2；遇到 2 时技能不重发。技能文件里没有任何 webhook 或密钥。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 Skill Hub 安装；DSH 不加载本包。已安装技能在目录中的描述是其 `SKILL.md` 的 `description`（面向名流员工，使用中文），模型使用技能时读取其正文和参考文件。技能让模型通过 `lark-cli` 读取飞书文档、表格和多维表，并以机器人身份发送交互卡片。

#### KV Cache 影响

没有直接影响；安装或移除技能会像其他已安装技能一样改变技能目录。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **事实都在配置文档里** — 表格 token、推送目标和 open_id 都在《AI巡检固化配置》中；智能体的飞书身份需要能读取它和各表格，open_id 只对读取它的那个飞书应用有效。
- **目前只发测试群** — 巡检任务只发测试群；JACK 和两个正式群在名流用真实账号验收时再加上。
- **webhook 密钥需手工放置** — 由名流管理员把 `roi-inspection/webhook_mapping.json` 放进每个运行该智能体的工作区；8 家服务商的 webhook 在名流同意做连通测试前都未验证。
- **待办同步的配置需手工放置** — 交接包没有它的配置文档，由名流管理员写 `pdd-meeting-todos/config.json`，填入各表和在 MO 飞书应用下查到的负责人 open_id，并把交接包里的删除记录复制进 `exclusions.json`；名流测试期间待办表指向测试表。
- **连续未达标提醒保持暂停** — 流程保留在技能参考文件中，名流要求恢复时才执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

技能来自名流的交接包（AI工作伙伴项目运行包 v2，2026-10-12）：Aily 的工具、工作区路径和评论交付都换成了 MO 的，已归档的直连推送脚本、按月的映射快照和交接包里的 webhook 文件没有迁入。`tests/pack.spec.ts` 确保技能文件里没有 Aily 名称和群或人员 id。

本包只在仓库内使用（[`scripts/repository-only-package-policy.ts`](../../../scripts/repository-only-package-policy.ts)）：名流拿到的是 zip，不是本包。

</details>
