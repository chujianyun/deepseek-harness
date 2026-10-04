/**
 * Browser-safe wire shapes of the `installedSkills` Remote namespace.
 *
 * @module @deepseek-ai/dsh-skill-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The named skill is not an installed user-level skill this namespace may act on. */
    'installed-skills/not-found': { readonly name: string }
    /** The Host refused or failed the requested file operation on an installed skill. */
    'installed-skills/rejected': { readonly name: string }
  }
}

/** Where an installed skill came from, as the "我安装的" page groups it: placed by the user, or installed from the Skill Hub market. */
export type InstalledSkillGroup = 'custom' | 'market'

/** One user-level skill installed on this machine. */
export interface InstalledSkillView {
  /** Kebab-case skill name. */
  readonly name: string
  /** Routing description from the skill's frontmatter. */
  readonly description: string
  /** Page group this skill belongs to. */
  readonly group: InstalledSkillGroup
  /** Discovery source that produced the winning skill (`user-dsh`, `user-agents`, or `market`). */
  readonly source: string
  /** Absolute path of the skill's instruction file. */
  readonly path: string
  /** False when the user switched the skill off. */
  readonly enabled: boolean
}

/** Every installed user-level skill, sorted by name. */
export interface InstalledSkillListValue {
  readonly skills: readonly InstalledSkillView[]
}

/** Confirmation that a file operation on an installed skill was accepted. */
export interface InstalledSkillActionValue {
  readonly done: true
}
