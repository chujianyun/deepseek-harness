/** The Automation tasks page's creation-form slot: a plugin that occupies it replaces New's Session with its form. */
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A task the form created: its Session and its schedule id. */
export interface TaskFormCreated {
  readonly sessionId: SessionId
  readonly id: ScheduleId
}

/** What the page passes the form it shows in its place. */
export interface TaskFormOwnerProps {
  /** Close the form and return to the list: with the created task, which the list then selects, or undefined when cancelled. */
  readonly onDone: (created: TaskFormCreated | undefined) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The creation form New opens in place of the task list. Without an occupant, New starts a
     * Session where the model creates the reminder.
     */
    'schedule.task.form': { kind: 'single'; scope: 'root'; owner: TaskFormOwnerProps }
  }
}
