/** Native onboarding reuses authenticated Web RPC and never reads credential values. */
import { describe, expect, it, vi } from 'vitest'
import { connectDesktopWelcome } from '../src/welcome-backend.ts'

function transport(preference?: string, branding: unknown = null) {
  const keys = new Map<string, string>()
  const namespaces = [
    { ns: 'llm-deepseek', value: { apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY' } },
    { ns: 'llm-pi-ai', value: { profiles: { example: { apiKeyEnv: 'EXAMPLE_API_KEY' } } } },
    { ns: 'locale', value: preference === undefined ? {} : { preference } },
  ]
  const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async (_input, init) => {
    if (init?.method !== 'POST') return new Response('index')
    const { rpcId, method, payload } = JSON.parse(init.body as string) as {
      rpcId: string
      method: string
      payload: { args: { ref: string; value: string; refs: string[] } }
    }
    let value: unknown
    if (method === 'hubAccount/getState') value = { status: 'signed-out', profile: null, reason: null, attempt: null, branding: null }
    else if (method === 'hubAccount/getBranding') value = branding
    else if (method === 'settings/describe') value = { namespaces }
    else if (method === 'llm/listConfigurableProviders') value = [{ settingsNs: 'llm-pi-ai', settingsPath: ['profiles', 'example'] }]
    else if (method === 'productAnalytics/enabled') value = true
    else if (method === 'productAnalytics/report') value = undefined
    else if (method === 'credentials/set') keys.set(payload.args.ref, payload.args.value)
    else value = Object.fromEntries(payload.args.refs.map(ref => [ref, { configured: keys.has(ref), writable: true }]))
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
  })
  return { send, keys, namespaces }
}

const url = 'http://127.0.0.1:19387/?token=fixture'

describe('desktop welcome Web operations', () => {
  it('authenticates through Web and reads the user-center sign-in and language over RPC', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    expect(host.send).toHaveBeenCalledExactlyOnceWith(url, { credentials: 'include' })
    expect(await backend.analyticsEnabled()).toBe(true)
    expect(await backend.read()).toEqual({ hub: { status: 'signed-out', profile: null, reason: null, attempt: null, branding: null }, localePreference: null })
    for (const [input, init] of host.send.mock.calls.slice(1)) {
      expect(input).toMatch(/^http:\/\/127\.0\.0\.1:19387\/api\//u)
      expect(init).toMatchObject({ credentials: 'include', redirect: 'error' })
    }
    expect(host.send.mock.calls.some(([input]) => input.endsWith('/api/hubAccount/getState'))).toBe(true)
  })

  it('reads the explicit language preference and detects a key of any configurable provider', async () => {
    const host = transport('zh')
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toMatchObject({ localePreference: 'zh' })
    expect(await backend.hasApiKey()).toBe(false)
    host.keys.set('EXAMPLE_API_KEY', 'sk-other')
    expect(await backend.hasApiKey()).toBe(true)
    host.keys.clear()
    host.keys.set('CUSTOM_DEEPSEEK_KEY', 'sk-official')
    expect(await backend.hasApiKey()).toBe(true)
  })

  it('reads language without querying account or model providers', async () => {
    const host = transport('zh')
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockClear()
    expect(await backend.readLocalePreference()).toBe('zh')
    expect(host.send).toHaveBeenCalledOnce()
    expect(host.send.mock.calls[0]![0]).toContain('/api/settings/describe')
  })

  it('allows profiles without the official provider and rejects invalid provider metadata', async () => {
    const host = transport()
    host.namespaces.splice(0, 1)
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.hasApiKey()).toBe(false)
    host.keys.set('EXAMPLE_API_KEY', 'custom-key')
    expect(await backend.hasApiKey()).toBe(true)
    host.namespaces.unshift({ ns: 'llm-deepseek', value: {} as { apiKeyEnv: string } })
    await expect(backend.hasApiKey()).rejects.toThrow('missing official DeepSeek credential reference')
  })

  it('reads the cached branding and admits only image data URLs as its logo', async () => {
    const logo = 'data:image/png;base64,iVBORw0KGgo='
    expect(await (await connectDesktopWelcome(url, transport(undefined, null).send)).branding()).toBeNull()
    const cached = { tenantId: 't-a', title: '甲公司', logo, extra: 1 }
    expect(await (await connectDesktopWelcome(url, transport(undefined, cached).send)).branding()).toEqual({ tenantId: 't-a', title: '甲公司', logo })
    for (const invalid of [
      { tenantId: 't-a', title: null, logo: 'https://hub.example/logo.png' }, { tenantId: 't-a', title: null, logo: 'data:text/html;base64,PGI+' },
      { tenantId: 't-a', title: 1, logo: null }, { title: null, logo: null }, 'logo',
    ]) await expect((await connectDesktopWelcome(url, transport(undefined, invalid).send)).branding()).rejects.toThrow('invalid branding')
  })

  it('rejects unmatched RPC envelopes and refused requests', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockResolvedValueOnce(Response.json({ type: 'server-response', rpcId: 'other', result: { ok: true } }))
    await expect(backend.read()).rejects.toThrow('Web RPC failed')
    host.send.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(backend.read()).rejects.toThrow('Web request failed')
  })

  it('submits native analytics through authenticated RPC with a bounded request', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    const event = { eventName: 'desktop_app_launch' as const, timestamp: 100, attributes: {} }
    await backend.report(event)
    const [input, init] = host.send.mock.calls.at(-1)!
    expect(input).toBe('http://127.0.0.1:19387/api/productAnalytics/report')
    expect(init?.credentials).toBe('include')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init!.body as string)).toMatchObject({ payload: { args: { event } } })
  })

  it('refuses an unauthenticated Web launch', async () => {
    const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async () => new Response(null, { status: 401 }))
    await expect(connectDesktopWelcome(url, send)).rejects.toThrow('Web authentication failed')
  })
})
