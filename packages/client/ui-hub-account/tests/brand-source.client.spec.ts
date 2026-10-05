import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HubAccountView, HubBrandingView } from '@deepseek-ai/dsh-hub-account/types'
import { createBrandSource } from '../src/client/brand-source.ts'

const signedIn: HubAccountView = { status: 'signed-in', profile: null, reason: null, attempt: null, branding: null }
const stamp = (title: string) => ({ ...signedIn, branding: { tenantId: 't-a', title, logoSha256: null } })
const ok = (title: string): RemoteResult<HubBrandingView | null> => ({ ok: true, value: { tenantId: 't-a', title, logo: null } })

it('reads the branding once per stamp and clears it when the stamp goes away', async () => {
  const read = vi.fn(async () => ok('甲公司'))
  const source = createBrandSource(read)
  source.publish(signedIn)
  expect(read).not.toHaveBeenCalled()
  source.publish(stamp('甲公司'))
  source.publish(stamp('甲公司'))
  await vi.waitFor(() => { expect(source.brand.getSnapshot()).toMatchObject({ title: '甲公司' }) })
  expect(read).toHaveBeenCalledOnce()
  source.publish(signedIn)
  expect(source.brand.getSnapshot()).toBeNull()
})

it('keeps only the answer for the latest stamp and shows nothing for a refused read', async () => {
  const first = Promise.withResolvers<RemoteResult<HubBrandingView | null>>()
  const read = vi.fn<() => Promise<RemoteResult<HubBrandingView | null>>>().mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(ok('乙公司')).mockResolvedValueOnce({ ok: false, error: { code: 'remote/unavailable', message: 'offline' } } as never)
  const source = createBrandSource(read)
  source.publish(stamp('甲公司'))
  source.publish(stamp('乙公司'))
  await vi.waitFor(() => { expect(source.brand.getSnapshot()).toMatchObject({ title: '乙公司' }) })
  first.resolve(ok('甲公司'))
  await first.promise
  expect(source.brand.getSnapshot()).toMatchObject({ title: '乙公司' })
  source.publish(stamp('丙公司'))
  await vi.waitFor(() => { expect(source.brand.getSnapshot()).toBeNull() })
})
