---
description: "Skill Hub market for Desktop: the per-tenant market skill source, browsing the Hub as the signed-in employee, and validated one-click install."
kind: "package-reference"
---
# Skill Market

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-skill-market` adds Skills installed from the Skill Hub to `ctx.skills` as the `market` source and exposes the generated `ctx.remote.skillMarket` namespace for the Desktop Skills page. Market Skills live under `<dshHome>/skills-market/<tenantId>/<name>/`; only the signed-in tenant's directory is discovered, and each Skill directory keeps an install record. Browsing and downloads go through the Hub sign-in of [`@deepseek-ai/dsh-hub-account`](../../credentials/hub-account/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry beside `hub-account`; it injects `skills` and `hubAccount`. The web-app bundle enables it exactly when `hub-account` is enabled.

The provider registers through `ctx.skills.registerProvider()` and discovers the signed-in tenant's directory through the filesystem provider with source `market` and rank 550: after the user roots, before bundled Skills, so a project Skill of the same name still wins in its project. A tenant switch swaps the directory; while signed out nothing is discovered.

`list(query)` proxies `/api/client/skills` (search text, category, page, page size), `categories()` proxies the tenant's categories, and `detail(id)` returns the current version's SKILL.md and file list. Every card carries `displayName` (the Hub's display name, such as 天猫发品; the slug `name` when the Hub sends none), `installedVersion` (the installed version of that Hub Skill for this tenant, or null), `updateAvailable` (installed and the Hub's version is newer, compared numerically), and `conflict` (a Skill the user placed in `~/.dsh/skills` or `~/.agents/skills` has the same name). `installSkill(id)` refuses a conflict with `skill-market/name-conflict`, downloads the current version, and validates it before anything lands: every entry must sit under `<name>/` without `.`/`..` segments, `SKILL.md` must exist, and the files must match the published sha256 list exactly. The files are written to a staging directory beside the target and moved into place with one rename (an existing install is replaced the same way), and `.hub-install.json` records the Hub Skill id, display name, version, install time, and each file's sha256. A failure removes the staging directory, so no partial Skill is left. Installing over an existing copy is the update: before replacing it, `installSkill(id, options)` compares the copy with its install record and refuses with `skill-market/local-changes` (naming every edited, added, or removed file) unless `options.overwriteLocalChanges` is set; a same-named directory without a record counts as local files. `installedStatus()` asks the Hub about each installed market Skill of the tenant and reports its display name (the Hub's current one, else the recorded one, else the slug) and state: `update` when a newer version is published, `current`, `unavailable` when the Hub no longer shows it to the employee (withdrawn, deleted, or out of view; the local copy stays installed and usable and is never removed), or `unknown` when the Hub cannot be asked. Hub errors surface as `skill-market/unavailable`, an unknown Skill as `skill-market/not-found`, and a rejected package as `skill-market/invalid-package`.

Uploading publishes a local folder to the Hub. `uploadSources()` lists the Skills the user placed in `~/.dsh/skills` or `~/.agents/skills` with their folders. `inspectFolder(dir)` reads a folder without changing it: SKILL.md's `name` and `description`, the files that would be uploaded (regular files only; `.DS_Store`, `.git`, `node_modules`, `__pycache__`, and `.hub-install.json` are left out) with their count and total size, the problems that keep it from being uploaded (`unreadable`, `no-skill-md`, `no-frontmatter`, `invalid-yaml`, `invalid-name`, `no-description`), and the employee's own Hub Skill of the same name with the next patch version as the suggested version (`1.0.0` for a new Skill). `uploadOptions()` returns the categories and the department and employee choices the Hub's web upload form offers; an account that cannot upload at all (a super administrator acting for a tenant) gets `skill-market/upload-rejected` with the Hub's reason. `uploadSkill(request)` inspects the folder again, refuses problems with `skill-market/invalid-folder` and a new Skill whose display name is missing, over 40 characters, or contains a line break or invisible character with `skill-market/invalid-display-name` (the Skill Hub's rule), zips the files under `<name>/`, and posts a new Skill (with its display name, visibility, departments or employees, and category) or a new version of the employee's own Skill. The answer says whether the version is waiting for review, with the Hub's review link, or already published (an administrator's upload). The Hub's reason for a refused upload (version format, duplicate name, version not higher, a version already in review, package too large) surfaces verbatim as `skill-market/upload-rejected`; an unreachable Hub surfaces as `skill-market/unavailable`. The local folder is never changed and stays a custom Skill.

`setDisabled(name, disabled)` switches a market Skill off for the signed-in tenant only, persisting `<tenantId>/<name>` in `disabledSkills`; a switched-off market Skill stays listed, but the provider closes its invocation for both the model and the user. The installed-skill Remote of [`@deepseek-ai/dsh-skill-controller`](../skill-controller/README.md) lists market Skills in their own group and routes their switch here.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Home whose `skills-market` directory holds market Skills. |
| `disabledSkills` | `[]` | Market Skills switched off, as `<tenantId>/<name>`; volatile, edited through `setDisabled()`. |
| `watch` | `true` | Watch the tenant directory for changes made outside DSH. |
| `maxPackageBytes` | 64 MiB | Largest package accepted for install. |

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the skill registry: an installed market Skill joins the model's skill catalog like any other Skill, and a switched-off one leaves it.

#### KV Cache effect

No direct effect; the skill catalog consumer appends a replacement catalog message when the visible set changes, as for any other catalog change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Uploads read a folder** — `uploadSkill` packs a folder on this machine; a ready-made `.zip` cannot be uploaded directly.
- **Updates are pulled, not pushed** — `installedStatus()` asks the Hub when the page opens; nothing checks in the background, and an update is installed only when the user asks.
- **Local-edit detection compares regular files** — a symbolic link the user adds inside a market Skill is not reported as a local edit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The tenant directory and its install records are the only state; the catalog is re-derived from them on every invalidation.
