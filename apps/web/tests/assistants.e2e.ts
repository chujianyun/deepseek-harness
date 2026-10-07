// Assistants over the real `assistants`, `hub-account`, and `llm-pi-ai` rows: the first sign-in to a
// mock user center creates the Daily Assistant as the company default. The employee opens 智能体 from
// the sidebar, finds the cards, and starts a chat with the default; the scripted model's request carries
// the assistant's core files after the deployment persona, and an edit to a core file on disk reaches
// the next request. A new session picks another assistant in the hero picker, and its first request
// carries that assistant's identity instead. A second run manages assistants from their detail page:
// a core file saved there reaches the next request of a session in progress, the default moves, a copy
// keeps the core files, and a deleted assistant's session continues without them. A third run gives
// an assistant only some Skills: its sessions' catalog lists only those, and the detail page marks one
// that is gone.
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-assistants'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-hub-account'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './assistants.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const ANSWER = 'ASSISTANT_ANSWER'
const SHOP_ID = 'shop-keeper'
/** A 3x2 PNG, so the wizard has a non-square image to crop. */
const PNG_3X2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4X6EBQQxwFgBmYgm7t2V+mQAAAABJRU5ErkJggg==', 'base64')

/** One chat completion request the mock received. */
interface ChatRequest {
  readonly model?: string
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
}

/** The system prompt of a request. */
function systemPrompt(request: ChatRequest): string {
  return request.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message.content ?? '')).join('\n')
}

function streamChat(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-assistants', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-assistants', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })}\n\n`
  res.write(chunk({ role: 'assistant', content: ANSWER }, null))
  res.end(`${chunk({}, 'stop')}${usage}data: [DONE]\n\n`)
}

async function startChat() {
  const chats: ChatRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      chats.push(JSON.parse(raw) as ChatRequest)
      streamChat(res)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseURL: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/v1`,
    chats,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
}

/** A second assistant the employee keeps in the company's folder before signing in. */
async function writeShopKeeper(tenantDir: string): Promise<void> {
  const dir = join(tenantDir, SHOP_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'assistant.json'), JSON.stringify({
    version: 1, id: SHOP_ID, name: '店铺测试助手', description: '帮店铺做运营复盘', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2030-01-01T00:00:00.000Z',
  }))
  await writeFile(join(dir, 'IDENTITY.md'), '# 身份\n\n- **名称**：店铺测试助手 SHOP_IDENTITY\n')
}

/** Sign the employee in to a mock user center and open the Desktop web page in Chinese. */
async function launch() {
  const chat = await startChat()
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_CHAT_API: chat.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-assistants-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([
    { id: 'assistants', config: { dshHome: harnessHome } },
    // User Skills come from the test home, and the user's own ~/.agents stays out.
    { id: 'skill-filesystem', config: { dshHome: harnessHome, agentsHome: join(harnessHome, 'agents') } },
  ]))
  const tenantDir = join(harnessHome, 'assistants', 't-a')
  await writeShopKeeper(tenantDir)
  for (const name of ['e2e-alpha', 'e2e-beta']) {
    await mkdir(join(harnessHome, 'skills', name), { recursive: true })
    await writeFile(join(harnessHome, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 测试用 Skill\n---\n\n# ${name}\n`)
  }
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  const close = async () => {
    await browser.close()
    await scaffold.close()
    await center.close()
    await chat.close()
  }
  await scaffold.ctx.hubAccount.signIn()
  await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
  await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
  await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
  await scaffold.ctx.credentials.set(credentialRef('DSH_E2E_ACME_KEY'), 'sk-acme-e2e')
  await expect.poll(async () => (await scaffold.ctx.assistants.getState()).assistants.length).toBe(2)
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
  await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'assistants')
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  const send = async (text: string) => {
    await writeComposerDraft(page, input, text)
    await page.keyboard.press('Enter')
  }
  const useChatModel = async () => {
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
  }
  return { chat, scaffold, tenantDir, page, tripwire, send, useChatModel, close }
}

it('creates the default assistant, carries its core files into the chat, and lets a new session pick another', async () => {
  const { chat, scaffold, tenantDir, page, tripwire, send, useChatModel, close } = await launch()
  try {
    const { defaultId } = await scaffold.ctx.assistants.getState()
    expect(defaultId).not.toBe(SHOP_ID)
    expect(JSON.parse(await readFile(join(tenantDir, 'tenant.json'), 'utf8'))).toEqual({ version: 1, defaultId, seeded: true })

    // The sidebar entry opens the cards: the Daily Assistant is the default, and search narrows the list.
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.getByRole('heading', { name: '智能体' }).waitFor()
    const daily = page.locator(`[data-assistant-id="${defaultId!}"]`)
    await expect.poll(() => daily.textContent()).toContain('默认')
    await expect.poll(() => page.locator(`li[data-assistant-id="${SHOP_ID}"]`).textContent()).toContain('帮店铺做运营复盘')
    await page.getByRole('textbox', { name: '搜索智能体' }).fill('运营')
    await expect.poll(() => page.locator('li[data-assistant-id]').count()).toBe(1)
    await page.getByRole('textbox', { name: '搜索智能体' }).fill('')

    // Chat opens a new session bound to the Daily Assistant; its request carries the core files.
    await daily.getByRole('button', { name: '对话' }).click()
    const picker = page.getByRole('button', { name: '选择这个会话的智能体' })
    await expect.poll(() => picker.textContent()).toContain('日常助手')
    await useChatModel()
    await send('你好，你是谁？')
    await page.getByText(ANSWER).first().waitFor({ timeout: 30_000 })
    const first = systemPrompt(chat.chats.at(-1)!)
    expect(first).toContain('You are the assistant \\"日常助手\\"')
    expect(first).toContain('<core_file name=\\"IDENTITY.md\\">')
    expect(first).not.toContain('SHOP_IDENTITY')
    // The picker is gone once the session started.
    expect(await picker.count()).toBe(0)

    // An edit to a core file on disk reaches the next request of the same session.
    await writeFile(join(tenantDir, defaultId!, 'SOUL.md'), '# 人格\n\n回答结尾加上 SOUL_EDITED。\n')
    await send('再说一次')
    await expect.poll(() => page.getByText(ANSWER).count(), { timeout: 30_000 }).toBe(2)
    expect(systemPrompt(chat.chats.at(-1)!)).toContain('SOUL_EDITED')

    // A new session picks another assistant in the hero picker; its first request carries that identity.
    await page.getByRole('button', { name: '新建会话' }).first().click()
    await expect.poll(() => picker.textContent()).toContain('日常助手')
    await picker.click()
    await page.getByRole('menuitem', { name: /店铺测试助手/ }).click()
    await expect.poll(() => picker.textContent()).toContain('店铺测试助手')
    await send('今天的运营怎么样？')
    await expect.poll(() => chat.chats.filter(request => systemPrompt(request).includes('SHOP_IDENTITY')).length, { timeout: 30_000 }).toBe(1)
    expect(systemPrompt(chat.chats.at(-1)!)).toContain('You are the assistant \\"店铺测试助手\\"')

    // The wizard creates an E-commerce Manager with an uploaded avatar, its own model, and what it should know about the user.
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.getByRole('button', { name: '新建智能体' }).click()
    const wizard = page.getByRole('dialog', { name: '新建智能体' })
    await wizard.getByRole('radio', { name: /电商管家/ }).click()
    await wizard.getByRole('button', { name: '下一步' }).click()
    await wizard.getByRole('textbox', { name: '名称' }).fill('')
    await expect.poll(() => wizard.getByRole('button', { name: '下一步' }).isDisabled()).toBe(true)
    await wizard.getByRole('textbox', { name: '名称' }).fill('名流电商管家')
    await wizard.getByLabel('上传图片').setInputFiles({ name: 'logo.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') })
    await wizard.getByText('只支持 PNG、JPG、WebP 图片').waitFor()
    await wizard.getByLabel('上传图片').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG_3X2 })
    await wizard.locator('img[src^="data:image/webp"]').waitFor()
    await wizard.getByRole('combobox', { name: '模型' }).selectOption(JSON.stringify(['acme-gateway', 'acme-pro']))
    await wizard.getByRole('button', { name: '下一步' }).click()
    await wizard.getByRole('radio', { name: /跟随默认/ }).waitFor()
    await wizard.getByRole('button', { name: '下一步' }).click()
    // The E-commerce Manager starts with only the Feishu connector.
    expect(await wizard.getByRole('group', { name: '连接器' }).getByRole('radio', { name: '仅选中' }).isChecked()).toBe(true)
    await wizard.getByRole('button', { name: '下一步' }).click()
    await wizard.getByRole('textbox', { name: '如何称呼你' }).fill('小明 USER_NAME')
    await wizard.getByRole('textbox', { name: '补充背景' }).fill('负责名流天猫旗舰店')
    await wizard.getByRole('button', { name: '创建' }).click()
    await wizard.waitFor({ state: 'detached' })
    const created = (await scaffold.ctx.assistants.getState()).assistants.find(item => item.name === '名流电商管家')!
    expect(created).toMatchObject({ templateId: 'ecommerce', model: { provider: 'acme-gateway', model: 'acme-pro' }, subsets: { connectors: ['feishu'] } })
    expect(created.avatar.kind).toBe('image')
    const card = page.locator(`li[data-assistant-id="${created.id}"]`)
    await card.locator('img[src^="data:image/webp"]').waitFor()
    expect(await readFile(join(tenantDir, created.id, 'USER.md'), 'utf8')).toContain('- **称呼**：小明 USER_NAME')

    // Chat with it: the first request runs on the assistant's model and carries its core files and the user information.
    await card.getByRole('button', { name: '对话' }).click()
    await expect.poll(() => picker.textContent()).toContain('名流电商管家')
    await send('帮我看看店铺')
    await expect.poll(() => chat.chats.filter(request => systemPrompt(request).includes('名流电商管家')).length, { timeout: 30_000 }).toBe(1)
    const shop = chat.chats.find(request => systemPrompt(request).includes('名流电商管家'))!
    expect(shop.model).toBe('acme-pro')
    expect(systemPrompt(shop)).toContain('天猫、拼多多、抖店')
    expect(systemPrompt(shop)).toContain('小明 USER_NAME')
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'assistants')
    throw error
  } finally {
    await close()
  }
}, 180_000)

it('edits core files on the detail page, moves the default, copies, and deletes assistants', async () => {
  const { chat, scaffold, tenantDir, page, tripwire, send, useChatModel, close } = await launch()
  const lastPrompt = () => systemPrompt(chat.chats.at(-1)!)
  const answers = () => page.getByText(ANSWER).count()
  const openAssistants = async () => {
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.getByRole('heading', { level: 1, name: '智能体' }).waitFor()
  }
  const card = (id: string) => page.locator(`li[data-assistant-id="${id}"]`)
  const deleteCard = async (id: string, sessions: number) => {
    await card(id).getByRole('button', { name: '删除' }).click()
    const dialog = page.getByRole('dialog', { name: '删除智能体' })
    await expect.poll(() => dialog.textContent()).toContain(`它有 ${String(sessions)} 个会话`)
    await dialog.getByRole('button', { name: '删除' }).click()
    await card(id).waitFor({ state: 'detached' })
  }
  try {
    const dailyId = (await scaffold.ctx.assistants.getState()).defaultId!

    // A card opens the detail page with the core files; Chat there starts a session bound to it.
    await openAssistants()
    await page.getByRole('button', { name: '查看 店铺测试助手 的详情' }).click()
    await page.getByRole('heading', { level: 1, name: '店铺测试助手' }).waitFor()
    await expect.poll(() => page.getByRole('textbox', { name: '身份 IDENTITY.md' }).inputValue()).toContain('SHOP_IDENTITY')
    await page.getByRole('button', { name: '对话' }).click()
    const picker = page.getByRole('button', { name: '选择这个会话的智能体' })
    await expect.poll(() => picker.textContent()).toContain('店铺测试助手')
    await useChatModel()
    await send('第一轮')
    await expect.poll(answers, { timeout: 30_000 }).toBe(1)
    expect(lastPrompt()).toContain('SHOP_IDENTITY')
    const rowKey = await page.locator('[role="treeitem"][aria-selected="true"]').getAttribute('data-row-key')
    const shopSession = page.locator(`[role="treeitem"][data-row-key="${rowKey!}"]`)

    // Renaming and a personality edit saved on the detail page reach the next request of that session.
    await openAssistants()
    await page.getByRole('button', { name: '查看 店铺测试助手 的详情' }).click()
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('店铺复盘助手')
    await page.getByRole('tab', { name: '人格' }).click()
    await page.getByRole('textbox', { name: '人格 SOUL.md' }).fill('# 人格\n\n回答前先说 SOUL_FROM_PAGE。\n')
    await page.getByRole('button', { name: '保存' }).click()
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor()
    await page.getByRole('heading', { level: 1, name: '店铺复盘助手' }).waitFor()
    await page.getByRole('tab', { name: '身份' }).click()
    await expect.poll(() => page.getByRole('textbox', { name: '身份 IDENTITY.md' }).inputValue()).toContain('- **名称**：店铺复盘助手')
    expect(await readFile(join(tenantDir, SHOP_ID, 'SOUL.md'), 'utf8')).toContain('SOUL_FROM_PAGE')
    await shopSession.click()
    await send('第二轮')
    await expect.poll(answers, { timeout: 30_000 }).toBe(2)
    expect(lastPrompt()).toContain('SOUL_FROM_PAGE')
    expect(lastPrompt()).toContain('You are the assistant \\"店铺复盘助手\\"')

    // Make default: the new-session screen then starts with it.
    await openAssistants()
    await card(SHOP_ID).getByRole('button', { name: '设为默认' }).click()
    await expect.poll(() => card(SHOP_ID).textContent()).toContain('默认')
    await expect.poll(async () => (await scaffold.ctx.assistants.getState()).defaultId).toBe(SHOP_ID)
    await page.getByRole('button', { name: '新建会话' }).first().click()
    await expect.poll(() => picker.textContent()).toContain('店铺复盘助手')

    // Duplicate: a copy with the same core files and no sessions.
    await openAssistants()
    await card(SHOP_ID).getByRole('button', { name: '复制' }).click()
    await expect.poll(async () => (await scaffold.ctx.assistants.getState()).assistants.length).toBe(3)
    const copy = (await scaffold.ctx.assistants.getState()).assistants.at(-1)!
    expect(copy.name).toBe('店铺复盘助手 副本')
    await card(copy.id).waitFor()
    expect(await readFile(join(tenantDir, copy.id, 'SOUL.md'), 'utf8')).toBe(await readFile(join(tenantDir, SHOP_ID, 'SOUL.md'), 'utf8'))

    // Delete the default with its one session: the default moves to the first remaining assistant,
    // and the session continues without the deleted assistant's core files.
    await deleteCard(SHOP_ID, 1)
    await expect.poll(() => card(dailyId).textContent()).toContain('默认')
    await shopSession.click()
    await send('第三轮')
    await expect.poll(answers, { timeout: 30_000 }).toBe(3)
    expect(lastPrompt()).not.toContain('SOUL_FROM_PAGE')
    expect(lastPrompt()).not.toContain('<core_file')
    // Providers that keep earlier system prompts still show the old core files; this turn says they no longer apply.
    expect(lastPrompt()).toContain('The core files given earlier in this conversation no longer apply')

    // With every assistant deleted, a new session has no picker and no core files, as before assistants.
    await openAssistants()
    await deleteCard(copy.id, 0)
    await deleteCard(dailyId, 0)
    await page.getByText('还没有智能体。').waitFor()
    await page.getByRole('button', { name: '新建会话' }).first().click()
    await page.locator('[data-composer-card]').waitFor()
    expect(await picker.count()).toBe(0)
    await useChatModel()
    await send('没有智能体了')
    await expect.poll(answers, { timeout: 30_000 }).toBe(1)
    expect(lastPrompt()).not.toContain('You are the assistant')
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'assistants-manage')
    throw error
  } finally {
    await close()
  }
}, 240_000)

it('gives an assistant\'s sessions only the Skills it allows, and marks a Skill that is gone', async () => {
  const { chat, scaffold, tenantDir, page, tripwire, send, useChatModel, close } = await launch()
  const messages = () => JSON.stringify(chat.chats.at(-1)!.messages)
  try {
    // The wizard's capability subsets step: only e2e-alpha among the Skills.
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.getByRole('button', { name: '新建智能体' }).click()
    const wizard = page.getByRole('dialog', { name: '新建智能体' })
    await wizard.getByRole('radio', { name: /空白/ }).click()
    await wizard.getByRole('button', { name: '下一步' }).click()
    await wizard.getByRole('textbox', { name: '名称', exact: true }).fill('只用一个Skill')
    await wizard.getByRole('button', { name: '下一步' }).click()
    await wizard.getByRole('button', { name: '下一步' }).click()
    const skills = wizard.getByRole('group', { name: 'Skill' })
    await skills.getByRole('radio', { name: '仅选中' }).check()
    await skills.getByRole('checkbox', { name: 'e2e-alpha' }).check()
    await wizard.getByRole('button', { name: '下一步' }).click()
    await wizard.getByRole('button', { name: '创建' }).click()
    await wizard.waitFor({ state: 'detached' })
    const limited = (await scaffold.ctx.assistants.getState()).assistants.find(item => item.name === '只用一个Skill')!
    expect(limited.subsets).toEqual({ skills: ['e2e-alpha'] })

    // Its session's Skill catalog lists e2e-alpha only; a session of the default assistant lists both.
    await page.locator(`li[data-assistant-id="${limited.id}"]`).getByRole('button', { name: '对话' }).click()
    const picker = page.getByRole('button', { name: '选择这个会话的智能体' })
    await expect.poll(() => picker.textContent()).toContain('只用一个Skill')
    await useChatModel()
    await send('有哪些 Skill？')
    await expect.poll(() => chat.chats.length, { timeout: 30_000 }).toBeGreaterThan(0)
    await expect.poll(messages).toContain('e2e-alpha')
    expect(messages()).not.toContain('e2e-beta')
    await page.getByRole('button', { name: '新建会话' }).first().click()
    await expect.poll(() => picker.textContent()).toContain('日常助手')
    const before = chat.chats.length
    await send('有哪些 Skill？')
    await expect.poll(() => chat.chats.length, { timeout: 30_000 }).toBeGreaterThan(before)
    expect(messages()).toContain('e2e-alpha')
    expect(messages()).toContain('e2e-beta')

    // A Skill named in the subset that is no longer installed shows as unavailable on the detail page.
    await scaffold.ctx.assistants.updateAssistant(limited.id, { subsets: { skills: ['e2e-alpha', 'e2e-gone'] } })
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.getByRole('button', { name: '查看 只用一个Skill 的详情' }).click()
    const group = page.getByRole('group', { name: 'Skill' })
    await group.getByText('已失效').waitFor()
    expect(await group.getByRole('checkbox', { name: 'e2e-gone' }).isChecked()).toBe(true)
    expect(await group.getByRole('checkbox', { name: 'e2e-alpha' }).isChecked()).toBe(true)
    expect(await group.getByRole('checkbox', { name: 'e2e-beta' }).isChecked()).toBe(false)
    expect(JSON.parse(await readFile(join(tenantDir, limited.id, 'assistant.json'), 'utf8'))).toMatchObject({ subsets: { skills: ['e2e-alpha', 'e2e-gone'] } })
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'assistants-subsets')
    throw error
  } finally {
    await close()
  }
}, 180_000)
