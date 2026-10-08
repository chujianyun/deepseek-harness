/**
 * The E-commerce accounts section of Settings: the tenant's accounts grouped by platform and
 * searchable, each one's details with sign-in again and delete, and the dialogs that add an
 * account and follow its sign-in in Google Chrome.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type {
  EcommerceAccountKind, EcommerceAccountsState, EcommerceAccountView, EcommerceCheckProblem, EcommercePlatform,
} from '@deepseek-ai/dsh-ecommerce-accounts/types'
import { Button, IconSearchOutlineRegular, Input, Modal, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountsInjected, Refusal } from './accounts-source.ts'
import type { EcommerceLocaleKey } from './locales.ts'
import css from './EcommerceAccountsSection.module.css'

/** Props the section reads from its `settings.section` registration. */
export type EcommerceAccountsSectionProps = PropsLocale<'ecommerce-accounts'> & InjectFace<AccountsInjected>

type T = TranslateNS<'ecommerce-accounts'>

const PLATFORM_KEYS = {
  tmall: 'platformTmall', taobao: 'platformTaobao', pinduoduo: 'platformPinduoduo', doudian: 'platformDoudian',
} as const satisfies Record<EcommercePlatform, EcommerceLocaleKey>
/** Platforms a buyer account can be on. */
const BUYER_PLATFORMS: ReadonlySet<EcommercePlatform> = new Set(['tmall', 'taobao'])
/** Platforms in the order the add form offers them. */
const PLATFORM_ORDER = Object.keys(PLATFORM_KEYS) as EcommercePlatform[]
const PROBLEM_KEYS = {
  timeout: 'problemTimeout', network: 'problemNetwork', busy: 'problemBusy',
} as const satisfies Record<EcommerceCheckProblem, EcommerceLocaleKey>
const STATUS_KEYS = {
  'signed-in': 'statusSignedIn', 'signed-out': 'statusSignedOut', 'signing-in': 'statusSigningIn', checking: 'statusChecking', 'check-failed': 'statusCheckFailed',
} as const satisfies Record<EcommerceAccountView['status'], EcommerceLocaleKey>

/** The name a row leads with: the store of a merchant account, else the account. */
const titleOf = (account: EcommerceAccountView): string => account.storeName ?? account.account

/** The status in words; a failed check says why, and an account a task is using says so. */
function statusText(t: T, account: EcommerceAccountView): string {
  if (account.problem !== undefined) return t(PROBLEM_KEYS[account.problem])
  return account.inUse ? t('statusInUse') : t(STATUS_KEYS[account.status])
}

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
    case 'browser-busy': return t('browserBusy')
    case 'in-use': return t('inUse')
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
            {state !== undefined && accounts.some(item => item.kind === 'buyer') && (
              <DailyPagesField {...props} limit={state.buyerDailyPages} />
            )}
            {state !== undefined && accounts.length > 0 && (
              <AccountList
                {...props} accounts={accounts} limit={state.buyerDailyPages} query={query} setQuery={setQuery} onOpen={setOpenId}
              />
            )}
          </>
        )
        : (
          <AccountDetail
            {...props} account={opened} limit={(state as EcommerceAccountsState).buyerDailyPages} banner={banner}
            onBack={() => { setOpenId(null) }}
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
function AccountList({ t, accounts, limit, query, setQuery, onOpen }: EcommerceAccountsSectionProps & {
  readonly accounts: readonly EcommerceAccountView[]
  readonly limit: number
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
                      <span className={css.muted}>
                        {[item.account, t(item.kind === 'merchant' ? 'kindMerchant' : 'kindBuyer'), usageText(t, item, limit)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className={css.muted}>{statusText(t, item)}</span>
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
  readonly limit: number
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
    ['status', statusText(t, account)],
    ...account.kind === 'buyer' ? [['pagesToday', t('pagesValue', { used: account.pagesToday ?? 0, limit: props.limit })] as const] : [],
    ...account.cooldownUntil === undefined
      ? []
      : [['cooldown', t('cooldownValue', { hours: hoursLeft(account.cooldownUntil), until: clock(account.cooldownUntil) })] as const],
    ...account.signedInAs === undefined ? [] : [['signedInAs', account.signedInAs] as const],
    ...account.signedInStore === undefined ? [] : [['signedInStore', account.signedInStore] as const],
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
      <ActualAccount {...props} account={account} onSignIn={onSignIn} />
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
  const [platform, setPlatform] = useState<EcommercePlatform>('tmall')
  const [kind, setKind] = useState<EcommerceAccountKind>('merchant')
  const [storeName, setStoreName] = useState('')
  const [account, setAccount] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const buyer = kind === 'buyer'
  const ready = (buyer || storeName.trim() !== '') && account.trim() !== ''
  const choosePlatform = (next: EcommercePlatform): void => {
    setPlatform(next)
    // Buyer accounts are on Taobao and Tmall only.
    if (!BUYER_PLATFORMS.has(next)) setKind('merchant')
  }
  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await onAdd(buyer ? { platform, kind, account } : { platform, kind, storeName, account })
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
          <select
            className={css.select} value={platform} aria-label={t('platform')}
            onChange={(event) => { choosePlatform(event.target.value as EcommercePlatform) }}
          >
            {PLATFORM_ORDER.map(id => <option key={id} value={id}>{t(PLATFORM_KEYS[id])}</option>)}
          </select>
        </label>
        <label className={css.formField}>
          <span>{t('kind')}</span>
          <select
            className={css.select} value={kind} aria-label={t('kind')}
            onChange={(event) => { setKind(event.target.value as EcommerceAccountKind) }}
          >
            <option value="merchant">{t('kindMerchant')}</option>
            {BUYER_PLATFORMS.has(platform) && <option value="buyer">{t('kindBuyer')}</option>}
          </select>
        </label>
        {buyer
          ? <p className={css.muted}>{t('buyerOnly')}</p>
          : (
            <label className={css.formField}>
              <span>{t('storeName')}</span>
              <Input value={storeName} placeholder={t('storeNamePlaceholder')} onChange={(event) => { setStoreName(event.target.value) }} />
            </label>
          )}
        <label className={css.formField}>
          <span>{t('account')}</span>
          <Input value={account} placeholder={t('accountPlaceholder')} onChange={(event) => { setAccount(event.target.value) }} />
        </label>
        {!ready && <p className={css.muted}>{t(buyer ? 'requiredAccount' : 'required')}</p>}
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
        {refusal === undefined && done && (
          <p>{doneText(t, account)}</p>
        )}
        {refusal === undefined && done && (
          <ActualAccount {...props} account={account} onSignIn={() => { void props.onStartSignIn(account.id) }} />
        )}
        {refusal === undefined && !done && waiting && <p>{t('signInWaiting', { platform })}</p>}
        {refusal === undefined && !done && !waiting && <p>{t('signInExpired')}</p>}
        {failure !== null && <p className={css.error}>{failure}</p>}
      </div>
    </Modal>
  )
}

/** What the sign-in dialog says once signed in: the account or store the platform shows, when it shows one. */
function doneText(t: T, account: EcommerceAccountView): string {
  if (account.signedInAs !== undefined) return t('signInDone', { name: account.signedInAs })
  if (account.signedInStore !== undefined) return t('signInDoneStore', { name: account.signedInStore })
  return t('signInDoneUnnamed')
}

/** One name the platform reports differently from the one entered, and how to adopt it. */
interface Mismatch {
  readonly key: 'account' | 'storeName'
  readonly text: string
  readonly action: string
  readonly name: string
}

/**
 * When the platform reports another account or store name than the one entered: says so, and
 * offers to use the reported name or to sign in again.
 */
function ActualAccount(props: EcommerceAccountsSectionProps & { readonly account: EcommerceAccountView; readonly onSignIn: () => void }) {
  const { t, account, onSignIn } = props
  const [failure, setFailure] = useState<string | null>(null)
  if (account.status !== 'signed-in') return null
  const mismatches: Mismatch[] = []
  if (account.signedInAs !== undefined && account.signedInAs !== account.account) {
    mismatches.push({ key: 'account', text: t('actualAccount', { name: account.signedInAs }), action: t('useActual'), name: account.signedInAs })
  }
  if (account.signedInStore !== undefined && account.storeName !== undefined && account.signedInStore !== account.storeName) {
    mismatches.push({ key: 'storeName', text: t('actualStore', { name: account.signedInStore }), action: t('useActualStore'), name: account.signedInStore })
  }
  if (mismatches.length === 0) return null
  return (
    <div className={css.mismatch} role="note">
      {mismatches.map(mismatch => <p key={mismatch.key}>{mismatch.text}</p>)}
      <div className={css.actions}>
        {mismatches.map(mismatch => (
          <Button
            key={mismatch.key} variant="outline" size="sm"
            onClick={() => {
              void props.onRename(account.id, { [mismatch.key]: mismatch.name }).then((refusal) => {
                setFailure(refusal === undefined ? null : refusalText(t, refusal))
              })
            }}
          >
            {mismatch.action}
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={onSignIn}>{t('relogin')}</Button>
      </div>
      {failure !== null && <p className={css.error} role="alert">{failure}</p>}
    </div>
  )
}

/** Whole hours left until a time, at least one. */
const hoursLeft = (until: string): number => Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 3_600_000))

/** A time as month, day, hours, and minutes, such as `10-11 08:05`. */
function clock(at: string): string {
  const time = new Date(at)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`
}

/** A row's note on a buyer account: its rest after risk control, or its pages today. */
function usageText(t: T, account: EcommerceAccountView, limit: number): string | undefined {
  if (account.cooldownUntil !== undefined) return t('rowCooldown', { hours: hoursLeft(account.cooldownUntil) })
  return account.kind === 'buyer' ? t('rowPages', { used: account.pagesToday ?? 0, limit }) : undefined
}

/** The tenant's daily page limit for buyer accounts, with a way to change it. */
function DailyPagesField({ t, limit, onSetDailyPages }: EcommerceAccountsSectionProps & { readonly limit: number }) {
  const [value, setValue] = useState(String(limit))
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { setValue(String(limit)) }, [limit])
  const pages = Number(value)
  const valid = /^\d+$/u.test(value) && pages >= 1 && pages <= 1000
  return (
    <div className={css.dailyPages}>
      <span>{t('dailyPages')}</span>
      <Input
        className={`${css.dailyPagesInput}`} value={value} inputMode="numeric" aria-label={t('dailyPages')}
        onChange={(event) => { setValue(event.target.value); setNote(null) }}
      />
      <span>{t('dailyPagesUnit')}</span>
      <Button
        variant="outline" size="sm" disabled={!valid || pages === limit}
        onClick={() => { void onSetDailyPages(pages).then((refusal) => { setNote(refusal === undefined ? t('dailyPagesSaved') : refusalText(t, refusal)) }) }}
      >
        {t('saveDailyPages')}
      </Button>
      {!valid && <span className={css.error}>{t('dailyPagesInvalid')}</span>}
      {note !== null && <span className={css.muted} role="status">{note}</span>}
    </div>
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
