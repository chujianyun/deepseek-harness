// Folder, web page, and note sources of a knowledge base over the real `knowledge-base`,
// `embedding`, `hub-account`, `web`, and `llm-pi-ai` rows: signed in to a mock user center, the
// employee adds a folder with a subfolder and an unsupported file, syncs it after changing it,
// adds a page served by a stand-in fetch provider and keeps it searchable once it becomes
// unreachable, and writes and edits a note — all found by the recall test.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-embedding'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-knowledge-base'
import type {} from '@deepseek-ai/dsh-web'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { startEmbeddingsEndpoint } from './knowledge-support.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './knowledge.overlay.yml', './knowledge-sources.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
const FIXTURES = fileURLToPath(new URL('../../../packages/knowledge/knowledge-base/tests/fixtures/', import.meta.url))
const PAGE_URL = 'https://intra.example.com/hr/leave'
const PAGE = '<html><head><title>年假制度 - 内网</title></head><body><nav>首页 | 通知</nav><article><h1>员工年假</h1>'
  + '<p>员工入职满一年后，每年享有五天带薪年假，满十年享有十天。年假需提前三个工作日在系统中申请，经直属主管批准后生效。</p></article></body></html>'

it('adds and syncs a folder, keeps an unreachable page, and writes notes, all found by the recall test', async () => {
  const api = await startEmbeddingsEndpoint()
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_EMBEDDING_API: api.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-knowledge-sources-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{ id: 'embedding', config: { autoDownload: false } }]))
  // The folder: two documents in a subfolder, one at the top, and an image.
  const folder = join(harnessHome, '公司制度')
  await mkdir(join(folder, '人事'), { recursive: true })
  await copyFile(join(FIXTURES, 'annual-leave.docx'), join(folder, '人事', 'annual-leave.docx'))
  await copyFile(join(FIXTURES, 'expense-policy.pdf'), join(folder, '人事', 'expense-policy.pdf'))
  await copyFile(join(FIXTURES, 'meeting-notes.txt'), join(folder, 'meeting-notes.txt'))
  await writeFile(join(folder, 'logo.png'), 'png')
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  // The stand-in fetch provider, under the id the `web` row selects: the page, until it is taken down.
  let pageUp = true
  scaffold.ctx.web.registerFetchProvider({
    id: 'http', available: () => true,
    fetch: async (request) => {
      if (!pageUp || request.url !== PAGE_URL) throw new Error(`could not reach ${request.url}`)
      return { url: request.url, statusCode: 200, truncated: false, body: { kind: 'html', content: PAGE } }
    },
  })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
    await scaffold.ctx.embedding.addApiModel('acme-gateway', 'bge-m3')
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript((parent: string) => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
      // The Desktop preload's real-path bridge: picked folders' files sit under the home directory.
      Object.defineProperty(globalThis, '__DSH_HOST_PATHS__', { value: { pathFor: (file: File) => `${parent}/${file.webkitRelativePath || file.name}` } })
    }, dirname(folder))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: '知识库', exact: true }).click()
    // The empty state's primary action opens the same dialog as the list's button.
    await page.getByRole('status').getByRole('button', { name: '新建知识库' }).click()
    const dialog = page.getByRole('dialog', { name: '新建知识库' })
    await dialog.getByRole('textbox').fill('甲公司资料')
    await dialog.getByRole('combobox').selectOption('acme-gateway/bge-m3')
    await dialog.getByRole('button', { name: '创建' }).click()
    const detail = page.getByRole('region', { name: '甲公司资料' })
    await detail.getByText('嵌入模型：bge-m3').waitFor()
    const id = (await scaffold.ctx.knowledgeBases.getState()).bases[0]!.id
    const items = async () => (await scaffold.ctx.knowledgeBases.getState()).bases[0]!.items
    const settled = async () => (await items()).every(item => item.status === 'completed' || item.status === 'failed')
    const top = async (question: string) => (await scaffold.ctx.knowledgeBases.recall(id, question)).hits[0]

    // Folder: supported files become its items; the image is skipped and listed.
    await detail.getByRole('tab', { name: /^文件夹/u }).click()
    await detail.getByLabel('添加文件夹', { exact: true }).setInputFiles(folder)
    const row = detail.getByRole('region', { name: '公司制度' })
    await row.getByText('3 个文件').waitFor({ timeout: 15_000 })
    await expect.poll(settled, { timeout: 20_000 }).toBe(true)
    await row.getByRole('button', { name: '已跳过 1 个文件' }).click()
    await row.getByText('logo.png：不支持的格式').waitFor()
    await row.getByRole('button', { name: '展开' }).click()
    expect(await row.getByRole('table', { name: '公司制度 中的文件' }).getByRole('row').allTextContents()).toHaveLength(4)
    expect((await top('员工每年有几天带薪年假'))?.itemName).toBe('annual-leave.docx')

    // Sync: one file changed, one deleted, one added.
    await writeFile(join(folder, 'meeting-notes.txt'), '会议纪要：周三下午讨论年终晚会的节目安排。')
    await rm(join(folder, '人事', 'expense-policy.pdf'))
    await writeFile(join(folder, '人事', 'overtime.md'), '# 加班制度\n\n加班需提前在系统中提交申请，按小时折算调休。')
    await row.getByRole('cell', { name: '公司制度 的操作' }).getByRole('button', { name: '重新处理' }).click()
    const folderFiles = async () => (await items()).filter(item => item.parentId !== null).map(item => item.source).sort()
    await expect.poll(folderFiles, { timeout: 15_000 })
      .toEqual(['meeting-notes.txt', '人事/annual-leave.docx', '人事/overtime.md'])
    await expect.poll(settled, { timeout: 20_000 }).toBe(true)
    expect((await top('年终晚会节目'))?.itemName).toBe('meeting-notes.txt')
    expect((await top('加班调休'))?.itemName).toBe('overtime.md')

    // Web page: fetched and titled; once unreachable it fails and stays searchable.
    await detail.getByRole('tab', { name: /^网址/u }).click()
    await detail.getByRole('textbox', { name: '输入网址，例如 https://example.com/page' }).fill(PAGE_URL)
    await detail.getByRole('button', { name: '添加网址' }).click()
    await detail.getByText('年假制度 - 内网', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(settled, { timeout: 20_000 }).toBe(true)
    expect((await top('提前三个工作日申请年假'))?.itemName).toBe('年假制度 - 内网')
    pageUp = false
    await detail.getByRole('cell', { name: '年假制度 - 内网 的操作' }).getByRole('button', { name: '重新处理' }).click()
    await detail.getByText('网页无法访问，保留上次抓取的内容').waitFor({ timeout: 15_000 })
    expect((await top('提前三个工作日申请年假'))?.itemName).toBe('年假制度 - 内网')

    // Note: written, then edited; only that note is processed again.
    await detail.getByRole('tab', { name: /^笔记/u }).click()
    await detail.getByRole('button', { name: '新建笔记' }).click()
    const editor = page.getByRole('dialog', { name: '新建笔记' })
    await editor.getByRole('textbox', { name: '标题' }).fill('报销提醒')
    await editor.getByRole('textbox', { name: '正文（Markdown）' }).fill('差旅发票要在出差结束后十五个工作日内提交。')
    await editor.getByText('21 / 1,000,000 字').waitFor()
    await editor.getByRole('button', { name: '保存' }).click()
    await expect.poll(settled, { timeout: 20_000 }).toBe(true)
    expect((await top('差旅发票什么时候提交'))?.itemName).toBe('报销提醒')
    const before = await items()
    await detail.getByRole('cell', { name: '报销提醒 的操作' }).getByRole('button', { name: '编辑' }).click()
    const edit = page.getByRole('dialog', { name: '编辑' })
    await edit.getByRole('textbox', { name: '正文（Markdown）' }).fill('差旅发票要在出差结束后十个工作日内提交，逾期需部门负责人审批。')
    await edit.getByRole('button', { name: '保存' }).click()
    await expect.poll(async () => (await top('逾期发票谁审批'))?.text, { timeout: 15_000 }).toContain('逾期需部门负责人审批')
    const after = await items()
    // Every other item kept its chunks untouched.
    expect(after.filter(item => item.kind !== 'note').map(item => [item.id, item.chunkCount]))
      .toEqual(before.filter(item => item.kind !== 'note').map(item => [item.id, item.chunkCount]))
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-knowledge-sources')
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
