/**
 * The DingTalk connector over a stand-in dws: signing a tenant in through the device flow, its
 * connection status, disconnecting, the model shell's `dws`, the Skills the release ships, and
 * confirming writes by the Safety the CLI states.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { seatbeltProfileArgs } from '../../../sandbox/sandbox-local/src/profiles.ts'
import { checkHealth, listSkills, qrCode, readSkill, removeTenant } from '../src/dingtalk.ts'
import { setup, VERSION } from './support.ts'

const runs = it.skipIf(process.platform === 'win32')

function bash(command: string, id = 'call-1'): ToolExecution {
  return {
    signal: new AbortController().signal, token: Symbol('connectors-test') as ToolExecution['token'],
    callId: ToolCallId(id), rootCallId: ToolCallId(id), name: 'bash', arguments: { command },
  }
}

async function connected(options: { homeParent?: string } = {}) {
  const t = await setup({ connector: 'dingtalk', ...options })
  await t.until(view => view.status === 'disconnected')
  await t.service.connect('dingtalk')
  await t.until(view => view.login?.url != null)
  await t.answer('user', 'ok')
  await t.until(view => view.status === 'connected')
  const dir = join(t.root, 'bin', 't-a')
  await vi.waitFor(async () => { await stat(join(dir, 'dws')) })
  type Shell = { code: number; stderr: string; stdout: string }
  const shell = (args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<Shell>((resolve) => {
    execFile(join(dir, 'dws'), args, { env: { ...process.env, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
    })
  })
  const gate = (exec: ToolExecution) => t.ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve<PreToolDecision>({ kind: 'allow' }))
  return { ...t, dir, shell, gate }
}

describe('connecting DingTalk', () => {
  runs('signs in through the device flow in one step, in the tenant\'s own configuration and credential store', async () => {
    vi.stubEnv('DWS_CLIENT_ID', 'users-own-app')
    vi.stubEnv('DWS_CONFIG_DIR', '/Users/someone/.dws')
    const t = await setup({ connector: 'dingtalk' })
    await t.until(view => view.status === 'disconnected')
    await t.service.connect('dingtalk')
    const waiting = await t.until(view => view.login?.qrCode != null)
    expect(waiting).toMatchObject({
      status: 'connecting',
      login: { steps: ['authorize'], step: 'authorize', url: 'https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&user_code=DING-1' },
    })
    expect(waiting.login?.qrCode).toMatch(/^data:image\/svg\+xml;base64,/u)
    await t.answer('user', 'ok')
    expect(await t.until(view => view.status === 'connected')).toMatchObject({ account: '韩梅梅（甲公司）', login: null, loginError: null })
    expect((await readFile(join(t.control, 'env'), 'utf8')).trim().split('\n')).toEqual([
      `DWS_CONFIG_DIR=${join(t.tenantDir('t-a'), 'config')}`,
      'DWS_DISABLE_KEYCHAIN=1',
      `DWS_KEYCHAIN_DIR=${join(t.tenantDir('t-a'), 'keychain')}`,
    ])
    expect(await t.calls()).toContain('auth login --device --no-browser --format json')
  })

  runs('reports a sign-in that failed and can connect again', async () => {
    const t = await setup({ connector: 'dingtalk' })
    await t.service.connect('dingtalk')
    await t.until(view => view.login?.url != null)
    await t.answer('user', 'fail:authorization expired')
    expect((await t.until(view => view.status === 'disconnected')).loginError).toEqual({ step: 'authorize', message: 'authorization expired' })
    await t.service.connect('dingtalk')
    await t.until(view => view.login?.url != null)
    await t.answer('user', 'ok')
    expect((await t.until(view => view.status === 'connected')).loginError).toBeNull()
  })

  it.each([
    [{ success: true, authenticated: true, user_name: '韩梅梅' }, { status: 'connected', account: '韩梅梅' }],
    [{ success: true, authenticated: true, corp_name: '甲公司' }, { status: 'connected', account: '甲公司' }],
    [{ success: true, authenticated: true }, { status: 'connected', account: null }],
    [{ success: true, authenticated: false, reason: 'dek_missing', message: '本地登录密钥缺失' }, { status: 'degraded', problem: '本地登录密钥缺失' }],
    [{ success: true, authenticated: false, reason: 'refresh_failed' }, { status: 'degraded', problem: 'refresh_failed' }],
    [{ success: false, error: { message: 'store unavailable' } }, { status: 'degraded', problem: 'store unavailable' }],
    ['not json', { status: 'degraded', problem: 'not json' }],
  ])('reads the readonly status %j as %j', async (status, expected) => {
    if (process.platform === 'win32') return
    const t = await setup({ connector: 'dingtalk' })
    await t.status(status)
    await t.service.check()
    expect(await t.until(view => view.status === expected.status)).toMatchObject(expected)
    expect(await t.calls()).toContain('auth status --readonly --format json')
  })

  runs('disconnects: dws signs out and the tenant\'s directory goes', async () => {
    const t = await connected()
    await t.service.disconnect('dingtalk')
    expect(await t.calls()).toContain('auth logout')
    expect(await t.exists(t.tenantDir('t-a'))).toBe(false)
    expect((await t.service.getState()).connectors[1]?.status).toBe('disconnected')
  })
})

describe('the model shell\'s dws', () => {
  runs('runs the installed CLI with the tenant\'s directories and none of the caller\'s DWS variables', async () => {
    const t = await connected()
    const result = await t.shell(['calendar', 'event', 'list'], { DWS_CONFIG_DIR: '/Users/someone/.dws', DWS_CLIENT_ID: 'mine' })
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('钉钉周会') as string })
    expect((await readFile(join(t.control, 'run-env'), 'utf8')).trim().split('\n')).toEqual([
      `DWS_CONFIG_DIR=${join(t.tenantDir('t-a'), 'config')}`,
      'DWS_DISABLE_KEYCHAIN=1',
      `DWS_KEYCHAIN_DIR=${join(t.tenantDir('t-a'), 'keychain')}`,
    ])
    const failed = await t.shell(['calendar', 'event', 'fail'])
    expect(failed.code).toBe(4)
    expect(failed.stderr).toContain('DSH: dws exited with status 4. If signing in to DingTalk or a missing permission is the cause, ask the user to check the DingTalk connector on the DSH Connectors page (连接器).')
  })

  runs('refuses while DingTalk is not connected', async () => {
    const t = await connected()
    await t.service.disconnect('dingtalk')
    await vi.waitFor(async () => {
      expect((await t.shell(['calendar', 'event', 'list'])).stderr)
        .toContain('DSH: the DingTalk connector is not connected for this company. Ask the user to connect DingTalk on the DSH Connectors page (连接器), then try again.')
    })
  })

  runs('checks the connection again after a bash call of dws fails', async () => {
    const t = await connected()
    const before = (await t.calls()).filter(call => call.startsWith('auth status')).length
    t.ctx.emit('tools/result', bash('dws calendar event fail'), { isError: true, content: [] } as object as ToolExecutionResult)
    await vi.waitFor(async () => {
      expect((await t.calls()).filter(call => call.startsWith('auth status')).length).toBeGreaterThan(before)
    })
  })
})

describe('the sandbox and DingTalk', () => {
  runs('grants the company\'s directory to confined shells while dws runs there, and only then', async () => {
    const t = await connected()
    expect(t.ctx.sandboxPolicy.resolve().extraWritableRoots).toEqual([t.tenantDir('t-a')])
    await t.service.setEnabled('dingtalk', false)
    expect(t.ctx.sandboxPolicy.resolve().extraWritableRoots).toBeUndefined()
    await t.service.setEnabled('dingtalk', true)
    await t.service.disconnect('dingtalk')
    expect(t.ctx.sandboxPolicy.resolve().extraWritableRoots).toBeUndefined()
  })

  it.skipIf(process.platform !== 'darwin')('lets dws take its lock under Seatbelt with the grant, and not without', async () => {
    // Outside the temporary directories, which every confined shell may write anyway.
    const t = await connected({ homeParent: join(process.cwd(), 'node_modules', '.cache', 'dsh-connectors-sandbox') })
    type Policy = ReturnType<typeof t.ctx.sandboxPolicy.resolve>
    const confined = (policy: Policy) => new Promise<{ code: number; stderr: string }>((resolve) => {
      const args = [...seatbeltProfileArgs({ ...policy, mode: 'workspace-write' }), '--', join(t.dir, 'dws'), 'calendar', 'event', 'list']
      execFile('/usr/bin/sandbox-exec', args, { encoding: 'utf8' }, (error, _stdout, stderr) => {
        resolve({ code: error === null ? 0 : Number(error.code), stderr })
      })
    })
    const policy = { ...t.ctx.sandboxPolicy.resolve(), workspaceRoot: tmpdir() }
    expect(await confined(policy)).toMatchObject({ code: 0 })
    const { extraWritableRoots: _granted, ...ungranted } = policy
    const refused = await confined(ungranted)
    expect(refused.code).toBe(5)
    expect(refused.stderr).toContain('opening lock file: operation not permitted')
  })
})

describe('DingTalk Skills', () => {
  runs('reach the model from the release\'s files while connected, and list on the card', async () => {
    const t = await connected()
    const skills = await t.ctx.skills.list()
    const ours = skills.filter(skill => skill.provider === 'connectors')
    expect(ours.map(skill => [skill.name, skill.description, skill.source])).toEqual([
      ['dingtalk-calendar', '钉钉日历与会议室', 'connector-dingtalk'], ['dingtalk-chat', '钉钉群聊与消息', 'connector-dingtalk'],
    ])
    const calendar = await t.ctx.skills.get('dingtalk-calendar')
    expect(calendar?.content).toBe('\n# calendar\n\nRun dws calendar event list.\n')
    expect(calendar?.resourceBase).toEqual({ kind: 'directory', path: join(t.root, VERSION, 'skills', 'dingtalk-calendar') })
    expect((await t.service.getState()).connectors[1]?.skills.map(skill => skill.name)).toEqual(['dingtalk-calendar', 'dingtalk-chat'])
  })
})

describe('confirming DingTalk writes', () => {
  runs('runs reads unasked and asks before a write, by the Safety its help states', async () => {
    const t = await connected()
    expect(await t.gate(bash('dws calendar event list --start 2026-10-06'))).toEqual({ kind: 'allow' })
    // Listed read-only commands need no help.
    expect(await t.gate(bash('dws auth status'))).toEqual({ kind: 'allow' })
    expect(await t.gate(bash('dws shortcut list --service chat --format json 2>&1 | head -200'))).toEqual({ kind: 'allow' })
    expect((await t.calls()).filter(call => call.startsWith('auth status --help'))).toEqual([])
    expect(await t.gate(bash('dws chat message send --text hi'))).toMatchObject({
      kind: 'ask', reason: 'DingTalk connector write command: dws chat message send',
      displayReason: { zh: '钉钉连接器将以你的身份执行写操作：dws chat message send。允许执行一次吗？' },
    })
    expect(await t.gate(bash('dws todo task create --title x'))).toMatchObject({
      kind: 'ask', displayReason: { zh: '无法确定这条钉钉命令的风险，按写操作确认：dws todo task create。允许以你的身份执行一次吗？' },
    })
  })

  runs('warns before a destructive command and, once approved, runs it with --yes', async () => {
    const t = await connected()
    const exec = bash('dws doc delete --doc-id d1', 'call-delete')
    expect(await t.gate(exec)).toMatchObject({
      kind: 'ask', reason: 'DingTalk connector high-risk-write command: dws doc delete',
      displayReason: { zh: '⚠️ 高风险操作：钉钉连接器将以你的身份执行 dws doc delete，可能删除数据或造成无法撤销的修改。同意后 DSH 会为本次执行加上 --yes。' },
    })
    const { DSH_CONNECTOR_CONFIRMED: confirmed } = t.ctx.shellEnv.collect(exec)
    expect(confirmed).toBe('dws doc delete')
    expect((await t.shell(['doc', 'delete', '--doc-id', 'd1'], { DSH_CONNECTOR_CONFIRMED: confirmed })).code).toBe(0)
    expect((await t.shell(['doc', 'delete', '--doc-id', 'd1', '-y'], { DSH_CONNECTOR_CONFIRMED: confirmed })).code).toBe(0)
    expect((await t.shell(['doc', 'delete', '--doc-id', 'd1'])).code).toBe(2)
    expect((await t.calls()).filter(call => call.startsWith('doc delete --doc-id'))).toEqual([
      'doc delete --doc-id d1 --yes', 'doc delete --doc-id d1 -y', 'doc delete --doc-id d1',
    ])
  })
})

describe('the DingTalk QR code', () => {
  it('is drawn by DSH as an SVG of the address', async () => {
    const image = await qrCode({ bin: 'dws', dir: '/nowhere' }, 'https://login.dingtalk.com/x?user_code=A')
    expect(Buffer.from((image ?? '').replace('data:image/svg+xml;base64,', ''), 'base64').toString()).toMatch(/^<svg/u)
  })
})

describe('the DingTalk release files', () => {
  it('lists nothing without a Skills directory, skips a directory without SKILL.md, and reads only named Skills', async () => {
    const versionDir = await mkdtemp(join(tmpdir(), 'dsh-dws-skills-'))
    try {
      const location = { versionDir, cli: { bin: 'dws', dir: versionDir } }
      expect(await listSkills(location)).toEqual([])
      await mkdir(join(versionDir, 'skills', 'dingtalk-none'), { recursive: true })
      expect(await listSkills(location)).toEqual([])
      expect(await readSkill(location, 'dingtalk-none')).toBeUndefined()
      expect(await readSkill(location, '../escape')).toBeUndefined()
    } finally {
      await rm(versionDir, { recursive: true, force: true })
    }
  })

  it('reads a dws that cannot start as degraded', async () => {
    const health = await checkHealth({ bin: join(tmpdir(), 'dsh-no-such-dws'), dir: tmpdir() }, new AbortController().signal)
    expect(health).toMatchObject({ kind: 'degraded', problem: expect.stringContaining('ENOENT') as string })
  })

  it('still deletes a tenant whose dws cannot sign out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-dws-tenant-'))
    await writeFile(join(dir, 'token'), 'x')
    await removeTenant({ bin: join(dir, 'missing-dws'), dir })
    expect(await stat(dir).catch(() => undefined)).toBeUndefined()
  })
})
