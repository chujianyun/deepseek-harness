/** Session sharing through the shipped composition against a mock user center: share, refresh, withdraw, and withdrawal on delete. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-session-share'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const OVERLAYS = ['./hub-account.overlay.yml', './session-share.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const SHOTS = process.env.DSH_E2E_SHOT_DIR

/** Boot the enterprise composition signed in to a mock user center. */
async function launch() {
  const center = await startMockUserCenter()
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS })
  const close = async () => {
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
  await scaffold.ctx.hubAccount.signIn()
  await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
  await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
  await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
  return { scaffold, center, close }
}

it('shares a Session from its row menu, copies nothing it should not, refreshes it, and withdraws it', async () => {
  const { scaffold, center, close } = await launch()
  const browser = await chromium.launch()
  try {
    const { ctx } = scaffold
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'session-share-ui')
    await workspace.attachSession(sessionId)
    await ctx.sessionController.rename({ sessionId, title: '双十一复盘' })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-share'))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const row = page.getByRole('treeitem').filter({ has: page.getByText('双十一复盘', { exact: true }) })
    const openMenu = async (): Promise<void> => {
      await row.hover()
      await row.getByRole('button', { name: '会话“双十一复盘”的操作', exact: true }).click()
    }

    await openMenu()
    // Share sits between Fork and Archive.
    const names = await page.getByRole('menuitem').allTextContents()
    expect(names.indexOf('分享会话')).toBeGreaterThan(names.findIndex(name => name.startsWith('分叉')))
    expect(names.indexOf('分享会话')).toBeLessThan(names.findIndex(name => name.startsWith('归档')))
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/e2e-share-menu.png` })
    await page.getByRole('menuitem', { name: '分享会话', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '分享会话' })
    await expect.poll(() => dialog.textContent()).toContain('同公司的成员登录后，可以通过链接查看“双十一复盘”的对话内容')
    await dialog.getByRole('button', { name: '生成链接' }).click()
    const field = dialog.getByRole('textbox', { name: '分享链接' })
    await field.waitFor({ timeout: 15_000 })
    const share = center.shares[sessionId]
    expect(share).toBeDefined()
    expect(await field.inputValue()).toBe(`${center.origin}/share/${share!.shareId}`)
    const body = share!.body as { title: string; assistantName: string | null; messages: { role: string; text: string }[] }
    expect(body.title).toBe('双十一复盘')
    expect(body.assistantName).toBeNull()
    expect(body.messages.length).toBeGreaterThan(1)
    expect(body.messages[0]!.role).toBe('user')
    expect(new Set(body.messages.map(message => message.role))).toEqual(new Set(['user', 'assistant']))
    if (SHOTS !== undefined) { await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/e2e-share-link.png` }) }

    // Updating keeps the link.
    await dialog.getByRole('button', { name: '更新内容' }).click()
    await dialog.getByText('内容已更新，链接不变', { exact: true }).waitFor({ timeout: 15_000 })
    expect(center.shares[sessionId]?.shareId).toBe(share!.shareId)
    await dialog.getByRole('button', { name: '完成' }).click()
    await expect.poll(() => dialog.count()).toBe(0)

    // Reopening shows the existing link; stopping the share withdraws it on the user center.
    await openMenu()
    await page.getByRole('menuitem', { name: '分享会话', exact: true }).click()
    await expect.poll(() => field.inputValue(), { timeout: 15_000 }).toBe(`${center.origin}/share/${share!.shareId}`)
    await dialog.getByRole('button', { name: '取消分享' }).click()
    await dialog.getByText('已取消分享，原链接已失效', { exact: true }).waitFor({ timeout: 15_000 })
    expect(center.shares).toEqual({})
    expect(await dialog.getByRole('button', { name: '生成链接' }).isEnabled()).toBe(true)
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/e2e-share-revoked.png` })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await close()
  }
}, 120_000)

it('withdraws the share of a deleted Session and refuses to share one without a conversation', async () => {
  const { scaffold, center, close } = await launch()
  try {
    const { ctx } = scaffold
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'session-share-delete')
    await workspace.attachSession(sessionId)
    const link = await ctx.sessionShare.share({ sessionId, title: '要删除的会话' })
    expect(await ctx.sessionShare.status({ sessionId })).toEqual({ signedIn: true, link })
    expect(Object.keys(center.shares)).toEqual([sessionId])

    await ctx.sessionController.delete({ sessionId })
    await expect.poll(() => center.shares).toEqual({})

    const blank = await ctx.sessionController.create({ workspaceId: workspace.id })
    await expect(ctx.sessionShare.share({ sessionId: blank.sessionId, title: '空白' })).rejects.toMatchObject({ code: 'session-share/empty' })
  } finally {
    await close()
  }
}, 90_000)
