/** Classifying the lark-cli commands of a bash command by the risk the CLI states. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { classify, helpRiskReader, invocations, tokenize, type Risk } from '../src/risk.ts'

const stated: Record<string, Risk> = { 'calendar +agenda': 'read', 'im +messages-send': 'write', 'drive +delete': 'high-risk-write' }
const reader = vi.fn((words: readonly string[]) => Promise.resolve(stated[words.join(' ')] ?? 'unknown'))

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
    expect(invocations('echo hi')).toEqual([])
    const found = invocations('cd /tmp && lark-cli im +messages-send --text "a b"; /opt/x/lark-cli calendar +agenda | jq .')
    if (found === 'opaque') throw new Error('expected lark-cli calls')
    expect(found.map(args => args.map(arg => arg.text))).toEqual([['im', '+messages-send', '--text', 'a b'], ['calendar', '+agenda']])
  })

  it.each(['echo $(lark-cli im +x)', 'echo `lark-cli im +x`', 'eval "lark-cli im +x"', 'sh -c "lark-cli im +x"', 'echo a | xargs lark-cli', 'diff <(lark-cli a) b'])(
    'treats %s as opaque', (command) => { expect(invocations(command)).toBe('opaque') },
  )
})

describe('classify', () => {
  it('takes the highest stated risk of the calls, reading only the command words before the first flag', async () => {
    expect(await classify('ls', reader)).toEqual({ risk: 'none', invocations: [] })
    expect(await classify('lark-cli calendar +agenda --start 2026-10-06', reader)).toEqual({ risk: 'read', invocations: [{ command: 'calendar +agenda', risk: 'read' }] })
    expect(reader).toHaveBeenLastCalledWith(['calendar', '+agenda'])
    expect((await classify('lark-cli calendar +agenda && lark-cli im +messages-send --text hi', reader)).risk).toBe('write')
    expect((await classify('lark-cli im +messages-send --text hi && lark-cli calendar +agenda', reader)).risk).toBe('write')
    expect((await classify('lark-cli im +messages-send; lark-cli drive +delete --file-token x', reader)).risk).toBe('high-risk-write')
    expect((await classify('lark-cli calendar list', reader)).risk).toBe('unknown')
  })

  it('reads help, version, a dry run, and a bare call as read, and an expanded argument or opaque form as unknown', async () => {
    for (const command of ['lark-cli drive +delete --help', 'lark-cli --version', 'lark-cli im +messages-send --dry-run', 'which lark-cli']) {
      expect((await classify(command, reader)).risk).toBe('read')
    }
    expect(await classify('lark-cli im +messages-send --chat-id $CHAT', reader)).toEqual({ risk: 'unknown', invocations: [{ command: 'im +messages-send', risk: 'unknown' }] })
    expect(await classify(' echo $(lark-cli drive +delete) ', reader)).toEqual({ risk: 'unknown', invocations: [{ command: 'echo $(lark-cli drive +delete)', risk: 'unknown' }] })
  })
})

describe.skipIf(process.platform === 'win32')('helpRiskReader', () => {
  it('parses the Risk line of --help, caches each command, and reads a command without one as unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-risk-'))
    try {
      const bin = join(dir, 'lark-cli')
      await writeFile(bin, `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$1" in im) echo "Risk: write";; drive) echo "Risk: high-risk-write (confirm)";; *) echo "Usage";; esac\n`)
      await chmod(bin, 0o755)
      const read = helpRiskReader(bin, process.env)
      expect(await read(['im', '+messages-send'])).toBe('write')
      expect(await read(['im', '+messages-send'])).toBe('write')
      expect(await read(['drive', '+delete'])).toBe('high-risk-write')
      expect(await read(['calendar'])).toBe('unknown')
      expect((await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n')).toEqual(['im +messages-send --help', 'drive +delete --help', 'calendar --help'])
      expect(await helpRiskReader(join(dir, 'missing'), process.env)(['im'])).toBe('unknown')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
