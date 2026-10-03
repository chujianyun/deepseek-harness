/**
 * Host Remote owner of the `installedSkills` namespace: the user-level skills
 * installed on this machine, with their enabled state and the file actions the
 * "我安装的" page offers (reveal, edit, uninstall).
 *
 * @module @deepseek-ai/dsh-skill-controller
 */

import { rename, mkdir, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
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

/** Discovery sources whose skills the user placed on this machine themselves. */
const CUSTOM_SOURCES: ReadonlySet<string> = new Set(['user-dsh', 'user-agents', 'custom'])

/**
 * Working directory used for user-level lookups. It has no `.git` ancestor and no `.dsh` or `.agents`
 * child, so project-level roots resolve to nothing and every user-level skill keeps its user source.
 */
const NEUTRAL_CWD = join(tmpdir(), 'dsh-skill-controller')

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

/** The file or directory that holds one skill: `<name>/` for a `SKILL.md` package, the file itself for a flat `<name>.md`. */
function skillRoot(path: string): string {
  return basename(path) === 'SKILL.md' ? dirname(path) : path
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
    return { skills: (await this.custom()).map(view) }
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
      await this.ctx.skills.setDisabled(skill.name, !enabled)
    } catch (error: unknown) {
      throw new RemoteError('installed-skills/rejected', `skill "${name}" could not be ${enabled ? 'enabled' : 'disabled'}: ${messageOf(error)}`, { name }, { cause: error })
    }
    return { ...view(skill), enabled }
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
    const result = await this.act(name, () => this.moveToTrash(skillRoot(skill.path), signal))
    if (skill.disabled === true) await this.ctx.skills.setDisabled(skill.name, false)
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
      await rename(path, await freeName(trash, basename(path)))
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
      return skills.filter((skill): skill is InstalledSkill => CUSTOM_SOURCES.has(skill.source) && skill.path !== undefined)
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${messageOf(error)}`, {}, { cause: error })
    }
  }

  private defaultScope(): Promise<({ key: ScopeKey } & AsyncDisposable) | undefined> {
    const presets = this.ctx.get('agentPresets')
    return presets === undefined ? Promise.resolve(undefined) : presets.acquireScope()
  }
}

function view(skill: InstalledSkill): InstalledSkillView {
  return {
    name: skill.name,
    description: skill.description,
    group: 'custom',
    source: skill.source,
    path: skill.path,
    enabled: skill.disabled !== true,
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
