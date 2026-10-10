// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, expect, it } from 'vitest'
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, MO_THEME_SOURCE } from '../src/client/index.ts'
import { MO_THEME_TOKENS } from '../src/client/tokens.ts'
import { MoBrandMark } from '../src/client/BrandMark.tsx'
import { MO_MARK } from '../src/mark.ts'

afterEach(cleanup)

/** WCAG relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
  const [r, g, b] = channels.map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

async function mount() {
  const layers = new Map<string, ThemeTokenOverrides>()
  const ctx = new Context()
  ctx.provide('theme', {
    overrideTokens: (source: string, tokens: ThemeTokenOverrides) => {
      layers.set(source, tokens)
      return () => { layers.delete(source) }
    },
  } as never)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const disposeHoles = slots.register({
    name: 'root', children: { 'sidebar.brand.mark': { kind: 'single', scope: 'root' } },
  } as never, () => null)
  const fiber = await ctx.plugin({ inject, apply })
  return { layers, slots, disposeHoles, dispose: () => fiber.dispose() }
}

it('injects the theme and slot services', () => {
  expect(inject).toEqual(['theme', 'slots'])
})

it('occupies the sidebar brand mark with the MO mark at the requested size until unloaded', async () => {
  const h = await mount()
  const [entry] = h.slots.entries('sidebar.brand.mark')
  expect(entry?.component).toBe(MoBrandMark)
  const img = render(createElement(MoBrandMark, { size: 24, placement: 'row' } as never)).container.querySelector('img')!
  expect(img.getAttribute('src')).toBe(MO_MARK)
  expect(img).toMatchObject({ width: 24, height: 24 })
  await h.dispose()
  expect(h.slots.entries('sidebar.brand.mark')).toEqual([])
  h.disposeHoles()
})

it('layers the MO tokens over the active theme for the plugin lifetime', async () => {
  const h = await mount()
  expect(h.layers.get(MO_THEME_SOURCE)).toBe(MO_THEME_TOKENS)
  await h.dispose()
  expect(h.layers.has(MO_THEME_SOURCE)).toBe(false)
})

it('turns primary buttons, send, links, focus rings, and the light accent alias 名流蓝', () => {
  expect(MO_THEME_TOKENS['--dsw-alias-button-primary-fill']).toEqual({ light: '#2A55F9', dark: '#5C7CFF' })
  // Send, links, and focus rings resolve through the accent ramp's 500 (light) and 400 (dark) steps.
  expect(MO_THEME_TOKENS['--dsw-static-deepseek-500']?.light).toBe('#2A55F9')
  expect(MO_THEME_TOKENS['--dsw-static-deepseek-400']?.dark).toBe('#5C7CFF')
  expect(MO_THEME_TOKENS['--dsw-alias-brand-primary-new-colorprimary-new-color']?.light).toBe('#2A55F9')
})

it('gives the ink tokens the same brand grey as primary text', () => {
  const primaryText = MO_THEME_TOKENS['--dsw-alias-label-primary']
  expect(MO_THEME_TOKENS['--dsw-alias-brand-primary']).toEqual(primaryText)
  expect(MO_THEME_TOKENS['--dsw-alias-brand-text']).toEqual(primaryText)
})

it('overrides only ramp steps the platform palette defines', () => {
  const ramp = Object.keys(MO_THEME_TOKENS).filter(name => name.startsWith('--dsw-static-deepseek-'))
  expect(ramp.map(name => name.slice('--dsw-static-deepseek-'.length)))
    .toEqual(['50', '100', '200', '300', '400', '450', '500', '600', '800', '900'])
})

it('marks the active sidebar panel with the light-blue fill and blue label', () => {
  expect(MO_THEME_TOKENS['--dsw-specific-sidebar-panel-active']?.light).toBe('#E6ECFE')
  expect(MO_THEME_TOKENS['--dsw-specific-sidebar-panel-active-label']?.light).toBe('#2A55F9')
})

it('keeps every brand text and fill pair at WCAG AA contrast in the light palette', () => {
  const light = (name: string) => MO_THEME_TOKENS[name]!.light
  for (const label of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary']) {
    expect(contrast(light(label), '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  }
  expect(contrast(light('--dsw-alias-button-primary-fill'), '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(light('--dsw-alias-button-primary-hover'), '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(light('--dsw-specific-sidebar-panel-active-label'), light('--dsw-specific-sidebar-panel-active'))).toBeGreaterThanOrEqual(4.5)
})

it('keeps business badges at WCAG AA: accent text on the tertiary tint in both palettes', () => {
  // business-primary/-tertiary read ramp 500/100 in the light palette and 400/800 in the dark one.
  const step = (n: number, mode: 'light' | 'dark') => MO_THEME_TOKENS[`--dsw-static-deepseek-${String(n)}`]![mode]
  expect(contrast(step(500, 'light'), step(100, 'light'))).toBeGreaterThanOrEqual(4.5)
  expect(contrast(step(400, 'dark'), step(800, 'dark'))).toBeGreaterThanOrEqual(4.5)
})

it('keeps dark-palette primary and info buttons readable under their dark foreground label', () => {
  // The dark info-button hover reads ramp 500.
  expect(contrast(MO_THEME_TOKENS['--dsw-static-deepseek-500']!.dark, '#0F1115')).toBeGreaterThanOrEqual(4.5)
  // label-primary-foreground is the near-black neutral-bluish-1000 in the dark palette.
  expect(contrast(MO_THEME_TOKENS['--dsw-alias-button-primary-fill']!.dark, '#0F1115')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(MO_THEME_TOKENS['--dsw-alias-button-primary-hover']!.dark, '#0F1115')).toBeGreaterThanOrEqual(4.5)
})
