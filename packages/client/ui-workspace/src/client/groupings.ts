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
  /**
   * Whether the grouping can name every section now. While false (its data is still loading, say)
   * the sidebar keeps the stored folds of sections it does not see; absent means always ready.
   */
  readonly ready?: () => boolean
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
  /**
   * The grouping a sidebar shows before its user picks one: 'workspace' unless a caller set another.
   * The value is remembered in the browser, so the next start shows it from the first frame.
   */
  readonly defaultGrouping: HostObservable<string>
  /**
   * Set the default grouping for as long as the caller keeps it.
   * @param id - a built-in view or a registered grouping's id.
   * @returns the disposer; the default returns to 'workspace' unless another call replaced it since.
   */
  readonly setDefault: (id: string) => () => void
  /** Idle Session rows a group shows before its overflow control: {@link DEFAULT_SESSION_LIMIT} unless a caller set another. */
  readonly sessionLimit: HostObservable<number>
  /**
   * Set the rows a group shows for as long as the caller keeps it.
   * @param limit - a positive whole number of idle Session rows.
   * @returns the disposer; the limit returns to the default unless another call replaced it since.
   * @throws when `limit` is not a positive whole number.
   */
  readonly setSessionLimit: (limit: number) => () => void
}

/** Idle Session rows a group shows before its overflow control, unless configured. */
export const DEFAULT_SESSION_LIMIT = 5

/** Browser storage key of the remembered default grouping. */
const DEFAULT_GROUPING_KEY = 'dsh.workspace.defaultGrouping'

/**
 * Create the registry the UiWorkspace service exposes.
 * @returns an empty registry.
 */
export function createSessionGroupingRegistry(): SessionGroupingRegistry {
  const store = createSnapshotStore<readonly SessionGrouping[]>([])
  const defaultGrouping = createSnapshotStore<string>('workspace', { persist: { name: DEFAULT_GROUPING_KEY } })
  const sessionLimit = createSnapshotStore<number>(DEFAULT_SESSION_LIMIT)
  return {
    groupings: store,
    sessionLimit,
    setSessionLimit: (limit) => {
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`ui-workspace: a group's session limit must be a positive whole number, got ${String(limit)}`)
      sessionLimit.set(limit)
      // A caller that replaces its own value sets the new one before withdrawing the old.
      return () => {
        if (sessionLimit.getSnapshot() === limit) sessionLimit.set(DEFAULT_SESSION_LIMIT)
      }
    },
    defaultGrouping,
    setDefault: (id) => {
      defaultGrouping.set(id)
      return () => {
        if (defaultGrouping.getSnapshot() === id) defaultGrouping.set('workspace')
      }
    },
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
