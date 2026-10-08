// An assistant's knowledge subset preselects knowledge bases, over the real `assistants`,
// `knowledge-base`, `knowledge-selection`, `embedding`, `hub-account`, and `llm-pi-ai` rows. An
// assistant allowed only two of the company's knowledge bases, and one since deleted, is picked in a
// new session: the composer's knowledge button selects the two at once, and switching to the Daily
// Assistant, which follows global, clears them. When the employee unticks one, switching back to the
// Daily Assistant keeps the choice. Starting the session with the assistant offers the model the
// search tool from its first request, and the log records every selection.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-assistants'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-embedding'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-knowledge-base'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { startEmbeddingsEndpoint } from './knowledge-support.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './knowledge.overlay.yml', './knowledge-chat.overlay.yml', './assistant-knowledge.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
const ANSWER = 'PRESELECTED_ANSWER_OK 入职满一年每年有五天带薪年假。'
const NO_TOOL = 'PRESELECTED_NO_TOOL'
const SHOTS = process.env.DSH_E2E_SHOTS

it('selects the knowledge bases an assistant is limited to in a new session, clears them unless changed, and offers the search tool at once', async () => {
  const api = await startEmbeddingsEndpoint({ query: '年假', answer: ANSWER, noTool: NO_TOOL })
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_EMBEDDING_API: api.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-assistant-knowledge-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([
    { id: 'embedding', config: { autoDownload: false } },
    { id: 'assistants', config: { dshHome: harnessHome } },
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
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
    for (const name of ['甲公司制度', '产品资料', '旧资料', '财务资料']) await knowledge.createBase(name, 'acme-gateway/bge-m3')
    const [policy, product, old] = (await knowledge.getState()).bases
    await knowledge.createNote(policy!.id, '年假', '员工入职满一年后，每年享有五天带薪年假。')
    await expect.poll(async () => (await knowledge.getState()).bases.flatMap(base => base.items).every(item => item.status === 'completed'), { timeout: 20_000 })
      .toBe(true)
    await expect.poll(async () => (await scaffold.ctx.assistants.getState()).assistants.length).toBe(1)
    await scaffold.ctx.assistants.createAssistant({
      templateId: null, name: '制度助手', description: '只查公司制度和产品资料', avatar: { kind: 'preset', key: 'sun' },
      user: { name: '', language: '', notes: '', background: '' },
      subsets: { knowledgeBases: [policy!.id, product!.id, old!.id] },
    })
    // A knowledge base deleted after the assistant named it is skipped without an error.
    await knowledge.deleteBase(old!.id)

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'assistant-knowledge')
    const shot = async (name: string) => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) }) }
    const picker = page.getByRole('button', { name: '选择这个会话的智能体' })
    const pick = async (name: RegExp) => {
      await picker.click()
      await page.getByRole('menuitem', { name }).click()
    }
    const knowledgeButton = (label: string) => page.getByRole('button', { name: label, exact: true }).last()
    const panel = page.getByRole('group', { name: '本次会话可检索的知识库' })
    const checked = async (name: string) => panel.getByRole('checkbox', { name }).isChecked()

    // The Daily Assistant follows global, so a new session selects none.
    await expect.poll(() => picker.textContent()).toContain('日常助手')
    await knowledgeButton('知识库').waitFor()
    await shot('01-daily-none')

    // Picking the assistant selects its two remaining knowledge bases.
    await pick(/制度助手/)
    await knowledgeButton('知识库 2').waitFor()
    await knowledgeButton('知识库 2').click()
    await expect.poll(() => checked('甲公司制度')).toBe(true)
    expect(await checked('产品资料')).toBe(true)
    // The list leaves out the knowledge base the assistant does not allow, once it has read what it allows.
    await panel.getByText('这个会话的智能体只允许检索部分知识库。').waitFor()
    expect(await panel.getByRole('checkbox', { name: '财务资料' }).count()).toBe(0)
    await shot('02-assistant-preselected')
    await knowledgeButton('知识库 2').click()
    await panel.waitFor({ state: 'detached' })

    // Switching to the Daily Assistant clears the preselection.
    await pick(/日常助手/)
    await knowledgeButton('知识库').waitFor()
    await shot('03-back-to-daily-cleared')

    // A selection the employee changed stays when switching back to the Daily Assistant.
    await pick(/制度助手/)
    await knowledgeButton('知识库 2').click()
    await panel.getByRole('checkbox', { name: '产品资料' }).click()
    await knowledgeButton('知识库 1').click()
    await panel.waitFor({ state: 'detached' })
    await pick(/日常助手/)
    await expect.poll(() => picker.textContent()).toContain('日常助手')
    await knowledgeButton('知识库 1').waitFor()
    await shot('04-changed-selection-kept')

    // Starting the session with the assistant offers the search tool from its first request.
    await pick(/制度助手/)
    await knowledgeButton('知识库 2').waitFor()
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await writeComposerDraft(page, input, '年假有几天？')
    await page.keyboard.press('Enter')
    await page.getByText(ANSWER).first().waitFor({ timeout: 30_000 })
    expect(api.chats[0]!.tools?.map(tool => tool.function.name)).toContain('knowledge_search')
    expect(String(api.chats.find(request => request.messages.at(-1)?.role === 'tool')!.messages.at(-1)!.content)).toContain('knowledge base "甲公司制度"')
    await shot('05-first-turn-searches')
    // Every preselection, clearing, and change is in the session log.
    const events = await readPersistedEvents(scaffold, scaffold.ctx.agents.list().at(-1)!.session.id)
    const both = { bases: [{ id: policy!.id, name: '甲公司制度' }, { id: product!.id, name: '产品资料' }] }
    expect(events.filter(event => event.type === 'knowledge/selection').map(event => event.data))
      .toEqual([both, { bases: [] }, both, { bases: [both.bases[0]] }, both])
    expect(events.some(event => event.type === 'tool/call')).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-assistant-knowledge')
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
