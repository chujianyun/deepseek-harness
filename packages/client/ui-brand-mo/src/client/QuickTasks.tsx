/** Quick-task cards under the blank new-session composer: a click fills the draft without sending it. */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { QuickTaskId } from '../quick-tasks.ts'
import css from './QuickTasks.module.css'

/** Business face injected into the quick-task dock occupant. */
export interface QuickTasksInjected {
  readonly hooks: {
    /** The brand settings section; `quickTasks` lists the offered task ids in order. */
    readonly brandSettings: HostObservable<ConfigFormSnapshot<{ quickTasks?: readonly QuickTaskId[] }>>
  }
}

/** Props of the `conversation.hero.dock` quick-task occupant. */
export type QuickTasksProps = PropsRuntime<'conversation.hero.dock'> & PropsLocale<'ui-brand-mo'> & InjectFace<QuickTasksInjected>

const EMPTY: readonly QuickTaskId[] = []

/**
 * Render the configured quick tasks while the Session is blank and the draft is empty; a card puts
 * its prompt in the draft, so a click never replaces text or references the user entered.
 * Repeated ids show once.
 * @param props - Session and input state, the composer's input actions, the brand translator, and the settings hook.
 * @returns the card list, or null outside a blank Session, with a draft, or with no task configured.
 */
export function QuickTasks({ t, useSession, useInput, inputActions, useBrandSettings }: QuickTasksProps) {
  const blank = useSession(session => session.blank && !session.promptAttempted && !session.running)
  const empty = useInput(input => input.draft.trim() === '' && input.occurrences.length === 0 && input.attachmentIds.length === 0)
  const tasks = useBrandSettings(snapshot => snapshot.value?.quickTasks ?? EMPTY)
  if (!blank || !empty || tasks.length === 0) return null
  return (
    <ul className={css.grid} aria-label={t('quickTasks')} data-quick-tasks="">
      {[...new Set(tasks)].map((id) => {
        const title = t(`${id}.title`)
        return (
          <li key={id}>
            <button type="button" className={css.card} data-task={id} onClick={() => { inputActions.setDraft(t(`${id}.prompt`)) }}>
              <span className={css.glyph} aria-hidden="true">{title.slice(0, 1)}</span>
              <span className={css.title}>{title}</span>
              <span className={css.description}>{t(`${id}.description`)}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
