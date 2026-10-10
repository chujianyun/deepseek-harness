/** The automation task form's values, their checks, and the `automationTasks.create` request they make. */
import type { AutomationTaskCreateRequest } from '@deepseek-ai/dsh-automation-tasks/client'
import type { ScheduleTimingChange } from '@deepseek-ai/dsh-schedule/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { TaskFormLocaleKey } from './locales.ts'

/** How often the task runs: on a calendar, at a fixed interval, or once. */
export type FrequencyMode = 'periodic' | 'interval' | 'once'
/** The calendar a periodic task follows. */
export type Repeat = 'daily' | 'weekdays' | 'weekly'
/** The unit of an interval. */
export type IntervalUnit = 'minutes' | 'hours'

/** Everything the form holds; text fields keep what was typed. */
export interface TaskFormValues {
  title: string
  workspaceId: string
  prompt: string
  /** Assistant id; empty for general mode. */
  assistantId: string
  /** `provider/model` as `JSON.stringify([provider, model])`; empty for the default model. */
  model: string
  permission: string
  connectors: string[]
  mode: FrequencyMode
  repeat: Repeat
  /** ISO weekdays, Monday 1 through Sunday 7. */
  weekdays: number[]
  /** Local `HH:mm`. */
  time: string
  interval: string
  unit: IntervalUnit
  /** Local `YYYY-MM-DD` of a one-shot run. */
  date: string
  start: string
  end: string
}

/** The field a message belongs under. */
export type TaskFormField = 'title' | 'workspace' | 'prompt' | 'frequency' | 'window'

/** One field's message. */
export interface TaskFormProblem {
  readonly field: TaskFormField
  readonly key: TaskFormLocaleKey
}

/** Longest task name the schedule stores. */
export const MAX_TITLE_LENGTH = 120
const WORKDAYS = [1, 2, 3, 4, 5]

/**
 * The values a new form starts with.
 * @param defaults - the first workspace, the default permission preset, and a suggested time.
 * @returns daily at the suggested time, in general mode, in that workspace.
 */
export function initialValues(defaults: { workspaceId: string; permission: string; time: string; date: string }): TaskFormValues {
  return {
    title: '', workspaceId: defaults.workspaceId, prompt: '', assistantId: '', model: '', permission: defaults.permission,
    connectors: [], mode: 'periodic', repeat: 'daily', weekdays: [1], time: defaults.time, interval: '1', unit: 'hours',
    date: defaults.date, start: '', end: '',
  }
}

/** The timing the values describe, read in the browser's zone. */
function timing(values: TaskFormValues, zone: string): ScheduleTimingChange {
  const time = `${values.time}:00`
  if (values.mode === 'interval') {
    return { kind: 'every', every_seconds: Number(values.interval) * (values.unit === 'hours' ? 3600 : 60) }
  }
  if (values.mode === 'once') return { kind: 'at', at: { date: values.date, time, time_zone: zone } }
  if (values.repeat === 'daily') return { kind: 'daily', daily: { time, time_zone: zone } }
  const weekdays = values.repeat === 'weekdays' ? WORKDAYS : [...values.weekdays].sort((a, b) => a - b)
  return { kind: 'weekly', weekly: { time, time_zone: zone, weekdays } }
}

/**
 * Check the values and build the request they make.
 * @param values - the form's values.
 * @param zone - the browser's IANA zone, which times and dates are read in.
 * @returns the request, or the problems to show under their fields.
 */
export function toRequest(
  values: TaskFormValues, zone: string,
): { request: AutomationTaskCreateRequest } | { problems: TaskFormProblem[] } {
  const problems: TaskFormProblem[] = []
  const title = values.title.trim()
  if (title === '') problems.push({ field: 'title', key: 'error.titleRequired' })
  else if (title.length > MAX_TITLE_LENGTH) problems.push({ field: 'title', key: 'error.titleTooLong' })
  if (values.workspaceId === '') problems.push({ field: 'workspace', key: 'error.workspaceRequired' })
  if (values.prompt.trim() === '') problems.push({ field: 'prompt', key: 'error.promptRequired' })
  if (values.mode === 'interval' && !(Number.isInteger(Number(values.interval)) && Number(values.interval) >= 1)) {
    problems.push({ field: 'frequency', key: 'error.intervalInvalid' })
  }
  else if (values.mode !== 'interval' && !/^\d{2}:\d{2}$/u.test(values.time)) problems.push({ field: 'frequency', key: 'error.timeRequired' })
  else if (values.mode === 'once' && values.date === '') problems.push({ field: 'frequency', key: 'error.dateRequired' })
  else if (values.mode === 'periodic' && values.repeat === 'weekly' && values.weekdays.length === 0) {
    problems.push({ field: 'frequency', key: 'error.weekdaysRequired' })
  }
  if (values.start !== '' && values.end !== '' && values.end < values.start) problems.push({ field: 'window', key: 'error.windowOrder' })
  if (problems.length > 0) return { problems }
  const [provider, model] = values.model === '' ? [] : JSON.parse(values.model) as [string, string]
  return {
    request: {
      title, prompt: values.prompt.trim(), workspaceId: values.workspaceId as WorkspaceId, timing: timing(values, zone),
      ...(values.assistantId === '' ? {} : { assistantId: values.assistantId }),
      ...(provider === undefined || model === undefined ? {} : { model: { provider, model } }),
      ...(values.permission === '' ? {} : { permission: values.permission }),
      ...(values.connectors.length === 0 ? {} : { connectors: [...values.connectors] }),
      ...(values.start === '' && values.end === '' ? {} : {
        window: { ...(values.start === '' ? {} : { start: values.start }), ...(values.end === '' ? {} : { end: values.end }), time_zone: zone },
      }),
    },
  }
}

/** A refusal from the Host, as the Remote reports it. */
export interface TaskFormRefusal {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

/**
 * The message and field for a refused save.
 * @param refusal - the Remote error.
 * @returns where to show it and the dictionary key; `error.unknown` shows the Host's message.
 */
export function refusalProblem(refusal: TaskFormRefusal): TaskFormProblem {
  const detail = typeof refusal.details === 'object' && refusal.details !== null && 'code' in refusal.details
    ? String(refusal.details.code)
    : ''
  if (refusal.code === 'automation-tasks/invalid') {
    switch (detail) {
      case 'invalid_prompt': return { field: 'prompt', key: 'error.promptInvalid' }
      case 'not_future': return { field: 'frequency', key: 'error.notFuture' }
      case 'frequency_too_high': return { field: 'frequency', key: 'error.intervalInvalid' }
      case 'unknown_permission': return { field: 'prompt', key: 'error.permissionUnknown' }
      default: return { field: 'frequency', key: 'error.outsideWindow' }
    }
  }
  if (refusal.code === 'automation-tasks/model-unavailable') return { field: 'prompt', key: 'error.modelUnavailable' }
  if (refusal.code === 'assistants/not-found') return { field: 'prompt', key: 'error.assistantGone' }
  return { field: 'window', key: 'error.unknown' }
}
