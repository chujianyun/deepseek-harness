/** The Connectors page: one card per built-in connector, with its install control or status in the top-right corner. */

import { useState } from 'react'
import type { ConnectorView } from '@deepseek-ai/dsh-connectors/types'
import {
  Button, IconEllipsisOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular, Menu, Modal, StateDot, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectorsInjected } from './connectors-source.ts'
import css from './ConnectorsPage.module.css'

/** Props the page reads from its `main` registration: the translator and the connectors face. */
export type ConnectorsPageProps = PropsLocale<'connectors'> & InjectFace<ConnectorsInjected>

type T = TranslateNS<'connectors'>

/**
 * Render the connector cards and the uninstall confirmation.
 * @param props - the `connectors` translator and the connectors face.
 * @returns the page.
 */
export function ConnectorsPage(props: ConnectorsPageProps) {
  const { t, useConnectors, onDismiss, onUninstall } = props
  const state = useConnectors(snapshot => snapshot.state)
  const failure = useConnectors(snapshot => snapshot.failure)
  const [uninstalling, setUninstalling] = useState<ConnectorView | undefined>(undefined)
  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <p className={css.intro}>{t('intro')}</p>
      </header>
      {failure !== null && (
        <div className={css.alert} role="alert">
          <span>{t('actionFailed', { message: failure })}</span>
          <Button variant="ghost" onClick={onDismiss}>{t('close')}</Button>
        </div>
      )}
      {state !== undefined && (
        <ul className={css.grid}>
          {state.connectors.map(connector => (
            <ConnectorCard key={connector.id} connector={connector} props={props} onUninstall={() => { setUninstalling(connector) }} />
          ))}
        </ul>
      )}
      <Modal
        open={uninstalling !== undefined}
        title={uninstalling === undefined ? '' : t('uninstallTitle', { name: t(`name.${uninstalling.id}`) })}
        description={t('uninstallDescription', { cli: uninstalling?.cli ?? '' })}
        closeLabel={t('close')}
        onClose={() => { setUninstalling(undefined) }}
        footer={uninstalling !== undefined && (
          <div className={css.dialogActions}>
            <Button variant="outline" onClick={() => { setUninstalling(undefined) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => { setUninstalling(undefined); void onUninstall(uninstalling.id) }}>
              {t('uninstallConfirm')}
            </Button>
          </div>
        )}
      />
    </div>
  )
}

function ConnectorCard({ connector, props, onUninstall }: {
  connector: ConnectorView
  props: ConnectorsPageProps
  onUninstall: () => void
}) {
  const { t } = props
  const name = t(`name.${connector.id}`)
  return (
    <li className={css.card} data-status={connector.status}>
      <div className={css.cardHead}>
        <span className={css.avatar} aria-hidden="true">{name.slice(0, 1)}</span>
        <span className={css.name}>{name}</span>
        <Corner connector={connector} name={name} props={props} onUninstall={onUninstall} />
      </div>
      <p className={css.description}>{t(`description.${connector.id}`)}</p>
      <Footer connector={connector} t={t} />
    </li>
  )
}

/** The card's top-right corner: install button, progress, status dot, or a label for a connector that cannot be installed. */
function Corner({ connector, name, props, onUninstall }: {
  connector: ConnectorView
  name: string
  props: ConnectorsPageProps
  onUninstall: () => void
}) {
  const { t, useConnectors, onInstall } = props
  const busy = useConnectors(snapshot => snapshot.busy.includes(connector.id))
  const [menuOpen, setMenuOpen] = useState(false)
  switch (connector.status) {
    case 'coming-soon':
    case 'unsupported':
      return <Tag tone="neutral">{t(`status.${connector.status}`)}</Tag>
    case 'not-installed':
      return (
        <Button size="sm" variant="outline" className={css.corner} aria-label={t('install', { name })} disabled={busy}
          onClick={() => { void onInstall(connector.id) }}>
          <IconPlusOutlineRegular />
        </Button>
      )
    case 'installing':
      return <span className={css.corner} role="status" aria-label={t('installing', { name })}><StateDot state="ongoing" /></span>
    case 'disconnected':
      return (
        <span className={css.corner}>
          <span className={css.status}><StateDot state="error" />{t('status.disconnected')}</span>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            align="end"
            portal
            items={[{ id: 'uninstall', label: t('uninstall'), icon: <IconTrashOutlineRegular />, danger: true }]}
            onSelect={() => { setMenuOpen(false); onUninstall() }}
            anchor={(
              <Button size="sm" aria-label={t('more', { name })} aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy}
                onClick={() => { setMenuOpen(open => !open) }}>
                <IconEllipsisOutlineRegular />
              </Button>
            )}
          />
        </span>
      )
  }
}

/** The card's last line: the pinned CLI, download progress while installing, or why the last install failed. */
function Footer({ connector, t }: { connector: ConnectorView; t: T }) {
  if (connector.cli === null || connector.version === null) return null
  const cli = connector.cli
  if (connector.status === 'installing') {
    const percent = connector.totalBytes === 0 ? 0 : Math.floor(connector.receivedBytes * 100 / connector.totalBytes)
    return (
      <div className={css.progress}>
        <progress max={100} value={percent} aria-label={t('installing', { name: t(`name.${connector.id}`) })} />
        <span>{percent >= 100 ? t('checking') : t('downloading', { percent: String(percent) })}</span>
      </div>
    )
  }
  return (
    <>
      {connector.error !== null && <p className={css.error} role="alert">{t(`error.${connector.error}`, { cli })}</p>}
      <p className={css.meta}>{t('cliVersion', { cli, version: connector.version })}</p>
    </>
  )
}
