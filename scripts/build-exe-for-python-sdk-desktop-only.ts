/**
 * Leave the enterprise Desktop's plugins out of the Python runtime. dsh-web-app depends on them, and the
 * CLI the runtime carries depends on dsh-web-app, but web-app enables each only in the `desktop` profile
 * with a user center, which the runtime never runs; a disabled Loader entry is never imported.
 */
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** The bundle whose dependency edges to {@link DESKTOP_ONLY_PACKAGES} are cut. */
export const DESKTOP_BUNDLE = '@deepseek-ai/dsh-web-app'

/** web-app dependencies whose patch rows are enabled only in the `desktop` profile with a user center. */
export const DESKTOP_ONLY_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-assistants',
  '@deepseek-ai/dsh-automation-tasks',
  '@deepseek-ai/dsh-client-ui-assistants',
  '@deepseek-ai/dsh-client-ui-automation-tasks',
  '@deepseek-ai/dsh-client-ui-brand-mo',
  '@deepseek-ai/dsh-client-ui-connectors',
  '@deepseek-ai/dsh-client-ui-ecommerce-accounts',
  '@deepseek-ai/dsh-client-ui-feedback-report',
  '@deepseek-ai/dsh-client-ui-hub-account',
  '@deepseek-ai/dsh-client-ui-knowledge',
  '@deepseek-ai/dsh-client-ui-session-share',
  '@deepseek-ai/dsh-client-ui-settings-embedding',
  '@deepseek-ai/dsh-connectors',
  '@deepseek-ai/dsh-ecommerce-accounts',
  '@deepseek-ai/dsh-embedding',
  '@deepseek-ai/dsh-feedback-report',
  '@deepseek-ai/dsh-hub-account',
  '@deepseek-ai/dsh-knowledge-base',
  '@deepseek-ai/dsh-knowledge-selection',
  '@deepseek-ai/dsh-session-share',
  '@deepseek-ai/dsh-skill-market',
]

interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

async function manifestOf(directory: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
  } catch (error) {
    // A missing optional dependency or a directory without a manifest is no package.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Node's lookup: the nearest `node_modules/<name>` from `from` up to the staging root. */
function lookup(staging: string, from: string, name: string, present: ReadonlySet<string>): string | undefined {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    if (present.has(candidate)) return candidate
    if (directory === staging || !directory.startsWith(staging)) return undefined
  }
}

/** Every package directory under `node_modules` trees in the staging closure. */
async function packageDirectories(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (modules: string): Promise<void> => {
    let entries: string[]
    try {
      entries = await readdir(modules)
    } catch (error) {
      // A package without its own node_modules has nothing nested.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const names = entry.startsWith('@') ? (await readdir(join(modules, entry))).map(child => join(entry, child)) : [entry]
      for (const name of names) {
        const directory = join(modules, name)
        found.push(directory)
        await walk(join(directory, 'node_modules'))
      }
    }
  }
  await walk(join(root, 'node_modules'))
  return found
}

/**
 * Remove from a symlink-free hoisted deployment every package reachable only through the desktop bundle's
 * edges to `cut`. Dependencies, optional dependencies, and peers count as edges; a package another path
 * still reaches stays.
 * @param staging - The deployed closure, holding the root manifest.
 * @param bundle - The package whose edges to `cut` are not followed.
 * @param cut - The packages the bundle's edges to are cut.
 * @returns The removed package directories, relative to `staging`, sorted.
 */
export async function pruneDesktopOnly(staging: string, bundle: string, cut: readonly string[]): Promise<string[]> {
  const directories = await packageDirectories(staging)
  const present = new Set(directories)
  const cutSet = new Set(cut)
  const reached = new Set<string>()
  const queue: { directory: string; manifest: Manifest }[] = []
  const root = await manifestOf(staging)
  if (root === undefined) throw new Error(`build-exe-for-python-sdk: ${staging} has no package.json`)
  queue.push({ directory: staging, manifest: root })
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { directory, manifest } = next
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    for (const name of names) {
      if (manifest.name === bundle && cutSet.has(name)) continue
      const target = lookup(staging, directory, name, present)
      if (target === undefined || reached.has(target)) continue
      reached.add(target)
      const found = await manifestOf(target)
      if (found !== undefined) queue.push({ directory: target, manifest: found })
    }
  }
  // A directory under a removed package goes with it.
  const removed = directories.filter(directory => !reached.has(directory))
    .filter((directory, _, all) => !all.some(other => other !== directory && directory.startsWith(other + sep)))
  for (const directory of removed) await rm(directory, { recursive: true, force: true })
  return removed.map(directory => relative(staging, directory)).sort()
}
