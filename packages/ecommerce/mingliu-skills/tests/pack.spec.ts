import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { manifestSchema } from '@deepseek-ai/dsh-assistant-packages/src/manifest.ts'
import { readOperations } from '@deepseek-ai/dsh-automation-tasks/operations'
import { packSkills, readTasks, SKILLS } from '../src/index.ts'

const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))
/** 名流's people named in the handover; who does what is read from the configuration document. */
const PEOPLE = /邓迦楠|周建平|建平|锁威|程政|王思成/u
let out: string
let zips: string[]

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'dsh-mingliu-skills-'))
  // A hidden file, as Finder leaves, stays out of the zip.
  await writeFile(join(SKILLS_DIR, 'ai-inspection', '.DS_Store'), 'finder')
  zips = await packSkills(out)
  // A second build replaces the first.
  zips = await packSkills(out)
})
afterAll(async () => {
  await rm(join(SKILLS_DIR, 'ai-inspection', '.DS_Store'), { force: true })
  await rm(out, { recursive: true, force: true })
})

/** Every file under a directory, relative to it with `/`. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue
    if (item.isDirectory()) found.push(...await filesUnder(join(dir, item.name), `${prefix}${item.name}/`))
    else found.push(`${prefix}${item.name}`)
  }
  return found
}

describe('packSkills', () => {
  it('zips each skill folder whole around <name>/, with a SKILL.md named after the folder', async () => {
    expect(zips).toEqual(SKILLS.map(name => join(out, `${name}.zip`)))
    for (const name of SKILLS) {
      const entries = unzipSync(await readFile(join(out, `${name}.zip`)))
      expect(Object.keys(entries).sort()).toEqual((await filesUnder(join(SKILLS_DIR, name))).map(file => `${name}/${file}`).sort())
      expect(strFromU8(entries[`${name}/SKILL.md`]!)).toMatch(new RegExp(`^---\\nname: ${name}\\n`, 'u'))
    }
  })

  it('carries nothing of the Aily environment, no chat or user ids, and no names of 名流\'s people', async () => {
    for (const name of SKILLS) {
      for (const file of await filesUnder(join(SKILLS_DIR, name))) {
        const text = await readFile(join(SKILLS_DIR, name, file), 'utf8')
        const forbidden = [/aily/iu, /larksuite-cli-guide/u, /\boc_[0-9a-f]{16,}/u, /\bou_[0-9a-f]{16,}/u, /cli_[0-9a-f]{16}/u, /评论/u]
        // The advertising data base, like every token, is read from the configuration document.
        forbidden.push(/OU8JbYF8WahWo3sYEzwcTyBcn8b/u)
        forbidden.push(PEOPLE)
        for (const pattern of forbidden) expect(text, `${name}/${file}`).not.toMatch(pattern)
      }
    }
  })
})

describe('recommended tasks', () => {
  it('are tasks an assistant package accepts, declaring operations an automation task accepts', async () => {
    const tasks = await readTasks()
    expect(tasks.map(task => (task as { id: string }).id)).toEqual(['ai-inspection', 'roi-internal-report', 'roi-provider-reminder'])
    const parsed = manifestSchema.parse({ name: 'mingliu-ops', displayName: '运营日报助手', description: 'x', version: '1.0.0', tasks })
    expect(parsed.tasks[0]).toMatchObject({
      title: '天猫一店+拼多多工作日巡检', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '11:00' }, timeZone: 'Asia/Shanghai',
      connectors: [], permission: 'workspace-write', operations: ['lark-cli im +messages-send'],
    })
    // The ROI runs only preview; what they send waits for the person's reply, so they declare nothing.
    expect(parsed.tasks[1]).toMatchObject({
      title: '投流ROI内部日报', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:30' }, connectors: [], permission: 'workspace-write',
    })
    expect(parsed.tasks[2]).toMatchObject({
      title: '投流ROI服务商提醒', timing: { kind: 'weekly', weekdays: [1, 3, 5], time: '10:00' }, connectors: [], permission: 'workspace-write',
    })
    expect([parsed.tasks[1]!.operations, parsed.tasks[2]!.operations]).toEqual([undefined, undefined])
    // The run's only write is sending the card, which it declares; other Feishu writes are not granted.
    expect(JSON.stringify(tasks)).not.toMatch(PEOPLE)
    for (const task of parsed.tasks) expect(readOperations(task.operations ?? [])).toEqual({ operations: task.operations ?? [] })
  })

  it('send the inspection only to the test group while it is in development', async () => {
    const [inspection] = await readTasks() as { prompt: string }[]
    expect(inspection!.prompt.match(/\boc_[0-9a-f]+/gu)).toEqual(['oc_94a59b1b5e0f87c703bccdc0f6a10daf'])
    // No month or table token is fixed in the instruction: the month's mapping is read from the configuration document.
    expect(inspection!.prompt).not.toMatch(/OPEN_ID|\bou_|20\d\d-\d\d(?!-\d)|BdO2sx|KGJzsl|B6KNbU/u)
  })

  it('send the ROI report only to the test group, and the provider reminders only to the test group webhook', async () => {
    const [, report, reminder] = await readTasks() as { prompt: string }[]
    expect(report!.prompt.match(/\boc_[0-9a-f]+/gu)).toEqual(['oc_94a59b1b5e0f87c703bccdc0f6a10daf'])
    expect(reminder!.prompt).not.toMatch(/\boc_|https:\/\/open\.feishu\.cn|\bou_/u)
    expect(reminder!.prompt).toContain('只发到 webhook 映射里的「测试群」')
    for (const prompt of [report!.prompt, reminder!.prompt]) expect(prompt).toContain('本次运行只出预览')
  })
})

describe('send_webhook.py', () => {
  const python = process.env.DSH_OFFICE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const script = join(SKILLS_DIR, 'roi-inspection', 'scripts', 'send_webhook.py')
  /** The script's environment: no proxy, so its requests reach the local webhook, and a code page that cannot write Chinese. */
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:https?|all|no)_proxy$/iu.test(name)))

  interface Sent { readonly body: Record<string, unknown> | undefined; readonly code: number; readonly out: string }

  /**
   * Run the script against a local webhook that answers `reply` as its body, with `message.txt` and
   * the mapping file `map.json` (naming the webhook as `url`) beside each other in a temporary folder.
   */
  async function send(mapping: (url: string) => unknown, args: (url: string, dir: string) => string[], reply: string): Promise<Sent> {
    let body: Record<string, unknown> | undefined
    const server = createServer((request: IncomingMessage, response) => {
      let text = ''
      request.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      request.on('end', () => {
        body = JSON.parse(text) as Record<string, unknown>
        response.setHeader('Content-Type', 'application/json')
        response.end(reply)
      })
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const dir = await mkdtemp(join(tmpdir(), 'dsh-roi-webhook-'))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
      await writeFile(join(dir, 'message.txt'), '【投流ROI提醒｜测试】\n')
      await writeFile(join(dir, 'map.json'), typeof mapping(url) === 'string' ? mapping(url) as string : JSON.stringify(mapping(url)))
      const ended = await new Promise<{ code: number; out: string }>((done) => {
        execFile(python, [script, ...args(url, dir)], { env: { ...env, PYTHONIOENCODING: 'cp1252' }, timeout: 4000, encoding: 'utf8' }, (error, stdout) => {
          done({ code: error ? Number(error.code) : 0, out: stdout })
        })
      })
      return { body, ...ended }
    } finally {
      server.close()
      await rm(dir, { recursive: true, force: true })
    }
  }

  const ok = JSON.stringify({ code: 0, msg: 'success', data: {} })
  const byName = (url: string): object => ({ webhooks: { 测试群: { url, secret: 'test-secret' } } })
  const named = (name: string) => (_url: string, dir: string): string[] => ['--mapping', join(dir, 'map.json'), '--name', name, '--file', join(dir, 'message.txt')]

  it('signs the message with the secret the mapping file holds, which stays out of its command and output, and writes UTF-8', async () => {
    const sent = await send(byName, named('测试群'), ok)
    expect([sent.code, sent.out]).toEqual([0, expect.stringContaining('发送成功')])
    expect(sent.out).not.toContain('test-secret')
    const { timestamp, sign, ...message } = sent.body!
    expect(message).toEqual({ msg_type: 'text', content: { text: '【投流ROI提醒｜测试】' } })
    expect(sign).toBe(createHmac('sha256', `${String(timestamp)}\ntest-secret`).digest('base64'))
  })

  it('sends unsigned to a URL, fails when the webhook refuses, and reports an unreadable answer as unknown', async () => {
    const plain = await send(byName, url => ['--url', url, '--content', '连通测试'], ok)
    expect([plain.code, plain.body]).toEqual([0, { msg_type: 'text', content: { text: '连通测试' } }])
    const refused = await send(byName, named('测试群'), JSON.stringify({ code: 19021, msg: 'sign match fail' }))
    expect([refused.code, refused.out]).toEqual([1, expect.stringContaining('发送失败')])
    // The webhook may have delivered it: exit 2 tells the skill not to resend.
    const unknown = await send(byName, named('测试群'), '<html>gateway</html>')
    expect([unknown.code, unknown.out]).toEqual([2, expect.stringContaining('结果不确定')])
  })

  it('sends nothing, and says why, without a usable mapping entry or webhook', async () => {
    const cases: Array<[(url: string) => unknown, (url: string, dir: string) => string[], string]> = [
      [byName, named('在达'), '没有「在达」的 webhook'],
      [() => ({ webhooks: null }), named('测试群'), '没有「测试群」的 webhook'],
      [() => 'not json', named('测试群'), '不是规定格式的 JSON'],
      [byName, (_url, dir) => ['--mapping', join(dir, 'gone.json'), '--name', '测试群', '--content', 'x'], '缺少 webhook 映射文件'],
      [byName, (_url, dir) => ['--mapping', join(dir, 'map.json'), '--content', 'x'], '需要同时给出 --name'],
      [byName, (_url, dir) => ['--file', join(dir, 'message.txt')], '必须提供 --url'],
    ]
    for (const [mapping, args, why] of cases) {
      const sent = await send(mapping, args, ok)
      expect([sent.code, sent.body, sent.out]).toEqual([1, undefined, expect.stringContaining(why)])
    }
  })
})
