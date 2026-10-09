/**
 * Authorization flows for the pi-ai providers that ship a login. This is the
 * whole of the translation between the harness's neutral notice/prompt
 * vocabulary and pi-ai's `AuthInteraction`; nothing above it knows which
 * library ran the conversation.
 *
 * @module dsh-llm-pi-ai/login
 */

import { createServer } from 'node:net'
import type { AuthEvent, AuthPrompt, AuthType, Provider } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationMethod, AuthorizationPrompt, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { LlmProviderSignIn } from '@deepseek-ai/dsh-llm'
import { isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import { recordKeyFor } from './auth.ts'
import type { PiAiAuthInjection } from './adapter.ts'
import { createModels } from './models.ts'

/**
 * The login methods one catalog provider offers.
 *
 * A method appears only when pi-ai can actually run it: `oauth` always carries
 * a `login`, while an api-key method has one only when the provider collects
 * its key interactively — which every installed one currently does, so a key is
 * typed into pi-ai's own prompt rather than into the settings form.
 * @param provider - the installed catalog provider, if pi-ai ships one.
 * @returns its methods, most preferred first; empty when it offers no login.
 */
function loginMethods(provider: Provider | undefined): AuthorizationMethod[] {
  const methods: AuthorizationMethod[] = []
  const oauth = provider?.auth.oauth
  if (oauth !== undefined) methods.push({ id: 'oauth', label: oauth.loginLabel ?? oauth.name })
  const apiKey = provider?.auth.apiKey
  if (apiKey?.login !== undefined) methods.push({ id: 'api-key', label: apiKey.name })
  return methods
}

/**
 * How a configuration surface signs into one catalog route's account: the
 * record its flow writes, the flow method to start, and whether the route also
 * takes an API key. Only an OAuth login counts — the interactive key prompt
 * every installed provider also ships asks for what the settings form's key
 * field already collects. A route {@link registerPiAiFlows} skips declares
 * nothing; every other declared sign-in has a flow behind it once the
 * composition mounts the authorization service, as every shipped profile does.
 * @param providerId - a catalog provider id.
 * @returns the declaration, or undefined when the route offers no account sign-in.
 */
export function signInFor(providerId: string): LlmProviderSignIn | undefined {
  const provider = catalogProvider(providerId)
  if (provider?.auth.oauth === undefined || !isCredentialKeySegment(providerId)) return undefined
  return { key: recordKeyFor(providerId), method: 'oauth', acceptsApiKey: provider.auth.apiKey !== undefined }
}

/**
 * The fixed loopback port each pi-ai browser login receives its redirect on,
 * for the logins that carry on without a word when another program holds it.
 * pi-ai's ChatGPT (Codex) login then still opens the sign-in page, but the
 * browser hands the result to whichever program owns the port, and the
 * attempt waits for a pasted address it never asked for in so many words.
 */
export const LOOPBACK_CALLBACK_PORTS: Readonly<Record<string, number>> = { 'openai-codex': 1455 }

/**
 * Whether another program already listens on a loopback port. The probe binds
 * the address pi-ai's logins use by default and releases it before answering.
 * @param port - the port to probe.
 * @returns true when the bind is refused.
 */
function loopbackPortTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(true) })
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => { server.close(() => { resolve(false) }) })
  })
}

/**
 * The notice for a browser login whose redirect port another program holds.
 * @param port - the taken port.
 * @returns the instruction naming both ways to finish.
 */
export function callbackPortTakenNotice(port: number): string {
  return `Port ${port} on this computer is already used by another program, so the browser cannot hand the`
    + ' sign-in back here. Cancel and choose device code login, or sign in on the page and paste the full'
    + " address from the browser's address bar below."
}

/** pi-ai's refusal when a route resolves no credential at all (`Models.applyAuth`). */
const NOT_CONFIGURED = /^Provider is not configured: (.+)$/

/**
 * Reword pi-ai's no-credential refusal for a route that offers account sign-in.
 *
 * pi-ai says only that the provider "is not configured", which tells a person
 * who signed out nothing about what to do. A route with an account sign-in
 * reaches that refusal exactly when no grant is stored (and, for a route that
 * also takes a key, none is set), so the reworded text names the fix.
 * @param text - the failure text pi-ai reported.
 * @returns the reworded failure, or undefined when `text` is another failure
 *   or names a route without account sign-in.
 */
export function signedOutFailure(text: string): string | undefined {
  const providerId = NOT_CONFIGURED.exec(text)?.[1]
  const signIn = providerId === undefined ? undefined : signInFor(providerId)
  if (signIn === undefined) return undefined
  return signIn.acceptsApiKey
    ? `The "${providerId}" account is not signed in and no API key is set. Sign in or add a key under Settings → Models, then send the message again.`
    : `The "${providerId}" account is not signed in. Sign in to it under Settings → Models, then send the message again.`
}

/**
 * Whether a sign-in page sends the browser back to a loopback port.
 * @param url - the sign-in page address.
 * @param port - the loopback port.
 * @returns true when its `redirect_uri` names that port on a loopback host.
 */
function redirectsTo(url: string, port: number): boolean {
  const redirect = URL.parse(new URL(url).searchParams.get('redirect_uri') ?? '')
  return redirect !== null && ['localhost', '127.0.0.1'].includes(redirect.hostname) && redirect.port === String(port)
}

/**
 * Restate one pi-ai login event in the seam's vocabulary.
 *
 * A device-code grant is the one event carrying two things the human needs at
 * once — where to go and what to type there — which is why the neutral notice
 * has a `code` beside its `url` rather than folding the code into the message.
 * @param event - what pi-ai reported.
 * @param session - the attempt to report it to.
 * @param takenPort - the login's loopback redirect port, when another program
 *   held it as the attempt began.
 */
function relay(event: AuthEvent, session: AuthorizationSession, takenPort?: number): void {
  switch (event.type) {
    case 'info': {
      const link = event.links?.[0]
      session.notify({ message: event.message, ...link === undefined ? {} : { url: link.url } })
      return
    }
    case 'auth_url':
      session.notify({
        message: takenPort !== undefined && redirectsTo(event.url, takenPort)
          ? callbackPortTakenNotice(takenPort)
          : event.instructions ?? 'Open this page to continue signing in.',
        url: event.url,
      })
      return
    case 'device_code':
      session.notify({
        message: 'Enter this code on the verification page to finish signing in.',
        url: event.verificationUri,
        code: event.userCode,
      })
      return
    case 'progress':
      session.notify({ message: event.message })
      return
    default:
      // pi-ai's event union is open to new members: a build that meets one it
      // does not know still shows the human that something is happening rather
      // than going silent mid-login.
      session.notify({ message: 'Signing in…' })
  }
}

/**
 * Restate one pi-ai prompt in the seam's vocabulary.
 *
 * `manual_code` becomes a plain text question because the difference pi-ai
 * draws — a code the human copies from a browser rather than a value they know
 * — changes nothing a surface renders. Its own `signal` is carried through, and
 * that is the part which matters: it is how a flow racing a typed code against
 * a browser callback withdraws the losing question.
 * @param prompt - what pi-ai asked.
 * @returns the neutral prompt to put to the human.
 */
function restate(prompt: AuthPrompt): AuthorizationPrompt {
  const signal = prompt.signal === undefined ? {} : { signal: prompt.signal }
  switch (prompt.type) {
    case 'select':
      return { ...signal, kind: 'select', message: prompt.message, options: prompt.options }
    case 'secret':
      return {
        ...signal,
        kind: 'secret',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
    default:
      return {
        ...signal,
        kind: 'text',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
  }
}

/**
 * Register one authorization flow per installed provider that ships a login.
 *
 * Registration is unconditional on configuration: a provider has to be signed
 * into before a route for it is worth adding, so the flow exists from the
 * moment the plugin mounts rather than appearing once a profile does.
 * @param ctx - the plugin context carrying `ctx.authorization`.
 * @param auth - the injectables every collection here is built with.
 */
export function registerPiAiFlows(ctx: Context, auth: PiAiAuthInjection): void {
  for (const providerId of catalogProviderIds()) {
    const provider = catalogProvider(providerId)
    const [first, ...rest] = loginMethods(provider)
    /* v8 ignore next 3 -- every id here names an installed provider and every
       installed provider ships a login, so no entry is skipped; the guard
       is what keeps that from becoming a crash if either stops being true. */
    if (provider === undefined || first === undefined) continue
    /* v8 ignore next 7 -- every installed catalog id is a lowercase
       hyphenated identifier; the guard keeps a future upstream id outside the
       record grammar (dotted or uppercase, as vendor ids elsewhere already
       are) from throwing in `recordKeyFor` and failing the whole mount. */
    if (!isCredentialKeySegment(providerId)) {
      ctx.logger.warn(
        'llm-pi-ai: catalog provider "%s" cannot address a credential record; its sign-in is not offered',
        providerId)
      continue
    }
    ctx.authorization.registerFlow({
      key: recordKeyFor(providerId),
      label: provider.name,
      methods: [first, ...rest],
      async run(session) {
        // A collection of its own, holding only the provider being signed
        // into: login is not serving requests, and the credential it produces
        // lands in the shared store either way.
        const models = createModels(auth)
        models.setProvider(provider)
        // Total over the two ids declared above, and the seam only ever hands
        // back one a flow declared.
        const type: AuthType = session.method === 'oauth' ? 'oauth' : 'api_key'
        const callbackPort = type === 'oauth' ? LOOPBACK_CALLBACK_PORTS[providerId] : undefined
        const takenPort = callbackPort !== undefined && await loopbackPortTaken(callbackPort) ? callbackPort : undefined
        // pi-ai persists what the login returns through that same store, which
        // is what makes it the single writer of this record.
        await models.login(providerId, type, {
          signal: session.signal,
          notify: (event) => { relay(event, session, takenPort) },
          prompt: prompt => session.prompt(restate(prompt)),
        })
      },
    })
  }
}
