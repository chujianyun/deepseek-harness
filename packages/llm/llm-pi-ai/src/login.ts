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
 * Whether a socket already listens on one address. The probe binds the
 * address and releases it before answering; only `EADDRINUSE` counts, so an
 * address the host lacks (no IPv6 loopback) or may not bind reads as free.
 * @param port - the port to probe.
 * @param host - the address to probe.
 * @returns true when another socket holds the address.
 */
function addressInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => { resolve(error.code === 'EADDRINUSE') })
    server.listen({ port, host, exclusive: true }, () => { server.close(() => { resolve(false) }) })
  })
}

/**
 * Whether a loopback port is in use where a browser's `localhost` redirect can
 * land: the IPv4 address pi-ai binds (`PI_OAUTH_CALLBACK_HOST`, which pi-ai
 * reads from the process environment, else `127.0.0.1`) and IPv6 `::1`, which
 * browsers may try first.
 * @param port - the port to probe.
 * @returns true when either address is held.
 */
async function loopbackPortTaken(port: number): Promise<boolean> {
  const host = process.env['PI_OAUTH_CALLBACK_HOST'] || '127.0.0.1'
  const held = await Promise.all([addressInUse(port, host), addressInUse(port, '::1')])
  return held.includes(true)
}

/**
 * The notice for a browser login whose redirect port is already in use.
 * @param port - the taken port.
 * @returns the instruction naming both ways to finish.
 */
export function callbackPortTakenNotice(port: number): string {
  return `Port ${port} on this computer is already in use (by another program or another sign-in), so the`
    + ' browser cannot hand the sign-in back here. Cancel and choose device code login, or sign in on the page'
    + " and paste the full address from the browser's address bar below."
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
 * @param takenPort - the login's loopback redirect port, when it was in use at
 *   the last probe.
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
        const probe = async (): Promise<number | undefined> =>
          callbackPort !== undefined && await loopbackPortTaken(callbackPort) ? callbackPort : undefined
        let takenPort = await probe()
        // pi-ai persists what the login returns through that same store, which
        // is what makes it the single writer of this record.
        await models.login(providerId, type, {
          signal: session.signal,
          notify: (event) => { relay(event, session, takenPort) },
          prompt: async (prompt) => {
            const answer = await session.prompt(restate(prompt))
            // A login method question precedes pi-ai's bind, and the human may
            // sit on it; probe again so the notice describes the port as the
            // browser path starts.
            if (callbackPort !== undefined && prompt.type === 'select') takenPort = await probe()
            return answer
          },
        })
      },
    })
  }
}
