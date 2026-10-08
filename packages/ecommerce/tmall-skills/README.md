---
description: "Tmall data skills that Skill Hub hands to the tenants that need them: the Alimama marketing-scene report and the Business Advisor core daily report, read with a Tmall merchant account, and the step that builds their upload packages."
kind: "package-reference"
---
# Tmall data skills

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tmall-skills` holds two read-only Skills that DSH does not ship: a tenant's admin uploads them to the [Skill Hub](../../../docs/glossary.md#skill-hub), and employees of that tenant install them. `tmall-alimama-scene-report` reads one day's figures per marketing scene from Alimama (万相台); `tmall-sycm-core-daily` exports Business Advisor's (生意参谋) 「店铺经营核心日报」 and checks its advertising spend against Alimama. Both take over a Tmall [merchant account](../../../docs/glossary.md#merchant-account) through `dsh-ecommerce browser` and run as one ES module under DSH's own Node, so an employee installs neither Python nor packages. Why skills call the platforms' page APIs is recorded in the [e-commerce accounts Agent Note](../../../.agents/notes/proposed/feature/2026-10-07-ecommerce-accounts-over-store-session.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`packSkills(outDir)` builds every skill in `SKILLS` into `<outDir>/<name>/` — its `SKILL.md` from `skills/<name>/` and one self-contained ES module per script under `scripts/`, bundled with tsdown from `src/` — and zips each folder as `<outDir>/<name>.zip` around `<name>/`, the layout Skill Hub accepts; earlier builds are replaced. From the repository root:

```sh
node --input-type=module -e "import { packSkills } from './packages/ecommerce/tmall-skills/src/index.ts'; console.log(await packSkills('dist/tmall-skills'))"
```

Each script takes `--account <id>` (an id from `dsh-ecommerce accounts`), `--date YYYY-MM-DD` (a day that has ended in Beijing time, yesterday by default), and `--out <dir>` (`天猫报表` under the working directory by default). It runs `dsh-ecommerce browser <id>`, which DSH answers only inside a bash call while a tenant is signed in; refuses an account that is not a Tmall merchant account; opens a background tab in the account's Chrome and closes it afterwards; and prints a Markdown summary with the paths of the files it wrote. It exits `0` on success, `2` when the platform has not finished the day (nothing written), `3` when the account is signed out of the platform, `64` for a wrong command line, and `1` otherwise, with the reason on stderr.

- `scripts/alimama-scene-report.mjs` opens Alimama's account report page for the day, captures the scene query the page sends (its `csrfId` and `loginPointId` are made at run time), and posts it again with the fields it reads. A page sent to the sign-in screen that offers 「进入后台」 is entered once. For yesterday (Beijing time), no scene or zero de-duplicated buyers in every scene (`alipayInshopUv`, computed after about 10:00 the next morning) stops it as not ready; earlier days are reported as they are. Otherwise it writes `万相台营销场景报表_<store>_<date>.csv`, one row per scene with spend, impressions, clicks, transactions, carts, and natural traffic, rates recomputed from the unrounded figures, and a `.md` summary with totals; when every scene reads zero natural impressions, which Alimama computes later than the other figures, the summary warns that the two natural-traffic columns are not computed yet.
- `scripts/sycm-core-daily.mjs` calls the self-service data APIs: the template list for 「店铺经营核心日报」, the export request, and the download address, which it polls for up to two minutes, then downloads the .xlsx (the last 30 days) from that signed address. A file without the day, or a Business Advisor update day (`commDateByLocation`) before it, is not ready, and the message names the days the file covers and the update day; a day older than the file's first day is a usage error. A failure while asking Alimama leaves the report unverified rather than failing it. It then compares the 关键词推广, 精准人群推广, and 全站推广 spend with Alimama's scenes 371, 372, and 436 in the same tab, allowing one cent. It writes `生意参谋店铺经营核心日报_<store>_<date>.csv` (every column of the day), the export as `.xlsx`, and a `.md` summary whose check line under the title is ✅ matching, ❌ with each difference, or ⚠️ with why Alimama could not be asked. A spend cell that is not a number counts as no spend.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Skill Hub install and the bash tool; DSH does not load this package. An installed skill's catalog description is the `description` in its `SKILL.md`, in Chinese for the tenant's employees. Its body tells the model to pick the account by the `ecommerce-accounts` rules, to get the Node path from `load_workspace_dependencies`, to run the script in one bash call relative to the skill's base directory, and what each exit status means: relay the summary and file paths, say the data is not ready rather than make up figures, send the user to Settings when signed out without switching stores, and pass on a spend mismatch with both figures. A script prints its summary to stdout (a table of a few rows) and one reason line to stderr when it stops.

#### KV Cache effect

No direct effect; installing or removing a skill changes the skill catalog the way any installed skill does.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Tmall merchant accounts only** — Taobao, Pinduoduo, and Douyin shop data, and buyer-account skills, are not here.
- **Page APIs follow the platforms** — the report query, its session fields, the self-service template name, and the export APIs belong to Alimama and Business Advisor; when they change, a script stops with the reason until it is updated.
- **Readiness by one signal each** — yesterday's Alimama figures are ready when any scene has buyers, so a yesterday with advertising but no sale reads not ready until the next day.
- **Attribution keeps moving** — Alimama counts transactions for days after the click, so a later run for the same day can show larger transaction figures.
- **Last 30 days of Business Advisor** — the template exports only the last 30 days.
- **The cross-check covers spend only** — visitors, payments, and buyers have no second source here.
- **Exports leave records** — each Business Advisor run adds an export to the store's self-service download list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The scripts reuse `Cdp` from `@deepseek-ai/dsh-ecommerce-accounts`, so `ws` is bundled into each script; the bundle must stay free of imports other than Node built-ins, which `tests/pack.spec.ts` checks.

</details>
