/**
 * A loopback stand-in for the user center's OAuth2 endpoints, enough for Hub sign-in: authorize
 * (redirecting straight back with a code, as a browser with a signed-in session and a recorded
 * consent would), token (authorization_code with PKCE S256, refresh_token with rotation), userinfo,
 * and revoke; the client Skill and login-page branding APIs. Shared by the package specs and the
 * Desktop web e2e.
 */
import { createHash, randomBytes } from 'node:crypto'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { createServer, type IncomingMessage, type Server } from 'node:http'

/** One tenant the mock employee can sign in to. */
export interface MockTenant {
  readonly tenantId: string
  readonly tenantName: string
}

/** One published Skill the mock serves through `/api/client/skills`. */
export interface MockSkill {
  readonly id: string
  readonly name: string
  /** Display name (T93); left out, the answers omit it as a user center before T93 does. */
  readonly displayName?: string
  readonly description: string
  readonly category: { readonly id: string; readonly name: string } | null
  readonly version: string
  /** Files relative to the Skill root; `SKILL.md` is generated from name and description when absent. */
  readonly files?: Readonly<Record<string, string>>
}

/** One upload the mock received through the client write API. */
export interface MockUpload {
  /** `/api/client/skills` or `/api/client/skills/:id/versions`. */
  readonly path: string
  /** Form fields other than the file; repeated fields are arrays. */
  readonly fields: Readonly<Record<string, string | string[]>>
  /** Entries of the uploaded zip. */
  readonly entries: readonly string[]
}

/** A Skill the signed-in employee owns on the mock Hub (what `/mine` reports). */
export interface MockOwnedSkill {
  readonly id: string
  readonly name: string
  /** Display name (T93); left out, the answers omit it. */
  readonly displayName?: string
  readonly versions: { readonly version: string; readonly status: 'published' | 'pending' }[]
}

/** Branding a tenant set (T30, T45); unset items are null. */
export interface MockBranding {
  readonly title: string | null
  /** New-session slogan (T45); left out, the answer omits it as a user center before T45 does. */
  readonly slogan?: string | null
  readonly logo: { readonly contentType: string; readonly data: Buffer } | null
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
  /** Skills visible to every tenant through the client API, in list order. */
  skills: MockSkill[]
  /** When set, a download answers with these bytes instead of the Skill's zip. */
  downloadBody: Uint8Array | undefined
  /** When set, client API calls answer with this status. */
  clientStatus: number | undefined
  /** Every client API path requested, with its query. */
  readonly clientRequests: string[]
  /** Whether the signed-in employee administers the tenant: uploads then publish directly. */
  tenantAdmin: boolean
  /** Skills the signed-in employee owns. */
  readonly owned: MockOwnedSkill[]
  /** Every upload received. */
  readonly uploads: MockUpload[]
  /** When set, an upload is answered with this raw reply, or its connection is dropped. */
  uploadReply: { status: number; body: string } | 'drop' | undefined
  /** Called when an upload arrives, before it is answered. */
  uploadHook: (() => Promise<void> | void) | undefined
  /** When set, the upload form's visibility options are answered with this raw reply. */
  optionsReply: { status: number; body: string } | undefined
  /** Branding per tenant id; a tenant without an entry has set nothing. */
  brandings: Record<string, MockBranding>
  /** When set, the next branding request waits for this promise first; later ones do not. */
  brandingGate: Promise<unknown> | undefined
  /** When set, the logo download answers with this raw reply instead. */
  logoReply: { status: number; contentType?: string; body: Buffer } | undefined
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
      } else if (url.pathname.startsWith('/api/client/')) {
        mock.clientRequests.push(`${url.pathname}${url.search}`)
        if (access.get((req.headers.authorization ?? '').replace(/^Bearer /, '')) === undefined) { json(401, { message: 'invalid_token' }); return }
        if (mock.clientStatus !== undefined) { json(mock.clientStatus, { message: 'unavailable' }); return }
        const bound = access.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))!
        if (url.pathname === '/api/client/branding') {
          const gate = mock.brandingGate
          mock.brandingGate = undefined
          await gate
        }
        if (url.pathname.startsWith('/api/client/branding')) brandingApi(url, res, json, bound)
        else await clientApi(url, req, res, json)
      } else if (url.pathname === '/oauth/userinfo' && mock.userinfoReply !== undefined) {
        res.writeHead(mock.userinfoReply.status, { 'content-type': 'application/json' }).end(mock.userinfoReply.body)
      } else if (url.pathname === '/oauth/userinfo') {
        const bound = access.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
        if (bound === undefined) { json(401, { error: 'invalid_token' }); return }
        json(200, { ...PROFILE, ...bound, isTenantAdmin: mock.tenantAdmin })
      } else if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
        const token = (await body(req)).get('token') ?? ''
        mock.revoked.push(token)
        refresh.delete(token)
        res.writeHead(200).end()
      } else res.writeHead(404).end()
    })()
  })
  const filesOf = (skill: MockSkill): Record<string, string> => ({
    'SKILL.md': `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\nUse ${skill.name}.\n`,
    ...skill.files,
  })
  const summary = (skill: MockSkill) => ({
    id: skill.id, name: skill.name, ...skill.displayName === undefined ? {} : { displayName: skill.displayName }, category: skill.category,
    currentVersion: { id: `${skill.id}-v`, version: skill.version, description: skill.description, uploaderName: '韩梅梅',
      uploadedAt: '2026-10-01T08:00:00.000Z', sizeBytes: 100, fileCount: Object.keys(filesOf(skill)).length, downloadCount: 0 },
  })
  const versionRule = /^\d+\.\d+\.\d+$/
  const later = (a: string, b: string) => {
    const x = a.split('.').map(Number); const y = b.split('.').map(Number)
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! > y[i]!
    return false
  }
  const upload = async (url: URL, req: IncomingMessage, json: (status: number, value: unknown) => void, existingId: string | undefined) => {
    const raw: Buffer[] = []
    for await (const chunk of req) raw.push(chunk as Buffer)
    const form = await new Response(Buffer.concat(raw), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData()
    const fields: Record<string, string | string[]> = {}
    for (const [key, value] of form.entries()) {
      if (typeof value !== 'string') continue
      const previous = fields[key]
      fields[key] = previous === undefined ? value : [...[previous].flat(), value]
    }
    const file = form.get('file') as Blob
    const entries = Object.keys(unzipSync(new Uint8Array(await file.arrayBuffer())))
    mock.uploads.push({ path: url.pathname, fields, entries })
    const version = String(fields.version ?? '')
    if (!versionRule.test(version)) { json(400, { message: '版本号格式应为 x.y.z（如 1.0.0）' }); return }
    const name = entries[0]!.split('/')[0]!
    let owned = mock.owned.find(skill => skill.id === existingId)
    if (existingId === undefined) {
      if (mock.owned.some(skill => skill.name === name) || mock.skills.some(skill => skill.name === name)) {
        json(409, { message: `本租户已存在名为「${name}」的 Skill，请到该 Skill 详情页上传新版本` }); return
      }
      // Like the T93 Hub: a new Skill without a display name takes its slug
      owned = { id: `s-up-${mock.owned.length + 1}`, name, displayName: typeof fields.displayName === 'string' ? fields.displayName.trim() : name, versions: [] }
      mock.owned.push(owned)
    } else {
      if (owned === undefined) { json(403, { message: '只有所有者或租户管理员可以上传新版本' }); return }
      const pending = owned.versions.find(v => v.status === 'pending')
      if (pending !== undefined) { json(409, { message: `该 Skill 已有未成为正式的版本 ${pending.version}（审核中），请先处理后再上传新版本` }); return }
      const highest = owned.versions.map(v => v.version).reduce((a, b) => (later(a, b) ? a : b))
      if (!later(version, highest)) { json(400, { message: `新版本号必须高于已有的最高版本 ${highest}` }); return }
    }
    const status = mock.tenantAdmin ? 'published' as const : 'pending' as const
    owned.versions.push({ version, status })
    if (status === 'published') {
      const ownedId = owned.id
      mock.skills = [...mock.skills.filter(skill => skill.id !== ownedId), { id: ownedId, name, ...owned.displayName === undefined ? {} : { displayName: owned.displayName }, description: `${name} uploaded`, category: null, version }]
    }
    const versionId = `${owned.id}-v${owned.versions.length}`
    json(201, {
      skillId: owned.id, name, ...owned.displayName === undefined ? {} : { displayName: owned.displayName }, version: { id: versionId, version, description: '', uploaderName: '李雷', uploadedAt: '2026-10-04T00:00:00.000Z', sizeBytes: 1, fileCount: entries.length, downloadCount: 0 },
      status, reviewPath: status === 'pending' ? `/skills/review/${versionId}` : null,
      reviewUrl: status === 'pending' ? `${mock.origin}/skills/review/${versionId}` : null,
    })
  }
  const clientApi = async (url: URL, req: IncomingMessage, res: import('node:http').ServerResponse, json: (status: number, value: unknown) => void): Promise<void> => {
    const parts = url.pathname.slice('/api/client/skills'.length).split('/').filter(Boolean)
    if (req.method === 'POST') {
      await mock.uploadHook?.()
      if (mock.uploadReply === 'drop') { res.destroy(); return }
      if (mock.uploadReply !== undefined) { res.writeHead(mock.uploadReply.status, { 'content-type': 'application/json' }).end(mock.uploadReply.body); return }
      await upload(url, req, json, parts[1] === 'versions' ? parts[0] : undefined)
      return
    }
    if (parts[0] === 'mine') {
      json(200, mock.owned.map((skill) => {
        const published = skill.versions.filter(v => v.status === 'published').at(-1)
        const working = skill.versions.find(v => v.status === 'pending')
        return { id: skill.id, name: skill.name, ...skill.displayName === undefined ? {} : { displayName: skill.displayName }, highestVersion: skill.versions.at(-1)!.version, currentVersion: published?.version ?? null, workingStatus: working === undefined ? null : 'pending' }
      }))
      return
    }
    if (parts[0] === 'visibility-options') {
      if (mock.optionsReply !== undefined) { res.writeHead(mock.optionsReply.status, { 'content-type': 'application/json' }).end(mock.optionsReply.body); return }
      json(200, {
        departments: [{ id: 'd-root', parentId: null, name: '甲公司' }, { id: 'd-rd', parentId: 'd-root', name: '研发部' }],
        employees: [{ id: 'e-li', name: '李雷', departmentName: '研发部' }, { id: 'e-han', name: '韩梅梅', departmentName: '甲公司' }],
      })
      return
    }
    if (parts.length === 0) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const categoryId = url.searchParams.get('categoryId')
      const page = Number(url.searchParams.get('page') ?? 1)
      const pageSize = Number(url.searchParams.get('pageSize') ?? 20)
      const matched = mock.skills.filter(skill => (q === '' || skill.name.includes(q) || (skill.displayName ?? '').includes(q) || skill.description.toLowerCase().includes(q))
        && (categoryId === null || skill.category?.id === categoryId))
      json(200, { items: matched.slice((page - 1) * pageSize, page * pageSize).map(summary), total: matched.length, page, pageSize })
      return
    }
    if (parts[0] === 'categories') {
      const seen = new Map(mock.skills.flatMap(skill => skill.category === null ? [] : [[skill.category.id, skill.category]] as const))
      json(200, [...seen.values()])
      return
    }
    const skill = mock.skills.find(item => item.id === parts[0])
    if (skill === undefined) { json(404, { message: 'Skill 不存在' }); return }
    const files = filesOf(skill)
    if (parts[1] === 'download') {
      const zip = mock.downloadBody ?? zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [`${skill.name}/${path}`, strToU8(text)])))
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${skill.name}-${skill.version}.zip"` }).end(Buffer.from(zip))
      return
    }
    json(200, {
      ...summary(skill), description: skill.description, ownerName: '韩梅梅', updatedAt: '2026-10-01T08:00:00.000Z', skillMd: files['SKILL.md'],
      files: Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, text]) => ({
        path, size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'),
      })),
    })
  }
  const brandingApi = (url: URL, res: import('node:http').ServerResponse, json: (status: number, value: unknown) => void, bound: MockTenant): void => {
    const branding = mock.brandings[bound.tenantId]
    const logo = branding?.logo ?? null
    if (url.pathname === '/api/client/branding') {
      json(200, {
        tenantId: bound.tenantId, title: branding?.title ?? null, ...branding?.slogan === undefined ? {} : { slogan: branding.slogan }, updatedAt: branding === undefined ? null : '2026-10-05T00:00:00.000Z',
        logo: logo === null ? null : { url: `${mock.origin}/api/client/branding/logo`, contentType: logo.contentType, sha256: createHash('sha256').update(logo.data).digest('hex') },
      })
    } else if (mock.logoReply !== undefined) {
      res.writeHead(mock.logoReply.status, mock.logoReply.contentType === undefined ? {} : { 'content-type': mock.logoReply.contentType }).end(mock.logoReply.body)
    } else if (logo === null) json(404, { message: '未设置 Logo' })
    else res.writeHead(200, { 'content-type': logo.contentType }).end(logo.data)
  }
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const mock: MockUserCenter = {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    clientId: 'dsh-desktop',
    tenant, denyWith: undefined, refreshStatus: undefined, expiresIn: 7200,
    exchangeStatus: undefined, tokenBody: undefined, tokenGate: undefined, userinfoReply: undefined,
    skills: [], downloadBody: undefined, clientStatus: undefined, clientRequests: [],
    tenantAdmin: false, owned: [], uploads: [], uploadReply: undefined, uploadHook: undefined, optionsReply: undefined,
    brandings: {}, brandingGate: undefined, logoReply: undefined,
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
