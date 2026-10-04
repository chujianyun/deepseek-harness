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
  readonly name: string
  readonly description: string
  readonly category: MarketCategory | null
  /** Current version on the Skill Hub. */
  readonly version: string
  /** When the current version was uploaded. */
  readonly updatedAt: string
  /** Version installed on this machine for the signed-in tenant, or null. */
  readonly installedVersion: string | null
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

/** The install record written as `.hub-install.json` inside each market Skill directory. */
export interface MarketInstallRecord {
  readonly hubSkillId: string
  readonly name: string
  readonly version: string
  /** ISO timestamp of the install. */
  readonly installedAt: string
  /** sha256 of every installed file, for detecting local edits. */
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
}
