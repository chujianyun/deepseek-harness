/** Quick-task cards under the blank new-session composer: a click picks the configured assistant and fills the draft without sending it. */
import { useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { QuickTaskId } from '../quick-tasks.ts'
import css from './QuickTasks.module.css'

/** Business face injected into the quick-task dock occupant. */
export interface QuickTasksInjected {
  readonly hooks: {
    /** The brand settings section; `quickTasks` lists the offered task ids in order, `quickTaskAssistant` the template a card picks. */
    readonly brandSettings: HostObservable<ConfigFormSnapshot<BrandSettings>>
  }
  /**
   * Pick the new session's assistant by template.
   * @returns false when the tenant has no assistant from the template; true once picked, or without the assistants UI.
   */
  readonly pickAssistant: (templateId: string) => Promise<boolean>
}

/** The brand settings the cards read. */
export interface BrandSettings {
  readonly quickTasks?: readonly QuickTaskId[]
  readonly quickTaskAssistant?: string
}

/** Props of the `conversation.hero.dock` quick-task occupant. */
export type QuickTasksProps = PropsRuntime<'conversation.hero.dock'> & PropsLocale<'ui-brand-mo'> & InjectFace<QuickTasksInjected>

const EMPTY: readonly QuickTaskId[] = []

/**
 * Render the configured quick tasks while the Session is blank and the draft is empty. A card first
 * picks the configured assistant and then puts its prompt in the draft, so the prompt cannot be sent
 * before the pick binds, and a click never replaces text or references the user entered. When the
 * tenant has no assistant from the template, the card fills nothing and says so. Repeated ids show once.
 * @param props - Session and input state, the composer's input actions, the brand translator, the settings hook, and the pick.
 * @returns the card list, or null outside a blank Session, with a draft, or with no task configured.
 */
export function QuickTasks({ t, useSession, useInput, inputActions, useBrandSettings, pickAssistant }: QuickTasksProps) {
  const blank = useSession(session => session.blank && !session.promptAttempted && !session.running)
  const empty = useInput(input => input.draft.trim() === '' && input.occurrences.length === 0 && input.attachmentIds.length === 0)
  const settings = useBrandSettings(snapshot => snapshot.value)
  const [missing, setMissing] = useState(false)
  const tasks = settings?.quickTasks ?? EMPTY
  const assistant = settings?.quickTaskAssistant ?? ''
  if (!blank || !empty || tasks.length === 0) return null
  const run = async (id: QuickTaskId): Promise<void> => {
    if (assistant !== '' && !await pickAssistant(assistant)) { setMissing(true); return }
    setMissing(false)
    inputActions.setDraft(t(`${id}.prompt`))
  }
  return (
    <div className={css.root}>
      <ul className={css.grid} aria-label={t('quickTasks')} data-quick-tasks="">
        {[...new Set(tasks)].map((id) => {
          const title = t(`${id}.title`)
          return (
            <li key={id}>
              <button type="button" className={css.card} data-task={id} onClick={() => { void run(id) }}>
                <span className={css.glyph} aria-hidden="true">{title.slice(0, 1)}</span>
                <span className={css.title}>{title}</span>
                <span className={css.description}>{t(`${id}.description`)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {missing && <p className={css.missing} role="alert">{t('missingAssistant')}</p>}
    </div>
  )
}
