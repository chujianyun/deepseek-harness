/**
 * MO WorkAI brand plugin, host half: brands the boot page and seeds the MO palette into each
 * index render, and projects the new-session quick tasks to the browser. The browser half ships
 * through `exports["./client"]`.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { moBootInjections } from './boot.ts'
import { QUICK_TASK_IDS, type QuickTaskId } from './quick-tasks.ts'

export { BRAND_SETTINGS_NAMESPACE, QUICK_TASK_IDS, type QuickTaskId } from './quick-tasks.ts'

/** Brand configuration projected to the browser. */
export interface Config {
  /** Quick tasks shown under the new-session composer, in order; empty shows none. */
  quickTasks: Volatile<QuickTaskId[]>
}

/** Brand configuration projected to the browser. */
export const Config = z.object({
  quickTasks: z.array(z.union(QUICK_TASK_IDS.map(id => z.const(id)))).default([]).volatile(),
})

/**
 * Add the boot rows to every index render, and expose `quickTasks` to the browser through Settings,
 * while mounted.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.on('webserver/index-inject', (table) => { table.push(...moBootInjections()) })
}
