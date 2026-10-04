/** The Skills page: installed skills as cards with an on/off switch and an actions menu. */

import { useEffect, useState } from 'react'
import type { InstalledSkillView } from '@deepseek-ai/dsh-skill-controller/types'
import {
  Button, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular,
  IconNewChatOutlineRegular, IconTrashOutlineRegular, Menu, Modal, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { InstalledSkillsInjected } from './installed-source.ts'
import css from './SkillsPage.module.css'

/** Cards shown per "load more" step. */
const PAGE_SIZE = 12

/** Props the page reads from its `main` registration: the translator and the installed-skill face. */
export type SkillsPageProps = PropsLocale<'skills'> & InjectFace<InstalledSkillsInjected>

/**
 * Render the installed-skill page and read the list when it mounts.
 * @param props - the `skills` translator and the installed-skill face.
 * @returns the page element.
 */
export function SkillsPage(props: SkillsPageProps) {
  const { t, useInstalled, onRefresh, onDismissFailure } = props
  const status = useInstalled(snapshot => snapshot.status)
  const skills = useInstalled(snapshot => snapshot.skills)
  const failure = useInstalled(snapshot => snapshot.failure)
  const [shown, setShown] = useState(PAGE_SIZE)
  const [uninstalling, setUninstalling] = useState<string>()

  useEffect(() => { void onRefresh() }, [onRefresh])

  const visible = skills.slice(0, shown)
  const remaining = skills.length - visible.length
  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('installedTitle')}</h1>
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
      ) : (
        <section className={css.group} aria-labelledby="skills-custom-group">
          <h2 id="skills-custom-group" className={css.groupTitle}>
            {t('customGroup')}
            <Tag>{String(skills.length)}</Tag>
          </h2>
          {skills.length === 0 ? <p className={css.notice}>{t('empty')}</p> : (
            <ul className={css.grid}>
              {visible.map(skill => (
                <SkillCard key={skill.name} skill={skill} props={props} onUninstall={() => { setUninstalling(skill.name) }} />
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
      )}
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
