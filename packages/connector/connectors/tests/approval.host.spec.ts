/**
 * Confirming connector writes: a bash call that runs a writing lark-cli command through a
 * connected connector waits for the user's approval, and an approved high-risk command runs with
 * `--yes`.
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { setup } from './support.ts'

const runs = it.skipIf(process.platform === 'win32')

function bash(command: string, id = 'call-1'): ToolExecution {
  return {
    signal: new AbortController().signal, token: Symbol('connectors-test') as ToolExecution['token'],
    callId: ToolCallId(id), rootCallId: ToolCallId(id), name: 'bash', arguments: { command },
  }
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

describe('confirming connector writes', () => {
  runs('lets reads and other commands run, and asks before a write or a command whose risk is unknown', async () => {
    const t = await connected()
    expect(await t.gate(bash('lark-cli calendar +agenda'))).toEqual({ kind: 'allow' })
    expect(await t.gate(bash('ls -la'))).toEqual({ kind: 'allow' })
    expect(await t.gate({ ...bash('lark-cli im +messages-send'), name: 'read' })).toEqual({ kind: 'allow' })
    expect(await t.gate(bash('lark-cli im +messages-send --text hi'))).toMatchObject({
      kind: 'ask', reason: 'Feishu connector write command: lark-cli im +messages-send',
      displayReason: { zh: '飞书连接器将以你的身份执行写操作：lark-cli im +messages-send。允许执行一次吗？' },
    })
    expect(await t.gate(bash('lark-cli calendar list'))).toMatchObject({
      kind: 'ask', displayReason: { zh: '无法确定这条飞书命令的风险，按写操作确认：lark-cli calendar list。允许以你的身份执行一次吗？' },
    })
    // A long list of commands is cut short.
    const many = await t.gate(bash(Array.from({ length: 10 }, () => 'lark-cli im +messages-send').join('; ')))
    expect(many).toMatchObject({ kind: 'ask' })
    expect((many as { reason: string }).reason).toMatch(/^Feishu connector write command: (lark-cli im \+messages-send; )+lark…$/u)
    // Another gate's denial stands.
    expect(await t.gate(bash('lark-cli im +messages-send'), { kind: 'deny', reason: 'policy' })).toEqual({ kind: 'deny', reason: 'policy' })
    expect(t.ctx.shellEnv.collect(bash('lark-cli im +messages-send --text hi'))).not.toHaveProperty('DSH_CONNECTOR_CONFIRMED')
  })

  runs('warns before a high-risk command and runs it, once approved, with --yes', async () => {
    const t = await connected()
    const exec = bash('lark-cli calendar +agenda && lark-cli drive +delete --file-token box_1', 'call-risky')
    expect(await t.gate(exec)).toMatchObject({
      kind: 'ask', reason: 'Feishu connector high-risk-write command: lark-cli drive +delete',
      displayReason: { zh: '⚠️ 高风险操作：飞书连接器将以你的身份执行 lark-cli drive +delete，可能删除数据或造成无法撤销的修改。同意后 DSH 会为本次执行加上 --yes。' },
    })
    const { DSH_CONNECTOR_CONFIRMED: confirmed } = t.ctx.shellEnv.collect(exec)
    expect(confirmed).toBe('lark-cli drive +delete')
    // The approved call's script adds --yes once, to the approved command only; an unapproved call's adds none.
    const [dir] = t.ctx.shellEnv.collectPath(exec)
    await vi.waitFor(async () => { await stat(join(dir!, 'lark-cli')) })
    const run = (args: string[], env: NodeJS.ProcessEnv) => new Promise<number>((resolve) => {
      execFile(join(dir!, 'lark-cli'), args, { env: { ...process.env, ...env } }, (error) => { resolve(error === null ? 0 : Number(error.code)) })
    })
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

  runs('asks nothing while the connector is not connected or switched off', async () => {
    const t = await setup()
    await t.until(view => view.status === 'disconnected')
    const gate = (exec: ToolExecution) => t.ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve<PreToolDecision>({ kind: 'allow' }))
    expect(await gate(bash('lark-cli im +messages-send'))).toEqual({ kind: 'allow' })
    const c = await connected()
    await c.service.setEnabled('feishu', false)
    expect(await c.gate(bash('lark-cli im +messages-send'))).toEqual({ kind: 'allow' })
  })
})
