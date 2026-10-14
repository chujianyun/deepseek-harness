/** The Skills page: the Skill Hub market, and the installed Skills as cards with an on/off switch and an actions menu. */

import { useEffect, useState } from 'react'
import type { InstalledSkillGroup, InstalledSkillView } from '@deepseek-ai/dsh-skill-controller/types'
import {
  Button, Checkbox, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular,
  IconNewChatOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, IconTrashOutlineRegular, Input, Menu, Modal, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { InstalledBatchAction, InstalledSkillsInjected } from './installed-source.ts'
import { pinKey } from './pins.ts'
import type { MarketInjected } from './market-source.ts'
import type { UploadInjected } from './upload-source.ts'
import { AddSkillDialog } from './AddSkillDialog.tsx'
import { initial, MarketView } from './MarketView.tsx'
import css from './SkillsPage.module.css'

/** Cards shown per "load more" step of an installed group. */
const PAGE_SIZE = 12

/** Business face of the whole page: installed Skills, the market, and uploads. */
export type SkillsInjected = Omit<InstalledSkillsInjected, 'hooks'> & Omit<MarketInjected, 'hooks'> & Omit<UploadInjected, 'hooks'> & {
  readonly hooks: InstalledSkillsInjected['hooks'] & MarketInjected['hooks'] & UploadInjected['hooks']
}

/** Props the page reads from its `main` registration: the translator and the Skills face. */
export type SkillsPageProps = PropsLocale<'skills'> & InjectFace<SkillsInjected>

/**
 * Render the market, or the installed Skills after "我安装的"; each view reads its lists when it opens.
 * @param props - the `skills` translator and the Skills face.
 * @returns the page element.
 */
export function SkillsPage(props: SkillsPageProps) {
  const [view, setView] = useState<'market' | 'installed'>('market')
  return (
    <>
      {view === 'market'
        ? <MarketView {...props} onShowInstalled={() => { setView('installed') }} />
        : <InstalledView {...props} onBack={() => { setView('market') }} />}
      <OverwriteDialog {...props} />
      <AddSkillDialog {...props} />
    </>
  )
}

/**
 * Ask before an update overwrites locally edited files of a market Skill.
 * @param props - the page props.
 * @returns the confirmation dialog, open while an update waits for the answer.
 */
export function OverwriteDialog({ t, useMarket, onConfirmOverwrite, onCancelOverwrite }: SkillsPageProps) {
  const pending = useMarket(snapshot => snapshot.overwrite)
  // The overwrite comes from the install refusal, which names the slug; show the display name when known
  const label = useMarket(snapshot => pending === null ? ''
    : snapshot.items.find(item => item.id === pending.id)?.displayName ?? snapshot.statuses[pending.name]?.displayName ?? pending.name)
  return (
    <Modal
      open={pending !== null}
      title={t('overwriteTitle')}
      description={t('overwriteDescription', { name: label })}
      closeLabel={t('uninstallClose')}
      onClose={onCancelOverwrite}
      footer={pending !== null && (
        <div className={css.dialogActions}>
          <Button variant="outline" onClick={onCancelOverwrite}>{t('overwriteCancel')}</Button>
          <Button variant="primary" onClick={() => { void onConfirmOverwrite() }}>{t('overwriteConfirm')}</Button>
        </div>
      )}
    >
      {pending !== null && <ul className={css.files}>{pending.files.map(file => <li key={file}><code>{file}</code></li>)}</ul>}
    </Modal>
  )
}

/**
 * The installed Skills in two groups: the ones the user placed on this machine, and the ones from the market.
 * @param props - the page props and the way back to the market.
 * @returns the installed view.
 */
export function InstalledView(props: SkillsPageProps & { onBack: () => void }) {
  const { t, useInstalled, onRefresh, onDismissFailure, onBack } = props
  const status = useInstalled(snapshot => snapshot.status)
  const installed = useInstalled(snapshot => snapshot.skills)
  const failure = useInstalled(snapshot => snapshot.failure)
  const [uninstalling, setUninstalling] = useState<string>()
  const uninstallLabel = props.useMarket(snapshot => uninstalling === undefined ? undefined : snapshot.statuses[uninstalling]?.displayName)
  // Bulk management: a selection of skill names, the names an uninstall waits to confirm, and the names a batch could not do
  const [picked, setPicked] = useState<ReadonlySet<string> | undefined>()
  const [confirmBatch, setConfirmBatch] = useState<readonly string[]>()
  const [batchRefused, setBatchRefused] = useState<readonly string[]>([])
  const [batchRunning, setBatchRunning] = useState(false)
  const statuses = props.useMarket(snapshot => snapshot.statuses)
  const shownName = (name: string) => statuses[name]?.displayName ?? name
  // Search filters as the user types: the name the card shows, the name, and the description, ignoring case
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const skills = needle === '' ? installed : installed.filter(skill =>
    [skill.group === 'market' ? shownName(skill.name) : skill.name, skill.name, skill.description].some(text => text.toLowerCase().includes(needle)))
  const noMatch = needle !== '' && installed.length > 0 && skills.length === 0
  // Only skills still listed and matching the search count as selected (one may leave through its own menu or a re-read)
  const selected = picked === undefined ? undefined : new Set(skills.map(skill => skill.name).filter(name => picked.has(name)))
  const runBatch = async (action: InstalledBatchAction, names: readonly string[]): Promise<void> => {
    setBatchRunning(true)
    setBatchRefused([])
    // Enabling leaves withdrawn skills out: they stay off until the platform offers them again
    const targets = action === 'enable' ? names.filter(name => !skills.some(skill => skill.name === name && isWithdrawn(skill, statuses[name]?.state))) : names
    let refused: readonly string[]
    try {
      refused = await props.onBatch(action, targets)
    } catch {
      // A batch that broke off reports every skill it was given as not done; the list re-read shows the rest
      refused = targets
    }
    setBatchRunning(false)
    setBatchRefused(refused)
    // Uninstalled skills leave the selection (selection and Done stay locked while the batch runs)
    if (action === 'uninstall') setPicked(new Set(refused))
  }
  const selection = selected === undefined ? undefined : {
    has: (name: string) => selected.has(name),
    set: (name: string, on: boolean) => {
      setPicked((current) => {
        const next = new Set(current)
        if (on) next.add(name); else next.delete(name)
        return next
      })
    },
    running: batchRunning,
  }

  useEffect(() => {
    void onRefresh()
    // The Hub check can switch withdrawn Skills off or back on: read the list again quietly afterwards.
    void props.onRefreshStatus().then(() => props.onSync())
  }, [onRefresh, props.onRefreshStatus, props.onSync])

  return (
    <div className={css.page}>
      <header className={css.header} data-window-drag>
        <div className={css.headerRow}>
          <h1 className={css.title}>{t('installedTitle')}</h1>
          <div className={css.headerActions}>
            {installed.length > 0 && (
              <Input className={`${css.installedSearch}`} type="search" value={query} placeholder={t('installedSearch')} aria-label={t('installedSearch')}
                onChange={(event) => {
                  setQuery(event.target.value)
                  // A new search starts a new selection, so no skill the search hides stays selected
                  if (picked !== undefined) setPicked(new Set())
                }} />
            )}
            {selected === undefined && installed.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => { setPicked(new Set()); setBatchRefused([]) }}>{t('batchManage')}</Button>
            )}
            <Button size="sm" variant="outline" onClick={onBack}>{t('backToMarket')}</Button>
          </div>
        </div>
        <p className={css.intro}>{t('installedIntro')}</p>
        {selected !== undefined && (
          <div className={css.batchBar} role="toolbar" aria-label={t('batchManage')}>
            <Checkbox
              checked={skills.length > 0 && selected.size === skills.length}
              indeterminate={selected.size > 0 && selected.size < skills.length}
              label={t('batchSelectAll')}
              disabled={batchRunning}
              onChange={(all) => { setPicked(new Set(all ? skills.map(skill => skill.name) : [])) }}
            />
            <span className={css.meta}>{t('batchSelected', { count: String(selected.size) })}</span>
            <span className={css.batchActions}>
              <Button size="sm" variant="outline" disabled={selected.size === 0 || batchRunning} onClick={() => { void runBatch('enable', [...selected]) }}>{t('batchEnable')}</Button>
              <Button size="sm" variant="outline" disabled={selected.size === 0 || batchRunning} onClick={() => { void runBatch('disable', [...selected]) }}>{t('batchDisable')}</Button>
              <Button size="sm" variant="outline" disabled={selected.size === 0 || batchRunning} onClick={() => { setConfirmBatch([...selected]) }}>{t('batchUninstall')}</Button>
              <Button size="sm" variant="primary" disabled={batchRunning} onClick={() => { setPicked(undefined); setBatchRefused([]) }}>{t('batchDone')}</Button>
            </span>
          </div>
        )}
      </header>
      {batchRefused.length > 0 && (
        <div className={css.failure} role="alert">
          <span>{t('batchFailed', { count: String(batchRefused.length), names: batchRefused.map(shownName).join(t('listSeparator')) })}</span>
          <Button size="sm" variant="ghost" onClick={() => { setBatchRefused([]) }}>{t('uninstallClose')}</Button>
        </div>
      )}
      {failure !== null && (
        <div className={css.failure} role="alert">
          <span>{t('actionFailed', { message: failure })}</span>
          <Button size="sm" variant="ghost" onClick={onDismissFailure}>{t('uninstallClose')}</Button>
        </div>
      )}
      {/* Stays mounted so screen readers announce the hint when a search stops matching */}
      <p className={noMatch ? css.notice : css.statusIdle} role="status">{noMatch ? t('installedNoMatch', { query: query.trim() }) : ''}</p>
      {status === 'error' && installed.length === 0 ? (
        <div className={css.notice}>
          <span>{t('error')}</span>
          <Button size="sm" variant="outline" onClick={() => { void onRefresh() }}>{t('retry')}</Button>
        </div>
      ) : status === 'loading' && installed.length === 0 ? (
        <p className={css.notice}>{t('loading')}</p>
      ) : (['custom', 'market'] as const).filter(group => needle === '' || skills.some(skill => skill.group === group)).map(group => (
        // Each search starts the group at its first page
        <InstalledGroup key={`${group}:${needle}`} group={group} skills={skills.filter(skill => skill.group === group)} props={props}
          selection={selection} onUninstall={(name) => { setUninstalling(name) }} />
      ))}
      <UninstallDialog
        name={uninstalling}
        label={uninstallLabel ?? uninstalling}
        t={t}
        onClose={() => { setUninstalling(undefined) }}
        onConfirm={(name) => {
          setUninstalling(undefined)
          void props.onUninstall(name)
        }}
      />
      <Modal
        open={confirmBatch !== undefined}
        title={t('batchUninstallTitle', { count: String(confirmBatch?.length ?? 0) })}
        // Every skill is named: select all also covers cards behind "load more"
        description={`${t('batchUninstallList', { names: (confirmBatch ?? []).map(shownName).join(t('listSeparator')) })}${t('batchUninstallDescription')}`}
        closeLabel={t('uninstallClose')}
        onClose={() => { setConfirmBatch(undefined) }}
        footer={confirmBatch !== undefined && (
          <div className={css.dialogActions}>
            <Button variant="outline" onClick={() => { setConfirmBatch(undefined) }}>{t('uninstallCancel')}</Button>
            <Button variant="primary" onClick={() => { setConfirmBatch(undefined); void runBatch('uninstall', confirmBatch) }}>{t('uninstallConfirm')}</Button>
          </div>
        )}
      />
    </div>
  )
}

/** The page's selection while bulk management is on. */
interface Selection {
  readonly has: (name: string) => boolean
  readonly set: (name: string, selected: boolean) => void
  /** A batch is running: selection and per-card controls are locked. */
  readonly running: boolean
}

function InstalledGroup({ group, skills: listed, props, selection, onUninstall }: {
  group: InstalledSkillGroup
  skills: readonly InstalledSkillView[]
  props: SkillsPageProps
  selection: Selection | undefined
  onUninstall: (name: string) => void
}) {
  const { t, useInstalled } = props
  const pinned = useInstalled(snapshot => snapshot.pinned)
  // Pinned cards first (most recently pinned first), the rest keep the list's name order
  const rank = (skill: InstalledSkillView) => pinned.indexOf(pinKey(skill))
  const skills = [...listed].sort((a, b) => rank(b) - rank(a))
  const [shown, setShown] = useState(PAGE_SIZE)
  const visible = skills.slice(0, shown)
  const remaining = skills.length - visible.length
  const titleId = `skills-${group}-group`
  return (
    <section className={css.group} aria-labelledby={titleId}>
      <h2 id={titleId} className={css.groupTitle}>
        {t(group === 'custom' ? 'customGroup' : 'marketGroup')}
        <Tag>{String(skills.length)}</Tag>
      </h2>
      {skills.length === 0 ? <p className={css.notice}>{t(group === 'custom' ? 'empty' : 'emptyMarket')}</p> : (
        <ul className={css.grid}>
          {visible.map(skill => (
            <SkillCard key={skill.name} skill={skill} props={props} pinned={rank(skill) >= 0} selection={selection}
              onUninstall={() => { onUninstall(skill.name) }} />
          ))}
          {remaining > 0 && (
            <li>
              <button type="button" className={css.loadMore} onClick={() => { setShown(count => count + PAGE_SIZE) }}>
                {t('loadMore', { count: String(remaining) })}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

/** Hub states that end a withdrawal: offered to the tenant again, or deleted (then usable like any unavailable Skill). */
const OFFERED: ReadonlySet<string | undefined> = new Set(['current', 'update', 'unavailable'])

/**
 * Whether an installed skill counts as withdrawn: the Hub check that runs when the page opens can
 * report a withdrawal (or its end) before the list is read again.
 * @param skill - the listed skill.
 * @param state - its market status, if any.
 * @returns true when withdrawn.
 */
function isWithdrawn(skill: InstalledSkillView, state: string | undefined): boolean {
  return state === 'withdrawn' || (skill.withdrawn && !OFFERED.has(state))
}

function SkillCard({ skill, props, pinned, selection, onUninstall }: {
  skill: InstalledSkillView
  props: SkillsPageProps
  pinned: boolean
  selection: Selection | undefined
  onUninstall: () => void
}) {
  // A running batch locks the selection; the card's own controls are hidden in bulk mode
  const locked = selection?.running === true
  const { t, useInstalled, useMarket, onToggle, onReveal, onEdit, onChat, onTogglePin } = props
  const busy = useInstalled(snapshot => snapshot.busy.includes(skill.name))
  // A market Skill shows the display name its Hub status carries; a user Skill has only its name
  const marketName = useMarket(snapshot => skill.group === 'market' ? snapshot.statuses[skill.name]?.displayName : undefined)
  const shown = marketName ?? skill.name
  const state = useMarket(snapshot => skill.group === 'market' ? snapshot.statuses[skill.name]?.state : undefined)
  const withdrawn = isWithdrawn(skill, state)
  const enabled = skill.enabled && !withdrawn
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <li className={css.card} data-enabled={enabled ? 'true' : 'false'}>
      <div className={css.cardHead}>
        {selection !== undefined && (
          <Checkbox className={css.select} labelHidden checked={selection.has(skill.name)} label={t('select', { name: shown })}
            disabled={locked} onChange={(next) => { selection.set(skill.name, next) }} />
        )}
        <span className={css.avatar} aria-hidden="true">{initial(shown)}</span>
        {shown === skill.name ? <span className={css.name}>{shown}</span> : (
          // The slug goes under the display name, so a long slug never squeezes the name out
          <span className={css.nameStack}>
            <span className={css.name}>{shown}</span>
            <span className={css.slug}>{skill.name}</span>
          </span>
        )}
        {/* Bulk mode keeps only the checkbox, so the name has the room */}
        {selection === undefined && (
          <>
            <Button
              size="sm"
              className={pinned ? css.pinned : css.pin}
              aria-label={t('pin', { name: shown })}
              aria-pressed={pinned}
              onClick={() => { onTogglePin(pinKey(skill), !pinned) }}
            >
              {pinned ? <IconPinFillRegular /> : <IconPinOutlineRegular />}
            </Button>
            <Menu
              open={menuOpen}
              onClose={() => { setMenuOpen(false) }}
              align="end"
              portal
              items={[
                { id: 'chat', label: t('chat'), icon: <IconNewChatOutlineRegular />, disabled: !enabled },
                { id: 'edit', label: t('edit'), icon: <IconEditOutlineRegular /> },
                { id: 'reveal', label: t('reveal'), icon: <IconFolderOpenOutlineRegular /> },
                { type: 'separator', id: 'separator' },
                { id: 'uninstall', label: t('uninstall'), icon: <IconTrashOutlineRegular />, danger: true },
              ]}
              onSelect={(id) => {
                setMenuOpen(false)
                if (id === 'chat') onChat(skill.name)
                else if (id === 'edit') void onEdit(skill.name)
                else if (id === 'reveal') void onReveal(skill.name)
                else onUninstall()
              }}
              anchor={(
                <Button
                  size="sm"
                  className={css.more}
                  aria-label={t('more', { name: shown })}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  disabled={busy}
                  onClick={() => { setMenuOpen(open => !open) }}
                >
                  <IconEllipsisOutlineRegular />
                </Button>
              )}
            />
            <Switch
              checked={enabled}
              label={t('toggle', { name: shown })}
              // A withdrawn Skill stays switched off until the platform offers it again
              disabled={busy || withdrawn}
              onChange={(next) => { void onToggle(skill.name, next) }}
            />
          </>
        )}
      </div>
      <p className={css.description}>{skill.description}</p>
      {withdrawn
        ? <span className={css.unavailable} data-testid="skill-withdrawn">{t('marketWithdrawn')}</span>
        : skill.group === 'market' && <MarketStatus name={skill.name} props={props} />}
    </li>
  )
}

function UninstallDialog({ name, label, t, onClose, onConfirm }: {
  name: string | undefined
  /** The name shown in the title: a market Skill's display name, otherwise its name. */
  label: string | undefined
  t: TranslateNS<'skills'>
  onClose: () => void
  onConfirm: (name: string) => void
}) {
  return (
    <Modal
      open={name !== undefined}
      title={t('uninstallTitle', { name: label ?? '' })}
      description={t('uninstallDescription')}
      closeLabel={t('uninstallClose')}
      onClose={onClose}
      footer={name !== undefined && (
        <div className={css.dialogActions}>
          <Button variant="outline" onClick={onClose}>{t('uninstallCancel')}</Button>
          <Button variant="primary" onClick={() => { onConfirm(name) }}>{t('uninstallConfirm')}</Button>
        </div>
      )}
    />
  )
}

/** A market Skill's Skill Hub state on its installed card: an update to take, or a Skill the Hub no longer offers. */
function MarketStatus({ name, props }: { name: string; props: SkillsPageProps }) {
  const { t, useMarket, onInstall } = props
  const status = useMarket(snapshot => snapshot.statuses[name])
  const installing = useMarket(snapshot => status !== undefined && snapshot.installing.includes(status.hubSkillId))
  if (status?.state === 'unavailable') return <span className={css.unavailable}>{t('marketUnavailable')}</span>
  if (status?.state !== 'update') return null
  return (
    <div className={css.statusRow}>
      <span className={css.meta}>{t('updateAvailable', { version: String(status.latestVersion) })}</span>
      <Button size="sm" variant="outline" disabled={installing} aria-label={t('update', { name: status.displayName })}
        onClick={() => { void onInstall(status.hubSkillId) }}>
        {installing ? t('installing') : t('updateButton')}
      </Button>
    </div>
  )
}
