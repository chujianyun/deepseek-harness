/**
 * What a connected connector gives the model: the `lark-cli` script ahead of the model shell's
 * PATH and the Skills the CLI embeds, both following the connection and the enable switch.
 */
import { execFile } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { readSkill } from '../src/lark.ts'
import { ConnectorSkillProvider } from '../src/skills.ts'
import { feishu, setup, VERSION } from './support.ts'

const runs = it.skipIf(process.platform === 'win32')

const execution: ToolExecution = {
  signal: new AbortController().signal, token: Symbol('connectors-test') as ToolExecution['token'],
  callId: ToolCallId('call'), rootCallId: ToolCallId('call'), name: 'bash', arguments: { command: 'lark-cli' },
}

/** Run the model shell's `lark-cli` as bash would find it: through the contributed PATH directory. */
function shell(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(join(dir, 'lark-cli'), args, { env: { ...process.env, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
    })
  })
}

async function connected(options: Parameters<typeof setup>[0] = {}) {
  const t = await setup(options)
  await t.service.connect('feishu')
  await t.until(view => view.login?.url != null)
  await t.answer('app', 'ok')
  await t.until(view => view.login?.step === 'authorize' && view.login.url !== null)
  await t.answer('user', 'ok')
  await t.until(view => view.status === 'connected')
  return t
}

const lark = (skills: readonly { name: string; provider: string }[]) => skills.filter(skill => skill.provider === 'connectors').map(skill => skill.name)

describe('the model shell\'s lark-cli', () => {
  runs('runs the installed CLI with the tenant\'s directories, without the user\'s own lark-cli variables', async () => {
    const t = await connected()
    const dir = t.ctx.shellEnv.collectPath(execution)
    expect(dir).toEqual([join(t.root, 'bin', 't-a')])
    await vi.waitFor(async () => { await stat(join(dir[0]!, 'lark-cli')) })
    const result = await shell(dir[0]!, ['calendar', '+agenda'], { LARKSUITE_CLI_CONFIG_DIR: '/Users/someone/.lark-cli', LARKSUITE_CLI_APP_ID: 'mine', HERMES_HOME: '/h' })
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('产品周会') as string })
    expect((await readFile(join(t.control, 'run-env'), 'utf8')).trim().split('\n')).toEqual([
      `LARKSUITE_CLI_CONFIG_DIR=${join(t.tenantDir('t-a'), 'config')}`,
      `LARKSUITE_CLI_DATA_DIR=${join(t.tenantDir('t-a'), 'data')}`,
      `LARKSUITE_CLI_LOG_DIR=${join(tmpdir(), 'dsh-connectors', 'feishu', 't-a', 'logs')}`,
      'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1',
      'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1',
    ])
  })

  runs('points a failing command to the Connectors page', async () => {
    const t = await connected()
    const [dir] = t.ctx.shellEnv.collectPath(execution)
    await vi.waitFor(async () => { await stat(join(dir!, 'lark-cli')) })
    const result = await shell(dir!, ['calendar', '+fail'])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('ask the user to check the Feishu connector on the DSH Connectors page (连接器)')
  })

  runs('checks the connection again after a bash call of lark-cli fails', async () => {
    const t = await connected()
    const checks = async () => (await t.calls()).filter(call => call.startsWith('auth status')).length
    // Let the sign-in's own checks settle first.
    await new Promise(resolve => setTimeout(resolve, 300))
    const before = await checks()
    const bash = (command: string): ToolExecution => ({ ...execution, arguments: { command } })
    const emit = (exec: ToolExecution, result: object) => { t.ctx.emit('tools/result', exec, result as ToolExecutionResult) }
    emit(bash('lark-cli calendar +agenda'), { isError: false, value: { kind: 'foreground', exitCode: 0 }, content: [] })
    emit(bash('echo lark-cli-free; false'), { isError: false, value: { kind: 'foreground', exitCode: 1 }, content: [] })
    emit({ ...bash('lark-cli calendar +agenda'), name: 'read' }, { isError: true, content: [] })
    emit({ ...execution, arguments: {} }, { isError: true, content: [] })
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(await checks()).toBe(before)
    emit(bash('cd /tmp && lark-cli calendar +fail'), { isError: false, value: { kind: 'foreground', exitCode: 4 }, content: [] })
    emit(bash('lark-cli calendar +fail'), { isError: true, content: [] })
    await vi.waitFor(async () => { expect(await checks()).toBe(before + 1) }, { timeout: 5000 })
  })

  runs('refuses while the connector is not connected, pointing to the Connectors page', async () => {
    const t = await setup()
    await t.until(view => view.status === 'disconnected')
    const [dir] = t.ctx.shellEnv.collectPath(execution)
    expect(dir).toBe(join(t.root, 'bin', 't-a'))
    await vi.waitFor(async () => { await stat(join(dir!, 'lark-cli')) })
    const result = await shell(dir!, ['calendar', '+agenda'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('the Feishu connector is not connected for this company. Ask the user to connect Feishu on the DSH Connectors page (连接器)')
    expect(await t.calls()).not.toContain('calendar +agenda')
  })

  runs('logs a script it cannot write and keeps working', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const t = await setup({ files: [] })
    await t.until(view => view.status === 'disconnected')
    await vi.waitFor(async () => { await stat(join(t.root, 'bin', 't-a', 'lark-cli')) })
    // A file where the next tenant's script directory belongs.
    await writeFile(join(t.root, 'bin', 't-b'), '')
    t.hub.set('t-b')
    await vi.waitFor(() => { expect(info).toHaveBeenCalledWith('[connectors] could not write the lark-cli script', expect.anything()) })
    info.mockRestore()
  })

  it('contributes nothing while signed out of the Hub or before the CLI is installed', async () => {
    expect((await setup({ tenant: null })).ctx.shellEnv.collectPath(execution)).toEqual([])
    expect((await setup({ installed: false })).ctx.shellEnv.collectPath(execution)).toEqual([])
  })
})

describe('connector Skills', () => {
  runs('reach the model while connected, list on the card, and load without frontmatter', async () => {
    const t = await setup()
    expect(lark(await t.ctx.skills.list())).toEqual([])
    expect((await t.until(view => view.skills.length > 0)).skills).toEqual([
      { name: 'lark-calendar', description: '飞书日历：查看日程' }, { name: 'lark-im', description: '飞书消息：搜索消息' },
    ])
    await t.service.connect('feishu')
    await t.until(view => view.login?.url != null)
    await t.answer('app', 'ok')
    await t.until(view => view.login?.step === 'authorize' && view.login.url !== null)
    await t.answer('user', 'ok')
    await t.until(view => view.status === 'connected')
    const listed = await t.ctx.skills.list()
    expect(lark(listed)).toEqual(['lark-calendar', 'lark-im'])
    expect(listed.find(skill => skill.name === 'lark-calendar')).toMatchObject({
      source: 'connector-feishu', invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'opaque', description: 'files of this Skill are read with `lark-cli skills read lark-calendar <path>`' },
    })
    const skill = await t.ctx.skills.get('lark-calendar')
    expect(skill?.content).toBe('> Tip: read files with lark-cli skills read lark-calendar <path>.\n\n# calendar\n\nRun lark-cli calendar +agenda.\n')
    expect(await t.ctx.skills.get('lark-im')).toBeUndefined()
    // Disconnected, the Skills leave and one loaded before is gone too.
    await t.service.disconnect('feishu')
    expect(lark(await t.ctx.skills.list())).toEqual([])
  })

  runs('leave with the enable switch, with the CLI, and come back when switched on', async () => {
    const t = await connected()
    expect(lark(await t.ctx.skills.list())).toHaveLength(2)
    expect(feishu(await t.service.setEnabled('feishu', false))).toMatchObject({ status: 'connected', enabled: false })
    expect(lark(await t.ctx.skills.list())).toEqual([])
    expect(t.ctx.shellEnv.collectPath(execution)).toEqual([])
    // Switching off again changes nothing.
    await t.service.setEnabled('feishu', false)
    t.hub.set('t-b')
    expect((await t.until(view => view.status === 'disconnected')).enabled).toBe(true)
    t.hub.set('t-a')
    await t.until(view => view.status === 'connected')
    expect(feishu(await t.service.getState()).enabled).toBe(false)
    expect(feishu(await t.service.setEnabled('feishu', true)).enabled).toBe(true)
    expect(lark(await t.ctx.skills.list())).toHaveLength(2)
    expect(t.ctx.shellEnv.collectPath(execution)).toEqual([join(t.root, 'bin', 't-a')])
  })

  runs('list none when the CLI cannot list them, and ask again next time', async () => {
    const t = await setup({ files: ['noskills'] })
    await t.until(view => view.status === 'disconnected')
    expect(feishu(await t.service.getState()).skills).toEqual([])
    await t.service.connect('feishu')
    await t.until(view => view.login?.url != null)
    await t.answer('app', 'ok')
    await t.until(view => view.login?.step === 'authorize' && view.login.url !== null)
    await t.answer('user', 'ok')
    await t.until(view => view.status === 'connected')
    expect(lark(await t.ctx.skills.list())).toEqual([])
    await rm(join(t.control, 'noskills'))
    t.hub.set('t-b')
    await t.until(view => view.status === 'disconnected')
    t.hub.set('t-a')
    await t.until(view => view.status === 'connected')
    expect(lark(await t.ctx.skills.list())).toEqual(['lark-calendar', 'lark-im'])
  })

  it('refuses the switch while signed out of the Hub, and without Settings', async () => {
    const signedOut = await setup({ tenant: null })
    expect(remoteErrorOf(await signedOut.service.setEnabled('feishu', false).catch((error: unknown) => error))?.code).toBe('hub-account/signed-out')
    const unsaved = await setup({ settings: false })
    await expect(unsaved.service.setEnabled('feishu', false)).rejects.toThrow('switching connectors requires the settings service and a profile entry')
  })

  it('loads nothing for a Skill whose connector no longer gives Skills', async () => {
    const control = { signal: new AbortController().signal, invalidate: vi.fn() }
    const provider = new ConnectorSkillProvider(() => [], control)
    expect(await provider.get({ name: 'lark-im', description: 'd', invocation: { modelInvocable: true, userInvocable: true },
      source: 'connector-feishu', provider: 'connectors', rank: 350, locator: 'connector-feishu' })).toBeUndefined()
    provider.invalidate()
    expect(control.invalidate).toHaveBeenCalledOnce()
  })

  runs('reads a Skill the CLI cannot read as none', async () => {
    const t = await setup()
    expect(await readSkill({ bin: join(t.root, VERSION, 'lark-cli'), dir: t.tenantDir('t-a') }, 'lark-im', new AbortController().signal)).toBeUndefined()
    expect(await readSkill({ bin: join(t.root, 'missing'), dir: t.tenantDir('t-a') }, 'lark-im', new AbortController().signal)).toBeUndefined()
  })

  runs('uninstalling removes the script, the PATH entry, and the Skills', async () => {
    const t = await connected()
    await t.service.uninstallConnector('feishu')
    expect(t.ctx.shellEnv.collectPath(execution)).toEqual([])
    expect(lark(await t.ctx.skills.list())).toEqual([])
    expect(feishu(await t.service.getState()).skills).toEqual([])
    await expect(stat(join(t.root, 'bin'))).rejects.toThrow()
  })

  runs('outranks the user\'s own copy of a Skill inside a preset that discovers local Skills', async () => {
    const t = await connected()
    const preset = createScope(t.ctx, { preset: 'standard' })
    // The user's stale copy, as a preset's skill-filesystem lists ~/.agents/skills in the preset's layer.
    const userCopy: SkillProvider = {
      name: 'filesystem',
      list: async () => [{
        name: 'lark-calendar', description: 'stale copy', invocation: { modelInvocable: true, userInvocable: true },
        provider: 'filesystem', source: 'user-agents', rank: 500, locator: null,
      }],
      get: async (candidate: SkillCandidate) => ({ ...candidate, content: 'Stale instructions.' }),
    }
    preset.ctx.get('skills')!.registerProvider(() => userCopy)
    const scope = { scope: scopeOf(preset.ctx) }
    expect((await t.ctx.skills.get('lark-calendar', scope))?.content).toContain('Run lark-cli calendar +agenda.')
    expect(lark(await t.ctx.skills.list(scope))).toEqual(['lark-calendar', 'lark-im'])
    // Disconnected, the connector's Skills leave and the user's copy is back.
    await t.service.disconnect('feishu')
    await vi.waitFor(async () => { expect(lark(await t.ctx.skills.list(scope))).toEqual([]) })
    expect((await t.ctx.skills.get('lark-calendar', scope))?.content).toBe('Stale instructions.')
    await preset.dispose()
  })
})
