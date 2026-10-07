/** The Assistants page: the signed-in tenant's assistants as cards, searchable, each opening a new session. */

import { useState } from 'react'
import { Button, IconSearchOutlineRegular, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { AssistantAvatar } from './AssistantAvatar.tsx'
import type { AssistantsInjected } from './assistants-source.ts'
import css from './AssistantsPage.module.css'

/** Props the page reads from its `main` registration: the translator and the assistants face. */
export type AssistantsPageProps = PropsLocale<'assistants'> & InjectFace<AssistantsInjected>

/**
 * Render the search box and the assistant cards; a card's Chat button opens a new session with it.
 * @param props - the `assistants` translator and the assistants face.
 * @returns the page.
 */
export function AssistantsPage({ t, useAssistants, onChat, onDismiss }: AssistantsPageProps) {
  const state = useAssistants(snapshot => snapshot.state)
  const failure = useAssistants(snapshot => snapshot.failure)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const assistants = state?.assistants ?? []
  const shown = needle === ''
    ? assistants
    : assistants.filter(item => `${item.name}\n${item.description}`.toLowerCase().includes(needle))
  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <p className={css.intro}>{t('intro')}</p>
      </header>
      {failure !== null && (
        <div className={css.alert} role="alert">
          <span>{t('selectFailed', { message: failure })}</span>
          <Button variant="ghost" onClick={onDismiss}>{t('dismiss')}</Button>
        </div>
      )}
      {state !== undefined && state.tenantId === null && <p className={css.empty}>{t('signedOut')}</p>}
      {state !== undefined && state.tenantId !== null && (
        <>
          <div className={css.toolbar}>
            <span className={css.search}>
              <Input
                icon={<IconSearchOutlineRegular size={14} />}
                value={query}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchPlaceholder')}
                onChange={(event) => { setQuery(event.target.value) }}
              />
            </span>
            <span className={css.count}>{t('count', { count: assistants.length })}</span>
          </div>
          {assistants.length === 0 && <p className={css.empty}>{t('empty')}</p>}
          {assistants.length > 0 && shown.length === 0 && <p className={css.empty}>{t('noMatch')}</p>}
          <ul className={css.grid}>
            {shown.map(item => (
              <li key={item.id} className={css.card} data-assistant-id={item.id}>
                <div className={css.cardHead}>
                  <AssistantAvatar avatar={item.avatar} name={item.name} size={36} />
                  <span className={css.name}>{item.name}</span>
                  {item.id === state.defaultId && <Tag tone="neutral">{t('default')}</Tag>}
                </div>
                <p className={css.description}>{item.description === '' ? t('noDescription') : item.description}</p>
                <div className={css.actions}>
                  <Button variant="outline" size="sm" onClick={() => { void onChat(item.id) }}>{t('chat')}</Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
