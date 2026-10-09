// @vitest-environment jsdom
/** Account sign-in on the Models page: the sign-in block, the provider card around it, and the row it marks. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  AuthorizationAttemptId, AuthorizationAttemptView, AuthorizationFlowView, AuthorizationPromptId,
  LlmProviderSignIn, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { AccountSignIn } from '../src/client/AccountSignIn.tsx'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { createModelsOperations } from '../src/client/operations.ts'
import { createSignInSource, type SignInActions } from '../src/client/sign-in-source.ts'
import { ModelsSettingsStore, providerUsable } from '../src/client/store.ts'
import type { ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]
const KEY = 'llm-pi-ai/openai-codex'
const CODEX: LlmProviderSignIn = { key: KEY, method: 'oauth', acceptsApiKey: false }
const ANTHROPIC: LlmProviderSignIn = { key: 'llm-pi-ai/anthropic', method: 'oauth', acceptsApiKey: true }

function attempt(overrides: Partial<AuthorizationAttemptView> = {}): AuthorizationAttemptView {
  return { id: 'a1' as AuthorizationAttemptId, method: 'oauth', phase: 'running', notices: [], prompts: [], ...overrides }
}

function flow(overrides: Partial<AuthorizationFlowView> = {}): AuthorizationFlowView {
  return { key: KEY, label: 'OpenAI (ChatGPT Plus/Pro)', methods: [{ id: 'oauth', label: 'Sign in' }], signedIn: false, attempt: null, ...overrides }
}

function actions() {
  return {
    begin: vi.fn<SignInActions['begin']>(() => Promise.resolve()),
    answer: vi.fn<SignInActions['answer']>(() => Promise.resolve()),
    decline: vi.fn<SignInActions['decline']>(() => Promise.resolve()),
    cancel: vi.fn<SignInActions['cancel']>(() => Promise.resolve()),
    signOut: vi.fn<SignInActions['signOut']>(() => Promise.resolve()),
    open: vi.fn<SignInActions['open']>(),
  }
}

function block(overrides: Partial<Parameters<typeof AccountSignIn>[0]> = {}) {
  const acts = actions()
  render(<AccountSignIn
    declaration={CODEX} flow={flow()} busy={false} failure={undefined} disabled={false} actions={acts} t={t} {...overrides}
  />)
  return acts
}

describe('AccountSignIn', () => {
  it('starts a sign-in with the declared method while signed out, and explains a sign-in-only provider', () => {
    const acts = block()
    expect(screen.getByRole('status').textContent).toBe(en.signedOut)
    expect(screen.getByText(en.signInOnly)).toBeTruthy()
    expect(screen.getByText(en.signInRisk)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.signIn }))
    expect(acts.begin).toHaveBeenCalledWith(KEY, 'oauth')
  })

  it('offers sign-out once signed in, and no sign-in-only hint for a provider that also takes a key', () => {
    const acts = block({ declaration: ANTHROPIC, flow: flow({ key: ANTHROPIC.key, signedIn: true }) })
    expect(screen.getByRole('status').textContent).toBe(en.signedIn)
    expect(screen.queryByText(en.signInOnly)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    expect(acts.signOut).toHaveBeenCalledWith(ANTHROPIC.key)
  })

  it('shows a running attempt\'s latest message, page, code, and questions, and cancels it', () => {
    const acts = block({
      flow: flow({
        attempt: attempt({
          notices: [
            { message: 'Open the page', url: 'https://auth.example/authorize' },
            { message: 'Enter this code on the verification page.', url: 'https://auth.example/device', code: 'ABCD-1234' },
          ],
          prompts: [
            { id: '1' as AuthorizationPromptId, kind: 'select', message: 'Select login method:', options: [
              { id: 'browser', label: 'Browser login' }, { id: 'device', label: 'Device code', description: 'Headless' },
            ] },
          ],
        }),
      }),
    })
    expect(screen.getByText('Enter this code on the verification page.')).toBeTruthy()
    expect(screen.getByText('ABCD-1234').tagName).toBe('CODE')
    const link = screen.getByRole('link', { name: en.signInOpenPage })
    expect(link.getAttribute('href')).toBe('https://auth.example/device')
    fireEvent.click(link)
    expect(acts.open).toHaveBeenCalledWith('https://auth.example/device')
    const methods = screen.getByRole('group', { name: 'Select login method:' })
    expect(within(methods).getByRole('button', { name: 'Device code' }).getAttribute('title')).toBe('Headless')
    fireEvent.click(within(methods).getByRole('button', { name: 'Browser login' }))
    expect(acts.answer).toHaveBeenCalledWith(KEY, '1', 'browser')
    fireEvent.click(screen.getByRole('button', { name: en.signInCancel }))
    expect(acts.cancel).toHaveBeenCalledWith(KEY)
    expect(screen.queryByRole('button', { name: en.signIn })).toBeNull()
  })

  it('submits a pasted secret only once something is typed, masked as a password', () => {
    const acts = block({
      flow: flow({ attempt: attempt({ prompts: [{ id: '2' as AuthorizationPromptId, kind: 'secret', message: 'Paste the redirect URL', placeholder: 'http://localhost:1455/auth/callback' }] }) }),
    })
    expect(screen.getByText(en.signInWaiting)).toBeTruthy()
    const field = screen.getByLabelText<HTMLInputElement>('Paste the redirect URL')
    expect(field.type).toBe('password')
    expect(field.placeholder).toBe('http://localhost:1455/auth/callback')
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: en.signInSubmit })
    expect(submit.disabled).toBe(true)
    fireEvent.submit(field.closest('form')!)
    expect(acts.answer).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '  http://localhost:1455/auth/callback?code=c&state=s  ' } })
    fireEvent.click(submit)
    expect(acts.answer).toHaveBeenCalledWith(KEY, '2', 'http://localhost:1455/auth/callback?code=c&state=s')
  })

  it('takes a plain text answer in a text field', () => {
    block({ flow: flow({ attempt: attempt({ prompts: [{ id: '3' as AuthorizationPromptId, kind: 'text', message: 'Code?' }] }) }) })
    expect(screen.getByLabelText<HTMLInputElement>('Code?').type).toBe('text')
  })

  it('reports a failed attempt, a cancelled one, and a refused action', () => {
    block({ flow: flow({ attempt: attempt({ phase: 'failed', error: 'The sign-in failed; the Host log has the details.' }) }) })
    expect(screen.getByRole('alert').textContent).toBe('The sign-in failed; the Host log has the details.')
    cleanup()
    block({ flow: flow({ attempt: attempt({ phase: 'cancelled' }) }) })
    expect(screen.getByText(en.signInCancelled)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.signIn })).toBeTruthy()
    cleanup()
    block({ failure: 'a sign-in for "llm-pi-ai/openai-codex" is already running elsewhere' })
    expect(screen.getByRole('alert').textContent).toContain('already running elsewhere')
  })

  it('locks its controls while busy or disabled, before the Host names the flow', () => {
    block({ flow: undefined, busy: true })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.signIn }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe(en.signedOut)
  })
})

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
    models: Schema.array(Schema.object({ id: Schema.string().required() })),
  })),
})

function piAi(value: JsonValue = { providers: { 'openai-codex': {} } }): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
    value,
    user: value,
    autoGenerate: true, applies: 'live',
    secrets: [],
    revision: 0,
  }
}

const okay = <T,>(value: T) => Promise.resolve({ ok: true as const, value })

describe('ProviderEditor with account sign-in', () => {
  function editor(signIn: LlmProviderSignIn | undefined, extra: { credentialOnly?: boolean } = {}) {
    const face = { credentials: { describe: () => okay({}) }, llm: { discoverModels: () => okay([]) } }
    const ctx = Object.assign(new Context(), { remote: face }) as never
    render(<ProviderEditor
      provider={signIn === ANTHROPIC ? 'anthropic' : 'openai-codex'}
      displayName="ChatGPT"
      namespace={piAi()}
      schema={settingsSchema}
      settingsPath={['providers', 'openai-codex']}
      operations={createModelsOperations(ctx)}
      t={t}
      readOnly={false}
      onClose={() => undefined}
      {...signIn === undefined
        ? {}
        : { signIn: { declaration: signIn, flow: undefined, busy: false, failure: undefined, actions: actions() } }}
      {...extra}
    />)
  }

  it('shows the sign-in block in place of the key field for a sign-in-only provider', () => {
    editor(CODEX)
    expect(screen.getByRole('group', { name: en.accountSignIn })).toBeTruthy()
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  })

  it('shows both for a provider that also takes a key', () => {
    editor(ANTHROPIC)
    expect(screen.getByRole('group', { name: en.accountSignIn })).toBeTruthy()
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
  })

  it('shows only the key field without a sign-in, or on a credential-only form', () => {
    editor(undefined)
    expect(screen.queryByRole('group', { name: en.accountSignIn })).toBeNull()
    cleanup()
    editor(CODEX, { credentialOnly: true })
    expect(screen.queryByRole('group', { name: en.accountSignIn })).toBeNull()
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
  })
})

function row(overrides: Partial<ProviderRow> & { signIn?: LlmProviderSignIn } = {}): ProviderRow {
  const { signIn, ...rest } = overrides
  return {
    entry: {
      provider: 'openai-codex', displayName: 'openai-codex', settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai-codex'], active: true, ...signIn === undefined ? {} : { signIn },
    },
    configured: true, removable: true, apiKeyEnv: undefined, credential: undefined, ...rest,
  }
}

describe('sign-in rows', () => {
  it('counts a sign-in-only route usable only once signed in', () => {
    expect(providerUsable(row({ signIn: CODEX }))).toBe(false)
    expect(providerUsable(row({ signIn: CODEX, signedIn: false }))).toBe(false)
    expect(providerUsable(row({ signIn: CODEX, signedIn: true }))).toBe(true)
    // A route that also takes a key keeps the keyless rule.
    expect(providerUsable(row({ signIn: ANTHROPIC }))).toBe(true)
  })

  function face(flows: () => Promise<{ ok: true; value: AuthorizationFlowView[] } | { ok: false; error: Error }>) {
    return {
      llm: {
        listProviders: () => okay([{ id: 'openai-codex', name: 'openai-codex' }, { id: 'anthropic', name: 'anthropic' }]),
        listConfigurableProviders: () => okay([
          { provider: 'openai-codex', displayName: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'], declared: false, signIn: CODEX },
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false, signIn: ANTHROPIC },
        ]),
        discoverModels: () => okay([]),
      },
      settings: {
        describe: () => okay({ writable: true, hasDocument: true, namespaces: [piAi({ providers: { 'openai-codex': {}, anthropic: {} } })] }),
        mutate: () => okay(piAi()),
      },
      credentials: {
        describe: (refs: string[]) => okay(Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }]))),
      },
      authorization: { list: vi.fn(flows) },
    }
  }

  async function mount(scripted: ReturnType<typeof face>) {
    const ctx = Object.assign(new Context(), { remote: { ...scripted, session: { modelCatalog: () => okay({ groups: [] }) } } }) as never
    const controller = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
    await controller.load()
    const source = createSignInSource({
      begin: key => okay(flow({ key })), answer: () => okay(undefined), decline: () => okay(undefined),
      cancel: () => okay(undefined), signOut: key => okay(flow({ key })), open: vi.fn(),
    })
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      useSignIns={bindSnapshotSelector(source.store)}
      signIn={source.actions}
      operations={createModelsOperations(ctx)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    return { controller, source }
  }

  it('marks a signed-in row configured, and a sign-in-only row missing until signed in', async () => {
    const scripted = face(() => okay([flow({ signedIn: false }), flow({ key: ANTHROPIC.key, signedIn: true })]))
    const { controller } = await mount(scripted)
    expect(controller.store.getSnapshot().rows.map(r => r.signedIn)).toEqual([false, true])
    const items = screen.getAllByRole('listitem')
    expect(within(items[0]!).getByRole('img').getAttribute('aria-label')).toBe(en.signedOut)
    expect(within(items[1]!).getByRole('img').getAttribute('aria-label')).toBe(en.signedIn)
  })

  it('leaves sign-in state unknown when the Host cannot list flows, and opens a card with the sign-in block', async () => {
    const scripted = face(() => Promise.resolve({ ok: false as const, error: new Error('no authorization service') }))
    const { controller, source } = await mount(scripted)
    expect(controller.store.getSnapshot().rows.map(r => r.signedIn)).toEqual([undefined, undefined])
    expect(within(screen.getAllByRole('listitem')[0]!).queryByRole('img')).toBeNull()
    source.publish([flow({ signedIn: true })])
    fireEvent.click(screen.getByRole('button', { name: 'Edit openai-codex' }))
    const signIn = await screen.findByRole('group', { name: en.accountSignIn })
    expect(within(signIn).getByRole('status').textContent).toBe(en.signedIn)
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  })

  it('leaves sign-in state unknown for a route without sign-in and for a flow the Host does not list', async () => {
    const scripted = face(() => okay([]))
    scripted.llm.listConfigurableProviders = () => okay([
      { provider: 'openai-codex', displayName: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'], declared: false, signIn: CODEX },
      { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false } as never,
    ])
    const { controller } = await mount(scripted)
    expect(controller.store.getSnapshot().rows.map(r => r.signedIn)).toEqual([undefined, undefined])
  })

  it('does not ask for sign-in state when no route signs in', async () => {
    const scripted = face(() => okay([]))
    scripted.llm.listConfigurableProviders = () => okay([
      { provider: 'openai-codex', displayName: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'], declared: false } as never,
    ])
    await mount(scripted)
    expect(scripted.authorization.list).not.toHaveBeenCalled()
  })
})
