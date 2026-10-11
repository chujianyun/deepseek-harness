/**
 * Session groupings the sidebar offers beside its built-in Workspace views: a plugin registers one
 * (an assistant grouping, say) and the browser lists it under Group by and renders its sections.
 * The built-in Date grouping is registered the same way.
 */
import type { ReactNode } from 'react'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** The built-in Workspace views, which keep their own rendering, ordering, and actions. */
export const WORKSPACE_GROUPINGS = ['workspace', 'workspace-tree', 'flat'] as const

/** One built-in Workspace view. */
export type WorkspaceGrouping = typeof WORKSPACE_GROUPINGS[number]

/** The section one Session belongs to under a grouping. */
export interface SessionGroupHeading {
  /** Sessions with the same key share a section; the key also names the section's stored collapse state. */
  readonly key: string
  /** Section heading in the UI language. */
  readonly label: string
  /** Optional leading glyph, such as an avatar. */
  readonly icon?: ReactNode
  /**
   * Fixed position among sections, lowest first, such as Today before Yesterday. Sections without
   * a rank follow ranked ones, most recently active first.
   */
  readonly rank?: number
}

/** A grouping a plugin adds to the sidebar's Group by menu. */
export interface SessionGrouping {
  /** Stable id, stored as the user's choice; must not repeat a built-in or another registration. */
  readonly id: string
  /** Menu label in the UI language. */
  readonly label: () => string
  /** Optional leading menu glyph. */
  readonly icon?: ReactNode
  /** Menu position: the built-in views sit at 100 (Workspace), 200 (Workspace tree), and 900 (No grouping). */
  readonly order: number
  /** The section a visible Session belongs to. */
  readonly groupOf: (session: SessionSummary) => SessionGroupHeading
  /** Changes that regroup or relabel Sessions, such as a renamed assistant; the sidebar re-derives on each. */
  readonly subscribe?: (onChange: () => void) => () => void
}

/** The groupings registered beside the built-in views, and their registration. */
export interface SessionGroupingRegistry {
  /** Registrations in registration order; the menu positions them by `order`. */
  readonly groupings: HostObservable<readonly SessionGrouping[]>
  /**
   * Add a grouping for exactly as long as the caller keeps it.
   * @param grouping - the grouping; an id already in use throws.
   * @returns the disposer that removes it.
   */
  readonly register: (grouping: SessionGrouping) => () => void
}

/**
 * Create the registry the UiWorkspace service exposes.
 * @returns an empty registry.
 */
export function createSessionGroupingRegistry(): SessionGroupingRegistry {
  const store = createSnapshotStore<readonly SessionGrouping[]>([])
  return {
    groupings: store,
    register: (grouping) => {
      const taken = (WORKSPACE_GROUPINGS as readonly string[]).includes(grouping.id)
        || store.getSnapshot().some(item => item.id === grouping.id)
      if (taken) throw new Error(`ui-workspace: a session grouping "${grouping.id}" already exists`)
      store.set([...store.getSnapshot(), grouping])
      return () => { store.set(store.getSnapshot().filter(item => item !== grouping)) }
    },
  }
}

/** Dictionary keys the Date grouping reads. */
export type DateGroupingKey = 'groupBy.date' | 'group.today' | 'group.yesterday' | 'group.earlier' | 'date.locale'

/** Days the Date grouping lists one by one before Earlier. */
const RECENT_DAYS = 7

/**
 * The built-in Date grouping: Today, Yesterday, one section per day of the past week, then Earlier,
 * by each Session's last activity in the browser's local calendar. Today, Yesterday, and Earlier are
 * relative sections, so a fold of one stays with the label as days pass; a day section's key names
 * its date.
 * @param t - translator owning {@link DateGroupingKey}.
 * @param localeChanges - subscription to language switches, which relabel the sections.
 * @param now - the current time, read at each grouping and when scheduling the midnight regroup.
 * @returns the grouping; its `subscribe` reports each language switch and each local midnight.
 */
export function dateGrouping(
  t: (key: DateGroupingKey) => string,
  localeChanges: (onChange: () => void) => () => void,
  now: () => number = Date.now,
): SessionGrouping {
  const startOfDay = (time: number): number => new Date(time).setHours(0, 0, 0, 0)
  const formats = new Map<string, Intl.DateTimeFormat>()
  const dayLabel = (date: Date): string => {
    const locale = t('date.locale')
    let format = formats.get(locale)
    if (format === undefined) {
      format = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' })
      formats.set(locale, format)
    }
    return format.format(date)
  }
  return {
    id: 'date',
    label: () => t('groupBy.date'),
    order: 300,
    groupOf: (session) => {
      const today = startOfDay(now())
      const day = startOfDay(session.updatedAt)
      // Calendar days apart, robust to a daylight-saving day of 23 or 25 hours.
      const ago = Math.round((today - day) / 86_400_000)
      if (ago <= 0) return { key: 'today', label: t('group.today'), rank: 0 }
      if (ago === 1) return { key: 'yesterday', label: t('group.yesterday'), rank: 1 }
      if (ago < RECENT_DAYS) {
        const date = new Date(day)
        return { key: `day:${String(date.getFullYear())}-${String(date.getMonth() + 1)}-${String(date.getDate())}`, label: dayLabel(date), rank: ago }
      }
      return { key: 'earlier', label: t('group.earlier'), rank: RECENT_DAYS }
    },
    subscribe: (onChange) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const scheduleMidnight = (): void => {
        const midnight = new Date(now()).setHours(24, 0, 0, 0)
        timer = setTimeout(() => { onChange(); scheduleMidnight() }, midnight - now())
      }
      scheduleMidnight()
      const stopLocale = localeChanges(onChange)
      return () => {
        clearTimeout(timer)
        stopLocale()
      }
    },
  }
}
