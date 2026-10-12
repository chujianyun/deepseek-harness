import { describe, expect, it } from 'vitest'
import { followTenant, type HubAccountView } from '../src/index.ts'

const view = (tenantId: string | null) => ({ profile: tenantId === null ? null : { tenantId } }) as HubAccountView

/** A hub whose watch yields the views pushed to it until the signal aborts. */
function hub(initial: string | null) {
  const pending: HubAccountView[] = []
  let wake: (() => void) | undefined
  return {
    getState: () => Promise.resolve(view(initial)),
    async *watch(signal: AbortSignal) {
      signal.addEventListener('abort', () => wake?.(), { once: true })
      while (!signal.aborted) {
        const next = pending.shift()
        if (next !== undefined) { yield next; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
    push: (tenantId: string | null) => { pending.push(view(tenantId)); wake?.() },
  }
}

describe('followTenant', () => {
  it('switches to the signed-in tenant at once, then on each change, and skips an unchanged one', async () => {
    const h = hub('t-a')
    const lifetime = new AbortController()
    let tenant: string | null = null
    const switches: (string | null)[] = []
    await followTenant(h, lifetime.signal, () => tenant, async (next) => { switches.push(next); tenant = next })
    expect(switches).toEqual(['t-a'])
    h.push('t-a')
    h.push('t-b')
    h.push(null)
    await expect.poll(() => switches).toEqual(['t-a', 't-b', null])
    lifetime.abort()
  })
})
