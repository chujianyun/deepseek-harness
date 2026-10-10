/**
 * Automation task form, browser half: occupies the Automation tasks page's `schedule.task.form` slot,
 * so New opens the Add automation task form there instead of a Session. Saving calls the
 * `automationTasks` Remote, which creates the task's Session and schedule together.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-schedule/client'
import { loadTaskFormOptions, type TaskFormInjected } from './form-options.ts'
import { en, zh, type TaskFormLocaleKey } from './locales.ts'
import { TaskForm } from './TaskForm.tsx'

export type { TaskFormInjected, TaskFormOptions } from './form-options.ts'
export type { TaskFormLocaleKey } from './locales.ts'
export type { TaskFormProps } from './TaskForm.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Add automation task form copy. */
    'automationTaskForm': TaskFormLocaleKey
  }
}

const NS = 'automationTaskForm'

/** Services the form reads: the slots, the copy, and the Remotes it offers options from and saves through. */
export const inject = [
  'slots', 'locale', 'workspaces', 'remote', 'remote.automationTasks', 'remote.assistants', 'remote.session', 'remote.permissionPresets', 'remote.connectors',
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
}
