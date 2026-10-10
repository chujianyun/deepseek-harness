// Automation tasks made from a form: the Host composer creates the task's Session, named after it
// and bound to its assistant and permission preset, and the schedule that runs it; a refused task
// leaves no Session behind.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-assistants'
import type {} from '@deepseek-ai/dsh-automation-tasks'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './assistants.overlay.yml', './automation-tasks.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))

/** Boot the enterprise composition signed in to a mock user center, with the Daily Assistant seeded. */
async function launch() {
  const center = await startMockUserCenter()
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-automation-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([
    { id: 'assistants', config: { dshHome: harnessHome } },
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const close = async () => {
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
  await scaffold.ctx.hubAccount.signIn()
  await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
  await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
  await expect.poll(async () => (await scaffold.ctx.assistants.getState()).assistants.length).toBe(1)
  return { scaffold, close }
}

it('creates the task\'s Session with its assistant and permission, schedules it, and rolls a refused task back', async () => {
  const { scaffold, close } = await launch()
  try {
    const ctx = scaffold.ctx
    const daily = (await ctx.assistants.getState()).assistants[0]!
    const catalog = ctx.permissionPresets.catalog()
    const preset = catalog.options.find(option => option.value !== catalog.defaultPreset)!.value
    const sessions = async () => (await ctx.sessionController.list({}, new AbortController().signal)).items.map(item => item.sessionId)
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd, '默认工作区')

    const created = await ctx.automationTasks.create({
      title: '每日简报', prompt: '整理昨天的待办并给出今天的建议', workspaceId: workspace.id, assistantId: daily.id, permission: preset,
      timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
      window: { end: '2099-12-31', time_zone: 'Asia/Shanghai' },
    })
    expect(created.record).toMatchObject({ kind: 'daily', title: '每日简报', prompt: '整理昨天的待办并给出今天的建议' })
    const [task] = await ctx.schedule.catalog()
    expect(task).toMatchObject({ id: created.record.id, sessionId: created.sessionId, status: 'active', window: { end: '2099-12-31' } })
    expect(await sessions()).toContain(created.sessionId)
    // The Session is filed under the chosen workspace, so the sidebar lists it there.
    expect(ctx.workspaceRegistry.get(workspace.id)?.sessionIds).toContain(created.sessionId)
    const resolved = await ctx.sessionController.resolveAgent(created.sessionId)
    if ('error' in resolved) throw resolved.error
    expect(ctx.sessionProjections.stateOf(resolved.agent.session, 'assistant')?.assistantId).toBe(daily.id)
    expect(ctx.permissionPresets.current(resolved.agent.session)).toBe(preset)
    expect(ctx.sessionTitle.get(resolved.agent.session)?.title).toBe('每日简报')

    // A task with no run inside its effective dates is refused before any Session exists.
    const listed = await sessions()
    await expect(ctx.automationTasks.create({
      title: '过期任务', prompt: '不会执行', workspaceId: workspace.id,
      timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } }, window: { end: '2020-01-01', time_zone: 'Asia/Shanghai' },
    })).rejects.toMatchObject({ code: 'automation-tasks/invalid', details: { code: 'invalid_rule' } })
    expect(await sessions()).toEqual(listed)
    // A refusal after the Session exists archives it: here an assistant the tenant does not have.
    await expect(ctx.automationTasks.create({
      title: '无效智能体', prompt: '不会执行', workspaceId: workspace.id, assistantId: 'missing',
      timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
    })).rejects.toMatchObject({ code: 'assistants/not-found' })
    const refused = (await sessions()).filter(id => !listed.includes(id))
    expect(refused).toHaveLength(1)
    await expect.poll(() => ctx.workspaceRegistry.archivedSessionIds).toEqual(refused)
    expect((await ctx.schedule.catalog()).map(item => item.id)).toEqual([created.record.id])
  } finally {
    await close()
  }
})

it('opens the Add automation task form from New, saves a task with its assistant, and lists it selected', async () => {
  const { scaffold, close } = await launch()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
  try {
    const ctx = scaffold.ctx
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'automation')
    const workspace = ctx.workspaceRegistry.list()[0]!
    const daily = (await ctx.assistants.getState()).assistants[0]!

    // New opens the form in place, not a Session.
    await page.getByRole('button', { name: '自动化任务', exact: true }).click()
    await page.getByRole('heading', { level: 1, name: '自动化任务' }).waitFor()
    const sessionsBefore = (await ctx.sessionController.list({}, new AbortController().signal)).items.length
    await page.getByRole('button', { name: '新建自动化任务' }).click()
    const form = page.getByRole('form', { name: '添加自动化任务' })
    await form.waitFor()
    await expect.poll(() => form.getByRole('note').textContent()).toContain('请勿关闭电脑')
    expect((await ctx.sessionController.list({}, new AbortController().signal)).items.length).toBe(sessionsBefore)

    // Saving without a name or prompt explains both and creates nothing.
    await form.getByRole('button', { name: '保存' }).click()
    await expect.poll(() => form.getByRole('alert').allTextContents()).toEqual(['请输入名称', '请输入提示词'])

    await form.getByLabel('名称', { exact: true }).fill('每日简报')
    await form.getByLabel('提示词', { exact: true }).fill('整理昨天的待办并给出今天的建议')
    await form.getByLabel('智能体').selectOption(daily.id)
    await form.getByLabel('重复').selectOption('weekdays')
    await form.getByLabel('时间', { exact: true }).fill('08:30')
    await form.getByLabel('结束日期').fill('2099-12-31')
    const shots = process.env['DSH_E2E_SHOT_DIR']
    if (shots !== undefined && shots !== '') await page.screenshot({ path: join(shots, 'automation-task-form.png') })
    await form.getByRole('button', { name: '保存' }).click()

    // Back on the list, the new task is selected; its Session carries the name and the assistant.
    await form.waitFor({ state: 'detached' })
    const detail = page.getByRole('complementary', { name: '任务详情' })
    await expect.poll(() => detail.getByRole('textbox', { name: '自动化任务名称' }).inputValue()).toBe('每日简报')
    const [task] = await ctx.schedule.catalog()
    expect(task).toMatchObject({
      title: '每日简报', prompt: '整理昨天的待办并给出今天的建议', kind: 'weekly', time: '08:30:00.000', weekdays: [1, 2, 3, 4, 5],
      window: { end: '2099-12-31' },
    })
    expect(ctx.workspaceRegistry.get(workspace.id)?.sessionIds).toContain(task!.sessionId)
    const resolved = await ctx.sessionController.resolveAgent(task!.sessionId)
    if ('error' in resolved) throw resolved.error
    expect(ctx.sessionTitle.get(resolved.agent.session)?.title).toBe('每日简报')
    expect(ctx.sessionProjections.stateOf(resolved.agent.session, 'assistant')?.assistantId).toBe(daily.id)
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'automation-task-form')
    throw error
  } finally {
    await browser.close()
    await close()
  }
})
