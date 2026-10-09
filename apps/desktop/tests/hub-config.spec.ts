import { expect, it } from 'vitest'
import { desktopHubEnvironment, HUB_NOT_CONFIGURED, resolveDesktopHubConfig } from '../src/hub-config.ts'
import { resolveDesktopHubEnvironment } from '../scripts/desktop-hub-environment.mjs'

const BUNDLED = { origin: 'https://hub.example.com', clientId: 'dsh_0123456789abcdef01234567' }

it('fills the Host environment from the bundled user center', () => {
  expect(desktopHubEnvironment({ PATH: '/bin' }, BUNDLED)).toEqual({
    PATH: '/bin', DSH_HUB_ORIGIN: BUNDLED.origin, DSH_HUB_CLIENT_ID: BUNDLED.clientId,
  })
  expect(desktopHubEnvironment({ DSH_HUB_ORIGIN: '' }, BUNDLED)).toMatchObject({ DSH_HUB_ORIGIN: BUNDLED.origin })
})

it('lets a launch environment that names a user center replace the bundled one', () => {
  const environment = { DSH_HUB_ORIGIN: 'http://localhost:8080', DSH_HUB_CLIENT_ID: 'dsh_local', DSH_HUB_ALLOW_LOOPBACK_HTTP: '1' }
  expect(desktopHubEnvironment(environment, BUNDLED)).toBe(environment)
  expect(desktopHubEnvironment(environment, undefined)).toBe(environment)
})

it('refuses to start a Host with no user center', () => {
  expect(() => desktopHubEnvironment({}, undefined)).toThrow(HUB_NOT_CONFIGURED)
})

it('reads the settings the packaging step bundles', () => {
  const packaged = resolveDesktopHubEnvironment({ DSH_DESKTOP_HUB_ORIGIN: 'https://hub.example.com/', DSH_DESKTOP_HUB_CLIENT_ID: BUNDLED.clientId })
  expect(packaged).toEqual(BUNDLED)
  expect(resolveDesktopHubConfig(packaged)).toEqual(BUNDLED)
  expect(resolveDesktopHubConfig(undefined)).toBeUndefined()
})

it.each([null, 'https://hub.example.com', {}, { origin: 'https://hub.example.com' }, { ...BUNDLED, clientId: '' },
  { ...BUNDLED, clientId: 7 }])('rejects malformed bundled settings %j', (value) => {
  expect(() => resolveDesktopHubConfig(value)).toThrow('invalid bundled user-center settings')
})

it.each(['http://hub.example.com', 'https://hub.example.com/path', 'not a url'])('rejects bundled origin %s', (origin) => {
  expect(() => resolveDesktopHubConfig({ ...BUNDLED, origin })).toThrow('invalid bundled user-center origin')
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
