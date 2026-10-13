/**
 * Automation task form, browser half: occupies the Automation tasks page's `schedule.task.form` slot,
 * so New opens the Add automation task form there instead of a Session. Saving calls the
 * `automationTasks` Remote, which creates the task's Session and schedule together. A scheduled
 * run's turn ends with the record of the calls it answered without anyone, run or refused.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-schedule/client'
import { loadTaskFormOptions, type TaskFormInjected } from './form-options.ts'
import { en, zh, type TaskFormLocaleKey } from './locales.ts'
import { TaskForm } from './TaskForm.tsx'
import { UnattendedRecord, type UnattendedRecordInjected } from './UnattendedRecord.tsx'
import { unattendedTurnDefinition } from './unattended-turn.ts'

export type { TaskFormInjected, TaskFormOptions } from './form-options.ts'
export type { TaskFormLocaleKey } from './locales.ts'
export type { TaskFormProps } from './TaskForm.tsx'
export type { UnattendedRecordProps } from './UnattendedRecord.tsx'
export type { UnattendedAnswer, UnattendedTurnData } from './unattended-turn.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Add automation task form copy. */
    'automationTaskForm': TaskFormLocaleKey
  }
}

const NS = 'automationTaskForm'

/**
 * Services the form reads — the slots, the copy, and the Remotes it offers options from and saves
 * through — and the conversation events the run record reads.
 */
export const inject = [
  'slots', 'locale', 'uiConversation', 'workspaces', 'remote', 'remote.automationTasks', 'remote.assistants', 'remote.session', 'remote.permissionPresets', 'remote.connectors',
]

/**
 * Register the form in `schedule.task.form` for exactly the plugin lifetime.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-automation-tasks: dictionaries')
  const remote = ctx.remote
  const face: TaskFormInjected = {
    hooks: { workspaces: ctx.workspaces.list },
    loadOptions: () => loadTaskFormOptions({
      assistants: () => remote.assistants.getState(),
      models: () => remote.session.modelCatalog(),
      permissions: () => remote.permissionPresets.catalog(),
      connectors: () => remote.connectors.getState(),
    }),
    onCreate: request => remote.automationTasks.create(request),
  }
  ctx.slots.inject('schedule.task.form', () => ctx.slots.register({
    name: 'schedule.task.form', locale: NS, inject: () => face,
  }, TaskForm))
  ctx.uiConversation.events.register(unattendedTurnDefinition)
  const none: UnattendedRecordInjected = {}
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'automation-unattended', order: 30, locale: NS, inject: () => none,
  }, UnattendedRecord))
}
