import { describe, expect, it } from 'vitest'
import { initialValues, refusalProblem, toRequest, type TaskFormValues } from '../src/client/form-model.ts'

const ZONE = 'Asia/Shanghai'
const base = (patch: Partial<TaskFormValues> = {}): TaskFormValues => ({
  ...initialValues({ workspaceId: 'ws-1', permission: 'workspace-write', time: '09:00', date: '2026-10-11' }),
  title: ' 店铺日报 ', prompt: ' 导出昨日日报 ', ...patch,
})

describe('building the request', () => {
  it('reads a daily task, trimming the text, in the browser zone', () => {
    expect(toRequest(base(), ZONE)).toEqual({ request: {
      title: '店铺日报', prompt: '导出昨日日报', workspaceId: 'ws-1', permission: 'workspace-write',
      timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: ZONE } },
    } })
  })

  it.each([
    [{ repeat: 'weekdays' as const }, { kind: 'weekly', weekly: { time: '09:00:00', time_zone: ZONE, weekdays: [1, 2, 3, 4, 5] } }],
    [{ repeat: 'weekly' as const, weekdays: [5, 1] }, { kind: 'weekly', weekly: { time: '09:00:00', time_zone: ZONE, weekdays: [1, 5] } }],
    [{ mode: 'interval' as const, interval: '30', unit: 'minutes' as const }, { kind: 'every', every_seconds: 1800 }],
    [{ mode: 'interval' as const, interval: '2', unit: 'hours' as const }, { kind: 'every', every_seconds: 7200 }],
    [{ mode: 'once' as const, date: '2026-10-12', time: '18:30' }, { kind: 'at', at: { date: '2026-10-12', time: '18:30:00', time_zone: ZONE } }],
  ])('reads %j', (patch, timing) => {
    expect(toRequest(base(patch), ZONE)).toMatchObject({ request: { timing } })
  })

  it('carries the assistant, model, connectors, and effective dates only when chosen', () => {
    const built = toRequest(base({
      assistantId: 'a-shop', model: JSON.stringify(['deepseek', 'v4']), permission: '', connectors: ['feishu'], start: '2026-10-11', end: '2026-12-31',
    }), ZONE)
    expect(built).toMatchObject({ request: {
      assistantId: 'a-shop', model: { provider: 'deepseek', model: 'v4' }, connectors: ['feishu'],
      window: { start: '2026-10-11', end: '2026-12-31', time_zone: ZONE },
    } })
    expect(built).not.toHaveProperty('request.permission')
    expect(toRequest(base({ end: '2026-12-31' }), ZONE)).toMatchObject({ request: { window: { end: '2026-12-31', time_zone: ZONE } } })
    expect(toRequest(base({ start: '2026-10-11' }), ZONE)).toMatchObject({ request: { window: { start: '2026-10-11', time_zone: ZONE } } })
  })

  it.each([
    [{ title: '  ' }, 'title', 'error.titleRequired'],
    [{ title: 'x'.repeat(121) }, 'title', 'error.titleTooLong'],
    [{ workspaceId: '' }, 'workspace', 'error.workspaceRequired'],
    [{ prompt: '' }, 'prompt', 'error.promptRequired'],
    [{ mode: 'interval' as const, interval: '0' }, 'frequency', 'error.intervalInvalid'],
    [{ mode: 'interval' as const, interval: '1.5' }, 'frequency', 'error.intervalInvalid'],
    [{ time: '' }, 'frequency', 'error.timeRequired'],
    [{ mode: 'once' as const, date: '' }, 'frequency', 'error.dateRequired'],
    [{ repeat: 'weekly' as const, weekdays: [] }, 'frequency', 'error.weekdaysRequired'],
    [{ start: '2026-12-31', end: '2026-10-11' }, 'window', 'error.windowOrder'],
  ])('refuses %j', (patch, field, key) => {
    expect(toRequest(base(patch), ZONE)).toEqual({ problems: [{ field, key }] })
  })
})

describe('explaining a refused save', () => {
  it.each([
    [{ code: 'automation-tasks/invalid', message: '', details: { code: 'invalid_prompt' } }, 'prompt', 'error.promptInvalid'],
    [{ code: 'automation-tasks/invalid', message: '', details: { code: 'not_future' } }, 'frequency', 'error.notFuture'],
    [{ code: 'automation-tasks/invalid', message: '', details: { code: 'frequency_too_high' } }, 'frequency', 'error.intervalInvalid'],
    [{ code: 'automation-tasks/invalid', message: '', details: { code: 'unknown_permission' } }, 'prompt', 'error.permissionUnknown'],
    [{ code: 'automation-tasks/invalid', message: '', details: { code: 'invalid_rule' } }, 'frequency', 'error.outsideWindow'],
    [{ code: 'automation-tasks/invalid', message: '' }, 'frequency', 'error.outsideWindow'],
    [{ code: 'automation-tasks/model-unavailable', message: '' }, 'prompt', 'error.modelUnavailable'],
    [{ code: 'assistants/not-found', message: '' }, 'prompt', 'error.assistantGone'],
    [{ code: 'hub-account/signed-out', message: 'sign in' }, 'window', 'error.unknown'],
  ])('shows %j', (refusal, field, key) => {
    expect(refusalProblem(refusal)).toEqual({ field, key })
  })
})
