import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalizeTimeZone, createAtScheduleRecord, createDailyScheduleRecord, parseWindowInput, placeInWindow, requireInWindow,
  ScheduleId, ScheduleInputError, windowClosesAt, windowOpensAt,
} from '../src/domain.ts'
import { ScheduleRuntime } from '../src/runtime.ts'
import { scheduleTaskSchema, type ScheduleTask } from '../src/storage.ts'
import type { ScheduleWindow } from '../src/types.ts'
import { agentFor, harness } from './harness.ts'

const SHANGHAI = 'Asia/Shanghai'
/** Daily 23:00 Shanghai created on 2026-09-16 08:00 local: first target 2026-09-16 23:00 local. */
const daily = (now = '2026-09-16T00:00:00.000Z') =>
  createDailyScheduleRecord(ScheduleId('daily'), 'Report', { time: '23:00:00', time_zone: SHANGHAI }, Date.parse(now), 'Report')
const window = (start?: string, end?: string): ScheduleWindow =>
  ({ ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }), timeZone: SHANGHAI })

afterEach(() => { vi.useRealTimers() })

describe('effective dates input', () => {
  it('reads empty dates as no window, and canonicalizes the dates and the zone', () => {
    expect(parseWindowInput({ start: '', end: '', time_zone: SHANGHAI })).toBeUndefined()
    expect(parseWindowInput({ time_zone: SHANGHAI })).toBeUndefined()
    expect(parseWindowInput({ start: '2026-09-20', time_zone: 'Asia/Shanghai' })).toEqual({ start: '2026-09-20', timeZone: SHANGHAI })
    expect(parseWindowInput({ end: '2026-09-20', time_zone: 'US/Eastern' }))
      .toEqual({ end: '2026-09-20', timeZone: canonicalizeTimeZone('US/Eastern') })
    expect(parseWindowInput({ start: '2026-09-20', end: '2026-09-20', time_zone: 'UTC' }))
      .toEqual({ start: '2026-09-20', end: '2026-09-20', timeZone: 'UTC' })
  })

  it.each([
    [{ start: '2026-9-20', time_zone: SHANGHAI }, 'window.start must be a date YYYY-MM-DD.'],
    [{ end: '2026-02-30', time_zone: SHANGHAI }, 'window.end must be a real calendar date.'],
    [{ start: '2026-09-21', end: '2026-09-20', time_zone: SHANGHAI }, 'window.end must not be before window.start.'],
  ])('refuses %j', (input, message) => {
    expect(() => parseWindowInput(input)).toThrow(new ScheduleInputError('invalid_rule', message))
  })

  it('refuses an unknown zone', () => {
    expect(() => parseWindowInput({ start: '2026-09-21', time_zone: 'Mars/Base' })).toThrow(expect.objectContaining({ code: 'invalid_time_zone' }))
  })

  it('opens at the start date\'s midnight and closes at the midnight after the end date, in the window\'s zone', () => {
    expect(windowOpensAt(window('2026-09-20'))).toBe(Date.parse('2026-09-19T16:00:00.000Z'))
    expect(windowClosesAt(window(undefined, '2026-09-20'))).toBe(Date.parse('2026-09-20T16:00:00.000Z'))
    expect(windowOpensAt(window(undefined, '2026-09-20'))).toBeUndefined()
    expect(windowClosesAt(window('2026-09-20'))).toBeUndefined()
  })
})

describe('placing a rule in its window', () => {
  it('skips a recurring rule\'s occurrences before the start date and keeps one already inside', () => {
    expect(placeInWindow(daily(), window('2026-09-20'))?.scheduledAt).toBe('2026-09-20T15:00:00.000Z')
    expect(placeInWindow(daily(), window('2026-09-16', '2026-09-16'))).toEqual(daily())
    const record = daily()
    expect(requireInWindow(record, undefined)).toBe(record)
  })

  it('finds no occurrence for a one-shot before the start date or any rule after the end date', () => {
    const at = createAtScheduleRecord(ScheduleId('once'), 'Once', '2026-09-18T01:00:00.000Z', Date.parse('2026-09-16T00:00:00.000Z'), 'Once')
    expect(placeInWindow(at, window('2026-09-20'))).toBeUndefined()
    expect(placeInWindow(at, window('2026-09-18', '2026-09-18'))).toEqual(at)
    expect(placeInWindow(daily(), window(undefined, '2026-09-15'))).toBeUndefined()
    expect(() => requireInWindow(at, window('2026-09-20')))
      .toThrow(new ScheduleInputError('invalid_rule', 'No occurrence of this rule falls within the effective dates.'))
  })
})

describe('stored effective dates', () => {
  const base = { sessionId: 's1', record: daily(), status: 'active' }

  it('reads a task without a window, and one with a start or an end date', () => {
    expect(scheduleTaskSchema.parse(base).window).toBeUndefined()
    expect(scheduleTaskSchema.parse({ ...base, window: { start: '2026-09-20', timeZone: SHANGHAI } }).window)
      .toEqual({ start: '2026-09-20', timeZone: SHANGHAI })
    expect(scheduleTaskSchema.parse({ ...base, window: { end: '2026-09-20', timeZone: SHANGHAI } }).window)
      .toEqual({ end: '2026-09-20', timeZone: SHANGHAI })
  })

  it.each([
    { timeZone: SHANGHAI },
    { start: '2026-09-21', end: '2026-09-20', timeZone: SHANGHAI },
    { start: '20260921', timeZone: SHANGHAI },
    { start: '2026-09-21', timeZone: SHANGHAI, extra: true },
  ])('refuses a malformed window %j', (value) => {
    expect(scheduleTaskSchema.safeParse({ ...base, window: value }).success).toBe(false)
  })
})

describe('the service', () => {
  it('stores and lists the window, starting at the first occurrence inside it, and refuses a rule outside it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'))
    const { service, fiber } = await harness()
    try {
      const sessionId = SessionId('owner')
      const request = { title: 'Report', prompt: 'Report', daily: { time: '23:00:00', time_zone: SHANGHAI } }
      const record = await service.create(sessionId, request, undefined, { start: '2026-09-20', end: '', time_zone: SHANGHAI })
      expect(record.scheduledAt).toBe('2026-09-20T15:00:00.000Z')
      const [entry] = await service.catalog()
      expect(entry).toMatchObject({ id: record.id, window: { start: '2026-09-20', timeZone: SHANGHAI } })
      await expect(service.create(sessionId, request, undefined, { end: '2026-09-15', time_zone: SHANGHAI }))
        .rejects.toThrow('No occurrence of this rule falls within the effective dates.')
      // A plain create has no window.
      const plain = await service.create(sessionId, request)
      expect((await service.catalog()).find(item => item.id === plain.id)?.window).toBeUndefined()
      // Retiming keeps the window: the new time also starts on the start date.
      const result = await service.update({
        sessionId, id: record.id, expected: record, change: { kind: 'daily', daily: { time: '08:00:00', time_zone: SHANGHAI } },
      })
      expect(result).toMatchObject({ updated: true, record: { scheduledAt: '2026-09-20T00:00:00.000Z' } })
      // A retiming with no occurrence inside the window is refused.
      const current = (await service.catalog()).find(item => item.id === record.id)!
      const { sessionId: _sessionId, status: _status, window: _window, ...expected } = current
      await expect(service.update({
        sessionId, id: record.id, expected, change: { kind: 'at', at: '2026-09-18T00:00:00.000Z' },
      })).resolves.toMatchObject({ code: 'invalid_rule' })
    } finally {
      await fiber.dispose()
    }
  })
})

describe('delivery at the end date', () => {
  async function drive(task: ScheduleTask, now: string) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
    const { ctx, resolve, fiber } = await harness()
    const agent = agentFor(ctx, task.sessionId)
    resolve.mockResolvedValue({ agent })
    const tasks: ScheduleTask[] = [task]
    const commit = vi.fn(async (next: ScheduleTask) => { tasks[0] = next })
    const runtime = new ScheduleRuntime(ctx, () => tasks, work => work(), commit, { days: 30, records: 200 })
    runtime.requestDrive()
    await vi.waitFor(() => { expect(commit).toHaveBeenCalled() })
    await runtime.dispose()
    await fiber.dispose()
    return { task: tasks[0]!, followup: agent.followup }
  }

  it('runs the last day inside the window and then ends', async () => {
    const record = daily()
    const { task, followup } = await drive(
      { sessionId: SessionId('w1'), record, status: 'active', window: window(undefined, '2026-09-16') }, '2026-09-16T15:00:01.000Z',
    )
    expect(followup).toHaveBeenCalledOnce()
    expect(task).toMatchObject({ status: 'inactive', record: { scheduledAt: '2026-09-16T15:00:00.000Z' } })
  })

  it('keeps running while the next occurrence is inside the window', async () => {
    const { task, followup } = await drive(
      { sessionId: SessionId('w2'), record: daily(), status: 'active', window: window(undefined, '2026-09-17') }, '2026-09-16T15:00:01.000Z',
    )
    expect(followup).toHaveBeenCalledOnce()
    expect(task).toMatchObject({ status: 'active', record: { scheduledAt: '2026-09-17T15:00:00.000Z' } })
  })

  it('catches up with the last occurrence before the end date after the Host was off past it', async () => {
    const { task, followup } = await drive(
      { sessionId: SessionId('w3'), record: daily(), status: 'active', window: window(undefined, '2026-09-17') }, '2026-09-20T00:00:00.000Z',
    )
    expect(followup).toHaveBeenCalledOnce()
    expect(JSON.stringify(followup.mock.calls[0]![0].content)).toContain('2026-09-17T15:00:00.000Z')
    expect(task).toMatchObject({ status: 'inactive', record: { scheduledAt: '2026-09-17T15:00:00.000Z' } })
  })

  it('ends without a delivery a task whose target is already after the end date', async () => {
    const record = { ...daily(), scheduledAt: '2026-09-18T15:00:00.000Z' }
    const { task, followup } = await drive(
      { sessionId: SessionId('w4'), record, status: 'active', window: window(undefined, '2026-09-17') }, '2026-09-19T00:00:00.000Z',
    )
    expect(followup).not.toHaveBeenCalled()
    expect(task).toMatchObject({ status: 'inactive', record: { scheduledAt: '2026-09-18T15:00:00.000Z' } })
  })
})
