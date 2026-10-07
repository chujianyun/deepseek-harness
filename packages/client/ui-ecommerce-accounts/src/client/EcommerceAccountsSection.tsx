/**
 * The E-commerce accounts section of Settings: the tenant's accounts grouped by platform and
 * searchable, each one's details with sign-in again and delete, and the dialogs that add an
 * account and follow its sign-in in Google Chrome.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { EcommerceAccountView, EcommercePlatform } from '@deepseek-ai/dsh-ecommerce-accounts/types'
import { Button, IconSearchOutlineRegular, Input, Modal, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountsInjected, Refusal } from './accounts-source.ts'
import type { EcommerceLocaleKey } from './locales.ts'
import css from './EcommerceAccountsSection.module.css'

/** Props the section reads from its `settings.section` registration. */
export type EcommerceAccountsSectionProps = PropsLocale<'ecommerce-accounts'> & InjectFace<AccountsInjected>

type T = TranslateNS<'ecommerce-accounts'>

const PLATFORM_KEYS: Readonly<Record<EcommercePlatform, EcommerceLocaleKey>> = { tmall: 'platformTmall' }
const STATUS_KEYS = {
  'signed-in': 'statusSignedIn', 'signed-out': 'statusSignedOut', 'signing-in': 'statusSigningIn', checking: 'statusChecking', 'check-failed': 'statusCheckFailed',
} as const satisfies Record<EcommerceAccountView['status'], EcommerceLocaleKey>

/** The name a row leads with: the store of a merchant account, else the account. */
const titleOf = (account: EcommerceAccountView): string => account.storeName ?? account.account

/**
 * Word a refusal.
 * @param t - the translator.
 * @param refusal - what the Host refused.
 * @returns the line to show.
 */
function refusalText(t: T, refusal: Refusal): string {
  switch (refusal.kind) {
    case 'chrome-missing': return t('chromeMissing')
    case 'chrome-outdated': return t('chromeOutdated', { version: refusal.version, min: refusal.minVersion })
    case 'duplicate': return t('duplicate')
    case 'other': return t('failed', { message: refusal.message })
  }
}

/**
 * Render the section.
 * @param props - copy and the accounts face.
 * @returns the section.
 */
export function EcommerceAccountsSection(props: EcommerceAccountsSectionProps) {
  const { t, useAccounts, onRefresh } = props
  const state = useAccounts(snapshot => snapshot.state)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [signingIn, setSigningIn] = useState<{ readonly id: string; readonly refusal?: Refusal } | null>(null)
  const [query, setQuery] = useState('')
  // Opening the section checks every account, so the dots show the platforms' answers.
  useEffect(() => { void onRefresh() }, [onRefresh])
  const accounts = state?.accounts ?? []
  const opened = accounts.find(item => item.id === openId)
  const signIn = async (id: string): Promise<void> => {
    setSigningIn({ id })
    const refusal = await props.onStartSignIn(id)
    if (refusal !== undefined) setSigningIn({ id, refusal })
  }
  const chrome = state?.chrome
  const banner = chrome !== undefined && chrome.status !== 'ready' && (
    <div className={css.banner} role="alert">
      <span>{chrome.status === 'missing' ? t('chromeMissing') : t('chromeOutdated', { version: chrome.version ?? '', min: chrome.minVersion })}</span>
      <Button variant="outline" size="sm" onClick={() => { props.onOpenUrl(chrome.downloadUrl) }}>{t('download')}</Button>
    </div>
  )
  return (
    <section className={css.section} aria-label={t('section')}>
      {opened === undefined
        ? (
          <>
            <div className={css.header}>
              <p className={css.intro}>{t('intro')}</p>
              {accounts.length > 0 && <Button variant="primary" size="sm" onClick={() => { setAdding(true) }}>{t('add')}</Button>}
            </div>
            {banner}
            {state !== undefined && accounts.length === 0 && (
              <div className={css.empty}>
                <p>{t('empty')}</p>
                <Button variant="primary" onClick={() => { setAdding(true) }}>{t('addFirst')}</Button>
              </div>
            )}
            {accounts.length > 0 && <AccountList {...props} accounts={accounts} query={query} setQuery={setQuery} onOpen={setOpenId} />}
          </>
        )
        : (
          <AccountDetail
            {...props} account={opened} banner={banner} onBack={() => { setOpenId(null) }}
            onSignIn={() => { void signIn(opened.id) }}
          />
        )}
      {adding && (
        <AddDialog
          {...props} onClose={() => { setAdding(false) }}
          onAdded={(id) => { setAdding(false); void signIn(id) }}
        />
      )}
      {signingIn !== null && (
        <SignInDialog
          {...props} account={accounts.find(item => item.id === signingIn.id)} refusal={signingIn.refusal}
          downloadUrl={chrome?.downloadUrl} onClose={() => { setSigningIn(null) }}
        />
      )}
    </section>
  )
}

/** The accounts grouped by platform, filtered by the search. */
function AccountList({ t, accounts, query, setQuery, onOpen }: EcommerceAccountsSectionProps & {
  readonly accounts: readonly EcommerceAccountView[]
  readonly query: string
  readonly setQuery: (query: string) => void
  readonly onOpen: (id: string) => void
}) {
  const needle = query.trim().toLowerCase()
  const shown = needle === '' ? accounts : accounts.filter(item => `${item.storeName ?? ''}\n${item.account}`.toLowerCase().includes(needle))
  const groups = Map.groupBy(shown, item => item.platform)
  return (
    <>
      <span className={css.search}>
        <Input
          icon={<IconSearchOutlineRegular size={14} />} value={query} placeholder={t('search')} aria-label={t('search')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </span>
      {shown.length === 0 && <p className={css.muted}>{t('noMatch')}</p>}
      {[...groups].map(([platform, rows]) => {
        return (
          <details key={platform} className={css.group} open>
            <summary className={css.groupTitle}>
              {t(PLATFORM_KEYS[platform])}
              <span className={css.muted}>{t('count', { count: rows.length })}</span>
            </summary>
            <ul className={css.rows}>
              {rows.map(item => (
                <li key={item.id}>
                  <button type="button" className={css.row} aria-label={t('open', { name: titleOf(item) })} onClick={() => { onOpen(item.id) }}>
                    <StatusDot status={item.status} />
                    <span className={css.rowText}>
                      <span className={css.rowTitle}>{titleOf(item)}</span>
                      <span className={css.muted}>{`${item.account} · ${t(item.kind === 'merchant' ? 'kindMerchant' : 'kindBuyer')}`}</span>
                    </span>
                    <span className={css.muted}>{t(STATUS_KEYS[item.status])}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )
      })}
    </>
  )
}

/** A colored dot for the sign-in status. */
function StatusDot({ status }: { readonly status: EcommerceAccountView['status'] }) {
  return <span className={css.dot} data-status={status} aria-hidden="true" />
}

/** One account's details, with sign-in again and delete. */
function AccountDetail(props: EcommerceAccountsSectionProps & {
  readonly account: EcommerceAccountView
  readonly banner: ReactNode
  readonly onBack: () => void
  readonly onSignIn: () => void
}) {
  const { t, account, onBack, onSignIn } = props
  const [deleting, setDeleting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const fields: readonly (readonly [EcommerceLocaleKey, string])[] = [
    ['platform', t(PLATFORM_KEYS[account.platform])],
    ...account.storeName === undefined ? [] : [['storeName', account.storeName] as const],
    ['account', account.account],
    ['kind', t(account.kind === 'merchant' ? 'kindMerchant' : 'kindBuyer')],
    ['status', t(STATUS_KEYS[account.status])],
    ...account.signedInAs === undefined ? [] : [['signedInAs', account.signedInAs] as const],
    ...account.checkedAt === undefined ? [] : [['checkedAt', ago(t, account.checkedAt)] as const],
  ]
  return (
    <div className={css.detail}>
      <Button variant="ghost" size="sm" className={css.back} onClick={onBack}>{`← ${t('back')}`}</Button>
      <h3 className={css.detailTitle}><StatusDot status={account.status} />{titleOf(account)}</h3>
      {props.banner}
      <dl className={css.fields}>
        {fields.map(([key, value]) => (
          <div key={key} className={css.field}>
            <dt>{t(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {failure !== null && <p className={css.error} role="alert">{failure}</p>}
      <div className={css.actions}>
        <Button variant="primary" onClick={onSignIn}>{account.status === 'signed-in' ? t('relogin') : t('signIn')}</Button>
        <Button variant="ghost" onClick={() => { setDeleting(true) }}>{t('delete')}</Button>
      </div>
      {deleting && (
        <Modal
          open title={t('deleteTitle')} description={t('deleteBody', { name: titleOf(account) })} closeLabel={t('close')}
          onClose={() => { setDeleting(false) }}
          footer={(
            <>
              <Button variant="outline" onClick={() => { setDeleting(false) }}>{t('cancel')}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setDeleting(false)
                  void props.onDelete(account.id).then((refusal) => {
                    if (refusal === undefined) onBack()
                    else setFailure(refusalText(t, refusal))
                  })
                }}
              >
                {t('confirmDelete')}
              </Button>
            </>
          )}
        />
      )}
    </div>
  )
}

/** The add-account form: platform, kind, store name, and account, then sign in. */
function AddDialog(
  { t, onAdd, onClose, onAdded }: EcommerceAccountsSectionProps & { readonly onClose: () => void; readonly onAdded: (id: string) => void },
) {
  const [storeName, setStoreName] = useState('')
  const [account, setAccount] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const ready = storeName.trim() !== '' && account.trim() !== ''
  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await onAdd({ platform: 'tmall', kind: 'merchant', storeName, account })
    setBusy(false)
    if ('accountId' in result) onAdded(result.accountId)
    else setFailure(refusalText(t, result))
  }
  return (
    <Modal
      open title={t('add')} description={t('chromeHint')} closeLabel={t('close')} onClose={onClose}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => { void submit() }}>{t('signIn')}</Button>
        </>
      )}
    >
      <div className={css.form}>
        <label className={css.formField}>
          <span>{t('platform')}</span>
          <select className={css.select} value="tmall" aria-label={t('platform')} disabled>
            <option value="tmall">{t('platformTmall')}</option>
          </select>
        </label>
        <label className={css.formField}>
          <span>{t('kind')}</span>
          <select className={css.select} value="merchant" aria-label={t('kind')} disabled>
            <option value="merchant">{t('kindMerchant')}</option>
          </select>
        </label>
        <label className={css.formField}>
          <span>{t('storeName')}</span>
          <Input value={storeName} placeholder={t('storeNamePlaceholder')} onChange={(event) => { setStoreName(event.target.value) }} />
        </label>
        <label className={css.formField}>
          <span>{t('account')}</span>
          <Input value={account} placeholder={t('accountPlaceholder')} onChange={(event) => { setAccount(event.target.value) }} />
        </label>
        {!ready && <p className={css.muted}>{t('required')}</p>}
        {failure !== null && <p className={css.error} role="alert">{failure}</p>}
      </div>
    </Modal>
  )
}

/** Follows one sign-in: waiting in Chrome, the "I have signed in" check, and the outcome. */
function SignInDialog(props: EcommerceAccountsSectionProps & {
  readonly account: EcommerceAccountView | undefined
  readonly refusal: Refusal | undefined
  readonly downloadUrl: string | undefined
  readonly onClose: () => void
}) {
  const { t, account, refusal, downloadUrl, onClose } = props
  const [failure, setFailure] = useState<string | null>(null)
  const platform = t(PLATFORM_KEYS[account?.platform ?? 'tmall'])
  const done = account?.status === 'signed-in'
  const waiting = account?.status === 'signing-in' || account?.status === 'checking'
  const chromeRefused = refusal?.kind === 'chrome-missing' || refusal?.kind === 'chrome-outdated'
  return (
    <Modal
      open title={t('signInTitle', { platform })} closeLabel={t('close')} onClose={onClose}
      footer={(
        <>
          {chromeRefused && downloadUrl !== undefined && (
            <Button variant="outline" onClick={() => { props.onOpenUrl(downloadUrl) }}>{t('download')}</Button>
          )}
          {!done && refusal === undefined && account !== undefined && (
            <Button
              variant="outline"
              onClick={() => {
                void props.onConfirmSignIn(account.id).then((next) => { setFailure(next === undefined ? null : refusalText(t, next)) })
              }}
            >
              {t('signInConfirm')}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>{done ? t('done') : t('close')}</Button>
        </>
      )}
    >
      <div className={css.signIn} role="status">
        {refusal !== undefined && <p className={css.error}>{refusalText(t, refusal)}</p>}
        {refusal === undefined && done && <p>{t('signInDone', { name: account.signedInAs ?? account.account })}</p>}
        {refusal === undefined && !done && waiting && <p>{t('signInWaiting', { platform })}</p>}
        {refusal === undefined && !done && !waiting && <p>{t('signInExpired')}</p>}
        {failure !== null && <p className={css.error}>{failure}</p>}
      </div>
    </Modal>
  )
}

/** Copy key of each relative time unit. */
const TIME_KEYS = {
  now: 'timeNow', minutes: 'timeMinutes', hours: 'timeHours', days: 'timeDays', months: 'timeMonths', years: 'timeYears',
} as const satisfies Record<ReturnType<typeof relativeTime>['unit'], EcommerceLocaleKey>

/**
 * How long ago a time was, in the section's language.
 * @param t - the section's copy.
 * @param at - an ISO time.
 * @returns such as 「3 分钟前」.
 */
function ago(t: T, at: string): string {
  const { unit, n } = relativeTime(Date.parse(at), Date.now())
  return t(TIME_KEYS[unit], { n })
}
