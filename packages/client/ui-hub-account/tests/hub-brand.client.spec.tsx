// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { HubAccountView, HubBrandingView } from '@deepseek-ai/dsh-hub-account/types'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { HubHeroHeadline, HubHeroMark } from '../src/client/HubBrand.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const LOGO = 'data:image/png;base64,iVBORw0KGgo='
const profile = { nickname: '韩梅梅', phone: '138****0001', tenantId: 't-a', tenantName: '甲公司', isTenantAdmin: false }

function hooks(tenantName: string | null, logo: string | null, slogan: string | null = null) {
  const view: HubAccountView = { status: 'signed-in', profile: { ...profile, tenantName }, reason: null, attempt: null, branding: null }
  const brand: HubBrandingView | null = logo === null && slogan === null ? null : { tenantId: 't-a', title: null, slogan, logo }
  return {
    useHub: bindSnapshotSelector(createSnapshotStore<{ view: HubAccountView | undefined }>({ view })),
    useBrand: bindSnapshotSelector(createSnapshotStore<HubBrandingView | null>(brand)),
  }
}
const standard = {} as GlobalStandardProps

it('leads the new-session hero with the tenant logo at the requested height, and nothing without one', () => {
  const mark = render(<HubHeroMark {...standard} {...hooks('甲公司', LOGO)} t={makeTranslate(zh)} size={34} className="host-fish" />)
  const logo = mark.container.querySelector('img')!
  expect(logo.getAttribute('src')).toBe(LOGO)
  expect(logo.alt).toBe('甲公司')
  expect(logo.height).toBe(34)
  // The host's fish class carries the swim animation; a tenant logo stays still.
  expect(logo.classList.contains('host-fish')).toBe(false)
  expect(render(<HubHeroMark {...standard} {...hooks(null, LOGO)} t={makeTranslate(zh)} size={34} />).container.querySelector('img')!.alt).toBe(zh.brandLogo)
  // No logo: no company-name stand-in, the hero half stays empty.
  expect(render(<HubHeroMark {...standard} {...hooks('甲公司', null, '标语')} t={makeTranslate(zh)} size={34} />).container.innerHTML).toBe('')
  expect(render(<HubHeroMark {...standard} {...hooks('甲公司', null)} t={makeTranslate(zh)} size={34} />).container.innerHTML).toBe('')
})

it('shows the tenant slogan as written as the new-session headline', () => {
  const headline = render(<HubHeroHeadline {...standard} {...hooks('甲公司', null, 'Work smarter, 一起')} t={makeTranslate(zh)} />)
  expect(headline.container.textContent).toBe('Work smarter, 一起')
})

it('greets the employee by the time of day when the tenant set no slogan', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const at = (hour: number, copy: typeof zh = zh) => {
    vi.setSystemTime(new Date(2026, 9, 10, hour, 30))
    cleanup()
    return render(<HubHeroHeadline {...standard} {...hooks('甲公司', LOGO)} t={makeTranslate(copy)} />).container
  }
  try {
    expect(at(8).querySelector('[data-hero-greeting]')?.textContent).toBe('早上好，韩梅梅')
    expect(at(12).querySelector('[data-hero-greeting]')?.textContent).toBe('中午好，韩梅梅')
    expect(at(15).querySelector('[data-hero-greeting]')?.textContent).toBe('下午好，韩梅梅')
    expect(at(21).querySelector('[data-hero-greeting]')?.textContent).toBe('晚上好，韩梅梅')
    expect(at(3).querySelector('[data-hero-greeting]')?.textContent).toBe('晚上好，韩梅梅')
    expect(at(15).textContent).toBe(`下午好，韩梅梅${zh.greetingPrompt}`)
    expect(at(8, en).querySelector('[data-hero-greeting]')?.textContent).toBe('Good morning, 韩梅梅')
    expect(at(15, en).querySelector('[data-hero-greeting]')?.textContent).toBe('Good afternoon, 韩梅梅')
    expect(at(21, en).querySelector('[data-hero-greeting]')?.textContent).toBe('Good evening, 韩梅梅')
  } finally {
    vi.useRealTimers()
  }
})

it('shows no headline while nobody is signed in', () => {
  const useHub = bindSnapshotSelector(createSnapshotStore<{ view: HubAccountView | undefined }>({ view: undefined }))
  const useBrand = bindSnapshotSelector(createSnapshotStore<HubBrandingView | null>(null))
  expect(render(<HubHeroHeadline {...standard} useHub={useHub} useBrand={useBrand} t={makeTranslate(zh)} />).container.innerHTML).toBe('')
})
