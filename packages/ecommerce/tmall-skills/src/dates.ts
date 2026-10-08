/** Report dates in Beijing time, whatever the computer's own time zone. */

import { EXIT, SkillError } from './errors.ts'

const BEIJING_OFFSET_MS = 8 * 3_600_000

/**
 * The calendar date in Beijing.
 * @param now - the moment.
 * @param daysBack - how many days earlier.
 * @returns `YYYY-MM-DD`.
 */
export function beijingDate(now: Date, daysBack = 0): string {
  return new Date(now.getTime() + BEIJING_OFFSET_MS - daysBack * 86_400_000).toISOString().slice(0, 10)
}

/**
 * The time in Beijing, to stamp a report.
 * @param now - the moment.
 * @returns `YYYY-MM-DD HH:mm`.
 */
export function beijingTime(now: Date): string {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * Check a report date: a real `YYYY-MM-DD` day that has ended in Beijing.
 * @param date - the date asked for.
 * @param now - the moment.
 * @returns the date.
 * @throws SkillError with the usage exit status otherwise.
 */
export function pastDate(date: string, now: Date): string {
  const day = new Date(`${date}T00:00:00Z`)
  const valid = /^\d{4}-\d{2}-\d{2}$/u.test(date) && !Number.isNaN(day.getTime()) && day.toISOString().startsWith(date)
  if (!valid) throw new SkillError(`日期「${date}」不是 YYYY-MM-DD 格式的有效日期。`, EXIT.usage)
  if (date >= beijingDate(now)) throw new SkillError(`${date} 还没有结束（按北京时间），只能取已经过去的日期。`, EXIT.usage)
  return date
}
