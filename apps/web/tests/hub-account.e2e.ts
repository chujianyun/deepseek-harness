// The assembled Skill Hub account section over the real `hubAccount` Remote and a mock user
// center: signed out, it says so and new prompts are refused; browser sign-in from Settings lets
// the user in; a refused refresh signs out while a running turn keeps streaming; signing in
// again restores prompts; Settings switches tenant, signs out, and signs in again. The Desktop
// welcome window that keeps the workspace closed while signed out is covered by the Desktop specs.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-hub-account'
import { startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot, writeComposerDraft } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./hub-account.overlay.yml', import.meta.url))
const FIRST = 'HUB_ACCOUNT_STREAM_FIRST'
const DONE = 'HUB_ACCOUNT_STREAM_DONE'
const DELTAS = [`${FIRST} `, ...Array.from({ length: 40 }, (_, index) => `chunk-${String(index).padStart(2, '0')} `), `${DONE}.`]

function replay(): ReplayOverrideDoc {
  const text = DELTAS.join('')
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...DELTAS.map(delta => ({ type: 'text-delta' as const, index: 0, text: delta })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 64 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return [{ kind: 'chunks', chunks }]
}

/** Click a sign-in button and finish the sign-in in the popup it opens. */
async function signInThroughBrowser(page: Page, button: Locator): Promise<string> {
  const popup = page.waitForEvent('popup')
  await button.click()
  const opened = await popup
  await opened.waitForLoadState()
  await expect.poll(() => opened.textContent('body')).toContain('登录成功')
  const url = opened.url()
  await opened.close()
  return url
}

it('signs in from Settings, survives a refused refresh without stopping a running turn, switches tenant, and signs in again after signing out', async () => {
  const center = await startMockUserCenter()
  const replayDir = await mkdtemp(join(tmpdir(), 'dsh-hub-account-replay-'))
  const override = join(replayDir, 'replay.override.json')
  await writeFile(override, JSON.stringify(replay()))
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  // Short-lived access tokens: the Host refreshes about every second.
  center.expiresIn = 3
  const scaffold = await launchWebScaffold({
    extraOverlayPath: OVERLAY, replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride: override, paceMs: 150,
  })
  const events: SessionEvent[] = []
  scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    const page = await newEnglishPage(browser)
    failurePage = page
    // The Desktop renderer's marker; the account section mounts only there.
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'hub-account')
    const sessionOf = () => scaffold.ctx.sessions.list()[0]?.id

    // First launch: no in-app gate; the Settings section says it is signed out (instead of a blank page).
    expect(await page.getByRole('dialog', { name: 'Sign in to Skill Hub' }).count()).toBe(0)
    const openAccount = async () => {
      await openSettings(page, 'en')
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Skill Hub account' }).click()
      return { settings, section: settings.getByRole('region', { name: 'Skill Hub account' }) }
    }
    let { settings, section } = await openAccount()
    await section.getByText('Not signed in to Skill Hub').waitFor({ timeout: 15_000 })
    const authorize = await signInThroughBrowser(page, section.getByRole('button', { name: 'Sign in to Skill Hub', exact: true }))
    expect(new URL(authorize).pathname).toBe('/callback')
    expect(Object.fromEntries(center.authorizeRequests[0]!)).toMatchObject({ client_id: 'dsh-desktop', code_challenge_method: 'S256', scope: 'profile skills:read skills:write' })
    await expect.poll(() => section.textContent()).toContain('Tenant：甲公司')
    expect((await scaffold.ctx.hubAccount.getState()).profile).toMatchObject({ nickname: '李雷', tenantName: '甲公司' })
    await settings.getByRole('button', { name: 'Close' }).last().click()

    // A turn starts streaming.
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await writeComposerDraft(page, input, 'Stream a long answer')
    await page.keyboard.press('Enter')
    await page.getByText(FIRST).first().waitFor({ timeout: 15_000 })

    // The user center refuses the next refresh: signed out, the turn keeps going.
    center.refreshStatus = 400
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).reason, { timeout: 10_000 }).toBe('expired')
    const sessionId = sessionOf()
    expect(sessionId).toBeDefined()
    const assistantDone = () => events.some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes(DONE)))
    expect(assistantDone()).toBe(false)
    await expect.poll(assistantDone, { timeout: 20_000 }).toBe(true)
    // New prompts are refused by the Host while signed out.
    expect(scaffold.ctx.bail('api-session/prompt-admission', sessionId!)).toMatchObject({ code: 'hub-account/signed-out' })

    // Settings explains the ended sign-in; signing in again restores prompts.
    ;({ settings, section } = await openAccount())
    await expect.poll(() => section.getByRole('alert').first().textContent()).toContain('Your sign-in has ended')
    center.refreshStatus = undefined
    await signInThroughBrowser(page, section.getByRole('button', { name: 'Sign in to Skill Hub', exact: true }))
    await expect.poll(() => section.textContent()).toContain('Tenant：甲公司')
    expect(scaffold.ctx.bail('api-session/prompt-admission', sessionId!)).toBeUndefined()

    // Tenant switch, then sign-out leaves a signed-out section with a way back in.
    center.tenant = { tenantId: 't-b', tenantName: '乙公司' }
    await signInThroughBrowser(page, section.getByRole('button', { name: 'Switch tenant' }))
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).profile?.tenantName).toBe('乙公司')
    expect(center.revoked.length).toBeGreaterThan(0)
    await expect.poll(() => section.textContent()).toContain('Tenant：乙公司')
    await section.getByRole('button', { name: 'Sign out' }).click()
    await section.getByText('Not signed in to Skill Hub').waitFor({ timeout: 10_000 })
    expect((await scaffold.ctx.hubAccount.getState()).status).toBe('signed-out')
    await signInThroughBrowser(page, section.getByRole('button', { name: 'Sign in to Skill Hub', exact: true }))
    await expect.poll(() => section.textContent()).toContain('Tenant：乙公司')

    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-hub-account')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    await rm(replayDir, { recursive: true, force: true })
  }
})
