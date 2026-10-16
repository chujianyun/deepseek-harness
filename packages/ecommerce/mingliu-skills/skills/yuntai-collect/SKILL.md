---
name: yuntai-collect
description: "云台每日补采（上海名流卫生用品·市场中心-推广部）。当用户要求补采云台数据、补充某天的三方外投账户数据、把站外投流账户数据写进站外投流数据 Base，或定时任务执行云台补采时使用。按站外投流 Base 各服务商表的最大日期找缺口 → 用 yuntai-details 技能逐天取云台三方外投抖音账户明细（账户行与总计行对平才算取全）→ 按账户名归类服务商、去掉表里已有的记录 → 只新增写入对应服务商表 → 写后核对 → 断点记在智能体工作区。Base 与各服务商表读配置文档《投流ROI巡检配置》「数据源映射」，不写死；只新增，绝不修改、删除已有记录。"
---

# 云台每日补采

把健康品牌云台三方外投（抖音）每个账户每天的数据补进站外投流数据 Base 的各服务商表。**只新增：绝不修改、绝不删除表里已有的记录；同一天同一账户只写一条；账户行与总计行对不平就不写。**

## 工作区文件

都在智能体工作区（当前会话的工作目录）的 `yuntai-collect/` 下：

- `tables.json`（可选，管理员放置）：`{"base_token": "…", "tables": {"<服务商>": "<table_id>", …}}`。有这个文件时用它代替配置文档里的「数据源映射」（例如测试期间指向测试 Base）。
- `checkpoint.json`（技能读写）：`{"breakpoint": "YYYY-MM-DD", "per_table_max": {…}, "last_run": {"dates": […], "written": {…}, "self_operated": […], "unknown_provider": […], "failed": "…"}, "updated_at": "<ISO 时间>"}`。只在某天整天写完并核对通过后前移，是找缺口的依据；某天只写进部分表时不前移，下次重跑这天，表里已有的记录自动跳过。
- `<运行日 YYYYMMDD>/`（按今天，下文 `<运行目录>`）：`tables.json`、`records/`（写前各表记录）、每个补采日期一个子目录 `<数据日期 YYYYMMDD>/`（下文 `<日目录>`：`accounts.json`、`plan.json`、`batch-*.json`、`records-after/`）。

## 执行流程

Python 用 `load_workspace_dependencies` 返回的自带解释器（`<python>`），`<技能目录>` 指本技能目录。Windows 上以带引号的路径开头的命令前加 `& `。目录先建好（bash `mkdir -p`，PowerShell `New-Item -ItemType Directory -Force`）。

1. **读配置**：工作区有 `yuntai-collect/tables.json` 时把它复制为 `<运行目录>/tables.json`，跳过配置文档；否则用 `lark-cli docs +fetch`（只读）读配置文档《投流ROI巡检配置》https://scnntx5zuepg.feishu.cn/docx/DdcJd7xIyoX1FgxTd5dcAOHXnue 「数据源映射」，把站外投流数据 Base 的 token 和各服务商表的 table_id 写成 `<运行目录>/tables.json`：`{"base_token": "…", "tables": {"<服务商>": "<table_id>", …}}`（服务商名用下表的写法）。读不到 → 停止，报告原因。
2. **读各表**：对 `tables.json` 里每张表，分页把「日期」「账户id」两列读出来存文件（只读），`<n>` 从 0 起，每页 200 条，直到返回里没有更多：
   ```bash
   lark-cli base +record-list --as user --base-token <base_token> --table-id <table_id> --field-id 日期 --field-id 账户id --limit 200 --offset <n×200> --format json > <运行目录>/records/<服务商>-<n>.json
   ```
3. **找缺口**：`<python> <技能目录>/scripts/collect_plan.py gap --records <运行目录>/records --to <昨天> --checkpoint yuntai-collect/checkpoint.json`。断点 = checkpoint 记下的最后一个整天写完的日期；还没有 checkpoint（第一次运行）时取各表最大日期中最晚的一天；`pending` 是断点之后到昨天要补的日期（最多 14 天）。为空 → 结束，报告「断点已是最新（截至 X 月 X 日），今日无需补数」。
4. **逐天补采**（按日期从早到晚，某天失败就停在这天，后面的日期下次再补）：
   1. 运行 `dsh-ecommerce accounts`，选店铺为「名流官方旗舰店」的健康品牌云台账号（`platform` 为 `yuntai`）；没有或已过期 → 停止，报告「需人工介入：请在 DSH 设置 → 电商账号重新登录健康品牌云台」。按 yuntai-details 技能的说明取这一天的账户明细：
      ```bash
      "<node>" "<yuntai-details 技能目录>/scripts/yuntai-accounts.mjs" --account <账号 id> --date <日期> > <日目录>/accounts.json
      ```
      退出码 2（未就绪）→ 停止，报告；3 → 停止，报告需重新登录；其他失败重试 1 次仍失败 → 停止，报告原因。
   2. `<python> <技能目录>/scripts/collect_plan.py plan --accounts <日目录>/accounts.json --tables <运行目录>/tables.json --records <运行目录>/records --out <日目录>`。退出码 2（如账户行与总计行对不平）→ 停止，报告原因。
   3. 对 `plan.json` 的 `writes` 每一项单独运行一条命令（`@` 参数加单引号）：
      ```bash
      lark-cli base +record-batch-create --as user --base-token <base_token> --table-id <table_id> --json '@<file>'
      ```
      不用管道、不拼别的命令；只用这一个写入命令，**不用** `+record-upsert`、`+record-batch-update`、`+record-delete`。报错 → 不重试，先做下一步核对：已写进去的不再写，没写进去的下次运行再补。
   4. **写后核对**：把写过的表按第 2 步重新分页读到 `<日目录>/records-after/`，运行 `<python> <技能目录>/scripts/collect_plan.py verify --plan <日目录>/plan.json --records <日目录>/records-after`；退出码 1（漏写或重复）→ 停止，报告「需人工介入」及明细。
   5. 这一天通过后，更新 `checkpoint.json` 的 `breakpoint` 为这一天；下一天用 `records-after` 里的新记录接着查重（把它们复制进 `<运行目录>/records/` 覆盖同名文件）。当天云台没有任何账户行（没有投放）也照样前移断点，记「无数据」。
5. **报告**：断点、补采日期、各服务商写入条数、表里已有而跳过的条数；自营账户（名称含 `-ML-`，自营表已不存在）、认不出服务商的账户、配置里没有表的服务商逐一列出；失败日期与原因。只写采集报告，不做额外解读。

## 服务商归类

| 账户名特征 | 服务商 |
|---|---|
| 含 `-ML-`（名流-官旗粉MO-ML-*、名流-爆款003-ML-*） | 自营（不写） |
| 含「豹擎」 | 豹擎 |
| 含「道有道」或「CID-」 | 道有道 |
| 含「剧星」 | 剧星 |
| 含「声势」 | 声势 |
| 含「旋龟」 | 旋龟 |
| 含「耀阳」 | 耀阳 |
| 含「青出蓝」 | 青出蓝 |
| 含「在达」 | 在达 |
| 含「大小无忧」 | 大小无忧 |

剧星、旋龟在停投过渡期，照常采集写入。出现新的服务商时，脚本把它列为「认不出服务商」，报告给用户，不猜。

## 写入字段

账户id、账户名称、投放平台（抖音）、日期（`YYYY-MM-DD 00:00:00`）、消耗、总GMV、有效GMV、退款率（小数，取页面展示值，不用退款金额÷总GMV 反推）、退款金额。总ROI、有效ROI 是表里的公式列，不写。

## 纪律

- 只新增，同一天同一账户只写一条；账户行与总计行四项（消耗、总GMV、有效GMV、退款金额）对不平就不写。
- 只读采集：不改云台投放、不导出下载。
- 只在出错时打扰用户：浏览器或登录不可用、对不平、写入失败。
