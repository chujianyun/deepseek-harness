import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
        forbidden.push(PEOPLE)
        for (const pattern of forbidden) expect(text, `${name}/${file}`).not.toMatch(pattern)
      }
    }
  })
})

describe('recommended tasks', () => {
  it('are tasks an assistant package accepts, declaring operations an automation task accepts', async () => {
    const tasks = await readTasks()
    expect(tasks.map(task => (task as { id: string }).id)).toEqual(['ai-inspection'])
    const parsed = manifestSchema.parse({ name: 'mingliu-ops', displayName: '运营日报助手', description: 'x', version: '1.0.0', tasks })
    expect(parsed.tasks[0]).toMatchObject({
      title: '天猫一店+拼多多工作日巡检', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '11:00' }, timeZone: 'Asia/Shanghai',
      connectors: [], permission: 'workspace-write', operations: ['lark-cli im +messages-send'],
    })
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
})
