// Knowledge base sync over the real `knowledge-base`, `embedding`, `hub-account`, and `llm-pi-ai`
// rows and the Knowledge page: signed in to a mock user center that holds knowledge bases another
// computer of the employee uploaded, this computer pulls them, leaves those of an API embedding model
// for the user to process, processes one on request so that search finds it, names a model it lacks,
// keeps a folder's scan to the computer that added it, uploads a knowledge base made here, and
// carries deletions both ways.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-embedding'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-knowledge-base'
import { browse, startMockUserCenter, type MockSync, type MockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { startEmbeddingsEndpoint } from './knowledge-support.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SHOTS = process.env.DSH_E2E_SHOT_DIR
const OVERLAYS = ['./hub-account.overlay.yml', './knowledge.overlay.yml', './knowledge-sync.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const SETTINGS = { chunkStrategy: 'structured', chunkSeparator: '\\n\\n', chunkSize: 1024, chunkOverlap: 200, documentCount: 6, threshold: 0 }
const HOME = '家里电脑'
const NOTE = '门店每天九点开门，晚上九点打烊；节假日照常营业。'
const RULES = '退货需要保留原包装，七天内寄回。'

/** What the employee's home computer uploaded: a knowledge base on the API model this computer offers, and one on a model it lacks. */
function uploadedAtHome(center: MockUserCenter): void {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const store: MockSync = center.sync['t-a'] ??= { sessions: {}, blobs: {} }
  store.blobs = { ...store.blobs, [sha(NOTE)]: Buffer.from(NOTE), [sha(RULES)]: Buffer.from(RULES), [sha('旧笔记')]: Buffer.from('旧笔记') }
  let seq = store.seq ?? 0
  const at = (meta: Record<string, unknown>) => ({ meta: { revision: 1, device: HOME, ...meta }, deleted: false, seq: ++seq })
  const item = (baseId: string, kind: string, name: string, more: Record<string, unknown> = {}) => at({
    baseId, kind, name, parentId: null, source: null, mediaType: 'text/markdown', sha256: null, sizeBytes: 0, addedAt: '2026-10-15T01:00:00.000Z', ...more,
  })
  store.knowledge = {
    bases: {
      'kb-store': at({ name: '门店手册', embeddingModelId: 'acme-gateway/bge-m3', settings: SETTINGS, createdAt: '2026-10-15T01:00:00.000Z' }),
      'kb-old': at({ name: '旧电脑资料', embeddingModelId: 'other/model-x', settings: SETTINGS, createdAt: '2026-10-15T01:00:01.000Z' }),
    },
    items: {
      'note-hours': item('kb-store', 'note', '营业时间', { sha256: sha(NOTE), sizeBytes: Buffer.byteLength(NOTE) }),
      'folder-after-sales': item('kb-store', 'folder', '售后', { source: '/Users/home/售后', mediaType: null, sizeBytes: Buffer.byteLength(RULES) }),
      'file-returns': item('kb-store', 'file', '退货规则.md', { parentId: 'folder-after-sales', source: '退货规则.md', sha256: sha(RULES), sizeBytes: Buffer.byteLength(RULES) }),
      'note-old': item('kb-old', 'note', '旧笔记', { sha256: sha('旧笔记'), sizeBytes: Buffer.byteLength('旧笔记') }),
    },
  }
  store.seq = seq
}

it('pulls another computer\'s knowledge bases, processes them on request, uploads its own, and carries deletions both ways', async () => {
  const api = await startEmbeddingsEndpoint()
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_EMBEDDING_API: api.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-knowledge-sync-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{ id: 'embedding', config: { autoDownload: false } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    uploadedAtHome(center)
    await scaffold.ctx.embedding.addApiModel('acme-gateway', 'bge-m3')
    // Adding the model embeds a trial text; anything after it is processing.
    const probed = api.embedded()
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: '知识库', exact: true }).click()
    const list = page.getByRole('navigation', { name: '知识库' })
    await list.getByRole('button', { name: /^门店手册/u }).waitFor({ timeout: 20_000 })

    // Pulled for an API model: nothing is embedded until the user asks.
    const detail = page.getByRole('region', { name: '门店手册' })
    await list.getByRole('button', { name: /^门店手册/u }).click()
    await page.getByRole('tab', { name: /^笔记/u }).click()
    await detail.getByText('从其他电脑同步过来，点「重新处理」开始处理（会调用 API 嵌入模型）').waitFor({ timeout: 15_000 })
    expect(api.embedded()).toBe(probed)
    await detail.getByRole('cell', { name: '营业时间 的操作' }).getByRole('button', { name: '重新处理' }).click()
    await expect.poll(async () => (await scaffold.ctx.knowledgeBases.getState()).bases.find(base => base.id === 'kb-store')!.items
      .find(item => item.id === 'note-hours')!.status, { timeout: 20_000 }).toBe('completed')
    const hits = await scaffold.ctx.knowledgeBases.search('kb-store', '门店几点开门', { limit: 1, threshold: 0 })
    expect(hits[0]?.text).toContain('九点开门')

    // The folder is scanned again only on the computer that added it.
    await page.getByRole('tab', { name: /^文件夹/u }).click()
    const folder = detail.getByRole('region', { name: '售后' })
    await folder.getByText('只能在「家里电脑」上重新扫描').waitFor()
    expect(await folder.getByRole('button', { name: '重新处理' }).count()).toBe(0)
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/e2e-pulled-folder.png` })

    // A model this computer lacks.
    await list.getByRole('button', { name: /^旧电脑资料/u }).click()
    await page.getByRole('region', { name: '旧电脑资料' }).getByText('不可用：请在设置里配置嵌入模型 other/model-x').waitFor()

    // Made here: uploaded with its note.
    await page.getByRole('button', { name: '新建知识库' }).first().click()
    const dialog = page.getByRole('dialog', { name: '新建知识库' })
    await dialog.getByRole('textbox').fill('前台资料')
    await dialog.getByRole('combobox').selectOption('acme-gateway/bge-m3')
    await dialog.getByRole('button', { name: '创建' }).click()
    await page.getByRole('region', { name: '前台资料' }).waitFor()
    const own = (await scaffold.ctx.knowledgeBases.getState()).bases.find(base => base.name === '前台资料')!
    await scaffold.ctx.knowledgeBases.createNote(own.id, '交接', '交班前清点收银台。')
    const held = () => center.sync['t-a']!.knowledge!
    await expect.poll(() => held().bases[own.id]?.meta).toMatchObject({ name: '前台资料', device: '前台电脑', embeddingModelId: 'acme-gateway/bge-m3' })
    await expect.poll(() => Object.values(held().items).find(item => item.meta.baseId === own.id)?.meta, { timeout: 10_000 })
      .toMatchObject({ kind: 'note', name: '交接', device: '前台电脑' })

    // Deleted here: deleted on the user center, so on the other computer too.
    await list.getByRole('button', { name: /^门店手册/u }).click()
    await page.getByRole('tab', { name: /^笔记/u }).click()
    await detail.getByRole('cell', { name: '营业时间 的操作' }).getByRole('button', { name: '删除' }).click()
    await expect.poll(() => held().items['note-hours']?.deleted).toBe(true)
    // Deleted on the other computer: gone here after the next pull.
    const store = center.sync['t-a']!
    store.seq = (store.seq ?? 0) + 1
    held().bases['kb-old'] = { ...held().bases['kb-old']!, deleted: true, seq: store.seq }
    await scaffold.ctx.knowledgeBases.syncNow()
    await expect.poll(() => list.getByRole('button', { name: /^旧电脑资料/u }).count(), { timeout: 10_000 }).toBe(0)

    if (SHOTS !== undefined) {
      // A note waiting for the user, the folder hint, and a missing model, in both languages and themes.
      uploadedAtHome(center)
      await scaffold.ctx.knowledgeBases.syncNow()
      await expect.poll(async () => (await scaffold.ctx.knowledgeBases.getState()).bases.length, { timeout: 10_000 }).toBe(3)
      for (const [lang, locale] of [['zh', ZH_BROWSER_LOCALE], ['en', 'en-US']] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const shot = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale, colorScheme: theme })
          await shot.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
          await shot.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await shot.getByRole('button', { name: lang === 'zh' ? '知识库' : 'Knowledge', exact: true }).click()
          const nav = shot.getByRole('navigation', { name: lang === 'zh' ? '知识库' : 'Knowledge' })
          await nav.getByRole('button', { name: /^旧电脑资料/u }).click()
          await shot.waitForTimeout(500)
          await shot.screenshot({ path: `${SHOTS}/${lang}-${theme}-missing.png` })
          await nav.getByRole('button', { name: /^门店手册/u }).click()
          await shot.getByRole('tab', { name: lang === 'zh' ? /^笔记/u : /^Notes/u }).click()
          await shot.waitForTimeout(500)
          await shot.screenshot({ path: `${SHOTS}/${lang}-${theme}-synced.png` })
          await shot.getByRole('tab', { name: lang === 'zh' ? /^文件夹/u : /^Folders/u }).click()
          await shot.waitForTimeout(500)
          await shot.screenshot({ path: `${SHOTS}/${lang}-${theme}-folder.png` })
          await shot.close()
        }
      }
    }
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-knowledge-sync')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await api.close()
    await center.close()
    await rm(harnessHome, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    Reflect.deleteProperty(process.env, 'DSH_E2E_EMBEDDING_API')
  }
})
