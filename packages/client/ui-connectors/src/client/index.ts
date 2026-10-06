/**
 * Connectors page, browser half: the **Connectors** entry of the Desktop sidebar and the page it
 * opens in the main column, where each built-in connector's CLI is installed, the signed-in
 * tenant connects and disconnects it, and its connection status shows. State streams from the
 * `connectors` Remote.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ConnectorsState } from '@deepseek-ai/dsh-connectors/types'
import { createConnectorsSource } from './connectors-source.ts'
import { ConnectorsPage } from './ConnectorsPage.tsx'
import { ConnectorsPanelIcon } from './ConnectorsPanelIcon.tsx'
import { en, zh, type ConnectorsLocaleKey } from './locales.ts'

export type { ConnectorsDependencies, ConnectorsInjected, ConnectorsSnapshot } from './connectors-source.ts'
export type { ConnectorsLocaleKey } from './locales.ts'
export type { ConnectorsPageProps } from './ConnectorsPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Connectors page copy. */
    'connectors': ConnectorsLocaleKey
  }
}

const NS = 'connectors'
const PANEL_ID = 'connectors' as MainPanelId

/** Services the page reads: the `connectors` Remote and the layout slots. */
export const inject = ['slots', 'locale', 'remote', 'remote.connectors']

/**
 * Contribute the Connectors sidebar entry, below Knowledge, and the page it opens, in the Desktop renderer.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: connector CLIs are installed on this machine.
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-connectors: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.connectors
  const source = createConnectorsSource({
    install: id => remote.installConnector(id),
    uninstall: id => remote.uninstallConnector(id),
    connect: id => remote.connect(id),
    cancelConnect: id => remote.cancelConnect(id),
    disconnect: id => remote.disconnect(id),
    check: () => remote.check(),
    // The Desktop shell sends a new window's http(s) address to the default browser.
    openUrl: (url) => { globalThis.open(url, '_blank', 'noopener') },
  })
  const connectors = ctx.remote.$stream<ConnectorsState>({
    name: 'connectors', open: signal => remote.watch(signal), ended: () => new Error('connectors stream ended'),
  })
  ctx.effect(() => () => { void connectors.dispose() }, 'ui-connectors: state stream')
  void (async () => {
    for await (const frame of connectors) { source.publish(frame.value); frame.accept() }
  })().catch(() => {
    // The stream reconnects on its own; a disposed plugin simply stops listening.
  })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => source }, ConnectorsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 7, label: () => t('panel'), locale: NS,
  }, ConnectorsPanelIcon))
}
