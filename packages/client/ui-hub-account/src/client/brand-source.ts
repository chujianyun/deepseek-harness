/** The signed-in tenant's cached login-page branding for the new-session hero. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HubAccountView, HubBrandingView } from '@deepseek-ai/dsh-hub-account/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Business face injected into the new-session hero occupants. */
export interface HubBrandInjected {
  readonly hooks: {
    /** Sign-in state: the tenant name comes from the signed-in profile. */
    readonly hub: HostObservable<{ readonly view: HubAccountView | undefined }>
    /** Cached branding of the signed-in tenant; null while there is none. */
    readonly brand: HostObservable<HubBrandingView | null>
  }
}

/** The branding store plus the Host stream's entry point. */
export interface BrandSource {
  readonly brand: HostObservable<HubBrandingView | null>
  /** Adopt one Host state frame: read the branding again whenever its stamp changes. */
  readonly publish: (view: HubAccountView) => void
}

/**
 * Create the branding source.
 * @param read - the `hubAccount.getBranding` Remote call.
 * @returns the store and the frame entry point.
 */
export function createBrandSource(read: () => Promise<RemoteResult<HubBrandingView | null>>): BrandSource {
  const brand = createSnapshotStore<HubBrandingView | null>(null)
  let stamp: string | undefined
  return {
    brand,
    publish: (view) => {
      const next = JSON.stringify(view.branding)
      if (next === stamp) return
      stamp = next
      if (view.branding === null) { brand.set(null); return }
      void read().then((result) => {
        // A later frame already asked for newer branding.
        if (stamp === next) brand.set(result.ok ? result.value : null)
      })
    },
  }
}
