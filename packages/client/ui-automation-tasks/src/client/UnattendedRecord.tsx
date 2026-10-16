/** The record a scheduled run leaves beneath its closing reply: what ran without asking and what was refused. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { selectUnattended, type UnattendedAnswer } from './unattended-turn.ts'
import css from './UnattendedRecord.module.css'

/** Nothing is injected: the record reads only its Turn. */
export type UnattendedRecordInjected = Record<never, never>

/** Props of the record in one Turn tail. */
export type UnattendedRecordProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'automationTaskForm'> & InjectFace<UnattendedRecordInjected>

/**
 * Render the calls a scheduled run answered without anyone, refused ones first.
 * @param props - closing Turn and copy.
 * @returns the record, or null when the Turn answered none.
 */
export function UnattendedRecord(props: UnattendedRecordProps) {
  const answers = selectUnattended(props)
  if (answers === null) return null
  const { t } = props
  const refused = answers.filter(answer => !answer.allowed)
  const allowed = answers.filter(answer => answer.allowed)
  const group = (items: readonly UnattendedAnswer[], kind: 'refused' | 'allowed') => items.length === 0 ? null : (
    <div className={css.group} data-kind={kind}>
      <p className={css.groupTitle}>{t(kind === 'refused' ? 'unattended.refused' : 'unattended.allowed', { count: String(items.length) })}</p>
      <ul className={css.list}>
        {items.map(item => (
          <li key={`${item.callId}-${String(item.seq)}`} className={css.item}>
            <code className={css.command}>{item.command}</code>
            {item.allowed && <span className={css.operations}>{t('unattended.matched', { operations: item.operations.join('、') })}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
  return (
    <section className={css.root} aria-label={t('unattended.title')}>
      <p className={css.title}>{t('unattended.title')}</p>
      {group(refused, 'refused')}
      {group(allowed, 'allowed')}
      {refused.length > 0 && <p className={css.hint}>{t('unattended.hint')}</p>}
    </section>
  )
}
