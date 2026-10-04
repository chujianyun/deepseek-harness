// The assembled Hub sign-in gate over the real `hubAccount` Remote and a mock user center:
// first launch is gated, browser sign-in lets the user in, a refused refresh returns to the
// gate while a running turn keeps streaming and new prompts are refused, signing in again
// restores the app, and Settings switches tenant and signs out.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-hub-account'
import { startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot, writeComposerDraft } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./hub-gate.overlay.yml', import.meta.url))
const FIRST = 'HUB_GATE_STREAM_FIRST'
const DONE = 'HUB_GATE_STREAM_DONE'
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

/** Click the gate's sign-in button and finish the sign-in in the popup the gate opens. */
async function signInThroughBrowser(page: Page, button: string): Promise<string> {
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: button, exact: true }).click()
  const opened = await popup
  await opened.waitForLoadState()
  await expect.poll(() => opened.textContent('body')).toContain('登录成功')
  const url = opened.url()
  await opened.close()
  return url
}

it('gates Desktop on Hub sign-in, returns to the gate on a refused refresh without stopping a running turn, and switches tenant', async () => {
  const center = await startMockUserCenter()
  const replayDir = await mkdtemp(join(tmpdir(), 'dsh-hub-gate-replay-'))
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
    // The Desktop renderer's marker; the gate mounts only there.
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)

    // First launch: everything is behind the gate.
    const gate = page.getByRole('dialog', { name: 'Sign in to Skill Hub' })
    await gate.waitFor({ timeout: 15_000 })
    const authorize = await signInThroughBrowser(page, 'Sign in with the user center')
    expect(new URL(authorize).pathname).toBe('/callback')
    expect(Object.fromEntries(center.authorizeRequests[0]!)).toMatchObject({ client_id: 'dsh-desktop', code_challenge_method: 'S256', scope: 'profile skills:read skills:write' })
    await gate.waitFor({ state: 'detached', timeout: 10_000 })
    expect((await scaffold.ctx.hubAccount.getState()).profile).toMatchObject({ nickname: '李雷', tenantName: '甲公司' })

    // A turn starts streaming.
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'hub-gate')
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await writeComposerDraft(page, input, 'Stream a long answer')
    await page.keyboard.press('Enter')
    await page.getByText(FIRST).first().waitFor({ timeout: 15_000 })

    // The user center refuses the next refresh: back to the gate, the turn keeps going.
    center.refreshStatus = 400
    await gate.waitFor({ timeout: 10_000 })
    expect(await gate.getByRole('alert').first().textContent()).toContain('Your sign-in has ended')
    const sessionId = (await scaffold.ctx.sessions.list())[0]?.id
    expect(sessionId).toBeDefined()
    const assistantDone = () => events.some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes(DONE)))
    expect(assistantDone()).toBe(false)
    await expect.poll(assistantDone, { timeout: 20_000 }).toBe(true)
    // New prompts are refused by the Host while signed out.
    expect(scaffold.ctx.bail('api-session/prompt-admission', sessionId!)).toMatchObject({ code: 'hub-account/signed-out' })

    // Signing in again restores the app with the finished answer.
    center.refreshStatus = undefined
    await signInThroughBrowser(page, 'Sign in with the user center')
    await gate.waitFor({ state: 'detached', timeout: 10_000 })
    await page.getByText(DONE).first().waitFor({ timeout: 10_000 })
    expect(scaffold.ctx.bail('api-session/prompt-admission', sessionId!)).toBeUndefined()

    // Settings: the account section, tenant switch, and sign-out.
    center.tenant = { tenantId: 't-b', tenantName: '乙公司' }
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Skill Hub account' }).click()
    const section = settings.getByRole('region', { name: 'Skill Hub account' })
    await expect.poll(() => section.textContent()).toContain('Tenant：甲公司')
    const popup = page.waitForEvent('popup')
    await section.getByRole('button', { name: 'Switch tenant' }).click()
    const opened = await popup
    await expect.poll(() => opened.textContent('body')).toContain('登录成功')
    await opened.close()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).profile?.tenantName).toBe('乙公司')
    expect(center.revoked.length).toBeGreaterThan(0)
    await expect.poll(() => section.textContent()).toContain('Tenant：乙公司')
    await section.getByRole('button', { name: 'Sign out' }).click()
    await gate.waitFor({ timeout: 10_000 })
    expect((await scaffold.ctx.hubAccount.getState()).status).toBe('signed-out')

    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-hub-gate')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    await rm(replayDir, { recursive: true, force: true })
  }
})
