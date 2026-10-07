/** Installed-skill catalog and actions over the `installedSkills` Remote. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { InstalledSkillActionValue, InstalledSkillListValue, InstalledSkillView } from '@deepseek-ai/dsh-skill-controller/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Query and action state the page renders. */
export interface InstalledSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** Installed skills from the last successful read, sorted by name. */
  readonly skills: readonly InstalledSkillView[]
  /** Names whose action is in flight; their controls stay disabled. */
  readonly busy: readonly string[]
  /** Message of the last failed action until the next action starts or the user dismisses it. */
  readonly failure: string | null
}

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
  /** Switch one skill on or off; the switch moves at once and returns if the Host refuses. */
  readonly onToggle: (name: string, enabled: boolean) => Promise<void>
  readonly onReveal: (name: string) => Promise<void>
  readonly onEdit: (name: string) => Promise<void>
  /** Move one skill to the trash, then re-read the list. */
  readonly onUninstall: (name: string) => Promise<void>
  readonly onChat: (name: string) => void
  readonly onDismissFailure: () => void
}

/**
 * Create the installed-skill source. Reads start when the page asks for them; every action
 * clears the previous failure, marks its skill busy until the Host answers, records a refusal,
 * and supersedes a list read still in flight so an older answer cannot undo it.
 * @param deps - Remote calls and the chat navigation.
 * @returns the observable snapshot and the page callbacks.
 */
export function createInstalledSource(deps: InstalledDependencies): InstalledSkillsInjected {
  const store = createSnapshotStore<InstalledSnapshot>({ status: 'loading', skills: [], busy: [], failure: null })
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

  return {
    hooks: { installed: store },
    onRefresh,
    onToggle: async (name, enabled) => {
      setShown(name, enabled)
      if (!await act(name, () => deps.setEnabled(name, enabled))) setShown(name, !enabled)
    },
    onReveal: async (name) => { await act(name, () => deps.reveal(name)) },
    onEdit: async (name) => { await act(name, () => deps.edit(name)) },
    onUninstall: async (name) => {
      if (await act(name, () => deps.uninstall(name))) {
        patch(({ skills }) => ({ skills: skills.filter(skill => skill.name !== name) }))
      }
    },
    onChat: deps.chat,
    onDismissFailure: () => { patch(() => ({ failure: null })) },
  }
}
