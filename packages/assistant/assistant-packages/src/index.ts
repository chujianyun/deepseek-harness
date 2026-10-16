/**
 * Company assistant packages for Desktop, behind one Host service and the `assistantPackages`
 * Remote namespace. A tenant administrator publishes a package on the user center: `agent.json`
 * (name, version, avatar, Agent preset, Skill and connector subsets, recommended scheduled tasks)
 * and the four core files. Installing one creates an assistant through the `assistants` service,
 * installs the Skills it names from the company's Skill Hub, and records the install under
 * `<dshHome>/assistant-packages/<tenantId>/installs.json`: the package version, the sha256 of each
 * core file and the profile fields as written, and the recommended tasks switched on.
 *
 * Recommended tasks are installed switched off. Switching one on creates an automation task
 * (its own Session bound to the assistant, with the task's timing, permission, and connector
 * grant); switching it off deletes that schedule and keeps the Session. Updating to a newer
 * version replaces each core file and profile field the user has not changed since the package
 * wrote it and keeps the rest; a switched-on task keeps running its earlier definition until the
 * user switches it off and on.
 *
 * @module @deepseek-ai/dsh-assistant-packages
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantSubsets, AssistantView, UpdateAssistantInput } from '@deepseek-ai/dsh-assistants'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-automation-tasks'
import type {} from '@deepseek-ai/dsh-hub-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ScheduleId, type ScheduleTimingChange } from '@deepseek-ai/dsh-schedule'
import { SessionId } from '@deepseek-ai/dsh-session'
import { compareVersions, type MarketSkillCard } from '@deepseek-ai/dsh-skill-market'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { CORE_FILES, listedSchema, manifestSchema, readPackage, sha256, type CoreFile, type ListedPackage, type PackageContent } from './manifest.ts'
import type {
  AssistantPackageInstallResult, AssistantPackageManifest, AssistantPackagesState, AssistantPackageTask,
  InstalledPackageView, InstalledTaskView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Company assistant packages: install, update, and the recommended tasks of installed ones. */
    assistantPackages: AssistantPackagesService
  }
}

/** Plugin configuration. */
export interface Config {
  /** DeepSeek Harness home; install records live under `<dshHome>/assistant-packages`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Largest package download accepted, in bytes. */
  maxPackageBytes?: number
  /** Avatar key of an assistant whose package names none. */
  defaultAvatar?: string
}

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  dshHome: Schema.string().description('DeepSeek Harness home; install records live under `<dshHome>/assistant-packages`. Defaults to `$DSH_HOME` or `~/.dsh`.'),
  maxPackageBytes: Schema.natural().min(1).default(2 * 1024 * 1024).description('Largest package download accepted, in bytes.'),
  defaultAvatar: Schema.string().default('sun').description('Avatar key of an assistant whose package names none.'),
})

const PROFILE_FIELDS = ['name', 'description', 'avatar', 'preset', 'subsets'] as const

/** An assistant field a package sets. */
type ProfileField = (typeof PROFILE_FIELDS)[number]

/** A switched-on recommended task: its automation task and the definition it was created from. */
interface EnabledTask {
  sessionId: string
  scheduleId: string
  /** Package version the task was switched on from. */
  version: string
  /** The task's definition as comparable JSON when it was switched on. */
  task: string
}

/** One assistant installed from a package. */
interface Install {
  packageId: string
  name: string
  version: string
  manifest: AssistantPackageManifest
  /** sha256 of each core file as the package last wrote it. */
  files: Record<string, string>
  /** JSON of each profile field as the package last wrote it. */
  profile: Record<string, string>
  /** Switched-on tasks by task id. */
  enabled: Record<string, EnabledTask>
  missingSkills: string[]
}

/** The install records of one tenant on this machine, keyed by assistant id. */
interface Records {
  version: 1
  installs: Record<string, Install>
}

const enabledSchema = z.object({ sessionId: z.string(), scheduleId: z.string(), version: z.string(), task: z.string() })
const installSchema = z.object({
  packageId: z.string(),
  name: z.string(),
  version: z.string(),
  manifest: manifestSchema,
  files: z.record(z.string(), z.string()),
  profile: z.record(z.string(), z.string()),
  enabled: z.record(z.string(), enabledSchema),
  missingSkills: z.array(z.string()),
})
const recordsSchema: z.ZodType<Records> = z.object({ version: z.literal(1), installs: z.record(z.string(), installSchema) })

const EMPTY_USER = { name: '', language: '', notes: '', background: '' }

/** The assistant fields a package sets, from its manifest. */
function profileOf(manifest: AssistantPackageManifest, defaultAvatar: string): Required<Pick<UpdateAssistantInput, 'name' | 'description' | 'avatar' | 'subsets'>> & { preset: string | null } {
  const subsets: AssistantSubsets = {
    ...(manifest.skills === undefined ? {} : { skills: manifest.skills }),
    ...(manifest.connectors === undefined ? {} : { connectors: manifest.connectors }),
  }
  return {
    name: manifest.displayName,
    description: manifest.description,
    avatar: { kind: 'preset', key: manifest.avatar ?? defaultAvatar },
    preset: manifest.preset ?? null,
    subsets,
  }
}

/** Each profile field of an assistant as comparable JSON; an absent preset or subset list reads as null or absent alike. */
function profileJson(view: Pick<AssistantView, ProfileField>): Record<ProfileField, string> {
  const subsets = view.subsets ?? {}
  return {
    name: JSON.stringify(view.name),
    description: JSON.stringify(view.description),
    avatar: JSON.stringify(view.avatar),
    preset: JSON.stringify(view.preset ?? null),
    subsets: JSON.stringify({
      skills: subsets.skills ?? null, connectors: subsets.connectors ?? null, knowledgeBases: subsets.knowledgeBases ?? null,
    }),
  }
}

/** A task's definition as comparable JSON. */
// Operations join only when declared, so a task enabled before they existed is not outdated by them alone.
const taskJson = (task: AssistantPackageTask): string => JSON.stringify([
  task.title, task.prompt, task.timing, task.timeZone, task.permission ?? null,
  ...(task.operations === undefined || task.operations.length === 0 ? [] : [task.operations]),
])

/**
 * A recommended task's timing as the schedule takes it, in the task's time zone.
 * @param task - the recommended task.
 * @returns the daily, weekly, or cron timing with seconds added to the time of day.
 */
export function scheduleTiming(task: AssistantPackageTask): ScheduleTimingChange {
  const zone = task.timeZone
  switch (task.timing.kind) {
    case 'daily': return { kind: 'daily', daily: { time: `${task.timing.time}:00`, time_zone: zone } }
    case 'weekly': return { kind: 'weekly', weekly: { time: `${task.timing.time}:00`, time_zone: zone, weekdays: [...task.timing.weekdays] } }
    case 'cron': return { kind: 'cron', cron: { expression: task.timing.expression, time_zone: zone } }
  }
}

/** Host owner of company assistant packages and of the `assistantPackages` Remote namespace. */
export class AssistantPackagesService extends TypertRemoteService {
  static inject = ['hubAccount', 'assistants']
  static Config = Config

  private readonly root: string
  private readonly maxPackageBytes: number
  private readonly defaultAvatar: string
  private writes: Promise<unknown> = Promise.resolve()

  /** @param ctx - Host with the Hub sign-in and the assistants. @param config - storage and download options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'assistantPackages', { namespace: 'assistantPackages' })
    const resolved = Config(config) as Config & Required<Omit<Config, 'dshHome'>>
    this.root = join(resolveDshHome(resolved.dshHome), 'assistant-packages')
    this.maxPackageBytes = resolved.maxPackageBytes
    this.defaultAvatar = resolved.defaultAvatar
  }

  /**
   * Read the packages the company offers and the assistants installed from packages here. A
   * switched-on task whose schedule was deleted elsewhere reads as switched off.
   * @param signal - caller lifetime.
   * @returns the offered packages (null while signed out or unreachable) and the installs.
   */
  @Remote
  getState(signal: AbortSignal): Promise<AssistantPackagesState> {
    return this.serialized(() => this.state(signal))
  }

  /**
   * Install a package: install the Skills it names from the company's Skill Hub, create its
   * assistant, and record the install with every recommended task switched off. Installing a
   * package already installed here updates that assistant instead.
   * @param packageId - user center package id.
   * @param signal - caller lifetime.
   * @returns what was installed and the state after it.
   * @throws RemoteError `hub-account/signed-out`, `assistant-packages/not-found`, `assistant-packages/invalid`,
   *   `assistant-packages/unavailable`, or an `assistants/*` refusal of the package's fields.
   */
  @Remote
  installPackage(packageId: string, signal: AbortSignal): Promise<AssistantPackageInstallResult> {
    return this.serialized(async () => {
      const tenantId = await this.requireTenant()
      const records = await this.read(tenantId)
      const existing = await this.installOf(records, (_id, install) => install.packageId === packageId)
      if (existing !== undefined) return this.updateLocked(tenantId, records, existing[0], existing[1], signal)
      const listed = await this.listed(packageId, signal)
      const content = await this.download(listed, signal)
      const skills = await this.ensureSkills(content.manifest, signal)
      const profile = profileOf(content.manifest, this.defaultAvatar)
      const { assistantId } = await this.ctx.assistants.createAssistant({
        templateId: null, name: profile.name, description: profile.description, avatar: profile.avatar,
        ...(profile.preset === null ? {} : { preset: profile.preset }), subsets: profile.subsets, user: EMPTY_USER,
      })
      try {
        await this.ctx.assistants.updateAssistant(assistantId, { files: content.files })
        const detail = await this.ctx.assistants.getAssistant(assistantId)
        records.installs[assistantId] = {
          packageId, name: listed.name, version: listed.version, manifest: content.manifest,
          files: Object.fromEntries(CORE_FILES.map(file => [file, sha256(detail.files[file])])),
          profile: profileJson(detail.assistant), enabled: {}, missingSkills: skills.missing,
        }
        await this.write(tenantId, records)
      } catch (error: unknown) {
        await this.ctx.assistants.deleteAssistant(assistantId).catch((cause: unknown) => {
          this.ctx.logger.warn(`assistant-packages: could not remove the assistant of a failed install: ${String(cause)}`)
        })
        throw error
      }
      const state = await this.state(signal)
      return {
        assistantId, version: listed.version, installedSkills: skills.installed, missingSkills: skills.missing, keptFiles: [], state,
      }
    })
  }

  /**
   * Update an installed assistant to its package's current version. Core files and profile fields
   * the user has not changed since the package wrote them take the new version's; changed ones are
   * kept. Skills the new version names are installed. Already current, nothing changes.
   * @param assistantId - the assistant installed from a package.
   * @param signal - caller lifetime.
   * @returns what was updated, the files kept, and the state after it.
   * @throws RemoteError `hub-account/signed-out`, `assistant-packages/not-installed`, `assistant-packages/not-found`,
   *   `assistant-packages/invalid`, or `assistant-packages/unavailable`.
   */
  @Remote
  updatePackage(assistantId: string, signal: AbortSignal): Promise<AssistantPackageInstallResult> {
    return this.serialized(async () => {
      const tenantId = await this.requireTenant()
      const records = await this.read(tenantId)
      const install = await this.requireInstall(records, assistantId)
      return this.updateLocked(tenantId, records, assistantId, install, signal)
    })
  }

  /**
   * Switch a recommended task on: create an automation task in the workspace, bound to the
   * assistant, with the task's timing, instruction, permission preset, and connector grant.
   * Already on, nothing changes.
   * @param assistantId - the assistant installed from a package.
   * @param taskId - the package's task id.
   * @param workspaceId - workspace the task's Session is filed under.
   * @param signal - caller lifetime.
   * @returns the state after it.
   * @throws RemoteError `hub-account/signed-out`, `assistant-packages/not-installed`, `assistant-packages/task-not-found`,
   *   or an `automation-tasks/*` refusal.
   */
  @Remote
  enableTask(assistantId: string, taskId: string, workspaceId: WorkspaceId, signal: AbortSignal): Promise<AssistantPackagesState> {
    return this.serialized(async () => {
      const tenantId = await this.requireTenant()
      const records = await this.read(tenantId)
      const install = await this.requireInstall(records, assistantId)
      const task = taskOf(install, assistantId, taskId)
      if (await this.liveSchedule(install.enabled[taskId]) === undefined) {
        const created = await this.automationTasks().create({
          title: task.title, prompt: task.prompt, workspaceId, assistantId, timing: scheduleTiming(task),
          ...(task.permission === undefined ? {} : { permission: task.permission }),
          ...(task.operations === undefined || task.operations.length === 0 ? {} : { operations: task.operations }),
        })
        install.enabled[taskId] = {
          sessionId: created.sessionId, scheduleId: created.record.id, version: install.version, task: taskJson(task),
        }
        await this.write(tenantId, records)
      }
      return this.state(signal)
    })
  }

  /**
   * Switch a recommended task off: delete its schedule. Its Session and history stay.
   * Already off, nothing changes.
   * @param assistantId - the assistant installed from a package.
   * @param taskId - the package's task id.
   * @param signal - caller lifetime.
   * @returns the state after it.
   * @throws RemoteError `hub-account/signed-out`, `assistant-packages/not-installed`, or `assistant-packages/task-not-found`.
   */
  @Remote
  disableTask(assistantId: string, taskId: string, signal: AbortSignal): Promise<AssistantPackagesState> {
    return this.serialized(async () => {
      const tenantId = await this.requireTenant()
      const records = await this.read(tenantId)
      const install = await this.requireInstall(records, assistantId)
      taskOf(install, assistantId, taskId)
      const enabled = install.enabled[taskId]
      if (enabled !== undefined) {
        await this.stopTasks([enabled])
        install.enabled = Object.fromEntries(Object.entries(install.enabled).filter(([id]) => id !== taskId))
        await this.write(tenantId, records)
      }
      return this.state(signal)
    })
  }

  private async updateLocked(
    tenantId: string, records: Records, assistantId: string, install: Install, signal: AbortSignal,
  ): Promise<AssistantPackageInstallResult> {
    const listed = await this.listed(install.packageId, signal)
    if (compareVersions(listed.version, install.version) <= 0) {
      const state = await this.state(signal)
      return { assistantId, version: install.version, installedSkills: [], missingSkills: install.missingSkills, keptFiles: [], state }
    }
    const content = await this.download(listed, signal)
    const skills = await this.ensureSkills(content.manifest, signal)
    const current = await this.ctx.assistants.getAssistant(assistantId)
    const files: Partial<Record<CoreFile, string>> = {}
    const keptFiles: CoreFile[] = []
    for (const file of CORE_FILES) {
      if (sha256(current.files[file]) === install.files[file]) files[file] = content.files[file]
      else keptFiles.push(file)
    }
    const next = profileOf(content.manifest, this.defaultAvatar)
    const now = profileJson(current.assistant)
    const change: { -readonly [K in keyof UpdateAssistantInput]: UpdateAssistantInput[K] } = { files }
    for (const field of PROFILE_FIELDS) {
      if (now[field] === install.profile[field]) Object.assign(change, { [field]: next[field] })
    }
    await this.ctx.assistants.updateAssistant(assistantId, change)
    const after = await this.ctx.assistants.getAssistant(assistantId)
    const written = profileJson(after.assistant)
    // A kept file keeps the hash the package last wrote, so it still counts as the user's on the next update.
    const replaced = CORE_FILES.filter(file => !keptFiles.includes(file)).map((file): [string, string] => [file, sha256(after.files[file])])
    const changed = PROFILE_FIELDS.filter(field => field in change).map((field): [string, string] => [field, written[field]])
    // A switched-on task the new version no longer recommends is switched off, so no schedule runs without an off switch.
    const kept = new Set(content.manifest.tasks.map(task => task.id))
    await this.stopTasks(Object.entries(install.enabled).filter(([id]) => !kept.has(id)).map(([, enabled]) => enabled))
    records.installs[assistantId] = {
      ...install, name: listed.name, version: listed.version, manifest: content.manifest,
      files: { ...install.files, ...Object.fromEntries(replaced) },
      profile: { ...install.profile, ...Object.fromEntries(changed) },
      enabled: Object.fromEntries(Object.entries(install.enabled).filter(([id]) => kept.has(id))),
      missingSkills: skills.missing,
    }
    await this.write(tenantId, records)
    const state = await this.state(signal)
    return { assistantId, version: listed.version, installedSkills: skills.installed, missingSkills: skills.missing, keptFiles, state }
  }

  private async state(signal: AbortSignal): Promise<AssistantPackagesState> {
    const tenantId = (await this.ctx.hubAccount.getState()).profile?.tenantId ?? null
    if (tenantId === null) return { tenantId, packages: null, unavailable: false, installed: [] }
    const records = await this.read(tenantId)
    let catalog: ListedPackage[] | null = null
    try {
      catalog = await this.catalog(signal)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      this.ctx.logger.warn(`assistant-packages: the package list could not be read: ${String(error)}`)
    }
    const assistants = new Set((await this.ctx.assistants.getState()).assistants.map(item => item.id))
    // The tasks of a deleted assistant are switched off and its record dropped, so none keeps running unseen.
    const gone = Object.entries(records.installs).filter(([id]) => !assistants.has(id))
    if (gone.length > 0) {
      await this.stopTasks(gone.flatMap(([, install]) => Object.values(install.enabled)))
      records.installs = Object.fromEntries(Object.entries(records.installs).filter(([id]) => assistants.has(id)))
      await this.write(tenantId, records)
    }
    const installed: InstalledPackageView[] = []
    for (const [assistantId, install] of Object.entries(records.installs)) {
      const latest = catalog?.find(item => item.id === install.packageId)
      const manifest = install.manifest
      // Each switched-on task has its own Session, so their schedules are listed side by side.
      const tasks: InstalledTaskView[] = await Promise.all(manifest.tasks.map(async (task) => {
        const live = await this.liveSchedule(install.enabled[task.id])
        return {
          ...task,
          enabled: live === undefined ? null : { sessionId: live.sessionId, scheduleId: live.scheduleId, version: live.version },
          outdated: live !== undefined && live.task !== taskJson(task),
        }
      }))
      installed.push({
        assistantId, packageId: install.packageId, name: install.name, displayName: manifest.displayName, version: install.version,
        updateVersion: latest !== undefined && compareVersions(latest.version, install.version) > 0 ? latest.version : null,
        tasks, missingSkills: install.missingSkills,
      })
    }
    const byPackage = new Map(installed.map(item => [item.packageId, item.assistantId]))
    return {
      tenantId,
      packages: catalog?.map(item => ({
        id: item.id, name: item.name, version: item.version, manifest: item.manifest, updatedAt: item.updatedAt,
        installedAssistantId: byPackage.get(item.id) ?? null,
      })) ?? null,
      unavailable: catalog === null,
      installed,
    }
  }

  /** The schedule of a switched-on task while it still exists. */
  private async liveSchedule(enabled: EnabledTask | undefined): Promise<EnabledTask | undefined> {
    if (enabled === undefined) return undefined
    const schedule = this.ctx.get('schedule')
    if (schedule === undefined) return undefined
    const tasks = await schedule.list({ sessionId: SessionId(enabled.sessionId) })
    return tasks.some(task => task.id === enabled.scheduleId) ? enabled : undefined
  }

  /** Delete the schedules of switched-on tasks; their Sessions stay. */
  private async stopTasks(enabled: readonly EnabledTask[]): Promise<void> {
    const schedule = this.ctx.get('schedule')
    for (const task of enabled) await schedule?.delete({ sessionId: SessionId(task.sessionId), id: ScheduleId(task.scheduleId) })
  }

  /**
   * Install the Skills a manifest names that are not on this machine yet, from the company's Skill Hub.
   * A Skill the Hub does not offer but a new session already finds, such as one DSH ships, needs
   * nothing; one the Hub does not offer and no session finds, or whose install fails, is reported
   * missing; the others still install.
   */
  private async ensureSkills(manifest: AssistantPackageManifest, signal: AbortSignal): Promise<{ installed: string[]; missing: string[] }> {
    const installed: string[] = []
    const missing: string[] = []
    if (manifest.skills === undefined) return { installed, missing }
    let found: Promise<Set<string>> | undefined
    const shipped = (name: string): Promise<boolean> => {
      found ??= this.foundSkills()
      return found.then(names => names.has(name))
    }
    const market = this.ctx.get('skillMarket')
    if (market === undefined) {
      for (const name of manifest.skills) if (!await shipped(name)) missing.push(name)
      return { installed, missing }
    }
    const records = await market.records()
    for (const name of manifest.skills) {
      if (records.has(name)) continue
      const card = await this.findSkill(market, name, signal)
      // A Skill the user placed on this machine under the same name already serves the assistant.
      if (card !== undefined && (card.conflict || card.installedVersion !== null)) continue
      if (card === undefined && await shipped(name)) continue
      try {
        if (card === undefined) throw new Error('not on the Skill Hub')
        await market.installSkill(card.id, {}, signal)
        installed.push(name)
      } catch (error: unknown) {
        if (signal.aborted) throw error
        this.ctx.logger.warn(`assistant-packages: Skill ${name} could not be installed: ${String(error)}`)
        missing.push(name)
      }
    }
    return { installed, missing }
  }

  /** The Skills a new session finds, as the assistants service lists them; none when it cannot tell. */
  private async foundSkills(): Promise<Set<string>> {
    try {
      return new Set((await this.ctx.assistants.capabilityOptions()).skills.map(skill => skill.id))
    } catch (error) {
      // Without the list, a Skill the Hub does not offer is reported missing.
      this.ctx.logger.warn(`assistant-packages: cannot list the Skills a session finds: ${String(error)}`)
      return new Set()
    }
  }

  /** The Skill Hub card named exactly `name`, searching every page of the matches. */
  private async findSkill(
    market: NonNullable<Context['skillMarket']>, name: string, signal: AbortSignal,
  ): Promise<MarketSkillCard | undefined> {
    let page = 0
    let more = true
    let card: MarketSkillCard | undefined
    while (card === undefined && more) {
      page += 1
      const result = await market.list({ q: name, page, pageSize: 50 }, signal)
      card = result.items.find(item => item.name === name)
      // An empty page ends the search even if the Hub's total says otherwise.
      more = page * result.pageSize < result.total && result.items.length > 0
    }
    return card
  }

  /** The packages the user center lists; one it lists in a form this build cannot read is left out. */
  private async catalog(signal: AbortSignal): Promise<ListedPackage[]> {
    const res = await this.hub('/api/client/agent-packages', signal)
    const raw: unknown = await res.json().catch(() => null)
    if (!Array.isArray(raw)) throw new RemoteError('assistant-packages/unavailable', 'The user center answered with no package list', { status: res.status })
    const listed: ListedPackage[] = []
    for (const item of raw) {
      const parsed = listedSchema.safeParse(item)
      if (parsed.success) listed.push(parsed.data)
      else this.ctx.logger.warn(`assistant-packages: a listed package cannot be read: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    }
    return listed
  }

  private async listed(packageId: string, signal: AbortSignal): Promise<ListedPackage> {
    const listed = (await this.catalog(signal)).find(item => item.id === packageId)
    if (listed === undefined) throw new RemoteError('assistant-packages/not-found', 'This assistant package is not available', { packageId })
    return listed
  }

  private async download(listed: ListedPackage, signal: AbortSignal): Promise<PackageContent> {
    const res = await this.hub(`/api/client/agent-packages/${encodeURIComponent(listed.id)}/download`, signal, listed.id)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new RemoteError('assistant-packages/unavailable', 'The download from the user center broke off', { status: null }, { cause: error })
    }
    try {
      return readPackage(bytes, listed, this.maxPackageBytes)
    } catch (error: unknown) {
      // readPackage throws only Error.
      const reason = (error as Error).message
      throw new RemoteError('assistant-packages/invalid', `The assistant package is invalid: ${reason}`, { reason }, { cause: error })
    }
  }

  /**
   * A user center call; a transport failure or an error answer reads as `assistant-packages/unavailable`,
   * a 404 for a package as not found.
   */
  private async hub(path: string, signal: AbortSignal, packageId?: string): Promise<Response> {
    let res: Response
    try {
      res = await this.ctx.hubAccount.request(path, { signal })
    } catch (error: unknown) {
      if (error instanceof RemoteError || signal.aborted) throw error
      throw new RemoteError('assistant-packages/unavailable', 'The user center cannot be reached', { status: null }, { cause: error })
    }
    if (res.status === 404 && packageId !== undefined) throw new RemoteError('assistant-packages/not-found', 'This assistant package is not available', { packageId })
    if (!res.ok) throw new RemoteError('assistant-packages/unavailable', `The user center answered ${String(res.status)}`, { status: res.status })
    return res
  }

  private automationTasks(): NonNullable<Context['automationTasks']> {
    const service = this.ctx.get('automationTasks')
    if (service === undefined) throw new RemoteError('assistant-packages/unavailable', 'This deployment cannot create automation tasks', { status: null })
    return service
  }

  private async requireTenant(): Promise<string> {
    const tenantId = (await this.ctx.hubAccount.getState()).profile?.tenantId ?? null
    if (tenantId === null) throw new RemoteError('hub-account/signed-out', 'Sign in to the user center first', {})
    return tenantId
  }

  /** The assistant id and install matching the predicate whose assistant still exists. */
  private async installOf(
    records: Records, match: (assistantId: string, install: Install) => boolean,
  ): Promise<[string, Install] | undefined> {
    const assistants = new Set((await this.ctx.assistants.getState()).assistants.map(item => item.id))
    return Object.entries(records.installs).find(([id, install]) => assistants.has(id) && match(id, install))
  }

  private async requireInstall(records: Records, assistantId: string): Promise<Install> {
    const found = await this.installOf(records, id => id === assistantId)
    if (found === undefined) throw notInstalled(assistantId)
    return found[1]
  }

  private file(tenantId: string): string {
    return join(this.root, tenantId, 'installs.json')
  }

  private async read(tenantId: string): Promise<Records> {
    let text: string
    try {
      text = await readFile(this.file(tenantId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, installs: {} }
      throw error
    }
    return recordsSchema.parse(JSON.parse(text))
  }

  private async write(tenantId: string, records: Records): Promise<void> {
    await writeFileAtomic(this.file(tenantId), `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  /** Run one operation after the previous ones, so two calls never interleave reads and writes of the records. */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation)
    this.writes = result.catch(() => undefined)
    return result
  }
}

const notInstalled = (assistantId: string) => new RemoteError('assistant-packages/not-installed', 'This assistant was not installed from a package', { assistantId })

function taskOf(install: Install, assistantId: string, taskId: string): AssistantPackageTask {
  const task = install.manifest.tasks.find(item => item.id === taskId)
  if (task === undefined) throw new RemoteError('assistant-packages/task-not-found', 'The package has no such recommended task', { assistantId, taskId })
  return task
}

export default AssistantPackagesService
