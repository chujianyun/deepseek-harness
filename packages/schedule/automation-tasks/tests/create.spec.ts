import { Context } from '@deepseek-ai/cordis'
import { ScheduleInputError } from '@deepseek-ai/dsh-schedule'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AutomationTasksService from '../src/index.ts'
import type { ScheduleTimingChange } from '@deepseek-ai/dsh-schedule'
import type { AutomationTaskCreateRequest } from '../src/types.ts'

const SESSION = SessionId('task-session')
const AGENT = { id: SESSION, session: { id: SESSION } }
const RECORD = { id: 'schedule-1', kind: 'daily', title: '日报', prompt: '导出昨日日报', time: '09:00:00.000', timeZone: 'Asia/Shanghai', scheduledAt: '2026-10-11T01:00:00.000Z' }
const WORKSPACE = 'ws-1' as AutomationTaskCreateRequest['workspaceId']
const BASE: AutomationTaskCreateRequest = {
  title: '日报', prompt: '导出昨日日报', workspaceId: WORKSPACE, timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** The service over recorded fakes; `optional` mounts the assistants and permission presets. */
async function mount(optional = true) {
  const steps: string[] = []
  let created: SessionId | undefined
  const appended: { type: string; data: unknown }[] = []
  const append = (type: string, data: unknown) => { steps.push(type); appended.push({ type, data }) }
  const record = (name: string) => vi.fn(async (..._args: unknown[]) => { steps.push(name) })
  const ctx = new Context()
  contexts.push(ctx)
  const controller = {
    create: vi.fn(async (request: { sessionId: SessionId }) => { steps.push('create'); created = request.sessionId; return { sessionId: request.sessionId } }),
    rename: record('rename'),
    resolveAgent: vi.fn(async (_id: SessionId): Promise<{ agent: typeof AGENT } | { error: Error }> => {
      steps.push('resolve')
      return { agent: { ...AGENT, id: created!, session: { id: created!, append } as typeof AGENT['session'] } }
    }),
    useModel: vi.fn(async (_agent: object, _model: object) => { steps.push('model'); return true }),
  }
  const schedule = {
    create: vi.fn(async (..._args: unknown[]) => { steps.push('schedule'); return RECORD }),
    validate: vi.fn((..._args: unknown[]) => { steps.push('validate') }),
  }
  const workspaceRegistry = { archiveSession: record('archive') }
  const assistants = { select: record('assistant') }
  const permissionPresets = {
    set: vi.fn((..._args: unknown[]) => { steps.push('permission') }),
    catalog: () => ({ options: [{ value: 'workspace-write' }, { value: 'full-access' }, { value: 'custom' }] }),
  }
  ctx.provide('sessionController', controller as never)
  ctx.provide('schedule', schedule as never)
  ctx.provide('workspaceRegistry', workspaceRegistry as never)
  ctx.provide('sessionProjections', { register: vi.fn(), stateOf: () => undefined } as never)
  if (optional) {
    ctx.provide('assistants', assistants as never)
    ctx.provide('permissionPresets', permissionPresets as never)
  }
  const warn = vi.spyOn(ctx.logger, 'warn')
  await ctx.plugin(AutomationTasksService).await()
  return {
    service: ctx.get('automationTasks')!, steps, appended, controller, schedule, workspaceRegistry, assistants, permissionPresets, warn,
    session: () => created!,
  }
}

describe('creating an automation task', () => {
  it('names a new Session after the task, binds everything the form chose, then schedules it', async () => {
    const m = await mount()
    const result = await m.service.create({
      ...BASE, assistantId: 'a-shop', model: { provider: 'deepseek', model: 'v4' },
      permission: 'full-access', window: { start: '2026-10-11', end: '', time_zone: 'Asia/Shanghai' },
      operations: [' lark-cli   im +messages-send ', 'dsh-ecommerce browser', 'lark-cli im +messages-send', ''],
    })
    const sessionId = m.session()
    const agent = { ...AGENT, id: sessionId, session: expect.objectContaining({ id: sessionId }) as object }
    expect(result).toEqual({ sessionId, record: RECORD })
    expect(m.steps).toEqual(['validate', 'create', 'rename', 'resolve', 'assistant', 'model', 'permission', 'automation-tasks/operations', 'schedule'])
    // The declaration is read: trimmed, one space between words, without blanks and repeats.
    expect(m.appended).toEqual([{ type: 'automation-tasks/operations', data: { operations: ['lark-cli im +messages-send', 'dsh-ecommerce browser'] } }])
    expect(m.controller.create).toHaveBeenCalledWith({ sessionId, workspaceId: WORKSPACE })
    expect(m.controller.rename).toHaveBeenCalledWith({ sessionId, title: '日报' })
    expect(m.assistants.select).toHaveBeenCalledWith(agent, 'a-shop')
    expect(m.controller.useModel).toHaveBeenCalledWith(agent, { provider: 'deepseek', model: 'v4' })
    expect(m.permissionPresets.set).toHaveBeenCalledWith(agent.session, 'full-access')
    expect(m.schedule.create).toHaveBeenCalledWith(sessionId, {
      title: '日报', prompt: '导出昨日日报', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' },
    }, undefined, { start: '2026-10-11', end: '', time_zone: 'Asia/Shanghai' })
  })

  const timings: [ScheduleTimingChange, object][] = [
    [{ kind: 'at', at: '2026-10-12T01:00:00Z' }, { at: '2026-10-12T01:00:00Z' }],
    [{ kind: 'every', every_seconds: 3600 }, { every_seconds: 3600 }],
    [{ kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1, 5] } }, { weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1, 5] } }],
    [{ kind: 'cron', cron: { expression: '0 9 * * 1-5', time_zone: 'UTC' } }, { cron: { expression: '0 9 * * 1-5', time_zone: 'UTC' } }],
  ]
  it.each(timings)('passes the %j timing to the schedule, and only what the form chose', async (timing, selector) => {
    const m = await mount()
    await m.service.create({ ...BASE, timing, operations: [] })
    expect(m.steps).toEqual(['validate', 'create', 'rename', 'resolve', 'schedule'])
    expect(m.schedule.create).toHaveBeenCalledWith(m.session(), { title: '日报', prompt: '导出昨日日报', ...selector }, undefined, undefined)
  })

  it.each([
    [{ assistantId: 'a-shop' }, 'assistant'],
    [{ permission: 'full-access' }, 'permission'],
  ] as const)('refuses %j without that service, before creating a Session', async (extra, field) => {
    const m = await mount(false)
    await expect(m.service.create({ ...BASE, ...extra })).rejects.toMatchObject({ code: 'automation-tasks/unavailable', details: { field } })
    expect(m.steps).toEqual([])
  })
})

describe('a refused task', () => {
  it('refuses a form the schedule rejects, or an unknown permission preset, before any Session exists', async () => {
    const m = await mount()
    m.schedule.validate.mockImplementationOnce(() => {
      throw new ScheduleInputError('invalid_rule', 'No occurrence of this rule falls within the effective dates.')
    })
    await expect(m.service.create(BASE)).rejects.toMatchObject({
      code: 'automation-tasks/invalid', message: 'No occurrence of this rule falls within the effective dates.', details: { code: 'invalid_rule' },
    })
    const operations: [string[], string][] = [
      [Array.from({ length: 51 }, (_, index) => `cli${String(index)} x`), 'too_many'],
      [['lark-cli'], 'not_declarable'],
      [[`lark-cli ${'x'.repeat(200)}`], 'too_long'],
      [['lark-cli im +messages-send; rm -rf ~'], 'shell_character'],
    ]
    for (const [declared, code] of operations) {
      await expect(m.service.create({ ...BASE, operations: declared })).rejects.toMatchObject({ code: 'automation-tasks/invalid', details: { code } })
    }
    for (const preset of ['custom', 'gone']) {
      await expect(m.service.create({ ...BASE, permission: preset })).rejects.toMatchObject({
        code: 'automation-tasks/invalid', details: { code: 'unknown_permission' },
      })
    }
    expect(m.steps).toEqual([])
    m.schedule.validate.mockImplementationOnce(() => { throw new Error('clock unreadable') })
    await expect(m.service.create(BASE)).rejects.toThrow('clock unreadable')
  })

  it('archives the new Session and passes a step\'s refusal through', async () => {
    const m = await mount()
    m.assistants.select.mockRejectedValueOnce(new RemoteError('assistants/not-found', 'gone', { assistantId: 'a-x' }))
    await expect(m.service.create({ ...BASE, assistantId: 'a-x' })).rejects.toMatchObject({ code: 'assistants/not-found' })
    expect(m.steps).toEqual(['validate', 'create', 'rename', 'resolve', 'archive'])
    expect(m.workspaceRegistry.archiveSession).toHaveBeenCalledWith(m.session(), { stopActivity: true })
  })

  it('archives a Session whose creation failed after it existed, by the id it chose', async () => {
    const m = await mount()
    m.controller.create.mockImplementationOnce(async () => { throw new RemoteError('session/workspace-attach-failed', 'attach failed', { sessionId: SESSION, workspaceId: 'ws-1' }) })
    await expect(m.service.create(BASE)).rejects.toMatchObject({ code: 'session/workspace-attach-failed' })
    const [[archived]] = m.workspaceRegistry.archiveSession.mock.calls as [[SessionId]]
    expect(archived).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('names a schedule refusal at creation by its code', async () => {
    const m = await mount()
    m.schedule.create.mockRejectedValueOnce(new ScheduleInputError('subagent_session', 'no delivery'))
    await expect(m.service.create(BASE)).rejects.toMatchObject({ code: 'automation-tasks/invalid', details: { code: 'subagent_session' } })
    expect(m.steps.at(-1)).toBe('archive')
  })

  it('refuses a model that is not available', async () => {
    const m = await mount()
    m.controller.useModel.mockResolvedValueOnce(false)
    await expect(m.service.create({ ...BASE, model: { provider: 'acme', model: 'gone' } })).rejects.toMatchObject({
      code: 'automation-tasks/model-unavailable', details: { provider: 'acme', model: 'gone' },
    })
    expect(m.steps.at(-1)).toBe('archive')
  })

  it('refuses a Session that cannot be resumed', async () => {
    const m = await mount()
    m.controller.resolveAgent.mockResolvedValueOnce({ error: new Error('cannot resume') })
    await expect(m.service.create(BASE)).rejects.toThrow('cannot resume')
    expect(m.steps).toEqual(['validate', 'create', 'rename', 'archive'])
  })

  it('logs a failed archive and still reports the refusal', async () => {
    const m = await mount()
    m.schedule.create.mockRejectedValueOnce(new Error('disk full'))
    m.workspaceRegistry.archiveSession.mockRejectedValueOnce(new Error('registry closed'))
    await expect(m.service.create(BASE)).rejects.toThrow('disk full')
    expect(m.warn).toHaveBeenCalledWith('automation-tasks: could not archive the Session of a refused task: Error: registry closed')
  })
})
