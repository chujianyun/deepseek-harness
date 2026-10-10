/** Durable Host-wide Schedule tasks, independently of Session activation. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { decodeScheduleRecord } from './domain.ts'
import type { ScheduleId, ScheduleRecord, ScheduleWindow } from './types.ts'

const recordSchema = z.unknown().transform((value, context): ScheduleRecord => {
  try {
    return decodeScheduleRecord(value)
  } catch (error: unknown) {
    context.addIssue({ code: 'custom', message: String(error) })
  }
  return z.NEVER
})

const instantSchema = z.iso.datetime({ precision: 3 }).refine(value => !value.startsWith('0000-'), {
  message: 'Expected a canonical four-digit-year UTC calendar instant',
})

const deliveryReceiptSchema = z.object({
  scheduledAt: instantSchema,
  deliveredAt: instantSchema,
  messageId: z.string().min(1).refine(value => value.trim() === value).transform(MessageId),
}).strict()

const deliveryHistorySchema = z.object({
  records: z.array(deliveryReceiptSchema.extend({ prompt: z.string().optional() }).strict()),
  earlierRecordsUnavailable: z.boolean(),
  earlierRecordsPruned: z.boolean().optional(),
}).strict().refine(history => new Set(history.records.map(record => record.messageId)).size === history.records.length, {
  message: 'Delivery history message identities must be unique within a task',
})

const windowDateSchema = z.iso.date()

/** Effective dates; the zone is canonical and at least one date is set. */
const windowSchema = z.object({
  start: windowDateSchema.optional(),
  end: windowDateSchema.optional(),
  timeZone: z.string().min(1),
}).strict().refine(window => window.start !== undefined || window.end !== undefined, {
  message: 'A window sets a start or an end date',
}).refine(window => window.start === undefined || window.end === undefined || window.start <= window.end, {
  message: 'A window ends on or after its start date',
}).transform((window): ScheduleWindow => ({
  ...(window.start === undefined ? {} : { start: window.start }),
  ...(window.end === undefined ? {} : { end: window.end }),
  timeZone: window.timeZone,
}))

/** Stored task binds one schedule to its original Session; absent status decodes as active. */
export const scheduleTaskSchema = z.object({
  sessionId: z.string().min(1).transform(SessionId),
  record: recordSchema,
  status: z.enum(['active', 'inactive']).default('active'),
  lastDelivery: deliveryReceiptSchema.optional(),
  deliveryHistory: deliveryHistorySchema.optional(),
  /** Effective dates; absent means the task always runs. */
  window: windowSchema.optional(),
}).strict().refine((task) => {
  if (task.deliveryHistory === undefined) return true
  const latest = task.deliveryHistory.records.at(-1)
  if (latest === undefined) return task.lastDelivery === undefined
  return task.lastDelivery !== undefined
    && latest.scheduledAt === task.lastDelivery.scheduledAt
    && latest.deliveredAt === task.lastDelivery.deliveredAt
    && latest.messageId === task.lastDelivery.messageId
}, { message: 'Last delivery must match the latest saved delivery receipt' })

/** Persistent task value; absent history retains only its legacy last receipt without a read-time rewrite. */
export type ScheduleTask = z.infer<typeof scheduleTaskSchema>

/** Authoritative Schedule storage; malformed tasks reject opening the domain. */
export const scheduleDomain = defineDomain({
  name: 'schedule', version: 1,
  tables: { tasks: domainTable<ScheduleId, ScheduleTask>(scheduleTaskSchema) },
})
