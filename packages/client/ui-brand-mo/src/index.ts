/**
 * MO WorkAI brand plugin, host half: brands the boot page and seeds the MO palette into each
 * index render. The browser half ships through `exports["./client"]`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { moBootInjections } from './boot.ts'

/**
 * Add the boot rows to every index render while mounted.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table) => { table.push(...moBootInjections()) })
}
