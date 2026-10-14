---
description: "名流's operations skills that only 名流's Skill Hub hands out — the department AI inspection of 天猫一店 and 拼多多 and its monthly configuration update, and the ROI inspection of off-site advertising — the recommended tasks of 名流's operations assistant, and the step that builds the skills' upload packages."
kind: "package-reference"
---
# 名流 operations skills

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-mingliu-skills` holds the Skills 名流 (上海名流卫生用品) moved over from its Aily AI work partner, not shipped with DSH: 名流's admin uploads them to 名流's [Skill Hub](../../../docs/glossary.md#skill-hub) only. `ai-inspection` checks 天猫一店 and 拼多多 department daily reports against their targets and writes the six-section inspection; `inspection-config-update` puts a new month's target tables into the inspection's configuration document; `roi-inspection` sums advertising providers' and accounts' effective ROI since its last report into an internal report and reminders to providers below the warning line. The package also keeps the recommended tasks of 名流's operations assistant, which an [assistant package](../../assistant/assistant-packages/README.md) carries.

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

`readTasks()` reads the recommended tasks, one JSON file each under `agent/tasks/`, in file-name order, as the assistant package's `agent.json` lists them: an id, a title, the instruction, the timing and its zone, the connectors whose plain writes run unasked (none for `ai-inspection`, whose only write is sending its card), the permission preset, and the [operations](../../schedule/automation-tasks/README.md) its unattended runs may run. `ai-inspection` runs on weekdays at 11:00 Asia/Shanghai with the instruction of the Aily task it replaces, reading the month's table mapping from the configuration document; while 名流 tests it, it sends its card to the inspection test group only. `roi-internal-report` (weekdays 09:30) and `roi-provider-reminder` (Monday, Wednesday, Friday 10:00) only preview and declare no operations: the report or reminders go out when the person replies 「发送内部日报」 or 「发送外部提醒」 in that session, and the run's checkpoint in the assistant's workspace, `roi-inspection/checkpoint.json`, moves on only after sending, so a later run does not count the same days again. While 名流 tests them, the report goes to the test group and every reminder to the test group's webhook.

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
- **Consecutive-shortfall reminders stay paused** — the procedure is kept in the skill's references but runs only when 名流 asks for it again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The skills come from 名流's handover package (AI工作伙伴项目运行包 v2, 2026-10-12): Aily's tools, workspace paths, and comment delivery are replaced by MO's, and the archived direct-push scripts, per-month mapping snapshots, and the handover's webhook file are left out. `tests/pack.spec.ts` keeps Aily names and chat or user ids out of the skill files.

The package is repository-only ([`scripts/repository-only-package-policy.ts`](../../../scripts/repository-only-package-policy.ts)): 名流 receives the zips, not this package.

</details>
