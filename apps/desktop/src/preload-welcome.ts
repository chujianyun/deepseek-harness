import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
/** Localized welcome copy and user-center sign-in actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import { WELCOME_IPC, type WelcomeApi, type WelcomeNotice } from './welcome-api.ts'

const prefix = '--dsh-welcome-locale='
const locale = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
if (locale === undefined) throw new Error('desktop welcome: missing window locale')
const api: WelcomeApi = {
  ...resolveDesktopLocale(locale),
  analytics: async (eventName, attributes) => {
    if (await api.analyticsEnabled()) await ipcRenderer.invoke(WELCOME_IPC.analytics, eventName, attributes)
  },
  analyticsEnabled: () => ipcRenderer.invoke(WELCOME_IPC.analyticsEnabled) as Promise<boolean>,
  takeNotice: () => ipcRenderer.invoke(WELCOME_IPC.takeNotice) as Promise<WelcomeNotice | undefined>,
  startSignIn: () => ipcRenderer.invoke(WELCOME_IPC.start) as Promise<HubAccountView>,
  cancelSignIn: (id: string) => ipcRenderer.invoke(WELCOME_IPC.cancel, id) as Promise<HubAccountView>,
  copySignInLink: (id: string) => ipcRenderer.invoke(WELCOME_IPC.copyLink, id) as Promise<void>,
  onAccountState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: HubAccountView): void => { listener(state) }
    ipcRenderer.on(WELCOME_IPC.state, receive)
    return () => { ipcRenderer.removeListener(WELCOME_IPC.state, receive) }
  },
}
contextBridge.exposeInMainWorld('dshWelcome', api)
