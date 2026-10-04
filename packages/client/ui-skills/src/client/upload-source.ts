/** "添加技能": upload a local Skill to the Skill Hub over the `skillMarket` Remote. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  MarketUploadOptions, MarketUploadPreview, MarketUploadRequest, MarketUploadResult, MarketUploadSource,
} from '@deepseek-ai/dsh-skill-market/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketFailure } from './market-source.ts'

/** What the "添加技能" dialog renders. */
export interface UploadSnapshot {
  readonly open: boolean
  /** Pick a folder, fill in the upload, or read the Hub's answer. */
  readonly step: 'pick' | 'form' | 'done'
  /** The user's own Skills offered for upload; null until read. */
  readonly sources: readonly MarketUploadSource[] | null
  /** The folder being uploaded, once read. */
  readonly preview: MarketUploadPreview | null
  /** Visibility and category choices; null until read. */
  readonly options: MarketUploadOptions | null
  /** A folder read or the upload is in flight. */
  readonly busy: boolean
  /** The last refused call until the next action. */
  readonly failure: MarketFailure | null
  readonly result: MarketUploadResult | null
  /** Whether the review link was just copied. */
  readonly copied: boolean
}

/** The upload form's choices; visibility and category apply to a new Skill only. */
export type UploadForm = Omit<MarketUploadRequest, 'dir'>

/** Remote calls and browser actions the source drives. */
export interface UploadDependencies {
  readonly uploadSources: () => Promise<RemoteResult<readonly MarketUploadSource[]>>
  readonly inspectFolder: (dir: string) => Promise<RemoteResult<MarketUploadPreview>>
  readonly uploadOptions: () => Promise<RemoteResult<MarketUploadOptions>>
  readonly uploadSkill: (request: MarketUploadRequest) => Promise<RemoteResult<MarketUploadResult>>
  /** Open the system folder chooser; null when cancelled or unavailable. */
  readonly pickDirectory: () => Promise<string | null>
  readonly copy: (text: string) => Promise<boolean>
  /** Runs after a published upload, so the market list shows it. */
  readonly published: () => void
}

/** Business face injected into the "添加技能" dialog. */
export interface UploadInjected {
  readonly hooks: { readonly upload: HostObservable<UploadSnapshot> }
  /** Open the dialog and read the user's own Skills and the upload choices. */
  readonly onOpenUpload: () => Promise<void>
  readonly onCloseUpload: () => void
  /** Read one folder (a listed Skill, a typed path, or the folder chooser's answer). */
  readonly onInspectFolder: (dir: string) => Promise<void>
  readonly onBrowseFolder: () => Promise<void>
  readonly onBackToPick: () => void
  readonly onSubmitUpload: (form: UploadForm) => Promise<void>
  readonly onCopyReviewUrl: () => Promise<void>
}

const failureOf = (result: { error: { code: string; message: string } }): MarketFailure =>
  ({ code: result.error.code, message: result.error.message })

/**
 * Create the upload source.
 * @param deps - Remote calls, the folder chooser, the clipboard, and the market refresh.
 * @returns the observable snapshot and the dialog callbacks.
 */
export function createUploadSource(deps: UploadDependencies): UploadInjected {
  const initial: UploadSnapshot = {
    open: false, step: 'pick', sources: null, preview: null, options: null, busy: false, failure: null, result: null, copied: false,
  }
  const store = createSnapshotStore<UploadSnapshot>(initial)
  const patch = (next: Partial<UploadSnapshot>): void => { store.set({ ...store.getSnapshot(), ...next }) }

  const inspect = async (dir: string): Promise<void> => {
    patch({ busy: true, failure: null })
    const result = await deps.inspectFolder(dir)
    patch(result.ok ? { busy: false, step: 'form', preview: result.value } : { busy: false, failure: failureOf(result) })
  }

  return {
    hooks: { upload: store },
    onOpenUpload: async () => {
      store.set({ ...initial, open: true })
      const [sources, options] = await Promise.all([deps.uploadSources(), deps.uploadOptions()])
      patch({
        sources: sources.ok ? sources.value : [],
        ...options.ok ? { options: options.value } : {},
        ...!sources.ok ? { failure: failureOf(sources) } : !options.ok ? { failure: failureOf(options) } : {},
      })
    },
    onCloseUpload: () => { store.set(initial) },
    onInspectFolder: inspect,
    onBrowseFolder: async () => {
      const dir = await deps.pickDirectory()
      if (dir !== null) await inspect(dir)
    },
    onBackToPick: () => { patch({ step: 'pick', preview: null, failure: null }) },
    onSubmitUpload: async (form) => {
      const preview = store.getSnapshot().preview
      if (preview === null) return
      patch({ busy: true, failure: null })
      const result = await deps.uploadSkill({ ...form, dir: preview.dir })
      if (!result.ok) {
        patch({ busy: false, failure: failureOf(result) })
        return
      }
      patch({ busy: false, step: 'done', result: result.value })
      if (result.value.status === 'published') deps.published()
    },
    onCopyReviewUrl: async () => {
      const url = store.getSnapshot().result?.reviewUrl
      if (url != null) patch({ copied: await deps.copy(url) })
    },
  }
}
