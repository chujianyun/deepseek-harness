/**
 * The Connectors page: one card per built-in connector, with its install control or connection
 * status in the top-right corner, the sign-in dialog, and the disconnect and uninstall confirmations.
 */

import { useEffect, useState } from 'react'
import type { ConnectorId, ConnectorLoginStep, ConnectorView } from '@deepseek-ai/dsh-connectors/types'
import {
  Button, IconEllipsisOutlineRegular, IconPlusOutlineRegular, Menu, Modal, StateDot, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectorsInjected } from './connectors-source.ts'
import type { ConnectorsLocaleKey } from './locales.ts'
import css from './ConnectorsPage.module.css'

/** Props the page reads from its `main` registration: the translator and the connectors face. */
export type ConnectorsPageProps = PropsLocale<'connectors'> & InjectFace<ConnectorsInjected>

type T = TranslateNS<'connectors'>

/** The dialog text and list label of one sign-in step. */
interface StepCopy {
  readonly description: ConnectorsLocaleKey
  readonly label: ConnectorsLocaleKey
}

const DINGTALK_AUTHORIZE: StepCopy = { description: 'login.dingtalk.authorize', label: 'loginStep.dingtalk.authorize' }

/** Each connector's sign-in steps. DingTalk signs in with its own app in one step, so it never creates one. */
const LOGIN_COPY: Record<ConnectorId, Record<ConnectorLoginStep, StepCopy>> = {
  feishu: {
    'create-app': { description: 'login.feishu.create-app', label: 'loginStep.feishu.create-app' },
    authorize: { description: 'login.feishu.authorize', label: 'loginStep.feishu.authorize' },
  },
  dingtalk: { 'create-app': DINGTALK_AUTHORIZE, authorize: DINGTALK_AUTHORIZE },
}

/** A confirmation the page is asking for. */
type Confirming = { readonly action: 'uninstall' | 'disconnect'; readonly connector: ConnectorView }

/**
 * Render the connector cards, the sign-in dialog of a connector being connected, and the confirmations.
 * Opening the page checks every connection.
 * @param props - the `connectors` translator and the connectors face.
 * @returns the page.
 */
export function ConnectorsPage(props: ConnectorsPageProps) {
  const { t, useConnectors, onDismiss, onCheck } = props
  const state = useConnectors(snapshot => snapshot.state)
  const failure = useConnectors(snapshot => snapshot.failure)
  const [confirming, setConfirming] = useState<Confirming | undefined>(undefined)
  useEffect(() => { void onCheck() }, [onCheck])
  const connecting = state?.connectors.find(connector => connector.status === 'connecting')
  return (
    <div className={css.page}>
      <header className={css.header} data-window-drag>
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
            <ConnectorCard
              key={connector.id} connector={connector} props={props}
              onConfirm={(action) => { setConfirming({ action, connector }) }}
            />
          ))}
        </ul>
      )}
      {connecting !== undefined && <LoginDialog connector={connecting} props={props} />}
      <ConfirmDialog confirming={confirming} props={props} onClose={() => { setConfirming(undefined) }} />
    </div>
  )
}

function ConnectorCard({ connector, props, onConfirm }: {
  connector: ConnectorView
  props: ConnectorsPageProps
  onConfirm: (action: Confirming['action']) => void
}) {
  const { t } = props
  const name = t(`name.${connector.id}`)
  return (
    <li className={css.card} data-status={connector.status} data-enabled={connector.enabled ? 'true' : 'false'}>
      <div className={css.cardHead}>
        <span className={css.avatar} aria-hidden="true">{name.slice(0, 1)}</span>
        <span className={css.name}>{name}</span>
        <Corner connector={connector} name={name} props={props} onConfirm={onConfirm} />
      </div>
      <p className={css.description}>{t(`description.${connector.id}`)}</p>
      <Skills connector={connector} t={t} />
      <AlwaysAllowed connector={connector} props={props} />
      <Footer connector={connector} t={t} />
    </li>
  )
}

/** The dot and word of a connection status. */
const DOTS = { disconnected: 'error', connected: 'done', degraded: 'warning' } as const

/**
 * The card's top-right corner: install button, progress, connection status with its actions, or a label
 * for a connector that cannot be installed.
 */
function Corner({ connector, name, props, onConfirm }: {
  connector: ConnectorView
  name: string
  props: ConnectorsPageProps
  onConfirm: (action: Confirming['action']) => void
}) {
  const { t, useConnectors, onInstall, onConnect, onCheck, onSetEnabled } = props
  const busy = useConnectors(snapshot => snapshot.busy.includes(connector.id))
  switch (connector.status) {
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
    case 'connecting':
      return (
        <span className={css.corner} role="status" aria-label={t('connecting', { name })}>
          <span className={css.status}><StateDot state="ongoing" />{t('status.connecting')}</span>
        </span>
      )
    default: {
      const { status } = connector
      const actions: { id: 'connect' | 'check' | 'disconnect' | 'uninstall'; label: string; danger?: true }[] = [
        ...status === 'connected' ? [] : [{ id: 'connect' as const, label: t(status === 'degraded' ? 'reconnect' : 'connect') }],
        ...status === 'disconnected' ? [] : [{ id: 'check' as const, label: t('check') }, { id: 'disconnect' as const, label: t('disconnect') }],
        { id: 'uninstall', label: t('uninstall'), danger: true },
      ]
      return (
        <span className={css.corner}>
          <span className={css.status} data-status={status}><StateDot state={DOTS[status]} />{t(`status.${status}`)}</span>
          {status === 'disconnected' && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { void onConnect(connector.id) }}>{t('connect')}</Button>
          )}
          <ActionsMenu name={name} t={t} busy={busy} actions={actions} onSelect={(id) => {
            if (id === 'connect') void onConnect(connector.id)
            else if (id === 'check') void onCheck()
            else onConfirm(id)
          }} />
          <Switch checked={connector.enabled} label={t('enable', { name })} disabled={busy}
            onChange={(next) => { void onSetEnabled(connector.id, next) }} />
        </span>
      )
    }
  }
}

function ActionsMenu<Id extends string>({ name, t, busy, actions, onSelect }: {
  name: string
  t: T
  busy: boolean
  actions: readonly { id: Id; label: string; danger?: true }[]
  onSelect: (id: Id) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      align="end"
      portal
      items={actions.map(action => ({ id: action.id, label: action.label, ...action.danger === undefined ? {} : { danger: true } }))}
      onSelect={(id) => { setOpen(false); onSelect(id as Id) }}
      anchor={(
        <Button size="sm" aria-label={t('more', { name })} aria-haspopup="menu" aria-expanded={open} disabled={busy}
          onClick={() => { setOpen(value => !value) }}>
          <IconEllipsisOutlineRegular />
        </Button>
      )}
    />
  )
}

/** Shown Skill names before the rest collapse into a count. */
const SHOWN_SKILLS = 8

/** The Skills the connector gives the model, once its CLI listed them; the description is each one's tooltip. */
function Skills({ connector, t }: { connector: ConnectorView; t: T }) {
  const [all, setAll] = useState(false)
  if (connector.skills.length === 0 || connector.status === 'installing') return null
  const shown = all ? connector.skills : connector.skills.slice(0, SHOWN_SKILLS)
  const rest = connector.skills.length - shown.length
  return (
    <div className={css.skills} aria-label={t('skills', { count: String(connector.skills.length) })}>
      <span className={css.skillsLabel}>{t('skills', { count: String(connector.skills.length) })}</span>
      {shown.map(skill => <span key={skill.name} className={css.skill} title={skill.description}>{skill.name}</span>)}
      {rest > 0 && <button type="button" className={css.more} onClick={() => { setAll(true) }}>{t('skillsMore', { count: String(rest) })}</button>}
    </div>
  )
}

/** The write commands the current company always allows through the connector, each with a way to revoke it. */
function AlwaysAllowed({ connector, props }: { connector: ConnectorView; props: ConnectorsPageProps }) {
  const { t, useConnectors, onRevokeAlwaysAllowed } = props
  const busy = useConnectors(snapshot => snapshot.busy.includes(connector.id))
  if (connector.alwaysAllowed.length === 0) return null
  return (
    <div className={css.allowed}>
      <span className={css.allowedLabel} title={t('alwaysAllowedHint')}>{t('alwaysAllowed')}</span>
      <ul className={css.allowedList} aria-label={t('alwaysAllowed')}>
        {connector.alwaysAllowed.map((command) => {
          const full = `${connector.cli} ${command}`
          return (
            <li key={command} className={css.allowedItem}>
              <code>{full}</code>
              <button type="button" className={css.more} disabled={busy} aria-label={t('revoke', { command: full })}
                onClick={() => { void onRevokeAlwaysAllowed(connector.id, command) }}>
                {t('revokeLabel')}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The card's last lines: download progress while installing, the signed-in account, why something failed, and the pinned CLI. */
function Footer({ connector, t }: { connector: ConnectorView; t: T }) {
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
      {connector.account !== null && <p className={css.account}>{t('account', { account: connector.account })}</p>}
      {!connector.enabled && <p className={css.meta}>{t('disabledHint', { name: t(`name.${connector.id}`) })}</p>}
      {connector.problem !== null && <p className={css.warning} role="alert">{t('problem', { problem: connector.problem })}</p>}
      {connector.loginError !== null && connector.status !== 'connecting' && (
        <p className={css.error} role="alert">{t(`loginError.${connector.loginError.step}`, { message: connector.loginError.message })}</p>
      )}
      {connector.error !== null && <p className={css.error} role="alert">{t(`error.${connector.error}`, { cli })}</p>}
      <p className={css.meta}>{t('cliVersion', { cli, version: connector.version })}</p>
    </>
  )
}

/** The sign-in under way: its two steps, the current step's QR code and address, and Cancel. */
function LoginDialog({ connector, props }: { connector: ConnectorView; props: ConnectorsPageProps }) {
  const { t, onCancelConnect, onOpenUrl } = props
  const name = t(`name.${connector.id}`)
  const step = connector.login?.step ?? 'authorize'
  const steps = connector.login?.steps ?? []
  const url = connector.login?.url ?? null
  const qrCode = connector.login?.qrCode ?? null
  const cancel = (): void => { void onCancelConnect(connector.id) }
  return (
    <Modal
      open
      title={t('loginTitle', { name })}
      description={t(LOGIN_COPY[connector.id][step].description)}
      closeLabel={t('loginCancel')}
      onClose={cancel}
      footer={(
        <div className={css.dialogActions}>
          <Button variant="outline" onClick={cancel}>{t('loginCancel')}</Button>
        </div>
      )}
    >
      {steps.length > 1 && (
        <ol className={css.steps}>
          {steps.map((item, index) => (
            <li key={item} aria-current={item === step ? 'step' : undefined}>
              {t('loginStep', { index: String(index + 1), label: t(LOGIN_COPY[connector.id][item].label) })}
            </li>
          ))}
        </ol>
      )}
      {url === null
        ? <p className={css.waiting} role="status"><StateDot state="ongoing" />{t('loginPreparing')}</p>
        : (
          <div className={css.login}>
            {qrCode === null
              ? <div className={css.qrMissing}>{t('loginNoQr')}</div>
              : <img className={css.qr} src={qrCode} alt={t('loginQr', { name })} width={200} height={200} />}
            <p className={css.hint}>{t('loginHint', { name })}</p>
            <Button variant="primary" onClick={() => { onOpenUrl(url) }}>{t('loginOpen')}</Button>
            <p className={css.url}>{url}</p>
          </div>
        )}
    </Modal>
  )
}

function ConfirmDialog({ confirming, props, onClose }: {
  confirming: Confirming | undefined
  props: ConnectorsPageProps
  onClose: () => void
}) {
  const { t, onUninstall, onDisconnect } = props
  const name = confirming === undefined ? '' : t(`name.${confirming.connector.id}`)
  const cli = confirming?.connector.cli ?? ''
  const action = confirming?.action ?? 'uninstall'
  return (
    <Modal
      open={confirming !== undefined}
      title={t(`${action}Title`, { name })}
      description={t(`${action}Description`, { cli, name })}
      closeLabel={t('close')}
      onClose={onClose}
      footer={confirming !== undefined && (
        <div className={css.dialogActions}>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => {
            onClose()
            void (action === 'uninstall' ? onUninstall : onDisconnect)(confirming.connector.id)
          }}>
            {t(`${action}Confirm`)}
          </Button>
        </div>
      )}
    />
  )
}
