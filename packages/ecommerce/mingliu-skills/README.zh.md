---
description: "名流运营技能，只由名流的 Skill Hub 下发——天猫一店与拼多多部门 AI 巡检及其月度配置更新，站外投流 ROI 巡检、拼多多日会待办同步，以及视频素材绩效日报——名流运营日报助手的推荐任务，以及构建技能上传包的步骤。"
kind: "package-reference"
---
# 名流运营技能

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-mingliu-skills` 保存名流（上海名流卫生用品）从 Aily AI 工作伙伴迁移过来的技能，不随 DSH 发布：由名流管理员只上传到名流的 [Skill Hub](../../../docs/glossary.zh.md#skill-hub)。内容包括天猫一店与拼多多部门巡检及其月度配置（`ai-inspection`、`inspection-config-update`）、站外投流 ROI 巡检（`roi-inspection`），拼多多日会待办同步（`pdd-meeting-todos`）、拼多多直播数据（`pdd-live-report`）、云台补采与计划 ROI 分析（`yuntai-collect`、`plan-roi-analysis`）、天猫日报采集填报（`tianmao-daily-report`），以及视频素材绩效日报（`video-performance-report`）。本包还保存名流运营日报助手的推荐任务，由[智能体包](../../assistant/assistant-packages/README.zh.md)携带。

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

`packAgent(outDir)` 把名流的「运营日报助手」打成[智能体包](../../assistant/assistant-packages/README.zh.md)，即 `<outDir>/<name>-<version>.zip`，内含 `<name>/` 目录：`agent/agent.json`（名称 `mingliu-ops-report`、头像、技能子集——名流技能、它们调用的 `tmall-daily-figures`、`yuntai-details`、`pdd-live-figures` 取数技能，以及 office 文档技能——连接器只有飞书），加上 `readTasks()` 的九条任务；以及 `agent/` 下的核心文件 `IDENTITY.md`、`SOUL.md`、`USER.md`、`AGENTS.md`。核心文件写入交接包的纪律：推送和写入前先出预览、配置读文档或工作区、数值可追溯且绝不估算、按名称定位行列、天猫日报写表前先回测、新旧任务并存期间不重复做。租户管理员在用户中心上传这个 zip；安装后所有任务都处于停用状态。

`readTasks()` 按文件名顺序读取推荐任务（`agent/tasks/` 下每个任务一个 JSON 文件），与智能体包 `agent.json` 列出的格式相同：id、标题、指令、运行时间及时区、免确认普通写操作的连接器（`ai-inspection` 不授予，它唯一的写操作是发卡片）、权限预设，以及无人值守运行可执行的[操作](../../schedule/automation-tasks/README.zh.md)。`ai-inspection` 在工作日 11:00（Asia/Shanghai）运行，指令沿用它所替代的 Aily 任务，从配置文档读取当月表格映射；名流测试期间，卡片只发到巡检测试群。`roi-internal-report`（工作日 09:30）与 `roi-provider-reminder`（周一、三、五 10:00）只出预览、不声明操作：用户在该会话回复「发送内部日报」或「发送外部提醒」后才发出日报或提醒；运行断点存于智能体工作区的 `roi-inspection/checkpoint.json`，发送后才前移，所以下一次运行不会重复统计同几天。名流测试期间，日报发到测试群，所有提醒发到测试群的 webhook。`pdd-meeting-todos`（工作日 17:00）只声明 `lark-cli base +record-batch-create`，并把记录放在 JSON 文件里传给它：只追加当天的待办，从不修改或删除记录。它的会议表、待办表、日会组织者和负责人 open_id 来自智能体工作区的 `pdd-meeting-todos/config.json`，旁边是已同步的会议（`synced.json`）和人工删除过、永不再写入的待办（`exclusions.json`）。`video-report`（工作日 10:00，取昨天）与 `video-reminder`（工作日 17:30，取今天）按固定三平台模板发送，所有数据项为「数据待更新」，只 @ `video-performance-report/config.json` 里的那个人，并把每次发出的日报记进 `sent.json`，同一天重跑不会重复发；遇法定节假日静默，节假日由技能的 `scripts/holiday.py` 用自带 Python 的 chinese_calendar 判断；名流测试期间发到测试群。

`tianmao-daily-report`（工作日 06:00）把最近 10 天到昨天之间仍有空格的每一天，在当月天猫日报表「店铺整体」中的「实际完成」列填上，表从《AI巡检固化配置》读取（测试时从智能体工作区的 `tianmao-daily-report/sheet.json` 读取）：店铺gmv 以及外投、自投、推广的花费、成交和投产，数来自 `@deepseek-ai/dsh-tmall-skills` 的 `tmall-daily-figures` 技能用这家店的天猫和健康品牌云台账号读到的数（外投 = 三方外投总计减去 `ML` 账户；推广 = 万相台三个场景，1 天累计归因）。它的 `scripts/daily_report.py` 按表头「实际完成（M月D日）」找列、按 A 列指标名找行，把元换算成万元，只写空格、从不替换人工填的数，跳过公式格、名称不唯一的行和为 null 的数，并为每段相邻单元格写一个 `+cells-set` 文件；写后核对写入的格能读回、该列其他非公式格没有变。任务只声明 `lark-cli sheets +cells-set`，以 `--as user` 运行。回测闸门：`daily_report.py backtest` 与最近某天人工填报的数相差都在 1% 以内（外投成交 2%）或 0.005 万元的舍入以内后，才记入智能体工作区的 `tianmao-daily-report/backtest.json` 并开始写这个月；此前运行只做回测。

`pdd-live-report`（每天 09:30）用 `@deepseek-ai/dsh-tmall-skills` 的 `pdd-live-figures` 技能取数，把拼多多直播店的数据追加到智能体工作区 `pdd-live-report/config.json` 指定的「直播数据每日」表。它的 `scripts/live_row.py` 列出表中最后日期之后到昨天为止还没写的日期（最多一周），生成下一行——A 列斜杠日期、D 列客单价公式 `=B/C`、E 列转化率 `0.00%`——表里已有的日期跳过；早于最后日期、表末行不是日期（如「合计」）或超出表格行数时拒绝；并核对回读的这一行、确认其他行没有变。任务只声明 `lark-cli sheets +cells-set`，以 `--as user` 运行。

`yuntai-collect`（工作日 07:00）把站外投流 Base 缺少的健康品牌云台三方外投抖音账户行补到昨天。Base 和各服务商表来自《投流ROI巡检配置》「数据源映射」，或来自智能体工作区的 `yuntai-collect/tables.json`（测试时指向测试 Base）。它的 `scripts/collect_plan.py` 按 `yuntai-collect/checkpoint.json` 的断点找缺口（某天整天写完并核对通过才前移；第一次运行取各表最晚日期），最多两周；能读 `+record-list` 的矩阵输出；`yuntai-details` 技能取到的账户行与总计行对不平的那天拒绝写；按账户名归类服务商，跳过表里已有的同日同账户，自营（`-ML-`）和认不出的账户不写、列出；每个服务商写一个 `+record-batch-create` 文件，并核对每行在表里恰好一条。任务只声明 `lark-cli base +record-batch-create`，以 `--as user` 运行；某天通过核对后断点才前移。`plan-roi-analysis` 按需运行、没有定时任务：它的 `scripts/plan_roi.py` 把窗口内消耗过线（默认 700 元）的计划按有效ROI（默认 1.5、1.2）分档，生成 card 2.0 卡片——摘要、高 ROI 计划、优先加码 5 条、最低 10 条建议关停、账户维度——并自检结构与大小；技能先出预览，用户要求时才以 `--as bot` 发到《投流ROI巡检配置》「内部日报接收」群。

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
- **工作区配置需手工放置** — 交接包没有待办同步和视频日报的配置文档，由名流管理员写 `pdd-meeting-todos/config.json`，填入各表和在 MO 飞书应用下查到的负责人 open_id，写 `video-performance-report/config.json` 指定视频日报 @ 的人，并写 `pdd-live-report/config.json` 指定直播表和店铺，并把交接包里的删除记录复制进 `exclusions.json`；名流测试期间待办表指向测试表。
- **视频日报受节假日数据年份限制** — 自带 chinese_calendar 没有当年数据时，`holiday.py` 以退出码 2 结束，日报不发送，直到某个桌面端版本带上新一年的节假日。
- **Windows PowerShell 5.1 下的内联消息 JSON** — `lark-cli im +messages-send` 只接受内联内容，Windows PowerShell 5.1 传参时可能丢掉其中的双引号；桌面端优先使用的 PowerShell 7 能原样传递。Windows 发送在名流验收时检查。
- **日报表的读写权限尚未验证** — `tianmao-daily-report` 以登录 MO 飞书连接器的用户身份（`--as user`，与交接包相同）读写表格；这个用户能否编辑当月日报表、各平台在 06:00 前是否已有昨天的数，在名流验收时核对。淘客几行不填：子账号要等主账号授权后才能打开淘宝联盟。
- **连续未达标提醒保持暂停** — 流程保留在技能参考文件中，名流要求恢复时才执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

技能来自名流的交接包（AI工作伙伴项目运行包 v2，2026-10-12）：Aily 的工具、工作区路径和评论交付都换成了 MO 的，已归档的直连推送脚本、按月的映射快照和交接包里的 webhook 文件没有迁入。`tests/pack.spec.ts` 确保技能文件里没有 Aily 名称和群或人员 id。

本包只在仓库内使用（[`scripts/repository-only-package-policy.ts`](../../../scripts/repository-only-package-policy.ts)）：名流拿到的是 zip，不是本包。

</details>
