/** Pinned installed skills, kept in this window's browser storage (this machine only). */

const STORAGE_KEY = 'dsh.skills.pinned'
/** Most pins kept; the oldest go first beyond it. */
const LIMIT = 200

/**
 * The pin key of an installed skill: its instruction file path, which differs per source and, for a
 * market Skill, per tenant (`skills-market/<tenantId>/<name>/`), so a pin never follows a name onto
 * another tenant's or source's skill.
 * @param skill - the installed skill.
 * @returns the key stored in the pin list.
 */
export const pinKey = (skill: { readonly path: string }): string => skill.path

/**
 * Read the pinned keys, oldest pin first; unreadable or missing storage reads as none.
 * @returns the pinned keys.
 */
export function loadPins(): readonly string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? [...new Set(parsed.filter((value): value is string => typeof value === 'string'))] : []
  } catch {
    // A private or corrupted browser store reads as no pins.
    return []
  }
}

/**
 * Pin or unpin one key and persist the bounded list when storage is available.
 * @param pins - the current keys.
 * @param key - the key to change.
 * @param pinned - whether it should be pinned.
 * @returns the new keys.
 */
export function savePin(pins: readonly string[], key: string, pinned: boolean): readonly string[] {
  const next = [...pins.filter(item => item !== key), ...pinned ? [key] : []].slice(-LIMIT)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // A private or full browser store keeps the pin for this page only.
    }
  }
  return next
}
