/** The redirect port the callback-port probe watches is the one pi-ai's ChatGPT (Codex) browser login uses. */
import { expect, it } from 'vitest'
import type { AuthEvent } from '@earendil-works/pi-ai'
import { catalogProvider } from '../src/catalog.ts'
import { LOOPBACK_CALLBACK_PORTS } from '../src/login.ts'

it('matches the redirect port of the installed ChatGPT (Codex) browser login', async () => {
  const oauth = catalogProvider('openai-codex')?.auth.oauth
  if (oauth === undefined) throw new Error('pi-ai ships no openai-codex login')
  const stop = new AbortController()
  let page: string | undefined
  const login = oauth.login({
    signal: stop.signal,
    notify: (event: AuthEvent) => {
      if (event.type === 'auth_url') {
        page = event.url
        stop.abort()
      }
    },
    // The method question first, then the paste question, refused once the page is known.
    prompt: prompt => prompt.type === 'select'
      ? Promise.resolve('browser')
      : Promise.reject(new Error('stop here')),
  })
  await login.catch(() => undefined)

  const redirect = new URL(new URL(page ?? '').searchParams.get('redirect_uri') ?? '')
  expect(Number(redirect.port)).toBe(LOOPBACK_CALLBACK_PORTS['openai-codex'])
})
