/**
 * Skill reference plugin, browser half: registers the '/' skill source —
 * candidates from the `skills/list` Remote addressed by the per-call session
 * projection's sessionId (sessions are always agent-backed; the host
 * resolves cwd from the session header). A pick lands the literal `/name `
 * text and the prompt ships the same literal (plain-text-reference decision;
 * see .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md);
 * determinism
 * lives host-side — the pre-step boundary (`dsh-tool-skill`) recognizes a
 * leading `/name` naming a user-invocable skill and injects the rendered
 * body for every entry point, including `disable-model-invocation` skills the
 * model-side catalog never lists (issue #1470). The RPC rides the plugin's
 * root-context Remote captured at registration — the source never reads
 * services off a per-call argument. Draft chip visuals derive from
 * the lexicon scan; this source implements no reference codec.
 *
 * Catalog fetches are cached per session (the small twin of the ui-commands
 * directory): the per-keystroke candidates re-poll filters a settled
 * snapshot locally, so one session costs one RPC. The scope-birth warm hook
 * prewarms the session's key; a preset switch drops that one key (the
 * catalog is the preset's, and a blank session may switch after the warm);
 * connection/reset clears everything — the host
 * catalog may differ across generations. A shared in-flight fetch
 * deliberately outlives any single menu interaction: closing the menu must
 * not kill the prewarm other consumers will hit, so it carries its own
 * abort (fired only on invalidation/teardown) while a candidates caller
 * with an aborted signal just returns early.
 * Catalog RPCs retain an existing Client Session through completion and
 * wait for its initial history open to succeed before contacting the Host.
 *
 * This browser half also owns the `skill` keyed toolview: a replay-stable
 * accent row derived only from each logged call/result slice.
 */
// Type-only: the carrier types, the forwarded Host-event face and the ctx.remote merge.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ReferenceInsert } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { rankByName } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SkillRow } from './SkillRow.tsx'
import { en, NS, zh, type SkillKey } from './locales.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A skill-catalog fetch waiting for initial history and its RPC result. */
    skillCatalog: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The dedicated skill tool row's copy. */
    skill: SkillKey
  }
}

/** One session's catalog fetch: the shared promise plus its own abort handle. */
/**
 * The chip a Skill lands as when it has a display name: shows the name the user knows, carries /name.
 * @param name - the Skill's name.
 * @param label - its display name.
 * @returns the reference to insert.
 */
export function skillChip(name: string, label: string): ReferenceInsert {
  return { source: 'skill', ref: `/${name}`, label, appearance: 'skill', clipboardText: `/${name}` }
}

interface CatalogFetch {
  readonly promise: Promise<readonly SkillEntry[]>
  readonly abort: AbortController
  /** Settled catalog for synchronous lexicon reads (unset while in flight or on failure). */
  settled?: readonly SkillEntry[]
}

/** Required services: reference source faces plus the tool-row and locale registries. */
export const inject = ['inputTriggers', 'sessions', 'slots', 'locale', 'remote', 'remote.skills', 'sidebarRight']

/**
 * Client plugin body: register the '/' source, dictionaries, and keyed tool row.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skill: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'skill', locale: NS },
    SkillRow,
  ))

  const skills = ctx.remote.skills
  const sessions = ctx.sessions
  // Session-keyed catalog cache; single-flight per key. Plugin-closure state:
  // the fiber effect below is its teardown boundary.
  const fetches = new Map<SessionId, CatalogFetch>()
  // Per-session lexicon invalidation listeners (subscribeLexicon consumers).
  const lexiconListeners = new Map<SessionId, Set<() => void>>()

  const notifyLexicon = (sessionId: SessionId): void => {
    for (const listener of [...(lexiconListeners.get(sessionId) ?? [])]) {
      try {
        listener()
      } catch (error) {
        // Contain listener failures: settlement notifies from an ignored
        // promise chain (a throw would surface as an unhandled rejection)
        // and one faulty consumer must not starve the others.
        console.error('[ui-skill] lexicon listener failed:', error)
      }
    }
  }

  // Display names of Skills installed from the Skill Hub (e.g. 「天猫发品」), read from the market's local install records where
  // it is mounted: the menu titles a Skill by it and its pick lands a chip showing it, while the prompt still carries /name.
  // Read alongside each catalog and never awaited by the menu, so a composition without the market, a slow read, or a failed
  // one leaves Skills titled by their names until the read settles.
  let labels: ReadonlyMap<string, string> = new Map()
  let labelsRead = 0
  // Bound while the market namespace is mounted (an optional dependency of this plugin).
  let marketNames: (() => ReturnType<typeof ctx.remote.skillMarket.displayNames>) | undefined
  ctx.inject(['remote.skillMarket'], (scope: ClientContext) => {
    marketNames = () => scope.remote.skillMarket.displayNames()
    scope.effect(() => () => { marketNames = undefined }, 'ui-skill: market display names')
  })
  const readDisplayNames = (): void => {
    const read = ++labelsRead
    const market = marketNames
    if (market === undefined) return
    // A failed read keeps the names last read; the menu still lists every Skill.
    void market().then(
      (result) => {
        if (read === labelsRead && result.ok) labels = new Map(Object.entries(result.value))
      },
      (error: unknown) => {
        console.warn('[ui-skill] display names unavailable:', error)
      },
    )
  }

  const fetchCatalog = (sessionId: SessionId): CatalogFetch => {
    const existing = fetches.get(sessionId)
    if (existing !== undefined) return existing
    readDisplayNames()
    const abort = new AbortController()
    const promise = (async () => {
      if (sessions.binding(sessionId) === undefined) {
        throw new Error(`skill catalog requires a retained session "${sessionId}"`)
      }
      return sessions.using(sessionId, { source: 'skillCatalog', signal: abort.signal }, async (reference) => {
        abort.signal.throwIfAborted()
        const state = reference.binding.session.getSnapshot()
        if (state.openState !== 'open') {
          throw state.openError ?? new Error(`session "${sessionId}" is not open`)
        }
        const result = await skills.list({ sessionId }, abort.signal)
        abort.signal.throwIfAborted()
        if (!result.ok) throw new Error(`skills/list failed: ${result.error.code}: ${result.error.message}`)
        return result.value.skills
      })
    })()
    const entry: CatalogFetch = { promise, abort }
    fetches.set(sessionId, entry)
    promise.then(
      // Settled snapshot backs the synchronous lexicon reads.
      (skills) => {
        entry.settled = skills
        notifyLexicon(sessionId)
      },
      // A failed fetch must not poison the key: the next consumer retries.
      () => {
        if (fetches.get(sessionId) === entry) fetches.delete(sessionId)
      },
    )
    return entry
  }

  const invalidate = (key: SessionId): void => {
    const entry = fetches.get(key)
    if (entry === undefined) return
    fetches.delete(key)
    entry.abort.abort()
    notifyLexicon(key)
  }

  const clearAll = (): void => {
    for (const key of [...fetches.keys()]) invalidate(key)
  }

  // The bound translate resolves against the registered dictionaries with the
  // locale service's own fallback ladder; candidate-time reads stay plain text.
  const t = ctx.locale.bind(NS)

  const source: InputTriggerSource = {
    trigger: '/',
    name: 'skill',
    order: 2,
    async candidates(session, { query, signal }) {
      if (sessions.subagentAddress(session.sessionId) !== undefined) return []
      const catalog = await fetchCatalog(session.sessionId).promise
      const names = labels
      // Superseded keystroke: the shared fetch stays warm, this caller yields.
      if (signal.aborted) return []
      // The display name is the row's title and a search key; the name stays beside it.
      const skills: readonly (SkillEntry & { readonly label?: string })[] = catalog.map((skill) => {
        const label = names.get(skill.name)
        return label === undefined ? skill : { ...skill, label }
      })
      // The same ranking as the command group of this menu: case-insensitive
      // ordered subsequence, prefix hits first. Then Skills whose description
      // holds the query: slugs are Latin, so this is how a Chinese query finds one.
      const named = rankByName(skills, query)
      const lower = query.toLowerCase()
      const described = query === ''
        ? []
        : skills.filter(skill => !named.includes(skill) && skill.description.toLowerCase().includes(lower))
      return [...named, ...described]
        .map(skill => ({
          name: skill.name,
          ...(skill.label === undefined ? {} : { label: skill.label }),
          // The user-only marker rides the description (the menu's only
          // secondary text); `hint` is the claim-state ghost text, not a badge.
          description: skill.modelInvocable ? skill.description : `${t('menu.userOnly')} · ${skill.description}`,
        }))
    },
    warm(session) {
      // Fire-and-forget scope-birth prewarm; the shared fetch reports
      // through candidates.
      if (sessions.subagentAddress(session.sessionId) !== undefined) return
      fetchCatalog(session.sessionId).promise.catch(() => {})
    },
    lexicon(session) {
      return fetches.get(session.sessionId)?.settled?.map(skill => skill.name)
    },
    subscribeLexicon(session, listener) {
      const key = session.sessionId
      const listeners = lexiconListeners.get(key) ?? new Set()
      listeners.add(listener)
      lexiconListeners.set(key, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) lexiconListeners.delete(key)
      }
    },
    openReference(session, { ref }) {
      if (sessions.subagentAddress(session.sessionId) !== undefined) return false
      const cwd = sessions.list.getSnapshot().byId[session.sessionId]?.cwd
      const open = (catalog: readonly SkillEntry[]): boolean => {
        const path = catalog.find(skill => `/${skill.name}` === ref)?.path
        if (path === undefined) return false
        ctx.sidebarRight.openResource(fileAddressFor(session.sessionId, cwd, path))
        return true
      }
      const settled = fetches.get(session.sessionId)?.settled
      if (settled !== undefined) return open(settled)
      const entry = fetchCatalog(session.sessionId)
      void entry.promise.then((catalog) => {
        if (!entry.abort.signal.aborted) open(catalog)
      }).catch((error: unknown) => {
        if (!entry.abort.signal.aborted) console.error('[ui-skill] reference preview failed:', error)
      })
      return true
    },
    onPick({ candidate }) {
      // Plain-text-reference decision (web-input-machine note): the pick
      // lands plain text and the prompt ships the same
      // literal. Determinism lives host-side — the host's
      // pre-step boundary (dsh-tool-skill) recognizes the leading /name and
      // injects the rendered body for every entry point. A name shared with a
      // host command still resolves to the command: adjudication claims the
      // line client-side before it ever becomes a prompt.
      // A Skill with a display name lands as a chip showing it; the chip's text, and so the prompt, is still /name.
      if (candidate.label !== undefined) return { insert: skillChip(candidate.name, candidate.label) }
      return { text: `/${candidate.name} ` }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  // A preset decides which skill providers an agent reads, so a switched
  // session's cached catalog belongs to the composition it no longer runs.
  ctx.remote.$on('agent-preset/selected', invalidate)
  ctx.on('connection/reset', clearAll)
  ctx.effect(() => {
    const unregister = inputTriggers.registerSource(source)
    return () => {
      unregister()
      clearAll()
    }
  }, 'ui-skill: source')
}
