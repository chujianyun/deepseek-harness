import { createUserMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { buildShareSnapshot } from '../src/snapshot.ts'

let seq = 0
const at = (time: number) => new Date(time).toISOString()
const event = (type: string, time: number, data: unknown) => ({ type, seq: SessionSeq(seq++), time, data }) as never as SessionEvent
const user = (time: number, text: string, kind = 'user') =>
  event('user/message', time, createUserMessage({ content: [{ type: 'text', text }], source: { kind } as never }))
const assistant = (time: number, content: unknown[]) => event('assistant/message', time, {
  turn: 1, step: 1, stream: [],
  message: { id: MessageId(`m${String(time)}`), role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } },
})
const call = (name: string, args: unknown) => ({ type: 'tool-call', id: ToolCallId(`c-${name}`), name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })

describe('the share snapshot', () => {
  it('keeps what the user typed and what the assistant answered, in order, with times', () => {
    const snapshot = buildShareSnapshot([
      event('turn/start', 1, { turn: 1 }),
      user(1_000, '帮我复盘双十一的数据'),
      assistant(2_000, [{ type: 'text', text: '好的，**成交额**增长 12%。' }]),
      event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(snapshot).toEqual([
      { role: 'user', text: '帮我复盘双十一的数据', at: at(1_000) },
      { role: 'assistant', text: '好的，**成交额**增长 12%。', at: at(2_000) },
    ])
  })

  it('merges the steps of one reply and lists its tool calls by name and a short summary of their arguments', () => {
    const snapshot = buildShareSnapshot([
      user(1_000, '读一下报表'),
      assistant(2_000, [
        { type: 'reasoning', text: '先读文件' },
        { type: 'text', text: '我先读取文件。' },
        call('read_file', { path: '/proj/双十一.xlsx', limit: 200, nested: { a: 1 }, flag: true }),
      ]),
      event('tool/result', 2_500, { content: 'SECRET FILE BODY' }),
      assistant(3_000, [call('shell', { command: `echo ${'x'.repeat(400)}` }), call('noop', '{}'), call('raw', 'not json')]),
      assistant(4_000, [{ type: 'text', text: '读完了。' }]),
    ])
    expect(snapshot).toHaveLength(2)
    expect(snapshot[1]).toEqual({
      role: 'assistant', at: at(2_000),
      text: '我先读取文件。\n\n读完了。',
      tools: [
        { name: 'read_file', summary: 'path=/proj/双十一.xlsx, limit=200, flag=true' },
        { name: 'shell', summary: `command=echo ${'x'.repeat(106)}…` },
        { name: 'noop' },
        { name: 'raw' },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain('SECRET FILE BODY')
    expect(JSON.stringify(snapshot)).not.toContain('先读文件')
  })

  it('names attachments instead of carrying them, and leaves out messages the user did not type', () => {
    const snapshot = buildShareSnapshot([
      event('user/message', 1_000, createUserMessage({
        content: [
          { type: 'text', text: '看看这两个文件' },
          { type: 'file', attachment: { name: '报价.pdf' } },
          { type: 'image', attachment: { name: '主图.png' } },
          { type: 'image', attachment: {} },
        ] as never,
        source: { kind: 'user' },
      })),
      // A schedule delivery or a subagent report is a user-role message the user did not type.
      user(2_000, 'scheduled reminder body', 'schedule'),
      event('user/message', 3_000, createUserMessage({ content: [{ type: 'file', attachment: { name: '只有附件.csv' } }] as never, source: { kind: 'user' } })),
      assistant(4_000, [{ type: 'text', text: '   ' }]),
    ])
    expect(snapshot).toEqual([
      { role: 'user', text: '看看这两个文件\n[附件：报价.pdf]\n[附件：主图.png]\n[附件]', at: at(1_000) },
      { role: 'user', text: '[附件：只有附件.csv]', at: at(3_000) },
    ])
  })

  it('names a call without a summary when its arguments are not an object, and skips other content', () => {
    const snapshot = buildShareSnapshot([
      event('user/message', 1_000, createUserMessage({ content: [{ type: 'text', text: '  ' }, { type: 'other' }] as never, source: { kind: 'user' } })),
      assistant(2_000, [call('list', '[1]'), call('nothing', 'null'), call('count', '3'), { type: 'other' }]),
    ])
    expect(snapshot).toEqual([{ role: 'assistant', text: '', tools: [{ name: 'list' }, { name: 'nothing' }, { name: 'count' }], at: at(2_000) }])
  })

  it('is empty for a log without a conversation', () => {
    expect(buildShareSnapshot([event('turn/start', 1, { turn: 1 })])).toEqual([])
  })
})
