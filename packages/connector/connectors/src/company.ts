/**
 * Company tools: connectors the user center gives the signed-in tenant, such as 吉客云 (Jackyun).
 * Their credentials stay on the user center: the model shell's `<name>` command reaches a loopback
 * endpoint of this Host with a token of its own shell call, and the Host forwards the call to the user
 * center as the signed-in employee, which signs it and calls the platform. Each call is allowed only
 * the methods the company allowed; one that would overwrite existing goods runs only after the user
 * approved that shell call.
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { JACKYUN_DOCS } from './jackyun-docs.ts'
import type { CompanyToolsStatus, CompanyToolView } from './types.ts'

/** A company tool as the user center lists it (`GET /api/client/connectors`). */
export interface CompanyTool {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly autoInstall: boolean
  readonly allowedMethods: readonly string[]
}

/** One row of the user center's list; rows that do not match are left out. */
const toolRow = z.object({
  id: z.string(), kind: z.string(), name: z.string(), displayName: z.string(), description: z.string(),
  autoInstall: z.boolean(), allowedMethods: z.array(z.string()),
})

/** The tool kinds this release has a command for. */
const KINDS: ReadonlySet<string> = new Set(['jackyun'])
/** A command name the scripts can carry as is. */
const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/u
/** The flag that asks to overwrite existing goods; a shell call with it waits for the user. */
export const OVERWRITE_FLAG = '--confirm-overwrite'
/** The most a call's form may hold. */
const MAX_BODY = 1024 * 1024

/** The shell call a token was given to. */
interface Grant {
  readonly callId: ToolCallId
  readonly tenantId: string
}

/** What the endpoint answers: the HTTP status and the text the command prints. */
interface Reply {
  readonly status: number
  readonly body: string
}

/** What the Host lends the company tools. */
export interface CompanyHost {
  /** Call a user-center client API as the signed-in employee. */
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  /** The signed-in tenant. */
  readonly tenant: () => string | null
  /** Whether the tenant keeps a tool on, from its own choice or the company's auto-install. */
  readonly enabled: (tool: CompanyTool) => boolean
  /** The state changed. */
  readonly changed: () => void
  /** Where failures the user does not see are reported. */
  readonly logger: { warn(message: string): void }
}

/** The company tools of the signed-in tenant, the commands that reach them, and the approvals they wait for. */
export class CompanyTools {
  private tools: readonly CompanyTool[] = []
  private status: CompanyToolsStatus = 'signed-out'
  /** The tenant {@link tools} belong to. */
  private listedFor: string | null = null
  private readonly grants = new Map<string, Grant>()
  private readonly tokens = new Map<ToolCallId, string>()
  /** Shell calls the user approved to overwrite existing goods, with how many overwriting calls each may still make. */
  private readonly overwrites = new Map<ToolCallId, number>()
  private port = 0
  private writes: Promise<void> = Promise.resolve()
  /** The tenant and commands last written. */
  private written: string | undefined
  private refreshing: { readonly tenant: string | null; readonly read: Promise<void> } | undefined

  /** @param host - the Hub sign-in and the tenant's switches. @param bin - where the commands are written, per tenant. */
  constructor(private readonly host: CompanyHost, private readonly bin: string) {}

  /**
   * Listen on a free loopback port.
   * @returns a function that stops listening.
   */
  /* jscpd:ignore-start -- the same loopback endpoint shape as the e-commerce accounts bridge, in an unrelated package. */
  async start(): Promise<() => Promise<void>> {
    const server = createServer((request, response) => {
      void readBody(request)
        .then(body => body === undefined ? { status: 413, body: 'DSH: the request is too large.' } : this.handle(request.url as string, body))
        .catch((error: unknown) => ({ status: 500, body: `DSH: the company tool could not answer: ${String(error)}` }))
        .then(({ status, body }) => { response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(body) })
    })
    await new Promise<void>((resolve) => { server.listen({ host: '127.0.0.1', port: 0 }, resolve) })
    this.port = (server.address() as { port: number }).port
    return async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      // A command write still under way would recreate files in a directory its owner is deleting.
      await this.writes
    }
  }
  /* jscpd:ignore-end */

  /**
   * The cards of the tenant's company tools.
   * @returns the status of the list and the tools in the user center's order.
   */
  view(): { readonly status: CompanyToolsStatus; readonly tools: readonly CompanyToolView[] } {
    const current = this.current()
    return {
      status: this.host.tenant() === null ? 'signed-out' : this.status,
      tools: current.map(tool => ({
        name: tool.name, kind: tool.kind, displayName: tool.displayName, description: tool.description,
        methods: tool.allowedMethods, enabled: this.host.enabled(tool),
      })),
    }
  }

  /**
   * A tool of the tenant by name.
   * @param name - the tool's name.
   * @returns the tool, or undefined.
   */
  find(name: string): CompanyTool | undefined {
    return this.current().find(tool => tool.name === name)
  }

  /**
   * The tools whose command the model shell has now.
   * @returns the tenant's tools that are on, in the user center's order.
   */
  enabledTools(): readonly CompanyTool[] {
    return this.current().filter(tool => this.host.enabled(tool))
  }

  /**
   * Read the tenant's tools from the user center again; one read at a time.
   * @returns once read, whether or not the user center answered.
   */
  refresh(): Promise<void> {
    const tenant = this.host.tenant()
    // A read for a tenant switched away from does not stand in for the new tenant's.
    if (this.refreshing?.tenant === tenant) return this.refreshing.read
    const entry = { tenant, read: this.read(tenant).finally(() => { if (this.refreshing === entry) this.refreshing = undefined }) }
    this.refreshing = entry
    return entry.read
  }

  /** The tenant switched or signed out: forget the old tenant's tools and read the new one's. */
  async switched(): Promise<void> {
    this.tools = []
    this.listedFor = null
    this.status = this.host.tenant() === null ? 'signed-out' : 'loading'
    void this.sync()
    if (this.host.tenant() !== null) await this.refresh()
  }

  /**
   * Write the commands of the tools that are on, for the current tenant, and only those.
   * @returns once written.
   */
  sync(): Promise<void> {
    const tenant = this.host.tenant()
    const names = this.enabledTools().map(tool => tool.name)
    // Rewritten only when the tenant or its commands change, so a command never vanishes under a running call.
    const written = `${String(tenant)}\n${names.join('\n')}`
    if (written === this.written) return this.writes
    this.written = written
    this.writes = this.writes.then(async () => {
      // Other tenants' commands go; the current tenant's are written before stale ones are removed.
      for (const entry of await readdir(this.bin).catch(() => [])) {
        if (entry !== tenant) await rm(join(this.bin, entry), { recursive: true, force: true })
      }
      if (tenant === null) return
      const dir = join(this.bin, tenant)
      await mkdir(dir, { recursive: true })
      for (const name of names) await installCommand(dir, name, process.platform)
      const keep = new Set(names.flatMap(name => [name, `${name}.cmd`, `${name}.mjs`]))
      for (const entry of await readdir(dir)) if (!keep.has(entry)) await rm(join(dir, entry), { force: true })
    }).catch((error: unknown) => {
      // Unwritable commands are written again on the next change.
      this.written = undefined
      this.host.logger.warn(`connectors: the company tools' commands could not be written: ${String(error)}`)
    })
    return this.writes
  }

  /**
   * The directory of the tenant's commands, while one is on.
   * @returns the directory, or undefined.
   */
  scriptDir(): string | undefined {
    const tenant = this.host.tenant()
    return tenant === null || this.enabledTools().length === 0 ? undefined : join(this.bin, tenant)
  }

  /**
   * The address a shell call reaches the tools at; the same call always gets the same address.
   * @param callId - the shell call.
   * @param tenantId - the tenant signed in as the call starts; a call outlives no tenant switch.
   * @returns the address with the call's token.
   */
  urlFor(callId: ToolCallId, tenantId: string): string {
    let token = this.tokens.get(callId)
    if (token === undefined) {
      token = randomBytes(24).toString('hex')
      this.tokens.set(callId, token)
      this.grants.set(token, { callId, tenantId })
    }
    return `http://127.0.0.1:${String(this.port)}/${token}`
  }

  /**
   * The user approved a shell call that overwrites existing goods.
   * @param callId - the shell call.
   * @param uses - how many overwriting calls the user saw in it.
   */
  allowOverwrite(callId: ToolCallId, uses: number): void {
    this.overwrites.set(callId, uses)
  }

  /**
   * End a shell call's token and approval.
   * @param callId - the shell call.
   */
  revoke(callId: ToolCallId): void {
    this.overwrites.delete(callId)
    const token = this.tokens.get(callId)
    if (token === undefined) return
    this.tokens.delete(callId)
    this.grants.delete(token)
  }

  private current(): readonly CompanyTool[] {
    return this.listedFor !== null && this.listedFor === this.host.tenant() ? this.tools : []
  }

  private async read(tenant: string | null): Promise<void> {
    if (tenant === null) return
    let res: Response
    try {
      res = await this.host.request('/api/client/connectors')
    } catch {
      // Signed out meanwhile, or the user center could not be reached: keep what was listed.
      this.settle(tenant, this.status === 'loading' ? 'unavailable' : this.status)
      return
    }
    if (res.status === 403 && await scopeMissing(res)) { this.settle(tenant, 'sign-in-again'); return }
    if (res.status === 404) { this.settle(tenant, 'ready', []); return }
    if (!res.ok) { this.settle(tenant, this.status === 'loading' ? 'unavailable' : this.status); return }
    const rows = parse(await res.text().catch(() => ''))
    if (!Array.isArray(rows)) { this.settle(tenant, this.status === 'loading' ? 'unavailable' : this.status); return }
    const listed = rows.flatMap((row) => {
      const tool = toolRow.safeParse(row)
      return tool.success && KINDS.has(tool.data.kind) && COMMAND_NAME.test(tool.data.name) ? [tool.data] : []
    })
    this.settle(tenant, 'ready', listed)
  }

  /** Record what was read for a tenant, unless the tenant switched meanwhile. */
  private settle(tenant: string, status: CompanyToolsStatus, tools?: readonly CompanyTool[]): void {
    if (this.host.tenant() !== tenant) return
    this.status = status
    if (tools !== undefined) {
      this.tools = tools
      this.listedFor = tenant
    }
    this.host.changed()
  }

  private async handle(path: string, body: string): Promise<Reply> {
    const url = new URL(path, 'http://127.0.0.1')
    const [, token = '', name = '', command = ''] = url.pathname.split('/')
    const grant = this.grants.get(token)
    if (grant === undefined || grant.tenantId !== this.host.tenant()) return { status: 403, body: 'DSH: this shell call can no longer reach the company tools.' }
    const tool = this.find(name)
    if (tool === undefined || !this.host.enabled(tool)) return { status: 404, body: `DSH: the company tool "${name}" is not on. Turn it on in Connectors.` }
    if (command === 'docs') return docs(tool, url.searchParams.get('method'))
    if (command === 'call') return this.call(grant, tool, new URLSearchParams(body))
    return { status: 404, body: `DSH: unknown command "${command}".` }
  }

  private async call(grant: Grant, tool: CompanyTool, form: URLSearchParams): Promise<Reply> {
    const method = form.get('method') ?? ''
    let params: unknown
    try {
      params = JSON.parse(form.get('params') ?? '{}')
    } catch {
      return { status: 400, body: `${tool.name}: the parameters are not valid JSON.` }
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return { status: 400, body: `${tool.name}: the parameters must be a JSON object.` }
    // Each approved overwrite is used once: a shell call never overwrites more often than the user saw.
    const left = this.overwrites.get(grant.callId) ?? 0
    const confirmOverwrite = form.get('confirm') === '1' && left > 0
    if (confirmOverwrite) this.overwrites.set(grant.callId, left - 1)
    let res: Response
    try {
      res = await this.host.request(`/api/client/connectors/${encodeURIComponent(tool.name)}/call`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params, confirmOverwrite }),
      })
    } catch (error) {
      return { status: 502, body: `${tool.name}: the user center could not be reached: ${error instanceof Error ? error.message : String(error)}` }
    }
    const text = await res.text()
    const answer = parse(text)
    if (res.ok) return { status: 200, body: JSON.stringify(answer ?? text, null, 2) }
    const message = typeof answer?.message === 'string' ? answer.message : text
    if (res.status === 409 && answer?.code === 'would_overwrite') {
      return {
        status: 409,
        body: `${message}\nNothing was changed. To overwrite, run the same command again with ${OVERWRITE_FLAG}; DSH asks the user to approve it first.`,
      }
    }
    if (res.status === 403 && answer?.error === 'insufficient_scope') {
      this.settle(grant.tenantId, 'sign-in-again')
      return { status: 403, body: `${tool.name}: sign out of the user center and sign in again in DSH to use company tools.` }
    }
    // Withdrawn or no longer visible to this employee: list the tools again.
    if (res.status === 404) void this.refresh()
    return { status: res.status, body: `${tool.name}: ${message}` }
  }
}

/** Whether a 403 of the user center is the sign-in lacking the company tools' scope. */
async function scopeMissing(res: Response): Promise<boolean> {
  return parse(await res.text())?.error === 'insufficient_scope'
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    // Not JSON: the caller treats the answer as text.
    return undefined
  }
}

/** `docs list` (no method) or `docs get -m <method>`, for the methods the company allowed. */
function docs(tool: CompanyTool, method: string | null): Reply {
  if (method === null) {
    const lines = tool.allowedMethods.map(item => `${item}\t${JACKYUN_DOCS[item]?.summary ?? ''}`.trimEnd())
    return { status: 200, body: lines.length === 0 ? `${tool.name}: the company allowed no methods.` : lines.join('\n') }
  }
  if (!tool.allowedMethods.includes(method)) return { status: 404, body: `${tool.name}: ${method} is not a method the company allowed; run \`${tool.name} docs list\`.` }
  const doc = JACKYUN_DOCS[method]
  if (doc === undefined) return { status: 404, body: `${tool.name}: no reference for ${method}.` }
  return { status: 200, body: JSON.stringify({ method, ...doc }, null, 2) }
}

/* jscpd:ignore-start -- read like the e-commerce accounts bridge: the whole body, so the refusal still reaches the caller. */
async function readBody(request: AsyncIterable<Buffer>): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size <= MAX_BODY) chunks.push(chunk)
  }
  return size > MAX_BODY ? undefined : Buffer.concat(chunks).toString('utf8')
}
/* jscpd:ignore-end */

/**
 * The command for macOS and Linux: POSIX shell and curl, as the model shell has them.
 * @param name - the tool's name, which is the command's.
 * @returns the script.
 */
export function posixCommand(name: string): string {
  return `#!/bin/sh
# ${name}: a company tool of DSH, through the user center, for this DSH shell call.
tool='${name}'
usage="usage: $tool api call --method <method> [--json '<json>' | --file <json-file>] [${OVERWRITE_FLAG}] | $tool docs list | $tool docs get -m <method>"
fail() { echo "$usage" >&2; exit 2; }
if [ -z "$DSH_COMPANY_URL" ]; then
  echo "$tool: company tools are only available in a DSH shell call while DSH is signed in to the user center." >&2
  exit 2
fi
base="$DSH_COMPANY_URL/$tool"
method=''
case "$1/$2" in
  api/call)
    shift 2
    json='{}'; file=''; confirm=''
    while [ $# -gt 0 ]; do
      case "$1" in
        -m|--method) [ $# -ge 2 ] || fail; method=$2; shift 2 ;;
        --json) [ $# -ge 2 ] || fail; json=$2; shift 2 ;;
        --file) [ $# -ge 2 ] || fail; file=$2; shift 2 ;;
        ${OVERWRITE_FLAG}) confirm=1; shift ;;
        *) fail ;;
      esac
    done
    [ -n "$method" ] || fail
    if [ -n "$file" ]; then
      [ -f "$file" ] || { echo "$tool: no such file: $file" >&2; exit 2; }
      set -- --data-urlencode "params@$file"
    else
      set -- --data-urlencode "params=$json"
    fi
    set -- "$@" --data-urlencode "method=$method"
    [ -z "$confirm" ] || set -- "$@" --data-urlencode "confirm=1"
    target="$base/call" ;;
  docs/list)
    [ $# -eq 2 ] || fail
    set --; target="$base/docs" ;;
  docs/get)
    shift 2
    while [ $# -gt 0 ]; do
      case "$1" in
        -m|--method) [ $# -ge 2 ] || fail; method=$2; shift 2 ;;
        *) fail ;;
      esac
    done
    [ -n "$method" ] || fail
    set -- --get --data-urlencode "method=$method"; target="$base/docs" ;;
  *) fail ;;
esac
# The address carries this call's token: it goes to curl on stdin, not in its arguments, and never through a proxy.
out=$(printf 'url = "%s"\\n' "$target" | curl -q --noproxy '*' -sS -K - -w '\\n%{http_code}' "$@") || exit 1
code=$(printf '%s' "$out" | tail -n 1)
body=$(printf '%s' "$out" | sed '$d')
case "$code" in
  200) printf '%s\\n' "$body"; exit 0 ;;
  409) printf '%s\\n' "$body" >&2; exit 3 ;;
  *) printf '%s\\n' "$body" >&2; exit 1 ;;
esac
`
}

/**
 * The command for Windows, whose model shell is PowerShell: a Node script that behaves as {@link posixCommand} does.
 * @param name - the tool's name.
 * @returns the script.
 */
export function nodeCommand(name: string): string {
  return `// ${name}: a company tool of DSH, through the user center, for this DSH shell call.
import { readFileSync, statSync } from 'node:fs'
import { Agent, request as send } from 'node:http'
const tool = '${name}'
const usage = 'usage: ' + tool + " api call --method <method> [--json '<json>' | --file <json-file>] [${OVERWRITE_FLAG}] | " + tool + ' docs list | ' + tool + ' docs get -m <method>'
const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }
function request(argv) {
  const base = process.env.DSH_COMPANY_URL
  if (!base) return tool + ': company tools are only available in a DSH shell call while DSH is signed in to the user center.'
  const [group, action, ...rest] = argv
  const flags = { method: '', json: '{}', file: '', confirm: false }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (flag === '${OVERWRITE_FLAG}' && action === 'call') { flags.confirm = true; continue }
    const value = rest[i + 1]
    if (value === undefined) return usage
    if (flag === '-m' || flag === '--method') flags.method = value
    else if ((flag === '--json') && action === 'call') flags.json = value
    else if ((flag === '--file') && action === 'call') flags.file = value
    else return usage
    i++
  }
  const url = base + '/' + tool
  if (group === 'docs' && action === 'list' && rest.length === 0) return { url: url + '/docs' }
  if (!flags.method) return usage
  if (group === 'docs' && action === 'get') return { url: url + '/docs?method=' + encodeURIComponent(flags.method) }
  if (group !== 'api' || action !== 'call') return usage
  if (flags.file && !isFile(flags.file)) return tool + ': no such file: ' + flags.file
  const form = new URLSearchParams({ method: flags.method, params: flags.file ? readFileSync(flags.file, 'utf8') : flags.json })
  if (flags.confirm) form.set('confirm', '1')
  return { url: url + '/call', init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() } }
}
/** A loopback request that, unlike fetch, never goes through a proxy the environment names. */
function http(url, init = {}) {
  return new Promise((resolve, reject) => {
    // A fresh agent: the global one follows NODE_USE_ENV_PROXY.
    const req = send(url, { method: init.method ?? 'GET', headers: init.headers, agent: new Agent() }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => { resolve({ status: res.statusCode, body }) })
    })
    req.on('error', reject)
    req.end(init.body)
  })
}
const asked = request(process.argv.slice(2))
if (typeof asked === 'string') {
  process.stderr.write(asked + '\\n')
  process.exitCode = 2
} else {
  try {
    const response = await http(asked.url, asked.init)
    const body = response.body.replace(/\\n+$/, '') + '\\n'
    if (response.status === 200) process.stdout.write(body)
    else { process.stderr.write(body); process.exitCode = response.status === 409 ? 3 : 1 }
  } catch (error) {
    process.stderr.write(tool + ': ' + error.message + '\\n')
    process.exitCode = 1
  }
}
`
}

/**
 * The Windows `<name>.cmd`, which runs {@link nodeCommand} with the Node each shell call names in
 * DSH_COMPANY_NODE; ELECTRON_RUN_AS_NODE lets DSH's Electron run it as Node.
 * @param name - the tool's name.
 * @returns the batch file.
 */
export function windowsCommand(name: string): string {
  return [
    '@echo off',
    'setlocal',
    'if not defined DSH_COMPANY_NODE (',
    `  1>&2 echo ${name}: company tools are only available in a DSH shell call while DSH is signed in to the user center.`,
    '  exit /b 2',
    ')',
    'set ELECTRON_RUN_AS_NODE=1',
    `"%DSH_COMPANY_NODE%" "%~dp0${name}.mjs" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

/**
 * Write a tool's command into a directory the model shell has on PATH.
 * @param dir - the directory.
 * @param name - the tool's name.
 * @param platform - the platform the command runs on.
 */
export async function installCommand(dir: string, name: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    await writeFile(join(dir, `${name}.mjs`), nodeCommand(name))
    await writeFile(join(dir, `${name}.cmd`), windowsCommand(name))
    return
  }
  await writeFile(join(dir, name), posixCommand(name))
  await chmod(join(dir, name), 0o755)
}
