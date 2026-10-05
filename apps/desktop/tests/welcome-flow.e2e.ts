/** Built Desktop Host acceptance; run after the repository build, without provider credentials. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { connectDesktopWelcome, type DesktopWelcomeBackend } from '../src/welcome-backend.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const builtHost = join(repository, 'apps/desktop-host/lib/index.js')
afterEach(() => { vi.unstubAllEnvs() })

function version(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

describe.skipIf(!existsSync(builtHost))('built Desktop welcome flow', () => {
  it('opens the workspace only for a user-center sign-in that persists across Host restarts', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-welcome-'))
    let host: DesktopHostProcess | undefined
    const center = await startMockUserCenter()
    try {
      for (const name of Object.keys(process.env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD/u.test(name)) vi.stubEnv(name, undefined)
      }
      vi.stubEnv('DSH_HUB_ORIGIN', center.origin)
      vi.stubEnv('DSH_HUB_CLIENT_ID', 'dsh-desktop')
      vi.stubEnv('DSH_HUB_ALLOW_LOOPBACK_HTTP', '1')
      const home = join(root, 'home')
      mkdirSync(home)
      vi.stubEnv('DSH_HOME', home)
      vi.stubEnv('DSH_TELEMETRY_MODE', 'DISABLED')
      const project = prepareDevelopmentProject({
        projectDir: join(root, 'project'),
        cliDir: join(repository, 'apps/cli'),
        hostDir: join(repository, 'apps/desktop-host'),
        dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'),
        release: {
          schemaVersion: 1,
          version: version(join(repository, 'apps/desktop/package.json')),
          pnpmVersion: version(join(repository, 'apps/desktop/node_modules/pnpm/package.json')),
          nodeVersion: process.versions.node,
          hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        },
        // This suite assembles a synthetic project on hosts that prepare no Desktop target, and
        // nothing it exercises compares the descriptor's platform/arch outside packaging.
        target: 'mac-x64',
      })
      cpSync(join(repository, 'packages/skill/skill-office/assets'), join(root, 'runtime/office-skills'), { recursive: true })
      const nodeBin = join(root, 'runtime/primary-runtime/dependencies/node/bin')
      mkdirSync(nodeBin, { recursive: true })
      cpSync(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))
      const paths = resolveDesktopPaths(home)
      const manager = new DesktopProjectManager(paths, {
        dsh: project,
      })
      await manager.applyRelease()
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
      let backend: DesktopWelcomeBackend
      let hostOrigin = ''
      const restart = async (): Promise<void> => {
        await host?.stop()
        host = new DesktopHostProcess(process.execPath, project, paths.profile)
        const { url } = await host.start()
        hostOrigin = new URL(url).origin
        let cookie = ''
        const send: typeof fetch = async (input, init) => {
          const headers = new Headers(init?.headers)
          if (cookie !== '') headers.set('cookie', cookie)
          const response = await fetch(input, { ...init, headers, redirect: 'manual' })
          if (response.status !== 303) return response
          cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
          await response.body?.cancel()
          return fetch(new URL(response.headers.get('location')!, url), { headers: { cookie } })
        }
        backend = await connectDesktopWelcome(url, send, () => Promise.resolve(cookie))
      }
      const status = async () => backend.read()
      const signedOut = { status: 'signed-out', profile: null, reason: null }
      await restart()
      expect(await status()).toMatchObject({ hub: signedOut, localePreference: null })
      await host!.stop()
      writeFileSync(join(paths.profile, 'cordis.patch.yml'),
        readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8') + '- id: locale\n  config:\n    preference: zh\n')
      await restart()
      expect(await status()).toMatchObject({ hub: signedOut, localePreference: 'zh' })

      // A cancelled attempt cannot complete later.
      const cancelled = await backend!.hub.start()
      await expect.poll(async () => (await backend!.hub.state()).attempt?.authorizeUrl).toBeDefined()
      const late = (await backend!.hub.state()).attempt!.authorizeUrl!
      expect(new URL(late).origin).toBe(center.origin)
      await backend!.hub.cancel(cancelled.attempt!.id)
      // The cancelled attempt's loopback callback no longer accepts the browser.
      await expect(browse(late)).rejects.toThrow('fetch failed')
      expect(await status()).toMatchObject({ hub: signedOut })

      // The browser sign-in signs the employee in, and the sign-in survives a Host restart.
      await backend!.hub.start()
      await expect.poll(async () => (await backend!.hub.state()).attempt?.authorizeUrl).toBeDefined()
      expect((await browse((await backend!.hub.state()).attempt!.authorizeUrl!)).text).toContain('登录成功')
      await expect.poll(async () => (await status()).hub.status).toBe('signed-in')
      expect((await status()).hub.profile).toMatchObject({ nickname: '李雷', tenantName: '甲公司' })
      expect(hostOrigin).not.toBe('')
      await restart()
      expect(await status()).toMatchObject({ hub: { status: 'signed-in', profile: { tenantName: '甲公司' } } })
    } finally {
      await host?.stop()
      await center.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
