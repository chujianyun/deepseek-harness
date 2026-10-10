// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { HubAccountView, HubBrandingView } from '@deepseek-ai/dsh-hub-account/types'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { HubBrandName, HubHeroHeadline, HubHeroMark } from '../src/client/HubBrand.tsx'
import { zh } from '../src/client/locales.ts'

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

it('shows the tenant logo above the product line, without the build version', () => {
  const name = render(<HubBrandName {...standard} {...hooks('甲公司', LOGO)} t={makeTranslate(zh)} version="0.2.0-rc.2-abc1234" />)
  const logo = name.container.querySelector('img')!
  expect(logo.getAttribute('src')).toBe(LOGO)
  expect(logo.alt).toBe('甲公司')
  expect(name.container.textContent).toBe(zh.productName)
})

it('shows the company name above the product line without a logo', () => {
  const name = render(<HubBrandName {...standard} {...hooks('甲公司', null)} t={makeTranslate(zh)} version="1.0.0-local" />)
  expect(name.container.textContent).toBe(`甲公司${zh.productName}`)
})

it('names the logo generically when the profile has no company', () => {
  const name = render(<HubBrandName {...standard} {...hooks(null, LOGO)} t={makeTranslate(zh)} version="1.0.0" />)
  expect(name.container.querySelector('img')!.alt).toBe(zh.brandLogo)
})

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

it('shows the tenant slogan as written as the new-session headline, and nothing without one', () => {
  const headline = render(<HubHeroHeadline {...standard} {...hooks('甲公司', null, 'Work smarter, 一起')} />)
  expect(headline.container.textContent).toBe('Work smarter, 一起')
  expect(render(<HubHeroHeadline {...standard} {...hooks('甲公司', LOGO)} />).container.innerHTML).toBe('')
  expect(render(<HubHeroHeadline {...standard} {...hooks('甲公司', null)} />).container.innerHTML).toBe('')
})
