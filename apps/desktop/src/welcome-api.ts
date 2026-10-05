/** Operations available to the isolated native welcome renderer. */

import type { HubAccountView, HubBrandingView } from '@deepseek-ai/dsh-hub-account/types'
import type { ProductEventMap } from '@deepseek-ai/dsh-client-product-analytics/types'
import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  analytics: 'dsh-welcome:analytics',
  analyticsEnabled: 'dsh-welcome:analytics-enabled',
  branding: 'dsh-welcome:branding',
  start: 'dsh-welcome:start',
  cancel: 'dsh-welcome:cancel',
  copyLink: 'dsh-welcome:copy-link',
  state: 'dsh-welcome:state',
  takeNotice: 'dsh-welcome:take-notice',
} as const

/** One-time notification retained by the main process until Welcome receives it. */
export type WelcomeNotice = 'session-expired'

type WelcomeEventName = 'auth_page_view' | 'auth_page_click'

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /** @param eventName - allowed welcome event. @param attributes - approved fields without credentials. */
  analytics?<K extends WelcomeEventName>(eventName: K, attributes: ProductEventMap[K]): Promise<void>
  /** @returns the Host's current effective collection policy. */
  analyticsEnabled(): Promise<boolean>
  /** @returns the pending notification, clearing it before another renderer can receive it. */
  takeNotice(): Promise<WelcomeNotice | undefined>
  /** @returns the user-center sign-in state after starting, or joining, a sign-in attempt. */
  startSignIn(): Promise<HubAccountView>
  /** @param id - attempt to cancel. @returns the settled state. */
  cancelSignIn(id: string): Promise<HubAccountView>
  /** @param id - current waiting attempt whose sign-in page URL is copied to the system clipboard. */
  copySignInLink(id: string): Promise<void>
  /** @returns the last-signed-in tenant's cached logo and title; null shows no branding. */
  branding(): Promise<HubBrandingView | null>
}

/** The renderer receives localized copy, sign-in operations, and token-free sign-in snapshots. */
export type WelcomeApi = DesktopLocale & WelcomeOperations & {
  /** @param listener - sign-in snapshot recipient. @returns subscription disposer. */
  onAccountState(listener: (state: HubAccountView) => void): () => void
}

/**
 * Decide whether a startup or sign-out requires the welcome entry: the workspace opens only
 * after a user-center sign-in.
 * @param state - current user-center sign-in state.
 * @returns true while signed out.
 */
export function needsWelcome(state: Pick<HubAccountView, 'status'>): boolean {
  return state.status !== 'signed-in'
}
