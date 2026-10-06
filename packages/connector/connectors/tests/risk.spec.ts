/** Classifying a connector CLI's commands in a bash command by what the CLI states. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assess as assessDws } from '../src/dingtalk.ts'
import { assess } from '../src/lark.ts'
import { classify, helpRiskReader, invocations, tokenize, type Risk } from '../src/risk.ts'

const stated: Record<string, Risk> = { 'calendar +agenda': 'read', 'im +messages-send': 'write', 'drive +delete': 'high-risk-write' }
const reader = vi.fn((words: readonly string[]) => {
  const risk = stated[words.join(' ')] ?? 'unknown'
  return Promise.resolve({ risk, confirm: risk === 'high-risk-write' })
})

describe('tokenize', () => {
  it('splits words and separators, keeping quoted text and escapes, and marks unquoted or double-quoted expansions', () => {
    expect(tokenize('a \'b c\' "d \\"e\\"" f\\ g && h||i;j|k&l (m) $X "$Y" \'no$\'\nz').map(t => `${t.separator ? '#' : ''}${t.text}${t.expanded ? '$' : ''}`)).toEqual([
      'a', 'b c', 'd "e"', 'f g', '#&&', 'h', '#||', 'i', '#;', 'j', '#|', 'k', '#&', 'l', '#(', 'm', '#)', '$X$', '$Y$', 'no$', '#\n', 'z',
    ])
    expect(tokenize("'open")).toEqual([{ text: 'open', separator: false, expanded: false }])
  })
})

describe('invocations', () => {
  it('finds each lark-cli call by name or path with its words up to the next separator', () => {
    expect(invocations('echo hi', 'lark-cli')).toEqual([])
    // A longer name that merely contains the CLI's is not it.
    expect(invocations('lark-cli-free im', 'lark-cli')).toEqual([])
    // Nor is a name inside another word, even in a form whose calls cannot be read.
    expect(invocations("cat $(find . -name '*kdws.txt')", 'dws')).toEqual([])
    expect(invocations('echo $(dws calendar event list)', 'dws')).toBe('opaque')
    const found = invocations('cd /tmp && lark-cli im +messages-send --text "a b"; /opt/x/lark-cli calendar +agenda | jq .', 'lark-cli')
    if (found === 'opaque') throw new Error('expected lark-cli calls')
    expect(found.map(args => args.map(arg => arg.text))).toEqual([['im', '+messages-send', '--text', 'a b'], ['calendar', '+agenda']])
  })

  it.each(['echo $(lark-cli im +x)', 'echo `lark-cli im +x`', 'eval "lark-cli im +x"', 'sh -c "lark-cli im +x"', 'echo a | xargs lark-cli', 'diff <(lark-cli a) b'])(
    'treats %s as opaque', (command) => { expect(invocations(command, 'lark-cli')).toBe('opaque') },
  )
})

describe('classify', () => {
  it('takes the highest stated risk of the calls, reading only the command words before the first flag', async () => {
    expect(await classify('ls', 'lark-cli', reader)).toEqual({ risk: 'none', invocations: [] })
    expect(await classify('lark-cli calendar +agenda --start 2026-10-06', 'lark-cli', reader)).toEqual({ risk: 'read', invocations: [{ command: 'calendar +agenda', risk: 'read', confirm: false }] })
    expect(reader).toHaveBeenLastCalledWith(['calendar', '+agenda'])
    expect((await classify('lark-cli calendar +agenda && lark-cli im +messages-send --text hi', 'lark-cli', reader)).risk).toBe('write')
    expect((await classify('lark-cli im +messages-send --text hi && lark-cli calendar +agenda', 'lark-cli', reader)).risk).toBe('write')
    expect((await classify('lark-cli im +messages-send; lark-cli drive +delete --file-token x', 'lark-cli', reader)).risk).toBe('high-risk-write')
    expect((await classify('lark-cli calendar list', 'lark-cli', reader)).risk).toBe('unknown')
    // Listed read-only words read, with whatever words follow them.
    expect((await classify('dws schema calendar.event.list', 'dws', reader, ['schema'])).risk).toBe('read')
    expect((await classify('dws schemas', 'dws', reader, ['schema'])).risk).toBe('unknown')
  })

  it('reads help, version, a dry run, and a bare call as read, and an expanded argument or opaque form as unknown', async () => {
    for (const command of ['lark-cli drive +delete --help', 'lark-cli --version', 'lark-cli im +messages-send --dry-run', 'which lark-cli']) {
      expect((await classify(command, 'lark-cli', reader)).risk).toBe('read')
    }
    expect(await classify('lark-cli im +messages-send --chat-id $CHAT', 'lark-cli', reader)).toEqual({ risk: 'unknown', invocations: [{ command: 'im +messages-send', risk: 'unknown', confirm: false }] })
    expect(await classify(' echo $(lark-cli drive +delete) ', 'lark-cli', reader)).toEqual({ risk: 'unknown', invocations: [{ command: 'echo $(lark-cli drive +delete)', risk: 'unknown', confirm: false }] })
  })
})

describe.skipIf(process.platform === 'win32')('helpRiskReader', () => {
  it('parses the Risk line of --help, caches each command, and reads a command without one as unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-risk-'))
    try {
      const bin = join(dir, 'lark-cli')
      await writeFile(bin, `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$1" in im) echo "Risk: write";; drive) echo "Risk: high-risk-write (confirm)";; *) echo "Usage";; esac\n`)
      await chmod(bin, 0o755)
      const read = helpRiskReader(bin, process.env, assess)
      expect(await read(['im', '+messages-send'])).toEqual({ risk: 'write', confirm: false })
      expect(await read(['im', '+messages-send'])).toEqual({ risk: 'write', confirm: false })
      expect(await read(['drive', '+delete'])).toEqual({ risk: 'high-risk-write', confirm: true })
      expect(await read(['calendar'])).toEqual({ risk: 'unknown', confirm: false })
      expect((await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n')).toEqual(['im +messages-send --help', 'drive +delete --help', 'calendar --help'])
      expect(await helpRiskReader(join(dir, 'missing'), process.env, assess)(['im'])).toEqual({ risk: 'unknown', confirm: false })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('assessing dws help', () => {
  it.each([
    ['effect=read  risk=low  confirmation=not_required', { risk: 'read', confirm: false }],
    ['effect=read  risk=medium  confirmation=not_required', { risk: 'read', confirm: false }],
    ['effect=write  risk=medium  confirmation=not_required', { risk: 'write', confirm: false }],
    ['effect=write  risk=medium  confirmation=user_required', { risk: 'write', confirm: true }],
    ['effect=write  risk=high  confirmation=user_required', { risk: 'high-risk-write', confirm: true }],
    ['effect=destructive  risk=high  confirmation=user_required', { risk: 'high-risk-write', confirm: true }],
    ['effect=destructive  risk=high  confirmation=not_required', { risk: 'high-risk-write', confirm: false }],
    ['effect=other  risk=low  confirmation=user_required', { risk: 'unknown', confirm: false }],
  ])('reads Safety: %s', (line, expected) => {
    expect(assessDws(`Usage: dws x\n\nSafety: ${line}  idempotency=unknown\n`)).toEqual(expected)
  })

  it('reads a help without a Safety line as unknown', () => {
    expect(assessDws('Usage: dws calendar')).toEqual({ risk: 'unknown', confirm: false })
  })
})
