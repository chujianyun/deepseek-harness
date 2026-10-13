// Company assistant packages over the real composition: a mock user center lists a package; the
// Assistants page installs it (its Skill from the Skill Hub, one missing Skill reported), the detail
// page switches a recommended task on as an automation task, an update keeps the core file the
// employee changed, and switching the task off deletes its schedule.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-assistant-packages'
import type {} from '@deepseek-ai/dsh-assistants'
import type {} from '@deepseek-ai/dsh-automation-tasks'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-skill-market'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './assistants.overlay.yml', './automation-tasks.overlay.yml', './assistant-packages.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))

const CORE = {
  'IDENTITY.md': '# 身份\n\n- **名称**：运营日报助手\n',
  'SOUL.md': '# 人格\n\n- 数值可追溯。\n',
  'USER.md': '# 用户信息\n',
  'AGENTS.md': '# 工作方法\n\n只读闸门。\n',
}

const manifest = (version: string, prompt: string) => ({
  name: 'ops-report', displayName: '运营日报助手', description: '每天巡检与日报', version, avatar: 'ocean',
  skills: ['roi-inspection', 'not-on-hub'], connectors: ['feishu'],
  tasks: [
    { id: 'inspection', title: '部门 AI 巡检', prompt, timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '11:00' }, timeZone: 'Asia/Shanghai', connectors: [] },
    { id: 'report', title: '天猫日报', prompt: '采集昨日数据', timing: { kind: 'daily', time: '06:00' }, timeZone: 'Asia/Shanghai', connectors: [] },
  ],
})

function packageOf(version: string, prompt: string, files: Record<string, string> = CORE) {
  const m = manifest(version, prompt)
  const zip = zipSync({ 'agent.json': strToU8(JSON.stringify(m)), ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])) })
  return { id: 'pkg-ops', name: m.name, version, manifest: m, zip }
}

it('installs a company package, switches its task on and off, and updates without overwriting the employee\'s edit', async () => {
  const center = await startMockUserCenter()
  center.skills = [{ id: 's-roi', name: 'roi-inspection', description: 'ROI 巡检', category: null, version: '1.0.0', files: { 'scripts/run.sh': 'echo roi\n' } }]
  center.agentPackages = [packageOf('1.0.0', '跑今日巡检')]
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-assistant-packages-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([
    { id: 'assistants', config: { dshHome: harnessHome } },
    { id: 'assistant-packages', config: { dshHome: harnessHome } },
    { id: 'skill-filesystem', config: { dshHome: harnessHome, agentsHome: join(harnessHome, 'agents') } },
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    const ctx = scaffold.ctx
    await ctx.hubAccount.signIn()
    await expect.poll(async () => (await ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await ctx.hubAccount.getState()).status).toBe('signed-in')
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'assistant-packages')

    // Install from the company section: the assistant joins the list, the Hub Skill installs, the missing one is named.
    await page.getByRole('button', { name: '智能体', exact: true }).first().click()
    const company = page.getByRole('region', { name: '企业智能体' })
    await expect.poll(() => company.getByText('版本 1.0.0 · 推荐定时任务 2 条').isVisible()).toBe(true)
    await company.getByRole('button', { name: '安装' }).click()
    const notice = company.getByRole('status')
    await expect.poll(() => notice.textContent()).toContain('已安装「运营日报助手」。')
    expect(await notice.textContent()).toContain('已从 Skill Hub 安装技能：roi-inspection。')
    expect(await notice.textContent()).toContain('请联系管理员：not-on-hub。')
    const assistant = (await ctx.assistants.getState()).assistants.find(item => item.name === '运营日报助手')!
    expect(assistant.subsets).toEqual({ skills: ['roi-inspection', 'not-on-hub'], connectors: ['feishu'] })
    expect((await ctx.assistants.getAssistant(assistant.id)).files['SOUL.md']).toBe(CORE['SOUL.md'])
    expect((await ctx.skillMarket.records()).has('roi-inspection')).toBe(true)

    // Switch the inspection task on from the detail page; it becomes an automation task bound to the assistant.
    await company.getByRole('button', { name: '查看' }).click()
    const tasks = page.getByRole('region', { name: '推荐定时任务' })
    const inspection = tasks.locator('[data-task-id="inspection"]')
    await expect.poll(() => inspection.textContent()).toContain('周一至周五 11:00 · 未开启')
    await inspection.getByRole('button', { name: '开启' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '开启' }).click()
    await expect.poll(() => inspection.textContent()).toContain('已开启')
    const [scheduled] = await ctx.schedule.catalog()
    expect(scheduled).toMatchObject({ title: '部门 AI 巡检', prompt: '跑今日巡检', kind: 'weekly', weekdays: [1, 2, 3, 4, 5], status: 'active' })
    const resolved = await ctx.sessionController.resolveAgent(scheduled!.sessionId)
    if ('error' in resolved) throw resolved.error
    expect(ctx.sessionProjections.stateOf(resolved.agent.session, 'assistant')?.assistantId).toBe(assistant.id)

    // The employee changes SOUL.md; the administrator publishes 1.1.0 changing SOUL.md, AGENTS.md, and the task.
    await ctx.assistants.updateAssistant(assistant.id, { files: { 'SOUL.md': '# 人格\n\n- 我自己的口径。\n' } })
    center.agentPackages = [packageOf('1.1.0', '跑今日巡检（新口径）', { ...CORE, 'SOUL.md': '# 人格\n\n- 新人格。\n', 'AGENTS.md': '# 工作方法\n\n新方法。\n' })]
    await page.reload()
    await page.getByRole('button', { name: '智能体', exact: true }).first().click()
    await company.getByRole('button', { name: '更新到 1.1.0' }).click()
    await expect.poll(() => company.getByRole('status').textContent()).toContain('你改过的文件保留了原样：SOUL.md。')
    const updated = await ctx.assistants.getAssistant(assistant.id)
    expect(updated.files['SOUL.md']).toBe('# 人格\n\n- 我自己的口径。\n')
    expect(updated.files['AGENTS.md']).toBe('# 工作方法\n\n新方法。\n')
    await company.getByRole('button', { name: '查看' }).click()
    await expect.poll(() => inspection.textContent()).toContain('新版本改了这条任务')

    // Switching it off deletes the schedule.
    await inspection.getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => inspection.textContent()).toContain('未开启')
    expect(await ctx.schedule.catalog()).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'assistant-packages')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
})
