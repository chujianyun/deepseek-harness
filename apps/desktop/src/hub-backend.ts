/** Native user-center (Skill Hub) sign-in commands and state stream; no renderer receives tokens. */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import type { HubAccountView, HubBrandingStamp, HubProfile, HubSignInAttemptView, HubSignInError, HubSignInPhase } from '@deepseek-ai/dsh-hub-account/types'

/** Authenticated unary caller shared with native onboarding. */
export type HubInvoke = (request: { namespace: string; method: string; args: Record<string, unknown> }) => Promise<unknown>

const PHASES = ['waiting-browser', 'exchanging', 'succeeded', 'cancelled', 'failed']
const ERRORS = ['denied', 'expired', 'protocol', 'network', 'storage']

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** Only HTTP loopback or HTTPS destinations can leave the native app. */
function validateBrowserDestination(value: string): void {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))) {
    throw new Error('desktop hub: invalid browser destination')
  }
}

function profileView(value: unknown): HubProfile | null {
  if (value === null) return null
  if (!record(value) || typeof value.nickname !== 'string' || typeof value.phone !== 'string'
    || !nullableString(value.tenantId) || !nullableString(value.tenantName)
    || !(value.isTenantAdmin === null || typeof value.isTenantAdmin === 'boolean')) {
    throw new Error('desktop hub: invalid profile')
  }
  return {
    nickname: value.nickname, phone: value.phone,
    tenantId: value.tenantId, tenantName: value.tenantName, isTenantAdmin: value.isTenantAdmin,
  }
}

function attemptView(value: unknown): HubSignInAttemptView | null {
  if (value === null) return null
  if (!record(value) || typeof value.id !== 'string' || typeof value.phase !== 'string' || !PHASES.includes(value.phase)
    || (value.authorizeUrl !== undefined && typeof value.authorizeUrl !== 'string')
    || (value.error !== undefined && (typeof value.error !== 'string' || !ERRORS.includes(value.error)))) {
    throw new Error('desktop hub: invalid attempt')
  }
  if (typeof value.authorizeUrl === 'string') validateBrowserDestination(value.authorizeUrl)
  return {
    id: value.id, phase: value.phase as HubSignInPhase,
    ...typeof value.authorizeUrl === 'string' ? { authorizeUrl: value.authorizeUrl } : {},
    ...value.error === undefined ? {} : { error: value.error as HubSignInError },
  }
}

function brandingStamp(value: unknown): HubBrandingStamp | null {
  if (value === null) return null
  if (!record(value) || typeof value.tenantId !== 'string' || !nullableString(value.title) || !nullableString(value.slogan)
    || !nullableString(value.logoSha256)) {
    throw new Error('desktop hub: invalid branding')
  }
  return { tenantId: value.tenantId, title: value.title, slogan: value.slogan, logoSha256: value.logoSha256 }
}

/**
 * Decode the sign-in state received across HTTP or WebSocket.
 * @param value - wire value.
 * @returns the validated state.
 */
export function hubView(value: unknown): HubAccountView {
  if (!record(value) || (value.status !== 'signed-out' && value.status !== 'signed-in')
    || (value.reason !== null && value.reason !== 'expired')) {
    throw new Error('desktop hub: invalid state')
  }
  return {
    status: value.status, profile: profileView(value.profile), reason: value.reason, attempt: attemptView(value.attempt),
    branding: brandingStamp(value.branding),
  }
}

/** Native sign-in operations and explicitly owned stream lifetime. */
export interface DesktopHubBackend {
  /** @returns the current sign-in state. */
  state(): Promise<HubAccountView>
  /** @returns the state with a new or already-running sign-in attempt. */
  start(): Promise<HubAccountView>
  /** @param id - attempt to cancel. @returns the settled state. */
  cancel(id: string): Promise<HubAccountView>
  /**
   * @param listener - state recipient.
   * @param failed - stream failure recipient; the stream reconnects on its own.
   * @param onAnalyticsEnabledChanged - optional Desktop collection-policy recipient; disconnected streams publish false.
   * @returns stream disposer.
   */
  watch(listener: (state: HubAccountView) => void, failed: () => void, onAnalyticsEnabledChanged?: (enabled: boolean) => void): () => void
}

/**
 * Connect native sign-in operations to the standard authenticated Web backend.
 * @param origin - Host Web origin.
 * @param invoke - validated unary RPC caller.
 * @param cookies - Electron session cookie reader.
 * @returns sign-in operations; watch callers own their subscriptions.
 */
export function desktopHubBackend(origin: string, invoke: HubInvoke, cookies: () => Promise<string>): DesktopHubBackend {
  const call = async (method: string, args: Record<string, unknown> = {}): Promise<HubAccountView> =>
    hubView(await invoke({ namespace: 'hubAccount', method, args }))
  return {
    state: () => call('getState'),
    start: () => call('signIn'),
    cancel: attemptId => call('cancelSignIn', { attemptId }),
    watch(listener, failed, onAnalyticsEnabledChanged) {
      let closed = false
      let socket: WebSocket | undefined
      let retry: ReturnType<typeof setTimeout> | undefined
      const reconnect = (): void => {
        if (closed) return
        onAnalyticsEnabledChanged?.(false)
        failed()
        retry = setTimeout(connect, 1000)
      }
      const connect = (): void => {
        const streamId = randomUUID()
        const analyticsPolicyStreamId = randomUUID()
        void cookies().then((cookie) => {
          if (closed) return
          const url = new URL(REMOTE_STREAM_MUX_PATH, origin)
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
          socket = new WebSocket(url, { headers: { cookie, origin }, maxPayload: 65_536 })
          socket.on('open', () => {
            if (onAnalyticsEnabledChanged !== undefined) socket?.send(JSON.stringify({ type: 'open', streamId: analyticsPolicyStreamId, endpoint: 'productAnalytics/watchPolicy', payload: { args: {} } }))
            socket?.send(JSON.stringify({ type: 'open', streamId, endpoint: 'hubAccount/watch', payload: { args: {} } }))
          })
          socket.on('message', (data) => {
            try {
              const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
              const frame = parseRemoteStreamServerMessage(bytes.toString('utf8'))
              if (frame.streamId === analyticsPolicyStreamId) {
                onAnalyticsEnabledChanged?.(frame.type === 'item' && frame.value === true)
                return
              }
              if (frame.streamId !== streamId) throw new Error('desktop hub: unexpected stream')
              if (frame.type === 'item') listener(hubView(frame.value))
              else socket?.close()
            } catch { socket?.close() }
          })
          socket.on('error', () => { socket?.close() })
          socket.on('close', reconnect)
        }).catch(reconnect)
      }
      connect()
      return () => { closed = true; onAnalyticsEnabledChanged?.(false); clearTimeout(retry); socket?.close() }
    },
  }
}
