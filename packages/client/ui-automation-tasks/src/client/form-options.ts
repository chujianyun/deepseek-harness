/** What the automation task form offers, read once when it opens, and the create call it makes. */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AutomationTaskCreateRequest, AutomationTaskCreateValue } from '@deepseek-ai/dsh-automation-tasks/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** One choice of a select. */
export interface TaskFormChoice {
  readonly value: string
  readonly label: string
}

/** The assistants, models, permission presets, and connected connectors the form offers. */
export interface TaskFormOptions {
  readonly assistants: readonly TaskFormChoice[]
  /** Models as `JSON.stringify([provider, model])` values. */
  readonly models: readonly TaskFormChoice[]
  readonly permissions: readonly TaskFormChoice[]
  readonly defaultPermission: string
  /** Ids of the connectors connected for the signed-in tenant. */
  readonly connectors: readonly string[]
}

/** One provider's models in the model catalog. */
export interface TaskFormModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** The Remote reads the options come from; each may be refused or absent. */
export interface TaskFormOptionSources {
  readonly assistants: () => Promise<RemoteResult<{ readonly assistants: readonly { readonly id: string; readonly name: string }[] }>>
  readonly models: () => Promise<RemoteResult<{ readonly groups: readonly TaskFormModelGroup[] }>>
  readonly permissions: () => Promise<RemoteResult<{
    readonly options: readonly { readonly value: string; readonly name: string }[]
    readonly defaultPreset: string
  }>>
  readonly connectors: () => Promise<RemoteResult<{ readonly connectors: readonly { readonly id: string; readonly status: string }[] }>>
}

/** The face the form receives. */
export interface TaskFormInjected {
  /** The workspaces a task's Session can be filed under, in sidebar order. */
  readonly hooks: { readonly workspaces: HostObservable<WorkspaceSnapshot> }
  /** Read the options; one that cannot be read offers none. */
  readonly loadOptions: () => Promise<TaskFormOptions>
  /** Create the task. */
  readonly onCreate: (request: AutomationTaskCreateRequest) => Promise<RemoteResult<AutomationTaskCreateValue>>
}

/**
 * Read every option at once; a source that refuses or throws contributes none.
 * @param sources - the Remote reads.
 * @returns the options.
 */
export async function loadTaskFormOptions(sources: TaskFormOptionSources): Promise<TaskFormOptions> {
  const settle = <T>(read: () => Promise<RemoteResult<T>>): Promise<T | undefined> =>
    // A read that throws offers nothing, as a refused one does.
    Promise.resolve().then(read).then(result => (result.ok ? result.value : undefined), () => undefined)
  const [assistants, models, permissions, connectors] = await Promise.all([
    settle(sources.assistants), settle(sources.models), settle(sources.permissions), settle(sources.connectors),
  ])
  return {
    assistants: (assistants?.assistants ?? []).map(item => ({ value: item.id, label: item.name })),
    models: (models?.groups ?? []).flatMap(group => group.models.map(model => ({
      value: JSON.stringify([group.id, model.id]), label: `${group.name} · ${model.name}`,
    }))),
    permissions: (permissions?.options ?? []).filter(option => option.value !== 'custom').map(option => ({ value: option.value, label: option.name })),
    defaultPermission: permissions?.defaultPreset ?? '',
    connectors: (connectors?.connectors ?? []).filter(item => item.status === 'connected' || item.status === 'degraded').map(item => item.id),
  }
}
