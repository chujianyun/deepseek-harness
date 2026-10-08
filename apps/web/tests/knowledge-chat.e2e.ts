// Knowledge bases in conversations over the real `knowledge-base`, `knowledge-selection`,
// `embedding`, `hub-account`, `web`, and `llm-pi-ai` rows: signed in to a mock user center, with a
// knowledge base holding a Word file, a web page, and a note, the employee chats with a scripted
// OpenAI-compatible model. Without a selection the model is offered no search tool; after ticking
// the knowledge base in the composer it searches it, the answer shows its sources, a page opens in
// the browser and a file through the Host, and reloading keeps the selection and the sources.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-embedding'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-knowledge-base'
import { KNOWLEDGE_SEARCH_DESCRIPTION } from '@deepseek-ai/dsh-knowledge-selection'
import type {} from '@deepseek-ai/dsh-web'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { startEmbeddingsEndpoint } from './knowledge-support.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './knowledge.overlay.yml', './knowledge-sources.overlay.yml', './knowledge-chat.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
const FIXTURES = fileURLToPath(new URL('../../../packages/knowledge/knowledge-base/tests/fixtures/', import.meta.url))
const PAGE_URL = 'https://intra.example.com/hr/leave'
const PAGE = '<html><head><title>年假制度 - 内网</title></head><body><article><h1>员工年假</h1>'
  + '<p>员工入职满一年后，每年享有五天带薪年假，满十年享有十天。年假需提前三个工作日申请。</p></article></body></html>'
const ANSWER = 'KNOWLEDGE_ANSWER_OK 入职满一年每年有五天带薪年假。'
const NO_TOOL = 'KNOWLEDGE_NO_TOOL_OK'

it('searches only the knowledge bases ticked in the composer, shows and opens their sources, and keeps both across a reload', async () => {
  const api = await startEmbeddingsEndpoint({ query: '年假', answer: ANSWER, noTool: NO_TOOL })
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_EMBEDDING_API: api.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-knowledge-chat-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{ id: 'embedding', config: { autoDownload: false } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  scaffold.ctx.web.registerFetchProvider({
    id: 'http', available: () => true,
    fetch: async (request) => {
      if (request.url !== PAGE_URL) throw new Error(`could not reach ${request.url}`)
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
    await scaffold.ctx.credentials.set(credentialRef('DSH_E2E_ACME_KEY'), 'sk-acme-e2e')
    await scaffold.ctx.embedding.addApiModel('acme-gateway', 'bge-m3')
    const knowledge = scaffold.ctx.knowledgeBases
    await knowledge.createBase('甲公司制度', 'acme-gateway/bge-m3')
    await knowledge.createBase('产品资料', 'acme-gateway/bge-m3')
    const [policy, product] = (await knowledge.getState()).bases
    await knowledge.addFiles(policy!.id, [join(FIXTURES, 'annual-leave.docx')])
    await knowledge.addUrl(policy!.id, PAGE_URL)
    await knowledge.createNote(policy!.id, '报销提醒', '差旅发票在出差结束后十五天内提交报销。')
    await knowledge.createNote(product!.id, '产品手册', '年假期间产品值班表见附件。')
    await expect.poll(async () => (await knowledge.getState()).bases.flatMap(base => base.items).every(item => item.status === 'completed'), { timeout: 20_000 })
      .toBe(true)
    // Opening a file copy would start this machine's default application; the Host call is observed instead.
    const openItem = vi.spyOn(knowledge, 'openItem').mockResolvedValue(undefined)

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
      const opened: string[] = []
      Object.defineProperty(globalThis, '__opened', { value: opened })
      globalThis.open = (url?: string | URL) => { opened.push(String(url)); return null }
    })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'knowledge-chat')
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const send = async (text: string) => {
      await writeComposerDraft(page, input, text)
      await page.keyboard.press('Enter')
    }
    const offered = () => api.chats.at(-1)?.tools?.map(tool => tool.function.name) ?? []

    // A new session selects none: the model is offered no search tool.
    const button = page.getByRole('button', { name: '知识库', exact: true }).last()
    await button.waitFor()
    await send('你好')
    await page.getByText(NO_TOOL).first().waitFor({ timeout: 30_000 })
    expect(offered()).not.toContain('knowledge_search')

    // Tick one knowledge base: the button counts it, and the model searches it.
    await button.click()
    const panel = page.getByRole('group', { name: '本次会话可检索的知识库' })
    await panel.getByText('勾选后，模型可以检索这些知识库来回答；新会话默认不勾选，智能体限定了知识库时默认勾选这些。').waitFor()
    await panel.getByRole('checkbox', { name: '甲公司制度' }).click()
    const counted = page.getByRole('button', { name: '知识库 1', exact: true })
    await counted.waitFor()
    await counted.click()
    await panel.waitFor({ state: 'detached' })
    await send('年假有几天？')
    await page.getByText(ANSWER).first().waitFor({ timeout: 30_000 })
    const searched = api.chats.find(request => request.messages.at(-1)?.role === 'tool')!
    expect(searched.tools?.find(tool => tool.function.name === 'knowledge_search')?.function.description).toBe(KNOWLEDGE_SEARCH_DESCRIPTION)
    const result = String(searched.messages.at(-1)!.content)
    expect(result).toContain('Found ')
    expect(result).toContain('knowledge base "甲公司制度"')
    expect(result).not.toContain('产品资料')

    // The answer's sources: the page opens in the browser, the file through the Host.
    const sources = page.getByRole('region', { name: '引用来源' }).last()
    await sources.waitFor()
    await sources.getByRole('button', { name: '在浏览器中打开 年假制度 - 内网' }).click()
    expect(await page.evaluate(() => Reflect.get(globalThis, '__opened') as string[])).toEqual([PAGE_URL])
    await sources.getByRole('button', { name: '打开 annual-leave.docx' }).click()
    await expect.poll(() => openItem.mock.calls.at(-1)).toEqual([policy!.id, expect.any(String)])

    // The selection and the search are in the session log.
    const sessionId = scaffold.ctx.agents.list().at(-1)!.session.id
    const events = await readPersistedEvents(scaffold, sessionId)
    expect(events.filter(event => event.type === 'knowledge/selection').map(event => event.data))
      .toEqual([{ bases: [{ id: policy!.id, name: '甲公司制度' }] }])
    const call = events.find(event => event.type === 'tool/call' && (event.data as { name: string }).name === 'knowledge_search')
    expect(call).toBeDefined()

    // A reload keeps the selection and derives the sources from the log again.
    await page.reload()
    await page.getByRole('region', { name: '引用来源' }).last().waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: '知识库 1', exact: true }).waitFor()

    // Clearing the selection takes the tool away from the next request.
    await page.getByRole('button', { name: '知识库 1', exact: true }).click()
    await page.getByRole('checkbox', { name: '甲公司制度' }).click()
    const cleared = page.getByRole('button', { name: '知识库', exact: true }).last()
    await cleared.waitFor()
    await cleared.click()
    await page.getByRole('group', { name: '本次会话可检索的知识库' }).waitFor({ state: 'detached' })
    await send('还有别的吗？')
    await expect.poll(() => page.getByText(NO_TOOL).count(), { timeout: 30_000 }).toBe(2)
    expect(offered()).not.toContain('knowledge_search')
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-knowledge-chat')
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
