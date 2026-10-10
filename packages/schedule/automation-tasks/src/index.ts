/**
 * Automation tasks, Host half: creates a task in one call — a new Session named after the task in
 * the chosen workspace, bound to its assistant, model, permission preset, and connector grant, and
 * the Host schedule that sends the task's instruction to that Session at each run. Any failed step
 * archives the new Session, so a refused task leaves nothing behind.
 *
 * @module @deepseek-ai/dsh-automation-tasks
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-assistants'
import type {} from '@deepseek-ai/dsh-connectors'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { ScheduleInputError, type ScheduleCreateRequest, type ScheduleTimingChange } from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-workspace'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AutomationTaskCreateRequest, AutomationTaskCreateValue } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Creates automation tasks with their Sessions. */
    automationTasks: AutomationTasksService
  }
}

/** The schedule selector of one timing choice. */
function selector(timing: ScheduleTimingChange): Omit<ScheduleCreateRequest, 'prompt' | 'title'> {
  switch (timing.kind) {
    case 'at': return { at: timing.at }
    case 'every': return { every_seconds: timing.every_seconds }
    case 'daily': return { daily: timing.daily }
    case 'weekly': return { weekly: timing.weekly }
    case 'cron': return { cron: timing.cron }
  }
}

/** Host owner of the `automationTasks` Remote namespace. */
export class AutomationTasksService extends TypertRemoteService {
  static inject = ['sessionController', 'schedule', 'workspaceRegistry']

  /** @param ctx - Host with the Session controller, the schedule, and the workspace registry. */
  constructor(ctx: Context) {
    super(ctx, 'automationTasks', { namespace: 'automationTasks' })
  }

  /**
   * Create one automation task: a new Session in the workspace, named after the task, with the
   * requested assistant, model, permission preset, and connector grant, then the schedule bound to
   * it. The assistant, connectors, and permission presets are optional services; asking for one a
   * deployment lacks is `automation-tasks/unavailable`. A step's refusal passes through unchanged,
   * except a Schedule input error, which becomes `automation-tasks/invalid` with its code, and an
   * unavailable model, `automation-tasks/model-unavailable`. Any failure archives the new Session.
   * @param request - the task as the form submits it.
   * @returns the new Session and the stored schedule.
   */
  @Remote('create')
  async create(request: AutomationTaskCreateRequest): Promise<AutomationTaskCreateValue> {
    const assistant = request.assistantId === undefined
      ? undefined
      : { service: this.require('assistants', 'assistant'), id: request.assistantId }
    const grant = request.connectors === undefined || request.connectors.length === 0
      ? undefined
      : { service: this.require('connectors', 'connectors'), ids: request.connectors }
    const permission = request.permission === undefined
      ? undefined
      : { service: this.require('permissionPresets', 'permission'), preset: request.permission }
    const controller = this.ctx.sessionController
    const { sessionId } = await controller.create(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId })
    try {
      await controller.rename({ sessionId, title: request.title })
      const resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      const { agent } = resolved
      if (assistant !== undefined) await assistant.service.select(agent, assistant.id)
      if (request.model !== undefined && !await controller.useModel(agent, request.model)) {
        const { provider, model } = request.model
        throw new RemoteError('automation-tasks/model-unavailable', `the model ${provider}/${model} is not available`, { provider, model })
      }
      if (permission !== undefined) permission.service.set(agent.session, permission.preset)
      if (grant !== undefined) grant.service.allowInSession(agent.session, grant.ids)
      const record = await this.ctx.schedule.create(
        sessionId, { title: request.title, prompt: request.prompt, ...selector(request.timing) }, undefined, request.window,
      )
      return { sessionId, record }
    } catch (error: unknown) {
      await this.ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch((cause: unknown) => {
        this.ctx.logger.warn(`automation-tasks: could not archive the Session of a refused task: ${String(cause)}`)
      })
      if (error instanceof ScheduleInputError) throw new RemoteError('automation-tasks/invalid', error.message, { code: error.code })
      throw error
    }
  }

  /** An optional service the request needs, or `automation-tasks/unavailable`. */
  private require<K extends 'assistants' | 'connectors' | 'permissionPresets'>(
    name: K, field: 'assistant' | 'connectors' | 'permission',
  ): NonNullable<Context[K]> {
    const service = this.ctx.get(name)
    if (service === undefined) throw new RemoteError('automation-tasks/unavailable', `this deployment has no ${field} service`, { field })
    return service
  }
}

export default AutomationTasksService
