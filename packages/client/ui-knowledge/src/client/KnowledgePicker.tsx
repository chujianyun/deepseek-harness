/** The composer's knowledge control: which knowledge bases this conversation may search. */
import { useEffect, useRef, useState } from 'react'
import { Checkbox, IconDeliverDocRegular, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-knowledge-selection/client'
import type { KnowledgeSnapshot } from './knowledge-source.ts'
import css from './KnowledgePage.module.css'

/** Knowledge bases to choose from, and how to select them for this session. */
export interface KnowledgePickerInjected {
  readonly hooks: { readonly knowledge: HostObservable<KnowledgeSnapshot> }
  /** Select knowledge bases; `next-step` while a turn runs, or the refusal's failure line. */
  select: (baseIds: string[]) => Promise<'now' | 'next-step' | { readonly failure: string }>
  /** The knowledge bases this session may select, such as its assistant allows; undefined when that cannot be read. */
  allowed: () => Promise<readonly string[] | undefined>
}

/**
 * Render the knowledge button and its checklist of the signed-in company's knowledge bases.
 * @param props - the session's selection, the knowledge bases, localized copy, and the selector.
 * @returns the control, or null while signed out.
 */
export function KnowledgePicker({ useProjection, useKnowledge, select, allowed, t }: PropsRuntime<'conversation.input.left'> & InjectFace<KnowledgePickerInjected> & PropsLocale<'knowledge'>) {
  const selection = useProjection('knowledgeSelection')
  const state = useKnowledge(snapshot => snapshot.state)
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<string[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [permitted, setPermitted] = useState<readonly string[] | undefined>(undefined)
  const root = useRef<HTMLSpanElement>(null)
  useDismissOnOutsidePointer(root, open, setOpen)
  // Read again each time the list opens: the session's assistant may have changed what it allows.
  useEffect(() => { if (open) void allowed().then(setPermitted) }, [open])
  if (state === undefined || state.tenantId === null) return null
  const logged = selection?.bases.map(base => base.id) ?? []
  const current = chosen ?? logged
  const toggle = async (id: string): Promise<void> => {
    const next = current.includes(id) ? current.filter(entry => entry !== id) : [...current, id]
    setChosen(next)
    const outcome = await select(next)
    setNote(outcome === 'now' ? null : outcome === 'next-step' ? t('picker.nextStep') : outcome.failure)
    // A refused selection shows the session's selection again; one waiting for the next step stays shown.
    if (outcome !== 'next-step') setChosen(null)
  }
  const label = current.length === 0 ? t('picker.button') : t('picker.buttonCount', { count: String(current.length) })
  // A selected knowledge base stays listed, so it can be cleared.
  const shown = permitted === undefined ? state.bases : state.bases.filter(base => permitted.includes(base.id) || current.includes(base.id))
  return (
    <span ref={root} className={css.picker}>
      <button type="button" className={css.pickerButton} data-active={current.length > 0} aria-expanded={open} aria-haspopup="true"
        aria-label={label} title={t('picker.title')} onClick={() => { setOpen(!open) }}>
        <IconDeliverDocRegular size={16} />
        <span className={css.pickerLabel}>{label}</span>
      </button>
      {open && (
        <div className={css.pickerPanel} role="group" aria-label={t('picker.title')}>
          <p className={css.pickerHint}>{t('picker.hint')}</p>
          {state.bases.length === 0 && <p className={css.muted}>{t('picker.empty')}</p>}
          {shown.length < state.bases.length && <p className={css.muted}>{t('picker.limited')}</p>}
          {shown.map(base => (
            <div key={base.id} className={css.pickerRow}>
              <Checkbox checked={current.includes(base.id)} label={base.name} onChange={() => { void toggle(base.id) }} />
              {base.status !== 'ready' && <span className={css.pickerStatus}>{t(`picker.status.${base.status}`)}</span>}
            </div>
          ))}
          {note !== null && <p className={css.pickerNote} role="status">{note}</p>}
        </div>
      )}
    </span>
  )
}
