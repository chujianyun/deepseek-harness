import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { apply } from '../src/index.ts'
import { MO_MARK } from '../src/mark.ts'

function collect(ctx: Context): IndexInjection[] {
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table)
  return table
}

it('brands the boot page and seeds the MO palette into every index render while mounted', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin({ apply })
  const [brand, style, ...rest] = collect(ctx)
  expect(rest).toEqual([])
  expect(brand).toEqual({
    kind: 'global',
    // The global the dsh-client-web boot page reads (pinned there as BOOT_BRAND_GLOBAL).
    name: '__DSH_BOOT_BRAND__',
    value: { mark: MO_MARK, name: 'MO WorkAI', hint: { en: 'Starting MO WorkAI…', zh: '正在启动 MO WorkAI…' } },
  })
  if (style?.kind !== 'style') throw new Error('expected a style row')
  // The boot page sits on the navy brand ground.
  expect(style.text).toContain('[data-dsh-boot]{background:#0E1430')
  // First paint already uses the brand tokens in both palettes, ahead of the client token layer.
  expect(style.text).toContain('html body{')
  expect(style.text).toContain('--dsw-alias-button-primary-fill:#2A55F9')
  expect(style.text).toContain('html body[data-ds-dark-theme]{')
  expect(style.text).toContain('--dsw-alias-button-primary-fill:#5C7CFF')
  expect(style.text).not.toContain('</style')
  await fiber.dispose()
  expect(collect(ctx)).toEqual([])
})
