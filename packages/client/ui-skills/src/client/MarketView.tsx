/** The Skill Hub market: search, category tabs, cards with one-click install, and the detail dialog. */

import { useEffect, useMemo, useState } from 'react'
import type { MarketSkillCard, MarketSkillDetail } from '@deepseek-ai/dsh-skill-market/types'
import { Button, fileSizeText, Input, MarkdownText, Modal, SegmentedTabs, Tag, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketFailure } from './market-source.ts'
import type { SkillsPageProps } from './SkillsPage.tsx'
import css from './SkillsPage.module.css'

/** Tab value of "all categories". */
const ALL = '*'
/** Localized copy of the market's own refusals; any other failure shows its message. */
const FAILURE_KEYS = {
  'skill-market/name-conflict': 'conflict',
  'skill-market/invalid-package': 'failureInvalidPackage',
  'skill-market/unavailable': 'failureUnavailable',
  'skill-market/not-found': 'failureNotFound',
  'hub-account/signed-out': 'failureSignedOut',
} as const

/**
 * The text of one refused market call.
 * @param failure - the refusal.
 * @param t - the `skills` translator.
 * @returns the localized reason, or the Host message for an unexpected refusal.
 */
function failureText(failure: MarketFailure, t: TranslateNS<'skills'>): string {
  return failure.code in FAILURE_KEYS ? t(FAILURE_KEYS[failure.code as keyof typeof FAILURE_KEYS]) : failure.message
}

/** The card list, labelled by the selected category tab. */
const PANEL_ID = 'market-panel'

/**
 * The SKILL.md body without its YAML frontmatter, which the dialog already shows as facts.
 * @param source - SKILL.md source.
 * @returns the Markdown body.
 */
export function skillMdBody(source: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(source)
  return match === null ? source : source.slice(match[0].length).trimStart()
}

/**
 * Render the market and read it (and the installed count) each time it opens.
 * @param props - the page props and the way to the installed view.
 * @returns the market view.
 */
export function MarketView(props: SkillsPageProps & { onShowInstalled: () => void }) {
  const {
    t, useMarket, useInstalled, onOpenMarket, onRefresh, onSearch, onCategory, onLoadMore, onDismissMarketFailure, onShowInstalled,
  } = props
  const status = useMarket(snapshot => snapshot.status)
  const error = useMarket(snapshot => snapshot.error)
  const items = useMarket(snapshot => snapshot.items)
  const total = useMarket(snapshot => snapshot.total)
  const categoryId = useMarket(snapshot => snapshot.categoryId)
  const categories = useMarket(snapshot => snapshot.categories)
  const failure = useMarket(snapshot => snapshot.failure)
  const installedCount = useInstalled(snapshot => snapshot.skills.length)
  const searched = useMarket(snapshot => snapshot.q)
  const [query, setQuery] = useState(searched)

  useEffect(() => {
    void onOpenMarket()
    void onRefresh()
  }, [onOpenMarket, onRefresh])

  const tabs = useMemo(() => [
    { value: ALL, label: t('allCategories'), id: 'market-tab-all', panelId: PANEL_ID },
    ...categories.map(category => ({ value: category.id, label: category.name, id: `market-tab-${category.id}`, panelId: PANEL_ID })),
  ] as const, [categories, t])
  const selected = tabs.find(tab => tab.value === (categoryId ?? ALL)) ?? tabs[0]

  return (
    <div className={css.page}>
      <header className={css.header} data-window-drag>
        <div className={css.headerRow}>
          <h1 className={css.title}>{t('marketTitle')}</h1>
          <div className={css.headerActions}>
            <Button size="sm" variant="outline" onClick={onShowInstalled}>{t('installedButton', { count: String(installedCount) })}</Button>
            <Button size="sm" variant="primary" onClick={() => { void props.onOpenUpload() }}>{t('addSkill')}</Button>
          </div>
        </div>
        <p className={css.intro}>{t('marketIntro')}</p>
      </header>
      <form className={css.toolbar} role="search" onSubmit={(event) => { event.preventDefault(); void onSearch(query.trim()) }}>
        <Input className={`${css.search}`} type="search" value={query} placeholder={t('searchPlaceholder')} aria-label={t('searchPlaceholder')}
          onChange={(event) => { setQuery(event.target.value) }} />
        <Button size="sm" variant="outline" type="submit">{t('search')}</Button>
      </form>
      <SegmentedTabs items={[tabs[0], ...tabs.slice(1)]} value={selected.value} label={t('categoryTabs')}
        onChange={(value) => { void onCategory(value === ALL ? null : value) }} />
      {failure !== null && (
        <div className={css.failure} role="alert">
          <span>{t('installFailed', { message: failureText(failure, t) })}</span>
          <Button size="sm" variant="ghost" onClick={onDismissMarketFailure}>{t('uninstallClose')}</Button>
        </div>
      )}
      {status === 'error' ? (
        <div className={css.notice}>
          <span>{t('marketError', { message: error === null ? '' : failureText(error, t) })}</span>
          <Button size="sm" variant="outline" onClick={() => { void onOpenMarket() }}>{t('retry')}</Button>
        </div>
      ) : status === 'loading' && items.length === 0 ? (
        <p className={css.notice}>{t('marketLoading')}</p>
      ) : items.length === 0 ? (
        <p className={css.notice}>{t('marketEmpty')}</p>
      ) : (
        <ul className={css.grid} id={PANEL_ID} role="tabpanel" aria-labelledby={selected.id}>
          {items.map(item => <MarketCard key={item.id} item={item} props={props} />)}
          {items.length < total && (
            <li>
              <button type="button" className={css.loadMore} onClick={() => { void onLoadMore() }}>
                {t('marketLoadMore', { count: String(total - items.length) })}
              </button>
            </li>
          )}
        </ul>
      )}
      <MarketDetailDialog props={props} />
    </div>
  )
}

/**
 * The avatar letter of a Skill: the first character of its shown name, uppercased.
 * @param name - the shown name.
 * @returns one character.
 */
export function initial(name: string): string {
  return (Array.from(name)[0] ?? '').toUpperCase()
}

function MarketCard({ item, props }: { item: MarketSkillCard; props: SkillsPageProps }) {
  const { onOpenDetail } = props
  return (
    <li className={css.card}>
      <div className={css.cardHead}>
        <span className={css.avatar} aria-hidden="true">{initial(item.displayName)}</span>
        <button type="button" className={css.cardLink} onClick={() => { void onOpenDetail(item.id) }}>{item.displayName}</button>
        <InstallControl item={item} props={props} compact />
      </div>
      <p className={css.description}>{item.description}</p>
      {item.category !== null && <span className={css.meta}>{item.category.name}</span>}
      {item.conflict && item.installedVersion === null && <span className={css.conflict}>{props.t('conflict')}</span>}
    </li>
  )
}

/** The + on a card, or the install button of the detail; installed and conflicting Skills cannot be installed. */
function InstallControl({ item, props, compact = false }: { item: MarketSkillCard; props: SkillsPageProps; compact?: boolean }) {
  const { t, useMarket, onInstall } = props
  const installing = useMarket(snapshot => snapshot.installing.includes(item.id))
  if (item.installedVersion !== null && !item.updateAvailable) return <Tag>{t('installedVersion', { version: item.installedVersion })}</Tag>
  if (item.updateAvailable) {
    return (
      <Button size="sm" variant={compact ? 'outline' : 'primary'} disabled={installing}
        aria-label={t('update', { name: item.displayName })} onClick={() => { void onInstall(item.id) }}>
        {installing ? t('installing') : t('updateTo', { version: item.version })}
      </Button>
    )
  }
  const label = installing ? t('installing') : compact ? '+' : t('installButton')
  const button = (
    <Button size="sm" variant={compact ? 'outline' : 'primary'} disabled={installing || item.conflict}
      aria-label={item.conflict ? t('conflict') : t('install', { name: item.displayName })} onClick={() => { void onInstall(item.id) }}>
      {label}
    </Button>
  )
  return button
}

function MarketDetailDialog({ props }: { props: SkillsPageProps }) {
  const { t, useMarket, onCloseDetail } = props
  const detail = useMarket(snapshot => snapshot.detail)
  const items = useMarket(snapshot => snapshot.items)
  const title = detail?.status === 'ready' ? detail.value.displayName : items.find(item => item.id === detail?.id)?.displayName ?? ''
  return (
    <Modal
      open={detail !== null}
      title={title}
      closeLabel={t('uninstallClose')}
      onClose={onCloseDetail}
      className={`${css.detail}`}
      footer={detail?.status === 'ready' && <div className={css.dialogActions}><InstallControl item={detail.value} props={props} /></div>}
    >
      {detail?.status === 'loading' && <p className={css.notice}>{t('detailLoading')}</p>}
      {detail?.status === 'error' && <p className={css.notice}>{t('detailError', { message: detail.message })}</p>}
      {detail?.status === 'ready' && <DetailBody detail={detail.value} t={t} />}
    </Modal>
  )
}

function DetailBody({ detail, t }: { detail: MarketSkillDetail; t: TranslateNS<'skills'> }) {
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('codeCopy'), copiedLabel: t('codeCopied'), toolbarLabels: { codeLabel: t('codeTitle'), wrapLabel: t('codeWrap'), unwrapLabel: t('codeUnwrap') } },
    footnotes: t('footnotes'),
  }), [t])
  return (
    <div className={css.detailBody}>
      <p className={css.intro}>{detail.description}</p>
      <dl className={css.facts}>
        <dt>{t('detailSlug')}</dt><dd><code>{detail.name}</code></dd>
        <dt>{t('detailCategory')}</dt><dd>{detail.category?.name ?? t('noCategory')}</dd>
        <dt>{t('detailOwner')}</dt><dd>{detail.ownerName}</dd>
        <dt>{t('detailVersion')}</dt><dd>{detail.version}</dd>
        <dt>{t('detailUpdated')}</dt><dd>{new Date(detail.updatedAt).toLocaleString()}</dd>
      </dl>
      {detail.conflict && <p className={css.failure} role="alert">{t('conflict')}</p>}
      <section aria-label={t('skillMd')} className={css.skillMd}>
        <MarkdownText text={skillMdBody(detail.skillMd)} labels={labels} />
      </section>
      <section aria-labelledby="skill-files">
        <h3 id="skill-files" className={css.groupTitle}>{t('detailFiles', { count: String(detail.files.length) })}</h3>
        <ul className={css.files}>
          {detail.files.map(file => (
            <li key={file.path}><code>{file.path}</code><span className={css.meta}>{fileSizeText(file.size)}</span></li>
          ))}
        </ul>
      </section>
    </div>
  )
}
