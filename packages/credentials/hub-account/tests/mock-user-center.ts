/**
 * A loopback stand-in for the user center's OAuth2 endpoints, enough for Hub sign-in: authorize
 * (redirecting straight back with a code, as a browser with a signed-in session and a recorded
 * consent would), token (authorization_code with PKCE S256, refresh_token with rotation), userinfo,
 * and revoke. Shared by the package specs and the Desktop web e2e.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

/** One tenant the mock employee can sign in to. */
export interface MockTenant {
  readonly tenantId: string
  readonly tenantName: string
}

/** Control and observation surface of the mock user center. */
export interface MockUserCenter {
  readonly origin: string
  readonly clientId: string
  /** Tenant the next authorization binds to (the tenant picked on the consent page). */
  tenant: MockTenant
  /** When set, `/oauth/authorize` answers with this OAuth error instead of a code. */
  denyWith: string | undefined
  /** When set, refresh answers with this HTTP status (400 = invalid_grant, 500 = outage). */
  refreshStatus: number | undefined
  /** access token lifetime handed out, in seconds. */
  expiresIn: number
  /** When set, the code exchange answers with this HTTP status. */
  exchangeStatus: number | undefined
  /** When set, every successful token response carries this raw body instead. */
  tokenBody: string | undefined
  /** When set, token responses wait for this promise first. */
  tokenGate: Promise<unknown> | undefined
  /** When set, userinfo answers with this status and raw body. */
  userinfoReply: { status: number; body: string } | undefined
  /** Every `/oauth/authorize` query, in order. */
  readonly authorizeRequests: URLSearchParams[]
  /** Every token request body, in order. */
  readonly tokenRequests: URLSearchParams[]
  /** Refresh tokens revoked through `/oauth/revoke`. */
  readonly revoked: string[]
  close(): Promise<void>
}

const PROFILE = { nickname: '李雷', phone: '138****0001', isTenantAdmin: false }

async function body(req: IncomingMessage): Promise<URLSearchParams> {
  let text = ''
  for await (const chunk of req) text += String(chunk)
  return new URLSearchParams(text)
}

/**
 * Start the mock on an ephemeral loopback port.
 * @param tenant - initial tenant binding.
 * @returns the running mock.
 */
export async function startMockUserCenter(tenant: MockTenant = { tenantId: 't-a', tenantName: '甲公司' }): Promise<MockUserCenter> {
  const codes = new Map<string, { challenge: string; redirectUri: string; tenant: MockTenant }>()
  const access = new Map<string, MockTenant>()
  const refresh = new Map<string, MockTenant>()
  const issue = (bound: MockTenant) => {
    const accessToken = `at-${randomBytes(8).toString('hex')}`
    const refreshToken = `rt-${randomBytes(8).toString('hex')}`
    access.set(accessToken, bound)
    refresh.set(refreshToken, bound)
    return { access_token: accessToken, token_type: 'Bearer', expires_in: mock.expiresIn, refresh_token: refreshToken, scope: 'profile skills:read skills:write' }
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (url.pathname === '/oauth/authorize') {
        const q = url.searchParams
        mock.authorizeRequests.push(q)
        const back = new URL(q.get('redirect_uri')!)
        back.searchParams.set('state', q.get('state') ?? '')
        if (mock.denyWith !== undefined) back.searchParams.set('error', mock.denyWith)
        else {
          const code = randomBytes(8).toString('hex')
          codes.set(code, { challenge: q.get('code_challenge') ?? '', redirectUri: q.get('redirect_uri')!, tenant: mock.tenant })
          back.searchParams.set('code', code)
        }
        res.writeHead(302, { location: back.href }).end()
      } else if (url.pathname === '/oauth/token' && req.method === 'POST') {
        const form = await body(req)
        mock.tokenRequests.push(form)
        await mock.tokenGate
        const reply = (value: unknown) => {
          if (mock.tokenBody === undefined) json(200, value)
          else res.writeHead(200, { 'content-type': 'application/json' }).end(mock.tokenBody)
        }
        if (form.get('client_id') !== mock.clientId) { json(401, { error: 'invalid_client' }); return }
        if (form.get('grant_type') === 'authorization_code') {
          const entry = codes.get(form.get('code') ?? '')
          codes.delete(form.get('code') ?? '')
          const verified = entry !== undefined && entry.redirectUri === form.get('redirect_uri')
            && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === entry.challenge
          if (!verified) { json(400, { error: 'invalid_grant' }); return }
          if (mock.exchangeStatus !== undefined) { json(mock.exchangeStatus, { error: 'server_error' }); return }
          reply(issue(entry.tenant))
        } else {
          if (mock.refreshStatus !== undefined) { json(mock.refreshStatus, { error: 'invalid_grant' }); return }
          const bound = refresh.get(form.get('refresh_token') ?? '')
          if (bound === undefined) { json(400, { error: 'invalid_grant' }); return }
          refresh.delete(form.get('refresh_token')!)
          reply(issue(bound))
        }
      } else if (url.pathname === '/oauth/userinfo' && mock.userinfoReply !== undefined) {
        res.writeHead(mock.userinfoReply.status, { 'content-type': 'application/json' }).end(mock.userinfoReply.body)
      } else if (url.pathname === '/oauth/userinfo') {
        const bound = access.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
        if (bound === undefined) { json(401, { error: 'invalid_token' }); return }
        json(200, { ...PROFILE, ...bound })
      } else if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
        const token = (await body(req)).get('token') ?? ''
        mock.revoked.push(token)
        refresh.delete(token)
        res.writeHead(200).end()
      } else res.writeHead(404).end()
    })()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const mock: MockUserCenter = {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    clientId: 'dsh-desktop',
    tenant, denyWith: undefined, refreshStatus: undefined, expiresIn: 7200,
    exchangeStatus: undefined, tokenBody: undefined, tokenGate: undefined, userinfoReply: undefined,
    authorizeRequests: [], tokenRequests: [], revoked: [],
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
  return mock
}

/**
 * Play the system browser: open the authorization page and follow redirects back to the loopback
 * callback, returning the page the callback served.
 * @param authorizeUrl - page the sign-in attempt published.
 * @returns final status and body text.
 */
export async function browse(authorizeUrl: string): Promise<{ status: number; text: string }> {
  const res = await fetch(authorizeUrl)
  return { status: res.status, text: await res.text() }
}
