/**
 * Assistants for Desktop, behind one Host service and the `assistants` Remote namespace. An
 * assistant is a named role with its own core files, kept per tenant of the current Hub sign-in
 * under `<dshHome>/assistants/<tenantId>/<assistantId>/`: `assistant.json` and the Markdown core
 * files. The tenant's `tenant.json` records its default assistant and that its first assistant
 * was created; the first time a tenant signs in, the service creates one from the Daily Assistant
 * template and makes it the default, and never again after the user deletes it.
 *
 * A main session binds one assistant while it is blank: a new session takes the tenant's default,
 * and the user may pick another before the first turn. Before each turn step the service reads the
 * bound assistant's core files and records them with `assistant/instructions` whenever they
 * differ from the previous record; the `assistant:core-files` prompt section carries the recorded
 * text, so an edit reaches the model on the next turn and every prompt stays reconstructable from
 * the session log.
 *
 * @module @deepseek-ai/dsh-assistants
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-hub-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { CORE_FILE_NAMES, DAILY_ASSISTANT, type AssistantTemplate } from './templates.ts'
import type { AssistantProjectionState, AssistantsState, AssistantView } from './types.ts'

export type * from './types.ts'
export { CORE_FILE_NAMES, DAILY_ASSISTANT, TEMPLATES, type AssistantTemplate, type CoreFiles } from './templates.ts'

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
}

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  dshHome: Schema.string().description('DeepSeek Harness home; assistants live under `<dshHome>/assistants`. Defaults to `$DSH_HOME` or `~/.dsh`.'),
})

/** Name of the prompt section that carries the bound assistant's core files. */
export const ASSISTANT_SECTION = 'assistant:core-files'

const avatarSchema = z.object({ kind: z.literal('preset'), key: z.string().min(1) })

const assistantFileSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  avatar: avatarSchema,
  preset: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  createdAt: z.string(),
})

const tenantFileSchema = z.object({
  version: z.literal(1),
  defaultId: z.string().nullable(),
  seeded: z.boolean(),
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
    if (event.type === 'assistant/selected') return { ...state, assistantId: event.data.assistantId }
    if (event.type === 'assistant/instructions') return { ...state, instructions: event.data.text }
    return state
  },
  wire: { viewSchema: projectionViewSchema, view: state => state.assistantId },
  stateVersion: 1,
} satisfies ProjectionDefinition<'assistant', AssistantProjectionState>

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
    `You are the assistant "${name}". The user wrote the core files below to define your identity, personality, what you know about them, and how you work. Follow them in this session.`,
    ...blocks,
  ].join('\n\n')
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

/** Host owner of the assistants and of the `assistants` Remote namespace. */
export class AssistantsService extends TypertRemoteService {
  static inject = ['hubAccount', 'sessionProjections', 'agents']
  static Config = Config

  private readonly root: string
  private tenantId: string | null = null
  private tenant: TenantFile = { version: 1, defaultId: null, seeded: false }
  private list: AssistantView[] = []
  private writes: Promise<unknown> = Promise.resolve()
  private revision = Date.now()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host with the Hub sign-in, session projections, and agents. @param config - storage options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'assistants', { namespace: 'assistants' })
    this.root = join(resolveDshHome(Config(config).dshHome), 'assistants')
    ctx.sessionProjections.register(assistantProjectionDefinition)
    ctx.effect(() => () => {
      this.lifetime.abort()
      this.changed()
    }, 'assistants: lifetime')
    for (const agent of ctx.agents.list()) {
      if (agent.session.header.parentSession === undefined) this.installPrompt(agent)
    }
    ctx.on('agent/created', async ({ agent }) => {
      if (agent.session.header.parentSession !== undefined) return
      this.installPrompt(agent)
      // A blank session without an assistant takes the default, whether new or resumed before its first turn.
      // Checked inside the queue, so a pick that reached select() first is never overwritten.
      await this.serialized(async () => {
        if (!this.isBlank(agent) || this.boundId(agent) !== null) return
        const fallback = this.list.find(item => item.id === this.tenant.defaultId)
        if (fallback !== undefined) await this.bind(agent, fallback)
      })
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
    return Promise.resolve({ revision: this.revision, tenantId: this.tenantId, defaultId: this.tenant.defaultId, assistants: this.list })
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
   * Bind a blank session to one of the signed-in tenant's assistants.
   * @param agent - the session's Agent.
   * @param assistantId - the assistant to bind.
   * @returns the bound assistant id.
   * @throws RemoteError `hub-account/signed-out`, `assistants/not-found`, or `assistants/locked` once the session started.
   */
  @Remote('select')
  select(agent: Agent, assistantId: string): Promise<string> {
    return this.serialized(async () => {
      this.requireTenant()
      const assistant = this.list.find(item => item.id === assistantId)
      if (assistant === undefined) throw new RemoteError('assistants/not-found', 'This assistant no longer exists', { assistantId })
      if (!this.isBlank(agent)) throw new RemoteError('assistants/locked', 'This session has already started', { sessionId: agent.id, assistantId })
      if (this.boundId(agent) !== assistantId) await this.bind(agent, assistant)
      return assistantId
    })
  }

  private async bind(agent: Agent, assistant: AssistantView): Promise<void> {
    const presets = this.ctx.get('agentPresets')
    if (assistant.preset !== undefined && presets !== undefined) await presets.select(agent, assistant.preset)
    agent.session.append('assistant/selected', { assistantId: assistant.id })
  }

  private boundId(agent: Agent): string | null {
    return this.ctx.sessionProjections.stateOf(agent.session, 'assistant')?.assistantId ?? null
  }

  private isBlank(agent: Agent): boolean {
    const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    return boundary === undefined || (boundary.openTurnStartSeq === null && boundary.lastTurn === 0)
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
        const text = await this.instructionsFor(assistantId)
        if (text !== (state?.instructions ?? null)) agent.session.append('assistant/instructions', { text })
        assembly.sections = assembly.sections.map(section => section.name === ASSISTANT_SECTION ? { ...section, text } : section)
        return next()
      })
    })
  }

  private async instructionsFor(assistantId: string): Promise<string> {
    const assistant = this.list.find(item => item.id === assistantId)
    if (assistant === undefined || this.tenantId === null) return ''
    const dir = join(this.root, this.tenantId, assistant.id)
    // A missing core file contributes nothing; the user may have deleted it on disk.
    const files = await Promise.all(CORE_FILE_NAMES.map(async file => [file, await readOptional(join(dir, file)) ?? ''] as const))
    return renderInstructions(assistant.name, files)
  }

  private async switchTenant(tenantId: string | null): Promise<void> {
    this.tenantId = tenantId
    this.tenant = { version: 1, defaultId: null, seeded: false }
    this.list = []
    if (tenantId !== null) {
      await mkdir(join(this.root, tenantId), { recursive: true })
      this.tenant = await this.readTenant(tenantId)
      this.list = await this.readAssistants(tenantId)
      if (!this.tenant.seeded) {
        const created = await this.createFrom(tenantId, DAILY_ASSISTANT)
        this.list = [...this.list, created]
        this.tenant = { version: 1, defaultId: created.id, seeded: true }
        await this.writeJson(join(this.root, tenantId, 'tenant.json'), this.tenant)
      }
    }
    this.changed()
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
      const { version: _version, preset, templateId, ...view } = parsed.data
      found.push({ ...view, ...(preset === undefined ? {} : { preset }), ...(templateId === undefined ? {} : { templateId }) })
    }
    return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private async createFrom(tenantId: string, template: AssistantTemplate): Promise<AssistantView> {
    const id = randomUUID()
    const view: AssistantView = {
      id, name: template.name, description: template.description, avatar: template.avatar,
      templateId: template.id, createdAt: new Date().toISOString(),
    }
    // Build in a temporary directory and rename, so a crash never leaves a half-written assistant.
    const staging = join(this.root, tenantId, `.${id}.tmp`)
    await mkdir(staging, { recursive: true })
    for (const file of CORE_FILE_NAMES) await writeFile(join(staging, file), template.files[file])
    await this.writeJson(join(staging, 'assistant.json'), { version: 1, ...view })
    await rename(staging, join(this.root, tenantId, id))
    return view
  }

  private async writeJson(path: string, value: object): Promise<void> {
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
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
