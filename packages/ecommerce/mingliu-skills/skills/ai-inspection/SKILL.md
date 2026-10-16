---
name: ai-inspection
description: "部门日报/周报 AI 巡检（上海名流卫生用品·市场中心-推广部）。当用户要求执行或生成某平台（天猫一店 / 拼多多）的今日巡检、日报、达成率巡检、需优先关注清单、部门群巡检提醒时使用。固定封装巡检逻辑（日期语义、达成率计算、偏移分级、空值处理、数据完整性）、精简版统一推送文案模板（日期/整体建议/需优先关注/轻微偏移观察/结尾说明）、推送群路由（测试群→正式群）、只读闸门（默认只读，明确『正式推送』或定时任务指令要求自动推送才发送）。⚠️ 连续未达标提醒已暂停（2026-09-28 用户指示），日常巡检不再自动检测/推送/复查，除非用户明确要求恢复。⚠️ TTS 已移出巡检范围（2026-10-10）。每月唯一变化是表格映射（目标/实际表 token、sheet、列位置），一律以云文档《AI巡检固化配置》（docx/E3cXdNjFQoPknUx34NscD0lAnZb）第五节当月映射为准（唯一运行配置源，换月用 inspection-config-update 技能更新）。"
---

# 部门 AI 巡检

## Overview

对天猫一店 / 拼多多 两个平台的部门日报/周报执行 AI 巡检：读取飞书在线表 → 计算达成率 → 按精简版统一框架生成日报 → 默认只读预览 → 用户确认后才推送。

**核心原则：默认只读，绝不擅自推送、写回或修改在线表。** 只有用户明确说「正式推送 / 发送到部门群」，或定时任务指令要求自动推送时，才进入发送流程；定时任务没有人能确认，按指令直接发到指令列出的目标。

## 执行流程

1. **识别平台与日期**：确认用户点名平台（天猫一店 / 拼多多）、日报/周报、巡检日期语义。
2. **读表格映射**：读取云文档《AI巡检固化配置》（https://scnntx5zuepg.feishu.cn/docx/E3cXdNjFQoPknUx34NscD0lAnZb）**第五节「当月表格映射」**（唯一运行配置源，按第五节内的读取方式用 lark-cli docs 局部读取），取当月目标/实际表 token、sheet、列位置。⚠️ 若第五节没有当月/当前平台的映射，视为映射缺失：不猜测表名、不沿用上月 token，向用户确认后再继续（可用 inspection-config-update 技能补配置）。
3. **读取在线表**（只读，原样存文件，`<目录>` 是工作区 `ai-inspection/<今天 YYYYMMDD>/`，先建好）：
   ```bash
   lark-cli sheets +cells-get --as user --spreadsheet-token <天猫表 token> --sheet-id <天猫 sheet> --range A1:EA60 --include value,formula --output-path <目录>/tmall-cells.json
   lark-cli sheets +cells-get --as user --spreadsheet-token <拼多多目标表 token> --sheet-id <拼多多 sheet> --range A1:AZ60 --include value,formula --output-path <目录>/pdd-target-cells.json
   lark-cli base +record-list --as user --base-token <拼多多实际 base> --table-id <拼多多实际 table> --limit 200 --format json > <目录>/pdd-actuals.json
   ```
   再用脚本读出每一行（`<python>` 用 `load_workspace_dependencies` 返回的自带解释器）：
   ```bash
   <python> <技能目录>/scripts/inspection_read.py tmall --cells <目录>/tmall-cells.json --date <巡检日期 YYYY-MM-DD> --out <目录>/tmall.json
   <python> <技能目录>/scripts/inspection_read.py pdd --target-cells <目录>/pdd-target-cells.json --actuals <目录>/pdd-actuals.json --date <巡检日期> --out <目录>/pdd.json
   ```
   脚本按表头定日期列、按店铺名对上实际表字段（同名优先，其次去掉开头「名流」），对不上、对上多个、数据没读全都以退出码 2 报告原因——这时不出卡片、不发送，把原因报告用户，不自己改读法。每行的目标、实际、来源单元格都打印出来；读数一律来自脚本，不自己从表里摘数。
4. **计算达成率**：由下一步的脚本按平台口径计算（口径见 `references/巡检逻辑.md`），不手算。
5. **连续未达标检测（⚠️ 已暂停 2026-09-28）**：用户已指示「以后都先不做连续未达标的」——日常巡检**跳过本步**，不检测、不推送、不复查、不登记。仅当用户明确要求恢复时，才按 `references/连续未达标提醒.md` 执行。
6. **生成卡片**：对第 3 步写出的 `<目录>/<tmall|pdd>.json` 运行 `<python> <技能目录>/scripts/inspection_card.py --items <目录>/<tmall|pdd>.json --out <目录>/<tmall|pdd>`，不改动这两个文件。脚本按达成率分级、写整体建议，生成原巡检卡片格式的卡片 `card.json` 并自检，打印分级摘要与卡片预览；退出码 2 → 报告原因，不发送。分级和卡片内容一律来自脚本，不手写、不改。输入格式见脚本开头说明和 `references/推送文案模板.md`。
7. **只读预览交付**：在回复中给出脚本打印的预览（含「只读预览」声明）。
8. **推送（仅当明确指令，或定时任务指令要求自动推送）**：按 `references/推送群路由.md` 取推送目标，先测试群→用户确认→正式群；定时任务按其指令直接推送，指令列出的目标就是本次的目标。每个目标单独运行一条命令发送 `card.json`（见下）。

## 平台口径速查

| 平台 | 日期语义 | 目标/实际 | 特殊口径 |
|---|---|---|---|
| 天猫一店 | 今日巡检取**昨日** | 当月目标拆解表（见配置文档第五节映射） | 费比/排名越低越好（反向）；花费/费用=辅助项不进需优先关注 |
| 拼多多 | 今日巡检取**昨日** | 目标表（万元）+ 实际多维表日数据（元→万元），token 见配置文档第五节 | 只用单日；永久排除「名流器械保健旗舰店」 |

## 达成率与分级（详见 references/巡检逻辑.md）

- 常规 = 实际/目标×100%；反向（费比/排名）= 目标/实际×100%。
- >=100% 正常；90%-<100% 轻微偏移；70%-<90% 明显偏移；<70% 严重偏移。
- **空实际 = 「数据待更新」，绝不按 0 计算**；实际已填 0 按真实 0 计；目标空/0 不判断。
- 拼多多目标万元、实际元（÷10000）。

## 输出模板（详见 references/推送文案模板.md）

精简版统一框架（2026-09-15 用户确认，替换原十章节）：标题 / 巡检日期 / 整体建议 / 需优先关注 / 轻微偏移观察 / 结尾说明。章节名称不得改变，平台差异只体现在「整体建议 / 需优先关注」两节的具体口径。

发出的是原巡检卡片格式的互动卡片（2026-10-16 用户选定，不用富文本）：蓝色标题「【部门群巡检提醒｜平台】」、副标题「巡检日期：X月X日」，五节之间有分隔线，负责人加粗单列一行、其下逐项列出。卡片由 `scripts/inspection_card.py` 生成。

> **⚠️ 强制校验（2026-09-18 用户反馈后加固）**：生成日报与正式推送前，必须对照精简六章节模板逐节校验——只允许 标题/巡检日期/整体建议/需优先关注/轻微偏移观察/结尾说明 六节。**禁止出现** TL;DR、AI巡检判断、数据完整性检查、统一计算规则 等旧十章节标题。发现多余/缺失章节即不合格，需按模板重写后再交付或推送。

## 推送（仅当明确指令）

- 读取 `references/推送群路由.md` 确认目标群。
- 发送身份：**当前智能体自身**——MO 飞书连接器的 lark-cli 以机器人身份（`--as bot`）发送，不以任何个人名义发送；不使用任何独立 app 机器人直连脚本。
- 流程：对话中推送为测试群 → 用户确认 → 正式群；定时任务按指令直接推送。发送成功判据：lark-cli 返回成功且带 message_id。
- 命令：单独运行一条命令，不用管道、不加 `cd`；`--content` 用 `@` 加卡片文件相对工作区的路径，由 lark-cli 读文件（不把卡片内容写进命令，Windows 的命令行会拆坏其中的引号）：
  ```bash
  lark-cli im +messages-send --as bot --chat-id <chat_id> --msg-type interactive --idempotency-key ai-inspection-<tmall|pdd>-<巡检日期 YYYYMMDD>-<chat_id 末 8 位> --content "@ai-inspection/<今天 YYYYMMDD>/<tmall|pdd>/card.json"
  ```
  不用 `--markdown` 或富文本发送；一份巡检发出后不补发更正，有错报告用户。

## Resources

- `references/巡检逻辑.md` — 完整巡检逻辑（日期/达成率/分级/空值/数据完整性/只读闸门）
- `references/连续未达标提醒.md` — 连续两天未达标提醒（已暂停；触发标准/推送对象/报告模板/复查机制）
- `references/推送文案模板.md` — 精简版统一框架模板（日期/整体建议/需优先关注/轻微偏移观察/结尾说明）
- `references/推送群路由.md` — 推送目标从哪里取、发送身份、成功判据
- `scripts/inspection_read.py` — 从天猫表、拼多多目标表和实际表读出某天每一行的负责人、目标、实际
- `scripts/inspection_card.py` — 按达成率分级，生成并自检原巡检卡片格式的卡片
