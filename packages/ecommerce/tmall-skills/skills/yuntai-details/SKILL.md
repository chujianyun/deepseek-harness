---
name: yuntai-details
description: 云台三方外投明细：用 DSH 里已登录的健康品牌云台账号，取某一天某媒体（默认抖音）的全部账户行（账户id、账户名称、消耗、总GMV、有效GMV、退款率、退款金额、总ROI、有效ROI）并与总计行逐项对账，或取一段日期内的全部计划行（计划ID、计划名称、所属账户及同样的指标，按消耗从高到低）。输出一行 JSON；当天数据没出来时如实报未就绪，不估算。只读，不改动投放。
---

# 云台三方外投明细

读取健康品牌云台「三方外投」里店铺看板的「账户」「计划」两个页签的数据。脚本调用三方外投页自己的效果查询接口，逐页取全，不点击页面、不导出下载、不改动任何投放。

## 步骤

Windows 上命令行是 PowerShell：以带引号的路径开头的命令前要加调用符 `& `，例如 `& "<node>" "<本技能目录>/scripts/…" …`，否则 PowerShell 不会执行它。

1. 选账号：按 `ecommerce-accounts` 技能的规则运行 `dsh-ecommerce accounts`，从 `platform` 为 `yuntai` 的账号中选。调用方指定了店铺时按店铺名选；有多个可选又没有指定时先问用户；没有可用账号时停下，请用户到 DSH 设置 → 电商账号登录。
2. 取 Node：调用 `load_workspace_dependencies`，用它返回的 `node` 路径运行脚本。
3. 用一次命令行调用运行其中一个脚本（`scripts/` 相对本技能目录）：

   ```sh
   "<node>" "<本技能目录>/scripts/yuntai-accounts.mjs" --account <账号 id> --date <YYYY-MM-DD>
   "<node>" "<本技能目录>/scripts/yuntai-plans.mjs" --account <账号 id> --from <YYYY-MM-DD> --to <YYYY-MM-DD>
   ```

   - 日期只能是已经过去的日期（北京时间）；`--channel` 选媒体，目前只支持「抖音」（默认）。
4. 需要保存结果时，把脚本输出原样写进工作区的 JSON 文件，不要改动里面的数。

## 输出

成功时输出一行 JSON：`{"platform", "accountId", "store", "account", "data"}`。

- `yuntai-accounts.mjs` 的 `data`：`{"date", "channel", "store", "total", "accounts", "check"}`。`accounts` 每行：`账户id`、`账户名称`、`消耗`、`总GMV`、`有效GMV`、`退款率`（页面展示的比值，0.0835 即 8.35%，不要用退款金额÷总GMV 反推）、`退款金额`、`总ROI`、`有效ROI`；消耗为 0 或全 0 的账户也照常列出。`check` 是消耗、总GMV、有效GMV、退款金额四项的账户行合计与总计行的对比，`matches` 全部为 true 才算取全；当天没有投放时 `accounts` 为空、总计为 0。
- `yuntai-plans.mjs` 的 `data`：`{"from", "to", "channel", "store", "plans"}`，`plans` 是这段日期汇总的全部计划，按消耗从高到低，每行多 `计划ID`（19 位，原样保留）和 `计划名称`。

## 退出码

- `0`：成功。
- `2`：数据未就绪（云台还没有这一天的总计行）。如实告诉用户稍后再试。
- `3`：账号需要重新登录。请用户到 DSH 设置 → 电商账号重新登录，不要换别的店铺。
- `1` / `64`：其他失败或参数错误，把脚本的说明原样告诉用户。

## 规则

- 只读：不改投放、不导出下载。
- 一次只用调用方指定的账号；失败时不要自动换店。
