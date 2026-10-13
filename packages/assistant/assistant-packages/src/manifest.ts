/**
 * Reading what the user center sends: the package list and a downloaded package zip. The user
 * center validates packages on upload; this module checks the response fields and the archive
 * again at the wire, and a zip whose sha256 differs from the listed one is refused.
 */
import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { z } from 'zod'
import type { AssistantPackageManifest } from './types.ts'

/** Core file names, in the order the assistant's model reads them. */
export const CORE_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md'] as const

/** One core file name. */
export type CoreFile = (typeof CORE_FILES)[number]

const MANIFEST_FILE = 'agent.json'
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const key = z.string().regex(KEY)

const timing = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: z.string().regex(TIME) }),
  z.object({
    kind: z.literal('weekly'),
    // The schedule refuses a repeated weekday; ascending order keeps the shown range right.
    weekdays: z.array(z.number().int().min(1).max(7)).min(1)
      .refine(days => days.every((day, i) => i === 0 || day > (days[i - 1] as number)), 'weekdays must be ascending without repeats'),
    time: z.string().regex(TIME),
  }),
  z.object({ kind: z.literal('cron'), expression: z.string().min(1) }),
])

const task = z.object({
  id: key,
  title: z.string().min(1),
  prompt: z.string().min(1),
  timing,
  timeZone: z.string().min(1).refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
      return true
    } catch {
      // An unknown zone throws RangeError.
      return false
    }
  }, 'timeZone is not an IANA time zone'),
  connectors: z.array(key),
  permission: key.optional(),
})

/** Runtime schema of `agent.json`; an optional field absent from the JSON stays absent. */
export const manifestSchema: z.ZodType<AssistantPackageManifest> = z.object({
  name: z.string().regex(SLUG),
  displayName: z.string().min(1),
  description: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  avatar: key.optional(),
  preset: key.optional(),
  skills: z.array(key).optional(),
  connectors: z.array(key).optional(),
  tasks: z.array(task).refine(tasks => new Set(tasks.map(item => item.id)).size === tasks.length, 'task ids must be unique'),
}).transform(({ avatar, preset, skills, connectors, tasks, ...rest }) => ({
  ...rest,
  ...(avatar === undefined ? {} : { avatar }),
  ...(preset === undefined ? {} : { preset }),
  ...(skills === undefined ? {} : { skills }),
  ...(connectors === undefined ? {} : { connectors }),
  tasks: tasks.map(({ permission, ...fields }) => ({ ...fields, ...(permission === undefined ? {} : { permission }) })),
}))

/** One listed package as the user center sends it. */
export interface ListedPackage {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly manifest: AssistantPackageManifest
  readonly updatedAt: string
}

/** Runtime schema of one package in `GET /api/client/agent-packages`. */
export const listedSchema: z.ZodType<ListedPackage> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  manifest: manifestSchema,
  updatedAt: z.string(),
})

/** A downloaded package: its manifest and core file texts. */
export interface PackageContent {
  readonly manifest: AssistantPackageManifest
  readonly files: Readonly<Record<CoreFile, string>>
}

/**
 * Hex sha256 of bytes or UTF-8 text.
 * @param data - the bytes or text.
 * @returns the lowercase hex digest.
 */
export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Check a downloaded package against its listing and read it.
 * @param zip - the downloaded bytes.
 * @param listed - the package as listed, whose sha256, size, and version the bytes must match.
 * @param maxBytes - largest package accepted.
 * @returns the manifest and core files.
 * @throws Error with the reason when the bytes, layout, or manifest are not the listed package.
 */
export function readPackage(zip: Uint8Array, listed: ListedPackage, maxBytes: number): PackageContent {
  if (zip.byteLength > maxBytes) throw new Error('the package is too large')
  if (zip.byteLength !== listed.sizeBytes || sha256(zip) !== listed.sha256) throw new Error('the package does not match the published version')
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip)
  } catch (error: unknown) {
    throw new Error('the package is not a zip archive', { cause: error })
  }
  const names = Object.keys(entries).filter(name => !name.endsWith('/'))
  const expected = [MANIFEST_FILE, ...CORE_FILES]
  if (names.length !== expected.length || !expected.every(name => names.includes(name))) {
    throw new Error(`the package must hold exactly ${expected.join(', ')}`)
  }
  // Every expected name was checked present above.
  const entry = (name: string): Uint8Array => entries[name] as Uint8Array
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(entry(MANIFEST_FILE)))
  } catch (error: unknown) {
    throw new Error('agent.json is not JSON', { cause: error })
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`agent.json is invalid: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
  if (parsed.data.version !== listed.version || parsed.data.name !== listed.name) throw new Error('agent.json does not match the published version')
  const files = Object.fromEntries(CORE_FILES.map(file => [file, strFromU8(entry(file))])) as Record<CoreFile, string>
  return { manifest: parsed.data, files }
}
