/** Pinned installed skills, kept in this window's browser storage (this machine only). */

const STORAGE_KEY = 'dsh.skills.pinned'
/** Most pins kept; the oldest go first beyond it. */
const LIMIT = 200

/**
 * The pin key of an installed skill: its page group and name, so a user skill and a market skill of
 * the same name are pinned apart.
 * @param group - the page group.
 * @param name - the skill name.
 * @returns the key stored in the pin list.
 */
export const pinKey = (group: string, name: string): string => `${group}:${name}`

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
