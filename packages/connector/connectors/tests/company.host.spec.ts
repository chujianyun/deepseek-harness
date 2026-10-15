/**
 * Company tools: the user center lists the tenant's tools; a tool that is on gives the model shell a
 * command that reaches the user center through this Host, and a call that would overwrite existing
 * goods runs only after the user approves its shell call.
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { CompanyTools, installCommand, nodeCommand, posixCommand, windowsCommand } from '../src/company.ts'
import type { ConnectorsState } from '../src/index.ts'
import { setup } from './support.ts'

// The command is a POSIX shell script; on Windows the Node command is checked separately below.
const runs = it.skipIf(process.platform === 'win32')

const JACKYUN = {
  id: 'c-1', kind: 'jackyun', name: 'jackyun', displayName: '吉客云', description: '查货品、创建组合装', autoInstall: true,
  allowedMethods: ['erp.storage.goodslist', 'erp.packagegoods.import'],
}

interface Forwarded {
  readonly path: string
  readonly body: unknown
}

/** A user center that lists `tools` and answers each forwarded call with `reply`. */
type Listing = unknown[] | { status: number; body: string } | Error | (() => Response)
function userCenter(tools: Listing) {
  const forwarded: Forwarded[] = []
  const center = {
    forwarded,
    tools,
    reply: (_body: { method: string; confirmOverwrite: boolean }): { status: number; body: unknown } | Response =>
      ({ status: 200, body: { code: 200, msg: '', subCode: '', result: { data: [{ goodsNo: 'A1' }] } } }),
    /** When set, the next listing waits for it. */
    listGate: undefined as Promise<unknown> | undefined,
    request: async (path: string, init?: RequestInit): Promise<Response> => {
      if (path === '/api/client/connectors') {
        await center.listGate
        const listed = center.tools
        if (listed instanceof Error) throw listed
        if (typeof listed === 'function') return listed()
        return Array.isArray(listed) ? Response.json(listed) : new Response(listed.body, { status: listed.status })
      }
      const body = JSON.parse(init?.body as string) as { method: string; confirmOverwrite: boolean }
      forwarded.push({ path, body })
      const answer = center.reply(body)
      return answer instanceof Response ? answer : Response.json(answer.body, { status: answer.status })
    },
  }
  return center
}

/** The company tools' directory among the model shell's PATH additions; the stand-in Feishu CLI has its own. */
const companyDir = (dirs: readonly string[]): string | undefined => dirs.find(dir => dir.includes(join('connectors', 'company')))

function bash(command: string, id = 'call-1'): ToolExecution {
  return {
    signal: new AbortController().signal, token: Symbol('company-test') as ToolExecution['token'],
    callId: ToolCallId(id), rootCallId: ToolCallId(id), name: 'bash', arguments: { command },
  }
}

async function company(tools: Listing = [JACKYUN]) {
  const center = userCenter(tools)
  const t = await setup({ hubRequest: center.request })
  const state = async (predicate: (state: ConnectorsState) => boolean): Promise<ConnectorsState> => {
    for (;;) {
      const next = await t.iterator.next()
      if (next.done === true) throw new Error('state stream ended')
      if (predicate(next.value)) return next.value
    }
  }
  /** The state once it satisfies `predicate`, however many frames came before. */
  const settled = async (predicate: (state: ConnectorsState) => boolean): Promise<ConnectorsState> => {
    for (;;) {
      const now = await t.service.getState()
      if (predicate(now)) return now
      await new Promise((resolve) => { setTimeout(resolve, 10) })
    }
  }
  /** The tools listed, and their commands written. */
  const listed = async (): Promise<void> => {
    await state(now => now.company.tools.length > 0)
    await t.service.setCompanyToolEnabled('jackyun', true)
  }
  const gate = (exec: ToolExecution): Promise<PreToolDecision> => t.ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
  /** Run the tool's command as the shell call `exec` would, with its PATH directory and variables. */
  type Run = { code: number; stdout: string; stderr: string }
  const run = (exec: ToolExecution, args: string[], variables = t.ctx.shellEnv.collect(exec)) => new Promise<Run>((resolve) => {
    const dir = companyDir(t.ctx.shellEnv.collectPath(exec)) ?? join(t.home, 'connectors', 'company', 'bin', 't-a')
    execFile(join(dir, 'jackyun'), args, { env: { ...process.env, ...variables }, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : Number.NaN, stdout, stderr: stderr || (error?.message ?? '') })
    })
  })
  const finish = (exec: ToolExecution) => { t.ctx.emit('tools/result', exec, { isError: false, value: { exitCode: 0 } } as object as ToolExecutionResult) }
  return { ...t, center, state, settled, listed, gate, run, finish }
}

describe('company tools', () => {
  it('lists the tenant\'s tools of known kinds, on by the company\'s auto-install, and puts their commands on PATH', async () => {
    const t = await company([JACKYUN, { ...JACKYUN, id: 'c-2', name: 'other', kind: 'erp-x' }, { ...JACKYUN, id: 'c-3', name: 'Bad Name' }])
    const state = await t.state(now => now.company.status === 'ready' && now.company.tools.length > 0)
    expect(state.company.tools).toEqual([{
      name: 'jackyun', kind: 'jackyun', displayName: '吉客云', description: '查货品、创建组合装',
      methods: ['erp.storage.goodslist', 'erp.packagegoods.import'], enabled: true,
    }])
    expect(companyDir(t.ctx.shellEnv.collectPath(bash('jackyun docs list')))).toBe(join(t.home, 'connectors', 'company', 'bin', 't-a'))
    expect(t.ctx.shellEnv.collect(bash('jackyun docs list'))['DSH_COMPANY_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/)
  })

  it('switches a tool off and on for the tenant; off, the model shell has no command for it', async () => {
    const t = await company([{ ...JACKYUN, autoInstall: false }])
    await t.state(now => now.company.tools.length === 1)
    expect((await t.service.getState()).company.tools[0]!.enabled).toBe(false)
    expect(companyDir(t.ctx.shellEnv.collectPath(bash('jackyun docs list')))).toBeUndefined()
    expect(t.ctx.shellEnv.collect(bash('jackyun docs list'))).not.toHaveProperty('DSH_COMPANY_URL')
    expect((await t.service.setCompanyToolEnabled('jackyun', true)).company.tools[0]!.enabled).toBe(true)
    expect(await readdir(join(t.home, 'connectors', 'company', 'bin', 't-a'))).toEqual(['jackyun'])
    expect((await t.service.setCompanyToolEnabled('jackyun', false)).company.tools[0]!.enabled).toBe(false)
    expect(companyDir(t.ctx.shellEnv.collectPath(bash('jackyun docs list')))).toBeUndefined()
    await expect(t.service.setCompanyToolEnabled('nope', true)).rejects.toMatchObject({ code: 'connectors/no-company-tool' })
  })

  runs('forwards calls to the user center and prints the platform\'s answer; reads its reference', async () => {
    const t = await company()
    await t.listed()
    const exec = bash('jackyun api call --method erp.storage.goodslist --json \'{"pageSize":1}\'')
    const read = await t.run(exec, ['api', 'call', '--method', 'erp.storage.goodslist', '--json', '{"pageSize":1,"goodsName":"名流 500mg"}'])
    expect(read.code).toBe(0)
    expect(JSON.parse(read.stdout)).toEqual({ code: 200, msg: '', subCode: '', result: { data: [{ goodsNo: 'A1' }] } })
    const file = join(t.home, 'params.json')
    await writeFile(file, '{"goodsNo":"A1"}')
    expect((await t.run(exec, ['api', 'call', '-m', 'erp.storage.goodslist', '--file', file])).code).toBe(0)
    expect(t.center.forwarded).toEqual([
      { path: '/api/client/connectors/jackyun/call', body: { method: 'erp.storage.goodslist', params: { pageSize: 1, goodsName: '名流 500mg' }, confirmOverwrite: false } },
      { path: '/api/client/connectors/jackyun/call', body: { method: 'erp.storage.goodslist', params: { goodsNo: 'A1' }, confirmOverwrite: false } },
    ])
    const list = await t.run(exec, ['docs', 'list'])
    expect(list.stdout).toContain('erp.packagegoods.import\t添加组合装商品')
    const doc = await t.run(exec, ['docs', 'get', '-m', 'erp.packagegoods.import'])
    expect(JSON.parse(doc.stdout)).toMatchObject({ method: 'erp.packagegoods.import', summary: '添加组合装商品', params: { goodsNo: { type: 'string' } } })
    expect((await t.run(exec, ['docs', 'get', '-m', 'erp.goods.delete'])).stderr).toContain('is not a method the company allowed')
    expect((await t.run(exec, ['api', 'call', '--method', 'x', '--json', '[1]'])).stderr).toContain('must be a JSON object')
    expect((await t.run(exec, ['api', 'list'])).code).toBe(2)
    expect((await t.run(exec, ['api call', '-m', 'x'])).code).toBe(2)
    expect((await t.run(exec, ['docs', 'list', 'extra'])).code).toBe(2)
    // A proxy the environment names is never asked for the loopback endpoint.
    const proxied = { ...t.ctx.shellEnv.collect(exec), http_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' }
    expect((await t.run(exec, ['docs', 'list'], proxied)).code).toBe(0)
    // The platform's refusal comes back as the user center states it.
    t.center.reply = () => ({ status: 403, body: { statusCode: 403, message: '接口 erp.goods.delete 不在「吉客云」允许调用的范围内' } })
    const refused = await t.run(exec, ['api', 'call', '--method', 'erp.goods.delete'])
    expect(refused).toMatchObject({ code: 1, stderr: 'jackyun: 接口 erp.goods.delete 不在「吉客云」允许调用的范围内\n' })
    // The call's address ends with the call.
    const variables = t.ctx.shellEnv.collect(exec)
    t.finish(exec)
    expect((await t.run(exec, ['docs', 'list'], variables)).stderr).toContain('can no longer reach the company tools')
  })

  runs('stops a call that would overwrite goods; the same call with the flag runs once the user approves it', async () => {
    const t = await company()
    await t.listed()
    t.center.reply = body => body.confirmOverwrite
      ? { status: 200, body: { code: 200, msg: '', subCode: '', result: { data: { skuIds: '1' } } } }
      : { status: 409, body: { code: 'would_overwrite', message: '会覆盖吉客云里已有的货品：名流组合装（ZH-001），需要确认后再执行', existing: [] } }
    const args = ['api', 'call', '--method', 'erp.packagegoods.import', '--json', '{"goodsNo":"ZH-001"}']
    const plain = bash(`jackyun ${args.join(' ')}`, 'call-plain')
    expect(await t.gate(plain)).toEqual({ kind: 'allow' })
    const stopped = await t.run(plain, args)
    expect(stopped.code).toBe(3)
    expect(stopped.stderr).toContain('会覆盖吉客云里已有的货品')
    expect(stopped.stderr).toContain('run the same command again with --confirm-overwrite')
    // The flag without the user's approval of the call changes nothing.
    expect((await t.run(plain, [...args, '--confirm-overwrite'])).code).toBe(3)
    const confirmed = bash(`jackyun ${args.join(' ')} --confirm-overwrite`, 'call-confirmed')
    expect(await t.gate(confirmed)).toEqual({
      kind: 'ask', reason: `company tool overwrite: jackyun ${args.join(' ')} --confirm-overwrite`,
      displayReason: {
        en: `⚠️ Overwrite: 吉客云 will change goods that already exist, as you: jackyun ${args.join(' ')} --confirm-overwrite. Allow it to run once?`,
        zh: `⚠️ 覆盖已有数据：吉客云将以你的身份修改已存在的货品或组合装：jackyun ${args.join(' ')} --confirm-overwrite。允许执行一次吗？`,
      },
    })
    expect((await t.run(confirmed, [...args, '--confirm-overwrite'])).code).toBe(0)
    // The approval covers the one overwrite the user saw: a second one in the same call stops again.
    expect((await t.run(confirmed, [...args, '--confirm-overwrite'])).code).toBe(3)
    const confirms = t.center.forwarded.map(call => (call.body as { confirmOverwrite: boolean }).confirmOverwrite)
    expect(confirms).toEqual([false, false, true, false])
    const twice = bash(`jackyun ${args.join(' ')} --confirm-overwrite && jackyun ${args.join(' ')} --confirm-overwrite`, 'call-twice')
    expect(await t.gate(twice)).toMatchObject({ kind: 'ask' })
    expect((await t.run(twice, [...args, '--confirm-overwrite'])).code).toBe(0)
    expect((await t.run(twice, [...args, '--confirm-overwrite'])).code).toBe(0)
    expect((await t.run(twice, [...args, '--confirm-overwrite'])).code).toBe(3)
    // A hidden command with the flag asks too; the approval ends with its call.
    expect(await t.gate(bash('sh -c "jackyun api call -m x --confirm-overwrite"'))).toMatchObject({ kind: 'ask' })
    t.finish(confirmed)
    expect(await t.gate(bash('jackyun docs list'))).toEqual({ kind: 'allow' })
  })

  it('asks for a new sign-in when the sign-in predates company tools, and says so when the user center cannot be read', async () => {
    const scope = await company({ status: 403, body: '{"error":"insufficient_scope","error_description":"connectors:use"}' })
    expect((await scope.state(now => now.company.status === 'sign-in-again')).company.tools).toEqual([])
    const down = await company({ status: 503, body: 'down' })
    expect((await down.state(now => now.company.status === 'unavailable')).company.tools).toEqual([])
  })

  it('forgets the tools on a tenant switch and reads the new tenant\'s', async () => {
    const t = await company()
    await t.state(now => now.company.tools.length === 1)
    t.center.tools = []
    t.hub.set('t-b')
    await t.state(now => now.company.status === 'ready' && now.company.tools.length === 0)
    t.hub.set(null)
    expect((await t.state(now => now.company.status === 'signed-out')).company.tools).toEqual([])
    expect(companyDir(t.ctx.shellEnv.collectPath(bash('jackyun docs list')))).toBeUndefined()
  })

  it('runs the Windows Node command as the POSIX one does', async () => {
    const t = await company()
    await t.listed()
    const dir = join(t.home, 'node-command')
    await mkdir(dir)
    await installCommand(dir, 'jackyun', 'win32')
    const exec = bash('jackyun api call -m erp.storage.goodslist', 'call-node')
    const node = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [join(dir, 'jackyun.mjs'), ...args], { env: { ...process.env, ...t.ctx.shellEnv.collect(exec) }, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
      })
    })
    expect(JSON.parse((await node(['api', 'call', '-m', 'erp.storage.goodslist', '--json', '{"pageSize":2}'])).stdout)).toMatchObject({ code: 200 })
    const file = join(dir, 'params.json')
    await writeFile(file, '{"goodsNo":"A1"}')
    await node(['api', 'call', '--method', 'erp.packagegoods.import', '--file', file, '--confirm-overwrite'])
    expect(t.center.forwarded.map(call => call.body)).toEqual([
      { method: 'erp.storage.goodslist', params: { pageSize: 2 }, confirmOverwrite: false },
      // The flag reaches the user center only for a call the user approved.
      { method: 'erp.packagegoods.import', params: { goodsNo: 'A1' }, confirmOverwrite: false },
    ])
    expect((await node(['docs', 'get', '--method', 'erp.storage.goodslist'])).stdout).toContain('"summary"')
    expect((await node(['docs', 'list'])).stdout).toContain('erp.storage.goodslist')
    const proxied = await new Promise<number>((resolve) => {
      const env = { ...process.env, ...t.ctx.shellEnv.collect(exec), NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' }
      execFile(process.execPath, [join(dir, 'jackyun.mjs'), 'docs', 'list'], { env }, (error) => { resolve(error === null ? 0 : Number(error.code)) })
    })
    expect(proxied).toBe(0)
    for (const args of [['api', 'call'], ['api', 'call', '--json'], ['docs', 'get'], ['other'], ['api', 'call', '-m', 'x', '--bogus', '1']]) {
      expect((await node(args)).code).toBe(2)
    }
    expect((await node(['api', 'call', '-m', 'x', '--file', join(dir, 'missing.json')])).stderr).toContain('no such file')
    t.center.reply = () => ({ status: 409, body: { code: 'would_overwrite', message: '会覆盖', existing: [] } })
    expect((await node(['api', 'call', '-m', 'erp.packagegoods.import'])).code).toBe(3)
    const outside = await new Promise<number>((resolve) => {
      execFile(process.execPath, [join(dir, 'jackyun.mjs'), 'docs', 'list'], { env: { ...process.env, DSH_COMPANY_URL: '' } }, (error) => { resolve(Number(error?.code)) })
    })
    expect(outside).toBe(2)
  })

  it('answers every request of a live call, refusing what the call may not do', async () => {
    const t = await company([{ ...JACKYUN, allowedMethods: ['erp.storage.goodslist', 'erp.not.documented'] }])
    await t.listed()
    const base = String(t.ctx.shellEnv.collect(bash('jackyun docs list'))['DSH_COMPANY_URL'])
    const post = async (path: string, form: Record<string, string> | string) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', body: typeof form === 'string' ? form : new URLSearchParams(form) })
      return { status: res.status, text: await res.text() }
    }
    expect(await post('/jackyun/bogus', {})).toEqual({ status: 404, text: 'DSH: unknown command "bogus".' })
    const off = await post('/nope/call', {})
    expect(off.status).toBe(404)
    expect(off.text).toContain('is not on')
    expect(await post('/jackyun/call', { method: 'x', params: '{' })).toEqual({ status: 400, text: 'jackyun: the parameters are not valid JSON.' })
    expect((await post('/jackyun/call', 'x'.repeat(1024 * 1024 + 1))).status).toBe(413)
    // No method and no parameters are forwarded as such; the user center refuses them.
    t.center.reply = () => new Response('plain text answer', { status: 200 })
    expect(await post('/jackyun/call', {})).toEqual({ status: 200, text: '"plain text answer"' })
    expect(t.center.forwarded.at(-1)!.body).toEqual({ method: '', params: {}, confirmOverwrite: false })
    t.center.reply = () => new Response('Bad Gateway', { status: 502 })
    expect(await post('/jackyun/call', { method: 'x' })).toEqual({ status: 502, text: 'jackyun: Bad Gateway' })
    t.center.reply = () => new Response('"text"', { status: 500 })
    expect(await post('/jackyun/call', { method: 'x' })).toEqual({ status: 500, text: 'jackyun: "text"' })
    t.center.reply = () => { throw new Error('offline') }
    expect(await post('/jackyun/call', { method: 'x' })).toEqual({ status: 502, text: 'jackyun: the user center could not be reached: offline' })
    t.center.reply = () => { throw 'offline' }
    expect(await post('/jackyun/call', { method: 'x' })).toEqual({ status: 502, text: 'jackyun: the user center could not be reached: offline' })
    t.center.reply = () => new Response(new ReadableStream({ start: (controller) => { controller.error(new Error('cut')) } }), { status: 200 })
    expect((await post('/jackyun/call', { method: 'x' })).status).toBe(500)
    const docs = await fetch(`${base}/jackyun/docs`)
    expect(await docs.text()).toBe('erp.storage.goodslist\t分页查询货品信息\nerp.not.documented')
    expect(await (await fetch(`${base}/jackyun/docs?method=erp.not.documented`)).text()).toBe('jackyun: no reference for erp.not.documented.')
    // A withdrawn tool is listed again; a sign-in without the scope asks for a new one.
    t.center.tools = []
    t.center.reply = () => ({ status: 404, body: { message: '连接器不存在，或你没有使用权限' } })
    expect(await post('/jackyun/call', { method: 'x' })).toEqual({ status: 404, text: 'jackyun: 连接器不存在，或你没有使用权限' })
    await t.settled(now => now.company.tools.length === 0)
    t.center.tools = [JACKYUN]
    await t.service.check()
    t.center.reply = () => ({ status: 403, body: { error: 'insufficient_scope' } })
    expect((await post('/jackyun/call', { method: 'x' })).text).toContain('sign in again')
    expect((await t.service.getState()).company.status).toBe('sign-in-again')
    // A switched tenant's calls can no longer reach the tools.
    t.center.tools = []
    t.hub.set('t-b')
    await t.settled(now => now.company.tools.length === 0)
    expect((await post('/jackyun/call', { method: 'x' })).status).toBe(403)
  })

  it('lists nothing for a tool of the company with no methods, and keeps what was listed when the user center fails later', async () => {
    const t = await company([{ ...JACKYUN, allowedMethods: [] }])
    await t.listed()
    const base = String(t.ctx.shellEnv.collect(bash('jackyun docs list'))['DSH_COMPANY_URL'])
    expect(await (await fetch(`${base}/jackyun/docs`)).text()).toBe('jackyun: the company allowed no methods.')
    t.center.tools = { status: 503, body: 'down' }
    await t.service.check()
    expect((await t.service.getState()).company).toMatchObject({ status: 'ready', tools: [{ name: 'jackyun' }] })
    t.center.tools = { status: 200, body: '{"tools":[]}' }
    await t.service.check()
    expect((await t.service.getState()).company.status).toBe('ready')
    t.center.tools = new Error('offline')
    await t.service.check()
    expect((await t.service.getState()).company).toMatchObject({ status: 'ready', tools: [{ name: 'jackyun' }] })
  })

  it('leaves out rows the user center lists malformed, and treats a list that is not one as unreadable', async () => {
    const t = await company([JACKYUN, { ...JACKYUN, name: 'broken', allowedMethods: 'all' }, 'junk'])
    expect((await t.state(now => now.company.tools.length > 0)).company.tools.map(tool => tool.name)).toEqual(['jackyun'])
    const odd = await company({ status: 200, body: '{"tools":[]}' })
    await odd.settled(now => now.company.status === 'unavailable')
    const garbled = await company({ status: 200, body: 'not json' })
    await garbled.settled(now => now.company.status === 'unavailable')
    const cut = await company(() => new Response(new ReadableStream({ start: (controller) => { controller.error(new Error('cut')) } }), { status: 200 }))
    await cut.settled(now => now.company.status === 'unavailable')
  })

  it('reads the new tenant\'s tools though a read for the old one is still under way', async () => {
    const t = await company([JACKYUN])
    await t.listed()
    let release = (): void => {}
    t.center.listGate = new Promise((resolve) => { release = () => { resolve(undefined) } })
    const stale = t.service.check()
    // A second check while the first reads waits for the same read.
    const same = t.service.check()
    t.center.tools = [{ ...JACKYUN, displayName: '乙公司的吉客云' }]
    t.hub.set('t-b')
    release()
    t.center.listGate = undefined
    await Promise.all([stale, same])
    await t.settled(now => now.company.tools[0]?.displayName === '乙公司的吉客云')
  })

  it('marks the tools unavailable when the first read fails, and drops a read that a tenant switch outdated', async () => {
    const offline = await company(new Error('offline'))
    await offline.settled(now => now.company.status === 'unavailable')
    const t = await company([JACKYUN])
    await t.listed()
    let release = (): void => {}
    t.center.listGate = new Promise((resolve) => { release = () => { resolve(undefined) } })
    const pending = t.service.check()
    t.hub.set('t-b')
    t.center.tools = []
    await t.settled(now => now.company.status === 'loading' || now.company.tools.length === 0)
    release()
    t.center.listGate = undefined
    await pending
    expect((await t.service.getState()).company.tools).toEqual([])
  })

  it('names a long command shortened in the overwrite approval', async () => {
    const t = await company()
    await t.listed()
    const long = `jackyun api call -m erp.packagegoods.import --json '${'x'.repeat(300)}' --confirm-overwrite`
    const decision = await t.gate(bash(long))
    expect(decision).toMatchObject({ kind: 'ask', reason: `company tool overwrite: ${long.slice(0, 200)}…` })
  })

  it('warns when the commands cannot be written, and writes them on the next change', async () => {
    const t = await company([])
    const blocker = join(t.home, 'blocker')
    await writeFile(blocker, '')
    const warnings: string[] = []
    const tools = new CompanyTools({
      request: () => Promise.resolve(Response.json([JACKYUN])), tenant: () => 't-a', enabled: () => true, changed: () => {},
      logger: { warn: (message: string) => { warnings.push(message) } },
    }, join(blocker, 'bin'))
    await tools.refresh()
    await tools.sync()
    expect(warnings).toEqual([expect.stringContaining("the company tools' commands could not be written")])
    await tools.sync()
    expect(warnings).toHaveLength(2)
  })

  it('writes the Windows command as a .cmd that runs the Node script', async () => {
    const t = await company([])
    const dir = join(t.home, 'win')
    await mkdir(dir)
    await installCommand(dir, 'jackyun', 'win32')
    expect((await readdir(dir)).sort()).toEqual(['jackyun.cmd', 'jackyun.mjs'])
    expect(windowsCommand('jackyun')).toContain('"%DSH_COMPANY_NODE%" "%~dp0jackyun.mjs" %*')
    expect(nodeCommand('jackyun')).toContain("const tool = 'jackyun'")
    expect(posixCommand('jackyun')).toContain("tool='jackyun'")
  })
})
