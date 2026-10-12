import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_BUNDLE, DESKTOP_ONLY_PACKAGES, pruneDesktopOnly } from './build-exe-for-python-sdk-desktop-only.ts'

const root = resolve(import.meta.dirname, '..')
const temps: string[] = []

afterEach(async () => {
  for (const directory of temps.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A deployed closure: each key a package directory relative to the root, each value its manifest. */
async function closure(packages: Record<string, object>): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), 'dsh-desktop-only-'))
  temps.push(staging)
  for (const [path, manifest] of Object.entries(packages)) {
    await mkdir(join(staging, path), { recursive: true })
    await writeFile(join(staging, path, 'package.json'), JSON.stringify(manifest))
  }
  return staging
}

describe('pruneDesktopOnly', () => {
  it('removes what only the bundle\'s cut edges reach, and keeps what another path still reaches', async () => {
    const staging = await closure({
      '.': { name: 'runtime', dependencies: { cli: '1' } },
      'node_modules/cli': { name: 'cli', dependencies: { bundle: '1', sdk: '1' } },
      'node_modules/bundle': { name: 'bundle', dependencies: { desk: '1', shared: '1', kept: '1' } },
      'node_modules/sdk': { name: 'sdk', dependencies: { shared: '1' }, peerDependencies: { peer: '1' } },
      'node_modules/desk': { name: 'desk', dependencies: { heavy: '1', shared: '1' }, optionalDependencies: { native: '1' } },
      'node_modules/desk/node_modules/inner': { name: 'inner' },
      'node_modules/heavy': { name: 'heavy' },
      'node_modules/native': { name: 'native' },
      'node_modules/shared': { name: 'shared' },
      'node_modules/kept': { name: 'kept', dependencies: { nested: '2' } },
      'node_modules/kept/node_modules/nested': { name: 'nested' },
      'node_modules/nested': { name: 'nested' },
      'node_modules/peer': { name: 'peer' },
      'node_modules/@scope/kept': { name: '@scope/kept' },
      'node_modules/@scope/gone': { name: '@scope/gone' },
    })
    await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'runtime', dependencies: { 'cli': '1', '@scope/kept': '1' } }))
    expect(await pruneDesktopOnly(staging, 'bundle', ['desk'])).toEqual([
      'node_modules/@scope/gone', 'node_modules/desk', 'node_modules/heavy', 'node_modules/native', 'node_modules/nested',
    ])
    // The nested copy is the one `kept` resolves; the hoisted copy nobody reached went.
    expect(JSON.parse(await readFile(join(staging, 'node_modules/kept/node_modules/nested/package.json'), 'utf8'))).toEqual({ name: 'nested' })
    expect(await pruneDesktopOnly(staging, 'bundle', ['desk'])).toEqual([])
  })

  it('leaves a package the cut bundle names but another package also needs', async () => {
    const staging = await closure({
      '.': { name: 'runtime', dependencies: { bundle: '1', sdk: '1' } },
      'node_modules/bundle': { name: 'bundle', dependencies: { desk: '1' } },
      'node_modules/sdk': { name: 'sdk', dependencies: { desk: '1' } },
      'node_modules/desk': { name: 'desk' },
    })
    expect(await pruneDesktopOnly(staging, 'bundle', ['desk'])).toEqual([])
  })

  it('refuses a staging directory without a manifest', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'dsh-desktop-only-'))
    temps.push(staging)
    await expect(pruneDesktopOnly(staging, 'bundle', [])).rejects.toThrow('has no package.json')
  })
})

describe('DESKTOP_ONLY_PACKAGES', () => {
  it('lists only web-app dependencies whose every web-app row runs in the Desktop with a user center alone', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'packages/bundle/web-app/package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> }
    expect(manifest.name).toBe(DESKTOP_BUNDLE)
    const patch = await readFile(join(root, 'packages/bundle/web-app/cordis.patch.yml'), 'utf8')
    for (const name of DESKTOP_ONLY_PACKAGES) {
      expect(manifest.dependencies, name).toHaveProperty([name])
      const rows = [...patch.matchAll(new RegExp(`name: '${name}(?:/[\\w-]+)?'\\n\\s+disabled: (.+)`, 'gu'))]
      const all = [...patch.matchAll(new RegExp(`name: '${name}(?:/[\\w-]+)?'`, 'gu'))]
      expect(rows.length, name).toBe(all.length)
      expect(all.length, name).toBeGreaterThan(0)
      for (const row of rows) expect(row[1], name).toMatch(/profileContext'\)\?\.name !== 'desktop'/u)
    }
  })
})
