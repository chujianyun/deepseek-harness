/**
 * Company assistant packages over the `assistantPackages` Remote: the Assistants page's company section and an
 * installed assistant's recommended tasks.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AssistantPackageInstallResult, AssistantPackagesState } from '@deepseek-ai/dsh-assistant-packages/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** What the company section and the recommended tasks show. */
export interface PackagesSnapshot {
  /** Last state read; undefined before the first read or when this deployment has no packages. */
  readonly state: AssistantPackagesState | undefined
  /** Package id or `assistantId:taskId` of the action running now. */
  readonly running: string | null
}

/** The `assistantPackages` Remote calls the source makes. */
export interface PackagesDependencies {
  readonly read: () => Promise<RemoteResult<AssistantPackagesState>>
  readonly install: (packageId: string) => Promise<RemoteResult<AssistantPackageInstallResult>>
  readonly update: (assistantId: string) => Promise<RemoteResult<AssistantPackageInstallResult>>
  readonly enableTask: (assistantId: string, taskId: string, workspaceId: string) => Promise<RemoteResult<AssistantPackagesState>>
  readonly disableTask: (assistantId: string, taskId: string) => Promise<RemoteResult<AssistantPackagesState>>
  /** The workspaces a task's Session can be filed under. */
  readonly workspaces: HostObservable<WorkspaceSnapshot>
}

/** An install or update that went through: what it installed and kept. */
export type PackageActionOutcome = Pick<AssistantPackageInstallResult, 'assistantId' | 'version' | 'installedSkills' | 'missingSkills' | 'keptFiles'>

/** The face the page and the detail page read. */
export interface PackagesInjected {
  readonly hooks: { readonly packages: HostObservable<PackagesSnapshot>; readonly workspaces: HostObservable<WorkspaceSnapshot> }
  /** Read the state again. */
  readonly onPackagesRefresh: () => Promise<void>
  /** Install a package; resolves the outcome, or the refusal message. */
  readonly onPackageInstall: (packageId: string) => Promise<PackageActionOutcome | string>
  /** Update an installed assistant; resolves the outcome, or the refusal message. */
  readonly onPackageUpdate: (assistantId: string) => Promise<PackageActionOutcome | string>
  /** Switch a recommended task on in a workspace; resolves the refusal message, if any. */
  readonly onTaskEnable: (assistantId: string, taskId: string, workspaceId: string) => Promise<string | undefined>
  /** Switch a recommended task off; resolves the refusal message, if any. */
  readonly onTaskDisable: (assistantId: string, taskId: string) => Promise<string | undefined>
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The refusal of an action asked for while another runs; the views show it in the user's language. */
export const PACKAGES_BUSY = 'assistant-packages:busy'

/**
 * Hold the packages state and run the page's package actions one at a time.
 * @param deps - the Remote calls and the workspaces.
 * @returns the injected face.
 */
export function createPackagesSource(deps: PackagesDependencies): PackagesInjected {
  const store = createSnapshotStore<PackagesSnapshot>({ state: undefined, running: null })
  const set = (patch: Partial<PackagesSnapshot>): void => { store.set({ ...store.getSnapshot(), ...patch }) }
  const onRefresh = async (): Promise<void> => {
    try {
      const result = await deps.read()
      if (result.ok) set({ state: result.value })
    } catch {
      // A deployment without the Remote, or a dropped connection, shows no company section until the next read.
    }
  }
  /**
   * Run one action under `key`; a second action while one runs is refused. The state the action
   * returns is shown as is; after a refusal the state is read again.
   */
  const run = async <T>(
    key: string, action: () => Promise<RemoteResult<T>>, stateOf: (value: T) => AssistantPackagesState,
  ): Promise<T | string> => {
    if (store.getSnapshot().running !== null) return PACKAGES_BUSY
    set({ running: key })
    let outcome: T | string
    try {
      const result = await action()
      outcome = result.ok ? result.value : result.error.message
    } catch (error) {
      outcome = message(error)
    }
    if (typeof outcome === 'string') {
      set({ running: null })
      await onRefresh()
    } else {
      set({ running: null, state: stateOf(outcome) })
    }
    return outcome
  }
  const fromResult = (value: AssistantPackageInstallResult): AssistantPackagesState => value.state
  const asState = (value: AssistantPackagesState): AssistantPackagesState => value
  const outcome = (value: AssistantPackageInstallResult | string): PackageActionOutcome | string => {
    if (typeof value === 'string') return value
    const { state: _state, ...rest } = value
    return rest
  }
  return {
    hooks: { packages: store, workspaces: deps.workspaces },
    onPackagesRefresh: onRefresh,
    onPackageInstall: async packageId => outcome(await run(packageId, () => deps.install(packageId), fromResult)),
    onPackageUpdate: async assistantId => outcome(await run(assistantId, () => deps.update(assistantId), fromResult)),
    onTaskEnable: async (assistantId, taskId, workspaceId) => {
      const value = await run(`${assistantId}:${taskId}`, () => deps.enableTask(assistantId, taskId, workspaceId), asState)
      return typeof value === 'string' ? value : undefined
    },
    onTaskDisable: async (assistantId, taskId) => {
      const value = await run(`${assistantId}:${taskId}`, () => deps.disableTask(assistantId, taskId), asState)
      return typeof value === 'string' ? value : undefined
    },
  }
}
