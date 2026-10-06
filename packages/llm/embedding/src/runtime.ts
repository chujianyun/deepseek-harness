/**
 * The onnxruntime-node runtime, fetched as npm tarballs instead of shipped: only the current
 * platform's native files are extracted, into `<dir>/node_modules/<package>`, so the package's
 * own relative `require` of its binding resolves without patching, and loaded with `createRequire`.
 */
import { createRequire } from 'node:module'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { extract } from 'tar'
import { DownloadError, downloadFile } from '@deepseek-ai/dsh-verified-download'
import type { RuntimeSpec } from './index.ts'

/** The subset of the onnxruntime-node API the embedder uses. */
export interface OrtModule {
  readonly InferenceSession: { create(path: string): Promise<OrtSession> }
  readonly Tensor: new (type: 'int64' | 'float32', data: BigInt64Array | Float32Array, dims: readonly number[]) => unknown
}

/** One loaded model. */
export interface OrtSession {
  readonly inputNames: readonly string[]
  /** Run once; decoder exports name their hidden states `last_hidden_state`. */
  run(feeds: Record<string, unknown>): Promise<{ readonly last_hidden_state: OrtTensor }>
}

/** An output tensor. */
export interface OrtTensor {
  readonly dims: readonly number[]
  readonly data: ArrayLike<number>
}

/**
 * Platform key of the running process, as the runtime names its builds.
 * @returns `<platform>-<arch>`.
 */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

/** Native files of the current platform; every other platform's are skipped. */
function nativeDir(): string {
  return `package/bin/napi-v6/${process.platform}/${process.arch}/`
}

/**
 * Tarball path inside a package to keep: its manifest and JavaScript, and this platform's native files.
 * @param name - package name.
 * @param path - entry path in the tarball.
 * @returns whether to extract it.
 */
export function keepEntry(name: string, path: string): boolean {
  if (name !== 'onnxruntime-node') return true
  return path === 'package/package.json' || path.startsWith('package/dist/') || path.startsWith(nativeDir())
}

/**
 * Whether the runtime is installed in a directory.
 * @param dir - runtime directory.
 * @param spec - the runtime packages.
 * @returns true when every package manifest is in place.
 */
export async function runtimeInstalled(dir: string, spec: RuntimeSpec): Promise<boolean> {
  for (const pkg of spec.packages) {
    if ((await stat(join(dir, 'node_modules', pkg.name, 'package.json')).catch(() => undefined)) === undefined) return false
  }
  return true
}

/**
 * Download and extract the runtime packages; tarballs are kept until extracted so an interrupted download resumes.
 * @param dir - runtime directory.
 * @param spec - the runtime packages.
 * @param registries - npm registry origins, tried in order.
 * @param onBytes - download progress, in bytes.
 * @param signal - stops the download.
 */
export async function installRuntime(
  dir: string, spec: RuntimeSpec, registries: readonly string[], onBytes: (bytes: number) => void, signal: AbortSignal,
): Promise<void> {
  for (const pkg of spec.packages) {
    const target = join(dir, 'node_modules', pkg.name)
    if ((await stat(join(target, 'package.json')).catch(() => undefined)) !== undefined) continue
    const tarball = join(dir, 'downloads', `${pkg.name}-${spec.version}.tgz`)
    await downloadFile({
      urls: registries.map(origin => `${origin.replace(/\/+$/u, '')}/${pkg.name}/-/${pkg.name}-${spec.version}.tgz`),
      dest: tarball, size: pkg.size, sha256: pkg.sha256,
    }, onBytes, signal)
    // Extract beside the target and rename, so an interrupted extraction never looks installed.
    const staging = `${target}.extract`
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      await extract({ file: tarball, cwd: staging, strip: 1, filter: path => keepEntry(pkg.name, path) })
      await rename(staging, target)
      await rm(tarball, { force: true })
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw new DownloadError('storage', `${pkg.name}: ${String(error)}`)
    }
  }
}

/**
 * Load the installed runtime.
 * @param dir - runtime directory.
 * @returns the onnxruntime-node module.
 */
export function loadRuntime(dir: string): OrtModule {
  return createRequire(join(dir, 'node_modules', '.root'))('onnxruntime-node') as OrtModule
}
