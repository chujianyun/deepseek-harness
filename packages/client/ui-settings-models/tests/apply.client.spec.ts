/** Models section registration: slot declaration injection, the locale-following label thunk, and HMR recovery. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'
import { ok, RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, refreshIfLoaded } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { DeepSeekOnboardingDialog } from '../src/client/DeepSeekOnboardingDialog.tsx'
import { WelcomeNotice } from '../src/client/WelcomeNotice.tsx'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as hostPlugin from '../src/index.ts'
import { ONBOARDING_CONFIG_GLOBAL } from '../src/onboarding-config.ts'

afterEach(() => { vi.unstubAllGlobals() })

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

async function bench(isLoopback = true, mock = RemoteMock.create().load(remoteDefaultResponses), services: object = {}) {
  onTestFinished(() => { mock.assertNoUnmatched() })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const authorization = {
    list: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
    begin: vi.fn(),
    answer: vi.fn(),
    cancel: vi.fn(),
    signOut: vi.fn(),
    watch: vi.fn(),
  }
  const remote = new TestRemote(ctx, {
    credentials: {
      describe: vi.fn(() => Promise.resolve({ ok: true, value: {} })),
      set: vi.fn(),
      unset: vi.fn(),
    },
    llm: {
      listProviders: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      listConfigurableProviders: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      discoverModels: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      ...services,
    },
    settings: mock.remote.settings,
    session: { initializeDefaultModel: vi.fn(async () => ({ ok: true, value: undefined })) },
    authorization,
  })
  // The fixed Host facts the settings provider reads its persistence from.
  remote.$host = { home: undefined, isLoopback }
  // The sign-in stream: frames the spec pushes, delivered until it fails or ends.
  const frames: unknown[][] = []
  let wake: (() => void) | undefined
  let fail: ((error: Error) => void) | undefined
  type StreamOptions = { open: (signal: AbortSignal) => unknown; ended: () => Error }
  const stream = { options: undefined as StreamOptions | undefined, opened: 0, accepted: vi.fn(), dispose: vi.fn() }
  Object.assign(remote, {
    $stream: (options: StreamOptions) => {
      stream.options = options
      stream.opened += 1
      return {
        dispose: stream.dispose,
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const value = frames.shift()
            if (value !== undefined) { yield { value, accept: stream.accepted }; continue }
            await new Promise<void>((resolve, reject) => { wake = resolve; fail = reject })
          }
        },
      }
    },
  })
  const push = (views: unknown[]): void => { frames.push(views); wake?.() }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, remote, authorization, stream, push,
    breakStream: (error: Error) => { fail?.(error) },
  }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

describe('ui-settings-models apply', () => {
  it('keeps manual credential onboarding available when the native shell owns automatic onboarding', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    try {
      const host = ctx.plugin(hostPlugin, { credentialOnboarding: false })
      await host.await()
      const rows: IndexInjection[] = []
      ctx.emit('webserver/index-inject', rows)
      expect(rows).toEqual([{ kind: 'global', name: ONBOARDING_CONFIG_GLOBAL, value: { credentialOnboarding: false } }])
      for (const row of rows) if (row.kind === 'global') vi.stubGlobal(row.name, row.value)
      const plugin = ctx.plugin({ inject: [...inject], apply })
      await plugin.await()
      expect(slots.entries('settings.onboarding').map(entry => entry.options.id)).toEqual(['welcome-notice', 'deepseek-official'])
      const onboarding = slots.entries('settings.onboarding').find(entry => entry.options.id === 'deepseek-official')!
      expect((onboarding.inject as () => { automatic: boolean })().automatic).toBe(false)
      expect(slots.entries('settings.section').map(entry => entry.options.id)).toEqual(['models'])
      await plugin.dispose()
      expect(slots.entries('settings.onboarding')).toEqual([])
      await host.dispose()
      const after: IndexInjection[] = []
      ctx.emit('webserver/index-inject', after)
      expect(after).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shows first-run credential onboarding automatically in Desktop too, without the preview notice', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
    try {
      const plugin = ctx.plugin({ inject: [...inject], apply })
      await plugin.await()
      expect(slots.entries('settings.onboarding').map(entry => entry.options.id)).toEqual(['deepseek-official'])
      const onboarding = slots.entries('settings.onboarding')[0]!
      expect((onboarding.inject as () => { automatic: boolean })().automatic).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      await ctx.fiber.dispose()
    }
  })

  it('defaults to browser onboarding and rejects malformed bootstrap options', async () => {
    expect(hostPlugin.Config({})).toEqual({ credentialOnboarding: true })
    expect(hostPlugin.Config['~standard'].validate({ credentialOnboarding: 'false' })).toHaveProperty('issues')
    const { ctx } = await bench()
    try {
      vi.stubGlobal(ONBOARDING_CONFIG_GLOBAL, { credentialOnboarding: 'false' })
      expect(() => { apply(ctx) }).toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.authorization', 'remote.credentials', 'remote.llm', 'remote.settings', 'remote.session',
      'configForms', 'settingsSchema',
    ])
  })

  it('follows the Host sign-in stream once the page loads, reopens it when the Host ends it, and refreshes rows on sign-in', async () => {
    const listProviders = vi.fn(() => Promise.resolve({ ok: true, value: [{ id: 'openai-codex', name: 'openai-codex' }] }))
    const b = await bench(true, undefined, {
      listProviders,
      listConfigurableProviders: vi.fn(() => Promise.resolve({ ok: true, value: [{
        provider: 'openai-codex', displayName: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'],
        declared: false, signIn: { key: 'llm-pi-ai/openai-codex', method: 'oauth', acceptsApiKey: false },
      }] })),
    })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = (b.slots.entries('settings.section')[0]!.inject as () => unknown)() as {
      controller: { load: () => Promise<void>; store: { getSnapshot: () => { rows: { signedIn?: boolean }[] } } }
      hooks: { signIns: { getSnapshot: () => { flows: Record<string, unknown> } } }
      signIn: Record<string, (...args: unknown[]) => unknown>
    }
    // Nothing streams for a window that never opens the Models page.
    expect(b.stream.opened).toBe(0)
    await injected.controller.load()
    expect(b.stream.opened).toBe(1)
    const signal = new AbortController().signal
    b.stream.options!.open(signal)
    expect(b.authorization.watch).toHaveBeenCalledWith(signal)
    expect(b.stream.options!.ended().message).toBe('authorization stream ended')

    const loads = listProviders.mock.calls.length
    expect(injected.controller.store.getSnapshot().rows[0]?.signedIn).toBeUndefined()
    const view = { key: 'llm-pi-ai/openai-codex', label: 'ChatGPT', methods: [], signedIn: true, attempt: null }
    b.push([view])
    await vi.waitFor(() => { expect(injected.hooks.signIns.getSnapshot().flows).toEqual({ 'llm-pi-ai/openai-codex': view }) })
    expect(b.stream.accepted).toHaveBeenCalledOnce()
    // A changed sign-in state refreshes the rows; a frame that changes no sign-in state does not.
    await vi.waitFor(() => { expect(injected.controller.store.getSnapshot().rows[0]?.signedIn).toBe(true) })
    expect(listProviders.mock.calls.length).toBe(loads + 1)
    b.push([{ ...view, label: 'ChatGPT (Codex)' }])
    await vi.waitFor(() => { expect(b.stream.accepted).toHaveBeenCalledTimes(2) })
    expect(listProviders.mock.calls.length).toBe(loads + 1)

    // Each card action reaches its own Remote method, addressed through the key's current attempt.
    const running = { ...view, attempt: { id: 'a1', method: 'oauth', phase: 'running', notices: [], prompts: [] } }
    const answered = { ok: true, value: undefined }
    b.authorization.begin.mockResolvedValue({ ok: true, value: running })
    b.authorization.answer.mockResolvedValue(answered)
    b.authorization.cancel.mockResolvedValue(answered)
    b.authorization.signOut.mockResolvedValue({ ok: true, value: view })
    await injected.signIn['begin']!('llm-pi-ai/openai-codex', 'oauth')
    await injected.signIn['answer']!('llm-pi-ai/openai-codex', '1', 'browser')
    await injected.signIn['cancel']!('llm-pi-ai/openai-codex')
    await injected.signIn['signOut']!('llm-pi-ai/openai-codex')
    expect(b.authorization.begin).toHaveBeenCalledWith('llm-pi-ai/openai-codex', 'oauth')
    expect(b.authorization.answer).toHaveBeenCalledWith('a1', '1', 'browser')
    expect(b.authorization.cancel).toHaveBeenCalledWith('a1')
    expect(b.authorization.signOut).toHaveBeenCalledWith('llm-pi-ai/openai-codex')
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    injected.signIn['open']!('https://auth.example/authorize')
    expect(open).toHaveBeenCalledWith('https://auth.example/authorize', '_blank', 'noopener,noreferrer')

    // The Host ending the stream (a restarted namespace) is followed by a new one.
    b.breakStream(new Error('authorization stream ended'))
    await vi.waitFor(() => { expect(b.stream.opened).toBe(2) }, { timeout: 3000 })
    expect(b.stream.dispose).toHaveBeenCalledOnce()
    await b.ctx.fiber.dispose()
    expect(b.stream.dispose).toHaveBeenCalledTimes(2)
  })

  it('registers the models nav entry for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = before.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ModelsSection)
    expect(entry.options).toMatchObject({ id: 'models', order: 10 })
    // The section claims its two extension seats in the same registration.
    expect(before.slots.spec('settings.models.provider-card')).toMatchObject({ kind: 'keyed', scope: 'root' })
    expect(before.slots.spec('settings.models.footer')).toMatchObject({ kind: 'list', scope: 'root' })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(resolveSlotLabel(entry.options.label)).toBe('模型')
    const injected = (entry.inject as unknown as () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected)()
    expect(injected.t('nav')).toBe('模型')
    expect(injected.t('deleteTitle')).toBe('删除 {provider}？')
    expect(typeof injected.controller.load).toBe('function')
    expect(injected.hooks.snapshot).toBe(injected.controller.store)
    expect(typeof injected.operations.writeSettings).toBe('function')
    const onboarding = before.slots.entries('settings.onboarding')
    expect(onboarding).toHaveLength(2)
    expect(onboarding.find(entry => entry.options.id === 'welcome-notice')).toMatchObject({
      component: WelcomeNotice,
      options: { id: 'welcome-notice', order: -100 },
    })
    const deepSeek = onboarding.find(entry => entry.options.id === 'deepseek-official')!
    expect(deepSeek.component).toBe(DeepSeekOnboardingDialog)
    const analytics = (deepSeek.inject!() as object) as import('../src/client/DeepSeekOnboardingDialog.tsx').DeepSeekOnboardingInjected
    analytics.track?.('api_key_save_click', {})
    const track = vi.fn()
    before.ctx.provide('productAnalytics', { track } as never)
    analytics.track?.('api_key_save_click', {})
    expect(track).toHaveBeenCalledWith('api_key_save_click', {})
    expect(deepSeek.options).toMatchObject({ id: 'deepseek-official', order: 0 })
    const deepSeekInjected = (
      deepSeek.inject as unknown as () => import('../src/client/DeepSeekOnboardingDialog.tsx').DeepSeekOnboardingInjected
    )()
    expect(deepSeekInjected.hooks.models).toBe(injected.controller.store)
    expect(typeof deepSeekInjected.operations.storeCredential).toBe('function')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    expect(after.slots.entries('settings.onboarding')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('settings.section')[0]!.component).toBe(ModelsSection)
    expect(after.slots.entries('settings.onboarding')).toHaveLength(2)
    // The self-inflicted ledger notifications hit the duplicate guard.
    expect(after.slots.entries('settings.section')).toHaveLength(1)
  })

  it('the label thunk follows the active locale without re-registration', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Models')
    const injected = b.slots.entries('settings.section')[0]!.inject as unknown as () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected
    expect(injected().t('deleteTitle')).toBe('Delete {provider}?')
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('模型')
    expect(injected().t('deleteTitle')).toBe('删除 {provider}？')
  })

  it('locale change while the slot is undeclared stays a no-op', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    b.locale.setLocale('zh')
  })

  it('re-registers after an HMR collapse re-declares the slot (stale disposer must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
    // Declarer unload: the cascade removes our entry while our local
    // disposer variable goes stale.
    redeclare()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(0)
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('settings.section')[0]!.component).toBe(ModelsSection)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(2)
    // The locale path also recovers through the same ledger re-check.
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Models')
    b.locale.setLocale('zh')
  })

  it('accepts extension entries under the declared seats and cascades them with the declarer', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // A keyed card extension and a footer entry register through the ordinary
    // ledger once the section's registration declared the seats.
    const disposeCard = b.slots.register(
      { name: 'settings.models.provider-card', key: 'llm-pi-ai' } as never,
      () => null,
    )
    b.slots.register({ name: 'settings.models.footer', id: 'extra', order: 0 } as never, () => null)
    expect(b.slots.entries('settings.models.provider-card')).toHaveLength(1)
    expect(b.slots.entries('settings.models.footer')).toHaveLength(1)
    // Extension-side HMR safety: its own disposer removes the entry.
    disposeCard()
    expect(b.slots.entries('settings.models.provider-card')).toHaveLength(0)
    // Declarer unload cascades whatever extension entries remain.
    await fiber.dispose()
    expect(b.slots.entries('settings.models.footer')).toHaveLength(0)
  })

  it('registers the zh/en nav dictionaries and disposes everything with the fiber', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.models')('nav')).toBe('模型')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(0)
    // The (ns, locale) seats are free again — the dictionary disposers ran.
    expect(() => b.locale.register('settings.models', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings.models', 'en', {})).not.toThrow()
  })

  it('keeps remote-browser acknowledgement in process memory', async () => {
    const b = await bench(false)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'welcome-notice')!
    const injected = (
      entry.inject as unknown as () => import('../src/client/WelcomeNotice.tsx').WelcomeNoticeInjected
    )()

    await injected.controller.load()
    expect(injected.controller.store.getSnapshot()).toEqual({
      status: 'ready', acknowledged: false, error: null,
    })
  })
})

describe('pushed invalidations', () => {
  it('ignores invalidations before the page ever loaded', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // The fake wire face has no methods: a fetch attempt would throw.
    b.remote.emit('settings/document-updated', ['llm-pi-ai', 1])
    b.remote.emit('credentials/reference-updated', ['OPENAI_API_KEY'])
    b.remote.emit('llm/adapters-updated', [])
    b.ctx.emit('connection/reset')
  })

  it('refreshes a loaded page and skips an idle one', () => {
    const loads: number[] = []
    const controller = {
      store: { getSnapshot: () => ({ status: 'ready' }) },
      load: () => { loads.push(1); return Promise.resolve() },
    }
    refreshIfLoaded(controller as import('../src/client/store.ts').ModelsSettingsStore)
    expect(loads).toHaveLength(1)
    const idle = {
      store: { getSnapshot: () => ({ status: 'idle' }) },
      load: () => { loads.push(2); return Promise.resolve() },
    }
    refreshIfLoaded(idle as import('../src/client/store.ts').ModelsSettingsStore)
    expect(loads).toHaveLength(1)
  })

  it('routes pushed credential invalidation into the shared onboarding join', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'deepseek-official')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/DeepSeekOnboardingDialog.tsx').DeepSeekOnboardingInjected
    )()
    injected.controller.store.update((state) => { state.status = 'ready' })
    const load = vi.spyOn(injected.controller, 'load').mockResolvedValue()
    b.remote.emit('credentials/reference-updated', ['DEEPSEEK_API_KEY'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('welcome state follows the shared mirror across document commits', async () => {
    // The welcome notice derives from its settings scope: a document commit
    // reaches it through the mirror's one refresh, with no routing here.
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const namespace = {
      ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
      schema: JSON.parse(JSON.stringify(Schema.object({ [WELCOME_NOTICE_ACK_FIELD]: Schema.string() }).toJSON())) as JsonValue,
      value: {},
      autoGenerate: true, applies: 'live' as const,
      secrets: [],
      revision: 0,
    }
    const document = { writable: true, hasDocument: false, namespaces: [namespace] }
    mock.remote.settings.describe.mockResolvedValue(ok(document))
    const b = await bench(true, mock)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'welcome-notice')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/WelcomeNotice.tsx').WelcomeNoticeInjected
    )()
    await injected.controller.load()
    await vi.waitFor(() => {
      expect(injected.hooks.welcome.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: false })
    })
    mock.remote.settings.describe.mockResolvedValue(ok({
      ...document,
      namespaces: [{ ...namespace, value: { [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION }, revision: 1 }],
    }))
    b.remote.emit('settings/document-updated', ['ui-settings-general', 1])
    await vi.waitFor(() => {
      expect(injected.hooks.welcome.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })
    })
  })

  it('joins the refreshed mirror view on a settings invalidation', async () => {
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const namespace = { ns: 'llm-test', schema: {}, value: {}, autoGenerate: true, applies: 'live' as const, secrets: [], revision: 1 }
    const document = { writable: true, hasDocument: false, namespaces: [namespace] }
    const describe = mock.remote.settings.describe
    describe.mockResolvedValue(ok(document))
    const listProviders = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const b = await bench(true, mock, { listProviders })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')
      .find(candidate => candidate.options.id === 'models')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected
    )()
    await injected.controller.load()
    expect(injected.hooks.snapshot.getSnapshot().namespaces.get('llm-test')?.revision).toBe(1)

    describe.mockResolvedValue(ok({ ...document, namespaces: [{ ...namespace, revision: 2 }] }))
    b.remote.emit('settings/document-updated', ['llm-test', 2])

    await vi.waitFor(() => {
      expect(injected.hooks.snapshot.getSnapshot().namespaces.get('llm-test')?.revision).toBe(2)
    })
    expect(describe).toHaveBeenCalledTimes(2)
  })
})
