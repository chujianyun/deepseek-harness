vi.mock('../src/web-document.ts', () => ({ authenticateWebHost: async () => 'test-cookie', serveWebDocument: vi.fn(), forwardWebRequest: vi.fn() }))
/** Welcome startup uses the Host before transitioning to the workspace. */

import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { DesktopLocale } from '../src/locale.ts'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import type { WelcomeOperations } from '../src/welcome-api.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const state = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  dialogLocale: undefined as (() => DesktopLocale) | undefined,
  beforeRead: vi.fn(async () => {}),
  beforeWelcome: vi.fn(async () => {}),
  copy: vi.fn(),
  openExternal: vi.fn(async () => {}),
  hubListener: undefined as ((value: HubAccountView) => void) | undefined,
  hubState: vi.fn<() => Promise<HubAccountView>>().mockResolvedValue({ status: 'signed-out', profile: null, reason: null, attempt: null, branding: null }),
  hubStart: vi.fn<() => Promise<HubAccountView>>(),
  hubCancel: vi.fn<(id: string) => Promise<HubAccountView>>(),
  quit: vi.fn(),
  startHost: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:3080/?token=test', injections: [] }),
  stopHost: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  loadWorkspace: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  showWorkspace: vi.fn(),
  showInactiveWorkspace: vi.fn(),
  focusWorkspace: vi.fn(),
  moveTopWorkspace: vi.fn(),
  openDevTools: vi.fn(),
  closeWelcome: vi.fn(),
  focusWelcome: vi.fn(),
  welcomeLocale: undefined as DesktopLocale | undefined,
  preference: 'zh',
  hasApiKey: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  contents: undefined as { mainFrame: { url: string } } | undefined,
  windowOptions: undefined as BrowserWindowConstructorOptions | undefined,
  menu: vi.fn(),
  operations: undefined as WelcomeOperations | undefined,
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
}))

vi.mock('../src/crash-report.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/crash-report.ts')>(),
  writeCrashReport: vi.fn(async () => undefined),
  pruneCrashReports: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  clipboard: { writeText: state.copy },
  shell: { openExternal: state.openExternal },
  app: {
    isPackaged: false,
    name: 'Harness',
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en',
    getVersion: () => '1.0.0',
    setAboutPanelOptions: vi.fn(),
    getAppPath: () => '/development-app',
    getPath: (name: string) => name === 'userData' ? '/desktop-user-data' : `/development-${name}`,
    setAppLogsPath: vi.fn(),
    getPreferredSystemLanguages: () => ['en-US'],
    on: (name: string, callback: (...args: unknown[]) => void) => { state.appListeners.set(name, callback) },
    quit: state.quit,
    exit: vi.fn(),
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) { state.windowOptions = options }
    private ready: (() => void) | undefined
    webContents = { mainFrame: { url: 'dsh-app://app/' }, setWindowOpenHandler: vi.fn(),
      on: vi.fn(), once: vi.fn(), send: vi.fn(), openDevTools: state.openDevTools }
    static getAllWindows() { return [] }
    once(name: string, callback: () => void) { if (name === 'ready-to-show') this.ready = callback; return this }
    on() { return this }
    isDestroyed() { return false }
    isMinimized() { return false }
    restore = vi.fn()
    focus = state.focusWorkspace
    moveTop = state.moveTopWorkspace
    hide = vi.fn()
    show = state.showWorkspace
    showInactive = state.showInactiveWorkspace
    async loadURL(url: string) { state.contents = this.webContents; await state.loadWorkspace(url); this.ready?.() }
  },
  net: { fetch: vi.fn() },
  nativeTheme: state.nativeTheme,
  session: { defaultSession: {
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn() },
  } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) => { state.handlers.set(name, callback) },
    on: (name: string, callback: (...args: unknown[]) => void) => { state.listeners.set(name, callback) },
  },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: state.menu, setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: (path: string) => ({ path }) },
}))
// The Windows tray relabels through Menu as well; keep the menu call counts below platform-neutral.
vi.mock('../src/tray.ts', () => ({ DesktopTray: class { relabel() {} dispose() {} } }))

vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: '/profile' }) }))
vi.mock('../src/login-shell-environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/login-shell-environment.ts')>(),
  readDesktopLoginShellEnvironment: async (base: NodeJS.ProcessEnv) => ({ environment: base, failures: [] }),
}))
vi.mock('../src/project-manager.ts', () => ({ DesktopProjectManager: class {
  applyRelease = vi.fn(async () => {})
  canRecoverProfile = vi.fn(() => true)
} }))
vi.mock('../src/host-process.ts', () => ({
  DesktopHostProcess: class {
    start = state.startHost
    stop = state.stopHost
    fetch() {
      return Promise.resolve(Response.json({}))
    }
  },
}))
vi.mock('../src/welcome-backend.ts', () => ({
  connectDesktopWelcome: async () => ({
    analyticsEnabled: async () => false,
    readLocalePreference: async () => state.preference,
    read: async () => {
      await state.beforeRead()
      return { hub: await state.hubState(), localePreference: state.preference }
    },
    hasApiKey: async () => state.hasApiKey,
    hub: {
      watch: (listener: (value: HubAccountView) => void) => {
        state.hubListener = listener
        return () => {}
      },
      state: state.hubState,
      start: state.hubStart,
      cancel: state.hubCancel,
    },
  }),
}))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async () => '{}'),
}))
vi.mock('../src/update-dialog.ts', () => ({ DesktopUpdateDialog: class {
  constructor(_preload: string, locale: () => DesktopLocale) { state.dialogLocale = locale }
  dispose() {}
} }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: class {
  state = { phase: 'idle' }
  check = vi.fn(async () => this.state)
  dispose = vi.fn()
} }))
vi.mock('../src/welcome-window.ts', () => ({
  openWelcomeWindow: async (locale: DesktopLocale, operations: WelcomeOperations) => {
    state.welcomeLocale = locale
    state.operations = operations
    await state.beforeWelcome()
    return { once: vi.fn(), close: state.closeWelcome, isDestroyed: () => false, isMinimized: () => false,
      show: vi.fn(), focus: state.focusWelcome, webContents: { send: vi.fn() } }
  },
}))

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([false, true])('opens the workspace only after a user-center sign-in and returns to welcome when it ends (Windows update=%s)', async (updated) => {
  vi.resetModules()
  vi.clearAllMocks()
  state.preference = 'zh'
  state.hasApiKey = false
  state.operations = undefined
  state.hubState.mockResolvedValue({ status: 'signed-out', profile: null, reason: null, attempt: null, branding: null })
  if (updated) vi.stubGlobal('process', { ...process, platform: 'win32', argv: ['desktop', '--updated'] })
  vi.useFakeTimers()
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', '/development-profile')
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', '/runtime/node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', '/runtime/pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', '/runtime/dsh')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', '/runtime/primary-runtime')
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '0')
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
  const reading = Promise.withResolvers<undefined>()
  const loading = Promise.withResolvers<undefined>()
  state.beforeRead.mockReturnValueOnce(reading.promise)
  state.beforeWelcome.mockReturnValueOnce(loading.promise)
  const activate = () => {
    state.appListeners.get('second-instance')!()
    state.appListeners.get('open-url')!({ preventDefault: vi.fn() }, 'dsh://open')
  }
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.beforeRead).toHaveBeenCalledOnce() })
  try {
    activate()
    expect(state.showWorkspace).not.toHaveBeenCalled()
    reading.resolve(undefined)
    await vi.waitFor(() => { expect(state.beforeWelcome).toHaveBeenCalledOnce() })
    activate()
    expect(state.showWorkspace).not.toHaveBeenCalled()
  } finally {
    reading.resolve(undefined)
    loading.resolve(undefined)
  }
  await vi.waitFor(() => { expect(state.operations).toBeDefined() })
  expect(state.startHost).toHaveBeenCalledOnce()
  expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('dsh-app://app/')
  expect(state.showWorkspace).not.toHaveBeenCalled()
  state.loadWorkspace.mockClear()
  expect(state.welcomeLocale).toMatchObject({ id: 'zh-CN' })
  expect(await state.operations!.takeNotice()).toBeUndefined()
  expect(state.dialogLocale!().id).toBe('zh-CN')
  const signedOut: HubAccountView = { status: 'signed-out', profile: null, reason: null, attempt: null, branding: null }
  const profile = { nickname: '李雷', phone: '138****0001', tenantId: 't-a', tenantName: '甲公司', isTenantAdmin: false }
  const signedIn: HubAccountView = { status: 'signed-in', profile, reason: null, attempt: null, branding: null }
  const waiting: HubAccountView = { ...signedOut, attempt: { id: 'login', phase: 'waiting-browser', authorizeUrl: 'https://hub.example/oauth/authorize?x' } }

  // The welcome window's own attempt opens in the system browser once, whichever of the reply and the stream comes first.
  state.hubStart.mockResolvedValue(waiting)
  expect(await state.operations!.startSignIn()).toEqual(waiting)
  state.hubListener!(waiting)
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith('https://hub.example/oauth/authorize?x')
  state.hubState.mockResolvedValue(waiting)
  await state.operations!.copySignInLink('login')
  expect(state.copy).toHaveBeenCalledExactlyOnceWith('https://hub.example/oauth/authorize?x')
  await expect(state.operations!.copySignInLink('stale')).rejects.toThrow('login link is unavailable')
  state.hubState.mockResolvedValue({ ...signedOut, attempt: { id: 'login', phase: 'failed', error: 'expired' } })
  await expect(state.operations!.copySignInLink('login')).rejects.toThrow('login link is unavailable')
  expect(state.copy).toHaveBeenCalledOnce()
  // An attempt the workspace started is opened by the workspace, not here.
  state.hubListener!({ ...signedOut, attempt: { id: 'other', phase: 'waiting-browser', authorizeUrl: 'https://hub.example/other' } })
  expect(state.openExternal).toHaveBeenCalledOnce()
  // A failed attempt shown in Welcome brings DSH back to the front once per attempt.
  state.focusWelcome.mockClear()
  state.hubListener!({ ...signedOut, attempt: { id: 'login', phase: 'failed', error: 'denied' } })
  state.hubListener!({ ...signedOut, attempt: { id: 'login', phase: 'failed', error: 'denied' } })
  expect(state.focusWelcome).toHaveBeenCalledOnce()
  state.hubListener!({ ...signedOut, attempt: { id: 'other', phase: 'failed', error: 'expired' } })
  expect(state.focusWelcome).toHaveBeenCalledTimes(2)
  // A start that fails to reach the Host names no attempt, so a later workspace attempt is not opened here.
  state.hubStart.mockRejectedValueOnce(new Error('Host restarting'))
  await expect(state.operations!.startSignIn()).rejects.toThrow('Host restarting')
  state.hubListener!({ ...signedOut, attempt: { id: 'switch', phase: 'waiting-browser', authorizeUrl: 'https://hub.example/switch' } })
  expect(state.openExternal).toHaveBeenCalledOnce()

  // Signing in opens the workspace without stealing focus from the browser.
  state.hubListener!({ ...signedIn, attempt: { id: 'login', phase: 'succeeded' } })
  await vi.waitFor(() => { expect(state.showInactiveWorkspace).toHaveBeenCalledOnce() })
  expect(state.loadWorkspace).not.toHaveBeenCalled()
  expect(state.showWorkspace).not.toHaveBeenCalled()
  expect(state.moveTopWorkspace).not.toHaveBeenCalled()
  expect(state.focusWorkspace).not.toHaveBeenCalled()
  expect(state.windowOptions).toMatchObject({
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, vibrancy: 'sidebar' } : {}),
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  expect(state.closeWelcome).toHaveBeenCalledOnce()
  activate()
  expect(state.showWorkspace).toHaveBeenCalledTimes(2)
  expect(state.quit).not.toHaveBeenCalled()
  expect(state.stopHost).not.toHaveBeenCalled()
  const contents = state.contents as { mainFrame: { url: string }; send: ReturnType<typeof vi.fn> }
  expect(contents.send).toHaveBeenCalledWith(DESKTOP_IPC.enterWorkspace)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const bootstrap = state.handlers.get(DESKTOP_IPC.localeBootstrap)!
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'zh' })
  state.preference = 'en'
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'en' })
  const changed = state.listeners.get(DESKTOP_IPC.localeChanged)!
  const initialMenus = state.menu.mock.calls.length
  changed({ ...event, senderFrame: {} }, 'en')
  changed(event, 42)
  expect(state.menu).toHaveBeenCalledTimes(initialMenus)
  changed(event, 'en')
  expect(state.dialogLocale!().id).toBe('en')
  expect(state.menu).toHaveBeenCalledTimes(initialMenus + 1)
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'en' })
  // Signing out returns to the welcome window; a stale signed-out frame while it is open does not reopen it.
  const welcomeCount = state.beforeWelcome.mock.calls.length
  state.hubListener!(signedOut)
  await vi.waitFor(() => { expect(state.beforeWelcome).toHaveBeenCalledTimes(welcomeCount + 1) })
  expect(await state.operations!.takeNotice()).toBeUndefined()
  state.hubListener!(signedOut)
  await vi.advanceTimersByTimeAsync(0)
  expect(state.beforeWelcome).toHaveBeenCalledTimes(welcomeCount + 1)

  // A refused refresh returns to the welcome window with a one-time notice.
  state.hubListener!(signedIn)
  await vi.waitFor(() => { expect(state.closeWelcome).toHaveBeenCalledTimes(2) })
  state.hubListener!({ ...signedOut, reason: 'expired' })
  await vi.waitFor(() => { expect(state.beforeWelcome).toHaveBeenCalledTimes(welcomeCount + 2) })
  expect(await state.operations!.takeNotice()).toBe('session-expired')
  expect(await state.operations!.takeNotice()).toBeUndefined()

  state.showWorkspace.mockClear()
  state.focusWorkspace.mockClear()
  state.showInactiveWorkspace.mockClear()
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '1')
  state.hubListener!({ ...signedIn, attempt: { id: 'again', phase: 'succeeded' } })
  await vi.waitFor(() => { expect(state.showInactiveWorkspace).toHaveBeenCalledOnce() })
  expect(state.showWorkspace).not.toHaveBeenCalled()
  expect(state.focusWorkspace).not.toHaveBeenCalled()
  expect(state.moveTopWorkspace).not.toHaveBeenCalled()
  expect(state.openDevTools).not.toHaveBeenCalled()
  state.appListeners.get('open-url')!({ preventDefault: vi.fn() }, 'dsh://open')
  expect(state.showWorkspace).toHaveBeenCalledOnce()
  expect(state.focusWorkspace).toHaveBeenCalledOnce()
})
