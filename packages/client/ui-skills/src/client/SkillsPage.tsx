/** The Skills page: the Skill Hub market, and the installed Skills as cards with an on/off switch and an actions menu. */

import { useEffect, useState } from 'react'
import type { InstalledSkillGroup, InstalledSkillView } from '@deepseek-ai/dsh-skill-controller/types'
import {
  Button, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular,
  IconNewChatOutlineRegular, IconTrashOutlineRegular, Menu, Modal, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { InstalledSkillsInjected } from './installed-source.ts'
import type { MarketInjected } from './market-source.ts'
import type { UploadInjected } from './upload-source.ts'
import { AddSkillDialog } from './AddSkillDialog.tsx'
import { MarketView } from './MarketView.tsx'
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
  return (
    <Modal
      open={pending !== null}
      title={t('overwriteTitle')}
      description={t('overwriteDescription', { name: pending?.name ?? '' })}
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
  const skills = useInstalled(snapshot => snapshot.skills)
  const failure = useInstalled(snapshot => snapshot.failure)
  const [uninstalling, setUninstalling] = useState<string>()

  useEffect(() => {
    void onRefresh()
    void props.onRefreshStatus()
  }, [onRefresh, props.onRefreshStatus])

  return (
    <div className={css.page}>
      <header className={css.header}>
        <div className={css.headerRow}>
          <h1 className={css.title}>{t('installedTitle')}</h1>
          <Button size="sm" variant="outline" onClick={onBack}>{t('backToMarket')}</Button>
        </div>
        <p className={css.intro}>{t('installedIntro')}</p>
      </header>
      {failure !== null && (
        <div className={css.failure} role="alert">
          <span>{t('actionFailed', { message: failure })}</span>
          <Button size="sm" variant="ghost" onClick={onDismissFailure}>{t('uninstallClose')}</Button>
        </div>
      )}
      {status === 'error' && skills.length === 0 ? (
        <div className={css.notice}>
          <span>{t('error')}</span>
          <Button size="sm" variant="outline" onClick={() => { void onRefresh() }}>{t('retry')}</Button>
        </div>
      ) : status === 'loading' && skills.length === 0 ? (
        <p className={css.notice}>{t('loading')}</p>
      ) : (['custom', 'market'] as const).map(group => (
        <InstalledGroup key={group} group={group} skills={skills.filter(skill => skill.group === group)} props={props}
          onUninstall={(name) => { setUninstalling(name) }} />
      ))}
      <UninstallDialog
        name={uninstalling}
        t={t}
        onClose={() => { setUninstalling(undefined) }}
        onConfirm={(name) => {
          setUninstalling(undefined)
          void props.onUninstall(name)
        }}
      />
    </div>
  )
}

function InstalledGroup({ group, skills, props, onUninstall }: {
  group: InstalledSkillGroup
  skills: readonly InstalledSkillView[]
  props: SkillsPageProps
  onUninstall: (name: string) => void
}) {
  const { t } = props
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
            <SkillCard key={skill.name} skill={skill} props={props} onUninstall={() => { onUninstall(skill.name) }} />
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

function SkillCard({ skill, props, onUninstall }: {
  skill: InstalledSkillView
  props: SkillsPageProps
  onUninstall: () => void
}) {
  const { t, useInstalled, onToggle, onReveal, onEdit, onChat } = props
  const busy = useInstalled(snapshot => snapshot.busy.includes(skill.name))
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <li className={css.card} data-enabled={skill.enabled ? 'true' : 'false'}>
      <div className={css.cardHead}>
        <span className={css.avatar} aria-hidden="true">{skill.name.slice(0, 1).toUpperCase()}</span>
        <span className={css.name}>{skill.name}</span>
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          portal
          items={[
            { id: 'chat', label: t('chat'), icon: <IconNewChatOutlineRegular />, disabled: !skill.enabled },
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
              aria-label={t('more', { name: skill.name })}
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
          checked={skill.enabled}
          label={t('toggle', { name: skill.name })}
          disabled={busy}
          onChange={(next) => { void onToggle(skill.name, next) }}
        />
      </div>
      <p className={css.description}>{skill.description}</p>
      {skill.group === 'market' && <MarketStatus name={skill.name} props={props} />}
    </li>
  )
}

function UninstallDialog({ name, t, onClose, onConfirm }: {
  name: string | undefined
  t: TranslateNS<'skills'>
  onClose: () => void
  onConfirm: (name: string) => void
}) {
  return (
    <Modal
      open={name !== undefined}
      title={t('uninstallTitle', { name: name ?? '' })}
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
      <Button size="sm" variant="outline" disabled={installing} aria-label={t('update', { name })}
        onClick={() => { void onInstall(status.hubSkillId) }}>
        {installing ? t('installing') : t('updateButton')}
      </Button>
    </div>
  )
}
