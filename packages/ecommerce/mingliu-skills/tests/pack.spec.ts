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
import { CORE_FILES, packAgent, packSkills, readTasks, SKILLS } from '../src/index.ts'

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
      'ai-inspection', 'pdd-live-report', 'pdd-meeting-todos', 'roi-internal-report', 'roi-provider-reminder', 'tianmao-daily-report', 'video-reminder', 'video-report', 'yuntai-collect',
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
    for (const task of parsed.tasks.slice(6, 8)) expect(task).toMatchObject({ connectors: [], operations: ['lark-cli im +messages-send'] })
    // The 云台 backfill runs on weekdays at 07:00 and only adds records.
    expect(parsed.tasks[8]).toMatchObject({
      title: '站外投流云台数据每日补采', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '07:00' }, connectors: [], permission: 'workspace-write',
      operations: ['lark-cli base +record-batch-create'],
    })
    // Each run declares only the write it makes; other Feishu writes are not granted.
    expect(JSON.stringify(tasks)).not.toMatch(PEOPLE)
    for (const task of parsed.tasks) expect(readOperations(task.operations ?? [])).toEqual({ operations: task.operations ?? [] })
  })

  it('send the inspection only to the test group while it is in development', async () => {
    const [inspection] = await readTasks() as { prompt: string }[]
    expect(inspection!.prompt.match(/\boc_[0-9a-f]+/gu)).toEqual(['oc_492528df63e4be9cd8b7dcb2eeed26ce'])
    // No month or table token is fixed in the instruction: the month's mapping is read from the configuration document.
    expect(inspection!.prompt).not.toMatch(/OPEN_ID|\bou_|20\d\d-\d\d(?!-\d)|BdO2sx|KGJzsl|B6KNbU/u)
  })

  it('send the ROI report only to the test group, and the provider reminders only to the test group webhook', async () => {
    const [, , , report, reminder] = await readTasks() as { prompt: string }[]
    expect(report!.prompt.match(/\boc_[0-9a-f]+/gu)).toEqual(['oc_492528df63e4be9cd8b7dcb2eeed26ce'])
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
      "lark-cli base +record-batch-create --as user --base-token <todo.base_token> --table-id <todo.table_id> --json '@pdd-meeting-todos/batch-YYYYMMDD.json'",
    )
    const write = "lark-cli base +record-batch-create --as user --base-token bascnX --table-id tblX --json '@pdd-meeting-todos/batch-20260907.json'"
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
    for (const task of [report!, reminder!]) expect(task.prompt.match(/\boc_[0-9a-f]+/gu)).toEqual(['oc_492528df63e4be9cd8b7dcb2eeed26ce'])
    const skill = await readFile(join(SKILLS_DIR, 'video-performance-report', 'SKILL.md'), 'utf8')
    expect(skill).toContain('距月GMV目标还差：数据待更新（月目标 14000 元）')
    // The message goes in a file lark-cli reads, so no shell has to quote it.
    const send = 'lark-cli im +messages-send --as bot --chat-id oc_x --msg-type text --idempotency-key video-report-日报-20261013 '
      + '--content "@video-performance-report/日报-20261013.json"'
    expect(skill).toContain('--content "@video-performance-report/<日报|提醒>-YYYYMMDD.json"')
    for (const dialect of ['bash', 'pwsh'] as const) expect(declaredOperations(send, dialect, report!.operations, false)).toEqual(['lark-cli im +messages-send'])
    for (const name of ['ai-inspection', 'plan-roi-analysis']) {
      expect(await readFile(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'), name).toMatch(/--msg-type interactive [^\n]*--content "@[^"]+card\.json"/u)
    }
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
    // A test points the skill at a test sheet through the workspace, not the shared configuration document.
    expect(skill).toContain('tianmao-daily-report/sheet.json')
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

describe('the 云台 backfill', () => {
  it('reads its Base from the configuration document or a test mapping, and its add passes the unattended check in either shell', async () => {
    const tasks = await readTasks() as { prompt: string; operations: string[] }[]
    const collect = tasks[8]!
    expect(collect.prompt).toContain('yuntai-collect/tables.json')
    const skill = await readFile(join(SKILLS_DIR, 'yuntai-collect', 'SKILL.md'), 'utf8')
    for (const text of [collect.prompt, skill]) expect(text).not.toMatch(/OU8JbYF8WahWo3sYEzwcTyBcn8b|tbl[0-9A-Za-z]{12}/u)
    const write = "lark-cli base +record-batch-create --as user --base-token bascnX --table-id tblX --json '@yuntai-collect/20261014/20261013/batch-在达-0.json'"
    const remove = 'lark-cli base +record-delete --as user --base-token bascnX --table-id tblX --record-id rec1'
    for (const dialect of ['bash', 'pwsh'] as const) {
      expect(declaredOperations(write, dialect, collect.operations, false)).toEqual(['lark-cli base +record-batch-create'])
      expect(declaredOperations(remove, dialect, collect.operations, false)).toBeUndefined()
    }
  })
})

describe('collect_plan.py', () => {
  const script = join(SKILLS_DIR, 'yuntai-collect', 'scripts', 'collect_plan.py')
  const row = (id: string, name: string, cost = 1) => ({
    账户id: id, 账户名称: name, 消耗: cost, 总GMV: 2, 有效GMV: 1.5, 退款率: 0.0835, 退款金额: 0.5, 总ROI: 2, 有效ROI: 1.5,
  })
  /** 2026-10-13's accounts as yuntai-accounts.mjs prints them; the check says whether the rows add up. */
  const ACCOUNTS = (rows = [
    row('1871401277666316', '上海法马有性格网络科技有限公司-在达ad01', 27748.53), row('1', '上海法马-道有道-名流-CID-03'), row('2', '名流-爆款003-ML-1'),
    row('3', '豹擎-名流-官旗店-粉MO-13-jw'), row('4', '某新服务商-01'), row('5', '名流-剧星-1'),
  ], matches = true) => ({ platform: 'yuntai', data: { date: '2026-10-13', channel: '抖音', accounts: rows, check: [{ field: '消耗', rows: 1, total: matches ? 1 : 2, matches }] } })
  const TABLES = { base_token: 'bascnX', tables: { 在达: 'tblZaida', 道有道: 'tblDao', 豹擎: 'tblBao', 剧星: 'tblJu' } }
  /** A +record-list page: fields under `fields`, text as segments, the date as a timestamp. */
  const page = (records: [number | string, string][]) => ({ data: { items: records.map(([date, id]) => ({ record_id: `rec${id}`, fields: { 日期: date, 账户id: [{ type: 'text', text: id }] } })), has_more: false } })
  const OCT12 = new Date('2026-10-12T00:00:00+08:00').getTime()

  async function run(args: (dir: string) => string[], files: Record<string, object>) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-collect-'))
    try {
      for (const [name, content] of Object.entries(files)) {
        await mkdir(join(dir, name, '..'), { recursive: true })
        await writeFile(join(dir, name), JSON.stringify(content))
      }
      const ended = await runPython(script, args(dir))
      const read = async (name: string) => await readFile(join(dir, 'out', name), 'utf8').then(text => JSON.parse(text) as unknown, () => undefined)
      return { ...ended, plan: await read('plan.json'), zaida: await read('batch-在达-0.json') }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const gap = (extra: string[] = []) => (dir: string) => ['gap', '--records', join(dir, 'records'), '--to', '2026-10-13', ...extra]
  const plan = (dir: string) => ['plan', '--accounts', join(dir, 'a.json'), '--tables', join(dir, 't.json'), '--records', join(dir, 'records'), '--out', join(dir, 'out')]

  it('finds the days after the latest date of every table and the checkpoint, two weeks at most', async () => {
    const fromTables = await run(gap(), {
      'records/在达-0.json': page([[OCT12 - 86_400_000, '1']]), 'records/道有道-0.json': page([['2026-10-12 00:00:00', '1']]), 'records/notes.txt.json': {},
    })
    expect(JSON.parse(fromTables.out)).toEqual({ breakpoint: '2026-10-12', per_table_max: { 在达: '2026-10-11', 道有道: '2026-10-12' }, pending: ['2026-10-13'] })
    const checkpointed = await run(gap(['--checkpoint', '/nonexistent']), { 'records/在达-0.json': page([['2026/9/1', '1']]) })
    expect((JSON.parse(checkpointed.out) as { pending: string[] }).pending).toHaveLength(14)
    const marked = await run(dir => [...gap()(dir), '--checkpoint', join(dir, 'c.json')], { 'records/在达-0.json': page([['2026-09-01', '1']]), 'c.json': { breakpoint: '2026-10-13' } })
    expect((JSON.parse(marked.out) as { pending: string[] }).pending).toEqual([])
    // 10-13 reached one table but not all of them: the checkpoint stayed at 10-12, so 10-13 is done again.
    const partial = await run(dir => [...gap()(dir), '--checkpoint', join(dir, 'c.json')], {
      'records/道有道-0.json': page([['2026-10-13', '1']]), 'c.json': { breakpoint: '2026-10-12T00:00:00' },
    })
    expect(JSON.parse(partial.out)).toMatchObject({ breakpoint: '2026-10-12', pending: ['2026-10-13'] })
    // +record-list prints a matrix: column names, and rows in their order.
    const matrix = { ok: true, data: { fields: ['账户id', '日期'], field_id_list: ['f1', 'f2'], record_id_list: ['r1', 'r2'], data: [['1', OCT12], ['2', 'x'], 'bad'] } }
    expect(JSON.parse((await run(gap(), { 'records/在达-0.json': matrix })).out)).toMatchObject({ breakpoint: '2026-10-12', pending: ['2026-10-13'] })
    const empty = await run(gap(), { 'records/在达-0.json': page([]) })
    expect(JSON.parse(empty.out)).toMatchObject({ breakpoint: null, pending: ['2026-10-13'] })
    const missing = await run(dir => ['gap', '--records', join(dir, 'none'), '--to', '2026-10-13'], {})
    expect([missing.code, missing.out]).toEqual([2, expect.stringContaining('没有记录目录')])
    expect((await run(dir => ['gap', '--records', dir, '--to', '2026-02-30'], {})).out).toContain('日期要写成 YYYY-MM-DD')
  })

  it('writes each provider its new rows, skipping rows the table has and accounts it cannot place', async () => {
    const ran = await run(plan, { 'a.json': ACCOUNTS(), 't.json': TABLES, 'records/道有道-0.json': page([[OCT12 + 86_400_000, '1']]) })
    expect(ran.code).toBe(0)
    expect(ran.plan).toMatchObject({
      date: '2026-10-13', accounts: 6, already_written: 1, self_operated: ['名流-爆款003-ML-1'], unknown_provider: ['某新服务商-01'], no_table: {},
      writes: [
        { provider: '剧星', table_id: 'tblJu', count: 1, accounts: ['5'] }, { provider: '在达', table_id: 'tblZaida', count: 1 }, { provider: '豹擎', table_id: 'tblBao', count: 1 },
      ],
    })
    expect(ran.zaida).toEqual({
      fields: ['账户id', '账户名称', '投放平台', '日期', '消耗', '总GMV', '有效GMV', '退款率', '退款金额'],
      rows: [['1871401277666316', '上海法马有性格网络科技有限公司-在达ad01', '抖音', '2026-10-13 00:00:00', 27748.53, 2, 1.5, 0.0835, 0.5]],
    })
    const noTable = await run(plan, { 'a.json': ACCOUNTS([row('9', '大小无忧-名流-法马-1')]), 't.json': TABLES, 'records/x.json': {} })
    expect(noTable.plan).toMatchObject({ writes: [], no_table: { 大小无忧: ['大小无忧-名流-法马-1'] } })
  })

  it('writes nothing when the rows do not add up to the total, or the files are not what it reads', async () => {
    const off = await run(plan, { 'a.json': ACCOUNTS(undefined, false), 't.json': TABLES, 'records/x.json': {} })
    expect([off.code, off.plan, off.out]).toEqual([2, undefined, expect.stringContaining('账户行合计与总计行对不上：消耗 账户合计 1 / 总计 2，不写')])
    const notAccounts = await run(plan, { 'a.json': { data: { plans: [] } }, 't.json': TABLES, 'records/x.json': {} })
    expect(notAccounts.out).toContain('不是 yuntai-accounts.mjs 的输出')
    const unchecked = { platform: 'yuntai', data: { date: '2026-10-13', accounts: [row('1', '名流-青出蓝')] } }
    expect((await run(plan, { 'a.json': unchecked, 't.json': TABLES, 'records/x.json': {} })).out).toContain('没有和总计行的对账结果（check），不写')
    const blank = await run(plan, { 'a.json': ACCOUNTS([row('', '名流-青出蓝'), row('7', '豹擎-1')]), 't.json': TABLES, 'records/x.json': {} })
    expect([blank.code, blank.plan, blank.out]).toEqual([2, undefined, expect.stringContaining('这些账户没有账户id，无法查重：名流-青出蓝，不写')])
  })

  it('verifies each planned row is in its table exactly once', async () => {
    const planned = { date: '2026-10-13', writes: [{ provider: '在达', table_id: 't', file: 'f', count: 2, accounts: ['1', '2'] }] }
    const verify = (records: object) => run(dir => ['verify', '--plan', join(dir, 'p.json'), '--records', join(dir, 'records')], { 'p.json': planned, 'records/在达-0.json': records })
    const ok = await verify(page([['2026-10-13 00:00:00', '1'], [OCT12 + 86_400_000, '2']]))
    expect([ok.code, ok.out]).toEqual([0, expect.stringContaining('写后核对一致：2026-10-13 共 2 条')])
    const bad = await verify(page([['2026-10-13', '1'], ['2026-10-13', '1']]))
    expect([bad.code, bad.out]).toEqual([1, expect.stringContaining('在达 表 2026-10-13 账户 1：有 2 条，重复了\n在达 表 2026-10-13 账户 2：没有写进去')])
  })
})

describe('inspection_card.py', () => {
  const script = join(SKILLS_DIR, 'ai-inspection', 'scripts', 'inspection_card.py')
  interface Card {
    schema: string
    config: { summary: { content: string } }
    header: { title: { content: string }; subtitle: { content: string }; template: string }
    body: { elements: { tag: string; content?: string }[] }
  }
  async function run(input: unknown) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-inspection-card-'))
    try {
      await writeFile(join(dir, 'items.json'), JSON.stringify(input))
      const ended = await runPython(script, ['--items', join(dir, 'items.json'), '--out', join(dir, 'out')])
      const text = await readFile(join(dir, 'out', 'card.json'), 'utf8').catch(() => undefined)
      return { ...ended, text, card: text === undefined ? undefined : JSON.parse(text) as Card }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const sections = (card: Card) => card.body.elements.filter(element => element.tag === 'markdown').map(element => element.content!)
  /** 拼多多 of 2026-10-15, as the first test run read it, with an owner-less 店铺 renamed. */
  const PDD = {
    platform: '拼多多', date: '2026-10-15', items: [
      { owner: '店长甲', name: '名流计生用品官方旗舰店', target: 10, actual: 9.42 },
      { owner: '店长乙', name: '名流保健官方旗舰店', target: 1.91, actual: 1.67 },
      { owner: '店长乙', name: '名流男性用品官方旗舰店', target: 9.8, actual: 9.1 },
      { owner: '店长丙', name: '名流成人保健品官方旗舰店', target: 0.78, actual: 0.7 },
      { owner: '店长甲', name: '名流成人保健品旗舰店', target: 3.31, actual: 2.79 },
      { owner: '店长丁', name: '名流保健情趣旗舰店', target: 2, actual: 2.174 },
    ],
  }

  it('grades each row once, and builds the card in the format of the inspection cards before it', async () => {
    const ran = await run(PDD)
    expect([ran.code, ran.out]).toEqual([0, expect.stringContaining('拼多多 2026-10-15：需优先关注 3、轻微偏移 2、达标 1、待更新 0、目标为空 0、辅助项 0；本次提醒完整性：完整。')])
    const card = ran.card!
    expect([card.schema, card.header.template, card.header.title.content, card.header.subtitle.content]).toEqual(['2.0', 'blue', '【部门群巡检提醒｜拼多多】', '巡检日期：10月15日'])
    expect(card.config.summary.content).toBe('拼多多10月15日巡检：名流保健官方旗舰店87.4%、名流成人保健品官方旗舰店89.7%、名流成人保健品旗舰店84.3%低于90%')
    // Five sections divided by lines, each opening with its bold name.
    expect(card.body.elements.map(element => element.tag)).toEqual(['markdown', 'hr', 'markdown', 'hr', 'markdown', 'hr', 'markdown', 'hr', 'markdown'])
    const [date, advice, focus, mild, ending] = sections(card)
    expect(date).toBe('**巡检日期**\n10月15日')
    expect(advice).toBe('**整体建议**\n- 本日 3 家店铺达成率低于 90%，建议相关负责人复查货品/投放/流量/转化链路。\n- AI只做数据解读和提醒，不替代负责人判断。')
    expect(focus).toBe([
      '**需优先关注**', '**店长乙**', '- 名流保健官方旗舰店：目标 1.91，实际 1.67，达成率 87.4%，暂无环比数据。',
      '', '**店长丙**', '- 名流成人保健品官方旗舰店：目标 0.78，实际 0.70，达成率 89.7%，暂无环比数据。',
      '', '**店长甲**', '- 名流成人保健品旗舰店：目标 3.31，实际 2.79，达成率 84.3%，暂无环比数据。',
    ].join('\n'))
    // A row at or over its target is in neither list; a row in 90%~100% only under the slight shifts.
    // A blank line parts the owners: without it Feishu runs the next owner's name into the list item above.
    expect(mild).toBe('**轻微偏移观察**\n**店长甲**\n- 名流计生用品官方旗舰店：94.2%\n\n**店长乙**\n- 名流男性用品官方旗舰店：92.9%')
    expect(ran.text).not.toContain('名流保健情趣旗舰店')
    expect(ending).toContain('机器人只发送提醒，不接收回复。')
    expect(ran.out).toContain('【部门群巡检提醒｜拼多多】\n巡检日期：10月15日\n\n巡检日期\n10月15日')
  })

  it('keeps pending, target-less, reverse, and spending rows out of the wrong lists', async () => {
    const ran = await run({
      platform: '天猫一店', date: '2026-10-12', items: [
        { owner: '甲', name: '自投成交', target: 3, actual: 2.26, suggestion: '核实自投渠道货品/投放/流量/转化链路。', note: '原因：素材未过审。' },
        { owner: '乙', name: '外投成交', target: 10, actual: 9.831 },
        { owner: '乙', name: '外投花费', target: 5, actual: 2, direction: 'auxiliary' },
        { owner: '丙', name: '店铺费比', target: 0.2, actual: 0.25, direction: 'reverse' },
        { owner: '丙', name: '排名', target: 3, actual: 0, direction: 'reverse' },
        { owner: '丁', name: '会员', target: 1, actual: null },
        { owner: '丁', name: '直播', target: 0, actual: 1 },
      ],
    })
    expect([ran.code, ran.out]).toEqual([0, expect.stringContaining('需优先关注 2、轻微偏移 1、达标 0、待更新 1、目标为空 2、辅助项 1；本次提醒完整性：不完整。')])
    const [, advice, focus, mild] = sections(ran.card!)
    expect(advice).toBe([
      '**整体建议**', '- 本日 2 项指标达成率低于 90%，建议相关负责人复查货品/投放/流量/转化链路。', '- 1 项实际待更新（会员），建议补齐后复核。',
      '- 2 项目标为空，不判断（排名、直播）。', '- 花费类（外投花费）为投放辅助项，不计入偏移统计与达成率判断，仅作参考。', '- AI只做数据解读和提醒，不替代负责人判断。',
    ].join('\n'))
    // 天猫一店 rates keep two decimals, as its cards did.
    expect(focus).toContain('- 自投成交：目标 3.00，实际 2.26，达成率 75.33%，暂无环比数据。原因：素材未过审。建议：核实自投渠道货品/投放/流量/转化链路。')
    expect(focus).toContain('- 店铺费比：目标 0.20，实际 0.25，达成率 80.00%')
    expect(mild).toBe('**轻微偏移观察**\n**乙**\n- 外投成交：98.31%')
    const calm = await run({ platform: '天猫一店', date: '2026-10-12', items: [{ owner: '甲', name: '店铺gmv', target: 1, actual: 1 }, { owner: '甲', name: "'s", target: 1, actual: null }] })
    expect(sections(calm.card!).slice(2, 4)).toEqual(['**需优先关注**\n本日无达成率低于 90% 的项。', '**轻微偏移观察**\n本日无落在 90%–100% 区间的项。'])
    expect(calm.card!.config.summary.content).toBe('天猫一店10月12日巡检：无低于90%的项')
    // A quote that would end a single-quoted shell string is a JSON escape in the file.
    expect(calm.text).toContain('\\u0027s')
  })

  it('refuses what it cannot read', async () => {
    const item = { owner: '甲', name: '店铺gmv', target: 1, actual: 1 }
    for (const [input, message] of [
      [{ ...PDD, platform: '北美TTS' }, 'platform 只能是 天猫一店 / 拼多多'],
      [{ ...PDD, date: '10月15日' }, 'date 要写成 YYYY-MM-DD'],
      [{ ...PDD, items: [] }, 'items 不能为空'],
      [{ ...PDD, items: [{ ...item, owner: '' }] }, '第 1 项缺少 owner 或 name'],
      [{ ...PDD, items: [{ ...item, direction: 'up' }] }, '第 1 项 direction 只能是'],
      [{ ...PDD, items: [{ ...item, actual: '1.2' }] }, '第 1 项 actual 要是数字或 null'],
    ] as const) {
      const ran = await run(input)
      expect([ran.code, ran.card, ran.out]).toEqual([2, undefined, expect.stringContaining(message)])
    }
    const huge = await run({ ...PDD, items: Array.from({ length: 400 }, (_v, i) => ({ ...item, name: `店铺-${'很长的名字'.repeat(10)}-${String(i)}`, actual: 0.5 })) })
    expect([huge.code, huge.out]).toEqual([2, expect.stringContaining('卡片自检不通过：卡片')])
  })
})

describe('inspection_read.py', () => {
  const script = join(SKILLS_DIR, 'ai-inspection', 'scripts', 'inspection_read.py')
  const card = join(SKILLS_DIR, 'ai-inspection', 'scripts', 'inspection_card.py')
  type Cell = string | number | null | { value: unknown; formula?: string }
  /** `lark-cli sheets +cells-get --include value,formula` output for rows from 1, columns from A. */
  const cells = (rows: Cell[][], extra: Record<string, unknown> = {}) => {
    const width = Math.max(...rows.map(row => row.length))
    const letter = (i: number): string => (i >= 26 ? letter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26))
    return {
      ok: true,
      data: {
        has_more: false,
        ranges: [{
          row_indices: rows.map((_row, i) => i + 1),
          col_indices: Array.from({ length: width }, (_v, i) => letter(i)),
          cells: rows.map(row => Array.from({ length: width }, (_v, i) => (typeof row[i] === 'object' && row[i] !== null ? row[i] : { value: row[i] ?? null }))),
          ...extra,
        }],
      },
    }
  }
  async function run(files: Record<string, unknown>, args: (dir: string) => string[]) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-inspection-read-'))
    try {
      for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(content))
      const ended = await runPython(script, args(dir))
      const items = await readFile(join(dir, 'items.json'), 'utf8').then(t => JSON.parse(t) as { platform: string; date: string; items: Record<string, unknown>[] }, () => undefined)
      const carded = items ? await runPython(card, ['--items', join(dir, 'items.json'), '--out', join(dir, 'card')]) : undefined
      return { ...ended, items, carded }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  /** 天猫 sheet: a 4-column block a day, the first target header written 「目标（…）」, the others the bare date. */
  const TMALL = [
    ['渠道', '负责人', '实际完成(w) 9月', '10月目标', '10月增量', '实际完成(w) 10月', '目标（10月01日）', '实际完成（10月01日）', '完成率（10月01日）', '原因及策略（10月01日）', '10月02日', '实际完成（10月02日）'],
    ['店铺gmv', '甲', 1071, 1200, 129, { value: 60, formula: '=H2+L2' }, '30.34 ', '28.66 ', null, null, '36.31 ', '34.82 '],
    ['外投花费', '乙', 156, 230, 74, 0, '5', '6.03', null, null, '6.78 ', '7.02 '],
    ['会员', '丙', 1, 1, 1, 0, '14.16 ', null, null, null, '14.16 ', null],
    ['店铺费比', '甲', 1, 1, 1, 0, '61.64%', '0.6', null, null, '61.64%', { value: 0.592475588742102, formula: '=(L3)/L2' }],
    ['备注', null, null, null, null, null, null, null, null, null, 'x', 'y'],
  ]
  const tmall = (sheet: unknown, date = '2026-10-02') => run({ 'cells.json': sheet }, dir => ['tmall', '--cells', join(dir, 'cells.json'), '--date', date, '--out', join(dir, 'items.json')])

  it('reads 天猫 rows from the target and actual columns of the day, by their headers', async () => {
    const ran = await tmall(cells(TMALL))
    expect([ran.code, ran.out]).toEqual([0, expect.stringContaining('天猫一店 2026-10-02：读到 4 行')])
    expect(ran.items).toEqual({
      platform: '天猫一店', date: '2026-10-02', items: [
        { owner: '甲', name: '店铺gmv', target: 36.31, actual: 34.82, direction: 'normal', source: 'K2/L2' },
        { owner: '乙', name: '外投花费', target: 6.78, actual: 7.02, direction: 'auxiliary', source: 'K3/L3' },
        { owner: '丙', name: '会员', target: 14.16, actual: null, direction: 'normal', source: 'K4/L4' },
        { owner: '甲', name: '店铺费比', target: 0.6164, actual: 0.592475588742102, direction: 'reverse', source: 'K5/L5', percent: true },
      ],
    })
    expect(ran.out).toContain('- 丙｜会员：目标 14.16，实际 待更新（K4/L4）')
    // A read written with --output-path holds only the data part.
    expect((await tmall(cells(TMALL).data)).items).toEqual(ran.items)
    // The first day's target column is headed 「目标（10月01日）」.
    expect((await tmall(cells(TMALL), '2026-10-01')).items!.items[0]).toMatchObject({ target: 30.34, actual: 28.66, source: 'G2/H2' })
    // A percentage row keeps its percentages on the card.
    const shown = await tmall(cells([TMALL[0]!, ['店铺费比', '甲', 1, 1, 1, 0, null, null, null, null, '50.00%', '80.00%']]))
    expect(shown.carded!.out).toContain('- 店铺费比：目标 50.00%，实际 80.00%，达成率 62.50%')
  })

  it('refuses a 天猫 sheet whose day it cannot place, or a read that is not whole', async () => {
    const missing = await tmall(cells(TMALL), '2026-10-03')
    expect([missing.code, missing.items, missing.out]).toEqual([2, undefined, expect.stringContaining('表头里「实际完成（10月3日）」没有')])
    for (const [sheet, message] of [
      [cells([[...TMALL[0]!.slice(0, 11), '实际完成（10月02日）', '实际完成（10月02日）'], ...TMALL.slice(1)]), '不止一列'],
      [cells([[...TMALL[0]!.slice(0, 10), '原因', '实际完成（10月02日）'], ...TMALL.slice(1)]), '左边一列的表头是「原因」'],
      [cells([TMALL[0]!, ['备注', null]]), 'A 列没有同时写了指标和负责人的行'],
      [cells(TMALL, { truncated: true }), '读数被截断'],
      [{ data: { ...cells(TMALL).data, has_more: true } }, '没读全（has_more）'],
      [{ data: {} }, '里没有 ranges'],
    ] as const) {
      const ran = await tmall(sheet)
      expect([ran.code, ran.items, ran.out]).toEqual([2, undefined, expect.stringContaining(message)])
    }
    expect((await tmall(cells(TMALL), '10月2日')).out).toContain('--date 要写成 YYYY-MM-DD')
  })

  /** 拼多多: targets by date column in 万元; actuals a record a day in 元, store fields mostly without 「名流」. */
  const TARGETS = [
    ['店铺名称', '负责人', '每天平均GMV（万元）', '10月1日', '10月2日'],
    ['名流旗舰店', '甲', '7.40', { value: 7.252, formula: '=7.4*E19' }, { value: 7.252, formula: '=7.4*E19' }],
    ['名流官方旗舰店', '乙', '6.70', 6.566, 6.566],
    ['名流情趣旗舰店', '甲', '7.35', 7.203, 7.203],
    ['名流器械保健旗舰店', '丙', '1', 1, 1],
    ['合计', null, null, '21', '21'],
  ]
  const record = (date: string | number, values: Record<string, string>) => ({ 日期: date, 日期1: '星期', 目标: 685900, 合计: '0', ...values })
  const actuals = (records: Record<string, unknown>[], fields = ['日期', '日期1', '目标', '合计', '旗舰店', '名流官方旗舰店', '情趣旗舰店', '保健情趣旗舰店'], hasMore = false) => ({
    ok: true, data: { fields, data: records.map(r => fields.map(f => r[f] ?? '')), has_more: hasMore },
  })
  const DAY2 = record('2026-10-02T00:00:00.000+08:00', { 旗舰店: '57734.32', 名流官方旗舰店: '72394.00', 情趣旗舰店: '', 保健情趣旗舰店: '30003' })
  const pdd = (targets: unknown, acts: unknown) =>
    run({ 'targets.json': targets, 'actuals.json': acts }, dir => ['pdd', '--target-cells', join(dir, 'targets.json'), '--actuals', join(dir, 'actuals.json'), '--date', '2026-10-02', '--out', join(dir, 'items.json')])

  it('matches each 拼多多 store to its actuals field, with or without 「名流」, and converts 元 to 万元', async () => {
    const ran = await pdd(cells(TARGETS), actuals([record('2026-10-01T00:00:00.000+08:00', { 旗舰店: '1' }), DAY2]))
    expect([ran.code, ran.items]).toEqual([0, {
      platform: '拼多多', date: '2026-10-02', items: [
        { owner: '甲', name: '名流旗舰店', target: 7.25, actual: 5.7734, direction: 'normal', source: 'E2/旗舰店' },
        { owner: '乙', name: '名流官方旗舰店', target: 6.57, actual: 7.2394, direction: 'normal', source: 'E3/名流官方旗舰店' },
        { owner: '甲', name: '名流情趣旗舰店', target: 7.2, actual: null, direction: 'normal', source: 'E4/情趣旗舰店' },
      ],
    }])
    // A store in the actuals but not among the targets is named, not graded.
    expect(ran.out).toContain('实际表里有目标表没有的店铺，未纳入：保健情趣旗舰店')
    expect(ran.carded!.out).toContain('- 名流旗舰店：目标 7.25，实际 5.77，达成率 79.6%')
    // A date read as a timestamp in milliseconds counts in Asia/Shanghai.
    const stamped = await pdd(cells(TARGETS), actuals([{ ...DAY2, 日期: Date.UTC(2026, 9, 1, 16) }]))
    expect(stamped.items!.items[0]).toMatchObject({ actual: 5.7734 })
  })

  it('stops when a store or the day cannot be found once', async () => {
    for (const [targets, acts, message] of [
      [cells(TARGETS), actuals([DAY2], ['日期', '名流官方旗舰店', '情趣旗舰店']), '「名流旗舰店」在实际表里找不到对应字段'],
      [cells(TARGETS), actuals([DAY2], ['日期', '旗舰店', '旗舰店', '名流官方旗舰店', '情趣旗舰店']), '对上了多个字段：旗舰店、旗舰店'],
      [cells(TARGETS), actuals([]), '日期为 2026-10-02 的记录没有'],
      [cells(TARGETS), actuals([DAY2, DAY2]), '不止一条'],
      [cells(TARGETS), actuals([DAY2], undefined, true), '实际表没读全'],
      [cells(TARGETS), actuals([DAY2], ['名流旗舰店']), '实际表没有「日期」字段'],
      [cells(TARGETS), { data: [] }, '不是 lark-cli base +record-list --format json 的输出'],
      [cells(TARGETS.map(row => row.slice(0, 4))), actuals([DAY2]), '目标表表头里「10月2日」没有'],
      [cells([TARGETS[0]!, ['合计', null]]), actuals([DAY2]), '目标表 A 列没有同时写了店铺和负责人的行'],
    ] as const) {
      const ran = await pdd(targets, acts)
      expect([ran.code, ran.items, ran.out]).toEqual([2, undefined, expect.stringContaining(message)])
    }
  })
})

describe('plan_roi.py', () => {
  const script = join(SKILLS_DIR, 'plan-roi-analysis', 'scripts', 'plan_roi.py')
  const plan = (id: string, name: string, account: string, cost: number, gmv: number, roi: number) => ({
    计划ID: id, 计划名称: name, 账户id: 'a', 账户名称: account, 消耗: cost, 总GMV: gmv, 有效GMV: gmv, 退款率: 0, 退款金额: 0, 总ROI: roi, 有效ROI: roi,
  })
  /** Plans of 2026-10-07~13 (real ids and figures, a few of them). */
  const PLANS = [
    plan('7680509391439478793', '0901_过审素材_1', '上海法马-道有道-名流-CID-03', 10271.35, 16790.41, 1.63),
    plan('7657093152461144102', '粉MO_063004医疗健康/二类医疗器械_4', '名流-官旗粉MO-ML-1', 936.28, 3258.58, 3.48),
    plan('7688162732307005481', "9.22-（提价增量）'s ‘新’", '上海法马有性格网络科技有限公司-在达ad01', 37362.09, 44586.7, 1.19),
    plan('7677539386985332774', '0831编辑|0824-最低-1', '豹擎-名流-官旗店-粉MO-13-jw', 1003.25, 390.36, 0.39),
    plan('7686335944308195374', '9.17-对话类型素材合集1*5', '上海法马有性格网络科技有限公司-在达ad01', 36663.56, 54770.09, 1.49),
    plan('1', '小计划', '名流-剧星-1', 700, 100, 0.14),
  ]
  async function run(plans: unknown, extra: string[] = []) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-plan-roi-'))
    try {
      await writeFile(join(dir, 'plans.json'), JSON.stringify(plans))
      const ended = await runPython(script, ['--plans', join(dir, 'plans.json'), '--out', join(dir, 'out'), ...extra])
      const card = await readFile(join(dir, 'out', 'card.json'), 'utf8').catch(() => undefined)
      const classified = await readFile(join(dir, 'out', 'classified.json'), 'utf8').then(t => JSON.parse(t) as Record<string, unknown>, () => undefined)
      return { ...ended, card, classified }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const data = (plans: unknown[]) => ({ platform: 'yuntai', data: { from: '2026-10-07', to: '2026-10-13', plans } })

  it('sorts plans over the spend line into three bands and builds the card with their full ids', async () => {
    const ran = await run(data(PLANS))
    expect([ran.code, ran.out]).toEqual([0, expect.stringContaining('计划 6 条，消耗 > 700 的 5 条；高 ROI 2、达标 1、低 ROI 2；整体有效 ROI 1.38')])
    expect(ran.classified).toMatchObject({ over: 5, overall_roi: 1.38 })
    expect(ran.card).not.toContain("'")
    interface Card {
      schema: string
      header: { title: { content: string }; template: string }
      body: { elements: { tag: string; content: string }[] }
    }
    const card = JSON.parse(ran.card!) as Card
    expect([card.schema, card.header.template, card.header.title.content]).toEqual(['2.0', 'blue', '站外投流 · 7天高ROI计划清单（2026-10-07–2026-10-13）'])
    const [summary, high, boost, stop, accounts] = card.body.elements.map(element => element.content)
    expect(card.body.elements).toHaveLength(5)
    expect(summary).toContain('**分档**：高 ROI（≥1.5）2 条 · 达标（1.2~1.5）1 条 · 低 ROI（<1.2）2 条')
    expect(high).toContain('| 1 | 粉MO_063004医疗健康/二类医疗器械_4 | 7657093152461144102 | 名流-官旗粉MO-ML-1 | 936.28 | 3,258.58 | 3.48 |')
    expect(boost!.split('\n')[1]).toBe('- 0901_过审素材_1（7680509391439478793）· 消耗 10,271.35 · ROI 1.63')
    expect(stop).toContain('| 0831编辑/0824-最低-1 | 7677539386985332774 |')
    // Quotes that end a single-quoted shell string are JSON escapes in the file, and read back as they were.
    expect(ran.card).toContain('9.22-（提价增量）\\u0027s')
    expect(ran.card).not.toMatch(/[\u2018\u2019]/u)
    expect(stop).toContain("9.22-（提价增量）'s")
    expect(accounts).toContain('- 头部高效账户：名流-官旗粉MO-ML-1（有效 ROI 3.48，高 ROI 计划 1 条）')
    expect(accounts).toContain('- 不达标账户（有效 ROI 低于 1.2）：豹擎-名流-官旗店-粉MO-13-jw')
  })

  it('takes other lines, and says so when a band or the window is empty', async () => {
    const raised = await run(data(PLANS), ['--spend-min', '10000', '--hi', '1.6', '--mid', '1.5'])
    expect(raised.out).toContain('消耗 > 10000 的 3 条；高 ROI 1、达标 0、低 ROI 2')
    const none = await run(data([]))
    const card = JSON.parse(none.card!) as { body: { elements: { content: string }[] } }
    expect(card.body.elements.map(element => element.content).join('\n')).toMatch(/整体有效 ROI\*\*：无消耗[\s\S]*按 ROI 从高到低）\*\*\n\n无[\s\S]*- 无高 ROI 计划[\s\S]*最低 10 条）\*\*\n\n无[\s\S]*计划）\*\*\n\n无\n\n- 不达标账户（有效 ROI 低于 1.2）：无/u)
  })

  it('shortens the high-ROI table to fit the card, and refuses what it cannot read', async () => {
    const many = Array.from({ length: 200 }, (_v, i) => plan(`76000000000000${String(10000 + i)}`, `高ROI计划-${'很长的计划名称'.repeat(4)}-${String(i)}`, '在达', 1000 + i, 3000, 3))
    const ran = await run(data(many))
    expect([ran.code, ran.out]).toEqual([0, expect.stringMatching(/卡片自检通过（高 ROI 表列出 \d+ 条）/u)])
    expect(ran.card).toMatch(/另有 \d+ 条高 ROI 计划未列出（卡片篇幅所限）/u)
    expect(Buffer.byteLength(ran.card!)).toBeLessThanOrEqual(28000)
    expect((await run(data(PLANS), ['--hi', '1.2', '--mid', '1.5'])).out).toContain('--mid 1.5 要小于 --hi 1.2')
    expect((await run({ data: {} })).out).toContain('不是 yuntai-plans.mjs 的输出')
    const windowless = await run({ data: { plans: PLANS } })
    expect([windowless.code, windowless.out]).toEqual([2, expect.stringContaining('不是 yuntai-plans.mjs 的输出')])
    const huge = Array.from({ length: 300 }, (_v, i) => plan(String(i), 'x', `账户-${'很长的账户名'.repeat(10)}-${String(i)}`, 800, 100, 0.1))
    const tooBig = await run(data(huge))
    expect([tooBig.code, tooBig.card, tooBig.out]).toEqual([2, undefined, expect.stringContaining('卡片自检不通过：卡片')])
  })
})

describe('packAgent', () => {
  it('builds 「运营日报助手」 as an assistant package naming every 名流 skill, the data skills they run, office, and Feishu', async () => {
    const zip = await packAgent(out)
    expect(zip).toBe(join(out, 'mingliu-ops-report-1.0.0.zip'))
    const entries = unzipSync(await readFile(zip))
    expect(Object.keys(entries).sort()).toEqual(['agent.json', ...CORE_FILES].map(name => `mingliu-ops-report/${name}`).sort())
    const manifest = manifestSchema.parse(JSON.parse(strFromU8(entries['mingliu-ops-report/agent.json']!)))
    expect(manifest).toMatchObject({ name: 'mingliu-ops-report', displayName: '运营日报助手', version: '1.0.0', connectors: ['feishu'] })
    expect(manifest.skills).toEqual(expect.arrayContaining([...SKILLS, 'tmall-daily-figures', 'yuntai-details', 'pdd-live-figures', 'office-docx', 'office-pptx', 'office-xlsx']))
    expect(manifest.skills).toHaveLength(SKILLS.length + 6)
    expect(manifest.tasks.map(task => task.id)).toEqual((await readTasks() as { id: string }[]).map(task => task.id))
    expect(manifest.tasks).toHaveLength(9)
    // The disciplines of the handover reach the model through the core files.
    const soul = strFromU8(entries['mingliu-ops-report/SOUL.md']!)
    for (const rule of ['只读闸门', '配置与逻辑分离', '数值可追溯', '按名定位，不写死', '回测先于写表', '切换期防重复']) expect(soul).toContain(rule)
    for (const name of CORE_FILES) expect(strFromU8(entries[`mingliu-ops-report/${name}`]!), name).not.toMatch(PEOPLE)
  })
})
