/** The new-session assistant picker: the first chip of the Hero's workspace row. */

import { useEffect, useState } from 'react'
import { IconChevronDownOutlineRegular, IconWarningOutlineRegular, Menu, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AssistantAvatar } from './AssistantAvatar.tsx'
import { shownAssistant, type AssistantsInjected } from './assistants-source.ts'
import css from './AssistantSeat.module.css'

/** Menu id of the "no assistant" item; assistant ids are UUIDs, so it never collides. */
const NONE = 'none'

/** Full component props. */
export type AssistantSeatProps =
  PropsRuntime<'conversation.hero.assistant'>
  & PropsLocale<'assistants'>
  & InjectFace<AssistantsInjected>

/**
 * Render the picker: the shown assistant's avatar and name, or "No assistant", opening a menu of
 * "No assistant" and the tenant's assistants.
 * @param props - composed slot props.
 * @returns the chip, or null outside the main view or when the tenant has no assistants.
 */
export function AssistantSeat({ sessionId, useSessionRetainInfo, useAssistants, onPick, onDismiss, t }: AssistantSeatProps) {
  const state = useAssistants(snapshot => snapshot.state)
  const shown = useAssistants(shownAssistant)
  const busy = useAssistants(snapshot => snapshot.busy)
  const failure = useAssistants(snapshot => snapshot.failure)
  const main = useSessionRetainInfo(info => sessionId === undefined || (info?.retainedBy.mainView ?? 0) > 0)
  const [open, setOpen] = useState(false)
  const assistants = state?.assistants ?? []
  useEffect(() => { if (assistants.length === 0) setOpen(false) }, [assistants.length])
  if (!main || assistants.length === 0) return null
  const current = assistants.find(item => item.id === shown)
  // Bound to an id the tenant lacks (another company's assistant): neither that assistant nor "No assistant".
  const unknown = shown !== null && current === undefined
  return (
    <>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={[
          {
            id: NONE,
            label: (
              <span className={css.item}>
                <span className={css.itemName}>{t('noAssistant')}</span>
                <span className={css.itemDesc}>{t('noAssistantDescription')}</span>
              </span>
            ),
          },
          ...assistants.map(item => ({
            id: item.id,
            icon: <AssistantAvatar avatar={item.avatar} name={item.name} size={20} />,
            label: (
              <span className={css.item}>
                <span className={css.itemName}>{item.name}</span>
                <span className={css.itemDesc}>{item.description === '' ? t('noDescription') : item.description}</span>
              </span>
            ),
          })),
        ]}
        selectedId={unknown ? undefined : current?.id ?? NONE}
        onSelect={(id) => {
          setOpen(false)
          void onPick(id === NONE ? null : id)
        }}
        align="start"
        portal
        className={css.menuAnchor}
        anchor={(
          <button
            type="button"
            className={css.seat}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('pickerHint')}
            title={t('pickerHint')}
            disabled={busy}
            data-assistant-id={current?.id}
            onClick={() => { setOpen(value => !value) }}
          >
            {current !== undefined && <AssistantAvatar avatar={current.avatar} name={current.name} size={18} />}
            <span className={css.seatLabel}>{current?.name ?? (unknown ? t('panel') : t('noAssistant'))}</span>
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        )}
      />
      {failure !== null && (
        <Toast
          text={t('selectFailed', { message: failure })}
          icon={<IconWarningOutlineRegular />}
          anchor={document.querySelector<HTMLElement>('[data-composer-card]')}
          onDone={onDismiss}
        />
      )}
    </>
  )
}
