import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import {
  Config, LOCALE_PREFERENCE_FIELD, apply,
} from '@deepseek-ai/dsh-client-locale'


describe('locale host', () => {
  it('registers an open locale preference with the Host settings lifecycle', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration
    expect(plainConfig(configuration.fiber.config)).toEqual({})
    await configuration.update({ preference: 'en' })
    expect(plainConfig(configuration.fiber.config)).toEqual({ preference: 'en' })
    await configuration.update({ preference: 'pt-BR' })
    expect(plainConfig(configuration.fiber.config)).toEqual({ preference: 'pt-BR' })
    await expect(configuration.update({ preference: 'bad locale' })).rejects.toThrow()
    await expect(configuration.update({ preference: '123' })).rejects.toThrow()
    await fiber.dispose()
  })

  it('writes an explicit preference into <html lang> before the client boots', async () => {
    const ctx = new Context()
    const collect = () => { const table: IndexInjection[] = []; ctx.emit('webserver/index-inject', table); return table }
    const configuration = await liveConfig(ctx, { Config, apply })
    expect(collect()).toEqual([])
    await configuration.update({ preference: 'zh' })
    expect(collect()).toEqual([{ kind: 'script', placement: 'head', text: 'document.documentElement.lang = "zh-CN"; document.documentElement.dataset.dshLocaleExplicit = \'\'' }])
    await configuration.update({ preference: 'pt-BR' })
    expect(collect()).toEqual([{ kind: 'script', placement: 'head', text: 'document.documentElement.lang = "pt-BR"; document.documentElement.dataset.dshLocaleExplicit = \'\'' }])
    await configuration.fiber.dispose()
    expect(collect()).toEqual([])
  })

  it('names the Config key after the settings field it projects', () => {
    // Config declares the key literally so the config catalog can read it; it must stay the settings field.
    expect(LOCALE_PREFERENCE_FIELD).toBe('preference')
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
