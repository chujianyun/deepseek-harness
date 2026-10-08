/**
 * The notice that an e-commerce account's sign-in expired: an app-wide banner in `shell.overlay`
 * whose action opens Settings → E-commerce accounts, so the user can sign in again. Each account
 * is announced once per expiry; signing it in again lets a later expiry be announced anew. Accounts
 * that expire while the notice shows, as the checks after a start finish one by one, join it.
 */
import type { ReactNode } from 'react'
import type { EcommerceAccountsState } from '@deepseek-ai/dsh-ecommerce-accounts/types'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** The accounts the shown notice is about; `seq` keys the banner so a new notice restarts it. */
export interface ExpiredNotice {
  /** The first account's name: its store, else the account. */
  readonly name: string
  /** How many accounts expired. */
  readonly count: number
  readonly seq: number
}

/** The notice store: fed with each Host state, read by the overlay entry. */
export interface ExpiredSource {
  readonly hooks: { readonly notice: HostObservable<ExpiredNotice | null> }
  /**
   * Announce the accounts whose sign-in expired since the last state.
   * @param state - the latest Host state.
   */
  readonly observe: (state: EcommerceAccountsState) => void
  /** Clear the shown notice. */
  readonly dismiss: () => void
}

/**
 * Create the notice store.
 * @returns the store.
 */
export function createExpiredSource(): ExpiredSource {
  let notice: ExpiredNotice | null = null
  let seq = 0
  /** Accounts already announced for their current expiry. */
  const announced = new Set<string>()
  const listeners = new Set<() => void>()
  const publish = (next: ExpiredNotice | null): void => {
    notice = next
    for (const listener of listeners) listener()
  }
  return {
    hooks: {
      notice: {
        getSnapshot: () => notice,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    observe: (state) => {
      const fresh: string[] = []
      for (const account of state.accounts) {
        if (!account.expired) {
          // Signing in again, or a check that has not answered yet, ends this expiry.
          if (account.status === 'signed-in') announced.delete(account.id)
          continue
        }
        if (announced.has(account.id)) continue
        announced.add(account.id)
        fresh.push(account.storeName ?? account.account)
      }
      const [name] = fresh
      if (name === undefined) return
      publish(notice === null ? { name, count: fresh.length, seq: ++seq } : { ...notice, count: notice.count + fresh.length })
    },
    dismiss: () => { publish(null) },
  }
}

/** Props of the `shell.overlay` entry. */
export type ExpiredToastProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'ecommerce-accounts'>
  & InjectFace<Omit<ExpiredSource, 'observe'> & { readonly openAccounts: () => void }>

/** How long the notice stays, so there is time to act on it. */
const HOLD_MS = 15_000

/**
 * Render the notice, or nothing.
 * @param props - the notice, its dismissal, the way to the accounts, and the copy.
 * @returns the banner on display, or null.
 */
export function ExpiredToast({ useNotice, dismiss, openAccounts, t }: ExpiredToastProps): ReactNode {
  const notice = useNotice(current => current)
  if (notice === null) return null
  const text = notice.count === 1 ? t('expiredOne', { name: notice.name }) : t('expiredMany', { count: notice.count })
  return (
    <Toast
      key={`ecommerce-expired-${String(notice.seq)}`} text={text} icon={<IconWarningOutlineRegular />} holdMs={HOLD_MS} onDone={dismiss}
      actions={[{ label: t('expiredAction'), onClick: () => { dismiss(); openAccounts() } }]}
    />
  )
}
