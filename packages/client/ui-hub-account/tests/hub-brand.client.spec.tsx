// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { HubAccountView, HubBrandingView } from '@deepseek-ai/dsh-hub-account/types'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { HubBrandMark, HubBrandName } from '../src/client/HubBrand.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const LOGO = 'data:image/png;base64,iVBORw0KGgo='
const profile = { nickname: '韩梅梅', phone: '138****0001', tenantId: 't-a', tenantName: '甲公司', isTenantAdmin: false }

function hooks(tenantName: string | null, logo: string | null) {
  const view: HubAccountView = { status: 'signed-in', profile: { ...profile, tenantName }, reason: null, attempt: null, branding: null }
  const brand: HubBrandingView | null = logo === null ? null : { tenantId: 't-a', title: null, logo }
  return {
    useHub: bindSnapshotSelector(createSnapshotStore<{ view: HubAccountView | undefined }>({ view })),
    useBrand: bindSnapshotSelector(createSnapshotStore<HubBrandingView | null>(brand)),
  }
}
const standard = {} as GlobalStandardProps

it('shows the tenant logo with the build version below, and nothing beside it in the expanded row', () => {
  const name = render(<HubBrandName {...standard} {...hooks('甲公司', LOGO)} t={makeTranslate(zh)} version="0.2.0-rc.2-abc1234" />)
  const logo = name.container.querySelector('img')!
  expect(logo.getAttribute('src')).toBe(LOGO)
  expect(logo.alt).toBe('甲公司')
  expect(name.container.textContent).toBe('0.2.0-rc.2-abc1234')
  const row = render(<HubBrandMark {...standard} {...hooks('甲公司', LOGO)} size={24} placement="row" />)
  expect(row.container.innerHTML).toBe('')
  const rail = render(<HubBrandMark {...standard} {...hooks('甲公司', LOGO)} size={24} placement="rail" />)
  expect(rail.container.querySelector('img')).toMatchObject({ width: 24, height: 24 })
})

it('shows the company name without a logo, and its first character on the rail', () => {
  const name = render(<HubBrandName {...standard} {...hooks('甲公司', null)} t={makeTranslate(zh)} version={undefined} />)
  expect(name.container.textContent).toBe('甲公司')
  const rail = render(<HubBrandMark {...standard} {...hooks('甲公司', null)} size={24} placement="rail" />)
  expect(rail.container.textContent).toBe('甲')
})

it('names the logo generically and draws no rail mark when the profile has no company', () => {
  const name = render(<HubBrandName {...standard} {...hooks(null, LOGO)} t={makeTranslate(zh)} version="1.0.0" />)
  expect(name.container.querySelector('img')!.alt).toBe(zh.brandLogo)
  const rail = render(<HubBrandMark {...standard} {...hooks(null, null)} size={24} placement="rail" />)
  expect(rail.container.innerHTML).toBe('')
})
