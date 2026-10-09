/**
 * Host owner of the `authorization` Remote namespace: the sign-in flows of
 * `ctx.authorization` as a browser configuration page starts, answers, and
 * watches them. The page holds no connection to a running attempt, so each
 * attempt lives here, with its notices and its open questions, until the page
 * reads them.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/authorization.ts
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationEntry, AuthorizationNotice, AuthorizationPrompt, AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  AuthorizationAttemptId, AuthorizationAttemptPhase, AuthorizationFlowView,
  AuthorizationPromptId, AuthorizationPromptView,
} from './types.ts'

/**
 * Notices kept per attempt. A flow reports a handful (the page to open, a code,
 * progress), so this only bounds a flow that keeps reporting.
 */
const MAX_NOTICES = 20

/** A question the flow is waiting on, and how to settle it. */
interface PendingPrompt {
  readonly view: AuthorizationPromptView
  readonly resolve: (answer: string) => void
  readonly reject: (error: Error) => void
}

/** One attempt started through this namespace. */
interface Attempt {
  readonly id: AuthorizationAttemptId
  readonly key: CredentialKey
  readonly method: string
  readonly controller: AbortController
  phase: AuthorizationAttemptPhase
  readonly notices: AuthorizationNotice[]
  readonly prompts: Map<AuthorizationPromptId, PendingPrompt>
  error?: string
  nextPrompt: number
  /** Settles once the seam reports how the attempt ended and this view records it. */
  done: Promise<void>
}

/**
 * What a failed attempt shows. A flow's own error can quote the token
 * server's response, tokens included, so it stays in the Host log.
 */
const FAILED_MESSAGE = 'The sign-in failed; the Host log has the details.'

const beginRequestSchema = z.object({ key: z.string().min(1), method: z.string().min(1).optional() })
const promptRequestSchema = z.object({ attemptId: z.string().min(1), promptId: z.string().min(1) })
const answerRequestSchema = promptRequestSchema.extend({ answer: z.string() })
const attemptRequestSchema = z.object({ attemptId: z.string().min(1) })
const keyRequestSchema = z.object({ key: z.string().min(1) })

/** Parse the wire arguments the generated codecs cannot constrain. */
function parseRequest<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  return parsed.data
}

/**
 * The part of a flow error that is safe for the Host log: everything before
 * the first quoted JSON document, where token responses are embedded.
 */
function loggableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const json = message.search(/[{[]/)
  return json === -1 ? message : `${message.slice(0, json).trimEnd()} …`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/** Copy one prompt into its wire view, keeping only the fields the view declares. */
function promptView(id: AuthorizationPromptId, prompt: AuthorizationPrompt): AuthorizationPromptView {
  if (prompt.kind === 'select') {
    return {
      id, kind: 'select', message: prompt.message,
      options: prompt.options.map(option => ({
        id: option.id, label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      })),
    }
  }
  return {
    id, kind: prompt.kind, message: prompt.message,
    ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
  }
}

/** Copy one notice, keeping only the fields the view declares. */
function noticeView(notice: AuthorizationNotice): AuthorizationNotice {
  return {
    message: notice.message,
    ...notice.url === undefined ? {} : { url: notice.url },
    ...notice.code === undefined ? {} : { code: notice.code },
  }
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace. It
 * starts one attempt per credential at a time; a second `begin` for the same
 * credential returns the running attempt, so two open pages share it. Answers
 * cross in one direction only: no view carries what a `secret` prompt received.
 */
export class AuthorizationController extends TypertRemoteService {
  private readonly attempts = new Map<CredentialKey, Attempt>()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host context where the authorization and credential services may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
    ctx.on('credentials/record-updated', () => { this.changed() })
    // Attempts another surface runs change what `begin` accepts for their key.
    ctx.on('authorization/settled', () => { this.changed() })
    ctx.effect(() => () => {
      this.lifetime.abort()
      for (const attempt of this.attempts.values()) attempt.controller.abort()
      this.changed()
    }, 'authorization-controller: lifetime')
  }

  /**
   * Describe every credential a sign-in can be started for.
   * @returns one view per registered flow, in registration order.
   * @throws RemoteError when no authorization or credential service is mounted.
   */
  @Remote
  async list(): Promise<AuthorizationFlowView[]> {
    return Promise.all(this.services().authorization.list().map(entry => this.flowView(entry)))
  }

  /**
   * Start signing in to one credential, or join the attempt already running for it.
   * @param key - credential record key (`<scope>/<id>`) the flow writes.
   * @param method - flow method to run; the flow's first method when omitted.
   * @returns the flow's view with the attempt.
   * @throws RemoteError `authorization/rejected` when no flow claims the key or it offers no such method.
   */
  @Remote
  async begin(key: string, method?: string): Promise<AuthorizationFlowView> {
    const request = parseRequest('authorization.begin', beginRequestSchema, { key, method })
    const entry = this.entry(request.key)
    const chosen = request.method ?? entry.methods[0]?.id
    if (chosen === undefined || !entry.methods.some(candidate => candidate.id === chosen)) {
      throw new RemoteError('authorization/rejected', `"${request.key}" offers no sign-in method "${String(request.method)}"`, { key: request.key })
    }
    const running = this.attempts.get(entry.key)
    // The seam releases the key before this view records the ending, so an
    // attempt still marked running here is joined only while the seam runs it.
    if (running?.phase === 'running' && entry.inFlight) {
      if (request.method !== undefined && request.method !== running.method) {
        throw new RemoteError('authorization/rejected', `a "${running.method}" sign-in for "${request.key}" is already running`, { key: request.key })
      }
      return this.flowView(entry)
    }
    if (entry.inFlight) {
      throw new RemoteError('authorization/rejected', `a sign-in for "${request.key}" is already running elsewhere`, { key: request.key })
    }
    const attempt: Attempt = {
      id: brandString<AuthorizationAttemptId>(randomUUID()), key: entry.key, method: chosen,
      controller: new AbortController(), phase: 'running', notices: [], prompts: new Map(), nextPrompt: 0,
      done: Promise.resolve(),
    }
    this.attempts.set(entry.key, attempt)
    attempt.done = this.services().authorization.begin({
      key: entry.key,
      method: chosen,
      signal: attempt.controller.signal,
      interaction: {
        notify: (notice) => {
          // A flow left running after its attempt ended reports to nobody.
          if (attempt.phase !== 'running' || attempt.controller.signal.aborted) return
          attempt.notices.push(noticeView(notice))
          if (attempt.notices.length > MAX_NOTICES) attempt.notices.shift()
          this.changed()
        },
        prompt: prompt => this.ask(attempt, prompt),
      },
    }).then((outcome) => {
      this.settle(attempt, outcome.status)
    }, (error: unknown) => {
      this.ctx.logger.warn('authorization: sign-in for "%s" failed: %s', entry.key, loggableMessage(error))
      this.settle(attempt, 'failed', FAILED_MESSAGE)
    })
    this.changed()
    return this.flowView(entry)
  }

  /**
   * Answer one question a running attempt is waiting on.
   * @param attemptId - the attempt asking.
   * @param promptId - the question.
   * @param answer - typed text, a secret, or the chosen option's id.
   * @throws RemoteError `authorization/not-found` when the attempt or question is no longer waiting.
   */
  @Remote
  answer(attemptId: AuthorizationAttemptId, promptId: AuthorizationPromptId, answer: string): void {
    parseRequest('authorization.answer', answerRequestSchema, { attemptId, promptId, answer })
    const { attempt, prompt } = this.pending(attemptId, promptId)
    if (prompt.view.kind === 'select' && !prompt.view.options.some(option => option.id === answer)) {
      throw new RemoteError('gateway/bad-request', 'invalid payload for authorization.answer: not one of the offered options', {})
    }
    attempt.prompts.delete(promptId)
    prompt.resolve(answer)
    this.changed()
  }

  /**
   * Decline one question; the flow treats it as the human saying no.
   * @param attemptId - the attempt asking.
   * @param promptId - the question.
   * @throws RemoteError `authorization/not-found` when the attempt or question is no longer waiting.
   */
  @Remote
  decline(attemptId: AuthorizationAttemptId, promptId: AuthorizationPromptId): void {
    parseRequest('authorization.decline', promptRequestSchema, { attemptId, promptId })
    const { attempt, prompt } = this.pending(attemptId, promptId)
    attempt.prompts.delete(promptId)
    prompt.reject(new AuthorizationDeclinedError())
    this.changed()
  }

  /**
   * Cancel a running attempt. Cancelling one that already finished does nothing.
   * @param attemptId - the attempt to cancel.
   * @throws RemoteError `authorization/not-found` when this namespace never started that attempt.
   */
  @Remote
  cancel(attemptId: AuthorizationAttemptId): void {
    parseRequest('authorization.cancel', attemptRequestSchema, { attemptId })
    this.attempt(attemptId).controller.abort()
  }

  /**
   * Forget the stored credential for one key. A running attempt is cancelled
   * and awaited first: one already committing finishes its write, which the
   * deletion then removes.
   * @param key - credential record key whose flow is registered.
   * @returns the flow's view after sign-out.
   * @throws RemoteError `authorization/rejected` when no flow claims the key.
   */
  @Remote
  async signOut(key: string): Promise<AuthorizationFlowView> {
    const request = parseRequest('authorization.signOut', keyRequestSchema, { key })
    const entry = this.entry(request.key)
    const running = this.attempts.get(entry.key)
    if (running !== undefined) {
      running.controller.abort()
      await running.done
    }
    await this.services().credentials.deleteRecord(entry.key)
    return this.flowView(entry)
  }

  /**
   * Stream every flow's view: the current views, then again after each change.
   * A flow registered while watching appears with the next change.
   * @param signal - stream lifetime.
   * @returns the views, re-read after every change.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<AuthorizationFlowView[]> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!this.lifetime.signal.aborted && !signal.aborted) {
        if (dirty) { dirty = false; yield await this.list(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  /** Hold one question open until the page answers it or the flow withdraws it. */
  private ask(attempt: Attempt, prompt: AuthorizationPrompt): Promise<string> {
    const id = brandString<AuthorizationPromptId>(String(++attempt.nextPrompt))
    return new Promise<string>((resolve, reject) => {
      if (attempt.phase !== 'running' || attempt.controller.signal.aborted) {
        reject(new Error('the sign-in has finished'))
        return
      }
      if (prompt.signal?.aborted === true) {
        reject(new Error('the sign-in withdrew this question'))
        return
      }
      attempt.prompts.set(id, { view: promptView(id, prompt), resolve, reject })
      prompt.signal?.addEventListener('abort', () => {
        if (!attempt.prompts.delete(id)) return
        reject(new Error('the sign-in withdrew this question'))
        this.changed()
      }, { once: true })
      this.changed()
    })
  }

  /** Record how an attempt ended and drop the questions nobody can answer any more. */
  private settle(attempt: Attempt, phase: AuthorizationAttemptPhase, error?: string): void {
    attempt.phase = phase
    if (error !== undefined) attempt.error = error
    for (const prompt of attempt.prompts.values()) prompt.reject(new Error('the sign-in has finished'))
    attempt.prompts.clear()
    this.changed()
  }

  private async flowView(entry: AuthorizationEntry): Promise<AuthorizationFlowView> {
    const info = await this.services().credentials.describeRecord(entry.key)
    const attempt = this.attempts.get(entry.key)
    return {
      key: entry.key,
      label: entry.label,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
      signedIn: info.configured,
      attempt: attempt === undefined ? null : {
        id: attempt.id,
        method: attempt.method,
        phase: attempt.phase,
        notices: [...attempt.notices],
        prompts: [...attempt.prompts.values()].map(prompt => prompt.view),
        ...attempt.error === undefined ? {} : { error: attempt.error },
      },
    }
  }

  /** The registered flow for a wire key, or the refusal a page can show. */
  private entry(key: string): AuthorizationEntry {
    let parsed: CredentialKey
    try {
      parsed = parseCredentialKey(key)
    } catch {
      // The grammar error names no more than this message does.
      throw new RemoteError('authorization/rejected', `"${key}" is not a credential record key`, { key })
    }
    const entry = this.services().authorization.describe(parsed)
    if (entry === undefined) throw new RemoteError('authorization/rejected', `no sign-in is registered for "${key}"`, { key })
    return entry
  }

  private attempt(attemptId: AuthorizationAttemptId): Attempt {
    for (const attempt of this.attempts.values()) if (attempt.id === attemptId) return attempt
    throw new RemoteError('authorization/not-found', 'no such sign-in attempt', { attemptId })
  }

  private pending(attemptId: AuthorizationAttemptId, promptId: AuthorizationPromptId): { attempt: Attempt; prompt: PendingPrompt } {
    const attempt = this.attempt(attemptId)
    const prompt = attempt.prompts.get(promptId)
    if (prompt === undefined) throw new RemoteError('authorization/not-found', 'that question is no longer waiting', { attemptId })
    return { attempt, prompt }
  }

  /**
   * Resolve the optional services or report how to supply them. The
   * authorization service injects the credential store, so either both are
   * mounted or the authorization service is absent.
   */
  private services(): { authorization: AuthorizationService; credentials: CredentialProvider } {
    const authorization = this.ctx.get('authorization')
    const credentials = this.ctx.get('credentials')
    if (authorization === undefined || credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'authorization service is absent: this deployment does not mount @deepseek-ai/dsh-authorization with a credential provider',
        {},
      )
    }
    return { authorization, credentials }
  }
}

export default AuthorizationController
