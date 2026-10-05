// The Knowledge page over the real `knowledge-base`, `embedding`, `hub-account`, and `llm-pi-ai`
// rows: signed in to a mock user center, the employee creates a knowledge base on an API
// embedding model served by a mock OpenAI-compatible endpoint, adds Word, PDF, Markdown, and text
// files from the sidebar page, watches them get processed, finds them by search, renames the
// knowledge base, deletes a file, runs recall tests under changed retrieval settings, reprocesses
// every document with smaller chunks, rebuilds on a new embedding model, and sees another tenant's
// sign-in show none of it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-embedding'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-knowledge-base'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { startEmbeddingsEndpoint } from './knowledge-support.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './knowledge.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const FIXTURES = fileURLToPath(new URL('../../../packages/knowledge/knowledge-base/tests/fixtures/', import.meta.url))
const FILES = ['annual-leave.docx', 'expense-policy.pdf', 'product-manual.md', 'meeting-notes.txt']

it('creates a knowledge base, processes the four document kinds, tunes and tests its retrieval, and keeps it to its tenant', async () => {
  const api = await startEmbeddingsEndpoint()
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_EMBEDDING_API: api.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-knowledge-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{ id: 'embedding', config: { autoDownload: false } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  const signIn = async () => {
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
  }
  try {
    await signIn()
    await scaffold.ctx.embedding.addApiModel('acme-gateway', 'bge-m3')
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript((fixtures: string) => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
      // The Desktop preload's real-path bridge, over the fixture directory.
      Object.defineProperty(globalThis, '__DSH_HOST_PATHS__', { value: { pathFor: (file: File) => fixtures + file.name } })
    }, FIXTURES)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: '知识库', exact: true }).click()
    await page.getByText('还没有知识库。').waitFor({ timeout: 15_000 })

    // Create on the API embedding model; the dialog warns that content goes to the provider.
    await page.getByRole('button', { name: '新建知识库' }).click()
    const dialog = page.getByRole('dialog', { name: '新建知识库' })
    await dialog.getByRole('textbox').fill('公司制度')
    await dialog.getByRole('combobox').selectOption('acme-gateway/bge-m3')
    await dialog.getByText('使用 API 嵌入模型时，文档内容会发送到该提供商。').waitFor()
    await dialog.getByRole('button', { name: '创建' }).click()
    const detail = page.getByRole('region', { name: '公司制度' })
    await detail.getByText('嵌入模型：bge-m3').waitFor()

    // Add the four kinds.
    await detail.getByLabel('添加文件', { exact: true }).setInputFiles([...FILES.map(name => join(FIXTURES, name))])
    await expect.poll(async () => (await detail.getByRole('row').allTextContents()).filter(row => row.includes('已完成')).length, { timeout: 20_000 }).toBe(4)
    await page.getByRole('status').getByText('已添加 4 个文件').waitFor()
    const base = (await scaffold.ctx.knowledgeBases.getState()).bases[0]!
    const hits = await scaffold.ctx.knowledgeBases.search(base.id, '差旅费报销需要多久', { limit: 1, threshold: 0 })
    expect(hits[0]?.itemName).toBe('expense-policy.pdf')

    // Rename; delete one file.
    await detail.getByRole('button', { name: '重命名' }).click()
    const rename = page.getByRole('dialog', { name: '重命名知识库' })
    await rename.getByRole('textbox').fill('甲公司制度')
    await rename.getByRole('button', { name: '保存' }).click()
    const renamed = page.getByRole('region', { name: '甲公司制度' })
    await renamed.getByRole('cell', { name: 'meeting-notes.txt 的操作' }).getByRole('button', { name: '删除' }).click()
    await expect.poll(async () => (await renamed.getByRole('row').count())).toBe(4)

    // Recall test under the retrieval settings: every remaining document by default, then only the best one.
    const recall = async (question: string) => {
      await renamed.getByRole('tab', { name: '召回测试' }).click()
      await renamed.getByRole('textbox', { name: '输入要测试的问题' }).fill(question)
      await renamed.getByRole('button', { name: '检索', exact: true }).click()
      return renamed.getByRole('list', { name: '召回结果' }).getByRole('listitem')
    }
    let found = await recall('员工每年有几天年假')
    await expect.poll(() => found.count()).toBe(3)
    expect(await found.first().textContent()).toContain('annual-leave.docx')
    await renamed.getByRole('tab', { name: '设置' }).click()
    await renamed.getByRole('slider', { name: '返回文档数' }).fill('1')
    await renamed.getByRole('button', { name: '保存', exact: true }).click()
    await renamed.getByRole('status').getByText('已保存').waitFor()
    found = await recall('员工每年有几天年假')
    await expect.poll(async () => (await renamed.getByRole('status').allTextContents()).join()).toContain('1 个结果')
    expect(await found.count()).toBe(1)

    // Smaller chunks reach existing documents once they are all processed again.
    await renamed.getByRole('tab', { name: '设置' }).click()
    const settings = renamed.getByRole('tabpanel')
    await settings.getByRole('region', { name: '分块' }).getByRole('textbox').nth(2).fill('0')
    await settings.getByRole('region', { name: '分块' }).getByRole('textbox').nth(1).fill('20')
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByRole('status').getByText('已保存').waitFor()
    await settings.getByRole('button', { name: '重新处理全部文档' }).click()
    await expect.poll(async () => {
      const { items } = (await scaffold.ctx.knowledgeBases.getState()).bases[0]!
      return items.every(item => item.status === 'completed') && items.some(item => item.chunkCount > 1)
    }, { timeout: 20_000 }).toBe(true)

    // A new embedding model, after confirming, rebuilds the knowledge base in place.
    await scaffold.ctx.embedding.addApiModel('acme-gateway', 'bge-small')
    await settings.getByRole('combobox', { name: '嵌入模型' }).selectOption('acme-gateway/bge-small')
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('dialog', { name: '更换嵌入模型' }).getByRole('button', { name: '更换并重建' }).click()
    await expect.poll(async () => {
      const rebuilt = (await scaffold.ctx.knowledgeBases.getState()).bases[0]!
      return `${rebuilt.embeddingModelId} ${rebuilt.status}`
    }, { timeout: 20_000 }).toBe('acme-gateway/bge-small ready')
    await renamed.getByText('嵌入模型：bge-small').waitFor()
    found = await recall('差旅费报销需要多久')
    // The previous hits stay on screen until the new search ends.
    await expect.poll(() => found.first().textContent()).toContain('expense-policy.pdf')
    expect(await found.count()).toBe(1)

    // Another tenant sees none of it; the first tenant's knowledge base is back after signing in again.
    center.tenant = { tenantId: 't-b', tenantName: '乙公司' }
    await scaffold.ctx.hubAccount.signOut()
    await signIn()
    await page.getByText('还没有知识库。').waitFor({ timeout: 10_000 })
    center.tenant = { tenantId: 't-a', tenantName: '甲公司' }
    await scaffold.ctx.hubAccount.signOut()
    await signIn()
    await page.getByRole('region', { name: '甲公司制度' }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-knowledge')
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
