/**
 * Assistants for Desktop, behind one Host service and the `assistants` Remote namespace. An
 * assistant is a named role with its own core files, kept per tenant of the current Hub sign-in
 * under `<dshHome>/assistants/<tenantId>/<assistantId>/`: `assistant.json` and the Markdown core
 * files. The tenant's `tenant.json` records the templates it was seeded from; when a tenant signs
 * in, the service creates one assistant from each configured seed template not seeded yet, so each
 * template is seeded once per tenant and never again after the user deletes it.
 *
 * A new main session binds no assistant; while it is blank the user may bind one, switch to
 * another, or go back to none, each recorded as `assistant/selected`. Binding an assistant whose knowledge subset
 * names knowledge bases selects those that still exist for the session, logged as
 * `knowledge/selection`; binding one without a knowledge subset, or none, clears that preselection.
 * A selection the user changed is kept. Before each turn step the service reads the
 * bound assistant's core files and records them with `assistant/instructions` whenever they
 * differ from the previous record; the `assistant:core-files` prompt section carries the recorded
 * text, so an edit reaches the model on the next turn and every prompt stays reconstructable from
 * the session log. A session whose assistant was deleted keeps its binding; once it carried core
 * files, the section then says they no longer apply. `otherTenantAssistants()` tells which bound ids
 * another tenant on this machine keeps, without reading anything about them.
 *
 * @module @deepseek-ai/dsh-assistants
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-connectors'
import type {} from '@deepseek-ai/dsh-knowledge-base'
import type {} from '@deepseek-ai/dsh-knowledge-selection'
import { RUNTIME_PROVIDER } from '@deepseek-ai/dsh-skill'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { BLANK_FILES, CORE_FILE_NAMES, DAILY_ASSISTANT, TEMPLATES, type AssistantTemplate, type CoreFiles } from './templates.ts'
import type {
  AssistantAvatar, AssistantCapabilityOptions, AssistantDetail, AssistantProjectionState, AssistantsState, AssistantSubsets,
  AssistantTemplateView, AssistantUserInfo, AssistantView, CreateAssistantInput, CreateAssistantResult, UpdateAssistantInput,
} from './types.ts'

export type * from './types.ts'
export { BLANK_FILES, CORE_FILE_NAMES, DAILY_ASSISTANT, ECOMMERCE_MANAGER, ECOMMERCE_SKILLS, OFFICE_SKILLS, TEMPLATES, type AssistantTemplate, type CoreFiles } from './templates.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The signed-in tenant's assistants and the assistant each session is bound to. */
    assistants: AssistantsService
  }
}

/** Plugin configuration. */
export interface Config {
  /** DeepSeek Harness home; assistants live under `<dshHome>/assistants`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Longest assistant name, in characters. */
  maxNameLength?: number
  /** Longest assistant description, in characters. */
  maxDescriptionLength?: number
  /** Largest uploaded avatar, as the length of its data URL. */
  maxAvatarLength?: number
  /** Longest core file the detail page may save, in characters; every turn carries the core files. */
  maxCoreFileLength?: number
  /**
   * Templates each tenant gets an assistant from when it signs in on this machine, in this order; each
   * template is seeded once per tenant, so one added later reaches tenants seeded before it, and one the
   * user deleted is not created again.
   */
  seedTemplates?: SeedTemplateId[]
}

/** Templates an assistant can be seeded from. */
export type SeedTemplateId = 'daily' | 'ecommerce'

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  dshHome: Schema.string().description('DeepSeek Harness home; assistants live under `<dshHome>/assistants`. Defaults to `$DSH_HOME` or `~/.dsh`.'),
  maxNameLength: Schema.natural().min(1).default(32).description('Longest assistant name, in characters.'),
  maxDescriptionLength: Schema.natural().default(200).description('Longest assistant description, in characters.'),
  maxAvatarLength: Schema.natural().min(1).default(700_000).description('Largest uploaded avatar, as the length of its data URL.'),
  maxCoreFileLength: Schema.natural().min(1).default(20_000).description('Longest core file the detail page may save, in characters; every turn carries the core files.'),
  seedTemplates: Schema.array(Schema.union(['daily', 'ecommerce'] as const)).default(['daily', 'ecommerce'])
    .description('Templates each tenant gets an assistant from when it signs in on this machine, in order; each is seeded once per tenant, so one added later reaches tenants seeded before it, and a deleted one is not created again.'),
})

/** Suffix of a duplicated assistant's name. */
const COPY_SUFFIX = ' 副本'

/** Name of the prompt section that carries the bound assistant's core files. */
export const ASSISTANT_SECTION = 'assistant:core-files'

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const avatarSchema = z.union([
  z.object({ kind: z.literal('preset'), key: z.string().min(1) }),
  z.object({ kind: z.literal('image'), dataUrl: z.string().regex(IMAGE_DATA_URL) }),
])
const modelSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() })

const assistantFileSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  avatar: avatarSchema,
  preset: z.string().min(1).optional(),
  model: modelSchema.optional(),
  subsets: z.object({
    skills: z.array(z.string()).optional(),
    connectors: z.array(z.string()).optional(),
    knowledgeBases: z.array(z.string()).optional(),
  }).optional(),
  templateId: z.string().min(1).optional(),
  createdAt: z.string(),
})

const tenantFileSchema = z.object({
  version: z.literal(1),
  // Ignored: new sessions bind no assistant. Kept so earlier builds still read the file; seeding writes it as null.
  defaultId: z.string().nullable(),
  // True once any assistant was seeded; a file without seededTemplates was written when only the Daily Assistant was.
  seeded: z.boolean(),
  /** Templates already seeded for the tenant. */
  seededTemplates: z.array(z.string()).optional(),
})

type TenantFile = z.infer<typeof tenantFileSchema>

const projectionStateSchema = z.object({ assistantId: z.string().nullable(), instructions: z.string().nullable() })
const projectionViewSchema = z.string().nullable()

/** The `assistant` Session projection: the bound assistant and its last recorded instructions. */
export const assistantProjectionDefinition = {
  key: 'assistant',
  stateSchema: projectionStateSchema,
  init: () => ({ assistantId: null, instructions: null }),
  apply: (state, event) => {
    // An empty id records going back to no assistant. Earlier builds keep it as an id no assistant has, so they carry no core files either.
    if (event.type === 'assistant/selected') return { ...state, assistantId: event.data.assistantId === '' ? null : event.data.assistantId }
    if (event.type === 'assistant/instructions') return { ...state, instructions: event.data.text }
    return state
  },
  wire: { viewSchema: projectionViewSchema, view: state => state.assistantId },
  // 2: an empty assistant/selected id folds to null.
  stateVersion: 2,
} satisfies ProjectionDefinition<'assistant', AssistantProjectionState>

/**
 * Section text once core files that earlier turns carried no longer apply, because the assistant was
 * deleted, left the signed-in tenant, or had every core file emptied. Earlier turns stay in the
 * conversation, so the model is told to stop following them.
 */
export const CORE_FILES_WITHDRAWN = 'The core files given earlier in this conversation no longer apply: the assistant they defined is no longer available or no longer has them. Stop following their identity, personality, user information, and working method, including any required openings, signatures, or formats, and work as a general assistant.'

/**
 * Render an assistant's core files as the prompt section text.
 * @param name - the assistant's display name.
 * @param files - core file contents by file name, in model reading order.
 * @returns the section text; empty when every file is blank.
 */
export function renderInstructions(name: string, files: ReadonlyArray<readonly [string, string]>): string {
  const blocks = files.filter(([, text]) => text.trim() !== '').map(([file, text]) => `<core_file name="${file}">\n${text.trim()}\n</core_file>`)
  if (blocks.length === 0) return ''
  return [
    `You are the assistant "${name}". The user wrote the core files below to define your identity, personality, what you know about them, and how you work. They replace any earlier version in this conversation; follow them.`,
    ...blocks,
  ].join('\n\n')
}

/**
 * Put an assistant's name into the `**名称**` line of its identity file, when the file has one.
 * @param identity - the identity file text.
 * @param name - the assistant's name.
 * @returns the text with the name line replaced.
 */
export function withName(identity: string, name: string): string {
  return identity.replace(/^(- \*\*名称\*\*：).*$/mu, (_line, label: string) => `${label}${name}`)
}

/**
 * Render the user information file.
 * @param user - what the user said about themselves.
 * @returns the `USER.md` text.
 */
export function renderUser(user: AssistantUserInfo): string {
  const line = (value: string): string => value.trim().replace(/\s*\n\s*/gu, ' ')
  return [
    '# 用户信息', '',
    `- **称呼**：${line(user.name)}`,
    `- **偏好语言**：${line(user.language)}`,
    `- **备注**：${line(user.notes)}`,
    '', '## 背景', '',
    ...(user.background.trim() === '' ? [] : [user.background.trim(), '']),
  ].join('\n')
}

/**
 * Read a UTF-8 file that may not exist.
 * @param path - the file to read.
 * @returns its text, or undefined when it does not exist; other read failures reject.
 */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Format a JSON file's text.
 * @param value - the value to store.
 * @returns indented JSON with a trailing newline.
 */
function jsonText(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** The kinds of capability a subset names. */
const SUBSET_KINDS = ['skills', 'connectors', 'knowledgeBases'] as const

/**
 * Keep the lists a subset sets, without empty or repeated ids.
 * @param subsets - subsets as given or stored.
 * @returns the subsets, or undefined when every kind allows everything.
 */
export function normalizeSubsets(
  subsets: Readonly<Partial<Record<keyof AssistantSubsets, readonly string[] | undefined>>> | undefined,
): AssistantSubsets | undefined {
  const kept: Partial<Record<keyof AssistantSubsets, readonly string[]>> = {}
  for (const kind of SUBSET_KINDS) {
    const ids = subsets?.[kind]
    if (ids !== undefined) kept[kind] = [...new Set(ids.filter(id => id !== ''))]
  }
  return Object.keys(kept).length === 0 ? undefined : kept
}

/** An assistant id that names one directory: no separator, and not hidden, `.`, or `..`. */
const SINGLE_SEGMENT = /^[^./\\][^/\\]*$/u

/** Connector states without an installed CLI. */
const NOT_INSTALLED: ReadonlySet<string> = new Set(['unsupported', 'not-installed', 'installing'])

/** Skill sources that belong to a connector, which the connector subset governs. */
const CONNECTOR_SKILL_SOURCE = /^connector-/u

/**
 * Whether a Skill belongs to DSH itself rather than to the user: a connector's, which the connector
 * subset governs, or one a plugin registers at runtime, such as `ecommerce-accounts`, which every
 * session gets like an account-wide Skill. Skill subsets never name either.
 */
const systemSkill = (skill: { readonly source: string; readonly provider: string }): boolean =>
  CONNECTOR_SKILL_SOURCE.test(skill.source) || skill.provider === RUNTIME_PROVIDER

const TEMPLATE_VIEWS: readonly AssistantTemplateView[] = [...TEMPLATES.values()]
  .map(({ id, name, description, avatar, subsets }) => ({ id, name, description, avatar, ...(subsets === undefined ? {} : { subsets }) }))

/** Host owner of the assistants and of the `assistants` Remote namespace. */
export class AssistantsService extends TypertRemoteService {
  static inject = ['hubAccount', 'sessionProjections', 'agents']
  static Config = Config

  private readonly root: string
  private readonly seedTemplates: readonly SeedTemplateId[]
  private readonly limits: { readonly name: number; readonly description: number; readonly avatar: number; readonly file: number }
  private tenantId: string | null = null
  private tenant: TenantFile = { version: 1, defaultId: null, seeded: false }
  private list: AssistantView[] = []
  private writes: Promise<unknown> = Promise.resolve()
  private revision = Date.now()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  /** The knowledge bases last preselected for each blank session; a selection that differs was changed by the user. */
  private readonly preselected = new WeakMap<Agent['session'], readonly string[]>()

  /** @param ctx - Host with the Hub sign-in, session projections, and agents. @param config - storage options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'assistants', { namespace: 'assistants' })
    const resolved = Config(config) as Config & Required<Omit<Config, 'dshHome'>>
    this.root = join(resolveDshHome(resolved.dshHome), 'assistants')
    this.seedTemplates = resolved.seedTemplates
    this.limits = {
      name: resolved.maxNameLength, description: resolved.maxDescriptionLength,
      avatar: resolved.maxAvatarLength, file: resolved.maxCoreFileLength,
    }
    ctx.sessionProjections.register(assistantProjectionDefinition)
    ctx.effect(() => () => {
      this.lifetime.abort()
      this.changed()
    }, 'assistants: lifetime')
    for (const agent of ctx.agents.list()) {
      if (agent.session.header.parentSession === undefined) this.installPrompt(agent)
    }
    this.installSubsets()
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession !== undefined) return
      // A new session binds no assistant; the user picks one, if any, before the first turn.
      this.installPrompt(agent)
    })
  }

  async [Service.init](): Promise<void> {
    await this.serialized(async () => this.switchTenant((await this.ctx.hubAccount.getState()).profile?.tenantId ?? null))
    void (async () => {
      for await (const state of this.ctx.hubAccount.watch(this.lifetime.signal)) {
        const tenantId = state.profile?.tenantId ?? null
        if (tenantId !== this.tenantId) await this.serialized(() => this.switchTenant(tenantId))
      }
    })()
  }

  /**
   * Read the signed-in tenant's assistants.
   * @returns the state the Assistants page and the new-session picker show.
   */
  @Remote
  getState(): Promise<AssistantsState> {
    return Promise.resolve({
      revision: this.revision, tenantId: this.tenantId, assistants: this.list, templates: TEMPLATE_VIEWS,
    })
  }

  /**
   * Stream the state.
   * @param signal - stream lifetime.
   * @returns the current state, then every change.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<AssistantsState> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!this.lifetime.signal.aborted && !signal.aborted) {
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }

  /**
   * Create an assistant for the signed-in tenant from a template or blank.
   * @param input - the wizard's choices: start, identity, avatar, model, preset, and user information.
   * @returns the new assistant's id and the state with it last.
   * @throws RemoteError `hub-account/signed-out`, `assistants/template-not-found`, `assistants/invalid-name`,
   *   `assistants/invalid-description`, `assistants/invalid-avatar`, or `assistants/preset-unavailable`.
   */
  @Remote
  createAssistant(input: CreateAssistantInput): Promise<CreateAssistantResult> {
    return this.serialized(async () => {
      const tenantId = this.requireTenant()
      const template = input.templateId === null ? undefined : TEMPLATES.get(input.templateId)
      if (input.templateId !== null && template === undefined) {
        throw new RemoteError('assistants/template-not-found', 'This template does not exist', { templateId: input.templateId })
      }
      const name = this.checkName(input.name)
      const description = this.checkDescription(input.description)
      this.checkAvatar(input.avatar)
      if (input.preset !== undefined) await this.checkPreset(input.preset)
      const files = template?.files ?? BLANK_FILES
      const subsets = normalizeSubsets(input.subsets ?? template?.subsets)
      const view = await this.writeAssistant(tenantId, {
        id: randomUUID(), name, description, avatar: input.avatar,
        ...(input.preset === undefined ? {} : { preset: input.preset }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(subsets === undefined ? {} : { subsets }),
        ...(template === undefined ? {} : { templateId: template.id }),
        createdAt: new Date().toISOString(),
      }, { ...files, 'IDENTITY.md': withName(files['IDENTITY.md'], name), 'USER.md': renderUser(input.user) })
      this.list = [...this.list, view]
      this.changed()
      return { assistantId: view.id, state: await this.getState() }
    })
  }

  /**
   * List the Skills, connectors, and knowledge bases available now, which subsets can name.
   * Skills are those a new session's default Agent preset discovers outside any project; a
   * service the deployment does not compose offers none.
   * @returns enabled model-usable Skills other than connector Skills, connectors installed and
   *   switched on for the tenant (named by id), and the tenant's knowledge bases.
   */
  @Remote
  async capabilityOptions(): Promise<AssistantCapabilityOptions> {
    // Skill discovery mounts with an Agent preset, so read through the default preset's scope, as a new session sees it.
    await using lease = await this.ctx.get('agentPresets')?.acquireScope()
    const skills = (await this.ctx.get('skills')?.list(lease === undefined ? {} : { scope: lease.key }) ?? [])
      .filter(skill => skill.invocation.modelInvocable && !systemSkill(skill))
      .map(skill => ({ id: skill.name, name: skill.name, description: skill.description }))
    // The client names each connector in its own language.
    const connectors = (await this.ctx.get('connectors')?.getState())?.connectors
      .filter(item => item.enabled && !NOT_INSTALLED.has(item.status))
      .map(item => ({ id: item.id, name: item.id })) ?? []
    const knowledgeBases = (await this.ctx.get('knowledgeBases')?.getState())?.bases
      .map(base => ({ id: base.id, name: base.name })) ?? []
    return { skills, connectors, knowledgeBases }
  }

  /**
   * Pick, from assistant ids that sessions are bound to, those another tenant keeps on this machine,
   * so a client can tell a session of another company's assistant from one whose assistant was
   * deleted. Only the existence of each `<tenant>/<id>/assistant.json` is checked, nothing in it is
   * read or returned, and a folder that cannot be read counts as not holding the assistant.
   * @param assistantIds - the ids to look for; one that is not a single path segment is never found.
   * @returns the ids found under a tenant other than the signed-in one; none while signed out.
   */
  @Remote
  async otherTenantAssistants(assistantIds: readonly string[]): Promise<string[]> {
    if (this.tenantId === null) return []
    const signedIn = this.tenantId
    const ids = [...new Set(assistantIds)].filter(id => SINGLE_SEGMENT.test(id))
    const entries = await readdir(this.root, { withFileTypes: true })
    const tenants = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== signedIn)
    const found = await Promise.all(ids.map(async (id) => {
      const held = await Promise.all(tenants.map(tenant => stat(join(this.root, tenant.name, id, 'assistant.json')).then(() => true, () => false)))
      return held.includes(true) ? id : undefined
    }))
    return found.filter(id => id !== undefined)
  }

  /**
   * Read one assistant with the text of its core files.
   * @param assistantId - the assistant to read.
   * @returns the assistant and its core files.
   * @throws RemoteError `hub-account/signed-out` or `assistants/not-found`.
   */
  @Remote
  getAssistant(assistantId: string): Promise<AssistantDetail> {
    return this.serialized(async () => {
      const assistant = this.find(assistantId)
      return { assistant, files: await this.readFiles(this.dirOf(assistant.id)) }
    })
  }

  /**
   * Change an assistant. Core files and the name reach every session bound to it on its next turn;
   * a changed model or preset applies to sessions bound afterward and to blank sessions bound now.
   * Renaming also rewrites the `**名称**` line of the identity file.
   * @param assistantId - the assistant to change.
   * @param input - the fields to change.
   * @returns the state with the change.
   * @throws RemoteError `hub-account/signed-out`, `assistants/not-found`, `assistants/invalid-name`,
   *   `assistants/invalid-description`, `assistants/invalid-avatar`, `assistants/preset-unavailable`, or `assistants/invalid-file`.
   */
  @Remote
  updateAssistant(assistantId: string, input: UpdateAssistantInput): Promise<AssistantsState> {
    return this.serialized(async () => {
      const previous = this.find(assistantId)
      const name = input.name === undefined ? previous.name : this.checkName(input.name)
      const description = input.description === undefined ? previous.description : this.checkDescription(input.description)
      if (input.avatar !== undefined) this.checkAvatar(input.avatar)
      if (typeof input.preset === 'string') await this.checkPreset(input.preset)
      // Only the core file names are read, so no other path under the assistant can be written.
      const files: Partial<Record<keyof CoreFiles, string>> = {}
      for (const file of CORE_FILE_NAMES) {
        const text = input.files?.[file]
        if (text === undefined) continue
        files[file] = text
        if (Array.from(text).length > this.limits.file) {
          throw new RemoteError('assistants/invalid-file', `A core file must be at most ${String(this.limits.file)} characters`, { file, length: Array.from(text).length })
        }
      }
      const dir = this.dirOf(assistantId)
      if (name !== previous.name) files['IDENTITY.md'] = withName(files['IDENTITY.md'] ?? await readOptional(join(dir, 'IDENTITY.md')) ?? '', name)
      const { preset: _preset, model: _model, subsets: _subsets, ...kept } = previous
      const preset = input.preset === undefined ? previous.preset : input.preset ?? undefined
      const model = input.model === undefined ? previous.model : input.model ?? undefined
      const subsets = input.subsets === undefined ? previous.subsets : normalizeSubsets(input.subsets)
      const next: AssistantView = {
        ...kept, name, description, avatar: input.avatar ?? previous.avatar,
        ...(preset === undefined ? {} : { preset }),
        ...(model === undefined ? {} : { model }),
        ...(subsets === undefined ? {} : { subsets }),
      }
      for (const [file, text] of Object.entries(files)) await this.writeAtomic(join(dir, file), text)
      await this.writeAtomic(join(dir, 'assistant.json'), jsonText({ version: 1, ...next }))
      this.list = this.list.map(item => item.id === assistantId ? next : item)
      const rebind = preset !== previous.preset || JSON.stringify(model) !== JSON.stringify(previous.model)
      if (rebind) await this.rebindBlank(assistantId, next, previous)
      if (JSON.stringify(next.subsets?.knowledgeBases) !== JSON.stringify(previous.subsets?.knowledgeBases)) {
        for (const agent of this.blankBoundTo(assistantId)) await this.preselectKnowledge(agent, next)
      }
      this.changed()
      return this.getState()
    })
  }

  /**
   * Copy an assistant's configuration and core files into a new assistant named «name 副本»; sessions are not copied.
   * @param assistantId - the assistant to copy.
   * @returns the copy's id and the state with it last.
   * @throws RemoteError `hub-account/signed-out` or `assistants/not-found`.
   */
  @Remote
  duplicateAssistant(assistantId: string): Promise<CreateAssistantResult> {
    return this.serialized(async () => {
      const source = this.find(assistantId)
      const base = Array.from(source.name).slice(0, Math.max(0, this.limits.name - Array.from(COPY_SUFFIX).length)).join('')
      const name = `${base}${COPY_SUFFIX}`
      const files = await this.readFiles(this.dirOf(source.id))
      const view = await this.writeAssistant(this.requireTenant(), {
        ...source, id: randomUUID(), name, createdAt: new Date().toISOString(),
      }, { ...files, 'IDENTITY.md': withName(files['IDENTITY.md'], name) })
      this.list = [...this.list, view]
      this.changed()
      return { assistantId: view.id, state: await this.getState() }
    })
  }

  /**
   * Delete an assistant. Its sessions remain and carry no core files from their next turn; blank
   * sessions bound to it bind none.
   * @param assistantId - the assistant to delete.
   * @returns the state without it.
   * @throws RemoteError `hub-account/signed-out` or `assistants/not-found`.
   */
  @Remote
  deleteAssistant(assistantId: string): Promise<AssistantsState> {
    return this.serialized(async () => {
      const deleted = this.find(assistantId)
      const dir = this.dirOf(deleted.id)
      // Without assistant.json the directory is no longer an assistant, so a crash mid-removal leaves none behind.
      await rm(join(dir, 'assistant.json'), { force: true })
      await rm(dir, { recursive: true, force: true })
      this.list = this.list.filter(item => item !== deleted)
      await this.rebindBlank(deleted.id, undefined, deleted)
      this.changed()
      return this.getState()
    })
  }

  /**
   * Bind a blank session to one of the signed-in tenant's assistants, or to none.
   * @param agent - the session's Agent.
   * @param assistantId - the assistant to bind, or null to bind none.
   * @returns the bound assistant id, or null.
   * @throws RemoteError `hub-account/signed-out`, `assistants/not-found`, or `assistants/locked` once the session started.
   */
  @Remote('select')
  select(agent: Agent, assistantId: string | null): Promise<string | null> {
    return this.serialized(async () => {
      this.requireTenant()
      const assistant = assistantId === null ? undefined : this.list.find(item => item.id === assistantId)
      if (assistantId !== null && assistant === undefined) throw new RemoteError('assistants/not-found', 'This assistant no longer exists', { assistantId })
      if (!this.isBlank(agent)) throw new RemoteError('assistants/locked', 'This session has already started', { sessionId: agent.id, assistantId })
      const boundId = this.boundId(agent)
      const previous = this.list.find(item => item.id === boundId)
      if (boundId !== (assistant?.id ?? null)) await this.bind(agent, assistant, previous)
      return assistantId
    })
  }

  /**
   * Bind the assistant, applying its preset and model. Picking, in the same blank session, an
   * assistant without either after one that set it returns the session to the deployment's default
   * preset or the global model, so a choice the user made in the composer is left alone otherwise.
   * Without an assistant, only that return happens and a bound session is recorded as bound to none.
   * Either way the session's knowledge selection follows the assistant's knowledge subset unless the
   * user changed it.
   */
  private async bind(agent: Agent, assistant: AssistantView | undefined, previous?: AssistantView): Promise<void> {
    const presets = this.ctx.get('agentPresets')
    const preset = assistant?.preset ?? (previous?.preset === undefined ? undefined : presets?.defaultId)
    if (preset !== undefined && presets !== undefined) {
      try {
        await presets.select(agent, preset)
      } catch (error) {
        // A preset removed since the assistant was created leaves the session on the deployment default.
        this.ctx.logger.warn(`assistants: preset ${preset} for ${agent.id} not applied: ${String(error)}`)
      }
    }
    const model = assistant?.model ?? (previous?.model === undefined ? undefined : this.ctx.get('agentDefaultModel')?.currentSelection())
    // An unavailable model, such as one removed from Settings, leaves the session on the global default.
    if (model !== undefined) await this.ctx.get('sessionController')?.useModel(agent, model)
    const assistantId = assistant?.id ?? null
    if (assistantId === this.boundId(agent)) return
    agent.session.append('assistant/selected', { assistantId: assistantId ?? '' })
    await this.preselectKnowledge(agent, assistant)
  }

  /**
   * Select for a blank session the knowledge bases its assistant's subset names that still exist, or
   * none for an assistant without a knowledge subset or for no assistant. Only a selection that still
   * equals the last preselection, or a session that never selected any, is replaced, so a selection the
   * user changed is kept. A failure leaves the binding in place and is logged as a warning.
   */
  private async preselectKnowledge(agent: Agent, assistant: AssistantView | undefined): Promise<void> {
    const selection = this.ctx.get('knowledgeSelection')
    const knowledgeBases = this.ctx.get('knowledgeBases')
    if (selection === undefined || knowledgeBases === undefined) return
    const current = this.ctx.sessionProjections.stateOf(agent.session, 'knowledgeSelection')?.bases.map(base => base.id) ?? []
    const last = this.preselected.get(agent.session) ?? []
    if (current.length !== last.length || !current.every(id => last.includes(id))) return
    const ids = assistant?.subsets?.knowledgeBases
    if (ids === undefined && current.length === 0) return
    try {
      const existing = ids === undefined ? [] : (await knowledgeBases.getState()).bases
      const wanted = existing.filter(base => ids?.includes(base.id) === true).map(base => base.id)
      await selection.select(agent.id, wanted)
      this.preselected.set(agent.session, wanted)
    } catch (error) {
      // The binding stands without the preselection; the user can still pick knowledge bases in the composer.
      this.ctx.logger.warn(`assistants: knowledge bases for ${agent.id} not preselected: ${String(error)}`)
    }
  }

  /** The blank main sessions bound to an assistant. */
  private blankBoundTo(assistantId: string): Agent[] {
    return this.ctx.agents.list()
      .filter(agent => agent.session.header.parentSession === undefined && this.isBlank(agent) && this.boundId(agent) === assistantId)
  }

  /** Bind every blank main session bound to `fromId` to `next`, or to none, replacing `previous`'s preset and model. */
  private async rebindBlank(fromId: string, next: AssistantView | undefined, previous: AssistantView): Promise<void> {
    for (const agent of this.blankBoundTo(fromId)) await this.bind(agent, next, previous)
  }

  private find(assistantId: string): AssistantView {
    this.requireTenant()
    const assistant = this.list.find(item => item.id === assistantId)
    if (assistant === undefined) throw new RemoteError('assistants/not-found', 'This assistant no longer exists', { assistantId })
    return assistant
  }

  private checkName(raw: string): string {
    const name = raw.trim()
    if (name === '' || Array.from(name).length > this.limits.name) {
      throw new RemoteError('assistants/invalid-name', `The name must be 1 to ${String(this.limits.name)} characters`, { name: raw })
    }
    return name
  }

  private checkDescription(raw: string): string {
    const description = raw.trim()
    if (Array.from(description).length > this.limits.description) {
      throw new RemoteError('assistants/invalid-description', `The description must be at most ${String(this.limits.description)} characters`, { length: Array.from(description).length })
    }
    return description
  }

  private async checkPreset(preset: string): Promise<void> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return
    try {
      await presets.resolve(preset)
    } catch {
      // resolve() rejects an id no declaration supplies; the page offered an outdated roster.
      throw new RemoteError('assistants/preset-unavailable', 'This capability base is no longer available', { preset })
    }
  }

  private checkAvatar(avatar: AssistantAvatar): void {
    const parsed = avatarSchema.safeParse(avatar)
    if (!parsed.success) throw new RemoteError('assistants/invalid-avatar', 'The avatar must be a preset or a PNG, JPEG, or WebP image', { reason: 'format' })
    if (avatar.kind === 'image' && avatar.dataUrl.length > this.limits.avatar) {
      throw new RemoteError('assistants/invalid-avatar', 'The avatar image is too large', { reason: 'size' })
    }
  }

  private boundId(agent: Agent): string | null {
    return this.ctx.sessionProjections.stateOf(agent.session, 'assistant')?.assistantId ?? null
  }

  private isBlank(agent: Agent): boolean {
    const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    return boundary === undefined || (boundary.openTurnStartSeq === null && boundary.lastTurn === 0)
  }

  /**
   * Keep each session to its assistant's subsets: Skills through the skill registry, connectors and
   * knowledge bases through their services, each where the deployment composes it.
   */
  private installSubsets(): void {
    this.ctx.inject(['skills'], (scope) => {
      scope.effect(() => scope.skills.addViewFilter((skill, viewer) => {
        if (systemSkill(skill)) return true
        const agent = this.ctx.agents.list().find(item => item === viewer)
        return agent === undefined || this.permits(agent, 'skills', skill.name)
      }), 'assistants: Skill subsets')
    })
    this.ctx.inject(['connectors'], (scope) => {
      scope.effect(() => scope.connectors.restrict((agent, id) => this.permits(agent, 'connectors', id)), 'assistants: connector subsets')
    })
    this.ctx.inject(['knowledgeSelection'], (scope) => {
      scope.effect(() => scope.knowledgeSelection.restrict((agent, id) => this.permits(agent, 'knowledgeBases', id)), 'assistants: knowledge subsets')
    })
  }

  /**
   * Whether the assistant of an agent's session allows one item. A subagent follows the session it
   * works for; a session bound to no assistant, or to one no longer in the tenant, is not limited.
   */
  private permits(agent: Agent, kind: keyof AssistantSubsets, id: string): boolean {
    let main = agent
    for (let parent = main.session.header.parentSession; parent !== undefined; parent = main.session.header.parentSession) {
      const found = this.ctx.agents.get(parent)
      if (found === undefined) break
      main = found
    }
    const ids = this.list.find(item => item.id === this.boundId(main))?.subsets?.[kind]
    return ids === undefined || ids.includes(id)
  }

  private installPrompt(agent: Agent): void {
    agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: ASSISTANT_SECTION,
        order: scope.systemPrompt.getSectionOrder('ASSISTANT_CORE_FILES'),
        text: () => this.ctx.sessionProjections.stateOf(agent.session, 'assistant')?.instructions ?? '',
        interpolate: false,
      })
      scope.on('system-prompt/assemble', async (assembly, context, next) => {
        if (context.signal === undefined) return next()
        const state = this.ctx.sessionProjections.stateOf(agent.session, 'assistant')
        const assistantId = state?.assistantId ?? null
        if (assistantId === null) return next()
        const rendered = await this.instructionsFor(assistantId)
        // Core files that earlier turns carried stay in the conversation; say they no longer apply.
        const text = rendered === '' && (state?.instructions ?? '') !== '' ? CORE_FILES_WITHDRAWN : rendered
        if (text !== (state?.instructions ?? null)) agent.session.append('assistant/instructions', { text })
        assembly.sections = assembly.sections.map(section => section.name === ASSISTANT_SECTION ? { ...section, text } : section)
        return next()
      })
    })
  }

  private async instructionsFor(assistantId: string): Promise<string> {
    const assistant = this.list.find(item => item.id === assistantId)
    if (assistant === undefined || this.tenantId === null) return ''
    const files = await this.readFiles(this.dirOf(assistant.id))
    return renderInstructions(assistant.name, CORE_FILE_NAMES.map(file => [file, files[file]] as const))
  }

  /** Read the core files of an assistant directory; a missing file reads empty, since the user may have deleted it on disk. */
  private async readFiles(dir: string): Promise<CoreFiles> {
    const texts = await Promise.all(CORE_FILE_NAMES.map(async file => [file, await readOptional(join(dir, file)) ?? ''] as const))
    return Object.fromEntries(texts) as Record<keyof CoreFiles, string>
  }

  private dirOf(assistantId: string): string {
    return join(this.root, this.requireTenant(), assistantId)
  }

  private async switchTenant(tenantId: string | null): Promise<void> {
    this.tenantId = tenantId
    this.tenant = { version: 1, defaultId: null, seeded: false }
    this.list = []
    if (tenantId !== null) {
      await mkdir(join(this.root, tenantId), { recursive: true })
      this.tenant = await this.readTenant(tenantId)
      this.list = await this.readAssistants(tenantId)
      try {
        await this.seed(tenantId)
      } catch (error) {
        // A failed seed (a full disk, say) leaves the tenant usable; the next sign-in tries the missing templates again.
        this.ctx.logger.warn(`assistants: seeding ${tenantId} failed: ${String(error)}`)
      }
    }
    this.changed()
  }

  /**
   * Create an assistant from each configured template the tenant has not been seeded from.
   */
  private async seed(tenantId: string): Promise<void> {
    const done = this.tenant.seededTemplates ?? (this.tenant.seeded ? [DAILY_ASSISTANT.id] : [])
    const missing = [...new Set(this.seedTemplates)].filter(id => !done.includes(id))
    // One millisecond apart, so the creation order (the list order) survives a reload.
    const start = Date.now()
    for (const [index, id] of missing.entries()) {
      const template = TEMPLATES.get(id)
      // Config admits only template ids, so every seed id names a template.
      if (template === undefined) continue
      const created = await this.createFrom(tenantId, template, new Date(start + index))
      this.list = [...this.list, created]
      // Recorded right after each creation, so an interrupted seeding never creates one twice.
      this.tenant = {
        version: 1, defaultId: null, seeded: true,
        seededTemplates: [...this.tenant.seededTemplates ?? done, id],
      }
      await this.writeAtomic(join(this.root, tenantId, 'tenant.json'), jsonText(this.tenant))
    }
  }

  private async readTenant(tenantId: string): Promise<TenantFile> {
    // A tenant that never signed in has no tenant file yet.
    const raw = await readOptional(join(this.root, tenantId, 'tenant.json'))
    return raw === undefined ? { version: 1, defaultId: null, seeded: false } : tenantFileSchema.parse(JSON.parse(raw))
  }

  private async readAssistants(tenantId: string): Promise<AssistantView[]> {
    const dir = join(this.root, tenantId)
    const found: AssistantView[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      // A directory without assistant.json is not an assistant, such as one whose creation was interrupted.
      const raw = await readOptional(join(dir, entry.name, 'assistant.json'))
      if (raw === undefined) continue
      const parsed = assistantFileSchema.safeParse(JSON.parse(raw))
      if (!parsed.success || parsed.data.id !== entry.name) {
        this.ctx.logger.warn(`assistants: skipped malformed ${join(dir, entry.name, 'assistant.json')}`)
        continue
      }
      const { version: _version, preset, model, subsets: stored, templateId, ...view } = parsed.data
      const subsets = normalizeSubsets(stored)
      found.push({
        ...view,
        ...(subsets === undefined ? {} : { subsets }),
        ...(preset === undefined ? {} : { preset }),
        ...(model === undefined ? {} : {
          model: {
            provider: model.provider, model: model.model,
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
          },
        }),
        ...(templateId === undefined ? {} : { templateId }),
      })
    }
    return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private createFrom(tenantId: string, template: AssistantTemplate, createdAt: Date): Promise<AssistantView> {
    const subsets = normalizeSubsets(template.subsets)
    return this.writeAssistant(tenantId, {
      id: randomUUID(), name: template.name, description: template.description, avatar: template.avatar,
      ...(subsets === undefined ? {} : { subsets }), templateId: template.id, createdAt: createdAt.toISOString(),
    }, template.files)
  }

  private async writeAssistant(tenantId: string, view: AssistantView, files: CoreFiles): Promise<AssistantView> {
    // Build in a temporary directory and rename, so a crash never leaves a half-written assistant.
    const staging = join(this.root, tenantId, `.${view.id}.tmp`)
    await mkdir(staging, { recursive: true })
    for (const file of CORE_FILE_NAMES) await writeFile(join(staging, file), files[file])
    await this.writeAtomic(join(staging, 'assistant.json'), jsonText({ version: 1, ...view }))
    await rename(staging, join(this.root, tenantId, view.id))
    return view
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    const temporary = `${path}.tmp`
    await writeFile(temporary, text)
    await rename(temporary, path)
  }

  private requireTenant(): string {
    if (this.tenantId === null) throw new RemoteError('hub-account/signed-out', 'Sign in to the user center first', {})
    return this.tenantId
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation)
    this.writes = result.catch(() => undefined)
    return result
  }

  private changed(): void {
    this.revision = Math.max(this.revision + 1, Date.now())
    for (const listener of this.listeners) listener()
  }
}

export default AssistantsService
