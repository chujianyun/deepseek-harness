import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { MandatoryUpdateView } from '../src/mandatory-update-window.ts'

const renderer = join(import.meta.dirname, '../renderer')
const html = readFileSync(join(renderer, 'mandatory-update.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/gu, '')
const script = readFileSync(join(renderer, 'mandatory-update.js'), 'utf8')

/** Render one view through the shipped page script and return its document. */
function render(view: Partial<MandatoryUpdateView>): Document {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  const full = {
    locale: resolveDesktopLocale('zh'), deferred: false, manualOnly: false,
    policy: { blocking: true, checking: false, title: '请更新 MO WorkAI', detail: '新版本修复了登录问题', page: 'https://hub.example.com/download' },
    update: { phase: 'error', failedOperation: 'check', message: 'desktop update: this application has no packaged update source' },
    ...view,
  }
  Object.assign(dom.window, { dshMandatoryUpdate: {
    status: () => Promise.resolve(full),
    subscribe: (listener: (state: unknown) => void) => { listener(full); return () => {} },
    action: () => Promise.resolve(),
  } })
  dom.window.eval(script)
  return dom.window.document
}

const shown = (document: Document, id: string) => !document.getElementById(id)!.hidden

it('shows only the policy text and the download page when the installation has no update source', () => {
  const document = render({ manualOnly: true })
  expect(document.getElementById('title')!.textContent).toBe('请更新 MO WorkAI')
  expect(document.getElementById('detail')!.textContent).toBe('新版本修复了登录问题')
  expect(shown(document, 'error')).toBe(false)
  expect(shown(document, 'technical-details')).toBe(false)
  expect(shown(document, 'refresh')).toBe(false)
  expect(shown(document, 'update')).toBe(false)
  expect(shown(document, 'page')).toBe(true)
})

it('still reports updater failures when the installation has an update source', () => {
  const document = render({ manualOnly: false })
  expect(shown(document, 'error')).toBe(true)
  expect(document.getElementById('technical-details-content')!.textContent).toContain('no packaged update source')
  expect(shown(document, 'refresh')).toBe(true)
})

it('keeps the policy sign-in prompt in manual mode', () => {
  const document = render({ manualOnly: true, policy: { blocking: true, checking: false, error: 'authentication-required' } })
  expect(shown(document, 'error')).toBe(true)
  expect(shown(document, 'refresh')).toBe(true)
})
