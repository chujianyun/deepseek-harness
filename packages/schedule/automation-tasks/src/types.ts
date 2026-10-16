/**
 * Pure types of the automation-task composer: the `automationTasks` Remote's request and result,
 * and its error details. Free of host-side value imports, so `./types` serves Host consumers and
 * `./client` re-exports it for Client code.
 *
 * @module @deepseek-ai/dsh-automation-tasks/types
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ScheduleRecord, ScheduleTimingChange, ScheduleWindowInput } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The operations the automation task declares for its unattended runs, as the first words of a
     * command such as `lark-cli im +messages-send`; replaces the earlier declaration, and an empty
     * list withdraws it. Log-only, never in the model transcript.
     */
    'automation-tasks/operations': {
      operations: string[]
    }
    /**
     * A call in a scheduled run that would have asked for approval, answered without anyone: run,
     * because each of its commands is a declared operation (`operations` lists them), or refused.
     * `turn` is the scheduled run's turn; `command` is the shell command, cut to 500 characters, or
     * the tool's name for another tool.
     * Log-only, never in the model transcript; the refusal reaches the model as the call's result.
     */
    'automation-tasks/unattended': {
      callId: ToolCallId
      turn: number
      command: string
      allowed: boolean
      operations: string[]
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /**
     * The automation task's declared operations, the open turn, whether a person wrote in it, and
     * the turn again while it is a scheduled run nobody has written in.
     */
    automationUnattended: { operations: string[]; openTurn: number | null; personWrote: boolean; scheduledTurn: number | null }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * The task's name, instruction, timing, or effective dates break a Schedule rule (`code` is its
     * Schedule input code), its permission preset does not exist (`unknown_permission`), or a
     * declared operation is refused (`too_many`, `too_long`, `shell_character`, or `not_declarable`).
     */
    'automation-tasks/invalid': { readonly code: string }
    /** The task asked for an assistant or a permission preset, but this deployment does not mount that service. */
    'automation-tasks/unavailable': { readonly field: 'assistant' | 'permission' }
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
  /** Workspace the new Session is filed under. */
  readonly workspaceId: WorkspaceId
  /** Assistant the Session is bound to; omitted runs in general mode. */
  readonly assistantId?: string
  /** Model the Session uses, without changing the default; omitted keeps the assistant's or the default model. */
  readonly model?: ModelSelection
  /** Permission preset of the Session, such as `workspace-write`; omitted keeps the default. */
  readonly permission?: string
  /**
   * Operations that run without asking when the task runs on its schedule, as a command's first
   * words such as `lark-cli im +messages-send` or `dsh-ecommerce browser`; in such a run a call
   * that would ask for approval and is not one of them is refused instead of waiting. Omitted or
   * empty declares none.
   */
  readonly operations?: readonly string[]
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
