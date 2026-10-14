import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { manifestSchema } from '@deepseek-ai/dsh-assistant-packages/src/manifest.ts'
import { readOperations } from '@deepseek-ai/dsh-automation-tasks/operations'
import { declaredOperations } from '@deepseek-ai/dsh-automation-tasks/src/unattended.ts'
import { packSkills, readTasks, SKILLS } from '../src/index.ts'

const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))
/** 名流's people named in the handover; who does what is read from the configuration documents or the assistant's workspace. */
const PEOPLE = /邓迦楠|周建平|建平|锁威|程政|王思成|刘玉林|路文龙|史鹏飞|李可豪|尹城琳|丰琳琳|倪宸/u
let out: string
let zips: string[]

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'dsh-mingliu-skills-'))
  // A hidden file, as Finder leaves, and Python's bytecode cache stay out of the zip.
  await writeFile(join(SKILLS_DIR, 'ai-inspection', '.DS_Store'), 'finder')
  await mkdir(join(SKILLS_DIR, 'roi-inspection', 'scripts', '__pycache__'), { recursive: true })
  await writeFile(join(SKILLS_DIR, 'roi-inspection', 'scripts', '__pycache__', 'send_webhook.pyc'), 'bytecode')
  zips = await packSkills(out)
  // A second build replaces the first.
  zips = await packSkills(out)
})
afterAll(async () => {
  await rm(join(SKILLS_DIR, 'ai-inspection', '.DS_Store'), { force: true })
  await rm(join(SKILLS_DIR, 'roi-inspection', 'scripts', '__pycache__'), { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})

/** Every file under a directory, relative to it with `/`. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === '__pycache__') continue
    if (item.isDirectory()) found.push(...await filesUnder(join(dir, item.name), `${prefix}${item.name}/`))
    else found.push(`${prefix}${item.name}`)
  }
  return found
}

const PYTHON = process.env.DSH_OFFICE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
/** The environment skill scripts run in: no proxy, so requests reach local servers, and a code page that cannot write Chinese. */
const SCRIPT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:https?|all|no)_proxy$/iu.test(name))),
  PYTHONIOENCODING: 'cp1252',
}

/**
 * Run a skill's Python script. A script killed at the timeout, or one whose interpreter is missing,
 * ends with code -1, so it is never taken for a success.
 */
async function runPython(
  script: string, args: readonly string[], env: Record<string, string | undefined> = {},
): Promise<{ code: number; out: string }> {
  return await new Promise((done) => {
    execFile(PYTHON, [script, ...args], { env: { ...SCRIPT_ENV, ...env }, timeout: 4000, encoding: 'utf8' }, (error, stdout) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out: stdout })
    })
  })
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
        // The video report's template counts 微博 and 视频号 comments; any other 评论 is Aily's comment delivery.
        const text = (await readFile(join(SKILLS_DIR, name, file), 'utf8')).replaceAll(/(?:微博|视频号)评论：/gu, '')
        // Aily, not the daily of a skill name.
        const forbidden = [/(?<![a-z])aily/iu, /larksuite-cli-guide/u, /\boc_[0-9a-f]{16,}/u, /\bou_[0-9a-f]{16,}/u, /cli_[0-9a-f]{16}/u]
        forbidden.push(/评论/u)
        // Base and table tokens are read from the configuration documents or the assistant's workspace.
        forbidden.push(/OU8JbYF8WahWo3sYEzwcTyBcn8b/u, /DMpmbusTjaZz60sYjFdcMjcRnTc|tbldnCoi0SeSDhWU/u)
        forbidden.push(/BfTxbFKoXaQghPsWPozcM9yun9e|tblA1lg0NDL5e8YI/u)
        forbidden.push(PEOPLE)
        for (const pattern of forbidden) expect(text, `${name}/${file}`).not.toMatch(pattern)
      }
    }
  })
})

describe('recommended tasks', () => {
  it('are tasks an assistant package accepts, declaring operations an automation task accepts', async () => {
    const tasks = await readTasks()
    expect(tasks.map(task => (task as { id: string }).id)).toEqual([
      'ai-inspection', 'pdd-live-report', 'pdd-meeting-todos', 'roi-internal-report', 'roi-provider-reminder', 'tianmao-daily-report', 'video-reminder', 'video-report',
    ])
    const parsed = manifestSchema.parse({ name: 'mingliu-ops', displayName: '运营日报助手', description: 'x', version: '1.0.0', tasks })
    expect(parsed.tasks[0]).toMatchObject({
      title: '天猫一店+拼多多工作日巡检', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '11:00' }, timeZone: 'Asia/Shanghai',
      connectors: [], permission: 'workspace-write', operations: ['lark-cli im +messages-send'],
    })
    // The live data runs every day, weekends too, and only appends rows.
    expect(parsed.tasks[1]).toMatchObject({
      title: '拼多多直播数据每日采集', timing: { kind: 'daily', time: '09:30' }, connectors: [], permission: 'workspace-write',
      operations: ['lark-cli sheets +cells-set'],
    })
    // The meeting sync only adds records: it declares the one write that adds them, not updating or deleting.
    expect(parsed.tasks[2]).toMatchObject({
      title: '拼多多日会待办同步', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '17:00' }, connectors: [], permission: 'workspace-write',
      operations: ['lark-cli base +record-batch-create'],
    })
    // The ROI runs only preview; what they send waits for the person's reply, so they declare nothing.
    expect(parsed.tasks[3]).toMatchObject({
      title: '投流ROI内部日报', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:30' }, connectors: [], permission: 'workspace-write',
    })
    expect(parsed.tasks[4]).toMatchObject({
      title: '投流ROI服务商提醒', timing: { kind: 'weekly', weekdays: [1, 3, 5], time: '10:00' }, connectors: [], permission: 'workspace-write',
    })
    expect([parsed.tasks[3]!.operations, parsed.tasks[4]!.operations]).toEqual([undefined, undefined])
    // The Tmall daily report fills the sheet at 06:00 and writes only cells.
    expect(parsed.tasks[5]).toMatchObject({
      title: '天猫日报采集填报', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '06:00' }, connectors: [], permission: 'workspace-write',
      operations: ['lark-cli sheets +cells-set'],
    })
    // The video report runs at 10:00 about yesterday, its reminder at 17:30 about today; each only sends its message.
    expect(parsed.tasks[6]).toMatchObject({ title: '视频素材绩效当日提醒', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '17:30' } })
    expect(parsed.tasks[7]).toMatchObject({ title: '视频素材绩效日报', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '10:00' } })
    for (const task of parsed.tasks.slice(6)) expect(task).toMatchObject({ connectors: [], operations: ['lark-cli im +messages-send'] })
    // Each run declares only the write it makes; other Feishu writes are not granted.
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
    const [, , , report, reminder] = await readTasks() as { prompt: string }[]
    expect(report!.prompt.match(/\boc_[0-9a-f]+/gu)).toEqual(['oc_94a59b1b5e0f87c703bccdc0f6a10daf'])
    expect(reminder!.prompt).not.toMatch(/\boc_|https:\/\/open\.feishu\.cn|\bou_/u)
    expect(reminder!.prompt).toContain('只发到 webhook 映射里的「测试群」')
    for (const prompt of [report!.prompt, reminder!.prompt]) expect(prompt).toContain('本次运行只出预览')
  })
})

describe('the meeting to-do sync', () => {
  it('reads its tables and people from the workspace, and writes through the one operation it declares, in either shell', async () => {
    const [, , sync] = await readTasks() as { prompt: string; operations: string[] }[]
    const skill = await readFile(join(SKILLS_DIR, 'pdd-meeting-todos', 'SKILL.md'), 'utf8')
    expect(sync!.prompt).not.toMatch(/DMpmbusTjaZz60sYjFdcMjcRnTc|BfTxbFKoXaQghPsWPozcM9yun9e/u)
    expect(sync!.prompt).toContain('pdd-meeting-todos/config.json')
    // The records go in a file, quoted so PowerShell does not read `@` as splatting.
    expect(skill).toContain(
      "lark-cli base +record-batch-create --base-token <todo.base_token> --table-id <todo.table_id> --json '@pdd-meeting-todos/batch-YYYYMMDD.json'",
    )
    const write = "lark-cli base +record-batch-create --base-token bascnX --table-id tblX --json '@pdd-meeting-todos/batch-20260907.json'"
    const remove = 'lark-cli base +record-delete --base-token bascnX --table-id tblX --record-id rec1'
    // The scheduled run's check lets the add through and refuses a delete, which the task does not declare.
    for (const dialect of ['bash', 'pwsh'] as const) {
      expect(declaredOperations(write, dialect, sync!.operations, false)).toEqual(['lark-cli base +record-batch-create'])
      expect(declaredOperations(remove, dialect, sync!.operations, false)).toBeUndefined()
    }
  })
})

describe('the video performance report', () => {
  it('sends only to the test group, and its send passes the unattended check in either shell', async () => {
    const [, , , , , , reminder, report] = await readTasks() as { prompt: string; operations: string[] }[]
    expect(report!.prompt).toContain('日期取昨天')
    expect(reminder!.prompt).toContain('日期取今天')
    for (const task of [report!, reminder!]) expect(task.prompt.match(/\boc_[0-9a-f]+/gu)).toEqual(['oc_94a59b1b5e0f87c703bccdc0f6a10daf'])
    const skill = await readFile(join(SKILLS_DIR, 'video-performance-report', 'SKILL.md'), 'utf8')
    expect(skill).toContain('距月GMV目标还差：数据待更新（月目标 14000 元）')
    const send = 'lark-cli im +messages-send --as bot --chat-id oc_x --msg-type text --idempotency-key video-report-日报-20261013 '
      + '--content \'{"text":"【小红书、微博、视频号素材绩效日报｜10月13日】<at user_id=\\"ou_x\\">x</at>\\n日期：10月13日"}\''
    for (const dialect of ['bash', 'pwsh'] as const) expect(declaredOperations(send, dialect, report!.operations, false)).toEqual(['lark-cli im +messages-send'])
  })
})

describe('holiday.py', () => {
  const script = join(SKILLS_DIR, 'video-performance-report', 'scripts', 'holiday.py')
  /** A stand-in chinese_calendar: 10-01 is National Day, 10-11 an ordinary Sunday, and 2030 is past its data. */
  const STAND_IN = [
    'import datetime',
    'def get_holiday_detail(day):',
    '    if day.year == 2030: raise NotImplementedError("no available data for year 2030")',
    '    if day == datetime.date(2026, 10, 1): return True, "National Day"',
    '    return day.weekday() >= 5, None',
  ].join('\n')
  /** A chinese_calendar that cannot be imported, as when the interpreter lacks it. */
  const MISSING = 'raise ImportError("No module named chinese_calendar")'

  async function judge(date: string | undefined, calendar = STAND_IN): Promise<{ code: number; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-holiday-'))
    try {
      await writeFile(join(dir, 'chinese_calendar.py'), calendar)
      const ended = await runPython(script, date === undefined ? [] : [date], { PYTHONPATH: dir })
      return { code: ended.code, out: ended.out.trim() }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('counts a named holiday, not an ordinary weekend, and cannot judge without the year\'s calendar', async () => {
    expect(await judge('2026-10-01')).toEqual({ code: 0, out: '{"date": "2026-10-01", "holiday": true, "name": "National Day"}' })
    expect(await judge('2026-10-11')).toEqual({ code: 0, out: '{"date": "2026-10-11", "holiday": false, "name": null}' })
    const unknownYear = await judge('2030-01-01')
    expect([unknownYear.code, unknownYear.out.startsWith('错误: 判断不了 2030-01-01')]).toEqual([2, true])
    expect((await judge('2026-10-12', MISSING)).code).toBe(2)
    for (const notDate of ['10月1日', '20261001', '2026-W40-4']) {
      const judged = await judge(notDate)
      expect([judged.code, judged.out]).toEqual([1, '错误: 需要一个 YYYY-MM-DD 日期参数'])
    }
    expect((await judge(undefined)).code).toBe(1)
  })
})

describe('send_webhook.py', () => {
  const script = join(SKILLS_DIR, 'roi-inspection', 'scripts', 'send_webhook.py')

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
      const ended = await runPython(script, args(url, dir))
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

describe('the Tmall daily report', () => {
  it('reads its sheet from the configuration document, and its cell writes pass the unattended check in either shell', async () => {
    const [, , , , , daily] = await readTasks() as { prompt: string; operations: string[] }[]
    expect(daily!.prompt).not.toMatch(/BdO2sx|0PYEgV/u)
    expect(daily!.prompt).toContain('《AI巡检固化配置》第五节')
    const skill = await readFile(join(SKILLS_DIR, 'tianmao-daily-report', 'SKILL.md'), 'utf8')
    expect(skill).toContain("lark-cli sheets +cells-set --as user --spreadsheet-token <token> --sheet-id <sheet_id> --range <range> --cells '@<file>'")
    const write = "lark-cli sheets +cells-set --as user --spreadsheet-token shtX --sheet-id s1 --range L2:L11 --cells '@tianmao-daily-report/20261013/cells-L2-L11.json'"
    const clear = 'lark-cli sheets +cells-clear --as user --spreadsheet-token shtX --sheet-id s1 --range L2:L11'
    for (const dialect of ['bash', 'pwsh'] as const) {
      expect(declaredOperations(write, dialect, daily!.operations, false)).toEqual(['lark-cli sheets +cells-set'])
      expect(declaredOperations(clear, dialect, daily!.operations, false)).toBeUndefined()
    }
  })

  it('carries the same holiday check as the video report', async () => {
    const copy = (skill: string) => readFile(join(SKILLS_DIR, skill, 'scripts', 'holiday.py'), 'utf8')
    expect(await copy('tianmao-daily-report')).toBe(await copy('video-performance-report'))
  })
})

describe('daily_report.py', () => {
  const script = join(SKILLS_DIR, 'tianmao-daily-report', 'scripts', 'daily_report.py')
  const LABELS = ['渠道', '店铺gmv', '外投花费（辅助项）', '外投成交', '外投投产', '自投花费', '自投成交', '自投投产', '推广花费', '推广成交', '推广投产', '会员', '店铺费比']
  const COLUMNS = ['A', 'B', 'G', 'H', 'K', 'L']
  const HEADERS: Record<string, string> = {
    A: '渠道', B: '负责人', G: '10月12日', H: '实际完成（10月12日）', K: '10月13日', L: '实际完成（10月13日）',
  }
  /** 10-12 as people filled it, in 万元 (投产 as ratios); 店铺费比 is a formula. */
  const FILLED_1012 = [32.65, 5.72, 6.85, 1.2, 1.81, 2.34, 1.29, 11.32, 14.44, 1.28, 0.5]

  type Cell = { value: unknown; formula?: string }
  /** What plan.json holds. */
  interface Plan {
    column: string
    writes: { cell: string; label: string; value: number }[]
    files: { range: string }[]
    skipped: { label: string; reason: string }[]
    not_written: string[]
  }
  /** The +cells-get answer of a sheet shaped like 10 月「店铺整体」, with cells changed by `edit`. */
  function cells(edit: (row: number, column: string, cell: Cell) => Cell = (_r, _c, cell) => cell): object {
    const rows = LABELS.map((label, r) => COLUMNS.map((column) => {
      const row = r + 1
      let cell: Cell = { value: null }
      if (row === 1) cell = { value: HEADERS[column] }
      else if (column === 'A') cell = { value: label }
      else if (label === '店铺费比' && (column === 'H' || column === 'L')) cell = { value: 0.3, formula: `=(${column}3+${column}9+${column}6)/${column}2` }
      else if (column === 'H') cell = { value: FILLED_1012[r - 1] }
      else if (column === 'L' && label === '会员') cell = { value: 0.6 }
      return edit(row, column, cell)
    }))
    return { ok: true, data: { ranges: [{ cells: rows, row_indices: LABELS.map((_l, r) => r + 1), col_indices: COLUMNS }] } }
  }

  /** What tmall-daily-figures printed for 2026-10-13 (real figures). */
  const TMALL = (date = '2026-10-13', alimama: object = {}) => ({
    platform: 'tmall', data: { date, platforms: [
      { platform: '生意参谋', date, metrics: { 全店支付金额: 326455.47, MO支付金额: 107565.75 }, missing: [], notes: [] },
      { platform: '万相台', date, metrics: {
        关键词推广花费: 67351.25, 关键词推广成交: 77473.03, 人群推广花费: 39783.68, 人群推广成交: 53286.31, 货品全站推花费: 6056.87, 货品全站推成交: 13603, ...alimama,
      }, missing: [], notes: [] },
    ] },
  })
  const YUNTAI = (date = '2026-10-13', metrics: object = {}) => ({
    platform: 'yuntai', data: { date, platforms: [{ platform: '健康品牌云台', date, metrics: {
      三方外投消耗: 75318.96, 三方外投有效GMV: 91920.27, 自投花费: 18105.81, 自投有效GMV: 23432.13, ...metrics,
    }, missing: [], notes: [] }] },
  })

  /** Run a command with files in a fresh directory; `files` values are JSON, or raw bytes. */
  async function run(args: (dir: string) => string[], files: Record<string, object | Uint8Array>) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-daily-report-'))
    try {
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, name), content instanceof Uint8Array ? content : JSON.stringify(content))
      }
      const ended = await runPython(script, args(dir))
      const read = async (name: string) => await readFile(join(dir, name), 'utf8').catch(() => undefined)
      return { ...ended, plan: await read('out/plan.json'), cellsFile: await read('out/cells-L2-L11.json') }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const planArgs = (date = '2026-10-13') => (dir: string) => [
    'plan', '--cells', join(dir, 'cells.json'), '--date', date,
    '--figures', join(dir, 't.json'), '--figures', join(dir, 'y.json'), '--out', join(dir, 'out'),
  ]

  it('plans the mapped cells of the day\'s 实际完成 column in 万元, leaving other rows and formulas alone', async () => {
    const ran = await run(planArgs(), { 'cells.json': cells(), 't.json': TMALL(), 'y.json': YUNTAI() })
    expect(ran.code).toBe(0)
    const plan = JSON.parse(ran.plan!) as Plan
    expect(plan.column).toBe('L')
    expect(plan.writes.map(({ cell, label, value }) => [cell, label, value])).toEqual([
      ['L2', '店铺gmv', 32.65], ['L3', '外投花费', 5.72], ['L4', '外投成交', 6.85], ['L5', '外投投产', 1.2], ['L6', '自投花费', 1.81],
      ['L7', '自投成交', 2.34], ['L8', '自投投产', 1.29], ['L9', '推广花费', 11.32], ['L10', '推广成交', 14.44], ['L11', '推广投产', 1.28],
    ])
    expect([plan.skipped, plan.not_written]).toEqual([[], ['会员', '店铺费比']])
    expect(JSON.parse(ran.cellsFile!)).toEqual(plan.writes.map(({ value }) => [{ value }]))
  })

  it('skips formulas, labels found twice, and figures that are missing or divide by zero, splitting the writes into runs', async () => {
    const edited = cells((row, column, cell) => {
      if (row === 3 && column === 'L') return { value: 5, formula: '=1+1' }
      if (row === 7 && column === 'A') return { value: '店铺gmv' }
      return cell
    })
    const figures = { 't.json': TMALL('2026-10-13', { 人群推广成交: null }), 'y.json': YUNTAI('2026-10-13', { 自投花费: 0, 自投有效GMV: 0 }) }
    const ran = await run(planArgs(), { 'cells.json': edited, ...figures })
    const plan = JSON.parse(ran.plan!) as Plan
    // 外投投产 still divides the collected figures when the 外投花费 cell is a formula.
    expect(plan.writes.map(({ cell }) => cell)).toEqual(['L4', 'L5', 'L6', 'L9'])
    expect(plan.files.map(({ range }) => range)).toEqual(['L4:L6', 'L9:L9'])
    expect(plan.skipped).toEqual([
      { label: '店铺gmv', reason: 'A 列指标名无法唯一定位：店铺gmv（找到 2 行）' },
      { label: '外投花费', reason: 'L3 是公式，已跳过' },
      { label: '自投成交', reason: 'A 列指标名无法唯一定位：自投成交（找到 0 行）' },
      { label: '自投投产', reason: '自投花费为 0' },
      { label: '推广成交', reason: '缺 万相台.人群推广成交（采集结果里没有）' },
      { label: '推广投产', reason: '推广成交或推广花费没有值' },
    ])
  })

  it('never replaces a cell a person filled, and lists the days that still have empty cells', async () => {
    const filled = cells((row, column, cell) => row === 2 && column === 'L' ? { value: 33.1 } : cell)
    const ran = await run(planArgs(), { 'cells.json': filled, 't.json': TMALL(), 'y.json': YUNTAI() })
    const plan = JSON.parse(ran.plan!) as Plan
    expect(plan.writes.map(({ cell }) => cell)[0]).toBe('L3')
    expect(plan.skipped).toEqual([{ label: '店铺gmv', reason: 'L2 已有值 33.1，未覆盖' }])
    const pending = (args: string[], content: object) => run(dir => ['pending', '--cells', join(dir, 'cells.json'), ...args], { 'cells.json': content })
    // 10-12 is filled (its 店铺费比 is a formula), 10-13 is empty.
    expect(JSON.parse((await pending(['--from', '2026-10-04', '--to', '2026-10-13'], cells())).out)).toEqual(['2026-10-13'])
    expect(JSON.parse((await pending(['--from', '2026-10-13', '--to', '2026-10-13'], cells())).out)).toEqual(['2026-10-13'])
    const done = cells((row, column, cell) => column === 'L' && row > 1 && row < 12 ? { value: 1 } : cell)
    expect(JSON.parse((await pending(['--from', '2026-10-04', '--to', '2026-10-13'], done)).out)).toEqual([])
    // Across the new year, October is last year's.
    expect(JSON.parse((await pending(['--from', '2026-10-04', '--to', '2027-01-03'], cells())).out)).toEqual(['2026-10-13'])
    expect((await pending(['--from', '2026-10-4', '--to', '2026-10-13'], cells())).code).toBe(2)
  })

  it('refuses inputs it cannot place: another month, figures of another day, unreadable files, a bad date', async () => {
    const cases: Array<[string[] | ((dir: string) => string[]), Record<string, object | Uint8Array>, string]> = [
      [planArgs('2026-11-02'), { 'cells.json': cells(), 't.json': TMALL('2026-11-02'), 'y.json': YUNTAI('2026-11-02') }, '表头里没有「实际完成（11月02日）」列'],
      [planArgs(), { 'cells.json': cells((row, column, cell) => row === 1 && column === 'H' ? { value: '实际完成（10月13日）' } : cell), 't.json': TMALL(), 'y.json': YUNTAI() }, '不止一列'],
      [planArgs(), { 'cells.json': cells(), 't.json': TMALL('2026-10-12'), 'y.json': YUNTAI() }, "采集文件的日期 ['2026-10-12', '2026-10-13'] 和 --date 2026-10-13 不一致"],
      [planArgs(), { 'cells.json': { ok: false }, 't.json': TMALL(), 'y.json': YUNTAI() }, '没有 data.ranges'],
      [planArgs(), { 'cells.json': cells(), 't.json': { data: {} }, 'y.json': YUNTAI() }, '不是 tmall-daily-figures 的输出'],
      [planArgs(), { 'cells.json': new TextEncoder().encode('not json'), 't.json': TMALL(), 'y.json': YUNTAI() }, '不是 JSON'],
      [planArgs(), { 't.json': TMALL(), 'y.json': YUNTAI() }, '读不了'],
      [planArgs('2026-10-1'), { 'cells.json': cells(), 't.json': TMALL(), 'y.json': YUNTAI() }, '日期要写成 YYYY-MM-DD'],
    ]
    for (const [args, files, why] of cases) {
      const ran = await run(typeof args === 'function' ? args : () => args, files)
      expect([ran.code, ran.out], why).toEqual([2, expect.stringContaining(why)])
    }
  })

  it('reads a file PowerShell 5.1 redirected as UTF-16', async () => {
    const utf16 = (value: object) => new Uint8Array([0xFF, 0xFE, ...new Uint8Array(Buffer.from(JSON.stringify(value), 'utf16le'))])
    const ran = await run(planArgs(), { 'cells.json': utf16(cells()), 't.json': utf16(TMALL()), 'y.json': YUNTAI() })
    expect(ran.code).toBe(0)
  })

  it('backtests against the figures people filled, passing within the tolerance and failing beyond it or without them', async () => {
    const args = (dir: string) => ['backtest', '--cells', join(dir, 'cells.json'), '--date', '2026-10-12', '--figures', join(dir, 't.json'), '--figures', join(dir, 'y.json')]
    const passed = await run(args, { 'cells.json': cells(), 't.json': TMALL('2026-10-12'), 'y.json': YUNTAI('2026-10-12') })
    expect([passed.code, passed.out]).toEqual([0, expect.stringContaining('结论：回测通过')])
    expect(passed.out).toContain('| 店铺gmv | 32.65 | 32.65 | 通过（差异 0.01%，允许 1%） |')
    expect(passed.out).toContain('| 外投投产 | 1.2 | 1.2 | 随花费与成交判定 |')
    expect(passed.out).toContain('| 外投成交 | 6.85 | 6.85 | 通过（差异 0.02%，允许 2%） |')
    // 3.5% more 店铺gmv is beyond 1%; a key figure nobody filled cannot be compared.
    const off = await run(args, { 'cells.json': cells(), 't.json': TMALL('2026-10-12'), 'y.json': YUNTAI('2026-10-12', { 自投有效GMV: null }) })
    expect([off.code, off.out]).toEqual([1, expect.stringContaining('| 自投成交 | 2.34 |  | 不通过：缺 健康品牌云台.自投有效GMV（采集结果里没有） |')])
    const empty = await run(args, {
      'cells.json': cells((row, column, cell) => row === 4 && column === 'H' ? { value: null } : cell),
      't.json': TMALL('2026-10-12', { 关键词推广成交: 87473.03 }), 'y.json': YUNTAI('2026-10-12'),
    })
    expect(empty.out).toContain('| 外投成交 |  | 6.85 | 不通过：表中无值，这一天不能用来回测 |')
    expect(empty.out).toContain('| 推广成交 | 14.44 | 15.44 | 不通过（差异 6.90%，允许 1%） |')
    expect(empty.code).toBe(1)
  })

  it('passes small figures within rounding, and does not judge a ratio whose spend is 0', async () => {
    const args = (dir: string) => ['backtest', '--cells', join(dir, 'cells.json'), '--date', '2026-10-12', '--figures', join(dir, 't.json'), '--figures', join(dir, 'y.json')]
    // 345 yuan of 自投 is 0.0345 万元, which a person wrote as 0.03.
    const small = cells((row, column, cell) => column === 'H' && row === 6 ? { value: 0.03 } : column === 'H' && row === 3 ? { value: 7.5 } : cell)
    const figures = { 't.json': TMALL('2026-10-12'), 'y.json': YUNTAI('2026-10-12', { 自投花费: 345, 三方外投消耗: 75345 }) }
    const ran = await run(args, { 'cells.json': small, ...figures })
    expect(ran.out).toContain('| 自投花费 | 0.03 | 0.03 | 通过（差异 15.00%，允许 1%） |')
    // A day without 自投 spend has no 自投投产 to compute, which does not fail the backtest.
    const none = cells((row, column, cell) => column === 'H' && (row === 6 || row === 7) ? { value: 0 } : cell)
    const idle = await run(args, { 'cells.json': none, ...figures, 'y.json': YUNTAI('2026-10-12', { 自投花费: 0, 自投有效GMV: 0, 三方外投消耗: 57213.15, 三方外投有效GMV: 68488.14 }) })
    expect([idle.code, idle.out]).toEqual([0, expect.stringContaining('| 自投投产 | 1.29 |  | 随花费与成交判定 |')])
    expect(ran.code).toBe(0)
  })

  it('lists the days people filled every key figure, latest first', async () => {
    const both = cells((row, column, cell) => column === 'L' && row > 1 && row < 12 ? { value: 1 } : cell)
    const listed = await run(dir => ['candidates', '--cells', join(dir, 'cells.json')], { 'cells.json': both })
    expect(JSON.parse(listed.out)).toEqual([{ month: 10, day: 13, column: 'L' }, { month: 10, day: 12, column: 'H' }])
    const only = await run(dir => ['candidates', '--cells', join(dir, 'cells.json')], { 'cells.json': cells() })
    expect(JSON.parse(only.out)).toEqual([{ month: 10, day: 12, column: 'H' }])
    const renamed = await run(dir => ['candidates', '--cells', join(dir, 'cells.json')], {
      'cells.json': cells((row, column, cell) => row === 2 && column === 'A' ? { value: '全店gmv' } : cell),
    })
    expect([renamed.code, renamed.out]).toEqual([2, expect.stringContaining('A 列找不到唯一的 店铺gmv')])
  })

  it('verifies the written cells and that no other plain cell of the column changed', async () => {
    const plan = { column: 'L', writes: [{ cell: 'L2', row: 2, label: '店铺gmv', value: 32.65 }] }
    const args = (dir: string) => ['verify', '--plan', join(dir, 'plan.json'), '--before', join(dir, 'before.json'), '--after', join(dir, 'after.json')]
    const written = cells((row, column, cell) => row === 2 && column === 'L' ? { value: 32.65 } : row === 13 && column === 'L' ? { value: 0.9, formula: '=x' } : cell)
    const ok = await run(args, { 'plan.json': plan, 'before.json': cells(), 'after.json': written })
    expect([ok.code, ok.out]).toEqual([0, expect.stringContaining('回读一致：1 格写入值正确')])
    const touched = cells((row, column, cell) => row === 2 && column === 'L' ? { value: '32.6' } : row === 12 && column === 'L' ? { value: 0.7 } : cell)
    const bad = await run(args, { 'plan.json': plan, 'before.json': cells(), 'after.json': touched })
    expect([bad.code, bad.out]).toEqual([1, expect.stringContaining('L2（店铺gmv）应为 32.65，回读为 32.6\nL12 不该被改动：写前 0.6，写后 0.7')])
  })
})

describe('the 拼多多 live report', () => {
  it('reads its sheet from the workspace, and its row write passes the unattended check in either shell', async () => {
    const [, live] = await readTasks() as { prompt: string; operations: string[] }[]
    expect(live!.prompt).toContain('pdd-live-report/config.json')
    const skill = await readFile(join(SKILLS_DIR, 'pdd-live-report', 'SKILL.md'), 'utf8')
    for (const text of [live!.prompt, skill]) expect(text).not.toMatch(/MqX2sxfqYhDJFytomMzcAuSgnod|0PpnJi/u)
    const write = "lark-cli sheets +cells-set --as user --spreadsheet-token shtX --sheet-id s1 --range A31:I31 --cells '@pdd-live-report/20261013/row.json'"
    for (const dialect of ['bash', 'pwsh'] as const) expect(declaredOperations(write, dialect, live!.operations, false)).toEqual(['lark-cli sheets +cells-set'])
  })
})

describe('live_row.py', () => {
  const script = join(SKILLS_DIR, 'pdd-live-report', 'scripts', 'live_row.py')
  type Cell = { value: unknown; formula?: string }
  /** The +cells-get answer of A1:I<rows>: a header and one row per given day, as dates are read back. */
  function sheet(rows: Cell[][]): object {
    const header = ['日期', '直播GMV', '直播支付订单', '客单价', '直播支付转化率', '人均观看时长', '千次进人成交', '直播间涨粉数', '每日观看量'].map(value => ({ value }))
    const all = [header, ...rows]
    return { data: { ranges: [{ cells: all, row_indices: all.map((_r, i) => i + 1), col_indices: 'ABCDEFGHI'.split('') }] } }
  }
  const day = (date: unknown): Cell[] => [{ value: date }, { value: 12991.67 }, { value: 455 }, { value: 28.55, formula: '=B2/C2' }, { value: 0.005 }, { value: 0.27 }, { value: 109.22 }, { value: 1262 }, { value: 119953 }]
  /** What pdd-live-figures printed for 2026-10-13 (real figures). */
  const LIVE = (date = '2026-10-13', metrics: object = {}) => ({ platform: 'pinduoduo', data: { date, platforms: [{ platform: '拼多多直播', date, metrics: {
    直播GMV: 12721.91, 直播支付订单: 494, 直播支付转化率: 0.0061, 人均观看时长: 0.3, 累计观看量: 106590, 千次进人成交: 120.29, 直播间涨粉数: 1078, ...metrics,
  }, missing: [], notes: [] }] } })

  async function run(args: (dir: string) => string[], files: Record<string, object>) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-live-row-'))
    try {
      for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(content))
      const ended = await runPython(script, args(dir))
      return { ...ended, row: await readFile(join(dir, 'out', 'row.json'), 'utf8').catch(() => undefined) }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const plan = (dir: string) => ['plan', '--cells', join(dir, 'cells.json'), '--figures', join(dir, 'live.json'), '--out', join(dir, 'out')]

  it('appends the day after the last row: a slash date, the 客单价 formula, and a percent conversion', async () => {
    // 2026-10-12 as Feishu reads a date back (a serial number), and as text.
    for (const date of [46307, '2026/10/12']) {
      const ran = await run(plan, { 'cells.json': sheet([day('2026/10/11'), day(date)]), 'live.json': LIVE() })
      expect(ran.code).toBe(0)
      expect(JSON.parse(ran.out)).toMatchObject({ status: 'append', date: '2026-10-13', row: 4, range: 'A4:I4' })
      expect(JSON.parse(ran.row!)).toEqual([[
        { value: '2026/10/13', cell_styles: { number_format: 'yyyy/m/d' } }, { value: 12721.91, cell_styles: { number_format: '0.00' } }, { value: 494 },
        { formula: '=B4/C4', cell_styles: { number_format: '0.00' } }, { value: 0.0061, cell_styles: { number_format: '0.00%' } },
        { value: 0.3 }, { value: 120.29 }, { value: 1078 }, { value: 106590 },
      ]])
    }
  })

  it('writes a day once, never between rows, and nothing from incomplete figures', async () => {
    const twice = await run(plan, { 'cells.json': sheet([day('2026-10-13')]), 'live.json': LIVE() })
    expect([twice.code, twice.row, JSON.parse(twice.out)]).toEqual([0, undefined, expect.objectContaining({ status: 'exists' })])
    const cases: Array<[object, object, string]> = [
      [sheet([day('2026/10/14')]), LIVE(), '早于表中最后的日期 2026-10-14'],
      [sheet([]), LIVE('2026-10-13', { 直播间涨粉数: null }), '采集结果缺少 直播间涨粉数'],
      [sheet([]), { data: { platforms: [] } }, '不是 pdd-live-figures 的输出'],
      [sheet([]), LIVE('2026/13/40'), '不是 YYYY-MM-DD'],
      [sheet([day('2026/10/11'), day('合计')]), LIVE(), 'A 列最后一行（第 3 行「合计」）不是日期'],
      [{ data: {} }, LIVE(), '没有 data.ranges'],
    ]
    for (const [cells, live, why] of cases) {
      const ran = await run(plan, { 'cells.json': cells, 'live.json': live })
      expect([ran.code, ran.row, ran.out], why).toEqual([2, undefined, expect.stringContaining(why)])
    }
  })

  it('refuses a row past the sheet\'s last grid row', async () => {
    const full = await run(dir => [...plan(dir), '--rows', '2'], { 'cells.json': sheet([day('2026/10/12')]), 'live.json': LIVE() })
    expect([full.code, full.row, full.out]).toEqual([2, undefined, expect.stringContaining('表格只有 2 行，新行要写到第 3 行：请先在表末尾插入空行')])
    const room = await run(dir => [...plan(dir), '--rows', '3'], { 'cells.json': sheet([day('2026/10/12')]), 'live.json': LIVE() })
    expect(room.code).toBe(0)
  })

  it('lists the days after the last row up to yesterday, a week at most', async () => {
    const pending = async (rows: Cell[][], to: string) => {
      const ran = await run(dir => ['pending', '--cells', join(dir, 'cells.json'), '--to', to], { 'cells.json': sheet(rows) })
      return ran.code === 0 ? JSON.parse(ran.out) as string[] : ran.out
    }
    expect(await pending([day('2026/10/11')], '2026-10-13')).toEqual(['2026-10-12', '2026-10-13'])
    expect(await pending([day('2026/10/13')], '2026-10-13')).toEqual([])
    expect(await pending([day('2026/9/1'), day('合计')], '2026-10-13')).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'])
    expect(await pending([], '2026-10-13')).toEqual(['2026-10-13'])
    expect(await pending([], '2026-02-30')).toContain('不是有效日期')
    expect(await pending([], '2026/10/13')).toContain('--to 要写成 YYYY-MM-DD')
  })

  it('verifies the new row and that no other row changed, flagging a date read back as text', async () => {
    const files = async (after: Cell[], earlier: Cell[] = day('2026/10/12')) => {
      const planned = await run(plan, { 'cells.json': sheet([day('2026/10/12')]), 'live.json': LIVE() })
      return await run(dir => ['verify', '--plan', join(dir, 'plan.json'), '--before', join(dir, 'before.json'), '--after', join(dir, 'after.json')], {
        'plan.json': JSON.parse(planned.out) as object, 'before.json': sheet([day('2026/10/12')]), 'after.json': sheet([earlier, after]),
      })
    }
    const good: Cell[] = [
      { value: 46308 }, { value: 12721.91 }, { value: 494 }, { value: 25.75, formula: '=B3/C3' }, { value: '0.61%' }, { value: 0.3 }, { value: 120.29 }, { value: 1078 },
      { value: 106590 },
    ]
    const ok = await files(good)
    expect([ok.code, ok.out]).toEqual([0, expect.stringContaining('回读一致：第 3 行')])
    expect(ok.out).not.toContain('提醒')
    const text = await files([{ value: '2026/10/13' }, ...good.slice(1)])
    expect([text.code, text.out]).toEqual([0, expect.stringContaining('提醒：A3 回读为文字「2026/10/13」，请确认它是日期格式而不是文本。')])
    // A ratio off by 0.005 and a GMV off by a cent are wrong, not rounding.
    const bad = await files([{ value: '2026/10/12' }, { value: 12721.92 }, { value: 494 }, { value: 25.75 }, { value: 0.0111 }, ...good.slice(5, 8), {} as Cell])
    expect([bad.code, bad.out]).toEqual([1, expect.stringContaining([
      'A3 应为日期 2026/10/13，回读为 2026/10/12', 'B3 应为 12721.91，回读为 12721.92', 'D3 应为公式 =B3/C3，回读为 25.75', 'E3 应为 0.0061，回读为 0.0111',
      'I3 应为 106590，回读为 None',
    ].join('\n'))])
    const touched = await files(good, [{ value: '2026/10/12' }, { value: 1 }, ...day('2026/10/12').slice(2)])
    expect([touched.code, touched.out]).toEqual([1, expect.stringContaining('B2 不该被改动：写前 12991.67，写后 1')])
  })
})
