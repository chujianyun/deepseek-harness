/** Installed-skill catalog and actions over the `installedSkills` Remote. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { InstalledSkillActionValue, InstalledSkillListValue, InstalledSkillView } from '@deepseek-ai/dsh-skill-controller/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { loadPins, savePin } from './pins.ts'

/** Query and action state the page renders. */
export interface InstalledSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** Installed skills from the last successful read, sorted by name. */
  readonly skills: readonly InstalledSkillView[]
  /** Names whose action is in flight; their controls stay disabled. */
  readonly busy: readonly string[]
  /** Message of the last failed action until the next action starts or the user dismisses it. */
  readonly failure: string | null
  /** Pinned skills as `pinKey(group, name)`, kept on this machine; pinned cards go first in their group. */
  readonly pinned: readonly string[]
}

/** An action the page applies to several selected skills at once. */
export type InstalledBatchAction = 'enable' | 'disable' | 'uninstall'

/** Remote calls and navigation the source drives. */
export interface InstalledDependencies {
  readonly list: () => Promise<RemoteResult<InstalledSkillListValue>>
  readonly setEnabled: (name: string, enabled: boolean) => Promise<RemoteResult<InstalledSkillView>>
  readonly reveal: (name: string) => Promise<RemoteResult<InstalledSkillActionValue>>
  readonly edit: (name: string) => Promise<RemoteResult<InstalledSkillActionValue>>
  readonly uninstall: (name: string) => Promise<RemoteResult<InstalledSkillActionValue>>
  /** Open a new Session whose draft invokes the skill. */
  readonly chat: (name: string) => void
}

/** Business face injected into the Skills page. */
export interface InstalledSkillsInjected {
  readonly hooks: { readonly installed: HostObservable<InstalledSnapshot> }
  /** Re-read the installed skills. */
  readonly onRefresh: () => Promise<void>
  /** Read the list again without showing the loading state; a read that fails keeps the list shown. */
  readonly onSync: () => Promise<void>
  /** Switch one skill on or off; the switch moves at once and returns if the Host refuses. */
  readonly onToggle: (name: string, enabled: boolean) => Promise<void>
  readonly onReveal: (name: string) => Promise<void>
  readonly onEdit: (name: string) => Promise<void>
  /** Move one skill to the trash, then re-read the list. */
  readonly onUninstall: (name: string) => Promise<void>
  readonly onChat: (name: string) => void
  readonly onDismissFailure: () => void
  /** Pin or unpin one skill on this machine. */
  readonly onTogglePin: (key: string, pinned: boolean) => void
  /**
   * Apply one action to the named skills, one after another. Enabling skips withdrawn skills; an
   * uninstalled skill leaves the list once the Host confirms its move.
   * @returns the names the Host refused (withdrawn skills skipped by enabling are not among them).
   */
  readonly onBatch: (action: InstalledBatchAction, names: readonly string[]) => Promise<readonly string[]>
}

/**
 * Create the installed-skill source. Reads start when the page asks for them; every action
 * clears the previous failure, marks its skill busy until the Host answers, records a refusal,
 * and supersedes a list read still in flight so an older answer cannot undo it.
 * @param deps - Remote calls and the chat navigation.
 * @returns the observable snapshot and the page callbacks.
 */
export function createInstalledSource(deps: InstalledDependencies): InstalledSkillsInjected {
  const store = createSnapshotStore<InstalledSnapshot>({ status: 'loading', skills: [], busy: [], failure: null, pinned: loadPins() })
  const patch = (next: (current: InstalledSnapshot) => Partial<InstalledSnapshot>): void => {
    const current = store.getSnapshot()
    store.set({ ...current, ...next(current) })
  }
  let epoch = 0

  const onRefresh = async (): Promise<void> => {
    const current = ++epoch
    patch(() => ({ status: 'loading' }))
    const result = await deps.list()
    if (current !== epoch) return
    patch(() => result.ok ? { status: 'ready', skills: result.value.skills } : { status: 'error' })
  }

  // Supersedes a read in flight like onRefresh does, so it also ends a loading state it took over.
  const onSync = async (): Promise<void> => {
    const current = ++epoch
    const result = await deps.list()
    if (current !== epoch) return
    if (result.ok) patch(() => ({ status: 'ready', skills: result.value.skills }))
    else patch(({ status }) => status === 'loading' ? { status: 'error' } : {})
  }

  /** Run one Host action for a skill; true when it succeeded. A list read already in flight predates it and is dropped. */
  const act = async <T>(name: string, call: () => Promise<RemoteResult<T>>): Promise<boolean> => {
    const supersedes = store.getSnapshot().status === 'loading'
    epoch += 1
    patch(({ busy }) => ({ failure: null, busy: [...busy, name] }))
    const result = await call()
    patch(({ busy }) => ({ busy: busy.filter(item => item !== name), ...result.ok ? {} : { failure: result.error.message } }))
    // The dropped read never published; read again so the page leaves its loading state.
    if (supersedes) void onRefresh()
    return result.ok
  }

  const setShown = (name: string, enabled: boolean): void => {
    patch(({ skills }) => ({ skills: skills.map(skill => skill.name === name ? { ...skill, enabled } : skill) }))
  }

  const uninstall = async (name: string): Promise<boolean> => {
    const ok = await act(name, () => deps.uninstall(name))
    if (ok) patch(({ skills }) => ({ skills: skills.filter(skill => skill.name !== name) }))
    return ok
  }
  const toggle = async (name: string, enabled: boolean): Promise<boolean> => {
    setShown(name, enabled)
    const ok = await act(name, () => deps.setEnabled(name, enabled))
    if (!ok) setShown(name, !enabled)
    return ok
  }

  return {
    hooks: { installed: store },
    onRefresh,
    onSync,
    onToggle: async (name, enabled) => { await toggle(name, enabled) },
    onReveal: async (name) => { await act(name, () => deps.reveal(name)) },
    onEdit: async (name) => { await act(name, () => deps.edit(name)) },
    onUninstall: async (name) => { await uninstall(name) },
    onChat: deps.chat,
    onDismissFailure: () => { patch(() => ({ failure: null })) },
    onTogglePin: (key, pinned) => { patch(({ pinned: current }) => ({ pinned: savePin(current, key, pinned) })) },
    onBatch: async (action, names) => {
      const refused: string[] = []
      for (const name of names) {
        const skill = store.getSnapshot().skills.find(item => item.name === name)
        if (skill === undefined || (action === 'enable' && skill.withdrawn)) continue
        const ok = action === 'uninstall' ? await uninstall(name) : await toggle(name, action === 'enable')
        if (!ok) refused.push(name)
      }
      // Each refusal set its own message; the page reports the whole batch instead.
      if (refused.length > 0) patch(() => ({ failure: null }))
      return refused
    },
  }
}
