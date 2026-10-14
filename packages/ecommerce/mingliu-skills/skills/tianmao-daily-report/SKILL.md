---
name: tianmao-daily-report
description: "天猫日报采集填报（上海名流卫生用品·名流官方旗舰店）。当用户要求「采集昨日数据并填报」「跑一遍天猫日报」「天猫日报数据同步」「把采集数据填进日报表」「天猫日报回测」，或定时任务执行天猫日报填报时使用。流程：节假日跳过 → 定要补的日期（最近 10 天里还空着的，默认到昨天）→ 读云文档《AI巡检固化配置》第五节拿当月日报表 → 回测闸门（换月后首跑只回测、不写表）→ 用 tmall-daily-figures 技能采集生意参谋、万相台、健康品牌云台 → 脚本按 A 列指标名定位行、按表头定位「实际完成」列并换算万元 → 只写映射行里空着的非公式格（人工填过的不覆盖）→ 回读核对 → 报告。缺证据不填、绝不估算，不发群消息。"
---

# 天猫日报采集填报

把名流官方旗舰店每天的店铺 GMV、外投、自投、推广数据填进当月天猫日报表「店铺整体」的「实际完成」列。任务只在工作日跑，所以每次都把最近 10 天里还空着的日期一起补上（周一补周五到周日，节后补整个假期）。**按 A 列指标名定位行，不写死行号；只写下表中的指标；只写空格，人工填过或改过的格不覆盖；公式格、没有采集来源的行、其他列一律不碰。**

## 填哪些指标

| A 列指标名 | 来源（采集单位元，写入换算） |
|---|---|
| 店铺gmv | 生意参谋全店支付金额，÷10000 保留 2 位（万元） |
| 外投花费 / 外投成交 | 云台三方外投消耗 / 有效GMV，各减去自投（ML 账户），万元 |
| 自投花费 / 自投成交 | 云台 ML 账户合计的消耗 / 有效GMV，万元 |
| 推广花费 / 推广成交 | 万相台关键词推广 + 人群推广 + 货品全站推三个场景合计（转化统计周期 1 天累计），万元 |
| 外投投产 / 自投投产 / 推广投产 | 成交 ÷ 花费（用元值相除），保留 2 位，不换算 |

A 列指标名去掉空格和括号说明后完全相等才算命中（「外投花费（辅助项）」→「外投花费」）。会员、私域、客服、直播、店铺排名、店铺费比以及表中其他指标都不写，留给负责人手填或表内公式。MO / 003 单品支付金额照常采集，只保留在采集文件里备查。

## 工作区文件

都在智能体工作区（当前会话的工作目录）的 `tianmao-daily-report/` 下：

- `sheet.json`（可选，管理员放置）：测试期间指向测试表，`{"spreadsheet_token": "…", "sheet_id": "…"}`；上线时删掉，改读配置文档。
- `backtest.json`：回测通过的月份，`{"month": "YYYY-MM", "passed_at": "<ISO 时间>", "dates": ["YYYY-MM-DD", …], "note": "…"}`。
- `YYYYMMDD/`（按要填的日期）：`tmall.json`、`yuntai.json`（采集结果）、`cells-before.json`、`plan.json`、`cells-*.json`（写入内容）、`cells-after.json`。回测日期 D 的采集放在 `backtest-YYYYMMDD/`。

## 执行流程

Python 用 `load_workspace_dependencies` 返回的自带解释器；下文 `<python>` 指它，`<技能目录>` 指本技能目录。Windows 上以带引号的路径开头的命令前加 `& `。

1. **节假日**：`<python> <技能目录>/scripts/holiday.py <今天 YYYY-MM-DD>`。`"holiday": true` → 输出「今日为法定节假日，跳过」并结束（假期里的日期由节后第一次运行补上）；退出码 2（日历没有今年数据）→ 不填，报告「需人工介入」及原因。
2. **定日期范围**：默认为最近 10 天到昨天（Asia/Shanghai）；用户指定日期时只处理那一天。范围跨两个月时按月份分开，各用当月的表，下面 3~9 步每个月走一遍。
3. **读配置**：工作区有 `tianmao-daily-report/sheet.json`（`{"spreadsheet_token": "…", "sheet_id": "…"}`，测试期间由管理员放置、指向测试表）时用它，跳过配置文档；否则用 `lark-cli docs +fetch`（只读）读云文档《AI巡检固化配置》https://scnntx5zuepg.feishu.cn/docx/E3cXdNjFQoPknUx34NscD0lAnZb 第五节「当月表格映射」，取这个月「天猫一店」的 spreadsheet_token 与「店铺整体」sheet_id。没有这个月的映射 → 这个月不采集、不写表，报告「需人工介入：配置文档缺少 YYYY-MM 天猫日报表映射，请先用 inspection-config-update 更新」。
4. **读表**：先 `lark-cli sheets +workbook-info --as user --spreadsheet-token <token>` 看「店铺整体」的行数、列数，再把整张表的值和公式存成文件（只读）：
   ```bash
   lark-cli sheets +cells-get --as user --spreadsheet-token <token> --sheet-id <sheet_id> --range A1:<末列><末行> --include value,formula > tianmao-daily-report/<YYYYMMDD>/cells-before.json
   ```
   `<YYYYMMDD>` 用这次要填的那一天。`has_more` 为 true 时缩小行范围（指标行都在表的前几十行）再读，不要拿截断的文件计算。
5. **回测闸门**：读 `backtest.json`。`month` 等于这个月 → 跳到第 6 步。否则这个月本轮**只回测、不写表**：
   1. `<python> <技能目录>/scripts/daily_report.py candidates --cells <cells-before.json>`，列出店铺gmv、外投成交、自投成交、推广成交都已有人工填报值的日期，最近的在前。没有 → 报告「本月暂无可回测日期：请负责人先手工填报至少 1 天的店铺gmv/外投/自投/推广实际完成，下一轮自动回测」并结束这个月。
   2. 取最近的 1~2 个日期 D，按第 7 步对每个 D 采集（存到 `backtest-YYYYMMDD/`），再运行 `<python> <技能目录>/scripts/daily_report.py backtest --cells <cells-before.json> --date <D> --figures <tmall.json> --figures <yuntai.json>`。金额差异 ≤1%（外投成交 ≤2%）或在 0.005 万元的舍入以内判通过，投产随花费与成交判定。
   3. 全部通过 → 写 `backtest.json`（month 为这个月），报告「回测通过，下一轮起按此口径填报」并附回测表；任一不通过 → 不写 `backtest.json`，报告差异项，交用户判断映射是否要调整。
   4. 用户看过上月回测结论后明确指示「本月沿用上月口径」时，可直接把 `backtest.json` 的 month 改为当月，并在 `note` 写明「接手人指示沿用 YYYY-MM 口径」。
6. **要填的日期**：`<python> <技能目录>/scripts/daily_report.py pending --cells <cells-before.json> --from <范围起> --to <范围止>`，列出这个月范围内映射指标还有空格的日期，早的在前。没有 → 这个月不用填。下面 7~9 步按日期从早到晚逐天做，每天都重新读一次表（第 4 步）作为这一天的 `cells-before.json`。
7. **采集**：运行 `dsh-ecommerce accounts`，选店铺为「名流官方旗舰店」的天猫商家账号（`platform` 为 `tmall`）和健康品牌云台账号（`platform` 为 `yuntai`）；没有这样的账号或已过期 → 停止，报告「需人工介入：请在 DSH 设置 → 电商账号登录名流官方旗舰店的天猫 / 健康品牌云台账号」。按 tmall-daily-figures 技能的说明运行它的两个脚本，把输出存进文件：
   ```bash
   "<node>" "<tmall-daily-figures 技能目录>/scripts/tmall-daily-figures.mjs" --account <天猫账号 id> --date <日期> --item MO=610081277604 --item 003=524565741530 > tianmao-daily-report/<YYYYMMDD>/tmall.json
   "<node>" "<tmall-daily-figures 技能目录>/scripts/yuntai-daily-figures.mjs" --account <云台账号 id> --date <日期> --self-keyword ML > tianmao-daily-report/<YYYYMMDD>/yuntai.json
   ```
   脚本退出码不是 0（账号要重新登录、页面不是这家店等）→ 不重试超过 1 次，报告「需人工介入」及脚本给出的原因；已经成功的那一份照常用于填报。
8. **计划与写入**：`<python> <技能目录>/scripts/daily_report.py plan --cells tianmao-daily-report/<YYYYMMDD>/cells-before.json --date <日期> --figures tianmao-daily-report/<YYYYMMDD>/tmall.json --figures tianmao-daily-report/<YYYYMMDD>/yuntai.json --out tianmao-daily-report/<YYYYMMDD>`。它按表头找到「实际完成（M月DD日）」列、按 A 列找行，算出每格要写的值，跳过公式格、已有值的格、定位不唯一和来源为 null 的指标（`skipped` 写明原因），并为每段连续空格写好 `cells-*.json`。退出码 2 → 这一天不写，报告原因。然后对 `plan.json` 的 `files` 每一项单独运行一条命令（`@` 参数加单引号）：
   ```bash
   lark-cli sheets +cells-set --as user --spreadsheet-token <token> --sheet-id <sheet_id> --range <range> --cells '@<file>'
   ```
   不用管道、不在命令里拼别的命令；不写 `files` 以外的任何单元格。某条报错 → 不重试，继续回读核对，报告哪段没写上。
9. **回读**：按第 4 步同样的范围再读一次存为 `cells-after.json`，运行 `<python> <技能目录>/scripts/daily_report.py verify --plan tianmao-daily-report/<YYYYMMDD>/plan.json --before tianmao-daily-report/<YYYYMMDD>/cells-before.json --after tianmao-daily-report/<YYYYMMDD>/cells-after.json`；退出码 1 → 报告「需人工介入」及不一致的单元格。
10. **报告**：逐天写日期、各指标元值与写入值（万元）、写入单元格清单、跳过项及原因（含「已有值，未覆盖」）、回读结论；采集文件 `notes` 里的口径与自检结果（如云台媒体合计与总计不一致、某场景当天没有数据按 0 计）一并列出。异常时首行写「需人工介入」及原因。

## 纪律

- 只写「实际完成」列里映射指标空着的非公式格；人工填过或改过的格不覆盖；不碰目标、完成率、原因及策略列，不碰其他行。
- 缺证据不填：来源为 null 的指标及其投产都不写，绝不估算、绝不用前后日替代。
- 每个写入值都能追溯到 `tmall.json` / `yuntai.json` 里的元值。
- 不发任何群消息、不推送巡检日报。
