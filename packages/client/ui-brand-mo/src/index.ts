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
  /** Template id of the assistant a quick task picks for the new session (`ecommerce` is 电商管家); empty keeps the current pick. */
  quickTaskAssistant: Volatile<string>
  /**
   * Grouping the sidebar's Session list shows until the user picks one: a built-in view
   * (`workspace`, `workspace-tree`, `flat`) or a registered grouping's id such as `assistant` or
   * `date`; empty keeps the sidebar's own default.
   */
  defaultSessionGrouping: Volatile<string>
}

/** Brand configuration projected to the browser. */
export const Config = z.object({
  quickTasks: z.array(z.union(QUICK_TASK_IDS.map(id => z.const(id)))).default([]).volatile(),
  quickTaskAssistant: z.string().default('').volatile(),
  defaultSessionGrouping: z.string().default('').volatile(),
})

/**
 * Add the boot rows to every index render, and expose the brand configuration to the browser through Settings,
 * while mounted.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.on('webserver/index-inject', (table) => { table.push(...moBootInjections()) })
}
