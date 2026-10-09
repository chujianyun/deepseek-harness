import { expect, it } from 'vitest'
import { desktopHubEnvironment, HUB_NOT_CONFIGURED, resolveDesktopHubConfig } from '../src/hub-config.ts'
import { resolveDesktopHubEnvironment } from '../scripts/desktop-hub-environment.mjs'

const BUNDLED = { origin: 'https://hub.example.com', clientId: 'dsh_0123456789abcdef01234567' }

it('fills the Host environment from the bundled user center', () => {
  expect(desktopHubEnvironment({ PATH: '/bin' }, BUNDLED)).toEqual({
    PATH: '/bin', DSH_HUB_ORIGIN: BUNDLED.origin, DSH_HUB_CLIENT_ID: BUNDLED.clientId,
  })
  expect(desktopHubEnvironment({ DSH_HUB_ORIGIN: '', DSH_HUB_CLIENT_ID: '' }, BUNDLED)).toMatchObject({ DSH_HUB_ORIGIN: BUNDLED.origin })
})

it('lets a launch environment that names a complete user center replace the bundled one', () => {
  const environment = { DSH_HUB_ORIGIN: 'http://localhost:8080', DSH_HUB_CLIENT_ID: 'dsh_local', DSH_HUB_ALLOW_LOOPBACK_HTTP: '1' }
  expect(desktopHubEnvironment(environment, BUNDLED)).toBe(environment)
  expect(desktopHubEnvironment(environment, undefined)).toBe(environment)
})

it.each([{ DSH_HUB_ORIGIN: 'https://hub.local' }, { DSH_HUB_CLIENT_ID: 'dsh_local' },
  { DSH_HUB_ORIGIN: 'https://hub.local', DSH_HUB_CLIENT_ID: 'dsh local' }])('refuses half a user center in the launch environment %j', (environment) => {
  expect(() => desktopHubEnvironment(environment, BUNDLED)).toThrow(`${HUB_NOT_CONFIGURED} (set both DSH_HUB_ORIGIN and DSH_HUB_CLIENT_ID)`)
})

it('refuses to start a Host with no user center', () => {
  expect(() => desktopHubEnvironment({}, undefined)).toThrow(HUB_NOT_CONFIGURED)
})

it('reads the settings the packaging step bundles', () => {
  const packaged = resolveDesktopHubEnvironment({ DSH_DESKTOP_HUB_ORIGIN: 'https://hub.example.com/', DSH_DESKTOP_HUB_CLIENT_ID: BUNDLED.clientId })
  expect(packaged).toEqual(BUNDLED)
  expect(resolveDesktopHubConfig({ name: 'app', dshHub: packaged })).toEqual(BUNDLED)
  expect(resolveDesktopHubConfig({ name: 'app' })).toBeUndefined()
  expect(resolveDesktopHubConfig(null)).toBeUndefined()
})

it.each([null, 'https://hub.example.com', {}, { origin: 'https://hub.example.com' }, { ...BUNDLED, clientId: '' },
  { ...BUNDLED, clientId: 7 }, { ...BUNDLED, clientId: 'dsh id' }, { ...BUNDLED, origin: 'http://hub.example.com' },
  { ...BUNDLED, origin: 'https://hub.example.com/' }, { ...BUNDLED, origin: 'not a url' }])('reports malformed bundled settings %j as a user-center failure', (dshHub) => {
  expect(() => resolveDesktopHubConfig({ dshHub })).toThrow(`${HUB_NOT_CONFIGURED} (the bundled user-center settings are invalid)`)
})

it.each([undefined, '', 'http://hub.example.com', 'https://user:secret@hub.example.com', 'https://hub.example.com/api',
  'https://hub.example.com/?q=1', 'https://hub.example.com/#x'])('requires an HTTPS origin to package, not %s', (origin) => {
  expect(() => resolveDesktopHubEnvironment({ DSH_DESKTOP_HUB_ORIGIN: origin, DSH_DESKTOP_HUB_CLIENT_ID: BUNDLED.clientId }))
    .toThrow('DSH_DESKTOP_HUB_ORIGIN requires an HTTPS origin')
})

it.each([undefined, '', 'dsh id', 'dsh/id'])('requires the registered client id to package, not %j', (clientId) => {
  expect(() => resolveDesktopHubEnvironment({ DSH_DESKTOP_HUB_ORIGIN: BUNDLED.origin, DSH_DESKTOP_HUB_CLIENT_ID: clientId }))
    .toThrow('DSH_DESKTOP_HUB_CLIENT_ID requires the DSH client id')
})
