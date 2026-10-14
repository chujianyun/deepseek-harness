---
description: "名流's operations skills that only 名流's Skill Hub hands out — the department AI inspection of 天猫一店 and 拼多多 and its monthly configuration update, the ROI inspection of off-site advertising, the 拼多多 daily-meeting to-do sync, and the video performance report — the recommended tasks of 名流's operations assistant, and the step that builds the skills' upload packages."
kind: "package-reference"
---
# 名流 operations skills

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-mingliu-skills` holds the Skills 名流 (上海名流卫生用品) moved over from its Aily AI work partner, not shipped with DSH: 名流's admin uploads them to 名流's [Skill Hub](../../../docs/glossary.md#skill-hub) only. They cover the 天猫一店 and 拼多多 department inspection and its monthly configuration (`ai-inspection`, `inspection-config-update`), the off-site advertising ROI inspection (`roi-inspection`), the 拼多多 daily-meeting to-do sync (`pdd-meeting-todos`), the 拼多多 live data (`pdd-live-report`), the Tmall daily report fill (`tianmao-daily-report`), and the video performance report (`video-performance-report`). The package also keeps the recommended tasks of 名流's operations assistant, which an [assistant package](../../assistant/assistant-packages/README.md) carries.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`packSkills(outDir)` zips each skill in `SKILLS` — its whole folder under `skills/<name>/`, `SKILL.md` and the reference files beside it, without hidden files — as `<outDir>/<name>.zip` around `<name>/`, the layout Skill Hub accepts, with `/`-separated entry names on every platform; an earlier build is replaced. It returns the zip paths. From the repository root:

```sh
node --input-type=module -e "import { packSkills } from './packages/ecommerce/mingliu-skills/src/index.ts'; console.log(await packSkills('dist/mingliu-skills'))"
```

`readTasks()` reads the recommended tasks, one JSON file each under `agent/tasks/`, in file-name order, as the assistant package's `agent.json` lists them: an id, a title, the instruction, the timing and its zone, the connectors whose plain writes run unasked (none for `ai-inspection`, whose only write is sending its card), the permission preset, and the [operations](../../schedule/automation-tasks/README.md) its unattended runs may run. `ai-inspection` runs on weekdays at 11:00 Asia/Shanghai with the instruction of the Aily task it replaces, reading the month's table mapping from the configuration document; while 名流 tests it, it sends its card to the inspection test group only. `roi-internal-report` (weekdays 09:30) and `roi-provider-reminder` (Monday, Wednesday, Friday 10:00) only preview and declare no operations: the report or reminders go out when the person replies 「发送内部日报」 or 「发送外部提醒」 in that session, and the run's checkpoint in the assistant's workspace, `roi-inspection/checkpoint.json`, moves on only after sending, so a later run does not count the same days again. While 名流 tests them, the report goes to the test group and every reminder to the test group's webhook. `pdd-meeting-todos` (weekdays 17:00) declares only `lark-cli base +record-batch-create`, which it runs with the records in a JSON file: it adds the day's to-dos and never updates or deletes a record. Its meeting and to-do tables, the meeting's organizer, and the owners' open_ids come from `pdd-meeting-todos/config.json` in the assistant's workspace, beside the meetings it has synced (`synced.json`) and the to-dos a person deleted (`exclusions.json`), which it never writes again. `video-report` (weekdays 10:00, about yesterday) and `video-reminder` (weekdays 17:30, about today) send the fixed three-platform template with every figure 「数据待更新」, mentioning only the person in `video-performance-report/config.json` and recording each sent report in `sent.json` so a rerun the same day does not repeat it; they stay silent on a public holiday, which the skill's `scripts/holiday.py` reads from the bundled Python's chinese_calendar, and while 名流 tests them they send to the test group.

`tianmao-daily-report` (weekdays 06:00) fills, for each of the last 10 days up to yesterday that still has empty cells, the 「实际完成」 column of that day in the month's Tmall daily report sheet 「店铺整体」, which it finds in 《AI巡检固化配置》: 店铺gmv, 外投, 自投, and 推广 spend, sales, and ROI, from the figures the `tmall-daily-figures` skill of `@deepseek-ai/dsh-tmall-skills` reads with the store's Tmall and 健康品牌云台 accounts (外投 is the 三方外投 total less the `ML` accounts; 推广 is three Alimama scenes with one-day attribution). Its `scripts/daily_report.py` finds the column by the header 「实际完成（M月D日）」 and each row by its A-column name, converts yuan to 万元, writes only empty cells, so a person's entry is never replaced, skips formula cells, names that are not unique, and figures that are null, and writes one `+cells-set` file per run of adjacent cells; after writing it checks that the written cells read back and no other plain cell of the column changed. The task declares only `lark-cli sheets +cells-set`, run with `--as user`. A backtest gate keeps a month from being written until `daily_report.py backtest` matches the figures people filled on a recent day within 1% (外投成交 2%) or the 0.005 万元 of rounding, recorded in `tianmao-daily-report/backtest.json` in the assistant's workspace; until then a run only backtests.

`pdd-live-report` (every day 09:30) appends the 拼多多 live store's figures to the 「直播数据每日」 sheet named in `pdd-live-report/config.json` in the assistant's workspace, from the `pdd-live-figures` skill of `@deepseek-ai/dsh-tmall-skills`. Its `scripts/live_row.py` lists the days after the sheet's last date up to yesterday (a week at most), builds the next row — a slash date in A, the 客单价 formula `=B/C` in D, the conversion as `0.00%` in E — skips a day the sheet already has, refuses one before its last date, after a last row that is not a date (such as 合计), or past the sheet's last grid row, and checks the row read back and that no other row changed. The task declares only `lark-cli sheets +cells-set`, run with `--as user`.

The skills read everything that changes — the month's table tokens and columns, push targets, warning lines, and people — from 名流's Feishu configuration documents 《AI巡检固化配置》 and 《投流ROI巡检配置》, never from their own files; they send as the assistant's own Feishu identity through the Feishu connector's `lark-cli` (`--as bot`). Provider reminders go to group webhooks through the skill's `scripts/send_webhook.py`, which signs them; the script reads each webhook's address and signing secret itself from `roi-inspection/webhook_mapping.json` in the assistant's workspace, so the secret stays off the command line. It exits 0 when Feishu accepts the message, 1 when it was not delivered, and 2 when the outcome is unknown and the message may have arrived; the skill does not resend on 2. No skill file holds a webhook or secret.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Skill Hub install; DSH does not load this package. An installed skill's catalog description is the `description` in its `SKILL.md`, in Chinese for 名流's employees, and its body and reference files are what the model reads when it uses the skill. The skills tell the model to read Feishu documents, sheets, and bases through `lark-cli` and to send interactive cards as the bot.

#### KV Cache effect

No direct effect; installing or removing a skill changes the skill catalog the way any installed skill does.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The configuration document holds the facts** — table tokens, push targets, and open_ids live in 《AI巡检固化配置》; the assistant's Feishu identity needs read access to it and to the tables, and an open_id is only valid for the Feishu app it was read with.
- **Test group only for now** — the inspection task sends to the test group; JACK and the two production groups are added when 名流 accepts it with real accounts.
- **Webhook secrets are placed by hand** — 名流's admin puts `roi-inspection/webhook_mapping.json` into each running assistant's workspace; the eight provider webhooks are untested until 名流 agrees to a connection test.
- **Workspace configuration is placed by hand** — the handover has no configuration document for the meeting sync or the video report, so 名流's admin writes `pdd-meeting-todos/config.json` with the tables and the owners' open_ids read under MO's Feishu app, `video-performance-report/config.json` with the person the video report mentions, and `pdd-live-report/config.json` with the live sheet and store, and copies the handover's deletions into `exclusions.json`; while 名流 tests it, the to-do table is a test table.
- **The video report stops at the end of the holiday calendar** — when the bundled chinese_calendar has no data for the year, `holiday.py` exits 2 and the report is not sent until a Desktop release carries the new year's holidays.
- **Inline message JSON on Windows PowerShell 5.1** — `lark-cli im +messages-send` takes its content only inline, and Windows PowerShell 5.1 may drop the inner double quotes when passing it; PowerShell 7, which Desktop prefers, passes them intact. Sending from Windows is checked in 名流's acceptance.
- **The daily report's sheet access is unchecked** — `tianmao-daily-report` reads and writes the sheet as the user signed in to MO's Feishu connector (`--as user`, as the handover did); whether that user can edit the month's sheet, and whether every platform has yesterday's figures by 06:00, is checked in 名流's acceptance. 淘客 rows are not filled: the store's sub-account cannot open 淘宝联盟 until the main account authorizes it.
- **Consecutive-shortfall reminders stay paused** — the procedure is kept in the skill's references but runs only when 名流 asks for it again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The skills come from 名流's handover package (AI工作伙伴项目运行包 v2, 2026-10-12): Aily's tools, workspace paths, and comment delivery are replaced by MO's, and the archived direct-push scripts, per-month mapping snapshots, and the handover's webhook file are left out. `tests/pack.spec.ts` keeps Aily names and chat or user ids out of the skill files.

The package is repository-only ([`scripts/repository-only-package-policy.ts`](../../../scripts/repository-only-package-policy.ts)): 名流 receives the zips, not this package.

</details>
