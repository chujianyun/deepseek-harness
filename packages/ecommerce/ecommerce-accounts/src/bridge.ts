/**
 * The way from a model shell call to the e-commerce accounts: a loopback HTTP endpoint and the
 * `dsh-ecommerce` script that calls it. Each bash call gets its own address with a random token,
 * valid until that call ends, so only commands of a live call reach the accounts.
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

/** The bash call a token was given to. */
export interface Grant {
  readonly callId: string
  /** Tenant signed in when the call started; a call outlives no tenant switch. */
  readonly tenantId: string
}

/** What the endpoint answers: the HTTP status and the text the script prints. */
export interface BridgeReply {
  readonly status: number
  readonly body: string
}

/** What the endpoint does for each command. */
export interface BridgeHandlers {
  readonly accounts: (grant: Grant) => Promise<BridgeReply>
  readonly browser: (grant: Grant, accountId: string) => Promise<BridgeReply>
}

/** The loopback endpoint and the tokens of the live calls. */
export class Bridge {
  private readonly grants = new Map<string, Grant>()
  private readonly tokens = new Map<string, string>()
  private port = 0

  /** @param handlers - what each command does. */
  constructor(private readonly handlers: BridgeHandlers) {}

  /**
   * Listen on a free loopback port.
   * @returns a function that stops listening.
   */
  async start(): Promise<() => Promise<void>> {
    const server = createServer((request, response) => {
      // A request the server parsed always has a path; a failed command still answers, so the script never waits forever.
      void this.handle(request.url as string)
        .catch((error: unknown) => ({ status: 500, body: `DSH: the e-commerce accounts could not answer: ${String(error)}` }))
        .then(({ status, body }) => {
          response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(body)
        })
    })
    await new Promise<void>((resolve) => { server.listen({ host: '127.0.0.1', port: 0 }, resolve) })
    this.port = (server.address() as { port: number }).port
    return async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }

  /**
   * The address a bash call reaches the endpoint at; the same call always gets the same address.
   * @param grant - the call and its tenant.
   * @returns the address with the call's token.
   */
  urlFor(grant: Grant): string {
    let token = this.tokens.get(grant.callId)
    if (token === undefined) {
      token = randomBytes(24).toString('hex')
      this.tokens.set(grant.callId, token)
      this.grants.set(token, grant)
    }
    return `http://127.0.0.1:${String(this.port)}/${token}`
  }

  /**
   * End a call's token.
   * @param callId - the bash call.
   */
  revoke(callId: string): void {
    const token = this.tokens.get(callId)
    if (token === undefined) return
    this.tokens.delete(callId)
    this.grants.delete(token)
  }

  private async handle(path: string): Promise<BridgeReply> {
    const url = new URL(path, 'http://127.0.0.1')
    const [, token = '', command = ''] = url.pathname.split('/')
    const grant = this.grants.get(token)
    if (grant === undefined) return { status: 403, body: 'DSH: this shell call can no longer reach the e-commerce accounts.' }
    if (command === 'accounts') return this.handlers.accounts(grant)
    if (command === 'browser') return this.handlers.browser(grant, url.searchParams.get('id') ?? '')
    return { status: 404, body: `DSH: unknown command "${command}".` }
  }
}

/** The `dsh-ecommerce` command: POSIX shell and curl, so it needs nothing DSH ships. */
export const SCRIPT = `#!/bin/sh
# dsh-ecommerce: the e-commerce accounts DSH keeps signed in, for this DSH shell call.
usage='usage: dsh-ecommerce accounts | dsh-ecommerce browser <account-id>'
if [ -z "$DSH_ECOMMERCE_URL" ]; then
  echo "dsh-ecommerce: e-commerce accounts are only available in a DSH shell call while DSH is signed in to the user center." >&2
  exit 2
fi
case "$1" in
  accounts) set -- "$DSH_ECOMMERCE_URL/accounts" ;;
  browser)
    if [ -z "$2" ]; then echo "$usage" >&2; exit 2; fi
    set -- --get --data-urlencode "id=$2" "$DSH_ECOMMERCE_URL/browser" ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
out=$(curl -sS -w '\\n%{http_code}' "$@") || exit 1
code=$(printf '%s' "$out" | tail -n 1)
body=$(printf '%s' "$out" | sed '$d')
if [ "$code" = 200 ]; then
  printf '%s\\n' "$body"
  exit 0
fi
printf '%s\\n' "$body" >&2
exit 1
`
