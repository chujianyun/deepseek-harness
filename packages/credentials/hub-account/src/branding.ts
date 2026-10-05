/**
 * Local cache of the login-page branding (logo and welcome title) of the tenant last signed in
 * to, so the Desktop welcome window can show it before anyone signs in. One record plus one logo
 * file named by its sha256; the record is replaced atomically after the logo is in place.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** Largest logo accepted, as the user center limits uploads (T30). */
export const BRANDING_LOGO_MAX_BYTES = 512 * 1024
/** Logo formats the user center accepts (T30). */
export const BRANDING_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'] as const

const RECORD = 'branding.json'
const LOGO_PREFIX = 'logo-'

/** A tenant's branding as cached: items the tenant has not set are null. */
export interface CachedBranding {
  readonly tenantId: string
  readonly title: string | null
  readonly logo: CachedLogo | null
}

/** A logo whose bytes match its declared type, size limit and sha256. */
export interface CachedLogo {
  readonly contentType: (typeof BRANDING_LOGO_TYPES)[number]
  readonly sha256: string
  readonly data: Buffer
}

const record = z.object({
  version: z.literal(1),
  issuer: z.string(),
  tenantId: z.string(),
  title: z.string().nullable(),
  logo: z.object({ contentType: z.enum(BRANDING_LOGO_TYPES), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
})

/**
 * Check logo bytes against what the user center declared for them.
 * @param contentType - declared type.
 * @param sha256 - declared sha256, hex.
 * @param data - the bytes.
 * @returns the logo, or undefined when the type, size or hash does not hold.
 */
export function checkedLogo(contentType: string, sha256: string, data: Buffer): CachedLogo | undefined {
  if (!(BRANDING_LOGO_TYPES as readonly string[]).includes(contentType)) return undefined
  if (data.length === 0 || data.length > BRANDING_LOGO_MAX_BYTES) return undefined
  if (createHash('sha256').update(data).digest('hex') !== sha256) return undefined
  return { contentType: contentType as CachedLogo['contentType'], sha256, data }
}

/**
 * Read the cached branding. A logo that no longer checks out is dropped; a record from another
 * user center, or an unreadable one, counts as no cache.
 * @param dir - cache directory.
 * @param issuer - user-center origin the cache must belong to.
 * @returns the branding, or undefined.
 */
export async function readBrandingCache(dir: string, issuer: string): Promise<CachedBranding | undefined> {
  let parsed
  try { parsed = record.safeParse(JSON.parse(await readFile(join(dir, RECORD), 'utf8'))) } catch { return undefined }
  if (!parsed.success || parsed.data.issuer !== issuer) return undefined
  const { tenantId, title, logo } = parsed.data
  let checked: CachedLogo | undefined
  if (logo !== null) {
    const data = await readFile(join(dir, LOGO_PREFIX + logo.sha256)).catch(() => undefined)
    checked = data === undefined ? undefined : checkedLogo(logo.contentType, logo.sha256, data)
  }
  if (title === null && checked === undefined) return undefined
  return { tenantId, title, logo: checked ?? null }
}

/**
 * Replace the cache: the logo file first, then the record, then logos no longer referenced.
 * @param dir - cache directory, created when missing.
 * @param issuer - user-center origin the branding came from.
 * @param branding - what to cache.
 */
export async function writeBrandingCache(dir: string, issuer: string, branding: CachedBranding): Promise<void> {
  await mkdir(dir, { recursive: true })
  const { logo } = branding
  const keep = logo === null ? undefined : LOGO_PREFIX + logo.sha256
  if (logo !== null) await replace(join(dir, LOGO_PREFIX + logo.sha256), logo.data)
  await replace(join(dir, RECORD), JSON.stringify({
    version: 1, issuer, tenantId: branding.tenantId, title: branding.title,
    logo: branding.logo === null ? null : { contentType: branding.logo.contentType, sha256: branding.logo.sha256 },
  }))
  await removeLogos(dir, keep)
}

/**
 * Forget the cached branding.
 * @param dir - cache directory.
 */
export async function clearBrandingCache(dir: string): Promise<void> {
  await rm(join(dir, RECORD), { force: true })
  await removeLogos(dir, undefined)
}

/**
 * Render a cached logo for an `<img>`.
 * @param logo - checked logo.
 * @returns its data URL.
 */
export function logoDataUrl(logo: CachedLogo): string {
  return `data:${logo.contentType};base64,${logo.data.toString('base64')}`
}

async function replace(path: string, data: string | Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

async function removeLogos(dir: string, keep: string | undefined): Promise<void> {
  const names = await readdir(dir).catch(() => [])
  await Promise.all(names.filter(name => name.startsWith(LOGO_PREFIX) && name !== keep).map(name => rm(join(dir, name), { force: true })))
}
