/** Native welcome operations using the shared Web authentication and RPC APIs. */
import { randomUUID } from 'node:crypto'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import type { ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
import { desktopAccountBackend, type DesktopAccountBackend } from './account-backend.ts'
import { desktopHubBackend, type DesktopHubBackend } from './hub-backend.ts'

/** Metadata needed before the native entry or workspace becomes visible. */
export interface WelcomeState {
  /** User-center sign-in state; the workspace opens only while signed in. */
  readonly hub: HubAccountView
  readonly localePreference: string | null
}

/** Narrow operations available to the native welcome flow. */
export interface DesktopWelcomeBackend {
  /** @returns the current Host policy; every read observes live configuration. */
  analyticsEnabled(): Promise<boolean>
  /** DeepSeek account sign-in started from the workspace. */
  readonly account: DesktopAccountBackend
  /** User-center sign-in; fails when the Host mounts no user center. */
  readonly hub: DesktopHubBackend
  /** @param event - desktop-owned fields. @returns after local Host intake. */
  report(event: ProductEvent): Promise<void>
  /** @returns the user-center sign-in state and the shared language preference. */
  read(): Promise<WelcomeState>
  /** @returns The saved UI language without sign-in requests. */
  readLocalePreference(): Promise<string | null>
  /** @returns whether any configurable model provider has a stored API key, without credential values. */
  hasApiKey(): Promise<boolean>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Authenticate the native HTTP client through the Web application's launch URL.
 * @param authenticatedUrl - URL supplied by the running Desktop Host.
 * @param send - Electron session fetch, retaining the Web authentication cookie.
 * @returns sign-in, language, and analytics operations over standard RPC.
 */
export async function connectDesktopWelcome(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  cookies: () => Promise<string> = () => Promise.resolve(''),
): Promise<DesktopWelcomeBackend> {
  const origin = new URL(authenticatedUrl).origin
  const authenticated = await send(authenticatedUrl, { credentials: 'include' })
  await authenticated.body?.cancel()
  if (!authenticated.ok) throw new Error('desktop welcome: Web authentication failed')
  const invoke = async (
    request: { namespace: string; method: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const rpcId = randomUUID()
    const method = `${request.namespace}/${request.method}`
    const response = await send(new URL(`/api/${method}`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error', ...(signal === undefined ? {} : { signal }),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) throw new Error('desktop welcome: Web request failed')
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('desktop welcome: Web RPC failed')
    }
    return envelope.result.value
  }
  const account = desktopAccountBackend(origin, invoke, cookies)
  const hub = desktopHubBackend(origin, invoke, cookies)
  const describeSettings = async (): Promise<unknown[]> => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
    const namespaces: unknown[] = settings.namespaces
    return namespaces
  }
  const localePreference = (namespaces: unknown[]): string | null => {
    const locale: unknown = namespaces.find((item: unknown) => record(item) && item.ns === 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop welcome: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  const hasApiKey = async (): Promise<boolean> => {
    const namespaces = await describeSettings()
    const official: unknown = namespaces.find((item: unknown) => record(item) && item.ns === 'llm-deepseek')
    if (official !== undefined && (!record(official) || !record(official.value) || typeof official.value.apiKeyEnv !== 'string')) {
      throw new Error('desktop welcome: missing official DeepSeek credential reference')
    }
    const providers = await invoke({ namespace: 'llm', method: 'listConfigurableProviders', args: {} })
    if (!Array.isArray(providers)) throw new Error('desktop welcome: invalid provider directory')
    const refs = providers.flatMap((provider: unknown) => {
      if (!record(provider) || typeof provider.settingsNs !== 'string' || !Array.isArray(provider.settingsPath)) {
        throw new Error('desktop welcome: invalid provider settings address')
      }
      const namespace: unknown = namespaces.find((item: unknown) => record(item) && item.ns === provider.settingsNs)
      let value: unknown = record(namespace) ? namespace.value : undefined
      for (const key of provider.settingsPath as unknown[]) {
        if (typeof key !== 'string') throw new Error('desktop welcome: invalid provider settings path')
        value = record(value) ? value[key] : undefined
      }
      return record(value) && typeof value.apiKeyEnv === 'string' ? [value.apiKeyEnv] : []
    })
    const unique = [...new Set([...(record(official) && record(official.value) ? [String(official.value.apiKeyEnv)] : []), ...refs])]
    const states: Record<string, unknown> = {}
    // credentials.describe accepts at most 64 references per request.
    for (let offset = 0; offset < unique.length; offset += 64) {
      const batch = await invoke({ namespace: 'credentials', method: 'describe', args: { refs: unique.slice(offset, offset + 64) } })
      if (!record(batch)) throw new Error('desktop welcome: invalid credential metadata')
      Object.assign(states, batch)
    }
    return Object.values(states).some(value => record(value) && value.configured === true)
  }
  const read = async (): Promise<WelcomeState> => ({ hub: await hub.state(), localePreference: localePreference(await describeSettings()) })
  return {
    account,
    hub,
    read,
    async analyticsEnabled() {
      const enabled = await invoke({ namespace: 'productAnalytics', method: 'enabled', args: {} }, AbortSignal.timeout(1000))
      if (typeof enabled !== 'boolean') throw new Error('desktop analytics: invalid collection policy')
      return enabled
    },
    async report(event) { await invoke({ namespace: 'productAnalytics', method: 'report', args: { event } }, AbortSignal.timeout(1000)) },
    async readLocalePreference() { return localePreference(await describeSettings()) },
    hasApiKey,
  }
}
