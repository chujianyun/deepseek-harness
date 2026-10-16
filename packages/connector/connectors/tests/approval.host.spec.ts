/**
 * Confirming connector commands: a shell call through a connected connector runs reads and plain
 * writes as its CLI states them; a high-risk command, one the CLI runs only confirmed, or one whose
 * risk cannot be read waits for the user's approval, and an approved high-risk command runs with `--yes`.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { cleanups, setup, shell } from './support.ts'

// The stand-in CLI is a POSIX shell script; on Windows windows-wrapper.spec.ts covers the script.
const runs = it.skipIf(process.platform === 'win32')

function bash(command: string, id = 'call-1', agent?: ToolExecution['agent']): ToolExecution {
  return {
    signal: new AbortController().signal, token: Symbol('connectors-test') as ToolExecution['token'],
    callId: ToolCallId(id), rootCallId: ToolCallId(id), name: 'bash', arguments: { command }, ...agent === undefined ? {} : { agent },
  }
}

/** A production agent in a context of its own, and the events its session recorded after it existed. */
async function auditedAgent() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const agent = await (await mountAgentLoopTestHarness(ctx)).create(SessionId(`audited-${String(cleanups.length)}`))
  const before = agent.session.ownEvents().length
  const appended = () => agent.session.ownEvents().slice(before).map(event => ({ type: event.type, data: event.data }))
  return { agent, appended }
}

async function connected() {
  const t = await setup()
  await t.service.connect('feishu')
  await t.until(view => view.login?.url != null)
  await t.answer('app', 'ok')
  await t.until(view => view.login?.step === 'authorize' && view.login.url !== null)
  await t.answer('user', 'ok')
  await t.until(view => view.status === 'connected')
  const gate = (exec: ToolExecution, upstream: PreToolDecision = { kind: 'allow' }) =>
    t.ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve(upstream))
  return { ...t, gate }
}

describe('confirming connector commands', () => {
  runs('runs reads and plain writes unasked and records nothing, and asks before a command of unknown risk', async () => {
    const t = await connected()
    const { agent, appended } = await auditedAgent()
    expect(await t.gate(bash('lark-cli calendar +agenda'))).toEqual({ kind: 'allow' })
    expect(await t.gate(bash('ls -la'))).toEqual({ kind: 'allow' })
    expect(await t.gate({ ...bash('lark-cli im +messages-send'), name: 'read' })).toEqual({ kind: 'allow' })
    expect(await t.gate(bash('lark-cli im +messages-send --text hi', 'call-1', agent))).toEqual({ kind: 'allow' })
    // A variable in a flag value leaves the command readable.
    expect(await t.gate(bash('lark-cli im +messages-send --text "$MESSAGE"', 'call-2', agent))).toEqual({ kind: 'allow' })
    expect(appended()).toEqual([])
    // A command without a stated risk, a variable among the command words, a flag before the last
    // command word, and a call that hides the CLI all ask.
    expect(await t.gate(bash('lark-cli calendar list'))).toEqual({
      kind: 'ask', reason: 'Feishu connector unknown command: lark-cli calendar list',
      displayReason: {
        en: 'The risk of this Feishu command cannot be determined, so it is confirmed: lark-cli calendar list. Allow it to run as you once?',
        zh: '无法确定这条飞书命令的风险，需要确认：lark-cli calendar list。允许以你的身份执行一次吗？',
      },
    })
    for (const command of ['lark-cli drive "$ACTION" --file-token box_1', 'lark-cli drive --file-token box_1 +delete --yes=true', 'sh -c "lark-cli drive +delete --yes"']) {
      expect(await t.gate(bash(command))).toMatchObject({ kind: 'ask' })
    }
    // Another gate's denial stands.
    expect(await t.gate(bash('lark-cli im +messages-send'), { kind: 'deny', reason: 'policy' })).toEqual({ kind: 'deny', reason: 'policy' })
    expect(t.ctx.shellEnv.collect(bash('lark-cli im +messages-send --text hi'))).not.toHaveProperty('DSH_CONNECTOR_CONFIRMED')
  })

  runs('warns before a high-risk command and runs it, once approved, with --yes', async () => {
    const t = await connected()
    const exec = bash('lark-cli calendar +agenda && lark-cli im +messages-send && lark-cli drive +delete --file-token box_1', 'call-risky')
    expect(await t.gate(exec)).toEqual({
      kind: 'ask', reason: 'Feishu connector high-risk-write command: lark-cli drive +delete',
      displayReason: {
        en: '⚠️ High-risk operation: the Feishu connector will run lark-cli drive +delete as you. It may delete data or make changes that cannot be undone. If you allow it, DSH confirms it with --yes for this run.',
        zh: '⚠️ 高风险操作：飞书连接器将以你的身份执行 lark-cli drive +delete，可能删除数据或造成无法撤销的修改。同意后 DSH 会为本次执行加上 --yes。',
      },
    })
    const { DSH_CONNECTOR_CONFIRMED: confirmed } = t.ctx.shellEnv.collect(exec)
    expect(confirmed).toBe('lark-cli drive +delete')
    // The approved call's script adds --yes once, to the approved command only; an unapproved call's adds none.
    const [dir] = t.ctx.shellEnv.collectPath(exec)
    const run = async (args: string[], env: NodeJS.ProcessEnv) => (await shell(dir!, args, env)).code
    expect(await run(['calendar', '+agenda'], { DSH_CONNECTOR_CONFIRMED: confirmed })).toBe(0)
    expect(await run(['drive', '+delete', '--file-token', 'box_1'], { DSH_CONNECTOR_CONFIRMED: confirmed })).toBe(0)
    expect(await run(['drive', '+delete', '--file-token', 'box_1', '--yes'], { DSH_CONNECTOR_CONFIRMED: confirmed })).toBe(0)
    expect(await run(['drive', '+delete', '--file-token', 'box_1'], {})).toBe(2)
    const calls = (await readFile(join(t.control, 'calls'), 'utf8')).trim().split('\n').filter(call => !call.includes('--help'))
    expect(calls.slice(-4)).toEqual([
      'calendar +agenda', 'drive +delete --file-token box_1 --yes', 'drive +delete --file-token box_1 --yes', 'drive +delete --file-token box_1',
    ])
    // The call's result ends the approval.
    t.ctx.emit('tools/result', exec, { isError: true, content: [] } as object as ToolExecutionResult)
    expect(t.ctx.shellEnv.collect(exec)).not.toHaveProperty('DSH_CONNECTOR_CONFIRMED')
  })

  runs('cuts a long list of asked commands short', async () => {
    const t = await connected()
    const many = await t.gate(bash(Array.from({ length: 10 }, () => 'lark-cli drive +delete').join('; ')))
    expect(many).toMatchObject({ kind: 'ask' })
    expect((many as { reason: string }).reason).toMatch(/^Feishu connector high-risk-write command: (lark-cli drive \+delete; )+[^;]*…$/u)
  })

  runs('reads a PowerShell call of lark-cli.cmd as the same command', async () => {
    const t = await connected()
    const pwsh = (command: string): ToolExecution => ({ ...bash(command, 'call-pwsh'), name: 'pwsh' })
    expect(await t.gate(pwsh("& 'C:\\Users\\a\\lark-cli.cmd' drive +delete --file-token box_1"))).toMatchObject({
      kind: 'ask', reason: 'Feishu connector high-risk-write command: lark-cli drive +delete',
    })
    expect(t.ctx.shellEnv.collect(pwsh('lark-cli.cmd drive +delete --file-token box_1'))).toHaveProperty('DSH_CONNECTOR_CONFIRMED', 'lark-cli drive +delete')
    expect(await t.gate(pwsh('iex "lark-cli drive +delete"'))).toMatchObject({ kind: 'ask', reason: 'Feishu connector unknown command: lark-cli iex "lark-cli drive +delete"' })
    // A PowerShell variable in a flag value leaves the command readable.
    expect(await t.gate(pwsh('lark-cli.cmd im +messages-send --text $message'))).toEqual({ kind: 'allow' })
  })

  runs('asks nothing while the connector is not connected or switched off', async () => {
    const t = await setup()
    await t.until(view => view.status === 'disconnected')
    const gate = (exec: ToolExecution) => t.ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve<PreToolDecision>({ kind: 'allow' }))
    expect(await gate(bash('lark-cli drive +delete'))).toEqual({ kind: 'allow' })
    const c = await connected()
    await c.service.setEnabled('feishu', false)
    expect(await c.gate(bash('lark-cli drive +delete'))).toEqual({ kind: 'allow' })
  })
})
