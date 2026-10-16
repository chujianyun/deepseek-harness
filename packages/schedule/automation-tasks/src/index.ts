/**
 * Automation tasks, Host half: creates a task in one call — a new Session named after the task in
 * the chosen workspace, bound to its assistant, model, permission preset, and declared operations,
 * and the Host schedule that sends the task's instruction to that Session at each run. Any failed step
 * archives the new Session, so a refused task leaves nothing behind. In a run the schedule starts,
 * nobody answers approvals: a call that would ask runs when it is a declared operation and is refused
 * otherwise, and each answer is recorded in the Session log.
 *
 * @module @deepseek-ai/dsh-automation-tasks
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-assistants'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { randomUUID } from 'node:crypto'
import { ScheduleInputError, timingRequest, type ScheduleCreateRequest } from '@deepseek-ai/dsh-schedule'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-workspace'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { readOperations, type OperationProblem } from './operations.ts'
import type { AutomationTaskCreateRequest, AutomationTaskCreateValue } from './types.ts'
import { declaredOperations, recordedCommand, unattendedProjection, type ShellDialect, type UnattendedState } from './unattended.ts'

export type * from './types.ts'
export { declarable, OPERATION_MAX_CHARS, OPERATIONS_MAX, readOperations, RUNNERS, type OperationProblem } from './operations.ts'
export { declaredOperations, readCommand, unattendedProjection, type ShellDialect, type SimpleCommand, type UnattendedState, type Word } from './unattended.ts'

/** The model shell tools by name, with the shell their commands are written for. */
const SHELL_TOOLS: Readonly<Record<string, ShellDialect>> = { bash: 'bash', pwsh: 'pwsh' }

/** A shell call's command and shell. */
interface ShellCall {
  readonly command: string
  readonly dialect: ShellDialect
}

/** The command of a model shell call, or undefined for another tool. */
function shellCall(exec: Pick<ToolExecution, 'name' | 'arguments'>): ShellCall | undefined {
  const command = (exec.arguments as { command?: unknown }).command
  const dialect = Object.hasOwn(SHELL_TOOLS, exec.name) ? SHELL_TOOLS[exec.name] : undefined
  return dialect !== undefined && typeof command === 'string' ? { command, dialect } : undefined
}

/** Why a declaration is refused, for the caller. */
function operationRefusal(problem: OperationProblem): string {
  switch (problem.code) {
    case 'too_many': return `a task declares at most ${String(problem.max)} operations`
    case 'too_long': return `the operation "${problem.operation}" is longer than ${String(problem.max)} characters`
    case 'shell_character': return `the operation "${problem.operation}" holds a shell character`
    case 'not_declarable': return `the operation "${problem.operation}" needs a program and a command, and the program cannot be one that runs other commands`
    /* v8 ignore next -- every problem code is a case above. */
    default: return assertNever(problem)
  }
}

/**
 * What the model reads when a scheduled run refuses a call.
 * @param operations - the task's declared operations.
 * @returns the refusal.
 */
function refusal(operations: readonly string[]): string {
  const declared = operations.length === 0 ? 'it declares none' : `it declares: ${operations.join('; ')}`
  return 'This run of the automation task is unattended: nobody can approve this call, and it is not one of the operations '
    + `the task may run without asking (${declared}), so it was not run. Run each declared operation as a command of its own, `
    + 'or report that this step needs a person.'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Creates automation tasks with their Sessions. */
    automationTasks: AutomationTasksService
  }
}

/** Host owner of the `automationTasks` Remote namespace. */
export class AutomationTasksService extends TypertRemoteService {
  static inject = ['sessionController', 'schedule', 'workspaceRegistry', 'sessionProjections']

  /** The shell command of each call in a scheduled run, kept until its result, for an approval it asks later. */
  private readonly shellCalls = new Map<ToolCallId, ShellCall>()

  /** @param ctx - Host with the Session controller, the schedule, the workspace registry, and Session projections. */
  constructor(ctx: Context) {
    super(ctx, 'automationTasks', { namespace: 'automationTasks' })
    ctx.sessionProjections.register(unattendedProjection)
    // Outermost, so it sees the decision every other gate reached: in a scheduled run an ask is answered here.
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      const agent = exec.agent
      if (agent === undefined) return decision
      const state = this.unattendedOf(agent.session)
      if (state.scheduledTurn === null) return decision
      if (decision.kind === 'deny' || decision.kind === 'cancel') return decision
      const shell = shellCall(exec)
      if (decision.kind === 'ask' && !this.answer(agent.session, state.scheduledTurn, exec.callId, exec.name, shell, state.operations, true)) {
        return { kind: 'deny', reason: refusal(state.operations) }
      }
      // Kept only for a call that runs: it may still ask to run outside the sandbox.
      if (shell !== undefined) this.shellCalls.set(exec.callId, shell)
      return decision.kind === 'ask' ? { kind: 'allow' } : decision
    }, { prepend: true })
    // An approval asked outside the tool gate, such as running a command outside the sandbox: the same answer, stricter.
    ctx.on('approval/request', (request, next) => {
      const state = this.unattendedOf(request.agent.session)
      if (state.scheduledTurn === null) return next()
      const shell = request.callId === undefined ? undefined : this.shellCalls.get(request.callId)
      const allowed = request.callId !== undefined
        && this.answer(request.agent.session, state.scheduledTurn, request.callId, request.toolName, shell, state.operations, false)
      return Promise.resolve(allowed ? 'allowed-once' : 'rejected')
    }, { prepend: true })
    ctx.on('tools/result', (exec) => { this.shellCalls.delete(exec.callId) })
  }

  /**
   * Answer a call in a scheduled run and record the answer: allowed when it is a shell command whose
   * every command is a declared operation.
   * @returns whether the call may run.
   */
  private answer(
    session: Session, turn: number, callId: ToolCallId, toolName: string,
    shell: ShellCall | undefined, operations: readonly string[], sandboxed: boolean,
  ): boolean {
    const matched = shell === undefined ? undefined : declaredOperations(shell.command, shell.dialect, operations, sandboxed)
    session.append('automation-tasks/unattended', {
      callId, turn, command: recordedCommand(shell?.command ?? toolName), allowed: matched !== undefined, operations: [...new Set(matched)],
    })
    return matched !== undefined
  }

  private unattendedOf(session: Session): UnattendedState {
    /* v8 ignore next -- this service registers the projection, so its state is always there. */
    return this.ctx.sessionProjections.stateOf(session, 'automationUnattended') ?? { operations: [], openTurn: null, personWrote: false, scheduledTurn: null }
  }

  /**
   * Create one automation task: a new Session in the workspace, named after the task, with the
   * requested assistant, model, permission preset, and declared operations
   * (`automation-tasks/operations`), then the schedule bound to it. The assistant and permission
   * presets are optional services; asking for one a deployment lacks is
   * `automation-tasks/unavailable`. A step's refusal passes through unchanged,
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
    const permission = request.permission === undefined
      ? undefined
      : { service: this.require('permissionPresets', 'permission'), preset: request.permission }
    // Everything checkable without a Session is checked first, so a refused form leaves nothing behind.
    if (permission !== undefined && !permission.service.catalog().options.some(option => option.value === permission.preset && option.value !== 'custom')) {
      throw new RemoteError('automation-tasks/invalid', `there is no permission preset ${permission.preset}`, { code: 'unknown_permission' })
    }
    const declared = readOperations(request.operations ?? [])
    if ('problem' in declared) {
      const { problem } = declared
      throw new RemoteError('automation-tasks/invalid', operationRefusal(problem), { code: problem.code })
    }
    const scheduled: ScheduleCreateRequest = { title: request.title, prompt: request.prompt, ...timingRequest(request.timing) }
    try {
      this.ctx.schedule.validate(scheduled, request.window)
    } catch (error: unknown) {
      throw this.refusal(error)
    }
    const controller = this.ctx.sessionController
    // The id is chosen here so a Session whose creation fails after it exists is still archived.
    const sessionId = SessionId(randomUUID())
    try {
      await controller.create({ sessionId, workspaceId: request.workspaceId })
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
      if (declared.operations.length > 0) agent.session.append('automation-tasks/operations', { operations: declared.operations })
      const record = await this.ctx.schedule.create(sessionId, scheduled, undefined, request.window)
      return { sessionId, record }
    } catch (error: unknown) {
      await this.ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch((cause: unknown) => {
        this.ctx.logger.warn(`automation-tasks: could not archive the Session of a refused task: ${String(cause)}`)
      })
      throw this.refusal(error)
    }
  }

  /** A Schedule input error as `automation-tasks/invalid`; any other error unchanged. */
  private refusal(error: unknown): unknown {
    return error instanceof ScheduleInputError ? new RemoteError('automation-tasks/invalid', error.message, { code: error.code }) : error
  }

  /** An optional service the request needs, or `automation-tasks/unavailable`. */
  private require<K extends 'assistants' | 'permissionPresets'>(
    name: K, field: 'assistant' | 'permission',
  ): NonNullable<Context[K]> {
    const service = this.ctx.get(name)
    if (service === undefined) throw new RemoteError('automation-tasks/unavailable', `this deployment has no ${field} service`, { field })
    return service
  }
}

export default AutomationTasksService
