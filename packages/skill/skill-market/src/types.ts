/**
 * Browser-safe wire shapes of the `skillMarket` Remote namespace: the Skill Hub market as the
 * Desktop Skills page renders it, and the install record kept beside each market Skill.
 *
 * @module @deepseek-ai/dsh-skill-market/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The Skill Hub could not be reached or answered with an error. */
    'skill-market/unavailable': { readonly status: number | null }
    /** The Skill is not visible to the signed-in employee. */
    'skill-market/not-found': { readonly id: string }
    /** A Skill the user placed on this machine already uses this name. */
    'skill-market/name-conflict': { readonly name: string }
    /** The downloaded package failed validation; nothing was installed. */
    'skill-market/invalid-package': { readonly reason: string }
    /** Installing would overwrite local edits to an installed market Skill; retry with `overwriteLocalChanges`. */
    'skill-market/local-changes': { readonly name: string; readonly files: readonly string[] }
    /** The Skill Hub refused an upload; the message is the Hub's own reason. */
    'skill-market/upload-rejected': { readonly status: number }
    /** The local folder cannot be uploaded (no SKILL.md, invalid frontmatter, unreadable). */
    'skill-market/invalid-folder': { readonly problems: readonly MarketFolderProblem[] }
    /** A new Skill's display name breaks the Skill Hub's rule (see `displayNameProblem`). */
    'skill-market/invalid-display-name': { readonly name: string; readonly problem: DisplayNameProblem }
  }
}

/** A Skill category of the signed-in tenant. */
export interface MarketCategory {
  readonly id: string
  readonly name: string
}

/** Market list query, as the user center's client API takes it. */
export interface MarketSkillQuery {
  /** Search text matched against name and description. */
  readonly q?: string
  /** Only Skills of this category. */
  readonly categoryId?: string
  /** One-based page number. */
  readonly page?: number
  /** Page size, at most 100. */
  readonly pageSize?: number
}

/** One market Skill card. */
export interface MarketSkillCard {
  /** Skill Hub Skill id. */
  readonly id: string
  /** Kebab-case Skill name (slug): the install directory and the name the model sees. */
  readonly name: string
  /** Name shown to people; the slug when the Skill Hub has none. */
  readonly displayName: string
  readonly description: string
  readonly category: MarketCategory | null
  /** Current version on the Skill Hub. */
  readonly version: string
  /** When the current version was uploaded. */
  readonly updatedAt: string
  /** Version installed on this machine for the signed-in tenant, or null. */
  readonly installedVersion: string | null
  /** True when installed and the Skill Hub's current version is newer. */
  readonly updateAvailable: boolean
  /** True when a Skill the user placed on this machine (`~/.dsh/skills`, `~/.agents/skills`) uses the same name. */
  readonly conflict: boolean
}

/** One page of the market list. */
export interface MarketSkillPage {
  readonly items: readonly MarketSkillCard[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

/** A file of the current version, relative to the Skill root. */
export interface MarketSkillFile {
  readonly path: string
  readonly size: number
}

/** The detail view of one market Skill. */
export interface MarketSkillDetail extends MarketSkillCard {
  /** Owner's current name. */
  readonly ownerName: string
  /** SKILL.md source of the current version; the page renders it as untrusted Markdown. */
  readonly skillMd: string
  /** Files of the current version, sorted by path. */
  readonly files: readonly MarketSkillFile[]
}

/** Options of one install or update. */
export interface MarketInstallOptions {
  /** Replace an installed copy even when its files were edited locally. */
  readonly overwriteLocalChanges?: boolean
}

/**
 * Where an installed market Skill stands on the Skill Hub: `current` (installed version is the
 * current one), `update` (a newer version is published), `unavailable` (withdrawn, deleted, or no
 * longer visible to the employee — the local copy keeps working), or `unknown` (the Hub could not
 * be asked).
 */
export type MarketInstalledState = 'current' | 'update' | 'unavailable' | 'unknown'

/** One installed market Skill of the signed-in tenant and its Skill Hub state. */
export interface MarketInstalledStatus {
  readonly name: string
  /** The Hub's current display name, else the one recorded at install, else the slug. */
  readonly displayName: string
  readonly hubSkillId: string
  readonly installedVersion: string
  /** Current version on the Skill Hub; null unless the Hub answered with the Skill. */
  readonly latestVersion: string | null
  readonly state: MarketInstalledState
}

/** A Skill the user placed on this machine, offered for upload to the Skill Hub. */
export interface MarketUploadSource {
  readonly name: string
  readonly description: string
  /** The Skill folder (the directory holding SKILL.md). */
  readonly dir: string
  /** Discovery source (`user-dsh` or `user-agents`). */
  readonly source: string
}

/**
 * Why a local folder cannot be uploaded: unreadable, no SKILL.md, no frontmatter, frontmatter that
 * is not YAML, a name that is not lowercase letters, digits, and hyphens, or no description.
 */
export type MarketFolderProblem = 'unreadable' | 'no-skill-md' | 'no-frontmatter' | 'invalid-yaml' | 'invalid-name' | 'no-description'

/** What an upload of one local folder would send, and where it would go. */
export interface MarketUploadPreview {
  readonly dir: string
  /** Name from SKILL.md frontmatter; null when it cannot be read. */
  readonly name: string | null
  readonly description: string | null
  /** Files that would be uploaded (junk such as `.DS_Store`, `.git/`, `node_modules/`, `__pycache__/` excluded). */
  readonly fileCount: number
  readonly sizeBytes: number
  /** Why the folder cannot be uploaded; empty when it can. */
  readonly problems: readonly MarketFolderProblem[]
  /** The employee's own Skill of the same name on the Hub: the upload becomes its new version. */
  readonly existing: {
    readonly skillId: string
    /** The existing Skill's display name (the slug when the Hub has none). */
    readonly displayName: string
    readonly highestVersion: string
    readonly currentVersion: string | null
    readonly workingStatus: 'draft' | 'pending' | null
  } | null
  /** `1.0.0` for a new Skill, otherwise the next patch after the highest existing version. */
  readonly suggestedVersion: string
}

/** Why a display name cannot be used: none given, over 40 characters, or a line break or invisible character. */
export type DisplayNameProblem = 'missing' | 'too-long' | 'invisible'

/** Who can see an uploaded Skill: the tenant, chosen departments or employees, or only the uploader. */
export type MarketVisibility = 'tenant' | 'departments' | 'employees' | 'private'

/** Visibility and category choices for an upload. */
export interface MarketUploadOptions {
  readonly categories: readonly MarketCategory[]
  readonly departments: readonly { readonly id: string; readonly parentId: string | null; readonly name: string }[]
  readonly employees: readonly { readonly id: string; readonly name: string; readonly departmentName: string }[]
}

/** One upload of a local Skill folder. Visibility and category apply to a new Skill only. */
export interface MarketUploadRequest {
  readonly dir: string
  readonly version: string
  /** Display name; required for a new Skill, ignored for a new version. Trimmed before sending. */
  readonly displayName?: string
  readonly visibility?: MarketVisibility
  readonly departmentIds?: readonly string[]
  readonly employeeIds?: readonly string[]
  readonly categoryId?: string
}

/** The Hub's answer to an upload. */
export interface MarketUploadResult {
  readonly skillId: string
  readonly name: string
  readonly displayName: string
  readonly version: string
  /** `create` for a new Skill, `version` for a new version of the employee's existing one. */
  readonly mode: 'create' | 'version'
  /** `pending` (submitted for review) for employees, `published` for tenant admins. */
  readonly status: 'pending' | 'published'
  /** Where an administrator reviews a pending upload. */
  readonly reviewUrl: string | null
}

/** The install record written as `.hub-install.json` inside each market Skill directory. */
export interface MarketInstallRecord {
  readonly hubSkillId: string
  readonly name: string
  /** Display name at install; absent in records written before T94. */
  readonly displayName?: string | undefined
  readonly version: string
  /** ISO timestamp of the install. */
  readonly installedAt: string
  /** sha256 of every installed file, for detecting local edits. */
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
}
