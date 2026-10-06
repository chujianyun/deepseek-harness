/**
 * Host Remote owner of the `installedSkills` namespace: the user-level skills
 * installed on this machine, with their enabled state and the file actions the
 * "我安装的" page offers (reveal, edit, uninstall).
 *
 * @module @deepseek-ai/dsh-skill-controller
 */

import { cp, lstat, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, parse } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-skill-market'
import { openNativeTextFile, revealNativePath, runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { type SkillSummary } from '@deepseek-ai/dsh-skill'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InstalledSkillActionValue, InstalledSkillListValue, InstalledSkillView } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `installedSkills` Remote namespace. */
    skillController: SkillController
  }
}

/** A discovered skill backed by a file on this machine. */
type InstalledSkill = SkillSummary & { readonly path: string }

/**
 * Discovery sources whose skills the user placed on this machine themselves. `custom` is excluded:
 * `customSkillDirs` is deployment configuration (the shipped presets point it at packaged skills).
 */
const CUSTOM_SOURCES: ReadonlySet<string> = new Set(['user-dsh', 'user-agents'])
/** Source of the Skills installed from the Skill Hub market (`@deepseek-ai/dsh-skill-market`). */
const MARKET_SOURCE = 'market'

/**
 * Working directory used for user-level lookups: a never-created child of the filesystem root, so
 * no `.git` ancestor (a home directory under version control included) turns user roots into project
 * roots, and every user-level skill keeps its user source.
 */
const NEUTRAL_CWD = join(parse(homedir()).root, '.dsh-skill-controller-neutral')

/** Host integrations replaceable by direct unit tests. */
export interface SkillControllerInternals {
  /** Host platform; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** Home directory holding the platform trash; defaults to `os.homedir()`. */
  readonly home?: string
  /** Native command runner used by the Windows recycle-bin move. */
  readonly run?: NativeCommandRunner
  /** Reveal a path in the native file manager. */
  readonly reveal?: (path: string, signal: AbortSignal) => Promise<void>
  /** Open a text file in the native editor. */
  readonly openTextFile?: (path: string, signal: AbortSignal) => Promise<void>
}

/**
 * The installed entry that holds one skill, as discovery found it under its root — `<root>/<name>/`
 * for a `SKILL.md` package, `<root>/<name>.md` for a flat file. Discovery reports `path` with symlinks
 * resolved, so the entry comes from the unresolved `resourceBase` instead: removing it removes an
 * installed symlink itself, never the folder it points to.
 * @param skill - installed skill.
 * @returns the path to move to the trash.
 */
function installedEntry(skill: InstalledSkill): string {
  const base = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined
  if (base === undefined) throw new Error(`skill "${skill.name}" has no installed location`)
  return basename(skill.path) === 'SKILL.md' ? base : join(base, `${skill.name}.md`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Host service backing the generated `ctx.remote.installedSkills` namespace.
 * Every action resolves the name against the current user-level catalog first,
 * so project-level and bundled skills can never be toggled, revealed, or removed here.
 */
export class SkillController extends TypertRemoteService {
  static inject = ['skills']

  private readonly internals: Required<SkillControllerInternals>

  /**
   * @param ctx - Host context carrying the skill registry and, optionally, agent presets.
   * @param internals - platform and native-integration overrides for tests.
   */
  constructor(ctx: Context, internals: SkillControllerInternals = {}) {
    super(ctx, 'skillController', { namespace: 'installedSkills' })
    this.internals = {
      platform: internals.platform ?? process.platform,
      home: internals.home ?? homedir(),
      run: internals.run ?? runNativeCommand,
      reveal: internals.reveal ?? revealNativePath,
      openTextFile: internals.openTextFile ?? openNativeTextFile,
    }
  }

  /**
   * List the user-level skills installed on this machine, including disabled ones.
   * @returns every custom skill sorted by name, with its enabled state.
   * @throws RemoteError when skill discovery fails.
   */
  @Remote
  async list(): Promise<InstalledSkillListValue> {
    return { skills: (await this.custom()).map(skill => this.view(skill)) }
  }

  /**
   * Switch one installed skill on or off for this user.
   * @param name - installed skill name.
   * @param enabled - whether the skill should be invocable.
   * @returns the skill's view after the change.
   * @throws RemoteError when the skill is not installed or the setting cannot be persisted.
   */
  @Remote
  async setEnabled(name: string, enabled: boolean): Promise<InstalledSkillView> {
    const skill = await this.find(name)
    try {
      await this.setDisabled(skill, !enabled)
    } catch (error: unknown) {
      throw new RemoteError('installed-skills/rejected', `skill "${name}" could not be ${enabled ? 'enabled' : 'disabled'}: ${messageOf(error)}`, { name }, { cause: error })
    }
    return { ...this.view(skill), enabled }
  }

  /**
   * Reveal an installed skill's instruction file in the native file manager.
   * @param name - installed skill name.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the file manager accepted the request.
   * @throws RemoteError when the skill is not installed or the file manager fails.
   */
  @Remote
  async reveal(name: string, signal: AbortSignal): Promise<InstalledSkillActionValue> {
    const skill = await this.find(name)
    return this.act(name, () => this.internals.reveal(skill.path, signal))
  }

  /**
   * Open an installed skill's instruction file in the native text editor.
   * @param name - installed skill name.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the editor accepted the file.
   * @throws RemoteError when the skill is not installed or the editor fails.
   */
  @Remote
  async edit(name: string, signal: AbortSignal): Promise<InstalledSkillActionValue> {
    const skill = await this.find(name)
    return this.act(name, () => this.internals.openTextFile(skill.path, signal))
  }

  /**
   * Move an installed skill's folder (or flat file) to the platform trash and forget its disabled state.
   * @param name - installed skill name.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the move.
   * @throws RemoteError when the skill is not installed, the platform has no trash, or the move fails.
   */
  @Remote
  async uninstall(name: string, signal: AbortSignal): Promise<InstalledSkillActionValue> {
    const skill = await this.find(name)
    const result = await this.act(name, () => this.moveToTrash(installedEntry(skill), signal))
    // The skill is already gone; a failure to forget its disabled state must not report the removal as failed.
    if (!this.view(skill).enabled) {
      await this.setDisabled(skill, false).catch((error: unknown) => {
        this.ctx.logger.warn(`uninstalled skill "${name}" stays in disabledSkills: ${messageOf(error)}`)
      })
    }
    return result
  }

  private async act(name: string, action: () => Promise<void>): Promise<InstalledSkillActionValue> {
    try {
      await action()
      return { done: true }
    } catch (error: unknown) {
      throw new RemoteError('installed-skills/rejected', `action on skill "${name}" failed: ${messageOf(error)}`, { name }, { cause: error })
    }
  }

  private async moveToTrash(path: string, signal: AbortSignal): Promise<void> {
    const platform = this.internals.platform
    if (platform === 'darwin') {
      const trash = join(this.internals.home, '.Trash')
      await mkdir(trash, { recursive: true })
      await moveAcrossVolumes(path, await freeName(trash, basename(path)))
      return
    }
    if (platform === 'win32') {
      // PowerShell single-quoted literal: only `'` needs escaping (doubled).
      const literal = `'${path.replaceAll("'", "''")}'`
      const script = `Add-Type -AssemblyName Microsoft.VisualBasic; if (Test-Path -LiteralPath ${literal} -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${literal}, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${literal}, 'OnlyErrorDialogs', 'SendToRecycleBin') }`
      await this.internals.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], signal, 'hidden')
      return
    }
    throw new Error(`moving to the trash is not supported on ${platform}`)
  }

  private async find(name: string): Promise<InstalledSkill> {
    const skill = (await this.custom()).find(item => item.name === name)
    if (skill === undefined) throw new RemoteError('installed-skills/not-found', `skill "${name}" is not an installed user-level skill`, { name })
    return skill
  }

  /** User-level skills as the default agent preset discovers them, or the global layer when presets are absent. */
  private async custom(): Promise<InstalledSkill[]> {
    await using lease = await this.defaultScope()
    try {
      const skills = await this.ctx.skills.list({ cwd: NEUTRAL_CWD, ...lease === undefined ? {} : { scope: lease.key } })
      return skills.filter((skill): skill is InstalledSkill =>
        (CUSTOM_SOURCES.has(skill.source) || skill.source === MARKET_SOURCE) && skill.path !== undefined)
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${messageOf(error)}`, {}, { cause: error })
    }
  }

  /** Market Skills are switched per tenant by the market; user Skills through the registry. */
  private setDisabled(skill: InstalledSkill, disabled: boolean): Promise<void> {
    if (skill.source !== MARKET_SOURCE) return this.ctx.skills.setDisabled(skill.name, disabled)
    const market = this.ctx.get('skillMarket')
    return market === undefined ? Promise.reject(new Error('the Skill market is not mounted')) : market.setDisabled(skill.name, disabled)
  }

  private view(skill: InstalledSkill): InstalledSkillView {
    const market = skill.source === MARKET_SOURCE
    return {
      name: skill.name,
      description: skill.description,
      group: market ? 'market' : 'custom',
      source: skill.source,
      path: skill.path,
      enabled: market ? this.ctx.get('skillMarket')?.isDisabled(skill.name) !== true : skill.disabled !== true,
    }
  }

  private defaultScope(): Promise<({ key: ScopeKey } & AsyncDisposable) | undefined> {
    const presets = this.ctx.get('agentPresets')
    return presets === undefined ? Promise.resolve(undefined) : presets.acquireScope()
  }
}

/**
 * Rename `from` to `to`, copying then deleting when they are on different volumes (EXDEV). A symlink
 * moves as the link itself.
 * @param from - existing entry.
 * @param to - free destination path.
 */
async function moveAcrossVolumes(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) throw error
    const entry = await lstat(from)
    await cp(from, to, { recursive: entry.isDirectory(), verbatimSymlinks: true })
    await rm(from, { recursive: true, force: true })
  }
}

/** First `<base>`, `<base> 2`, `<base> 3`, … that does not exist yet in `dir`, as Finder names trash collisions. */
async function freeName(dir: string, base: string): Promise<string> {
  for (let index = 1; ; index += 1) {
    const candidate = join(dir, index === 1 ? base : `${base} ${index}`)
    try {
      await stat(candidate)
    } catch (missing: unknown) {
      // stat failing (ENOENT) means the name is free; the error itself carries nothing to report.
      void missing
      return candidate
    }
  }
}

export default SkillController
