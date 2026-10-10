/**
 * Pure types of the automation-task composer: the `automationTasks` Remote's request and result,
 * and its error details. Free of host-side value imports, so `./types` serves Host consumers and
 * `./client` re-exports it for Client code.
 *
 * @module @deepseek-ai/dsh-automation-tasks/types
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ScheduleRecord, ScheduleTimingChange, ScheduleWindowInput } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The schedule refused the task's name, instruction, timing, or effective dates; `code` is its Schedule input code. */
    'automation-tasks/invalid': { readonly code: string }
    /** The task asked for an assistant, connectors, or a permission preset, but this deployment does not mount that service. */
    'automation-tasks/unavailable': { readonly field: 'assistant' | 'connectors' | 'permission' }
    /** The requested model is not available. */
    'automation-tasks/model-unavailable': { readonly provider: string; readonly model: string }
  }
}

/** One automation task as the form submits it. */
export interface AutomationTaskCreateRequest {
  /** Task name, also the name of its Session: at most 120 characters, non-empty after trimming. */
  readonly title: string
  /** Instruction sent to the Session at each run, non-empty after trimming. */
  readonly prompt: string
  /** Workspace of the new Session; omitted uses the default workspace. */
  readonly workspaceId?: WorkspaceId
  /** Assistant the Session is bound to; omitted runs in general mode. */
  readonly assistantId?: string
  /** Model the Session uses, without changing the default; omitted keeps the assistant's or the default model. */
  readonly model?: ModelSelection
  /** Permission preset of the Session, such as `workspace-write`; omitted keeps the default. */
  readonly permission?: string
  /** Connectors whose plain writes run without asking in the Session; omitted or empty grants none. */
  readonly connectors?: readonly string[]
  /** When the task runs. */
  readonly timing: ScheduleTimingChange
  /** Optional effective dates. */
  readonly window?: ScheduleWindowInput
}

/** A created automation task: its Session and stored schedule. */
export interface AutomationTaskCreateValue {
  readonly sessionId: SessionId
  readonly record: ScheduleRecord
}
