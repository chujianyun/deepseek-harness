---
name: pdd-live-report
description: "拼多多直播数据每日采集（上海名流卫生用品·拼多多直播店）。当用户要求「采集昨天的拼多多直播数据」「更新直播数据每日表」「补一下拼多多直播数据」，或定时任务执行拼多多直播数据采集时使用。用 pdd-live-figures 技能取直播成交额、支付订单、支付转化率、人均观看时长、累计观看量、千次进人成交、直播间涨粉数，追加到飞书「直播数据每日」表的下一行：A 列斜杠日期、D 列客单价写公式、E 列百分比格式，写后回读核对。表和店铺读智能体工作区的配置文件；缺数据不写、绝不估算，同一天不重复写。"
---

# 拼多多直播数据每日采集

每天把拼多多直播店前一天的直播数据追加到飞书在线表「直播数据每日」。**只在表的末尾追加新行，不修改已有行；同一天只写一次；数据没出来就不写。**

## 工作区文件

智能体工作区（当前会话的工作目录）的 `pdd-live-report/` 下：

- `config.json`（管理员放置，必需）：`{"spreadsheet_token": "<表 token>", "sheet_id": "<「直播数据每日」sheet_id>", "store": "<电商账号里的拼多多店铺名>"}`。缺少 → 停止，报告「缺少 pdd-live-report/config.json 配置」，不猜测表。
- `<运行日 YYYYMMDD>/`（按今天）：`cells-0.json`（开始时读到的表）；每写一天一个子目录 `<数据日期 YYYYMMDD>/`：`live.json`（采集结果）、`plan.json`、`row.json`、`cells-after.json`。

## 写入格式（与原表一致）

| 列 | 内容 | 格式 |
|---|---|---|
| A | 数据日期 | 斜杠日期，如 2026/10/8（写成 2026-10-08 会落成文本） |
| B | 直播GMV（直播成交额，元） | 两位小数 |
| C | 直播支付订单 | 整数 |
| D | 客单价 | 公式 `=B<行号>/C<行号>`，两位小数 |
| E | 直播支付转化率 | 百分比 `0.00%` |
| F | 人均观看时长（分钟） | |
| G | 千次进人成交 | 两位小数 |
| H | 直播间涨粉数 | 整数 |
| I | 每日观看量（累计观看量） | 整数 |

## 执行流程

Python 用 `load_workspace_dependencies` 返回的自带解释器；`<python>` 指它，`<技能目录>` 指本技能目录。Windows 上以带引号的路径开头的命令前加 `& `。

1. **读配置**：读 `pdd-live-report/config.json`。
2. **读表**：先建好本次运行的目录 `pdd-live-report/<今天 YYYYMMDD>/`（bash 用 `mkdir -p`，PowerShell 用 `New-Item -ItemType Directory -Force`；下文 `<运行目录>` 指它），再用 `lark-cli sheets +workbook-info --as user --spreadsheet-token <token>` 看「直播数据每日」的行数（下文 `<行数>`），把 A~I 列存成文件（只读）：
   ```bash
   lark-cli sheets +cells-get --as user --spreadsheet-token <token> --sheet-id <sheet_id> --range A1:I<行数> --include value,formula > <运行目录>/cells-0.json
   ```
   `has_more` 为 true 时分段读，不要拿截断的文件计算。
3. **要写的日期**：`<python> <技能目录>/scripts/live_row.py pending --cells <运行目录>/cells-0.json --to <昨天>`，列出表中最后日期之后、到昨天为止还没写的日期（最多 7 天，早的在前）。没有 → 结束，报告「直播数据已是最新」。下面 4~6 步按日期从早到晚逐天做；每一天的子目录 `<运行目录>/<数据日期 YYYYMMDD>/` 先建好（下文 `<日目录>`）。第一天用 `cells-0.json` 作为写前的表，之后每天用前一天的 `cells-after.json`，不必重读。
4. **采集**：运行 `dsh-ecommerce accounts`，选店铺为 config 里 `store` 的拼多多商家账号（`platform` 为 `pinduoduo`）；没有或已过期 → 停止，报告「需人工介入：请在 DSH 设置 → 电商账号重新登录拼多多」。按 pdd-live-figures 技能的说明运行脚本，输出存进文件：
   ```bash
   "<node>" "<pdd-live-figures 技能目录>/scripts/pdd-live-figures.mjs" --account <账号 id> --date <日期> > <日目录>/live.json
   ```
   退出码 2（数据未就绪）→ 这一天不写，报告「<日期> 直播数据未就绪」并结束本轮（后面的日期更不会有）；退出码 3 → 停止，报告需重新登录；其他失败重试 1 次仍失败 → 停止，报告原因。核对 `notes` 里的直播间名称是这家店；`missing` 不为空 → 这一天不写，报告缺哪几项。
5. **计划与写入**：`<python> <技能目录>/scripts/live_row.py plan --cells <写前的表> --figures <日目录>/live.json --out <日目录> --rows <行数>`。
   - 输出 `"status": "exists"` → 表里已经有这一天，不写，继续下一天。
   - 退出码 2（早于表中最后日期、表末行不是日期、表格行数已满、指标不全等）→ 不写，报告原因，结束本轮。
   - 否则按 `plan.json` 的 `range` 和 `file` 单独运行一条命令（`@` 参数加单引号）：
     ```bash
     lark-cli sheets +cells-set --as user --spreadsheet-token <token> --sheet-id <sheet_id> --range <range> --cells '@<file>'
     ```
     不用管道、不在命令里拼别的命令；不写这一行以外的任何单元格。报错 → 不重试，回读核对后报告。
6. **回读**：按第 2 步的范围再读一次存为 `<日目录>/cells-after.json`，运行 `<python> <技能目录>/scripts/live_row.py verify --plan <日目录>/plan.json --before <写前的表> --after <日目录>/cells-after.json`；退出码 1（某格不一致、D 列不是公式、其他行被改动）→ 报告「需人工介入」及不一致的单元格，不再写后面的日期。输出里的「提醒」（如 A 列回读为文字）原样写进报告。
7. **报告**：逐天写日期、7 项指标数值、写入的行号和回读结论；跳过的日期及原因。

## 纪律

- 只追加，不改已有行；同一天不写第二遍；不往表中间插行。
- 缺证据不写：数据未就绪、页面换了店、指标缺失都不写，绝不估算、不用前后日替代。
- 不发任何群消息。
